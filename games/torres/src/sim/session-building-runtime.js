import { AttackCycle } from "./attack-cycle.js";
import { evaluateDeployment } from "./deployment.js";
import {
  MOVEMENT_SPEEDS,
  advanceMovement,
  createMovementState,
  restoreMovementState,
  serializeMovementState,
} from "./movement.js";
import { findGroundPath } from "./pathfinding.js";
import { assertSessionBuildingProfileReceipt } from "./session-building-profile-receipts.js";

/**
 * GAME-001HBA's intentionally small capability boundary.
 *
 * This module has no session class and no mutable authority.  It never owns a
 * deck, elixir store, clock, ID stream, unit/tower array, or transcript.  The
 * only public transition consumes a canonical host snapshot for one already
 * selected shared tick and returns bounded intents for LiveBattle to validate
 * and commit atomically.  In particular, there is deliberately no `step()`
 * method and no independently advancing clock here.
 */
export const SESSION_BUILDING_ADMITTED_IDS = Object.freeze([
  "aether-well",
  "bulwark-needle",
  "buried-coil",
  "burrow-rig",
  "cinder-reliquary",
  "ember-basin",
  "horizon-caster",
  "prism-furnace",
]);
export const SESSION_BUILDING_QUESTION_IDS = Object.freeze([
  "bramble-cage",
  "ember-roost",
]);
export const SESSION_BUILDING_MAX_STRUCTURES = 128;
export const SESSION_BUILDING_MAX_INTENTS = 2_048;

const ADMITTED = new Set(SESSION_BUILDING_ADMITTED_IDS);
const QUESTION = new Set(SESSION_BUILDING_QUESTION_IDS);
const CLASS_BY_ID = Object.freeze({
  "aether-well": "resource",
  "bulwark-needle": "defensive",
  "buried-coil": "defensive",
  "burrow-rig": "travel",
  "cinder-reliquary": "death-effect",
  "ember-basin": "defensive",
  "horizon-caster": "defensive",
  "prism-furnace": "defensive",
});
const SIDES = new Set(["north", "south"]);
const LAYERS = new Set(["air", "ground"]);
const MAX_TICK = 18_000;
const MAX_POSITION = 1_000_000;
const MAX_DAMAGE = 1_000_000;
const MAX_BOUNDARY_BYTES = 1_048_576;
const MAX_BOUNDARY_NODES = 20_000;
const MAX_BOUNDARY_DEPTH = 64;
const TOWER_CYCLE_IDS = new Map([
  ["north:central", 9_000_000_001],
  ["north:lane:west", 9_000_000_002],
  ["north:lane:east", 9_000_000_003],
  ["south:central", 9_000_000_004],
  ["south:lane:west", 9_000_000_005],
  ["south:lane:east", 9_000_000_006],
]);

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.keys(value).sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

const clone = (value) => JSON.parse(JSON.stringify(value));
function freeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function exact(value, keys, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length !== 0) {
    throw new TypeError(`${label} must be a plain data object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const actual = Object.keys(descriptors).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index]) ||
      actual.some((key) => !descriptors[key].enumerable || !Object.hasOwn(descriptors[key], "value"))) {
    throw new TypeError(`${label} has an invalid shape`);
  }
  return Object.fromEntries(keys.map((key) => [key, descriptors[key].value]));
}
function dense(value, maximum, label) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype ||
      value.length > maximum || Object.getOwnPropertySymbols(value).length !== 0) {
    throw new TypeError(`${label} must be a bounded plain array`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== value.length + 1) {
    throw new TypeError(`${label} must be dense`);
  }
  return Array.from({ length: value.length }, (_, index) => {
    const descriptor = descriptors[index];
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) {
      throw new TypeError(`${label} must be dense`);
    }
    return descriptor.value;
  });
}
function integer(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label} must be a bounded safe integer`);
  }
  return value;
}
function point(value, label) {
  const item = exact(value, ["x", "y"], label);
  return {
    x: integer(item.x, -MAX_POSITION, MAX_POSITION, `${label}.x`),
    y: integer(item.y, -MAX_POSITION, MAX_POSITION, `${label}.y`),
  };
}
function scalarBytes(text, label) {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const low = text.charCodeAt(index + 1);
      if (!(low >= 0xdc00 && low <= 0xdfff)) throw new TypeError(`${label} contains a lone surrogate`);
      bytes += 4;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new TypeError(`${label} contains a lone surrogate`);
    } else bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : 3;
  }
  return bytes;
}
function parsed(text, label) {
  if (typeof text !== "string") throw new TypeError(`${label} must be canonical JSON text`);
  if (scalarBytes(text, label) > MAX_BOUNDARY_BYTES) throw new RangeError(`${label} exceeds its byte bound`);
  let value;
  try { value = JSON.parse(text); } catch { throw new TypeError(`${label} must be valid JSON`); }
  const pending = [{ depth: 0, value }];
  let nodes = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    nodes += 1;
    if (nodes > MAX_BOUNDARY_NODES || current.depth > MAX_BOUNDARY_DEPTH) {
      throw new RangeError(`${label} exceeds its graph bound`);
    }
    const entry = current.value;
    if (entry === null || typeof entry === "boolean") continue;
    if (typeof entry === "number") {
      if (!Number.isSafeInteger(entry)) throw new TypeError(`${label} contains a non-safe integer`);
      continue;
    }
    if (typeof entry === "string") {
      scalarBytes(entry, label);
      continue;
    }
    if (!entry || typeof entry !== "object") throw new TypeError(`${label} contains an invalid value`);
    if (Array.isArray(entry)) {
      if (entry.length > MAX_BOUNDARY_NODES) throw new RangeError(`${label} exceeds its array bound`);
      for (let index = entry.length - 1; index >= 0; index -= 1) {
        pending.push({ depth: current.depth + 1, value: entry[index] });
      }
      continue;
    }
    if (Object.getPrototypeOf(entry) !== Object.prototype) throw new TypeError(`${label} contains a non-plain object`);
    const keys = Object.keys(entry);
    if (keys.length > 128) throw new RangeError(`${label} exceeds its key bound`);
    for (let index = keys.length - 1; index >= 0; index -= 1) {
      const key = keys[index];
      if (["__proto__", "constructor", "prototype"].includes(key)) {
        throw new TypeError(`${label} contains a forbidden key`);
      }
      scalarBytes(key, label);
      pending.push({ depth: current.depth + 1, value: entry[key] });
    }
  }
  if (canonical(value) !== text) throw new TypeError(`${label} must be canonical JSON`);
  return value;
}
function opposite(side) { return side === "north" ? "south" : "north"; }
function distanceSquared(left, right) {
  const dx = BigInt(left.x) - BigInt(right.x);
  const dy = BigInt(left.y) - BigInt(right.y);
  return dx * dx + dy * dy;
}
function withinDistance(left, right, distance) {
  const reach = BigInt(distance);
  return distanceSquared(left, right) <= reach * reach;
}
/** Fresh catalog metadata.  QUESTION-only identities are never materializable. */
export function createSessionBuildingCatalog(...args) {
  if (args.length !== 0) throw new TypeError("session building catalog takes no arguments");
  return freeze({
    admitted: SESSION_BUILDING_ADMITTED_IDS.map((id) => ({
      id, kind: "structure", mechanics: CLASS_BY_ID[id],
      ...(["defensive", "resource"].includes(CLASS_BY_ID[id])
        ? { policyDisposition: "question" } : {}),
    })),
    question: SESSION_BUILDING_QUESTION_IDS.map((id) => ({
      id,
      reason: "identity-only admission missing kind/cost/deploy fields",
      status: "question",
    })),
    version: 2,
  });
}

