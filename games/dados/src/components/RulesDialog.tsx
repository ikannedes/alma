import type { GameMode } from '../types/game'
import { useTranslation } from 'react-i18next'
import { Button } from './ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog'
import { PipFace } from './ui/PipFace'

export interface RulesDialogProps {
  open: boolean
  onClose: () => void
  mode: GameMode
}

/** Rules reference, opened from the app bar at any time. */
export function RulesDialog({ open, onClose, mode }: RulesDialogProps) {
  const { t } = useTranslation()

  const sections = [
    { title: t('rules.howToTitle'), items: t('rules.howTo', { returnObjects: true }) as string[] },
    { title: t('rules.judgeTitle'), items: t('rules.judge', { returnObjects: true }) as string[] },
    { title: t('rules.openTitle'), items: t('rules.open', { returnObjects: true }) as string[] },
    { title: t('rules.controlsTitle'), items: t('rules.controls', { returnObjects: true }) as string[] },
  ]

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto bg-room-900 sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('rules.title')}</DialogTitle>
          <DialogDescription>{mode === 'liar' ? t('rules.currentLiar') : t('rules.currentOpen')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          {sections.map((section) => (
            <section key={section.title}>
              <h3 className="text-[13px] font-semibold tracking-wide text-amber-200/90">{section.title}</h3>
              <ul className="mt-2 space-y-1.5">
                {section.items.map((item) => (
                  <li key={item} className="flex gap-2.5 text-[13px] leading-6 text-slate-300">
                    <span className="mt-2.5 h-1.5 w-1.5 shrink-0 rounded-full bg-slate-500" />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </section>
          ))}

          <section className="rounded-2xl border border-white/8 bg-black/25 px-4 py-3">
            <h3 className="text-[13px] font-semibold text-slate-200">{t('rules.pipChart')}</h3>
            <div className="mt-2.5 flex flex-wrap gap-2">
              {[1, 2, 3, 4, 5, 6].map((value) => (
                <span key={value} className="flex items-center gap-1.5 rounded-lg bg-white/[0.06] px-2 py-1">
                  <PipFace value={value} className="h-5 w-5" />
                  <span className="tnum text-[11px] text-slate-400">{value}</span>
                </span>
              ))}
            </div>
          </section>
        </div>

        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">{t('rules.close')}</Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
