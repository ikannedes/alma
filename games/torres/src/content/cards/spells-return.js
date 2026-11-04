import {
  InstantRadiusSpellEncounter,
  createInstantSpellCatalog,
  createInstantSpellFixture,
} from "./spells-instant.js";
import {
  createTravelingLineSpellCatalog,
  createTravelingLineSpellFixture,
} from "./spells-travel-line.js";
import {
  ReturnEncounter,
  createReturnQuestionFixture,
  createReturnSpecialFixture,
} from "./special-projectiles-return.js";
import {
  appendCombatEffectEvent,
  appendCombatEffectRoot,
  combatEffectFeedSnapshot,
  createCombatEffectFeed,
  serializeCombatEffectFeed,
} from "../../sim/combat-effect-feed.js";

const SOURCE = "unsourced-returning-traveling-spell-composition";
const MAX_EVENTS = 16_384;
const MAX_SNAPSHOT_BYTES = 262_144;
const MAX_STEP_CHUNK = 128;
const MAX_TICK = 128;
const SNAPSHOT_KEYS = ["identity", "primitives", "tick", "version"];
const IDENTITY_KEYS = ["fixture", "setup"];
const INSTANT_DAMAGE = createInstantSpellCatalog()[0].damage;
const RETURN_DAMAGE = createReturnQuestionFixture().damagePerPass.value;
let returnContractCache;

const QUESTION_VALUES = Object.freeze({
  cancellationBoundary:
    "passed-return-primitive;death-or-interruption-through-launch-cancels;post-launch-projectile-continues",
  contactDamage:
    "each-new-leg-contact-delegates-one plain passed instant-damage application",
  contactGeometry:
    "passed-return-primitive-static-launch-snapshot-inclusive-finite-capsule",
  contactOrder:
    "forward-on-outbound;reverse-on-inbound;stable-target-id-ties",
  inboundStart: "first-inbound-contact-boundary-is-one-tick-after-turn",
  movingTargetPolicy: "cast-time-position-snapshot",
  repeatHitPolicy: "at-most-once-per-target-per-leg;repeat-on-return-allowed",
  sameBoundaryOrder:
    "commands;effect-id;contact;damage;death;turn-or-complete",
  sourceDeathAfterCompletion: "no-retroactive-cancellation",
  sourceDeathAfterLaunch: "passed-return-primitive-launched-projectile-continues",
  targetDeathBoundary:
    "command-first-death-excludes-current-and-future-contact;earlier-damage-retained",
  timingComposition:
    "launch-leg-turn-and-completion-boundaries-are-the-passed-return-primitive",
  turnPolicy:
    "outbound-contacts-through-endpoint;turn-after-outbound;inbound-next-boundary",
  zeroDistancePolicy: "reject-cast-without-two-positive-duration-legs",
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

function safeCount(value, label, maximum) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new TypeError(`${label} must be a bounded non-negative safe integer`);
  }
  return value;
}

