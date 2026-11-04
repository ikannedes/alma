import { AreaDamageSystem } from "../../sim/area-damage.js";
import { acquireTarget } from "../../sim/targeting.js";
import { validatePosition } from "../../sim/spatial.js";
import { createCardCatalog } from "../schema.js";
import {
  JUMP_QUESTION_RUNTIME,
  createJumpQuestionFixture as createJumpQuestionFixtureUnwrapped,
} from "../session-troop-movement-question-authority.js";

const createJumpQuestionFixture = createJumpQuestionFixtureUnwrapped;
export { createJumpQuestionFixture };

const QUESTION_RUNTIME = JUMP_QUESTION_RUNTIME;

const DEFINITIONS = [
  {
    id: "stonevault",
    displayName: "Stonevault",
    cost: 7,
    kind: "unit",
    rarity: "mythic",
    hitpoints: 3993,
    damage: 268,
    hitSpeedTicks: 102,
    firstHitTicks: 72,
    deployTimeTicks: 60,
    rangeMillitiles: 1200,
    sightRangeMillitiles: 5500,
    movementMillitilesPerSecond: 1000,
    targetMode: "ground",
    count: 1,
    areaDamageRadiusMillitiles: 1300,
    components: [],
  },
];

const IDENTITY = Object.freeze({
  encounter: "northbound-landing-jump-v1",
  target: Object.freeze({
    hitpoints: 1000,
    id: 202,
    kind: "troop",
    layer: "ground",
    position: Object.freeze({ x: 3500, y: 15500 }),
    radius: 0,
  }),
  unit: Object.freeze({
    id: 101,
    position: Object.freeze({ x: 3500, y: 11500 }),
    radius: 0,
  }),
});

const LANDING_CANDIDATES = Object.freeze([
  IDENTITY.target,
  Object.freeze({
    hitpoints: 536,
    id: 203,
    kind: "troop",
    layer: "ground",
    position: Object.freeze({ x: 4800, y: 15500 }),
    radius: 0,
  }),
  Object.freeze({
    hitpoints: 1000,
    id: 204,
    kind: "troop",
    layer: "ground",
    position: Object.freeze({ x: 4801, y: 15500 }),
    radius: 0,
  }),
  Object.freeze({
    hitpoints: 1000,
    id: 205,
    kind: "troop",
    layer: "air",
    position: Object.freeze({ x: 3500, y: 15500 }),
    radius: 0,
  }),
  Object.freeze({
    hitpoints: 1000,
    id: 206,
    kind: "troop",
    layer: "ground",
    position: Object.freeze({ x: 3500, y: 15500 }),
    radius: 0,
    targetable: false,
  }),
  Object.freeze({
    hitpoints: 536,
    id: 207,
    kind: "structure",
    layer: "ground",
    position: Object.freeze({ x: 4800, y: 15500 }),
    radius: 0,
  }),
]);

const COMMAND_KEYS = ["tick", "type"];
const COMMAND_TYPES = new Set(["interrupt", "target-killed", "target-lost"]);
const SETUP_KEYS = ["commands"];
const SNAPSHOT_KEYS = ["identity", "tick", "version"];
const SNAPSHOT_IDENTITY_KEYS = ["commands", "encounter"];
const MAX_COMMANDS = 1;
const MAX_SNAPSHOT_BYTES = 4096;
const MAX_TICK = 120;
const TAKEOFF_TICK = 60;
const LANDING_TICK = TAKEOFF_TICK + QUESTION_RUNTIME.transitTicks;

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
    throw new TypeError("jump commands must be a bounded plain array");
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
    throw new TypeError("jump commands must contain dense data properties");
  }
  return Array.from(
    { length: value.length },
    (_, index) => descriptors[index].value,
  );
}

function checkedCommands(value) {
  return denseCommands(value).map((entry, index) => {
    const command = exactRecord(entry, COMMAND_KEYS, `jump command ${index}`);
    if (
      !Number.isSafeInteger(command.tick) ||
      command.tick < 0 ||
      command.tick > LANDING_TICK
    ) {
      throw new TypeError(`jump command ${index}.tick is outside the encounter`);
    }
    if (!COMMAND_TYPES.has(command.type)) {
      throw new TypeError(`jump command ${index}.type is invalid`);
    }
    if (command.type === "target-lost" && command.tick > TAKEOFF_TICK) {
      throw new TypeError("target-lost must causally precede jump takeoff");
    }
    if (command.type === "interrupt" && command.tick < TAKEOFF_TICK) {
      throw new TypeError(
        "interrupt must causally occur at takeoff or during jump transit",
      );
    }
    return { tick: command.tick, type: command.type };
  });
}

function checkedSetup(value) {
  const setup = exactRecord(value, SETUP_KEYS, "jump setup");
  return { commands: checkedCommands(setup.commands) };
}

