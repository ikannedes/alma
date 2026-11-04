import { FormattedMessage } from 'react-intl';
import { showAttack } from '../../utils/boardTools.js';
import Grid from './Grid';

// Tu flota: tus barcos con los disparos de Alma encima (el último, resaltado).
const FleetBoard = ({ board, attack, highlight }) => (
  <div className='board-container'>
    <h2 className='board-title board-title-p1'>
      <FormattedMessage id='board.mine' />
    </h2>
    <Grid board={showAttack(board, attack)} disabled className='board-p1' highlight={highlight} />
  </div>
);

export default FleetBoard;
