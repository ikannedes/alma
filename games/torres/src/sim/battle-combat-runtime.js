import { AttackCycle } from "./attack-cycle.js";
import { DamageSystem } from "./damage.js";
import {
  MAX_SPATIAL_MILLITILES,
  validateCircle,
  validatePosition,
} from "./spatial.js";
import { retainOrAcquireTarget } from "./targeting.js";
import {
  appendCombatEffectChild,
  appendCombatEffectProjectileRoot,
  appendCombatEffectStructureContacts,
  combatEffectRootId,
  combatEffectFeedSnapshot,
  createCombatEffectFeed,
  serializeCombatEffectFeed,
} from "./combat-effect-feed.js";
import { appendSpellAreaImpact, checkedAreaImpact } from "./spell-area-impact.js";
import {
  checkedCombatSpawn as checkedSpawn,
  checkedCombatUnit as checkedUnit,
  copyCombatUnitFields,
  planOrdinaryProjectileSplashImpact,
} from "./ordinary-projectile-splash.js";
import {
  canonicalMeleeAreaSetup,
  exactMeleeAreaSetup,
  planMeleeUnitAttack,
} from "./area-target-selection.js";
import {
  advanceOrdinaryProjectileQueue,
  ordinaryProjectileImpactTargetStatus,
  ordinaryProjectileTargetInRange,
  ordinaryProjectileTravelTicks,
  resolveOrdinaryProjectileHomingTarget,
} from "./ordinary-projectile-homing.js";
import { opaqueContinuation } from "./opaque-continuation.js";

export function defineBattleCombat(registerCompact) {
  let compact, currentTick, recordStructureContacts;
  const runtimeInstances = new WeakSet();
  const previewReceipts = new WeakMap();

const MAX_BATTLE_COMBAT_STEP_TICKS = 18_000;

const MAX_TICK = 1_000_000_000;
const MAX_UNITS = 1_024;
const MAX_HISTORY = 100_000;
const MAX_SNAPSHOT_BYTES = 1_048_576;
const MAX_STAT = 1_000_000_000;
const MAX_EXTERNAL_ENTRIES = 1_024;
const EXPLICIT_HISTORY_TAIL = 256;
const SNAPSHOT_GRAPH_LIMITS = Object.freeze({
  arrayLength: 200_000,
  containers: 100_000,
  depth: 128,
  keys: 1_024,
  nodes: 200_000,
  stringLength: 524_288,
});
const SIDES = new Set(["north", "south"]);
const POSITION_KEYS = ["id", "position", "tick"];
const POSITIONS_KEYS = ["positions", "tick"];
const STRUCTURE_KEYS = [
  "alive", "id", "kind", "layer", "position", "radius", "side",
  "structureId", "targetable",
];
const EXTERNAL_HIT_KEYS = ["damage", "delivery", "sourceId", "targetUnitId"];
const EXTERNAL_PROJECTILE_KEYS = [
  "attackSequence", "damage", "direction", "projectileId", "sourceId",
  "projectileIdentity", "targetUnitId",
];
const BOUNDARY_KEYS = ["externalHits", "externalProjectiles", "structures", "tick"];
const STATUS_BOUNDARY_KEYS = [...BOUNDARY_KEYS, "unitControls", "unitHeals"];
const UNIT_CONTROL_KEYS = ["attackBlocked", "attackStep", "id", "targetable"];
const UNIT_HEAL_KEYS = ["amount", "commandId", "sourceId", "targetUnitId"];
const PROJECTILE_IDENTITY_KEYS = [
  "attackSequence", "direction", "projectileId", "sourceId",
];
const PROJECTILE_DIRECTIONS = new Set([
  "unit-to-tower", "unit-to-unit", "tower-to-unit",
]);

function plain(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype &&
       Object.getPrototypeOf(value) !== null) ||
      Object.getOwnPropertySymbols(value).length !== 0) {
    throw new TypeError(`${label} must be a plain string-keyed data object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
      throw new TypeError(`${label}.${key} must be an enumerable data property`);
    }
  }
  return descriptors;
}

function exact(value, keys, label) {
  const descriptors = plain(value, label);
  const actual = Reflect.ownKeys(descriptors).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length ||
      actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${label} has an invalid shape`);
  }
  return Object.fromEntries(keys.map((key) => [key, descriptors[key].value]));
}

function denseArray(value, label, maximum = MAX_UNITS) {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new TypeError(`${label} must be a bounded array`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (key === "length") continue;
    if (typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key) ||
        Number(key) >= value.length) {
      throw new TypeError(`${label} must contain only indexed data`);
    }
  }
  return Array.from({ length: value.length }, (_, index) => {
    const descriptor = descriptors[index];
    if (descriptor === undefined || !descriptor.enumerable ||
        !Object.hasOwn(descriptor, "value")) {
      throw new TypeError(`${label}[${index}] must be an enumerable data property`);
    }
    return descriptor.value;
  });
}

