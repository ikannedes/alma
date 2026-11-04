import { createCardCatalog } from "../schema.js";

const DEFINITIONS = [{
  areaDamageRadiusMillitiles: null,
  components: [],
  cost: 4,
  count: 1,
  damage: 160,
  deployTimeTicks: 60,
  displayName: "Cinder Reliquary",
  firstHitTicks: 60,
  hitSpeedTicks: 120,
  hitpoints: 1200,
  id: "cinder-reliquary",
  kind: "structure",
  movementMillitilesPerSecond: 0,
  rangeMillitiles: 4500,
  rarity: "uncommon",
  sightRangeMillitiles: 5500,
  targetMode: "ground",
}];

const PROVENANCE = Object.freeze({
  accessed: "2026-07-30",
  document: "SOURCES.md",
  location: "Known limitations",
  statement:
    "Card abilities, including death damage and crown-tower damage multipliers, are outside the common schema.",
});
const QUESTION_VALUES = Object.freeze({
  trigger: "one instantaneous area-damage trigger for each effect-bearing death",
  radius: 2000,
  damage: 200,
  eligibility:
    "living targetable enemy ground troops, structures, and crown towers",
  cause:
    "the FIFO request supplying the final positive applied damage owns the death; zero and post-lethal overkill requests do not contribute; only combat-damage deaths trigger",
  sameTickOrder:
    "commands by tick/input sequence; damage wave; deaths by id; FIFO triggers; hits by id",
  chain: "new effect-bearing deaths append to the same-tick FIFO trigger queue",
  selfSourceInclusion: "dead source and all friendly entities are excluded",
  towerModifier: Object.freeze({ denominator: 100, numerator: 35 }),
  recursion: "each entity may enqueue its death trigger exactly once",
  cap: Object.freeze({
    commands: 64,
    entities: 64,
    events: 16384,
    snapshotBytes: 262144,
    tick: 1024,
    triggerQueue: 64,
  }),
});

const MAX_COMMANDS = QUESTION_VALUES.cap.commands;
const MAX_ENTITIES = QUESTION_VALUES.cap.entities;
const MAX_EVENTS = QUESTION_VALUES.cap.events;
const MAX_SNAPSHOT_BYTES = QUESTION_VALUES.cap.snapshotBytes;
const MAX_TICK = QUESTION_VALUES.cap.tick;
const MAX_QUEUE = QUESTION_VALUES.cap.triggerQueue;
const ENTITY_KEYS = [
  "alive",
  "deathEffect",
  "id",
  "kind",
  "layer",
  "maxHealth",
  "owner",
  "position",
  "radius",
  "targetable",
];
const COMMAND_KEYS = ["amount", "cause", "sourceId", "targetId", "tick"];
const SETUP_KEYS = ["commands", "entities"];
const SNAPSHOT_KEYS = ["identity", "tick", "version"];
const KINDS = new Set(["crown-tower", "structure", "troop"]);
const LAYERS = new Set(["air", "ground"]);
const OWNERS = new Set(["north", "south"]);
const CAUSES = new Set(["combat-damage", "expiry"]);

function deepFreeze(value) {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

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
    Array.from({ length: value.length }, (_, index) => index).some((index) =>
      !descriptors[index]?.enumerable ||
      !Object.hasOwn(descriptors[index], "value")
    )
  ) {
    throw new TypeError(`${label} must contain only dense data properties`);
  }
  return Array.from({ length: value.length }, (_, index) =>
    descriptors[index].value
  );
}

function safeInteger(value, minimum, label) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new TypeError(`${label} must be a safe integer >= ${minimum}`);
  }
  return value;
}

function checkedPosition(value, label) {
  const position = exactRecord(value, ["x", "y"], label);
  return {
    x: safeInteger(position.x, -Number.MAX_SAFE_INTEGER, `${label}.x`),
    y: safeInteger(position.y, -Number.MAX_SAFE_INTEGER, `${label}.y`),
  };
}

