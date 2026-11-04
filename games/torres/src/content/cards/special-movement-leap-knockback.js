import { AreaDamageSystem } from "../../sim/area-damage.js";
import { AttackCycle } from "../../sim/attack-cycle.js";
import {
  acquireTarget,
  retainOrAcquireTarget,
} from "../../sim/targeting.js";
import {
  evaluateForcedKnockbackQuestionBoundary,
} from "./special-movement-knockback.js";

const TAKEOFF_TICK = 60;
const LANDING_TICK = 96;
const MAX_TICK = 200;
const MAX_COMMANDS = 32;
const MAX_SNAPSHOT_BYTES = 65_536;
const JUMPER_ID = 101;
const INITIAL_POSITION = Object.freeze({ x: 3500, y: 11500 });
const LANDING_DAMAGE = 536;
const LANDING_RADIUS = 1300;
const FIRST_HIT_TICKS = 42;
const HIT_SPEED_TICKS = 102;
const SIGHT_RANGE = 5500;
const ATTACK_RANGE = 1200;

const CANDIDATES = Object.freeze([
  Object.freeze({
    health: 1000, id: 202, kind: "troop", layer: "ground",
    position: Object.freeze({ x: 3500, y: 15500 }), radius: 0,
    targetable: true,
  }),
  Object.freeze({
    health: 536, id: 203, kind: "troop", layer: "ground",
    position: Object.freeze({ x: 4800, y: 15500 }), radius: 0,
    targetable: true,
  }),
  Object.freeze({
    health: 1000, id: 204, kind: "troop", layer: "ground",
    position: Object.freeze({ x: 4801, y: 15500 }), radius: 0,
    targetable: true,
  }),
  Object.freeze({
    health: 1000, id: 205, kind: "troop", layer: "air",
    position: Object.freeze({ x: 3500, y: 15500 }), radius: 0,
    targetable: true,
  }),
  Object.freeze({
    health: 1000, id: 206, kind: "troop", layer: "ground",
    position: Object.freeze({ x: 3500, y: 15500 }), radius: 0,
    targetable: false,
  }),
  Object.freeze({
    health: 536, id: 207, kind: "structure", layer: "ground",
    position: Object.freeze({ x: 4800, y: 15500 }), radius: 0,
    targetable: true,
  }),
]);

const QUESTION_VALUES = Object.freeze({
  airborneAttackEligibility: "airborne-jumper-cannot-acquire-or-wind-attacks",
  airborneTargetability: "jumper-is-untargetable-from-takeoff-through-transit",
  commandPriority: "commands-before-leap-boundary-actions",
  displacementAtLanding:
    "jumper-displacement-on-landing-boundary-resolves-after-impact",
  displacementPrelaunch: "grounded-displacement-changes-takeoff-origin",
  displacementTransit:
    "forced-displacement-interrupts-at-last-completed-transit-position",
  interruptionImpact: "interrupted-leap-deals-no-landing-damage",
  landingDamage: LANDING_DAMAGE,
  landingDeathOrder: "area-hit-damage-death-before-leap-complete",
  landingRadiusMillitiles: LANDING_RADIUS,
  landingTargetEligibility:
    "living-targetable-ground-candidates-at-impact-boundary",
  postLandingRetention: "dead-snapshot-target-is-invalidated",
  reacquisitionBoundary: "first-boundary-after-landing-or-interruption",
  reacquisitionTieBreak: "nearest-then-ascending-stable-id",
  restoredTargetEligibility:
    "restoration-before-impact-reincludes-a-living-ground-candidate",
  snapshotDestination: "target-position-at-takeoff",
  targetInvalidationTransit:
    "destination-remains-snapshotted-but-ineligible-target-is-not-damaged",
  targetRestorationTransit:
    "same-id-restoration-does-not-change-snapshotted-destination",
  targetabilityRestoreOrder:
    "restore-jumper-targetability-before-landing-or-interruption-event",
  windupAfterReacquisition: "full-fresh-42-tick-first-hit-windup",
});

const COMMAND_KEYS = ["distance", "source", "targetId", "tick", "type"];
const COMMAND_TYPES = new Set([
  "displace-jumper",
  "displace-target",
  "interrupt",
  "invalidate-target",
  "restore-target",
]);

