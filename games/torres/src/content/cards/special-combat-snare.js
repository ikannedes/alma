import { createCardCatalog } from "../schema.js";

const CARD_DEFINITIONS = [{
  areaDamageRadiusMillitiles: null,
  components: [],
  cost: 5,
  count: 1,
  damage: 266,
  deployTimeTicks: 60,
  displayName: "Tether Rider",
  firstHitTicks: 72,
  hitSpeedTicks: 108,
  hitpoints: 1767,
  id: "tether-rider",
  kind: "unit",
  movementMillitilesPerSecond: 1000,
  rangeMillitiles: 800,
  rarity: "mythic",
  sightRangeMillitiles: 7500,
  targetMode: "structures",
}];

const SOURCE = "unsourced-timed-movement-only-snare-fixture";
const MAX_COMMANDS = 64;
const MAX_EVENTS = 8192;
const MAX_POSITION = 1_000_000;
const MAX_SNAPSHOT_BYTES = 262144;
const MAX_STEP_CHUNK = 4096;
const MAX_TICK = 4096;
const STARTING_HEALTH = 1767;
const COMMAND_KEYS = ["sourceId", "targetId", "tick", "type"];
const COMMAND_TYPES = new Set([
  "acquire-target",
  "die",
  "interrupt",
  "lose-target",
  "snare",
  "target-died",
]);
const SETUP_KEYS = ["commands", "direction"];
const SNAPSHOT_KEYS = ["identity", "state", "version"];
const IDENTITY_KEYS = ["commands", "direction", "fixture"];
const STATE_KEYS = [
  "alive",
  "attackPhase",
  "attackRemaining",
  "attackSequence",
  "commandIndex",
  "health",
  "history",
  "movementRemainder",
  "pendingContacts",
  "position",
  "snaredThroughTick",
  "snareSourceId",
  "targetAlive",
  "targetId",
  "tick",
];
const CONTACT_KEYS = ["remaining", "sequence", "targetId"];
const EVENT_KEYS = {
  "attack-contact": ["sequence", "targetId", "tick", "type"],
  "attack-launched": ["contactDelayTicks", "sequence", "targetId", "tick", "type"],
  died: ["tick", "type"],
  interrupted: ["tick", "type"],
  moved: ["from", "tick", "to", "type"],
  "snare-applied": ["snaredThroughTick", "sourceId", "tick", "type"],
  "snare-expired": ["sourceId", "tick", "type"],
  "target-acquired": ["targetId", "tick", "type"],
  "target-died": ["targetId", "tick", "type"],
  "target-lost": ["targetId", "tick", "type"],
};

