// Prueba sin navegador del control externo del lado norte (Alma) en "Batalla de torres".
// Usa la GameSession real del juego y una Alma simulada que elige al azar (uniforme)
// entre las jugadas legales que construye src/alma/norte.js.
//
// Uso:  node tests/alma-norte.test.mjs [partidasCortas=100] [ticksPorPartida=900] [partidasCompletas=2] [semillaInicial=1000]
//
// Comprueba: 0 decisiones rechazadas o inválidas, tamaño de la lista legal dentro de
// límites, ids estables y cortos, respuestas tardías ignoradas, que sin respuestas de
// Alma el norte no despliega nada (no hay bot sustituto), que la transcripción con
// órdenes norte se restaura igual, y que las partidas completas terminan.

import assert from "node:assert/strict";
import { GameSession } from "../src/sim/game-session.js";
import { evaluateDeployment } from "../src/sim/deployment.js";
import {
  ControladorNorte,
  ID_ESPERAR,
  INTERVALO_POR_DEFECTO,
  MAX_LARGO_ID,
  MAX_LEGALES,
  TICKS_MAXIMOS,
  canonico,
  construirEstado,
  construirLegales,
  crearConfiguracionAlma,
} from "../src/alma/norte.js";

const PARTIDAS_CORTAS = Number(process.argv[2] ?? 100);
const TICKS_CORTOS = Number(process.argv[3] ?? 900);
const PARTIDAS_COMPLETAS = Number(process.argv[4] ?? 2);
const SEMILLA_INICIAL = Number(process.argv[5] ?? 1_000);
const PASO = 10; // ticks por "fotograma" simulado
const FALLOS = [];