function fixedIdentity(commands) {
  return {
    commands: commands.map((command) => ({ ...command })),
    encounter: IDENTITY.encounter,
  };
}

function interpolatePosition(from, to, elapsed, total) {
  const checkedFrom = validatePosition(from, "jump interpolation start");
  const checkedTo = validatePosition(to, "jump interpolation end");
  return {
    x: checkedFrom.x + Number(
      (BigInt(checkedTo.x - checkedFrom.x) * BigInt(elapsed)) / BigInt(total),
    ),
    y: checkedFrom.y + Number(
      (BigInt(checkedTo.y - checkedFrom.y) * BigInt(elapsed)) / BigInt(total),
    ),
  };
}

function candidateState(candidate, targetAlive) {
  return {
    alive: candidate.id === IDENTITY.target.id ? targetAlive : true,
    id: candidate.id,
    kind: candidate.kind,
    layer: candidate.layer,
    position: { ...candidate.position },
    radius: candidate.radius,
    targetable: candidate.targetable ?? true,
  };
}

/**
 * Returns the isolated original Stonevault definition. Its benchmark-backed
 * numbers are comparison questions wherever the research corpus marks them
 * unverified.
 */
export function createJumpSpecialCatalog() {
  return createCardCatalog(DEFINITIONS);
}

/**
 * Creates the only caller-controlled input: at most one bounded causal event.
 * Mechanics, identities, geometry, health, and timing cannot be overridden.
 */
export function createJumpSpecialFixture(commands = []) {
  return clone(checkedSetup({ commands }));
}

/**
 * Pure exact evaluator for the inclusive QUESTION trigger interval.
 */
export function evaluateJumpQuestionBoundary(distanceMillitiles, ...extra) {
  if (
    extra.length !== 0 ||
    !Number.isSafeInteger(distanceMillitiles) ||
    distanceMillitiles < 0
  ) {
    throw new TypeError(
      "jump boundary distance must be one non-negative safe integer",
    );
  }
  return {
    eligible:
      distanceMillitiles >= QUESTION_RUNTIME.triggerMinimumMillitiles &&
      distanceMillitiles <= QUESTION_RUNTIME.triggerMaximumMillitiles,
    triggerMaximumMillitiles:
      QUESTION_RUNTIME.triggerMaximumMillitiles,
    triggerMinimumMillitiles:
      QUESTION_RUNTIME.triggerMinimumMillitiles,
  };
}

/**
 * A narrow fixed jump-transit and landing-area QUESTION fixture. Commands
 * resolve before takeoff, movement, and landing. The destination is captured
 * at takeoff; integer interpolation truncates toward zero; the jumper is
 * untargetable only in transit. Interruption stops at the last completed
 * position without impact. Target death before takeoff cancels; death after
 * takeoff preserves the destination and excludes that dead target from the
 * shared AreaDamageSystem landing batch.
 *
 * This is not an authoritative jump-value, charge, dash, recoil, collision,
 * arc/height, animation, footage, pathfinding, knockback, retargeting, deploy
 * impact, or ordinary-attack claim.
 */
export class JumpEncounter {
  #area;
  #card;
  #commands;
  #commandIndex = 0;
  #history = [];
  #jump = null;
  #position = { ...IDENTITY.unit.position };
  #targetAlive = true;
  #targetId = null;
  #targetable = true;
  #terminal = false;
  #tick = 0;

  constructor(setup = createJumpSpecialFixture()) {
    const checked = checkedSetup(setup);
    this.#commands = checked.commands;
    this.#card = createJumpSpecialCatalog()[0];
    this.#area = new AreaDamageSystem();
    for (const candidate of LANDING_CANDIDATES) {
      this.#area.add(candidate.id, candidate.hitpoints);
    }
  }

