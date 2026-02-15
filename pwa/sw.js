/**
 * DrWEEE PWA Service Worker v3
 * Required for PWA install prompt on Chrome/Edge
 */

const CACHE_NAME = 'drweee-pwa-v3';

// Assets to cache
const ASSETS_TO_CACHE = [
    '/app',
    '/pwa/app-shell.html',
    '/pwa/offline.html',
    '/pwa/manifest.json',
    '/pwa/assets/icons/icon-192x192.png',
    '/pwa/assets/icons/icon-512x512.png'
];

// Install event - cache assets
self.addEventListener('install', (event) => {
    console.log('[SW v3] Installing...');
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => {
                console.log('[SW v3] Caching assets');
                return cache.addAll(ASSETS_TO_CACHE);
            })
            .then(() => self.skipWaiting())
            .catch(err => console.error('[SW v3] Cache failed:', err))
    );
});

// Activate event - clean old caches
self.addEventListener('activate', (event) => {
    console.log('[SW v3] Activating...');
    event.waitUntil(
        caches.keys()
            .then(keys => Promise.all(
                keys.filter(key => key.startsWith('drweee-pwa-') && key !== CACHE_NAME)
                    .map(key => {
                        console.log('[SW v3] Removing old cache:', key);
                        return caches.delete(key);
                    })
            ))
            .then(() => self.clients.claim())
    );
});

// Fetch event - minimal handling, let network handle most requests
self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);

    // Only handle same-origin requests
    if (url.origin !== self.location.origin) {
        return;
    }

    // For /app and /app-test navigation requests
    if (event.request.mode === 'navigate' &&
        (url.pathname === '/app' || url.pathname.startsWith('/app/') ||
         url.pathname === '/app-test' || url.pathname.startsWith('/app-test/'))) {
        event.respondWith(
            fetch(event.request)
                .catch(() => caches.match('/pwa/app-shell.html'))
        );
        return;
    }

    // For PWA assets only - network first with cache fallback
    if (url.pathname.startsWith('/pwa/')) {
        event.respondWith(
            fetch(event.request)
                .catch(() => caches.match(event.request))
        );
    }

    // Let all other requests pass through to network normally
});
