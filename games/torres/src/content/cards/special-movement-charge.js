import { AttackCycle } from "../../sim/attack-cycle.js";
import { DamageSystem } from "../../sim/damage.js";
import {
  advanceMovement,
  createMovementState,
} from "../../sim/movement.js";
import { findGroundPath } from "../../sim/pathfinding.js";
import { createCardCatalog } from "../schema.js";
import {
  CHARGE_QUESTION_RUNTIME,
  createChargeQuestionFixture as createChargeQuestionFixtureUnwrapped,
} from "../session-troop-movement-question-authority.js";

const createChargeQuestionFixture = createChargeQuestionFixtureUnwrapped;
export { createChargeQuestionFixture };

const DEFINITIONS = [
  {
    id: "emberlance",
    displayName: "Emberlance",
    cost: 5,
    kind: "unit",
    rarity: "special",
    hitpoints: 1920,
    damage: 392,
    hitSpeedTicks: 84,
    firstHitTicks: 54,
    deployTimeTicks: 60,
    rangeMillitiles: 1600,
    sightRangeMillitiles: 5500,
    movementMillitilesPerSecond: 1000,
    targetMode: "ground",
    count: 1,
    areaDamageRadiusMillitiles: null,
    components: [],
  },
];

const WEST_LANE_X = 3500;
const IDENTITY = Object.freeze({
  encounter: "west-bridge-charge-v1",
  target: Object.freeze({
    hitpoints: 5000,
    id: 202,
    position: Object.freeze({ x: WEST_LANE_X, y: 18500 }),
    radius: 0,
  }),
  unit: Object.freeze({
    cardId: "emberlance",
    id: 101,
    position: Object.freeze({ x: WEST_LANE_X, y: 11500 }),
    radius: 0,
  }),
});

const COMMAND_KEYS = ["tick", "type"];
const COMMAND_TYPES = new Set(["target-acquired", "target-lost"]);
const SETUP_KEYS = ["commands"];
const SNAPSHOT_KEYS = ["identity", "tick", "version"];
const IDENTITY_KEYS = ["commands", "encounter"];
const MAX_COMMANDS = 32;
const MAX_SNAPSHOT_BYTES = 8192;
const MAX_TICK = 1000;
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

