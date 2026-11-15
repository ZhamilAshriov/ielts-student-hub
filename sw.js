const CACHE_NAME = "ielts-hub-v2";
const CORE_ASSETS = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./vocab-data.js",
  "./assignments-data.js",
  "./resources-data.js",
  "./manifest.json"
];

// 1. Install: pre-cache core shell & activate immediately
self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(CORE_ASSETS)).catch(() => {})
  );
});

// 2. Activate: delete any outdated cache versions & claim open tabs
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((oldKey) => caches.delete(oldKey))
      )
    ).then(() => self.clients.claim())
  );
});

// 3. Fetch: Network-first with cache:"no-store" for HTML/JS/CSS; ignore external APIs
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  // Never intercept Firebase, Cloudinary, Chart.js CDN, or YouTube requests
  if (url.origin !== self.location.origin) return;

  const isCodeOrDoc =
    req.mode === "navigate" ||
    url.pathname.endsWith(".html") ||
    url.pathname.endsWith(".js") ||
    url.pathname.endsWith(".css") ||
    url.pathname.endsWith("/");

  if (isCodeOrDoc) {
    event.respondWith(
      fetch(req, { cache: "no-store" })
        .then((networkRes) => {
          const copy = networkRes.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
          return networkRes;
        })
        .catch(() => caches.match(req))
    );
  }
});
