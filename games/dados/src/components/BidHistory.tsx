import type { CallRecord, Turn } from '../types/game'
import { useTranslation } from 'react-i18next'
import { cn } from 'cn'
import { Card, CardAction, CardContent, CardHeader, CardTitle } from './ui/card'
import { PipFace } from './ui/PipFace'
import { LayersIcon } from './ui/icons'

/** Chronological bidding log, newest entry highlighted. */
export function BidHistory({ log, opener }: { log: CallRecord[]; opener: Turn | null }) {
  const { t } = useTranslation()
  const lastIndex = log.length - 1

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-[13px] font-semibold tracking-wide text-slate-200">
          <LayersIcon className="h-4 w-4 text-slate-400" />
          {t('history.title')}
        </CardTitle>
        <CardAction>
          <span className="text-[11px] text-slate-400">{t('history.entries', { count: log.length })}</span>
        </CardAction>
      </CardHeader>

      <CardContent>
        {log.length === 0 ? (
          <p className="py-6 text-center text-xs leading-5 text-slate-500">
            {t('history.empty')}
            <br />
            {t('history.emptyHint')}
          </p>
        ) : (
          <ol className="scroll-slim max-h-72 overflow-y-auto px-2 py-1.5">
            {log.map((record, index) => {
              const isLast = index === lastIndex
              const isPlayer = record.by === 'player'
              return (
                <li
                  key={index}
                  className={cn(
                    'flex items-center gap-3 rounded-xl px-2.5 py-2 transition',
                    isLast && !opener && 'bg-white/[0.07] ring-1 ring-inset ring-white/10',
                  )}
                >
                  <span className="tnum w-5 shrink-0 text-center text-[11px] text-slate-500">{index + 1}</span>
                  <span
                    className={cn(
                      'grid h-7 w-7 shrink-0 place-items-center rounded-lg text-[11px] font-medium',
                      isPlayer ? 'bg-emerald-400/15 text-emerald-200' : 'bg-rose-400/15 text-rose-200',
                    )}
                  >
                    {isPlayer ? t('seat.playerShort') : t('seat.aiShort')}
                  </span>
                  <span className="tnum min-w-0 flex-1 truncate text-sm text-slate-200">
                    {t('console.callNow', { quantity: record.call.quantity, face: record.call.face })}
                  </span>
                  <PipFace value={record.call.face} className="h-5 w-5" />
                </li>
              )
            })}
          </ol>
        )}

        {opener && log.length > 0 ? (
          <p className="border-t border-white/8 px-4 pt-2 text-[11px] text-slate-500">
            {t('history.opener', { seat: t(`seat.${opener}`) })}
          </p>
        ) : null}
      </CardContent>
    </Card>
  )
}
