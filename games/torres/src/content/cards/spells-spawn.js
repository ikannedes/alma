import {
  ARENA_LENGTH_MILLITILES,
  ARENA_WIDTH_MILLITILES,
} from "../../sim/arena-geometry.js";
import { evaluateDeployment } from "../../sim/deployment.js";
import { SeededRandom } from "../../sim/rng.js";
import {
  PeriodicSpawnEncounter,
  createPeriodicSpawnFixture,
} from "./periodic-spawns.js";
import { SpawnBatchMaterializer } from "./spawn-placement.js";
import {
  InstantRadiusSpellEncounter,
  createInstantSpellFixture,
} from "./spells-instant.js";

const SOURCE = "spawn-spell-comparison-question-fixture";
const FIXTURE_ID = "original-spawn-spell-encounter-v1";
const IMPACT_DELAY_TICKS = 2;
const AREA_RADIUS = 4000;
const CHILD_RADIUS = 100;
const MAX_COMMANDS = 64;
const MAX_EVENTS = 4096;
const MAX_OWNER_ID = 1024;
const MAX_SNAPSHOT_BYTES = 262_144;
const MAX_SOURCES = 16;
const MAX_STEP_CHUNK = 128;
const MAX_TICK = 128;
const MAX_RANDOM_ATTEMPTS = 128;
const COMMAND_KEYS = [
  "center",
  "id",
  "sourceId",
  "tick",
  "type",
  "variant",
];
const SOURCE_KEYS = ["id", "ownerId"];
const SETUP_KEYS = ["commands", "seed", "sources"];
const SNAPSHOT_KEYS = [
  "identity",
  "placementSnapshotBytes",
  "tick",
  "version",
];
const IDENTITY_KEYS = ["fixture", "setup"];
const VARIANTS = new Set(["burst", "periodic"]);

export const SPAWN_SPELL_IDENTITIES = deepFreeze([
  {
    displayName: "Cloudseed Flask",
    id: "cloudseed-flask",
    variant: "burst",
  },
  {
    displayName: "Hollowgarden",
    id: "hollowgarden",
    variant: "periodic",
  },
]);

export const SPAWN_SPELL_COUNTS = deepFreeze({
  burst: {
    confidence: "medium",
    count: 3,
    disposition: "comparison-value",
  },
  periodic: {
    confidence: "medium",
    count: 15,
    disposition: "comparison-value",
  },
});

