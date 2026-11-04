import { SpawnBatchMaterializer } from "./spawn-placement.js";

const SOURCE = "unsourced-periodic-spawn-cadence-lifetime-fixture";
const FIXTURE_ID = "emberwell-periodic-spawn-question-v1";
const MAX_COMMANDS = 64;
const MAX_EVENTS = 1024;
const MAX_SNAPSHOT_BYTES = 262_144;
const MAX_STEP_CHUNK = 4096;
const MAX_TICK = 4096;
const COMMAND_KEYS = ["tick", "type"];
const SETUP_KEYS = ["commands"];
const SNAPSHOT_KEYS = [
  "identity",
  "placementSnapshotBytes",
  "state",
  "version",
];
const IDENTITY_KEYS = ["commands", "fixture", "schedule", "source"];
const SCHEDULE_KEYS = [
  "cadenceTicks",
  "initialDelayTicks",
  "lifetimeTicks",
];
const SOURCE_KEYS = ["anchor", "children", "ownerId", "sourceId"];
const STATE_KEYS = [
  "alive",
  "batchCount",
  "commandIndex",
  "endReason",
  "history",
  "nextDueTick",
  "tick",
];
const CHILD_KEYS = ["archetypeId", "radius", "role"];
const EVENT_KEYS = {
  "source-expired": ["sourceId", "tick", "type"],
  "source-killed": ["sourceId", "tick", "type"],
  "spawn-batch": [
    "anchor",
    "batchIndex",
    "childIds",
    "ownerId",
    "sourceId",
    "tick",
    "type",
  ],
};

export const PERIODIC_SPAWN_IDENTITY = deepFreeze({
  displayName: "Emberwell",
  id: "emberwell",
});

export const PERIODIC_SPAWN_TIMELINE = deepFreeze({
  cadenceTicks: 4,
  initialDelayTicks: 3,
  lifetimeTicks: 15,
});

const PERIODIC_SOURCE = deepFreeze({
  anchor: { x: 1200, y: -800 },
  children: [
    {
      archetypeId: "cinderling",
      radius: 100,
      role: "primary",
    },
    {
      archetypeId: "cinderling",
      radius: 100,
      role: "secondary",
    },
  ],
  ownerId: 17,
  sourceId: 73,
});

const QUESTION_VALUES = deepFreeze({
  absoluteSchedule:
    "due-tick-equals-initial-delay-plus-zero-based-batch-index-times-cadence",
  childCountPerBatch: 2,
  childOrder:
    "source-child-array-order-determines-formation-slot-then-monotonic-id-order",
  deathTriggeredSpawns: "none-in-periodic-only-encounter",
  expiryBoundary: "source-expiry-is-resolved-before-a-same-tick-due-batch",
  initialDelayTicks: PERIODIC_SPAWN_TIMELINE.initialDelayTicks,
  lethalCancellation:
    "lethal-command-cancels-same-tick-and-all-later-due-batches",
  ownership:
    "each-child-inherits-literal-owner-id-17-and-source-id-73",
  placement:
    "every-batch-delegates-to-spawn-batch-materializer-at-anchor-1200,-800",
  repeatedCadenceTicks: PERIODIC_SPAWN_TIMELINE.cadenceTicks,
  sameTickOrder: "expiry-then-command-then-periodic-due-batch",
  sourceLifetimeTicks: PERIODIC_SPAWN_TIMELINE.lifetimeTicks,
  summonRelationship:
    "emberwell-periodically-materializes-the-two-cinderling-child-specifications",
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
    )
  ) {
    throw new TypeError(`${label} must be a plain object`);
  }
  if (Object.getOwnPropertySymbols(value).length !== 0) {
    throw new TypeError(`${label} must contain only string-keyed data`);
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
    throw new TypeError(`${label} must contain only dense data properties`);
  }
  return Array.from(
    { length: value.length },
    (_, index) => descriptors[index].value,
  );
}

