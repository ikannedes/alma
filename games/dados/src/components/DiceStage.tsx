import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { GameMode, OpenModeVerdict, OpenResult, Phase, Turn } from '../types/game'
import type { CameraPreset } from '../three/DiceScene'
import { useDiceScene } from '../hooks/useDiceScene'
import { useTranslation } from 'react-i18next'
import { cn } from 'cn'
import { Badge } from './ui/badge'
import { PipFace } from './ui/PipFace'
import { DiceIcon } from './ui/icons'

/** Camera angle order for the preset buttons and the mobile cycle button. */
const CAMERA_PRESETS = [{ preset: 'low' }, { preset: 'default' }, { preset: 'top' }] as const

export interface DiceStageProps {
  mode: GameMode
  /** 2 seats in Liar's Dice, 1 shared hand in open mode. */
  seats: 1 | 2
  diceCount: number
  /** Changes on every roll; drives the animation exactly once per roll. */
  rollId: number
  playerDice: number[]
  aiDice: number[]
  aiRevealed: boolean
  phase: Phase
  round: number
  firstTurn: Turn
  /** Present once a challenge has been decided. */
  result: OpenResult | null
  /** Open mode only: powers the compact result readout on the felt. */
  verdict: OpenModeVerdict | null
  reduceMotion: boolean
  onSettle: () => void
  /** Open mode: throw the dice again (also happens when the felt is tapped). */
  onRoll: () => void
  /**
   * Controls pinned over the bottom of the felt — the on-table console. Its
   * measured height is given back to the camera as keep-out space.
   */
  console?: ReactNode
}

/** A pointer press counts as a tap only if it barely moved and ended quickly. */
const TAP_SLOP_PX = 9
const TAP_MAX_MS = 650

/**
 * Hosts the WebGL canvas, the HUD chrome and the on-table console.
 *
 * React owns no dice state here — the scene is driven through `useDiceScene`.
 * The stage measures its own top and bottom chrome and hands those heights to
 * the scene, so the camera always fits the dice into the space left over.
 */
