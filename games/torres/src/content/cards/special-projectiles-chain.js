import { DamageSystem } from "../../sim/damage.js";
import { createChainQuestionFixture } from "../../sim/live-battle-chain.js";
export { createChainQuestionFixture };
import { targetCandidate } from "../../sim/targeting.js";
import { createCardCatalog } from "../schema.js";

const DEFINITIONS = [{
  id: "stormkite",
  displayName: "Stormkite",
  cost: 5,
  kind: "unit",
  rarity: "special",
  hitpoints: 950,
  damage: 192,
  hitSpeedTicks: 126,
  firstHitTicks: 84,
  deployTimeTicks: 60,
  rangeMillitiles: 3500,
  sightRangeMillitiles: 5500,
  movementMillitilesPerSecond: 1000,
  targetMode: "ground-and-air",
  count: 1,
  areaDamageRadiusMillitiles: null,
  components: [],
}];

const QUESTION_FIXTURES = createChainQuestionFixture();

const ATTACKER_ID = 101;
const ATTACKER_POSITION = Object.freeze({ x: 1000, y: 4000 });
const ATTACKER_RADIUS = 0;
const ATTACKER_MAX_HEALTH = 950;
const PRIMARY_TICK = DEFINITIONS[0].firstHitTicks;
const MAX_CANDIDATES = 16;
const MAX_COMMANDS = 8;
const MAX_SNAPSHOT_BYTES = 32_768;
const MAX_TICK =
  PRIMARY_TICK +
  QUESTION_FIXTURES.hopDelayTicks.value *
    QUESTION_FIXTURES.targetCap.value +
  1;
const SETUP_KEYS = ["candidates", "commands", "primaryTargetId"];
const CANDIDATE_KEYS = [
  "alive",
  "id",
  "kind",
  "layer",
  "maxHealth",
  "position",
  "radius",
  "targetable",
];
const COMMAND_KEYS = ["targetId", "tick", "type"];
const SNAPSHOT_KEYS = ["identity", "tick", "version"];
const COMMAND_TYPES = new Set(["kill-attacker", "kill-target"]);

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
    Array.from({ length: value.length }, (_, index) => index).some(
      (index) => (
        !descriptors[index]?.enumerable ||
        !Object.hasOwn(descriptors[index], "value")
      ),
    )
  ) {
    throw new TypeError(`${label} must contain dense data properties`);
  }
  return Array.from(
    { length: value.length },
    (_, index) => descriptors[index].value,
  );
}

function checkedCandidate(value, index) {
  const label = `chain candidate ${index}`;
  const raw = exactRecord(value, CANDIDATE_KEYS, label);
  if (!Number.isSafeInteger(raw.maxHealth) || raw.maxHealth < 1) {
    throw new TypeError(`${label}.maxHealth must be a positive safe integer`);
  }
  const candidate = targetCandidate({
    alive: raw.alive,
    id: raw.id,
    kind: raw.kind,
    layer: raw.layer,
    position: raw.position,
    radius: raw.radius,
    targetable: raw.targetable,
  }, label);
  if (candidate.id === ATTACKER_ID) {
    throw new TypeError("chain candidate ID collides with the attacker");
  }
  return { ...candidate, maxHealth: raw.maxHealth };
}

function checkedCandidates(value) {
  const candidates = denseArray(
    value,
    MAX_CANDIDATES,
    "chain candidates",
  ).map(checkedCandidate).sort((left, right) => left.id - right.id);
  if (candidates.length === 0) {
    throw new TypeError("chain candidates must not be empty");
  }
  for (let index = 1; index < candidates.length; index += 1) {
    if (candidates[index - 1].id === candidates[index].id) {
      throw new TypeError("chain candidates must have unique IDs");
    }
  }
  return candidates;
}

