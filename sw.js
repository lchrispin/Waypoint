const CACHE = 'waypoint-v5';
const SHELL = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './vendor/maplibre-gl.js',
  './vendor/maplibre-gl.css',
  './src/main.js',
  './src/views.js',
  './src/db.js',
  './src/geo.js',
  './src/format.js',
  './src/story.js',
  './src/places.js',
  './src/roads.js',
  './src/exif.js',
  './src/photos.js',
  './src/map.js',
  './src/camera.js',
  './src/home.js',
  './src/record.js',
  './src/playback.js',
  './src/import-google.js',
  './src/backup.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  // Network-first everywhere, including the app shell: a deploy should reach visitors on their very
  // next load without depending on someone remembering to bump CACHE. Cache is only an offline fallback.
  // cache:'no-cache' forces ETag revalidation so the browser's HTTP cache (Pages max-age=600) can't
  // serve a stale module against a fresh index.html around a deploy.
  const sameOrigin = new URL(e.request.url).origin === self.location.origin;
  e.respondWith(
    fetch(e.request, { cache: 'no-cache' }).then((res) => {
      // only same-origin app files get cached; tiles/geocoding/routing pass straight through
      if (sameOrigin && res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
      }
      return res;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
