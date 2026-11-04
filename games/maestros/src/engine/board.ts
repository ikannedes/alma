// Reglas de Maestros: port fiel de onitamalib/src/board.rs y agents/move_gen.rs (jackadamson/onitama, MIT).
// Diferencias deliberadas con el original (marcadas con «CAMBIO»):
//  1. Quién empieza: el original siempre empieza el rojo; aquí, como en el reglamento, empieza el color del sello
//     de la carta del lado (se puede forzar con el parámetro `turn`).
//  2. Pasar (Discard) comprueba que la carta esté en la mano (el original no lo comprobaba).
import { BASE_SET, cardMoves, cardStamp } from './cards';
import {
  add, containsPoint, eq, inBounds, invertPlayer, neg, outOfBounds, sub,
  type Board, type Card, type GameSquare, type GameState, type Move, type MoveResult, type Player, type Point,
} from './models';

export type Rng = () => number; // como Math.random: [0, 1)

const cp = (p: Point): Point => ({ x: p.x, y: p.y });
const cpOpt = (p: Point | null): Point | null => (p ? cp(p) : null);

export function cloneBoard(b: Board): Board {
  return {
    blueKing: cp(b.blueKing),
    bluePawns: b.bluePawns.map(cpOpt),
    blueHand: [b.blueHand[0], b.blueHand[1]],
    redKing: cp(b.redKing),
    redPawns: b.redPawns.map(cpOpt),
    redHand: [b.redHand[0], b.redHand[1]],
    spareCard: b.spareCard,
    turn: b.turn,
  };
}

// ---- Accesos relativos al jugador en turno ----
export const playerHand = (b: Board): [Card, Card] => (b.turn === 'rojo' ? b.redHand : b.blueHand);
export const opponentHand = (b: Board): [Card, Card] => (b.turn === 'rojo' ? b.blueHand : b.redHand);
export const playerPawns = (b: Board): (Point | null)[] => (b.turn === 'rojo' ? b.redPawns : b.bluePawns);
export const opponentPawns = (b: Board): (Point | null)[] => (b.turn === 'rojo' ? b.bluePawns : b.redPawns);
export const playerKing = (b: Board): Point => (b.turn === 'rojo' ? b.redKing : b.blueKing);
export const opponentKing = (b: Board): Point => (b.turn === 'rojo' ? b.blueKing : b.redKing);
/** Piezas del jugador en turno: [maestro, alumno×4] (como player_pieces en Rust). */
export const playerPieces = (b: Board): (Point | null)[] => [playerKing(b), ...playerPawns(b)];
export const opponentPieces = (b: Board): (Point | null)[] => [opponentKing(b), ...opponentPawns(b)];
/** [alumno×4, maestro] (como red_pieces/blue_pieces en Rust). */
export const redPieces = (b: Board): (Point | null)[] => [...b.redPawns, b.redKing];
export const bluePieces = (b: Board): (Point | null)[] => [...b.bluePawns, b.blueKing];

/** Desplazamiento real en el tablero: el azul ve la carta girada 180°. */
export const orient = (turn: Player, delta: Point): Point => (turn === 'rojo' ? delta : neg(delta));

/** Templo que gana el jugador si llega su maestro (el punto de partida del maestro rival). */
export const goalSquare = (p: Player): Point => (p === 'rojo' ? { x: 2, y: 0 } : { x: 2, y: 4 });

export function tryMove(board: Board, move: Move): MoveResult {
  const turn = board.turn;
  const pKing = playerKing(board);
  const oKing = opponentKing(board);
  const pieces = playerPieces(board);
  const hand = playerHand(board);

  if (move.type === 'Discard') {
    if (canMove(board)) return { ok: false, error: 'Hay jugadas posibles: no se puede pasar' };
    // CAMBIO 2: el original no comprobaba que la carta estuviera en la mano.
    if (!hand.includes(move.card)) return { ok: false, error: 'La carta no está en tu mano' };
    const newHand = hand.map((c) => (c === move.card ? board.spareCard : c)) as [Card, Card];
    const next = cloneBoard(board);
    if (turn === 'rojo') next.redHand = newHand;
    else next.blueHand = newHand;
    next.spareCard = move.card;
    next.turn = invertPlayer(turn);
    return { ok: true, state: { status: 'Playing', board: next } };
  }

  const { card, src, dst } = move;
  if (!hand.includes(card)) return { ok: false, error: 'La carta no está en tu mano' };
  if (!containsPoint(pieces, src)) return { ok: false, error: 'No hay pieza tuya en el origen' };
  if (containsPoint(pieces, dst)) return { ok: false, error: 'El destino está ocupado por una pieza tuya' };
  if (outOfBounds(dst)) return { ok: false, error: 'El destino está fuera del tablero' };
  const delta = orient(turn, sub(dst, src));
  if (!cardMoves(card).some((m) => eq(m, delta))) return { ok: false, error: 'La carta no permite ese movimiento' };

  const goal = goalSquare(turn);
  const movingKing = eq(pKing, src);
  const newPlayerPawns = playerPawns(board).map((pw) => (pw === null ? null : eq(pw, src) ? cp(dst) : cp(pw)));
  const newOpponentPawns = opponentPawns(board).map((pw) => (pw === null ? null : eq(pw, dst) ? null : cp(pw)));
  const newHand = hand.map((c) => (c === card ? board.spareCard : c)) as [Card, Card];
  const newPlayerKing = movingKing ? cp(dst) : cp(pKing);

  const next: Board =
    turn === 'rojo'
      ? {
          blueKing: cp(board.blueKing), bluePawns: newOpponentPawns, blueHand: [...board.blueHand] as [Card, Card],
          redKing: newPlayerKing, redPawns: newPlayerPawns, redHand: newHand,
          spareCard: card, turn: 'azul',
        }
      : {
          blueKing: newPlayerKing, bluePawns: newPlayerPawns, blueHand: newHand,
          redKing: cp(board.redKing), redPawns: newOpponentPawns, redHand: [...board.redHand] as [Card, Card],
          spareCard: card, turn: 'rojo',
        };
  // Se gana capturando al maestro rival o llevando el propio maestro al templo rival.
  if (eq(dst, oKing)) return { ok: true, state: { status: 'Finished', board: next, winner: turn } };
  if (movingKing && eq(dst, goal)) return { ok: true, state: { status: 'Finished', board: next, winner: turn } };
  return { ok: true, state: { status: 'Playing', board: next } };
}

