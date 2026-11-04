// EMO en 3D: cabeza con pantalla, dos piernas con cadera (gira alrededor del eje vertical) y pie (se inclina hacia
// los lados). S0 cadera izquierda, S1 cadera derecha, S2 pie izquierdo, S3 pie derecho (HALLAZGOS §4).
// Medidas en cm, tomadas del modelo CAD (emo_tools/step2glb/articular.mjs): ejes de cadera por la pierna, eje del
// tobillo por sus pernos. El robot mira hacia +Z; su izquierda es +X.
// Si serve.mjs da el modelo CAD (privado, fuera del repo), attachModel() lo pone en lugar de las piezas dibujadas.
// Este módulo también corre en node (cli.mjs, pruebas): nada de document salvo dentro de `if (DOM)`.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { ConvexHull } from 'three/examples/jsm/math/ConvexHull.js';

const HIP_X = 1.32;          // cada cadera desde el centro
const LEG_LEN = 3.08;        // de la cadera al tobillo
const FOOT = { w: 3.35, h: 1.15, d: 3.8, x: 0.65, z: 0 };   // h: del tobillo a la suela; x: el pie se carga hacia afuera
const HEAD = { w: 5.9, h: 5.15, d: 5.0, y: 2.15, z: 0.22 }; // caja de la cabeza (con el cuerpo) y su centro
const COM = { x: 0, y: 2.2, z: 0.2 };    // centro de masa en el cuerpo (la cabeza pesa casi todo)
const CONTACT = 0.06;                    // cm: un pie a menos de esto del piso cuenta como apoyado
const FLOOR_SEEN = 0.3;                  // cm: un sensor a más de esto ya no ve piso
export const SERVO_COLORS = [0xff6b6b, 0xffc861, 0x38e1ff, 0x9d7bff];
const DOM = typeof document !== 'undefined';
const SIDE = { L: 1, R: -1 };

const rbox = (w, h, d, r, seg = 4) => new RoundedBoxGeometry(w, h, d, seg, Math.min(r, w / 2, h / 2, d / 2) * 0.999);

