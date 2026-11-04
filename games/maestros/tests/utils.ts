// Utilidades de prueba (port de onitamalib/src/tests/utils.rs): RNG con semilla y tablero "como Board::new()".
import { newBoard, randomLegalMove, tryMoveState, type Rng } from '../src/engine/board';
import type { Board, GameState } from '../src/engine/models';

/** RNG determinista (mulberry32), equivalente a SmallRng::seed_from_u64 para nuestras pruebas. */
export function seeded(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let r = seeded(12345);
/** Board::new() del original: cartas al azar y empieza el rojo. */
export const boardNew = (): Board => newBoard(r, 'rojo');
export const resetRng = (seed = 12345) => { r = seeded(seed); };

const SAMPLES = 100;
/** generate_test_states(): estados intermedios de partidas aleatorias. */
export function generateTestStates(): GameState[] {
  const rng = seeded(0);
  const states: GameState[] = [];
  while (states.length < SAMPLES) {
    let state: GameState = { status: 'Playing', board: newBoard(rng, 'rojo') };
    while (state.status === 'Playing') {
      states.push(state);
      const res = tryMoveState(state, randomLegalMove(state.board, rng));
      if (!res.ok) throw new Error('Jugada ilegal generada');
      state = res.state;
    }
  }
  return states.slice(0, SAMPLES);
}
