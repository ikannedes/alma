import * as THREE from 'three'
import { FACE_MAX, FACE_MIN } from '../lib/constants'

/**
 * Value assigned to each `BoxGeometry` material slot.
 *
 * Slot order is fixed by three.js (`+X, -X, +Y, -Y, +Z, -Z`) and verified against
 * `RoundedBoxGeometry`, which preserves the six groups after becoming
 * non-indexed. Opposite faces are arranged to sum to 7, as on a real die.
 */
export const FACE_MATERIAL_ORDER = [1, 6, 2, 5, 3, 4] as const

/** Outward normal of every face, in the die's local frame. */
const FACE_NORMALS: Record<number, THREE.Vector3> = {
  1: new THREE.Vector3(1, 0, 0),
  6: new THREE.Vector3(-1, 0, 0),
  2: new THREE.Vector3(0, 1, 0),
  5: new THREE.Vector3(0, -1, 0),
  3: new THREE.Vector3(0, 0, 1),
  4: new THREE.Vector3(0, 0, -1),
}

const UP = new THREE.Vector3(0, 1, 0)

const _faceRotation = new THREE.Quaternion()
const _spin = new THREE.Quaternion()
const _normal = new THREE.Vector3()

/**
 * Rotation that brings `face` to point straight up.
 *
 * Any face can be brought to the top; the additional rotation around Y keeps
 * results varied. Pip layouts are invariant under 180°/mirrored rotations, so
 * the free spin never makes a face read as a different value.
 */
export function quaternionForFaceUp(face: number, spinY: number): THREE.Quaternion {
  _normal.copy(FACE_NORMALS[face]).normalize()
  _faceRotation.setFromUnitVectors(_normal, UP)
  _spin.setFromAxisAngle(UP, spinY)
  return _spin.clone().multiply(_faceRotation)
}

/** Snap a die to show `face` on top, offset by a random spin. */
export function applyFaceUp(target: THREE.Object3D, face: number, spinY: number): void {
  target.quaternion.copy(quaternionForFaceUp(face, spinY))
}

/** Every legal face value. */
export function allFaces(): number[] {
  const faces: number[] = []
  for (let face = FACE_MIN; face <= FACE_MAX; face += 1) faces.push(face)
  return faces
}
