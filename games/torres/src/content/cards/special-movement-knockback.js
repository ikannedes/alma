import {
  ARENA_LENGTH_MILLITILES,
  ARENA_WIDTH_MILLITILES,
  isPointInArena,
} from "../../sim/arena-geometry.js";
import { validateCircle, validatePosition } from "../../sim/spatial.js";
import { createCardCatalog } from "../schema.js";

const DEFINITIONS = [{
  id: "squall-orb",
  displayName: "Squall Orb",
  cost: 4,
  kind: "effect",
  rarity: "uncommon",
  hitpoints: null,
  damage: 689,
  hitSpeedTicks: null,
  firstHitTicks: null,
  deployTimeTicks: null,
  rangeMillitiles: null,
  sightRangeMillitiles: null,
  movementMillitilesPerSecond: null,
  targetMode: "ground-and-air",
  count: 1,
  areaDamageRadiusMillitiles: 2500,
  components: [],
}];

const QUESTION_SOURCE = "unsourced-external-knockback-fixture";
const QUESTION_RECORDS = {
  arenaClamp: {
    key: "knockback-arena-clamp",
    value: "clamp-victim-center-to-radius-inset-closed-arena",
  },
  collision: {
    key: "knockback-collision-policy",
    value: "arena-boundary-only-with-no-unit-or-static-obstacle-resolution",
  },
  distance: {
    key: "knockback-distance",
    value: 2000,
    units: "millitiles",
  },
  eligibility: {
    key: "knockback-eligibility",
    value: "caller-frozen-eligible-boolean-gates-living-victims",
  },
  interruption: {
    key: "knockback-interruption",
    value: "interrupt-at-or-before-pulse-boundary-suppresses-entire-pulse",
  },
  mappedAreaDamageRadius: {
    key: "mapped-unverified-field-area-damage-radius",
    value: 2500,
    units: "millitiles",
  },
  mappedTargets: {
    key: "mapped-unverified-field-targets",
    value: "ground-and-air",
  },
  order: {
    key: "knockback-victim-order",
    value: "ascending-stable-victim-id-after-whole-batch-validation",
  },
  timing: {
    key: "knockback-pulse-timing",
    value: "instantaneous-at-simulation-boundary-2-after-commands",
  },
  vector: {
    key: "knockback-vector-projection",
    value: "away-from-source-by-exact-integer-euclidean-components",
  },
  zeroVector: {
    key: "knockback-zero-vector",
    value: "reject-eligible-victim-coincident-with-source",
  },
};

const SOURCE_ID = 700;
const PULSE_TICK = 2;
const MAX_TICK = 4;
const MAX_VICTIMS = 16;
const MAX_COMMANDS = 1;
const MAX_SNAPSHOT_BYTES = 4096;
const MAX_ARENA_RADIUS = 9000;
const MIN_SAFE_BIGINT = BigInt(Number.MIN_SAFE_INTEGER);
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const VICTIM_KEYS = ["eligible", "id", "position", "radius"];
const SETUP_KEYS = ["commands", "scenario"];
const COMMAND_KEYS = ["tick", "type"];
const SNAPSHOT_KEYS = ["identity", "tick", "version"];
const IDENTITY_KEYS = ["commands", "encounter", "scenario"];

const SCENARIOS = Object.freeze({
  edge: Object.freeze({
    encounter: "edge-external-pulse-v1",
    source: Object.freeze({ x: 3500, y: 4500 }),
    victims: Object.freeze([
      Object.freeze({
        eligible: true,
        id: 31,
        position: Object.freeze({ x: 500, y: 500 }),
        radius: 400,
      }),
      Object.freeze({
        eligible: false,
        id: 12,
        position: Object.freeze({ x: 6500, y: 8500 }),
        radius: 400,
      }),
    ]),
  }),
  open: Object.freeze({
    encounter: "open-external-pulse-v1",
    source: Object.freeze({ x: 9000, y: 16000 }),
    victims: Object.freeze([
      Object.freeze({
        eligible: true,
        id: 31,
        position: Object.freeze({ x: 12000, y: 20000 }),
        radius: 400,
      }),
      Object.freeze({
        eligible: false,
        id: 20,
        position: Object.freeze({ x: 9000, y: 20000 }),
        radius: 400,
      }),
      Object.freeze({
        eligible: true,
        id: 12,
        position: Object.freeze({ x: 6000, y: 12000 }),
        radius: 400,
      }),
    ]),
  }),
});

