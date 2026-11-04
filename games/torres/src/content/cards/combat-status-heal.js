import { createCardCatalog } from "../schema.js";

const CARD_DEFINITIONS = [
  {
    areaDamageRadiusMillitiles: null,
    components: [],
    cost: 4,
    count: 1,
    damage: 148,
    deployTimeTicks: 60,
    displayName: "Dawnmender",
    firstHitTicks: 72,
    hitSpeedTicks: 90,
    hitpoints: 1717,
    id: "dawnmender",
    kind: "unit",
    movementMillitilesPerSecond: 1000,
    rangeMillitiles: 1600,
    rarity: "uncommon",
    sightRangeMillitiles: 5500,
    targetMode: "ground",
  },
  {
    areaDamageRadiusMillitiles: null,
    components: [],
    cost: 1,
    count: 1,
    damage: 110,
    deployTimeTicks: 60,
    displayName: "Bloom Wisp",
    firstHitTicks: 6,
    hitSpeedTicks: 18,
    hitpoints: 231,
    id: "bloom-wisp",
    kind: "unit",
    movementMillitilesPerSecond: 2000,
    rangeMillitiles: 2500,
    rarity: "uncommon",
    sightRangeMillitiles: 5500,
    targetMode: "ground-and-air",
  },
];

const SOURCE = "unsourced-instant-healing-and-health-cap-composition";
const ORDINARY_SOURCE =
  "royaleapi-cr-api-data-54fdef5-character-and-troop-snapshot-unverified";
const FIXTURE_ID = "instant-healing-and-health-cap-question-v1";
const MAX_COMMANDS = 128;
const MAX_ENTITIES = 64;
const MAX_EVENTS = 8192;
const MAX_SNAPSHOT_BYTES = 1048576;
const MAX_STEP_CHUNK = 4096;
const MAX_TICK = 4096;
const ENTITY_KINDS = new Set(["structure", "tower", "troop"]);
const COMMAND_TYPES = new Set(["damage", "heal"]);
const SETUP_KEYS = ["commands", "entities"];
const ENTITY_KEYS = ["currentHealth", "id", "kind", "maxHealth", "ownerId"];
const COMMAND_KEYS = ["amount", "sourceId", "targetId", "tick", "type"];
const SNAPSHOT_KEYS = ["identity", "state", "version"];
const IDENTITY_KEYS = ["commands", "entities", "fixture"];
const STATE_KEYS = ["commandIndex", "entities", "history", "tick"];
const EVENT_KEYS = {
  damage: [
    "amount",
    "currentHealthAfter",
    "currentHealthBefore",
    "targetId",
    "tick",
    "type",
  ],
  death: ["targetId", "tick", "type"],
  heal: [
    "applied",
    "currentHealthAfter",
    "currentHealthBefore",
    "requested",
    "sourceId",
    "status",
    "targetId",
    "tick",
    "type",
  ],
};
const HEAL_STATUSES = new Set([
  "applied",
  "enemy",
  "source-dead",
  "source-missing",
  "target-dead",
  "target-ineligible",
  "target-missing",
]);

