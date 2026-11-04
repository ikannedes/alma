import {
  InstantRadiusSpellEncounter,
  createInstantSpellFixture,
} from "./spells-instant.js";
import {
  TravelingLineSpellEncounter,
  createTravelingLineSpellFixture,
} from "./spells-travel-line.js";

const SOURCE = "unsourced-three-wave-traveling-spell-composition";
const WAVE_COUNT = 3;
const WAVE_LAUNCH_OFFSETS = Object.freeze([0, 1, 2]);
const WAVE_DAMAGE = 122;
const CROWN_DAMAGE = 37;
const WAVE_RADIUS = 1400;
const MAX_EVENTS = 32768;
const MAX_SNAPSHOT_BYTES = 262144;
const MAX_STEP_CHUNK = 128;
const MAX_TICK = 128;
const SNAPSHOT_KEYS = ["identity", "tick", "version"];
const IDENTITY_KEYS = ["fixture", "setup"];

const QUESTION_VALUES = Object.freeze({
  cancellationBoundary:
    "commands-first;explicit-cancel-stops-unlaunched-and-traveling-waves",
  crownTowerDamage:
    "per-wave-nearest-integer-three-tenths-of-ordinary-damage",
  movingTargetPolicy:
    "each-wave-launch-uses-the-cast-time-static-position-snapshot",
  overlapOrder:
    "commands-then-ascending-effect-id-then-wave-index-then-line-contact-order",
  repeatHitPolicy: "an-eligible-target-may-be-hit-once-by-each-of-three-waves",
  sourceDeathBoundary:
    "commands-first;source-death-stops-unlaunched-and-traveling-waves",
  targetDeathBoundary:
    "commands-first;dead-target-excluded-from-new-contact-and-damage",
  waveDamageComposition:
    "passed-instant-radius-damage-transition-with-content-damage-adapter",
  waveGeometryComposition:
    "passed-traveling-line-static-capsule-contact-and-carrier-timing",
  waveLaunchOffsetsTicks: WAVE_LAUNCH_OFFSETS,
  waveRadiusBoundary:
    "inclusive-center-distance-plus-victim-radius-at-wave-impact",
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
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(",")}}`;
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

function safeInteger(value, label, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label} must be a bounded safe integer`);
  }
  return value;
}

function checkedSetup(value) {
  return createTravelingLineSpellFixture(value);
}

function sourceFor(state, sourceId) {
  return state.sources.find(({ id }) => id === sourceId);
}

function initialState(setup) {
  return {
    commandIndex: 0,
    history: [],
    nextEffectId: 1,
    pending: [],
    sources: setup.sources.map((source) => ({ ...clone(source), alive: true })),
    tick: 0,
    victims: setup.victims.map((victim) => ({
      ...clone(victim),
      alive: true,
    })),
  };
}

function primitiveVictim(victim, targetable = victim.targetable) {
  return {
    combatTargetId: victim.combatTargetId,
    combatTargetMode: victim.combatTargetMode,
    health: Math.max(1, victim.health),
    id: victim.id,
    kind: victim.kind,
    layer: victim.layer,
    ownerId: victim.ownerId,
    position: { ...victim.position },
    radius: victim.radius,
    targetable: victim.alive && targetable,
  };
}

function lineFixture(state, effect, wave) {
  const source = sourceFor(state, effect.sourceId);
  return createTravelingLineSpellFixture({
    commands: [{
      center: { ...effect.center },
      effectId: null,
      id: 1,
      sourceId: source.id,
      targetId: null,
      tick: 0,
      type: "cast",
    }],
    sources: [{
      id: source.id,
      ownerId: source.ownerId,
      position: { ...effect.origin },
    }],
    victims: state.victims.map((victim) => primitiveVictim(victim)),
  });
}

function lineDuration(state, effect) {
  const primitive = new TravelingLineSpellEncounter(
    lineFixture(state, effect),
  );
  const launch = primitive.step().find(({ type }) => type === "travel-launch");
  if (launch === undefined) {
    throw new TypeError("three-wave carrier failed to launch");
  }
  return launch.duration;
}

