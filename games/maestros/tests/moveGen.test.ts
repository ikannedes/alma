// Port de onitamalib/src/tests/test_move_gen.rs (+ comprobaciones sobre generate_test_states de utils.rs)
import { describe, expect, it } from 'vitest';
import { canMove, legalMoves, playerPieces, randomLegalMove, tryMove, tryMoveState } from '../src/engine/board';
import { eq, inBounds, pt, type Move } from '../src/engine/models';
import { boardNew, generateTestStates, seeded } from './utils';

const dstOf = (m: Move) => (m.type === 'Move' ? m.dst : null);

describe('generación de jugadas legales', () => {
  it('el tablero inicial tiene jugadas', () => expect(legalMoves(boardNew()).length).toBeGreaterThan(0));
  it('todas las jugadas generadas son válidas', () => {
    const b = boardNew();
    for (const m of legalMoves(b)) expect(tryMove(b, m).ok).toBe(true);
  });
  it('solo usa cartas de la mano', () => {
    const b = boardNew();
    b.redHand = ['tigre', 'cangrejo'];
    b.spareCard = 'dragon';
    b.turn = 'rojo';
    for (const m of legalMoves(b)) expect(['tigre', 'cangrejo']).toContain(m.card);
  });
  it('solo desde piezas propias', () => {
    const b = boardNew();
    b.turn = 'rojo';
    const own = playerPieces(b);
    for (const m of legalMoves(b)) if (m.type === 'Move') expect(own.some((p) => eq(p, m.src))).toBe(true);
  });
  it('nunca fuera del tablero', () => {
    for (const m of legalMoves(boardNew())) if (m.type === 'Move') expect(inBounds(m.dst)).toBe(true);
  });
  it('nunca sobre una pieza propia', () => {
    const b = boardNew();
    b.turn = 'rojo';
    const own = playerPieces(b);
    for (const m of legalMoves(b)) if (m.type === 'Move') expect(own.some((p) => eq(p, m.dst))).toBe(false);
  });
  it('las capturas van primero', () => {
    const b = boardNew();
    b.redHand = ['cangrejo', 'dragon'];
    b.spareCard = 'tigre';
    b.turn = 'rojo';
    b.bluePawns[0] = pt(2, 3);
    const ms = legalMoves(b);
    const isCap = (m: Move) => eq(dstOf(m), pt(2, 3));
    if (ms.some(isCap)) expect(ms.slice(0, 5).some(isCap)).toBe(true);
  });
  it('devuelve pasar cuando está bloqueado', () => {
    const b = boardNew();
    b.redHand = ['tigre', 'cangrejo'];
    b.spareCard = 'dragon';
    b.turn = 'rojo';
    b.redPawns = [null, null, null, null];
    b.redKing = pt(0, 0);
    b.bluePawns = [pt(1, 0), pt(0, 1), pt(2, 0), pt(0, 2)];
    const ms = legalMoves(b);
    if (!canMove(b)) {
      expect(ms.length).toBeGreaterThan(0);
      expect(ms.every((m) => m.type === 'Discard')).toBe(true);
    }
  });
  it('bloqueo real: solo jugadas de pasar, una por carta', () => {
    const b = boardNew();
    b.turn = 'rojo';
    b.redKing = pt(0, 0);
    b.redPawns = [pt(0, 1), pt(0, 2), pt(0, 3), pt(0, 4)];
    b.redHand = ['tigre', 'tigre'];
    const ms = legalMoves(b);
    expect(ms).toEqual([{ type: 'Discard', card: 'tigre' }, { type: 'Discard', card: 'tigre' }]);
  });
});

describe('jugada aleatoria', () => {
  it('siempre válida', () => {
    const b = boardNew();
    const rng = seeded(42);
    for (let i = 0; i < 10; i++) expect(tryMove(b, randomLegalMove(b, rng)).ok).toBe(true);
  });
  it('con variedad', () => {
    const b = boardNew();
    const rng = seeded(42);
    const seen = new Set<string>();
    for (let i = 0; i < 20; i++) seen.add(JSON.stringify(randomLegalMove(b, rng)));
    expect(seen.size).toBeGreaterThan(1);
  });
  it('usa las cartas del jugador', () => {
    const b = boardNew();
    b.redHand = ['tigre', 'cangrejo'];
    b.spareCard = 'dragon';
    b.turn = 'rojo';
    const rng = seeded(42);
    for (let i = 0; i < 10; i++) expect(['tigre', 'cangrejo']).toContain(randomLegalMove(b, rng).card);
  });
});

describe('casos límite', () => {
  it('con una sola pieza (el maestro)', () => {
    const b = boardNew();
    b.redPawns = [null, null, null, null];
    b.redHand = ['mono', 'tigre'];
    b.turn = 'rojo';
    const ms = legalMoves(b);
    expect(ms.length).toBeGreaterThan(0);
    for (const m of ms) if (m.type === 'Move') expect(m.src).toEqual(b.redKing);
  });
  it('con cartas limitadas', () => {
    const b = boardNew();
    b.redHand = ['tigre', 'tigre'];
    b.turn = 'rojo';
    expect(legalMoves(b).length).toBeGreaterThan(0);
  });
  it('can_move falso cuando está bloqueado ⇒ solo pasar', () => {
    const b = boardNew();
    b.redPawns = [null, null, null, null];
    b.redKing = pt(0, 0);
    b.redHand = ['mono', 'dragon'];
    b.turn = 'rojo';
    b.bluePawns = [pt(1, 0), pt(0, 1), pt(1, 1), null];
    if (!canMove(b)) expect(legalMoves(b).every((m) => m.type === 'Discard')).toBe(true);
  });
  it('número razonable de jugadas', () => {
    const n = legalMoves(boardNew()).length;
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThan(100);
  });
  it('determinista', () => {
    const b = boardNew();
    expect(JSON.stringify(legalMoves(b))).toBe(JSON.stringify(legalMoves(b)));
  });
});

describe('estados de prueba (utils.rs)', () => {
  it('100 estados intermedios: legales ⇔ válidos, y can_move coherente', () => {
    const states = generateTestStates();
    expect(states).toHaveLength(100);
    for (const s of states) {
      if (s.status !== 'Playing') continue;
      const ms = legalMoves(s.board);
      for (const m of ms) expect(tryMoveState(s, m).ok).toBe(true);
      expect(ms.some((m) => m.type === 'Move')).toBe(canMove(s.board));
    }
  });
});
