import {
  ARENA_LENGTH_MILLITILES,
  ARENA_WIDTH_MILLITILES,
  getArenaGeometry,
  isPointInArena,
  validateArenaPoint,
} from "./arena-geometry.js";

const SIDES = new Set(["south", "north"]);
const PLACEMENT_CLASSES = new Set(["ground_entity", "global_effect"]);
const LANES = new Set(["west", "east"]);

// Exact placement cells have not been calibrated from footage. All rectangles
// in this table are therefore deterministic estimates, isolated from the
// high-confidence qualitative rules implemented below.
const ESTIMATED_DEPLOYMENT_MASK = Object.freeze({
  edgeInset: 500,
  kingBehindStrips: Object.freeze({
    south: Object.freeze({
      minX: 7_000, maxX: 11_000, minY: 0, maxY: 1_000,
    }),
    north: Object.freeze({
      minX: 7_000, maxX: 11_000, minY: 31_000, maxY: 32_000,
    }),
  }),
  forwardPockets: Object.freeze({
    south: Object.freeze({
      west: Object.freeze({
        minX: 500, maxX: 9_000, minY: 17_000, maxY: 23_000,
      }),
      east: Object.freeze({
        minX: 9_000, maxX: 17_500, minY: 17_000, maxY: 23_000,
      }),
    }),
    north: Object.freeze({
      west: Object.freeze({
        minX: 500, maxX: 9_000, minY: 9_000, maxY: 15_000,
      }),
      east: Object.freeze({
        minX: 9_000, maxX: 17_500, minY: 9_000, maxY: 15_000,
      }),
    }),
  }),
});