function checkedCommands(value, candidateIds) {
  const commands = denseArray(value, MAX_COMMANDS, "chain commands")
    .map((entry, index) => {
      const command = exactRecord(
        entry,
        COMMAND_KEYS,
        `chain command ${index}`,
      );
      if (!COMMAND_TYPES.has(command.type)) {
        throw new TypeError(`chain command ${index}.type is invalid`);
      }
      if (
        !Number.isSafeInteger(command.tick) ||
        command.tick < 0 ||
        command.tick >= MAX_TICK
      ) {
        throw new TypeError(`chain command ${index}.tick is invalid`);
      }
      if (command.type === "kill-attacker") {
        if (command.targetId !== null) {
          throw new TypeError("kill-attacker targetId must be null");
        }
      } else if (
        !Number.isSafeInteger(command.targetId) ||
        !candidateIds.has(command.targetId)
      ) {
        throw new TypeError("kill-target targetId must name a candidate");
      }
      return {
        targetId: command.targetId,
        tick: command.tick,
        type: command.type,
      };
    })
    .sort((left, right) =>
      left.tick - right.tick ||
      (left.type < right.type ? -1 : left.type > right.type ? 1 : 0) ||
      (left.targetId ?? 0) - (right.targetId ?? 0)
    );
  for (let index = 1; index < commands.length; index += 1) {
    if (
      commands[index - 1].tick === commands[index].tick &&
      commands[index - 1].type === commands[index].type &&
      commands[index - 1].targetId === commands[index].targetId
    ) {
      throw new TypeError("chain commands must be unique");
    }
  }
  return commands;
}

function checkedSetup(value) {
  const setup = exactRecord(value, SETUP_KEYS, "chain setup");
  const candidates = checkedCandidates(setup.candidates);
  const candidateIds = new Set(candidates.map(({ id }) => id));
  if (
    !Number.isSafeInteger(setup.primaryTargetId) ||
    !candidateIds.has(setup.primaryTargetId)
  ) {
    throw new TypeError("chain primaryTargetId must name a candidate");
  }
  return {
    candidates,
    commands: checkedCommands(setup.commands, candidateIds),
    primaryTargetId: setup.primaryTargetId,
  };
}

function defaultCandidates() {
  return [
    {
      alive: true,
      id: 201,
      kind: "troop",
      layer: "ground",
      maxHealth: 500,
      position: { x: 4000, y: 4000 },
      radius: 0,
      targetable: true,
    },
    {
      alive: true,
      id: 202,
      kind: "troop",
      layer: "air",
      maxHealth: 500,
      position: { x: 7000, y: 4000 },
      radius: 0,
      targetable: true,
    },
    {
      alive: true,
      id: 203,
      kind: "structure",
      layer: "ground",
      maxHealth: 500,
      position: { x: 10_000, y: 4000 },
      radius: 0,
      targetable: true,
    },
    {
      alive: true,
      id: 204,
      kind: "troop",
      layer: "ground",
      maxHealth: 500,
      position: { x: 12_000, y: 4000 },
      radius: 0,
      targetable: true,
    },
  ];
}

function distanceSquared(left, right) {
  const dx = BigInt(left.x) - BigInt(right.x);
  const dy = BigInt(left.y) - BigInt(right.y);
  return dx * dx + dy * dy;
}

function inRange(origin, candidate, range) {
  const reach = BigInt(origin.radius + range + candidate.radius);
  return distanceSquared(origin.position, candidate.position) <= reach * reach;
}

/**
 * Returns the original Stormkite runtime definition. Chained behavior is not
 * part of the common card schema; benchmark mapping is owned by tests only.
 */
export function createChainSpecialCatalog() {
  return createCardCatalog(DEFINITIONS);
}

/** Creates a validated, isolated, bounded encounter fixture. */
export function createChainSpecialFixture(
  candidates = defaultCandidates(),
  primaryTargetId = 201,
  commands = [],
  ...extra
) {
  if (extra.length !== 0) {
    throw new TypeError("chain fixture received extra arguments");
  }
  return clone(checkedSetup({ candidates, commands, primaryTargetId }));
}

/**
 * One deterministic chained-target attack over static candidate geometry.
 *
 * The explicit primary resolves first. Every later boundary selects the
 * nearest currently alive, targetable, unhit candidate within inclusive
 * circle-edge hop range; equal center distance uses the lower stable ID.
 * Damage is sequential per hop. A lethal hop keeps that target's snapshotted
 * circle as the next origin. Commands resolve before attacks on their tick.
 *
 * This is not an authoritative chain-cap, hop-range, timing, damage-per-hop,
 * death/cancellation, moving-target, stun/reset, obstacle, projectile-travel,
 * visual, animation, audio, or full-match parity claim.
 */
