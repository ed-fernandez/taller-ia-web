// Captura de voz, foto y vídeo en el navegador, y preparación de los archivos para el taller IA.

const md = () => navigator.mediaDevices;
export const canRecord = () => !!(md() && md().getUserMedia && window.MediaRecorder);
export const canCamera = () => !!(md() && md().getUserMedia);

function pickMime(list) {
  if (!window.MediaRecorder || !MediaRecorder.isTypeSupported) return '';
  return list.find((m) => MediaRecorder.isTypeSupported(m)) || '';
}
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error('tiempo')), ms))]);

// ------------------------------------------------------------------ nota de voz
// Sin cancelación de eco ni supresión de ruido: en un taller el «ruido» (un silbido, un
// golpeteo) suele ser justo lo que hay que oír, y whisper transcribe bien aunque haya fondo.
const VOICE = { echoCancellation: false, noiseSuppression: false, autoGainControl: true, channelCount: 1 };
const RAW = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
const AUDIO_MIMES = ['audio/webm;codecs=opus', 'audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/webm'];

export class VoiceRecorder {
  async start() {
    this.stream = await md().getUserMedia({ audio: VOICE });
    const mime = pickMime(AUDIO_MIMES);
    this.rec = new MediaRecorder(this.stream, mime ? { mimeType: mime, audioBitsPerSecond: 64000 } : undefined);
    this.chunks = [];
    this.rec.ondataavailable = (e) => { if (e.data && e.data.size) this.chunks.push(e.data); };
    this.rec.start();
    this.t0 = performance.now();
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ac = new AC();
      this.an = this.ac.createAnalyser();
      this.an.fftSize = 512;
      this.ac.createMediaStreamSource(this.stream).connect(this.an);
      this.buf = new Uint8Array(this.an.fftSize);
    } catch { this.an = null; }
  }

  // Nivel de 0 a 1 para dibujar el halo y la onda
  level() {
    if (!this.an) return 0;
    this.an.getByteTimeDomainData(this.buf);
    let sum = 0;
    for (let i = 0; i < this.buf.length; i++) { const v = (this.buf[i] - 128) / 128; sum += v * v; }
    return Math.min(1, Math.sqrt(sum / this.buf.length) * 3.2);
  }

  elapsed() { return performance.now() - this.t0; }

  stop() {
    return new Promise((resolve) => {
      const ms = this.elapsed();
      const done = () => {
        const mime = (this.rec.mimeType || 'audio/webm').split(';')[0];
        const blob = new Blob(this.chunks, { type: mime });
        this.release();
        resolve({ blob, ms, mime });
      };
      this.rec.onstop = done;
      try { this.rec.stop(); } catch { done(); }
    });
  }

  cancel() {
    try { this.rec.onstop = null; this.rec.stop(); } catch { /* ya parado */ }
    this.release();
  }

  release() {
    try { this.stream.getTracks().forEach((t) => t.stop()); } catch { /* nada */ }
    try { this.ac && this.ac.close(); } catch { /* nada */ }
    this.an = null;
  }
}

// ------------------------------------------------------------------ imágenes
function toBlob(canvas, type, q) { return new Promise((r) => canvas.toBlob(r, type, q)); }
function drawTo(src, w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  c.getContext('2d').drawImage(src, 0, 0, w, h);
  return c;
}
function loadImg(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('imagen')); };
    img.src = url;
  });
}

