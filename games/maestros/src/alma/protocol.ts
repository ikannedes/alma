// Lo que Alma ve y puede elegir en Maestros (PLAN-JUEGOS del dueño). Código puro (sin red) para poder probarlo.
// El motor (src/engine) es el árbitro: aquí solo se traducen las jugadas legales a ids estables y texto en castellano.
// Coordenadas absolutas para todos (ids, historial y tablero): columnas a–e de izquierda a derecha vistas por el
// dueño, filas 1–5 desde el lado del dueño. El dueño juega con ROJO (abajo, fila 1) y Alma con AZUL (arriba, fila 5).
import { cardMoves, cardName, isCard } from '../engine/cards';
import {
  goalSquare, legalMoves, opponentKing, opponentPieces, playerKing, tryMove, cloneBoard,
} from '../engine/board';
import { containsPoint, eq, type Board, type Card, type GameState, type Move, type Player, type Point } from '../engine/models';

export const OWNER: Player = 'rojo';
export const ALMA: Player = 'azul';

export type Who = 'alma' | 'dueno';
export const whoOf = (p: Player): Who => (p === ALMA ? 'alma' : 'dueno');
export const playerOf = (w: Who): Player => (w === 'alma' ? ALMA : OWNER);

/** Casilla en notación a1..e5 (a1 = esquina inferior izquierda del dueño). */
export const sq = (p: Point): string => 'abcde'[p.x] + String(5 - p.y);
export function parseSq(s: string): Point | null {
  const m = /^([a-e])([1-5])$/.exec(s);
  return m ? { x: 'abcde'.indexOf(m[1]), y: 5 - Number(m[2]) } : null;
}

/** Id estable de una jugada: "tigre:b1-b3" o "pasa:tigre" (siempre ≤ 40 caracteres). */
export function moveId(m: Move): string {
  return m.type === 'Discard' ? `pasa:${m.card}` : `${m.card}:${sq(m.src)}-${sq(m.dst)}`;
}

/** Inverso de moveId (no valida legalidad: eso lo hace el motor). */
export function parseMoveId(id: string): Move | null {
  const pasa = /^pasa:([a-z]+)$/.exec(id);
  if (pasa) return isCard(pasa[1]) ? { type: 'Discard', card: pasa[1] } : null;
  const m = /^([a-z]+):([a-e][1-5])-([a-e][1-5])$/.exec(id);
  if (!m || !isCard(m[1])) return null;
  const src = parseSq(m[2]);
  const dst = parseSq(m[3]);
  return src && dst ? { type: 'Move', card: m[1] as Card, src, dst } : null;
}

/** ¿Puede el jugador en turno ganar ya mismo con alguna jugada? */
function hasWinningMove(b: Board): boolean {
  return legalMoves(b).some((m) => {
    const r = tryMove(b, m);
    return r.ok && r.state.status === 'Finished';
  });
}

interface MoveInfo {
  pieza: 'maestro' | 'alumno';
  captura: null | 'maestro' | 'alumno';
  templo: boolean; // el maestro llega al templo rival
  gana: boolean;
}

export function moveInfo(b: Board, m: Move): MoveInfo | null {
  if (m.type === 'Discard') return null;
  const capt = containsPoint(opponentPieces(b), m.dst);
  const capMaestro = eq(opponentKing(b), m.dst);
  const maestro = eq(playerKing(b), m.src);
  const templo = maestro && eq(goalSquare(b.turn), m.dst);
  return {
    pieza: maestro ? 'maestro' : 'alumno',
    captura: capMaestro ? 'maestro' : capt ? 'alumno' : null,
    templo,
    gana: capMaestro || templo,
  };
}

/** Etiqueta para Alma (le toca a ella): "Tigre: alumno de b5 a b3, captura un alumno". */
export function almaLabel(b: Board, m: Move): string {
  if (m.type === 'Discard') return `Pasar (no tienes ninguna jugada): cedes ${cardName(m.card)} sin mover`;
  const i = moveInfo(b, m)!;
  let s = `${cardName(m.card)}: ${i.pieza} de ${sq(m.src)} a ${sq(m.dst)}`;
  if (i.captura === 'maestro') s += ', captura al maestro del dueño y GANAS';
  else if (i.templo) s += `, tu maestro entra en el templo del dueño (${sq(goalSquare(b.turn))}) y GANAS`;
  else {
    if (i.captura) s += ', captura un alumno';
    const r = tryMove(b, m);
    if (r.ok && r.state.status === 'Playing' && hasWinningMove(r.state.board)) s += ' (¡ojo! después el dueño podría ganar)';
  }
  return s;
}

/** Jugadas legales de Alma: [{id, label, move}] con ids únicos (se descartan repetidos por si acaso). */
export function almaLegal(b: Board): { id: string; label: string; move: Move }[] {
  const seen = new Set<string>();
  const out: { id: string; label: string; move: Move }[] = [];
  for (const m of legalMoves(b)) {
    const id = moveId(m);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, label: almaLabel(b, m), move: m });
  }
  return out;
}

/** Busca la jugada elegida por Alma entre las legales actuales; null si el id no vale. */
export function findLegal(b: Board, id: string): Move | null {
  return legalMoves(b).find((m) => moveId(m) === id) ?? null;
}