function checkedSetup(value) {
  const setup = createTravelingLineSpellFixture(value);
  for (const command of setup.commands) {
    if (command.type !== "cast") continue;
    const source = setup.sources.find(({ id }) => id === command.sourceId);
    if (
      source.position.x === command.center.x &&
      source.position.y === command.center.y
    ) {
      throw new RangeError("return spell requires a non-zero leg");
    }
    const aim = {
      x: command.center.x - source.position.x,
      y: command.center.y - source.position.y,
    };
    // The primitive owns projection validity, distance, launch, turn, and
    // completion timing. Construction here rejects spell setups that cannot
    // be represented by that exact causal contract.
    createReturnSpecialFixture([], aim, []);
    if (command.tick + primitiveContract().terminalTick > MAX_TICK) {
      throw new RangeError("return spell completion exceeds encounter bound");
    }
  }
  return setup;
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

function eligible(source, victim) {
  return (
    source.ownerId !== victim.ownerId &&
    victim.alive &&
    victim.targetable &&
    (victim.kind === "troop" || victim.kind === "structure")
  );
}

function primitiveHealth(health) {
  if (health <= INSTANT_DAMAGE) return RETURN_DAMAGE;
  if (health <= INSTANT_DAMAGE * 2) return RETURN_DAMAGE * 2;
  return RETURN_DAMAGE * 3;
}

function primitiveContract() {
  if (returnContractCache !== undefined) return clone(returnContractCache);
  const encounter = new ReturnEncounter(
    createReturnSpecialFixture([], { x: 1, y: 0 }, []),
  );
  encounter.run();
  const launch = encounter.replay.find(({ type }) => type === "return-launch");
  if (launch === undefined) {
    throw new TypeError("passed return primitive did not launch");
  }
  returnContractCache = {
    completeTick: encounter.replay.find(({ type }) =>
      type === "return-complete"
    ).tick,
    launchTick: launch.tick,
    origin: launch.origin,
    turnPoint: launch.turnPoint,
    turnTick: launch.turnTick,
    terminalTick: encounter.state.tick,
  };
  return clone(returnContractCache);
}

function translatedPosition(position, sourcePosition, primitiveOrigin) {
  return {
    x: primitiveOrigin.x + position.x - sourcePosition.x,
    y: primitiveOrigin.y + position.y - sourcePosition.y,
  };
}

function worldPosition(position, sourcePosition, primitiveOrigin) {
  return {
    x: sourcePosition.x + position.x - primitiveOrigin.x,
    y: sourcePosition.y + position.y - primitiveOrigin.y,
  };
}

function primitiveCommands(setup, effectId, cast, idMap, completeTick) {
  const commands = [];
  for (const command of setup.commands) {
    const tick = command.tick - cast.tick;
    if (tick < 0 || tick > completeTick) continue;
    if (command.type === "source-died" && command.sourceId === cast.sourceId) {
      commands.push({ targetId: null, tick, type: "kill-attacker" });
    } else if (
      command.type === "cancel-effect" &&
      command.effectId === effectId
    ) {
      commands.push({ targetId: null, tick, type: "interrupt-attacker" });
    } else if (command.type === "target-died" && idMap.has(command.targetId)) {
      commands.push({
        targetId: idMap.get(command.targetId),
        tick,
        type: "kill-target",
      });
    }
  }
  return commands.filter((command, index) =>
    commands.findIndex((candidate) =>
      candidate.tick === command.tick &&
      candidate.type === command.type &&
      candidate.targetId === command.targetId
    ) === index
  );
}

function createPrimitive(setup, state, cast, effectId) {
  const source = state.sources.find(({ id }) => id === cast.sourceId);
  const aim = {
    x: cast.center.x - source.position.x,
    y: cast.center.y - source.position.y,
  };
  const contract = primitiveContract();
  const victims = state.victims
    .filter((victim) => eligible(source, victim))
    .sort((left, right) => left.id - right.id);
  const idMap = new Map(victims.map((victim, index) => [victim.id, 201 + index]));
  const reverseIdMap = Object.fromEntries(
    [...idMap].map(([spellId, primitiveId]) => [primitiveId, spellId]),
  );
  const candidates = victims.map((victim) => ({
    alive: victim.alive,
    id: idMap.get(victim.id),
    kind: victim.kind,
    layer: victim.layer,
    maxHealth: primitiveHealth(victim.health),
    position: translatedPosition(
      victim.position,
      source.position,
      contract.origin,
    ),
    radius: victim.radius,
    targetable: victim.targetable,
  }));
  const primitiveSetup = createReturnSpecialFixture(
    candidates,
    aim,
    primitiveCommands(
      setup,
      effectId,
      cast,
      idMap,
      contract.completeTick,
    ),
  );
  const primitive = new ReturnEncounter(primitiveSetup);
  return {
    contract,
    effectId,
    primitiveSnapshot: primitive.serialize(),
    reverseIdMap,
    sourceId: source.id,
    sourcePosition: clone(source.position),
  };
}

function instantDamage(state, sourceId, victim) {
  const source = state.sources.find(({ id }) => id === sourceId);
  const encounter = new InstantRadiusSpellEncounter(createInstantSpellFixture({
    commands: [{
      center: clone(victim.position),
      id: 1,
      sourceId,
      targetId: null,
      tick: 0,
      type: "cast",
      variant: "plain",
    }],
    sources: [{ id: sourceId, ownerId: source.ownerId }],
    victims: [{
      combatTargetId: victim.combatTargetId,
      combatTargetMode: victim.combatTargetMode,
      health: victim.health,
      id: victim.id,
      kind: victim.kind,
      layer: victim.layer,
      ownerId: victim.ownerId,
      position: clone(victim.position),
      radius: victim.radius,
      targetable: true,
    }],
  }));
  const primitiveEvents = encounter.stepMany(3);
  const result = encounter.state.victims[0];
  victim.health = result.health;
  victim.alive = result.alive;
  return primitiveEvents.filter(({ type }) =>
    type === "spell-damage" || type === "spell-death"
  );
}

function applyCommand(state, setup, command, events) {
  if (command.type === "cast") {
    const source = state.sources.find(({ id }) => id === command.sourceId);
    if (!source.alive) {
      events.push({
        commandId: command.id,
        reason: "source-dead",
        sourceId: source.id,
        tick: state.tick,
        type: "return-launch-cancelled",
      });
      return;
    }
    if (state.nextEffectId === Number.MAX_SAFE_INTEGER) {
      throw new RangeError("return spell effect ID space is exhausted");
    }
    const effectId = state.nextEffectId;
    state.nextEffectId += 1;
    state.pending.push(createPrimitive(setup, state, command, effectId));
    return;
  }
  if (command.type === "source-died") {
    const source = state.sources.find(({ id }) => id === command.sourceId);
    if (source.alive) {
      source.alive = false;
      events.push({
        sourceId: source.id,
        tick: state.tick,
        type: "return-source-died",
      });
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
        type: "return-target-died",
      });
    }
    return;
  }
}

