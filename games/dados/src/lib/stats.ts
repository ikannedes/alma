import type { OpenModeVerdict, RollSummary } from '../types/game'
import { expectedSum, summarize } from './dice'

/**
 * Interpret a fully revealed roll for the open (`明牌`) mode.
 *
 * The verdict is structured, not worded: the headline is picked by priority —
 * 豹子 (all dice equal) beats 顺子 (a run of distinct faces), which beats the
 * plain big/small comparison against the statistical mean of 3.5 per die — and
 * components turn `kind` + payloads into localized text.
 */
export function analyzeOpenRoll(values: number[]): OpenModeVerdict {
  const summary = summarize(values)
  const count = values.length
  const mean = expectedSum(count)
  const size: 'big' | 'small' = summary.sum >= mean ? 'big' : 'small'

  const distinct = Object.keys(summary.counts)
    .map(Number)
    .filter((face) => summary.counts[face] > 0)
    .sort((a, b) => a - b)

  const isAllSame = count > 1 && distinct.length === 1
  const isStraight = count > 1 && distinct.length === count && distinct[count - 1] - distinct[0] === count - 1

  if (isAllSame) {
    return {
      summary,
      size,
      isAllSame,
      isStraight: false,
      kind: 'leopard',
      leopardFace: distinct[0],
      leopardOdds: allSameOdds(count),
    }
  }

  if (isStraight) {
    return {
      summary,
      size,
      isAllSame,
      isStraight,
      kind: 'straight',
      straightFaces: distinct,
    }
  }

  return {
    summary,
    size,
    isAllSame,
    isStraight,
    kind: size,
  }
}

/** Human-readable odds of every die landing on the same face. */
function allSameOdds(count: number): string {
  const probability = 6 * (1 / 6) ** count
  if (probability >= 0.001) return `${(probability * 100).toFixed(2)}%`
  return `${(probability * 100).toExponential(1)}%`
}

/** Distribution rows for the histogram, always six entries wide. */
export function faceDistribution(summary: RollSummary): Array<{ face: number; count: number; ratio: number }> {
  const total = summary.values.length || 1
  return [1, 2, 3, 4, 5, 6].map((face) => {
    const count = summary.counts[face] ?? 0
    return { face, count, ratio: count / total }
  })
}
