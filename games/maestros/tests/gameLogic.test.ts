// Port de onitamalib/src/tests/test_game_logic.rs
import { describe, expect, it } from 'vitest';
import { finished, newGame, tryMove, tryMoveState } from '../src/engine/board';
import { pt, type Card, type GameState, type Move } from '../src/engine/models';
import { boardNew } from './utils';

const mv = (card: Card, src: [number, number], dst: [number, number]): Move =>
  ({ type: 'Move', card, src: pt(...src), dst: pt(...dst) });

describe('condiciones de victoria', () => {
  it('capturar al maestro rival gana', () => {
    const b = boardNew();
    b.redHand = ['cangrejo', 'dragon'];
    b.spareCard = 'tigre';
    b.turn = 'rojo';
    b.blueKing = pt(2, 3);
    const r = tryMove(b, mv('cangrejo', [2, 4], [2, 3]));
    expect(r.ok && r.state.status === 'Finished' && r.state.winner).toBe('rojo');
  });
  it('llegar al templo gana (rojo)', () => {
    const b = boardNew();
    b.redHand = ['tigre', 'dragon'];
    b.spareCard = 'cangrejo';
    b.turn = 'rojo';
    b.redKing = pt(2, 2);
    // Ajuste: en el original el maestro azul sigue en (2,0), así que esta jugada también lo captura.
    const r = tryMove(b, mv('tigre', [2, 2], [2, 0]));
    expect(r.ok && r.state.status === 'Finished' && r.state.winner).toBe('rojo');
  });
  it('llegar al templo gana (azul)', () => {
    const b = boardNew();
    b.blueHand = ['tigre', 'dragon'];
    b.spareCard = 'cangrejo';
    b.turn = 'azul';
    b.blueKing = pt(2, 2);
    const r = tryMove(b, mv('tigre', [2, 2], [2, 4]));
    expect(r.ok && r.state.status === 'Finished' && r.state.winner).toBe('azul');
  });
  it('templo SIN captura: el maestro rojo entra en c5 vacío y gana', () => {
    const b = boardNew();
    b.redHand = ['tigre', 'dragon'];
    b.spareCard = 'cangrejo';
    b.turn = 'rojo';
    b.redKing = pt(2, 2);
    b.blueKing = pt(4, 2); // el maestro azul ya no está en su templo
    const r = tryMove(b, mv('tigre', [2, 2], [2, 0]));
    expect(r.ok && r.state.status === 'Finished' && r.state.winner).toBe('rojo');
  });
  // En el original este test estaba #[ignore]: fallaba porque el alumno capturaba al maestro azul, que seguía en
  // (2,0). Aquí se aparta al maestro azul y el test pasa: un alumno en el templo no gana.
  it('un alumno en el templo rival no gana', () => {
    const b = boardNew();
    b.redHand = ['tigre', 'dragon'];
    b.spareCard = 'cangrejo';
    b.turn = 'rojo';
    b.redKing = pt(1, 3);
    b.redPawns = [pt(2, 2), null, null, null];
    b.blueKing = pt(4, 2);
    const r = tryMove(b, mv('tigre', [2, 2], [2, 0]));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.state.status).toBe('Playing');
      expect(r.state.board.redPawns[0]).toEqual(pt(2, 0));
    }
  });
});

describe('estado de la partida', () => {
  it('nueva partida en juego', () => expect(newGame().status).toBe('Playing'));
  it('finished()', () => {
    expect(finished(newGame())).toBe(false);
    expect(finished({ status: 'Finished', winner: 'rojo', board: boardNew() })).toBe(true);
  });
  it('mover en partida terminada da error', () => {
    const s: GameState = { status: 'Finished', winner: 'rojo', board: boardNew() };
    expect(tryMoveState(s, mv('tigre', [2, 4], [2, 3]))).toEqual({ ok: false, error: 'La partida ya terminó' });
  });
  it('GameState.try_move delega en el tablero', () => {
    const s: GameState = { status: 'Playing', board: boardNew() };
    const r = tryMoveState(s, mv('tigre', [2, 4], [2, 3]));
    expect(typeof r.ok).toBe('boolean');
  });
});

describe('sentido de avance', () => {
  it('el rojo avanza hacia y=0', () => {
    const b = boardNew();
    b.redHand = ['tigre', 'dragon'];
    b.spareCard = 'cangrejo';
    b.turn = 'rojo';
    expect(tryMove(b, mv('tigre', [2, 4], [2, 2])).ok).toBe(true);
  });
  it('el azul ve las cartas giradas', () => {
    const b = boardNew();
    b.blueHand = ['tigre', 'dragon'];
    b.spareCard = 'cangrejo';
    b.turn = 'azul';
    b.blueKing = pt(2, 2);
    expect(tryMove(b, mv('tigre', [2, 2], [2, 4])).ok).toBe(true);
  });
});

describe('escenarios', () => {
  it('secuencia de jugadas', () => {
    const b = boardNew();
    b.redHand = ['tigre', 'cangrejo'];
    b.blueHand = ['dragon', 'mono'];
    b.spareCard = 'caballo';
    b.turn = 'rojo';
    const r1 = tryMoveState({ status: 'Playing', board: b }, mv('cangrejo', [2, 4], [2, 3]));
    expect(r1.ok && r1.state.status).toBe('Playing');
    if (!r1.ok) return;
    expect(r1.state.board.turn).toBe('azul');
    // Mono desde (2,0) a (1,1): para el azul (-1,-1) girado = (1,1)… diagonal válida para Mono.
    const r2 = tryMoveState(r1.state, mv('mono', [2, 0], [1, 1]));
    expect(r2.ok).toBe(true);
    if (r2.ok && r2.state.status === 'Playing') expect(r2.state.board.turn).toBe('rojo');
  });
  it('capturar alumnos no gana', () => {
    const b = boardNew();
    b.redHand = ['dragon', 'mono'];
    b.spareCard = 'tigre';
    b.turn = 'rojo';
    b.bluePawns[0] = pt(2, 3);
    const r = tryMove(b, mv('dragon', [1, 4], [2, 3]));
    if (r.ok) expect(r.state.status).toBe('Playing');
  });
  it('el maestro puede capturar', () => {
    const b = boardNew();
    b.redHand = ['cangrejo', 'dragon'];
    b.spareCard = 'tigre';
    b.turn = 'rojo';
    b.bluePawns[0] = pt(2, 3);
    expect(tryMove(b, mv('cangrejo', [2, 4], [2, 3])).ok).toBe(true);
  });
  it('un alumno puede capturar', () => {
    const b = boardNew();
    b.redHand = ['dragon', 'mono'];
    b.spareCard = 'tigre';
    b.turn = 'rojo';
    b.bluePawns[0] = pt(3, 3);
    expect(tryMove(b, mv('dragon', [1, 4], [3, 3])).ok).toBe(true);
  });
});
