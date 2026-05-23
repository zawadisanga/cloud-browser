// sw.js - SIMPLE VERSION
self.addEventListener('install', event => {
    console.log('Service Worker installed');
    self.skipWaiting();
});

self.addEventListener('fetch', event => {
    // Don't cache API calls
    if (event.request.url.includes('/api/')) {
        return;
    }
    event.respondWith(fetch(event.request));
});
