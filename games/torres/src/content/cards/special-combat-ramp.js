import { createCardCatalog } from "../schema.js";

const CARD_DEFINITIONS = [{
  areaDamageRadiusMillitiles: null,
  components: [],
  cost: 4,
  count: 1,
  damage: 36,
  deployTimeTicks: 60,
  displayName: "Cinder Ray",
  firstHitTicks: 72,
  hitSpeedTicks: 24,
  hitpoints: 1294,
  id: "cinder-ray",
  kind: "unit",
  movementMillitilesPerSecond: 1000,
  rangeMillitiles: 3500,
  rarity: "mythic",
  sightRangeMillitiles: 5500,
  targetMode: "ground-and-air",
}];

const SOURCE = "unsourced-consecutive-target-ramp-fixture";
const MAX_COMMANDS = 64;
const MAX_REPLAY_EVENTS = 4096;
const MAX_SNAPSHOT_BYTES = 131072;
const MAX_STEP_CHUNK = 4096;
const MAX_TICK = 4096;
const TARGET_HEALTH = 1_000_000;
const COMMAND_TYPES = new Set([
  "interrupt",
  "reset",
  "target-acquired",
  "target-died",
  "target-lost",
]);
const COMMAND_KEYS = ["targetId", "tick", "type"];
const SETUP_KEYS = ["commands"];
const SNAPSHOT_KEYS = ["identity", "state", "version"];
const IDENTITY_KEYS = ["commands", "fixture"];
const STATE_KEYS = [
  "attackSequence",
  "commandIndex",
  "consecutiveContacts",
  "history",
  "nextLaunchTick",
  "pending",
  "stageIndex",
  "targetAlive",
  "targetEligible",
  "targetHealth",
  "targetId",
  "tick",
];
const PENDING_KEYS = [
  "amount",
  "contactTick",
  "sequence",
  "stageIndex",
  "targetId",
];
const EVENT_KEYS = {
  "attack-launched": [
    "amount",
    "contactTick",
    "sequence",
    "stageIndex",
    "targetId",
    "tick",
    "type",
  ],
  damage: [
    "amount",
    "healthAfter",
    "healthBefore",
    "sequence",
    "stageIndex",
    "targetId",
    "tick",
    "type",
  ],
  "ramp-reset": ["reason", "targetId", "tick", "type"],
  "stage-changed": [
    "consecutiveContacts",
    "stageIndex",
    "targetId",
    "tick",
    "type",
  ],
  "target-acquired": ["targetId", "tick", "type"],
  "target-died": ["targetId", "tick", "type"],
  "target-lost": ["targetId", "tick", "type"],
};

