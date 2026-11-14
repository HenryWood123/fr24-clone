// Cloudflare Worker (static assets + API proxy).
//  - /api/lat/{lat}/lon/{lon}/dist/{nm}  -> relays to a community ADS-B feed and adds CORS headers
//  - /api/info/{hex}?callsign=ABC123     -> aircraft details + candidate routes from adsbdb.com and hexdb.io
//  - /api/find?q=BA117                   -> search live aircraft by callsign, flight number, registration, hex or type
//  - everything else                     -> served from the static files in /public (index.html)

const UPSTREAMS = [
  (lat, lon, nm) => `https://opendata.adsb.fi/api/v2/lat/${lat}/lon/${lon}/dist/${nm}`,
  (lat, lon, nm) => `https://api.adsb.lol/v2/lat/${lat}/lon/${lon}/dist/${nm}`,
];

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

const UA = "personal-flight-map (non-commercial)";

// GET a JSON document, cached at the edge for an hour. Returns null if unknown or on any failure.
async function getJson(url) {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA },
      cf: { cacheEverything: true, cacheTtlByStatus: { "200-299": 3600, "404": 900, "500-599": 0 } },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    return null;
  }
}

// Normalised airport shape used by the page: { icao, iata, name, city, lat, lon }
const fromAdsbdb = a => a && {
  icao: a.icao_code, iata: a.iata_code, name: a.name, city: a.municipality, lat: a.latitude, lon: a.longitude,
};
const fromHexdb = a => a && {
  icao: a.icao, iata: a.iata, name: a.name, city: null, lat: a.latitude, lon: a.longitude,
};

// Route candidates for a callsign from two independent databases. The page decides which one
// (if any) matches where the aircraft actually is, because a callsign can fly several legs and
// databases go stale.
async function lookupRoutes(callsign) {
  const [adsbdb, hexdb] = await Promise.all([
    getJson(`https://api.adsbdb.com/v0/callsign/${callsign}`),
    getJson(`https://hexdb.io/api/v2/routes/${callsign}`),
  ]);

  const routes = [];
  let airline = null;

  const fr = adsbdb && adsbdb.response && adsbdb.response.flightroute;
  if (fr) {
    airline = (fr.airline && fr.airline.name) || null;
    const airports = [fr.origin, fr.midpoint, fr.destination].filter(Boolean).map(fromAdsbdb);
    if (airports.length >= 2) routes.push({ source: "adsbdb", airports });
  }

  if (hexdb && !hexdb.error) {
    const list = Array.isArray(hexdb.airports) && hexdb.airports.length >= 2
      ? hexdb.airports
      : [hexdb.origin, hexdb.destination].filter(Boolean);
    const airports = list.map(fromHexdb);
    if (airports.length >= 2) routes.push({ source: "hexdb", airports });
  }

  return { airline, routes };
}

// ---- Search ----
// Airlines print flight numbers with a 2-character IATA code (BA117) but broadcast a 3-letter
// ICAO callsign (BAW117). This table lets people search by the number they see on a ticket.
const IATA_TO_ICAO = {
  BA: "BAW", AA: "AAL", UA: "UAL", DL: "DAL", WN: "SWA", B6: "JBU", AS: "ASA", NK: "NKS", F9: "FFT", HA: "HAL",
  AC: "ACA", WS: "WJA", LH: "DLH", AF: "AFR", KL: "KLM", IB: "IBE", AZ: "ITY", SK: "SAS", AY: "FIN", LX: "SWR",
  OS: "AUA", SN: "BEL", TP: "TAP", EI: "EIN", FR: "RYR", RK: "RUK", U2: "EZY", W6: "WZZ", VS: "VIR", LS: "EXS",
  BY: "TOM", EW: "EWG", VY: "VLG", DY: "NOZ", LO: "LOT", TK: "THY", PC: "PGT", FI: "ICE", A3: "AEE", UX: "AEA",
  EK: "UAE", QR: "QTR", EY: "ETD", SV: "SVA", MS: "MSR", ET: "ETH", SA: "SAA", WY: "OMA", GF: "GFA",
  QF: "QFA", NZ: "ANZ", SQ: "SIA", CX: "CPA", JL: "JAL", NH: "ANA", KE: "KAL", OZ: "AAR", CA: "CCA", MU: "CES",
  CZ: "CSN", AI: "AIC", TG: "THA", MH: "MAS", GA: "GIA", DE: "CFG", SU: "AFL",
};

// Registration prefixes that are written with a hyphen after the country code (G-XWBA, EI-ABC).
const REG_PREFIX_1 = ["G", "D", "F", "C", "I", "B"];
const REG_PREFIX_2 = ["EI", "HB", "OO", "PH", "SE", "OY", "LN", "OH", "EC", "CS", "TC", "A6", "A7", "VH", "ZK",
  "ZS", "SP", "OK", "OE", "TF", "LX", "SX", "VT", "HL", "YR", "LZ", "9V", "RA", "UR", "ES", "YL", "LY"];

