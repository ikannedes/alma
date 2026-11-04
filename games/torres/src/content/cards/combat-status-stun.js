import { createCardCatalog } from "../schema.js";

const CARD_DEFINITIONS = [{
  areaDamageRadiusMillitiles: null,
  components: [],
  cost: 4,
  count: 1,
  damage: 110,
  deployTimeTicks: 60,
  displayName: "Pulse Sentry",
  firstHitTicks: 6,
  hitSpeedTicks: 8,
  hitpoints: 1000,
  id: "pulse-sentry",
  kind: "unit",
  movementMillitilesPerSecond: 1000,
  rangeMillitiles: 5000,
  rarity: "uncommon",
  sightRangeMillitiles: 5500,
  targetMode: "ground-and-air",
}];

const SOURCE = "unsourced-timed-full-disable-stun-fixture";
const MAX_COMMANDS = 64;
const MAX_EVENTS = 4096;
const MAX_SNAPSHOT_BYTES = 131072;
const MAX_STEP_CHUNK = 4096;
const MAX_TICK = 4096;
const MAX_POSITION = 1_000_000;
const STARTING_HEALTH = 1000;
const COMMAND_KEYS = ["sourceId", "targetId", "tick", "type"];
const COMMAND_TYPES = new Set([
  "acquire-target",
  "die",
  "interrupt",
  "lose-target",
  "stun",
  "target-died",
]);
const SETUP_KEYS = ["commands"];
const SNAPSHOT_KEYS = ["identity", "state", "version"];
const IDENTITY_KEYS = ["commands", "fixture"];
const STATE_KEYS = [
  "alive",
  "attackPhase",
  "attackRemaining",
  "attackSequence",
  "commandIndex",
  "disabledThroughTick",
  "health",
  "history",
  "movementRemainder",
  "pendingContact",
  "position",
  "targetAlive",
  "targetHealth",
  "targetId",
  "tick",
];
const PENDING_KEYS = ["remaining", "sequence", "targetId"];
const EVENT_KEYS = {
  "attack-contact": ["healthAfter", "healthBefore", "sequence", "targetId", "tick", "type"],
  "attack-launched": ["contactDelayTicks", "sequence", "targetId", "tick", "type"],
  died: ["tick", "type"],
  interrupted: ["tick", "type"],
  moved: ["from", "tick", "to", "type"],
  "stun-applied": ["disabledThroughTick", "sourceId", "tick", "type"],
  "stun-expired": ["tick", "type"],
  "target-acquired": ["targetId", "tick", "type"],
  "target-died": ["targetId", "tick", "type"],
  "target-lost": ["targetId", "tick", "type"],
};

