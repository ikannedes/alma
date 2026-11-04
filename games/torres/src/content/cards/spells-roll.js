import {
  ARENA_LENGTH_MILLITILES,
  ARENA_WIDTH_MILLITILES,
} from "../../sim/arena-geometry.js";
import {
  InstantRadiusSpellEncounter,
  createInstantSpellFixture,
} from "./spells-instant.js";
import {
  TravelingLineSpellEncounter,
  createTravelingLineSpellFixture,
} from "./spells-travel-line.js";

const SOURCE = "unsourced-rolling-collision-spell-composition";
const DAMAGE = 290;
const CROWN_DAMAGE = 87;
const ROLL_RADIUS = 1950;
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
const MAX_OBSTACLES = 64;
const COMMAND_KEYS = [
  "center", "effectId", "id", "obstacleId", "sourceId", "targetId", "tick",
  "type",
];
const SETUP_KEYS = ["commands", "obstacles", "sources", "victims"];
const SOURCE_KEYS = ["id", "ownerId", "position"];
const VICTIM_KEYS = [
  "combatTargetId", "combatTargetMode", "health", "id", "kind", "layer",
  "ownerId", "position", "radius", "targetable",
];
const OBSTACLE_KEYS = ["blocking", "id", "position", "radius"];
const SNAPSHOT_KEYS = ["identity", "tick", "version"];
const IDENTITY_KEYS = ["fixture", "setup"];
const COMMAND_TYPES = new Set([
  "cancel-effect", "cast", "obstacle-died", "source-died", "target-died",
]);
const VICTIM_KINDS = new Set(["crown", "structure", "troop"]);
const VICTIM_LAYERS = new Set(["air", "ground"]);
const COMBAT_TARGET_MODES = new Set([
  "air", "air_and_ground", "buildings", "ground", "none",
]);

const QUESTION_VALUES = Object.freeze({
  cancellationBoundary:
    "commands-first; cancellation or source death prevents same-tick new contacts",
  collisionDamage:
    "unverified-corpus-value-290; crown damage uses nearest-half-up three-tenths",
  collisionGeometry:
    "static-cast-snapshot swept closed capsule; radius 1950 plus target radius",
  collisionOrder:
    "exact swept-capsule entry then stable numeric ID",
  damageComposition:
    "passed instant plain damage event phases adapted to one contacted target",
  expiryBoundary: "expire after inclusive endpoint contacts at carrier impact tick",
  movingTargetPolicy: "cast-time position snapshot",
  obstaclePolicy:
    "first living blocking obstacle stops roll before equal-or-later contacts",
  repeatHitPolicy: "at-most-once per target per rolling effect",
  rollingRadiusMillitiles: ROLL_RADIUS,
  sameBoundaryOrder:
    "commands then effects by ID then contacts by path key; each damage is atomic",
  sourceDeathAfterContact: "does not undo prior contact damage",
  stopBoundary: "obstacle contact emits stop and suppresses terminal expiry",
  targetDeathBoundary:
    "command-first death excludes contact; earlier effect death excludes later effect",
  targetFilter: "living targetable hostile ground troop structure or crown",
  travelComposition: "passed traveling-line carrier determines exact duration",
  travelSpeedMillitilesPerTick: 1000,
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
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
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
  return Array.from({ length: value.length }, (_, index) => (
    descriptors[index].value
  ));
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
    x: safeInteger(position.x, `${label}.x`, 0, ARENA_WIDTH_MILLITILES),
    y: safeInteger(position.y, `${label}.y`, 0, ARENA_LENGTH_MILLITILES),
  };
}

function checkedSources(value) {
  const sources = denseArray(value, MAX_SOURCES, "rolling spell sources")
    .map((entry, index) => {
      const label = `rolling spell source ${index}`;
      const source = exactRecord(entry, SOURCE_KEYS, label);
      return {
        id: checkedId(source.id, `${label}.id`),
        ownerId: safeInteger(source.ownerId, `${label}.ownerId`, 1, MAX_OWNER_ID),
        position: checkedPosition(source.position, `${label}.position`),
      };
    });
  if (sources.length === 0) throw new RangeError("rolling spell sources must not be empty");
  uniqueIds(sources, "rolling spell source");
  return sources;
}

