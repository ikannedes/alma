import {
  nearestSpatialEntity,
  spatialEntity,
  validateCircle,
} from "./spatial.js";

export const ATTACK_TARGET_MODES = Object.freeze([
  "ground",
  "air",
  "air_and_ground",
  "buildings",
  "none",
]);

const TARGET_MODES = new Set(ATTACK_TARGET_MODES);
const TARGET_KINDS = new Set(["structure", "troop"]);

function assertExactDataObject(value, expectedKeys, label) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    throw new TypeError(`${label} must be a plain object`);
  }

  const descriptors = Object.getOwnPropertyDescriptors(value);
  const actualKeys = Reflect.ownKeys(descriptors);
  if (actualKeys.some((key) => typeof key !== "string")) {
    throw new TypeError(`${label} must contain only string-keyed data`);
  }
  const actual = actualKeys.sort();
  const expected = [...expectedKeys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new TypeError(`${label} has an invalid shape`);
  }

  const result = {};
  for (const key of expected) {
    const descriptor = descriptors[key];
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
      throw new TypeError(`${label}.${key} must be an enumerable data property`);
    }
    result[key] = descriptor.value;
  }
  return result;
}

function checkedCircle(value, label) {
  const circle = assertExactDataObject(value, ["position", "radius"], label);
  const position = assertExactDataObject(
    circle.position,
    ["x", "y"],
    `${label}.position`,
  );
  return validateCircle({
    position: { x: position.x, y: position.y },
    radius: circle.radius,
  }, label);
}

function checkedCandidate(value, label) {
  const candidate = assertExactDataObject(
    value,
    [
      "alive",
      "id",
      "kind",
      "layer",
      "position",
      "radius",
      "targetable",
    ],
    label,
  );
  const position = assertExactDataObject(
    candidate.position,
    ["x", "y"],
    `${label}.position`,
  );
  const spatial = spatialEntity({
    id: candidate.id,
    layer: candidate.layer,
    position: { x: position.x, y: position.y },
    radius: candidate.radius,
  }, label);
  if (!TARGET_KINDS.has(candidate.kind)) {
    throw new TypeError(`${label}.kind must be "troop" or "structure"`);
  }
  if (typeof candidate.alive !== "boolean") {
    throw new TypeError(`${label}.alive must be a boolean`);
  }
  if (typeof candidate.targetable !== "boolean") {
    throw new TypeError(`${label}.targetable must be a boolean`);
  }
  return {
    alive: candidate.alive,
    id: spatial.id,
    kind: candidate.kind,
    layer: spatial.layer,
    position: spatial.position,
    radius: spatial.radius,
    targetable: candidate.targetable,
  };
}

function checkedCandidateArray(candidates) {
  if (!Array.isArray(candidates)) {
    throw new TypeError("target candidates must be an array");
  }
  const descriptors = Object.getOwnPropertyDescriptors(candidates);
  const ownKeys = Reflect.ownKeys(descriptors);
  for (const key of ownKeys) {
    if (key === "length") continue;
    if (
      typeof key !== "string" ||
      !/^(0|[1-9]\d*)$/.test(key) ||
      Number(key) >= candidates.length
    ) {
      throw new TypeError(
        "target candidates must contain only indexed data",
      );
    }
  }

  const checked = [];
  const ids = new Set();
  for (let index = 0; index < candidates.length; index += 1) {
    const descriptor = descriptors[index];
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !Object.hasOwn(descriptor, "value")
    ) {
      throw new TypeError(
        `target candidates[${index}] must be an enumerable data property`,
      );
    }
    const candidate = checkedCandidate(
      descriptor.value,
      `target candidate ${index}`,
    );
    if (ids.has(candidate.id)) {
      throw new TypeError("target candidates must have unique entity IDs");
    }
    ids.add(candidate.id);
    checked.push(candidate);
  }
  return checked;
}

