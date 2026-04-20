// ya-plan console service worker v17 (AR-025 monorepo restructure)
// Caches console/ shell. Infra modules at ../infra/ are outside this SW's
// scope, so they rely on browser HTTP cache — acceptable trade-off (first
// offline load requires prior network visit that primed the HTTP cache).
// Auto-updates: new SW takes over on first fetch after deploy; posts
// "sw-updated" message so app can reload itself.

const CACHE = 'yp-console-v17';
const SHELL = [
  './',
  './index.html',
  './app.js',
  './config.js',
  './events-compose.js',
  './telemetry.js',
  './debug.js',
  './inbox.js',
  './health.js',
  './manifest.json',
  './runner/index.html',
  './runner/config.js',
  './runner/runner-ui.js',
];

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

  // For HTML and JS: network-first, cache fallback.
  // Rationale: cache-first means users can get stuck on stale JS after
  // a push (no listener to hear the new-SW signal). Network-first ensures
  // each load pulls fresh when online, with offline-cache as backup.
  const isHtml = e.request.destination === 'document' || url.pathname.endsWith('.html') || url.pathname.endsWith('/');
  const isJs = url.pathname.endsWith('.js');
  if (isHtml || isJs) {
    e.respondWith(
      fetch(e.request).then(resp => {
        // Update cache in background for offline fallback
        if (resp && resp.ok) {
          const copy = resp.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
        }
        return resp;
      }).catch(() => caches.match(e.request).then(c => c || Response.error()))
    );
    return;
  }

  // Non-JS/HTML assets (icons, manifest): cache-first for speed
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