function integer(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label} must be a safe integer from ${minimum} through ${maximum}`);
  }
  return value;
}

function checkedPosition(value) {
  const command = exact(value, POSITION_KEYS, "battle combat position command");
  return {
    id: integer(command.id, 1, Number.MAX_SAFE_INTEGER, "position command.id"),
    position: validatePosition(command.position, "position command.position"),
    tick: integer(command.tick, 0, MAX_TICK, "position command.tick"),
  };
}

function checkedPositions(value) {
  const command = exact(value, POSITIONS_KEYS, "battle combat positions command");
  const positions = denseArray(command.positions, "positions command.positions", MAX_UNITS)
    .map((entry) => {
      const checked = exact(entry, ["id", "position"], "positions command entry");
      return {
        id: integer(checked.id, 1, Number.MAX_SAFE_INTEGER, "positions command entry.id"),
        position: validatePosition(checked.position, "positions command entry.position"),
      };
    });
  if (new Set(positions.map(({ id }) => id)).size !== positions.length) {
    throw new TypeError("positions command unit IDs must be unique");
  }
  return { positions, tick: integer(command.tick, 0, MAX_TICK, "positions command.tick") };
}

function nonEmptyText(value, label) {
  if (typeof value !== "string" || value.length < 1 || value.length > 256 ||
      value.normalize("NFC") !== value || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`${label} must be bounded normalized text`);
  }
  return value;
}

function checkedStructure(value, index) {
  const label = `battle combat boundary.structures[${index}]`;
  const structure = exact(value, STRUCTURE_KEYS, label);
  if (structure.kind !== "structure") throw new TypeError(`${label}.kind is invalid`);
  if (!SIDES.has(structure.side)) throw new TypeError(`${label}.side is invalid`);
  if (structure.layer !== "ground") throw new TypeError(`${label}.layer is invalid`);
  if (typeof structure.alive !== "boolean" || typeof structure.targetable !== "boolean") {
    throw new TypeError(`${label} flags must be booleans`);
  }
  integer(structure.id, 1, Number.MAX_SAFE_INTEGER, `${label}.id`);
  nonEmptyText(structure.structureId, `${label}.structureId`);
  const position = validatePosition(structure.position, `${label}.position`);
  validateCircle({ position, radius: structure.radius }, `${label} circle`);
  return { ...structure, position: { ...position } };
}

function checkedExternalHit(value, index) {
  const label = `battle combat boundary.externalHits[${index}]`;
  const hit = exact(value, EXTERNAL_HIT_KEYS, label);
  integer(hit.damage, 0, MAX_STAT, `${label}.damage`);
  if (hit.delivery !== "melee") throw new TypeError(`${label}.delivery is invalid`);
  nonEmptyText(hit.sourceId, `${label}.sourceId`);
  integer(hit.targetUnitId, 1, Number.MAX_SAFE_INTEGER, `${label}.targetUnitId`);
  return { ...hit };
}

function checkedExternalProjectile(value, index) {
  const label = `battle combat boundary.externalProjectiles[${index}]`;
  const descriptors = plain(value, label);
  const actual = Reflect.ownKeys(descriptors).sort();
  const legacyKeys = ["damage", "projectileId", "sourceId", "targetUnitId"];
  const scalarKeys = EXTERNAL_PROJECTILE_KEYS.filter((key) => key !== "projectileIdentity");
  const legacy = actual.length === legacyKeys.length &&
    actual.every((key, keyIndex) => key === [...legacyKeys].sort()[keyIndex]);
  const scalar = actual.length === scalarKeys.length &&
    actual.every((key, keyIndex) => key === [...scalarKeys].sort()[keyIndex]);
  const projectile = legacy || scalar
    ? exact(value, legacy ? legacyKeys : scalarKeys, label)
    : exact(value, EXTERNAL_PROJECTILE_KEYS, label);
  if (legacy) {
    projectile.attackSequence = projectile.projectileId;
    projectile.direction = "tower-to-unit";
  }
  integer(projectile.attackSequence, 1, Number.MAX_SAFE_INTEGER,
    `${label}.attackSequence`);
  integer(projectile.damage, 0, MAX_STAT, `${label}.damage`);
  if (projectile.direction !== "tower-to-unit") {
    throw new TypeError(`${label}.direction is invalid`);
  }
  integer(projectile.projectileId, 1, Number.MAX_SAFE_INTEGER, `${label}.projectileId`);
  nonEmptyText(projectile.sourceId, `${label}.sourceId`);
  integer(projectile.targetUnitId, 1, Number.MAX_SAFE_INTEGER, `${label}.targetUnitId`);
  const expectedIdentity = {
    attackSequence: projectile.attackSequence,
    direction: projectile.direction,
    projectileId: projectile.projectileId,
    sourceId: projectile.sourceId,
  };
  if (!legacy && !scalar) {
    const nested = exact(projectile.projectileIdentity, PROJECTILE_IDENTITY_KEYS,
      `${label}.projectileIdentity`);
    if (canonical(nested) !== canonical(expectedIdentity)) {
      throw new TypeError(`${label}.projectileIdentity does not match its scalar mirrors`);
    }
  }
  return { ...projectile, projectileIdentity: expectedIdentity };
}

function checkedUnitControl(value, index) {
  const label = `battle combat boundary.unitControls[${index}]`;
  const control = exact(value, UNIT_CONTROL_KEYS, label);
  integer(control.id, 1, Number.MAX_SAFE_INTEGER, `${label}.id`);
  if (typeof control.attackBlocked !== "boolean" || typeof control.targetable !== "boolean" ||
      !["normal", "pause"].includes(control.attackStep)) {
    throw new TypeError(`${label} contains invalid status control flags`);
  }
  return {
    attackBlocked: control.attackBlocked,
    attackStep: control.attackStep,
    id: control.id,
    targetable: control.targetable,
  };
}

function checkedUnitHeal(value, index) {
  const label = `battle combat boundary.unitHeals[${index}]`;
  const heal = exact(value, UNIT_HEAL_KEYS, label);
  integer(heal.amount, 0, MAX_STAT, `${label}.amount`);
  integer(heal.commandId, 0, Number.MAX_SAFE_INTEGER, `${label}.commandId`);
  integer(heal.sourceId, 1, Number.MAX_SAFE_INTEGER, `${label}.sourceId`);
  integer(heal.targetUnitId, 1, Number.MAX_SAFE_INTEGER, `${label}.targetUnitId`);
  return { ...heal };
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function checkedBoundary(value) {
  const descriptors = plain(value, "battle combat boundary");
  const actual = Reflect.ownKeys(descriptors).sort();
  const base = [...BOUNDARY_KEYS].sort();
  const status = [...STATUS_BOUNDARY_KEYS].sort();
  const hasStatus = actual.length === status.length &&
    actual.every((key, index) => key === status[index]);
  if (!hasStatus && (actual.length !== base.length ||
      actual.some((key, index) => key !== base[index]))) {
    throw new TypeError("battle combat boundary has an invalid shape");
  }
  const boundary = exact(value, hasStatus ? STATUS_BOUNDARY_KEYS : BOUNDARY_KEYS,
    "battle combat boundary");
  const tick = integer(boundary.tick, 0, MAX_TICK, "battle combat boundary.tick");
  const structures = denseArray(
    boundary.structures, "battle combat boundary.structures", MAX_EXTERNAL_ENTRIES,
  ).map(checkedStructure).sort((left, right) =>
    left.id - right.id || compareText(left.structureId, right.structureId));
  const ids = new Set();
  const structureIds = new Set();
  for (const structure of structures) {
    if (ids.has(structure.id) || structureIds.has(structure.structureId)) {
      throw new TypeError("battle combat boundary structures must have unique IDs");
    }
    ids.add(structure.id);
    structureIds.add(structure.structureId);
  }
  const externalHits = denseArray(
    boundary.externalHits, "battle combat boundary.externalHits", MAX_EXTERNAL_ENTRIES,
  ).map(checkedExternalHit).sort((left, right) =>
    left.targetUnitId - right.targetUnitId || compareText(left.sourceId, right.sourceId) ||
    left.damage - right.damage);
  const hitIdentities = new Set();
  for (const hit of externalHits) {
    const identity = canonical({
      delivery: hit.delivery,
      sourceId: hit.sourceId,
      targetUnitId: hit.targetUnitId,
    });
    if (hitIdentities.has(identity)) {
      throw new TypeError("battle combat boundary external hit identities must be unique");
    }
    hitIdentities.add(identity);
  }
  const externalProjectiles = denseArray(
    boundary.externalProjectiles,
    "battle combat boundary.externalProjectiles",
    MAX_EXTERNAL_ENTRIES,
  ).map(checkedExternalProjectile).sort((left, right) =>
    left.projectileId - right.projectileId);
  if (new Set(externalProjectiles.map(({ projectileId }) => projectileId)).size !==
      externalProjectiles.length) {
    throw new TypeError("battle combat boundary external projectile IDs must be unique");
  }
  if (!hasStatus) return { externalHits, externalProjectiles, structures, tick };
  const unitControls = denseArray(boundary.unitControls,
    "battle combat boundary.unitControls", MAX_UNITS)
    .map(checkedUnitControl,)
    .sort((left, right) => left.id - right.id);
  if (new Set(unitControls.map(({ id }) => id)).size !== unitControls.length) {
    throw new TypeError("battle combat boundary unit control IDs must be unique");
  }
  const unitHeals = denseArray(boundary.unitHeals,
    "battle combat boundary.unitHeals", MAX_EXTERNAL_ENTRIES)
    .map(checkedUnitHeal)
    .sort((left, right) => left.commandId - right.commandId ||
      left.sourceId - right.sourceId || left.targetUnitId - right.targetUnitId);
  if (new Set(unitHeals.map(({ commandId, sourceId }) =>
    `${sourceId}:${commandId}`)).size !== unitHeals.length) {
    throw new TypeError("battle combat boundary unit heal source/command identities must be unique");
  }
  return { externalHits, externalProjectiles, structures, tick, unitControls, unitHeals };
}

function emptyBoundary(tick) {
  return { externalHits: [], externalProjectiles: [], structures: [], tick };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function scalarString(value, maximum, label) {
  if (value.length > maximum) throw new RangeError(`${label} string length bound exceeded`);
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xD800 && code <= 0xDBFF) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xDC00 && next <= 0xDFFF)) {
        throw new TypeError(`${label} strings must contain only Unicode scalar values`);
      }
      index += 1;
    } else if (code >= 0xDC00 && code <= 0xDFFF) {
      throw new TypeError(`${label} strings must contain only Unicode scalar values`);
    }
  }
}

function preflightParsedGraph(root, limits, label) {
  const pending = [{ depth: 0, value: root }];
  let nodes = 0;
  let containers = 0;
  while (pending.length > 0) {
    const { depth, value } = pending.pop();
    nodes += 1;
    if (nodes > limits.nodes) throw new RangeError(`${label} node bound exceeded`);
    if (depth > limits.depth) throw new RangeError(`${label} depth bound exceeded`);
    if (typeof value === "string") {
      scalarString(value, limits.stringLength, label);
      continue;
    }
    if (typeof value === "number") {
      if (!Number.isSafeInteger(value)) throw new TypeError(`${label} numbers must be safe integers`);
      continue;
    }
    if (value === null || typeof value !== "object") continue;
    containers += 1;
    if (containers > limits.containers) throw new RangeError(`${label} container bound exceeded`);
    if (Array.isArray(value)) {
      if (value.length > limits.arrayLength) {
        throw new RangeError(`${label} array length bound exceeded`);
      }
      for (let index = 0; index < value.length; index += 1) {
        pending.push({ depth: depth + 1, value: value[index] });
      }
    } else {
      const keys = Object.keys(value);
      if (keys.length > limits.keys) throw new RangeError(`${label} object key bound exceeded`);
      for (const key of keys) {
        scalarString(key, limits.stringLength, `${label} key`);
        pending.push({ depth: depth + 1, value: value[key] });
      }
    }
  }
}

function same(left, right) {
  return canonical(left) === canonical(right);
}

// Both values come from independently decoded BattleCombat runtimes, never
// from a caller-owned graph. Compare their JSON-like continuation fields
// without recursively walking or materializing a second canonical transcript.
// Work and auxiliary memory are linear in the already-admitted runtime graphs.
function iterativeSemanticEqual(left, right) {
  const pending = [[left, right]];
  while (pending.length > 0) {
    const [leftValue, rightValue] = pending.pop();
    if (leftValue === rightValue) continue;
    if (leftValue === null || rightValue === null ||
        typeof leftValue !== typeof rightValue || typeof leftValue !== "object") {
      return false;
    }
    const leftArray = Array.isArray(leftValue);
    if (leftArray !== Array.isArray(rightValue)) return false;
    const leftDescriptors = Object.getOwnPropertyDescriptors(leftValue);
    const rightDescriptors = Object.getOwnPropertyDescriptors(rightValue);
    const leftKeys = Reflect.ownKeys(leftDescriptors)
      .filter((key) => !(leftArray && key === "length")).sort();
    const rightKeys = Reflect.ownKeys(rightDescriptors)
      .filter((key) => !(leftArray && key === "length")).sort();
    if (leftArray && leftValue.length !== rightValue.length) return false;
    if (leftKeys.length !== rightKeys.length ||
        leftKeys.some((key, index) => key !== rightKeys[index])) return false;
    for (let index = leftKeys.length - 1; index >= 0; index -= 1) {
      const key = leftKeys[index];
      const leftDescriptor = leftDescriptors[key];
      const rightDescriptor = rightDescriptors[key];
      if (!Object.hasOwn(leftDescriptor, "value") ||
          !Object.hasOwn(rightDescriptor, "value") ||
          leftDescriptor.enumerable !== rightDescriptor.enumerable) return false;
      pending.push([leftDescriptor.value, rightDescriptor.value]);
    }
  }
  return true;
}

function boundaryPayload(command, structureSet) {
  return {
    externalHits: command.externalHits,
    externalProjectiles: command.externalProjectiles,
    structureSet,
  };
}

function positionVelocity(left, right) {
  if (left.length !== right.length) return null;
  const velocity = [];
  for (let index = 0; index < left.length; index += 1) {
    if (left[index].id !== right[index].id) return null;
    velocity.push({
      dx: right[index].position.x - left[index].position.x,
      dy: right[index].position.y - left[index].position.y,
      id: left[index].id,
    });
  }
  return velocity;
}

function applyVelocity(positions, velocity) {
  return positions.map((entry, index) => ({
    id: entry.id,
    position: {
      x: entry.position.x + velocity[index].dx,
      y: entry.position.y + velocity[index].dy,
    },
  }));
}

function compactHistory(history) {
  const structureSets = [];
  const structureIndexes = new Map();
  const structureSet = (structures) => {
    const key = canonical(structures);
    let index = structureIndexes.get(key);
    if (index === undefined) {
      index = structureSets.length;
      structureIndexes.set(key, index);
      structureSets.push(clone(structures));
    }
    return index;
  };
  const transcript = [];
  for (let index = 0; index < history.length;) {
    const operation = history[index];
    if (operation.type === "step") {
      let ticks = 1;
      while (history[index + ticks]?.type === "step" &&
          history[index + ticks].tick === operation.tick + ticks) ticks += 1;
      transcript.push({ tick: operation.tick, ticks, type: "step-run" });
      index += ticks;
      continue;
    }
    if (operation.type === "positions" && history[index + 1]?.type === "boundary" &&
        operation.command.tick === history[index + 1].command.tick) {
      const firstPositions = clone(operation.command.positions);
      const firstBoundary = history[index + 1].command;
      const payload = boundaryPayload(firstBoundary, structureSet(firstBoundary.structures));
      let ticks = 1;
      let velocity = null;
      let prior = firstPositions;
      while (history[index + ticks * 2]?.type === "positions" &&
          history[index + ticks * 2 + 1]?.type === "boundary") {
        const nextPositions = history[index + ticks * 2].command;
        const nextBoundary = history[index + ticks * 2 + 1].command;
        if (nextPositions.tick !== operation.command.tick + ticks ||
            nextBoundary.tick !== nextPositions.tick ||
            !same(payload, boundaryPayload(nextBoundary, structureSet(nextBoundary.structures)))) break;
        const delta = positionVelocity(prior, nextPositions.positions);
        if (delta === null || (velocity !== null && !same(delta, velocity))) break;
        velocity ??= delta;
        prior = nextPositions.positions;
        ticks += 1;
      }
      transcript.push({
        boundary: payload,
        positions: firstPositions,
        tick: operation.command.tick,
        ticks,
        type: "position-boundary-run",
        velocity: velocity ?? firstPositions.map(({ id }) => ({ dx: 0, dy: 0, id })),
      });
      index += ticks * 2;
      continue;
    }
    if (operation.type === "boundary") {
      const payload = boundaryPayload(operation.command, structureSet(operation.command.structures));
      let ticks = 1;
      while (history[index + ticks]?.type === "boundary" &&
          history[index + ticks].command.tick === operation.command.tick + ticks &&
          same(payload, boundaryPayload(history[index + ticks].command,
            structureSet(history[index + ticks].command.structures)))) ticks += 1;
      transcript.push({ boundary: payload, tick: operation.command.tick, ticks, type: "boundary-run" });
      index += ticks;
      continue;
    }
    transcript.push(clone(operation));
    index += 1;
  }
  return { structureSets, transcript };
}


function projectileIdentity(direction, sourceId, attackSequence, projectileId) {
  if (!PROJECTILE_DIRECTIONS.has(direction)) {
    throw new TypeError("projectile identity direction is invalid");
  }
  if (!Number.isSafeInteger(attackSequence) || attackSequence < 1 ||
      !Number.isSafeInteger(projectileId) || projectileId < 1) {
    throw new TypeError("projectile identity sequence and ID must be positive safe integers");
  }
  if (!Number.isSafeInteger(sourceId) &&
      (typeof sourceId !== "string" || sourceId.length === 0 || sourceId.length > 256)) {
    throw new TypeError("projectile identity source is invalid");
  }
  return { attackSequence, direction, projectileId, sourceId };
}

function checkedProjectileIdentity(value, label = "projectile identity") {
  const identity = exact(value, PROJECTILE_IDENTITY_KEYS, label);
  return projectileIdentity(
    identity.direction,
    identity.sourceId,
    identity.attackSequence,
    identity.projectileId,
  );
}

function withProjectileIdentity(event, value) {
  const identity = checkedProjectileIdentity(value);
  if (Object.hasOwn(event, "projectileIdentity") &&
      canonical(event.projectileIdentity) !== canonical(identity)) {
    throw new TypeError("projectile event contains divergent identity provenance");
  }
  for (const [key, expected] of [
    ["attackSequence", identity.attackSequence],
    ["direction", identity.direction],
    ["projectileId", identity.projectileId],
    ["sourceId", identity.sourceId],
    ["sourceUnitId", identity.sourceId],
    ["externalProjectileId", identity.projectileId],
    ["externalSourceId", identity.sourceId],
  ]) {
    if (Object.hasOwn(event, key) && event[key] !== expected) {
      throw new TypeError(`projectile event contains divergent ${key} provenance`);
    }
  }
  if (Object.hasOwn(event, "sequence") && event.sequence !== identity.attackSequence) {
    throw new TypeError("projectile event contains divergent sequence provenance");
  }
  if (Object.hasOwn(event, "attackerId") && event.attackerId !== identity.sourceId) {
    throw new TypeError("projectile event contains divergent attacker provenance");
  }
  if (Object.hasOwn(event, "projectileScope") &&
      event.projectileScope !== identity.direction) {
    throw new TypeError("projectile event contains divergent scope provenance");
  }
  if (Object.hasOwn(event, "projectile")) {
    const projectile = event.projectile;
    if (projectile.projectileIdentity !== undefined &&
        canonical(projectile.projectileIdentity) !== canonical(identity)) {
      throw new TypeError("projectile data contains divergent identity provenance");
    }
    for (const [key, expected] of [
      ["attackSequence", identity.attackSequence],
      ["direction", identity.direction],
      ["projectileId", identity.projectileId],
      ["sourceId", identity.sourceId],
    ]) {
      if (Object.hasOwn(projectile, key) && projectile[key] !== expected) {
        throw new TypeError(`projectile data contains divergent ${key} provenance`);
      }
    }
    if (Object.hasOwn(projectile, "id") && projectile.id !== identity.projectileId) {
      throw new TypeError("projectile data contains divergent ID provenance");
    }
    if (Object.hasOwn(projectile, "attackerId") &&
        projectile.attackerId !== identity.sourceId) {
      throw new TypeError("projectile data contains divergent attacker provenance");
    }
    if (Object.hasOwn(projectile, "projectileScope") &&
        projectile.projectileScope !== identity.direction) {
      throw new TypeError("projectile data contains divergent scope provenance");
    }
  }
  return {
    ...event,
    attackSequence: identity.attackSequence,
    direction: identity.direction,
    projectileIdentity: clone(identity),
    projectileId: identity.projectileId,
    projectileScope: identity.direction,
    sourceId: identity.sourceId,
  };
}

function publicUnit(unit, health) {
  return {
    alive: !health.dead,
    attack: clone(unit.attack.state),
    cadenceTicks: unit.cadenceTicks,
    damage: unit.damage,
    delivery: unit.delivery,
    deployTicks: unit.deployTicks,
    firstHitTicks: unit.firstHitTicks,
    hitpoints: health.currentHealth,
    id: unit.id,
    layer: unit.layer,
    maxHealth: unit.maxHealth,
    position: { ...unit.position },
    projectileSpeed: unit.projectileSpeed,
    radius: unit.radius,
    reach: unit.reach,
    side: unit.side,
    sightRange: unit.sightRange,
    spawnedAt: unit.spawnedAt,
    targetId: unit.targetId,
    targetMode: unit.targetMode,
  };
}

/**
 * Dynamic deterministic combat for ordinary units.
 *
 * Boundary order is: scheduled spawns, target retention/acquisition, attack
 * readiness and launches, projectile contacts, one simultaneous damage/death
 * window, then tick advance. Position changes are explicit commands between
 * boundaries; this kernel deliberately owns no movement policy.
 */
class BattleCombat {
  #damage = new DamageSystem();
  #events = [];
  #feed = createCombatEffectFeed();
  #feedRoots = new Map();
  #history = [];
  #knownExternalStructures = [];
  #nextProjectileId = 1;
  #nextScheduleSequence = 0;
  #projectiles = [];
  #scheduled = [];
  #seenExternalProjectileIds = [];
  #setup;
  #stateToken = {};
  #tick = 0;
  #units = [];

  constructor(setup = { units: [] }) {
    runtimeInstances.add(this);
    const checked = exactMeleeAreaSetup(setup, ["units"], "battle combat setup");
    const units = denseArray(checked.units, "battle combat setup.units")
      .map((unit, index) => checkedUnit(unit, `battle combat setup.units[${index}]`));
    if (new Set(units.map(({ id }) => id)).size !== units.length) {
      throw new TypeError("battle combat setup unit IDs must be unique");
    }
    const canonicalUnits = [...units].sort((left, right) => left.id - right.id);
    this.#setup = canonicalMeleeAreaSetup(checked, canonicalUnits, clone,
      "battle combat setup");
    for (const unit of canonicalUnits) {
      this.#activate(unit, 0);
    }
  }

  get replay() {
    return deepFreeze(clone(this.#events));
  }

  /** Closed source-owned visual transcript; raw replay remains unchanged. */
  get combatEffectFeed() {
    return combatEffectFeedSnapshot(this.#feed);
  }

  get effectFeed() {
    return this.combatEffectFeed;
  }

  get visualFeed() {
    return this.combatEffectFeed;
  }

  combatEffectFeedBytes() {
    return serializeCombatEffectFeed(this.#feed);
  }

  get state() {
    return deepFreeze({
      nextProjectileId: this.#nextProjectileId,
      pendingSpawns: clone(this.#scheduled),
      projectiles: clone(this.#projectiles),
      tick: this.#tick,
      units: this.#units.map((unit) => publicUnit(unit, this.#damage.get(unit.id))),
    });
  }

  /** Exact comparison of all twelve fields that determine future behavior. */
  static continuationEquivalent(left, right) {
    if (!(left instanceof BattleCombat) || !(right instanceof BattleCombat)) {
      throw new TypeError("battle combat continuation comparison requires two runtimes");
    }
    return iterativeSemanticEqual(left.#continuationFields(), right.#continuationFields());
  }

  #continuationFields() {
    return {
      damage: this.#damage.serialize(),
      combatEffectFeed: this.#feed.serialize(),
      events: this.#events,
      history: this.#history,
      knownExternalStructures: this.#knownExternalStructures,
      nextProjectileId: this.#nextProjectileId,
      nextScheduleSequence: this.#nextScheduleSequence,
      projectiles: this.#projectiles,
      scheduled: this.#scheduled,
      seenExternalProjectileIds: this.#seenExternalProjectileIds,
      setup: this.#setup,
      tick: this.#tick,
      units: this.#units.map((unit) => ({
        ...copyCombatUnitFields(unit, clone),
        attack: unit.attack.serialize(),
        spawnedAt: unit.spawnedAt,
        targetId: unit.targetId,
      })),
    };
  }

  /**
   * Returns an independent in-memory continuation without replaying history.
   * The fork carries no shared mutable state and is suitable for transactional
   * previews by owning adapters.
   */
  fork() {
    return this.#runtimeClone();
  }

  /** Internal-composition checkpoint: exact continuation without duplicate provenance. */
  static {
    compact = (value) => value.#runtimeClone(false);
    currentTick = (value) => {
      if (!runtimeInstances.has(value)) {
        throw new TypeError("internal defineBattleCombat tick receiver is invalid");
      }
      return value.#tick;
    };
    recordStructureContacts = (value, hits, tick, events) => {
      if (!runtimeInstances.has(value)) {
        throw new TypeError("internal structure contact receiver is invalid");
      }
      value.#recordStructureContacts(hits, tick, events);
    };
  }
  /** Computes one boundary on a witness-free fork without retaining history. */
  previewBoundary(command) {
    const checked = this.#checkBoundary(command);
    const candidate = this.#runtimeClone(false);
    const trustedEvents = candidate.#applyBoundary(checked);
    const previewEvents = deepFreeze(clone(trustedEvents));
    previewReceipts.set(previewEvents, {
      command: checked,
      commandWitness: canonical(checked),
      owner: this,
      stateToken: this.#stateToken,
      trustedEvents,
      consumed: false,
    });
    return previewEvents;
  }

  /**
   * Commits only a module-minted preview capability. The capability remains
   * retryable after command admission failure; any state mutation or a
   * successful commit makes it stale or consumed. The trusted receipt keeps
   * caller-visible preview data out of the commit path while an independent
   * witness preserves atomicity without copying cumulative transcripts.
   */
  stepBoundaryAfterPreview(command, previewEvents) {
    const receipt = previewReceipts.get(previewEvents);
    if (receipt === undefined || receipt.owner !== this || receipt.consumed ||
        receipt.stateToken !== this.#stateToken) {
      throw new TypeError("battle combat preview capability is invalid or stale");
    }
    const checked = this.#checkBoundary(command);
    if (receipt.stateToken !== this.#stateToken || receipt.consumed) {
      throw new TypeError("battle combat preview capability is invalid or stale");
    }
    if (canonical(checked) !== receipt.commandWitness) {
      throw new TypeError("battle combat preview command diverged");
    }
    const candidate = this.#runtimeClone(false);
    const witness = candidate.#applyBoundary(receipt.command);
    if (canonical(witness) !== canonical(receipt.trustedEvents)) {
      throw new TypeError("battle combat preview witness diverged");
    }
    if (receipt.stateToken !== this.#stateToken || receipt.consumed) {
      throw new TypeError("battle combat preview capability is invalid or stale");
    }
    this.#adoptBoundary(candidate);
    receipt.consumed = true;
    return deepFreeze(clone(witness));
  }

  spawn(command) {
    const checked = checkedSpawn(command);
    if (checked.tick !== this.#tick) {
      throw new RangeError("spawn.tick must equal the current battle combat tick");
    }
    this.#assertNewId(checked.id);
    this.#reserveHistory();
    this.#activate(checked, checked.tick);
    this.#record({ command: checked, type: "spawn" });
    this.#stateToken = {};
    return deepFreeze(clone(this.#events.at(-1)));
  }

  scheduleSpawn(command) {
    const checked = checkedSpawn(command, "battle combat scheduled spawn");
    if (checked.tick < this.#tick) {
      throw new RangeError("scheduled spawn.tick must not precede the current tick");
    }
    this.#assertNewId(checked.id);
    if (this.#units.length + this.#scheduled.length >= MAX_UNITS) {
      throw new RangeError("battle combat unit bound exceeded");
    }
    this.#reserveHistory();
    const scheduled = { ...checked, sequence: this.#nextScheduleSequence };
    this.#nextScheduleSequence += 1;
    this.#scheduled.push(scheduled);
    this.#scheduled.sort((left, right) =>
      left.tick - right.tick || left.id - right.id || left.sequence - right.sequence);
    this.#record({ command: checked, type: "schedule-spawn" });
    this.#stateToken = {};
    return deepFreeze(clone(scheduled));
  }

  updatePosition(command) {
    const checked = checkedPosition(command);
    if (checked.tick !== this.#tick) {
      throw new RangeError("position command.tick must equal the current battle combat tick");
    }
    const unit = this.#unit(checked.id);
    if (unit === null || this.#damage.get(checked.id).dead) {
      throw new RangeError("position command requires a live unit");
    }
    this.#reserveHistory();
    const from = { ...unit.position };
    unit.position = { ...checked.position };
    const event = {
      from,
      id: unit.id,
      position: { ...unit.position },
      tick: this.#tick,
      type: "position",
    };
    this.#events.push(event);
    this.#record({ command: checked, type: "position" });
    this.#stateToken = {};
    return deepFreeze(clone(event));
  }

  updatePositions(command) {
    const checked = checkedPositions(command);
    if (checked.tick !== this.#tick) {
      throw new RangeError("positions command.tick must equal the current battle combat tick");
    }
    if (this.#history.length >= MAX_HISTORY) {
      throw new RangeError("battle combat history bound exceeded");
    }
    for (const entry of checked.positions) {
      const unit = this.#unit(entry.id);
      if (unit === null || this.#damage.get(entry.id).dead) {
        throw new RangeError("positions command requires live units");
      }
    }
    const events = checked.positions.map((entry) => {
      const unit = this.#unit(entry.id);
      const from = { ...unit.position };
      unit.position = { ...entry.position };
      return { from, id: unit.id, position: { ...unit.position }, tick: this.#tick, type: "position" };
    });
    this.#events.push(...events);
    this.#record({ command: checked, type: "positions" });
    this.#stateToken = {};
    return deepFreeze(clone(events));
  }

  /** Records a resolved, deterministic spell area for the browser effect feed. */
  recordAreaImpact(command) {
    const checked = checkedAreaImpact(command, this.#tick, MAX_TICK);
    this.#reserveHistory();
    const candidate = this.#runtimeClone();
    appendSpellAreaImpact(candidate.#feed, checked);
    candidate.#record({ command: checked, type: "area-impact" });
    candidate.#stateToken = {};
    this.#adopt(candidate);
    return deepFreeze(clone(checked));
  }

  step(tick = this.#tick) {
    integer(tick, 0, MAX_TICK, "battle combat step tick");
    if (tick !== this.#tick) {
      throw new RangeError("battle combat step tick must equal the current tick");
    }
    return this.stepMany(1);
  }

  /**
   * Advances one boundary with structures and already-contacting external
   * damage supplied by an owning session. External structures remain data-only
   * targets: this kernel owns unit health/attack state and emits contacts for
   * the session to apply to its authoritative structure health exactly once.
   */
  stepBoundary(command) {
    const checked = this.#checkBoundary(command);
    const candidate = this.#runtimeClone();
    const events = candidate.#applyBoundary(checked);
    this.#adopt(candidate);
    return deepFreeze(clone(events));
  }

  #checkBoundary(command) {
    const checked = checkedBoundary(command);
    if (checked.tick !== this.#tick) {
      throw new RangeError("battle combat boundary.tick must equal the current tick");
    }
    if (this.#history.length >= MAX_HISTORY) {
      throw new RangeError("battle combat history bound exceeded");
    }
    const occupied = new Set([
      ...this.#units.map(({ id }) => id),
      ...this.#scheduled.map(({ id }) => id),
    ]);
    for (const structure of checked.structures) {
      if (occupied.has(structure.id)) {
        throw new RangeError("external structure candidate ID collides with a unit ID");
      }
    }
    const newStructureCount = checked.structures.filter((structure) =>
      !this.#knownExternalStructures.some(({ id }) => id === structure.id)).length;
    if (this.#knownExternalStructures.length + newStructureCount > MAX_UNITS) {
      throw new RangeError("external structure identity reservation bound exceeded");
    }
    const seen = new Set(this.#seenExternalProjectileIds);
    for (const projectile of checked.externalProjectiles) {
      if (seen.has(projectile.projectileId)) {
        throw new RangeError("external projectile ID has already contacted battle combat");
      }
      seen.add(projectile.projectileId);
    }
    const unitHeals = checked.unitHeals ?? [];
    for (const ingress of [
      ...checked.externalHits,
      ...checked.externalProjectiles,
      ...unitHeals.map(({ sourceId: _sourceId, targetUnitId, ...heal }) => ({
        ...heal,
        targetUnitId,
      })),
    ]) {
      const unit = this.#unit(ingress.targetUnitId);
      const due = this.#scheduled.some(({ id, tick }) =>
        id === ingress.targetUnitId && tick === this.#tick);
      if ((unit === null && !due) || (unit !== null && this.#damage.get(unit.id).dead)) {
        throw new RangeError("external ingress must target a live battle combat unit");
      }
    }
    for (const heal of unitHeals) {
      const source = this.#unit(heal.sourceId);
      if (source === null || this.#damage.get(source.id).dead) {
        throw new RangeError("unit heal ingress must have a live source unit");
      }
    }
    for (const structure of checked.structures) {
      const knownId = this.#knownExternalStructures.find(({ id }) => id === structure.id);
      const knownName = this.#knownExternalStructures.find(
        ({ structureId }) => structureId === structure.structureId,
      );
      if ((knownId !== undefined && knownId.structureId !== structure.structureId) ||
          (knownName !== undefined && knownName.id !== structure.id) ||
          (knownId !== undefined &&
            (knownId.side !== structure.side || knownId.kind !== structure.kind ||
             knownId.layer !== structure.layer))) {
        throw new RangeError("external structure identity mapping must remain stable");
      }
    }
    return checked;
  }

  #applyBoundary(checked) {
    const events = this.#advance(checked);
    for (const structure of checked.structures) {
      if (!this.#knownExternalStructures.some(({ id }) => id === structure.id)) {
        this.#knownExternalStructures.push({
          id: structure.id,
          kind: structure.kind,
          layer: structure.layer,
          side: structure.side,
          structureId: structure.structureId,
        });
      }
    }
    this.#knownExternalStructures.sort((left, right) => left.id - right.id);
    this.#seenExternalProjectileIds.push(
      ...checked.externalProjectiles.map(({ projectileId }) => projectileId),
    );
    this.#seenExternalProjectileIds.sort((left, right) => left - right);
    this.#history.push({ command: checked, type: "boundary" });
    this.#stateToken = {};
    return events;
  }

  stepMany(ticks) {
    integer(ticks, 0, MAX_BATTLE_COMBAT_STEP_TICKS, "battle combat step ticks");
    if (this.#tick + ticks > MAX_TICK) {
      throw new RangeError("battle combat tick bound exceeded");
    }
    if (this.#history.length + ticks > MAX_HISTORY) {
      throw new RangeError("battle combat history bound exceeded");
    }
    const candidate = this.#runtimeClone();
    const events = [];
    for (let count = 0; count < ticks; count += 1) {
      events.push(...candidate.#advance(emptyBoundary(candidate.#tick)));
      candidate.#history.push({ tick: candidate.#tick - 1, type: "step" });
    }
    this.#adopt(candidate);
    return deepFreeze(clone(events));
  }

  serialize() {
    const tailStart = Math.max(0, this.#history.length - EXPLICIT_HISTORY_TAIL);
    const compacted = compactHistory(this.#history.slice(0, tailStart));
    const serialized = canonical({
      history: this.#history.slice(tailStart),
      setup: this.#setup,
      structureSets: compacted.structureSets,
      transcript: compacted.transcript,
      version: 2,
    });
    if (new TextEncoder().encode(serialized).byteLength > MAX_SNAPSHOT_BYTES) {
      throw new RangeError("serialized battle combat exceeds the byte bound");
    }
    return serialized;
  }

  static restore(serialized) {
    if (typeof serialized !== "string") {
      throw new TypeError("serialized battle combat must be a string");
    }
    if (new TextEncoder().encode(serialized).byteLength > MAX_SNAPSHOT_BYTES) {
      throw new RangeError("serialized battle combat exceeds the byte bound");
    }
    let snapshot;
    try { snapshot = JSON.parse(serialized); }
    catch { throw new TypeError("serialized battle combat must be valid JSON"); }
    preflightParsedGraph(snapshot, SNAPSHOT_GRAPH_LIMITS, "battle combat snapshot");
    if (canonical(snapshot) !== serialized) {
      throw new TypeError("serialized battle combat must be canonical JSON");
    }
    const snapshotShape = plain(snapshot, "battle combat snapshot");
    const version = snapshotShape.version?.value;
    if (version === 1) {
      const checked = exact(snapshot, ["history", "setup", "version"], "battle combat snapshot");
      exact(checked.setup, ["units"], "battle combat snapshot.setup");
      const restored = new BattleCombat(checked.setup);
      BattleCombat.#replayOperations(restored,
        denseArray(checked.history, "battle combat snapshot.history", MAX_HISTORY));
      return restored;
    }
    if (version !== 2) throw new TypeError("unsupported battle combat snapshot version");
    const checked = exact(snapshot,
      ["history", "setup", "structureSets", "transcript", "version"],
      "battle combat snapshot");
    const setup = exactMeleeAreaSetup(checked.setup, ["units"], "battle combat snapshot.setup");
    const transcript = denseArray(checked.transcript,
      "battle combat snapshot.transcript", MAX_HISTORY);
    const history = denseArray(checked.history, "battle combat snapshot.history", MAX_HISTORY);
    let expandedOperations = history.length;
    for (let index = 0; index < transcript.length; index += 1) {
      const record = transcript[index];
      const descriptors = plain(record, `battle combat snapshot.transcript[${index}]`);
      const type = descriptors.type?.value;
      let added = 1;
      if (type === "step-run" || type === "boundary-run" || type === "position-boundary-run") {
        const tick = integer(descriptors.tick?.value, 0, MAX_TICK,
          `battle combat snapshot.transcript[${index}].tick`);
        const ticks = integer(descriptors.ticks?.value, 1, MAX_HISTORY,
          `battle combat snapshot.transcript[${index}].ticks`);
        if (ticks - 1 > MAX_TICK - tick) {
          throw new RangeError("battle combat transcript tick bound exceeded");
        }
        added = type === "position-boundary-run" ? ticks * 2 : ticks;
      }
      if (added > MAX_HISTORY - expandedOperations) {
        throw new RangeError("battle combat transcript operation bound exceeded");
      }
      expandedOperations += added;
    }
    const structureSets = denseArray(checked.structureSets,
      "battle combat snapshot.structureSets", MAX_EXTERNAL_ENTRIES).map((structures, index) =>
      checkedBoundary({ externalHits: [], externalProjectiles: [], structures, tick: 0 }).structures);
    const restored = new BattleCombat(setup);
    let operations = 0;
    const structuresFor = (value, label) => {
      const index = integer(value, 0, structureSets.length - 1, `${label}.structureSet`);
      return structureSets[index];
    };
    for (let index = 0; index < transcript.length; index += 1) {
      const record = transcript[index];
      plain(record, `battle combat snapshot.transcript[${index}]`);
      if (record.type === "step-run") {
        const run = exact(record, ["tick", "ticks", "type"], `transcript[${index}]`);
        integer(run.tick, 0, MAX_TICK, `transcript[${index}].tick`);
        const ticks = integer(run.ticks, 1, MAX_HISTORY, `transcript[${index}].ticks`);
        for (let count = 0; count < ticks; count += 1) {
          BattleCombat.#replayOperations(restored,
            [{ tick: run.tick + count, type: "step" }]);
        }
        operations += ticks;
      } else if (record.type === "boundary-run") {
        const run = exact(record, ["boundary", "tick", "ticks", "type"], `transcript[${index}]`);
        const payload = exact(run.boundary,
          ["externalHits", "externalProjectiles", "structureSet"], `transcript[${index}].boundary`);
        const structures = structuresFor(payload.structureSet, `transcript[${index}].boundary`);
        const ticks = integer(run.ticks, 1, MAX_HISTORY, `transcript[${index}].ticks`);
        for (let count = 0; count < ticks; count += 1) restored.stepBoundary({
          externalHits: payload.externalHits,
          externalProjectiles: payload.externalProjectiles,
          structures,
          tick: run.tick + count,
        });
        operations += ticks;
      } else if (record.type === "position-boundary-run") {
        const run = exact(record,
          ["boundary", "positions", "tick", "ticks", "type", "velocity"],
          `transcript[${index}]`);
        const payload = exact(run.boundary,
          ["externalHits", "externalProjectiles", "structureSet"], `transcript[${index}].boundary`);
        const structures = structuresFor(payload.structureSet, `transcript[${index}].boundary`);
        let positions = checkedPositions({ positions: run.positions, tick: run.tick }).positions;
        const velocity = denseArray(run.velocity, `transcript[${index}].velocity`, MAX_UNITS)
          .map((entry, velocityIndex) => {
            const delta = exact(entry, ["dx", "dy", "id"], `velocity[${velocityIndex}]`);
            integer(delta.id, 1, Number.MAX_SAFE_INTEGER, `velocity[${velocityIndex}].id`);
            integer(delta.dx, -MAX_SPATIAL_MILLITILES, MAX_SPATIAL_MILLITILES,
              `velocity[${velocityIndex}].dx`);
            integer(delta.dy, -MAX_SPATIAL_MILLITILES, MAX_SPATIAL_MILLITILES,
              `velocity[${velocityIndex}].dy`);
            return delta;
          });
        if (velocity.length !== positions.length ||
            velocity.some((entry, velocityIndex) => entry.id !== positions[velocityIndex].id)) {
          throw new TypeError("position-boundary-run velocity identities diverge");
        }
        const ticks = integer(run.ticks, 1, MAX_HISTORY, `transcript[${index}].ticks`);
        for (let count = 0; count < ticks; count += 1) {
          const tick = run.tick + count;
          restored.updatePositions({ positions, tick });
          restored.stepBoundary({
            externalHits: payload.externalHits,
            externalProjectiles: payload.externalProjectiles,
            structures,
            tick,
          });
          positions = applyVelocity(positions, velocity);
        }
        operations += ticks * 2;
      } else {
        BattleCombat.#replayOperations(restored, [record]);
        operations += 1;
      }
      if (operations > MAX_HISTORY) throw new RangeError("battle combat transcript operation bound exceeded");
    }
    BattleCombat.#replayOperations(restored,
      history);
    if (restored.serialize() !== serialized) {
      throw new TypeError("battle combat snapshot is not canonical or causal");
    }
    return restored;
  }

  static #replayOperations(restored, history) {
    for (let index = 0; index < history.length; index += 1) {
      const operation = history[index];
      plain(operation, `battle combat history[${index}]`);
      if (operation.type === "spawn") {
        restored.spawn(exact(operation, ["command", "type"], `history[${index}]`).command);
      } else if (operation.type === "schedule-spawn") {
        restored.scheduleSpawn(exact(operation, ["command", "type"], `history[${index}]`).command);
      } else if (operation.type === "position") {
        restored.updatePosition(exact(operation, ["command", "type"], `history[${index}]`).command);
      } else if (operation.type === "positions") {
        restored.updatePositions(exact(operation, ["command", "type"], `history[${index}]`).command);
      } else if (operation.type === "area-impact") {
        restored.recordAreaImpact(exact(operation, ["command", "type"], `history[${index}]`).command);
      } else if (operation.type === "step") {
        const entry = exact(operation, ["tick", "type"], `history[${index}]`);
        if (entry.tick !== restored.#tick) throw new TypeError("noncausal battle combat step history");
        restored.#advance(emptyBoundary(restored.#tick));
        restored.#history.push({ tick: entry.tick, type: "step" });
        restored.#stateToken = {};
      } else if (operation.type === "boundary") {
        restored.stepBoundary(exact(operation, ["command", "type"], `history[${index}]`).command);
      } else throw new TypeError(`battle combat history[${index}] is invalid`);
    }
  }

  #advance(external) {
    const tick = this.#tick;
    const boundary = [];
    const dueSpawns = this.#scheduled.filter((entry) => entry.tick === tick);
    if (dueSpawns.length > 0) {
      if (this.#units.length + dueSpawns.length > MAX_UNITS) {
        throw new RangeError("due battle combat spawns exceed the live unit bound");
      }
      const occupied = new Set(this.#units.map(({ id }) => id));
      for (let index = 0; index < dueSpawns.length; index += 1) {
        const entry = dueSpawns[index];
        integer(entry.sequence, 0, MAX_HISTORY, `due spawn ${index}.sequence`);
        if (entry.tick !== tick) throw new RangeError(`due spawn ${index} has the wrong tick`);
        checkedUnit(copyCombatUnitFields(entry, clone), `due spawn ${index}.unit`);
        if (occupied.has(entry.id)) {
          throw new RangeError(`due spawn ${index} has an occupied unit ID`);
        }
        occupied.add(entry.id);
      }
      const ids = new Set(dueSpawns.map(({ id }) => id));
      this.#scheduled = this.#scheduled.filter((entry) => !ids.has(entry.id));
      for (const entry of dueSpawns) {
        const { sequence: ignored, tick: spawnTick, ...unit } = entry;
        void ignored;
        this.#activate(unit, spawnTick, boundary);
      }
    }

    const liveAtStart = this.#units.filter((unit) => !this.#damage.get(unit.id).dead);
    const controls = new Map((external.unitControls ?? []).map((control) => [control.id, control]));
    const externalById = new Map(external.structures.map((structure) =>
      [structure.id, structure]));
    const attacks = [];
    for (const attacker of liveAtStart.sort((left, right) => left.id - right.id)) {
      const unitCandidates = liveAtStart
        .filter((target) => target.side !== attacker.side)
        .map((target) => ({
          alive: true,
          id: target.id,
          kind: "troop",
          layer: target.layer,
          position: target.position,
          radius: target.radius,
          targetable: controls.get(target.id)?.targetable ?? true,
        }));
      const structureCandidates = external.structures
        .filter((target) => target.side !== attacker.side)
        .map((target) => ({
          alive: target.alive,
          id: target.id,
          kind: target.kind,
          layer: target.layer,
          position: target.position,
          radius: target.radius,
          targetable: target.targetable,
        }));
      const control = controls.get(attacker.id);
      const allCandidates = [...unitCandidates, ...structureCandidates];
      const targetCandidates = control?.attackBlocked && attacker.targetId !== null
        ? allCandidates.filter(({ id }) => id === attacker.targetId)
        : allCandidates;
      const target = retainOrAcquireTarget(
        { position: attacker.position, radius: attacker.radius },
        targetCandidates,
        {
          currentTargetId: attacker.targetId,
          mode: attacker.targetMode,
          sightRange: attacker.sightRange,
        },
      );
      const previous = attacker.targetId;
      attacker.targetId = target?.id ?? null;
      if (previous !== attacker.targetId) {
        boundary.push({
          fromTargetId: previous,
          id: attacker.id,
          targetId: attacker.targetId,
          tick,
          type: "target",
        });
      }
      const targetUnit = target === null ? null : this.#unit(target.id);
      const targetStructure = target === null ? null : externalById.get(target.id) ?? null;
      const attackTarget = targetUnit ?? targetStructure;
      const eligible = attackTarget !== null && ordinaryProjectileTargetInRange(
        attacker, attackTarget, attacker.reach,
      );
      const attackInput = {
        targetEligible: eligible,
        targetId: eligible ? attackTarget.id : null,
      };
      const ready = control?.attackBlocked || control?.attackStep === "pause"
        ? attacker.attack.stepPaused(attackInput)
        : attacker.attack.step(attackInput);
      for (const event of ready) {
        attacks.push({
          attacker,
          sequence: event.sequence,
          structure: targetStructure,
          target: attackTarget,
        });
      }
    }

    const queue = advanceOrdinaryProjectileQueue({
      maxTick: MAX_TICK,
      projectiles: this.#projectiles,
      resolveTarget: (projectile) => resolveOrdinaryProjectileHomingTarget(projectile,
        externalById, this.#units, this.#damage, controls),
      tick,
    });
    const dueProjectiles = queue.due;
    this.#projectiles = queue.pending;
    const hits = [];
    const hitSources = [];
    for (const attack of attacks) {
      const homing = attack.attacker.splashProfile?.homing === true;
      const duration = attack.attacker.delivery === "projectile" && !homing
        ? ordinaryProjectileTravelTicks(
          attack.attacker, attack.target, attack.attacker.projectileSpeed, MAX_TICK,
        ) : 0;
      let projectile = null;
      let projectileProvenance = null;
      if (attack.attacker.delivery === "projectile") {
        if (homing ? tick >= MAX_TICK : tick + duration > MAX_TICK) {
          throw new RangeError("projectile impact exceeds tick bounds");
        }
        const direction = attack.structure === null ? "unit-to-unit" : "unit-to-tower";
        projectileProvenance = projectileIdentity(
          direction,
          attack.attacker.id,
          attack.sequence,
          this.#nextProjectileId,
        );
        projectile = {
          attackSequence: projectileProvenance.attackSequence,
          attackerId: attack.attacker.id,
          damage: attack.attacker.damage,
          direction: projectileProvenance.direction,
          id: this.#nextProjectileId,
          impactTick: homing ? tick + 1 : tick + duration,
          launchTick: tick,
          origin: { ...attack.attacker.position },
          projectileId: projectileProvenance.projectileId,
          projectileIdentity: clone(projectileProvenance),
          projectileScope: projectileProvenance.direction,
          sourceId: attack.attacker.id,
          speed: attack.attacker.projectileSpeed,
          targetId: attack.target.id,
          targetPosition: { ...attack.target.position },
          ...(homing ? { position: { ...attack.attacker.position } } : {}),
        };
        if (attack.attacker.splashProfile !== undefined) {
          projectile.splashProfile = clone(attack.attacker.splashProfile);
        }
        if (attack.structure !== null) {
          projectile.structureKind = attack.structure.kind;
          projectile.structureLayer = attack.structure.layer;
          projectile.structureSide = attack.structure.side;
          projectile.structureId = attack.structure.structureId;
        }
        this.#nextProjectileId += 1;
        this.#projectiles.push(projectile);
        this.#openVisualProjectile(projectile, tick);
      }

      const attackEvent = {
        attackerId: attack.attacker.id,
        sequence: attack.sequence,
        targetId: attack.target.id,
        tick,
        type: "attack",
      };
      boundary.push(projectileProvenance === null
        ? attackEvent
        : withProjectileIdentity(attackEvent, projectileProvenance));
      if (attack.structure !== null) {
        const structureAttack = {
          ...(homing ? {} : { contactTick: tick + duration }),
          attackSequence: attack.sequence,
          damage: attack.attacker.damage,
          delivery: attack.attacker.delivery,
          sourceUnitId: attack.attacker.id,
          structureId: attack.structure.structureId,
          tick,
          type: "external-structure-attack",
        };
        boundary.push(projectileProvenance === null
          ? structureAttack
          : withProjectileIdentity(structureAttack, projectileProvenance));
      }
      if (attack.attacker.delivery === "melee") {
        if (attack.structure === null) {
          const area = planMeleeUnitAttack({
            attacker: attack.attacker,
            attackSequence: attack.sequence,
            areaPolicies: this.#setup.meleeAreaPolicies,
            controls,
            damage: this.#damage,
            primaryTargetId: attack.target.id,
            units: this.#units,
          });
          hits.push(...area.unitHits);
          hitSources.push(...area.hitSources);
        } else {
          boundary.push({
            contactTick: tick,
            attackSequence: attack.sequence,
            damage: attack.attacker.damage,
            delivery: "melee",
            sourceUnitId: attack.attacker.id,
            structureId: attack.structure.structureId,
            tick,
            type: "external-structure-contact",
          });
        }
      } else {
        boundary.push(withProjectileIdentity({
          projectile: clone(projectile),
          tick,
          type: "projectile-launch",
        }, projectileProvenance));
        if (duration === 0 && !homing) dueProjectiles.push(projectile);
      }
    }
    dueProjectiles.sort((left, right) => left.id - right.id);
    const visualRootsToClose = new Map();
    const visualRootsByTarget = new Map();
    for (const projectile of dueProjectiles) {
      const targetStructure = Object.hasOwn(projectile, "structureId")
        ? externalById.get(projectile.targetId) ?? null
        : null;
      const health = Object.hasOwn(projectile, "structureId")
        ? null
        : this.#damage.get(projectile.targetId);
      const splashProfile = projectile.splashProfile;
      const splashAttacker = splashProfile === undefined
        ? null : this.#unit(projectile.attackerId);
      if (splashProfile !== undefined && splashAttacker === null) {
        throw new TypeError("splash projectile source unit is missing");
      }
      const { homing, primaryTargetable, status } = ordinaryProjectileImpactTargetStatus(
        projectile, targetStructure, health,
        controls.get(projectile.targetId)?.targetable ?? true,
      );
      const primaryTarget = targetStructure ?? this.#unit(projectile.targetId);
      const unitTargets = splashProfile === undefined ? [] : this.#units.map((unit) => ({
        alive: !this.#damage.get(unit.id).dead,
        id: unit.id,
        layer: unit.layer,
        position: unit.position,
        radius: unit.radius,
        side: unit.side,
        targetable: controls.get(unit.id)?.targetable ?? true,
      }));
      const impact = planOrdinaryProjectileSplashImpact({
        attackerId: projectile.attackerId,
        attackSequence: projectile.attackSequence,
        center: homing && status !== "contact"
          ? projectile.position : projectile.targetPosition,
        damage: projectile.damage,
        enemySide: splashAttacker === null ? null :
          (splashAttacker.side === "north" ? "south" : "north"),
        primaryKind: targetStructure === null ? "unit" : "structure",
        primaryStatus: status,
        primaryTarget,
        primaryTargetId: projectile.targetId,
        primaryTargetable,
        profile: homing && status !== "contact" ? null : splashProfile ?? null,
        projectileId: projectile.id,
        structures: external.structures,
        tick,
        units: unitTargets,
      });
      for (const contact of impact.visualContacts) {
        const visualRoot = this.#visualRoot(projectile.projectileIdentity);
        if (visualRoot === undefined) continue;
        this.#appendVisualContact(visualRoot, contact.position, contact.id, contact.status, tick);
        visualRootsToClose.set(visualRoot.rootId, {
          reason: contact.status === "contact" ? "complete" : "target-missing",
          root: visualRoot,
        });
      }
      boundary.push(withProjectileIdentity({
        projectileId: projectile.id,
        status: impact.impactStatus,
        targetId: projectile.targetId,
        tick,
        type: "projectile-impact",
      }, projectile.projectileIdentity));
      hits.push(...impact.unitHits);
      hitSources.push(...impact.hitSources.map((source) => ({
        ...source, projectileIdentity: clone(projectile.projectileIdentity),
      })));
      for (const contact of impact.structureContacts) {
        boundary.push(withProjectileIdentity(contact, projectile.projectileIdentity));
      }
    }
    if (dueProjectiles.length > 0) {
      const ids = new Set(dueProjectiles.map(({ id }) => id));
      this.#projectiles = this.#projectiles.filter(({ id }) => !ids.has(id));
    }
    for (const hit of external.externalHits) {
      boundary.push({
        contactTick: tick,
        damage: hit.damage,
        delivery: hit.delivery,
        sourceId: hit.sourceId,
        targetUnitId: hit.targetUnitId,
        tick,
        type: "external-unit-contact",
      });
      hits.push({ amount: hit.damage, targetId: hit.targetUnitId });
      hitSources.push({ delivery: hit.delivery, externalSourceId: hit.sourceId });
    }
    for (const projectile of external.externalProjectiles) {
      const projectileIdentity = projectile.projectileIdentity;
      const targetUnit = this.#unit(projectile.targetUnitId);
      const sourceStructure = external.structures.find(({ structureId }) =>
        structureId === projectileIdentity.sourceId);
      const visualRoot = this.#openExternalVisualProjectile(
        projectile,
        sourceStructure?.position ?? targetUnit?.position ?? { x: 0, y: 0 },
        targetUnit?.position ?? { x: 0, y: 0 },
        tick,
      );
      this.#appendVisualContact(
        visualRoot,
        targetUnit?.position ?? { x: 0, y: 0 },
        projectile.targetUnitId,
        "contact",
        tick,
      );
      visualRootsToClose.set(visualRoot.rootId, {
        reason: "complete",
        root: visualRoot,
      });
      boundary.push(withProjectileIdentity({
        attackSequence: projectile.attackSequence,
        contactTick: tick,
        damage: projectile.damage,
        delivery: "projectile",
        direction: projectile.direction,
        projectileIdentity,
        projectileId: projectile.projectileId,
        sourceId: projectile.sourceId,
        targetUnitId: projectile.targetUnitId,
        tick,
        type: "external-unit-contact",
      }, projectileIdentity));
      hits.push({ amount: projectile.damage, targetId: projectile.targetUnitId });
      hitSources.push({
        attackSequence: projectile.attackSequence,
        delivery: "projectile",
        direction: projectile.direction,
        externalProjectileId: projectile.projectileId,
        externalSourceId: projectile.sourceId,
        projectileIdentity: clone(projectileIdentity),
      });
    }
    const resolved = this.#damage.damageSimultaneously(hits);
    let sourceIndex = 0;
    for (const event of resolved.events) {
      if (event.type === "damage") {
        const source = hitSources[sourceIndex];
        const damage = { ...event, ...source, tick };
        boundary.push(source.projectileIdentity === undefined
          ? damage
          : withProjectileIdentity(damage, source.projectileIdentity));
        if (source.projectileIdentity !== undefined) {
          const visualRoot = this.#visualRoot(source.projectileIdentity);
          if (visualRoot !== undefined) {
            this.#appendVisualDamage(visualRoot, damage);
            visualRootsByTarget.set(event.targetId, visualRoot);
            visualRootsToClose.set(visualRoot.rootId, {
              reason: "complete",
              root: visualRoot,
            });
          }
        }
        sourceIndex += 1;
      } else {
        boundary.push({ ...event, tick });
        const visualRoot = visualRootsByTarget.get(event.targetId);
        if (visualRoot !== undefined) this.#appendVisualDeath(visualRoot, event.targetId, tick);
      }
    }
    for (const { reason, root } of visualRootsToClose.values()) {
      this.#appendVisualClose(root, reason, tick);
    }
    for (const heal of external.unitHeals ?? []) {
      const source = this.#damage.get(heal.sourceId);
      let result;
      if (source === null) {
        result = {
          amount: heal.amount,
          appliedAmount: 0,
          currentHealth: null,
          status: "source-missing",
          targetId: heal.targetUnitId,
        };
      } else if (source.dead) {
        const target = this.#damage.get(heal.targetUnitId);
        result = {
          amount: heal.amount,
          appliedAmount: 0,
          currentHealth: target?.currentHealth ?? null,
          status: "source-dead",
          targetId: heal.targetUnitId,
        };
      } else {
        result = this.#damage.heal(heal.targetUnitId, heal.amount);
      }
      boundary.push({
        amount: heal.amount,
        appliedAmount: result.appliedAmount ?? 0,
        commandId: heal.commandId,
        currentHealth: result.currentHealth,
        sourceId: heal.sourceId,
        status: result.status,
        targetId: heal.targetUnitId,
        tick,
        type: "heal",
      });
    }
    this.#tick += 1;
    this.#events.push(...boundary);
    this.#stateToken = {};
    return boundary;
  }

  #openVisualProjectile(projectile, tick) {
    const visualRoot = appendCombatEffectProjectileRoot(this.#feed, projectile,
      projectile.origin, projectile.targetPosition, tick, projectile.impactTick);
    this.#feedRoots.set(visualRoot.rootId, visualRoot);
    return visualRoot;
  }

  #openExternalVisualProjectile(projectile, origin, target, tick) {
    const visualRoot = appendCombatEffectProjectileRoot(this.#feed, projectile,
      origin, target, tick, tick, projectile.radius ?? 0);
    this.#feedRoots.set(visualRoot.rootId, visualRoot);
    return visualRoot;
  }

  #visualRoot(identity) {
    const rootId = combatEffectRootId({
      type: "projectile",
      direction: identity.direction,
      sourceId: identity.sourceId,
      effectId: null,
      projectileId: identity.projectileId,
      sequence: identity.attackSequence,
    });
    return this.#feedRoots.get(rootId);
  }

  #appendVisualContact(root, point, targetId, status, tick) {
    const statusMap = {
      contact: "contact",
      target_dead: "target-dead",
      target_missing: "target-missing",
    };
    return appendCombatEffectChild(this.#feed, root, "contact", {
      point,
      status: statusMap[status] ?? "observed",
      subId: null,
      targetId,
    }, tick);
  }

  #appendVisualDamage(root, event) {
    return appendCombatEffectChild(this.#feed, root, "damage", {
      amount: event.amount,
      currentHealthAfter: event.currentHealthAfter,
      currentHealthBefore: event.currentHealthBefore,
      targetId: event.targetId,
    }, event.tick);
  }

  #appendVisualDeath(root, targetId, tick) {
    return appendCombatEffectChild(this.#feed, root, "death", { targetId }, tick);
  }

  #appendVisualClose(root, reason, tick) {
    return appendCombatEffectChild(this.#feed, root, "close", { reason }, tick);
  }

  #recordStructureContacts(hits, tick, events) {
    const boundary = this.#history.at(-1);
    if (boundary?.type !== "boundary" || boundary.command.tick !== tick) {
      throw new TypeError("direct structure contact has no admitted combat boundary");
    }
    appendCombatEffectStructureContacts(this.#feed, {
      acceptedHits: boundary.command.externalHits,
      events,
      hits,
      knownStructures: this.#knownExternalStructures,
      tick,
      units: this.#units,
    });
  }

  #activate(spec, tick, sink = this.#events) {
    if (this.#units.length >= MAX_UNITS) throw new RangeError("battle combat unit bound exceeded");
    const canonicalSpec = copyCombatUnitFields(spec, clone);
    const unit = {
      ...canonicalSpec,
      attack: new AttackCycle({
        deployTicks: spec.deployTicks,
        firstHitTicks: spec.firstHitTicks,
        hitSpeedTicks: spec.cadenceTicks,
      }),
      spawnedAt: tick,
      targetId: null,
    };
    this.#damage.add(unit.id, unit.maxHealth);
    const insertion = this.#units.findIndex(({ id }) => id > unit.id);
    if (insertion === -1) this.#units.push(unit);
    else this.#units.splice(insertion, 0, unit);
    const event = { id: unit.id, position: { ...unit.position }, side: unit.side, tick, type: "spawn" };
    sink.push(event);
    if (sink !== this.#events) return event;
    return event;
  }

  #assertNewId(id) {
    if (this.#unit(id) !== null || this.#scheduled.some((entry) => entry.id === id) ||
        this.#knownExternalStructures.some((entry) => entry.id === id)) {
      throw new RangeError(
        `battle combat unit ${id} already exists, is scheduled, or is externally reserved`,
      );
    }
  }

  #unit(id) {
    return this.#units.find((unit) => unit.id === id) ?? null;
  }

  #reserveHistory() {
    if (this.#history.length >= MAX_HISTORY) throw new RangeError("battle combat history bound exceeded");
  }

  #record(operation) {
    this.#history.push(clone(operation));
  }

  #runtimeClone(includeTranscript = true) {
    const candidate = new BattleCombat();
    candidate.#damage = DamageSystem.restore(this.#damage.serialize());
    candidate.#feed = this.#feed.fork();
    candidate.#feedRoots = new Map([...this.#feedRoots].map(([rootId, root]) => [
      rootId,
      { ...root },
    ]));
    candidate.#events = includeTranscript ? clone(this.#events) : [];
    candidate.#history = includeTranscript ? clone(this.#history) : [];
    candidate.#knownExternalStructures = clone(this.#knownExternalStructures);
    candidate.#nextProjectileId = this.#nextProjectileId;
    candidate.#nextScheduleSequence = this.#nextScheduleSequence;
    candidate.#projectiles = clone(this.#projectiles);
    candidate.#scheduled = clone(this.#scheduled);
    candidate.#seenExternalProjectileIds = clone(this.#seenExternalProjectileIds);
    candidate.#setup = clone(this.#setup);
    candidate.#tick = this.#tick;
    candidate.#units = this.#units.map((unit) => ({
      ...copyCombatUnitFields(unit, clone),
      // Each unit owns an authentic private AttackCycle. Forking it preserves
      // an independent continuation without repeatedly serializing, parsing,
      // and re-admitting that trusted internal authority for every session
      // transaction.
      attack: unit.attack.fork(),
      spawnedAt: unit.spawnedAt,
      targetId: unit.targetId,
    }));
    return candidate;
  }

  #adopt(candidate) {
    this.#damage = candidate.#damage;
    this.#feed = candidate.#feed;
    this.#feedRoots = candidate.#feedRoots;
    this.#events = candidate.#events;
    this.#history = candidate.#history;
    this.#knownExternalStructures = candidate.#knownExternalStructures;
    this.#nextProjectileId = candidate.#nextProjectileId;
    this.#nextScheduleSequence = candidate.#nextScheduleSequence;
    this.#projectiles = candidate.#projectiles;
    this.#scheduled = candidate.#scheduled;
    this.#seenExternalProjectileIds = candidate.#seenExternalProjectileIds;
    this.#setup = candidate.#setup;
    this.#tick = candidate.#tick;
    this.#units = candidate.#units;
    this.#stateToken = {};
  }

  #adoptBoundary(candidate) {
    this.#damage = candidate.#damage;
    this.#feed = candidate.#feed;
    this.#feedRoots = candidate.#feedRoots;
    this.#events = [...this.#events, ...candidate.#events];
    this.#history = [...this.#history, ...candidate.#history];
    this.#knownExternalStructures = candidate.#knownExternalStructures;
    this.#nextProjectileId = candidate.#nextProjectileId;
    this.#nextScheduleSequence = candidate.#nextScheduleSequence;
    this.#projectiles = candidate.#projectiles;
    this.#scheduled = candidate.#scheduled;
    this.#seenExternalProjectileIds = candidate.#seenExternalProjectileIds;
    this.#tick = candidate.#tick;
    this.#units = candidate.#units;
    this.#stateToken = {};
  }
}

const DynamicBattleCombat = BattleCombat;
  opaqueContinuation((value) => {
    if (!runtimeInstances.has(value)) {
      throw new TypeError("internal defineBattleCombat continuation receiver is invalid");
    }
    return compact(value);
  }, registerCompact);
  return { BattleCombat, DynamicBattleCombat, MAX_BATTLE_COMBAT_STEP_TICKS, currentTick,
    recordStructureContacts };
}
