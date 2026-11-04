import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { parseMot, timeline, frameName, gaitSupported, POSE, TS_MS, buildMot, validate, toAnim, fromAnim, scaleTime, mirror,
  scaleAmplitude } from './engine.js';
import { setupEditor } from './editor.js';
import { buildRobot, applyPose, updateGauges, setXray, setExplode, updateFace, attachModel, showGauges } from './robot.js';

const $ = (id) => document.getElementById(id);
const COLORS = ['#ff6b6b', '#ffc861', '#38e1ff', '#9d7bff'];
const NAMES = ['S0 cadera izq.', 'S1 cadera der.', 'S2 pie izq.', 'S3 pie der.'];

// ---- escena ----
const view = $('view');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
view.appendChild(renderer.domElement);
const scene = new THREE.Scene();
const BG = 0x0d1015;
scene.background = new THREE.Color(BG);
scene.fog = new THREE.FogExp2(BG, 0.016);
scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.45;
const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 500);
camera.position.set(13, 9, 15);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 4.2, 0);
controls.enableDamping = true;
controls.maxPolarAngle = Math.PI * 0.495;
controls.minDistance = 6;
controls.maxDistance = 80;

scene.add(new THREE.HemisphereLight(0xcfe0ff, 0x101317, 0.5));
const sun = new THREE.DirectionalLight(0xffffff, 2.2);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -10, right: 10, top: 10, bottom: -10, near: 1, far: 60 });
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.03;
sun.shadow.radius = 5;
scene.add(sun, sun.target);
const rim = new THREE.DirectionalLight(0x6fdcff, 0.9);
scene.add(rim, rim.target);

const ground = new THREE.Mesh(new THREE.CircleGeometry(150, 96), new THREE.MeshStandardMaterial({ color: 0x151920, roughness: 0.92 }));
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);
const grid = new THREE.GridHelper(160, 80, 0x2b3542, 0x1d242d);
grid.position.y = 0.005;
grid.material.transparent = true;
grid.material.opacity = 0.7;
scene.add(grid);

const rb = buildRobot();
scene.add(rb.root);
const trailPts = [];
const trailGeo = new THREE.BufferGeometry();
const trail = new THREE.Line(trailGeo, new THREE.LineBasicMaterial({ color: 0x38e1ff, transparent: true, opacity: 0.5 }));
trail.position.y = 0.02;
scene.add(trail);

// huellas: cada vez que un pie vuelve a tocar el piso
const prints = new THREE.Group();
scene.add(prints);
const printGeo = (() => {
  const w = 3.35, d = 3.8, r = 0.7, sh = new THREE.Shape();
  sh.moveTo(-w / 2 + r, -d / 2); sh.lineTo(w / 2 - r, -d / 2); sh.quadraticCurveTo(w / 2, -d / 2, w / 2, -d / 2 + r);
  sh.lineTo(w / 2, d / 2 - r); sh.quadraticCurveTo(w / 2, d / 2, w / 2 - r, d / 2); sh.lineTo(-w / 2 + r, d / 2);
  sh.quadraticCurveTo(-w / 2, d / 2, -w / 2, d / 2 - r); sh.lineTo(-w / 2, -d / 2 + r); sh.quadraticCurveTo(-w / 2, -d / 2, -w / 2 + r, -d / 2);
  const g = new THREE.ShapeGeometry(sh, 6);
  g.rotateX(-Math.PI / 2);
  return g;
})();
let prevContact = { L: false, R: false };
const tmpV = new THREE.Vector3();
function footprints() {
  if ($('trail').checked) for (const k of ['L', 'R']) {
    if (!rb.contact[k] || prevContact[k]) continue;
    rb.root.updateMatrixWorld(true);
    rb.legs[k].foot.getWorldPosition(tmpV);
    const m = new THREE.Mesh(printGeo, new THREE.MeshBasicMaterial({ color: k === 'L' ? 0x38e1ff : 0x9d7bff, transparent: true, opacity: 0.3, depthWrite: false }));
    m.position.set(tmpV.x, 0.012 + (prints.children.length % 50) * 1e-4, tmpV.z);
    m.rotation.y = st.yaw + rb.legs[k].hip.rotation.y;
    prints.add(m);
    while (prints.children.length > 40) { const o = prints.children[0]; o.material.dispose(); prints.remove(o); }
    prints.children.forEach((o, i, a) => { o.material.opacity = 0.03 + 0.15 * ((i + 1) / a.length); });
  }
  prevContact = { ...rb.contact };
}

