import { MAX_SPATIAL_MILLITILES } from "./spatial.js";

export const MOVEMENT_TICKS_PER_SECOND = 60;

export const MOVEMENT_SPEEDS = Object.freeze({
  stationary: 0,
  slow: 750,
  medium: 1000,
  fast: 1500,
  very_fast: 2000,
});

const ALLOWED_SPEEDS = new Set(Object.values(MOVEMENT_SPEEDS));
const STATE_KEYS = ["direction", "position", "remainder", "speed"];

function assertPlainObject(value, label) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    throw new TypeError(`${label} must be a plain object`);
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new TypeError(`${label} must contain only string-keyed data`);
  }
  for (const [key, descriptor] of Object.entries(
    Object.getOwnPropertyDescriptors(value),
  )) {
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

function assertPosition(value, label = "movement position") {
  if (
    !Number.isSafeInteger(value) ||
    Math.abs(value) > MAX_SPATIAL_MILLITILES
  ) {
    throw new TypeError(
      `${label} must be a safe integer millitile value within spatial bounds`,
    );
  }
}

function validateState(value, label = "movement state") {
  assertExactKeys(value, STATE_KEYS, label);
  assertPosition(value.position, `${label}.position`);
  if (!ALLOWED_SPEEDS.has(value.speed)) {
    throw new TypeError(
      `${label}.speed must be a reference speed in millitiles per second`,
    );
  }
  if (
    !Number.isSafeInteger(value.direction) ||
    ![-1, 0, 1].includes(value.direction)
  ) {
    throw new TypeError(`${label}.direction must be -1, 0, or 1`);
  }
  if (
    !Number.isSafeInteger(value.remainder) ||
    value.remainder < 0 ||
    value.remainder >= MOVEMENT_TICKS_PER_SECOND
  ) {
    throw new TypeError(
      `${label}.remainder must be an integer from 0 through ${
        MOVEMENT_TICKS_PER_SECOND - 1
      }`,
    );
  }
  if (
    (value.speed === MOVEMENT_SPEEDS.stationary) !==
      (value.direction === 0) ||
    (value.speed === MOVEMENT_SPEEDS.stationary && value.remainder !== 0)
  ) {
    throw new TypeError(
      `${label} must pair stopped speed, direction, and remainder`,
    );
  }
  return {
    direction: value.direction,
    position: value.position,
    remainder: value.remainder,
    speed: value.speed,
  };
}

/**
 * Creates one-dimensional movement state in integer millitiles.
 *
 * A moving state uses one of the four reference speeds and direction -1 or 1.
 * The explicit stopped state is speed 0, direction 0, and remainder 0.
 */
export function createMovementState({
  direction = 0,
  position = 0,
  remainder = 0,
  speed = MOVEMENT_SPEEDS.stationary,
} = {}) {
  return validateState({ direction, position, remainder, speed });
}

/**
 * Advances an axis by an integer number of 60 Hz simulation ticks.
 *
 * `remainder` is a numerator over 60, not a floating-point distance. Movement
 * is distributed by flooring cumulative ideal distance: slow alternates
 * 12/13 millitiles, medium repeats 16/17/17, fast is always 25, and very-fast
 * repeats 33/33/34. Negative movement applies the exact opposite displacement
 * while retaining the same non-negative phase. Thus chunked and single-tick
 * advancement produce identical state.
 */
export function advanceMovement(state, ticks = 1) {
  const checked = validateState(state);
  if (!Number.isSafeInteger(ticks) || ticks < 0) {
    throw new TypeError("movement ticks must be a non-negative safe integer");
  }
  if (checked.direction === 0 || ticks === 0) {
    return checked;
  }

  const accumulated =
    BigInt(checked.remainder) + BigInt(checked.speed) * BigInt(ticks);
  const divisor = BigInt(MOVEMENT_TICKS_PER_SECOND);
  const distance = accumulated / divisor;
  const remainder = Number(accumulated % divisor);
  const position =
    BigInt(checked.position) + BigInt(checked.direction) * distance;
  if (
    position < -BigInt(MAX_SPATIAL_MILLITILES) ||
    position > BigInt(MAX_SPATIAL_MILLITILES)
  ) {
    throw new RangeError("movement result is outside the supported spatial bounds");
  }

  return {
    direction: checked.direction,
    position: Number(position),
    remainder,
    speed: checked.speed,
  };
}

export function stopMovement(state) {
  const checked = validateState(state);
  return {
    direction: 0,
    position: checked.position,
    remainder: 0,
    speed: MOVEMENT_SPEEDS.stationary,
  };
}

export function serializeMovementState(state) {
  const checked = validateState(state);
  return JSON.stringify({
    state: checked,
    version: 1,
  });
}

export function restoreMovementState(serialized) {
  if (typeof serialized !== "string") {
    throw new TypeError("serialized movement state must be a string");
  }
  let snapshot;
  try {
    snapshot = JSON.parse(serialized);
  } catch {
    throw new TypeError("serialized movement state must be valid JSON");
  }
  assertExactKeys(snapshot, ["state", "version"], "movement snapshot");
  if (snapshot.version !== 1) {
    throw new TypeError("movement snapshot has an unsupported version");
  }
  return validateState(snapshot.state, "movement snapshot.state");
}
