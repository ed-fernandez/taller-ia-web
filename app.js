// Taller IA · web. Misma función que la APK (voz, foto, vídeo, galería, texto, casos, progreso,
// respuesta hablada, documentos) contra la misma cola, para cualquier móvil, tableta u ordenador.

import { ls, idb, useDemoStore } from './store.js';
import { createBackend, PinError, NetError } from './backend.js';
import { VoiceRecorder, Camera, processImage, videoInfo, fixWebmDuration, canRecord, canCamera } from './media.js';
import { trocear } from './voz.js';

const VERSION = '1.4.0';
const CFG = window.TALLER_CONFIG || {};
const QS = new URLSearchParams(location.search);
const DEMO = !!CFG.demo || QS.has('demo');
if (DEMO) useDemoStore();

// Apps Script admite 50 MB por petición y 10 archivos por mensaje; la nota de voz siempre debe caber.
const LIMIT = { file: 30 * 1048576, total: 33 * 1048576, reserve: 1.5 * 1048576, files: 9, voiceS: 120, videoS: 45 };
const PIN_LEN = CFG.pinLength || 6;

// ------------------------------------------------------------------ utilidades
const $ = (id) => document.getElementById(id);
const SVGNS = 'http://www.w3.org/2000/svg';

function h(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  if (attrs) for (const k in attrs) {
    const v = attrs[k];
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'dataset') Object.assign(e.dataset, v);
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k.nodeType ? k : document.createTextNode(String(k)));
  return e;
}
function icon(name, cls) {
  const s = document.createElementNS(SVGNS, 'svg');
  s.setAttribute('class', cls || 'ic'); s.setAttribute('aria-hidden', 'true');
  const u = document.createElementNS(SVGNS, 'use');
  u.setAttribute('href', '#i-' + name); s.append(u);
  return s;
}
const setIcon = (btn, name) => { const u = btn.querySelector('use'); if (u) u.setAttribute('href', '#i-' + name); };
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
const pad2 = (n) => String(n).padStart(2, '0');
const stamp = (d = new Date()) => `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
const clock = (s) => { s = Math.max(0, Math.floor(s)); return `${Math.floor(s / 60)}:${pad2(s % 60)}`; };
const fmtDur = (s) => { s = Math.max(0, Math.round(s)); return s >= 60 ? `${Math.floor(s / 60)} min ${pad2(s % 60)} s` : `${s} s`; };
const about = (s) => (s >= 90 ? `${Math.round(s / 60)} min` : `${Math.max(10, Math.round(s / 10) * 10)} s`);
const mb = (n) => (n < 1048576 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1048576).toFixed(n < 10485760 ? 1 : 0).replace('.', ',')} MB`);
const hhmm = (ts) => { try { return new Date(ts).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' }); } catch { return ''; } };
const safeUrl = (u) => (/^https?:\/\//i.test(String(u || '')) ? String(u) : null);
const touch = () => matchMedia('(pointer: coarse)').matches;          // móvil o tableta: se maneja con el dedo
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const buzz = (p) => { try { if (navigator.vibrate) navigator.vibrate(p); } catch { /* sin vibración */ } };
const cleanName = (n) => String(n || 'adjunto').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(-80);
const EXT = { image: ['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif', 'gif'], video: ['mp4', 'mov', '3gp', 'mkv', 'webm', 'm4v'], audio: ['m4a', 'mp3', 'ogg', 'opus', 'wav', 'aac', 'amr'] };
function kindOf(name, mime) {
  mime = mime || '';
  for (const k of ['image', 'video', 'audio']) if (mime.startsWith(k + '/')) return k;
  const ext = (String(name).split('.').pop() || '').toLowerCase();
  if (/^nota-/.test(name) && ext === 'webm') return 'audio';
  for (const k in EXT) if (EXT[k].includes(ext)) return k;
  return 'file';
}

// ------------------------------------------------------------------ estado
const S = {
  queue: '', pin: '', cases: [], current: null, voice: true, notify: false, hidden: {}, resent: {},
  messages: [], outbox: [], tray: [], extraText: '', media: new Map(), watch: {}, flight: {}, mode: 'voice',
};
const fresh = new Set();
const api = createBackend({ demo: DEMO, url: () => S.queue, pin: () => S.pin });
const cur = () => S.cases.find((c) => c.id === S.current) || null;
const mkey = (caso, name) => caso + '|' + name;
const isAuto = (c) => /^Coche \d+$/.test(c.vehicle);
// Un coche «vacío» (nombre automático, sin consultas ni envíos pendientes) es un borrador: no se apunta en la lista
// salvo que sea el abierto, y desaparece al cambiar a otro. Así no se acumulan «Coche 1» vacíos.
const isEmpty = (c) => !!c && isAuto(c) && !c.remote && !(c.last && c.last.n) && !S.outbox.some((o) => o.caso === c.id);
const listed = () => S.cases.filter((c) => c.id === S.current || !isEmpty(c));
const saveCases = () => { ls.set('cases', listed()); ls.set('current', S.current); };
const actOf = (c) => Math.max(c.ts || 0, c.act || 0);                // última actividad: ordena la lista de coches
const wide = () => matchMedia('(min-width: 980px)').matches;         // escritorio: la lista de coches está siempre a la izquierda
// Sin vehículo todavía: el principio de la consulta sirve de nombre hasta que el diagnóstico lo identifique
const firstWords = (t) => { t = String(t || '').replace(/\s+/g, ' ').trim(); return t.length <= 40 ? t : t.slice(0, 40).replace(/[\s,.;:]+\S*$/, '') + '…'; };
const vehicleName = (v) => String(v || '').replace(/\s*\([^)]*\)/g, '').split(',')[0].replace(/\s+\d{2,3}\s?(CV|cv|kW|hp)\b/g, '').trim().slice(0, 60);

function queueUrlFrom(v) {
  v = String(v || '').trim();
  if (/^https:\/\/script\.google\.com\/macros\/s\/[\w-]{20,}\/exec$/.test(v)) return v;
  return /^[\w-]{20,}$/.test(v) ? `https://script.google.com/macros/s/${v}/exec` : '';
}
function parseInvite(text) {
  const s = String(text || '').trim();
  const frag = s.includes('#') ? s.slice(s.indexOf('#') + 1) : '';
  const p = new URLSearchParams(frag);
  const q = queueUrlFrom(p.get('q')) || queueUrlFrom(s);
  return q ? { q, pin: (p.get('pin') || '').replace(/\D/g, '').slice(0, 8) } : null;
}

// ------------------------------------------------------------------ avisos, hojas y visor
let toastT = null;
function toast(msg, opt) {
  opt = opt || {};
  const t = $('toast'), b = $('toastAct');
  $('toastMsg').textContent = msg;
  b.hidden = !opt.action;
  if (opt.action) { b.textContent = opt.action; b.onclick = () => { t.hidden = true; opt.onAction(); }; }
  t.hidden = true; void t.offsetWidth; t.hidden = false;
  clearTimeout(toastT);
  toastT = setTimeout(() => { t.hidden = true; }, opt.ms || (opt.action ? 9000 : 3800));
}

// Aviso fijo bajo la cabecera: otro coche ya tiene diagnóstico. No se va solo: se quita al verlo o al cerrarlo.
let newsFor = null;
function showNews(c, n) {
  newsFor = c.id;
  $('newsMsg').textContent = n > 1 ? `${n} diagnósticos nuevos` : `Diagnóstico listo: ${c.vehicle}`;
  $('news').hidden = false;
  renderHeader();
}
function hideNews(id) { if (id && newsFor !== id) return; newsFor = null; $('news').hidden = true; renderHeader(); }

// Las capas (hoja, cámara, visor) entran en el historial: el gesto «atrás» las cierra en vez de salir.
const overlays = [];
let backing = false;
function pushOverlay(close) { overlays.push(close); try { history.pushState({ ov: overlays.length }, ''); } catch { /* sin historial */ } }
function closeTop() { backing = false; const c = overlays.pop(); if (c) c(); }
function popOverlay() {
  if (!overlays.length || backing) return;
  backing = true;
  try { history.back(); } catch { closeTop(); return; }
  setTimeout(() => { if (backing) closeTop(); }, 500);
}
window.addEventListener('popstate', closeTop);

let sheetClosed = null;
function openSheet(node, onClose) {
  $('sheetBody').replaceChildren(node);
  if ($('sheetWrap').hidden) {
    $('sheetWrap').hidden = false;
    pushOverlay(() => { $('sheetWrap').hidden = true; $('sheetBody').replaceChildren(); const f = sheetClosed; sheetClosed = null; if (f) f(); });
  }
  sheetClosed = onClose || null;
  $('sheet').scrollTop = 0;
  $('sheet').focus({ preventScroll: true });
}
const closeSheet = () => { if (!$('sheetWrap').hidden) popOverlay(); };

function openLightbox(src) {
  $('lightboxImg').src = src;
  $('lightbox').hidden = false;
  pushOverlay(() => { $('lightbox').hidden = true; $('lightboxImg').removeAttribute('src'); });
}

// ------------------------------------------------------------------ voz, sonido y avisos del sistema
const tts = {
  ok: 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window,
  cur: null, unlocked: false,
  unlock() {
    if (!this.ok || this.unlocked) return;
    try { const u = new SpeechSynthesisUtterance(' '); u.volume = 0; speechSynthesis.speak(u); this.unlocked = true; } catch { /* nada */ }
  },
  voice() {
    const vs = speechSynthesis.getVoices() || [];
    return vs.find((v) => /^es[-_]ES/i.test(v.lang) && v.localService) || vs.find((v) => /^es[-_]ES/i.test(v.lang)) || vs.find((v) => /^es/i.test(v.lang)) || null;
  },
  speak(id, text) {
    if (!this.ok || !text) return;
    this.stop();
    const v = this.voice();
    const parts = trocear(text);                                    // frases sueltas: Chrome corta las locuciones largas
    if (!parts.length) return;
    let left = parts.length;
    this.cur = id;
    parts.forEach((p) => {
      const u = new SpeechSynthesisUtterance(p);
      u.lang = v ? v.lang : 'es-ES';
      if (v) u.voice = v;
      u.onend = u.onerror = () => { if (--left <= 0 && this.cur === id) { this.cur = null; syncListen(); } };
      speechSynthesis.speak(u);
    });
    syncListen();
  },
  stop() {
    if (!this.ok) return;
    try { speechSynthesis.cancel(); } catch { /* nada */ }
    this.cur = null; syncListen();
  },
};
function syncListen() {
  document.querySelectorAll('.listen').forEach((b) => {
    const on = b.dataset.id === tts.cur;
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
    setIcon(b, on ? 'stop' : 'vol');
    b.lastChild.textContent = on ? 'Parar' : b.dataset.label || 'Escuchar';
  });
}

// Lo que se dice en voz alta de una respuesta
function sayOf(r) {
  if (!r) return '';
  if (r._error) return 'No he podido terminar este diagnóstico. Ed ya está avisado. Si quieres, pulsa Volver a enviar.';
  return [r.respuesta_voz, r.seguridad ? 'Atención: ' + r.seguridad : ''].filter(Boolean).join('. ');
}
// Mientras se graba voz o vídeo no suena nada: la voz del asistente acabaría dentro de la grabación (y whisper la
// transcribiría como si fuera Manolo). Lo que llegue entretanto se queda pendiente y se lee al terminar.
const capturing = () => recState !== 'idle' || camRecState !== 'idle' || camera.recording;
let speakLater = null;
function sayNow(id, say) { chime(); setTimeout(() => { if (!capturing()) tts.speak(id, say); else speakLater = { id, say }; }, 500); }
function speakOrDefer(id, say) {
  if (!S.voice || !say) return;
  if (document.hidden || capturing()) { speakLater = { id, say }; refreshHint(); camNote(); return; }
  sayNow(id, say);
}
function flushSpeak() {
  if (!speakLater || document.hidden || capturing()) return;
  const s = speakLater; speakLater = null;
  if (S.voice) sayNow(s.id, s.say);
  refreshHint(); camNote();
}

let actx = null;
function audioCtx() {
  try { actx = actx || new (window.AudioContext || window.webkitAudioContext)(); if (actx.state === 'suspended') actx.resume(); } catch { /* sin audio */ }
  return actx;
}
// Campanilla de tres notas, para que se oiga en un taller con ruido (y nunca encima de una grabación)
function chime() {
  if (capturing()) return;
  const a = audioCtx();
  if (!a || a.state !== 'running') return;
  const t = a.currentTime;
  [[880, 0], [1320, 0.16], [1760, 0.32]].forEach(([f, d]) => {
    const o = a.createOscillator(), g = a.createGain();
    o.type = 'triangle'; o.frequency.value = f;
    g.gain.setValueAtTime(0.0001, t + d);
    g.gain.exponentialRampToValueAtTime(0.5, t + d + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + d + 0.5);
    o.connect(g); g.connect(a.destination);
    o.start(t + d); o.stop(t + d + 0.55);
  });
}
async function notify(c, r) {
  if (!S.notify || !('Notification' in window) || Notification.permission !== 'granted') return;
  const title = 'Diagnóstico listo: ' + c.vehicle;
  const opt = { body: r.hipotesis_principal || r.respuesta_voz || '', tag: c.id, icon: 'icons/icon-192.png' };
  try {
    const reg = navigator.serviceWorker && await navigator.serviceWorker.getRegistration();
    if (reg && reg.showNotification) await reg.showNotification(title, opt); else new Notification(title, opt);
  } catch { /* sin avisos */ }
}
// La pantalla se queda encendida mientras se espera un diagnóstico, pero no sin fin: tras 15 min sin ningún
// avance (el ordenador del taller no contesta) se suelta y se sigue consultando cada 30 s.
const WAKE_MAX = 15 * 60000;
let wake = null, lastMove = Date.now();
async function keepAwake() {
  if (wake || !('wakeLock' in navigator) || document.hidden) return;
  try { wake = await navigator.wakeLock.request('screen'); wake.addEventListener('release', () => { wake = null; }); } catch { /* no disponible */ }
}
function releaseWake() { try { if (wake) wake.release(); } catch { /* nada */ } wake = null; }

// ------------------------------------------------------------------ coches (casos)
function newCase(name) {
  const c0 = cur();
  if (!name && c0 && isAuto(c0) && !(c0.last && c0.last.n) && !S.outbox.some((o) => o.caso === c0.id)) {
    // El coche abierto aún está vacío: se reutiliza, pero se nota (en escritorio se abre su nombre para escribirlo)
    if (started) { if (wide()) { editCar(c0); renderCars(); } toast(wide() ? 'Este coche aún está vacío: escribe su nombre o cuéntame la avería.' : 'Este coche está por estrenar. Cuéntame la avería.'); }
    return c0;
  }
  const n = S.cases.filter(isAuto).reduce((a, x) => Math.max(a, parseInt(x.vehicle.slice(6), 10) || 0), 0);
  const c = { id: `APP-${stamp()}-${Math.random().toString(36).slice(2, 4)}`, vehicle: name || `Coche ${n + 1}`, ts: Date.now(), seen: Date.now() };
  S.cases.push(c); S.current = c.id; S.messages = []; sig = '';
  saveCases();
  if (started) { if (wide() && !name) editCar(c); renderAll(true); schedule(); }
  return c;
}
// `leer`: al abrir un coche desde el aviso «Diagnóstico listo», se lee su última respuesta sin más toques
async function selectCase(id, leer) {
  hideNews(id);
  if (id === S.current) { if (leer) readLast(); return; }
  S.current = id;
  S.cases = listed();                                               // el borrador que se deja atrás desaparece
  const c = cur();
  if (c) { c.news = false; c.seen = Date.now(); if (!isEmpty(c)) { pushMark(id); pushRefresh(); } }
  if (editing && editing !== id) editing = null;
  saveCases();
  tts.stop();
  await loadCase();
  renderAll(true);
  await refresh();
  schedule();
  if (leer && id === S.current) readLast();
}
const lastAnswer = () => { const m = S.messages.slice().reverse().find((x) => x.respuesta); return m || null; };
function readLast() {
  const m = lastAnswer();
  if (!m || capturing()) return;
  tts.unlock(); stopNote();
  tts.speak(m.id, sayOf(m.respuesta));
}
async function loadCase() {
  const id = S.current;
  S.messages = []; sig = '';
  const [media, cached] = await Promise.all([idb.all('media').catch(() => []), idb.get('cases', id).catch(() => null)]);
  if (id !== S.current) return;
  S.media = new Map(media.map((m) => [m.key, m]));
  if (cached && cached.messages) { cached.messages.forEach((m) => { if (m.progreso) delete m.progreso._seen; }); S.messages = cached.messages; }
}
// Quitar un coche lo oculta solo en este dispositivo: la cola lo sigue teniendo y vuelve si hay mensajes nuevos
// Con «Deshacer» durante unos segundos, en vez de pedir confirmación.
function removeCase(c) {
  const at = S.cases.indexOf(c), wasCur = S.current === c.id, flight = S.flight[c.id];
  S.cases = S.cases.filter((x) => x !== c);
  S.hidden[c.id] = Math.max(Date.now(), actOf(c)); ls.set('hidden', S.hidden);
  delete S.flight[c.id]; ls.set('flight', S.flight);
  editing = null;
  if (newsFor === c.id) hideNews();
  if (wasCur) {
    S.current = null; saveCases();
    const next = S.cases.slice().sort((a, b) => actOf(b) - actOf(a))[0];
    if (next) selectCase(next.id); else { newCase(); }
  } else { saveCases(); renderCars(); renderHeader(); }
  toast(`${c.vehicle}: oculto en este dispositivo`, { action: 'Deshacer', onAction: () => {
    delete S.hidden[c.id]; ls.set('hidden', S.hidden);
    if (flight) { S.flight[c.id] = flight; ls.set('flight', S.flight); }
    if (!S.cases.includes(c)) S.cases.splice(Math.min(at, S.cases.length), 0, c);
    saveCases();
    if (wasCur) selectCase(c.id); else { renderCars(); renderHeader(); }
  } });
}
function noteCase(c, list) {
  const last = list[list.length - 1];
  const r = last && last.respuesta;
  c.last = last ? { busy: list.some((m) => !m.respuesta), err: !!(r && r._error), n: list.length, text: String(r ? (r._error ? 'No se ha podido completar' : r.hipotesis_principal || r.respuesta_voz || '') : last.texto || '').slice(0, 90) } : null;
  list.forEach((m) => { if (m.respuesta && m.respuesta.vehiculo && (isAuto(c) || (c.remote && !c.named))) c.vehicle = vehicleName(m.respuesta.vehiculo) || c.vehicle; });
  if (last) c.act = Math.max(c.act || 0, Date.parse(last.ts) || 0);
}

// Nombre del coche. El formulario sobrevive a los repintados (la lista se repinta sola al llegar respuestas)
// sin robar el foco: solo se enfoca al abrirlo. Al salir de él se guarda lo escrito.
let editing = null, editFresh = false, editDraft = null, carsOpen = false, pointerDown = false;
document.addEventListener('pointerdown', () => { pointerDown = true; }, true);
document.addEventListener('pointerup', () => { pointerDown = false; }, true);
function editCar(c) { editing = c.id; editFresh = true; editDraft = null; }
function carForm(c, inSheet) {
  const initial = c.vehicle;
  const input = h('input', { type: 'text', value: editDraft != null ? editDraft : c.vehicle, maxlength: '80', 'aria-label': 'Nombre del coche', placeholder: 'Marca y modelo', enterkeyhint: 'done', autocomplete: 'off' });
  let done = false;
  const commit = (keep) => {
    if (done) return; done = true;
    const v = input.value.trim().slice(0, 80);
    if (keep && v && v !== initial) { c.vehicle = v; c.named = true; }
    editing = null; editDraft = null; saveCases(); renderHeader();
  };
  // Repintar justo al soltar el ratón haría perder el clic que ha quitado el foco: se espera a que termine
  const repaint = () => { const go = () => setTimeout(() => { if (editing === null) renderCars(); }, 0); if (pointerDown) document.addEventListener('pointerup', go, { once: true, capture: true }); else go(); };
  input.addEventListener('input', () => { editDraft = input.value; });
  input.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); commit(false); renderCars(); } });
  const rm = !isEmpty(c) ? h('button', { class: 'rm', type: 'button', onclick: () => { done = true; removeCase(c); } }, 'Ocultar en este dispositivo') : null;
  const form = h('form', { class: 'car-form', onsubmit: (e) => {
    e.preventDefault(); commit(true); renderCars();
    if (!inSheet && S.mode === 'text') $('txt').focus();          // nombre y, a continuación, la avería
  } }, input, h('button', { class: 'btn btn-ink', type: 'submit' }, 'Guardar'), rm);
  form.addEventListener('focusout', (e) => { if (!rebuilding && !form.contains(e.relatedTarget) && document.hasFocus()) { commit(true); repaint(); } });
  return form;
}
function carsList(inSheet) {
  const box = h('div', null);
  box.append(h('button', { class: 'btn btn-go cars-new', type: 'button', onclick: () => { newCase(); if (inSheet) closeSheet(); else renderCars(); } }, icon('plus'), 'Coche nuevo'));
  listed().sort((a, b) => actOf(b) - actOf(a)).forEach((c) => {
    if (editing === c.id) { box.append(carForm(c, inSheet)); return; }
    const l = c.last || {}, news = c.news && c.id !== S.current;
    box.append(h('div', { class: 'car' + (news ? ' news' : l.busy ? ' busy' : l.err ? ' err' : l.n ? ' done' : ''), 'aria-current': c.id === S.current ? 'true' : null, dataset: { id: c.id } },
      h('button', { class: 'car-go', type: 'button', onclick: () => { selectCase(c.id, news); if (inSheet) closeSheet(); } },
        h('span', { class: 'dot' }), h('span', { class: 'car-txt' }, h('b', null, c.vehicle),
          h('small', null, c.src === 'correo' ? h('span', { class: 'car-src' }, 'Correo') : null, news ? 'Diagnóstico nuevo' : l.busy ? 'Diagnóstico en marcha' : l.text || 'Sin consultas todavía'))),
      h('button', { class: 'car-edit', type: 'button', 'aria-label': 'Cambiar el nombre de ' + c.vehicle, onclick: () => { editCar(c); renderCars(); } }, icon('pen')),
      // Ocultar a la vista, con texto: con solo un icono nadie lo encontraba (se puede deshacer)
      isEmpty(c) ? null : h('button', { class: 'car-hide', type: 'button', 'aria-label': 'Ocultar ' + c.vehicle + ' en este dispositivo', onclick: () => removeCase(c) }, 'Ocultar')));
  });
  return box;
}
let rebuilding = false;
function renderCars() {
  // Si se estaba escribiendo el nombre, el formulario nuevo recupera el foco y el cursor
  const a = document.activeElement, typing = a && a.tagName === 'INPUT' && a.closest('.car-form') ? [a.closest('#railCars') ? 'railCars' : 'sheetBody', a.selectionStart, a.selectionEnd] : null;
  rebuilding = true;
  try {
    $('railCars').replaceChildren(h('h1', null, 'Taller IA'), carsList(false));
    if (carsOpen) $('sheetBody').replaceChildren(h('div', null, h('h2', null, 'Coches'), carsList(true)));
  } finally { rebuilding = false; }
  if (typing) { const i = $(typing[0]).querySelector('.car-form input'); if (i) { i.focus({ preventScroll: true }); try { i.setSelectionRange(typing[1], typing[2]); } catch { /* nada */ } } }
  if (editFresh) {
    editFresh = false;
    setTimeout(() => { const i = [...document.querySelectorAll('.car-form input')].find((x) => x.offsetParent !== null); if (i) { i.focus(); i.select(); } }, 40);
  }
}
function openCars() {
  carsOpen = true; editing = null;
  syncCases();
  openSheet(h('div', null, h('h2', null, 'Coches'), carsList(true)), () => { carsOpen = false; editing = null; });
}
function renderHeader() {
  const c = cur();
  if (!c) return;
  const other = S.cases.find((x) => x.news && x.id !== c.id);
  const l = c.last;
  $('carName').textContent = c.vehicle;
  $('carSub').textContent = other && $('news').hidden ? `Diagnóstico listo: ${other.vehicle}` : l && l.busy ? 'Diagnóstico en marcha' : l && l.n ? (l.n === 1 ? '1 consulta' : `${l.n} consultas`) : 'Sin consultas todavía';
  $('carBtn').classList.toggle('has-news', !!other);
}

