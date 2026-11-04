import type { OpenResult } from '../types/game'
import { useTranslation } from 'react-i18next'
import { cn } from 'cn'
import { Button } from './ui/button'
import { Card, CardAction, CardContent, CardHeader, CardTitle } from './ui/card'
import { PipFace } from './ui/PipFace'
import { CheckIcon, DiceIcon, TargetIcon } from './ui/icons'

export interface ResultCardProps {
  result: OpenResult
  onesWild: boolean
  onNextRound: () => void
}

/**
 * Post-challenge breakdown: who won, why, and the arithmetic behind it. The
 * called face is highlighted in both hands so the count can be verified by eye.
 */
export function ResultCard({ result, onesWild, onNextRound }: ResultCardProps) {
  const { t } = useTranslation()
  const playerWon = result.winner === 'player'
  const claimHeld = result.actualCount >= result.call.quantity

  return (
    <Card
      className={cn(
        'animate-rise-in ring-1 ring-inset',
        playerWon ? 'ring-emerald-400/25' : 'ring-rose-400/25',
      )}
    >
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-[13px] font-semibold tracking-wide text-slate-200">
          <TargetIcon className="h-4 w-4 text-slate-400" />
          {t('result.title')}
        </CardTitle>
        <CardAction>
          <span
            className={cn(
              'rounded-full px-2.5 py-1 text-[11px] font-medium',
              playerWon ? 'bg-emerald-400/15 text-emerald-200' : 'bg-rose-400/15 text-rose-200',
            )}
          >
            {playerWon ? t('result.youWin') : t('result.aiWin')}
          </span>
        </CardAction>
      </CardHeader>

      <CardContent className="space-y-4">
        <p className="text-sm leading-6 text-slate-300">
          {t('result.verdict', {
            opener: t(`seat.${result.opener}`),
            caller: t(`seat.${result.caller}`),
            call: t('console.callNow', { quantity: result.call.quantity, face: result.call.face }),
            count: result.actualCount,
            face: result.call.face,
            held: claimHeld ? t('result.held') : t('result.notHeld'),
          })}
        </p>

        <div className="space-y-3">
          <HandRow
            label={t('seat.player')}
            values={result.playerValues}
            highlight={result.call.face}
            onesWild={onesWild}
          />
          <HandRow
            label={t('seat.ai')}
            values={result.aiValues}
            highlight={result.call.face}
            onesWild={onesWild}
          />
        </div>

        <div className="grid grid-cols-2 gap-2 text-center">
          <div className="rounded-xl bg-black/25 px-3 py-2.5">
            <div className="tnum text-xl font-semibold text-white">
              {result.actualCount}
              <span className="text-sm text-slate-400"> / {result.call.quantity}</span>
            </div>
            <div className="mt-0.5 text-[11px] text-slate-500">{t('result.actualVsCalled')}</div>
          </div>
          <div className="rounded-xl bg-black/25 px-3 py-2.5">
            <div className="flex items-center justify-center gap-1.5 text-xl font-semibold text-white">
              <PipFace value={result.call.face} className="h-6 w-6" />
              {onesWild && result.call.face !== 1 ? (
                <span className="text-xs font-normal text-amber-200">{t('result.includesOnes')}</span>
              ) : null}
            </div>
            <div className="mt-0.5 text-[11px] text-slate-500">{t('result.judgedFace')}</div>
          </div>
        </div>

        <Button className="w-full" onClick={onNextRound}>
          <DiceIcon data-icon="inline-start" />
          {t('result.nextRound')}
        </Button>
      </CardContent>
    </Card>
  )
}

function HandRow({
  label,
  values,
  highlight,
  onesWild,
}: {
  label: string
  values: number[]
  highlight: number
  onesWild: boolean
}) {
  const { t } = useTranslation()
  const counts = (value: number) => value === highlight || (onesWild && value === 1 && highlight !== 1)
  const hits = values.filter(counts).length

  return (
    <div className="rounded-xl border border-white/8 bg-black/20 px-3 py-2.5">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[11px] text-slate-400">{label}</span>
        <span className="flex items-center gap-1 text-[11px] text-slate-400">
          <CheckIcon className="h-3 w-3" />
          {t('result.counted', { count: hits })}
        </span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {values.map((value, index) => (
          <PipFace key={index} value={value} tone={counts(value) ? 'highlight' : 'ivory'} className="h-7 w-7" />
        ))}
      </div>
    </div>
  )
}
