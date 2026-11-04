import type {
  Call,
  CallRecord,
  Difficulty,
  GameMode,
  GameSettings,
  OpenResult,
  Phase,
  Score,
  Turn,
} from '../types/game'
import { DICE_MAX, DICE_MIN } from '../lib/constants'
import { rollDice } from '../lib/dice'
import { aiFirstCall, aiRespond, judgeOpen, isValidRaise, type AiContext, type AiDecision } from '../lib/liarDice'

export interface GameState {
  settings: GameSettings
  phase: Phase
  /** 1-based round counter. */
  round: number
  /** Bumped on every roll so the scene reacts even when values repeat. */
  rollId: number
  playerDice: number[]
  /** Empty in open mode, where there is no opposing seat. */
  aiDice: number[]
  aiRevealed: boolean
  currentCall: Call | null
  /** Who is behind the standing bid — the only seat that can be challenged. */
  lastCaller: Turn | null
  log: CallRecord[]
  /** Seat that opened the round; coin-flipped in Liar's Dice, always the player otherwise. */
  firstTurn: Turn
  result: OpenResult | null
  score: Score
}

export type GameAction =
  | { type: 'set-mode'; mode: GameMode }
  | { type: 'set-dice-count'; count: number }
  | { type: 'set-ones-wild'; value: boolean }
  | { type: 'set-difficulty'; difficulty: Difficulty }
  | { type: 'set-sound'; value: boolean }
  | { type: 'set-reduce-motion'; value: boolean }
  | { type: 'start-round' }
  | { type: 'roll-complete' }
  | { type: 'player-call'; call: Call }
  | { type: 'player-open' }
  | { type: 'ai-move'; decision: AiDecision }
  | { type: 'reveal-complete' }
  | { type: 'reset' }

export interface InitialSettings {
  settings?: Partial<GameSettings>
}

export function createInitialState(options: InitialSettings = {}): GameState {
  return {
    settings: {
      mode: 'liar',
      diceCount: 3,
      onesWild: true,
      difficulty: 'normal',
      soundEnabled: true,
      reduceMotion: false,
      ...options.settings,
    },
    phase: 'idle',
    round: 0,
    rollId: 0,
    playerDice: [],
    aiDice: [],
    aiRevealed: true,
    currentCall: null,
    lastCaller: null,
    log: [],
    firstTurn: 'player',
    result: null,
    score: { player: 0, ai: 0 },
  }
}

/** Dice currently on the table. */
export function totalDice(state: GameState): number {
  return state.settings.mode === 'liar' ? state.settings.diceCount * 2 : state.settings.diceCount
}

/** Highest quantity that can legally be bid. */
export function maxBidQuantity(state: GameState): number {
  return totalDice(state)
}

/** The player may only challenge once the opponent has bid. */
export function canPlayerOpen(state: GameState): boolean {
  return state.phase === 'awaiting-call' && state.currentCall !== null && state.lastCaller === 'ai'
}

function withSettings(state: GameState, settings: Partial<GameSettings>): GameState {
  return { ...state, settings: { ...state.settings, ...settings } }
}

/** Deal a fresh hand and start the roll animation. */
function startRound(state: GameState): GameState {
  const { mode, diceCount } = state.settings
  const isLiar = mode === 'liar'

  return {
    ...state,
    phase: 'rolling',
    round: state.round + 1,
    rollId: state.rollId + 1,
    playerDice: rollDice(diceCount),
    aiDice: isLiar ? rollDice(diceCount) : [],
    // Open mode publishes everything immediately; Liar's Dice conceals the opponent.
    aiRevealed: !isLiar,
    currentCall: null,
    lastCaller: null,
    log: [],
    firstTurn: isLiar && Math.random() < 0.5 ? 'ai' : 'player',
    result: null,
  }
}