const QUESTION_VALUES = {
  applyBoundary: "command-first-immediate-at-integer-tick-boundary",
  attackAcquisitionBehavior: "unaffected",
  attackCadenceBehavior: "unaffected-original-integer-countdown",
  attackContactBehavior: "unaffected-original-integer-countdown",
  attackWindupBehavior: "unaffected-original-integer-countdown",
  cleansePolicy: "deferred-no-cleanse-claim",
  commonAreaDamageRadiusMillitiles: null,
  commonCount: 1,
  commonDamage: 266,
  commonDeployTimeTicks: 60,
  commonFirstHitTicks: 72,
  commonHitSpeedTicks: 108,
  commonHitpoints: 1767,
  commonMovementMillitilesPerSecond: 1000,
  commonRangeMillitiles: 800,
  commonSightRangeMillitiles: 7500,
  commonTargetMode: "structures",
  contactDelayTicks: 2,
  deathPolicy: "death-clears-snare-target-and-attack-state",
  delivery: "explicit-command-no-projectile-delivery-claim",
  durationTicks: 90,
  eligibility: "living-explicit-target-fixture-only",
  expiry: "inclusive-through-application-plus-duration-minus-one",
  expiryBoundaryOrder: "commands-then-attacks-then-snare-gated-movement-then-expiry-event",
  fullFidelity: "deferred",
  immunityPolicy: "deferred-no-immunity-claim",
  interruptionPolicy: "clear-contacts-and-restart-windup-retain-snare-and-target",
  movementRateWhileSnared: 0,
  movementRemainder: "preserve-exactly-with-no-accumulation-while-snared",
  rageComposition: "deferred-no-composition-claim",
  reapplyDifferentSource: "refresh-inclusive-expiry-and-replace-source",
  reapplySameSource: "refresh-inclusive-expiry",
  resetComposition: "deferred-no-reset-claim",
  sameBoundaryPriority: "stable-command-first-before-attack-and-movement",
  slowComposition: "deferred-no-composition-claim",
  source: "positive-safe-integer-command-source-id",
  sourceCadence: "explicit-command-only-no-cadence-claim",
  sourceReplacement: "most-recent-successful-application",
  stack: "single-status-nonstacking",
  stunComposition: "deferred-no-composition-claim",
  targetClasses: "deferred-no-class-eligibility-claim",
  targetRetention: "retain-current-stable-target",
  ticksPerSecond: 60,
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
  const commands = denseArray(value, "snare commands", MAX_COMMANDS).map(
    (entry, index) => {
      const command = exactRecord(entry, COMMAND_KEYS, `snare command ${index}`);
      safeInteger(command.tick, `snare command ${index}.tick`, 0, MAX_TICK - 1);
      if (!COMMAND_TYPES.has(command.type)) {
        throw new TypeError(`snare command ${index}.type is invalid`);
      }
      if (command.type === "snare") {
        checkedId(command.sourceId, `snare command ${index}.sourceId`);
        if (command.targetId !== null) {
          throw new TypeError(`snare command ${index}.targetId must be null`);
        }
        if (command.tick > MAX_TICK - QUESTION_VALUES.durationTicks) {
          throw new TypeError(`snare command ${index}.tick cannot fit its duration`);
        }
      } else if (command.type === "acquire-target") {
        checkedId(command.targetId, `snare command ${index}.targetId`);
        if (command.sourceId !== null) {
          throw new TypeError(`snare command ${index}.sourceId must be null`);
        }
      } else if (command.type === "target-died") {
        checkedId(command.targetId, `snare command ${index}.targetId`, true);
        if (command.sourceId !== null) {
          throw new TypeError(`snare command ${index}.sourceId must be null`);
        }
      } else if (command.sourceId !== null || command.targetId !== null) {
        throw new TypeError(`snare command ${index} has inapplicable IDs`);
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
    if (command.tick <= prior) {
      throw new TypeError("snare commands must have unique increasing ticks");
    }
    prior = command.tick;
  }
  return commands;
}

function checkedDirection(value, label = "snare direction") {
  if (value !== -1 && value !== 1) {
    throw new TypeError(`${label} must be -1 or 1`);
  }
  return value;
}

function checkedSetup(value) {
  const setup = exactRecord(value, SETUP_KEYS, "snare setup");
  return {
    commands: checkedCommands(setup.commands),
    direction: checkedDirection(setup.direction),
  };
}

function checkedContact(value, label) {
  const contact = exactRecord(value, CONTACT_KEYS, label);
  safeInteger(contact.remaining, `${label}.remaining`, 1,
    QUESTION_VALUES.contactDelayTicks);
  safeInteger(contact.sequence, `${label}.sequence`, 1, MAX_EVENTS);
  checkedId(contact.targetId, `${label}.targetId`);
  return contact;
}

function checkedEvent(value, index) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`snare history event ${index} has an invalid shape`);
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, "type");
  if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) {
    throw new TypeError(`snare history event ${index}.type must be data`);
  }
  const keys = EVENT_KEYS[descriptor.value];
  if (keys === undefined) {
    throw new TypeError(`snare history event ${index}.type is invalid`);
  }
  const event = exactRecord(value, keys, `snare history event ${index}`);
  safeInteger(event.tick, `snare history event ${index}.tick`, 0, MAX_TICK - 1);
  for (const key of [
    "contactDelayTicks", "sequence", "snaredThroughTick", "sourceId", "targetId",
  ]) {
    if (Object.hasOwn(event, key)) {
      const minimum = ["sequence", "sourceId", "targetId"].includes(key) ? 1 : 0;
      safeInteger(event[key], `snare history event ${index}.${key}`, minimum);
    }
  }
  for (const key of ["from", "to"]) {
    if (Object.hasOwn(event, key)) {
      safeInteger(event[key], `snare history event ${index}.${key}`,
        -MAX_POSITION, MAX_POSITION);
    }
  }
  return event;
}

