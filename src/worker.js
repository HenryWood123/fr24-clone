// Cloudflare Pages "advanced mode" worker.
// Put this file next to index.html in the folder you upload.
//  - /api/lat/{lat}/lon/{lon}/dist/{nm}  -> relays to a community ADS-B feed and adds CORS headers
//  - everything else                     -> served from your uploaded static files (index.html)

const UPSTREAMS = [
  (lat, lon, nm) => `https://opendata.adsb.fi/api/v2/lat/${lat}/lon/${lon}/dist/${nm}`,
  (lat, lon, nm) => `https://api.adsb.lol/v2/lat/${lat}/lon/${lon}/dist/${nm}`,
];

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (!url.pathname.startsWith("/api/")) {
      return env.ASSETS.fetch(request);          // serve index.html etc.
    }

    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

    const m = url.pathname.match(/^\/api\/lat\/(-?\d+(?:\.\d+)?)\/lon\/(-?\d+(?:\.\d+)?)\/dist\/(\d+)$/);
    if (!m) {
      return new Response("Use /api/lat/{lat}/lon/{lon}/dist/{nm}", { status: 400, headers: CORS });
    }
    const [, lat, lon, nmRaw] = m;
    const nm = Math.min(250, Math.max(1, Number(nmRaw)));

    for (const build of UPSTREAMS) {
      try {
        const res = await fetch(build(lat, lon, nm), {
          headers: { "User-Agent": "personal-flight-map (non-commercial)" },
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
