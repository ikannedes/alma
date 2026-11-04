// @vitest-environment jsdom
// Flujo lento/asíncrono contra un puente falso: retomar, jugada pendiente, seen()+save(), eventos y turno de Alma.
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { newFromCards } from '../src/engine/board';
import { pt } from '../src/engine/models';
import type { Snapshot } from '../src/partida';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const calls: { name: string; args: unknown[] }[] = [];
let match: Record<string, unknown> | null = null;
let pendingQueue: unknown[] = [];
const fake = {
  get match() { return match; },
  start: vi.fn(async (fresh: boolean) => { calls.push({ name: 'start', args: [fresh] }); return { ok: true, match }; }),
  load: vi.fn(async () => ({ match })),
  move: vi.fn(async (req: unknown) => { calls.push({ name: 'move', args: [req] }); return { pending: true }; }),
  waitPending: vi.fn(async () => { calls.push({ name: 'waitPending', args: [] }); return pendingQueue.shift() ?? null; }),
  resume: vi.fn(async () => ({})),
  seen: vi.fn(async () => { calls.push({ name: 'seen', args: [] }); }),
  save: vi.fn(async (s: unknown) => { calls.push({ name: 'save', args: [s] }); }),
  event: vi.fn(async (t: string, x: unknown) => { calls.push({ name: 'event', args: [t, x] }); return {}; }),
  say: vi.fn(), notice: vi.fn(), status: vi.fn(),
};
vi.mock('../src/alma/bridge', () => ({ alma: async () => fake }));

const { useMaestros } = await import('../src/useMaestros');
type Hook = ReturnType<typeof useMaestros>;
let hook: Hook;
function Probe() { hook = useMaestros(); return null; }

const flush = async () => { for (let i = 0; i < 20; i++) await act(async () => { await Promise.resolve(); }); };
async function mount() {
  const el = document.createElement('div');
  await act(async () => { createRoot(el).render(<Probe />); });
  await flush();
}
const snapOf = (turn: 'rojo' | 'azul'): Snapshot => ({
  v: 1, game: { status: 'Playing', board: newFromCards(['tigre', 'grulla', 'mono', 'cangrejo', 'dragon'], turn) },
  log: ['inicio'], lastMove: null,
});
const names = () => calls.map((c) => c.name);

beforeEach(() => { calls.length = 0; pendingQueue = []; match = { id: 'm1' }; });

