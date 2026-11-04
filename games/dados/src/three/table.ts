import * as THREE from 'three'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import { TRAY_CORNER_RATIO } from './layout'
import { createSoftDotTexture } from './pipTexture'

const FELT_INNER = '#1d7a56'
const FELT_OUTER = '#06301f'
const TABLE_BODY = '#120d0a'
const TABLE_BUMPER = '#9aa3ad'

/**
 * Paint the felt: a lit pool fading into a dark rim, with fibre noise and a
 * faint inlaid ring. Baking the light pool into the texture keeps the lighting
 * setup fully deterministic — no spot-light exposure tuning required.
 */
function createFeltTexture(size = 1024): THREE.CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')

  if (ctx) {
    const base = ctx.createRadialGradient(size / 2, size / 2, size * 0.05, size / 2, size / 2, size * 0.55)
    base.addColorStop(0, FELT_INNER)
    base.addColorStop(0.55, '#0f4b33')
    base.addColorStop(1, FELT_OUTER)
    ctx.fillStyle = base
    ctx.fillRect(0, 0, size, size)

    // Woven fibre, tuned to be felt rather than seen.
    ctx.globalAlpha = 0.05
    for (let i = 0; i < 24000; i += 1) {
      const x = Math.random() * size
      const y = Math.random() * size
      const shade = Math.random() > 0.5 ? 255 : 0
      ctx.fillStyle = `rgb(${shade}, ${shade}, ${shade})`
      ctx.fillRect(x, y, 1.6, 1.6)
    }
    ctx.globalAlpha = 1

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.07)'
    ctx.lineWidth = size * 0.004
    ctx.beginPath()
    ctx.arc(size / 2, size / 2, size * 0.36, 0, Math.PI * 2)
    ctx.stroke()

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.045)'
    ctx.beginPath()
    ctx.arc(size / 2, size / 2, size * 0.2, 0, Math.PI * 2)
    ctx.stroke()
  }

  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.anisotropy = 8
  return texture
}

/** Palette for the two seat trays, matched to the UI chrome. */
export const TRAY_ACCENTS = {
  player: { line: '52, 211, 153', text: '167, 243, 208' },
  ai: { line: '167, 139, 250', text: '221, 214, 254' },
} as const

export type TraySeat = keyof typeof TRAY_ACCENTS

export interface SeatTrayOptions {
  width: number
  depth: number
  /** Absolute height of the label band along the tray's +Z edge. */
  band: number
  /** Drawn in the band. */
  label: string
  seat: TraySeat
}

/**
 * An inlaid outline on the felt marking one seat's dice area.
 *
 * This is what keeps the table readable: it separates the two hands, and it
 * keeps "whose dice are those" answerable after the camera has been orbited.
 * Drawn on a canvas so it costs nothing at render time and scales with the tray.
 */
export function createSeatTray(options: SeatTrayOptions): { mesh: THREE.Mesh; dispose: () => void } {
  const { width, depth, band, label, seat } = options
  const px = 170
  const canvasWidth = Math.max(64, Math.round(width * px))
  const canvasHeight = Math.max(64, Math.round((depth + band) * px))
  // Canvas top maps to world −Z, so the band occupies the first rows and the
  // tray rect fills the rest. The label therefore sits above its own dice.
  const bandPx = band * px
  const rectHeight = canvasHeight - bandPx
  // Matches `trayReach` in layout.ts: rounding the corners is what keeps a wide
  // tray inside the round felt.
  const radius = Math.min(width, depth) * TRAY_CORNER_RATIO * px
  const inset = px * 0.09

  const canvas = document.createElement('canvas')
  canvas.width = canvasWidth
  canvas.height = canvasHeight
  const ctx = canvas.getContext('2d')

  const accent = TRAY_ACCENTS[seat]

  if (ctx) {
    const rectTop = bandPx

    // Tray body: a barely-there tint so the felt still reads as felt.
    ctx.beginPath()
    roundRect(
      ctx,
      inset,
      rectTop + inset,
      canvasWidth - inset * 2,
      rectHeight - inset * 2,
      radius,
    )
    ctx.fillStyle = `rgba(${accent.line}, 0.07)`
    ctx.fill()
    ctx.strokeStyle = `rgba(${accent.line}, 0.5)`
    ctx.lineWidth = Math.max(2, px * 0.02)
    ctx.stroke()

    // Label, centred in the band above the outline.
    if (label) {
      ctx.font = `600 ${Math.round(bandPx * 0.5)}px ui-sans-serif, system-ui, "PingFang SC", "Microsoft YaHei", sans-serif`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillStyle = `rgba(${accent.text}, 0.95)`
      ctx.fillText(label, canvasWidth / 2, bandPx / 2)
    }
  }

  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.anisotropy = 8

  const geometry = new THREE.PlaneGeometry(width, depth + band).rotateX(-Math.PI / 2)
  const material = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    depthWrite: false,
    toneMapped: false,
  })
  const mesh = new THREE.Mesh(geometry, material)
  mesh.position.y = 0.012
  mesh.renderOrder = 1

  return {
    mesh,
    dispose: () => {
      geometry.dispose()
      material.dispose()
      texture.dispose()
    },
  }
}

