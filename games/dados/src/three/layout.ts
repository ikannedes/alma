import * as THREE from 'three'
import { randomFloat } from '../lib/dice'

/** Final resting place for one die, in table space. */
export interface DiceSlot {
  position: THREE.Vector3
  /** Free rotation about Y, so identical values still look distinct. */
  spinY: number
}

/** Felt area reserved for one seat, drawn as an inlaid tray. */
export interface SeatTray {
  /** Centre of the tray in table space. */
  center: THREE.Vector3
  /** Span across the dice block, plus padding. */
  width: number
  /** Span front-to-back across the dice block, plus padding. */
  depth: number
  /** Absolute height of the label band drawn along the tray's +Z edge. */
  band: number
  /** Text drawn in that band. */
  label: string
}

export interface DiceLayout {
  player: DiceSlot[]
  ai: DiceSlot[]
  rows: number
  /** Half-extent the table must cover on X / Z. */
  extent: { x: number; z: number }
  trays: { player: SeatTray; ai: SeatTray | null }
}

export interface LayoutOptions {
  count: number
  /** 1 = single shared hand (open mode), 2 = one hand per seat (Liar's Dice). */
  seats: 1 | 2
  dieSize: number
  /** Labels for the two trays; ignored in single-seat mode. */
  labels?: { player: string; ai: string; shared: string }
  /** Defaults to `true`; disabled for deterministic screenshots and tests. */
  jitter?: boolean
}

/**
 * Spacing and padding, as multiples of the die size. Tuned so that neighbouring
 * dice, adjacent rows and the two seats all read as separate objects — dice that
 * touch each other are impossible to count at a glance.
 */
export const LAYOUT_TUNING = {
  /** Centre-to-centre distance within a row. */
  spacingX: 1.62,
  /** Centre-to-centre distance between rows. */
  spacingZ: 1.88,
  /** Empty felt between the two seats' blocks. */
  seatGap: 2.7,
  /** Felt margin inside a tray, beyond the outermost die edge. */
  trayPadding: 0.62,
  /**
   * Height of the tray's label band. It sits on the tray's far (−Z) edge, so
   * each label reads as a header above its own dice rather than a caption that
   * could belong to the row in front of it.
   */
  labelBand: 1.0,
  /** Positional jitter, to break up the grid without risking overlap. */
  jitter: 0.07,
} as const

/**
 * Corner rounding of a tray, as a fraction of its shorter side.
 *
 * Generously rounded trays are not just a look: a rectangle's corners are its
 * furthest points from the table centre, so sharp corners would push off the
 * round felt. Rounding them off keeps every tray inside the felt by
 * construction.
 */
export const TRAY_CORNER_RATIO = 0.42

/**
 * Furthest distance from the table centre to the tray outline, taking the
 * rounding and the label band into account. Used to size the felt.
 */
export function trayReach(tray: SeatTray): number {
  const corner = Math.min(tray.width, tray.depth) * TRAY_CORNER_RATIO
  // The label band extends the tray away from the table centre.
  const farZ = Math.abs(tray.center.z) + tray.depth / 2 + tray.band
  const farX = Math.abs(tray.center.x) + tray.width / 2
  return Math.hypot(Math.max(0, farX - corner), Math.max(0, farZ - corner)) + corner
}

/**
 * Points along a tray's rounded outline, in table space.
 *
 * The camera fits against these rather than the felt rim: the trays (and the
 * dice inside them) are the subject, and letting the outer felt run past the
 * frame reads as a close-up instead of a floating disc.
 */
export function trayOutlinePoints(tray: SeatTray, segments = 24): THREE.Vector3[] {
  const halfWidth = tray.width / 2
  const halfDepth = tray.depth / 2
  const corner = Math.min(tray.width, tray.depth) * TRAY_CORNER_RATIO
  const cx = Math.max(0, halfWidth - corner)
  const cz = Math.max(0, halfDepth - corner)

  const points: THREE.Vector3[] = []
  for (let i = 0; i < segments; i += 1) {
    const angle = (i / segments) * Math.PI * 2
    const x = tray.center.x + Math.sign(Math.cos(angle)) * (cx + corner * Math.abs(Math.cos(angle)))
    const z =
      tray.center.z + tray.band / 2 + Math.sign(Math.sin(angle)) * (cz + corner * Math.abs(Math.sin(angle)))
    points.push(new THREE.Vector3(x, 0, z))
  }
  return points
}