function checkedEntity(value, index) {
  const label = `death entity ${index}`;
  const entity = exactRecord(value, ENTITY_KEYS, label);
  safeInteger(entity.id, 1, `${label}.id`);
  safeInteger(entity.maxHealth, 1, `${label}.maxHealth`);
  safeInteger(entity.radius, 0, `${label}.radius`);
  if (typeof entity.alive !== "boolean" ||
      typeof entity.deathEffect !== "boolean" ||
      typeof entity.targetable !== "boolean") {
    throw new TypeError(`${label} flags must be booleans`);
  }
  if (!KINDS.has(entity.kind) || !LAYERS.has(entity.layer) ||
      !OWNERS.has(entity.owner)) {
    throw new TypeError(`${label} classification is invalid`);
  }
  if (entity.kind === "crown-tower" && entity.layer !== "ground") {
    throw new TypeError(`${label} crown tower must be ground`);
  }
  return {
    alive: entity.alive,
    deathEffect: entity.deathEffect,
    id: entity.id,
    kind: entity.kind,
    layer: entity.layer,
    maxHealth: entity.maxHealth,
    owner: entity.owner,
    position: checkedPosition(entity.position, `${label}.position`),
    radius: entity.radius,
    targetable: entity.targetable,
  };
}

function checkedEntities(value) {
  const entities = denseArray(value, MAX_ENTITIES, "death entities")
    .map(checkedEntity)
    .sort((left, right) => left.id - right.id);
  if (entities.length === 0) {
    throw new TypeError("death entities must not be empty");
  }
  for (let index = 1; index < entities.length; index += 1) {
    if (entities[index - 1].id === entities[index].id) {
      throw new TypeError("death entities must have unique ids");
    }
  }
  return entities;
}

function checkedCommands(value, ids) {
  const commands = denseArray(value, MAX_COMMANDS, "death commands")
    .map((entry, index) => {
      const label = `death command ${index}`;
      const command = exactRecord(entry, COMMAND_KEYS, label);
      safeInteger(command.amount, 0, `${label}.amount`);
      safeInteger(command.tick, 0, `${label}.tick`);
      if (command.tick >= MAX_TICK) {
        throw new RangeError(`${label}.tick exceeds the encounter bound`);
      }
      if (!CAUSES.has(command.cause)) {
        throw new TypeError(`${label}.cause is invalid`);
      }
      if (command.sourceId !== null) {
        safeInteger(command.sourceId, 1, `${label}.sourceId`);
      }
      safeInteger(command.targetId, 1, `${label}.targetId`);
      if (!ids.has(command.targetId)) {
        throw new TypeError(`${label}.targetId is unknown`);
      }
      return {
        amount: command.amount,
        cause: command.cause,
        sequence: index,
        sourceId: command.sourceId,
        targetId: command.targetId,
        tick: command.tick,
      };
    })
    .sort((left, right) => left.tick - right.tick || left.sequence - right.sequence)
    .map(({ sequence: _sequence, ...command }) => command);
  const signatures = new Set();
  for (const command of commands) {
    const signature = canonicalJson(command);
    if (signatures.has(signature)) {
      throw new TypeError("death commands must not contain duplicates");
    }
    signatures.add(signature);
  }
  return commands;
}

function checkedSetup(value) {
  const setup = exactRecord(value, SETUP_KEYS, "death setup");
  const entities = checkedEntities(setup.entities);
  const ids = new Set(entities.map(({ id }) => id));
  return {
    commands: checkedCommands(setup.commands, ids),
    entities,
  };
}

function questionRecord(key, value) {
  return deepFreeze({
    authoritative: false,
    confidence: "unverified",
    disposition: "question",
    key,
    provenance: clone(PROVENANCE),
    value: clone(value),
  });
}

function defaultEntities() {
  return [
    {
      alive: true,
      deathEffect: true,
      id: 10,
      kind: "structure",
      layer: "ground",
      maxHealth: 100,
      owner: "south",
      position: { x: 0, y: 0 },
      radius: 500,
      targetable: true,
    },
    {
      alive: true,
      deathEffect: false,
      id: 20,
      kind: "troop",
      layer: "ground",
      maxHealth: 500,
      owner: "north",
      position: { x: 2500, y: 0 },
      radius: 0,
      targetable: true,
    },
  ];
}

function defaultCommands() {
  return [{
    amount: 100,
    cause: "combat-damage",
    sourceId: 20,
    targetId: 10,
    tick: 0,
  }];
}

function squaredDistance(left, right) {
  const dx = BigInt(left.x) - BigInt(right.x);
  const dy = BigInt(left.y) - BigInt(right.y);
  return dx * dx + dy * dy;
}

