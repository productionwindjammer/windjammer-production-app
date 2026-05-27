// Service worker that keeps installed users on the latest version.
//   - HTML/navigation requests: network-first (so index.html always reflects newest deploy)
//   - Hashed JS/CSS/images: cache-first (Vite fingerprints filenames, so stale = wrong URL = miss)
//   - On update, notifies open clients so the UI can prompt a reload.
//
// Bump CACHE when you intentionally want to nuke all old caches.
const CACHE = 'windjammer-v3';
const SHELL = ['/manifest.webmanifest', '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => {}));
  // Activate immediately so we don't wait for all tabs to close
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
    const clients = await self.clients.matchAll({ type: 'window' });
    clients.forEach(c => c.postMessage({ type: 'SW_UPDATED' }));
  })());
});

// Allow the page to trigger an immediate skip-waiting
self.addEventListener('message', e => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});

// Always returns a real Response so respondWith never sees null/undefined
// (which would throw "Failed to convert value to 'Response'").
function offlineResponse(message = 'Offline') {
  return new Response(message, {
    status: 503,
    statusText: 'Offline',
    headers: { 'Content-Type': 'text/plain' },
  });
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); }
  catch { return; }

  // Only handle same-origin requests; let the browser do its thing for everything else.
  if (url.origin !== self.location.origin) return;

  // Never cache API or auth callbacks
  if (url.pathname.startsWith('/api/')) return;

  // HTML / navigations: network-first so users always pick up the newest deploy
  const isHtml =
    req.mode === 'navigate' ||
    (req.headers.get('accept') || '').includes('text/html');

  if (isHtml) {
    e.respondWith((async () => {
      try {
        const fresh = await fetch(req, { cache: 'no-store' });
        // Cache the app shell under '/' so we can serve it offline for SPA routes
        try {
          const copy = fresh.clone();
          const cache = await caches.open(CACHE);
          await cache.put('/', copy);
        } catch {}
        return fresh;
      } catch {
        const cached = (await caches.match('/')) || (await caches.match(req));
        return cached || offlineResponse('Offline');
      }
    })());
    return;
  }

  // Static assets: cache-first, refresh in background
  e.respondWith((async () => {
    try {
      const cached = await caches.match(req);
      if (cached) {
        // Refresh in the background, but don't block the response on it.
        fetch(req).then(res => {
          if (res && res.ok) caches.open(CACHE).then(c => c.put(req, res.clone())).catch(() => {});
        }).catch(() => {});
        return cached;
      }
      const res = await fetch(req);
      if (res && res.ok) {
        try {
          const copy = res.clone();
          const cache = await caches.open(CACHE);
          await cache.put(req, copy);
        } catch {}
      }
      return res || offlineResponse('Resource unavailable');
    } catch {
      return offlineResponse('Resource unavailable');
    }
  })());
});
