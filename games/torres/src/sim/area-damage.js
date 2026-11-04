import { DamageSystem } from "./damage.js";
import { circlesOverlap, validateCircle } from "./spatial.js";
import {
  ATTACK_TARGET_MODES,
  targetCandidate,
} from "./targeting.js";
import {
  appendCombatEffectEvent,
  appendCombatEffectRoot,
  combatEffectFeedSnapshot,
  createCombatEffectFeed,
  serializeCombatEffectFeed,
} from "./combat-effect-feed.js";

const TARGET_MODES = new Set(ATTACK_TARGET_MODES);
// The largest safe integer is a terminal next-ID sentinel. It is valid state
// for snapshots, but is never assigned to an effect because it cannot be
// incremented to another safe integer.
const EXHAUSTED_EFFECT_ID = Number.MAX_SAFE_INTEGER;

function assertExactDataObject(value, expectedKeys, label) {
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
  const sorted = actual.sort();
  const expected = [...expectedKeys].sort();
  if (
    sorted.length !== expected.length ||
    sorted.some((key, index) => key !== expected[index])
  ) {
    throw new TypeError(`${label} has an invalid shape`);
  }
  const result = {};
  for (const key of expectedKeys) {
    const descriptor = descriptors[key];
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
      throw new TypeError(`${label}.${key} must be an enumerable data property`);
    }
    result[key] = descriptor.value;
  }
  return result;
}

function assertPositiveId(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
}

function assertTick(value, label = "effect.tick") {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
}

function assertDamage(value, label = "effect.damage") {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
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

function checkedEffect(value) {
  const effect = assertExactDataObject(
    value,
    ["center", "damage", "mode", "radius", "tick"],
    "area effect",
  );
  const center = assertExactDataObject(
    effect.center,
    ["x", "y"],
    "area effect.center",
  );
  const circle = validateCircle({
    position: { x: center.x, y: center.y },
    radius: effect.radius,
  }, "area effect");
  assertDamage(effect.damage);
  assertTick(effect.tick);
  if (!TARGET_MODES.has(effect.mode)) {
    throw new TypeError(
      "effect.mode must be ground, air, air_and_ground, buildings, or none",
    );
  }
  return {
    center: circle.position,
    damage: effect.damage,
    mode: effect.mode,
    radius: circle.radius,
    tick: effect.tick,
  };
}

function checkedCandidates(values) {
  if (!Array.isArray(values)) {
    throw new TypeError("area candidates must be an array");
  }
  const descriptors = Object.getOwnPropertyDescriptors(values);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (key === "length") continue;
    if (
      typeof key !== "string" ||
      !/^(0|[1-9]\d*)$/.test(key) ||
      Number(key) >= values.length
    ) {
      throw new TypeError("area candidates must contain only indexed data");
    }
  }
  const checked = [];
  const ids = new Set();
  for (let index = 0; index < values.length; index += 1) {
    const descriptor = descriptors[index];
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !Object.hasOwn(descriptor, "value")
    ) {
      throw new TypeError(
        `area candidates[${index}] must be an enumerable data property`,
      );
    }
    const candidate = targetCandidate(
      descriptor.value,
      `area candidate ${index}`,
    );
    if (ids.has(candidate.id)) {
      throw new TypeError("area candidates must have unique entity IDs");
    }
    ids.add(candidate.id);
    checked.push(candidate);
  }
  return checked;
}

function modeEligible(candidate, mode) {
  if (!candidate.alive || !candidate.targetable || mode === "none") {
    return false;
  }
  if (mode === "buildings") return candidate.kind === "structure";
  if (mode === "air_and_ground") return true;
  return candidate.layer === mode;
}

/**
 * Instantaneous deterministic area damage.
 *
 * Geometry and targeting descriptors are supplied at resolution time while
 * health and the monotonic effect-ID sequence are owned here. Resolution first
 * validates and snapshots the complete command, then applies exactly one
 * simultaneous hit to every eligible overlapping ID.
 */
export class AreaDamageSystem {
  #damage;
  #feed = createCombatEffectFeed();
  #history = [];
  #initialDamage;
  #nextEffectId;

  constructor() {
    this.#damage = new DamageSystem();
    this.#initialDamage = new DamageSystem();
    this.#nextEffectId = 1;
  }

  get nextEffectId() {
    return this.#nextEffectId;
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
    return AreaDamageSystem.restore(this.serialize(), this.combatEffectFeedBytes());
  }

  add(id, maxHealth, currentHealth = maxHealth) {
    const result = this.#damage.add(id, maxHealth, currentHealth);
    this.#initialDamage.add(id, maxHealth, currentHealth);
    return result;
  }