function checkedVictims(value) {
  const victims = denseArray(value, MAX_VICTIMS, "rolling spell victims")
    .map((entry, index) => {
      const label = `rolling spell victim ${index}`;
      const victim = exactRecord(entry, VICTIM_KEYS, label);
      if (!VICTIM_KINDS.has(victim.kind)) throw new TypeError(`${label}.kind is invalid`);
      if (!VICTIM_LAYERS.has(victim.layer)) throw new TypeError(`${label}.layer is invalid`);
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
        victim.combatTargetId, `${label}.combatTargetId`, true,
      );
      if ((combatTargetId === null) !== (victim.combatTargetMode === null)) {
        throw new TypeError(`${label} combat target fields must both be null or non-null`);
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
        ownerId: safeInteger(victim.ownerId, `${label}.ownerId`, 1, MAX_OWNER_ID),
        position,
        radius,
        targetable: victim.targetable,
      };
    });
  uniqueIds(victims, "rolling spell victim");
  return victims;
}

function checkedObstacles(value) {
  const obstacles = denseArray(value, MAX_OBSTACLES, "rolling spell obstacles")
    .map((entry, index) => {
      const label = `rolling spell obstacle ${index}`;
      const obstacle = exactRecord(entry, OBSTACLE_KEYS, label);
      if (typeof obstacle.blocking !== "boolean") {
        throw new TypeError(`${label}.blocking must be boolean`);
      }
      const position = checkedPosition(obstacle.position, `${label}.position`);
      const radius = safeInteger(obstacle.radius, `${label}.radius`, 0, MAX_RADIUS);
      return {
        blocking: obstacle.blocking,
        id: checkedId(obstacle.id, `${label}.id`),
        position,
        radius,
      };
    });
  uniqueIds(obstacles, "rolling spell obstacle");
  return obstacles;
}

function uniqueIds(records, label) {
  const ids = new Set();
  for (const record of records) {
    if (ids.has(record.id)) throw new TypeError(`${label} IDs must be unique`);
    ids.add(record.id);
  }
}

function checkedCommands(value, sources, victims, obstacles) {
  const sourceIds = new Set(sources.map(({ id }) => id));
  const victimIds = new Set(victims.map(({ id }) => id));
  const obstacleIds = new Set(obstacles.map(({ id }) => id));
  const commands = denseArray(value, MAX_COMMANDS, "rolling spell commands")
    .map((entry, index) => {
      const label = `rolling spell command ${index}`;
      const command = exactRecord(entry, COMMAND_KEYS, label);
      if (!COMMAND_TYPES.has(command.type)) throw new TypeError(`${label}.type is invalid`);
      const result = {
        center: null,
        effectId: null,
        id: checkedId(command.id, `${label}.id`),
        obstacleId: null,
        sourceId: null,
        targetId: null,
        tick: safeInteger(command.tick, `${label}.tick`, 0, MAX_TICK - 1),
        type: command.type,
      };
      if (command.type === "cast") {
        result.center = checkedPosition(command.center, `${label}.center`);
        result.sourceId = checkedId(command.sourceId, `${label}.sourceId`);
        if (
          !sourceIds.has(result.sourceId) ||
          command.effectId !== null ||
          command.obstacleId !== null ||
          command.targetId !== null
        ) throw new TypeError(`${label} has invalid cast fields`);
      } else if (command.type === "source-died") {
        result.sourceId = checkedId(command.sourceId, `${label}.sourceId`);
        if (
          !sourceIds.has(result.sourceId) ||
          command.center !== null ||
          command.effectId !== null ||
          command.obstacleId !== null ||
          command.targetId !== null
        ) throw new TypeError(`${label} has invalid source death fields`);
      } else if (command.type === "target-died") {
        result.targetId = checkedId(command.targetId, `${label}.targetId`);
        if (
          !victimIds.has(result.targetId) ||
          command.center !== null ||
          command.effectId !== null ||
          command.obstacleId !== null ||
          command.sourceId !== null
        ) throw new TypeError(`${label} has invalid target death fields`);
      } else if (command.type === "obstacle-died") {
        result.obstacleId = checkedId(command.obstacleId, `${label}.obstacleId`);
        if (
          !obstacleIds.has(result.obstacleId) ||
          command.center !== null ||
          command.effectId !== null ||
          command.sourceId !== null ||
          command.targetId !== null
        ) throw new TypeError(`${label} has invalid obstacle death fields`);
      } else {
        result.effectId = checkedId(command.effectId, `${label}.effectId`);
        if (
          command.center !== null ||
          command.obstacleId !== null ||
          command.sourceId !== null ||
          command.targetId !== null
        ) throw new TypeError(`${label} has invalid cancellation fields`);
      }
      return result;
    });
  uniqueIds(commands, "rolling spell command");
  let priorTick = -1;
  let priorId = -1;
  for (const command of commands) {
    if (
      command.tick < priorTick ||
      (command.tick === priorTick && command.id <= priorId)
    ) throw new TypeError("rolling spell commands must use increasing tick and command-ID order");
    priorTick = command.tick;
    priorId = command.id;
  }
  return commands;
}

