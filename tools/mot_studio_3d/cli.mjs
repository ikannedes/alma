#!/usr/bin/env node
// mot-studio 3D por línea de comandos: para escribir y revisar animaciones sin abrir el navegador.
//   node cli.mjs info <archivo.mot|archivo.json>          resumen, validación y cuánto avanza y gira (modelo aproximado)
//   node cli.mjs to-mot <entrada.json> <salida.mot>         valida y escribe el .mot
//   node cli.mjs to-json <entrada.mot> <salida.json>        el .mot en formato alma-anim/1
import fs from 'node:fs';
import path from 'node:path';
import { parseMot, timeline, frameName, buildMot, validate, toAnim, fromAnim, POSE, TS_MS, S_RANGE } from './src/engine.js';
import { buildRobot, applyPose } from './src/robot.js';

const SIGNS = [-1, -1, -1, -1];   // como el visor por omisión: medido en el robot el 2026-10-30

function load(file) {
  if (/\.json$/i.test(file)) {
    const anim = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { name: anim.nombre || path.basename(file, '.json'), frames: fromAnim(anim) };
  }
  const { frames, bad } = parseMot(new Uint8Array(fs.readFileSync(file)));
  if (bad) throw new Error(`${file}: ${bad} registros inválidos`);
  return { name: path.basename(file).replace(/\.(mot|mo|m)$/i, ''), frames };
}

function info({ name, frames }) {
  const tl = timeline(frames), errs = validate(frames);
  const kinds = {};
  frames.forEach((f) => { const k = frameName(f); kinds[k] = (kinds[k] ?? 0) + 1; });
  const lo = [180, 180, 180, 180], hi = [0, 0, 0, 0];
  tl.forEach((s) => s.s.forEach((a, i) => { lo[i] = Math.min(lo[i], a); hi[i] = Math.max(hi[i], a); }));
  const rb = buildRobot(), st = { x: 0, z: 0, yaw: 0, prevHip: null };
  for (const s of tl) applyPose(rb, s.s, st, SIGNS);
  const names = ['S0 cadera izq.', 'S1 cadera der.', 'S2 pie izq.', 'S3 pie der.'];
  console.log(`${name}: ${frames.length} cuadros (${Object.entries(kinds).map(([k, n]) => `${n} ${k}`).join(', ')}), ${(tl.length * TS_MS / 1000).toFixed(2)} s`);
  names.forEach((n, i) => console.log(`  ${n.padEnd(15)} ${Math.round(lo[i])}–${Math.round(hi[i])}°  (permitido ${S_RANGE[i][0]}–${S_RANGE[i][1]})`));
  console.log(`  modelo aproximado: avanza ${st.z.toFixed(1)} cm, de lado ${st.x.toFixed(1)} cm, gira ${(st.yaw * 180 / Math.PI).toFixed(0)}° (+ = izquierda)`);
  console.log(errs.length ? `  NO VÁLIDO:\n${errs.map((e) => `    cuadro ${e.k + 1}: ${e.msg}`).join('\n')}` : '  válido');
  return errs.length === 0;
}

const [cmd, a, b] = process.argv.slice(2);
try {
  if (cmd === 'info' && a) process.exit(info(load(a)) ? 0 : 1);
  if (cmd === 'to-mot' && a && b) {
    const m = load(a);
    if (!info(m)) process.exit(1);
    fs.writeFileSync(b, buildMot(m.frames));
    const back = parseMot(new Uint8Array(fs.readFileSync(b)));
    if (back.bad || back.frames.length !== m.frames.length) throw new Error('el .mot escrito no se vuelve a leer igual');
    console.log(`  escrito ${b} (${m.frames.length * 20} bytes)`);
    process.exit(0);
  }
  if (cmd === 'to-json' && a && b) {
    const m = load(a);
    fs.writeFileSync(b, JSON.stringify(toAnim(m.name, m.frames), null, 1));
    console.log(`  escrito ${b}`);
    process.exit(0);
  }
  console.log('uso: node cli.mjs info <archivo> | to-mot <in.json> <out.mot> | to-json <in.mot> <out.json>');
  process.exit(2);
} catch (err) {
  console.error(`error: ${err.message}`);
  process.exit(1);
}
