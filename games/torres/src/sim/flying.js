import {
  ARENA_LENGTH_MILLITILES,
  ARENA_WIDTH_MILLITILES,
  isPointInArena,
  validateArenaPoint,
} from "./arena-geometry.js";
import {
  MOVEMENT_SPEEDS,
  MOVEMENT_TICKS_PER_SECOND,
} from "./movement.js";

const ALLOWED_SPEEDS = new Set(Object.values(MOVEMENT_SPEEDS));
const STATE_KEYS = [
  "collisionRadius",
  "position",
  "remainder",
  "speed",
  "target",
];
const TARGET_KEYS = ["position", "radius", "range"];

function assertPlainObject(value, label) {
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
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
      throw new TypeError(`${label}.${key} must be an enumerable data property`);
    }
  }
}

function assertExactKeys(value, keys, label) {
  assertPlainObject(value, label);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new TypeError(`${label} has an invalid shape`);
  }
}

function nonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function clonePoint(value, label) {
  const point = validateArenaPoint(value, label);
  if (!isPointInArena(point)) {
    throw new RangeError(`${label} must be inside the arena`);
  }
  return point;
}

function validateTarget(value, label = "flying target") {
  if (value === null) return null;
  assertExactKeys(value, TARGET_KEYS, label);
  return {
    position: clonePoint(value.position, `${label}.position`),
    radius: nonNegativeInteger(value.radius, `${label}.radius`),
    range: nonNegativeInteger(value.range, `${label}.range`),
  };
}

function assertFlyerFits(position, collisionRadius, label) {
  if (
    position.x < collisionRadius ||
    position.x > ARENA_WIDTH_MILLITILES - collisionRadius ||
    position.y < collisionRadius ||
    position.y > ARENA_LENGTH_MILLITILES - collisionRadius
  ) {
    throw new RangeError(`${label} must fit inside the arena bounds`);
  }
}

function validateAxisTarget(position, target, label) {
  if (
    target !== null &&
    position.x !== target.position.x &&
    position.y !== target.position.y
  ) {
    throw new RangeError(
      `${label} must be axis-aligned; arbitrary-angle normalization is not yet supported`,
    );
  }
}

function validateState(value, label = "flying state") {
  assertExactKeys(value, STATE_KEYS, label);
  const position = clonePoint(value.position, `${label}.position`);
  const collisionRadius = nonNegativeInteger(
    value.collisionRadius,
    `${label}.collisionRadius`,
  );
  assertFlyerFits(position, collisionRadius, `${label}.position`);
  if (!ALLOWED_SPEEDS.has(value.speed)) {
    throw new TypeError(
      `${label}.speed must be a supported reference speed in millitiles per second`,
    );
  }
  const remainder = nonNegativeInteger(value.remainder, `${label}.remainder`);
  if (remainder >= MOVEMENT_TICKS_PER_SECOND) {
    throw new RangeError(
      `${label}.remainder must be less than ${MOVEMENT_TICKS_PER_SECOND}`,
    );
  }
  const target = validateTarget(value.target, `${label}.target`);
  validateAxisTarget(position, target, `${label}.target.position`);
  if ((target === null || value.speed === 0) && remainder !== 0) {
    throw new RangeError(
      `${label}.remainder must be zero while the flyer cannot move`,
    );
  }
  return {
    collisionRadius,
    position,
    remainder,
    speed: value.speed,
    target,
  };
}

function directionAndGap(state) {
  if (state.target === null) {
    return { axis: null, direction: 0, gap: 0 };
  }
  const dx = state.target.position.x - state.position.x;
  const dy = state.target.position.y - state.position.y;
  const axis = dx === 0 ? "y" : "x";
  const delta = axis === "x" ? dx : dy;
  const edgeDistance =
    state.collisionRadius + state.target.radius + state.target.range;
  return {
    axis,
    direction: Math.sign(delta),
    gap: Math.max(0, Math.abs(delta) - edgeDistance),
  };
}