// Reduce la foto a un tamaño que Claude aprovecha entero (no ve más de ~1600 px) y que sube rápido.
export async function processImage(file, maxEdge = 2048, quality = 0.86, forceJpeg = false) {
  let src;
  try { src = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch { src = await loadImg(file); }
  const w0 = src.width || src.naturalWidth, h0 = src.height || src.naturalHeight;
  const s = Math.min(1, maxEdge / Math.max(w0, h0));
  const w = Math.max(1, Math.round(w0 * s)), h = Math.max(1, Math.round(h0 * s));
  let blob, mime = 'image/jpeg';
  if (!forceJpeg && file.type === 'image/png' && s === 1 && file.size < 1.5e6) { blob = file; mime = 'image/png'; }   // capturas de pantalla: texto nítido
  else blob = await toBlob(drawTo(src, w, h), 'image/jpeg', quality);
  const ps = Math.min(1, 640 / Math.max(w0, h0));
  const preview = drawTo(src, Math.max(1, Math.round(w0 * ps)), Math.max(1, Math.round(h0 * ps))).toDataURL('image/jpeg', 0.72);
  if (src.close) src.close();
  if (!blob) throw new Error('imagen');
  return { blob, mime, preview, w, h };
}

// Carátula y duración de un vídeo elegido de la galería (si el navegador sabe abrirlo)
export function videoInfo(blob) {
  return new Promise((resolve) => {
    const v = document.createElement('video');
    const url = URL.createObjectURL(blob);
    let done = false;
    const fin = (r) => { if (done) return; done = true; try { v.removeAttribute('src'); v.load(); } catch { /* nada */ } URL.revokeObjectURL(url); resolve(r); };
    v.muted = true; v.playsInline = true; v.preload = 'auto';
    v.onloadedmetadata = () => { try { v.currentTime = Math.min(0.3, (v.duration || 1) / 2); } catch { /* nada */ } };
    v.onseeked = v.onloadeddata = () => {
      if (!v.videoWidth) return;
      try {
        const s = Math.min(1, 640 / Math.max(v.videoWidth, v.videoHeight));
        const poster = drawTo(v, Math.round(v.videoWidth * s), Math.round(v.videoHeight * s)).toDataURL('image/jpeg', 0.7);
        fin({ poster, dur: isFinite(v.duration) ? v.duration : 0 });
      } catch { fin(null); }
    };
    v.onerror = () => fin(null);
    setTimeout(() => fin(null), 4000);
    v.src = url;
    const p = v.play(); if (p && p.catch) p.catch(() => {});
  });
}

// ------------------------------------------------------------------ duración en WebM
// El trabajador reparte los fotogramas según la duración que lee ffprobe. El Chrome actual ya la
// escribe al cerrar la grabación, pero otros navegadores graban WebM «en directo», sin duración:
// en ese caso se la añadimos a la cabecera (elemento Duration dentro de Segment › Info).
function vint(buf, pos, isId) {
  const first = buf[pos];
  if (first === undefined || first === 0) return null;
  let len = 1, mask = 0x80;
  while (!(first & mask)) { mask >>= 1; len++; }
  if (pos + len > buf.length) return null;
  let value = isId ? first : first & (mask - 1), ones = (first & (mask - 1)) === mask - 1;
  for (let i = 1; i < len; i++) { value = value * 256 + buf[pos + i]; if (buf[pos + i] !== 0xFF) ones = false; }
  return { value, len, unknown: !isId && ones };
}
function encodeSize(value, len) {
  if (value >= Math.pow(2, 7 * len) - 1) return null;
  const out = new Uint8Array(len);
  for (let i = len - 1; i >= 0; i--) { out[i] = value % 256; value = Math.floor(value / 256); }
  out[0] |= 1 << (8 - len);
  return out;
}

export async function fixWebmDuration(blob, ms) {
  try {
    const head = new Uint8Array(await blob.slice(0, 65536).arrayBuffer());
    let p = 0;
    let id = vint(head, p, true);
    if (!id || id.value !== 0x1A45DFA3) return blob;                 // EBML
    let sz = vint(head, p + id.len, false);
    p += id.len + sz.len + sz.value;
    id = vint(head, p, true);
    if (!id || id.value !== 0x18538067) return blob;                 // Segment
    const segSizeAt = p + id.len;
    const seg = vint(head, segSizeAt, false);
    p = segSizeAt + seg.len;
    while (p < head.length - 12) {
      const cid = vint(head, p, true);
      const csz = cid && vint(head, p + cid.len, false);
      if (!cid || !csz) return blob;
      const start = p + cid.len + csz.len;
      if (cid.value === 0x1549A966) {                                // Info
        if (csz.unknown) return blob;
        const end = start + csz.value;
        if (end > head.length) return blob;
        let q = start, scale = 1000000;
        while (q < end) {
          const eid = vint(head, q, true);
          const esz = eid && vint(head, q + eid.len, false);
          if (!eid || !esz) return blob;
          const at = q + eid.len + esz.len;
          if (eid.value === 0x4489) return blob;                     // ya trae duración
          if (eid.value === 0x2AD7B1) { scale = 0; for (let i = 0; i < esz.value; i++) scale = scale * 256 + head[at + i]; }
          q = at + esz.value;
        }
        const dur = new Uint8Array(11);
        dur.set([0x44, 0x89, 0x88]);
        new DataView(dur.buffer).setFloat64(3, (ms * 1e6) / (scale || 1000000));
        const newSize = encodeSize(csz.value + dur.length, csz.len);
        if (!newSize) return blob;
        const pre = head.slice(0, p + cid.len);
        if (!seg.unknown) {
          const segNew = encodeSize(seg.value + dur.length, seg.len);
          if (!segNew) return blob;
          pre.set(segNew, segSizeAt);
        }
        return new Blob([pre, newSize, head.slice(start, end), dur, blob.slice(end)], { type: blob.type });
      }
      // Con índices (SeekHead, Cues) por delante o ya en los datos, mejor no tocar
      if (cid.value === 0x114D9B74 || cid.value === 0x1C53BB6B || cid.value === 0x1F43B675 || csz.unknown) return blob;
      p = start + csz.value;
    }
  } catch { /* se envía tal cual */ }
  return blob;
}

// ------------------------------------------------------------------ cámara
// Preferimos WebM (podemos fijarle la duración) con H.264 si el móvil lo codifica por hardware.
const VIDEO_MIMES = ['video/webm;codecs=h264,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4'];

export class Camera {
  constructor(video) { this.video = video; this.facing = 'environment'; this.stream = null; this.rec = null; }

  async open() {
    this.close();
    this.stream = await md().getUserMedia({ audio: false, video: { facingMode: { ideal: this.facing }, width: { ideal: 1920 }, height: { ideal: 1080 } } });
    this.track = this.stream.getVideoTracks()[0];
    this.video.srcObject = this.stream;
    try { await this.video.play(); } catch { /* autoplay ya lo arranca */ }
    let caps = {};
    try { caps = this.track.getCapabilities ? this.track.getCapabilities() : {}; } catch { /* nada */ }
    this.hasTorch = !!caps.torch;
    const st = this.track.getSettings ? this.track.getSettings() : {};
    this.mirrored = st.facingMode ? st.facingMode === 'user' : this.facing === 'user';
  }

  get live() { return !!(this.track && this.track.readyState === 'live'); }
  get recording() { return !!this.rec; }

  async torch(on) {
    try { await this.track.applyConstraints({ advanced: [{ torch: !!on }] }); return true; } catch { return false; }
  }

  async flip() { this.facing = this.facing === 'environment' ? 'user' : 'environment'; await this.open(); }

  frame(maxEdge) {
    const v = this.video, w0 = v.videoWidth, h0 = v.videoHeight;
    if (!w0) return null;
    const s = Math.min(1, maxEdge / Math.max(w0, h0));
    return drawTo(v, Math.round(w0 * s), Math.round(h0 * s));
  }

  // Foto a resolución completa del sensor si el navegador lo permite; si no, un fotograma.
  async photo() {
    if (window.ImageCapture) {
      try { const b = await withTimeout(new ImageCapture(this.track).takePhoto(), 3000); if (b && b.size) return b; } catch { /* fotograma */ }
    }
    const c = this.frame(4096);
    if (!c) throw new Error('cámara');
    return toBlob(c, 'image/jpeg', 0.92);
  }

  async startVideo() {
    const mime = pickMime(VIDEO_MIMES);
    if (!window.MediaRecorder) throw new Error('grabación');
    try { await this.track.applyConstraints({ width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } }); } catch { /* se graba como esté */ }
    this.silent = false;
    try { this.mic = await md().getUserMedia({ audio: RAW }); } catch { this.mic = null; this.silent = true; }
    const tracks = [this.track].concat(this.mic ? this.mic.getAudioTracks() : []);
    const opts = { videoBitsPerSecond: 2000000, audioBitsPerSecond: 96000 };
    if (mime) opts.mimeType = mime;
    const rec = new MediaRecorder(new MediaStream(tracks), opts);
    this.chunks = [];
    rec.ondataavailable = (e) => { if (e.data && e.data.size) this.chunks.push(e.data); };
    rec.start();
    this.rec = rec;
    this.t0 = performance.now();
  }

  elapsed() { return this.rec ? performance.now() - this.t0 : 0; }

  stopVideo() {
    return new Promise((resolve) => {
      const rec = this.rec, ms = this.elapsed();
      let poster = null;
      try { const c = this.frame(640); poster = c && c.toDataURL('image/jpeg', 0.7); } catch { /* sin carátula */ }
      const done = () => {
        const mime = (rec.mimeType || 'video/webm').split(';')[0];
        const blob = new Blob(this.chunks, { type: mime });
        this.rec = null; this.chunks = [];
        if (this.mic) { this.mic.getTracks().forEach((t) => t.stop()); this.mic = null; }
        if (this.live) this.track.applyConstraints({ width: { ideal: 1920 }, height: { ideal: 1080 } }).catch(() => {});
        resolve({ blob, ms, mime, poster, silent: this.silent });
      };
      rec.onstop = done;
      try { rec.stop(); } catch { done(); }
    });
  }

  close() {
    if (this.rec) { try { this.rec.onstop = null; this.rec.stop(); } catch { /* nada */ } this.rec = null; }
    if (this.mic) { this.mic.getTracks().forEach((t) => t.stop()); this.mic = null; }
    if (this.stream) { this.stream.getTracks().forEach((t) => t.stop()); this.stream = null; }
    this.track = null;
    try { this.video.srcObject = null; } catch { /* nada */ }
  }
}
