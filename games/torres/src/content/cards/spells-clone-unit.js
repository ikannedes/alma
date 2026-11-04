import { DeckCycle } from "../../sim/deck.js";
import { ShieldFormEncounter } from "./shields-forms.js";

const RULE = "deployed-unit-echo-v1";
const VERSION = 1;
const RADIUS_MILLITILES = 3_000;
const CLONED_HEALTH = 1;
const MAX_ACTIONS = 1_000;
const MAX_COMMANDS = 512;
const MAX_DECKS = 2;
const MAX_ENTITIES = 2_048;
const MAX_INITIAL_ENTITIES = 256;
const MAX_SNAPSHOT_BYTES = 1_000_000;
const MAX_TICK = 1_000_000;
const MAX_COORDINATE = 1_000_000;

const SETUP_KEYS = ["cardId", "decks", "entities"];
const DECK_KEYS = ["deck", "ownerId", "seed"];
const ENTITY_KEYS = [
  "damage",
  "dead",
  "deployed",
  "health",
  "id",
  "kind",
  "maxHealth",
  "ownerId",
  "position",
  "sourceEntityId",
];
const POSITION_KEYS = ["x", "y"];
const CAST_KEYS = ["cardId", "center", "ownerId", "tick", "type"];
const ADVANCE_KEYS = ["ticks", "type"];
const SNAPSHOT_KEYS = ["actions", "rule", "setup", "version"];
const ADAPTER_KEYS = ["id", "ownerId", "position"];

const QUESTION_RECORDS = [
  ["effect.radius", "low_confidence", RADIUS_MILLITILES,
    "the common row's radius is unverified"],
  ["clone.health", "corpus_absent", CLONED_HEALTH,
    "effect-dependent health is absent from the common schema"],
  ["clone.maximum_health", "corpus_absent", CLONED_HEALTH,
    "effect-dependent maximum health is absent from the common schema"],
  ["clone.damage", "corpus_absent", "retain_source_damage",
    "effect-dependent damage is absent from the common schema"],
  ["clone.owner", "corpus_absent", "retain_source_owner",
    "materialized clone ownership is absent"],
  ["clone.kind", "corpus_absent", "unit",
    "materialized clone kind is absent"],
  ["clone.deployed", "corpus_absent", true,
    "materialized clone deployment state is absent"],
  ["clone.dead", "corpus_absent", false,
    "materialized clone lifecycle state is absent"],
  ["clone.attribution", "corpus_absent", "source_entity_id",
    "materialized clone attribution is absent"],
  ["eligibility.owner", "corpus_absent", "caster_owned_only",
    "effect ownership policy is absent"],
  ["eligibility.kind", "corpus_absent", "deployed_units_only",
    "unit and structure eligibility policy is absent"],
  ["eligibility.dead", "corpus_absent", "exclude_dead",
    "dead-entity eligibility is absent"],
  ["eligibility.undeployed", "corpus_absent", "exclude_undeployed",
    "pre-deployment eligibility is absent"],
  ["eligibility.existing_clone", "corpus_absent", "exclude_clones",
    "recursive clone eligibility is absent"],
  ["geometry.edge", "corpus_absent", "inclusive_radius",
    "radius-edge inclusion is absent"],
  ["geometry.position", "corpus_absent", "copy_source_position",
    "clone placement policy is absent"],
  ["identity", "corpus_absent", "monotonic_id_after_existing_max",
    "clone entity identity allocation is absent"],
  ["ordering.targets", "corpus_absent", "ascending_source_entity_id",
    "target materialization ordering is absent"],
  ["ordering.casts", "corpus_absent", "command_insertion_order",
    "same-boundary cast ordering is absent"],
  ["boundary.batch", "corpus_absent", "pre_boundary_snapshot",
    "simultaneous cast visibility is absent"],
  ["shield_form.mobile", "corpus_absent", "clone_current_mobile_unit",
    "shield and form clone interaction is absent"],
  ["shield_form.stationary", "corpus_absent", "exclude_structure_form",
    "stationary form clone interaction is absent"],
  ["cycle.rejection", "corpus_absent", "shared_deck_cycle_result",
    "effect behavior after rejected card play is absent"],
  ["cast.empty", "corpus_absent", "accepted_no_op",
    "accepted cast behavior with no eligible units is absent"],
  ["replay", "corpus_absent", "canonical_action_replay",
    "clone-effect replay representation is absent"],
].map(([key, confidence, value, reason]) => ({
  confidence,
  key,
  reason,
  status: "QUESTION",
  value,
}));

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
deepFreeze(QUESTION_RECORDS);