export function isSessionBuildingCardId(value) {
  return typeof value === "string" && ADMITTED.has(value);
}

function profileInteger(value, key, label, minimum = 0, maximum = MAX_DAMAGE) {
  return integer(value[key], minimum, maximum, `${label}.${key}`);
}

function checkedQuestionPolicy(value, fields, label, expectedSource) {
  const policy = exact(value, fields.map(([field]) => field), label);
  const confidence = expectedSource === "pre-evolutions-building-corpus-and-absent-resource-policy"
    ? "absent" : "unverified";
  const checked = {};
  for (const [field, sourceKey, expectedValue] of fields) {
    const recordKeys = expectedSource === null
      ? ["authoritative", "confidence", "disposition", "key", "provenance", "value"]
      : ["authoritative", "confidence", "disposition", "key", "source", "value"];
    const record = exact(policy[field], recordKeys, `${label}.${field}`);
    if (record.authoritative !== false || record.confidence !== confidence ||
        record.disposition !== "question" || record.key !== sourceKey ||
        canonical(record.value) !== canonical(expectedValue)) {
      throw new TypeError(`${label}.${field} must retain its exact QUESTION record`);
    }
    if (expectedSource !== null) {
      if (record.source !== expectedSource) {
        throw new TypeError(`${label}.${field} has invalid QUESTION provenance`);
      }
    } else {
      const provenance = exact(record.provenance,
        ["accessed", "document", "location", "statement"], `${label}.${field}.provenance`);
      if (provenance.accessed !== "2026-07-30" || provenance.document !== "SOURCES.md" ||
          provenance.location !== "Known limitations" ||
          provenance.statement !== "Card abilities, including death damage and crown-tower damage multipliers, are outside the common schema.") {
        throw new TypeError(`${label}.${field} has invalid QUESTION provenance`);
      }
    }
    checked[field] = clone(record);
  }
  return checked;
}

const DEFENSIVE_CORPUS_FIELDS = Object.freeze([
  "cost", "damage", "deployTicks", "firstHitTicks", "hitSpeedTicks",
  "hitpoints", "maxRange", "mode", "sightRange",
]);

function checkedDefensiveQuestionPolicy(value, cardId, label) {
  const policy = exact(value, ["confidence", "corpusFields", "disposition", "source"], label);
  if (policy.confidence !== "unverified" || policy.disposition !== "question" ||
      policy.source !== "pre-evolutions-building-corpus-and-unsourced-policy-fixture") {
    throw new TypeError(`${label} must retain its QUESTION disposition`);
  }
  const corpus = exact(policy.corpusFields, DEFENSIVE_CORPUS_FIELDS, `${label}.corpusFields`);
  const corpusFields = {};
  for (const key of DEFENSIVE_CORPUS_FIELDS) {
    const record = exact(corpus[key], ["authoritative", "confidence", "source", "value"],
      `${label}.corpusFields.${key}`);
    const authoritative = key === "cost" || cardId === "bulwark-needle" && key === "hitSpeedTicks";
    const source = key === "cost"
      ? "pinned-pre-march-2023-card-roster-identity"
      : "pinned-pre-march-2023-building-constants";
    if (record.authoritative !== authoritative ||
        record.confidence !== (authoritative ? "high" : "unverified") || record.source !== source ||
        !(record.value === null || typeof record.value === "string" ||
          Number.isSafeInteger(record.value))) {
      throw new TypeError(`${label}.corpusFields.${key} has invalid provenance`);
    }
    corpusFields[key] = {
      authoritative,
      confidence: authoritative ? "high" : "unverified",
      source,
      value: record.value,
    };
  }
  return {
    confidence: "unverified",
    corpusFields,
    disposition: "question",
    source: policy.source,
  };
}

const RESOURCE_V2_POLICY_METADATA = Object.freeze({
  cadenceAnchorPolicy: { authoritative: false, confidence: "absent", disposition: "question",
    key: "cadenceAnchorPolicy", source: "pre-evolutions-resource-consumer-semantics-question",
    value: "placement-tick-multiples-after-deployment" },
  cadenceResetPolicy: { authoritative: false, confidence: "absent", disposition: "question",
    key: "cadenceResetPolicy", source: "pre-evolutions-resource-consumer-semantics-question",
    value: "nonlethal-damage-does-not-reset-placement-relative-cadence" },
  deployTicks: { authoritative: false, confidence: "unverified", disposition: "question",
    key: "deploy_time", source: "pinned-pre-march-2023-building-constants" },
  destructionAmount: { authoritative: true, confidence: "high", disposition: "source-aligned",
    key: "mana_on_death", source: "https://supercell.com/en/games/clashroyale/blog/release-notes/balance-changes-april-2022/" },
  expiryOrderingPolicy: { authoritative: false, confidence: "absent", disposition: "question",
    key: "expiryOrderingPolicy", source: "pre-evolutions-resource-consumer-semantics-question",
    value: "expiry-transition-suppresses-cadence-and-grants-after-the-destruction-event" },
  hitpoints: { authoritative: false, confidence: "unverified", disposition: "question",
    key: "hitpoints", source: "pinned-pre-march-2023-building-constants" },
  generationAmount: { authoritative: false, confidence: "datamine-only", disposition: "question",
    key: "mana_collect_amount", source: "pinned-pre-march-2023-building-constants" },
  generationCadenceTicks: { authoritative: true, confidence: "high", disposition: "source-aligned",
    key: "mana_generate_time_ms", source: "https://supercell.com/en/games/clashroyale/blog/release-notes/balance-changes-april-2022/" },
  lifetimeTicks: { authoritative: true, confidence: "high", disposition: "source-aligned",
    key: "life_time", source: "https://supercell.com/en/games/clashroyale/blog/release-notes/balance-changes-april-2022/" },
  placementPolicy: { authoritative: false, confidence: "absent", disposition: "question",
    key: "placementPolicy", source: "pre-evolutions-resource-consumer-semantics-question",
    value: "ordinary-ground-entity-deployment-mask-at-building-center" },
  recipientPolicy: { authoritative: false, confidence: "absent", disposition: "question",
    key: "resourceRecipient", source: "pre-evolutions-resource-consumer-semantics-question",
    value: "building-owner" },
  resourceCapacity: { authoritative: false, confidence: "absent", disposition: "question",
    key: "mana_generate_limit", source: "pre-evolutions-resource-consumer-semantics-question", value: 10 },
  sameTickOrderingPolicy: { authoritative: false, confidence: "absent", disposition: "question",
    key: "sameTickOrderingPolicy", source: "pre-evolutions-resource-consumer-semantics-question",
    value: "combat-destruction-suppresses-cadence;spends-before-natural-generation-before-building-grants" },
  simultaneousGenerationOrder: { authoritative: false, confidence: "absent", disposition: "question",
    key: "simultaneousGenerationOrder", source: "pre-evolutions-resource-consumer-semantics-question",
    value: "ascending-positive-building-id" },
});