function initialState() {
  return {
    alive: true,
    attackPhase: "idle",
    attackRemaining: null,
    attackSequence: 0,
    commandIndex: 0,
    health: STARTING_HEALTH,
    history: [],
    movementRemainder: 0,
    pendingContacts: [],
    position: 0,
    snaredThroughTick: null,
    snareSourceId: null,
    targetAlive: false,
    targetId: null,
    tick: 0,
  };
}

function clearTarget(state) {
  state.targetAlive = false;
  state.targetId = null;
  state.attackPhase = "idle";
  state.attackRemaining = null;
  state.pendingContacts = [];
}

function applyCommand(state, command, events) {
  if (command.type === "snare") {
    if (!state.alive) return;
    state.snaredThroughTick = state.tick + QUESTION_VALUES.durationTicks - 1;
    state.snareSourceId = command.sourceId;
    events.push({
      snaredThroughTick: state.snaredThroughTick,
      sourceId: command.sourceId,
      tick: state.tick,
      type: "snare-applied",
    });
    return;
  }
  if (command.type === "acquire-target") {
    if (!state.alive || state.targetId === command.targetId) return;
    state.targetAlive = true;
    state.targetId = command.targetId;
    state.attackPhase = "windup";
    state.attackRemaining = QUESTION_VALUES.commonFirstHitTicks;
    state.pendingContacts = [];
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
  if (command.type === "interrupt") {
    if (state.alive) {
      state.pendingContacts = [];
      if (state.targetAlive) {
        state.attackPhase = "windup";
        state.attackRemaining = QUESTION_VALUES.commonFirstHitTicks;
      }
      events.push({ tick: state.tick, type: "interrupted" });
    }
    return;
  }
  if (state.alive) {
    state.alive = false;
    state.health = 0;
    state.snaredThroughTick = null;
    state.snareSourceId = null;
    clearTarget(state);
    events.push({ tick: state.tick, type: "died" });
  }
}

function uncheckedAdvance(state, commands, direction) {
  const tick = state.tick;
  if (tick >= MAX_TICK) return [];
  const events = [];
  const command = commands[state.commandIndex];
  if (command?.tick === tick) {
    state.commandIndex += 1;
    applyCommand(state, command, events);
  }

  if (state.alive) {
    for (const pending of state.pendingContacts) pending.remaining -= 1;
    const contacting = state.pendingContacts.filter(({ remaining }) => remaining === 0);
    state.pendingContacts = state.pendingContacts.filter(({ remaining }) => remaining > 0);
    for (const pending of contacting) {
      if (state.targetAlive && state.targetId === pending.targetId) {
        events.push({
          sequence: pending.sequence,
          targetId: pending.targetId,
          tick,
          type: "attack-contact",
        });
      }
    }
    if (state.targetAlive) {
      state.attackRemaining -= 1;
      if (state.attackRemaining === 0) {
        state.attackSequence += 1;
        state.pendingContacts.push({
          remaining: QUESTION_VALUES.contactDelayTicks,
          sequence: state.attackSequence,
          targetId: state.targetId,
        });
        events.push({
          contactDelayTicks: QUESTION_VALUES.contactDelayTicks,
          sequence: state.attackSequence,
          targetId: state.targetId,
          tick,
          type: "attack-launched",
        });
        state.attackPhase = "cadence";
        state.attackRemaining = QUESTION_VALUES.commonHitSpeedTicks;
      }
    }

    const snared = state.snaredThroughTick !== null &&
      tick <= state.snaredThroughTick;
    if (!snared) {
      const accumulated = state.movementRemainder +
        QUESTION_VALUES.commonMovementMillitilesPerSecond;
      const magnitude = Math.floor(accumulated / QUESTION_VALUES.ticksPerSecond);
      state.movementRemainder = accumulated % QUESTION_VALUES.ticksPerSecond;
      const next = state.position + direction * magnitude;
      if (!Number.isSafeInteger(next) || Math.abs(next) > MAX_POSITION) {
        throw new RangeError("snare movement exceeds its position bound");
      }
      if (next !== state.position) {
        events.push({ from: state.position, tick, to: next, type: "moved" });
      }
      state.position = next;
    }
    if (snared && tick === state.snaredThroughTick) {
      events.push({ sourceId: state.snareSourceId, tick, type: "snare-expired" });
      state.snaredThroughTick = null;
      state.snareSourceId = null;
    }
  }
  if (state.history.length + events.length > MAX_EVENTS) {
    throw new RangeError("snare replay exceeds its event bound");
  }
  state.history.push(...clone(events));
  state.tick += 1;
  return events;
}

function checkedStateShape(value, commands, label) {
  const state = exactRecord(value, STATE_KEYS, label);
  if (typeof state.alive !== "boolean" || typeof state.targetAlive !== "boolean") {
    throw new TypeError(`${label} alive flags must be booleans`);
  }
  safeInteger(state.tick, `${label}.tick`, 0, MAX_TICK);
  safeInteger(state.commandIndex, `${label}.commandIndex`, 0, commands.length);
  safeInteger(state.attackSequence, `${label}.attackSequence`, 0, MAX_EVENTS);
  safeInteger(state.health, `${label}.health`, 0, STARTING_HEALTH);
  safeInteger(state.position, `${label}.position`, -MAX_POSITION, MAX_POSITION);
  safeInteger(state.movementRemainder, `${label}.movementRemainder`, 0, 59);
  checkedId(state.targetId, `${label}.targetId`, true);
  checkedId(state.snareSourceId, `${label}.snareSourceId`, true);
  if (state.snaredThroughTick !== null) {
    safeInteger(state.snaredThroughTick, `${label}.snaredThroughTick`, 0,
      MAX_TICK - 1);
  }
  if (!["idle", "windup", "cadence"].includes(state.attackPhase)) {
    throw new TypeError(`${label}.attackPhase is invalid`);
  }
  if (state.attackRemaining !== null) {
    safeInteger(state.attackRemaining, `${label}.attackRemaining`, 1,
      QUESTION_VALUES.commonHitSpeedTicks);
  }
  const pendingContacts = denseArray(
    state.pendingContacts,
    `${label}.pendingContacts`,
    MAX_COMMANDS,
  ).map((contact, index) =>
    checkedContact(contact, `${label}.pendingContacts[${index}]`));
  const history = denseArray(state.history, `${label}.history`, MAX_EVENTS)
    .map(checkedEvent);
  if (state.alive !== (state.health > 0)) {
    throw new TypeError(`${label} health and life state disagree`);
  }
  if ((state.snaredThroughTick === null) !== (state.snareSourceId === null)) {
    throw new TypeError(`${label} snare state is inconsistent`);
  }
  if (state.targetAlive !== (state.targetId !== null)) {
    throw new TypeError(`${label} target state is inconsistent`);
  }
  if (!state.targetAlive && (
    state.attackPhase !== "idle" ||
    state.attackRemaining !== null ||
    pendingContacts.length !== 0
  )) {
    throw new TypeError(`${label} inactive target retains attack state`);
  }
  if (state.targetAlive && (
    state.attackPhase === "idle" ||
    state.attackRemaining === null ||
    pendingContacts.some(({ targetId }) => targetId !== state.targetId)
  )) {
    throw new TypeError(`${label} active target attack state is inconsistent`);
  }
  const expectedCommandIndex = commands.filter(({ tick }) => tick < state.tick).length;
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
    attackRemaining: state.attackRemaining,
    attackSequence: state.attackSequence,
    commandIndex: state.commandIndex,
    health: state.health,
    history,
    movementRemainder: state.movementRemainder,
    pendingContacts,
    position: state.position,
    snaredThroughTick: state.snaredThroughTick,
    snareSourceId: state.snareSourceId,
    targetAlive: state.targetAlive,
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

function checkedCausalState(value, commands, direction, label = "snare state") {
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

export function createSnareSpecialCatalog() {
  return createCardCatalog(CARD_DEFINITIONS);
}

export function createSnareQuestionRecords(...args) {
  if (args.length !== 0) {
    throw new TypeError("snare question records do not accept overrides");
  }
  return deepFreeze(Object.fromEntries(
    Object.entries(QUESTION_VALUES).map(([key, value]) =>
      [key, questionRecord(key, value)]),
  ));
}

export function createSnareFixture(commands = [], direction = 1) {
  return clone(checkedSetup({ commands, direction }));
}

export class TimedMovementOnlySnareEncounter {
  #commands;
  #direction;
  #state;

  constructor(setup = createSnareFixture()) {
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
    return this.stepMany(1);
  }

  stepMany(count) {
    safeInteger(count, "snare step count", 0, MAX_STEP_CHUNK);
    if (count > MAX_TICK - this.#state.tick) {
      throw new RangeError("snare step count exceeds the encounter bound");
    }
    const candidate = checkedCausalState(
      this.#state,
      this.#commands,
      this.#direction,
    );
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
        fixture: "timed-movement-only-snare-question-v1",
      },
      state: checkedCausalState(
        this.#state,
        this.#commands,
        this.#direction,
      ),
      version: 1,
    });
    if (Buffer.byteLength(serialized, "utf8") > MAX_SNAPSHOT_BYTES) {
      throw new RangeError("snare snapshot exceeds its byte bound");
    }
    return serialized;
  }

  static restore(serialized) {
    if (typeof serialized !== "string") {
      throw new TypeError("snare snapshot must be a string");
    }
    if (Buffer.byteLength(serialized, "utf8") > MAX_SNAPSHOT_BYTES) {
      throw new RangeError("snare snapshot exceeds its byte bound");
    }
    let value;
    try {
      value = JSON.parse(serialized);
    } catch {
      throw new TypeError("snare snapshot must be valid JSON");
    }
    if (serialized !== canonicalJson(value)) {
      throw new TypeError("snare snapshot must be canonical duplicate-free JSON");
    }
    const snapshot = exactRecord(value, SNAPSHOT_KEYS, "snare snapshot");
    if (snapshot.version !== 1) {
      throw new TypeError("snare snapshot version is unsupported");
    }
    const identity = exactRecord(
      snapshot.identity,
      IDENTITY_KEYS,
      "snare snapshot.identity",
    );
    if (identity.fixture !== "timed-movement-only-snare-question-v1") {
      throw new TypeError("snare snapshot fixture identity is invalid");
    }
    const commands = checkedCommands(identity.commands);
    const direction = checkedDirection(
      identity.direction,
      "snare snapshot.identity.direction",
    );
    const state = checkedCausalState(
      snapshot.state,
      commands,
      direction,
      "snare snapshot.state",
    );
    const encounter = new TimedMovementOnlySnareEncounter({ commands, direction });
    encounter.#state = state;
    return encounter;
  }
}