function checkedSetup(value) {
  const setup = exactRecord(value, SETUP_KEYS, "rolling spell setup");
  const sources = checkedSources(setup.sources);
  const victims = checkedVictims(setup.victims);
  const obstacles = checkedObstacles(setup.obstacles);
  const all = [...sources, ...victims, ...obstacles];
  const ids = new Set();
  for (const record of all) {
    if (ids.has(record.id)) throw new TypeError("rolling spell entity IDs must be disjoint");
    ids.add(record.id);
  }
  return {
    commands: checkedCommands(setup.commands, sources, victims, obstacles),
    obstacles,
    sources,
    victims,
  };
}

function initialState(setup) {
  return {
    commandIndex: 0,
    history: [],
    nextEffectId: 1,
    obstacles: setup.obstacles.map((entry) => ({ ...clone(entry), alive: true })),
    pending: [],
    sources: setup.sources.map((entry) => ({ ...clone(entry), alive: true })),
    tick: 0,
    victims: setup.victims.map((entry) => ({ ...clone(entry), alive: true })),
  };
}

function lineCarrier(origin, center) {
  const setup = createTravelingLineSpellFixture({
    commands: [{
      center: { ...center },
      effectId: null,
      id: 1,
      sourceId: 1,
      targetId: null,
      tick: 0,
      type: "cast",
    }],
    sources: [{ id: 1, ownerId: 1, position: { ...origin } }],
    victims: [],
  });
  const encounter = new TravelingLineSpellEncounter(setup);
  const launch = encounter.step().find(({ type }) => type === "travel-launch");
  return { duration: launch.duration, primitiveEffectId: launch.effectId };
}

function targetEligible(source, victim) {
  return (
    victim.alive &&
    victim.targetable &&
    victim.ownerId !== source.ownerId &&
    victim.layer === "ground" &&
    VICTIM_KINDS.has(victim.kind)
  );
}

function contactKey(origin, center, position, radius) {
  const dx = BigInt(center.x) - BigInt(origin.x);
  const dy = BigInt(center.y) - BigInt(origin.y);
  const px = BigInt(position.x) - BigInt(origin.x);
  const py = BigInt(position.y) - BigInt(origin.y);
  const lengthSquared = dx * dx + dy * dy;
  const combined = BigInt(ROLL_RADIUS + radius);
  const radiusSquared = combined * combined;
  const pointSquared = px * px + py * py;
  if (pointSquared <= radiusSquared) {
    return { radical: 0n, whole: 0n };
  }
  if (lengthSquared === 0n) {
    return null;
  }
  const dot = px * dx + py * dy;
  const cross = px * dy - py * dx;
  const radical = radiusSquared * lengthSquared - cross * cross;
  if (radical < 0n) return null;
  if (dot < 0n && dot * dot > radical) return null;
  const beyondEnd = dot - lengthSquared;
  if (beyondEnd > 0n && beyondEnd * beyondEnd > radical) return null;
  return { radical, whole: dot };
}

function compareContactKeys(left, right) {
  const wholeDifference = left.whole - right.whole;
  if (wholeDifference < 0n) return -compareContactKeys(right, left);
  if (wholeDifference === 0n) {
    return left.radical > right.radical ? -1 :
      left.radical < right.radical ? 1 : 0;
  }
  const remainder = left.radical -
    wholeDifference * wholeDifference -
    right.radical;
  if (remainder < 0n) return 1;
  if (remainder === 0n) return right.radical === 0n ? 0 : 1;
  const squaredRemainder = remainder * remainder;
  const squaredRadical = 4n * wholeDifference * wholeDifference * right.radical;
  return squaredRemainder > squaredRadical ? -1 :
    squaredRemainder < squaredRadical ? 1 : 0;
}