// Generador pseudoaleatorio reproducible (mulberry32).
function azar(semilla) {
  let a = semilla >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const vaciar = () => new Promise((resolve) => setImmediate(resolve));

function revisarLegales(legal) {
  assert.ok(Array.isArray(legal) && legal.length >= 1, "lista legal vacía");
  assert.ok(legal.length <= MAX_LEGALES, `lista legal demasiado larga: ${legal.length}`);
  assert.equal(legal[0].id, ID_ESPERAR, "la primera jugada debe ser esperar");
  const ids = new Set();
  for (const { id, label } of legal) {
    assert.equal(typeof id, "string");
    assert.ok(id.length > 0 && id.length <= MAX_LARGO_ID, `id fuera de límite: ${id}`);
    assert.ok(id === ID_ESPERAR || /^carta:[a-z0-9-]+@[a-z-]+$/u.test(id), `id con formato raro: ${id}`);
    assert.ok(!ids.has(id), `id repetido: ${id}`);
    ids.add(id);
    assert.ok(typeof label === "string" && label.length > 0, "etiqueta vacía");
  }
}

// El "dueño" simulado (sur) juega de vez en cuando por la ruta normal del jugador.
const ZONAS_SUR = [3_500, 6_500, 11_500, 14_500].flatMap((x) =>
  [3_500, 10_500, 14_500].map((y) => ({ x, y }))).filter((point) =>
  evaluateDeployment({ destroyedOpposingLaneTowers: [], placementClass: "ground_entity", point, side: "south" }).legal);

function jugarSur(sesion, estado, rnd, contador) {
  const energia = estado.elixir.sides.south.amount;
  const costes = new Map(estado.cardRuntime.cards.map(({ cost, id }) => [id, cost]));
  const opciones = estado.decks.south.hand
    .map((cardId, slot) => ({ cardId, slot }))
    .filter(({ cardId }) => costes.get(cardId) <= energia);
  if (opciones.length === 0) return false;
  const { cardId, slot } = opciones[Math.floor(rnd() * opciones.length)];
  const point = ZONAS_SUR[Math.floor(rnd() * ZONAS_SUR.length)];
  try {
    sesion.submitPlayerCommand(canonico({ cardId, commandId: contador.n, point, slot,
      tick: estado.tick, type: "deploy" }));
    contador.n += 1;
    return true;
  } catch {
    return false;
  }
}

/**
 * Juega una partida. modo: "azar" (Alma elige al azar) o "muda" (Alma nunca responde).
 * Devuelve estadísticas.
 */
async function jugarPartida({ semilla, limiteTicks, modo = "azar", conDueno = true }) {
  const rnd = azar(semilla * 7919 + 13);
  const sesion = new GameSession(crearConfiguracionAlma(semilla));
  const pendientes = [];
  let peticiones = 0;
  const controlador = new ControladorNorte({
    intervaloTicks: INTERVALO_POR_DEFECTO,
    pedir: (peticion) => new Promise((resolve) => {
      peticiones += 1;
      try {
        revisarLegales(peticion.legal);
        assert.ok(peticion.state.includes("energía"), "estado sin energía");
        assert.ok(peticion.state.length < 2_000, `estado demasiado largo (${peticion.state.length})`);
        assert.ok(Array.isArray(peticion.history));
      } catch (error) {
        FALLOS.push(error); // el controlador se traga los rechazos de pedir(): se revisan al final
      }
      if (modo === "muda") { pendientes.push({ tick: peticion.tick + 30, resolve, valor: null }); return; }
      const r = rnd();
      // 80 %: responde a tiempo; 10 %: llega tarde (después del siguiente ciclo); 10 %: {late:true}.
      const retraso = r < 0.8 ? Math.floor(rnd() * INTERVALO_POR_DEFECTO)
        : INTERVALO_POR_DEFECTO + Math.floor(rnd() * INTERVALO_POR_DEFECTO);
      const elegido = peticion.legal[Math.floor(rnd() * peticion.legal.length)];
      pendientes.push({ tick: peticion.tick + retraso, resolve, valor: r >= 0.9 ? null : { id: elegido.id } });
    }),
  });
  controlador.reiniciar(sesion);
  const contadorSur = { n: 0 };
  let proximoSur = 200 + Math.floor(rnd() * 120);
  let estado = sesion.state;
  while (!estado.terminal && estado.tick < limiteTicks) {
    sesion.stepMany(Math.min(PASO, limiteTicks - estado.tick, TICKS_MAXIMOS - estado.tick));
    estado = sesion.state;
    // Llegan las respuestas cuyo "retraso" ya pasó (fuera del bucle de simulación).
    for (let i = pendientes.length - 1; i >= 0; i -= 1) {
      if (pendientes[i].tick <= estado.tick) { pendientes[i].resolve(pendientes[i].valor); pendientes.splice(i, 1); }
    }
    await vaciar();
    estado = sesion.state;
    controlador.tick(sesion, estado);
    if (conDueno && !estado.terminal && estado.tick >= proximoSur) {
      jugarSur(sesion, estado, rnd, contadorSur);
      proximoSur = estado.tick + 150 + Math.floor(rnd() * 200);
    }
  }
  for (const p of pendientes) p.resolve(null);
  await vaciar();
  // Una orden admitida en el último tick se materializa en el siguiente paso.
  if (!sesion.state.terminal && sesion.state.tick < TICKS_MAXIMOS) sesion.stepMany(1);
  const stats = controlador.estadisticas;
  const transcripcion = JSON.parse(sesion.serialize()).transcript;
  const ordenesNorte = transcripcion.filter(({ type }) => type === "submit-north").length;
  const desplieguesNorte = sesion.replay.filter((evento) =>
    evento.type === "session-deployed" && evento.side === "north").length;
  return { estado: sesion.state, ordenesNorte, desplieguesNorte, peticiones, sesion, stats };
}

const inicio = Date.now();
const total = { ciclos: 0, aplicadas: 0, esperas: 0, rechazadas: 0, tardias: 0, sinRespuesta: 0,
  desconocidas: 0, maxLegales: 0, minLegales: Infinity, motivos: [] };
function sumar(stats) {
  for (const clave of ["ciclos", "aplicadas", "esperas", "rechazadas", "tardias", "sinRespuesta", "desconocidas"]) {
    total[clave] += stats[clave];
  }
  total.maxLegales = Math.max(total.maxLegales, stats.maxLegales);
  total.minLegales = Math.min(total.minLegales, stats.minLegales);
  total.motivos.push(...stats.motivos);
}

// 1) Partidas cortas con Alma al azar y dueño simulado.
for (let partida = 0; partida < PARTIDAS_CORTAS; partida += 1) {
  const r = await jugarPartida({ semilla: SEMILLA_INICIAL + partida, limiteTicks: TICKS_CORTOS });
  sumar(r.stats);
  assert.equal(r.ordenesNorte, r.stats.aplicadas, "cada jugada aplicada deja una orden norte");
  assert.ok(r.desplieguesNorte <= r.ordenesNorte, "despliegues norte sin orden de Alma");
  if (!r.estado.terminal) assert.equal(r.desplieguesNorte, r.ordenesNorte, "orden norte sin materializar");
  if (partida === 0) {
    // La transcripción con órdenes "submit-north" se restaura byte a byte.
    const bytes = r.sesion.serialize();
    assert.equal(GameSession.restore(bytes).serialize(), bytes, "la restauración no reproduce la sesión");
  }
  if ((partida + 1) % 10 === 0) {
    console.log(`  ${partida + 1}/${PARTIDAS_CORTAS} partidas cortas · ciclos ${total.ciclos} · aplicadas ${total.aplicadas} · rechazadas ${total.rechazadas} · ${((Date.now() - inicio) / 1000).toFixed(0)} s`);
  }
}

// 2) Alma muda: el norte no despliega nada (no hay bot sustituto).
{
  const r = await jugarPartida({ semilla: 77, limiteTicks: 1_200, modo: "muda" });
  assert.equal(r.desplieguesNorte, 0, "el norte desplegó sin decisiones de Alma");
  assert.equal(r.stats.aplicadas, 0);
  assert.ok(r.peticiones > 0);
  console.log(`  Alma muda: ${r.peticiones} peticiones, 0 despliegues norte`);
}

// 3) Partidas completas hasta el final (3:00 de reglamento y, si hay empate, prórroga).
for (let partida = 0; partida < PARTIDAS_COMPLETAS; partida += 1) {
  const r = await jugarPartida({ semilla: 5_000 + partida, limiteTicks: TICKS_MAXIMOS });
  sumar(r.stats);
  assert.ok(r.estado.terminal, "la partida completa no terminó");
  assert.ok(r.estado.clock.result !== null, "partida terminada sin resultado");
  const res = r.estado.clock.result;
  console.log(`  partida completa ${partida + 1}: ${res.kind} ${res.winner ?? "-"} (${res.reason}) en tick ${res.endedAtTick} · coronas Alma ${res.crowns.north} – dueño ${res.crowns.south} · cartas de Alma ${r.stats.aplicadas}`);
}

// 4) Una lista legal de ejemplo y el estado en texto.
{
  const sesion = new GameSession(crearConfiguracionAlma(3));
  sesion.stepMany(60);
  const { legal } = construirLegales(sesion.state);
  revisarLegales(legal);
  console.log(`  ejemplo: ${legal.length} jugadas legales; p. ej. ${legal[1]?.id} = "${legal[1]?.label}"`);
  console.log(construirEstado(sesion.state).split("\n").map((linea) => `    | ${linea}`).join("\n"));
}

console.log(`RESUMEN: ciclos ${total.ciclos}, aplicadas ${total.aplicadas}, esperas ${total.esperas}, sin respuesta ${total.sinRespuesta}, tardías ignoradas ${total.tardias}, rechazadas ${total.rechazadas}, desconocidas ${total.desconocidas}, tamaño legal ${total.minLegales}–${total.maxLegales}, ${((Date.now() - inicio) / 1000).toFixed(0)} s`);
assert.equal(FALLOS.length, 0, `peticiones inválidas: ${FALLOS.slice(0, 3).map((e) => e.message).join(" | ")}`);
assert.equal(total.rechazadas, 0, `decisiones rechazadas: ${total.motivos.join(" | ")}`);
assert.equal(total.desconocidas, 0, "decisiones con id desconocido");
assert.ok(total.ciclos >= 100, "menos de 100 ciclos de decisión");
assert.ok(total.aplicadas > 0, "ninguna jugada aplicada");
assert.ok(total.tardias > 0, "no se probó ninguna respuesta tardía");
console.log("OK");
