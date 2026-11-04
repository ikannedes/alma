import { DamageSystem } from "../../sim/damage.js";
import { acquireTarget } from "../../sim/targeting.js";
import { validatePosition } from "../../sim/spatial.js";
import { createCardCatalog } from "../schema.js";
import {
  DASH_QUESTION_RUNTIME,
  createDashQuestionFixture as createDashQuestionFixtureUnwrapped,
} from "../session-troop-movement-question-authority.js";

const createDashQuestionFixture = createDashQuestionFixtureUnwrapped;
export { createDashQuestionFixture };

const DEFINITIONS = [
  {
    id: "veilrunner",
    displayName: "Veilrunner",
    cost: 3,
    kind: "unit",
    rarity: "mythic",
    hitpoints: 907,
    damage: 193,
    hitSpeedTicks: 60,
    firstHitTicks: 36,
    deployTimeTicks: 60,
    rangeMillitiles: 750,
    sightRangeMillitiles: 6000,
    movementMillitilesPerSecond: 1500,
    targetMode: "ground",
    count: 1,
    areaDamageRadiusMillitiles: null,
    components: [],
  },
];

const IDENTITY = Object.freeze({
  encounter: "northbound-targeted-dash-v1",
  target: Object.freeze({
    hitpoints: 1000,
    id: 202,
    kind: "troop",
    layer: "ground",
    position: Object.freeze({ x: 3500, y: 16500 }),
    radius: 0,
  }),
  unit: Object.freeze({
    id: 101,
    position: Object.freeze({ x: 3500, y: 11500 }),
    radius: 0,
  }),
});

const COMMAND_KEYS = ["tick", "type"];
const COMMAND_TYPES = new Set(["interrupt", "target-killed", "target-lost"]);
const SETUP_KEYS = ["commands"];
const SNAPSHOT_KEYS = ["identity", "tick", "version"];
const SNAPSHOT_IDENTITY_KEYS = ["commands", "encounter"];
const MAX_COMMANDS = 1;
const MAX_SNAPSHOT_BYTES = 4096;
const MAX_TICK = 100;

const QUESTION_RUNTIME = DASH_QUESTION_RUNTIME;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
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

function denseCommands(value) {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > MAX_COMMANDS
  ) {
    throw new TypeError("dash commands must be a bounded plain array");
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
    throw new TypeError("dash commands must contain dense data properties");
  }
  return Array.from(
    { length: value.length },
    (_, index) => descriptors[index].value,
  );
}

function checkedCommands(value) {
  return denseCommands(value).map((entry, index) => {
    const command = exactRecord(entry, COMMAND_KEYS, `dash command ${index}`);
    if (
      !Number.isSafeInteger(command.tick) ||
      command.tick < 0 ||
      command.tick >= MAX_TICK
    ) {
      throw new TypeError(`dash command ${index}.tick is outside the encounter`);
    }
    if (!COMMAND_TYPES.has(command.type)) {
      throw new TypeError(`dash command ${index}.type is invalid`);
    }
    if (command.type === "target-lost" && command.tick >= 60) {
      throw new TypeError("target-lost must causally precede dash launch");
    }
    if (command.type === "interrupt" && (
      command.tick < 60 ||
      command.tick >= 90
    )) {
      throw new TypeError(
        "interrupt must causally occur at launch or during dash transit",
      );
    }
    if (command.type === "target-killed" && command.tick >= 90) {
      throw new TypeError(
        "target-killed must causally occur while the target is alive",
      );
    }
    return { tick: command.tick, type: command.type };
  });
}

function checkedSetup(value) {
  const setup = exactRecord(value, SETUP_KEYS, "dash setup");
  return { commands: checkedCommands(setup.commands) };
}

function fixedIdentity(commands) {
  return {
    commands: commands.map((command) => ({ ...command })),
    encounter: IDENTITY.encounter,
  };
}

function interpolatePosition(from, to, elapsed, total) {
  const checkedFrom = validatePosition(from, "dash interpolation start");
  const checkedTo = validatePosition(to, "dash interpolation end");
  const fraction = BigInt(elapsed);
  const divisor = BigInt(total);
  return {
    x: checkedFrom.x + Number(
      (BigInt(checkedTo.x - checkedFrom.x) * fraction) / divisor,
    ),
    y: checkedFrom.y + Number(
      (BigInt(checkedTo.y - checkedFrom.y) * fraction) / divisor,
    ),
  };
}

/**
 * Returns the isolated original Veilrunner definition. The benchmark-backed
 * combat fields are comparison questions where their research source marks
 * them unverified.
 */
export function createDashSpecialCatalog() {
  return createCardCatalog(DEFINITIONS);
}

/**
 * Creates the only caller-controlled input: at most one bounded causal event.
 * Mechanics, entities, positions, and timing cannot be overridden.
 */
export function createDashSpecialFixture(commands = []) {
  return clone(checkedSetup({ commands }));
}

