import { createCardCatalog } from "../schema.js";

const CARD_DEFINITIONS = [{
  areaDamageRadiusMillitiles: 2500,
  components: [],
  cost: 2,
  count: 1,
  damage: 192,
  deployTimeTicks: null,
  displayName: "Static Burst",
  firstHitTicks: null,
  hitSpeedTicks: null,
  hitpoints: null,
  id: "static-burst",
  kind: "effect",
  movementMillitilesPerSecond: null,
  rangeMillitiles: null,
  rarity: "standard",
  sightRangeMillitiles: null,
  targetMode: "ground-and-air",
}];

const SOURCE = "unsourced-instantaneous-combat-reset-composition";
const MAX_COMMAND_TICK = 512;
const MAX_COMMANDS = 64;
const MAX_EVENTS = 4096;
const MAX_SNAPSHOT_BYTES = 262144;
const MAX_STEP_CHUNK = 1024;
const MAX_TICK = 1024;
const TARGET_HEALTH = 1_000_000;
const COMMAND_KEYS = ["sourceId", "targetId", "tick", "type"];
const COMMAND_TYPES = new Set([
  "acquire-target",
  "die",
  "interrupt",
  "reset",
  "reset-immune-target",
  "reset-ineligible-source",
  "reset-ineligible-target",
  "target-died",
]);
const RESET_TYPES = new Set([
  "reset",
  "reset-immune-target",
  "reset-ineligible-source",
  "reset-ineligible-target",
]);
const SETUP_KEYS = ["commands"];
const SNAPSHOT_KEYS = ["identity", "state", "version"];
const IDENTITY_KEYS = ["commands", "fixture"];
const STATE_KEYS = [
  "alive",
  "attackSequence",
  "commandIndex",
  "consecutiveHits",
  "history",
  "nextLaunchTick",
  "pendingContact",
  "phase",
  "stageIndex",
  "targetAlive",
  "targetHealth",
  "targetId",
  "tick",
];
const CONTACT_KEYS = [
  "amount",
  "contactTick",
  "sequence",
  "stageIndex",
  "targetId",
];
const EVENT_KEYS = {
  "attack-contact": [
    "amount",
    "healthAfter",
    "healthBefore",
    "sequence",
    "stageIndex",
    "targetId",
    "tick",
    "type",
  ],
  "attack-launched": [
    "amount",
    "contactTick",
    "sequence",
    "stageIndex",
    "targetId",
    "tick",
    "type",
  ],
  "combat-reset": [
    "applied",
    "reason",
    "sourceId",
    "targetId",
    "tick",
    "type",
  ],
  died: ["tick", "type"],
  interrupted: ["targetId", "tick", "type"],
  "stage-changed": [
    "consecutiveHits",
    "stageIndex",
    "targetId",
    "tick",
    "type",
  ],
  "target-acquired": ["targetId", "tick", "type"],
  "target-died": ["targetId", "tick", "type"],
};
const PHASES = new Set(["cadence", "contact", "dead", "idle", "windup"]);
const RESET_REASONS = new Set([
  "applied",
  "dead",
  "idle",
  "source-ineligible",
  "target-immune",
  "target-ineligible",
  "target-mismatch",
]);

