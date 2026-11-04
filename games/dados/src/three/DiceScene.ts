import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import { DICE_MAX, DICE_MIN, REVEAL_DURATION_MS, ROLL_DURATION_MS } from '../lib/constants'
import { FACE_MATERIAL_ORDER } from './diceFace'
import { computeLayout, trayOutlinePoints, trayReach, type DiceLayout } from './layout'
import { createHiddenTexture, createPipTexture } from './pipTexture'
import {
  createEnvironment,
  createLights,
  createSeatTray,
  createTable,
  type LightRig,
  type TableParts,
} from './table'
import { TumbleSimulation, type DieTarget } from './tumble'

/** Nominal edge length of one die, in world units. */
const DIE_SIZE = 1
const CAMERA_FOV = 36

/** The camera stays in front of the table, so a seat's dice never swap sides. */
const AZIMUTH_LIMIT = THREE.MathUtils.degToRad(52)
const TABLE_RADIUS_MIN = 2.6
const TABLE_RADIUS_MAX = 18
const ORBIT_TARGET = new THREE.Vector3(0, 0.35, 0)
const CAMERA_TWEEN_MS = 520

/** Named camera angles, exposed as buttons on the stage. */
export type CameraPreset = 'low' | 'default' | 'top'

/**
 * All three angles stay above ~34°, which is roughly where a label lying flat
 * on the felt stops being legible. A lower camera is a nice idea and a bad view.
 */
const PRESET_ELEVATION: Record<CameraPreset, number> = {
  low: THREE.MathUtils.degToRad(34),
  default: THREE.MathUtils.degToRad(48),
  top: THREE.MathUtils.degToRad(64),
}

/** Elevation range the player may orbit within, for the same reason. */
const ELEVATION_RANGE = { min: THREE.MathUtils.degToRad(30), max: THREE.MathUtils.degToRad(68) }

export interface DiceSceneOptions {
  canvas: HTMLCanvasElement
  container: HTMLElement
  /** Called once the dice have come to rest. */
  onSettle?: () => void
  /** Tray labels, so the seat names live with the rest of the copy. */
  labels?: { player: string; ai: string; shared: string }
}

export interface RollPayload {
  playerValues: number[]
  aiValues: number[]
  /** Keep the opponent's hand face-down until `revealAi()` is called. */
  hideAi: boolean
}

interface DieEntry {
  mesh: THREE.Mesh
  /** Face materials in `FACE_MATERIAL_ORDER`, kept for cheap re-assignment. */
  faceMaterials: THREE.Material[]
  seat: 'player' | 'ai'
  /** Resting height, so the reveal animation can offset from it. */
  baseY: number
}

/** Nudge a table-space point outward from the centre, as fit padding. */
function pushOut(point: THREE.Vector3, amount: number): THREE.Vector3 {
  const length = Math.hypot(point.x, point.z) || 1
  point.x *= (length + amount) / length
  point.z *= (length + amount) / length
  return point
}

function tableRadiusFor(layout: DiceLayout): number {
  // Keep the felt close to the dice so the camera can stay low and the dice
  // read large; a much wider table would shrink them for no benefit. The trays
  // must fit inside the felt too, which is what `trayReach` accounts for.
  const reach = Math.max(
    trayReach(layout.trays.player),
    layout.trays.ai ? trayReach(layout.trays.ai) : 0,
  )
  const required = Math.max(layout.extent.x, layout.extent.z * 0.95, reach + 0.3) + 0.7
  return THREE.MathUtils.clamp(required, TABLE_RADIUS_MIN, TABLE_RADIUS_MAX)
}

/**
 * The NDC window the fitted content must land in.
 *
 * HTML overlays sit along the top and bottom of the stage, so the fit works in
 * a band rather than a plain fill factor: every sample has to land inside it,
 * and the band is derived from the real overlay height in pixels.
 */
interface FitBand {
  xMin: number
  xMax: number
  yMin: number
  yMax: number
}

/**
 * Distance at which every sample point fits inside the camera frustum.
 *
 * Solved by iteration — project the samples, measure the worst overflow beyond
 * the band, rescale, repeat. It converges in a few passes and, unlike a
 * bounding-sphere approximation, stays correct for the flat oblique subject and
 * for portrait aspect ratios.
 */
