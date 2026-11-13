// Service worker: keeps the app shell (page, icons, map library) so the app opens instantly
// and still launches with no signal. Live data is never cached.
//
// Bump VERSION if you change the file list below, to clear out old caches.
const VERSION = "overhead-v1";
const SHELL = ["/", "/manifest.json", "/icon-192.png", "/apple-touch-icon.png"];
const CDN_HOST = "cdnjs.cloudflare.com";

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(VERSION).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;

  if (sameOrigin && url.pathname.startsWith("/api/")) return;   // live aircraft data: always fresh
  if (!sameOrigin && url.hostname !== CDN_HOST) return;         // map tiles etc.: leave to the browser

  event.respondWith(url.hostname === CDN_HOST && !sameOrigin ? cacheFirst(req) : networkFirst(req));
});

// Your own files: try the network first so a new deploy shows up straight away,
// and fall back to the saved copy when offline.
async function networkFirst(req) {
  const cache = await caches.open(VERSION);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(req);
    if (hit) return hit;
    if (req.mode === "navigate") {
      const shell = await cache.match("/");
      if (shell) return shell;
    }
    throw err;
  }
}

// The map library is versioned in its URL, so a saved copy is always fine.
async function cacheFirst(req) {
  const cache = await caches.open(VERSION);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok || res.type === "opaque") cache.put(req, res.clone());
  return res;
}
