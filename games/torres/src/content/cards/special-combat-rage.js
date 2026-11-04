import { createCardCatalog } from "../schema.js";

const CARD_DEFINITIONS = [{
  areaDamageRadiusMillitiles: 3000,
  components: [],
  cost: 2,
  count: 1,
  damage: 192,
  deployTimeTicks: 0,
  displayName: "Tempo Field",
  firstHitTicks: null,
  hitSpeedTicks: null,
  hitpoints: null,
  id: "tempo-field",
  kind: "effect",
  movementMillitilesPerSecond: null,
  rangeMillitiles: null,
  rarity: "mythic",
  sightRangeMillitiles: null,
  targetMode: "ground-and-air",
}];

const SOURCE = "unsourced-timed-movement-and-attack-rage-fixture";
const FIXTURE_ID = "timed-movement-and-attack-rage-question-v1";
const MAX_COMMANDS = 96;
const MAX_EVENTS = 16384;
const MAX_POSITION = 100_000;
const MAX_SNAPSHOT_BYTES = 1048576;
const MAX_STEP_CHUNK = 4096;
const MAX_TICK = 4096;
const BASE_RATE = 80n;
const RAGE_RATE = 140n;
const SLOW_RATE = 52n;
const COMPOSED_RATE = 91n;
const MOVEMENT_DENOMINATOR = 4800n;
const MOVEMENT_SPEED = 1000n;
const WINDUP_WORK = 5760;
const CONTACT_WORK = 160;
const CADENCE_WORK = 8160;
const RAGE_DURATION_TICKS = 90;
const SLOW_DURATION_TICKS = 60;

const COMMAND_KEYS = ["sourceId", "targetId", "tick", "type"];
const COMMAND_TYPES = new Set([
  "acquire-target",
  "die",
  "interrupt",
  "lose-target",
  "accelerate",
  "slow",
  "target-died",
]);
const SETUP_KEYS = ["commands", "direction"];
const SNAPSHOT_KEYS = ["identity", "state", "version"];
const IDENTITY_KEYS = ["commands", "direction", "fixture"];
const STATE_KEYS = [
  "alive", "attackPhase", "attackSequence", "attackWork", "commandIndex",
  "history", "movementRemainder", "pendingAttack", "position",
  "boostSourceId", "boostUntilTick", "slowSourceId", "slowUntilTick",
  "targetId", "tick",
];
const PENDING_KEYS = ["sequence", "targetId"];
const EVENT_KEYS = {
  "attack-contact": ["sequence", "targetId", "tick", "type"],
  "attack-launched": ["sequence", "targetId", "tick", "type"],
  died: ["tick", "type"],
  interrupted: ["targetId", "tick", "type"],
  moved: ["delta", "from", "rate", "remainder", "tick", "to", "type"],
  "rage-applied": ["sourceId", "tick", "type", "untilTick"],
  "rage-expired": ["sourceId", "tick", "type"],
  "slow-applied": ["sourceId", "tick", "type", "untilTick"],
  "slow-expired": ["sourceId", "tick", "type"],
  "target-acquired": ["targetId", "tick", "type"],
  "target-died": ["targetId", "tick", "type"],
  "target-lost": ["targetId", "tick", "type"],
};

