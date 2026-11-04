import * as BLOCK_STATE from '../../utils/blockStates';
import { FormattedMessage } from 'react-intl';

// Estadísticas de un bando (adaptado de DataCard.jsx del repo; sin MUI).
const DataCard = ({ name, attack }) => {
  const shots = attack.slice(1);
  const numberOfAttack = shots.length;
  const numberOfMiss = shots.filter((item) => item.state === BLOCK_STATE.MISS).length;
  const numberOfHit = numberOfAttack - numberOfMiss;
  const hitRate = numberOfAttack ? ((numberOfHit / numberOfAttack) * 100).toFixed(0) : '0';

  return (
    <div className='data-card'>
      <h3 className='data-player'>{name}</h3>
      <p><FormattedMessage id='over.numberOfAttack' />{numberOfAttack}</p>
      <p><FormattedMessage id='over.numberOfHit' />{numberOfHit}</p>
      <p><FormattedMessage id='over.numberOfMiss' />{numberOfMiss}</p>
      <p><FormattedMessage id='over.hitRate' />{hitRate} %</p>
    </div>
  );
};

export default DataCard;