/**
 * Pure inclusive launch-boundary evaluator for the QUESTION fixture.
 */
export function evaluateDashQuestionBoundary(distanceMillitiles, ...extra) {
  if (
    extra.length !== 0 ||
    !Number.isSafeInteger(distanceMillitiles) ||
    distanceMillitiles < 0
  ) {
    throw new TypeError(
      "dash boundary distance must be one non-negative safe integer",
    );
  }
  return {
    eligible:
      distanceMillitiles >= QUESTION_RUNTIME.launchMinimumMillitiles &&
      distanceMillitiles <= QUESTION_RUNTIME.launchMaximumMillitiles,
    launchMaximumMillitiles:
      QUESTION_RUNTIME.launchMaximumMillitiles,
    launchMinimumMillitiles:
      QUESTION_RUNTIME.launchMinimumMillitiles,
  };
}

/**
 * One narrow targeted-dash QUESTION fixture. Target selection composes shared
 * targeting, transit uses exact integer spatial interpolation, and arrival
 * damage composes the shared damage system.
 *
 * Chosen interruption semantics are deliberately question-backed: an explicit
 * interrupt ends transit at its last completed position and immediately makes
 * the unit targetable; once transit is snapshotted, target death does not
 * redirect it but suppresses arrival damage. A pre-launch target loss or death
 * cancels the special. At the launch boundary, commands resolve before launch
 * and the first movement step.
 *
 * This is not an authoritative value, collision, animation, footage, general
 * dash, charge, jump, recoil, pathfinding, crowd-control, or retargeting claim.
 */
export class DashEncounter {
  #card;
  #commands;
  #commandIndex = 0;
  #damage;
  #history = [];
  #launch = null;
  #position = { ...IDENTITY.unit.position };
  #targetAlive = true;
  #targetId = null;
  #targetable = true;
  #terminal = false;
  #tick = 0;

  constructor(setup = createDashSpecialFixture()) {
    const checked = checkedSetup(setup);
    this.#commands = checked.commands;
    this.#card = createDashSpecialCatalog()[0];
    this.#damage = new DamageSystem();
    this.#damage.add(IDENTITY.target.id, IDENTITY.target.hitpoints);
  }