export function DiceStage(props: DiceStageProps) {
  const { t } = useTranslation()
  const {
    mode,
    seats,
    diceCount,
    rollId,
    playerDice,
    aiDice,
    aiRevealed,
    phase,
    round,
    firstTurn,
    result,
    verdict,
    reduceMotion,
    onSettle,
    onRoll,
    console: tableConsole,
  } = props

  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const topBarRef = useRef<HTMLDivElement>(null)
  const bottomBarRef = useRef<HTMLDivElement>(null)

  const [insets, setInsets] = useState({ top: 56, bottom: 96 })
  const applyInsets = useCallback((next: { top: number; bottom: number }) => {
    setInsets((prev) => (prev.top === next.top && prev.bottom === next.bottom ? prev : next))
  }, [])

  // Tray labels are painted onto the felt — they follow the active language.
  const labels = {
    player: t('tray.player'),
    ai: t('tray.ai'),
    shared: t('tray.shared'),
  }

  const { failed, setView } = useDiceScene({
    containerRef,
    canvasRef,
    onSettle,
    labels,
    diceCount,
    seats,
    reduceMotion,
    rollId,
    playerDice,
    aiDice,
    aiRevealed,
    insetTop: insets.top,
    insetBottom: insets.bottom,
  })

  // The camera must know how tall the chrome is. Measuring (rather than
  // guessing) keeps this correct across breakpoints and console states.
  useEffect(() => {
    const measure = () => {
      applyInsets({
        top: (topBarRef.current?.offsetHeight ?? 0) + 10,
        bottom: (bottomBarRef.current?.offsetHeight ?? 0) + 10,
      })
    }
    measure()
    const observer = new ResizeObserver(measure)
    if (topBarRef.current) observer.observe(topBarRef.current)
    if (bottomBarRef.current) observer.observe(bottomBarRef.current)
    return () => observer.disconnect()
  }, [applyInsets])

  // The active preset is UI state: the scene flies to an angle but never
  // reports one back, and dragging leaves the last chosen angle highlighted.
  const [view, setViewState] = useState<CameraPreset>('default')
  const chooseView = useCallback(
    (preset: CameraPreset) => {
      setViewState(preset)
      setView(preset)
    },
    [setView],
  )
  const cycleView = useCallback(() => {
    const order = CAMERA_PRESETS.map((entry) => entry.preset as CameraPreset)
    chooseView(order[(order.indexOf(view) + 1) % order.length])
  }, [chooseView, view])
  const currentViewLabel = t(`camera.${view}`)

  const rolling = phase === 'rolling'
  const thinking = phase === 'ai-thinking'
  const playerTurn = phase === 'awaiting-call'
  const canRoll = mode === 'open' && !rolling

  // ---- tap-to-roll on the felt (open mode only). A drag to look around must
  // not also throw the dice, so the press is only a tap if it barely moved.
  const pressRef = useRef<{ x: number; y: number; at: number } | null>(null)

  const handlePointerDown = useCallback((event: React.PointerEvent<HTMLCanvasElement>) => {
    pressRef.current = { x: event.clientX, y: event.clientY, at: performance.now() }
  }, [])

  const handlePointerUp = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      const press = pressRef.current
      pressRef.current = null
      if (!press || !canRoll) return
      const moved = Math.hypot(event.clientX - press.x, event.clientY - press.y)
      if (moved <= TAP_SLOP_PX && performance.now() - press.at <= TAP_MAX_MS) onRoll()
    },
    [canRoll, onRoll],
  )

  return (
    <div className="relative overflow-hidden rounded-2xl border border-white/10 bg-room-900 shadow-[0_40px_80px_-50px_rgb(0_0_0/1)] sm:rounded-3xl">
      <div
        ref={containerRef}
        className={cn(
          'relative w-full',
          'aspect-[4/5] max-h-[68dvh] min-h-[340px]',
          'sm:aspect-[4/3] lg:aspect-[3/2] lg:max-h-[min(64vh,660px)]',
        )}
      >
        <canvas
          ref={canvasRef}
          className={cn('absolute inset-0 h-full w-full', canRoll && 'cursor-pointer')}
          aria-hidden="true"
          onPointerDown={handlePointerDown}
          onPointerUp={handlePointerUp}
        />

        {/* Vignette: deepens the corners without touching the renderer. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(120%_90%_at_50%_38%,transparent_35%,rgb(3_5_10/0.5)_78%,rgb(3_5_10/0.88)_100%)]"
        />

        {failed ? (
          <FlatFallback playerDice={playerDice} aiDice={aiDice} aiRevealed={aiRevealed} seats={seats} />
        ) : null}

        {/* Top chrome: round state on the left, camera angles on the right */}
        <div
          ref={topBarRef}
          className="absolute inset-x-0 top-0 flex items-start justify-between gap-2 p-2.5 sm:p-4"
        >
          <div className="pointer-events-none flex max-w-[calc(100%-6.5rem)] flex-wrap items-center gap-1.5 sm:gap-2">
            <Badge variant="secondary" className="border-white/12 bg-black/45 backdrop-blur">
              {t('stage.round', { round: Math.max(round, 1) })}
            </Badge>
            <Badge variant="secondary" className="border-white/12 bg-black/45 backdrop-blur">
              {mode === 'liar'
                ? t('stage.liarDice', { count: diceCount, total: diceCount * 2 })
                : t('stage.openDice', { count: diceCount })}
            </Badge>
            {mode === 'liar' && phase !== 'idle' ? (
              <Badge className="border-amber-300/25 bg-amber-400/12 text-amber-200 backdrop-blur">
                {t('stage.firstCaller', { seat: t(`seat.${firstTurn}`) })}
              </Badge>
            ) : null}
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <span className="pointer-events-none hidden rounded-full border border-white/10 bg-black/40 px-3 py-1 text-[11px] text-slate-400 backdrop-blur xl:block">
              {t('camera.hint')}
            </span>

            <div
              role="group"
              aria-label={t('camera.groupLabel')}
              className="hidden items-center gap-0.5 rounded-full border border-white/10 bg-black/45 p-0.5 backdrop-blur sm:flex"
            >
              {CAMERA_PRESETS.map(({ preset }) => (
                <button
                  key={preset}
                  type="button"
                  aria-pressed={view === preset}
                  onClick={() => chooseView(preset as CameraPreset)}
                  className={cn(
                    'rounded-full px-2 py-1 text-[11px] transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300/70',
                    view === preset
                      ? 'bg-white/15 text-white'
                      : 'text-slate-300 hover:bg-white/12 hover:text-white',
                  )}
                >
                  {t(`camera.${preset}`)}
                </button>
              ))}
            </div>

            <button
              type="button"
              onClick={cycleView}
              aria-label={t('camera.cycle', { label: currentViewLabel })}
              className="rounded-full border border-white/10 bg-black/45 px-2.5 py-1 text-[11px] text-slate-300 backdrop-blur transition hover:bg-white/12 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300/70 sm:hidden"
            >
              {currentViewLabel}
            </button>
          </div>
        </div>

        {/* Winner banner. The subtitle is derived from the actual judgement —
            a player can win either by opening successfully or by having their
            own bid hold up, and each case reads differently. */}
        {result && phase === 'round-over' ? (
          <div className="pointer-events-none absolute inset-x-0 top-[38%] flex -translate-y-1/2 justify-center px-4">
            <div
              className={cn(
                'animate-pop-in rounded-2xl border px-5 py-2.5 text-center backdrop-blur-md',
                result.winner === 'player'
                  ? 'border-emerald-300/35 bg-emerald-500/18 text-emerald-100'
                  : 'border-rose-300/35 bg-rose-500/18 text-rose-100',
              )}
            >
              <div className="text-lg font-semibold">
                {result.winner === 'player' ? t('stage.win') : t('stage.lose')}
              </div>
              <div className="text-[11px] opacity-80">{resultHeadline(result, t)}</div>
            </div>
          </div>
        ) : null}

        {/* Bottom chrome: phase readout, then whatever controls the mode brings */}
        <div
          ref={bottomBarRef}
          className="absolute inset-x-0 bottom-0 flex flex-col items-center gap-2 p-2.5 sm:p-4"
        >
          <StatusPill
            phase={phase}
            rolling={rolling}
            thinking={thinking}
            playerTurn={playerTurn}
            mode={mode}
            verdict={verdict}
          />

          {tableConsole}

          {canRoll ? (
            <span className="pointer-events-none text-[10px] text-slate-500 sm:text-[11px]">
              {t('console.rollHint')}
            </span>
          ) : null}
        </div>
      </div>

      {failed ? (
        <p className="border-t border-white/8 bg-black/30 px-4 py-2 text-center text-[11px] text-amber-200/80">
          {t('stage.webglFailed')}
        </p>
      ) : null}
    </div>
  )
}

