import { evaluateDeployment } from "../../sim/deployment.js";
import {
  MOVEMENT_SPEEDS,
  advanceMovement,
  createMovementState,
  restoreMovementState,
  serializeMovementState,
} from "../../sim/movement.js";
import { findGroundPath } from "../../sim/pathfinding.js";
import { createCardCatalog } from "../schema.js";

const SOURCE = "pre-evolutions-building-corpus-and-unsourced-travel-policy";
const FIXTURE = "underground-travel-building-encounter-v1";
const MAX_BUILDINGS = 16;
const MAX_COMMANDS = 256;
const MAX_EVENTS = 4096;
const MAX_HEALTH = 1_000_000;
const MAX_OWNER_ID = 1_000_000;
const MAX_SNAPSHOT_BYTES = 1_048_576;
const MAX_STEP_CHUNK = 4096;
const MAX_TICK = 4096;

const ARCHETYPE = Object.freeze({
  cost: 4,
  deployTicks: 60,
  firstSpawnDelayTicks: 12,
  hitpoints: 1440,
  lifetimeTicks: 1800,
  speed: MOVEMENT_SPEEDS.fast,
});

const QUESTION_VALUES = Object.freeze({
  commandBoundaryOrder:
    "commands-by-command-id-then-deployment-then-travel-then-emergence-then-spawn-then-lifetime",
  deploymentCompletionBoundary:
    "underground-travel-starts-at-placement-plus-60-ticks-without-distance-on-that-boundary",
  destinationPlacementPolicy:
    "any-clear-coarse-ground-navigation-node-in-the-playfield",
  emergenceBoundary:
    "emerge-on-the-first-boundary-that-completes-the-final-path-segment",
  emergenceSpawnDelayTicks: 12,
  emergenceSpawnPolicy:
    "one-owned-ground-unit-at-the-destination-12-ticks-after-emergence",
  interruptionPolicy:
    "explicit-interruption-destroys-deploying-or-traveling-building-without-emergence-or-spawn",
  lifetimeBoundary:
    "emerged-building-dies-at-emergence-plus-1800-ticks",
  lifetimeTicks: 1800,
  ordinaryDamageWhileUntargetable:
    "ordinary-damage-commands-are-ignored-before-emergence",
  pathPolicy:
    "passed-coarse-ground-shortest-path-with-its-stable-west-first-tie-break",
  sameBoundaryDeathPolicy:
    "command-phase-lethal-damage-or-death-prevents-that-boundarys-emergence-spawn-or-lifetime-work",
  travelSpeedMillitilesPerSecond: MOVEMENT_SPEEDS.fast,
  undergroundTargetabilityPolicy:
    "deploying-and-underground-buildings-are-untargetable-emerged-buildings-are-targetable",
});

const CORPUS_VALUES = Object.freeze({
  cost: ARCHETYPE.cost,
  deployTicks: ARCHETYPE.deployTicks,
  firstSpawnDelayTicks: ARCHETYPE.firstSpawnDelayTicks,
  hitpoints: ARCHETYPE.hitpoints,
});

const CARD_DEFINITIONS = Object.freeze([Object.freeze({
  areaDamageRadiusMillitiles: null,
  components: [],
  cost: ARCHETYPE.cost,
  count: 1,
  damage: null,
  deployTimeTicks: ARCHETYPE.deployTicks,
  displayName: "Burrow Rig",
  firstHitTicks: ARCHETYPE.firstSpawnDelayTicks,
  hitSpeedTicks: 66,
  hitpoints: ARCHETYPE.hitpoints,
  id: "burrow-rig",
  kind: "structure",
  movementMillitilesPerSecond: 0,
  rangeMillitiles: 2000,
  rarity: "mythic",
  sightRangeMillitiles: 2000,
  targetMode: "ground",
})]);

const BUILDING_KEYS = Object.freeze([
  "destination", "destroyedOpposingLaneTowers", "id", "origin", "ownerId", "side",
]);
const COMMAND_KEYS = Object.freeze(["amount", "buildingId", "id", "tick", "type"]);
const COMMAND_TYPES = new Set(["damage-building", "interrupt-travel", "kill-building"]);

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

function denseArray(value, label, maximum) {
  if (
    !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > maximum
  ) throw new TypeError(`${label} must be a bounded plain array`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(descriptors).length !== value.length + 1 ||
    Array.from({ length: value.length }, (_, index) => index).some((index) =>
      !descriptors[index]?.enumerable || !Object.hasOwn(descriptors[index], "value"))
  ) throw new TypeError(`${label} must contain dense data properties`);
  return Array.from({ length: value.length }, (_, index) => descriptors[index].value);
}

