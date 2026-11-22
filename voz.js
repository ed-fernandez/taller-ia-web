// Troceo de la respuesta en frases para leerla en voz alta. Chrome corta las locuciones largas, así que se
// lee frase a frase; pero un punto no siempre acaba una frase: «1.0 EcoBoost», «1.6 TDI», «95.000 km»,
// «N.º 3», «aprox. 20 min» o «p. ej. el termostato» no se pueden partir, o se oye «uno [pausa] cero».
// Regla: solo se corta tras . ! ? … (con comillas o paréntesis de cierre opcionales) seguidos de espacio y de
// algo que empieza frase (mayúscula, ¿, ¡, comillas o paréntesis de apertura), y en los saltos de línea.

const ABREV = /(?:^|[\s(«"])(?:n\.?º|núm|aprox|p\. ?ej|ej|etc|pág|art|sr|sra|dr|dra|ud|uds|vs|aprox)\.$/i;
const LARGO = 220;                                                   // más largo que esto se parte en ; o :

export function trocear(texto) {
  const t = String(texto == null ? '' : texto).replace(/\r/g, '').trim();
  if (!t) return [];
  const out = [];
  for (const linea of t.split(/\n+/)) {
    let buf = '';
    const piezas = linea.split(/(?<=[.!?…]["»)]?)\s+(?=[¿¡«"(A-ZÁÉÍÓÚÜÑ])/);
    for (const p of piezas) {
      buf = buf ? buf + ' ' + p : p;
      if (ABREV.test(buf)) continue;                                 // «aprox.» seguido de mayúscula: no es final
      out.push(buf); buf = '';
    }
    if (buf) out.push(buf);
  }
  return out.flatMap(partirLarga).map((s) => s.trim()).filter(Boolean);
}

function partirLarga(s) {
  if (s.length <= LARGO) return [s];
  const mitad = s.length / 2;
  let mejor = -1;
  for (const m of s.matchAll(/[;:]\s+|,\s+(?=(?:y|pero|que|porque|aunque|así|luego|después|antes)\b)/g)) {
    const at = m.index + 1;
    if (mejor < 0 || Math.abs(at - mitad) < Math.abs(mejor - mitad)) mejor = at;
  }
  if (mejor < 20 || mejor > s.length - 20) return [s];
  return [...partirLarga(s.slice(0, mejor)), ...partirLarga(s.slice(mejor).trim())];
}
