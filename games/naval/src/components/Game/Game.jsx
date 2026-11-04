import React from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import * as GAME_STATE from '../../utils/gameState';
import { indexToCoordinate, coordinateToIndex } from '../../utils/boardTools.js';
import { computerPlacingShip } from '../../utils/computerTools';
import {
  FLEET,
  allSunk,
  applyShot,
  cellId,
  historyText,
  legalShots,
  newAttack,
  parseCellId,
  stateText,
} from '../../alma/naval';
import { alma, almaEvent } from '../../alma/almaPlayer';
import Welcome from '../Welcome/Welcome';
import Board from './Board';
import AttackBoard from './AttackBoard';
import FleetBoard from './FleetBoard';
import Tip from './Tip';
import GameOver from '../GameOver/GameOver';

const fresh = () => ({
  phase: GAME_STATE.WELCOME,
  ownerBoard: null, // flota del dueño (oculta para Alma)
  almaBoard: null, // flota de Alma (oculta para el dueño)
  ownerAttack: newAttack(), // disparos del dueño sobre la flota de Alma
  almaAttack: newAttack(), // disparos de Alma sobre la flota del dueño
  log: [], // [{by, id, result, sunk}]
  last: null,
});

const lastIndex = (log, by) => {
  for (let i = log.length - 1; i >= 0; i--) {
    if (log[i].by === by) {
      const p = parseCellId(log[i].id);
      return coordinateToIndex(p.row, p.col);
    }
  }
  return null;
};