function fitDistance(
  camera: THREE.PerspectiveCamera,
  target: THREE.Vector3,
  direction: THREE.Vector3,
  samples: THREE.Vector3[],
  band: FitBand,
): number {
  const projected = new THREE.Vector3()
  const halfX = (band.xMax - band.xMin) / 2 || 1
  const halfY = (band.yMax - band.yMin) / 2 || 1
  const centerX = (band.xMax + band.xMin) / 2
  const centerY = (band.yMax + band.yMin) / 2
  let distance = 12

  for (let pass = 0; pass < 10; pass += 1) {
    camera.position.copy(direction).multiplyScalar(distance).add(target)
    camera.lookAt(target)
    camera.updateMatrixWorld()

    let worst = 0
    for (const point of samples) {
      projected.copy(point).project(camera)
      const overflowX = (Math.abs(projected.x - centerX) - halfX) / halfX
      const overflowY = (Math.abs(projected.y - centerY) - halfY) / halfY
      worst = Math.max(worst, overflowX, overflowY)
    }
    if (worst <= 0.002) break

    const next = distance * (1 + worst)
    const settled = Math.abs(next - distance) < distance * 0.004
    distance = next
    if (settled) break
  }

  return distance
}

/**
 * Owns everything Three.js: renderer, camera, lights, table, dice and the roll
 * animation. React sends intent — "lay out N dice", "roll these values",
 * "reveal the hidden hand" — and renders plain DOM on top.
 */
export class DiceScene {
  private readonly container: HTMLElement
  private readonly onSettle: (() => void) | undefined
  private labels: { player: string; ai: string; shared: string }
  /** Last applied layout parameters, so `setLabels` can recompute trays only. */
  private lastCount = DICE_MIN
  private lastSeats: 1 | 2 = 1

  private readonly renderer: THREE.WebGLRenderer
  private readonly scene: THREE.Scene
  private readonly camera: THREE.PerspectiveCamera
  private readonly controls: OrbitControls
  private readonly environment: { texture: THREE.Texture; dispose: () => void }
  private lights: LightRig
  private table: TableParts
  private tableRadius: number

  private readonly trayGroup: THREE.Group
  private trayParts: Array<{ dispose: () => void }> = []

  private readonly geometry: RoundedBoxGeometry
  private readonly pipTextures: Map<number, THREE.Texture>
  private readonly faceMaterials: THREE.Material[]
  private readonly hiddenMaterial: THREE.Material

  private dice: DieEntry[] = []
  private layout: DiceLayout
  private readonly sim: TumbleSimulation

  private aiRevealed = true
  private revealElapsed = 0
  private revealActive = false

  private frameId = 0
  private lastTime = 0
  private dirty = true
  private reduceMotion = false
  private disposed = false

  /**
   * Height in pixels of the HTML chrome hugging the top and bottom of the
   * stage. The camera fits its content into whatever is left, which is how the
   * on-table console reserves its room without shrinking the canvas.
   */
  private insets = { top: 56, bottom: 84 }

  /** Camera fly-to state, used by the view preset buttons. */
  private tween: {
    fromPosition: THREE.Vector3
    toPosition: THREE.Vector3
    elapsed: number
    duration: number
  } | null = null

  private readonly resizeObserver: ResizeObserver
  private readonly onVisibilityChange: () => void

  /** Bound arrow property: safe to pass to add/removeEventListener. */
  private readonly markDirty = (): void => {
    this.dirty = true
  }

