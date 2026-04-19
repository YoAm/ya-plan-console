// ya-plan console service worker v1
// Caches app shell (HTML/JS) so the console opens offline.
// API responses are NOT cached — always fresh from GitHub when online.

const CACHE = 'yp-console-v1';
const SHELL = ['./', './index.html', './app.js', './manifest.json'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // Never cache GitHub API — always try network first
  if (url.hostname === 'api.github.com') {
    return; // let default handle it
  }
  // App shell: cache-first fallback to network
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});
