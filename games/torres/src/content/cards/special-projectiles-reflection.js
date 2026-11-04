import { DamageSystem } from "../../sim/damage.js";
import { MAX_SPATIAL_MILLITILES } from "../../sim/spatial.js";
import { createCardCatalog } from "../schema.js";

const DEFINITIONS = [{
  id: "aegis-sage",
  displayName: "Aegis Sage",
  cost: 5,
  kind: "unit",
  rarity: "heroic",
  hitpoints: 2000,
  damage: 140,
  hitSpeedTicks: 48,
  firstHitTicks: 36,
  deployTimeTicks: 60,
  rangeMillitiles: 1200,
  sightRangeMillitiles: 5500,
  movementMillitilesPerSecond: 1000,
  targetMode: "ground",
  count: 1,
  areaDamageRadiusMillitiles: null,
  components: [],
}];

const QUESTION_SOURCE = "unsourced-projectile-reflection-fixture";
function question(value) {
  return Object.freeze({
    authoritative: false,
    confidence: "unverified",
    disposition: "question",
    source: QUESTION_SOURCE,
    value,
  });
}

const QUESTION_FIXTURES = Object.freeze({
  benchmarkHitpoints: question(2000),
  benchmarkDamage: question(140),
  benchmarkHitSpeedSeconds: question(0.8),
  benchmarkFirstHitSeconds: question(0.6),
  benchmarkDeployTimeSeconds: question(1),
  benchmarkRangeTiles: question(1.2),
  benchmarkSightRangeTiles: question(5.5),
  benchmarkMovementSpeedTilesPerSecond: question(1),
  benchmarkMovementSpeed: question("medium"),
  benchmarkTargets: question("ground"),
  benchmarkCount: question(1),
  reflectionEligibilityRule: question(
    "alive-targetable-enemy-reflector-intersecting-flight-segment",
  ),
  reflectionRadiusMillitiles: question(500),
  reflectionTimingRule: question("commands-then-reflection-before-contact-damage"),
  reflectedOwnershipRule: question("reflector-owner"),
  reflectedTargetRule: question("original-source"),
  reflectedSpeedRule: question("carry-parent-speed"),
  reflectedDamageRule: question("carry-parent-damage"),
  selfReflectionRule: question("source-and-current-target-ineligible"),
  loopPolicy: question("one-reflection-maximum"),
  maximumReflections: question(1),
  lifecycleRule: question("replace-parent-atomically"),
  eventOrderRule: question(
    "commands;projectiles-by-id;reflector-by-id;contact;damage;death",
  ),
  sourceProvenanceRule: question("replacement-source-is-reflector"),
  sourceDeathRule: question("launched-projectile-continues"),
  targetDeathRule: question("dead-before-contact-fizzles"),
  geometryRule: question("inclusive-integer-segment-circle"),
  movingTargetRule: question("launch-time-position-snapshots"),
  simultaneousReflectionRule: question("parent-projectile-id-order"),
  invalidReflectorRule: question("dead-friendly-untargetable-and-nonreflector-ignore"),
  integerPathDomainRule: question(
    "reject-at-setup-unless-every-required-straight-leg-has-integer-tick-positions",
  ),
});

const ENTITY_KEYS = [
  "alive", "id", "kind", "layer", "maxHealth", "ownerId", "position",
  "radius", "reflector", "targetable",
];
const POSITION_KEYS = ["x", "y"];
const PROJECTILE_KEYS = [
  "damage", "ownerId", "radius", "sourceId", "speed", "targetId",
];
const COMMAND_KEYS = ["targetId", "tick", "type"];
const SETUP_KEYS = ["commands", "entities", "projectiles"];
const SNAPSHOT_KEYS = ["identity", "tick", "version"];
const MAX_ENTITIES = 32;
const MAX_PROJECTILES = 32;
const MAX_COMMANDS = 64;
const MAX_TICK = 128;
const MAX_REPLAY_EVENTS = 1024;
const MAX_SNAPSHOT_BYTES = 131_072;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
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
    Array.from({ length: value.length }, (_, index) => index).some((index) =>
      !descriptors[index]?.enumerable ||
      !Object.hasOwn(descriptors[index], "value"))
  ) throw new TypeError(`${label} must contain dense data properties`);
  return Array.from({ length: value.length }, (_, index) =>
    descriptors[index].value);
}

