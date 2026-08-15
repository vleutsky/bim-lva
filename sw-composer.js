/* BIM.LVA Composer — lightweight shell cache */
const CACHE = 'bimlva-composer-shell-v160';
const SHELL = [
  './',
  './index.html',
  './bim-lva-composer-ifc.html',
  './manifest.webmanifest'
];

/**
 * Вендоры (assets/vendor) неизменяемы в пределах деплоя и пересобираются только
 * через `npm run vendor`. Кэшируем их cache-first и наполняем кэш по мере
 * загрузки: precache на 11 МБ при install был бы грубостью на мобильном,
 * а после первого удачного открытия вьювера офлайн собирается сам.
 */
const VENDOR_PREFIX = '/assets/vendor/';

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

/** Кладём копию ответа в кэш, не задерживая отдачу страницы. */
function putInCache(req, res) {
  if (res && res.ok) {
    const copy = res.clone();
    caches.open(CACHE).then(cache => cache.put(req, copy));
  }
  return res;
}

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  const path = url.pathname;

  // Вендоры — cache-first: здесь и three.js, и wasm web-ifc, и шрифты.
  // Без этой ветки офлайн не работал вообще: файлы лежали на unpkg, а SW
  // пропускает кросс-домен, так что вьювер молча падал без three.js.
  if (path.includes(VENDOR_PREFIX)) {
    event.respondWith(
      caches.match(req).then(hit => hit || fetch(req).then(res => putInCache(req, res)))
    );
    return;
  }

  const isScript = path.endsWith('.js') || path.endsWith('.css');
  const isShellDoc =
    path.endsWith('.html') ||
    path.endsWith('.webmanifest') ||
    path.endsWith('/') ||
    /\/bim-lva\/?$/.test(path);

  // JS/CSS приложения — всегда с сети, иначе auth-config залипает в SW и ломает
  // вход на Composer. Копию кладём в кэш, чтобы офлайн было чем ответить.
  if (isScript) {
    event.respondWith(
      fetch(req)
        .then(res => putInCache(req, res))
        .catch(() => caches.match(req))
    );
    return;
  }

  if (!isShellDoc) return;

  event.respondWith(
    fetch(req)
      .then(res => putInCache(req, res))
      .catch(() => caches.match(req))
  );
});
