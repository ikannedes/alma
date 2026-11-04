import { describe, expect, it } from 'vitest';
import { computerPlacingShip } from '../utils/computerTools';
import { canAttack, coordinateToIndex } from '../utils/boardTools';
import * as BLOCK_STATE from '../utils/blockStates';
import {
  FLEET,
  FLEET_CELLS,
  allSunk,
  applyShot,
  canShoot,
  historyText,
  legalShots,
  newAttack,
  parseCellId,
  stateText,
} from './naval';

const pick = (list) => list[Math.floor(Math.random() * list.length)];

/**
 * Una partida entera por el árbitro: el dueño dispara al azar; Alma "simulada" elige al azar de su lista legal
 * (como el enum de Haiku). Devuelve contadores para comprobar que nada se sale de las reglas.
 */
function playGame() {
  const ownerBoard = computerPlacingShip(FLEET);
  const almaBoard = computerPlacingShip(FLEET);
  let ownerAttack = newAttack();
  let almaAttack = newAttack();
  const log = [];
  let invalid = 0;
  let dupIds = 0;
  let winner = null;
  let leaks = 0;
  let owner = 0;
  let almaShots = 0;

  for (let turn = 0; turn < 200 && !winner; turn++) {
    // dueño
    const om = pick(legalShots(ownerAttack));
    const o = parseCellId(om.id);
    const ro = applyShot(ownerAttack, almaBoard, o.row, o.col);
    if (!ro) { invalid++; break; }
    ownerAttack = ro.attack;
    owner++;
    log.push({ by: 'dueno', id: om.id, result: ro.result, sunk: ro.sunk });
    if (allSunk(ownerAttack)) { winner = 'dueno'; break; }

    // Alma
    const legal = legalShots(almaAttack);
    const ids = legal.map((m) => m.id);
    if (new Set(ids).size !== ids.length) dupIds++;
    if (legal.length > 400 || legal.length === 0) invalid++;
    const text = stateText(almaAttack, ownerAttack);
    // lo que ve Alma no destapa barcos: solo marca casillas ya disparadas
    const marked = text.split('\n').filter((l) => /^[A-H] {2}/.test(l)).map((l) => l.slice(1)).join('').match(/[oX#]/g)?.length ?? 0;
    if (marked !== almaAttack.length - 1) leaks++;
    const m = pick(legal);
    const p = parseCellId(m.id);
    // el árbitro del repo (canAttack) confirma que la jugada es legal
    if (!canAttack([{ position: p }, ...almaAttack.slice(1)])) invalid++;
    const ra = applyShot(almaAttack, ownerBoard, p.row, p.col);
    if (!ra) { invalid++; break; }
    // el resultado coincide con el tablero oculto
    const hasShip = ownerBoard[coordinateToIndex(p.row, p.col)] !== BLOCK_STATE.EMTPY;
    if (hasShip !== (ra.result !== 'agua')) invalid++;
    almaAttack = ra.attack;
    almaShots++;
    log.push({ by: 'alma', id: m.id, result: ra.result, sunk: ra.sunk });
    if (allSunk(almaAttack)) { winner = 'alma'; break; }
  }
  // tras la partida, repetir cualquier casilla ya disparada debe rechazarse
  const first = almaAttack[1].position;
  if (canShoot(almaAttack, first.row, first.col) || applyShot(almaAttack, ownerBoard, first.row, first.col)) invalid++;
  return { winner, invalid, dupIds, leaks, owner, alma: almaShots, history: historyText(log) };
}

describe('Batalla naval contra Alma', () => {
  it('100 partidas simuladas: 0 disparos inválidos, ids únicas, siempre hay ganador, ≤64 disparos por bando', () => {
    const wins = { dueno: 0, alma: 0 };
    let maxOwner = 0;
    let maxAlma = 0;
    let totalAlma = 0;
    for (let i = 0; i < 100; i++) {
      const r = playGame();
      expect(r.invalid).toBe(0);
      expect(r.dupIds).toBe(0);
      expect(r.leaks).toBe(0);
      expect(r.winner).not.toBeNull();
      expect(r.owner).toBeLessThanOrEqual(64);
      expect(r.alma).toBeLessThanOrEqual(64);
      expect(r.history.length).toBeGreaterThan(0);
      wins[r.winner]++;
      maxOwner = Math.max(maxOwner, r.owner);
      maxAlma = Math.max(maxAlma, r.alma);
      totalAlma += r.alma;
    }
    expect(wins.dueno + wins.alma).toBe(100);
    console.log(`100 partidas: gana dueño ${wins.dueno}, gana Alma ${wins.alma}; máx. disparos dueño ${maxOwner}, ` +
      `máx. Alma ${maxAlma}; disparos de Alma en total ${totalAlma}, todos válidos.`);
  });

  it('lista legal: 64 casillas al empezar, ids A1..H8 únicas y etiquetas en español', () => {
    const legal = legalShots(newAttack());
    expect(legal).toHaveLength(64);
    expect(legal[0]).toEqual({ id: 'A1', label: 'Disparar a A1' });
    expect(legal[63].id).toBe('H8');
    expect(new Set(legal.map((m) => m.id)).size).toBe(64);
  });

  it('el estado de Alma cuenta tocados sin hundir y barcos a flote, sin destapar barcos', () => {
    const board = computerPlacingShip(FLEET);
    let attack = newAttack();
    // dispara a la primera casilla con barco y a una de agua
    const shipIdx = board.findIndex((c) => c !== BLOCK_STATE.EMTPY);
    const waterIdx = board.findIndex((c) => c === BLOCK_STATE.EMTPY);
    attack = applyShot(attack, board, Math.floor(shipIdx / 8), shipIdx % 8).attack;
    attack = applyShot(attack, board, Math.floor(waterIdx / 8), waterIdx % 8).attack;
    const text = stateText(attack, newAttack());
    expect(text).toContain('Tocados sin hundir: ' + 'ABCDEFGH'[Math.floor(shipIdx / 8)] + ((shipIdx % 8) + 1));
    expect(text).toContain('Portaaviones (5)');
    expect(text).toContain('Disparos hechos: 2 (1 en barco, 1 al agua)');
    // el nombre del barco tocado (sin hundir) no aparece como hundido
    expect(text).not.toContain('Barcos del dueño hundidos');
    expect(FLEET_CELLS).toBe(17);
  });

  it('rechaza ids fuera del tablero', () => {
    expect(parseCellId('I1')).toBeNull();
    expect(parseCellId('A9')).toBeNull();
    expect(parseCellId('')).toBeNull();
    expect(canShoot(newAttack(), 8, 0)).toBe(false);
  });
});
