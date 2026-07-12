const CACHE_NAME = "tracksuite-work-v1";
const ASSETS = [
    "/",
    "/index.html",
    "/logo_light.png",
    "/logo_dark.png",
    "/manifest.json"
];

// Install event - caching basic shell assets
self.addEventListener("install", event => {
    event.waitUntil(
        caches.open(CACHE_NAME).then(cache => {
            return cache.addAll(ASSETS);
        })
    );
});

// Activate event - cleanup old caches
self.addEventListener("activate", event => {
    event.waitUntil(
        caches.keys().then(keys => {
            return Promise.all(
                keys.map(key => {
                    if (key !== CACHE_NAME) {
                        return caches.delete(key);
                    }
                })
            );
        })
    );
});

// Fetch event - Network first strategy
self.addEventListener("fetch", event => {
    // Only intercept local HTTP/HTTPS requests
    if (!event.request.url.startsWith(self.location.origin)) {
        return;
    }

    // Skip API calls so they don't get cached offline stale data
    if (event.request.url.includes("/api/")) {
        return;
    }

    event.respondWith(
        fetch(event.request)
            .then(response => {
                // If response is valid, clone it and cache it
                if (response.status === 200) {
                    const responseClone = response.clone();
                    caches.open(CACHE_NAME).then(cache => {
                        cache.put(event.request, responseClone);
                    });
                }
                return response;
            })
            .catch(() => {
                // Network failed, try cache
                return caches.match(event.request).then(cachedResponse => {
                    if (cachedResponse) {
                        return cachedResponse;
                    }
                    // If everything fails, fallback
                    return caches.match("/");
                });
            })
    );
});