// postproceso: el bloom hace brillar los ojos, los aros de los servos y los sensores
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
composer.addPass(new UnrealBloomPass(new THREE.Vector2(256, 256), 0.42, 0.35, 1.6));
composer.addPass(new OutputPass());

function resize() {
  const w = view.clientWidth, h = view.clientHeight;
  renderer.setSize(w, h);
  composer.setSize(w, h);
  camera.aspect = w / h;
  camera.fov = w / h < 1 ? 50 : 35;   // celular vertical: lente más abierto
  camera.updateProjectionMatrix();
  drawChart();
}
window.addEventListener('resize', resize);

// ---- sentido de cada servo (se guarda en el navegador) ----
// Medido en el robot (2026-10-30): los cuatro invertidos. Así explore_foward avanza, explore_back_away retrocede,
// explore_turn_left/right giran a su lado y explore_foward1 levanta primero el pie derecho, como EMO.
let signs = [-1, -1, -1, -1];
try { const s = JSON.parse(localStorage.getItem('mot3d.signs.v4')); if (Array.isArray(s) && s.length === 4) signs = s; } catch {}
$('signs').innerHTML = NAMES.map((n, i) =>
  `<label><input type="checkbox" data-i="${i}" ${signs[i] < 0 ? 'checked' : ''}/> invertir <b style="color:${COLORS[i]}">${n}</b></label>`).join('<br>');
$('signs').addEventListener('change', (e) => {
  const i = +e.target.dataset.i;
  signs[i] = e.target.checked ? -1 : 1;
  try { localStorage.setItem('mot3d.signs.v4', JSON.stringify(signs)); } catch {}
  redraw();
});

// ---- vistas, rayos X, separar, ángulos ----
// piso: de frente al ras del suelo (para ver el contacto; solo con ?vista=piso)
const VIEWS = { tres: [13, 9, 15], frente: [0, 4.5, 21], lado: [21, 4.5, 0], arriba: [0, 24, 0.01], piso: [0, -3.4, 24] };
let camAnim = null;
document.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => {
  const [x, y, z] = VIEWS[b.dataset.view];
  const v = new THREE.Vector3(x, y, z);
  if (b.dataset.view !== 'tres') v.applyAxisAngle(new THREE.Vector3(0, 1, 0), st.yaw);
  camAnim = { from: camera.position.clone().sub(controls.target), to: v, t: 0 };
  // desde arriba la cabeza tapa las piernas: rayos X
  if (b.dataset.view === 'arriba' && !$('xray').checked) { $('xray').checked = true; setXray(rb, true); }
}));
$('xray').addEventListener('change', (e) => setXray(rb, e.target.checked));
$('gauges').addEventListener('change', (e) => showGauges(rb, e.target.checked));
$('explode').addEventListener('input', (e) => { setExplode(rb, +e.target.value); redraw(); });
$('exag').addEventListener('change', redraw);

// ---- archivos ----
let files = [];      // { name, frames, tl, dur, kinds }
let cur = null, cursor = 0, playing = false, lastT = 0, acc = 0;
const st = { x: 0, z: 0, yaw: 0, prevHip: null };

