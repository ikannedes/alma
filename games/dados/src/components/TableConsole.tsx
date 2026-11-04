import { useEffect, useState } from 'react'
import type { DiceGameApi } from '@/hooks/useDiceGame'
import { estimateCallProbability } from '@/lib/liarDice'
import { useTranslation } from 'react-i18next'
import { cn } from 'cn'
import { Button } from '@/components/ui/button'
import { Slider } from '@/components/ui/slider'
import { PipFace } from '@/components/ui/PipFace'
import { DiceIcon, EyeIcon, MinusIcon, PlusIcon, SwordsIcon } from '@/components/ui/icons'

const FACES = [1, 2, 3, 4, 5, 6]

/** Shell shared by both on-table consoles: dark glass, pinned to the felt. */
function ConsoleShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="pointer-events-auto w-full rounded-2xl border border-white/12 bg-room-900/85 p-2 shadow-[0_24px_60px_-28px_rgb(0_0_0/1)] backdrop-blur-md sm:p-2.5">
      {children}
    </div>
  )
}

/**
 * Liar's Dice bidding, right on the felt.
 *
 * The slider's range is derived every render — the floor is the standing bid
 * and the ceiling is the dice on the table — so an illegal raise is never
 * offered. Replaces the old side panel: nothing to look away from.
 */
