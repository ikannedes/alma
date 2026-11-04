// Núcleo sin navegador: lee .mot y produce los ángulos S0..S3 cada 20 ms, como alma-f2 (motion_player.c + gait.c).
// Pose: interpolación lineal desde los ángulos anteriores durante `ms` y pasa al siguiente cuadro (HALLAZGOS §5).
// Primitivas 1 (caminar), 2 (girar) y 14 (balanceo): osciladores con la misma aritmética que gait.c, que coincide
// muestra por muestra con la referencia. Otros tipos: se sostiene la pose ciclos × T.

export const TS_MS = 20;
export const POSE = 0xfe, PAUSE = 0xfd;

/** Un registro de 20 bytes → cuadro, o null si la firma, la suma o el cierre no son válidos. */
export function parseFrame(b) {
  if (b[0] !== 0x55 || b[1] !== 0xaa || b[2] !== 0x55 || b[3] !== 0xaa || b[19] !== 0xed) return null;
  let s = 0;
  for (let i = 4; i <= 17; i++) s += b[i];
  if ((s & 0xff) !== b[18]) return null;
  return { type: b[5], b4: b[4], s: [b[11], b[12], b[13], b[14]], ms: b[16] | (b[17] << 8), gp: Array.from(b.slice(6, 13)), raw: Uint8Array.from(b) };
}

/** Un .mot entero → { frames, bad } */
export function parseMot(bytes) {
  const frames = [];
  let bad = 0;
  for (let o = 0; o + 20 <= bytes.length; o += 20) {
    const f = parseFrame(bytes.subarray(o, o + 20));
    if (f) frames.push(f); else bad++;
  }
  return { frames, bad: bad + (bytes.length % 20 ? 1 : 0) };
}

export const gaitSupported = (t) => t === 1 || t === 2 || t === 14;

export function frameName(f) {
  if (f.type === POSE) return 'pose';
  if (f.type === PAUSE) return 'pausa';
  return { 1: 'caminar', 2: 'girar', 14: 'balanceo' }[f.type] ?? `primitiva ${f.type}`;
}

/** Dirección de una primitiva: +1 adelante, −1 atrás, 0 en el sitio (probable; se confirma en el robot) */
export function gaitDir(f) {
  if (f.type !== 1) return 0;
  const d = f.gp[4];
  return d === 1 || d === 101 ? 1 : d === 2 || d === 102 ? -1 : 0;
}

// ---- aritmética del original: π y 2π en simple precisión, redondeo de C (mitades lejos de cero) ----
const F = Math.fround;
const PI_F = F(3.1415925);
const TWO_PI = new Float32Array(new Uint32Array([0x40c90fda]).buffer)[0];   // los bits exactos del original (no fround(2π), que da 0x40c90fdb)
const deg2rad = (deg) => F(F(F(deg) * PI_F) / F(180));
const roundC = (v) => (v < 0 ? -Math.round(-v) : Math.round(v));
const sgn200 = (b) => (b > 200 ? 200 - b : b);

/** Estado de una primitiva (port de gait_begin / gait_next). `phase` sigue de un registro al siguiente. */
export function gaitBegin(f, cur, phase) {
  const N = Math.floor(f.ms / TS_MS);
  if (!gaitSupported(f.type) || N === 0) return null;
  const [p0, n3, n4, n5, dir, b11, b12] = f.gp;
  const n7 = sgn200(b11), n8 = sgn200(b12);
  const steps = F(p0 / 10);
  const A = [0, 0, 0, 0], O = [0, 0, 0, 0], ph = [0, 0, 0, 0];
  const setPhase = (deg) => { const p = (deg / 360) * TWO_PI; for (let i = 0; i < 4; i++) phase[i] = p; };
  if (f.type === 1) {
    setPhase(n4);
    A[0] = A[1] = n7; A[2] = A[3] = n8; O[2] = n3; O[3] = -n3;
    if (dir === 1 || dir === 101) ph[2] = ph[3] = deg2rad(-90);
    if (dir === 2 || dir === 102) ph[2] = ph[3] = deg2rad(90);
  } else if (f.type === 2) {
    setPhase(n4);
    A[0] = A[1] = 30; A[2] = A[3] = n5; O[2] = n3; O[3] = -n3;
    ph[2] = ph[3] = deg2rad(-90);
    if (dir === 1 || dir === 101) { A[0] = n7; A[1] = n8; }
    if (dir === 2 || dir === 102) { A[0] = n8; A[1] = n7; }
  } else {
    setPhase(n4);
    A[2] = A[3] = n3; O[2] = Math.trunc(n3 / 2); O[3] = -Math.trunc(n3 / 2);
  }
  const cycles = Math.trunc(steps), frac = F(steps - cycles);
  let extra = 0;
  if (frac > 0) while (extra < frac * N) extra++;
  const homeN = f.type !== 14 && (dir === 101 || dir === 102) ? Math.floor(Math.floor(f.ms / 2) / TS_MS) : 0;
  return { A, O, ph, N, total: cycles * N + extra, done: 0, homeN, homeK: 0, last: cur.slice(), phase };
}

