const CACHE = "peak-route-runner-v1.1u";
const CORE = ["./", "./index.html", "./manifest.webmanifest", "./icon.svg", "./css/app.css", "./js/app.js"];

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(CORE)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

function isAppShell(url) {
  return (
    url.pathname.endsWith("/routes.js") ||
    url.pathname.endsWith("/index.html") ||
    url.pathname.endsWith("/js/app.js") ||
    url.pathname.endsWith("/css/app.css") ||
    url.pathname.endsWith("/")
  );
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  if (isAppShell(url)) {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req, { cache: "no-store" });
        const cache = await caches.open(CACHE);
        if (fresh.ok) cache.put(req, fresh.clone());
        return fresh;
      } catch (e) {
        const cached = await caches.match(req);
        if (cached) return cached;
        if (url.pathname.endsWith("/routes.js")) throw e;
        return caches.match("./index.html");
      }
    })());
    return;
  }

  if (url.origin === self.location.origin && url.pathname.includes("/photos/")) {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req, { cache: "no-store" });
        const cache = await caches.open(CACHE);
        if (fresh.ok) cache.put(req, fresh.clone());
        return fresh;
      } catch (e) {
        const cached = await caches.match(req);
        if (cached) return cached;
        throw e;
      }
    })());
    return;
  }

  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(req).then((cached) => cached || fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((cache) => cache.put(req, copy));
        return res;
      }))
    );
  }
});