const QUESTION_VALUES = {
  bloomWispCount: 1,
  bloomWispDamage: 110,
  bloomWispDeployTimeTicks: 60,
  bloomWispFirstHitTicks: 6,
  bloomWispHealAmount: 240,
  bloomWispHitSpeedTicks: 18,
  bloomWispHitpoints: 231,
  bloomWispMovementMillitilesPerSecond: 2000,
  bloomWispMovementSpeedLabel: "very_fast",
  bloomWispRangeMillitiles: 2500,
  bloomWispSightRangeMillitiles: 5500,
  bloomWispTargetMode: "ground-and-air",
  bloomWispTrigger: "explicit-instant-heal-command",
  boundaryOrder:
    "validate-due-commands-then-simultaneous-damage-then-ascending-id-deaths-then-heals-in-command-order",
  conversionCoupling: "deferred-no-conversion-coupling-claim",
  damageCoupling: "same-boundary-damage-and-death-resolve-before-healing",
  dawnmenderCount: 1,
  dawnmenderDamage: 148,
  dawnmenderDeployTimeTicks: 60,
  dawnmenderFirstHitTicks: 72,
  dawnmenderHealAmount: 120,
  dawnmenderHitSpeedTicks: 90,
  dawnmenderHitpoints: 1717,
  dawnmenderMovementMillitilesPerSecond: 1000,
  dawnmenderMovementSpeedLabel: "medium",
  dawnmenderRangeMillitiles: 1600,
  dawnmenderSightRangeMillitiles: 5500,
  dawnmenderTargetMode: "ground",
  dawnmenderTrigger: "explicit-instant-heal-command",
  deliveryRule: "explicit-source-target-command-no-radius-or-projectile-claim",
  duplicateHeals: "each-valid-command-resolves-in-stable-input-order",
  eligibleTargetClass: "living-troop-only",
  enemyTarget: "valid-no-op",
  invisibilityCoupling: "deferred-no-invisibility-coupling-claim",
  maximumHealthCap: "minimum-of-requested-and-max-health-minus-current-health",
  missingTarget: "valid-no-op",
  noRevivalRule: "zero-health-dead-targets-are-never-healed",
  ownershipRule: "source-and-target-owner-id-must-match",
  rageCoupling: "deferred-no-rage-coupling-claim",
  reflectionCoupling: "deferred-no-reflection-coupling-claim",
  selfHealRule: "living-troop-source-may-target-itself",
  sourceAliveRule: "source-must-exist-and-remain-alive-after-damage-phase",
  sourceDeathSameTick: "lethal-damage-cancels-all-later-source-heals",
  structureTarget: "valid-no-op",
  targetDeathSameTick: "lethal-damage-makes-later-heal-a-no-op",
  towerTarget: "valid-no-op",
  zeroAmount: "valid-command-that-applies-zero",
};
const ORDINARY_QUESTION_KEYS = new Set([
  "bloomWispCount",
  "bloomWispDamage",
  "bloomWispDeployTimeTicks",
  "bloomWispFirstHitTicks",
  "bloomWispHitSpeedTicks",
  "bloomWispHitpoints",
  "bloomWispMovementMillitilesPerSecond",
  "bloomWispMovementSpeedLabel",
  "bloomWispRangeMillitiles",
  "bloomWispSightRangeMillitiles",
  "bloomWispTargetMode",
  "dawnmenderCount",
  "dawnmenderDamage",
  "dawnmenderDeployTimeTicks",
  "dawnmenderFirstHitTicks",
  "dawnmenderHitSpeedTicks",
  "dawnmenderHitpoints",
  "dawnmenderMovementMillitilesPerSecond",
  "dawnmenderMovementSpeedLabel",
  "dawnmenderRangeMillitiles",
  "dawnmenderSightRangeMillitiles",
  "dawnmenderTargetMode",
]);

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

function checkedEntities(value, label = "heal entities") {
  const entities = denseArray(value, label, MAX_ENTITIES).map((entry, index) => {
    const entity = exactRecord(entry, ENTITY_KEYS, `${label}[${index}]`);
    safeInteger(entity.id, `${label}[${index}].id`, 1);
    safeInteger(entity.ownerId, `${label}[${index}].ownerId`, 1);
    safeInteger(entity.maxHealth, `${label}[${index}].maxHealth`, 1);
    safeInteger(
      entity.currentHealth,
      `${label}[${index}].currentHealth`,
      0,
      entity.maxHealth,
    );
    if (!ENTITY_KINDS.has(entity.kind)) {
      throw new TypeError(`${label}[${index}].kind is invalid`);
    }
    return { ...entity };
  });
  let previousId = 0;
  for (const entity of entities) {
    if (entity.id <= previousId) {
      throw new TypeError(`${label} must have unique ascending IDs`);
    }
    previousId = entity.id;
  }
  return entities;
}