// ------------------------------------------------------------------ conversación
const DTC = /\b([PBCU][0-3][0-9A-F]{3})\b/g;
function rich(text) {
  const f = document.createDocumentFragment();
  String(text || '').split(DTC).forEach((p, i) => { if (p) f.append(i % 2 ? h('span', { class: 'dtc' }, p) : p); });
  return f;
}
function lead(text) {
  const s = String(text || ''), i = s.indexOf(':');
  return i > 7 && i < 90 ? h('div', null, h('b', null, rich(s.slice(0, i + 1))), rich(s.slice(i + 1))) : h('div', null, rich(s));
}
function fakePeaks(seed) {
  let x = 7;
  for (const ch of String(seed)) x = (x * 31 + ch.charCodeAt(0)) % 9973;
  return Array.from({ length: 30 }, () => { x = (x * 137 + 11) % 9973; return 0.2 + (x % 60) / 100; });
}

let playing = null;
function stopNote() { if (!playing) return; try { playing.audio.pause(); } catch { /* nada */ } setIcon(playing.btn, 'play'); playing = null; }
function playNote(f, btn) {
  const same = playing && playing.btn === btn;
  stopNote();
  if (same) return;
  tts.stop();
  const audio = new Audio(URL.createObjectURL(f.blob));
  audio.onended = audio.onerror = () => { if (playing && playing.audio === audio) stopNote(); };
  audio.play().catch(() => stopNote());
  setIcon(btn, 'pause');
  playing = { audio, btn };
}
function voiceNote(f) {
  const peaks = f.peaks && f.peaks.length ? f.peaks : fakePeaks(f.name);
  const btn = h('button', { class: 'vn-play', type: 'button', 'aria-label': 'Oír la nota de voz', disabled: !f.blob }, icon('play'));
  if (f.blob) btn.addEventListener('click', () => playNote(f, btn));
  return h('div', { class: 'vn' }, btn,
    h('div', { class: 'bars', 'aria-hidden': 'true' }, peaks.map((p) => h('i', { style: `height:${Math.round(4 + Math.min(1, p) * 24)}px` }))),
    h('time', null, f.dur ? clock(f.dur) : 'Voz'));
}
const resolveFiles = (caso, names) => (names || []).map((n) => S.media.get(mkey(caso, n)) || { name: n, kind: kindOf(n) });

function bubble(texto, files, cls, meta) {
  const el = h('div', { class: 'me' + (cls ? ' ' + cls : '') });
  const seen = (f) => (f.kind === 'image' || f.kind === 'video') && f.preview;
  const pics = files.filter(seen), notes = files.filter((f) => f.kind === 'audio'), rest = files.filter((f) => f.kind !== 'audio' && !seen(f));
  if (pics.length) el.append(h('div', { class: 'pics' + (pics.length === 1 ? ' one' : '') }, pics.map((f) =>
    h('button', { class: 'pic', type: 'button', 'aria-label': f.kind === 'video' ? 'Ver la carátula del vídeo' : 'Ver la foto', onclick: () => openLightbox(f.preview) },
      h('img', { src: f.preview, alt: '' }), f.kind === 'video' ? h('span', { class: 'badge' }, icon('video'), f.dur ? clock(f.dur) : 'Vídeo') : null))));
  notes.forEach((f) => el.append(voiceNote(f)));
  if (rest.length) el.append(h('div', null, rest.map((f) => h('span', { class: 'fchip' }, icon(f.kind === 'video' ? 'video' : f.kind === 'image' ? 'image' : 'file'), h('span', null, f.name)))));
  if (texto) el.append(h('div', { class: 'me-text' }, texto));
  else if (!files.length) el.append(h('div', { class: 'me-text' }, '(mensaje)'));
  if (meta) el.append(meta);
  return el;
}
// Por qué no ha salido un envío, en palabras del taller (lo que contesta la cola, traducido si se conoce)
function motivo(o) {
  const e = String(o.error || ''), video = o.files.some((f) => f.kind === 'video');
  if (/poca cobertura/.test(e)) return video ? 'Muy poca cobertura para este vídeo. Acércate al wifi o envíalo sin el vídeo.' : 'Muy poca cobertura para enviarlo. Acércate al wifi y pulsa Reintentar.';
  if (/demasiado grande|too large|exceed|maximum|límite|limit/i.test(e)) return video ? 'Pesa demasiado: quita el vídeo o grábalo más corto.' : 'Pesa demasiado: quita alguna foto.';
  if (!e) return 'No se ha enviado.';
  return `No se ha enviado. La cola ha contestado: «${e.slice(0, 80)}».`;
}
function chip(kind, text) { return h('span', { class: 'st st-' + kind }, text); }
function outboxBubble(o) {
  const size = o.files.reduce((a, f) => a + f.size, 0);
  let meta;
  if (o.status === 'failed') {
    meta = h('div', { class: 'me-meta me-fail' }, chip('bad', 'No enviado'), h('p', { class: 'me-why' }, motivo(o)),
      h('div', { class: 'me-acts' },
        h('button', { type: 'button', onclick: () => { o.status = 'queued'; o.slow = 0; renderChat(); pump(); } }, 'Reintentar'),
        o.files.some((f) => f.kind === 'video') ? h('button', { type: 'button', onclick: () => { o.files = o.files.filter((f) => f.kind !== 'video'); o.status = 'queued'; o.slow = 0; o.error = ''; idb.put('outbox', o).catch(() => {}); renderChat(); pump(); } }, 'Enviar sin el vídeo') : null,
        h('button', { type: 'button', onclick: () => { S.outbox = S.outbox.filter((x) => x !== o); idb.del('outbox', o.lid).catch(() => {}); renderChat(); refreshHint(); } }, 'Borrar')));
  } else if (o.status === 'sent') meta = h('div', { class: 'me-meta' }, chip('ok', 'Enviado'));
  else if (o.status === 'waiting') meta = h('div', { class: 'me-meta' }, chip('wait', 'En espera'), 'Sin conexión. Saldrá solo.');
  else meta = h('div', { class: 'me-meta' }, h('span', { class: 'spin' }), size > 300000 ? `Enviando ${mb(size)}…` + (o.sendAt && Date.now() - o.sendAt > 15000 ? ` (${fmtDur((Date.now() - o.sendAt) / 1000)})` : '') : 'Enviando…');
  return bubble(o.texto, o.files, o.status === 'failed' ? 'failed' : 'local', meta);
}

