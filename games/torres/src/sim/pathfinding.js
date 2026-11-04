import {
  ARENA_LENGTH_MILLITILES,
  ARENA_MILLITILES_PER_TILE,
  ARENA_WIDTH_MILLITILES,
  isGroundStaticallyBlocked,
  isPointInArena,
  rotateArenaPoint180,
  validateArenaPoint,
} from "./arena-geometry.js";

/**
 * Coarse, deterministic point-agent navigation graph.
 *
 * Nodes are the centers of the arena's 18 by 32 tiles. This is deliberately
 * not a collision-authoritative model: unit radius, footprint edge
 * calibration, crowding, and continuous steering belong to later pieces. The
 * estimated half-open arena obstacles are conservatively mirrored into the
 * navigation mask so graph legality and path length are exactly 180-degree
 * symmetric.
 */
export const GROUND_PATH_GRID_STEP_MILLITILES = ARENA_MILLITILES_PER_TILE;
const GROUND_PATH_GRID_ORIGIN_MILLITILES =
  GROUND_PATH_GRID_STEP_MILLITILES / 2;

// Fixed order is part of the deterministic contract. West wins a fully equal
// lane choice; no object, Set, or Map iteration chooses a predecessor.
const NEIGHBOR_OFFSETS = Object.freeze([
  Object.freeze({ dx: -GROUND_PATH_GRID_STEP_MILLITILES, dy: 0 }),
  Object.freeze({ dx: 0, dy: GROUND_PATH_GRID_STEP_MILLITILES }),
  Object.freeze({ dx: GROUND_PATH_GRID_STEP_MILLITILES, dy: 0 }),
  Object.freeze({ dx: 0, dy: -GROUND_PATH_GRID_STEP_MILLITILES }),
]);

const COLUMN_COUNT =
  ARENA_WIDTH_MILLITILES / GROUND_PATH_GRID_STEP_MILLITILES;
const ROW_COUNT =
  ARENA_LENGTH_MILLITILES / GROUND_PATH_GRID_STEP_MILLITILES;
const NODE_COUNT = COLUMN_COUNT * ROW_COUNT;

function isOnNavigationLattice(point) {
  return (
    (point.x - GROUND_PATH_GRID_ORIGIN_MILLITILES) %
      GROUND_PATH_GRID_STEP_MILLITILES ===
      0 &&
    (point.y - GROUND_PATH_GRID_ORIGIN_MILLITILES) %
      GROUND_PATH_GRID_STEP_MILLITILES ===
      0
  );
}

function hasSymmetricStaticClearance(point) {
  return (
    !isGroundStaticallyBlocked(point) &&
    !isGroundStaticallyBlocked(rotateArenaPoint180(point))
  );
}

/**
 * Reports whether a point is a legal node in the coarse ground graph.
 * Malformed point data is rejected by the arena-geometry validator.
 */
export function isGroundNavigationNode(value) {
  const point = validateArenaPoint(value, "ground navigation point");
  return (
    isPointInArena(point) &&
    isOnNavigationLattice(point) &&
    hasSymmetricStaticClearance(point)
  );
}

function assertEndpoint(value, label) {
  const point = validateArenaPoint(value, label);
  if (!isPointInArena(point)) {
    throw new RangeError(`${label} must be inside the arena`);
  }
  if (!isOnNavigationLattice(point)) {
    throw new RangeError(
      `${label} must be on the ${GROUND_PATH_GRID_STEP_MILLITILES}-millitile navigation lattice`,
    );
  }
  if (!hasSymmetricStaticClearance(point)) {
    throw new RangeError(`${label} is blocked in the coarse ground graph`);
  }
  return point;
}

function pointToIndex(point) {
  return (
    ((point.y - GROUND_PATH_GRID_ORIGIN_MILLITILES) /
      GROUND_PATH_GRID_STEP_MILLITILES) *
      COLUMN_COUNT +
    (point.x - GROUND_PATH_GRID_ORIGIN_MILLITILES) /
      GROUND_PATH_GRID_STEP_MILLITILES
  );
}

function indexToPoint(index) {
  return {
    x:
      GROUND_PATH_GRID_ORIGIN_MILLITILES +
      (index % COLUMN_COUNT) * GROUND_PATH_GRID_STEP_MILLITILES,
    y:
      GROUND_PATH_GRID_ORIGIN_MILLITILES +
      Math.floor(index / COLUMN_COUNT) *
        GROUND_PATH_GRID_STEP_MILLITILES,
  };
}

function isClearSegment(from, to) {
  // All obstacle edges use whole- or half-tile coordinates. On this one-tile
  // axis-aligned graph, endpoint and midpoint checks cover every interval
  // created by those edges. Mirroring preserves the same guarantee on rotate.
  const midpoint = {
    x: (from.x + to.x) / 2,
    y: (from.y + to.y) / 2,
  };
  return hasSymmetricStaticClearance(midpoint);
}

function reconstructPath(predecessor, endIndex) {
  const reversed = [];
  let index = endIndex;
  while (index !== -1) {
    reversed.push(indexToPoint(index));
    index = predecessor[index];
  }
  reversed.reverse();
  return reversed;
}

/**
 * Finds a shortest coarse ground route.
 *
 * Returns a fresh JSON array of millitile waypoints, or null if the legal
 * graph contains no route. Invalid, off-grid, outside, and blocked endpoints
 * throw explicit errors instead of being silently snapped. Breadth-first
 * search plus NEIGHBOR_OFFSETS gives stable byte-identical tie breaking.
 */
export function findGroundPath(startValue, endValue) {
  const start = assertEndpoint(startValue, "ground path start");
  const end = assertEndpoint(endValue, "ground path end");
  const startIndex = pointToIndex(start);
  const endIndex = pointToIndex(end);

  const predecessor = new Int32Array(NODE_COUNT);
  predecessor.fill(-2);
  predecessor[startIndex] = -1;

  const queue = new Int32Array(NODE_COUNT);
  let queueRead = 0;
  let queueWrite = 0;
  queue[queueWrite] = startIndex;
  queueWrite += 1;

  while (queueRead < queueWrite) {
    const currentIndex = queue[queueRead];
    queueRead += 1;
    if (currentIndex === endIndex) {
      return reconstructPath(predecessor, endIndex);
    }

    const current = indexToPoint(currentIndex);
    for (let offsetIndex = 0; offsetIndex < NEIGHBOR_OFFSETS.length; offsetIndex += 1) {
      const offset = NEIGHBOR_OFFSETS[offsetIndex];
      const candidate = {
        x: current.x + offset.dx,
        y: current.y + offset.dy,
      };
      if (!isPointInArena(candidate) || !isOnNavigationLattice(candidate)) {
        continue;
      }
      const candidateIndex = pointToIndex(candidate);
      if (
        predecessor[candidateIndex] !== -2 ||
        !hasSymmetricStaticClearance(candidate) ||
        !isClearSegment(current, candidate)
      ) {
        continue;
      }
      predecessor[candidateIndex] = currentIndex;
      queue[queueWrite] = candidateIndex;
      queueWrite += 1;
    }
  }

  return null;
}
