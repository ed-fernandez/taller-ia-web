// Conexión con la cola (Google Apps Script). Mismo contrato que la APK:
//   POST text/plain  { pin, op: 'submit' | 'poll' | 'doc' | 'casos' | 'suscribir', ... }
// y un servidor de demostración que simula el taller IA sin salir del navegador.

export class PinError extends Error { constructor() { super('PIN'); this.name = 'PinError'; } }
export class NetError extends Error { constructor(m) { super(m); this.name = 'NetError'; } }

const blobToB64 = (blob) => new Promise((resolve, reject) => {
  const fr = new FileReader();
  fr.onload = () => { const s = String(fr.result); resolve(s.slice(s.indexOf(',') + 1)); };
  fr.onerror = () => reject(fr.error || new Error('lectura'));
  fr.readAsDataURL(blob);
});

export function createBackend({ demo, url, pin }) {
  return demo ? demoBackend() : liveBackend(url, pin);
}

// ------------------------------------------------------------------ real
function liveBackend(getUrl, getPin) {
  async function call(body, timeoutMs) {
    const url = getUrl();
    if (!url) throw new Error('sin conexión configurada');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res;
    try {
      // text/plain evita la consulta previa de CORS, que Apps Script no contesta
      res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body, signal: ctrl.signal, redirect: 'follow', credentials: 'omit' });
    } catch (e) {
      throw new NetError(e && e.name === 'AbortError' ? 'ha tardado demasiado' : 'sin conexión');
    } finally { clearTimeout(timer); }
    let data;
    try { data = await res.json(); } catch { throw new NetError('respuesta ilegible'); }
    if (data.error === 'PIN') throw new PinError();
    if (data.error) throw new Error(String(data.error));
    return data;
  }
  const json = (o) => JSON.stringify(Object.assign({ pin: getPin() }, o));

  return {
    demo: false,
    poll(caso) { return call(json({ op: 'poll', caso }), 25000); },
    casos() { return call(json({ op: 'casos' }), 25000); },
    // Avisos push: sin `sub` devuelve la clave pública VAPID; con `sub` la guarda (o la quita con `baja`)
    suscribir(extra) { return call(json(Object.assign({ op: 'suscribir' }, extra || {})), 25000); },
    doc(id) { return call(json({ op: 'doc', id }), 180000); },
    async submit({ caso, vehiculo, texto, files }) {
      // El cuerpo se monta por trozos para no duplicar en memoria los adjuntos grandes
      const head = json({ op: 'submit', caso, vehiculo, texto });
      const parts = [head.slice(0, -1), ',"files":['];
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        parts.push((i ? ',' : '') + '{"name":' + JSON.stringify(f.name) + ',"mime":' + JSON.stringify(f.mime) + ',"b64":"', await blobToB64(f.blob), '"}');
      }
      parts.push(']}');
      const body = new Blob(parts, { type: 'text/plain;charset=utf-8' });
      return call(body, 300000);
    },
  };
}

// ------------------------------------------------------------------ demostración
const DEMO_STEPS = [
  [0, 4, 'El taller IA ha recogido tu consulta'],
  [2, 9, 'Transcribiendo la voz y analizando fotos y vídeos'],
  [5, 12, 'Buscando la documentación técnica del vehículo'],
  [8, 22, 'Buscando manuales y documentación: Ford Focus 1.0 EcoBoost coolant loss TSB'],
  [11, 34, 'Descargando documentación: tsb-ssm47587-1.0ecoboost-perdida-refrigerante.pdf'],
  [14, 46, 'Leyendo manual: tsb-ssm47587-1.0ecoboost-perdida-refrigerante.pdf'],
  [17, 58, 'Buscando casos en foros: 1.0 EcoBoost pierde refrigerante sin fuga'],
  [20, 70, 'Leyendo foro: www.pistonheads.com'],
  [23, 92, 'Redactando la respuesta'],
  [25, 96, 'Subiendo la documentación a tu biblioteca'],
];
const DEMO_TOTAL = 27;
// Clave pública VAPID de ejemplo (un punto P-256 válido; su privada no existe en ningún sitio)
const DEMO_VAPID = 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U';