/** Score a challenge and hand the table over for the reveal. */
function resolveOpen(state: GameState, opener: Turn): GameState {
  const { currentCall, lastCaller, playerDice, aiDice, settings } = state
  if (!currentCall || !lastCaller) return state

  const judgement = judgeOpen(playerDice, aiDice, currentCall, lastCaller, settings.onesWild)
  const result: OpenResult = {
    caller: lastCaller,
    opener,
    call: currentCall,
    actualCount: judgement.actualCount,
    playerValues: playerDice,
    aiValues: aiDice,
    winner: judgement.winner,
    loser: judgement.loser,
  }

  return {
    ...state,
    phase: 'revealing',
    aiRevealed: true,
    result,
    score: { ...state.score, [judgement.winner]: state.score[judgement.winner] + 1 },
  }
}

export function gameReducer(state: GameState, action: GameAction): GameState {
  switch (action.type) {
    case 'set-mode': {
      if (action.mode === state.settings.mode) return state
      // A mode switch changes what is on the table, so the round restarts.
      // The score is kept: it is the player's session tally.
      return startRound(withSettings(state, { mode: action.mode }))
    }

    case 'set-dice-count': {
      const count = Math.round(Math.min(Math.max(action.count, DICE_MIN), DICE_MAX))
      if (count === state.settings.diceCount) return state
      return startRound(withSettings(state, { diceCount: count }))
    }

    case 'set-ones-wild': {
      if (action.value === state.settings.onesWild) return state
      return startRound(withSettings(state, { onesWild: action.value }))
    }

    case 'set-difficulty':
      return withSettings(state, { difficulty: action.difficulty })

    case 'set-sound':
      return withSettings(state, { soundEnabled: action.value })

    case 'set-reduce-motion':
      return withSettings(state, { reduceMotion: action.value })

    case 'start-round':
      return startRound(state)

    case 'roll-complete': {
      if (state.phase !== 'rolling') return state
      if (state.settings.mode === 'open') return { ...state, phase: 'round-over' }
      return { ...state, phase: state.firstTurn === 'player' ? 'awaiting-call' : 'ai-thinking' }
    }

    case 'player-call': {
      if (state.phase !== 'awaiting-call') return state
      const { call } = action
      if (call.quantity < 1 || call.quantity > maxBidQuantity(state)) return state
      if (!isValidRaise(state.currentCall, call)) return state

      return {
        ...state,
        phase: 'ai-thinking',
        currentCall: call,
        lastCaller: 'player',
        log: [...state.log, { call, by: 'player' }],
      }
    }

    case 'player-open': {
      if (!canPlayerOpen(state)) return state
      return resolveOpen(state, 'player')
    }

    case 'ai-move': {
      if (state.phase !== 'ai-thinking') return state
      const { decision } = action

      if (decision.action === 'raise' && decision.call) {
        return {
          ...state,
          phase: 'awaiting-call',
          currentCall: decision.call,
          lastCaller: 'ai',
          log: [...state.log, { call: decision.call, by: 'ai' }],
        }
      }

      return resolveOpen(state, 'ai')
    }

    case 'reveal-complete': {
      if (state.phase !== 'revealing') return state
      return { ...state, phase: 'round-over' }
    }

    case 'reset':
      return createInitialState({ settings: { ...state.settings } })

    default:
      return state
  }
}

/** Build the AI's decision context from the current position. */
export function buildAiContext(state: GameState): AiContext {
  return {
    ownValues: state.aiDice,
    opponentDice: state.playerDice.length,
    maxQuantity: maxBidQuantity(state),
    onesWild: state.settings.onesWild,
    difficulty: state.settings.difficulty,
  }
}

/** Ask the opponent to move. Pure, so it can be unit-tested in isolation. */
export function decideAiMove(state: GameState): AiDecision {
  const context = buildAiContext(state)
  if (!state.currentCall) return { action: 'raise', call: aiFirstCall(context) }
  return aiRespond(state.currentCall, context)
}
