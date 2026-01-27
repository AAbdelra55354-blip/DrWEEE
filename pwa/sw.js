/**
 * DrWEEE PWA Service Worker
 * Handles caching for the install landing page
 */

const CACHE_NAME = 'drweee-pwa-v2';

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
    console.log('[SW] Installing v2...');
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => {
                console.log('[SW] Caching assets');
                return cache.addAll(ASSETS_TO_CACHE);
            })
            .then(() => {
                console.log('[SW] Skip waiting');
                return self.skipWaiting();
            })
    );
});

// Activate - clean old caches and claim clients
self.addEventListener('activate', (event) => {
    console.log('[SW] Activating...');
    event.waitUntil(
        caches.keys()
            .then(keys => Promise.all(
                keys.filter(key => key !== CACHE_NAME)
                    .map(key => {
                        console.log('[SW] Deleting old cache:', key);
                        return caches.delete(key);
                    })
            ))
            .then(() => {
                console.log('[SW] Claiming clients');
                return self.clients.claim();
            })
    );
});

// Fetch - network first with cache fallback for our assets
self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);

    // Only handle same-origin requests
    if (url.origin !== self.location.origin) {
        return;
    }

    // For /app navigation, serve the app-shell
    if (event.request.mode === 'navigate') {
        if (url.pathname === '/app' || url.pathname.startsWith('/app/')) {
            event.respondWith(
                fetch(event.request)
                    .catch(() => caches.match('/pwa/app-shell.html'))
            );
            return;
        }
    }

    // For PWA assets, try network first then cache
    if (url.pathname.startsWith('/pwa/')) {
        event.respondWith(
            fetch(event.request)
                .then(response => {
                    // Clone and cache successful responses
                    if (response.ok) {
                        const responseClone = response.clone();
                        caches.open(CACHE_NAME).then(cache => {
                            cache.put(event.request, responseClone);
                        });
                    }
                    return response;
                })
                .catch(() => caches.match(event.request))
        );
        return;
    }
});
