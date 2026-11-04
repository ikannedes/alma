import type { DiceGameApi } from '../hooks/useDiceGame'
import { useTranslation } from 'react-i18next'
import { cn } from 'cn'
import { Button } from './ui/button'
import { Card, CardAction, CardContent, CardHeader, CardTitle } from './ui/card'
import { DiceIcon, ResetIcon, SwordsIcon, TrophyIcon } from './ui/icons'

/**
 * Whose turn it is, what just happened, and the one action that moves the round
 * forward. Complements the on-table console: this is the read-first panel.
 */
export function StatusPanel({ game }: { game: DiceGameApi }) {
  const { t } = useTranslation()
  const { state, isPlayerTurn, isBusy, totalDice } = game
  const isLiar = state.settings.mode === 'liar'
  const roundOver = state.phase === 'round-over'
  const playerWon = state.result?.winner === 'player'

  const primaryLabel = !isLiar
    ? isBusy
      ? t('status.throwing')
      : t('status.rollAgain')
    : roundOver
      ? t('status.restartRound')
      : t('console.startRound')

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-[13px] font-semibold tracking-wide text-slate-200">
          <SwordsIcon className="h-4 w-4 text-slate-400" />
          {t('status.title')}
        </CardTitle>
        <CardAction>
          <span className="text-[11px] text-slate-400">
            {isLiar ? t('status.onTable', { count: totalDice }) : t('status.inOneThrow', { count: totalDice })}
          </span>
        </CardAction>
      </CardHeader>

      <CardContent className="space-y-3">
        {isLiar ? (
          <div className="grid grid-cols-2 gap-2">
            <SeatCard
              label={t('seat.player')}
              tone="emerald"
              active={isPlayerTurn}
              subtitle={state.score.player > 0 ? t('status.wins', { count: state.score.player }) : undefined}
            />
            <SeatCard
              label={t('seat.ai')}
              tone="rose"
              active={state.phase === 'ai-thinking' || (state.lastCaller === 'ai' && !roundOver)}
              subtitle={state.score.ai > 0 ? t('status.wins', { count: state.score.ai }) : undefined}
            />
          </div>
        ) : (
          // Open mode has no opponent: showing seat cards would leak the other
          // mode into this one.
          <div className="rounded-xl border border-white/8 bg-black/20 px-3 py-2.5 text-[12px] leading-5 text-slate-400">
            {t('status.openIntro', { count: totalDice })}
          </div>
        )}

        <div className="flex items-center gap-2 rounded-xl border border-white/8 bg-black/25 px-3.5 py-2.5">
          {state.result ? (
            <TrophyIcon className={cn('h-4 w-4 shrink-0', playerWon ? 'text-emerald-300' : 'text-rose-300')} />
          ) : (
            <DiceIcon className="h-4 w-4 shrink-0 text-slate-400" />
          )}
          <span className="text-[13px] text-slate-300">
            {state.phase === 'idle' ? t('status.clickToStart') : t(`phase.${state.phase}`)}
          </span>
        </div>

        <div className="grid grid-cols-1 gap-2">
          <Button disabled={isBusy} onClick={game.nextRound} className="w-full">
            <DiceIcon data-icon="inline-start" />
            {primaryLabel}
          </Button>
          <Button variant="ghost" className="w-full text-slate-400" onClick={game.reset}>
            <ResetIcon data-icon="inline-start" className="h-3.5 w-3.5" />
            {t('status.resetAll')}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

function SeatCard({
  label,
  tone,
  active,
  subtitle,
}: {
  label: string
  tone: 'emerald' | 'rose'
  active: boolean
  subtitle?: string
}) {
  const { t } = useTranslation()
  const palette =
    tone === 'emerald'
      ? { ring: 'ring-emerald-300/60', text: 'text-emerald-200', dot: 'bg-emerald-400' }
      : { ring: 'ring-rose-300/60', text: 'text-rose-200', dot: 'bg-rose-400' }

  return (
    <div
      className={cn(
        'relative rounded-xl border px-3 py-2.5 transition',
        active ? `border-white/10 bg-white/[0.07] ring-1 ring-inset ${palette.ring}` : 'border-white/8 bg-black/20',
      )}
    >
      <div className="flex items-center gap-2">
        <span className={cn('h-2 w-2 rounded-full', active ? `${palette.dot} animate-soft-pulse` : 'bg-slate-600')} />
        <span className={cn('text-[13px] font-medium', active ? palette.text : 'text-slate-300')}>{label}</span>
      </div>
      <div className="mt-1 text-[11px] text-slate-500">
        {active ? t('status.seatActive') : (subtitle ?? t('status.seatWaiting'))}
      </div>
    </div>
  )
}
