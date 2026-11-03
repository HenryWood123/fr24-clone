// Cloudflare Worker (static assets + API proxy).
//  - /api/lat/{lat}/lon/{lon}/dist/{nm}  -> relays to a community ADS-B feed and adds CORS headers
//  - /api/info/{hex}?callsign=ABC123     -> aircraft details + candidate routes from adsbdb.com and hexdb.io
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (!url.pathname.startsWith("/api/")) {
      return env.ASSETS.fetch(request);          // serve index.html etc.
    }

    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

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
