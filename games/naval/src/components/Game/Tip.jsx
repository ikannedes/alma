import { FormattedMessage } from 'react-intl';
import * as GAME_STATE from '../../utils/gameState';

// Aviso de turno y último disparo (adaptado de Tip.jsx del repo).
const Tip = ({ gameState, last }) => (
  <div className='tip'>
    {last && (
      <p className={`tip-last ${last.result}`}>
        <FormattedMessage
          id='tip.last'
          values={{
            who: <FormattedMessage id={last.by === 'alma' ? 'who.alma' : 'who.owner'} />,
            id: <b>{last.id}</b>,
            result: <FormattedMessage id={`result.${last.result}`} />,
          }}
        />
      </p>
    )}
    <p>
      {gameState === GAME_STATE.P1ATTACK && <FormattedMessage id='tip.p1Attack' />}
      {gameState === GAME_STATE.COMPUTER_ATTACK && <FormattedMessage id='tip.almaAttack' />}
    </p>
  </div>
);

export default Tip;
