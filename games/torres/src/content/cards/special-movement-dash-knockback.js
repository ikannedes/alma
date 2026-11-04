import { AttackCycle } from "../../sim/attack-cycle.js";
import { retainOrAcquireTarget } from "../../sim/targeting.js";
import { evaluateForcedKnockbackQuestionBoundary } from "./special-movement-knockback.js";

const MAX_TICK = 140;
const MAX_COMMANDS = 8;
const MAX_EVENTS = 512;
const MAX_SNAPSHOT_BYTES = 32_768;
const LAUNCH_TICK = 60;
const TRANSIT_TICKS = 30;
const ARRIVAL_TICK = 89;
const DASH_DAMAGE = 386;
const KNOCKBACK_DISTANCE = 2000;
const COMMAND_KEYS = ["tick", "type"];
const SETUP_KEYS = ["commands", "scenario"];
const SNAPSHOT_KEYS = ["setup", "tick", "version"];
const COMMAND_TYPES = new Set(["interrupt", "knockback", "target-killed"]);

const SCENARIOS = Object.freeze({
  baseline: Object.freeze({
    attacker: Object.freeze({ position: Object.freeze({ x: 3500, y: 11500 }), radius: 300 }),
    backup: Object.freeze({ id: 303, position: Object.freeze({ x: 4500, y: 16500 }) }),
    encounter: "veilrunner-dash-knockback-baseline-v1",
    knockbackSource: Object.freeze({ x: 5500, y: 16500 }),
    target: Object.freeze({ health: 1000, id: 202, position: Object.freeze({ x: 3500, y: 16500 }) }),
  }),
  clamp: Object.freeze({
    attacker: Object.freeze({ position: Object.freeze({ x: 1500, y: 11500 }), radius: 300 }),
    backup: Object.freeze({ id: 303, position: Object.freeze({ x: 2500, y: 16500 }) }),
    encounter: "veilrunner-dash-knockback-clamp-v1",
    knockbackSource: Object.freeze({ x: 3500, y: 16500 }),
    target: Object.freeze({ health: 1000, id: 202, position: Object.freeze({ x: 1500, y: 16500 }) }),
  }),
  diagonal: Object.freeze({
    attacker: Object.freeze({ position: Object.freeze({ x: 3500, y: 11500 }), radius: 300 }),
    backup: Object.freeze({ id: 303, position: Object.freeze({ x: 7500, y: 15500 }) }),
    encounter: "veilrunner-dash-knockback-diagonal-v1",
    knockbackSource: Object.freeze({ x: 8500, y: 15500 }),
    target: Object.freeze({ health: 1000, id: 202, position: Object.freeze({ x: 6500, y: 15500 }) }),
  }),
  fragile: Object.freeze({
    attacker: Object.freeze({ position: Object.freeze({ x: 3500, y: 11500 }), radius: 300 }),
    backup: Object.freeze({ id: 303, position: Object.freeze({ x: 4500, y: 16500 }) }),
    encounter: "veilrunner-dash-knockback-fragile-v1",
    knockbackSource: Object.freeze({ x: 5500, y: 16500 }),
    target: Object.freeze({ health: 386, id: 202, position: Object.freeze({ x: 3500, y: 16500 }) }),
  }),
});

const QUESTION_VALUES = Object.freeze({
  arrivalBoundaryOrder: [
    "dash-move",
    "targetability-restored",
    "dash-arrived",
    "dash-damage-or-skip",
    "forced-knockback",
  ],
  arrivalDamage: "snapshotted-living-target-takes-base-plus-bonus-before-retarget",
  arrivalKnockbackEligibility: "eligible-after-targetability-restoration",
  attackAfterDash: "ordinary-attack-cycle-starts-only-on-next-boundary",
  attackDamage: "composition-observes-readiness-without-applying-ordinary-damage",
  collisionPolicy: "arena-boundary-only-no-unit-or-obstacle-resolution",
  commandPriority: "commands-before-dash-transition-before-arrival-knockback",
  diagonalInterpolation: "integer-truncate-toward-zero-from-launch-snapshot",
  fullFreshWindup: 36,
  interruption: "stop-at-last-completed-position-and-restore-targetability",
  interruptionKnockbackEligibility: "interrupt-restoration-makes-same-boundary-pulse-eligible",
  knockbackDistanceMillitiles: KNOCKBACK_DISTANCE,
  knockbackDirection: "horizontal-away-from-scenario-source-x-aligned-to-current-y",
  nextBoundaryReacquisition: true,
  prelaunchDisplacement: "displacement-updates-launch-origin-with-target-snapshot-unchanged",
  prelaunchKnockbackEligibility: "eligible-while-targetable",
  retargetOrigin: "current-post-dash-or-post-knockback-position",
  stableIdReacquisition: "shared-nearest-selection-with-ascending-id-tie-break",
  targetDeathDuringTransit: "continue-to-snapshot-skip-arrival-damage-then-reacquire",
  targetabilityDuringTransit: false,
  targetabilityRestoration: "arrival-or-interruption-boundary-before-next-boundary-selection",
  transitKnockbackEligibility: "ineligible-while-untargetable-and-pulse-is-skipped",
});

