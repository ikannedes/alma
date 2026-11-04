import { describe, expect, it } from 'vitest'
import {
  countMatches,
  estimateCallProbability,
  generateRaises,
  isValidRaise,
  judgeOpen,
} from './liarDice'

describe('isValidRaise', () => {
  it('accepts any opening bid', () => {
    expect(isValidRaise(null, { quantity: 1, face: 1 })).toBe(true)
    expect(isValidRaise(null, { quantity: 6, face: 6 })).toBe(true)
  })

  it('requires a higher quantity or a higher face at equal quantity', () => {
    const prev = { quantity: 2, face: 3 }
    expect(isValidRaise(prev, { quantity: 3, face: 1 })).toBe(true)
    expect(isValidRaise(prev, { quantity: 2, face: 4 })).toBe(true)
    expect(isValidRaise(prev, { quantity: 1, face: 6 })).toBe(false)
    expect(isValidRaise(prev, { quantity: 2, face: 3 })).toBe(false)
    expect(isValidRaise(prev, { quantity: 2, face: 2 })).toBe(false)
  })
})

describe('countMatches', () => {
  it('counts wild ones toward any face except one', () => {
    expect(countMatches([1, 1, 3], 3, true)).toBe(3)
    expect(countMatches([1, 1, 3], 1, true)).toBe(2)
    expect(countMatches([1, 1, 3], 3, false)).toBe(1)
    expect(countMatches([1, 1, 3], 5, true)).toBe(2)
  })
})

describe('judgeOpen', () => {
  it('sides with the bidder when the claim holds exactly', () => {
    const result = judgeOpen([4, 4], [4, 1], { quantity: 3, face: 4 }, 'player', false)
    expect(result.actualCount).toBe(3)
    expect(result.winner).toBe('player')
    expect(result.loser).toBe('ai')
  })

  it('sides with the challenger when the claim falls short', () => {
    const result = judgeOpen([4, 4], [2, 2], { quantity: 3, face: 4 }, 'player', false)
    expect(result.actualCount).toBe(2)
    expect(result.winner).toBe('ai')
  })

  it('lets the AI be the bidder too', () => {
    const result = judgeOpen([6], [6, 6], { quantity: 2, face: 6 }, 'ai', false)
    expect(result.winner).toBe('ai')
  })
})

describe('generateRaises', () => {
  it('offers every bid when the table is empty', () => {
    expect(generateRaises(null, 2)).toHaveLength(12)
  })

  it('only offers strict raises of the standing bid', () => {
    const raises = generateRaises({ quantity: 2, face: 3 }, 4)
    expect(raises).toContainEqual({ quantity: 2, face: 4 })
    expect(raises).toContainEqual({ quantity: 3, face: 1 })
    expect(raises).toContainEqual({ quantity: 4, face: 6 })
    expect(raises).not.toContainEqual({ quantity: 2, face: 3 })
    expect(raises).not.toContainEqual({ quantity: 2, face: 2 })
    expect(raises.every((call) => isValidRaise({ quantity: 2, face: 3 }, call))).toBe(true)
  })
})

describe('estimateCallProbability', () => {
  it('is certain when the hand already covers the bid', () => {
    expect(estimateCallProbability([4, 4, 4], 3, { quantity: 3, face: 4 }, false)).toBe(1)
  })

  it('matches the closed form for one needed hit', () => {
    const probability = estimateCallProbability([], 5, { quantity: 1, face: 4 }, false)
    expect(probability).toBeCloseTo(1 - (5 / 6) ** 5, 10)
  })

  it('never leaves the [0, 1] range', () => {
    const probability = estimateCallProbability([], 10, { quantity: 10, face: 6 }, true)
    expect(probability).toBeGreaterThan(0)
    expect(probability).toBeLessThanOrEqual(1)
  })
})