  get replay() {
    return clone(this.#history);
  }

  get state() {
    return clone({
      airborne: this.#jump !== null,
      candidateHealth: Object.fromEntries(
        LANDING_CANDIDATES.map((candidate) => [
          candidate.id,
          candidate.id === IDENTITY.target.id && !this.#targetAlive
            ? 0
            : this.#area.get(candidate.id).currentHealth,
        ]),
      ),
      jump: this.#jump,
      phase: this.#terminal
        ? "terminal"
        : this.#jump !== null
          ? "transit"
          : this.#tick < this.#card.deployTimeTicks
            ? "deploying"
            : "ready",
      position: this.#position,
      targetAlive: this.#targetAlive,
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
          reason: "target-lost-before-takeoff",
          targetId: IDENTITY.target.id,
          tick: boundary,
          type: "jump-cancelled",
        });
      } else if (command.type === "target-killed") {
        this.#targetAlive = false;
        events.push({
          targetId: IDENTITY.target.id,
          tick: boundary,
          type: "target-died",
        });
        if (boundary <= TAKEOFF_TICK) {
          this.#terminal = true;
          events.push({
            reason: "target-killed-before-takeoff",
            targetId: IDENTITY.target.id,
            tick: boundary,
            type: "jump-cancelled",
          });
        }
      } else {
        const phase = this.#jump === null ? "pretakeoff" : "transit";
        this.#jump = null;
        this.#targetable = true;
        this.#terminal = true;
        events.push({
          phase,
          position: { ...this.#position },
          tick: boundary,
          type: "jump-interrupted",
        });
        if (phase === "transit") {
          events.push({
            targetable: true,
            tick: boundary,
            type: "targetability-changed",
          });
        }
      }
    }

    if (!this.#terminal && boundary === 0) {
      const selected = acquireTarget(
        { position: this.#position, radius: IDENTITY.unit.radius },
        [candidateState(IDENTITY.target, this.#targetAlive)],
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

    if (!this.#terminal && boundary === TAKEOFF_TICK) {
      const distance = Math.abs(
        IDENTITY.target.position.x - this.#position.x,
      ) + Math.abs(IDENTITY.target.position.y - this.#position.y);
      if (
        this.#targetId === null ||
        !this.#targetAlive ||
        !evaluateJumpQuestionBoundary(distance).eligible
      ) {
        this.#terminal = true;
        events.push({
          reason: "no-eligible-target",
          tick: boundary,
          type: "jump-cancelled",
        });
      } else {
        this.#jump = {
          elapsedTicks: 0,
          from: { ...this.#position },
          targetId: this.#targetId,
          to: { ...IDENTITY.target.position },
        };
        this.#targetable = false;
        events.push({
          from: { ...this.#jump.from },
          targetId: this.#jump.targetId,
          tick: boundary,
          to: { ...this.#jump.to },
          type: "jump-takeoff",
        });
        events.push({
          targetable: false,
          tick: boundary,
          type: "targetability-changed",
        });
      }
    }

    if (
      !this.#terminal &&
      this.#jump !== null &&
      boundary > TAKEOFF_TICK
    ) {
      this.#jump.elapsedTicks += 1;
      this.#position = interpolatePosition(
        this.#jump.from,
        this.#jump.to,
        this.#jump.elapsedTicks,
        QUESTION_RUNTIME.transitTicks,
      );
      events.push({
        elapsedTicks: this.#jump.elapsedTicks,
        position: { ...this.#position },
        tick: boundary,
        type: "jump-move",
      });
      if (
        this.#jump.elapsedTicks === QUESTION_RUNTIME.transitTicks
      ) {
        const targetId = this.#jump.targetId;
        this.#jump = null;
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
          type: "jump-landed",
        });
        const result = this.#area.resolve({
          center: { ...this.#position },
          damage: QUESTION_RUNTIME.landingDamage,
          mode: QUESTION_RUNTIME.landingMode,
          radius: QUESTION_RUNTIME.landingRadiusMillitiles,
          tick: boundary,
        }, LANDING_CANDIDATES.map((candidate) =>
          candidateState(candidate, this.#targetAlive)
        ));
        events.push(...result.events);
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
      throw new TypeError("jump ticks must be a non-negative safe integer");
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
      throw new TypeError("jump tick limit must be a non-negative safe integer");
    }
    if (tickLimit > MAX_TICK) {
      throw new RangeError("jump tick limit exceeds its bound");
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
      throw new RangeError("jump snapshot exceeds its size bound");
    }
    return serialized;
  }

  static restore(serialized) {
    if (typeof serialized !== "string") {
      throw new TypeError("jump snapshot must be a string");
    }
    if (serialized.length > MAX_SNAPSHOT_BYTES) {
      throw new RangeError("jump snapshot exceeds its size bound");
    }
    let snapshot;
    try {
      snapshot = JSON.parse(serialized);
    } catch {
      throw new TypeError("jump snapshot must be valid JSON");
    }
    const checked = exactRecord(snapshot, SNAPSHOT_KEYS, "jump snapshot");
    if (checked.version !== 1) {
      throw new TypeError("jump snapshot version is unsupported");
    }
    if (
      !Number.isSafeInteger(checked.tick) ||
      checked.tick < 0 ||
      checked.tick > MAX_TICK
    ) {
      throw new TypeError("jump snapshot.tick is invalid");
    }
    const identity = exactRecord(
      checked.identity,
      SNAPSHOT_IDENTITY_KEYS,
      "jump snapshot.identity",
    );
    if (identity.encounter !== IDENTITY.encounter) {
      throw new TypeError("jump snapshot identity is unsupported");
    }
    const encounter = new JumpEncounter({
      commands: checkedCommands(identity.commands),
    });
    encounter.stepMany(checked.tick);
    if (encounter.#tick !== checked.tick) {
      throw new TypeError("jump snapshot contains post-terminal time");
    }
    return encounter;
  }
}