function deepFreeze(value) {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function clone(value) {
  return structuredClone(value);
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

function byteLength(value) {
  return new TextEncoder().encode(value).length;
}

function exactDataObject(value, keys, label) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (
      Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null
    )
  ) {
    throw new TypeError(`${label} must be a plain object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const actual = Reflect.ownKeys(descriptors);
  if (
    actual.length !== keys.length ||
    actual.some((key) => (
      typeof key !== "string" ||
      !keys.includes(key) ||
      !descriptors[key].enumerable ||
      !Object.hasOwn(descriptors[key], "value")
    ))
  ) {
    throw new TypeError(`${label} has an invalid shape`);
  }
  return Object.fromEntries(keys.map((key) => [key, descriptors[key].value]));
}

function denseArray(value, maximum, label) {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > maximum
  ) {
    throw new TypeError(`${label} must be a bounded plain array`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(descriptors).length !== value.length + 1 ||
    Array.from({ length: value.length }, (_, index) => index).some(
      (index) => (
        !descriptors[index]?.enumerable ||
        !Object.hasOwn(descriptors[index], "value")
      ),
    )
  ) {
    throw new TypeError(`${label} must contain only dense data properties`);
  }
  return Array.from(
    { length: value.length },
    (_, index) => descriptors[index].value,
  );
}

function checkedDistance(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(
      "knockback distance must be a positive safe integer millitile value",
    );
  }
  return value;
}

function checkedRadiusInset(position, radius, label) {
  if (
    radius > MAX_ARENA_RADIUS ||
    !isPointInArena(position) ||
    position.x < radius ||
    position.x > ARENA_WIDTH_MILLITILES - radius ||
    position.y < radius ||
    position.y > ARENA_LENGTH_MILLITILES - radius
  ) {
    throw new RangeError(`${label} must fit in the radius-inset arena`);
  }
}

function checkedVictim(value, index) {
  const victim = exactDataObject(value, VICTIM_KEYS, `knockback victim ${index}`);
  if (!Number.isSafeInteger(victim.id) || victim.id < 1) {
    throw new TypeError(`knockback victim ${index}.id is invalid`);
  }
  if (typeof victim.eligible !== "boolean") {
    throw new TypeError(`knockback victim ${index}.eligible is invalid`);
  }
  const position = validatePosition(
    victim.position,
    `knockback victim ${index}.position`,
  );
  const circle = validateCircle(
    { position, radius: victim.radius },
    `knockback victim ${index}.circle`,
  );
  checkedRadiusInset(position, circle.radius, `knockback victim ${index}`);
  return {
    eligible: victim.eligible,
    id: victim.id,
    position,
    radius: circle.radius,
  };
}

function integerSquareRoot(value) {
  if (value < 0n) throw new RangeError("square root input must be non-negative");
  if (value < 2n) return value;
  let current = value;
  let next = (current + value / current) / 2n;
  while (next < current) {
    current = next;
    next = (current + value / current) / 2n;
  }
  return current;
}

function safeNumber(value, label) {
  if (value < MIN_SAFE_BIGINT || value > MAX_SAFE_BIGINT) {
    throw new RangeError(`${label} exceeds the safe integer range`);
  }
  return Number(value);
}

function zeroVector() {
  return { x: 0, y: 0 };
}

function projectVictim(source, victim, distance) {
  if (!victim.eligible) {
    return {
      applied: zeroVector(),
      blocked: zeroVector(),
      clamped: false,
      eligible: false,
      id: victim.id,
      origin: { ...victim.position },
      position: { ...victim.position },
      requested: zeroVector(),
    };
  }
  const dx = BigInt(victim.position.x) - BigInt(source.x);
  const dy = BigInt(victim.position.y) - BigInt(source.y);
  const squared = dx * dx + dy * dy;
  if (squared === 0n) {
    throw new RangeError("knockback direction is undefined for a zero vector");
  }
  const length = integerSquareRoot(squared);
  if (length * length !== squared) {
    throw new RangeError(
      "knockback source vector length must be an exact integer millitile value",
    );
  }
  const scale = BigInt(distance);
  if ((dx * scale) % length !== 0n || (dy * scale) % length !== 0n) {
    throw new RangeError(
      "knockback projection must produce exact integer components",
    );
  }
  const requestedX = (dx * scale) / length;
  const requestedY = (dy * scale) / length;
  const rawX = BigInt(victim.position.x) + requestedX;
  const rawY = BigInt(victim.position.y) + requestedY;
  safeNumber(requestedX, "knockback requested.x");
  safeNumber(requestedY, "knockback requested.y");
  safeNumber(rawX, "knockback raw position.x");
  safeNumber(rawY, "knockback raw position.y");

  const minX = BigInt(victim.radius);
  const maxX = BigInt(ARENA_WIDTH_MILLITILES - victim.radius);
  const minY = BigInt(victim.radius);
  const maxY = BigInt(ARENA_LENGTH_MILLITILES - victim.radius);
  const finalX = rawX < minX ? minX : rawX > maxX ? maxX : rawX;
  const finalY = rawY < minY ? minY : rawY > maxY ? maxY : rawY;
  const appliedX = finalX - BigInt(victim.position.x);
  const appliedY = finalY - BigInt(victim.position.y);
  const blockedX = requestedX - appliedX;
  const blockedY = requestedY - appliedY;
  return {
    applied: {
      x: safeNumber(appliedX, "knockback applied.x"),
      y: safeNumber(appliedY, "knockback applied.y"),
    },
    blocked: {
      x: safeNumber(blockedX, "knockback blocked.x"),
      y: safeNumber(blockedY, "knockback blocked.y"),
    },
    clamped: finalX !== rawX || finalY !== rawY,
    eligible: true,
    id: victim.id,
    origin: { ...victim.position },
    position: {
      x: safeNumber(finalX, "knockback position.x"),
      y: safeNumber(finalY, "knockback position.y"),
    },
    requested: {
      x: safeNumber(requestedX, "knockback requested.x"),
      y: safeNumber(requestedY, "knockback requested.y"),
    },
  };
}

/**
 * Applies one external forced-displacement pulse to a bounded victim batch.
 * This is not attack-triggered recoil and has no charge, leap, dash, retarget,
 * damage, pathfinding, or ordinary movement state.
 */
export function evaluateForcedKnockbackQuestionBoundary(
  sourceValue,
  victimsValue,
  distanceValue = QUESTION_RECORDS.distance.value,
  ...extra
) {
  if (extra.length !== 0) {
    throw new TypeError("knockback evaluator received extra arguments");
  }
  const source = validatePosition(sourceValue, "knockback source");
  if (!isPointInArena(source)) {
    throw new RangeError("knockback source must be in the closed arena");
  }
  const distance = checkedDistance(distanceValue);
  const victims = denseArray(
    victimsValue,
    MAX_VICTIMS,
    "knockback victims",
  ).map(checkedVictim);
  if (victims.length < 1) {
    throw new RangeError("knockback victims must not be empty");
  }
  const ids = new Set();
  for (const victim of victims) {
    if (ids.has(victim.id)) {
      throw new TypeError("knockback victim IDs must be unique");
    }
    ids.add(victim.id);
  }

  // Calculate the complete result before returning any caller-observable data.
  return victims
    .map((victim) => projectVictim(source, victim, distance))
    .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
}

export function createKnockbackSpecialCatalog() {
  return createCardCatalog(DEFINITIONS);
}

export function createKnockbackQuestionRecords(...args) {
  if (args.length !== 0) {
    throw new TypeError("knockback question records take no arguments");
  }
  const records = Object.fromEntries(
    Object.entries(QUESTION_RECORDS).map(([name, record]) => [
      name,
      {
        authoritative: false,
        confidence: "unverified",
        disposition: "question",
        source: QUESTION_SOURCE,
        ...record,
      },
    ]),
  );
  return deepFreeze(records);
}

function checkedCommands(value) {
  return denseArray(value, MAX_COMMANDS, "knockback commands")
    .map((entry, index) => {
      const command = exactDataObject(
        entry,
        COMMAND_KEYS,
        `knockback command ${index}`,
      );
      if (command.type !== "interrupt") {
        throw new TypeError(`knockback command ${index}.type is invalid`);
      }
      if (
        !Number.isSafeInteger(command.tick) ||
        command.tick < 0 ||
        command.tick > PULSE_TICK
      ) {
        throw new TypeError(`knockback command ${index}.tick is invalid`);
      }
      return { tick: command.tick, type: command.type };
    });
}

function checkedSetup(value) {
  const setup = exactDataObject(value, SETUP_KEYS, "knockback setup");
  if (
    typeof setup.scenario !== "string" ||
    !Object.hasOwn(SCENARIOS, setup.scenario)
  ) {
    throw new TypeError("knockback setup.scenario is invalid");
  }
  return {
    commands: checkedCommands(setup.commands),
    scenario: setup.scenario,
  };
}

export function createKnockbackSpecialFixture(
  commands = [],
  scenario = "open",
) {
  return clone(checkedSetup({ commands, scenario }));
}

function fixedIdentity(commands, scenario) {
  return {
    commands: clone(commands),
    encounter: SCENARIOS[scenario].encounter,
    scenario,
  };
}

export class ForcedKnockbackEncounter {
  #commands;
  #events;
  #interrupted;
  #scenario;
  #tick;
  #victims;

  constructor(setup = createKnockbackSpecialFixture()) {
    const checked = checkedSetup(setup);
    this.#commands = checked.commands;
    this.#events = [];
    this.#interrupted = false;
    this.#scenario = checked.scenario;
    this.#tick = 0;
    this.#victims = clone(SCENARIOS[this.#scenario].victims);
  }

  get state() {
    return clone({
      events: this.#events,
      interrupted: this.#interrupted,
      sourceId: SOURCE_ID,
      terminal: this.#tick >= MAX_TICK,
      tick: this.#tick,
      victims: this.#victims,
    });
  }

  step() {
    if (this.#tick >= MAX_TICK) return [];
    const boundary = this.#tick;
    const events = [];
    for (const command of this.#commands) {
      if (command.tick === boundary) {
        this.#interrupted = true;
        events.push({ tick: boundary, type: "external-pulse-interrupted" });
      }
    }
    if (boundary === PULSE_TICK && !this.#interrupted) {
      const results = evaluateForcedKnockbackQuestionBoundary(
        SCENARIOS[this.#scenario].source,
        this.#victims,
      );
      const positions = new Map(
        results.map(({ id, position }) => [id, position]),
      );
      this.#victims = this.#victims.map((victim) => ({
        ...victim,
        position: { ...positions.get(victim.id) },
      }));
      events.push({
        results,
        sourceId: SOURCE_ID,
        tick: boundary,
        type: "external-forced-knockback",
      });
    }
    this.#events.push(...clone(events));
    this.#tick += 1;
    return clone(events);
  }

  stepMany(ticks) {
    if (!Number.isSafeInteger(ticks) || ticks < 0) {
      throw new TypeError("knockback ticks must be a non-negative safe integer");
    }
    const events = [];
    for (let index = 0; index < ticks && this.#tick < MAX_TICK; index += 1) {
      events.push(...this.step());
    }
    return events;
  }

  run(tickLimit = MAX_TICK) {
    if (!Number.isSafeInteger(tickLimit) || tickLimit < 0) {
      throw new TypeError(
        "knockback tick limit must be a non-negative safe integer",
      );
    }
    if (tickLimit > MAX_TICK) {
      throw new RangeError("knockback tick limit exceeds its bound");
    }
    while (this.#tick < tickLimit) this.step();
    return this.state;
  }

  serialize() {
    const serialized = canonicalJson({
      identity: fixedIdentity(this.#commands, this.#scenario),
      tick: this.#tick,
      version: 1,
    });
    if (byteLength(serialized) > MAX_SNAPSHOT_BYTES) {
      throw new RangeError("knockback snapshot exceeds its byte bound");
    }
    return serialized;
  }

  static restore(serialized) {
    if (typeof serialized !== "string") {
      throw new TypeError("knockback snapshot must be a string");
    }
    if (byteLength(serialized) > MAX_SNAPSHOT_BYTES) {
      throw new RangeError("knockback snapshot exceeds its byte bound");
    }
    let parsed;
    try {
      parsed = JSON.parse(serialized);
    } catch {
      throw new TypeError("knockback snapshot must be valid JSON");
    }
    if (canonicalJson(parsed) !== serialized) {
      throw new TypeError("knockback snapshot must use canonical JSON");
    }
    const snapshot = exactDataObject(
      parsed,
      SNAPSHOT_KEYS,
      "knockback snapshot",
    );
    if (snapshot.version !== 1) {
      throw new TypeError("knockback snapshot version is unsupported");
    }
    if (
      !Number.isSafeInteger(snapshot.tick) ||
      snapshot.tick < 0 ||
      snapshot.tick > MAX_TICK
    ) {
      throw new TypeError("knockback snapshot.tick is invalid");
    }
    const identity = exactDataObject(
      snapshot.identity,
      IDENTITY_KEYS,
      "knockback snapshot.identity",
    );
    if (
      typeof identity.scenario !== "string" ||
      !Object.hasOwn(SCENARIOS, identity.scenario) ||
      identity.encounter !== SCENARIOS[identity.scenario].encounter
    ) {
      throw new TypeError("knockback snapshot identity is unsupported");
    }
    const encounter = new ForcedKnockbackEncounter({
      commands: checkedCommands(identity.commands),
      scenario: identity.scenario,
    });
    encounter.stepMany(snapshot.tick);
    return encounter;
  }
}
