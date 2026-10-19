// Офлайн-кэш «Лога дня»: файлы приложения отдаются из кэша и тихо обновляются из сети.
// При изменении файлов приложения подними номер версии.
const CACHE = 'daylog-v7';
const FILES = ['./', 'index.html', 'app.js', 'styles.css', 'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png'];

// Хостинг (GitHub Pages) отдаёт файлы с max-age=600, поэтому мимо HTTP-кэша браузера:
// при установке — только с сервера, в фоне — с проверкой по ETag (обычно ответ 304, почти без трафика).
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE)
    .then(c => c.addAll(FILES.map(f => new Request(f, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  const fresh = fetch(url.href, { cache: 'no-cache' })   // по адресу: запрос навигации нельзя пересоздать с опциями
    .then(res => {
      if (res.ok) {
        const copy = res.clone();   // клонировать сразу, пока тело ответа не прочитано
        caches.open(CACHE).then(c => c.put(url.origin + url.pathname, copy));   // без ?параметров — одна копия на файл
      }
      return res;
    })
    .catch(() => null);
  e.waitUntil(fresh);
  e.respondWith((async () => {
    const cached = await caches.match(req, { ignoreSearch: true });
    return cached || (await fresh) || (req.mode === 'navigate' ? caches.match('index.html') : Response.error());
  })());
});