function clone(value) {
  return structuredClone(value);
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
    ) ||
    Object.getOwnPropertySymbols(value).length !== 0
  ) {
    throw new TypeError(`${label} must be a plain data object`);
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
  return Array.from({ length: value.length }, (_, index) =>
    descriptors[index].value);
}

function integer(value, minimum, maximum, label) {
  if (
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new TypeError(
      `${label} must be a safe integer from ${minimum} through ${maximum}`,
    );
  }
  return value;
}

function runtimeId(value, label) {
  if (
    !(
      (typeof value === "string" && value.length > 0) ||
      (Number.isSafeInteger(value) && value > 0)
    )
  ) {
    throw new TypeError(`${label} must be a runtime card id`);
  }
  return value;
}

function checkedPosition(value, label) {
  const position = exactRecord(value, POSITION_KEYS, label);
  return {
    x: integer(
      position.x,
      -MAX_COORDINATE,
      MAX_COORDINATE,
      `${label}.x`,
    ),
    y: integer(
      position.y,
      -MAX_COORDINATE,
      MAX_COORDINATE,
      `${label}.y`,
    ),
  };
}

function checkedEntity(value, index) {
  const label = `entities[${index}]`;
  const entity = exactRecord(value, ENTITY_KEYS, label);
  const kind = entity.kind;
  if (!["structure", "tower", "unit"].includes(kind)) {
    throw new TypeError(`${label}.kind is unsupported`);
  }
  if (typeof entity.dead !== "boolean" || typeof entity.deployed !== "boolean") {
    throw new TypeError(`${label} lifecycle flags must be booleans`);
  }
  const maxHealth = integer(
    entity.maxHealth,
    1,
    1_000_000_000,
    `${label}.maxHealth`,
  );
  const health = integer(entity.health, 0, maxHealth, `${label}.health`);
  if (entity.dead !== (health === 0)) {
    throw new TypeError(`${label}.dead must agree with health`);
  }
  const sourceEntityId = entity.sourceEntityId === null
    ? null
    : integer(
      entity.sourceEntityId,
      1,
      Number.MAX_SAFE_INTEGER,
      `${label}.sourceEntityId`,
    );
  return {
    damage: integer(entity.damage, 0, 1_000_000_000, `${label}.damage`),
    dead: entity.dead,
    deployed: entity.deployed,
    health,
    id: integer(entity.id, 1, Number.MAX_SAFE_INTEGER, `${label}.id`),
    kind,
    maxHealth,
    ownerId: integer(
      entity.ownerId,
      1,
      Number.MAX_SAFE_INTEGER,
      `${label}.ownerId`,
    ),
    position: checkedPosition(entity.position, `${label}.position`),
    sourceEntityId,
  };
}

function checkedDeck(value, index) {
  const label = `decks[${index}]`;
  const record = exactRecord(value, DECK_KEYS, label);
  return {
    deck: denseArray(record.deck, 8, `${label}.deck`).map((cardId, cardIndex) =>
      runtimeId(cardId, `${label}.deck[${cardIndex}]`)),
    ownerId: integer(
      record.ownerId,
      1,
      Number.MAX_SAFE_INTEGER,
      `${label}.ownerId`,
    ),
    seed: record.seed,
  };
}

