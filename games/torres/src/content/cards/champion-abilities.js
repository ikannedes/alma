import {
  ShieldFormEncounter,
} from "./shields-forms.js";
import {
  RecoilEncounter,
  createRecoilSpecialFixture,
} from "./special-movement-recoil.js";
import {
  ChargeSpecialEncounter,
  createChargeSpecialFixture,
} from "./special-movement-charge.js";
import {
  DashEncounter,
  createDashSpecialFixture,
} from "./special-movement-dash.js";
import {
  LeapKnockbackRetargetEncounter,
  createLeapKnockbackFixture,
} from "./special-movement-leap-knockback.js";
import {
  InstantaneousCombatResetEncounter,
  createResetFixture,
} from "./special-combat-reset.js";
import {
  InvisibilityRevealEncounter,
  createInvisibilityFixture,
} from "./combat-status-invisibility.js";
import {
  ReflectionEncounter,
  createReflectionSpecialFixture,
} from "./special-projectiles-reflection.js";
import { createCardCatalog } from "../schema.js";

const MAX_CHAMPIONS = 16;
const MAX_OWNERS = 8;
const MAX_COMMANDS = 256;
const MAX_TICK = 4096;
const MAX_STEP_CHUNK = 512;
const MAX_SNAPSHOT_BYTES = 524288;
const SETUP_KEYS = ["champions", "commands", "owners"];
const CHAMPION_KEYS = ["archetypeId", "entityId", "ownerId"];
const OWNER_KEYS = ["elixir", "id"];
const COMMAND_KEYS = ["entityId", "tick", "type"];
const SNAPSHOT_KEYS = ["identity", "state", "version"];
const IDENTITY_KEYS = ["fixture", "setup"];
const STATE_KEYS = ["champions", "commandIndex", "history", "owners", "tick"];
const CHAMPION_STATE_KEYS = [
  "activeUntilTick", "archetypeId", "cooldownUntilTick", "entityId",
  "life", "ownerId", "phase", "primitives",
];
const OWNER_STATE_KEYS = ["elixir", "id"];
const COMMAND_TYPES = new Set(["activate", "deploy", "die"]);
const COMMAND_ORDER = Object.freeze({ deploy: 0, activate: 1, die: 2 });

const DEFINITIONS = [{
  id: "iron-borer",
  displayName: "Iron Borer",
  cost: 4,
  kind: "unit",
  rarity: "heroic",
  hitpoints: 2300,
  damage: 40,
  hitSpeedTicks: 24,
  firstHitTicks: 42,
  deployTimeTicks: 60,
  rangeMillitiles: 1600,
  sightRangeMillitiles: 5500,
  movementMillitilesPerSecond: 1000,
  targetMode: "ground",
  count: 1,
  areaDamageRadiusMillitiles: null,
  components: [],
}, {
  id: "bone-regent",
  displayName: "Bone Regent",
  cost: 4,
  kind: "unit",
  rarity: "heroic",
  hitpoints: 2300,
  damage: 205,
  hitSpeedTicks: 96,
  firstHitTicks: 78,
  deployTimeTicks: 60,
  rangeMillitiles: 1200,
  sightRangeMillitiles: 5500,
  movementMillitilesPerSecond: 1000,
  targetMode: "ground",
  count: 1,
  areaDamageRadiusMillitiles: 1300,
  components: [],
}, {
  id: "dusk-ranger",
  displayName: "Dusk Ranger",
  cost: 5,
  kind: "unit",
  rarity: "heroic",
  hitpoints: 1000,
  damage: 225,
  hitSpeedTicks: 72,
  firstHitTicks: 54,
  deployTimeTicks: 60,
  rangeMillitiles: 5000,
  sightRangeMillitiles: 5500,
  movementMillitilesPerSecond: 1000,
  targetMode: "ground-and-air",
  count: 1,
  areaDamageRadiusMillitiles: null,
  components: [],
}, {
  id: "gilded-lancer",
  displayName: "Gilded Lancer",
  cost: 4,
  kind: "unit",
  rarity: "heroic",
  hitpoints: 1800,
  damage: 160,
  hitSpeedTicks: 54,
  firstHitTicks: 42,
  deployTimeTicks: 60,
  rangeMillitiles: 1200,
  sightRangeMillitiles: 5500,
  movementMillitilesPerSecond: 1000,
  targetMode: "ground",
  count: 1,
  areaDamageRadiusMillitiles: null,
  components: [],
}, {
  id: "aegis-sage",
  displayName: "Aegis Sage",
  cost: 5,
  kind: "unit",
  rarity: "heroic",
  hitpoints: 2000,
  damage: 140,
  hitSpeedTicks: 48,
  firstHitTicks: 36,
  deployTimeTicks: 60,
  rangeMillitiles: 1200,
  sightRangeMillitiles: 5500,
  movementMillitilesPerSecond: 1000,
  targetMode: "ground",
  count: 1,
  areaDamageRadiusMillitiles: null,
  components: [],
}];