export function gaitNext(g) {
  if (g.done < g.total) {
    const inc = TWO_PI / g.N;
    for (let s = 0; s < 4; s++) {
      const v = F(g.A[s]) * Math.sin(g.phase[s] + g.ph[s]) + g.O[s];
      g.last[s] = roundC(v) + 90;
      g.phase[s] += inc;
    }
    g.done++;
    return g.last.slice();
  }
  if (g.homeK < g.homeN) {
    if (g.homeK === 0) {
      g.hs = g.last.slice();
      g.step = g.hs.map((a) => F((90 - a) / g.homeN));
    }
    g.homeK++;
    for (let s = 0; s < 4; s++) g.last[s] = Math.trunc(F(g.hs[s] + F(g.homeK * g.step[s])));
    return g.last.slice();
  }
  return null;
}

/**
 * Línea de tiempo completa: una muestra cada 20 ms con { t, s: [S0..S3], k (cuadro), gait (bool), dir }.
 * Las poses se interpolan desde la posición anterior como motion_player; el primer cuadro parte de 90/90/90/90.
 */
export function timeline(frames, start = [90, 90, 90, 90]) {
  const out = [];
  let cur = start.slice(), t = 0;
  const phase = [0, 0, 0, 0];
  frames.forEach((f, k) => {
    if (f.type === POSE) {
      const n = Math.max(1, Math.round(f.ms / TS_MS)), from = cur.slice();
      for (let i = 1; i <= n; i++) {
        const u = i / n;
        out.push({ t, k, gait: false, dir: 0, s: from.map((a, j) => a + (f.s[j] - a) * u) });
        t += TS_MS;
      }
      cur = f.s.slice();
    } else if (gaitSupported(f.type)) {
      const g = gaitBegin(f, cur.map(Math.round), phase);
      let a;
      while (g && (a = gaitNext(g))) { out.push({ t, k, gait: true, dir: gaitDir(f), s: a }); t += TS_MS; }
      if (g) cur = g.last.slice();
    } else {
      const ms = f.type === PAUSE ? f.ms : (f.gp[0] * f.ms) / 10;
      for (let i = 0; i < Math.max(1, Math.round(ms / TS_MS)); i++) { out.push({ t, k, gait: false, dir: 0, s: cur.slice() }); t += TS_MS; }
    }
  });
  return out;
}

/** Muestras crudas de cada primitiva, como las imprime marcha_ref (para las pruebas). */
export function gaitSamples(frames) {
  const recs = [];
  let cur = [90, 90, 90, 90];
  const phase = [0, 0, 0, 0];
  frames.forEach((f, k) => {
    if (f.type === POSE) { cur = f.s.slice(); return; }
    if (!gaitSupported(f.type)) return;
    const g = gaitBegin(f, cur, phase);
    const s = [];
    let a;
    while (g && (a = gaitNext(g))) s.push(a);
    recs.push({ k, samples: s });
    if (g) cur = g.last.slice();
  });
  return recs;
}

// ---- construir, validar y el formato de texto alma-anim/1 ----
export const S_RANGE = [[40, 160], [53, 130], [0, 150], [30, 180]];   // R10: rango observado por servo (02)
export const MS_RANGE = [40, 6400];

/** Cuadro → 20 bytes. Parte de los bytes originales (si los hay), así un cuadro sin cambios sale idéntico. */
export function buildFrame(f) {
  const b = f.raw ? Uint8Array.from(f.raw) : new Uint8Array(20);
  b[0] = 0x55; b[1] = 0xaa; b[2] = 0x55; b[3] = 0xaa;
  b[4] = f.b4 ?? 2;
  b[5] = f.type;
  if (f.type === POSE) for (let i = 0; i < 4; i++) b[11 + i] = f.s[i];
  else if (f.type !== PAUSE) for (let i = 0; i < 7; i++) b[6 + i] = f.gp[i];
  b[16] = f.ms & 0xff; b[17] = (f.ms >> 8) & 0xff;
  let c = 0;
  for (let i = 4; i <= 17; i++) c += b[i];
  b[18] = c & 0xff;
  b[19] = 0xed;
  return b;
}

