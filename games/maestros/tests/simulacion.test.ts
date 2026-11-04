// Simulación de 100 partidas completas por el motor y el protocolo de Alma:
// Alma (azul) elige al azar de su lista legal {id,label}; el dueño (rojo) juega al azar entre sus jugadas legales.
import { describe, expect, it } from 'vitest';
import { legalMoves, newGame, tryMoveState } from '../src/engine/board';
import type { Board, GameState } from '../src/engine/models';
import { ALMA, almaLegal, findLegal, historyLine, moveId, parseMoveId, stateText } from '../src/alma/protocol';
import { seeded } from './utils';

const CAP = 300;
const key = (b: Board) => JSON.stringify(b);

describe('simulación de 100 partidas', () => {
  it('ids válidos y únicos, y toda partida termina', () => {
    const rng = seeded(2026);
    let invalid = 0, duplicated = 0, hitCap = 0, cycled = 0, almaStarts = 0, passes = 0, plies = 0;
    const wins = { alma: 0, dueno: 0 };
    for (let g = 0; g < 100; g++) {
      let s: GameState = newGame(rng); // empieza quien diga el sello de la carta del lado
      if (s.board.turn === ALMA) almaStarts++;
      const seen = new Map<string, number>();
      let ply = 0;
      let repeated = false;
      while (s.status === 'Playing' && ply < CAP) {
        const b = s.board;
        const k = key(b);
        if (seen.has(k)) repeated = true;
        seen.set(k, ply);
        let id: string;
        if (b.turn === ALMA) {
          const legal = almaLegal(b);
          const ids = legal.map((l) => l.id);
          if (new Set(ids).size !== ids.length) duplicated++;
          for (const l of legal) {
            if (l.id.length > 40 || !l.label) invalid++;
            if (moveId(parseMoveId(l.id)!) !== l.id) invalid++;
          }
          expect(stateText(b).length).toBeGreaterThan(100);
          id = legal[Math.floor(rng() * legal.length)].id;
        } else {
          const ms = legalMoves(b);
          const ids = ms.map(moveId);
          if (new Set(ids).size !== ids.length) duplicated++;
          id = ids[Math.floor(rng() * ids.length)];
        }
        if (id.startsWith('pasa:')) passes++;
        // El árbitro: la jugada elegida tiene que estar entre las legales y aplicarse sin error.
        const m = findLegal(b, id);
        if (!m) { invalid++; break; }
        expect(historyLine(b, m).length).toBeGreaterThan(5);
        const r = tryMoveState(s, m);
        if (!r.ok) { invalid++; break; }
        s = r.state;
        ply++;
      }
      plies += ply;
      if (s.status === 'Finished') wins[s.winner === ALMA ? 'alma' : 'dueno']++;
      else { hitCap++; if (repeated) cycled++; }
    }
    // Informe en la salida de las pruebas.
    console.log(`[simulación] 100 partidas, ${plies} medias jugadas; gana Alma ${wins.alma}, gana dueño ${wins.dueno}; ` +
      `empieza Alma ${almaStarts}; pases ${passes}; tope ${CAP} alcanzado ${hitCap} (con ciclo ${cycled}); ` +
      `ids inválidos ${invalid}; turnos con ids duplicados ${duplicated}`);
    expect(invalid).toBe(0);
    expect(duplicated).toBe(0);
    expect(wins.alma + wins.dueno + hitCap).toBe(100);
    expect(cycled).toBe(hitCap); // solo cuenta como tablas si de verdad se repite la posición
  });
});
