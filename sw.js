// sw.js — Family Shopping PWA Service Worker v3
// Strategy: Network-first for API/Firebase, Cache-first for app shell

const CACHE_VERSION = 'fsl-v3';
const APP_SHELL = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
  // js/barcode.js and js/analytics.js exist in the repo as standalone modules
  // but are not yet imported by index.html (inline implementations are active).
  // They are intentionally excluded from APP_SHELL until integration is complete.
];

// Patterns that should NEVER be served from cache
const NETWORK_ONLY_PATTERNS = [
  /firebase\.googleapis\.com/,
  /firebaseio\.com/,
  /googleapis\.com/,
  /\/api\//,
  /openfoodfacts\.org/,
];

// ── Install: pre-cache app shell ──────────────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then(cache => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

// ── Activate: clean up old caches ─────────────────────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(key => key !== CACHE_VERSION)
          .map(key => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

// ── Fetch: tiered strategy ────────────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = request.url;

  // Skip non-GET and network-only patterns
  if (request.method !== 'GET') return;
  if (NETWORK_ONLY_PATTERNS.some(p => p.test(url))) return;

  // Navigation requests (HTML): network-first, fall back to cached /index.html
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then(res => {
          // Cache a fresh copy of the app shell on successful navigation
          if (res.ok) {
            const clone = res.clone();
            caches.open(CACHE_VERSION).then(c => c.put(request, clone));
          }
          return res;
        })
        .catch(() => caches.match('/index.html'))
    );
    return;
  }

  // Static assets: cache-first
  event.respondWith(
    caches.match(request).then(cached => {
      if (cached) return cached;
      return fetch(request).then(res => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE_VERSION).then(c => c.put(request, clone));
        }
        return res;
      }).catch(() => cached); // if fetch fails and not cached, let it fail naturally
    })
  );
});
