// Taller IA · service worker: la app abre sin conexión y recibe lo que se comparte desde otras apps.
// Al publicar cambios, sube la versión para que los dispositivos renueven la copia.
const V = 'taller-ia-1.4.0';
const SHELL = ['./', 'index.html', 'app.css', 'app.js', 'backend.js', 'media.js', 'store.js', 'voz.js', 'config.js', 'manifest.webmanifest',
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

// ------------------------------------------------------------------ avisos push
// El trabajador manda el formato de Declarative Web Push ({ web_push: 8030, notification: { title, body, navigate,
// tag } }): en Safari 18.4+ el sistema lo muestra aunque falle este código; aquí se muestra en todos los demás
// (Chrome en Android, Firefox, Edge) y en Safari se sustituye por el mismo aviso. Siempre se enseña un aviso visible.
const CASO = /^[\w.-]{1,100}$/;
function casoDe(url) {
  try { const u = new URL(url, self.registration.scope); const c = u.searchParams.get('caso'); return u.origin === self.location.origin && CASO.test(c || '') ? c : ''; } catch (err) { return ''; }
}
// waitUntil solo admite eventos del navegador: si no se puede (p. ej. un evento simulado), el trabajo sigue igual
const hold = (e, p) => { try { e.waitUntil(p); } catch (err) { /* evento sin waitUntil */ } return p; };

async function onPush(data) {
  let d = {};
  try { d = data ? data.json() : {}; } catch (err) { d = { notification: { title: 'Taller IA', body: data ? data.text().slice(0, 200) : '' } }; }
  const n = (d && d.notification) || d || {};
  const caso = casoDe(n.navigate || n.url || '');
  const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  wins.forEach((w) => w.postMessage({ tipo: 'push', caso }));         // si la app está abierta, que consulte ya
  await self.registration.showNotification(String(n.title || 'Taller IA').slice(0, 120), {
    body: String(n.body || '').slice(0, 300), tag: String(n.tag || caso || 'taller-ia'), lang: 'es-ES', dir: 'ltr', renotify: true,
    icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', data: { caso },
  });
}
self.addEventListener('push', (e) => { hold(e, onPush(e.data)); });

// Al tocar el aviso se abre la app en ESE coche: si ya está abierta, se le pide que cambie; si no, se abre con ?caso=
async function onClick(notification) {
  notification.close();
  const caso = (notification.data && notification.data.caso) || '';
  const scope = self.registration.scope;
  const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const w = list.find((c) => c.url.startsWith(scope)) || list[0];
  if (w) {
    w.postMessage({ tipo: 'abrir', caso });
    try { await w.focus(); } catch (err) { /* sin permiso para enfocar */ }
    return;
  }
  await self.clients.openWindow(caso ? scope + '?caso=' + encodeURIComponent(caso) : scope);
}
self.addEventListener('notificationclick', (e) => { hold(e, onClick(e.notification)); });

// El navegador renovó la suscripción por su cuenta: se suscribe otra vez con la misma clave. A la cola se lo dice
// la app al abrirse (aquí no hay PIN): ve que el endpoint ha cambiado y lo manda.
self.addEventListener('pushsubscriptionchange', (e) => {
  const o = e.oldSubscription && e.oldSubscription.options;
  if (o && o.applicationServerKey) hold(e, self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: o.applicationServerKey }).catch(() => null));
});
