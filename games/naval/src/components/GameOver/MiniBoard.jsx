import { showAttack } from '../../utils/boardTools.js';
import Grid from '../Game/Grid';

// Tablero final destapado con los disparos recibidos (adaptado de MiniBoard.jsx del repo).
const MiniBoard = ({ finalBoard, attack, title, player }) => (
  <div className='mini-board-container'>
    <h3 className='mini-name'>{title}</h3>
    <Grid board={showAttack(finalBoard, attack)} disabled small className={player === 'p1' ? 'board-p1' : 'board-p2'} />
  </div>
);

export default MiniBoard;