  get(id) {
    return this.#damage.get(id);
  }

  list() {
    return this.#damage.list();
  }

  /**
   * Resolves an effect at its explicit simulation tick.
   *
   * Boundary contact counts as a hit. Candidate circles, rather than only
   * their centers, overlap the effect. Replay is grouped as effect, hits,
   * damage, then deaths; every target-bearing group is ascending by target ID.
   */
  resolve(effect, candidates) {
    const checked = checkedEffect(effect);
    const checkedCandidatesValue = checkedCandidates(candidates);
    if (this.#nextEffectId === EXHAUSTED_EFFECT_ID) {
      throw new RangeError("area effect id space is exhausted");
    }

    const effectId = this.#nextEffectId;
    // Resolve and append the derived transcript on private candidates. A
    // feed bound failure must not leave authoritative health or IDs half
    // committed, just like any other rejected source boundary.
    const candidateDamage = DamageSystem.restore(this.#damage.serialize());
    const candidateFeed = this.#feed.fork();
    const effectCircle = {
      position: checked.center,
      radius: checked.radius,
    };
    const hitTargetIds = checkedCandidatesValue
      .filter((candidate) => {
        const health = candidateDamage.get(candidate.id);
        return (
          modeEligible(candidate, checked.mode) &&
          health !== null &&
          !health.dead &&
          circlesOverlap(effectCircle, {
            position: candidate.position,
            radius: candidate.radius,
          })
        );
      })
      .map((candidate) => candidate.id)
      .sort((left, right) => left - right);

    const batch = candidateDamage.damageSimultaneously(
      hitTargetIds.map((targetId) => ({
        amount: checked.damage,
        targetId,
      })),
    );

    const root = appendCombatEffectRoot(candidateFeed, {
      direction: "area",
      effectId,
      from: checked.center,
      impactTick: checked.tick,
      projectileId: null,
      radius: checked.radius,
      segments: [],
      sequence: null,
      sourceId: null,
      tick: checked.tick,
      to: null,
      type: "area",
    });
    let parentId = root.eventId;
    const impact = appendCombatEffectEvent(candidateFeed, {
      parentId,
      payload: {
        center: checked.center,
        radius: checked.radius,
        targetIds: hitTargetIds,
      },
      phase: "impact",
      rootId: root.rootId,
      tick: checked.tick,
      type: "area",
    });
    parentId = impact.eventId;
    for (const event of batch.events) {
      if (event.type === "damage") {
        const damage = appendCombatEffectEvent(candidateFeed, {
          parentId,
          payload: {
            amount: event.amount,
            currentHealthAfter: event.currentHealthAfter,
            currentHealthBefore: event.currentHealthBefore,
            targetId: event.targetId,
          },
          phase: "damage",
          rootId: root.rootId,
          tick: checked.tick,
          type: "area",
        });
        parentId = damage.eventId;
      } else {
        const death = appendCombatEffectEvent(candidateFeed, {
          parentId,
          payload: { targetId: event.targetId },
          phase: "death",
          rootId: root.rootId,
          tick: checked.tick,
          type: "area",
        });
        parentId = death.eventId;
      }
    }
    appendCombatEffectEvent(candidateFeed, {
      parentId,
      payload: { reason: "complete" },
      phase: "close",
      rootId: root.rootId,
      tick: checked.tick,
      type: "area",
    });

    this.#damage = candidateDamage;
    this.#feed = candidateFeed;
    this.#history = [
      ...this.#history,
      {
        candidates: clone([...checkedCandidatesValue].sort((left, right) => left.id - right.id)),
        effect: clone(checked),
        effectId,
      },
    ];
    this.#nextEffectId += 1;
    const effectEvent = {
      center: { ...checked.center },
      damage: checked.damage,
      effectId,
      mode: checked.mode,
      radius: checked.radius,
      tick: checked.tick,
      type: "effect",
    };
    const hitEvents = hitTargetIds.map((targetId) => ({
      amount: checked.damage,
      effectId,
      targetId,
      tick: checked.tick,
      type: "hit",
    }));
    const damageEvents = batch.events
      .filter((event) => event.type === "damage")
      .map((event) => ({
        ...event,
        effectId,
        tick: checked.tick,
      }));
    const deathEvents = batch.events
      .filter((event) => event.type === "death")
      .map((event) => ({
        ...event,
        effectId,
        tick: checked.tick,
      }));

    return clone({
      effectId,
      events: [effectEvent, ...hitEvents, ...damageEvents, ...deathEvents],
      hitTargetIds,
      tick: checked.tick,
    });
  }

