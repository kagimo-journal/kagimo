/*
 * Kagimo service worker (SPEC §10 "Offline app"). Generated at build time from
 * src/sw/sw-template.js: __VERSION__ and __PRECACHE__ are filled in by vite.config.ts.
 *
 * - The app shell (index.html and every built asset) is cached at install, so Kagimo opens
 *   with no network at all. A new version installs in the background and takes over when the
 *   page asks (after the person agreed to reload).
 * - Other same-origin static files (the places dataset, icons) are cached the first time they
 *   are used.
 * - /api/ is never touched: journal data lives in IndexedDB, and sync talks to the server itself.
 */
const VERSION = '__VERSION__';
const PRECACHE = __PRECACHE__;
const SHELL = `kagimo-shell-${VERSION}`;
const RUNTIME = 'kagimo-runtime-v1';

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL).then((c) => c.addAll(PRECACHE)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) {
        if (key.startsWith('kagimo-shell-') && key !== SHELL) await caches.delete(key);
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // The API and installer downloads always come from the server, never from a cache or the app shell.
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/') || url.pathname.startsWith('/download/') || url.pathname === '/sw.js') return;

  if (req.mode === 'navigate') {
    // Client-side routes all render index.html: the cached shell, whatever the path.
    event.respondWith(
      (async () => {
        const shell = await caches.open(SHELL);
        const cached = await shell.match('/index.html');
        if (cached) return cached;
        return fetch(req);
      })(),
    );
    return;
  }

  event.respondWith(
    (async () => {
      const shell = await caches.open(SHELL);
      const hit = await shell.match(req, { ignoreSearch: true });
      if (hit) return hit;
      const runtime = await caches.open(RUNTIME);
      const cached = await runtime.match(req);
      if (cached) return cached;
      const res = await fetch(req);
      // Only complete, same-origin, non-HTML responses are worth keeping.
      const type = res.headers.get('Content-Type') || '';
      if (res.ok && res.status === 200 && !type.includes('text/html')) await runtime.put(req, res.clone());
      return res;
    })(),
  );
});
