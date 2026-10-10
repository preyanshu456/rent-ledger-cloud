// App files are served from the phone's own cache first, so the app opens
// instantly even on a slow connection. Each time, a fresh copy is fetched in
// the background and used from the next open. Money and records (/api/) are
// never cached here.
const CACHE_NAME = 'rent-ledger-shell-v12';
const APP_SHELL = ['/', '/index.html', '/style.css', '/app.js', '/i18n.js', '/modules.js', '/manifest.webmanifest', '/assets/rent-ledger-icon.svg', '/sw-register.js'];
const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;
  if (sameOrigin && url.pathname.startsWith('/api/')) return;
  if (!sameOrigin && !FONT_HOSTS.includes(url.hostname)) return;
  // Pages of the app all use the same shell.
  const key = sameOrigin && req.mode === 'navigate' ? '/index.html' : req;
  const cachePromise = caches.open(CACHE_NAME);
  const fresh = cachePromise.then((cache) => fetch(req).then((response) => {
    if (response && (response.ok || response.type === 'opaque')) cache.put(key, response.clone());
    return response;
  }));
  event.waitUntil(fresh.catch(() => undefined));
  event.respondWith(cachePromise.then((cache) => cache.match(key)).then((cached) => cached || fresh.catch(() => caches.match('/index.html'))));
});