function emptyState() {
  const box = h('div', { class: 'empty' },
    h('h2', null, '¿Qué le pasa al coche?'),
    h('p', null, 'Cuéntamelo como a un compañero: qué hace, desde cuándo y qué códigos salen.'),
    h('ul', null,
      h('li', null, h('span', null, icon('mic')), 'Pulsa el botón amarillo y habla'),
      h('li', null, h('span', null, icon('camera')), 'Manda fotos de la placa, el cuadro o la pieza'),
      h('li', null, h('span', null, icon('video')), 'Graba el ruido en vídeo')));
  if (canInstall() && !ls.get('noinstall', false)) box.append(h('button', { class: 'install', type: 'button', onclick: install }, icon('phone'), h('span', null, 'Instalar en este dispositivo', h('small', null, 'Se abre con un toque, a pantalla completa'))));
  return box;
}

// --- el taller IA trabajando
const PHASES = ['Recibido', 'Manuales', 'Foros', 'Diagnóstico'];
const phaseMax = new Map();
function phaseOf(stage) {
  const s = stage.toLowerCase();
  if (/redactando|subiendo la documentaci/.test(s)) return 3;
  if (/foro/.test(s)) return 2;
  if (/manual|documentaci|biblioteca|leyendo|consultando|investigando/.test(s)) return 1;
  return 0;
}
function gaugeSvg() {
  const t = document.createElement('template');
  t.innerHTML = '<svg viewBox="0 0 100 100" aria-hidden="true"><circle class="g-track" cx="50" cy="50" r="42" pathLength="100"/><circle class="g-val" cx="50" cy="50" r="42" pathLength="100"/></svg>';
  return t.content.firstChild;
}
function jobCard(m) {
  const el = h('div', { class: 'job', dataset: { id: m.id } },
    h('div', { class: 'gauge' }, gaugeSvg(), h('b', null, '')),
    h('p', { class: 'job-stage' }), h('p', { class: 'job-time' }),
    h('ol', { class: 'phases' }, PHASES.map((p) => h('li', null, p))),
    h('p', { class: 'job-note', hidden: true }, h('span', null, 'Está tardando más de lo normal. Puede que el ordenador del taller IA esté apagado.'),
      safeUrl(CFG.avisarEd) || /^mailto:/.test(CFG.avisarEd || '') ? h('a', { class: 'btn btn-go job-ed', href: CFG.avisarEd, target: '_blank', rel: 'noopener' }, 'Avisar a Ed') : ' Avisa a Ed.'));
  if (!ls.get('push', false) && !ls.get('nobell', false) && (pushOk() || isIOS) && !(('Notification' in window) && Notification.permission === 'denied')) {
    el.append(h('button', { class: 'job-bell', type: 'button', onclick: () => { ls.set('nobell', true); pushOn(); } }, icon('bell'), 'Avísame aunque cierre la app'));
  } else if (!pushOk() && 'Notification' in window && Notification.permission === 'default' && !ls.get('nobell', false)) {
    el.append(h('button', { class: 'job-bell', type: 'button', onclick: askNotify }, icon('bell'), 'Avísame cuando esté listo'));
  }
  updateJob(el, m);
  return el;
}
function updateJob(el, m) {
  const pg = m.progreso, now = Date.now();
  let pct, stage, rest, sofar;
  if (pg && m.estado === 'procesando') {
    const age = (now - (pg._seen || (pg._seen = now))) / 1000, p0 = pg.pct || 5;
    sofar = (pg.transcurrido_s || 0) + age; rest = (pg.eta_s || 120) - age;
    pct = Math.min(97, Math.max(p0, p0 + (100 - p0) * Math.min(0.9, age / Math.max(30, pg.eta_s || 120))));
    stage = pg.etapa || 'Analizando';
  } else {
    sofar = Math.max(0, (now - new Date(m.ts).getTime()) / 1000); rest = Math.max(20, 60 - sofar) + 200;
    pct = Math.min(8, 2 + sofar / 10);
    stage = sofar < 45 ? 'En cola: avisando al taller IA' : sofar < 180 ? 'Despertando el ordenador del taller IA' : 'El ordenador del taller no contesta todavía';
  }
  // Sin noticias del taller pasados 3 min, no se inventa una cuenta atrás: se dice lo que pasa
  const quiet = !(pg && m.estado === 'procesando') && sofar >= 180;
  const ph = Math.max(phaseMax.get(m.id) || 0, phaseOf(stage));
  phaseMax.set(m.id, ph);
  el.classList.toggle('quiet', quiet);
  el.querySelector('.gauge').style.setProperty('--pct', pct.toFixed(1));
  el.querySelector('.gauge b').textContent = Math.round(pct) + '%';
  el.querySelector('.job-stage').textContent = stage;
  el.querySelector('.job-time').textContent = quiet ? `En cola desde hace ${fmtDur(sofar)}. Empezará en cuanto se encienda.` : `Lleva ${fmtDur(sofar)}` + (rest > 5 ? `, quedan unos ${about(rest)}` : ', casi listo');
  el.querySelectorAll('.phases li').forEach((li, i) => { li.className = i < ph ? 'on' : i === ph ? 'on now' : ''; });
  el.querySelector('.job-note').hidden = sofar < 600;
}
async function askNotify() {
  let p = 'denied';
  try { p = await Notification.requestPermission(); } catch { /* nada */ }
  ls.set('nobell', true);
  if (p === 'granted') { S.notify = true; ls.set('notify', true); toast('Hecho. Te aviso cuando esté el diagnóstico.'); }
  renderChat();
}

// --- el parte de diagnóstico
const CONF = { baja: 1, media: 2, alta: 3 };
// Fallo terminal de la cola (`_error`): no es un diagnóstico. Se dice claro y, si lo enviado sigue en este
// dispositivo (el texto y la nota de voz se guardan; las fotos y vídeos no), se puede volver a mandar.
function resendable(m) {
  const files = resolveFiles(S.current, m.files), keep = files.filter((f) => f.kind === 'audio' && f.blob);
  return { files: keep, lost: files.length - keep.length, ok: !!(m.texto || keep.length) };
}
function resend(m) {
  const c = cur(), r = resendable(m);
  if (!c || !r.ok) return;
  S.resent[m.id] = 1; ls.set('resent', S.resent);
  const files = r.files.map((f) => ({ id: uid(), kind: 'audio', name: f.name, mime: f.blob.type || mimeOf(f.name), size: f.blob.size, blob: f.blob, dur: f.dur, peaks: f.peaks }));
  const o = { lid: uid(), caso: c.id, vehiculo: isAuto(c) ? '' : c.vehicle, texto: m.texto || '', files, ts: Date.now(), status: 'queued', tries: 0 };
  c.act = o.ts; saveCases();
  S.outbox.push(o); idb.put('outbox', o).catch(() => {});
  renderChat(true); pump();
}
function errorCard(m, isFresh) {
  const r = resendable(m), done = !!S.resent[m.id];
  const el = h('article', { class: 'parte err' + (isFresh ? ' fresh' : ''), dataset: { id: m.id } },
    h('div', { class: 'parte-head' }, h('span', { class: 'parte-kind' }, icon('warn'), 'Sin diagnóstico'), h('span', { class: 'parte-no' }, 'N.º ' + m.id)),
    h('h2', null, 'No se ha podido completar el diagnóstico'),
    h('p', { class: 'say' }, 'El taller IA lo ha intentado varias veces sin terminar. Ed ya está avisado.'));
  if (r.ok) {
    el.append(h('div', { class: 'parte-bar' }, h('button', { class: 'btn btn-go', type: 'button', disabled: done, onclick: () => resend(m) }, icon('retry'), done ? 'Vuelto a enviar' : 'Volver a enviar')));
    if (r.lost) el.append(h('p', { class: 'err-note' }, r.lost === 1 ? 'La foto o el vídeo no se guardan en el móvil: si hace falta, vuelve a hacerlo.' : 'Las fotos y los vídeos no se guardan en el móvil: si hacen falta, vuelve a hacerlos.'));
  } else el.append(h('p', { class: 'err-note' }, 'Lo que mandaste ya no está en este dispositivo: cuéntamelo otra vez con el botón amarillo.'));
  return el;
}
function parte(m, isFresh) {
  const r = m.respuesta || {};
  if (r._error) return errorCard(m, isFresh);
  const el = h('article', { class: 'parte' + (isFresh ? ' fresh' : ''), dataset: { id: m.id } });
  el.append(h('div', { class: 'parte-head' }, h('span', { class: 'parte-kind' }, 'Diagnóstico'), h('span', { class: 'parte-no' }, 'N.º ' + m.id)));
  if (r.hipotesis_principal) el.append(h('h2', { class: String(r.hipotesis_principal).length > 110 ? 'long' : null }, rich(r.hipotesis_principal)));
  const bar = h('div', { class: 'parte-bar' });
  const lvl = CONF[String(r.confianza || '').toLowerCase()];
  if (lvl) bar.append(h('span', { class: 'conf' }, [1, 2, 3].map((i) => h('i', { class: i <= lvl ? 'on' : null })), h('span', null, 'Confianza ' + String(r.confianza).toLowerCase())));
  const say = sayOf(r);
  if (tts.ok && say) bar.append(h('button', { class: 'listen', type: 'button', 'aria-pressed': 'false', dataset: { id: m.id }, onclick: () => { tts.unlock(); stopNote(); if (tts.cur === m.id) tts.stop(); else tts.speak(m.id, say); } }, icon('vol'), h('span', null, 'Escuchar')));
  if (bar.childNodes.length) el.append(bar);
  if (r.respuesta_voz) el.append(h('p', { class: 'say' }, rich(r.respuesta_voz)));
  if (r.seguridad) el.append(h('p', { class: 'safety' }, rich(r.seguridad)));
  if (r.pruebas && r.pruebas.length) el.append(h('section', { class: 'sec' }, h('h3', null, 'Siguientes comprobaciones'), h('ol', { class: 'checks' }, r.pruebas.map((p) => h('li', null, lead(p))))));
  const docs = (r.documentos || []).filter((x) => x && x.drive_id);
  if (docs.length) el.append(h('section', { class: 'sec' }, h('h3', null, 'Documentación técnica'), docs.map((x) => {
    const ext = (String(x.archivo || '').split('.').pop() || 'pdf').slice(0, 4).toUpperCase();
    const sub = [x.tipo, x.mb ? String(x.mb).replace('.', ',') + ' MB' : ''].filter(Boolean).join(', ');
    return h('button', { class: 'doc', type: 'button', onclick: () => openDoc(x) }, h('span', { class: 'doc-tag' }, ext),
      h('span', null, h('b', null, x.titulo || x.archivo), sub ? h('small', null, sub) : null, x.por_que ? h('small', { class: 'why' }, x.por_que) : null));
  })));
  if (r.casos_foros && r.casos_foros.length) el.append(h('section', { class: 'sec' }, h('h3', null, 'Casos resueltos en foros'), r.casos_foros.map((x) => {
    const u = safeUrl(x.url);
    return h('div', { class: 'foro' }, h('p', null, x.resumen), u ? h('a', { href: u, target: '_blank', rel: 'noopener noreferrer' }, 'Ver el hilo', icon('ext')) : null);
  })));
  const foot = h('div', { class: 'parte-foot' });
  if (r.respuesta_html) foot.append(h('button', { class: 'link-btn', type: 'button', onclick: () => openReport(r) }, icon('file'), 'Informe completo'));
  const src = (r.fuentes || []).filter((f) => f && safeUrl(f.url));
  if (src.length) foot.append(h('button', { class: 'link-btn', type: 'button', onclick: () => openSources(src) }, `Fuentes (${src.length})`));
  if (r._segundos) foot.append(h('small', null, 'Resuelto en ' + fmtDur(r._segundos)));
  if (foot.childNodes.length) el.append(foot);
  return el;
}