function safeInteger(value, label, minimum = -Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new TypeError(`${label} must be a safe integer`);
  }
  return value;
}

function checkedPosition(value, label) {
  const position = exactRecord(value, POSITION_KEYS, label);
  for (const key of POSITION_KEYS) {
    safeInteger(position[key], `${label}.${key}`);
    if (Math.abs(position[key]) > MAX_SPATIAL_MILLITILES) {
      throw new RangeError(`${label}.${key} exceeds spatial bounds`);
    }
  }
  return { ...position };
}

function checkedEntity(value, index) {
  const label = `reflection entity ${index}`;
  const raw = exactRecord(value, ENTITY_KEYS, label);
  safeInteger(raw.id, `${label}.id`, 1);
  safeInteger(raw.maxHealth, `${label}.maxHealth`, 1);
  safeInteger(raw.ownerId, `${label}.ownerId`, 1);
  safeInteger(raw.radius, `${label}.radius`, 0);
  if (raw.radius > MAX_SPATIAL_MILLITILES) {
    throw new RangeError(`${label}.radius exceeds spatial bounds`);
  }
  if (typeof raw.alive !== "boolean" || typeof raw.reflector !== "boolean" ||
    typeof raw.targetable !== "boolean") {
    throw new TypeError(`${label} flags must be booleans`);
  }
  if (!["troop", "structure"].includes(raw.kind) ||
    !["air", "ground"].includes(raw.layer)) {
    throw new TypeError(`${label} kind or layer is invalid`);
  }
  return { ...raw, position: checkedPosition(raw.position, `${label}.position`) };
}

function checkedProjectile(value, index, entityById) {
  const label = `reflection projectile ${index}`;
  const raw = exactRecord(value, PROJECTILE_KEYS, label);
  for (const key of ["ownerId", "sourceId", "targetId"]) {
    safeInteger(raw[key], `${label}.${key}`, 1);
  }
  safeInteger(raw.damage, `${label}.damage`, 0);
  safeInteger(raw.radius, `${label}.radius`, 0);
  safeInteger(raw.speed, `${label}.speed`, 1);
  if (raw.radius > MAX_SPATIAL_MILLITILES ||
    raw.speed > MAX_SPATIAL_MILLITILES) {
    throw new RangeError(`${label} geometry exceeds bounds`);
  }
  if (!entityById.has(raw.sourceId) || !entityById.has(raw.targetId) ||
    raw.sourceId === raw.targetId) {
    throw new TypeError(`${label} endpoints must name distinct entities`);
  }
  if (entityById.get(raw.sourceId).ownerId !== raw.ownerId) {
    throw new TypeError(`${label}.ownerId must match its source`);
  }
  return { ...raw };
}

function checkedSetup(value) {
  const raw = exactRecord(value, SETUP_KEYS, "reflection setup");
  const entities = denseArray(raw.entities, MAX_ENTITIES, "reflection entities")
    .map(checkedEntity).sort((a, b) => a.id - b.id);
  const entityById = new Map(entities.map((entity) => [entity.id, entity]));
  if (entityById.size !== entities.length) {
    throw new TypeError("reflection entities must have unique IDs");
  }
  const projectiles = denseArray(
    raw.projectiles, MAX_PROJECTILES, "reflection projectiles",
  ).map((entry, index) => checkedProjectile(entry, index, entityById))
    .sort((a, b) =>
      a.sourceId - b.sourceId || a.targetId - b.targetId ||
      a.ownerId - b.ownerId || a.damage - b.damage ||
      a.speed - b.speed || a.radius - b.radius);
  const signatures = new Set(projectiles.map((entry) =>
    canonicalJson(entry)));
  if (signatures.size !== projectiles.length) {
    throw new TypeError("reflection projectiles must be unique");
  }
  const commands = denseArray(raw.commands, MAX_COMMANDS, "reflection commands")
    .map((entry, index) => {
      const command = exactRecord(entry, COMMAND_KEYS, `reflection command ${index}`);
      if (command.type !== "kill-entity") {
        throw new TypeError(`reflection command ${index}.type is invalid`);
      }
      safeInteger(command.tick, `reflection command ${index}.tick`, 0);
      safeInteger(command.targetId, `reflection command ${index}.targetId`, 1);
      if (command.tick > MAX_TICK || !entityById.has(command.targetId)) {
        throw new TypeError(`reflection command ${index} is out of bounds`);
      }
      return { ...command };
    }).sort((a, b) => a.tick - b.tick || a.targetId - b.targetId);
  for (let index = 1; index < commands.length; index += 1) {
    if (commands[index - 1].tick === commands[index].tick &&
      commands[index - 1].targetId === commands[index].targetId) {
      throw new TypeError("reflection commands must be unique");
    }
  }
  validateProjectilePaths(entities, projectiles);
  return { commands, entities, projectiles };
}

