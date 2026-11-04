// Alma controla el lado NORTE de "Batalla de torres" (Moss & Ember, AGPL-3.0-only).
// Este módulo es puro (sin DOM): crea la configuración de la sesión sin bot norte,
// construye las jugadas legales agrupadas por zonas, el estado en texto para Alma y
// aplica su elección por la ruta de validación del propio juego (submitNorthCommand).
// Lo usan tanto el navegador (main.js) como la prueba sin navegador (tests/).

import {
  createPlayableRoster,
  createPlayableRosterQuestionRecords,
} from "../content/playable-roster.js";
import { evaluateDeployment } from "../sim/deployment.js";
import { TOWER_COMBAT_CONFIG } from "../sim/battle-continuation-kernel.js";

export const TICKS_POR_SEGUNDO = 60;
export const TICKS_REGLAMENTO = 10_800; // 3:00, regla del propio juego
export const TICKS_MAXIMOS = 18_000; // prórroga hasta 5:00 solo si hay empate
export const INTERVALO_POR_DEFECTO = 150; // 2,5 s de tiempo de juego entre decisiones
export const MAX_LEGALES = 60;
export const MAX_LARGO_ID = 40;
export const ID_ESPERAR = "esperar";

// Hechizos de radio que el norte puede lanzar (el árbitro lo vuelve a comprobar).
// El mazo estándar no trae hechizos; se deja preparado por si cambia el mazo.
const HECHIZOS_DE_RADIO = new Set(["squall-orb"]);
// Cartas que necesitan destino subterráneo: el norte externo no las usa.
const CARTAS_EXCLUIDAS = new Set(["burrow-rig"]);

/** JSON canónico (claves ordenadas), igual que el resto del juego. */
export function canonico(valor) {
  if (Array.isArray(valor)) return `[${valor.map(canonico).join(",")}]`;
  if (valor !== null && typeof valor === "object") {
    return `{${Object.keys(valor).sort().map((clave) =>
      `${JSON.stringify(clave)}:${canonico(valor[clave])}`).join(",")}}`;
  }
  return JSON.stringify(valor);
}

/**
 * Configuración de la partida: la misma que el juego publicado (mazo estándar,
 * energía inicial 10) pero SIN despliegues del bot norte integrado, de modo que el
 * norte solo actúa cuando Alma decide. Nunca hay bot sustituto.
 */
export function crearConfiguracionAlma(semilla = 0) {
  if (!Number.isSafeInteger(semilla) || semilla < 0) throw new TypeError("semilla inválida");
  const roster = createPlayableRoster();
  const questions = createPlayableRosterQuestionRecords();
  return canonico({
    battleSetup: canonico({ initialWindupTicks: { central: 0, lane: 0 }, questions, roster }),
    deck: roster.map(({ id }) => id),
    legalNorthDeployments: [],
    rosterWitness: canonico({ questions, roster }),
    seed: semilla,
    startingElixir: { north: 10, south: 10 },
    thinkIntervalTicks: 60,
    thinkOffsetTicks: 0,
  });
}

// --- Zonas agrupadas (izquierda/derecha según la pantalla del dueño; Alma está arriba) ---
// Cada zona tiene un punto representativo (centro de casilla, en milésimas de casilla).
const ZONAS_TERRESTRES = Object.freeze([
  { id: "izq-fondo", texto: "izquierda, al fondo (junto a tu rey)", punto: { x: 3_500, y: 28_500 } },
  { id: "izq-medio", texto: "izquierda, en medio (delante de tu torre)", punto: { x: 3_500, y: 21_500 } },
  { id: "izq-frente", texto: "izquierda, al frente (salida del puente)", punto: { x: 3_500, y: 17_500 } },
  { id: "der-fondo", texto: "derecha, al fondo (junto a tu rey)", punto: { x: 14_500, y: 28_500 } },
  { id: "der-medio", texto: "derecha, en medio (delante de tu torre)", punto: { x: 14_500, y: 21_500 } },
  { id: "der-frente", texto: "derecha, al frente (salida del puente)", punto: { x: 14_500, y: 17_500 } },
]);
// Los hechizos pueden caer sobre el campo rival (y dos zonas propias para defender).
const ZONAS_HECHIZO = Object.freeze([
  { id: "izq-torre", texto: "sobre la torre izquierda del dueño", punto: { x: 3_500, y: 7_500 } },
  { id: "der-torre", texto: "sobre la torre derecha del dueño", punto: { x: 14_500, y: 7_500 } },
  { id: "izq-puente", texto: "campo del dueño, izquierda, junto al río", punto: { x: 3_500, y: 13_000 } },
  { id: "der-puente", texto: "campo del dueño, derecha, junto al río", punto: { x: 14_500, y: 13_000 } },
  { id: "izq-medio", texto: "tu campo, izquierda, en medio", punto: { x: 3_500, y: 21_500 } },
  { id: "der-medio", texto: "tu campo, derecha, en medio", punto: { x: 14_500, y: 21_500 } },
]);

