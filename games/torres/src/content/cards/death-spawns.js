import { SpawnBatchMaterializer } from "./spawn-placement.js";

const SOURCE = "unsourced-death-spawn-graph-policy-fixture";
const FIXTURE = "ashen-nest-death-spawn-question-v1";
const MAX_COMMANDS = 128;
const MAX_ENTITIES = 64;
const MAX_EVENTS = 4096;
const MAX_GRAPH_NODES = 64;
const MAX_SNAPSHOT_BYTES = 524_288;
const MAX_STEP_CHUNK = 512;
const MAX_TICK = 512;
const MAX_TRIGGERS = 64;
const COMMAND_KEYS = ["amount", "cause", "sourceId", "targetId", "tick"];
const SETUP_KEYS = ["commands", "entities"];
const ENTITY_KEYS = [
  "anchor",
  "archetypeId",
  "children",
  "health",
  "id",
  "ownerId",
  "periodic",
  "sourceId",
];
const CHILD_KEYS = [
  "archetypeId",
  "children",
  "health",
  "periodic",
  "radius",
  "role",
];
const PERIODIC_KEYS = [
  "cadenceTicks",
  "children",
  "initialDelayTicks",
  "lifetimeTicks",
];
const SNAPSHOT_KEYS = [
  "identity",
  "placementSnapshotBytes",
  "state",
  "version",
];
const IDENTITY_KEYS = ["fixture", "setup"];
const STATE_KEYS = [
  "batchCount",
  "commandIndex",
  "entities",
  "history",
  "latches",
  "tick",
];
const RUNTIME_ENTITY_KEYS = [
  "alive",
  "anchor",
  "archetypeId",
  "bornTick",
  "children",
  "health",
  "id",
  "ownerId",
  "periodic",
  "periodicBatchCount",
  "sourceId",
];
const CAUSES = new Set(["combat-damage", "despawn", "expiry"]);

export const DEATH_SPAWN_IDENTITY = deepFreeze({
  displayName: "Ashen Nest",
  id: "ashen-nest",
});

const DEFAULT_SETUP = deepFreeze({
  commands: [{
    amount: 120,
    cause: "combat-damage",
    sourceId: 900,
    targetId: 101,
    tick: 3,
  }],
  entities: [{
    anchor: { x: -600, y: 1400 },
    archetypeId: "ashen-nest",
    children: [
      {
        archetypeId: "coal-mite",
        children: [],
        health: 30,
        periodic: null,
        radius: 90,
        role: "primary",
      },
      {
        archetypeId: "coal-mite",
        children: [],
        health: 30,
        periodic: null,
        radius: 90,
        role: "secondary",
      },
    ],
    health: 120,
    id: 101,
    ownerId: 7,
    periodic: {
      cadenceTicks: 4,
      children: [{
        archetypeId: "soot-sprite",
        children: [],
        health: 20,
        periodic: null,
        radius: 60,
        role: "primary",
      }],
      initialDelayTicks: 3,
      lifetimeTicks: 11,
    },
    sourceId: 101,
  }],
});

const QUESTION_VALUES = deepFreeze({
  shippedIdentity: "ashen-nest-is-an-original-runtime-identity",
  benchmarkMapping: "historical-comparison-identities-exist-in-tests-only",
  parentHealth: 120,
  parentAnchor: { x: -600, y: 1400 },
  deathSpawnGraph:
    "each-source-carries-a-finite-recursive-child-specification",
  deathChildCount: 2,
  deathChildSpecifications:
    "two-ordered-coal-mite-specifications-in-the-default-fixture",
  eligibleLethalCauses: ["combat-damage"],
  exactlyOnceLatch: "one-per-source-entity-id",
  sourceRemovalOrder:
    "death-then-source-despawn-then-death-triggered-then-child-batch",
  simultaneousParentOrder: "ascending-source-entity-id",
  periodicBoundaryOrder:
    "expiry-then-command-and-death-fifo-then-living-periodic-due-batches",
  periodicInitialDelayTicks: 3,
  periodicCadenceTicks: 4,
  periodicLifetimeTicks: 11,
  priorPeriodicChildSurvival:
    "materialized-periodic-children-survive-their-source-death",
  futurePeriodicCancellation:
    "source-death-cancels-the-same-boundary-and-all-future-due-batches",
  recursionPolicy:
    "later-child-deaths-append-eligible-sources-to-one-fifo-by-death-id",
  recursionBound: MAX_TRIGGERS,
  eventBound: MAX_EVENTS,
  entityBound: MAX_ENTITIES,
  graphBound: MAX_GRAPH_NODES,
  initialIdNamespace:
    "setup-source-ids-exceed-the-maximum-runtime-child-entity-count",
  ownerAttribution: "children-inherit-the-dead-source-owner-id",
  sourceAttribution: "each-batch-uses-the-immediate-dead-source-entity-id",
  childOrder:
    "source-child-array-order-is-materializer-formation-and-id-order",
  idPolicy: "placement-materializer-monotonic-ids",
  anchorPolicy: "children-use-the-immediate-source-death-anchor",
  commandOrder: "tick-then-input-sequence-before-due-periodic-batches",
  zeroDamagePolicy: "zero-never-kills-or-contributes-a-lethal-cause",
  overkillPolicy:
    "first-positive-request-reaching-zero-owns-cause-and-later-requests-no-op",
  alreadyDeadPolicy: "later-commands-targeting-dead-entities-are-no-ops",
  snapshotPolicy:
    "canonical-state-history-latches-graphs-and-placement-must-equal-replay",
});