async function load(list) {
  // .mot, y también los nombres que el SPIFFS cortó a 32 caracteres (….m, ….mo)
  const mots = [...list].filter((f) => /\.(mot|mo|m)$/i.test(f.name));
  files = [];
  for (const f of mots) {
    const { frames, bad } = parseMot(new Uint8Array(await f.arrayBuffer()));
    files.push(entry(f.name.replace(/\.(mot|mo|m)$/i, ''), frames, bad));
  }
  files.sort((a, b) => a.name.localeCompare(b.name));
  renderList();
  if (files.length) select(files.find((f) => f.name.startsWith('explore_foward')) ?? files[0]);
}
$('dir').addEventListener('change', (e) => load(e.target.files));
$('files').addEventListener('change', (e) => load(e.target.files));
$('search').addEventListener('input', renderList);

function entry(name, frames, bad = 0) {
  const e = { name, frames, orig: frames, bad, edited: false };
  refresh(e);
  return e;
}

function refresh(e) {
  e.tl = timeline(e.frames);
  e.dur = e.tl.length * TS_MS;
  e.kinds = [...new Set(e.frames.filter((x) => x.type !== POSE).map(frameName))];
  e.errs = validate(e.frames);
}

function renderList() {
  const q = $('search').value.trim().toLowerCase().replace(/\*/g, '');
  $('list').innerHTML = files.filter((f) => !q || f.name.toLowerCase().includes(q)).map((f) =>
    `<div class="f ${f === cur ? 'on' : ''}" data-n="${f.name}"><span>${f.edited ? '✎ ' : ''}${f.name}${f.kinds.length ? ` <span class="tag">${f.kinds.join(', ')}</span>` : ''}${f.bad ? ' ⚠' : ''}</span><small>${(f.dur / 1000).toFixed(1)} s</small></div>`).join('') ||
    '<p class="hint">Sin archivos.</p>';
}
$('list').addEventListener('click', (e) => {
  const d = e.target.closest('.f');
  if (!d) return;
  select(files.find((f) => f.name === d.dataset.n));
  if (window.matchMedia('(max-width: 760px)').matches) $('stage').scrollIntoView({ behavior: 'smooth' });
});

function select(f) {
  cur = f;
  try { history.replaceState(null, '', `#${encodeURIComponent(f.name)}`); } catch {}
  renderList();
  goHome();
  seek(0);
  drawChart();
}

function goHome() {
  Object.assign(st, { x: 0, z: 0, yaw: 0, prevHip: null });
  trailPts.length = 0;
  prevContact = { L: false, R: false };
  for (const o of [...prints.children]) { o.material.dispose(); prints.remove(o); }
}

// ---- tarjetas: ángulo de cada servo y los cuatro sensores de piso ----
$('dials').innerHTML = NAMES.map((n, i) => `<div class="dial" style="--c:${COLORS[i]}"><small>${n}</small><b id="dv${i}">90°</b><i><u id="db${i}"></u></i></div>`).join('') +
  '<div class="dial floor"><small>piso</small><span id="fl"></span></div>';
function updateDials(s) {
  s.forEach((a, i) => {
    $(`dv${i}`).textContent = `${Math.round(a)}°`;
    const d = Math.max(-1, Math.min(1, (a - 90) / 45));
    $(`db${i}`).style.cssText = d >= 0 ? `left:50%;width:${d * 50}%` : `left:${50 + d * 50}%;width:${-d * 50}%`;
  });
  const f = rb.floor, dot = (ok, t) => `<em class="${ok ? 'ok' : 'air'}">${t}</em>`;
  $('fl').innerHTML = `${dot(f.L[0], 'I adel.')}${dot(f.L[1], 'I atrás')}${dot(f.R[0], 'D adel.')}${dot(f.R[1], 'D atrás')}`;
}

// ---- reproducción ----
// "exagerar" agranda los ángulos alrededor de 90° solo para verlos mejor; las tarjetas muestran los reales
const shown = (s) => { const k = +$('exag').value; return k === 1 ? s : s.map((a) => 90 + (a - 90) * k); };
function step(s) { const p = applyPose(rb, shown(s), st, signs); footprints(); return p; }
function redraw() { if (cur) seek(cursor, true); else idle(); }
function idle() { applyPose(rb, [90, 90, 90, 90], st, signs); updateGauges(rb, [90, 90, 90, 90], signs); updateDials([90, 90, 90, 90]); }

