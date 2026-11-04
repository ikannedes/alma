// Tablero 5×5 con coordenadas a–e / 1–5 (adaptado de GameGrid.jsx y GameSquare.jsx del original).
// El dueño (rojo) siempre abajo. Las piezas son SVG propios (el original usaba iconos de Font Awesome).
import type { GameSquare as Tile, Point } from '../engine/models';
import LastMove from './LastMove';

function Piece({ tile }: { tile: Tile }) {
  if (tile === 'Empty') return null;
  const color = tile.startsWith('Red') ? 'var(--rojo)' : 'var(--azul)';
  const king = tile.endsWith('King');
  return (
    <svg viewBox="0 0 40 40" className="piece" aria-hidden>
      {king ? (
        <>
          <path d="M8 30 L6 13 L14 20 L20 8 L26 20 L34 13 L32 30 Z" fill={color} stroke="#0008" strokeWidth="1.5" />
          <rect x="8" y="30" width="24" height="5" rx="2" fill={color} stroke="#0008" strokeWidth="1.5" />
        </>
      ) : (
        <>
          <circle cx="20" cy="14" r="7" fill={color} stroke="#0008" strokeWidth="1.5" />
          <path d="M11 34 Q20 14 29 34 Z" fill={color} stroke="#0008" strokeWidth="1.5" />
        </>
      )}
    </svg>
  );
}

const NAMES: Record<Tile, string> = {
  Empty: 'vacía', RedKing: 'tu maestro', RedPawn: 'tu alumno', BlueKing: 'maestro de Alma', BluePawn: 'alumno de Alma',
};

interface Props {
  grid: Tile[][];
  src: Point | null;
  isValid: (x: number, y: number) => boolean;
  lastMove: { src: Point; dst: Point } | null;
  onSquare: (p: Point, tile: Tile) => void;
}

export default function GameGrid({ grid, src, isValid, lastMove, onSquare }: Props) {
  return (
    <div className="board-wrap">
      <div className="board">
        {grid.map((row, y) => (
          <div className="board-row" key={y}>
            <span className="rank">{5 - y}</span>
            {row.map((tile, x) => {
              const sel = src?.x === x && src?.y === y;
              const valid = isValid(x, y);
              const last = (lastMove?.src.x === x && lastMove?.src.y === y) || (lastMove?.dst.x === x && lastMove?.dst.y === y);
              const temple = x === 2 && (y === 0 || y === 4) ? (y === 4 ? ' temple-rojo' : ' temple-azul') : '';
              return (
                <button type="button" key={x}
                  className={`sq${sel ? ' sel' : ''}${valid ? ' valid' : ''}${last ? ' last' : ''}${temple}`}
                  aria-label={`${'abcde'[x]}${5 - y}: ${NAMES[tile]}${valid ? ', destino posible' : ''}`}
                  onClick={() => onSquare({ x, y }, tile)}>
                  <Piece tile={tile} />
                </button>
              );
            })}
          </div>
        ))}
        <div className="board-row files">
          <span className="rank" />
          {'abcde'.split('').map((f) => <span key={f} className="file">{f}</span>)}
        </div>
        <div className="board-overlay"><LastMove lastMove={lastMove} /></div>
      </div>
    </div>
  );
}
