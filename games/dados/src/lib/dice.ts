import type { RollSummary } from '../types/game'
import { FACE_MAX, FACE_MIN } from './constants'

/** Roll `count` fair six-sided dice. */
export function rollDice(count: number): number[] {
  return Array.from({ length: count }, () => randomFace())
}

/** A single fair d6 result. */
export function randomFace(): number {
  return FACE_MIN + Math.floor(Math.random() * (FACE_MAX - FACE_MIN + 1))
}

/** Collapse dice values into a sum and per-face counts. */
export function summarize(values: number[]): RollSummary {
  const counts: Record<number, number> = {}
  for (let face = FACE_MIN; face <= FACE_MAX; face += 1) counts[face] = 0
  for (const value of values) counts[value] += 1
  return {
    values,
    sum: values.reduce((total, value) => total + value, 0),
    counts,
  }
}

/** Statistical expectation of a roll of `count` dice (3.5 per die). */
export function expectedSum(count: number): number {
  return count * 3.5
}

/** Inclusive random integer. */
export function randomInt(min: number, max: number): number {
  return min + Math.floor(Math.random() * (max - min + 1))
}

/** Inclusive random float. */
export function randomFloat(min: number, max: number): number {
  return min + Math.random() * (max - min)
}
