import { Fragment } from 'react';
import { ROW_LETTERS } from '../../alma/naval';

// Tablero 8×8 con coordenadas (filas A–H, columnas 1–8), el mismo sistema que usan las ids de Alma.
// Cada casilla es un botón: funciona con dedo y con ratón.
const Grid = ({ board, onCell, onHover, onRightClick, disabled = false, className = '', small = false, highlight = null }) => (
  <div
    className={`grid ${small ? 'grid-small' : ''} ${disabled ? 'disabled' : ''} ${className}`}
    onContextMenu={(e) => e.preventDefault()}
    onMouseLeave={onHover ? () => onHover(null) : undefined}
  >
    <span className='lbl' />
    {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => (
      <span className='lbl' key={n}>{n}</span>
    ))}
    {ROW_LETTERS.split('').map((letter, row) => (
      <Fragment key={letter}>
        <span className='lbl'>{letter}</span>
        {board.slice(row * 8, row * 8 + 8).map((state, col) => {
          const index = row * 8 + col;
          return (
            <button
              type='button'
              key={index}
              className={`block ${state}${index === highlight ? ' last' : ''}`}
              aria-label={`${letter}${col + 1}`}
              tabIndex={onCell && !disabled ? 0 : -1}
              onMouseEnter={onHover && !disabled ? () => onHover(index) : undefined}
              onClick={onCell && !disabled ? () => onCell(index) : undefined}
              onMouseDown={onRightClick && !disabled ? (e) => e.button === 2 && onRightClick(index) : undefined}
            />
          );
        })}
      </Fragment>
    ))}
  </div>
);

export default Grid;
