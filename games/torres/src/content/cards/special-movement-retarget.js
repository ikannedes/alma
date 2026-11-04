import { AttackCycle } from "../../sim/attack-cycle.js";
import { retainOrAcquireTarget } from "../../sim/targeting.js";
import { createCardCatalog } from "../schema.js";
import {
  createRetargetQuestionRecords as createRetargetQuestionRecordsUnwrapped,
} from "../session-troop-movement-question-authority.js";

const createRetargetQuestionRecords = createRetargetQuestionRecordsUnwrapped;
export { createRetargetQuestionRecords };

const DEFINITION = Object.freeze({
  areaDamageRadiusMillitiles: null,
  components: [],
  cost: 3,
  count: 1,
  damage: 202,
  deployTimeTicks: 60,
  displayName: "Wayfinder",
  firstHitTicks: 42,
  hitSpeedTicks: 72,
  hitpoints: 1766,
  id: "wayfinder",
  kind: "unit",
  movementMillitilesPerSecond: 1000,
  rangeMillitiles: 1200,
  rarity: "standard",
  sightRangeMillitiles: 5500,
  targetMode: "ground",
});

const ATTACKER = Object.freeze({
  position: Object.freeze({ x: 0, y: 0 }),
  radius: 300,
});
const MAX_CANDIDATES = 16;
const MAX_COMMANDS = 64;
const MAX_EVENTS = 512;
const MAX_SNAPSHOT_BYTES = 262_144;
const MAX_TICK = 1_000;
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
const COMMAND_KEYS = ["candidate", "targetId", "tick", "type"];
const SETUP_KEYS = ["candidates", "commands"];
const COMMAND_TYPES = new Set(["remove-candidate", "set-candidate"]);

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
  return Array.from(
    { length: value.length },
    (_, index) => descriptors[index].value,
  );
}

