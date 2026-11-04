import { createCardCatalog } from "../schema.js";

const CARD_DEFINITIONS = [{
  areaDamageRadiusMillitiles: null,
  components: [],
  cost: 3,
  count: 1,
  damage: 96,
  deployTimeTicks: 60,
  displayName: "Veil Prowler",
  firstHitTicks: 4,
  hitSpeedTicks: 6,
  hitpoints: 900,
  id: "veil-prowler",
  kind: "unit",
  movementMillitilesPerSecond: 1000,
  rangeMillitiles: 2000,
  rarity: "uncommon",
  sightRangeMillitiles: 5000,
  targetMode: "ground-and-air",
}];

const SOURCE = "unsourced-invisibility-reveal-reacquisition-fixture";
const FIXTURE = "invisibility-reveal-reacquisition-question-v1";
const MAX_COMMANDS = 96;
const MAX_ENTITIES = 32;
const MAX_EVENTS = 8192;
const MAX_HEALTH = 1_000_000;
const MAX_POSITION = 1_000_000;
const MAX_RADIUS = 100_000;
const MAX_SNAPSHOT_BYTES = 524288;
const MAX_STEP_CHUNK = 4096;
const MAX_TICK = 4096;
const SETUP_KEYS = ["commands", "targets"];
const TARGET_KEYS = [
  "alive", "health", "id", "kind", "layer", "position", "radius",
];
const POSITION_KEYS = ["x", "y"];
const COMMAND_KEYS = ["sourceId", "targetId", "tick", "type"];
const COMMAND_TYPES = new Set([
  "die", "hide", "interrupt", "reveal", "target-died",
]);
const SNAPSHOT_KEYS = ["identity", "state", "version"];
const IDENTITY_KEYS = ["commands", "fixture", "targets"];
const STATE_KEYS = [
  "alive", "attackPhase", "attackRemaining", "attackSequence",
  "commandIndex", "history", "pendingProjectiles", "targetId", "targets",
  "tick",
];
const TARGET_STATE_KEYS = [
  "alive", "health", "hideSources", "id", "kind", "layer", "position",
  "radius", "revealThroughTick", "visible",
];
const HIDE_SOURCE_KEYS = ["hiddenThroughTick", "sourceId"];
const PROJECTILE_KEYS = ["contactTick", "sequence", "targetId"];
const KINDS = new Set(["structure", "troop"]);
const LAYERS = new Set(["air", "ground"]);
const PHASES = new Set(["cadence", "dead", "idle", "tracking", "windup"]);

