export const AUDIO_EVENT_VERSION = 1;
export const AUDIO_EVENT_MAX_RECORDS = 16_384;
export const AUDIO_EVENT_MAX_TICK = 18_000;
export const AUDIO_EVENT_MAX_SNAPSHOT_BYTES = 4_194_304;

export const AUDIO_CUE_TAXONOMY = deepFreeze({
  attack: "strike-release",
  crown: "crown-award",
  damage: "vital-damage",
  death: "unit-fall",
  deploy: "field-deploy",
  impact: "contact-impact",
  launch: "bolt-flight",
  matchEnd: "match-complete",
  overtime: "phase-overtime",
  tiebreak: "phase-tiebreak",
  tower: "tower-fall",
});

// The original simulation taxonomy remains a stable public contract.  The
// production taxonomy is a superset used by the polished renderer and by the
// authenticated UI seam.  Keeping the legacy object unchanged means existing
// replay consumers continue to see the same enumerable event families while
// new audio identities can be admitted with their own provenance.
export const AUDIO_PRODUCTION_CUE_TAXONOMY = deepFreeze({
  ...AUDIO_CUE_TAXONOMY,
  movement: "soft-locomotion",
  cardSelect: "card-select",
  cardPlay: "card-play",
  uiConfirm: "ui-confirm",
  uiReject: "ui-reject",
  uiToggle: "ui-toggle",
});

export const AUDIO_UNKNOWN_EVENT_POLICY = "explicit-no-cue";

const DEPLOY_TYPES = new Set([
  "building-deployed", "card-play", "clone-cast", "deployed", "play",
  "spawn", "spawn-batch", "spawn-spell-batch", "spawn-spell-cast",
  "spawn-spell-child", "unit-cloned",
]);
const ATTACK_TYPES = new Set([
  "attack", "attack-launched", "attack-ready",
  "shot-ready",
]);
const LAUNCH_TYPES = new Set([
  "attack-projectile-launched", "chain-start", "dash-launched", "jump-takeoff",
  "launch", "pellet-volley-launch", "periodic-cast", "pierce-launch",
  "projectile-launch", "projectile-launched", "return-launch", "roll-launch",
  "spell-cast", "target-kill-projectile-launched", "three-wave-cast",
  "three-wave-launch", "travel-launch",
]);
const IMPACT_TYPES = new Set([
  "attack-contact", "chain-hit", "hit", "impact", "pellet-contact", "pierce-hit",
  "projectile-contact", "projectile-impact", "return-contact", "return-hit",
  "roll-contact", "roll-hit", "spawn-spell-impact", "spell-hit", "spell-impact",
  "three-wave-contact", "three-wave-hit", "three-wave-impact", "travel-contact",
  "travel-impact",
]);
const DAMAGE_TYPES = new Set([
  "body-damage", "building-damaged", "chain-damage", "damage", "damage-applied",
  "dash-damage", "pellet-aggregate-damage", "pellet-damage", "projectile-damage",
  "roll-damage", "shield-damage", "spell-damage", "three-wave-damage",
  "travel-building-damaged",
]);
const DEATH_TYPES = new Set([
  "building-destroyed", "chain-death", "death", "died", "pellet-death",
  "projectile-death", "roll-death", "shield-break", "source-killed",
  "spell-death", "target-destroyed", "target-died", "three-wave-death", "travel-building-destroyed",
  "travel-source-died", "travel-target-died",
]);
const TOWER_TYPES = new Set(["tower-destroyed"]);
const MOVEMENT_TYPES = new Set([
  "locomotion-start", "movement-begin", "movement-start", "unit-move-start",
  "unit-moved-start", "walk-start",
]);
const MOVEMENT_MIN_INTERVAL_TICKS = 12;
const MATCH_TOWER_IDS = Object.freeze([
  "north:central", "north:lane:left", "north:lane:right",
  "south:central", "south:lane:left", "south:lane:right",
]);
const MATCH_TOWER_ID_SET = new Set(MATCH_TOWER_IDS);
const IRRELEVANT_TYPES = new Set([
  "acquire-target", "advance", "cast", "charge-armed", "charge-consumed", "charge-reset",
  "combat-reset", "cooldown-ended", "death-triggered", "deploy", "effect",
  "encounter-complete",
  "form-transition", "generated", "grant", "heal", "hide-applied",
  "interrupted", "lethal", "move", "moved", "pierce-command", "pierce-complete",
  "projectile-fizzle", "reveal-applied", "return-command", "return-complete",
  "return-turn", "roll-expired", "roll-stopped", "slow-applied", "slow-expired",
  "source-expired", "spend", "stage-changed", "stun-applied", "stun-expired",
  "target", "target-acquired", "target-lost", "targetability-changed",
  "time-advanced", "tower-activated", "travel-building-emerged",
  "underground-travel-moved", "underground-travel-started",
]);

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null) &&
    Object.getOwnPropertySymbols(value).length === 0;
}

