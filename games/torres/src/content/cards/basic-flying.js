import {
  advanceFlying,
  createFlyingState,
  restoreFlyingState,
  serializeFlyingState,
} from "../../sim/flying.js";
import { ProjectileCombat } from "../../sim/projectile.js";
import { acquireTarget } from "../../sim/targeting.js";
import { createCardCatalog } from "../schema.js";

const DEFINITIONS = [
  {
    id: "skymaul",
    displayName: "Skymaul",
    cost: 3,
    kind: "unit",
    rarity: "uncommon",
    hitpoints: 837,
    damage: 311,
    hitSpeedTicks: 96,
    firstHitTicks: 72,
    deployTimeTicks: 60,
    rangeMillitiles: 1600,
    sightRangeMillitiles: 5500,
    movementMillitilesPerSecond: 1000,
    targetMode: "ground-and-air",
    count: 1,
    areaDamageRadiusMillitiles: null,
    components: [],
  },
  {
    id: "copperskiff",
    displayName: "Copperskiff",
    cost: 4,
    kind: "unit",
    rarity: "uncommon",
    hitpoints: 614,
    damage: 171,
    hitSpeedTicks: 66,
    firstHitTicks: 36,
    deployTimeTicks: 60,
    rangeMillitiles: 6000,
    sightRangeMillitiles: 6000,
    movementMillitilesPerSecond: 1500,
    targetMode: "ground-and-air",
    count: 1,
    areaDamageRadiusMillitiles: null,
    components: [],
  },
];

const COMBATANT_KEYS = [
  "cardId",
  "damage",
  "deployTicks",
  "firstHitTicks",
  "hitSpeedTicks",
  "hitpoints",
  "id",
  "range",
  "targetMode",
];
const IDENTITY_KEYS = ["cardId", "id"];