function deepFreeze(value) {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function clone(value) {
  return structuredClone(value);
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
    ) ||
    Object.getOwnPropertySymbols(value).length !== 0
  ) {
    throw new TypeError(`${label} must be a plain string-keyed object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const actual = Reflect.ownKeys(descriptors);
  if (
    actual.length !== keys.length ||
    actual.some((key) =>
      typeof key !== "string" ||
      !keys.includes(key) ||
      !descriptors[key].enumerable ||
      !Object.hasOwn(descriptors[key], "value")
    )
  ) {
    throw new TypeError(`${label} has an invalid shape`);
  }
  return Object.fromEntries(keys.map((key) => [key, descriptors[key].value]));
}

function denseArray(value, maximum, label, minimum = 0) {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length < minimum ||
    value.length > maximum ||
    Object.getOwnPropertySymbols(value).length !== 0
  ) {
    throw new TypeError(`${label} must be a bounded plain array`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(descriptors).length !== value.length + 1 ||
    Array.from({ length: value.length }, (_, index) => index).some((index) =>
      !descriptors[index]?.enumerable ||
      !Object.hasOwn(descriptors[index], "value")
    )
  ) {
    throw new TypeError(`${label} must contain only dense data properties`);
  }
  return Array.from({ length: value.length }, (_, index) =>
    descriptors[index].value
  );
}

function integer(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label} must be a bounded safe integer`);
  }
  return value;
}

function text(value, label) {
  let count = 0;
  if (typeof value === "string" && value.isWellFormed()) {
    for (const _point of value) {
      count += 1;
      if (count > 128) break;
    }
  }
  if (count < 1 || count > 128) {
    throw new TypeError(`${label} must be 1 to 128 Unicode code points`);
  }
  return value;
}

function checkedAnchor(value, label) {
  const anchor = exactRecord(value, ["x", "y"], label);
  return {
    x: integer(anchor.x, -1_000_000, 1_000_000, `${label}.x`),
    y: integer(anchor.y, -1_000_000, 1_000_000, `${label}.y`),
  };
}

function checkedPeriodic(value, tracker, label) {
  if (value === null) return null;
  if (tracker.seen.has(value)) {
    throw new TypeError(`${label} graph must not contain aliases or cycles`);
  }
  tracker.seen.add(value);
  const periodic = exactRecord(value, PERIODIC_KEYS, label);
  const initialDelayTicks = integer(
    periodic.initialDelayTicks, 1, MAX_TICK - 1, `${label}.initialDelayTicks`,
  );
  const cadenceTicks = integer(
    periodic.cadenceTicks, 1, MAX_TICK, `${label}.cadenceTicks`,
  );
  const lifetimeTicks = integer(
    periodic.lifetimeTicks, 1, MAX_TICK, `${label}.lifetimeTicks`,
  );
  return {
    cadenceTicks,
    children: checkedChildren(
      periodic.children, tracker, `${label}.children`, 1,
    ),
    initialDelayTicks,
    lifetimeTicks,
  };
}