// Decide which lookups are worth making, most likely first. The free feeds allow about one
// request a second and count bad requests against you, so the plan stays short and specific.
function searchPlan(q) {
  const plan = [];
  const add = (kind, value) => plan.push({ kind, value });

  if (q.includes("-")) { add("reg", q); return plan; }                                    // G-XWBA
  if (/^N\d[A-Z0-9]{0,5}$/.test(q) || /^JA\d{3}[A-Z0-9]$/.test(q)) { add("reg", q); return plan; }   // N123AB, JA123A

  // BA117 -> BAW117. Aegean's code "A3" collides with Airbus types (A320, A359, A35K...), but its
  // flight numbers have 3-4 digits, so a short "A3" string is treated as an aircraft type instead.
  const iata = q.match(/^([A-Z0-9]{2})(\d{1,4}[A-Z]?)$/);
  if (iata && IATA_TO_ICAO[iata[1]] && !(iata[1] === "A3" && iata[2].length <= 2)) {
    add("callsign", IATA_TO_ICAO[iata[1]] + iata[2]);
    return plan;
  }

  if (/^[A-Z][A-Z0-9]{3}$/.test(q) && /\d/.test(q) && !/^[A-Z]{3}\d$/.test(q)) {          // A388, B738, C172
    add("type", q);
    return plan;
  }

  const isHex = /^[0-9A-F]{6}$/.test(q);
  if (isHex) add("hex", q);                                                               // 406B0F
  if (/^[A-Z0-9]{3,8}$/.test(q) && !(isHex && /^\d/.test(q))) add("callsign", q);          // BAW117, or a GA callsign

  if (/^[A-Z]{1,2}[A-Z0-9]{3,5}$/.test(q) && !/^[A-Z]{3}\d/.test(q)) {                     // GXWBA -> G-XWBA
    const p2 = REG_PREFIX_2.find(p => q.startsWith(p));
    const guess = p2 ? `${p2}-${q.slice(2)}` : REG_PREFIX_1.includes(q[0]) ? `${q[0]}-${q.slice(1)}` : null;
    if (guess) add("reg", guess);
  }
  return plan.slice(0, 3);
}

// One lookup against the feeds. Returns { now, ac } or null when every feed failed.
async function lookup(kind, value) {
  const fiPath = { hex: "hex", callsign: "callsign", reg: "registration" };
  const lolPath = { hex: "hex", callsign: "callsign", reg: "reg", type: "type" };
  const urls = [];
  if (kind !== "type") urls.push(`https://opendata.adsb.fi/api/v2/${fiPath[kind]}/${encodeURIComponent(value)}`);
  urls.push(`https://api.adsb.lol/v2/${lolPath[kind]}/${encodeURIComponent(value)}`);
  for (const url of urls) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA }, cf: { cacheTtl: 5, cacheEverything: true } });
      if (!res.ok) continue;
      const json = await res.json();
      return { now: json.now, ac: (json.ac || json.aircraft || []).filter(a => a.lat != null && a.lon != null) };
    } catch (e) { /* try the next feed */ }
  }
  return null;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (!url.pathname.startsWith("/api/")) {
      return env.ASSETS.fetch(request);          // serve index.html etc.
    }

    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

    // /api/find?q=BA117  -> live aircraft matching a callsign, flight number, registration, hex or type
    if (url.pathname === "/api/find") {
      const q = (url.searchParams.get("q") || "").toUpperCase().replace(/\s+/g, "");
      const headers = { ...CORS, "Content-Type": "application/json" };
      if (!/^[A-Z0-9-]{2,10}$/.test(q)) {
        return new Response(JSON.stringify({ error: "Use letters, numbers and hyphens only (2 to 10 characters)." }), { status: 400, headers });
      }
      const plan = searchPlan(q);
      const result = { query: q, matched: null, now: null, ac: [], tried: plan, failed: false };
      let reached = false;
      for (let i = 0; i < plan.length; i++) {
        if (i > 0) await sleep(700);                          // stay under the feeds' 1 request/second limit
        const r = await lookup(plan[i].kind, plan[i].value);
        if (r) reached = true;
        if (r && r.ac.length) {
          result.matched = plan[i];
          result.now = r.now;
          result.ac = r.ac.slice(0, 300);
          break;
        }
      }
      result.failed = plan.length > 0 && !reached;           // true when no feed could be reached at all
      return new Response(JSON.stringify(result), { headers });
    }

    // /api/info/{icao24hex}?callsign=BAW117
    const im = url.pathname.match(/^\/api\/info\/([0-9a-fA-F]{6})$/);
    if (im) {
      const callsign = (url.searchParams.get("callsign") || "").trim().toUpperCase();
      const [acJson, route] = await Promise.all([
        getJson(`https://api.adsbdb.com/v0/aircraft/${im[1].toLowerCase()}`),
        /^[A-Z0-9]{2,8}$/.test(callsign) ? lookupRoutes(callsign) : { airline: null, routes: [] },
      ]);
      const aircraft = (acJson && acJson.response && acJson.response.aircraft) || null;
      return new Response(JSON.stringify({ aircraft, airline: route.airline, routes: route.routes }), {
        headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "public, max-age=600" },
      });
    }

    const m = url.pathname.match(/^\/api\/lat\/(-?\d+(?:\.\d+)?)\/lon\/(-?\d+(?:\.\d+)?)\/dist\/(\d+)$/);
    if (!m) {
      return new Response("Use /api/lat/{lat}/lon/{lon}/dist/{nm}", { status: 400, headers: CORS });
    }
    const [, lat, lon, nmRaw] = m;
    const nm = Math.min(250, Math.max(1, Number(nmRaw)));

    for (const build of UPSTREAMS) {
      try {
        const res = await fetch(build(lat, lon, nm), {
          headers: { "User-Agent": UA },
          cf: { cacheTtl: 4, cacheEverything: true },
        });
        if (res.ok) {
          return new Response(res.body, {
            headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "public, max-age=4" },
          });
        }
      } catch (e) {
        // try the next upstream
      }
    }

    return new Response(JSON.stringify({ error: "all upstream feeds failed" }), {
      status: 502,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  },
};