function lineEventsAt(state, effect, wave) {
  const elapsed = state.tick - wave.launchTick;
  const primitive = new TravelingLineSpellEncounter(
    lineFixture(state, effect, wave),
  );
  primitive.stepMany(elapsed + 1);
  return primitive.replay.filter(({ tick }) => tick === elapsed);
}

function withinWaveRadius(center, victim) {
  const dx = BigInt(victim.position.x) - BigInt(center.x);
  const dy = BigInt(victim.position.y) - BigInt(center.y);
  const radius = BigInt(WAVE_RADIUS + victim.radius);
  return dx * dx + dy * dy <= radius * radius;
}

function ordinaryDamage(victim) {
  return victim.kind === "crown" ? CROWN_DAMAGE : WAVE_DAMAGE;
}

function adaptedHealth(victim) {
  const damage = ordinaryDamage(victim);
  const primitiveDamage = victim.kind === "crown" ? 207 : 689;
  if (victim.health <= primitiveDamage) {
    return {
      input: victim.health + primitiveDamage - damage,
      outputOffset: 0,
    };
  }
  return {
    input: victim.health,
    outputOffset: primitiveDamage - damage,
  };
}

function resolveWaveDamage(state, effect, wave, events) {
  const source = sourceFor(state, effect.sourceId);
  const adapters = new Map();
  const victims = state.victims.map((victim) => {
    const adapter = adaptedHealth(victim);
    adapters.set(victim.id, adapter);
    return {
      ...primitiveVictim(
        victim,
        victim.targetable && withinWaveRadius(effect.center, victim),
      ),
      health: adapter.input,
    };
  });
  const primitive = new InstantRadiusSpellEncounter(createInstantSpellFixture({
    commands: [{
      center: { ...effect.center },
      id: 1,
      sourceId: source.id,
      targetId: null,
      tick: 0,
      type: "cast",
      variant: "plain",
    }],
    sources: [{ id: source.id, ownerId: source.ownerId }],
    victims,
  }));
  primitive.stepMany(3);
  const hitIds = primitive.replay
    .filter(({ type }) => type === "spell-hit")
    .map(({ targetId }) => targetId);
  const primitiveState = primitive.state;
  for (const targetId of hitIds) {
    const victim = state.victims.find(({ id }) => id === targetId);
    const result = primitiveState.victims.find(({ id }) => id === targetId);
    const healthBefore = victim.health;
    const healthAfter = result.alive
      ? result.health + adapters.get(targetId).outputOffset
      : 0;
    const amount = ordinaryDamage(victim);
    events.push({
      amount,
      effectId: effect.effectId,
      primitiveEffectId: 1,
      targetId,
      tick: state.tick,
      type: "three-wave-hit",
      waveIndex: wave.waveIndex,
    });
    victim.health = healthAfter;
    victim.alive = healthAfter > 0;
    events.push({
      amount,
      effectId: effect.effectId,
      healthAfter,
      healthBefore,
      primitiveEffectId: 1,
      targetId,
      tick: state.tick,
      type: "three-wave-damage",
      waveIndex: wave.waveIndex,
    });
    if (!victim.alive) {
      events.push({
        effectId: effect.effectId,
        primitiveEffectId: 1,
        targetId,
        tick: state.tick,
        type: "three-wave-death",
        waveIndex: wave.waveIndex,
      });
    }
  }
}

function emitWaveEvents(state, effect, wave, events) {
  if (state.tick === wave.launchTick) {
    events.push({
      center: { ...effect.center },
      duration: wave.duration,
      effectId: effect.effectId,
      impactTick: wave.impactTick,
      origin: { ...effect.origin },
      primitiveProjectileId: 1,
      sourceId: effect.sourceId,
      tick: state.tick,
      type: "three-wave-launch",
      waveIndex: wave.waveIndex,
    });
  }
  const primitiveEvents = lineEventsAt(state, effect, wave);
  const contacted = new Set(wave.contactedTargetIds);
  for (const contact of primitiveEvents.filter(
    ({ type }) => type === "travel-contact",
  )) {
    if (contacted.has(contact.targetId)) continue;
    contacted.add(contact.targetId);
    wave.contactedTargetIds.push(contact.targetId);
    events.push({
      effectId: effect.effectId,
      orderNumerator: contact.orderNumerator,
      targetId: contact.targetId,
      tick: state.tick,
      type: "three-wave-contact",
      waveIndex: wave.waveIndex,
    });
  }
  if (state.tick === wave.impactTick) {
    const impact = primitiveEvents.find(({ type }) => type === "travel-impact");
    if (impact === undefined) {
      throw new TypeError("three-wave carrier failed to contact its endpoint");
    }
    events.push({
      center: { ...effect.center },
      duration: wave.duration,
      effectId: effect.effectId,
      primitiveProjectileId: impact.primitiveProjectileId,
      sourceId: effect.sourceId,
      tick: state.tick,
      type: "three-wave-impact",
      waveIndex: wave.waveIndex,
    });
    resolveWaveDamage(state, effect, wave, events);
    wave.resolved = true;
  }
}

