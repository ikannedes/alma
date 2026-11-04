// Pruebas del texto y los ids que se mandan a Alma.
import { describe, expect, it } from 'vitest';
import { newFromCards } from '../src/engine/board';
import { pt } from '../src/engine/models';
import {
  almaLabel, almaLegal, cardShifts, findLegal, historyLine, moveId, parseMoveId, parseSq, sq, stateText,
} from '../src/alma/protocol';

const base = () => newFromCards(['tigre', 'grulla', 'mono', 'cangrejo', 'dragon'], 'azul');

describe('coordenadas e ids', () => {
  it('a1 es la esquina del dueño y c5 el templo de Alma', () => {
    expect(sq(pt(0, 4))).toBe('a1');
    expect(sq(pt(2, 0))).toBe('c5');
    expect(parseSq('e3')).toEqual(pt(4, 2));
  });
  it('ids estables y reversibles', () => {
    const b = base();
    for (const l of almaLegal(b)) {
      expect(l.id).toMatch(/^[a-z]+:[a-e][1-5]-[a-e][1-5]$/);
      expect(moveId(parseMoveId(l.id)!)).toBe(l.id);
      expect(findLegal(b, l.id)).toEqual(l.move);
    }
    expect(findLegal(b, 'tigre:c5-c1')).toBeNull();
    expect(parseMoveId('pasa:tigre')).toEqual({ type: 'Discard', card: 'tigre' });
    expect(parseMoveId('pasa:onitama')).toBeNull();
  });
  it('Tigre de Alma: alumno b5 → b3 (adelante 2 para el azul)', () => {
    const b = base();
    expect(almaLegal(b).map((l) => l.id)).toContain('tigre:b5-b3');
    expect(cardShifts('tigre', 'azul')).toBe('(0,−2) (0,+1)');
    expect(cardShifts('tigre', 'rojo')).toBe('(0,+2) (0,−1)');
  });
});

describe('etiquetas', () => {
  it('marca captura y victoria', () => {
    const b = base();
    b.redPawns[1] = pt(1, 2); // alumno del dueño en b3
    const cap = findLegal(b, 'tigre:b5-b3')!;
    expect(almaLabel(b, cap)).toBe('Tigre: alumno de b5 a b3, captura un alumno');
    b.redKing = pt(2, 2); // maestro del dueño en c3
    const win = findLegal(b, 'tigre:c5-c3')!;
    expect(almaLabel(b, win)).toContain('GANAS');
    expect(historyLine(b, win)).toContain('GANA ALMA');
  });
  it('marca la entrada en el templo', () => {
    const b = base();
    b.blueKing = pt(2, 2);
    b.redKing = pt(4, 2);
    const m = findLegal(b, 'tigre:c3-c1')!;
    expect(almaLabel(b, m)).toContain('templo del dueño (c1) y GANAS');
  });
  it('pasar se expone como pasa:<carta>', () => {
    const b = base();
    b.blueHand = ['tigre', 'tigre'];
    b.blueKing = pt(0, 4);
    b.bluePawns = [pt(0, 3), pt(0, 2), pt(0, 1), pt(0, 0)];
    const legal = almaLegal(b);
    expect(legal.map((l) => l.id)).toEqual(['pasa:tigre']);
    expect(legal[0].label).toContain('Pasar');
  });
});

describe('estado para Alma', () => {
  it('incluye piezas, cartas, carta del lado y templos', () => {
    const t = stateText(base());
    expect(t).toContain('Tus piezas: maestro c5; alumnos: a5, b5, d5, e5.');
    expect(t).toContain('Piezas del dueño (ROJO): maestro c1; alumnos: a1, b1, d1, e1.');
    expect(t).toContain('Tus cartas: Tigre');
    expect(t).toContain('Carta del lado: Dragón');
    expect(t).toContain('Templo del dueño: c1');
    expect(t).not.toMatch(/onitama/i);
  });
});