  get replay() {
    return clone(this.#history);
  }

  get state() {
    return clone({
      inTransit: this.#launch !== null,
      launch: this.#launch,
      phase: this.#terminal
        ? "terminal"
        : this.#launch !== null
          ? "transit"
          : this.#tick < this.#card.deployTimeTicks
            ? "deploying"
            : "ready",
      position: this.#position,
      targetAlive: this.#targetAlive,
      targetHealth: this.#damage.get(IDENTITY.target.id).currentHealth,
      targetId: this.#targetId,
      targetable: this.#targetable,
      terminal: this.#terminal,
      tick: this.#tick,
    });
  }

  step() {
    if (this.#terminal || this.#tick >= MAX_TICK) return [];
    const boundary = this.#tick;
    const events = [];
    const command = this.#commands[this.#commandIndex];
    if (command?.tick === boundary) {
      this.#commandIndex += 1;
      if (command.type === "target-lost") {
        this.#targetId = null;
        this.#terminal = true;
        events.push({
          reason: "target-lost-before-launch",
          targetId: IDENTITY.target.id,
          tick: boundary,
          type: "dash-cancelled",
        });
      } else if (command.type === "interrupt") {
        this.#launch = null;
        this.#targetable = true;
        this.#terminal = true;
        if (boundary === this.#card.deployTimeTicks) {
          events.push({
            phase: "prelaunch",
            position: { ...this.#position },
            targetId: this.#targetId,
            tick: boundary,
            type: "dash-interrupted",
          });
        } else {
          events.push({
            position: { ...this.#position },
            tick: boundary,
            type: "dash-interrupted",
          });
          events.push({
            targetable: true,
            tick: boundary,
            type: "targetability-changed",
          });
        }
      } else {
        const result = this.#damage.damage(
          IDENTITY.target.id,
          IDENTITY.target.hitpoints,
        );
        this.#targetAlive = false;
        events.push({
          currentHealth: result.currentHealth,
          targetId: IDENTITY.target.id,
          tick: boundary,
          type: "target-died",
        });
        if (boundary <= this.#card.deployTimeTicks) {
          this.#terminal = true;
          events.push({
            reason: "target-killed-before-launch",
            targetId: IDENTITY.target.id,
            tick: boundary,
            type: "dash-cancelled",
          });
        }
      }
    }

    if (!this.#terminal && boundary === 0) {
      const selected = acquireTarget(
        { position: this.#position, radius: IDENTITY.unit.radius },
        [{
          alive: this.#targetAlive,
          id: IDENTITY.target.id,
          kind: IDENTITY.target.kind,
          layer: IDENTITY.target.layer,
          position: IDENTITY.target.position,
          radius: IDENTITY.target.radius,
          targetable: true,
        }],
        {
          mode: "ground",
          sightRange: this.#card.sightRangeMillitiles,
        },
      );
      this.#targetId = selected?.id ?? null;
      if (selected !== null) {
        events.push({
          targetId: selected.id,
          tick: boundary,
          type: "target-acquired",
        });
      }
    }

    if (!this.#terminal && boundary === this.#card.deployTimeTicks) {
      const distance = Math.abs(
        IDENTITY.target.position.x - this.#position.x,
      ) + Math.abs(IDENTITY.target.position.y - this.#position.y);
      if (
        this.#targetId === null ||
        !evaluateDashQuestionBoundary(distance).eligible
      ) {
        this.#terminal = true;
        events.push({
          reason: "no-eligible-target",
          tick: boundary,
          type: "dash-cancelled",
        });
      } else {
        this.#launch = {
          elapsedTicks: 0,
          from: { ...this.#position },
          targetId: this.#targetId,
          to: { ...IDENTITY.target.position },
        };
        this.#targetable = false;
        events.push({
          from: { ...this.#launch.from },
          targetId: this.#launch.targetId,
          tick: boundary,
          to: { ...this.#launch.to },
          type: "dash-launched",
        });
        events.push({
          targetable: false,
          tick: boundary,
          type: "targetability-changed",
        });
      }
    }

    if (!this.#terminal && this.#launch !== null) {
      this.#launch.elapsedTicks += 1;
      this.#position = interpolatePosition(
        this.#launch.from,
        this.#launch.to,
        this.#launch.elapsedTicks,
        QUESTION_RUNTIME.transitTicks,
      );
      events.push({
        elapsedTicks: this.#launch.elapsedTicks,
        position: { ...this.#position },
        tick: boundary,
        type: "dash-move",
      });
      if (
        this.#launch.elapsedTicks === QUESTION_RUNTIME.transitTicks
      ) {
        const targetId = this.#launch.targetId;
        this.#launch = null;
        this.#targetable = true;
        events.push({
          targetable: true,
          tick: boundary,
          type: "targetability-changed",
        });
        events.push({
          position: { ...this.#position },
          targetId,
          tick: boundary,
          type: "dash-arrived",
        });
        if (this.#targetAlive) {
          const amount = this.#card.damage +
            QUESTION_RUNTIME.bonusDamage;
          const result = this.#damage.damage(targetId, amount);
          events.push({
            amount,
            baseAmount: this.#card.damage,
            bonusAmount: QUESTION_RUNTIME.bonusDamage,
            currentHealth: result.currentHealth,
            targetId,
            tick: boundary,
            type: "dash-damage",
          });
        } else {
          events.push({
            reason: "snapshotted-target-dead",
            targetId,
            tick: boundary,
            type: "dash-damage-skipped",
          });
        }
        this.#terminal = true;
        events.push({ tick: boundary, type: "encounter-complete" });
      }
    }

    this.#tick += 1;
    this.#history.push(...events);
    return clone(events);
  }

  stepMany(ticks) {
    if (!Number.isSafeInteger(ticks) || ticks < 0) {
      throw new TypeError("dash ticks must be a non-negative safe integer");
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
      throw new TypeError("dash tick limit must be a non-negative safe integer");
    }
    if (tickLimit > MAX_TICK) {
      throw new RangeError("dash tick limit exceeds its bound");
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
      throw new RangeError("dash snapshot exceeds its size bound");
    }
    return serialized;
  }

  static restore(serialized) {
    if (typeof serialized !== "string") {
      throw new TypeError("dash snapshot must be a string");
    }
    if (serialized.length > MAX_SNAPSHOT_BYTES) {
      throw new RangeError("dash snapshot exceeds its size bound");
    }
    let snapshot;
    try {
      snapshot = JSON.parse(serialized);
    } catch {
      throw new TypeError("dash snapshot must be valid JSON");
    }
    const checked = exactRecord(snapshot, SNAPSHOT_KEYS, "dash snapshot");
    if (checked.version !== 1) {
      throw new TypeError("dash snapshot version is unsupported");
    }
    if (
      !Number.isSafeInteger(checked.tick) ||
      checked.tick < 0 ||
      checked.tick > MAX_TICK
    ) {
      throw new TypeError("dash snapshot.tick is invalid");
    }
    const identity = exactRecord(
      checked.identity,
      SNAPSHOT_IDENTITY_KEYS,
      "dash snapshot.identity",
    );
    if (identity.encounter !== IDENTITY.encounter) {
      throw new TypeError("dash snapshot identity is unsupported");
    }
    const encounter = new DashEncounter({
      commands: checkedCommands(identity.commands),
    });
    encounter.stepMany(checked.tick);
    if (encounter.#tick !== checked.tick) {
      throw new TypeError("dash snapshot contains post-terminal time");
    }
    return encounter;
  }
}
