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
  id: "rune-reaver",
  displayName: "Rune Reaver",
  cost: 5,
  kind: "unit",
  rarity: "special",
  hitpoints: 1280,
  damage: 169,
  hitSpeedTicks: 54,
  firstHitTicks: 24,
  deployTimeTicks: 60,
  rangeMillitiles: 4500,
  sightRangeMillitiles: 5500,
  movementMillitilesPerSecond: 1000,
  targetMode: "ground-and-air",
  count: 1,
  areaDamageRadiusMillitiles: null,
  components: [],
}];

const QUESTION_SOURCE = "unsourced-outbound-returning-projectile-fixture";

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
  attackerDeathAfterLaunchRule: question("launched-projectile-continues"),
  attackerDeathThroughLaunchRule: question("cancels-launch"),
  collisionGeometryRule: question(
    "static-directed-finite-segment-with-inclusive-start-cap-corridor-and-end-cap",
  ),
  collisionWidthMillitiles: question(250),
  damagePerPass: question(169),
  damagePerPassRule: question("full-base-damage-on-each-leg"),
  eventOrderRule: question(
    "commands;launch;outbound-hits-near-to-far;turn;inbound-hits-far-to-near;complete",
  ),
  inboundTimingRule: question("first-inbound-travel-boundary-is-after-turn"),
  interruptionAfterLaunchRule: question("launched-projectile-continues"),
  interruptionThroughLaunchRule: question("cancels-launch"),
  launchTimingTicks: question(24),
  movingTargetRule: question("launch-time-position-snapshot"),
  obstacleRule: question("obstacles-not-modeled-static-segment-unblocked"),
  oneHitPerLegRule: question("at-most-once-per-target-per-leg"),
  projectileSpeedMillitilesPerTick: question(1000),
  sameBoundaryRule: question("commands-resolve-before-projectile-events"),
  targetDeathRule: question("dead-before-pass-contact-is-ineligible"),
  targetEligibilityRule: question(
    "alive-targetable-ground-or-air-troops-and-structures",
  ),
  turnDistanceMillitiles: question(7000),
  turnaroundTimingRule: question("turn-after-outbound-contacts-at-end-boundary"),
});

const ATTACKER_ID = 101;
const ATTACKER_MAX_HEALTH = DEFINITIONS[0].hitpoints;
const ORIGIN = Object.freeze({ x: 1000, y: 4000 });
const LAUNCH_TICK = QUESTION_FIXTURES.launchTimingTicks.value;
const LEG_TICKS = Math.ceil(
  QUESTION_FIXTURES.turnDistanceMillitiles.value /
    QUESTION_FIXTURES.projectileSpeedMillitilesPerTick.value,
);
const TURN_TICK = LAUNCH_TICK + LEG_TICKS;
const COMPLETE_TICK = TURN_TICK + LEG_TICKS;
const MAX_TICK = COMPLETE_TICK + 1;
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