/** The table's status line: phase, plus the open-mode total once it is known. */
function StatusPill({
  phase,
  rolling,
  thinking,
  playerTurn,
  mode,
  verdict,
}: {
  phase: Phase
  rolling: boolean
  thinking: boolean
  playerTurn: boolean
  mode: GameMode
  verdict: OpenModeVerdict | null
}) {
  const { t } = useTranslation()
  const settled = mode === 'open' && !rolling && verdict && phase === 'round-over'

  return (
    <div
      className={cn(
        'relative flex items-center gap-2.5 overflow-hidden rounded-full border px-3.5 py-1.5 text-[11px] backdrop-blur-md transition-colors sm:py-2 sm:text-xs',
        playerTurn
          ? 'border-emerald-300/40 bg-emerald-500/15 text-emerald-100'
          : thinking || rolling
            ? 'border-amber-300/35 bg-amber-400/12 text-amber-100'
            : 'border-white/12 bg-black/45 text-slate-300',
      )}
      role="status"
      aria-live="polite"
    >
      {rolling ? (
        <DiceIcon className="h-3.5 w-3.5 animate-soft-pulse" />
      ) : (
        <span
          className={cn(
            'h-2 w-2 shrink-0 rounded-full',
            playerTurn && 'animate-ring-pulse bg-emerald-400',
            thinking && 'animate-soft-pulse bg-amber-300',
            !playerTurn && !thinking && 'bg-slate-500',
          )}
        />
      )}

      {settled ? (
        <span className="tnum flex items-center gap-2 font-medium">
          <span className="text-slate-400">{t('console.totalLabel')}</span>
          <span className="text-base font-semibold text-white">{verdict.summary.sum}</span>
          <span className="rounded-full bg-white/12 px-2 py-0.5 text-[11px] text-slate-200">
            {t(`verdict.${verdict.kind}`)}
          </span>
        </span>
      ) : (
        <span className="font-medium">{t(`phase.${phase}`)}</span>
      )}

      {thinking ? (
        <span className="flex items-center gap-0.5" aria-hidden="true">
          <span className="h-1 w-1 animate-soft-pulse rounded-full bg-current" />
          <span className="h-1 w-1 animate-soft-pulse rounded-full bg-current" style={{ animationDelay: '160ms' }} />
          <span className="h-1 w-1 animate-soft-pulse rounded-full bg-current" style={{ animationDelay: '320ms' }} />
        </span>
      ) : null}

      {rolling ? (
        <span
          aria-hidden="true"
          className="animate-sweep pointer-events-none absolute inset-y-0 w-1/3 bg-gradient-to-r from-transparent via-white/18 to-transparent"
        />
      ) : null}
    </div>
  )
}

type TFunc = ReturnType<typeof useTranslation>['t']

/** Plain-language reason for the outcome, kept next to the banner it explains. */
function resultHeadline(result: OpenResult, t: TFunc): string {
  const playerWon = result.winner === 'player'
  const playerOpened = result.opener === 'player'

  if (playerOpened) {
    return t(playerWon ? 'stage.headlineYouOpenedWon' : 'stage.headlineYouOpenedLost')
  }
  return t(playerWon ? 'stage.headlineAiOpenedYouWon' : 'stage.headlineAiOpenedYouLost')
}

/** Rendered only when WebGL is unavailable — same information, no 3D. */
function FlatFallback({
  playerDice,
  aiDice,
  aiRevealed,
  seats,
}: {
  playerDice: number[]
  aiDice: number[]
  aiRevealed: boolean
  seats: 1 | 2
}) {
  const { t } = useTranslation()

  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-gradient-to-b from-felt-700/60 to-room-950 px-4 py-10">
      {seats === 2 ? (
        <FlatRow label={t('tray.ai')} values={aiDice} tone={aiRevealed ? 'ivory' : 'concealed'} />
      ) : null}
      <FlatRow label={seats === 2 ? t('tray.player') : t('tray.shared')} values={playerDice} tone="ivory" />
    </div>
  )
}

function FlatRow({ label, values, tone }: { label: string; values: number[]; tone: 'ivory' | 'concealed' }) {
  return (
    <div className="flex flex-col items-center gap-2">
      <span className="text-[11px] tracking-wide text-slate-400">{label}</span>
      <div className="flex max-w-md flex-wrap justify-center gap-2">
        {values.map((value, index) => (
          <PipFace key={index} value={value} tone={tone} className="h-9 w-9" />
        ))}
      </div>
    </div>
  )
}