function integer(value, label, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label} must be a bounded safe integer`);
  }
}

function checkedCandidate(value, label) {
  const candidate = exactRecord(value, CANDIDATE_KEYS, label);
  integer(candidate.id, `${label}.id`, 1);
  integer(candidate.health, `${label}.health`, 0);
  integer(candidate.radius, `${label}.radius`, 0, 10_000);
  const position = exactRecord(candidate.position, ["x", "y"], `${label}.position`);
  integer(position.x, `${label}.position.x`, -100_000, 100_000);
  integer(position.y, `${label}.position.y`, -100_000, 100_000);
  if (!["troop", "structure"].includes(candidate.kind)) {
    throw new TypeError(`${label}.kind is invalid`);
  }
  if (!["air", "ground"].includes(candidate.layer)) {
    throw new TypeError(`${label}.layer is invalid`);
  }
  if (
    typeof candidate.alive !== "boolean" ||
    typeof candidate.targetable !== "boolean"
  ) {
    throw new TypeError(`${label} flags must be booleans`);
  }
  if (candidate.alive !== (candidate.health > 0)) {
    throw new TypeError(`${label}.alive must agree with health`);
  }
  return {
    alive: candidate.alive,
    health: candidate.health,
    id: candidate.id,
    kind: candidate.kind,
    layer: candidate.layer,
    position: { x: position.x, y: position.y },
    radius: candidate.radius,
    targetable: candidate.targetable,
  };
}

function checkedCandidates(value) {
  const candidates = denseArray(value, "retarget candidates", MAX_CANDIDATES)
    .map((candidate, index) =>
      checkedCandidate(candidate, `retarget candidate ${index}`)
    );
  const ids = new Set();
  for (const candidate of candidates) {
    if (ids.has(candidate.id)) {
      throw new TypeError("retarget candidates must have unique IDs");
    }
    ids.add(candidate.id);
  }
  return candidates.sort((left, right) => left.id - right.id);
}

function checkedCommands(value) {
  const commands = denseArray(value, "retarget commands", MAX_COMMANDS)
    .map((entry, index) => {
      const command = exactRecord(entry, COMMAND_KEYS, `retarget command ${index}`);
      integer(command.tick, `retarget command ${index}.tick`, 0, MAX_TICK - 1);
      if (!COMMAND_TYPES.has(command.type)) {
        throw new TypeError(`retarget command ${index}.type is invalid`);
      }
      integer(command.targetId, `retarget command ${index}.targetId`, 1);
      if (command.type === "set-candidate") {
        const candidate = checkedCandidate(
          command.candidate,
          `retarget command ${index}.candidate`,
        );
        if (candidate.id !== command.targetId) {
          throw new TypeError(`retarget command ${index} IDs must agree`);
        }
        return { candidate, targetId: command.targetId, tick: command.tick,
          type: command.type };
      }
      if (command.candidate !== null) {
        throw new TypeError(`retarget command ${index}.candidate is inapplicable`);
      }
      return { candidate: null, targetId: command.targetId, tick: command.tick,
        type: command.type };
    });
  let priorTick = -1;
  for (const command of commands) {
    if (command.tick < priorTick) {
      throw new TypeError("retarget commands must be ordered by tick");
    }
    priorTick = command.tick;
  }
  return commands;
}

function checkedSetup(value) {
  const setup = exactRecord(value, SETUP_KEYS, "retarget setup");
  const candidates = checkedCandidates(setup.candidates);
  const commands = checkedCommands(setup.commands);
  const liveIds = new Set(candidates.map(({ id }) => id));
  for (const command of commands) {
    if (command.type === "remove-candidate") {
      liveIds.delete(command.targetId);
    } else {
      liveIds.add(command.targetId);
      if (liveIds.size > MAX_CANDIDATES) {
        throw new RangeError(
          "retarget commands exceed the live candidate bound",
        );
      }
    }
  }
  return { candidates, commands };
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

function clone(value) {
  return JSON.parse(JSON.stringify(value));
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

function inAttackReach(candidate) {
  const dx = BigInt(candidate.position.x - ATTACKER.position.x);
  const dy = BigInt(candidate.position.y - ATTACKER.position.y);
  const reach = BigInt(
    ATTACKER.radius + DEFINITION.rangeMillitiles + candidate.radius,
  );
  return dx * dx + dy * dy <= reach * reach;
}

function event(type, tick, fields = {}) {
  return { ...fields, tick, type };
}

export function createRetargetSpecialCatalog() {
  return createCardCatalog([DEFINITION]);
}

export function createRetargetFixture(candidates = [], commands = []) {
  return clone(checkedSetup({ candidates, commands }));
}

/**
 * One bounded deterministic retarget encounter. It deliberately composes only
 * selection and attack readiness; movement, knockback, and movement specials
 * are outside this artifact.
 */
export class RetargetAttackEncounter {
  #attack;
  #candidates;
  #commandIndex = 0;
  #commands;
  #history = [];
  #selectedTargetId = null;
  #setup;
  #tick = 0;

  constructor(setup = createRetargetFixture()) {
    this.#setup = checkedSetup(setup);
    this.#candidates = clone(this.#setup.candidates);
    this.#commands = clone(this.#setup.commands);
    this.#attack = new AttackCycle({
      deployTicks: DEFINITION.deployTimeTicks,
      firstHitTicks: DEFINITION.firstHitTicks,
      hitSpeedTicks: DEFINITION.hitSpeedTicks,
    });
  }

  get replay() {
    return clone(this.#history);
  }

  get state() {
    return clone({
      attack: this.#attack.state,
      candidates: this.#candidates,
      selectedTargetId: this.#selectedTargetId,
      tick: this.#tick,
    });
  }

  #applyCommands(boundary) {
    while (this.#commands[this.#commandIndex]?.tick === boundary) {
      const command = this.#commands[this.#commandIndex];
      this.#commandIndex += 1;
      const index = this.#candidates.findIndex(({ id }) =>
        id === command.targetId
      );
      if (command.type === "remove-candidate") {
        if (index !== -1) this.#candidates.splice(index, 1);
      } else if (index === -1) {
        if (this.#candidates.length >= MAX_CANDIDATES) {
          throw new RangeError("retarget candidate bound exceeded");
        }
        this.#candidates.push(clone(command.candidate));
      } else {
        this.#candidates[index] = clone(command.candidate);
      }
      this.#candidates.sort((left, right) => left.id - right.id);
    }
  }

  step() {
    return this.stepMany(1);
  }

  stepMany(count) {
    integer(count, "retarget step count", 0, MAX_TICK);
    if (this.#tick + count > MAX_TICK) {
      throw new RangeError("retarget encounter exceeds its tick bound");
    }
    const emitted = [];
    for (let offset = 0; offset < count; offset += 1) {
      const boundary = this.#tick;
      this.#applyCommands(boundary);
      const selected = retainOrAcquireTarget(
        ATTACKER,
        this.#candidates.map(targetView),
        {
          currentTargetId: this.#selectedTargetId,
          mode: DEFINITION.targetMode,
          sightRange: DEFINITION.sightRangeMillitiles,
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
      }

      const candidate = this.#candidates.find(({ id }) => id === nextId);
      const ready = this.#attack.step({
        targetEligible: candidate !== undefined && inAttackReach(candidate),
        targetId: nextId,
      });
      for (const readyEvent of ready) {
        emitted.push({ ...readyEvent });
        const target = this.#candidates.find(
          ({ id }) => id === readyEvent.targetId,
        );
        if (target === undefined || !target.alive || !inAttackReach(target)) {
          continue;
        }
        const healthBefore = target.health;
        target.health = Math.max(0, target.health - DEFINITION.damage);
        target.alive = target.health > 0;
        emitted.push(event("damage", boundary, {
          amount: DEFINITION.damage,
          healthAfter: target.health,
          healthBefore,
          targetId: target.id,
        }));
        if (!target.alive) {
          emitted.push(event("death", boundary, { targetId: target.id }));
        }
      }
      this.#tick += 1;
    }
    if (this.#history.length + emitted.length > MAX_EVENTS) {
      throw new RangeError("retarget event bound exceeded");
    }
    this.#history.push(...clone(emitted));
    return clone(emitted);
  }

  serialize() {
    return canonicalJson({
      setup: this.#setup,
      tick: this.#tick,
      version: 1,
    });
  }

  static restore(serialized) {
    if (typeof serialized !== "string") {
      throw new TypeError("retarget snapshot must be a string");
    }
    if (Buffer.byteLength(serialized, "utf8") > MAX_SNAPSHOT_BYTES) {
      throw new RangeError("retarget snapshot exceeds its byte bound");
    }
    let snapshot;
    try {
      snapshot = JSON.parse(serialized);
    } catch {
      throw new TypeError("retarget snapshot must be valid JSON");
    }
    const checked = exactRecord(
      snapshot,
      ["setup", "tick", "version"],
      "retarget snapshot",
    );
    if (checked.version !== 1 || serialized !== canonicalJson(snapshot)) {
      throw new TypeError("retarget snapshot must be canonical version 1 data");
    }
    integer(checked.tick, "retarget snapshot.tick", 0, MAX_TICK);
    const restored = new RetargetAttackEncounter(checked.setup);
    restored.stepMany(checked.tick);
    if (restored.serialize() !== serialized) {
      throw new TypeError("retarget snapshot is not reproducible");
    }
    return restored;
  }
}