/** Línea de historial en castellano (quien mueve = b.turn). */
export function historyLine(b: Board, m: Move): string {
  const who = whoOf(b.turn) === 'alma' ? 'Alma' : 'Dueño';
  const rival = whoOf(b.turn) === 'alma' ? 'del dueño' : 'de Alma';
  if (m.type === 'Discard') return `${who}: pasa (sin jugadas) y cede ${cardName(m.card)}`;
  const i = moveInfo(b, m)!;
  let s = `${who}: ${cardName(m.card)}, ${i.pieza} ${sq(m.src)}→${sq(m.dst)}`;
  if (i.captura) s += `, captura ${i.captura === 'maestro' ? 'al maestro' : 'un alumno'} ${rival}`;
  if (i.templo) s += ', entra en el templo rival';
  if (i.gana) s += ` — GANA ${who === 'Alma' ? 'ALMA' : 'EL DUEÑO'}`;
  return s;
}

// ---- Descripción de cartas ----
const n = (v: number) => (v > 0 ? `+${v}` : v < 0 ? `−${-v}` : '0');

/** Movimientos de la carta en palabras, desde el punto de vista de quien la usa. */
export function cardWords(c: Card): string {
  return cardMoves(c)
    .map(({ x, y }) => {
      const parts: string[] = [];
      if (y < 0) parts.push(`adelante ${-y}`);
      if (y > 0) parts.push(`atrás ${y}`);
      if (x > 0) parts.push(`derecha ${x}`);
      if (x < 0) parts.push(`izquierda ${-x}`);
      return parts.join(' y ');
    })
    .join('; ');
}

/** Desplazamientos absolutos (columna, fila) de la carta para un jugador. */
export function cardShifts(c: Card, p: Player): string {
  return cardMoves(c)
    .map(({ x, y }) => (p === OWNER ? `(${n(x)},${n(-y)})` : `(${n(-x)},${n(y)})`))
    .join(' ');
}

const cardLine = (c: Card, p: Player) =>
  `${cardName(c)}: ${cardWords(c)} → en coordenadas (columna,fila) ${p === ALMA ? 'para ti' : 'para el dueño'}: ${cardShifts(c, p)}`;

function piecesText(king: Point, pawns: (Point | null)[]): string {
  const al = pawns.filter((p): p is Point => !!p).map(sq).sort();
  return `maestro ${sq(king)}; alumnos: ${al.length ? al.join(', ') : 'ninguno'}`;
}

/** Amenazas: capturas (o victoria) que el jugador `p` tendría si le tocara ahora. */
function threats(b: Board, p: Player): string[] {
  const bb = cloneBoard(b);
  bb.turn = p;
  const out: string[] = [];
  for (const m of legalMoves(bb)) {
    if (m.type !== 'Move') continue;
    const i = moveInfo(bb, m)!;
    if (i.gana) out.push(`GANAR con ${cardName(m.card)} (${sq(m.src)}→${sq(m.dst)}${i.templo ? ', templo' : ', captura maestro'})`);
    else if (i.captura) out.push(`capturar en ${sq(m.dst)} con ${cardName(m.card)} desde ${sq(m.src)}`);
  }
  return [...new Set(out)];
}

/** Texto compacto en castellano de lo que Alma ve (desde su lado). */
export function stateText(b: Board): string {
  const rows: string[] = ['    a b c d e'];
  const grid: string[][] = Array.from({ length: 5 }, () => Array(5).fill('·'));
  for (const p of b.redPawns) if (p) grid[p.y][p.x] = 'd';
  for (const p of b.bluePawns) if (p) grid[p.y][p.x] = 'a';
  grid[b.redKing.y][b.redKing.x] = 'D';
  grid[b.blueKing.y][b.blueKing.x] = 'A';
  for (let y = 0; y < 5; y++) rows.push(` ${5 - y}  ${grid[y].join(' ')}`);
  const almaThreats = threats(b, OWNER);
  return [
    'Maestros (tablero 5×5, columnas a–e, filas 1–5). Tú (Alma) eres AZUL y empezaste en la fila 5: "adelante" para ti es hacia la fila 1.',
    'Se gana capturando el maestro rival o llevando tu maestro al templo rival. Tu templo: c5. Templo del dueño: c1 (tu maestro gana si llega ahí).',
    `Tus piezas: ${piecesText(b.blueKing, b.bluePawns)}.`,
    `Piezas del dueño (ROJO): ${piecesText(b.redKing, b.redPawns)}.`,
    'Tablero (A = tu maestro, a = tu alumno, D = maestro del dueño, d = alumno del dueño):',
    ...rows,
    `Tus cartas: ${b.blueHand.map((c) => cardLine(c, ALMA)).join(' | ')}.`,
    `Cartas del dueño: ${b.redHand.map((c) => cardLine(c, OWNER)).join(' | ')}.`,
    `Carta del lado: ${cardName(b.spareCard)} (${cardWords(b.spareCard)}). Al jugar, te quedas con ella y la carta que uses queda al lado; el dueño la recibirá cuando juegue él.`,
    almaThreats.length
      ? `Ahora mismo el dueño, con sus cartas, podría: ${almaThreats.join('; ')}.`
      : 'Ahora mismo el dueño no amenaza ninguna de tus piezas.',
  ].join('\n');
}

/** Resumen corto para pantalla: quién gana. */
export function winnerOf(s: GameState): Who | null {
  return s.status === 'Finished' ? whoOf(s.winner) : null;
}