function distanceToBound(state, axis, direction) {
  if (axis === "x") {
    return direction < 0
      ? state.position.x - state.collisionRadius
      : ARENA_WIDTH_MILLITILES - state.collisionRadius - state.position.x;
  }
  return direction < 0
    ? state.position.y - state.collisionRadius
    : ARENA_LENGTH_MILLITILES - state.collisionRadius - state.position.y;
}

/**
 * Creates a deterministic flying-unit movement state in integer millitiles.
 *
 * This first primitive deliberately accepts axis-aligned targets only. Flyers
 * use no ground navigation or obstacle query: river, bridges, and tower
 * footprints do not participate in movement. The scalar phase is a numerator
 * over 60 and is serialized as part of the state.
 */
export function createFlyingState({
  collisionRadius = 0,
  position = { x: 0, y: 0 },
  remainder = 0,
  speed = MOVEMENT_SPEEDS.stationary,
  target = null,
} = {}) {
  return validateState({
    collisionRadius,
    position,
    remainder,
    speed,
    target,
  });
}

export function setFlyingTarget(state, target) {
  const checked = validateState(state);
  const checkedTarget = validateTarget(target);
  if (checkedTarget === null) {
    throw new TypeError("flying target command requires a target");
  }
  validateAxisTarget(
    checked.position,
    checkedTarget,
    "flying target.position",
  );
  return {
    ...checked,
    remainder: 0,
    target: checkedTarget,
  };
}

export function stopFlying(state) {
  const checked = validateState(state);
  return {
    ...checked,
    remainder: 0,
    target: null,
  };
}

/**
 * Advances an axis-aligned flyer by an exact number of 60 Hz ticks.
 *
 * Scalar movement uses the same cumulative rational method as the passed
 * movement primitive. Reaching either the configured circle-edge range or the
 * radius-adjusted arena boundary consumes the command and clears fractional
 * phase, making a chunk identical to repeated single-tick advancement.
 */
export function advanceFlying(state, ticks = 1) {
  const checked = validateState(state);
  if (!Number.isSafeInteger(ticks) || ticks < 0) {
    throw new TypeError("flying ticks must be a non-negative safe integer");
  }
  if (ticks === 0 || checked.target === null || checked.speed === 0) {
    return checked;
  }

  const route = directionAndGap(checked);
  if (route.direction === 0 || route.gap === 0) {
    return { ...checked, remainder: 0 };
  }
  const boundGap = distanceToBound(checked, route.axis, route.direction);
  const limit = Math.min(route.gap, boundGap);
  if (limit === 0) {
    return { ...checked, remainder: 0 };
  }

  const accumulated =
    BigInt(checked.remainder) + BigInt(checked.speed) * BigInt(ticks);
  const divisor = BigInt(MOVEMENT_TICKS_PER_SECOND);
  const availableDistance = accumulated / divisor;
  const travel = availableDistance > BigInt(limit)
    ? BigInt(limit)
    : availableDistance;
  const reachedLimit = travel === BigInt(limit);
  const position = { ...checked.position };
  position[route.axis] += route.direction * Number(travel);

  return {
    ...checked,
    position,
    remainder: reachedLimit ? 0 : Number(accumulated % divisor),
  };
}

export function serializeFlyingState(state) {
  const checked = validateState(state);
  return JSON.stringify({ state: checked, version: 1 });
}

export function restoreFlyingState(serialized) {
  if (typeof serialized !== "string") {
    throw new TypeError("serialized flying state must be a string");
  }
  let snapshot;
  try {
    snapshot = JSON.parse(serialized);
  } catch {
    throw new TypeError("serialized flying state must be valid JSON");
  }
  assertExactKeys(snapshot, ["state", "version"], "flying snapshot");
  if (snapshot.version !== 1) {
    throw new TypeError("flying snapshot has an unsupported version");
  }
  return validateState(snapshot.state, "flying snapshot.state");
}