function seek(i, redo = false) {
  if (!cur || !cur.tl.length) return;
  const n = cur.tl.length;
  if (redo || i < cursor || i === 0) {   // hacia atrás: se recalcula el camino desde el principio
    goHome();
    for (let k = 0; k < i; k++) step(cur.tl[k].s);
  } else {
    for (let k = cursor + 1; k < i; k++) step(cur.tl[k].s);
  }
  cursor = Math.max(0, Math.min(n - 1, i));
  const smp = cur.tl[cursor];
  const planted = step(smp.s);
  updateGauges(rb, shown(smp.s), signs);
  updateDials(smp.s);
  if ($('trail').checked) {
    trailPts.push(new THREE.Vector3(st.x, 0, st.z));
    if (trailPts.length > 5000) trailPts.shift();
  }
  trailGeo.setFromPoints($('trail').checked ? trailPts : []);
  const f = cur.frames[smp.k];
  let extra = '';
  if (gaitSupported(f.type)) {
    const [p0, b7, b8, b9, dir, b11, b12] = f.gp;
    extra = `\nciclos ${p0 / 10}  T ${f.ms} ms  dirección ${dir}${f.type === 1 ? (dir === 1 || dir === 101 ? ' (adelante?)' : dir === 2 || dir === 102 ? ' (atrás?)' : '') : ''}` +
      `\nbytes 7–12: ${b7} ${b8} ${b9} ${dir} ${b11} ${b12}`;
  }
  const deg = (r) => (r * 180 / Math.PI).toFixed(1);
  $('info').textContent = `${cur.name}\ncuadro ${smp.k + 1}/${cur.frames.length}: ${frameName(f)}${f.type === POSE ? ` → ${f.s.join(' / ')} en ${f.ms} ms` : ''}${extra}` +
    `\n\nt = ${(smp.t / 1000).toFixed(2)} s de ${(cur.dur / 1000).toFixed(2)} s\n` +
    smp.s.map((a, j) => `${NAMES[j]}: ${Math.round(a)}°`).join('\n') +
    `\napoyo: ${planted === 'both' ? 'los dos pies' : planted === 'L' ? 'pie izquierdo' : 'pie derecho'}` +
    `\ncuerpo: ladeo ${deg(rb.body.rotation.z)}°, cabeceo ${deg(rb.body.rotation.x)}°` +
    `\ncamino: ${st.z.toFixed(1)} cm al frente, ${st.x.toFixed(1)} de lado, rumbo ${deg(st.yaw)}°` +
    (+$('exag').value > 1 ? `\n(vista exagerada ×${$('exag').value}; los números son los reales)` : '');
  $('hud').textContent = `${cur.name} — ${(smp.t / 1000).toFixed(2)} s`;
  drawChart();
  editor.render();
}

$('play').addEventListener('click', () => { playing = !playing; $('play').textContent = playing ? '⏸' : '▶'; acc = 0; });
$('restart').addEventListener('click', () => seek(0));
$('home').addEventListener('click', () => { goHome(); seek(cursor); });
$('prev').addEventListener('click', () => { if (!cur) return; const k = cur.tl[cursor].k; const i = cur.tl.findIndex((x) => x.k === Math.max(0, k - 1)); seek(i); });
$('next').addEventListener('click', () => { if (!cur) return; const k = cur.tl[cursor].k; const i = cur.tl.findIndex((x) => x.k === k + 1); if (i >= 0) seek(i); });
$('trail').addEventListener('change', () => seek(cursor, true));
window.addEventListener('keydown', (e) => { if (e.code === 'Space' && e.target === document.body) { e.preventDefault(); $('play').click(); } });

