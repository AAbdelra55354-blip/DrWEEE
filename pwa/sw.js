/**
 * DrWEEE PWA Service Worker
 * Caching strategy: Cache-First for shell, Network-Only for Dynamics
 */

const CACHE_NAME = 'drweee-app-shell-v1';
const CACHE_VERSION = 1;

// Shell assets to pre-cache
const SHELL_ASSETS = [
    '/pwa/app-shell.html',
    '/pwa/offline.html',
    '/pwa/assets/app-shell.css',
    '/pwa/js/offline-manager.js',
    '/pwa/js/pwa-bridge.js',
    '/pwa/js/install-prompt.js',
    '/pwa/js/deep-link-router.js',
    '/pwa/assets/icons/icon-192x192.png',
    '/pwa/assets/icons/icon-512x512.png',
    '/pwa/manifest.json'
];

// Domains that should never be cached (require authentication)
const NO_CACHE_DOMAINS = [
    'dynamics.com',
    'crm3.dynamics.com',
    'crm.dynamics.com',
    'microsoftonline.com',
    'login.microsoftonline.com',
    'login.microsoft.com'
];

/**
 * Install event - Pre-cache shell assets
 */
self.addEventListener('install', (event) => {
    console.log('[SW] Installing service worker v' + CACHE_VERSION);

    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => {
                console.log('[SW] Pre-caching shell assets');
                return cache.addAll(SHELL_ASSETS);
            })
            .then(() => {
                console.log('[SW] Shell assets cached successfully');
                return self.skipWaiting();
            })
            .catch(error => {
                console.error('[SW] Failed to cache shell assets:', error);
            })
    );
});

/**
 * Activate event - Clean up old caches
 */
self.addEventListener('activate', (event) => {
    console.log('[SW] Activating service worker v' + CACHE_VERSION);

    event.waitUntil(
        caches.keys()
            .then(cacheNames => {
                return Promise.all(
                    cacheNames
                        .filter(cacheName => cacheName !== CACHE_NAME)
                        .map(cacheName => {
                            console.log('[SW] Deleting old cache:', cacheName);
                            return caches.delete(cacheName);
                        })
                );
            })
            .then(() => {
                console.log('[SW] Service worker activated');
                return self.clients.claim();
            })
    );
});

/**
 * Check if URL should not be cached
 */
function shouldNotCache(url) {
    return NO_CACHE_DOMAINS.some(domain => url.hostname.includes(domain));
}

/**
 * Check if request is for a shell asset
 */
function isShellAsset(url) {
    return SHELL_ASSETS.some(asset =>
        url.pathname === asset || url.pathname.endsWith(asset)
    );
}

/**
 * Fetch event - Handle all network requests
 */