function checkedSetup(value) {
  const setup = exactRecord(value, SETUP_KEYS, "clone-unit setup");
  const decks = denseArray(setup.decks, MAX_DECKS, "decks")
    .map(checkedDeck);
  if (decks.length === 0 || new Set(decks.map(({ ownerId }) => ownerId)).size !== decks.length) {
    throw new TypeError("decks must contain unique owners");
  }
  const entities = denseArray(
    setup.entities,
    MAX_INITIAL_ENTITIES,
    "entities",
  ).map(checkedEntity);
  if (new Set(entities.map(({ id }) => id)).size !== entities.length) {
    throw new TypeError("entities must have unique ids");
  }
  const owners = new Set(decks.map(({ ownerId }) => ownerId));
  if (entities.some(({ ownerId }) => !owners.has(ownerId))) {
    throw new TypeError("every entity owner must have a deck");
  }

  const cardId = runtimeId(setup.cardId, "clone-unit setup.cardId");
  for (const [index, entry] of decks.entries()) {
    // DeckCycle is the authority for deck shape, uniqueness, seed, and shuffle.
    new DeckCycle({ deck: entry.deck, seed: entry.seed });
    if (!entry.deck.includes(cardId)) {
      throw new TypeError(`decks[${index}] must contain the effect card`);
    }
  }
  return clone({ cardId, decks, entities });
}

function checkedCast(value) {
  const command = exactRecord(value, CAST_KEYS, "cast command");
  if (command.type !== "cast") {
    throw new TypeError("cast command.type is unsupported");
  }
  return {
    cardId: runtimeId(command.cardId, "cast command.cardId"),
    center: checkedPosition(command.center, "cast command.center"),
    ownerId: integer(
      command.ownerId,
      1,
      Number.MAX_SAFE_INTEGER,
      "cast command.ownerId",
    ),
    tick: integer(command.tick, 0, MAX_TICK, "cast command.tick"),
    type: "cast",
  };
}

function checkedAdvance(value) {
  const command = exactRecord(value, ADVANCE_KEYS, "advance command");
  if (command.type !== "advance") {
    throw new TypeError("advance command.type is unsupported");
  }
  return {
    ticks: integer(command.ticks, 1, MAX_TICK, "advance command.ticks"),
    type: "advance",
  };
}

function checkedAction(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    throw new TypeError("clone-unit action must be a plain data object");
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, "type");
  if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
    throw new TypeError("clone-unit action.type must be a data property");
  }
  return descriptor.value === "cast"
    ? checkedCast(value)
    : descriptor.value === "advance"
      ? checkedAdvance(value)
      : (() => { throw new TypeError("clone-unit action.type is unsupported"); })();
}

function inRadius(entity, center) {
  const dx = BigInt(entity.position.x) - BigInt(center.x);
  const dy = BigInt(entity.position.y) - BigInt(center.y);
  return dx * dx + dy * dy <= BigInt(RADIUS_MILLITILES) ** 2n;
}

function eligible(entity, command) {
  return (
    entity.ownerId === command.ownerId &&
    entity.kind === "unit" &&
    entity.deployed &&
    !entity.dead &&
    entity.health > 0 &&
    entity.sourceEntityId === null &&
    inRadius(entity, command.center)
  );
}

function cloneDecks(decks) {
  return new Map([...decks.entries()].map(([ownerId, deck]) => [
    ownerId,
    DeckCycle.restore(deck.serialize()),
  ]));
}

function makeInitial(setup) {
  return {
    decks: new Map(setup.decks.map((entry) => [
      entry.ownerId,
      new DeckCycle({ deck: entry.deck, seed: entry.seed }),
    ])),
    entities: clone(setup.entities).sort((left, right) => left.id - right.id),
    events: [],
    pending: [],
    tick: 0,
  };
}

function snapshotMutable(mutable) {
  return {
    decks: cloneDecks(mutable.decks),
    entities: clone(mutable.entities),
    events: clone(mutable.events),
    pending: clone(mutable.pending),
    tick: mutable.tick,
  };
}

