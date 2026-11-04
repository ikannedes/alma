import { ProjectileCombat } from "../../sim/projectile.js";
import {
  ARENA_LENGTH_MILLITILES,
  ARENA_WIDTH_MILLITILES,
} from "../../sim/arena-geometry.js";
import {
  InstantRadiusSpellEncounter,
  createInstantSpellCatalog,
  createInstantSpellFixture,
} from "./spells-instant.js";
import {
  appendCombatEffectEvent,
  appendCombatEffectRoot,
  combatEffectFeedSnapshot,
  createCombatEffectFeed,
  serializeCombatEffectFeed,
} from "../../sim/combat-effect-feed.js";

const SOURCE = "unsourced-traveling-line-spell-composition";
const SPEED = 1000;
const PROJECTILE_RADIUS = 0;
const TERMINAL_RADIUS = createInstantSpellCatalog()[0].areaDamageRadiusMillitiles;
const MAX_COMMANDS = 96;
const MAX_EVENTS = 8192;
const MAX_HEALTH = 1_000_000;
const MAX_OWNER_ID = 1024;
const MAX_RADIUS = 9000;
const MAX_SNAPSHOT_BYTES = 262144;
const MAX_SOURCES = 16;
const MAX_STEP_CHUNK = 128;
const MAX_TICK = 128;
const MAX_VICTIMS = 64;
const COMMAND_KEYS = [
  "center",
  "effectId",
  "id",
  "sourceId",
  "targetId",
  "tick",
  "type",
];
const SETUP_KEYS = ["commands", "sources", "victims"];
const SOURCE_KEYS = ["id", "ownerId", "position"];
const VICTIM_KEYS = [
  "combatTargetId",
  "combatTargetMode",
  "health",
  "id",
  "kind",
  "layer",
  "ownerId",
  "position",
  "radius",
  "targetable",
];
const SNAPSHOT_KEYS = ["identity", "tick", "version"];
const IDENTITY_KEYS = ["fixture", "setup"];
const COMMAND_TYPES = new Set([
  "cancel-effect",
  "cast",
  "source-died",
  "target-died",
]);
const VICTIM_KINDS = new Set(["crown", "structure", "troop"]);
const VICTIM_LAYERS = new Set(["air", "ground"]);
const COMBAT_TARGET_MODES = new Set([
  "air",
  "air_and_ground",
  "buildings",
  "ground",
  "none",
]);

const QUESTION_VALUES = Object.freeze({
  cancellationBoundary:
    "commands-first;cancel-or-source-death-stops-future-contact-and-impact",
  collisionDamage: "travel-contacts-are-observations;damage-occurs-at-impact-only",
  collisionGeometry:
    "static-launch-snapshot-finite-capsule-with-inclusive-end-caps",
  collisionOrder: "forward-clamped-segment-dot-then-stable-target-id",
  impactComposition:
    "delegate-terminal-center-to-passed-instant-radius-plain-variant",
  movingTargetPolicy: "launch-time-position-snapshot-for-line-contacts",
  projectileRadiusMillitiles: PROJECTILE_RADIUS,
  sameBoundaryOrder:
    "commands-then-cancellations-then-effect-id-ordered-impact-contact-and-damage",
  sourceDeathAfterImpact: "no-retroactive-cancellation",
  speedMillitilesPerTick: SPEED,
  targetFilter:
    "living-targetable-hostile-ground-or-air-troop-structure-or-crown",
  targetDeathAtImpact:
    "command-first-death-excludes-new-contact-and-impact;prior-latch-retained",
  travelComposition:
    "delegate-zero-damage-carrier-timing-to-passed-static-projectile",
  travelContactTiming:
    "first-inclusive-swept-capsule-boundary-from-launch-through-impact",
});

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
    Array.from({ length: value.length }, (_, index) => (
      !descriptors[index]?.enumerable ||
      !Object.hasOwn(descriptors[index], "value")
    )).some(Boolean)
  ) {
    throw new TypeError(`${label} must contain dense data properties`);
  }
  return Array.from(
    { length: value.length },
    (_, index) => descriptors[index].value,
  );
}