self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);

    // Strategy 1: Navigation requests to /app* serve the app shell
    if (event.request.mode === 'navigate' && url.pathname.startsWith('/app')) {
        event.respondWith(
            caches.match('/pwa/app-shell.html')
                .then(response => {
                    if (response) {
                        console.log('[SW] Serving app shell from cache');
                        return response;
                    }
                    return fetch(event.request);
                })
                .catch(() => {
                    console.log('[SW] Serving offline page');
                    return caches.match('/pwa/offline.html');
                })
        );
        return;
    }

    // Strategy 2: Shell assets - Cache First
    if (isShellAsset(url)) {
        event.respondWith(
            caches.match(event.request)
                .then(response => {
                    if (response) {
                        return response;
                    }
                    return fetch(event.request).then(networkResponse => {
                        // Cache the new response
                        if (networkResponse.ok) {
                            const clone = networkResponse.clone();
                            caches.open(CACHE_NAME).then(cache => {
                                cache.put(event.request, clone);
                            });
                        }
                        return networkResponse;
                    });
                })
        );
        return;
    }

    // Strategy 3: Dynamics 365 and auth requests - Network Only (no caching)
    if (shouldNotCache(url)) {
        event.respondWith(fetch(event.request));
        return;
    }

    // Strategy 4: PWA assets - Cache First with network fallback
    if (url.pathname.startsWith('/pwa/')) {
        event.respondWith(
            caches.match(event.request)
                .then(response => {
                    return response || fetch(event.request).then(networkResponse => {
                        if (networkResponse.ok) {
                            const clone = networkResponse.clone();
                            caches.open(CACHE_NAME).then(cache => {
                                cache.put(event.request, clone);
                            });
                        }
                        return networkResponse;
                    });
                })
        );
        return;
    }

    // Strategy 5: Images and static assets - Stale While Revalidate
    if (url.pathname.match(/\.(png|jpg|jpeg|gif|svg|ico|woff|woff2)$/)) {
        event.respondWith(
            caches.match(event.request)
                .then(cachedResponse => {
                    const fetchPromise = fetch(event.request).then(networkResponse => {
                        if (networkResponse.ok) {
                            const clone = networkResponse.clone();
                            caches.open(CACHE_NAME).then(cache => {
                                cache.put(event.request, clone);
                            });
                        }
                        return networkResponse;
                    }).catch(() => cachedResponse);

                    return cachedResponse || fetchPromise;
                })
        );
        return;
    }

    // Strategy 6: Everything else - Network First with cache fallback
    event.respondWith(
        fetch(event.request)
            .then(response => {
                // Only cache successful responses for same-origin requests
                if (response.ok && url.origin === self.location.origin) {
                    const clone = response.clone();
                    caches.open(CACHE_NAME).then(cache => {
                        cache.put(event.request, clone);
                    });
                }
                return response;
            })
            .catch(() => caches.match(event.request))
    );
});

/**
 * Push notification handler
 */
self.addEventListener('push', (event) => {
    if (!event.data) {
        console.log('[SW] Push received but no data');
        return;
    }

    let data;
    try {
        data = event.data.json();
    } catch (e) {
        data = {
            title: 'DrWEEE',
            body: event.data.text()
        };
    }

    const options = {
        body: data.body || '',
        icon: '/pwa/assets/icons/icon-192x192.png',
        badge: '/pwa/assets/icons/icon-72x72.png',
        vibrate: [100, 50, 100],
        data: {
            url: data.url || '/app',
            dateOfArrival: Date.now()
        },
        actions: data.actions || [],
        tag: data.tag || 'drweee-notification',
        renotify: data.renotify || false
    };

    event.waitUntil(
        self.registration.showNotification(data.title || 'DrWEEE', options)
    );
});

/**
 * Notification click handler
 */
self.addEventListener('notificationclick', (event) => {
    console.log('[SW] Notification clicked:', event.notification.tag);

    event.notification.close();

    const url = event.notification.data?.url || '/app';

    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true })
            .then(clientList => {
                // Try to focus an existing window
                for (const client of clientList) {
                    if (client.url.includes('/app') && 'focus' in client) {
                        // Send message to navigate
                        client.postMessage({
                            type: 'notification:clicked',
                            url: url
                        });
                        return client.focus();
                    }
                }
                // Open new window if none found
                return clients.openWindow(url);
            })
    );
});

/**
 * Background sync handler (for future offline form submissions)
 */
self.addEventListener('sync', (event) => {
    console.log('[SW] Background sync:', event.tag);

    if (event.tag === 'sync-pending-data') {
        event.waitUntil(
            // Future: sync offline data when connection restored
            Promise.resolve()
        );
    }
});

/**
 * Message handler for communication with main thread
 */
self.addEventListener('message', (event) => {
    console.log('[SW] Message received:', event.data);

    if (event.data?.type === 'skipWaiting') {
        self.skipWaiting();
    }

    if (event.data?.type === 'getVersion') {
        event.ports[0]?.postMessage({
            version: CACHE_VERSION,
            cacheName: CACHE_NAME
        });
    }
});