function checkedSharedHostResourcePolicy(value, profile, label) {
  const fields = Object.keys(RESOURCE_V2_POLICY_METADATA);
  const policy = exact(value, [...fields, "version"], label);
  if (policy.version !== 2) throw new TypeError(`${label}.version is unsupported`);
  const values = {
    deployTicks: profile.deployTicks,
    destructionAmount: profile.destructionAmount,
    generationAmount: profile.generationAmount,
    generationCadenceTicks: profile.generationCadenceTicks,
    hitpoints: profile.hitpoints,
    lifetimeTicks: profile.lifetimeTicks,
  };
  const checked = { version: 2 };
  for (const field of fields) {
    const record = exact(policy[field], ["authoritative", "confidence", "disposition", "key", "source", "value"],
      `${label}.${field}`);
    const expected = { ...RESOURCE_V2_POLICY_METADATA[field],
      ...(Object.hasOwn(values, field) ? { value: values[field] } : {}) };
    if (canonical(record) !== canonical(expected)) {
      throw new TypeError(`${label}.${field} has invalid source or QUESTION provenance`);
    }
    checked[field] = clone(record);
  }
  return checked;
}

function checkedProfile(value, cardId) {
  const expectedClass = CLASS_BY_ID[cardId];
  const label = `session building profile ${cardId}`;
  if (expectedClass === "defensive") {
    const profile = exact(value, ["areaDamageRadiusMillitiles", "class", "damage", "deployTicks",
      "firstHitTicks", "hitSpeedTicks", "hitpoints", "lifetimeTicks", "maxRangeMillitiles",
      "minRangeMillitiles", "policy", "rampStages", "rampThresholds", "targetMode", "variant"], label);
    if (profile.class !== expectedClass || !["air_and_ground", "ground"].includes(profile.targetMode) ||
        !["hidden", "plain", "ramp", "siege", "splash"].includes(profile.variant) ||
        (profile.areaDamageRadiusMillitiles !== null &&
          (!Number.isSafeInteger(profile.areaDamageRadiusMillitiles) ||
            profile.areaDamageRadiusMillitiles < 0 ||
            profile.areaDamageRadiusMillitiles > MAX_POSITION))) {
      throw new TypeError(`${label} is invalid`);
    }
    const result = {
      areaDamageRadiusMillitiles: profile.areaDamageRadiusMillitiles,
      class: expectedClass,
      damage: profileInteger(profile, "damage", label, 1),
      deployTicks: profileInteger(profile, "deployTicks", label, 0, MAX_TICK),
      firstHitTicks: profileInteger(profile, "firstHitTicks", label, 0, MAX_TICK),
      hitSpeedTicks: profileInteger(profile, "hitSpeedTicks", label, 1, MAX_TICK),
      hitpoints: profileInteger(profile, "hitpoints", label, 1),
      lifetimeTicks: profileInteger(profile, "lifetimeTicks", label, 1, MAX_TICK),
      maxRangeMillitiles: profileInteger(profile, "maxRangeMillitiles", label, 0, MAX_POSITION),
      minRangeMillitiles: profileInteger(profile, "minRangeMillitiles", label, 0, MAX_POSITION),
      policy: checkedDefensiveQuestionPolicy(profile.policy, cardId, `${label}.policy`),
      rampStages: dense(profile.rampStages, 8, `${label}.rampStages`).map((stage, index) =>
        integer(stage, 1, MAX_DAMAGE, `${label}.rampStages[${index}]`)),
      rampThresholds: dense(profile.rampThresholds, 8, `${label}.rampThresholds`).map((threshold, index) =>
        integer(threshold, 0, MAX_DAMAGE, `${label}.rampThresholds[${index}]`)),
      targetMode: profile.targetMode,
      variant: profile.variant,
    };
    if (result.minRangeMillitiles > result.maxRangeMillitiles ||
        result.rampStages.length === 0 || result.rampStages.length !== result.rampThresholds.length ||
        result.rampThresholds.some((threshold, index) => index > 0 &&
          threshold <= result.rampThresholds[index - 1]) ||
        (result.variant === "splash" && result.areaDamageRadiusMillitiles === null) ||
        (result.variant !== "splash" && result.areaDamageRadiusMillitiles !== null)) {
      throw new TypeError(`${label} has inconsistent defensive policy`);
    }
    return result;
  }
  if (expectedClass === "resource") {
    const v2 = Object.hasOwn(value, "destructionAmount") ||
      (value.policy !== null && typeof value.policy === "object" && Object.hasOwn(value.policy, "version"));
    const profile = exact(value, ["class", "deployTicks", "generationAmount",
      "generationCadenceTicks", "hitpoints", "lifetimeTicks", "policy",
      ...(v2 ? ["destructionAmount"] : [])], label);
    if (profile.class !== expectedClass) throw new TypeError(`${label} is invalid`);
    const result = { class: expectedClass,
      deployTicks: profileInteger(profile, "deployTicks", label, 0, MAX_TICK),
      generationAmount: profileInteger(profile, "generationAmount", label, 1, 10),
      generationCadenceTicks: profileInteger(profile, "generationCadenceTicks", label, 1, MAX_TICK),
      hitpoints: profileInteger(profile, "hitpoints", label, 1),
      lifetimeTicks: profileInteger(profile, "lifetimeTicks", label, 1, MAX_TICK) };
    if (v2) {
      result.destructionAmount = profileInteger(profile, "destructionAmount", label, 1, 10);
      result.policy = checkedSharedHostResourcePolicy(profile.policy, result,
        `${label}.policy`);
    } else {
      result.policy = checkedQuestionPolicy(profile.policy, [
        ["generationAmount", "generationAmount", result.generationAmount],
        ["generationCadenceTicks", "generationCadenceTicks", result.generationCadenceTicks],
        ["lifetimeTicks", "lifetimeTicks", result.lifetimeTicks],
      ], `${label}.policy`, "pre-evolutions-building-corpus-and-absent-resource-policy");
    }
    return result;
  }
  if (expectedClass === "travel") {
    const profile = exact(value, ["class", "deployTicks", "emergenceSpawnDelayTicks", "hitpoints",
      "lifetimeTicks", "travelSpeedMillitilesPerSecond", "policy"], label);
    if (profile.class !== expectedClass || profile.travelSpeedMillitilesPerSecond === MOVEMENT_SPEEDS.stationary ||
        !Object.values(MOVEMENT_SPEEDS).includes(profile.travelSpeedMillitilesPerSecond)) {
      throw new TypeError(`${label} is invalid`);
    }
    const result = { class: expectedClass,
      deployTicks: profileInteger(profile, "deployTicks", label, 0, MAX_TICK),
      emergenceSpawnDelayTicks: profileInteger(profile, "emergenceSpawnDelayTicks", label, 0, MAX_TICK),
      hitpoints: profileInteger(profile, "hitpoints", label, 1),
      lifetimeTicks: profileInteger(profile, "lifetimeTicks", label, 1, MAX_TICK),
      travelSpeedMillitilesPerSecond: profile.travelSpeedMillitilesPerSecond };
    result.policy = checkedQuestionPolicy(profile.policy, [
      ["emergenceSpawnDelayTicks", "emergenceSpawnDelayTicks", result.emergenceSpawnDelayTicks],
      ["lifetimeTicks", "lifetimeTicks", result.lifetimeTicks],
      ["travelSpeedMillitilesPerSecond", "travelSpeedMillitilesPerSecond",
        result.travelSpeedMillitilesPerSecond],
    ], `${label}.policy`, "pre-evolutions-building-corpus-and-unsourced-travel-policy");
    return result;
  }
  const profile = exact(value, ["class", "damage", "deathDamage", "deployTicks", "firstHitTicks",
    "hitSpeedTicks", "hitpoints", "policy", "radius", "rangeMillitiles", "targetMode",
    "towerModifier"], label);
  const modifier = exact(profile.towerModifier, ["denominator", "numerator"], `${label}.towerModifier`);
  if (profile.class !== expectedClass || profile.targetMode !== "ground") {
    throw new TypeError(`${label} is invalid`);
  }
  const result = { class: expectedClass,
    damage: profileInteger(profile, "damage", label, 1),
    deathDamage: profileInteger(profile, "deathDamage", label, 1),
    deployTicks: profileInteger(profile, "deployTicks", label, 0, MAX_TICK),
    firstHitTicks: profileInteger(profile, "firstHitTicks", label, 0, MAX_TICK),
    hitSpeedTicks: profileInteger(profile, "hitSpeedTicks", label, 1, MAX_TICK),
    hitpoints: profileInteger(profile, "hitpoints", label, 1),
    radius: profileInteger(profile, "radius", label, 0, MAX_POSITION),
    rangeMillitiles: profileInteger(profile, "rangeMillitiles", label, 0, MAX_POSITION),
    targetMode: profile.targetMode,
    towerModifier: { denominator: integer(modifier.denominator, 1, MAX_DAMAGE,
      `${label}.towerModifier.denominator`), numerator: integer(modifier.numerator, 0, MAX_DAMAGE,
      `${label}.towerModifier.numerator`) } };
  result.policy = checkedQuestionPolicy(profile.policy, [
    ["deathDamage", "damage", result.deathDamage],
    ["radius", "radius", result.radius],
    ["towerModifier", "towerModifier", result.towerModifier],
  ], `${label}.policy`, null);
  return result;
}