  serialize() {
    return canonicalJson({
      combatEffectFeed: combatEffectFeedSnapshot(this.#feed),
      damage: JSON.parse(this.#damage.serialize()),
      history: this.#history,
      initialDamage: JSON.parse(this.#initialDamage.serialize()),
      nextEffectId: this.#nextEffectId,
      version: 3,
    });
  }

  /**
   * Restores mechanics and visual history as one canonical snapshot. Version
   * 1 is retained only for an unplayed empty system: a played legacy snapshot
   * cannot prove which visual records belonged to it and is rejected rather
   * than accepting an independently forgeable feed argument.
   */
  static restore(serialized, feedSerialized = undefined) {
    if (typeof serialized !== "string") {
      throw new TypeError("serialized area-damage snapshot must be a string");
    }
    let raw;
    try {
      raw = JSON.parse(serialized);
    } catch {
      throw new TypeError("serialized area-damage snapshot must be valid JSON");
    }
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new TypeError("area-damage snapshot must be a plain object");
    }
    if (canonicalJson(raw) !== serialized) {
      throw new TypeError(
        "serialized area-damage snapshot must be canonical duplicate-free JSON",
      );
    }
    const version = raw.version;
    if (version === 1) {
      const legacy = assertExactDataObject(
        raw,
        ["damage", "nextEffectId", "version"],
        "area-damage legacy snapshot",
      );
      assertPositiveId(legacy.nextEffectId, "snapshot nextEffectId");
      if (legacy.nextEffectId !== 1 || feedSerialized !== undefined) {
        throw new TypeError("played area-damage legacy snapshots require a bound visual transcript");
      }
      const system = new AreaDamageSystem();
      system.#damage = DamageSystem.restore(canonicalJson(legacy.damage));
      system.#initialDamage = DamageSystem.restore(canonicalJson(legacy.damage));
      system.#nextEffectId = legacy.nextEffectId;
      return system;
    }
    if (version !== 3) {
      throw new TypeError("area-damage snapshot has an invalid version");
    }
    const snapshot = assertExactDataObject(
      raw,
        ["combatEffectFeed", "damage", "history", "initialDamage", "nextEffectId", "version"],
      "area-damage snapshot",
    );
    assertPositiveId(snapshot.nextEffectId, "snapshot nextEffectId");
    if (!Array.isArray(snapshot.history)) {
      throw new TypeError("area-damage snapshot.history must be an array");
    }
    const expectedFeedBytes = serializeCombatEffectFeed(snapshot.combatEffectFeed);
    if (feedSerialized !== undefined &&
        (typeof feedSerialized !== "string" || feedSerialized !== expectedFeedBytes)) {
      throw new TypeError("area-damage supplied feed does not match its canonical snapshot");
    }
    const system = new AreaDamageSystem();
    system.#initialDamage = DamageSystem.restore(canonicalJson(snapshot.initialDamage));
    system.#damage = DamageSystem.restore(canonicalJson(snapshot.initialDamage));
    if (snapshot.nextEffectId !== snapshot.history.length + 1) {
      throw new TypeError("area-damage snapshot effect lineage is not contiguous");
    }
    if (snapshot.history.length === 0) {
      system.#nextEffectId = 1;
    } else {
      const firstEffectId = snapshot.history[0]?.effectId;
      if (firstEffectId !== 1) {
        throw new TypeError("area-damage snapshot history effect identities are not causal");
      }
      system.#nextEffectId = 1;
    }
    for (let index = 0; index < snapshot.history.length; index += 1) {
      const entry = assertExactDataObject(
        snapshot.history[index],
        ["candidates", "effect", "effectId"],
        `area-damage snapshot.history[${index}]`,
      );
      if (!Array.isArray(entry.candidates)) {
        throw new TypeError(`area-damage snapshot.history[${index}].candidates must be an array`);
      }
      const result = system.resolve(entry.effect, entry.candidates);
      if (result.effectId !== entry.effectId) {
        throw new TypeError(`area-damage snapshot.history[${index}] effect identity diverges`);
      }
    }
    if (snapshot.history.length > 0 && system.#nextEffectId !== snapshot.nextEffectId ||
        canonicalJson(system.#history) !== canonicalJson(snapshot.history) ||
        canonicalJson(JSON.parse(system.#damage.serialize())) !== canonicalJson(snapshot.damage) ||
        system.combatEffectFeedBytes() !== expectedFeedBytes) {
      throw new TypeError("area-damage snapshot mechanics and visual history diverge");
    }
    return system;
  }
}
