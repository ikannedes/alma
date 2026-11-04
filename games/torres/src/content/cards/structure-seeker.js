import { AttackCycle } from "../../sim/attack-cycle.js";
import { DamageSystem } from "../../sim/damage.js";
import {
  advanceMovement,
  createMovementState,
} from "../../sim/movement.js";
import { findGroundPath } from "../../sim/pathfinding.js";
import { retainOrAcquireTarget } from "../../sim/targeting.js";
import { createCardCatalog } from "../schema.js";

const DEFINITIONS = [
  {
    id: "stonehauler",
    displayName: "Stonehauler",
    cost: 5,
    kind: "unit",
    rarity: "uncommon",
    hitpoints: 4091,
    damage: 254,
    hitSpeedTicks: 90,
    firstHitTicks: 60,
    deployTimeTicks: 60,
    rangeMillitiles: 1200,
    sightRangeMillitiles: 7500,
    movementMillitilesPerSecond: 750,
    targetMode: "structures",
    count: 1,
    areaDamageRadiusMillitiles: null,
    components: [],
  },
];

const FIXTURE = Object.freeze({
  candidates: Object.freeze([
    Object.freeze({
      alive: true,
      hitpoints: null,
      id: 1,
      kind: "troop",
      layer: "ground",
      position: Object.freeze({ x: 3500, y: 12000 }),
      radius: 0,
      targetable: true,
    }),
    Object.freeze({
      alive: true,
      hitpoints: 1000,
      id: 301,
      kind: "structure",
      layer: "ground",
      position: Object.freeze({ x: 3500, y: 18500 }),
      radius: 0,
      targetable: true,
    }),
    Object.freeze({
      alive: true,
      hitpoints: 1000,
      id: 302,
      kind: "structure",
      layer: "ground",
      position: Object.freeze({ x: 4500, y: 18500 }),
      radius: 0,
      targetable: true,
    }),
  ]),
  seeker: Object.freeze({
    cardId: "stonehauler",
    id: 101,
    position: Object.freeze({ x: 3500, y: 11500 }),
    radius: 0,
  }),
});

const SETUP_KEYS = ["candidates", "seeker"];
const SEEKER_KEYS = ["cardId", "id", "position", "radius"];
const CANDIDATE_KEYS = [
  "alive",
  "hitpoints",
  "id",
  "kind",
  "layer",
  "position",
  "radius",
  "targetable",
];
const POSITION_KEYS = ["x", "y"];
const SNAPSHOT_KEYS = ["identity", "tick", "version"];
const MAX_CANDIDATES = 8;
const MAX_ENTITY_ID = Number.MAX_SAFE_INTEGER;
const MAX_HITPOINTS = 1_000_000;
const MAX_RADIUS = 5_000;
const MAX_SNAPSHOT_BYTES = 8_192;
const MAX_TICK = 854;

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

function denseArray(value, minimumLength, maximumLength, label) {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length < minimumLength ||
    value.length > maximumLength
  ) {
    throw new TypeError(
      `${label} must be a plain array with ${minimumLength} to ${maximumLength} entries`,
    );
  }
  const length = value.length;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(descriptors).length !== length + 1 ||
    Array.from({ length }, (_, index) => index).some((index) => (
      !descriptors[index]?.enumerable ||
      !Object.hasOwn(descriptors[index], "value")
    ))
  ) {
    throw new TypeError(`${label} must contain dense data properties`);
  }
  return Array.from({ length }, (_, index) => descriptors[index].value);
}

function safeInteger(value, label, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new TypeError(
      `${label} must be a safe integer of at least ${minimum}`,
    );
  }
}

function boundedInteger(value, label, minimum, maximum) {
  safeInteger(value, label, minimum);
  if (value > maximum) {
    throw new RangeError(`${label} exceeds its encounter bound`);
  }
}

function checkedPosition(value, label) {
  const position = exactRecord(value, POSITION_KEYS, label);
  for (const axis of POSITION_KEYS) {
    safeInteger(position[axis], `${label}.${axis}`);
    const maximum = axis === "x" ? 18000 : 32000;
    if (position[axis] > maximum) {
      throw new RangeError(`${label}.${axis} is outside the encounter bounds`);
    }
  }
  return position;
}