const QUESTION_VALUES = {
  attackCadenceTicks: 8,
  attackReadyBoundary: "reset-command-wins-before-launch",
  buffCoupling: "deferred-no-buff-coupling-claim",
  cadenceRestart: "restart-full-first-hit-windup-from-reset-tick",
  chargeCoupling: "deferred-no-charge-coupling-claim",
  commandFirstPriority: "commands-before-contact-before-launch",
  commonAreaDamageRadiusMillitiles: 2500,
  commonCount: 1,
  commonDamage: 192,
  commonDeployTimeTicks: null,
  commonFirstHitTicks: null,
  commonHitSpeedTicks: null,
  commonHitpoints: null,
  commonMovementMillitilesPerSecond: null,
  commonRangeMillitiles: null,
  commonSightRangeMillitiles: null,
  commonTargetMode: "ground-and-air",
  contactDelayTicks: 2,
  deathPolicy: "source-combatant-death-clears-target-and-all-attack-state",
  delivery: "explicit-command-only-no-radius-projectile-or-spell-delivery-claim",
  firstHitWindupTicks: 6,
  hitCounterClearing: "set-consecutive-hits-to-zero",
  idleBehavior: "valid-reset-is-recorded-no-op-with-idle-reason",
  immunity: "explicit-immune-target-rejects-reset-without-state-change",
  instantaneousTick: "integer-command-boundary-no-duration",
  interruption: "clear-pending-ramp-and-restart-windup-retaining-target",
  pendingContactCancellation: "discard-launched-unresolved-contact",
  pendingLaunchCancellation: "discard-current-windup-or-cadence-deadline",
  rampDamageStages: [10, 20, 40],
  rampStageClearing: "set-stage-zero",
  rampStageThresholds: [0, 2, 4],
  repeatedResets: "latest-applied-reset-restarts-full-windup",
  sameBoundaryOrdering: "stable-command-first-then-contact-then-launch",
  slowCoupling: "deferred-no-slow-coupling-claim",
  snareCoupling: "deferred-no-snare-coupling-claim",
  sourceEligibility: "positive-safe-integer-explicitly-eligible-source",
  stunCoupling: "deferred-no-stun-coupling-claim",
  syntheticTargetHealth: TARGET_HEALTH,
  targetEligibility: "retained-living-explicitly-eligible-target",
  targetReacquisition: "none-reset-does-not-search-or-switch-target",
  targetRetention: "retain-same-stable-positive-safe-integer-target-id",
  ticksPerSecond: 60,
  windupRestart: "next-launch-at-reset-tick-plus-six",
};

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

function checkedId(value, label, nullable = false) {
  if (nullable && value === null) return;
  safeInteger(value, label, 1);
}

function checkedCommands(value) {
  const commands = denseArray(value, "reset commands", MAX_COMMANDS).map(
    (entry, index) => {
      const command = exactRecord(entry, COMMAND_KEYS, `reset command ${index}`);
      safeInteger(
        command.tick,
        `reset command ${index}.tick`,
        0,
        MAX_COMMAND_TICK - 1,
      );
      if (!COMMAND_TYPES.has(command.type)) {
        throw new TypeError(`reset command ${index}.type is invalid`);
      }
      if (command.type === "acquire-target") {
        checkedId(command.targetId, `reset command ${index}.targetId`);
        if (command.sourceId !== null) {
          throw new TypeError(`reset command ${index}.sourceId is inapplicable`);
        }
      } else if (RESET_TYPES.has(command.type)) {
        checkedId(command.sourceId, `reset command ${index}.sourceId`);
        checkedId(command.targetId, `reset command ${index}.targetId`);
      } else if (command.type === "target-died") {
        checkedId(command.targetId, `reset command ${index}.targetId`, true);
        if (command.sourceId !== null) {
          throw new TypeError(`reset command ${index}.sourceId is inapplicable`);
        }
      } else if (command.sourceId !== null || command.targetId !== null) {
        throw new TypeError(`reset command ${index} has inapplicable IDs`);
      }
      return {
        sourceId: command.sourceId,
        targetId: command.targetId,
        tick: command.tick,
        type: command.type,
      };
    },
  );
  let priorTick = -1;
  for (const command of commands) {
    if (command.tick <= priorTick) {
      throw new TypeError("reset commands must have unique increasing ticks");
    }
    priorTick = command.tick;
  }
  return commands;
}

function checkedSetup(value) {
  const setup = exactRecord(value, SETUP_KEYS, "reset setup");
  return { commands: checkedCommands(setup.commands) };
}

function stageForHits(hits) {
  let stageIndex = 0;
  for (
    let index = 1;
    index < QUESTION_VALUES.rampStageThresholds.length;
    index += 1
  ) {
    if (hits >= QUESTION_VALUES.rampStageThresholds[index]) stageIndex = index;
  }
  return stageIndex;
}

