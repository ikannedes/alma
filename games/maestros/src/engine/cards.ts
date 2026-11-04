// Cartas de Maestros. Port de onitamalib/src/cards.rs (solo el juego base de 16 cartas).
// Movimientos desde el punto de vista del rojo: y negativa = hacia delante, x positiva = a la derecha.
// Añadido respecto al original: nombre en castellano y color del sello (decide quién empieza, según el reglamento).
import type { Card, CardDirection, Player, Point } from './models';

interface CardInfo {
  nombre: string; // nombre visible
  moves: Point[];
  direction: CardDirection;
  sello: Player; // color del sello: si es la carta del lado al empezar, empieza ese color
}

const p = (x: number, y: number): Point => ({ x, y });

export const CARDS: Record<Card, CardInfo> = {
  tigre: { nombre: 'Tigre', moves: [p(0, -2), p(0, 1)], direction: 'equilibrada', sello: 'azul' },
  dragon: { nombre: 'Dragón', moves: [p(-2, -1), p(-1, 1), p(2, -1), p(1, 1)], direction: 'equilibrada', sello: 'rojo' },
  rana: { nombre: 'Rana', moves: [p(-2, 0), p(-1, -1), p(1, 1)], direction: 'izquierda', sello: 'rojo' },
  conejo: { nombre: 'Conejo', moves: [p(1, -1), p(2, 0), p(-1, 1)], direction: 'derecha', sello: 'azul' },
  cangrejo: { nombre: 'Cangrejo', moves: [p(0, -1), p(-2, 0), p(2, 0)], direction: 'equilibrada', sello: 'azul' },
  elefante: { nombre: 'Elefante', moves: [p(1, 0), p(-1, -1), p(1, -1), p(-1, 0)], direction: 'equilibrada', sello: 'rojo' },
  ganso: { nombre: 'Ganso', moves: [p(-1, 0), p(-1, -1), p(1, 0), p(1, 1)], direction: 'izquierda', sello: 'azul' },
  gallo: { nombre: 'Gallo', moves: [p(1, 0), p(1, -1), p(-1, 0), p(-1, 1)], direction: 'derecha', sello: 'rojo' },
  mono: { nombre: 'Mono', moves: [p(-1, -1), p(1, -1), p(-1, 1), p(1, 1)], direction: 'equilibrada', sello: 'azul' },
  mantis: { nombre: 'Mantis', moves: [p(-1, -1), p(1, -1), p(0, 1)], direction: 'equilibrada', sello: 'rojo' },
  caballo: { nombre: 'Caballo', moves: [p(0, -1), p(-1, 0), p(0, 1)], direction: 'izquierda', sello: 'rojo' },
  buey: { nombre: 'Buey', moves: [p(0, -1), p(1, 0), p(0, 1)], direction: 'derecha', sello: 'azul' },
  grulla: { nombre: 'Grulla', moves: [p(0, -1), p(1, 1), p(-1, 1)], direction: 'equilibrada', sello: 'azul' },
  jabali: { nombre: 'Jabalí', moves: [p(0, -1), p(1, 0), p(-1, 0)], direction: 'equilibrada', sello: 'rojo' },
  anguila: { nombre: 'Anguila', moves: [p(1, 0), p(-1, -1), p(-1, 1)], direction: 'izquierda', sello: 'azul' },
  cobra: { nombre: 'Cobra', moves: [p(-1, 0), p(1, -1), p(1, 1)], direction: 'derecha', sello: 'rojo' },
};

/** Orden del enum Card de Rust (para index()/from()). */
export const ALL_CARDS: Card[] = [
  'tigre', 'dragon', 'rana', 'conejo', 'cangrejo', 'elefante', 'ganso', 'gallo',
  'mono', 'mantis', 'caballo', 'buey', 'grulla', 'jabali', 'anguila', 'cobra',
];

/** CardSet::Base.cards() en el orden del original. */
export const BASE_SET: Card[] = [
  'jabali', 'cangrejo', 'elefante', 'dragon', 'mono', 'tigre', 'grulla', 'mantis',
  'anguila', 'cobra', 'rana', 'conejo', 'ganso', 'gallo', 'caballo', 'buey',
];

export const cardMoves = (c: Card): Point[] => CARDS[c].moves.map((m) => ({ ...m }));
export const cardDirection = (c: Card): CardDirection => CARDS[c].direction;
export const cardName = (c: Card): string => CARDS[c].nombre;
export const cardStamp = (c: Card): Player => CARDS[c].sello;
export const cardIndex = (c: Card): number => ALL_CARDS.indexOf(c);
export function cardFromIndex(i: number): Card {
  const c = ALL_CARDS[i];
  if (!c) throw new Error('índice de carta no válido');
  return c;
}
export const isCard = (s: unknown): s is Card => typeof s === 'string' && s in CARDS;