function exactObject(value, keys, label) {
  if (!isPlainObject(value)) throw new TypeError(`${label} must be a plain object`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const actual = Reflect.ownKeys(descriptors);
  const wanted = [...keys].sort();
  if (
    actual.some((key) => typeof key !== "string") ||
    actual.length !== wanted.length ||
    [...actual].sort().some((key, index) => key !== wanted[index])
  ) throw new TypeError(`${label} has an invalid shape`);
  const result = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
      throw new TypeError(`${label}.${key} must be an enumerable data property`);
    }
    result[key] = descriptor.value;
  }
  return result;
}

function exactArray(value, label) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new TypeError(`${label} must be an array`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (key === "length") continue;
    if (typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length) {
      throw new TypeError(`${label} must contain only indexed data properties`);
    }
    const descriptor = descriptors[key];
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
      throw new TypeError(`${label}[${key}] must be an enumerable data property`);
    }
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) throw new TypeError(`${label} must not be sparse`);
  }
  return Array.from(value);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const result = {};
    for (const key of Object.keys(value).sort()) result[key] = canonicalize(value[key]);
    return result;
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function checkedJson(value, label, budget = { nodes: 0 }, depth = 0) {
  budget.nodes += 1;
  if (budget.nodes > 2_048) throw new RangeError(`${label} exceeds the node bound`);
  if (depth > 16) throw new RangeError(`${label} exceeds the depth bound`);
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new TypeError(`${label} numbers must be safe integers`);
    return value;
  }
  if (typeof value === "string") {
    if ([...value].length > 512) throw new RangeError(`${label} strings exceed the length bound`);
    return value;
  }
  if (Array.isArray(value)) {
    const values = exactArray(value, label);
    if (values.length > 256) throw new RangeError(`${label} exceeds the array bound`);
    return values.map((child, index) => checkedJson(child, `${label}[${index}]`, budget, depth + 1));
  }
  if (isPlainObject(value)) {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.length > 128) throw new RangeError(`${label} exceeds the key bound`);
    const result = {};
    for (const key of [...keys].sort()) {
      if (typeof key !== "string" || [...key].length > 128) {
        throw new TypeError(`${label} contains an invalid key`);
      }
      if (key === "__proto__" || key === "constructor" || key === "prototype") {
        throw new TypeError(`${label} contains an unsafe key`);
      }
      const descriptor = descriptors[key];
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
        throw new TypeError(`${label}.${key} must be an enumerable data property`);
      }
      result[key] = checkedJson(descriptor.value, `${label}.${key}`, budget, depth + 1);
    }
    return result;
  }
  throw new TypeError(`${label} must contain only canonical data`);
}

function checkedEntry(value, label) {
  const entry = exactObject(value, ["event", "sequence", "tick"], label);
  if (!Number.isSafeInteger(entry.sequence) || entry.sequence < 0) {
    throw new TypeError(`${label}.sequence must be a non-negative safe integer`);
  }
  if (!Number.isSafeInteger(entry.tick) || entry.tick < 0 || entry.tick > AUDIO_EVENT_MAX_TICK) {
    throw new TypeError(`${label}.tick must be an in-range non-negative safe integer`);
  }
  const event = checkedJson(entry.event, `${label}.event`);
  if (!isPlainObject(event) || typeof event.type !== "string" ||
      !/^[a-z0-9_-]{1,128}$/.test(event.type)) {
    throw new TypeError(`${label}.event.type must be a canonical event type`);
  }
  if (Object.hasOwn(event, "tick") && event.tick !== entry.tick) {
    throw new TypeError(`${label}.event.tick must match ${label}.tick`);
  }
  if (event.type === "tower_evidence") checkedTowerEvidenceEvent(event, `${label}.event`);
  return { event, sequence: entry.sequence, tick: entry.tick };
}

