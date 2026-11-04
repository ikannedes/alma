// Port de onitamalib/src/tests/test_models.rs
import { describe, expect, it } from 'vitest';
import { add, inBounds, invertPlayer, invertPoint, neg, outOfBounds, sub, pt } from '../src/engine/models';
import { ALL_CARDS, cardDirection, cardFromIndex, cardIndex, cardMoves, cardName } from '../src/engine/cards';

describe('Point', () => {
  it('suma', () => expect(add(pt(1, 2), pt(3, 4))).toEqual(pt(4, 6)));
  it('resta', () => expect(sub(pt(5, 7), pt(2, 3))).toEqual(pt(3, 4)));
  it('negación', () => expect(neg(pt(3, -2))).toEqual(pt(-3, 2)));
  it('dentro del tablero', () => {
    for (const p of [pt(0, 0), pt(2, 2), pt(4, 4), pt(0, 2), pt(4, 2), pt(2, 0), pt(2, 4)]) expect(inBounds(p)).toBe(true);
  });
  it('fuera del tablero', () => {
    for (const p of [pt(-1, 0), pt(0, -1), pt(5, 2), pt(2, 5), pt(-1, -1), pt(5, 5)]) expect(outOfBounds(p)).toBe(true);
  });
  it('invertir', () => {
    expect(invertPoint(pt(1, 2))).toEqual(pt(3, 2));
    expect(invertPoint(pt(2, 2))).toEqual(pt(2, 2));
    expect(invertPoint(pt(0, 0))).toEqual(pt(4, 4));
    expect(invertPoint(pt(4, 4))).toEqual(pt(0, 0));
  });
});

describe('Player', () => {
  it('invertir', () => {
    expect(invertPlayer('rojo')).toBe('azul');
    expect(invertPlayer('azul')).toBe('rojo');
  });
  it('doble inversión', () => {
    expect(invertPlayer(invertPlayer('rojo'))).toBe('rojo');
    expect(invertPlayer(invertPlayer('azul'))).toBe('azul');
  });
});

describe('Card', () => {
  it('toda carta tiene entre 1 y 4 movimientos', () => {
    for (const c of ALL_CARDS) {
      expect(cardMoves(c).length).toBeGreaterThan(0);
      expect(cardMoves(c).length).toBeLessThanOrEqual(4);
    }
  });
  it('Tigre', () => {
    const m = cardMoves('tigre');
    expect(m).toHaveLength(2);
    expect(m).toContainEqual(pt(0, -2));
    expect(m).toContainEqual(pt(0, 1));
  });
  it('Cangrejo', () => {
    const m = cardMoves('cangrejo');
    expect(m).toHaveLength(3);
    expect(m).toContainEqual(pt(0, -1));
    expect(m).toContainEqual(pt(-2, 0));
    expect(m).toContainEqual(pt(2, 0));
  });
  it('Mono', () => {
    const m = cardMoves('mono');
    expect(m).toHaveLength(4);
    for (const p of [pt(-1, -1), pt(1, -1), pt(-1, 1), pt(1, 1)]) expect(m).toContainEqual(p);
  });
  it('índice ida y vuelta', () => {
    for (const c of ALL_CARDS) expect(cardFromIndex(cardIndex(c))).toBe(c);
  });
  it('índices únicos', () => {
    expect(new Set(ALL_CARDS.map(cardIndex)).size).toBe(ALL_CARDS.length);
  });
  it('dirección', () => {
    expect(cardDirection('rana')).toBe('izquierda');
    expect(cardDirection('conejo')).toBe('derecha');
    expect(cardDirection('tigre')).toBe('equilibrada');
    expect(cardDirection('dragon')).toBe('equilibrada');
  });
  it('nombre visible', () => {
    expect(cardName('tigre')).toBe('Tigre');
    expect(cardName('dragon')).toBe('Dragón');
  });
});