const DEMO_ANSWERS = [
  {
    vehiculo: 'Ford Focus III 1.0 EcoBoost 125 CV (M1DA), 2016',
    vehiculo_slug: 'ford-focus-iii-1.0ecoboost-m1da',
    hipotesis_principal: 'Fuga interna de refrigerante a la cámara de combustión por una grieta en la culata, en la zona del colector de escape integrado, o por la junta de culata',
    confianza: 'media',
    respuesta_voz: 'Manolo, este 1.0 EcoBoost tiene un boletín de Ford justo para esto: pierde refrigerante, echa humo blanco y a veces va a tirones. Si no hay fuga por fuera, Ford manda mirar si hay grietas en la culata, en la zona del colector de escape integrado. Antes de abrir nada, haz la prueba de presión larga en frío y la de gases de combustión en el vaso de expansión. Por el P0128 no cambies el termostato todavía: primero comprueba el nivel.',
    pruebas: [
      'Prueba de gases de combustión en el vaso de expansión, con el motor caliente y dando gas, con líquido reactivo o analizador. Si da positivo, la causa es interna (culata o junta) y descarta una fuga externa que se evapora.',
      'Prueba de presión prolongada según el manual de taller de Ford, sección 303-03: presuriza el circuito y déjalo toda la noche en frío. Si la presión baja sin gotear, la fuga es interna. Por la mañana saca las bujías y mira con el boroscopio si un cilindro está húmedo o lavado.',
      'Inspección externa con el circuito presurizado y lámpara UV: vaso de expansión por debajo y su tapón, racores de refrigeración del turbo, carcasa del termostato y bomba de agua.',
      'P0128 con la diagnosis: graba en datos en vivo la temperatura del refrigerante desde frío, con el nivel correcto. Si se estanca o baja en circulación, apunta al termostato.',
    ],
    seguridad: 'No abras el vaso de expansión con el motor caliente. Si sospechas que entra líquido al cilindro, quita las bujías y gira el motor sin arrancarlo para evitar un golpe de ariete.',
    documentos: [
      { titulo: 'Ford SSM 47587: 1.0L EcoBoost, consumo de refrigerante, humo blanco o funcionamiento irregular', archivo: 'tsb-ssm47587-1.0ecoboost-perdida-refrigerante-iem.pdf', tipo: 'boletín técnico', por_que: 'Es el boletín oficial de Ford para este síntoma en este motor. Pide la prueba de presión prolongada de la sección 303-03.', drive_id: 'demo-doc-1', mb: 0.3 },
      { titulo: 'MC 10168739 0001', archivo: 'MC-10168739-0001.pdf', tipo: 'biblioteca', por_que: 'Disponible en la biblioteca de este vehículo', drive_id: 'demo-doc-2', mb: 1.2 },
    ],
    casos_foros: [
      { resumen: 'Focus 1.0 EcoBoost con pérdida de refrigerante sin fugas visibles. Se cambió dos veces el vaso de expansión y la pérdida siguió. Un test de gases de combustión dio positivo y Ford dictaminó cambio de motor.', url: 'https://www.pistonheads.com/gassing/topic.asp?h=0&f=66&t=1948509' },
      { resumen: 'Focus 1.0 EcoBoost de 2015 con consumo interno de refrigerante. La causa fue una culata agrietada.', url: 'https://www.youtube.com/watch?v=f9EpGF8fu9k' },
    ],
    respuesta_html: '<p><b>Hipótesis principal: fuga interna por la culata o el colector de escape integrado (55 %)</b></p><p><b>Lo que entiendo:</b> Focus III 1.0 EcoBoost de 2016 con 95.000 km. Pierde refrigerante sin fugas visibles, echa algo de humo blanco en frío y a veces salta el P0128.</p><table><tr><th>#</th><th>Hipótesis</th><th>%</th><th>A favor</th><th>En contra</th></tr><tr><td>1</td><td>Grieta en la culata o fallo de la junta de culata</td><td>55</td><td>Pierde sin fugas visibles y echa humo blanco en frío. Es el patrón del SSM 47587</td><td>El humo blanco en frío también puede ser condensación</td></tr><tr><td>2</td><td>Fuga externa que se evapora sobre piezas calientes</td><td>25</td><td>Muy habitual en racores del turbo y carcasa del termostato</td><td>No explica el humo blanco</td></tr><tr><td>3</td><td>Vaso de expansión agrietado o tapón defectuoso</td><td>12</td><td>Hay un caso documentado</td><td>Suele dejar rastro</td></tr><tr><td>4</td><td>Termostato abierto (P0128)</td><td>8</td><td>P0128 intermitente</td><td>El nivel bajo también lo provoca</td></tr></table><p><b>Qué hacer ahora:</b></p><ol><li><b>Prueba de gases de combustión</b> en el vaso de expansión. Unos 15 minutos.</li><li><b>Prueba de presión prolongada</b> según la sección 303-03 del manual.</li><li><b>Inspección externa</b> con lámpara UV.</li></ol>',
    fuentes: [
      { title: 'Ford SSM 47587 – 1.0L EcoBoost coolant consumption (PDF NHTSA)', url: 'https://static.nhtsa.gov/odi/tsbs/2018/MC-10148728-9999.pdf' },
      { title: 'PistonHeads – Focus 1.0 Ecoboost Coolant / Headgasket issue', url: 'https://www.pistonheads.com/gassing/topic.asp?h=0&f=66&t=1948509' },
    ],
  },
  {
    vehiculo: 'Ford Focus III 1.0 EcoBoost 125 CV (M1DA), 2016',
    vehiculo_slug: 'ford-focus-iii-1.0ecoboost-m1da',
    hipotesis_principal: 'Con el test de gases positivo, la fuga es interna: culata agrietada o junta de culata',
    confianza: 'alta',
    respuesta_voz: 'Pues ya lo tenemos acotado. Con el test de gases positivo la fuga es interna, así que deja de buscar por fuera. Saca las bujías, mira con el boroscopio cuál sale lavada y haz compresión y fugas en ese cilindro. Con eso sabrás si es junta o culata antes de dar presupuesto.',
    pruebas: [
      'Boroscopio por las bujías con el circuito presurizado en frío: busca el cilindro con la cabeza del pistón limpia o con gotas.',
      'Prueba de fugas de cilindro en el afectado: si burbujea el vaso de expansión, confirma el paso a refrigeración.',
    ],
    seguridad: 'No arranques el motor si ves líquido en un cilindro.',
    documentos: [],
    casos_foros: [],
    respuesta_html: '<p><b>Fuga interna confirmada.</b> Siguiente paso: localizar el cilindro y decidir entre junta y culata.</p>',
    fuentes: [],
  },
];