function contactOrderNumerator(key) {
  return key.whole.toString();
}

function prefixContains(effect, position, radius, elapsed) {
  const { origin, center, duration } = effect;
  const dx = BigInt(center.x) - BigInt(origin.x);
  const dy = BigInt(center.y) - BigInt(origin.y);
  const px = BigInt(position.x) - BigInt(origin.x);
  const py = BigInt(position.y) - BigInt(origin.y);
  const lengthSquared = dx * dx + dy * dy;
  const combined = BigInt(ROLL_RADIUS + radius);
  const radiusSquared = combined * combined;
  const pointSquared = px * px + py * py;
  if (lengthSquared === 0n || pointSquared <= radiusSquared) {
    return pointSquared <= radiusSquared;
  }
  if (elapsed >= duration) {
    return contactKey(origin, center, position, radius) !== null;
  }
  const reach = 1000n * BigInt(elapsed);
  const dot = px * dx + py * dy;
  if (reach === 0n || dot <= 0n) return false;
  const reachSquared = reach * reach;
  if (dot * dot <= reachSquared * lengthSquared) {
    const cross = px * dy - py * dx;
    return cross * cross <= radiusSquared * lengthSquared;
  }
  const left = (pointSquared + reachSquared - radiusSquared) * lengthSquared;
  if (left <= 0n) return true;
  return left * left <= 4n * dot * dot * reachSquared * lengthSquared;
}

function contactCandidates(state, source, effect) {
  const elapsed = state.tick - effect.launchTick;
  const hit = new Set(effect.contactedTargetIds);
  const targets = state.victims
    .filter((victim) => targetEligible(source, victim) && !hit.has(victim.id))
    .map((victim) => ({
      id: victim.id,
      key: contactKey(effect.origin, effect.center, victim.position, victim.radius),
      record: victim,
      type: "target",
    }));
  const obstacles = state.obstacles
    .filter((obstacle) => obstacle.alive && obstacle.blocking)
    .map((obstacle) => ({
      id: obstacle.id,
      key: contactKey(
        effect.origin, effect.center, obstacle.position, obstacle.radius,
      ),
      record: obstacle,
      type: "obstacle",
    }));
  return [...targets, ...obstacles]
    .filter(({ key, record }) => (
      key !== null &&
      prefixContains(effect, record.position, record.radius, elapsed)
    ))
    .sort((left, right) => (
      compareContactKeys(left.key, right.key) ||
      left.id - right.id
    ));
}

function instantDamagePhases(source, victim) {
  const fixture = createInstantSpellFixture({
    commands: [{
      center: { ...victim.position },
      id: 1,
      sourceId: source.id,
      targetId: null,
      tick: 0,
      type: "cast",
      variant: "plain",
    }],
    sources: [{ id: source.id, ownerId: source.ownerId }],
    victims: [{
      combatTargetId: victim.combatTargetId,
      combatTargetMode: victim.combatTargetMode,
      health: Math.max(1, victim.health),
      id: victim.id,
      kind: victim.kind,
      layer: victim.layer,
      ownerId: victim.ownerId,
      position: { ...victim.position },
      radius: victim.radius,
      targetable: true,
    }],
  });
  const primitive = new InstantRadiusSpellEncounter(fixture);
  return primitive.run().filter(({ type }) => (
    type === "spell-hit" ||
    type === "spell-damage" ||
    type === "spell-death"
  ));
}

function damageTarget(state, source, effect, victim, key, events) {
  const phases = instantDamagePhases(source, victim);
  if (!phases.some(({ type }) => type === "spell-hit")) {
    throw new TypeError("rolling spell instant damage composition failed");
  }
  const amount = victim.kind === "crown" ? CROWN_DAMAGE : DAMAGE;
  const healthBefore = victim.health;
  const healthAfter = Math.max(0, healthBefore - amount);
  effect.contactedTargetIds.push(victim.id);
  events.push({
    effectId: effect.effectId,
    orderNumerator: contactOrderNumerator(key),
    targetId: victim.id,
    tick: state.tick,
    type: "roll-contact",
  }, {
    amount,
    effectId: effect.effectId,
    primitiveEffectId: phases[0].effectId,
    targetId: victim.id,
    tick: state.tick,
    type: "roll-hit",
  }, {
    amount,
    effectId: effect.effectId,
    healthAfter,
    healthBefore,
    primitiveEffectId: phases[0].effectId,
    targetId: victim.id,
    tick: state.tick,
    type: "roll-damage",
  });
  victim.health = healthAfter;
  if (healthAfter === 0) {
    victim.alive = false;
    events.push({
      effectId: effect.effectId,
      primitiveEffectId: phases.at(-1).effectId,
      targetId: victim.id,
      tick: state.tick,
      type: "roll-death",
    });
  }
}