function defaultSetup() {
  return {
    commands: [],
    entities: [
      entity(101, -4000, 0, 1),
      entity(201, 0, 0, 2, { reflector: true }),
      entity(301, 4000, 0, 2),
    ],
    projectiles: [{
      damage: 140, ownerId: 1, radius: 0, sourceId: 101, speed: 1000,
      targetId: 301,
    }],
  };
}

function entity(
  id, x, y, ownerId,
  { alive = true, kind = "troop", layer = "ground", maxHealth = 1000,
    radius = 0, reflector = false, targetable = true } = {},
) {
  return {
    alive, id, kind, layer, maxHealth, ownerId, position: { x, y }, radius,
    reflector, targetable,
  };
}

function squaredDistance(left, right) {
  const dx = BigInt(left.x) - BigInt(right.x);
  const dy = BigInt(left.y) - BigInt(right.y);
  return dx * dx + dy * dy;
}

function segmentCircleIntersects(start, end, center, radius) {
  const dx = BigInt(end.x) - BigInt(start.x);
  const dy = BigInt(end.y) - BigInt(start.y);
  const px = BigInt(center.x) - BigInt(start.x);
  const py = BigInt(center.y) - BigInt(start.y);
  const lengthSquared = dx * dx + dy * dy;
  const reach = BigInt(radius);
  if (lengthSquared === 0n) return px * px + py * py <= reach * reach;
  const dot = px * dx + py * dy;
  if (dot <= 0n) return px * px + py * py <= reach * reach;
  if (dot >= lengthSquared) {
    const ex = BigInt(center.x) - BigInt(end.x);
    const ey = BigInt(center.y) - BigInt(end.y);
    return ex * ex + ey * ey <= reach * reach;
  }
  const cross = px * dy - py * dx;
  return cross * cross <= reach * reach * lengthSquared;
}

function integerSquareRoot(value) {
  if (value < 2n) return value;
  let low = 1n;
  let high = value;
  while (low + 1n < high) {
    const middle = (low + high) / 2n;
    if (middle * middle <= value) low = middle;
    else high = middle;
  }
  return low;
}

function advance(position, target, speed) {
  const dx = BigInt(target.x) - BigInt(position.x);
  const dy = BigInt(target.y) - BigInt(position.y);
  const distanceSquared = dx * dx + dy * dy;
  const speedBig = BigInt(speed);
  if (distanceSquared <= speedBig * speedBig) return { ...target };
  const distance = integerSquareRoot(distanceSquared);
  if (distance * distance !== distanceSquared) {
    throw new RangeError("projectile path length must have an exact integer magnitude");
  }
  const nextX = BigInt(position.x) + dx * speedBig / distance;
  const nextY = BigInt(position.y) + dy * speedBig / distance;
  if (dx * speedBig % distance !== 0n || dy * speedBig % distance !== 0n) {
    throw new RangeError("projectile step must remain on integer coordinates");
  }
  return { x: Number(nextX), y: Number(nextY) };
}