let sig = '';
function renderChat(toBottom) {
  const c = cur(), chat = $('chat');
  if (!c) return;
  const near = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 160;
  stopNote();
  const local = S.outbox.filter((o) => o.caso === c.id && !(o.serverId && S.messages.some((m) => m.id === o.serverId)));
  const kids = [];
  let first = null;
  if (!S.messages.length && !local.length) kids.push(emptyState());
  S.messages.forEach((m) => {
    kids.push(bubble(m.texto, resolveFiles(c.id, m.files), '', h('div', { class: 'me-meta' }, hhmm(m.ts))));
    if (m.respuesta) { const p = parte(m, fresh.has(m.id)); if (fresh.has(m.id) && !first) first = p; kids.push(p); }
    else kids.push(jobCard(m));
  });
  local.forEach((o) => kids.push(outboxBubble(o)));
  chat.replaceChildren(...kids);
  fresh.clear();
  syncListen();
  if (first) chat.scrollTo({ top: Math.max(0, first.offsetTop - 12), behavior: reduced() ? 'auto' : 'smooth' });   // el parte nuevo se lee desde arriba
  else if (toBottom || near) chat.scrollTop = chat.scrollHeight;
}
setInterval(() => {
  document.querySelectorAll('.job').forEach((el) => { const m = S.messages.find((x) => x.id === el.dataset.id); if (m && !m.respuesta) updateJob(el, m); });
}, 1000);

// ------------------------------------------------------------------ bandeja de adjuntos
let busyAdds = 0;
const trayBytes = () => S.tray.reduce((a, f) => a + f.size, 0);
function renderTray() {
  const show = S.tray.length > 0 || !!S.extraText || busyAdds > 0;
  $('tray').hidden = !show;
  $('dock').classList.toggle('has-tray', show);
  const kids = S.tray.map((f) => h('div', { class: 'chip' },
    f.preview ? h('img', { src: f.preview, alt: '' }) : icon(f.kind === 'audio' ? 'mic' : f.kind === 'video' ? 'video' : 'image'),
    f.dur ? h('span', { class: 'dur' }, clock(f.dur)) : null,
    h('button', { class: 'rm', type: 'button', 'aria-label': 'Quitar ' + (f.kind === 'image' ? 'la foto' : f.kind === 'video' ? 'el vídeo' : 'el audio'), onclick: () => untray(f) }, icon('x'))));
  for (let i = 0; i < busyAdds; i++) kids.push(h('div', { class: 'chip busy' }));
  if (S.extraText) kids.push(h('div', { class: 'chip note' }, h('span', null, S.extraText), h('button', { class: 'rm', type: 'button', 'aria-label': 'Quitar el texto', onclick: () => {
    const t = S.extraText; S.extraText = ''; renderTray();
    toast('Texto quitado', { action: 'Deshacer', onAction: () => { S.extraText = t; renderTray(); } });
  } }, icon('x'))));
  const bytes = trayBytes();
  if (bytes > LIMIT.total * 0.5) kids.push(h('span', { class: 'tray-size' }, `${mb(bytes)} de ${mb(LIMIT.total)}`));
  $('trayList').replaceChildren(...kids);
  $('traySend').disabled = !(S.tray.length || S.extraText) || busyAdds > 0;
  refreshHint();
}
// Quitar un adjunto, con «Deshacer»: con los dedos sucios es fácil darle sin querer
function untray(f) {
  const at = S.tray.indexOf(f);
  if (at < 0) return;
  S.tray.splice(at, 1); renderTray(); camStack();
  toast(f.kind === 'image' ? 'Foto quitada' : f.kind === 'video' ? 'Vídeo quitado' : 'Audio quitado', { action: 'Deshacer', onAction: () => {
    if (!S.tray.includes(f)) S.tray.splice(Math.min(at, S.tray.length), 0, f);
    renderTray(); camStack();
  } });
}
function uniqueName(name) {
  const c = cur(), dot = name.lastIndexOf('.'), base = dot > 0 ? name.slice(0, dot) : name, ext = dot > 0 ? name.slice(dot) : '';
  let out = name, i = 1;
  while (S.tray.some((f) => f.name === out) || (c && S.media.has(mkey(c.id, out)))) out = `${base}-${++i}${ext}`;
  return out;
}
function mimeOf(name) {
  const k = kindOf(name), ext = (String(name).split('.').pop() || '').toLowerCase();
  return k === 'file' ? '' : `${k}/${ext === 'jpg' ? 'jpeg' : ext === 'mov' ? 'quicktime' : ext === 'm4a' ? 'mp4' : ext}`;
}
async function addFiles(list) {
  for (const f of Array.from(list || [])) {
    if (S.tray.length + busyAdds >= LIMIT.files) { toast(`Máximo ${LIMIT.files} adjuntos por envío. Envía estos primero.`); break; }
    const type = f.type || mimeOf(f.name);
    const kind = kindOf(f.name, type);
    if (kind === 'file') { toast('Solo puedo recibir fotos, vídeos y audios.'); continue; }
    busyAdds++; renderTray();
    try {
      let a;
      if (kind === 'image') {
        try { const r = await processImage(f); a = { kind, name: uniqueName(cleanName(f.name || 'foto').replace(/\.[^.]*$/, '') + (r.mime === 'image/png' ? '.png' : '.jpg')), mime: r.mime, size: r.blob.size, blob: r.blob, preview: r.preview }; }
        catch { a = { kind, name: uniqueName(cleanName(f.name)), mime: type, size: f.size, blob: f, preview: null }; }
      } else if (kind === 'video') {
        const info = await videoInfo(f);
        a = { kind, name: uniqueName(cleanName(f.name || 'video.mp4').replace(/\.webm$/i, '.mkv')), mime: type, size: f.size, blob: f, preview: info && info.poster, dur: info ? info.dur : 0 };
      } else a = { kind, name: uniqueName(cleanName(f.name || 'audio.m4a')), mime: type, size: f.size, blob: f };
      if (a.size > LIMIT.file) toast(kind === 'video' ? `Ese vídeo pesa ${mb(a.size)} y el máximo son 30 MB. Grábalo con el botón Vídeo: ocupa mucho menos.` : `Ese archivo pesa ${mb(a.size)} y el máximo son 30 MB.`, { ms: 7000 });
      else if (trayBytes() + a.size > LIMIT.total - LIMIT.reserve) toast('No cabe en este envío. Envía primero lo que ya tienes.', { ms: 6000 });
      else { a.id = uid(); S.tray.push(a); }
    } finally { busyAdds--; renderTray(); }
  }
  camStack();
}

// ------------------------------------------------------------------ envío (cola local resistente a cortes)
async function send(text, voice) {
  const c = cur();
  if (!c) return;
  while (busyAdds > 0) await new Promise((r) => setTimeout(r, 120));   // una foto aún se está preparando
  const texto = [S.extraText, text].filter(Boolean).join('\n').trim().slice(0, 8000);
  const files = (voice ? [voice] : []).concat(S.tray);          // la nota de voz, siempre la primera
  if (!texto && !files.length) return;
  const o = { lid: uid(), caso: c.id, vehiculo: isAuto(c) ? '' : c.vehicle, texto, files, ts: Date.now(), status: 'queued', tries: 0 };
  S.tray = []; S.extraText = '';
  S.outbox.push(o);
  c.act = o.ts; saveCases(); lastMove = Date.now();
  idb.put('outbox', o).catch(() => {});
  renderTray(); renderChat(true);
  pump();
}
let pumping = false, retryT = null;
async function pump() {
  if (pumping || !ready()) return;
  pumping = true;
  try {
    for (;;) {
      const o = S.outbox.find((x) => x.status === 'queued');
      if (!o) break;
      await sendItem(o);
      if (o.status !== 'sent') break;                             // lo demás espera su turno, en orden
    }
  } finally { pumping = false; refreshHint(); }
}
async function alreadyThere(o) {
  try {
    const d = await api.poll(o.caso), names = o.files.map((f) => f.name).sort().join('|');
    const m = (d.mensajes || []).find((x) => (x.texto || '') === o.texto && (x.files || []).slice().sort().join('|') === names && new Date(x.ts).getTime() > o.ts - 120000);
    return m ? m.id : null;
  } catch { return null; }
}
async function sendItem(o) {
  o.status = 'sending'; o.sendAt = Date.now();
  renderChat(); refreshHint();
  try {
    // Si un intento anterior se cortó a medias, puede que ya llegara: no lo mandamos dos veces
    const id = (o.tries > 0 && await alreadyThere(o)) || (await api.submit(o)).id;
    o.status = 'sent'; o.serverId = id;
    o.files.forEach((f) => {
      const rec = { key: mkey(o.caso, f.name), name: f.name, kind: f.kind, preview: f.preview || null, dur: f.dur || 0, peaks: f.peaks || null, blob: f.kind === 'audio' ? f.blob : null, ts: Date.now() };
      S.media.set(rec.key, rec); idb.put('media', rec).catch(() => {});
    });
    idb.del('outbox', o.lid).catch(() => {});
    if (id) { S.watch[id] = 1; ls.set('watch', S.watch); }
    S.flight[o.caso] = Date.now(); ls.set('flight', S.flight);
    pushMark(o.caso); pushRefresh();
    if (o.caso === S.current) toast('Enviado. Estoy con ello.');
    renderChat();
    refresh().then(schedule);
  } catch (e) {
    o.tries++;
    if (e instanceof PinError) { o.status = 'queued'; lock('El PIN ha cambiado. Escríbelo otra vez.'); }
    else if (e instanceof NetError && /tardado/.test(e.message) && (o.slow = (o.slow || 0) + 1) >= 2 && o.files.reduce((a, f) => a + f.size, 0) > 2e6) {
      // Dos subidas grandes agotadas: con una raya de cobertura no tiene sentido seguir gastando datos desde cero
      o.status = 'failed'; o.error = 'poca cobertura';
    } else if (e instanceof NetError) {
      o.status = 'waiting';
      clearTimeout(retryT);
      retryT = setTimeout(wakeOutbox, [4000, 12000, 30000, 60000][Math.min(o.tries - 1, 3)]);
    } else { o.status = 'failed'; o.error = String((e && e.message) || '').slice(0, 200); }
    idb.put('outbox', o).catch(() => {});
    renderChat();
  }
}
function wakeOutbox() { S.outbox.forEach((o) => { if (o.status === 'waiting') o.status = 'queued'; }); renderChat(); pump(); }

// ------------------------------------------------------------------ consulta periódica
const ready = () => DEMO || (!!S.queue && !!S.pin);
let pollT = null, refreshing = false, moveSig = '';
const lastOther = {};
async function refresh() {
  const c = cur();
  if (!c || !ready() || refreshing) return;
  refreshing = true;
  try {
    const d = await api.poll(c.id);
    if (c.id !== S.current) return;
    const list = d.mensajes || [], prev = new Map(S.messages.map((m) => [m.id, m])), news = [];
    list.forEach((m) => {
      const o = prev.get(m.id);
      if (o && o.progreso && m.progreso && o.progreso.ts === m.progreso.ts) m.progreso._seen = o.progreso._seen;
      if (!m.respuesta) S.watch[m.id] = 1;
      else if (S.watch[m.id]) { delete S.watch[m.id]; fresh.add(m.id); news.push(m); }
    });
    ls.set('watch', S.watch);
    S.messages = list;
    const mv = c.id + '#' + list.map((m) => m.id + m.estado + (m.progreso ? m.progreso.ts : '')).join('|');
    if (mv !== moveSig) { moveSig = mv; lastMove = Date.now(); }
    idb.put('cases', { id: c.id, messages: list, ts: Date.now() }).catch(() => {});
    S.outbox = S.outbox.filter((o) => !(o.status === 'sent' && (o.caso !== c.id || list.some((m) => m.id === o.serverId))));
    const name = c.vehicle;
    noteCase(c, list);
    c.seen = Date.now(); c.news = false;
    if (!c.last || !c.last.busy) { delete S.flight[c.id]; ls.set('flight', S.flight); }
    saveCases();
    const now = list.map((m) => `${m.id}:${m.estado}:${m.respuesta ? 1 : 0}`).join('|') + '#' + S.outbox.map((o) => o.lid + o.status).join('|');
    if (now !== sig || name !== c.vehicle) { sig = now; renderChat(); renderHeader(); renderCars(); refreshHint(); }
    if (news.length) announce(c, news[news.length - 1]);
  } catch (e) {
    if (e instanceof PinError) lock('El PIN ha cambiado. Escríbelo otra vez.');
  } finally { refreshing = false; }
}
async function refreshOthers() {
  for (const id of Object.keys(S.flight)) {
    if (id === S.current) continue;
    const c = S.cases.find((x) => x.id === id);
    if (!c) { delete S.flight[id]; continue; }
    if (Date.now() - (lastOther[id] || 0) < 15000) continue;
    lastOther[id] = Date.now();
    try {
      const list = (await api.poll(id)).mensajes || [];
      idb.put('cases', { id, messages: list, ts: Date.now() }).catch(() => {});
      noteCase(c, list);
      if (!c.last || !c.last.busy) {
        delete S.flight[id];
        c.news = true;
        const last = list[list.length - 1];
        announceOther(c, 1);
        if (document.hidden && last && last.respuesta) notify(c, last.respuesta);
      }
      saveCases(); renderHeader(); renderCars();
    } catch { /* se reintenta */ }
  }
  ls.set('flight', S.flight);
}
// Todos los casos abiertos, no solo los creados aquí: la cola dice qué casos tienen actividad y se suman a la
// lista (escritorio: barra izquierda; móvil: hoja de coches). Los que se ocultan aquí no vuelven salvo que haya
// mensajes nuevos. Si la cola es anterior a esta operación, la lista se queda con los casos locales, como antes.
let syncT = null, syncing = false, synced = false, casosOff = false;
async function syncCases() {
  clearTimeout(syncT);
  if (!started || !ready() || syncing || casosOff || !api.casos) return;
  syncing = true;
  let wait = 120000;
  try {
    const d = await api.casos(), first = !synced, now = Date.now(), ready_ = [];
    synced = true;
    let changed = false, hid = false;
    for (const r of d.casos || []) {
      const t = Date.parse(r.ts) || 0, rt = Date.parse(r.respondido_ts) || 0, busy = r.estado === 'pendiente' || r.estado === 'procesando';
      let c = S.cases.find((x) => x.id === r.caso);
      if (!c) {
        if (S.hidden[r.caso] && t <= S.hidden[r.caso]) continue;
        if (S.hidden[r.caso]) { delete S.hidden[r.caso]; hid = true; }
        c = { id: r.caso, vehicle: vehicleName(r.vehiculo) || firstWords(r.resumen) || (r.origen === 'email' ? 'Consulta por correo' : 'Coche sin nombre'), ts: t, remote: true, src: r.origen === 'email' ? 'correo' : 'app', seen: first ? now : 0 };
        S.cases.push(c); changed = true;
      }
      if (c.seen == null) c.seen = first ? now : 0;              // coches guardados por la versión anterior
      if (t > (c.act || 0)) { c.act = t; changed = true; }
      if (c.id === S.current || S.flight[c.id]) continue;          // de esos se encargan refresh() y refreshOthers()
      if (r.vehiculo && (isAuto(c) || (c.remote && !c.named)) && vehicleName(r.vehiculo) !== c.vehicle) { c.vehicle = vehicleName(r.vehiculo); changed = true; }
      const l = { busy, err: r.estado === 'error', n: r.n, text: String(r.estado === 'error' ? 'No se ha podido completar' : r.resumen || '').slice(0, 90) };
      if (JSON.stringify(l) !== JSON.stringify(c.last || null)) { c.last = l; changed = true; }
      if (busy) wait = 30000;
      if (!busy && rt > (c.seen || 0) && !c.news) { c.news = true; changed = true; if (!first) ready_.push(c); }
    }
    if (hid) ls.set('hidden', S.hidden);
    if (changed) { saveCases(); renderHeader(); renderCars(); }
    const c = ready_[ready_.length - 1];
    if (c) announceOther(c, ready_.length);
    // Escritorio recién abierto: en vez de un «Coche 1» vacío, el caso con actividad más reciente (Ed sigue desde
    // el ordenador lo que entra por el móvil). En el móvil no: la nota siguiente suele ser de otro coche.
    if (first && wide() && !touched && isEmpty(cur()) && !QS.has('nuevo') && !QS.has('caso')) {
      const pick = S.cases.filter((x) => !isEmpty(x)).sort((a, b) => actOf(b) - actOf(a))[0];
      if (pick) selectCase(pick.id);
    }
  } catch (e) {
    if (!(e instanceof PinError) && !(e instanceof NetError)) casosOff = true;   // la cola aún no sabe listar casos
    wait = 60000;
  } finally { syncing = false; }
  if (!casosOff && !document.hidden) syncT = setTimeout(syncCases, wait);
}
const needsPoll = () => S.messages.some((m) => !m.respuesta) || Object.keys(S.flight).length > 0;
function schedule() {
  clearTimeout(pollT);
  if (!ready() || !needsPoll()) { releaseWake(); return; }
  const stale = Date.now() - lastMove > WAKE_MAX;
  if (stale) releaseWake(); else keepAwake();                       // pantalla encendida: la respuesta se oye sin tocar el móvil
  pollT = setTimeout(async () => { await refresh(); await refreshOthers(); schedule(); }, stale ? 30000 : document.hidden ? 12000 : 5000);
}
function announce(c, m) {
  const r = m.respuesta, say = sayOf(r);
  buzz([60, 50, 60]);
  if (document.hidden) { if (S.voice) speakLater = { id: m.id, say }; notify(c, r); return; }
  if (!S.voice) {                                                   // en silencio, pero que se note
    toast(r._error ? 'No se ha podido completar el diagnóstico' : 'Respuesta en silencio', { action: 'Oír', ms: 15000, onAction: () => { tts.unlock(); stopNote(); tts.speak(m.id, say); } });
    return;
  }
  speakOrDefer(m.id, say);
}
// Otro coche ya tiene diagnóstico: aviso fijo, campanilla y una frase corta (si se puede hablar)
function announceOther(c, n) {
  buzz([60, 50, 60]);
  showNews(c, n);
  if (!S.voice) return;
  const say = n > 1 ? `Hay ${n} diagnósticos nuevos. Pulsa Ver.` : `Ya está el diagnóstico: ${c.vehicle}. Pulsa Ver para oírlo.`;
  if (document.hidden || capturing()) { if (!speakLater) speakLater = { id: null, say }; refreshHint(); camNote(); return; }
  if (tts.cur) { chime(); return; }                                 // no se corta la lectura en curso
  sayNow(null, say);
}