function resolveBoundary(mutable, setup, tick) {
  const commands = mutable.pending
    .filter((entry) => entry.command.tick === tick)
    .sort((left, right) => left.sequence - right.sequence);
  if (commands.length === 0) return [];

  const baseline = clone(mutable.entities)
    .sort((left, right) => left.id - right.id);
  const outcomes = [];
  for (const entry of commands) {
    const deck = mutable.decks.get(entry.command.ownerId);
    if (!deck) {
      outcomes.push({ event: {
        accepted: false,
        cardId: entry.command.cardId,
        commandSequence: entry.sequence,
        ownerId: entry.command.ownerId,
        reason: "unknown_owner",
        tick,
        type: "clone-cast",
      } });
      continue;
    }
    const play = deck.play(entry.command.cardId);
    if (!play.accepted || entry.command.cardId !== setup.cardId) {
      outcomes.push({ event: {
        accepted: false,
        cardId: entry.command.cardId,
        commandSequence: entry.sequence,
        deckEvent: play,
        ownerId: entry.command.ownerId,
        reason: play.accepted ? "not_effect_card" : play.reason,
        tick,
        type: "clone-cast",
      } });
      continue;
    }
    const sources = baseline.filter((entity) =>
      eligible(entity, entry.command));
    outcomes.push({
      plan: { command: entry.command, sequence: entry.sequence, sources },
    });
  }

  const cloneCount = outcomes.reduce(
    (total, outcome) => total + (outcome.plan?.sources.length ?? 0),
    0,
  );
  if (mutable.entities.length + cloneCount > MAX_ENTITIES) {
    throw new RangeError("clone-unit entity limit exceeded");
  }
  const maximumId = mutable.entities.reduce(
    (maximum, entity) => Math.max(maximum, entity.id),
    0,
  );
  if (cloneCount > Number.MAX_SAFE_INTEGER - maximumId) {
    throw new RangeError("clone-unit entity id space exhausted");
  }
  let nextId = maximumId + 1;

  const events = [];
  for (const outcome of outcomes) {
    if (outcome.event) {
      events.push(outcome.event);
      continue;
    }
    const { plan } = outcome;
    const createdIds = [];
    const sourceIds = [];
    for (const source of plan.sources) {
      const created = {
        damage: source.damage,
        dead: false,
        deployed: true,
        health: CLONED_HEALTH,
        id: nextId,
        kind: "unit",
        maxHealth: CLONED_HEALTH,
        ownerId: source.ownerId,
        position: clone(source.position),
        sourceEntityId: source.id,
      };
      nextId += 1;
      mutable.entities.push(created);
      createdIds.push(created.id);
      sourceIds.push(source.id);
      events.push({
        damage: created.damage,
        entityId: created.id,
        health: created.health,
        ownerId: created.ownerId,
        sourceEntityId: source.id,
        tick,
        type: "unit-cloned",
      });
    }
    events.push({
      accepted: true,
      cardId: plan.command.cardId,
      commandSequence: plan.sequence,
      createdIds,
      ownerId: plan.command.ownerId,
      reason: "accepted",
      sourceIds,
      tick,
      type: "clone-cast",
    });
  }
  mutable.entities.sort((left, right) => left.id - right.id);
  mutable.pending = mutable.pending.filter(
    (entry) => entry.command.tick !== tick,
  );
  return events;
}

function applyAdvance(mutable, setup, ticks) {
  if (ticks > MAX_TICK - mutable.tick) {
    throw new RangeError("clone-unit tick limit exceeded");
  }
  const target = mutable.tick + ticks;
  const boundaryTicks = [...new Set(mutable.pending
    .map(({ command }) => command.tick)
    .filter((tick) => tick > mutable.tick && tick <= target))]
    .sort((left, right) => left - right);
  const emitted = [];
  for (const tick of boundaryTicks) {
    emitted.push(...resolveBoundary(mutable, setup, tick));
  }
  mutable.tick = target;
  mutable.events.push(...clone(emitted));
  return emitted;
}

/**
 * Adapts the already-resolved CONTENT-007 fixture state into this effect's
 * deployed-entity input. Shield damage and form transitions remain owned by
 * ShieldFormEncounter; this module consumes only its current public state.
 */
export function createCloneUnitEntityFromShieldForm(encounter, identity) {
  const checkedIdentity = exactRecord(
    identity,
    ADAPTER_KEYS,
    "shield-form identity",
  );
  const resolved = typeof encounter === "string"
    ? ShieldFormEncounter.restore(encounter)
    : encounter;
  if (!(resolved instanceof ShieldFormEncounter)) {
    throw new TypeError("encounter must be a ShieldFormEncounter or snapshot");
  }
  const state = resolved.state;
  const currentHealth = state.form === "mobile"
    ? state.shield.currentHealth
    : state.body.currentHealth;
  const maxHealth = state.form === "mobile"
    ? state.shield.maxHealth
    : state.body.maxHealth;
  return checkedEntity({
    damage: state.combat.damage,
    dead: state.dead,
    deployed: true,
    health: currentHealth,
    id: checkedIdentity.id,
    kind: state.kind,
    maxHealth,
    ownerId: checkedIdentity.ownerId,
    position: checkedIdentity.position,
    sourceEntityId: null,
  }, 0);
}