const QUESTION_VALUES = Object.freeze({
  applyTick: "command-boundary-immediate",
  attackCadenceBehavior: "pause-exact-remaining-boundaries",
  attackReadinessBehavior: "pause-exact-remaining-boundaries",
  commonAreaDamageRadius: null,
  commonBaseDamage: 110,
  commonCount: 1,
  commonDeployTicks: 60,
  commonFirstHitTicks: 6,
  commonHitCadenceTicks: 8,
  commonHitpoints: STARTING_HEALTH,
  commonMovementMillitilesPerSecond: 1000,
  commonRangeMillitiles: 5000,
  commonSightRangeMillitiles: 5500,
  commonTargetMode: "ground-and-air",
  contactDelayTicks: 2,
  contactBehavior: "pause-pending-contact-exact-remaining-boundaries",
  deathPolicy: "death-clears-disable-target-attack-and-pending-contact",
  durationTicks: 30,
  eligibility: "living-source-and-living-target-explicit-command",
  expiry: "inclusive-through-application-plus-duration-minus-one",
  healthPreservation: "stun-does-not-change-health",
  interruptionPolicy: "clear-pending-contact-and-rewind-windup-retain-disable-and-target",
  launchSnapshot: "target-id-and-sequence-copied-at-launch-pending-contact-pauses",
  movementPerTickPattern: "integer-millitiles-with-remainder-over-60",
  movementSuppression: "zero-displacement-and-preserve-remainder",
  reapply: "refresh-to-later-inclusive-expiry",
  refresh: "replace-current-expiry-only-when-new-expiry-is-later",
  resetCoupling: "outside-piece-nonclaim",
  sameBoundaryOrdering: "command-first-then-disable-gate-then-contact-attack-movement",
  sourceEligibility: "positive-safe-integer-source-id",
  stack: "single-state-no-stacking",
  simulationTicksPerSecond: 60,
  targetEligibility: "positive-safe-integer-retained-living-target-id",
  targetRetention: "preserve-stable-target-and-target-health",
  windupBehavior: "pause-exact-remaining-boundaries",
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
  const commands = denseArray(value, "stun commands", MAX_COMMANDS).map(
    (entry, index) => {
      const command = exactRecord(entry, COMMAND_KEYS, `stun command ${index}`);
      safeInteger(command.tick, `stun command ${index}.tick`, 0, MAX_TICK - 1);
      if (!COMMAND_TYPES.has(command.type)) {
        throw new TypeError(`stun command ${index}.type is invalid`);
      }
      if (command.type === "stun") {
        checkedId(command.sourceId, `stun command ${index}.sourceId`);
        if (command.tick > MAX_TICK - QUESTION_VALUES.durationTicks) {
          throw new TypeError(`stun command ${index}.tick cannot fit its duration`);
        }
        if (command.targetId !== null) {
          throw new TypeError(`stun command ${index}.targetId must be null`);
        }
      } else if (command.type === "acquire-target") {
        checkedId(command.targetId, `stun command ${index}.targetId`);
        if (command.sourceId !== null) {
          throw new TypeError(`stun command ${index}.sourceId must be null`);
        }
      } else if (command.type === "target-died") {
        checkedId(command.targetId, `stun command ${index}.targetId`, true);
        if (command.sourceId !== null) {
          throw new TypeError(`stun command ${index}.sourceId must be null`);
        }
      } else if (command.sourceId !== null || command.targetId !== null) {
        throw new TypeError(`stun command ${index} has inapplicable IDs`);
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
      throw new TypeError("stun commands must have unique increasing ticks");
    }
    prior = command.tick;
  }
  return commands;
}

function checkedSetup(value) {
  const setup = exactRecord(value, SETUP_KEYS, "stun setup");
  return { commands: checkedCommands(setup.commands) };
}

function checkedEvent(value, index) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`stun history event ${index} has an invalid shape`);
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, "type");
  if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) {
    throw new TypeError(`stun history event ${index}.type must be data`);
  }
  const keys = EVENT_KEYS[descriptor.value];
  if (keys === undefined) {
    throw new TypeError(`stun history event ${index}.type is invalid`);
  }
  const event = exactRecord(value, keys, `stun history event ${index}`);
  safeInteger(event.tick, `stun history event ${index}.tick`, 0, MAX_TICK - 1);
  for (const key of [
    "contactDelayTicks", "disabledThroughTick", "from", "healthAfter",
    "healthBefore", "sequence", "sourceId", "targetId", "to",
  ]) {
    if (Object.hasOwn(event, key)) {
      const minimum = ["sourceId", "targetId", "sequence"].includes(key) ? 1 : 0;
      safeInteger(event[key], `stun history event ${index}.${key}`, minimum);
    }
  }
  return event;
}

function checkedPending(value, label) {
  if (value === null) return null;
  const pending = exactRecord(value, PENDING_KEYS, label);
  safeInteger(pending.remaining, `${label}.remaining`, 1,
    QUESTION_VALUES.contactDelayTicks);
  safeInteger(pending.sequence, `${label}.sequence`, 1, MAX_EVENTS);
  checkedId(pending.targetId, `${label}.targetId`);
  return pending;
}

function initialState() {
  return {
    alive: true,
    attackPhase: "idle",
    attackRemaining: null,
    attackSequence: 0,
    commandIndex: 0,
    disabledThroughTick: null,
    health: STARTING_HEALTH,
    history: [],
    movementRemainder: 0,
    pendingContact: null,
    position: 0,
    targetAlive: false,
    targetHealth: null,
    targetId: null,
    tick: 0,
  };
}

