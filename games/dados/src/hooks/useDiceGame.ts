import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import type { Call, GameMode, GameSettings } from '../types/game'
import { AI_THINK_MS, REVEAL_DURATION_MS, ROLL_DURATION_MS, STORAGE_KEY } from '../lib/constants'
import { legalFacesAt, minimumQuantity } from '../lib/liarDice'
import { alma, almaDecides, almaLastReaction, history as almaHistory } from '../alma/almaPlayer'
import {
  canPlayerOpen,
  createInitialState,
  gameReducer,
  maxBidQuantity,
  type GameState,
} from '../state/gameReducer'
import {
  playCallSound,
  playLoseSound,
  playRevealSound,
  playRollSound,
  playSettleSound,
  playWinSound,
  setMuted,
  unlockAudio,
} from '../lib/sound'

const PERSISTED_KEYS: Array<keyof GameSettings> = [
  'mode',
  'diceCount',
  'onesWild',
  'difficulty',
  'soundEnabled',
]

/** Restore the previous session's preferences, ignoring anything malformed. */
function loadSettings(): Partial<GameSettings> {
  if (typeof window === 'undefined') return {}
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const restored: Partial<GameSettings> = {}
    for (const key of PERSISTED_KEYS) {
      const value = parsed[key]
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        Object.assign(restored, { [key]: value })
      }
    }
    return restored
  } catch {
    return {}
  }
}

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

export interface DiceGameApi {
  state: GameState
  /** Dice currently on the table. */
  totalDice: number
  /** Ceiling for any bid quantity. */
  maxQuantity: number
  /** Lowest quantity the player may still bid. */
  minQuantity: number
  /** Faces that would be a legal raise at `quantity`. */
  facesFor: (quantity: number) => number[]
  canOpen: boolean
  isPlayerTurn: boolean
  isBusy: boolean
  setMode: (mode: GameMode) => void
  setDiceCount: (count: number) => void
  adjustDiceCount: (delta: number) => void
  setOnesWild: (value: boolean) => void
  setDifficulty: (difficulty: GameSettings['difficulty']) => void
  setSoundEnabled: (value: boolean) => void
  setReduceMotion: (value: boolean) => void
  startRound: () => void
  nextRound: () => void
  reset: () => void
  submitCall: (call: Call) => void
  submitOpen: () => void
  /** Wired to the 3D scene so the round advances the moment the dice stop. */
  notifySettled: () => void
}

/**
 * Owns the round flow and keeps it in step with the 3D scene.
 *
 * Timing model: the reducer is pure and instant, while the scene animates. Each
 * animated phase therefore has (a) an event from the scene when it finishes and
 * (b) a generous fallback timer, so a stalled WebGL context or a backgrounded
 * tab can never leave the round stuck.
 */
