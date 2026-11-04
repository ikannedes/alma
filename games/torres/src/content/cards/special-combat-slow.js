import { createCardCatalog } from "../schema.js";

const CARD_DEFINITIONS = [{
  areaDamageRadiusMillitiles: null,
  components: [],
  cost: 3,
  count: 1,
  damage: 90,
  deployTimeTicks: 60,
  displayName: "Rime Adept",
  firstHitTicks: 72,
  hitSpeedTicks: 102,
  hitpoints: 688,
  id: "rime-adept",
  kind: "unit",
  movementMillitilesPerSecond: 1000,
  rangeMillitiles: 5500,
  rarity: "mythic",
  sightRangeMillitiles: 5500,
  targetMode: "ground-and-air",
}];

const SOURCE = "unsourced-timed-movement-and-attack-slow-fixture";
const FIXTURE_ID = "timed-movement-and-attack-slow-question-v1";
const PROFILE_FIXTURE_ID = "timed-movement-and-attack-slow-profile-question-v1";
const MAX_COMMANDS = 64;
const MAX_EVENTS = 8192;
const MAX_POSITION = 1_000_000;
const MAX_SNAPSHOT_BYTES = 1048576;
const MAX_STEP_CHUNK = 4096;
const MAX_TICK = 4096;
const MOVEMENT_DENOMINATOR = 1200n;
const NORMAL_PROGRESS = 20n;
const PROGRESS_TWENTIETHS = 20;
const DEFAULT_SLOW_PROGRESS = Object.freeze({
  attackWorkTwentieths: 13,
  movementTwentieths: 13,
});
const WINDUP_WORK = 1440;
const CADENCE_WORK = 2040;
const DURATION_TICKS = 60;

const COMMAND_KEYS = ["sourceId", "targetId", "tick", "type"];
const COMMAND_TYPES = new Set([
  "acquire-target",
  "die",
  "lose-target",
  "slow",
  "target-died",
]);
const SETUP_KEYS = ["commands", "direction"];
const PROFILE_SETUP_KEYS = [...SETUP_KEYS, "slowProgress"];
const SLOW_PROGRESS_KEYS = ["attackWorkTwentieths", "movementTwentieths"];
const SNAPSHOT_KEYS = ["identity", "state", "version"];
const IDENTITY_KEYS = ["commands", "direction", "fixture"];
const PROFILE_IDENTITY_KEYS = [...IDENTITY_KEYS, "slowProgress"];
const STATE_KEYS = [
  "alive",
  "attackPhase",
  "attackSequence",
  "attackWork",
  "commandIndex",
  "history",
  "movementRemainder",
  "position",
  "slowSourceId",
  "slowUntilTick",
  "targetId",
  "tick",
];
const EVENT_KEYS = {
  attack: ["sequence", "targetId", "tick", "type"],
  died: ["tick", "type"],
  moved: ["delta", "from", "remainder", "tick", "to", "type"],
  "slow-applied": ["sourceId", "tick", "type", "untilTick"],
  "slow-expired": ["sourceId", "tick", "type"],
  "target-acquired": ["targetId", "tick", "type"],
  "target-died": ["targetId", "tick", "type"],
  "target-lost": ["targetId", "tick", "type"],
};

