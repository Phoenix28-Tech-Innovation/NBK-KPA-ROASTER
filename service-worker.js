const RELEASE_VERSION = '375258c7ef17697dc08742c889418f1cdbfeaf32';
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
        caches.open(releaseCacheName(RELEASE_VERSION))
            .then(cache => cache.add(releasePageUrl(RELEASE_VERSION)))
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
