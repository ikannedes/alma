// Verificación de la mecánica con lo que de verdad se dibuja (?verificar=1). No usa las cuentas de robot.js: toma
// las mallas visibles (pies, piernas, cabeza), su envolvente convexa, y las matrices de three.js de cada muestra.
//   - piso: el punto más bajo de todo el robot debe quedar en 0 (ni metido ni flotando)
//   - resbalón: un pie apoyado y plano no se mueve sobre el piso de una muestra a la siguiente
//   - pies hacia lados opuestos: el robot queda sobre los cantos y se levanta respecto a la pose neutra
//   - pies hacia el mismo lado: el otro pie se levanta
import * as THREE from 'three';
import { ConvexHull } from 'three/examples/jsm/math/ConvexHull.js';
import { timeline } from './engine.js';
import { supportPoints } from './robot.js';

const EPS = 0.01;   // cm (0.1 mm)

// Envolvente convexa de la malla reducida a sus puntos de apoyo con 40 000 direcciones (paso ≈ 1°, error < 0.002 mm):
// más fina que la de la física (12 000) y calculada aparte, sobre cada malla que se dibuja.
function hullOf(mesh) {
  const p = mesh.geometry.attributes.position, pts = [];
  for (let i = 0; i < p.count; i++) pts.push(new THREE.Vector3().fromBufferAttribute(p, i));
  const hv = new ConvexHull().setFromPoints(pts).vertices.map(({ point: v }) => [v.x, v.y, v.z]);
  return supportPoints(hv, 40000).map(([x, y, z]) => new THREE.Vector3(x, y, z));
}

function minY(mesh, hull) {
  const e = mesh.matrixWorld.elements;
  let lo = Infinity;
  for (const p of hull) { const y = e[1] * p.x + e[5] * p.y + e[9] * p.z + e[13]; if (y < lo) lo = y; }
  return lo;
}

export async function verify({ files, rb, applyPose, signs, progress }) {
  // piezas sólidas que se ven (sin indicadores, sensores ni pantalla de ojos)
  const parts = [];
  const add = (group, kind) => group.traverseVisible((o) => {
    if (o.isMesh && !(o.material instanceof THREE.MeshBasicMaterial) && !rb.legs.L.sensors.includes(o) && !rb.legs.R.sensors.includes(o))
      parts.push({ mesh: o, kind, hull: hullOf(o) });
  });
  add(rb.head, 'cabeza');
  for (const k of ['L', 'R']) { add(rb.legs[k].legVis, `pierna_${k}`); add(rb.legs[k].footVis, `pie_${k}`); }

  const st = { x: 0, z: 0, yaw: 0, prevHip: null };
  applyPose(rb, [90, 90, 90, 90], st, signs);

  const R = {
    modelo: rb.model, piezas: parts.length, archivos: 0, muestras: 0,
    metido: { peor: 0, donde: null, muestras: 0 },          // punto más bajo < 0
    flotando: { peor: 0, donde: null, muestras: 0 },        // punto más bajo > 0
    pieza_bajo_piso: {},                                    // por pieza: peor y < 0
    resbalon: { peor: 0, donde: null },                     // pie anclado, plano, que se mueve (cm por muestra)
    arrastre: { peor: 0, donde: null, muestras: 0 },        // el otro pie, con los dos en el piso y las caderas torciéndose
    opuestos: { muestras: 0,   // pies en espejo, los dos a ≥ 5°: subida respecto a la misma postura con los pies rectos
      subida_min: Infinity, subida_max: 0, donde_min: null, sin_subir: 0 },
    mismo_lado: { muestras: 0, pie_levantado_max: 0, donde: null },
  };
  const foot = { L: new THREE.Vector3(), R: new THREE.Vector3() }, prev = { L: null, R: null };
  const up = new THREE.Vector3(), q = new THREE.Quaternion();

  for (const f of files) {
    const tl = timeline(f.frames);
    Object.assign(st, { x: 0, z: 0, yaw: 0, prevHip: null });
    prev.L = prev.R = null;
    tl.forEach((smp, i) => {
      const s = smp.s;
      const aL = (s[2] - 90) * signs[2], aR = (s[3] - 90) * signs[3];
      const mirrored = Math.abs(aL) >= 5 && Math.abs(aR) >= 5 && aL * aR < 0;
      // referencia: la misma postura de caderas con los pies rectos (con un estado aparte, sin mover el camino)
      let href = 0;
      if (mirrored) { applyPose(rb, [s[0], s[1], 90, 90], { x: 0, z: 0, yaw: 0, prevHip: null }, signs); href = rb.body.position.y; }
      applyPose(rb, s, st, signs);
      rb.root.updateMatrixWorld(true);
      const where = `${f.name} @ ${(smp.t / 1000).toFixed(2)} s (${s.map(Math.round).join('/')})`;
      let lo = Infinity;
      const low = {};
      for (const p of parts) {
        const y = minY(p.mesh, p.hull);
        low[p.kind] = Math.min(low[p.kind] ?? Infinity, y);
        lo = Math.min(lo, y);
      }
      for (const [k, y] of Object.entries(low)) if (y < -EPS) R.pieza_bajo_piso[k] = Math.min(R.pieza_bajo_piso[k] ?? 0, y);
      if (lo < -EPS) { R.metido.muestras++; if (lo < R.metido.peor) { R.metido.peor = lo; R.metido.donde = where; } }
      if (lo > EPS) { R.flotando.muestras++; if (lo > R.flotando.peor) { R.flotando.peor = lo; R.flotando.donde = where; } }

      // resbalón: un punto fijo del pie, si el pie está apoyado y plano en esta muestra y en la anterior
      for (const k of ['L', 'R']) {
        const fv = rb.legs[k].footVis;
        fv.getWorldQuaternion(q);
        const flat = up.set(0, 1, 0).applyQuaternion(q).y > Math.cos(0.5 * Math.PI / 180);
        const planted = low[`pie_${k}`] < EPS && flat;
        fv.localToWorld(foot[k].set(0, -1, 0));
        if (planted && prev[k]) {
          const d = Math.hypot(foot[k].x - prev[k].x, foot[k].z - prev[k].z), r = rb.anchor === k ? R.resbalon : R.arrastre;
          if (rb.anchor !== k && d > EPS) R.arrastre.muestras++;
          if (d > r.peor) { r.peor = d; r.donde = where; }
        }
        prev[k] = planted ? foot[k].clone() : null;
      }

      // pies inclinados: hacia lados opuestos se levanta; hacia el mismo lado un pie queda en el aire
      if (Math.abs(aL) >= 3 && Math.abs(aR) >= 3) {
        if (mirrored) {
          const rise = rb.body.position.y - href;
          R.opuestos.muestras++;
          if (rise <= EPS) R.opuestos.sin_subir++;
          if (rise < R.opuestos.subida_min) { R.opuestos.subida_min = rise; R.opuestos.donde_min = where; }
          R.opuestos.subida_max = Math.max(R.opuestos.subida_max, rise);
        } else if (aL * aR > 0) {
          const lift = Math.max(low.pie_L, low.pie_R);
          R.mismo_lado.muestras++;
          if (lift > R.mismo_lado.pie_levantado_max) { R.mismo_lado.pie_levantado_max = lift; R.mismo_lado.donde = where; }
        }
      }
      R.muestras++;
    });
    R.archivos++;
    if (progress) progress(R);
    await new Promise((r) => setTimeout(r, 0));
  }
  return R;
}
