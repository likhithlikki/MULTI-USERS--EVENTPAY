
// ============================================================
// SERVICE WORKER v4 — EventPay  (NETWORK-FIRST)
// Every page load fetches fresh from GitHub.
// Falls back to cache ONLY when offline.
// ============================================================
const CACHE = "eventpay-v4";

self.addEventListener("install", e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(["./offline.html","./icons/icon-192.png"]))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting())
  );
});

// Delete ALL old caches on activate
self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// NETWORK FIRST — always fetch fresh, cache as backup
self.addEventListener("fetch", e => {
  if (e.request.method !== "GET") return;
  if (e.request.url.startsWith("chrome-extension")) return;

  e.respondWith(
    fetch(e.request)
      .then(res => {
        if (res && res.status === 200) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      })
      .catch(() =>
        caches.match(e.request).then(cached => {
          if (cached) return cached;
          if (e.request.headers.get("accept")?.includes("text/html"))
            return caches.match("./offline.html");
        })
      )
  );
});

