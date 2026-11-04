import { DamageSystem } from "./damage.js";
import {
  MAX_SPATIAL_MILLITILES,
  spatialEntity,
  validateCircle,
} from "./spatial.js";
import {
  ATTACK_TARGET_MODES,
  acquireTarget,
  targetCandidate,
} from "./targeting.js";
import {
  appendCombatEffectEvent,
  appendCombatEffectRoot,
  combatEffectFeedSnapshot,
  createCombatEffectFeed,
  serializeCombatEffectFeed,
} from "./combat-effect-feed.js";

const ENTITY_KEYS = [
  "attackRange",
  "id",
  "kind",
  "layer",
  "maxHealth",
  "position",
  "radius",
  "targetMode",
  "targetable",
];
const SETUP_KEYS = ["entities"];
const LAUNCH_KEYS = [
  "attackerId",
  "damage",
  "radius",
  "speed",
  "targetId",
  "tick",
];
const MODES = new Set(ATTACK_TARGET_MODES);

function exactObject(value, keys, label) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    throw new TypeError(`${label} must be a plain object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const actual = Reflect.ownKeys(descriptors);
  if (actual.some((key) => typeof key !== "string")) {
    throw new TypeError(`${label} must contain only string-keyed data`);
  }
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    [...actual].sort().some((key, index) => key !== expected[index])
  ) {
    throw new TypeError(`${label} has an invalid shape`);
  }
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

function safeInteger(value, label, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new TypeError(`${label} must be a safe integer of at least ${minimum}`);
  }
}

function checkedEntity(value, index) {
  const label = `projectile entity ${index}`;
  const entity = exactObject(value, ENTITY_KEYS, label);
  safeInteger(entity.id, `${label}.id`, 1);
  safeInteger(entity.maxHealth, `${label}.maxHealth`, 1);
  safeInteger(entity.attackRange, `${label}.attackRange`);
  if (entity.attackRange > MAX_SPATIAL_MILLITILES) {
    throw new RangeError(`${label}.attackRange is outside the spatial bounds`);
  }
  if (!MODES.has(entity.targetMode)) {
    throw new TypeError(`${label}.targetMode is invalid`);
  }
  if (typeof entity.targetable !== "boolean") {
    throw new TypeError(`${label}.targetable must be a boolean`);
  }
  const spatial = spatialEntity({
    id: entity.id,
    layer: entity.layer,
    position: entity.position,
    radius: entity.radius,
  }, label);
  const candidate = targetCandidate({
    alive: true,
    id: entity.id,
    kind: entity.kind,
    layer: spatial.layer,
    position: spatial.position,
    radius: spatial.radius,
    targetable: entity.targetable,
  }, label);
  return {
    attackRange: entity.attackRange,
    id: candidate.id,
    kind: candidate.kind,
    layer: candidate.layer,
    maxHealth: entity.maxHealth,
    position: candidate.position,
    radius: candidate.radius,
    targetMode: entity.targetMode,
    targetable: candidate.targetable,
  };
}

function checkedArray(value, label) {
  if (!Array.isArray(value)) {
    throw new TypeError(`${label} must be an array`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (key === "length") continue;
    if (
      typeof key !== "string" ||
      !/^(0|[1-9]\d*)$/.test(key) ||
      Number(key) >= value.length
    ) {
      throw new TypeError(`${label} must contain only indexed data`);
    }
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[index];
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !Object.hasOwn(descriptor, "value")
    ) {
      throw new TypeError(`${label}[${index}] must be an enumerable data property`);
    }
  }
  return value;
}

function checkedSetup(value) {
  const setup = exactObject(value, SETUP_KEYS, "projectile setup");
  const entities = checkedArray(setup.entities, "projectile setup.entities")
    .map(checkedEntity)
    .sort((left, right) => left.id - right.id);
  for (let index = 1; index < entities.length; index += 1) {
    if (entities[index - 1].id === entities[index].id) {
      throw new TypeError("projectile entities must have unique IDs");
    }
  }
  return { entities };
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

function travelTicks(origin, target, contactRadius, speed) {
  const dx = BigInt(target.x) - BigInt(origin.x);
  const dy = BigInt(target.y) - BigInt(origin.y);
  const distanceSquared = dx * dx + dy * dy;
  const contact = BigInt(contactRadius);
  if (distanceSquared <= contact * contact) return 0;

  const speedBig = BigInt(speed);
  const reached = (ticks) => {
    const reach = contact + speedBig * ticks;
    return reach * reach >= distanceSquared;
  };
  let low = 0n;
  let high = 1n;
  while (!reached(high)) high *= 2n;
  while (low + 1n < high) {
    const middle = (low + high) / 2n;
    if (reached(middle)) high = middle;
    else low = middle;
  }
  if (high > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError("projectile flight exceeds the safe tick range");
  }
  return Number(high);
}

/**
 * Deterministic projectile combat over static launch-time geometry.
 *
 * A projectile flies on the straight segment from its launch origin toward the
 * target's launch-time position. Moving/homing targets are intentionally not
 * modeled here. Contact is inclusive when projectile and target circle edges
 * meet. `step(T)` resolves every contact scheduled for boundary T in ascending
 * projectile-ID order and sends all still-live hits through one simultaneous
 * damage batch. A target dead before T produces an explicit `target_dead`
 * resolution; projectiles never retarget.
 */
export class ProjectileCombat {
  #damage = new DamageSystem();
  #entities = [];
  #feed = createCombatEffectFeed();
  #feedRoots = new Map();
  #history = [];
  #initial;
  #nextProjectileId = 1;
  #projectiles = [];
  #replay = [];
  #tick = 0;

  constructor(setup) {
    this.#initial = checkedSetup(setup);
    this.#entities = clone(this.#initial.entities);
    for (const entity of this.#entities) {
      this.#damage.add(entity.id, entity.maxHealth);
    }
  }

  get replay() {
    return clone(this.#replay);
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
    return ProjectileCombat.restore(this.serialize());
  }

  get state() {
    return clone({
      entities: this.#entities.map((entity) => ({
        alive: !this.#damage.get(entity.id).dead,
        hitpoints: this.#damage.get(entity.id).currentHealth,
        id: entity.id,
      })),
      nextProjectileId: this.#nextProjectileId,
      projectiles: this.#projectiles,
      tick: this.#tick,
    });
  }

  /**
   * Launches at the current explicit boundary. Range and eligibility are
   * delegated to the targeting module, including inclusive circle-edge reach.
   */
  launch(command) {
    const checked = exactObject(command, LAUNCH_KEYS, "projectile launch");
    safeInteger(checked.attackerId, "projectile launch.attackerId", 1);
    safeInteger(checked.targetId, "projectile launch.targetId", 1);
    safeInteger(checked.tick, "projectile launch.tick");
    safeInteger(checked.damage, "projectile launch.damage");
    safeInteger(checked.speed, "projectile launch.speed", 1);
    safeInteger(checked.radius, "projectile launch.radius");
    validateCircle({
      position: { x: 0, y: 0 },
      radius: checked.radius,
    }, "projectile launch circle");
    if (checked.tick !== this.#tick) {
      throw new RangeError("projectile launch.tick must equal the current tick");
    }
    if (this.#nextProjectileId >= Number.MAX_SAFE_INTEGER) {
      throw new RangeError("projectile ID space is exhausted");
    }

    const attacker = this.#entity(checked.attackerId);
    const target = this.#entity(checked.targetId);
    if (attacker === null || target === null) {
      throw new RangeError("projectile launch entities must exist");
    }
    if (this.#damage.get(attacker.id).dead) {
      throw new RangeError("projectile attacker must be alive");
    }
    const health = this.#damage.get(target.id);
    const candidate = {
      alive: !health.dead,
      id: target.id,
      kind: target.kind,
      layer: target.layer,
      position: target.position,
      radius: target.radius,
      targetable: target.targetable,
    };
    const eligible = acquireTarget(
      { position: attacker.position, radius: attacker.radius },
      [candidate],
      { mode: attacker.targetMode, sightRange: attacker.attackRange },
    );
    if (eligible === null) {
      throw new RangeError("projectile target is not eligible or in attack range");
    }

    const duration = travelTicks(
      attacker.position,
      target.position,
      checked.radius + target.radius,
      checked.speed,
    );
    if (duration > Number.MAX_SAFE_INTEGER - checked.tick) {
      throw new RangeError("projectile impact tick exceeds the safe integer range");
    }
    const projectile = {
      attackerId: attacker.id,
      damage: checked.damage,
      id: this.#nextProjectileId,
      impactTick: checked.tick + duration,
      launchTick: checked.tick,
      origin: { ...attacker.position },
      radius: checked.radius,
      speed: checked.speed,
      targetId: target.id,
      targetPosition: { ...target.position },
      targetRadius: target.radius,
    };
    const root = appendCombatEffectRoot(this.#feed, {
      direction: "projectile",
      effectId: null,
      from: projectile.origin,
      impactTick: projectile.impactTick,
      projectileId: projectile.id,
      radius: projectile.radius,
      segments: [],
      sequence: projectile.id,
      sourceId: projectile.attackerId,
      tick: checked.tick,
      to: projectile.targetPosition,
      type: "projectile",
    });
    this.#nextProjectileId += 1;
    this.#projectiles.push(projectile);
    this.#feedRoots.set(projectile.id, {
      lastEventId: root.eventId,
      rootId: root.rootId,
    });
    const event = {
      projectile: clone(projectile),
      tick: checked.tick,
      type: "launch",
    };
    this.#replay.push(event);
    this.#history.push({ command: clone(checked), type: "launch" });
    return clone(projectile);
  }

  /**
   * Resolves one explicit simulation boundary. Launches scheduled for this
   * boundary must be made before calling step(boundary).
   */
  step(tick) {
    safeInteger(tick, "projectile step tick");
    if (tick !== this.#tick) {
      throw new RangeError("projectile step tick must equal the current tick");
    }
    if (this.#tick === Number.MAX_SAFE_INTEGER) {
      throw new RangeError("projectile tick space is exhausted");
    }

    const due = this.#projectiles
      .filter((projectile) => projectile.impactTick === tick)
      .sort((left, right) => left.id - right.id);
    if (due.length === 0) {
      this.#tick += 1;
      this.#history.push({ tick, type: "step" });
      return [];
    }
    // A due boundary is one simulation operation. Stage every health and
    // visual mutation on detached authoritative forks, and adopt them only
    // after all contacts, damage, deaths, closes, and feed bounds succeed.
    // This makes a late record/byte failure indistinguishable from rejection
    // before the first due contact.
    const candidateDamage = DamageSystem.restore(this.#damage.serialize());
    const candidateFeed = this.#feed.fork();
    const candidateFeedRoots = new Map([...this.#feedRoots].map(
      ([projectileId, root]) => [projectileId, { ...root }],
    ));
    const live = [];
    const events = [];
    const feedTargets = new Map();
    const dueRoots = [];
    for (const projectile of due) {
      const health = candidateDamage.get(projectile.targetId);
      const status = health === null
        ? "target_missing"
        : health.dead
        ? "target_dead"
        : "contact";
      events.push({
        projectileId: projectile.id,
        status,
        targetId: projectile.targetId,
        tick,
        type: "impact",
      });
      const root = candidateFeedRoots.get(projectile.id);
      if (root === undefined) throw new Error("projectile visual root is missing");
      const contact = appendCombatEffectEvent(candidateFeed, {
        parentId: root.lastEventId,
        payload: {
          point: projectile.targetPosition,
          status: status === "contact" ? "contact" :
            status === "target_dead" ? "target-dead" : "target-missing",
          subId: null,
          targetId: projectile.targetId,
        },
        phase: "contact",
        rootId: root.rootId,
        tick,
        type: "projectile",
      });
      root.lastEventId = contact.eventId;
      dueRoots.push(root);
      if (status === "contact") live.push(projectile);
    }

    const batch = candidateDamage.damageSimultaneously(
      live.map((projectile) => ({
        amount: projectile.damage,
        targetId: projectile.targetId,
      })),
    );
    let damageIndex = 0;
    for (const event of batch.events) {
      if (event.type === "damage") {
        const projectile = live[damageIndex];
        const root = candidateFeedRoots.get(projectile.id);
        const damage = appendCombatEffectEvent(candidateFeed, {
          parentId: root.lastEventId,
          payload: {
            amount: event.amount,
            currentHealthAfter: event.currentHealthAfter,
            currentHealthBefore: event.currentHealthBefore,
            targetId: event.targetId,
          },
          phase: "damage",
          rootId: root.rootId,
          tick,
          type: "projectile",
        });
        root.lastEventId = damage.eventId;
        feedTargets.set(event.targetId, root);
        events.push({
          ...event,
          projectileId: projectile.id,
          tick,
        });
        damageIndex += 1;
      } else {
        events.push({ ...event, tick });
        const root = feedTargets.get(event.targetId);
        if (root !== undefined) {
          const death = appendCombatEffectEvent(candidateFeed, {
            parentId: root.lastEventId,
            payload: { targetId: event.targetId },
            phase: "death",
            rootId: root.rootId,
            tick,
            type: "projectile",
          });
          root.lastEventId = death.eventId;
        }
      }
    }
    for (const root of dueRoots) {
      const close = appendCombatEffectEvent(candidateFeed, {
        parentId: root.lastEventId,
        payload: { reason: "complete" },
        phase: "close",
        rootId: root.rootId,
        tick,
        type: "projectile",
      });
      root.lastEventId = close.eventId;
    }
    this.#damage = candidateDamage;
    this.#feed = candidateFeed;
    this.#feedRoots = candidateFeedRoots;
    const dueIds = new Set(due.map(({ id }) => id));
    this.#projectiles = this.#projectiles.filter(
      (projectile) => !dueIds.has(projectile.id),
    );
    this.#tick += 1;
    this.#replay.push(...events);
    this.#history.push({ tick, type: "step" });
    return clone(events);
  }

  serialize() {
    return canonicalJson({
      history: this.#history,
      setup: this.#initial,
      version: 1,
    });
  }

  static restore(serialized) {
    if (typeof serialized !== "string") {
      throw new TypeError("serialized projectile combat must be a string");
    }
    let snapshot;
    try {
      snapshot = JSON.parse(serialized);
    } catch {
      throw new TypeError("serialized projectile combat must be valid JSON");
    }
    const checked = exactObject(
      snapshot,
      ["history", "setup", "version"],
      "projectile snapshot",
    );
    if (checked.version !== 1) {
      throw new TypeError("projectile snapshot has an unsupported version");
    }
    checkedArray(checked.history, "projectile snapshot.history");
    const combat = new ProjectileCombat(checked.setup);
    for (let index = 0; index < checked.history.length; index += 1) {
      const operation = checked.history[index];
      if (
        operation !== null &&
        typeof operation === "object" &&
        !Array.isArray(operation) &&
        operation.type === "launch"
      ) {
        const entry = exactObject(
          operation,
          ["command", "type"],
          `projectile snapshot.history[${index}]`,
        );
        combat.launch(entry.command);
      } else if (
        operation !== null &&
        typeof operation === "object" &&
        !Array.isArray(operation) &&
        operation.type === "step"
      ) {
        const entry = exactObject(
          operation,
          ["tick", "type"],
          `projectile snapshot.history[${index}]`,
        );
        combat.step(entry.tick);
      } else {
        throw new TypeError(
          `projectile snapshot.history[${index}] has an invalid operation`,
        );
      }
    }
    return combat;
  }

  #entity(id) {
    return this.#entities.find((entity) => entity.id === id) ?? null;
  }
}

export const ProjectileSystem = ProjectileCombat;
