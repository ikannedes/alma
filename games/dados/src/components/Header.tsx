import type { GameMode } from '@/types/game'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { BookIcon, DiceIcon, VolumeOffIcon, VolumeOnIcon } from '@/components/ui/icons'

export interface HeaderProps {
  mode: GameMode
  onModeChange: (mode: GameMode) => void
  soundEnabled: boolean
  onSoundToggle: () => void
  onOpenRules: () => void
  busy: boolean
}

/** Sticky app bar: identity, mode switch, language and the two global toggles. */
export function Header({ mode, soundEnabled, onSoundToggle, onOpenRules, busy }: HeaderProps) {
  const { t } = useTranslation()


  return (
    <header className="sticky top-[44px] z-30 border-b border-white/8 bg-room-950/85 backdrop-blur-xl">
      <div className="mx-auto flex max-w-[1500px] flex-wrap items-center gap-3 px-4 py-3 sm:px-6">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-amber-300 to-amber-500 text-room-950 shadow-[0_10px_30px_-14px_rgb(251_191_36/0.9)]">
            <DiceIcon className="h-6 w-6" strokeWidth={2} />
          </span>
          <div className="min-w-0">
            <h1 className="truncate text-base font-semibold text-white sm:text-lg">{t('app.title')}</h1>
            <p className="truncate text-xs text-slate-400">{t(`app.subtitle.${mode}`)}</p>
          </div>
        </div>

        {/* Alma: sin selector de modo (solo dados mentirosos contra ella) */}

        <div className="flex shrink-0 items-center gap-2">

          <Button
            variant="ghost"
            size="icon"
            aria-label={soundEnabled ? t('header.soundOn') : t('header.soundOff')}
            aria-pressed={soundEnabled}
            onClick={onSoundToggle}
          >
            {soundEnabled ? <VolumeOnIcon /> : <VolumeOffIcon />}
          </Button>
          <Button variant="outline" onClick={onOpenRules} disabled={busy} className="hidden sm:inline-flex">
            <BookIcon data-icon="inline-start" />
            {t('header.rules')}
          </Button>
          <Button variant="ghost" size="icon" aria-label={t('header.rulesAria')} onClick={onOpenRules} className="sm:hidden">
            <BookIcon />
          </Button>
        </div>
      </div>
    </header>
  )
}
