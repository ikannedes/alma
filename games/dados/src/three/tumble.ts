import * as THREE from 'three'
import { randomFloat } from '../lib/dice'
import { quaternionForFaceUp } from './diceFace'
import type { DiceSlot } from './layout'

/** One die's motion state. */
export interface DieBody {
  /** Chaotic integration state — never read directly by the renderer. */
  chaosPosition: THREE.Vector3
  chaosQuaternion: THREE.Quaternion
  velocity: THREE.Vector3
  /** Angular velocity in rad/s, applied about its own axis. */
  spin: THREE.Vector3

  /** Blended transform the renderer reads. */
  position: THREE.Vector3
  quaternion: THREE.Quaternion

  /** Rest pose. */
  targetPosition: THREE.Vector3
  targetQuaternion: THREE.Quaternion

  /** Fraction of the roll this die waits before it starts moving. */
  delay: number
  settled: boolean
}

/** A die's final destination: where it rests and which face ends up on top. */
export interface DieTarget {
  slot: DiceSlot
  value: number
}

export interface TumbleOptions {
  dieSize: number
  /** Half-extents of the playable area, so dice stay on the table. */
  bound: { x: number; z: number }
  durationMs: number
  reducedMotion: boolean
}

/**
 * Fraction of the roll spent tumbling freely. Past this point the die eases
 * into its rest pose, which guarantees a readable, on-the-table result.
 */
const TUMBLE_PHASE = 0.52

const GRAVITY = 32
const RESTITUTION = 0.44
const FLOOR_FRICTION = 0.78
const WALL_RESTITUTION = 0.55
const AIR_DRAG = 0.6
const SPIN_DRAG = 1.6
const REST_SPEED = 1.1

const _axis = new THREE.Vector3()
const _delta = new THREE.Quaternion()

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = THREE.MathUtils.clamp((value - edge0) / (edge1 - edge0), 0, 1)
  return t * t * (3 - 2 * t)
}

/**
 * Drives every die through a roll.
 *
 * Phase 1 integrates a lightweight rigid-body approximation — gravity, floor
 * and wall bounces, friction and spin damping — so the dice genuinely scatter.
 * Phase 2 blends each die from that chaotic state into an exact rest pose, so
 * the face the game reports is always the face the player can read.
 */
export class TumbleSimulation {
  readonly bodies: DieBody[] = []

  progress = 0
  running = false

  private elapsedMs = 0
  private durationMs: number
  private reducedMotion: boolean
  private dieSize: number
  private bound: { x: number; z: number }

  constructor(options: TumbleOptions) {
    this.dieSize = options.dieSize
    this.bound = options.bound
    this.durationMs = options.durationMs
    this.reducedMotion = options.reducedMotion
  }

  /** Resize the table area without disturbing an in-flight roll. */
  setBound(bound: { x: number; z: number }): void {
    this.bound = bound
  }

  setReducedMotion(value: boolean): void {
    this.reducedMotion = value
  }

  setDuration(durationMs: number): void {
    this.durationMs = durationMs
  }

  /** Point the simulation at a new set of dice and rest poses. */
  reset(targets: DieTarget[]): void {
    this.bodies.length = 0
    this.elapsedMs = 0
    this.progress = 0

    targets.forEach((target, index) => {
      const angle = targets.length > 1 ? randomFloat(0, Math.PI * 2) : 0
      const spread = this.dieSize * 1.6
      const startX = THREE.MathUtils.clamp(
        Math.cos(angle) * spread * randomFloat(0.2, 1),
        -this.bound.x + this.dieSize,
        this.bound.x - this.dieSize,
      )
      const startZ = THREE.MathUtils.clamp(
        Math.sin(angle) * spread * randomFloat(0.2, 1),
        -this.bound.z + this.dieSize,
        this.bound.z - this.dieSize,
      )

      const body: DieBody = {
        chaosPosition: new THREE.Vector3(startX, this.dieSize * randomFloat(5.5, 8.5), startZ),
        chaosQuaternion: new THREE.Quaternion().setFromEuler(
          new THREE.Euler(randomFloat(0, 6.28), randomFloat(0, 6.28), randomFloat(0, 6.28)),
        ),
        velocity: new THREE.Vector3(randomFloat(-4, 4), randomFloat(-7, -3), randomFloat(-4, 4)),
        spin: new THREE.Vector3(randomFloat(-14, 14), randomFloat(-14, 14), randomFloat(-14, 14)),
        position: new THREE.Vector3(),
        quaternion: new THREE.Quaternion(),
        targetPosition: target.slot.position.clone(),
        targetQuaternion: quaternionForFaceUp(target.value, target.slot.spinY),
        delay: targets.length > 1 ? (index / targets.length) * 0.16 : 0,
        settled: false,
      }

      if (this.reducedMotion) {
        body.chaosPosition.copy(body.targetPosition)
        body.chaosQuaternion.copy(body.targetQuaternion)
        body.position.copy(body.targetPosition)
        body.quaternion.copy(body.targetQuaternion)
        body.settled = true
      } else {
        body.position.copy(body.chaosPosition)
        body.quaternion.copy(body.chaosQuaternion)
      }

      this.bodies.push(body)
    })

    this.running = !this.reducedMotion && this.bodies.length > 0
    if (!this.running) this.progress = 1
  }