function mesh(geo, mat) {
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

// ---- pantalla: ojos dibujados en un canvas (solo en el navegador) ----
function makeFace() {
  if (!DOM) return null;
  const c = document.createElement('canvas');
  c.width = 512; c.height = 440;
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return { c, tex, ctx: c.getContext('2d'), blink: 0, nextBlink: 1.5, lookX: 0, lookY: 0, t: 0 };
}

function drawFace(f, dt, look) {
  f.t += dt;
  if (f.t > f.nextBlink) { f.blink = 1; f.nextBlink = f.t + 2.5 + Math.random() * 3; }
  f.blink = Math.max(0, f.blink - dt * 7);
  const open = 1 - Math.sin(Math.min(1, f.blink) * Math.PI) * 0.92;
  f.lookX += (look.x - f.lookX) * Math.min(1, dt * 6);
  f.lookY += (look.y - f.lookY) * Math.min(1, dt * 6);
  const { ctx, c } = f;
  ctx.clearRect(0, 0, c.width, c.height);
  ctx.fillStyle = '#38e1ff';
  ctx.shadowColor = '#38e1ff';
  ctx.shadowBlur = 38;
  const ew = 118, eh = 168 * open;
  for (const cx of [170, 342]) {
    const x = cx - ew / 2 + f.lookX * 40, y = 220 - eh / 2 + f.lookY * 30;
    ctx.beginPath();
    ctx.roundRect(x, y, ew, Math.max(10, eh), Math.min(36, eh / 2));
    ctx.fill();
  }
  f.tex.needsUpdate = true;
}

function label(text, w = 256, h = 96) {
  if (!DOM) return null;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  g.fillStyle = '#111';
  g.fillRect(0, 0, w, h);
  g.fillStyle = '#d8dde4';
  g.font = `bold ${Math.round(h * 0.42)}px system-ui, sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, w / 2, h / 2);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function buildRobot() {
  const M = {
    shell: new THREE.MeshPhysicalMaterial({ color: 0x1d2025, roughness: 0.32, metalness: 0.1, clearcoat: 1, clearcoatRoughness: 0.14 }),
    glass: new THREE.MeshPhysicalMaterial({ color: 0x020305, roughness: 0.05, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.03 }),
    body: new THREE.MeshPhysicalMaterial({ color: 0xe3e6ea, roughness: 0.42, metalness: 0.05, clearcoat: 0.4, clearcoatRoughness: 0.3 }),
    joint: new THREE.MeshStandardMaterial({ color: 0x2a2e35, roughness: 0.5, metalness: 0.6 }),
    sole: new THREE.MeshStandardMaterial({ color: 0x1b1d21, roughness: 0.9 }),
    servo: new THREE.MeshStandardMaterial({ color: 0x2f62d6, roughness: 0.5 }),
    pcb: new THREE.MeshStandardMaterial({ color: 0x0f6b3a, roughness: 0.6 }),
    batt: new THREE.MeshStandardMaterial({ color: 0xd98a2b, roughness: 0.5 }),
  };
  const shells = [M.shell, M.glass, M.body, M.sole];
  const accent = SERVO_COLORS.map((c) => new THREE.MeshStandardMaterial({ color: c, emissive: c, emissiveIntensity: 2.4, roughness: 0.4 }));

  const root = new THREE.Group();          // posición y rumbo en el piso
  const body = new THREE.Group();          // se acomoda sobre los pies; origen entre las caderas
  root.add(body);
  const internals = [];                    // piezas de adentro: solo se ven con rayos X
  const drawn = [];                        // piezas dibujadas: se ocultan si llega el modelo CAD

  // ---- cabeza (con el cuerpo) ----
  const head = new THREE.Group();          // se separa con "separar piezas"
  body.add(head);
  const headC = new THREE.Group();         // centro de la caja de la cabeza
  headC.position.set(0, HEAD.y, HEAD.z);
  head.add(headC);
  const shellHead = mesh(rbox(HEAD.w, HEAD.h, HEAD.d, 1.1, 6), M.shell);
  headC.add(shellHead);
  const plate = mesh(rbox(HEAD.w * 0.76, HEAD.h * 0.78, 0.2, 0.7, 5), M.glass);
  plate.position.set(0, -0.15, HEAD.d / 2 - 0.085);
  headC.add(plate);
  drawn.push(shellHead, plate);
  const face = makeFace();
  let screen = null;
  if (face) {
    screen = new THREE.Mesh(new THREE.PlaneGeometry(HEAD.w * 0.7, HEAD.h * 0.68),
      new THREE.MeshBasicMaterial({ map: face.tex, transparent: true, toneMapped: false }));
    screen.material.color.setScalar(4);   // más que blanco: el bloom lo hace brillar
    screen.position.set(0, -0.15, HEAD.d / 2 + 0.03);
    headC.add(screen);
  }
  // por dentro: placa con el ESP32 y el K210, la batería y los servos de cadera
  const pcb = mesh(new THREE.BoxGeometry(HEAD.w * 0.7, HEAD.h * 0.55, 0.08), M.pcb);
  pcb.position.set(0, 0.35, -0.9);
  headC.add(pcb); internals.push(pcb);
  for (const [txt, x] of [['ESP32', -0.95], ['K210', 0.95]]) {
    const t = label(txt);
    const chip = mesh(new THREE.BoxGeometry(1.25, 1.0, 0.12), t ? new THREE.MeshStandardMaterial({ map: t, roughness: 0.5 }) : M.joint);
    chip.position.set(x, 0.45, 0.1);
    pcb.add(chip);
  }
  const batt = mesh(rbox(HEAD.w * 0.6, 0.9, 1.8, 0.2), M.batt);
  batt.position.set(0, 1.1, 0.4);
  headC.add(batt); internals.push(batt);

  const legs = {};
  for (const side of ['L', 'R']) {
    const sg = SIDE[side], hx = sg * HIP_X;
    const hs = side === 'L' ? 0 : 1, fs = side === 'L' ? 2 : 3;
    const servoHip = mesh(new THREE.BoxGeometry(1.0, 1.15, 2.2), M.servo);
    servoHip.position.set(hx, 0.75, 0);
    head.add(servoHip); internals.push(servoHip);

    const hip = new THREE.Group();          // gira con S0/S1
    hip.position.x = hx;
    body.add(hip);
    const legVis = new THREE.Group();       // se separa con "separar piezas"
    hip.add(legVis);
    const leg = mesh(rbox(1.2, LEG_LEN + 0.58, 3.1, 0.55), M.shell);
    leg.position.set(0, -(LEG_LEN + 0.58) / 2, 0.05);
    legVis.add(leg);
    drawn.push(leg);

    const ankle = new THREE.Group();        // se inclina con S2/S3
    ankle.position.y = -LEG_LEN;
    hip.add(ankle);
    const footVis = new THREE.Group();
    ankle.add(footVis);
    const servoAnk = mesh(new THREE.BoxGeometry(1.1, 1.0, 2.2), M.servo);
    servoAnk.position.set(sg * 0.9, -0.1, 0);
    footVis.add(servoAnk); internals.push(servoAnk);
    const upper = mesh(rbox(FOOT.w, FOOT.h * 0.7, FOOT.d, 0.3), M.body);
    upper.position.set(sg * FOOT.x, -FOOT.h * 0.65, FOOT.z);
    footVis.add(upper);
    const sole = mesh(rbox(FOOT.w + 0.06, FOOT.h * 0.3, FOOT.d + 0.06, 0.12), M.sole);
    sole.position.set(sg * FOOT.x, -FOOT.h * 0.85, FOOT.z);
    footVis.add(sole);
    drawn.push(upper, sole);
    // eje del tobillo: un aro del color del servo en cada perno (adelante y atrás)
    const pins = [1, -1].map((dz) => {
      const r = mesh(new THREE.TorusGeometry(0.28, 0.06, 10, 36), accent[fs]);
      r.position.set(0, 0, dz * 1.05);
      ankle.add(r);
      return r;
    });
    // sensores de piso: adelante y atrás de cada pie (verde = ve piso, rojo = al aire)
    const sensors = [1, -1].map((dz) => {
      const m = new THREE.Mesh(new THREE.SphereGeometry(0.13, 16, 10),
        new THREE.MeshStandardMaterial({ color: 0x55ff88, emissive: 0x55ff88, emissiveIntensity: 3 }));
      m.position.set(sg * FOOT.x, -FOOT.h + 0.15, FOOT.z + dz * (FOOT.d / 2 + 0.03));
      footVis.add(m);
      return m;
    });
    legs[side] = { hip, ankle, foot: upper, sole, legVis, footVis, sensors, pins, hx, hs, fs };
  }

  // ---- indicadores de ángulo ----
  const gauges = new THREE.Group();
  body.add(gauges);
  const gaugeMat = new THREE.MeshBasicMaterial({ color: 0x8b95a3, transparent: true, opacity: 0.5, side: THREE.DoubleSide, depthWrite: false });
  const fills = SERVO_COLORS.map((c) => new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: 0.45, side: THREE.DoubleSide, depthWrite: false }));
  const needles = SERVO_COLORS.map((c) => new THREE.MeshBasicMaterial({ color: c, toneMapped: false }));
  const G = [];
  for (const side of ['L', 'R']) {
    const lg = legs[side];
    // cadera: anillo horizontal alrededor de la pierna, fijo al cuerpo
    const gh = new THREE.Group();
    gh.position.set(lg.hx, -1.15, 0);
    gauges.add(gh);
    // pie: medio anillo vertical delante de la punta, fijo a la pierna (gira con la cadera)
    const gf = new THREE.Group();
    gf.position.set(SIDE[side] * FOOT.x, -LEG_LEN + 0.05, FOOT.z + FOOT.d / 2 + 0.3);
    lg.hip.add(gf);
    for (const [g, idx, R, horiz] of [[gh, lg.hs, 2.0, true], [gf, lg.fs, 1.1, false]]) {
      // el del pie es medio anillo (arriba): abajo está el piso
      const base = new THREE.Mesh(horiz ? new THREE.RingGeometry(R - 0.04, R, 64) : new THREE.RingGeometry(R - 0.04, R, 48, 1, 0, Math.PI), gaugeMat);
      const tick = new THREE.Mesh(new THREE.PlaneGeometry(0.05, 0.25), gaugeMat);
      const fill = new THREE.Mesh(new THREE.BufferGeometry(), fills[idx]);
      const needle = new THREE.Mesh(new THREE.PlaneGeometry(0.06, R), needles[idx]);
      needle.geometry.translate(0, R / 2, 0);
      const plane = new THREE.Group();
      plane.add(base, tick, fill, needle);
      if (horiz) plane.rotation.x = -Math.PI / 2;
      tick.position.y = horiz ? -R : R;
      g.add(plane);
      G.push({ idx, R, horiz, fill, needle, last: null, group: g });
    }
  }

  for (const m of internals) m.visible = false;
  // la física apoya el contorno de lo que se dibuja
  const fm = (k) => [legs[k].foot, legs[k].sole];
  const { solePts, footPts } = contactSets({ L: hullPoints(legs.L.footVis, fm('L')), R: hullPoints(legs.R.footVis, fm('R')) });
  return {
    root, solePts, footPts, body, legs, head, headC, screen, gauges, internals, shells, drawn, M, accent, face, G, model: false,
    floor: { L: [true, true], R: [true, true] }, contact: { L: true, R: true }, lift: 0, explode: 0,
  };
}

/**
 * Pone el modelo CAD articulado (GLB de articular.mjs: nodos cuerpo, pantalla, pierna_L/R, pie_L/R, ya en el marco
 * de cada articulación) en lugar de las piezas dibujadas.
 */
export function attachModel(rb, scene) {
  const get = (n) => scene.getObjectByName(n);
  const need = ['cuerpo', 'pantalla', 'pierna_L', 'pierna_R', 'pie_L', 'pie_R'];
  if (!need.every(get)) return false;
  const mats = { carcasa: rb.M.shell, pantalla: rb.M.glass, pie: rb.M.body, suela: rb.M.sole };
  const put = (obj, parent, pinMat) => {
    obj.removeFromParent();
    obj.position.set(0, 0, 0);
    obj.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = o.receiveShadow = true;
      const n = o.material.name;
      o.material = n === 'perno' ? pinMat : mats[n] ?? rb.M.body;
    });
    parent.add(obj);
  };
  const feet = { L: get('pie_L'), R: get('pie_R') };
  put(get('cuerpo'), rb.head);
  put(get('pantalla'), rb.head);
  for (const k of ['L', 'R']) {
    const lg = rb.legs[k];
    put(get(`pierna_${k}`), lg.legVis);
    put(get(`pie_${k}`), lg.footVis, rb.accent[lg.fs]);
    lg.pins.forEach((p) => { p.visible = false; });
  }
  for (const m of rb.drawn) m.visible = false;
  // los ojos, sobre el vidrio del modelo (su frente está en z = 3.07, centro y = 2.0 en el cuerpo)
  if (rb.screen) {
    rb.screen.removeFromParent();
    rb.screen.geometry.dispose();
    rb.screen.geometry = new THREE.PlaneGeometry(3.9, 3.5);
    rb.screen.position.set(0, 2.0, 3.095);
    rb.head.add(rb.screen);
  }
  // la física apoya el contorno real de cada pie, no la caja aproximada
  Object.assign(rb, contactSets({ L: hullPoints(feet.L), R: hullPoints(feet.R) }));
  rb.model = true;
  return true;
}

/** Vértices de la envolvente convexa de las mallas de `obj` (todas, o solo `meshes`), en el marco de `obj`. */
export function hullPoints(obj, meshes = null) {
  const pts = [];
  obj.updateMatrixWorld(true);
  const inv = obj.matrixWorld.clone().invert();
  obj.traverse((o) => {
    if (!o.isMesh || (meshes && !meshes.includes(o))) return;
    const p = o.geometry.attributes.position, m = inv.clone().multiply(o.matrixWorld), v = new THREE.Vector3();
    for (let i = 0; i < p.count; i++) pts.push(v.fromBufferAttribute(p, i).applyMatrix4(m).clone());
  });
  return new ConvexHull().setFromPoints(pts).vertices.map(({ point: p }) => [p.x, p.y, p.z]);
}

/**
 * Puntos de apoyo: para n direcciones repartidas en la esfera (a no más de maxDeg de "abajo" del pie), el vértice
 * más bajo en esa dirección. El punto más bajo del pie en cualquier postura es uno de ellos, salvo un error de
 * R·(1 − cos(paso/2)): con 12 000 direcciones (paso ≈ 2°) y un pie de 3 cm, ~0.005 mm. La envolvente del modelo CAD
 * tiene ~11 000 vértices; así quedan muchos menos y la física corre en tiempo real.
 */
export function supportPoints(pts, n, maxDeg = 180) {
  const keep = new Set(), cmin = Math.cos(maxDeg * d2r), golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const y = 1 - (2 * (i + 0.5)) / n, r = Math.sqrt(1 - y * y), ph = i * golden;
    const d = [r * Math.cos(ph), y, r * Math.sin(ph)];
    if (-d[1] < cmin) continue;
    let best = 0, lo = Infinity;
    for (let k = 0; k < pts.length; k++) { const v = pts[k][0] * d[0] + pts[k][1] * d[1] + pts[k][2] * d[2]; if (v < lo) { lo = v; best = k; } }
    keep.add(best);
  }
  return [...keep].map((k) => pts[k]);
}

/** footPts: apoyos del pie completo (piso y contacto, en cualquier inclinación); solePts: los de la suela, para buscar la postura. */
function contactSets(hull) {
  const out = { footPts: {}, solePts: {} };
  for (const k of ['L', 'R']) {
    out.footPts[k] = supportPoints(hull[k], 12000);
    out.solePts[k] = supportPoints(out.footPts[k], 1500, 50);
  }
  return out;
}

// ---- física de apoyo ----
const d2r = Math.PI / 180;
const CORNERS = {}, SENS = {};
for (const k of ['L', 'R']) {
  const cx = SIDE[k] * FOOT.x;
  CORNERS[k] = [];
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) CORNERS[k].push([cx + sx * FOOT.w / 2, -FOOT.h, FOOT.z + sz * FOOT.d / 2]);
  SENS[k] = [[cx, -FOOT.h, FOOT.z + FOOT.d / 2 - 0.25], [cx, -FOOT.h, FOOT.z - FOOT.d / 2 + 0.25]];
}

function toBody(p, hx, hip, ank) {
  // pie (tobillo) → pierna → cuerpo
  const ca = Math.cos(ank), sa = Math.sin(ank);
  const x1 = p[0] * ca - p[1] * sa, y1 = p[0] * sa + p[1] * ca - LEG_LEN, z1 = p[2];
  const ch = Math.cos(hip), sh = Math.sin(hip);
  return [hx + x1 * ch + z1 * sh, y1, -x1 * sh + z1 * ch];
}

function rot(p, r, q) {   // Rz(r) y luego Rx(q), como body.rotation.set(q, 0, r)
  const cr = Math.cos(r), sr = Math.sin(r), cq = Math.cos(q), sq = Math.sin(q);
  const x1 = p[0] * cr - p[1] * sr, y1 = p[0] * sr + p[1] * cr;
  return [x1, y1 * cq - p[2] * sq, y1 * sq + p[2] * cq];
}

// Sobre los cantos (pies inclinados hacia lados opuestos): la inclinación que deja el centro de masa más abajo sin
// atravesar el piso, buscada desde derecho (la gravedad lleva al reposo más cercano, no a "tirado en el piso").
function settle(pts) {
  const cost = (r, q) => {
    let lo = Infinity;
    for (const p of pts) { const y = rot(p, r, q)[1]; if (y < lo) lo = y; }
    return rot([COM.x, COM.y, COM.z], r, q)[1] - lo + 1e-4 * (r * r + q * q);
  };
  let br = 0, bq = 0, bc = cost(0, 0);
  for (let step = 2 * d2r; step > 0.05 * d2r;) {
    let moved = false;
    for (const [dr, dq] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const r = br + dr * step, q = bq + dq * step;
      if (Math.abs(r) > 40 * d2r || Math.abs(q) > 28 * d2r) continue;
      const c = cost(r, q);
      if (c < bc - 1e-7) { bc = c; br = r; bq = q; moved = true; break; }
    }
    if (!moved) step /= 2;
  }
  return [br, bq];
}

/**
 * Pose a partir de S0..S3 (grados) y del estado anterior `st` ({x, z, yaw, prevHip}). El cuerpo se acomoda sobre
 * los pies; la cadera del pie apoyado hace girar el cuerpo alrededor de ese pie (así avanza y gira).
 * signs = [S0..S3] con +1 o −1 (el sentido real de cada servo se confirma en el robot).
 * Devuelve 'both', 'L' o 'R' (qué pie está apoyado).
 */
export function applyPose(rb, s, st, signs) {
  const hipL = (s[0] - 90) * signs[0], hipR = (s[1] - 90) * signs[1];
  const footL = (s[2] - 90) * signs[2], footR = (s[3] - 90) * signs[3];
  const J = { L: [HIP_X, hipL * d2r, footL * d2r], R: [-HIP_X, hipR * d2r, footR * d2r] };
  rb.legs.L.hip.rotation.y = J.L[1];
  rb.legs.R.hip.rotation.y = J.R[1];
  rb.legs.L.ankle.rotation.z = J.L[2];
  rb.legs.R.ankle.rotation.z = J.R[2];

  // Contorno de lo que se dibuja: la parte baja de la suela para buscar la postura, y el pie completo (envolvente
  // convexa) para el piso y el contacto, así ni a 90° se mete un costado al piso. Sin modelo, la caja del pie.
  const S = rb.solePts ?? CORNERS, C = rb.footPts ?? S;
  const sp = { L: S.L.map((c) => toBody(c, ...J.L)), R: S.R.map((c) => toBody(c, ...J.R)) };
  const pts = { L: C.L.map((c) => toBody(c, ...J.L)), R: C.R.map((c) => toBody(c, ...J.R)) };
  // Pies inclinados hacia el mismo lado (el vaivén de la marcha): con peso encima, el pie apoyado se queda plano y el
  // servo ladea el cuerpo, así que el otro pie se levanta; se prueba plano sobre cada pie y vale si el otro no
  // atraviesa el piso. Pies en espejo (los dos hacia adentro o hacia afuera): queda sobre los cantos y se levanta.
  let best = null;
  const mirrored = J.L[2] * J.R[2] < 0;
  for (const k of mirrored ? [] : ['L', 'R']) {
    const [, h, a] = J[k];
    const n = [-Math.sin(a) * Math.cos(h), Math.cos(a), Math.sin(a) * Math.sin(h)];   // normal de la suela
    const r0 = Math.atan2(n[0], n[1]), q0 = Math.atan2(-n[2], Math.hypot(n[0], n[1]));
    const lo = Math.min(...pts[k].map((p) => rot(p, r0, q0)[1]));
    const other = Math.min(...pts[k === 'L' ? 'R' : 'L'].map((p) => rot(p, r0, q0)[1]));
    if (other < lo - 1e-6) continue;
    // estable solo si el centro de masa cae sobre lo que apoya ese pie; si no, se caería: queda sobre los cantos
    const g = rot([COM.x, COM.y, COM.z], r0, q0), on = pts[k].map((p) => rot(p, r0, q0)).filter((p) => p[1] - lo < CONTACT);
    const xs = on.map((p) => p[0]), zs = on.map((p) => p[2]);
    if (g[0] < Math.min(...xs) || g[0] > Math.max(...xs) || g[2] < Math.min(...zs) || g[2] > Math.max(...zs)) continue;
    const com = g[1] - lo;
    if (!best || com < best.com) best = { r: r0, q: q0, com };
  }
  const [r, q] = best ? [best.r, best.q] : settle([...sp.L, ...sp.R]);
  const W = { L: pts.L.map((p) => rot(p, r, q)), R: pts.R.map((p) => rot(p, r, q)) };
  let lo = Infinity;
  for (const k of ['L', 'R']) for (const p of W[k]) lo = Math.min(lo, p[1]);
  // contacto: las esquinas pegadas al piso; el cuerpo gira alrededor de ellas, sin resbalar
  let n = 0, fx = 0, fz = 0, rx = 0, rz = 0;
  const touch = { L: false, R: false };
  for (const k of ['L', 'R']) W[k].forEach((p, i) => {
    if (p[1] - lo < CONTACT) { touch[k] = true; n++; rx += p[0]; rz += p[2]; fx += pts[k][i][0]; fz += pts[k][i][2]; }
  });
  rb.body.rotation.set(q, 0, r);
  rb.body.position.set((fx - rx) / n, -lo + rb.lift, (fz - rz) / n);
  rb.contact = touch;
  for (const k of ['L', 'R']) rb.floor[k] = SENS[k].map((p) => rot(toBody(p, ...J[k]), r, q)[1] - lo < FLOOR_SEEN);
  const planted = touch.L && touch.R ? 'both' : touch.L ? 'L' : 'R';

  // El pie apoyado queda anclado: su punto de contacto no se mueve en el piso y su rumbo (rumbo del cuerpo + su
  // cadera) tampoco; el cuerpo gira y se desplaza alrededor de él, así avanza y gira. Con los dos apoyados se queda
  // anclado el que ya lo estaba (si las caderas se tuercen con los dos en el piso, el otro tiene que resbalar).
  const a = planted !== 'both' ? planted : st.anchor && touch[st.anchor] ? st.anchor : 'L';
  let cx = 0, cy = 0, cz = 0, m = 0;
  W[a].forEach((p, i) => { if (p[1] - lo < CONTACT) { cx += C[a][i][0]; cy += C[a][i][1]; cz += C[a][i][2]; m++; } });
  const cLocal = [cx / m, cy / m, cz / m];
  const now = { J, r, q, off: [rb.body.position.x, rb.body.position.z] };
  const world = (P, yaw, x, z) => {   // el punto de contacto (marco del tobillo) → piso del mundo
    const b = rot(toBody(cLocal, ...P.J[a]), P.r, P.q), px = P.off[0] + b[0], pz = P.off[1] + b[2];
    return [x + px * Math.cos(yaw) + pz * Math.sin(yaw), z - px * Math.sin(yaw) + pz * Math.cos(yaw)];
  };
  // también al cambiar de pie: el que ahora apoya no se mueve respecto a donde estaba en la muestra anterior
  if (st.prevHip && st.prev) {
    const before = world(st.prev, st.yaw, st.x, st.z);
    // rumbo del pie apoyado en el marco del robot (su eje al frente, proyectado al piso), antes y ahora: con el cuerpo
    // ladeado, la cadera no gira sobre un eje vertical y el rumbo no cambia exactamente lo que cambia la cadera
    const heading = (P) => {
      const o = rot(toBody([0, 0, 0], ...P.J[a]), P.r, P.q), f = rot(toBody([0, 0, 1], ...P.J[a]), P.r, P.q);
      return Math.atan2(f[0] - o[0], f[2] - o[2]);
    };
    st.yaw += heading(st.prev) - heading(now);
    const after = world(now, st.yaw, st.x, st.z);
    st.x += before[0] - after[0];
    st.z += before[1] - after[1];
  }
  st.anchor = a;
  st.prev = now;
  rb.anchor = a;
  st.prevHip = [hipL, hipR];
  rb.root.position.set(st.x, 0, st.z);
  rb.root.rotation.y = st.yaw;
  return planted;
}

// ---- solo para la vista (navegador) ----

/** Indicadores: abanico de color desde 90° hasta el ángulo actual de cada servo. s = ángulos que se ven. */
export function updateGauges(rb, s, signs) {
  for (const g of rb.G) {
    const a = (s[g.idx] - 90) * signs[g.idx] * d2r;
    if (g.last === a) continue;
    g.last = a;
    // cadera: el anillo está acostado (−90° en X): el frente (+Z) queda en −π/2; pie: arriba (+Y) en π/2
    const start = g.horiz ? -Math.PI / 2 : Math.PI / 2;
    g.fill.geometry.dispose();
    g.fill.geometry = Math.abs(a) < 1e-3 ? new THREE.BufferGeometry()
      : new THREE.RingGeometry(0.15, g.R - 0.06, 48, 1, a > 0 ? start : start + a, Math.abs(a));
    g.needle.rotation.z = g.horiz ? a + Math.PI : a;
  }
  for (const k of ['L', 'R']) rb.legs[k].sensors.forEach((m, i) => {
    const c = rb.floor[k][i] ? 0x55ff88 : 0xff4d4d;
    m.material.color.setHex(c);
    m.material.emissive.setHex(c);
  });
}

export function showGauges(rb, on) {
  for (const g of rb.G) g.group.visible = on;
}

export function setXray(rb, on) {
  for (const m of rb.shells) {
    m.transparent = on;
    m.opacity = on ? 0.14 : 1;
    m.depthWrite = !on;
    m.needsUpdate = true;
  }
  for (const m of rb.internals) m.visible = on;
}

/** Separar piezas (0..1): la cabeza sube, las piernas se abren y los pies bajan. */
export function setExplode(rb, e) {
  rb.explode = e;
  rb.head.position.y = e * 3.2;
  for (const k of ['L', 'R']) {
    const lg = rb.legs[k];
    lg.legVis.position.set(SIDE[k] * e * 1.1, -e * 0.5, 0);
    lg.footVis.position.y = -e * 1.6;
  }
  rb.lift = e * 2.2;
}

export function updateFace(rb, dt, look) {
  if (rb.face) drawFace(rb.face, dt, look);
}
