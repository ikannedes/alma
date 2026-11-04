// Modelos de Maestros. Port a TypeScript de onitamalib/src/models.rs (jackadamson/onitama, MIT, commit fe03d8c).
// Coordenadas como en el original: x = columna 0..4 (izquierda→derecha vista por el rojo), y = fila 0..4.
// El rojo empieza abajo (y=4) y avanza hacia y=0; el azul empieza arriba (y=0) y ve las cartas giradas 180°.
// En la integración con Alma, el rojo es el dueño y el azul es Alma.

export type Player = 'rojo' | 'azul';

export interface Point {
  x: number;
  y: number;
}

/** Cartas del juego base (16). El identificador es el nombre en castellano sin tildes. */
export type Card =
  | 'tigre'
  | 'dragon'
  | 'rana'
  | 'conejo'
  | 'cangrejo'
  | 'elefante'
  | 'ganso'
  | 'gallo'
  | 'mono'
  | 'mantis'
  | 'caballo'
  | 'buey'
  | 'grulla'
  | 'jabali'
  | 'anguila'
  | 'cobra';

export type CardDirection = 'derecha' | 'izquierda' | 'equilibrada';

/** Tablero: igual que el struct Board de Rust (alumnos = peones; null = capturado). */
export interface Board {
  blueKing: Point;
  bluePawns: (Point | null)[]; // siempre 4 posiciones
  blueHand: [Card, Card];
  redKing: Point;
  redPawns: (Point | null)[]; // siempre 4 posiciones
  redHand: [Card, Card];
  spareCard: Card;
  turn: Player;
}

export type Move =
  | { type: 'Move'; card: Card; src: Point; dst: Point }
  | { type: 'Discard'; card: Card };

export type GameState =
  | { status: 'Playing'; board: Board }
  | { status: 'Finished'; board: Board; winner: Player };

export type GameSquare = 'RedKing' | 'RedPawn' | 'BlueKing' | 'BluePawn' | 'Empty';

/** Resultado de intentar una jugada (Result<GameState, String> en Rust). */
export type MoveResult = { ok: true; state: GameState } | { ok: false; error: string };

// ---- Point (Add, Sub, Neg, out_of_bounds, in_bounds, invert) ----
export const pt = (x: number, y: number): Point => ({ x, y });
export const add = (a: Point, b: Point): Point => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Point, b: Point): Point => ({ x: a.x - b.x, y: a.y - b.y });
export const neg = (a: Point): Point => ({ x: -a.x, y: -a.y });
export const eq = (a: Point | null | undefined, b: Point | null | undefined): boolean =>
  !!a && !!b && a.x === b.x && a.y === b.y;
export const outOfBounds = (p: Point): boolean => p.x < 0 || p.x > 4 || p.y < 0 || p.y > 4;
export const inBounds = (p: Point): boolean => !outOfBounds(p);
export const invertPoint = (p: Point): Point => ({ x: 4 - p.x, y: 4 - p.y });

// ---- Player ----
export const invertPlayer = (p: Player): Player => (p === 'rojo' ? 'azul' : 'rojo');

/** Contiene el punto (equivale a pieces.contains(&Some(p)) en Rust). */
export const containsPoint = (list: (Point | null)[], p: Point): boolean => list.some((q) => eq(q, p));
