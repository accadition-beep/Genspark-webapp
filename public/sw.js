// adition Service Worker v4
const CACHE_NAME = 'adition-v4';
const SYNC_TAG   = 'adition-sync';
const IDB_NAME   = 'adition-offline';
const IDB_VER    = 4;

const STATIC_ASSETS = ['/', '/index.html', '/static/app.js', '/static/style.css', '/favicon.svg'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE_NAME).then(cache => Promise.allSettled(STATIC_ASSETS.map(u => cache.add(u).catch(() => {})))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.pathname.startsWith('/api/')) {
    e.respondWith(fetch(e.request).catch(() => new Response(JSON.stringify({ error: 'offline', offline: true }), { status: 503, headers: { 'Content-Type': 'application/json' } })));
    return;
  }
  e.respondWith(caches.match(e.request).then(cached => {
    if (cached) return cached;
    return fetch(e.request).then(resp => {
      if (resp.ok) { const clone = resp.clone(); caches.open(CACHE_NAME).then(c => c.put(e.request, clone)); }
      return resp;
    }).catch(() => e.request.mode === 'navigate' ? caches.match('/index.html') : new Response('', { status: 404 }));
  }));
});

self.addEventListener('sync', e => { if (e.tag === SYNC_TAG) e.waitUntil(flushOfflineQueue()); });

self.addEventListener('message', e => {
  if (e.data?.type === 'SYNC_NOW') flushOfflineQueue();
});

async function flushOfflineQueue() {
  const db = await openIDB(); const items = await getAllPending(db); if (!items.length) return;
  const token = await getAuthToken(db); let synced = 0;
  items.sort((a, b) => (a.ts || 0) - (b.ts || 0));
  for (const item of items) {
    try {
      const resp = await fetch(item.url, { method: item.method, headers: { 'Content-Type': 'application/json', 'Authorization': token ? `Bearer ${token}` : '', 'X-Offline-Ts': String(item.ts || Date.now()) }, body: item.body || undefined });
      if (resp.ok || resp.status === 409 || resp.status === 400 || resp.status === 422) { await deletePending(db, item.id); synced++; }
      else if (resp.status === 401 || resp.status === 403) break;
    } catch { break; }
  }
  if (synced > 0) { const clients = await self.clients.matchAll(); clients.forEach(c => c.postMessage({ type: 'SYNC_DONE', count: synced })); }
}

function openIDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, IDB_VER);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('queue')) { const s = db.createObjectStore('queue', { keyPath: 'id', autoIncrement: true }); s.createIndex('status_idx', 'status'); }
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('offline_data')) db.createObjectStore('offline_data', { keyPath: 'key' });
    };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = () => reject(req.error);
  });
}
function getAllPending(db) {
  return new Promise(resolve => {
    const items = []; const req = db.transaction('queue', 'readonly').objectStore('queue').openCursor();
    req.onsuccess = e => { const c = e.target.result; if (c) { if (c.value.status === 'pending') items.push(c.value); c.continue(); } else resolve(items); };
    req.onerror = () => resolve([]);
  });
}
function deletePending(db, id) {
  return new Promise(resolve => { const req = db.transaction('queue', 'readwrite').objectStore('queue').delete(id); req.onsuccess = () => resolve(); req.onerror = () => resolve(); });
}
function getAuthToken(db) {
  return new Promise(resolve => { const req = db.transaction('meta', 'readonly').objectStore('meta').get('auth_token'); req.onsuccess = e => resolve(e.target.result?.value || null); req.onerror = () => resolve(null); });
}
