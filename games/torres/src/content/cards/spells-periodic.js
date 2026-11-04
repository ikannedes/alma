import {
  ARENA_LENGTH_MILLITILES,
  ARENA_WIDTH_MILLITILES,
} from "../../sim/arena-geometry.js";
import { AreaDamageSystem } from "../../sim/area-damage.js";
import { createCardCatalog } from "../schema.js";
import {
  TimedMovementAttackSlowEncounter,
  createSlowFixture,
} from "./special-combat-slow.js";

const SOURCE = "unsourced-periodic-area-spell-composition";
const FIXTURE_ID = "periodic-area-spell-question-v1";
const MAX_COMMANDS = 96;
const MAX_EFFECTS = 32;
const MAX_EVENTS = 32768;
const MAX_HEALTH = 1_000_000;
const MAX_OWNER_ID = 1024;
const MAX_RADIUS = 9000;
const MAX_SNAPSHOT_BYTES = 262144;
const MAX_SOURCES = 16;
const MAX_STEP_CHUNK = 512;
const MAX_TARGETS = 64;
const MAX_TICK = 512;
const IMPACT_DELAY_TICKS = 2;
const SLOW_PROGRESS_TWENTIETHS = Object.freeze({
  "blight-ring": Object.freeze({
    attackWorkTwentieths: 20,
    movementTwentieths: 17,
  }),
  "fault-pulse": Object.freeze({
    attackWorkTwentieths: 20,
    movementTwentieths: 10,
  }),
});

const ARCHETYPES = Object.freeze({
  "blight-ring": Object.freeze({
    cadenceTicks: 60,
    cost: 4,
    damage: 91,
    durationTicks: 421,
    firstOffsetTicks: 2,
    radius: 3500,
    targetMode: "air_and_ground",
    tickCount: 8,
    towerDenominator: 10,
    towerNumerator: 3,
    structureDenominator: 1,
    structureNumerator: 1,
    variant: "slow",
  }),
  "fault-pulse": Object.freeze({
    cadenceTicks: 60,
    cost: 3,
    damage: 81,
    durationTicks: 121,
    firstOffsetTicks: 2,
    radius: 3500,
    targetMode: "ground",
    tickCount: 3,
    towerDenominator: 10,
    towerNumerator: 3,
    structureDenominator: 1,
    structureNumerator: 3,
    variant: "slow",
  }),
  "gravity-well": Object.freeze({
    cadenceTicks: 30,
    cost: 3,
    damage: 84,
    durationTicks: 31,
    firstOffsetTicks: 2,
    radius: 5500,
    targetMode: "air_and_ground",
    tickCount: 2,
    towerDenominator: 10,
    towerNumerator: 3,
    structureDenominator: 1,
    structureNumerator: 1,
    variant: "pull",
  }),
});

const CARD_DEFINITIONS = [
  {
    areaDamageRadiusMillitiles: 3500,
    components: [],
    cost: 4,
    count: 1,
    damage: 91,
    deployTimeTicks: null,
    displayName: "Blight Ring",
    firstHitTicks: null,
    hitSpeedTicks: null,
    hitpoints: null,
    id: "blight-ring",
    kind: "effect",
    movementMillitilesPerSecond: null,
    rangeMillitiles: null,
    rarity: "mythic",
    sightRangeMillitiles: null,
    targetMode: "ground-and-air",
  },
  {
    areaDamageRadiusMillitiles: 5500,
    components: [],
    cost: 3,
    count: 1,
    damage: 84,
    deployTimeTicks: null,
    displayName: "Gravity Well",
    firstHitTicks: null,
    hitSpeedTicks: null,
    hitpoints: null,
    id: "gravity-well",
    kind: "effect",
    movementMillitilesPerSecond: null,
    rangeMillitiles: null,
    rarity: "mythic",
    sightRangeMillitiles: null,
    targetMode: "ground-and-air",
  },
  {
    areaDamageRadiusMillitiles: 3500,
    components: [],
    cost: 3,
    count: 1,
    damage: 81,
    deployTimeTicks: null,
    displayName: "Fault Pulse",
    firstHitTicks: null,
    hitSpeedTicks: null,
    hitpoints: null,
    id: "fault-pulse",
    kind: "effect",
    movementMillitilesPerSecond: null,
    rangeMillitiles: null,
    rarity: "uncommon",
    sightRangeMillitiles: null,
    targetMode: "ground",
  },
];

