// Taller IA · service worker: la app abre sin conexión y recibe lo que se comparte desde otras apps.
// Al publicar cambios, sube la versión para que los dispositivos renueven la copia.
const V = 'taller-ia-1.3.1';
const SHELL = ['./', 'index.html', 'app.css', 'app.js', 'backend.js', 'media.js', 'store.js', 'config.js', 'manifest.webmanifest',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png', 'fonts/archivo-latin-wdth-normal.woff2'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(V).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith('taller-ia-') && k !== V).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Compartir con «Taller IA» desde la galería o WhatsApp (Android): se guarda lo recibido y la app lo recoge al abrir
async function receiveShare(req) {
  try {
    const fd = await req.formData();
    const cache = await caches.open('taller-share');
    await Promise.all((await cache.keys()).map((k) => cache.delete(k)));
    let i = 0;
    for (const f of fd.getAll('files')) {
      if (!f || typeof f === 'string') continue;
      await cache.put('shared/' + (i++), new Response(f, { headers: { 'Content-Type': f.type || 'application/octet-stream', 'X-Name': encodeURIComponent(f.name || 'adjunto') } }));
    }
    const text = [fd.get('title'), fd.get('text'), fd.get('url')].filter((x) => typeof x === 'string' && x).join('\n');
    if (text) await cache.put('shared/text', new Response(text));
  } catch (err) { /* se abre la app igualmente */ }
  return Response.redirect('./?share=1', 303);
}

self.addEventListener('fetch', (e) => {
  const req = e.request, url = new URL(req.url);
  if (url.origin !== self.location.origin) return;                 // la cola de Google va directa, nunca por caché
  if (req.method === 'POST' && url.pathname.endsWith('/share')) { e.respondWith(receiveShare(req)); return; }
  if (req.method !== 'GET') return;
  e.respondWith((async () => {
    const cache = await caches.open(V);
    const nav = req.mode === 'navigate';
    const hit = await cache.match(nav ? 'index.html' : req);
    const net = fetch(req).then((r) => { if (r.ok && r.type === 'basic' && !url.search) cache.put(nav ? 'index.html' : req, r.clone()); return r; }).catch(() => null);
    if (hit) { e.waitUntil(net); return hit; }                       // sirve la copia y se pone al día por detrás
    return (await net) || Response.error();
  })());
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => (list.length ? list[0].focus() : self.clients.openWindow('./'))));
});