function checkedContact(value, label) {
  if (value === null) return null;
  const contact = exactRecord(value, CONTACT_KEYS, label);
  safeInteger(contact.amount, `${label}.amount`, 1);
  safeInteger(contact.contactTick, `${label}.contactTick`, 0, MAX_TICK);
  safeInteger(contact.sequence, `${label}.sequence`, 1, MAX_EVENTS);
  safeInteger(
    contact.stageIndex,
    `${label}.stageIndex`,
    0,
    QUESTION_VALUES.rampDamageStages.length - 1,
  );
  checkedId(contact.targetId, `${label}.targetId`);
  if (
    contact.amount !==
    QUESTION_VALUES.rampDamageStages[contact.stageIndex]
  ) {
    throw new TypeError(`${label}.amount does not match its stage`);
  }
  return { ...contact };
}

function checkedEvent(value, index) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`reset history event ${index} has an invalid shape`);
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, "type");
  if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) {
    throw new TypeError(`reset history event ${index}.type must be data`);
  }
  const keys = EVENT_KEYS[descriptor.value];
  if (keys === undefined) {
    throw new TypeError(`reset history event ${index}.type is invalid`);
  }
  const event = exactRecord(value, keys, `reset history event ${index}`);
  safeInteger(event.tick, `reset history event ${index}.tick`, 0, MAX_TICK - 1);
  if (Object.hasOwn(event, "sourceId")) {
    checkedId(event.sourceId, `reset history event ${index}.sourceId`);
  }
  if (Object.hasOwn(event, "targetId")) {
    checkedId(event.targetId, `reset history event ${index}.targetId`, true);
  }
  for (const key of [
    "amount",
    "consecutiveHits",
    "contactTick",
    "healthAfter",
    "healthBefore",
    "sequence",
    "stageIndex",
  ]) {
    if (Object.hasOwn(event, key)) {
      safeInteger(event[key], `reset history event ${index}.${key}`);
    }
  }
  if (
    Object.hasOwn(event, "stageIndex") &&
    event.stageIndex >= QUESTION_VALUES.rampDamageStages.length
  ) {
    throw new TypeError(`reset history event ${index}.stageIndex is invalid`);
  }
  if (
    Object.hasOwn(event, "contactTick") &&
    event.contactTick > MAX_TICK
  ) {
    throw new TypeError(`reset history event ${index}.contactTick is invalid`);
  }
  if (Object.hasOwn(event, "applied") && typeof event.applied !== "boolean") {
    throw new TypeError(`reset history event ${index}.applied must be boolean`);
  }
  if (Object.hasOwn(event, "reason") && !RESET_REASONS.has(event.reason)) {
    throw new TypeError(`reset history event ${index}.reason is invalid`);
  }
  return event;
}

function initialState() {
  return {
    alive: true,
    attackSequence: 0,
    commandIndex: 0,
    consecutiveHits: 0,
    history: [],
    nextLaunchTick: null,
    pendingContact: null,
    phase: "idle",
    stageIndex: 0,
    targetAlive: false,
    targetHealth: null,
    targetId: null,
    tick: 0,
  };
}