const QUESTION_VALUES = deepFreeze({
  areaRadiusMillitiles: AREA_RADIUS,
  boundaryOrdering:
    "commands-then-travel-impacts-in-effect-id-order-then-periodic-batches",
  burstPlacement:
    "one-seeded-integer-area-draw-per-child-in-child-index-order-with-first-draw-anchoring-one-boundary-formation",
  cancellation:
    "source-cancel-before-impact-cancels-impact-after-impact-cancels-future-periodic-batches",
  childArchetype: "original-spriglet-for-burst-and-original-wispbone-for-periodic",
  childRadiusMillitiles: CHILD_RADIUS,
  impactDelayTicks: IMPACT_DELAY_TICKS,
  ownership:
    "spawned-child-inherits-casting-source-owner-and-casting-source-id",
  periodicBatching: "three-periodic-boundaries-of-five-children-each",
  periodicCadence:
    "delegate-to-content-011p-question-timeline-relative-to-impact",
  placementBounds:
    "cast-center-must-inset-the-question-radius-and-child-radius-inside-arena",
  randomAlgorithm:
    "pcg32-named-effect-fork-square-rejection-with-inclusive-circle",
  randomExhaustion:
    "reject-atomically-after-128-outside-circle-candidates",
  restorePolicy: "canonical-identity-plus-causal-tick-replay",
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
    Array.from({ length: value.length }, (_, index) => (
      !descriptors[index]?.enumerable ||
      !Object.hasOwn(descriptors[index], "value")
    )).some(Boolean)
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

function checkedPosition(value, label) {
  const position = exactRecord(value, ["x", "y"], label);
  const inset = AREA_RADIUS + CHILD_RADIUS;
  const checked = {
    x: safeInteger(
      position.x,
      `${label}.x`,
      inset,
      ARENA_WIDTH_MILLITILES - inset,
    ),
    y: safeInteger(
      position.y,
      `${label}.y`,
      inset,
      ARENA_LENGTH_MILLITILES - inset,
    ),
  };
  const deployment = evaluateDeployment({
    destroyedOpposingLaneTowers: [],
    placementClass: "global_effect",
    point: checked,
    side: "south",
  });
  if (!deployment.legal) {
    throw new RangeError(`${label} must be legal global-effect placement`);
  }
  return checked;
}

function checkedSources(value) {
  const sources = denseArray(value, MAX_SOURCES, "spawn spell sources")
    .map((entry, index) => {
      const source = exactRecord(
        entry,
        SOURCE_KEYS,
        `spawn spell source ${index}`,
      );
      return {
        id: safeInteger(source.id, `spawn spell source ${index}.id`, 1),
        ownerId: safeInteger(
          source.ownerId,
          `spawn spell source ${index}.ownerId`,
          1,
          MAX_OWNER_ID,
        ),
      };
    });
  if (sources.length < 1) {
    throw new RangeError("spawn spell sources must not be empty");
  }
  if (new Set(sources.map(({ id }) => id)).size !== sources.length) {
    throw new TypeError("spawn spell source IDs must be unique");
  }
  return sources;
}

function checkedCommands(value, sources) {
  const sourceIds = new Set(sources.map(({ id }) => id));
  const commands = denseArray(value, MAX_COMMANDS, "spawn spell commands")
    .map((entry, index) => {
      const command = exactRecord(
        entry,
        COMMAND_KEYS,
        `spawn spell command ${index}`,
      );
      const common = {
        id: safeInteger(command.id, `spawn spell command ${index}.id`, 1),
        tick: safeInteger(
          command.tick,
          `spawn spell command ${index}.tick`,
          0,
          MAX_TICK - IMPACT_DELAY_TICKS - 1,
        ),
      };
      if (!sourceIds.has(command.sourceId)) {
        throw new TypeError(`spawn spell command ${index}.sourceId is unknown`);
      }
      if (command.type === "cast") {
        if (!VARIANTS.has(command.variant)) {
          throw new TypeError(
            `spawn spell command ${index}.variant is invalid`,
          );
        }
        return {
          center: checkedPosition(
            command.center,
            `spawn spell command ${index}.center`,
          ),
          ...common,
          sourceId: command.sourceId,
          type: "cast",
          variant: command.variant,
        };
      }
      if (
        command.type !== "cancel-source" ||
        command.center !== null ||
        command.variant !== null
      ) {
        throw new TypeError(`spawn spell command ${index} fields are invalid`);
      }
      return {
        center: null,
        ...common,
        sourceId: command.sourceId,
        type: "cancel-source",
        variant: null,
      };
    });
  const ids = new Set();
  let priorTick = -1;
  let priorId = -1;
  for (const command of commands) {
    if (ids.has(command.id)) {
      throw new TypeError("spawn spell command IDs must be unique");
    }
    ids.add(command.id);
    if (
      command.tick < priorTick ||
      (command.tick === priorTick && command.id <= priorId)
    ) {
      throw new TypeError(
        "spawn spell commands must use increasing tick and command-ID order",
      );
    }
    priorTick = command.tick;
    priorId = command.id;
  }
  return commands;
}

function checkedSeed(value) {
  // Construction validates the exact SIM-002 seed domain without consuming it.
  new SeededRandom(value);
  return value;
}

function checkedSetup(value) {
  const setup = exactRecord(value, SETUP_KEYS, "spawn spell setup");
  const sources = checkedSources(setup.sources);
  return {
    commands: checkedCommands(setup.commands, sources),
    seed: checkedSeed(setup.seed),
    sources,
  };
}

function instantSetup(setup) {
  return createInstantSpellFixture({
    commands: setup.commands.map((command) => ({
      center: command.center,
      id: command.id,
      sourceId: command.sourceId,
      targetId: null,
      tick: command.tick,
      type: command.type === "cast" ? "cast" : "source-died",
      variant: command.type === "cast" ? "plain" : null,
    })),
    sources: setup.sources,
    victims: [],
  });
}

function cancellationTick(setup, sourceId, impactTick) {
  const cancellation = setup.commands.find((command) =>
    command.type === "cancel-source" &&
    command.sourceId === sourceId &&
    command.tick > impactTick
  );
  return cancellation === undefined ? null : cancellation.tick - impactTick;
}

function randomAnchor(rng, center) {
  const diameter = AREA_RADIUS * 2 + 1;
  for (let attempt = 0; attempt < MAX_RANDOM_ATTEMPTS; attempt += 1) {
    const x = rng.int(diameter) - AREA_RADIUS;
    const y = rng.int(diameter) - AREA_RADIUS;
    if (
      BigInt(x) * BigInt(x) + BigInt(y) * BigInt(y) <=
      BigInt(AREA_RADIUS) * BigInt(AREA_RADIUS)
    ) {
      return { x: center.x + x, y: center.y + y };
    }
  }
  throw new RangeError("spawn spell random placement exhausted its bound");
}

function materializeChildren(runtime, effect, count, archetypeId, tick, kind) {
  const source = runtime.setup.sources.find(({ id }) =>
    id === effect.sourceId);
  // Keep the named effect stream consumption stable: every child still owns
  // one deterministic area-placement draw. The primitive causal boundary is
  // the complete outer spawn set, so its first draw anchors one attached
  // formation and the materializer receives exactly one operation.
  const anchors = Array.from(
    { length: count },
    () => randomAnchor(effect.rng, effect.center),
  );
  const spawned = runtime.materializer.materialize({
    anchor: anchors[0],
    children: Array.from({ length: count }, () => ({
      archetypeId,
      radius: CHILD_RADIUS,
      role: "primary",
    })),
    ownerId: source.ownerId,
    sourceId: source.id,
  });
  for (const child of spawned) {
    runtime.history.push({
      childId: child.id,
      effectId: effect.effectId,
      ownerId: source.ownerId,
      position: clone(child.data.position),
      sourceId: source.id,
      tick,
      type: "spawn-spell-child",
      variant: effect.variant,
    });
  }
  runtime.history.push({
    childIds: spawned.map(({ id }) => id),
    effectId: effect.effectId,
    kind,
    tick,
    type: "spawn-spell-batch",
    variant: effect.variant,
  });
}

function startEffect(runtime, instantEvent) {
  const cast = runtime.effectCasts.get(instantEvent.effectId);
  const effect = {
    center: clone(cast.center),
    effectId: instantEvent.effectId,
    impactTick: instantEvent.tick,
    oracle: null,
    rng: new SeededRandom(runtime.setup.seed).fork(
      `spawn-spell-effect-${instantEvent.effectId}`,
    ),
    sourceId: instantEvent.sourceId,
    variant: cast.variant,
  };
  runtime.history.push({
    center: clone(effect.center),
    effectId: effect.effectId,
    sourceId: effect.sourceId,
    tick: instantEvent.tick,
    type: "spawn-spell-impact",
    variant: effect.variant,
  });
  if (effect.variant === "burst") {
    materializeChildren(
      runtime,
      effect,
      SPAWN_SPELL_COUNTS.burst.count,
      "spriglet",
      instantEvent.tick,
      "burst",
    );
    return;
  }
  const relativeCancellation = cancellationTick(
    runtime.setup,
    effect.sourceId,
    effect.impactTick,
  );
  effect.oracle = new PeriodicSpawnEncounter(createPeriodicSpawnFixture(
    relativeCancellation === null
      ? []
      : [{ tick: relativeCancellation, type: "lethal" }],
  ));
  runtime.periodic.push(effect);
}

function initialRuntime(setup) {
  return {
    effectCasts: new Map(),
    history: [],
    instant: new InstantRadiusSpellEncounter(instantSetup(setup)),
    materializer: new SpawnBatchMaterializer(),
    periodic: [],
    setup,
    tick: 0,
  };
}

function advance(runtime) {
  const tick = runtime.tick;
  const beforeInstantLength = runtime.instant.replay.length;
  runtime.instant.step();
  const instantEvents = runtime.instant.replay.slice(beforeInstantLength);
  for (const event of instantEvents) {
    if (event.type === "spell-cast") {
      const cast = runtime.setup.commands.find((command) =>
        command.type === "cast" &&
        command.sourceId === event.sourceId &&
        command.tick === event.tick &&
        ![...runtime.effectCasts.values()].includes(command)
      );
      runtime.effectCasts.set(event.effectId, cast);
      runtime.history.push({
        effectId: event.effectId,
        impactTick: event.impactTick,
        sourceId: event.sourceId,
        tick,
        type: "spawn-spell-cast",
        variant: cast.variant,
      });
    } else if (event.type === "spell-source-died") {
      runtime.history.push({
        sourceId: event.sourceId,
        tick,
        type: "spawn-spell-source-cancelled",
      });
    } else if (event.type === "spell-impact") {
      startEffect(runtime, event);
    }
  }

  for (const effect of runtime.periodic) {
    const relativeEvents = effect.oracle.step();
    for (const event of relativeEvents) {
      if (event.type === "spawn-batch") {
        materializeChildren(
          runtime,
          effect,
          SPAWN_SPELL_COUNTS.periodic.count / 3,
          "wispbone",
          tick,
          `periodic-${event.batchIndex}`,
        );
      } else if (event.type === "source-killed") {
        runtime.history.push({
          effectId: effect.effectId,
          sourceId: effect.sourceId,
          tick,
          type: "spawn-spell-periodic-cancelled",
        });
      } else if (event.type === "source-expired") {
        runtime.history.push({
          effectId: effect.effectId,
          sourceId: effect.sourceId,
          tick,
          type: "spawn-spell-periodic-expired",
        });
      }
    }
  }
  if (runtime.history.length > MAX_EVENTS) {
    throw new RangeError("spawn spell replay exceeds its event bound");
  }
  runtime.tick += 1;
}

function replayTo(setup, tick) {
  const runtime = initialRuntime(setup);
  for (let index = 0; index < tick; index += 1) advance(runtime);
  return runtime;
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

export function createSpawnSpellQuestionRecords(...args) {
  if (args.length !== 0) {
    throw new TypeError("spawn spell questions do not accept overrides");
  }
  return deepFreeze(Object.fromEntries(
    Object.entries(QUESTION_VALUES).map(([key, value]) => [
      key,
      questionRecord(key, value),
    ]),
  ));
}

export function createSpawnSpellFixture(value) {
  return clone(checkedSetup(value));
}

export class SpawnSpellEncounter {
  #runtime;
  #setup;

  constructor(setup) {
    this.#setup = checkedSetup(setup);
    this.#runtime = initialRuntime(this.#setup);
  }

  get children() {
    return this.#runtime.materializer.list();
  }

  get replay() {
    return clone(this.#runtime.history);
  }

  get placementSnapshotBytes() {
    return this.#runtime.materializer.serialize();
  }

  get state() {
    return {
      childCount: this.#runtime.materializer.list().length,
      placementSnapshotBytes: this.#runtime.materializer.serialize(),
      replay: clone(this.#runtime.history),
      tick: this.#runtime.tick,
    };
  }

  step() {
    return this.stepMany(1);
  }

  stepMany(count) {
    safeInteger(count, "spawn spell step count", 0, MAX_STEP_CHUNK);
    if (count > MAX_TICK - this.#runtime.tick) {
      throw new RangeError("spawn spell step count exceeds encounter bound");
    }
    const candidate = replayTo(this.#setup, this.#runtime.tick);
    const start = candidate.history.length;
    for (let index = 0; index < count; index += 1) advance(candidate);
    const events = candidate.history.slice(start);
    this.#runtime = candidate;
    return clone(events);
  }

  run() {
    return this.stepMany(MAX_TICK - this.#runtime.tick);
  }

  serialize() {
    const serialized = canonicalJson({
      identity: {
        fixture: FIXTURE_ID,
        setup: this.#setup,
      },
      placementSnapshotBytes: this.#runtime.materializer.serialize(),
      tick: this.#runtime.tick,
      version: 1,
    });
    if (Buffer.byteLength(serialized, "utf8") > MAX_SNAPSHOT_BYTES) {
      throw new RangeError("spawn spell snapshot exceeds its byte bound");
    }
    return serialized;
  }

  static restore(serialized) {
    if (typeof serialized !== "string") {
      throw new TypeError("spawn spell snapshot must be a string");
    }
    if (Buffer.byteLength(serialized, "utf8") > MAX_SNAPSHOT_BYTES) {
      throw new RangeError("spawn spell snapshot exceeds its byte bound");
    }
    let value;
    try {
      value = JSON.parse(serialized);
    } catch {
      throw new TypeError("spawn spell snapshot must be valid JSON");
    }
    if (canonicalJson(value) !== serialized) {
      throw new TypeError(
        "spawn spell snapshot must be canonical duplicate-free JSON",
      );
    }
    const snapshot = exactRecord(value, SNAPSHOT_KEYS, "spawn spell snapshot");
    if (snapshot.version !== 1) {
      throw new TypeError("spawn spell snapshot version is unsupported");
    }
    const identity = exactRecord(
      snapshot.identity,
      IDENTITY_KEYS,
      "spawn spell snapshot.identity",
    );
    if (identity.fixture !== FIXTURE_ID) {
      throw new TypeError("spawn spell snapshot fixture is unsupported");
    }
    safeInteger(snapshot.tick, "spawn spell snapshot.tick", 0, MAX_TICK);
    const encounter = new SpawnSpellEncounter(identity.setup);
    const expected = replayTo(encounter.#setup, snapshot.tick);
    const placement = SpawnBatchMaterializer.restore(
      snapshot.placementSnapshotBytes,
    );
    if (placement.serialize() !== expected.materializer.serialize()) {
      throw new TypeError(
        "spawn spell nested placement snapshot is forged or noncausal",
      );
    }
    expected.materializer = placement;
    encounter.#runtime = expected;
    return encounter;
  }
}