/** Dice per row before the layout wraps. */
function perRowFor(count: number): number {
  return count <= 5 ? Math.max(1, count) : Math.ceil(count / 2)
}

function buildBlock(
  total: number,
  perRow: number,
  rows: number,
  centerZ: number,
  dieSize: number,
  jitter: boolean,
): DiceSlot[] {
  const { spacingX, spacingZ } = LAYOUT_TUNING
  const slots: DiceSlot[] = []
  let remaining = total

  for (let row = 0; row < rows; row += 1) {
    const inRow = Math.min(perRow, remaining)
    remaining -= inRow
    const rowZ = centerZ - row * spacingZ * dieSize

    for (let column = 0; column < inRow; column += 1) {
      const rowX = (column - (inRow - 1) / 2) * spacingX * dieSize
      const jitterX = jitter ? randomFloat(-1, 1) * LAYOUT_TUNING.jitter * dieSize : 0
      const jitterZ = jitter ? randomFloat(-1, 1) * LAYOUT_TUNING.jitter * dieSize : 0
      slots.push({
        position: new THREE.Vector3(rowX + jitterX, dieSize / 2, rowZ + jitterZ),
        spinY: randomFloat(0, Math.PI * 2),
      })
    }
  }

  return slots
}

function trayFor(
  centerZ: number,
  blockWidth: number,
  depth: number,
  dieSize: number,
  label: string,
): SeatTray {
  const { trayPadding, labelBand } = LAYOUT_TUNING
  return {
    center: new THREE.Vector3(0, 0, centerZ),
    width: blockWidth + trayPadding * 2 * dieSize,
    depth: depth + trayPadding * 2 * dieSize,
    band: labelBand * dieSize,
    label,
  }
}

/**
 * Arrange dice in centred rows, and work out the felt tray that holds each
 * seat's hand.
 *
 * In two-seat mode the hands sit in two mirrored trays separated by a wide
 * band of empty felt, each with its own label, so it is always obvious which
 * dice belong to whom — even after the camera has been orbited.
 */
export function computeLayout(options: LayoutOptions): DiceLayout {
  const { count, seats, dieSize, jitter = true, labels } = options
  const { spacingX, spacingZ, seatGap } = LAYOUT_TUNING

  const total = Math.max(1, count)
  const perRow = perRowFor(total)
  const rows = Math.ceil(total / perRow)

  const blockWidth = (perRow - 1) * spacingX * dieSize + dieSize
  const blockDepth = (rows - 1) * spacingZ * dieSize + dieSize
  const z0 = seats === 2 ? (seatGap * dieSize) / 2 + blockDepth / 2 : 0

  const player = buildBlock(total, perRow, rows, z0, dieSize, jitter)
  const ai = seats === 2 ? buildBlock(total, perRow, rows, -z0, dieSize, jitter) : []

  const playerLabel =
    seats === 2 ? (labels?.player ?? '你的骰子') : (labels?.shared ?? '本局骰子')
  const playerTray = trayFor(z0, blockWidth, blockDepth, dieSize, playerLabel)
  const aiTray =
    seats === 2
      ? trayFor(-z0, blockWidth, blockDepth, dieSize, labels?.ai ?? '对手的骰子')
      : null

  return {
    player,
    ai,
    rows,
    extent: {
      // Measured from a die's centre: half a die plus the tray padding.
      x: blockWidth / 2 + dieSize * 0.35,
      z: z0 + blockDepth / 2 + dieSize * 0.5,
    },
    trays: {
      player: playerTray,
      ai: aiTray,
    },
  }
}