function checkedState(value, commands, label = "reset state") {
  const state = exactRecord(value, STATE_KEYS, label);
  if (typeof state.alive !== "boolean" || typeof state.targetAlive !== "boolean") {
    throw new TypeError(`${label} liveness fields must be booleans`);
  }
  safeInteger(state.tick, `${label}.tick`, 0, MAX_TICK);
  safeInteger(state.commandIndex, `${label}.commandIndex`, 0, commands.length);
  safeInteger(state.attackSequence, `${label}.attackSequence`, 0, MAX_EVENTS);
  safeInteger(state.consecutiveHits, `${label}.consecutiveHits`, 0, MAX_TICK);
  safeInteger(
    state.stageIndex,
    `${label}.stageIndex`,
    0,
    QUESTION_VALUES.rampDamageStages.length - 1,
  );
  if (!PHASES.has(state.phase)) {
    throw new TypeError(`${label}.phase is invalid`);
  }
  checkedId(state.targetId, `${label}.targetId`, true);
  if (state.targetHealth !== null) {
    safeInteger(state.targetHealth, `${label}.targetHealth`, 1, TARGET_HEALTH);
  }
  if (state.nextLaunchTick !== null) {
    safeInteger(
      state.nextLaunchTick,
      `${label}.nextLaunchTick`,
      state.tick,
      MAX_TICK,
    );
  }
  const pendingContact = checkedContact(
    state.pendingContact,
    `${label}.pendingContact`,
  );
  const history = denseArray(
    state.history,
    `${label}.history`,
    MAX_EVENTS,
  ).map(checkedEvent);
  let priorEventTick = -1;
  for (const event of history) {
    if (event.tick < priorEventTick || event.tick >= state.tick) {
      throw new TypeError(`${label}.history is noncausal`);
    }
    priorEventTick = event.tick;
  }
  const expectedCommandIndex = commands.filter(
    (command) => command.tick < state.tick,
  ).length;
  if (state.commandIndex !== expectedCommandIndex) {
    throw new TypeError(`${label}.commandIndex is noncausal`);
  }
  if (state.consecutiveHits > state.attackSequence) {
    throw new TypeError(`${label} has more hits than launches`);
  }
  if (state.stageIndex !== stageForHits(state.consecutiveHits)) {
    throw new TypeError(`${label}.stageIndex does not match hit counter`);
  }
  const hasTarget = state.targetId !== null;
  if (
    hasTarget !== state.targetAlive ||
    hasTarget !== (state.targetHealth !== null)
  ) {
    throw new TypeError(`${label} target fields are inconsistent`);
  }
  if (!state.alive && (
    state.phase !== "dead" ||
    hasTarget ||
    state.nextLaunchTick !== null ||
    pendingContact !== null ||
    state.consecutiveHits !== 0 ||
    state.stageIndex !== 0
  )) {
    throw new TypeError(`${label} dead state is inconsistent`);
  }
  if (state.alive && !hasTarget && (
    state.phase !== "idle" ||
    state.nextLaunchTick !== null ||
    pendingContact !== null ||
    state.consecutiveHits !== 0 ||
    state.stageIndex !== 0
  )) {
    throw new TypeError(`${label} idle state is inconsistent`);
  }
  if (state.phase === "contact" && (
    pendingContact === null ||
    state.nextLaunchTick === null
  )) {
    throw new TypeError(`${label} contact phase is inconsistent`);
  }
  if (
    (state.phase === "windup" || state.phase === "cadence") &&
    (pendingContact !== null || state.nextLaunchTick === null)
  ) {
    throw new TypeError(`${label} attack countdown phase is inconsistent`);
  }
  if (pendingContact !== null && (
    pendingContact.targetId !== state.targetId ||
    pendingContact.sequence > state.attackSequence ||
    pendingContact.contactTick < state.tick ||
    pendingContact.contactTick > state.tick + QUESTION_VALUES.contactDelayTicks
  )) {
    throw new TypeError(`${label}.pendingContact is inconsistent`);
  }
  return {
    alive: state.alive,
    attackSequence: state.attackSequence,
    commandIndex: state.commandIndex,
    consecutiveHits: state.consecutiveHits,
    history,
    nextLaunchTick: state.nextLaunchTick,
    pendingContact,
    phase: state.phase,
    stageIndex: state.stageIndex,
    targetAlive: state.targetAlive,
    targetHealth: state.targetHealth,
    targetId: state.targetId,
    tick: state.tick,
  };
}

function clearCombatProgress(state) {
  state.consecutiveHits = 0;
  state.stageIndex = 0;
  state.pendingContact = null;
}

function restartRetainedTarget(state) {
  clearCombatProgress(state);
  if (state.alive && state.targetId !== null) {
    state.nextLaunchTick = state.tick + QUESTION_VALUES.firstHitWindupTicks;
    state.phase = "windup";
  } else {
    state.nextLaunchTick = null;
    state.phase = state.alive ? "idle" : "dead";
  }
}