function assertIntegralStepPath(start, target, speed, label) {
  const dx = BigInt(target.x) - BigInt(start.x);
  const dy = BigInt(target.y) - BigInt(start.y);
  const distanceSquared = dx * dx + dy * dy;
  const speedBig = BigInt(speed);
  if (distanceSquared <= speedBig * speedBig) return;
  const distance = integerSquareRoot(distanceSquared);
  if (distance * distance !== distanceSquared) {
    throw new RangeError(`${label} must have an exact integer magnitude`);
  }
  // An integral first displacement proves every non-final displacement:
  // each subtracts the same integer vector from the same straight line.
  // The remaining final segment is snapped to its already-integer endpoint.
  if (dx * speedBig % distance !== 0n || dy * speedBig % distance !== 0n) {
    throw new RangeError(`${label} must remain on integer coordinates`);
  }
}

function validateProjectilePaths(entities, projectiles) {
  const entityById = new Map(entities.map((entry) => [entry.id, entry]));
  for (let index = 0; index < projectiles.length; index += 1) {
    const projectile = projectiles[index];
    const source = entityById.get(projectile.sourceId);
    const target = entityById.get(projectile.targetId);
    assertIntegralStepPath(
      source.position, target.position, projectile.speed,
      `reflection projectile ${index} original path`,
    );
    for (const reflector of entities) {
      if (
        !reflector.alive || !reflector.reflector || !reflector.targetable ||
        reflector.ownerId === projectile.ownerId ||
        reflector.id === projectile.sourceId ||
        reflector.id === projectile.targetId ||
        !segmentCircleIntersects(
          source.position, target.position, reflector.position,
          projectile.radius +
            QUESTION_FIXTURES.reflectionRadiusMillitiles.value,
        )
      ) continue;
      assertIntegralStepPath(
        reflector.position, source.position, projectile.speed,
        `reflection projectile ${index} reflected path via entity ${reflector.id}`,
      );
    }
  }
}

function deepFrozenQuestionCopy() {
  return Object.freeze(Object.fromEntries(
    Object.entries(QUESTION_FIXTURES).map(([key, record]) => [
      key, Object.freeze({ ...record }),
    ]),
  ));
}

export function createReflectionQuestionFixture(...args) {
  if (args.length !== 0) {
    throw new TypeError("createReflectionQuestionFixture does not accept overrides");
  }
  return deepFrozenQuestionCopy();
}

export function createReflectionSpecialCatalog() {
  return createCardCatalog(DEFINITIONS);
}

export function createReflectionSpecialFixture(
  entities = defaultSetup().entities,
  projectiles = defaultSetup().projectiles,
  commands = [],
  ...extra
) {
  if (extra.length !== 0) {
    throw new TypeError("createReflectionSpecialFixture received extra arguments");
  }
  return clone(checkedSetup({ commands, entities, projectiles }));
}

/**
 * One deterministic, isolated reflection encounter.
 *
 * This is not an authoritative reflection eligibility, radius, timing,
 * ownership, target, speed, damage, loop, lifecycle, event-order, source,
 * source-death, target-death, moving-target, projectile-height, animation,
 * visual, audio, or full-match parity claim. It exists to make every absent
 * value and policy executable without changing ordinary projectile semantics.
 */
export class ReflectionEncounter {
  #identity;
  #tick = 0;
  #damage;
  #entities;
  #projectiles;
  #commands;
  #commandIndex = 0;
  #nextProjectileId = 1;
  #replay = [];

  constructor(setup = defaultSetup()) {
    this.#identity = checkedSetup(setup);
    this.#initialize();
  }

