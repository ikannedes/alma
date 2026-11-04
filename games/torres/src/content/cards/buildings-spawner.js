import { evaluateDeployment } from "../../sim/deployment.js";
import {
  DeathSpawnEncounter,
  createDeathSpawnFixture,
} from "./death-spawns.js";

const FIXTURE = "spawner-building-encounter-v1";
const SOURCE = "spawner-building-corpus-and-unsourced-policy-fixture";
const MAX_BUILDINGS = 8;
const MAX_COMMANDS = 64;
const MAX_STEP_CHUNK = 512;
const MAX_TICK = 512;
const MAX_SNAPSHOT_BYTES = 1_048_576;

export const SPAWNER_BUILDING_IDENTITIES = deepFreeze({
  "bramble-cage": { displayName: "Bramble Cage", id: "bramble-cage" },
  "ember-roost": { displayName: "Ember Roost", id: "ember-roost" },
});

const ARCHETYPES = deepFreeze({
  "bramble-cage": {
    corpus: { cost: 4, deployTicks: 60, hitpoints: 742 },
    deathChildren: [{
      archetypeId: "thorn-runner", children: [], health: 96, periodic: null,
      radius: 90, role: "primary",
    }],
    health: 150,
    lifetimeTicks: 18,
    periodic: null,
  },
  "ember-roost": {
    corpus: { cost: 5, deployTicks: 60, hitpoints: 848 },
    deathChildren: [
      {
        archetypeId: "ember-scout", children: [], health: 30, periodic: null,
        radius: 70, role: "primary",
      },
      {
        archetypeId: "ember-scout", children: [], health: 30, periodic: null,
        radius: 70, role: "secondary",
      },
      {
        archetypeId: "ember-scout", children: [], health: 30, periodic: null,
        radius: 70, role: "secondary",
      },
    ],
    health: 120,
    lifetimeTicks: 15,
    periodic: {
      cadenceTicks: 4,
      children: [
        {
          archetypeId: "cinderling", children: [], health: 20, periodic: null,
          radius: 60, role: "primary",
        },
        {
          archetypeId: "cinderling", children: [], health: 20, periodic: null,
          radius: 60, role: "secondary",
        },
      ],
      initialDelayTicks: 3,
    },
  },
});

