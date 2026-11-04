import { AttackCycle } from "../../sim/attack-cycle.js";
import {
  advanceMovement,
  createMovementState,
} from "../../sim/movement.js";
import { findGroundPath } from "../../sim/pathfinding.js";
import { retainOrAcquireTarget } from "../../sim/targeting.js";
import { createCardCatalog } from "../schema.js";
import {
  createChargeKnockbackQuestionRecords as createChargeKnockbackQuestionRecordsUnwrapped,
} from "../session-troop-movement-question-authority.js";

const createChargeKnockbackQuestionRecords = createChargeKnockbackQuestionRecordsUnwrapped;
export { createChargeKnockbackQuestionRecords };
import { evaluateForcedKnockbackQuestionBoundary } from "./special-movement-knockback.js";

const DEFINITION = Object.freeze({
  areaDamageRadiusMillitiles: null,
  components: [],
  cost: 5,
  count: 1,
  damage: 392,
  deployTimeTicks: 60,
  displayName: "Emberlance",
  firstHitTicks: 54,
  hitSpeedTicks: 84,
  hitpoints: 1920,
  id: "emberlance",
  kind: "unit",
  movementMillitilesPerSecond: 1000,
  rangeMillitiles: 1600,
  rarity: "special",
  sightRangeMillitiles: 5500,
  targetMode: "ground",
});

const UNIT = Object.freeze({
  id: 101,
  position: Object.freeze({ x: 3500, y: 11500 }),
  radius: 0,
});
const DEFAULT_CANDIDATES = Object.freeze([
  Object.freeze({
    alive: true,
    health: 5000,
    id: 202,
    kind: "troop",
    layer: "ground",
    position: Object.freeze({ x: 3500, y: 18500 }),
    radius: 0,
    targetable: true,
  }),
]);

const ARM_DISTANCE = 3500;
const BONUS_DAMAGE = 392;
const CHARGED_SPEED = 2000;
const COMPOSITION_SIGHT = 7000;
const MAX_CANDIDATES = 16;
const MAX_COMMANDS = 64;
const MAX_EVENTS = 4096;
const MAX_PREFLIGHT_CACHE = 128;
const MAX_TICK = 1000;
const MAX_SNAPSHOT_BYTES = 262_144;
const INTERNAL_PREFLIGHT = Symbol("charge-knockback-preflight");
const PREFLIGHTED_SETUPS = new Set();
const CANDIDATE_KEYS = [
  "alive",
  "health",
  "id",
  "kind",
  "layer",
  "position",
  "radius",
  "targetable",
];
const COMMAND_KEYS = [
  "candidate",
  "distance",
  "source",
  "targetId",
  "tick",
  "type",
];
const SETUP_KEYS = ["candidates", "commands"];
const COMMAND_TYPES = new Set([
  "knockback-attacker",
  "remove-candidate",
  "set-candidate",
]);

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
    descriptors[index].value
  );
}