  constructor(options: DiceSceneOptions) {
    this.container = options.container
    this.onSettle = options.onSettle
    this.labels = options.labels ?? { player: '你', ai: '对手', shared: '骰子' }

    this.renderer = new THREE.WebGLRenderer({
      canvas: options.canvas,
      antialias: true,
      powerPreference: 'high-performance',
    })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFShadowMap
    // Shadows only change when the dice move, so the shadow pass is driven
    // manually rather than re-rendered on every frame. That halves the cost of
    // a static table, which matters a lot on integrated or software renderers.
    this.renderer.shadowMap.autoUpdate = false
    this.renderer.shadowMap.needsUpdate = true
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.06

    this.scene = new THREE.Scene()
    this.scene.background = new THREE.Color('#06090f')

    const elevation = PRESET_ELEVATION.default
    this.camera = new THREE.PerspectiveCamera(CAMERA_FOV, 1, 0.5, 400)
    this.camera.position.set(0, Math.sin(elevation) * 12, Math.cos(elevation) * 12)

    this.controls = new OrbitControls(this.camera, options.canvas)
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.075
    this.controls.enablePan = false
    this.controls.minPolarAngle = Math.PI / 2 - ELEVATION_RANGE.max
    this.controls.maxPolarAngle = Math.PI / 2 - ELEVATION_RANGE.min
    // Orbit is deliberately partial: enough to look around, never enough to put
    // the far seat in front of the near one. Losing track of whose dice are
    // whose was the single most confusing thing about the old table.
    this.controls.minAzimuthAngle = -AZIMUTH_LIMIT
    this.controls.maxAzimuthAngle = AZIMUTH_LIMIT
    this.controls.rotateSpeed = 0.55
    // Pinch-to-zoom fights the browser's own page zoom on touch devices, which
    // is why zoom is opt-in only for fine pointers.
    this.controls.enableZoom = window.matchMedia('(pointer: fine)').matches
    this.controls.zoomSpeed = 0.65
    this.controls.target.copy(ORBIT_TARGET)
    this.controls.addEventListener('change', this.markDirty)

    this.environment = createEnvironment(this.renderer)
    this.scene.environment = this.environment.texture
    this.scene.environmentIntensity = 0.34

    this.tableRadius = TABLE_RADIUS_MIN
    this.table = createTable(this.tableRadius)
    this.scene.add(this.table.group)

    this.trayGroup = new THREE.Group()
    this.scene.add(this.trayGroup)

    this.lights = createLights(this.tableRadius)
    this.scene.add(this.lights.group)

    this.geometry = new RoundedBoxGeometry(DIE_SIZE, DIE_SIZE, DIE_SIZE, 3, DIE_SIZE * 0.16)
    this.pipTextures = new Map()
    this.faceMaterials = FACE_MATERIAL_ORDER.map((face) => {
      const texture = createPipTexture(face)
      this.pipTextures.set(face, texture)
      return new THREE.MeshPhysicalMaterial({
        map: texture,
        roughness: 0.3,
        metalness: 0.02,
        clearcoat: 0.55,
        clearcoatRoughness: 0.26,
      })
    })
    this.hiddenMaterial = new THREE.MeshStandardMaterial({
      map: createHiddenTexture(),
      roughness: 0.42,
      metalness: 0.2,
      emissive: new THREE.Color('#2b1d66'),
      emissiveIntensity: 0.5,
    })

    this.layout = computeLayout({ count: DICE_MIN, seats: 1, dieSize: DIE_SIZE })
    this.sim = new TumbleSimulation({
      dieSize: DIE_SIZE,
      bound: { x: this.tableRadius, z: this.tableRadius },
      durationMs: ROLL_DURATION_MS,
      reducedMotion: false,
    })

    this.resizeObserver = new ResizeObserver(() => this.handleResize())
    this.resizeObserver.observe(this.container)
    this.onVisibilityChange = () => {
      this.lastTime = performance.now()
      // Browser tabs throttle timers and animation frames in the background, so
      // an in-flight roll cannot be relied on to finish while hidden. Land the
      // dice now: the phase machine and the table then agree on return.
      if (document.hidden && this.sim.running) {
        this.sim.finish()
        this.syncMeshes()
        this.onSettle?.()
      }
      this.markDirty()
    }
    document.addEventListener('visibilitychange', this.onVisibilityChange)

    this.setLayout(DICE_MIN, 1)
    this.lastTime = performance.now()
    this.frameId = requestAnimationFrame(this.tick)
  }

  // --------------------------------------------------------------- public API

  /** Rebuild the table, trays and dice for a new count / seat setup. */
  setLayout(count: number, seats: 1 | 2): void {
    const safeCount = THREE.MathUtils.clamp(Math.round(count), DICE_MIN, DICE_MAX)
    this.lastCount = safeCount
    this.lastSeats = seats
    this.layout = computeLayout({
      count: safeCount,
      seats,
      dieSize: DIE_SIZE,
      labels: this.labels,
    })

    const radius = tableRadiusFor(this.layout)
    if (Math.abs(radius - this.tableRadius) > 0.02) {
      this.scene.remove(this.table.group)
      this.table.dispose()
      this.scene.remove(this.lights.group)
      this.lights.dispose()

      this.tableRadius = radius
      this.table = createTable(radius)
      this.scene.add(this.table.group)
      this.lights = createLights(radius)
      this.scene.add(this.lights.group)
    }

    this.buildTrays()
    this.sim.setBound({ x: this.tableRadius, z: this.tableRadius })
    this.buildDice(safeCount, seats)
    this.fitCamera(false)
    this.markDirty()
  }

