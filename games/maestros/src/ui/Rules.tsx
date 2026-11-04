// Reglas en castellano (adaptadas del texto de src/Rules/Rules.jsx del original).
export default function Rules({ onClose }: { onClose: () => void }) {
  return (
    <div className="rules" role="dialog" aria-label="Reglas">
      <div className="rules-box">
        <button type="button" className="close" onClick={onClose} aria-label="Cerrar">×</button>
        <h2>Cómo se juega a Maestros</h2>
        <p>Tablero de 5×5. Cada bando tiene <b>1 maestro</b> y <b>4 alumnos</b>. Tú eres el <b className="t-rojo">rojo</b> (abajo) y Alma el <b className="t-azul">azul</b> (arriba).</p>
        <p>Se usan 5 cartas al azar de 16: dos para cada uno y una <b>al lado</b>. Empieza el color del sello (el puntito) de la carta del lado.</p>
        <h3>Tu turno</h3>
        <p>Elige una de tus dos cartas y una de tus piezas, y muévela a una de las casillas que marca la carta (el cuadrado claro es la pieza; los de color, a dónde puede ir). Las cartas de Alma se ven giradas porque ella las usa desde su lado.</p>
        <p>No puedes ir a una casilla con pieza tuya. Si vas a una con pieza de Alma, la <b>capturas</b>.</p>
        <p>La carta usada se queda al lado y tú te llevas la que estaba al lado. Así las cartas van pasando de un jugador a otro.</p>
        <p>Si no tienes ningún movimiento posible, <b>pasas</b>: cedes una de tus cartas sin mover.</p>
        <h3>Cómo se gana</h3>
        <ul>
          <li><b>Camino de la piedra:</b> capturar el maestro rival.</li>
          <li><b>Camino del arroyo:</b> llevar tu maestro al templo rival (la casilla de salida de su maestro, c5).</li>
        </ul>
        <p>Las coordenadas (a–e, 1–5) son las mismas que usa el historial y las que ve Alma.</p>
      </div>
    </div>
  );
}
