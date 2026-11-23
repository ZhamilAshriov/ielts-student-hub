const CACHE_NAME = "ielts-hub-v3";
const CORE_ASSETS = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./firebase.js",
  "./store.js",
  "./utils.js",
  "./submissions.js",
  "./anki.js",
  "./recorder.js",
  "./charts.js",
  "./announcements.js",
  "./teacher.js",
  "./student.js",
  "./vocab-data.js",
  "./assignments-data.js",
  "./resources-data.js"
];

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(CORE_ASSETS)).catch(() => {})
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  // Never intercept Firebase, Firestore, Cloudinary, or Gemini API calls
  if (
    url.hostname.includes("googleapis.com") ||
    url.hostname.includes("firebaseio.com") ||
    url.hostname.includes("cloudinary.com")
  ) {
    return;
  }

  // Same-origin app files (.html, .js, .css): Network-First so updates arrive immediately
  if (url.origin === self.location.origin) {
    event.respondWith(
      fetch(req)
        .then((networkRes) => {
          if (networkRes && networkRes.status === 200) {
            const copy = networkRes.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
          }
          return networkRes;
        })
        .catch(() => caches.match(req))
    );
    return;
  }

  // External static CDNs (Chart.js, QRCode.js, Firebase SDK): Cache-First
  event.respondWith(
    caches.match(req).then(
      (cached) =>
        cached ||
        fetch(req).then((networkRes) => {
          if (networkRes && networkRes.status === 200) {
            const copy = networkRes.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
          }
          return networkRes;
        })
    )
  );
});