function checkedTowerEvidenceEvent(event, label) {
  if (event.accepted === true) {
    const checked = exactObject(
      event,
      ["accepted", "destroyedTowerIds", "sequence", "tick", "type"],
      label,
    );
    if (!Number.isSafeInteger(checked.sequence) || checked.sequence < 0) {
      throw new TypeError(`${label}.sequence must be a non-negative safe integer`);
    }
    const ids = exactArray(checked.destroyedTowerIds, `${label}.destroyedTowerIds`);
    if (ids.length > MATCH_TOWER_IDS.length) {
      throw new RangeError(`${label}.destroyedTowerIds exceeds the tower bound`);
    }
    let previousIndex = -1;
    for (let index = 0; index < ids.length; index += 1) {
      const towerIndex = MATCH_TOWER_IDS.indexOf(ids[index]);
      if (!MATCH_TOWER_ID_SET.has(ids[index]) || towerIndex <= previousIndex) {
        throw new TypeError(
          `${label}.destroyedTowerIds must contain unique canonical match tower IDs`,
        );
      }
      previousIndex = towerIndex;
    }
    return;
  }
  if (event.accepted === false) {
    const checked = exactObject(
      event,
      ["accepted", "reason", "sequence", "tick", "type"],
      label,
    );
    if (checked.reason !== "match_ended" ||
        !Number.isSafeInteger(checked.sequence) || checked.sequence < 0) {
      throw new TypeError(`${label} is not a canonical rejected tower evidence event`);
    }
    return;
  }
  throw new TypeError(`${label}.accepted must be a boolean`);
}

function cue(family, reason = "mapped") {
  return { cueId: AUDIO_PRODUCTION_CUE_TAXONOMY[family], family, reason };
}

function movementSourceKey(event) {
  for (const key of ["entityId", "sourceId", "unitId", "id"]) {
    const value = event[key];
    if (typeof value === "string" && /^[a-zA-Z0-9:_-]{1,128}$/.test(value)) {
      return `${key}:${value}`;
    }
    if (Number.isSafeInteger(value) && value >= 0) return `${key}:${value}`;
  }
  return null;
}

function isMovementStart(event) {
  if (MOVEMENT_TYPES.has(event.type)) return true;
  return (event.type === "move" || event.type === "moved") &&
    (event.phase === "start" || event.state === "start");
}

function classify(event, creditedTowerIds, movementLastTicks, sequence) {
  const type = event.type;
  if (DEPLOY_TYPES.has(type) && event.accepted === false) {
    return { cueId: null, family: null, reason: "rejected" };
  }
  if ((type === "impact" || type === "projectile-impact") && event.status !== "contact") {
    return { cueId: null, family: null, reason: "no-contact" };
  }
  if (type === "tower_evidence") {
    if (!event.accepted) {
      return { cueId: null, family: null, reason: "rejected-evidence" };
    }
    const newlyCredited = event.destroyedTowerIds.filter(
      (towerId) => !creditedTowerIds.has(towerId),
    );
    for (const towerId of newlyCredited) creditedTowerIds.add(towerId);
    return newlyCredited.length > 0
      ? cue("crown")
      : { cueId: null, family: null, reason: "no-new-destruction" };
  }
  if (type === "overtime_started") return cue("overtime");
  if (type === "tiebreak") return cue("tiebreak");
  if (type === "match_end") return cue("matchEnd");
  if (TOWER_TYPES.has(type)) return cue("tower");
  if (DEPLOY_TYPES.has(type)) return cue("deploy");
  if (ATTACK_TYPES.has(type)) return cue("attack");
  if (LAUNCH_TYPES.has(type)) return cue("launch");
  if (IMPACT_TYPES.has(type)) return cue("impact");
  if (DAMAGE_TYPES.has(type)) return cue("damage");
  if (DEATH_TYPES.has(type)) return cue("death");
  if (isMovementStart(event)) {
    const sourceKey = movementSourceKey(event) ?? `sequence:${sequence}`;
    const previousTick = movementLastTicks.get(sourceKey);
    if (previousTick !== undefined && event.tick - previousTick < MOVEMENT_MIN_INTERVAL_TICKS) {
      return { cueId: null, family: null, reason: "rate-limited" };
    }
    movementLastTicks.set(sourceKey, event.tick);
    return cue("movement");
  }
  return {
    cueId: null,
    family: null,
    reason: IRRELEVANT_TYPES.has(type) ? "irrelevant" : "unknown",
  };
}

