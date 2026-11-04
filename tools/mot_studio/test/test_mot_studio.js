// Pruebas de mot-studio con el mismo código del navegador: extrae el bloque <script id="mot-core"> de index.html
// y lo ejecuta en Node. Los .mot (de Living AI, R5) se leen de emo_backup y lo exportado va a una carpeta temporal.
//
// Uso: node test_mot_studio.js <carpeta_mot> <mot_tool.json> <dir_salida_temporal>
// 1. parse JS = mot_tool.parse en todos los archivos;  2. exportar sin cambios = bytes originales;
// 3. ediciones (escalar, espejar, encadenar, insertar, duplicar, borrar) válidas y exportadas a <dir>/editado_*.mot
//    para que test.sh las pase por mot_tool.py;  4. el validador detecta ángulos y duraciones fuera de rango.
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const m = html.match(/<script id="mot-core">([\s\S]*?)<\/script>/);
if (!m) throw new Error("no encuentro <script id=\"mot-core\"> en index.html");
const ctx = { Uint8Array, Array, Object, Number, Math, Error, JSON };
vm.createContext(ctx);
vm.runInContext(m[1], ctx);
const C = ctx.MotCore;

const [dir, refPath, outDir] = process.argv.slice(2);
const ref = JSON.parse(fs.readFileSync(refPath, "utf8"));
let checks = 0, fails = 0;
const check = (ok, msg) => { checks++; if (!ok) { fails++; console.log("FALLA:", msg); } };
const plain = (frames) => JSON.parse(JSON.stringify(frames));   // los objetos del contexto vm a JSON comparable

const names = fs.readdirSync(dir).filter((n) => /\.(mot|mo|m)$/.test(n)).sort();
check(names.length === 317, `317 archivos (hay ${names.length})`);
let frames = 0, sameParse = 0, sameBytes = 0;
const data = {};
for (const n of names) {
  const bytes = new Uint8Array(fs.readFileSync(path.join(dir, n)));
  data[n] = bytes;
  let js;
  try { js = plain(C.parse(bytes)); } catch (e) { js = { error: e.message }; }
  if (JSON.stringify(js) === JSON.stringify(ref[n])) sameParse++;
  else check(false, `${n}: parse distinto de mot_tool`);
  if (js.error) continue;
  frames += js.length;
  const out = C.serialize(C.parse(bytes));
  if (out.length === bytes.length && out.every((b, i) => b === bytes[i])) sameBytes++;
  else check(false, `${n}: exportar sin cambios no da los mismos bytes`);
  check(C.validate(C.parse(bytes)).length === 0, `${n}: un original no debería tener errores de rango`);
}
check(sameParse === 317, `parse idéntico en ${sameParse}/317`);
check(sameBytes === 317, `bytes idénticos al exportar sin cambios en ${sameBytes}/317`);
console.log(`parse JS = mot_tool.parse: ${sameParse}/317 archivos, ${frames} cuadros`);
console.log(`exportar sin cambios = original: ${sameBytes}/317`);

// ---- ediciones ----
fs.mkdirSync(outDir, { recursive: true });
const dance = C.parse(data["d1_EmoDance.mot"]);
const turn = C.parse(data["ttt_my_turn.mot"]);
const walk = C.parse(data[names.find((n) => C.parse(data[n]).some((f) => f.mode === "paso"))]);

let ed = C.scale(dance, 0.5);
ed = C.mirror(ed);
ed = C.concat([ed, turn, walk]);
ed.splice(1, 0, { type: 2, mode: "pose", gait: [0, 0, 0, 0, 0], s: [90, 90, 90, 90], ms: 500 });   // insertar
ed.splice(3, 0, C.clone([ed[2]])[0]);                                                              // duplicar
ed.splice(5, 1);                                                                                   // borrar
ed[0].s[0] = 100; ed[0].ms = 1200;                                                                 // editar
check(C.validate(ed).length === 0, "la edición combinada debería ser válida: " + JSON.stringify(plain(C.validate(ed)).slice(0, 3)));
const edBytes = C.serialize(ed);
check(plain(C.parse(edBytes)).length === ed.length, "lo exportado se vuelve a leer igual");
fs.writeFileSync(path.join(outDir, "editado_combinado.mot"), edBytes);

// Ediciones no tocan paso y giro
const stepsBefore = JSON.stringify(plain(walk));
check(JSON.stringify(plain(C.mirror(C.scale(walk, 0.3)).filter((f) => f.mode !== "pose"))) ===
      JSON.stringify(plain(walk).filter((f) => f.mode !== "pose")), "espejar y escalar no tocan paso y giro");
check(JSON.stringify(plain(walk)) === stepsBefore, "las ediciones no modifican el original");
// espejar dos veces = original; escalar ×1 = original
check(JSON.stringify(plain(C.mirror(C.mirror(dance)))) === JSON.stringify(plain(dance)), "espejar dos veces devuelve el original");
check(JSON.stringify(plain(C.scale(dance, 1))) === JSON.stringify(plain(dance)), "escalar ×1 devuelve el original");
const mir = C.mirror(turn);
check(mir[0].s.join() === [turn[0].s[1], turn[0].s[0], turn[0].s[3], turn[0].s[2]].join(), "espejar intercambia S0/S1 y S2/S3");
check(C.scale(turn, 0.5)[0].s.join() === "85,90,95,85", "escalar 0.5 alrededor de 90° (80,90,100,80 → 85,90,95,85)");
fs.writeFileSync(path.join(outDir, "editado_espejado_escalado.mot"), C.serialize(C.scale(C.mirror(dance), 0.8)));

// ---- validador ----
const bad = C.clone(turn);
bad[0].s[1] = 140;   // S1 observado 53–130
bad[1].ms = 30;      // < 40 ms
const errs = plain(C.validate(bad));
check(errs.some((e) => e.field === "s1" && e.frame === 0), "detecta S1 fuera de rango");
check(errs.some((e) => e.field === "ms" && e.frame === 1), "detecta duración fuera de 40–6400 ms");
const big = C.scale(dance, 3);
check(C.validate(big).length > 0, "escalar ×3 saca ángulos de rango y bloquea exportar");
const stepBad = C.clone(walk);
check(C.validate(stepBad).length === 0, "los parámetros de paso (≥ 200) no se juzgan como ángulos");

// ---- poseAt ----
// ttt_my_turn: cuadro 0 = (80,90,100,80) en 400 ms, cuadro 1 = (90,90,90,90) en 400 ms
const p0 = C.poseAt(turn, 0, "linear"), p400 = C.poseAt(turn, 400, "linear"), pEnd = C.poseAt(turn, 800, "linear");
const pHold = C.poseAt(turn, 1, "hold");
check(p0.s.join() === "90,90,90,90" && p400.s.join() === "80,90,100,80" && pEnd.s.join() === "90,90,90,90",
      "lineal: parte de 90° y llega a cada pose al final de su cuadro");
check(pHold.s.join() === "80,90,100,80", "salto: toma la pose al empezar el cuadro");
check(C.poseAt(turn, 200, "linear").s[0] === 85, "lineal: a la mitad, a medio camino");

console.log(`${checks} comprobaciones, ${fails} fallas`);
process.exit(fails ? 1 : 0);