function checkedCommands(value, label = "heal commands") {
  const commands = denseArray(value, label, MAX_COMMANDS).map((entry, index) => {
    const command = exactRecord(entry, COMMAND_KEYS, `${label}[${index}]`);
    safeInteger(command.tick, `${label}[${index}].tick`, 0, MAX_TICK - 1);
    safeInteger(command.targetId, `${label}[${index}].targetId`, 1);
    safeInteger(command.amount, `${label}[${index}].amount`);
    if (!COMMAND_TYPES.has(command.type)) {
      throw new TypeError(`${label}[${index}].type is invalid`);
    }
    if (command.type === "damage") {
      if (command.sourceId !== null) {
        throw new TypeError(`${label}[${index}].sourceId is inapplicable`);
      }
    } else {
      safeInteger(command.sourceId, `${label}[${index}].sourceId`, 1);
    }
    return { ...command };
  });
  let previousTick = -1;
  for (const command of commands) {
    if (command.tick < previousTick) {
      throw new TypeError(`${label} must have nondecreasing ticks`);
    }
    previousTick = command.tick;
  }
  return commands;
}

function checkedSetup(value) {
  const setup = exactRecord(value, SETUP_KEYS, "heal setup");
  return {
    commands: checkedCommands(setup.commands),
    entities: checkedEntities(setup.entities),
  };
}

function checkedEvent(value, index) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`heal history[${index}] has an invalid shape`);
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, "type");
  if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) {
    throw new TypeError(`heal history[${index}].type must be data`);
  }
  const keys = EVENT_KEYS[descriptor.value];
  if (keys === undefined) {
    throw new TypeError(`heal history[${index}].type is invalid`);
  }
  const event = exactRecord(value, keys, `heal history[${index}]`);
  safeInteger(event.tick, `heal history[${index}].tick`, 0, MAX_TICK - 1);
  safeInteger(event.targetId, `heal history[${index}].targetId`, 1);
  if (event.type === "death") return event;
  if (event.type === "damage") {
    safeInteger(event.amount, `heal history[${index}].amount`);
  } else {
    safeInteger(event.sourceId, `heal history[${index}].sourceId`, 1);
    safeInteger(event.requested, `heal history[${index}].requested`);
    safeInteger(event.applied, `heal history[${index}].applied`);
    if (!HEAL_STATUSES.has(event.status)) {
      throw new TypeError(`heal history[${index}].status is invalid`);
    }
    if (event.status !== "applied" && event.applied !== 0) {
      throw new TypeError(`heal history[${index}] no-op applied must be zero`);
    }
  }
  if (event.currentHealthBefore !== null) {
    safeInteger(
      event.currentHealthBefore,
      `heal history[${index}].currentHealthBefore`,
    );
  }
  if (event.currentHealthAfter !== null) {
    safeInteger(
      event.currentHealthAfter,
      `heal history[${index}].currentHealthAfter`,
    );
  }
  return event;
}

function checkedState(value, commands, label = "heal state") {
  const state = exactRecord(value, STATE_KEYS, label);
  safeInteger(state.tick, `${label}.tick`, 0, MAX_TICK);
  safeInteger(state.commandIndex, `${label}.commandIndex`, 0, commands.length);
  const entities = checkedEntities(state.entities, `${label}.entities`);
  const history = denseArray(state.history, `${label}.history`, MAX_EVENTS)
    .map(checkedEvent);
  if (
    state.commandIndex !==
    commands.findIndex((command) => command.tick >= state.tick) &&
    !(
      state.commandIndex === commands.length &&
      commands.every((command) => command.tick < state.tick)
    )
  ) {
    throw new TypeError(`${label}.commandIndex is inconsistent with tick`);
  }
  for (let index = 1; index < history.length; index += 1) {
    if (history[index].tick < history[index - 1].tick) {
      throw new TypeError(`${label}.history ticks must be nondecreasing`);
    }
  }
  return {
    commandIndex: state.commandIndex,
    entities,
    history,
    tick: state.tick,
  };
}

