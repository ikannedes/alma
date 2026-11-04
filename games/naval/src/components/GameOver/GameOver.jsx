import { FormattedMessage, useIntl } from 'react-intl';
import * as GAME_STATE from '../../utils/gameState';
import MiniBoard from './MiniBoard';
import DataCard from './DataCard';

// Fin de la partida (adaptado de GameOver.jsx del repo): ganador, estadísticas y las dos flotas destapadas.
const GameOver = ({ gameState, ownerBoard, almaBoard, ownerAttack, almaAttack, onAgain, busy }) => {
  const intl = useIntl();
  const ownerWins = gameState === GAME_STATE.P1WIN;
  return (
    <section className='over'>
      <h1 className='over-title'>
        <FormattedMessage id='over.title' />
      </h1>
      <h2 className={`over-winner ${ownerWins ? 'win' : 'lose'}`}>
        <FormattedMessage id={ownerWins ? 'over.ownerWins' : 'over.almaWins'} />
      </h2>
      <button type='button' className='btn btn-main' onClick={onAgain} disabled={busy}>
        <FormattedMessage id='over.again' />
      </button>
      <div className='over-show'>
        <div className='show-side'>
          <DataCard name={intl.formatMessage({ id: 'who.owner' })} attack={ownerAttack} />
          <MiniBoard finalBoard={ownerBoard} attack={almaAttack} title={intl.formatMessage({ id: 'over.ownerBoard' })} player='p1' />
        </div>
        <div className='show-side'>
          <DataCard name={intl.formatMessage({ id: 'who.alma' })} attack={almaAttack} />
          <MiniBoard finalBoard={almaBoard} attack={ownerAttack} title={intl.formatMessage({ id: 'over.almaBoard' })} player='p2' />
        </div>
      </div>
    </section>
  );
};

export default GameOver;
