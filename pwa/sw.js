/**
 * DrWEEE PWA Service Worker
 * Simple service worker for install landing page
 */

const CACHE_NAME = 'drweee-pwa-v1';

// Assets to cache for offline install page
const ASSETS_TO_CACHE = [
    '/pwa/app-shell.html',
    '/pwa/offline.html',
    '/pwa/manifest.json',
    '/pwa/assets/icons/icon-192x192.png',
    '/pwa/assets/icons/icon-512x512.png',
    '/images/favicon/favicon-96x96.png'
];

// Install - cache essential assets
self.addEventListener('install', (event) => {
    console.log('[SW] Installing...');
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => cache.addAll(ASSETS_TO_CACHE))
            .then(() => self.skipWaiting())
    );
});

// Activate - clean old caches
self.addEventListener('activate', (event) => {
    console.log('[SW] Activating...');
    event.waitUntil(
        caches.keys()
            .then(keys => Promise.all(
                keys.filter(key => key !== CACHE_NAME)
                    .map(key => caches.delete(key))
            ))
            .then(() => self.clients.claim())
    );
});

// Fetch - serve from cache, fallback to network
self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);

    // Only handle same-origin requests
    if (url.origin !== self.location.origin) {
        return;
    }

    // For /app navigation, serve the install page
    if (event.request.mode === 'navigate' && url.pathname.startsWith('/app')) {
        event.respondWith(
            caches.match('/pwa/app-shell.html')
                .then(response => response || fetch(event.request))
                .catch(() => caches.match('/pwa/offline.html'))
        );
        return;
    }

    // For other assets, try cache first
    event.respondWith(
        caches.match(event.request)
            .then(response => response || fetch(event.request))
    );
});
