/**
 * Core domain types for the 3D dice game.
 *
 * The game ships two modes:
 * - `liar` — 大话骰 / Liar's Dice: each seat keeps a hidden hand, players take
 *   turns raising a bid and may challenge ("open") the previous bid.
 * - `open` — 明牌 / Open Roll: a single hand is rolled in the open and the
 *   outcome is published immediately with a plain-language verdict.
 */

/** Playable modes. */
export type GameMode = 'liar' | 'open'

/** The two seats at the table. */
export type Turn = 'player' | 'ai'

/** AI aggression preset — drives how eagerly the opponent challenges. */
export type Difficulty = 'easy' | 'normal' | 'hard'

/** Lifecycle of a single round. */
export type Phase =
  /** No dice on the table yet. */
  | 'idle'
  /** Dice are tumbling in the 3D scene. */
  | 'rolling'
  /** Player's turn to bid. */
  | 'awaiting-call'
  /** The opponent is deciding. */
  | 'ai-thinking'
  /** The table is being revealed after a challenge. */
  | 'revealing'
  /** Result is final; waiting for the next round. */
  | 'round-over'

/** A bid: "I claim at least `quantity` dice show `face`". */
export interface Call {
  /** Number of dice claimed (叫的数量). */
  quantity: number
  /** Claimed face value, 1-6 (叫的点数). */
  face: number
}

/** One entry in the bidding log. */
export interface CallRecord {
  call: Call
  by: Turn
}

/** Aggregate statistics for a set of dice. */
export interface RollSummary {
  values: number[]
  sum: number
  /** Face value (1-6) mapped to how many dice show it. */
  counts: Record<number, number>
}

/** Outcome of a challenge (开牌). */
export interface OpenResult {
  /** Seat that made the challenged bid. */
  caller: Turn
  /** Seat that challenged. */
  opener: Turn
  call: Call
  /** Actual dice showing the called face, wild 1s included when enabled. */
  actualCount: number
  /** Both hands as revealed on the table. */
  playerValues: number[]
  aiValues: number[]
  winner: Turn
  loser: Turn
}

/** Per-session scoreboard. */
export interface Score {
  player: number
  ai: number
}

/** Everything the player can configure. */
export interface GameSettings {
  mode: GameMode
  /** Dice per seat in `liar` mode, or dice in the single hand in `open` mode. */
  diceCount: number
  /** When true, a 1 counts as any face (1 为任意数). */
  onesWild: boolean
  difficulty: Difficulty
  soundEnabled: boolean
  /** Honours `prefers-reduced-motion`: skips the tumble, settles immediately. */
  reduceMotion: boolean
}

/** Read-out for `open` mode: the roll plus a structured verdict. Components
 *  translate `kind` + the payloads, so the lib layer carries no copy. */
export interface OpenModeVerdict {
  summary: RollSummary
  /** Sum compared against the statistical mean (3.5 × dice count). */
  size: 'big' | 'small'
  /** Every die shows the same face (豹子). */
  isAllSame: boolean
  /** The distinct faces form a run (顺子). */
  isStraight: boolean
  /** Headline selector, in priority order: 豹子 > 顺子 > 大/小. */
  kind: 'leopard' | 'straight' | 'big' | 'small'
  /** Present when `kind` is 'leopard': the single face all dice show. */
  leopardFace?: number
  /** Present when `kind` is 'straight': the ascending distinct faces. */
  straightFaces?: number[]
  /** Present when `kind` is 'leopard': one-in-six^count style odds text. */
  leopardOdds?: string
}