// Comprobación al cargar: cada punto representativo es legal para el norte.
for (const [zonas, placementClass] of [[ZONAS_TERRESTRES, "ground_entity"], [ZONAS_HECHIZO, "global_effect"]]) {
  for (const zona of zonas) {
    const decision = evaluateDeployment({ destroyedOpposingLaneTowers: [], placementClass,
      point: { ...zona.punto }, side: "north" });
    if (!decision.legal) throw new Error(`zona ${zona.id} no es legal para el norte: ${decision.reason}`);
  }
}

const CARTAS = new Map(createPlayableRoster().map((carta) => [carta.id, carta]));

function nombreCarta(id) {
  return CARTAS.get(id)?.displayName ?? id;
}

function describirCarta(id) {
  const carta = CARTAS.get(id);
  if (!carta) return id;
  const capas = new Set((carta.entities ?? []).map(({ layer }) => layer));
  const cuantos = (carta.entities ?? []).reduce((total, { count }) => total + (count ?? 1), 0);
  const tipo = carta.kind === "effect" ? "hechizo" : carta.kind === "structure" ? "edificio"
    : capas.has("air") ? "tropa aérea" : "tropa terrestre";
  const ataca = carta.targetMode === "ground" ? "solo ataca suelo" : "ataca aire y suelo";
  return `${carta.displayName} (${carta.cost}, ${tipo}${cuantos > 1 ? ` ×${cuantos}` : ""}, ${ataca})`;
}

function tipoDeCarta(estado, id) {
  return estado.cardRuntime.cards.find((carta) => carta.id === id)?.kind ?? null;
}

function zonasPara(kind) {
  return kind === "effect" ? ZONAS_HECHIZO : ZONAS_TERRESTRES;
}

function cartaJugable(estado, id) {
  const kind = tipoDeCarta(estado, id);
  if (kind === null || CARTAS_EXCLUIDAS.has(id)) return false;
  if (kind === "effect") return HECHIZOS_DE_RADIO.has(id);
  return kind === "unit" || kind === "structure";
}

/**
 * Jugadas legales para el norte en este instante: "esperar" + (cartas de la mano
 * que se pueden pagar) × (zonas agrupadas). Devuelve [{id, label}] y un mapa
 * id → jugada {cardId, zona, punto, kind} para aplicar la elección.
 */
export function construirLegales(estado) {
  const legal = [{ id: ID_ESPERAR, label: "Esperar: no jugar nada ahora" }];
  const jugadas = new Map();
  if (estado.terminal || estado.paused) return { legal, jugadas };
  const energia = estado.elixir.sides.north.amount;
  const costes = new Map(estado.cardRuntime.cards.map(({ cost, id }) => [id, cost]));
  const vistas = new Set();
  for (const cardId of estado.decks.north.hand) {
    if (vistas.has(cardId)) continue;
    vistas.add(cardId);
    const coste = costes.get(cardId);
    if (!Number.isSafeInteger(coste) || coste > energia || !cartaJugable(estado, cardId)) continue;
    const kind = tipoDeCarta(estado, cardId);
    for (const zona of zonasPara(kind)) {
      const id = `carta:${cardId}@${zona.id}`;
      if (id.length > MAX_LARGO_ID) continue;
      const verbo = kind === "effect" ? "Lanzar" : "Jugar";
      legal.push({ id, label: `${verbo} ${nombreCarta(cardId)} (cuesta ${coste}) ${zona.texto}` });
      jugadas.set(id, { cardId, kind, punto: { ...zona.punto }, zona: zona.id });
    }
  }
  if (legal.length > MAX_LEGALES) legal.length = MAX_LEGALES;
  return { legal, jugadas };
}