const QUESTION_VALUES = {
  attackCadenceTicks: 6,
  attackRangeBoundary: "inclusive-edge-to-edge-millitile-distance",
  attackRangeMillitiles: 2000,
  attackReadyOrdering: "command-first-visibility-then-contact-then-launch",
  commonAreaDamageRadiusMillitiles: null,
  commonCount: 1,
  commonDamage: 96,
  commonDeployTimeTicks: 60,
  commonFirstHitTicks: 4,
  commonHitSpeedTicks: 6,
  commonHitpoints: 900,
  commonMovementMillitilesPerSecond: 1000,
  commonRangeMillitiles: 2000,
  commonSightRangeMillitiles: 5000,
  commonTargetMode: "ground-and-air",
  contactBoundary: "contact-applies-after-command-and-visibility-resolution",
  deathPolicy: "attacker-death-clears-target-windup-and-in-flight-projectiles",
  eligibilityPolicy:
    "living-visible-ground-or-air-troops-and-structures-are-eligible",
  hideApplyBoundary: "hide-command-is-effective-on-its-integer-boundary",
  hideDurationTicks: 12,
  hideExpiryBoundary:
    "source-hide-is-inclusive-through-apply-plus-duration-minus-one",
  hideSourcePolicy: "independent-source-expiries-union-to-hidden",
  inFlightHiddenTargetPolicy:
    "launched-projectile-retains-stable-target-and-hits-while-hidden",
  interruptionPolicy:
    "attacker-interruption-clears-all-attack-work-and-reacquires-next-boundary",
  projectileContactDelayTicks: 2,
  reacquisitionPolicy:
    "nearest-edge-distance-then-lowest-stable-id-independent-of-input-order",
  reapplyPolicy: "same-source-hide-refreshes-only-to-the-later-expiry",
  rehideBoundary: "rehide-on-first-boundary-after-reveal-window",
  revealApplyBoundary:
    "reveal-command-suppresses-all-active-hide-sources-immediately",
  revealDurationTicks: 4,
  revealExpiryBoundary:
    "reveal-is-inclusive-through-apply-plus-duration-minus-one",
  sightRangeBoundary: "inclusive-edge-to-edge-millitile-distance",
  sightRangeMillitiles: 5000,
  simulationTicksPerSecond: 60,
  sourceEligibility: "positive-safe-integer-source-id",
  targetDeathPolicy:
    "target-death-loses-lock-and-in-flight-projectile-misses-at-contact",
  targetMode: "ground-and-air",
  targetabilityPolicy: "invisibility-removes-targetability-without-moving",
  tiePolicy: "lowest-positive-stable-id",
  windupCancellation: "target-loss-discards-readiness-and-cadence-progress",
  windupRestart: "reacquisition-starts-a-full-four-boundary-windup",
};

function deepFreeze(value) {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
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
    (
      Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null
    )
  ) {
    throw new TypeError(`${label} must be a plain object`);
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
    throw new TypeError(`${label} must contain dense data properties`);
  }
  return Array.from({ length: value.length }, (_, index) =>
    descriptors[index].value);
}