const QUESTION_VALUES = Object.freeze({
  boundaryOrdering:
    "commands-by-ascending-id-then-effects-by-ascending-id-then-target-class-batches-then-status",
  cadenceTicks: Object.freeze({
    "blight-ring": 60,
    "fault-pulse": 60,
    "gravity-well": 30,
  }),
  castIdentity: "monotonic-effect-id-in-cast-command-order",
  crownTowerDamageRatio: Object.freeze({ denominator: 10, numerator: 3 }),
  crownTowerRounding: "nearest-integer-half-up",
  durationTicks: Object.freeze({
    "blight-ring": 421,
    "fault-pulse": 121,
    "gravity-well": 31,
  }),
  effectExpiry: "final-tick-resolves-then-effect-is-complete",
  firstTickOffset: IMPACT_DELAY_TICKS,
  geometryAndDamageComposition:
    "each-target-class-batch-delegates-to-shared-area-damage-system",
  hostileOwnership: "only-targets-with-owner-different-from-source",
  mappedDamageConfidence: "reference-corpus-unverified-question",
  mappedRadiusConfidence: "reference-corpus-unverified-question",
  mappedTargetClassConfidence: "reference-corpus-unverified-question",
  pullArenaClamp: "radius-inset-closed-arena",
  pullDistanceMillitiles: 1000,
  pullEligibility: "surviving-hostile-troops-only",
  pullComponentRounding:
    "largest-magnitude-integer-satisfying-q-squared-times-length-squared-not-greater-than-scaled-component-squared-then-restore-sign",
  pullProjection:
    "toward-center-exact-integer-euclidean-components-truncated-toward-zero",
  pullZeroVector: "coincident-target-does-not-move",
  slowComposition:
    "movement-rate-is-source-backed; activation-and-refresh-remain-question",
  slowEligibility: "surviving-hostile-troops-only",
  slowRefresh: "each-damaging-tick-refreshes-one-nonstacking-status-slot",
  sourceDeathPolicy: "cancel-all-remaining-ticks-before-same-boundary-effects",
  stableTargetOrdering: "ascending-target-id-within-each-effect",
  structureDamageRatio: Object.freeze({
    "blight-ring": Object.freeze({ denominator: 1, numerator: 1 }),
    "fault-pulse": Object.freeze({ denominator: 1, numerator: 3 }),
    "gravity-well": Object.freeze({ denominator: 1, numerator: 1 }),
  }),
  targetDeathPolicy: "command-first-death-excludes-target-from-that-boundary",
  tickCount: Object.freeze({
    "blight-ring": 8,
    "fault-pulse": 3,
    "gravity-well": 2,
  }),
  towerModifierScope: "crown-kind-only",
});

const SETUP_KEYS = ["commands", "sources", "targets"];
const SOURCE_KEYS = ["id", "ownerId"];
const TARGET_KEYS = [
  "health", "id", "kind", "layer", "ownerId", "position", "radius",
  "targetable",
];
const COMMAND_KEYS = [
  "center", "id", "sourceId", "targetId", "tick", "type", "variant",
];
const SNAPSHOT_KEYS = ["identity", "tick", "version"];
const IDENTITY_KEYS = ["fixture", "setup"];
const COMMAND_TYPES = new Set(["cast", "source-died", "target-died"]);
const TARGET_KINDS = new Set(["crown", "structure", "troop"]);
const TARGET_LAYERS = new Set(["air", "ground"]);