function checkedProfileReceipt(value) {
  const receipt = exact(value, ["profiles", "version"], "session building profile receipt");
  if (receipt.version !== 1) throw new TypeError("session building profile receipt version is unsupported");
  const profiles = new Map();
  for (const [index, raw] of dense(receipt.profiles, SESSION_BUILDING_ADMITTED_IDS.length,
    "session building profile receipt.profiles").entries()) {
    const entry = exact(raw, ["cardId", "profile"], `session building profile receipt.profiles[${index}]`);
    if (!ADMITTED.has(entry.cardId) || profiles.has(entry.cardId)) {
      throw new TypeError("session building profile receipt identities are invalid");
    }
    // This reducer is public but cannot be a second admission route.  Its
    // profile receipt is pinned to the same immutable catalog receipt that
    // LiveBattle checks before it reaches the host boundary.
    assertSessionBuildingProfileReceipt(entry.cardId, canonical(entry.profile),
      `session building profile receipt.profiles[${index}].profile`);
    profiles.set(entry.cardId, freeze(checkedProfile(entry.profile, entry.cardId)));
  }
  return profiles;
}

function checkedPlacement(value, profiles) {
  const route = exact(value, ["cardId", "destination", "id", "point", "side", "tick"],
    "session building placement receipt");
  if (!ADMITTED.has(route.cardId) || !profiles.has(route.cardId) || !SIDES.has(route.side)) {
    throw new TypeError("session building placement receipt has an unknown identity");
  }
  const id = integer(route.id, 1, Number.MAX_SAFE_INTEGER, "session building placement receipt.id");
  const tick = integer(route.tick, 0, MAX_TICK - 1, "session building placement receipt.tick");
  const placement = point(route.point, "session building placement receipt.point");
  const destination = route.destination === null ? null : point(route.destination,
    "session building placement receipt.destination");
  if ((route.cardId === "burrow-rig") !== (destination !== null)) {
    throw new TypeError("underground travel receipt must carry exactly one destination");
  }
  const legality = evaluateDeployment({ destroyedOpposingLaneTowers: [],
    placementClass: "ground_entity", point: placement, side: route.side });
  if (!legality.legal) throw new RangeError(`session building placement is illegal: ${legality.reason}`);
  return { cardId: route.cardId, destination, id, point: placement, side: route.side, tick };
}

