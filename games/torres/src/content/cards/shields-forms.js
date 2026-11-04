import { createCardCatalog } from "../schema.js";

const DEFINITIONS = [
  {
    id: "railward",
    displayName: "Railward",
    cost: 5,
    kind: "unit",
    rarity: "special",
    hitpoints: 892,
    damage: 212,
    hitSpeedTicks: 60,
    firstHitTicks: 24,
    deployTimeTicks: 60,
    rangeMillitiles: 5500,
    sightRangeMillitiles: 6000,
    movementMillitilesPerSecond: 1000,
    targetMode: "ground",
    count: 1,
    areaDamageRadiusMillitiles: null,
    components: [],
  },
];

const FIXTURE_ID = "railward-shield-form-v1";
const ENTITY_ID = 1;
const MAX_COMMANDS = 64;
const MAX_DAMAGE = 1_000_000;
const MAX_SNAPSHOT_BYTES = 8_192;
const MAX_TICK = 1_000_000;
const SNAPSHOT_KEYS = ["commands", "fixture", "version"];
const DAMAGE_COMMAND_KEYS = ["amount", "type"];
const ADVANCE_COMMAND_KEYS = ["ticks", "type"];

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

function denseArray(value, maximumLength, label) {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > maximumLength
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

function boundedInteger(value, label, minimum, maximum) {
  if (
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new TypeError(
      `${label} must be a safe integer from ${minimum} through ${maximum}`,
    );
  }
}

function checkedCommand(value, index = null) {
  const label = index === null
    ? "shield-form command"
    : `shield-form command ${index}`;
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
  const typeDescriptor = Object.getOwnPropertyDescriptor(value, "type");
  if (
    typeDescriptor === undefined ||
    !typeDescriptor.enumerable ||
    !Object.hasOwn(typeDescriptor, "value")
  ) {
    throw new TypeError(`${label}.type must be an enumerable data property`);
  }
  if (typeDescriptor.value === "damage") {
    const command = exactRecord(value, DAMAGE_COMMAND_KEYS, label);
    boundedInteger(command.amount, `${label}.amount`, 1, MAX_DAMAGE);
    return { amount: command.amount, type: "damage" };
  }
  if (typeDescriptor.value === "advance") {
    const command = exactRecord(value, ADVANCE_COMMAND_KEYS, label);
    boundedInteger(command.ticks, `${label}.ticks`, 1, MAX_TICK);
    return { ticks: command.ticks, type: "advance" };
  }
  throw new TypeError(`${label}.type is unsupported`);
}

/**
 * Returns the original common-schema definition used by this question
 * fixture. The definition does not encode its shield or stationary form.
 */
export function createShieldFormCatalog() {
  return createCardCatalog(DEFINITIONS);
}

/**
 * A deliberately narrow, deterministic shield-break question fixture.
 *
 * It models one mobile entity becoming one stationary structure. It does not
 * claim generic shield composition, simultaneous damage batches, revival,
 * placement, retargeting, visuals, or attack-cycle continuity through the
 * transition. In particular, only sequential commands have an ordering.
 */
export class ShieldFormEncounter {
  #bodyCurrent = 892;
  #commands = [];
  #dead = false;
  #events = [];
  #form = "mobile";
  #shieldCurrent = 892;
  #tick = 0;

  constructor(...setup) {
    if (setup.length !== 0) {
      throw new TypeError("shield-form encounter accepts no custom setup");
    }
  }

  get replay() {
    return clone(this.#events);
  }

  get state() {
    const card = createShieldFormCatalog()[0];
    return clone({
      body: {
        currentHealth: this.#bodyCurrent,
        maxHealth: card.hitpoints,
      },
      combat: {
        areaDamageRadiusMillitiles: card.areaDamageRadiusMillitiles,
        count: card.count,
        damage: card.damage,
        deployTimeTicks: card.deployTimeTicks,
        firstHitTicks: card.firstHitTicks,
        hitSpeedTicks: card.hitSpeedTicks,
        rangeMillitiles: card.rangeMillitiles,
        sightRangeMillitiles: card.sightRangeMillitiles,
        targetMode: card.targetMode,
      },
      dead: this.#dead,
      entityId: ENTITY_ID,
      form: this.#form,
      kind: this.#form === "mobile" ? "unit" : "structure",
      movementMillitilesPerSecond: this.#form === "mobile"
        ? card.movementMillitilesPerSecond
        : 0,
      shield: {
        currentHealth: this.#shieldCurrent,
        maxHealth: card.hitpoints,
      },
      tick: this.#tick,
    });
  }

  command(value) {
    const command = checkedCommand(value);
    if (this.#commands.length >= MAX_COMMANDS) {
      throw new RangeError("shield-form command limit exceeded");
    }
    if (
      command.type === "advance" &&
      command.ticks > MAX_TICK - this.#tick
    ) {
      throw new RangeError("shield-form tick limit exceeded");
    }

    const events = command.type === "damage"
      ? this.#applyDamage(command.amount)
      : this.#applyAdvance(command.ticks);
    const orderedEvents = events.map((event, index) => ({
      ...event,
      sequence: this.#events.length + index + 1,
    }));
    this.#commands.push(command);
    this.#events.push(...orderedEvents);
    return clone(orderedEvents);
  }

  damage(amount) {
    return this.command({ amount, type: "damage" });
  }

  advanceTicks(ticks) {
    return this.command({ ticks, type: "advance" });
  }

  serialize() {
    const serialized = canonicalJson({
      commands: this.#commands,
      fixture: FIXTURE_ID,
      version: 1,
    });
    if (serialized.length > MAX_SNAPSHOT_BYTES) {
      throw new RangeError("shield-form snapshot exceeds its size bound");
    }
    return serialized;
  }

  static restore(serialized) {
    if (typeof serialized !== "string") {
      throw new TypeError("shield-form snapshot must be a string");
    }
    if (serialized.length > MAX_SNAPSHOT_BYTES) {
      throw new RangeError("shield-form snapshot exceeds its size bound");
    }
    let parsed;
    try {
      parsed = JSON.parse(serialized);
    } catch {
      throw new TypeError("shield-form snapshot must be valid JSON");
    }
    const snapshot = exactRecord(
      parsed,
      SNAPSHOT_KEYS,
      "shield-form snapshot",
    );
    if (snapshot.fixture !== FIXTURE_ID || snapshot.version !== 1) {
      throw new TypeError("shield-form snapshot identity is unsupported");
    }
    const commands = denseArray(
      snapshot.commands,
      MAX_COMMANDS,
      "shield-form snapshot commands",
    ).map(checkedCommand);
    const encounter = new ShieldFormEncounter();
    for (const command of commands) encounter.command(command);
    if (encounter.serialize() !== canonicalJson({
      commands,
      fixture: FIXTURE_ID,
      version: 1,
    })) {
      throw new TypeError("shield-form snapshot is not canonical");
    }
    return encounter;
  }

  #applyAdvance(ticks) {
    this.#tick += ticks;
    return [{
      tick: this.#tick,
      ticks,
      type: "time-advanced",
    }];
  }

  #applyDamage(amount) {
    if (this.#dead) {
      return [{
        amount,
        reason: "dead",
        tick: this.#tick,
        type: "damage-no-op",
      }];
    }
    if (this.#form === "mobile") {
      const before = this.#shieldCurrent;
      const applied = Math.min(before, amount);
      this.#shieldCurrent -= applied;
      const events = [{
        applied,
        currentHealth: this.#shieldCurrent,
        discardedOverflow: amount - applied,
        incoming: amount,
        tick: this.#tick,
        type: "shield-damage",
      }];
      if (this.#shieldCurrent === 0) {
        this.#form = "stationary";
        events.push(
          {
            tick: this.#tick,
            type: "shield-break",
          },
          {
            from: "mobile",
            tick: this.#tick,
            to: "stationary",
            type: "form-transition",
          },
        );
      }
      return events;
    }

    const before = this.#bodyCurrent;
    this.#bodyCurrent = Math.max(0, before - amount);
    const events = [{
      amount,
      currentHealth: this.#bodyCurrent,
      previousHealth: before,
      tick: this.#tick,
      type: "body-damage",
    }];
    if (this.#bodyCurrent === 0) {
      this.#dead = true;
      events.push({
        entityId: ENTITY_ID,
        tick: this.#tick,
        type: "death",
      });
    }
    return events;
  }
}
