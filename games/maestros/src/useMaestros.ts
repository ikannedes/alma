// Flujo de la partida contra Alma (partida LENTA/asíncrona, PLAN-JUEGOS):
//  · el dueño mueve → move({snapshot: estado ANTES de la jugada de Alma, async:true}) → {pending:true}
//  · mientras la página esté abierta, waitPending(); al llegar: aplicar el id, seen(), save(estado después)
//  · al cargar: start(false) retoma; se restaura el snapshot; si hay pendiente sin ver se aplica; si le toca a Alma, se espera
// El motor es el árbitro. Nunca hay bot sustituto: si Alma no contesta, la partida espera con "Reintentar".
import { useCallback, useEffect, useRef, useState } from 'react';
import { alma, type AlmaBridge, type AlmaMatch, type AlmaPending } from './alma/bridge';
import { ALMA, OWNER, almaLegal, findLegal, stateText } from './alma/protocol';
import type { Move } from './engine/models';
import { freshSnapshot, isSnapshot, play, recent, type Snapshot } from './partida';

export type Phase = 'cargando' | 'dueno' | 'alma' | 'fin' | 'rechazada' | 'sin-conexion';

export function useMaestros() {
  const [snap, setSnapState] = useState<Snapshot | null>(null);
  const [phase, setPhase] = useState<Phase>('cargando');
  const [message, setMessage] = useState('');
  const snapRef = useRef<Snapshot | null>(null);
  const gen = useRef(0); // cambia con cada partida nueva: descarta respuestas de partidas viejas
  const bridgeRef = useRef<AlmaBridge | null>(null);

  const setSnap = (s: Snapshot) => { snapRef.current = s; setSnapState(s); };
  const live = (g: number) => g === gen.current;

  const safe = async (f: () => Promise<unknown>) => { try { return await f(); } catch { return null; } };

  // ---- Turno de Alma ----
  const applyAlma = useCallback(async (a: AlmaBridge, p: { id: string; reaccion?: string }, s: Snapshot, g: number) => {
    if (!live(g)) return;
    const m = s.game.status === 'Playing' ? findLegal(s.game.board, p.id) : null;
    if (!m) {
      // No debería pasar (el relay solo acepta ids de la lista), pero el árbitro es el juego.
      a.notice('Alma ha mandado una jugada que no vale en esta posición.', {
        label: 'Pedirle otra', run: () => void askAlma(a, s, true, g),
      });
      return;
    }
    const r = play(s, m);
    if (!r.ok) return;
    setSnap(r.next);
    await safe(() => a.seen());
    await safe(() => a.save(r.next));
    if (r.next.game.status === 'Finished') {
      setPhase('fin');
      await safe(() => a.event('gana_alma', { reaccion: p.reaccion, history: r.next.log }));
      return;
    }
    if (r.captura) await safe(() => a.event('buena_jugada', { reaccion: p.reaccion, history: recent(r.next.log) }));
    setPhase('dueno');
    setMessage('');
  }, []);

  const waitAlma = useCallback(async (a: AlmaBridge, s: Snapshot, g: number) => {
    if (!live(g)) return;
    setPhase('alma');
    setMessage('Alma lo está pensando. Puedes cerrar la página: su jugada te esperará aquí.');
    let p: AlmaPending | null = null;
    try { p = await a.waitPending(); } catch { p = null; }
    if (!live(g)) return;
    if (p) return applyAlma(a, p, s, g);
    // Sin jugada: o está en pausa, o se acabó el tiempo de espera, o falló la red.
    const l = await safe(() => a.load()) as { match: AlmaMatch | null; paused_text?: string } | null;
    if (!live(g)) return;
    const pend = l?.match?.pending;
    if (pend && !pend.seen) return applyAlma(a, pend, s, g);
    if (l?.paused_text) {
      a.notice(l.paused_text, { label: 'Reintentar', run: () => { void safe(() => a.resume()).then(() => waitAlma(a, s, g)); } });
    } else {
      a.notice('Alma todavía no ha jugado.', { label: 'Seguir esperando', run: () => void waitAlma(a, s, g) });
    }
  }, [applyAlma]);

  const askAlma = useCallback(async (a: AlmaBridge, s: Snapshot, ownerMoved: boolean, g: number): Promise<void> => {
    if (!live(g) || s.game.status !== 'Playing' || s.game.board.turn !== ALMA) return;
    setPhase('alma');
    setMessage('Esperando a Alma…');
    const b = s.game.board;
    const legal = almaLegal(b).map(({ id, label }) => ({ id, label }));
    try {
      const r = await a.move({
        state: stateText(b), legal, history: recent(s.log), snapshot: s, ownerMoved, async: true,
        onRetry: () => void askAlma(a, s, ownerMoved, g),
      });
      if (!live(g)) return;
      if (r.move) return applyAlma(a, r.move, s, g);
      if (r.pending || r.late) return waitAlma(a, s, g);
      if (r.paused) { setMessage('Alma está en pausa.'); return; } // el puente ya muestra "Reintentar"
      return waitAlma(a, s, g);
    } catch {
      if (!live(g)) return;
      setMessage('No hay conexión con Alma.');
      a.notice('No he podido hablar con Alma.', { label: 'Reintentar', run: () => void askAlma(a, s, ownerMoved, g) });
    }
  }, [applyAlma, waitAlma]);

  // ---- Arranque / partida nueva ----
  const adopt = useCallback(async (a: AlmaBridge, match: AlmaMatch | undefined | null, g: number) => {
    let s = isSnapshot(match?.snapshot) ? match!.snapshot as Snapshot : null;
    if (!s) {
      s = freshSnapshot();
      setSnap(s);
      await safe(() => a.save(s));
    } else setSnap(s);
    if (s.game.status === 'Finished') { setPhase('fin'); return; }
    const p = match?.pending;
    if (s.game.board.turn === ALMA) {
      if (p && !p.seen) return applyAlma(a, p, s, g);
      if (match?.turn === 'alma') return waitAlma(a, s, g);
      return askAlma(a, s, s.log.length > 1, g); // el relay no sabe que le toca: se le pide
    }
    if (p && !p.seen) await safe(() => a.seen()); // ya aplicada en el snapshot guardado
    setPhase('dueno');
    setMessage('');
  }, [applyAlma, waitAlma, askAlma]);

  const boot = useCallback(async (fresh: boolean) => {
    const g = ++gen.current;
    setPhase('cargando');
    setMessage(fresh ? 'Preparando una partida nueva…' : 'Cargando…');
    let a: AlmaBridge;
    try {
      a = await alma();
      bridgeRef.current = a;
    } catch {
      setPhase('sin-conexion');
      setMessage('No se ha podido cargar el puente con Alma. Sin Alma no hay rival: vuelve a intentarlo.');
      return;
    }
    try {
      const r = await a.start(fresh);
      if (!live(g)) return;
      if (!r.ok) { setPhase('rechazada'); setMessage(r.refused || 'Alma no quiere jugar ahora mismo.'); return; }
      if (fresh) {
        // Partida nueva: siempre tablero nuevo, aunque el relay devolviera algo.
        const s = freshSnapshot();
        setSnap(s);
        await safe(() => a.save(s));
        if (s.game.status === 'Playing' && s.game.board.turn === ALMA) return askAlma(a, s, false, g);
        setPhase('dueno');
        setMessage('');
        return;
      }
      await adopt(a, r.match, g);
    } catch {
      if (!live(g)) return;
      setPhase('sin-conexion');
      setMessage('No hay conexión con Alma.');
    }
  }, [adopt, askAlma]);

  useEffect(() => { void boot(false); }, [boot]);

  // ---- Jugada del dueño ----
  const ownerPlay = useCallback(async (m: Move): Promise<string | null> => {
    const s = snapRef.current;
    const a = bridgeRef.current;
    if (!s || !a || phase !== 'dueno' || s.game.status !== 'Playing' || s.game.board.turn !== OWNER) {
      return 'Ahora no es tu turno';
    }
    const r = play(s, m);
    if (!r.ok) return r.error;
    const g = gen.current;
    setSnap(r.next);
    if (r.next.game.status === 'Finished') {
      setPhase('fin');
      await safe(() => a.save(r.next));
      await safe(() => a.event('pierde_alma', { history: r.next.log }));
      return null;
    }
    setPhase('alma');
    if (r.captura) await safe(() => a.event('mala_jugada', { history: recent(r.next.log) }));
    void askAlma(a, r.next, true, g);
    return null;
  }, [phase, askAlma]);

  const newGame = useCallback(() => boot(true), [boot]);
  const retry = useCallback(() => boot(false), [boot]);

  return { snap, phase, message, ownerPlay, newGame, retry };
}