function questionRecord(key, value) {
  return deepFreeze({
    authoritative: false,
    confidence: "unverified",
    disposition: "question",
    key,
    source: ORDINARY_QUESTION_KEYS.has(key) ? ORDINARY_SOURCE : SOURCE,
    value: clone(value),
  });
}

function findEntity(entities, id) {
  let low = 0;
  let high = entities.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (entities[middle].id === id) return entities[middle];
    if (entities[middle].id < id) low = middle + 1;
    else high = middle - 1;
  }
  return null;
}

function healNoOp(command, target, status, tick) {
  return {
    applied: 0,
    currentHealthAfter: target?.currentHealth ?? null,
    currentHealthBefore: target?.currentHealth ?? null,
    requested: command.amount,
    sourceId: command.sourceId,
    status,
    targetId: command.targetId,
    tick,
    type: "heal",
  };
}

function advanceOne(state, commands) {
  const tick = state.tick;
  const start = state.commandIndex;
  let end = start;
  while (commands[end]?.tick === tick) end += 1;
  const due = commands.slice(start, end);

  // Revalidate the complete boundary before making any mutation.
  checkedCommands(due, `heal due commands at tick ${tick}`);
  const damageCommands = due.filter(({ type }) => type === "damage");
  const healCommands = due.filter(({ type }) => type === "heal");
  const preDamage = new Map(state.entities.map((entity) => [entity.id, {
    ...entity,
  }]));
  const totals = new Map();
  for (const command of damageCommands) {
    const target = preDamage.get(command.targetId);
    if (target !== undefined && target.currentHealth > 0) {
      const total = totals.get(target.id) ?? 0;
      if (command.amount > Number.MAX_SAFE_INTEGER - total) {
        throw new RangeError(
          `total damage for entity ${target.id} exceeds safe integer range`,
        );
      }
      totals.set(target.id, total + command.amount);
    }
  }

  const events = [];
  const cumulative = new Map();
  for (const command of damageCommands) {
    const target = preDamage.get(command.targetId);
    if (target === undefined || target.currentHealth === 0) continue;
    const prior = cumulative.get(target.id) ?? 0;
    const before = Math.max(0, target.currentHealth - prior);
    const after = Math.max(0, target.currentHealth - prior - command.amount);
    cumulative.set(target.id, prior + command.amount);
    events.push({
      amount: command.amount,
      currentHealthAfter: after,
      currentHealthBefore: before,
      targetId: target.id,
      tick,
      type: "damage",
    });
  }
  const deaths = [];
  for (const [id, amount] of [...totals].sort(([left], [right]) => left - right)) {
    const target = findEntity(state.entities, id);
    target.currentHealth = Math.max(0, target.currentHealth - amount);
    if (target.currentHealth === 0) {
      deaths.push({ targetId: id, tick, type: "death" });
    }
  }
  events.push(...deaths);

  for (const command of healCommands) {
    const source = findEntity(state.entities, command.sourceId);
    const target = findEntity(state.entities, command.targetId);
    if (source === null) {
      events.push(healNoOp(command, target, "source-missing", tick));
    } else if (source.currentHealth === 0) {
      events.push(healNoOp(command, target, "source-dead", tick));
    } else if (target === null) {
      events.push(healNoOp(command, target, "target-missing", tick));
    } else if (target.currentHealth === 0) {
      events.push(healNoOp(command, target, "target-dead", tick));
    } else if (target.ownerId !== source.ownerId) {
      events.push(healNoOp(command, target, "enemy", tick));
    } else if (target.kind !== "troop") {
      events.push(healNoOp(command, target, "target-ineligible", tick));
    } else {
      const before = target.currentHealth;
      const applied = Math.min(command.amount, target.maxHealth - before);
      target.currentHealth += applied;
      events.push({
        applied,
        currentHealthAfter: target.currentHealth,
        currentHealthBefore: before,
        requested: command.amount,
        sourceId: command.sourceId,
        status: "applied",
        targetId: command.targetId,
        tick,
        type: "heal",
      });
    }
  }
  if (state.history.length + events.length > MAX_EVENTS) {
    throw new RangeError("heal replay exceeds its event bound");
  }
  state.commandIndex = end;
  state.history.push(...clone(events));
  state.tick += 1;
  return events;
}