export function buildMot(frames) {
  const out = new Uint8Array(frames.length * 20);
  frames.forEach((f, k) => out.set(buildFrame(f), k * 20));
  return out;
}

/** Errores que impiden exportar: [{ k, msg }]. Las primitivas se simulan, como el R10 de alma-f2. */
export function validate(frames) {
  const errs = [];
  const inMs = (v) => Number.isInteger(v) && v >= MS_RANGE[0] && v <= MS_RANGE[1];
  frames.forEach((f, k) => {
    if (f.type === POSE) {
      f.s.forEach((a, i) => { if (!Number.isInteger(a) || a < S_RANGE[i][0] || a > S_RANGE[i][1]) errs.push({ k, msg: `S${i} = ${a}, fuera de ${S_RANGE[i][0]}–${S_RANGE[i][1]}` }); });
      if (!inMs(f.ms)) errs.push({ k, msg: `duración ${f.ms} ms, fuera de ${MS_RANGE[0]}–${MS_RANGE[1]}` });
    } else if (f.type === PAUSE) {
      if (!inMs(f.ms)) errs.push({ k, msg: `pausa ${f.ms} ms, fuera de ${MS_RANGE[0]}–${MS_RANGE[1]}` });
    } else if (gaitSupported(f.type)) {
      if (!inMs(f.ms)) errs.push({ k, msg: `T = ${f.ms} ms, fuera de ${MS_RANGE[0]}–${MS_RANGE[1]}` });
      if (f.gp.some((v) => !Number.isInteger(v) || v < 0 || v > 255)) errs.push({ k, msg: 'parámetro fuera de 0–255' });
      if (f.gp[0] < 1) errs.push({ k, msg: 'ciclos = 0' });
      const g = gaitBegin(f, [90, 90, 90, 90], [0, 0, 0, 0]);
      let a, worst = null;
      while (g && !worst && (a = gaitNext(g)))
        a.forEach((v, i) => { if (!worst && (v < S_RANGE[i][0] || v > S_RANGE[i][1])) worst = `la primitiva llevaría S${i} a ${v}, fuera de ${S_RANGE[i][0]}–${S_RANGE[i][1]}`; });
      if (worst) errs.push({ k, msg: worst });
    }
  });
  return errs;
}

// Bytes de las primitivas (HALLAZGOS §5): 6 ciclos×10, 7 desvío/altura, 8 fase, 9 pies (girar), 10 dirección,
// 11 y 12 amplitudes. Negativos: 200 − x.
const enc = (v) => (v < 0 ? 200 - v : v);
const dec = (b) => (b > 200 ? 200 - b : b);
const WALK_DIR = { adelante: 1, atras: 2, sitio: 3, adelante_y_neutro: 101, atras_y_neutro: 102 };
const TURN_DIR = { izquierda: 1, derecha: 2, izquierda_y_neutro: 101, derecha_y_neutro: 102 };
const nameOf = (map, v) => Object.keys(map).find((k) => map[k] === v) ?? v;
const hex = (u) => Array.from(u, (x) => x.toString(16).padStart(2, '0')).join('');

/** Cuadros → objeto alma-anim/1 (texto que se puede escribir a mano). Guarda los bytes libres si no son 0. */
export function toAnim(name, frames) {
  const cuadros = frames.map((f) => {
    let c;
    const [p0, b7, b8, b9, b10, b11, b12] = f.gp;
    if (f.type === POSE) c = { pose: f.s.slice(), ms: f.ms };
    else if (f.type === PAUSE) c = { pausa: f.ms };
    else if (f.type === 1) c = { caminar: { ciclos: p0 / 10, T: f.ms, caderas: dec(b11), pies: dec(b12), desvio: b7, fase: b8, dir: nameOf(WALK_DIR, b10) } };
    else if (f.type === 2) c = { girar: { ciclos: p0 / 10, T: f.ms, cadera_a: dec(b11), cadera_b: dec(b12), pies: b9, desvio: b7, fase: b8, dir: nameOf(TURN_DIR, b10) } };
    else if (f.type === 14) c = { balanceo: { ciclos: p0 / 10, T: f.ms, altura: b7, fase: b8 } };
    else return { crudo: hex(buildFrame(f)) };
    if (f.raw) {   // fidelidad: lo que el formato no nombra
      const expect = buildFrame({ ...fromCuadro(c), raw: null, b4: f.b4 });
      const free = [];
      f.raw.forEach((v, i) => { if (i >= 4 && i <= 17 && v !== expect[i]) free.push([i, v]); });
      if (f.b4 !== 2) c.b4 = f.b4;
      const rest = free.filter(([i]) => i !== 4);
      if (rest.length) c.bytes = Object.fromEntries(rest);
    }
    return c;
  });
  return { formato: 'alma-anim/1', nombre: name, cuadros };
}