function assertPlainDataObject(value, keys, label) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null) ||
    Object.getOwnPropertySymbols(value).length !== 0
  ) {
    throw new TypeError(`${label} must be a plain string-keyed data object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const actual = Object.keys(descriptors).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new TypeError(`${label} has an invalid shape`);
  }
  for (const key of actual) {
    const descriptor = descriptors[key];
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
      throw new TypeError(`${label}.${key} must be an enumerable data property`);
    }
  }
  return descriptors;
}

function validateDestroyedLanes(value) {
  if (!Array.isArray(value) || Object.getOwnPropertySymbols(value).length !== 0) {
    throw new TypeError("destroyedOpposingLaneTowers must be an array");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const length = descriptors.length;
  if (
    !length ||
    !Object.hasOwn(length, "value") ||
    !Number.isSafeInteger(length.value) ||
    length.value < 0 ||
    length.value > 2
  ) {
    throw new TypeError(
      "destroyedOpposingLaneTowers must contain at most two lanes",
    );
  }
  const lanes = [];
  for (let index = 0; index < length.value; index += 1) {
    const descriptor = descriptors[String(index)];
    if (
      !descriptor ||
      !descriptor.enumerable ||
      !Object.hasOwn(descriptor, "value") ||
      !LANES.has(descriptor.value)
    ) {
      throw new TypeError(
        "destroyedOpposingLaneTowers entries must be west or east data values",
      );
    }
    lanes.push(descriptor.value);
  }
  const allowedKeys = new Set([
    "length",
    ...lanes.map((unused, index) => String(index)),
  ]);
  if (Object.keys(descriptors).some((key) => !allowedKeys.has(key))) {
    throw new TypeError("destroyedOpposingLaneTowers has an invalid shape");
  }
  if (new Set(lanes).size !== lanes.length) {
    throw new TypeError("destroyedOpposingLaneTowers must not contain duplicates");
  }
  return lanes;
}

function decision(legal, reason, confidence) {
  return { legal, reason, confidence };
}

/**
 * Deployment masks use closed rectangle edges.
 *
 * The arena geometry module's general-purpose [min, max) convention is useful
 * for partitioning cells, but it cannot commute at raw edge coordinates with
 * rotateArenaPoint180: rotation exchanges each rectangle's min and max edges.
 * Deployment decisions instead treat both estimated outer edges as belonging
 * to the mask. A rectangle and its 180-degree rotation therefore contain
 * exactly the same rotated points, including corners and edges.
 */
function deploymentRectangleContainsPoint(rectangle, point) {
  return (
    point.x >= rectangle.minX &&
    point.x <= rectangle.maxX &&
    point.y >= rectangle.minY &&
    point.y <= rectangle.maxY
  );
}

function isEstimatedEdgeExcluded(point) {
  const inset = ESTIMATED_DEPLOYMENT_MASK.edgeInset;
  return (
    point.x < inset ||
    point.x > ARENA_WIDTH_MILLITILES - inset ||
    point.y < inset ||
    point.y > ARENA_LENGTH_MILLITILES - inset
  );
}

function isInOwnHalf(side, point) {
  return side === "south" ? point.y < 15_000 : point.y >= 17_000;
}

function towerAt(point) {
  return getArenaGeometry().towers.find((tower) =>
    deploymentRectangleContainsPoint(tower.bounds, point)
  );
}

/**
 * Evaluate one placement without mutating or retaining caller data.
 *
 * The accepted request is exactly:
 * { side, placementClass, point, destroyedOpposingLaneTowers }.
 * Special card placement behavior belongs in a future card policy layer.
 */
export function evaluateDeployment(value) {
  const descriptors = assertPlainDataObject(
    value,
    ["destroyedOpposingLaneTowers", "placementClass", "point", "side"],
    "deployment request",
  );
  const side = descriptors.side.value;
  const placementClass = descriptors.placementClass.value;
  if (!SIDES.has(side)) {
    throw new TypeError("deployment request.side must be south or north");
  }
  if (!PLACEMENT_CLASSES.has(placementClass)) {
    throw new TypeError(
      "deployment request.placementClass must be ground_entity or global_effect",
    );
  }
  const point = validateArenaPoint(
    descriptors.point.value,
    "deployment request.point",
  );
  const destroyedLanes = validateDestroyedLanes(
    descriptors.destroyedOpposingLaneTowers.value,
  );

  if (!isPointInArena(point)) {
    return decision(false, "outside_playfield", "high");
  }
  if (placementClass === "global_effect") {
    return decision(true, "full_playfield_effect", "high");
  }

  const geometry = getArenaGeometry();
  if (deploymentRectangleContainsPoint(geometry.river, point)) {
    return decision(false, "river_excluded", "high");
  }
  if (towerAt(point)) {
    return decision(false, "tower_footprint", "estimate");
  }
  if (
    isEstimatedEdgeExcluded(point) ||
    deploymentRectangleContainsPoint(
      ESTIMATED_DEPLOYMENT_MASK.kingBehindStrips[side],
      point,
    )
  ) {
    return decision(false, "estimated_edge_exclusion", "estimate");
  }
  if (isInOwnHalf(side, point)) {
    return decision(true, "own_side_ground", "estimate");
  }
  for (const lane of destroyedLanes) {
    if (
      deploymentRectangleContainsPoint(
        ESTIMATED_DEPLOYMENT_MASK.forwardPockets[side][lane],
        point,
      )
    ) {
      return decision(true, "destroyed_lane_pocket", "estimate");
    }
  }
  return decision(false, "opposing_side_locked", "estimate");
}

function cloneRectangle(rectangle) {
  return {
    minX: rectangle.minX,
    maxX: rectangle.maxX,
    minY: rectangle.minY,
    maxY: rectangle.maxY,
  };
}

/** Returns calibration metadata as fresh JSON data. */
export function getDeploymentPolicy() {
  return {
    units: "millitiles",
    hardRules: {
      playfield: {
        minX: 0,
        maxX: ARENA_WIDTH_MILLITILES,
        minY: 0,
        maxY: ARENA_LENGTH_MILLITILES,
      },
      groundEntities: "own-side walkable ground; river and towers excluded",
      globalEffects: "full playfield",
      destroyedTowerRule: "only the destroyed opposing tower lane unlocks",
      confidence: "high",
    },
    estimatedMasksNotCollisionAuthoritative: {
      confidence: "estimate",
      rectangleBoundarySemantics:
        "closed [min, max] edges; membership commutes with 180-degree rotation",
      edgeInset: ESTIMATED_DEPLOYMENT_MASK.edgeInset,
      kingBehindStrips: {
        south: cloneRectangle(ESTIMATED_DEPLOYMENT_MASK.kingBehindStrips.south),
        north: cloneRectangle(ESTIMATED_DEPLOYMENT_MASK.kingBehindStrips.north),
      },
      forwardPockets: {
        south: {
          west: cloneRectangle(
            ESTIMATED_DEPLOYMENT_MASK.forwardPockets.south.west,
          ),
          east: cloneRectangle(
            ESTIMATED_DEPLOYMENT_MASK.forwardPockets.south.east,
          ),
        },
        north: {
          west: cloneRectangle(
            ESTIMATED_DEPLOYMENT_MASK.forwardPockets.north.west,
          ),
          east: cloneRectangle(
            ESTIMATED_DEPLOYMENT_MASK.forwardPockets.north.east,
          ),
        },
      },
    },
  };
}