export function BidConsole({ game }: { game: DiceGameApi }) {
  const { t } = useTranslation()
  const { state, facesFor, minQuantity, maxQuantity, canOpen, isPlayerTurn, submitCall, submitOpen } = game
  const currentCall = state.currentCall
  const lastCaller = state.lastCaller
  const onesWild = state.settings.onesWild

  const [quantity, setQuantity] = useState(minQuantity)
  const [face, setFace] = useState(() => facesFor(minQuantity)[0] ?? 1)

  const legalFaces = facesFor(quantity)
  const effectiveFace = legalFaces.includes(face) ? face : (legalFaces[0] ?? 1)
  const canBid = legalFaces.length > 0 && isPlayerTurn
  // 还没开局时，主按钮就是开局键——桌面永远有一个明确的「下一步」。
  const idle = state.phase === 'idle'

  // PC 端键盘出牌：1-6 选点数、↑↓ 调数量、Enter 叫骰/开局。
  useEffect(() => {
    if (!isPlayerTurn && !idle) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return
      const target = event.target as HTMLElement | null
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      )
        return
      if (document.querySelector('dialog[open]')) return

      if (event.key >= '1' && event.key <= '6') {
        const picked = Number(event.key)
        if (legalFaces.includes(picked)) {
          setFace(picked)
          event.preventDefault()
        }
        return
      }
      if (event.key === 'ArrowUp') {
        setQuantity((value) => Math.min(maxQuantity, value + 1))
        event.preventDefault()
        return
      }
      if (event.key === 'ArrowDown') {
        setQuantity((value) => Math.max(minQuantity, value - 1))
        event.preventDefault()
        return
      }
      if (event.key === 'Enter' && (canBid || idle)) {
        if (idle) game.startRound()
        else submitCall({ quantity, face: effectiveFace })
        event.preventDefault()
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [isPlayerTurn, legalFaces, maxQuantity, minQuantity, canBid, quantity, effectiveFace, submitCall, idle, game])

  const probability =
    state.aiDice.length === 0
      ? null
      : estimateCallProbability(state.playerDice, state.aiDice.length, { quantity, face: effectiveFace }, onesWild)
  const confidence = probability === null ? null : Math.round(probability * 100)

  const locked = !isPlayerTurn
  const roundOver = state.phase === 'round-over'
  const progress = maxQuantity === minQuantity ? 100 : ((quantity - minQuantity) / (maxQuantity - minQuantity)) * 100
  // 主按钮永远有且只有一个动作：开局前/局间开局，轮到你时叫骰。
  const canAct = canBid || idle || roundOver
  const act = () => {
    if (idle || roundOver) game.startRound()
    else submitCall({ quantity, face: effectiveFace })
  }
  const callLabel = idle
    ? t('console.startRound')
    : canBid
      ? t('console.callNow', { quantity, face: effectiveFace })
      : isPlayerTurn
        ? t('console.openOnly')
        : state.phase === 'rolling'
          ? t('console.rolling')
          : roundOver
            ? t('console.nextRound')
            : t('console.waiting')

  return (
    <ConsoleShell>
      {/* Standing bid + the odds of the raise currently dialled in */}
      <div className="flex items-center justify-between gap-3 text-[11px] leading-4">
        <span className="flex min-w-0 items-center gap-1.5 text-slate-400">
          {currentCall ? (
            <>
              {t('console.standingCall')}
              <span className="tnum font-semibold text-slate-100">{currentCall.quantity}</span>
              {t('console.quantityUnit')}
              <PipFace value={currentCall.face} className="h-4 w-4" />
              <span className="rounded-full bg-white/10 px-1.5 py-0.5 text-[10px] text-slate-300">
                {t(`seat.${lastCaller ?? 'player'}`)}
                {t('console.callerSuffix')}
              </span>
            </>
          ) : (
            t('console.noCallYet')
          )}
        </span>

        {confidence !== null ? (
          <span className="flex shrink-0 items-center gap-1.5 text-slate-400">
            {t('console.odds')}
            <span className="h-1 w-12 overflow-hidden rounded-full bg-white/10">
              <span
                className={cn(
                  'block h-full rounded-full transition-all duration-300',
                  confidence >= 66 ? 'bg-emerald-400' : confidence >= 34 ? 'bg-amber-300' : 'bg-rose-400',
                )}
                style={{ width: `${Math.max(confidence, 3)}%` }}
              />
            </span>
            <span className="tnum font-medium text-slate-200">{confidence}%</span>
          </span>
        ) : null}
      </div>

      {/* Quantity: range driven by the standing bid and the table's dice */}
      <div className={cn('mt-2 flex items-center gap-2 transition-opacity', locked && 'pointer-events-none opacity-45')}>
        <Button
          variant="secondary"
          size="icon"
          aria-label={t('console.decrease')}
          disabled={quantity <= minQuantity}
          onClick={() => setQuantity((value) => Math.max(minQuantity, value - 1))}
        >
          <MinusIcon />
        </Button>
        <div className="relative h-9 flex-1">
          {/* Gradient progress under the slider track: quantity as a dial. */}
          <div className="pointer-events-none absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 overflow-hidden rounded-full bg-white/10">
            <div
              className="h-full rounded-full bg-gradient-to-r from-emerald-400 to-amber-300 transition-[width] duration-200"
              style={{ width: `${progress}%` }}
            />
          </div>
          <Slider
            aria-label={t('console.bidQuantity')}
            min={minQuantity}
            max={maxQuantity}
            step={1}
            value={[quantity]}
            onValueChange={(values) => setQuantity(values[0] ?? quantity)}
            className="absolute inset-0 h-9 [&_[data-slot=slider-track]]:h-1.5 [&_[data-slot=slider-track]]:border-none [&_[data-slot=slider-track]]:bg-transparent [&_[data-slot=slider-range]]:bg-transparent"
          />
          <span className="tnum pointer-events-none absolute top-1/2 right-1 -translate-y-1/2 rounded bg-black/60 px-1.5 text-[11px] font-semibold text-white">
            {quantity}
          </span>
        </div>
        <Button
          variant="secondary"
          size="icon"
          aria-label={t('console.increase')}
          disabled={quantity >= maxQuantity}
          onClick={() => setQuantity((value) => Math.min(maxQuantity, value + 1))}
        >
          <PlusIcon />
        </Button>
      </div>

      {/* Faces + actions */}
      <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className={cn('grid flex-1 grid-cols-6 gap-1.5 transition-opacity', locked && 'pointer-events-none opacity-45')}>
          {FACES.map((value) => {
            const enabled = legalFaces.includes(value)
            const active = enabled && value === effectiveFace
            return (
              <button
                key={value}
                type="button"
                aria-label={t('console.bidFace', { face: value })}
                aria-pressed={active}
                disabled={!enabled}
                onClick={() => setFace(value)}
                className={cn(
                  'grid aspect-square place-items-center rounded-lg transition',
                  'focus-visible:ring-2 focus-visible:ring-amber-300/70 focus-visible:outline-none',
                  active
                    ? 'bg-amber-400/25 ring-2 ring-amber-300/80 ring-inset'
                    : 'bg-white/[0.06] ring-1 ring-white/10 ring-inset hover:bg-white/[0.12]',
                  !enabled && 'cursor-not-allowed opacity-25 hover:bg-white/[0.06]',
                  enabled && 'active:scale-95',
                )}
              >
                <PipFace value={value} tone={active ? 'highlight' : 'ivory'} className="h-6 w-6" />
              </button>
            )
          })}
        </div>

        <div className="flex gap-2">
          <Button
            className="flex-1 sm:w-32"
            disabled={!canAct}
            onClick={act}
          >
            <SwordsIcon data-icon="inline-start" />
            {callLabel}
          </Button>
          <Button variant="destructive" className="sm:w-24" disabled={!canOpen} onClick={submitOpen}>
            <EyeIcon data-icon="inline-start" />
            {t('console.open')}
          </Button>
        </div>
      </div>

      {onesWild ? (
        <p className="mt-2 text-center text-[10px] text-amber-200/70 sm:text-left">{t('console.onesWildHint')}</p>
      ) : null}
      <p className="hidden text-center text-[10px] leading-3.5 text-slate-600 sm:block">{t('console.keyboardHint')}</p>
    </ConsoleShell>
  )
}

/**
 * Open mode's whole controls: how many dice, and throw them. Changing the count
 * re-rolls immediately, so the loop is one tap.
 */
export function RollConsole({ game }: { game: DiceGameApi }) {
  const { t } = useTranslation()
  const { state } = game
  const rolling = state.phase === 'rolling'
  const count = state.settings.diceCount

  return (
    <ConsoleShell>
      <div className="flex items-center gap-2.5">
        <span className="hidden text-[11px] text-slate-400 sm:inline">{t('console.diceCount')}</span>
        <Button
          variant="secondary"
          size="icon"
          aria-label={t('console.decrease')}
          disabled={rolling || count <= 1}
          onClick={() => game.setDiceCount(count - 1)}
        >
          <MinusIcon />
        </Button>
        <div className="relative h-9 flex-1 overflow-hidden rounded-lg bg-white/[0.06] ring-1 ring-white/10 ring-inset">
          <div className="relative flex h-full items-center justify-center gap-1.5">
            <DiceIcon className={cn('h-4 w-4 text-slate-400', rolling && 'animate-soft-pulse')} />
            <span className="tnum text-lg font-semibold text-white">{count}</span>
            <span className="text-[11px] text-slate-400">{t('console.diceUnit')}</span>
          </div>
        </div>
        <Button
          variant="secondary"
          size="icon"
          aria-label={t('console.increase')}
          disabled={rolling || count >= 10}
          onClick={() => game.setDiceCount(count + 1)}
        >
          <PlusIcon />
        </Button>
        <Button className="min-w-28 flex-1 sm:flex-none" disabled={rolling} onClick={game.nextRound}>
          <DiceIcon data-icon="inline-start" />
          {rolling ? t('console.rollingShort') : t('console.rollNow')}
        </Button>
      </div>
    </ConsoleShell>
  )
}