function uncheckedAdvance(state, commands) {
  const tick = state.tick;
  if (tick >= MAX_TICK) return [];
  const events = [];
  const command = commands[state.commandIndex];
  if (command?.tick === tick) {
    state.commandIndex += 1;
    applyCommand(state, command, events);
  }

  const disabled = state.alive &&
    state.disabledThroughTick !== null &&
    tick <= state.disabledThroughTick;
  if (state.alive && !disabled) {
    if (state.pendingContact !== null) {
      state.pendingContact.remaining -= 1;
      if (state.pendingContact.remaining === 0) {
        const pending = state.pendingContact;
        state.pendingContact = null;
        if (state.targetAlive && state.targetId === pending.targetId) {
          const before = state.targetHealth;
          state.targetHealth = Math.max(0, before - QUESTION_VALUES.commonBaseDamage);
          events.push({
            healthAfter: state.targetHealth,
            healthBefore: before,
            sequence: pending.sequence,
            targetId: pending.targetId,
            tick,
            type: "attack-contact",
          });
          if (state.targetHealth === 0) clearTarget(state);
        }
      }
    }
    if (state.targetAlive && state.pendingContact === null) {
      if (state.attackRemaining > 0) state.attackRemaining -= 1;
      if (state.attackRemaining === 0) {
        state.attackSequence += 1;
        state.pendingContact = {
          remaining: QUESTION_VALUES.contactDelayTicks,
          sequence: state.attackSequence,
          targetId: state.targetId,
        };
        events.push({
          contactDelayTicks: QUESTION_VALUES.contactDelayTicks,
          sequence: state.attackSequence,
          targetId: state.targetId,
          tick,
          type: "attack-launched",
        });
        state.attackPhase = "cadence";
        state.attackRemaining = QUESTION_VALUES.commonHitCadenceTicks;
      }
    }
    const accumulated =
      state.movementRemainder + QUESTION_VALUES.commonMovementMillitilesPerSecond;
    const displacement = Math.floor(accumulated / 60);
    state.movementRemainder = accumulated % 60;
    if (state.position + displacement > MAX_POSITION) {
      throw new RangeError("stun movement exceeds its position bound");
    }
    state.position += displacement;
  }
  if (disabled && tick === state.disabledThroughTick) {
    events.push({ tick, type: "stun-expired" });
  }
  if (state.history.length + events.length > MAX_EVENTS) {
    throw new RangeError("stun replay exceeds its event bound");
  }
  state.history.push(...clone(events));
  state.tick += 1;
  return events;
}

function clearTarget(state) {
  state.targetAlive = false;
  state.targetHealth = null;
  state.targetId = null;
  state.attackPhase = "idle";
  state.attackRemaining = null;
  state.pendingContact = null;
}