  get finished(): boolean {
    return !this.running
  }

  /**
   * Jump straight to the end of the roll: every die lands exactly on its rest
   * pose. Used when the table goes out of sight mid-roll, so the dice and the
   * game state never disagree.
   */
  finish(): void {
    if (!this.running) return
    this.elapsedMs = this.durationMs
    this.progress = 1
    for (const body of this.bodies) {
      body.position.copy(body.targetPosition)
      body.quaternion.copy(body.targetQuaternion)
      body.settled = true
    }
    this.running = false
  }

  /** Advance the roll. Safe to call every frame, including once settled. */
  step(deltaMs: number): void {
    if (!this.running) return

    // Progress tracks wall-clock time, so a roll always lasts as long as
    // advertised even if the frame rate collapses (software rendering, heavy
    // scenes). Physics is sub-stepped separately to stay stable.
    const elapsedDelta = Math.min(deltaMs, 250)
    this.elapsedMs += elapsedDelta
    this.progress = THREE.MathUtils.clamp(this.elapsedMs / this.durationMs, 0, 1)

    const physicsDelta = Math.min(elapsedDelta, 64) / 1000

    for (const body of this.bodies) {
      const dieDuration = this.durationMs * (1 - body.delay)
      const local = THREE.MathUtils.clamp(
        (this.elapsedMs - this.durationMs * body.delay) / dieDuration,
        0,
        1,
      )

      if (local < 1) this.integrateStepped(body, physicsDelta)

      const blend = smoothstep(TUMBLE_PHASE, 1, local)
      body.position.lerpVectors(body.chaosPosition, body.targetPosition, blend)
      body.quaternion.copy(body.chaosQuaternion).slerp(body.targetQuaternion, blend)

      if (local >= 1) {
        body.position.copy(body.targetPosition)
        body.quaternion.copy(body.targetQuaternion)
        body.settled = true
      }
    }

    if (this.elapsedMs >= this.durationMs) {
      this.running = false
      this.progress = 1
    }
  }

  /**
   * Integrate in fixed-ish sub-steps. A single large step would tunnel dice
   * through the table or the walls; splitting keeps bounces believable at any
   * frame rate.
   */
  private integrateStepped(body: DieBody, dt: number): void {
    const maxStep = 1 / 60
    const steps = Math.min(8, Math.max(1, Math.ceil(dt / maxStep)))
    const sub = dt / steps
    for (let step = 0; step < steps; step += 1) this.integrate(body, sub)
  }

  /** Free-tumble integration for one die. */
  private integrate(body: DieBody, dt: number): void {
    const radius = this.dieSize / 2

    body.velocity.y -= GRAVITY * dt

    const drag = Math.exp(-AIR_DRAG * dt)
    body.velocity.x *= drag
    body.velocity.z *= drag

    body.chaosPosition.addScaledVector(body.velocity, dt)

    const angularSpeed = body.spin.length()
    if (angularSpeed > 1e-4) {
      _axis.copy(body.spin).divideScalar(angularSpeed)
      _delta.setFromAxisAngle(_axis, angularSpeed * dt)
      body.chaosQuaternion.premultiply(_delta).normalize()
      body.spin.multiplyScalar(Math.exp(-SPIN_DRAG * dt))
    }

    // Floor: bounce and bleed energy until the die is rolling.
    if (body.chaosPosition.y < radius) {
      body.chaosPosition.y = radius
      if (body.velocity.y < 0) {
        body.velocity.y = -body.velocity.y * RESTITUTION
        body.velocity.x *= FLOOR_FRICTION
        body.velocity.z *= FLOOR_FRICTION
        body.spin.multiplyScalar(0.8)
        if (body.velocity.y < REST_SPEED) body.velocity.y = 0
      }
      body.spin.multiplyScalar(Math.exp(-0.9 * dt))
    }

    // Walls: keep every die on the felt.
    const limitX = Math.max(radius, this.bound.x - radius)
    if (Math.abs(body.chaosPosition.x) > limitX) {
      body.chaosPosition.x = Math.sign(body.chaosPosition.x) * limitX
      body.velocity.x = -body.velocity.x * WALL_RESTITUTION
      body.spin.multiplyScalar(0.85)
    }

    const limitZ = Math.max(radius, this.bound.z - radius)
    if (Math.abs(body.chaosPosition.z) > limitZ) {
      body.chaosPosition.z = Math.sign(body.chaosPosition.z) * limitZ
      body.velocity.z = -body.velocity.z * WALL_RESTITUTION
      body.spin.multiplyScalar(0.85)
    }
  }
}
