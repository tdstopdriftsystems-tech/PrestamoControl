// ============================================================
//  PRESTAMOCONTROL — SERVICE WORKER v2.0
//  Estrategia: Cache-First para assets, Network-First para datos
// ============================================================

const SW_VERSION = '2.0.0';
const CACHE_NAME = `prestamocontrol-v${SW_VERSION}`;
const DATA_CACHE = `prestamocontrol-data-v${SW_VERSION}`;

// Assets a cachear en la instalación
const PRECACHE_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icons/icon-192x192.png',
  './icons/icon-512x512.png',
  './icons/maskable-192.png',
  // CDN libs — cached on first load
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js',
];

// ── INSTALL ──────────────────────────────────────────────
self.addEventListener('install', event => {
  console.log('[SW] Installing PrestamoControl SW', SW_VERSION);
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('[SW] Pre-caching assets...');
        // Cache local assets strictly, CDN assets best-effort
        const localAssets = PRECACHE_ASSETS.filter(url => !url.startsWith('http'));
        const cdnAssets = PRECACHE_ASSETS.filter(url => url.startsWith('http'));

        return cache.addAll(localAssets).then(() => {
          // CDN: best effort, don't fail install if CDN is down
          return Promise.allSettled(
            cdnAssets.map(url =>
              fetch(url, { mode: 'cors' })
                .then(res => res.ok ? cache.put(url, res) : null)
                .catch(() => console.log('[SW] CDN not cached:', url))
            )
          );
        });
      })
      .then(() => {
        console.log('[SW] Install complete, skipping wait');
        return self.skipWaiting();
      })
  );
});

// ── ACTIVATE ─────────────────────────────────────────────
self.addEventListener('activate', event => {
  console.log('[SW] Activating...');
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames
          .filter(name => name.startsWith('prestamocontrol-') && name !== CACHE_NAME && name !== DATA_CACHE)
          .map(name => {
            console.log('[SW] Deleting old cache:', name);
            return caches.delete(name);
          })
      );
    }).then(() => {
      console.log('[SW] Activated, claiming clients');
      return self.clients.claim();
    })
  );
});

// ── FETCH STRATEGY ───────────────────────────────────────
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Skip non-GET and Chrome extensions
  if (event.request.method !== 'GET') return;
  if (url.protocol === 'chrome-extension:') return;

  // CDN libs → Cache First (they never change for a given version)
  if (url.hostname.includes('cdnjs.cloudflare.com') || url.hostname.includes('fonts.googleapis.com') || url.hostname.includes('fonts.gstatic.com')) {
    event.respondWith(cacheFirst(event.request));
    return;
  }

  // App shell → Stale While Revalidate
  if (url.pathname.endsWith('.html') || url.pathname === '/' || url.pathname.endsWith('/')) {
    event.respondWith(staleWhileRevalidate(event.request));
    return;
  }

  // Icons and static assets → Cache First
  if (url.pathname.includes('/icons/') || url.pathname.endsWith('.png') || url.pathname.endsWith('.json')) {
    event.respondWith(cacheFirst(event.request));
    return;
  }

  // Default → Network with cache fallback
  event.respondWith(networkWithCacheFallback(event.request));
});

// ── CACHE STRATEGIES ─────────────────────────────────────

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    return new Response('Recurso no disponible offline', { status: 503 });
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);

  const fetchPromise = fetch(request).then(response => {
    if (response.ok) cache.put(request, response.clone());
    return response;
  }).catch(() => null);

  return cached || fetchPromise || offlineFallback();
}

async function networkWithCacheFallback(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(request);
    return cached || offlineFallback();
  }
}

function offlineFallback() {
  return caches.match('./index.html').then(r => r || new Response(
    `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>PrestamoControl — Sin conexión</title>
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <style>body{background:#0a0c10;color:#e8ecf4;font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;flex-direction:column;gap:16px;text-align:center;padding:20px}
    h2{color:#00e5a0;font-size:1.4rem}p{color:#6b7494;max-width:320px}
    button{background:#00e5a0;color:#0a0c10;border:none;padding:12px 24px;border-radius:8px;font-size:1rem;cursor:pointer;font-weight:600;margin-top:8px}</style></head>
    <body><div style="font-size:3rem">💰</div><h2>PrestamoControl</h2>
    <p>Sin conexión a internet. La app funciona offline — abre desde la pantalla de inicio.</p>
    <button onclick="location.reload()">🔄 Reintentar</button></body></html>`,
    { headers: { 'Content-Type': 'text/html' } }
  ));
}

// ── BACKGROUND SYNC ──────────────────────────────────────
// Sincroniza datos cuando recupera conexión
self.addEventListener('sync', event => {
  console.log('[SW] Background sync:', event.tag);
  if (event.tag === 'backup-sync') {
    event.waitUntil(handleBackupSync());
  }
});

async function handleBackupSync() {
  // Notify all clients that sync is available
  const clients = await self.clients.matchAll();
  clients.forEach(client => {
    client.postMessage({ type: 'SYNC_READY', tag: 'backup-sync' });
  });
}

// ── PUSH NOTIFICATIONS ───────────────────────────────────
self.addEventListener('push', event => {
  console.log('[SW] Push received');
  let data = { title: 'PrestamoControl', body: 'Tienes cobros pendientes', icon: './icons/icon-192x192.png' };

  if (event.data) {
    try { data = { ...data, ...event.data.json() }; } catch {}
  }

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: data.icon || './icons/icon-192x192.png',
      badge: './icons/icon-72x72.png',
      tag: data.tag || 'prestamocontrol',
      renotify: true,
      requireInteraction: false,
      vibrate: [200, 100, 200],
      actions: [
        { action: 'open-cobros', title: '📅 Ver Cobros' },
        { action: 'dismiss',     title: 'Cerrar' }
      ],
      data: data
    })
  );
});

// ── NOTIFICATION CLICK ───────────────────────────────────
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const action = event.action;
  const url = action === 'open-cobros' ? './index.html?view=cobros' : './index.html';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
      // Focus existing window if open
      for (const client of clients) {
        if (client.url.includes('prestamocontrol') || client.url.includes('index.html')) {
          client.focus();
          client.postMessage({ type: 'NAVIGATE', view: action === 'open-cobros' ? 'cobros' : 'dashboard' });
          return;
        }
      }
      // Open new window
      return self.clients.openWindow(url);
    })
  );
});

// ── MESSAGE HANDLER ──────────────────────────────────────
self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
  if (event.data?.type === 'GET_VERSION') {
    event.ports[0]?.postMessage({ version: SW_VERSION, cache: CACHE_NAME });
  }
  if (event.data?.type === 'CLEAR_CACHE') {
    caches.delete(CACHE_NAME).then(() => event.ports[0]?.postMessage({ ok: true }));
  }
});

console.log('[SW] PrestamoControl Service Worker', SW_VERSION, 'loaded');
