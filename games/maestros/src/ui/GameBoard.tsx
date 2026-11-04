// Pantalla de juego (adaptado de src/GameBoard/GameBoard.jsx y LocalGame.jsx del original).
// Selección como en el original: carta + pieza → se marcan los destinos → se toca el destino.
import { useEffect, useMemo, useState } from 'react';
import { canMove, toGrid } from '../engine/board';
import { cardMoves } from '../engine/cards';
import type { Card, GameSquare, Move, Point } from '../engine/models';
import { OWNER } from '../alma/protocol';
import type { Snapshot } from '../partida';
import type { Phase } from '../useMaestros';
import GameCard from './GameCard';
import GameGrid from './GameGrid';

/** Destinos válidos para la carta y pieza elegidas (getMoves del original; el dueño es rojo: sin girar). */
function destinations(src: Point | null, card: Card | null) {
  if (!src || !card) return () => false;
  const set = new Set(cardMoves(card).map(({ x, y }) => `${src.x + x},${src.y + y}`));
  return (x: number, y: number) => set.has(`${x},${y}`);
}

interface Props {
  snap: Snapshot;
  phase: Phase;
  onMove: (m: Move) => Promise<string | null>;
}

export default function GameBoard({ snap, phase, onMove }: Props) {
  const [card, setCard] = useState<Card | null>(null);
  const [src, setSrc] = useState<Point | null>(null);
  const [error, setError] = useState('');
  const { game, lastMove } = snap;
  const b = game.board;
  const myTurn = phase === 'dueno' && game.status === 'Playing' && b.turn === OWNER;
  const ownerCanMove = myTurn ? canMove(b) : true;

  // Al cambiar de posición se borra la selección.
  useEffect(() => { setCard(null); setSrc(null); setError(''); }, [snap]);

  const grid = useMemo(() => {
    const g = toGrid(b);
    // Al terminar por captura del maestro, se dibuja encima la pieza que capturó (el original dejaba el maestro azul).
    if (game.status === 'Finished' && lastMove) {
      const d = lastMove.dst;
      const winnerKing = game.winner === 'rojo' ? b.redKing : b.blueKing;
      const king = winnerKing.x === d.x && winnerKing.y === d.y;
      g[d.y][d.x] = (game.winner === 'rojo' ? (king ? 'RedKing' : 'RedPawn') : (king ? 'BlueKing' : 'BluePawn')) as GameSquare;
    }
    return g;
  }, [b, game, lastMove]);

  const isValid = destinations(myTurn ? src : null, myTurn ? card : null);

  const send = async (m: Move) => {
    const err = await onMove(m);
    setError(err ?? '');
  };

  const onSquare = (p: Point, tile: GameSquare) => {
    if (!myTurn) return;
    if (tile.startsWith('Red')) { setSrc(p); setError(''); return; }
    if (card && src && isValid(p.x, p.y)) void send({ type: 'Move', card, src, dst: p });
    else if (!card) setError('Elige primero una carta');
    else if (!src) setError('Elige una de tus piezas');
  };

  // La carta del lado se muestra junto a la mano de quien acaba de jugarla (como el original en móvil),
  // orientada para quien la recibirá: el jugador en turno.
  const spareWithAlma = b.turn === OWNER;
  const spare = <GameCard card={b.spareCard} spare inverted={!spareWithAlma} />;

  return (
    <div className="game">
      <div className="hand alma-hand">
        {b.blueHand.map((c) => <GameCard key={c} card={c} inverted />)}
        {spareWithAlma && spare}
      </div>
      <GameGrid grid={grid} src={myTurn ? src : null} isValid={isValid} lastMove={lastMove} onSquare={onSquare} />
      <div className="hand owner-hand">
        {b.redHand.map((c) => (
          <GameCard key={c} card={c} enabled={myTurn} selected={card === c} canMove={ownerCanMove}
            onPick={(k) => { setCard(k); setError(''); }}
            onDiscard={(k) => void send({ type: 'Discard', card: k })} />
        ))}
        {!spareWithAlma && spare}
      </div>
      {myTurn && !ownerCanMove && <p className="hint warn">No tienes ningún movimiento: toca una carta para pasarla.</p>}
      {myTurn && ownerCanMove && !error && (
        <p className="hint">{!card ? 'Elige una carta' : !src ? 'Elige una pieza' : 'Toca un destino marcado'}</p>
      )}
      {error && <p className="hint warn">{error}</p>}
    </div>
  );
}