// Respuestas ya dadas de los casos de ejemplo (correo y otro dispositivo)
const DEMO_EXTRA = [
  { vehiculo: 'Peugeot 308 1.6 HDi 92 CV (9HP), 2012', hipotesis_principal: 'Calentadores gastados y relé de precalentamiento intermitente', confianza: 'media',
    respuesta_voz: 'Con humo blanco solo en frío y arranque perezoso, en este HDi lo primero son los calentadores: mide su resistencia y mira si el relé de precalentamiento entra.',
    pruebas: ['Resistencia de cada calentador en frío: por encima de 2 ohmios, cámbialo.', 'Con la diagnosis, activa el relé de precalentamiento y mide tensión en la barra.'], seguridad: '', documentos: [], casos_foros: [], respuesta_html: '<p>Calentadores y relé de precalentamiento.</p>', fuentes: [] },
  { vehiculo: 'Seat León III 1.6 TDI 110 CV (CXXB), 2015', hipotesis_principal: 'Válvula EGR agarrotada o con hollín (P0401)', confianza: 'media',
    respuesta_voz: 'El P0401 en este 1.6 TDI suele ser la EGR sucia. Haz la prueba de actuadores y mira el valor real frente al teórico antes de cambiar nada.',
    pruebas: ['Prueba de actuadores de la EGR con la diagnosis.', 'Compara caudal de aire teórico y real a 2.000 rpm.'], seguridad: '', documentos: [], casos_foros: [], respuesta_html: '<p>EGR agarrotada.</p>', fuentes: [] },
];

