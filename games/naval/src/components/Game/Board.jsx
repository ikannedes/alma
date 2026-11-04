import React from 'react';
import { FormattedMessage } from 'react-intl';
import {
  canBePlaced,
  createEmptyBoard,
  indexToCoordinate,
  placeShipOnBoard,
} from '../../utils/boardTools.js';
import { randomPlacedShips } from '../../utils/computerTools';
import { FLEET } from '../../alma/naval';
import Grid from './Grid';
import Harbour from './Harbour';

const NO_POS = { row: null, col: null };

// Colocación de la flota del dueño (adaptado de Board.jsx del repo). Se quitó el turno del segundo jugador y se añadió:
// tocar para colocar, botón «Girar» (en el móvil no hay clic derecho), «Al azar» y «Quitar todo».
const Board = ({ onReady, busy }) => {
  const [placedShips, setPlacedShips] = React.useState([]);
  const [placingShip, setPlacingShip] = React.useState({ ...FLEET[0], position: NO_POS });
  const [direction, setDirection] = React.useState('HORIZONTAL');
  const avaliableShips = FLEET.filter((s) => !placedShips.some((p) => p.name === s.name));

  // barcos ya colocados
  let fixed = createEmptyBoard();
  placedShips.forEach((ship) => {
    fixed = placeShipOnBoard(fixed, ship);
  });
  // vista previa del que se está colocando (naranja si cabe, rojo si no)
  const board = placingShip ? placeShipOnBoard(fixed, { ...placingShip, direction }, true) : fixed;

  const select = (ship) => setPlacingShip({ ...ship, position: NO_POS });

  const hover = (index) => {
    if (!placingShip) return;
    const position = index == null ? NO_POS : indexToCoordinate(index);
    setPlacingShip((prev) => prev && { ...prev, position });
  };

  const place = (index) => {
    if (!placingShip) return;
    const position = indexToCoordinate(index);
    if (canBePlaced(fixed, placingShip.length, direction, position.row, position.col) === 'OK') {
      const ship = { ...placingShip, direction, position };
      const rest = avaliableShips.filter((s) => s.name !== ship.name);
      setPlacedShips((prev) => [...prev, ship]);
      setPlacingShip(rest.length ? { ...rest[0], position: NO_POS } : null);
    } else {
      setPlacingShip((prev) => ({ ...prev, position })); // se ve en rojo por qué no cabe
    }
  };

  const rotate = () => setDirection((d) => (d === 'HORIZONTAL' ? 'VERTICAL' : 'HORIZONTAL'));
  const random = () => {
    setPlacedShips(randomPlacedShips(FLEET));
    setPlacingShip(null);
  };
  const reset = () => {
    setPlacedShips([]);
    setPlacingShip({ ...FLEET[0], position: NO_POS });
  };

  const done = avaliableShips.length === 0;

  return (
    <section className='placing'>
      <h2 className='board-title board-title-p1'>
        <FormattedMessage id='placing.title' />
      </h2>
      <p className='tip small'>
        <FormattedMessage id='placing.tip' />
      </p>
      <div className='placing-body'>
        <Grid board={board} onCell={place} onHover={hover} onRightClick={rotate} className='board-p1' />
        <div className='placing-side'>
          {done ? null : (
            <Harbour avaliableShips={avaliableShips} placingShip={placingShip} onSelect={select} />
          )}
          <div className='actions'>
            {!done && (
              <button type='button' className='btn' onClick={rotate}>
                <FormattedMessage
                  id='placing.rotate'
                  values={{ dir: <FormattedMessage id={direction === 'HORIZONTAL' ? 'placing.horizontal' : 'placing.vertical'} /> }}
                />
              </button>
            )}
            <button type='button' className='btn' onClick={random}>
              <FormattedMessage id='placing.random' />
            </button>
            <button type='button' className='btn' onClick={reset} disabled={!placedShips.length}>
              <FormattedMessage id='placing.reset' />
            </button>
            {done && (
              <button type='button' className='btn btn-main' onClick={() => onReady(fixed)} disabled={busy}>
                <FormattedMessage id='placing.ready' />
              </button>
            )}
          </div>
        </div>
      </div>
    </section>
  );
};

export default Board;