function checkedModeAndSight(options, expectedKeys, label) {
  const checked = assertExactDataObject(options, expectedKeys, label);
  if (!TARGET_MODES.has(checked.mode)) {
    throw new TypeError(
      `${label}.mode must be ground, air, air_and_ground, buildings, or none`,
    );
  }
  const sight = checkedCircle(
    { position: { x: 0, y: 0 }, radius: checked.sightRange },
    `${label} sight`,
  );
  return { checked, sightRange: sight.radius };
}

function isModeEligible(candidate, mode) {
  if (!candidate.alive || !candidate.targetable || mode === "none") {
    return false;
  }
  if (mode === "buildings") {
    return candidate.kind === "structure";
  }
  if (mode === "air_and_ground") {
    return true;
  }
  return candidate.layer === mode;
}

function cloneCandidate(candidate) {
  return {
    alive: candidate.alive,
    id: candidate.id,
    kind: candidate.kind,
    layer: candidate.layer,
    position: { ...candidate.position },
    radius: candidate.radius,
    targetable: candidate.targetable,
  };
}

function toSpatialCandidate(candidate) {
  return {
    id: candidate.id,
    layer: candidate.layer,
    position: candidate.position,
    radius: candidate.radius,
  };
}

function acquireChecked(origin, candidates, mode, sightRange) {
  const eligible = candidates.filter((candidate) =>
    isModeEligible(candidate, mode)
  );
  const nearest = nearestSpatialEntity(
    origin,
    eligible.map(toSpatialCandidate),
    {
      includeRangeBoundary: true,
      layer: "both",
      range: sightRange,
    },
  );
  if (nearest === null) return null;
  return cloneCandidate(
    eligible.find((candidate) => candidate.id === nearest.id),
  );
}

/**
 * Validates and isolates one targeting candidate.
 *
 * Structures include all modeled buildings and towers. This module makes no
 * card-specific distinctions within either "troop" or "structure".
 */
export function targetCandidate(value, label = "target candidate") {
  return checkedCandidate(value, label);
}

/**
 * Acquires the nearest eligible target in sight.
 *
 * Sight range is edge-to-edge millitile reach: origin radius + sightRange +
 * candidate radius. Exact boundary contact is in sight. Equal center distances
 * resolve to the lowest candidate ID, independent of input order.
 */
export function acquireTarget(origin, candidates, options) {
  const checkedOrigin = checkedCircle(origin, "targeting origin");
  const checkedCandidates = checkedCandidateArray(candidates);
  const { checked, sightRange } = checkedModeAndSight(
    options,
    ["mode", "sightRange"],
    "acquire options",
  );
  return acquireChecked(
    checkedOrigin,
    checkedCandidates,
    checked.mode,
    sightRange,
  );
}

/**
 * Retains a current target while it remains alive, targetable, mode-eligible,
 * and in sight. Only an invalid or out-of-sight current target causes a fresh,
 * deterministic acquisition. A missing current target is represented by null.
 */
export function retainOrAcquireTarget(origin, candidates, options) {
  const checkedOrigin = checkedCircle(origin, "targeting origin");
  const checkedCandidates = checkedCandidateArray(candidates);
  const { checked, sightRange } = checkedModeAndSight(
    options,
    ["currentTargetId", "mode", "sightRange"],
    "retarget options",
  );
  if (
    checked.currentTargetId !== null &&
    (!Number.isSafeInteger(checked.currentTargetId) ||
      checked.currentTargetId < 1)
  ) {
    throw new TypeError(
      "retarget options.currentTargetId must be null or a positive safe integer",
    );
  }

  const current = checkedCandidates.find(
    (candidate) => candidate.id === checked.currentTargetId,
  );
  if (current !== undefined && isModeEligible(current, checked.mode)) {
    const inSight = nearestSpatialEntity(checkedOrigin, [
      toSpatialCandidate(current),
    ], {
      includeRangeBoundary: true,
      layer: "both",
      range: sightRange,
    });
    if (inSight !== null) return cloneCandidate(current);
  }

  return acquireChecked(
    checkedOrigin,
    checkedCandidates,
    checked.mode,
    sightRange,
  );
}