// Cada coche de la demostración es un vehículo distinto: el que se nombre en el texto (o en el nombre del coche)
// y, si no se nombra ninguno (las notas de voz no traen texto en la demostración), uno por turno: el primero, el Focus.
const ficha = (vehiculo, slug, hipotesis_principal, respuesta_voz, pruebas, seguridad, segunda) => ({
  re: null, base: { vehiculo, vehiculo_slug: slug, hipotesis_principal, confianza: 'media', respuesta_voz, pruebas, seguridad, documentos: [], casos_foros: [],
    respuesta_html: `<p><b>${hipotesis_principal}.</b></p><p>${respuesta_voz}</p>`, fuentes: [] },
  segunda: Object.assign({ vehiculo, vehiculo_slug: slug, confianza: 'alta', pruebas: [], seguridad: '', documentos: [], casos_foros: [], fuentes: [] }, segunda,
    { respuesta_html: `<p><b>${segunda.hipotesis_principal}.</b></p><p>${segunda.respuesta_voz}</p>` }),
});
const DEMO_COCHES = [
  { re: /focus|ecoboost|\bford\b/i, base: DEMO_ANSWERS[0], segunda: DEMO_ANSWERS[1] },
  Object.assign(ficha('Renault Clio IV 1.5 dCi 90 CV (K9K), 2017', 'renault-clio-iv-1.5dci-k9k', 'Inyector con retorno excesivo o fuga en la rampa (P0087)',
    'Este 1.5 dCi con el P0087 y tirones al acelerar suele ser un inyector que retorna demasiado. Haz la prueba de retorno de inyectores en frío y mira la presión de rampa real frente a la teórica antes de cambiar la bomba.',
    ['Prueba de retorno de los cuatro inyectores con probetas, a ralentí y a 2.500 rpm.', 'Datos en vivo: presión de rampa real frente a la consigna al acelerar a fondo.'], '',
    { hipotesis_principal: 'El inyector del cilindro 3 retorna el triple que los demás', respuesta_voz: 'Con ese retorno, el culpable es el inyector del tres. Cámbialo con su arandela y codifícalo con la diagnosis.' }), { re: /clio|renault|\bdci\b/i }),
  Object.assign(ficha('Volkswagen Golf VII 2.0 TDI 150 CV (CRBC), 2015', 'volkswagen-golf-vii-2.0tdi-crbc', 'Filtro de partículas saturado por regeneraciones interrumpidas',
    'En este 2.0 TDI, con el testigo del filtro y pérdida de potencia, mira la presión diferencial del filtro y la carga de hollín calculada. Si está por encima del límite, haz una regeneración en servicio.',
    ['Datos en vivo: presión diferencial del filtro a ralentí y a 2.500 rpm.', 'Carga de hollín calculada y kilómetros desde la última regeneración.'], 'La regeneración en servicio calienta mucho el escape: hazla en el exterior y lejos de materiales inflamables.',
    { hipotesis_principal: 'Regeneración completada; el sensor diferencial lee bien', respuesta_voz: 'Si tras la regeneración la presión diferencial ha bajado, el filtro está bien. Revisa por qué no regeneraba solo: trayectos cortos o el termostato.' }), { re: /golf|volkswagen|\bvw\b|\bdpf\b|filtro de part/i }),
  { re: /le[oó]n|\bseat\b|\btdi\b|p0401/i, base: DEMO_EXTRA[1], segunda: { vehiculo: DEMO_EXTRA[1].vehiculo, hipotesis_principal: 'EGR confirmada: el valor real no sigue al teórico', confianza: 'alta', respuesta_voz: 'Pues es la EGR. Límpiala o cámbiala y borra la adaptación con la diagnosis.', pruebas: [], seguridad: '', documentos: [], casos_foros: [], respuesta_html: '<p>EGR confirmada.</p>', fuentes: [] } },
  { re: /308|peugeot|\bhdi\b/i, base: DEMO_EXTRA[0], segunda: { vehiculo: DEMO_EXTRA[0].vehiculo, hipotesis_principal: 'Dos calentadores abiertos', confianza: 'alta', respuesta_voz: 'Cambia los dos calentadores abiertos y prueba el arranque en frío mañana.', pruebas: [], seguridad: '', documentos: [], casos_foros: [], respuesta_html: '<p>Calentadores.</p>', fuentes: [] } },
];
// Por turno, sin repetir el de los casos de ejemplo: Focus, Clio, Golf, Focus…
const TURNO = [0, 1, 2];