const QUESTION_VALUES = Object.freeze({
  commonAreaDamageRadius: null,
  commonBaseDamage: 36,
  commonCount: 1,
  commonDeployTicks: 60,
  commonFirstHitTicks: 72,
  commonHitCadenceTicks: 24,
  commonHitpoints: 1294,
  commonMovementMillitilesPerSecond: 1000,
  commonRangeMillitiles: 3500,
  commonSightRangeMillitiles: 5500,
  commonTargetMode: "ground-and-air",
  contactDelayTicks: 2,
  damageProgression: Object.freeze([10, 20, 40]),
  decay: "none",
  eligibility: "explicit-eligible-living-target",
  explicitReset: "clear-stage-and-pending-retain-target-block-boundary",
  firstLaunchTicks: 0,
  interruption: "clear-stage-and-pending-retain-target-block-boundary",
  launchSnapshot: "copy-target-stage-and-damage-at-launch",
  lossChangeDeathReset: "clear-stage-and-pending",
  retainedTargetIdentity: "same-positive-safe-integer-id",
  sameBoundaryOrdering: "command-first-then-contact-then-launch",
  stageAdvancement: "after-successful-contact",
  stageCount: 3,
  stageThresholds: Object.freeze([0, 2, 4]),
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

function safeInteger(value, label, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label} must be a bounded safe integer`);
  }
}

function checkedTargetId(value, label, nullable = false) {
  if (nullable && value === null) return;
  safeInteger(value, label, 1);
}

function checkedCommands(value) {
  const commands = denseArray(value, "ramp commands", MAX_COMMANDS).map(
    (entry, index) => {
      const command = exactRecord(
        entry,
        COMMAND_KEYS,
        `ramp command ${index}`,
      );
      safeInteger(command.tick, `ramp command ${index}.tick`, 0, MAX_TICK - 1);
      if (!COMMAND_TYPES.has(command.type)) {
        throw new TypeError(`ramp command ${index}.type is invalid`);
      }
      if (command.type === "target-acquired") {
        checkedTargetId(command.targetId, `ramp command ${index}.targetId`);
      } else if (
        command.type === "target-died" &&
        command.targetId !== null
      ) {
        checkedTargetId(command.targetId, `ramp command ${index}.targetId`);
      } else if (command.type !== "target-died" && command.targetId !== null) {
        throw new TypeError(
          `ramp command ${index}.targetId must be null for ${command.type}`,
        );
      }
      return { targetId: command.targetId, tick: command.tick, type: command.type };
    },
  );
  let priorTick = -1;
  for (const command of commands) {
    if (command.tick <= priorTick) {
      throw new TypeError("ramp commands must have unique increasing ticks");
    }
    priorTick = command.tick;
  }
  return commands;
}

function checkedSetup(value) {
  const setup = exactRecord(value, SETUP_KEYS, "ramp setup");
  return { commands: checkedCommands(setup.commands) };
}

function checkedPending(value, label) {
  if (value === null) return null;
  const pending = exactRecord(value, PENDING_KEYS, label);
  safeInteger(pending.amount, `${label}.amount`, 1);
  safeInteger(pending.contactTick, `${label}.contactTick`, 0, MAX_TICK);
  safeInteger(pending.sequence, `${label}.sequence`, 1, MAX_REPLAY_EVENTS);
  safeInteger(
    pending.stageIndex,
    `${label}.stageIndex`,
    0,
    QUESTION_VALUES.stageCount - 1,
  );
  checkedTargetId(pending.targetId, `${label}.targetId`);
  if (pending.amount !== QUESTION_VALUES.damageProgression[pending.stageIndex]) {
    throw new TypeError(`${label} damage does not match its launch stage`);
  }
  return { ...pending };
}

function checkedEvent(value, index) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`ramp history event ${index} has an invalid shape`);
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, "type");
  if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) {
    throw new TypeError(`ramp history event ${index}.type must be data`);
  }
  const keys = EVENT_KEYS[descriptor.value];
  if (keys === undefined) {
    throw new TypeError(`ramp history event ${index}.type is invalid`);
  }
  const event = exactRecord(value, keys, `ramp history event ${index}`);
  safeInteger(event.tick, `ramp history event ${index}.tick`, 0, MAX_TICK - 1);
  if (Object.hasOwn(event, "targetId")) {
    checkedTargetId(event.targetId, `ramp history event ${index}.targetId`, true);
  }
  for (const key of [
    "amount",
    "contactTick",
    "consecutiveContacts",
    "healthAfter",
    "healthBefore",
    "sequence",
    "stageIndex",
  ]) {
    if (Object.hasOwn(event, key)) {
      safeInteger(event[key], `ramp history event ${index}.${key}`);
    }
  }
  if (
    Object.hasOwn(event, "stageIndex") &&
    event.stageIndex >= QUESTION_VALUES.stageCount
  ) {
    throw new TypeError(`ramp history event ${index}.stageIndex is invalid`);
  }
  if (
    Object.hasOwn(event, "contactTick") &&
    event.contactTick > MAX_TICK
  ) {
    throw new TypeError(`ramp history event ${index}.contactTick is invalid`);
  }
  if (
    Object.hasOwn(event, "sequence") &&
    event.sequence > MAX_REPLAY_EVENTS
  ) {
    throw new TypeError(`ramp history event ${index}.sequence is invalid`);
  }
  if (
    Object.hasOwn(event, "consecutiveContacts") &&
    event.consecutiveContacts > MAX_TICK
  ) {
    throw new TypeError(
      `ramp history event ${index}.consecutiveContacts is invalid`,
    );
  }
  for (const key of ["healthAfter", "healthBefore"]) {
    if (Object.hasOwn(event, key) && event[key] > TARGET_HEALTH) {
      throw new TypeError(`ramp history event ${index}.${key} is invalid`);
    }
  }
  if (Object.hasOwn(event, "reason") && ![
    "explicit",
    "interruption",
    "target-change",
    "target-death",
    "target-loss",
  ].includes(event.reason)) {
    throw new TypeError(`ramp history event ${index}.reason is invalid`);
  }
  return event;
}

function stageForContacts(contacts) {
  let stageIndex = 0;
  for (
    let index = 1;
    index < QUESTION_VALUES.stageThresholds.length;
    index += 1
  ) {
    if (contacts >= QUESTION_VALUES.stageThresholds[index]) stageIndex = index;
  }
  return stageIndex;
}

function initialState() {
  return {
    attackSequence: 0,
    commandIndex: 0,
    consecutiveContacts: 0,
    history: [],
    nextLaunchTick: null,
    pending: null,
    stageIndex: 0,
    targetAlive: false,
    targetEligible: false,
    targetHealth: null,
    targetId: null,
    tick: 0,
  };
}

function checkedState(value, commands, label = "ramp state") {
  const state = exactRecord(value, STATE_KEYS, label);
  safeInteger(state.tick, `${label}.tick`, 0, MAX_TICK);
  safeInteger(state.commandIndex, `${label}.commandIndex`, 0, commands.length);
  safeInteger(state.attackSequence, `${label}.attackSequence`, 0, MAX_TICK);
  safeInteger(
    state.consecutiveContacts,
    `${label}.consecutiveContacts`,
    0,
    MAX_TICK,
  );
  safeInteger(
    state.stageIndex,
    `${label}.stageIndex`,
    0,
    QUESTION_VALUES.stageCount - 1,
  );
  if (
    typeof state.targetAlive !== "boolean" ||
    typeof state.targetEligible !== "boolean"
  ) {
    throw new TypeError(`${label} target flags must be booleans`);
  }
  checkedTargetId(state.targetId, `${label}.targetId`, true);
  if (state.targetHealth !== null) {
    safeInteger(state.targetHealth, `${label}.targetHealth`, 0, TARGET_HEALTH);
  }
  if (state.nextLaunchTick !== null) {
    safeInteger(state.nextLaunchTick, `${label}.nextLaunchTick`, state.tick, MAX_TICK);
  }
  const pending = checkedPending(state.pending, `${label}.pending`);
  const history = denseArray(
    state.history,
    `${label}.history`,
    MAX_REPLAY_EVENTS,
  ).map(checkedEvent);
  let priorEventTick = -1;
  for (const event of history) {
    if (event.tick < priorEventTick || event.tick >= state.tick) {
      throw new TypeError(`${label} history is noncausal`);
    }
    priorEventTick = event.tick;
  }
  if (state.consecutiveContacts > state.attackSequence) {
    throw new TypeError(`${label} has more contacts than launches`);
  }
  if (state.stageIndex !== stageForContacts(state.consecutiveContacts)) {
    throw new TypeError(`${label} stage does not match consecutive contacts`);
  }
  const hasTarget = state.targetId !== null;
  if (
    hasTarget !== state.targetAlive ||
    hasTarget !== state.targetEligible ||
    hasTarget !== (state.targetHealth !== null && state.targetHealth > 0)
  ) {
    throw new TypeError(`${label} target fields are inconsistent`);
  }
  if (!hasTarget && (
    state.nextLaunchTick !== null ||
    pending !== null ||
    state.consecutiveContacts !== 0 ||
    state.stageIndex !== 0
  )) {
    throw new TypeError(`${label} inactive target retains attack state`);
  }
  if (pending !== null && (
    pending.targetId !== state.targetId ||
    pending.sequence > state.attackSequence ||
    pending.contactTick < state.tick ||
    pending.contactTick > state.tick + QUESTION_VALUES.contactDelayTicks
  )) {
    throw new TypeError(`${label} pending launch is inconsistent`);
  }
  const expectedCommandIndex = commands.filter(
    (command) => command.tick < state.tick,
  ).length;
  if (state.commandIndex !== expectedCommandIndex) {
    throw new TypeError(`${label} command cursor is noncausal`);
  }
  return {
    attackSequence: state.attackSequence,
    commandIndex: state.commandIndex,
    consecutiveContacts: state.consecutiveContacts,
    history,
    nextLaunchTick: state.nextLaunchTick,
    pending,
    stageIndex: state.stageIndex,
    targetAlive: state.targetAlive,
    targetEligible: state.targetEligible,
    targetHealth: state.targetHealth,
    targetId: state.targetId,
    tick: state.tick,
  };
}

function resetRamp(state, reason, events, blockBoundary) {
  const changed = (
    state.consecutiveContacts !== 0 ||
    state.stageIndex !== 0 ||
    state.pending !== null
  );
  state.consecutiveContacts = 0;
  state.stageIndex = 0;
  state.pending = null;
  if (state.targetId !== null) {
    state.nextLaunchTick = blockBoundary
      ? state.tick + QUESTION_VALUES.commonHitCadenceTicks
      : state.tick + QUESTION_VALUES.firstLaunchTicks;
  } else {
    state.nextLaunchTick = null;
  }
  if (changed || reason === "explicit" || reason === "interruption") {
    events.push({
      reason,
      targetId: state.targetId,
      tick: state.tick,
      type: "ramp-reset",
    });
  }
}

function applyCommand(state, command, events) {
  if (command.type === "target-acquired") {
    if (state.targetId !== command.targetId) {
      if (state.targetId !== null) {
        resetRamp(state, "target-change", events, false);
      }
      state.targetId = command.targetId;
      state.targetAlive = true;
      state.targetEligible = true;
      state.targetHealth = TARGET_HEALTH;
      state.nextLaunchTick = state.tick + QUESTION_VALUES.firstLaunchTicks;
      events.push({
        targetId: state.targetId,
        tick: state.tick,
        type: "target-acquired",
      });
    }
    return false;
  }
  if (command.type === "target-lost") {
    const priorId = state.targetId;
    if (priorId !== null) resetRamp(state, "target-loss", events, false);
    state.targetId = null;
    state.targetAlive = false;
    state.targetEligible = false;
    state.targetHealth = null;
    state.nextLaunchTick = null;
    events.push({ targetId: priorId, tick: state.tick, type: "target-lost" });
    return true;
  }
  if (command.type === "target-died") {
    if (
      state.targetId !== null &&
      (command.targetId === null || command.targetId === state.targetId)
    ) {
      const priorId = state.targetId;
      resetRamp(state, "target-death", events, false);
      state.targetId = null;
      state.targetAlive = false;
      state.targetEligible = false;
      state.targetHealth = null;
      state.nextLaunchTick = null;
      events.push({ targetId: priorId, tick: state.tick, type: "target-died" });
    }
    return true;
  }
  resetRamp(
    state,
    command.type === "reset" ? "explicit" : "interruption",
    events,
    true,
  );
  return true;
}

function advanceOne(state, commands) {
  if (state.tick >= MAX_TICK) return [];
  const events = [];
  let blockLaunch = false;
  const command = commands[state.commandIndex];
  if (command?.tick === state.tick) {
    state.commandIndex += 1;
    blockLaunch = applyCommand(state, command, events);
  }

  if (state.pending?.contactTick === state.tick) {
    const pending = state.pending;
    state.pending = null;
    if (
      state.targetId === pending.targetId &&
      state.targetAlive &&
      state.targetEligible
    ) {
      const before = state.targetHealth;
      state.targetHealth = Math.max(0, before - pending.amount);
      events.push({
        amount: pending.amount,
        healthAfter: state.targetHealth,
        healthBefore: before,
        sequence: pending.sequence,
        stageIndex: pending.stageIndex,
        targetId: pending.targetId,
        tick: state.tick,
        type: "damage",
      });
      state.consecutiveContacts += 1;
      const nextStage = stageForContacts(state.consecutiveContacts);
      if (nextStage !== state.stageIndex) {
        state.stageIndex = nextStage;
        events.push({
          consecutiveContacts: state.consecutiveContacts,
          stageIndex: nextStage,
          targetId: state.targetId,
          tick: state.tick,
          type: "stage-changed",
        });
      }
    }
  }

  if (
    !blockLaunch &&
    state.targetId !== null &&
    state.targetAlive &&
    state.targetEligible &&
    state.pending === null &&
    state.nextLaunchTick === state.tick
  ) {
    state.attackSequence += 1;
    const amount = QUESTION_VALUES.damageProgression[state.stageIndex];
    const contactTick = state.tick + QUESTION_VALUES.contactDelayTicks;
    state.pending = {
      amount,
      contactTick,
      sequence: state.attackSequence,
      stageIndex: state.stageIndex,
      targetId: state.targetId,
    };
    state.nextLaunchTick = state.tick + QUESTION_VALUES.commonHitCadenceTicks;
    events.push({
      amount,
      contactTick,
      sequence: state.attackSequence,
      stageIndex: state.stageIndex,
      targetId: state.targetId,
      tick: state.tick,
      type: "attack-launched",
    });
  }

  if (
    state.nextLaunchTick !== null &&
    state.nextLaunchTick > MAX_TICK
  ) {
    state.nextLaunchTick = null;
  }
  if (state.history.length + events.length > MAX_REPLAY_EVENTS) {
    throw new RangeError("ramp replay exceeds its event bound");
  }
  state.history.push(...clone(events));
  state.tick += 1;
  return events;
}

/**
 * Returns the original shipped runtime definition. Numeric combat fields are
 * question-backed reconstruction inputs; only identity, cost, kind, and rarity
 * are supported by the common roster corpus.
 */
export function createRampSpecialCatalog() {
  return createCardCatalog(CARD_DEFINITIONS);
}

/**
 * Returns fresh, recursively frozen records. Each absent number or policy has
 * its own record so later evidence can replace one assumption without silently
 * promoting any other assumption.
 */
export function createRampQuestionRecords(...args) {
  if (args.length !== 0) {
    throw new TypeError("ramp question records do not accept overrides");
  }
  const records = {};
  for (const [key, value] of Object.entries(QUESTION_VALUES)) {
    records[key] = questionRecord(key, value);
  }
  return deepFreeze(records);
}

export function createRampFixture(commands = []) {
  return clone(checkedSetup({ commands }));
}

/**
 * Bounded deterministic executable QUESTION fixture for one retained target.
 * Boundary order is command, pending contact, then launch. Stage and damage are
 * copied at launch; successful contact advances the next launch's stage.
 */
export class ConsecutiveTargetRampEncounter {
  #commands;
  #state;

  constructor(setup = createRampFixture()) {
    const checked = checkedSetup(setup);
    this.#commands = checked.commands;
    this.#state = initialState();
  }

  get replay() {
    return clone(this.#state.history);
  }

  get state() {
    return clone(this.#state);
  }

  step() {
    return clone(advanceOne(this.#state, this.#commands));
  }

  stepMany(count) {
    safeInteger(count, "ramp step count", 0, MAX_STEP_CHUNK);
    if (count > MAX_TICK - this.#state.tick) {
      throw new RangeError("ramp step count exceeds the encounter bound");
    }
    const candidate = checkedState(this.#state, this.#commands);
    const events = [];
    for (let index = 0; index < count; index += 1) {
      events.push(...advanceOne(candidate, this.#commands));
    }
    this.#state = candidate;
    return clone(events);
  }

  run() {
    return this.stepMany(MAX_TICK - this.#state.tick);
  }

  serialize() {
    return canonicalJson({
      identity: {
        commands: this.#commands,
        fixture: "consecutive-target-ramp-question-v1",
      },
      state: checkedState(this.#state, this.#commands),
      version: 1,
    });
  }

  static restore(serialized) {
    if (typeof serialized !== "string") {
      throw new TypeError("ramp snapshot must be a string");
    }
    if (Buffer.byteLength(serialized, "utf8") > MAX_SNAPSHOT_BYTES) {
      throw new RangeError("ramp snapshot exceeds its byte bound");
    }
    let value;
    try {
      value = JSON.parse(serialized);
    } catch {
      throw new TypeError("ramp snapshot must be valid JSON");
    }
    const snapshot = exactRecord(value, SNAPSHOT_KEYS, "ramp snapshot");
    if (snapshot.version !== 1) {
      throw new TypeError("ramp snapshot version is unsupported");
    }
    const identity = exactRecord(
      snapshot.identity,
      IDENTITY_KEYS,
      "ramp snapshot.identity",
    );
    if (identity.fixture !== "consecutive-target-ramp-question-v1") {
      throw new TypeError("ramp snapshot fixture identity is invalid");
    }
    const commands = checkedCommands(identity.commands);
    const state = checkedState(snapshot.state, commands, "ramp snapshot.state");
    const encounter = new ConsecutiveTargetRampEncounter({ commands });
    encounter.stepMany(state.tick);
    if (canonicalJson(encounter.#state) !== canonicalJson(state)) {
      throw new TypeError("ramp snapshot state is not a causal execution");
    }
    return encounter;
  }
}