const QUESTION_VALUES = Object.freeze({
  alreadyEarnedReadiness: "ready-at-boundary-start-fires-after-application",
  attackProgressRate: { denominator: 20, numerator: 13 },
  boundaryOrdering:
    "expire-then-commands-then-loss-death-change-cancellation-then-ready-then-movement-then-attack-work-then-events-then-tick",
  cadenceWorkTwentieths: CADENCE_WORK,
  commonAreaDamageRadius: null,
  commonBaseDamage: 90,
  commonCount: 1,
  commonDeployTicks: 60,
  commonFirstHitTicks: 72,
  commonHitCadenceTicks: 102,
  commonHitpoints: 688,
  commonMovementMillitilesPerSecond: 1000,
  commonRangeMillitiles: 5500,
  commonSightRangeMillitiles: 5500,
  commonTargetMode: "ground-and-air",
  deadlineRescaling: "none-progress-is-work-not-a-rescaled-deadline",
  deathPolicy: "unit-death-clears-target-attack-and-slow",
  delivery: "explicit-boundary-command-no-projectile-or-area-claim",
  deployment: "fixture-starts-deployed-deploy-delay-is-not-simulated",
  differentSourceReapply: "refresh-expiry-from-current-tick-and-replace-source",
  durationTicks: DURATION_TICKS,
  eligibility: "living-unit-explicit-command-positive-safe-source-id",
  expiryWindow: "application-tick-through-application-plus-59",
  fidelity: "test-only-question-fixture-not-a-general-slow-system",
  immunity: "none-in-this-fixture",
  movementProgressRate: { denominator: 20, numerator: 13 },
  movementRemainder: "retained-across-application-refresh-and-expiry",
  nonStacking: "single-status-slot",
  rageComposition: "deferred-no-composition-claim",
  reciprocalAttackInterval: { denominator: 13, numerator: 20 },
  refresh: "expiry-is-current-application-tick-plus-60",
  resetComposition: "deferred-no-reset-claim",
  sameSourceReapply: "refresh-expiry-from-current-tick-and-retain-remainders",
  snareComposition: "deferred-no-composition-claim",
  sourceDeath: "existing-slow-persists-source-liveness-is-not-tracked",
  stack: "double-application-on-one-boundary-equals-one-latest-source-slot",
  stunComposition: "deferred-no-composition-claim",
  targetChange: "fresh-windup-and-cancel-earned-readiness-before-ready",
  targetDeath: "cancel-attack-before-ready-slow-on-unit-persists",
  targetLoss: "cancel-attack-before-ready-slow-on-unit-persists",
  windupWorkTwentieths: WINDUP_WORK,
  workRemainder: "attack-work-is-exact-integer-twentieths-and-retained",
  workUnderSlow: "windup-and-cadence-consume-13-twentieths-per-boundary",
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
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
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

function denseArray(value, label, maximum) {
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
      (index) => !descriptors[index]?.enumerable ||
        !Object.hasOwn(descriptors[index], "value"),
    )
  ) {
    throw new TypeError(`${label} must contain dense data properties`);
  }
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
  const commands = denseArray(value, "slow commands", MAX_COMMANDS).map(
    (entry, index) => {
      const command = exactRecord(entry, COMMAND_KEYS, `slow command ${index}`);
      safeInteger(command.tick, `slow command ${index}.tick`, 0, MAX_TICK - 1);
      if (!COMMAND_TYPES.has(command.type)) {
        throw new TypeError(`slow command ${index}.type is invalid`);
      }
      if (command.type === "slow") {
        checkedId(command.sourceId, `slow command ${index}.sourceId`);
        if (command.targetId !== null) {
          throw new TypeError(`slow command ${index}.targetId must be null`);
        }
        if (command.tick > MAX_TICK - DURATION_TICKS) {
          throw new TypeError(`slow command ${index}.tick cannot fit duration`);
        }
      } else if (command.type === "acquire-target") {
        checkedId(command.targetId, `slow command ${index}.targetId`);
        if (command.sourceId !== null) {
          throw new TypeError(`slow command ${index}.sourceId must be null`);
        }
      } else if (command.type === "target-died") {
        checkedId(command.targetId, `slow command ${index}.targetId`, true);
        if (command.sourceId !== null) {
          throw new TypeError(`slow command ${index}.sourceId must be null`);
        }
      } else if (command.sourceId !== null || command.targetId !== null) {
        throw new TypeError(`slow command ${index} has inapplicable IDs`);
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
      throw new TypeError("slow commands must have nondecreasing ticks");
    }
    prior = command.tick;
  }
  return commands;
}

function checkedSlowProgress(value) {
  const progress = exactRecord(value, SLOW_PROGRESS_KEYS, "slow progress");
  for (const key of SLOW_PROGRESS_KEYS) {
    safeInteger(
      progress[key],
      `slow progress.${key}`,
      1,
      PROGRESS_TWENTIETHS,
    );
  }
  return {
    attackWorkTwentieths: progress.attackWorkTwentieths,
    movementTwentieths: progress.movementTwentieths,
  };
}

function checkedSetup(value) {
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const profiled = Object.hasOwn(descriptors, "slowProgress");
  const keys = profiled ? PROFILE_SETUP_KEYS : SETUP_KEYS;
  const setup = exactRecord(value, keys, "slow setup");
  if (setup.direction !== -1 && setup.direction !== 1) {
    throw new TypeError("slow setup.direction must be -1 or 1");
  }
  return {
    commands: checkedCommands(setup.commands),
    direction: setup.direction,
    profiled,
    slowProgress: profiled
      ? checkedSlowProgress(setup.slowProgress)
      : { ...DEFAULT_SLOW_PROGRESS },
  };
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
    position: 0,
    slowSourceId: null,
    slowUntilTick: null,
    targetId: null,
    tick: 0,
  };
}