const ARCHETYPES = Object.freeze({
  "aegis-sage": Object.freeze({
    abilityCost: 1, activeTicks: 4, adapter: "reflection",
    cooldownTicks: 6,
  }),
  "bone-regent": Object.freeze({
    abilityCost: 2, activeTicks: 3, adapter: "shield-form-reset",
    cooldownTicks: 7,
  }),
  "dusk-ranger": Object.freeze({
    abilityCost: 1, activeTicks: 5, adapter: "invisibility",
    cooldownTicks: 8,
  }),
  "gilded-lancer": Object.freeze({
    abilityCost: 1, activeTicks: 2, adapter: "charge-dash-leap",
    cooldownTicks: 5,
  }),
  "iron-borer": Object.freeze({
    abilityCost: 1, activeTicks: 3, adapter: "recoil-reset",
    cooldownTicks: 6,
  }),
});

const QUESTION_FIELDS = Object.freeze([
  "abilityCost",
  "activationDurationTicks",
  "cooldownTicks",
  "activationEligibility",
  "activationBoundaryOrder",
  "activeExpiryBoundary",
  "cooldownExpiryBoundary",
  "deathCancellation",
  "deployEligibility",
  "redeployState",
  "oneLivingChampionPerOwner",
  "simultaneousActivationOrder",
  "abilitySpecificCoupling",
]);
const UNVERIFIED_COMMON_FIELDS = Object.freeze([
  "hitpoints", "damage", "hitSpeedTicks", "firstHitTicks", "deployTimeTicks",
  "rangeMillitiles", "sightRangeMillitiles", "movementMillitilesPerSecond",
  "targetMode", "count",
]);

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

function denseArray(value, maximum, label) {
  if (
    !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > maximum
  ) throw new TypeError(`${label} must be a bounded plain array`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(descriptors).length !== value.length + 1 ||
    Array.from({ length: value.length }, (_, index) => index).some((index) =>
      !descriptors[index]?.enumerable ||
      !Object.hasOwn(descriptors[index], "value"))
  ) throw new TypeError(`${label} must contain dense data properties`);
  return Array.from({ length: value.length }, (_, index) =>
    descriptors[index].value);
}