function integer(value, label, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label} must be a bounded safe integer`);
  }
}

function checkedPosition(value, label) {
  const position = exactRecord(value, ["x", "y"], label);
  integer(position.x, `${label}.x`, 0, 18_000);
  integer(position.y, `${label}.y`, 0, 32_000);
  return { x: position.x, y: position.y };
}

function checkedCandidate(value, label) {
  const candidate = exactRecord(value, CANDIDATE_KEYS, label);
  integer(candidate.id, `${label}.id`, 1);
  integer(candidate.health, `${label}.health`, 0, 1_000_000);
  integer(candidate.radius, `${label}.radius`, 0, 9000);
  const position = checkedPosition(candidate.position, `${label}.position`);
  if (!["troop", "structure"].includes(candidate.kind)) {
    throw new TypeError(`${label}.kind is invalid`);
  }
  if (!["air", "ground"].includes(candidate.layer)) {
    throw new TypeError(`${label}.layer is invalid`);
  }
  if (
    typeof candidate.alive !== "boolean" ||
    typeof candidate.targetable !== "boolean" ||
    candidate.alive !== (candidate.health > 0)
  ) {
    throw new TypeError(`${label} lifecycle flags are invalid`);
  }
  return {
    alive: candidate.alive,
    health: candidate.health,
    id: candidate.id,
    kind: candidate.kind,
    layer: candidate.layer,
    position,
    radius: candidate.radius,
    targetable: candidate.targetable,
  };
}

function checkedCandidates(value) {
  const candidates = denseArray(value, MAX_CANDIDATES, "composition candidates")
    .map((entry, index) =>
      checkedCandidate(entry, `composition candidate ${index}`)
    );
  const ids = new Set();
  for (const candidate of candidates) {
    if (ids.has(candidate.id)) {
      throw new TypeError("composition candidate IDs must be unique");
    }
    ids.add(candidate.id);
  }
  return candidates.sort((left, right) => left.id - right.id);
}

function checkedCommand(value, index) {
  const command = exactRecord(
    value,
    COMMAND_KEYS,
    `composition command ${index}`,
  );
  integer(command.tick, `composition command ${index}.tick`, 0, MAX_TICK - 1);
  if (!COMMAND_TYPES.has(command.type)) {
    throw new TypeError(`composition command ${index}.type is invalid`);
  }
  integer(command.targetId, `composition command ${index}.targetId`, 1);
  if (command.type === "set-candidate") {
    const candidate = checkedCandidate(
      command.candidate,
      `composition command ${index}.candidate`,
    );
    if (
      candidate.id !== command.targetId ||
      command.distance !== null ||
      command.source !== null
    ) {
      throw new TypeError(`composition command ${index} fields disagree`);
    }
    return { candidate, distance: null, source: null,
      targetId: command.targetId, tick: command.tick, type: command.type };
  }
  if (command.type === "remove-candidate") {
    if (
      command.candidate !== null ||
      command.distance !== null ||
      command.source !== null
    ) {
      throw new TypeError(`composition command ${index} fields are inapplicable`);
    }
    return { candidate: null, distance: null, source: null,
      targetId: command.targetId, tick: command.tick, type: command.type };
  }
  if (command.candidate !== null || command.targetId !== UNIT.id) {
    throw new TypeError(`composition command ${index} victim is unsupported`);
  }
  integer(command.distance, `composition command ${index}.distance`, 1);
  const source = checkedPosition(
    command.source,
    `composition command ${index}.source`,
  );
  return { candidate: null, distance: command.distance, source,
    targetId: command.targetId, tick: command.tick, type: command.type };
}

function checkedCommands(value) {
  const commands = denseArray(value, MAX_COMMANDS, "composition commands")
    .map(checkedCommand);
  let priorTick = -1;
  const semanticKeys = new Set();
  for (const command of commands) {
    if (command.tick < priorTick) {
      throw new TypeError("composition commands must be ordered by tick");
    }
    const semanticKey = canonicalJson({
      targetId: command.targetId,
      tick: command.tick,
      type: command.type,
    });
    if (semanticKeys.has(semanticKey)) {
      throw new TypeError(
        "composition commands must not contain semantic duplicates",
      );
    }
    semanticKeys.add(semanticKey);
    priorTick = command.tick;
  }
  return commands;
}

function checkedSetup(value, preflight = true) {
  const setup = exactRecord(value, SETUP_KEYS, "composition setup");
  const candidates = checkedCandidates(setup.candidates);
  const commands = checkedCommands(setup.commands);
  const liveIds = new Set(candidates.map(({ id }) => id));
  for (const command of commands) {
    if (command.type === "remove-candidate") {
      liveIds.delete(command.targetId);
    } else if (command.type === "set-candidate") {
      liveIds.add(command.targetId);
      if (liveIds.size > MAX_CANDIDATES) {
        throw new RangeError("composition commands exceed candidate bound");
      }
    }
  }
  const checked = { candidates, commands };
  if (preflight && commands.length > 0) {
    const cacheKey = canonicalJson(checked);
    if (!PREFLIGHTED_SETUPS.has(cacheKey)) {
      const probe = new ChargeKnockbackRetargetEncounter(
        checked,
        INTERNAL_PREFLIGHT,
      );
      probe.stepMany(commands.at(-1).tick + 1, INTERNAL_PREFLIGHT);
      if (PREFLIGHTED_SETUPS.size >= MAX_PREFLIGHT_CACHE) {
        PREFLIGHTED_SETUPS.clear();
      }
      PREFLIGHTED_SETUPS.add(cacheKey);
    }
  }
  return checked;
}

function targetView(candidate) {
  return {
    alive: candidate.alive,
    id: candidate.id,
    kind: candidate.kind,
    layer: candidate.layer,
    position: { ...candidate.position },
    radius: candidate.radius,
    targetable: candidate.targetable,
  };
}

function positionAtDistance(route, distance) {
  let remaining = distance;
  for (let index = 1; index < route.length; index += 1) {
    const from = route[index - 1];
    const to = route[index];
    const length = Math.abs(to.x - from.x) + Math.abs(to.y - from.y);
    if (remaining <= length) {
      return {
        x: from.x + Math.sign(to.x - from.x) * remaining,
        y: from.y + Math.sign(to.y - from.y) * remaining,
      };
    }
    remaining -= length;
  }
  return { ...route.at(-1) };
}

function reached(position, candidate) {
  if (candidate === undefined) return false;
  const dx = BigInt(position.x - candidate.position.x);
  const dy = BigInt(position.y - candidate.position.y);
  const reach = BigInt(
    UNIT.radius + DEFINITION.rangeMillitiles + candidate.radius,
  );
  return dx * dx + dy * dy <= reach * reach;
}

function event(type, tick, fields = {}) {
  return { ...fields, tick, type };
}

export function createChargeKnockbackCatalog() {
  return createCardCatalog([DEFINITION]);
}

export function createChargeKnockbackFixture(
  candidates = clone(DEFAULT_CANDIDATES),
  commands = [],
) {
  return clone(checkedSetup({ candidates, commands }));
}

export class ChargeKnockbackRetargetEncounter {
  #attack;
  #candidates;
  #chargeProgress = 0;
  #charged = false;
  #commandIndex = 0;
  #commands;
  #history = [];
  #movement;
  #position = { ...UNIT.position };
  #route;
  #selectedTargetId = null;
  #setup;
  #tick = 0;

  constructor(setup = createChargeKnockbackFixture(), internal = null) {
    this.#setup = checkedSetup(setup, internal !== INTERNAL_PREFLIGHT);
    this.#candidates = clone(this.#setup.candidates);
    this.#commands = clone(this.#setup.commands);
    this.#attack = new AttackCycle({
      deployTicks: DEFINITION.deployTimeTicks,
      firstHitTicks: DEFINITION.firstHitTicks,
      hitSpeedTicks: DEFINITION.hitSpeedTicks,
    });
    this.#movement = createMovementState({
      direction: 1,
      position: 0,
      remainder: 0,
      speed: DEFINITION.movementMillitilesPerSecond,
    });
    this.#route = findGroundPath(
      UNIT.position,
      DEFAULT_CANDIDATES[0].position,
    );
    if (this.#route === null) {
      throw new RangeError("composition route is unavailable");
    }
  }

  get replay() {
    return clone(this.#history);
  }

  get route() {
    return clone(this.#route);
  }

  get state() {
    const selected = this.#candidates.find(
      ({ id }) => id === this.#selectedTargetId,
    );
    return clone({
      attack: this.#attack.state,
      candidates: this.#candidates,
      chargeProgressMillitiles: this.#chargeProgress,
      charged: this.#charged,
      movement: this.#movement,
      phase: this.#attack.state.phase === "deploying"
        ? "deploying"
        : selected === undefined
        ? "inert"
        : reached(this.#position, selected)
        ? this.#attack.state.phase
        : this.#charged
        ? "charged-moving"
        : "moving",
      position: this.#position,
      selectedTargetId: this.#selectedTargetId,
      tick: this.#tick,
    });
  }

  #resetCharge(boundary, emitted) {
    const hadProgress = this.#charged || this.#chargeProgress > 0;
    this.#chargeProgress = 0;
    this.#charged = false;
    this.#movement = createMovementState({
      direction: this.#selectedTargetId === null ? 0 : 1,
      position: 0,
      remainder: 0,
      speed: this.#selectedTargetId === null
        ? 0
        : DEFINITION.movementMillitilesPerSecond,
    });
    if (hadProgress) emitted.push(event("charge-reset", boundary));
  }

  #reroute(candidate) {
    if (candidate === undefined) return;
    const corner = { x: candidate.position.x, y: this.#position.y };
    this.#route = [
      { ...this.#position },
      ...(corner.x === this.#position.x && corner.y === this.#position.y
        ? []
        : [corner]),
      ...(corner.x === candidate.position.x && corner.y === candidate.position.y
        ? []
        : [{ ...candidate.position }]),
    ];
    if (this.#route.length === 1) this.#route.push({ ...candidate.position });
    this.#movement = createMovementState({
      direction: 1,
      position: 0,
      remainder: 0,
      speed: this.#charged ? CHARGED_SPEED
        : DEFINITION.movementMillitilesPerSecond,
    });
  }

  #applyCommands(boundary, emitted) {
    const candidates = clone(this.#candidates);
    const commandEvents = [];
    let commandIndex = this.#commandIndex;
    let displaced = false;
    let position = { ...this.#position };
    while (this.#commands[commandIndex]?.tick === boundary) {
      const command = this.#commands[commandIndex];
      if (command.type === "knockback-attacker") {
        const result = evaluateForcedKnockbackQuestionBoundary(
          command.source,
          [{
            eligible: true,
            id: UNIT.id,
            position,
            radius: UNIT.radius,
          }],
          command.distance,
        )[0];
        position = { ...result.position };
        displaced ||= result.applied.x !== 0 || result.applied.y !== 0;
        commandEvents.push(event("forced-knockback", boundary, {
          result,
          source: { ...command.source },
          targetId: UNIT.id,
        }));
      } else {
        const index = candidates.findIndex(
          ({ id }) => id === command.targetId,
        );
        if (command.type === "remove-candidate") {
          if (index !== -1) candidates.splice(index, 1);
        } else if (index === -1) {
          candidates.push(clone(command.candidate));
        } else {
          candidates[index] = clone(command.candidate);
        }
        candidates.sort((left, right) => left.id - right.id);
      }
      commandIndex += 1;
    }
    this.#candidates = candidates;
    this.#commandIndex = commandIndex;
    this.#position = position;
    emitted.push(...commandEvents);
    if (displaced) this.#resetCharge(boundary, emitted);
    return displaced;
  }

  step(...extra) {
    if (extra.length !== 0) {
      throw new TypeError("composition step does not accept arguments");
    }
    return this.stepMany(1);
  }

  stepMany(count, internal = null) {
    integer(count, "composition step count", 0, MAX_TICK);
    if (this.#tick + count > MAX_TICK) {
      throw new RangeError("composition encounter exceeds its tick bound");
    }
    if (internal === INTERNAL_PREFLIGHT) {
      return this.#stepManyUnchecked(count);
    }
    const priorTick = this.#tick;
    try {
      return this.#stepManyUnchecked(count);
    } catch (error) {
      const restored = new ChargeKnockbackRetargetEncounter(
        this.#setup,
        INTERNAL_PREFLIGHT,
      );
      restored.#stepManyUnchecked(priorTick);
      this.#attack = restored.#attack;
      this.#candidates = restored.#candidates;
      this.#chargeProgress = restored.#chargeProgress;
      this.#charged = restored.#charged;
      this.#commandIndex = restored.#commandIndex;
      this.#commands = restored.#commands;
      this.#history = restored.#history;
      this.#movement = restored.#movement;
      this.#position = restored.#position;
      this.#route = restored.#route;
      this.#selectedTargetId = restored.#selectedTargetId;
      this.#tick = restored.#tick;
      throw error;
    }
  }

  #stepManyUnchecked(count) {
    const emitted = [];
    for (let offset = 0; offset < count; offset += 1) {
      const boundary = this.#tick;
      const priorTargetId = this.#selectedTargetId;
      const displaced = this.#applyCommands(boundary, emitted);
      const selected = retainOrAcquireTarget(
        { position: this.#position, radius: UNIT.radius },
        this.#candidates.map(targetView),
        {
          currentTargetId: this.#selectedTargetId,
          mode: DEFINITION.targetMode,
          sightRange: COMPOSITION_SIGHT,
        },
      );
      const nextId = selected?.id ?? null;
      if (nextId !== this.#selectedTargetId) {
        if (this.#selectedTargetId !== null) {
          emitted.push(event("target-lost", boundary, {
            targetId: this.#selectedTargetId,
          }));
        }
        this.#selectedTargetId = nextId;
        if (nextId !== null) {
          emitted.push(event("target-acquired", boundary, { targetId: nextId }));
        }
        if (!displaced) this.#resetCharge(boundary, emitted);
      }

      const candidate = this.#candidates.find(({ id }) => id === nextId);
      if (
        candidate !== undefined &&
        (displaced || nextId !== priorTargetId)
      ) {
        this.#reroute(candidate);
      }
      let isReached = reached(this.#position, candidate);
      if (
        boundary >= DEFINITION.deployTimeTicks &&
        candidate !== undefined &&
        !isReached
      ) {
        const priorDistance = this.#movement.position;
        this.#movement = advanceMovement(this.#movement);
        const travelled = this.#movement.position - priorDistance;
        this.#chargeProgress += travelled;
        this.#position = positionAtDistance(this.#route, this.#movement.position);
        isReached = reached(this.#position, candidate);
        emitted.push(event("move", boundary, {
          position: { ...this.#position },
        }));
        if (!this.#charged && this.#chargeProgress >= ARM_DISTANCE) {
          this.#charged = true;
          this.#movement = createMovementState({
            direction: 1,
            position: this.#movement.position,
            remainder: this.#movement.remainder,
            speed: CHARGED_SPEED,
          });
          emitted.push(event("charge-armed", boundary, {
            distanceMillitiles: ARM_DISTANCE,
          }));
        }
        if (isReached) {
          emitted.push(event("reached", boundary, {
            position: { ...this.#position },
            targetId: candidate.id,
          }));
        }
      }

      const ready = this.#attack.step({
        targetEligible: candidate !== undefined && isReached,
        targetId: candidate !== undefined && isReached ? candidate.id : null,
      });
      for (const readyEvent of ready) {
        const target = this.#candidates.find(
          ({ id }) => id === readyEvent.targetId,
        );
        if (target === undefined || !target.alive || !reached(this.#position, target)) {
          continue;
        }
        const chargedStrike = this.#charged;
        const bonusAmount = chargedStrike ? BONUS_DAMAGE : 0;
        const amount = DEFINITION.damage + bonusAmount;
        const healthBefore = target.health;
        target.health = Math.max(0, target.health - amount);
        target.alive = target.health > 0;
        emitted.push(event("attack", boundary, {
          amount,
          baseAmount: DEFINITION.damage,
          bonusAmount,
          charged: chargedStrike,
          currentHealth: target.health,
          healthBefore,
          sequence: readyEvent.sequence,
          targetId: target.id,
        }));
        if (!target.alive) {
          emitted.push(event("death", boundary, { targetId: target.id }));
        }
        if (chargedStrike) {
          this.#charged = false;
          this.#chargeProgress = 0;
          this.#movement = createMovementState({
            direction: 1,
            position: this.#movement.position,
            remainder: this.#movement.remainder,
            speed: DEFINITION.movementMillitilesPerSecond,
          });
          emitted.push(event("charge-consumed", boundary));
        }
      }
      this.#tick += 1;
    }
    if (this.#history.length + emitted.length > MAX_EVENTS) {
      throw new RangeError("composition event bound exceeded");
    }
    this.#history.push(...clone(emitted));
    return clone(emitted);
  }

  serialize() {
    const serialized = canonicalJson({
      setup: this.#setup,
      tick: this.#tick,
      version: 1,
    });
    if (Buffer.byteLength(serialized, "utf8") > MAX_SNAPSHOT_BYTES) {
      throw new RangeError("composition snapshot exceeds its byte bound");
    }
    return serialized;
  }

  static restore(serialized) {
    if (typeof serialized !== "string") {
      throw new TypeError("composition snapshot must be a string");
    }
    if (Buffer.byteLength(serialized, "utf8") > MAX_SNAPSHOT_BYTES) {
      throw new RangeError("composition snapshot exceeds its byte bound");
    }
    let parsed;
    try {
      parsed = JSON.parse(serialized);
    } catch {
      throw new TypeError("composition snapshot must be valid JSON");
    }
    if (canonicalJson(parsed) !== serialized) {
      throw new TypeError("composition snapshot must be canonical");
    }
    const snapshot = exactRecord(
      parsed,
      ["setup", "tick", "version"],
      "composition snapshot",
    );
    if (snapshot.version !== 1) {
      throw new TypeError("composition snapshot version is unsupported");
    }
    integer(snapshot.tick, "composition snapshot.tick", 0, MAX_TICK);
    const restored = new ChargeKnockbackRetargetEncounter(snapshot.setup);
    restored.stepMany(snapshot.tick);
    if (restored.serialize() !== serialized) {
      throw new TypeError("composition snapshot is not reproducible");
    }
    return restored;
  }
}