function createEffect(state, command, source) {
  if (state.nextEffectId === Number.MAX_SAFE_INTEGER) {
    throw new RangeError("three-wave effect ID space is exhausted");
  }
  const effect = {
    cancelled: false,
    center: { ...command.center },
    effectId: state.nextEffectId,
    origin: { ...source.position },
    sourceId: source.id,
    waves: [],
  };
  state.nextEffectId += 1;
  const duration = lineDuration(state, effect);
  for (let waveIndex = 0; waveIndex < WAVE_COUNT; waveIndex += 1) {
    const launchTick = state.tick + WAVE_LAUNCH_OFFSETS[waveIndex];
    const impactTick = launchTick + duration;
    if (impactTick > MAX_TICK - 1) {
      throw new RangeError("three-wave impact exceeds encounter tick bound");
    }
    effect.waves.push({
      contactedTargetIds: [],
      duration,
      impactTick,
      launchTick,
      resolved: false,
      waveIndex,
    });
  }
  return effect;
}

function cancelEffect(state, effect, reason, events) {
  if (effect === undefined || effect.cancelled) return;
  effect.cancelled = true;
  events.push({
    effectId: effect.effectId,
    reason,
    sourceId: effect.sourceId,
    tick: state.tick,
    type: "three-wave-cancelled",
  });
}

function applyCommand(state, command, events) {
  if (command.type === "cast") {
    const source = sourceFor(state, command.sourceId);
    if (!source.alive) {
      events.push({
        commandId: command.id,
        reason: "source-dead",
        sourceId: source.id,
        tick: state.tick,
        type: "three-wave-cast-cancelled",
      });
      return;
    }
    const effect = createEffect(state, command, source);
    state.pending.push(effect);
    events.push({
      center: { ...effect.center },
      effectId: effect.effectId,
      sourceId: source.id,
      tick: state.tick,
      type: "three-wave-cast",
      waveCount: WAVE_COUNT,
    });
    return;
  }
  if (command.type === "source-died") {
    const source = sourceFor(state, command.sourceId);
    if (source.alive) {
      source.alive = false;
      events.push({
        sourceId: source.id,
        tick: state.tick,
        type: "three-wave-source-died",
      });
      for (const effect of state.pending.filter(
        ({ sourceId }) => sourceId === source.id,
      )) {
        cancelEffect(state, effect, "source-dead", events);
      }
    }
    return;
  }
  if (command.type === "target-died") {
    const victim = state.victims.find(({ id }) => id === command.targetId);
    if (victim.alive) {
      victim.alive = false;
      victim.health = 0;
      events.push({
        targetId: victim.id,
        tick: state.tick,
        type: "three-wave-target-died",
      });
    }
    return;
  }
  const effect = state.pending.find(
    ({ effectId }) => effectId === command.effectId,
  );
  cancelEffect(state, effect, "explicit-cancel", events);
}

