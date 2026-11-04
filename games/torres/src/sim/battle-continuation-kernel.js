// Modificado para Alma, 2026-10-31: GameSession admite un controlador externo del lado
// norte (submitNorthCommand + operación "submit-north" en la transcripción) cuando la
// sesión no trae despliegues norte del bot integrado (legalNorthDeployments vacío).
// Original: Moss & Ember, ThatXliner/clash-royale-clone, commit 75d30d1 (AGPL-3.0-only).
import {
  ARENA_LENGTH_MILLITILES,
  ARENA_WIDTH_MILLITILES,
  getArenaGeometry,
  isPointInArena,
  validateArenaPoint,
} from "./arena-geometry.js";
import { AttackCycle, attackSecondsToTicks } from "./attack-cycle.js";
import { defineBattleCombat } from "./battle-combat-runtime.js";
import { assertOpaqueContinuationHandle, opaqueContinuation } from "./opaque-continuation.js";
import { DamageSystem } from "./damage.js";
import { DeckCycle } from "./deck.js";
import { evaluateDeployment } from "./deployment.js";
import { layoutFormation } from "./formations.js";
import { MOVEMENT_TICKS_PER_SECOND } from "./movement.js";
import { findGroundPath, isGroundNavigationNode } from "./pathfinding.js";
import { SeededRandom } from "./rng.js";
import { SessionCardRuntime, isAuthenticSessionCardRuntime } from "./session-card-runtime.js";
import {
  SESSION_BUILDING_MAX_INTENTS,
  SESSION_BUILDING_MAX_STRUCTURES,
  createSessionBuildingRuntime,
  isSessionBuildingCardId,
} from "./session-building-runtime.js";
import { assertSessionBuildingProfileReceipt } from "./session-building-profile-receipts.js";
import {
  SESSION_TROOP_RUNTIME_ACTION_PROFILE_VERSION,
  SESSION_TROOP_RUNTIME_LEGACY_VERSION,
  SESSION_TROOP_RUNTIME_MAX_SOURCES,
  SESSION_TROOP_RUNTIME_MOVEMENT_VERSION,
  SESSION_TROOP_RUNTIME_VERSION,
  parseSessionTroopRuntimeProfiles,
  SessionTroopRuntime,
} from "./session-troop-runtime.js";
import {
  SESSION_TROOP_STATUS_RUNTIME_MAX_COMMANDS,
  SESSION_TROOP_STATUS_RUNTIME_MAX_SOURCES,
  assertSessionTroopStatusSourceRoster,
  parseSessionTroopStatusRuntimeProfiles,
  SessionTroopStatusRuntime,
} from "./session-troop-status-runtime.js";
import {
  SessionTroopProjectileRuntime,
} from "./session-troop-projectile-runtime.js";
import {
  admitStormkiteChainQuestionPolicy,
  LiveBattleChainContinuation,
} from "./live-battle-chain.js";
import {
  assertOrdinaryProjectileDeliveryPolicy,
} from "../shared/ordinary-projectile-delivery-authority.js";
import {
  assertSessionTroopSourceConfidenceQuestions,
  sessionTroopSourceQuestionMinimum,
} from "../shared/session-troop-source-confidence-authority.js";
import {
  createSpellIntentRuntime,
  getUnprofiledAdmittedEffectProfileQuestion,
  parseSpellIntentProfileReceipts,
} from "./spell-intent-runtime.js";
import { MAX_SPATIAL_MILLITILES, circlesOverlap, validateCircle, validatePosition } from "./spatial.js";
import { retainOrAcquireTarget, targetCandidate } from "./targeting.js";
import { createStageSideDeployment } from "./game-side-deploy-core.js";
import {
  appendCombatEffectChild,
  appendCombatEffectEvent,
  appendCombatEffectProjectileRoot,
  appendCombatEffectStructureContacts,
  combatEffectRootId,
  combatEffectFeedSnapshot,
  createCombatEffectFeed,
  serializeCombatEffectFeed,
} from "./combat-effect-feed.js";
import {
  mapBattleTowerIdToMatchTowerId,
  mapLiveBattleTowerStateToMatchEvidence,
} from "./tower-evidence-map.js";
import { appendSpellAreaImpact, checkedAreaImpact } from "./spell-area-impact.js";
import {
  checkedCombatSpawn as checkedSpawn,
  checkedCombatUnit as checkedUnit,
  copyCombatUnitFields,
  ordinaryProjectileSplashCombatFields,
  ordinaryProjectileSplashEntityFields,
  ordinaryProjectileSplashEntityShape,
  planOrdinaryProjectileSplashImpact,
} from "./ordinary-projectile-splash.js";
import {
  canonicalMeleeAreaSetup,
  canonicalMeleeTowerSetup,
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

const SPELL_TOWER_FOOTPRINT_RADII = Object.freeze({ central: 2_829, lane: 2_122 });

function preflightMovementSnapshotGraph(root, limits, label) {
  const pending = [{ depth: 0, value: root }];
  let nodes = 0;
  let containers = 0;
  while (pending.length > 0) {
    const { depth, value } = pending.pop();
    nodes += 1;
    if (nodes > limits.nodes) throw new RangeError(`${label} node bound exceeded`);
    if (depth > limits.depth) throw new RangeError(`${label} depth bound exceeded`);
    if (typeof value === "string") {
      if (value.length > limits.stringLength) {
        throw new RangeError(`${label} string length bound exceeded`);
      }
      continue;
    }
    if (typeof value === "number") {
      if (!Number.isSafeInteger(value)) {
        throw new TypeError(`${label} numbers must be safe integers`);
      }
      continue;
    }
    if (value === null || typeof value !== "object") continue;
    containers += 1;
    if (containers > limits.containers) {
      throw new RangeError(`${label} container bound exceeded`);
    }
    if (Array.isArray(value)) {
      if (value.length > limits.arrayLength) {
        throw new RangeError(`${label} array length bound exceeded`);
      }
      for (let index = 0; index < value.length; index += 1) {
        pending.push({ depth: depth + 1, value: value[index] });
      }
    } else {
      const keys = Object.keys(value);
      if (keys.length > limits.keys) {
        throw new RangeError(`${label} object key bound exceeded`);
      }
      for (const key of keys) {
        if (key.length > limits.stringLength) {
          throw new RangeError(`${label} key string length bound exceeded`);
        }
        pending.push({ depth: depth + 1, value: value[key] });
      }
    }
  }
}

function defineBattleMovement(registerCompact) {
  let compact;
  const runtimeInstances = new WeakSet();

const BATTLE_MOVEMENT_MODES = Object.freeze({
  air: "air",
  ground: "ground",
});

const MAX_BATTLE_MOVEMENT_STEP_TICKS = 18_000;
const MAX_SNAPSHOT_BYTES = 262_144;
const MAX_ROUTE_POINTS = 1_024;
const MAX_COMMANDS = 1_024;
const MAX_TICK = 18_000;
const MAX_SPEED = 1_000_000;
const SNAPSHOT_GRAPH_LIMITS = Object.freeze({
  arrayLength: MAX_COMMANDS + MAX_ROUTE_POINTS + 64,
  containers: 8_192,
  depth: 64,
  keys: 64,
  nodes: 65_536,
  stringLength: MAX_SNAPSHOT_BYTES,
});
const STATE_KEYS = [
  "anchor",
  "bodyRadius",
  "commands",
  "edgeStart",
  "initialPosition",
  "mode",
  "position",
  "remainder",
  "route",
  "routeIndex",
  "routeOrigin",
  "segmentLength",
  "segmentProgress",
  "segmentStart",
  "speed",
  "target",
  "tick",
];
const TARGET_KEYS = ["position", "radius", "range"];
const STOP_COMMAND_KEYS = ["kind", "tick"];
const TARGET_COMMAND_KEYS = ["kind", "target", "tick"];

function assertPlainObject(value, label) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null) ||
    Object.getOwnPropertySymbols(value).length !== 0
  ) {
    throw new TypeError(`${label} must be a plain string-keyed data object`);
  }
  for (const [key, descriptor] of Object.entries(
    Object.getOwnPropertyDescriptors(value),
  )) {
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
      throw new TypeError(`${label}.${key} must be an enumerable data property`);
    }
  }
}

function assertExactKeys(value, keys, label) {
  assertPlainObject(value, label);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new TypeError(`${label} has an invalid shape`);
  }
}

function integer(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(
      `${label} must be a safe integer from ${minimum} through ${maximum}`,
    );
  }
  return value;
}

function point(value, label) {
  const checked = validateArenaPoint(value, label);
  if (!isPointInArena(checked)) {
    throw new RangeError(`${label} must be inside the arena`);
  }
  return { x: checked.x, y: checked.y };
}

function assertBodyFits(position, radius, label) {
  if (
    position.x < radius ||
    position.x > ARENA_WIDTH_MILLITILES - radius ||
    position.y < radius ||
    position.y > ARENA_LENGTH_MILLITILES - radius
  ) {
    throw new RangeError(`${label} must fit inside the radius-inset arena`);
  }
}

function target(value, label = "battle movement target") {
  if (value === null) return null;
  assertExactKeys(value, TARGET_KEYS, label);
  return {
    position: point(value.position, `${label}.position`),
    radius: integer(value.radius, 0, ARENA_WIDTH_MILLITILES, `${label}.radius`),
    range: integer(value.range, 0, ARENA_LENGTH_MILLITILES, `${label}.range`),
  };
}

function clonePoint(value) {
  return { x: value.x, y: value.y };
}

function samePoint(left, right) {
  return left.x === right.x && left.y === right.y;
}

function pointsEqual(left, right) {
  return left.length === right.length && left.every((entry, index) =>
    samePoint(entry, right[index]));
}

function isPointOnAxisSegment(candidate, from, to) {
  if (samePoint(from, to)) return samePoint(candidate, from);
  if (from.x === to.x && candidate.x === from.x) {
    return candidate.y >= Math.min(from.y, to.y) &&
      candidate.y <= Math.max(from.y, to.y);
  }
  if (from.y === to.y && candidate.y === from.y) {
    return candidate.x >= Math.min(from.x, to.x) &&
      candidate.x <= Math.max(from.x, to.x);
  }
  return false;
}

function cloneTarget(value) {
  return value === null
    ? null
    : {
        position: clonePoint(value.position),
        radius: value.radius,
        range: value.range,
      };
}

function frozenTarget(value) {
  const copy = cloneTarget(value);
  return Object.freeze({
    position: Object.freeze(copy.position),
    radius: copy.radius,
    range: copy.range,
  });
}

function cloneCommand(value) {
  return value.kind === "stop"
    ? { kind: "stop", tick: value.tick }
    : { kind: "target", target: cloneTarget(value.target), tick: value.tick };
}

function frozenCommand(value) {
  const copy = cloneCommand(value);
  if (copy.kind === "target") copy.target = frozenTarget(copy.target);
  return Object.freeze(copy);
}

function validateCommands(value, snapshotTick, label) {
  if (!Array.isArray(value) || value.length > MAX_COMMANDS) {
    throw new TypeError(`${label} must be a bounded command array`);
  }
  let priorTick = 0;
  return value.map((entry, index) => {
    const commandLabel = `${label}[${index}]`;
    assertPlainObject(entry, commandLabel);
    if (entry.kind === "stop") {
      assertExactKeys(entry, STOP_COMMAND_KEYS, commandLabel);
      const tick = integer(entry.tick, priorTick, snapshotTick, `${commandLabel}.tick`);
      priorTick = tick;
      return { kind: "stop", tick };
    }
    if (entry.kind === "target") {
      assertExactKeys(entry, TARGET_COMMAND_KEYS, commandLabel);
      const tick = integer(entry.tick, priorTick, snapshotTick, `${commandLabel}.tick`);
      priorTick = tick;
      return {
        kind: "target",
        target: target(entry.target, `${commandLabel}.target`),
        tick,
      };
    }
    throw new TypeError(`${commandLabel}.kind must be target or stop`);
  });
}

function squaredDistance(left, right) {
  const dx = BigInt(left.x) - BigInt(right.x);
  const dy = BigInt(left.y) - BigInt(right.y);
  return dx * dx + dy * dy;
}

function isInBar(position, bodyRadius, destination) {
  const bar = BigInt(bodyRadius + destination.radius + destination.range);
  return squaredDistance(position, destination.position) <= bar * bar;
}

function integerSquareRoot(value) {
  if (value < 0n) throw new RangeError("square root input must be non-negative");
  if (value < 2n) return value;
  let low = 1n;
  let high = value;
  while (low <= high) {
    const middle = (low + high) >> 1n;
    const square = middle * middle;
    if (square === value) return middle;
    if (square < value) low = middle + 1n;
    else high = middle - 1n;
  }
  return high;
}

function segmentLength(from, to) {
  const square = squaredDistance(from, to);
  const floor = integerSquareRoot(square);
  return Number(floor * floor === square ? floor : floor + 1n);
}

function interpolate(from, to, progress, length) {
  if (progress === length) return clonePoint(to);
  const result = {};
  for (const axis of ["x", "y"]) {
    const delta = BigInt(to[axis]) - BigInt(from[axis]);
    const magnitude = delta < 0n ? -delta : delta;
    const offset = (magnitude * BigInt(progress)) / BigInt(length);
    result[axis] = from[axis] + (delta < 0n ? -Number(offset) : Number(offset));
  }
  return result;
}

function firstProgressInBar(from, to, length, bodyRadius, destination) {
  if (isInBar(from, bodyRadius, destination)) return 0;
  if (!isInBar(to, bodyRadius, destination)) return length;
  let low = 1;
  let high = length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (isInBar(interpolate(from, to, middle, length), bodyRadius, destination)) {
      high = middle;
    } else {
      low = middle + 1;
    }
  }
  return low;
}

function event(kind, tick, position, extra = {}) {
  return Object.freeze({
    kind,
    position: Object.freeze(clonePoint(position)),
    tick,
    ...extra,
  });
}

function frozenEvents(events) {
  return Object.freeze(events);
}

function deepFrozenState(state) {
  const copy = {
    anchor: state.anchor === null ? null : Object.freeze(clonePoint(state.anchor)),
    bodyRadius: state.bodyRadius,
    commands: Object.freeze(state.commands.map(frozenCommand)),
    edgeStart: state.edgeStart === null
      ? null
      : Object.freeze(clonePoint(state.edgeStart)),
    initialPosition: Object.freeze(clonePoint(state.initialPosition)),
    mode: state.mode,
    position: Object.freeze(clonePoint(state.position)),
    remainder: state.remainder,
    route: Object.freeze(state.route.map((entry) => Object.freeze(clonePoint(entry)))),
    routeIndex: state.routeIndex,
    routeOrigin: state.routeOrigin === null
      ? null
      : Object.freeze(clonePoint(state.routeOrigin)),
    segmentLength: state.segmentLength,
    segmentProgress: state.segmentProgress,
    segmentStart: Object.freeze(clonePoint(state.segmentStart)),
    speed: state.speed,
    target: state.target === null
      ? null
      : Object.freeze({
          position: Object.freeze(clonePoint(state.target.position)),
          radius: state.target.radius,
          range: state.target.range,
        }),
    tick: state.tick,
  };
  return Object.freeze(copy);
}

function canonicalState(state) {
  return {
    anchor: state.anchor === null ? null : clonePoint(state.anchor),
    bodyRadius: state.bodyRadius,
    commands: state.commands.map(cloneCommand),
    edgeStart: state.edgeStart === null ? null : clonePoint(state.edgeStart),
    initialPosition: clonePoint(state.initialPosition),
    mode: state.mode,
    position: clonePoint(state.position),
    remainder: state.remainder,
    route: state.route.map(clonePoint),
    routeIndex: state.routeIndex,
    routeOrigin: state.routeOrigin === null ? null : clonePoint(state.routeOrigin),
    segmentLength: state.segmentLength,
    segmentProgress: state.segmentProgress,
    segmentStart: clonePoint(state.segmentStart),
    speed: state.speed,
    target: cloneTarget(state.target),
    tick: state.tick,
  };
}

function validateState(value, label = "battle movement state") {
  assertExactKeys(value, STATE_KEYS, label);
  if (!Object.values(BATTLE_MOVEMENT_MODES).includes(value.mode)) {
    throw new TypeError(`${label}.mode must be ground or air`);
  }
  const bodyRadius = integer(
    value.bodyRadius,
    0,
    Math.floor(ARENA_WIDTH_MILLITILES / 2),
    `${label}.bodyRadius`,
  );
  const position = point(value.position, `${label}.position`);
  assertBodyFits(position, bodyRadius, `${label}.position`);
  const initialPosition = point(value.initialPosition, `${label}.initialPosition`);
  assertBodyFits(initialPosition, bodyRadius, `${label}.initialPosition`);
  if (value.mode === BATTLE_MOVEMENT_MODES.ground &&
      !isGroundNavigationNode(initialPosition)) {
    throw new RangeError(`${label}.initialPosition must be a ground navigation node`);
  }
  const speed = integer(value.speed, 0, MAX_SPEED, `${label}.speed`);
  const remainder = integer(
    value.remainder,
    0,
    MOVEMENT_TICKS_PER_SECOND - 1,
    `${label}.remainder`,
  );
  const tick = integer(value.tick, 0, MAX_TICK, `${label}.tick`);
  const commands = validateCommands(value.commands, tick, `${label}.commands`);
  const destination = target(value.target, `${label}.target`);
  const anchor = value.anchor === null
    ? null
    : point(value.anchor, `${label}.anchor`);
  if (value.mode === BATTLE_MOVEMENT_MODES.air && anchor !== null) {
    throw new RangeError(`${label}.anchor must be null for air movement`);
  }
  if (value.mode === BATTLE_MOVEMENT_MODES.ground &&
      (anchor === null || !isGroundNavigationNode(anchor))) {
    throw new RangeError(`${label}.anchor must be a ground navigation node`);
  }
  const edgeStart = value.edgeStart === null
    ? null
    : point(value.edgeStart, `${label}.edgeStart`);
  if (value.mode === BATTLE_MOVEMENT_MODES.air && edgeStart !== null) {
    throw new RangeError(`${label}.edgeStart must be null for air movement`);
  }
  if (value.mode === BATTLE_MOVEMENT_MODES.ground &&
      (edgeStart === null || !isGroundNavigationNode(edgeStart))) {
    throw new RangeError(`${label}.edgeStart must be a ground navigation node`);
  }
  if (anchor !== null) assertBodyFits(anchor, bodyRadius, `${label}.anchor`);
  if (edgeStart !== null) {
    assertBodyFits(edgeStart, bodyRadius, `${label}.edgeStart`);
    if (!samePoint(edgeStart, anchor)) {
      const edge = findGroundPath(edgeStart, anchor);
      if (edge === null || edge.length !== 2 ||
          !samePoint(edge[0], edgeStart) || !samePoint(edge[1], anchor)) {
        throw new RangeError(`${label} has a noncanonical active ground edge`);
      }
    }
  }
  const routeOrigin = value.routeOrigin === null
    ? null
    : point(value.routeOrigin, `${label}.routeOrigin`);
  const routeIndex = integer(
    value.routeIndex,
    0,
    MAX_ROUTE_POINTS,
    `${label}.routeIndex`,
  );
  if (value.mode === BATTLE_MOVEMENT_MODES.air &&
      (routeOrigin !== null || routeIndex !== 0)) {
    throw new RangeError(`${label} cannot use ground route provenance in air mode`);
  }
  if (value.mode === BATTLE_MOVEMENT_MODES.ground &&
      (routeOrigin === null || !isGroundNavigationNode(routeOrigin))) {
    throw new RangeError(`${label}.routeOrigin must be a ground navigation node`);
  }
  if (routeOrigin !== null) {
    assertBodyFits(routeOrigin, bodyRadius, `${label}.routeOrigin`);
  }
  if (!Array.isArray(value.route) || value.route.length > MAX_ROUTE_POINTS) {
    throw new TypeError(`${label}.route must be a bounded array`);
  }
  const route = value.route.map((entry, index) => {
    const checked = point(entry, `${label}.route[${index}]`);
    assertBodyFits(checked, bodyRadius, `${label}.route[${index}]`);
    if (value.mode === BATTLE_MOVEMENT_MODES.ground &&
        !isGroundNavigationNode(checked)) {
      throw new RangeError(`${label}.route[${index}] must be a ground navigation node`);
    }
    return checked;
  });
  const segmentStart = point(value.segmentStart, `${label}.segmentStart`);
  assertBodyFits(segmentStart, bodyRadius, `${label}.segmentStart`);
  if (value.mode === BATTLE_MOVEMENT_MODES.ground &&
      (!isPointOnAxisSegment(segmentStart, edgeStart, anchor) ||
       !isPointOnAxisSegment(position, edgeStart, anchor))) {
    throw new RangeError(`${label} is not on its canonical active ground edge`);
  }
  const checkedLength = integer(
    value.segmentLength,
    0,
    ARENA_WIDTH_MILLITILES + ARENA_LENGTH_MILLITILES,
    `${label}.segmentLength`,
  );
  const checkedProgress = integer(
    value.segmentProgress,
    0,
    checkedLength,
    `${label}.segmentProgress`,
  );
  if (route.length === 0) {
    if (checkedLength !== 0 || checkedProgress !== 0 || remainder !== 0 ||
        segmentStart.x !== position.x || segmentStart.y !== position.y) {
      throw new RangeError(`${label} has inconsistent idle segment state`);
    }
    if (value.mode === BATTLE_MOVEMENT_MODES.ground && destination !== null &&
        speed > 0 && !isInBar(position, bodyRadius, destination)) {
      throw new RangeError(`${label} stopped outside its target bar`);
    }
    if (value.mode === BATTLE_MOVEMENT_MODES.ground && destination === null &&
        (routeIndex !== 0 || !samePoint(routeOrigin, anchor))) {
      throw new RangeError(`${label} has noncanonical stopped route provenance`);
    }
  } else {
    const expectedLength = segmentLength(segmentStart, route[0]);
    if (expectedLength === 0 || checkedLength !== expectedLength ||
        checkedProgress >= checkedLength) {
      throw new RangeError(`${label} has inconsistent active segment state`);
    }
    const expectedPosition = interpolate(
      segmentStart,
      route[0],
      checkedProgress,
      checkedLength,
    );
    if (expectedPosition.x !== position.x || expectedPosition.y !== position.y) {
      throw new RangeError(`${label}.position does not match segment progress`);
    }
    if (destination === null || speed === 0) {
      throw new RangeError(`${label} cannot route without a moving command`);
    }
    if (value.mode === BATTLE_MOVEMENT_MODES.ground) {
      if (anchor.x !== route[0].x || anchor.y !== route[0].y) {
        throw new RangeError(`${label}.anchor must be the next ground waypoint`);
      }
      const canonical = findGroundPath(routeOrigin, destination.position);
      const expected = canonical?.slice(routeIndex);
      if (canonical === null || !pointsEqual(route, expected)) {
        throw new RangeError(
          `${label}.route must exactly match the canonical ground path`,
        );
      }
    } else if (route.length !== 1 ||
        route[0].x !== destination.position.x ||
        route[0].y !== destination.position.y) {
      throw new RangeError(`${label}.route must be the direct air segment`);
    }
  }
  if ((destination === null || speed === 0) && remainder !== 0) {
    throw new RangeError(`${label}.remainder must be zero while stopped`);
  }
  return {
    anchor,
    bodyRadius,
    commands,
    edgeStart,
    initialPosition,
    mode: value.mode,
    position,
    remainder,
    route,
    routeIndex,
    routeOrigin,
    segmentLength: checkedLength,
    segmentProgress: checkedProgress,
    segmentStart,
    speed,
    target: destination,
    tick,
  };
}

function initialState({ bodyRadius = 0, mode, position, speed = 0 }) {
  if (!Object.values(BATTLE_MOVEMENT_MODES).includes(mode)) {
    throw new TypeError("battle movement mode must be ground or air");
  }
  const checkedPosition = point(position, "battle movement position");
  const checkedRadius = integer(
    bodyRadius,
    0,
    Math.floor(ARENA_WIDTH_MILLITILES / 2),
    "battle movement bodyRadius",
  );
  assertBodyFits(checkedPosition, checkedRadius, "battle movement position");
  if (mode === BATTLE_MOVEMENT_MODES.ground &&
      !isGroundNavigationNode(checkedPosition)) {
    throw new RangeError("ground battle movement position must be a navigation node");
  }
  const checkedSpeed = integer(speed, 0, MAX_SPEED, "battle movement speed");
  return {
    anchor: mode === BATTLE_MOVEMENT_MODES.ground
      ? clonePoint(checkedPosition)
      : null,
    bodyRadius: checkedRadius,
    commands: [],
    edgeStart: mode === BATTLE_MOVEMENT_MODES.ground
      ? clonePoint(checkedPosition)
      : null,
    initialPosition: clonePoint(checkedPosition),
    mode,
    position: checkedPosition,
    remainder: 0,
    route: [],
    routeIndex: 0,
    routeOrigin: mode === BATTLE_MOVEMENT_MODES.ground
      ? clonePoint(checkedPosition)
      : null,
    segmentLength: 0,
    segmentProgress: 0,
    segmentStart: clonePoint(checkedPosition),
    speed: checkedSpeed,
    target: null,
    tick: 0,
  };
}

function idleAt(state, position = state.position) {
  state.position = clonePoint(position);
  state.remainder = 0;
  state.route = [];
  state.segmentLength = 0;
  state.segmentProgress = 0;
  state.segmentStart = clonePoint(position);
}

function startSegment(state) {
  state.segmentStart = clonePoint(state.position);
  state.segmentProgress = 0;
  state.segmentLength = state.route.length === 0
    ? 0
    : segmentLength(state.segmentStart, state.route[0]);
}

function routingAnchor(state) {
  if (state.mode !== BATTLE_MOVEMENT_MODES.ground) return null;
  if (isGroundNavigationNode(state.position)) return clonePoint(state.position);
  return clonePoint(state.anchor);
}

function applyTargetState(state, checked) {
  let route;
  let nextAnchor = state.anchor;
  let nextEdgeStart = state.edgeStart;
  let nextRouteIndex = state.routeIndex;
  let nextRouteOrigin = state.routeOrigin;
  if (isInBar(state.position, state.bodyRadius, checked) || state.speed === 0) {
    route = [];
  } else if (state.mode === BATTLE_MOVEMENT_MODES.air) {
    assertBodyFits(checked.position, state.bodyRadius, "air movement target");
    route = [clonePoint(checked.position)];
  } else {
    const anchor = routingAnchor(state);
    const suffix = findGroundPath(anchor, checked.position);
    if (suffix === null) {
      throw new RangeError("ground battle movement target has no route");
    }
    route = [];
    nextRouteOrigin = clonePoint(anchor);
    if (state.position.x !== anchor.x || state.position.y !== anchor.y) {
      route.push(anchor);
      nextAnchor = clonePoint(anchor);
      nextRouteIndex = 0;
    }
    route.push(...suffix.slice(1).map(clonePoint));
    if (samePoint(state.position, anchor) && route.length > 0) {
      nextEdgeStart = clonePoint(state.position);
      nextAnchor = clonePoint(route[0]);
      nextRouteIndex = 1;
    }
    for (let index = 0; index < route.length; index += 1) {
      assertBodyFits(
        route[index],
        state.bodyRadius,
        `ground movement route[${index}]`,
      );
    }
  }

  state.target = cloneTarget(checked);
  state.remainder = 0;
  state.route = route;
  if (state.mode === BATTLE_MOVEMENT_MODES.ground && route.length > 0) {
    state.anchor = nextAnchor;
    state.edgeStart = nextEdgeStart;
    state.routeIndex = nextRouteIndex;
    state.routeOrigin = nextRouteOrigin;
  }
  if (route.length === 0) idleAt(state);
  else startSegment(state);
}

function applyStopState(state) {
  if (state.mode === BATTLE_MOVEMENT_MODES.ground) {
    const anchor = routingAnchor(state);
    if (samePoint(state.position, anchor)) {
      state.edgeStart = clonePoint(anchor);
    }
    state.anchor = clonePoint(anchor);
    state.routeOrigin = clonePoint(anchor);
    state.routeIndex = 0;
  }
  state.target = null;
  idleAt(state);
}

function authoritativeState(state) {
  const copy = canonicalState(state);
  copy.commands = [];
  return copy;
}

function sameAuthoritativeState(left, right) {
  return JSON.stringify(authoritativeState(left)) ===
    JSON.stringify(authoritativeState(right));
}

function authoritativeSignature(state) {
  return JSON.stringify(authoritativeState(state));
}

function applyCommandState(state, command) {
  if (command.kind === "target") applyTargetState(state, command.target);
  else applyStopState(state);
}

function replayCommandState(configuration, commands, snapshotTick) {
  const state = initialState(configuration);
  for (const command of commands) {
    advanceStateOnly(state, command.tick - state.tick);
    applyCommandState(state, command);
  }
  advanceStateOnly(state, snapshotTick - state.tick);
  return state;
}

const EXACT_CANONICAL_HISTORY_COMMANDS = 24;
const PAIR_CANONICAL_HISTORY_COMMANDS = 64;
const EXACT_CANONICAL_WINDOW_COMMANDS = 16;
const EXACT_CANONICAL_WINDOW_OVERLAP = 8;
const EXACT_CANONICAL_WINDOW_HISTORY_LIMIT = 128;

function commandLexicalKey(command) {
  return JSON.stringify(command);
}

function compareCommandSequences(left, right) {
  if (left.length !== right.length) return left.length - right.length;
  for (let index = 0; index < left.length; index += 1) {
    const leftKey = commandLexicalKey(left[index]);
    const rightKey = commandLexicalKey(right[index]);
    if (leftKey < rightKey) return -1;
    if (leftKey > rightKey) return 1;
  }
  return 0;
}

function rememberCanonicalState(states, state, sequence) {
  const key = authoritativeSignature(state);
  const prior = states.get(key);
  if (prior === undefined || compareCommandSequences(sequence, prior.sequence) < 0) {
    states.set(key, { sequence, state });
  }
}

/*
 * Find the shortest subsequence that reaches the expected authority. The
 * frontier contains one shortest, lexicographically smallest sequence for
 * every exact authoritative state at the current command boundary. Omitting
 * or retaining the next command are the only transitions, so induction over
 * the input proves that no strict subsequence is skipped. State signatures
 * include every continuation field except the history itself, including all
 * ground route provenance and the air segment/remainder.
 *
 * This exact frontier is intentionally used for small hostile histories. It
 * also handles joint redundancy: a pair that is not removable separately is
 * still represented by the branch that omits both commands.
 */
function shortestCanonicalCommandSubsequence(
  initial,
  commands,
  snapshotTick,
  expected,
) {
  let frontier = new Map();
  const start = canonicalState(initial);
  start.commands = [];
  rememberCanonicalState(frontier, start, []);

  for (const command of commands) {
    const next = new Map();
    for (const { state, sequence } of frontier.values()) {
      const advanced = canonicalState(state);
      advanced.commands = [];
      advanceStateOnly(advanced, command.tick - advanced.tick);
      rememberCanonicalState(next, advanced, sequence);

      const included = canonicalState(advanced);
      included.commands = [];
      try {
        applyCommandState(included, command);
      } catch {
        continue;
      }
      rememberCanonicalState(
        next,
        included,
        [...sequence, cloneCommand(command)],
      );
    }
    frontier = next;
  }

  const expectedKey = authoritativeSignature(expected);
  let best = null;
  for (const { state, sequence } of frontier.values()) {
    advanceStateOnly(state, snapshotTick - state.tick);
    if (authoritativeSignature(state) !== expectedKey) continue;
    if (best === null || compareCommandSequences(sequence, best) < 0) {
      best = sequence;
    }
  }
  if (best === null) {
    throw new RangeError("battle movement command history has no canonical subsequence");
  }
  return best;
}

function shortestCanonicalCommandHistory(configuration, commands, snapshotTick, expected) {
  return shortestCanonicalCommandSubsequence(
    initialState(configuration),
    commands,
    snapshotTick,
    expected,
  );
}

function prefixStates(configuration, commands) {
  const state = initialState(configuration);
  const prefixes = [];
  for (const command of commands) {
    advanceStateOnly(state, command.tick - state.tick);
    const prefix = canonicalState(state);
    prefix.commands = [];
    prefixes.push(prefix);
    applyCommandState(state, command);
    state.commands = [];
  }
  return prefixes;
}

function replayFromPrefix(prefix, commands, startIndex, snapshotTick) {
  const state = canonicalState(prefix);
  state.commands = [];
  for (let index = startIndex; index < commands.length; index += 1) {
    const command = commands[index];
    advanceStateOnly(state, command.tick - state.tick);
    applyCommandState(state, command);
  }
  advanceStateOnly(state, snapshotTick - state.tick);
  return state;
}

function replayFromPrefixSkipping(
  prefix,
  commands,
  startIndex,
  skippedIndex,
  snapshotTick,
) {
  const state = canonicalState(prefix);
  state.commands = [];
  for (let index = startIndex; index < commands.length; index += 1) {
    if (index === skippedIndex) continue;
    const command = commands[index];
    advanceStateOnly(state, command.tick - state.tick);
    applyCommandState(state, command);
  }
  advanceStateOnly(state, snapshotTick - state.tick);
  return state;
}

function omissionMatchesExpected(commands, snapshotTick, expectedKey, prefixes, index) {
  try {
    const state = replayFromPrefixSkipping(
      prefixes[index],
      commands,
      index + 1,
      -1,
      snapshotTick,
    );
    return authoritativeSignature(state) === expectedKey;
  } catch {
    return false;
  }
}

function pairMatchesExpected(commands, snapshotTick, expectedKey, prefixes, first, second) {
  try {
    const state = replayFromPrefixSkipping(
      prefixes[first],
      commands,
      first + 1,
      second,
      snapshotTick,
    );
    return authoritativeSignature(state) === expectedKey;
  } catch {
    return false;
  }
}

/*
 * For larger histories the exact frontier can have exponentially many
 * distinct states. The bounded public format still admits a deterministic
 * fixed-point reduction: scan omissions in source order, remove the first
 * command whose complete authoritative continuation is unchanged, rebuild
 * prefix checkpoints, and repeat. For histories small enough to expose
 * attacker-chosen joint redundancy, the exact frontier above is used; for
 * the larger bounded path, adjacent reductions are supplemented by an
 * exhaustive pair pass when the quadratic candidate set remains bounded.
 * Every accepted history is compared against the resulting fixed point.
 */
function globalOmissionPass(configuration, kept, snapshotTick, expected) {
  const expectedKey = authoritativeSignature(expected);
  const prefixes = prefixStates(configuration, kept);
  for (let index = 0; index < kept.length; index += 1) {
    if (!omissionMatchesExpected(
      kept,
      snapshotTick,
      expectedKey,
      prefixes,
      index,
    )) continue;
    kept.splice(index, 1);
    return true;
  }

  if (kept.length > PAIR_CANONICAL_HISTORY_COMMANDS) return false;
  for (let first = 0; first < kept.length; first += 1) {
    for (let second = first + 1; second < kept.length; second += 1) {
      if (!pairMatchesExpected(
        kept,
        snapshotTick,
        expectedKey,
        prefixes,
        first,
        second,
      )) continue;
      kept.splice(second, 1);
      kept.splice(first, 1);
      return true;
    }
  }
  return false;
}

function fixedPointCanonicalCommandHistory(configuration, commands, snapshotTick, expected) {
  const kept = commands.map(cloneCommand);
  while (kept.length > EXACT_CANONICAL_HISTORY_COMMANDS) {
    if (exactWindowPass(configuration, kept, snapshotTick, expected)) continue;
    if (globalOmissionPass(configuration, kept, snapshotTick, expected)) continue;
    break;
  }
  if (kept.length <= EXACT_CANONICAL_HISTORY_COMMANDS) {
    // Crossing the exact frontier is an immediate handoff. The returned
    // sequence is fed back through the outer byte-fixed-point loop below.
    return shortestCanonicalCommandHistory(
      configuration,
      kept,
      snapshotTick,
      expected,
    );
  }
  return kept;
}

function exactWindowReplacement(
  configuration,
  commands,
  start,
  end,
  boundaryTick,
  boundaryState,
  prefixes,
) {
  return shortestCanonicalCommandSubsequence(
    prefixes[start],
    commands.slice(start, end),
    boundaryTick,
    boundaryState,
  );
}

function exactWindowPass(configuration, kept, snapshotTick, expected) {
  if (kept.length <= EXACT_CANONICAL_HISTORY_COMMANDS ||
      kept.length > EXACT_CANONICAL_WINDOW_HISTORY_LIMIT) return false;

  const prefixes = prefixStates(configuration, kept);
  const starts = [];
  const stride = EXACT_CANONICAL_WINDOW_COMMANDS - EXACT_CANONICAL_WINDOW_OVERLAP;
  for (let start = 0;
       start + EXACT_CANONICAL_WINDOW_COMMANDS < kept.length;
       start += stride) {
    starts.push(start);
  }
  const finalStart = Math.max(0, kept.length - EXACT_CANONICAL_WINDOW_COMMANDS);
  if (!starts.includes(finalStart)) starts.push(finalStart);

  for (const start of starts) {
    const end = Math.min(start + EXACT_CANONICAL_WINDOW_COMMANDS, kept.length);
    if (end - start < 2) continue;
    const boundaryTick = end < kept.length ? kept[end].tick : snapshotTick;
    const boundaryState = end < kept.length ? prefixes[end] : expected;
    const replacement = exactWindowReplacement(
      configuration,
      kept,
      start,
      end,
      boundaryTick,
      boundaryState,
      prefixes,
    );
    const current = kept.slice(start, end);
    if (JSON.stringify(replacement) === JSON.stringify(current)) continue;
    kept.splice(start, end - start, ...replacement);
    return true;
  }
  return false;
}

function canonicalCommandHistory(configuration, commands, snapshotTick, expected) {
  let kept = commands.map(cloneCommand);
  while (true) {
    const before = JSON.stringify(kept);
    kept = kept.length <= EXACT_CANONICAL_HISTORY_COMMANDS
      ? shortestCanonicalCommandHistory(configuration, kept, snapshotTick, expected)
      : fixedPointCanonicalCommandHistory(configuration, kept, snapshotTick, expected);
    if (JSON.stringify(kept) === before) return kept;
  }
}

function movementDistanceToArrival(state) {
  let distance = 0;
  let from = clonePoint(state.segmentStart);
  let progress = state.segmentProgress;
  let length = state.segmentLength;
  for (let index = 0; index < state.route.length; index += 1) {
    const finalSegment = index === state.route.length - 1;
    const limit = finalSegment
      ? firstProgressInBar(
          from,
          state.route[index],
          length,
          state.bodyRadius,
          state.target,
        )
      : length;
    distance += limit - progress;
    from = clonePoint(state.route[index]);
    progress = 0;
    if (index + 1 < state.route.length) {
      length = segmentLength(from, state.route[index + 1]);
    }
  }
  return distance;
}

function consumeMovementBudget(state, budget) {
  while (budget > 0 && state.route.length > 0) {
    const finalSegment = state.route.length === 1;
    const limit = finalSegment
      ? firstProgressInBar(
          state.segmentStart,
          state.route[0],
          state.segmentLength,
          state.bodyRadius,
          state.target,
        )
      : state.segmentLength;
    const remaining = limit - state.segmentProgress;
    const travel = Math.min(budget, Math.max(0, remaining));
    state.segmentProgress += travel;
    budget -= travel;
    state.position = interpolate(
      state.segmentStart,
      state.route[0],
      state.segmentProgress,
      state.segmentLength,
    );

    if (state.segmentProgress === limit) {
      if (finalSegment) {
        if (state.mode === BATTLE_MOVEMENT_MODES.ground) {
          state.anchor = clonePoint(state.target.position);
          state.routeIndex += 1;
        }
        idleAt(state);
        break;
      }
      state.position = clonePoint(state.route[0]);
      if (state.mode === BATTLE_MOVEMENT_MODES.ground) {
        state.edgeStart = clonePoint(state.position);
        state.routeIndex += 1;
      }
      state.route.shift();
      if (state.mode === BATTLE_MOVEMENT_MODES.ground) {
        state.anchor = clonePoint(state.route[0]);
      }
      startSegment(state);
    }
  }
}

function advanceStateOnly(state, ticks) {
  if (ticks === 0) return;
  let remainingTicks = ticks;
  while (remainingTicks > 0) {
    if (state.route.length === 0 || state.speed === 0) {
      state.tick += remainingTicks;
      return;
    }

    // Indexed history admission replays many independent air candidates with
    // one active direct segment. Seek that common non-arrival case without
    // rebuilding the route-distance accumulator on every command boundary.
    if (state.mode === BATTLE_MOVEMENT_MODES.air && state.route.length === 1) {
      const accumulated = state.remainder + state.speed * remainingTicks;
      const travel = Math.floor(accumulated / MOVEMENT_TICKS_PER_SECOND);
      const progress = state.segmentProgress + travel;
      // Interpolated coordinates move monotonically toward this direct air
      // target. If the last position is still outside its bar, no earlier
      // position in this chunk entered it, so avoid the binary search in
      // firstProgressInBar. Reaching or passing the segment end stays on the
      // general path, which handles arrival and any leftover ticks exactly.
      if (progress < state.segmentLength && !isInBar(
        interpolate(
          state.segmentStart,
          state.route[0],
          progress,
          state.segmentLength,
        ),
        state.bodyRadius,
        state.target,
      )) {
        state.remainder = accumulated % MOVEMENT_TICKS_PER_SECOND;
        state.segmentProgress = progress;
        state.position = interpolate(
          state.segmentStart,
          state.route[0],
          state.segmentProgress,
          state.segmentLength,
        );
        state.tick += remainingTicks;
        return;
      }
    }

    const distance = movementDistanceToArrival(state);
    const numerator = distance * MOVEMENT_TICKS_PER_SECOND - state.remainder;
    const arrivalTicks = Math.max(
      1,
      numerator <= 0 ? 1 : Math.ceil(numerator / state.speed),
    );
    if (arrivalTicks > remainingTicks) {
      const accumulated = state.remainder + state.speed * remainingTicks;
      state.remainder = accumulated % MOVEMENT_TICKS_PER_SECOND;
      consumeMovementBudget(
        state,
        Math.floor(accumulated / MOVEMENT_TICKS_PER_SECOND),
      );
      state.tick += remainingTicks;
      if (state.route.length === 0) state.remainder = 0;
      return;
    }

    // Consume only through the next arrival boundary. If the budget lands on
    // an intermediate waypoint whose next segment is already inside the
    // target bar, the public one-tick loop resolves that zero-distance segment
    // on the following tick. Keep the unused chunk ticks and iterate so this
    // bulk replay has the same boundary semantics.
    const accumulated = state.remainder + state.speed * arrivalTicks;
    state.remainder = accumulated % MOVEMENT_TICKS_PER_SECOND;
    consumeMovementBudget(
      state,
      Math.floor(accumulated / MOVEMENT_TICKS_PER_SECOND),
    );
    state.tick += arrivalTicks;
    remainingTicks -= arrivalTicks;
    if (state.route.length === 0) {
      state.remainder = 0;
      state.tick += remainingTicks;
      return;
    }
  }
}

function sameTickState(base, commands) {
  const state = canonicalState(base);
  state.commands = [];
  for (const command of commands) applyCommandState(state, command);
  return state;
}

function canonicalSameTickGroup(base, commands, expected) {
  if (sameAuthoritativeState(base, expected)) return [];
  if (commands.length === 1) return commands.map(cloneCommand);

  const last = commands.at(-1);
  if (sameAuthoritativeState(sameTickState(base, [last]), expected)) {
    return [cloneCommand(last)];
  }

  // Ground retargets can deliberately retain route provenance from an
  // earlier same-tick command. Preserve that causal prefix, but remove any
  // individual command whose omission is semantically invisible. This local
  // minimizer never advances simulation time and is therefore bounded by the
  // same-tick command group rather than MAX_TICK.
  const kept = commands.map(cloneCommand);
  let index = 0;
  while (index < kept.length) {
    const candidate = kept.slice(0, index).concat(kept.slice(index + 1));
    if (sameAuthoritativeState(sameTickState(base, candidate), expected)) {
      kept.splice(index, 1);
      continue;
    }
    index += 1;
  }
  return kept;
}

class BattleMovement {
  #state;
  #commandBase = null;
  #commandGroup = [];
  #commandTick = null;
  #serializedSnapshot = null;

  constructor(configuration) {
    runtimeInstances.add(this);
    assertPlainObject(configuration, "battle movement configuration");
    const keys = Object.keys(configuration).sort();
    const allowed = ["bodyRadius", "mode", "position", "speed"];
    if (keys.some((key) => !allowed.includes(key)) ||
        !keys.includes("mode") || !keys.includes("position")) {
      throw new TypeError("battle movement configuration has an invalid shape");
    }
    this.#state = initialState(configuration);
  }

  get state() {
    return deepFrozenState(this.#state);
  }

  setTarget(value) {
    const checked = target(value);
    if (checked === null) {
      throw new TypeError("battle movement target command requires a target");
    }
    if (this.#state.mode === BATTLE_MOVEMENT_MODES.ground &&
        !isGroundNavigationNode(checked.position)) {
      throw new RangeError("ground battle movement target must be a navigation node");
    }
    this.#beginCommandGroup();
    if (this.#commandGroup.length >= MAX_COMMANDS ||
        this.#state.commands.length >= MAX_COMMANDS) {
      throw new RangeError("battle movement command bound exceeded");
    }
    const candidate = canonicalState(this.#state);
    const command = {
      kind: "target",
      target: cloneTarget(checked),
      tick: this.#state.tick,
    };
    applyTargetState(candidate, checked);
    const rawGroup = [...this.#commandGroup, command];
    const effectiveGroup = canonicalSameTickGroup(
      this.#commandBase,
      rawGroup,
      candidate,
    );
    if (this.#commandBase.commands.length + effectiveGroup.length > MAX_COMMANDS) {
      throw new RangeError("battle movement command bound exceeded");
    }
    candidate.commands = this.#commandBase.commands.concat(effectiveGroup);
    this.#state = candidate;
    this.#commandGroup = rawGroup;
    this.#serializedSnapshot = null;
    return frozenEvents([
      event("target-set", this.#state.tick, this.#state.position, {
        target: frozenTarget(checked),
      }),
    ]);
  }

  stop() {
    this.#beginCommandGroup();
    if (this.#commandGroup.length >= MAX_COMMANDS ||
        this.#state.commands.length >= MAX_COMMANDS) {
      throw new RangeError("battle movement command bound exceeded");
    }
    const candidate = canonicalState(this.#state);
    const command = { kind: "stop", tick: this.#state.tick };
    applyStopState(candidate);
    const rawGroup = [...this.#commandGroup, command];
    const effectiveGroup = canonicalSameTickGroup(
      this.#commandBase,
      rawGroup,
      candidate,
    );
    if (this.#commandBase.commands.length + effectiveGroup.length > MAX_COMMANDS) {
      throw new RangeError("battle movement command bound exceeded");
    }
    candidate.commands = this.#commandBase.commands.concat(effectiveGroup);
    this.#state = candidate;
    this.#commandGroup = rawGroup;
    this.#serializedSnapshot = null;
    return frozenEvents([event("stopped", this.#state.tick, this.#state.position)]);
  }

  step() {
    return this.stepMany(1);
  }

  /**
   * Advances the shared movement clock without consuming route distance.
   * Status runtime owns why a boundary is paused. This method keeps the
   * movement authority's target, route, progress, and remainder intact.
   */
  stepPaused() {
    if (this.#state.tick >= MAX_TICK) {
      throw new RangeError("battle movement tick bound exceeded");
    }
    this.#state.tick += 1;
    this.#commandTick = null;
    this.#commandBase = null;
    this.#commandGroup = [];
    this.#serializedSnapshot = null;
    return frozenEvents([]);
  }

  stepMany(ticks) {
    integer(
      ticks,
      0,
      MAX_BATTLE_MOVEMENT_STEP_TICKS,
      "battle movement step ticks",
    );
    if (this.#state.tick + ticks > MAX_TICK) {
      throw new RangeError("battle movement tick bound exceeded");
    }
    if (ticks > 0) this.#serializedSnapshot = null;
    const events = [];
    for (let count = 0; count < ticks; count += 1) {
      this.#state.tick += 1;
      if (this.#state.route.length === 0 || this.#state.speed === 0) continue;
      const before = clonePoint(this.#state.position);
      const accumulated =
        BigInt(this.#state.remainder) + BigInt(this.#state.speed);
      let budget = Number(accumulated / BigInt(MOVEMENT_TICKS_PER_SECOND));
      this.#state.remainder = Number(
        accumulated % BigInt(MOVEMENT_TICKS_PER_SECOND),
      );
      consumeMovementBudget(this.#state, budget);

      if (before.x !== this.#state.position.x || before.y !== this.#state.position.y) {
        events.push(event("moved", this.#state.tick, this.#state.position, {
          from: Object.freeze(before),
        }));
      }
      if (this.#state.route.length === 0) {
        this.#state.remainder = 0;
        events.push(event("arrived", this.#state.tick, this.#state.position));
      }
    }
    if (ticks > 0) {
      this.#commandTick = null;
      this.#commandBase = null;
      this.#commandGroup = [];
    }
    return frozenEvents(events);
  }

  serialize() {
    if (this.#serializedSnapshot !== null) return this.#serializedSnapshot;
    // Canonicalization is tick-dependent, so it must never run against live
    // history: serializing early would rewrite causal commands and corrupt
    // future snapshots. Canonicalize a detached clone instead.
    const detached = compact(this);
    detached.#canonicalizeLiveHistory();
    this.#serializedSnapshot = JSON.stringify({
      state: canonicalState(detached.#state),
      version: 1,
    });
    return this.#serializedSnapshot;
  }

  /**
   * Copies the complete present movement authority without reconstructing it
   * from the public command history. The serialized history remains intact.
   */
  static {
    compact = (value) => value.#runtimeClone();
  }

  #runtimeClone() {
    const candidate = new BattleMovement({
      bodyRadius: this.#state.bodyRadius,
      mode: this.#state.mode,
      position: this.#state.initialPosition,
      speed: this.#state.speed,
    });
    candidate.#state = canonicalState(this.#state);
    candidate.#commandBase = this.#commandBase === null
      ? null
      : canonicalState(this.#commandBase);
    candidate.#commandGroup = this.#commandGroup.map(cloneCommand);
    candidate.#commandTick = this.#commandTick;
    candidate.#serializedSnapshot = this.#serializedSnapshot;
    return candidate;
  }

  #beginCommandGroup() {
    if (this.#commandTick === this.#state.tick) return;
    this.#commandTick = this.#state.tick;
    this.#commandBase = canonicalState(this.#state);
    this.#commandGroup = [];
  }

  #canonicalizeLiveHistory() {
    if (this.#state.commands.length < 2) return;
    const configuration = {
      bodyRadius: this.#state.bodyRadius,
      mode: this.#state.mode,
      position: this.#state.initialPosition,
      speed: this.#state.speed,
    };
    const canonicalCommands = canonicalCommandHistory(
      configuration,
      this.#state.commands,
      this.#state.tick,
      this.#state,
    );
    if (canonicalCommands.length !== this.#state.commands.length ||
        JSON.stringify(canonicalCommands) !== JSON.stringify(this.#state.commands)) {
      this.#state.commands = canonicalCommands;
      this.#commandTick = null;
      this.#commandBase = null;
      this.#commandGroup = [];
    }
  }

  static restore(serialized) {
    if (typeof serialized !== "string") {
      throw new TypeError("serialized battle movement must be a string");
    }
    if (new TextEncoder().encode(serialized).byteLength > MAX_SNAPSHOT_BYTES) {
      throw new RangeError("serialized battle movement exceeds the byte bound");
    }
    let snapshot;
    try {
      snapshot = JSON.parse(serialized);
    } catch {
      throw new TypeError("serialized battle movement must be valid JSON");
    }
    preflightMovementSnapshotGraph(
      snapshot,
      SNAPSHOT_GRAPH_LIMITS,
      "battle movement snapshot",
    );
    if (JSON.stringify(snapshot) !== serialized) {
      throw new TypeError("serialized battle movement must be canonical JSON");
    }
    assertExactKeys(snapshot, ["state", "version"], "battle movement snapshot");
    if (snapshot.version !== 1) {
      throw new TypeError("battle movement snapshot has an unsupported version");
    }
    const checked = validateState(snapshot.state, "battle movement snapshot.state");
    const configuration = {
      bodyRadius: checked.bodyRadius,
      mode: checked.mode,
      position: checked.initialPosition,
      speed: checked.speed,
    };
    const replayed = replayCommandState(
      configuration,
      checked.commands,
      checked.tick,
    );
    if (!sameAuthoritativeState(replayed, checked)) {
      throw new RangeError(
        "battle movement snapshot state is not reachable from its command history",
      );
    }
    const canonicalCommands = canonicalCommandHistory(
      configuration,
      checked.commands,
      checked.tick,
      checked,
    );
    if (JSON.stringify(canonicalCommands) !== JSON.stringify(checked.commands)) {
      throw new TypeError(
        "battle movement snapshot command history is not minimal canonical history",
      );
    }
    const restored = new BattleMovement({
      mode: BATTLE_MOVEMENT_MODES.air,
      position: { x: 0, y: 0 },
      speed: 0,
    });
    restored.#state = checked;
    if (JSON.stringify({ state: canonicalState(checked), version: 1 }) !== serialized) {
      throw new TypeError("battle movement snapshot is not canonical");
    }
    restored.#serializedSnapshot = serialized;
    return restored;
  }
}
  opaqueContinuation((value) => {
    if (!runtimeInstances.has(value)) {
      throw new TypeError("internal defineBattleMovement continuation receiver is invalid");
    }
    return compact(value);
  }, registerCompact);
  return { BATTLE_MOVEMENT_MODES, BattleMovement, MAX_BATTLE_MOVEMENT_STEP_TICKS };
}

function defineTowers(registerCompact) {
  let compact, currentTick;
  const runtimeInstances = new WeakSet();

const TOWER_TICKS_PER_SECOND = 60;

// Combat values are the level-11, pre-Evolutions comparison values. Tower
// positions remain the centralized screenshot-derived arena estimate.
const TOWER_COMBAT_CONFIG = Object.freeze({
  central: Object.freeze({
    countPerSide: 1,
    damage: 109,
    hitSpeedTicks: 60,
    hitpoints: 4824,
    rangeMillitiles: 7000,
    targets: "air_and_ground",
  }),
  lane: Object.freeze({
    countPerSide: 2,
    damage: 109,
    hitSpeedTicks: 48,
    hitpoints: 3052,
    rangeMillitiles: 7500,
    targets: "air_and_ground",
  }),
});

// Windup is deliberately not part of TOWER_COMBAT_CONFIG. The comparison
// corpus marks central 3.3 s as unverified and supplies no lane first-hit
// value, so callers must choose explicit, non-authoritative simulation values.
const TOWER_WINDUP_ESTIMATE = Object.freeze({
  central: Object.freeze({
    confidence: "unverified_estimate",
    ticks: 198,
  }),
  lane: Object.freeze({
    confidence: "unspecified_estimate",
    ticks: 0,
  }),
});

const TOWER_LIVE_SHOT_DELIVERY = Object.freeze({
  delivery: "projectile",
  projectileResolution: "external",
});

const SIDES = new Set(["north", "south"]);
const ROLES = new Set(["central", "lane"]);
const ACTIVATION_CAUSES = new Set(["damaged", "friendly-lane-destroyed"]);
const MAX_REPLAY_TICKS = 100_000;
const MAX_CANDIDATES_PER_TICK = 256;
const MAX_DAMAGE_ENTRIES_PER_TICK = 256;
const MAX_LIVE_CANDIDATE_IDENTITIES = 4_096;

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

function towerProjectileIdentity(sourceId, attackSequence, projectileId) {
  if (typeof sourceId !== "string" || sourceId.length === 0 || sourceId.length > 256 ||
      !Number.isSafeInteger(attackSequence) || attackSequence < 1 ||
      !Number.isSafeInteger(projectileId) || projectileId < 1) {
    throw new TypeError("tower projectile identity is invalid");
  }
  return {
    attackSequence,
    direction: "tower-to-unit",
    projectileId,
    sourceId,
  };
}

function plainObject(value, keys, label) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    throw new TypeError(`${label} must be a plain object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const actual = Reflect.ownKeys(descriptors);
  if (actual.some((key) => typeof key !== "string")) {
    throw new TypeError(`${label} must contain only string keys`);
  }
  const sortedActual = [...actual].sort();
  const sortedExpected = [...keys].sort();
  if (
    sortedActual.length !== sortedExpected.length ||
    sortedActual.some((key, index) => key !== sortedExpected[index])
  ) {
    throw new TypeError(`${label} has an invalid shape`);
  }
  const result = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
      throw new TypeError(`${label}.${key} must be an enumerable data property`);
    }
    result[key] = descriptor.value;
  }
  return result;
}

function safeNonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function checkedWindups(value) {
  const windups = plainObject(
    value,
    ["central", "lane"],
    "tower initial windups",
  );
  return {
    central: safeNonNegativeInteger(
      windups.central,
      "tower initial windups.central",
    ),
    lane: safeNonNegativeInteger(
      windups.lane,
      "tower initial windups.lane",
    ),
  };
}

function checkedActivationHistory(value, nextTick) {
  const history = plainObject(
    value,
    ["north", "south"],
    "tower activation history",
  );
  const result = {};
  for (const side of ["north", "south"]) {
    const entry = history[side];
    if (entry === null) {
      result[side] = null;
      continue;
    }
    const activation = plainObject(
      entry,
      ["cause", "tick"],
      `tower activation history.${side}`,
    );
    if (
      typeof activation.cause !== "string" ||
      !ACTIVATION_CAUSES.has(activation.cause)
    ) {
      throw new TypeError(
        `tower activation history.${side}.cause is invalid`,
      );
    }
    safeNonNegativeInteger(
      activation.tick,
      `tower activation history.${side}.tick`,
    );
    if (activation.tick >= nextTick) {
      throw new TypeError(
        `tower activation history.${side}.tick must precede nextTick`,
      );
    }
    result[side] = { cause: activation.cause, tick: activation.tick };
  }
  return result;
}

function towerId(side, role, lane) {
  return role === "central"
    ? `${side}:central`
    : `${side}:lane:${lane}`;
}

function createInitialTowers(windups) {
  return getArenaGeometry().towers.map((layout) => {
    const config = TOWER_COMBAT_CONFIG[layout.role];
    return {
      active: layout.role === "lane",
      attackCycle: new AttackCycle({
        deployTicks: 0,
        firstHitTicks: windups[layout.role],
        hitSpeedTicks: config.hitSpeedTicks,
      }),
      hitpoints: config.hitpoints,
      id: towerId(layout.side, layout.role, layout.lane),
      lane: layout.lane ?? null,
      position: { ...layout.center },
      role: layout.role,
      side: layout.side,
    };
  });
}

function cloneTower(tower) {
  return {
    active: tower.active,
    attack: tower.attackCycle.state,
    hitpoints: tower.hitpoints,
    id: tower.id,
    lane: tower.lane,
    position: { ...tower.position },
    role: tower.role,
    side: tower.side,
  };
}

function checkedDamage(value, index, validIds) {
  const damage = plainObject(
    value,
    ["amount", "towerId"],
    `tower damage ${index}`,
  );
  if (typeof damage.towerId !== "string" || !validIds.has(damage.towerId)) {
    throw new TypeError(`tower damage ${index}.towerId is unknown`);
  }
  safeNonNegativeInteger(damage.amount, `tower damage ${index}.amount`);
  return { amount: damage.amount, towerId: damage.towerId };
}

function checkedArray(value, label) {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (key === "length") continue;
    if (
      typeof key !== "string" ||
      !/^(0|[1-9]\d*)$/.test(key) ||
      Number(key) >= value.length
    ) {
      throw new TypeError(`${label} must contain only indexed data`);
    }
  }
  const result = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[index];
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !Object.hasOwn(descriptor, "value")
    ) {
      throw new TypeError(`${label}[${index}] must be an enumerable data property`);
    }
    result.push(descriptor.value);
  }
  return result;
}

function checkedStepInput(value, validIds, label = "tower step input") {
  const input = plainObject(value, ["candidates", "damage"], label);
  const candidateValues = checkedArray(input.candidates, `${label}.candidates`);
  if (candidateValues.length > MAX_CANDIDATES_PER_TICK) {
    throw new RangeError(
      `${label}.candidates exceeds ${MAX_CANDIDATES_PER_TICK} entries`,
    );
  }
  const candidates = candidateValues.map((candidate, index) =>
      targetCandidate(candidate, `${label}.candidates[${index}]`)
  );
  const candidateIds = new Set();
  for (const candidate of candidates) {
    if (candidateIds.has(candidate.id)) {
      throw new TypeError(`${label}.candidates must have unique IDs`);
    }
    candidateIds.add(candidate.id);
  }
  const damageValues = checkedArray(input.damage, `${label}.damage`);
  if (damageValues.length > MAX_DAMAGE_ENTRIES_PER_TICK) {
    throw new RangeError(
      `${label}.damage exceeds ${MAX_DAMAGE_ENTRIES_PER_TICK} entries`,
    );
  }
  const damage = damageValues.map(
    (entry, index) => checkedDamage(entry, index, validIds),
  );
  return { candidates, damage };
}

function checkedLiveCandidate(value, index, label) {
  const owned = plainObject(
    value,
    ["alive", "id", "kind", "layer", "position", "radius", "side", "targetable"],
    `${label}.candidates[${index}]`,
  );
  if (typeof owned.side !== "string" || !SIDES.has(owned.side)) {
    throw new TypeError(`${label}.candidates[${index}].side is invalid`);
  }
  const candidate = targetCandidate({
    alive: owned.alive,
    id: owned.id,
    kind: owned.kind,
    layer: owned.layer,
    position: owned.position,
    radius: owned.radius,
    targetable: owned.targetable,
  }, `${label}.candidates[${index}]`);
  return { ...candidate, side: owned.side };
}

function checkedLiveStepInput(value, validIds, label = "live tower step input") {
  const input = plainObject(value, ["candidates", "damage"], label);
  const candidateValues = checkedArray(input.candidates, `${label}.candidates`);
  if (candidateValues.length > MAX_CANDIDATES_PER_TICK) {
    throw new RangeError(`${label}.candidates exceeds ${MAX_CANDIDATES_PER_TICK} entries`);
  }
  const candidates = candidateValues.map((candidate, index) =>
    checkedLiveCandidate(candidate, index, label)
  );
  const candidateIds = new Set();
  for (const candidate of candidates) {
    if (candidateIds.has(candidate.id)) throw new TypeError(`${label}.candidates must have unique IDs`);
    candidateIds.add(candidate.id);
  }
  const damageValues = checkedArray(input.damage, `${label}.damage`);
  if (damageValues.length > MAX_DAMAGE_ENTRIES_PER_TICK) {
    throw new RangeError(`${label}.damage exceeds ${MAX_DAMAGE_ENTRIES_PER_TICK} entries`);
  }
  return {
    candidates,
    damage: damageValues.map((entry, index) => checkedDamage(entry, index, validIds)),
  };
}

function cloneStepInput(input) {
  return {
    candidates: input.candidates.map((candidate) => ({
      alive: candidate.alive,
      id: candidate.id,
      kind: candidate.kind,
      layer: candidate.layer,
      position: { ...candidate.position },
      radius: candidate.radius,
      targetable: candidate.targetable,
    })),
    damage: input.damage.map((entry) => ({ ...entry })),
  };
}

function cloneLiveStepInput(input) {
  return {
    candidates: input.candidates.map((candidate) => ({
      alive: candidate.alive,
      id: candidate.id,
      kind: candidate.kind,
      layer: candidate.layer,
      position: { ...candidate.position },
      radius: candidate.radius,
      side: candidate.side,
      targetable: candidate.targetable,
    })),
    damage: input.damage.map((entry) => ({ ...entry })),
  };
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function applyDamage(state, input, events) {
  const totals = new Map();
  for (const damage of input.damage) {
    totals.set(
      damage.towerId,
      (totals.get(damage.towerId) ?? 0) + damage.amount,
    );
    if (!Number.isSafeInteger(totals.get(damage.towerId))) {
      throw new RangeError("tower damage total exceeds the safe integer range");
    }
  }

  const newlyDestroyed = [];
  const directlyDamagedCentral = [];
  for (const [id, amount] of [...totals].sort(([a], [b]) => compareText(a, b))) {
    if (amount === 0) continue;
    const tower = state.towers.find((candidate) => candidate.id === id);
    if (tower.hitpoints === 0) continue;
    const previousHitpoints = tower.hitpoints;
    tower.hitpoints = Math.max(0, tower.hitpoints - amount);
    if (tower.role === "central" && !tower.active) {
      directlyDamagedCentral.push(tower);
    }
    if (previousHitpoints > 0 && tower.hitpoints === 0) {
      newlyDestroyed.push(tower);
    }
  }

  const activationCauses = new Map();
  for (const tower of directlyDamagedCentral) {
    activationCauses.set(tower.id, "damaged");
  }
  for (const tower of newlyDestroyed) {
    if (tower.role !== "lane") continue;
    const centralId = `${tower.side}:central`;
    if (!activationCauses.has(centralId)) {
      activationCauses.set(centralId, "friendly-lane-destroyed");
    }
  }
  for (const [id, cause] of [...activationCauses].sort(([a], [b]) =>
    compareText(a, b)
  )) {
    const central = state.towers.find((tower) => tower.id === id);
    if (!central.active) {
      central.active = true;
      state.activationHistory[central.side] = {
        cause,
        tick: state.nextTick,
      };
      events.push({
        cause,
        tick: state.nextTick,
        towerId: central.id,
        type: "tower-activated",
      });
    }
  }
  for (const tower of newlyDestroyed.sort((a, b) => compareText(a.id, b.id))) {
    events.push({
      tick: state.nextTick,
      towerId: tower.id,
      type: "tower-destroyed",
    });
  }
}

function stepChecked(state, input, { sideAware = false } = {}) {
  const events = [];
  applyDamage(state, input, events);

  for (const tower of state.towers) {
    const standingAndActive = tower.hitpoints > 0 && tower.active;
    const currentTargetId = standingAndActive
      ? tower.attackCycle.state.targetId
      : null;
    const candidates = sideAware
      ? input.candidates.filter((candidate) => candidate.side !== tower.side)
      : input.candidates;
    const targetCandidates = sideAware
      ? candidates.map(({ side: _side, ...candidate }) => candidate)
      : candidates;
    const target = standingAndActive
      ? retainOrAcquireTarget(
        { position: tower.position, radius: 0 },
        targetCandidates,
        {
          currentTargetId,
          mode: TOWER_COMBAT_CONFIG[tower.role].targets,
          sightRange: TOWER_COMBAT_CONFIG[tower.role].rangeMillitiles,
        },
      )
      : null;
    const attackEvents = tower.attackCycle.step({
      targetEligible: target !== null,
      targetId: target?.id ?? null,
    });
    for (const attack of attackEvents) {
      const event = {
        damage: TOWER_COMBAT_CONFIG[tower.role].damage,
        sequence: attack.sequence,
        targetId: attack.targetId,
        tick: attack.tick,
        towerId: tower.id,
        type: "shot-ready",
      };
      if (sideAware) {
        const liveTarget = candidates.find(({ id }) => id === attack.targetId) ?? null;
        if (liveTarget === null) {
          throw new TypeError("live tower shot requires retained target provenance");
        }
        Object.assign(event, {
          delivery: TOWER_LIVE_SHOT_DELIVERY.delivery,
          projectileResolution: TOWER_LIVE_SHOT_DELIVERY.projectileResolution,
          sourceId: tower.id,
          sourceSide: tower.side,
          targetSide: liveTarget.side,
        });
        if (state.nextProjectileId === Number.MAX_SAFE_INTEGER) {
          throw new RangeError("tower projectile ID exceeds the safe integer range");
        }
        const projectileIdentity = towerProjectileIdentity(
          tower.id,
          attack.sequence,
          state.nextProjectileId,
        );
        Object.assign(event, {
          attackSequence: projectileIdentity.attackSequence,
          direction: projectileIdentity.direction,
          projectileId: projectileIdentity.projectileId,
          projectileIdentity,
          projectileScope: projectileIdentity.direction,
        });
        state.nextProjectileId += 1;
      }
      events.push(event);
    }
  }

  if (state.nextTick === Number.MAX_SAFE_INTEGER) {
    throw new RangeError("tower tick exceeds the safe integer range");
  }
  state.nextTick += 1;
  return events;
}

function snapshotState(state) {
  return {
    activationHistory: {
      north: state.activationHistory.north === null
        ? null
        : { ...state.activationHistory.north },
      south: state.activationHistory.south === null
        ? null
        : { ...state.activationHistory.south },
    },
    initialWindupTicks: { ...state.initialWindupTicks },
    nextProjectileId: state.nextProjectileId,
    nextTick: state.nextTick,
    towers: state.towers.map((tower) => ({
      active: tower.active,
      attackCycle: JSON.parse(tower.attackCycle.serialize()),
      hitpoints: tower.hitpoints,
      id: tower.id,
      lane: tower.lane,
      position: { ...tower.position },
      role: tower.role,
      side: tower.side,
    })),
  };
}

function restoreState(value) {
  const state = plainObject(
    value,
    ["activationHistory", "initialWindupTicks", "nextProjectileId", "nextTick", "towers"],
    "tower snapshot state",
  );
  const windups = checkedWindups(state.initialWindupTicks);
  if (!Number.isSafeInteger(state.nextProjectileId) || state.nextProjectileId < 1) {
    throw new TypeError("tower snapshot state.nextProjectileId is invalid");
  }
  safeNonNegativeInteger(state.nextTick, "tower snapshot state.nextTick");
  const activationHistory = checkedActivationHistory(
    state.activationHistory,
    state.nextTick,
  );
  const initial = createInitialTowers(windups);
  const towerValues = checkedArray(state.towers, "tower snapshot state.towers");
  if (towerValues.length !== initial.length) {
    throw new TypeError("tower snapshot must contain exactly six towers");
  }
  const towers = towerValues.map((value, index) => {
    const tower = plainObject(
      value,
      [
        "active",
        "attackCycle",
        "hitpoints",
        "id",
        "lane",
        "position",
        "role",
        "side",
      ],
      `tower snapshot tower ${index}`,
    );
    const expected = initial[index];
    if (
      tower.id !== expected.id ||
      tower.lane !== expected.lane ||
      tower.role !== expected.role ||
      tower.side !== expected.side ||
      canonicalJson(tower.position) !== canonicalJson(expected.position)
    ) {
      throw new TypeError(`tower snapshot tower ${index} has invalid identity`);
    }
    if (typeof tower.active !== "boolean") {
      throw new TypeError(`tower snapshot tower ${index}.active must be boolean`);
    }
    safeNonNegativeInteger(
      tower.hitpoints,
      `tower snapshot tower ${index}.hitpoints`,
    );
    if (tower.hitpoints > TOWER_COMBAT_CONFIG[tower.role].hitpoints) {
      throw new TypeError(`tower snapshot tower ${index}.hitpoints is too high`);
    }
    const attackCycle = AttackCycle.restore(canonicalJson(tower.attackCycle));
    if (attackCycle.state.nextTick !== state.nextTick) {
      throw new TypeError(`tower snapshot tower ${index} tick is inconsistent`);
    }
    const expectedAttackConfig = {
      deployTicks: 0,
      firstHitTicks: windups[tower.role],
      hitSpeedTicks: TOWER_COMBAT_CONFIG[tower.role].hitSpeedTicks,
    };
    if (
      canonicalJson(attackCycle.state.config) !==
      canonicalJson(expectedAttackConfig)
    ) {
      throw new TypeError(
        `tower snapshot tower ${index} attack config is inconsistent`,
      );
    }
    if (
      (!tower.active || tower.hitpoints === 0) &&
      attackCycle.state.targetId !== null
    ) {
      throw new TypeError(
        `tower snapshot tower ${index} cannot retain a target`,
      );
    }
    return { ...expected, active: tower.active, attackCycle, hitpoints: tower.hitpoints };
  });
  for (const tower of towers) {
    if (tower.role === "lane" && !tower.active) {
      throw new TypeError("lane towers must remain active");
    }
    if (tower.role !== "central") continue;
    const activation = activationHistory[tower.side];
    const friendlyLaneDestroyed = towers.some(
      (candidate) =>
        candidate.side === tower.side &&
        candidate.role === "lane" &&
        candidate.hitpoints === 0,
    );
    if (!tower.active) {
      if (
        activation !== null ||
        tower.hitpoints !== TOWER_COMBAT_CONFIG.central.hitpoints ||
        friendlyLaneDestroyed
      ) {
        throw new TypeError("inactive central tower violates activation history");
      }
      continue;
    }
    if (activation === null) {
      throw new TypeError("active central tower requires activation history");
    }
    if (
      activation.cause === "damaged" &&
      tower.hitpoints === TOWER_COMBAT_CONFIG.central.hitpoints
    ) {
      throw new TypeError(
        "damaged central activation requires direct damage provenance",
      );
    }
    if (
      activation.cause === "friendly-lane-destroyed" &&
      !friendlyLaneDestroyed
    ) {
      throw new TypeError(
        "lane-destruction activation requires a destroyed friendly lane",
      );
    }
  }
  return {
    activationHistory,
    initialWindupTicks: windups,
    nextProjectileId: state.nextProjectileId,
    nextTick: state.nextTick,
    towers,
  };
}

/**
 * Deterministic six-tower state for one arena.
 *
 * Damage for a boundary is resolved as a simultaneous batch before activation,
 * target selection, and shot readiness. Events are stable by tower ID. This
 * model intentionally emits shot readiness only; projectile travel is external.
 * Central activation provenance is irreversible and written exactly when the
 * activation event is emitted. Direct damage wins when direct damage and a
 * friendly lane death occur on the same boundary.
 */
class CrownTowerBattle {
  #candidateSides;
  #state;
  #stepHistory;

  constructor({ initialWindupTicks }) {
    runtimeInstances.add(this);
    const windups = checkedWindups(initialWindupTicks);
    this.#state = {
      activationHistory: { north: null, south: null },
      initialWindupTicks: windups,
      nextProjectileId: 1,
      nextTick: 0,
      towers: createInitialTowers(windups),
    };
    this.#candidateSides = new Map();
    this.#stepHistory = [];
  }

  get state() {
    return {
      activationHistory: {
        north: this.#state.activationHistory.north === null
          ? null
          : { ...this.#state.activationHistory.north },
        south: this.#state.activationHistory.south === null
          ? null
          : { ...this.#state.activationHistory.south },
      },
      initialWindupTicks: { ...this.#state.initialWindupTicks },
      nextTick: this.#state.nextTick,
      towers: this.#state.towers.map(cloneTower),
    };
  }

  /** Returns an independent continuation without replaying prior ticks. */
  fork() {
    const candidate = new CrownTowerBattle({
      initialWindupTicks: this.#state.initialWindupTicks,
    });
    candidate.#state = restoreState(snapshotState(this.#state));
    candidate.#candidateSides = new Map(this.#candidateSides);
    candidate.#stepHistory = this.#stepHistory.map(({ input, mode }) => ({
      input: mode === "side-aware" ? cloneLiveStepInput(input) : cloneStepInput(input),
      mode,
    }));
    return candidate;
  }

  /** Internal-composition checkpoint: exact continuation without duplicate step provenance. */
  static {
    compact = (value) => value.#runtimeClone();
    currentTick = (value) => {
      if (!runtimeInstances.has(value)) {
        throw new TypeError("internal defineTowers tick receiver is invalid");
      }
      return value.#state.nextTick;
    };
  }

  #runtimeClone() {
    const candidate = new CrownTowerBattle({ initialWindupTicks: this.#state.initialWindupTicks });
    candidate.#state = restoreState(snapshotState(this.#state));
    candidate.#candidateSides = new Map(this.#candidateSides);
    return candidate;
  }

  /** Computes a live boundary without copying or retaining replay history. */
  previewLive(input) {
    const candidate = new CrownTowerBattle({
      initialWindupTicks: this.#state.initialWindupTicks,
    });
    candidate.#state = restoreState(snapshotState(this.#state));
    candidate.#candidateSides = new Map(this.#candidateSides);
    return candidate.stepLive(input);
  }

  step(input) {
    return this.stepMany([input]);
  }

  stepMany(inputs) {
    const rawInputs = checkedArray(inputs, "tower step inputs");
    if (rawInputs.length > MAX_REPLAY_TICKS - this.#stepHistory.length) {
      throw new RangeError(
        `tower step history exceeds ${MAX_REPLAY_TICKS} ticks`,
      );
    }
    const validIds = new Set(this.#state.towers.map((tower) => tower.id));
    const checkedInputs = rawInputs.map((input, index) =>
      checkedStepInput(input, validIds, `tower step input ${index}`)
    );
    const candidate = restoreState(snapshotState(this.#state));
    const events = [];
    for (const input of checkedInputs) events.push(...stepChecked(candidate, input));
    this.#state = candidate;
    this.#stepHistory.push(...checkedInputs.map((input) => ({
      input: cloneStepInput(input),
      mode: "legacy",
    })));
    return events;
  }

  stepLive(input) {
    return this.stepManyLive([input]);
  }

  stepManyLive(inputs) {
    const rawInputs = checkedArray(inputs, "live tower step inputs");
    if (rawInputs.length > MAX_REPLAY_TICKS - this.#stepHistory.length) {
      throw new RangeError(`tower step history exceeds ${MAX_REPLAY_TICKS} ticks`);
    }
    const validIds = new Set(this.#state.towers.map((tower) => tower.id));
    const checkedInputs = rawInputs.map((input, index) =>
      checkedLiveStepInput(input, validIds, `live tower step input ${index}`)
    );
    const candidateSides = new Map(this.#candidateSides);
    for (const input of checkedInputs) {
      for (const candidate of input.candidates) {
        const known = candidateSides.get(candidate.id);
        if (known !== undefined && known !== candidate.side) {
          throw new TypeError(`live tower candidate ${candidate.id} cannot change side`);
        }
        candidateSides.set(candidate.id, candidate.side);
        if (candidateSides.size > MAX_LIVE_CANDIDATE_IDENTITIES) {
          throw new RangeError(`live tower candidate identities exceed ${MAX_LIVE_CANDIDATE_IDENTITIES}`);
        }
      }
    }
    const candidate = restoreState(snapshotState(this.#state));
    const events = [];
    for (const input of checkedInputs) {
      events.push(...stepChecked(candidate, input, { sideAware: true }));
    }
    this.#state = candidate;
    this.#candidateSides = candidateSides;
    this.#stepHistory.push(...checkedInputs.map((input) => ({
      input: cloneLiveStepInput(input),
      mode: "side-aware",
    })));
    return events;
  }

  serialize() {
    const hasLiveSteps = this.#stepHistory.some(({ mode }) => mode === "side-aware");
    return canonicalJson({
      initialWindupTicks: { ...this.#state.initialWindupTicks },
      steps: hasLiveSteps
        ? this.#stepHistory.map(({ input, mode }) => ({
          input: mode === "side-aware" ? cloneLiveStepInput(input) : cloneStepInput(input),
          mode,
        }))
        : this.#stepHistory.map(({ input }) => cloneStepInput(input)),
      version: hasLiveSteps ? 4 : 3,
    });
  }

  static restore(serialized) {
    if (typeof serialized !== "string") {
      throw new TypeError("serialized tower state must be a string");
    }
    let value;
    try {
      value = JSON.parse(serialized);
    } catch {
      throw new TypeError("serialized tower state must be valid JSON");
    }
    const snapshot = plainObject(
      value,
      ["initialWindupTicks", "steps", "version"],
      "tower snapshot",
    );
    if (snapshot.version !== 3 && snapshot.version !== 4) {
      throw new TypeError("tower snapshot has an unsupported version");
    }
    const windups = checkedWindups(snapshot.initialWindupTicks);
    const steps = checkedArray(snapshot.steps, "tower snapshot.steps");
    if (steps.length > MAX_REPLAY_TICKS) {
      throw new RangeError(
        `tower snapshot.steps exceeds ${MAX_REPLAY_TICKS} ticks`,
      );
    }
    const battle = new CrownTowerBattle({
      initialWindupTicks: windups,
    });
    // HP, deaths, activation provenance, targets, and attack-cycle continuation
    // all derive from the immutable initial roster by the normal transition.
    // No serialized current-state field is trusted as an independent authority.
    if (snapshot.version === 3) {
      battle.stepMany(steps);
    } else {
      let hasLiveStep = false;
      for (let index = 0; index < steps.length; index += 1) {
        const entry = plainObject(
          steps[index],
          ["input", "mode"],
          `tower snapshot.steps[${index}]`,
        );
        if (entry.mode === "legacy") battle.step(entry.input);
        else if (entry.mode === "side-aware") {
          hasLiveStep = true;
          battle.stepLive(entry.input);
        }
        else throw new TypeError(`tower snapshot.steps[${index}].mode is invalid`);
      }
      if (!hasLiveStep) throw new TypeError("tower snapshot version 4 requires a side-aware step");
    }
    return battle;
  }
}

function towerSecondsToTicks(seconds) {
  return attackSecondsToTicks(seconds);
}
  opaqueContinuation((value) => {
    if (!runtimeInstances.has(value)) {
      throw new TypeError("internal defineTowers continuation receiver is invalid");
    }
    return compact(value);
  }, registerCompact);
  return { CrownTowerBattle, TOWER_COMBAT_CONFIG, TOWER_LIVE_SHOT_DELIVERY, TOWER_TICKS_PER_SECOND, TOWER_WINDUP_ESTIMATE, currentTick, towerSecondsToTicks };
}

function defineBattleTowers(BattleCombat, CrownTowerBattle, MAX_BATTLE_COMBAT_STEP_TICKS,
  battleCombatCompactClone, resolveBattleCombat, crownTowerCompactClone,
  resolveCrownTower, battleCombatCurrentTick, crownTowerCurrentTick,
  recordCombatStructureContacts, registerCompact) {
  let compact, towerSnapshot, recordStructureContacts;
  const runtimeInstances = new WeakSet();

const MAX_BATTLE_TOWER_STEP_TICKS = MAX_BATTLE_COMBAT_STEP_TICKS;

const MAX_HISTORY = 100_000;
const MAX_SNAPSHOT_BYTES = 4_194_304;
const EXPLICIT_HISTORY_TAIL = 256;
const MAX_TICK = 1_000_000_000;
const TOWER_IDS = new Map([
  ["south:central", Number.MAX_SAFE_INTEGER - 5],
  ["south:lane:west", Number.MAX_SAFE_INTEGER - 4],
  ["south:lane:east", Number.MAX_SAFE_INTEGER - 3],
  ["north:central", Number.MAX_SAFE_INTEGER - 2],
  ["north:lane:west", Number.MAX_SAFE_INTEGER - 1],
  ["north:lane:east", Number.MAX_SAFE_INTEGER],
]);
const TOWER_NUMERIC_IDS = new Set(TOWER_IDS.values());
const TOWER_TEXT_IDS = new Set(TOWER_IDS.keys());
// Ceiling of the center-to-corner distance for the existing estimated arena
// footprints: sqrt(1,500^2 + 1,500^2) and sqrt(2,000^2 + 2,000^2).
// The combat kernel is circular, so the circumscribed radius represents the
// whole authoritative square footprint without a side-dependent correction.
const TOWER_FOOTPRINT_RADII = Object.freeze({ central: 2_829, lane: 2_122 });

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

function denseArray(value, label, maximum = MAX_HISTORY) {
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

function checkedUnitControl(value, index) {
  const label = `battle tower external boundary.unitControls[${index}]`;
  const control = exact(value, ["attackBlocked", "attackStep", "id", "targetable"], label);
  integer(control.id, 1, Number.MAX_SAFE_INTEGER, `${label}.id`);
  if (typeof control.attackBlocked !== "boolean" ||
      typeof control.targetable !== "boolean" ||
      !["normal", "pause"].includes(control.attackStep)) {
    throw new TypeError(`${label} contains invalid status control flags`);
  }
  return { ...control };
}

function checkedUnitHeal(value, index) {
  const label = `battle tower external boundary.unitHeals[${index}]`;
  const heal = exact(value, ["amount", "commandId", "sourceId", "targetUnitId"], label);
  integer(heal.amount, 0, Number.MAX_SAFE_INTEGER, `${label}.amount`);
  integer(heal.commandId, 0, Number.MAX_SAFE_INTEGER, `${label}.commandId`);
  integer(heal.sourceId, 1, Number.MAX_SAFE_INTEGER, `${label}.sourceId`);
  integer(heal.targetUnitId, 1, Number.MAX_SAFE_INTEGER, `${label}.targetUnitId`);
  return { ...heal };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function freeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
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

function positionVelocity(left, right) {
  if (left.length !== right.length) return null;
  return left.map((entry, index) => entry.id === right[index].id ? {
    dx: right[index].position.x - entry.position.x,
    dy: right[index].position.y - entry.position.y,
    id: entry.id,
  } : null).includes(null) ? null : left.map((entry, index) => ({
    dx: right[index].position.x - entry.position.x,
    dy: right[index].position.y - entry.position.y,
    id: entry.id,
  }));
}

function applyVelocity(positions, velocity) {
  return positions.map((entry, index) => ({ id: entry.id, position: {
    x: entry.position.x + velocity[index].dx,
    y: entry.position.y + velocity[index].dy,
  } }));
}

function compactTowerHistory(history) {
  const transcript = [];
  for (let index = 0; index < history.length;) {
    const operation = history[index];
    if (operation.type === "positions" && history[index + 1]?.type === "step" &&
        operation.command.tick === history[index + 1].tick) {
      const positions = clone(operation.command.positions);
      let prior = positions, velocity = null, ticks = 1;
      while (history[index + ticks * 2]?.type === "positions" &&
          history[index + ticks * 2 + 1]?.type === "step") {
        const next = history[index + ticks * 2].command;
        if (next.tick !== operation.command.tick + ticks ||
            history[index + ticks * 2 + 1].tick !== next.tick) break;
        const delta = positionVelocity(prior, next.positions);
        if (delta === null || (velocity !== null && canonical(delta) !== canonical(velocity))) break;
        velocity ??= delta; prior = next.positions; ticks += 1;
      }
      transcript.push({ positions, tick: operation.command.tick, ticks,
        type: "position-step-run", velocity: velocity ?? positions.map(({ id }) =>
          ({ dx: 0, dy: 0, id })) });
      index += ticks * 2; continue;
    }
    if (operation.type === "step") {
      let ticks = 1;
      while (history[index + ticks]?.type === "step" &&
          history[index + ticks].tick === operation.tick + ticks) ticks += 1;
      transcript.push({ tick: operation.tick, ticks, type: "step-run" });
      index += ticks; continue;
    }
    transcript.push(clone(operation)); index += 1;
  }
  return transcript;
}

function preflightUnitIds(units, label = "battle tower setup.units") {
  for (const [index, unit] of denseArray(units, label, 1_024).entries()) {
    const descriptors = plain(unit, `${label}[${index}]`);
    const id = descriptors.id?.value;
    if (TOWER_NUMERIC_IDS.has(id)) {
      throw new RangeError(`${label}[${index}].id is reserved for a crown tower structure`);
    }
  }
}

function structuresFrom(towers) {
  return towers.map((tower) => ({
    alive: tower.hitpoints > 0,
    id: TOWER_IDS.get(tower.id),
    kind: "structure",
    layer: "ground",
    position: { ...tower.position },
    radius: TOWER_FOOTPRINT_RADII[tower.role],
    side: tower.side,
    structureId: tower.id,
    targetable: tower.hitpoints > 0,
  }));
}

function candidatesFrom(combat, unitControls = []) {
  const state = combat.state;
  const controls = new Map(unitControls.map((control) => [control.id, control]));
  const candidates = state.units.filter(({ alive }) => alive).map((unit) => ({
    alive: true,
    id: unit.id,
    kind: "troop",
    layer: unit.layer,
    position: { ...unit.position },
    radius: unit.radius,
    side: unit.side,
    targetable: controls.get(unit.id)?.targetable ?? true,
  }));
  for (const pending of state.pendingSpawns) {
    if (pending.tick !== state.tick || candidates.some(({ id }) => id === pending.id)) continue;
    candidates.push({
      alive: true,
      id: pending.id,
      kind: "troop",
      layer: pending.layer,
      position: { ...pending.position },
      radius: pending.radius,
      side: pending.side,
      targetable: controls.get(pending.id)?.targetable ?? true,
    });
  }
  return candidates.sort((left, right) => left.id - right.id);
}

function towerDamageFrom(events) {
  return events.filter(({ type }) => type === "external-structure-contact")
    .filter(({ structureId }) => TOWER_TEXT_IDS.has(structureId))
    .map(({ damage, structureId }) => ({ amount: damage, towerId: structureId }));
}

function checkedTowerProjectile(value, index) {
  const label = `battle tower external boundary.externalProjectiles[${index}]`;
  const descriptors = plain(value, label);
  const actual = Reflect.ownKeys(descriptors).sort();
  const legacyKeys = ["damage", "projectileId", "sourceId", "targetUnitId"];
  const scalarKeys = [
    "attackSequence", "damage", "direction", "projectileId", "sourceId", "targetUnitId",
  ];
  const currentKeys = [...scalarKeys, "projectileIdentity"];
  const legacy = actual.length === legacyKeys.length &&
    actual.every((key, keyIndex) => key === [...legacyKeys].sort()[keyIndex]);
  const scalar = actual.length === scalarKeys.length &&
    actual.every((key, keyIndex) => key === [...scalarKeys].sort()[keyIndex]);
  const projectile = legacy || scalar
    ? exact(value, legacy ? legacyKeys : scalarKeys, label)
    : exact(value, currentKeys, label);
  if (legacy) {
    projectile.attackSequence = projectile.projectileId;
    projectile.direction = "tower-to-unit";
  }
  if (projectile.direction !== "tower-to-unit") {
    throw new TypeError(`${label}.direction is invalid`);
  }
  if (!Number.isSafeInteger(projectile.attackSequence) || projectile.attackSequence < 1 ||
      !Number.isSafeInteger(projectile.projectileId) || projectile.projectileId < 1 ||
      !Number.isSafeInteger(projectile.targetUnitId) || projectile.targetUnitId < 1 ||
      !Number.isSafeInteger(projectile.damage) || projectile.damage < 0 ||
      typeof projectile.sourceId !== "string" || projectile.sourceId.length === 0 ||
      projectile.sourceId.length > 256) {
    throw new TypeError(`${label} contains invalid projectile data`);
  }
  const expected = checkedProjectileIdentity({
    attackSequence: projectile.attackSequence,
    direction: projectile.direction,
    projectileId: projectile.projectileId,
    sourceId: projectile.sourceId,
  }, `${label}.projectileIdentity`);
  if (!legacy && !scalar && canonical(projectile.projectileIdentity) !== canonical(expected)) {
    throw new TypeError(`${label}.projectileIdentity does not match its scalar mirrors`);
  }
  return { ...projectile, projectileIdentity: expected };
}

function checkedBuildingBoundary(value, currentTick) {
  const baseKeys = ["externalHits", "externalProjectiles", "externalTowerHits", "structures", "tick"];
  const statusKeys = [...baseKeys, "unitControls", "unitHeals"];
  const descriptors = plain(value, "battle tower external boundary");
  const actual = Reflect.ownKeys(descriptors).sort();
  const hasStatus = actual.length === statusKeys.length &&
    actual.every((key, index) => key === [...statusKeys].sort()[index]);
  const sortedBase = [...baseKeys].sort();
  if (!hasStatus && (actual.length !== sortedBase.length ||
      actual.some((key, index) => key !== sortedBase[index]))) {
    throw new TypeError("battle tower external boundary has an invalid shape");
  }
  const boundary = exact(value, hasStatus ? statusKeys : baseKeys,
    "battle tower external boundary");
  if (boundary.tick !== currentTick) {
    throw new RangeError("battle tower external boundary tick must equal the current tick");
  }
  const hits = denseArray(boundary.externalTowerHits, "battle tower external tower hits", 1_024)
    .map((entry, index) => {
      const hit = exact(entry, ["amount", "sourceId", "towerId"],
        `battle tower external tower hits[${index}]`);
      integer(hit.amount, 0, Number.MAX_SAFE_INTEGER,
        `battle tower external tower hits[${index}].amount`);
      if (typeof hit.sourceId !== "string" || hit.sourceId.length === 0 ||
          !TOWER_TEXT_IDS.has(hit.towerId)) {
        throw new TypeError(`battle tower external tower hits[${index}] is invalid`);
      }
      return clone(hit);
    }).sort((left, right) => left.towerId.localeCompare(right.towerId) ||
      left.sourceId.localeCompare(right.sourceId) || left.amount - right.amount);
  if (new Set(hits.map(({ sourceId, towerId }) => `${towerId}:${sourceId}`)).size !== hits.length) {
    throw new TypeError("battle tower external tower hit identities must be unique");
  }
  const externalProjectiles = denseArray(
    boundary.externalProjectiles,
    "battle tower external boundary.externalProjectiles",
    1_024,
  ).map(checkedTowerProjectile).sort((left, right) =>
    left.projectileId - right.projectileId);
  if (new Set(externalProjectiles.map(({ projectileId }) => projectileId)).size !==
      externalProjectiles.length) {
    throw new TypeError("battle tower external projectile IDs must be unique");
  }
  if (!hasStatus) return { externalHits: clone(boundary.externalHits),
    externalProjectiles, externalTowerHits: hits,
    structures: clone(boundary.structures), tick: boundary.tick };
  const unitControls = denseArray(boundary.unitControls,
    "battle tower external boundary.unitControls", 1_024)
    .map(checkedUnitControl)
    .sort((left, right) => left.id - right.id);
  const unitHeals = denseArray(boundary.unitHeals,
    "battle tower external boundary.unitHeals", 1_024)
    .map(checkedUnitHeal)
    .sort((left, right) => left.commandId - right.commandId ||
      left.sourceId - right.sourceId || left.targetUnitId - right.targetUnitId);
  if (new Set(unitControls.map(({ id }) => id)).size !== unitControls.length ||
      new Set(unitHeals.map(({ commandId, sourceId }) =>
        `${sourceId}:${commandId}`)).size !== unitHeals.length) {
    throw new TypeError("battle tower status ingress identities must be unique");
  }
  return { externalHits: clone(boundary.externalHits),
    externalProjectiles, externalTowerHits: hits,
    structures: clone(boundary.structures), tick: boundary.tick, unitControls, unitHeals };
}

// Spell profiles are admitted by LiveBattle, then translated to the exact
// unit-health ingress BattleCombat already owns.  Keeping this small typed
// envelope here lets the tower bridge preserve a distinct causal witness for
// a sourced effect boundary without granting an effect reducer tower authority.
function checkedEffects(value) {
  const effects = exact(value, ["unitHits"], "battle tower effects");
  const unitHits = denseArray(effects.unitHits, "battle tower effects.unitHits", 1_024)
    .map((value, index) => {
      const entry = exact(value, ["damage", "effectId", "sourceId", "targetUnitId"],
        `battle tower effects.unitHits[${index}]`);
      return {
        damage: integer(entry.damage, 0, Number.MAX_SAFE_INTEGER,
          `battle tower effects.unitHits[${index}].damage`),
        effectId: integer(entry.effectId, 1, Number.MAX_SAFE_INTEGER,
          `battle tower effects.unitHits[${index}].effectId`),
        sourceId: typeof entry.sourceId === "string" && entry.sourceId.length > 0 &&
            entry.sourceId.length <= 128
          ? entry.sourceId
          : (() => { throw new TypeError(`battle tower effects.unitHits[${index}].sourceId is invalid`); })(),
        targetUnitId: integer(entry.targetUnitId, 1, Number.MAX_SAFE_INTEGER,
          `battle tower effects.unitHits[${index}].targetUnitId`),
      };
    });
  if (new Set(unitHits.map(({ effectId, targetUnitId }) => `${effectId}:${targetUnitId}`)).size !== unitHits.length) {
    throw new TypeError("battle tower effects must have unique effect/target pairs");
  }
  return { unitHits: unitHits.sort((left, right) => left.effectId - right.effectId ||
    left.targetUnitId - right.targetUnitId) };
}

const PROJECTILE_IDENTITY_KEYS = [
  "attackSequence", "direction", "projectileId", "sourceId",
];
const PROJECTILE_DIRECTIONS = new Set([
  "unit-to-tower", "unit-to-unit", "tower-to-unit",
]);

function checkedProjectileIdentity(value, label = "projectile identity") {
  const projectileIdentity = exact(value, PROJECTILE_IDENTITY_KEYS, label);
  if (!Number.isSafeInteger(projectileIdentity.attackSequence) ||
      projectileIdentity.attackSequence < 1 ||
      !Number.isSafeInteger(projectileIdentity.projectileId) ||
      projectileIdentity.projectileId < 1 ||
      !PROJECTILE_DIRECTIONS.has(projectileIdentity.direction) ||
      (!Number.isSafeInteger(projectileIdentity.sourceId) &&
        (typeof projectileIdentity.sourceId !== "string" ||
          projectileIdentity.sourceId.length === 0 ||
          projectileIdentity.sourceId.length > 256))) {
    throw new TypeError(`${label} is invalid`);
  }
  return { ...projectileIdentity };
}

function projectileFor(shot) {
  const projectileIdentity = checkedProjectileIdentity(
    shot.projectileIdentity,
    "tower projectile launch identity",
  );
  return {
    attackSequence: projectileIdentity.attackSequence,
    damage: shot.damage,
    direction: projectileIdentity.direction,
    projectileId: projectileIdentity.projectileId,
    projectileIdentity: clone(projectileIdentity),
    sourceId: projectileIdentity.sourceId,
    targetUnitId: shot.targetUnitId,
  };
}

function withIdentity(event, projectileIdentity) {
  const checked = checkedProjectileIdentity(projectileIdentity);
  if (Object.hasOwn(event, "projectileIdentity") &&
      canonical(event.projectileIdentity) !== canonical(checked)) {
    throw new TypeError("projectile event contains divergent identity provenance");
  }
  for (const [key, expected] of [
    ["attackSequence", checked.attackSequence],
    ["direction", checked.direction],
    ["projectileId", checked.projectileId],
    ["sourceId", checked.sourceId],
    ["sourceUnitId", checked.sourceId],
    ["externalProjectileId", checked.projectileId],
    ["externalSourceId", checked.sourceId],
  ]) {
    if (Object.hasOwn(event, key) && event[key] !== expected) {
      throw new TypeError(`projectile event contains divergent ${key} provenance`);
    }
  }
  if (Object.hasOwn(event, "sequence") && event.sequence !== checked.attackSequence) {
    throw new TypeError("projectile event contains divergent sequence provenance");
  }
  if (Object.hasOwn(event, "attackerId") && event.attackerId !== checked.sourceId) {
    throw new TypeError("projectile event contains divergent attacker provenance");
  }
  if (Object.hasOwn(event, "projectileScope") && event.projectileScope !== checked.direction) {
    throw new TypeError("projectile event contains divergent scope provenance");
  }
  if (Object.hasOwn(event, "projectile") &&
      Object.hasOwn(event.projectile, "projectileIdentity") &&
      canonical(event.projectile.projectileIdentity) !== canonical(checked)) {
    throw new TypeError("projectile data contains divergent identity provenance");
  }
  if (Object.hasOwn(event, "projectile")) {
    for (const [key, expected] of [
      ["attackSequence", checked.attackSequence],
      ["direction", checked.direction],
      ["projectileId", checked.projectileId],
      ["sourceId", checked.sourceId],
    ]) {
      if (Object.hasOwn(event.projectile, key) && event.projectile[key] !== expected) {
        throw new TypeError(`projectile data contains divergent ${key} provenance`);
      }
    }
    if (Object.hasOwn(event.projectile, "id") &&
        event.projectile.id !== checked.projectileId) {
      throw new TypeError("projectile data contains divergent ID provenance");
    }
    if (Object.hasOwn(event.projectile, "attackerId") &&
        event.projectile.attackerId !== checked.sourceId) {
      throw new TypeError("projectile data contains divergent attacker provenance");
    }
    if (Object.hasOwn(event.projectile, "projectileScope") &&
        event.projectile.projectileScope !== checked.direction) {
      throw new TypeError("projectile data contains divergent scope provenance");
    }
  }
  return {
    ...event,
    attackSequence: checked.attackSequence,
    direction: checked.direction,
    projectileIdentity: clone(checked),
    projectileId: checked.projectileId,
    projectileScope: checked.direction,
    sourceId: checked.sourceId,
  };
}

function strictProjectileEvent(event, label) {
  const identity = checkedProjectileIdentity(event.projectileIdentity,
    `${label}.projectileIdentity`);
  for (const [key, expected] of [
    ["attackSequence", identity.attackSequence],
    ["direction", identity.direction],
    ["projectileId", identity.projectileId],
    ["sourceId", identity.sourceId],
    ["projectileScope", identity.direction],
  ]) {
    if (!Object.hasOwn(event, key) || event[key] !== expected) {
      throw new TypeError(`${label}.${key} does not match its current identity`);
    }
  }
  if (Object.hasOwn(event, "sequence") && event.sequence !== identity.attackSequence) {
    throw new TypeError(`${label}.sequence does not match its current identity`);
  }
  if (Object.hasOwn(event, "attackerId") && event.attackerId !== identity.sourceId) {
    throw new TypeError(`${label}.attackerId does not match its current identity`);
  }
  if (Object.hasOwn(event, "sourceUnitId") && event.sourceUnitId !== identity.sourceId) {
    throw new TypeError(`${label}.sourceUnitId does not match its current identity`);
  }
  if (Object.hasOwn(event, "projectile")) {
    const projectile = event.projectile;
    if (projectile === null || typeof projectile !== "object" || Array.isArray(projectile)) {
      throw new TypeError(`${label}.projectile is invalid`);
    }
    const nested = checkedProjectileIdentity(projectile.projectileIdentity,
      `${label}.projectile.projectileIdentity`);
    if (canonical(nested) !== canonical(identity)) {
      throw new TypeError(`${label}.projectile identity does not match its event identity`);
    }
    for (const [key, expected] of [
      ["attackSequence", identity.attackSequence],
      ["direction", identity.direction],
      ["projectileId", identity.projectileId],
      ["sourceId", identity.sourceId],
      ["projectileScope", identity.direction],
      ["id", identity.projectileId],
      ["attackerId", identity.sourceId],
    ]) {
      if (!Object.hasOwn(projectile, key) || projectile[key] !== expected) {
        throw new TypeError(`${label}.projectile.${key} does not match its identity`);
      }
    }
  }
  return withIdentity(event, identity);
}

function isProjectileEvent(event) {
  return event.type === "projectile-launch" ||
    event.type === "projectile-impact" ||
    event.projectileId !== undefined ||
    event.externalProjectileId !== undefined ||
    event.projectile !== undefined ||
    (event.delivery === "projectile" && [
      "attack", "damage", "external-structure-attack", "external-structure-contact",
      "external-unit-contact",
    ].includes(event.type));
}

function validateCombatEvents(combatEvents) {
  return combatEvents.map((event) => isProjectileEvent(event)
    ? strictProjectileEvent(event, "battle combat event")
    : event);
}

function unifiedEvents(combatEvents, towerEvents, shots) {
  const validatedCombat = validateCombatEvents(combatEvents);
  const nonShotTowerEvents = towerEvents.filter(({ type }) => type !== "shot-ready");
  const phase = (event) => {
    if (event.type === "tower-activated" || event.type === "tower-destroyed") return 1;
    if (event.type === "tower-projectile-launch") return 2;
    if (event.type === "external-unit-contact") return 3;
    if (event.type === "damage" || event.type === "death") return 4;
    return 0;
  };
  return [...validatedCombat, ...nonShotTowerEvents, ...shots]
    .map((event, index) => ({ event, index, phase: phase(event) }))
    .sort((left, right) => left.phase - right.phase || left.index - right.index)
    .map(({ event }) => event);
}

/**
 * One deterministic authority boundary joining ordinary units and crown towers.
 * BattleCombat remains the sole unit-health authority; CrownTowerBattle remains
 * the sole tower-health authority. A preview is discarded and exists only to
 * discover same-boundary structure contacts before either authority commits.
 */
class BattleTowerCombat {
  #combat;
  #childrenOpaque;
  #events;
  #history;
  #historyCount;
  #isContinuation;
  #setup;
  #towers;

  constructor(value) {
    runtimeInstances.add(this);
    const setup = exactMeleeAreaSetup(
      value,
      ["initialWindupTicks", "units"],
      "battle tower setup",
    );
    preflightUnitIds(setup.units);
    this.#combat = new BattleCombat({ units: setup.units,
      ...(Object.hasOwn(setup, "meleeAreaPolicies")
        ? { meleeAreaPolicies: setup.meleeAreaPolicies } : {}) });
    const canonicalSetup = canonicalMeleeTowerSetup(setup, setup.units, "battle tower setup");
    this.#towers = new CrownTowerBattle({
      initialWindupTicks: setup.initialWindupTicks,
    });
    this.#setup = clone(canonicalSetup);
    this.#history = [];
    this.#historyCount = 0;
    this.#isContinuation = false;
    this.#childrenOpaque = false;
    this.#events = clone(this.#combat.replay);
    this.#assertSynchronized();
  }

  // Compact child handles are never public objects. This owner resolves them
  // only through the lexical weak-map capability passed to this factory.
  #combatRuntime() {
    return this.#childrenOpaque ? resolveBattleCombat(this.#combat) : this.#combat;
  }

  #towerRuntime() {
    return this.#childrenOpaque ? resolveCrownTower(this.#towers) : this.#towers;
  }

  get state() {
    this.#assertSynchronized();
    const combat = this.#combatRuntime().state;
    const towers = this.#towerRuntime().state;
    return freeze({
      activationHistory: clone(towers.activationHistory),
      pendingSpawns: clone(combat.pendingSpawns),
      projectiles: clone(combat.projectiles),
      tick: combat.tick,
      towers: clone(towers.towers),
      units: clone(combat.units),
    });
  }

  // This remains lexical-only through defineBattleTowers(). GameSession needs
  // this narrow read for its independent tower-evidence witness, not the
  // complete public combat projection (which also clones every unit).
  #towerSnapshot() {
    this.#assertSynchronized();
    return clone(this.#towerRuntime().state.towers);
  }

  get replay() {
    this.#assertPublicTranscript();
    return freeze(clone(this.#events));
  }

  /** The unit combat authority owns the closed visual transcript. */
  get combatEffectFeed() {
    return this.#combatRuntime().combatEffectFeed;
  }

  get effectFeed() {
    return this.combatEffectFeed;
  }

  get visualFeed() {
    return this.combatEffectFeed;
  }

  combatEffectFeedBytes() {
    return this.#combatRuntime().combatEffectFeedBytes();
  }

  /** Returns an independent transactional continuation without history replay. */
  fork() {
    this.#assertPublicTranscript();
    return this.#runtimeClone();
  }

  /** Internal composite checkpoint. Public history remains owned by the caller. */
  static {
    compact = (value) => value.#runtimeClone(false);
    towerSnapshot = (value) => {
      if (!runtimeInstances.has(value)) {
        throw new TypeError("internal defineBattleTowers tower snapshot receiver is invalid");
      }
      return value.#towerSnapshot();
    };
    recordStructureContacts = (value, hits, tick, events) => {
      if (!runtimeInstances.has(value)) {
        throw new TypeError("internal defineBattleTowers structure contact receiver is invalid");
      }
      recordCombatStructureContacts(value.#combatRuntime(), hits, tick, events);
    };
  }
  spawn(command) {
    this.#reserveHistory();
    this.#assertUnitId(command);
    const event = this.#combatRuntime().spawn(command);
    this.#appendHistory({ command: clone(command), type: "spawn" });
    this.#events.push(clone(event));
    return freeze(clone(event));
  }

  scheduleSpawn(command) {
    this.#reserveHistory();
    this.#assertUnitId(command);
    const scheduled = this.#combatRuntime().scheduleSpawn(command);
    this.#appendHistory({ command: clone(command), type: "schedule-spawn" });
    const event = { id: scheduled.id, tick: this.#combatRuntime().state.tick,
      toTick: scheduled.tick, type: "schedule-spawn" };
    this.#events.push(event);
    return freeze(clone(scheduled));
  }

  updatePosition(command) {
    this.#reserveHistory();
    const event = this.#combatRuntime().updatePosition(command);
    this.#appendHistory({ command: clone(command), type: "position" });
    this.#events.push(clone(event));
    return freeze(clone(event));
  }

  updatePositions(command) {
    this.#reserveHistory();
    const events = this.#combatRuntime().updatePositions(command);
    this.#appendHistory({ command: clone(command), type: "positions" });
    this.#events.push(...clone(events));
    return freeze(clone(events));
  }

  /** Adds the resolved spell ring to the unit combat visual transcript. */
  recordSpellAreaImpact(command) {
    const checked = checkedAreaImpact(command, this.state.tick, MAX_TICK);
    this.#reserveHistory();
    this.#combatRuntime().recordAreaImpact(checked);
    this.#appendHistory({ command: clone(checked), type: "spell-area-impact" });
    return freeze(clone(checked));
  }

  step(tick = this.state.tick) {
    integer(tick, 0, MAX_TICK, "battle tower step tick");
    if (tick !== this.state.tick) {
      throw new RangeError("battle tower step tick must equal the current tick");
    }
    if (this.#historyCount >= MAX_HISTORY) {
      throw new RangeError("battle tower history bound exceeded");
    }
    return freeze(clone(this.#advance()));
  }

  /**
   * Applies already-admitted LiveBattle effect ingress at this shared combat
   * boundary. Unit and tower health remain owned by the two child authorities.
   */
  stepWithEffects(tick, effects) {
    integer(tick, 0, MAX_TICK, "battle tower effect step tick");
    if (tick !== this.state.tick) {
      throw new RangeError("battle tower effect step tick must equal the current tick");
    }
    if (this.#historyCount >= MAX_HISTORY) {
      throw new RangeError("battle tower history bound exceeded");
    }
    const checked = checkedEffects(effects);
    const external = {
      externalHits: checked.unitHits.map(({ damage, sourceId, targetUnitId }) => ({
        damage, delivery: "melee", sourceId, targetUnitId,
      })),
      externalProjectiles: [],
      externalTowerHits: [],
      structures: [],
      tick,
    };
    return freeze(clone(this.#advance(external, "effect-step", checked)));
  }

  /**
   * One host-owned boundary with data-only external structures and already
   * validated building contacts. BattleCombat remains the unit authority and
   * CrownTowerBattle remains the tower authority; this adapter only joins the
   * shared tick so neither can be advanced out of order.
   */
  stepBoundary(command) {
    if (this.#historyCount >= MAX_HISTORY) {
      throw new RangeError("battle tower history bound exceeded");
    }
    const checked = checkedBuildingBoundary(command, this.state.tick);
    const towerStructures = structuresFrom(this.#towerRuntime().state.towers);
    const structureIds = new Set(towerStructures.map(({ id }) => id));
    const structureNames = new Set(towerStructures.map(({ structureId }) => structureId));
    for (const structure of checked.structures) {
      if (structureIds.has(structure.id) || structureNames.has(structure.structureId)) {
        throw new RangeError("battle tower external structure identity collides with a crown tower");
      }
      structureIds.add(structure.id);
      structureNames.add(structure.structureId);
    }
    // Validate the complete unit ingress and external structure graph before
    // touching either live child authority.
    this.#combatRuntime().previewBoundary({ externalHits: checked.externalHits,
      externalProjectiles: checked.externalProjectiles,
      structures: [...towerStructures, ...checked.structures], tick: checked.tick,
      ...(checked.unitControls === undefined ? {} : {
        unitControls: checked.unitControls, unitHeals: checked.unitHeals,
      }) });
    this.#towerRuntime().previewLive({ candidates: candidatesFrom(this.#combatRuntime(),
      checked.unitControls ?? []),
      damage: checked.externalTowerHits.map(({ amount, towerId }) => ({ amount, towerId })) });
    return freeze(clone(this.#advance(checked, "boundary")));
  }

  stepMany(ticks) {
    integer(ticks, 0, MAX_BATTLE_TOWER_STEP_TICKS, "battle tower step ticks");
    if (this.state.tick + ticks > MAX_TICK) {
      throw new RangeError("battle tower tick bound exceeded");
    }
    if (this.#historyCount + ticks > MAX_HISTORY) {
      throw new RangeError("battle tower history bound exceeded");
    }
    const candidate = this.#runtimeClone();
    const events = [];
    for (let count = 0; count < ticks; count += 1) {
      events.push(...candidate.#advance());
    }
    this.#adopt(candidate);
    return freeze(clone(events));
  }

  serialize() {
    this.#assertPublicTranscript();
    const hasEffects = this.#history.some(({ type }) => type === "effect-step");
    if (hasEffects || this.#history.length > EXPLICIT_HISTORY_TAIL) {
      const tailStart = Math.max(0, this.#history.length - EXPLICIT_HISTORY_TAIL);
      const serialized = canonical({ history: this.#history.slice(tailStart), setup: this.#setup,
        transcript: compactTowerHistory(this.#history.slice(0, tailStart)), version: hasEffects ? 4 : 3 });
      if (new TextEncoder().encode(serialized).byteLength > MAX_SNAPSHOT_BYTES) {
        throw new RangeError("serialized battle tower combat exceeds the byte bound");
      }
      return serialized;
    }
    const serialized = canonical({
      combat: this.#combatRuntime().serialize(),
      history: this.#history,
      setup: this.#setup,
      towers: this.#towerRuntime().serialize(),
      version: 2,
    });
    if (new TextEncoder().encode(serialized).byteLength > MAX_SNAPSHOT_BYTES) {
      throw new RangeError("serialized battle tower combat exceeds the byte bound");
    }
    return serialized;
  }

  static restore(serialized) {
    if (typeof serialized !== "string") {
      throw new TypeError("serialized battle tower combat must be a string");
    }
    if (new TextEncoder().encode(serialized).byteLength > MAX_SNAPSHOT_BYTES) {
      throw new RangeError("serialized battle tower combat exceeds the byte bound");
    }
    let snapshot;
    try { snapshot = JSON.parse(serialized); }
    catch { throw new TypeError("serialized battle tower combat must be valid JSON"); }
    if (canonical(snapshot) !== serialized) {
      throw new TypeError("serialized battle tower combat must be canonical JSON");
    }
    if (snapshot.version === 3 || snapshot.version === 4) {
      const hasEffects = snapshot.version === 4;
      const checked = exact(snapshot, ["history", "setup", "transcript", "version"],
        "battle tower snapshot");
      const history = denseArray(checked.history, "battle tower snapshot.history");
      const transcript = denseArray(checked.transcript, "battle tower snapshot.transcript");
      const restored = new BattleTowerCombat(
        exactMeleeAreaSetup(checked.setup, ["initialWindupTicks", "units"], "snapshot setup"));
      let operations = history.length;
      const replay = (operation, index, label) => {
        plain(operation, `${label}[${index}]`);
        if (operation.type === "spawn") restored.spawn(exact(operation,
          ["command", "type"], `${label}[${index}]`).command);
        else if (operation.type === "schedule-spawn") restored.scheduleSpawn(exact(operation,
          ["command", "type"], `${label}[${index}]`).command);
        else if (operation.type === "position") restored.updatePosition(exact(operation,
          ["command", "type"], `${label}[${index}]`).command);
        else if (operation.type === "positions") restored.updatePositions(exact(operation,
          ["command", "type"], `${label}[${index}]`).command);
        else if (operation.type === "spell-area-impact") restored.recordSpellAreaImpact(exact(operation,
          ["command", "type"], `${label}[${index}]`).command);
        else if (operation.type === "boundary") restored.stepBoundary(exact(operation,
          ["command", "type"], `${label}[${index}]`).command);
        else if (operation.type === "effect-step") {
          if (!hasEffects) throw new TypeError("legacy battle tower snapshot cannot contain effects");
          const entry = exact(operation, ["effects", "tick", "type"], `${label}[${index}]`);
          if (entry.tick !== restored.state.tick) {
            throw new TypeError("noncausal battle tower effect history");
          }
          restored.stepWithEffects(entry.tick, checkedEffects(entry.effects));
        }
        else if (operation.type === "step") {
          const entry = exact(operation, ["tick", "type"], `${label}[${index}]`);
          if (entry.tick !== restored.state.tick) throw new TypeError("noncausal battle tower step history");
          restored.#advance();
        } else throw new TypeError(`battle tower snapshot.${label}[${index}] is invalid`);
      };
      for (const [index, record] of transcript.entries()) {
        plain(record, `battle tower snapshot.transcript[${index}]`);
        if (record.type === "step-run") {
          const run = exact(record, ["tick", "ticks", "type"], `transcript[${index}]`);
          const ticks = integer(run.ticks, 1, MAX_HISTORY, `transcript[${index}].ticks`);
          if (run.tick !== restored.state.tick) throw new TypeError("noncausal battle tower step run");
          if (ticks > MAX_HISTORY - operations) throw new RangeError("battle tower history bound exceeded");
          for (let count = 0; count < ticks; count += 1) restored.#advance();
          operations += ticks;
        } else if (record.type === "position-step-run") {
          const run = exact(record, ["positions", "tick", "ticks", "type", "velocity"],
            `transcript[${index}]`);
          const ticks = integer(run.ticks, 1, MAX_HISTORY, `transcript[${index}].ticks`);
          const positions = denseArray(run.positions, `transcript[${index}].positions`, 1_024);
          const velocity = denseArray(run.velocity, `transcript[${index}].velocity`, 1_024)
            .map((entry, velocityIndex) => exact(entry, ["dx", "dy", "id"],
              `transcript[${index}].velocity[${velocityIndex}]`));
          if (positions.length !== velocity.length || velocity.some((entry, velocityIndex) =>
            entry.id !== positions[velocityIndex]?.id) || run.tick !== restored.state.tick) {
            throw new TypeError("battle tower position-step run identities diverge");
          }
          if (ticks * 2 > MAX_HISTORY - operations) throw new RangeError("battle tower history bound exceeded");
          let current = clone(positions);
          for (let count = 0; count < ticks; count += 1) {
            restored.updatePositions({ positions: current, tick: run.tick + count });
            restored.#advance(); current = applyVelocity(current, velocity);
          }
          operations += ticks * 2;
        } else { replay(record, index, "transcript"); operations += 1; }
      }
      for (const [index, operation] of history.entries()) replay(operation, index, "history");
      if (hasEffects && !restored.#history.some(({ type }) => type === "effect-step")) {
        throw new TypeError("battle tower effect snapshot lacks an effect boundary");
      }
      if (restored.serialize() !== serialized) {
        throw new TypeError("battle tower snapshot witnesses are not causal");
      }
      return restored;
    }
    const checked = exact(snapshot, ["combat", "history", "setup", "towers", "version"],
      "battle tower snapshot");
    if (checked.version !== 1 && checked.version !== 2) {
      throw new TypeError("unsupported battle tower snapshot version");
    }
    const combatWitness = BattleCombat.restore(checked.combat);
    const combatSnapshot = JSON.parse(checked.combat);
    if (combatSnapshot.version !== checked.version) {
      throw new TypeError("battle tower and combat snapshot versions are mixed");
    }
    const setup = checked.version === 1
      ? exact(checked.setup, ["initialWindupTicks", "units"], "snapshot setup")
      : exactMeleeAreaSetup(checked.setup, ["initialWindupTicks", "units"], "snapshot setup");
    const history = denseArray(checked.history, "battle tower snapshot.history");
    const restored = new BattleTowerCombat(setup);
    for (let index = 0; index < history.length; index += 1) {
      const operation = history[index];
      plain(operation, `battle tower snapshot.history[${index}]`);
      if (operation.type === "spawn") {
        const entry = exact(operation, ["command", "type"], `history[${index}]`);
        restored.spawn(entry.command);
      } else if (operation.type === "schedule-spawn") {
        const entry = exact(operation, ["command", "type"], `history[${index}]`);
        restored.scheduleSpawn(entry.command);
      } else if (operation.type === "position") {
        const entry = exact(operation, ["command", "type"], `history[${index}]`);
        restored.updatePosition(entry.command);
      } else if (operation.type === "positions") {
        const entry = exact(operation, ["command", "type"], `history[${index}]`);
        restored.updatePositions(entry.command);
      } else if (operation.type === "spell-area-impact") {
        const entry = exact(operation, ["command", "type"], `history[${index}]`);
        restored.recordSpellAreaImpact(entry.command);
      } else if (operation.type === "boundary") {
        const entry = exact(operation, ["command", "type"], `history[${index}]`);
        restored.stepBoundary(entry.command);
      } else if (operation.type === "step") {
        const entry = exact(operation, ["tick", "type"], `history[${index}]`);
        if (entry.tick !== restored.state.tick) {
          throw new TypeError("noncausal battle tower step history");
        }
        restored.#advance();
      } else {
        throw new TypeError(`battle tower snapshot.history[${index}] is invalid`);
      }
    }
    const combatWitnessMatches = checked.version === 2
      ? restored.#combatRuntime().serialize() === checked.combat
      : BattleCombat.continuationEquivalent(combatWitness, restored.#combatRuntime());
    if (!combatWitnessMatches || restored.#towerRuntime().serialize() !== checked.towers ||
        (checked.version === 2 && restored.serialize() !== serialized)) {
      throw new TypeError("battle tower snapshot witnesses are not causal");
    }
    return restored;
  }

  #advance(external = null, historyType = "step", effectWitness = null) {
    this.#assertSynchronized();
    const combat = this.#combatRuntime();
    const towers = this.#towerRuntime();
    const tick = battleCombatCurrentTick(combat);
    const checkedExternal = external === null ? {
      externalHits: [], externalProjectiles: [], externalTowerHits: [], structures: [], tick,
    } : external;
    if (checkedExternal.tick !== tick) {
      throw new RangeError("battle tower boundary is not current");
    }
    const towerStructures = structuresFrom(towers.state.towers);
    const structures = [...towerStructures, ...checkedExternal.structures];
    const candidates = candidatesFrom(combat, checkedExternal.unitControls ?? []);
    const statusIngress = checkedExternal.unitControls === undefined ? {} : {
      unitControls: checkedExternal.unitControls,
      unitHeals: checkedExternal.unitHeals,
    };

    const previewEvents = combat.previewBoundary({
      externalHits: checkedExternal.externalHits,
      externalProjectiles: checkedExternal.externalProjectiles,
      structures,
      tick,
      ...statusIngress,
    });
    const towerInput = {
      candidates,
      damage: [...towerDamageFrom(previewEvents), ...checkedExternal.externalTowerHits
        .map(({ amount, towerId }) => ({ amount, towerId }))],
    };
    const towerEvents = towers.previewLive(towerInput);
    const ready = towerEvents.filter(({ type }) => type === "shot-ready");
    const shots = ready.map((shot) => withIdentity({
      attackSequence: shot.attackSequence ?? shot.sequence,
      damage: shot.damage,
      delivery: shot.delivery,
      projectileId: shot.projectileId,
      sourceId: shot.sourceId,
      sourceSide: shot.sourceSide,
      targetSide: shot.targetSide,
      targetUnitId: shot.targetId,
      tick,
      towerId: shot.towerId,
      type: "tower-projectile-launch",
    }, shot.projectileIdentity));
    const ingresses = shots.map((shot) => ({
      command: projectileFor(shot),
      identity: clone(shot.projectileIdentity),
    }));
    const combatInput = {
      externalHits: checkedExternal.externalHits,
      externalProjectiles: [...checkedExternal.externalProjectiles,
        ...ingresses.map(({ command }) => command)],
      structures,
      tick,
      ...statusIngress,
    };
    const combatEvents = combat.previewBoundary(combatInput);
    const actualDamage = towerDamageFrom(combatEvents);
    if (canonical(actualDamage) !== canonical(towerDamageFrom(previewEvents))) {
      throw new TypeError("battle tower preview diverged from committed structure contacts");
    }

    towers.stepLive(towerInput);
    combat.stepBoundaryAfterPreview(combatInput, combatEvents);
    if (historyType === "step") {
      this.#appendHistory({ tick, type: "step" });
    } else if (historyType === "effect-step") {
      this.#appendHistory({ effects: clone(effectWitness), tick, type: "effect-step" });
    } else {
      this.#appendHistory({ command: clone(checkedExternal), type: "boundary" });
    }
    const events = unifiedEvents(combatEvents, towerEvents, shots);
    for (const hit of checkedExternal.externalTowerHits) {
      events.push({ damage: hit.amount, delivery: "building", sourceId: hit.sourceId,
        structureId: hit.towerId, tick, type: "external-structure-contact" });
    }
    this.#events.push(...clone(events));
    this.#assertSynchronized();
    return events;
  }

  #assertSynchronized() {
    if (battleCombatCurrentTick(this.#combatRuntime()) !==
        crownTowerCurrentTick(this.#towerRuntime())) {
      throw new TypeError("battle combat and crown towers are not tick-synchronized");
    }
  }

  #assertUnitId(command) {
    const descriptors = plain(command, "battle tower unit command");
    const id = descriptors.id?.value;
    if (TOWER_NUMERIC_IDS.has(id)) {
      throw new RangeError("unit ID is reserved for a crown tower structure");
    }
  }

  #reserveHistory() {
    if (this.#historyCount >= MAX_HISTORY) {
      throw new RangeError("battle tower history bound exceeded");
    }
  }

  #appendHistory(operation) {
    this.#history.push(operation);
    this.#historyCount += 1;
  }

  #assertPublicTranscript() {
    if (this.#isContinuation) {
      throw new TypeError("internal battle tower continuation cannot expose a public transcript");
    }
  }

  #runtimeClone(includeTranscript = true) {
    const candidate = new BattleTowerCombat(this.#setup);
    const retainTranscript = includeTranscript && !this.#isContinuation;
    const checkpointed = !retainTranscript || this.#history.length > EXPLICIT_HISTORY_TAIL;
    const combat = this.#combatRuntime();
    const towers = this.#towerRuntime();
    candidate.#combat = checkpointed ? battleCombatCompactClone(combat) : combat.fork();
    candidate.#towers = checkpointed ? crownTowerCompactClone(towers) : towers.fork();
    candidate.#events = retainTranscript ? [...this.#events] : [];
    candidate.#history = retainTranscript ? [...this.#history] : [];
    candidate.#historyCount = this.#historyCount;
    candidate.#isContinuation = !retainTranscript;
    candidate.#childrenOpaque = checkpointed;
    candidate.#setup = clone(this.#setup);
    return candidate;
  }

  #adopt(candidate) {
    this.#combat = candidate.#combat;
    this.#towers = candidate.#towers;
    this.#events = candidate.#events;
    this.#history = candidate.#history;
    this.#historyCount = candidate.#historyCount;
    this.#isContinuation = candidate.#isContinuation;
    this.#childrenOpaque = candidate.#childrenOpaque;
    this.#setup = candidate.#setup;
  }
}

const IntegratedBattleTowers = BattleTowerCombat;
  opaqueContinuation((value) => {
    if (!runtimeInstances.has(value)) {
      throw new TypeError("internal defineBattleTowers continuation receiver is invalid");
    }
    return compact(value);
  }, registerCompact);
  function towerCandidateGeometry(tower) {
    if (tower === null || typeof tower !== "object" ||
        !TOWER_TEXT_IDS.has(tower.id) || !Object.hasOwn(TOWER_FOOTPRINT_RADII, tower.role)) {
      throw new TypeError("canonical crown tower candidate is invalid");
    }
    return {
      hostId: TOWER_IDS.get(tower.id),
      radius: TOWER_FOOTPRINT_RADII[tower.role],
    };
  }

  return { BattleTowerCombat, IntegratedBattleTowers, MAX_BATTLE_TOWER_STEP_TICKS,
    recordStructureContacts, towerCandidateGeometry, towerSnapshot };
}

function defineLiveBattle(BattleMovement, BattleTowerCombat, battleMovementCompactClone,
  resolveBattleMovement, battleTowerCompactClone, resolveBattleTower, battleTowerSnapshot,
  battleTowerRecordStructureContacts, battleTowerCandidateGeometry, registerCompact) {
  let compact, towerSnapshot, advanceFromSession, combatEffectFeed;
  const runtimeInstances = new WeakSet();

const MAX_LIVE_BATTLE_STEP_TICKS = 18_000;
const MAX_LIVE_BATTLE_DEPLOYMENTS = 1_024;
const MAX_LIVE_BATTLE_TROOP_ACTIONS = 1_024;
const MAX_LIVE_BATTLE_UNITS = 1_024;
const MAX_LIVE_BATTLE_STRUCTURES = SESSION_BUILDING_MAX_STRUCTURES;

const MAX_HISTORY = 100_000;
const EXPLICIT_HISTORY_TAIL = 256;
const MAX_SNAPSHOT_BYTES = 8_388_608;
const MAX_SETUP_BYTES = 1_048_576;
const MAX_COMMAND_BYTES = 16_384;
const MAX_SETUP_DEPTH = 32;
const MAX_SETUP_NODES = 10_000;
const ADMITTED_SETUPS = new WeakSet();
const SETUP_GRAPH_LIMITS = Object.freeze({
  arrayLength: 1_024,
  containers: 2_048,
  depth: MAX_SETUP_DEPTH,
  keys: 64,
  nodes: MAX_SETUP_NODES,
  stringLength: 256,
});
const SNAPSHOT_GRAPH_LIMITS = Object.freeze({
  arrayLength: 200_000,
  containers: 100_000,
  depth: 128,
  keys: 1_024,
  nodes: 200_000,
  stringLength: 4_194_304,
});
const COMMAND_GRAPH_LIMITS = Object.freeze({
  arrayLength: 16,
  containers: 16,
  depth: 8,
  keys: 16,
  nodes: 64,
  stringLength: 256,
});
const SIDES = new Set(["north", "south"]);
const DEPLOY_KEYS = ["cardId", "point", "sequence", "side", "tick"];
const STRUCTURE_DEPLOY_KEYS = ["cardId", "destination", "point", "sequence", "side", "tick"];
const TROOP_ACTION_KEYS = [
  "actionId", "commandId", "point", "side", "sourceId", "targetId", "tick", "type",
];
const TROOP_INTENT_KEYS = [
  "actionId", "cardId", "commandId", "kind", "phase", "point", "sourceId", "targetId",
  "side", "tick", "type",
];
const CURRENT_TROOP_CONTACT_INTENT_KEYS = [
  "attackSequence", "cardId", "kind", "phase", "side", "sourceId", "targetId", "tick", "type",
];
const TROOP_MOVEMENT_INTENT_KEYS = [
  "cardId", "claimFamily", "kind", "layer", "pathScope", "phase", "side", "sourceId", "tick", "type",
];
const TROOP_STATUS_KEYS = [
  "actionId", "cardId", "commandId", "key", "kind", "phase", "point", "sourceId",
  "side", "targetId", "tick",
];
const REPRESENTATIVE_TROOP_STATUS_KEYS = [
  "actionId", "cardId", "commandId", "damage", "delivery", "effect", "externalSourceId",
  "key", "kind", "phase", "point", "sourceId", "side", "targetId", "tick",
];
const CURRENT_TROOP_CONTACT_STATUS_KEYS = [
  "attackSequence", "cardId", "contactId", "damage", "delivery", "effect", "hostSourceIdentity",
  "key", "kind", "phase", "provenance", "side", "sourceId", "sourceProfile", "targetId", "tick",
];
const TROOP_PHASES = new Set(["combat", "deploy", "pre-move", "pre-combat", "post-combat"]);
const TROOP_INTENT_KINDS = new Set(["action", "contact", "deploy", "pass"]);
const TROOP_REPRESENTATIVE_EFFECTS = new Set(["source-melee-contact"]);
const CURRENT_TROOP_CONTACT_EFFECT = "ordinary-live-contact";
const TROOP_STATUS_LIMIT = MAX_LIVE_BATTLE_UNITS * 5;
const SETUP_KEYS = ["initialWindupTicks", "questions", "roster"];
const SPELL_SETUP_KEYS = [...SETUP_KEYS, "spellProfileReceipts"];
const CARD_KEYS = [
  "areaDamageRadiusMillitiles", "cost", "count", "damage", "deployTimeTicks",
  "displayName", "entities", "firstHitTicks", "formation", "hitSpeedTicks",
  "hitpoints", "id", "kind", "movementMillitilesPerSecond", "rangeMillitiles",
  "rarity", "sightRangeMillitiles", "targetMode",
];
const STRUCTURE_CARD_KEYS = [...CARD_KEYS, "buildingRuntime"];
const MAX_PENDING_BUILDING_HITS = SESSION_BUILDING_MAX_INTENTS;
const ENTITY_KEYS = [
  "archetypeId", "areaDamageRadiusMillitiles", "bodyRadiusPolicy", "count",
  "damage", "delivery", "deployTimeTicks", "displayName", "firstHitTicks",
  "hitSpeedTicks", "hitpoints", "kind", "layer",
  "movementMillitilesPerSecond", "projectileSpeedPolicy", "rangeMillitiles",
  "role", "sightRangeMillitiles", "targetMode",
];
const ENTITY_ORDINARY_POLICY_KEYS = ["deliveryPolicy", "layerPolicy"];
const ENTITY_DAMAGE_POLICY_KEYS = ["damagePolicy"];
const ENTITY_SOURCE_CONFIDENCE_KEYS = ["sourceConfidencePolicy"];
const QUESTION_KEYS = [
  "authoritative", "confidence", "disposition", "key", "source", "value",
];
const POLICY_KEYS = ["kind", "questionKey"];
const FORMATION_KEYS = ["componentOrder", "expansionOrder", "totalCount"];
const GROUND_NODES = Object.freeze(Array.from({ length: 32 }, (_, row) =>
  Array.from({ length: 18 }, (_, column) => ({
    x: column * 1_000 + 500,
    y: row * 1_000 + 500,
  }))).flat().filter((point) => isGroundNavigationNode(point))
  .map((point) => Object.freeze(point)));

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

function denseArray(value, label, maximum = MAX_HISTORY) {
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

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function freeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
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
      if (!Number.isSafeInteger(value)) {
        throw new TypeError(`${label} numbers must be safe integers`);
      }
      continue;
    }
    if (value === null || typeof value !== "object") continue;
    containers += 1;
    if (containers > limits.containers) throw new RangeError(`${label} container bound exceeded`);
    if (Array.isArray(value)) {
      if (value.length > limits.arrayLength) {
        throw new RangeError(`${label} array length bound exceeded`);
      }
    } else {
      const keys = Object.keys(value);
      if (keys.length > limits.keys) throw new RangeError(`${label} object key bound exceeded`);
      for (const key of keys) scalarString(key, limits.stringLength, `${label} key`);
    }
    for (const child of Array.isArray(value) ? value : Object.values(value)) {
      pending.push({ depth: depth + 1, value: child });
    }
  }
}

function parsedSetupBytes(serialized) {
  if (typeof serialized !== "string") {
    throw new TypeError("live battle setup must be canonical JSON text or an admitted snapshot");
  }
  if (new TextEncoder().encode(serialized).byteLength > MAX_SETUP_BYTES) {
    throw new RangeError("live battle setup byte bound exceeded");
  }
  let parsed;
  try { parsed = JSON.parse(serialized); }
  catch { throw new TypeError("live battle setup must be valid JSON text"); }
  preflightParsedGraph(parsed, SETUP_GRAPH_LIMITS, "live battle setup");
  if (canonical(parsed) !== serialized) {
    throw new TypeError("live battle setup must be canonical JSON text");
  }
  return parsed;
}

// Public deploy/action admission begins at canonical text, so hostile objects
// cannot trigger getters or Proxy traps before being rejected.
function parsedCommandBytes(serialized, label) {
  if (typeof serialized !== "string") {
    throw new TypeError(`${label} must be canonical JSON text`);
  }
  if (new TextEncoder().encode(serialized).byteLength > MAX_COMMAND_BYTES) {
    throw new RangeError(`${label} exceeds its byte bound`);
  }
  let parsed;
  try { parsed = JSON.parse(serialized); }
  catch { throw new TypeError(`${label} must be valid JSON text`); }
  preflightParsedGraph(parsed, COMMAND_GRAPH_LIMITS, label);
  if (canonical(parsed) !== serialized) {
    throw new TypeError(`${label} must be canonical JSON text`);
  }
  return parsed;
}

function string(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.length > 128) {
    throw new TypeError(`${label} must be a bounded non-empty primitive string`);
  }
  return value;
}

function identity(value, displayName, label) {
  const checked = string(value, label);
  const display = string(displayName, `${label} display name`);
  if (!/^[A-Za-z0-9]+(?: [A-Za-z0-9]+)*$/u.test(display)) {
    throw new TypeError(`${label} display name cannot form a canonical identity`);
  }
  const derived = display.toLowerCase().replaceAll(" ", "-");
  if (checked !== derived) {
    throw new TypeError(`${label} must be the canonical identity of its display name`);
  }
  return checked;
}

function nonnegative(value, label) {
  return integer(value, 0, Number.MAX_SAFE_INTEGER, label);
}

function nullableNonnegative(value, label) {
  return value === null ? null : nonnegative(value, label);
}

function checkedPolicy(value, label, { projectile = false } = {}) {
  const policy = exact(value, POLICY_KEYS, label);
  if (policy.kind === "not-applicable" && projectile && policy.questionKey === null) {
    return { kind: policy.kind, questionKey: null };
  }
  if (policy.kind !== "question") throw new TypeError(`${label}.kind is invalid`);
  return { kind: policy.kind, questionKey: string(policy.questionKey, `${label}.questionKey`) };
}

function checkedSetup(value, { legacyStructureReceipts = false } = {}) {
  const descriptors = plain(value, "live battle setup");
  const actual = Reflect.ownKeys(descriptors).sort();
  const hasSpellProfiles = actual.includes("spellProfileReceipts");
  const hasChainQuestionPolicy = actual.includes("chainQuestionPolicy");
  const expected = [
    ...SETUP_KEYS,
    ...(hasSpellProfiles ? ["spellProfileReceipts"] : []),
    ...(hasChainQuestionPolicy ? ["chainQuestionPolicy"] : []),
  ];
  if (actual.length !== expected.length || actual.some((key, index) =>
    key !== [...expected].sort()[index])) {
    throw new TypeError("live battle setup has an invalid shape");
  }
  const setup = Object.fromEntries(expected.map((key) => [key, descriptors[key].value]));
  const chainQuestionPolicy = hasChainQuestionPolicy
    ? admitStormkiteChainQuestionPolicy(setup.chainQuestionPolicy)
    : null;
  const windups = exact(setup.initialWindupTicks, ["central", "lane"],
    "live battle setup.initialWindupTicks");
  const initialWindupTicks = {
    central: nonnegative(windups.central, "live battle setup.initialWindupTicks.central"),
    lane: nonnegative(windups.lane, "live battle setup.initialWindupTicks.lane"),
  };
  const questions = denseArray(setup.questions, "live battle setup.questions", 256)
    .map((value, index) => {
      const record = exact(value, QUESTION_KEYS, `live battle setup.questions[${index}]`);
      if (record.authoritative !== false || record.disposition !== "question") {
        throw new TypeError(`live battle setup.questions[${index}] must be non-authoritative`);
      }
      const key = string(record.key, `questions[${index}].key`);
      return {
        authoritative: false,
        confidence: string(record.confidence, `questions[${index}].confidence`),
        disposition: "question",
        key,
        source: string(record.source, `questions[${index}].source`),
        value: integer(record.value,
          sessionTroopSourceQuestionMinimum(key),
          Number.MAX_SAFE_INTEGER, `questions[${index}].value`),
      };
    });
  if (new Set(questions.map(({ key }) => key)).size !== questions.length) {
    throw new TypeError("live battle setup question keys must be unique");
  }
  const questionKeys = new Set(questions.map(({ key }) => key));
  const questionValues = new Map(questions.map(({ key, value: answer }) => [key, answer]));
  const questionSources = new Map(questions.map(({ key, source }) => [key, source]));
  const referencedQuestionKeys = new Set();
  const roster = denseArray(setup.roster, "live battle setup.roster", 8)
    .map((value, cardIndex) => {
      const hasBuildingRuntime = value !== null && typeof value === "object" &&
        !Array.isArray(value) && Object.hasOwn(value, "buildingRuntime");
      const card = exact(value, value?.kind === "structure" && hasBuildingRuntime
        ? STRUCTURE_CARD_KEYS : CARD_KEYS, `live battle setup.roster[${cardIndex}]`);
      const cardKind = string(card.kind, `roster[${cardIndex}].kind`);
      if (!["effect", "structure", "unit"].includes(cardKind)) {
        throw new TypeError(`roster[${cardIndex}].kind is invalid`);
      }
      // Fresh HBA setup always carries the receipt needed to materialize a
      // structure. Pre-HBA route-only structures are accepted only by the
      // explicit versioned-restore path below.
      if (cardKind === "structure" && !hasBuildingRuntime && !legacyStructureReceipts) {
        throw new TypeError(`roster[${cardIndex}] structure lacks a canonical buildingRuntime receipt`);
      }
      const cardId = identity(card.id, card.displayName,
        `roster[${cardIndex}].id`);
      const entities = denseArray(card.entities, `roster[${cardIndex}].entities`, 16)
        .map((raw, entityIndex) => {
          const label = `roster[${cardIndex}].entities[${entityIndex}]`;
          const hasOrdinaryPolicies = raw !== null && typeof raw === "object" &&
            !Array.isArray(raw) &&
            (Object.hasOwn(raw, "deliveryPolicy") || Object.hasOwn(raw, "layerPolicy"));
          const hasDamagePolicy = raw !== null && typeof raw === "object" &&
            !Array.isArray(raw) && Object.hasOwn(raw, "damagePolicy");
          const hasSourceConfidencePolicy = raw !== null && typeof raw === "object" &&
            !Array.isArray(raw) && Object.hasOwn(raw, "sourceConfidencePolicy");
          const splashShape = ordinaryProjectileSplashEntityShape(raw, [
            ...ENTITY_KEYS,
            ...(hasOrdinaryPolicies ? ENTITY_ORDINARY_POLICY_KEYS : []),
            ...(hasDamagePolicy ? ENTITY_DAMAGE_POLICY_KEYS : []),
            ...(hasSourceConfidencePolicy ? ENTITY_SOURCE_CONFIDENCE_KEYS : []),
          ]);
          const entity = exact(raw, splashShape.keys, label);
          const archetypeId = identity(entity.archetypeId, entity.displayName,
            `${label}.archetypeId`);
          const sourceConfidencePolicy = assertSessionTroopSourceConfidenceQuestions({
            present: hasSourceConfidencePolicy,
            value: entity.sourceConfidencePolicy,
            cardId,
            archetypeId,
            entity,
            questionKeys,
            questionValues,
            questionSources,
            referencedQuestionKeys,
            label,
          });
          const bodyRadiusPolicy = checkedPolicy(entity.bodyRadiusPolicy, `${label}.bodyRadiusPolicy`);
          const projectileSpeedPolicy = checkedPolicy(
            entity.projectileSpeedPolicy, `${label}.projectileSpeedPolicy`, { projectile: true },
          );
          const deliveryPolicy = hasOrdinaryPolicies
            ? entity.deliveryPolicy?.kind === "source-backed"
              ? assertOrdinaryProjectileDeliveryPolicy(entity.deliveryPolicy, cardId,
                archetypeId, entity.delivery)
              : checkedPolicy(entity.deliveryPolicy, `${label}.deliveryPolicy`)
            : null;
          const layerPolicy = hasOrdinaryPolicies
            ? checkedPolicy(entity.layerPolicy, `${label}.layerPolicy`)
            : null;
          const damagePolicy = hasDamagePolicy
            ? checkedPolicy(entity.damagePolicy, `${label}.damagePolicy`)
            : null;
          const projectileSplashFields = splashShape.hasProfile
            ? ordinaryProjectileSplashEntityFields(entity, cardId, archetypeId, label)
            : {};
          for (const policy of [bodyRadiusPolicy, projectileSpeedPolicy]) {
            if (policy.kind === "question" && !questionKeys.has(policy.questionKey)) {
              throw new TypeError(`${label} has an unresolved question policy`);
            }
            if (policy.kind === "question") referencedQuestionKeys.add(policy.questionKey);
          }
          if (!["melee", "projectile"].includes(entity.delivery) ||
              !["air", "ground"].includes(entity.layer)) {
            throw new TypeError(`${label} has an invalid delivery or layer`);
          }
          if ((entity.delivery === "projectile") !==
              (projectileSpeedPolicy.kind === "question") || entity.kind !== "unit" ||
              !["buildings", "ground", "ground-and-air", "structures"].includes(entity.targetMode)) {
            throw new TypeError(`${label} has inconsistent combat metadata`);
          }
          const expectedBodyKey = `${archetypeId}.body-radius-millitiles`;
          const expectedProjectileKey = `${archetypeId}.projectile-speed-millitiles-per-tick`;
          if (bodyRadiusPolicy.questionKey !== expectedBodyKey ||
              (projectileSpeedPolicy.kind === "question" &&
                projectileSpeedPolicy.questionKey !== expectedProjectileKey)) {
            throw new TypeError(`${label} policy identities are inconsistent with its archetype`);
          }
          if (hasOrdinaryPolicies) {
            const expectedLayerKey = `${archetypeId}.layer`;
            if (layerPolicy.kind !== "question" ||
                layerPolicy.questionKey !== expectedLayerKey ||
                !questionKeys.has(layerPolicy.questionKey)) {
              throw new TypeError(`${label} ordinary runtime policies are unresolved`);
            }
            referencedQuestionKeys.add(layerPolicy.questionKey);
            const layerAnswer = questionValues.get(layerPolicy.questionKey);
            const expectedLayer = layerAnswer === 1 ? "ground" :
              layerAnswer === 2 ? "air" : null;
            if (expectedLayer === null || entity.layer !== expectedLayer) {
              throw new TypeError(`${label} ordinary runtime policies disagree with estimates`);
            }
            if (deliveryPolicy.kind === "question") {
              const expectedDeliveryKey = `${archetypeId}.delivery`;
              if (deliveryPolicy.questionKey !== expectedDeliveryKey ||
                  !questionKeys.has(deliveryPolicy.questionKey)) {
                throw new TypeError(`${label} ordinary runtime policies are unresolved`);
              }
              referencedQuestionKeys.add(deliveryPolicy.questionKey);
              const deliveryAnswer = questionValues.get(deliveryPolicy.questionKey);
              const expectedDelivery = deliveryAnswer === 1 ? "melee" :
                deliveryAnswer === 2 ? "projectile" : null;
              if (expectedDelivery === null || entity.delivery !== expectedDelivery) {
                throw new TypeError(`${label} ordinary runtime policies disagree with estimates`);
              }
            } else if (deliveryPolicy.kind !== "source-backed" ||
                entity.delivery !== "projectile") {
              throw new TypeError(`${label} ordinary delivery source policy is invalid`);
            }
          }
          if (hasDamagePolicy) {
            const expectedDamageKey = `${archetypeId}.damage`;
            if (damagePolicy.kind !== "question" || damagePolicy.questionKey !== expectedDamageKey ||
                !questionKeys.has(damagePolicy.questionKey) || entity.damage !== null ||
                questionValues.get(damagePolicy.questionKey) === undefined) {
              throw new TypeError(`${label} damage policy is unresolved`);
            }
            referencedQuestionKeys.add(damagePolicy.questionKey);
          }
          if (entity.role !== (entityIndex === 0 ? "primary" : "secondary")) {
            throw new TypeError(`${label}.role is inconsistent with component ownership`);
          }
          const normalizedEntity = {
            archetypeId,
            areaDamageRadiusMillitiles: nullableNonnegative(entity.areaDamageRadiusMillitiles,
              `${label}.areaDamageRadiusMillitiles`),
            bodyRadiusPolicy,
            count: integer(entity.count, 1, 64, `${label}.count`),
            damage: hasDamagePolicy ? nullableNonnegative(entity.damage, `${label}.damage`) :
              nonnegative(entity.damage, `${label}.damage`),
            delivery: entity.delivery,
            deployTimeTicks: nonnegative(entity.deployTimeTicks, `${label}.deployTimeTicks`),
            displayName: string(entity.displayName, `${label}.displayName`),
            firstHitTicks: nonnegative(entity.firstHitTicks, `${label}.firstHitTicks`),
            hitSpeedTicks: integer(entity.hitSpeedTicks, 1, Number.MAX_SAFE_INTEGER,
              `${label}.hitSpeedTicks`),
            hitpoints: integer(entity.hitpoints, 1, Number.MAX_SAFE_INTEGER, `${label}.hitpoints`),
            kind: string(entity.kind, `${label}.kind`),
            layer: entity.layer,
            movementMillitilesPerSecond: nonnegative(entity.movementMillitilesPerSecond,
              `${label}.movementMillitilesPerSecond`),
            projectileSpeedPolicy,
            rangeMillitiles: nonnegative(entity.rangeMillitiles, `${label}.rangeMillitiles`),
            role: string(entity.role, `${label}.role`),
            sightRangeMillitiles: nonnegative(entity.sightRangeMillitiles,
              `${label}.sightRangeMillitiles`),
            targetMode: string(entity.targetMode, `${label}.targetMode`),
            ...projectileSplashFields,
          };
          if (hasOrdinaryPolicies) {
            normalizedEntity.deliveryPolicy = deliveryPolicy;
            normalizedEntity.layerPolicy = layerPolicy;
          }
          if (hasDamagePolicy) normalizedEntity.damagePolicy = damagePolicy;
          if (sourceConfidencePolicy !== null) {
            normalizedEntity.sourceConfidencePolicy = sourceConfidencePolicy;
          }
          return normalizedEntity;
        });
      if ((cardKind === "unit") !== (entities.length > 0)) {
        throw new TypeError(`roster[${cardIndex}] entity inventory is inconsistent with its kind`);
      }
      const formation = exact(card.formation, FORMATION_KEYS, `roster[${cardIndex}].formation`);
      const componentOrder = denseArray(formation.componentOrder,
        `roster[${cardIndex}].formation.componentOrder`, 16)
        .map((id, index) => string(id, `formation.componentOrder[${index}]`));
      if (formation.expansionOrder !== "component-order-then-member-index" ||
          canonical(componentOrder) !== canonical(entities.map(({ archetypeId }) => archetypeId)) ||
          formation.totalCount !== entities.reduce((sum, entity) => sum + entity.count, 0) ||
          (cardKind === "unit" ? card.count !== formation.totalCount :
            formation.totalCount !== 0)) {
        throw new TypeError(`roster[${cardIndex}].formation is inconsistent`);
      }
      const label = `roster[${cardIndex}]`;
      const hasDamageQuestion = entities.some(({ damagePolicy }) => damagePolicy !== undefined);
      if (cardKind === "unit" && (card.damage === null) !== hasDamageQuestion) {
        throw new TypeError(`${label}.damage must agree with its damage question policy`);
      }
      const normalizedCard = {
        areaDamageRadiusMillitiles: nullableNonnegative(card.areaDamageRadiusMillitiles,
          `${label}.areaDamageRadiusMillitiles`),
        cost: nonnegative(card.cost, `${label}.cost`),
        count: integer(card.count, 1, 64, `${label}.count`),
        damage: cardKind === "unit" ? (hasDamageQuestion
          ? nullableNonnegative(card.damage, `${label}.damage`)
          : nonnegative(card.damage, `${label}.damage`)) :
          nullableNonnegative(card.damage, `${label}.damage`),
        deployTimeTicks: cardKind === "unit" ?
          nonnegative(card.deployTimeTicks, `${label}.deployTimeTicks`) :
          nullableNonnegative(card.deployTimeTicks, `${label}.deployTimeTicks`),
        displayName: string(card.displayName, `${label}.displayName`),
        entities,
        firstHitTicks: cardKind === "unit" ? nonnegative(card.firstHitTicks, `${label}.firstHitTicks`) :
          nullableNonnegative(card.firstHitTicks, `${label}.firstHitTicks`),
        formation: { componentOrder, expansionOrder: formation.expansionOrder,
          totalCount: formation.totalCount },
        hitSpeedTicks: cardKind === "unit" ? integer(card.hitSpeedTicks, 1,
          Number.MAX_SAFE_INTEGER, `${label}.hitSpeedTicks`) : card.hitSpeedTicks === null ? null :
          integer(card.hitSpeedTicks, 1, Number.MAX_SAFE_INTEGER, `${label}.hitSpeedTicks`),
        hitpoints: cardKind === "unit" ? integer(card.hitpoints, 1,
          Number.MAX_SAFE_INTEGER, `${label}.hitpoints`) : card.hitpoints === null ? null :
          integer(card.hitpoints, 1, Number.MAX_SAFE_INTEGER, `${label}.hitpoints`),
        id: cardId,
        kind: cardKind,
        movementMillitilesPerSecond: cardKind === "unit" ?
          nonnegative(card.movementMillitilesPerSecond,
            `${label}.movementMillitilesPerSecond`) :
          nullableNonnegative(card.movementMillitilesPerSecond,
            `${label}.movementMillitilesPerSecond`),
        rangeMillitiles: cardKind === "unit" ?
          nonnegative(card.rangeMillitiles, `${label}.rangeMillitiles`) :
          nullableNonnegative(card.rangeMillitiles, `${label}.rangeMillitiles`),
        rarity: string(card.rarity, `${label}.rarity`),
        sightRangeMillitiles: cardKind === "unit" ?
          nonnegative(card.sightRangeMillitiles, `${label}.sightRangeMillitiles`) :
          nullableNonnegative(card.sightRangeMillitiles, `${label}.sightRangeMillitiles`),
        targetMode: string(card.targetMode, `${label}.targetMode`),
      };
      if (cardKind === "structure" && hasBuildingRuntime) {
        const buildingRuntime = clone(card.buildingRuntime);
        assertSessionBuildingProfileReceipt(normalizedCard.id, canonical(buildingRuntime),
          `${label}.buildingRuntime`);
        normalizedCard.buildingRuntime = buildingRuntime;
      }
      return normalizedCard;
    });
  if (roster.length !== 8 || new Set(roster.map(({ id }) => id)).size !== roster.length) {
    throw new TypeError("live battle setup roster must contain eight unique cards");
  }
  // Ordinary-policy mode is uniform over materializable unit entities only;
  // effect and structure cards have empty entity inventories and own separate schemas.
  const unitEntities = roster
    .filter(({ kind }) => kind === "unit")
    .flatMap(({ entities }) => entities);
  const ordinaryPolicyEntities = unitEntities.filter(({ deliveryPolicy, layerPolicy }) =>
    deliveryPolicy !== undefined && layerPolicy !== undefined);
  if (ordinaryPolicyEntities.length !== 0 &&
      ordinaryPolicyEntities.length !== unitEntities.length) {
    throw new TypeError(
      "live battle ordinary runtime policies must use one uniform mode across unit entities",
    );
  }
  const archetypeFacts = new Map();
  for (const entity of roster.flatMap(({ entities }) => entities)) {
    // Count is this card's formation size; all remaining entity fields describe
    // the shared body and must agree when two cards reuse its archetype ID.
    const { archetypeId, count, ...facts } = entity;
    const factBytes = canonical(facts);
    const previous = archetypeFacts.get(archetypeId);
    if (previous !== undefined && previous !== factBytes) {
      throw new TypeError("live battle duplicate archetype facts must be canonically identical");
    }
    archetypeFacts.set(archetypeId, factBytes);
  }
  const cardOwners = new Set(roster.map(({ id }) => id));
  for (const card of roster) {
    if (card.entities.length === 1 && card.entities[0].count === 1 &&
        card.entities[0].archetypeId !== card.id) {
      throw new TypeError("live battle singleton card must own its matching archetype identity");
    }
    for (const entity of card.entities) {
      if (cardOwners.has(entity.archetypeId) && entity.archetypeId !== card.id) {
        throw new TypeError("live battle archetype cannot alias another card identity");
      }
    }
  }
  const expectedQuestions = [...referencedQuestionKeys].sort();
  const actualQuestions = questions.map(({ key }) => key).sort();
  if (canonical(actualQuestions) !== canonical(expectedQuestions)) {
    throw new TypeError("live battle questions must be the canonical exact referenced inventory");
  }
  if (questions.some(({ confidence }) => confidence !== "unverified")) {
    throw new TypeError("live battle questions must retain unverified confidence");
  }
  const canonicalQuestions = [...questions].sort((left, right) =>
    left.key < right.key ? -1 : left.key > right.key ? 1 : 0);
  const spellProfileReceipts = hasSpellProfiles
    ? parseSpellIntentProfileReceipts(setup.spellProfileReceipts)
    : null;
  if (spellProfileReceipts !== null) {
    const fact = spellProfileReceipts.profiles[0].fact;
    const card = roster.find(({ id }) => id === fact.cardId);
    if (card === undefined || card.kind !== fact.kind || card.cost !== fact.cost ||
        card.count !== fact.count || card.damage !== fact.damage) {
      throw new TypeError("live battle spell receipt diverges from its admitted roster fact");
    }
  }
  const normalized = freeze({
    initialWindupTicks,
    questions: canonicalQuestions,
    roster,
    ...(spellProfileReceipts === null ? {} : { spellProfileReceipts }),
    ...(chainQuestionPolicy === null ? {} : { chainQuestionPolicy }),
  });
  ADMITTED_SETUPS.add(normalized);
  return normalized;
}

function admittedSetup(value) {
  if (typeof value === "string") return checkedSetup(parsedSetupBytes(value));
  if (value !== null && typeof value === "object" && ADMITTED_SETUPS.has(value)) return value;
  throw new TypeError("live battle setup object must come from parseLiveBattleSetup");
}

function projectileUnitRosterFromAdmittedSetup(setup) {
  if (!ADMITTED_SETUPS.has(setup)) {
    throw new TypeError("projectile unit source roster requires an admitted full setup");
  }
  return setup.roster.filter(({ kind }) => kind === "unit");
}

function buildingProfileReceipt(setup) {
  return canonical({ profiles: setup.roster.filter(({ buildingRuntime, kind }) =>
    kind === "structure" && buildingRuntime !== undefined)
    .map(({ buildingRuntime, id }) => ({ cardId: id, profile: buildingRuntime })), version: 1 });
}

// These two runtimes are immutable configuration capabilities. Sharing their
// empty instances keeps a unit-only continuation from reparsing an empty
// shared-runtime receipt on every already-isolated GameSession candidate.
const EMPTY_BUILDING_PROFILE_RECEIPT = canonical({ profiles: [], version: 1 });
const EMPTY_BUILDING_RUNTIME = createSessionBuildingRuntime(EMPTY_BUILDING_PROFILE_RECEIPT);
const EMPTY_TROOP_RUNTIME = new SessionTroopRuntime();

function parseLiveBattleSetup(serialized) {
  return checkedSetup(parsedSetupBytes(serialized));
}

function resolveQuestion(policy, questionValues) {
  if (policy.kind !== "question") return null;
  return questionValues.get(policy.questionKey);
}

function checkedDeploy(value, currentTick, rosterById) {
  const command = exact(value, DEPLOY_KEYS, "live battle deploy command");
  const tick = integer(command.tick, currentTick, MAX_LIVE_BATTLE_STEP_TICKS,
    "live battle deploy command.tick");
  const sequence = integer(command.sequence, 0, Number.MAX_SAFE_INTEGER,
    "live battle deploy command.sequence");
  if (!SIDES.has(command.side)) throw new TypeError("live battle deploy command.side is invalid");
  const card = rosterById.get(command.cardId);
  if (!card) {
    throw new TypeError("live battle deploy command.cardId is not playable");
  }
  if (card.kind !== "unit" || card.entities.length === 0) {
    throw new TypeError("live battle deploy command.cardId is not a materializable unit");
  }
  const point = validateArenaPoint(command.point, "live battle deploy command.point");
  const decision = evaluateDeployment({
    destroyedOpposingLaneTowers: [],
    placementClass: "ground_entity",
    point,
    side: command.side,
  });
  if (!decision.legal) throw new RangeError(`live battle deployment is illegal: ${decision.reason}`);
  return { cardId: command.cardId, point: { ...point }, sequence, side: command.side, tick };
}

function checkedStructureDeploy(value, currentTick, rosterById) {
  const command = exact(value, STRUCTURE_DEPLOY_KEYS, "live battle structure deploy command");
  const tick = integer(command.tick, currentTick, MAX_LIVE_BATTLE_STEP_TICKS,
    "live battle structure deploy command.tick");
  const sequence = integer(command.sequence, 0, Number.MAX_SAFE_INTEGER,
    "live battle structure deploy command.sequence");
  if (!SIDES.has(command.side)) {
    throw new TypeError("live battle structure deploy command.side is invalid");
  }
  const card = rosterById.get(command.cardId);
  if (!card || card.kind !== "structure" || !Object.hasOwn(card, "buildingRuntime") ||
      !isSessionBuildingCardId(command.cardId)) {
    throw new TypeError("live battle structure deploy command.cardId is not a supported structure");
  }
  const point = validateArenaPoint(command.point, "live battle structure deploy command.point");
  const destination = command.destination === null ? null : validateArenaPoint(command.destination,
    "live battle structure deploy command.destination");
  if ((command.cardId === "burrow-rig") !== (destination !== null)) {
    throw new TypeError("underground travel structures require exactly one destination");
  }
  const decision = evaluateDeployment({ destroyedOpposingLaneTowers: [],
    placementClass: "ground_entity", point, side: command.side });
  if (!decision.legal) {
    throw new RangeError(`live battle structure deployment is illegal: ${decision.reason}`);
  }
  if (destination !== null) {
    const destinationDecision = evaluateDeployment({ destroyedOpposingLaneTowers: [],
      placementClass: "ground_entity", point: destination, side: command.side });
    if (!destinationDecision.legal) {
      throw new RangeError(`live battle structure destination is illegal: ${destinationDecision.reason}`);
    }
  }
  return { cardId: command.cardId, destination: destination === null ? null : { ...destination },
    point: { ...point }, sequence, side: command.side, tick };
}

function checkedTroopAction(value, currentTick, { requireCurrent = true } = {}) {
  const action = exact(value, TROOP_ACTION_KEYS, "live battle troop action");
  if (action.type !== "ability") throw new TypeError("live battle troop action.type is invalid");
  const tick = integer(action.tick, currentTick, MAX_LIVE_BATTLE_STEP_TICKS,
    "live battle troop action.tick");
  if (requireCurrent && tick !== currentTick) {
    throw new RangeError("live battle troop action.tick must equal the current tick");
  }
  const side = string(action.side, "live battle troop action.side");
  if (!SIDES.has(side)) throw new TypeError("live battle troop action.side is invalid");
  const point = action.point === null ? null : validateArenaPoint(action.point,
    "live battle troop action.point");
  const targetId = action.targetId === null ? null : integer(action.targetId, 1,
    Number.MAX_SAFE_INTEGER, "live battle troop action.targetId");
  return {
    actionId: string(action.actionId, "live battle troop action.actionId"),
    commandId: integer(action.commandId, 0, Number.MAX_SAFE_INTEGER,
      "live battle troop action.commandId"),
    point: point === null ? null : { ...point },
    side,
    sourceId: integer(action.sourceId, 1, Number.MAX_SAFE_INTEGER,
      "live battle troop action.sourceId"),
    targetId,
    tick,
    type: "ability",
  };
}

function checkedTroopStatusAction(value, currentTick, { requireCurrent = true } = {}) {
  const action = exact(value, TROOP_ACTION_KEYS, "live battle troop status action");
  if (action.type !== "status") {
    throw new TypeError("live battle troop status action.type is invalid");
  }
  const tick = integer(action.tick, currentTick, MAX_LIVE_BATTLE_STEP_TICKS,
    "live battle troop status action.tick");
  if (requireCurrent && tick !== currentTick) {
    throw new RangeError("live battle troop status action.tick must equal the current tick");
  }
  const side = string(action.side, "live battle troop status action.side");
  if (!SIDES.has(side)) throw new TypeError("live battle troop status action.side is invalid");
  const point = action.point === null ? null : validateArenaPoint(action.point,
    "live battle troop status action.point");
  const targetId = action.targetId === null ? null : integer(action.targetId, 1,
    Number.MAX_SAFE_INTEGER, "live battle troop status action.targetId");
  return {
    actionId: string(action.actionId, "live battle troop status action.actionId"),
    commandId: integer(action.commandId, 0, Number.MAX_SAFE_INTEGER,
      "live battle troop status action.commandId"),
    point: point === null ? null : { ...point },
    side,
    sourceId: integer(action.sourceId, 1, Number.MAX_SAFE_INTEGER,
      "live battle troop status action.sourceId"),
    targetId,
    tick,
    type: "status",
  };
}

function checkedLegacyTroopIntent(value, tick) {
  const intent = exact(value, TROOP_INTENT_KEYS, "live battle troop runtime intent");
  if (intent.type !== "troop-runtime-intent" || !["action", "deploy", "pass"].includes(intent.kind) ||
      !["deploy", "pre-move", "pre-combat", "post-combat"].includes(intent.phase)) {
    throw new TypeError("live battle troop runtime intent is invalid");
  }
  const intentTick = integer(intent.tick, 0, MAX_LIVE_BATTLE_STEP_TICKS,
    "live battle troop runtime intent.tick");
  if (intentTick !== tick) throw new RangeError("live battle troop runtime intent tick is stale");
  const side = string(intent.side, "live battle troop runtime intent.side");
  if (!SIDES.has(side)) throw new TypeError("live battle troop runtime intent.side is invalid");
  const sourceId = integer(intent.sourceId, 1, Number.MAX_SAFE_INTEGER,
    "live battle troop runtime intent.sourceId");
  const targetId = intent.targetId === null ? null : integer(intent.targetId, 1,
    Number.MAX_SAFE_INTEGER, "live battle troop runtime intent.targetId");
  const point = intent.point === null ? null : validateArenaPoint(intent.point,
    "live battle troop runtime intent.point");
  const actionId = intent.actionId === null ? null : string(intent.actionId,
    "live battle troop runtime intent.actionId");
  const commandId = intent.commandId === null ? null : integer(intent.commandId, 0,
    Number.MAX_SAFE_INTEGER, "live battle troop runtime intent.commandId");
  const cardId = string(intent.cardId, "live battle troop runtime intent.cardId");
  if (intent.kind === "action") {
    if (intent.phase !== "pre-combat" || actionId === null || commandId === null ||
        targetId === null || point !== null) {
      throw new TypeError("live battle troop action intent is noncanonical");
    }
  } else if (actionId !== null || commandId !== null || targetId !== null || point !== null) {
    throw new TypeError("live battle passive troop intent is noncanonical");
  }
  return { actionId, cardId, commandId, kind: intent.kind, phase: intent.phase,
    point: point === null ? null : { ...point }, side, sourceId, targetId, tick: intentTick,
    type: "troop-runtime-intent" };
}

function checkedCurrentTroopContactIntent(value, tick) {
  const intent = exact(value, CURRENT_TROOP_CONTACT_INTENT_KEYS,
    "live battle current troop contact intent");
  if (intent.type !== "troop-runtime-intent" || intent.kind !== "contact" ||
      intent.phase !== "combat") {
    throw new TypeError("live battle current troop contact intent is invalid");
  }
  const intentTick = integer(intent.tick, 0, MAX_LIVE_BATTLE_STEP_TICKS,
    "live battle current troop contact intent.tick");
  if (intentTick !== tick) throw new RangeError("live battle current troop contact intent tick is stale");
  const side = string(intent.side, "live battle current troop contact intent.side");
  if (!SIDES.has(side)) throw new TypeError("live battle current troop contact intent.side is invalid");
  return {
    attackSequence: integer(intent.attackSequence, 1, Number.MAX_SAFE_INTEGER,
      "live battle current troop contact intent.attackSequence"),
    cardId: string(intent.cardId, "live battle current troop contact intent.cardId"),
    kind: "contact",
    phase: "combat",
    side,
    sourceId: integer(intent.sourceId, 1, Number.MAX_SAFE_INTEGER,
      "live battle current troop contact intent.sourceId"),
    targetId: integer(intent.targetId, 1, Number.MAX_SAFE_INTEGER,
      "live battle current troop contact intent.targetId"),
    tick: intentTick,
    type: "troop-runtime-intent",
  };
}

function checkedTroopMovementCommand(value, currentTick, { requireCurrent = true } = {}) {
  const command = exact(value,
    ["cardId", "claimFamily", "phase", "side", "sourceId", "tick", "type"],
    "live battle troop movement command");
  if (command.type !== "troop-movement") {
    throw new TypeError("live battle troop movement command.type is invalid");
  }
  const tick = integer(command.tick, currentTick, MAX_LIVE_BATTLE_STEP_TICKS,
    "live battle troop movement command.tick");
  if (requireCurrent && tick !== currentTick) {
    throw new RangeError("live battle troop movement command.tick must equal the current tick");
  }
  const side = string(command.side, "live battle troop movement command.side");
  if (!SIDES.has(side)) throw new TypeError("live battle troop movement command.side is invalid");
  return {
    cardId: string(command.cardId, "live battle troop movement command.cardId"),
    claimFamily: string(command.claimFamily, "live battle troop movement command.claimFamily"),
    phase: string(command.phase, "live battle troop movement command.phase"),
    side,
    sourceId: integer(command.sourceId, 1, Number.MAX_SAFE_INTEGER,
      "live battle troop movement command.sourceId"),
    tick,
    type: "troop-movement",
  };
}

function checkedTroopMovementIntent(value, tick) {
  const intent = exact(value, TROOP_MOVEMENT_INTENT_KEYS,
    "live battle troop movement intent");
  if (intent.type !== "troop-runtime-intent" || intent.kind !== "flight" ||
      intent.claimFamily !== "flight" || intent.layer !== "air" ||
      intent.pathScope !== "axis-aligned-only" || intent.phase !== "pre-move") {
    throw new TypeError("live battle troop movement intent is invalid");
  }
  const intentTick = integer(intent.tick, 0, MAX_LIVE_BATTLE_STEP_TICKS,
    "live battle troop movement intent.tick");
  if (intentTick !== tick) throw new RangeError("live battle troop movement intent tick is stale");
  const side = string(intent.side, "live battle troop movement intent.side");
  if (!SIDES.has(side)) throw new TypeError("live battle troop movement intent.side is invalid");
  return {
    cardId: string(intent.cardId, "live battle troop movement intent.cardId"),
    claimFamily: "flight",
    kind: "flight",
    layer: "air",
    pathScope: "axis-aligned-only",
    phase: "pre-move",
    side,
    sourceId: integer(intent.sourceId, 1, Number.MAX_SAFE_INTEGER,
      "live battle troop movement intent.sourceId"),
    tick: intentTick,
    type: "troop-runtime-intent",
  };
}

function checkedTroopIntent(value, tick, version) {
  return version === SESSION_TROOP_RUNTIME_MOVEMENT_VERSION
    ? checkedTroopMovementIntent(value, tick)
    : version === SESSION_TROOP_RUNTIME_VERSION
    ? checkedCurrentTroopContactIntent(value, tick)
    : checkedLegacyTroopIntent(value, tick);
}

function sideRank(side) {
  return side === "north" ? 0 : 1;
}

function troopStatusKey({ cardId, kind, phase, sourceId }) {
  return `${cardId}:${sourceId}:${kind}:${phase}`;
}

function troopExternalSourceId(intent) {
  return `troop-runtime:${intent.side}:${intent.commandId}:${intent.sourceId}:${intent.actionId}`;
}

function troopHostSourceIdentity({ side, sourceId }) {
  return `live-battle-unit:${side}:${sourceId}`;
}

function troopContactIdentity({ attackSequence, side, sourceId, targetId, tick }) {
  return `live-contact:${side}:${sourceId}:${attackSequence}:${targetId}:${tick}`;
}

function checkedTroopStatus(value, { profile = null, version } = {}) {
  if (version === SESSION_TROOP_RUNTIME_VERSION) {
    const status = exact(value, CURRENT_TROOP_CONTACT_STATUS_KEYS,
      "live battle current troop contact status");
    const intent = checkedCurrentTroopContactIntent({
      attackSequence: status.attackSequence,
      cardId: status.cardId,
      kind: status.kind,
      phase: status.phase,
      side: status.side,
      sourceId: status.sourceId,
      targetId: status.targetId,
      tick: status.tick,
      type: "troop-runtime-intent",
    }, status.tick);
    const key = string(status.key, "live battle current troop contact status.key");
    if (key !== troopStatusKey(intent) || status.effect !== CURRENT_TROOP_CONTACT_EFFECT ||
        status.delivery !== "melee" || !Number.isSafeInteger(status.damage) || status.damage < 1 ||
        status.damage > 1_000_000_000 ||
        status.hostSourceIdentity !== troopHostSourceIdentity(intent) ||
        status.contactId !== troopContactIdentity(intent)) {
      throw new TypeError("live battle current troop contact status is noncanonical");
    }
    if (profile === null || profile.cardId !== intent.cardId ||
        canonical(status.provenance) !== canonical(profile.contact.provenance) ||
        canonical(status.sourceProfile) !== canonical(profile.sourceProfile)) {
      throw new TypeError("live battle current troop contact status profile diverges");
    }
    return {
      attackSequence: intent.attackSequence,
      cardId: intent.cardId,
      contactId: status.contactId,
      damage: status.damage,
      delivery: "melee",
      effect: CURRENT_TROOP_CONTACT_EFFECT,
      hostSourceIdentity: status.hostSourceIdentity,
      key,
      kind: "contact",
      phase: "combat",
      provenance: clone(profile.contact.provenance),
      side: intent.side,
      sourceId: intent.sourceId,
      sourceProfile: clone(profile.sourceProfile),
      targetId: intent.targetId,
      tick: intent.tick,
    };
  }

  const representative = version === SESSION_TROOP_RUNTIME_ACTION_PROFILE_VERSION;
  const status = exact(value, representative ? REPRESENTATIVE_TROOP_STATUS_KEYS : TROOP_STATUS_KEYS,
    "live battle troop runtime status");
  const intent = checkedLegacyTroopIntent({
    actionId: status.actionId,
    cardId: status.cardId,
    commandId: status.commandId,
    kind: status.kind,
    phase: status.phase,
    point: status.point,
    side: status.side,
    sourceId: status.sourceId,
    targetId: status.targetId,
    tick: status.tick,
    type: "troop-runtime-intent",
  }, status.tick);
  const key = string(status.key, "live battle troop runtime status.key");
  if (key !== troopStatusKey(intent)) {
    throw new TypeError("live battle troop runtime status key is noncanonical");
  }
  const { type: ignored, ...statusData } = intent;
  void ignored;
  if (!representative) return { ...statusData, key };
  const effect = status.effect;
  const delivery = status.delivery;
  const damage = status.damage;
  const externalSourceId = status.externalSourceId;
  if (intent.kind !== "action") {
    if (effect !== null || delivery !== null || damage !== null || externalSourceId !== null) {
      throw new TypeError("live battle passive representative status must not carry an effect");
    }
  } else if (!TROOP_REPRESENTATIVE_EFFECTS.has(effect) || delivery !== "melee" ||
      !Number.isSafeInteger(damage) || damage < 1 || damage > 1_000_000_000 ||
      externalSourceId !== troopExternalSourceId(intent)) {
    throw new TypeError("live battle representative action status is noncanonical");
  }
  return { ...statusData, damage, delivery, effect, externalSourceId, key };
}

function otherSide(side) {
  return side === "north" ? "south" : "north";
}

function squaredDistance(left, right) {
  const dx = BigInt(left.x) - BigInt(right.x);
  const dy = BigInt(left.y) - BigInt(right.y);
  return dx * dx + dy * dy;
}

function targetMode(value) {
  if (value === "ground-and-air") return "air_and_ground";
  if (value === "structures") return "buildings";
  return value;
}

function layerEligible(mode, layer) {
  return mode === "air_and_ground" || mode === layer;
}

function nearestGroundNode(point, occupied = new Set()) {
  let best = null;
  let bestDistance = null;
  for (const candidate of GROUND_NODES) {
    if (!occupied.has(`${candidate.x}:${candidate.y}`)) {
      const distance = squaredDistance(candidate, point);
      if (best === null || distance < bestDistance ||
          (distance === bestDistance && (candidate.y < best.y ||
            (candidate.y === best.y && candidate.x < best.x)))) {
        best = candidate;
        bestDistance = distance;
      }
    }
  }
  if (best === null) throw new RangeError("no ground navigation node is available");
  return best;
}

function expandedEntities(card, firstId, questionValues, movementOverride = null) {
  const entities = [];
  let id = firstId;
  for (const component of card.entities) {
    const radius = resolveQuestion(component.bodyRadiusPolicy, questionValues);
    const projectileSpeed = component.projectileSpeedPolicy.kind === "question"
      ? resolveQuestion(component.projectileSpeedPolicy, questionValues)
      : null;
    const delivery = component.deliveryPolicy?.kind === "question"
      ? (resolveQuestion(component.deliveryPolicy, questionValues) === 2 ? "projectile" : "melee")
      : component.delivery;
    const layer = component.layerPolicy?.kind === "question"
      ? (resolveQuestion(component.layerPolicy, questionValues) === 2 ? "air" : "ground")
      : component.layer;
    const damage = component.damagePolicy?.kind === "question"
      ? resolveQuestion(component.damagePolicy, questionValues)
      : component.damage;
    const override = movementOverride !== null ? {
      layer: movementOverride.layer,
      movementMillitilesPerSecond: movementOverride.speed,
    } : null;
    const runtimeComponent = { ...component, damage, delivery, layer, ...override };
    for (let memberIndex = 0; memberIndex < component.count; memberIndex += 1) {
      entities.push({ component: runtimeComponent, id, memberIndex, projectileSpeed, radius });
      id += 1;
    }
  }
  return entities;
}

function placedEntities(card, point, firstId, questionValues, movementOverride = null) {
  const expanded = expandedEntities(card, firstId, questionValues, movementOverride);
  const laidOut = layoutFormation(point, expanded.map(({ component, id, radius }) => ({
    id,
    radius,
    role: component.role,
  })));
  const occupied = new Set();
  return expanded.map((entry, index) => {
    const desired = laidOut[index].position;
    const position = entry.component.layer === "ground"
      ? nearestGroundNode(desired, occupied)
      : desired;
    if (entry.component.layer === "ground") occupied.add(`${position.x}:${position.y}`);
    return { ...entry, position };
  });
}

function combatSpec(entity, side) {
  const component = entity.component;
  const spec = {
    cadenceTicks: component.hitSpeedTicks,
    damage: component.damage,
    delivery: component.delivery,
    deployTicks: component.deployTimeTicks,
    firstHitTicks: component.firstHitTicks,
    id: entity.id,
    layer: component.layer,
    maxHealth: component.hitpoints,
    position: { ...entity.position },
    projectileSpeed: entity.projectileSpeed,
    radius: entity.radius,
    reach: component.rangeMillitiles,
    side,
    sightRange: component.sightRangeMillitiles,
    targetMode: targetMode(component.targetMode),
    ...ordinaryProjectileSplashCombatFields(component),
  };
  return spec;
}

function currentContactSourceProfileFromRoster(card) {
  if (card.kind !== "unit" || card.entities.length !== 1 || card.entities[0].count !== 1) {
    throw new TypeError("current troop contact profile requires one materializable source entity");
  }
  const entity = card.entities[0];
  if (entity.projectileSpeedPolicy.kind !== "not-applicable") {
    throw new TypeError("current troop contact profile requires a non-projectile source");
  }
  return {
    combat: {
      damage: entity.damage,
      delivery: entity.delivery,
      deployTimeTicks: entity.deployTimeTicks,
      firstHitTicks: entity.firstHitTicks,
      hitSpeedTicks: entity.hitSpeedTicks,
      layer: entity.layer,
      rangeMillitiles: entity.rangeMillitiles,
      sightRangeMillitiles: entity.sightRangeMillitiles,
      targetMode: entity.targetMode,
    },
    entity: {
      archetypeId: entity.archetypeId,
      memberIndex: 0,
      role: entity.role,
    },
  };
}

function currentContactSourceProfileFromMaterialized(unit, metadata) {
  return {
    combat: {
      damage: unit.damage,
      delivery: unit.delivery,
      deployTimeTicks: unit.deployTicks,
      firstHitTicks: unit.firstHitTicks,
      hitSpeedTicks: unit.cadenceTicks,
      layer: unit.layer,
      rangeMillitiles: unit.reach,
      sightRangeMillitiles: unit.sightRange,
      targetMode: unit.targetMode === "air_and_ground" ? "ground-and-air" : unit.targetMode,
    },
    entity: {
      archetypeId: metadata.archetypeId,
      memberIndex: metadata.memberIndex,
      role: metadata.role,
    },
  };
}

function movementWitnesses(movements, metadata) {
  return [...movements].sort(([left], [right]) => left - right).map(([id, movement]) => ({
    bytes: movement.serialize(),
    id,
    targetKey: metadata.get(id).targetKey,
  }));
}

function compactLiveHistory(history) {
  const transcript = [];
  for (let index = 0; index < history.length;) {
    const operation = history[index];
    if (operation.type !== "step") {
      transcript.push(clone(operation));
      index += 1;
      continue;
    }
    let ticks = 1;
    while (history[index + ticks]?.type === "step" &&
        history[index + ticks].tick === operation.tick + ticks) ticks += 1;
    transcript.push({ tick: operation.tick, ticks, type: "step-run" });
    index += ticks;
  }
  return transcript;
}

class LiveBattle {
  #battle;
  #buildingRuntime;
  #events;
  #history;
  #historyCount;
  #isContinuation;
  #metadata;
  #movements;
  #movementsOpaque;
  #nextEntityId;
  #pending;
  #pendingBuildingHits;
  #pendingStructures;
  #pendingTroopActions;
  #pendingTroopStatusActions;
  #chainContinuation;
  #projectileRuntime;
  #questionValues;
  #rosterById;
  #setup;
  #spells;
  #structures;
  #statusEffects;
  #statusRuntime;
  #troopRuntime;
  #troopStatuses;

  constructor(value, troopRuntimeProfiles = undefined, statusRuntimeProfiles = undefined,
    projectileRuntimePlan = undefined) {
    runtimeInstances.add(this);
    const setup = admittedSetup(value);
    const projectileRuntime = projectileRuntimePlan === undefined
      ? null
      : typeof projectileRuntimePlan === "string"
        ? SessionTroopProjectileRuntime.fromReceipt(projectileRuntimePlan)
        : new SessionTroopProjectileRuntime(projectileRuntimePlan);
    projectileRuntime?.assertSourceRoster(projectileUnitRosterFromAdmittedSetup(setup));
    const chainQuestionPolicy = setup.chainQuestionPolicy ?? null;
    if (chainQuestionPolicy !== null) {
      const chainProfile = projectileRuntime?.profile("stormkite") ?? null;
      if (chainProfile?.claimFamily !== "chain" ||
          !setup.roster.some(({ id, kind }) => id === "stormkite" && kind === "unit")) {
        throw new RangeError(
          "live battle Stormkite chain execution requires its admitted chain projectile profile",
        );
      }
    }
    const statusRuntime = statusRuntimeProfiles === undefined
      ? null
      : new SessionTroopStatusRuntime(statusRuntimeProfiles);
    if (statusRuntime === null) {
      assertSessionTroopStatusSourceRoster(setup.roster);
    } else {
      statusRuntime.assertSourceRoster(setup.roster, setup.questions);
    }
    this.#battle = new BattleTowerCombat({
      initialWindupTicks: setup.initialWindupTicks,
      units: [],
    });
    this.#events = [];
    this.#history = [];
    this.#historyCount = 0;
    this.#isContinuation = false;
    this.#metadata = new Map();
    this.#movements = new Map();
    this.#movementsOpaque = false;
    this.#nextEntityId = 1;
    this.#pending = [];
    this.#pendingBuildingHits = [];
    this.#pendingStructures = [];
    this.#pendingTroopActions = [];
    this.#pendingTroopStatusActions = [];
    this.#chainContinuation = chainQuestionPolicy === null
      ? null : new LiveBattleChainContinuation(chainQuestionPolicy);
    this.#projectileRuntime = projectileRuntime;
    this.#setup = setup;
    const hasBuildingProfile = setup.roster.some(({ buildingRuntime, kind }) =>
      kind === "structure" && buildingRuntime !== undefined);
    const buildingReceipt = hasBuildingProfile ? buildingProfileReceipt(setup) :
      EMPTY_BUILDING_PROFILE_RECEIPT;
    this.#buildingRuntime = buildingReceipt === EMPTY_BUILDING_PROFILE_RECEIPT
      ? EMPTY_BUILDING_RUNTIME
      : createSessionBuildingRuntime(buildingReceipt);
    this.#structures = [];
    this.#questionValues = new Map(setup.questions.map(({ key, value: answer }) => [key, answer]));
    this.#rosterById = new Map(setup.roster.map((card) => [card.id, card]));
    this.#spells = setup.spellProfileReceipts === undefined
      ? null
      : createSpellIntentRuntime(setup.spellProfileReceipts);
    this.#troopRuntime = troopRuntimeProfiles === undefined
      ? EMPTY_TROOP_RUNTIME
      : new SessionTroopRuntime(troopRuntimeProfiles);
    if (this.#troopRuntime.version === SESSION_TROOP_RUNTIME_MOVEMENT_VERSION) {
      this.#troopRuntime.assertSourceRoster(setup.roster);
    }
    this.#statusRuntime = statusRuntime;
    this.#statusEffects = new Map();
    this.#troopStatuses = new Map();
    for (const profile of this.#troopRuntime.configuration.profiles) {
      const profileCardId = this.#troopRuntime.version === SESSION_TROOP_RUNTIME_MOVEMENT_VERSION
        ? profile.id : profile.cardId;
      const card = this.#rosterById.get(profileCardId);
      if (card === undefined && this.#troopRuntime.version === SESSION_TROOP_RUNTIME_MOVEMENT_VERSION) {
        continue;
      }
      if (card === undefined || card.kind !== "unit" || card.entities.length === 0) {
        throw new TypeError("live battle troop runtime profile card is not a materializable roster unit");
      }
      if (this.#troopRuntime.version === SESSION_TROOP_RUNTIME_VERSION) {
        const expected = currentContactSourceProfileFromRoster(card);
        if (canonical(profile.sourceProfile) !== canonical(expected)) {
          throw new TypeError("live battle current troop contact source profile diverges from roster");
        }
      }
    }
  }

  #battleRuntime() {
    return this.#isContinuation ? resolveBattleTower(this.#battle) : this.#battle;
  }

  #towerSnapshot() {
    return battleTowerSnapshot(this.#battleRuntime());
  }

  #movementRuntime(movement) {
    return this.#movementsOpaque ? resolveBattleMovement(movement) : movement;
  }

  #movementRuntimes() {
    if (!this.#movementsOpaque) return this.#movements;
    return new Map([...this.#movements].map(([id, movement]) =>
      [id, this.#movementRuntime(movement)]));
  }

  get state() {
    const state = this.#battleRuntime().state;
    const publicState = {
      activationHistory: clone(state.activationHistory),
      pendingBuildingHits: clone(this.#pendingBuildingHits),
      pendingDeployments: clone(this.#pending),
      pendingStructures: clone(this.#pendingStructures),
      projectiles: clone(state.projectiles),
      structures: clone(this.#structures),
      tick: state.tick,
      towers: clone(state.towers),
      units: state.units.map((unit) => ({
        ...clone(unit),
        archetypeId: this.#metadata.get(unit.id).archetypeId,
        cardId: this.#metadata.get(unit.id).cardId,
        count: this.#metadata.get(unit.id).count,
        memberIndex: this.#metadata.get(unit.id).memberIndex,
        movement: unit.alive ? clone(this.#movementRuntime(this.#movements.get(unit.id)).state) : null,
        role: this.#metadata.get(unit.id).role,
      })),
    };
    if (this.#hasTroopRuntime()) {
      publicState.troopRuntime = {
        configuration: clone(this.#troopRuntime.state),
        statuses: this.#troopStatusWitnesses(),
      };
      if (this.#allowsLegacyTroopActions()) {
        publicState.pendingTroopActions = clone(this.#pendingTroopActions);
      }
    }
    if (this.#hasStatusRuntime()) {
      publicState.statusRuntime = {
        configuration: this.#statusRuntime.state,
        effects: this.#statusEffectWitnesses(),
        pending: clone(this.#pendingTroopStatusActions),
      };
    }
    if (this.#projectileRuntime !== null) {
      publicState.projectileRuntime = clone(this.#projectileRuntime.state);
    }
    if (this.#spells !== null) publicState.pendingSpellIntents = clone(this.#spells.state.pending);
    return freeze(publicState);
  }

  get events() {
    this.#assertPublicTranscript();
    return freeze(clone(this.#events));
  }

  get replay() {
    return this.events;
  }

  /** Closed combat-effect feed delegated from the authentic battle authority. */
  get combatEffectFeed() {
    return this.#battleRuntime().combatEffectFeed;
  }

  get effectFeed() {
    return this.combatEffectFeed;
  }

  get visualFeed() {
    return this.combatEffectFeed;
  }

  combatEffectFeedBytes() {
    return this.#battleRuntime().combatEffectFeedBytes();
  }

  get allowsLegacyTroopActions() {
    return this.#allowsLegacyTroopActions();
  }

  /** Whether this admitted roster has the canonical profile needed to materialize a structure. */
  supportsStructureRuntime(cardId) {
    if (typeof cardId !== "string") return false;
    const card = this.#rosterById.get(cardId);
    return card?.kind === "structure" && Object.hasOwn(card, "buildingRuntime") &&
      isSessionBuildingCardId(cardId);
  }

  /** Whether this battle is bound to the closed troop projectile receipt. */
  supportsProjectileRuntime(cardId = null) {
    if (this.#projectileRuntime === null) return false;
    if (cardId === null) return true;
    if (typeof cardId !== "string") throw new TypeError("live battle projectile card ID must be primitive");
    return this.#projectileRuntime.profile(cardId) !== null;
  }

  /** Whether this battle is bound to the closed HTMP movement receipt. */
  supportsMovementRuntime(cardId = null) {
    if (this.#troopRuntime.version !== SESSION_TROOP_RUNTIME_MOVEMENT_VERSION) return false;
    if (cardId === null) return true;
    if (typeof cardId !== "string") throw new TypeError("live battle movement card ID must be primitive");
    return this.#troopRuntime.movementProfile(cardId) !== null;
  }

  /** Pure admission for a sourced movement family or its frozen QUESTION path. */
  inspectTroopMovement(serialized) {
    if (!this.supportsMovementRuntime()) {
      throw new RangeError("live battle has no sourced movement profile receipt");
    }
    const command = parsedCommandBytes(serialized, "live battle troop movement command");
    const checked = checkedTroopMovementCommand(command, this.#battleRuntime().state.tick);
    const source = this.#troopSource(checked.sourceId, { requireAlive: true });
    if (source.cardId !== checked.cardId || source.side !== checked.side) {
      throw new RangeError("live battle troop movement command source is not causal");
    }
    this.#troopRuntime.assertSourceRoster(this.#setup.roster);
    return freeze(clone(this.#troopRuntime.inspectMovement(checked)));
  }

  scheduleTroopMovement(serialized) {
    const inspection = this.inspectTroopMovement(serialized);
    if (inspection.disposition === "question") {
      throw new RangeError(
        `live battle movement ${inspection.cardId} ${inspection.claimFamily} remains an explicit QUESTION`,
      );
    }
    return inspection;
  }

  /**
   * Pure mechanic admission.  QUESTION-dependent continuation never reaches
   * the host mutation boundary; callers receive the frozen rejection witness.
   */
  inspectProjectileMechanic(serialized) {
    if (this.#projectileRuntime === null) {
      throw new RangeError("live battle has no sourced projectile profile receipt");
    }
    const command = parsedCommandBytes(serialized, "live battle projectile mechanic command");
    this.#projectileRuntime.assertSourceRoster(projectileUnitRosterFromAdmittedSetup(this.#setup));
    const state = this.#battleRuntime().state;
    const sources = this.#projectileSourcesFromState(state);
    return freeze(clone(this.#projectileRuntime.inspectMechanic(command, sources)));
  }

  scheduleProjectileMechanic(serialized) {
    const inspection = this.inspectProjectileMechanic(serialized);
    if (inspection.disposition === "question") {
      throw new RangeError(
        `live battle projectile ${inspection.claimFamily} remains an explicit QUESTION`,
      );
    }
    return inspection;
  }

  hasSpellProfile(cardId) {
    if (typeof cardId !== "string") throw new TypeError("live battle spell card ID must be primitive");
    return this.#spells !== null && this.#spells.hasCard(cardId);
  }

  hasRadiusSpellProfile(cardId) {
    if (typeof cardId !== "string") throw new TypeError("live battle spell card ID must be primitive");
    return this.#spells !== null && this.#spells.profileVersion === 2 && this.#spells.hasCard(cardId);
  }

  getSpellProfileQuestion(cardId) {
    if (typeof cardId !== "string") throw new TypeError("live battle spell card ID must be primitive");
    const card = this.#rosterById.get(cardId);
    if (card === undefined || card.kind !== "effect" || this.hasSpellProfile(cardId)) return null;
    return getUnprofiledAdmittedEffectProfileQuestion(cardId);
  }

  validateSpell(command) {
    return freeze(clone(this.#validatedSpellCommand(command)));
  }

  /** Returns an independent transactional continuation without history replay. */
  fork() {
    this.#assertPublicTranscript();
    return this.#runtimeClone();
  }

  /** Internal composite checkpoint. Public history remains owned by the caller. */
  static {
    compact = (value) => value.#runtimeClone(false);
    towerSnapshot = (value) => {
      if (!runtimeInstances.has(value)) {
        throw new TypeError("internal defineLiveBattle tower snapshot receiver is invalid");
      }
      return value.#towerSnapshot();
    };
    // GameSession has already cloned this LiveBattle into an unobservable
    // transactional candidate. Re-cloning it through public stepMany() would
    // duplicate every live combat/movement authority on each fixed session
    // slice without adding rollback protection. This closure never leaves the
    // module and authenticates the receiver without touching attacker data.
    advanceFromSession = (value, ticks) => {
      if (!runtimeInstances.has(value)) {
        throw new TypeError("internal defineLiveBattle session advance receiver is invalid");
      }
      return value.#advanceFromSession(ticks);
    };
    combatEffectFeed = (value) => {
      if (!runtimeInstances.has(value)) {
        throw new TypeError("internal defineLiveBattle combat-effect feed receiver is invalid");
      }
      return value.#battleRuntime().combatEffectFeed;
    };
  }
  scheduleDeploy(serialized) {
    const command = parsedCommandBytes(serialized, "live battle deploy command");
    return this.#scheduleDeployChecked(command);
  }

  #scheduleDeployChecked(command) {
    if (this.#historyCount >= MAX_HISTORY || this.#pending.length >= MAX_LIVE_BATTLE_DEPLOYMENTS) {
      throw new RangeError("live battle deployment/history bound exceeded");
    }
    const battle = this.#battleRuntime();
    // `BattleTowerCombat.state` is a complete immutable projection. Capture
    // the current tick once: admission and the observable scheduling event
    // must name the same boundary, and a second projection needlessly clones
    // every live unit/projectile during an active deployment transaction.
    const battleTick = battle.state.tick;
    const checked = checkedDeploy(command, battleTick, this.#rosterById);
    if (this.#pending.some((entry) =>
      entry.tick === checked.tick && entry.sequence === checked.sequence) ||
        this.#pendingStructures.some((entry) => entry.tick === checked.tick &&
          entry.sequence === checked.sequence) ||
        this.#spells?.hasPendingSequence(checked.tick, checked.sequence)) {
      throw new RangeError("live battle deployment tick/sequence must be unique");
    }
    this.#pending.push(clone(checked));
    this.#pending.sort((left, right) => left.tick - right.tick ||
      left.sequence - right.sequence || sideRank(left.side) - sideRank(right.side));
    this.#appendHistory({ command: clone(checked), type: "deploy" });
    const event = { ...clone(checked), scheduledAt: battleTick, type: "deploy-scheduled" };
    this.#events.push(event);
    return freeze(clone(event));
  }

  /** Schedules one exact sourced effect against a shared live unit. */
  scheduleSpell(command) {
    if (this.#spells === null) throw new RangeError("live battle has no sourced spell profile");
    if (this.#historyCount >= MAX_HISTORY) {
      throw new RangeError("live battle spell/history bound exceeded");
    }
    const checked = this.#validatedSpellCommand(command);
    const scheduled = this.#spells.schedule(checked, this.#battleRuntime().state.tick, () => true);
    this.#appendHistory({ command: {
      cardId: scheduled.cardId,
      point: clone(scheduled.point),
      sequence: scheduled.sequence,
      side: scheduled.side,
      ...(Object.hasOwn(scheduled, "target") ? { target: clone(scheduled.target) } : {}),
      tick: scheduled.tick,
    }, type: "spell" });
    this.#events.push(clone(scheduled));
    return freeze(clone(scheduled));
  }

  /** Schedules one typed, host-owned structure placement for the shared tick. */
  scheduleStructure(command) {
    const parsed = typeof command === "string"
      ? parsedCommandBytes(command, "live battle structure deploy command")
      : command;
    return this.#scheduleStructureChecked(parsed);
  }

  #scheduleStructureChecked(command) {
    if (this.#historyCount >= MAX_HISTORY ||
        this.#pendingStructures.length >= MAX_LIVE_BATTLE_DEPLOYMENTS) {
      throw new RangeError("live battle structure deployment/history bound exceeded");
    }
    const battle = this.#battleRuntime();
    const checked = checkedStructureDeploy(command, battle.state.tick, this.#rosterById);
    if (this.#pendingStructures.some((entry) => entry.tick === checked.tick &&
        entry.sequence === checked.sequence) || this.#pending.some((entry) =>
      entry.tick === checked.tick && entry.sequence === checked.sequence) ||
        this.#spells?.hasPendingSequence(checked.tick, checked.sequence)) {
      throw new RangeError("live battle deployment tick/sequence must be globally unique");
    }
    this.#pendingStructures.push(clone(checked));
    this.#pendingStructures.sort((left, right) => left.tick - right.tick ||
      left.sequence - right.sequence || sideRank(left.side) - sideRank(right.side));
    this.#appendHistory({ command: clone(checked), type: "structure-deploy" });
    const event = { ...clone(checked), scheduledAt: battle.state.tick,
      type: "structure-deploy-scheduled" };
    this.#events.push(event);
    return freeze(clone(event));
  }

  /**
   * Pure current-boundary inspection for legacy GameSession action replay.
   * Current profiles intentionally expose no player-triggered action.
   */
  inspectTroopAction(serialized) {
    const command = parsedCommandBytes(serialized, "live battle troop action");
    return this.#inspectTroopActionChecked(command);
  }

  #inspectTroopActionChecked(command) {
    const action = checkedTroopAction(command, this.#battleRuntime().state.tick);
    if (!this.#allowsLegacyTroopActions()) {
      throw new RangeError("current live battle troop runtime does not admit player actions");
    }
    if (action.targetId === null || action.point !== null) {
      throw new RangeError("live battle troop action requires exactly one unit target");
    }
    const source = this.#troopSource(action.sourceId, { requireAlive: true });
    if (source.side !== action.side) {
      throw new RangeError("live battle troop action source side is divergent");
    }
    const target = this.#troopSource(action.targetId, { requireAlive: true });
    if (target.side === source.side) {
      throw new RangeError("live battle troop action target must be opposing");
    }
    const inspected = this.#troopRuntime.inspectAction({ action, source });
    if (inspected.effect === "source-melee-contact") {
      this.#representativeContact(action, source, target);
    }
    return freeze(clone(inspected));
  }

  scheduleTroopAction(serialized) {
    const command = parsedCommandBytes(serialized, "live battle troop action");
    return this.#scheduleTroopActionChecked(command);
  }

  #scheduleTroopActionChecked(command) {
    if (this.#historyCount >= MAX_HISTORY ||
        this.#pendingTroopActions.length >= MAX_LIVE_BATTLE_TROOP_ACTIONS) {
      throw new RangeError("live battle troop action/history bound exceeded");
    }
    const action = checkedTroopAction(command, this.#battleRuntime().state.tick);
    this.#inspectTroopActionChecked(action);
    if (this.#pendingTroopActions.some((entry) => entry.side === action.side &&
        entry.commandId === action.commandId) || this.#history.some((entry) =>
      entry.type === "action" && entry.command.side === action.side &&
        entry.command.commandId === action.commandId)) {
      throw new RangeError("live battle troop action identity is duplicate");
    }
    this.#pendingTroopActions.push(clone(action));
    this.#pendingTroopActions.sort((left, right) => left.tick - right.tick ||
      sideRank(left.side) - sideRank(right.side) || left.commandId - right.commandId);
    this.#appendHistory({ command: clone(action), type: "action" });
    const event = { ...clone(action), scheduledAt: this.#battleRuntime().state.tick,
      type: "troop-action-scheduled" };
    this.#events.push(event);
    return freeze(clone(event));
  }

  /** Pure admission for the narrow status-runtime command route. */
  inspectTroopStatus(serialized) {
    const command = parsedCommandBytes(serialized, "live battle troop status action");
    return this.#inspectTroopStatusChecked(command);
  }

  #statusTargetLayerEligible(source, target, effect) {
    // Heal's sourced eligibility is living troop only; its ordinary attack
    // target mode is not evidence for a healing-layer restriction. The
    // control profiles that actually claim a layer policy are ground-and-air
    // in the admitted roster. A structures attack mode has no sourced status
    // target-class claim, so retain the existing explicit unit witness until
    // that question is resolved rather than inventing one.
    if (effect === "heal" || source.targetMode === "buildings") return true;
    return layerEligible(source.targetMode, target.layer);
  }

  #statusAdmission(action, state = this.#battleRuntime().state, { checkIdentity = false } = {}) {
    if (!this.#hasStatusRuntime()) {
      throw new RangeError("live battle troop status action has no admitted status profile");
    }
    this.#statusRuntime.assertSourceRoster(this.#setup.roster, this.#setup.questions);
    if (action.point !== null) {
      throw new RangeError("live battle troop status action must be point-free");
    }
    if (checkIdentity && (this.#pendingTroopStatusActions.some((entry) =>
        entry.side === action.side && entry.commandId === action.commandId) ||
        this.#pendingTroopActions.some((entry) =>
          entry.side === action.side && entry.commandId === action.commandId) ||
        this.#history.some((entry) => ["action", "status"].includes(entry.type) &&
          entry.command.side === action.side && entry.command.commandId === action.commandId))) {
      throw new RangeError("live battle troop status action identity is duplicate");
    }
    const sourceUnit = state.units.find(({ id }) => id === action.sourceId);
    const sourceMetadata = this.#metadata.get(action.sourceId);
    const sourceCard = sourceMetadata === undefined ? null : this.#rosterById.get(sourceMetadata.cardId);
    if (sourceUnit === undefined || sourceMetadata === undefined || sourceCard?.kind !== "unit") {
      throw new RangeError("live battle troop status source is unknown");
    }
    if (!sourceUnit.alive) {
      throw new RangeError("live battle troop status source is not live");
    }
    if (sourceUnit.side !== action.side) {
      throw new RangeError("live battle troop status action source side is divergent");
    }
    const resolved = this.#statusRuntime.inspect({
      actionId: action.actionId,
      cardId: sourceMetadata.cardId,
      sourceId: action.sourceId,
      targetId: action.targetId,
    });
    const source = {
      cardId: sourceMetadata.cardId,
      id: sourceUnit.id,
      kind: "unit",
      layer: sourceUnit.layer,
      side: sourceUnit.side,
      sourceId: sourceUnit.id,
      targetMode: sourceUnit.targetMode,
    };
    let target = null;
    if (action.targetId !== null) {
      const targetUnit = state.units.find(({ id }) => id === action.targetId);
      const targetMetadata = this.#metadata.get(action.targetId);
      const targetCard = targetMetadata === undefined ? null : this.#rosterById.get(targetMetadata.cardId);
      if (targetUnit === undefined) {
        if (this.#structures.some(({ id }) => id === action.targetId)) {
          throw new RangeError("live battle troop status target kind is not eligible");
        }
        throw new RangeError("live battle troop status target is unknown");
      }
      if (targetMetadata === undefined || targetCard?.kind !== "unit") {
        throw new RangeError("live battle troop status target kind is not eligible");
      }
      if (!targetUnit.alive) {
        throw new RangeError("live battle troop status target is not live");
      }
      const friendly = resolved.effect === "heal";
      if ((friendly && targetUnit.side !== sourceUnit.side) ||
          (!friendly && targetUnit.side === sourceUnit.side)) {
        throw new RangeError(`live battle troop status target ${friendly ? "must be friendly" : "must be opposing"}`);
      }
      if (!this.#statusTargetLayerEligible(sourceUnit, targetUnit, resolved.effect)) {
        throw new RangeError("live battle troop status target layer is not eligible");
      }
      if (!friendly && !this.#statusTargetable(targetUnit.id, state.tick)) {
        throw new RangeError("live battle troop status target is not targetable");
      }
      target = {
        alive: true,
        id: targetUnit.id,
        kind: "unit",
        layer: targetUnit.layer,
        side: targetUnit.side,
        targetable: this.#statusTargetable(targetUnit.id, state.tick),
      };
    }
    return freeze(clone({
      actionId: action.actionId,
      cardId: source.cardId,
      commandId: action.commandId,
      effect: resolved.effect,
      parameters: resolved.parameters,
      phase: "pre-move",
      side: action.side,
      source,
      sourceId: action.sourceId,
      target,
      targetId: action.targetId,
      tick: action.tick,
      type: "troop-status-admission",
    }));
  }

  #inspectTroopStatusChecked(command) {
    const state = this.#battleRuntime().state;
    const action = checkedTroopStatusAction(command, state.tick);
    const admission = this.#statusAdmission(action, state);
    return freeze(clone({
      actionId: admission.actionId,
      cardId: admission.cardId,
      effect: admission.effect,
      parameters: admission.parameters,
      source: admission.source,
      sourceId: admission.sourceId,
      target: admission.target,
      targetId: admission.targetId,
      type: "troop-status-inspection",
    }));
  }

  scheduleTroopStatus(serialized) {
    const command = parsedCommandBytes(serialized, "live battle troop status action");
    return this.#scheduleTroopStatusChecked(command);
  }

  #scheduleTroopStatusChecked(command) {
    if (this.#historyCount >= MAX_HISTORY ||
        this.#pendingTroopStatusActions.length >= SESSION_TROOP_STATUS_RUNTIME_MAX_COMMANDS) {
      throw new RangeError("live battle troop status action/history bound exceeded");
    }
    const state = this.#battleRuntime().state;
    const action = checkedTroopStatusAction(command, state.tick);
    this.#statusAdmission(action, state, { checkIdentity: true });
    this.#pendingTroopStatusActions.push(clone(action));
    this.#pendingTroopStatusActions.sort((left, right) => left.tick - right.tick ||
      sideRank(left.side) - sideRank(right.side) || left.commandId - right.commandId);
    this.#appendHistory({ command: clone(action), type: "status" });
    const event = { ...clone(action), scheduledAt: this.#battleRuntime().state.tick,
      type: "troop-status-scheduled" };
    this.#events.push(event);
    return freeze(clone(event));
  }

  step(tick = this.#battleRuntime().state.tick) {
    integer(tick, 0, MAX_LIVE_BATTLE_STEP_TICKS, "live battle step tick");
    if (tick !== this.#battleRuntime().state.tick) throw new RangeError("live battle step tick is not current");
    if (this.#historyCount >= MAX_HISTORY) throw new RangeError("live battle history bound exceeded");
    this.#preflightBoundary();
    const candidate = this.#runtimeClone();
    const events = candidate.#advance();
    this.#adopt(candidate);
    return freeze(clone(events));
  }

  stepMany(ticks) {
    integer(ticks, 0, MAX_LIVE_BATTLE_STEP_TICKS, "live battle step ticks");
    if (this.#battleRuntime().state.tick + ticks > MAX_LIVE_BATTLE_STEP_TICKS) {
      throw new RangeError("live battle tick bound exceeded");
    }
    if (this.#historyCount + ticks > MAX_HISTORY) throw new RangeError("live battle history bound exceeded");
    const candidate = this.#runtimeClone();
    const events = [];
    for (let count = 0; count < ticks; count += 1) events.push(...candidate.#advance());
    this.#adopt(candidate);
    return freeze(clone(events));
  }

  /**
   * Closure-private fast path for GameSession's already-isolated candidate.
   * Public callers retain stepMany()'s independent clone/adopt transaction;
   * any failure here instead discards the enclosing GameSession candidate.
   */
  #advanceFromSession(ticks) {
    integer(ticks, 0, MAX_LIVE_BATTLE_STEP_TICKS, "live battle session advance ticks");
    // GameSession has already checked its synchronized match-clock boundary
    // before constructing this candidate. Reading BattleTowerCombat.state here
    // would clone every active unit only to repeat that same 18,000-tick cap;
    // #advance() obtains the one authoritative pre-boundary snapshot below.
    if (this.#historyCount + ticks > MAX_HISTORY) {
      throw new RangeError("live battle history bound exceeded");
    }
    const events = [];
    for (let count = 0; count < ticks; count += 1) events.push(...this.#advance());
    return events;
  }

  serialize() {
    this.#assertPublicTranscript();
    const tailStart = Math.max(0, this.#history.length - EXPLICIT_HISTORY_TAIL);
    const hasBuildingState = this.#structures.length > 0 || this.#pendingStructures.length > 0 ||
      this.#pendingBuildingHits.length > 0;
    const hasSpellRuntime = this.#spells !== null;
    const hasProjectileRuntime = this.#projectileRuntime !== null;
    const common = {
      battle: this.#battleRuntime().serialize(),
      history: this.#history.slice(tailStart),
      movements: movementWitnesses(this.#movementRuntimes(), this.#metadata),
      ...(hasProjectileRuntime ? { projectileRuntime: this.#projectileRuntime.serialize() } : {}),
      ...(this.#chainContinuation === null ? {} : {
        chainContinuation: this.#chainContinuation.serialize(),
      }),
      setup: this.#setup,
      transcript: compactLiveHistory(this.#history.slice(0, tailStart)),
    };
    let snapshot;
    if (this.#hasStatusRuntime()) {
      const statusRuntime = {
        configuration: this.#statusRuntime.serialize(),
        effects: this.#statusEffectWitnesses(),
        pending: clone(this.#pendingTroopStatusActions),
      };
      if (!this.#hasTroopRuntime()) {
        snapshot = {
          ...common,
          ...(hasBuildingState ? { building: this.#buildingWitness() } : {}),
          ...(hasSpellRuntime ? { spellRuntime: this.#spells.state } : {}),
          statusRuntime,
          version: 15 + (hasBuildingState ? 1 : 0) + (hasSpellRuntime ? 2 : 0),
        };
      } else if (this.#troopRuntime.version === SESSION_TROOP_RUNTIME_LEGACY_VERSION) {
        snapshot = {
          ...common,
          pendingTroopActions: this.#pendingTroopActions,
          runtime: this.#troopRuntime.serialize(),
          ...(hasSpellRuntime ? { spellRuntime: this.#spells.state } : {}),
          statusRuntime,
          troopStatuses: this.#troopStatusWitnesses(),
          version: 19 + (hasBuildingState ? 1 : 0) + (hasSpellRuntime ? 2 : 0),
        };
      } else if (this.#troopRuntime.version === SESSION_TROOP_RUNTIME_ACTION_PROFILE_VERSION) {
        snapshot = {
          ...common,
          pendingTroopActions: this.#pendingTroopActions,
          runtime: this.#troopRuntime.serialize(),
          ...(hasSpellRuntime ? { spellRuntime: this.#spells.state } : {}),
          statusRuntime,
          troopStatuses: this.#troopStatusWitnesses(),
          version: 23 + (hasBuildingState ? 1 : 0) + (hasSpellRuntime ? 2 : 0),
        };
      } else if (this.#troopRuntime.version === SESSION_TROOP_RUNTIME_MOVEMENT_VERSION) {
        snapshot = {
          ...common,
          runtime: this.#troopRuntime.serialize(),
          ...(hasSpellRuntime ? { spellRuntime: this.#spells.state } : {}),
          statusRuntime,
          troopStatuses: this.#troopStatusWitnesses(),
          version: 35 + (hasBuildingState ? 1 : 0) + (hasSpellRuntime ? 2 : 0),
        };
      } else {
        snapshot = {
          ...common,
          runtime: this.#troopRuntime.serialize(),
          ...(hasSpellRuntime ? { spellRuntime: this.#spells.state } : {}),
          statusRuntime,
          troopStatuses: this.#troopStatusWitnesses(),
          version: 27 + (hasBuildingState ? 1 : 0) + (hasSpellRuntime ? 2 : 0),
        };
      }
    } else if (!this.#hasTroopRuntime()) {
      snapshot = hasSpellRuntime
        ? { ...common, ...(hasBuildingState ? { building: this.#buildingWitness() } : {}),
          spellRuntime: this.#spells.state, version: hasBuildingState ? 8 : 3 }
        : { ...common, version: hasBuildingState ? 3 : 2 };
    } else if (this.#troopRuntime.version === SESSION_TROOP_RUNTIME_LEGACY_VERSION) {
      snapshot = {
        ...common,
        pendingTroopActions: this.#pendingTroopActions,
        runtime: this.#troopRuntime.serialize(),
        ...(hasSpellRuntime ? { spellRuntime: this.#spells.state } : {}),
        troopStatuses: this.#troopStatusWitnesses(),
        version: hasSpellRuntime ? (hasBuildingState ? 10 : 9) : (hasBuildingState ? 6 : 3),
      };
    } else if (this.#troopRuntime.version === SESSION_TROOP_RUNTIME_ACTION_PROFILE_VERSION) {
      snapshot = {
        ...common,
        pendingTroopActions: this.#pendingTroopActions,
        runtime: this.#troopRuntime.serialize(),
        ...(hasSpellRuntime ? { spellRuntime: this.#spells.state } : {}),
        troopStatuses: this.#troopStatusWitnesses(),
        version: hasSpellRuntime ? (hasBuildingState ? 12 : 11) : (hasBuildingState ? 7 : 4),
      };
    } else if (this.#troopRuntime.version === SESSION_TROOP_RUNTIME_MOVEMENT_VERSION) {
      snapshot = {
        ...common,
        runtime: this.#troopRuntime.serialize(),
        ...(hasSpellRuntime ? { spellRuntime: this.#spells.state } : {}),
        troopStatuses: this.#troopStatusWitnesses(),
        version: hasSpellRuntime ? (hasBuildingState ? 34 : 33) : (hasBuildingState ? 32 : 31),
      };
    } else {
      // Current v3 has no player action queue. A building witness is additive
      // only when a shared structure has actually materialized or queued work.
      snapshot = {
        ...common,
        runtime: this.#troopRuntime.serialize(),
        ...(hasSpellRuntime ? { spellRuntime: this.#spells.state } : {}),
        troopStatuses: this.#troopStatusWitnesses(),
        version: hasSpellRuntime ? (hasBuildingState ? 14 : 13) : 5,
      };
    }
    if (hasBuildingState && !Object.hasOwn(snapshot, "building")) {
      snapshot.building = this.#buildingWitness();
    }
    const serialized = canonical(snapshot);
    if (new TextEncoder().encode(serialized).byteLength > MAX_SNAPSHOT_BYTES) {
      throw new RangeError("serialized live battle exceeds the byte bound");
    }
    return serialized;
  }

  static restore(serialized, projectileRuntimePlan = undefined) {
    if (typeof serialized !== "string") throw new TypeError("serialized live battle must be a string");
    if (new TextEncoder().encode(serialized).byteLength > MAX_SNAPSHOT_BYTES) {
      throw new RangeError("serialized live battle exceeds the byte bound");
    }
    let snapshot;
    try { snapshot = JSON.parse(serialized); }
    catch { throw new TypeError("serialized live battle must be valid JSON"); }
    preflightParsedGraph(snapshot, SNAPSHOT_GRAPH_LIMITS, "live battle snapshot");
    if (canonical(snapshot) !== serialized) throw new TypeError("serialized live battle must be canonical JSON");
    const snapshotShape = plain(snapshot, "live battle snapshot");
    const version = snapshotShape.version?.value;
    const hasStatusRuntimeWitness = [
      15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30,
      35, 36, 37, 38,
    ].includes(version);
    const hasBuildingWitness = Object.hasOwn(snapshot, "building");
    const hasSpellRuntimeWitness = (version === 3 && !hasBuildingWitness &&
      Object.hasOwn(snapshot, "spellRuntime")) || [8, 9, 10, 11, 12, 13, 14].includes(version) ||
      [17, 18, 21, 22, 25, 26, 29, 30, 33, 34, 37, 38].includes(version);
    const hasProjectileRuntimeWitness = Object.hasOwn(snapshot, "projectileRuntime");
    const projectileRuntimeSnapshot = hasProjectileRuntimeWitness
      ? snapshot.projectileRuntime : null;
    const hasChainContinuationWitness = Object.hasOwn(snapshot, "chainContinuation");
    const chainContinuationSnapshot = hasChainContinuationWitness
      ? snapshot.chainContinuation : null;
    const legacyRuntimeSnapshot = (version === 3 && !hasBuildingWitness &&
      !hasSpellRuntimeWitness) || [4, 6, 7, 9, 10, 11, 12].includes(version) ||
      [19, 20, 21, 22].includes(version);
    const actionRuntimeSnapshot = [4, 7, 11, 12, 23, 24, 25, 26].includes(version);
    const currentRuntimeSnapshot = [5, 13, 14, 27, 28, 29, 30].includes(version);
    const movementRuntimeSnapshot = [31, 32, 33, 34, 35, 36, 37, 38].includes(version);
    const hasTroopRuntimeWitness = legacyRuntimeSnapshot || actionRuntimeSnapshot ||
      currentRuntimeSnapshot || movementRuntimeSnapshot;
    // Optional runtime witnesses are additive to every existing LiveBattle
    // snapshot version. Strip them only for the historical shape table below;
    // each is validated and replay-checked separately.
    if (hasProjectileRuntimeWitness || hasChainContinuationWitness) {
      snapshot = Object.fromEntries(Object.entries(snapshot)
        .filter(([key]) => key !== "projectileRuntime" && key !== "chainContinuation"));
    }
    let checked;
    if (version === 15) {
      checked = exact(snapshot, ["battle", "history", "movements", "setup", "statusRuntime",
        "transcript", "version"], "live battle snapshot");
    } else if (version === 16) {
      checked = exact(snapshot, ["battle", "building", "history", "movements", "setup", "statusRuntime",
        "transcript", "version"], "live battle snapshot");
    } else if (version === 17) {
      checked = exact(snapshot, ["battle", "history", "movements", "setup", "spellRuntime", "statusRuntime",
        "transcript", "version"], "live battle snapshot");
    } else if (version === 18) {
      checked = exact(snapshot, ["battle", "building", "history", "movements", "setup", "spellRuntime",
        "statusRuntime", "transcript", "version"], "live battle snapshot");
    } else if (version === 19 || version === 23 || version === 27) {
      checked = exact(snapshot, ["battle", "history", "movements", ...(version === 19 || version === 23 ? ["pendingTroopActions"] : []),
        ...(version >= 19 ? ["runtime"] : []), "setup", "statusRuntime", "transcript", "troopStatuses", "version"],
      "live battle snapshot");
    } else if (version === 20 || version === 24 || version === 28) {
      checked = exact(snapshot, ["battle", "building", "history", "movements", ...(version === 20 || version === 24 ? ["pendingTroopActions"] : []),
        "runtime", "setup", "statusRuntime", "transcript", "troopStatuses", "version"],
      "live battle snapshot");
    } else if (version === 21 || version === 25 || version === 29) {
      checked = exact(snapshot, ["battle", "history", "movements", ...(version === 21 || version === 25 ? ["pendingTroopActions"] : []),
        "runtime", "setup", "spellRuntime", "statusRuntime", "transcript", "troopStatuses", "version"],
      "live battle snapshot");
    } else if (version === 22 || version === 26 || version === 30) {
      checked = exact(snapshot, ["battle", "building", "history", "movements", ...(version === 22 || version === 26 ? ["pendingTroopActions"] : []),
        "runtime", "setup", "spellRuntime", "statusRuntime", "transcript", "troopStatuses", "version"],
      "live battle snapshot");
    } else if (version === 31) {
      checked = exact(snapshot, ["battle", "history", "movements", "runtime", "setup", "transcript",
        "troopStatuses", "version"], "live battle snapshot");
    } else if (version === 32) {
      checked = exact(snapshot, ["battle", "building", "history", "movements", "runtime", "setup",
        "transcript", "troopStatuses", "version"], "live battle snapshot");
    } else if (version === 33) {
      checked = exact(snapshot, ["battle", "history", "movements", "runtime", "setup", "spellRuntime",
        "transcript", "troopStatuses", "version"], "live battle snapshot");
    } else if (version === 34) {
      checked = exact(snapshot, ["battle", "building", "history", "movements", "runtime", "setup",
        "spellRuntime", "transcript", "troopStatuses", "version"], "live battle snapshot");
    } else if (version === 35) {
      checked = exact(snapshot, ["battle", "history", "movements", "runtime", "setup", "statusRuntime",
        "transcript", "troopStatuses", "version"], "live battle snapshot");
    } else if (version === 36) {
      checked = exact(snapshot, ["battle", "building", "history", "movements", "runtime", "setup",
        "statusRuntime", "transcript", "troopStatuses", "version"], "live battle snapshot");
    } else if (version === 37) {
      checked = exact(snapshot, ["battle", "history", "movements", "runtime", "setup", "spellRuntime",
        "statusRuntime", "transcript", "troopStatuses", "version"], "live battle snapshot");
    } else if (version === 38) {
      checked = exact(snapshot, ["battle", "building", "history", "movements", "runtime", "setup",
        "spellRuntime", "statusRuntime", "transcript", "troopStatuses", "version"],
      "live battle snapshot");
    } else if (version === 1) {
      checked = exact(snapshot, ["battle", "history", "movements", "setup", "version"],
        "live battle snapshot");
    } else if (version === 2) {
      checked = exact(snapshot, ["battle", "history", "movements", "setup", "transcript", "version"],
        "live battle snapshot");
    } else if (version === 3 && hasBuildingWitness) {
      checked = exact(snapshot, ["battle", "building", "history", "movements", "setup", "transcript", "version"],
        "live battle snapshot");
    } else if (version === 3 && hasSpellRuntimeWitness) {
      checked = exact(snapshot, ["battle", "history", "movements", "setup", "spellRuntime",
        "transcript", "version"], "live battle snapshot");
    } else if (version === 3 || version === 4) {
      checked = exact(snapshot, ["battle", "history", "movements", "pendingTroopActions", "runtime",
        "setup", "transcript", "troopStatuses", "version"], "live battle snapshot");
    } else if (version === 5) {
      checked = exact(snapshot, hasBuildingWitness
        ? ["battle", "building", "history", "movements", "runtime", "setup", "transcript",
          "troopStatuses", "version"]
        : ["battle", "history", "movements", "runtime", "setup", "transcript", "troopStatuses",
          "version"], "live battle snapshot");
    } else if (version === 6 || version === 7) {
      checked = exact(snapshot, ["battle", "building", "history", "movements", "pendingTroopActions",
        "runtime", "setup", "transcript", "troopStatuses", "version"], "live battle snapshot");
    } else if (version === 8) {
      checked = exact(snapshot, ["battle", "building", "history", "movements", "setup", "spellRuntime",
        "transcript", "version"], "live battle snapshot");
    } else if (version === 9 || version === 11) {
      checked = exact(snapshot, ["battle", "history", "movements", "pendingTroopActions", "runtime",
        "setup", "spellRuntime", "transcript", "troopStatuses", "version"],
      "live battle snapshot");
    } else if (version === 10 || version === 12) {
      checked = exact(snapshot, ["battle", "building", "history", "movements", "pendingTroopActions",
        "runtime", "setup", "spellRuntime", "transcript", "troopStatuses", "version"],
      "live battle snapshot");
    } else if (version === 13) {
      checked = exact(snapshot, ["battle", "history", "movements", "runtime", "setup", "spellRuntime",
        "transcript", "troopStatuses", "version"], "live battle snapshot");
    } else if (version === 14) {
      checked = exact(snapshot, ["battle", "building", "history", "movements", "runtime", "setup",
        "spellRuntime", "transcript", "troopStatuses", "version"], "live battle snapshot");
    } else {
      throw new TypeError("unsupported live battle snapshot version");
    }
    const history = denseArray(checked.history, "live battle snapshot.history", MAX_HISTORY);
    const transcript = version >= 2
      ? denseArray(checked.transcript, "live battle snapshot.transcript", MAX_HISTORY)
      : [];
    let runtimeBytes;
    let pendingTroopActions = [];
    let troopStatuses = [];
    if (hasTroopRuntimeWitness) {
      if (typeof checked.runtime !== "string") {
        throw new TypeError("live battle troop runtime witness must be canonical JSON text");
      }
      const runtime = SessionTroopRuntime.restore(checked.runtime);
      const expectedRuntimeVersion = version === 3 || version === 6 || version === 9 || version === 10 ||
        version === 19 || version === 20 || version === 21 || version === 22
        ? SESSION_TROOP_RUNTIME_LEGACY_VERSION
        : version === 4 || version === 7 || version === 11 || version === 12 ||
            version === 23 || version === 24 || version === 25 || version === 26
          ? SESSION_TROOP_RUNTIME_ACTION_PROFILE_VERSION
          : movementRuntimeSnapshot
            ? SESSION_TROOP_RUNTIME_MOVEMENT_VERSION
            : SESSION_TROOP_RUNTIME_VERSION;
      if (runtime.configuration.profiles.length === 0 || runtime.serialize() !== checked.runtime ||
          runtime.configuration.version !== expectedRuntimeVersion) {
        throw new TypeError("live battle troop runtime witness is noncanonical");
      }
      runtimeBytes = runtime.serialize();
      if (legacyRuntimeSnapshot || actionRuntimeSnapshot) {
        pendingTroopActions = denseArray(checked.pendingTroopActions,
          "live battle snapshot.pendingTroopActions", MAX_LIVE_BATTLE_TROOP_ACTIONS)
          .map((action) => checkedTroopAction(action, 0, { requireCurrent: false }));
        pendingTroopActions.sort((left, right) => left.tick - right.tick ||
          sideRank(left.side) - sideRank(right.side) || left.commandId - right.commandId);
        if (canonical(pendingTroopActions) !== canonical(checked.pendingTroopActions) ||
            new Set(pendingTroopActions.map(({ commandId, side }) => `${side}:${commandId}`)).size !==
              pendingTroopActions.length) {
          throw new TypeError("live battle pending troop actions are noncanonical");
        }
      }
      const rawTroopStatuses = denseArray(checked.troopStatuses,
        "live battle snapshot.troopStatuses", TROOP_STATUS_LIMIT);
      if (movementRuntimeSnapshot && rawTroopStatuses.length !== 0) {
        throw new TypeError("live battle movement runtime cannot carry troop status state");
      }
      troopStatuses = movementRuntimeSnapshot ? [] : rawTroopStatuses.map((status) =>
        checkedTroopStatus(status, {
          profile: runtime.profile(status.cardId),
          version: runtime.version,
        }))
        .sort((left, right) => left.key.localeCompare(right.key));
      if (canonical(troopStatuses) !== canonical(checked.troopStatuses) ||
          new Set(troopStatuses.map(({ key }) => key)).size !== troopStatuses.length) {
        throw new TypeError("live battle troop statuses are noncanonical");
      }
    }
    let statusRuntimeBytes;
    let statusEffects = [];
    let pendingTroopStatusActions = [];
    if (hasStatusRuntimeWitness) {
      const witness = exact(checked.statusRuntime, ["configuration", "effects", "pending"],
        "live battle status runtime witness");
      if (typeof witness.configuration !== "string") {
        throw new TypeError("live battle status runtime configuration must be canonical JSON text");
      }
      const statusRuntime = new SessionTroopStatusRuntime(witness.configuration);
      if (statusRuntime.serialize() !== witness.configuration) {
        throw new TypeError("live battle status runtime configuration is noncanonical");
      }
      statusRuntimeBytes = statusRuntime.serialize();
      statusEffects = denseArray(witness.effects, "live battle status runtime effects",
        MAX_LIVE_BATTLE_UNITS).map((effect, index) => {
          const checkedEffect = exact(effect,
            ["hides", "revealUntil", "slow", "snare", "stun", "targetId"],
            `live battle status runtime effects[${index}]`);
          integer(checkedEffect.targetId, 1, Number.MAX_SAFE_INTEGER,
            `live battle status runtime effects[${index}].targetId`);
          if (!Array.isArray(checkedEffect.hides) || checkedEffect.hides.length > MAX_LIVE_BATTLE_UNITS) {
            throw new TypeError("live battle status runtime hide witness is invalid");
          }
          const hides = checkedEffect.hides.map((hide, hideIndex) => {
            const checkedHide = exact(hide, ["applyTick", "expiryTick", "sourceId"],
              `live battle status runtime hide ${index}/${hideIndex}`);
            const applyTick = integer(checkedHide.applyTick, 0, MAX_LIVE_BATTLE_STEP_TICKS,
              "status hide applyTick");
            const expiryTick = integer(checkedHide.expiryTick, 0, MAX_LIVE_BATTLE_STEP_TICKS,
              "status hide expiryTick");
            if (expiryTick < applyTick) throw new TypeError("status hide interval is inverted");
            return {
              applyTick,
              expiryTick,
              sourceId: integer(checkedHide.sourceId, 1, Number.MAX_SAFE_INTEGER,
                "status hide sourceId"),
            };
          }).sort((left, right) => left.sourceId - right.sourceId);
          const checkedRecord = (record, label) => {
            if (record === null) return null;
            const checkedRecordValue = exact(record,
              ["applyTick", "expiryTick", "sourceId"], label);
            const applyTick = integer(checkedRecordValue.applyTick, 0, MAX_LIVE_BATTLE_STEP_TICKS,
              `${label}.applyTick`);
            const expiryTick = integer(checkedRecordValue.expiryTick, 0, MAX_LIVE_BATTLE_STEP_TICKS,
              `${label}.expiryTick`);
            if (expiryTick < applyTick) throw new TypeError(`${label} interval is inverted`);
            return {
              applyTick,
              expiryTick,
              sourceId: integer(checkedRecordValue.sourceId, 1, Number.MAX_SAFE_INTEGER,
                `${label}.sourceId`),
            };
          };
          const checkedSlow = checkedEffect.slow === null ? null : (() => {
            const slow = exact(checkedEffect.slow,
              ["applyTick", "attackRate", "attackRemainder", "expiryTick", "movementRate",
                "movementRemainder", "sourceId"],
              `live battle status runtime effects[${index}].slow`);
            const rate = (value, label) => {
              const checkedRateValue = exact(value, ["denominator", "numerator"], label);
              const denominator = integer(checkedRateValue.denominator, 1, Number.MAX_SAFE_INTEGER,
                `${label}.denominator`);
              const numerator = integer(checkedRateValue.numerator, 1, denominator - 1,
                `${label}.numerator`);
              return {
                denominator,
                numerator,
              };
            };
            const applyTick = integer(slow.applyTick, 0, MAX_LIVE_BATTLE_STEP_TICKS,
              "status slow applyTick");
            const expiryTick = integer(slow.expiryTick, 0, MAX_LIVE_BATTLE_STEP_TICKS,
              "status slow expiryTick");
            if (expiryTick < applyTick) throw new TypeError("status slow interval is inverted");
            const attackRate = rate(slow.attackRate, "status slow attackRate");
            const movementRate = rate(slow.movementRate, "status slow movementRate");
            return {
              applyTick,
              attackRate,
              attackRemainder: integer(slow.attackRemainder, 0, attackRate.denominator - 1,
                "status slow attackRemainder"),
              expiryTick,
              movementRate,
              movementRemainder: integer(slow.movementRemainder, 0, movementRate.denominator - 1,
                "status slow movementRemainder"),
              sourceId: integer(slow.sourceId, 1, Number.MAX_SAFE_INTEGER, "status slow sourceId"),
            };
          })();
          const revealUntil = checkedEffect.revealUntil === null ? null : integer(
            checkedEffect.revealUntil, 0, MAX_LIVE_BATTLE_STEP_TICKS,
            `live battle status runtime effects[${index}].revealUntil`);
          return {
            hides,
            revealUntil,
            slow: checkedSlow,
            snare: checkedRecord(checkedEffect.snare,
              `live battle status runtime effects[${index}].snare`),
            stun: checkedRecord(checkedEffect.stun,
              `live battle status runtime effects[${index}].stun`),
            targetId: checkedEffect.targetId,
          };
        }).sort((left, right) => left.targetId - right.targetId);
      if (canonical(statusEffects) !== canonical(witness.effects) ||
          new Set(statusEffects.map(({ targetId }) => targetId)).size !== statusEffects.length) {
        throw new TypeError("live battle status runtime effects are noncanonical");
      }
      pendingTroopStatusActions = denseArray(witness.pending,
        "live battle status runtime pending", SESSION_TROOP_STATUS_RUNTIME_MAX_COMMANDS)
        .map((action) => checkedTroopStatusAction(action, 0, { requireCurrent: false }))
        .sort((left, right) => left.tick - right.tick || sideRank(left.side) - sideRank(right.side) ||
          left.commandId - right.commandId);
      if (canonical(pendingTroopStatusActions) !== canonical(witness.pending) ||
          new Set(pendingTroopStatusActions.map(({ side, commandId }) => `${side}:${commandId}`)).size !==
            pendingTroopStatusActions.length) {
        throw new TypeError("live battle status runtime pending actions are noncanonical");
      }
    }
    let projectileRuntime = null;
    if (hasProjectileRuntimeWitness) {
      if (typeof projectileRuntimeSnapshot !== "string") {
        throw new TypeError("live battle projectile runtime witness must be canonical JSON text");
      }
      projectileRuntime = SessionTroopProjectileRuntime.restore(projectileRuntimeSnapshot,
        projectileRuntimePlan);
      if (projectileRuntime.serialize() !== projectileRuntimeSnapshot) {
        throw new TypeError("live battle projectile runtime witness is noncanonical");
      }
    }
    let spellRuntimeState = null;
    if (hasSpellRuntimeWitness) {
      const witness = exact(checked.spellRuntime, ["nextEffectId", "pending", "version"],
        "live battle spell runtime witness");
      if (![1, 2].includes(witness.version) || !Number.isSafeInteger(witness.nextEffectId) ||
          witness.nextEffectId < 1 || !Array.isArray(witness.pending) ||
          witness.pending.length > MAX_LIVE_BATTLE_DEPLOYMENTS) {
        throw new TypeError("live battle spell runtime witness is noncanonical");
      }
      spellRuntimeState = clone(witness);
    }
    let expandedOperations = history.length;
    for (let index = 0; index < transcript.length; index += 1) {
      const descriptors = plain(transcript[index], `live battle snapshot.transcript[${index}]`);
      let added = 1;
      if (descriptors.type?.value === "step-run") {
        const tick = integer(descriptors.tick?.value, 0, MAX_LIVE_BATTLE_STEP_TICKS,
          `transcript[${index}].tick`);
        added = integer(descriptors.ticks?.value, 1, MAX_HISTORY, `transcript[${index}].ticks`);
        if (added > MAX_LIVE_BATTLE_STEP_TICKS - tick) {
          throw new RangeError("live battle transcript tick bound exceeded");
        }
      }
      if (added > MAX_HISTORY - expandedOperations) {
        throw new RangeError("live battle transcript operation bound exceeded");
      }
      expandedOperations += added;
    }
    // Versions 1 and 2 predate canonical building receipts. Later witnesses
    // are fresh-admitted, including the ambiguous v3 building/legacy-troop fork.
    const restored = new LiveBattle(checkedSetup(checked.setup,
      { legacyStructureReceipts: version <= 2 }), runtimeBytes, statusRuntimeBytes,
      projectileRuntimePlan);
    if ((restored.#chainContinuation !== null) !== hasChainContinuationWitness) {
      throw new TypeError("live battle chain witness presence diverges from its admitted setup");
    }
    if (hasChainContinuationWitness) {
      if (typeof chainContinuationSnapshot !== "string") {
        throw new TypeError("live battle chain witness must be canonical JSON text");
      }
      LiveBattleChainContinuation.restore(chainContinuationSnapshot,
        restored.#chainContinuation.policy);
    }
    const replayOperation = (operation, index, label) => {
      plain(operation, `live battle snapshot.history[${index}]`);
      if (operation.type === "deploy") {
        const entry = exact(operation, ["command", "type"], `history[${index}]`);
        restored.#scheduleDeployChecked(entry.command);
      } else if (operation.type === "structure-deploy") {
        const entry = exact(operation, ["command", "type"], `history[${index}]`);
        restored.#scheduleStructureChecked(entry.command);
      } else if (operation.type === "action") {
        const entry = exact(operation, ["command", "type"], `history[${index}]`);
        restored.#scheduleTroopActionChecked(entry.command);
      } else if (operation.type === "status") {
        const entry = exact(operation, ["command", "type"], `history[${index}]`);
        restored.#scheduleTroopStatusChecked(entry.command);
      } else if (operation.type === "spell") {
        if (!hasSpellRuntimeWitness) {
          throw new TypeError("legacy live battle snapshot cannot contain spell intents");
        }
        const entry = exact(operation, ["command", "type"], `history[${index}]`);
        restored.scheduleSpell(entry.command);
      } else if (operation.type === "step") {
        const entry = exact(operation, ["tick", "type"], `history[${index}]`);
        integer(entry.tick, 0, MAX_LIVE_BATTLE_STEP_TICKS, `history[${index}].tick`);
        if (entry.tick !== restored.state.tick) throw new TypeError("noncausal live battle step history");
        restored.#advance();
      } else throw new TypeError(`live battle snapshot.${label}[${index}] is invalid`);
    };
    if (version >= 2) {
      let operations = 0;
      for (const [index, record] of transcript.entries()) {
        plain(record, `live battle snapshot.transcript[${index}]`);
        if (record.type === "step-run") {
          const run = exact(record, ["tick", "ticks", "type"], `transcript[${index}]`);
          const ticks = integer(run.ticks, 1, MAX_HISTORY, `transcript[${index}].ticks`);
          for (let count = 0; count < ticks; count += 1) {
            replayOperation({ tick: run.tick + count, type: "step" }, index, "transcript");
          }
          operations += ticks;
        } else {
          replayOperation(record, index, "transcript");
          operations += 1;
        }
        if (operations > MAX_HISTORY) throw new RangeError("live battle transcript operation bound exceeded");
      }
      for (const [index, operation] of history.entries()) {
        replayOperation(operation, index, "history");
      }
    } else {
      for (const [index, operation] of history.entries()) {
        replayOperation(operation, index, "history");
      }
    }
    const battleWitnessMatches = version >= 2
      ? restored.#battleRuntime().serialize() === checked.battle
      : (() => {
        const legacy = BattleTowerCombat.restore(checked.battle);
        if (JSON.parse(checked.battle).version !== 1) {
          throw new TypeError("live battle and battle tower snapshot versions are mixed");
        }
        return canonical(legacy.state) === canonical(restored.#battleRuntime().state) &&
          canonical(legacy.replay) === canonical(restored.#battleRuntime().replay);
      })();
    const buildingWitnessMatches = !hasBuildingWitness || canonical(restored.#buildingWitness()) ===
      canonical(checked.building);
    const runtimeWitnessMatches = !hasTroopRuntimeWitness || (
      restored.#troopRuntime.serialize() === runtimeBytes &&
      (!legacyRuntimeSnapshot || canonical(restored.#pendingTroopActions) === canonical(pendingTroopActions)) &&
      canonical(restored.#troopStatusWitnesses()) === canonical(troopStatuses)
    );
    const statusWitnessMatches = !hasStatusRuntimeWitness || (
      restored.#statusRuntime.serialize() === statusRuntimeBytes &&
      canonical(restored.#statusEffectWitnesses()) === canonical(statusEffects) &&
      canonical(restored.#pendingTroopStatusActions) === canonical(pendingTroopStatusActions)
    );
    const spellWitnessMatches = !hasSpellRuntimeWitness || (restored.#spells !== null &&
      restored.#spells.profileVersion === spellRuntimeState.version &&
      canonical(restored.#spells.state) === canonical(spellRuntimeState));
    const projectileWitnessMatches = !hasProjectileRuntimeWitness || (
      restored.#projectileRuntime !== null &&
      restored.#projectileRuntime.serialize() === projectileRuntimeSnapshot);
    const chainWitnessMatches = !hasChainContinuationWitness || (
      restored.#chainContinuation !== null &&
      restored.#chainContinuation.serialize() === chainContinuationSnapshot);
    if (!battleWitnessMatches || !buildingWitnessMatches || !runtimeWitnessMatches ||
        !statusWitnessMatches ||
        !spellWitnessMatches ||
        !projectileWitnessMatches ||
        !chainWitnessMatches ||
        canonical(movementWitnesses(restored.#movementRuntimes(), restored.#metadata)) !==
          canonical(checked.movements) || (version >= 2 && restored.serialize() !== serialized)) {
      throw new TypeError("live battle snapshot witnesses are not causal");
    }
    return restored;
  }

  #advance() {
    const battle = this.#battleRuntime();
    // BattleTowerCombat.state is deliberately a complete immutable public
    // snapshot. Reuse the pre-materialization read for admission and target
    // selection rather than repeatedly cloning every live unit on a normal
    // one-tick transactional continuation. A deployment changes the unit set,
    // so only that path obtains the one required post-materialization view.
    let before = battle.state;
    const due = this.#preflightBoundary(before);
    const tick = before.tick;
    const boundary = [];
    const unitOnlyBoundary = this.#buildingRuntime === EMPTY_BUILDING_RUNTIME &&
      this.#troopRuntime === EMPTY_TROOP_RUNTIME && this.#spells === null &&
      this.#projectileRuntime === null &&
      this.#chainContinuation === null &&
      this.#structures.length === 0 && this.#pendingStructures.length === 0 &&
      this.#pendingBuildingHits.length === 0 && this.#pendingTroopActions.length === 0 &&
      this.#pendingTroopStatusActions.length === 0 && !this.#hasStatusRuntime();
    const hasTroopRuntime = this.#hasTroopRuntime();
    const allowsLegacyTroopActions = hasTroopRuntime && this.#troopRuntime.allowsLegacyActions;
    const usesCurrentContactRuntime = hasTroopRuntime &&
      this.#troopRuntime.version === SESSION_TROOP_RUNTIME_VERSION;
    const dueTroopActions = unitOnlyBoundary ? null : allowsLegacyTroopActions
      ? this.#pendingTroopActions.filter((entry) => entry.tick === tick)
      : [];
    const dueStatusActions = this.#hasStatusRuntime()
      ? this.#pendingTroopStatusActions.filter((entry) => entry.tick === tick)
      : [];
    this.#pending = this.#pending.filter((entry) => entry.tick !== tick);
    if (allowsLegacyTroopActions) {
      this.#pendingTroopActions = this.#pendingTroopActions.filter((entry) => entry.tick !== tick);
    }
    this.#pendingTroopStatusActions = this.#pendingTroopStatusActions.filter((entry) => entry.tick !== tick);
    const deploySources = unitOnlyBoundary ? null : [];
    for (const deployment of due) {
      const materialized = this.#materialize(deployment);
      boundary.push(...materialized);
      if (!unitOnlyBoundary) {
        const deployed = materialized.find(({ type }) => type === "deployed");
        const liveIds = new Set(battle.state.units.map(({ id }) => id));
        for (const sourceId of deployed.entityIds) {
          if (liveIds.has(sourceId)) deploySources.push(this.#troopSource(sourceId, { requireAlive: false }));
        }
      }
    }

    const dueStructures = unitOnlyBoundary ? null :
      this.#pendingStructures.filter((entry) => entry.tick === tick);
    let externalHits = null;
    let externalTowerHits = null;
    if (!unitOnlyBoundary) {
      this.#pendingStructures = this.#pendingStructures.filter((entry) => entry.tick !== tick);
      for (const deployment of dueStructures) {
        boundary.push(...this.#materializeStructure(deployment));
      }
    }

    // Only v1/v2 retain deploy/pass witness receipts. The current v3 profile
    // observes a real host combat event and creates no placeholder record.
    if (hasTroopRuntime) {
      boundary.push(...this.#troopReceipts(this.#runTroopRuntime("deploy", deploySources, null, tick)));
      boundary.push(...this.#troopReceipts(this.#runTroopRuntime(
        "pre-move", this.#phaseTroopSources(), null, tick,
      )));
    }

    if (this.#hasStatusRuntime()) {
      this.#expireStatusEffects(tick, boundary);
      this.#clearDeadStatusEffects(tick, boundary);
    }

    // Building contacts are emitted at the prior shared boundary and consumed
    // here with ordinary BattleTowerCombat ingress. A stale target publishes
    // an ordered miss rather than mutating a later graph.
    const dueBuilding = unitOnlyBoundary ? null :
      this.#pendingBuildingHits.filter(({ applyTick }) => applyTick === tick);
    if (!unitOnlyBoundary) {
      this.#pendingBuildingHits = this.#pendingBuildingHits.filter(({ applyTick }) => applyTick !== tick);
      externalHits = [];
      externalTowerHits = [];
      for (const hit of dueBuilding) {
        if (hit.targetKind === "structure") {
          const target = this.#structures.find(({ id }) => id === hit.targetId);
          if (target?.alive) {
            boundary.push(...this.#damageStructure(target, hit.amount,
              `building:${hit.sourceId}`, hit.origin));
          } else {
            boundary.push(this.#buildingMiss(hit));
          }
        } else if (hit.targetKind === "unit") {
          const target = battle.state.units.find(({ alive, id }) => alive && id === hit.targetId);
          if (target) {
            externalHits.push({ damage: hit.amount, delivery: "melee",
              sourceId: `building:${hit.sourceId}`, targetUnitId: hit.targetId });
          } else {
            boundary.push(this.#buildingMiss(hit));
          }
        } else if (hit.targetKind === "tower") {
          const target = battle.state.towers.find(({ hitpoints, id }) => hitpoints > 0 && id === hit.targetId);
          if (target) {
            externalTowerHits.push({ amount: hit.amount, sourceId: `building:${hit.sourceId}`,
              towerId: hit.targetId });
          } else {
            boundary.push(this.#buildingMiss(hit));
          }
        } else {
          throw new Error("live battle queued building target kind is invalid");
        }
      }
    }

    if (due.length > 0) before = battle.state;
    let statusPlans = [];
    if (this.#hasStatusRuntime()) {
      statusPlans = this.#runStatusRuntime("pre-move",
        this.#phaseStatusSourcesFromState(before), dueStatusActions, tick, before);
      for (const plan of statusPlans) {
        if (plan.heal === null) boundary.push(clone(plan.receipt));
      }
    }
    const positionCommands = [];
    for (const unit of before.units.filter(({ alive }) => alive).sort((a, b) => a.id - b.id)) {
      const movement = this.#movementRuntime(this.#movements.get(unit.id));
      const desired = this.#desiredTarget(unit, before);
      const metadata = this.#metadata.get(unit.id);
      if (this.#admittedFlightProfile(metadata.cardId) !== null &&
          desired.target !== null && desired.target.position.x !== unit.position.x &&
          desired.target.position.y !== unit.position.y) {
        throw new RangeError("live battle troop flight target is outside the sourced axis-aligned path");
      }
      if (desired.key !== metadata.targetKey) {
        if (desired.target === null) {
          if (movement.state.target !== null) movement.stop();
        } else movement.setTarget(desired.target);
        metadata.targetKey = desired.key;
      }
      const movementEvents = this.#hasStatusRuntime() &&
        this.#statusMovementPaused(unit.id, tick, movement)
        ? movement.stepPaused()
        : movement.step();
      if (movementEvents.length > 0) {
        boundary.push(...movementEvents.map((event) => ({
          event: clone(event), tick, type: "movement", unitId: unit.id,
        })));
      }
      if (movement.state.position.x !== unit.position.x || movement.state.position.y !== unit.position.y) {
        positionCommands.push({
          id: unit.id,
          position: movement.state.position,
        });
      }
    }
    if (positionCommands.length > 0) {
      boundary.push(...battle.updatePositions({ positions: positionCommands, tick }));
    }
    if (unitOnlyBoundary) {
      boundary.push(...battle.step(tick));
      this.#appendHistory({ tick, type: "step" });
      this.#events.push(...clone(boundary));
      return boundary;
    }
    const spellActions = this.#spells === null ? [] : this.#spells.resolve(tick);
    const spellEffects = { unitHits: [] };
    const spellAreaVisuals = [];
    for (const action of spellActions) {
      const sourceId = `spell-intent:${String(action.effectId).padStart(16, "0")}`;
      boundary.push({ ...clone(action), sourceId, type: "spell-intent-resolved" });
      if (action.kind === "isolated-direct-target-damage") {
        spellEffects.unitHits.push({ damage: action.damage, effectId: action.effectId, sourceId,
          targetUnitId: action.target.id });
        continue;
      }
      const spellCircle = { position: action.point, radius: action.areaDamageRadiusMillitiles };
      const areaTargetIds = [];
      for (const unit of battle.state.units.filter(({ alive, side }) => alive && side !== action.side)) {
        if (action.targetMode !== "ground-and-air" ||
            !circlesOverlap(spellCircle, { position: unit.position, radius: unit.radius })) continue;
        spellEffects.unitHits.push({ damage: action.damage, effectId: action.effectId, sourceId,
          targetUnitId: unit.id });
        areaTargetIds.push(unit.id);
        boundary.push({ damage: action.damage, effectId: action.effectId, profileId: action.profileId, sourceId,
          targetId: unit.id, targetKind: "unit", tick, type: "spell-area-hit" });
      }
      for (const structure of this.#structures.filter(({ alive, side }) => alive && side !== action.side)) {
        if (!circlesOverlap(spellCircle, { position: structure.position, radius: 0 })) continue;
        boundary.push(...this.#damageStructure(structure, action.damage, sourceId,
          "spell-area-damage", tick));
        areaTargetIds.push(structure.id);
        boundary.push({ damage: action.damage, effectId: action.effectId, profileId: action.profileId, sourceId,
          targetId: structure.id, targetKind: "building", tick, type: "spell-area-hit" });
      }
      for (const tower of battle.state.towers.filter(({ hitpoints, side }) =>
        hitpoints > 0 && side !== action.side)) {
        const radius = SPELL_TOWER_FOOTPRINT_RADII[tower.role];
        if (!circlesOverlap(spellCircle, { position: tower.position, radius })) continue;
        // Half-up is the explicit v2 QUESTION policy; integer arithmetic keeps
        // every replay on the same deterministic path.
        const damage = Math.floor((action.damage * (100 + action.crownTowerDamagePercent) + 50) / 100);
        externalTowerHits.push({ amount: damage, sourceId, towerId: tower.id });
        boundary.push({ damage, effectId: action.effectId, profileId: action.profileId, sourceId,
          targetId: tower.id, targetKind: "crown-tower", tick, type: "spell-area-hit" });
      }
      spellAreaVisuals.push({ center: action.point, effectId: action.effectId,
        radius: action.areaDamageRadiusMillitiles, targetIds: areaTargetIds });
    }
    const beforeCombat = usesCurrentContactRuntime || this.#hasStatusRuntime() ? battle.state : null;
    const actionPlans = [];
    if (hasTroopRuntime) {
      boundary.push(...this.#troopReceipts(this.#runTroopRuntime(
        "pre-combat", this.#phaseTroopSources(), null, tick,
      )));
      for (const action of dueTroopActions) {
        const source = this.#troopSource(action.sourceId, { requireAlive: true });
        this.#inspectTroopActionChecked(action);
        const plans = this.#runTroopRuntime("pre-combat", [source], action, tick);
        actionPlans.push(...plans);
        boundary.push(...this.#troopReceipts(plans));
      }
    }
    externalHits.push(...actionPlans.flatMap(({ externalHit }) => externalHit === null ? [] : [externalHit]));
    externalHits.sort((left, right) => left.targetUnitId - right.targetUnitId ||
      (left.sourceId < right.sourceId ? -1 : left.sourceId > right.sourceId ? 1 : 0) ||
      left.damage - right.damage);
    const structureCandidates = this.#battleStructureCandidates();
    // Preserve the established unit-only path byte-for-byte. The reducer still
    // runs once below; richer ingress is needed only while host structures or
    // their contacts are present.
    let combatEvents;
    const statusControls = this.#hasStatusRuntime()
      ? beforeCombat.units.filter(({ alive }) => alive).sort((left, right) => left.id - right.id)
        .map((unit) => this.#statusControl(unit, tick))
      : null;
    const statusHeals = this.#hasStatusRuntime()
      ? statusPlans.filter(({ heal }) => heal !== null).map(({ heal }) => heal)
      : null;
    const chainCandidates = this.#chainContinuation === null ? null :
      this.#chainCandidatesFromState(battle.state, statusControls);
    const chainHopPlans = this.#chainContinuation === null ? [] :
      this.#chainContinuation.planDue(tick, chainCandidates);
    const chainBuildingPlans = [];
    for (const plan of chainHopPlans) {
      if (plan.target === null) {
        this.#chainContinuation.settleHop(plan, { ownerConfirmed: false, tick });
        boundary.push({ lineage: clone(plan.lineage), status: "no-eligible-target", tick,
          type: "chain-hop-settled" });
      } else if (plan.target.owner.kind === "unit") {
        externalHits.push({ damage: plan.damage, delivery: "melee",
          sourceId: plan.ingressSourceId, targetUnitId: plan.target.owner.id });
      } else if (plan.target.owner.kind === "crown-tower") {
        externalTowerHits.push({ amount: plan.damage, sourceId: plan.ingressSourceId,
          towerId: plan.target.owner.id });
      } else if (plan.target.owner.kind === "building") {
        chainBuildingPlans.push(plan);
      } else {
        throw new TypeError("live battle chain selected an unsupported owner");
      }
    }
    if (chainHopPlans.some(({ target }) => target !== null)) {
      externalHits.sort((left, right) => left.targetUnitId - right.targetUnitId ||
        (left.sourceId < right.sourceId ? -1 : left.sourceId > right.sourceId ? 1 : 0) ||
        left.damage - right.damage);
    }
    if (!this.#hasStatusRuntime() && spellEffects.unitHits.length > 0 && structureCandidates.length === 0 &&
        externalHits.length === 0 && externalTowerHits.length === 0) {
      combatEvents = battle.stepWithEffects(tick, spellEffects);
    } else if (!this.#hasStatusRuntime() && structureCandidates.length === 0 && externalHits.length === 0 &&
        externalTowerHits.length === 0) {
      combatEvents = battle.step(tick);
    } else {
      externalHits.push(...spellEffects.unitHits.map(({ damage, sourceId, targetUnitId }) => ({
        damage, delivery: "melee", sourceId, targetUnitId,
      })));
      externalHits.sort((left, right) => left.targetUnitId - right.targetUnitId ||
        (left.sourceId < right.sourceId ? -1 : left.sourceId > right.sourceId ? 1 : 0) ||
        left.damage - right.damage);
      combatEvents = battle.stepBoundary({ externalHits, externalProjectiles: [], externalTowerHits,
        structures: structureCandidates, tick,
        ...(this.#hasStatusRuntime() ? {
          unitControls: statusControls,
          unitHeals: statusHeals,
        } : {}) });
    }
    boundary.push(...combatEvents);
    const chainPrimaryImpacts = [];
    if (this.#chainContinuation !== null) {
      for (const launch of combatEvents.filter(({ type }) => type === "projectile-launch")) {
        const identity = launch.projectileIdentity;
        if (identity === undefined || this.#metadata.get(identity.sourceId)?.cardId !== "stormkite" ||
            this.#projectileRuntime?.profile("stormkite")?.claimFamily !== "chain") continue;
        const source = before.units.find(({ id }) => id === identity.sourceId);
        const targetId = launch.projectile?.targetId;
        if (source === undefined || !source.alive || !Number.isSafeInteger(targetId) || targetId < 1) {
          continue;
        }
        this.#chainContinuation.launch({ identity, primaryTargetId: targetId,
          sourceSide: source.side, tick });
      }
      for (const impact of combatEvents.filter(({ projectileIdentity, type }) =>
        type === "projectile-impact" && projectileIdentity !== undefined &&
        this.#chainContinuation.hasPrimaryFlight(projectileIdentity))) {
        chainPrimaryImpacts.push(impact);
      }
    }
    if (dueBuilding?.length) {
      battleTowerRecordStructureContacts(battle, dueBuilding, tick, boundary);
    }

    if (this.#projectileRuntime !== null) {
      // The host event list is the sole source of projectile identity.  The
      // reducer may retain only those identities and QUESTION receipts; it
      // cannot mint a projectile, advance the host tick, or touch health.
      this.#projectileRuntime.assertSourceRoster(projectileUnitRosterFromAdmittedSetup(this.#setup));
      boundary.push(...this.#projectileRuntime.step({
        events: combatEvents,
        sources: this.#projectileSourcesFromState(before),
        tick,
      }));
    }

    if (this.#hasStatusRuntime()) {
      this.#finalizeStatusPlans(statusPlans, combatEvents, boundary, tick);
      this.#clearDeadStatusEffects(tick, boundary);
    }

    if (usesCurrentContactRuntime) {
      const contacts = this.#currentContactBatch(combatEvents, beforeCombat, tick);
      const plans = this.#runTroopRuntime("combat",
        this.#phaseTroopSourcesFromState(beforeCombat), null, tick, {
          beforeCombat,
          combatEvents,
          contacts,
        });
      boundary.push(...this.#troopReceipts(plans));
    }

    if (hasTroopRuntime) {
      boundary.push(...this.#troopReceipts(this.#runTroopRuntime(
        "post-combat", this.#phaseTroopSources(), null, tick,
      )));
    }

    // BattleCombat emits unit-to-building contacts for data-only targets;
    // LiveBattle owns the corresponding structure-health transition exactly once.
    const primaryBuildingResults = [];
    for (const contact of combatEvents.filter((event) => event.type === "external-structure-contact" &&
      typeof event.structureId === "string" && event.structureId.startsWith("building:"))) {
      const id = Number(contact.structureId.slice("building:".length));
      const structure = this.#structures.find((entry) => entry.id === id);
      if (structure?.alive) {
        const identity = this.#chainContinuation === null
          ? null : contact.projectileIdentity ?? null;
        const result = this.#damageStructure(structure, contact.damage,
          contact.sourceUnitId ?? contact.sourceId ?? null, "combat-damage", tick, identity);
        boundary.push(...result);
        if (identity !== null) {
          primaryBuildingResults.push({ amountApplied: result.find(({ type }) =>
            type === "structure-damaged")?.amountApplied ?? 0, buildingId: id,
          identity: clone(identity) });
        }
      }
    }

    if (this.#chainContinuation !== null) {
      const afterState = battle.state;
      for (const plan of chainHopPlans.filter(({ target }) => target !== null)) {
        let ownerConfirmed = false;
        if (plan.target.owner.kind === "unit") {
          const damage = combatEvents.find((event) => event.type === "damage" &&
            event.externalSourceId === plan.ingressSourceId &&
            event.targetId === plan.target.owner.id);
          ownerConfirmed = damage !== undefined &&
            damage.currentHealthAfter < damage.currentHealthBefore;
        } else if (plan.target.owner.kind === "crown-tower") {
          const hit = combatEvents.find((event) => event.type === "external-structure-contact" &&
            event.sourceId === plan.ingressSourceId && event.structureId === plan.target.owner.id);
          const beforeTower = before.towers.find(({ id }) => id === plan.target.owner.id);
          const afterTower = afterState.towers.find(({ id }) => id === plan.target.owner.id);
          ownerConfirmed = hit !== undefined && hit.damage > 0 && beforeTower !== undefined &&
            afterTower !== undefined && beforeTower.hitpoints > afterTower.hitpoints;
        } else {
          const target = this.#structures.find(({ id }) => id === plan.target.owner.id);
          const applied = target?.alive
            ? this.#damageStructure(target, plan.damage, plan.ingressSourceId,
              "stormkite-chain-contact", tick)
            : [];
          boundary.push(...applied);
          ownerConfirmed = applied.some((event) => event.type === "structure-damaged" &&
            event.amountApplied > 0 && event.sourceId === plan.ingressSourceId);
        }
        const status = this.#chainContinuation.settleHop(plan, { ownerConfirmed, tick });
        boundary.push({ lineage: clone(plan.lineage), owner: clone(plan.target.owner),
          status: ownerConfirmed ? status : "no-owner-decrease", tick, type: "chain-hop-settled" });
      }

      for (const impact of chainPrimaryImpacts) {
        const identity = impact.projectileIdentity;
        const sourceSide = this.#chainContinuation.primarySourceSide(identity);
        const target = chainCandidates.find(({ hostId }) => hostId === impact.targetId) ?? null;
        let ownerConfirmed = false;
        if (impact.status === "contact" && target !== null && target.side !== sourceSide) {
          if (target.owner.kind === "unit") {
            const damage = combatEvents.find((event) => event.type === "damage" &&
              canonical(event.projectileIdentity) === canonical(identity) &&
              event.targetId === target.owner.id);
            ownerConfirmed = damage !== undefined &&
              damage.currentHealthAfter < damage.currentHealthBefore;
          } else {
            const contactStructureId = target.owner.kind === "building"
              ? `building:${target.owner.id}` : target.owner.id;
            const contact = combatEvents.find((event) => event.type === "external-structure-contact" &&
              canonical(event.projectileIdentity) === canonical(identity) &&
              event.structureId === contactStructureId && event.damage > 0);
            if (contact !== undefined && target.owner.kind === "crown-tower") {
              const beforeTower = before.towers.find(({ id }) => id === target.owner.id);
              const afterTower = afterState.towers.find(({ id }) => id === target.owner.id);
              ownerConfirmed = beforeTower !== undefined && afterTower !== undefined &&
                beforeTower.hitpoints > afterTower.hitpoints;
            } else if (contact !== undefined && target.owner.kind === "building") {
              ownerConfirmed = primaryBuildingResults.some((result) =>
                result.buildingId === target.owner.id && result.amountApplied > 0 &&
                canonical(result.identity) === canonical(identity));
            }
          }
        }
        const sourceAlive = afterState.units.find(({ id }) => id === identity.sourceId)?.alive === true;
        const result = this.#chainContinuation.settlePrimary(identity, {
          ownerConfirmed,
          sourceAlive,
          target: ownerConfirmed ? {
            owner: target.owner,
            position: target.position,
            radius: target.radius,
          } : null,
          tick,
        });
        boundary.push({ lineage: { hopOrdinal: 0, primaryProjectileIdentity: clone(identity) },
          owner: result.target?.owner ?? null, status: result.status, tick,
          type: "chain-primary-settled" });
      }
    }

    // An empty building runtime is semantically inert. Do not serialize and
    // revalidate the complete unit/tower graph until a structure or its queued
    // causal work actually exists. Once present, the authoritative reducer and
    // intent validation remain on the exact shared boundary below.
    if (this.#structures.length > 0 || dueStructures.length > 0 || dueBuilding.length > 0) {
      const building = this.#buildingRuntime.reduceBoundary(canonical({ structures: this.#structures,
        tick, towers: battle.state.towers.map(({ hitpoints, id, position, side }) =>
          ({ hitpoints, id, position, side })), units: battle.state.units.map((unit) => ({
          alive: unit.alive, id: unit.id, layer: unit.layer, position: unit.position, radius: unit.radius,
          side: unit.side, targetable: unit.alive,
        })) }));
      boundary.push(...this.#applyBuildingIntents(building, tick));
    }
    for (const impact of spellAreaVisuals) {
      // The resolver hits at `tick`; publish at the resulting state tick so the
      // browser can render the impact ring with the just-resolved board.
      battle.recordSpellAreaImpact({ ...impact, tick: battle.state.tick });
    }
    this.#appendHistory({ tick, type: "step" });
    this.#events.push(...clone(boundary));
    return boundary;
  }

  #runTroopRuntime(phase, sources, action, tick, contactWitness = null) {
    const canonicalSources = [...sources].sort((left, right) => left.sourceId - right.sourceId);
    const input = this.#troopRuntime.version === SESSION_TROOP_RUNTIME_MOVEMENT_VERSION
      ? {
          phase,
          sources: canonicalSources.map((source) => clone(source)),
          tick,
        }
      : this.#usesCurrentContactRuntime()
      ? {
          contacts: (contactWitness?.contacts ?? []).map((contact) => clone(contact)),
          phase,
          sources: canonicalSources.map((source) => clone(source)),
          tick,
        }
      : {
          action: action === null ? null : clone(action),
          phase,
          sources: canonicalSources.map((source) => clone(source)),
          tick,
        };
    const intents = this.#troopRuntime.reduce(input);
    return intents.map((intent) => this.#applyTroopIntent(intent, tick, contactWitness));
  }

  #runStatusRuntime(phase, sources, actions, tick, state = this.#battleRuntime().state) {
    if (!this.#hasStatusRuntime()) return [];
    const admissions = actions.map((action) => this.#statusAdmission(action, state));
    const input = {
      commands: actions.map((action) => ({
        actionId: action.actionId,
        commandId: action.commandId,
        side: action.side,
        sourceId: action.sourceId,
        targetId: action.targetId,
        tick: action.tick,
        type: "status",
      })),
      phase,
      sources: [...sources].sort((left, right) => left.sourceId - right.sourceId)
        .map((source) => ({ cardId: source.cardId, side: source.side, sourceId: source.sourceId })),
      targets: admissions.map(({ target }) => target === null ? null : {
        alive: target.alive,
        id: target.id,
        kind: target.kind,
        layer: target.layer,
        side: target.side,
        targetable: target.targetable,
      }),
      tick,
    };
    const intents = this.#statusRuntime.reduce(input);
    return intents.map((intent) => {
      const admission = admissions.find((candidate) =>
        candidate.commandId === intent.commandId && candidate.side === intent.side &&
        candidate.sourceId === intent.sourceId);
      if (admission === undefined) {
        throw new RangeError("live battle troop status intent has no admission receipt");
      }
      return this.#applyStatusIntent(intent, tick, admission);
    });
  }

  #applyStatusIntent(value, tick, admission) {
    const intent = exact(value, [
      "actionId", "cardId", "commandId", "effect", "parameters", "phase", "side",
      "sourceId", "targetId", "tick", "type",
    ], "live battle troop status intent");
    if (intent.type !== "troop-status-intent" || intent.phase !== "pre-move" || intent.tick !== tick ||
        !["heal", "hide", "reveal", "slow", "snare", "stun"].includes(intent.effect)) {
      throw new TypeError("live battle troop status intent is invalid");
    }
    const source = this.#battleRuntime().state.units.find(({ id }) => id === intent.sourceId);
    const metadata = this.#metadata.get(intent.sourceId);
    if (source === undefined || metadata === undefined || !source.alive ||
        metadata.cardId !== intent.cardId || source.side !== intent.side) {
      throw new RangeError("live battle troop status intent source is not causal");
    }
    const resolved = this.#statusRuntime.inspect({
      actionId: intent.actionId,
      cardId: intent.cardId,
      sourceId: intent.sourceId,
      targetId: intent.targetId,
    });
    if (canonical(resolved.parameters) !== canonical(intent.parameters) ||
        resolved.effect !== intent.effect) {
      throw new TypeError("live battle troop status intent diverges from its admitted receipt");
    }
    if (admission === undefined || admission.type !== "troop-status-admission" ||
        admission.actionId !== intent.actionId || admission.cardId !== intent.cardId ||
        admission.commandId !== intent.commandId || admission.effect !== intent.effect ||
        admission.side !== intent.side || admission.sourceId !== intent.sourceId ||
        admission.targetId !== intent.targetId || admission.tick !== intent.tick ||
        canonical(admission.parameters) !== canonical(intent.parameters)) {
      throw new TypeError("live battle troop status intent diverges from its admission receipt");
    }
    const target = intent.targetId === null ? null : this.#battleRuntime().state.units.find(({ id }) =>
      id === intent.targetId);
    if (intent.targetId !== null && (target === undefined || !target.alive ||
        admission.target === null || target.id !== admission.target.id)) {
      throw new RangeError("live battle troop status intent target is no longer causal");
    }
    const receipt = {
      actionId: intent.actionId,
      cardId: intent.cardId,
      commandId: intent.commandId,
      effect: intent.effect,
      parameters: clone(intent.parameters),
      phase: intent.phase,
      side: intent.side,
      sourceId: intent.sourceId,
      status: "no-op",
      targetId: intent.targetId,
      tick,
      type: "troop-status-receipt",
    };
    if (intent.effect === "heal") {
      const heal = target !== null && target.alive && target.side === source.side
        ? {
            amount: intent.parameters.amount,
            commandId: intent.commandId,
            sourceId: intent.sourceId,
            targetUnitId: target.id,
          }
        : null;
      return { heal, receipt };
    }
    if (intent.effect === "hide" || intent.effect === "reveal") {
      const effect = this.#statusEffect(source.id, true);
      const expiryTick = tick + intent.parameters.durationTicks - 1;
      if (!Number.isSafeInteger(expiryTick)) throw new RangeError("status expiry exceeds the safe tick range");
      if (intent.effect === "hide") {
        const prior = effect.hides.find(({ sourceId }) => sourceId === source.id);
        if (prior === undefined) effect.hides.push({
          applyTick: tick, expiryTick, sourceId: source.id,
        });
        else prior.expiryTick = Math.max(prior.expiryTick, expiryTick);
        effect.hides.sort((left, right) => left.sourceId - right.sourceId);
      } else {
        effect.revealUntil = Math.max(effect.revealUntil ?? -1, expiryTick);
      }
      receipt.status = "applied";
      receipt.expiryTick = expiryTick;
      return { heal: null, receipt };
    }
    if (target === null || !target.alive || target.side === source.side) {
      return { heal: null, receipt };
    }
    const effect = this.#statusEffect(target.id, true);
    const expiryTick = tick + intent.parameters.durationTicks - 1;
    if (!Number.isSafeInteger(expiryTick)) throw new RangeError("status expiry exceeds the safe tick range");
    if (intent.effect === "stun") {
      const prior = effect.stun;
      effect.stun = {
        applyTick: tick,
        expiryTick: Math.max(prior?.expiryTick ?? -1, expiryTick),
        sourceId: source.id,
      };
    } else if (intent.effect === "snare") {
      const prior = effect.snare;
      effect.snare = {
        applyTick: tick,
        expiryTick: Math.max(prior?.expiryTick ?? -1, expiryTick),
        sourceId: source.id,
      };
    } else if (intent.effect === "slow") {
      const prior = effect.slow;
      effect.slow = {
        applyTick: tick,
        attackRate: clone(intent.parameters.attackRate),
        attackRemainder: prior?.attackRemainder ?? 0,
        expiryTick: Math.max(prior?.expiryTick ?? -1, expiryTick),
        movementRate: clone(intent.parameters.movementRate),
        movementRemainder: prior?.movementRemainder ?? 0,
        sourceId: source.id,
      };
    }
    receipt.status = "applied";
    receipt.expiryTick = expiryTick;
    return { heal: null, receipt };
  }

  #finalizeStatusPlans(plans, combatEvents, boundary, tick) {
    for (const plan of plans) {
      if (plan.heal === null) continue;
      const event = combatEvents.find(({ commandId, sourceId, targetId, type }) =>
        type === "heal" && commandId === plan.heal.commandId &&
        sourceId === plan.heal.sourceId &&
        targetId === plan.heal.targetUnitId);
      boundary.push({
        ...clone(plan.receipt),
        appliedAmount: event?.appliedAmount ?? 0,
        currentHealth: event?.currentHealth ?? null,
        status: event?.status === "applied" && event.appliedAmount > 0 ? "applied" :
          event?.status === "applied" ? "capped" : event?.status ?? plan.receipt.status,
        tick,
      });
    }
  }

  #troopReceipts(plans) {
    return plans.map(({ receipt }) => receipt);
  }

  #applyTroopIntent(value, tick, contactWitness = null) {
    const version = this.#troopRuntime.version;
    const intent = checkedTroopIntent(value, tick, version);
    if (version === SESSION_TROOP_RUNTIME_MOVEMENT_VERSION) {
      return this.#applyTroopMovementIntent(intent, tick);
    }
    if (version === SESSION_TROOP_RUNTIME_VERSION) {
      return this.#applyCurrentTroopContact(intent, tick, contactWitness);
    }
    return this.#applyLegacyTroopIntent(intent, tick);
  }

  #applyTroopMovementIntent(intent, tick) {
    const source = this.#battleRuntime().state.units.find(({ id }) => id === intent.sourceId);
    const metadata = this.#metadata.get(intent.sourceId);
    if (source === undefined || metadata === undefined || !source.alive ||
        metadata.cardId !== intent.cardId || source.side !== intent.side) {
      throw new RangeError("live battle troop movement intent source is not causal");
    }
    const profile = this.#admittedFlightProfile(metadata.cardId);
    const movement = this.#movementRuntime(this.#movements.get(intent.sourceId));
    if (profile === null || profile.layer !== intent.layer || profile.pathScope !== intent.pathScope ||
        source.layer !== "air" || movement.state.mode !== "air" ||
        movement.state.speed !== profile.speed) {
      throw new TypeError("live battle troop movement intent diverges from the exact HTMP receipt");
    }
    const admission = this.#troopRuntime.inspectMovement({
      cardId: intent.cardId,
      claimFamily: intent.claimFamily,
      phase: intent.phase,
      side: intent.side,
      sourceId: intent.sourceId,
      tick,
      type: "troop-movement",
    });
    if (admission.disposition !== "admitted" || admission.layer !== intent.layer ||
        admission.pathScope !== intent.pathScope) {
      throw new TypeError("live battle troop movement intent has no matching receipt admission");
    }
    const target = movement.state.target;
    if (target !== null && target.position.x !== source.position.x &&
        target.position.y !== source.position.y) {
      throw new RangeError("live battle troop flight target is outside the sourced axis-aligned path");
    }
    return {
      externalHit: null,
      receipt: {
        cardId: intent.cardId,
        claimFamily: "flight",
        kind: "flight",
        layer: "air",
        pathScope: "axis-aligned-only",
        phase: "pre-move",
        side: intent.side,
        sourceId: intent.sourceId,
        tick,
        type: "troop-runtime-receipt",
      },
    };
  }

  #applyLegacyTroopIntent(intent, tick) {
    const source = this.#troopSource(intent.sourceId, { requireAlive: intent.kind === "action" });
    if (source.cardId !== intent.cardId || source.side !== intent.side) {
      throw new TypeError("live battle troop runtime intent source diverges");
    }
    const profile = this.#troopRuntime.profile(intent.cardId);
    const legacy = this.#troopRuntime.version === SESSION_TROOP_RUNTIME_LEGACY_VERSION;
    const admittedClaim = legacy
      ? profile?.claim === "unclaimed"
      : profile?.claim === "receipt-witness" || profile?.claim === "representative-mechanic";
    if (profile === null || !admittedClaim || profile.deploy !== "receipt-only") {
      throw new TypeError("live battle troop runtime intent profile is unavailable");
    }
    let contact = null;
    if (intent.kind === "action") {
      if (profile.action === null || profile.action.id !== intent.actionId ||
          profile.action.abilityCost !== null) {
        throw new TypeError("live battle troop runtime action intent diverges from its profile");
      }
      const target = this.#troopSource(intent.targetId, { requireAlive: true });
      if (target.side === source.side) {
        throw new RangeError("live battle troop runtime action target must be opposing");
      }
      if (profile.action.effect === "source-melee-contact") {
        contact = this.#representativeContact(intent, source, target);
      } else if (!legacy) {
        throw new TypeError("live battle troop runtime action effect is unsupported");
      }
    } else if ((intent.kind === "deploy" && intent.phase !== "deploy") ||
        (intent.kind === "pass" && (intent.phase === "deploy" ||
          !profile.passes.includes(intent.phase)))) {
      throw new TypeError("live battle troop runtime passive intent diverges from its profile");
    }
    const key = troopStatusKey(intent);
    if (!this.#troopStatuses.has(key) && this.#troopStatuses.size >= TROOP_STATUS_LIMIT) {
      throw new RangeError("live battle troop runtime status bound exceeded");
    }
    const status = { ...intent, key };
    delete status.type;
    if (this.#troopRuntime.version === SESSION_TROOP_RUNTIME_ACTION_PROFILE_VERSION) {
      Object.assign(status, {
        damage: contact?.damage ?? null,
        delivery: contact?.delivery ?? null,
        effect: contact?.effect ?? null,
        externalSourceId: contact?.externalSourceId ?? null,
      });
    }
    this.#troopStatuses.set(key, status);
    return {
      externalHit: contact === null ? null : {
        damage: contact.damage,
        delivery: contact.delivery,
        sourceId: contact.externalSourceId,
        targetUnitId: intent.targetId,
      },
      receipt: { ...clone(status), type: "troop-runtime-receipt" },
    };
  }

  #currentContactBatch(combatEvents, beforeCombat, tick) {
    const units = new Map(beforeCombat.units.map((unit) => [unit.id, unit]));
    const contacts = [];
    for (const event of combatEvents.filter(({ type }) => type === "attack")
      .sort((left, right) => left.attackerId - right.attackerId || left.sequence - right.sequence ||
        left.targetId - right.targetId)) {
      const source = units.get(event.attackerId);
      const target = units.get(event.targetId);
      const metadata = this.#metadata.get(event.attackerId);
      if (source === undefined || target === undefined || metadata === undefined ||
          this.#troopRuntime.profile(metadata.cardId) === null) continue;
      contacts.push({ attackSequence: event.sequence, sourceId: event.attackerId, targetId: event.targetId });
    }
    if (contacts.length > SESSION_TROOP_RUNTIME_MAX_SOURCES) {
      throw new RangeError("live battle current troop contact batch exceeds its source bound");
    }
    if (contacts.some(({ attackSequence, sourceId, targetId }) =>
      !Number.isSafeInteger(attackSequence) || !Number.isSafeInteger(sourceId) ||
      !Number.isSafeInteger(targetId) || sourceId < 1 || targetId < 1)) {
      throw new TypeError("live battle current troop contact batch is invalid");
    }
    void tick;
    return contacts;
  }

  #applyCurrentTroopContact(intent, tick, contactWitness) {
    if (contactWitness === null || contactWitness.beforeCombat?.tick !== tick ||
        !Array.isArray(contactWitness.combatEvents)) {
      throw new TypeError("live battle current troop contact lacks a causal host boundary");
    }
    const profile = this.#troopRuntime.profile(intent.cardId);
    const source = contactWitness.beforeCombat.units.find(({ id }) => id === intent.sourceId);
    const target = contactWitness.beforeCombat.units.find(({ id }) => id === intent.targetId);
    const metadata = this.#metadata.get(intent.sourceId);
    const card = this.#rosterById.get(intent.cardId);
    if (profile === null || profile.claim !== "representative-live-contact" ||
        source === undefined || target === undefined || metadata === undefined || card === undefined ||
        !source.alive || !target.alive || source.side !== intent.side || target.side === source.side) {
      throw new RangeError("live battle current troop contact endpoints are not causal");
    }
    if (canonical(profile.sourceProfile) !== canonical(currentContactSourceProfileFromRoster(card)) ||
        canonical(profile.sourceProfile) !== canonical(currentContactSourceProfileFromMaterialized(source, metadata))) {
      throw new TypeError("live battle current troop contact source profile diverges from the shared host");
    }
    if (source.delivery !== profile.contact.delivery || source.delivery !== "melee" ||
        !layerEligible(source.targetMode, target.layer)) {
      throw new RangeError("live battle current troop contact delivery or target layer is invalid");
    }
    const range = source.radius + source.reach + target.radius;
    if (squaredDistance(source.position, target.position) > BigInt(range) * BigInt(range)) {
      throw new RangeError("live battle current troop contact target is out of range");
    }
    if (source.attack.phase === "deploying" || source.attack.nextTick !== tick ||
        !["winding", "cycling"].includes(source.attack.phase) ||
        source.attack.nextAttackTick !== tick || source.attack.targetId !== intent.targetId ||
        intent.attackSequence !== source.attack.attackSequence + 1) {
      throw new RangeError("live battle current troop contact attack timing is not eligible");
    }
    const attacks = contactWitness.combatEvents.filter((event) => event.type === "attack" &&
      event.attackerId === intent.sourceId && event.sequence === intent.attackSequence &&
      event.targetId === intent.targetId && event.tick === tick);
    const damage = contactWitness.combatEvents.filter((event) => event.type === "damage" &&
      event.attackerId === intent.sourceId && event.delivery === "melee" &&
      event.targetId === intent.targetId && event.tick === tick);
    if (attacks.length !== 1 || damage.length !== 1 || damage[0].amount !== source.damage) {
      throw new RangeError("live battle current troop contact normal attack evidence is absent");
    }
    const key = troopStatusKey(intent);
    const contactId = troopContactIdentity(intent);
    if (this.#troopStatuses.get(key)?.contactId === contactId) {
      throw new RangeError("live battle current troop contact identity is duplicate");
    }
    if (!this.#troopStatuses.has(key) && this.#troopStatuses.size >= TROOP_STATUS_LIMIT) {
      throw new RangeError("live battle troop runtime status bound exceeded");
    }
    const status = {
      attackSequence: intent.attackSequence,
      cardId: intent.cardId,
      contactId,
      damage: damage[0].amount,
      delivery: "melee",
      effect: CURRENT_TROOP_CONTACT_EFFECT,
      hostSourceIdentity: troopHostSourceIdentity(intent),
      key,
      kind: "contact",
      phase: "combat",
      provenance: clone(profile.contact.provenance),
      side: intent.side,
      sourceId: intent.sourceId,
      sourceProfile: clone(profile.sourceProfile),
      targetId: intent.targetId,
      tick,
    };
    this.#troopStatuses.set(key, status);
    return { externalHit: null, receipt: { ...clone(status), type: "troop-runtime-receipt" } };
  }

  #representativeContact(intent, source, target) {
    const state = this.#battleRuntime().state;
    const sourceUnit = state.units.find(({ id }) => id === source.sourceId);
    const targetUnit = state.units.find(({ id }) => id === target.sourceId);
    if (sourceUnit === undefined || targetUnit === undefined || !sourceUnit.alive || !targetUnit.alive) {
      throw new RangeError("live battle representative contact endpoints must be live");
    }
    if (sourceUnit.side !== intent.side || targetUnit.side === sourceUnit.side) {
      throw new RangeError("live battle representative contact sides are divergent");
    }
    if (sourceUnit.delivery !== "melee") {
      throw new RangeError("live battle representative contact source must be melee");
    }
    if (!layerEligible(sourceUnit.targetMode, targetUnit.layer)) {
      throw new RangeError("live battle representative contact target layer is ineligible");
    }
    const radius = sourceUnit.radius + sourceUnit.reach + targetUnit.radius;
    if (squaredDistance(sourceUnit.position, targetUnit.position) > BigInt(radius) * BigInt(radius)) {
      throw new RangeError("live battle representative contact target is out of range");
    }
    if (!Number.isSafeInteger(sourceUnit.damage) || sourceUnit.damage < 1 ||
        sourceUnit.damage > 1_000_000_000) {
      throw new TypeError("live battle representative contact source damage is invalid");
    }
    return {
      damage: sourceUnit.damage,
      delivery: "melee",
      effect: "source-melee-contact",
      externalSourceId: troopExternalSourceId(intent),
    };
  }

  #troopSource(sourceId, { requireAlive }) {
    if (!Number.isSafeInteger(sourceId) || sourceId < 1) {
      throw new TypeError("live battle troop source ID is invalid");
    }
    const unit = this.#battleRuntime().state.units.find(({ id }) => id === sourceId);
    const metadata = this.#metadata.get(sourceId);
    if (unit === undefined || metadata === undefined) {
      throw new RangeError("live battle troop source is unknown");
    }
    if (requireAlive && !unit.alive) {
      throw new RangeError("live battle troop source is not live");
    }
    return { cardId: metadata.cardId, side: unit.side, sourceId };
  }

  #troopSourceFromUnit(unit, { requireAlive }) {
    const metadata = this.#metadata.get(unit.id);
    if (metadata === undefined) {
      throw new RangeError("live battle troop source metadata is unknown");
    }
    if (requireAlive && !unit.alive) {
      throw new RangeError("live battle troop source is not live");
    }
    return { cardId: metadata.cardId, side: unit.side, sourceId: unit.id };
  }

  #phaseTroopSources() {
    return this.#phaseTroopSourcesFromState(this.#battleRuntime().state);
  }

  #phaseTroopSourcesFromState(state) {
    if (!this.#hasTroopRuntime()) return [];
    return state.units.filter(({ alive }) => alive).sort((left, right) => left.id - right.id)
      .map((unit) => this.#troopSourceFromUnit(unit, { requireAlive: true }))
      .filter(({ cardId }) => this.#troopRuntime.version === SESSION_TROOP_RUNTIME_MOVEMENT_VERSION
        ? this.#admittedFlightProfile(cardId) !== null
        : this.#troopRuntime.profile(cardId) !== null);
  }

  #admittedFlightProfile(cardId) {
    if (this.#troopRuntime.version !== SESSION_TROOP_RUNTIME_MOVEMENT_VERSION) return null;
    const profile = this.#troopRuntime.flightProfile(cardId);
    if (profile === null) return null;
    if (profile.cardId !== cardId || profile.claimFamily !== "flight" ||
        profile.layer !== "air" || profile.pathScope !== "axis-aligned-only" ||
        !Number.isSafeInteger(profile.speed) || profile.speed < 0) {
      throw new TypeError("live battle flight profile is not the exact admitted source profile");
    }
    return profile;
  }

  #projectileSourcesFromState(state) {
    if (this.#projectileRuntime === null) return [];
    return [...state.units].sort((left, right) => left.id - right.id)
      .map((unit) => ({
        cardId: this.#metadata.get(unit.id)?.cardId,
        damage: unit.damage,
        delivery: unit.delivery,
        layer: unit.layer,
        maxHealth: unit.maxHealth,
        projectileSpeed: unit.projectileSpeed,
        rangeMillitiles: unit.reach,
        sightRangeMillitiles: unit.sightRange,
        side: unit.side,
        sourceId: unit.id,
        targetMode: unit.targetMode,
      }))
      .filter(({ cardId }) => cardId !== undefined &&
        (this.#projectileRuntime.profile(cardId) !== null ||
          this.#projectileRuntime.question(cardId) !== null));
  }

  #chainCandidatesFromState(state, unitControls = null) {
    const controls = new Map((unitControls ?? []).map((control) => [control.id, control]));
    const units = state.units.map((unit) => ({
      alive: unit.alive,
      hostId: unit.id,
      layer: unit.layer,
      owner: { id: unit.id, kind: "unit" },
      position: clone(unit.position),
      radius: unit.radius,
      side: unit.side,
      targetable: unit.alive && (controls.get(unit.id)?.targetable ?? true),
    }));
    const towers = state.towers.map((tower) => {
      const geometry = battleTowerCandidateGeometry(tower);
      return {
        alive: tower.hitpoints > 0,
        hostId: geometry.hostId,
        layer: "ground",
        owner: { id: tower.id, kind: "crown-tower" },
        position: clone(tower.position),
        radius: geometry.radius,
        side: tower.side,
        targetable: tower.hitpoints > 0,
      };
    });
    const buildings = this.#structures.map((structure) => ({
      alive: structure.alive,
      hostId: structure.id,
      layer: "ground",
      owner: { id: structure.id, kind: "building" },
      position: clone(structure.position),
      radius: 0,
      side: structure.side,
      targetable: structure.alive && structure.targetable,
    }));
    return [...units, ...towers, ...buildings].sort((left, right) =>
      left.hostId - right.hostId || (left.owner.kind < right.owner.kind ? -1 :
        left.owner.kind > right.owner.kind ? 1 : 0));
  }

  #phaseStatusSourcesFromState(state) {
    if (!this.#hasStatusRuntime()) return [];
    return state.units.filter(({ alive }) => alive).sort((left, right) => left.id - right.id)
      .map((unit) => this.#troopSourceFromUnit(unit, { requireAlive: true }))
      .filter(({ cardId }) => this.#statusRuntime.profile(cardId) !== null);
  }

  #troopStatusWitnesses() {
    return [...this.#troopStatuses.values()].map((status) => clone(status))
      .sort((left, right) => left.key.localeCompare(right.key));
  }

  #hasStatusRuntime() {
    return this.#statusRuntime !== null;
  }

  #statusEffectWitnesses() {
    return [...this.#statusEffects.values()].map((effect) => ({
      hides: effect.hides.map((hide) => clone(hide)).sort((left, right) =>
        left.sourceId - right.sourceId),
      revealUntil: effect.revealUntil,
      slow: effect.slow === null ? null : clone(effect.slow),
      snare: effect.snare === null ? null : clone(effect.snare),
      stun: effect.stun === null ? null : clone(effect.stun),
      targetId: effect.targetId,
    })).sort((left, right) => left.targetId - right.targetId);
  }

  #statusEffect(targetId, create = false) {
    let effect = this.#statusEffects.get(targetId);
    if (effect === undefined && create) {
      effect = {
        hides: [],
        revealUntil: null,
        slow: null,
        snare: null,
        stun: null,
        targetId,
      };
      this.#statusEffects.set(targetId, effect);
    }
    return effect ?? null;
  }

  #statusEffectEmpty(effect) {
    return effect.hides.length === 0 && effect.revealUntil === null &&
      effect.slow === null && effect.snare === null && effect.stun === null;
  }

  #statusTargetable(targetId, tick) {
    const effect = this.#statusEffect(targetId);
    if (effect === null || effect.revealUntil !== null && effect.revealUntil >= tick) return true;
    return !effect.hides.some(({ expiryTick }) => expiryTick >= tick);
  }

  #statusActive(record, tick) {
    return record !== null && record.expiryTick >= tick;
  }

  #expireStatusEffects(tick, boundary) {
    for (const effect of [...this.#statusEffects.values()].sort((left, right) =>
      left.targetId - right.targetId)) {
      for (const field of ["stun", "slow", "snare"]) {
        const record = effect[field];
        if (record !== null && record.expiryTick < tick) {
          boundary.push({ effect: field, sourceId: record.sourceId, targetId: effect.targetId,
            tick, type: "troop-status-expired" });
          effect[field] = null;
        }
      }
      const expiredHides = effect.hides.filter(({ expiryTick }) => expiryTick < tick);
      for (const record of expiredHides) {
        boundary.push({ effect: "hide", sourceId: record.sourceId, targetId: effect.targetId,
          tick, type: "troop-status-expired" });
      }
      effect.hides = effect.hides.filter(({ expiryTick }) => expiryTick >= tick);
      if (effect.revealUntil !== null && effect.revealUntil < tick) {
        boundary.push({ effect: "reveal", targetId: effect.targetId, tick,
          type: "troop-status-expired" });
        effect.revealUntil = null;
      }
      if (this.#statusEffectEmpty(effect)) this.#statusEffects.delete(effect.targetId);
    }
  }

  #clearDeadStatusEffects(tick, boundary) {
    const units = new Map(this.#battleRuntime().state.units.map((unit) => [unit.id, unit]));
    for (const effect of [...this.#statusEffects.values()].sort((left, right) =>
      left.targetId - right.targetId)) {
      const target = units.get(effect.targetId);
      if (target === undefined || !target.alive) {
        for (const field of ["stun", "slow", "snare"]) {
          if (effect[field] !== null) {
            boundary.push({ effect: field, reason: "target-death", sourceId: effect[field].sourceId,
              targetId: effect.targetId, tick, type: "troop-status-cancelled" });
            effect[field] = null;
          }
        }
        if (effect.hides.length > 0) {
          boundary.push({ effect: "hide", reason: "target-death", targetId: effect.targetId,
            tick, type: "troop-status-cancelled" });
          effect.hides = [];
        }
      }
      for (const field of ["stun", "snare"]) {
        const record = effect[field];
        if (record !== null && (!units.get(record.sourceId)?.alive)) {
          boundary.push({ effect: field, reason: "source-death", sourceId: record.sourceId,
            targetId: effect.targetId, tick, type: "troop-status-cancelled" });
          effect[field] = null;
        }
      }
      effect.hides = effect.hides.filter((record) => {
        if (units.get(record.sourceId)?.alive) return true;
        boundary.push({ effect: "hide", reason: "source-death", sourceId: record.sourceId,
          targetId: effect.targetId, tick, type: "troop-status-cancelled" });
        return false;
      });
      if (this.#statusEffectEmpty(effect)) this.#statusEffects.delete(effect.targetId);
    }
  }

  #statusControl(unit, tick) {
    const effect = this.#statusEffect(unit.id);
    const stun = this.#statusActive(effect?.stun ?? null, tick);
    const slow = this.#statusActive(effect?.slow ?? null, tick);
    let attackStep = "normal";
    if (stun) {
      attackStep = "pause";
    } else if (slow) {
      const rate = effect.slow.attackRate;
      const readyAtBoundary = unit.attack.nextAttackTick === tick;
      if (!readyAtBoundary && unit.attack.nextAttackTick !== null) {
        effect.slow.attackRemainder += rate.numerator;
        if (effect.slow.attackRemainder >= rate.denominator) {
          effect.slow.attackRemainder -= rate.denominator;
        } else {
          attackStep = "pause";
        }
      }
    }
    return {
      attackBlocked: stun,
      attackStep,
      id: unit.id,
      targetable: this.#statusTargetable(unit.id, tick),
    };
  }

  #statusMovementPaused(unitId, tick, movement) {
    const effect = this.#statusEffect(unitId);
    if (this.#statusActive(effect?.stun ?? null, tick) ||
        this.#statusActive(effect?.snare ?? null, tick)) return true;
    if (!this.#statusActive(effect?.slow ?? null, tick)) return false;
    if (movement !== undefined && movement.state.target === null) return false;
    const rate = effect.slow.movementRate;
    effect.slow.movementRemainder += rate.numerator;
    if (effect.slow.movementRemainder >= rate.denominator) {
      effect.slow.movementRemainder -= rate.denominator;
      return false;
    }
    return true;
  }

  #hasTroopRuntime() {
    return this.#troopRuntime.hasProfiles;
  }

  #allowsLegacyTroopActions() {
    return this.#hasTroopRuntime() && this.#troopRuntime.allowsLegacyActions;
  }

  #usesCurrentContactRuntime() {
    return this.#hasTroopRuntime() &&
      this.#troopRuntime.version === SESSION_TROOP_RUNTIME_VERSION;
  }

  #hasLiveSpellTarget(target) {
    return this.#battleRuntime().state.units.some((unit) => unit.id === target.id && unit.alive);
  }

  #validatedSpellCommand(command) {
    if (this.#spells === null) throw new RangeError("live battle has no sourced spell profile");
    const descriptors = plain(command, "live spell command");
    const question = typeof descriptors.cardId?.value === "string"
      ? this.getSpellProfileQuestion(descriptors.cardId.value)
      : null;
    if (question !== null) {
      throw new RangeError(`live battle effect ${question.cardId} remains an explicit QUESTION (${question.id}): ${question.reason}`);
    }
    const checked = this.#spells.validate(command, this.#battleRuntime().state.tick);
    const card = this.#rosterById.get(checked.cardId);
    if (card === undefined || card.kind !== "effect") {
      throw new TypeError("live spell command card is not an admitted effect");
    }
    const placement = evaluateDeployment({
      destroyedOpposingLaneTowers: [],
      placementClass: "global_effect",
      point: checked.point,
      side: checked.side,
    });
    if (!placement.legal) {
      throw new RangeError(`live spell command is illegal: ${placement.reason}`);
    }
    if (this.#pending.some((entry) => entry.tick === checked.tick && entry.sequence === checked.sequence) ||
        this.#pendingStructures.some((entry) => entry.tick === checked.tick &&
          entry.sequence === checked.sequence) ||
        this.#spells.hasPendingSequence(checked.tick, checked.sequence)) {
      throw new RangeError("live battle spell tick/sequence must be unique");
    }
    if (this.#spells.profileVersion === 1 && !this.#hasLiveSpellTarget(checked.target)) {
      throw new RangeError("live spell command target is not a live shared entity");
    }
    return checked;
  }

  #preflightBoundary(state = this.#battleRuntime().state) {
    const tick = state.tick;
    const due = this.#pending.filter((entry) => entry.tick === tick);
    const dueStructures = this.#pendingStructures.length === 0 ? null :
      this.#pendingStructures.filter((entry) => entry.tick === tick);
    const added = due.reduce((sum, deployment) => {
      const card = this.#rosterById.get(deployment.cardId);
      if (card === undefined) throw new TypeError("live battle pending card identity is unknown");
      return sum + card.formation.totalCount;
    }, 0);
    const existing = state.units.length;
    if (!Number.isSafeInteger(added) || existing + added > MAX_LIVE_BATTLE_UNITS) {
      throw new RangeError("live battle boundary unit capacity exceeded");
    }
    if (this.#structures.length + (dueStructures?.length ?? 0) > MAX_LIVE_BATTLE_STRUCTURES) {
      throw new RangeError("live battle boundary structure capacity exceeded");
    }
    if (this.#nextEntityId + added + (dueStructures?.length ?? 0) > Number.MAX_SAFE_INTEGER) {
      throw new RangeError("live battle entity identity capacity exceeded");
    }
    if (this.#pendingBuildingHits.length > MAX_PENDING_BUILDING_HITS) {
      throw new RangeError("live battle pending building contact capacity exceeded");
    }
    return due;
  }

  #materialize(deployment) {
    const card = this.#rosterById.get(deployment.cardId);
    const entities = placedEntities(card, deployment.point, this.#nextEntityId,
      this.#questionValues, this.#admittedFlightProfile(card.id));
    const events = [];
    const battle = this.#battleRuntime();
    const interval=card.entities[0].sourceConfidencePolicy?.deploymentInterval?.ticks??0;
    for (const entity of entities) {
      const spawnTick=deployment.tick+(entity.id-this.#nextEntityId)*interval;
      const spec = combatSpec(entity, deployment.side);
      if (spawnTick === deployment.tick) events.push(battle.spawn({ ...spec, tick: spawnTick }));
      else battle.scheduleSpawn({ ...spec, tick: spawnTick });
      const movement = new BattleMovement({
        bodyRadius: entity.radius,
        mode: entity.component.layer,
        position: entity.position,
        speed: entity.component.movementMillitilesPerSecond,
      });
      movement.stepMany(spawnTick);
      this.#movements.set(entity.id, this.#movementsOpaque
        ? battleMovementCompactClone(movement)
        : movement);
      this.#metadata.set(entity.id, {
        archetypeId: entity.component.archetypeId,
        cardId: card.id,
        count: entity.component.count,
        memberIndex: entity.memberIndex,
        role: entity.component.role,
        targetKey: null,
      });
    }
    this.#nextEntityId += entities.length;
    events.push({
      cardId: card.id,
      entityIds: entities.map(({ id }) => id),
      point: { ...deployment.point },
      sequence: deployment.sequence,
      side: deployment.side,
      tick: deployment.tick,
      type: "deployed",
    });
    return events;
  }

  #materializeStructure(deployment) {
    const id = this.#nextEntityId;
    const structure = this.#buildingRuntime.materializePlacement(canonical({
      cardId: deployment.cardId,
      destination: deployment.destination,
      id,
      point: deployment.point,
      side: deployment.side,
      tick: deployment.tick,
    }));
    this.#nextEntityId += 1;
    this.#structures.push(clone(structure));
    this.#structures.sort((left, right) => left.id - right.id);
    return [{ cardId: deployment.cardId, destination: clone(deployment.destination),
      point: clone(deployment.point), sequence: deployment.sequence, side: deployment.side,
      structureId: id, tick: deployment.tick, type: "structure-materialized" }];
  }

  #battleStructureCandidates() {
    return this.#structures.map((structure) => ({
      alive: structure.alive,
      id: structure.id,
      kind: "structure",
      layer: "ground",
      position: clone(structure.position),
      radius: 0,
      side: structure.side,
      structureId: `building:${structure.id}`,
      targetable: structure.targetable,
    })).sort((left, right) => left.id - right.id);
  }

  #buildingMiss(hit) {
    return { amount: hit.amount, origin: hit.origin, sourceId: hit.sourceId,
      targetId: hit.targetId, targetKind: hit.targetKind, tick: this.#battleRuntime().state.tick,
      type: "building-contact-missed" };
  }

  #damageStructure(structure, amount, sourceId, origin, tick = this.#battleRuntime().state.tick,
    projectileIdentity = null) {
    if (!structure.alive || amount <= 0) return [];
    const applied = Math.min(structure.hitpoints, amount);
    structure.hitpoints -= applied;
    const events = [{ amountApplied: applied, amountRequested: amount, buildingId: structure.id,
      origin, sourceId, tick, type: "structure-damaged",
      ...(projectileIdentity === null ? {} : { projectileIdentity: clone(projectileIdentity) }) }];
    if (structure.hitpoints === 0) {
      structure.alive = false;
      structure.deathCause = "combat-damage";
      structure.targetable = false;
      if (structure.class === "travel") {
        structure.phase = "dead";
        events.push({ buildingId: structure.id, reason: "damage", tick,
          type: "travel-building-destroyed" });
      } else {
        events.push({ buildingId: structure.id, cause: "combat-damage", reason: "damage", sourceId,
          tick, type: "structure-destroyed",
          ...(projectileIdentity === null ? {} : { projectileIdentity: clone(projectileIdentity) }) });
      }
    }
    return events;
  }

  #applyBuildingIntents(result, tick) {
    if (!result || result.tick !== tick || !Array.isArray(result.intents) ||
        result.intents.length > SESSION_BUILDING_MAX_INTENTS) {
      throw new TypeError("live battle building runtime result is invalid");
    }
    const replacements = new Map();
    const queued = [];
    const published = [];
    const structures = new Map(this.#structures.map((structure) => [structure.id, structure]));
    const battle = this.#battleRuntime();
    const unitIds = new Set(battle.state.units.map(({ id }) => id));
    const towerIds = new Set(battle.state.towers.map(({ id }) => id));
    for (let index = 0; index < result.intents.length; index += 1) {
      const intent = result.intents[index];
      if (!intent || typeof intent !== "object" || intent.order !== index || typeof intent.type !== "string") {
        throw new TypeError("live battle building runtime intent is invalid");
      }
      if (intent.type === "replace-structure") {
        const replacement = this.#buildingRuntime.validateStructureReceipt(canonical(intent.structure));
        const current = replacement && structures.get(replacement.id);
        if (!current || replacements.has(replacement.id) || replacement.cardId !== current.cardId ||
            replacement.class !== current.class || replacement.side !== current.side ||
            replacement.maxHitpoints !== current.maxHitpoints ||
            replacement.placedTick !== current.placedTick ||
            !Number.isSafeInteger(replacement.hitpoints) || replacement.hitpoints < 0 ||
            replacement.hitpoints > current.maxHitpoints || typeof replacement.alive !== "boolean" ||
            typeof replacement.targetable !== "boolean") {
          throw new TypeError("live battle building replacement intent is invalid");
        }
        replacements.set(replacement.id, clone(replacement));
      } else if (intent.type === "queue-hit") {
        if (!Number.isSafeInteger(intent.amount) || intent.amount < 1 ||
            intent.amount > Number.MAX_SAFE_INTEGER || intent.applyTick !== result.tick + 1 ||
            !Number.isSafeInteger(intent.sourceId) || !structures.has(intent.sourceId) ||
            !["structure", "tower", "unit"].includes(intent.targetKind) ||
            typeof intent.origin !== "string") {
          throw new TypeError("live battle building contact intent is invalid");
        }
        if ((intent.targetKind === "unit" || intent.targetKind === "structure") &&
            (!Number.isSafeInteger(intent.targetId) ||
             (intent.targetKind === "unit" ? !unitIds.has(intent.targetId) : !structures.has(intent.targetId)))) {
          throw new RangeError("live battle building contact target is unknown");
        }
        if (intent.targetKind === "tower" && (typeof intent.targetId !== "string" ||
            !towerIds.has(intent.targetId))) {
          throw new RangeError("live battle building tower contact target is unknown");
        }
        queued.push({ amount: intent.amount, applyTick: intent.applyTick, origin: intent.origin,
          sourceId: intent.sourceId, targetId: intent.targetId, targetKind: intent.targetKind });
      } else if (intent.type === "resource-grant") {
        const source = structures.get(intent.sourceId);
        if (!Number.isSafeInteger(intent.amount) || intent.amount < 1 || intent.amount > 10 ||
            !SIDES.has(intent.side) || !Number.isSafeInteger(intent.sourceId) ||
            !source || source.class !== "resource" || source.side !== intent.side ||
            intent.tick !== result.tick) {
          throw new TypeError("live battle building resource intent is invalid");
        }
        published.push({ amount: intent.amount, sourceId: intent.sourceId, side: intent.side,
          tick: intent.tick, type: "building-resource-grant" });
      } else if (intent.type === "event") {
        const value = intent.value;
        if (!value || typeof value !== "object" || Array.isArray(value) || value.tick !== result.tick ||
            typeof value.type !== "string") {
          throw new TypeError("live battle building event intent is invalid");
        }
        published.push(clone(value));
      } else {
        throw new TypeError("live battle building runtime intent type is invalid");
      }
    }
    if (this.#pendingBuildingHits.length + queued.length > MAX_PENDING_BUILDING_HITS) {
      throw new RangeError("live battle pending building contact capacity exceeded");
    }
    this.#structures = this.#structures.map((structure) => replacements.has(structure.id)
      ? replacements.get(structure.id) : structure).sort((left, right) => left.id - right.id);
    this.#pendingBuildingHits.push(...queued);
    this.#pendingBuildingHits.sort((left, right) => left.applyTick - right.applyTick ||
      left.sourceId - right.sourceId || String(left.targetId).localeCompare(String(right.targetId)) ||
      left.targetKind.localeCompare(right.targetKind));
    return published;
  }

  #buildingWitness() {
    return {
      pendingHits: clone(this.#pendingBuildingHits),
      pendingStructures: clone(this.#pendingStructures),
      structures: clone(this.#structures),
    };
  }

  #desiredTarget(unit, state) {
    const metadata = this.#metadata.get(unit.id);
    const enemies = state.units.filter((candidate) => candidate.alive && candidate.side !== unit.side &&
      layerEligible(unit.targetMode, candidate.layer) &&
      (!this.#hasStatusRuntime() || this.#statusTargetable(candidate.id, state.tick)));
    enemies.sort((left, right) => {
      const distance = squaredDistance(unit.position, left.position) -
        squaredDistance(unit.position, right.position);
      return distance < 0n ? -1 : distance > 0n ? 1 : left.id - right.id;
    });
    const sight = BigInt(unit.radius + unit.sightRange + (enemies[0]?.radius ?? 0));
    const enemy = enemies[0] !== undefined &&
      squaredDistance(unit.position, enemies[0].position) <= sight * sight ? enemies[0] : null;
    if (enemy !== null) {
      const inReach = BigInt(unit.radius + unit.reach + enemy.radius);
      if (squaredDistance(unit.position, enemy.position) <= inReach * inReach) {
        return { key: `hold-unit:${enemy.id}`, target: null };
      }
      const point = unit.layer === "ground" ? nearestGroundNode(enemy.position) : enemy.position;
      return {
        key: `unit:${enemy.id}:${point.x}:${point.y}`,
        target: { position: point, radius: enemy.radius, range: unit.reach },
      };
    }
    const structureSight = BigInt(unit.radius + unit.sightRange);
    const structures = this.#structures.filter((candidate) => candidate.alive &&
      candidate.targetable && candidate.side !== unit.side &&
      (unit.targetMode !== "buildings" || squaredDistance(unit.position,
        candidate.position) <= structureSight * structureSight));
    structures.sort((left, right) => {
      const distance = squaredDistance(unit.position, left.position) -
        squaredDistance(unit.position, right.position);
      return distance < 0n ? -1 : distance > 0n ? 1 : left.id - right.id;
    });
    if (structures.length > 0) {
      const targetStructure = structures[0];
      const structureKey = `structure:${targetStructure.id}`;
      if (metadata.targetKey === structureKey) return { key: structureKey, target: null };
      const point = unit.layer === "ground" ? nearestGroundNode(targetStructure.position) :
        targetStructure.position;
      return {
        key: structureKey,
        target: { position: point, radius: 0, range: unit.reach },
      };
    }
    const towers = state.towers.filter((tower) => tower.hitpoints > 0 && tower.side === otherSide(unit.side));
    towers.sort((left, right) => {
      const distance = squaredDistance(unit.position, left.position) -
        squaredDistance(unit.position, right.position);
      return distance < 0n ? -1 : distance > 0n ? 1 : left.id.localeCompare(right.id);
    });
    if (towers.length === 0) return { key: "idle", target: null };
    const targetTower = towers[0];
    const towerKey = `tower:${targetTower.id}`;
    if (metadata.targetKey === towerKey) return { key: towerKey, target: null };
    const point = unit.layer === "ground" ? nearestGroundNode(targetTower.position) : targetTower.position;
    return {
      key: towerKey,
      target: { position: point, radius: 0, range: unit.reach },
    };
  }

  #appendHistory(operation) {
    this.#history.push(operation);
    this.#historyCount += 1;
  }

  #assertPublicTranscript() {
    if (this.#isContinuation) {
      throw new TypeError("internal live battle continuation cannot expose a public transcript");
    }
  }

  #runtimeClone(includeTranscript = true) {
    const cloneSetup = this.#chainContinuation === null ? this.#setup : checkedSetup(
      Object.fromEntries(Object.entries(this.#setup).filter(([key]) =>
        key !== "chainQuestionPolicy")));
    const candidate = new LiveBattle(cloneSetup,
      this.#hasTroopRuntime() ? this.#troopRuntime.serialize() : undefined,
      this.#hasStatusRuntime() ? this.#statusRuntime.serialize() : undefined);
    const retainTranscript = includeTranscript && !this.#isContinuation;
    const battle = this.#battleRuntime();
    candidate.#battle = retainTranscript ? battle.fork() : battleTowerCompactClone(battle);
    candidate.#buildingRuntime = this.#buildingRuntime;
    candidate.#events = retainTranscript ? [...this.#events] : [];
    candidate.#history = retainTranscript ? [...this.#history] : [];
    candidate.#historyCount = this.#historyCount;
    candidate.#isContinuation = !retainTranscript;
    candidate.#metadata = new Map([...this.#metadata].map(([id, data]) => [id, clone(data)]));
    candidate.#movements = new Map([...this.#movements].map(([id, movement]) =>
      [id, battleMovementCompactClone(this.#movementRuntime(movement))]));
    candidate.#movementsOpaque = true;
    candidate.#nextEntityId = this.#nextEntityId;
    candidate.#pending = clone(this.#pending);
    candidate.#pendingBuildingHits = this.#pendingBuildingHits.length === 0
      ? [] : clone(this.#pendingBuildingHits);
    candidate.#pendingStructures = this.#pendingStructures.length === 0
      ? [] : clone(this.#pendingStructures);
    candidate.#pendingTroopActions = this.#pendingTroopActions.length === 0
      ? [] : clone(this.#pendingTroopActions);
    candidate.#pendingTroopStatusActions = this.#pendingTroopStatusActions.length === 0
      ? [] : clone(this.#pendingTroopStatusActions);
    candidate.#questionValues = new Map(this.#questionValues);
    candidate.#setup = this.#setup;
    candidate.#rosterById = new Map(candidate.#setup.roster.map((card) => [card.id, card]));
    candidate.#spells = this.#spells === null ? null : this.#spells.fork();
    candidate.#structures = this.#structures.length === 0 ? [] : clone(this.#structures);
    candidate.#statusEffects = this.#statusEffects.size === 0 ? new Map() : new Map(
      [...this.#statusEffects].map(([key, effect]) => [key, clone(effect)]));
    candidate.#troopRuntime = this.#hasTroopRuntime()
      ? this.#troopRuntime.fork()
      : EMPTY_TROOP_RUNTIME;
    candidate.#projectileRuntime = this.#projectileRuntime === null
      ? null : this.#projectileRuntime.fork();
    candidate.#chainContinuation = this.#chainContinuation === null
      ? null : this.#chainContinuation.fork();
    candidate.#troopStatuses = this.#troopStatuses.size === 0 ? new Map() : new Map(
      [...this.#troopStatuses].map(([key, status]) => [key, clone(status)]));
    return candidate;
  }

  #adopt(candidate) {
    this.#battle = candidate.#battle;
    this.#buildingRuntime = candidate.#buildingRuntime;
    this.#events = candidate.#events;
    this.#history = candidate.#history;
    this.#historyCount = candidate.#historyCount;
    this.#isContinuation = candidate.#isContinuation;
    this.#metadata = candidate.#metadata;
    this.#movements = candidate.#movements;
    this.#movementsOpaque = candidate.#movementsOpaque;
    this.#nextEntityId = candidate.#nextEntityId;
    this.#pending = candidate.#pending;
    this.#pendingBuildingHits = candidate.#pendingBuildingHits;
    this.#pendingStructures = candidate.#pendingStructures;
    this.#pendingTroopActions = candidate.#pendingTroopActions;
    this.#pendingTroopStatusActions = candidate.#pendingTroopStatusActions;
    this.#questionValues = candidate.#questionValues;
    this.#rosterById = candidate.#rosterById;
    this.#setup = candidate.#setup;
    this.#spells = candidate.#spells;
    this.#structures = candidate.#structures;
    this.#statusEffects = candidate.#statusEffects;
    this.#statusRuntime = candidate.#statusRuntime;
    this.#troopRuntime = candidate.#troopRuntime;
    this.#projectileRuntime = candidate.#projectileRuntime;
    this.#chainContinuation = candidate.#chainContinuation;
    this.#troopStatuses = candidate.#troopStatuses;
  }
}

function createLegacyLiveBattleForRestore(setup, troopRuntimeProfiles = undefined,
  statusRuntimeProfiles = undefined, projectileRuntimePlan = undefined) {
  return new LiveBattle(checkedSetup(setup, { legacyStructureReceipts: true }),
    troopRuntimeProfiles, statusRuntimeProfiles, projectileRuntimePlan);
}

function getLiveBattlePlayableCardIds(setup) {
  return freeze(admittedSetup(setup).roster.map(({ id }) => id));
}
  opaqueContinuation((value) => {
    if (!runtimeInstances.has(value)) {
      throw new TypeError("internal defineLiveBattle continuation receiver is invalid");
    }
    return compact(value);
  }, registerCompact);
  return { advanceFromSession, combatEffectFeed, createLegacyLiveBattleForRestore,
    getLiveBattlePlayableCardIds, LiveBattle,
    MAX_LIVE_BATTLE_DEPLOYMENTS, MAX_LIVE_BATTLE_STEP_TICKS, MAX_LIVE_BATTLE_STRUCTURES,
    MAX_LIVE_BATTLE_UNITS, parseLiveBattleSetup, towerSnapshot };
}

let compactMovement, resolveMovement, compactCombat, resolveCombat, compactCrownTower,
  resolveCrownTower, battleCombatCurrentTick, crownTowerCurrentTick, compactBattleTowers,
  resolveBattleTowers, compactLiveBattle, resolveLiveBattle, liveBattleAdvanceFromSession,
  liveBattleTowerSnapshot, liveBattleCombatEffectFeed;
const movement = defineBattleMovement((clone, resolve) => {
  compactMovement = clone; resolveMovement = resolve;
});
const combat = defineBattleCombat((clone, resolve) => {
  compactCombat = clone; resolveCombat = resolve;
});
battleCombatCurrentTick = combat.currentTick;
const towers = defineTowers((clone, resolve) => {
  compactCrownTower = clone; resolveCrownTower = resolve;
});
crownTowerCurrentTick = towers.currentTick;
const battleTowers = defineBattleTowers(combat.BattleCombat, towers.CrownTowerBattle,
  combat.MAX_BATTLE_COMBAT_STEP_TICKS, compactCombat, resolveCombat, compactCrownTower,
  resolveCrownTower, battleCombatCurrentTick, crownTowerCurrentTick,
  combat.recordStructureContacts, (clone, resolve) => {
    compactBattleTowers = clone; resolveBattleTowers = resolve;
  });
const liveBattle = defineLiveBattle(movement.BattleMovement, battleTowers.BattleTowerCombat,
  compactMovement, resolveMovement, compactBattleTowers, resolveBattleTowers,
  battleTowers.towerSnapshot, battleTowers.recordStructureContacts,
  battleTowers.towerCandidateGeometry,
  (clone, resolve) => { compactLiveBattle = clone; resolveLiveBattle = resolve; });
liveBattleAdvanceFromSession = liveBattle.advanceFromSession;
liveBattleTowerSnapshot = liveBattle.towerSnapshot;
liveBattleCombatEffectFeed = liveBattle.combatEffectFeed;

export const BATTLE_MOVEMENT_MODES = movement.BATTLE_MOVEMENT_MODES;
export const MAX_BATTLE_MOVEMENT_STEP_TICKS = movement.MAX_BATTLE_MOVEMENT_STEP_TICKS;
export const BattleMovement = movement.BattleMovement;
export const MAX_BATTLE_COMBAT_STEP_TICKS = combat.MAX_BATTLE_COMBAT_STEP_TICKS;
export const BattleCombat = combat.BattleCombat;
export const DynamicBattleCombat = combat.DynamicBattleCombat;
export const TOWER_TICKS_PER_SECOND = towers.TOWER_TICKS_PER_SECOND;
export const TOWER_COMBAT_CONFIG = towers.TOWER_COMBAT_CONFIG;
export const TOWER_WINDUP_ESTIMATE = towers.TOWER_WINDUP_ESTIMATE;
export const TOWER_LIVE_SHOT_DELIVERY = towers.TOWER_LIVE_SHOT_DELIVERY;
export const CrownTowerBattle = towers.CrownTowerBattle;
export const towerSecondsToTicks = towers.towerSecondsToTicks;
export const MAX_BATTLE_TOWER_STEP_TICKS = battleTowers.MAX_BATTLE_TOWER_STEP_TICKS;
export const BattleTowerCombat = battleTowers.BattleTowerCombat;
export const IntegratedBattleTowers = battleTowers.IntegratedBattleTowers;
export const MAX_LIVE_BATTLE_STEP_TICKS = liveBattle.MAX_LIVE_BATTLE_STEP_TICKS;
export const MAX_LIVE_BATTLE_DEPLOYMENTS = liveBattle.MAX_LIVE_BATTLE_DEPLOYMENTS;
export const MAX_LIVE_BATTLE_UNITS = liveBattle.MAX_LIVE_BATTLE_UNITS;
export const MAX_LIVE_BATTLE_STRUCTURES = liveBattle.MAX_LIVE_BATTLE_STRUCTURES;
export const parseLiveBattleSetup = liveBattle.parseLiveBattleSetup;
export const LiveBattle = liveBattle.LiveBattle;
export const getLiveBattlePlayableCardIds = liveBattle.getLiveBattlePlayableCardIds;


function defineElixir(registerCompact) {
  let compact;
  const runtimeInstances = new WeakSet();
const ELIXIR_TICKS_PER_SECOND = 60;
const ELIXIR_ACCUMULATOR_DENOMINATOR = 168;
const ELIXIR_CAPACITY = 10;
const ESTIMATED_STARTING_ELIXIR = 5;
const ELIXIR_MATCH_TICKS = 18_000;
const ELIXIR_MAX_PENDING_SPENDS = 10_000;
const ELIXIR_MAX_HISTORY_ENTRIES = 100_000;

const SIDES = Object.freeze(["south", "north"]);
const SIDE_SET = new Set(SIDES);
const PHASES = Object.freeze([
  Object.freeze({
    name: "single",
    fromTick: 0,
    toTick: 7_200,
    numeratorPerTick: 1,
    ticksPerElixir: 168,
    confidence: "high",
  }),
  Object.freeze({
    name: "double",
    fromTick: 7_200,
    toTick: 14_400,
    numeratorPerTick: 2,
    ticksPerElixir: 84,
    confidence: "high",
  }),
  Object.freeze({
    name: "triple",
    fromTick: 14_400,
    toTick: 18_000,
    numeratorPerTick: 3,
    ticksPerElixir: 56,
    confidence: "normalized_exact_third",
  }),
]);
const ELIXIR_MAX_GENERATED_EVENTS =
  SIDES.length *
  Math.floor(
    PHASES.reduce(
      (total, phase) =>
        total +
        (phase.toTick - phase.fromTick) * phase.numeratorPerTick,
      0,
    ) / ELIXIR_ACCUMULATOR_DENOMINATOR,
  );
const ELIXIR_MAX_EVENT_ENTRIES =
  ELIXIR_MAX_HISTORY_ENTRIES + ELIXIR_MAX_GENERATED_EVENTS;

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null) &&
    Object.getOwnPropertySymbols(value).length === 0
  );
}

function assertExactKeys(value, expected, label) {
  if (!isPlainObject(value)) {
    throw new TypeError(`${label} must be a plain object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    throw new TypeError(`${label} has an invalid shape`);
  }
}

function assertSafeTick(value, label = "tick") {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isPlainObject(value)) {
    const result = {};
    for (const key of Object.keys(value).sort()) {
      result[key] = canonicalize(value[key]);
    }
    return result;
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function validateSideState(value, label) {
  assertExactKeys(value, ["accumulator", "amount"], label);
  if (
    !Number.isInteger(value.amount) ||
    value.amount < 0 ||
    value.amount > ELIXIR_CAPACITY
  ) {
    throw new TypeError(`${label}.amount must be an integer from 0 to 10`);
  }
  if (
    !Number.isInteger(value.accumulator) ||
    value.accumulator < 0 ||
    value.accumulator >= ELIXIR_ACCUMULATOR_DENOMINATOR
  ) {
    throw new TypeError(
      `${label}.accumulator must be an integer from 0 to 167`,
    );
  }
  if (value.amount === ELIXIR_CAPACITY && value.accumulator !== 0) {
    throw new TypeError(`${label} cannot retain progress at capacity`);
  }
}

function validateHistoryEntry(entry, index) {
  assertExactKeys(entry, ["command", "events", "sequence", "tick"], `history[${index}]`);
  assertSafeTick(entry.tick, `history[${index}].tick`);
  if (!Number.isSafeInteger(entry.sequence) || entry.sequence < 0) {
    throw new TypeError(`history[${index}].sequence must be a safe integer`);
  }
  validateCommand(entry.command, `history[${index}].command`);
  if (!Array.isArray(entry.events) || entry.events.length !== 1) {
    throw new TypeError(`history[${index}].events must contain one spend event`);
  }
  validateEvent(entry.events[0], `history[${index}].events[0]`);
  if (
    entry.events[0].type !== "spend" ||
    entry.events[0].tick !== entry.tick ||
    entry.events[0].sequence !== entry.sequence ||
    entry.events[0].side !== entry.command.side ||
    entry.events[0].cost !== entry.command.cost
  ) {
    throw new TypeError(`history[${index}] command and event must correspond`);
  }
}

function validateCommand(command, label = "command") {
  assertExactKeys(command, ["cost", "side"], label);
  if (typeof command.side !== "string") {
    throw new TypeError(`${label}.side must be a string`);
  }
  if (typeof command.cost !== "number" || !Number.isFinite(command.cost)) {
    throw new TypeError(`${label}.cost must be a finite number`);
  }
}

function validateEvent(event, label) {
  if (!isPlainObject(event)) {
    throw new TypeError(`${label} must be a plain object`);
  }
  if (event.type === "generated") {
    assertExactKeys(event, ["amountAfter", "side", "tick", "type"], label);
    if (
      !SIDE_SET.has(event.side) ||
      !Number.isInteger(event.amountAfter) ||
      event.amountAfter < 1 ||
      event.amountAfter > ELIXIR_CAPACITY
    ) {
      throw new TypeError(`${label} has invalid generation values`);
    }
    assertSafeTick(event.tick, `${label}.tick`);
    return;
  }
  if (event.type === "spend") {
    assertExactKeys(
      event,
      [
        "accepted",
        "amountAfter",
        "cost",
        "reason",
        "sequence",
        "side",
        "tick",
        "type",
      ],
      label,
    );
    if (
      typeof event.accepted !== "boolean" ||
      !Number.isSafeInteger(event.sequence) ||
      event.sequence < 0 ||
      typeof event.side !== "string" ||
      typeof event.cost !== "number" ||
      !Number.isFinite(event.cost) ||
      ![
        "accepted",
        "insufficient_elixir",
        "invalid_cost",
        "invalid_side",
      ].includes(event.reason) ||
      (event.amountAfter !== null &&
        (!Number.isInteger(event.amountAfter) ||
          event.amountAfter < 0 ||
          event.amountAfter > ELIXIR_CAPACITY))
    ) {
      throw new TypeError(`${label} has invalid spend values`);
    }
    assertSafeTick(event.tick, `${label}.tick`);
    return;
  }
  throw new TypeError(`${label}.type is invalid`);
}

function phaseForTick(tick) {
  return PHASES.find((phase) => tick >= phase.fromTick && tick < phase.toTick);
}

function maximumGeneratedEventsThroughTick(tick) {
  let numerator = 0;
  for (const phase of PHASES) {
    const phaseTicks = Math.max(
      0,
      Math.min(tick, phase.toTick) - phase.fromTick,
    );
    numerator += phaseTicks * phase.numeratorPerTick;
  }
  return (
    SIDES.length *
    Math.floor(numerator / ELIXIR_ACCUMULATOR_DENOMINATOR)
  );
}

/** Return the generation phase for a match-start tick. */
function getElixirPhase(tick) {
  assertSafeTick(tick);
  const phase = phaseForTick(tick);
  if (!phase) {
    throw new RangeError(`tick must be before ${ELIXIR_MATCH_TICKS}`);
  }
  return cloneJson(phase);
}

/** Fresh JSON calibration data. Starting elixir is deliberately an estimate. */
function getElixirRules() {
  return {
    tickRateHz: ELIXIR_TICKS_PER_SECOND,
    capacity: ELIXIR_CAPACITY,
    startingElixir: {
      value: ESTIMATED_STARTING_ELIXIR,
      confidence: "estimate",
      note: "not independently corroborated in the reference corpus",
    },
    accumulator: {
      denominator: ELIXIR_ACCUMULATOR_DENOMINATOR,
      phaseChangePolicy: "preserve_fractional_progress",
      capacityPolicy: "reset_and_freeze",
    },
    tickSemantics: {
      interval: "[fromTick,toTick)",
      orderWithinTick: ["scheduled_spends_in_sequence_order", "generation"],
      firstDoubleTick: 7_200,
      firstTripleTick: 14_400,
    },
    resourceLimits: {
      resolvedCommands: ELIXIR_MAX_HISTORY_ENTRIES,
      pendingCommands: ELIXIR_MAX_PENDING_SPENDS,
      generatedEvents: ELIXIR_MAX_GENERATED_EVENTS,
      derivedEventLogEntries: ELIXIR_MAX_EVENT_ENTRIES,
    },
    phases: cloneJson(PHASES),
  };
}

class ElixirMatch {
  #startingElixir;
  #tick;
  #sides;
  #pending;
  #history;
  #events;
  #nextSequence;
  #grants;

  constructor({ startingElixir = ESTIMATED_STARTING_ELIXIR } = {}) {
    runtimeInstances.add(this);
    const startingSides = Number.isInteger(startingElixir)
      ? { north: startingElixir, south: startingElixir }
      : startingElixir;
    assertExactKeys(startingSides, SIDES, "startingElixir");
    for (const side of SIDES) {
      if (
        !Number.isInteger(startingSides[side]) ||
        startingSides[side] < 0 ||
        startingSides[side] > ELIXIR_CAPACITY
      ) {
        throw new TypeError(
          `startingElixir.${side} must be an integer from 0 to 10`,
        );
      }
    }
    this.#startingElixir = Number.isInteger(startingElixir)
      ? startingElixir
      : cloneJson(startingSides);
    this.#tick = 0;
    this.#sides = {
      north: { accumulator: 0, amount: startingSides.north },
      south: { accumulator: 0, amount: startingSides.south },
    };
    this.#pending = [];
    this.#history = [];
    this.#events = [];
    this.#nextSequence = 0;
    this.#grants = [];
  }

  get tick() {
    return this.#tick;
  }

  get state() {
    return cloneJson({ tick: this.#tick, sides: this.#sides });
  }

  get eventLog() {
    return cloneJson(this.#events);
  }

  get replayLog() {
    return cloneJson([...this.#history, ...this.#grants].sort(
      (left, right) =>
        left.tick - right.tick ||
        left.order - right.order ||
        left.sequence - right.sequence,
    ).map(({ order: _order, ...entry }) => entry));
  }

  phase() {
    return getElixirPhase(this.#tick);
  }

  scheduleSpend(tick, side, cost) {
    assertSafeTick(tick, "scheduled tick");
    if (tick < this.#tick) {
      throw new RangeError("cannot schedule a spend in a resolved tick");
    }
    if (tick >= ELIXIR_MATCH_TICKS) {
      throw new RangeError(`scheduled tick must be before ${ELIXIR_MATCH_TICKS}`);
    }
    if (this.#pending.length >= ELIXIR_MAX_PENDING_SPENDS) {
      throw new RangeError("pending spend limit exceeded");
    }
    if (this.#nextSequence >= Number.MAX_SAFE_INTEGER) {
      throw new RangeError("spend sequence limit exceeded");
    }
    if (typeof side !== "string") {
      throw new TypeError("side must be a string");
    }
    if (typeof cost !== "number" || !Number.isFinite(cost)) {
      throw new TypeError("cost must be a finite number");
    }
    const entry = {
      command: { cost, side },
      sequence: this.#nextSequence,
      tick,
    };
    this.#nextSequence += 1;
    this.#pending.push(entry);
    this.#pending.sort(
      (left, right) =>
        left.tick - right.tick || left.sequence - right.sequence,
    );
    return entry.sequence;
  }

  step({ grants = [] } = {}) {
    return this.#stepWithGrantSequences(grants);
  }

  #stepWithGrantSequences(grants, restoredGrantSequences = null) {
    if (this.#tick >= ELIXIR_MATCH_TICKS) {
      throw new RangeError("all configured elixir phase ticks are resolved");
    }
    if (!Array.isArray(grants) || grants.length > ELIXIR_MAX_PENDING_SPENDS) {
      throw new TypeError("grants must be a bounded array");
    }
    if (
      restoredGrantSequences !== null &&
      (!Array.isArray(restoredGrantSequences) ||
        restoredGrantSequences.length !== grants.length)
    ) {
      throw new TypeError("restored grant sequences must correspond to grants");
    }
    const checkedGrants = grants.map((grant, index) => {
      assertExactKeys(
        grant, ["amount", "side", "sourceId"], `grants[${index}]`,
      );
      if (!SIDE_SET.has(grant.side)) {
        throw new TypeError(`grants[${index}].side is invalid`);
      }
      if (!Number.isSafeInteger(grant.amount) || grant.amount < 1) {
        throw new TypeError(`grants[${index}].amount must be a positive integer`);
      }
      if (
        grant.sourceId !== null &&
        (!Number.isSafeInteger(grant.sourceId) || grant.sourceId < 1)
      ) {
        throw new TypeError(`grants[${index}].sourceId is invalid`);
      }
      return cloneJson(grant);
    });
    let dueCount = 0;
    while (this.#pending[dueCount]?.tick === this.#tick) dueCount += 1;
    const due = this.#pending.slice(0, dueCount);
    if (
      this.#history.length + this.#grants.length +
        due.length + checkedGrants.length >
        ELIXIR_MAX_HISTORY_ENTRIES
    ) {
      throw new RangeError("resolved elixir command history limit exceeded");
    }
    if (
      restoredGrantSequences === null &&
      this.#nextSequence >
      Number.MAX_SAFE_INTEGER - checkedGrants.length
    ) {
      throw new RangeError("elixir command sequence limit exceeded");
    }
    this.#pending.splice(0, dueCount);

    const tickEvents = [];
    for (const entry of due) {
      const events = [this.#resolveSpend(entry)];
      this.#history.push({ ...entry, events });
      tickEvents.push(...events);
    }

    const phase = phaseForTick(this.#tick);
    for (const side of SIDES) {
      const generated = this.#generate(side, phase.numeratorPerTick);
      if (generated) tickEvents.push(generated);
    }
    for (const [order, grant] of checkedGrants.entries()) {
      const sequence = restoredGrantSequences === null
        ? this.#nextSequence++
        : restoredGrantSequences[order];
      const sideState = this.#sides[grant.side];
      const amountGranted = Math.min(
        grant.amount,
        ELIXIR_CAPACITY - sideState.amount,
      );
      sideState.amount += amountGranted;
      if (sideState.amount === ELIXIR_CAPACITY) sideState.accumulator = 0;
      const event = {
        amountAfter: sideState.amount,
        amountGranted,
        amountRequested: grant.amount,
        side: grant.side,
        sourceId: grant.sourceId,
        tick: this.#tick,
        type: "grant",
      };
      this.#grants.push({
        command: { ...grant, type: "grant" },
        events: [event],
        order: due.length + order,
        sequence,
        tick: this.#tick,
      });
      tickEvents.push(event);
    }
    this.#events.push(...tickEvents);
    if (this.#events.length > ELIXIR_MAX_EVENT_ENTRIES) {
      throw new Error("derived elixir event log invariant exceeded");
    }
    this.#tick += 1;
    return cloneJson(tickEvents);
  }

  advanceTicks(count) {
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new TypeError("count must be a non-negative safe integer");
    }
    if (count > ELIXIR_MATCH_TICKS - this.#tick) {
      throw new RangeError("advance exceeds configured elixir phases");
    }
    const events = [];
    for (let index = 0; index < count; index += 1) {
      events.push(...this.step());
    }
    return events;
  }

  runToTick(targetTick) {
    assertSafeTick(targetTick, "target tick");
    if (targetTick < this.#tick) {
      throw new RangeError("target tick is already resolved");
    }
    return this.advanceTicks(targetTick - this.#tick);
  }

  replayBytes() {
    return canonicalJson(this.replayLog);
  }

  /**
   * Copies every present authority without replaying the public command log.
   * Composite session candidates use this internal checkpoint only; public
   * serialization and restoration remain the complete command transcript.
   */
  static {
    compact = (value) => value.#runtimeClone();
  }

  #runtimeClone() {
    const candidate = new ElixirMatch({ startingElixir: cloneJson(this.#startingElixir) });
    candidate.#tick = this.#tick;
    candidate.#sides = cloneJson(this.#sides);
    candidate.#pending = cloneJson(this.#pending);
    candidate.#history = cloneJson(this.#history);
    candidate.#events = cloneJson(this.#events);
    candidate.#nextSequence = this.#nextSequence;
    candidate.#grants = cloneJson(this.#grants);
    return candidate;
  }

  serialize() {
    const commands = [...this.#history, ...this.#pending]
      .sort((left, right) => left.sequence - right.sequence)
      .map(({ command, sequence, tick }) => ({ ...command, sequence, tick }));
    if (this.#grants.length === 0) return canonicalJson({
      commands: commands.map(({ sequence: _sequence, ...command }) => command),
      startingElixir: this.#startingElixir,
      tick: this.#tick,
      version: 2,
    });
    return canonicalJson({
      commands,
      grants: this.#grants.map(({ command, sequence, tick }) => ({
        amount: command.amount,
        sequence,
        side: command.side,
        sourceId: command.sourceId,
        tick,
      })),
      startingElixir: this.#startingElixir,
      tick: this.#tick,
      version: 3,
    });
  }

  static restore(serialized) {
    if (typeof serialized !== "string") {
      throw new TypeError("serialized snapshot must be a string");
    }
    let snapshot;
    try {
      snapshot = JSON.parse(serialized);
    } catch {
      throw new TypeError("serialized snapshot must be valid JSON");
    }
    if (snapshot?.version === 2) {
      assertExactKeys(
        snapshot,
        ["commands", "startingElixir", "tick", "version"],
        "snapshot",
      );
    } else if (snapshot?.version === 3) {
      assertExactKeys(
        snapshot,
        ["commands", "grants", "startingElixir", "tick", "version"],
        "snapshot",
      );
    } else {
      throw new TypeError("snapshot version must be 2 or 3");
    }
    assertSafeTick(snapshot.tick, "snapshot.tick");
    if (snapshot.tick > ELIXIR_MATCH_TICKS) {
      throw new TypeError("snapshot.tick exceeds configured phases");
    }
    const startingSides = Number.isInteger(snapshot.startingElixir)
      ? { north: snapshot.startingElixir, south: snapshot.startingElixir }
      : snapshot.startingElixir;
    assertExactKeys(startingSides, SIDES, "snapshot.startingElixir");
    for (const side of SIDES) {
      if (
        !Number.isInteger(startingSides[side]) ||
        startingSides[side] < 0 ||
        startingSides[side] > ELIXIR_CAPACITY
      ) {
        throw new TypeError(
          `snapshot.startingElixir.${side} must be an integer from 0 to 10`,
        );
      }
    }
    if (
      !Array.isArray(snapshot.commands) ||
      snapshot.commands.length >
        ELIXIR_MAX_HISTORY_ENTRIES + ELIXIR_MAX_PENDING_SPENDS
    ) {
      throw new TypeError("snapshot.commands has an invalid length");
    }
    const versionThreeEntries = snapshot.version === 3
      ? [...snapshot.commands, ...snapshot.grants]
      : [];
    const hasEncodedSequences = versionThreeEntries.some((value) =>
      isPlainObject(value) &&
      Object.prototype.hasOwnProperty.call(value, "sequence")
    );
    if (
      hasEncodedSequences &&
      versionThreeEntries.some((value) =>
        !isPlainObject(value) ||
        !Object.prototype.hasOwnProperty.call(value, "sequence")
      )
    ) {
      throw new TypeError("version 3 command sequences must be encoded uniformly");
    }
    const entries = snapshot.commands.map((value, index) => {
      assertExactKeys(
        value,
        hasEncodedSequences
          ? ["cost", "sequence", "side", "tick"]
          : ["cost", "side", "tick"],
        `commands[${index}]`,
      );
      const command = { cost: value.cost, side: value.side };
      validateCommand(command, `commands[${index}]`);
      const sequence = hasEncodedSequences ? value.sequence : index;
      if (!Number.isSafeInteger(sequence) || sequence < 0) {
        throw new TypeError(`commands[${index}].sequence must be a safe integer`);
      }
      assertSafeTick(value.tick, `commands[${index}].tick`);
      if (value.tick >= ELIXIR_MATCH_TICKS) {
        throw new TypeError(
          `commands[${index}].tick exceeds configured phases`,
        );
      }
      return { command, sequence, tick: value.tick };
    });
    const resolvedCount = entries.reduce(
      (count, entry) => count + Number(entry.tick < snapshot.tick),
      0,
    );
    const pendingCount = entries.length - resolvedCount;
    if (resolvedCount > ELIXIR_MAX_HISTORY_ENTRIES) {
      throw new TypeError("snapshot resolved command history is too long");
    }
    if (pendingCount > ELIXIR_MAX_PENDING_SPENDS) {
      throw new TypeError("snapshot pending command history is too long");
    }
    if (
      resolvedCount + maximumGeneratedEventsThroughTick(snapshot.tick) >
      ELIXIR_MAX_EVENT_ENTRIES
    ) {
      throw new TypeError(
        "snapshot exceeds the derived elixir event log limit",
      );
    }

    if (
      snapshot.version === 3 &&
      (!Array.isArray(snapshot.grants) ||
        snapshot.grants.length > ELIXIR_MAX_HISTORY_ENTRIES)
    ) {
      throw new TypeError("snapshot.grants has an invalid length");
    }
    const grants = snapshot.version === 3
      ? snapshot.grants.map((grant, index) => {
        assertExactKeys(
          grant,
          hasEncodedSequences
            ? ["amount", "sequence", "side", "sourceId", "tick"]
            : ["amount", "side", "sourceId", "tick"],
          `grants[${index}]`,
        );
        const sequence = hasEncodedSequences
          ? grant.sequence
          : entries.length + index;
        if (!Number.isSafeInteger(sequence) || sequence < 0) {
          throw new TypeError(`grants[${index}].sequence must be a safe integer`);
        }
        assertSafeTick(grant.tick, `grants[${index}].tick`);
        if (grant.tick >= snapshot.tick) {
          throw new TypeError(`grants[${index}].tick is not resolved`);
        }
        return {
          amount: grant.amount,
          sequence,
          side: grant.side,
          sourceId: grant.sourceId,
          tick: grant.tick,
        };
      })
      : [];
    if (resolvedCount + grants.length > ELIXIR_MAX_HISTORY_ENTRIES) {
      throw new TypeError("snapshot resolved elixir command history is too long");
    }
    const unifiedSequences = [...entries, ...grants]
      .map(({ sequence }) => sequence)
      .sort((left, right) => left - right);
    if (
      unifiedSequences.some((sequence, index) => sequence !== index)
    ) {
      throw new TypeError(
        "snapshot elixir command sequences must be unique and contiguous",
      );
    }
    if (hasEncodedSequences) {
      let lastGrantTick = -1;
      for (const entry of [...entries, ...grants]
        .sort((left, right) => left.sequence - right.sequence)) {
        if ("amount" in entry) {
          if (entry.tick < lastGrantTick) {
            throw new TypeError(
              "snapshot grant sequences are not causally ordered",
            );
          }
          lastGrantTick = entry.tick;
        } else if (entry.tick <= lastGrantTick) {
          throw new TypeError(
            "snapshot spend sequence is not causally schedulable",
          );
        }
      }
    }
    const match = new ElixirMatch({
      startingElixir: snapshot.startingElixir,
    });
    // Commands are the sole causal authority. Cached balances, accumulators,
    // results, sequence numbers, and generated events have no snapshot
    // representation and are rebuilt by the normal deterministic transition.
    match.#pending = entries.sort(
      (left, right) =>
        left.tick - right.tick || left.sequence - right.sequence,
    );
    match.#nextSequence = unifiedSequences.length;
    while (match.tick < snapshot.tick) {
      const tickGrants = grants.filter(({ tick }) => tick === match.tick);
      match.#stepWithGrantSequences(
        tickGrants.map(({
          sequence: _sequence,
          tick: _tick,
          ...grant
        }) => grant),
        tickGrants.map(({ sequence }) => sequence),
      );
    }
    return match;
  }

  #resolveSpend(entry) {
    const { side, cost } = entry.command;
    let reason = "accepted";
    let accepted = true;
    if (!SIDE_SET.has(side)) {
      accepted = false;
      reason = "invalid_side";
    } else if (!Number.isInteger(cost) || cost < 1 || cost > ELIXIR_CAPACITY) {
      accepted = false;
      reason = "invalid_cost";
    } else if (this.#sides[side].amount < cost) {
      accepted = false;
      reason = "insufficient_elixir";
    } else {
      this.#sides[side].amount -= cost;
    }
    return {
      accepted,
      amountAfter: SIDE_SET.has(side) ? this.#sides[side].amount : null,
      cost,
      reason,
      sequence: entry.sequence,
      side,
      tick: this.#tick,
      type: "spend",
    };
  }

  #generate(side, numerator) {
    const state = this.#sides[side];
    if (state.amount === ELIXIR_CAPACITY) {
      state.accumulator = 0;
      return null;
    }
    state.accumulator += numerator;
    if (state.accumulator < ELIXIR_ACCUMULATOR_DENOMINATOR) {
      return null;
    }
    state.accumulator -= ELIXIR_ACCUMULATOR_DENOMINATOR;
    state.amount += 1;
    if (state.amount === ELIXIR_CAPACITY) state.accumulator = 0;
    return {
      amountAfter: state.amount,
      side,
      tick: this.#tick,
      type: "generated",
    };
  }
}
  opaqueContinuation((value) => {
    if (!runtimeInstances.has(value)) {
      throw new TypeError("internal defineElixir continuation receiver is invalid");
    }
    return compact(value);
  }, registerCompact);
  return { ELIXIR_ACCUMULATOR_DENOMINATOR, ELIXIR_CAPACITY, ELIXIR_MATCH_TICKS, ELIXIR_MAX_EVENT_ENTRIES, ELIXIR_MAX_GENERATED_EVENTS, ELIXIR_MAX_HISTORY_ENTRIES, ELIXIR_MAX_PENDING_SPENDS, ELIXIR_TICKS_PER_SECOND, ESTIMATED_STARTING_ELIXIR, ElixirMatch, getElixirPhase, getElixirRules };
}

function defineMatch(registerCompact) {
  let compact;
  const runtimeInstances = new WeakSet();
const MATCH_TICKS_PER_SECOND = 60;
const MATCH_REGULATION_TICKS = 10_800;
const MATCH_TRIPLE_ELIXIR_TICK = 14_400;
const MATCH_MAX_TICKS = 18_000;
const MATCH_MAX_EVIDENCE_COMMANDS = 10_000;

const SIDES = Object.freeze(["north", "south"]);
const TOWER_IDS = Object.freeze([
  "north:central",
  "north:lane:left",
  "north:lane:right",
  "south:central",
  "south:lane:left",
  "south:lane:right",
]);
const TOWER_ID_SET = new Set(TOWER_IDS);

function otherSide(side) {
  return side === "north" ? "south" : "north";
}

function towerSide(id) {
  return id.startsWith("north:") ? "north" : "south";
}

function towerRole(id) {
  return id.endsWith(":central") ? "central" : "lane";
}

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null) &&
    Object.getOwnPropertySymbols(value).length === 0
  );
}

function exactObject(value, keys, label) {
  if (!isPlainObject(value)) {
    throw new TypeError(`${label} must be a plain object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const actual = Reflect.ownKeys(descriptors);
  if (actual.some((key) => typeof key !== "string")) {
    throw new TypeError(`${label} must contain only string keys`);
  }
  const wanted = [...keys].sort();
  const sorted = [...actual].sort();
  if (
    sorted.length !== wanted.length ||
    sorted.some((key, index) => key !== wanted[index])
  ) {
    throw new TypeError(`${label} has an invalid shape`);
  }
  const result = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
      throw new TypeError(`${label}.${key} must be an enumerable data property`);
    }
    result[key] = descriptor.value;
  }
  return result;
}

function exactArray(value, length, label) {
  if (!Array.isArray(value) || value.length !== length) {
    throw new TypeError(`${label} must be an array of length ${length}`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (key === "length") continue;
    if (
      typeof key !== "string" ||
      !/^(0|[1-9]\d*)$/.test(key) ||
      Number(key) >= length
    ) {
      throw new TypeError(`${label} must contain only indexed data`);
    }
    const descriptor = descriptors[key];
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
      throw new TypeError(`${label}[${key}] must be an enumerable data property`);
    }
  }
  return Array.from(value);
}

function safeTick(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isPlainObject(value)) {
    const result = {};
    for (const key of Object.keys(value).sort()) {
      result[key] = canonicalize(value[key]);
    }
    return result;
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function checkedTowerArray(value, label, { allowZero }) {
  const towers = exactArray(value, TOWER_IDS.length, label).map(
    (raw, index) => {
      const tower = exactObject(
        raw,
        ["hitpoints", "id"],
        `${label}[${index}]`,
      );
      if (tower.id !== TOWER_IDS[index]) {
        throw new TypeError(
          `${label}[${index}].id must be ${TOWER_IDS[index]}`,
        );
      }
      if (
        !Number.isSafeInteger(tower.hitpoints) ||
        tower.hitpoints < (allowZero ? 0 : 1)
      ) {
        throw new TypeError(
          `${label}[${index}].hitpoints must be a ${allowZero ? "non-negative" : "positive"} safe integer`,
        );
      }
      return { hitpoints: tower.hitpoints, id: tower.id };
    },
  );
  return towers;
}

function checkedEvidence(value, label = "evidence") {
  const evidence = exactObject(
    value,
    ["destroyedTowerIds", "towers"],
    label,
  );
  const towers = checkedTowerArray(evidence.towers, `${label}.towers`, {
    allowZero: true,
  });
  const destroyedTowerIds = exactArray(
    evidence.destroyedTowerIds,
    towers.filter((tower) => tower.hitpoints === 0).length,
    `${label}.destroyedTowerIds`,
  );
  const expected = towers
    .filter((tower) => tower.hitpoints === 0)
    .map((tower) => tower.id);
  if (
    destroyedTowerIds.some(
      (id, index) =>
        typeof id !== "string" ||
        !TOWER_ID_SET.has(id) ||
        id !== expected[index],
    )
  ) {
    throw new TypeError(
      `${label}.destroyedTowerIds must exactly match zero-HP towers`,
    );
  }
  return { destroyedTowerIds: [...destroyedTowerIds], towers };
}

function towerMap(towers) {
  return Object.fromEntries(
    towers.map((tower) => [tower.id, tower.hitpoints]),
  );
}

function validateEvidenceTransition(previousTowers, nextTowers) {
  const previous = towerMap(previousTowers);
  for (const tower of nextTowers) {
    if (tower.hitpoints > previous[tower.id]) {
      throw new TypeError(
        `tower evidence cannot increase hitpoints for ${tower.id}`,
      );
    }
    if (previous[tower.id] === 0 && tower.hitpoints !== 0) {
      throw new TypeError(
        `tower evidence cannot revive destroyed tower ${tower.id}`,
      );
    }
  }
}

function commandOrder(left, right) {
  return left.tick - right.tick || left.sequence - right.sequence;
}

function insertionIndex(ordered, entry) {
  let low = 0;
  let high = ordered.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (commandOrder(ordered[middle], entry) <= 0) low = middle + 1;
    else high = middle;
  }
  return low;
}

function resultObject({ crowns, endedAtTick, kind, reason, winner }) {
  return {
    crowns: { north: crowns.north, south: crowns.south },
    endedAtTick,
    kind,
    reason,
    winner,
  };
}

/**
 * Return the neutral match clock phase. Boundaries are half-open:
 * regulation=[0,10800), overtime=[10800,18000), ended={18000}.
 */
function getMatchPhase(tick) {
  safeTick(tick, "tick");
  if (tick > MATCH_MAX_TICKS) {
    throw new RangeError(`tick must not exceed ${MATCH_MAX_TICKS}`);
  }
  if (tick === MATCH_MAX_TICKS) {
    return {
      clock: "ended",
      elixirRate: null,
      fromTick: MATCH_MAX_TICKS,
      toTick: MATCH_MAX_TICKS,
    };
  }
  return {
    clock: tick < MATCH_REGULATION_TICKS ? "regulation" : "overtime",
    elixirRate:
      tick < 7_200 ? "single" : tick < MATCH_TRIPLE_ELIXIR_TICK ? "double" : "triple",
    fromTick:
      tick < 7_200
        ? 0
        : tick < MATCH_REGULATION_TICKS
          ? 7_200
          : tick < MATCH_TRIPLE_ELIXIR_TICK
            ? MATCH_REGULATION_TICKS
            : MATCH_TRIPLE_ELIXIR_TICK,
    toTick:
      tick < 7_200
        ? 7_200
        : tick < MATCH_REGULATION_TICKS
          ? MATCH_REGULATION_TICKS
          : tick < MATCH_TRIPLE_ELIXIR_TICK
            ? MATCH_TRIPLE_ELIXIR_TICK
            : MATCH_MAX_TICKS,
  };
}

function getMatchRules() {
  return {
    simultaneousOvertimeDestruction: {
      confidence: "corpus_silent_deterministic_policy",
      policy: "opposing destructions on the first overtime destruction tick draw",
    },
    tickRateHz: MATCH_TICKS_PER_SECOND,
    tickSemantics: {
      interval: "[fromTick,toTick)",
      orderAtRegulationBoundary: [
        "regulation_result_or_enter_overtime",
        "tick_10800_evidence",
      ],
      orderAtMaximumBoundary: [
        "tiebreak_from_last_completed_evidence",
        "reject_tick_18000_evidence",
      ],
      sameTickEvidence: "sequence_order_then_one_combined_destruction_result",
    },
    resourceLimits: {
      evidenceCommands: MATCH_MAX_EVIDENCE_COMMANDS,
    },
    tiebreak: {
      model:
        "instant comparison is the mathematical result of equal-rate HP drain",
      tiePolicy:
        "all towers at each side's equal minimum drain simultaneously; exact inter-side tie is a draw",
    },
    timings: {
      maximumTicks: MATCH_MAX_TICKS,
      overtimeTicks: MATCH_MAX_TICKS - MATCH_REGULATION_TICKS,
      regulationTicks: MATCH_REGULATION_TICKS,
      tripleElixirFromTick: MATCH_TRIPLE_ELIXIR_TICK,
    },
    towerIds: [...TOWER_IDS],
  };
}

class MatchClock {
  #initialTowers;
  #tick;
  #commands;
  #orderedCommands;
  #pending;
  #nextSequence;
  #towers;
  #crowns;
  #destroyed;
  #overtime;
  #result;
  #events;
  #replay;

  constructor({ initialTowers } = {}) {
    runtimeInstances.add(this);
    this.#initialTowers = checkedTowerArray(
      initialTowers,
      "initialTowers",
      { allowZero: false },
    );
    this.#tick = 0;
    this.#commands = [];
    this.#orderedCommands = [];
    this.#pending = [];
    this.#nextSequence = 0;
    this.#resetDerived();
  }

  #resetDerived() {
    this.#towers = towerMap(this.#initialTowers);
    this.#crowns = { north: 0, south: 0 };
    this.#destroyed = new Set();
    this.#overtime = false;
    this.#result = null;
    this.#events = [];
    this.#replay = [];
  }

  get tick() {
    return this.#tick;
  }

  get state() {
    return cloneJson({
      crowns: this.#crowns,
      destroyedTowerIds: TOWER_IDS.filter((id) => this.#destroyed.has(id)),
      phase: this.#result
        ? "ended"
        : this.#overtime
          ? "overtime"
          : "regulation",
      result: this.#result,
      tick: this.#tick,
      towers: TOWER_IDS.map((id) => ({ hitpoints: this.#towers[id], id })),
    });
  }

  get eventLog() {
    return cloneJson(this.#events);
  }

  get replayLog() {
    return cloneJson(this.#replay);
  }

  phase() {
    if (this.#result) {
      return {
        clock: "ended",
        elixirRate:
          this.#tick < MATCH_MAX_TICKS
            ? getMatchPhase(this.#tick).elixirRate
            : null,
        result: cloneJson(this.#result),
      };
    }
    return getMatchPhase(this.#tick);
  }

  scheduleTowerEvidence(tick, evidence) {
    safeTick(tick, "scheduled tick");
    if (this.#tick === MATCH_MAX_TICKS) {
      throw new RangeError("maximum match tick is already resolved");
    }
    if (tick < this.#tick) {
      throw new RangeError("cannot schedule evidence in a resolved tick");
    }
    if (tick > MATCH_MAX_TICKS) {
      throw new RangeError(`scheduled tick must not exceed ${MATCH_MAX_TICKS}`);
    }
    if (this.#commands.length >= MATCH_MAX_EVIDENCE_COMMANDS) {
      throw new RangeError("tower evidence command limit exceeded");
    }
    if (this.#nextSequence >= Number.MAX_SAFE_INTEGER) {
      throw new RangeError("tower evidence sequence limit exceeded");
    }
    const entry = {
      evidence: checkedEvidence(evidence),
      sequence: this.#nextSequence,
      tick,
    };
    const orderedIndex = insertionIndex(this.#orderedCommands, entry);
    const previousTowers =
      orderedIndex === 0
        ? this.#initialTowers
        : this.#orderedCommands[orderedIndex - 1].evidence.towers;
    const nextTowers =
      this.#orderedCommands[orderedIndex]?.evidence.towers ?? null;
    validateEvidenceTransition(previousTowers, entry.evidence.towers);
    if (nextTowers) {
      validateEvidenceTransition(entry.evidence.towers, nextTowers);
    }
    this.#nextSequence += 1;
    this.#commands.push(entry);
    this.#orderedCommands.splice(orderedIndex, 0, entry);
    const pendingIndex = insertionIndex(this.#pending, entry);
    this.#pending.splice(pendingIndex, 0, entry);
    return entry.sequence;
  }

  step() {
    if (this.#tick >= MATCH_MAX_TICKS) {
      throw new RangeError("maximum match tick is already resolved");
    }
    const tickEvents = [];
    tickEvents.push(...this.#resolveEvidenceAtCurrentTick());
    this.#tick += 1;
    if (this.#tick === MATCH_REGULATION_TICKS) {
      tickEvents.push(...this.#resolveRegulationBoundary());
    } else if (this.#tick === MATCH_MAX_TICKS) {
      // A successful step resolves every automatic boundary at the tick it
      // reaches. Evidence for tick 17999 has already been applied above, so
      // the tiebreak uses the latest complete tower state. Evidence stamped
      // 18000 is outside [0,18000) and is rejected only after that result is
      // permanent.
      tickEvents.push(...this.#resolveTiebreak());
      tickEvents.push(...this.#rejectMaximumTickEvidence());
    }
    this.#events.push(...tickEvents);
    return cloneJson(tickEvents);
  }

  advanceTicks(count) {
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new TypeError("count must be a non-negative safe integer");
    }
    if (count > MATCH_MAX_TICKS - this.#tick) {
      throw new RangeError("advance exceeds maximum match time");
    }
    const events = [];
    for (let index = 0; index < count; index += 1) {
      events.push(...this.step());
    }
    return cloneJson(events);
  }

  runToTick(targetTick) {
    safeTick(targetTick, "target tick");
    if (targetTick < this.#tick) {
      throw new RangeError("target tick is already resolved");
    }
    return this.advanceTicks(targetTick - this.#tick);
  }

  serialize() {
    return canonicalJson({
      commands: [...this.#commands]
        .sort((left, right) => left.sequence - right.sequence)
        .map(({ evidence, tick }) => ({ evidence, tick })),
      initialTowers: this.#initialTowers,
      tick: this.#tick,
      version: 1,
    });
  }

  replayBytes() {
    return canonicalJson(this.#replay);
  }

  /**
   * Copies every present authority without reconstructing it from the public
   * command transcript. Composite owners use this only for an internal
   * transactional candidate; the normal serialize/restore contract is
   * unchanged.
   */
  static {
    compact = (value) => value.#runtimeClone();
  }

  #runtimeClone() {
    const candidate = new MatchClock({ initialTowers: cloneJson(this.#initialTowers) });
    candidate.#tick = this.#tick;
    candidate.#commands = cloneJson(this.#commands);
    candidate.#orderedCommands = cloneJson(this.#orderedCommands);
    candidate.#pending = cloneJson(this.#pending);
    candidate.#nextSequence = this.#nextSequence;
    candidate.#towers = cloneJson(this.#towers);
    candidate.#crowns = cloneJson(this.#crowns);
    candidate.#destroyed = new Set(this.#destroyed);
    candidate.#overtime = this.#overtime;
    candidate.#result = this.#result === null ? null : cloneJson(this.#result);
    candidate.#events = cloneJson(this.#events);
    candidate.#replay = cloneJson(this.#replay);
    return candidate;
  }

  static restore(serialized) {
    if (typeof serialized !== "string") {
      throw new TypeError("serialized snapshot must be a string");
    }
    let snapshot;
    try {
      snapshot = JSON.parse(serialized);
    } catch {
      throw new TypeError("serialized snapshot must be valid JSON");
    }
    const checked = exactObject(
      snapshot,
      ["commands", "initialTowers", "tick", "version"],
      "snapshot",
    );
    if (checked.version !== 1) {
      throw new TypeError("snapshot.version must be 1");
    }
    safeTick(checked.tick, "snapshot.tick");
    if (checked.tick > MATCH_MAX_TICKS) {
      throw new TypeError("snapshot.tick exceeds maximum match time");
    }
    const initialTowers = checkedTowerArray(
      checked.initialTowers,
      "snapshot.initialTowers",
      { allowZero: false },
    );
    if (
      !Array.isArray(checked.commands) ||
      checked.commands.length > MATCH_MAX_EVIDENCE_COMMANDS
    ) {
      throw new TypeError("snapshot.commands has an invalid length");
    }
    exactArray(
      checked.commands,
      checked.commands.length,
      "snapshot.commands",
    );
    const match = new MatchClock({ initialTowers });
    for (let index = 0; index < checked.commands.length; index += 1) {
      const command = exactObject(
        checked.commands[index],
        ["evidence", "tick"],
        `snapshot.commands[${index}]`,
      );
      safeTick(command.tick, `snapshot.commands[${index}].tick`);
      if (command.tick > MATCH_MAX_TICKS) {
        throw new TypeError(
          `snapshot.commands[${index}].tick exceeds maximum match time`,
        );
      }
      match.scheduleTowerEvidence(command.tick, command.evidence);
    }
    match.runToTick(checked.tick);
    return match;
  }

  #resolveRegulationBoundary() {
    if (this.#result) return [];
    if (this.#crowns.north !== this.#crowns.south) {
      const winner =
        this.#crowns.north > this.#crowns.south ? "north" : "south";
      this.#end("win", "regulation_crowns", winner, this.#tick);
      return [{ result: cloneJson(this.#result), tick: this.#tick, type: "match_end" }];
    }
    this.#overtime = true;
    return [{ tick: this.#tick, type: "overtime_started" }];
  }

  #resolveEvidenceAtCurrentTick() {
    let dueCount = 0;
    while (this.#pending[dueCount]?.tick === this.#tick) dueCount += 1;
    if (dueCount === 0) return [];
    const due = this.#pending.splice(0, dueCount);
    if (this.#result) {
      return due.map((entry) => this.#rejectedEntry(entry));
    }
    const events = [];
    const newlyDestroyed = [];
    for (const entry of due) {
      const before = { ...this.#towers };
      for (const tower of entry.evidence.towers) {
        this.#towers[tower.id] = tower.hitpoints;
        if (
          tower.hitpoints === 0 &&
          before[tower.id] > 0 &&
          !this.#destroyed.has(tower.id)
        ) {
          this.#destroyed.add(tower.id);
          newlyDestroyed.push(tower.id);
        }
      }
      const event = {
        accepted: true,
        destroyedTowerIds: entry.evidence.destroyedTowerIds,
        sequence: entry.sequence,
        tick: this.#tick,
        type: "tower_evidence",
      };
      events.push(event);
      this.#replay.push({
        command: { evidence: entry.evidence, tick: entry.tick },
        event,
        sequence: entry.sequence,
      });
    }
    if (newlyDestroyed.length > 0) {
      this.#awardCrowns(newlyDestroyed);
      events.push(...this.#resolveDestructionResult(newlyDestroyed));
    }
    return events;
  }

  #awardCrowns(ids) {
    for (const id of ids) {
      const scorer = otherSide(towerSide(id));
      if (towerRole(id) === "central") {
        this.#crowns[scorer] = 3;
      } else if (this.#crowns[scorer] < 3) {
        this.#crowns[scorer] += 1;
      }
    }
  }

  #resolveDestructionResult(ids) {
    const losingSides = new Set(ids.map(towerSide));
    const centralLosingSides = new Set(
      ids.filter((id) => towerRole(id) === "central").map(towerSide),
    );
    let reason = null;
    if (centralLosingSides.size > 0) reason = "central_destroyed";
    else if (this.#overtime) reason = "overtime_sudden_death";
    if (!reason) return [];

    let kind;
    let winner;
    if (losingSides.size === 2) {
      if (this.#crowns.north === this.#crowns.south) {
        kind = "draw";
        winner = null;
      } else {
        kind = "win";
        winner =
          this.#crowns.north > this.#crowns.south ? "north" : "south";
      }
    } else {
      kind = "win";
      winner = otherSide([...losingSides][0]);
    }
    this.#end(kind, reason, winner, this.#tick);
    return [{ result: cloneJson(this.#result), tick: this.#tick, type: "match_end" }];
  }

  #resolveTiebreak() {
    if (this.#result) return [];
    const minima = {};
    for (const side of SIDES) {
      minima[side] = Math.min(
        ...TOWER_IDS.filter(
          (id) => towerSide(id) === side && this.#towers[id] > 0,
        ).map((id) => this.#towers[id]),
      );
    }
    const losingSides =
      minima.north === minima.south
        ? ["north", "south"]
        : [minima.north < minima.south ? "north" : "south"];
    const drained = TOWER_IDS.filter(
      (id) =>
        losingSides.includes(towerSide(id)) &&
        this.#towers[id] === minima[towerSide(id)],
    );
    for (const id of drained) {
      this.#towers[id] = 0;
      this.#destroyed.add(id);
    }
    this.#awardCrowns(drained);
    const winner =
      losingSides.length === 2 ? null : otherSide(losingSides[0]);
    this.#end(
      winner === null ? "draw" : "win",
      winner === null ? "tiebreak_exact_tie" : "tiebreak_lowest_hp",
      winner,
      MATCH_MAX_TICKS,
    );
    return [{
      drainedTowerIds: drained,
      minima,
      result: cloneJson(this.#result),
      tick: MATCH_MAX_TICKS,
      type: "tiebreak",
    }];
  }

  #rejectMaximumTickEvidence() {
    const due = this.#pending.filter((entry) => entry.tick === MATCH_MAX_TICKS);
    this.#pending = this.#pending.filter(
      (entry) => entry.tick !== MATCH_MAX_TICKS,
    );
    return due.map((entry) => this.#rejectedEntry(entry));
  }

  #rejectedEntry(entry) {
    const event = {
      accepted: false,
      reason: "match_ended",
      sequence: entry.sequence,
      tick: this.#tick,
      type: "tower_evidence",
    };
    this.#replay.push({
      command: { evidence: entry.evidence, tick: entry.tick },
      event,
      sequence: entry.sequence,
    });
    return event;
  }

  #end(kind, reason, winner, endedAtTick) {
    if (this.#result) return;
    this.#result = resultObject({
      crowns: this.#crowns,
      endedAtTick,
      kind,
      reason,
      winner,
    });
  }
}
  opaqueContinuation((value) => {
    if (!runtimeInstances.has(value)) {
      throw new TypeError("internal defineMatch continuation receiver is invalid");
    }
    return compact(value);
  }, registerCompact);
  return { MATCH_MAX_EVIDENCE_COMMANDS, MATCH_MAX_TICKS, MATCH_REGULATION_TICKS, MATCH_TICKS_PER_SECOND, MATCH_TRIPLE_ELIXIR_TICK, MatchClock, getMatchPhase, getMatchRules };
}

function defineOpponentController(registerCompact) {
  let compact;
  const runtimeInstances = new WeakSet();

const OPPONENT_CONTROLLER_ALGORITHM =
  "bounded-seeded-opponent-controller-v1";
const OPPONENT_CONTROLLER_MAX_BATCH_TICKS = 4_096;
const OPPONENT_CONTROLLER_MAX_CANDIDATES = 1_024;
const OPPONENT_CONTROLLER_MAX_DECISIONS = 10_000;
const OPPONENT_CONTROLLER_MAX_REPLAY_BYTES = 3 * 1_024 * 1_024;
const OPPONENT_CONTROLLER_MAX_TICKS = 1_000_000;

const SNAPSHOT_MAX_BYTES = 4 * 1_024 * 1_024;
const CARD_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;
const SNAPSHOT_KEYS = Object.freeze([
  "algorithm",
  "nextSequence",
  "nextTick",
  "replay",
  "rng",
  "seed",
  "thinkIntervalTicks",
  "thinkOffsetTicks",
  "version",
]);

const hasOwn = (value, key) =>
  Object.prototype.hasOwnProperty.call(value, key);

function assertPlainRecord(value, label, expectedKeys) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    throw new TypeError(`${label} must be a plain object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Object.keys(descriptors).sort();
  if (keys.join(",") !== [...expectedKeys].sort().join(",")) {
    throw new TypeError(`${label} has an invalid shape`);
  }
  for (const key of keys) {
    if (!("value" in descriptors[key])) {
      throw new TypeError(`${label}.${key} must be a data property`);
    }
  }
  return descriptors;
}

function assertSafeInteger(value, label, minimum, maximum) {
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

function assertCardId(value, label) {
  if (typeof value !== "string" || !CARD_ID_PATTERN.test(value)) {
    throw new TypeError(`${label} must be a canonical card id`);
  }
  return value;
}

function assertSeed(value) {
  if (
    (typeof value === "string" &&
      new TextEncoder().encode(value).length <= 256) ||
    Number.isSafeInteger(value)
  ) return value;
  throw new TypeError("seed must be a string or safe integer");
}

function assertDenseArray(value, label, maximumLength) {
  if (!Array.isArray(value) || value.length > maximumLength) {
    throw new TypeError(`${label} must contain at most ${maximumLength} entries`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const enumerableKeys = Object.keys(descriptors)
    .filter((key) => descriptors[key].enumerable)
    .sort();
  const expectedKeys = Array.from({ length: value.length }, (_, index) =>
    String(index)).sort();
  if (enumerableKeys.join(",") !== expectedKeys.join(",")) {
    throw new TypeError(`${label} must be a dense data array`);
  }
  for (const key of expectedKeys) {
    if (!("value" in descriptors[key])) {
      throw new TypeError(`${label} must be a dense data array`);
    }
  }
  return descriptors;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const result = {};
    for (const key of Object.keys(value).sort()) {
      result[key] = canonicalize(value[key]);
    }
    return result;
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function isolated(value) {
  return deepFreeze(canonicalize(value));
}

function compareCandidates(left, right) {
  return (
    (left.cardId < right.cardId ? -1 : left.cardId > right.cardId ? 1 : 0) ||
    left.point.x - right.point.x ||
    left.point.y - right.point.y
  );
}

function checkCanonicalOrder(values, compare, label) {
  for (let index = 1; index < values.length; index += 1) {
    if (compare(values[index - 1], values[index]) >= 0) {
      throw new TypeError(`${label} must be unique and canonically ordered`);
    }
  }
}

function validateObservation(value, expectedTick) {
  const fields = assertPlainRecord(value, "observation", [
    "legalNorthDeployments",
    "northCardCosts",
    "northElixir",
    "northHand",
    "tick",
  ]);
  const tick = assertSafeInteger(
    fields.tick.value,
    "observation.tick",
    0,
    OPPONENT_CONTROLLER_MAX_TICKS - 1,
  );
  if (tick !== expectedTick) {
    throw new RangeError(
      `observation.tick must equal next unresolved tick ${expectedTick}`,
    );
  }
  const northElixir = assertSafeInteger(
    fields.northElixir.value,
    "observation.northElixir",
    0,
    10,
  );

  const northHandRaw = fields.northHand.value;
  const handDescriptors = assertDenseArray(
    northHandRaw,
    "observation.northHand",
    8,
  );
  const northHand = [];
  const handSet = new Set();
  for (let index = 0; index < northHandRaw.length; index += 1) {
    const descriptor = handDescriptors[String(index)];
    const cardId = assertCardId(
      descriptor.value,
      `observation.northHand[${index}]`,
    );
    if (handSet.has(cardId)) {
      throw new TypeError("observation.northHand must not contain duplicates");
    }
    handSet.add(cardId);
    northHand.push(cardId);
  }

  const costsRaw = fields.northCardCosts.value;
  const costDescriptors = assertDenseArray(
    costsRaw,
    "observation.northCardCosts",
    8,
  );
  if (costsRaw.length !== northHand.length) {
    throw new TypeError(
      "observation.northCardCosts must contain exactly one cost per hand card",
    );
  }
  const northCardCosts = [];
  const costMap = new Map();
  for (let index = 0; index < costsRaw.length; index += 1) {
    const descriptor = costDescriptors[String(index)];
    const costFields = assertPlainRecord(
      descriptor.value,
      `observation.northCardCosts[${index}]`,
      ["cardId", "cost"],
    );
    const cardId = assertCardId(
      costFields.cardId.value,
      `observation.northCardCosts[${index}].cardId`,
    );
    const cost = assertSafeInteger(
      costFields.cost.value,
      `observation.northCardCosts[${index}].cost`,
      0,
      10,
    );
    if (!handSet.has(cardId) || costMap.has(cardId)) {
      throw new TypeError(
        "observation.northCardCosts must uniquely cover the north hand",
      );
    }
    costMap.set(cardId, cost);
    northCardCosts.push({ cardId, cost });
  }
  checkCanonicalOrder(
    northCardCosts,
    (left, right) =>
      left.cardId < right.cardId ? -1 : left.cardId > right.cardId ? 1 : 0,
    "observation.northCardCosts",
  );

  const candidatesRaw = fields.legalNorthDeployments.value;
  const candidateDescriptors = assertDenseArray(
    candidatesRaw,
    "observation.legalNorthDeployments",
    OPPONENT_CONTROLLER_MAX_CANDIDATES,
  );
  const legalNorthDeployments = [];
  for (let index = 0; index < candidatesRaw.length; index += 1) {
    const descriptor = candidateDescriptors[String(index)];
    const candidateFields = assertPlainRecord(
      descriptor.value,
      `observation.legalNorthDeployments[${index}]`,
      ["cardId", "point"],
    );
    const cardId = assertCardId(
      candidateFields.cardId.value,
      `observation.legalNorthDeployments[${index}].cardId`,
    );
    if (!handSet.has(cardId)) {
      throw new TypeError(
        "observation.legalNorthDeployments must reference only hand cards",
      );
    }
    const pointFields = assertPlainRecord(
      candidateFields.point.value,
      `observation.legalNorthDeployments[${index}].point`,
      ["x", "y"],
    );
    const point = {
      x: assertSafeInteger(
        pointFields.x.value,
        `observation.legalNorthDeployments[${index}].point.x`,
        0,
        1_000_000,
      ),
      y: assertSafeInteger(
        pointFields.y.value,
        `observation.legalNorthDeployments[${index}].point.y`,
        0,
        1_000_000,
      ),
    };
    legalNorthDeployments.push({ cardId, point });
  }
  checkCanonicalOrder(
    legalNorthDeployments,
    compareCandidates,
    "observation.legalNorthDeployments",
  );

  return { legalNorthDeployments, northCardCosts, northElixir, northHand, tick };
}

function validateProposal(value, expectedTick, expectedSequence) {
  const fields = assertPlainRecord(value, "replay proposal", [
    "cardId",
    "point",
    "sequence",
    "side",
    "tick",
    "type",
  ]);
  if (fields.type.value !== "deploy" || fields.side.value !== "north") {
    throw new TypeError("replay proposal has an invalid type or side");
  }
  const cardId = assertCardId(fields.cardId.value, "replay proposal.cardId");
  const tick = assertSafeInteger(
    fields.tick.value,
    "replay proposal.tick",
    0,
    OPPONENT_CONTROLLER_MAX_TICKS - 1,
  );
  const sequence = assertSafeInteger(
    fields.sequence.value,
    "replay proposal.sequence",
    0,
    OPPONENT_CONTROLLER_MAX_DECISIONS - 1,
  );
  if (tick !== expectedTick || sequence !== expectedSequence) {
    throw new TypeError("replay proposal is not causally contiguous");
  }
  const pointFields = assertPlainRecord(fields.point.value, "replay proposal.point", [
    "x",
    "y",
  ]);
  return {
    cardId,
    point: {
      x: assertSafeInteger(pointFields.x.value, "replay proposal.point.x", 0, 1_000_000),
      y: assertSafeInteger(pointFields.y.value, "replay proposal.point.y", 0, 1_000_000),
    },
    sequence,
    side: "north",
    tick,
    type: "deploy",
  };
}

class OpponentController {
  #nextSequence = 0;
  #nextTick = 0;
  #replay = [];
  #rng;
  #seed;
  #thinkIntervalTicks;
  #thinkOffsetTicks;

  constructor(options = {}) {
    runtimeInstances.add(this);
    if (
      options === null ||
      typeof options !== "object" ||
      Array.isArray(options) ||
      Object.getPrototypeOf(options) !== Object.prototype
    ) {
      throw new TypeError("controller options must be a plain object");
    }
    const descriptors = Object.getOwnPropertyDescriptors(options);
    const optionKeys = Object.keys(descriptors).sort();
    if (
      optionKeys.some((key) =>
        !["seed", "thinkIntervalTicks", "thinkOffsetTicks"].includes(key)) ||
      !hasOwn(descriptors, "seed")
    ) {
      throw new TypeError("controller options have an invalid shape");
    }
    for (const key of optionKeys) {
      if (!("value" in descriptors[key])) {
        throw new TypeError(`controller option ${key} must be a data property`);
      }
    }
    const seed = descriptors.seed.value;
    const thinkIntervalTicks = hasOwn(descriptors, "thinkIntervalTicks")
      ? descriptors.thinkIntervalTicks.value
      : 30;
    const thinkOffsetTicks = hasOwn(descriptors, "thinkOffsetTicks")
      ? descriptors.thinkOffsetTicks.value
      : 0;
    this.#seed = assertSeed(seed);
    this.#thinkIntervalTicks = assertSafeInteger(
      thinkIntervalTicks,
      "thinkIntervalTicks",
      1,
      3_600,
    );
    this.#thinkOffsetTicks = assertSafeInteger(
      thinkOffsetTicks,
      "thinkOffsetTicks",
      0,
      this.#thinkIntervalTicks - 1,
    );
    this.#rng = new SeededRandom(this.#seed).fork(
      OPPONENT_CONTROLLER_ALGORITHM,
    );
  }

  get state() {
    return isolated({
      nextSequence: this.#nextSequence,
      nextTick: this.#nextTick,
      thinkIntervalTicks: this.#thinkIntervalTicks,
      thinkOffsetTicks: this.#thinkOffsetTicks,
    });
  }

  get replayLog() {
    return isolated(this.#replay);
  }

  /** Composite-session checkpoint with exact continuation and no duplicate provenance. */
  static {
    compact = (value) => value.#runtimeClone();
  }

  #runtimeClone() {
    const candidate = new OpponentController({ seed: this.#seed,
      thinkIntervalTicks: this.#thinkIntervalTicks, thinkOffsetTicks: this.#thinkOffsetTicks });
    candidate.#nextSequence = this.#nextSequence;
    candidate.#nextTick = this.#nextTick;
    candidate.#rng = SeededRandom.restore(this.#rng.serialize());
    return candidate;
  }

  step(observation) {
    return this.stepMany([observation]);
  }

  stepMany(observations) {
    const observationDescriptors = assertDenseArray(
      observations,
      "observations",
      OPPONENT_CONTROLLER_MAX_BATCH_TICKS,
    );
    if (this.#nextTick + observations.length > OPPONENT_CONTROLLER_MAX_TICKS) {
      throw new RangeError("controller cannot exceed its total tick bound");
    }

    const checked = [];
    let expectedTick = this.#nextTick;
    let addedDecisions = 0;
    for (let index = 0; index < observations.length; index += 1) {
      const descriptor = observationDescriptors[String(index)];
      const observation = validateObservation(descriptor.value, expectedTick);
      checked.push(observation);
      if (this.#isThinkTick(expectedTick)) addedDecisions += 1;
      expectedTick += 1;
    }
    if (this.#replay.length + addedDecisions > OPPONENT_CONTROLLER_MAX_DECISIONS) {
      throw new RangeError("controller cannot exceed its decision history bound");
    }

    const stagedRng = SeededRandom.restore(this.#rng.serialize());
    let stagedSequence = this.#nextSequence;
    const additions = [];
    const proposals = [];
    for (const observation of checked) {
      if (this.#isThinkTick(observation.tick)) {
        const costs = new Map(
          observation.northCardCosts.map(({ cardId, cost }) => [cardId, cost]),
        );
        const eligible = observation.legalNorthDeployments.filter(
          ({ cardId }) => costs.get(cardId) <= observation.northElixir,
        ).map(({ cardId, point }) => ({
          cardId,
          cost: costs.get(cardId),
          point,
        }));
        let choiceIndex = null;
        let proposal = null;
        if (eligible.length > 0) {
          choiceIndex = stagedRng.int(eligible.length);
          const selected = eligible[choiceIndex];
          proposal = isolated({
            cardId: selected.cardId,
            point: selected.point,
            sequence: stagedSequence,
            side: "north",
            tick: observation.tick,
            type: "deploy",
          });
          stagedSequence += 1;
          proposals.push(proposal);
        }
        additions.push(
          isolated({
            choiceIndex,
            eligibleCandidates: eligible,
            eligibleCount: eligible.length,
            observation: {
              legalNorthDeployments: observation.legalNorthDeployments,
              northCardCosts: observation.northCardCosts,
              northElixir: observation.northElixir,
              northHand: observation.northHand,
            },
            proposal,
            tick: observation.tick,
          }),
        );
      }
    }
    const replay = [...this.#replay, ...additions];
    if (
      new TextEncoder().encode(canonicalJson(replay)).length >
      OPPONENT_CONTROLLER_MAX_REPLAY_BYTES
    ) {
      throw new RangeError("controller cannot exceed its replay byte bound");
    }
    this.#rng = stagedRng;
    this.#nextSequence = stagedSequence;
    this.#nextTick += checked.length;
    this.#replay = replay;
    return isolated(proposals);
  }

  replayBytes() {
    return canonicalJson(this.#replay);
  }

  serialize() {
    return canonicalJson({
      algorithm: OPPONENT_CONTROLLER_ALGORITHM,
      nextSequence: this.#nextSequence,
      nextTick: this.#nextTick,
      replay: this.#replay,
      rng: this.#rng.serialize(),
      seed: this.#seed,
      thinkIntervalTicks: this.#thinkIntervalTicks,
      thinkOffsetTicks: this.#thinkOffsetTicks,
      version: 1,
    });
  }

  static restore(serialized) {
    if (typeof serialized !== "string") {
      throw new TypeError("serialized controller snapshot must be a string");
    }
    if (new TextEncoder().encode(serialized).length > SNAPSHOT_MAX_BYTES) {
      throw new RangeError("serialized controller snapshot exceeds its byte bound");
    }
    let snapshot;
    try {
      snapshot = JSON.parse(serialized);
    } catch {
      throw new TypeError("serialized controller snapshot must be valid JSON");
    }
    const fields = assertPlainRecord(snapshot, "controller snapshot", SNAPSHOT_KEYS);
    if (canonicalJson(snapshot) !== serialized) {
      throw new TypeError("serialized controller snapshot must be canonical JSON");
    }
    if (
      fields.algorithm.value !== OPPONENT_CONTROLLER_ALGORITHM ||
      fields.version.value !== 1
    ) {
      throw new TypeError("controller snapshot has an unsupported algorithm");
    }
    const seed = assertSeed(fields.seed.value);
    const thinkIntervalTicks = assertSafeInteger(
      fields.thinkIntervalTicks.value,
      "snapshot.thinkIntervalTicks",
      1,
      3_600,
    );
    const thinkOffsetTicks = assertSafeInteger(
      fields.thinkOffsetTicks.value,
      "snapshot.thinkOffsetTicks",
      0,
      thinkIntervalTicks - 1,
    );
    const nextTick = assertSafeInteger(
      fields.nextTick.value,
      "snapshot.nextTick",
      0,
      OPPONENT_CONTROLLER_MAX_TICKS,
    );
    const nextSequence = assertSafeInteger(
      fields.nextSequence.value,
      "snapshot.nextSequence",
      0,
      OPPONENT_CONTROLLER_MAX_DECISIONS,
    );
    const replayRaw = fields.replay.value;
    if (
      !Array.isArray(replayRaw) ||
      replayRaw.length > OPPONENT_CONTROLLER_MAX_DECISIONS
    ) {
      throw new TypeError("snapshot.replay exceeds its decision history bound");
    }

    const controller = new OpponentController({
      seed,
      thinkIntervalTicks,
      thinkOffsetTicks,
    });
    const replay = [];
    let proposalSequence = 0;
    let expectedDecisionTick = thinkOffsetTicks;
    for (let index = 0; index < replayRaw.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(replayRaw, String(index));
      if (descriptor === undefined || !("value" in descriptor)) {
        throw new TypeError("snapshot.replay must be a dense data array");
      }
      const replayFields = assertPlainRecord(
        descriptor.value,
        `snapshot.replay[${index}]`,
        [
          "choiceIndex",
          "eligibleCandidates",
          "eligibleCount",
          "observation",
          "proposal",
          "tick",
        ],
      );
      const tick = assertSafeInteger(
        replayFields.tick.value,
        `snapshot.replay[${index}].tick`,
        0,
        OPPONENT_CONTROLLER_MAX_TICKS - 1,
      );
      if (tick !== expectedDecisionTick || tick >= nextTick) {
        throw new TypeError("snapshot.replay decision ticks are not causal");
      }
      const eligibleCount = assertSafeInteger(
        replayFields.eligibleCount.value,
        `snapshot.replay[${index}].eligibleCount`,
        0,
        OPPONENT_CONTROLLER_MAX_CANDIDATES,
      );
      const observationFields = assertPlainRecord(
        replayFields.observation.value,
        `snapshot.replay[${index}].observation`,
        [
          "legalNorthDeployments",
          "northCardCosts",
          "northElixir",
          "northHand",
        ],
      );
      const observation = validateObservation(
        {
          legalNorthDeployments:
            observationFields.legalNorthDeployments.value,
          northCardCosts: observationFields.northCardCosts.value,
          northElixir: observationFields.northElixir.value,
          northHand: observationFields.northHand.value,
          tick,
        },
        tick,
      );
      const costs = new Map(
        observation.northCardCosts.map(({ cardId, cost }) => [cardId, cost]),
      );
      const expectedEligible = observation.legalNorthDeployments
        .filter(({ cardId }) => costs.get(cardId) <= observation.northElixir)
        .map(({ cardId, point }) => ({
          cardId,
          cost: costs.get(cardId),
          point,
        }));
      if (
        eligibleCount !== expectedEligible.length ||
        canonicalJson(replayFields.eligibleCandidates.value) !==
          canonicalJson(expectedEligible)
      ) {
        throw new TypeError(
          "snapshot eligible candidates do not match their causal observation",
        );
      }
      let choiceIndex = replayFields.choiceIndex.value;
      let proposal = replayFields.proposal.value;
      if (eligibleCount === 0) {
        if (choiceIndex !== null || proposal !== null) {
          throw new TypeError("empty replay decisions cannot contain a choice");
        }
      } else {
        choiceIndex = assertSafeInteger(
          choiceIndex,
          `snapshot.replay[${index}].choiceIndex`,
          0,
          eligibleCount - 1,
        );
        const expectedChoice = controller.#rng.int(eligibleCount);
        if (choiceIndex !== expectedChoice) {
          throw new TypeError("snapshot replay does not match its seeded RNG");
        }
        proposal = validateProposal(proposal, tick, proposalSequence);
        const selected = expectedEligible[choiceIndex];
        if (
          proposal.cardId !== selected.cardId ||
          proposal.point.x !== selected.point.x ||
          proposal.point.y !== selected.point.y
        ) {
          throw new TypeError(
            "snapshot proposal does not match its seeded eligible candidate",
          );
        }
        proposalSequence += 1;
      }
      replay.push(isolated({
        choiceIndex,
        eligibleCandidates: expectedEligible,
        eligibleCount,
        observation: {
          legalNorthDeployments: observation.legalNorthDeployments,
          northCardCosts: observation.northCardCosts,
          northElixir: observation.northElixir,
          northHand: observation.northHand,
        },
        proposal,
        tick,
      }));
      expectedDecisionTick += thinkIntervalTicks;
    }
    const expectedDecisionCount =
      nextTick <= thinkOffsetTicks
        ? 0
        : Math.floor((nextTick - 1 - thinkOffsetTicks) / thinkIntervalTicks) + 1;
    if (
      replay.length !== expectedDecisionCount ||
      proposalSequence !== nextSequence ||
      new TextEncoder().encode(canonicalJson(replay)).length >
        OPPONENT_CONTROLLER_MAX_REPLAY_BYTES
    ) {
      throw new TypeError("snapshot replay is incomplete or noncontiguous");
    }
    const restoredRng = SeededRandom.restore(fields.rng.value);
    if (canonicalJson(restoredRng.serialize()) !== canonicalJson(controller.#rng.serialize())) {
      throw new TypeError("snapshot RNG state does not match its replay");
    }

    controller.#nextTick = nextTick;
    controller.#nextSequence = nextSequence;
    controller.#replay = replay;
    controller.#rng = restoredRng;
    return controller;
  }

  #isThinkTick(tick) {
    return (
      tick >= this.#thinkOffsetTicks &&
      (tick - this.#thinkOffsetTicks) % this.#thinkIntervalTicks === 0
    );
  }
}
  opaqueContinuation((value) => {
    if (!runtimeInstances.has(value)) {
      throw new TypeError("internal defineOpponentController continuation receiver is invalid");
    }
    return compact(value);
  }, registerCompact);
  return { OPPONENT_CONTROLLER_ALGORITHM, OPPONENT_CONTROLLER_MAX_BATCH_TICKS, OPPONENT_CONTROLLER_MAX_CANDIDATES, OPPONENT_CONTROLLER_MAX_DECISIONS, OPPONENT_CONTROLLER_MAX_REPLAY_BYTES, OPPONENT_CONTROLLER_MAX_TICKS, OpponentController };
}

function defineGameSession(ElixirMatch, LiveBattle, MATCH_MAX_TICKS, MatchClock,
  OpponentController, TOWER_COMBAT_CONFIG, compactElixirMatch, compactLiveBattle,
  compactMatchClock, compactOpponentController, resolveElixirMatch, resolveLiveBattle,
  resolveMatchClock, resolveOpponentController, createLegacyLiveBattleForRestore,
  liveBattleCombatEffectFeed) {

let getAudioReplay;

const GAME_SESSION_MAX_BATCH_TICKS = 18_000;
const GAME_SESSION_MAX_SETUP_BYTES = 2 * 1_024 * 1_024;
const GAME_SESSION_MAX_SNAPSHOT_BYTES = 32 * 1_024 * 1_024;
const GAME_SESSION_MAX_TRANSCRIPT = 20_000;
const GAME_SESSION_SETUP_GRAPH_LIMITS = Object.freeze({ arrayLength: 4_096,
  containers: 4_096, depth: 64, keys: 128, nodes: 12_000, stringLength: 1_048_576 });
const GAME_SESSION_SNAPSHOT_GRAPH_LIMITS = Object.freeze({ arrayLength: 20_000,
  containers: 100_000, depth: 128, keys: 1_024, nodes: 200_000,
  stringLength: 8_388_608 });
const COMMAND_GRAPH_LIMITS = Object.freeze({ arrayLength: 32, containers: 32, depth: 8,
  keys: 16, nodes: 64, stringLength: 8_192 });
const SETUP_KEYS = ["battleSetup", "deck", "legalNorthDeployments", "rosterWitness",
  "seed", "startingElixir", "thinkIntervalTicks", "thinkOffsetTicks"];
const SETUP_KEYS_WITH_TROOP_RUNTIME = [...SETUP_KEYS, "troopRuntimeProfiles"];
const SETUP_KEYS_WITH_STATUS_RUNTIME = [...SETUP_KEYS, "statusRuntimeProfiles"];
const SETUP_KEYS_WITH_BOTH_RUNTIMES = [
  ...SETUP_KEYS, "statusRuntimeProfiles", "troopRuntimeProfiles",
];
const SETUP_KEYS_WITH_PROJECTILE_RUNTIME = [...SETUP_KEYS, "projectileRuntimeProfiles"];
const SETUP_KEYS_WITH_TROOP_AND_PROJECTILE_RUNTIME = [
  ...SETUP_KEYS, "projectileRuntimeProfiles", "troopRuntimeProfiles",
];
const SETUP_KEYS_WITH_STATUS_AND_PROJECTILE_RUNTIME = [
  ...SETUP_KEYS, "projectileRuntimeProfiles", "statusRuntimeProfiles",
];
const SETUP_KEYS_WITH_ALL_RUNTIMES = [
  ...SETUP_KEYS, "projectileRuntimeProfiles", "statusRuntimeProfiles", "troopRuntimeProfiles",
];
const ABILITY_COMMAND_KEYS = [
  "actionId", "commandId", "point", "side", "sourceId", "targetId", "tick", "type",
];
const authenticGameSessions = new WeakSet();
const authenticGameSessionProjectionSnapshots = new WeakSet();
// Module-private capability: only restore/restart can instantiate a pre-HBA
// route-only structure setup. Fresh construction is always strict.
const LEGACY_STRUCTURE_RESTORE = Symbol("legacy structure restore");
const GAME_SESSION_SNAPSHOT_SUFFIX = "],\"version\":2}";
const GAME_SESSION_SNAPSHOT_SUFFIX_BYTES = GAME_SESSION_SNAPSHOT_SUFFIX.length;
// A clone shell may reuse only this frozen setup graph, which has already
// passed the complete public setup admission. The fieldless token itself is
// private to GameSession instances; WeakMap identity lookup cannot inspect a
// forged, proxied, or revoked caller-supplied value.
const prevalidatedGameSessionSetups = new WeakMap();

function isAuthenticGameSession(value) {
  return authenticGameSessions.has(value);
}

function isAuthenticGameSessionProjectionSnapshot(value) {
  return authenticGameSessionProjectionSnapshots.has(value);
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.keys(value).sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
const clone = (value) => JSON.parse(JSON.stringify(value));
function freeze(value) { if (value && typeof value === "object" && !Object.isFrozen(value)) {
  for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value; }
function exact(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) throw new TypeError(`${label} must be a plain object`);
  const actual = Object.keys(value).sort(), expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${label} has an invalid shape`);
  }
  return value;
}
function scalarByteLength(text, label) {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const low = text.charCodeAt(index + 1);
      if (!(low >= 0xdc00 && low <= 0xdfff)) throw new TypeError(`${label} contains a lone surrogate`);
      bytes += 4; index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new TypeError(`${label} contains a lone surrogate`);
    } else bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : 3;
  }
  return bytes;
}
function preflight(value, limits, label) {
  const stack = [{ depth: 0, path: [], value }]; let containers = 0, nodes = 0;
  while (stack.length) {
    const current = stack.pop(); nodes += 1;
    if (nodes > limits.nodes) throw new RangeError(`${label} exceeds its node bound`);
    if (current.depth > limits.depth) throw new RangeError(`${label} exceeds its depth bound`);
    const entry = current.value;
    if (typeof entry === "string") {
      if (entry.length > limits.stringLength) throw new RangeError(`${label} exceeds its string bound`);
      scalarByteLength(entry, label); continue;
    }
    const isStatusReceiptProvenance = current.path.includes("statusRuntimeProfiles");
    if (typeof entry === "number" && (!Number.isSafeInteger(entry) || !Number.isFinite(entry)) &&
        !(isStatusReceiptProvenance && Number.isFinite(entry))) {
      throw new TypeError(`${label} contains a non-safe integer`);
    }
    if (entry === null || typeof entry === "boolean" || typeof entry === "number") continue;
    if (!entry || typeof entry !== "object") throw new TypeError(`${label} contains an invalid value`);
    containers += 1;
    if (containers > limits.containers) throw new RangeError(`${label} exceeds its container bound`);
    if (Array.isArray(entry)) {
      if (entry.length > limits.arrayLength) throw new RangeError(`${label} exceeds its array bound`);
      for (let index = entry.length - 1; index >= 0; index -= 1) {
        stack.push({ depth: current.depth + 1, path: [...current.path, index], value: entry[index] });
      }
      continue;
    }
    if (Object.getPrototypeOf(entry) !== Object.prototype) throw new TypeError(`${label} contains a non-plain object`);
    const keys = Object.keys(entry);
    if (keys.length > limits.keys) throw new RangeError(`${label} exceeds its key bound`);
    for (let index = keys.length - 1; index >= 0; index -= 1) {
      const key = keys[index];
      if (key.length > limits.stringLength) throw new RangeError(`${label} exceeds its string bound`);
      scalarByteLength(key, label);
      if (["__proto__", "constructor", "prototype"].includes(key)) {
        throw new TypeError(`${label} contains a forbidden key`);
      }
      stack.push({ depth: current.depth + 1, path: current.path.length === 0
        ? [key] : [...current.path, key], value: entry[key] });
    }
  }
  return value;
}
function parsed(serialized, label, maximum = GAME_SESSION_MAX_SNAPSHOT_BYTES,
  limits = GAME_SESSION_SNAPSHOT_GRAPH_LIMITS) {
  if (typeof serialized !== "string") throw new TypeError(`${label} must be canonical JSON text`);
  if (scalarByteLength(serialized, label) > maximum) throw new RangeError(`${label} exceeds its byte bound`);
  let value; try { value = JSON.parse(serialized); } catch { throw new TypeError(`${label} must be valid JSON`); }
  preflight(value, limits, label);
  if (canonical(value) !== serialized) throw new TypeError(`${label} must be canonical JSON`);
  return value;
}
function validateSetup(bytes, { allowLegacyStructureReceipts = false,
  projectileRuntimePlan = undefined } = {}) {
  const rawSetup = parsed(bytes, "game session setup", GAME_SESSION_MAX_SETUP_BYTES,
    GAME_SESSION_SETUP_GRAPH_LIMITS);
  const hasTroopRuntimeProfiles = Object.hasOwn(rawSetup, "troopRuntimeProfiles");
  const hasStatusRuntimeProfiles = Object.hasOwn(rawSetup, "statusRuntimeProfiles");
  const hasProjectileRuntimeProfiles = Object.hasOwn(rawSetup, "projectileRuntimeProfiles");
  const setup = exact(rawSetup, hasTroopRuntimeProfiles && hasStatusRuntimeProfiles &&
    hasProjectileRuntimeProfiles ? SETUP_KEYS_WITH_ALL_RUNTIMES
    : hasTroopRuntimeProfiles && hasProjectileRuntimeProfiles
      ? SETUP_KEYS_WITH_TROOP_AND_PROJECTILE_RUNTIME
      : hasStatusRuntimeProfiles && hasProjectileRuntimeProfiles
        ? SETUP_KEYS_WITH_STATUS_AND_PROJECTILE_RUNTIME
        : hasProjectileRuntimeProfiles ? SETUP_KEYS_WITH_PROJECTILE_RUNTIME
          : hasTroopRuntimeProfiles && hasStatusRuntimeProfiles
            ? SETUP_KEYS_WITH_BOTH_RUNTIMES
            : hasTroopRuntimeProfiles ? SETUP_KEYS_WITH_TROOP_RUNTIME
              : hasStatusRuntimeProfiles ? SETUP_KEYS_WITH_STATUS_RUNTIME : SETUP_KEYS,
  "game session setup");
  const battleSetupValue = parsed(setup.battleSetup, "game session battle setup", GAME_SESSION_MAX_SETUP_BYTES,
    GAME_SESSION_SETUP_GRAPH_LIMITS);
  parsed(setup.rosterWitness, "game session roster witness", GAME_SESSION_MAX_SETUP_BYTES,
    GAME_SESSION_SETUP_GRAPH_LIMITS);
  const legacyStructureReceipts = Array.isArray(battleSetupValue.roster) &&
    battleSetupValue.roster.some((card) => card !== null && typeof card === "object" &&
      !Array.isArray(card) && card.kind === "structure" && !Object.hasOwn(card, "buildingRuntime"));
  const troopRuntimeProfiles = Object.hasOwn(setup, "troopRuntimeProfiles")
    ? canonical(parseSessionTroopRuntimeProfiles(canonical(setup.troopRuntimeProfiles)))
    : undefined;
  if (troopRuntimeProfiles !== undefined && troopRuntimeProfiles !== canonical(setup.troopRuntimeProfiles)) {
    throw new TypeError("session troop runtime profiles diverge from their canonical setup");
  }
  const statusRuntimeProfiles = Object.hasOwn(setup, "statusRuntimeProfiles")
    ? canonical(parseSessionTroopStatusRuntimeProfiles(canonical(setup.statusRuntimeProfiles)))
    : undefined;
  if (statusRuntimeProfiles !== undefined &&
      statusRuntimeProfiles !== canonical(setup.statusRuntimeProfiles)) {
    throw new TypeError("session troop status runtime profiles diverge from their canonical setup");
  }
  const projectileRuntimeProfiles = Object.hasOwn(setup, "projectileRuntimeProfiles")
    ? setup.projectileRuntimeProfiles : undefined;
  if (projectileRuntimeProfiles !== undefined &&
      (typeof projectileRuntimeProfiles !== "string" || projectileRuntimePlan === undefined ||
       projectileRuntimePlan !== projectileRuntimeProfiles)) {
    throw new TypeError("session troop projectile runtime profiles require the admitted host plan");
  }
  assertSessionTroopStatusSourceRoster(
    battleSetupValue.roster, statusRuntimeProfiles, battleSetupValue.questions,
  );
  const battle = legacyStructureReceipts && allowLegacyStructureReceipts
    ? createLegacyLiveBattleForRestore(battleSetupValue, troopRuntimeProfiles, statusRuntimeProfiles,
      projectileRuntimePlan)
    : new LiveBattle(setup.battleSetup, troopRuntimeProfiles, statusRuntimeProfiles,
      projectileRuntimePlan);
  if (setup.rosterWitness !== canonical({ questions: battleSetupValue.questions,
    roster: battleSetupValue.roster })) throw new TypeError("session roster witness diverges");
  const cards = battleSetupValue.roster.map(({ cost, id }) => ({ cost, id }));
  if (cards.length !== 8 || canonical(setup.deck) !== canonical(cards.map(({ id }) => id))) {
    throw new TypeError("session deck must exactly equal the admitted roster");
  }
  const costs = new Map(cards.map(({ cost, id }) => [id, cost]));
  const cardRuntime = new SessionCardRuntime(canonical(battleSetupValue.roster.map(({ cost, id, kind }) => ({
    cost, id, kind, placementClass: kind === "effect" ? "global_effect" : "ground_entity",
  }))));
  for (const card of battleSetupValue.roster) {
    const admitted = cardRuntime.card(card.id);
    if (admitted.cost !== card.cost || admitted.kind !== card.kind) {
      throw new TypeError("session card admission diverges from battle roster");
    }
  }
  const legal = setup.legalNorthDeployments;
  if (!Array.isArray(legal) || legal.length > 1_024) throw new TypeError("north deployments are invalid");
  legal.forEach((raw, sequence) => {
    const entry = exact(raw, ["cardId", "point"], `north deployment ${sequence}`);
    const admitted = cardRuntime.card(entry.cardId);
    const decision = evaluateDeployment({ destroyedOpposingLaneTowers: [],
      placementClass: admitted.placementClass, point: entry.point, side: "north" });
    if (!decision.legal) throw new RangeError(`north deployment is illegal: ${decision.reason}`);
    if (admitted.kind === "unit") battle.scheduleDeploy(canonical({ cardId: entry.cardId,
      point: entry.point, sequence, side: "north", tick: 0 }));
  });
  return { batchBattleAdvance: !battleSetupValue.roster.some(({ kind }) => kind === "structure"),
    battleSetupValue: legacyStructureReceipts ? freeze(clone(battleSetupValue)) : null,
    cardRuntime, cards, costs, legacyStructureReceipts, setup: freeze(clone(setup)),
    projectileRuntimePlan, projectileRuntimeProfiles, statusRuntimeProfiles, troopRuntimeProfiles };
}
function issuePrevalidatedGameSessionSetup(setup, batchBattleAdvance) {
  const snapshotPrefix = `{\"setup\":${canonical(setup)},\"transcript\":[`;
  const token = Object.freeze(Object.create(null));
  assertOpaqueContinuationHandle(token);
  prevalidatedGameSessionSetups.set(token, Object.freeze({
    batchBattleAdvance,
    setup,
    snapshotPrefix,
    snapshotPrefixBytes: scalarByteLength(snapshotPrefix, "game session snapshot"),
  }));
  return token;
}
function initialMatchTowers(battle) {
  const order = ["north:central", "north:lane:left", "north:lane:right",
    "south:central", "south:lane:left", "south:lane:right"];
  return battle.state.towers.map(({ hitpoints, id }) => ({ hitpoints,
    id: mapBattleTowerIdToMatchTowerId(id) })).sort((left, right) =>
    order.indexOf(left.id) - order.indexOf(right.id));
}
function commandText(value) {
  const decoded = parsed(value, "player session command", 16_384, COMMAND_GRAPH_LIMITS);
  if (decoded.type === "ability" || decoded.type === "status") {
    const command = exact(decoded, ABILITY_COMMAND_KEYS, "player session ability command");
    if (!["ability", "status"].includes(command.type) ||
        typeof command.actionId !== "string" || command.actionId.length === 0 ||
        !Number.isSafeInteger(command.commandId) || command.commandId < 0 ||
        !["north", "south"].includes(command.side) ||
        !Number.isSafeInteger(command.sourceId) || command.sourceId < 1 ||
        !(command.targetId === null || (Number.isSafeInteger(command.targetId) && command.targetId >= 1)) ||
        !Number.isSafeInteger(command.tick) || command.tick < 0 || command.tick >= MATCH_MAX_TICKS) {
      throw new TypeError("player session ability command is invalid");
    }
    if (command.point !== null) {
      exact(command.point, ["x", "y"], "player session ability command.point");
      if (!Number.isSafeInteger(command.point.x) || !Number.isSafeInteger(command.point.y)) {
        throw new TypeError("player session ability point is invalid");
      }
    }
    return clone(command);
  }
  if (decoded.type === "spell") {
    const hasTarget = Object.hasOwn(decoded, "target");
    const command = exact(decoded, hasTarget
      ? ["cardId", "commandId", "point", "side", "slot", "target", "tick", "type"]
      : ["cardId", "commandId", "point", "side", "slot", "tick", "type"],
      "player session spell command");
    if (typeof command.cardId !== "string" || !Number.isSafeInteger(command.commandId) ||
        command.commandId < 0 || command.side !== "south" || !Number.isSafeInteger(command.slot) ||
        command.slot < 0 || command.slot > 3 || !Number.isSafeInteger(command.tick) ||
        command.tick < 0 || command.tick >= MATCH_MAX_TICKS) {
      throw new TypeError("player session spell command is invalid");
    }
    exact(command.point, ["x", "y"], "player session spell command.point");
    if (!Number.isSafeInteger(command.point.x) || !Number.isSafeInteger(command.point.y)) {
      throw new TypeError("player session spell command point is invalid");
    }
    if (hasTarget) {
      const target = exact(command.target, ["id", "kind"], "player session spell command.target");
      if (target.kind !== "unit" || !Number.isSafeInteger(target.id) || target.id < 1) {
        throw new TypeError("player session spell command target is invalid");
      }
    }
    return clone(command);
  }
  if (decoded.type !== "deploy") throw new TypeError("player session command type is invalid");
  const hasDestination = Object.hasOwn(decoded, "destination");
  const command = exact(decoded, hasDestination
    ? ["cardId", "commandId", "destination", "point", "slot", "tick", "type"]
    : ["cardId", "commandId", "point", "slot", "tick", "type"], "player session command");
  if (command.type !== "deploy" || typeof command.cardId !== "string" ||
      !Number.isSafeInteger(command.commandId) || command.commandId < 0 ||
      !Number.isSafeInteger(command.slot) || command.slot < 0 || command.slot > 3 ||
      !Number.isSafeInteger(command.tick) || command.tick < 0 || command.tick >= MATCH_MAX_TICKS) {
    throw new TypeError("player session command is invalid");
  }
  exact(command.point, ["x", "y"], "player session command.point");
  if (!Number.isSafeInteger(command.point.x) || !Number.isSafeInteger(command.point.y)) {
    throw new TypeError("player session command point is invalid");
  }
  if (hasDestination && command.destination !== null) {
    exact(command.destination, ["x", "y"], "player session command.destination");
    if (!Number.isSafeInteger(command.destination.x) || !Number.isSafeInteger(command.destination.y)) {
      throw new TypeError("player session command destination is invalid");
    }
  }
  return clone(command);
}
// Alma: forma exacta de una orden externa del lado norte. Solo "deploy" (tropa/edificio)
// o "spell" (hechizo de radio, sin objetivo); nunca destino subterráneo ni habilidades.
function northCommandText(value) {
  const decoded = parsed(value, "north session command", 16_384, COMMAND_GRAPH_LIMITS);
  const command = exact(decoded, ["cardId", "commandId", "point", "side", "slot", "tick", "type"],
    "north session command");
  if (!["deploy", "spell"].includes(command.type) || command.side !== "north" ||
      typeof command.cardId !== "string" || !Number.isSafeInteger(command.commandId) ||
      command.commandId < 0 || !Number.isSafeInteger(command.slot) || command.slot < 0 ||
      command.slot > 3 || !Number.isSafeInteger(command.tick) || command.tick < 0 ||
      command.tick >= MATCH_MAX_TICKS) {
    throw new TypeError("north session command is invalid");
  }
  exact(command.point, ["x", "y"], "north session command.point");
  if (!Number.isSafeInteger(command.point.x) || !Number.isSafeInteger(command.point.y)) {
    throw new TypeError("north session command point is invalid");
  }
  return clone(command);
}

class GameSession {
  // Alma: órdenes externas del norte pendientes y siguiente commandId norte admisible.
  #northPending = []; #nextNorthCommandId = 0;
  #audioEvents = []; #audioMovementStarted = new Set();
  #battle; #cardRuntime; #clock; #controller; #costs; #decks; #elixir; #events = [];
  #history = []; #historyBytes = []; #historyByteLength = 0; #legal;
  #lastCardPlay = { north: null, south: null };
  #nextDeploymentSequence = 0; #paused = false; #pending = [];
  #processed = new Map(); #projectionSequence = 0; #projectionSource = Object.freeze({}); #setup;
  #setupToken; #snapshotPrefix; #snapshotPrefixBytes; #towerEvidence; #isContinuation = false;
  #legacyStructureReceipts = false;
  #batchBattleAdvance = true;
  #projectileRuntimePlan;

  static {
    getAudioReplay = (value) => {
      if (!authenticGameSessions.has(value)) {
        throw new TypeError("game session audio replay receiver is invalid");
      }
      return freeze(clone(value.#audioEvents));
    };
  }

  constructor(canonicalSetup, restoreCapability = null, projectileRuntimePlan = undefined) {
    const prevalidated = new.target === GameSession
      ? prevalidatedGameSessionSetups.get(canonicalSetup) : undefined;
    if (prevalidated !== undefined) {
      // This branch is reachable only from #runtimeClone() with an opaque
      // lexical token. All mutable authorities are installed independently by
      // that method before the candidate can escape or be observed.
      this.#setup = prevalidated.setup;
      this.#legal = prevalidated.setup.legalNorthDeployments;
      this.#batchBattleAdvance = prevalidated.batchBattleAdvance;
      this.#setupToken = canonicalSetup;
      this.#snapshotPrefix = prevalidated.snapshotPrefix;
      this.#snapshotPrefixBytes = prevalidated.snapshotPrefixBytes;
      authenticGameSessions.add(this);
      return;
    }
    const checked = validateSetup(canonicalSetup, { allowLegacyStructureReceipts:
      restoreCapability === LEGACY_STRUCTURE_RESTORE, projectileRuntimePlan }); this.#setup = checked.setup;
    this.#legacyStructureReceipts = checked.legacyStructureReceipts;
    this.#batchBattleAdvance = checked.batchBattleAdvance;
    this.#projectileRuntimePlan = checked.projectileRuntimePlan;
    this.#cardRuntime = checked.cardRuntime;
    this.#costs = checked.costs; this.#legal = this.#setup.legalNorthDeployments;
    this.#battle = this.#legacyStructureReceipts
      ? createLegacyLiveBattleForRestore(checked.battleSetupValue, checked.troopRuntimeProfiles,
        checked.statusRuntimeProfiles, checked.projectileRuntimePlan)
      : new LiveBattle(this.#setup.battleSetup, checked.troopRuntimeProfiles,
        checked.statusRuntimeProfiles, checked.projectileRuntimePlan);
    this.#elixir = new ElixirMatch({ startingElixir: this.#setup.startingElixir });
    this.#decks = { north: new DeckCycle({ deck: this.#setup.deck, seed: `${this.#setup.seed}:north` }),
      south: new DeckCycle({ deck: this.#setup.deck, seed: `${this.#setup.seed}:south` }) };
    this.#controller = new OpponentController({ seed: this.#setup.seed,
      thinkIntervalTicks: this.#setup.thinkIntervalTicks,
      thinkOffsetTicks: this.#setup.thinkOffsetTicks });
    this.#clock = new MatchClock({ initialTowers: initialMatchTowers(this.#battle) });
    this.#towerEvidence = mapLiveBattleTowerStateToMatchEvidence(this.#battle.state.towers);
    this.#setupToken = issuePrevalidatedGameSessionSetup(this.#setup, this.#batchBattleAdvance);
    const prevalidatedSetup = prevalidatedGameSessionSetups.get(this.#setupToken);
    this.#snapshotPrefix = prevalidatedSetup.snapshotPrefix;
    this.#snapshotPrefixBytes = prevalidatedSetup.snapshotPrefixBytes;
    authenticGameSessions.add(this);
  }

  #battleRuntime() {
    return this.#isContinuation ? resolveLiveBattle(this.#battle) : this.#battle;
  }

  #clockRuntime() {
    return this.#isContinuation ? resolveMatchClock(this.#clock) : this.#clock;
  }

  #controllerRuntime() {
    return this.#isContinuation ? resolveOpponentController(this.#controller) : this.#controller;
  }

  #elixirRuntime() {
    return this.#isContinuation ? resolveElixirMatch(this.#elixir) : this.#elixir;
  }

  // The public transcript is append-only after its fully validated setup.
  // Retaining each exact canonical operation fragment makes the transactional
  // snapshot bound O(new operations), while public serialize() still returns
  // the identical canonical v2 bytes.
  #appendHistory(operation) {
    const bytes = canonical(operation);
    this.#history.push(operation);
    this.#historyBytes.push(bytes);
    this.#historyByteLength += scalarByteLength(bytes, "game session snapshot") +
      (this.#historyBytes.length === 1 ? 0 : 1);
  }

  #assertSnapshotBound() {
    if (this.#snapshotPrefixBytes + this.#historyByteLength +
        GAME_SESSION_SNAPSHOT_SUFFIX_BYTES > GAME_SESSION_MAX_SNAPSHOT_BYTES) {
      throw new RangeError("game session snapshot exceeds its byte bound");
    }
  }

  get state() { const battle = this.#battleRuntime(), clock = this.#clockRuntime();
    const elixir = this.#elixirRuntime(), controller = this.#controllerRuntime(); return freeze({ battle: clone(battle.state),
    cardRuntime: clone(this.#cardRuntime.state), clock: clone(clock.state),
    decks: { north: clone(this.#decks.north.state), south: clone(this.#decks.south.state) },
    elixir: clone(elixir.state), opponent: clone(controller.state),
    paused: this.#paused, pendingPlayerCommands: clone(this.#pending),
    terminal: clock.state.result !== null, tick: clock.tick }); }
  get replay() { return freeze(clone(this.#events)); }
  replayBytes() { return canonical(this.#events); }

  /** Fork this authentic session without replaying its durable transcript. */
  fork() {
    const forked = this.#runtimeClone();
    forked.#projectionSource = Object.freeze({});
    return forked;
  }

  /**
   * One immutable, module-branded read of every authority needed by browser
   * projections. It does not replay, restore, or expose live mutable state.
   */
  projectionSnapshot() {
    if (!Number.isSafeInteger(this.#projectionSequence) ||
        this.#projectionSequence === Number.MAX_SAFE_INTEGER) {
      throw new RangeError("game session projection sequence bound exceeded");
    }
    const battleRuntime = this.#battleRuntime(), clock = this.#clockRuntime();
    const elixir = this.#elixirRuntime(), controller = this.#controllerRuntime();
    const combatEffectFeed = liveBattleCombatEffectFeed(battleRuntime);
    const battle = clone(battleRuntime.state);
    battle.towers = battle.towers.map((tower) => ({
      ...tower,
      maxHitpoints: TOWER_COMBAT_CONFIG[tower.role].hitpoints,
    }));
    const state = { battle, cardRuntime: clone(this.#cardRuntime.state), clock: clone(clock.state),
      decks: { north: clone(this.#decks.north.state), south: clone(this.#decks.south.state) },
      elixir: clone(elixir.state), opponent: clone(controller.state),
      paused: this.#paused, pendingPlayerCommands: clone(this.#pending),
      terminal: clock.state.result !== null, tick: clock.tick };
    const snapshot = freeze({
      combatEffectFeed,
      hudFeedback: { lastCardPlay: clone(this.#lastCardPlay) },
      matchFeedback: {
        events: clone(clock.eventLog),
        replayBytes: clock.replayBytes(),
        snapshot: clock.serialize(),
      },
      replay: clone(this.#events),
      sequence: this.#projectionSequence,
      setup: clone(this.#setup),
      source: this.#projectionSource,
      state,
      version: 1,
    });
    this.#projectionSequence += 1;
    authenticGameSessionProjectionSnapshots.add(snapshot);
    return snapshot;
  }

  submitPlayerCommand(text) {
    const command = commandText(text), before = this.serialize();
    const clock = this.#clockRuntime(), elixir = this.#elixirRuntime();
    if (this.#history.length >= GAME_SESSION_MAX_TRANSCRIPT) {
      throw new RangeError("game session transcript exceeds its operation bound");
    }
    if (this.#paused || clock.state.result !== null || command.tick < clock.tick ||
        this.#processed.has(command.commandId) ||
        this.#pending.some((entry) => entry.commandId === command.commandId || entry.tick === command.tick)) {
      throw new RangeError("player session command is stale, duplicate, terminal, or unknown");
    }
    if (command.type === "ability") {
      if (command.side !== "south" || command.tick !== clock.tick) {
        throw new RangeError("player session ability command must be current and south-owned");
      }
      if (!this.#battleRuntime().allowsLegacyTroopActions) {
        throw new RangeError("current session troop runtime does not admit player actions");
      }
      const inspected = this.#battleRuntime().inspectTroopAction(canonical(command));
      if (inspected.abilityCost !== null) {
        throw new TypeError("player session ability cost is not sourced");
      }
    } else if (command.type === "status") {
      if (command.side !== "south" || command.tick !== clock.tick) {
        throw new RangeError("player session status command must be current and south-owned");
      }
      this.#battleRuntime().inspectTroopStatus(canonical(command));
    } else {
      if (!this.#costs.has(command.cardId)) {
        throw new RangeError("player session deploy card is unknown");
      }
      const battle = this.#battleRuntime();
      const admitted = this.#cardRuntime.card(command.cardId);
      const hasSourcedSpellProfile = battle.hasSpellProfile(command.cardId);
      const hasRadiusSpellProfile = hasSourcedSpellProfile && battle.hasRadiusSpellProfile(command.cardId);
      const effectQuestion = admitted.kind === "effect"
        ? battle.getSpellProfileQuestion(command.cardId)
        : null;
      if (effectQuestion !== null) {
        throw new RangeError(`player session effect ${effectQuestion.cardId} remains an explicit QUESTION (${effectQuestion.id}): ${effectQuestion.reason}`);
      }
      if ((command.type === "spell") !== hasSourcedSpellProfile ||
          (hasSourcedSpellProfile && admitted.kind !== "effect")) {
        throw new RangeError("player session command does not match a sourced spell profile");
      }
      if (hasSourcedSpellProfile && (hasRadiusSpellProfile
        ? Object.hasOwn(command, "target")
        : !Object.hasOwn(command, "target"))) {
        throw new TypeError(hasRadiusSpellProfile
          ? "radius spell command must use its trusted center without a target"
          : "direct-target spell command requires one shared unit target");
      }
      if (hasSourcedSpellProfile && command.tick !== clock.tick) {
        throw new RangeError("player spell command must target the current shared tick");
      }
      const placement = evaluateDeployment({ destroyedOpposingLaneTowers: [],
        placementClass: admitted.placementClass,
        point: command.point, side: "south" });
      if (!placement.legal) throw new RangeError(`player session command is illegal: ${placement.reason}`);
      if (admitted.kind === "structure") {
        const destination = Object.hasOwn(command, "destination") ? command.destination : null;
        if (battle.supportsStructureRuntime(command.cardId)) {
          if (!isSessionBuildingCardId(command.cardId)) {
            throw new RangeError("player session structure has no admitted shared building runtime");
          }
          if ((command.cardId === "burrow-rig") !== (destination !== null)) {
            throw new TypeError("underground travel player command requires exactly one destination");
          }
          if (destination !== null) {
            const destinationPlacement = evaluateDeployment({ destroyedOpposingLaneTowers: [],
              placementClass: admitted.placementClass, point: destination, side: "south" });
            if (!destinationPlacement.legal) {
              throw new RangeError(`player session destination is illegal: ${destinationPlacement.reason}`);
            }
          }
        } else if (destination !== null) {
          throw new TypeError("legacy inert structures have no sourced destination route");
        }
      } else if (Object.hasOwn(command, "destination") && command.destination !== null) {
        throw new TypeError("only underground travel structures accept a destination");
      }
      if (command.tick === clock.tick &&
          (this.#decks.south.state.hand[command.slot] !== command.cardId ||
           this.#costs.get(command.cardId) > elixir.state.sides.south.amount)) {
        throw new RangeError("player session command is divergent or unaffordable");
      }
      if (hasSourcedSpellProfile) {
        battle.validateSpell({ cardId: command.cardId, point: command.point,
          sequence: this.#nextDeploymentSequence, side: command.side,
          ...(Object.hasOwn(command, "target") ? { target: command.target } : {}),
          tick: command.tick });
      }
    }
    this.#pending.push(command); this.#pending.sort((a, b) => a.tick - b.tick || a.commandId - b.commandId);
    this.#appendHistory({ command: clone(command), type: "submit" });
    if (before === this.serialize()) throw new Error("player command admission invariant failed");
    return freeze(clone({ accepted: true, commandId: command.commandId, tick: command.tick,
      type: "player-command-admitted" }));
  }
  /**
   * Alma: un controlador externo juega el lado norte. Solo existe en sesiones sin
   * despliegues del bot integrado (legalNorthDeployments vacío), así que nunca hay un
   * bot sustituto. La orden debe ser del tick actual y el juego sigue siendo el árbitro:
   * mano, coste, colocación y perfil de hechizo se validan aquí y además se ensaya la
   * orden sobre un clon desechable; si algo falla se lanza y la sesión no cambia.
   */
  submitNorthCommand(text) {
    const command = northCommandText(text), before = this.serialize();
    const clock = this.#clockRuntime(), elixir = this.#elixirRuntime();
    if (this.#history.length >= GAME_SESSION_MAX_TRANSCRIPT) {
      throw new RangeError("game session transcript exceeds its operation bound");
    }
    if (this.#legal.length !== 0) {
      throw new RangeError("external north control requires a session without built-in north deployments");
    }
    if (this.#paused || clock.state.result !== null || command.tick !== clock.tick ||
        command.commandId < this.#nextNorthCommandId || this.#northPending.length !== 0) {
      throw new RangeError("north session command is stale, duplicate, terminal, or unknown");
    }
    if (!this.#costs.has(command.cardId) || command.cardId === "burrow-rig") {
      throw new RangeError("north session card is unknown or has no north route");
    }
    const battle = this.#battleRuntime();
    const admitted = this.#cardRuntime.card(command.cardId);
    if (admitted.kind === "effect") {
      const effectQuestion = battle.getSpellProfileQuestion(command.cardId);
      if (effectQuestion !== null || !battle.hasRadiusSpellProfile(command.cardId) ||
          command.type !== "spell") {
        throw new RangeError("north session effect must be a sourced radius spell");
      }
    } else if (command.type !== "deploy") {
      throw new RangeError("north session non-effect card must deploy");
    }
    const placement = evaluateDeployment({ destroyedOpposingLaneTowers: [],
      placementClass: admitted.placementClass, point: command.point, side: "north" });
    if (!placement.legal) throw new RangeError(`north session command is illegal: ${placement.reason}`);
    if (this.#decks.north.state.hand[command.slot] !== command.cardId ||
        this.#costs.get(command.cardId) > elixir.state.sides.north.amount) {
      throw new RangeError("north session command is divergent or unaffordable");
    }
    if (admitted.kind === "effect") {
      battle.validateSpell({ cardId: command.cardId, point: command.point,
        sequence: this.#nextDeploymentSequence, side: "north", tick: command.tick });
    }
    // Ensayo sobre un clon desechable: la orden debe materializarse en el siguiente tick.
    try {
      const probe = this.#runtimeClone();
      probe.#northPending = [clone(command)];
      probe.#advanceMany(1);
    } catch (error) {
      throw new RangeError(`north session command was rejected by the referee: ${error?.message ?? error}`);
    }
    this.#northPending.push(command);
    this.#nextNorthCommandId = command.commandId + 1;
    this.#appendHistory({ command: clone(command), type: "submit-north" });
    if (before === this.serialize()) throw new Error("north command admission invariant failed");
    return freeze(clone({ accepted: true, commandId: command.commandId, tick: command.tick,
      type: "north-command-admitted" }));
  }
  pause() { if (!this.#paused) { if (this.#history.length >= GAME_SESSION_MAX_TRANSCRIPT) {
      throw new RangeError("game session transcript exceeds its operation bound");
    } this.#paused = true; this.#appendHistory({ type: "pause" }); } return this.state; }
  resume() { if (this.#paused) { if (this.#history.length >= GAME_SESSION_MAX_TRANSCRIPT) {
      throw new RangeError("game session transcript exceeds its operation bound");
    } this.#paused = false; this.#appendHistory({ type: "resume" }); } return this.state; }
  restart() { const freshSetup = clone(this.#setup); freshSetup.seed = 0;
    const fresh = new GameSession(canonical(freshSetup), this.#legacyStructureReceipts
      ? LEGACY_STRUCTURE_RESTORE : null, this.#projectileRuntimePlan);
    this.#adopt(fresh); return this.state; }
  step() { return this.stepMany(1); }
  stepMany(count) {
    if (!Number.isSafeInteger(count) || count < 0 || count > GAME_SESSION_MAX_BATCH_TICKS) {
      throw new TypeError("session step count is invalid");
    }
    const clock = this.#clockRuntime();
    if (this.#paused || clock.state.result !== null) return freeze([]);
    if (clock.tick + count > MATCH_MAX_TICKS) throw new RangeError("session step exceeds match bound");
    let candidate = this.#runtimeClone();
    let events = candidate.#advanceMany(count), committedCount = count;
    const discovered = candidate.#clockRuntime().state.result;
    if (discovered !== null) {
      const boundaryResult = discovered.reason === "regulation_crowns" ||
        discovered.reason === "tiebreak_exact_tie" || discovered.reason === "tiebreak_lowest_hp";
      const terminalTick = discovered.endedAtTick + (boundaryResult ? 0 : 1);
      if (terminalTick < candidate.#clockRuntime().tick) {
        committedCount = terminalTick - clock.tick;
        if (committedCount <= 0) throw new Error("session terminal prefix is invalid");
        candidate = this.#runtimeClone();
        events = candidate.#advanceMany(committedCount);
        const rebuilt = candidate.#clockRuntime().state.result;
        if (rebuilt === null || canonical(rebuilt) !== canonical(discovered)) {
          throw new Error("session terminal prefix did not reproduce its result");
        }
      }
    }
    if (this.#history.length + committedCount > GAME_SESSION_MAX_TRANSCRIPT) {
      throw new RangeError("game session transcript exceeds its operation bound");
    }
    for (let index = 0; index < committedCount; index += 1) candidate.#appendHistory({ type: "step" });
    candidate.#assertSnapshotBound(); this.#adopt(candidate); return freeze(clone(events));
  }

  serialize() {
    this.#assertSnapshotBound();
    return `${this.#snapshotPrefix}${this.#historyBytes.join(",")}${GAME_SESSION_SNAPSHOT_SUFFIX}`;
  }
  static restore(serialized, projectileRuntimePlan = undefined) {
    const value = exact(parsed(serialized, "game session snapshot"),
      ["setup", "transcript", "version"], "game session snapshot");
    if (value.version !== 2 || !Array.isArray(value.transcript) ||
        value.transcript.length > GAME_SESSION_MAX_TRANSCRIPT) {
      throw new TypeError("unsupported or oversized game session snapshot");
    }
    // The outer v2 snapshot is the only public path allowed to invoke the
    // module-private legacy setup capability.
    const session = new GameSession(canonical(value.setup), LEGACY_STRUCTURE_RESTORE,
      projectileRuntimePlan);
    for (let index = 0; index < value.transcript.length;) {
      const operation = value.transcript[index];
      if (!operation || typeof operation !== "object" || Array.isArray(operation)) {
        throw new TypeError("game session transcript operation is invalid");
      }
      if (operation.type === "step") {
        exact(operation, ["type"], "game session step operation");
        let count = 1;
        while (index + count < value.transcript.length &&
          canonical(value.transcript[index + count]) === '{"type":"step"}') count += 1;
        if (session.#paused || session.#clockRuntime().state.result !== null) {
          throw new TypeError("game session transcript contains an uncaused step");
        }
        session.stepMany(count); index += count; continue;
      }
      if (operation.type === "submit") {
        exact(operation, ["command", "type"], "game session submit operation");
        session.submitPlayerCommand(canonical(operation.command)); index += 1; continue;
      }
      if (operation.type === "submit-north") {
        // Alma: reproduce una orden externa del norte con la misma validación.
        exact(operation, ["command", "type"], "game session north submit operation");
        session.submitNorthCommand(canonical(operation.command)); index += 1; continue;
      }
      if (operation.type === "pause") {
        exact(operation, ["type"], "game session pause operation");
        if (session.#paused) throw new TypeError("game session transcript contains an uncaused pause");
        session.pause(); index += 1; continue;
      }
      if (operation.type === "resume") {
        exact(operation, ["type"], "game session resume operation");
        if (!session.#paused) throw new TypeError("game session transcript contains an uncaused resume");
        session.resume(); index += 1; continue;
      }
      throw new TypeError("game session transcript operation type is invalid");
    }
    if (session.serialize() !== serialized) {
      throw new TypeError("game session transcript did not reproduce its snapshot");
    }
    return session;
  }

  #advanceMany(count) {
    const battle = this.#battleRuntime(), clock = this.#clockRuntime();
    const elixir = this.#elixirRuntime(), controller = this.#controllerRuntime();
    const firstTick = clock.tick, endTick = firstTick + count;
    // Tower evidence deliberately owns an independent six-record witness. Do
    // not build LiveBattle.state here: that public projection also clones all
    // active units and movement histories although this path consumes towers
    // only. The lexical reader preserves BattleTowerCombat synchronization.
    const batchBattleAdvance = this.#batchBattleAdvance;
    const staged = [], battleEvents = [], resourceEvents = batchBattleAdvance ? null : [],
      towerRecords = clone(liveBattleTowerSnapshot(battle));
    let battleTick = firstTick;
    const flushBattleTo = (tick) => {
      if (tick < battleTick) throw new RangeError("session battle cursor moved backwards");
      if (tick > battleTick) {
        battleEvents.push(...liveBattleAdvanceFromSession(battle, tick - battleTick));
      }
      battleTick = tick;
    };
    // Structures have a live resource/contact reducer whose grants must reach
    // ElixirMatch on their originating boundary. Keep that authoritative
    // cadence intact; unit-only sessions can use the authenticated in-place
    // continuation on this already-isolated GameSession candidate.
    // Card kind and sourced spell admission are setup invariants. Derive the
    // controller's materializable candidate set once instead of revalidating
    // every legal card through SessionCardRuntime on every fixed tick.
    const northLegalDeployments = this.#legal.filter(({ cardId }) => {
      const kind = this.#cardRuntime.card(cardId).kind;
      return cardId !== "burrow-rig" &&
        (kind !== "effect" || battle.hasRadiusSpellProfile(cardId));
    });
    for (let tick = firstTick; tick < endTick; tick += 1) {
      const player = this.#pending.find((entry) => entry.tick === tick) ?? null;
      if (player) {
        if (batchBattleAdvance) flushBattleTo(tick);
        if (player.type === "ability") {
          if (!battle.allowsLegacyTroopActions) {
            throw new RangeError("current session troop runtime does not admit player actions");
          }
          const inspected = battle.inspectTroopAction(canonical(player));
          if (inspected.abilityCost !== null) {
            throw new TypeError("session troop action cost is not sourced");
          }
          battle.scheduleTroopAction(canonical(player));
          staged.push({ actionId: player.actionId, commandId: player.commandId,
            side: player.side, sourceId: player.sourceId, targetId: player.targetId,
            tick: player.tick, type: "troop-action-staged" });
        } else if (player.type === "status") {
          battle.inspectTroopStatus(canonical(player));
          battle.scheduleTroopStatus(canonical(player));
          staged.push({ actionId: player.actionId, commandId: player.commandId,
            side: player.side, sourceId: player.sourceId, targetId: player.targetId,
            tick: player.tick, type: "troop-status-staged" });
        } else {
          staged.push({ ...stageSideDeployment({ battle,
            cardCosts: this.#costs, command: { ...player, side: "south" },
            deck: this.#decks.south, deploymentSequence: this.#nextDeploymentSequence++,
            elixir, sessionCards: this.#cardRuntime }) });
        }
      }
      const hand = this.#decks.north.state.hand;
      // The deterministic opponent proposal has no sourced destination field;
      // underground travel remains player-only until one exists.
      const observation = { legalNorthDeployments: northLegalDeployments.filter(({ cardId }) =>
        hand.includes(cardId)),
        northCardCosts: hand.map((cardId) => ({ cardId, cost: this.#costs.get(cardId) }))
          .sort((a, b) => a.cardId < b.cardId ? -1 : 1),
        northElixir: elixir.state.sides.north.amount, northHand: hand, tick };
      const proposal = controller.step(observation)[0] ?? null;
      if (proposal) {
        if (batchBattleAdvance) flushBattleTo(tick);
        staged.push({ ...stageSideDeployment({ battle,
          cardCosts: this.#costs, command: { ...proposal,
            commandId: proposal.sequence, slot: hand.indexOf(proposal.cardId) },
          deck: this.#decks.north, deploymentSequence: this.#nextDeploymentSequence++,
          elixir, sessionCards: this.#cardRuntime }) });
      }
      // Alma: la orden externa del norte (si hay una para este tick) entra por la misma
      // ruta de despliegue que el bot integrado; aquí solo se escenifica.
      const external = this.#northPending.find((entry) => entry.tick === tick) ?? null;
      if (external) {
        if (batchBattleAdvance) flushBattleTo(tick);
        staged.push({ ...stageSideDeployment({ battle,
          cardCosts: this.#costs, command: { cardId: external.cardId,
            commandId: external.commandId, point: external.point, side: "north",
            slot: external.slot, tick: external.tick },
          deck: this.#decks.north, deploymentSequence: this.#nextDeploymentSequence++,
          elixir, sessionCards: this.#cardRuntime }) });
      }
      let elixirEvents;
      if (batchBattleAdvance) {
        elixirEvents = elixir.step();
      } else {
        const tickBattleEvents = battle.step(tick);
        battleEvents.push(...tickBattleEvents);
        const grants = tickBattleEvents.filter(({ type }) => type === "building-resource-grant")
          .map(({ amount, side, sourceId }) => ({ amount, side, sourceId }));
        elixirEvents = elixir.step({ grants });
      }
      if (!batchBattleAdvance) {
        for (const grant of elixirEvents.filter(({ sourceId, type }) =>
          type === "grant" && sourceId !== null)) {
          resourceEvents.push({ amountAfter: grant.amountAfter, amountGranted: grant.amountGranted,
            amountRequested: grant.amountRequested, buildingId: grant.sourceId, side: grant.side,
            tick: grant.tick, type: "building-resource-granted" });
        }
      }
      for (const stage of staged.filter((entry) => entry.tick === tick)) {
        if (stage.type === "troop-action-staged" || stage.type === "troop-status-staged") continue;
        const spend = elixirEvents.find((event) => event.type === "spend" &&
          event.sequence === stage.spendSequence);
        if (!spend?.accepted) throw new RangeError("session deployment spend failed");
        stage.resolvedSpend = spend;
      }
    }
    if (batchBattleAdvance) flushBattleTo(endTick);
    // Alma: las órdenes norte de ticks ya avanzados quedaron escenificadas.
    this.#northPending = this.#northPending.filter(({ tick }) => tick >= endTick);
    const sessionEvents = [];
    for (const stage of staged) {
      let committed = stage.route;
      if (stage.type === "troop-action-staged") {
        const receipt = battleEvents.find((event) => event.type === "troop-runtime-receipt" &&
          event.kind === "action" && event.side === stage.side &&
          event.commandId === stage.commandId && event.actionId === stage.actionId &&
          event.sourceId === stage.sourceId && event.targetId === stage.targetId &&
          event.tick === stage.tick);
        if (!receipt) throw new Error("session troop action did not receive a host receipt");
        committed = { ability: clone(receipt), side: stage.side, tick: stage.tick,
          type: "session-ability" };
        sessionEvents.push(committed);
      } else if (stage.type === "troop-status-staged") {
        const receipt = battleEvents.find((event) => event.type === "troop-status-receipt" &&
          event.side === stage.side && event.commandId === stage.commandId &&
          event.actionId === stage.actionId && event.sourceId === stage.sourceId &&
          event.targetId === stage.targetId && event.tick === stage.tick);
        if (!receipt) throw new Error("session troop status did not receive a host receipt");
        committed = { status: clone(receipt), side: stage.side, tick: stage.tick,
          type: "session-status" };
        sessionEvents.push(committed);
      } else if (stage.kind === "unit") {
        const deployment = battleEvents.find((event) => event.type === "deployed" &&
          event.sequence === stage.deploymentSequence);
        if (!deployment) throw new Error("session deployment did not materialize");
        committed = { deployment: clone(deployment), side: stage.side,
          spend: clone(stage.resolvedSpend), tick: stage.tick, type: "session-deployed" };
        sessionEvents.push(committed);
      } else if (stage.spellIntent !== undefined) {
        const resolution = battleEvents.find((event) => event.type === "spell-intent-resolved" &&
          event.effectId === stage.spellIntent.effectId);
        if (!resolution && !battle.hasRadiusSpellProfile(stage.cardId)) {
          throw new Error("session direct-target spell intent did not resolve exactly once");
        }
        committed = { intent: clone(stage.spellIntent),
          resolution: resolution === undefined ? null : clone(resolution), side: stage.side,
          spend: clone(stage.resolvedSpend), tick: stage.tick, type: "session-spell-played" };
        sessionEvents.push(committed);
      } else if (stage.kind === "structure" && stage.structureMaterializes) {
        const materialization = battleEvents.find((event) => event.type === "structure-materialized" &&
          event.sequence === stage.deploymentSequence);
        if (!materialization) throw new Error("session structure deployment did not materialize");
        committed = { materialization: clone(materialization), route: clone(stage.route), side: stage.side,
          spend: clone(stage.resolvedSpend), tick: stage.tick, type: "session-structure-deployed" };
        sessionEvents.push(committed);
      }
      if (stage.type === "side-deployment-staged") {
        this.#lastCardPlay[stage.side] = {
          cardId: stage.cardId,
          cost: stage.cost,
          slot: stage.cycle.slot,
          tick: stage.tick,
        };
      }
      if (stage.side === "south") { this.#processed.set(stage.commandId, clone(committed));
        this.#pending = this.#pending.filter(({ commandId }) => commandId !== stage.commandId); }
    }
    const contactsByTick = new Map();
    for (const event of battleEvents) if (event.type === "external-structure-contact") {
      if (!contactsByTick.has(event.tick)) contactsByTick.set(event.tick, []);
      contactsByTick.get(event.tick).push(event);
    }
    for (const [tick, contacts] of [...contactsByTick].sort((a, b) => a[0] - b[0])) {
      for (const contact of contacts) {
        const tower = towerRecords.find(({ id }) => id === contact.structureId);
        if (tower) tower.hitpoints = Math.max(0, tower.hitpoints - contact.damage);
      }
      const evidence = mapLiveBattleTowerStateToMatchEvidence(towerRecords);
      clock.scheduleTowerEvidence(tick, evidence); this.#towerEvidence = evidence;
    }
    const finalEvidence = mapLiveBattleTowerStateToMatchEvidence(liveBattleTowerSnapshot(battle));
    if (canonical(finalEvidence) !== canonical(this.#towerEvidence)) {
      throw new Error("session tower evidence did not reproduce the authoritative battle");
    }
    const clockEvents = clock.advanceTicks(count);
    // Publish the already-authoritative audible combat boundary in its original
    // LiveBattle order. This is projection only: stepping and authority remain
    // owned by LiveBattle above.
    const meaningfulBattle = battleEvents.filter(({ type }) => [
      "attack",
      "damage",
      "death",
      "heal",
      "external-structure-contact",
      "projectile-impact",
      "projectile-launch",
      "projectile-runtime-question",
      "projectile-runtime-receipt",
      "chain-primary-settled",
      "chain-hop-settled",
      "tower-destroyed",
      "troop-status-receipt",
      "troop-status-expired",
      "troop-status-cancelled",
    ].includes(type) || /^(building|structure|death-effect|travel|underground|ramp)-/u.test(type));
    sessionEvents.push(...meaningfulBattle,
      ...battleEvents.filter(({ profileId, type }) =>
        (profileId === "squall-orb-radius-v2" &&
          ["spell-area-hit", "spell-intent-resolved"].includes(type))),
      ...(resourceEvents ?? []), ...clockEvents);
    sessionEvents.sort((a, b) => (a.tick ?? 0) - (b.tick ?? 0));
    const movementStarts = [];
    for (const wrapper of battleEvents) {
      if (wrapper.type !== "movement" || wrapper.event?.kind !== "moved" ||
          this.#audioMovementStarted.has(wrapper.unitId)) continue;
      this.#audioMovementStarted.add(wrapper.unitId);
      movementStarts.push({
        entityId: wrapper.unitId,
        tick: wrapper.tick,
        type: "locomotion-start",
      });
    }
    const audioEvents = [...sessionEvents.filter(({ type }) =>
      !["chain-primary-settled", "chain-hop-settled"].includes(type)), ...movementStarts];
    audioEvents.sort((a, b) => (a.tick ?? 0) - (b.tick ?? 0));
    this.#audioEvents.push(...clone(audioEvents));
    this.#events.push(...clone(sessionEvents));
    return sessionEvents;
  }
  #runtimeClone() {
    const value = new GameSession(this.#setupToken);
    const battle = this.#battleRuntime(), clock = this.#clockRuntime();
    const controller = this.#controllerRuntime(), elixir = this.#elixirRuntime();
    value.#battle = compactLiveBattle(battle);
    value.#cardRuntime = this.#cardRuntime.fork();
    value.#clock = compactMatchClock(clock);
    value.#controller = compactOpponentController(controller);
    value.#costs = new Map(this.#costs);
    value.#decks = { north: DeckCycle.restore(this.#decks.north.serializeJson()),
      south: DeckCycle.restore(this.#decks.south.serializeJson()) };
    value.#elixir = compactElixirMatch(elixir);
    value.#isContinuation = true;
    value.#audioEvents = [...this.#audioEvents];
    value.#audioMovementStarted = new Set(this.#audioMovementStarted);
    value.#events = [...this.#events]; value.#history = [...this.#history];
    value.#historyBytes = [...this.#historyBytes]; value.#historyByteLength = this.#historyByteLength;
    value.#lastCardPlay = clone(this.#lastCardPlay);
    value.#nextDeploymentSequence = this.#nextDeploymentSequence;
    value.#projectionSequence = this.#projectionSequence;
    value.#projectionSource = this.#projectionSource;
    value.#paused = this.#paused; value.#pending = clone(this.#pending);
    value.#northPending = clone(this.#northPending); value.#nextNorthCommandId = this.#nextNorthCommandId;
    value.#processed = new Map([...this.#processed.entries()].map(([key, entry]) => [key, clone(entry)]));
    value.#setupToken = this.#setupToken;
    value.#snapshotPrefix = this.#snapshotPrefix;
    value.#snapshotPrefixBytes = this.#snapshotPrefixBytes;
    value.#legacyStructureReceipts = this.#legacyStructureReceipts;
    value.#batchBattleAdvance = this.#batchBattleAdvance;
    // Every committed source session has already compared this frozen evidence
    // with its authoritative live battle at the preceding boundary. A clone
    // owns an independent copy; rebuilding it through LiveBattle.state would
    // clone all live units just to read six tower records.
    value.#towerEvidence = clone(this.#towerEvidence);
    value.#projectileRuntimePlan = this.#projectileRuntimePlan;
    return value;
  }
  #adopt(other) { this.#battle = other.#battle; this.#cardRuntime = other.#cardRuntime;
    this.#clock = other.#clock;
    this.#controller = other.#controller; this.#costs = other.#costs; this.#decks = other.#decks;
    this.#elixir = other.#elixir;
    this.#audioEvents = other.#audioEvents;
    this.#audioMovementStarted = other.#audioMovementStarted;
    this.#events = other.#events; this.#history = other.#history;
    this.#historyBytes = other.#historyBytes; this.#historyByteLength = other.#historyByteLength;
    this.#lastCardPlay = other.#lastCardPlay;
    this.#legal = other.#legal; this.#nextDeploymentSequence = other.#nextDeploymentSequence;
    this.#projectionSequence = other.#projectionSequence;
    this.#projectionSource = other.#projectionSource;
    this.#paused = other.#paused; this.#pending = other.#pending; this.#processed = other.#processed;
    this.#northPending = other.#northPending; this.#nextNorthCommandId = other.#nextNorthCommandId;
    this.#setup = other.#setup; this.#setupToken = other.#setupToken;
    this.#snapshotPrefix = other.#snapshotPrefix;
    this.#snapshotPrefixBytes = other.#snapshotPrefixBytes;
    this.#towerEvidence = other.#towerEvidence;
    this.#projectileRuntimePlan = other.#projectileRuntimePlan;
    this.#legacyStructureReceipts = other.#legacyStructureReceipts;
    this.#batchBattleAdvance = other.#batchBattleAdvance;
    this.#isContinuation = other.#isContinuation; }
}
  return {
    GAME_SESSION_MAX_BATCH_TICKS,
    GAME_SESSION_MAX_SETUP_BYTES,
    GAME_SESSION_MAX_SNAPSHOT_BYTES,
    GAME_SESSION_MAX_TRANSCRIPT,
    GAME_SESSION_SETUP_GRAPH_LIMITS,
    GAME_SESSION_SNAPSHOT_GRAPH_LIMITS,
    GameSession,
    getAudioReplay,
    isAuthenticGameSession,
    isAuthenticGameSessionProjectionSnapshot,
  };
}

let compactElixirMatch, resolveElixirMatch, compactMatchClock, resolveMatchClock,
  compactOpponentController, resolveOpponentController;
const elixir = defineElixir((clone, resolve) => {
  compactElixirMatch = clone; resolveElixirMatch = resolve;
});
const match = defineMatch((clone, resolve) => {
  compactMatchClock = clone; resolveMatchClock = resolve;
});
const opponent = defineOpponentController((clone, resolve) => {
  compactOpponentController = clone; resolveOpponentController = resolve;
});
const stageSideDeployment = createStageSideDeployment({
  DeckCycle,
  ElixirMatch: elixir.ElixirMatch,
  LiveBattle: liveBattle.LiveBattle,
  SessionCardRuntime,
  evaluateDeployment,
  isAuthenticSessionCardRuntime,
});
const gameSession = defineGameSession(elixir.ElixirMatch, liveBattle.LiveBattle,
  match.MATCH_MAX_TICKS, match.MatchClock, opponent.OpponentController,
  towers.TOWER_COMBAT_CONFIG, compactElixirMatch, compactLiveBattle,
  compactMatchClock, compactOpponentController, resolveElixirMatch, resolveLiveBattle,
  resolveMatchClock, resolveOpponentController, liveBattle.createLegacyLiveBattleForRestore,
  liveBattleCombatEffectFeed);

export const ELIXIR_TICKS_PER_SECOND = elixir.ELIXIR_TICKS_PER_SECOND;
export const ELIXIR_ACCUMULATOR_DENOMINATOR = elixir.ELIXIR_ACCUMULATOR_DENOMINATOR;
export const ELIXIR_CAPACITY = elixir.ELIXIR_CAPACITY;
export const ESTIMATED_STARTING_ELIXIR = elixir.ESTIMATED_STARTING_ELIXIR;
export const ELIXIR_MATCH_TICKS = elixir.ELIXIR_MATCH_TICKS;
export const ELIXIR_MAX_PENDING_SPENDS = elixir.ELIXIR_MAX_PENDING_SPENDS;
export const ELIXIR_MAX_HISTORY_ENTRIES = elixir.ELIXIR_MAX_HISTORY_ENTRIES;
export const ELIXIR_MAX_GENERATED_EVENTS = elixir.ELIXIR_MAX_GENERATED_EVENTS;
export const ELIXIR_MAX_EVENT_ENTRIES = elixir.ELIXIR_MAX_EVENT_ENTRIES;
export const getElixirPhase = elixir.getElixirPhase;
export const getElixirRules = elixir.getElixirRules;
export const ElixirMatch = elixir.ElixirMatch;

export const MATCH_TICKS_PER_SECOND = match.MATCH_TICKS_PER_SECOND;
export const MATCH_REGULATION_TICKS = match.MATCH_REGULATION_TICKS;
export const MATCH_TRIPLE_ELIXIR_TICK = match.MATCH_TRIPLE_ELIXIR_TICK;
export const MATCH_MAX_TICKS = match.MATCH_MAX_TICKS;
export const MATCH_MAX_EVIDENCE_COMMANDS = match.MATCH_MAX_EVIDENCE_COMMANDS;
export const getMatchPhase = match.getMatchPhase;
export const getMatchRules = match.getMatchRules;
export const MatchClock = match.MatchClock;

export const OPPONENT_CONTROLLER_ALGORITHM = opponent.OPPONENT_CONTROLLER_ALGORITHM;
export const OPPONENT_CONTROLLER_MAX_BATCH_TICKS = opponent.OPPONENT_CONTROLLER_MAX_BATCH_TICKS;
export const OPPONENT_CONTROLLER_MAX_CANDIDATES = opponent.OPPONENT_CONTROLLER_MAX_CANDIDATES;
export const OPPONENT_CONTROLLER_MAX_DECISIONS = opponent.OPPONENT_CONTROLLER_MAX_DECISIONS;
export const OPPONENT_CONTROLLER_MAX_REPLAY_BYTES = opponent.OPPONENT_CONTROLLER_MAX_REPLAY_BYTES;
export const OPPONENT_CONTROLLER_MAX_TICKS = opponent.OPPONENT_CONTROLLER_MAX_TICKS;
export const OpponentController = opponent.OpponentController;

export const GAME_SESSION_MAX_BATCH_TICKS = gameSession.GAME_SESSION_MAX_BATCH_TICKS;
export const GAME_SESSION_MAX_SETUP_BYTES = gameSession.GAME_SESSION_MAX_SETUP_BYTES;
export const GAME_SESSION_MAX_SNAPSHOT_BYTES = gameSession.GAME_SESSION_MAX_SNAPSHOT_BYTES;
export const GAME_SESSION_MAX_TRANSCRIPT = gameSession.GAME_SESSION_MAX_TRANSCRIPT;
export const GAME_SESSION_SETUP_GRAPH_LIMITS = gameSession.GAME_SESSION_SETUP_GRAPH_LIMITS;
export const GAME_SESSION_SNAPSHOT_GRAPH_LIMITS = gameSession.GAME_SESSION_SNAPSHOT_GRAPH_LIMITS;
export const GameSession = gameSession.GameSession;
export const getGameSessionAudioReplay = gameSession.getAudioReplay;
export const isAuthenticGameSession = gameSession.isAuthenticGameSession;
export const isAuthenticGameSessionProjectionSnapshot = gameSession.isAuthenticGameSessionProjectionSnapshot;