function overlaps(source, target) {
  const reach =
    BigInt(QUESTION_VALUES.radius) +
    BigInt(source.radius) +
    BigInt(target.radius);
  return squaredDistance(source.position, target.position) <= reach * reach;
}

function effectDamage(target) {
  if (target.kind !== "crown-tower") return QUESTION_VALUES.damage;
  const modifier = QUESTION_VALUES.towerModifier;
  return Number(
    BigInt(QUESTION_VALUES.damage) * BigInt(modifier.numerator) /
      BigInt(modifier.denominator),
  );
}

export function createDeathEffectsCatalog() {
  return createCardCatalog(DEFINITIONS);
}

export function createDeathEffectsQuestions(...args) {
  if (args.length !== 0) {
    throw new TypeError("death questions do not accept overrides");
  }
  return deepFreeze(Object.fromEntries(
    Object.entries(QUESTION_VALUES).map(([key, value]) => [
      key,
      questionRecord(key, value),
    ]),
  ));
}

export function createDeathEffectsFixture(
  entities = defaultEntities(),
  commands = defaultCommands(),
  ...extra
) {
  if (extra.length !== 0) {
    throw new TypeError("death fixture received extra arguments");
  }
  return clone(checkedSetup({ commands, entities }));
}

export class DeathEffectsEncounter {
  #commands;
  #commandIndex = 0;
  #entities;
  #health = new Map();
  #history = [];
  #setup;
  #terminal = false;
  #tick = 0;
  #triggered = new Set();

  constructor(setup = createDeathEffectsFixture()) {
    this.#setup = checkedSetup(setup);
    this.#commands = this.#setup.commands;
    this.#entities = this.#setup.entities;
    for (const entity of this.#entities) {
      this.#health.set(entity.id, entity.alive ? entity.maxHealth : 0);
    }
    if (this.#commands.length === 0) this.#terminal = true;
  }

  get replay() {
    return clone(this.#history);
  }

  get state() {
    return clone({
      entities: this.#entities.map((entity) => ({
        alive: this.#health.get(entity.id) > 0,
        hitpoints: this.#health.get(entity.id),
        id: entity.id,
      })),
      terminal: this.#terminal,
      tick: this.#tick,
      triggeredIds: [...this.#triggered].sort((a, b) => a - b),
    });
  }

