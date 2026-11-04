import {
  ARENA_LENGTH_MILLITILES,
  ARENA_WIDTH_MILLITILES,
} from "../../sim/arena-geometry.js";
import {
  createKnockbackSpecialCatalog,
  evaluateForcedKnockbackQuestionBoundary,
} from "./special-movement-knockback.js";
import {
  TimedFullDisableStunEncounter,
  createStunFixture,
} from "./combat-status-stun.js";
import {
  InstantaneousCombatResetEncounter,
  createResetFixture,
} from "./special-combat-reset.js";

const SPELL = createKnockbackSpecialCatalog()[0];
const SOURCE = "unsourced-instant-radius-spell-composition";
const IMPACT_DELAY_TICKS = 2;
const CROWN_DAMAGE_NUMERATOR = 3;
const CROWN_DAMAGE_DENOMINATOR = 10;
const CROWN_DAMAGE_ROUNDING_OFFSET = 5;
const MAX_COMMANDS = 96;
const MAX_EVENTS = 8192;
const MAX_HEALTH = 1_000_000;
const MAX_OWNER_ID = 1024;
const MAX_RADIUS = 9000;
const MAX_SNAPSHOT_BYTES = 262144;
const MAX_SOURCES = 16;
const MAX_STEP_CHUNK = 128;
const MAX_TICK = 128;
const MAX_VICTIMS = 64;
const COMMAND_KEYS = [
  "center",
  "id",
  "sourceId",
  "targetId",
  "tick",
  "type",
  "variant",
];
const SETUP_KEYS = ["commands", "sources", "victims"];
const SOURCE_KEYS = ["id", "ownerId"];
const VICTIM_KEYS = [
  "combatTargetMode",
  "combatTargetId",
  "health",
  "id",
  "kind",
  "layer",
  "ownerId",
  "position",
  "radius",
  "targetable",
];
const SNAPSHOT_KEYS = ["identity", "tick", "version"];
const IDENTITY_KEYS = ["fixture", "setup"];
const COMMAND_TYPES = new Set(["cast", "source-died", "target-died"]);
const VARIANTS = new Set(["knockback", "plain", "stun-reset"]);
const VICTIM_KINDS = new Set(["crown", "structure", "troop"]);
const VICTIM_LAYERS = new Set(["air", "ground"]);
const COMBAT_TARGET_MODES = new Set([
  "air",
  "air_and_ground",
  "buildings",
  "ground",
  "none",
]);

const QUESTION_VALUES = Object.freeze({
  crownTowerDamageRatio: Object.freeze({
    denominator: CROWN_DAMAGE_DENOMINATOR,
    numerator: CROWN_DAMAGE_NUMERATOR,
  }),
  crownTowerDamageRounding: "nearest-integer-half-up",
  effectIdPolicy: "assign-monotonic-id-at-cast-in-command-order",
  impactCancellationOnSourceDeath: "cancel-pending-impact",
  impactDelayTicks: IMPACT_DELAY_TICKS,
  knockbackAdapterTiming: "same-impact-boundary-after-damage-and-deaths",
  knockbackCoupling:
    "surviving-troops-use-passed-exact-forced-knockback-boundary",
  mappedAreaDamageRadiusMillitiles: SPELL.areaDamageRadiusMillitiles,
  mappedTargetMode: SPELL.targetMode,
  multiSpellSameTickOrder: "ascending-command-id-then-effect-id",
  ownershipFilter: "hostile-owner-only",
  placementPolicy: "closed-arena-center-without-side-or-cell-mask",
  radiusBoundary: "inclusive-center-distance-plus-victim-radius",
  resetCoupling:
    "surviving-troops-with-retained-target-use-passed-instant-reset",
  resetAdapterTiming:
    "primitive-acquire-zero-reset-one-evaluated-at-impact-boundary",
  sameBoundaryOrdering:
    "commands-first-then-pending-impacts-then-damage-death-status",
  statusDeathEligibility: "status-only-on-survivors",
  statusKindFilter: "troops-only",
  stunCoupling: "surviving-troops-use-passed-full-disable-duration",
  stunAdapterTiming:
    "primitive-application-zero-translated-to-impact-boundary",
  targetKindFilter: "troop-structure-and-crown",
  targetLayerFilter: "ground-and-air",
  targetLivenessFilter: "living-at-impact-boundary",
  targetTargetableFilter: "explicit-targetable-flag",
  targetDeathAtImpact: "command-first-death-excludes-only-that-victim",
});

