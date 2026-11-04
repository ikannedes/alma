import { DamageSystem } from "../../sim/damage.js";
import { MAX_SPATIAL_MILLITILES } from "../../sim/spatial.js";
import { targetCandidate } from "../../sim/targeting.js";
import {
  appendCombatEffectEvent,
  appendCombatEffectRoot,
  combatEffectFeedSnapshot,
  createCombatEffectFeed,
  serializeCombatEffectFeed,
} from "../../sim/combat-effect-feed.js";
import { createCardCatalog } from "../schema.js";

const DEFINITIONS = [{
  id: "scatterguard",
  displayName: "Scatterguard",
  cost: 4,
  kind: "unit",
  rarity: "special",
  hitpoints: 838,
  damage: 84,
  hitSpeedTicks: 132,
  firstHitTicks: 84,
  deployTimeTicks: 60,
  rangeMillitiles: 4000,
  sightRangeMillitiles: 5500,
  movementMillitilesPerSecond: 1000,
  targetMode: "ground-and-air",
  count: 1,
  areaDamageRadiusMillitiles: 70,
  components: [],
}];

const QUESTION_SOURCE = "unsourced-fixed-fan-pellet-volley-fixture";

function deepFreeze(value) {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function question(value) {
  return deepFreeze({
    authoritative: false,
    confidence: "unverified",
    disposition: "question",
    source: QUESTION_SOURCE,
    value,
  });
}

const QUESTION_FIXTURES = deepFreeze({
  aggregateDamageOrderRule: question(
    "pellet-id-order;targets-first-contact-pellet-id-order",
  ),
  areaDamageRadiusMillitiles: question(70),
  attackerDeathAfterLaunchRule: question("launched-volley-continues"),
  attackerDeathThroughLaunchRule: question("cancels-volley"),
  collisionWidthMillitiles: question(40),
  count: question(1),
  damage: question(84),
  damagePerPellet: question(84),
  deployTimeTicks: question(60),
  firstContactObstructionRule: question(
    "each-ray-stops-at-first-alive-eligible-launch-snapshot-contact",
  ),
  firstHitTicks: question(84),
  hitSpeedTicks: question(132),
  hitpoints: question(838),
  interruptionAfterLaunchRule: question("launched-volley-continues"),
  interruptionThroughLaunchRule: question("cancels-volley"),
  launchSnapshotRule: question(
    "positions-radii-kinds-layers-and-targetable-state-snapshot-at-launch",
  ),
  movementMillitilesPerSecond: question(1000),
  pelletCount: question(10),
  pelletIdRule: question("one-through-ten-in-ray-pattern-order"),
  pelletRangeMillitiles: question(4250),
  pelletSpeedMillitilesPerTick: question(425),
  rangeMillitiles: question(4000),
  rayPattern: question([
    { x: 375, y: -200 },
    { x: 385, y: -180 },
    { x: 408, y: -119 },
    { x: 416, y: -87 },
    { x: 420, y: -65 },
    { x: 420, y: 65 },
    { x: 416, y: 87 },
    { x: 408, y: 119 },
    { x: 385, y: 180 },
    { x: 375, y: 200 },
  ]),
  rayPatternNorm: question(425),
  sameBoundaryRule: question(
    "commands-before-launch-or-impact;pellets-then-aggregate-damage-then-complete",
  ),
  sightRangeMillitiles: question(5500),
  targetDeathRule: question(
    "dead-before-impact-is-ineligible-and-does-not-obstruct",
  ),
  targetEligibilityRule: question(
    "alive-targetable-ground-or-air-troops-and-structures",
  ),
  targetMode: question("ground-and-air"),
  volleyDamageRule: question(
    "same-target-may-take-one-damage-per-contacting-pellet",
  ),
});

const ATTACKER_ID = 101;
const ORIGIN = Object.freeze({ x: 0, y: 0 });
const LAUNCH_TICK = QUESTION_FIXTURES.firstHitTicks.value;
const FLIGHT_TICKS = Math.ceil(
  QUESTION_FIXTURES.pelletRangeMillitiles.value /
    QUESTION_FIXTURES.pelletSpeedMillitilesPerTick.value,
);
const IMPACT_TICK = LAUNCH_TICK + FLIGHT_TICKS;
const MAX_TICK = IMPACT_TICK + 1;
const MAX_CANDIDATES = 32;
const MAX_COMMANDS = 24;
const MAX_REPLAY_EVENTS = 256;
const MAX_SNAPSHOT_BYTES = 65_536;
const SETUP_KEYS = ["aim", "candidates", "commands"];
const AIM_KEYS = ["x", "y"];
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
const COMMAND_TYPES = new Set([
  "interrupt-attacker",
  "kill-attacker",
  "kill-target",
]);

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

function integerSquareRoot(value) {
  if (value < 0n) throw new RangeError("square root input must be non-negative");
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

function checkedAim(value) {
  const aim = exactRecord(value, AIM_KEYS, "pellet aim");
  for (const key of AIM_KEYS) {
    if (
      !Number.isSafeInteger(aim[key]) ||
      Math.abs(aim[key]) > MAX_SPATIAL_MILLITILES
    ) {
      throw new TypeError(
        `pellet aim.${key} must be a safe integer within spatial bounds`,
      );
    }
  }
  if (aim.x === 0 && aim.y === 0) {
    throw new TypeError("pellet aim must not be a zero vector");
  }
  return { x: aim.x, y: aim.y };
}

function projectedRays(aim) {
  const ax = BigInt(aim.x);
  const ay = BigInt(aim.y);
  const magnitudeSquared = ax * ax + ay * ay;
  const magnitude = integerSquareRoot(magnitudeSquared);
  if (magnitude * magnitude !== magnitudeSquared) {
    throw new TypeError("pellet aim magnitude must be an exact integer");
  }
  const range = BigInt(QUESTION_FIXTURES.pelletRangeMillitiles.value);
  const norm = BigInt(QUESTION_FIXTURES.rayPatternNorm.value);
  if (range % norm !== 0n) {
    throw new RangeError("pellet range must be an integer ray-norm multiple");
  }
  const scale = range / norm;
  const bound = BigInt(MAX_SPATIAL_MILLITILES);
  return QUESTION_FIXTURES.rayPattern.value.map((local, index) => {
    const rotatedX = ax * BigInt(local.x) - ay * BigInt(local.y);
    const rotatedY = ay * BigInt(local.x) + ax * BigInt(local.y);
    const xNumerator = rotatedX * scale;
    const yNumerator = rotatedY * scale;
    if (
      xNumerator < -bound * magnitude ||
      xNumerator > bound * magnitude ||
      yNumerator < -bound * magnitude ||
      yNumerator > bound * magnitude
    ) {
      throw new RangeError("pellet endpoint exceeds spatial bounds");
    }
    return {
      endpoint: {
        denominator: magnitude.toString(),
        xNumerator: xNumerator.toString(),
        yNumerator: yNumerator.toString(),
      },
      pelletId: index + 1,
    };
  });
}

function checkedCandidate(value, index) {
  const label = `pellet candidate ${index}`;
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
    throw new TypeError("pellet candidate ID collides with the attacker");
  }
  return { ...candidate, maxHealth: raw.maxHealth };
}

function checkedCandidates(value) {
  const candidates = denseArray(
    value,
    MAX_CANDIDATES,
    "pellet candidates",
  ).map(checkedCandidate).sort((left, right) => left.id - right.id);
  for (let index = 1; index < candidates.length; index += 1) {
    if (candidates[index - 1].id === candidates[index].id) {
      throw new TypeError("pellet candidates must have unique IDs");
    }
  }
  return candidates;
}

function checkedCommands(value, candidateIds) {
  const commands = denseArray(value, MAX_COMMANDS, "pellet commands")
    .map((entry, index) => {
      const command = exactRecord(
        entry,
        COMMAND_KEYS,
        `pellet command ${index}`,
      );
      if (!COMMAND_TYPES.has(command.type)) {
        throw new TypeError(`pellet command ${index}.type is invalid`);
      }
      if (
        !Number.isSafeInteger(command.tick) ||
        command.tick < 0 ||
        command.tick > IMPACT_TICK
      ) {
        throw new TypeError(`pellet command ${index}.tick is invalid`);
      }
      if (command.type === "kill-target") {
        if (
          !Number.isSafeInteger(command.targetId) ||
          !candidateIds.has(command.targetId)
        ) {
          throw new TypeError("kill-target targetId must name a candidate");
        }
      } else if (command.targetId !== null) {
        throw new TypeError(`${command.type} targetId must be null`);
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
    const left = commands[index - 1];
    const right = commands[index];
    if (
      left.tick === right.tick &&
      left.type === right.type &&
      left.targetId === right.targetId
    ) {
      throw new TypeError("pellet commands must be unique");
    }
  }
  return commands;
}

function checkedSetup(value) {
  const setup = exactRecord(value, SETUP_KEYS, "pellet setup");
  const aim = checkedAim(setup.aim);
  projectedRays(aim);
  const candidates = checkedCandidates(setup.candidates);
  return {
    aim,
    candidates,
    commands: checkedCommands(
      setup.commands,
      new Set(candidates.map(({ id }) => id)),
    ),
  };
}

function defaultCandidates() {
  return [{
    alive: true,
    id: 201,
    kind: "troop",
    layer: "ground",
    maxHealth: 2000,
    position: { x: 1000, y: 0 },
    radius: 600,
    targetable: true,
  }];
}

function deepFrozenQuestionCopy() {
  return deepFreeze(clone(QUESTION_FIXTURES));
}

function capsuleParameter(candidate, endpoint) {
  const denominator = BigInt(endpoint.denominator);
  const px = BigInt(candidate.position.x) - BigInt(ORIGIN.x);
  const py = BigInt(candidate.position.y) - BigInt(ORIGIN.y);
  const nx = BigInt(endpoint.xNumerator);
  const ny = BigInt(endpoint.yNumerator);
  const numeratorLengthSquared = nx * nx + ny * ny;
  const dotNumerator = px * nx + py * ny;
  const reach =
    BigInt(QUESTION_FIXTURES.collisionWidthMillitiles.value) +
    BigInt(candidate.radius);
  if (dotNumerator <= 0n) {
    if (px * px + py * py > reach * reach) return null;
    return 0n;
  }
  if (dotNumerator * denominator >= numeratorLengthSquared) {
    const ex = px * denominator - nx;
    const ey = py * denominator - ny;
    if (ex * ex + ey * ey > reach * reach * denominator * denominator) {
      return null;
    }
    return numeratorLengthSquared;
  }
  const crossNumerator = px * ny - py * nx;
  if (
    crossNumerator * crossNumerator >
      reach * reach * numeratorLengthSquared
  ) {
    return null;
  }
  return dotNumerator * denominator;
}

/**
 * Returns the original Scatterguard runtime definition. Any external
 * comparison identity belongs only in tests and never in shipped content.
 */
export function createPelletSpecialCatalog() {
  return createCardCatalog(DEFINITIONS);
}

/**
 * Returns an independently copied, recursively frozen QUESTION record for
 * every combat value and every fixed-fan policy absent from the common corpus.
 */
export function createPelletQuestionFixture(...args) {
  if (args.length !== 0) {
    throw new TypeError("pellet question fixture does not accept overrides");
  }
  return deepFrozenQuestionCopy();
}

/** Creates one validated, isolated, bounded pellet-volley fixture. */
export function createPelletSpecialFixture(
  candidates = defaultCandidates(),
  aim = { x: 1, y: 0 },
  commands = [],
  ...extra
) {
  if (extra.length !== 0) {
    throw new TypeError("pellet fixture received extra arguments");
  }
  return clone(checkedSetup({ aim, candidates, commands }));
}

/**
 * One deterministic fixed-fan volley over launch-time candidate geometry.
 * Ten integer local rays rotate into exact rational endpoints without
 * trigonometry or floating arithmetic.
 * Each finite inclusive capsule selects its first live eligible contact by
 * forward parameter then stable target ID. Pellet contacts and aggregate
 * damage resolve in stable pellet-ID order.
 *
 * This is not an authoritative pellet-count, ray-pattern, range, speed, width,
 * damage-per-pellet, first-contact, obstruction, aggregation, event-order,
 * launch-snapshot, death, interruption, target-eligibility, same-boundary,
 * animation, visual, audio, or full-match parity claim.
 */
export class PelletEncounter {
  #candidates;
  #commands;
  #commandIndex = 0;
  #damage = new DamageSystem();
  #feed = createCombatEffectFeed();
  #feedRoot = null;
  #history = [];
  #interrupted = false;
  #launched = false;
  #rays = [];
  #setup;
  #terminal = false;
  #tick = 0;

  constructor(setup = createPelletSpecialFixture()) {
    this.#setup = checkedSetup(setup);
    this.#candidates = this.#setup.candidates;
    this.#commands = this.#setup.commands;
    this.#damage.add(ATTACKER_ID, QUESTION_FIXTURES.hitpoints.value);
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
    return PelletEncounter.restore(this.serialize());
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
      contacts: this.#history
        .filter(({ type }) => type === "pellet-contact")
        .map(({ pelletId, targetId }) => ({ pelletId, targetId })),
      interrupted: this.#interrupted,
      launched: this.#launched,
      phase: this.#terminal
        ? "terminal"
        : this.#launched ? "in-flight" : "winding-up",
      terminal: this.#terminal,
      tick: this.#tick,
    });
  }

  step() {
    if (this.#terminal || this.#tick >= MAX_TICK) return [];
    const boundary = this.#tick;
    const events = [];
    this.#resolveCommands(boundary, events);

    if (boundary === LAUNCH_TICK) {
      if (this.#damage.get(ATTACKER_ID).dead || this.#interrupted) {
        this.#complete(events, boundary, "launch-cancelled");
      } else {
        this.#launched = true;
        this.#rays = projectedRays(this.#setup.aim);
        events.push({
          impactTick: IMPACT_TICK,
          origin: { ...ORIGIN },
          pellets: this.#rays.map(({ endpoint, pelletId }) => ({
            endpoint: { ...endpoint },
            pelletId,
          })),
          tick: boundary,
          type: "pellet-volley-launch",
        });
      }
    } else if (boundary === IMPACT_TICK && this.#launched) {
      this.#impact(boundary, events);
    }

    this.#tick += 1;
    this.#observeVisualEvents(events);
    if (this.#history.length + events.length > MAX_REPLAY_EVENTS) {
      throw new RangeError("pellet replay exceeds its event bound");
    }
    this.#history.push(...events);
    return clone(events);
  }

  stepMany(ticks) {
    if (!Number.isSafeInteger(ticks) || ticks < 0) {
      throw new TypeError("pellet ticks must be a non-negative safe integer");
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
      throw new TypeError(
        "pellet tick limit must be a non-negative safe integer",
      );
    }
    if (tickLimit > MAX_TICK) {
      throw new RangeError("pellet tick limit exceeds its bound");
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
      throw new RangeError("pellet snapshot exceeds its size bound");
    }
    return serialized;
  }

  static restore(serialized) {
    if (typeof serialized !== "string") {
      throw new TypeError("pellet snapshot must be a string");
    }
    if (serialized.length > MAX_SNAPSHOT_BYTES) {
      throw new RangeError("pellet snapshot exceeds its size bound");
    }
    let raw;
    try {
      raw = JSON.parse(serialized);
    } catch {
      throw new TypeError("pellet snapshot must be valid JSON");
    }
    const snapshot = exactRecord(raw, SNAPSHOT_KEYS, "pellet snapshot");
    if (snapshot.version !== 1) {
      throw new TypeError("pellet snapshot version is unsupported");
    }
    if (
      !Number.isSafeInteger(snapshot.tick) ||
      snapshot.tick < 0 ||
      snapshot.tick > MAX_TICK
    ) {
      throw new TypeError("pellet snapshot.tick is invalid");
    }
    const encounter = new PelletEncounter(snapshot.identity);
    encounter.stepMany(snapshot.tick);
    if (encounter.#tick !== snapshot.tick) {
      throw new TypeError("pellet snapshot contains post-terminal time");
    }
    return encounter;
  }

  #complete(events, tick, reason) {
    this.#terminal = true;
    events.push({
      contacts: [
        ...this.#history,
        ...events,
      ].filter(({ type }) => type === "pellet-contact")
        .map(({ pelletId, targetId }) => ({ pelletId, targetId })),
      reason,
      tick,
      type: "pellet-volley-complete",
    });
  }

  #observeVisualEvents(events) {
    for (const event of events) {
      if (event.type === "pellet-volley-launch") {
        const root = appendCombatEffectRoot(this.#feed, {
          direction: "pellet",
          effectId: null,
          from: event.origin,
          impactTick: event.impactTick,
          projectileId: null,
          radius: QUESTION_FIXTURES.collisionWidthMillitiles.value,
          segments: event.pellets.map(({ endpoint, pelletId }) => ({ id: pelletId, to: endpoint })),
          sequence: 1,
          sourceId: ATTACKER_ID,
          tick: event.tick,
          to: null,
          type: "projectile",
        });
        this.#feedRoot = { lastEventId: root.eventId, rootId: root.rootId };
        continue;
      }
      if (this.#feedRoot === null) continue;
      if (event.type === "pellet-contact") {
        const ray = this.#rays.find(({ pelletId }) => pelletId === event.pelletId);
        const child = appendCombatEffectEvent(this.#feed, {
          parentId: this.#feedRoot.lastEventId,
          payload: {
            point: ray?.endpoint ?? ORIGIN,
            status: "contact",
            subId: event.pelletId,
            targetId: event.targetId,
          },
          phase: "contact",
          rootId: this.#feedRoot.rootId,
          tick: event.tick,
          type: "projectile",
        });
        this.#feedRoot.lastEventId = child.eventId;
      } else if (event.type === "pellet-damage" || event.type === "pellet-aggregate-damage") {
        if (event.type === "pellet-aggregate-damage") {
          // Aggregate records are outcomes of the contact batch; the visual
          // transcript keeps one linked damage record per authoritative damage
          // event and does not expose a private aggregate primitive.
          continue;
        }
        const child = appendCombatEffectEvent(this.#feed, {
          parentId: this.#feedRoot.lastEventId,
          payload: {
            amount: event.amount,
            currentHealthAfter: event.currentHealthAfter,
            currentHealthBefore: event.currentHealthBefore,
            targetId: event.targetId,
          },
          phase: "damage",
          rootId: this.#feedRoot.rootId,
          tick: event.tick,
          type: "projectile",
        });
        this.#feedRoot.lastEventId = child.eventId;
      } else if (event.type === "pellet-death") {
        const child = appendCombatEffectEvent(this.#feed, {
          parentId: this.#feedRoot.lastEventId,
          payload: { targetId: event.targetId },
          phase: "death",
          rootId: this.#feedRoot.rootId,
          tick: event.tick,
          type: "projectile",
        });
        this.#feedRoot.lastEventId = child.eventId;
      } else if (event.type === "pellet-volley-complete") {
        const reason = event.reason === "impact-resolved" ? "complete" : event.reason;
        const child = appendCombatEffectEvent(this.#feed, {
          parentId: this.#feedRoot.lastEventId,
          payload: { reason },
          phase: "close",
          rootId: this.#feedRoot.rootId,
          tick: event.tick,
          type: "projectile",
        });
        this.#feedRoot.lastEventId = child.eventId;
      }
    }
  }

  #impact(tick, events) {
    const contacts = [];
    for (const ray of this.#rays) {
      const contact = this.#candidates
        .filter((candidate) =>
          candidate.targetable &&
          !this.#damage.get(candidate.id).dead
        )
        .map((candidate) => ({
          candidate,
          parameter: capsuleParameter(candidate, ray.endpoint),
        }))
        .filter(({ parameter }) => parameter !== null)
        .sort((left, right) =>
          left.parameter < right.parameter
            ? -1
            : left.parameter > right.parameter
            ? 1
            : left.candidate.id - right.candidate.id
        )[0];
      if (contact !== undefined) {
        contacts.push({
          pelletId: ray.pelletId,
          targetId: contact.candidate.id,
        });
        events.push({
          parameterNumerator: contact.parameter.toString(),
          pelletId: ray.pelletId,
          targetId: contact.candidate.id,
          tick,
          type: "pellet-contact",
        });
      }
    }

    const aggregates = [];
    for (const contact of contacts) {
      let aggregate = aggregates.find(
        ({ targetId }) => targetId === contact.targetId,
      );
      if (aggregate === undefined) {
        aggregate = {
          amount: 0,
          pelletIds: [],
          targetId: contact.targetId,
        };
        aggregates.push(aggregate);
      }
      aggregate.amount += QUESTION_FIXTURES.damagePerPellet.value;
      aggregate.pelletIds.push(contact.pelletId);
    }
    for (const aggregate of aggregates) {
      events.push({
        amount: aggregate.amount,
        pelletIds: [...aggregate.pelletIds],
        targetId: aggregate.targetId,
        tick,
        type: "pellet-aggregate-damage",
      });
      const result = this.#damage.damage(
        aggregate.targetId,
        aggregate.amount,
      );
      events.push(...result.events.map((event) => ({
        ...event,
        pelletIds: [...aggregate.pelletIds],
        tick,
        type: `pellet-${event.type}`,
      })));
    }
    this.#complete(events, tick, "impact-resolved");
  }

  #resolveCommands(tick, events) {
    while (this.#commands[this.#commandIndex]?.tick === tick) {
      const command = this.#commands[this.#commandIndex];
      this.#commandIndex += 1;
      const targetId = command.type === "kill-target"
        ? command.targetId
        : ATTACKER_ID;
      events.push({
        targetId,
        tick,
        type: "pellet-command",
        value: command.type,
      });
      if (command.type === "interrupt-attacker") {
        this.#interrupted = true;
      } else {
        const result = this.#damage.damage(
          targetId,
          this.#damage.get(targetId).maxHealth,
        );
        events.push(...result.events.map((event) => ({
          ...event,
          tick,
          type: `external-${event.type}`,
        })));
      }
    }
  }
}
