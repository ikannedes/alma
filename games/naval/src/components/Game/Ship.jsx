// Dibujo del barco en el puerto: una fila de casillas del color de su tipo (del repo, con color por barco).
const Ship = ({ length, name }) => (
  <span className='harbour-ship'>
    {[...new Array(length)].map((_, index) => (
      <span key={index} className={`ship-unit ${name}`} />
    ))}
  </span>
);

export default Ship;
