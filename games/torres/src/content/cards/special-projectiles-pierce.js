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
  id: "prism-warden",
  displayName: "Prism Warden",
  cost: 4,
  kind: "unit",
  rarity: "mythic",
  hitpoints: 532,
  damage: 134,
  hitSpeedTicks: 66,
  firstHitTicks: 36,
  deployTimeTicks: 60,
  rangeMillitiles: 7000,
  sightRangeMillitiles: 7500,
  movementMillitilesPerSecond: 1000,
  targetMode: "ground-and-air",
  count: 1,
  areaDamageRadiusMillitiles: null,
  components: [],
}];

const QUESTION_SOURCE = "unsourced-linear-through-shot-fixture";

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
  attackerDeathAfterLaunchRule: question("launched-shot-continues"),
  attackerDeathThroughLaunchRule: question("cancels-launch"),
  collisionGeometryRule: question(
    "static-directed-finite-segment-with-inclusive-start-cap-corridor-and-end-cap",
  ),
  corridorHalfWidthMillitiles: question(250),
  damageApplicationRule: question(
    "one-full-base-damage-hit-per-eligible-intersection",
  ),
  eventOrderRule: question(
    "commands-then-launch-or-cancel;impact-hit-order-then-damage-order-then-id-sorted-deaths-then-complete",
  ),
  hitOrderRule: question(
    "forward-segment-parameter-then-stable-id",
  ),
  interruptionAfterLaunchRule: question("launched-shot-continues"),
  interruptionThroughLaunchRule: question("cancels-launch"),
  movingCollisionRule: question("launch-time-position-snapshot"),
  oneHitRule: question("at-most-once-per-target"),
  pierceLengthMillitiles: question(11_000),
  projectionRule: question(
    "integer-endpoint-from-exact-integer-direction-magnitude",
  ),
  projectileSpeedMillitilesPerTick: question(1000),
  sameBoundaryRule: question(
    "commands-resolve-before-launch-and-impact",
  ),
  targetDeathRule: question("dead-before-impact-is-ineligible"),
  targetEligibilityRule: question(
    "alive-targetable-ground-or-air-troops-and-structures",
  ),
});

const ATTACKER_ID = 101;
const ATTACKER_MAX_HEALTH = DEFINITIONS[0].hitpoints;
const ORIGIN = Object.freeze({ x: 1000, y: 4000 });
const LAUNCH_TICK = DEFINITIONS[0].firstHitTicks;
const FLIGHT_TICKS = Math.ceil(
  QUESTION_FIXTURES.pierceLengthMillitiles.value /
    QUESTION_FIXTURES.projectileSpeedMillitilesPerTick.value,
);
const IMPACT_TICK = LAUNCH_TICK + FLIGHT_TICKS;
const MAX_TICK = IMPACT_TICK + 1;
const MAX_CANDIDATES = 32;
const MAX_COMMANDS = 16;
const MAX_REPLAY_EVENTS = 128;
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

function checkedAim(value) {
  const aim = exactRecord(value, AIM_KEYS, "pierce aim");
  for (const key of AIM_KEYS) {
    if (
      !Number.isSafeInteger(aim[key]) ||
      Math.abs(aim[key]) > MAX_SPATIAL_MILLITILES
    ) {
      throw new TypeError(
        `pierce aim.${key} must be a safe integer within spatial bounds`,
      );
    }
  }
  if (aim.x === 0 && aim.y === 0) {
    throw new TypeError("pierce aim must not be a zero vector");
  }
  return { x: aim.x, y: aim.y };
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

function projectedSegment(aim) {
  const x = BigInt(aim.x);
  const y = BigInt(aim.y);
  const magnitudeSquared = x * x + y * y;
  const magnitude = integerSquareRoot(magnitudeSquared);
  if (magnitude * magnitude !== magnitudeSquared) {
    throw new TypeError("pierce aim magnitude must be an exact integer");
  }
  const length = BigInt(QUESTION_FIXTURES.pierceLengthMillitiles.value);
  const scaledX = x * length;
  const scaledY = y * length;
  if (scaledX % magnitude !== 0n || scaledY % magnitude !== 0n) {
    throw new TypeError("pierce aim projection must produce an integer endpoint");
  }
  const dx = scaledX / magnitude;
  const dy = scaledY / magnitude;
  const endX = BigInt(ORIGIN.x) + dx;
  const endY = BigInt(ORIGIN.y) + dy;
  const bound = BigInt(MAX_SPATIAL_MILLITILES);
  if (
    endX < -bound ||
    endX > bound ||
    endY < -bound ||
    endY > bound
  ) {
    throw new RangeError("pierce endpoint exceeds spatial bounds");
  }
  return {
    direction: { x: Number(dx), y: Number(dy) },
    endpoint: { x: Number(endX), y: Number(endY) },
  };
}

function checkedCandidate(value, index) {
  const label = `pierce candidate ${index}`;
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
    throw new TypeError("pierce candidate ID collides with the attacker");
  }
  return { ...candidate, maxHealth: raw.maxHealth };
}