function travelMovement(path, index, profile) {
  if (index >= path.length - 1) return serializeMovementState(createMovementState());
  return serializeMovementState(createMovementState({ direction: 1,
    speed: profile.travelSpeedMillitilesPerSecond }));
}

/**
 * Pure placement materializer.  `id` and `tick` are host receipts, never
 * allocated or advanced here.
 */
function materializeSessionBuildingStructure(receiptText, profiles) {
  const receipt = checkedPlacement(parsed(receiptText, "session building placement receipt"), profiles);
  const profile = profiles.get(receipt.cardId);
  const structure = {
    alive: true,
    cardId: receipt.cardId,
    class: profile.class,
    deathCause: null,
    deathTriggered: false,
    hitpoints: profile.hitpoints,
    id: receipt.id,
    maxHitpoints: profile.hitpoints,
    policy: clone(profile.policy),
    placedTick: receipt.tick,
    position: clone(receipt.point),
    side: receipt.side,
    targetable: true,
  };
  if (profile.class === "defensive") {
    structure.attackCycle = new AttackCycle({ deployTicks: profile.deployTicks,
      firstHitTicks: profile.firstHitTicks, hitSpeedTicks: profile.hitSpeedTicks }).serialize();
    structure.consecutiveHits = 0;
    structure.hidden = profile.variant === "hidden";
    structure.policy = clone(profile.policy);
    structure.targetKey = null;
    structure.targetable = !structure.hidden;
  } else if (profile.class === "resource") {
    structure.deployed = false;
  } else if (profile.class === "travel") {
    const path = findGroundPath(receipt.point, receipt.destination);
    if (path === null) throw new RangeError("underground travel destination has no ground path");
    structure.destination = clone(receipt.destination);
    structure.emergedTick = null;
    structure.movementPrimitive = travelMovement(path, 0, profile);
    structure.path = clone(path);
    structure.pathIndex = 0;
    structure.phase = "deploying";
    structure.spawnQuestionPublished = false;
    structure.targetable = false;
  } else if (profile.class === "death-effect") {
    structure.attackCycle = new AttackCycle({ deployTicks: profile.deployTicks,
      firstHitTicks: profile.firstHitTicks, hitSpeedTicks: profile.hitSpeedTicks }).serialize();
    structure.targetKey = null;
  } else {
    throw new Error("unsupported building profile class");
  }
  return freeze(clone(structure));
}

function checkedUnit(value, index) {
  const item = exact(value, ["alive", "id", "layer", "position", "radius", "side", "targetable"],
    `session building boundary.units[${index}]`);
  if (!SIDES.has(item.side) || !LAYERS.has(item.layer) || typeof item.alive !== "boolean" ||
      typeof item.targetable !== "boolean") {
    throw new TypeError(`session building boundary.units[${index}] is invalid`);
  }
  return { alive: item.alive, id: integer(item.id, 1, Number.MAX_SAFE_INTEGER,
    `session building boundary.units[${index}].id`), layer: item.layer,
  position: point(item.position, `session building boundary.units[${index}].position`),
  radius: integer(item.radius, 0, MAX_POSITION, `session building boundary.units[${index}].radius`),
  side: item.side, targetable: item.targetable };
}
function checkedTower(value, index) {
  const item = exact(value, ["hitpoints", "id", "position", "side"],
    `session building boundary.towers[${index}]`);
  if (typeof item.id !== "string" || item.id.length === 0 || !SIDES.has(item.side)) {
    throw new TypeError(`session building boundary.towers[${index}] is invalid`);
  }
  return { hitpoints: integer(item.hitpoints, 0, MAX_DAMAGE,
    `session building boundary.towers[${index}].hitpoints`), id: item.id,
  position: point(item.position, `session building boundary.towers[${index}].position`), side: item.side };
}
function checkedStructure(value, index, profiles) {
  const label = `session building boundary.structures[${index}]`;
  // The reducer receives a JSON boundary, not an arbitrary live object.  Its
  // class-specific state is deliberately closed here so a hostile receipt
  // cannot smuggle a field that changes a later reducer branch after the host
  // has started its candidate tick.
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype || !Object.hasOwn(value, "cardId") ||
      !Object.hasOwn(value, "class") || !ADMITTED.has(value.cardId) || typeof value.class !== "string") {
    throw new TypeError(`session building boundary.structures[${index}] is invalid`);
  }
  const profile = profiles.get(value.cardId);
  if (profile === undefined) throw new TypeError("session building structure profile is not admitted by this host");
  if (profile.class !== value.class) throw new TypeError("session building structure profile diverges");
  const common = ["alive", "cardId", "class", "deathCause", "deathTriggered", "hitpoints", "id",
    "maxHitpoints", "policy", "placedTick", "position", "side", "targetable"];
  const extra = profile.class === "defensive"
    ? ["attackCycle", "consecutiveHits", "hidden", "targetKey"]
    : profile.class === "resource"
      ? ["deployed"]
      : profile.class === "travel"
        ? ["destination", "emergedTick", "movementPrimitive", "path", "pathIndex", "phase",
          "spawnQuestionPublished"]
        : ["attackCycle", "targetKey"];
  const raw = exact(value, [...common, ...extra], label);
  if (!SIDES.has(raw.side) || typeof raw.alive !== "boolean" ||
      typeof raw.targetable !== "boolean" || typeof raw.deathTriggered !== "boolean" ||
      ![null, "combat-damage", "expiry"].includes(raw.deathCause)) {
    throw new TypeError(`${label} is invalid`);
  }
  integer(raw.id, 1, Number.MAX_SAFE_INTEGER, `session building boundary.structures[${index}].id`);
  integer(raw.hitpoints, 0, MAX_DAMAGE, `session building boundary.structures[${index}].hitpoints`);
  integer(raw.maxHitpoints, 1, MAX_DAMAGE, `session building boundary.structures[${index}].maxHitpoints`);
  integer(raw.placedTick, 0, MAX_TICK - 1, `session building boundary.structures[${index}].placedTick`);
  point(raw.position, `session building boundary.structures[${index}].position`);
  if (raw.maxHitpoints !== profile.hitpoints || raw.hitpoints > raw.maxHitpoints ||
      (raw.alive && (raw.hitpoints === 0 || raw.deathCause !== null)) ||
      (!raw.alive && (raw.hitpoints !== 0 || raw.targetable)) ||
      (profile.class !== "death-effect" &&
        !(profile.class === "resource" && profile.policy.version === 2) && raw.deathTriggered)) {
    throw new TypeError("session building structure hitpoints or life state diverges");
  }
  if (canonical(raw.policy) !== canonical(profile.policy)) {
    throw new TypeError(`${label} building policy provenance diverges`);
  }
  if (profile.class === "defensive") {
    if (typeof raw.attackCycle !== "string" || !Number.isSafeInteger(raw.consecutiveHits) ||
        raw.consecutiveHits < 0 || typeof raw.hidden !== "boolean" ||
        (raw.targetKey !== null && typeof raw.targetKey !== "string") ||
        raw.targetable !== (raw.alive && !raw.hidden)) {
      throw new TypeError(`${label} defensive state is invalid`);
    }
    // This validates its nested graph and phase invariants before the reducer
    // can call step() on it.  Re-serialization rejects alternate JSON spellings.
    if (AttackCycle.restore(raw.attackCycle).serialize() !== raw.attackCycle) {
      throw new TypeError(`${label} attack cycle must be canonical`);
    }
  } else if (profile.class === "resource") {
    const version2 = profile.policy.version === 2;
    if (typeof raw.deployed !== "boolean" || raw.targetable !== raw.alive ||
        (version2 && !raw.alive && !["combat-damage", "expiry"].includes(raw.deathCause)) ||
        (version2 && raw.deathTriggered && (raw.alive ||
          !["combat-damage", "expiry"].includes(raw.deathCause)))) {
      throw new TypeError(`${label} resource state is invalid`);
    }
  } else if (profile.class === "travel") {
    if (typeof raw.emergedTick !== "number" && raw.emergedTick !== null ||
        (raw.emergedTick !== null && (!Number.isSafeInteger(raw.emergedTick) || raw.emergedTick < 0 ||
          raw.emergedTick >= MAX_TICK)) || typeof raw.movementPrimitive !== "string" ||
        !["dead", "deploying", "emerged", "underground"].includes(raw.phase) ||
        !Number.isSafeInteger(raw.pathIndex) || raw.pathIndex < 0 ||
        typeof raw.spawnQuestionPublished !== "boolean") {
      throw new TypeError(`${label} travel state is invalid`);
    }
    point(raw.destination, `${label}.destination`);
    const path = dense(raw.path, 1_024, `${label}.path`).map((entry, pathIndex) =>
      point(entry, `${label}.path[${pathIndex}]`));
    if (path.length < 1 || raw.pathIndex >= path.length ||
        canonical(path[path.length - 1]) !== canonical(raw.destination)) {
      throw new TypeError(`${label} travel path is invalid`);
    }
    if (serializeMovementState(restoreMovementState(raw.movementPrimitive)) !== raw.movementPrimitive) {
      throw new TypeError(`${label} movement state must be canonical`);
    }
    if ((raw.phase === "emerged") !== raw.targetable ||
        (raw.phase === "dead") !== !raw.alive ||
        ((raw.phase === "deploying" || raw.phase === "underground") && raw.targetable)) {
      throw new TypeError(`${label} travel life state is invalid`);
    }
  } else if (typeof raw.attackCycle !== "string" ||
      (raw.targetKey !== null && typeof raw.targetKey !== "string") ||
      AttackCycle.restore(raw.attackCycle).serialize() !== raw.attackCycle || raw.targetable !== raw.alive ||
      (raw.deathTriggered && (raw.alive || raw.deathCause !== "combat-damage"))) {
    throw new TypeError(`${label} death-effect state is invalid`);
  }
  return clone(raw);
}

