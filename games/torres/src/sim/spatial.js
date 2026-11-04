export const MILLITILES_PER_TILE = 1000;

// Keeping each component inside this bound makes the sum of two squared
// coordinate differences, and the square of two added radii, exact safe
// integers. BigInt is still used while comparing so no intermediate operation
// can silently round.
export const MAX_SPATIAL_MILLITILES = Math.floor(
  Math.sqrt(Number.MAX_SAFE_INTEGER / 8),
);

const LAYERS = new Set(["air", "ground"]);
const QUERY_LAYERS = new Set(["air", "both", "ground"]);

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
    throw new TypeError(`${label} must contain only string-keyed JSON data`);
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

function assertSafeMillitiles(value, label, { nonNegative = false } = {}) {
  if (
    !Number.isSafeInteger(value) ||
    Math.abs(value) > MAX_SPATIAL_MILLITILES ||
    (nonNegative && value < 0)
  ) {
    const sign = nonNegative ? "non-negative " : "";
    throw new TypeError(
      `${label} must be a ${sign}safe integer millitile value within spatial bounds`,
    );
  }
}

function assertEntityId(value, label = "entity id") {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
}

/**
 * Converts a JSON number of tiles to integer millitiles.
 *
 * The input must have an exact representation at thousandth-tile precision.
 * Values that would require rounding (including ordinary binary floating-point
 * artifacts) are rejected instead of snapped.
 */
export function tilesToMillitiles(tiles, label = "tile value") {
  if (typeof tiles !== "number" || !Number.isFinite(tiles)) {
    throw new TypeError(`${label} must be a finite number`);
  }
  const text = tiles.toString().toLowerCase();
  const [coefficient, exponentText = "0"] = text.split("e");
  const negative = coefficient.startsWith("-");
  const unsigned = negative ? coefficient.slice(1) : coefficient;
  const [whole, fraction = ""] = unsigned.split(".");
  let scaled = BigInt(`${negative ? "-" : ""}${whole}${fraction}`);
  const decimalShift = Number(exponentText) - fraction.length + 3;
  if (decimalShift >= 0) {
    scaled *= 10n ** BigInt(decimalShift);
  } else {
    const divisor = 10n ** BigInt(-decimalShift);
    if (scaled % divisor !== 0n) {
      throw new TypeError(
        `${label} must be exactly representable in thousandths of a tile`,
      );
    }
    scaled /= divisor;
  }
  if (scaled < -BigInt(MAX_SPATIAL_MILLITILES) ||
      scaled > BigInt(MAX_SPATIAL_MILLITILES)) {
    throw new RangeError(`${label} is outside the supported spatial bounds`);
  }
  const result = Number(scaled);
  if (!Number.isSafeInteger(result)) {
    throw new TypeError(
      `${label} must be exactly representable in thousandths of a tile`,
    );
  }
  return Object.is(result, -0) ? 0 : result;
}

export function millitilesToTiles(millitiles, label = "millitile value") {
  assertSafeMillitiles(millitiles, label);
  return millitiles / MILLITILES_PER_TILE;
}

export function position(xTiles, yTiles) {
  return {
    x: tilesToMillitiles(xTiles, "x"),
    y: tilesToMillitiles(yTiles, "y"),
  };
}

export function radius(tileRadius) {
  const result = tilesToMillitiles(tileRadius, "radius");
  assertSafeMillitiles(result, "radius", { nonNegative: true });
  return result;
}

export function validatePosition(value, label = "position") {
  assertExactKeys(value, ["x", "y"], label);
  assertSafeMillitiles(value.x, `${label}.x`);
  assertSafeMillitiles(value.y, `${label}.y`);
  return { x: value.x, y: value.y };
}

export function validateCircle(value, label = "circle") {
  assertExactKeys(value, ["position", "radius"], label);
  const checkedPosition = validatePosition(value.position, `${label}.position`);
  assertSafeMillitiles(value.radius, `${label}.radius`, { nonNegative: true });
  return { position: checkedPosition, radius: value.radius };
}

export function spatialEntity(value, label = "spatial entity") {
  assertExactKeys(value, ["id", "layer", "position", "radius"], label);
  assertEntityId(value.id, `${label}.id`);
  if (!LAYERS.has(value.layer)) {
    throw new TypeError(`${label}.layer must be "ground" or "air"`);
  }
  return {
    id: value.id,
    layer: value.layer,
    position: validatePosition(value.position, `${label}.position`),
    radius: validateRadius(value.radius, `${label}.radius`),
  };
}

function validateRadius(value, label) {
  assertSafeMillitiles(value, label, { nonNegative: true });
  return value;
}

function distanceSquaredBigInt(left, right) {
  const dx = BigInt(left.x) - BigInt(right.x);
  const dy = BigInt(left.y) - BigInt(right.y);
  return dx * dx + dy * dy;
}

