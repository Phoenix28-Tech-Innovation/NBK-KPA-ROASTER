const RELEASE_VERSION = 'b0a60758e68281bb27d08c84bb1a367a9961d4b0';
const RELEASE_CACHE_PREFIX = 'nbk-kpa-release-';
const RELEASE_STATE_CACHE = 'nbk-kpa-release-state';
const SCOPE_URL = self.registration.scope;
const ACTIVE_RELEASE_KEY = new URL('__active_release__', SCOPE_URL).href;

function releaseCacheName(version) {
    return `${RELEASE_CACHE_PREFIX}${version}`;
}

function releasePageUrl(version) {
    return new URL(`releases/${version}.html`, SCOPE_URL).href;
}

async function getActiveReleaseVersion() {
    const stateCache = await caches.open(RELEASE_STATE_CACHE);
    const response = await stateCache.match(ACTIVE_RELEASE_KEY);
    return response ? response.text() : RELEASE_VERSION;
}

function serveAtRequestedUrl(response) {
    return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers
    });
}

self.addEventListener('install', event => {
    event.waitUntil(
        (async () => {
            const releaseCache = await caches.open(releaseCacheName(RELEASE_VERSION));
            await releaseCache.add(releasePageUrl(RELEASE_VERSION));
            await releaseCache.addAll([
                new URL('favicon.ico', SCOPE_URL).href,
                new URL('index.html', SCOPE_URL).href,
                new URL('manifest.json', SCOPE_URL).href,
                new URL('update.json', SCOPE_URL).href,
                new URL('icons/roster-icon.svg', SCOPE_URL).href,
                new URL('icons/favicon-16x16.png', SCOPE_URL).href,
                new URL('icons/favicon-32x32.png', SCOPE_URL).href,
                new URL('icons/roster-icon-192.png', SCOPE_URL).href,
                new URL('icons/roster-icon-512.png', SCOPE_URL).href
            ]);
        })()
    );
});

self.addEventListener('message', event => {
    if (event.data?.type === 'ACTIVATE_RELEASE' && event.data.version === RELEASE_VERSION) {
        event.waitUntil(self.skipWaiting());
    }
});

self.addEventListener('activate', event => {
    event.waitUntil((async () => {
        const stateCache = await caches.open(RELEASE_STATE_CACHE);
        await stateCache.put(ACTIVE_RELEASE_KEY, new Response(RELEASE_VERSION));
        const cacheNames = await caches.keys();
        await Promise.all(cacheNames
            .filter(name => name.startsWith(RELEASE_CACHE_PREFIX) && name !== releaseCacheName(RELEASE_VERSION))
            .map(name => caches.delete(name)));
        await self.clients.claim();
    })());
});

self.addEventListener('fetch', event => {
    const requestUrl = new URL(event.request.url);
    const scopePath = new URL(SCOPE_URL).pathname;
    if (event.request.method === 'GET' &&
        requestUrl.origin === self.location.origin &&
        ['/favicon.ico', '/manifest.json', '/manifest.webmanifest', '/index.html', '/update.json',
         '/icons/roster-icon.svg', '/icons/favicon-16x16.png', '/icons/favicon-32x32.png',
         '/icons/roster-icon-192.png', '/icons/roster-icon-512.png']
            .includes(requestUrl.pathname.replace(scopePath, '/'))) {
        event.respondWith((async () => {
            const cached = await caches.match(event.request);
            if (cached) return cached;
            const response = await fetch(event.request);
            if (response.ok) {
                const cache = await caches.open(releaseCacheName(RELEASE_VERSION));
                await cache.put(event.request, response.clone());
            }
            return response;
        })());
        return;
    }
    const isAppNavigation = event.request.method === 'GET' &&
        event.request.mode === 'navigate' &&
        requestUrl.origin === self.location.origin &&
        (requestUrl.pathname === scopePath ||
            requestUrl.pathname === `${scopePath}index.html`);

    if (!isAppNavigation) return;

    event.respondWith((async () => {
        const activeVersion = await getActiveReleaseVersion();
        const cache = await caches.open(releaseCacheName(activeVersion));
        const pageUrl = releasePageUrl(activeVersion);
        const cachedPage = await cache.match(pageUrl);
        if (cachedPage) return serveAtRequestedUrl(cachedPage);

        const response = await fetch(pageUrl, { cache: 'no-store' });
        if (!response.ok) return response;
        await cache.put(pageUrl, response.clone());
        return serveAtRequestedUrl(response);
    })());
});