/**
 * Bounded data-only normalization used by the host before it adopts a
 * reducer replacement intent.  This is intentionally not a second runtime:
 * it allocates nothing and advances no state; it simply applies the same
 * closed snapshot contract that the reducer accepts at its boundary.
 */
function validateSessionBuildingStructure(structureText, profiles) {
  return freeze(checkedStructure(parsed(structureText, "session building structure receipt"), 0, profiles));
}

function checkedBoundary(value, profiles) {
  const item = exact(value, ["structures", "tick", "towers", "units"], "session building boundary");
  const tick = integer(item.tick, 0, MAX_TICK - 1, "session building boundary.tick");
  const structures = dense(item.structures, SESSION_BUILDING_MAX_STRUCTURES,
    "session building boundary.structures").map((structure, index) =>
      checkedStructure(structure, index, profiles)).sort((left, right) => left.id - right.id);
  const units = dense(item.units, 1_024, "session building boundary.units").map(checkedUnit)
    .sort((left, right) => left.id - right.id);
  const towers = dense(item.towers, 6, "session building boundary.towers").map(checkedTower)
    .sort((left, right) => left.id.localeCompare(right.id));
  const ids = new Set();
  for (const structure of structures) {
    if (ids.has(structure.id)) throw new TypeError("session building structure IDs must be unique");
    ids.add(structure.id);
  }
  for (const unit of units) {
    if (ids.has(unit.id)) throw new TypeError("session building unit IDs collide with structures");
    ids.add(unit.id);
  }
  if (new Set(towers.map(({ id }) => id)).size !== towers.length) {
    throw new TypeError("session building tower IDs must be unique");
  }
  return { structures, tick, towers, units };
}
function candidateKey(kind, id) { return `${kind}:${id}`; }
function candidateList(structure, boundary, profile) {
  const side = opposite(structure.side);
  const candidates = [];
  for (const unit of boundary.units) {
    if (!unit.alive || !unit.targetable || unit.side !== side ||
        (profile.targetMode === "ground" && unit.layer !== "ground")) continue;
    candidates.push({ cycleId: unit.id, id: unit.id, key: candidateKey("unit", unit.id), kind: "unit", layer: unit.layer,
      position: unit.position, radius: unit.radius });
  }
  for (const entry of boundary.structures) {
    if (!entry.alive || !entry.targetable || entry.side !== side) continue;
    candidates.push({ cycleId: entry.id, id: entry.id, key: candidateKey("structure", entry.id), kind: "structure",
      layer: "ground", position: entry.position, radius: 0 });
  }
  for (const tower of boundary.towers) {
    if (tower.hitpoints <= 0 || tower.side !== side) continue;
    const cycleId = TOWER_CYCLE_IDS.get(tower.id);
    if (cycleId === undefined) throw new TypeError("session building boundary tower identity is unknown");
    candidates.push({ cycleId, id: tower.id, key: candidateKey("tower", tower.id), kind: "tower", layer: "ground",
      position: tower.position, radius: 0 });
  }
  const maximum = profile.maxRangeMillitiles ?? profile.rangeMillitiles;
  const minimum = profile.minRangeMillitiles ?? 0;
  return candidates.filter((candidate) => {
    const reach = maximum + candidate.radius;
    if (!withinDistance(structure.position, candidate.position, reach)) return false;
    return minimum === 0 || !withinDistance(structure.position, candidate.position,
      Math.max(0, minimum - 1));
  }).sort((left, right) => {
    const leftDistance = distanceSquared(structure.position, left.position);
    const rightDistance = distanceSquared(structure.position, right.position);
    if (leftDistance !== rightDistance) return leftDistance < rightDistance ? -1 : 1;
    return left.key.localeCompare(right.key);
  });
}
function selectTarget(structure, boundary, profile) {
  const candidates = candidateList(structure, boundary, profile);
  return candidates.find(({ key }) => key === structure.targetKey) ?? candidates[0] ?? null;
}
function event(intents, value) { intents.push({ type: "event", value }); }
function replace(intents, structure) { intents.push({ structure, type: "replace-structure" }); }
function queueHit(intents, boundary, structure, target, amount, origin) {
  intents.push({ amount, applyTick: boundary.tick + 1, origin, sourceId: structure.id,
    targetId: target.id, targetKind: target.kind, type: "queue-hit" });
}
function destroy(next, cause) {
  next.alive = false;
  next.deathCause = cause;
  next.hitpoints = 0;
  next.targetable = false;
  if (next.class === "travel") next.phase = "dead";
}
function buildDefensiveIntents(intents, boundary, structure, profile) {
  const next = clone(structure);
  const age = boundary.tick - next.placedTick;
  if (age >= profile.lifetimeTicks) {
    destroy(next, "expiry");
    replace(intents, next);
    event(intents, { buildingId: next.id, cause: "expiry", reason: "lifetime", tick: boundary.tick,
      type: "structure-destroyed" });
    return;
  }
  const target = selectTarget(next, boundary, profile);
  const prior = next.targetKey;
  next.targetKey = target?.key ?? null;
  if (profile.variant === "hidden") {
    const hidden = target === null;
    if (next.hidden !== hidden) {
      next.hidden = hidden;
      next.targetable = !hidden;
      event(intents, { buildingId: next.id, tick: boundary.tick,
        type: hidden ? "building-hidden" : "building-revealed" });
    }
  }
  if (profile.variant === "ramp" && prior !== null && prior !== next.targetKey) {
    next.consecutiveHits = 0;
    event(intents, { buildingId: next.id, reason: "target-change-or-loss", tick: boundary.tick,
      type: "ramp-reset" });
  }
  const cycle = AttackCycle.restore(next.attackCycle);
  const ready = cycle.step({ targetEligible: target !== null, targetId: target?.cycleId ?? null });
  next.attackCycle = cycle.serialize();
  for (const readyEvent of ready) {
    const stageIndex = profile.variant === "ramp" ? Math.max(0, profile.rampThresholds
      .findLastIndex((threshold) => next.consecutiveHits >= threshold)) : 0;
    const amount = profile.variant === "ramp" ? profile.rampStages[stageIndex] : profile.damage;
    event(intents, { amount, buildingId: next.id, targetId: target.id, tick: boundary.tick,
      type: "structure-attack" });
    if (profile.variant === "splash") {
      const targets = candidateList(next, boundary, { ...profile, minRangeMillitiles: 0,
        // Target eligibility belongs to the impact circle, not a second
        // source-to-candidate range check.  The primary target has already
        // passed this building's real maximum/minimum range; every eligible
        // enemy in its inclusive impact radius receives the same contact.
        maxRangeMillitiles: MAX_POSITION, targetMode: "air_and_ground" })
        .filter((candidate) => withinDistance(target.position, candidate.position,
          profile.areaDamageRadiusMillitiles));
      for (const candidate of targets) queueHit(intents, boundary, next, candidate, amount,
        "defensive-splash");
    } else queueHit(intents, boundary, next, target, amount, "defensive-attack");
    if (profile.variant === "ramp") {
      next.consecutiveHits += 1;
      event(intents, { buildingId: next.id, consecutiveHits: next.consecutiveHits, stageIndex,
        targetId: target.id, tick: boundary.tick, type: "ramp-contact" });
    }
    void readyEvent;
  }
  replace(intents, next);
}
function buildResourceIntents(intents, boundary, structure, profile) {
  const next = clone(structure);
  const version2 = profile.policy.version === 2;
  let grant = null;
  if (!next.alive) {
    if (version2 && !next.deathTriggered) {
      next.deathTriggered = true;
      event(intents, { amount: profile.destructionAmount, buildingId: next.id,
        cause: next.deathCause, recipientSide: next.side, tick: boundary.tick,
        type: "building-resource-payout-triggered" });
      grant = { amount: profile.destructionAmount, side: next.side, sourceId: next.id,
        tick: boundary.tick, type: "resource-grant" };
      replace(intents, next);
      intents.push(grant);
    }
    return;
  }
  const age = boundary.tick - next.placedTick;
  if (age >= profile.lifetimeTicks) {
    destroy(next, "expiry");
    event(intents, { buildingId: next.id, cause: "expiry", reason: "lifetime", tick: boundary.tick,
      type: "structure-destroyed" });
  } else {
    if (!next.deployed && age === profile.deployTicks) {
      next.deployed = true;
      event(intents, { buildingId: next.id, side: next.side, tick: boundary.tick,
        type: "building-deployed" });
    }
    if (next.deployed && age > 0 && age % profile.generationCadenceTicks === 0) {
      grant = { amount: profile.generationAmount, side: next.side, sourceId: next.id,
        tick: boundary.tick, type: "resource-grant" };
      if (version2) {
        event(intents, { amount: profile.generationAmount, buildingId: next.id,
          tick: boundary.tick, type: "building-resource-cadence-triggered" });
      }
    }
  }
  if (version2 && !next.alive && !next.deathTriggered) {
    next.deathTriggered = true;
    event(intents, { amount: profile.destructionAmount, buildingId: next.id,
      cause: next.deathCause, recipientSide: next.side, tick: boundary.tick,
      type: "building-resource-payout-triggered" });
    grant = { amount: profile.destructionAmount, side: next.side, sourceId: next.id,
      tick: boundary.tick, type: "resource-grant" };
  }
  replace(intents, next);
  if (grant !== null) intents.push(grant);
}
function emerge(intents, boundary, next) {
  next.emergedTick = boundary.tick;
  next.movementPrimitive = serializeMovementState(createMovementState());
  next.phase = "emerged";
  next.position = clone(next.destination);
  next.targetable = true;
  event(intents, { buildingId: next.id, position: clone(next.position), tick: boundary.tick,
    type: "travel-building-emerged" });
}
function buildTravelIntents(intents, boundary, structure, profile) {
  const next = clone(structure);
  const age = boundary.tick - next.placedTick;
  if (next.phase === "deploying" && age === profile.deployTicks) {
    next.phase = "underground";
    event(intents, { buildingId: next.id, destination: clone(next.destination), path: clone(next.path),
      tick: boundary.tick, type: "underground-travel-started" });
    if (next.path.length === 1) emerge(intents, boundary, next);
  } else if (next.phase === "underground") {
    const from = next.path[next.pathIndex];
    const to = next.path[next.pathIndex + 1];
    const segment = Math.abs(to.x - from.x) + Math.abs(to.y - from.y);
    const movement = advanceMovement(restoreMovementState(next.movementPrimitive), 1);
    const progress = Math.min(segment, movement.position);
    next.position = { x: from.x + Math.sign(to.x - from.x) * progress,
      y: from.y + Math.sign(to.y - from.y) * progress };
    event(intents, { buildingId: next.id, pathIndex: next.pathIndex, position: clone(next.position),
      tick: boundary.tick, type: "underground-travel-moved" });
    if (movement.position < segment) next.movementPrimitive = serializeMovementState(movement);
    else {
      next.pathIndex += 1;
      next.movementPrimitive = travelMovement(next.path, next.pathIndex, profile);
      if (next.pathIndex === next.path.length - 1) emerge(intents, boundary, next);
    }
  }
  if (next.phase === "emerged" && !next.spawnQuestionPublished &&
      boundary.tick === next.emergedTick + profile.emergenceSpawnDelayTicks) {
    next.spawnQuestionPublished = true;
    // The corpus establishes that a unit appears, but gives no sourced runtime
    // identity/stats.  Publishing this omission is safer than fabricating a
    // detached placeholder troop or a second unit authority.
    event(intents, { buildingId: next.id, reason: "spawn identity and combat fields are unsourced",
      tick: boundary.tick, type: "travel-emergence-spawn-question" });
  }
  if (next.phase === "emerged" && boundary.tick === next.emergedTick + profile.lifetimeTicks) {
    destroy(next, "expiry");
    event(intents, { buildingId: next.id, cause: "expiry", reason: "lifetime", tick: boundary.tick,
      type: "travel-building-destroyed" });
  }
  replace(intents, next);
}
function buildDeathEffectIntents(intents, boundary, structure, profile) {
  const next = clone(structure);
  if (!next.alive) {
    if (next.deathCause === "combat-damage" && !next.deathTriggered) {
      next.deathTriggered = true;
      event(intents, { sourceId: next.id, tick: boundary.tick, type: "death-effect-triggered" });
      const targets = candidateList(next, boundary, { maxRangeMillitiles: profile.radius,
        minRangeMillitiles: 0, targetMode: "ground" }).filter((target) =>
        withinDistance(next.position, target.position, profile.radius));
      for (const target of targets) {
        const amount = target.kind === "tower"
          ? Number(BigInt(profile.deathDamage) * BigInt(profile.towerModifier.numerator) /
            BigInt(profile.towerModifier.denominator))
          : profile.deathDamage;
        event(intents, { amount, origin: "death-effect", sourceId: next.id, targetId: target.id,
          tick: boundary.tick, type: "death-effect-hit" });
        queueHit(intents, boundary, next, target, amount, "death-effect");
      }
      replace(intents, next);
    }
    return;
  }
  const target = selectTarget(next, boundary, profile);
  next.targetKey = target?.key ?? null;
  const cycle = AttackCycle.restore(next.attackCycle);
  const ready = cycle.step({ targetEligible: target !== null, targetId: target?.cycleId ?? null });
  next.attackCycle = cycle.serialize();
  for (const readyEvent of ready) {
    event(intents, { amount: profile.damage, buildingId: next.id, targetId: target.id,
      tick: boundary.tick, type: "structure-attack" });
    queueHit(intents, boundary, next, target, profile.damage, "defensive-attack");
    void readyEvent;
  }
  replace(intents, next);
}