function mappedTargetId(effect, primitiveId) {
  return effect.reverseIdMap[primitiveId];
}

function translatePrimitiveEvent(state, effect, event, events) {
  const tick = state.tick;
  if (event.type === "return-hit") {
    const targetId = mappedTargetId(effect, event.targetId);
    const victim = state.victims.find(({ id }) => id === targetId);
    events.push({
      effectId: effect.effectId,
      leg: event.leg,
      orderNumerator: event.parameterNumerator,
      pass: event.pass,
      targetId,
      tick,
      type: "return-contact",
    });
    if (victim?.alive) {
      for (const damageEvent of instantDamage(state, effect.sourceId, victim)) {
        events.push({
          ...clone(damageEvent),
          effectId: effect.effectId,
          leg: event.leg,
          pass: event.pass,
          primitiveEffectId: damageEvent.effectId,
          tick,
          type: `return-${damageEvent.type}`,
        });
      }
    }
    return;
  }
  if (event.type === "return-damage" || event.type === "return-death") return;
  if (event.type === "return-launch") {
    events.push({
      completeTick: tick + event.completeTick - event.tick,
      effectId: effect.effectId,
      origin: clone(effect.sourcePosition),
      sourceId: effect.sourceId,
      tick,
      turn: worldPosition(
        event.turnPoint,
        effect.sourcePosition,
        event.origin,
      ),
      turnTick: tick + event.turnTick - event.tick,
      type: "return-launch",
    });
    return;
  }
  if (event.type === "return-turn") {
    events.push({
      effectId: effect.effectId,
      tick,
      turn: worldPosition(
        event.turnPoint,
        effect.sourcePosition,
        effect.contract.origin,
      ),
      type: "return-turn",
    });
    return;
  }
  if (event.type === "return-complete") {
    events.push({
      effectId: effect.effectId,
      inboundHitIds: event.inboundHitIds.map((id) => mappedTargetId(effect, id)),
      outboundHitIds: event.outboundHitIds.map((id) => mappedTargetId(effect, id)),
      reason: event.reason,
      tick,
      type: "return-complete",
    });
    return;
  }
  events.push({
    ...clone(event),
    effectId: effect.effectId,
    primitiveTargetId: event.targetId,
    targetId: event.targetId === 101
      ? effect.sourceId
      : mappedTargetId(effect, event.targetId),
    tick,
    type: `return-primitive-${event.type}`,
  });
}