function clone(value) {
  return structuredClone(value);
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function exactRecord(value, keys, label) {
  if (
    value === null || typeof value !== "object" || Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) throw new TypeError(`${label} must be a plain object`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const actual = Reflect.ownKeys(descriptors);
  if (
    actual.length !== keys.length ||
    actual.some((key) => typeof key !== "string" || !keys.includes(key) ||
      !descriptors[key].enumerable || !Object.hasOwn(descriptors[key], "value"))
  ) throw new TypeError(`${label} has an invalid shape`);
  return Object.fromEntries(keys.map((key) => [key, descriptors[key].value]));
}

function denseArray(value, maximum, label) {
  if (
    !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > maximum
  ) throw new TypeError(`${label} must be a bounded plain array`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(descriptors).length !== value.length + 1 ||
    Array.from({ length: value.length }, (_, index) =>
      !descriptors[index]?.enumerable ||
      !Object.hasOwn(descriptors[index], "value")).some(Boolean)
  ) throw new TypeError(`${label} must contain dense data properties`);
  return Array.from({ length: value.length }, (_, index) =>
    descriptors[index].value);
}

function integer(value, label, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label} must be a bounded safe integer`);
  }
  return value;
}

function id(value, label, nullable = false) {
  if (nullable && value === null) return null;
  return integer(value, label, 1);
}

function position(value, label) {
  const checked = exactRecord(value, ["x", "y"], label);
  return {
    x: integer(checked.x, `${label}.x`, 0, ARENA_WIDTH_MILLITILES),
    y: integer(checked.y, `${label}.y`, 0, ARENA_LENGTH_MILLITILES),
  };
}

function checkedSources(value) {
  const sources = denseArray(value, MAX_SOURCES, "periodic spell sources")
    .map((entry, index) => {
      const source = exactRecord(entry, SOURCE_KEYS, `source ${index}`);
      return {
        id: id(source.id, `source ${index}.id`),
        ownerId: integer(source.ownerId, `source ${index}.ownerId`, 1, MAX_OWNER_ID),
      };
    });
  if (sources.length === 0) throw new RangeError("sources must not be empty");
  if (new Set(sources.map(({ id: value }) => value)).size !== sources.length) {
    throw new TypeError("source IDs must be unique");
  }
  return sources;
}

function checkedTargets(value) {
  const targets = denseArray(value, MAX_TARGETS, "periodic spell targets")
    .map((entry, index) => {
      const target = exactRecord(entry, TARGET_KEYS, `target ${index}`);
      if (!TARGET_KINDS.has(target.kind)) {
        throw new TypeError(`target ${index}.kind is invalid`);
      }
      if (!TARGET_LAYERS.has(target.layer)) {
        throw new TypeError(`target ${index}.layer is invalid`);
      }
      if (typeof target.targetable !== "boolean") {
        throw new TypeError(`target ${index}.targetable must be boolean`);
      }
      const radius = integer(target.radius, `target ${index}.radius`, 0, MAX_RADIUS);
      const where = position(target.position, `target ${index}.position`);
      if (
        where.x < radius || where.x > ARENA_WIDTH_MILLITILES - radius ||
        where.y < radius || where.y > ARENA_LENGTH_MILLITILES - radius
      ) throw new RangeError(`target ${index} circle must fit in arena`);
      return {
        health: integer(target.health, `target ${index}.health`, 1, MAX_HEALTH),
        id: id(target.id, `target ${index}.id`),
        kind: target.kind,
        layer: target.layer,
        ownerId: integer(target.ownerId, `target ${index}.ownerId`, 1, MAX_OWNER_ID),
        position: where,
        radius,
        targetable: target.targetable,
      };
    });
  if (new Set(targets.map(({ id: value }) => value)).size !== targets.length) {
    throw new TypeError("target IDs must be unique");
  }
  return targets.sort((left, right) => left.id - right.id);
}

function checkedCommands(value, sources, targets) {
  const sourceIds = new Set(sources.map(({ id: value }) => value));
  const targetIds = new Set(targets.map(({ id: value }) => value));
  const commands = denseArray(value, MAX_COMMANDS, "periodic spell commands")
    .map((entry, index) => {
      const command = exactRecord(entry, COMMAND_KEYS, `command ${index}`);
      const checked = {
        center: command.center,
        id: id(command.id, `command ${index}.id`),
        sourceId: command.sourceId,
        targetId: command.targetId,
        tick: integer(command.tick, `command ${index}.tick`, 0, MAX_TICK - 1),
        type: command.type,
        variant: command.variant,
      };
      if (!COMMAND_TYPES.has(checked.type)) {
        throw new TypeError(`command ${index}.type is invalid`);
      }
      if (checked.type === "cast") {
        checked.center = position(checked.center, `command ${index}.center`);
        checked.sourceId = id(checked.sourceId, `command ${index}.sourceId`);
        if (!sourceIds.has(checked.sourceId)) {
          throw new TypeError(`command ${index}.sourceId is missing`);
        }
        if (!Object.hasOwn(ARCHETYPES, checked.variant)) {
          throw new TypeError(`command ${index}.variant is invalid`);
        }
        if (checked.targetId !== null) {
          throw new TypeError(`command ${index}.targetId must be null`);
        }
        const finalTick = checked.tick + ARCHETYPES[checked.variant].firstOffsetTicks +
          (ARCHETYPES[checked.variant].tickCount - 1) *
          ARCHETYPES[checked.variant].cadenceTicks;
        if (finalTick >= MAX_TICK) {
          throw new RangeError(`command ${index} cannot fit all periodic ticks`);
        }
      } else {
        checked.center = null;
        checked.variant = null;
        if (command.center !== null || command.variant !== null) {
          throw new TypeError(`command ${index} has inapplicable cast fields`);
        }
        if (checked.type === "source-died") {
          checked.sourceId = id(checked.sourceId, `command ${index}.sourceId`);
          if (!sourceIds.has(checked.sourceId) || checked.targetId !== null) {
            throw new TypeError(`command ${index} source death is invalid`);
          }
        } else {
          checked.targetId = id(checked.targetId, `command ${index}.targetId`);
          if (!targetIds.has(checked.targetId) || checked.sourceId !== null) {
            throw new TypeError(`command ${index} target death is invalid`);
          }
        }
      }
      return checked;
    });
  if (new Set(commands.map(({ id: value }) => value)).size !== commands.length) {
    throw new TypeError("command IDs must be unique");
  }
  let priorTick = -1;
  for (const command of commands) {
    if (command.tick < priorTick) {
      throw new TypeError("commands must have nondecreasing ticks");
    }
    priorTick = command.tick;
  }
  return commands;
}

function checkedSetup(value) {
  const setup = exactRecord(value, SETUP_KEYS, "periodic spell setup");
  const sources = checkedSources(setup.sources);
  const targets = checkedTargets(setup.targets);
  const commands = checkedCommands(setup.commands, sources, targets);
  return { commands, sources, targets };
}

function initialState(setup) {
  const area = new AreaDamageSystem();
  for (const target of setup.targets) area.add(target.id, target.health);
  return {
    areaSerialized: area.serialize(),
    effects: [],
    history: [],
    nextEffectId: 1,
    sources: setup.sources.map((source) => ({ ...source, alive: true })),
    targets: setup.targets.map((target) => ({
      ...clone(target),
      alive: true,
      slowSourceId: null,
      slowUntilTick: null,
    })),
    tick: 0,
  };
}

function scaledDamage(value, numerator, denominator) {
  const product = BigInt(value) * BigInt(numerator);
  return Number((product + BigInt(Math.floor(denominator / 2))) /
    BigInt(denominator));
}

function candidate(target) {
  return {
    alive: target.alive,
    id: target.id,
    kind: target.kind === "crown" ? "structure" : target.kind,
    layer: target.layer,
    position: clone(target.position),
    radius: target.radius,
    targetable: target.targetable,
  };
}

function applyDamageBatch(area, state, effect, targets, amount, events) {
  if (targets.length === 0) return [];
  const archetype = ARCHETYPES[effect.variant];
  const result = area.resolve({
    center: effect.center,
    damage: amount,
    mode: targets[0].kind === "troop" ? archetype.targetMode : "buildings",
    radius: archetype.radius,
    tick: state.tick,
  }, targets.map(candidate));
  const hitIds = new Set(result.hitTargetIds);
  for (const primitiveEvent of result.events) {
    events.push({
      effectId: effect.id,
      primitiveEffectId: result.effectId,
      primitiveEvent,
      tick: state.tick,
      type: "periodic-damage-primitive",
    });
  }
  for (const target of targets) {
    const health = area.get(target.id);
    target.health = health.currentHealth;
    target.alive = !health.dead;
  }
  return targets.filter((target) => hitIds.has(target.id));
}

function applySlow(state, effect, source, target, events) {
  const slowProgress = SLOW_PROGRESS_TWENTIETHS[effect.variant];
  const primitive = new TimedMovementAttackSlowEncounter(createSlowFixture([{
    sourceId: source.id,
    targetId: null,
    tick: 0,
    type: "slow",
  }], 1, slowProgress));
  const primitiveEvent = primitive.step().find(({ type }) =>
    type === "slow-applied");
  target.slowSourceId = source.id;
  target.slowUntilTick = state.tick + primitiveEvent.untilTick;
  events.push({
    effectId: effect.id,
    primitiveEvent,
    sourceId: source.id,
    slowProgress: clone(slowProgress),
    targetId: target.id,
    tick: state.tick,
    type: "periodic-slow",
    untilTick: target.slowUntilTick,
  });
}

function exactPullComponent(component, distance, lengthSquared) {
  if (component === 0n || lengthSquared === 0n) return 0n;
  const magnitude = component < 0n ? -component : component;
  const scaledSquared = magnitude * distance * magnitude * distance;
  let lower = 0n;
  let upper = distance;
  while (lower < upper) {
    const candidate = (lower + upper + 1n) >> 1n;
    if (candidate * candidate * lengthSquared <= scaledSquared) {
      lower = candidate;
    } else {
      upper = candidate - 1n;
    }
  }
  return component < 0n ? -lower : lower;
}

function applyPull(state, effect, target, events) {
  const dx = BigInt(effect.center.x - target.position.x);
  const dy = BigInt(effect.center.y - target.position.y);
  const lengthSquared = dx * dx + dy * dy;
  let requestedX = 0n;
  let requestedY = 0n;
  if (lengthSquared !== 0n) {
    const distance = BigInt(QUESTION_VALUES.pullDistanceMillitiles);
    requestedX = exactPullComponent(dx, distance, lengthSquared);
    requestedY = exactPullComponent(dy, distance, lengthSquared);
  }
  const rawX = BigInt(target.position.x) + requestedX;
  const rawY = BigInt(target.position.y) + requestedY;
  const minX = BigInt(target.radius);
  const maxX = BigInt(ARENA_WIDTH_MILLITILES - target.radius);
  const minY = BigInt(target.radius);
  const maxY = BigInt(ARENA_LENGTH_MILLITILES - target.radius);
  const finalX = rawX < minX ? minX : rawX > maxX ? maxX : rawX;
  const finalY = rawY < minY ? minY : rawY > maxY ? maxY : rawY;
  const origin = clone(target.position);
  target.position = { x: Number(finalX), y: Number(finalY) };
  events.push({
    applied: {
      x: target.position.x - origin.x,
      y: target.position.y - origin.y,
    },
    effectId: effect.id,
    origin,
    position: clone(target.position),
    requested: { x: Number(requestedX), y: Number(requestedY) },
    targetId: target.id,
    tick: state.tick,
    type: "periodic-pull",
  });
}

function resolveEffectTick(area, state, effect, events) {
  const source = state.sources.find(({ id: value }) => value === effect.sourceId);
  if (!source.alive) return;
  const archetype = ARCHETYPES[effect.variant];
  events.push({
    center: clone(effect.center),
    effectId: effect.id,
    ordinal: effect.resolvedTicks,
    sourceId: source.id,
    tick: state.tick,
    type: "periodic-tick",
    variant: effect.variant,
  });
  const eligible = state.targets.filter((target) =>
    target.alive && target.targetable && target.ownerId !== source.ownerId &&
    (archetype.targetMode === "air_and_ground" || target.layer === "ground"));
  const troops = eligible.filter(({ kind }) => kind === "troop");
  const structures = eligible.filter(({ kind }) => kind === "structure");
  const crowns = eligible.filter(({ kind }) => kind === "crown");
  const hit = [
    ...applyDamageBatch(area, state, effect, troops, archetype.damage, events),
    ...applyDamageBatch(
      area,
      state,
      effect,
      structures,
      scaledDamage(
        archetype.damage,
        archetype.structureNumerator,
        archetype.structureDenominator,
      ),
      events,
    ),
    ...applyDamageBatch(
      area,
      state,
      effect,
      crowns,
      scaledDamage(
        archetype.damage,
        archetype.towerNumerator,
        archetype.towerDenominator,
      ),
      events,
    ),
  ].sort((left, right) => left.id - right.id);
  for (const target of hit) {
    if (!target.alive || target.kind !== "troop") continue;
    if (archetype.variant === "pull") applyPull(state, effect, target, events);
    else applySlow(state, effect, source, target, events);
  }
  effect.resolvedTicks += 1;
  effect.nextTick += archetype.cadenceTicks;
}

function applyCommand(state, command, events) {
  if (command.type === "cast") {
    if (state.effects.length >= MAX_EFFECTS) {
      throw new RangeError("periodic spell active-effect bound exceeded");
    }
    if (state.nextEffectId === Number.MAX_SAFE_INTEGER) {
      throw new RangeError("periodic spell effect ID space is exhausted");
    }
    const effectId = state.nextEffectId;
    state.nextEffectId += 1;
    const source = state.sources.find(({ id: value }) =>
      value === command.sourceId);
    if (!source.alive) {
      events.push({
        effectId,
        reason: "source-dead",
        sourceId: source.id,
        tick: state.tick,
        type: "periodic-cast-cancelled",
        variant: command.variant,
      });
      return;
    }
    const effect = {
      center: clone(command.center),
      id: effectId,
      nextTick: state.tick + ARCHETYPES[command.variant].firstOffsetTicks,
      resolvedTicks: 0,
      sourceId: command.sourceId,
      variant: command.variant,
    };
    state.effects.push(effect);
    events.push({
      effectId: effect.id,
      firstTick: effect.nextTick,
      sourceId: effect.sourceId,
      tick: state.tick,
      type: "periodic-cast",
      variant: effect.variant,
    });
    return;
  }
  if (command.type === "source-died") {
    const source = state.sources.find(({ id: value }) => value === command.sourceId);
    if (source.alive) {
      source.alive = false;
      const cancelled = state.effects
        .filter(({ sourceId }) => sourceId === source.id)
        .map(({ id: value }) => value)
        .sort((left, right) => left - right);
      state.effects = state.effects.filter(({ sourceId }) => sourceId !== source.id);
      events.push({
        cancelledEffectIds: cancelled,
        sourceId: source.id,
        tick: state.tick,
        type: "periodic-source-died",
      });
    }
    return;
  }
  const target = state.targets.find(({ id: value }) => value === command.targetId);
  if (target.alive) {
    target.alive = false;
    target.health = 0;
    events.push({
      targetId: target.id,
      tick: state.tick,
      type: "periodic-target-died",
    });
  }
}

function advance(state, setup) {
  const area = AreaDamageSystem.restore(state.areaSerialized);
  const events = [];
  const dueCommands = setup.commands
    .filter(({ tick }) => tick === state.tick)
    .sort((left, right) => left.id - right.id);
  for (const command of dueCommands) applyCommand(state, command, events);
  const dueEffects = state.effects
    .filter(({ nextTick, resolvedTicks, variant }) =>
      nextTick === state.tick &&
      resolvedTicks < ARCHETYPES[variant].tickCount)
    .sort((left, right) => left.id - right.id);
  for (const effect of dueEffects) resolveEffectTick(area, state, effect, events);
  state.effects = state.effects.filter((effect) =>
    effect.resolvedTicks < ARCHETYPES[effect.variant].tickCount);
  if (state.history.length + events.length > MAX_EVENTS) {
    throw new RangeError("periodic spell replay exceeds its event bound");
  }
  state.areaSerialized = area.serialize();
  state.history.push(...clone(events));
  state.tick += 1;
  return events;
}

function questionRecord(key, value) {
  return deepFreeze({
    authoritative: false,
    confidence: "unverified",
    disposition: "question",
    key,
    source: SOURCE,
    value: clone(value),
  });
}

export function createPeriodicSpellCatalog(...args) {
  if (args.length !== 0) {
    throw new TypeError("periodic spell catalog does not accept overrides");
  }
  return createCardCatalog(CARD_DEFINITIONS);
}

export function createPeriodicSpellQuestionRecords(...args) {
  if (args.length !== 0) {
    throw new TypeError("periodic spell questions do not accept overrides");
  }
  return deepFreeze(Object.fromEntries(
    Object.entries(QUESTION_VALUES).map(([key, value]) =>
      [key, questionRecord(key, value)]),
  ));
}

export function createPeriodicSpellFixture(value) {
  return clone(checkedSetup(value));
}

export class PeriodicAreaSpellEncounter {
  #setup;
  #state;

  constructor(setup) {
    this.#setup = checkedSetup(setup);
    this.#state = initialState(this.#setup);
  }

  get replay() {
    return clone(this.#state.history);
  }

  get state() {
    return clone(this.#state);
  }

  step() {
    return this.stepMany(1);
  }

  stepMany(count) {
    integer(count, "periodic spell step count", 0, MAX_STEP_CHUNK);
    if (count > MAX_TICK - this.#state.tick) {
      throw new RangeError("periodic spell step count exceeds encounter bound");
    }
    const candidate = clone(this.#state);
    const events = [];
    for (let index = 0; index < count; index += 1) {
      events.push(...advance(candidate, this.#setup));
    }
    this.#state = candidate;
    return clone(events);
  }

  run() {
    return this.stepMany(MAX_TICK - this.#state.tick);
  }

  serialize() {
    const serialized = canonicalJson({
      identity: { fixture: FIXTURE_ID, setup: this.#setup },
      tick: this.#state.tick,
      version: 1,
    });
    if (Buffer.byteLength(serialized, "utf8") > MAX_SNAPSHOT_BYTES) {
      throw new RangeError("periodic spell snapshot exceeds its byte bound");
    }
    return serialized;
  }

  static restore(serialized) {
    if (typeof serialized !== "string") {
      throw new TypeError("periodic spell snapshot must be a string");
    }
    if (Buffer.byteLength(serialized, "utf8") > MAX_SNAPSHOT_BYTES) {
      throw new RangeError("periodic spell snapshot exceeds its byte bound");
    }
    let value;
    try {
      value = JSON.parse(serialized);
    } catch {
      throw new TypeError("periodic spell snapshot must be valid JSON");
    }
    if (canonicalJson(value) !== serialized) {
      throw new TypeError(
        "periodic spell snapshot must be canonical duplicate-free JSON",
      );
    }
    const snapshot = exactRecord(value, SNAPSHOT_KEYS, "periodic spell snapshot");
    if (snapshot.version !== 1) {
      throw new TypeError("periodic spell snapshot version is unsupported");
    }
    const identity = exactRecord(
      snapshot.identity,
      IDENTITY_KEYS,
      "periodic spell snapshot.identity",
    );
    if (identity.fixture !== FIXTURE_ID) {
      throw new TypeError("periodic spell snapshot fixture is unsupported");
    }
    integer(snapshot.tick, "periodic spell snapshot.tick", 0, MAX_TICK);
    const encounter = new PeriodicAreaSpellEncounter(identity.setup);
    encounter.stepMany(snapshot.tick);
    return encounter;
  }
}