// ------------------------------------------------------------------ panel de mandos: voz y texto
let hintOver = '';
function refreshHint() {
  let t;
  if (hintOver) t = hintOver;
  else if (recState === 'starting') t = 'Preparando el micro…';
  else if (recState === 'on' && speakLater) t = 'Diagnóstico listo: te lo leo al terminar';
  else if (recState === 'on') t = holding() ? 'Suelta para enviar' : 'Te escucho. Pulsa otra vez para enviar.';
  else if (S.outbox.some((o) => o.status === 'sending')) t = 'Enviando…';
  else if (S.tray.length || S.extraText) t = 'Explícalo por voz o pulsa Enviar';
  else if (S.messages.some((m) => !m.respuesta)) t = 'Mientras tanto puedes mandar más datos';
  else if (S.messages.length) t = 'Pulsa y cuéntame qué ha salido';
  else t = 'Pulsa y cuéntame la avería';
  if ($('hint').textContent !== t) $('hint').textContent = t;
  // Con un diagnóstico en pantalla y nada entre manos, la pista se convierte en «Repetir respuesta», al alcance del pulgar
  const last = S.mode === 'voice' && recState === 'idle' && !S.tray.length && !S.extraText && !S.outbox.some((o) => o.caso === S.current && o.status !== 'sent') ? lastAnswer() : null;
  $('replay').hidden = !last;
  $('hint').hidden = !!last || S.mode === 'text';
  if (last) {
    $('replay').dataset.id = last.id;
    $('replay').dataset.label = last.respuesta._error ? 'Oír el aviso' : 'Repetir respuesta';
    syncListen();
  }
}
// En pantallas táctiles se arranca siempre hablando y se vuelve al micro tras enviar un texto: si Alberto escribe
// una vez, Manolo no debe encontrarse un teclado. En el ordenador sí se recuerda (escribir es lo natural ahí).
function setMode(m, focus) {
  S.mode = m;
  if (!touch()) ls.set('mode', m);
  $('dockVoice').hidden = m !== 'voice';
  $('dockText').hidden = m !== 'text';
  $('traySend').hidden = m === 'text';                              // en modo texto, la flecha lo envía todo
  refreshHint();
  if (m === 'text' && focus) setTimeout(() => $('txt').focus(), 40);
}
function sendTyped() {
  const t = $('txt').value.trim();
  if (!t && !S.tray.length && !S.extraText) return;
  $('txt').value = ''; $('txt').style.height = '';
  send(t);
  if (touch()) { $('txt').blur(); setMode('voice'); }
}

let rec = null, recState = 'idle', recRaf = 0, recMaxT = null, downAt = 0, downXY = [0, 0], pressOwns = false, pressed = false;
let peaks = [], peakNow = 0, peakAt = 0, smooth = 0, loud = 0, hintAt = 0;
const holding = () => pressed && pressOwns && performance.now() - downAt > 650;

// Dónde se da el permiso, según el dispositivo (con las palabras que se ven en pantalla)
function permHelp(what) {
  if (isIOS) return `En el iPhone: Ajustes › Apps › Safari › ${what} › Permitir. Luego vuelve y pulsa otra vez.`;
  if (/Android/i.test(navigator.userAgent)) return standalone()
    ? `Mantén pulsado el icono de Taller IA › Información de la aplicación › Permisos › ${what} › Permitir.`
    : `Toca el icono a la izquierda de la dirección › Permisos › ${what} › Permitir.`;
  return `Pulsa el icono a la izquierda de la dirección › ${what} › Permitir, y vuelve a pulsar.`;
}
function micHelp(e) {
  const name = e && e.name;
  if (!window.isSecureContext) return 'Para grabar hace falta abrir la app por https.';
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'El micro está bloqueado para esta app. ' + permHelp('Micrófono');
  if (name === 'NotFoundError') return 'No encuentro ningún micrófono en este dispositivo.';
  return 'No he podido abrir el micro. Prueba otra vez.';
}
async function recStart() {
  if (recState !== 'idle') return;
  if (!canRecord()) { toast(window.isSecureContext ? 'Este navegador no deja grabar voz aquí. Usa Escribir o Galería.' : 'Para grabar hace falta abrir la app por https.', { ms: 6000 }); return; }
  recState = 'starting';
  tts.stop(); stopNote();
  $('ptt').classList.add('arming');
  refreshHint();
  const r = new VoiceRecorder();
  try { await r.start(); }
  catch (e) { recState = 'idle'; $('ptt').classList.remove('arming'); refreshHint(); toast(micHelp(e), { ms: 10000 }); return; }
  if (recState !== 'starting') { r.cancel(); return; }
  rec = r; recState = 'on';
  peaks = []; peakNow = 0; peakAt = 0; smooth = 0; loud = 0; hintOver = '';
  buzz(30);
  $('ptt').classList.remove('arming'); $('ptt').classList.add('rec');
  $('ptt').setAttribute('aria-label', 'Parar y enviar la nota de voz');
  $('dock').classList.add('is-rec');
  recMaxT = setTimeout(recStop, LIMIT.voiceS * 1000);
  recLoop();
}
function recLoop() {
  if (recState !== 'on') return;
  const ms = rec.elapsed(), lvl = rec.level();
  smooth = Math.max(lvl, smooth * 0.85); loud = Math.max(loud, lvl);
  $('ptt').style.setProperty('--lvl', smooth.toFixed(3));
  $('ptt').style.setProperty('--prog', (ms / (LIMIT.voiceS * 10)).toFixed(2));
  $('recTime').textContent = clock(ms / 1000);
  peakNow = Math.max(peakNow, lvl);
  if (ms - peakAt > 110) { peaks.push(peakNow); peakNow = 0; peakAt = ms; drawWave(); }
  if (ms - hintAt > 250 || ms < hintAt) {
    hintAt = ms;
    hintOver = ms > 3500 && loud < 0.02 && rec.an ? 'No te oigo. ¿Está tapado el micro?' : '';
    refreshHint();
  }
  recRaf = requestAnimationFrame(recLoop);
}
function drawWave() {
  const cv = $('recWave'), g = cv.getContext('2d'), n = 30, w = cv.width / n;
  g.clearRect(0, 0, cv.width, cv.height);
  g.fillStyle = '#fff';
  peaks.slice(-n).forEach((p, i) => { const bh = Math.max(2, Math.min(1, p) * cv.height); g.fillRect(i * w + 1, (cv.height - bh) / 2, w - 2, bh); });
}
function recReset() {
  cancelAnimationFrame(recRaf); clearTimeout(recMaxT);
  hintOver = '';
  $('ptt').classList.remove('rec', 'arming'); $('ptt').style.setProperty('--lvl', 0); $('ptt').style.setProperty('--prog', 0);
  $('ptt').setAttribute('aria-label', 'Grabar nota de voz');
  $('dock').classList.remove('is-rec');
  $('recTime').textContent = '0:00';
  const cv = $('recWave'); cv.getContext('2d').clearRect(0, 0, cv.width, cv.height);
  setTimeout(flushSpeak, 300);                                      // lo que llegó mientras se grababa
}
async function recStop() {
  if (recState !== 'on') return;
  recState = 'stopping';
  const r = await rec.stop();
  rec = null; recState = 'idle';
  recReset();
  if (r.ms < 800 || !r.blob.size) { toast('Demasiado corto. Pulsa, habla y vuelve a pulsar.'); refreshHint(); return; }
  buzz(20);
  const ext = /mp4|aac/.test(r.mime) ? 'm4a' : /ogg/.test(r.mime) ? 'ogg' : 'webm';
  const step = Math.max(1, Math.ceil(peaks.length / 32)), bars = [];
  for (let i = 0; i < peaks.length; i += step) bars.push(Math.max(...peaks.slice(i, i + step)));
  send('', { id: uid(), kind: 'audio', name: `nota-${stamp()}.${ext}`, mime: r.mime, size: r.blob.size, blob: r.blob, dur: r.ms / 1000, peaks: bars });
}
function recCancel() {
  if (recState === 'starting') { recState = 'idle'; recReset(); refreshHint(); return; }
  if (recState !== 'on') return;
  rec.cancel(); rec = null; recState = 'idle';
  recReset(); refreshHint();
  toast('Nota de voz descartada');
}

