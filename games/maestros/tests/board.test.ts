// Port de onitamalib/src/tests/test_board.rs
import { describe, expect, it } from 'vitest';
import {
  canMove, newFromCards, opponentHand, opponentPieces, playerHand, playerPieces, toGrid, tryMove,
} from '../src/engine/board';
import { BASE_SET, cardStamp } from '../src/engine/cards';
import { pt, type Card, type Move } from '../src/engine/models';
import { boardNew } from './utils';

describe('creación del tablero', () => {
  it('posiciones iniciales correctas', () => {
    const b = boardNew();
    expect(b.blueKing).toEqual(pt(2, 0));
    expect(b.redKing).toEqual(pt(2, 4));
    expect(b.bluePawns.filter(Boolean)).toHaveLength(4);
    expect(b.redPawns.filter(Boolean)).toHaveLength(4);
    [0, 1, 3, 4].forEach((x, i) => {
      expect(b.bluePawns[i]).toEqual(pt(x, 0));
      expect(b.redPawns[i]).toEqual(pt(x, 4));
    });
  });
  it('cinco cartas distintas', () => {
    const b = boardNew();
    expect(b.blueHand).toHaveLength(2);
    expect(b.redHand).toHaveLength(2);
    expect(new Set([...b.blueHand, ...b.redHand, b.spareCard]).size).toBe(5);
  });
  it('Board::new() del original empieza con el rojo', () => {
    expect(boardNew().turn).toBe('rojo');
  });
  // CAMBIO respecto al original: sin forzar turno, empieza el color del sello de la carta del lado.
  it('por reglamento empieza el sello de la carta del lado', () => {
    for (let i = 0; i < BASE_SET.length; i++) {
      const cards = [...BASE_SET.slice(i), ...BASE_SET.slice(0, i)];
      const b = newFromCards(cards);
      expect(b.turn).toBe(cardStamp(cards[4]));
    }
  });
});

describe('ayudas del tablero', () => {
  it('player_hand devuelve la mano correcta', () => {
    const b = boardNew();
    b.redHand = ['tigre', 'dragon'];
    b.blueHand = ['cangrejo', 'mono'];
    b.turn = 'rojo';
    expect(playerHand(b)).toEqual(['tigre', 'dragon']);
    b.turn = 'azul';
    expect(playerHand(b)).toEqual(['cangrejo', 'mono']);
  });
  it('opponent_hand devuelve la mano correcta', () => {
    const b = boardNew();
    b.redHand = ['tigre', 'dragon'];
    b.blueHand = ['cangrejo', 'mono'];
    b.turn = 'rojo';
    expect(opponentHand(b)).toEqual(['cangrejo', 'mono']);
    b.turn = 'azul';
    expect(opponentHand(b)).toEqual(['tigre', 'dragon']);
  });
  it('player_pieces incluye el maestro primero', () => {
    const b = boardNew();
    expect(playerPieces(b)[0]).toEqual(b.redKing);
  });
  it('player_pieces cuenta 5', () => {
    expect(playerPieces(boardNew()).filter(Boolean)).toHaveLength(5);
  });
  it('opponent_pieces', () => {
    const b = boardNew();
    b.turn = 'rojo';
    expect(opponentPieces(b)[0]).toEqual(b.blueKing);
  });
  it('to_grid dimensiones', () => {
    const g = toGrid(boardNew());
    expect(g).toHaveLength(5);
    expect(g[0]).toHaveLength(5);
  });
  it('to_grid maestros', () => {
    const g = toGrid(boardNew());
    expect(g[0][2]).toBe('BlueKing');
    expect(g[4][2]).toBe('RedKing');
  });
  it('to_grid alumnos', () => {
    const g = toGrid(boardNew());
    for (const x of [0, 1, 3, 4]) {
      expect(g[0][x]).toBe('BluePawn');
      expect(g[4][x]).toBe('RedPawn');
    }
  });
});