function exactRecord(value, keys, label) {
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

function safeInteger(value, label, minimum) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new TypeError(`${label} must be a safe integer of at least ${minimum}`);
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
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

function modeForTargeting(mode) {
  if (mode === "ground-and-air") return "air_and_ground";
  return mode;
}

function checkedCombatant(value, index) {
  const label = `basic flying combatant ${index}`;
  const combatant = exactRecord(value, COMBATANT_KEYS, label);
  if (typeof combatant.cardId !== "string" || combatant.cardId.length === 0) {
    throw new TypeError(`${label}.cardId must be a non-empty string`);
  }
  for (const field of [
    "damage",
    "deployTicks",
    "firstHitTicks",
    "hitSpeedTicks",
    "hitpoints",
    "id",
    "range",
  ]) {
    safeInteger(
      combatant[field],
      `${label}.${field}`,
      ["deployTicks", "firstHitTicks", "range"].includes(field) ? 0 : 1,
    );
  }
  if (combatant.targetMode !== "ground-and-air") {
    throw new TypeError(`${label}.targetMode must be ground-and-air`);
  }
  if (
    combatant.deployTicks > Number.MAX_SAFE_INTEGER - combatant.firstHitTicks
  ) {
    throw new RangeError(`${label} first attack exceeds the safe tick range`);
  }
  return combatant;
}

function checkedSetup(value) {
  const setup = exactRecord(value, ["combatants"], "basic flying setup");
  if (
    !Array.isArray(setup.combatants) ||
    Object.getPrototypeOf(setup.combatants) !== Array.prototype ||
    setup.combatants.length !== 2
  ) {
    throw new TypeError("basic flying setup requires exactly two combatants");
  }
  const descriptors = Object.getOwnPropertyDescriptors(setup.combatants);
  if (
    Reflect.ownKeys(descriptors).length !== 3 ||
    [0, 1].some((index) => (
      !descriptors[index]?.enumerable ||
      !Object.hasOwn(descriptors[index], "value")
    ))
  ) {
    throw new TypeError("basic flying combatants must be a dense data-only array");
  }
  const combatants = setup.combatants
    .map(checkedCombatant)
    .sort((left, right) => left.id - right.id);
  if (combatants[0].id === combatants[1].id) {
    throw new TypeError("basic flying combatants must have unique IDs");
  }
  for (const combatant of combatants) {
    let canonical;
    try {
      canonical = createBasicFlyingCombatant(combatant.cardId, combatant.id);
    } catch {
      throw new TypeError(
        "basic flying combatants must select an original runtime card",
      );
    }
    if (canonicalJson(combatant) !== canonicalJson(canonical)) {
      throw new TypeError(
        "basic flying combatants must match their runtime card definition",
      );
    }
  }
  return { combatants };
}

function projectileSetup(combatants) {
  return {
    entities: combatants.map((combatant) => ({
      attackRange: combatant.range,
      id: combatant.id,
      kind: "troop",
      layer: "air",
      maxHealth: combatant.hitpoints,
      position: { x: 0, y: 0 },
      radius: 0,
      targetMode: modeForTargeting(combatant.targetMode),
      targetable: true,
    })),
  };
}

function duelSnapshotLimits(combatants) {
  const firstAttackTick = (combatant) => (
    combatant.deployTicks + combatant.firstHitTicks
  );
  const lethalTick = (attacker, target) => {
    const requiredHits = Math.ceil(target.hitpoints / attacker.damage);
    return firstAttackTick(attacker) +
      (requiredHits - 1) * attacker.hitSpeedTicks;
  };
  const resolutionBoundary = Math.min(
    lethalTick(combatants[0], combatants[1]),
    lethalTick(combatants[1], combatants[0]),
  );
  const launchesThroughResolution = combatants.reduce((total, combatant) => {
    const first = firstAttackTick(combatant);
    if (first > resolutionBoundary) return total;
    return total +
      Math.floor((resolutionBoundary - first) / combatant.hitSpeedTicks) + 1;
  }, 0);
  const maximumTick = resolutionBoundary + 1;
  return {
    maximumHistoryEntries: maximumTick + launchesThroughResolution,
    maximumTick,
  };
}

export function createBasicFlyingCatalog() {
  return createCardCatalog(DEFINITIONS);
}

export function createBasicFlyingCombatant(cardId, entityId) {
  if (typeof cardId !== "string") {
    throw new TypeError("basic flying card id must be a string");
  }
  safeInteger(entityId, "basic flying entityId", 1);
  const card = createBasicFlyingCatalog().find(({ id }) => id === cardId);
  if (card === undefined) {
    throw new RangeError(`unknown basic flying card id: ${cardId}`);
  }
  return {
    cardId: card.id,
    damage: card.damage,
    deployTicks: card.deployTimeTicks,
    firstHitTicks: card.firstHitTicks,
    hitSpeedTicks: card.hitSpeedTicks,
    hitpoints: card.hitpoints,
    id: entityId,
    range: card.rangeMillitiles,
    targetMode: card.targetMode,
  };
}

/**
 * Binds an original flying card's speed to the shared deterministic flying
 * movement engine. Only axis-aligned paths are claimed by that engine.
 */
export function createBasicFlyingMovement(cardId, options = {}) {
  const card = createBasicFlyingCatalog().find(({ id }) => id === cardId);
  if (card === undefined) {
    throw new RangeError(`unknown basic flying card id: ${cardId}`);
  }
  return createFlyingState({
    ...options,
    speed: card.movementMillitilesPerSecond,
  });
}

export function advanceBasicFlyingMovement(state, ticks = 1) {
  return advanceFlying(state, ticks);
}

export function serializeBasicFlyingMovement(state) {
  return serializeFlyingState(state);
}

export function restoreBasicFlyingMovement(serialized) {
  return restoreFlyingState(serialized);
}

/**
 * Delegates layer eligibility and deterministic tie-breaking to targeting.
 */
export function acquireBasicFlyingTarget(cardId, origin, candidates) {
  const card = createBasicFlyingCatalog().find(({ id }) => id === cardId);
  if (card === undefined) {
    throw new RangeError(`unknown basic flying card id: ${cardId}`);
  }
  return acquireTarget(origin, candidates, {
    mode: modeForTargeting(card.targetMode),
    sightRange: card.sightRangeMillitiles,
  });
}

/**
 * Co-located cadence fixture. Projectile radius 0 and synthetic speed 1 make
 * every impact immediate. It claims deployment, startup, cadence, damage, air
 * layer eligibility, and same-boundary ordering only. Collision, projectile
 * travel, and moving-target parity are explicitly outside this fixture because
 * the card schema has no projectile-speed value.
 */
export class BasicFlyingDuel {
  #combat;
  #initial;
  #nextAttacks = new Map();
  #tick = 0;

  constructor(setup) {
    this.#initial = checkedSetup(setup);
    this.#combat = new ProjectileCombat(
      projectileSetup(this.#initial.combatants),
    );
    for (const combatant of this.#initial.combatants) {
      this.#nextAttacks.set(
        combatant.id,
        combatant.deployTicks + combatant.firstHitTicks,
      );
    }
  }

  get replay() {
    return this.#combat.replay;
  }

  get state() {
    return clone({
      combatants: this.#combat.state.entities,
      nextAttacks: this.#initial.combatants.map(({ id }) => ({
        id,
        tick: this.#nextAttacks.get(id),
      })),
      tick: this.#tick,
    });
  }

  step() {
    if (this.#outcome() !== null) {
      throw new RangeError("basic flying duel cannot step after its outcome");
    }
    const health = new Map(
      this.#combat.state.entities.map((entity) => [entity.id, entity]),
    );
    const launched = [];
    for (const combatant of this.#initial.combatants) {
      const target = this.#initial.combatants.find(
        ({ id }) => id !== combatant.id,
      );
      if (
        this.#nextAttacks.get(combatant.id) === this.#tick &&
        health.get(combatant.id).alive &&
        health.get(target.id).alive
      ) {
        const next = this.#tick + combatant.hitSpeedTicks;
        if (!Number.isSafeInteger(next)) {
          throw new RangeError("basic flying attack tick space is exhausted");
        }
        this.#combat.launch({
          attackerId: combatant.id,
          damage: combatant.damage,
          radius: 0,
          speed: 1,
          targetId: target.id,
          tick: this.#tick,
        });
        this.#nextAttacks.set(combatant.id, next);
        launched.push(combatant.id);
      }
    }
    const events = this.#combat.step(this.#tick);
    this.#tick += 1;
    return clone({ events, launched, tick: this.#tick - 1 });
  }

  stepMany(count) {
    safeInteger(count, "basic flying step count", 0);
    for (let index = 0; index < count; index += 1) this.step();
    return this.state;
  }

  run(maxTick) {
    safeInteger(maxTick, "basic flying maximum tick", 0);
    while (this.#tick <= maxTick && this.#outcome() === null) this.step();
    return clone({ outcome: this.#outcome(), state: this.state });
  }

  serialize() {
    return canonicalJson({
      combat: JSON.parse(this.#combat.serialize()),
      identity: this.#initial.combatants.map(({ cardId, id }) => ({
        cardId,
        id,
      })),
      nextAttacks: this.#initial.combatants.map(({ id }) => ({
        id,
        tick: this.#nextAttacks.get(id),
      })),
      tick: this.#tick,
      version: 1,
    });
  }

  static restore(serialized) {
    if (typeof serialized !== "string") {
      throw new TypeError("serialized basic flying duel must be a string");
    }
    let snapshot;
    try {
      snapshot = JSON.parse(serialized);
    } catch {
      throw new TypeError("serialized basic flying duel must be valid JSON");
    }
    const checked = exactRecord(
      snapshot,
      ["combat", "identity", "nextAttacks", "tick", "version"],
      "basic flying snapshot",
    );
    if (checked.version !== 1) {
      throw new TypeError("basic flying snapshot has an unsupported version");
    }
    safeInteger(checked.tick, "basic flying snapshot.tick", 0);
    if (
      !Array.isArray(checked.identity) ||
      Object.getPrototypeOf(checked.identity) !== Array.prototype ||
      checked.identity.length !== 2
    ) {
      throw new TypeError("basic flying snapshot identity is invalid");
    }
    const identity = checked.identity.map((value, index) => {
      const entry = exactRecord(
        value,
        IDENTITY_KEYS,
        `basic flying snapshot identity[${index}]`,
      );
      if (typeof entry.cardId !== "string" || entry.cardId.length === 0) {
        throw new TypeError(
          `basic flying snapshot identity[${index}].cardId is invalid`,
        );
      }
      safeInteger(entry.id, `basic flying snapshot identity[${index}].id`, 1);
      return entry;
    });
    if (identity[0].id === identity[1].id) {
      throw new TypeError("basic flying snapshot identity has duplicate IDs");
    }
    const canonicalCombatants = identity.map(({ cardId, id }) =>
      createBasicFlyingCombatant(cardId, id)
    );
    const limits = duelSnapshotLimits(canonicalCombatants);
    if (checked.tick > limits.maximumTick) {
      throw new RangeError(
        "basic flying snapshot.tick exceeds its derived duel limit",
      );
    }
    const combat = exactRecord(
      checked.combat,
      ["history", "setup", "version"],
      "basic flying snapshot combat",
    );
    if (combat.version !== 1) {
      throw new TypeError(
        "basic flying snapshot combat has an unsupported version",
      );
    }
    if (
      !Array.isArray(combat.history) ||
      Object.getPrototypeOf(combat.history) !== Array.prototype
    ) {
      throw new TypeError("basic flying snapshot combat history is invalid");
    }
    if (combat.history.length > limits.maximumHistoryEntries) {
      throw new RangeError(
        "basic flying snapshot combat history exceeds its derived duel limit",
      );
    }
    const duel = new BasicFlyingDuel({ combatants: canonicalCombatants });
    if (
      !Array.isArray(checked.nextAttacks) ||
      Object.getPrototypeOf(checked.nextAttacks) !== Array.prototype ||
      checked.nextAttacks.length !== 2
    ) {
      throw new TypeError("basic flying snapshot nextAttacks is invalid");
    }
    const nextAttacks = new Map();
    for (let index = 0; index < checked.nextAttacks.length; index += 1) {
      const entry = exactRecord(
        checked.nextAttacks[index],
        ["id", "tick"],
        `basic flying snapshot nextAttacks[${index}]`,
      );
      safeInteger(entry.id, `basic flying snapshot nextAttacks[${index}].id`, 1);
      safeInteger(entry.tick, `basic flying snapshot nextAttacks[${index}].tick`, 0);
      if (nextAttacks.has(entry.id)) {
        throw new TypeError("basic flying snapshot nextAttacks has duplicate IDs");
      }
      nextAttacks.set(entry.id, entry.tick);
    }

    while (duel.#tick < checked.tick) {
      if (duel.#outcome() !== null) {
        throw new TypeError(
          "basic flying snapshot contains post-terminal history",
        );
      }
      duel.step();
    }
    const expected = JSON.parse(duel.serialize());
    if (canonicalJson(checked.combat) !== canonicalJson(expected.combat)) {
      throw new TypeError("basic flying snapshot combat history is incoherent");
    }
    if (
      canonicalJson(checked.identity) !== canonicalJson(expected.identity) ||
      canonicalJson(checked.nextAttacks) !== canonicalJson(expected.nextAttacks)
    ) {
      throw new TypeError("basic flying snapshot cadence is incoherent");
    }
    return duel;
  }

  #outcome() {
    const entities = this.#combat.state.entities;
    const alive = entities.filter(({ alive }) => alive);
    if (alive.length === 2) return null;
    const deaths = this.#combat.replay.filter(({ type }) => type === "death");
    return {
      deathTick: deaths.at(-1)?.tick ?? null,
      draw: alive.length === 0,
      winnerId: alive.length === 1 ? alive[0].id : null,
    };
  }
}