function integer(value, label, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label} must be a bounded safe integer`);
  }
  return value;
}

function point(value, label) {
  const checked = exactRecord(value, ["x", "y"], label);
  integer(checked.x, `${label}.x`, -1_000_000, 1_000_000);
  integer(checked.y, `${label}.y`, -1_000_000, 1_000_000);
  return { x: checked.x, y: checked.y };
}

function checkedBuildings(value) {
  const buildings = denseArray(value, "travel buildings", MAX_BUILDINGS)
    .map((entry, index) => {
      const label = `travel building ${index}`;
      const item = exactRecord(entry, BUILDING_KEYS, label);
      const id = integer(item.id, `${label}.id`, 1);
      const ownerId = integer(item.ownerId, `${label}.ownerId`, 1, MAX_OWNER_ID);
      const origin = point(item.origin, `${label}.origin`);
      const destination = point(item.destination, `${label}.destination`);
      const lanes = denseArray(
        item.destroyedOpposingLaneTowers,
        `${label}.destroyedOpposingLaneTowers`,
        2,
      );
      const placement = evaluateDeployment({
        destroyedOpposingLaneTowers: lanes,
        placementClass: "ground_entity",
        point: origin,
        side: item.side,
      });
      if (!placement.legal) {
        throw new TypeError(`${label} origin is illegal: ${placement.reason}`);
      }
      const path = findGroundPath(origin, destination);
      if (path === null) throw new TypeError(`${label} destination has no ground path`);
      return {
        destination, destroyedOpposingLaneTowers: clone(lanes), id, origin,
        ownerId, path, placement, side: item.side,
      };
    }).sort((a, b) => a.id - b.id);
  const ids = new Set();
  for (const building of buildings) {
    if (ids.has(building.id)) throw new TypeError("travel building IDs must be unique");
    ids.add(building.id);
  }
  return buildings;
}

function checkedCommands(value, buildings) {
  const buildingIds = new Set(buildings.map(({ id }) => id));
  const commands = denseArray(value, "travel building commands", MAX_COMMANDS)
    .map((entry, index) => {
      const label = `travel building command ${index}`;
      const item = exactRecord(entry, COMMAND_KEYS, label);
      if (!COMMAND_TYPES.has(item.type)) throw new TypeError(`${label}.type is invalid`);
      const command = {
        amount: item.amount,
        buildingId: integer(item.buildingId, `${label}.buildingId`, 1),
        id: integer(item.id, `${label}.id`, 1),
        tick: integer(item.tick, `${label}.tick`, 0, MAX_TICK - 1),
        type: item.type,
      };
      if (!buildingIds.has(command.buildingId)) {
        throw new TypeError(`${label}.buildingId is unknown`);
      }
      if (command.type === "damage-building") {
        command.amount = integer(item.amount, `${label}.amount`, 1, MAX_HEALTH);
      } else if (item.amount !== null) {
        throw new TypeError(`${label}.amount must be null`);
      }
      return command;
    });
  const ids = new Set();
  let priorTick = -1;
  let priorId = -1;
  for (const command of commands) {
    if (ids.has(command.id)) throw new TypeError("travel command IDs must be unique");
    ids.add(command.id);
    if (
      command.tick < priorTick ||
      (command.tick === priorTick && command.id <= priorId)
    ) throw new TypeError("travel commands must use increasing tick and command-ID order");
    priorTick = command.tick;
    priorId = command.id;
  }
  return commands;
}

function checkedSetup(value) {
  const setup = exactRecord(value, ["buildings", "commands"], "travel building setup");
  const buildings = checkedBuildings(setup.buildings);
  return { buildings, commands: checkedCommands(setup.commands, buildings) };
}

function segmentState(path, index) {
  if (index >= path.length - 1) {
    return serializeMovementState(createMovementState());
  }
  return serializeMovementState(createMovementState({
    direction: 1,
    speed: ARCHETYPE.speed,
  }));
}

function initialState(setup) {
  return {
    buildings: setup.buildings.map((item) => ({
      alive: true,
      archetypeId: "burrow-rig",
      destination: clone(item.destination),
      emergedTick: null,
      health: ARCHETYPE.hitpoints,
      id: item.id,
      movementPrimitive: segmentState(item.path, 0),
      nextSpawnTick: null,
      ownerId: item.ownerId,
      path: clone(item.path),
      pathIndex: 0,
      phase: "deploying",
      placement: clone(item.placement),
      position: clone(item.origin),
      spawnCount: 0,
      targetable: false,
      travelStartedTick: null,
    })),
    commandIndex: 0,
    history: [],
    tick: 0,
  };
}

function destroy(state, building, reason, events) {
  if (!building.alive) return;
  building.alive = false;
  building.health = 0;
  building.phase = "dead";
  building.targetable = false;
  building.nextSpawnTick = null;
  events.push({
    buildingId: building.id,
    reason,
    tick: state.tick,
    type: "travel-building-destroyed",
  });
}

function applyCommands(state, commands, events) {
  while (commands[state.commandIndex]?.tick === state.tick) {
    const command = commands[state.commandIndex++];
    const building = state.buildings.find(({ id }) => id === command.buildingId);
    if (!building.alive) continue;
    if (command.type === "damage-building") {
      if (!building.targetable) {
        events.push({
          amount: command.amount,
          buildingId: building.id,
          reason: "untargetable",
          tick: state.tick,
          type: "travel-damage-ignored",
        });
        continue;
      }
      building.health = Math.max(0, building.health - command.amount);
      events.push({
        amount: command.amount,
        buildingId: building.id,
        healthAfter: building.health,
        tick: state.tick,
        type: "travel-building-damaged",
      });
      if (building.health === 0) destroy(state, building, "damage", events);
      continue;
    }
    if (command.type === "interrupt-travel") {
      if (building.phase === "deploying" || building.phase === "underground") {
        destroy(state, building, "interrupted", events);
      }
      continue;
    }
    destroy(state, building, "forced-death", events);
  }
}

function startTravel(state, building, events) {
  building.phase = "underground";
  building.travelStartedTick = state.tick;
  events.push({
    buildingId: building.id,
    destination: clone(building.destination),
    path: clone(building.path),
    tick: state.tick,
    type: "underground-travel-started",
  });
  if (building.path.length === 1) emerge(state, building, events);
}

function emerge(state, building, events) {
  building.phase = "emerged";
  building.position = clone(building.destination);
  building.targetable = true;
  building.emergedTick = state.tick;
  building.nextSpawnTick = state.tick + ARCHETYPE.firstSpawnDelayTicks;
  building.movementPrimitive = serializeMovementState(createMovementState());
  events.push({
    buildingId: building.id,
    position: clone(building.position),
    tick: state.tick,
    type: "travel-building-emerged",
  });
}

function moveUnderground(state, building, events) {
  const from = building.path[building.pathIndex];
  const to = building.path[building.pathIndex + 1];
  const segmentLength = Math.abs(to.x - from.x) + Math.abs(to.y - from.y);
  const primitive = advanceMovement(
    restoreMovementState(building.movementPrimitive),
    1,
  );
  const progress = Math.min(segmentLength, primitive.position);
  building.position = {
    x: from.x + Math.sign(to.x - from.x) * progress,
    y: from.y + Math.sign(to.y - from.y) * progress,
  };
  events.push({
    buildingId: building.id,
    pathIndex: building.pathIndex,
    position: clone(building.position),
    tick: state.tick,
    type: "underground-travel-moved",
  });
  if (primitive.position < segmentLength) {
    building.movementPrimitive = serializeMovementState(primitive);
    return;
  }
  building.pathIndex += 1;
  building.movementPrimitive = segmentState(building.path, building.pathIndex);
  if (building.pathIndex === building.path.length - 1) emerge(state, building, events);
}

function advance(state, setup) {
  if (state.tick >= MAX_TICK) return [];
  const events = [];
  applyCommands(state, setup.commands, events);
  for (const building of state.buildings) {
    if (!building.alive) continue;
    if (building.phase === "deploying" && state.tick === ARCHETYPE.deployTicks) {
      startTravel(state, building, events);
      continue;
    }
    if (building.phase === "underground") {
      moveUnderground(state, building, events);
      continue;
    }
    if (building.phase !== "emerged") continue;
    if (state.tick === building.nextSpawnTick) {
      building.spawnCount += 1;
      building.nextSpawnTick = null;
      events.push({
        buildingId: building.id,
        ownerId: building.ownerId,
        position: clone(building.position),
        spawnId: `${building.id}:${building.spawnCount}`,
        tick: state.tick,
        type: "travel-emergence-spawn",
      });
    }
    if (state.tick === building.emergedTick + ARCHETYPE.lifetimeTicks) {
      destroy(state, building, "lifetime", events);
    }
  }
  if (state.history.length + events.length > MAX_EVENTS) {
    throw new RangeError("travel building replay exceeds its event bound");
  }
  state.history.push(...clone(events));
  state.tick += 1;
  return events;
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

export function createUndergroundTravelBuildingCatalog(...args) {
  if (args.length !== 0) throw new TypeError("travel building catalog does not accept overrides");
  return createCardCatalog(clone(CARD_DEFINITIONS));
}

export function createUndergroundTravelBuildingCorpusRecords(...args) {
  if (args.length !== 0) throw new TypeError("travel building corpus does not accept overrides");
  return deepFreeze(Object.fromEntries(
    Object.entries(CORPUS_VALUES).map(([key, value]) => [key, {
      authoritative: false,
      confidence: "unverified",
      source: "pinned-pre-march-2023-building-constants",
      value,
    }]),
  ));
}

export function createUndergroundTravelBuildingQuestionRecords(...args) {
  if (args.length !== 0) throw new TypeError("travel building questions do not accept overrides");
  return deepFreeze(Object.fromEntries(
    Object.entries(QUESTION_VALUES).map(([key, value]) => [
      key, questionRecord(key, value),
    ]),
  ));
}

export function createUndergroundTravelBuildingFixture(buildings = [], commands = []) {
  checkedSetup({ buildings, commands });
  return clone({ buildings, commands });
}

export class UndergroundTravelBuildingEncounter {
  #setup;
  #state;

  constructor(setup = createUndergroundTravelBuildingFixture()) {
    this.#setup = checkedSetup(setup);
    this.#state = initialState(this.#setup);
  }

  get replay() { return clone(this.#state.history); }
  get state() { return clone(this.#state); }
  step() { return this.stepMany(1); }

  stepMany(count) {
    integer(count, "travel building step count", 0, MAX_STEP_CHUNK);
    if (count > MAX_TICK - this.#state.tick) {
      throw new RangeError("travel building step count exceeds encounter bound");
    }
    const candidate = clone(this.#state);
    const events = [];
    for (let index = 0; index < count; index += 1) {
      events.push(...advance(candidate, this.#setup));
    }
    this.#state = candidate;
    return clone(events);
  }

  run() { return this.stepMany(MAX_TICK - this.#state.tick); }

  serialize() {
    const serialized = canonicalJson({
      identity: {
        buildings: this.#setup.buildings.map((building) => ({
          destination: building.destination,
          destroyedOpposingLaneTowers: building.destroyedOpposingLaneTowers,
          id: building.id,
          origin: building.origin,
          ownerId: building.ownerId,
          side: building.side,
        })),
        commands: this.#setup.commands,
        fixture: FIXTURE,
      },
      state: this.#state,
      version: 1,
    });
    if (Buffer.byteLength(serialized, "utf8") > MAX_SNAPSHOT_BYTES) {
      throw new RangeError("travel building snapshot exceeds its byte bound");
    }
    return serialized;
  }

  static restore(serialized) {
    if (typeof serialized !== "string") {
      throw new TypeError("travel building snapshot must be a string");
    }
    if (Buffer.byteLength(serialized, "utf8") > MAX_SNAPSHOT_BYTES) {
      throw new RangeError("travel building snapshot exceeds its byte bound");
    }
    let value;
    try { value = JSON.parse(serialized); } catch {
      throw new TypeError("travel building snapshot must be valid JSON");
    }
    if (canonicalJson(value) !== serialized) {
      throw new TypeError("travel building snapshot must be canonical duplicate-free JSON");
    }
    const snapshot = exactRecord(value, ["identity", "state", "version"], "travel building snapshot");
    if (snapshot.version !== 1) throw new TypeError("travel building snapshot version is unsupported");
    const identity = exactRecord(
      snapshot.identity,
      ["buildings", "commands", "fixture"],
      "travel building snapshot.identity",
    );
    if (identity.fixture !== FIXTURE) throw new TypeError("travel building snapshot fixture is invalid");
    integer(snapshot.state?.tick, "travel building snapshot.state.tick", 0, MAX_TICK);
    const encounter = new UndergroundTravelBuildingEncounter({
      buildings: identity.buildings,
      commands: identity.commands,
    });
    encounter.stepMany(snapshot.state.tick);
    if (canonicalJson(encounter.#state) !== canonicalJson(snapshot.state)) {
      throw new TypeError("travel building snapshot state is not a causal execution");
    }
    return encounter;
  }
}