// La partida: dueño contra Alma (sustituye a Game.jsx del repo). Los disparos de Alma los elige Haiku por el puente;
// el juego (boardTools del repo) es el árbitro. Sin red, Alma no juega: el turno espera con «Reintentar».
const Game = () => {
  const intl = useIntl();
  const [s, setS] = React.useState(fresh);
  const sRef = React.useRef(s); // estado al día para las funciones asíncronas
  const [busy, setBusy] = React.useState(false);
  const busyRef = React.useRef(false);
  const [aviso, setAviso] = React.useState(null); // {text, retry} cuando ni siquiera carga el puente

  const update = (patch) => {
    sRef.current = { ...sRef.current, ...patch };
    setS(sRef.current);
  };
  const lock = (on) => {
    busyRef.current = on;
    setBusy(on);
  };
  const noAlma = (e, retry) =>
    setAviso({ text: intl.formatMessage({ id: 'error.noAlma' }, { msg: e?.message || 'sin red' }), retry });

  // Partida nueva: start(true) en el relay; si Alma la rechaza, el puente muestra el motivo.
  const newGame = async () => {
    if (busyRef.current) return;
    lock(true);
    setAviso(null);
    try {
      const b = await alma();
      const r = await b.start(true);
      if (!r?.ok) return;
      // Colocar no es una jugada: la flota de Alma se coloca al azar con la función del repo.
      update({ ...fresh(), n: (sRef.current.n || 0) + 1, phase: GAME_STATE.P1PLACING, almaBoard: computerPlacingShip(FLEET) });
    } catch (e) {
      noAlma(e, newGame);
    } finally {
      lock(false);
    }
  };

  const startBattle = (board) => update({ ownerBoard: board, phase: GAME_STATE.P1ATTACK });

  // Turno de Alma: le pasamos lo que ve y la lista de casillas legales; ella elige una id; el árbitro la aplica.
  const runAlmaTurn = async () => {
    if (busyRef.current) return;
    lock(true);
    setAviso(null);
    let b = null;
    const retry = { label: intl.formatMessage({ id: 'error.retry' }), run: () => runAlmaTurn() };
    try {
      b = await alma();
      const st = sRef.current;
      if (st.phase !== GAME_STATE.COMPUTER_ATTACK) return;
      const r = await b.move({
        state: stateText(st.almaAttack, st.ownerAttack),
        legal: legalShots(st.almaAttack),
        history: historyText(st.log),
        ownerMoved: true,
        async: false,
        onRetry: () => runAlmaTurn(),
      });
      if (r?.paused) return; // el puente ya muestra el aviso con «Reintentar»
      if (!r?.move) {
        b.notice('Alma no ha contestado.', retry);
        return;
      }
      const cur = sRef.current;
      const pos = parseCellId(r.move.id);
      const res = pos && cur.phase === GAME_STATE.COMPUTER_ATTACK
        ? applyShot(cur.almaAttack, cur.ownerBoard, pos.row, pos.col)
        : null;
      if (!res) {
        // nunca se juega por ella: si la id no vale, se vuelve a preguntar
        b.notice(`Alma eligió una casilla que no vale (${r.move.id}).`, retry);
        return;
      }
      const entry = { by: 'alma', id: cellId(pos.row, pos.col), result: res.result, sunk: res.sunk };
      const log = [...cur.log, entry];
      if (allSunk(res.attack)) {
        update({ almaAttack: res.attack, log, last: entry, phase: GAME_STATE.COMPUTER_WIN });
        almaEvent('gana_alma', { history: historyText(log) });
      } else {
        update({ almaAttack: res.attack, log, last: entry, phase: GAME_STATE.P1ATTACK });
        if (res.sunk) almaEvent('buena_jugada', { history: historyText(log) });
      }
    } catch (e) {
      if (b) b.notice(`Sin red, Alma no juega (${e?.message || 'error'}).`, retry);
      else noAlma(e, runAlmaTurn);
    } finally {
      lock(false);
    }
  };

  // Disparo del dueño sobre las aguas de Alma.
  const ownerShoot = async (index) => {
    const st = sRef.current;
    if (st.phase !== GAME_STATE.P1ATTACK || busyRef.current) return;
    const { row, col } = indexToCoordinate(index);
    const res = applyShot(st.ownerAttack, st.almaBoard, row, col);
    if (!res) return; // ya disparado ahí
    const entry = { by: 'dueno', id: cellId(row, col), result: res.result, sunk: res.sunk };
    const log = [...st.log, entry];
    if (allSunk(res.attack)) {
      update({ ownerAttack: res.attack, log, last: entry, phase: GAME_STATE.P1WIN });
      almaEvent('pierde_alma', { history: historyText(log) });
      return;
    }
    update({ ownerAttack: res.attack, log, last: entry, phase: GAME_STATE.COMPUTER_ATTACK });
    if (res.sunk) await almaEvent('mala_jugada', { history: historyText(log) });
    runAlmaTurn();
  };

  const { phase } = s;
  const gameOver = phase === GAME_STATE.P1WIN || phase === GAME_STATE.COMPUTER_WIN;
  const inBattle = phase === GAME_STATE.P1ATTACK || phase === GAME_STATE.COMPUTER_ATTACK;

  return (
    <div className='game'>
      {aviso && (
        <div className='aviso'>
          {aviso.text}{' '}
          <button type='button' className='btn' onClick={() => aviso.retry()}>
            <FormattedMessage id='error.retry' />
          </button>
        </div>
      )}

      {phase === GAME_STATE.WELCOME && <Welcome onStart={newGame} busy={busy} />}

      {phase === GAME_STATE.P1PLACING && <Board key={s.n} onReady={startBattle} busy={busy} />}

      {inBattle && (
        <>
          <Tip gameState={phase} last={s.last} />
          <main className='game-area'>
            <AttackBoard
              attack={s.ownerAttack}
              onShoot={ownerShoot}
              disabled={phase !== GAME_STATE.P1ATTACK || busy}
              highlight={lastIndex(s.log, 'dueno')}
            />
            <FleetBoard board={s.ownerBoard} attack={s.almaAttack} highlight={lastIndex(s.log, 'alma')} />
          </main>
        </>
      )}

      {gameOver && (
        <GameOver
          gameState={phase}
          ownerBoard={s.ownerBoard}
          almaBoard={s.almaBoard}
          ownerAttack={s.ownerAttack}
          almaAttack={s.almaAttack}
          onAgain={newGame}
          busy={busy}
        />
      )}

      {(inBattle || phase === GAME_STATE.P1PLACING) && (
        <p className='new-game'>
          <button type='button' className='btn btn-ghost' onClick={newGame} disabled={busy}>
            <FormattedMessage id='game.new' />
          </button>
        </p>
      )}
    </div>
  );
};

export default Game;
