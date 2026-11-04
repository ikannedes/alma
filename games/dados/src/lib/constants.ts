import type { Difficulty } from '../types/game'

/** Dice allowed per seat (or per hand in open mode). */
export const DICE_MIN = 1
export const DICE_MAX = 10

/** Face bounds of a standard d6. */
export const FACE_MIN = 1
export const FACE_MAX = 6

/** How long the dice tumble before they must be readable. */
export const ROLL_DURATION_MS = 1500

/** How long the hidden hand takes to flip over on a challenge. */
export const REVEAL_DURATION_MS = 900

/** Pause before the opponent commits to a bid, so the move reads as deliberate. */
export const AI_THINK_MS = 950

/** Probability of winning the challenge above which the AI will open. */
export const AI_OPEN_THRESHOLD: Record<Difficulty, number> = {
  easy: 0.85,
  normal: 0.72,
  hard: 0.6,
}

/** How much random noise the AI adds when scoring candidate bids. */
export const AI_NOISE: Record<Difficulty, number> = {
  easy: 0.22,
  normal: 0.1,
  hard: 0.02,
}

export const DIFFICULTY_LABELS: Record<Difficulty, string> = {
  easy: '轻松',
  normal: '标准',
  hard: '高手',
}

export const STORAGE_KEY = 'dice-game:settings:v1'