const QUESTION_VALUES = deepFreeze({
  buildingHealthFixture: {
    "bramble-cage": 150,
    "ember-roost": 120,
  },
  buildingLifetimeTicks: {
    "bramble-cage": 18,
    "ember-roost": 15,
  },
  commandBoundaryOrder:
    "deployment-is-preflight-only-then-lifetime-command-joins-input-sequence",
  deathBatchCounts: {
    "bramble-cage": 1,
    "ember-roost": 3,
  },
  deathBatchOrder: "declared-child-order-is-stable-id-and-formation-order",
  deathOnLifetime:
    "lifetime-destruction-is-lethal-and-triggers-the-same-death-batch-as-damage",
  destructionAttribution:
    "input-lethal-source-wins-otherwise-lifetime-has-null-source",
  lifetimePeriodicBoundary:
    "destruction-precedes-and-cancels-a-periodic-batch-due-at-the-same-boundary",
  periodicBatchCounts: { "ember-roost": 2 },
  periodicCadenceTicks: { "ember-roost": 4 },
  periodicFirstDelayTicks: { "ember-roost": 3 },
  periodicPlacement:
    "shared-materializer-uses-building-center-anchor-and-declared-child-order",
  stationaryPolicy: "ordinary-ground-deployment-with-no-post-placement-movement",
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
    value === null || typeof value !== "object" || Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) throw new TypeError(`${label} must be a plain object`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const actual = Reflect.ownKeys(descriptors);
  if (
    actual.length !== keys.length ||
    actual.some((key) => (
      typeof key !== "string" || !keys.includes(key) ||
      !descriptors[key].enumerable || !Object.hasOwn(descriptors[key], "value")
    ))
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

function integer(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label} must be a bounded safe integer`);
  }
  return value;
}

function checkedPoint(value, label) {
  const point = exactRecord(value, ["x", "y"], label);
  return {
    x: integer(point.x, -1_000_000, 1_000_000, `${label}.x`),
    y: integer(point.y, -1_000_000, 1_000_000, `${label}.y`),
  };
}

function checkedBuildings(value) {
  const result = denseArray(value, MAX_BUILDINGS, "spawner buildings")
    .map((entry, index) => {
      const label = `spawner building ${index}`;
      const item = exactRecord(entry, [
        "archetypeId", "destroyedOpposingLaneTowers", "id", "ownerId",
        "position", "side",
      ], label);
      if (!Object.hasOwn(ARCHETYPES, item.archetypeId)) {
        throw new TypeError(`${label}.archetypeId is invalid`);
      }
      const destroyedOpposingLaneTowers = denseArray(
        item.destroyedOpposingLaneTowers, 2,
        `${label}.destroyedOpposingLaneTowers`,
      );
      const position = checkedPoint(item.position, `${label}.position`);
      const placement = evaluateDeployment({
        destroyedOpposingLaneTowers,
        placementClass: "ground_entity",
        point: position,
        side: item.side,
      });
      if (!placement.legal) {
        throw new TypeError(`${label} placement is illegal: ${placement.reason}`);
      }
      return {
        archetypeId: item.archetypeId,
        destroyedOpposingLaneTowers: clone(destroyedOpposingLaneTowers),
        id: integer(item.id, 65, Number.MAX_SAFE_INTEGER, `${label}.id`),
        ownerId: integer(
          item.ownerId, 1, Number.MAX_SAFE_INTEGER, `${label}.ownerId`,
        ),
        position,
        side: item.side,
      };
    }).sort((left, right) => left.id - right.id);
  const ids = new Set();
  for (const building of result) {
    if (ids.has(building.id)) {
      throw new TypeError("spawner buildings must have unique IDs");
    }
    ids.add(building.id);
  }
  return result;
}

function checkedCommands(value, buildingIds) {
  const result = denseArray(value, MAX_COMMANDS, "spawner building commands")
    .map((entry, sequence) => {
      const label = `spawner building command ${sequence}`;
      const command = exactRecord(
        entry, ["amount", "buildingId", "sourceId", "tick", "type"], label,
      );
      if (command.type !== "damage-building") {
        throw new TypeError(`${label}.type is invalid`);
      }
      const checked = {
        amount: integer(
          command.amount, 0, Number.MAX_SAFE_INTEGER, `${label}.amount`,
        ),
        buildingId: integer(
          command.buildingId, 65, Number.MAX_SAFE_INTEGER,
          `${label}.buildingId`,
        ),
        sequence,
        sourceId: integer(
          command.sourceId, 1, Number.MAX_SAFE_INTEGER, `${label}.sourceId`,
        ),
        tick: integer(command.tick, 0, MAX_TICK - 1, `${label}.tick`),
        type: command.type,
      };
      if (!buildingIds.has(checked.buildingId)) {
        throw new TypeError(`${label}.buildingId does not exist`);
      }
      return checked;
    }).sort((left, right) =>
      left.tick - right.tick || left.sequence - right.sequence);
  const signatures = new Set();
  for (const command of result) {
    const signature = canonicalJson({
      amount: command.amount, buildingId: command.buildingId,
      sourceId: command.sourceId, tick: command.tick, type: command.type,
    });
    if (signatures.has(signature)) {
      throw new TypeError("spawner building commands must not contain duplicates");
    }
    signatures.add(signature);
  }
  return result.map(({ sequence: _sequence, ...command }) => command);
}

function checkedSetup(value) {
  const setup = exactRecord(value, ["buildings", "commands"], "spawner setup");
  const buildings = checkedBuildings(setup.buildings);
  return {
    buildings,
    commands: checkedCommands(
      setup.commands, new Set(buildings.map(({ id }) => id)),
    ),
  };
}

function deathEntity(building) {
  const archetype = ARCHETYPES[building.archetypeId];
  return {
    anchor: clone(building.position),
    archetypeId: building.archetypeId,
    children: clone(archetype.deathChildren),
    health: archetype.health,
    id: building.id,
    ownerId: building.ownerId,
    periodic: archetype.periodic === null ? null : {
      ...clone(archetype.periodic),
      // The shared expiry boundary intentionally sits one tick later. The
      // facade's ordered lifetime command destroys the building and thereby
      // exercises the shared exactly-once death path.
      lifetimeTicks: archetype.lifetimeTicks + 1,
    },
    sourceId: building.id,
  };
}

function primitiveCommands(setup) {
  const commands = setup.commands.map((command) => ({
    amount: command.amount,
    cause: "combat-damage",
    sourceId: command.sourceId,
    targetId: command.buildingId,
    tick: command.tick,
  }));
  for (const building of setup.buildings) {
    commands.push({
      amount: ARCHETYPES[building.archetypeId].health,
      cause: "combat-damage",
      sourceId: null,
      targetId: building.id,
      tick: ARCHETYPES[building.archetypeId].lifetimeTicks,
    });
  }
  return commands.sort((left, right) => left.tick - right.tick);
}

function primitiveSetup(setup) {
  return createDeathSpawnFixture(
    setup.buildings.map(deathEntity),
    primitiveCommands(setup),
  );
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

export function createSpawnerBuildingCorpusRecords() {
  return deepFreeze(Object.fromEntries(
    Object.entries(ARCHETYPES).map(([id, archetype]) => [
      id,
      Object.fromEntries(Object.entries(archetype.corpus).map(([field, value]) => [
        field,
        {
          authoritative: false,
          confidence: "medium-high-datamine-unverified-value",
          source: "pinned-pre-march-2023-building-constants",
          value,
        },
      ])),
    ]),
  ));
}

export function createSpawnerBuildingQuestionRecords(...args) {
  if (args.length !== 0) {
    throw new TypeError("spawner building questions do not accept overrides");
  }
  return deepFreeze(Object.fromEntries(
    Object.entries(QUESTION_VALUES).map(([key, value]) => [
      key, questionRecord(key, value),
    ]),
  ));
}

export function createSpawnerBuildingFixture(buildings = [], commands = []) {
  return clone(checkedSetup({ buildings, commands }));
}

export class SpawnerBuildingEncounter {
  #encounter;
  #setup;

  constructor(setup = createSpawnerBuildingFixture()) {
    this.#setup = checkedSetup(setup);
    if (this.#setup.buildings.length === 0) {
      throw new TypeError("spawner setup must contain at least one building");
    }
    this.#encounter = new DeathSpawnEncounter(primitiveSetup(this.#setup));
  }

  get children() {
    return this.#encounter.children;
  }

  get replay() {
    return this.#encounter.replay;
  }

  get state() {
    return {
      buildings: this.#encounter.state.entities.filter(({ id }) =>
        this.#setup.buildings.some((building) => building.id === id)),
      commandIndex: this.#encounter.state.commandIndex,
      history: this.#encounter.replay,
      tick: this.#encounter.state.tick,
    };
  }

  step() {
    return this.stepMany(1);
  }

  stepMany(count) {
    integer(count, 0, MAX_STEP_CHUNK, "spawner building step count");
    return this.#encounter.stepMany(count);
  }

  run() {
    return this.stepMany(MAX_TICK - this.#encounter.state.tick);
  }

  serialize() {
    const serialized = canonicalJson({
      identity: { fixture: FIXTURE, setup: this.#setup },
      primitiveSnapshotBytes: this.#encounter.serialize(),
      version: 1,
    });
    if (Buffer.byteLength(serialized, "utf8") > MAX_SNAPSHOT_BYTES) {
      throw new RangeError("spawner building snapshot exceeds its byte bound");
    }
    return serialized;
  }

  static restore(serialized) {
    if (typeof serialized !== "string") {
      throw new TypeError("spawner building snapshot must be a string");
    }
    if (Buffer.byteLength(serialized, "utf8") > MAX_SNAPSHOT_BYTES) {
      throw new RangeError("spawner building snapshot exceeds its byte bound");
    }
    let raw;
    try {
      raw = JSON.parse(serialized);
    } catch {
      throw new TypeError("spawner building snapshot must be valid JSON");
    }
    if (canonicalJson(raw) !== serialized) {
      throw new TypeError("spawner building snapshot must use canonical bytes");
    }
    const snapshot = exactRecord(
      raw, ["identity", "primitiveSnapshotBytes", "version"],
      "spawner building snapshot",
    );
    if (snapshot.version !== 1) {
      throw new TypeError("spawner building snapshot version is unsupported");
    }
    const identity = exactRecord(
      snapshot.identity, ["fixture", "setup"],
      "spawner building snapshot.identity",
    );
    if (identity.fixture !== FIXTURE) {
      throw new TypeError("spawner building snapshot fixture is invalid");
    }
    const setup = checkedSetup(identity.setup);
    const restoredPrimitive = DeathSpawnEncounter.restore(
      snapshot.primitiveSnapshotBytes,
    );
    const encounter = new SpawnerBuildingEncounter(setup);
    encounter.stepMany(restoredPrimitive.state.tick);
    if (encounter.#encounter.serialize() !== snapshot.primitiveSnapshotBytes) {
      throw new TypeError(
        "spawner building snapshot is not a causal primitive execution",
      );
    }
    return encounter;
  }
}
