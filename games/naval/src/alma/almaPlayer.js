/**
 * Puente con Alma. El módulo lo sirve el mismo sitio en /play/_alma/alma.js (con la sesión del dueño); no se empaqueta
 * con el juego. Si no carga, Alma no juega: no hay bot de repuesto.
 */
let bridge = null;

export function alma() {
  const url = '/play/_alma/alma.js';
  if (!bridge) {
    bridge = import(/* @vite-ignore */ url)
      .then((m) => m.createAlma('naval'))
      .catch((e) => {
        bridge = null; // para poder reintentar
        throw e;
      });
  }
  return bridge;
}

/** Evento para el relay; si falla no se para la partida (no es una jugada). */
export async function almaEvent(type, extra) {
  try {
    const b = await alma();
    await b.event(type, extra);
  } catch {
    /* sin red: el evento se pierde, la partida sigue */
  }
}