function integer(value, label, minimum, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label} must be a bounded safe integer`);
  }
  return value;
}

function checkedSetup(value) {
  const raw = exactRecord(value, SETUP_KEYS, "champion setup");
  const owners = denseArray(raw.owners, MAX_OWNERS, "champion owners")
    .map((entry, index) => {
      const owner = exactRecord(entry, OWNER_KEYS, `champion owner ${index}`);
      return {
        elixir: integer(owner.elixir, `champion owner ${index}.elixir`, 0, 10),
        id: integer(owner.id, `champion owner ${index}.id`, 1),
      };
    }).sort((a, b) => a.id - b.id);
  if (new Set(owners.map(({ id }) => id)).size !== owners.length) {
    throw new TypeError("champion owner IDs must be unique");
  }
  const ownerIds = new Set(owners.map(({ id }) => id));
  const champions = denseArray(raw.champions, MAX_CHAMPIONS, "champions")
    .map((entry, index) => {
      const champion = exactRecord(
        entry, CHAMPION_KEYS, `champion ${index}`,
      );
      if (!Object.hasOwn(ARCHETYPES, champion.archetypeId)) {
        throw new TypeError(`champion ${index}.archetypeId is unsupported`);
      }
      const result = {
        archetypeId: champion.archetypeId,
        entityId: integer(champion.entityId, `champion ${index}.entityId`, 1),
        ownerId: integer(champion.ownerId, `champion ${index}.ownerId`, 1),
      };
      if (!ownerIds.has(result.ownerId)) {
        throw new TypeError(`champion ${index}.ownerId is unknown`);
      }
      return result;
    }).sort((a, b) => a.entityId - b.entityId);
  if (new Set(champions.map(({ entityId }) => entityId)).size !== champions.length) {
    throw new TypeError("champion entity IDs must be unique");
  }
  const championIds = new Set(champions.map(({ entityId }) => entityId));
  const commands = denseArray(raw.commands, MAX_COMMANDS, "champion commands")
    .map((entry, index) => {
      const command = exactRecord(entry, COMMAND_KEYS, `champion command ${index}`);
      if (!COMMAND_TYPES.has(command.type)) {
        throw new TypeError(`champion command ${index}.type is unsupported`);
      }
      integer(command.tick, `champion command ${index}.tick`, 0, MAX_TICK - 1);
      integer(command.entityId, `champion command ${index}.entityId`, 1);
      if (!championIds.has(command.entityId)) {
        throw new TypeError(`champion command ${index}.entityId is unknown`);
      }
      return { ...command };
    }).sort((a, b) => a.tick - b.tick ||
      a.entityId - b.entityId || COMMAND_ORDER[a.type] - COMMAND_ORDER[b.type]);
  const signatures = commands.map(canonicalJson);
  if (new Set(signatures).size !== signatures.length) {
    throw new TypeError("champion commands must be unique");
  }
  return { champions, commands, owners };
}

function initialState(setup) {
  return {
    champions: setup.champions.map((entry) => ({
      activeUntilTick: null,
      archetypeId: entry.archetypeId,
      cooldownUntilTick: null,
      entityId: entry.entityId,
      life: "undeployed",
      ownerId: entry.ownerId,
      phase: "unavailable",
      primitives: [],
    })),
    commandIndex: 0,
    history: [],
    owners: clone(setup.owners),
    tick: 0,
  };
}

function event(state, value) {
  state.history.push({
    ...value,
    sequence: state.history.length + 1,
    tick: state.tick,
  });
}

const PRIMITIVE_NAMES = Object.freeze({
  "aegis-sage": Object.freeze(["reflection"]),
  "bone-regent": Object.freeze(["shield-form", "reset"]),
  "dusk-ranger": Object.freeze(["invisibility"]),
  "gilded-lancer": Object.freeze(["charge", "dash", "leap"]),
  "iron-borer": Object.freeze(["recoil", "reset"]),
});

function createPrimitive(name) {
  if (name === "shield-form") return new ShieldFormEncounter();
  if (name === "recoil") {
    return new RecoilEncounter(createRecoilSpecialFixture());
  }
  if (name === "charge") {
    return new ChargeSpecialEncounter(createChargeSpecialFixture());
  }
  if (name === "dash") return new DashEncounter(createDashSpecialFixture());
  if (name === "leap") {
    return new LeapKnockbackRetargetEncounter(createLeapKnockbackFixture());
  }
  if (name === "reset") {
    return new InstantaneousCombatResetEncounter(createResetFixture());
  }
  if (name === "invisibility") {
    return new InvisibilityRevealEncounter(createInvisibilityFixture());
  }
  if (name === "reflection") {
    return new ReflectionEncounter(createReflectionSpecialFixture());
  }
  throw new TypeError("champion primitive is unsupported");
}

function restorePrimitive(name, serialized) {
  if (name === "shield-form") return ShieldFormEncounter.restore(serialized);
  if (name === "recoil") return RecoilEncounter.restore(serialized);
  if (name === "charge") return ChargeSpecialEncounter.restore(serialized);
  if (name === "dash") return DashEncounter.restore(serialized);
  if (name === "leap") {
    return LeapKnockbackRetargetEncounter.restore(serialized);
  }
  if (name === "reset") {
    return InstantaneousCombatResetEncounter.restore(serialized);
  }
  if (name === "invisibility") {
    return InvisibilityRevealEncounter.restore(serialized);
  }
  if (name === "reflection") return ReflectionEncounter.restore(serialized);
  throw new TypeError("champion primitive is unsupported");
}

function invokePrimitive(name, encounter, first) {
  if (name === "shield-form") {
    return first ? encounter.damage(892) : encounter.advanceTicks(1);
  }
  return encounter.stepMany(1);
}

function appendPrimitiveEvents(state, champion, primitive, values) {
  for (const primitiveEvent of values) {
    event(state, {
      archetypeId: champion.archetypeId,
      entityId: champion.entityId,
      ownerId: champion.ownerId,
      primitive: primitive.name,
      primitiveEvent,
      sourceActivationTick: primitive.source.activationTick,
      type: "primitive-event",
    });
  }
}

function activatePrimitives(state, champion) {
  champion.primitives = PRIMITIVE_NAMES[champion.archetypeId].map((name) => {
    const encounter = createPrimitive(name);
    const events = invokePrimitive(name, encounter, true);
    const primitive = {
      events: clone(events),
      name,
      serialized: encounter.serialize(),
      source: {
        activationTick: state.tick,
        archetypeId: champion.archetypeId,
        entityId: champion.entityId,
        ownerId: champion.ownerId,
      },
      state: encounter.state,
      status: "active",
    };
    appendPrimitiveEvents(state, champion, primitive, events);
    return primitive;
  });
}

function advancePrimitives(state, champion) {
  for (const primitive of champion.primitives) {
    if (
      primitive.status !== "active" ||
      primitive.source.activationTick === state.tick
    ) continue;
    const encounter = restorePrimitive(primitive.name, primitive.serialized);
    const events = invokePrimitive(primitive.name, encounter, false);
    primitive.events.push(...clone(events));
    primitive.serialized = encounter.serialize();
    primitive.state = encounter.state;
    appendPrimitiveEvents(state, champion, primitive, events);
  }
}

function setPrimitiveStatus(champion, status) {
  for (const primitive of champion.primitives) primitive.status = status;
}

function processCommand(state, command) {
  const champion = state.champions.find(({ entityId }) =>
    entityId === command.entityId);
  const owner = state.owners.find(({ id }) => id === champion.ownerId);
  const config = ARCHETYPES[champion.archetypeId];
  if (command.type === "deploy") {
    const anotherLives = state.champions.some((entry) =>
      entry.ownerId === champion.ownerId && entry.entityId !== champion.entityId &&
      entry.life === "alive");
    if (champion.life === "alive" || anotherLives) {
      event(state, {
        entityId: champion.entityId,
        reason: champion.life === "alive" ? "already-alive" : "owner-has-champion",
        type: "deploy-rejected",
      });
      return;
    }
    Object.assign(champion, {
      activeUntilTick: null,
      cooldownUntilTick: null,
      life: "alive",
      phase: "idle",
      primitives: [],
    });
    event(state, { entityId: champion.entityId, type: "deployed" });
    return;
  }
  if (command.type === "die") {
    if (champion.life !== "alive") {
      event(state, {
        entityId: champion.entityId, reason: "not-alive",
        type: "death-rejected",
      });
      return;
    }
    Object.assign(champion, {
      activeUntilTick: null,
      cooldownUntilTick: null,
      life: "dead",
      phase: "unavailable",
    });
    setPrimitiveStatus(champion, "cancelled");
    event(state, { entityId: champion.entityId, type: "died" });
    return;
  }
  let reason = null;
  if (champion.life !== "alive") reason = "not-alive";
  else if (champion.phase !== "idle") reason = champion.phase;
  else if (owner.elixir < config.abilityCost) reason = "insufficient-elixir";
  if (reason !== null) {
    event(state, {
      entityId: champion.entityId, reason, type: "activation-rejected",
    });
    return;
  }
  owner.elixir -= config.abilityCost;
  champion.phase = "active";
  champion.activeUntilTick = state.tick + config.activeTicks;
  champion.cooldownUntilTick =
    champion.activeUntilTick + config.cooldownTicks;
  event(state, {
    activeUntilTick: champion.activeUntilTick,
    adapter: config.adapter,
    cooldownUntilTick: champion.cooldownUntilTick,
    cost: config.abilityCost,
    elixirAfter: owner.elixir,
    entityId: champion.entityId,
    type: "activated",
  });
  activatePrimitives(state, champion);
}

function advanceOne(state, setup) {
  while (setup.commands[state.commandIndex]?.tick === state.tick) {
    processCommand(state, setup.commands[state.commandIndex]);
    state.commandIndex += 1;
  }
  for (const champion of state.champions) {
    if (champion.life === "alive" && champion.phase === "active") {
      advancePrimitives(state, champion);
    }
    if (
      champion.life === "alive" && champion.phase === "active" &&
      champion.activeUntilTick === state.tick
    ) {
      champion.phase = "cooldown";
      champion.activeUntilTick = null;
      setPrimitiveStatus(champion, "completed");
      event(state, { entityId: champion.entityId, type: "active-ended" });
    }
    if (
      champion.life === "alive" && champion.phase === "cooldown" &&
      champion.cooldownUntilTick === state.tick
    ) {
      champion.phase = "idle";
      champion.cooldownUntilTick = null;
      event(state, { entityId: champion.entityId, type: "cooldown-ended" });
    }
  }
  state.tick += 1;
}

function checkedCausalState(value, setup) {
  const raw = exactRecord(value, STATE_KEYS, "champion state");
  integer(raw.tick, "champion state.tick", 0, MAX_TICK);
  const rebuilt = initialState(setup);
  while (rebuilt.tick < raw.tick) advanceOne(rebuilt, setup);
  if (canonicalJson(raw) !== canonicalJson(rebuilt)) {
    throw new TypeError("champion snapshot state is not the canonical causal state");
  }
  return rebuilt;
}

function question(archetypeId, field, value) {
  return Object.freeze({
    archetypeId,
    authoritative: false,
    confidence: "unverified",
    disposition: "question",
    field,
    source: "absent-pre-cutoff-champion-ability-evidence",
    value,
  });
}

export function createChampionAbilityCatalog() {
  return createCardCatalog(DEFINITIONS);
}

export function createChampionAbilityQuestionRecords(...args) {
  if (args.length !== 0) {
    throw new TypeError("champion question records do not accept overrides");
  }
  const values = [];
  for (const [archetypeId, config] of Object.entries(ARCHETYPES)) {
    const byField = {
      abilityCost: config.abilityCost,
      activationDurationTicks: config.activeTicks,
      cooldownTicks: config.cooldownTicks,
      activationEligibility: "alive-deployed-idle-and-owner-can-pay",
      activationBoundaryOrder: "commands-before-active-and-cooldown-expiry",
      activeExpiryBoundary: "active-through-boundary-before-command-processing",
      cooldownExpiryBoundary: "idle-after-command-processing-on-expiry-boundary",
      deathCancellation: "death-clears-active-and-cooldown-without-refund",
      deployEligibility: "only-when-owner-has-no-other-living-champion",
      redeployState: "idle-with-no-carried-active-or-cooldown-state",
      oneLivingChampionPerOwner: "deploy-rejects-second-living-champion",
      simultaneousActivationOrder: "tick-then-stable-entity-id",
      abilitySpecificCoupling: config.adapter,
    };
    for (const field of QUESTION_FIELDS) {
      values.push(question(archetypeId, field, byField[field]));
    }
  }
  return Object.freeze(values);
}

export function createChampionMappedFieldQuestionRecords(...args) {
  if (args.length !== 0) {
    throw new TypeError(
      "champion mapped-field question records do not accept overrides",
    );
  }
  const records = [];
  for (const definition of DEFINITIONS) {
    const fields = definition.id === "bone-regent"
      ? [...UNVERIFIED_COMMON_FIELDS, "areaDamageRadiusMillitiles"]
      : UNVERIFIED_COMMON_FIELDS;
    for (const field of fields) {
      records.push(Object.freeze({
        archetypeId: definition.id,
        authoritative: false,
        confidence: "unverified",
        disposition: "question-backed-match",
        field,
        source: "cards.json unverified_fields",
        value: definition[field],
      }));
    }
  }
  return Object.freeze(records);
}

export function createChampionAbilityFixture(
  owners = [], champions = [], commands = [],
) {
  return clone(checkedSetup({ champions, commands, owners }));
}

/**
 * Compatibility view over the controller's real activation path. It cannot
 * execute primitives independently of a deployed and paid-for activation.
 */
export function probeChampionAbilityAdapters() {
  return Object.fromEntries(Object.keys(ARCHETYPES).map((archetypeId, index) => {
    const entityId = index + 1;
    const ownerId = index + 1;
    const controller = new ChampionAbilityController(createChampionAbilityFixture(
      [{ elixir: 10, id: ownerId }],
      [{ archetypeId, entityId, ownerId }],
      [
        { entityId, tick: 0, type: "deploy" },
        { entityId, tick: 1, type: "activate" },
      ],
    ));
    controller.stepMany(2);
    return [archetypeId, controller.state.champions[0].primitives];
  }));
}

export class ChampionAbilityController {
  #setup;
  #state;

  constructor(setup = createChampionAbilityFixture()) {
    this.#setup = checkedSetup(setup);
    this.#state = initialState(this.#setup);
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
    integer(count, "champion step count", 0, MAX_STEP_CHUNK);
    if (count > MAX_TICK - this.#state.tick) {
      throw new RangeError("champion step count exceeds the encounter bound");
    }
    const candidate = clone(this.#state);
    const historyStart = candidate.history.length;
    for (let index = 0; index < count; index += 1) {
      advanceOne(candidate, this.#setup);
    }
    this.#state = candidate;
    return clone(candidate.history.slice(historyStart));
  }

  serialize() {
    const serialized = canonicalJson({
      identity: {
        fixture: "champion-ability-controller-question-v1",
        setup: this.#setup,
      },
      state: this.#state,
      version: 1,
    });
    if (new TextEncoder().encode(serialized).byteLength > MAX_SNAPSHOT_BYTES) {
      throw new RangeError("champion snapshot exceeds its byte bound");
    }
    return serialized;
  }

  static restore(serialized) {
    if (typeof serialized !== "string") {
      throw new TypeError("champion snapshot must be a string");
    }
    if (new TextEncoder().encode(serialized).byteLength > MAX_SNAPSHOT_BYTES) {
      throw new RangeError("champion snapshot exceeds its byte bound");
    }
    let parsed;
    try {
      parsed = JSON.parse(serialized);
    } catch {
      throw new TypeError("champion snapshot must be valid JSON");
    }
    if (serialized !== canonicalJson(parsed)) {
      throw new TypeError("champion snapshot must be canonical duplicate-free JSON");
    }
    const snapshot = exactRecord(parsed, SNAPSHOT_KEYS, "champion snapshot");
    if (snapshot.version !== 1) {
      throw new TypeError("champion snapshot version is unsupported");
    }
    const identity = exactRecord(
      snapshot.identity, IDENTITY_KEYS, "champion snapshot identity",
    );
    if (identity.fixture !== "champion-ability-controller-question-v1") {
      throw new TypeError("champion snapshot fixture is unsupported");
    }
    const setup = checkedSetup(identity.setup);
    const state = checkedCausalState(snapshot.state, setup);
    const controller = new ChampionAbilityController(setup);
    controller.#state = state;
    return controller;
  }
}
