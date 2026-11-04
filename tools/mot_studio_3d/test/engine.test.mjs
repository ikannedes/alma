// gait de mot_studio_3d contra la referencia (emo_backup/re/marcha_ref.c), muestra por muestra, en cada primitiva
// 1, 2 y 14 de los .mot. Uso: node test/engine.test.mjs <carpeta_mot> <carpeta_ref>
import fs from 'node:fs';
import path from 'node:path';
import { parseMot, gaitSamples, timeline, POSE, PAUSE, buildMot, toAnim, fromAnim, validate, mirror, scaleTime } from '../src/engine.js';

const [motDir, refDir] = process.argv.slice(2);
let files = 0, recs = 0, samples = 0, bad = 0, badDur = 0, badExport = 0, badJson = 0, invalid0 = 0, badMirror = 0;
for (const name of fs.readdirSync(motDir).filter((n) => /\.(mot|mo|m)$/.test(n)).sort()) {
  const raw = new Uint8Array(fs.readFileSync(path.join(motDir, name)));
  const { frames, bad: invalid } = parseMot(raw);
  if (invalid) { console.log(`  ${name}: ${invalid} registros inválidos`); bad++; continue; }
  files++;
  // referencia: bloques "# registro k" seguidos de "t S0 S1 S2 S3"
  const ref = {};
  let k = -1;
  for (const line of fs.readFileSync(path.join(refDir, name.replace(/\.(mot|mo|m)$/, '') + '.txt'), 'utf8').split('\n')) {
    if (line.startsWith('#')) { k++; ref[k] = []; continue; }
    const p = line.trim().split(/\s+/).map(Number);
    if (p.length === 5) ref[k].push(p.slice(1));
  }
  for (const r of gaitSamples(frames)) {
    recs++;
    const want = ref[r.k] ?? [];
    if (want.length !== r.samples.length) { bad++; if (bad < 5) console.log(`  ${name} registro ${r.k}: ${r.samples.length} muestras, referencia ${want.length}`); continue; }
    r.samples.forEach((s, i) => {
      samples++;
      if (s.some((v, j) => v !== want[i][j])) { bad++; if (bad < 5) console.log(`  ${name} registro ${r.k} muestra ${i}: ${s} / ${want[i]}`); }
    });
  }
  // duración de la línea de tiempo = poses ms + primitivas ciclos × T (±20 ms por cuadro)
  const tl = timeline(frames);
  const want = frames.reduce((a, f) => a + (f.type === POSE || f.type === PAUSE ? f.ms : (f.gp[0] * f.ms) / 10), 0);
  if (Math.abs(tl.length * 20 - want) > 20 * frames.length) badDur++;
  // exportar sin cambios = los mismos bytes; ida y vuelta por el JSON alma-anim/1 = los mismos bytes
  const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
  if (!same(buildMot(frames), raw)) { badExport++; if (badExport < 4) console.log(`  ${name}: exportar sin cambios no da los mismos bytes`); }
  const viaJson = fromAnim(JSON.parse(JSON.stringify(toAnim(name, frames))));
  if (!same(buildMot(viaJson), raw)) { badJson++; if (badJson < 4) console.log(`  ${name}: la ida y vuelta por JSON cambia bytes`); }
  if (validate(frames).length) invalid0++;
  const mm = mirror(mirror(frames));
  if (!same(buildMot(mm), raw)) badMirror++;
}
// la validación ve un ángulo fuera de rango, una duración imposible y una primitiva que se sale
const bad1 = fromAnim({ formato: 'alma-anim/1', cuadros: [{ pose: [90, 90, 160, 90], ms: 300 }, { pose: [90, 90, 90, 90], ms: 10 },
  { caminar: { ciclos: 2, T: 800, caderas: 60, pies: 10, desvio: 0, fase: 0, dir: 'adelante' } }] });
const v = validate(bad1);
const okVal = v.some((e) => e.k === 0) && v.some((e) => e.k === 1) && v.some((e) => e.k === 2);
const fast = validate(scaleTime(bad1.slice(0, 1).map((f) => ({ ...f, s: [90, 90, 90, 90] })), 0.5));
console.log(`  exportar: ${badExport} distintos; JSON ida y vuelta: ${badJson} distintos; espejar dos veces: ${badMirror} distintos; originales que no validan: ${invalid0}; validación de errores ${okVal ? 'ok' : 'FALLA'}`);
if (badExport || badJson || badMirror || !okVal || fast.length) bad++;
console.log(`  ${files} .mot, ${recs} primitivas, ${samples} muestras comparadas, ${bad} distintas; ${badDur} con duración fuera de tolerancia`);
process.exit(bad || badDur || !recs ? 1 : 0);
