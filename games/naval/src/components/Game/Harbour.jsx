import Ship from './Ship';

// Puerto: barcos que quedan por colocar (adaptado de Harbour.jsx del repo; nombres en español).
const Harbour = ({ avaliableShips, placingShip, onSelect }) => (
  <div className='harbour'>
    {avaliableShips.map((ship) => (
      <button
        type='button'
        key={ship.name}
        className={`ship-container ${placingShip?.name === ship.name ? 'ship-selected' : ''}`}
        onClick={() => onSelect(ship)}
      >
        <span className='ship-name'>{ship.es}</span>
        <Ship length={ship.length} name={ship.name} />
      </button>
    ))}
  </div>
);

export default Harbour;