function checkedCandidates(value) {
  const candidates = denseArray(
    value,
    MAX_CANDIDATES,
    "pierce candidates",
  ).map(checkedCandidate).sort((left, right) => left.id - right.id);
  for (let index = 1; index < candidates.length; index += 1) {
    if (candidates[index - 1].id === candidates[index].id) {
      throw new TypeError("pierce candidates must have unique IDs");
    }
  }
  return candidates;
}

function checkedCommands(value, candidateIds) {
  const commands = denseArray(value, MAX_COMMANDS, "pierce commands")
    .map((entry, index) => {
      const command = exactRecord(
        entry,
        COMMAND_KEYS,
        `pierce command ${index}`,
      );
      if (!COMMAND_TYPES.has(command.type)) {
        throw new TypeError(`pierce command ${index}.type is invalid`);
      }
      if (
        !Number.isSafeInteger(command.tick) ||
        command.tick < 0 ||
        command.tick > IMPACT_TICK
      ) {
        throw new TypeError(`pierce command ${index}.tick is invalid`);
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
    if (
      commands[index - 1].tick === commands[index].tick &&
      commands[index - 1].type === commands[index].type &&
      commands[index - 1].targetId === commands[index].targetId
    ) {
      throw new TypeError("pierce commands must be unique");
    }
  }
  return commands;
}

function checkedSetup(value) {
  const setup = exactRecord(value, SETUP_KEYS, "pierce setup");
  const aim = checkedAim(setup.aim);
  projectedSegment(aim);
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
  return [
    {
      alive: true,
      id: 201,
      kind: "troop",
      layer: "ground",
      maxHealth: 500,
      position: { x: 3000, y: 4000 },
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
      position: { x: 12_000, y: 4000 },
      radius: 0,
      targetable: true,
    },
  ];
}

function deepFrozenQuestionCopy() {
  return Object.freeze(Object.fromEntries(
    Object.entries(QUESTION_FIXTURES).map(([key, record]) => [
      key,
      Object.freeze({ ...record }),
    ]),
  ));
}

function collisionOrder(candidate, segment) {
  const px = BigInt(candidate.position.x) - BigInt(ORIGIN.x);
  const py = BigInt(candidate.position.y) - BigInt(ORIGIN.y);
  const dx = BigInt(segment.direction.x);
  const dy = BigInt(segment.direction.y);
  const lengthSquared = dx * dx + dy * dy;
  const dot = px * dx + py * dy;

  const reach =
    BigInt(QUESTION_FIXTURES.corridorHalfWidthMillitiles.value) +
    BigInt(candidate.radius);
  if (dot < 0n) {
    if (px * px + py * py > reach * reach) return null;
  } else if (dot <= lengthSquared) {
    const cross = px * dy - py * dx;
    if (cross * cross > reach * reach * lengthSquared) return null;
  } else {
    const ex = BigInt(candidate.position.x) - BigInt(segment.endpoint.x);
    const ey = BigInt(candidate.position.y) - BigInt(segment.endpoint.y);
    if (ex * ex + ey * ey > reach * reach) return null;
  }
  return dot;
}

/**
 * Returns the original Prism Warden runtime definition. External comparison
 * mappings belong to tests and are never part of shipped content.
 */
export function createPierceSpecialCatalog() {
  return createCardCatalog(DEFINITIONS);
}

/**
 * Returns independently frozen QUESTION records for every through-shot number
 * and policy absent from the common content corpus.
 */
export function createPierceQuestionFixture(...args) {
  if (args.length !== 0) {
    throw new TypeError("pierce question fixture does not accept overrides");
  }
  return deepFrozenQuestionCopy();
}

/** Creates a validated, isolated, bounded encounter fixture. */
export function createPierceSpecialFixture(
  candidates = defaultCandidates(),
  aim = { x: 1, y: 0 },
  commands = [],
  ...extra
) {
  if (extra.length !== 0) {
    throw new TypeError("pierce fixture received extra arguments");
  }
  return clone(checkedSetup({ aim, candidates, commands }));
}

/**
 * One deterministic linear through-shot over launch-time candidate geometry.
 *
 * The directed finite segment is constructed only when an integer aim
 * magnitude produces an exact integer endpoint. Intersection comparisons use
 * BigInt dot, cross, and squared-distance arithmetic. Forward corridor and
 * start and terminal cap boundaries are inclusive. Intersections resolve by
 * segment parameter and then stable ID.
 *
 * This is not an authoritative collision-geometry, length, width, speed,
 * moving-collision, simultaneous-event, interruption, death, obstacle,
 * projectile-height, animation, visual, audio, or full-match parity claim.
 */
export class PierceEncounter {
  #candidates;
  #commands;
  #commandIndex = 0;
  #damage = new DamageSystem();
  #feed = createCombatEffectFeed();
  #feedRoot = null;
  #history = [];
  #interrupted = false;
  #launched = false;
  #setup;
  #terminal = false;
  #tick = 0;

  constructor(setup = createPierceSpecialFixture()) {
    this.#setup = checkedSetup(setup);
    this.#candidates = this.#setup.candidates;
    this.#commands = this.#setup.commands;
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
    return PierceEncounter.restore(this.serialize());
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
      hitTargetIds: this.#history
        .filter(({ type }) => type === "pierce-hit")
        .map(({ targetId }) => targetId),
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
      if (
        this.#damage.get(ATTACKER_ID).dead ||
        this.#interrupted
      ) {
        this.#complete(events, boundary, "launch-cancelled");
      } else {
        this.#launched = true;
        const segment = projectedSegment(this.#setup.aim);
        events.push({
          endpoint: segment.endpoint,
          impactTick: IMPACT_TICK,
          origin: { ...ORIGIN },
          tick: boundary,
          type: "pierce-launch",
        });
      }
    } else if (boundary === IMPACT_TICK && this.#launched) {
      this.#impact(boundary, events);
    }

    this.#tick += 1;
    this.#observeVisualEvents(events);
    if (this.#history.length + events.length > MAX_REPLAY_EVENTS) {
      throw new RangeError("pierce replay exceeds its event bound");
    }
    this.#history.push(...events);
    return clone(events);
  }

  stepMany(ticks) {
    if (!Number.isSafeInteger(ticks) || ticks < 0) {
      throw new TypeError("pierce ticks must be a non-negative safe integer");
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
        "pierce tick limit must be a non-negative safe integer",
      );
    }
    if (tickLimit > MAX_TICK) {
      throw new RangeError("pierce tick limit exceeds its bound");
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
      throw new RangeError("pierce snapshot exceeds its size bound");
    }
    return serialized;
  }

  static restore(serialized) {
    if (typeof serialized !== "string") {
      throw new TypeError("pierce snapshot must be a string");
    }
    if (serialized.length > MAX_SNAPSHOT_BYTES) {
      throw new RangeError("pierce snapshot exceeds its size bound");
    }
    let raw;
    try {
      raw = JSON.parse(serialized);
    } catch {
      throw new TypeError("pierce snapshot must be valid JSON");
    }
    const snapshot = exactRecord(raw, SNAPSHOT_KEYS, "pierce snapshot");
    if (snapshot.version !== 1) {
      throw new TypeError("pierce snapshot version is unsupported");
    }
    if (
      !Number.isSafeInteger(snapshot.tick) ||
      snapshot.tick < 0 ||
      snapshot.tick > MAX_TICK
    ) {
      throw new TypeError("pierce snapshot.tick is invalid");
    }
    const encounter = new PierceEncounter(snapshot.identity);
    encounter.stepMany(snapshot.tick);
    if (encounter.#tick !== snapshot.tick) {
      throw new TypeError("pierce snapshot contains post-terminal time");
    }
    return encounter;
  }

  #complete(events, tick, reason) {
    this.#terminal = true;
    events.push({
      hitTargetIds: [
        ...this.#history,
        ...events,
      ].filter(({ type }) => type === "pierce-hit")
        .map(({ targetId }) => targetId),
      reason,
      tick,
      type: "pierce-complete",
    });
  }

  #observeVisualEvents(events) {
    for (const event of events) {
      if (event.type === "pierce-launch") {
        const root = appendCombatEffectRoot(this.#feed, {
          direction: "pierce",
          effectId: null,
          from: event.origin,
          impactTick: event.impactTick,
          projectileId: null,
          radius: QUESTION_FIXTURES.corridorHalfWidthMillitiles.value,
          segments: [],
          sequence: 1,
          sourceId: ATTACKER_ID,
          tick: event.tick,
          to: event.endpoint,
          type: "projectile",
        });
        this.#feedRoot = { lastEventId: root.eventId, rootId: root.rootId };
        continue;
      }
      if (this.#feedRoot === null) continue;
      if (event.type === "pierce-hit") {
        const candidate = this.#candidates.find(({ id }) => id === event.targetId);
        const child = appendCombatEffectEvent(this.#feed, {
          parentId: this.#feedRoot.lastEventId,
          payload: {
            point: candidate?.position ?? ORIGIN,
            status: "contact",
            subId: null,
            targetId: event.targetId,
          },
          phase: "contact",
          rootId: this.#feedRoot.rootId,
          tick: event.tick,
          type: "projectile",
        });
        this.#feedRoot.lastEventId = child.eventId;
      } else if (event.type === "pierce-damage") {
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
      } else if (event.type === "pierce-death") {
        const child = appendCombatEffectEvent(this.#feed, {
          parentId: this.#feedRoot.lastEventId,
          payload: { targetId: event.targetId },
          phase: "death",
          rootId: this.#feedRoot.rootId,
          tick: event.tick,
          type: "projectile",
        });
        this.#feedRoot.lastEventId = child.eventId;
      } else if (event.type === "pierce-complete") {
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
    const segment = projectedSegment(this.#setup.aim);
    const hits = this.#candidates
      .map((candidate) => ({
        candidate,
        parameter: collisionOrder(candidate, segment),
      }))
      .filter(({ candidate, parameter }) =>
        parameter !== null &&
        candidate.targetable &&
        !this.#damage.get(candidate.id).dead
      )
      .sort((left, right) =>
        left.parameter < right.parameter
          ? -1
          : left.parameter > right.parameter
          ? 1
          : left.candidate.id - right.candidate.id
      );

    for (const { candidate, parameter } of hits) {
      events.push({
        parameterNumerator: parameter.toString(),
        targetId: candidate.id,
        tick,
        type: "pierce-hit",
      });
    }
    const batch = this.#damage.damageSimultaneously(
      hits.map(({ candidate }) => ({
        amount: DEFINITIONS[0].damage,
        targetId: candidate.id,
      })),
    );
    events.push(...batch.events.map((event) => ({
      ...event,
      tick,
      type: `pierce-${event.type}`,
    })));
    this.#complete(events, tick, "impact-resolved");
  }

  #resolveCommands(tick, events) {
    while (this.#commands[this.#commandIndex]?.tick === tick) {
      const command = this.#commands[this.#commandIndex];
      this.#commandIndex += 1;
      events.push({
        targetId: command.type === "kill-target"
          ? command.targetId
          : ATTACKER_ID,
        tick,
        type: "pierce-command",
        value: command.type,
      });
      if (command.type === "interrupt-attacker") {
        this.#interrupted = true;
      } else {
        const targetId = command.type === "kill-attacker"
          ? ATTACKER_ID
          : command.targetId;
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