/**
 * Reduce exactly one host-owned shared tick.  The return value is data only;
 * LiveBattle validates every replacement/contact/grant before mutating its
 * own battle state.  No intent can advance a clock or allocate an identity.
 */
function reduceSessionBuildingBoundary(boundaryText, profiles) {
  const boundary = checkedBoundary(parsed(boundaryText, "session building boundary"), profiles);
  const intents = [];
  for (const structure of boundary.structures) {
    if (structure.class === "defensive" && structure.alive) {
      buildDefensiveIntents(intents, boundary, structure, profiles.get(structure.cardId));
    } else if (structure.class === "resource") {
      buildResourceIntents(intents, boundary, structure, profiles.get(structure.cardId));
    } else if (structure.class === "travel" && structure.alive) {
      buildTravelIntents(intents, boundary, structure, profiles.get(structure.cardId));
    } else if (structure.class === "death-effect") {
      buildDeathEffectIntents(intents, boundary, structure, profiles.get(structure.cardId));
    }
    if (intents.length > SESSION_BUILDING_MAX_INTENTS) {
      throw new RangeError("session building runtime intent bound exceeded");
    }
  }
  return freeze({ intents: intents.map((intent, order) => freeze({ ...clone(intent), order })),
    tick: boundary.tick, version: 1 });
}

/**
 * Creates the pure reducer capability for one host-admitted roster. The
 * profile receipt is canonical data from LiveBattle's already-validated
 * roster; this module never imports a content catalog or retains mutable
 * battle state. Its three methods all consume canonical receipts and have no
 * independently advancing clock.
 */
export function createSessionBuildingRuntime(profileReceiptText) {
  const profiles = checkedProfileReceipt(parsed(profileReceiptText, "session building profile receipt"));
  return freeze({
    materializePlacement(receiptText) {
      return materializeSessionBuildingStructure(receiptText, profiles);
    },
    reduceBoundary(boundaryText) {
      return reduceSessionBuildingBoundary(boundaryText, profiles);
    },
    validateStructureReceipt(structureText) {
      return validateSessionBuildingStructure(structureText, profiles);
    },
  });
}

/** Explicit identity-only status; these IDs are never accepted by the reducer. */
export function isSessionBuildingQuestionId(value) {
  return typeof value === "string" && QUESTION.has(value);
}
