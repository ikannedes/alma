import { evaluateDeployment } from "../../sim/deployment.js";
import { ELIXIR_CAPACITY, ElixirMatch } from "../../sim/elixir.js";
import { createCardCatalog } from "../schema.js";

const FIXTURE = "resource-building-encounter-v1";
const SOURCE = "pre-evolutions-building-corpus-and-absent-resource-policy";
const MAX_BUILDINGS = 16;
const MAX_COMMANDS = 2_048;
const MAX_EVENTS = 10_000;
const MAX_TICK = 18_000;
const MAX_STEP_CHUNK = 18_000;
const MAX_POSITION = 1_000_000;
const MAX_SNAPSHOT_BYTES = 1_048_576;

const RESOURCE_RULE = Object.freeze({
  amount: 1,
  cadenceTicks: 510,
  capacity: ELIXIR_CAPACITY,
  deployTicks: 60,
  hitpoints: 1_070,
  lifetimeTicks: 4_200,
});

const QUESTION_VALUES = Object.freeze({
  commandOrderingPolicy:
    "same-tick commands resolve in input order before lifetime, deployment, and generation",
  deploymentBoundary:
    "placed at tick zero, deployed at tick 60, and unable to generate before deployment",
  generationAmount: RESOURCE_RULE.amount,
  generationCadenceTicks: RESOURCE_RULE.cadenceTicks,
  generationFirstBoundary:
    "the first pulse is one cadence after placement, at tick 510",
  generationWhileCapped:
    "a pulse at capacity is retained in replay with zero granted resource",
  lifetimeDestructionBoundary:
    "alive before tick 4200 and destroyed before generation at tick 4200",
  lifetimeTicks: RESOURCE_RULE.lifetimeTicks,
  ownershipPolicy:
    "each living building grants only to the side that deployed that building",
  placementPolicy: "ordinary ground-entity deployment mask at the building center",
  resourceCapacity: RESOURCE_RULE.capacity,
  simultaneousGenerationOrder:
    "resource buildings resolve by ascending positive building id",
});

const SHARED_HOST_RESOURCE_POLICY_V2 = Object.freeze({
  cadenceAnchorPolicy: Object.freeze({ authoritative: false, confidence: "absent",
    disposition: "question", key: "cadenceAnchorPolicy",
    source: "pre-evolutions-resource-consumer-semantics-question",
    value: "placement-tick-multiples-after-deployment" }),
  cadenceResetPolicy: Object.freeze({ authoritative: false, confidence: "absent",
    disposition: "question", key: "cadenceResetPolicy",
    source: "pre-evolutions-resource-consumer-semantics-question",
    value: "nonlethal-damage-does-not-reset-placement-relative-cadence" }),
  deployTicks: Object.freeze({ authoritative: false, confidence: "unverified",
    disposition: "question", key: "deploy_time",
    source: "pinned-pre-march-2023-building-constants", value: 60 }),
  destructionAmount: Object.freeze({ authoritative: true, confidence: "high",
    disposition: "source-aligned", key: "mana_on_death",
    source: "https://supercell.com/en/games/clashroyale/blog/release-notes/balance-changes-april-2022/",
    value: 1 }),
  expiryOrderingPolicy: Object.freeze({ authoritative: false, confidence: "absent",
    disposition: "question", key: "expiryOrderingPolicy",
    source: "pre-evolutions-resource-consumer-semantics-question",
    value: "expiry-transition-suppresses-cadence-and-grants-after-the-destruction-event" }),
  hitpoints: Object.freeze({ authoritative: false, confidence: "unverified",
    disposition: "question", key: "hitpoints",
    source: "pinned-pre-march-2023-building-constants", value: 1_070 }),
  generationAmount: Object.freeze({ authoritative: false, confidence: "datamine-only",
    disposition: "question", key: "mana_collect_amount",
    source: "pinned-pre-march-2023-building-constants", value: 1 }),
  generationCadenceTicks: Object.freeze({ authoritative: true, confidence: "high",
    disposition: "source-aligned", key: "mana_generate_time_ms",
    source: "https://supercell.com/en/games/clashroyale/blog/release-notes/balance-changes-april-2022/", value: 540 }),
  lifetimeTicks: Object.freeze({ authoritative: true, confidence: "high",
    disposition: "source-aligned", key: "life_time",
    source: "https://supercell.com/en/games/clashroyale/blog/release-notes/balance-changes-april-2022/", value: 3_900 }),
  placementPolicy: Object.freeze({ authoritative: false, confidence: "absent",
    disposition: "question", key: "placementPolicy",
    source: "pre-evolutions-resource-consumer-semantics-question",
    value: "ordinary-ground-entity-deployment-mask-at-building-center" }),
  recipientPolicy: Object.freeze({ authoritative: false, confidence: "absent",
    disposition: "question", key: "resourceRecipient",
    source: "pre-evolutions-resource-consumer-semantics-question",
    value: "building-owner" }),
  resourceCapacity: Object.freeze({ authoritative: false, confidence: "absent",
    disposition: "question", key: "mana_generate_limit",
    source: "pre-evolutions-resource-consumer-semantics-question", value: 10 }),
  sameTickOrderingPolicy: Object.freeze({ authoritative: false, confidence: "absent",
    disposition: "question", key: "sameTickOrderingPolicy",
    source: "pre-evolutions-resource-consumer-semantics-question",
    value: "combat-destruction-suppresses-cadence;spends-before-natural-generation-before-building-grants" }),
  simultaneousGenerationOrder: Object.freeze({ authoritative: false, confidence: "absent",
    disposition: "question", key: "simultaneousGenerationOrder",
    source: "pre-evolutions-resource-consumer-semantics-question",
    value: "ascending-positive-building-id" }),
});

