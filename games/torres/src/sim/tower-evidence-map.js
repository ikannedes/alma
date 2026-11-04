const BATTLE_IDS = Object.freeze([
  "south:central",
  "south:lane:west",
  "south:lane:east",
  "north:central",
  "north:lane:west",
  "north:lane:east",
]);
const MATCH_IDS = Object.freeze([
  "north:central",
  "north:lane:left",
  "north:lane:right",
  "south:central",
  "south:lane:left",
  "south:lane:right",
]);
const ID_MAP = Object.freeze({
  "north:central": "north:central",
  "north:lane:east": "north:lane:right",
  "north:lane:west": "north:lane:left",
  "south:central": "south:central",
  "south:lane:east": "south:lane:right",
  "south:lane:west": "south:lane:left",
});

function exactObject(value, keys, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype &&
        Object.getPrototypeOf(value) !== null)) {
    throw new TypeError(label + " must be a plain object");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const actual = Reflect.ownKeys(descriptors);
  if (actual.some((key) => typeof key !== "string")) {
    throw new TypeError(label + " must contain only string keys");
  }
  const sorted = [...actual].sort();
  const wanted = [...keys].sort();
  if (sorted.length !== wanted.length || sorted.some((key, index) => key !== wanted[index])) {
    throw new TypeError(label + " has an invalid shape");
  }
  const result = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
      throw new TypeError(label + "." + key + " must be an enumerable data property");
    }
    result[key] = descriptor.value;
  }
  return result;
}

function exactArray(value, label) {
  if (!Array.isArray(value)) throw new TypeError(label + " must be an array");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (key === "length") continue;
    if (typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length) {
      throw new TypeError(label + " must contain only indexed data");
    }
    const descriptor = descriptors[key];
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
      throw new TypeError(label + "[" + key + "] must be an enumerable data property");
    }
  }
  return Array.from(value);
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function evidenceFromHitpoints(hitpoints) {
  const towers = MATCH_IDS.map((id) => {
    const sourceId = BATTLE_IDS.find((candidate) => ID_MAP[candidate] === id);
    return { hitpoints: hitpoints[sourceId], id };
  });
  return {
    destroyedTowerIds: towers.filter((tower) => tower.hitpoints === 0).map((tower) => tower.id),
    towers,
  };
}

/** Pure live-battle-to-match mapping shared without importing either ownership kernel. */
export function mapLiveBattleTowerStateToMatchEvidence(towers) {
  const values = exactArray(towers, "live battle towers");
  if (values.length !== BATTLE_IDS.length) {
    throw new TypeError("live battle towers must contain all six towers");
  }
  const hitpoints = {};
  for (const [index, value] of values.entries()) {
    const tower = exactObject(value, ["active", "attack", "hitpoints", "id", "lane",
      "position", "role", "side"], "live battle towers[" + index + "]");
    if (!BATTLE_IDS.includes(tower.id) || Object.hasOwn(hitpoints, tower.id) ||
        !Number.isSafeInteger(tower.hitpoints) || tower.hitpoints < 0) {
      throw new TypeError("live battle towers[" + index + "] is invalid");
    }
    hitpoints[tower.id] = tower.hitpoints;
  }
  return deepFreeze(evidenceFromHitpoints(hitpoints));
}

export function mapBattleTowerIdToMatchTowerId(id) {
  if (typeof id !== "string" || !Object.hasOwn(ID_MAP, id)) {
    throw new TypeError("battle tower ID is unknown");
  }
  return ID_MAP[id];
}