function tinyPdf(title) {
  const safe = String(title).normalize('NFD').replace(/[^\x20-\x7E]/g, '').replace(/[()\\]/g, ' ');
  const stream = `BT /F1 20 Tf 60 760 Td (${safe}) Tj 0 -30 Td /F1 12 Tf (Documento de demostracion de Taller IA) Tj ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offs = objs.map((o, i) => { const at = out.length; out += `${i + 1} 0 obj\n${o}\nendobj\n`; return at; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('');
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return btoa(out);
}

function demoBackend() {
  const KEY = 'taller.demo.server';
  const speed = /demo=fast/.test(location.search) ? 6 : 1;
  let db = {};
  try { db = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { db = {}; }
  // Casos que «ya estaban en la cola»: uno por correo y otro desde otro dispositivo, para ver la barra completa
  if (!db.__sembrado) {
    const hace = (min) => Date.now() - min * 60000, iso = (t) => new Date(t).toISOString();
    db['MAIL-demo-308'] = [{ id: 'd308a1', ts: iso(hace(26 * 60)), texto: 'Peugeot 308 1.6 HDi de 2012. Por las mañanas le cuesta arrancar y echa humo blanco hasta que coge temperatura.', files: [], estado: 'respondido', progreso: null, t0: hace(26 * 60),
      respuesta: Object.assign({}, DEMO_EXTRA[0], { _segundos: 212 }), vehiculo: 'Peugeot 308 no arranca en frío', origen: 'email', ts_respuesta: iso(hace(26 * 60 - 4)) }];
    db['APP-20261120-171204-k3'] = [{ id: 'd6b9c2', ts: iso(hace(95)), texto: 'Seat León 1.6 TDI, testigo de motor y P0401.', files: [], estado: 'respondido', progreso: null, t0: hace(95),
      respuesta: Object.assign({}, DEMO_EXTRA[1], { _segundos: 187 }), origen: 'app', ts_respuesta: iso(hace(91)) }];
    db.__sembrado = 1;
  }
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(db)); } catch { /* nada */ } };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  // Qué coche es: lo que diga el texto o el vehículo declarado; si no, uno por turno (y siempre el mismo para ese caso)
  db.__coche = db.__coche || {};
  function cocheDe(caso, list) {
    if (db.__coche[caso] != null) return DEMO_COCHES[db.__coche[caso]];
    const dicho = list.map((m) => [m.vehiculo, m.texto].filter(Boolean).join(' ')).join(' ');
    let i = DEMO_COCHES.findIndex((c) => c.re.test(dicho));
    if (i < 0) { const n = Object.keys(db.__coche).filter((k) => db.__coche[k] !== null).length; i = TURNO[n % TURNO.length]; }
    db.__coche[caso] = i;
    return DEMO_COCHES[i];
  }

  function advance(list, caso) {
    list.forEach((m, i) => {
      if (m.respuesta) return;
      const el = ((Date.now() - m.t0) / 1000) * speed - 3;      // 3 s de cola
      if (el < 0) { m.estado = 'pendiente'; m.progreso = null; return; }
      if (el >= DEMO_TOTAL) {
        m.estado = 'respondido'; m.progreso = null;
        const coche = cocheDe(caso, list), prev = list.slice(0, i).some((x) => x.respuesta);
        m.respuesta = Object.assign({ _segundos: Math.round(DEMO_TOTAL / speed) + 3 }, prev ? coche.segunda : coche.base);
        return;
      }
      const step = DEMO_STEPS.filter((s) => s[0] <= el).pop();
      m.estado = 'procesando';
      m.progreso = { pct: step[1], etapa: step[2], transcurrido_s: Math.round(el / speed), eta_s: Math.max(15, Math.round((DEMO_TOTAL - el) / speed)), ts: 'p' + step[0] };
    });
  }

  return {
    demo: true,
    async poll(caso) {
      await wait(180);
      const list = (!/^__/.test(caso) && Array.isArray(db[caso]) && db[caso]) || [];
      advance(list, caso); save();
      return { mensajes: list.map(({ t0, vehiculo, origen, ts_respuesta, ...m }) => JSON.parse(JSON.stringify(m))) };
    },
    // Igual que casos_() de Code.gs: un elemento por caso, del más reciente al más antiguo
    async casos() {
      await wait(150);
      const out = [];
      for (const caso of Object.keys(db)) {
        const list = db[caso];
        if (!Array.isArray(list) || !list.length) continue;
        advance(list, caso);
        const t = (m) => Math.max(Date.parse(m.ts) || 0, Date.parse(m.ts_respuesta) || 0, m.respuesta ? m.t0 + (DEMO_TOTAL / speed + 3) * 1000 : 0);
        const last = list.reduce((a, m) => (t(m) >= t(a) ? m : a)), withR = list.filter((m) => m.respuesta).pop();
        const r = withR && withR.respuesta;
        out.push({ caso, origen: list[0].origen || 'app', vehiculo: (r && r.vehiculo) || list.map((m) => m.vehiculo).filter(Boolean).pop() || '', n: list.length, estado: last.estado,
          ts: new Date(t(last)).toISOString(), respondido_ts: withR ? new Date(t(withR)).toISOString() : '',
          resumen: String((last.respuesta && (last.respuesta.hipotesis_principal || last.respuesta.respuesta_voz)) || last.texto || '').slice(0, 120) });
      }
      save();
      return { casos: out.sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts)).slice(0, 100) };
    },
    async submit({ caso, vehiculo, texto, files }) {
      const bytes = files.reduce((a, f) => a + f.blob.size, 0);
      await wait(Math.min(2500, 500 + bytes / 4000) / speed);
      const id = Math.random().toString(16).slice(2, 10);
      (db[caso] = db[caso] || []).push({ id, ts: new Date().toISOString(), texto, vehiculo: vehiculo || '', files: files.map((f) => f.name), estado: 'pendiente', respuesta: null, progreso: null, t0: Date.now() });
      save();
      return { ok: true, id };
    },
    // En la demostración no hay servicio push: se guarda la suscripción y se contesta como la cola
    async suscribir(extra) {
      await wait(120);
      if (!extra || !extra.sub) return { ok: true, vapid: DEMO_VAPID };
      db.__push = extra.baja ? null : { endpoint: extra.sub.endpoint, casos: extra.casos || [] }; save();
      return extra.baja ? { ok: true, baja: true } : { ok: true, casos: (extra.casos || []).length };
    },
    async doc(id) {
      await wait(900 / speed);
      const all = DEMO_ANSWERS.flatMap((a) => a.documentos);
      const d = all.find((x) => x.drive_id === id) || { archivo: 'documento.pdf', titulo: 'Documento' };
      return { name: d.archivo, mime: 'application/pdf', b64: tinyPdf(d.titulo) };
    },
  };
}
