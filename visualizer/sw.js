// Offline support: the whole app is a handful of static files, cached up front.
const SHELL = "pulse-shell-v3";
const FILES = ["./", "index.html", "style.css", "app.js", "manifest.webmanifest", "icons/icon-180.png", "icons/icon-192.png", "icons/icon-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("pulse-") && k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  // network-first so fixes show up on the next launch; the cache is the offline fallback
  e.respondWith(caches.open(SHELL).then((c) =>
    fetch(e.request)
      .then((res) => { if (res.ok) c.put(e.request, res.clone()); return res; })
      .catch(() => c.match(e.request, { ignoreSearch: true }))
  ));
});
