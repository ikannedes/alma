import type { OpenModeVerdict } from '../types/game'
import { expectedSum } from '../lib/dice'
import { faceDistribution } from '../lib/stats'
import { useTranslation } from 'react-i18next'
import { cn } from 'cn'
import { Button } from './ui/button'
import { Card, CardAction, CardContent, CardHeader, CardTitle } from './ui/card'
import { PipFace } from './ui/PipFace'
import { ChartIcon, DiceIcon } from './ui/icons'

export interface OpenRollCardProps {
  verdict: OpenModeVerdict
  /** While true the numbers stay hidden so the roll is not spoiled mid-air. */
  rolling: boolean
  onRoll: () => void
  reducedMotion: boolean
}

/**
 * Result report for open (明牌) mode: the roll, its verdict and its shape.
 *
 * The dice values exist before the animation finishes, so every figure here is
 * withheld until `rolling` clears — otherwise the table would announce the
 * outcome while the dice are still tumbling.
 */
export function OpenRollCard({ verdict, rolling, onRoll, reducedMotion }: OpenRollCardProps) {
  const { t } = useTranslation()
  const distribution = faceDistribution(verdict.summary)
  const peak = Math.max(1, ...distribution.map((row) => row.count))
  const average = verdict.summary.values.length ? verdict.summary.sum / verdict.summary.values.length : 0

  const tone = verdict.isAllSame || verdict.isStraight
    ? 'bg-amber-400/18 text-amber-200'
    : verdict.size === 'big'
      ? 'bg-rose-400/15 text-rose-200'
      : 'bg-emerald-400/15 text-emerald-200'

  return (
    <Card className="animate-rise-in">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-[13px] font-semibold tracking-wide text-slate-200">
          <ChartIcon className="h-4 w-4 text-slate-400" />
          {t('open.title')}
        </CardTitle>
        <CardAction>
          <span
            className={cn(
              'rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors',
              rolling ? 'bg-white/8 text-slate-400' : tone,
            )}
          >
            {rolling ? t('open.rolling') : t(`verdict.${verdict.kind}`)}
          </span>
        </CardAction>
      </CardHeader>

      <CardContent className="space-y-4">
        <div className="flex items-end justify-between gap-4">
          <div>
            <div className="text-[11px] tracking-wide text-slate-400">{t('open.sum')}</div>
            <div
              className={cn(
                'tnum text-4xl font-semibold leading-tight transition-colors',
                rolling ? 'text-slate-600' : 'text-white',
              )}
            >
              {rolling ? '—' : verdict.summary.sum}
            </div>
          </div>
          <div className="text-right">
            <div className="text-[11px] text-slate-400">{t('open.average')}</div>
            <div className={cn('tnum text-lg font-medium', rolling ? 'text-slate-600' : 'text-slate-300')}>
              {rolling ? '—' : average.toFixed(1)}
            </div>
          </div>
        </div>

        <p
          className={cn(
            'rounded-xl border border-white/8 bg-black/25 px-3.5 py-2.5 text-[13px] leading-5',
            rolling ? 'text-slate-500' : 'text-slate-300',
          )}
        >
          {rolling ? t('open.rollingDetail') : verdictDetail(verdict, t)}
        </p>

        <div className={cn('space-y-1.5 transition-opacity duration-300', rolling && 'opacity-30')}>
          {distribution.map((row) => (
            <div key={row.face} className="flex items-center gap-3">
              <PipFace value={row.face} className="h-5 w-5" />
              <div className="h-2 flex-1 overflow-hidden rounded-full bg-white/8">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-amber-300 to-emerald-300 transition-[width] duration-500"
                  style={{ width: rolling ? '0%' : `${(row.count / peak) * 100}%` }}
                />
              </div>
              <span className="tnum w-8 text-right text-xs text-slate-400">{rolling ? '·' : row.count}</span>
            </div>
          ))}
        </div>

        <Button className="w-full" disabled={rolling} onClick={onRoll}>
          <DiceIcon data-icon="inline-start" className={cn('h-4.5 w-4.5', rolling && 'animate-soft-pulse')} />
          {rolling ? t('open.throwing') : reducedMotion ? t('open.again') : t('open.rollAgain')}
        </Button>
      </CardContent>
    </Card>
  )
}

type TFunc = ReturnType<typeof useTranslation>['t']

/** Localized one-liner for the structured verdict. */
function verdictDetail(verdict: OpenModeVerdict, t: TFunc): string {
  switch (verdict.kind) {
    case 'leopard':
      return t('verdict.leopardDetail', {
        count: verdict.summary.values.length,
        face: verdict.leopardFace,
        odds: verdict.leopardOdds,
      })
    case 'straight':
      return t('verdict.straightDetail', {
        faces: verdict.straightFaces?.join(' - '),
        count: verdict.summary.values.length,
      })
    case 'big':
      return t('verdict.bigDetail', { sum: verdict.summary.sum, mean: expectedMean(verdict) })
    default:
      return t('verdict.smallDetail', { sum: verdict.summary.sum, mean: expectedMean(verdict) })
  }
}

function expectedMean(verdict: OpenModeVerdict): number {
  return expectedSum(verdict.summary.values.length)
}