function checkedChild(value, tracker, label) {
  if (tracker.seen.has(value)) {
    throw new TypeError(`${label} graph must not contain aliases or cycles`);
  }
  tracker.seen.add(value);
  tracker.count += 1;
  if (tracker.count > MAX_GRAPH_NODES) {
    throw new RangeError(`death spawn graph exceeds ${MAX_GRAPH_NODES} nodes`);
  }
  const child = exactRecord(value, CHILD_KEYS, label);
  const checked = {
    archetypeId: text(child.archetypeId, `${label}.archetypeId`),
    children: checkedChildren(child.children, tracker, `${label}.children`),
    health: integer(child.health, 1, Number.MAX_SAFE_INTEGER, `${label}.health`),
    periodic: checkedPeriodic(child.periodic, tracker, `${label}.periodic`),
    radius: integer(child.radius, 0, 1_000_000, `${label}.radius`),
    role: child.role,
  };
  if (checked.role !== "primary" && checked.role !== "secondary") {
    throw new TypeError(`${label}.role is invalid`);
  }
  return checked;
}

function checkedChildren(value, tracker, label, minimum = 0) {
  return denseArray(value, 15, label, minimum).map((entry, index) =>
    checkedChild(entry, tracker, `${label}[${index}]`)
  );
}

function checkedEntity(value, index, tracker) {
  const label = `death spawn entity ${index}`;
  if (tracker.seen.has(value)) {
    throw new TypeError(`${label} graph must not contain aliases or cycles`);
  }
  tracker.seen.add(value);
  const entity = exactRecord(value, ENTITY_KEYS, label);
  return {
    anchor: checkedAnchor(entity.anchor, `${label}.anchor`),
    archetypeId: text(entity.archetypeId, `${label}.archetypeId`),
    children: checkedChildren(entity.children, tracker, `${label}.children`),
    health: integer(entity.health, 1, Number.MAX_SAFE_INTEGER, `${label}.health`),
    id: integer(entity.id, 1, Number.MAX_SAFE_INTEGER, `${label}.id`),
    ownerId: integer(
      entity.ownerId, 1, Number.MAX_SAFE_INTEGER, `${label}.ownerId`,
    ),
    periodic: checkedPeriodic(entity.periodic, tracker, `${label}.periodic`),
    sourceId: integer(
      entity.sourceId, 1, Number.MAX_SAFE_INTEGER, `${label}.sourceId`,
    ),
  };
}

function checkedCommands(value) {
  const commands = denseArray(value, MAX_COMMANDS, "death spawn commands")
    .map((entry, sequence) => {
      const label = `death spawn command ${sequence}`;
      const command = exactRecord(entry, COMMAND_KEYS, label);
      if (!CAUSES.has(command.cause)) {
        throw new TypeError(`${label}.cause is invalid`);
      }
      return {
        amount: integer(
          command.amount, 0, Number.MAX_SAFE_INTEGER, `${label}.amount`,
        ),
        cause: command.cause,
        sequence,
        sourceId: command.sourceId === null
          ? null
          : integer(
            command.sourceId, 1, Number.MAX_SAFE_INTEGER, `${label}.sourceId`,
          ),
        targetId: integer(
          command.targetId, 1, Number.MAX_SAFE_INTEGER, `${label}.targetId`,
        ),
        tick: integer(command.tick, 0, MAX_TICK - 1, `${label}.tick`),
      };
    })
    .sort((left, right) =>
      left.tick - right.tick || left.sequence - right.sequence
    )
    .map(({ sequence: _sequence, ...command }) => command);
  const signatures = new Set();
  for (const command of commands) {
    const signature = canonicalJson(command);
    if (signatures.has(signature)) {
      throw new TypeError("death spawn commands must not contain duplicates");
    }
    signatures.add(signature);
  }
  return commands;
}