  step() {
    if (this.#terminal) return [];
    const tick = this.#tick;
    const commands = [];
    while (
      this.#commandIndex < this.#commands.length &&
      this.#commands[this.#commandIndex].tick === tick
    ) {
      commands.push(this.#commands[this.#commandIndex]);
      this.#commandIndex += 1;
    }

    const events = [];
    if (commands.length > 0) {
      const hits = commands.map((command) => ({
        amount: command.cause === "expiry"
          ? this.#health.get(command.targetId)
          : command.amount,
        cause: command.cause,
        sourceId: command.sourceId,
        targetId: command.targetId,
      }));
      const deaths = this.#applyWave(hits, tick, "command", null, events);
      const queue = deaths
        .filter(({ cause, entity }) =>
          cause === "combat-damage" &&
          entity.deathEffect &&
          !this.#triggered.has(entity.id)
        )
        .map(({ entity }) => entity.id);
      this.#drainTriggers(queue, tick, events);
    }

    if (this.#history.length + events.length > MAX_EVENTS) {
      throw new RangeError("death encounter event bound exceeded");
    }
    this.#history.push(...events);
    this.#tick += 1;
    if (this.#commandIndex === this.#commands.length) this.#terminal = true;
    return clone(events);
  }

  stepMany(count) {
    safeInteger(count, 0, "death step count");
    if (count > MAX_TICK) throw new RangeError("death step count exceeds bound");
    const events = [];
    for (let index = 0; index < count && !this.#terminal; index += 1) {
      events.push(...this.step());
    }
    return clone(events);
  }

  run() {
    while (!this.#terminal) this.step();
    return this.replay;
  }

  serialize() {
    return canonicalJson({
      identity: {
        commands: this.#setup.commands,
        entities: this.#setup.entities,
      },
      tick: this.#tick,
      version: 1,
    });
  }

  static restore(serialized) {
    if (typeof serialized !== "string") {
      throw new TypeError("death snapshot must be a string");
    }
    if (serialized.length > MAX_SNAPSHOT_BYTES) {
      throw new RangeError("death snapshot exceeds its size bound");
    }
    let raw;
    try {
      raw = JSON.parse(serialized);
    } catch {
      throw new TypeError("death snapshot must be valid JSON");
    }
    if (canonicalJson(raw) !== serialized) {
      throw new TypeError("death snapshot must use canonical encoding");
    }
    const snapshot = exactRecord(raw, SNAPSHOT_KEYS, "death snapshot");
    if (snapshot.version !== 1) {
      throw new TypeError("death snapshot version is unsupported");
    }
    safeInteger(snapshot.tick, 0, "death snapshot.tick");
    if (snapshot.tick > MAX_TICK) {
      throw new RangeError("death snapshot.tick exceeds bound");
    }
    const encounter = new DeathEffectsEncounter(snapshot.identity);
    encounter.stepMany(snapshot.tick);
    if (encounter.#tick !== snapshot.tick) {
      throw new TypeError("death snapshot contains post-terminal time");
    }
    return encounter;
  }

  #entity(id) {
    return this.#entities.find((entity) => entity.id === id);
  }

  #applyWave(hits, tick, origin, triggerId, events) {
    const totals = new Map();
    const hitsByTarget = new Map();
    for (const hit of hits) {
      if (this.#health.get(hit.targetId) === 0) continue;
      totals.set(
        hit.targetId,
        (totals.get(hit.targetId) ?? 0n) + BigInt(hit.amount),
      );
      if (!hitsByTarget.has(hit.targetId)) hitsByTarget.set(hit.targetId, []);
      hitsByTarget.get(hit.targetId).push(hit);
      events.push({
        amount: hit.amount,
        cause: hit.cause,
        origin,
        sourceId: hit.sourceId,
        targetId: hit.targetId,
        tick,
        triggerId,
        type: "damage-requested",
      });
    }
    const deaths = [];
    for (const targetId of [...totals.keys()].sort((a, b) => a - b)) {
      const before = this.#health.get(targetId);
      const requested = totals.get(targetId);
      const applied = Number(requested > BigInt(before) ? BigInt(before) : requested);
      const after = before - applied;
      let remaining = BigInt(before);
      let cause = null;
      for (const hit of hitsByTarget.get(targetId)) {
        if (remaining === 0n || hit.amount === 0) continue;
        const contribution = BigInt(hit.amount) < remaining
          ? BigInt(hit.amount)
          : remaining;
        if (contribution === 0n) continue;
        remaining -= contribution;
        if (remaining === 0n) cause = hit.cause;
      }
      this.#health.set(targetId, after);
      events.push({
        applied,
        cause,
        healthAfter: after,
        healthBefore: before,
        origin,
        requested: requested.toString(),
        targetId,
        tick,
        triggerId,
        type: "damage-applied",
      });
      if (before > 0 && after === 0) {
        const entity = this.#entity(targetId);
        deaths.push({ cause, entity });
        events.push({
          cause,
          targetId,
          tick,
          triggerId,
          type: "death",
        });
      }
    }
    return deaths;
  }

  #drainTriggers(queue, tick, events) {
    while (queue.length > 0) {
      if (queue.length > MAX_QUEUE) {
        throw new RangeError("death trigger queue bound exceeded");
      }
      const sourceId = queue.shift();
      if (this.#triggered.has(sourceId)) continue;
      this.#triggered.add(sourceId);
      const source = this.#entity(sourceId);
      events.push({
        queueIndex: this.#triggered.size,
        sourceId,
        tick,
        type: "death-triggered",
      });
      const targets = this.#entities
        .filter((target) =>
          this.#health.get(target.id) > 0 &&
          target.targetable &&
          target.owner !== source.owner &&
          target.layer === "ground" &&
          overlaps(source, target)
        )
        .sort((left, right) => left.id - right.id);
      const deaths = this.#applyWave(
        targets.map((target) => ({
          amount: effectDamage(target),
          cause: "combat-damage",
          sourceId,
          targetId: target.id,
        })),
        tick,
        "death-effect",
        sourceId,
        events,
      );
      for (const { cause, entity } of deaths) {
        if (
          cause === "combat-damage" &&
          entity.deathEffect &&
          !this.#triggered.has(entity.id)
        ) {
          queue.push(entity.id);
        }
      }
    }
  }
}