export function createHealCatalog() {
  return createCardCatalog(CARD_DEFINITIONS);
}

export function createHealQuestionRecords(...args) {
  if (args.length !== 0) {
    throw new TypeError("heal question records do not accept overrides");
  }
  const records = {};
  for (const [key, value] of Object.entries(QUESTION_VALUES)) {
    records[key] = questionRecord(key, value);
  }
  return deepFreeze(records);
}

export function createHealFixture(entities = [], commands = []) {
  return clone(checkedSetup({ commands, entities }));
}

export class InstantHealingEncounter {
  #commands;
  #initialEntities;
  #state;

  constructor(setup = createHealFixture()) {
    const checked = checkedSetup(setup);
    this.#commands = checked.commands;
    this.#initialEntities = checked.entities;
    this.#state = {
      commandIndex: 0,
      entities: clone(checked.entities),
      history: [],
      tick: 0,
    };
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
    safeInteger(count, "heal step count", 0, MAX_STEP_CHUNK);
    if (count > MAX_TICK - this.#state.tick) {
      throw new RangeError("heal step count exceeds the encounter bound");
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
    const lastTick = this.#commands.at(-1)?.tick ?? -1;
    return this.stepMany(Math.max(0, lastTick + 1 - this.#state.tick));
  }

  serialize() {
    const serialized = canonicalJson({
      identity: {
        commands: this.#commands,
        entities: this.#initialEntities,
        fixture: FIXTURE_ID,
      },
      state: checkedState(this.#state, this.#commands),
      version: 1,
    });
    if (Buffer.byteLength(serialized, "utf8") > MAX_SNAPSHOT_BYTES) {
      throw new RangeError("heal snapshot exceeds its byte bound");
    }
    return serialized;
  }

  static restore(serialized) {
    if (typeof serialized !== "string") {
      throw new TypeError("heal snapshot must be a string");
    }
    if (Buffer.byteLength(serialized, "utf8") > MAX_SNAPSHOT_BYTES) {
      throw new RangeError("heal snapshot exceeds its byte bound");
    }
    let value;
    try {
      value = JSON.parse(serialized);
    } catch {
      throw new TypeError("heal snapshot must be valid JSON");
    }
    if (serialized !== canonicalJson(value)) {
      throw new TypeError("heal snapshot must be canonical duplicate-free JSON");
    }
    const snapshot = exactRecord(value, SNAPSHOT_KEYS, "heal snapshot");
    if (snapshot.version !== 1) {
      throw new TypeError("heal snapshot version is unsupported");
    }
    const identity = exactRecord(
      snapshot.identity,
      IDENTITY_KEYS,
      "heal snapshot.identity",
    );
    if (identity.fixture !== FIXTURE_ID) {
      throw new TypeError("heal snapshot fixture identity is invalid");
    }
    const setup = checkedSetup({
      commands: identity.commands,
      entities: identity.entities,
    });
    const state = checkedState(snapshot.state, setup.commands, "heal snapshot.state");
    const encounter = new InstantHealingEncounter(setup);
    encounter.stepMany(state.tick);
    if (encounter.serialize() !== serialized) {
      throw new TypeError("heal snapshot state is not a causal execution");
    }
    return encounter;
  }
}