/**
 * Returns center-to-center squared distance in square millitiles.
 * No square root or floating-point operation participates in comparisons.
 */
export function squaredDistance(left, right) {
  const checkedLeft = validatePosition(left, "left position");
  const checkedRight = validatePosition(right, "right position");
  return Number(distanceSquaredBigInt(checkedLeft, checkedRight));
}

/**
 * Tests circle intersection. Tangency counts as overlap by default.
 * Pass { includeBoundary: false } to require a positive-area intersection.
 */
export function circlesOverlap(
  left,
  right,
  options = {},
) {
  assertPlainObject(options, "overlap options");
  assertExactKeys(
    options,
    Object.hasOwn(options, "includeBoundary") ? ["includeBoundary"] : [],
    "overlap options",
  );
  const includeBoundary = options.includeBoundary ?? true;
  if (typeof includeBoundary !== "boolean") {
    throw new TypeError("includeBoundary must be a boolean");
  }
  const checkedLeft = validateCircle(left, "left circle");
  const checkedRight = validateCircle(right, "right circle");
  const sum = BigInt(checkedLeft.radius) + BigInt(checkedRight.radius);
  const distance = distanceSquaredBigInt(
    checkedLeft.position,
    checkedRight.position,
  );
  const threshold = sum * sum;
  return includeBoundary ? distance <= threshold : distance < threshold;
}

function validateOptions(options) {
  assertPlainObject(options, "nearest options");
  const allowed = new Set(["includeRangeBoundary", "layer", "range"]);
  for (const key of Object.keys(options)) {
    if (!allowed.has(key)) {
      throw new TypeError("nearest options has an invalid shape");
    }
  }

  const layer = options.layer ?? "both";
  if (!QUERY_LAYERS.has(layer)) {
    throw new TypeError(
      'nearest options.layer must be "ground", "air", or "both"',
    );
  }
  const includeRangeBoundary = options.includeRangeBoundary ?? true;
  if (typeof includeRangeBoundary !== "boolean") {
    throw new TypeError("nearest options.includeRangeBoundary must be a boolean");
  }
  const range = options.range ?? null;
  if (range !== null) {
    validateRadius(range, "nearest options.range");
  }
  return { includeRangeBoundary, layer, range };
}

/**
 * Finds the nearest eligible circle by center distance.
 *
 * Candidate order is irrelevant: equal distances resolve to the lowest entity
 * ID. `range`, when supplied, is edge-to-edge reach in millitiles; the origin
 * and candidate radii extend it. Exact boundary contact is included by default.
 * Inputs are validated completely before querying and the result is an isolated
 * JSON object.
 */
export function nearestSpatialEntity(origin, candidates, options = {}) {
  const checkedOrigin = validateCircle(origin, "origin");
  if (!Array.isArray(candidates)) {
    throw new TypeError("candidates must be an array");
  }
  for (let index = 0; index < candidates.length; index += 1) {
    if (!Object.hasOwn(candidates, index)) {
      throw new TypeError("candidates must not be a sparse array");
    }
    const descriptor = Object.getOwnPropertyDescriptor(candidates, `${index}`);
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
      throw new TypeError(
        `candidates[${index}] must be an enumerable data property`,
      );
    }
  }
  const extraCandidateKeys = Reflect.ownKeys(candidates).filter(
    (key) =>
      key !== "length" &&
      (typeof key !== "string" ||
        !/^(0|[1-9]\d*)$/.test(key) ||
        Number(key) >= candidates.length),
  );
  if (extraCandidateKeys.length > 0) {
    throw new TypeError("candidates must contain only indexed JSON data");
  }
  const checkedCandidates = candidates.map((candidate, index) =>
    spatialEntity(candidate, `candidate ${index}`)
  );
  const ids = new Set();
  for (const candidate of checkedCandidates) {
    if (ids.has(candidate.id)) {
      throw new TypeError("candidates must have unique entity IDs");
    }
    ids.add(candidate.id);
  }
  const { includeRangeBoundary, layer, range } = validateOptions(options);

  let best = null;
  let bestDistance = null;
  for (const candidate of checkedCandidates) {
    if (layer !== "both" && candidate.layer !== layer) {
      continue;
    }
    const distance = distanceSquaredBigInt(
      checkedOrigin.position,
      candidate.position,
    );
    if (range !== null) {
      const reach =
        BigInt(checkedOrigin.radius) +
        BigInt(range) +
        BigInt(candidate.radius);
      const threshold = reach * reach;
      if (
        includeRangeBoundary ? distance > threshold : distance >= threshold
      ) {
        continue;
      }
    }
    if (
      best === null ||
      distance < bestDistance ||
      (distance === bestDistance && candidate.id < best.id)
    ) {
      best = candidate;
      bestDistance = distance;
    }
  }

  return best === null
    ? null
    : {
        id: best.id,
        layer: best.layer,
        position: { ...best.position },
        radius: best.radius,
      };
}
