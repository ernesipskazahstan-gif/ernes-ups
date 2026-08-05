/**
 * ERNES — Service Worker.
 * Кэширует оболочку приложения, чтобы форма открывалась без сети.
 * При изменении файлов приложения поднимай версию CACHE — старый кэш
 * удалится при активации нового воркера.
 *
 * Что кэшируется:
 *  - оболочка (HTML/JS/manifest/иконки) — precache при установке;
 *  - Tesseract.js (CDN, для OCR офлайн) — runtime cache при первом онлайн-запуске;
 *  - миниатюры Drive — runtime cache (появляются офлайн, если раньше открывались).
 * Запросы к Apps Script (данные) НИКОГДА не кэшируются — только сеть.
 */
var CACHE = 'ernes-field-v6';

var SHELL = [
  './audit-github.html',
  './offline.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) {
      // Пропускаем сбои отдельных файлов, чтобы установка не падала целиком.
      return Promise.all(SHELL.map(function (url) {
        return c.add(url).catch(function () {});
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        if (k !== CACHE) return caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return; // POST к Apps Script — мимо кэша

  var url = new URL(req.url);

  // Данные Apps Script — только сеть (свежие акты/фото), не кэшируем.
  if (url.hostname.indexOf('script.google.com') !== -1 ||
      url.hostname.indexOf('script.googleusercontent.com') !== -1) {
    return; // пусть идёт в сеть штатно
  }

  // Tesseract CDN и миниатюры Drive — cache-first с дозаписью (runtime).
  if (url.hostname.indexOf('cdn.jsdelivr.net') !== -1 ||
      url.hostname.indexOf('drive.google.com') !== -1) {
    e.respondWith(
      caches.match(req).then(function (hit) {
        return hit || fetch(req).then(function (resp) {
          var copy = resp.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); });
          return resp;
        }).catch(function () { return hit; });
      })
    );
    return;
  }

  // Оболочка (свой origin).
  if (url.origin === self.location.origin) {
    var isPage = req.mode === 'navigate' || /\.html($|\?)/.test(url.pathname) || url.pathname.endsWith('/');
    if (isPage) {
      // Страницы (HTML) — network-first: при наличии сети всегда свежая версия,
      // из кэша — только когда офлайн. Так обновление применяется сразу.
      e.respondWith(
        fetch(req).then(function (resp) {
          var copy = resp.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); });
          return resp;
        }).catch(function () { return caches.match(req); })
      );
      return;
    }
    // Остальное своё (js, png, json) — cache-first с фоновым обновлением.
    e.respondWith(
      caches.match(req).then(function (hit) {
        var net = fetch(req).then(function (resp) {
          var copy = resp.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); });
          return resp;
        }).catch(function () { return hit; });
        return hit || net;
      })
    );
  }
});