  #initialize() {
    this.#tick = 0;
    this.#commandIndex = 0;
    this.#nextProjectileId = 1;
    this.#replay = [];
    this.#commands = clone(this.#identity.commands);
    this.#entities = clone(this.#identity.entities);
    this.#damage = new DamageSystem();
    for (const entry of this.#entities) {
      this.#damage.add(entry.id, entry.maxHealth);
      if (!entry.alive) this.#damage.damage(entry.id, entry.maxHealth);
    }
    this.#projectiles = this.#identity.projectiles.map((raw) => {
      const source = this.#entity(raw.sourceId);
      const target = this.#entity(raw.targetId);
      const projectile = {
        ...raw,
        id: this.#nextProjectileId++,
        launchTick: 0,
        origin: { ...source.position },
        position: { ...source.position },
        provenance: {
          parentProjectileId: null,
          reflectionCount: 0,
          rootProjectileId: this.#nextProjectileId - 1,
        },
        targetPosition: { ...target.position },
      };
      this.#replay.push({
        projectile: clone(projectile), tick: 0, type: "projectile-launch",
      });
      return projectile;
    });
    this.#replay.push(...this.#applyCommands(0));
  }

  #applyCommands(tick) {
    const events = [];
    while (this.#commands[this.#commandIndex]?.tick === tick) {
      const command = this.#commands[this.#commandIndex++];
      events.push({ targetId: command.targetId, tick, type: "reflection-command" });
      const health = this.#damage.get(command.targetId);
      const result = this.#damage.damage(command.targetId, health.maxHealth);
      events.push(...result.events.map((event) => ({
        ...event, tick, type: `external-${event.type}`,
      })));
    }
    return events;
  }

  #entity(id) {
    return this.#entities.find((entry) => entry.id === id);
  }

  get replay() {
    return clone(this.#replay);
  }

  get state() {
    return clone({
      entities: this.#entities.map((entry) => ({
        ...entry, hitpoints: this.#damage.get(entry.id).currentHealth,
      })),
      nextProjectileId: this.#nextProjectileId,
      projectiles: this.#projectiles,
      tick: this.#tick,
    });
  }

  serialize() {
    const serialized = canonicalJson({
      identity: this.#identity, tick: this.#tick, version: 1,
    });
    if (serialized.length > MAX_SNAPSHOT_BYTES) {
      throw new RangeError("reflection snapshot exceeds its byte bound");
    }
    return serialized;
  }

  static restore(serialized) {
    if (typeof serialized !== "string") {
      throw new TypeError("serialized reflection encounter must be a string");
    }
    if (serialized.length > MAX_SNAPSHOT_BYTES) {
      throw new RangeError("serialized reflection encounter is oversized");
    }
    let raw;
    try {
      raw = JSON.parse(serialized);
    } catch {
      throw new TypeError("serialized reflection encounter must be valid JSON");
    }
    const snapshot = exactRecord(raw, SNAPSHOT_KEYS, "reflection snapshot");
    if (snapshot.version !== 1) {
      throw new TypeError("reflection snapshot has an unsupported version");
    }
    safeInteger(snapshot.tick, "reflection snapshot.tick", 0);
    if (snapshot.tick > MAX_TICK) {
      throw new RangeError("reflection snapshot tick exceeds its bound");
    }
    const encounter = new ReflectionEncounter(checkedSetup(snapshot.identity));
    encounter.stepMany(snapshot.tick);
    if (encounter.serialize() !== serialized) {
      throw new TypeError("reflection snapshot is not canonical");
    }
    return encounter;
  }

  #stagedCopy() {
    const staged = new ReflectionEncounter(this.#identity);
    staged.#identity = clone(this.#identity);
    staged.#tick = this.#tick;
    staged.#damage = DamageSystem.restore(this.#damage.serialize());
    staged.#entities = clone(this.#entities);
    staged.#projectiles = clone(this.#projectiles);
    staged.#commands = clone(this.#commands);
    staged.#commandIndex = this.#commandIndex;
    staged.#nextProjectileId = this.#nextProjectileId;
    staged.#replay = clone(this.#replay);
    return staged;
  }

  #commit(staged) {
    this.#identity = staged.#identity;
    this.#tick = staged.#tick;
    this.#damage = staged.#damage;
    this.#entities = staged.#entities;
    this.#projectiles = staged.#projectiles;
    this.#commands = staged.#commands;
    this.#commandIndex = staged.#commandIndex;
    this.#nextProjectileId = staged.#nextProjectileId;
    this.#replay = staged.#replay;
  }

  stepMany(count) {
    safeInteger(count, "reflection step count", 0);
    if (this.#tick + count > MAX_TICK) {
      throw new RangeError("reflection execution exceeds its bound");
    }
    const staged = this.#stagedCopy();
    const events = [];
    for (let index = 0; index < count; index += 1) {
      events.push(...staged.#stepUnchecked());
    }
    this.#commit(staged);
    return clone(events);
  }

  run(limit = MAX_TICK) {
    safeInteger(limit, "reflection run limit", 0);
    if (limit > MAX_TICK) throw new RangeError("reflection run exceeds its bound");
    const staged = this.#stagedCopy();
    while (staged.#projectiles.length > 0 && staged.#tick < limit) {
      staged.#stepUnchecked();
    }
    this.#commit(staged);
    return this.replay;
  }

  step() {
    const staged = this.#stagedCopy();
    const events = staged.#stepUnchecked();
    this.#commit(staged);
    return clone(events);
  }

  #stepUnchecked() {
    if (this.#tick >= MAX_TICK) {
      throw new RangeError("reflection tick space is exhausted");
    }
    const tick = this.#tick + 1;
    const events = this.#applyCommands(tick);

    const survivors = [];
    const replacements = [];
    for (const projectile of [...this.#projectiles].sort((a, b) => a.id - b.id)) {
      const targetHealth = this.#damage.get(projectile.targetId);
      if (targetHealth.currentHealth === 0) {
        events.push({
          projectileId: projectile.id, status: "target-dead", tick,
          type: "projectile-fizzle",
        });
        continue;
      }
      const next = advance(projectile.position, projectile.targetPosition, projectile.speed);
      const reflector = projectile.provenance.reflectionCount <
          QUESTION_FIXTURES.maximumReflections.value
        ? this.#entities.filter((candidate) => {
          const health = this.#damage.get(candidate.id);
          return candidate.reflector && candidate.targetable &&
            health.currentHealth > 0 && candidate.ownerId !== projectile.ownerId &&
            candidate.id !== projectile.sourceId &&
            candidate.id !== projectile.targetId &&
            segmentCircleIntersects(
              projectile.position, next, candidate.position,
              projectile.radius +
                QUESTION_FIXTURES.reflectionRadiusMillitiles.value,
            );
        }).sort((a, b) => a.id - b.id)[0]
        : undefined;
      if (reflector !== undefined) {
        const reflectedTarget = this.#entity(projectile.sourceId);
        const replacement = {
          damage: projectile.damage,
          id: this.#nextProjectileId++,
          launchTick: tick,
          origin: { ...reflector.position },
          ownerId: reflector.ownerId,
          position: { ...reflector.position },
          provenance: {
            parentProjectileId: projectile.id,
            reflectionCount: projectile.provenance.reflectionCount + 1,
            rootProjectileId: projectile.provenance.rootProjectileId,
          },
          radius: projectile.radius,
          sourceId: reflector.id,
          speed: projectile.speed,
          targetId: reflectedTarget.id,
          targetPosition: { ...reflectedTarget.position },
        };
        replacements.push(replacement);
        events.push({
          parentProjectileId: projectile.id,
          projectile: clone(replacement),
          reflectorId: reflector.id,
          tick,
          type: "projectile-reflection",
        });
        continue;
      }
      if (segmentCircleIntersects(
        projectile.position, next, projectile.targetPosition,
        projectile.radius + this.#entity(projectile.targetId).radius,
      )) {
        events.push({
          projectileId: projectile.id, targetId: projectile.targetId, tick,
          type: "projectile-contact",
        });
        const result = this.#damage.damage(projectile.targetId, projectile.damage);
        events.push(...result.events.map((event) => ({
          ...event, projectileId: projectile.id, tick,
          type: `projectile-${event.type}`,
        })));
        continue;
      }
      projectile.position = next;
      survivors.push(projectile);
    }
    this.#projectiles = [...survivors, ...replacements].sort((a, b) => a.id - b.id);
    this.#tick = tick;
    this.#replay.push(...events);
    if (this.#replay.length > MAX_REPLAY_EVENTS) {
      throw new RangeError("reflection replay exceeds its bound");
    }
    return clone(events);
  }
}