/** Coloca las piezas y reparte: 2 al azul, 2 al rojo, 1 al lado (new_from_cards en Rust). */
export function newFromCards(cards: Card[], turn?: Player): Board {
  if (cards.length < 5) throw new Error('Hacen falta 5 cartas');
  const xs = [0, 1, 3, 4];
  const spare = cards[4];
  return {
    blueKing: { x: 2, y: 0 },
    bluePawns: xs.map((x) => ({ x, y: 0 })),
    blueHand: [cards[0], cards[1]],
    redKing: { x: 2, y: 4 },
    redPawns: xs.map((x) => ({ x, y: 4 })),
    redHand: [cards[2], cards[3]],
    spareCard: spare,
    // CAMBIO 1: empieza el color del sello de la carta del lado (el original fijaba el rojo).
    turn: turn ?? cardStamp(spare),
  };
}

export function shuffle<T>(arr: T[], rng: Rng = Math.random): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Tablero nuevo con 5 cartas al azar de las 16 del juego base. */
export function newBoard(rng: Rng = Math.random, turn?: Player): Board {
  return newFromCards(shuffle(BASE_SET, rng), turn);
}

export function newGame(rng: Rng = Math.random, turn?: Player): GameState {
  return { status: 'Playing', board: newBoard(rng, turn) };
}

/** Rejilla [y][x] (to_grid en Rust). Los maestros se dibujan al final; el azul encima del rojo como en el original. */
export function toGrid(b: Board): GameSquare[][] {
  const grid: GameSquare[][] = Array.from({ length: 5 }, () => Array<GameSquare>(5).fill('Empty'));
  for (const p of b.bluePawns) if (p) grid[p.y][p.x] = 'BluePawn';
  for (const p of b.redPawns) if (p) grid[p.y][p.x] = 'RedPawn';
  grid[b.redKing.y][b.redKing.x] = 'RedKing';
  grid[b.blueKing.y][b.blueKing.x] = 'BlueKing';
  return grid;
}

/** ¿Tiene el jugador en turno alguna jugada (aparte de pasar)? */
export function canMove(b: Board): boolean {
  const pieces = playerPieces(b);
  for (const src of pieces) {
    if (!src) continue;
    for (const card of playerHand(b)) {
      for (const raw of cardMoves(card)) {
        const dst = add(orient(b.turn, raw), src);
        if (inBounds(dst) && !containsPoint(pieces, dst)) return true;
      }
    }
  }
  return false;
}

export const finished = (s: GameState): boolean => s.status === 'Finished';

export function tryMoveState(s: GameState, move: Move): MoveResult {
  if (s.status === 'Finished') return { ok: false, error: 'La partida ya terminó' };
  return tryMove(s.board, move);
}

// ---- Generación de jugadas (agents/move_gen.rs) ----

/** Todas las jugadas legales; capturas primero. Si no hay ninguna, las dos formas de pasar carta. */
export function legalMoves(b: Board): Move[] {
  const moves: Move[] = [];
  const pieces = playerPieces(b);
  for (const card of playerHand(b)) {
    for (const src of pieces) {
      if (!src) continue;
      for (const raw of cardMoves(card)) {
        const dst = add(src, orient(b.turn, raw));
        if (inBounds(dst) && !containsPoint(pieces, dst)) moves.push({ type: 'Move', card, src: cp(src), dst });
      }
    }
  }
  if (moves.length > 0) {
    const opp = opponentPieces(b);
    const key = (m: Move) => (m.type === 'Move' ? (containsPoint(opp, m.dst) ? 0 : 1) : 0);
    // Orden estable, como sort_by_cached_key.
    return moves.map((m, i) => ({ m, i, k: key(m) })).sort((a, z) => a.k - z.k || a.i - z.i).map((o) => o.m);
  }
  return playerHand(b).map((card) => ({ type: 'Discard', card }));
}

export function randomLegalMove(b: Board, rng: Rng = Math.random): Move {
  const cards = shuffle(playerHand(b), rng);
  const pieces = shuffle(playerPieces(b), rng);
  for (const card of cards) {
    const ms = shuffle(cardMoves(card), rng);
    for (const src of pieces) {
      if (!src) continue;
      for (const off of ms) {
        const dst = add(src, orient(b.turn, off));
        if (inBounds(dst) && !containsPoint(pieces, dst)) return { type: 'Move', card, src: cp(src), dst };
      }
    }
  }
  return { type: 'Discard', card: cards[0] };
}