function checkedSetup(value) {
  const setup = exactRecord(value, SETUP_KEYS, "death spawn setup");
  const tracker = { count: 0, seen: new Set() };
  const entities = denseArray(
    setup.entities, MAX_ENTITIES, "death spawn entities", 1,
  ).map((entry, index) => checkedEntity(entry, index, tracker))
    .sort((left, right) => left.id - right.id);
  for (let index = 1; index < entities.length; index += 1) {
    if (entities[index - 1].id === entities[index].id) {
      throw new TypeError("death spawn entities must have unique IDs");
    }
  }
  if (entities.some(({ id }) => id <= MAX_ENTITIES)) {
    throw new TypeError(
      `death spawn setup source IDs must exceed child namespace ${MAX_ENTITIES}`,
    );
  }
  return { commands: checkedCommands(setup.commands), entities };
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

function runtimeEntity(spec, bornTick = 0) {
  return {
    alive: true,
    anchor: clone(spec.anchor),
    archetypeId: spec.archetypeId,
    bornTick,
    children: clone(spec.children),
    health: spec.health,
    id: spec.id,
    ownerId: spec.ownerId,
    periodic: clone(spec.periodic),
    periodicBatchCount: 0,
    sourceId: spec.sourceId,
  };
}

function initialState(setup) {
  return {
    batchCount: 0,
    commandIndex: 0,
    entities: setup.entities.map((entity) => runtimeEntity(entity)),
    history: [],
    latches: [],
    tick: 0,
  };
}

function childBatch(source, children) {
  return {
    anchor: clone(source.anchor),
    children: children.map(({ archetypeId, radius, role }) => ({
      archetypeId,
      radius,
      role,
    })),
    ownerId: source.ownerId,
    sourceId: source.id,
  };
}

function appendEvents(state, events) {
  if (state.history.length + events.length > MAX_EVENTS) {
    throw new RangeError(`death spawn event bound ${MAX_EVENTS} exceeded`);
  }
  state.history.push(...clone(events));
}

function materialize(
  state,
  materializer,
  source,
  children,
  kind,
  tick,
  events,
) {
  if (children.length === 0) return;
  if (state.entities.length + children.length > MAX_ENTITIES) {
    throw new RangeError(`death spawn entity bound ${MAX_ENTITIES} exceeded`);
  }
  const spawned = materializer.materialize(childBatch(source, children));
  const batchIndex = state.batchCount;
  state.batchCount += 1;
  events.push({
    anchor: clone(source.anchor),
    batchIndex,
    childIds: spawned.map(({ id }) => id),
    kind,
    ownerId: source.ownerId,
    sourceId: source.id,
    tick,
    type: "spawn-batch",
  });
  for (let index = 0; index < spawned.length; index += 1) {
    const placed = spawned[index];
    const spec = children[index];
    state.entities.push({
      alive: true,
      anchor: clone(placed.data.position),
      archetypeId: spec.archetypeId,
      bornTick: tick,
      children: clone(spec.children),
      health: spec.health,
      id: placed.id,
      ownerId: source.ownerId,
      periodic: clone(spec.periodic),
      periodicBatchCount: 0,
      sourceId: source.id,
    });
  }
  state.entities.sort((left, right) => left.id - right.id);
}

function kill(entity, cause, sourceId, tick, events, queue) {
  if (!entity.alive) return;
  entity.alive = false;
  entity.health = 0;
  events.push({
    cause,
    sourceId,
    targetId: entity.id,
    tick,
    type: "death",
  });
  events.push({ sourceId: entity.id, tick, type: "source-despawn" });
  if (cause === "combat-damage") queue.push(entity.id);
}

function applyCommands(state, commands, tick, events, queue) {
  const pendingDeaths = new Map();
  const virtualHealth = new Map(
    state.entities.map((entity) => [entity.id, entity.alive ? entity.health : 0]),
  );
  while (
    state.commandIndex < commands.length &&
    commands[state.commandIndex].tick === tick
  ) {
    const command = commands[state.commandIndex];
    state.commandIndex += 1;
    const target = state.entities.find(({ id }) => id === command.targetId);
    const before = virtualHealth.get(command.targetId) ?? 0;
    const applied = before > 0 ? Math.min(before, command.amount) : 0;
    const after = before - applied;
    events.push({
      amount: command.amount,
      applied,
      cause: command.cause,
      healthAfter: after,
      healthBefore: before,
      sourceId: command.sourceId,
      targetId: command.targetId,
      tick,
      type: "damage",
    });
    if (target?.alive) {
      virtualHealth.set(command.targetId, after);
      target.health = after;
    }
    if (
      target?.alive &&
      before > 0 &&
      after === 0 &&
      !pendingDeaths.has(target.id)
    ) {
      pendingDeaths.set(target.id, {
        cause: command.cause,
        sourceId: command.sourceId,
        target,
      });
    }
  }
  for (const { cause, sourceId, target } of [...pendingDeaths.values()]
    .sort((left, right) => left.target.id - right.target.id)) {
    kill(target, cause, sourceId, tick, events, queue);
  }
}

function drainDeaths(state, materializer, tick, events, queue) {
  queue.sort((left, right) => left - right);
  while (queue.length > 0) {
    const sourceId = queue.shift();
    if (state.latches.includes(sourceId)) continue;
    if (state.latches.length >= MAX_TRIGGERS) {
      throw new RangeError(`death spawn recursion bound ${MAX_TRIGGERS} exceeded`);
    }
    const source = state.entities.find(({ id }) => id === sourceId);
    if (source === undefined || source.alive) continue;
    state.latches.push(sourceId);
    events.push({ sourceId, tick, type: "death-triggered" });
    materialize(
      state,
      materializer,
      source,
      source.children,
      "death",
      tick,
      events,
    );
  }
}

function resolveExpiry(state, tick, events) {
  for (const source of state.entities) {
    if (
      source.alive &&
      source.periodic !== null &&
      tick === source.bornTick + source.periodic.lifetimeTicks
    ) {
      source.alive = false;
      source.health = 0;
      events.push({
        cause: "expiry",
        sourceId: null,
        targetId: source.id,
        tick,
        type: "death",
      });
      events.push({ sourceId: source.id, tick, type: "source-despawn" });
    }
  }
}

function resolvePeriodic(state, materializer, tick, events) {
  for (const source of [...state.entities].sort((a, b) => a.id - b.id)) {
    if (!source.alive || source.periodic === null) continue;
    const due = source.bornTick + source.periodic.initialDelayTicks +
      source.periodicBatchCount * source.periodic.cadenceTicks;
    if (tick === due) {
      materialize(
        state,
        materializer,
        source,
        source.periodic.children,
        "periodic",
        tick,
        events,
      );
      source.periodicBatchCount += 1;
    }
  }
}

function advance(state, setup, materializer) {
  if (state.tick >= MAX_TICK) return [];
  const tick = state.tick;
  const events = [];
  const queue = [];
  resolveExpiry(state, tick, events);
  applyCommands(state, setup.commands, tick, events, queue);
  drainDeaths(state, materializer, tick, events, queue);
  resolvePeriodic(state, materializer, tick, events);
  appendEvents(state, events);
  state.tick += 1;
  return events;
}

function replay(setup, ticks) {
  const state = initialState(setup);
  const materializer = new SpawnBatchMaterializer();
  for (let index = 0; index < ticks; index += 1) {
    advance(state, setup, materializer);
  }
  return { materializer, state };
}

function checkedState(value) {
  const state = exactRecord(value, STATE_KEYS, "death spawn snapshot.state");
  integer(state.tick, 0, MAX_TICK, "death spawn snapshot.state.tick");
  integer(
    state.commandIndex, 0, MAX_COMMANDS,
    "death spawn snapshot.state.commandIndex",
  );
  integer(state.batchCount, 0, 1024, "death spawn snapshot.state.batchCount");
  denseArray(
    state.entities, MAX_ENTITIES, "death spawn snapshot.state.entities", 1,
  ).forEach((entry, index) => {
    exactRecord(
      entry, RUNTIME_ENTITY_KEYS,
      `death spawn snapshot.state.entities[${index}]`,
    );
  });
  denseArray(state.history, MAX_EVENTS, "death spawn snapshot.state.history");
  const latches = denseArray(
    state.latches, MAX_TRIGGERS, "death spawn snapshot.state.latches",
  );
  for (let index = 0; index < latches.length; index += 1) {
    integer(
      latches[index], 1, Number.MAX_SAFE_INTEGER,
      `death spawn snapshot.state.latches[${index}]`,
    );
    if (index > 0 && latches.slice(0, index).includes(latches[index])) {
      throw new TypeError("death spawn snapshot latches must be unique");
    }
  }
  return clone(state);
}

function causal(setup, stateValue, placementSnapshotBytes) {
  const checked = checkedState(stateValue);
  if (typeof placementSnapshotBytes !== "string") {
    throw new TypeError("death spawn nested placement snapshot must be a string");
  }
  const nested = SpawnBatchMaterializer.restore(placementSnapshotBytes);
  const expected = replay(setup, checked.tick);
  if (
    canonicalJson(checked) !== canonicalJson(expected.state) ||
    nested.serialize() !== expected.materializer.serialize()
  ) {
    throw new TypeError(
      "death spawn snapshot state, graph, history, latches, or placement is forged",
    );
  }
  return { materializer: nested, state: checked };
}

export function createDeathSpawnQuestionRecords(...args) {
  if (args.length !== 0) {
    throw new TypeError("death spawn questions do not accept overrides");
  }
  return deepFreeze(Object.fromEntries(
    Object.entries(QUESTION_VALUES).map(([key, value]) => [
      key,
      questionRecord(key, value),
    ]),
  ));
}

export function createDeathSpawnFixture(
  entities = DEFAULT_SETUP.entities,
  commands = DEFAULT_SETUP.commands,
  ...extra
) {
  if (extra.length !== 0) {
    throw new TypeError("death spawn fixture received extra arguments");
  }
  return clone(checkedSetup({ commands, entities }));
}

export class DeathSpawnEncounter {
  #materializer;
  #setup;
  #state;

  constructor(setup = createDeathSpawnFixture()) {
    this.#setup = checkedSetup(setup);
    this.#materializer = new SpawnBatchMaterializer();
    this.#state = initialState(this.#setup);
  }

  get children() {
    return this.#materializer.list();
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
    integer(count, 0, MAX_STEP_CHUNK, "death spawn step count");
    if (count > MAX_TICK - this.#state.tick) {
      throw new RangeError("death spawn step count exceeds encounter bound");
    }
    const candidate = causal(
      this.#setup,
      this.#state,
      this.#materializer.serialize(),
    );
    const events = [];
    for (let index = 0; index < count; index += 1) {
      events.push(...advance(candidate.state, this.#setup, candidate.materializer));
    }
    const candidateBytes = canonicalJson({
      identity: { fixture: FIXTURE, setup: this.#setup },
      placementSnapshotBytes: candidate.materializer.serialize(),
      state: candidate.state,
      version: 1,
    });
    if (new TextEncoder().encode(candidateBytes).byteLength > MAX_SNAPSHOT_BYTES) {
      throw new RangeError("death spawn step would exceed snapshot byte bound");
    }
    this.#state = candidate.state;
    this.#materializer = candidate.materializer;
    return clone(events);
  }

  run() {
    return this.stepMany(MAX_TICK - this.#state.tick);
  }

  serialize() {
    const placementSnapshotBytes = this.#materializer.serialize();
    const checked = causal(this.#setup, this.#state, placementSnapshotBytes);
    const serialized = canonicalJson({
      identity: { fixture: FIXTURE, setup: this.#setup },
      placementSnapshotBytes: checked.materializer.serialize(),
      state: checked.state,
      version: 1,
    });
    if (new TextEncoder().encode(serialized).byteLength > MAX_SNAPSHOT_BYTES) {
      throw new RangeError("death spawn snapshot exceeds its byte bound");
    }
    return serialized;
  }

  static restore(serialized) {
    if (typeof serialized !== "string") {
      throw new TypeError("death spawn snapshot must be a string");
    }
    if (new TextEncoder().encode(serialized).byteLength > MAX_SNAPSHOT_BYTES) {
      throw new RangeError("death spawn snapshot exceeds its byte bound");
    }
    let raw;
    try {
      raw = JSON.parse(serialized);
    } catch {
      throw new TypeError("death spawn snapshot must be valid JSON");
    }
    if (canonicalJson(raw) !== serialized) {
      throw new TypeError("death spawn snapshot must use canonical bytes");
    }
    const snapshot = exactRecord(raw, SNAPSHOT_KEYS, "death spawn snapshot");
    if (snapshot.version !== 1) {
      throw new TypeError("death spawn snapshot version is unsupported");
    }
    const identity = exactRecord(
      snapshot.identity, IDENTITY_KEYS, "death spawn snapshot.identity",
    );
    if (identity.fixture !== FIXTURE) {
      throw new TypeError("death spawn snapshot fixture identity is invalid");
    }
    const setup = checkedSetup(identity.setup);
    const checked = causal(
      setup,
      snapshot.state,
      snapshot.placementSnapshotBytes,
    );
    const encounter = new DeathSpawnEncounter(setup);
    encounter.#state = checked.state;
    encounter.#materializer = checked.materializer;
    return encounter;
  }
}
