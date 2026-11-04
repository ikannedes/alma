// Tablero de "Batalla de torres" (dentro del iframe arena.html). Sustituye al arranque
// original (src/ui/arena-shell-entry.js): monta la misma interfaz "app-frame" de Moss &
// Ember para el dueño (sur), pero con una sesión SIN bot norte, y conecta el ciclo de
// decisiones del norte con Alma a través de la página exterior (window.parent.almaTorres).

import { GameSession } from "../sim/game-session.js";
import {
  mountShippedGameBrowser,
  prepareShippedAppFrameHud,
} from "../ui/game-browser-entry.js";
import {
  ControladorNorte,
  INTERVALO_POR_DEFECTO,
  TICKS_POR_SEGUNDO,
  crearConfiguracionAlma,
} from "./norte.js";

function puenteExterior() {
  try {
    return window.parent !== window ? window.parent.almaTorres ?? null : null;
  } catch {
    return null;
  }
}

// Ritmo de decisión configurable con ?ritmo=2.5 en la página (segundos de juego, 2–3).
function intervaloDesdeUrl() {
  let valor = NaN;
  try { valor = Number(new URLSearchParams(window.parent.location.search).get("ritmo")); } catch { /* sin acceso */ }
  if (!Number.isFinite(valor) || valor <= 0) return INTERVALO_POR_DEFECTO;
  return Math.round(Math.min(3, Math.max(2, valor)) * TICKS_POR_SEGUNDO);
}

const puente = puenteExterior();
const alma = puente?.alma ?? null;

function aplicarPresentacion() {
  const { bodyCssPixels, frameScale } = puente.presentacion();
  document.documentElement.dataset.combatBodyCssPixels = String(bodyCssPixels);
  document.documentElement.dataset.combatFrameScale = String(frameScale);
  const tamano = Number.isFinite(frameScale) && frameScale > 0 ? Math.max(11, Math.ceil(12 / frameScale)) : 11;
  document.documentElement.style.setProperty("--combat-policy-question-font-size", `${tamano}px`);
}

let controlador = null; // controlador del navegador del juego (bucle, pausa, sesión)
let sesion = null;
let enJuego = false;
let terminado = false;
let almaEnPausa = false;
let torresCaidas = new Set();
let colaEventos = Promise.resolve();

function enviarEvento(tipo, reaccion, history) {
  colaEventos = colaEventos.then(() => alma.event(tipo, { reaccion, history }))
    .catch((error) => console.warn("evento de Alma", tipo, error));
  return colaEventos;
}

function pausarJuego() {
  try { controlador?.pause(); } catch (error) { console.warn(error); }
}

function reanudarJuego() {
  try { controlador?.resume(); } catch (error) { console.warn(error); }
}

// Si el servidor pausa a Alma, se pausa la partida hasta que el dueño pulse "Reintentar".
async function reintentarAlma() {
  try { await alma.resume(); } catch (error) { console.warn(error); }
  almaEnPausa = false;
  if (enJuego && !terminado) reanudarJuego();
}

const norte = new ControladorNorte({
  intervaloTicks: intervaloDesdeUrl(),
  // Pregunta a Alma sin bloquear la simulación. null = el norte no actúa este ciclo.
  pedir: async ({ state, legal, history }) => {
    if (!alma || almaEnPausa) return null;
    const respuesta = await alma.move({ state, legal, history, ownerMoved: false, async: false,
      onRetry: reintentarAlma });
    if (respuesta?.paused) {
      almaEnPausa = true;
      pausarJuego();
      return null;
    }
    if (respuesta?.late || !respuesta?.move) return null;
    return { id: respuesta.move.id };
  },
});

function terminar(estado) {
  terminado = true;
  const resultado = estado.clock.result;
  const ganador = resultado?.winner ?? null;
  const tipo = ganador === "north" ? "gana_alma" : ganador === "south" ? "pierde_alma" : "empate";
  const reaccion = tipo === "gana_alma" ? "presumida" : tipo === "pierde_alma" ? "picada" : "dudosa";
  const coronas = resultado?.crowns ?? estado.clock.crowns;
  const frase = tipo === "gana_alma" ? "Gana Alma" : tipo === "pierde_alma" ? "¡Has ganado!" : "Empate";
  enviarEvento(tipo, reaccion, [`Resultado: ${frase} (Alma ${coronas.north} – dueño ${coronas.south}).`,
    ...norte.resumen()]);
  puente.fin({ frase, coronasAlma: coronas.north, coronasDueno: coronas.south });
}

// Tras cada fotograma de simulación: torres derribadas, final y ciclo del norte.
function alFotograma() {
  if (!controlador || !enJuego || terminado) return;
  const actual = controlador.session;
  if (actual !== sesion) {
    // El juego cambió de sesión (no debería: el reinicio original está oculto).
    sesion = actual;
    norte.reiniciar(sesion);
  }
  const estado = sesion.state;
  for (const torre of estado.battle.towers) {
    if (torre.hitpoints > 0 || torresCaidas.has(torre.id)) continue;
    torresCaidas.add(torre.id);
    if (estado.terminal) continue; // el evento final ya lo cuenta
    if (torre.side === "south") enviarEvento("buena_jugada", "contenta", norte.historial.slice(-6));
    else enviarEvento("mala_jugada", "picada", norte.historial.slice(-6));
  }
  if (estado.terminal) {
    terminar(estado);
    return;
  }
  norte.tick(sesion, estado);
}

// El bucle del juego pide los fotogramas a este planificador; tras cada uno, revisa Alma.
const planificador = {
  requestAnimationFrame: (callback) => window.requestAnimationFrame((marca) => {
    callback(marca);
    try { alFotograma(); } catch (error) { console.error(error); }
  }),
  cancelAnimationFrame: (handle) => window.cancelAnimationFrame(handle),
};

if (!puente || !alma) {
  // Abierto fuera de Alma: no hay oponente, así que no se monta la partida (nunca hay bot).
  document.querySelector("[data-aviso]").hidden = false;
} else {
  document.body.dataset.appFrame = "true"; // interfaz grande pensada para móvil
  aplicarPresentacion();
  await prepareShippedAppFrameHud(document);
  const semilla = Math.floor(Math.random() * 1_000_000_000);
  sesion = new GameSession(crearConfiguracionAlma(semilla));
  controlador = mountShippedGameBrowser(document.querySelector("[data-arena-shell-root]"),
    planificador, sesion, undefined, false);
  controlador.pause();

  window.torres = Object.freeze({
    // La página exterior ya hizo alma.start(true): empieza a correr el reloj.
    empezar() {
      if (enJuego) return false;
      sesion = controlador.session;
      torresCaidas = new Set(sesion.state.battle.towers.filter((t) => t.hitpoints <= 0).map((t) => t.id));
      norte.reiniciar(sesion);
      enJuego = true;
      reanudarJuego();
      return true;
    },
    // La página exterior cambió la escala del iframe.
    presentacionCambiada() {
      aplicarPresentacion();
      try { if (controlador.state.paused) controlador.stepMany(0); } catch (error) { console.warn(error); }
    },
    get estadisticas() { return norte.estadisticas; },
  });
  puente.listo();
}