export function useDiceGame(): DiceGameApi {
  const [state, dispatch] = useReducer(
    gameReducer,
    undefined,
    () => createInitialState({ settings: { ...loadSettings(), mode: 'liar', reduceMotion: prefersReducedMotion() } }),
  )

  // Keep a live reference so event handlers stay stable across renders.
  const stateRef = useRef(state)
  useEffect(() => {
    stateRef.current = state
  }, [state])

  // ------------------------------------------------------------- preferences

  useEffect(() => {
    setMuted(!state.settings.soundEnabled)
  }, [state.settings.soundEnabled])

  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      const payload = Object.fromEntries(
        PERSISTED_KEYS.map((key) => [key, state.settings[key]]),
      )
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload))
    } catch {
      // Storage can be unavailable (private mode); preferences simply do not persist.
    }
  }, [state.settings])

  // ----------------------------------------------------------- round timing

  // The roll ends early when the scene reports settle; this is the safety net.
  useEffect(() => {
    if (state.phase !== 'rolling') return
    const budget = state.settings.reduceMotion ? 450 : ROLL_DURATION_MS + 300
    const timer = window.setTimeout(() => dispatch({ type: 'roll-complete' }), budget)
    return () => window.clearTimeout(timer)
  }, [state.phase, state.rollId, state.settings.reduceMotion])

  useEffect(() => {
    if (state.phase !== 'rolling') return
    playRollSound()
  }, [state.phase, state.rollId])

  useEffect(() => {
    if (state.phase === 'awaiting-call' || state.phase === 'ai-thinking') {
      playSettleSound()
      // 触觉反馈只在支持的安卓设备上生效，iOS 会静默忽略。
      navigator.vibrate?.(12)
    }
  }, [state.phase])

  // Reveal: the scene animates the flip, the timer closes it out.
  useEffect(() => {
    if (state.phase !== 'revealing') return
    const timer = window.setTimeout(
      () => dispatch({ type: 'reveal-complete' }),
      state.settings.reduceMotion ? 350 : REVEAL_DURATION_MS + 220,
    )
    return () => window.clearTimeout(timer)
  }, [state.phase, state.settings.reduceMotion])

  // Alma (Haiku en el relay) decide; el juego aplica y valida. Sin red, la ronda espera a "Reintentar".
  const [almaTry, setAlmaTry] = useState(0)
  useEffect(() => {
    if (state.phase !== 'ai-thinking') return
    let cancelled = false
    const started = Date.now()
    void almaDecides(stateRef.current, () => setAlmaTry((n) => n + 1)).then((decision) => {
      if (cancelled || !decision) return
      const wait = Math.max(0, (state.settings.reduceMotion ? 260 : AI_THINK_MS) - (Date.now() - started))
      window.setTimeout(() => !cancelled && dispatch({ type: 'ai-move', decision }), wait)
    })
    return () => {
      cancelled = true
    }
  }, [state.phase, state.settings.reduceMotion, state.round, state.rollId, state.log.length, almaTry])

  // Fin de ronda: al relay (memoria de partidas) y al robot (game_event): gana o pierde, y si abrieron su farol.
  const reportedRound = useRef(-1)
  useEffect(() => {
    if (state.phase !== 'round-over' || !state.result || reportedRound.current === state.round) return
    reportedRound.current = state.round
    const r = state.result
    void alma().then(async (a) => {
      if (!a.match) return
      const hist = [...almaHistory(stateRef.current), `${r.opener === 'ai' ? 'Alma' : 'Dueño'} abrió`]
      if (r.opener === 'player' && r.caller === 'ai' && r.winner === 'player' && almaLastReaction() === 'farol')
        await a.event('farol_descubierto', { reaccion: 'nerviosa' })
      else if (r.opener === 'ai') await a.event(r.winner === 'ai' ? 'buena_jugada' : 'mala_jugada')
      await a.event(r.winner === 'ai' ? 'gana_alma' : 'pierde_alma', { history: hist })
    })
  }, [state.phase, state.result, state.round])

  // Result sting, once per decided round.
  const lastStingRound = useRef(-1)
  useEffect(() => {
    if (state.phase !== 'round-over' || !state.result) return
    if (lastStingRound.current === state.round) return
    lastStingRound.current = state.round
    if (state.result.winner === 'player') playWinSound()
    else playLoseSound()
  }, [state.phase, state.result, state.round])

  // ---------------------------------------------------------------- actions

  const startRound = useCallback(() => {
    unlockAudio()
    dispatch({ type: 'start-round' })
  }, [])

  const submitCall = useCallback((call: Call) => {
    unlockAudio()
    playCallSound(call.quantity)
    dispatch({ type: 'player-call', call })
  }, [])

  const submitOpen = useCallback(() => {
    unlockAudio()
    playRevealSound()
    dispatch({ type: 'player-open' })
  }, [])

  const notifySettled = useCallback(() => {
    dispatch({ type: 'roll-complete' })
  }, [])

  // Recomputed from the live bid so the panel never offers an illegal raise.
  const facesFor = useCallback((quantity: number) => legalFacesAt(quantity, state.currentCall), [state.currentCall])

  const derived = useMemo(() => {
    const total = state.settings.mode === 'liar' ? state.settings.diceCount * 2 : state.settings.diceCount
    return {
      totalDice: total,
      maxQuantity: maxBidQuantity(state),
      minQuantity: minimumQuantity(state.currentCall),
      canOpen: canPlayerOpen(state),
      isPlayerTurn: state.phase === 'awaiting-call',
      isBusy: state.phase === 'rolling' || state.phase === 'ai-thinking' || state.phase === 'revealing',
    }
  }, [state])

  return {
    state,
    ...derived,
    facesFor,
    setMode: useCallback((mode: GameMode) => dispatch({ type: 'set-mode', mode }), []),
    setDiceCount: useCallback((count: number) => dispatch({ type: 'set-dice-count', count }), []),
    adjustDiceCount: useCallback(
      (delta: number) => {
        const next = stateRef.current.settings.diceCount + delta
        dispatch({ type: 'set-dice-count', count: next })
      },
      [],
    ),
    setOnesWild: useCallback((value: boolean) => dispatch({ type: 'set-ones-wild', value }), []),
    setDifficulty: useCallback(
      (difficulty: GameSettings['difficulty']) => dispatch({ type: 'set-difficulty', difficulty }),
      [],
    ),
    setSoundEnabled: useCallback((value: boolean) => dispatch({ type: 'set-sound', value }), []),
    setReduceMotion: useCallback((value: boolean) => dispatch({ type: 'set-reduce-motion', value }), []),
    startRound,
    nextRound: startRound,
    reset: useCallback(() => dispatch({ type: 'reset' }), []),
    submitCall,
    submitOpen,
    notifySettled,
  }
}
