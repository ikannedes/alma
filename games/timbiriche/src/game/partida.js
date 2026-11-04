// Flujo de una partida dueño contra Alma, sin DOM (lo usa la app y las pruebas con un puente falso).
// Reglas del plan del dueño: el motor es el árbitro; Alma solo elige un id de la lista de jugadas legales.
// Sin red, Alma no juega: nunca hay bot de reemplazo, la partida espera con "Reintentar".
import { Timbiriche } from "./timbiriche.js";

const REACCION = {
  buena_jugada: "presumida",
  mala_jugada: "nerviosa",
  gana_alma: "contenta",
  pierde_alma: "picada",
  empate: "dudosa",
};

const SIN_RED = "Sin red, Alma no juega.";

// alma: objeto de createAlma("timbiriche") (o uno falso en pruebas).
// alCambiar(): se llama cada vez que hay que repintar. pausa: ms entre jugadas seguidas de Alma.
export function crearPartida({ alma, alCambiar = () => {}, pausa = 0 }) {
  let juego = null;
  let historial = [];
  let ronda = 0;           // invalida respuestas viejas al empezar otra partida
  let ocupado = false;     // esperando a Alma (o al relay)
  let enPausa = false;     // Alma no respondió: esperando "Reintentar"
  let rechazada = null;    // texto si el relay no dejó empezar
  const esperar = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());
  const avisar = () => alCambiar();

  function aviso(texto, reintentar) {
    alma.notice(texto, reintentar ? { label: "Reintentar", run: reintentar } : undefined);
  }

  async function evento(tipo, mio) {
    try {
      const r = await alma.event(tipo, { reaccion: REACCION[tipo], history: [...historial] });
      if (mio !== ronda) return true;
      const frase = r && (r.pensamiento || r.text || r.frase);
      if (frase) alma.say(frase, (r && r.reaccion) || REACCION[tipo]);
      return true;
    } catch {
      return false;
    }
  }

  async function fin(mio) {
    const tipo = juego.resultado();
    ocupado = true;
    avisar();
    const ok = await evento(tipo, mio);
    if (mio !== ronda) return;
    if (!ok) {
      // El resultado tiene que llegar al relay: se reintenta a mano.
      enPausa = true;
      aviso(SIN_RED + " No se pudo guardar el resultado.", () => { enPausa = false; fin(mio); });
      avisar();
      return;
    }
    ocupado = false;
    enPausa = false;
    avisar();
  }

  async function turnoAlma(mio, ownerMoved) {
    if (mio !== ronda || !juego || juego.terminada || !juego.turnoDeAlma) return;
    ocupado = true;
    enPausa = false;
    avisar();
    const reintentar = () => turnoAlma(mio, ownerMoved);
    const legal = juego.legales().map(({ id, label }) => ({ id, label }));
    let r;
    try {
      r = await alma.move({ state: juego.estadoTexto(), legal, history: [...historial], ownerMoved,
                            async: false, onRetry: reintentar });
    } catch {
      if (mio !== ronda) return;
      enPausa = true;
      aviso(SIN_RED, reintentar);
      avisar();
      return;
    }
    if (mio !== ronda) return;
    if (!r || r.paused || !r.move) {
      // En pausa el puente ya mostró su aviso con "Reintentar" (onRetry). Cualquier otra respuesta: igual.
      enPausa = true;
      if (!r || !r.paused) aviso("Alma no respondió con una jugada.", reintentar);
      avisar();
      return;
    }
    const edge = juego.lineaPorId(r.move.id);
    if (edge < 0) {
      enPausa = true;
      aviso("Alma eligió una línea que no vale.", reintentar);
      avisar();
      return;
    }
    const res = juego.jugar(edge);
    historial.push(res.entrada);
    avisar();
    if (res.turnoTerminado && res.cajasDelTurno >= 2) await evento("buena_jugada", mio);
    if (mio !== ronda) return;
    if (res.terminada) return fin(mio);
    if (res.otraVez) {
      // Cerró caja: vuelve a jugar Alma, ya sin jugada nueva del dueño.
      await esperar(pausa);
      return turnoAlma(mio, false);
    }
    ocupado = false;
    avisar();
  }

  return {
    get juego() { return juego; },
    get historial() { return historial; },
    get ocupado() { return ocupado; },
    get enPausa() { return enPausa; },
    get rechazada() { return rechazada; },
    get puedeJugarDueno() { return !!juego && !ocupado && !juego.terminada && !juego.turnoDeAlma; },

    // Nueva partida: start(true) en el relay y tablero limpio.
    async nueva(size, almaEmpieza) {
      const mio = ++ronda;
      ocupado = true;
      enPausa = false;
      rechazada = null;
      avisar();
      let r;
      try {
        r = await alma.start(true);
      } catch {
        if (mio !== ronda) return;
        ocupado = false;
        enPausa = true;
        aviso(SIN_RED, () => this.nueva(size, almaEmpieza));
        avisar();
        return;
      }
      if (mio !== ronda) return;
      if (!r || !r.ok) {
        ocupado = false;
        juego = null;
        rechazada = (r && r.refused) || "Alma no puede jugar ahora.";
        avisar();
        return;
      }
      juego = new Timbiriche(size, almaEmpieza);
      historial = [];
      ocupado = false;
      avisar();
      if (juego.turnoDeAlma) await turnoAlma(mio, false);
    },

    // Línea elegida por el dueño. Devuelve false si no le toca o la línea no vale.
    async jugarDueno(edge) {
      if (!this.puedeJugarDueno || !juego.libre(edge)) return false;
      const mio = ronda;
      const res = juego.jugar(edge);
      historial.push(res.entrada);
      avisar();
      // Si el dueño se llevó 2 o más cajas seguidas, Alma se las dejó: mala jugada de Alma.
      if (res.turnoTerminado && res.cajasDelTurno >= 2) {
        ocupado = true;
        await evento("mala_jugada", mio);
        if (mio !== ronda) return true;
        ocupado = false;
      }
      if (res.terminada) await fin(mio);
      else if (juego.turnoDeAlma) await turnoAlma(mio, true);
      else avisar();
      return true;
    },
  };
}
