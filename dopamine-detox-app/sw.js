// オフラインで動かすための Service Worker。
// 方針は stale-while-revalidate: まずキャッシュを返して即起動し、裏で更新を取りに行く。

const CACHE = 'detox-v1';

const SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.webmanifest',
  './assets/icon.svg',
  './assets/icon-192.png',
  './assets/icon-512.png',
  './src/app.js',
  './src/store.js',
  './src/session.js',
  './src/impulse.js',
  './src/dom.js',
  './src/alerts.js',
  './src/views/session.js',
  './src/views/log.js',
  './src/views/settings.js',
  './src/views/sheets.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // 1つでも失敗すると addAll 全体が落ちるので、個別に入れて取りこぼしを許容する
      await Promise.allSettled(SHELL.map((url) => cache.add(url)));
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(request, { ignoreSearch: true });

      const network = fetch(request)
        .then((response) => {
          if (response.ok) void cache.put(request, response.clone());
          return response;
        })
        .catch(() => null);

      if (cached) return cached;

      const fresh = await network;
      if (fresh) return fresh;

      // ナビゲーションだけは、オフラインでもアプリ本体を返す
      if (request.mode === 'navigate') {
        const shell = await cache.match('./index.html');
        if (shell) return shell;
      }
      return new Response('オフラインです', { status: 503, statusText: 'offline' });
    })(),
  );
});

// 通知をタップしたらアプリを前面に出す
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of clientList) {
        if ('focus' in client) return client.focus();
      }
      return self.clients.openWindow('./');
    })(),
  );
});
