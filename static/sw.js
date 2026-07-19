const CACHE_NAME = 'shadow-ledger-v1';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icon.svg'
];

const CACHE_STRATEGIES = {
  'firebase-sdk': { pattern: /^https:\/\/www\.gstatic\.com\/firebasejs\/.*/, strategy: 'cache-first', maxAge: 60 * 60 * 24 * 30 },
  'tailwind-cdn': { pattern: /^https:\/\/cdn\.tailwindcss\.com\/.*/, strategy: 'stale-while-revalidate', maxAge: 60 * 60 * 24 * 7 },
  'static': { pattern: /^.*$/, strategy: 'network-first', maxAge: 60 * 60 * 24 }
};

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  if (url.origin !== location.origin && !url.host.includes('gstatic.com') && !url.host.includes('cdn.tailwindcss.com')) {
    return;
  }

  if (request.method !== 'GET') return;

  const strategy = Object.values(CACHE_STRATEGIES).find(s => s.pattern.test(url.href)) || CACHE_STRATEGIES.static;

  if (strategy.strategy === 'cache-first') {
    event.respondWith(
      caches.match(request).then((cached) => cached || fetchAndCache(request))
    );
  } else if (strategy.strategy === 'stale-while-revalidate') {
    event.respondWith(
      caches.match(request).then((cached) => {
        const network = fetchAndCache(request).catch(() => cached);
        return cached || network;
      })
    );
  } else {
    event.respondWith(
      fetchAndCache(request).catch(() => caches.match(request))
    );
  }
});

async function fetchAndCache(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    return caches.match(request);
  }
}

self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') {
    self.skipWaiting();
  }
});