function resolveEffectBoundary(state, effect, events) {
  const source = state.sources.find(({ id }) => id === effect.sourceId);
  if (effect.cancelled || !source.alive) {
    events.push({
      effectId: effect.effectId,
      reason: effect.cancelled ? "explicit-cancel" : "source-dead",
      sourceId: effect.sourceId,
      tick: state.tick,
      type: "roll-cancelled",
    });
    return true;
  }
  const candidates = contactCandidates(state, source, effect);
  const blocker = candidates.find(({ type }) => type === "obstacle");
  for (const candidate of candidates) {
    if (
      blocker !== undefined &&
      compareContactKeys(candidate.key, blocker.key) >= 0
    ) {
      events.push({
        effectId: effect.effectId,
        obstacleId: blocker.id,
        orderNumerator: contactOrderNumerator(blocker.key),
        tick: state.tick,
        type: "roll-stopped",
      });
      return true;
    }
    if (candidate.record.alive) {
      damageTarget(
        state, source, effect, candidate.record, candidate.key, events,
      );
    }
  }
  if (state.tick === effect.expiryTick) {
    events.push({
      center: { ...effect.center },
      duration: effect.duration,
      effectId: effect.effectId,
      sourceId: effect.sourceId,
      tick: state.tick,
      type: "roll-expired",
    });
    return true;
  }
  return false;
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
        type: "roll-launch-cancelled",
      });
      return;
    }
    if (state.nextEffectId === Number.MAX_SAFE_INTEGER) {
      throw new RangeError("rolling spell effect ID space is exhausted");
    }
    const carrier = lineCarrier(source.position, command.center);
    if (carrier.duration > MAX_TICK - 1 - state.tick) {
      throw new RangeError("rolling spell expiry exceeds encounter tick bound");
    }
    const effectId = state.nextEffectId;
    state.nextEffectId += 1;
    state.pending.push({
      cancelled: false,
      center: { ...command.center },
      contactedTargetIds: [],
      duration: carrier.duration,
      effectId,
      expiryTick: state.tick + carrier.duration,
      launchTick: state.tick,
      origin: { ...source.position },
      primitiveEffectId: carrier.primitiveEffectId,
      sourceId: source.id,
    });
    events.push({
      center: { ...command.center },
      duration: carrier.duration,
      effectId,
      expiryTick: state.tick + carrier.duration,
      origin: { ...source.position },
      primitiveEffectId: carrier.primitiveEffectId,
      radius: ROLL_RADIUS,
      sourceId: source.id,
      tick: state.tick,
      type: "roll-launch",
    });
    return;
  }
  if (command.type === "source-died") {
    const source = state.sources.find(({ id }) => id === command.sourceId);
    if (source.alive) {
      source.alive = false;
      events.push({ sourceId: source.id, tick: state.tick, type: "roll-source-died" });
    }
    return;
  }
  if (command.type === "target-died") {
    const victim = state.victims.find(({ id }) => id === command.targetId);
    if (victim.alive) {
      victim.alive = false;
      victim.health = 0;
      events.push({ targetId: victim.id, tick: state.tick, type: "roll-target-died" });
    }
    return;
  }
  if (command.type === "obstacle-died") {
    const obstacle = state.obstacles.find(({ id }) => id === command.obstacleId);
    if (obstacle.alive) {
      obstacle.alive = false;
      events.push({
        obstacleId: obstacle.id, tick: state.tick, type: "roll-obstacle-died",
      });
    }
    return;
  }
  const effect = state.pending.find(({ effectId }) => effectId === command.effectId);
  if (effect !== undefined && effect.expiryTick >= state.tick) {
    effect.cancelled = true;
    events.push({
      effectId: effect.effectId, tick: state.tick, type: "roll-cancel-requested",
    });
  }
}