function safeInteger(
  value,
  label,
  minimum = 0,
  maximum = Number.MAX_SAFE_INTEGER,
) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label} must be a bounded safe integer`);
  }
  return value;
}

function checkedCommands(value) {
  const commands = denseArray(
    value,
    "periodic spawn commands",
    MAX_COMMANDS,
  ).map((entry, index) => {
    const command = exactRecord(
      entry,
      COMMAND_KEYS,
      `periodic spawn command ${index}`,
    );
    safeInteger(
      command.tick,
      `periodic spawn command ${index}.tick`,
      0,
      MAX_TICK - 1,
    );
    if (command.type !== "lethal") {
      throw new TypeError(`periodic spawn command ${index}.type is invalid`);
    }
    return { tick: command.tick, type: command.type };
  });
  let previousTick = -1;
  for (const command of commands) {
    if (command.tick <= previousTick) {
      throw new TypeError(
        "periodic spawn commands must have unique increasing ticks",
      );
    }
    previousTick = command.tick;
  }
  return commands;
}

function checkedSetup(value) {
  const setup = exactRecord(value, SETUP_KEYS, "periodic spawn setup");
  return { commands: checkedCommands(setup.commands) };
}

function checkedAnchor(value, label) {
  const anchor = exactRecord(value, ["x", "y"], label);
  safeInteger(anchor.x, `${label}.x`, -1_000_000, 1_000_000);
  safeInteger(anchor.y, `${label}.y`, -1_000_000, 1_000_000);
  return anchor;
}

function checkedSource(value, label) {
  const source = exactRecord(value, SOURCE_KEYS, label);
  const anchor = checkedAnchor(source.anchor, `${label}.anchor`);
  const children = denseArray(source.children, `${label}.children`, 15)
    .map((entry, index) => {
      const child = exactRecord(
        entry,
        CHILD_KEYS,
        `${label}.children[${index}]`,
      );
      if (
        typeof child.archetypeId !== "string" ||
        child.archetypeId.length < 1 ||
        child.archetypeId.length > 128 ||
        !child.archetypeId.isWellFormed()
      ) {
        throw new TypeError(
          `${label}.children[${index}].archetypeId is invalid`,
        );
      }
      safeInteger(
        child.radius,
        `${label}.children[${index}].radius`,
        0,
        1_000_000,
      );
      if (child.role !== "primary" && child.role !== "secondary") {
        throw new TypeError(`${label}.children[${index}].role is invalid`);
      }
      return child;
    });
  if (children.length !== QUESTION_VALUES.childCountPerBatch) {
    throw new TypeError(`${label}.children disagrees with the fixture count`);
  }
  safeInteger(source.ownerId, `${label}.ownerId`, 1);
  safeInteger(source.sourceId, `${label}.sourceId`, 1);
  return {
    anchor,
    children,
    ownerId: source.ownerId,
    sourceId: source.sourceId,
  };
}

function checkedSchedule(value, label) {
  const schedule = exactRecord(value, SCHEDULE_KEYS, label);
  for (const key of SCHEDULE_KEYS) {
    safeInteger(schedule[key], `${label}.${key}`, 1, MAX_TICK);
  }
  return schedule;
}

function checkedEvent(value, index) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`periodic spawn history event ${index} is invalid`);
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, "type");
  if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) {
    throw new TypeError(
      `periodic spawn history event ${index}.type must be data`,
    );
  }
  const keys = EVENT_KEYS[descriptor.value];
  if (keys === undefined) {
    throw new TypeError(`periodic spawn history event ${index}.type is invalid`);
  }
  const event = exactRecord(
    value,
    keys,
    `periodic spawn history event ${index}`,
  );
  safeInteger(event.tick, `periodic spawn history event ${index}.tick`, 0,
    MAX_TICK - 1);
  safeInteger(event.sourceId,
    `periodic spawn history event ${index}.sourceId`, 1);
  if (event.type === "spawn-batch") {
    checkedAnchor(
      event.anchor,
      `periodic spawn history event ${index}.anchor`,
    );
    safeInteger(event.batchIndex,
      `periodic spawn history event ${index}.batchIndex`, 0, MAX_EVENTS);
    safeInteger(event.ownerId,
      `periodic spawn history event ${index}.ownerId`, 1);
    const childIds = denseArray(
      event.childIds,
      `periodic spawn history event ${index}.childIds`,
      15,
    );
    if (childIds.length !== QUESTION_VALUES.childCountPerBatch) {
      throw new TypeError(
        `periodic spawn history event ${index}.childIds has invalid count`,
      );
    }
    for (let childIndex = 0; childIndex < childIds.length; childIndex += 1) {
      safeInteger(
        childIds[childIndex],
        `periodic spawn history event ${index}.childIds[${childIndex}]`,
        1,
      );
    }
    return { ...event, anchor: clone(event.anchor), childIds: [...childIds] };
  }
  return event;
}

function initialState() {
  return {
    alive: true,
    batchCount: 0,
    commandIndex: 0,
    endReason: null,
    history: [],
    nextDueTick: PERIODIC_SPAWN_TIMELINE.initialDelayTicks,
    tick: 0,
  };
}

function uncheckedAdvance(state, commands, materializer) {
  if (state.tick >= MAX_TICK) return [];
  const tick = state.tick;
  const events = [];

  // Boundary order is literal and question-backed: expiry, command, then due.
  if (state.alive && tick === PERIODIC_SPAWN_TIMELINE.lifetimeTicks) {
    state.alive = false;
    state.endReason = "expired";
    state.nextDueTick = null;
    events.push({
      sourceId: PERIODIC_SOURCE.sourceId,
      tick,
      type: "source-expired",
    });
  }

  const command = commands[state.commandIndex];
  if (command?.tick === tick) {
    state.commandIndex += 1;
    if (state.alive) {
      state.alive = false;
      state.endReason = "lethal";
      state.nextDueTick = null;
      events.push({
        sourceId: PERIODIC_SOURCE.sourceId,
        tick,
        type: "source-killed",
      });
    }
  }

  if (state.alive && tick === state.nextDueTick) {
    const batchIndex = state.batchCount;
    const spawned = materializer.materialize(PERIODIC_SOURCE);
    events.push({
      anchor: clone(PERIODIC_SOURCE.anchor),
      batchIndex,
      childIds: spawned.map(({ id }) => id),
      ownerId: PERIODIC_SOURCE.ownerId,
      sourceId: PERIODIC_SOURCE.sourceId,
      tick,
      type: "spawn-batch",
    });
    state.batchCount += 1;
    const absoluteDue =
      PERIODIC_SPAWN_TIMELINE.initialDelayTicks +
      state.batchCount * PERIODIC_SPAWN_TIMELINE.cadenceTicks;
    if (!Number.isSafeInteger(absoluteDue) || absoluteDue >= MAX_TICK) {
      throw new RangeError("periodic spawn schedule exceeds its tick bound");
    }
    state.nextDueTick = absoluteDue;
  }

  if (state.history.length + events.length > MAX_EVENTS) {
    throw new RangeError("periodic spawn history exceeds its event bound");
  }
  state.history.push(...clone(events));
  state.tick += 1;
  return events;
}

function checkedStateShape(value, commands, label) {
  const state = exactRecord(value, STATE_KEYS, label);
  if (typeof state.alive !== "boolean") {
    throw new TypeError(`${label}.alive must be boolean`);
  }
  safeInteger(state.tick, `${label}.tick`, 0, MAX_TICK);
  safeInteger(state.batchCount, `${label}.batchCount`, 0, MAX_EVENTS);
  safeInteger(
    state.commandIndex,
    `${label}.commandIndex`,
    0,
    commands.length,
  );
  if (
    state.endReason !== null &&
    state.endReason !== "expired" &&
    state.endReason !== "lethal"
  ) {
    throw new TypeError(`${label}.endReason is invalid`);
  }
  if (state.nextDueTick !== null) {
    safeInteger(state.nextDueTick, `${label}.nextDueTick`, 0, MAX_TICK - 1);
  }
  const history = denseArray(state.history, `${label}.history`, MAX_EVENTS)
    .map(checkedEvent);
  if (state.alive !== (state.endReason === null)) {
    throw new TypeError(`${label} life and end reason disagree`);
  }
  if (state.alive !== (state.nextDueTick !== null)) {
    throw new TypeError(`${label} life and schedule disagree`);
  }
  const expectedCommandIndex = commands.filter(
    ({ tick }) => tick < state.tick,
  ).length;
  if (state.commandIndex !== expectedCommandIndex) {
    throw new TypeError(`${label}.commandIndex is noncausal`);
  }
  let previousTick = -1;
  for (const event of history) {
    if (event.tick < previousTick || event.tick >= state.tick) {
      throw new TypeError(`${label}.history is noncausal`);
    }
    previousTick = event.tick;
  }
  return {
    alive: state.alive,
    batchCount: state.batchCount,
    commandIndex: state.commandIndex,
    endReason: state.endReason,
    history,
    nextDueTick: state.nextDueTick,
    tick: state.tick,
  };
}

function replay(commands, ticks) {
  const state = initialState();
  const materializer = new SpawnBatchMaterializer();
  for (let index = 0; index < ticks; index += 1) {
    uncheckedAdvance(state, commands, materializer);
  }
  return { materializer, state };
}

function checkedCausal(value, placementSnapshotBytes, commands, label) {
  const checked = checkedStateShape(value, commands, label);
  if (typeof placementSnapshotBytes !== "string") {
    throw new TypeError("periodic spawn placement snapshot must be a string");
  }
  const nested = SpawnBatchMaterializer.restore(placementSnapshotBytes);
  const expected = replay(commands, checked.tick);
  if (
    canonicalJson(checked) !== canonicalJson(expected.state) ||
    nested.serialize() !== expected.materializer.serialize()
  ) {
    throw new TypeError(
      `${label} or nested placement snapshot is forged or noncausal`,
    );
  }
  return {
    materializer: nested,
    state: checked,
  };
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

export function createPeriodicSpawnQuestionRecords(...args) {
  if (args.length !== 0) {
    throw new TypeError(
      "periodic spawn question records do not accept overrides",
    );
  }
  return deepFreeze(Object.fromEntries(
    Object.entries(QUESTION_VALUES).map(([key, value]) => [
      key,
      questionRecord(key, value),
    ]),
  ));
}

export function createPeriodicSpawnFixture(commands = []) {
  return clone(checkedSetup({ commands }));
}

export class PeriodicSpawnEncounter {
  #commands;
  #materializer;
  #state;

  constructor(setup = createPeriodicSpawnFixture()) {
    const checked = checkedSetup(setup);
    this.#commands = checked.commands;
    this.#materializer = new SpawnBatchMaterializer();
    this.#state = initialState();
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
    safeInteger(count, "periodic spawn step count", 0, MAX_STEP_CHUNK);
    if (count > MAX_TICK - this.#state.tick) {
      throw new RangeError(
        "periodic spawn step count exceeds the encounter bound",
      );
    }
    const candidate = checkedCausal(
      this.#state,
      this.#materializer.serialize(),
      this.#commands,
      "periodic spawn state",
    );
    const events = [];
    for (let index = 0; index < count; index += 1) {
      events.push(...uncheckedAdvance(
        candidate.state,
        this.#commands,
        candidate.materializer,
      ));
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
    const causal = checkedCausal(
      this.#state,
      placementSnapshotBytes,
      this.#commands,
      "periodic spawn state",
    );
    const serialized = canonicalJson({
      identity: {
        commands: this.#commands,
        fixture: FIXTURE_ID,
        schedule: PERIODIC_SPAWN_TIMELINE,
        source: PERIODIC_SOURCE,
      },
      placementSnapshotBytes: causal.materializer.serialize(),
      state: causal.state,
      version: 1,
    });
    if (Buffer.byteLength(serialized, "utf8") > MAX_SNAPSHOT_BYTES) {
      throw new RangeError("periodic spawn snapshot exceeds its byte bound");
    }
    return serialized;
  }

  static restore(serialized) {
    if (typeof serialized !== "string") {
      throw new TypeError("periodic spawn snapshot must be a string");
    }
    if (Buffer.byteLength(serialized, "utf8") > MAX_SNAPSHOT_BYTES) {
      throw new RangeError("periodic spawn snapshot exceeds its byte bound");
    }
    let value;
    try {
      value = JSON.parse(serialized);
    } catch {
      throw new TypeError("periodic spawn snapshot must be valid JSON");
    }
    if (serialized !== canonicalJson(value)) {
      throw new TypeError(
        "periodic spawn snapshot must be canonical duplicate-free JSON",
      );
    }
    const snapshot = exactRecord(
      value,
      SNAPSHOT_KEYS,
      "periodic spawn snapshot",
    );
    if (snapshot.version !== 1) {
      throw new TypeError("periodic spawn snapshot version is unsupported");
    }
    const identity = exactRecord(
      snapshot.identity,
      IDENTITY_KEYS,
      "periodic spawn snapshot.identity",
    );
    if (identity.fixture !== FIXTURE_ID) {
      throw new TypeError("periodic spawn snapshot fixture identity is invalid");
    }
    const commands = checkedCommands(identity.commands);
    const schedule = checkedSchedule(
      identity.schedule,
      "periodic spawn snapshot.identity.schedule",
    );
    const source = checkedSource(
      identity.source,
      "periodic spawn snapshot.identity.source",
    );
    if (
      canonicalJson(schedule) !== canonicalJson(PERIODIC_SPAWN_TIMELINE) ||
      canonicalJson(source) !== canonicalJson(PERIODIC_SOURCE)
    ) {
      throw new TypeError(
        "periodic spawn snapshot identity disagrees with fixture policy",
      );
    }
    const causal = checkedCausal(
      snapshot.state,
      snapshot.placementSnapshotBytes,
      commands,
      "periodic spawn snapshot.state",
    );
    const encounter = new PeriodicSpawnEncounter({ commands });
    encounter.#state = causal.state;
    encounter.#materializer = causal.materializer;
    return encounter;
  }
}
