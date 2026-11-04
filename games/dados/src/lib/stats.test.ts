import { describe, expect, it } from 'vitest'
import { analyzeOpenRoll, faceDistribution } from './stats'

describe('analyzeOpenRoll', () => {
  it('calls all-same rolls a leopard', () => {
    const verdict = analyzeOpenRoll([3, 3, 3])
    expect(verdict.kind).toBe('leopard')
    expect(verdict.leopardFace).toBe(3)
    expect(verdict.isAllSame).toBe(true)
    expect(verdict.summary.sum).toBe(9)
  })

  it('calls distinct consecutive faces a straight', () => {
    const verdict = analyzeOpenRoll([1, 2, 3, 4, 5])
    expect(verdict.kind).toBe('straight')
    expect(verdict.straightFaces).toEqual([1, 2, 3, 4, 5])
    expect(verdict.isStraight).toBe(true)
    expect(verdict.isAllSame).toBe(false)
  })

  it('does not call a broken run a straight', () => {
    const verdict = analyzeOpenRoll([1, 2, 4, 5])
    expect(verdict.isStraight).toBe(false)
  })

  it('compares the total against the statistical mean', () => {
    expect(analyzeOpenRoll([6, 6, 5]).size).toBe('big')
    expect(analyzeOpenRoll([1, 1, 2]).size).toBe('small')
  })

  it('treats a single die as neither 豹子 nor 顺子', () => {
    const verdict = analyzeOpenRoll([4])
    expect(verdict.isAllSame).toBe(false)
    expect(verdict.isStraight).toBe(false)
  })
})

describe('faceDistribution', () => {
  it('returns all six faces with their share', () => {
    const rows = faceDistribution(analyzeOpenRoll([2, 2, 5]).summary)
    expect(rows).toHaveLength(6)
    expect(rows.find((row) => row.face === 2)?.count).toBe(2)
    expect(rows.reduce((total, row) => total + row.count, 0)).toBe(3)
  })

  it('survives an empty hand', () => {
    expect(faceDistribution(analyzeOpenRoll([]).summary)).toHaveLength(6)
  })
})
