import { isPointInArena, validateArenaPoint } from "./arena-geometry.js";
import { appendCombatEffectEvent, appendCombatEffectRoot } from "./combat-effect-feed.js";
import { MAX_SPATIAL_MILLITILES } from "./spatial.js";

function checkedAreaImpact(value, currentTick, maxTick) {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) ||
      Object.getOwnPropertySymbols(value).length !== 0) {
    throw new TypeError("spell area impact must be a plain string-keyed data object");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const expected = ["center", "effectId", "radius", "targetIds", "tick"].sort();
  const actual = Reflect.ownKeys(descriptors).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError("spell area impact has an invalid shape");
  }
  for (const key of expected) {
    if (!descriptors[key].enumerable || !Object.hasOwn(descriptors[key], "value")) {
      throw new TypeError(`spell area impact.${key} must be an enumerable data property`);
    }
  }
  const raw = Object.fromEntries(expected.map((key) => [key, descriptors[key].value]));
  const tick = raw.tick;
  if (!Number.isSafeInteger(tick) || tick < 0 || tick > maxTick) {
    throw new TypeError("spell area impact.tick is outside the safe tick range");
  }
  if (tick !== currentTick) throw new RangeError("spell area impact tick must equal the current combat tick");
  const centerPoint = validateArenaPoint(raw.center, "spell area impact.center");
  if (!isPointInArena(centerPoint)) throw new RangeError("spell area impact.center must be inside the arena");
  if (!Number.isSafeInteger(raw.effectId) || raw.effectId < 1) {
    throw new TypeError("spell area impact.effectId must be a positive safe integer");
  }
  if (!Number.isSafeInteger(raw.radius) || raw.radius < 1 || raw.radius > MAX_SPATIAL_MILLITILES) {
    throw new TypeError("spell area impact.radius is outside spatial bounds");
  }
  if (!Array.isArray(raw.targetIds) || raw.targetIds.length > 1_024) {
    throw new TypeError("spell area impact.targetIds must be a bounded array");
  }
  const idDescriptors = Object.getOwnPropertyDescriptors(raw.targetIds);
  for (const key of Reflect.ownKeys(idDescriptors)) {
    if (key === "length") continue;
    if (typeof key !== "string" || !/^(0|[1-9]\d*)$/u.test(key) ||
        Number(key) >= raw.targetIds.length) {
      throw new TypeError("spell area impact.targetIds must contain only indexed data");
    }
  }
  const targetIds = Array.from({ length: raw.targetIds.length }, (_, index) => {
    const descriptor = idDescriptors[index];
    if (descriptor === undefined || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
      throw new TypeError(`spell area impact.targetIds[${index}] must be an enumerable data property`);
    }
    const id = descriptor.value;
    if (!Number.isSafeInteger(id) || id < 1) {
      throw new TypeError(`spell area impact.targetIds[${index}] must be a positive safe integer`);
    }
    return id;
  });
  if (new Set(targetIds).size !== targetIds.length) {
    throw new TypeError("spell area impact target IDs must be unique");
  }
  targetIds.sort((left, right) => left - right);
  return { center: { x: centerPoint.x, y: centerPoint.y },
    effectId: raw.effectId, radius: raw.radius, targetIds, tick };
}

function appendSpellAreaImpact(feed, impact) {
  const root = appendCombatEffectRoot(feed, {
    direction: "area", effectId: impact.effectId, from: impact.center,
    impactTick: impact.tick, projectileId: null, radius: impact.radius, segments: [],
    sequence: null, sourceId: null, tick: impact.tick, to: null, type: "area",
  });
  const applied = appendCombatEffectEvent(feed, {
    parentId: root.eventId,
    payload: { center: impact.center, radius: impact.radius, targetIds: impact.targetIds },
    phase: "impact", rootId: root.rootId, tick: impact.tick, type: "area",
  });
  appendCombatEffectEvent(feed, {
    parentId: applied.eventId, payload: { reason: "complete" },
    phase: "close", rootId: root.rootId, tick: impact.tick, type: "area",
  });
}

export { appendSpellAreaImpact, checkedAreaImpact };