/** Canvas rounded-rectangle path (roundRect is not available everywhere yet). */
function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  const r = Math.min(radius, width / 2, height / 2)
  ctx.moveTo(x + r, y)
  ctx.lineTo(x + width - r, y)
  ctx.arcTo(x + width, y, x + width, y + r, r)
  ctx.lineTo(x + width, y + height - r)
  ctx.arcTo(x + width, y + height, x + width - r, y + height, r)
  ctx.lineTo(x + r, y + height)
  ctx.arcTo(x, y + height, x, y + height - r, r)
  ctx.lineTo(x, y + r)
  ctx.arcTo(x, y, x + r, y, r)
  ctx.closePath()
}

export interface TableParts {
  group: THREE.Group
  dispose: () => void
}

/** Build the table disc, its bumper rim and the surrounding floor plate. */
export function createTable(radius: number): TableParts {
  const group = new THREE.Group()
  const disposables: Array<{ dispose: () => void }> = []

  const feltTexture = createFeltTexture()
  const feltGeometry = new THREE.CircleGeometry(radius, 96).rotateX(-Math.PI / 2)
  const feltMaterial = new THREE.MeshStandardMaterial({
    map: feltTexture,
    roughness: 0.96,
    metalness: 0,
  })
  const felt = new THREE.Mesh(feltGeometry, feltMaterial)
  felt.position.y = 0
  felt.receiveShadow = true
  group.add(felt)
  disposables.push(feltGeometry, feltMaterial, feltTexture)

  // Wooden body underneath, so the table has thickness from a low camera.
  const bodyGeometry = new THREE.CylinderGeometry(radius + 0.34, radius + 0.62, 0.9, 96)
  const bodyMaterial = new THREE.MeshStandardMaterial({ color: TABLE_BODY, roughness: 0.62, metalness: 0.18 })
  const body = new THREE.Mesh(bodyGeometry, bodyMaterial)
  body.position.y = -0.46
  body.receiveShadow = true
  group.add(body)
  disposables.push(bodyGeometry, bodyMaterial)

  // Brushed metal bumper around the edge.
  const bumperGeometry = new THREE.CylinderGeometry(radius + 0.3, radius + 0.3, 0.26, 96, 1, true)
  const bumperMaterial = new THREE.MeshStandardMaterial({
    color: TABLE_BUMPER,
    roughness: 0.28,
    metalness: 0.92,
    side: THREE.DoubleSide,
  })
  const bumper = new THREE.Mesh(bumperGeometry, bumperMaterial)
  bumper.position.y = 0.05
  group.add(bumper)
  disposables.push(bumperGeometry, bumperMaterial)

  // Big dark plate so the table never floats in a void.
  const plateTexture = createSoftDotTexture('120, 150, 190')
  const plateGeometry = new THREE.PlaneGeometry(1, 1)
  const plateMaterial = new THREE.MeshStandardMaterial({
    map: plateTexture,
    transparent: true,
    opacity: 0.35,
    roughness: 1,
    depthWrite: false,
  })
  const plate = new THREE.Mesh(plateGeometry, plateMaterial)
  plate.rotation.x = -Math.PI / 2
  plate.position.y = -1
  plate.scale.setScalar((radius + 6) * 2.4)
  group.add(plate)
  disposables.push(plateGeometry, plateMaterial, plateTexture)

  return {
    group,
    dispose: () => {
      for (const item of disposables) item.dispose()
      group.clear()
    },
  }
}

/** Image-based lighting from three's procedural room, for believable highlights. */
export function createEnvironment(renderer: THREE.WebGLRenderer): { texture: THREE.Texture; dispose: () => void } {
  const room = new RoomEnvironment()
  const pmrem = new THREE.PMREMGenerator(renderer)
  const target = pmrem.fromScene(room, 0.04)

  room.dispose()
  pmrem.dispose()

  return {
    texture: target.texture,
    dispose: () => {
      target.texture.dispose()
      target.dispose()
    },
  }
}

export interface LightRig {
  group: THREE.Group
  key: THREE.DirectionalLight
  dispose: () => void
}

/** Key, rim and ambient lighting rig, sized to the table. */
export function createLights(radius: number): LightRig {
  const group = new THREE.Group()

  const hemisphere = new THREE.HemisphereLight('#a8c4e6', '#123425', 0.72)
  group.add(hemisphere)

  const key = new THREE.DirectionalLight('#fff3e2', 2.15)
  key.position.set(radius * 0.62, radius * 1.45, radius * 0.75)
  key.castShadow = true
  // 512 is ample for a die-sized shadow at these distances, and the shadow pass
  // is re-rendered on demand only (see DiceScene), so this stays cheap.
  key.shadow.mapSize.set(1024, 1024)
  key.shadow.camera.near = 1
  key.shadow.camera.far = radius * 4 + 12
  const span = radius * 1.15
  key.shadow.camera.left = -span
  key.shadow.camera.right = span
  key.shadow.camera.top = span
  key.shadow.camera.bottom = -span
  key.shadow.bias = -0.0006
  key.shadow.normalBias = 0.022
  key.shadow.radius = 3
  group.add(key)

  const rim = new THREE.DirectionalLight('#78a8ff', 0.62)
  rim.position.set(-radius * 0.9, radius * 0.8, -radius * 0.85)
  group.add(rim)

  const fill = new THREE.DirectionalLight('#ffcf96', 0.32)
  fill.position.set(0, radius * 0.35, radius * 1.2)
  group.add(fill)

  return {
    group,
    key,
    dispose: () => {
      group.clear()
    },
  }
}