  /** Draw the labelled felt tray for each seat present on the table. */
  private buildTrays(): void {
    for (const part of this.trayParts) part.dispose()
    this.trayParts = []
    this.trayGroup.clear()

    const trays = [
      { tray: this.layout.trays.player, seat: 'player' as const },
      ...(this.layout.trays.ai ? [{ tray: this.layout.trays.ai, seat: 'ai' as const }] : []),
    ]

    for (const { tray, seat } of trays) {
      const { mesh, dispose } = createSeatTray({
        width: tray.width,
        depth: tray.depth,
        band: tray.band,
        label: tray.label,
        seat,
      })
      // The tray plane includes the label band along its far (−Z) edge, so
      // shifting back by half a band centres it on the dice block.
      mesh.position.set(tray.center.x, mesh.position.y, tray.center.z - tray.band / 2)
      this.trayGroup.add(mesh)
      this.trayParts.push({ dispose })
    }
  }

  /** Launch a roll that is guaranteed to terminate on the supplied values. */
  roll(payload: RollPayload): void {
    this.aiRevealed = !payload.hideAi
    this.revealActive = false
    this.revealElapsed = 0

    const targets: DieTarget[] = []
    let playerIndex = 0
    let aiIndex = 0

    // Targets must follow the same order as `this.dice` so the simulation
    // bodies line up with the meshes in `syncMeshes`.
    for (const die of this.dice) {
      const isPlayer = die.seat === 'player'
      const value = isPlayer ? payload.playerValues[playerIndex] : payload.aiValues[aiIndex]
      const slot = isPlayer ? this.layout.player[playerIndex] : this.layout.ai[aiIndex]
      if (isPlayer) playerIndex += 1
      else aiIndex += 1
      if (value !== undefined && slot) targets.push({ slot, value })
    }

    const concealed = payload.hideAi
    for (const die of this.dice) {
      const hide = concealed && die.seat === 'ai'
      die.mesh.material = hide ? this.hiddenMaterial : die.faceMaterials
    }

    this.sim.setDuration(this.reduceMotion ? 1 : ROLL_DURATION_MS)
    this.sim.reset(targets)
    this.syncMeshes()
    this.markDirty()
  }

  /** Flip the concealed hand face-up with a short lift-and-settle animation. */
  revealAi(animate = true): void {
    if (this.aiRevealed) return
    this.aiRevealed = true

    for (const die of this.dice) {
      if (die.seat === 'ai') die.mesh.material = die.faceMaterials
    }

    if (!animate || this.reduceMotion) {
      for (const die of this.dice) {
        if (die.seat !== 'ai') continue
        die.mesh.scale.setScalar(1)
        die.mesh.position.y = die.baseY
      }
      this.markDirty()
      return
    }

    this.revealElapsed = 0
    this.revealActive = true
    this.markDirty()
  }

  /** Re-point the tray labels (language switch) without touching the dice. */
  setLabels(labels: { player: string; ai: string; shared: string }): void {
    this.labels = labels
    this.layout = computeLayout({
      count: this.lastCount,
      seats: this.lastSeats,
      dieSize: DIE_SIZE,
      labels,
    })
    this.buildTrays()
    this.markDirty()
  }

  setReducedMotion(value: boolean): void {
    this.reduceMotion = value
    this.sim.setReducedMotion(value)
  }

  /**
   * Tell the scene how tall the stage's HTML chrome is, in pixels, so the next
   * fit keeps the dice clear of it. Refits only when the numbers actually move.
   */
  setOverlayInsets(insets: { top: number; bottom: number }): void {
    const top = Math.max(0, Math.round(insets.top))
    const bottom = Math.max(0, Math.round(insets.bottom))
    if (top === this.insets.top && bottom === this.insets.bottom) return
    this.insets = { top, bottom }
    this.fitCamera(true)
    this.markDirty()
  }

