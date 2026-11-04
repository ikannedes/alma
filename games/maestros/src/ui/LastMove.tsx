// Flecha de la última jugada (adaptado de src/GameBoard/LastMove.jsx). Coordenadas en una caja 320×320.
import type { Point } from '../engine/models';

export default function LastMove({ lastMove }: { lastMove: { src: Point; dst: Point } | null }) {
  if (!lastMove) return null;
  const { src, dst } = lastMove;
  const dx = dst.x - src.x;
  const dy = dst.y - src.y;
  const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
  const len = 64 * Math.sqrt(dx * dx + dy * dy);
  const pts = [[0, 0], [len - 24, -3], [len - 24, -12], [len - 12, 0], [len - 24, 12], [len - 24, 3]]
    .map((p) => p.join(',')).join(' ');
  return (
    <svg className="last-move" viewBox="0 0 320 320" aria-hidden>
      <g transform={`translate(${src.x * 64 + 32} ${src.y * 64 + 32}) rotate(${angle})`}>
        <polygon points={pts} stroke="rgba(120, 255, 120, 0.55)" fill="rgba(120,255,120,0.12)" strokeWidth="3" />
      </g>
    </svg>
  );
}