function tick(now) {
  const dt = Math.min(0.1, (now - lastT) / 1000);
  if (playing && cur) {
    acc += dt * 1000 * +$('speed').value;
    while (acc >= TS_MS) {
      acc -= TS_MS;
      if (cursor + 1 < cur.tl.length) seek(cursor + 1);
      else if ($('loop').checked) seek(0);
      else { playing = false; $('play').textContent = '▶'; break; }
    }
  }
  lastT = now;
  // la cámara sigue al robot sin perder el ángulo que eligió el usuario
  const delta = new THREE.Vector3(st.x, 4.2 + rb.explode * 2, st.z).sub(controls.target).multiplyScalar(Math.min(1, dt * 4));
  controls.target.add(delta);
  camera.position.add(delta);
  if (camAnim) {
    camAnim.t = Math.min(1, camAnim.t + dt * 1.8);
    const e = 1 - Math.pow(1 - camAnim.t, 3);
    const off = camAnim.from.clone().lerp(camAnim.to, e).setLength(THREE.MathUtils.lerp(camAnim.from.length(), camAnim.to.length(), e));
    camera.position.copy(controls.target).add(off);
    if (camAnim.t >= 1) camAnim = null;
  }
  controls.update();
  const c = rb.root.position;
  sun.position.set(c.x + 7, 16, c.z + 9); sun.target.position.copy(c);
  rim.position.set(c.x - 6, 7, c.z - 10); rim.target.position.copy(c);
  const s = cur && cur.tl.length ? cur.tl[cursor].s : [90, 90, 90, 90];
  updateFace(rb, dt, { x: Math.max(-1, Math.min(1, (s[0] + s[1] - 180) / 30)), y: 0 });
  composer.render();
  requestAnimationFrame(tick);
}

// ---- gráfica S0..S3 contra el tiempo ----
const chart = $('chart');
function drawChart() {
  const ctx = chart.getContext('2d');
  const w = (chart.width = chart.clientWidth), h = chart.height;
  ctx.fillStyle = '#0d1015';
  ctx.fillRect(0, 0, w, h);
  if (!cur || !cur.tl.length) return;
  const n = cur.tl.length, y = (a) => h - 10 - ((a - 0) / 180) * (h - 20);
  ctx.strokeStyle = '#2c323c';
  for (const a of [0, 45, 90, 135, 180]) { ctx.beginPath(); ctx.moveTo(0, y(a)); ctx.lineTo(w, y(a)); ctx.stroke(); }
  // cuadros de marcha sombreados
  ctx.fillStyle = 'rgba(255,200,97,0.08)';
  cur.tl.forEach((s, i) => { if (s.gait) ctx.fillRect((i / n) * w, 0, w / n + 1, h); });
  ctx.lineWidth = 1.5;
  for (let j = 0; j < 4; j++) {
    ctx.strokeStyle = COLORS[j];
    ctx.beginPath();
    cur.tl.forEach((s, i) => { const px = (i / n) * w; i ? ctx.lineTo(px, y(s.s[j])) : ctx.moveTo(px, y(s.s[j])); });
    ctx.stroke();
  }
  ctx.lineWidth = 1;
  ctx.fillStyle = '#dfe4ea';
  ctx.fillRect((cursor / n) * w, 0, 1.5, h);
}
chart.addEventListener('click', (e) => { if (cur) seek(Math.round((e.offsetX / chart.clientWidth) * (cur.tl.length - 1))); });

// ---- editor (editor.js) ----
const editor = setupEditor({
  $, engine: { buildMot, validate, toAnim, fromAnim, scaleTime, mirror, scaleAmplitude, parseMot },
  get: () => ({ cur, cursor, files }),
  change(frames, keepK) {
    cur.frames = frames;
    cur.edited = true;
    refresh(cur);
    renderList();
    const i = cur.tl.findIndex((x) => x.k === Math.min(keepK, cur.frames.length - 1));
    cursor = 0;
    seek(Math.max(0, i));
  },
  revert() { cur.frames = cur.orig; cur.edited = false; refresh(cur); renderList(); cursor = 0; seek(0); },
  add(name, frames) { const e = entry(name, frames); e.edited = true; files.unshift(e); select(e); },
});