describe('flujo con el puente', () => {
  it('retoma: aplica la jugada pendiente sin ver, luego seen() y save(después)', async () => {
    match = { id: 'm1', turn: 'alma', snapshot: snapOf('azul'), pending: { id: 'tigre:b5-b3', seen: false, reaccion: 'contenta' } };
    await mount();
    expect(names()).toEqual(['start', 'seen', 'save']);
    const saved = calls[2].args[0] as Snapshot;
    expect(saved.game.status === 'Playing' && saved.game.board.bluePawns[1]).toEqual(pt(1, 2));
    expect(saved.game.board.turn).toBe('rojo');
    expect(hook.phase).toBe('dueno');
  });

  it('retoma con turno de Alma y sin pendiente: espera con waitPending()', async () => {
    match = { id: 'm1', turn: 'alma', snapshot: snapOf('azul'), pending: null };
    pendingQueue = [{ id: 'grulla:c5-c4', seen: false }];
    await mount();
    expect(names()).toEqual(['start', 'waitPending', 'seen', 'save']);
    expect(hook.phase).toBe('dueno');
  });

  it('jugada del dueño → move(async, snapshot antes de Alma) → pending → waitPending → aplica', async () => {
    match = { id: 'm1', snapshot: snapOf('rojo') };
    await mount();
    expect(hook.phase).toBe('dueno');
    pendingQueue = [{ id: 'tigre:b5-b3', seen: false }];
    await act(async () => { await hook.ownerPlay({ type: 'Move', card: 'mono', src: pt(1, 4), dst: pt(2, 3) }); });
    await flush();
    expect(names()).toEqual(['start', 'move', 'waitPending', 'seen', 'save']);
    const req = calls[1].args[0] as { async: boolean; snapshot: Snapshot; legal: { id: string }[]; ownerMoved: boolean };
    expect(req.async).toBe(true);
    expect(req.ownerMoved).toBe(true);
    expect(req.snapshot.game.board.turn).toBe('azul');
    expect(req.legal.map((l) => l.id)).toContain('tigre:b5-b3');
    expect(hook.phase).toBe('dueno');
  });

  it('Alma empieza en una partida nueva (sello azul): se le pide jugar con ownerMoved=false', async () => {
    match = { id: 'm1' };
    const rnd = vi.spyOn(Math, 'random').mockReturnValue(0); // baraja fija: la carta del lado será la 5.ª
    await mount();
    rnd.mockRestore();
    const s = calls.find((c) => c.name === 'save')!.args[0] as Snapshot;
    if (s.game.board.turn === 'azul') {
      const mv = calls.find((c) => c.name === 'move')!.args[0] as { ownerMoved: boolean };
      expect(mv.ownerMoved).toBe(false);
    } else expect(names()).not.toContain('move');
  });

  it('captura de Alma → buena_jugada; captura del maestro → gana_alma con historial completo', async () => {
    const s = snapOf('azul');
    if (s.game.status !== 'Playing') throw new Error();
    s.game.board.redPawns[1] = pt(1, 2); // alumno del dueño en b3
    match = { id: 'm1', turn: 'alma', snapshot: s, pending: { id: 'tigre:b5-b3', seen: false } };
    await mount();
    expect(calls.find((c) => c.name === 'event')?.args[0]).toBe('buena_jugada');

    calls.length = 0;
    const w = snapOf('azul');
    if (w.game.status !== 'Playing') throw new Error();
    w.game.board.redKing = pt(2, 2);
    match = { id: 'm1', turn: 'alma', snapshot: w, pending: { id: 'tigre:c5-c3', seen: false } };
    await mount();
    const ev = calls.find((c) => c.name === 'event')!;
    expect(ev.args[0]).toBe('gana_alma');
    expect((ev.args[1] as { history: string[] }).history[0]).toBe('inicio');
    expect(hook.phase).toBe('fin');
  });

  it('captura del dueño → mala_jugada; victoria del dueño → pierde_alma', async () => {
    const s = snapOf('rojo');
    if (s.game.status !== 'Playing') throw new Error();
    s.game.board.bluePawns[2] = pt(2, 3); // alumno de Alma en c2
    match = { id: 'm1', snapshot: s };
    await mount();
    await act(async () => { await hook.ownerPlay({ type: 'Move', card: 'cangrejo', src: pt(2, 4), dst: pt(2, 3) }); });
    await flush();
    expect(calls.find((c) => c.name === 'event')?.args[0]).toBe('mala_jugada');

    calls.length = 0;
    const w = snapOf('rojo');
    if (w.game.status !== 'Playing') throw new Error();
    w.game.board.blueKing = pt(2, 3);
    match = { id: 'm1', snapshot: w };
    await mount();
    await act(async () => { await hook.ownerPlay({ type: 'Move', card: 'cangrejo', src: pt(2, 4), dst: pt(2, 3) }); });
    await flush();
    expect(calls.find((c) => c.name === 'event')?.args[0]).toBe('pierde_alma');
    expect(names()).not.toContain('move');
    expect(hook.phase).toBe('fin');
  });
});

describe('pantalla', () => {
  it('pinta el tablero, las cartas y deja jugar tocando carta, pieza y destino', async () => {
    const { default: App } = await import('../src/App');
    match = { id: 'm1', snapshot: snapOf('rojo') };
    const el = document.createElement('div');
    document.body.appendChild(el);
    await act(async () => { createRoot(el).render(<App />); });
    await flush();
    expect(el.querySelector('h1')?.textContent).toBe('Tu turno');
    expect(el.querySelectorAll('.sq')).toHaveLength(25);
    expect(el.textContent).toContain('Mono');
    expect(el.textContent).toContain('Dragón');
    const click = async (n: Element | null | undefined) => { await act(async () => { (n as HTMLElement).click(); }); await flush(); };
    await click([...el.querySelectorAll('.owner-hand .card')].find((c) => c.textContent?.includes('Mono')));
    await click(el.querySelector('[aria-label^="b1:"]'));
    expect(el.querySelectorAll('.sq.valid').length).toBeGreaterThan(0);
    await click(el.querySelector('[aria-label^="c2:"]'));
    expect(names()).toContain('move');
    expect(el.querySelector('h1')?.textContent).toBe('Turno de Alma');
    await click([...el.querySelectorAll('.actions button')].find((b) => b.textContent === 'Historial'));
    expect(el.textContent).toContain('Dueño: Mono, alumno b1→c2');
    document.body.removeChild(el);
  });
});