function fromCuadro(c) {
  if (c.crudo) {
    const b = Uint8Array.from(c.crudo.match(/../g).map((h) => parseInt(h, 16)));
    const f = parseFrame(b);
    if (!f) throw new Error(`registro crudo inválido: ${c.crudo}`);
    return f;
  }
  const gp = [0, 0, 0, 0, 0, 0, 0];
  let f;
  if (c.pose) f = { type: POSE, s: c.pose.map(Math.round), ms: Math.round(c.ms), gp };
  else if (c.pausa !== undefined) f = { type: PAUSE, s: [0, 0, 0, 0], ms: Math.round(c.pausa), gp };
  else if (c.caminar) {
    const w = c.caminar, dir = WALK_DIR[w.dir] ?? w.dir ?? 1;
    f = { type: 1, s: [0, 0, 0, 0], ms: Math.round(w.T), gp: [Math.round(w.ciclos * 10), w.desvio ?? 0, w.fase ?? 0, 0, dir, enc(w.caderas), enc(w.pies)] };
  } else if (c.girar) {
    const w = c.girar, dir = TURN_DIR[w.dir] ?? w.dir ?? 1;
    f = { type: 2, s: [0, 0, 0, 0], ms: Math.round(w.T), gp: [Math.round(w.ciclos * 10), w.desvio ?? 0, w.fase ?? 0, w.pies ?? 0, dir, enc(w.cadera_a), enc(w.cadera_b)] };
  } else if (c.balanceo) {
    const w = c.balanceo;
    f = { type: 14, s: [0, 0, 0, 0], ms: Math.round(w.T), gp: [Math.round(w.ciclos * 10), w.altura, w.fase ?? 0, 0, 0, 0, 0] };
  } else throw new Error(`cuadro desconocido: ${JSON.stringify(c)}`);
  if (c.b4 !== undefined) f.b4 = c.b4;
  return f;
}

/** Objeto alma-anim/1 → cuadros (con los bytes libres si los trae) */
export function fromAnim(anim) {
  if (anim.formato !== 'alma-anim/1') throw new Error('formato desconocido (se espera "alma-anim/1")');
  return anim.cuadros.map((c) => {
    const f = fromCuadro(c);
    if (c.bytes) {
      const b = buildFrame(f);
      for (const [i, v] of Object.entries(c.bytes)) b[+i] = v;
      return parseFrame(buildFrame({ ...parseFrame(fixSum(b)), raw: fixSum(b) }));
    }
    return f;
  });
}

function fixSum(b) {
  let c = 0;
  for (let i = 4; i <= 17; i++) c += b[i];
  b[18] = c & 0xff;
  return b;
}

/** Herramientas de edición (devuelven cuadros nuevos) */
export function scaleTime(frames, factor) {
  return frames.map((f) => ({ ...f, ms: Math.max(1, Math.round(f.ms * factor)) }));
}
export function mirror(frames) {
  return frames.map((f) => {
    if (f.type === POSE) return { ...f, s: [180 - f.s[1], 180 - f.s[0], 180 - f.s[3], 180 - f.s[2]] };
    if (f.type === 2) { const gp = f.gp.slice(); gp[4] = { 1: 2, 2: 1, 101: 102, 102: 101 }[gp[4]] ?? gp[4]; return { ...f, gp }; }
    return { ...f };
  });
}
export function scaleAmplitude(frames, factor) {
  return frames.map((f) => (f.type === POSE ? { ...f, s: f.s.map((a) => Math.round(90 + (a - 90) * factor)) } : { ...f }));
}