// Abierto con serve.mjs (p. ej. desde el celular por Tailscale): los .mot vienen de la PC, sin elegir carpeta
// modelo CAD articulado (privado: lo da serve.mjs desde emo_tools; si no está, quedan las piezas dibujadas)
async function loadModel() {
  if (location.protocol === 'file:' || Q.get('modelo') === '0') return;
  try {
    const g = await new GLTFLoader().loadAsync('./modelo.glb');
    if (attachModel(rb, g.scene)) $('hud').dataset.modelo = '1';
  } catch (err) { console.warn('modelo CAD:', err); }
}

const startHash = location.hash;   // load() elige un archivo y cambia el #: se guarda el del enlace antes
async function loadFromServer() {
  if (location.protocol === 'file:') return;
  try {
    const r = await fetch('./mot/index.json');
    if (!r.ok) return;
    const names = await r.json();
    if (!names.length) return;
    $('note').textContent = `Cargando ${names.length} .mot de la PC…`;
    const list = await Promise.all(names.map(async (n) => {
      const b = await (await fetch(`./mot/${encodeURIComponent(n)}`)).arrayBuffer();
      return { name: n, arrayBuffer: async () => b };
    }));
    await load(list);
    $('note').textContent = `${files.length} .mot leídos de la PC (solo lectura).`;
    fromHash(startHash);
  } catch {}
}

// enlace directo: #nombre o #nombre@segundos (p. ej. #explore_foward1@1.2)
function fromHash(h = location.hash) {
  const m = /^#([^@]+)(?:@([\d.]+))?$/.exec(h);
  const f = m && files.find((x) => x.name === decodeURIComponent(m[1]));
  if (!f) return;
  select(f);
  if (m[2]) seek(Math.round((+m[2] * 1000) / TS_MS));
}
window.addEventListener('hashchange', () => fromHash());

// opciones en la dirección: ?xray=1&sep=0.6&exag=2&vista=frente&angulos=0
const Q = new URLSearchParams(location.search);
if (Q.get('xray') === '1') { $('xray').checked = true; setXray(rb, true); }
if (Q.get('angulos') === '0') { $('gauges').checked = false; $('gauges').dispatchEvent(new Event('change')); }
if (Q.has('sep')) { $('explode').value = Q.get('sep'); setExplode(rb, +Q.get('sep')); }
if (['1', '2', '3'].includes(Q.get('exag'))) $('exag').value = Q.get('exag');
if (Q.has('vista')) {
  const b = document.querySelector(`[data-view="${Q.get('vista')}"]`);
  if (b) b.click();
  else if (VIEWS[Q.get('vista')]) camera.position.copy(controls.target).add(new THREE.Vector3(...VIEWS[Q.get('vista')]));
}

resize();
idle();
lastT = performance.now();
requestAnimationFrame(tick);
const modelReady = loadModel();
const filesReady = loadFromServer();
// ?verificar=1: revisa la mecánica en todos los .mot con lo que se dibuja (verify.js); resultado en window.__verif
if (Q.get('verificar') === '1' || Q.get('medir') === '1') (async () => {
  if (Q.get('medir') === '1') { await modelReady; await filesReady; const t0 = performance.now(), st2 = { x: 0, z: 0, yaw: 0, prevHip: null }; let n = 0; for (const s of timeline(files.find((f) => f.name === 'd2_WontLetGo').frames)) { applyPose(rb, s.s, st2, signs); n++; } window.__medir = { suela: rb.solePts.L.length, pie: rb.footPts.L.length, muestras: n, ms_por_muestra: (performance.now() - t0) / n }; return; }
  await modelReady; await filesReady;
  window.__rb = rb;
  const { verify } = await import('./verify.js');
  const out = await verify({ files, rb, applyPose, signs, progress: (r) => { $('note').textContent = `verificando… ${r.archivos}/${files.length}`; } });
  window.__verif = out;
  $('note').textContent = 'verificación lista';
})();
