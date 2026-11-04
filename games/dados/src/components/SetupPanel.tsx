import type { Difficulty, GameMode, Score } from '../types/game'   // Difficulty: queda en las props (Alma no la usa)
import { DICE_MAX, DICE_MIN } from '../lib/constants'
import { useTranslation } from 'react-i18next'
import { cn } from 'cn'
import { Button } from './ui/button'
import { Card, CardAction, CardContent, CardHeader, CardTitle } from './ui/card'
import { Switch } from './ui/switch'
import { GaugeIcon, MinusIcon, PlusIcon } from './ui/icons'

export interface SetupPanelProps {
  mode: GameMode
  diceCount: number
  onDiceCountChange: (count: number) => void
  onesWild: boolean
  onOnesWildChange: (value: boolean) => void
  difficulty: Difficulty
  onDifficultyChange: (value: Difficulty) => void
  reduceMotion: boolean
  onReduceMotionChange: (value: boolean) => void
  /** Changing any of these mid-round restarts the round; we warn instead of surprising. */
  midRound: boolean
  score: Score
  round: number
  onResetScore: () => void
}

/** Table setup: everything that shapes a round. */
export function SetupPanel({
  mode,
  diceCount,
  onDiceCountChange,
  onesWild,
  onOnesWildChange,
  reduceMotion,
  onReduceMotionChange,
  midRound,
  score,
  round,
  onResetScore,
}: SetupPanelProps) {
  const { t } = useTranslation()
  const isLiar = mode === 'liar'

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-[13px] font-semibold tracking-wide text-slate-200">
          <GaugeIcon className="h-4 w-4 text-slate-400" />
          {t('setup.title')}
        </CardTitle>
        <CardAction>
          <Button
            variant="ghost"
            className="h-7 px-2 text-[11px] text-slate-400 hover:text-slate-200"
            onClick={onResetScore}
          >
            {t('setup.resetScore')}
          </Button>
        </CardAction>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* 大话骰才需要在这里调数量；明牌的骰子数就是玩法本身，长在桌面上。 */}
        {isLiar ? (
          <div>
            <div className="flex items-center justify-between">
              <span className="text-[13px] font-medium text-slate-300">{t('setup.dicePerSeat')}</span>
              <div className="flex items-center gap-2">
                <Button
                  variant="secondary"
                  size="icon"
                  className="size-7"
                  aria-label={t('console.decrease')}
                  disabled={diceCount <= DICE_MIN}
                  onClick={() => onDiceCountChange(diceCount - 1)}
                >
                  <MinusIcon />
                </Button>
                <span className="tnum w-6 text-center text-base font-semibold text-white">{diceCount}</span>
                <Button
                  variant="secondary"
                  size="icon"
                  className="size-7"
                  aria-label={t('console.increase')}
                  disabled={diceCount >= DICE_MAX}
                  onClick={() => onDiceCountChange(diceCount + 1)}
                >
                  <PlusIcon />
                </Button>
              </div>
            </div>
            <p className="mt-1 text-[11px] leading-4 text-slate-500">
              {t('setup.diceTotalHint', { total: diceCount * 2 })}
            </p>
          </div>
        ) : null}

        {midRound && isLiar ? (
          <p className="rounded-xl border border-amber-300/20 bg-amber-400/8 px-3 py-2 text-[11px] leading-4 text-amber-200/85">
            {t('setup.midRoundWarning')}
          </p>
        ) : null}

        {/* 大话骰专属规则：明牌模式下不出现，避免两种玩法互相渗透。 */}
        {isLiar ? (
          <>
            <SettingRow
              label={t('setup.onesWild')}
              hint={t('setup.onesWildHint')}
              checked={onesWild}
              onChange={onOnesWildChange}
            />

          </>
        ) : null}

        <SettingRow
          label={t('setup.reduceMotion')}
          hint={t('setup.reduceMotionHint')}
          checked={reduceMotion}
          onChange={onReduceMotionChange}
        />

        <div className="grid grid-cols-3 gap-2 border-t border-white/8 pt-3 text-center">
          <Stat label={t('setup.statRounds')} value={round} />
          <Stat label={t('setup.statPlayerWins')} value={score.player} tone="emerald" />
          <Stat label={t('setup.statAiWins')} value={score.ai} tone="rose" />
        </div>
      </CardContent>
    </Card>
  )
}

/** One switch row: label + hint on the left, the control on the right. */
function SettingRow({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string
  hint: string
  checked: boolean
  onChange: (value: boolean) => void
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-t border-white/8 pt-3 first:border-t-0 first:pt-0">
      <div className="min-w-0">
        <div className="text-[13px] font-medium text-slate-300">{label}</div>
        <div className="mt-0.5 text-[11px] leading-4 text-slate-500">{hint}</div>
      </div>
      <Switch checked={checked} onCheckedChange={onChange} aria-label={label} className="shrink-0" />
    </div>
  )
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: 'emerald' | 'rose' }) {
  return (
    <div className="rounded-xl bg-black/25 px-2 py-2">
      <div
        className={cn(
          'tnum text-lg font-semibold',
          tone === 'emerald' ? 'text-emerald-300' : tone === 'rose' ? 'text-rose-300' : 'text-slate-200',
        )}
      >
        {value}
      </div>
      <div className="text-[11px] text-slate-500">{label}</div>
    </div>
  )
}
