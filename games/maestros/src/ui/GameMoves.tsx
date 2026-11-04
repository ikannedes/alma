// Rejilla 5×5 de movimientos de una carta (adaptado de src/GameBoard/GameMoves.jsx del original, sin Material-UI).
import { memo } from 'react';
import type { CardDirection, Point } from '../engine/models';

const IDX = [-2, -1, 0, 1, 2];

function GameMoves({ moves, inverted, direction }: { moves: Point[]; inverted: boolean; direction: CardDirection }) {
  const set = new Set(moves.map(({ x, y }) => `${x},${y}`));
  const rows = inverted ? [...IDX].reverse() : IDX;
  const cols = inverted ? [...IDX].reverse() : IDX;
  return (
    <div className="mv-grid" aria-hidden>
      {rows.map((y) => (
        <div className="mv-row" key={y}>
          {cols.map((x) => {
            const k = `${x},${y}`;
            const cls = x === 0 && y === 0 ? 'mv-cell origin' : set.has(k) ? `mv-cell dir-${direction}` : 'mv-cell';
            return <div key={k} className={cls} />;
          })}
        </div>
      ))}
    </div>
  );
}

export default memo(GameMoves);