function safeInteger(value, label, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label} must be a bounded safe integer`);
  }
}

function checkedId(value, label, nullable = false) {
  if (nullable && value === null) return;
  safeInteger(value, label, 1);
}

function checkedPosition(value, label) {
  const position = exactRecord(value, POSITION_KEYS, label);
  safeInteger(position.x, `${label}.x`, -MAX_POSITION, MAX_POSITION);
  safeInteger(position.y, `${label}.y`, -MAX_POSITION, MAX_POSITION);
  return { x: position.x, y: position.y };
}

function checkedTargets(value, label = "invisibility targets") {
  const targets = denseArray(value, label, MAX_ENTITIES).map((entry, index) => {
    const target = exactRecord(entry, TARGET_KEYS, `${label}[${index}]`);
    checkedId(target.id, `${label}[${index}].id`);
    if (typeof target.alive !== "boolean") {
      throw new TypeError(`${label}[${index}].alive must be a boolean`);
    }
    safeInteger(target.health, `${label}[${index}].health`, 0, MAX_HEALTH);
    if (target.alive !== (target.health > 0)) {
      throw new TypeError(`${label}[${index}] life and health disagree`);
    }
    if (!KINDS.has(target.kind) || !LAYERS.has(target.layer)) {
      throw new TypeError(`${label}[${index}] has an invalid kind or layer`);
    }
    safeInteger(target.radius, `${label}[${index}].radius`, 0, MAX_RADIUS);
    return {
      alive: target.alive,
      health: target.health,
      id: target.id,
      kind: target.kind,
      layer: target.layer,
      position: checkedPosition(target.position, `${label}[${index}].position`),
      radius: target.radius,
    };
  });
  const ids = new Set();
  for (const target of targets) {
    if (ids.has(target.id)) {
      throw new TypeError("invisibility targets must have unique IDs");
    }
    ids.add(target.id);
  }
  return targets.sort((left, right) => left.id - right.id);
}

function checkedCommands(value, targetIds = null) {
  const commands = denseArray(value, "invisibility commands", MAX_COMMANDS)
    .map((entry, index) => {
      const command = exactRecord(
        entry,
        COMMAND_KEYS,
        `invisibility command ${index}`,
      );
      safeInteger(command.tick, `invisibility command ${index}.tick`, 0,
        MAX_TICK - 1);
      if (!COMMAND_TYPES.has(command.type)) {
        throw new TypeError(`invisibility command ${index}.type is invalid`);
      }
      if (["hide", "reveal"].includes(command.type)) {
        checkedId(command.sourceId, `invisibility command ${index}.sourceId`);
        checkedId(command.targetId, `invisibility command ${index}.targetId`);
        if (targetIds !== null && !targetIds.has(command.targetId)) {
          throw new TypeError(`invisibility command ${index} has unknown target`);
        }
        const duration = command.type === "hide"
          ? QUESTION_VALUES.hideDurationTicks
          : QUESTION_VALUES.revealDurationTicks;
        if (command.tick > MAX_TICK - duration) {
          throw new TypeError(
            `invisibility command ${index}.tick cannot fit its duration`,
          );
        }
      } else if (command.type === "target-died") {
        if (command.sourceId !== null) {
          throw new TypeError(
            `invisibility command ${index}.sourceId is inapplicable`,
          );
        }
        checkedId(command.targetId, `invisibility command ${index}.targetId`);
        if (targetIds !== null && !targetIds.has(command.targetId)) {
          throw new TypeError(`invisibility command ${index} has unknown target`);
        }
      } else if (command.sourceId !== null || command.targetId !== null) {
        throw new TypeError(`invisibility command ${index} has inapplicable IDs`);
      }
      return {
        sourceId: command.sourceId,
        targetId: command.targetId,
        tick: command.tick,
        type: command.type,
      };
    });
  let prior = -1;
  for (const command of commands) {
    if (command.tick <= prior) {
      throw new TypeError(
        "invisibility commands must have unique increasing ticks",
      );
    }
    prior = command.tick;
  }
  return commands;
}

function checkedSetup(value) {
  const setup = exactRecord(value, SETUP_KEYS, "invisibility setup");
  const targets = checkedTargets(setup.targets);
  const commands = checkedCommands(
    setup.commands,
    new Set(targets.map(({ id }) => id)),
  );
  return { commands, targets };
}

function initialState(targets) {
  return {
    alive: true,
    attackPhase: "idle",
    attackRemaining: null,
    attackSequence: 0,
    commandIndex: 0,
    history: [],
    pendingProjectiles: [],
    targetId: null,
    targets: targets.map((target) => ({
      ...clone(target),
      hideSources: [],
      revealThroughTick: null,
      visible: target.alive,
    })),
    tick: 0,
  };
}

function edgeDistanceSquared(target) {
  const centerSquared =
    BigInt(target.position.x) * BigInt(target.position.x) +
    BigInt(target.position.y) * BigInt(target.position.y);
  return { centerSquared, inset: target.radius };
}

function withinRange(target, range) {
  const reach = range + target.radius;
  return edgeDistanceSquared(target).centerSquared <= BigInt(reach) * BigInt(reach);
}

function compareDistance(left, right) {
  // Compare sqrt(centerSq) - radius exactly without floating point.
  const l = edgeDistanceSquared(left);
  const r = edgeDistanceSquared(right);
  if (l.inset === r.inset) {
    if (l.centerSquared !== r.centerSquared) {
      return l.centerSquared < r.centerSquared ? -1 : 1;
    }
    return left.id - right.id;
  }
  const delta = BigInt(l.inset - r.inset);
  if (delta > 0n) {
    if (l.centerSquared <= r.centerSquared) return -1;
    const difference =
      l.centerSquared - r.centerSquared - delta * delta;
    if (difference <= 0n) return -1;
    const comparison =
      difference * difference -
      4n * delta * delta * r.centerSquared;
    if (comparison !== 0n) return comparison < 0n ? -1 : 1;
  } else {
    return -compareDistance(right, left);
  }
  return left.id - right.id;
}

function acquireTarget(state) {
  const eligible = state.targets.filter((target) =>
    target.alive && target.visible &&
    withinRange(target, QUESTION_VALUES.sightRangeMillitiles)
  );
  eligible.sort(compareDistance);
  return eligible[0] ?? null;
}

function event(state, events, value) {
  if (state.history.length + events.length >= MAX_EVENTS) {
    throw new RangeError("invisibility replay exceeds its event bound");
  }
  events.push(value);
}

function loseTarget(state, events, reason) {
  if (state.targetId === null) return;
  const targetId = state.targetId;
  state.targetId = null;
  state.attackPhase = "idle";
  state.attackRemaining = null;
  event(state, events, {
    reason,
    targetId,
    tick: state.tick,
    type: "target-lost",
  });
}

function targetById(state, id) {
  return state.targets.find((target) => target.id === id);
}

function applyCommand(state, command, events) {
  if (command.type === "die") {
    if (!state.alive) return;
    state.alive = false;
    loseTarget(state, events, "attacker-died");
    state.attackPhase = "dead";
    state.pendingProjectiles = [];
    event(state, events, { tick: state.tick, type: "died" });
    return;
  }
  if (command.type === "interrupt") {
    if (!state.alive) return;
    loseTarget(state, events, "interrupted");
    state.pendingProjectiles = [];
    event(state, events, { tick: state.tick, type: "interrupted" });
    return;
  }
  const target = targetById(state, command.targetId);
  if (command.type === "target-died") {
    if (!target.alive) return;
    target.alive = false;
    target.health = 0;
    target.visible = false;
    target.hideSources = [];
    target.revealThroughTick = null;
    event(state, events, {
      targetId: target.id,
      tick: state.tick,
      type: "target-died",
    });
    return;
  }
  if (!target.alive) return;
  if (command.type === "hide") {
    const hiddenThroughTick =
      state.tick + QUESTION_VALUES.hideDurationTicks - 1;
    const current = target.hideSources.find(
      ({ sourceId }) => sourceId === command.sourceId,
    );
    if (current === undefined) {
      target.hideSources.push({ hiddenThroughTick, sourceId: command.sourceId });
      target.hideSources.sort((left, right) => left.sourceId - right.sourceId);
    } else {
      current.hiddenThroughTick = Math.max(
        current.hiddenThroughTick,
        hiddenThroughTick,
      );
    }
    event(state, events, {
      hiddenThroughTick:
        target.hideSources.find(({ sourceId }) =>
          sourceId === command.sourceId).hiddenThroughTick,
      sourceId: command.sourceId,
      targetId: target.id,
      tick: state.tick,
      type: "hide-applied",
    });
    return;
  }
  const revealThroughTick =
    state.tick + QUESTION_VALUES.revealDurationTicks - 1;
  target.revealThroughTick = Math.max(
    target.revealThroughTick ?? -1,
    revealThroughTick,
  );
  event(state, events, {
    revealThroughTick: target.revealThroughTick,
    sourceId: command.sourceId,
    targetId: target.id,
    tick: state.tick,
    type: "reveal-applied",
  });
}

function resolveVisibility(state, events) {
  for (const target of state.targets) {
    if (!target.alive) continue;
    target.hideSources = target.hideSources.filter(
      ({ hiddenThroughTick }) => hiddenThroughTick >= state.tick,
    );
    if (
      target.revealThroughTick !== null &&
      target.revealThroughTick < state.tick
    ) {
      target.revealThroughTick = null;
    }
    const visible =
      target.revealThroughTick !== null || target.hideSources.length === 0;
    if (visible !== target.visible) {
      target.visible = visible;
      event(state, events, {
        targetId: target.id,
        tick: state.tick,
        type: visible ? "target-revealed" : "target-hidden",
      });
    }
  }
}

function reconcileTarget(state, events) {
  if (!state.alive) return;
  if (state.targetId !== null) {
    const retained = targetById(state, state.targetId);
    if (
      !retained.alive || !retained.visible ||
      !withinRange(retained, QUESTION_VALUES.sightRangeMillitiles)
    ) {
      loseTarget(state, events, retained.alive ? "ineligible" : "target-dead");
    }
  }
  if (state.targetId === null) {
    const acquired = acquireTarget(state);
    if (acquired !== null) {
      state.targetId = acquired.id;
      state.attackPhase = withinRange(
        acquired,
        QUESTION_VALUES.attackRangeMillitiles,
      ) ? "windup" : "tracking";
      state.attackRemaining = state.attackPhase === "windup"
        ? QUESTION_VALUES.commonFirstHitTicks
        : null;
      event(state, events, {
        targetId: acquired.id,
        tick: state.tick,
        type: "target-acquired",
      });
    }
  }
}

function resolveProjectiles(state, events) {
  const pending = [];
  for (const projectile of state.pendingProjectiles) {
    if (projectile.contactTick !== state.tick) {
      pending.push(projectile);
      continue;
    }
    const target = targetById(state, projectile.targetId);
    if (!target.alive) {
      event(state, events, {
        reason: "target-dead",
        sequence: projectile.sequence,
        targetId: projectile.targetId,
        tick: state.tick,
        type: "projectile-missed",
      });
      continue;
    }
    const healthBefore = target.health;
    target.health = Math.max(0, target.health - QUESTION_VALUES.commonDamage);
    target.alive = target.health > 0;
    if (!target.alive) target.visible = false;
    event(state, events, {
      healthAfter: target.health,
      healthBefore,
      sequence: projectile.sequence,
      targetId: target.id,
      targetVisible: target.visible,
      tick: state.tick,
      type: "projectile-contact",
    });
  }
  state.pendingProjectiles = pending;
}

function resolveAttack(state, events) {
  if (!state.alive || state.targetId === null) return;
  const target = targetById(state, state.targetId);
  const inAttackRange = target.alive && target.visible &&
    withinRange(target, QUESTION_VALUES.attackRangeMillitiles);
  if (!inAttackRange) {
    if (state.attackPhase !== "tracking") {
      state.attackPhase = "tracking";
      state.attackRemaining = null;
    }
    return;
  }
  if (state.attackPhase === "tracking") {
    state.attackPhase = "windup";
    state.attackRemaining = QUESTION_VALUES.commonFirstHitTicks;
  }
  state.attackRemaining -= 1;
  if (state.attackRemaining !== 0) return;
  if (state.attackSequence === MAX_EVENTS) {
    throw new RangeError("invisibility attack sequence exceeds its bound");
  }
  state.attackSequence += 1;
  const contactTick =
    state.tick + QUESTION_VALUES.projectileContactDelayTicks;
  if (contactTick >= MAX_TICK) {
    throw new RangeError("invisibility projectile contact exceeds tick bound");
  }
  state.pendingProjectiles.push({
    contactTick,
    sequence: state.attackSequence,
    targetId: target.id,
  });
  event(state, events, {
    contactTick,
    sequence: state.attackSequence,
    targetId: target.id,
    tick: state.tick,
    type: "projectile-launched",
  });
  state.attackPhase = "cadence";
  state.attackRemaining = QUESTION_VALUES.attackCadenceTicks;
}

function uncheckedAdvance(state, commands) {
  if (state.tick >= MAX_TICK) return [];
  const events = [];
  const command = commands[state.commandIndex];
  let suppressAcquisition = false;
  if (command?.tick === state.tick) {
    state.commandIndex += 1;
    applyCommand(state, command, events);
    suppressAcquisition = ["die", "interrupt"].includes(command.type);
  }
  resolveVisibility(state, events);
  if (!suppressAcquisition) reconcileTarget(state, events);
  if (state.alive) resolveProjectiles(state, events);
  resolveAttack(state, events);
  state.history.push(...clone(events));
  state.tick += 1;
  return events;
}

function checkedHideSources(value, label) {
  const sources = denseArray(value, label, MAX_COMMANDS).map((entry, index) => {
    const source = exactRecord(entry, HIDE_SOURCE_KEYS, `${label}[${index}]`);
    checkedId(source.sourceId, `${label}[${index}].sourceId`);
    safeInteger(source.hiddenThroughTick,
      `${label}[${index}].hiddenThroughTick`, 0, MAX_TICK - 1);
    return source;
  });
  let prior = 0;
  for (const source of sources) {
    if (source.sourceId <= prior) throw new TypeError(`${label} is not ordered`);
    prior = source.sourceId;
  }
  return sources;
}

function checkedStateShape(value, commands, targets, label) {
  const state = exactRecord(value, STATE_KEYS, label);
  if (typeof state.alive !== "boolean") {
    throw new TypeError(`${label}.alive must be a boolean`);
  }
  safeInteger(state.tick, `${label}.tick`, 0, MAX_TICK);
  safeInteger(state.commandIndex, `${label}.commandIndex`, 0, commands.length);
  safeInteger(state.attackSequence, `${label}.attackSequence`, 0, MAX_EVENTS);
  checkedId(state.targetId, `${label}.targetId`, true);
  if (!PHASES.has(state.attackPhase)) {
    throw new TypeError(`${label}.attackPhase is invalid`);
  }
  if (state.attackRemaining !== null) {
    safeInteger(state.attackRemaining, `${label}.attackRemaining`, 1,
      QUESTION_VALUES.attackCadenceTicks);
  }
  const checkedTargetStates = denseArray(
    state.targets,
    `${label}.targets`,
    MAX_ENTITIES,
  ).map((entry, index) => {
    const target = exactRecord(
      entry,
      TARGET_STATE_KEYS,
      `${label}.targets[${index}]`,
    );
    const base = checkedTargets([{
      alive: target.alive,
      health: target.health,
      id: target.id,
      kind: target.kind,
      layer: target.layer,
      position: target.position,
      radius: target.radius,
    }], `${label}.target-base`)[0];
    if (typeof target.visible !== "boolean") {
      throw new TypeError(`${label}.targets[${index}].visible must be boolean`);
    }
    if (target.revealThroughTick !== null) {
      safeInteger(target.revealThroughTick,
        `${label}.targets[${index}].revealThroughTick`, 0, MAX_TICK - 1);
    }
    return {
      ...base,
      hideSources: checkedHideSources(
        target.hideSources,
        `${label}.targets[${index}].hideSources`,
      ),
      revealThroughTick: target.revealThroughTick,
      visible: target.visible,
    };
  });
  const pendingProjectiles = denseArray(
    state.pendingProjectiles,
    `${label}.pendingProjectiles`,
    MAX_EVENTS,
  ).map((entry, index) => {
    const projectile = exactRecord(
      entry,
      PROJECTILE_KEYS,
      `${label}.pendingProjectiles[${index}]`,
    );
    safeInteger(projectile.contactTick,
      `${label}.pendingProjectiles[${index}].contactTick`, state.tick,
      MAX_TICK - 1);
    safeInteger(projectile.sequence,
      `${label}.pendingProjectiles[${index}].sequence`, 1, MAX_EVENTS);
    checkedId(projectile.targetId,
      `${label}.pendingProjectiles[${index}].targetId`);
    return projectile;
  });
  const history = denseArray(state.history, `${label}.history`, MAX_EVENTS);
  for (let index = 0; index < history.length; index += 1) {
    if (
      history[index] === null || typeof history[index] !== "object" ||
      Array.isArray(history[index])
    ) {
      throw new TypeError(`${label}.history[${index}] must be an event object`);
    }
    const tick = Object.getOwnPropertyDescriptor(history[index], "tick");
    const type = Object.getOwnPropertyDescriptor(history[index], "type");
    if (
      !tick?.enumerable || !Object.hasOwn(tick, "value") ||
      !type?.enumerable || !Object.hasOwn(type, "value") ||
      typeof type.value !== "string"
    ) {
      throw new TypeError(`${label}.history[${index}] has invalid event data`);
    }
    safeInteger(tick.value, `${label}.history[${index}].tick`, 0,
      Math.max(0, state.tick - 1));
  }
  if (checkedTargetStates.length !== targets.length) {
    throw new TypeError(`${label}.targets changed identity cardinality`);
  }
  return {
    alive: state.alive,
    attackPhase: state.attackPhase,
    attackRemaining: state.attackRemaining,
    attackSequence: state.attackSequence,
    commandIndex: state.commandIndex,
    history: clone(history),
    pendingProjectiles,
    targetId: state.targetId,
    targets: checkedTargetStates,
    tick: state.tick,
  };
}

function replayState(commands, targets, ticks) {
  const state = initialState(targets);
  for (let index = 0; index < ticks; index += 1) {
    uncheckedAdvance(state, commands);
  }
  return state;
}

function checkedCausalState(value, commands, targets, label = "invisibility state") {
  const checked = checkedStateShape(value, commands, targets, label);
  const expected = replayState(commands, targets, checked.tick);
  if (canonicalJson(checked) !== canonicalJson(expected)) {
    throw new TypeError(`${label} is forged or noncausal`);
  }
  return checked;
}

function questionRecord(key, value, source = SOURCE) {
  return deepFreeze({
    authoritative: false,
    confidence: "unverified",
    disposition: "question",
    key,
    source,
    value: clone(value),
  });
}

export function createInvisibilityMappedFieldQuestionRecords(fixtures) {
  const checkedFixtures = denseArray(
    fixtures,
    "invisibility mapped benchmark fixtures",
    MAX_ENTITIES,
  );
  const records = [];
  const fixtureIdentities = new Set();
  for (let fixtureIndex = 0;
    fixtureIndex < checkedFixtures.length;
    fixtureIndex += 1) {
    const fixture = exactRecord(
      checkedFixtures[fixtureIndex],
      ["fixtureIdentity", "unverifiedFields"],
      `invisibility mapped benchmark fixture ${fixtureIndex}`,
    );
    if (
      typeof fixture.fixtureIdentity !== "string" ||
      fixture.fixtureIdentity.length === 0 ||
      fixture.fixtureIdentity.length > 128
    ) {
      throw new TypeError(
        `invisibility mapped benchmark fixture ${fixtureIndex} identity is invalid`,
      );
    }
    if (fixtureIdentities.has(fixture.fixtureIdentity)) {
      throw new TypeError(
        "invisibility mapped benchmark fixtures must have unique identities",
      );
    }
    fixtureIdentities.add(fixture.fixtureIdentity);
    const fields = denseArray(
      fixture.unverifiedFields,
      `invisibility mapped benchmark fixture ${fixtureIndex} fields`,
      MAX_COMMANDS,
    );
    const fieldNames = new Set();
    for (let fieldIndex = 0; fieldIndex < fields.length; fieldIndex += 1) {
      const mappedField = exactRecord(
        fields[fieldIndex],
        ["field", "value"],
        `invisibility mapped benchmark fixture ${fixtureIndex} field ${fieldIndex}`,
      );
      if (
        typeof mappedField.field !== "string" ||
        !/^[a-z][a-z0-9_]*$/u.test(mappedField.field)
      ) {
        throw new TypeError(
          `invisibility mapped benchmark fixture ${fixtureIndex} field name is invalid`,
        );
      }
      if (fieldNames.has(mappedField.field)) {
        throw new TypeError(
          `invisibility mapped benchmark fixture ${fixtureIndex} fields must be unique`,
        );
      }
      fieldNames.add(mappedField.field);
      const key =
        `mappedField:${fixture.fixtureIdentity}:${mappedField.field}`;
      const source =
        `test-only benchmark fixture ${fixture.fixtureIdentity} ` +
        `unverified_fields contains ${mappedField.field}`;
      records.push([key, questionRecord(key, mappedField.value, source)]);
    }
  }
  return deepFreeze(Object.fromEntries(records));
}

export function createInvisibilitySpecialCatalog() {
  return createCardCatalog(CARD_DEFINITIONS);
}

export function createInvisibilityQuestionRecords(...args) {
  if (args.length !== 0) {
    throw new TypeError("invisibility question records do not accept overrides");
  }
  return deepFreeze(Object.fromEntries(
    Object.entries(QUESTION_VALUES).map(([key, value]) =>
      [key, questionRecord(key, value)]),
  ));
}

export function createInvisibilityFixture(targets = [], commands = []) {
  return clone(checkedSetup({ commands, targets }));
}

export class InvisibilityRevealEncounter {
  #commands;
  #state;
  #targets;

  constructor(setup = createInvisibilityFixture()) {
    const checked = checkedSetup(setup);
    this.#commands = checked.commands;
    this.#targets = checked.targets;
    this.#state = initialState(this.#targets);
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
    safeInteger(count, "invisibility step count", 0, MAX_STEP_CHUNK);
    if (count > MAX_TICK - this.#state.tick) {
      throw new RangeError("invisibility step count exceeds the encounter bound");
    }
    const candidate = checkedCausalState(
      this.#state,
      this.#commands,
      this.#targets,
    );
    const events = [];
    for (let index = 0; index < count; index += 1) {
      events.push(...uncheckedAdvance(candidate, this.#commands));
    }
    this.#state = candidate;
    return clone(events);
  }

  run() {
    return this.stepMany(MAX_TICK - this.#state.tick);
  }

  serialize() {
    const serialized = canonicalJson({
      identity: {
        commands: this.#commands,
        fixture: FIXTURE,
        targets: this.#targets,
      },
      state: checkedCausalState(
        this.#state,
        this.#commands,
        this.#targets,
      ),
      version: 1,
    });
    if (new TextEncoder().encode(serialized).byteLength > MAX_SNAPSHOT_BYTES) {
      throw new RangeError("invisibility snapshot exceeds its byte bound");
    }
    return serialized;
  }

  static restore(serialized) {
    if (typeof serialized !== "string") {
      throw new TypeError("invisibility snapshot must be a string");
    }
    if (new TextEncoder().encode(serialized).byteLength > MAX_SNAPSHOT_BYTES) {
      throw new RangeError("invisibility snapshot exceeds its byte bound");
    }
    let value;
    try {
      value = JSON.parse(serialized);
    } catch {
      throw new TypeError("invisibility snapshot must be valid JSON");
    }
    if (serialized !== canonicalJson(value)) {
      throw new TypeError(
        "invisibility snapshot must be canonical duplicate-free JSON",
      );
    }
    const snapshot = exactRecord(value, SNAPSHOT_KEYS, "invisibility snapshot");
    if (snapshot.version !== 1) {
      throw new TypeError("invisibility snapshot version is unsupported");
    }
    const identity = exactRecord(
      snapshot.identity,
      IDENTITY_KEYS,
      "invisibility snapshot.identity",
    );
    if (identity.fixture !== FIXTURE) {
      throw new TypeError("invisibility snapshot fixture identity is invalid");
    }
    const targets = checkedTargets(identity.targets);
    const commands = checkedCommands(
      identity.commands,
      new Set(targets.map(({ id }) => id)),
    );
    const state = checkedCausalState(
      snapshot.state,
      commands,
      targets,
      "invisibility snapshot.state",
    );
    const encounter = new InvisibilityRevealEncounter({ commands, targets });
    encounter.#state = state;
    return encounter;
  }
}