const QUESTION_VALUES = Object.freeze({
  applyBoundary: "command-boundary-immediate-before-ready-contact-and-work",
  attackMultiplier: { denominator: 4, numerator: 7 },
  attackWorkRate: "same-exact-rational-rate-as-movement",
  boundaryOrdering:
    "expire-rage-then-expire-slow-then-commands-in-input-order-then-ready-or-contact-then-movement-and-attack-work-then-tick",
  cadenceWorkUnits: CADENCE_WORK,
  commonAreaDamageRadius: 3000,
  commonBaseDamage: 192,
  commonCount: 1,
  commonDeployTicks: 0,
  commonFirstHitTicks: null,
  commonHitCadenceTicks: null,
  commonHitpoints: null,
  commonMovementMillitilesPerSecond: null,
  commonRangeMillitiles: null,
  commonSightRangeMillitiles: null,
  commonTargetMode: "ground-and-air",
  contactDelayTicks: 2,
  contactRageApplication: "application-before-contact-advances-retained-contact-work",
  deathPolicy: "unit-death-clears-target-attack-pending-contact-rage-and-slow",
  delivery: "explicit-boundary-command-no-area-delivery-claim",
  differentSourceRefresh: "latest-command-replaces-source-and-refreshes-full-duration",
  durationTicks: RAGE_DURATION_TICKS,
  eligibility: "living-unit-explicit-command-positive-safe-source-id",
  expiryBoundaryReapply: "expiry-event-precedes-same-boundary-new-application",
  expiryWindow: "application-tick-through-application-plus-89-inclusive",
  fidelity: "isolated-question-fixture-not-a-general-buff-or-spell-system",
  idleApplication: "status-runs-and-movement-accelerates-with-no-target",
  interruptionPolicy:
    "command-first-interruption-cancels-pending-contact-and-restarts-full-windup-for-retained-target",
  movementMultiplier: { denominator: 4, numerator: 7 },
  movementRemainder: "retained-across-application-refresh-composition-and-expiry",
  nonStacking: "one-rage-slot-regardless-of-source",
  normalRateUnits: Number(BASE_RATE),
  rageRateUnits: Number(RAGE_RATE),
  readyApplication: "command-first-rage-does-not-cancel-already-earned-readiness",
  retainedAttackRemainder:
    "integer-work-retained-across-application-refresh-composition-and-expiry",
  sameSourceRefresh: "refresh-full-duration-and-retain-all-remainders",
  slowComposition:
    "multiplicative-rage-seven-fourths-times-slow-thirteen-twentieths-equals-ninety-one-eightieths",
  slowDurationTicks: SLOW_DURATION_TICKS,
  slowEligibility: "living-unit-explicit-command-positive-safe-source-id",
  slowMultiplier: { denominator: 20, numerator: 13 },
  slowNonStacking: "one-isolated-slow-slot-regardless-of-source",
  slowRefresh: "latest-command-replaces-source-and-refreshes-full-duration",
  sourceDeath: "active-status-persists-because-source-liveness-is-not-modeled",
  stack: "multiple-rage-commands-never-multiply-and-latest-command-wins",
  targetChange: "command-first-change-cancels-ready-or-contact-and-starts-full-windup",
  targetDeath: "command-first-matching-target-death-cancels-ready-or-contact",
  targetLoss: "command-first-loss-cancels-ready-or-contact",
  windupWorkUnits: WINDUP_WORK,
});