// --- Estado en texto compacto ---

function reloj(ticks) {
  const segundos = Math.max(0, Math.ceil(ticks / TICKS_POR_SEGUNDO));
  return `${Math.floor(segundos / 60)}:${String(segundos % 60).padStart(2, "0")}`;
}

/** Momento de la partida en formato m:ss transcurrido (para el historial). */
export function momento(tick) {
  return reloj(tick);
}

function lado(x) {
  return x < 9_000 ? "izq" : "der";
}

/** Zona de una posición vista por Alma (ella está arriba, en el norte). */
export function zonaDePosicion({ x, y }) {
  const banda = y >= 26_000 ? "tu fondo" : y >= 21_000 ? "tu medio" : y >= 17_000 ? "tu frente"
    : y >= 15_000 ? "río" : y >= 9_000 ? "campo del dueño, cerca del río" : "campo del dueño, junto a sus torres";
  return `${lado(x)} · ${banda}`;
}

function nombreTorre(torre) {
  return torre.role === "central" ? "rey" : torre.lane === "west" ? "izq" : "der";
}

function torresTexto(estado, side) {
  return estado.battle.towers.filter((torre) => torre.side === side)
    .sort((a, b) => (a.role === "central" ? 0 : a.lane === "west" ? 1 : 2) -
      (b.role === "central" ? 0 : b.lane === "west" ? 1 : 2))
    .map((torre) => {
      const maxima = TOWER_COMBAT_CONFIG[torre.role]?.hitpoints;
      return `${nombreTorre(torre)} ${torre.hitpoints <= 0 ? "DESTRUIDA" : `${torre.hitpoints}${maxima ? `/${maxima}` : ""}`}`;
    }).join(", ");
}

function unidadesTexto(estado, side) {
  const grupos = new Map();
  for (const unidad of estado.battle.units) {
    if (unidad.side !== side || unidad.alive === false) continue;
    const clave = `${zonaDePosicion(unidad.position)}|${unidad.cardId}`;
    const grupo = grupos.get(clave) ?? { cardId: unidad.cardId, n: 0, pv: 0,
      zona: zonaDePosicion(unidad.position), aire: unidad.layer === "air" };
    grupo.n += 1;
    grupo.pv += Math.max(0, unidad.hitpoints ?? 0);
    grupos.set(clave, grupo);
  }
  for (const estructura of estado.battle.structures ?? []) {
    if (estructura.side !== side || estructura.alive === false) continue;
    const clave = `${zonaDePosicion(estructura.position)}|${estructura.cardId}`;
    const grupo = grupos.get(clave) ?? { cardId: estructura.cardId, n: 0, pv: 0,
      zona: zonaDePosicion(estructura.position), aire: false };
    grupo.n += 1;
    grupo.pv += Math.max(0, estructura.hitpoints ?? 0);
    grupos.set(clave, grupo);
  }
  if (grupos.size === 0) return "ninguna";
  return [...grupos.values()].sort((a, b) => a.zona.localeCompare(b.zona))
    .map((g) => `${g.zona}: ${g.n > 1 ? `${g.n}× ` : ""}${nombreCarta(g.cardId)}${g.aire ? " (aire)" : ""} ${g.pv} PV`)
    .join("; ");
}

