/* ═══════════════════════════════════════════════════════
   Shadow Ledger — Service Worker
   Cache-first for app shell, network-first for Firebase
   ═══════════════════════════════════════════════════════ */

const CACHE_VERSION = 'sl-v21';
const CACHE_NAME   = 'st3s-' + CACHE_VERSION;
const FIREBASE_V   = '10.13.2';
const APP_SHELL = [
  '/',
  '/index.html',
  '/app.js',
  '/firebase-config.js',
  '/manifest.json',
  '/sw.js',
  '/icon.svg',
  '/warehouse-3d.html',
  '/mobile.html',
  '/guest-out.html',
  '/proofinv.html',
  `https://www.gstatic.com/firebasejs/${FIREBASE_V}/firebase-app-compat.js`,
  `https://www.gstatic.com/firebasejs/${FIREBASE_V}/firebase-auth-compat.js`,
  `https://www.gstatic.com/firebasejs/${FIREBASE_V}/firebase-firestore-compat.js`,
  'https://cdn.tailwindcss.com/3.4.16',
  'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js',
  'https://cdn.jsdelivr.net/npm/qrcodejs@1.0.0/qrcode.min.js'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(APP_SHELL).catch(() => {
        // Fallback: cache each asset individually so one failure doesn't block install
        return Promise.all(
          APP_SHELL.map(url =>
            cache.add(url).catch(() => null)
          )
        );
      }))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // Never cache Firestore or Auth requests — always go to network
  if (url.host.includes('googleapis.com') ||
      url.host.includes('firebaseio.com') ||
      url.host.includes('firestore.googleapis.com') ||
      url.host.includes('identitytoolkit.googleapis.com')) {
    return; // browser default: network
  }

  // CDN scripts: stale-while-revalidate
  if (url.host.includes('cdn.') || url.host.includes('gstatic.com')) {
    event.respondWith(
      caches.match(request).then(cached => {
        const network = fetch(request).then(resp => {
          if (resp.ok) {
            const clone = resp.clone();
            caches.open(CACHE_NAME).then(c => c.put(request, clone));
          }
          return resp;
        }).catch(() => cached);
        return cached || network;
      })
    );
    return;
  }

  // App shell: cache-first
  event.respondWith(
    caches.match(request).then(cached => {
      return cached || fetch(request).then(resp => {
        if (resp.ok && request.method === 'GET') {
          const clone = resp.clone();
          caches.open(CACHE_NAME).then(c => c.put(request, clone));
        }
        return resp;
      }).catch(() => {
        // Offline fallback: return index.html for navigation requests
        if (request.mode === 'navigate') {
          return caches.match('/index.html');
        }
      });
    })
  );
});