function clearTarget(state) {
  state.attackPhase = "idle";
  state.attackWork = null;
  state.targetId = null;
}

function applyCommand(state, command, events) {
  if (command.type === "slow") {
    if (!state.alive) return;
    state.slowSourceId = command.sourceId;
    state.slowUntilTick = state.tick + DURATION_TICKS;
    events.push({
      sourceId: command.sourceId,
      tick: state.tick,
      type: "slow-applied",
      untilTick: state.slowUntilTick,
    });
    return;
  }
  if (command.type === "acquire-target") {
    if (!state.alive || state.targetId === command.targetId) return;
    clearTarget(state);
    state.targetId = command.targetId;
    state.attackPhase = "windup";
    state.attackWork = WINDUP_WORK;
    events.push({
      targetId: command.targetId,
      tick: state.tick,
      type: "target-acquired",
    });
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
    if (
      state.targetId !== null &&
      (command.targetId === null || command.targetId === state.targetId)
    ) {
      const targetId = state.targetId;
      clearTarget(state);
      events.push({ targetId, tick: state.tick, type: "target-died" });
    }
    return;
  }
  if (state.alive) {
    state.alive = false;
    state.slowSourceId = null;
    state.slowUntilTick = null;
    clearTarget(state);
    events.push({ tick: state.tick, type: "died" });
  }
}

function uncheckedAdvance(state, commands, direction, slowProgress) {
  if (state.tick >= MAX_TICK) {
    throw new RangeError("slow encounter has reached its tick bound");
  }
  const tick = state.tick;
  const events = [];
  if (state.slowUntilTick !== null && tick >= state.slowUntilTick) {
    events.push({
      sourceId: state.slowSourceId,
      tick,
      type: "slow-expired",
    });
    state.slowSourceId = null;
    state.slowUntilTick = null;
  }
  while (commands[state.commandIndex]?.tick === tick) {
    const command = commands[state.commandIndex];
    state.commandIndex += 1;
    applyCommand(state, command, events);
  }

  if (state.alive && state.targetId !== null && state.attackWork === 0) {
    state.attackSequence += 1;
    events.push({
      sequence: state.attackSequence,
      targetId: state.targetId,
      tick,
      type: "attack",
    });
    state.attackPhase = "cadence";
    state.attackWork = CADENCE_WORK;
  }

  if (state.alive) {
    const movementProgress = state.slowUntilTick === null
      ? NORMAL_PROGRESS
      : BigInt(slowProgress.movementTwentieths);
    const attackProgress = state.slowUntilTick === null
      ? NORMAL_PROGRESS
      : BigInt(slowProgress.attackWorkTwentieths);
    const accumulated =
      BigInt(state.movementRemainder) +
      BigInt(CARD_DEFINITIONS[0].movementMillitilesPerSecond) *
      movementProgress;
    const magnitude = accumulated / MOVEMENT_DENOMINATOR;
    const remainder = accumulated % MOVEMENT_DENOMINATOR;
    const deltaBig = BigInt(direction) * magnitude;
    const next = BigInt(state.position) + deltaBig;
    if (next < -BigInt(MAX_POSITION) || next > BigInt(MAX_POSITION)) {
      throw new RangeError("slow movement exceeds its position bound");
    }
    const delta = Number(deltaBig);
    const from = state.position;
    state.position = Number(next);
    state.movementRemainder = Number(remainder);
    events.push({
      delta,
      from,
      remainder: state.movementRemainder,
      tick,
      to: state.position,
      type: "moved",
    });
    if (state.targetId !== null && state.attackWork > 0) {
      state.attackWork = Number(
        BigInt(state.attackWork) > attackProgress
          ? BigInt(state.attackWork) - attackProgress
          : 0n,
      );
    }
  }
  if (state.history.length + events.length > MAX_EVENTS) {
    throw new RangeError("slow replay exceeds its event bound");
  }
  state.history.push(...clone(events));
  state.tick += 1;
  return events;
}