function safeInteger(value, label, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label} must be a bounded safe integer`);
  }
  return value;
}

function checkedId(value, label, nullable = false) {
  if (nullable && value === null) return null;
  return safeInteger(value, label, 1);
}

function checkedPosition(value, label) {
  const position = exactRecord(value, ["x", "y"], label);
  return {
    x: safeInteger(
      position.x,
      `${label}.x`,
      0,
      ARENA_WIDTH_MILLITILES,
    ),
    y: safeInteger(
      position.y,
      `${label}.y`,
      0,
      ARENA_LENGTH_MILLITILES,
    ),
  };
}

function checkedSources(value) {
  const sources = denseArray(value, MAX_SOURCES, "travel spell sources")
    .map((entry, index) => {
      const source = exactRecord(
        entry,
        SOURCE_KEYS,
        `travel spell source ${index}`,
      );
      return {
        id: checkedId(source.id, `travel spell source ${index}.id`),
        ownerId: safeInteger(
          source.ownerId,
          `travel spell source ${index}.ownerId`,
          1,
          MAX_OWNER_ID,
        ),
        position: checkedPosition(
          source.position,
          `travel spell source ${index}.position`,
        ),
      };
    });
  if (sources.length < 1) {
    throw new RangeError("travel spell sources must not be empty");
  }
  const ids = new Set();
  for (const source of sources) {
    if (ids.has(source.id)) {
      throw new TypeError("travel spell source IDs must be unique");
    }
    ids.add(source.id);
  }
  return sources;
}

function checkedVictims(value) {
  const victims = denseArray(value, MAX_VICTIMS, "travel spell victims")
    .map((entry, index) => {
      const label = `travel spell victim ${index}`;
      const victim = exactRecord(entry, VICTIM_KEYS, label);
      if (!VICTIM_KINDS.has(victim.kind)) {
        throw new TypeError(`${label}.kind is invalid`);
      }
      if (!VICTIM_LAYERS.has(victim.layer)) {
        throw new TypeError(`${label}.layer is invalid`);
      }
      if (
        victim.combatTargetMode !== null &&
        !COMBAT_TARGET_MODES.has(victim.combatTargetMode)
      ) {
        throw new TypeError(`${label}.combatTargetMode is invalid`);
      }
      if (typeof victim.targetable !== "boolean") {
        throw new TypeError(`${label}.targetable must be boolean`);
      }
      const combatTargetId = checkedId(
        victim.combatTargetId,
        `${label}.combatTargetId`,
        true,
      );
      if (
        (combatTargetId === null) !== (victim.combatTargetMode === null)
      ) {
        throw new TypeError(
          `${label} combat target ID and mode must both be null or non-null`,
        );
      }
      const position = checkedPosition(victim.position, `${label}.position`);
      const radius = safeInteger(victim.radius, `${label}.radius`, 0, MAX_RADIUS);
      if (
        position.x < radius ||
        position.x > ARENA_WIDTH_MILLITILES - radius ||
        position.y < radius ||
        position.y > ARENA_LENGTH_MILLITILES - radius
      ) {
        throw new RangeError(`${label} must fit in the radius-inset arena`);
      }
      return {
        combatTargetId,
        combatTargetMode: victim.combatTargetMode,
        health: safeInteger(victim.health, `${label}.health`, 1, MAX_HEALTH),
        id: checkedId(victim.id, `${label}.id`),
        kind: victim.kind,
        layer: victim.layer,
        ownerId: safeInteger(
          victim.ownerId,
          `${label}.ownerId`,
          1,
          MAX_OWNER_ID,
        ),
        position,
        radius,
        targetable: victim.targetable,
      };
    });
  const ids = new Set();
  for (const victim of victims) {
    if (ids.has(victim.id)) {
      throw new TypeError("travel spell victim IDs must be unique");
    }
    ids.add(victim.id);
  }
  return victims;
}

function checkedCommands(value, sources, victims) {
  const sourceIds = new Set(sources.map(({ id }) => id));
  const victimIds = new Set(victims.map(({ id }) => id));
  const commands = denseArray(value, MAX_COMMANDS, "travel spell commands")
    .map((entry, index) => {
      const label = `travel spell command ${index}`;
      const command = exactRecord(entry, COMMAND_KEYS, label);
      if (!COMMAND_TYPES.has(command.type)) {
        throw new TypeError(`${label}.type is invalid`);
      }
      const base = {
        center: null,
        effectId: null,
        id: checkedId(command.id, `${label}.id`),
        sourceId: null,
        targetId: null,
        tick: safeInteger(command.tick, `${label}.tick`, 0, MAX_TICK - 1),
        type: command.type,
      };
      if (command.type === "cast") {
        base.center = checkedPosition(command.center, `${label}.center`);
        base.sourceId = checkedId(command.sourceId, `${label}.sourceId`);
        if (
          !sourceIds.has(base.sourceId) ||
          command.effectId !== null ||
          command.targetId !== null
        ) {
          throw new TypeError(`${label} has invalid cast fields`);
        }
      } else if (command.type === "source-died") {
        base.sourceId = checkedId(command.sourceId, `${label}.sourceId`);
        if (
          !sourceIds.has(base.sourceId) ||
          command.center !== null ||
          command.effectId !== null ||
          command.targetId !== null
        ) {
          throw new TypeError(`${label} has invalid source death fields`);
        }
      } else if (command.type === "target-died") {
        base.targetId = checkedId(command.targetId, `${label}.targetId`);
        if (
          !victimIds.has(base.targetId) ||
          command.center !== null ||
          command.effectId !== null ||
          command.sourceId !== null
        ) {
          throw new TypeError(`${label} has invalid target death fields`);
        }
      } else {
        base.effectId = checkedId(command.effectId, `${label}.effectId`);
        if (
          command.center !== null ||
          command.sourceId !== null ||
          command.targetId !== null
        ) {
          throw new TypeError(`${label} has invalid cancellation fields`);
        }
      }
      return base;
    });
  const ids = new Set();
  let priorTick = -1;
  let priorId = -1;
  for (const command of commands) {
    if (ids.has(command.id)) {
      throw new TypeError("travel spell command IDs must be unique");
    }
    ids.add(command.id);
    if (
      command.tick < priorTick ||
      (command.tick === priorTick && command.id <= priorId)
    ) {
      throw new TypeError(
        "travel spell commands must use increasing tick and command-ID order",
      );
    }
    priorTick = command.tick;
    priorId = command.id;
  }
  return commands;
}

function checkedSetup(value) {
  const setup = exactRecord(value, SETUP_KEYS, "travel spell setup");
  const sources = checkedSources(setup.sources);
  const victims = checkedVictims(setup.victims);
  const allIds = new Set(sources.map(({ id }) => id));
  for (const victim of victims) {
    if (allIds.has(victim.id)) {
      throw new TypeError("travel spell source and victim IDs must be disjoint");
    }
    allIds.add(victim.id);
  }
  return {
    commands: checkedCommands(setup.commands, sources, victims),
    sources,
    victims,
  };
}

function projectileCarrier(origin, center) {
  const combat = new ProjectileCombat({
    entities: [
      {
        attackRange: 40000,
        id: 1,
        kind: "troop",
        layer: "ground",
        maxHealth: 1,
        position: { ...origin },
        radius: 0,
        targetMode: "air_and_ground",
        targetable: true,
      },
      {
        attackRange: 0,
        id: 2,
        kind: "troop",
        layer: "ground",
        maxHealth: 1,
        position: { ...center },
        radius: 0,
        targetMode: "none",
        targetable: true,
      },
    ],
  });
  const projectile = combat.launch({
    attackerId: 1,
    damage: 0,
    radius: PROJECTILE_RADIUS,
    speed: SPEED,
    targetId: 2,
    tick: 0,
  });
  return { combat, projectile };
}

function initialState(setup) {
  return {
    commandIndex: 0,
    history: [],
    nextEffectId: 1,
    pending: [],
    sources: setup.sources.map((source) => ({ ...clone(source), alive: true })),
    tick: 0,
    victims: setup.victims.map((victim) => ({
      ...clone(victim),
      alive: true,
    })),
  };
}

function targetEligible(source, victim) {
  return (
    victim.alive &&
    victim.targetable &&
    victim.ownerId !== source.ownerId &&
    VICTIM_KINDS.has(victim.kind) &&
    VICTIM_LAYERS.has(victim.layer)
  );
}

function collisionKey(origin, center, victim) {
  const dx = BigInt(center.x) - BigInt(origin.x);
  const dy = BigInt(center.y) - BigInt(origin.y);
  const px = BigInt(victim.position.x) - BigInt(origin.x);
  const py = BigInt(victim.position.y) - BigInt(origin.y);
  const lengthSquared = dx * dx + dy * dy;
  const radius = BigInt(PROJECTILE_RADIUS + victim.radius);
  if (lengthSquared === 0n) {
    const hit = px * px + py * py <= radius * radius;
    return hit ? 0n : null;
  }
  const dot = px * dx + py * dy;
  if (dot <= 0n) {
    return px * px + py * py <= radius * radius ? 0n : null;
  }
  if (dot >= lengthSquared) {
    const ex = BigInt(victim.position.x) - BigInt(center.x);
    const ey = BigInt(victim.position.y) - BigInt(center.y);
    return ex * ex + ey * ey <= radius * radius
      ? lengthSquared
      : null;
  }
  const cross = px * dy - py * dx;
  return cross * cross <= radius * radius * lengthSquared ? dot : null;
}

function prefixCapsuleContains(origin, center, victim, elapsedTicks, duration) {
  const dx = BigInt(center.x) - BigInt(origin.x);
  const dy = BigInt(center.y) - BigInt(origin.y);
  const px = BigInt(victim.position.x) - BigInt(origin.x);
  const py = BigInt(victim.position.y) - BigInt(origin.y);
  const lengthSquared = dx * dx + dy * dy;
  const radius = BigInt(PROJECTILE_RADIUS + victim.radius);
  const radiusSquared = radius * radius;
  const pointSquared = px * px + py * py;
  if (lengthSquared === 0n || pointSquared <= radiusSquared) {
    return pointSquared <= radiusSquared;
  }
  if (elapsedTicks >= duration) {
    return collisionKey(origin, center, victim) !== null;
  }

  const reach = BigInt(SPEED) * BigInt(elapsedTicks);
  const dot = px * dx + py * dy;
  if (reach === 0n || dot <= 0n) return false;

  const reachSquared = reach * reach;
  if (dot * dot <= reachSquared * lengthSquared) {
    const cross = px * dy - py * dx;
    return cross * cross <= radiusSquared * lengthSquared;
  }

  // Compare |p - unit(d) * reach|² <= radius² without rounding the
  // irrational unit vector. Both sides are non-negative in this branch, so
  // the final squared BigInt comparison is exact.
  const left = (pointSquared + reachSquared - radiusSquared) * lengthSquared;
  if (left <= 0n) return true;
  return (
    left * left <=
    4n * dot * dot * reachSquared * lengthSquared
  );
}

function lineContacts(state, source, impact, elapsedTicks) {
  const contacted = new Set(impact.contactedTargetIds);
  return state.victims
    .filter((victim) => (
      !contacted.has(victim.id) &&
      targetEligible(source, victim)
    ))
    .map((victim) => ({
      key: collisionKey(impact.origin, impact.center, victim),
      victim,
    }))
    .filter(({ key, victim }) => (
      key !== null &&
      prefixCapsuleContains(
        impact.origin,
        impact.center,
        victim,
        elapsedTicks,
        impact.duration,
      )
    ))
    .sort((left, right) => (
      left.key < right.key
        ? -1
        : left.key > right.key
        ? 1
        : left.victim.id - right.victim.id
    ));
}

function emitContacts(state, source, impact, events) {
  const elapsedTicks = state.tick - impact.launchTick;
  const contacts = lineContacts(state, source, impact, elapsedTicks);
  for (const { key, victim } of contacts) {
    impact.contactedTargetIds.push(victim.id);
    events.push({
      effectId: impact.effectId,
      orderNumerator: key.toString(),
      targetId: victim.id,
      tick: state.tick,
      type: "travel-contact",
    });
  }
}

function instantImpact(state, source, impact) {
  const setup = createInstantSpellFixture({
    commands: [{
      center: { ...impact.center },
      id: 1,
      sourceId: source.id,
      targetId: null,
      tick: 0,
      type: "cast",
      variant: "plain",
    }],
    sources: [{ id: source.id, ownerId: source.ownerId }],
    victims: state.victims.map((victim) => ({
      combatTargetId: victim.combatTargetId,
      combatTargetMode: victim.combatTargetMode,
      health: Math.max(1, victim.health),
      id: victim.id,
      kind: victim.kind,
      layer: victim.layer,
      ownerId: victim.ownerId,
      position: { ...victim.position },
      radius: victim.radius,
      targetable: victim.alive && victim.targetable,
    })),
  });
  const encounter = new InstantRadiusSpellEncounter(setup);
  const primitiveEvents = encounter.stepMany(3);
  const primitiveState = encounter.state;
  for (const victim of state.victims) {
    const result = primitiveState.victims.find(({ id }) => id === victim.id);
    if (victim.alive && !result.alive) {
      victim.alive = false;
      victim.health = 0;
    } else if (victim.alive) {
      victim.health = result.health;
    }
  }
  return primitiveEvents;
}

function translatedImpactEvents(state, source, impact) {
  const events = [];
  const primitiveEvents = instantImpact(state, source, impact);
  for (const event of primitiveEvents) {
    if (!event.type.startsWith("spell-") || event.type === "spell-cast") continue;
    events.push({
      ...clone(event),
      effectId: impact.effectId,
      primitiveEffectId: event.effectId,
      tick: state.tick,
      type: `travel-${event.type}`,
    });
  }
  return events;
}

function resolveImpact(state, impact, events) {
  const source = state.sources.find(({ id }) => id === impact.sourceId);
  if (impact.cancelled || !source.alive) {
    events.push({
      effectId: impact.effectId,
      reason: impact.cancelled ? "explicit-cancel" : "source-dead",
      sourceId: impact.sourceId,
      tick: state.tick,
      type: "travel-cancelled",
    });
    return;
  }
  const { combat } = projectileCarrier(impact.origin, impact.center);
  let primitiveEvents = [];
  for (let tick = 0; tick <= impact.duration; tick += 1) {
    primitiveEvents = combat.step(tick);
  }
  const carrierImpact = primitiveEvents.find(({ type }) => type === "impact");
  if (carrierImpact?.status !== "contact") {
    throw new TypeError("travel spell carrier failed to contact its endpoint");
  }
  events.push({
    center: { ...impact.center },
    duration: impact.duration,
    effectId: impact.effectId,
    primitiveProjectileId: carrierImpact.projectileId,
    sourceId: source.id,
    tick: state.tick,
    type: "travel-impact",
  });
  emitContacts(state, source, impact, events);
  events.push(...translatedImpactEvents(state, source, impact));
}

function applyCommand(state, command, events) {
  if (command.type === "cast") {
    const source = state.sources.find(({ id }) => id === command.sourceId);
    if (!source.alive) {
      events.push({
        commandId: command.id,
        reason: "source-dead",
        sourceId: source.id,
        tick: state.tick,
        type: "travel-launch-cancelled",
      });
      return;
    }
    if (state.nextEffectId === Number.MAX_SAFE_INTEGER) {
      throw new RangeError("travel spell effect ID space is exhausted");
    }
    const { projectile } = projectileCarrier(source.position, command.center);
    if (projectile.impactTick > MAX_TICK - 1 - state.tick) {
      throw new RangeError("travel spell impact exceeds encounter tick bound");
    }
    const effectId = state.nextEffectId;
    state.nextEffectId += 1;
    state.pending.push({
      cancelled: false,
      center: { ...command.center },
      contactedTargetIds: [],
      duration: projectile.impactTick,
      effectId,
      impactTick: state.tick + projectile.impactTick,
      launchTick: state.tick,
      origin: { ...source.position },
      sourceId: source.id,
    });
    events.push({
      center: { ...command.center },
      duration: projectile.impactTick,
      effectId,
      impactTick: state.tick + projectile.impactTick,
      origin: { ...source.position },
      primitiveProjectileId: projectile.id,
      sourceId: source.id,
      tick: state.tick,
      type: "travel-launch",
    });
    return;
  }
  if (command.type === "source-died") {
    const source = state.sources.find(({ id }) => id === command.sourceId);
    if (source.alive) {
      source.alive = false;
      events.push({
        sourceId: source.id,
        tick: state.tick,
        type: "travel-source-died",
      });
    }
    return;
  }
  if (command.type === "target-died") {
    const victim = state.victims.find(({ id }) => id === command.targetId);
    if (victim.alive) {
      victim.alive = false;
      victim.health = 0;
      events.push({
        targetId: victim.id,
        tick: state.tick,
        type: "travel-target-died",
      });
    }
    return;
  }
  const pending = state.pending.find(({ effectId }) => (
    effectId === command.effectId
  ));
  if (pending !== undefined && pending.impactTick >= state.tick) {
    pending.cancelled = true;
    events.push({
      effectId: pending.effectId,
      tick: state.tick,
      type: "travel-cancel-requested",
    });
  }
}

function advance(state, commands) {
  if (state.tick >= MAX_TICK) return [];
  const events = [];
  while (commands[state.commandIndex]?.tick === state.tick) {
    const command = commands[state.commandIndex];
    state.commandIndex += 1;
    applyCommand(state, command, events);
  }
  const traveling = state.pending
    .filter(({ impactTick }) => impactTick > state.tick)
    .sort((left, right) => left.effectId - right.effectId);
  for (const impact of traveling) {
    const source = state.sources.find(({ id }) => id === impact.sourceId);
    if (!impact.cancelled && source.alive) {
      emitContacts(state, source, impact, events);
    }
  }
  const due = state.pending
    .filter(({ impactTick }) => impactTick === state.tick)
    .sort((left, right) => left.effectId - right.effectId);
  state.pending = state.pending.filter(
    ({ impactTick }) => impactTick !== state.tick,
  );
  for (const impact of due) resolveImpact(state, impact, events);
  if (state.history.length + events.length > MAX_EVENTS) {
    throw new RangeError("travel spell replay exceeds its event bound");
  }
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

export function createTravelingLineSpellCatalog(...args) {
  if (args.length !== 0) {
    throw new TypeError("travel spell catalog does not accept overrides");
  }
  return createInstantSpellCatalog();
}

export function createTravelingLineSpellQuestionRecords(...args) {
  if (args.length !== 0) {
    throw new TypeError("travel spell questions do not accept overrides");
  }
  return deepFreeze(Object.fromEntries(
    Object.entries(QUESTION_VALUES).map(([key, value]) => [
      key,
      questionRecord(key, value),
    ]),
  ));
}

export function createTravelingLineSpellFixture(value) {
  return clone(checkedSetup(value));
}

/**
 * A bounded traveling carrier followed by one terminal radius impact.
 * Projectile timing and instant impact behavior are delegated to passed
 * primitives. The frozen line-contact policy is observational and does not
 * implement waves, return legs, rolling, or intermediate damage.
 */
export class TravelingLineSpellEncounter {
  #setup;
  #state;
  #feed = createCombatEffectFeed();
  #feedRoots = new Map();

  constructor(setup) {
    this.#setup = checkedSetup(setup);
    this.#state = initialState(this.#setup);
  }

  get replay() {
    return clone(this.#state.history);
  }

  get combatEffectFeed() {
    return combatEffectFeedSnapshot(this.#feed);
  }

  get effectFeed() {
    return this.combatEffectFeed;
  }

  get visualFeed() {
    return this.combatEffectFeed;
  }

  combatEffectFeedBytes() {
    return serializeCombatEffectFeed(this.#feed);
  }

  fork() {
    return TravelingLineSpellEncounter.restore(this.serialize());
  }

  get state() {
    return clone(this.#state);
  }

  step() {
    return this.stepMany(1);
  }

  stepMany(count) {
    safeInteger(count, "travel spell step count", 0, MAX_STEP_CHUNK);
    if (count > MAX_TICK - this.#state.tick) {
      throw new RangeError("travel spell step count exceeds encounter bound");
    }
    const candidate = clone(this.#state);
    const candidateFeed = this.#feed.fork();
    const candidateRoots = new Map([...this.#feedRoots].map(([effectId, root]) => [
      effectId,
      { ...root },
    ]));
    const events = [];
    for (let index = 0; index < count; index += 1) {
      events.push(...advance(candidate, this.#setup.commands));
    }
    this.#observeVisualEvents(candidate, candidateFeed, candidateRoots, events);
    this.#state = candidate;
    this.#feed = candidateFeed;
    this.#feedRoots = candidateRoots;
    return clone(events);
  }

  run() {
    return this.stepMany(MAX_TICK - this.#state.tick);
  }

  serialize() {
    const serialized = canonicalJson({
      identity: {
        fixture: "traveling-line-spell-question-v1",
        setup: this.#setup,
      },
      tick: this.#state.tick,
      version: 1,
    });
    if (Buffer.byteLength(serialized, "utf8") > MAX_SNAPSHOT_BYTES) {
      throw new RangeError("travel spell snapshot exceeds its byte bound");
    }
    return serialized;
  }

  static restore(serialized) {
    if (typeof serialized !== "string") {
      throw new TypeError("travel spell snapshot must be a string");
    }
    if (Buffer.byteLength(serialized, "utf8") > MAX_SNAPSHOT_BYTES) {
      throw new RangeError("travel spell snapshot exceeds its byte bound");
    }
    let value;
    try {
      value = JSON.parse(serialized);
    } catch {
      throw new TypeError("travel spell snapshot must be valid JSON");
    }
    if (canonicalJson(value) !== serialized) {
      throw new TypeError(
        "travel spell snapshot must be canonical duplicate-free JSON",
      );
    }
    const snapshot = exactRecord(value, SNAPSHOT_KEYS, "travel spell snapshot");
    if (snapshot.version !== 1) {
      throw new TypeError("travel spell snapshot version is unsupported");
    }
    const identity = exactRecord(
      snapshot.identity,
      IDENTITY_KEYS,
      "travel spell snapshot.identity",
    );
    if (identity.fixture !== "traveling-line-spell-question-v1") {
      throw new TypeError("travel spell snapshot fixture is unsupported");
    }
    safeInteger(snapshot.tick, "travel spell snapshot.tick", 0, MAX_TICK);
    const encounter = new TravelingLineSpellEncounter(
      checkedSetup(identity.setup),
    );
    encounter.stepMany(snapshot.tick);
    return encounter;
  }

  #observeVisualEvents(state, feed, roots, events) {
    const impactTargets = new Map();
    const completed = [];
    for (const event of events) {
      if (event.type !== "travel-spell-damage") continue;
      const targets = impactTargets.get(event.effectId) ?? [];
      targets.push(event.targetId);
      impactTargets.set(event.effectId, targets);
    }
    for (const targets of impactTargets.values()) targets.sort((left, right) => left - right);

    for (const event of events) {
      if (event.type === "travel-launch") {
        const root = appendCombatEffectRoot(feed, {
          direction: "travel",
          effectId: event.effectId,
          from: event.origin,
          impactTick: event.impactTick,
          projectileId: event.primitiveProjectileId,
          radius: PROJECTILE_RADIUS,
          segments: [],
          sequence: event.effectId,
          sourceId: event.sourceId,
          tick: event.tick,
          to: event.center,
          type: "projectile",
        });
        roots.set(event.effectId, {
          lastEventId: root.eventId,
          rootId: root.rootId,
        });
        continue;
      }
      const root = event.effectId === undefined ? null : roots.get(event.effectId);
      if (root === null || root === undefined) continue;
      if (event.type === "travel-contact") {
        const victim = state.victims.find(({ id }) => id === event.targetId);
        const child = appendCombatEffectEvent(feed, {
          parentId: root.lastEventId,
          payload: {
            point: victim?.position ?? event.point ?? state.sources[0].position,
            status: "contact",
            subId: null,
            targetId: event.targetId,
          },
          phase: "contact",
          rootId: root.rootId,
          tick: event.tick,
          type: "projectile",
        });
        root.lastEventId = child.eventId;
      } else if (event.type === "travel-impact") {
        completed.push(event.effectId);
        const child = appendCombatEffectEvent(feed, {
          parentId: root.lastEventId,
          payload: {
            center: event.center,
            radius: TERMINAL_RADIUS,
            targetIds: impactTargets.get(event.effectId) ?? [],
          },
          phase: "impact",
          rootId: root.rootId,
          tick: event.tick,
          type: "projectile",
        });
        root.lastEventId = child.eventId;
      } else if (event.type === "travel-spell-damage") {
        const child = appendCombatEffectEvent(feed, {
          parentId: root.lastEventId,
          payload: {
            amount: event.amount,
            currentHealthAfter: event.healthAfter,
            currentHealthBefore: event.healthBefore,
            targetId: event.targetId,
          },
          phase: "damage",
          rootId: root.rootId,
          tick: event.tick,
          type: "projectile",
        });
        root.lastEventId = child.eventId;
      } else if (event.type === "travel-spell-death") {
        const child = appendCombatEffectEvent(feed, {
          parentId: root.lastEventId,
          payload: { targetId: event.targetId },
          phase: "death",
          rootId: root.rootId,
          tick: event.tick,
          type: "projectile",
        });
        root.lastEventId = child.eventId;
      } else if (event.type === "travel-cancelled") {
        const child = appendCombatEffectEvent(feed, {
          parentId: root.lastEventId,
          payload: {
            reason: event.reason === "source-dead" ? "source-dead" : "explicit-cancel",
          },
          phase: "close",
          rootId: root.rootId,
          tick: event.tick,
          type: "projectile",
        });
        root.lastEventId = child.eventId;
      }
    }
    for (const effectId of [...new Set(completed)]) {
      const root = roots.get(effectId);
      if (root === undefined) continue;
      const child = appendCombatEffectEvent(feed, {
        parentId: root.lastEventId,
        payload: { reason: "impact-resolved" },
        phase: "close",
        rootId: root.rootId,
        tick: events.find(({ effectId: id, type }) => id === effectId && type === "travel-impact").tick,
        type: "projectile",
      });
      root.lastEventId = child.eventId;
    }
  }
}