function denseArray(value, label) {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > MAX_COMMANDS
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

function safeTick(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
  if (value >= MAX_TICK) {
    throw new RangeError(`${label} exceeds the encounter bound`);
  }
}

function checkedCommands(value) {
  const commands = denseArray(value, "charge commands").map((entry, index) => {
    const command = exactRecord(entry, COMMAND_KEYS, `charge command ${index}`);
    safeTick(command.tick, `charge command ${index}.tick`);
    if (!COMMAND_TYPES.has(command.type)) {
      throw new TypeError(`charge command ${index}.type is invalid`);
    }
    return { tick: command.tick, type: command.type };
  });
  let available = true;
  let priorTick = -1;
  for (const command of commands) {
    if (command.tick <= priorTick) {
      throw new TypeError("charge commands must have unique increasing ticks");
    }
    const expected = available ? "target-lost" : "target-acquired";
    if (command.type !== expected) {
      throw new TypeError("charge commands must causally alternate target state");
    }
    available = !available;
    priorTick = command.tick;
  }
  return commands;
}

function checkedSetup(value) {
  const setup = exactRecord(value, SETUP_KEYS, "charge setup");
  return { commands: checkedCommands(setup.commands) };
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

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

const QUESTION_RUNTIME = CHARGE_QUESTION_RUNTIME;

function fixedIdentity(commands) {
  return {
    commands: commands.map((command) => ({ ...command })),
    encounter: IDENTITY.encounter,
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

function reached(position, range) {
  const dx = BigInt(position.x - IDENTITY.target.position.x);
  const dy = BigInt(position.y - IDENTITY.target.position.y);
  const limit = BigInt(range + IDENTITY.unit.radius + IDENTITY.target.radius);
  return dx * dx + dy * dy <= limit * limit;
}

/**
 * Returns the original Emberlance definition. Its combat numbers are
 * question-backed research fixtures, not authoritative special-mechanic
 * claims.
 */
export function createChargeSpecialCatalog() {
  return createCardCatalog(DEFINITIONS);
}

/**
 * Creates a bounded causal target-availability schedule for the fixed
 * west-bridge encounter.
 */
export function createChargeSpecialFixture(commands = []) {
  return clone(checkedSetup({ commands }));
}

/**
 * Evaluates the exact arm boundary without allowing callers to replace any
 * QUESTION_FIXTURE value. This is a narrow executable description of the
 * unsourced special-mechanic assumption, not an authoritative game claim.
 */
export function evaluateChargeQuestionBoundary(
  distanceMillitiles,
  ...extra
) {
  if (
    extra.length !== 0 ||
    !Number.isSafeInteger(distanceMillitiles) ||
    distanceMillitiles < 0
  ) {
    throw new TypeError(
      "charge boundary distance must be one non-negative safe integer",
    );
  }
  const armed =
    distanceMillitiles >= QUESTION_RUNTIME.armDistanceMillitiles;
  const bonusAmount = armed ? QUESTION_RUNTIME.bonusDamage : 0;
  return {
    armed,
    movementMillitilesPerSecond: armed
      ? QUESTION_RUNTIME.chargedMovementMillitilesPerSecond
      : DEFINITIONS[0].movementMillitilesPerSecond,
    strike: {
      amount: DEFINITIONS[0].damage + bonusAmount,
      baseAmount: DEFINITIONS[0].damage,
      bonusAmount,
    },
  };
}

/**
 * A QUESTION_FIXTURE for one narrow special: uninterrupted travel arms a
 * faster locomotion phase and one bonus strike. It composes the shared path,
 * fixed-point movement, attack-cycle, and damage primitives.
 *
 * It makes no claim about authoritative special values, collision or crowd
 * behavior, knockback, animation, other units, untargetability, dashes,
 * jumps, recoil, or footage parity.
 */
export class ChargeSpecialEncounter {
  #attack;
  #card;
  #chargeProgress = 0;
  #charged = false;
  #commands;
  #commandIndex = 0;
  #damage;
  #history = [];
  #movement;
  #position = { ...IDENTITY.unit.position };
  #route;
  #targetAvailable = true;
  #targetId = null;
  #terminal = false;
  #tick = 0;

  constructor(setup = createChargeSpecialFixture()) {
    const checked = checkedSetup(setup);
    this.#commands = checked.commands;
    this.#card = createChargeSpecialCatalog()[0];
    this.#route = findGroundPath(
      IDENTITY.unit.position,
      IDENTITY.target.position,
    );
    if (this.#route === null) {
      throw new RangeError("charge encounter route is unavailable");
    }
    this.#movement = createMovementState({
      direction: 1,
      position: 0,
      remainder: 0,
      speed: this.#card.movementMillitilesPerSecond,
    });
    this.#attack = new AttackCycle({
      deployTicks: this.#card.deployTimeTicks,
      firstHitTicks: this.#card.firstHitTicks,
      hitSpeedTicks: this.#card.hitSpeedTicks,
    });
    this.#damage = new DamageSystem();
    this.#damage.add(IDENTITY.target.id, IDENTITY.target.hitpoints);
  }

  get replay() {
    return clone(this.#history);
  }

  get route() {
    return clone(this.#route);
  }

  get state() {
    let phase;
    if (this.#terminal) {
      phase = "terminal";
    } else if (this.#attack.state.phase === "deploying") {
      phase = "deploying";
    } else if (!this.#targetAvailable) {
      phase = "inert";
    } else if (reached(this.#position, this.#card.rangeMillitiles)) {
      phase = this.#attack.state.phase;
    } else {
      phase = this.#charged ? "charged-moving" : "moving";
    }
    return clone({
      attack: this.#attack.state,
      chargeProgressMillitiles: this.#chargeProgress,
      charged: this.#charged,
      movement: this.#movement,
      phase,
      position: this.#position,
      targetHealth: this.#damage.get(IDENTITY.target.id),
      targetId: this.#targetId,
      terminal: this.#terminal,
      tick: this.#tick,
    });
  }

  step() {
    if (this.#terminal || this.#tick >= MAX_TICK) return [];
    const boundary = this.#tick;
    const events = [];
    let interrupted = false;
    const command = this.#commands[this.#commandIndex];
    if (command?.tick === boundary) {
      this.#commandIndex += 1;
      this.#targetAvailable = command.type === "target-acquired";
      interrupted = !this.#targetAvailable;
    }

    const selectedId = this.#targetAvailable ? IDENTITY.target.id : null;
    if (selectedId !== this.#targetId) {
      this.#targetId = selectedId;
      events.push({
        targetId: selectedId,
        tick: boundary,
        type: selectedId === null ? "target-lost" : "target-acquired",
      });
    }

    if (interrupted) {
      const hadCharge = this.#charged || this.#chargeProgress > 0;
      this.#chargeProgress = 0;
      this.#charged = false;
      this.#movement = createMovementState({
        direction: 0,
        position: this.#movement.position,
        remainder: 0,
        speed: 0,
      });
      if (hadCharge) {
        events.push({
          tick: boundary,
          type: "charge-reset",
        });
      }
    } else if (
      this.#targetAvailable &&
      this.#movement.direction === 0 &&
      !reached(this.#position, this.#card.rangeMillitiles)
    ) {
      this.#movement = createMovementState({
        direction: 1,
        position: this.#movement.position,
        remainder: 0,
        speed: this.#card.movementMillitilesPerSecond,
      });
    }

    let isReached = this.#targetAvailable &&
      reached(this.#position, this.#card.rangeMillitiles);
    if (
      !interrupted &&
      boundary >= this.#card.deployTimeTicks &&
      this.#targetAvailable &&
      !isReached
    ) {
      const priorDistance = this.#movement.position;
      this.#movement = advanceMovement(this.#movement);
      const travelled = this.#movement.position - priorDistance;
      this.#chargeProgress += travelled;
      this.#position = positionAtDistance(this.#route, this.#movement.position);
      isReached = reached(this.#position, this.#card.rangeMillitiles);
      events.push({
        position: { ...this.#position },
        tick: boundary,
        type: "move",
      });
      if (
        !this.#charged &&
        this.#chargeProgress >= QUESTION_RUNTIME.armDistanceMillitiles
      ) {
        this.#charged = true;
        this.#movement = createMovementState({
          direction: 1,
          position: this.#movement.position,
          remainder: this.#movement.remainder,
          speed:
            QUESTION_RUNTIME.chargedMovementMillitilesPerSecond,
        });
        events.push({
          distanceMillitiles:
            QUESTION_RUNTIME.armDistanceMillitiles,
          tick: boundary,
          type: "charge-armed",
        });
      }
      if (isReached) {
        events.push({
          position: { ...this.#position },
          targetId: IDENTITY.target.id,
          tick: boundary,
          type: "reached",
        });
      }
    }

    const ready = this.#attack.step({
      targetEligible: isReached && this.#targetAvailable,
      targetId: isReached && this.#targetAvailable
        ? IDENTITY.target.id
        : null,
    });
    for (const event of ready) {
      const chargedStrike = this.#charged;
      const bonus = chargedStrike
        ? QUESTION_RUNTIME.bonusDamage
        : 0;
      const amount = this.#card.damage + bonus;
      const result = this.#damage.damage(event.targetId, amount);
      events.push({
        amount,
        baseAmount: this.#card.damage,
        bonusAmount: bonus,
        charged: chargedStrike,
        currentHealth: result.currentHealth,
        sequence: event.sequence,
        targetId: event.targetId,
        tick: event.tick,
        type: "attack",
      });
      if (chargedStrike) {
        this.#charged = false;
        this.#chargeProgress = 0;
        this.#movement = createMovementState({
          direction: 1,
          position: this.#movement.position,
          remainder: this.#movement.remainder,
          speed: this.#card.movementMillitilesPerSecond,
        });
        events.push({
          tick: event.tick,
          type: "charge-consumed",
        });
      }
      this.#terminal = true;
      events.push({
        tick: event.tick,
        type: "encounter-complete",
      });
    }

    this.#tick += 1;
    this.#history.push(...events);
    return clone(events);
  }

  stepMany(ticks) {
    if (!Number.isSafeInteger(ticks) || ticks < 0) {
      throw new TypeError("charge ticks must be a non-negative safe integer");
    }
    const events = [];
    for (
      let index = 0;
      index < ticks && !this.#terminal && this.#tick < MAX_TICK;
      index += 1
    ) {
      events.push(...this.step());
    }
    return events;
  }

  run(tickLimit = MAX_TICK) {
    if (!Number.isSafeInteger(tickLimit) || tickLimit < 0) {
      throw new TypeError("charge tick limit must be a non-negative safe integer");
    }
    if (tickLimit > MAX_TICK) {
      throw new RangeError("charge tick limit exceeds its bound");
    }
    while (!this.#terminal && this.#tick < tickLimit) this.step();
    return this.state;
  }

  serialize() {
    const serialized = canonicalJson({
      identity: fixedIdentity(this.#commands),
      tick: this.#tick,
      version: 1,
    });
    if (serialized.length > MAX_SNAPSHOT_BYTES) {
      throw new RangeError("charge snapshot exceeds its size bound");
    }
    return serialized;
  }

  static restore(serialized) {
    if (typeof serialized !== "string") {
      throw new TypeError("charge snapshot must be a string");
    }
    if (serialized.length > MAX_SNAPSHOT_BYTES) {
      throw new RangeError("charge snapshot exceeds its size bound");
    }
    let snapshot;
    try {
      snapshot = JSON.parse(serialized);
    } catch {
      throw new TypeError("charge snapshot must be valid JSON");
    }
    const checked = exactRecord(snapshot, SNAPSHOT_KEYS, "charge snapshot");
    if (checked.version !== 1) {
      throw new TypeError("charge snapshot version is unsupported");
    }
    if (!Number.isSafeInteger(checked.tick) || checked.tick < 0) {
      throw new TypeError("charge snapshot.tick is invalid");
    }
    if (checked.tick > MAX_TICK) {
      throw new RangeError("charge snapshot exceeds its causal bound");
    }
    const identity = exactRecord(
      checked.identity,
      IDENTITY_KEYS,
      "charge snapshot.identity",
    );
    if (identity.encounter !== IDENTITY.encounter) {
      throw new TypeError("charge snapshot identity is unsupported");
    }
    const encounter = new ChargeSpecialEncounter({
      commands: checkedCommands(identity.commands),
    });
    encounter.stepMany(checked.tick);
    if (encounter.#tick !== checked.tick) {
      throw new TypeError("charge snapshot contains post-terminal time");
    }
    return encounter;
  }
}