const CARD = Object.freeze({
  areaDamageRadiusMillitiles: null,
  components: [],
  cost: 6,
  count: 1,
  damage: null,
  deployTimeTicks: RESOURCE_RULE.deployTicks,
  displayName: "Aether Well",
  firstHitTicks: null,
  hitSpeedTicks: null,
  hitpoints: RESOURCE_RULE.hitpoints,
  id: "aether-well",
  kind: "structure",
  movementMillitilesPerSecond: 0,
  rangeMillitiles: null,
  rarity: "uncommon",
  sightRangeMillitiles: null,
  targetMode: "none",
});

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
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
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
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
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new TypeError(`${label} must be a plain array`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const length = descriptors.length?.value;
  if (
    !Number.isSafeInteger(length) ||
    length < 0 ||
    length > maximum ||
    Reflect.ownKeys(descriptors).length !== length + 1
  ) {
    throw new TypeError(`${label} has an invalid length or shape`);
  }
  return Array.from({ length }, (_, index) => {
    const descriptor = descriptors[String(index)];
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) {
      throw new TypeError(`${label}[${index}] must be a data property`);
    }
    return descriptor.value;
  });
}

function integer(value, label, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label} must be a bounded safe integer`);
  }
}

function checkedPosition(value, label) {
  const item = exactRecord(value, ["x", "y"], label);
  integer(item.x, `${label}.x`, -MAX_POSITION, MAX_POSITION);
  integer(item.y, `${label}.y`, -MAX_POSITION, MAX_POSITION);
  return { x: item.x, y: item.y };
}

function checkedDestroyedTowers(value, label) {
  const towers = denseArray(value, 2, label);
  for (const [index, tower] of towers.entries()) {
    if (!["left", "right"].includes(tower)) {
      throw new TypeError(`${label}[${index}] is invalid`);
    }
  }
  if (new Set(towers).size !== towers.length) {
    throw new TypeError(`${label} must not contain duplicates`);
  }
  return towers;
}

function checkedBuildings(value) {
  const buildings = denseArray(value, MAX_BUILDINGS, "resource buildings")
    .map((entry, index) => {
      const item = exactRecord(entry, [
        "destroyedOpposingLaneTowers", "id", "position", "side",
      ], `resource building ${index}`);
      integer(item.id, `resource building ${index}.id`, 1);
      const position = checkedPosition(
        item.position,
        `resource building ${index}.position`,
      );
      const destroyedOpposingLaneTowers = checkedDestroyedTowers(
        item.destroyedOpposingLaneTowers,
        `resource building ${index}.destroyedOpposingLaneTowers`,
      );
      const placement = evaluateDeployment({
        destroyedOpposingLaneTowers,
        placementClass: "ground_entity",
        point: position,
        side: item.side,
      });
      if (!placement.legal) {
        throw new TypeError(
          `resource building ${index} placement is illegal: ${placement.reason}`,
        );
      }
      return {
        destroyedOpposingLaneTowers,
        id: item.id,
        placement,
        position,
        side: item.side,
      };
    }).sort((left, right) => left.id - right.id);
  if (new Set(buildings.map(({ id }) => id)).size !== buildings.length) {
    throw new TypeError("resource buildings must have unique ids");
  }
  return buildings;
}

function checkedStartingResource(value) {
  if (typeof value === "string") {
    const match = ElixirMatch.restore(value);
    if (match.serialize() !== value) {
      throw new TypeError("startingResource must use canonical ElixirMatch bytes");
    }
    if (match.tick > MAX_TICK) {
      throw new TypeError("startingResource tick exceeds the encounter bound");
    }
    return value;
  }
  const item = exactRecord(value, ["north", "south"], "startingResource");
  integer(item.north, "startingResource.north", 0, RESOURCE_RULE.capacity);
  integer(item.south, "startingResource.south", 0, RESOURCE_RULE.capacity);
  return new ElixirMatch({
    startingElixir: { north: item.north, south: item.south },
  }).serialize();
}

function checkedCommands(value, buildingIds) {
  return denseArray(value, MAX_COMMANDS, "resource commands")
    .map((entry, sequence) => {
      const item = exactRecord(entry, [
        "amount", "buildingId", "side", "tick", "type",
      ], `resource command ${sequence}`);
      integer(item.tick, `resource command ${sequence}.tick`, 0, MAX_TICK - 1);
      integer(item.amount, `resource command ${sequence}.amount`, 1, 1_000_000);
      if (!["damage-building", "spend-resource"].includes(item.type)) {
        throw new TypeError(`resource command ${sequence}.type is invalid`);
      }
      if (item.type === "damage-building") {
        integer(item.buildingId, `resource command ${sequence}.buildingId`, 1);
        if (!buildingIds.has(item.buildingId) || item.side !== null) {
          throw new TypeError(`resource command ${sequence} has invalid damage fields`);
        }
      } else if (
        item.buildingId !== null ||
        !["north", "south"].includes(item.side) ||
        item.amount > RESOURCE_RULE.capacity
      ) {
        throw new TypeError(`resource command ${sequence} has invalid spend fields`);
      }
      return {
        amount: item.amount,
        buildingId: item.buildingId,
        sequence,
        side: item.side,
        tick: item.tick,
        type: item.type,
      };
    }).sort((left, right) => left.tick - right.tick || left.sequence - right.sequence);
}

function checkedSetup(setup) {
  const item = exactRecord(
    setup,
    ["buildings", "commands", "startingResource"],
    "resource setup",
  );
  const buildings = checkedBuildings(item.buildings);
  const startingElixirSnapshotBytes =
    checkedStartingResource(item.startingResource);
  const startingTick =
    ElixirMatch.restore(startingElixirSnapshotBytes).tick;
  const commands = checkedCommands(
    item.commands, new Set(buildings.map(({ id }) => id)),
  );
  if (commands.some(({ tick }) => tick < startingTick)) {
    throw new TypeError(
      "resource commands cannot precede the starting ElixirMatch tick",
    );
  }
  return {
    buildings,
    commands,
    startingElixirSnapshotBytes,
  };
}

function initialState(setup, tick) {
  return {
    buildings: setup.buildings.map((building) => ({
      alive: tick <= RESOURCE_RULE.lifetimeTicks,
      deployed: tick > RESOURCE_RULE.deployTicks,
      health: tick <= RESOURCE_RULE.lifetimeTicks
        ? RESOURCE_RULE.hitpoints
        : 0,
      id: building.id,
      placement: clone(building.placement),
      position: clone(building.position),
      side: building.side,
    })),
    commandIndex: 0,
    history: [],
    tick,
  };
}

function destroy(state, building, reason) {
  building.alive = false;
  building.health = 0;
  return {
    buildingId: building.id,
    reason,
    tick: state.tick,
    type: "building-destroyed",
  };
}

function applyDamageCommands(state, commands) {
  const eventsBySequence = new Map();
  const spendCommands = [];
  while (
    state.commandIndex < commands.length &&
    commands[state.commandIndex].tick === state.tick
  ) {
    const command = commands[state.commandIndex++];
    if (command.type === "damage-building") {
      const building = state.buildings.find(({ id }) => id === command.buildingId);
      const applied = building.alive ? Math.min(building.health, command.amount) : 0;
      if (building.alive) building.health -= applied;
      const events = [{
        amountApplied: applied,
        amountRequested: command.amount,
        buildingId: command.buildingId,
        sequence: command.sequence,
        tick: state.tick,
        type: "building-damaged",
      }];
      if (building.alive && building.health === 0) {
        events.push(destroy(state, building, "damage"));
      }
      eventsBySequence.set(command.sequence, events);
    } else {
      spendCommands.push(command);
    }
  }
  return { eventsBySequence, spendCommands };
}

function advance(state, commands, elixir) {
  const historyStart = state.history.length;
  const { eventsBySequence, spendCommands } =
    applyDamageCommands(state, commands);
  const lifecycleEvents = [];
  for (const building of state.buildings) {
    if (building.alive && state.tick >= RESOURCE_RULE.lifetimeTicks) {
      lifecycleEvents.push(destroy(state, building, "lifetime"));
    }
  }
  for (const building of state.buildings) {
    if (
      building.alive &&
      !building.deployed &&
      state.tick >= RESOURCE_RULE.deployTicks
    ) {
      building.deployed = true;
      lifecycleEvents.push({
        buildingId: building.id,
        side: building.side,
        tick: state.tick,
        type: "building-deployed",
      });
    }
  }
  const grants = [];
  for (const building of state.buildings) {
    if (
      !building.alive ||
      !building.deployed ||
      state.tick === 0 ||
      state.tick % RESOURCE_RULE.cadenceTicks !== 0
    ) continue;
    grants.push({
      amount: RESOURCE_RULE.amount,
      side: building.side,
      sourceId: building.id,
    });
  }
  const elixirEvents = elixir.step({ grants });
  const spendEvents = elixirEvents.filter(({ type }) => type === "spend");
  if (spendEvents.length !== spendCommands.length) {
    throw new Error("canonical elixir spend count diverged");
  }
  for (const [index, command] of spendCommands.entries()) {
    const event = spendEvents[index];
    eventsBySequence.set(command.sequence, [{
      accepted: event.accepted,
      amountAfter: event.amountAfter,
      amountRequested: event.cost,
      reason: event.reason === "insufficient_elixir"
        ? "insufficient_resource"
        : event.reason,
      sequence: command.sequence,
      side: event.side,
      tick: event.tick,
      type: "resource-spent",
    }]);
  }
  const firstSequence = state.commandIndex - eventsBySequence.size;
  for (let sequence = firstSequence; sequence < state.commandIndex; sequence += 1) {
    state.history.push(...eventsBySequence.get(sequence));
  }
  state.history.push(...lifecycleEvents);
  for (const event of elixirEvents) {
    if (event.type === "generated") {
      state.history.push({
        amountAfter: event.amountAfter,
        side: event.side,
        tick: event.tick,
        type: "elixir-generated",
      });
    } else if (event.type === "grant") {
      state.history.push({
        amountAfter: event.amountAfter,
        amountGranted: event.amountGranted,
        amountRequested: event.amountRequested,
        buildingId: event.sourceId,
        side: event.side,
        tick: event.tick,
        type: "resource-generated",
      });
    }
  }
  state.tick = elixir.tick;
  if (state.history.length > MAX_EVENTS) {
    throw new RangeError("resource event history exceeds its bound");
  }
  return clone(state.history.slice(historyStart));
}

export function createResourceBuildingCatalog() {
  return createCardCatalog([CARD]);
}

export function createResourceBuildingCorpusRecords() {
  return deepFreeze({
    "aether-well": {
      cost: {
        authoritative: true,
        confidence: "high",
        source: "pinned-pre-march-2023-roster",
        value: 6,
      },
      deployTicks: {
        authoritative: false,
        confidence: "unverified",
        source: "pinned-pre-march-2023-building-constants",
        value: RESOURCE_RULE.deployTicks,
      },
      hitpoints: {
        authoritative: false,
        confidence: "unverified",
        source: "pinned-pre-march-2023-building-constants",
        value: RESOURCE_RULE.hitpoints,
      },
    },
  });
}

export function createResourceBuildingQuestionRecords(...args) {
  if (args.length !== 0) {
    throw new TypeError("resource-building QUESTION records do not accept overrides");
  }
  return deepFreeze(Object.fromEntries(
    Object.entries(QUESTION_VALUES).map(([key, value]) => [key, {
      authoritative: false,
      confidence: "absent",
      disposition: "question",
      key,
      source: SOURCE,
      value: clone(value),
    }]),
  ));
}

/**
 * Version 2 is the shared-host lifecycle receipt. The standalone encounter
 * above remains the original version-1 QUESTION fixture for saved bytes.
 */
export function createSharedHostResourcePolicyRecords(...args) {
  if (args.length !== 0) {
    throw new TypeError("shared-host resource policy records do not accept overrides");
  }
  return deepFreeze(structuredClone({ version: 2, ...SHARED_HOST_RESOURCE_POLICY_V2 }));
}

export function createResourceBuildingFixture(
  buildings = [],
  commands = [],
  startingResource = { north: 0, south: 0 },
) {
  const canonicalStartingResource =
    startingResource instanceof ElixirMatch
      ? startingResource.serialize()
      : startingResource;
  return clone({
    buildings,
    commands,
    startingResource: canonicalStartingResource,
  });
}

export class ResourceBuildingEncounter {
  #elixir;
  #setup;
  #state;

  constructor(setup = createResourceBuildingFixture()) {
    this.#setup = checkedSetup(setup);
    this.#elixir = ElixirMatch.restore(
      this.#setup.startingElixirSnapshotBytes,
    );
    this.#state = initialState(this.#setup, this.#elixir.tick);
    for (const command of this.#setup.commands) {
      if (command.type === "spend-resource") {
        this.#elixir.scheduleSpend(command.tick, command.side, command.amount);
      }
    }
  }

  get state() {
    return clone({
      ...this.#state,
      elixir: this.#elixir.state,
    });
  }

  get replay() {
    return clone(this.#state.history);
  }

  replayBytes() {
    return canonicalJson(this.#state.history);
  }

  step() {
    return this.stepMany(1);
  }

  stepMany(count) {
    integer(count, "resource step count", 0, MAX_STEP_CHUNK);
    if (count > MAX_TICK - this.#state.tick) {
      throw new RangeError("resource step count exceeds the encounter bound");
    }
    const state = clone(this.#state);
    const elixir = ElixirMatch.restore(this.#elixir.serialize());
    const events = [];
    for (let index = 0; index < count; index += 1) {
      events.push(...advance(state, this.#setup.commands, elixir));
    }
    this.#state = state;
    this.#elixir = elixir;
    return clone(events);
  }

  run() {
    return this.stepMany(MAX_TICK - this.#state.tick);
  }

  serialize() {
    const serialized = canonicalJson({
      elixirSnapshotBytes: this.#elixir.serialize(),
      identity: {
        fixture: FIXTURE,
        setup: {
          buildings: this.#setup.buildings.map((building) => ({
            destroyedOpposingLaneTowers:
              clone(building.destroyedOpposingLaneTowers),
            id: building.id,
            position: clone(building.position),
            side: building.side,
          })),
          commands: [...this.#setup.commands]
            .sort((left, right) => left.sequence - right.sequence)
            .map(({ sequence: _sequence, ...command }) => command),
          startingResource: this.#setup.startingElixirSnapshotBytes,
        },
      },
      version: 1,
    });
    if (Buffer.byteLength(serialized, "utf8") > MAX_SNAPSHOT_BYTES) {
      throw new RangeError("resource snapshot exceeds its byte bound");
    }
    return serialized;
  }

  static restore(serialized) {
    if (typeof serialized !== "string") {
      throw new TypeError("resource snapshot must be a string");
    }
    if (Buffer.byteLength(serialized, "utf8") > MAX_SNAPSHOT_BYTES) {
      throw new RangeError("resource snapshot exceeds its byte bound");
    }
    let value;
    try {
      value = JSON.parse(serialized);
    } catch {
      throw new TypeError("resource snapshot must be valid JSON");
    }
    if (serialized !== canonicalJson(value)) {
      throw new TypeError("resource snapshot must be canonical JSON");
    }
    const snapshot = exactRecord(
      value,
      ["elixirSnapshotBytes", "identity", "version"],
      "resource snapshot",
    );
    if (snapshot.version !== 1) {
      throw new TypeError("resource snapshot identity or version is invalid");
    }
    const identity = exactRecord(
      snapshot.identity, ["fixture", "setup"], "resource snapshot.identity",
    );
    if (identity.fixture !== FIXTURE) {
      throw new TypeError("resource snapshot identity or version is invalid");
    }
    const canonicalElixir = ElixirMatch.restore(snapshot.elixirSnapshotBytes);
    integer(canonicalElixir.tick, "resource snapshot.tick", 0, MAX_TICK);
    const encounter = new ResourceBuildingEncounter(identity.setup);
    encounter.stepMany(canonicalElixir.tick - encounter.#state.tick);
    if (encounter.#elixir.serialize() !== snapshot.elixirSnapshotBytes) {
      throw new TypeError(
        "resource snapshot is not a causal canonical elixir execution",
      );
    }
    return encounter;
  }
}
