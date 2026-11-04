export const ARENA_MILLITILES_PER_TILE = 1000;
export const ARENA_WIDTH_MILLITILES = 18_000;
export const ARENA_LENGTH_MILLITILES = 32_000;

// These screenshot-derived values are deliberately centralized. They are a
// useful deterministic starting layout, not collision-authoritative evidence;
// later footage calibration can replace this one table without changing the
// query API.
const ESTIMATED_LAYOUT = Object.freeze({
  river: Object.freeze({ minX: 0, maxX: 18_000, minY: 15_000, maxY: 17_000 }),
  bridges: Object.freeze([
    Object.freeze({
      lane: "west",
      center: Object.freeze({ x: 3_500, y: 16_000 }),
      bounds: Object.freeze({
        minX: 2_500, maxX: 4_500, minY: 15_000, maxY: 17_000,
      }),
    }),
    Object.freeze({
      lane: "east",
      center: Object.freeze({ x: 14_500, y: 16_000 }),
      bounds: Object.freeze({
        minX: 13_500, maxX: 15_500, minY: 15_000, maxY: 17_000,
      }),
    }),
  ]),
  towers: Object.freeze([
    Object.freeze({
      side: "south",
      role: "central",
      center: Object.freeze({ x: 9_000, y: 3_000 }),
      bounds: Object.freeze({
        minX: 7_000, maxX: 11_000, minY: 1_000, maxY: 5_000,
      }),
    }),
    Object.freeze({
      side: "south",
      role: "lane",
      lane: "west",
      center: Object.freeze({ x: 3_500, y: 7_500 }),
      bounds: Object.freeze({
        minX: 2_000, maxX: 5_000, minY: 6_000, maxY: 9_000,
      }),
    }),
    Object.freeze({
      side: "south",
      role: "lane",
      lane: "east",
      center: Object.freeze({ x: 14_500, y: 7_500 }),
      bounds: Object.freeze({
        minX: 13_000, maxX: 16_000, minY: 6_000, maxY: 9_000,
      }),
    }),
    Object.freeze({
      side: "north",
      role: "central",
      center: Object.freeze({ x: 9_000, y: 29_000 }),
      bounds: Object.freeze({
        minX: 7_000, maxX: 11_000, minY: 27_000, maxY: 31_000,
      }),
    }),
    Object.freeze({
      side: "north",
      role: "lane",
      lane: "west",
      center: Object.freeze({ x: 3_500, y: 24_500 }),
      bounds: Object.freeze({
        minX: 2_000, maxX: 5_000, minY: 23_000, maxY: 26_000,
      }),
    }),
    Object.freeze({
      side: "north",
      role: "lane",
      lane: "east",
      center: Object.freeze({ x: 14_500, y: 24_500 }),
      bounds: Object.freeze({
        minX: 13_000, maxX: 16_000, minY: 23_000, maxY: 26_000,
      }),
    }),
  ]),
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

function safeCoordinate(descriptor, label) {
  const value = descriptor.value;
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(`${label} must be a safe integer millitile coordinate`);
  }
  return value;
}

function pointIsInArena(point) {
  return point.x >= 0 && point.x <= ARENA_WIDTH_MILLITILES &&
    point.y >= 0 && point.y <= ARENA_LENGTH_MILLITILES;
}

function rectangleIsInArena(rectangle) {
  return rectangle.minX >= 0 && rectangle.maxX <= ARENA_WIDTH_MILLITILES &&
    rectangle.minY >= 0 && rectangle.maxY <= ARENA_LENGTH_MILLITILES;
}

function trustedRectangleContainsPoint(rectangle, point) {
  return point.x >= rectangle.minX && point.x < rectangle.maxX &&
    point.y >= rectangle.minY && point.y < rectangle.maxY;
}

export function validateArenaPoint(value, label = "arena point") {
  const descriptors = assertPlainDataObject(value, ["x", "y"], label);
  return {
    x: safeCoordinate(descriptors.x, `${label}.x`),
    y: safeCoordinate(descriptors.y, `${label}.y`),
  };
}

export function validateArenaRectangle(value, label = "arena rectangle") {
  const descriptors = assertPlainDataObject(
    value,
    ["maxX", "maxY", "minX", "minY"],
    label,
  );
  const rectangle = {
    minX: safeCoordinate(descriptors.minX, `${label}.minX`),
    maxX: safeCoordinate(descriptors.maxX, `${label}.maxX`),
    minY: safeCoordinate(descriptors.minY, `${label}.minY`),
    maxY: safeCoordinate(descriptors.maxY, `${label}.maxY`),
  };
  if (
    rectangle.minX >= rectangle.maxX ||
    rectangle.minY >= rectangle.maxY
  ) {
    throw new RangeError(`${label} must have positive width and height`);
  }
  return rectangle;
}

// Static obstacle bounds are validated once from this module's frozen literal
// layout. They are private, never caller-provided, and live for the module
// lifetime; the public geometry APIs still validate every caller point and
// rectangle. There is no exported capability or mutable per-session cache.
const CANONICAL_STATIC_OBSTACLES = (() => {
  const admitted = (rectangle, label) => {
    const checked = validateArenaRectangle(rectangle, label);
    if (!rectangleIsInArena(checked)) {
      throw new RangeError(`${label} must be within the arena`);
    }
    return Object.freeze(checked);
  };
  return Object.freeze({
    bridges: Object.freeze(ESTIMATED_LAYOUT.bridges.map(({ bounds }, index) =>
      admitted(bounds, `canonical bridge ${index}`))),
    river: admitted(ESTIMATED_LAYOUT.river, "canonical river"),
    towers: Object.freeze(ESTIMATED_LAYOUT.towers.map(({ bounds }, index) =>
      admitted(bounds, `canonical tower ${index}`))),
  });
})();

/**
 * Arena coordinate bounds are closed: outer tile edges (0 and width/length)
 * are valid coordinates.
 */
export function isPointInArena(value) {
  const point = validateArenaPoint(value);
  return pointIsInArena(point);
}

/**
 * A rectangle is in bounds when all of its closed outer edges fit in the
 * arena. Rectangles themselves use [min, max) containment.
 */
export function isRectangleInArena(value) {
  const rectangle = validateArenaRectangle(value);
  return rectangleIsInArena(rectangle);
}

/** Returns true for min edges and false for max edges. */
export function rectangleContainsPoint(rectangleValue, pointValue) {
  const rectangle = validateArenaRectangle(rectangleValue);
  const point = validateArenaPoint(pointValue);
  return trustedRectangleContainsPoint(rectangle, point);
}

export function rotateArenaPoint180(value) {
  const point = validateArenaPoint(value);
  if (!pointIsInArena(point)) {
    throw new RangeError("arena point must be within the closed arena bounds");
  }
  return {
    x: ARENA_WIDTH_MILLITILES - point.x,
    y: ARENA_LENGTH_MILLITILES - point.y,
  };
}

export function rotateArenaRectangle180(value) {
  const rectangle = validateArenaRectangle(value);
  if (!rectangleIsInArena(rectangle)) {
    throw new RangeError(
      "arena rectangle must be within the closed arena bounds",
    );
  }
  return {
    minX: ARENA_WIDTH_MILLITILES - rectangle.maxX,
    maxX: ARENA_WIDTH_MILLITILES - rectangle.minX,
    minY: ARENA_LENGTH_MILLITILES - rectangle.maxY,
    maxY: ARENA_LENGTH_MILLITILES - rectangle.minY,
  };
}

/**
 * Static point query for ground movement. Outside points, the river away from
 * bridge footprints, and tower footprints are blocked. Rectangle containment
 * is min-inclusive/max-exclusive, including on bridge and tower edges.
 */
export function isGroundStaticallyBlocked(value) {
  const point = validateArenaPoint(value);
  if (!pointIsInArena(point)) return true;

  for (const tower of CANONICAL_STATIC_OBSTACLES.towers) {
    if (trustedRectangleContainsPoint(tower, point)) return true;
  }
  if (!trustedRectangleContainsPoint(CANONICAL_STATIC_OBSTACLES.river, point)) return false;
  return !CANONICAL_STATIC_OBSTACLES.bridges.some((bridge) =>
    trustedRectangleContainsPoint(bridge, point)
  );
}

function cloneRectangle(rectangle) {
  return {
    minX: rectangle.minX,
    maxX: rectangle.maxX,
    minY: rectangle.minY,
    maxY: rectangle.maxY,
  };
}

function clonePoint(point) {
  return { x: point.x, y: point.y };
}

/**
 * Returns fresh JSON data on every call. Bridge and tower geometry is marked
 * as an estimate because its source is screenshot-derived.
 */
export function getArenaGeometry() {
  return {
    units: "millitiles",
    bounds: {
      minX: 0,
      maxX: ARENA_WIDTH_MILLITILES,
      minY: 0,
      maxY: ARENA_LENGTH_MILLITILES,
    },
    river: cloneRectangle(ESTIMATED_LAYOUT.river),
    bridges: ESTIMATED_LAYOUT.bridges.map((bridge) => ({
      lane: bridge.lane,
      confidence: "estimate",
      center: clonePoint(bridge.center),
      bounds: cloneRectangle(bridge.bounds),
    })),
    towers: ESTIMATED_LAYOUT.towers.map((tower) => ({
      side: tower.side,
      role: tower.role,
      ...(tower.lane === undefined ? {} : { lane: tower.lane }),
      confidence: "estimate",
      center: clonePoint(tower.center),
      bounds: cloneRectangle(tower.bounds),
    })),
  };
}