// ------------------------------------------------------------------ cámara integrada
const camera = new Camera($('camVideo'));
let camMode = 'photo', camOpen = false, camRaf = 0, camMaxT = null, camBusy = 0, shot = 0, camRecState = 'idle';
// En la cámara no hay pista: si llega un diagnóstico mientras se graba, se dice aquí que se leerá al terminar
function camNote() { $('camNote').hidden = !(camOpen && speakLater && capturing()); }
function camStack() {
  const n = S.tray.length + camBusy, last = S.tray.slice().reverse().find((f) => f.preview);
  $('camStack').hidden = n === 0; $('camDone').hidden = n === 0;
  $('camStackN').textContent = n;
  if (last) $('camStackImg').src = last.preview; else $('camStackImg').removeAttribute('src');
}
function setCamMode(m) {
  camMode = m;
  $('cam').dataset.mode = m;
  $('camModes').querySelectorAll('button').forEach((b) => b.setAttribute('aria-selected', b.dataset.mode === m ? 'true' : 'false'));
  $('shutter').setAttribute('aria-label', m === 'photo' ? 'Hacer la foto' : 'Empezar a grabar');
}
function nativeCapture(m) { $(m === 'video' ? 'capVideo' : 'capPhoto').click(); }
async function camStart() {
  try {
    await camera.open();
    if (!camOpen) { camera.close(); return; }
    $('cam').classList.toggle('mirror', !!camera.mirrored);
    $('camTorch').hidden = !camera.hasTorch; $('camTorch').setAttribute('aria-pressed', 'false');
    $('camErr').hidden = true;
    camera.track.addEventListener('ended', () => {                  // otra app se ha quedado la cámara, o el sistema la ha cortado
      if (!camOpen || camera.recording) return;
      $('camErrMsg').textContent = 'La cámara se ha cortado.'; $('camErr').hidden = false;
    });
  } catch (e) {
    if (!camOpen) return;
    const n = e && e.name;
    $('camErrMsg').textContent = n === 'NotAllowedError' || n === 'SecurityError' ? 'La cámara está bloqueada para esta app. ' + permHelp('Cámara') + ' O usa la cámara del móvil.'
      : n === 'NotFoundError' || n === 'OverconstrainedError' ? 'No encuentro ninguna cámara en este dispositivo.' : 'No he podido abrir la cámara.';
    $('camErr').hidden = false;
  }
}
function openCam(m) {
  if (!canCamera()) { nativeCapture(m); return; }
  if (S.tray.length >= LIMIT.files) { toast(`Máximo ${LIMIT.files} adjuntos por envío. Envía estos primero.`); return; }
  if (recState !== 'idle') return;
  tts.stop(); stopNote();
  camOpen = true;
  $('cam').hidden = false; $('camErr').hidden = true; $('camTimer').hidden = true;
  setCamMode(m); camStack();
  pushOverlay(() => {
    camOpen = false;
    cancelAnimationFrame(camRaf); clearTimeout(camMaxT);
    camMicCancel(true);
    camera.close();
    $('cam').hidden = true; $('cam').classList.remove('rec');
    renderTray(); camNote();
    setTimeout(flushSpeak, 300);
  });
  camStart();
}
const closeCam = () => { if (camOpen) popOverlay(); };
async function snap() {
  if (!camera.live) { $('camErrMsg').textContent = 'La cámara se ha cortado.'; $('camErr').hidden = false; return; }
  if (S.tray.length + camBusy >= LIMIT.files) { toast(`Máximo ${LIMIT.files} adjuntos por envío.`); return; }
  const fl = $('camFlash'); fl.classList.remove('go'); void fl.offsetWidth; fl.classList.add('go');
  buzz(15);
  camBusy++; camStack();
  try {
    const r = await processImage(await camera.photo(), 2048, 0.86, true);
    S.tray.push({ id: uid(), kind: 'image', name: `foto-${stamp()}-${++shot}.jpg`, mime: r.mime, size: r.blob.size, blob: r.blob, preview: r.preview });
  } catch { toast('No ha salido la foto. Prueba otra vez.'); }
  camBusy--; camStack();
}
async function toggleVideo() {
  if (!camera.recording) {
    if (!camera.live || camRecState !== 'idle') return;
    if (trayBytes() > LIMIT.total - LIMIT.reserve - 14e6) { toast('No cabe otro vídeo en este envío. Envía primero lo que tienes.'); return; }
    tts.stop(); stopNote();
    try { await camera.startVideo(); }
    catch { toast('Este navegador no deja grabar vídeo aquí. Usa la cámara del móvil.', { ms: 6000 }); $('camErrMsg').textContent = 'Este navegador no deja grabar vídeo aquí.'; $('camErr').hidden = false; return; }
    if (camera.silent) toast('Sin permiso de micro: el vídeo irá sin sonido.', { ms: 5000 });
    buzz(30);
    $('cam').classList.add('rec'); $('camTimer').hidden = false;
    $('shutter').setAttribute('aria-label', 'Parar y guardar el vídeo');
    camMaxT = setTimeout(() => { if (camera.recording) toggleVideo(); }, LIMIT.videoS * 1000);
    const tick = () => {
      if (!camera.recording) return;
      const ms = camera.elapsed();
      $('camTime').textContent = `${clock(ms / 1000)} / ${clock(LIMIT.videoS)}`;
      $('shutter').style.setProperty('--prog', (ms / (LIMIT.videoS * 10)).toFixed(2));
      camRaf = requestAnimationFrame(tick);
    };
    tick();
    return;
  }
  clearTimeout(camMaxT); cancelAnimationFrame(camRaf);
  const r = await camera.stopVideo();
  $('cam').classList.remove('rec'); $('camTimer').hidden = true;
  $('shutter').style.setProperty('--prog', 0); $('shutter').setAttribute('aria-label', 'Empezar a grabar');
  camNote(); setTimeout(flushSpeak, 300);
  if (r.ms < 1000 || !r.blob.size) { toast('Vídeo demasiado corto.'); return; }
  const webm = /webm|matroska/.test(r.mime);
  // .mkv: el trabajador trata cualquier .webm como audio; WebM es Matroska y ffmpeg lo lee igual
  const blob = webm ? await fixWebmDuration(r.blob, r.ms) : r.blob;
  S.tray.push({ id: uid(), kind: 'video', name: `video-${stamp()}.${webm ? 'mkv' : 'mp4'}`, mime: webm ? 'video/webm' : 'video/mp4', size: blob.size, blob, preview: r.poster, dur: r.ms / 1000 });
  buzz([20, 40, 20]);
  closeCam();                                                      // queda en la bandeja, listo para enviar
}

// --- micro dentro de la cámara: explicar mientras se hacen fotos.
// Mantener pulsado y soltar, o un toque para empezar y otro para terminar (con la otra mano se dispara).
// Al terminar se envía todo en un solo mensaje: la nota primero y las fotos detrás, y se cierra la cámara.
// Mientras graba no suena nada (ni voz ni campanilla), para no meter al asistente en la nota.
let camRec = null, camMicRaf = 0, camMicMaxT = null, camDownAt = 0, camDownXY = [0, 0], camPressOwns = false, camPressed = false, camPeaks = [], camPeakAt = 0, camPeakNow = 0;
const camHolding = () => camPressed && camPressOwns && performance.now() - camDownAt > 650;
function camMicLabel() {
  const l = $('camMicLbl');
  if (camRecState === 'starting') l.textContent = 'Preparando…';
  else if (camRecState === 'on') l.textContent = `${clock(camRec.elapsed() / 1000)} · ${camHolding() ? 'suelta y envío' : 'pulsa y envío'}`;
  else l.textContent = 'Explicar';
}
async function camMicStart() {
  if (camRecState !== 'idle' || camera.recording) return;
  if (!canRecord()) { toast('Este navegador no deja grabar voz aquí. Haz las fotos y explícalo después.', { ms: 6000 }); return; }
  camRecState = 'starting';
  tts.stop(); stopNote();
  $('cam').classList.add('mic-arming'); camMicLabel();
  const r = new VoiceRecorder();
  try { await r.start(); }
  catch (e) { camRecState = 'idle'; $('cam').classList.remove('mic-arming'); camMicLabel(); toast(micHelp(e), { ms: 10000 }); return; }
  if (camRecState !== 'starting' || !camOpen) { r.cancel(); camRecState = 'idle'; camMicReset(); return; }
  camRec = r; camRecState = 'on'; camPeaks = []; camPeakAt = 0; camPeakNow = 0;
  buzz([30, 40, 30]);                                              // distinto del obturador (15 ms)
  $('cam').classList.remove('mic-arming'); $('cam').classList.add('mic-on');
  $('camMic').setAttribute('aria-label', 'Terminar la explicación y enviarlo todo');
  $('camDone').textContent = 'Enviar';
  camMicMaxT = setTimeout(camMicStop, LIMIT.voiceS * 1000);
  camMicLoop();
}
function camMicLoop() {
  if (camRecState !== 'on') return;
  const ms = camRec.elapsed(), lvl = camRec.level();
  $('camMic').style.setProperty('--lvl', lvl.toFixed(3));
  camPeakNow = Math.max(camPeakNow, lvl);
  if (ms - camPeakAt > 110) { camPeaks.push(camPeakNow); camPeakNow = 0; camPeakAt = ms; }
  camMicLabel();
  camMicRaf = requestAnimationFrame(camMicLoop);
}
function camMicReset() {
  cancelAnimationFrame(camMicRaf); clearTimeout(camMicMaxT);
  $('cam').classList.remove('mic-on', 'mic-arming');
  $('camMic').style.setProperty('--lvl', 0); $('camMic').classList.remove('down');
  $('camMic').setAttribute('aria-label', 'Explicar por voz mientras haces fotos: mantén pulsado, o pulsa para empezar y otra vez para enviar');
  $('camDone').textContent = 'Listo';
  camMicLabel(); camNote();
}
async function camMicStop() {
  if (camRecState !== 'on') return;
  camRecState = 'stopping';
  const r = await camRec.stop();
  camRec = null; camRecState = 'idle';
  camMicReset();
  if (r.ms < 800 || !r.blob.size) { toast('Demasiado corto. Mantén pulsado el micro mientras hablas.'); setTimeout(flushSpeak, 300); return; }
  buzz(20);
  while (camBusy > 0) await new Promise((ok) => setTimeout(ok, 100));   // la última foto aún se está preparando
  const ext = /mp4|aac/.test(r.mime) ? 'm4a' : /ogg/.test(r.mime) ? 'ogg' : 'webm';
  const step = Math.max(1, Math.ceil(camPeaks.length / 32)), bars = [];
  for (let i = 0; i < camPeaks.length; i += step) bars.push(Math.max(...camPeaks.slice(i, i + step)));
  closeCam();
  send('', { id: uid(), kind: 'audio', name: `nota-${stamp()}.${ext}`, mime: r.mime, size: r.blob.size, blob: r.blob, dur: r.ms / 1000, peaks: bars });
}
function camMicCancel(quiet) {
  if (camRecState === 'starting') { camRecState = 'idle'; camMicReset(); return; }
  if (camRecState !== 'on') return;
  camRec.cancel(); camRec = null; camRecState = 'idle';
  camMicReset();
  if (!quiet) toast('Explicación descartada');
  setTimeout(flushSpeak, 300);
}

// ------------------------------------------------------------------ documentos, informe y fuentes
const docUrls = new Map();
function b64ToBlob(b64, mime) {
  const parts = [], CH = 1048576;
  for (let i = 0; i < b64.length; i += CH) {
    const bin = atob(b64.slice(i, i + CH)), u = new Uint8Array(bin.length);
    for (let j = 0; j < bin.length; j++) u[j] = bin.charCodeAt(j);
    parts.push(u);
  }
  return new Blob(parts, { type: mime || 'application/pdf' });
}
async function openDoc(x) {
  const id = x.drive_id, tapAt = performance.now();
  const status = h('p', { class: 'lead', 'aria-live': 'polite' }, 'Buscando el documento…');
  const actions = h('div', { class: 'sheet-actions' });
  openSheet(h('div', null, h('h2', null, x.titulo || x.archivo), x.por_que ? h('p', { class: 'lead' }, x.por_que) : null, status, actions));
  const load = async () => {
    actions.replaceChildren();
    let d = await idb.get('docs', id).catch(() => null);
    const cached = !!d;
    if (!d) {
      status.textContent = `Descargando${x.mb ? ' ' + String(x.mb).replace('.', ',') + ' MB' : ''}…`;
      try {
        const r = await api.doc(id);
        d = { id, name: r.name || x.archivo || 'documento.pdf', blob: b64ToBlob(r.b64, r.mime), ts: Date.now() };
        idb.put('docs', d).catch(() => {});
      } catch (e) {
        if (e instanceof PinError) { closeSheet(); lock('El PIN ha cambiado. Escríbelo otra vez.'); return; }
        status.textContent = 'No se ha podido descargar. Comprueba la conexión.';
        actions.append(h('button', { class: 'btn btn-go', type: 'button', onclick: load }, icon('retry'), 'Reintentar'));
        return;
      }
    }
    let url = docUrls.get(id);
    if (!url) { url = URL.createObjectURL(d.blob); docUrls.set(id, url); }
    status.textContent = `Listo, ${mb(d.blob.size)}. Queda guardado en este dispositivo para abrirlo sin conexión.`;
    let file = null;
    try { file = new File([d.blob], d.name, { type: d.blob.type }); } catch { /* sin File */ }
    const share = file && navigator.canShare && navigator.canShare({ files: [file] });
    // En el iPhone instalado, abrir un enlace blob: en otra ventana no es fiable: primero «Abrir con…» (Libros, Archivos…)
    const iosFirst = isIOS && share;
    const open = h('a', { class: 'btn ' + (iosFirst ? 'btn-quiet' : 'btn-go'), href: url, target: '_blank', rel: 'noopener' }, icon('ext'), 'Abrir');
    const withApp = share ? h('button', { class: 'btn ' + (iosFirst ? 'btn-go' : 'btn-quiet'), type: 'button', onclick: () => navigator.share({ files: [file], title: d.name }).catch(() => {}) }, icon('share'), iosFirst ? 'Abrir con…' : 'Compartir o abrir con otra app') : null;
    const save = h('a', { class: 'btn btn-quiet', href: url, download: d.name }, icon('down'), 'Guardar en el dispositivo');
    if (iosFirst) actions.append(withApp, open, save); else actions.append(open, save, withApp || '');
    // Si ya estaba guardado, el toque sigue «vivo» y se abre directamente (en el iPhone no: ver arriba)
    if (cached && !isIOS && performance.now() - tapAt < 1500) { try { if (window.open(url, '_blank')) closeSheet(); } catch { /* queda el botón */ } }
  };
  load();
}

const TAGS = new Set(['P', 'B', 'STRONG', 'I', 'EM', 'U', 'BR', 'HR', 'UL', 'OL', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD', 'A', 'CODE', 'PRE', 'BLOCKQUOTE', 'SPAN', 'DIV', 'SMALL', 'SUP', 'SUB']);
const DROP = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'TEMPLATE', 'SVG', 'MATH', 'LINK', 'META', 'HEAD', 'TITLE', 'NOSCRIPT', 'FORM', 'INPUT', 'BUTTON', 'TEXTAREA', 'SELECT', 'IMG', 'VIDEO', 'AUDIO']);
// El informe llega como HTML escrito por el modelo a partir de páginas web: se reconstruye
// nodo a nodo con una lista cerrada de etiquetas y sin atributos (salvo enlaces http/https).
function sanitize(html) {
  const out = document.createDocumentFragment();
  const walk = (src, dst) => src.childNodes.forEach((n) => {
    if (n.nodeType === 3) { dst.append(n.textContent); return; }
    if (n.nodeType !== 1 || DROP.has(n.tagName)) return;
    if (!TAGS.has(n.tagName)) { walk(n, dst); return; }
    const tag = /^H[1-5]$/.test(n.tagName) ? 'h3' : n.tagName.toLowerCase();
    const e = document.createElement(tag);
    if (tag === 'a') { const u = safeUrl(n.getAttribute('href')); if (u) { e.href = u; e.target = '_blank'; e.rel = 'noopener noreferrer'; } }
    if (tag === 'td' || tag === 'th') ['colspan', 'rowspan'].forEach((a) => { const v = parseInt(n.getAttribute(a), 10); if (v > 1 && v < 20) e.setAttribute(a, v); });
    walk(n, e);
    if (tag === 'table') dst.append(h('div', { class: 'tbl' }, e)); else dst.append(e);
  });
  walk(new DOMParser().parseFromString(String(html || ''), 'text/html').body, out);
  return out;
}
function openReport(r) { openSheet(h('div', null, h('h2', null, 'Informe completo'), h('div', { class: 'report' }, sanitize(r.respuesta_html)))); }
function openSources(src) {
  openSheet(h('div', null, h('h2', null, 'Fuentes'), h('ol', { class: 'steps' }, src.map((f) => h('li', null, h('a', { href: safeUrl(f.url), target: '_blank', rel: 'noopener noreferrer' }, f.title || f.url))))));
}