function deepFreeze(value) {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
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

function denseArray(value, label, maximum) {
  if (
    !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > maximum
  ) throw new TypeError(`${label} must be a bounded plain array`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(descriptors).length !== value.length + 1 ||
    Array.from({ length: value.length }, (_, index) => index).some(
      (index) => !descriptors[index]?.enumerable ||
        !Object.hasOwn(descriptors[index], "value"),
    )
  ) throw new TypeError(`${label} must contain dense data properties`);
  return Array.from({ length: value.length }, (_, index) =>
    descriptors[index].value);
}

function safeInteger(value, label, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label} must be a bounded safe integer`);
  }
}

function checkedId(value, label, nullable = false) {
  if (nullable && value === null) return;
  safeInteger(value, label, 1);
}

function checkedCommands(value) {
  const commands = denseArray(value, "rage commands", MAX_COMMANDS).map(
    (entry, index) => {
      const label = `rage command ${index}`;
      const command = exactRecord(entry, COMMAND_KEYS, label);
      safeInteger(command.tick, `${label}.tick`, 0, MAX_TICK - 1);
      if (!COMMAND_TYPES.has(command.type)) {
        throw new TypeError(`${label}.type is invalid`);
      }
      if (command.type === "accelerate" || command.type === "slow") {
        checkedId(command.sourceId, `${label}.sourceId`);
        if (command.targetId !== null) {
          throw new TypeError(`${label}.targetId must be null`);
        }
        const duration = command.type === "accelerate"
          ? RAGE_DURATION_TICKS : SLOW_DURATION_TICKS;
        if (command.tick > MAX_TICK - duration) {
          throw new TypeError(`${label}.tick cannot fit duration`);
        }
      } else if (command.type === "acquire-target") {
        checkedId(command.targetId, `${label}.targetId`);
        if (command.sourceId !== null) {
          throw new TypeError(`${label}.sourceId must be null`);
        }
      } else if (command.type === "target-died") {
        checkedId(command.targetId, `${label}.targetId`, true);
        if (command.sourceId !== null) {
          throw new TypeError(`${label}.sourceId must be null`);
        }
      } else if (command.sourceId !== null || command.targetId !== null) {
        throw new TypeError(`${label} has inapplicable IDs`);
      }
      return {
        sourceId: command.sourceId,
        targetId: command.targetId,
        tick: command.tick,
        type: command.type,
      };
    },
  );
  let prior = -1;
  for (const command of commands) {
    if (command.tick < prior) {
      throw new TypeError("rage commands must have nondecreasing ticks");
    }
    prior = command.tick;
  }
  return commands;
}

function checkedSetup(value) {
  const setup = exactRecord(value, SETUP_KEYS, "rage setup");
  if (setup.direction !== -1 && setup.direction !== 1) {
    throw new TypeError("rage setup.direction must be -1 or 1");
  }
  return { commands: checkedCommands(setup.commands), direction: setup.direction };
}

function initialState() {
  return {
    alive: true,
    attackPhase: "idle",
    attackSequence: 0,
    attackWork: null,
    commandIndex: 0,
    history: [],
    movementRemainder: 0,
    pendingAttack: null,
    position: 0,
    boostSourceId: null,
    boostUntilTick: null,
    slowSourceId: null,
    slowUntilTick: null,
    targetId: null,
    tick: 0,
  };
}

function clearTarget(state) {
  state.attackPhase = "idle";
  state.attackWork = null;
  state.pendingAttack = null;
  state.targetId = null;
}

function applyCommand(state, command, events) {
  if (command.type === "accelerate" || command.type === "slow") {
    if (!state.alive) return;
    const duration = command.type === "accelerate"
      ? RAGE_DURATION_TICKS : SLOW_DURATION_TICKS;
    const status = command.type === "accelerate" ? "boost" : "slow";
    state[`${status}SourceId`] = command.sourceId;
    state[`${status}UntilTick`] = state.tick + duration;
    events.push({
      sourceId: command.sourceId,
      tick: state.tick,
      type: command.type === "accelerate" ? "rage-applied" : "slow-applied",
      untilTick: state.tick + duration,
    });
    return;
  }
  if (command.type === "acquire-target") {
    if (!state.alive || state.targetId === command.targetId) return;
    clearTarget(state);
    state.targetId = command.targetId;
    state.attackPhase = "windup";
    state.attackWork = WINDUP_WORK;
    events.push({ targetId: command.targetId, tick: state.tick,
      type: "target-acquired" });
    return;
  }
  if (command.type === "lose-target") {
    if (state.targetId === null) return;
    const targetId = state.targetId;
    clearTarget(state);
    events.push({ targetId, tick: state.tick, type: "target-lost" });
    return;
  }
  if (command.type === "target-died") {
    if (state.targetId !== null &&
      (command.targetId === null || command.targetId === state.targetId)) {
      const targetId = state.targetId;
      clearTarget(state);
      events.push({ targetId, tick: state.tick, type: "target-died" });
    }
    return;
  }
  if (command.type === "interrupt") {
    if (!state.alive || state.targetId === null) return;
    const targetId = state.targetId;
    state.attackPhase = "windup";
    state.attackWork = WINDUP_WORK;
    state.pendingAttack = null;
    events.push({ targetId, tick: state.tick, type: "interrupted" });
    return;
  }
  if (state.alive) {
    state.alive = false;
    state.boostSourceId = null;
    state.boostUntilTick = null;
    state.slowSourceId = null;
    state.slowUntilTick = null;
    clearTarget(state);
    events.push({ tick: state.tick, type: "died" });
  }
}

function activeRate(state) {
  if (state.boostUntilTick !== null && state.slowUntilTick !== null) {
    return COMPOSED_RATE;
  }
  if (state.boostUntilTick !== null) return RAGE_RATE;
  if (state.slowUntilTick !== null) return SLOW_RATE;
  return BASE_RATE;
}

function expire(state, status, eventType, events) {
  const untilKey = `${status}UntilTick`;
  const sourceKey = `${status}SourceId`;
  if (state[untilKey] !== null && state.tick >= state[untilKey]) {
    events.push({
      sourceId: state[sourceKey],
      tick: state.tick,
      type: eventType,
    });
    state[sourceKey] = null;
    state[untilKey] = null;
  }
}

function uncheckedAdvance(state, commands, direction) {
  if (state.tick >= MAX_TICK) {
    throw new RangeError("rage encounter has reached its tick bound");
  }
  const tick = state.tick;
  const events = [];
  expire(state, "boost", "rage-expired", events);
  expire(state, "slow", "slow-expired", events);
  while (commands[state.commandIndex]?.tick === tick) {
    const command = commands[state.commandIndex];
    state.commandIndex += 1;
    applyCommand(state, command, events);
  }

  if (state.alive && state.targetId !== null && state.attackWork === 0) {
    if (state.attackPhase === "contact") {
      events.push({
        sequence: state.pendingAttack.sequence,
        targetId: state.pendingAttack.targetId,
        tick,
        type: "attack-contact",
      });
      state.pendingAttack = null;
      state.attackPhase = "cadence";
      state.attackWork = CADENCE_WORK;
    } else {
      state.attackSequence += 1;
      state.pendingAttack = {
        sequence: state.attackSequence,
        targetId: state.targetId,
      };
      events.push({
        sequence: state.attackSequence,
        targetId: state.targetId,
        tick,
        type: "attack-launched",
      });
      state.attackPhase = "contact";
      state.attackWork = CONTACT_WORK;
    }
  }

  if (state.alive) {
    const rate = activeRate(state);
    const accumulated = BigInt(state.movementRemainder) + MOVEMENT_SPEED * rate;
    const magnitude = accumulated / MOVEMENT_DENOMINATOR;
    const remainder = accumulated % MOVEMENT_DENOMINATOR;
    const deltaBig = BigInt(direction) * magnitude;
    const next = BigInt(state.position) + deltaBig;
    if (next < -BigInt(MAX_POSITION) || next > BigInt(MAX_POSITION)) {
      throw new RangeError("rage movement exceeds its position bound");
    }
    const from = state.position;
    state.position = Number(next);
    state.movementRemainder = Number(remainder);
    events.push({
      delta: Number(deltaBig),
      from,
      rate: Number(rate),
      remainder: state.movementRemainder,
      tick,
      to: state.position,
      type: "moved",
    });
    if (state.targetId !== null && state.attackWork > 0) {
      state.attackWork = Number(BigInt(state.attackWork) > rate
        ? BigInt(state.attackWork) - rate : 0n);
    }
  }
  if (state.history.length + events.length > MAX_EVENTS) {
    throw new RangeError("rage replay exceeds its event bound");
  }
  state.history.push(...clone(events));
  state.tick += 1;
  return events;
}

function checkedEvent(value, index) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`rage history event ${index} has an invalid shape`);
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, "type");
  if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) {
    throw new TypeError(`rage history event ${index}.type must be data`);
  }
  const keys = EVENT_KEYS[descriptor.value];
  if (keys === undefined) {
    throw new TypeError(`rage history event ${index}.type is invalid`);
  }
  const event = exactRecord(value, keys, `rage history event ${index}`);
  safeInteger(event.tick, `rage history event ${index}.tick`, 0, MAX_TICK - 1);
  for (const key of [
    "rate", "remainder", "sequence", "sourceId", "targetId", "untilTick",
  ]) {
    if (Object.hasOwn(event, key)) {
      safeInteger(event[key], `rage history event ${index}.${key}`,
        key === "remainder" ? 0 : 1);
    }
  }
  for (const key of ["delta", "from", "to"]) {
    if (Object.hasOwn(event, key)) {
      safeInteger(event[key] + MAX_POSITION,
        `rage history event ${index}.${key}`, 0, MAX_POSITION * 2);
    }
  }
  return event;
}

function checkedStateShape(value, commands, label) {
  const state = exactRecord(value, STATE_KEYS, label);
  if (typeof state.alive !== "boolean") {
    throw new TypeError(`${label}.alive must be boolean`);
  }
  safeInteger(state.tick, `${label}.tick`, 0, MAX_TICK);
  safeInteger(state.commandIndex, `${label}.commandIndex`, 0, commands.length);
  safeInteger(state.attackSequence, `${label}.attackSequence`, 0, MAX_EVENTS);
  safeInteger(state.position + MAX_POSITION, `${label}.position`, 0,
    MAX_POSITION * 2);
  safeInteger(state.movementRemainder, `${label}.movementRemainder`, 0,
    Number(MOVEMENT_DENOMINATOR - 1n));
  checkedId(state.targetId, `${label}.targetId`, true);
  checkedId(state.boostSourceId, `${label}.boostSourceId`, true);
  checkedId(state.slowSourceId, `${label}.slowSourceId`, true);
  if (!["idle", "windup", "contact", "cadence"].includes(state.attackPhase)) {
    throw new TypeError(`${label}.attackPhase is invalid`);
  }
  if (state.attackWork !== null) {
    safeInteger(state.attackWork, `${label}.attackWork`, 0, CADENCE_WORK);
  }
  for (const [status, duration] of [
    ["boost", RAGE_DURATION_TICKS],
    ["slow", SLOW_DURATION_TICKS],
  ]) {
    const until = state[`${status}UntilTick`];
    const source = state[`${status}SourceId`];
    if (until !== null) {
      safeInteger(until, `${label}.${status}UntilTick`, 1, MAX_TICK);
    }
    if ((source === null) !== (until === null)) {
      throw new TypeError(`${label} ${status} status is inconsistent`);
    }
    if (until !== null && (until < state.tick || until > state.tick + duration)) {
      throw new TypeError(`${label} ${status} expiry is noncausal`);
    }
  }
  let pendingAttack = null;
  if (state.pendingAttack !== null) {
    const pending = exactRecord(state.pendingAttack, PENDING_KEYS,
      `${label}.pendingAttack`);
    checkedId(pending.targetId, `${label}.pendingAttack.targetId`);
    safeInteger(pending.sequence, `${label}.pendingAttack.sequence`, 1,
      MAX_EVENTS);
    pendingAttack = pending;
  }
  const history = denseArray(state.history, `${label}.history`, MAX_EVENTS)
    .map(checkedEvent);
  if ((state.targetId === null) !==
    (state.attackPhase === "idle" && state.attackWork === null)) {
    throw new TypeError(`${label} target and attack state are inconsistent`);
  }
  if ((state.attackPhase === "contact") !== (pendingAttack !== null)) {
    throw new TypeError(`${label} pending contact is inconsistent`);
  }
  if (!state.alive && (state.targetId !== null || state.boostSourceId !== null ||
    state.slowSourceId !== null || state.pendingAttack !== null)) {
    throw new TypeError(`${label} dead state retains combat status`);
  }
  const expectedCommandIndex =
    commands.filter(({ tick }) => tick < state.tick).length;
  if (state.commandIndex !== expectedCommandIndex) {
    throw new TypeError(`${label} command cursor is noncausal`);
  }
  let priorTick = -1;
  for (const event of history) {
    if (event.tick < priorTick || event.tick >= state.tick) {
      throw new TypeError(`${label} history is noncausal`);
    }
    priorTick = event.tick;
  }
  return {
    alive: state.alive,
    attackPhase: state.attackPhase,
    attackSequence: state.attackSequence,
    attackWork: state.attackWork,
    commandIndex: state.commandIndex,
    history,
    movementRemainder: state.movementRemainder,
    pendingAttack,
    position: state.position,
    boostSourceId: state.boostSourceId,
    boostUntilTick: state.boostUntilTick,
    slowSourceId: state.slowSourceId,
    slowUntilTick: state.slowUntilTick,
    targetId: state.targetId,
    tick: state.tick,
  };
}

function replayState(commands, direction, ticks) {
  const state = initialState();
  for (let index = 0; index < ticks; index += 1) {
    uncheckedAdvance(state, commands, direction);
  }
  return state;
}

function checkedCausalState(value, commands, direction, label = "rage state") {
  const checked = checkedStateShape(value, commands, label);
  const expected = replayState(commands, direction, checked.tick);
  if (canonicalJson(checked) !== canonicalJson(expected)) {
    throw new TypeError(`${label} is forged or noncausal`);
  }
  return checked;
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

export function createRageSpecialCatalog() {
  return createCardCatalog(CARD_DEFINITIONS);
}

export function createRageQuestionRecords(...args) {
  if (args.length !== 0) {
    throw new TypeError("rage question records do not accept overrides");
  }
  return deepFreeze(Object.fromEntries(Object.entries(QUESTION_VALUES).map(
    ([key, value]) => [key, questionRecord(key, value)],
  )));
}

export function createRageFixture(commands = [], direction = 1) {
  return clone(checkedSetup({ commands, direction }));
}

export class TimedMovementAttackRageEncounter {
  #commands;
  #direction;
  #state;

  constructor(setup = createRageFixture()) {
    const checked = checkedSetup(setup);
    this.#commands = checked.commands;
    this.#direction = checked.direction;
    this.#state = initialState();
  }

  get replay() {
    return clone(this.#state.history);
  }

  get state() {
    return clone(this.#state);
  }

  step() {
    const candidate = checkedCausalState(this.#state, this.#commands,
      this.#direction);
    const events = uncheckedAdvance(candidate, this.#commands, this.#direction);
    this.#state = candidate;
    return clone(events);
  }

  stepMany(count) {
    safeInteger(count, "rage step count", 0, MAX_STEP_CHUNK);
    if (count > MAX_TICK - this.#state.tick) {
      throw new RangeError("rage step count exceeds the encounter bound");
    }
    const candidate = checkedCausalState(this.#state, this.#commands,
      this.#direction);
    const events = [];
    for (let index = 0; index < count; index += 1) {
      events.push(...uncheckedAdvance(candidate, this.#commands, this.#direction));
    }
    this.#state = candidate;
    return clone(events);
  }

  run() {
    return this.stepMany(MAX_TICK - this.#state.tick);
  }

  serialize() {
    const serialized = canonicalJson({
      identity: {
        commands: this.#commands,
        direction: this.#direction,
        fixture: FIXTURE_ID,
      },
      state: checkedCausalState(this.#state, this.#commands, this.#direction),
      version: 1,
    });
    if (Buffer.byteLength(serialized, "utf8") > MAX_SNAPSHOT_BYTES) {
      throw new RangeError("rage snapshot exceeds its byte bound");
    }
    return serialized;
  }

  static restore(serialized) {
    if (typeof serialized !== "string") {
      throw new TypeError("rage snapshot must be a string");
    }
    if (Buffer.byteLength(serialized, "utf8") > MAX_SNAPSHOT_BYTES) {
      throw new RangeError("rage snapshot exceeds its byte bound");
    }
    let value;
    try {
      value = JSON.parse(serialized);
    } catch {
      throw new TypeError("rage snapshot must be valid JSON");
    }
    if (serialized !== canonicalJson(value)) {
      throw new TypeError("rage snapshot must be canonical duplicate-free JSON");
    }
    const snapshot = exactRecord(value, SNAPSHOT_KEYS, "rage snapshot");
    if (snapshot.version !== 1) {
      throw new TypeError("rage snapshot version is unsupported");
    }
    const identity = exactRecord(snapshot.identity, IDENTITY_KEYS,
      "rage snapshot.identity");
    if (identity.fixture !== FIXTURE_ID) {
      throw new TypeError("rage snapshot fixture identity is invalid");
    }
    const setup = checkedSetup({
      commands: identity.commands,
      direction: identity.direction,
    });
    const state = checkedCausalState(snapshot.state, setup.commands,
      setup.direction, "rage snapshot.state");
    const encounter = new TimedMovementAttackRageEncounter(setup);
    encounter.#state = state;
    return encounter;
  }
}
