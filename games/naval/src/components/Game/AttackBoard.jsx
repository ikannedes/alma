import React from 'react';
import { FormattedMessage } from 'react-intl';
import {
  createEmptyBoard,
  indexToCoordinate,
  showAttack,
  showSelectiongBlock,
} from '../../utils/boardTools.js';
import Grid from './Grid';

// Aguas de Alma: donde dispara el dueño (adaptado de AttackBoard.jsx del repo). El turno del ordenador que había aquí
// (randomAttack / attackPotentialTarget) se quitó: los disparos de Alma llegan de Haiku por el puente (Game.jsx).
const AttackBoard = ({ attack, onShoot, disabled, highlight }) => {
  const [hover, setHover] = React.useState(null);

  // tablero vacío + casilla apuntada + disparos hechos (como en el repo)
  let board = createEmptyBoard();
  if (!disabled && hover != null) board = showSelectiongBlock(board, indexToCoordinate(hover));
  board = showAttack(board, attack);

  return (
    <div className='board-container'>
      <h2 className='board-title board-title-p2'>
        <FormattedMessage id='board.alma' />
      </h2>
      <Grid board={board} onCell={onShoot} onHover={setHover} disabled={disabled} className='board-p2' highlight={highlight} />
    </div>
  );
};

export default AttackBoard;