// ------------------------------------------------------------------ ajustes, instalación e invitación
let installEvt = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvt = e; if (started && !S.messages.length) renderChat(); });
const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const canInstall = () => !standalone() && (!!installEvt || isIOS);
async function install() {
  if (installEvt) {
    const e = installEvt; installEvt = null;
    e.prompt();
    try { await e.userChoice; } catch { /* nada */ }
    renderChat();
  } else {
    // La app instalada no comparte datos con Safari: se copia la conexión en este mismo toque y dentro solo hay que pegarla
    let copied = false;
    if (!DEMO && S.queue && navigator.clipboard && navigator.clipboard.writeText) {
      try { await navigator.clipboard.writeText(inviteLink(ls.get('pinLink', false))); copied = true; } catch { /* sin portapapeles */ }
    }
    openSheet(h('div', null, h('h2', null, 'Instalar en el iPhone o iPad'),
      copied ? h('p', { class: 'lead ok-lead' }, icon('check'), 'He copiado tu conexión.') : null,
      h('ol', { class: 'steps' },
        h('li', null, 'Si no estás en Safari, abre esta página en Safari.'),
        h('li', null, 'Pulsa ··· (abajo a la derecha) y luego Compartir. En iOS 18 o anterior, Compartir es el cuadrado con una flecha.'),
        h('li', null, 'Elige «Añadir a pantalla de inicio» y pulsa Añadir.'),
        h('li', null, 'Abre Taller IA desde el icono nuevo' + (copied ? ' y pulsa el botón amarillo «Pegar el enlace copiado».' : '.'))),
      h('div', { class: 'sheet-actions' }, h('button', { class: 'btn btn-quiet', type: 'button', onclick: () => { ls.set('noinstall', true); closeSheet(); renderChat(); } }, 'No volver a enseñarlo'))));
  }
}
function row(ic, title, sub, onclick, sw) {
  return h('button', { class: 'row', type: 'button', role: sw == null ? null : 'switch', 'aria-checked': sw == null ? null : String(!!sw), onclick }, icon(ic), h('span', null, h('b', null, title), sub ? h('small', null, sub) : null), sw == null ? null : h('span', { class: 'sw' }));
}
function openMenu() {
  const box = h('div', null, h('h2', null, 'Ajustes'));
  if (pushOk() || isIOS) box.append(row('bell', 'Avísame aunque cierre la app', isIOS && !standalone() ? 'En el iPhone, con la app instalada (iOS 16.4 o posterior)' : 'Un aviso en el móvil con el coche y lo que tiene, aunque la app esté cerrada', async (e) => {
    const b = e.currentTarget;
    if (ls.get('push', false)) await pushOff(); else await pushOn();
    b.setAttribute('aria-checked', String(!!ls.get('push', false)));
  }, !!ls.get('push', false)));
  else if ('Notification' in window) box.append(row('bell', 'Avisarme cuando esté el diagnóstico', 'Funciona mientras la app siga abierta de fondo', async (e) => {
    const b = e.currentTarget;
    if (S.notify) S.notify = false;
    else { let p = 'denied'; try { p = await Notification.requestPermission(); } catch { /* nada */ } S.notify = p === 'granted'; if (!S.notify) toast('Los avisos están bloqueados en los ajustes del navegador.'); }
    ls.set('notify', S.notify); b.setAttribute('aria-checked', String(S.notify));
  }, S.notify && Notification.permission === 'granted'));
  if (canInstall()) box.append(row('phone', 'Instalar en este dispositivo', 'Se abre con un toque, a pantalla completa', install));
  if (!DEMO && S.queue) box.append(row('share', 'Conectar otro móvil, tableta u ordenador', 'Manda un enlace de invitación', openInvite));
  if (!DEMO) box.append(row('out', 'Cerrar sesión', 'Vuelve a pedir el PIN en este dispositivo', () => { S.pin = ''; ls.del('pin'); closeSheet(); clearTimeout(pollT); lock(); }));
  box.append(h('p', { class: 'about' }, `Taller IA web ${VERSION}` + (DEMO ? ', en modo demostración: nada sale de este dispositivo.' : '')));
  openSheet(box);
}
function inviteLink(withPin) {
  const id = (S.queue.match(/\/s\/([\w-]+)\/exec/) || [])[1], base = location.origin + location.pathname;
  return `${base}#q=${id}` + (withPin && S.pin ? `&pin=${S.pin}` : '');
}
function openInvite() {
  let withPin = false;
  const code = h('code', { class: 'code' });
  const link = () => inviteLink(withPin);
  const paint = () => { code.textContent = link(); };
  paint();
  openSheet(h('div', null, h('h2', null, 'Conectar otro dispositivo'),
    h('p', { class: 'lead' }, 'Abre este enlace en el otro móvil, tableta u ordenador. Después solo hay que escribir el PIN.'), code,
    h('label', { class: 'field' }, h('input', { type: 'checkbox', onchange: (e) => { withPin = e.target.checked; paint(); } }), 'Incluir el PIN, para entrar sin escribirlo'),
    h('div', { class: 'sheet-actions' }, h('button', { class: 'btn btn-go', type: 'button', onclick: async () => {
      try { if (navigator.share) await navigator.share({ title: 'Taller IA', url: link() }); else { await navigator.clipboard.writeText(link()); toast('Enlace copiado'); } } catch { /* cancelado */ }
    } }, icon('share'), navigator.share ? 'Enviar el enlace' : 'Copiar el enlace'))));
}

// ------------------------------------------------------------------ avisos con la app cerrada (Web Push)
// La cola guarda la suscripción de este dispositivo con los casos que le importan (los que ha enviado o abierto) y
// el trabajador, al responder, manda un aviso con el coche y la hipótesis (worker/push.py). En el iPhone solo
// existe con la app instalada en la pantalla de inicio, desde iOS 16.4, y el permiso se pide tras un toque.
const pushOk = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window && window.isSecureContext;
function b64uBytes(s) { const b = atob(String(s).replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((String(s).length + 3) % 4)); return Uint8Array.from(b, (c) => c.charCodeAt(0)); }
async function swReg() {
  if (!('serviceWorker' in navigator)) return null;
  const r = await navigator.serviceWorker.getRegistration().catch(() => null);
  if (!r) return null;
  return Promise.race([navigator.serviceWorker.ready, new Promise((ok) => setTimeout(() => ok(null), 5000))]);
}
async function vapidKey(fresh) {
  if (!fresh && ls.get('vapid', '')) return ls.get('vapid', '');
  try { const d = await api.suscribir(); if (d && d.vapid) { ls.set('vapid', d.vapid); return d.vapid; } } catch { /* sin conexión */ }
  return ls.get('vapid', '');
}
function pushCasos() {
  const mine = ls.get('pushMine', {});
  if (S.current) mine[S.current] = Math.max(mine[S.current] || 0, Date.now() - 1);
  const old = Date.now() - 60 * 864e5;
  return Object.keys(mine).filter((k) => mine[k] > old).sort((a, b) => mine[b] - mine[a]).slice(0, 60);
}
function pushMark(caso) { const mine = ls.get('pushMine', {}); mine[caso] = Date.now(); ls.set('pushMine', mine); }
async function pushSend(sub, force) {
  const casos = pushCasos(), firma = sub.endpoint + '|' + casos.join(','), last = ls.get('pushSent', {});
  if (!force && last.firma === firma && Date.now() - (last.at || 0) < 7 * 864e5) return true;
  const d = await api.suscribir({ sub: sub.toJSON(), casos, app: location.origin + location.pathname });
  if (!d || !d.ok) throw new Error((d && d.error) || 'suscribir');
  ls.set('pushSent', { firma, at: Date.now() });
  return true;
}
function pushHelp() {
  const ios = isIOS && !standalone();
  openSheet(h('div', null, h('h2', null, 'Avisos con la app cerrada'),
    h('p', { class: 'lead' }, ios ? 'En el iPhone y el iPad solo funcionan con la app instalada en la pantalla de inicio, con iOS 16.4 o posterior.'
      : isIOS ? 'Este iPhone no los admite: hace falta iOS 16.4 o posterior.' : 'Este navegador no admite avisos con la app cerrada. En Android, usa Chrome.'),
    ios ? h('ol', { class: 'steps' }, h('li', null, 'Instala la app: ··· › Compartir › «Añadir a pantalla de inicio».'), h('li', null, 'Ábrela desde el icono.'), h('li', null, 'En Ajustes, activa «Avísame aunque cierre la app» y pulsa Permitir.')) : null,
    ios ? h('div', { class: 'sheet-actions' }, h('button', { class: 'btn btn-go', type: 'button', onclick: () => { closeSheet(); setTimeout(install, 350); } }, icon('phone'), 'Cómo instalarla')) : null));
}
// Activar: SIEMPRE tras un toque (el permiso lo exige). Primero el permiso, luego la suscripción, luego la cola.
async function pushOn() {
  if (!pushOk()) { pushHelp(); return false; }
  let perm = Notification.permission;
  if (perm === 'default') { try { perm = await Notification.requestPermission(); } catch { perm = 'denied'; } }
  if (perm !== 'granted') { toast('Los avisos están bloqueados. ' + permHelp('Notificaciones'), { ms: 10000 }); renderChat(); return false; }
  try {
    const reg = await swReg();
    if (!reg || !reg.pushManager) throw new Error('sin service worker');
    const key = await vapidKey(true);
    if (!key) { toast('La cola aún no tiene la clave de los avisos. Avisa a Ed.', { ms: 8000 }); return false; }
    let sub = await reg.pushManager.getSubscription();
    if (sub && ls.get('pushKey', '') && ls.get('pushKey', '') !== key) { await sub.unsubscribe().catch(() => {}); sub = null; }   // Ed cambió las claves
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uBytes(key) });
    await pushSend(sub, true);
    ls.set('push', true); ls.set('pushKey', key);
    S.notify = true; ls.set('notify', true);
    toast('Hecho. Te aviso aunque cierres la app.');
    renderChat();
    return true;
  } catch (e) {
    toast(e instanceof PinError ? 'El PIN ha cambiado.' : 'No he podido activar los avisos. Prueba otra vez con conexión.', { ms: 7000 });
    return false;
  }
}
async function pushOff() {
  ls.set('push', false); ls.del('pushSent');
  try {
    const reg = await swReg(), sub = reg && reg.pushManager && await reg.pushManager.getSubscription();
    if (sub) { const endpoint = sub.endpoint; await sub.unsubscribe().catch(() => {}); await api.suscribir({ sub: { endpoint }, baja: true }).catch(() => {}); }
  } catch { /* nada */ }
  toast('Avisos con la app cerrada desactivados');
}
// Renovación: al abrir la app y tras cada envío. Si el navegador cambió la suscripción, o hay casos nuevos, o
// hace una semana que no se renueva, se vuelve a mandar a la cola. Sin toques: el permiso ya está dado.
let pushT = null;
function pushRefresh(force) {
  clearTimeout(pushT);
  pushT = setTimeout(async () => {
    if (!ls.get('push', false) || !pushOk() || !ready()) return;
    if (Notification.permission !== 'granted') { ls.set('push', false); return; }       // lo quitaron en los ajustes del sistema
    try {
      const reg = await swReg();
      if (!reg || !reg.pushManager) return;
      const key = await vapidKey();
      let sub = await reg.pushManager.getSubscription();
      if (!sub && key) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uBytes(key) });
      if (sub) await pushSend(sub, force);
    } catch { /* se reintenta en la próxima */ }
  }, 800);
}

// ------------------------------------------------------------------ PIN y conexión
let pinBuf = '';
function drawDots() {
  $('dots').replaceChildren(...Array.from({ length: Math.max(PIN_LEN, pinBuf.length) }, (_, i) => h('i', { class: i < pinBuf.length ? 'on' : null })));
}
function lock(msg) {
  tts.stop();
  $('lock').hidden = false; $('lockPin').hidden = false; $('lockSetup').hidden = true;
  $('lock').classList.toggle('bad', !!msg);
  $('lockMsg').textContent = msg || 'Escribe el PIN del taller';
  pinBuf = ''; drawDots();
}
function showSetup() {
  $('lock').hidden = false; $('lockPin').hidden = true; $('lockSetup').hidden = false;
  $('lockMsg').textContent = isIOS && standalone() ? 'Pulsa el botón amarillo y luego «Pegar».' : 'Falta conectar esta app con el taller. Copia el enlace que te han mandado y pulsa el botón amarillo.';
  $('invitePaste').hidden = !(navigator.clipboard && navigator.clipboard.readText);
}
async function tryPin() {
  if (pinBuf.length < 4 || $('lock').classList.contains('busy')) return;
  $('lock').classList.add('busy');
  S.pin = pinBuf;
  try {
    await api.poll('ping');
    ls.set('pin', S.pin);
    $('lock').hidden = true;
    if (started) { refresh().then(schedule); pump(); syncCases(); } else start();
  } catch (e) {
    S.pin = '';
    $('lock').classList.add('bad');
    $('lockMsg').textContent = e instanceof PinError ? 'Ese PIN no es. Prueba otra vez.' : 'No hay conexión con el taller. Prueba otra vez.';
    if (e instanceof PinError) { pinBuf = ''; drawDots(); }
    buzz(120);
  } finally { $('lock').classList.remove('busy'); }
}
function pinKey(k) {
  if ($('lock').hidden || $('lockPin').hidden || $('lock').classList.contains('busy')) return;
  $('lock').classList.remove('bad');
  if (k === 'ok') { tryPin(); return; }
  if (k === 'del') pinBuf = pinBuf.slice(0, -1);
  else if (pinBuf.length < 8) pinBuf += k;
  drawDots();
  if (k !== 'del' && pinBuf.length === PIN_LEN) tryPin();
}

// ------------------------------------------------------------------ arranque
let started = false, touched = false;
function renderAll(toBottom) { renderHeader(); renderCars(); renderChat(toBottom); renderTray(); }

async function takeShared() {
  if (!QS.has('share') || !('caches' in window)) return;
  try { history.replaceState(history.state, '', location.pathname); } catch { /* nada */ }
  try {
    const cache = await caches.open('taller-share'), files = [];
    for (const k of await cache.keys()) {
      const r = await cache.match(k);
      if (r && k.url.endsWith('/text')) S.extraText = [S.extraText, (await r.text()).trim()].filter(Boolean).join('\n').slice(0, 4000);
      else if (r) { const b = await r.blob(); files.push(new File([b], decodeURIComponent(r.headers.get('X-Name') || 'adjunto'), { type: b.type })); }
      await cache.delete(k);
    }
    await addFiles(files);
    renderTray();
  } catch { /* nada compartido */ }
}

