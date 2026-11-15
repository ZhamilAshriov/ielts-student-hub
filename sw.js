self.addEventListener("install", (e) => {
  self.skipWaiting();
});

self.addEventListener("fetch", (e) => {
  // Network-first pass-through so Firebase and data files always stay fresh
  e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
});
