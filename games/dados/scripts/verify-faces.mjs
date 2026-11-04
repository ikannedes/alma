/**
 * Verifies the one mapping that cannot be checked by looking at the screen:
 * that snapping face `v` to the top really puts `v`'s texture on the top slot
 * of the geometry, and that opposite faces still sum to 7.
 *
 * Loads the real modules through Vite's resolver, so it exercises exactly the
 * code the app ships with. Run with: npm run verify:faces
 */
import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import { createServer } from 'vite'

/** Material-slot order three.js gives every BoxGeometry. */
const SLOT_NORMALS = [
  new THREE.Vector3(1, 0, 0), // 0: +X
  new THREE.Vector3(-1, 0, 0), // 1: -X
  new THREE.Vector3(0, 1, 0), // 2: +Y
  new THREE.Vector3(0, -1, 0), // 3: -Y
  new THREE.Vector3(0, 0, 1), // 4: +Z
  new THREE.Vector3(0, 0, -1), // 5: -Z
]

let failures = 0
const check = (label, ok, detail) => {
  if (!ok) failures += 1
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? '  -> ' + detail : ''))
}

const server = await createServer({
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'warn',
})

try {
  const { FACE_MATERIAL_ORDER, quaternionForFaceUp } = await server.ssrLoadModule(
    '/src/three/diceFace.ts',
  )

  // 1. Opposite faces must sum to 7, as on a real die.
  for (let slot = 0; slot < 6; slot += 1) {
    const opposite = slot % 2 === 0 ? slot + 1 : slot - 1
    const sum = FACE_MATERIAL_ORDER[slot] + FACE_MATERIAL_ORDER[opposite]
    check(`slot ${slot} + ${opposite} sum to 7`, sum === 7, `got ${sum}`)
  }

  // 2. All six values present exactly once.
  check('six distinct values', new Set(FACE_MATERIAL_ORDER).size === 6, FACE_MATERIAL_ORDER.join(','))

  // 3. Snapping face v up must land slot(v) on +Y, for any spin.
  for (let face = 1; face <= 6; face += 1) {
    for (const spin of [0, 0.9, 2.4, 5.1]) {
      const quaternion = quaternionForFaceUp(face, spin)
      const slot = FACE_MATERIAL_ORDER.indexOf(face)
      const rotated = SLOT_NORMALS[slot].clone().applyQuaternion(quaternion)
      check(
        `face ${face} up at spin ${spin}`,
        Math.abs(rotated.y - 1) < 1e-6,
        '(' + rotated.x.toFixed(3) + ', ' + rotated.y.toFixed(3) + ', ' + rotated.z.toFixed(3) + ')',
      )
    }
  }

  // 4. Exactly one face points up after a snap, and four sides stay level.
  {
    const quaternion = quaternionForFaceUp(3, 1.234)
    const vertical = SLOT_NORMALS.map((normal) => normal.clone().applyQuaternion(quaternion))
    const upCount = vertical.filter((normal) => normal.y > 0.999).length
    const flatCount = vertical.filter((normal) => Math.abs(normal.y) < 1e-6).length
    check('exactly one face up', upCount === 1, 'up=' + upCount)
    check('four side faces level', flatCount === 4, 'level=' + flatCount)
  }

  // 5. The rounded geometry really does expose six slots covering every vertex.
  {
    const geometry = new RoundedBoxGeometry(1, 1, 1, 3, 0.16)
    check('six material groups', geometry.groups.length === 6, 'groups=' + geometry.groups.length)
    const total = geometry.attributes.position.count
    const covered = geometry.groups.reduce((sum, group) => sum + group.count, 0)
    check('groups cover every vertex', covered === total, covered + ' vs ' + total)
    geometry.dispose()
  }
} finally {
  await server.close()
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : '\n' + failures + ' CHECK(S) FAILED')
process.exit(failures === 0 ? 0 : 1)
