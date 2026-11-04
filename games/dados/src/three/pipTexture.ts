import * as THREE from 'three'

/**
 * Pip positions on a unit square (x, y in 0-1, origin top-left).
 *
 * Every layout is invariant under 180° rotation and under mirroring, so face
 * UV orientation on a box never changes which value a face reads as. That is
 * what lets the tumble animation pick an arbitrary spin.
 */
const PIP_LAYOUTS: Record<number, ReadonlyArray<readonly [number, number]>> = {
  1: [[0.5, 0.5]],
  2: [
    [0.7, 0.7],
    [0.3, 0.3],
  ],
  3: [
    [0.72, 0.72],
    [0.5, 0.5],
    [0.28, 0.28],
  ],
  4: [
    [0.3, 0.3],
    [0.7, 0.3],
    [0.3, 0.7],
    [0.7, 0.7],
  ],
  5: [
    [0.28, 0.28],
    [0.72, 0.28],
    [0.5, 0.5],
    [0.28, 0.72],
    [0.72, 0.72],
  ],
  6: [
    [0.3, 0.24],
    [0.7, 0.24],
    [0.3, 0.5],
    [0.7, 0.5],
    [0.3, 0.76],
    [0.7, 0.76],
  ],
}

const TEXTURE_SIZE = 256

/** Face colours, kept in one place so the die reads consistently at every size. */
const FACE_HIGHLIGHT = '#ffffff'
const FACE_SHADE = '#e8e4dc'
const PIP_DARK = '#141416'
const PIP_EDGE = 'rgba(0, 0, 0, 0.55)'
const PIP_HIGHLIGHT = 'rgba(255, 255, 255, 0.5)'

/**
 * Draw one die face: a softly shaded ivory square with recessed pips that catch
 * a highlight on the lower edge, mimicking a drilled hole.
 */
function drawFace(ctx: CanvasRenderingContext2D, value: number): void {
  const size = TEXTURE_SIZE

  // Diffuse base with a corner falloff so the face is not flat white.
  const base = ctx.createLinearGradient(0, 0, size, size)
  base.addColorStop(0, FACE_HIGHLIGHT)
  base.addColorStop(0.55, '#f7f5f0')
  base.addColorStop(1, FACE_SHADE)
  ctx.fillStyle = base
  ctx.fillRect(0, 0, size, size)

  // Vignette toward the rounded edges, matching the geometry's corner radius.
  const vignette = ctx.createRadialGradient(size / 2, size / 2, size * 0.28, size / 2, size / 2, size * 0.72)
  vignette.addColorStop(0, 'rgba(0, 0, 0, 0)')
  vignette.addColorStop(1, 'rgba(90, 80, 60, 0.16)')
  ctx.fillStyle = vignette
  ctx.fillRect(0, 0, size, size)

  const pips = PIP_LAYOUTS[value] ?? []
  const radius = size * (value === 1 ? 0.135 : 0.098)

  for (const [px, py] of pips) {
    const x = px * size
    const y = py * size

    // Recessed rim: a light crescent below, a dark crescent above.
    ctx.beginPath()
    ctx.arc(x, y + radius * 0.1, radius * 1.06, 0, Math.PI * 2)
    ctx.fillStyle = PIP_HIGHLIGHT
    ctx.fill()

    ctx.beginPath()
    ctx.arc(x, y - radius * 0.06, radius * 1.05, 0, Math.PI * 2)
    ctx.strokeStyle = PIP_EDGE
    ctx.lineWidth = radius * 0.22
    ctx.stroke()

    // The hole itself.
    const hole = ctx.createRadialGradient(
      x - radius * 0.28,
      y - radius * 0.3,
      radius * 0.08,
      x,
      y,
      radius,
    )
    hole.addColorStop(0, '#3a3a40')
    hole.addColorStop(0.65, '#1b1b1f')
    hole.addColorStop(1, PIP_DARK)
    ctx.beginPath()
    ctx.arc(x, y, radius, 0, Math.PI * 2)
    ctx.fillStyle = hole
    ctx.fill()
  }
}

function finish(canvas: HTMLCanvasElement): THREE.CanvasTexture {
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.anisotropy = 8
  texture.needsUpdate = true
  return texture
}

/** Face texture for a die showing `value` (1-6). */
export function createPipTexture(value: number): THREE.CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = TEXTURE_SIZE
  canvas.height = TEXTURE_SIZE
  const ctx = canvas.getContext('2d')
  if (ctx) drawFace(ctx, value)
  return finish(canvas)
}

/**
 * Cover texture used while a hand is concealed in Liar's Dice mode. The dice
 * read as face-down rather than blank, so the table state stays legible.
 */
export function createHiddenTexture(): THREE.CanvasTexture {
  const size = 128
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')

  if (ctx) {
    const base = ctx.createLinearGradient(0, 0, size, size)
    base.addColorStop(0, '#2b2350')
    base.addColorStop(1, '#161231')
    ctx.fillStyle = base
    ctx.fillRect(0, 0, size, size)

    // Faint inlay ring, like a stamped pattern on a cup lid.
    ctx.strokeStyle = 'rgba(167, 139, 250, 0.35)'
    ctx.lineWidth = size * 0.035
    ctx.beginPath()
    ctx.arc(size / 2, size / 2, size * 0.33, 0, Math.PI * 2)
    ctx.stroke()

    ctx.fillStyle = 'rgba(226, 214, 255, 0.92)'
    ctx.font = `bold ${size * 0.46}px ui-sans-serif, system-ui, sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText('?', size / 2, size / 2 + size * 0.03)
  }

  return finish(canvas)
}

/** Soft radial sprite reused for glow dots and highlight accents. */
export function createSoftDotTexture(color = '255, 255, 255'): THREE.CanvasTexture {
  const size = 128
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')

  if (ctx) {
    const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
    gradient.addColorStop(0, `rgba(${color}, 1)`)
    gradient.addColorStop(0.45, `rgba(${color}, 0.45)`)
    gradient.addColorStop(1, `rgba(${color}, 0)`)
    ctx.fillStyle = gradient
    ctx.fillRect(0, 0, size, size)
  }

  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}