function checkedAim(value) {
  const aim = exactRecord(value, AIM_KEYS, "return aim");
  for (const key of AIM_KEYS) {
    if (
      !Number.isSafeInteger(aim[key]) ||
      Math.abs(aim[key]) > MAX_SPATIAL_MILLITILES
    ) {
      throw new TypeError(
        `return aim.${key} must be a safe integer within spatial bounds`,
      );
    }
  }
  if (aim.x === 0 && aim.y === 0) {
    throw new TypeError("return aim must not be a zero vector");
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

function projectedTurn(aim) {
  const x = BigInt(aim.x);
  const y = BigInt(aim.y);
  const magnitudeSquared = x * x + y * y;
  const magnitude = integerSquareRoot(magnitudeSquared);
  if (magnitude * magnitude !== magnitudeSquared) {
    throw new TypeError("return aim magnitude must be an exact integer");
  }
  const distance = BigInt(QUESTION_FIXTURES.turnDistanceMillitiles.value);
  const scaledX = x * distance;
  const scaledY = y * distance;
  if (scaledX % magnitude !== 0n || scaledY % magnitude !== 0n) {
    throw new TypeError("return aim projection must produce an integer turn point");
  }
  const dx = scaledX / magnitude;
  const dy = scaledY / magnitude;
  const turnX = BigInt(ORIGIN.x) + dx;
  const turnY = BigInt(ORIGIN.y) + dy;
  const bound = BigInt(MAX_SPATIAL_MILLITILES);
  if (
    turnX < -bound || turnX > bound ||
    turnY < -bound || turnY > bound
  ) {
    throw new RangeError("return turn point exceeds spatial bounds");
  }
  return {
    direction: { x: Number(dx), y: Number(dy) },
    turnPoint: { x: Number(turnX), y: Number(turnY) },
  };
}

function checkedCandidate(value, index) {
  const label = `return candidate ${index}`;
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
    throw new TypeError("return candidate ID collides with the attacker");
  }
  return { ...candidate, maxHealth: raw.maxHealth };
}

function checkedCandidates(value) {
  const candidates = denseArray(
    value,
    MAX_CANDIDATES,
    "return candidates",
  ).map(checkedCandidate).sort((left, right) => left.id - right.id);
  for (let index = 1; index < candidates.length; index += 1) {
    if (candidates[index - 1].id === candidates[index].id) {
      throw new TypeError("return candidates must have unique IDs");
    }
  }
  return candidates;
}

function checkedCommands(value, candidateIds) {
  const commands = denseArray(value, MAX_COMMANDS, "return commands")
    .map((entry, index) => {
      const command = exactRecord(entry, COMMAND_KEYS, `return command ${index}`);
      if (!COMMAND_TYPES.has(command.type)) {
        throw new TypeError(`return command ${index}.type is invalid`);
      }
      if (
        !Number.isSafeInteger(command.tick) ||
        command.tick < 0 ||
        command.tick > COMPLETE_TICK
      ) {
        throw new TypeError(`return command ${index}.tick is invalid`);
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
      throw new TypeError("return commands must be unique");
    }
  }
  return commands;
}

function checkedSetup(value) {
  const setup = exactRecord(value, SETUP_KEYS, "return setup");
  const aim = checkedAim(setup.aim);
  projectedTurn(aim);
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
      position: { x: 6000, y: 4000 },
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

function pointAlong(start, direction, travelled) {
  const distance = BigInt(QUESTION_FIXTURES.turnDistanceMillitiles.value);
  const amount = BigInt(travelled);
  const x = BigInt(start.x) + BigInt(direction.x) * amount / distance;
  const y = BigInt(start.y) + BigInt(direction.y) * amount / distance;
  return { x: Number(x), y: Number(y) };
}

function segmentParameter(candidate, start, end) {
  const px = BigInt(candidate.position.x) - BigInt(start.x);
  const py = BigInt(candidate.position.y) - BigInt(start.y);
  const dx = BigInt(end.x) - BigInt(start.x);
  const dy = BigInt(end.y) - BigInt(start.y);
  return px * dx + py * dy;
}

function capsuleIntersects(candidate, start, end) {
  const px = BigInt(candidate.position.x) - BigInt(start.x);
  const py = BigInt(candidate.position.y) - BigInt(start.y);
  const dx = BigInt(end.x) - BigInt(start.x);
  const dy = BigInt(end.y) - BigInt(start.y);
  const lengthSquared = dx * dx + dy * dy;
  const reach =
    BigInt(QUESTION_FIXTURES.collisionWidthMillitiles.value) +
    BigInt(candidate.radius);
  if (lengthSquared === 0n) {
    return px * px + py * py <= reach * reach;
  }
  const dot = px * dx + py * dy;
  if (dot <= 0n) return px * px + py * py <= reach * reach;
  if (dot >= lengthSquared) {
    const ex = BigInt(candidate.position.x) - BigInt(end.x);
    const ey = BigInt(candidate.position.y) - BigInt(end.y);
    return ex * ex + ey * ey <= reach * reach;
  }
  const cross = px * dy - py * dx;
  return cross * cross <= reach * reach * lengthSquared;
}

export function createReturnSpecialCatalog() {
  return createCardCatalog(DEFINITIONS);
}

export function createReturnQuestionFixture(...args) {
  if (args.length !== 0) {
    throw new TypeError("return question fixture does not accept overrides");
  }
  return deepFrozenQuestionCopy();
}

export function createReturnSpecialFixture(
  candidates = defaultCandidates(),
  aim = { x: 1, y: 0 },
  commands = [],
  ...extra
) {
  if (extra.length !== 0) {
    throw new TypeError("return fixture received extra arguments");
  }
  return clone(checkedSetup({ aim, candidates, commands }));
}

/**
 * One deterministic outbound-and-returning projectile over launch-time,
 * finite-segment candidate geometry. BigInt dot, cross, and squared-distance
 * comparisons make corridor and both cap boundaries exact and inclusive.
 *
 * This is not an authoritative return distance, collision width, speed,
 * launch, turn or inbound timing, damage-per-pass, one-hit, event-order,
 * moving-target, obstacle, eligibility, interruption, death, projectile-height,
 * animation, visual, audio, or full-match parity claim.
 */
export class ReturnEncounter {
  #candidates;
  #commands;
  #commandIndex = 0;
  #damage = new DamageSystem();
  #feed = createCombatEffectFeed();
  #feedRoot = null;
  #history = [];
  #interrupted = false;
  #launched = false;
  #outboundHitIds = [];
  #inboundHitIds = [];
  #setup;
  #terminal = false;
  #tick = 0;

  constructor(setup = createReturnSpecialFixture()) {
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
    return ReturnEncounter.restore(this.serialize());
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
      inboundHitIds: this.#inboundHitIds,
      interrupted: this.#interrupted,
      launched: this.#launched,
      outboundHitIds: this.#outboundHitIds,
      phase: this.#phase(),
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
        const { turnPoint } = projectedTurn(this.#setup.aim);
        events.push({
          attackerId: ATTACKER_ID,
          completeTick: COMPLETE_TICK,
          origin: { ...ORIGIN },
          tick: boundary,
          turnPoint,
          turnTick: TURN_TICK,
          type: "return-launch",
        });
        this.#resolveLeg("outbound", boundary, events);
      }
    } else if (this.#launched && boundary <= TURN_TICK) {
      this.#resolveLeg("outbound", boundary, events);
      if (boundary === TURN_TICK) {
        events.push({
          tick: boundary,
          turnPoint: projectedTurn(this.#setup.aim).turnPoint,
          type: "return-turn",
        });
      }
    } else if (this.#launched && boundary <= COMPLETE_TICK) {
      this.#resolveLeg("inbound", boundary, events);
      if (boundary === COMPLETE_TICK) {
        this.#complete(events, boundary, "returned-to-origin");
      }
    }

    this.#tick += 1;
    this.#observeVisualEvents(events);
    if (this.#history.length + events.length > MAX_REPLAY_EVENTS) {
      throw new RangeError("return replay exceeds its event bound");
    }
    this.#history.push(...events);
    return clone(events);
  }

  stepMany(ticks) {
    if (!Number.isSafeInteger(ticks) || ticks < 0) {
      throw new TypeError("return ticks must be a non-negative safe integer");
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
      throw new TypeError("return tick limit must be a non-negative safe integer");
    }
    if (tickLimit > MAX_TICK) {
      throw new RangeError("return tick limit exceeds its bound");
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
      throw new RangeError("return snapshot exceeds its size bound");
    }
    return serialized;
  }

  static restore(serialized) {
    if (typeof serialized !== "string") {
      throw new TypeError("return snapshot must be a string");
    }
    if (serialized.length > MAX_SNAPSHOT_BYTES) {
      throw new RangeError("return snapshot exceeds its size bound");
    }
    let raw;
    try {
      raw = JSON.parse(serialized);
    } catch {
      throw new TypeError("return snapshot must be valid JSON");
    }
    const snapshot = exactRecord(raw, SNAPSHOT_KEYS, "return snapshot");
    if (snapshot.version !== 1) {
      throw new TypeError("return snapshot version is unsupported");
    }
    if (
      !Number.isSafeInteger(snapshot.tick) ||
      snapshot.tick < 0 ||
      snapshot.tick > MAX_TICK
    ) {
      throw new TypeError("return snapshot.tick is invalid");
    }
    const encounter = new ReturnEncounter(snapshot.identity);
    encounter.stepMany(snapshot.tick);
    if (encounter.#tick !== snapshot.tick) {
      throw new TypeError("return snapshot contains post-terminal time");
    }
    return encounter;
  }

  #complete(events, tick, reason) {
    this.#terminal = true;
    events.push({
      inboundHitIds: [...this.#inboundHitIds],
      outboundHitIds: [...this.#outboundHitIds],
      reason,
      tick,
      type: "return-complete",
    });
  }

  #observeVisualEvents(events) {
    for (const event of events) {
      if (event.type === "return-launch") {
        const root = appendCombatEffectRoot(this.#feed, {
          direction: "return",
          effectId: null,
          from: event.origin,
          impactTick: event.completeTick,
          projectileId: null,
          radius: QUESTION_FIXTURES.collisionWidthMillitiles.value,
          segments: [],
          sequence: 1,
          sourceId: ATTACKER_ID,
          tick: event.tick,
          to: event.turnPoint,
          type: "projectile",
        });
        this.#feedRoot = { lastEventId: root.eventId, rootId: root.rootId };
        continue;
      }
      if (this.#feedRoot === null) continue;
      if (event.type === "return-turn") {
        const child = appendCombatEffectEvent(this.#feed, {
          parentId: this.#feedRoot.lastEventId,
          payload: { point: event.turnPoint },
          phase: "turn",
          rootId: this.#feedRoot.rootId,
          tick: event.tick,
          type: "projectile",
        });
        this.#feedRoot.lastEventId = child.eventId;
      } else if (event.type === "return-hit") {
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
      } else if (event.type === "return-damage") {
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
      } else if (event.type === "return-death") {
        const child = appendCombatEffectEvent(this.#feed, {
          parentId: this.#feedRoot.lastEventId,
          payload: { targetId: event.targetId },
          phase: "death",
          rootId: this.#feedRoot.rootId,
          tick: event.tick,
          type: "projectile",
        });
        this.#feedRoot.lastEventId = child.eventId;
      } else if (event.type === "return-complete") {
        const reason = event.reason === "returned-to-origin" ? "complete" : event.reason;
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

  #phase() {
    if (this.#terminal) return "terminal";
    if (!this.#launched) return "prelaunch";
    if (this.#tick < TURN_TICK) return "outbound";
    if (this.#tick === TURN_TICK) return "turn";
    return "inbound";
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
        type: "return-command",
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

  #resolveLeg(leg, tick, events) {
    const projected = projectedTurn(this.#setup.aim);
    const outbound = leg === "outbound";
    const elapsed = outbound ? tick - LAUNCH_TICK : tick - TURN_TICK;
    if (elapsed < 0 || (!outbound && elapsed === 0)) return;
    const travelled = Math.min(
      QUESTION_FIXTURES.turnDistanceMillitiles.value,
      elapsed * QUESTION_FIXTURES.projectileSpeedMillitilesPerTick.value,
    );
    const start = outbound ? ORIGIN : projected.turnPoint;
    const direction = outbound
      ? projected.direction
      : { x: -projected.direction.x, y: -projected.direction.y };
    const end = pointAlong(start, direction, travelled);
    const legEnd = outbound ? projected.turnPoint : ORIGIN;
    const hitIds = outbound ? this.#outboundHitIds : this.#inboundHitIds;
    const hits = this.#candidates
      .filter((candidate) =>
        !hitIds.includes(candidate.id) &&
        candidate.targetable &&
        !this.#damage.get(candidate.id).dead &&
        capsuleIntersects(candidate, start, end)
      )
      .map((candidate) => ({
        candidate,
        parameter: segmentParameter(candidate, start, legEnd),
      }))
      .sort((left, right) =>
        left.parameter < right.parameter
          ? -1
          : left.parameter > right.parameter
          ? 1
          : left.candidate.id - right.candidate.id
      );

    for (const { candidate, parameter } of hits) {
      hitIds.push(candidate.id);
      events.push({
        leg,
        parameterNumerator: parameter.toString(),
        pass: outbound ? 1 : 2,
        targetId: candidate.id,
        tick,
        type: "return-hit",
      });
      const result = this.#damage.damage(
        candidate.id,
        QUESTION_FIXTURES.damagePerPass.value,
      );
      events.push(...result.events.map((event) => ({
        ...event,
        leg,
        pass: outbound ? 1 : 2,
        tick,
        type: `return-${event.type}`,
      })));
    }
  }
}