/** Estado compacto en español de lo que Alma ve en este instante. */
export function construirEstado(estado) {
  const tick = estado.tick;
  const tiempo = tick < TICKS_REGLAMENTO
    ? `quedan ${reloj(TICKS_REGLAMENTO - tick)} de 3:00`
    : `PRÓRROGA (muerte súbita), quedan ${reloj(TICKS_MAXIMOS - tick)}`;
  const mano = estado.decks.north.hand.map(describirCarta).join("; ");
  const coronas = estado.clock.crowns;
  return [
    "Batalla de torres. Eres Alma y juegas ARRIBA (norte); el dueño juega abajo. Izquierda/derecha según la pantalla del dueño.",
    `Tiempo: ${tiempo}. Coronas: Alma ${coronas.north} – dueño ${coronas.south}.`,
    `Tu energía: ${estado.elixir.sides.north.amount}/10 (sube sola). Tu mano: ${mano}. Siguiente: ${nombreCarta(estado.decks.north.next)}.`,
    `Tus torres: ${torresTexto(estado, "north")}. Torres del dueño: ${torresTexto(estado, "south")}.`,
    `Tropas del dueño a la vista: ${unidadesTexto(estado, "south")}.`,
    `Tus tropas: ${unidadesTexto(estado, "north")}.`,
  ].join("\n");
}

/**
 * Aplica una jugada por la ruta de validación del propio juego. Devuelve
 * {ok:true} o {ok:false, motivo}. Nunca lanza: si el árbitro la rechaza no pasa nada.
 */
export function aplicarJugada(sesion, jugada, commandId) {
  try {
    const estado = sesion.state;
    if (estado.terminal || estado.paused) return { ok: false, motivo: "partida detenida" };
    const slot = estado.decks.north.hand.indexOf(jugada.cardId);
    if (slot < 0) return { ok: false, motivo: "la carta ya no está en la mano" };
    sesion.submitNorthCommand(canonico({
      cardId: jugada.cardId,
      commandId,
      point: { x: jugada.punto.x, y: jugada.punto.y },
      side: "north",
      slot,
      tick: estado.tick,
      type: jugada.kind === "effect" ? "spell" : "deploy",
    }));
    return { ok: true, tick: estado.tick };
  } catch (error) {
    return { ok: false, motivo: String(error?.message ?? error) };
  }
}

/**
 * Ciclo de decisiones del norte. Cada `intervaloTicks` de tiempo de JUEGO pregunta a
 * Alma (sin bloquear la simulación). Solo se aplica la respuesta del ciclo vigente:
 * si llega tarde (ya empezó el siguiente ciclo) se ignora. Si no hay respuesta, el
 * norte simplemente no actúa ese ciclo.
 */
export class ControladorNorte {
  #pedir;
  #intervalo;
  #primerTick;
  #maxHistorial;
  #sesion = null;
  #ciclo = 0;
  #proximoTick = 0;
  #jugadas = new Map();
  #siguienteComando = 0;
  #tickUltimaOrden = -1; // tick de la última orden admitida (pendiente hasta avanzar)
  #historial = [];
  #stats = null;
  #alAplicar;

  /**
   * pedir({state, legal, history, ciclo}) → Promise<{id}|null>
   * intervaloTicks: ticks de juego entre decisiones (60 ticks = 1 s).
   */
  constructor({ pedir, intervaloTicks = INTERVALO_POR_DEFECTO, primerTick = 60,
    maxHistorial = 8, alAplicar = null } = {}) {
    if (typeof pedir !== "function") throw new TypeError("pedir debe ser una función");
    if (!Number.isSafeInteger(intervaloTicks) || intervaloTicks < 30 || intervaloTicks > 600) {
      throw new RangeError("intervaloTicks fuera de rango (30–600)");
    }
    this.#pedir = pedir;
    this.#intervalo = intervaloTicks;
    this.#primerTick = primerTick;
    this.#maxHistorial = maxHistorial;
    this.#alAplicar = alAplicar;
    this.#reiniciarStats();
  }

