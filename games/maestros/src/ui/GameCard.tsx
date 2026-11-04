// Carta de movimiento (adaptado de src/GameBoard/GameCard.jsx del original).
import { CARDS, cardMoves } from '../engine/cards';
import type { Card } from '../engine/models';
import { cardWords } from '../alma/protocol';
import GameMoves from './GameMoves';

interface Props {
  card: Card;
  enabled?: boolean;
  selected?: boolean;
  inverted?: boolean; // girada 180° (cartas de Alma)
  canMove?: boolean;
  spare?: boolean; // carta del lado
  onPick?: (c: Card) => void;
  onDiscard?: (c: Card) => void;
}

export default function GameCard({ card, enabled = false, selected = false, inverted = false, canMove = true, spare = false, onPick, onDiscard }: Props) {
  const info = CARDS[card];
  const click = () => {
    if (!enabled) return;
    if (!canMove) onDiscard?.(card);
    else onPick?.(card);
  };
  const cls = ['card', enabled ? 'enabled' : '', selected ? 'selected' : '', spare ? 'spare' : '',
    enabled && !canMove ? 'no-moves' : ''].join(' ');
  return (
    <button type="button" className={cls} onClick={click} disabled={!enabled}
      title={`${info.nombre}: ${cardWords(card)}`} aria-pressed={selected}>
      <span className="card-name">
        <i className={`stamp stamp-${info.sello}`} title={`Sello ${info.sello}`} />
        {info.nombre}
      </span>
      <GameMoves moves={cardMoves(card)} direction={info.direction} inverted={inverted} />
      {enabled && !canMove && <span className="card-note warn">Pasar</span>}
      {spare && <span className="card-note">al lado</span>}
    </button>
  );
}
