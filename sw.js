const CACHE_VERSION = 'v4-rover';
const CACHE_NAME = `myo-rover-cache-${CACHE_VERSION}`;
const urlsToCache = [
    './',
    './index.html',
    './script.js',
    './script.js?v=4',
    './manifest.json'
];

self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => cache.addAll(urlsToCache))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(keys => {
            return Promise.all(
                keys.filter(key => key !== CACHE_NAME)
                    .map(key => caches.delete(key))
            );
        }).then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', event => {
    event.respondWith(
        fetch(event.request).then(response => {
            const copy = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
            return response;
        }).catch(() => caches.match(event.request).then(response => {
            return response || new Response('Offline', { status: 503 });
        }))
    );
});
