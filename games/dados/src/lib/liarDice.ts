import type { Call, Difficulty, Turn } from '../types/game'
import { AI_NOISE, AI_OPEN_THRESHOLD, FACE_MAX, FACE_MIN } from './constants'

/**
 * How many dice count toward `face`.
 * When `onesWild` is true a 1 is wild for every face except 1 itself.
 */
export function countMatches(values: number[], face: number, onesWild: boolean): number {
  if (face === FACE_MIN) return values.filter((value) => value === FACE_MIN).length
  return values.filter((value) => value === face || (onesWild && value === FACE_MIN)).length
}

/** Probability that a single die counts toward `face`. */
export function probabilityPerDie(face: number, onesWild: boolean): number {
  if (face === FACE_MIN) return 1 / 6
  return onesWild ? 2 / 6 : 1 / 6
}

/**
 * Judge a challenge (开牌). The bidder wins when the actual number of dice
 * showing the called face (wild 1s included when enabled) is at least the
 * quantity they claimed; otherwise the challenger wins.
 */
export function judgeOpen(
  playerValues: number[],
  aiValues: number[],
  call: Call,
  caller: Turn,
  onesWild: boolean,
): { actualCount: number; winner: Turn; loser: Turn } {
  const actualCount = countMatches([...playerValues, ...aiValues], call.face, onesWild)
  const callerWins = actualCount >= call.quantity
  const winner: Turn = callerWins ? caller : caller === 'player' ? 'ai' : 'player'
  const loser: Turn = winner === 'player' ? 'ai' : 'player'
  return { actualCount, winner, loser }
}

/** A bid only beats the previous one when the quantity rises, or the face rises at equal quantity. */
export function isValidRaise(previous: Call | null, next: Call): boolean {
  if (!previous) return true
  if (next.quantity > previous.quantity) return true
  return next.quantity === previous.quantity && next.face > previous.face
}

/** Every bid that strictly outbids `previous` (or every legal bid when there is none). */
export function generateRaises(previous: Call | null, maxQuantity: number): Call[] {
  const calls: Call[] = []
  if (!previous) {
    for (let quantity = 1; quantity <= maxQuantity; quantity += 1) {
      for (let face = FACE_MIN; face <= FACE_MAX; face += 1) calls.push({ quantity, face })
    }
    return calls
  }
  for (let quantity = previous.quantity; quantity <= maxQuantity; quantity += 1) {
    for (let face = FACE_MIN; face <= FACE_MAX; face += 1) {
      const call: Call = { quantity, face }
      if (isValidRaise(previous, call)) calls.push(call)
    }
  }
  return calls
}

/** Faces that would still be a legal raise at `quantity`. */
export function legalFacesAt(quantity: number, previous: Call | null): number[] {
  const faces: number[] = []
  for (let face = FACE_MIN; face <= FACE_MAX; face += 1) {
    if (isValidRaise(previous, { quantity, face })) faces.push(face)
  }
  return faces
}

/** Lowest quantity that can still be bid given the previous bid. */
export function minimumQuantity(previous: Call | null): number {
  return previous ? previous.quantity : 1
}

/** Exact number of ways to choose `k` items from `n`, computed without overflow-prone factorials. */
function binomial(n: number, k: number): number {
  if (k < 0 || k > n) return 0
  let result = 1
  for (let i = 1; i <= k; i += 1) result = (result * (n - k + i)) / i
  return result
}

/**
 * Probability that a bid holds up, given the bidder's own dice and the
 * opponent's unknown dice: P(hidden dice supply the shortfall).
 */
export function estimateCallProbability(
  ownValues: number[],
  opponentDice: number,
  call: Call,
  onesWild: boolean,
): number {
  const own = countMatches(ownValues, call.face, onesWild)
  const perDie = probabilityPerDie(call.face, onesWild)
  const needed = Math.max(0, call.quantity - own)
  let probability = 0
  for (let hits = needed; hits <= opponentDice; hits += 1) {
    probability += binomial(opponentDice, hits) * perDie ** hits * (1 - perDie) ** (opponentDice - hits)
  }
  return Math.min(1, probability)
}

/** What the opponent decided to do on its turn. */
export interface AiDecision {
  action: 'raise' | 'open'
  call?: Call
}

export interface AiContext {
  ownValues: number[]
  /** Dice held by the human seat. */
  opponentDice: number
  /** Total dice on the table — the ceiling for any bid quantity. */
  maxQuantity: number
  onesWild: boolean
  difficulty: Difficulty
}

/** The opponent's response to the standing bid. */
export function aiRespond(previous: Call, context: AiContext): AiDecision {
  const { ownValues, opponentDice, maxQuantity, onesWild, difficulty } = context
  const previousSafe = estimateCallProbability(ownValues, opponentDice, previous, onesWild)

  if (1 - previousSafe > AI_OPEN_THRESHOLD[difficulty]) return { action: 'open' }

  const noise = AI_NOISE[difficulty]
  const candidates = generateRaises(previous, maxQuantity)
  let best: Call | null = null
  let bestScore = -Infinity

  for (const call of candidates) {
    const safe = estimateCallProbability(ownValues, opponentDice, call, onesWild)
    // Prefer cheap raises (bumping the face beats inflating the quantity) and
    // bid closer to what the hand actually supports.
    const discipline = call.quantity === previous.quantity ? 0.06 : 0
    const bluffPenalty = Math.max(0, call.quantity - countMatches(ownValues, call.face, onesWild)) * 0.02
    const score = safe + discipline - bluffPenalty + (Math.random() * 2 - 1) * noise
    if (score > bestScore) {
      bestScore = score
      best = call
    }
  }

  return best ? { action: 'raise', call: best } : { action: 'open' }
}

/** The opponent's opening bid, anchored on its strongest face. */
export function aiFirstCall(context: AiContext): Call {
  const { ownValues, maxQuantity, onesWild, difficulty } = context
  let bestFace = FACE_MIN
  let bestCount = -1
  for (let face = FACE_MIN; face <= FACE_MAX; face += 1) {
    const count = countMatches(ownValues, face, onesWild)
    if (count > bestCount) {
      bestCount = count
      bestFace = face
    }
  }
  // Easy opponents sometimes lead with a random face instead of their best one.
  if (difficulty === 'easy' && Math.random() < 0.35) bestFace = FACE_MIN + Math.floor(Math.random() * FACE_MAX)

  const quantity = Math.min(Math.max(bestCount + 1, 1), maxQuantity)
  return { quantity, face: bestFace }
}

/** Human-readable bid, e.g. "4 个 3". */
