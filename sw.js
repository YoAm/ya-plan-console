// ya-plan console service worker v3
// Caches app shell for offline use. Auto-updates: new SW takes over on first
// fetch after deploy; posts "update-ready" message so app can reload itself.

const CACHE = 'yp-console-v3';
const SHELL = ['./', './index.html', './app.js', './manifest.json'];

self.addEventListener('install', (e) => {
  // New SW version takes over immediately instead of waiting for all tabs to close
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    // Purge old caches
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    // Claim all tabs so the new SW controls them
    await self.clients.claim();
    // Tell every open tab there's an update — they can reload
    const clients = await self.clients.matchAll({ type: 'window' });
    for (const client of clients) {
      client.postMessage({ type: 'sw-updated', cache: CACHE });
    }
  })());
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // Never cache GitHub API — always hit the network
  if (url.hostname === 'api.github.com') return;
  // App shell: cache-first, network fallback
  e.respondWith(caches.match(e.request).then(cached => cached || fetch(e.request)));
});

// Allow page to force-unregister this SW (for the "Hard reload" button)
self.addEventListener('message', (e) => {
  if (e.data?.type === 'skipWaiting') self.skipWaiting();
  if (e.data?.type === 'unregister') {
    self.registration.unregister().then(() => {
      self.clients.matchAll({ type: 'window' }).then(cs => {
        cs.forEach(c => c.postMessage({ type: 'sw-unregistered' }));
      });
    });
  }
});