function checkedSeeker(value) {
  const seeker = exactRecord(value, SEEKER_KEYS, "structure seeker");
  if (seeker.cardId !== FIXTURE.seeker.cardId) {
    throw new TypeError("structure seeker must select the canonical card");
  }
  boundedInteger(
    seeker.id,
    "structure seeker.id",
    1,
    MAX_ENTITY_ID,
  );
  boundedInteger(
    seeker.radius,
    "structure seeker.radius",
    0,
    MAX_RADIUS,
  );
  return {
    cardId: seeker.cardId,
    id: seeker.id,
    position: checkedPosition(seeker.position, "structure seeker.position"),
    radius: seeker.radius,
  };
}

function checkedCandidate(value, index) {
  const label = `structure seeker candidate ${index}`;
  const candidate = exactRecord(value, CANDIDATE_KEYS, label);
  boundedInteger(candidate.id, `${label}.id`, 1, MAX_ENTITY_ID);
  boundedInteger(candidate.radius, `${label}.radius`, 0, MAX_RADIUS);
  if (typeof candidate.alive !== "boolean") {
    throw new TypeError(`${label}.alive must be a boolean`);
  }
  if (candidate.kind !== "troop" && candidate.kind !== "structure") {
    throw new TypeError(`${label}.kind is invalid`);
  }
  if (candidate.layer !== "ground" && candidate.layer !== "air") {
    throw new TypeError(`${label}.layer is invalid`);
  }
  if (typeof candidate.targetable !== "boolean") {
    throw new TypeError(`${label}.targetable must be a boolean`);
  }
  if (candidate.kind === "structure") {
    boundedInteger(
      candidate.hitpoints,
      `${label}.hitpoints`,
      1,
      MAX_HITPOINTS,
    );
  } else if (candidate.hitpoints !== null) {
    throw new TypeError(`${label}.hitpoints must be null for a troop`);
  }
  return {
    alive: candidate.alive,
    hitpoints: candidate.hitpoints,
    id: candidate.id,
    kind: candidate.kind,
    layer: candidate.layer,
    position: checkedPosition(candidate.position, `${label}.position`),
    radius: candidate.radius,
    targetable: candidate.targetable,
  };
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

function canonicalFixture() {
  return {
    candidates: FIXTURE.candidates.map((candidate) => ({
      ...candidate,
      position: { ...candidate.position },
    })),
    seeker: {
      ...FIXTURE.seeker,
      position: { ...FIXTURE.seeker.position },
    },
  };
}

function checkedSetup(value) {
  const setup = exactRecord(value, SETUP_KEYS, "structure seeker setup");
  const seeker = checkedSeeker(setup.seeker);
  const candidates = denseArray(
    setup.candidates,
    1,
    MAX_CANDIDATES,
    "structure seeker candidates",
  ).map(checkedCandidate).sort((left, right) => left.id - right.id);
  if (
    new Set([seeker.id, ...candidates.map(({ id }) => id)]).size !==
      candidates.length + 1
  ) {
    throw new TypeError("structure seeker fixture IDs must be unique");
  }
  return { candidates, seeker };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function inReach(origin, target, range) {
  const dx = BigInt(origin.position.x - target.position.x);
  const dy = BigInt(origin.position.y - target.position.y);
  const reach = BigInt(range + origin.radius + target.radius);
  return dx * dx + dy * dy <= reach * reach;
}

/**
 * Returns the one original structure-seeking runtime definition in isolation.
 */
export function createStructureSeekerCatalog() {
  return createCardCatalog(DEFINITIONS);
}

/**
 * Returns the canonical synthetic encounter. Candidate order may be reversed
 * to exercise deterministic targeting without changing encounter identity.
 */
export function createStructureSeekerFixture(reverseCandidates = false) {
  if (typeof reverseCandidates !== "boolean") {
    throw new TypeError("reverseCandidates must be a boolean");
  }
  const fixture = canonicalFixture();
  if (reverseCandidates) fixture.candidates.reverse();
  return fixture;
}

/**
 * A deliberately narrow deterministic integration of target selection,
 * coarse ground routing, exact fixed-point movement, attack cadence, and
 * damage. It accepts a bounded plain-data point-agent fixture while keeping
 * all Stonehauler combat stats internal and immutable.
 *
 * This is not a claim about collision-authoritative bridge geometry, body
 * radii, crowd steering, animation timing, or complete Crown Tower combat.
 * The coarse bridge coordinates are screenshot-derived; canonical fixture
 * radii are synthetic zeroes; and firstHitTicks represents load time rather
 * than a footage-measured contact frame.
 */
export class StructureSeekerEncounter {
  #attack;
  #card;
  #damage;
  #fixture;
  #history = [];
  #movement;
  #position;
  #route;
  #routeDistance = 0;
  #targetId = null;
  #terminal = false;
  #tick = 0;

  constructor(setup = createStructureSeekerFixture()) {
    this.#fixture = checkedSetup(setup);
    this.#card = createStructureSeekerCatalog()[0];
    this.#position = { ...this.#fixture.seeker.position };
    // Validate the start even when no target is eligible and no route would
    // otherwise be requested. The graph itself has a fixed 576-node bound.
    findGroundPath(
      this.#fixture.seeker.position,
      this.#fixture.seeker.position,
    );
    this.#damage = new DamageSystem();
    for (
      const candidate of this.#fixture.candidates.filter(
        ({ kind }) => kind === "structure",
      )
    ) {
      this.#damage.add(candidate.id, candidate.hitpoints);
    }
    const initial = retainOrAcquireTarget(
      {
        position: this.#fixture.seeker.position,
        radius: this.#fixture.seeker.radius,
      },
      this.#targetingCandidates(),
      {
        currentTargetId: null,
        mode: "buildings",
        sightRange: this.#card.sightRangeMillitiles,
      },
    );
    this.#route = initial === null
      ? null
      : findGroundPath(this.#fixture.seeker.position, initial.position);
    if (initial !== null && this.#route === null) {
      throw new RangeError("selected structure seeker route is unavailable");
    }
    this.#movement = createMovementState({
      direction: 1,
      position: 0,
      remainder: 0,
      speed: this.#card.movementMillitilesPerSecond,
    });
    this.#attack = new AttackCycle({
      deployTicks: this.#card.deployTimeTicks,
      firstHitTicks: this.#card.firstHitTicks,
      hitSpeedTicks: this.#card.hitSpeedTicks,
    });
  }

  #candidateAlive(candidate) {
    return candidate.alive && (
      candidate.kind !== "structure" ||
      !this.#damage.get(candidate.id).dead
    );
  }

  #targetingCandidates() {
    return this.#fixture.candidates.map((candidate) => ({
      alive: this.#candidateAlive(candidate),
      id: candidate.id,
      kind: candidate.kind,
      layer: candidate.layer,
      position: candidate.position,
      radius: candidate.radius,
      // Buildings are ground entities in this encounter. Keeping the layer
      // check here lets the shared buildings-mode selector remain generic.
      targetable: candidate.targetable && candidate.layer === "ground",
    }));
  }

  #positionAtRouteDistance(distance) {
    if (this.#route === null || this.#route.length === 0) {
      return { ...this.#position };
    }
    let remaining = distance;
    for (let index = 1; index < this.#route.length; index += 1) {
      const from = this.#route[index - 1];
      const to = this.#route[index];
      const length = Math.abs(to.x - from.x) + Math.abs(to.y - from.y);
      if (remaining <= length) {
        const moved = Math.min(remaining, length);
        return {
          x: from.x + Math.sign(to.x - from.x) * moved,
          y: from.y + Math.sign(to.y - from.y) * moved,
        };
      }
      remaining -= length;
    }
    return { ...this.#route.at(-1) };
  }

  get replay() {
    return clone(this.#history);
  }

  get route() {
    return clone(this.#route);
  }

  get state() {
    const target = this.#targetId === null
      ? null
      : this.#fixture.candidates.find(({ id }) => id === this.#targetId);
    const targetHealth = target === null || target.kind !== "structure"
      ? null
      : this.#damage.get(target.id);
    let phase;
    if (this.#terminal) {
      phase = "terminal";
    } else if (this.#attack.state.phase === "deploying") {
      phase = "deploying";
    } else if (target !== null && inReach(
      { position: this.#position, radius: this.#fixture.seeker.radius },
      target,
      this.#card.rangeMillitiles,
    )) {
      phase = this.#attack.state.phase;
    } else if (target === null && this.#attack.state.phase !== "deploying") {
      phase = "inert";
    } else {
      phase = "moving";
    }
    return clone({
      attack: this.#attack.state,
      phase,
      position: this.#position,
      targetHealth,
      targetId: this.#targetId,
      terminal: this.#terminal,
      tick: this.#tick,
    });
  }

  step() {
    if (this.#terminal || this.#tick >= MAX_TICK) return [];
    const boundary = this.#tick;
    const candidates = this.#targetingCandidates();
    const selected = retainOrAcquireTarget(
      { position: this.#position, radius: this.#fixture.seeker.radius },
      candidates,
      {
        currentTargetId: this.#targetId,
        mode: "buildings",
        sightRange: this.#card.sightRangeMillitiles,
      },
    );
    const events = [];
    const selectedId = selected?.id ?? null;
    if (selectedId !== this.#targetId) {
      this.#targetId = selectedId;
      events.push({
        targetId: selectedId,
        tick: boundary,
        type: selectedId === null ? "target-lost" : "target-acquired",
      });
    }

    let reached = selected !== null && inReach(
      { position: this.#position, radius: this.#fixture.seeker.radius },
      selected,
      this.#card.rangeMillitiles,
    );
    if (
      boundary >= this.#card.deployTimeTicks &&
      selected !== null &&
      !reached
    ) {
      this.#movement = advanceMovement(this.#movement);
      this.#routeDistance = this.#movement.position;
      this.#position = this.#positionAtRouteDistance(this.#routeDistance);
      reached = inReach(
        { position: this.#position, radius: this.#fixture.seeker.radius },
        selected,
        this.#card.rangeMillitiles,
      );
      events.push({
        position: { ...this.#position },
        tick: boundary,
        type: "move",
      });
      if (reached) {
        events.push({
          position: { ...this.#position },
          targetId: selected.id,
          tick: boundary,
          type: "reached",
        });
      }
    }

    const ready = this.#attack.step({
      targetEligible: reached && selected !== null,
      targetId: reached && selected !== null ? selected.id : null,
    });
    for (const event of ready) {
      const result = this.#damage.damage(event.targetId, this.#card.damage);
      events.push({
        amount: this.#card.damage,
        currentHealth: result.currentHealth,
        sequence: event.sequence,
        targetId: event.targetId,
        tick: event.tick,
        type: "attack",
      });
      if (result.currentHealth === 0) {
        this.#terminal = true;
        events.push({
          targetId: event.targetId,
          tick: event.tick,
          type: "terminal",
        });
      }
    }
    this.#tick += 1;
    this.#history.push(...events);
    return clone(events);
  }

  stepMany(ticks) {
    safeInteger(ticks, "structure seeker ticks");
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
    safeInteger(tickLimit, "structure seeker tick limit");
    if (tickLimit > MAX_TICK) {
      throw new RangeError("structure seeker tick limit exceeds its bound");
    }
    while (!this.#terminal && this.#tick < tickLimit) this.step();
    return this.state;
  }

  serialize() {
    const serialized = canonicalJson({
      identity: this.#fixture,
      tick: this.#tick,
      version: 1,
    });
    if (serialized.length > MAX_SNAPSHOT_BYTES) {
      throw new RangeError("structure seeker snapshot exceeds its size bound");
    }
    return serialized;
  }

  static restore(serialized) {
    if (typeof serialized !== "string") {
      throw new TypeError("structure seeker snapshot must be a string");
    }
    if (serialized.length > MAX_SNAPSHOT_BYTES) {
      throw new RangeError("structure seeker snapshot exceeds its size bound");
    }
    let snapshot;
    try {
      snapshot = JSON.parse(serialized);
    } catch {
      throw new TypeError("structure seeker snapshot must be valid JSON");
    }
    const checked = exactRecord(
      snapshot,
      SNAPSHOT_KEYS,
      "structure seeker snapshot",
    );
    if (checked.version !== 1) {
      throw new TypeError("structure seeker snapshot version is unsupported");
    }
    safeInteger(checked.tick, "structure seeker snapshot.tick");
    if (checked.tick > MAX_TICK) {
      throw new RangeError("structure seeker snapshot exceeds its causal bound");
    }
    const encounter = new StructureSeekerEncounter(checked.identity);
    encounter.stepMany(checked.tick);
    if (encounter.#tick !== checked.tick) {
      throw new TypeError("structure seeker snapshot contains post-terminal time");
    }
    return encounter;
  }
}
