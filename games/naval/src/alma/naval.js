/**
 * Partida de batalla naval dueño contra Alma (PLAN-JUEGOS, 2026-10-31).
 * Funciones puras sobre el árbitro del repo (boardTools: canAttack, checkAttack, checkSunk). Aquí se genera la lista de
 * disparos legales de Alma, el texto de lo que Alma ve y el historial. Alma NUNCA ve el tablero oculto del dueño:
 * stateText solo recibe los arrays de disparos (resultado agua/tocado/hundido), nunca un tablero con barcos.
 */
import {
  canAttack,
  checkAttack,
  checkSunk,
  coordinateToIndex,
} from '../utils/boardTools';
import * as BLOCK_STATE from '../utils/blockStates';
import * as SHIPS from '../utils/ships';

export const ROW_LETTERS = 'ABCDEFGH';
export const SIZE = 8;
export const FLEET = [SHIPS.CARRIER, SHIPS.BATTLESHIP, SHIPS.DESTROYER, SHIPS.SUBMARINE, SHIPS.PATROL];
export const FLEET_CELLS = FLEET.reduce((n, s) => n + s.length, 0); // 17

const SHIP_BY_NAME = Object.fromEntries(FLEET.map((s) => [s.name, s]));
export const shipEs = (name) => SHIP_BY_NAME[name]?.es ?? name;

/** Id estable de casilla: fila A–H + columna 1–8 (p. ej. "C5"). */
export const cellId = (row, col) => ROW_LETTERS[row] + (col + 1);
export const parseCellId = (id) => {
  const m = /^([A-H])([1-8])$/.exec(String(id ?? '').trim().toUpperCase());
  return m ? { row: ROW_LETTERS.indexOf(m[1]), col: Number(m[2]) - 1 } : null;
};

/** Array de disparos vacío, con el cursor "selecting" en la posición 0 como en el repo. */
export const newAttack = () => [{ position: { row: null, col: null }, state: BLOCK_STATE.SELECTING }];

/** Árbitro: ¿se puede disparar a (row, col)? Usa canAttack del repo. */
export function canShoot(attack, row, col) {
  if (!Number.isInteger(row) || !Number.isInteger(col)) return false;
  if (row < 0 || row >= SIZE || col < 0 || col >= SIZE) return false;
  return canAttack([{ position: { row, col } }, ...attack.slice(1)]);
}

/**
 * Aplica un disparo con las reglas del repo. Devuelve {attack, result: 'agua'|'tocado'|'hundido', sunk} o null si no
 * es legal. No muta el array recibido (checkSunk del repo muta sus elementos, por eso se copian antes).
 */
export function applyShot(attack, finalBoard, row, col) {
  if (!canShoot(attack, row, col)) return null;
  const isHit = checkAttack(finalBoard, { row, col });
  const ship = finalBoard[coordinateToIndex(row, col)];
  const copy = attack.map((it) => ({ ...it, position: { ...it.position } }));
  copy.push({ position: { row, col }, state: isHit ? BLOCK_STATE.HIT : BLOCK_STATE.MISS, ship });
  const after = checkSunk(copy, finalBoard, row, col);
  const sunk = isHit && after[after.length - 1].state === BLOCK_STATE.SANK ? ship : null;
  return { attack: after, result: sunk ? 'hundido' : isHit ? 'tocado' : 'agua', sunk };
}

/** ¿Hundida toda la flota? (mismo criterio que el repo: 17 casillas en "sank") */
export const allSunk = (attack) => attack.filter((it) => it.state === BLOCK_STATE.SANK).length === FLEET_CELLS;

export const shotsOf = (attack) => attack.slice(1);

/** Disparos legales de Alma: cada casilla a la que aún puede disparar (≤ 64). */
export function legalShots(attack) {
  const out = [];
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      if (canShoot(attack, r, c)) out.push({ id: cellId(r, c), label: `Disparar a ${cellId(r, c)}` });
    }
  }
  return out;
}

/** Barcos hundidos según un array de disparos (solo se sabe el nombre de un barco cuando se hunde). */
export const sunkShips = (attack) => [
  ...new Set(shotsOf(attack).filter((it) => it.state === BLOCK_STATE.SANK).map((it) => it.ship)),
];

const MARK = { [BLOCK_STATE.MISS]: 'o', [BLOCK_STATE.HIT]: 'X', [BLOCK_STATE.SANK]: '#' };

/**
 * Lo que Alma ve, en español compacto: su tablero de seguimiento sobre la flota del dueño (solo resultados), los barcos
 * del dueño a flote por tamaño, los tocados sin hundir y cómo va su propia flota.
 * almaAttack: disparos de Alma; ownerAttack: disparos del dueño sobre la flota de Alma.
 */
export function stateText(almaAttack, ownerAttack) {
  const grid = Array.from({ length: SIZE }, () => Array(SIZE).fill('·'));
  for (const it of shotsOf(almaAttack)) grid[it.position.row][it.position.col] = MARK[it.state] ?? '?';
  const lines = [
    'Tu tablero de disparos sobre la flota del dueño (sus barcos están ocultos).',
    'Leyenda: · sin disparar, o agua, X tocado sin hundir, # hundido.',
    '   1 2 3 4 5 6 7 8',
    ...grid.map((row, r) => `${ROW_LETTERS[r]}  ${row.join(' ')}`),
  ];
  const shots = shotsOf(almaAttack);
  const hits = shots.filter((it) => it.state !== BLOCK_STATE.MISS).length;
  lines.push(`Disparos hechos: ${shots.length} (${hits} en barco, ${shots.length - hits} al agua).`);

  const sunk = sunkShips(almaAttack);
  const afloat = FLEET.filter((s) => !sunk.includes(s.name));
  lines.push(`Barcos del dueño a flote: ${afloat.map((s) => `${s.es} (${s.length})`).join(', ') || 'ninguno'}.`);
  if (sunk.length) lines.push(`Barcos del dueño hundidos: ${sunk.map((n) => `${shipEs(n)} (${SHIP_BY_NAME[n]?.length})`).join(', ')}.`);

  const open = shots.filter((it) => it.state === BLOCK_STATE.HIT).map((it) => cellId(it.position.row, it.position.col));
  lines.push(open.length
    ? `Tocados sin hundir: ${open.join(', ')}. Dispara junto a ellos, en línea, para acabar ese barco.`
    : 'Tocados sin hundir: ninguno. Toca buscar barcos nuevos.');

  if (ownerAttack) {
    const own = shotsOf(ownerAttack);
    const ownHits = own.filter((it) => it.state !== BLOCK_STATE.MISS).length;
    const lost = sunkShips(ownerAttack);
    lines.push(`Tu flota: el dueño lleva ${own.length} disparos y te ha tocado ${ownHits} de ${FLEET_CELLS} casillas; ` +
      `te ha hundido: ${lost.map(shipEs).join(', ') || 'nada'}.`);
  }
  return lines.join('\n');
}

/** Una línea de historial en español. by: 'alma' | 'dueno'. */
export const logLine = ({ by, id, result, sunk }) =>
  `${by === 'alma' ? 'Alma' : 'Dueño'} dispara a ${id}: ${result}${sunk ? ` (${shipEs(sunk)})` : ''}`;

/** Historial reciente de ambos (lo último al final). */
export const historyText = (log, n = 24) => log.slice(-n).map(logLine);