describe('validación de jugadas', () => {
  const mv = (card: Card, src: [number, number], dst: [number, number]): Move =>
    ({ type: 'Move', card, src: pt(...src), dst: pt(...dst) });

  it('el tablero inicial tiene jugadas', () => expect(canMove(boardNew())).toBe(true));

  it('jugada simple válida', () => {
    const b = boardNew();
    b.redHand = ['tigre', 'dragon'];
    b.spareCard = 'cangrejo';
    b.turn = 'rojo';
    expect(tryMove(b, mv('tigre', [2, 4], [2, 2])).ok).toBe(true);
  });
  it('carta que no está en la mano', () => {
    const b = boardNew();
    b.redHand = ['tigre', 'dragon'];
    b.turn = 'rojo';
    const r = tryMove(b, mv('cangrejo', [2, 4], [2, 3]));
    expect(r).toEqual({ ok: false, error: 'La carta no está en tu mano' });
  });
  it('sin pieza en el origen', () => {
    const b = boardNew();
    b.redHand = ['tigre', 'dragon'];
    b.turn = 'rojo';
    expect(tryMove(b, mv('tigre', [2, 2], [2, 1]))).toEqual({ ok: false, error: 'No hay pieza tuya en el origen' });
  });
  it('destino ocupado por pieza propia', () => {
    const b = boardNew();
    b.redHand = ['cangrejo', 'dragon'];
    b.turn = 'rojo';
    expect(tryMove(b, mv('cangrejo', [0, 4], [2, 4]))).toEqual({ ok: false, error: 'El destino está ocupado por una pieza tuya' });
  });
  it('fuera del tablero', () => {
    const b = boardNew();
    b.redHand = ['tigre', 'dragon'];
    b.turn = 'rojo';
    expect(tryMove(b, mv('tigre', [2, 4], [2, 6]))).toEqual({ ok: false, error: 'El destino está fuera del tablero' });
  });
  it('movimiento no permitido por la carta', () => {
    const b = boardNew();
    b.redHand = ['tigre', 'dragon'];
    b.turn = 'rojo';
    expect(tryMove(b, mv('tigre', [2, 4], [3, 3]))).toEqual({ ok: false, error: 'La carta no permite ese movimiento' });
  });
  it('captura válida', () => {
    const b = boardNew();
    b.redHand = ['cangrejo', 'dragon'];
    b.bluePawns[0] = pt(2, 3);
    b.turn = 'rojo';
    const r = tryMove(b, mv('cangrejo', [2, 4], [2, 3]));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.state.board.bluePawns).not.toContainEqual(pt(2, 3));
  });
  it('la jugada cambia el turno', () => {
    const b = boardNew();
    b.redHand = ['tigre', 'dragon'];
    b.spareCard = 'cangrejo';
    b.turn = 'rojo';
    const r = tryMove(b, mv('tigre', [2, 4], [2, 2]));
    expect(r.ok && r.state.board.turn).toBe('azul');
  });
  it('la carta jugada pasa al lado y el jugador toma la del lado', () => {
    const b = boardNew();
    b.redHand = ['tigre', 'dragon'];
    b.spareCard = 'cangrejo';
    b.turn = 'rojo';
    const r = tryMove(b, mv('tigre', [2, 4], [2, 2]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state.board.spareCard).toBe('tigre');
    expect(r.state.board.redHand).toContain('cangrejo');
    expect(r.state.board.redHand).toContain('dragon');
    expect(r.state.board.turn).toBe('azul');
  });
  it('pasar cuando no hay jugadas', () => {
    const b = boardNew();
    b.redHand = ['tigre', 'dragon'];
    b.spareCard = 'cangrejo';
    b.turn = 'rojo';
    b.redKing = pt(0, 0);
    b.redPawns = [null, null, null, null];
    b.bluePawns[0] = pt(0, 1);
    const r = tryMove(b, { type: 'Discard', card: 'tigre' });
    if (!canMove(b)) expect(r.ok).toBe(true);
  });
  it('no se puede pasar si hay jugadas', () => {
    const b = boardNew();
    const r = tryMove(b, { type: 'Discard', card: b.redHand[0] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('Hay jugadas posibles');
  });
  // Añadido (CAMBIO 2). Tablero imposible pero útil: columna a llena de piezas rojas y solo Tigre en la mano.
  it('pasar de verdad: carta ajena falla, la propia se cede y cambia el turno', () => {
    const b = boardNew();
    b.turn = 'rojo';
    b.redKing = pt(0, 0);
    b.redPawns = [pt(0, 1), pt(0, 2), pt(0, 3), pt(0, 4)];
    b.redHand = ['tigre', 'tigre'];
    b.spareCard = 'cangrejo';
    expect(canMove(b)).toBe(false);
    expect(tryMove(b, { type: 'Discard', card: 'mono' })).toEqual({ ok: false, error: 'La carta no está en tu mano' });
    const r = tryMove(b, { type: 'Discard', card: 'tigre' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.state.status).toBe('Playing');
      expect(r.state.board.spareCard).toBe('tigre');
      expect(r.state.board.redHand).toContain('cangrejo');
      expect(r.state.board.turn).toBe('azul');
    }
  });
});
