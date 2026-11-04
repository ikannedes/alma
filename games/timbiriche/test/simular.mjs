// Prueba sin dependencias: node test/simular.mjs
// A) Motor: 100 partidas aleatorias por tamaño (3×3 y 4×4) aplicadas por el árbitro.
// B) Flujo completo con un puente de Alma falso (elige al azar de la lista legal, a veces se pausa o falla la red).
import assert from "node:assert/strict";
import { Timbiriche } from "../src/game/timbiriche.js";
import { crearPartida } from "../src/game/partida.js";

const PARTIDAS = 100;
const TAMANOS = [3, 4];

// Aleatorio reproducible (mulberry32).
function rng(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const elegir = (rand, xs) => xs[Math.floor(rand() * xs.length)];

// Revisa la lista legal que recibiría Alma. Devuelve la lista.
function revisarLegales(juego, cuenta) {
  const legal = juego.legales();
  const ids = new Set(legal.map((l) => l.id));
  const labels = new Set(legal.map((l) => l.label));
  assert.equal(ids.size, legal.length, "ids repetidos en un turno");
  assert.equal(labels.size, legal.length, "etiquetas repetidas en un turno");
  assert.equal(legal.length, juego.model.edgeCount - juego.board.step, "faltan o sobran jugadas legales");
  for (const l of legal) {
    assert.ok(l.id.length <= 40 && /^[hv]:r\d+c\d+$/.test(l.id), "id mal formado: " + l.id);
    if (juego.lineaPorId(l.id) !== l.edge) cuenta.idsInvalidos += 1;
  }
  cuenta.turnos += 1;
  cuenta.idsRevisados += legal.length;
  return legal;
}

// ---------- A) Motor ----------
function pruebaMotor(size, rand, cuenta) {
  const juego = new Timbiriche(size, rand() < 0.5);
  while (!juego.terminada) {
    const legal = revisarLegales(juego, cuenta);
    const pick = elegir(rand, legal);            // Alma y el dueño eligen al azar de la lista legal
    const edge = juego.lineaPorId(pick.id);
    if (edge < 0) { cuenta.idsInvalidos += 1; continue; }
    const { cierra, regala } = juego.efecto(edge);
    const quien = juego.turnoDeAlma;
    const res = juego.jugar(edge);
    // Las marcas de la etiqueta dicen la verdad.
    assert.equal(res.cajas, cierra, "cajas cerradas ≠ marca");
    assert.equal(pick.label.includes("cierra"), cierra > 0, "marca (cierra caja) incorrecta");
    assert.equal(pick.label.includes("regala"), regala > 0, "marca (regala caja) incorrecta");
    // Turno extra: cerrar caja repite; si no, cambia el turno.
    if (!res.terminada) {
      assert.equal(juego.turnoDeAlma, res.cajas > 0 ? quien : !quien, "turno extra mal aplicado");
      if (res.cajas > 0) cuenta.turnosExtra += 1;
    }
    assert.equal(juego.lineaPorId(pick.id), -1, "la línea puesta sigue libre");
  }
  const { alma, dueno } = juego.marcador();
  assert.equal(alma + dueno, size * size, "total de cajas incorrecto");
  let cajas = 0;
  for (let b = 0; b < juego.totalCajas; b += 1) if (juego.board.boxOwner(b)) cajas += 1;
  assert.equal(cajas, size * size, "quedaron cajas sin dueño");
  assert.ok(["gana_alma", "pierde_alma", "empate"].includes(juego.resultado()));
  cuenta.partidas += 1;
  cuenta.resultados[juego.resultado()] += 1;
}

// ---------- B) Flujo con puente falso ----------
function puenteFalso(rand, cuenta) {
  const p = {
    match: null, eventos: [], reintento: null, jugadas: 0, juego: null, historial: null,
    say() {}, status() {}, thinking() {},
    notice(texto, accion) { if (accion) p.reintento = accion.run; },
    async start(fresh) { assert.equal(fresh, true); p.match = { id: "m" + Math.floor(rand() * 1e9) }; p.eventos = []; return { ok: true, match: p.match }; },
    async move({ state, legal, history, ownerMoved, async, onRetry }) {
      assert.equal(async, false);
      assert.equal(typeof onRetry, "function");
      assert.ok(typeof state === "string" && state.includes("Marcador"));
      // ownerMoved: true solo justo después de una jugada del dueño.
      const ultima = history[history.length - 1];
      assert.equal(ownerMoved, !!ultima && ultima.startsWith("Dueño:"), "ownerMoved incorrecto");
      if (!ownerMoved && ultima) cuenta.llamadasExtra += 1;
      const juego = p.juego();
      assert.ok(juego.turnoDeAlma, "se pidió jugada a Alma fuera de su turno");
      const ids = new Set(legal.map((l) => l.id));
      assert.equal(ids.size, legal.length, "ids repetidos");
      for (const l of legal) if (juego.lineaPorId(l.id) < 0) cuenta.idsInvalidos += 1;
      cuenta.turnos += 1;
      cuenta.idsRevisados += legal.length;
      const x = rand();
      if (x < 0.03) { p.reintento = onRetry; cuenta.pausas += 1; return { paused: true, text: "Alma se tomó un respiro" }; }
      if (x < 0.05) { cuenta.fallosRed += 1; throw new Error("sin red"); }
      p.jugadas += 1;
      return { move: { id: elegir(rand, legal).id, reaccion: "concentrada", pensamiento: "…" } };
    },
    async event(tipo, { history }) {
      assert.ok(Array.isArray(history));
      p.eventos.push(tipo);
      return {};
    },
  };
  return p;
}

async function pruebaFlujo(size, rand, cuenta) {
  const alma = puenteFalso(rand, cuenta);
  const partida = crearPartida({ alma });
  alma.juego = () => partida.juego;
  await partida.nueva(size, rand() < 0.5);
  let vueltas = 0;
  while (!(partida.juego.terminada && !partida.ocupado && !partida.enPausa)) {
    assert.ok(++vueltas < 5000, "la partida no avanza");
    if (partida.enPausa) {
      const r = alma.reintento; alma.reintento = null;
      assert.ok(r, "en pausa sin botón Reintentar");
      await r();
      continue;
    }
    assert.ok(partida.puedeJugarDueno, "el dueño no puede jugar y nadie espera");
    const libres = partida.juego.legales();
    assert.equal(await partida.jugarDueno(elegir(rand, libres).edge), true);
  }
  const juego = partida.juego;
  const { alma: a, dueno: d } = juego.marcador();
  assert.equal(a + d, size * size, "total de cajas incorrecto");
  // Recalcula los eventos esperados desde el historial: rachas del mismo jugador = un turno.
  const h = partida.historial;
  assert.equal(h.length, juego.model.edgeCount, "historial incompleto");
  assert.equal(h.filter((e) => e.startsWith("Alma:")).length, alma.jugadas, "jugadas de Alma ≠ respuestas");
  let buenas = 0, malas = 0;
  for (let i = 0; i < h.length;) {
    const quien = h[i].split(":")[0];
    let cajas = 0;
    while (i < h.length && h[i].startsWith(quien + ":")) {
      const m = h[i].match(/cierra (\d+) caja/);
      if (m) cajas += Number(m[1]);
      i += 1;
    }
    if (cajas >= 2) quien === "Alma" ? buenas++ : malas++;
  }
  const ev = alma.eventos;
  assert.equal(ev.filter((t) => t === "buena_jugada").length, buenas, "buena_jugada mal contada");
  assert.equal(ev.filter((t) => t === "mala_jugada").length, malas, "mala_jugada mal contada");
  const finales = ev.filter((t) => ["gana_alma", "pierde_alma", "empate"].includes(t));
  assert.deepEqual(finales, [juego.resultado()], "evento final incorrecto");
  assert.equal(ev[ev.length - 1], juego.resultado(), "el evento final no es el último");
  cuenta.partidas += 1;
  cuenta.resultados[juego.resultado()] += 1;
  cuenta.buenas += buenas;
  cuenta.malas += malas;
}

const nuevaCuenta = () => ({ partidas: 0, turnos: 0, idsRevisados: 0, idsInvalidos: 0, turnosExtra: 0,
  llamadasExtra: 0, pausas: 0, fallosRed: 0, buenas: 0, malas: 0,
  resultados: { gana_alma: 0, pierde_alma: 0, empate: 0 } });

let fallo = false;
for (const size of TAMANOS) {
  const a = nuevaCuenta();
  const randA = rng(1000 + size);
  for (let i = 0; i < PARTIDAS; i += 1) pruebaMotor(size, randA, a);
  console.log(`Motor ${size}×${size}:`, JSON.stringify(a));
  const b = nuevaCuenta();
  const randB = rng(2000 + size);
  for (let i = 0; i < PARTIDAS; i += 1) await pruebaFlujo(size, randB, b);
  console.log(`Flujo ${size}×${size}:`, JSON.stringify(b));
  if (a.idsInvalidos || b.idsInvalidos || a.partidas !== PARTIDAS || b.partidas !== PARTIDAS) fallo = true;
}
// Tamaños opcionales: una pasada corta para comprobar que también terminan.
for (const size of [5, 6]) {
  const c = nuevaCuenta();
  const rand = rng(3000 + size);
  for (let i = 0; i < 10; i += 1) pruebaMotor(size, rand, c);
  console.log(`Motor ${size}×${size} (10 partidas):`, JSON.stringify(c));
  if (c.idsInvalidos) fallo = true;
}
if (fallo) { console.error("FALLÓ"); process.exit(1); }
console.log("OK: todas las simulaciones pasaron.");