function advance(state, setup) {
  if (state.tick >= MAX_TICK) return [];
  const events = [];
  while (setup.commands[state.commandIndex]?.tick === state.tick) {
    applyCommand(state, setup, setup.commands[state.commandIndex], events);
    state.commandIndex += 1;
  }
  for (const effect of state.pending.sort((a, b) => a.effectId - b.effectId)) {
    const primitive = ReturnEncounter.restore(effect.primitiveSnapshot);
    const primitiveEvents = primitive.step();
    effect.primitiveSnapshot = primitive.serialize();
    for (const event of primitiveEvents) {
      translatePrimitiveEvent(state, effect, event, events);
    }
  }
  if (state.history.length + events.length > MAX_EVENTS) {
    throw new RangeError("return spell replay exceeds its event bound");
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

export function createReturningSpellCatalog(...args) {
  if (args.length !== 0) {
    throw new TypeError("return spell catalog does not accept overrides");
  }
  return createTravelingLineSpellCatalog();
}

export function createReturningSpellQuestionRecords(...args) {
  if (args.length !== 0) {
    throw new TypeError("return spell questions do not accept overrides");
  }
  // Reading the passed primitive fixture here pins this composition to its
  // independently tested return-leg policy without importing reference data.
  // The primitive details refine the corresponding composition questions
  // rather than inventing a second record for the same three uncertainties.
  const primitive = createReturnQuestionFixture();
  const values = {
    ...QUESTION_VALUES,
    contactOrder: {
      composition: QUESTION_VALUES.contactOrder,
      primitive: primitive.eventOrderRule.value,
    },
    repeatHitPolicy: {
      composition: QUESTION_VALUES.repeatHitPolicy,
      primitive: primitive.oneHitPerLegRule.value,
    },
    turnPolicy: {
      composition: QUESTION_VALUES.turnPolicy,
      primitive: primitive.turnaroundTimingRule.value,
    },
  };
  return deepFreeze(Object.fromEntries(
    Object.entries(values).map(([key, value]) => [
      key,
      questionRecord(key, value),
    ]),
  ));
}

export function createReturningSpellFixture(value) {
  return clone(checkedSetup(value));
}

/**
 * A bounded outbound/turn/inbound traveling spell composition. It intentionally
 * does not implement waves, rolling collision, obstacles, animation, or audio.
 */
export class ReturningSpellEncounter {
  #setup;
  #state;
  #feed = createCombatEffectFeed();
  #feedRoots = new Map();

  constructor(setup) {
    this.#setup = checkedSetup(setup);
    this.#state = initialState(this.#setup);
  }

  get replay() {
    return clone(this.#state.history);
  }

  get combatEffectFeed() {
    return combatEffectFeedSnapshot(this.#feed);
  }

  get effectFeed() {
    return this.combatEffectFeed;
  }

  get visualFeed() {
    return this.combatEffectFeed;
  }

  combatEffectFeedBytes() {
    return serializeCombatEffectFeed(this.#feed);
  }

  fork() {
    return ReturningSpellEncounter.restore(this.serialize());
  }

  get state() {
    return clone(this.#state);
  }

  step() {
    return this.stepMany(1);
  }

  stepMany(count) {
    safeCount(count, "return spell step count", MAX_STEP_CHUNK);
    if (count > MAX_TICK - this.#state.tick) {
      throw new RangeError("return spell step count exceeds encounter bound");
    }
    const candidate = clone(this.#state);
    const candidateFeed = this.#feed.fork();
    const candidateRoots = new Map([...this.#feedRoots].map(([effectId, root]) => [
      effectId, { ...root },
    ]));
    const events = [];
    for (let index = 0; index < count; index += 1) {
      events.push(...advance(candidate, this.#setup));
    }
    this.#observeVisualEvents(candidateFeed, candidateRoots, events);
    this.#state = candidate;
    this.#feed = candidateFeed;
    this.#feedRoots = candidateRoots;
    return clone(events);
  }

  run() {
    return this.stepMany(MAX_TICK - this.#state.tick);
  }

  serialize() {
    const serialized = canonicalJson({
      identity: {
        fixture: "returning-traveling-spell-question-v1",
        setup: this.#setup,
      },
      primitives: this.#state.pending.map(({ effectId, primitiveSnapshot }) => ({
        effectId,
        snapshot: primitiveSnapshot,
      })),
      tick: this.#state.tick,
      version: 1,
    });
    if (Buffer.byteLength(serialized, "utf8") > MAX_SNAPSHOT_BYTES) {
      throw new RangeError("return spell snapshot exceeds its byte bound");
    }
    return serialized;
  }

  static restore(serialized) {
    if (typeof serialized !== "string") {
      throw new TypeError("return spell snapshot must be a string");
    }
    if (Buffer.byteLength(serialized, "utf8") > MAX_SNAPSHOT_BYTES) {
      throw new RangeError("return spell snapshot exceeds its byte bound");
    }
    let value;
    try {
      value = JSON.parse(serialized);
    } catch {
      throw new TypeError("return spell snapshot must be valid JSON");
    }
    if (canonicalJson(value) !== serialized) {
      throw new TypeError(
        "return spell snapshot must be canonical duplicate-free JSON",
      );
    }
    const snapshot = exactRecord(value, SNAPSHOT_KEYS, "return spell snapshot");
    if (snapshot.version !== 1) {
      throw new TypeError("return spell snapshot version is unsupported");
    }
    const identity = exactRecord(
      snapshot.identity,
      IDENTITY_KEYS,
      "return spell snapshot.identity",
    );
    if (identity.fixture !== "returning-traveling-spell-question-v1") {
      throw new TypeError("return spell snapshot fixture is unsupported");
    }
    safeCount(snapshot.tick, "return spell snapshot.tick", MAX_TICK);
    if (
      !Array.isArray(snapshot.primitives) ||
      Object.getPrototypeOf(snapshot.primitives) !== Array.prototype
    ) {
      throw new TypeError("return spell snapshot.primitives must be an array");
    }
    for (const [index, entry] of snapshot.primitives.entries()) {
      const primitive = exactRecord(
        entry,
        ["effectId", "snapshot"],
        `return spell snapshot primitive ${index}`,
      );
      safeCount(
        primitive.effectId,
        `return spell snapshot primitive ${index}.effectId`,
        Number.MAX_SAFE_INTEGER,
      );
      ReturnEncounter.restore(primitive.snapshot);
    }
    const encounter = new ReturningSpellEncounter(identity.setup);
    encounter.stepMany(snapshot.tick);
    const expected = encounter.#state.pending.map(
      ({ effectId, primitiveSnapshot }) => ({
        effectId,
        snapshot: primitiveSnapshot,
      }),
    );
    if (canonicalJson(snapshot.primitives) !== canonicalJson(expected)) {
      throw new TypeError(
        "return spell snapshot primitive state is non-causal",
      );
    }
    return encounter;
  }

  #observeVisualEvents(feed, roots, events) {
    for (const event of events) {
      if (event.type === "return-launch") {
        const root = appendCombatEffectRoot(feed, {
          direction: "return",
          effectId: event.effectId,
          from: event.origin,
          impactTick: event.completeTick,
          projectileId: null,
          radius: createReturnQuestionFixture().collisionWidthMillitiles.value,
          segments: [],
          sequence: event.effectId,
          sourceId: event.sourceId,
          tick: event.tick,
          to: event.turn,
          type: "projectile",
        });
        roots.set(event.effectId, { lastEventId: root.eventId, rootId: root.rootId });
        continue;
      }
      const root = event.effectId === undefined ? null : roots.get(event.effectId);
      if (root === null || root === undefined) continue;
      if (event.type === "return-turn") {
        const child = appendCombatEffectEvent(feed, {
          parentId: root.lastEventId,
          payload: { point: event.turn },
          phase: "turn",
          rootId: root.rootId,
          tick: event.tick,
          type: "projectile",
        });
        root.lastEventId = child.eventId;
      } else if (event.type === "return-contact") {
        const victim = this.#state.victims.find(({ id }) => id === event.targetId);
        const child = appendCombatEffectEvent(feed, {
          parentId: root.lastEventId,
          payload: {
            point: victim?.position ?? { x: 0, y: 0 },
            status: "contact",
            subId: null,
            targetId: event.targetId,
          },
          phase: "contact",
          rootId: root.rootId,
          tick: event.tick,
          type: "projectile",
        });
        root.lastEventId = child.eventId;
      } else if (event.type === "return-spell-damage") {
        const child = appendCombatEffectEvent(feed, {
          parentId: root.lastEventId,
          payload: {
            amount: event.amount,
            currentHealthAfter: event.healthAfter,
            currentHealthBefore: event.healthBefore,
            targetId: event.targetId,
          },
          phase: "damage",
          rootId: root.rootId,
          tick: event.tick,
          type: "projectile",
        });
        root.lastEventId = child.eventId;
      } else if (event.type === "return-spell-death") {
        const child = appendCombatEffectEvent(feed, {
          parentId: root.lastEventId,
          payload: { targetId: event.targetId },
          phase: "death",
          rootId: root.rootId,
          tick: event.tick,
          type: "projectile",
        });
        root.lastEventId = child.eventId;
      } else if (event.type === "return-complete") {
        const reason = event.reason === "returned-to-origin" ? "complete" : event.reason;
        const child = appendCombatEffectEvent(feed, {
          parentId: root.lastEventId,
          payload: { reason },
          phase: "close",
          rootId: root.rootId,
          tick: event.tick,
          type: "projectile",
        });
        root.lastEventId = child.eventId;
      }
    }
  }
}
