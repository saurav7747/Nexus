// ═══════════════════════════════════════════════════════
// service-worker.js — Nexus Chat PWA
// Cache-first strategy for static assets
// ═══════════════════════════════════════════════════════

const CACHE_NAME = "nexus-chat-v1";

// Files to cache on install
const PRECACHE_ASSETS = [
  "./",
  "./index.html",
  "./style.css",
  "./script.js",
  "./firebase.js",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
  "https://fonts.googleapis.com/css2?family=Syne:wght@400;500;600;700;800&family=DM+Sans:ital,opsz,wght@0,9..40,300;0,9..40,400;0,9..40,500;1,9..40,300&display=swap"
];

// ── Install: pre-cache all static assets ─────────────
self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(PRECACHE_ASSETS).catch(err => {
        console.warn("[SW] Some assets failed to cache:", err);
      });
    }).then(() => self.skipWaiting())
  );
});

// ── Activate: clean up old caches ────────────────────
self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key !== CACHE_NAME)
          .map(key => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

// ── Fetch: cache-first for static, network-first for Firebase ─
self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);

  // Always go to network for Firebase APIs (auth, firestore, rtdb)
  const isFirebase = url.hostname.includes("firebase") ||
                     url.hostname.includes("firebaseio") ||
                     url.hostname.includes("googleapis.com") ||
                     url.hostname.includes("gstatic.com");

  if (isFirebase) {
    // Network-only for Firebase — don't cache dynamic data
    event.respondWith(fetch(event.request).catch(() => new Response("")));
    return;
  }

  // Cache-first for everything else (HTML, CSS, JS, fonts, icons)
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        // Cache valid responses
        if (response && response.status === 200 && response.type !== "opaque") {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => {
        // Offline fallback: serve index.html for navigation requests
        if (event.request.mode === "navigate") {
          return caches.match("./index.html");
        }
      });
    })
  );
});
