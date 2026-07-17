/* BIM.LVA Composer — lightweight shell cache */
const CACHE = 'bimlva-composer-shell-v9';
const SHELL = [
  './',
  './index.html',
  './bim-lva-composer-ifc.html',
  './manifest.webmanifest'
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
  if (url.origin !== self.location.origin) return;

  const path = url.pathname;
  const isScript = path.endsWith('.js') || path.endsWith('.css');
  const isShellDoc =
    path.endsWith('.html') ||
    path.endsWith('.webmanifest') ||
    path.endsWith('/') ||
    /\/bim-lva\/?$/.test(path);

  // JS/CSS всегда с сети — иначе auth-config залипает в SW и ломает вход на Composer
  if (isScript) {
    event.respondWith(
      fetch(req)
        .then(res => res)
        .catch(() => caches.match(req))
    );
    return;
  }

  if (!isShellDoc) return;

  event.respondWith(
    fetch(req)
      .then(res => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(cache => cache.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req))
  );
});
