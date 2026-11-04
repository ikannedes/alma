// Estado serializable de una partida (lo que se guarda en el relay como snapshot) y cómo avanza.
import { newGame, tryMoveState, type Rng } from './engine/board';
import { cardName, cardStamp } from './engine/cards';
import type { GameState, Move, Point } from './engine/models';
import { historyLine, moveInfo, OWNER } from './alma/protocol';

export interface Snapshot {
  v: 1;
  game: GameState;
  log: string[]; // historial en castellano
  lastMove: { src: Point; dst: Point } | null;
}

export function freshSnapshot(rng?: Rng): Snapshot {
  const game = newGame(rng); // empieza el color del sello de la carta del lado
  const spare = game.board.spareCard;
  const who = cardStamp(spare) === OWNER ? 'el dueño (rojo)' : 'Alma (azul)';
  return {
    v: 1,
    game,
    log: [`Carta del lado: ${cardName(spare)}, sello ${cardStamp(spare)}: empieza ${who}.`],
    lastMove: null,
  };
}

export function isSnapshot(x: unknown): x is Snapshot {
  const s = x as Snapshot | null;
  return !!s && s.v === 1 && !!s.game && !!s.game.board && Array.isArray(s.log) &&
    (s.game.status === 'Playing' || s.game.status === 'Finished');
}

export type PlayResult =
  | { ok: true; next: Snapshot; captura: boolean; line: string }
  | { ok: false; error: string };

/** Aplica una jugada (validada por el motor) y devuelve el snapshot siguiente. */
export function play(s: Snapshot, m: Move): PlayResult {
  if (s.game.status !== 'Playing') return { ok: false, error: 'La partida ya terminó' };
  const b = s.game.board;
  const r = tryMoveState(s.game, m);
  if (!r.ok) return r;
  const line = historyLine(b, m);
  const info = moveInfo(b, m);
  return {
    ok: true,
    line,
    captura: !!info?.captura,
    next: {
      v: 1,
      game: r.state,
      log: [...s.log, line],
      lastMove: m.type === 'Move' ? { src: m.src, dst: m.dst } : null,
    },
  };
}

export const recent = (log: string[], n = 12) => log.slice(-n);