// Abrir un caso concreto (desde un aviso push o un enlace «?caso=»): si este dispositivo no lo conoce, se apunta y
// la cola lo rellena al consultarlo.
const CASO_RE = /^[\w.-]{1,100}$/;
function adoptCase(id) {
  if (!CASO_RE.test(String(id || ''))) return null;
  let c = S.cases.find((x) => x.id === id);
  if (!c) { c = { id, vehicle: 'Coche sin nombre', ts: Date.now(), remote: true, src: 'app', seen: 0 }; S.cases.push(c); delete S.hidden[id]; ls.set('hidden', S.hidden); }
  return c;
}
async function start() {
  S.cases = S.cases.filter((c) => c.id === S.current || !isEmpty(c));   // «Coche N» vacíos que dejó la versión anterior
  const want = QS.get('caso');
  if (want && adoptCase(want)) { S.current = want; try { history.replaceState(history.state, '', location.pathname + (DEMO ? '?demo=' + (QS.get('demo') || '1') : '')); } catch { /* nada */ } }
  if (!S.cases.length) newCase();
  if (!cur()) S.current = S.cases.slice().sort((a, b) => actOf(b) - actOf(a))[0].id;
  if (QS.has('nuevo')) newCase();
  // En WebKit el almacenamiento es «de mejor esfuerzo» y desalojable; aquí vive la cola de envío y las notas de voz.
  // Instalada (o en un móvil) se pide que sea persistente; en un ordenador Firefox lo preguntaría y no hace falta.
  if (navigator.storage && navigator.storage.persist && (standalone() || touch())) navigator.storage.persisted().then((p) => p || navigator.storage.persist()).catch(() => {});
  const stored = await idb.all('outbox').catch(() => []);
  S.outbox = stored.sort((a, b) => a.ts - b.ts).map((o) => { if (o.status !== 'failed') { if (o.status === 'sending' || o.status === 'waiting') o.tries = (o.tries || 0) + 1; o.status = 'queued'; } return o; });
  await loadCase();
  const old = Date.now() - 120 * 864e5;                             // las miniaturas de hace meses ya no hacen falta
  S.media.forEach((m, k) => { if (m.ts < old) { S.media.delete(k); idb.del('media', k).catch(() => {}); } });
  started = true;
  renderAll(true);
  refresh().then(() => { refreshOthers(); schedule(); syncCases(); pushRefresh(); });
  pump();
  takeShared();
}

function bind() {
  $('carBtn').onclick = openCars;
  $('menuBtn').onclick = openMenu;
  $('voiceBtn').onclick = () => {
    S.voice = !S.voice; ls.set('voice', S.voice);
    $('voiceBtn').setAttribute('aria-pressed', String(S.voice)); setIcon($('voiceBtn'), S.voice ? 'vol' : 'mute');
    if (!S.voice) { tts.stop(); speakLater = null; }
    toast(S.voice ? 'Leeré las respuestas en voz alta' : 'Respuestas en silencio: no leeré nada hasta que lo vuelvas a activar');
  };
  $('replay').onclick = () => {
    const id = $('replay').dataset.id, m = S.messages.find((x) => x.id === id);
    if (!m) return;
    tts.unlock(); stopNote();
    if (tts.cur === id) tts.stop(); else tts.speak(id, sayOf(m.respuesta));
  };
  $('newsGo').onclick = () => { const id = newsFor; hideNews(); if (id) selectCase(id, true); };
  $('newsX').onclick = () => hideNews();
  // Interacción en la zona de trabajo: el escritorio ya no cambia de coche por su cuenta (ver syncCases)
  const markTouched = () => { touched = true; };
  $('app').addEventListener('pointerdown', markTouched, true);
  $('app').addEventListener('keydown', markTouched, true);
  $('photoBtn').onclick = () => openCam('photo');
  $('videoBtn').onclick = () => openCam('video');
  $('galleryBtn').onclick = () => $('pick').click();
  $('typeBtn').onclick = () => setMode('text', true);
  $('backVoice').onclick = () => setMode('voice');
  ['pick', 'capPhoto', 'capVideo'].forEach((id) => { $(id).onchange = (e) => { const fl = Array.from(e.target.files || []); e.target.value = ''; if (fl.length) { if (camOpen) closeCam(); addFiles(fl); } }; });
  $('traySend').onclick = sendTyped;
  $('sendTxt').onclick = sendTyped;
  $('txt').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendTyped(); } });
  $('txt').addEventListener('input', (e) => { const t = e.target; t.style.height = 'auto'; t.style.height = Math.min(148, t.scrollHeight) + 'px'; });

  // Botón de hablar: un toque empieza y otro envía; o se mantiene pulsado y se suelta para enviar.
  const ptt = $('ptt');
  ptt.addEventListener('pointerdown', (e) => {
    if (e.button) return;
    e.preventDefault();
    try { ptt.setPointerCapture(e.pointerId); } catch { /* nada */ }
    pressed = true; downAt = performance.now(); downXY = [e.clientX, e.clientY];
    pressOwns = recState === 'idle';
    ptt.classList.add('down');
    if (pressOwns) recStart();
  });
  ptt.addEventListener('pointerup', (e) => {
    if (!pressed) return;
    pressed = false; ptt.classList.remove('down');
    const held = performance.now() - downAt, far = Math.hypot(e.clientX - downXY[0], e.clientY - downXY[1]) > 90;
    if (!pressOwns) { if (recState === 'on') recStop(); }
    else if (held > 650 && recState === 'on') { if (far) recCancel(); else recStop(); }
  });
  ptt.addEventListener('pointercancel', () => { pressed = false; ptt.classList.remove('down'); });
  ptt.addEventListener('contextmenu', (e) => e.preventDefault());
  ptt.addEventListener('keydown', (e) => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); if (recState === 'idle') recStart(); else if (recState === 'on') recStop(); } });
  $('recCancel').onclick = recCancel;

  // La X con el micro en marcha descarta la explicación y se queda en la cámara; otra vez, cierra
  $('camClose').onclick = () => { if (camRecState !== 'idle') camMicCancel(); else closeCam(); };
  const cm = $('camMic');
  cm.addEventListener('pointerdown', (e) => {
    if (e.button) return;
    e.preventDefault();
    try { cm.setPointerCapture(e.pointerId); } catch { /* nada */ }
    camPressed = true; camDownAt = performance.now(); camDownXY = [e.clientX, e.clientY];
    camPressOwns = camRecState === 'idle';
    cm.classList.add('down');
    if (camPressOwns) camMicStart();
  });
  cm.addEventListener('pointerup', (e) => {
    if (!camPressed) return;
    camPressed = false; cm.classList.remove('down');
    const held = performance.now() - camDownAt, far = Math.hypot(e.clientX - camDownXY[0], e.clientY - camDownXY[1]) > 90;
    if (!camPressOwns) { if (camRecState === 'on') camMicStop(); }
    else if (held > 650 && camRecState === 'on') { if (far) camMicCancel(); else camMicStop(); }
  });
  cm.addEventListener('pointercancel', () => { camPressed = false; cm.classList.remove('down'); });
  cm.addEventListener('contextmenu', (e) => e.preventDefault());
  cm.addEventListener('keydown', (e) => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); if (camRecState === 'idle') camMicStart(); else if (camRecState === 'on') camMicStop(); } });
  // «Listo» con el micro en marcha termina la explicación y lo envía todo (nunca la tira)
  const camFinish = () => { if (camRecState === 'on') camMicStop(); else if (camRecState === 'idle') closeCam(); };
  $('camDone').onclick = camFinish;
  $('camStack').onclick = camFinish;
  $('shutter').onclick = () => (camMode === 'photo' ? snap() : toggleVideo());
  $('camModes').onclick = (e) => { const b = e.target.closest('button'); if (b && !camera.recording && camRecState === 'idle') setCamMode(b.dataset.mode); };
  $('camFlip').onclick = async () => { try { await camera.flip(); $('cam').classList.toggle('mirror', !!camera.mirrored); $('camTorch').hidden = !camera.hasTorch; } catch { toast('No hay otra cámara.'); camStart(); } };
  $('camTorch').onclick = async () => { const on = $('camTorch').getAttribute('aria-pressed') !== 'true'; if (await camera.torch(on)) $('camTorch').setAttribute('aria-pressed', String(on)); };
  $('camNative').onclick = () => { nativeCapture(camMode); };
  $('camRetry').onclick = camStart;

  $('sheetX').onclick = closeSheet;
  $('sheetWrap').addEventListener('click', (e) => { if (e.target === $('sheetWrap')) closeSheet(); });
  $('lightbox').onclick = () => popOverlay();

  // teclado del PIN
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'ok', '0', 'del'];
  $('pad').replaceChildren(...keys.map((k) => h('button', { class: 'key' + (k === 'ok' ? ' sm ok' : k === 'del' ? ' sm' : ''), type: 'button', 'aria-label': k === 'del' ? 'Borrar' : k === 'ok' ? 'Entrar' : k, onclick: () => pinKey(k) }, k === 'del' ? icon('back') : k === 'ok' ? 'Entrar' : k)));
  $('lockSetup').addEventListener('submit', (e) => {
    e.preventDefault();
    const inv = parseInvite($('inviteInput').value);
    if (!inv) { $('lockMsg').textContent = 'Ese enlace no vale. Cópialo entero, tal como te lo mandaron.'; return; }
    S.queue = inv.q; ls.set('queue', inv.q);
    lock();
    ls.set('pinLink', !!inv.pin);
    if (inv.pin) { pinBuf = inv.pin; drawDots(); tryPin(); }
  });

  // En el iPhone, la app instalada no comparte datos con Safari: se conecta pegando el enlace copiado
  $('invitePaste').onclick = async () => {
    try { $('inviteInput').value = (await navigator.clipboard.readText()).trim(); $('lockSetup').dispatchEvent(new Event('submit', { cancelable: true })); }
    catch { $('lockMsg').textContent = 'No he podido leer lo copiado. Pega el enlace en la casilla y pulsa Conectar.'; }
  };

  document.addEventListener('keydown', (e) => {
    if (!$('lock').hidden && !$('lockPin').hidden) {
      if (/^\d$/.test(e.key)) pinKey(e.key); else if (e.key === 'Backspace') pinKey('del'); else if (e.key === 'Enter') pinKey('ok');
      return;
    }
    if (e.key === 'Escape' && overlays.length) popOverlay();
  });
  document.addEventListener('pointerdown', () => { tts.unlock(); audioCtx(); }, { capture: true, once: true });
  document.addEventListener('paste', (e) => { const fl = Array.from((e.clipboardData && e.clipboardData.files) || []); if (fl.length && $('lock').hidden) { e.preventDefault(); addFiles(fl); } });
  const chat = $('chat');
  chat.addEventListener('dragover', (e) => { e.preventDefault(); chat.classList.add('drop'); });
  chat.addEventListener('dragleave', () => chat.classList.remove('drop'));
  chat.addEventListener('drop', (e) => { e.preventDefault(); chat.classList.remove('drop'); if (e.dataTransfer && e.dataTransfer.files.length) addFiles(e.dataTransfer.files); });

  const net = () => { $('net').hidden = navigator.onLine !== false; if (navigator.onLine !== false && started) { wakeOutbox(); refresh().then(schedule); syncCases(); } };
  window.addEventListener('online', net); window.addEventListener('offline', net); net();
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    if (started && ready()) syncCases();
    if (started && ready()) refresh().then(() => { schedule(); flushSpeak(); });
  });
  if (window.visualViewport) {
    const fit = () => { document.documentElement.style.setProperty('--app-h', visualViewport.height + 'px'); if (document.activeElement === $('txt')) window.scrollTo(0, 0); };
    visualViewport.addEventListener('resize', fit); fit();
  }
}

function boot() {
  S.queue = queueUrlFrom(ls.get('queue', '')) || queueUrlFrom(CFG.queueUrl);
  S.pin = DEMO ? 'demo' : ls.get('pin', '');
  S.cases = ls.get('cases', []); S.current = ls.get('current', null);
  S.voice = ls.get('voice', true); S.notify = ls.get('notify', false);
  S.watch = ls.get('watch', {}); S.flight = ls.get('flight', {}); S.hidden = ls.get('hidden', {}); S.resent = ls.get('resent', {});
  bind();
  $('voiceBtn').setAttribute('aria-pressed', String(S.voice)); setIcon($('voiceBtn'), S.voice ? 'vol' : 'mute');
  setMode(!touch() && ls.get('mode', 'voice') === 'text' ? 'text' : 'voice');
  refreshHint();

  const inv = location.hash.length > 3 ? parseInvite(location.href) : null;
  if (location.hash) { try { history.replaceState(null, '', location.pathname + location.search); } catch { /* nada */ } }
  if (inv && !DEMO && (!S.queue || S.queue === inv.q || confirm('Este enlace conecta la app con otra cola de taller. ¿Cambiar la conexión?'))) {
    S.queue = inv.q; ls.set('queue', inv.q);
    ls.set('pinLink', !!inv.pin);                                   // al instalar en el iPhone se copia igual que llegó
    if (inv.pin) { S.pin = inv.pin; ls.set('pin', inv.pin); }
  }

  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol) && (!/^(localhost|127\.)/.test(location.hostname) || QS.has('sw'))) {
    const had = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register('sw.js').catch(() => {});
    navigator.serviceWorker.addEventListener('message', (e) => {
      const d = e.data || {};
      if (d.tipo === 'abrir' && CASO_RE.test(String(d.caso || '')) && started) { adoptCase(d.caso); saveCases(); selectCase(d.caso, true); }
      else if (d.tipo === 'push' && started && ready()) { refresh().then(schedule); syncCases(); }
    });
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (had) toast('Hay una versión nueva de Taller IA.', { action: 'Actualizar', onAction: () => location.reload(), ms: 20000 }); });
  }

  if (DEMO && !QS.has('lock')) start();
  else if (!DEMO && !S.queue) showSetup();
  else if (!S.pin || QS.has('lock')) lock();
  else start();
}

boot();

// Para las pruebas automáticas
window.__taller = { S, send, addFiles, VERSION, syncCases, trocear,
  wake: () => ({ held: !!wake, lastMove, stale: Date.now() - lastMove > WAKE_MAX }), envejecer: (ms) => { lastMove -= ms; schedule(); },
  pendiente: () => speakLater };