function clone(value) {
  return structuredClone(value);
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

function integer(value, label, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label} must be a bounded safe integer`);
  }
}

function checkedPoint(value, label) {
  const point = exactRecord(value, ["x", "y"], label);
  integer(point.x, `${label}.x`, 0, 18_000);
  integer(point.y, `${label}.y`, 0, 32_000);
  return { x: point.x, y: point.y };
}

function checkedCommands(value) {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > MAX_COMMANDS
  ) {
    throw new TypeError("leap composition commands must be a bounded plain array");
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
    throw new TypeError("leap composition commands must be dense data");
  }
  let previousTick = -1;
  let landingPostStageSeen = false;
  return Array.from({ length: value.length }, (_, index) => {
    const command = exactRecord(
      descriptors[index].value,
      COMMAND_KEYS,
      `leap composition command ${index}`,
    );
    integer(command.tick, `leap composition command ${index}.tick`, 0, 199);
    if (command.tick < previousTick) {
      throw new TypeError("leap composition commands must be tick ordered");
    }
    if (command.tick !== previousTick) landingPostStageSeen = false;
    previousTick = command.tick;
    if (!COMMAND_TYPES.has(command.type)) {
      throw new TypeError(`leap composition command ${index}.type is invalid`);
    }
    const needsTarget = command.type !== "displace-jumper" &&
      command.type !== "interrupt";
    if (needsTarget) {
      integer(command.targetId, `leap composition command ${index}.targetId`,
        202, 207);
      if (!CANDIDATES.some(({ id }) => id === command.targetId)) {
        throw new TypeError("leap composition target ID is unsupported");
      }
    } else if (command.targetId !== null) {
      throw new TypeError("leap composition target ID must be null");
    }
    const displacement = command.type.startsWith("displace-");
    const landingPostStage =
      command.tick === LANDING_TICK && command.type === "displace-jumper";
    if (!landingPostStage && landingPostStageSeen) {
      throw new TypeError(
        "landing-boundary pre-impact commands must precede jumper displacement",
      );
    }
    landingPostStageSeen ||= landingPostStage;
    const source = displacement
      ? checkedPoint(command.source, `leap composition command ${index}.source`)
      : null;
    if (displacement) {
      integer(command.distance, `leap composition command ${index}.distance`,
        1, 32_000);
    } else if (command.distance !== null || command.source !== null) {
      throw new TypeError("non-displacement command geometry must be null");
    }
    return {
      distance: command.distance,
      source,
      targetId: command.targetId,
      tick: command.tick,
      type: command.type,
    };
  });
}

function recursivelyFreeze(value) {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) recursivelyFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function question(key, value) {
  return recursivelyFreeze({
    authoritative: false,
    confidence: "unverified",
    disposition: "question",
    key,
    source: "unsourced-leap-knockback-retarget-composition",
    value: clone(value),
  });
}

function interpolate(from, to, elapsed) {
  return {
    x: from.x + Number(
      (BigInt(to.x - from.x) * BigInt(elapsed)) / 36n,
    ),
    y: from.y + Number(
      (BigInt(to.y - from.y) * BigInt(elapsed)) / 36n,
    ),
  };
}

function targetView(candidate) {
  return {
    alive: candidate.health > 0,
    id: candidate.id,
    kind: candidate.kind,
    layer: candidate.layer,
    position: { ...candidate.position },
    radius: candidate.radius,
    targetable: candidate.targetable,
  };
}

function inAttackReach(position, candidate) {
  const dx = BigInt(candidate.position.x - position.x);
  const dy = BigInt(candidate.position.y - position.y);
  const reach = BigInt(300 + ATTACK_RANGE + candidate.radius);
  return dx * dx + dy * dy <= reach * reach;
}

function knockback(source, entity, distance) {
  return evaluateForcedKnockbackQuestionBoundary(source, [{
    eligible: true,
    id: entity.id,
    position: entity.position,
    radius: entity.radius,
  }], distance)[0];
}

export function createLeapKnockbackFixture(commands = []) {
  return { commands: clone(checkedCommands(commands)) };
}

export function createLeapKnockbackQuestionRecords(...args) {
  if (args.length !== 0) {
    throw new TypeError("leap composition questions do not accept overrides");
  }
  return recursivelyFreeze(Object.fromEntries(
    Object.entries(QUESTION_VALUES).map(([key, value]) => [
      key,
      question(key, value),
    ]),
  ));
}

/**
 * A bounded composition fixture. It reuses the knockback projection and area
 * damage primitives, while independently sequencing jump transit and retarget
 * attack-cycle boundaries. It makes no claim that the frozen coupling policy
 * is authoritative.
 */
export class LeapKnockbackRetargetEncounter {
  #area = new AreaDamageSystem();
  #attack = new AttackCycle({
    deployTicks: 0,
    firstHitTicks: FIRST_HIT_TICKS,
    hitSpeedTicks: HIT_SPEED_TICKS,
  });
  #candidates = clone(CANDIDATES);
  #commandIndex = 0;
  #commands;
  #history = [];
  #jump = null;
  #jumpFinished = false;
  #position = { ...INITIAL_POSITION };
  #retargetAfterTick = null;
  #selectedTargetId = null;
  #targetable = true;
  #tick = 0;

  constructor(setup = createLeapKnockbackFixture()) {
    const checked = exactRecord(setup, ["commands"], "leap composition setup");
    this.#commands = checkedCommands(checked.commands);
    for (const candidate of this.#candidates) {
      this.#area.add(candidate.id, candidate.health);
    }
  }

  get replay() {
    return clone(this.#history);
  }

  get state() {
    return clone({
      airborne: this.#jump !== null,
      attack: this.#attack.state,
      candidates: this.#candidates,
      jump: this.#jump,
      jumpFinished: this.#jumpFinished,
      position: this.#position,
      selectedTargetId: this.#selectedTargetId,
      targetable: this.#targetable,
      tick: this.#tick,
    });
  }

  #interrupt(boundary, events, reason) {
    if (this.#jumpFinished) return;
    const phase = this.#jump === null ? "pretakeoff" : "transit";
    this.#jump = null;
    if (!this.#targetable) {
      this.#targetable = true;
      events.push({
        targetable: true,
        tick: boundary,
        type: "targetability-changed",
      });
    }
    this.#jumpFinished = true;
    this.#retargetAfterTick = boundary;
    events.push({
      phase,
      position: { ...this.#position },
      reason,
      tick: boundary,
      type: "jump-interrupted",
    });
  }

  #applyDisplacement(command, boundary, events) {
    const jumper = command.type === "displace-jumper";
    const entity = jumper
      ? { id: JUMPER_ID, position: this.#position, radius: 0 }
      : this.#candidates.find(({ id }) => id === command.targetId);
    const result = knockback(command.source, entity, command.distance);
    if (jumper) {
      if (this.#jump !== null && boundary < LANDING_TICK) {
        this.#interrupt(boundary, events, "forced-displacement");
      }
      this.#position = { ...result.position };
    } else {
      entity.position = { ...result.position };
    }
    events.push({
      result,
      targetId: entity.id,
      tick: boundary,
      type: "external-forced-knockback",
    });
  }

  #applyCommands(boundary, events, postLanding) {
    const candidatePositions = new Map(
      this.#candidates.map(({ id, position }) => [id, { ...position }]),
    );
    let jumperPosition = { ...this.#position };
    let validationIndex = this.#commandIndex;
    while (this.#commands[validationIndex]?.tick === boundary) {
      const command = this.#commands[validationIndex];
      const isLandingJumperDisplacement =
        boundary === LANDING_TICK && command.type === "displace-jumper";
      if (isLandingJumperDisplacement !== postLanding) break;
      if (command.type.startsWith("displace-")) {
        const jumper = command.type === "displace-jumper";
        const entity = jumper
          ? { id: JUMPER_ID, position: jumperPosition, radius: 0 }
          : {
              id: command.targetId,
              position: candidatePositions.get(command.targetId),
              radius: this.#candidates.find(({ id }) =>
                id === command.targetId
              ).radius,
            };
        const result = knockback(command.source, entity, command.distance);
        if (jumper) jumperPosition = result.position;
        else candidatePositions.set(command.targetId, result.position);
      }
      validationIndex += 1;
    }
    while (this.#commands[this.#commandIndex]?.tick === boundary) {
      const command = this.#commands[this.#commandIndex];
      const isLandingJumperDisplacement =
        boundary === LANDING_TICK && command.type === "displace-jumper";
      if (isLandingJumperDisplacement !== postLanding) break;
      this.#commandIndex += 1;
      if (command.type.startsWith("displace-")) {
        this.#applyDisplacement(command, boundary, events);
      } else if (command.type === "interrupt") {
        this.#interrupt(boundary, events, "explicit-interruption");
      } else {
        const target = this.#candidates.find(({ id }) =>
          id === command.targetId
        );
        target.targetable = command.type === "restore-target";
        events.push({
          targetId: target.id,
          targetable: target.targetable,
          tick: boundary,
          type: "candidate-targetability-changed",
        });
      }
    }
  }

  #landing(boundary, events) {
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
      damage: LANDING_DAMAGE,
      mode: "ground",
      radius: LANDING_RADIUS,
      tick: boundary,
    }, this.#candidates.map(targetView));
    events.push(...result.events);
    for (const candidate of this.#candidates) {
      candidate.health = this.#area.get(candidate.id).currentHealth;
    }
    this.#jumpFinished = true;
    this.#retargetAfterTick = boundary;
    this.#selectedTargetId = targetId;
    events.push({ tick: boundary, type: "encounter-complete" });
  }

  #retarget(boundary, events) {
    if (!this.#jumpFinished || !this.#targetable) return;
    const selected = retainOrAcquireTarget(
      { position: this.#position, radius: 0 },
      this.#candidates.map(targetView),
      {
        currentTargetId: this.#selectedTargetId,
        mode: "ground",
        sightRange: SIGHT_RANGE,
      },
    );
    const nextId = selected?.id ?? null;
    if (nextId !== this.#selectedTargetId) {
      if (this.#selectedTargetId !== null) {
        events.push({
          targetId: this.#selectedTargetId,
          tick: boundary,
          type: "target-lost",
        });
      }
      this.#selectedTargetId = nextId;
      if (nextId !== null) {
        events.push({ targetId: nextId, tick: boundary, type: "target-acquired" });
      }
    }
    const candidate = this.#candidates.find(({ id }) => id === nextId);
    const ready = this.#attack.step({
      targetEligible: candidate !== undefined &&
        inAttackReach(this.#position, candidate),
      targetId: nextId,
    });
    events.push(...ready.map((readyEvent) => ({
      ...readyEvent,
      tick: boundary,
    })));
  }

  step() {
    if (this.#tick >= MAX_TICK) return [];
    const boundary = this.#tick;
    const events = [];
    this.#applyCommands(boundary, events, false);

    if (boundary === 0 && !this.#jumpFinished) {
      const selected = acquireTarget(
        { position: this.#position, radius: 0 },
        this.#candidates.map(targetView),
        { mode: "ground", sightRange: SIGHT_RANGE },
      );
      this.#selectedTargetId = selected?.id ?? null;
      if (selected !== null) {
        events.push({
          targetId: selected.id,
          tick: boundary,
          type: "target-acquired",
        });
      }
    }
    if (boundary === TAKEOFF_TICK && !this.#jumpFinished) {
      const target = this.#candidates.find(({ id }) =>
        id === this.#selectedTargetId
      );
      if (target === undefined || !target.targetable || target.health === 0) {
        this.#interrupt(boundary, events, "no-eligible-target");
      } else {
        this.#jump = {
          elapsedTicks: 0,
          from: { ...this.#position },
          targetId: target.id,
          to: { ...target.position },
        };
        this.#targetable = false;
        events.push({
          from: { ...this.#jump.from },
          targetId: target.id,
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
    if (this.#jump !== null && boundary > TAKEOFF_TICK) {
      this.#jump.elapsedTicks += 1;
      this.#position = interpolate(
        this.#jump.from,
        this.#jump.to,
        this.#jump.elapsedTicks,
      );
      events.push({
        elapsedTicks: this.#jump.elapsedTicks,
        position: { ...this.#position },
        tick: boundary,
        type: "jump-move",
      });
      if (this.#jump.elapsedTicks === 36) this.#landing(boundary, events);
    }
    this.#applyCommands(boundary, events, true);
    if (
      this.#retargetAfterTick !== null &&
      boundary > this.#retargetAfterTick
    ) {
      this.#retarget(boundary, events);
    }

    this.#tick += 1;
    this.#history.push(...clone(events));
    return clone(events);
  }

  stepMany(count) {
    integer(count, "leap composition step count", 0, MAX_TICK);
    if (this.#tick + count > MAX_TICK) {
      throw new RangeError("leap composition exceeds its tick bound");
    }
    const events = [];
    for (let index = 0; index < count; index += 1) {
      events.push(...this.step());
    }
    return events;
  }

  run() {
    return this.stepMany(MAX_TICK - this.#tick);
  }

  serialize() {
    const serialized = canonicalJson({
      setup: { commands: this.#commands },
      tick: this.#tick,
      version: 1,
    });
    if (Buffer.byteLength(serialized, "utf8") > MAX_SNAPSHOT_BYTES) {
      throw new RangeError("leap composition snapshot exceeds its byte bound");
    }
    return serialized;
  }

  static restore(serialized) {
    if (typeof serialized !== "string") {
      throw new TypeError("leap composition snapshot must be a string");
    }
    if (Buffer.byteLength(serialized, "utf8") > MAX_SNAPSHOT_BYTES) {
      throw new RangeError("leap composition snapshot exceeds its byte bound");
    }
    let parsed;
    try {
      parsed = JSON.parse(serialized);
    } catch {
      throw new TypeError("leap composition snapshot must be valid JSON");
    }
    if (canonicalJson(parsed) !== serialized) {
      throw new TypeError("leap composition snapshot must be canonical JSON");
    }
    const snapshot = exactRecord(
      parsed,
      ["setup", "tick", "version"],
      "leap composition snapshot",
    );
    if (snapshot.version !== 1) {
      throw new TypeError("leap composition snapshot version is unsupported");
    }
    integer(snapshot.tick, "leap composition snapshot.tick", 0, MAX_TICK);
    const restored = new LeapKnockbackRetargetEncounter(snapshot.setup);
    restored.stepMany(snapshot.tick);
    if (restored.serialize() !== serialized) {
      throw new TypeError("leap composition snapshot is not reproducible");
    }
    return restored;
  }
}
