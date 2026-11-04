// Carga del puente "Jugar con Alma". Lo sirve el mismo sitio en /play/_alma/alma.js (con la sesión del dueño):
// no se copia ni se empaqueta con el juego.

export interface AlmaPending { id: string; reaccion?: string; pensamiento?: string; seen?: boolean }
export interface AlmaMatch {
  id: string;
  turn?: string; // "alma" | "dueno"…
  snapshot?: unknown;
  pending?: AlmaPending | null;
}
export interface AlmaMoveResult {
  move?: { id: string; reaccion?: string; pensamiento?: string };
  pending?: boolean;
  paused?: boolean | string;
  text?: string;
  late?: boolean;
}
export interface AlmaBridge {
  readonly match: AlmaMatch | null;
  start(fresh?: boolean): Promise<{ ok: boolean; match?: AlmaMatch; refused?: string; resumed?: boolean }>;
  load(): Promise<{ match: AlmaMatch | null; paused_text?: string }>;
  move(req: {
    state: string;
    legal: { id: string; label: string }[];
    history?: string[];
    snapshot?: unknown;
    ownerMoved?: boolean;
    async?: boolean;
    onRetry?: () => void;
  }): Promise<AlmaMoveResult>;
  waitPending(ms?: number, every?: number): Promise<AlmaPending | null>;
  resume(): Promise<unknown>;
  seen(): Promise<void>;
  save(snapshot: unknown): Promise<void>;
  event(type: string, extra?: { reaccion?: string; history?: string[] }): Promise<unknown>;
  say(thought: string, reaction?: string, ms?: number): void;
  notice(text: string, action?: { label: string; run: () => void }): void;
  status(text: string): void;
}

let bridge: Promise<AlmaBridge> | null = null;

export function alma(): Promise<AlmaBridge> {
  const url = '/play/_alma/alma.js';
  bridge ??= import(/* @vite-ignore */ url).then(
    (m: { createAlma: (g: string) => AlmaBridge }) => m.createAlma('maestros'),
  );
  // Si falla la carga (sin red), que el siguiente intento vuelva a probar.
  bridge.catch(() => { bridge = null; });
  return bridge;
}
