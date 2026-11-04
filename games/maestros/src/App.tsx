// Maestros contra Alma: cabecera de estado, tablero, historial y botones.
import { useState } from 'react';
import { ALMA, winnerOf } from './alma/protocol';
import GameBoard from './ui/GameBoard';
import Rules from './ui/Rules';
import { useMaestros } from './useMaestros';

export default function App() {
  const { snap, phase, message, ownerPlay, newGame, retry } = useMaestros();
  const [rules, setRules] = useState(false);
  const [showLog, setShowLog] = useState(false);

  const winner = snap ? winnerOf(snap.game) : null;
  let title = 'Maestros';
  if (phase === 'cargando') title = 'Cargando…';
  else if (winner === 'dueno') title = '¡Has ganado!';
  else if (winner === 'alma') title = 'Gana Alma';
  else if (phase === 'dueno') title = 'Tu turno';
  else if (phase === 'alma' || snap?.game.board.turn === ALMA) title = 'Turno de Alma';

  const confirmNew = () => {
    if (snap && snap.game.status === 'Playing' && snap.log.length > 1 &&
      !window.confirm('¿Abandonar esta partida y empezar otra?')) return;
    void newGame();
  };

  return (
    <main className="app">
      <header className="top">
        <h1 className={winner ? `t-${winner === 'alma' ? 'azul' : 'rojo'}` : phase === 'dueno' ? 't-rojo' : 't-azul'}>{title}</h1>
        <div className="actions">
          <button type="button" onClick={() => setRules(true)}>Reglas</button>
          <button type="button" onClick={() => setShowLog((v) => !v)} disabled={!snap}>Historial</button>
          <button type="button" onClick={confirmNew} disabled={phase === 'cargando'}>Nueva</button>
        </div>
      </header>

      {message && <p className="msg">{message}</p>}
      {(phase === 'sin-conexion' || phase === 'rechazada') && (
        <p className="msg"><button type="button" onClick={() => void retry()}>Reintentar</button></p>
      )}

      {snap && <GameBoard snap={snap} phase={phase} onMove={ownerPlay} />}

      {winner && (
        <div className="end">
          <p>{winner === 'dueno' ? 'Has vencido a Alma.' : 'Alma te ha ganado esta vez.'}</p>
          <button type="button" className="primary" onClick={() => void newGame()}>Revancha</button>
        </div>
      )}

      {showLog && snap && (
        <section className="log" aria-label="Historial">
          <h2>Historial</h2>
          <ol>{snap.log.map((l, i) => <li key={i}>{l}</li>)}</ol>
        </section>
      )}

      {rules && <Rules onClose={() => setRules(false)} />}
    </main>
  );
}