function recordFor(entry, creditedTowerIds, movementLastTicks) {
  return deepFreeze({
    ...classify(entry.event, creditedTowerIds, movementLastTicks, entry.sequence),
    sequence: entry.sequence,
    tick: entry.tick,
    type: entry.event.type,
  });
}

function isolated(value) {
  return deepFreeze(JSON.parse(canonicalJson(value)));
}

function utf8Length(value) {
  return new TextEncoder().encode(value).byteLength;
}

const EMPTY_SNAPSHOT_BYTES = utf8Length(canonicalJson({
  entries: [],
  version: AUDIO_EVENT_VERSION,
}));

export class AudioEventProjection {
  #creditedTowerIds = new Set();
  #entryBytes = 0;
  #entries = [];
  #movementLastTicks = new Map();
  #records = [];
  #lastTick = null;

  get state() {
    return isolated({
      lastTick: this.#lastTick,
      nextSequence: this.#entries.length,
      recordCount: this.#records.length,
      creditedTowerIds: MATCH_TOWER_IDS.filter((towerId) =>
        this.#creditedTowerIds.has(towerId)),
    });
  }

  get records() {
    return isolated(this.#records);
  }

  get cues() {
    return isolated(this.#records.filter((record) => record.cueId !== null));
  }

  project(entry) {
    return this.projectBatch([entry])[0];
  }

  projectBatch(entries) {
    const values = exactArray(entries, "audio event batch");
    if (values.length > AUDIO_EVENT_MAX_RECORDS - this.#entries.length) {
      throw new RangeError(`audio event records cannot exceed ${AUDIO_EVENT_MAX_RECORDS}`);
    }
    const checked = [];
    let expectedSequence = this.#entries.length;
    let lastTick = this.#lastTick;
    for (let index = 0; index < values.length; index += 1) {
      const entry = checkedEntry(values[index], `audio event batch[${index}]`);
      if (entry.sequence !== expectedSequence) {
        throw new RangeError(`audio event batch[${index}].sequence must be ${expectedSequence}`);
      }
      if (lastTick !== null && entry.tick < lastTick) {
        throw new RangeError(`audio event batch[${index}].tick must not move backwards`);
      }
      checked.push(entry);
      expectedSequence += 1;
      lastTick = entry.tick;
    }
    let entryBytes = this.#entryBytes;
    for (let index = 0; index < checked.length; index += 1) {
      if (this.#entries.length + index > 0) entryBytes += 1;
      entryBytes += utf8Length(canonicalJson(checked[index]));
    }
    if (EMPTY_SNAPSHOT_BYTES + entryBytes > AUDIO_EVENT_MAX_SNAPSHOT_BYTES) {
      throw new RangeError("audio event history exceeds the snapshot byte bound");
    }
    const creditedTowerIds = new Set(this.#creditedTowerIds);
    const movementLastTicks = new Map(this.#movementLastTicks);
    const records = checked.map((entry) =>
      recordFor(entry, creditedTowerIds, movementLastTicks));
    this.#entries.push(...checked);
    this.#records.push(...records);
    this.#creditedTowerIds = creditedTowerIds;
    this.#movementLastTicks = movementLastTicks;
    this.#entryBytes = entryBytes;
    if (checked.length > 0) this.#lastTick = checked.at(-1).tick;
    return isolated(records);
  }

  serialize() {
    return canonicalJson({ entries: this.#entries, version: AUDIO_EVENT_VERSION });
  }

  static restore(serialized) {
    if (typeof serialized !== "string") throw new TypeError("audio snapshot must be a string");
    if (utf8Length(serialized) > AUDIO_EVENT_MAX_SNAPSHOT_BYTES) {
      throw new RangeError("audio snapshot exceeds the byte bound");
    }
    let parsed;
    try {
      parsed = JSON.parse(serialized);
    } catch {
      throw new TypeError("audio snapshot must be valid JSON");
    }
    const snapshot = exactObject(parsed, ["entries", "version"], "audio snapshot");
    if (snapshot.version !== AUDIO_EVENT_VERSION) throw new TypeError("audio snapshot version is unsupported");
    if (canonicalJson(parsed) !== serialized) throw new TypeError("audio snapshot must use canonical encoding");
    const projection = new AudioEventProjection();
    projection.projectBatch(snapshot.entries);
    return projection;
  }
}
