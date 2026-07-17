/* BIM.LVA Composer — lightweight offline shell cache */
const CACHE = 'bimlva-composer-shell-v5';
const SHELL = [
  './',
  './index.html',
  './bim-lva-composer-ifc.html',
  './manifest.webmanifest',
  './stats.js',
  './auth-config.js',
  './auth.js',
  './auth-ui.js'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Кэшируем только same-origin shell; CDN (three/web-ifc) — network-first
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(req).then(cached => {
      const network = fetch(req).then(res => {
        if (res && res.ok && (url.pathname.endsWith('.html') || url.pathname.endsWith('.webmanifest') || url.pathname === '/' || url.pathname.endsWith('/'))) {
          const copy = res.clone();
          caches.open(CACHE).then(cache => cache.put(req, copy));
        }
        return res;
      }).catch(() => cached);
      return cached || network;
    })
  );
});
