/**
 * Alma como rival (PLAN-JUEGOS, 2026-10-31). Sustituye a la IA del repo (aiRespond / aiFirstCall): el juego sigue
 * siendo el árbitro (generateRaises da solo apuestas legales, resolveOpen decide); Alma elige con Haiku en el relay
 * por el puente /play/_alma/alma.js. Sin red, Alma no juega: la ronda se queda esperando con "Reintentar".
 */
import type { AiDecision } from '../lib/liarDice'
import { estimateCallProbability, generateRaises } from '../lib/liarDice'
import { maxBidQuantity, type GameState } from '../state/gameReducer'
import type { Call } from '../types/game'

export interface AlmaMove { id: string; reaccion: string; pensamiento: string }
export interface AlmaMoveResult { move?: AlmaMove; pending?: boolean; paused?: string; text?: string; late?: boolean }
export interface AlmaBridge {
  readonly match: { id: string } | null
  start(fresh?: boolean): Promise<{ ok: boolean; refused?: string }>
  move(req: { state: string; legal: { id: string; label: string }[]; history?: string[]; ownerMoved?: boolean;
              async?: boolean; onRetry?: () => void }): Promise<AlmaMoveResult>
  event(type: string, extra?: { reaccion?: string; history?: string[] }): Promise<unknown>
  notice(text: string, action?: { label: string; run: () => void }): void
  say(thought: string, reaction?: string, ms?: number): void
}

let bridge: Promise<AlmaBridge> | null = null

/** El puente lo sirve el mismo sitio (Caddy, con la sesión del dueño); no se empaqueta con el juego. */
export function alma(): Promise<AlmaBridge> {
  const url = '/play/_alma/alma.js'
  bridge ??= import(/* @vite-ignore */ url).then((m: { createAlma: (g: string) => AlmaBridge }) => m.createAlma('dados'))
  return bridge
}

const FACE: Record<number, [string, string]> = {
  1: ['uno', 'unos'], 2: ['dos', 'doses'], 3: ['tres', 'treses'], 4: ['cuatro', 'cuatros'], 5: ['cinco', 'cincos'],
  6: ['seis', 'seises'],
}

export const callText = (c: Call) => `${c.quantity} ${FACE[c.face][c.quantity === 1 ? 0 : 1]}`
const callId = (c: Call) => `q${c.quantity}c${c.face}`

/** Jugadas legales de Alma: subir (todas las que permite el juego) o abrir si hay una apuesta del dueño. */
export function legalMoves(state: GameState): { id: string; label: string; decision: AiDecision }[] {
  const out: { id: string; label: string; decision: AiDecision }[] = []
  if (state.currentCall && state.lastCaller === 'player') {
    out.push({ id: 'abrir', label: `Abrir: dudar de "${callText(state.currentCall)}"`, decision: { action: 'open' } })
  }
  for (const call of generateRaises(state.currentCall, maxBidQuantity(state))) {
    out.push({ id: callId(call), label: `Apostar ${callText(call)}`, decision: { action: 'raise', call } })
  }
  return out
}

/** Lo que Alma ve: sus dados, la mesa y la apuesta actual con una probabilidad aproximada. */
export function stateText(state: GameState): string {
  const s = state.settings
  const lines = [
    `Tus dados (los del dueño están ocultos): ${state.aiDice.join(', ')}.`,
    `Dados en la mesa: ${state.aiDice.length + state.playerDice.length} (${state.playerDice.length} del dueño).`,
    `Unos comodín: ${s.onesWild ? 'sí' : 'no'}.`,
  ]
  if (state.currentCall) {
    const p = estimateCallProbability(state.aiDice, state.playerDice.length, state.currentCall, s.onesWild)
    lines.push(`Apuesta actual: ${callText(state.currentCall)} (la hizo ${state.lastCaller === 'ai' ? 'tú' : 'el dueño'}). ` +
      `Probabilidad aproximada de que se cumpla: ${Math.round(p * 100)} %.`)
  } else lines.push('Aún no hay apuesta: abres tú.')
  lines.push(`Marcador de hoy: tú ${state.score.ai}, dueño ${state.score.player}.`)
  return lines.join('\n')
}

export function history(state: GameState): string[] {
  return state.log.map((r) => `${r.by === 'ai' ? 'Alma' : 'Dueño'}: ${callText(r.call)}`)
}

/** Última reacción de Alma (para saber si su apuesta era un farol cuando la abren). */
let lastReaction = ''
export const almaLastReaction = () => lastReaction

/** Turno de Alma. null = no jugó (sin red, pausada): la ronda espera con "Reintentar". */
export async function almaDecides(state: GameState, onRetry: () => void): Promise<AiDecision | null> {
  const legal = legalMoves(state)
  if (!legal.length) return { action: 'open' }
  const a = await alma()
  if (!a.match) {
    const r = await a.start(true)
    if (!r.ok) return null
  }
  const r = await a.move({
    state: stateText(state), legal: legal.map(({ id, label }) => ({ id, label })), history: history(state),
    ownerMoved: state.log.length > 0, async: false, onRetry,
  })
  if (!r.move) return null
  lastReaction = r.move.reaccion
  return legal.find((m) => m.id === r.move!.id)?.decision ?? null
}