function resetReason(state, command) {
  if (!state.alive) return "dead";
  if (state.targetId === null) return "idle";
  if (command.targetId !== state.targetId) return "target-mismatch";
  if (command.type === "reset-ineligible-source") return "source-ineligible";
  if (command.type === "reset-ineligible-target") return "target-ineligible";
  if (command.type === "reset-immune-target") return "target-immune";
  return "applied";
}

function applyCommand(state, command, events) {
  if (command.type === "acquire-target") {
    if (!state.alive) return false;
    if (state.targetId !== command.targetId) {
      clearCombatProgress(state);
      state.targetId = command.targetId;
      state.targetAlive = true;
      state.targetHealth = TARGET_HEALTH;
      state.nextLaunchTick = state.tick + QUESTION_VALUES.firstHitWindupTicks;
      state.phase = "windup";
      events.push({
        targetId: command.targetId,
        tick: state.tick,
        type: "target-acquired",
      });
    }
    return false;
  }
  if (RESET_TYPES.has(command.type)) {
    const reason = resetReason(state, command);
    const applied = reason === "applied";
    if (applied) restartRetainedTarget(state);
    events.push({
      applied,
      reason,
      sourceId: command.sourceId,
      targetId: command.targetId,
      tick: state.tick,
      type: "combat-reset",
    });
    return applied;
  }
  if (command.type === "target-died") {
    if (
      state.targetId !== null &&
      (command.targetId === null || command.targetId === state.targetId)
    ) {
      const targetId = state.targetId;
      clearCombatProgress(state);
      state.targetId = null;
      state.targetAlive = false;
      state.targetHealth = null;
      state.nextLaunchTick = null;
      state.phase = state.alive ? "idle" : "dead";
      events.push({ targetId, tick: state.tick, type: "target-died" });
      return true;
    }
    return false;
  }
  if (command.type === "interrupt") {
    if (state.alive) restartRetainedTarget(state);
    events.push({
      targetId: state.targetId,
      tick: state.tick,
      type: "interrupted",
    });
    return true;
  }
  state.alive = false;
  clearCombatProgress(state);
  state.targetId = null;
  state.targetAlive = false;
  state.targetHealth = null;
  state.nextLaunchTick = null;
  state.phase = "dead";
  events.push({ tick: state.tick, type: "died" });
  return true;
}

function advanceOne(state, commands) {
  if (state.tick >= MAX_TICK) return [];
  const events = [];
  let blockAttack = false;
  const command = commands[state.commandIndex];
  if (command?.tick === state.tick) {
    state.commandIndex += 1;
    blockAttack = applyCommand(state, command, events);
  }

  if (!blockAttack && state.pendingContact?.contactTick === state.tick) {
    const contact = state.pendingContact;
    state.pendingContact = null;
    if (
      state.alive &&
      state.targetAlive &&
      state.targetId === contact.targetId
    ) {
      const healthBefore = state.targetHealth;
      state.targetHealth = Math.max(1, healthBefore - contact.amount);
      events.push({
        amount: contact.amount,
        healthAfter: state.targetHealth,
        healthBefore,
        sequence: contact.sequence,
        stageIndex: contact.stageIndex,
        targetId: contact.targetId,
        tick: state.tick,
        type: "attack-contact",
      });
      state.consecutiveHits += 1;
      const stageIndex = stageForHits(state.consecutiveHits);
      if (stageIndex !== state.stageIndex) {
        state.stageIndex = stageIndex;
        events.push({
          consecutiveHits: state.consecutiveHits,
          stageIndex,
          targetId: state.targetId,
          tick: state.tick,
          type: "stage-changed",
        });
      }
      state.phase = "cadence";
    }
  }

  if (
    !blockAttack &&
    state.alive &&
    state.targetAlive &&
    state.pendingContact === null &&
    state.nextLaunchTick === state.tick &&
    state.tick < MAX_TICK - QUESTION_VALUES.contactDelayTicks
  ) {
    state.attackSequence += 1;
    const amount = QUESTION_VALUES.rampDamageStages[state.stageIndex];
    const contactTick = state.tick + QUESTION_VALUES.contactDelayTicks;
    state.pendingContact = {
      amount,
      contactTick,
      sequence: state.attackSequence,
      stageIndex: state.stageIndex,
      targetId: state.targetId,
    };
    state.nextLaunchTick = Math.min(
      MAX_TICK,
      state.tick + QUESTION_VALUES.attackCadenceTicks,
    );
    state.phase = "contact";
    events.push({
      amount,
      contactTick,
      sequence: state.attackSequence,
      stageIndex: state.stageIndex,
      targetId: state.targetId,
      tick: state.tick,
      type: "attack-launched",
    });
  } else if (
    !blockAttack &&
    state.alive &&
    state.targetAlive &&
    state.pendingContact === null &&
    state.nextLaunchTick === state.tick
  ) {
    state.nextLaunchTick = MAX_TICK;
    state.phase = "cadence";
  }

  if (state.history.length + events.length > MAX_EVENTS) {
    throw new RangeError("reset replay exceeds its event bound");
  }
  state.history.push(...clone(events));
  state.tick += 1;
  return events;
}

