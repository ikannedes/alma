import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { DiceScene, type CameraPreset } from '../three/DiceScene'

/** Everything the scene needs to know about the current round. */
export interface DiceSceneInput {
  containerRef: RefObject<HTMLDivElement | null>
  canvasRef: RefObject<HTMLCanvasElement | null>
  /** Called when the dice come to rest. */
  onSettle: () => void
  labels: { player: string; ai: string; shared: string }
  diceCount: number
  seats: 1 | 2
  reduceMotion: boolean
  /** Bumped on every roll; drives the animation exactly once per roll. */
  rollId: number
  playerDice: number[]
  aiDice: number[]
  aiRevealed: boolean
  /** Stage chrome height in pixels, so the camera fits around the overlays. */
  insetTop: number
  insetBottom: number
}

export interface DiceSceneApi {
  /** True when WebGL is unavailable and the flat fallback should render. */
  failed: boolean
  setView: (preset: CameraPreset) => void
}

/** Cheap capability probe, so a device without WebGL never reaches the renderer. */
function hasWebGL(): boolean {
  try {
    const probe = document.createElement('canvas')
    return Boolean(probe.getContext('webgl2') ?? probe.getContext('webgl'))
  } catch {
    return false
  }
}

/**
 * Bridges React state to the imperative Three.js scene.
 *
 * Every scene command is applied once per distinct input signature, so React
 * re-renders never restart an animation or rebuild the table. Scene creation is
 * deferred by one frame: building the renderer, compiling shaders and
 * generating the environment map are synchronous and can block the main thread
 * for seconds on a software renderer, so the page gets to paint its chrome
 * first instead of showing a blank screen.
 */
export function useDiceScene(input: DiceSceneInput): DiceSceneApi {
  const {
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
    insetTop,
    insetBottom,
  } = input

  const sceneRef = useRef<DiceScene | null>(null)
  const onSettleRef = useRef(onSettle)
  const labelsRef = useRef(labels)
  const appliedLayoutRef = useRef('')
  const appliedMotionRef = useRef<boolean | null>(null)
  const appliedRollRef = useRef(-1)

  // Derived during render; only a construction failure needs state.
  const [failed, setFailed] = useState(() => !hasWebGL())
  // Bumped once the scene exists, so the command effects below run against it.
  const [sceneEpoch, setSceneEpoch] = useState(0)

  // Kept in refs so the scene is constructed with the latest values without
  // making the construction effect depend on them.
  useEffect(() => {
    onSettleRef.current = onSettle
  }, [onSettle])

  useEffect(() => {
    labelsRef.current = labels
  }, [labels])

  useEffect(() => {
    let cancelled = false
    let scene: DiceScene | null = null

    const frame = requestAnimationFrame(() => {
      if (cancelled) return
      const container = containerRef.current
      const canvas = canvasRef.current
      if (!container || !canvas || sceneRef.current || !hasWebGL()) return

      try {
        scene = new DiceScene({
          canvas,
          container,
          onSettle: () => onSettleRef.current(),
          labels: labelsRef.current,
        })
      } catch (error) {
        console.error('[useDiceScene] WebGL scene failed to start', error)
        // External-system failure — state is the only way to surface it.
        // oxlint-disable-next-line react/set-state-in-effect
        setFailed(true)
        return
      }

      sceneRef.current = scene
      appliedLayoutRef.current = ''
      appliedMotionRef.current = null
      setSceneEpoch((epoch) => epoch + 1)
    })

    return () => {
      cancelled = true
      cancelAnimationFrame(frame)
      scene?.dispose()
      sceneRef.current = null
      appliedLayoutRef.current = ''
      appliedMotionRef.current = null
      appliedRollRef.current = -1
    }
  }, [containerRef, canvasRef])

  useEffect(() => {
    const scene = sceneRef.current
    if (!scene) return
    const signature = `${diceCount}:${seats}`
    if (appliedLayoutRef.current === signature) return
    appliedLayoutRef.current = signature
    scene.setLayout(diceCount, seats)
  }, [diceCount, seats, sceneEpoch])

  // Language switches repaint the tray labels only — dice keep their state.
  const labelsSignature = `${labels.player}|${labels.ai}|${labels.shared}`
  useEffect(() => {
    sceneRef.current?.setLabels(labels)
    // oxlint-disable-next-line react/exhaustive-deps -- keyed on the joined labels, not object identity
  }, [labelsSignature, sceneEpoch])

  useEffect(() => {
    const scene = sceneRef.current
    if (!scene || appliedMotionRef.current === reduceMotion) return
    appliedMotionRef.current = reduceMotion
    scene.setReducedMotion(reduceMotion)
  }, [reduceMotion, sceneEpoch])

  useEffect(() => {
    sceneRef.current?.setOverlayInsets({ top: insetTop, bottom: insetBottom })
  }, [insetTop, insetBottom, sceneEpoch])

  // One roll per rollId — dice values and the conceal flag arrive together.
  useEffect(() => {
    const scene = sceneRef.current
    if (!scene || rollId === appliedRollRef.current || playerDice.length === 0) return
    appliedRollRef.current = rollId
    scene.roll({ playerValues: playerDice, aiValues: aiDice, hideAi: !aiRevealed })
  }, [rollId, playerDice, aiDice, aiRevealed, sceneEpoch])

  useEffect(() => {
    if (!aiRevealed) return
    sceneRef.current?.revealAi(true)
  }, [aiRevealed, sceneEpoch])

  const setView = useCallback((preset: CameraPreset) => {
    sceneRef.current?.setView(preset)
  }, [])

  return { failed, setView }
}
