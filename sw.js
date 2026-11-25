// ============================================================
// TOOLIFY — Service Worker (Offline + Auto-Update)
// ============================================================
const CACHE_NAME = 'toolify-v71';
const APP_SHELL = [
  './', './index.html', './styles.css', './responsive.css', './app.js', './manifest.json', './logo.png', './logo-192.png', './logo-512.png',
  './js/config.js', './js/store.js', './js/supabase.js', './js/db.js', './js/ui.js', './js/responsive.js', './js/music.js',
  './js/workspace.js', './js/tools.js', './js/data.js', './js/settings.js', './js/splash.js',
  './js/books.js', './js/auth.js', './js/events.js', './js/clock.js'
];

// Install: cache the app shell
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting(); // activate immediately
});

// Activate: clean old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim(); // take control of all pages immediately
});

// Fetch: network-first for HTML (gets updates on refresh), cache-first for same-origin assets
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Only handle same-origin requests
  if (url.origin !== self.location.origin) return;

  // HTML document: network first, cache fallback (so refresh gets latest version)
  if (request.mode === 'navigate' || request.destination === 'document') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          return response;
        })
        .catch(() => caches.match(request))
    );
    return;
  }

  // Other same-origin assets: instant cache hit, then refresh it in the
  // background so the next open is already on the newest version.
  event.respondWith(
    caches.match(request, { ignoreSearch: true }).then((cached) => {
      const network = fetch(request).then((response) => {
        if(response.ok){
          caches.open(CACHE_NAME).then((cache) => cache.put(request, response.clone())).catch(() => {});
        }
        return response;
      }).catch(() => cached || Response.error());
      return cached || network;
    })
  );
});