function advance(state, commands) {
  if (state.tick >= MAX_TICK) return [];
  const events = [];
  while (commands[state.commandIndex]?.tick === state.tick) {
    const command = commands[state.commandIndex];
    state.commandIndex += 1;
    applyCommand(state, command, events);
  }
  const effects = state.pending
    .filter(({ cancelled }) => !cancelled)
    .sort((left, right) => left.effectId - right.effectId);
  for (const effect of effects) {
    const source = sourceFor(state, effect.sourceId);
    if (!source.alive) {
      cancelEffect(state, effect, "source-dead", events);
      continue;
    }
    for (const wave of effect.waves) {
      if (
        !wave.resolved &&
        wave.launchTick <= state.tick &&
        state.tick <= wave.impactTick
      ) {
        emitWaveEvents(state, effect, wave, events);
      }
    }
  }
  state.pending = state.pending.filter((effect) => (
    !effect.cancelled &&
    effect.waves.some(({ resolved }) => !resolved)
  ));
  if (state.history.length + events.length > MAX_EVENTS) {
    throw new RangeError("three-wave replay exceeds its event bound");
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

export function createThreeWaveTravelingSpellCatalog(...args) {
  if (args.length !== 0) {
    throw new TypeError("three-wave spell catalog does not accept overrides");
  }
  return deepFreeze([{
    areaDamageRadiusMillitiles: WAVE_RADIUS,
    components: [],
    cost: 3,
    count: 1,
    damage: WAVE_DAMAGE,
    deployTimeTicks: null,
    displayName: "Skyshard Volley",
    firstHitTicks: null,
    hitSpeedTicks: null,
    hitpoints: null,
    id: "skyshard-volley",
    kind: "effect",
    movementMillitilesPerSecond: null,
    rangeMillitiles: null,
    rarity: "common",
    sightRangeMillitiles: null,
    targetMode: "ground-and-air",
  }]);
}

export function createThreeWaveTravelingSpellQuestionRecords(...args) {
  if (args.length !== 0) {
    throw new TypeError("three-wave spell questions do not accept overrides");
  }
  return deepFreeze(Object.fromEntries(
    Object.entries(QUESTION_VALUES).map(([key, value]) => [
      key,
      questionRecord(key, value),
    ]),
  ));
}

export function createThreeWaveTravelingSpellFixture(value) {
  return clone(checkedSetup(value));
}

/**
 * Three independently traveling waves. Every wave delegates its carrier
 * timing and finite-capsule contacts to the passed line encounter and its
 * terminal target/damage transition to the passed instant encounter.
 * Returning legs and rolling collision state are intentionally absent.
 */
export class ThreeWaveTravelingSpellEncounter {
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
    safeInteger(count, "three-wave spell step count", 0, MAX_STEP_CHUNK);
    if (count > MAX_TICK - this.#state.tick) {
      throw new RangeError("three-wave spell step count exceeds encounter bound");
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
        fixture: "three-wave-traveling-spell-question-v1",
        setup: this.#setup,
      },
      tick: this.#state.tick,
      version: 1,
    });
    if (Buffer.byteLength(serialized, "utf8") > MAX_SNAPSHOT_BYTES) {
      throw new RangeError("three-wave spell snapshot exceeds its byte bound");
    }
    return serialized;
  }

  static restore(serialized) {
    if (typeof serialized !== "string") {
      throw new TypeError("three-wave spell snapshot must be a string");
    }
    if (Buffer.byteLength(serialized, "utf8") > MAX_SNAPSHOT_BYTES) {
      throw new RangeError("three-wave spell snapshot exceeds its byte bound");
    }
    let value;
    try {
      value = JSON.parse(serialized);
    } catch {
      throw new TypeError("three-wave spell snapshot must be valid JSON");
    }
    if (canonicalJson(value) !== serialized) {
      throw new TypeError(
        "three-wave spell snapshot must be canonical duplicate-free JSON",
      );
    }
    const snapshot = exactRecord(
      value,
      SNAPSHOT_KEYS,
      "three-wave spell snapshot",
    );
    if (snapshot.version !== 1) {
      throw new TypeError("three-wave spell snapshot version is unsupported");
    }
    const identity = exactRecord(
      snapshot.identity,
      IDENTITY_KEYS,
      "three-wave spell snapshot.identity",
    );
    if (identity.fixture !== "three-wave-traveling-spell-question-v1") {
      throw new TypeError("three-wave spell snapshot fixture is unsupported");
    }
    safeInteger(snapshot.tick, "three-wave spell snapshot.tick", 0, MAX_TICK);
    const encounter = new ThreeWaveTravelingSpellEncounter(
      checkedSetup(identity.setup),
    );
    encounter.stepMany(snapshot.tick);
    return encounter;
  }
}