function applyCommand(state, command, events) {
  if (command.type === "stun") {
    if (!state.alive) return;
    const expiry = state.tick + QUESTION_VALUES.durationTicks - 1;
    if (expiry >= MAX_TICK) {
      throw new RangeError("stun expiry exceeds the encounter bound");
    }
    state.disabledThroughTick = Math.max(
      state.disabledThroughTick ?? -1,
      expiry,
    );
    events.push({
      disabledThroughTick: state.disabledThroughTick,
      sourceId: command.sourceId,
      tick: state.tick,
      type: "stun-applied",
    });
    return;
  }
  if (command.type === "acquire-target") {
    if (!state.alive) return;
    if (state.targetId !== command.targetId) {
      state.targetId = command.targetId;
      state.targetAlive = true;
      state.targetHealth = STARTING_HEALTH;
      state.attackPhase = "windup";
      state.attackRemaining = QUESTION_VALUES.commonFirstHitTicks;
      state.pendingContact = null;
      events.push({ targetId: command.targetId, tick: state.tick,
        type: "target-acquired" });
    }
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
      state.pendingContact = null;
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
    state.disabledThroughTick = null;
    clearTarget(state);
    events.push({ tick: state.tick, type: "died" });
  }
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
  safeInteger(state.position, `${label}.position`, 0, MAX_POSITION);
  safeInteger(state.movementRemainder, `${label}.movementRemainder`, 0, 59);
  checkedId(state.targetId, `${label}.targetId`, true);
  if (state.targetHealth !== null) {
    safeInteger(state.targetHealth, `${label}.targetHealth`, 1, STARTING_HEALTH);
  }
  if (state.disabledThroughTick !== null) {
    safeInteger(state.disabledThroughTick, `${label}.disabledThroughTick`, 0,
      MAX_TICK - 1);
  }
  if (!["idle", "windup", "cadence"].includes(state.attackPhase)) {
    throw new TypeError(`${label}.attackPhase is invalid`);
  }
  if (state.attackRemaining !== null) {
    safeInteger(state.attackRemaining, `${label}.attackRemaining`, 1,
      QUESTION_VALUES.commonHitCadenceTicks);
  }
  const pendingContact = checkedPending(
    state.pendingContact,
    `${label}.pendingContact`,
  );
  const history = denseArray(state.history, `${label}.history`, MAX_EVENTS)
    .map(checkedEvent);
  if (state.alive !== (state.health > 0)) {
    throw new TypeError(`${label} health and life state disagree`);
  }
  if (state.targetAlive !== (state.targetId !== null) ||
      state.targetAlive !== (state.targetHealth !== null)) {
    throw new TypeError(`${label} target state is inconsistent`);
  }
  if (!state.targetAlive && (
    state.attackPhase !== "idle" ||
    state.attackRemaining !== null ||
    pendingContact !== null
  )) {
    throw new TypeError(`${label} inactive target retains attack state`);
  }
  if (state.targetAlive && (
    state.attackPhase === "idle" ||
    state.attackRemaining === null ||
    (pendingContact !== null && pendingContact.targetId !== state.targetId)
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
    disabledThroughTick: state.disabledThroughTick,
    health: state.health,
    history,
    movementRemainder: state.movementRemainder,
    pendingContact,
    position: state.position,
    targetAlive: state.targetAlive,
    targetHealth: state.targetHealth,
    targetId: state.targetId,
    tick: state.tick,
  };
}

function replayState(commands, ticks) {
  const state = initialState();
  for (let index = 0; index < ticks; index += 1) uncheckedAdvance(state, commands);
  return state;
}

function checkedCausalState(value, commands, label = "stun state") {
  const checked = checkedStateShape(value, commands, label);
  const expected = replayState(commands, checked.tick);
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

export function createStunSpecialCatalog() {
  return createCardCatalog(CARD_DEFINITIONS);
}

export function createStunQuestionRecords(...args) {
  if (args.length !== 0) {
    throw new TypeError("stun question records do not accept overrides");
  }
  return deepFreeze(Object.fromEntries(
    Object.entries(QUESTION_VALUES).map(([key, value]) =>
      [key, questionRecord(key, value)]),
  ));
}

export function createStunFixture(commands = []) {
  return clone(checkedSetup({ commands }));
}

export class TimedFullDisableStunEncounter {
  #commands;
  #state;

  constructor(setup = createStunFixture()) {
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
    return clone(uncheckedAdvance(this.#state, this.#commands));
  }

  stepMany(count) {
    safeInteger(count, "stun step count", 0, MAX_STEP_CHUNK);
    if (count > MAX_TICK - this.#state.tick) {
      throw new RangeError("stun step count exceeds the encounter bound");
    }
    const candidate = checkedCausalState(this.#state, this.#commands);
    const events = [];
    for (let index = 0; index < count; index += 1) {
      events.push(...uncheckedAdvance(candidate, this.#commands));
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
        fixture: "timed-full-disable-stun-question-v1",
      },
      state: checkedCausalState(this.#state, this.#commands),
      version: 1,
    });
    if (Buffer.byteLength(serialized, "utf8") > MAX_SNAPSHOT_BYTES) {
      throw new RangeError("stun snapshot exceeds its byte bound");
    }
    return serialized;
  }

  static restore(serialized) {
    if (typeof serialized !== "string") {
      throw new TypeError("stun snapshot must be a string");
    }
    if (Buffer.byteLength(serialized, "utf8") > MAX_SNAPSHOT_BYTES) {
      throw new RangeError("stun snapshot exceeds its byte bound");
    }
    let value;
    try {
      value = JSON.parse(serialized);
    } catch {
      throw new TypeError("stun snapshot must be valid JSON");
    }
    if (serialized !== canonicalJson(value)) {
      throw new TypeError("stun snapshot must be canonical duplicate-free JSON");
    }
    const snapshot = exactRecord(value, SNAPSHOT_KEYS, "stun snapshot");
    if (snapshot.version !== 1) {
      throw new TypeError("stun snapshot version is unsupported");
    }
    const identity = exactRecord(
      snapshot.identity,
      IDENTITY_KEYS,
      "stun snapshot.identity",
    );
    if (identity.fixture !== "timed-full-disable-stun-question-v1") {
      throw new TypeError("stun snapshot fixture identity is invalid");
    }
    const commands = checkedCommands(identity.commands);
    const state = checkedCausalState(snapshot.state, commands, "stun snapshot.state");
    const encounter = new TimedFullDisableStunEncounter({ commands });
    encounter.#state = state;
    return encounter;
  }
}