export class ChainEncounter {
  #candidates;
  #commands;
  #commandIndex = 0;
  #currentOrigin = null;
  #damage = new DamageSystem();
  #history = [];
  #hitIds = [];
  #primaryTargetId;
  #setup;
  #started = false;
  #terminal = false;
  #tick = 0;

  constructor(setup = createChainSpecialFixture()) {
    this.#setup = checkedSetup(setup);
    this.#candidates = this.#setup.candidates;
    this.#commands = this.#setup.commands;
    this.#primaryTargetId = this.#setup.primaryTargetId;
    this.#damage.add(ATTACKER_ID, ATTACKER_MAX_HEALTH);
    for (const candidate of this.#candidates) {
      this.#damage.add(candidate.id, candidate.maxHealth);
      if (!candidate.alive) {
        this.#damage.damage(candidate.id, candidate.maxHealth);
      }
    }
  }

  get replay() {
    return clone(this.#history);
  }

  get state() {
    return clone({
      attackerAlive: !this.#damage.get(ATTACKER_ID).dead,
      candidates: this.#candidates.map((candidate) => {
        const health = this.#damage.get(candidate.id);
        return {
          alive: !health.dead,
          hitpoints: health.currentHealth,
          id: candidate.id,
        };
      }),
      currentOriginId: this.#currentOrigin?.id ?? null,
      hitTargetIds: this.#hitIds,
      phase: this.#terminal
        ? "terminal"
        : this.#started ? "chaining" : "winding-up",
      terminal: this.#terminal,
      tick: this.#tick,
    });
  }

  step() {
    if (this.#terminal || this.#tick >= MAX_TICK) return [];
    const boundary = this.#tick;
    const events = [];

    while (this.#commands[this.#commandIndex]?.tick === boundary) {
      const command = this.#commands[this.#commandIndex];
      this.#commandIndex += 1;
      const targetId = command.type === "kill-attacker"
        ? ATTACKER_ID
        : command.targetId;
      events.push({
        targetId,
        tick: boundary,
        type: "chain-command",
        value: command.type,
      });
      const result = this.#damage.damage(
        targetId,
        this.#damage.get(targetId).maxHealth,
      );
      events.push(...result.events.map((event) => ({
        ...event,
        tick: boundary,
        type: `external-${event.type}`,
      })));
    }

    if (boundary === PRIMARY_TICK && !this.#started) {
      if (this.#damage.get(ATTACKER_ID).dead) {
        this.#complete(events, boundary, "attacker-dead-before-primary");
      } else {
        const primary = this.#candidate(this.#primaryTargetId);
        if (!this.#eligible(primary) || !inRange({
          position: ATTACKER_POSITION,
          radius: ATTACKER_RADIUS,
        }, primary, DEFINITIONS[0].rangeMillitiles)) {
          this.#complete(events, boundary, "primary-ineligible");
        } else {
          this.#started = true;
          events.push({
            attackerId: ATTACKER_ID,
            targetId: primary.id,
            tick: boundary,
            type: "chain-start",
          });
          this.#hit(primary, events, boundary);
        }
      }
    } else if (
      this.#started &&
      !this.#terminal &&
      boundary ===
        PRIMARY_TICK +
          this.#hitIds.length * QUESTION_FIXTURES.hopDelayTicks.value
    ) {
      const next = this.#nearestEligibleUnhit();
      if (next === null) {
        this.#complete(events, boundary, "no-eligible-target");
      } else {
        this.#hit(next, events, boundary);
      }
    }

    this.#tick += 1;
    this.#history.push(...events);
    return clone(events);
  }

  stepMany(ticks) {
    if (!Number.isSafeInteger(ticks) || ticks < 0) {
      throw new TypeError("chain ticks must be a non-negative safe integer");
    }
    const events = [];
    for (
      let index = 0;
      index < ticks && !this.#terminal && this.#tick < MAX_TICK;
      index += 1
    ) {
      events.push(...this.step());
    }
    return events;
  }

  run(tickLimit = MAX_TICK) {
    if (!Number.isSafeInteger(tickLimit) || tickLimit < 0) {
      throw new TypeError("chain tick limit must be a non-negative safe integer");
    }
    if (tickLimit > MAX_TICK) {
      throw new RangeError("chain tick limit exceeds its bound");
    }
    while (!this.#terminal && this.#tick < tickLimit) this.step();
    return this.state;
  }

  serialize() {
    const serialized = canonicalJson({
      identity: this.#setup,
      tick: this.#tick,
      version: 1,
    });
    if (serialized.length > MAX_SNAPSHOT_BYTES) {
      throw new RangeError("chain snapshot exceeds its size bound");
    }
    return serialized;
  }

  static restore(serialized) {
    if (typeof serialized !== "string") {
      throw new TypeError("chain snapshot must be a string");
    }
    if (serialized.length > MAX_SNAPSHOT_BYTES) {
      throw new RangeError("chain snapshot exceeds its size bound");
    }
    let raw;
    try {
      raw = JSON.parse(serialized);
    } catch {
      throw new TypeError("chain snapshot must be valid JSON");
    }
    const snapshot = exactRecord(raw, SNAPSHOT_KEYS, "chain snapshot");
    if (snapshot.version !== 1) {
      throw new TypeError("chain snapshot version is unsupported");
    }
    if (
      !Number.isSafeInteger(snapshot.tick) ||
      snapshot.tick < 0 ||
      snapshot.tick > MAX_TICK
    ) {
      throw new TypeError("chain snapshot.tick is invalid");
    }
    const encounter = new ChainEncounter(snapshot.identity);
    encounter.stepMany(snapshot.tick);
    if (encounter.#tick !== snapshot.tick) {
      throw new TypeError("chain snapshot contains post-terminal time");
    }
    return encounter;
  }

  #candidate(id) {
    return this.#candidates.find((candidate) => candidate.id === id) ?? null;
  }

  #complete(events, tick, reason) {
    this.#terminal = true;
    events.push({
      hitTargetIds: [...this.#hitIds],
      reason,
      tick,
      type: "chain-complete",
    });
  }

  #eligible(candidate) {
    if (
      candidate === null ||
      !candidate.targetable ||
      this.#hitIds.includes(candidate.id)
    ) {
      return false;
    }
    return !this.#damage.get(candidate.id).dead;
  }

  #hit(candidate, events, tick) {
    this.#hitIds.push(candidate.id);
    this.#currentOrigin = {
      id: candidate.id,
      position: { ...candidate.position },
      radius: candidate.radius,
    };
    events.push({
      amount: QUESTION_FIXTURES.damagePerHop.value,
      hop: this.#hitIds.length,
      targetId: candidate.id,
      tick,
      type: "chain-hit",
    });
    const result = this.#damage.damage(
      candidate.id,
      QUESTION_FIXTURES.damagePerHop.value,
    );
    events.push(...result.events.map((event) => ({
      ...event,
      hop: this.#hitIds.length,
      tick,
      type: `chain-${event.type}`,
    })));
    if (this.#hitIds.length === QUESTION_FIXTURES.targetCap.value) {
      this.#complete(events, tick, "target-cap");
    } else {
      events.push({
        fromTargetId: candidate.id,
        nextTick: tick + QUESTION_FIXTURES.hopDelayTicks.value,
        tick,
        type: "chain-hop-pending",
      });
    }
  }

  #nearestEligibleUnhit() {
    const candidates = this.#candidates.filter((candidate) =>
      this.#eligible(candidate) &&
      inRange(
        this.#currentOrigin,
        candidate,
        QUESTION_FIXTURES.hopRangeMillitiles.value,
      )
    );
    candidates.sort((left, right) => {
      const leftDistance = distanceSquared(
        this.#currentOrigin.position,
        left.position,
      );
      const rightDistance = distanceSquared(
        this.#currentOrigin.position,
        right.position,
      );
      return leftDistance < rightDistance
        ? -1
        : leftDistance > rightDistance ? 1 : left.id - right.id;
    });
    return candidates[0] ?? null;
  }
}