  /**
   * Shift the projection so the table centres in the space the overlays leave,
   * instead of in the middle of the whole stage. The orbit target stays put —
   * it is the pivot the player rotates around — so this has to happen in the
   * projection, via three's view offset.
   */
  private applyViewOffset(): void {
    const width = this.container.clientWidth || 1
    const height = this.container.clientHeight || 1
    const extra = this.insets.bottom - this.insets.top

    if (extra === 0) {
      this.camera.clearViewOffset()
    } else if (extra > 0) {
      // More chrome below: show the bottom slice of a taller virtual frame.
      this.camera.setViewOffset(width, height + extra, 0, extra, width, height)
    } else {
      // More chrome above: show the top slice.
      this.camera.setViewOffset(width, height - extra, 0, 0, width, height)
    }
  }

  /**
   * Fly the camera to a named angle. Presets exist so looking around never
   * requires a drag — which is what made the table feel unresponsive on touch,
   * where a drag could equally have been a page scroll.
   */
  setView(preset: CameraPreset): void {
    const elevation = PRESET_ELEVATION[preset]
    const distance = this.camera.position.distanceTo(ORBIT_TARGET) || 12
    const direction = new THREE.Vector3(0, Math.sin(elevation), Math.cos(elevation))

    this.tween = {
      fromPosition: this.camera.position.clone(),
      toPosition: direction.multiplyScalar(distance).add(ORBIT_TARGET),
      elapsed: 0,
      duration: this.reduceMotion ? 1 : CAMERA_TWEEN_MS,
    }
    this.controls.enabled = false
    this.markDirty()
  }

  /** True while the camera is flying to a preset. */
  get isMovingCamera(): boolean {
    return this.tween !== null
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true

    cancelAnimationFrame(this.frameId)
    this.resizeObserver.disconnect()
    document.removeEventListener('visibilitychange', this.onVisibilityChange)
    this.controls.removeEventListener('change', this.markDirty)
    this.controls.dispose()

    for (const die of this.dice) this.scene.remove(die.mesh)
    this.dice = []
    for (const part of this.trayParts) part.dispose()
    this.trayParts = []
    this.trayGroup.clear()

    this.geometry.dispose()
    this.pipTextures.forEach((texture) => texture.dispose())
    this.faceMaterials.forEach((material) => material.dispose())
    this.hiddenMaterial.dispose()

    this.table.dispose()
    this.lights.dispose()
    this.environment.dispose()
    this.renderer.dispose()
  }

  // ----------------------------------------------------------------- internals

  private buildDice(count: number, seats: 1 | 2): void {
    for (const die of this.dice) this.scene.remove(die.mesh)
    this.dice = []

    const total = seats === 2 ? count * 2 : count

    for (let index = 0; index < total; index += 1) {
      const seat: 'player' | 'ai' = seats === 2 && index >= count ? 'ai' : 'player'
      const slot = seat === 'player' ? this.layout.player[index] : this.layout.ai[index - count]
      if (!slot) continue

      const faceMaterials = [...this.faceMaterials]
      const mesh = new THREE.Mesh(this.geometry, faceMaterials)
      mesh.castShadow = true
      mesh.receiveShadow = true
      mesh.position.copy(slot.position)
      this.scene.add(mesh)

      this.dice.push({ mesh, faceMaterials, seat, baseY: slot.position.y })
    }
  }

  /** Copy simulated transforms onto the meshes. */
  private syncMeshes(): void {
    const bodies = this.sim.bodies
    this.dice.forEach((die, index) => {
      const body = bodies[index]
      if (!body) return
      die.mesh.position.copy(body.position)
      die.mesh.quaternion.copy(body.quaternion)
    })
  }

  private handleResize(): void {
    const width = this.container.clientWidth
    const height = this.container.clientHeight
    if (width === 0 || height === 0) return

    this.renderer.setSize(width, height, false)
    this.camera.aspect = width / height
    this.camera.updateProjectionMatrix()
    this.fitCamera(true)
    this.markDirty()
  }