function clone(value) {
  return structuredClone(value);
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
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
    Array.from({ length: value.length }, (_, index) => (
      !descriptors[index]?.enumerable ||
      !Object.hasOwn(descriptors[index], "value")
    )).some(Boolean)
  ) {
    throw new TypeError(`${label} must contain dense data properties`);
  }
  return Array.from(
    { length: value.length },
    (_, index) => descriptors[index].value,
  );
}

function safeInteger(
  value,
  label,
  minimum = 0,
  maximum = Number.MAX_SAFE_INTEGER,
) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label} must be a bounded safe integer`);
  }
  return value;
}

function checkedId(value, label, nullable = false) {
  if (nullable && value === null) return null;
  return safeInteger(value, label, 1);
}

function checkedPosition(value, label) {
  const position = exactRecord(value, ["x", "y"], label);
  return {
    x: safeInteger(position.x, `${label}.x`, 0, ARENA_WIDTH_MILLITILES),
    y: safeInteger(position.y, `${label}.y`, 0, ARENA_LENGTH_MILLITILES),
  };
}

function checkedSources(value) {
  const sources = denseArray(value, MAX_SOURCES, "spell sources")
    .map((entry, index) => {
      const source = exactRecord(entry, SOURCE_KEYS, `spell source ${index}`);
      return {
        id: checkedId(source.id, `spell source ${index}.id`),
        ownerId: safeInteger(
          source.ownerId,
          `spell source ${index}.ownerId`,
          1,
          MAX_OWNER_ID,
        ),
      };
    });
  if (sources.length < 1) {
    throw new RangeError("spell sources must not be empty");
  }
  const ids = new Set();
  for (const source of sources) {
    if (ids.has(source.id)) {
      throw new TypeError("spell source IDs must be unique");
    }
    ids.add(source.id);
  }
  return sources;
}

function checkedVictims(value) {
  const victims = denseArray(value, MAX_VICTIMS, "spell victims")
    .map((entry, index) => {
      const victim = exactRecord(entry, VICTIM_KEYS, `spell victim ${index}`);
      if (!VICTIM_KINDS.has(victim.kind)) {
        throw new TypeError(`spell victim ${index}.kind is invalid`);
      }
      if (!VICTIM_LAYERS.has(victim.layer)) {
        throw new TypeError(`spell victim ${index}.layer is invalid`);
      }
      if (
        victim.combatTargetMode !== null &&
        !COMBAT_TARGET_MODES.has(victim.combatTargetMode)
      ) {
        throw new TypeError(
          `spell victim ${index}.combatTargetMode is invalid`,
        );
      }
      if (typeof victim.targetable !== "boolean") {
        throw new TypeError(`spell victim ${index}.targetable must be boolean`);
      }
      const position = checkedPosition(
        victim.position,
        `spell victim ${index}.position`,
      );
      const radius = safeInteger(
        victim.radius,
        `spell victim ${index}.radius`,
        0,
        MAX_RADIUS,
      );
      if (
        position.x < radius ||
        position.x > ARENA_WIDTH_MILLITILES - radius ||
        position.y < radius ||
        position.y > ARENA_LENGTH_MILLITILES - radius
      ) {
        throw new RangeError(
          `spell victim ${index} must fit in the radius-inset arena`,
        );
      }
      const combatTargetId = checkedId(
        victim.combatTargetId,
        `spell victim ${index}.combatTargetId`,
        true,
      );
      if (
        (combatTargetId === null) !== (victim.combatTargetMode === null)
      ) {
        throw new TypeError(
          `spell victim ${index} combat target ID and mode must both be null or non-null`,
        );
      }
      return {
        combatTargetMode: victim.combatTargetMode,
        combatTargetId,
        health: safeInteger(
          victim.health,
          `spell victim ${index}.health`,
          1,
          MAX_HEALTH,
        ),
        id: checkedId(victim.id, `spell victim ${index}.id`),
        kind: victim.kind,
        layer: victim.layer,
        ownerId: safeInteger(
          victim.ownerId,
          `spell victim ${index}.ownerId`,
          1,
          MAX_OWNER_ID,
        ),
        position,
        radius,
        targetable: victim.targetable,
      };
    });
  const ids = new Set();
  for (const victim of victims) {
    if (ids.has(victim.id)) {
      throw new TypeError("spell victim IDs must be unique");
    }
    ids.add(victim.id);
  }
  return victims;
}

function checkedCommands(value, sources, victims) {
  const sourceIds = new Set(sources.map(({ id }) => id));
  const victimIds = new Set(victims.map(({ id }) => id));
  const commands = denseArray(value, MAX_COMMANDS, "spell commands")
    .map((entry, index) => {
      const command = exactRecord(
        entry,
        COMMAND_KEYS,
        `spell command ${index}`,
      );
      if (!COMMAND_TYPES.has(command.type)) {
        throw new TypeError(`spell command ${index}.type is invalid`);
      }
      const id = checkedId(command.id, `spell command ${index}.id`);
      const maximumTick = command.type === "cast"
        ? MAX_TICK - IMPACT_DELAY_TICKS - 1
        : MAX_TICK - 1;
      const tick = safeInteger(
        command.tick,
        `spell command ${index}.tick`,
        0,
        maximumTick,
      );
      if (command.type === "cast") {
        const sourceId = checkedId(
          command.sourceId,
          `spell command ${index}.sourceId`,
        );
        if (!sourceIds.has(sourceId)) {
          throw new TypeError(`spell command ${index}.sourceId is unknown`);
        }
        if (
          command.targetId !== null ||
          !VARIANTS.has(command.variant)
        ) {
          throw new TypeError(
            `spell command ${index} has invalid cast fields`,
          );
        }
        return {
          center: checkedPosition(
            command.center,
            `spell command ${index}.center`,
          ),
          id,
          sourceId,
          targetId: null,
          tick,
          type: command.type,
          variant: command.variant,
        };
      }
      if (command.type === "source-died") {
        const sourceId = checkedId(
          command.sourceId,
          `spell command ${index}.sourceId`,
        );
        if (
          !sourceIds.has(sourceId) ||
          command.center !== null ||
          command.targetId !== null ||
          command.variant !== null
        ) {
          throw new TypeError(
            `spell command ${index} has invalid source death fields`,
          );
        }
        return {
          center: null,
          id,
          sourceId,
          targetId: null,
          tick,
          type: command.type,
          variant: null,
        };
      }
      const targetId = checkedId(
        command.targetId,
        `spell command ${index}.targetId`,
      );
      if (
        !victimIds.has(targetId) ||
        command.center !== null ||
        command.sourceId !== null ||
        command.variant !== null
      ) {
        throw new TypeError(
          `spell command ${index} has invalid target death fields`,
        );
      }
      return {
        center: null,
        id,
        sourceId: null,
        targetId,
        tick,
        type: command.type,
        variant: null,
      };
    });

  const ids = new Set();
  let priorTick = -1;
  let priorId = -1;
  for (const command of commands) {
    if (ids.has(command.id)) {
      throw new TypeError("spell command IDs must be unique");
    }
    ids.add(command.id);
    if (
      command.tick < priorTick ||
      (command.tick === priorTick && command.id <= priorId)
    ) {
      throw new TypeError(
        "spell commands must use increasing tick and command-ID order",
      );
    }
    priorTick = command.tick;
    priorId = command.id;
  }
  return commands;
}

function checkedSetup(value) {
  const setup = exactRecord(value, SETUP_KEYS, "instant spell setup");
  const sources = checkedSources(setup.sources);
  const victims = checkedVictims(setup.victims);
  const allIds = new Set(sources.map(({ id }) => id));
  for (const victim of victims) {
    if (allIds.has(victim.id)) {
      throw new TypeError("spell source and victim IDs must be disjoint");
    }
    allIds.add(victim.id);
  }
  return {
    commands: checkedCommands(setup.commands, sources, victims),
    sources,
    victims,
  };
}

function initialState(setup) {
  return {
    commandIndex: 0,
    history: [],
    nextEffectId: 1,
    pending: [],
    sources: setup.sources.map((source) => ({ ...source, alive: true })),
    tick: 0,
    victims: setup.victims.map((victim) => ({
      ...clone(victim),
      alive: true,
      disabledThroughTick: null,
      resetCount: 0,
    })),
  };
}

function overlaps(center, victim) {
  const dx = BigInt(victim.position.x) - BigInt(center.x);
  const dy = BigInt(victim.position.y) - BigInt(center.y);
  const totalRadius = BigInt(
    SPELL.areaDamageRadiusMillitiles + victim.radius,
  );
  return dx * dx + dy * dy <= totalRadius * totalRadius;
}

function crownDamage() {
  const scaled = BigInt(SPELL.damage) * BigInt(CROWN_DAMAGE_NUMERATOR);
  return Number(
    (scaled + BigInt(CROWN_DAMAGE_ROUNDING_OFFSET)) /
      BigInt(CROWN_DAMAGE_DENOMINATOR),
  );
}

function hitAmount(victim) {
  return victim.kind === "crown" ? crownDamage() : SPELL.damage;
}

function targetEligible(source, victim, center) {
  return (
    victim.alive &&
    victim.targetable &&
    victim.ownerId !== source.ownerId &&
    VICTIM_KINDS.has(victim.kind) &&
    VICTIM_LAYERS.has(victim.layer) &&
    overlaps(center, victim)
  );
}

function applyKnockback(state, impact, targets, events) {
  const eligible = targets.filter(
    (victim) => victim.alive && victim.kind === "troop",
  );
  if (eligible.length === 0) return;
  const results = evaluateForcedKnockbackQuestionBoundary(
    impact.center,
    eligible.map((victim) => ({
      eligible: true,
      id: victim.id,
      position: { ...victim.position },
      radius: victim.radius,
    })),
  );
  for (const result of results) {
    const victim = state.victims.find(({ id }) => id === result.id);
    victim.position = { ...result.position };
    events.push({
      applied: { ...result.applied },
      blocked: { ...result.blocked },
      clamped: result.clamped,
      effectId: impact.effectId,
      origin: { ...result.origin },
      position: { ...result.position },
      requested: { ...result.requested },
      targetId: result.id,
      tick: state.tick,
      type: "spell-knockback",
    });
  }
}

function retainedTargetEligible(victim, retainedTarget) {
  if (!retainedTarget.targetable || victim.combatTargetMode === "none") {
    return false;
  }
  if (victim.combatTargetMode === "buildings") {
    return (
      retainedTarget.kind === "structure" ||
      retainedTarget.kind === "crown"
    );
  }
  if (victim.combatTargetMode === "air_and_ground") return true;
  return retainedTarget.layer === victim.combatTargetMode;
}

function resetCommandsFor(state, victim, source) {
  const retainedTarget = state.victims.find(
    ({ id }) => id === victim.combatTargetId,
  );
  const commands = [{
    sourceId: null,
    targetId: victim.combatTargetId,
    tick: 0,
    type: "acquire-target",
  }];
  if (retainedTarget === undefined || !retainedTarget.alive) {
    commands.push({
      sourceId: null,
      targetId: victim.combatTargetId,
      tick: 1,
      type: "target-died",
    }, {
      sourceId: source.id,
      targetId: victim.combatTargetId,
      tick: 2,
      type: "reset",
    });
    return commands;
  }
  commands.push({
    sourceId: source.id,
    targetId: victim.combatTargetId,
    tick: 1,
    type: retainedTargetEligible(victim, retainedTarget)
      ? "reset"
      : "reset-ineligible-target",
  });
  return commands;
}

function applyStunAndReset(state, impact, targets, source, events) {
  for (const victim of targets) {
    if (!victim.alive || victim.kind !== "troop") continue;
    const stun = new TimedFullDisableStunEncounter(createStunFixture([{
      sourceId: source.id,
      targetId: null,
      tick: 0,
      type: "stun",
    }]));
    const stunEvent = stun.step().find(({ type }) => type === "stun-applied");
    victim.disabledThroughTick = state.tick + stunEvent.disabledThroughTick;
    events.push({
      disabledThroughTick: victim.disabledThroughTick,
      effectId: impact.effectId,
      sourceId: source.id,
      targetId: victim.id,
      tick: state.tick,
      type: "spell-stun",
    });

    if (victim.combatTargetId === null) continue;
    const resetCommands = resetCommandsFor(state, victim, source);
    const reset = new InstantaneousCombatResetEncounter(
      createResetFixture(resetCommands),
    );
    const resetEvent = reset.stepMany(resetCommands.length).find(
      ({ type }) => type === "combat-reset",
    );
    if (resetEvent.applied) victim.resetCount += 1;
    events.push({
      applied: resetEvent.applied,
      effectId: impact.effectId,
      primitiveEvent: clone(resetEvent),
      reason: resetEvent.reason,
      retainedTargetId: resetEvent.targetId,
      sourceId: source.id,
      targetId: victim.id,
      tick: state.tick,
      type: "spell-combat-reset",
    });
  }
}

function resolveImpact(state, impact, events) {
  const source = state.sources.find(({ id }) => id === impact.sourceId);
  if (!source.alive) {
    events.push({
      effectId: impact.effectId,
      reason: "source-dead",
      sourceId: source.id,
      tick: state.tick,
      type: "spell-cancelled",
    });
    return;
  }

  const targets = state.victims
    .filter((victim) => targetEligible(source, victim, impact.center))
    .sort((left, right) => left.id - right.id);
  events.push({
    center: { ...impact.center },
    crownDamage: crownDamage(),
    damage: SPELL.damage,
    effectId: impact.effectId,
    radius: SPELL.areaDamageRadiusMillitiles,
    sourceId: source.id,
    tick: state.tick,
    type: "spell-impact",
    variant: impact.variant,
  });

  const batch = targets.map((victim) => {
    const amount = hitAmount(victim);
    return {
      amount,
      healthAfter: Math.max(0, victim.health - amount),
      healthBefore: victim.health,
      victim,
    };
  });
  for (const { amount, victim } of batch) {
    events.push({
      amount,
      effectId: impact.effectId,
      targetId: victim.id,
      tick: state.tick,
      type: "spell-hit",
    });
  }
  for (const { amount, healthAfter, healthBefore, victim } of batch) {
    victim.health = healthAfter;
    events.push({
      amount,
      effectId: impact.effectId,
      healthAfter,
      healthBefore,
      targetId: victim.id,
      tick: state.tick,
      type: "spell-damage",
    });
  }
  for (const { healthAfter, victim } of batch) {
    if (healthAfter !== 0) continue;
    victim.alive = false;
    events.push({
      effectId: impact.effectId,
      targetId: victim.id,
      tick: state.tick,
      type: "spell-death",
    });
  }

  if (impact.variant === "knockback") {
    applyKnockback(state, impact, targets, events);
  } else if (impact.variant === "stun-reset") {
    applyStunAndReset(state, impact, targets, source, events);
  }
}

function applyCommand(state, command, events) {
  if (command.type === "cast") {
    if (state.nextEffectId === Number.MAX_SAFE_INTEGER) {
      throw new RangeError("instant spell effect ID space is exhausted");
    }
    const effectId = state.nextEffectId;
    state.nextEffectId += 1;
    const impactTick = state.tick + IMPACT_DELAY_TICKS;
    state.pending.push({
      center: { ...command.center },
      effectId,
      impactTick,
      sourceId: command.sourceId,
      variant: command.variant,
    });
    events.push({
      effectId,
      impactTick,
      sourceId: command.sourceId,
      tick: state.tick,
      type: "spell-cast",
      variant: command.variant,
    });
    return;
  }
  if (command.type === "source-died") {
    const source = state.sources.find(({ id }) => id === command.sourceId);
    if (source.alive) {
      source.alive = false;
      events.push({
        sourceId: source.id,
        tick: state.tick,
        type: "spell-source-died",
      });
    }
    return;
  }
  const victim = state.victims.find(({ id }) => id === command.targetId);
  if (victim.alive) {
    victim.alive = false;
    victim.health = 0;
    events.push({
      targetId: victim.id,
      tick: state.tick,
      type: "spell-target-died",
    });
  }
}

function advance(state, commands) {
  if (state.tick >= MAX_TICK) return [];
  const events = [];
  while (commands[state.commandIndex]?.tick === state.tick) {
    const command = commands[state.commandIndex];
    state.commandIndex += 1;
    applyCommand(state, command, events);
  }

  const due = state.pending
    .filter(({ impactTick }) => impactTick === state.tick)
    .sort((left, right) => left.effectId - right.effectId);
  state.pending = state.pending.filter(
    ({ impactTick }) => impactTick !== state.tick,
  );
  for (const impact of due) resolveImpact(state, impact, events);

  if (state.history.length + events.length > MAX_EVENTS) {
    throw new RangeError("instant spell replay exceeds its event bound");
  }
  state.history.push(...clone(events));
  state.tick += 1;
  return events;
}

function questionRecord(key, value) {
  return deepFreeze({
    authoritative: false,
    confidence: "unverified",
    disposition: "question",
    key,
    source: SOURCE,
    value: clone(value),
  });
}

export function createInstantSpellCatalog(...args) {
  if (args.length !== 0) {
    throw new TypeError("instant spell catalog does not accept overrides");
  }
  return createKnockbackSpecialCatalog();
}

export function createInstantSpellQuestionRecords(...args) {
  if (args.length !== 0) {
    throw new TypeError("instant spell questions do not accept overrides");
  }
  return deepFreeze(Object.fromEntries(
    Object.entries(QUESTION_VALUES).map(([key, value]) => [
      key,
      questionRecord(key, value),
    ]),
  ));
}

export function createInstantSpellFixture(value) {
  return clone(checkedSetup(value));
}

/**
 * A bounded causal encounter for one original instant-radius spell family.
 * Casts receive stable effect IDs immediately. Every command on a boundary is
 * applied before impacts, and each impact batches damage and deaths before
 * composing any passed status primitive.
 */
export class InstantRadiusSpellEncounter {
  #setup;
  #state;

  constructor(setup) {
    this.#setup = checkedSetup(setup);
    this.#state = initialState(this.#setup);
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
    safeInteger(count, "instant spell step count", 0, MAX_STEP_CHUNK);
    if (count > MAX_TICK - this.#state.tick) {
      throw new RangeError("instant spell step count exceeds encounter bound");
    }
    const candidate = clone(this.#state);
    const events = [];
    for (let index = 0; index < count; index += 1) {
      events.push(...advance(candidate, this.#setup.commands));
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
        fixture: "instant-radius-spell-question-v1",
        setup: this.#setup,
      },
      tick: this.#state.tick,
      version: 1,
    });
    if (Buffer.byteLength(serialized, "utf8") > MAX_SNAPSHOT_BYTES) {
      throw new RangeError("instant spell snapshot exceeds its byte bound");
    }
    return serialized;
  }

  static restore(serialized) {
    if (typeof serialized !== "string") {
      throw new TypeError("instant spell snapshot must be a string");
    }
    if (Buffer.byteLength(serialized, "utf8") > MAX_SNAPSHOT_BYTES) {
      throw new RangeError("instant spell snapshot exceeds its byte bound");
    }
    let value;
    try {
      value = JSON.parse(serialized);
    } catch {
      throw new TypeError("instant spell snapshot must be valid JSON");
    }
    if (canonicalJson(value) !== serialized) {
      throw new TypeError(
        "instant spell snapshot must be canonical duplicate-free JSON",
      );
    }
    const snapshot = exactRecord(value, SNAPSHOT_KEYS, "instant spell snapshot");
    if (snapshot.version !== 1) {
      throw new TypeError("instant spell snapshot version is unsupported");
    }
    const identity = exactRecord(
      snapshot.identity,
      IDENTITY_KEYS,
      "instant spell snapshot.identity",
    );
    if (identity.fixture !== "instant-radius-spell-question-v1") {
      throw new TypeError("instant spell snapshot fixture is unsupported");
    }
    safeInteger(snapshot.tick, "instant spell snapshot.tick", 0, MAX_TICK);
    const encounter = new InstantRadiusSpellEncounter(
      checkedSetup(identity.setup),
    );
    encounter.stepMany(snapshot.tick);
    return encounter;
  }
}