function clone(value) {
  return structuredClone(value);
}

function freeze(value) {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
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
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    throw new TypeError(`${label} must be a plain object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const actual = Reflect.ownKeys(descriptors);
  if (
    actual.length !== keys.length ||
    actual.some((key) =>
      typeof key !== "string" ||
      !keys.includes(key) ||
      !descriptors[key].enumerable ||
      !Object.hasOwn(descriptors[key], "value")
    )
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
    Array.from({ length: value.length }, (_, index) => index).some((index) =>
      !descriptors[index]?.enumerable ||
      !Object.hasOwn(descriptors[index], "value")
    )
  ) {
    throw new TypeError(`${label} must contain dense data properties`);
  }
  return Array.from({ length: value.length }, (_, index) => descriptors[index].value);
}

function checkedCommands(value) {
  const commands = denseArray(value, "dash-knockback commands").map((entry, index) => {
    const command = exactRecord(entry, COMMAND_KEYS, `dash-knockback command ${index}`);
    if (
      !Number.isSafeInteger(command.tick) ||
      command.tick < 0 ||
      command.tick >= MAX_TICK
    ) {
      throw new TypeError(`dash-knockback command ${index}.tick is invalid`);
    }
    if (!COMMAND_TYPES.has(command.type)) {
      throw new TypeError(`dash-knockback command ${index}.type is invalid`);
    }
    if (command.type === "interrupt" && (command.tick < LAUNCH_TICK || command.tick > ARRIVAL_TICK)) {
      throw new TypeError("dash interruption must occur from launch through arrival");
    }
    if (command.type === "target-killed" && command.tick > ARRIVAL_TICK) {
      throw new TypeError("target death must occur no later than arrival");
    }
    return { tick: command.tick, type: command.type };
  });
  let prior = -1;
  const seen = new Set();
  let pulseCount = 0;
  for (const command of commands) {
    if (command.tick < prior) throw new TypeError("dash-knockback commands must be tick ordered");
    const identity = `${command.tick}:${command.type}`;
    if (seen.has(identity)) throw new TypeError("dash-knockback commands must be unique");
    seen.add(identity);
    if (command.type === "knockback") pulseCount += 1;
    prior = command.tick;
  }
  if (pulseCount > 1) {
    throw new TypeError("dash-knockback fixture supports only one external pulse");
  }
  return commands;
}

function checkedSetup(value) {
  const setup = exactRecord(value, SETUP_KEYS, "dash-knockback setup");
  if (typeof setup.scenario !== "string" || !Object.hasOwn(SCENARIOS, setup.scenario)) {
    throw new TypeError("dash-knockback setup.scenario is invalid");
  }
  return { commands: checkedCommands(setup.commands), scenario: setup.scenario };
}

function interpolate(from, to, elapsed) {
  return {
    x: from.x + Number((BigInt(to.x - from.x) * BigInt(elapsed)) / BigInt(TRANSIT_TICKS)),
    y: from.y + Number((BigInt(to.y - from.y) * BigInt(elapsed)) / BigInt(TRANSIT_TICKS)),
  };
}

function candidate(id, position, alive = true) {
  return {
    alive,
    id,
    kind: "troop",
    layer: "ground",
    position: { ...position },
    radius: 0,
    targetable: true,
  };
}

function questionRecord(key, value) {
  return freeze({
    authoritative: false,
    confidence: "unverified",
    disposition: "question",
    key,
    source: "unsourced-dash-knockback-retarget-composition",
    value: clone(value),
  });
}

export function createDashKnockbackQuestionRecords(...args) {
  if (args.length !== 0) {
    throw new TypeError("dash-knockback question records do not accept overrides");
  }
  return freeze(Object.fromEntries(Object.entries(QUESTION_VALUES).map(([key, value]) => [
    key,
    questionRecord(key, value),
  ])));
}

export function createDashKnockbackFixture(commands = [], scenario = "baseline") {
  return clone(checkedSetup({ commands, scenario }));
}

/**
 * A bounded QUESTION-backed composition of the passed targeted dash, forced
 * knockback projection, shared retarget selection, and shared attack cycle.
 * It makes no authoritative collision, ordinary movement, stun, mass,
 * animation, pathfinding, multi-pulse, or post-attack-damage claim.
 */
export class DashKnockbackRetargetEncounter {
  #attack = null;
  #commands;
  #commandIndex = 0;
  #history = [];
  #launch = null;
  #phase = "deploying";
  #position;
  #scenario;
  #selectedTargetId = 202;
  #setup;
  #targetAlive = true;
  #targetHealth;
  #targetable = true;
  #tick = 0;

  constructor(setup = createDashKnockbackFixture()) {
    this.#setup = checkedSetup(setup);
    this.#commands = clone(this.#setup.commands);
    this.#scenario = SCENARIOS[this.#setup.scenario];
    this.#position = { ...this.#scenario.attacker.position };
    this.#targetHealth = this.#scenario.target.health;
  }

  get replay() {
    return clone(this.#history);
  }

  get state() {
    return clone({
      attack: this.#attack?.state ?? null,
      inTransit: this.#launch !== null,
      phase: this.#phase,
      position: this.#position,
      selectedTargetId: this.#selectedTargetId,
      targetAlive: this.#targetAlive,
      targetHealth: this.#targetHealth,
      targetable: this.#targetable,
      terminal: this.#tick >= MAX_TICK,
      tick: this.#tick,
    });
  }

  #pulse(boundary, events) {
    const eligible = this.#targetable;
    if (!eligible) {
      events.push({
        eligible: false,
        reason: "dash-unit-untargetable",
        tick: boundary,
        type: "forced-knockback-skipped",
      });
      return;
    }
    const [result] = evaluateForcedKnockbackQuestionBoundary(
      { x: this.#scenario.knockbackSource.x, y: this.#position.y },
      [{ eligible: true, id: 101, position: this.#position, radius: this.#scenario.attacker.radius }],
      KNOCKBACK_DISTANCE,
    );
    this.#position = { ...result.position };
    events.push({ result, tick: boundary, type: "forced-knockback" });
  }

  #startRetarget() {
    this.#phase = "retargeting";
    this.#selectedTargetId = null;
    this.#attack = new AttackCycle({
      deployTicks: 0,
      firstHitTicks: QUESTION_VALUES.fullFreshWindup,
      hitSpeedTicks: 60,
    });
  }

  #retarget(boundary, events) {
    const candidates = [
      candidate(this.#scenario.target.id, this.#scenario.target.position, this.#targetAlive),
      candidate(this.#scenario.backup.id, this.#scenario.backup.position, true),
    ];
    const selected = retainOrAcquireTarget(
      { position: this.#position, radius: this.#scenario.attacker.radius },
      candidates,
      {
        currentTargetId: this.#selectedTargetId,
        mode: "ground",
        sightRange: 6000,
      },
    );
    const nextId = selected?.id ?? null;
    if (nextId !== this.#selectedTargetId) {
      if (this.#selectedTargetId !== null) {
        events.push({ targetId: this.#selectedTargetId, tick: boundary, type: "target-lost" });
      }
      this.#selectedTargetId = nextId;
      if (nextId !== null) {
        events.push({ targetId: nextId, tick: boundary, type: "target-acquired" });
      }
    }
    for (const ready of this.#attack.step({
      targetEligible: nextId !== null,
      targetId: nextId,
    })) {
      events.push({ ...ready, tick: boundary });
    }
  }

  step() {
    if (this.#tick >= MAX_TICK) return [];
    const boundary = this.#tick;
    const events = [];
    const pulseCommands = [];
    while (this.#commands[this.#commandIndex]?.tick === boundary) {
      const command = this.#commands[this.#commandIndex];
      this.#commandIndex += 1;
      if (command.type === "target-killed" && this.#targetAlive) {
        this.#targetAlive = false;
        this.#targetHealth = 0;
        events.push({
          currentHealth: this.#targetHealth,
          targetId: 202,
          tick: boundary,
          type: "target-died",
        });
        if (boundary <= LAUNCH_TICK && this.#launch === null) {
          this.#phase = "retarget-pending";
          events.push({
            reason: "target-killed-before-launch",
            targetId: 202,
            tick: boundary,
            type: "dash-cancelled",
          });
        }
      } else if (command.type === "interrupt" && this.#phase !== "retargeting") {
        const wasTransit = this.#launch !== null;
        this.#launch = null;
        this.#targetable = true;
        this.#phase = "retarget-pending";
        events.push({
          ...(wasTransit ? {} : { phase: "prelaunch" }),
          position: { ...this.#position },
          ...(wasTransit ? {} : { targetId: this.#selectedTargetId }),
          tick: boundary,
          type: "dash-interrupted",
        });
        if (wasTransit) {
          events.push({ targetable: true, tick: boundary, type: "targetability-changed" });
        }
      } else if (command.type === "knockback") {
        pulseCommands.push(command);
      }
    }

    if (boundary === 0 && this.#phase === "deploying") {
      events.push({ targetId: 202, tick: boundary, type: "target-acquired" });
    }

    if (boundary === LAUNCH_TICK && this.#phase === "deploying") {
      this.#phase = "transit";
      this.#launch = {
        elapsedTicks: 0,
        from: { ...this.#position },
        targetId: 202,
        to: { ...this.#scenario.target.position },
      };
      this.#targetable = false;
      events.push({
        from: { ...this.#launch.from },
        targetId: 202,
        tick: boundary,
        to: { ...this.#launch.to },
        type: "dash-launched",
      });
      events.push({ targetable: false, tick: boundary, type: "targetability-changed" });
    }

    if (this.#launch !== null) {
      this.#launch.elapsedTicks += 1;
      this.#position = interpolate(this.#launch.from, this.#launch.to, this.#launch.elapsedTicks);
      events.push({
        elapsedTicks: this.#launch.elapsedTicks,
        position: { ...this.#position },
        tick: boundary,
        type: "dash-move",
      });
      if (this.#launch.elapsedTicks === TRANSIT_TICKS) {
        this.#launch = null;
        this.#targetable = true;
        this.#phase = "retarget-pending";
        events.push({ targetable: true, tick: boundary, type: "targetability-changed" });
        events.push({
          position: { ...this.#position },
          targetId: 202,
          tick: boundary,
          type: "dash-arrived",
        });
        if (this.#targetAlive) {
          const before = this.#targetHealth;
          this.#targetHealth = Math.max(0, before - DASH_DAMAGE);
          this.#targetAlive = this.#targetHealth > 0;
          events.push({
            amount: DASH_DAMAGE,
            baseAmount: 193,
            bonusAmount: 193,
            currentHealth: this.#targetHealth,
            targetId: 202,
            tick: boundary,
            type: "dash-damage",
          });
          if (!this.#targetAlive) {
            events.push({ targetId: 202, tick: boundary, type: "target-died" });
          }
        } else {
          events.push({
            reason: "snapshotted-target-dead",
            targetId: 202,
            tick: boundary,
            type: "dash-damage-skipped",
          });
        }
      }
    }

    for (const ignored of pulseCommands) this.#pulse(boundary, events);

    if (this.#phase === "retargeting") {
      this.#retarget(boundary, events);
    } else if (this.#phase === "retarget-pending") {
      this.#startRetarget();
    }

    this.#tick += 1;
    if (this.#history.length + events.length > MAX_EVENTS) {
      throw new RangeError("dash-knockback event bound exceeded");
    }
    this.#history.push(...clone(events));
    return clone(events);
  }

  stepMany(count) {
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new TypeError("dash-knockback ticks must be a non-negative safe integer");
    }
    if (this.#tick + count > MAX_TICK) {
      throw new RangeError("dash-knockback encounter exceeds its tick bound");
    }
    const events = [];
    for (let index = 0; index < count; index += 1) events.push(...this.step());
    return events;
  }

  run(tickLimit = MAX_TICK) {
    if (!Number.isSafeInteger(tickLimit) || tickLimit < 0) {
      throw new TypeError("dash-knockback tick limit must be a non-negative safe integer");
    }
    if (tickLimit > MAX_TICK) throw new RangeError("dash-knockback tick limit exceeds its bound");
    while (this.#tick < tickLimit) this.step();
    return this.state;
  }

  serialize() {
    const serialized = canonicalJson({ setup: this.#setup, tick: this.#tick, version: 1 });
    if (Buffer.byteLength(serialized, "utf8") > MAX_SNAPSHOT_BYTES) {
      throw new RangeError("dash-knockback snapshot exceeds its byte bound");
    }
    return serialized;
  }

  static restore(serialized) {
    if (typeof serialized !== "string") throw new TypeError("dash-knockback snapshot must be a string");
    if (Buffer.byteLength(serialized, "utf8") > MAX_SNAPSHOT_BYTES) {
      throw new RangeError("dash-knockback snapshot exceeds its byte bound");
    }
    let parsed;
    try {
      parsed = JSON.parse(serialized);
    } catch {
      throw new TypeError("dash-knockback snapshot must be valid JSON");
    }
    if (canonicalJson(parsed) !== serialized) {
      throw new TypeError("dash-knockback snapshot must use canonical JSON");
    }
    const snapshot = exactRecord(parsed, SNAPSHOT_KEYS, "dash-knockback snapshot");
    if (
      snapshot.version !== 1 ||
      !Number.isSafeInteger(snapshot.tick) ||
      snapshot.tick < 0 ||
      snapshot.tick > MAX_TICK
    ) {
      throw new TypeError("dash-knockback snapshot metadata is invalid");
    }
    const restored = new DashKnockbackRetargetEncounter(checkedSetup(snapshot.setup));
    restored.stepMany(snapshot.tick);
    if (restored.serialize() !== serialized) {
      throw new TypeError("dash-knockback snapshot is not reproducible");
    }
    return restored;
  }
}