  /**
   * Pull the camera back far enough to hold the whole table, optionally keeping
   * whichever direction the player has orbited to.
   */
  private fitCamera(preserveDirection: boolean): void {
    this.applyViewOffset()
    if (!preserveDirection) {
      const elevation = PRESET_ELEVATION.default
      this.camera.position.set(0, Math.sin(elevation) * 12, Math.cos(elevation) * 12)
    }

    const samples: THREE.Vector3[] = []
    // Fit against the dice and the felt trays, padded a little for shadows.
    // The outer felt is deliberately absent from this list: it runs past the
    // frame, which reads as a close-up on the action rather than a floating
    // disc that has to be shrunk to fit.
    for (const slot of [...this.layout.player, ...this.layout.ai]) {
      samples.push(pushOut(slot.position.clone().setY(DIE_SIZE), DIE_SIZE * 1.1))
    }
    const trays = [this.layout.trays.player, ...(this.layout.trays.ai ? [this.layout.trays.ai] : [])]
    for (const tray of trays) {
      for (const point of trayOutlinePoints(tray, 28)) samples.push(pushOut(point, 0.55))
    }

    const direction = this.camera.position.clone().sub(ORBIT_TARGET)
    if (direction.lengthSq() < 1e-6) {
      direction.set(0, Math.sin(PRESET_ELEVATION.default), Math.cos(PRESET_ELEVATION.default))
    }
    direction.normalize()

    // The overlays eat different amounts of the top and bottom edges, so the
    // dice should not be centred in the frame — they belong in the middle of
    // whatever is left. Shifting the projection (not the orbit target, which
    // must stay the pivot) does exactly that: render the bottom slice of a
    // taller virtual frame and the table rides above the console.
    const width = this.container.clientWidth || 1
    const height = this.container.clientHeight || 1
    const extra = this.insets.bottom - this.insets.top
    if (extra === 0) this.camera.clearViewOffset()
    else if (extra > 0) this.camera.setViewOffset(width, height + extra, 0, extra, width, height)
    else this.camera.setViewOffset(width, height - extra, 0, 0, width, height)

    // With the offset applied the content centres at NDC `extra / height`, and
    // the free vertical space between the two overlays is the band it must fit.
    const halfNdc = Math.max(0.08, (height - this.insets.top - this.insets.bottom) / height)
    const band: FitBand = {
      xMin: -0.96,
      xMax: 0.96,
      yMin: extra / height - halfNdc,
      yMax: extra / height + halfNdc,
    }

    const distance = fitDistance(this.camera, ORBIT_TARGET, direction, samples, band)
    this.camera.position.copy(direction).multiplyScalar(distance).add(ORBIT_TARGET)
    this.controls.target.copy(ORBIT_TARGET)
    this.controls.minDistance = distance * 0.5
    this.controls.maxDistance = distance * 1.8
    this.camera.lookAt(ORBIT_TARGET)
    this.controls.update()
    this.markDirty()
  }

  private readonly tick = (time: number): void => {
    if (this.disposed) return
    this.frameId = requestAnimationFrame(this.tick)

    const delta = Math.min(time - this.lastTime, 250)
    this.lastTime = time

    if (document.hidden) return

    if (this.sim.running) {
      this.sim.step(delta)
      this.syncMeshes()
      this.renderer.shadowMap.needsUpdate = true
      this.dirty = true
      if (!this.sim.running) this.onSettle?.()
    }

    if (this.revealActive) {
      this.revealElapsed += delta
      const t = THREE.MathUtils.clamp(this.revealElapsed / REVEAL_DURATION_MS, 0, 1)
      const lift = Math.sin(Math.PI * t) * 0.42
      const pop = 1 + Math.sin(Math.PI * t) * 0.1
      for (const die of this.dice) {
        if (die.seat !== 'ai') continue
        die.mesh.position.y = die.baseY + lift
        die.mesh.scale.setScalar(pop)
      }
      this.renderer.shadowMap.needsUpdate = true
      this.dirty = true
      if (t >= 1) {
        this.revealActive = false
        for (const die of this.dice) {
          if (die.seat !== 'ai') continue
          die.mesh.position.y = die.baseY
          die.mesh.scale.setScalar(1)
        }
      }
    }

    if (this.tween) {
      this.tween.elapsed += delta
      const t = THREE.MathUtils.clamp(this.tween.elapsed / this.tween.duration, 0, 1)
      // Ease in-out cubic: a snappy start, a soft landing.
      const eased = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2
      this.camera.position.lerpVectors(this.tween.fromPosition, this.tween.toPosition, eased)
      this.camera.lookAt(ORBIT_TARGET)
      this.dirty = true

      if (t >= 1) {
        this.tween = null
        this.controls.enabled = true
        this.controls.update()
      }
    } else {
      this.controls.update()
    }

    if (this.dirty) {
      this.renderer.render(this.scene, this.camera)
      this.dirty = false
    }
  }

}