  #reiniciarStats() {
    this.#stats = { ciclos: 0, aplicadas: 0, esperas: 0, rechazadas: 0, tardias: 0,
      sinRespuesta: 0, desconocidas: 0, maxLegales: 0, minLegales: Infinity, motivos: [] };
  }

  /** Empieza una partida nueva con esta sesión. */
  reiniciar(sesion) {
    this.#sesion = sesion;
    this.#ciclo += 1; // invalida cualquier respuesta en vuelo de la partida anterior
    this.#proximoTick = (sesion?.state.tick ?? 0) + this.#primerTick;
    this.#jugadas = new Map();
    this.#siguienteComando = 0;
    this.#tickUltimaOrden = -1;
    this.#historial = [];
    this.#reiniciarStats();
  }

  get estadisticas() { return { ...this.#stats, motivos: [...this.#stats.motivos] }; }
  get historial() { return [...this.#historial]; }
  get ciclo() { return this.#ciclo; }

  #anotar(texto) {
    this.#historial.push(texto);
    if (this.#historial.length > 200) this.#historial.shift();
  }

  /** Llamar después de cada avance de la simulación (p. ej. cada fotograma). */
  tick(sesion, estado = sesion.state) {
    if (sesion !== this.#sesion || estado.terminal || estado.paused) return null;
    if (estado.tick < this.#proximoTick) return null;
    // Si la última orden aún no se ha simulado, la mano y la energía del estado no la
    // reflejan todavía: se espera al siguiente avance para no ofrecer jugadas viejas.
    if (estado.tick <= this.#tickUltimaOrden) return null;
    this.#proximoTick = estado.tick + this.#intervalo;
    this.#ciclo += 1;
    const ciclo = this.#ciclo;
    const { legal, jugadas } = construirLegales(estado);
    this.#jugadas = jugadas;
    this.#stats.ciclos += 1;
    this.#stats.maxLegales = Math.max(this.#stats.maxLegales, legal.length);
    this.#stats.minLegales = Math.min(this.#stats.minLegales, legal.length);
    const peticion = {
      ciclo,
      history: this.#historial.slice(-this.#maxHistorial),
      legal,
      state: construirEstado(estado),
      tick: estado.tick,
    };
    let promesa;
    try { promesa = Promise.resolve(this.#pedir(peticion)); }
    catch (error) { promesa = Promise.reject(error); }
    promesa.then((respuesta) => this.#resolver(ciclo, estado.tick, respuesta),
      () => this.#resolver(ciclo, estado.tick, null));
    return peticion;
  }

  #resolver(ciclo, tickPedido, respuesta) {
    const cuando = momento(tickPedido);
    if (ciclo !== this.#ciclo || this.#sesion === null) {
      this.#stats.tardias += 1;
      this.#anotar(`${cuando} llegó tarde (ignorada)`);
      return;
    }
    const id = respuesta?.id;
    if (typeof id !== "string") {
      this.#stats.sinRespuesta += 1;
      this.#anotar(`${cuando} sin respuesta: no jugó`);
      return;
    }
    if (id === ID_ESPERAR) {
      this.#stats.esperas += 1;
      this.#anotar(`${cuando} esperó`);
      return;
    }
    const jugada = this.#jugadas.get(id);
    if (!jugada) {
      this.#stats.desconocidas += 1;
      this.#anotar(`${cuando} jugada desconocida (ignorada)`);
      return;
    }
    const resultado = aplicarJugada(this.#sesion, jugada, this.#siguienteComando);
    if (resultado.ok) {
      this.#siguienteComando += 1;
      this.#tickUltimaOrden = resultado.tick;
      this.#stats.aplicadas += 1;
      this.#anotar(`${cuando} ${nombreCarta(jugada.cardId)} en ${jugada.zona}`);
      this.#alAplicar?.(jugada);
    } else {
      this.#stats.rechazadas += 1;
      if (this.#stats.motivos.length < 20) this.#stats.motivos.push(resultado.motivo);
      this.#anotar(`${cuando} ${nombreCarta(jugada.cardId)} en ${jugada.zona} (rechazada)`);
    }
    this.#jugadas = new Map(); // una sola jugada por ciclo
  }

  /** Historial corto para el evento final. */
  resumen(maximo = 12) {
    const s = this.#stats;
    const lineas = this.#historial.filter((linea) => !linea.includes("esperó")).slice(-maximo);
    return [`Alma jugó ${s.aplicadas} cartas en ${s.ciclos} turnos (esperó ${s.esperas}, sin respuesta ${s.sinRespuesta + s.tardias}).`, ...lineas];
  }
}