export function getCloneUnitQuestionRecords() {
  return deepFreeze(clone(QUESTION_RECORDS));
}

export function getCloneUnitRules() {
  return deepFreeze({
    cloneHealth: CLONED_HEALTH,
    effectRadiusMillitiles: RADIUS_MILLITILES,
    fidelity: "question_fixture_pending_calibration",
    rule: RULE,
    version: VERSION,
  });
}

export class DeployedUnitCloneEncounter {
  #actions = [];
  #mutable;
  #setup;

  constructor(setup) {
    this.#setup = checkedSetup(setup);
    this.#mutable = makeInitial(this.#setup);
  }

  get replay() {
    return clone(this.#mutable.events);
  }

  get state() {
    return clone({
      decks: [...this.#mutable.decks.entries()]
        .sort(([left], [right]) => left - right)
        .map(([ownerId, deck]) => ({ ownerId, state: deck.state })),
      entities: this.#mutable.entities,
      pending: this.#mutable.pending.map(({ command }) => command),
      tick: this.#mutable.tick,
    });
  }

  scheduleCast(value) {
    const command = checkedCast(value);
    if (this.#actions.length >= MAX_ACTIONS) {
      throw new RangeError("clone-unit action limit exceeded");
    }
    if (this.#mutable.pending.length >= MAX_COMMANDS) {
      throw new RangeError("clone-unit pending command limit exceeded");
    }
    if (command.tick <= this.#mutable.tick) {
      throw new RangeError("cast command.tick must be a future boundary");
    }
    const sequence = this.#actions.filter(({ type }) => type === "cast").length;
    this.#mutable.pending.push({ command, sequence });
    this.#actions.push(command);
    return clone(command);
  }

  advanceTicks(ticks) {
    const command = checkedAdvance({ ticks, type: "advance" });
    if (this.#actions.length >= MAX_ACTIONS) {
      throw new RangeError("clone-unit action limit exceeded");
    }
    const staged = snapshotMutable(this.#mutable);
    const events = applyAdvance(staged, this.#setup, command.ticks);
    this.#mutable = staged;
    this.#actions.push(command);
    return clone(events);
  }

  serialize() {
    const serialized = canonicalJson({
      actions: this.#actions,
      rule: RULE,
      setup: this.#setup,
      version: VERSION,
    });
    if (serialized.length > MAX_SNAPSHOT_BYTES) {
      throw new RangeError("clone-unit snapshot exceeds its size bound");
    }
    return serialized;
  }

  static restore(serialized) {
    if (typeof serialized !== "string") {
      throw new TypeError("clone-unit snapshot must be a string");
    }
    if (serialized.length > MAX_SNAPSHOT_BYTES) {
      throw new RangeError("clone-unit snapshot exceeds its size bound");
    }
    let parsed;
    try {
      parsed = JSON.parse(serialized);
    } catch {
      throw new TypeError("clone-unit snapshot must be valid JSON");
    }
    const snapshot = exactRecord(
      parsed,
      SNAPSHOT_KEYS,
      "clone-unit snapshot",
    );
    if (snapshot.rule !== RULE || snapshot.version !== VERSION) {
      throw new TypeError("clone-unit snapshot identity is unsupported");
    }
    const actions = denseArray(
      snapshot.actions,
      MAX_ACTIONS,
      "clone-unit snapshot.actions",
    ).map(checkedAction);
    const encounter = new DeployedUnitCloneEncounter(snapshot.setup);
    for (const action of actions) {
      if (action.type === "cast") encounter.scheduleCast(action);
      else encounter.advanceTicks(action.ticks);
    }
    if (encounter.serialize() !== serialized) {
      throw new TypeError("clone-unit snapshot is not canonical");
    }
    return encounter;
  }
}