function checkedEvent(value, index) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`slow history event ${index} has an invalid shape`);
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, "type");
  if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) {
    throw new TypeError(`slow history event ${index}.type must be data`);
  }
  const keys = EVENT_KEYS[descriptor.value];
  if (keys === undefined) {
    throw new TypeError(`slow history event ${index}.type is invalid`);
  }
  const event = exactRecord(value, keys, `slow history event ${index}`);
  safeInteger(event.tick, `slow history event ${index}.tick`, 0, MAX_TICK - 1);
  for (const key of [
    "sequence", "sourceId", "targetId", "untilTick", "remainder",
  ]) {
    if (Object.hasOwn(event, key)) {
      const minimum = key === "remainder" ? 0 : 1;
      safeInteger(event[key], `slow history event ${index}.${key}`, minimum);
    }
  }
  for (const key of ["delta", "from", "to"]) {
    if (Object.hasOwn(event, key)) {
      safeInteger(
        event[key] + MAX_POSITION,
        `slow history event ${index}.${key}`,
        0,
        MAX_POSITION * 2,
      );
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
  safeInteger(
    state.position + MAX_POSITION,
    `${label}.position`,
    0,
    MAX_POSITION * 2,
  );
  safeInteger(
    state.movementRemainder,
    `${label}.movementRemainder`,
    0,
    Number(MOVEMENT_DENOMINATOR - 1n),
  );
  checkedId(state.targetId, `${label}.targetId`, true);
  checkedId(state.slowSourceId, `${label}.slowSourceId`, true);
  if (!["idle", "windup", "cadence"].includes(state.attackPhase)) {
    throw new TypeError(`${label}.attackPhase is invalid`);
  }
  if (state.attackWork !== null) {
    safeInteger(state.attackWork, `${label}.attackWork`, 0, CADENCE_WORK);
  }
  if (state.slowUntilTick !== null) {
    safeInteger(state.slowUntilTick, `${label}.slowUntilTick`, 1, MAX_TICK);
  }
  const history = denseArray(state.history, `${label}.history`, MAX_EVENTS)
    .map(checkedEvent);
  if ((state.slowSourceId === null) !== (state.slowUntilTick === null)) {
    throw new TypeError(`${label} slow status is inconsistent`);
  }
  if (
    state.slowUntilTick !== null &&
    (state.slowUntilTick < state.tick ||
      state.slowUntilTick > state.tick + DURATION_TICKS)
  ) {
    throw new TypeError(`${label} slow expiry is noncausal`);
  }
  if (
    (state.targetId === null) !==
    (state.attackPhase === "idle" && state.attackWork === null)
  ) {
    throw new TypeError(`${label} target and attack state are inconsistent`);
  }
  if (!state.alive && (
    state.targetId !== null ||
    state.slowSourceId !== null ||
    state.attackPhase !== "idle"
  )) {
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
    position: state.position,
    slowSourceId: state.slowSourceId,
    slowUntilTick: state.slowUntilTick,
    targetId: state.targetId,
    tick: state.tick,
  };
}

function replayState(commands, direction, ticks, slowProgress) {
  const state = initialState();
  for (let index = 0; index < ticks; index += 1) {
    uncheckedAdvance(state, commands, direction, slowProgress);
  }
  return state;
}

function checkedCausalState(
  value,
  commands,
  direction,
  slowProgress,
  label = "slow state",
) {
  const checked = checkedStateShape(value, commands, label);
  const expected = replayState(commands, direction, checked.tick, slowProgress);
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

export function createSlowSpecialCatalog() {
  return createCardCatalog(CARD_DEFINITIONS);
}

export function createSlowQuestionRecords(...args) {
  if (args.length !== 0) {
    throw new TypeError("slow question records do not accept overrides");
  }
  return deepFreeze(Object.fromEntries(
    Object.entries(QUESTION_VALUES).map(([key, value]) =>
      [key, questionRecord(key, value)]),
  ));
}

export function createSlowFixture(commands = [], direction = 1, slowProgress) {
  const setup = slowProgress === undefined
    ? { commands, direction }
    : { commands, direction, slowProgress };
  const checked = checkedSetup(setup);
  return clone(checked.profiled
    ? {
      commands: checked.commands,
      direction: checked.direction,
      slowProgress: checked.slowProgress,
    }
    : { commands: checked.commands, direction: checked.direction });
}

export class TimedMovementAttackSlowEncounter {
  #commands;
  #direction;
  #profiled;
  #slowProgress;
  #state;

  constructor(setup = createSlowFixture()) {
    const checked = checkedSetup(setup);
    this.#commands = checked.commands;
    this.#direction = checked.direction;
    this.#profiled = checked.profiled;
    this.#slowProgress = checked.slowProgress;
    this.#state = initialState();
  }

  get replay() {
    return clone(this.#state.history);
  }

  get state() {
    return clone(this.#state);
  }

  step() {
    const candidate = checkedCausalState(
      this.#state,
      this.#commands,
      this.#direction,
      this.#slowProgress,
    );
    const events = uncheckedAdvance(
      candidate,
      this.#commands,
      this.#direction,
      this.#slowProgress,
    );
    this.#state = candidate;
    return clone(events);
  }

  stepMany(count) {
    safeInteger(count, "slow step count", 0, MAX_STEP_CHUNK);
    if (count > MAX_TICK - this.#state.tick) {
      throw new RangeError("slow step count exceeds the encounter bound");
    }
    const candidate = checkedCausalState(
      this.#state,
      this.#commands,
      this.#direction,
      this.#slowProgress,
    );
    const events = [];
    for (let index = 0; index < count; index += 1) {
      events.push(...uncheckedAdvance(
        candidate,
        this.#commands,
        this.#direction,
        this.#slowProgress,
      ));
    }
    this.#state = candidate;
    return clone(events);
  }

  run() {
    return this.stepMany(MAX_TICK - this.#state.tick);
  }

  serialize() {
    const identity = {
      commands: this.#commands,
      direction: this.#direction,
      fixture: this.#profiled ? PROFILE_FIXTURE_ID : FIXTURE_ID,
    };
    if (this.#profiled) identity.slowProgress = this.#slowProgress;
    const serialized = canonicalJson({
      identity,
      state: checkedCausalState(
        this.#state,
        this.#commands,
        this.#direction,
        this.#slowProgress,
      ),
      version: 1,
    });
    if (Buffer.byteLength(serialized, "utf8") > MAX_SNAPSHOT_BYTES) {
      throw new RangeError("slow snapshot exceeds its byte bound");
    }
    return serialized;
  }

  static restore(serialized) {
    if (typeof serialized !== "string") {
      throw new TypeError("slow snapshot must be a string");
    }
    if (Buffer.byteLength(serialized, "utf8") > MAX_SNAPSHOT_BYTES) {
      throw new RangeError("slow snapshot exceeds its byte bound");
    }
    let value;
    try {
      value = JSON.parse(serialized);
    } catch {
      throw new TypeError("slow snapshot must be valid JSON");
    }
    if (serialized !== canonicalJson(value)) {
      throw new TypeError("slow snapshot must be canonical duplicate-free JSON");
    }
    const snapshot = exactRecord(value, SNAPSHOT_KEYS, "slow snapshot");
    if (snapshot.version !== 1) {
      throw new TypeError("slow snapshot version is unsupported");
    }
    const fixtureDescriptor = Object.getOwnPropertyDescriptor(
      snapshot.identity,
      "fixture",
    );
    const fixture = fixtureDescriptor?.value;
    if (fixture !== FIXTURE_ID && fixture !== PROFILE_FIXTURE_ID) {
      throw new TypeError("slow snapshot fixture identity is invalid");
    }
    const identity = exactRecord(
      snapshot.identity,
      fixture === FIXTURE_ID ? IDENTITY_KEYS : PROFILE_IDENTITY_KEYS,
      "slow snapshot.identity",
    );
    const setupInput = {
      commands: identity.commands,
      direction: identity.direction,
    };
    if (fixture === PROFILE_FIXTURE_ID) {
      setupInput.slowProgress = identity.slowProgress;
    }
    const setup = checkedSetup(setupInput);
    const state = checkedCausalState(
      snapshot.state,
      setup.commands,
      setup.direction,
      setup.slowProgress,
      "slow snapshot.state",
    );
    const encounter = new TimedMovementAttackSlowEncounter(setupInput);
    encounter.#state = state;
    return encounter;
  }
}