function advance(state, commands) {
  if (state.tick >= MAX_TICK) return [];
  const events = [];
  while (commands[state.commandIndex]?.tick === state.tick) {
    applyCommand(state, commands[state.commandIndex], events);
    state.commandIndex += 1;
  }
  const completed = new Set();
  for (const effect of [...state.pending].sort((a, b) => a.effectId - b.effectId)) {
    if (resolveEffectBoundary(state, effect, events)) completed.add(effect.effectId);
  }
  state.pending = state.pending.filter(({ effectId }) => !completed.has(effectId));
  if (state.history.length + events.length > MAX_EVENTS) {
    throw new RangeError("rolling spell replay exceeds its event bound");
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

export function createRollingSpellCatalog(...args) {
  if (args.length !== 0) throw new TypeError("rolling spell catalog does not accept overrides");
  return deepFreeze([{
    areaDamageRadiusMillitiles: ROLL_RADIUS,
    components: [],
    cost: 2,
    count: 1,
    damage: DAMAGE,
    deployTimeTicks: null,
    displayName: "Ironbark Roller",
    firstHitTicks: null,
    hitSpeedTicks: null,
    hitpoints: null,
    id: "ironbark-roller",
    kind: "effect",
    movementMillitilesPerSecond: null,
    rangeMillitiles: null,
    rarity: "mythic",
    sightRangeMillitiles: null,
    targetMode: "ground",
  }]);
}

export function createRollingSpellQuestionRecords(...args) {
  if (args.length !== 0) throw new TypeError("rolling spell questions do not accept overrides");
  return deepFreeze(Object.fromEntries(
    Object.entries(QUESTION_VALUES).map(([key, value]) => [
      key, questionRecord(key, value),
    ]),
  ));
}

export function createRollingSpellFixture(value) {
  return clone(checkedSetup(value));
}

/**
 * One deterministic rolling carrier. It damages each eligible target once,
 * stops at the first blocking obstacle, and otherwise expires at its endpoint.
 * This composes the passed line carrier and instant damage phase behavior; it
 * deliberately does not implement waves, a return leg, or terminal spawning.
 */
export class RollingSpellEncounter {
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
    safeInteger(count, "rolling spell step count", 0, MAX_STEP_CHUNK);
    if (count > MAX_TICK - this.#state.tick) {
      throw new RangeError("rolling spell step count exceeds encounter bound");
    }
    const candidate = clone(this.#state);
    const events = [];
    for (let index = 0; index < count; index += 1) {
      events.push(...advance(candidate, this.#setup.commands));
    }
    this.#state = candidate;
    return clone(events);
  }

  run() {
    return this.stepMany(MAX_TICK - this.#state.tick);
  }

  serialize() {
    const serialized = canonicalJson({
      identity: { fixture: "rolling-spell-question-v1", setup: this.#setup },
      tick: this.#state.tick,
      version: 1,
    });
    if (Buffer.byteLength(serialized, "utf8") > MAX_SNAPSHOT_BYTES) {
      throw new RangeError("rolling spell snapshot exceeds its byte bound");
    }
    return serialized;
  }

  static restore(serialized) {
    if (typeof serialized !== "string") {
      throw new TypeError("rolling spell snapshot must be a string");
    }
    if (Buffer.byteLength(serialized, "utf8") > MAX_SNAPSHOT_BYTES) {
      throw new RangeError("rolling spell snapshot exceeds its byte bound");
    }
    let value;
    try {
      value = JSON.parse(serialized);
    } catch {
      throw new TypeError("rolling spell snapshot must be valid JSON");
    }
    if (canonicalJson(value) !== serialized) {
      throw new TypeError("rolling spell snapshot must be canonical duplicate-free JSON");
    }
    const snapshot = exactRecord(value, SNAPSHOT_KEYS, "rolling spell snapshot");
    if (snapshot.version !== 1) throw new TypeError("rolling spell snapshot version is unsupported");
    const identity = exactRecord(
      snapshot.identity, IDENTITY_KEYS, "rolling spell snapshot.identity",
    );
    if (identity.fixture !== "rolling-spell-question-v1") {
      throw new TypeError("rolling spell snapshot fixture is unsupported");
    }
    safeInteger(snapshot.tick, "rolling spell snapshot.tick", 0, MAX_TICK);
    const encounter = new RollingSpellEncounter(checkedSetup(identity.setup));
    encounter.stepMany(snapshot.tick);
    return encounter;
  }
}