export function createResetSpecialCatalog() {
  return createCardCatalog(CARD_DEFINITIONS);
}

export function createResetQuestionRecords(...args) {
  if (args.length !== 0) {
    throw new TypeError("reset question records do not accept overrides");
  }
  const records = {};
  for (const [key, value] of Object.entries(QUESTION_VALUES)) {
    records[key] = questionRecord(key, value);
  }
  return deepFreeze(records);
}

export function createResetFixture(commands = []) {
  return clone(checkedSetup({ commands }));
}

/**
 * Bounded deterministic executable QUESTION composition. Commands resolve
 * before pending contact and launch. An applied reset retains the exact target,
 * cancels both attack phases, clears the ramp, and restarts full windup.
 */
export class InstantaneousCombatResetEncounter {
  #commands;
  #state;

  constructor(setup = createResetFixture()) {
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
    return this.stepMany(1);
  }

  stepMany(count) {
    safeInteger(count, "reset step count", 0, MAX_STEP_CHUNK);
    if (count > MAX_TICK - this.#state.tick) {
      throw new RangeError("reset step count exceeds the encounter bound");
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
    const serialized = canonicalJson({
      identity: {
        commands: this.#commands,
        fixture: "instantaneous-combat-reset-question-v1",
      },
      state: checkedState(this.#state, this.#commands),
      version: 1,
    });
    if (Buffer.byteLength(serialized, "utf8") > MAX_SNAPSHOT_BYTES) {
      throw new RangeError("reset snapshot exceeds its byte bound");
    }
    return serialized;
  }

  static restore(serialized) {
    if (typeof serialized !== "string") {
      throw new TypeError("reset snapshot must be a string");
    }
    if (Buffer.byteLength(serialized, "utf8") > MAX_SNAPSHOT_BYTES) {
      throw new RangeError("reset snapshot exceeds its byte bound");
    }
    let value;
    try {
      value = JSON.parse(serialized);
    } catch {
      throw new TypeError("reset snapshot must be valid JSON");
    }
    if (serialized !== canonicalJson(value)) {
      throw new TypeError("reset snapshot must be canonical duplicate-free JSON");
    }
    const snapshot = exactRecord(value, SNAPSHOT_KEYS, "reset snapshot");
    if (snapshot.version !== 1) {
      throw new TypeError("reset snapshot version is unsupported");
    }
    const identity = exactRecord(
      snapshot.identity,
      IDENTITY_KEYS,
      "reset snapshot.identity",
    );
    if (identity.fixture !== "instantaneous-combat-reset-question-v1") {
      throw new TypeError("reset snapshot fixture identity is invalid");
    }
    const commands = checkedCommands(identity.commands);
    const state = checkedState(snapshot.state, commands, "reset snapshot.state");
    const encounter = new InstantaneousCombatResetEncounter({ commands });
    encounter.stepMany(state.tick);
    if (canonicalJson(encounter.#state) !== canonicalJson(state)) {
      throw new TypeError("reset snapshot state is not a causal execution");
    }
    return encounter;
  }
}
