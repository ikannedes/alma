import {
  DECK_MAX_PLAY_COMMANDS,
  DeckCycle,
} from "../../sim/deck.js";
import { ELIXIR_CAPACITY } from "../../sim/elixir.js";

export const COPY_CARD_RULE_VERSION = 1;
export const COPY_CARD_MAX_TICK = 1_000_000;

const FIXTURE = "previous-card-copy-v1";
const MAX_LEVEL = 15;
const MAX_SNAPSHOT_BYTES = 2_000_000;
const UTF8_ENCODER = new TextEncoder();
const SETUP_KEYS = ["cards", "copyCardId", "deck", "seed"];
const CARD_KEYS = ["cost", "excludedFromCopy", "id", "level"];
const COMMAND_KEYS = ["cardId", "tick"];
const SNAPSHOT_KEYS = ["commands", "fixture", "setup", "tick", "version"];

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/**
 * The comparison corpus has no authoritative record for these policies.
 * Each is deliberately isolated so later footage or a stronger source can
 * replace one decision without silently changing the others.
 */
export const PREVIOUS_CARD_COPY_QUESTIONS = deepFreeze([
  {
    confidence: "absent",
    id: "copy-cost-increment",
    policy: "copied effective cost is the copied card cost plus one",
    status: "QUESTION",
  },
  {
    confidence: "absent",
    id: "copy-cost-cap",
    policy: `copied effective cost is capped at ${ELIXIR_CAPACITY}`,
    status: "QUESTION",
  },
  {
    confidence: "absent",
    id: "copy-level-increment",
    policy: "copied effective level is the previous effective level plus one",
    status: "QUESTION",
  },
  {
    confidence: "absent",
    id: "copy-level-cap",
    policy: `copied effective level is capped at ${MAX_LEVEL}`,
    status: "QUESTION",
  },
  {
    confidence: "absent",
    id: "copy-history-selection",
    policy: "previous means the latest accepted non-copy card",
    status: "QUESTION",
  },
  {
    confidence: "absent",
    id: "copy-history-after-copy",
    policy: "an accepted copy does not replace the previous eligible card",
    status: "QUESTION",
  },
  {
    confidence: "absent",
    id: "copy-rejection-cycle",
    policy: "empty or excluded history rejects atomically without cycling",
    status: "QUESTION",
  },
  {
    confidence: "absent",
    id: "copy-exclusions",
    policy: "copy identity and caller-declared excluded cards are ineligible",
    status: "QUESTION",
  },
  {
    confidence: "absent",
    id: "copy-same-tick-order",
    policy: "same-tick plays resolve in scheduling sequence order",
    status: "QUESTION",
  },
  {
    confidence: "absent",
    id: "copy-form-semantics",
    policy: "copying selects card data, not a deployed shield or form state",
    status: "QUESTION",
  },
]);

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

function utf8ByteLength(value) {
  return UTF8_ENCODER.encode(value).byteLength;
}

function exactRecord(value, keys, label) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (
      Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null
    ) ||
    Object.getOwnPropertySymbols(value).length !== 0
  ) {
    throw new TypeError(`${label} must be a plain data object`);
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
    Object.getPrototypeOf(value) !== Array.prototype
  ) {
    throw new TypeError(`${label} must be a plain array`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const length = descriptors.length?.value;
  if (
    !Number.isSafeInteger(length) ||
    length < 0 ||
    length > maximum ||
    Reflect.ownKeys(descriptors).length !== length + 1
  ) {
    throw new TypeError(`${label} has an invalid length or shape`);
  }
  return Array.from({ length }, (_, index) => {
    const descriptor = descriptors[String(index)];
    if (
      !descriptor?.enumerable ||
      !Object.hasOwn(descriptor, "value")
    ) {
      throw new TypeError(`${label}[${index}] must be a data property`);
    }
    return descriptor.value;
  });
}

function runtimeId(value, label) {
  if (
    !(
      (typeof value === "string" && value.length > 0) ||
      (Number.isSafeInteger(value) && value > 0)
    )
  ) {
    throw new TypeError(`${label} must be a runtime card id`);
  }
  return value;
}

function safeInteger(value, minimum, maximum, label) {
  if (
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new TypeError(
      `${label} must be a safe integer from ${minimum} through ${maximum}`,
    );
  }
  return value;
}

function validateCard(value, index) {
  const card = exactRecord(value, CARD_KEYS, `cards[${index}]`);
  runtimeId(card.id, `cards[${index}].id`);
  safeInteger(card.cost, 1, ELIXIR_CAPACITY, `cards[${index}].cost`);
  safeInteger(card.level, 1, MAX_LEVEL, `cards[${index}].level`);
  if (typeof card.excludedFromCopy !== "boolean") {
    throw new TypeError(`cards[${index}].excludedFromCopy must be boolean`);
  }
  return {
    cost: card.cost,
    excludedFromCopy: card.excludedFromCopy,
    id: card.id,
    level: card.level,
  };
}

function validateSetup(value) {
  const setup = exactRecord(value, SETUP_KEYS, "copy setup");
  const cards = denseArray(setup.cards, 256, "copy setup.cards")
    .map(validateCard);
  if (cards.length < 8) {
    throw new TypeError("copy setup.cards must describe the entire deck");
  }
  const ids = cards.map(({ id }) => id);
  if (new Set(ids).size !== ids.length) {
    throw new TypeError("copy setup.cards ids must be unique");
  }
  const deck = denseArray(setup.deck, 8, "copy setup.deck")
    .map((id, index) => runtimeId(id, `copy setup.deck[${index}]`));
  if (deck.length !== 8 || new Set(deck).size !== 8) {
    throw new TypeError("copy setup.deck must contain eight unique cards");
  }
  if (deck.some((id) => !ids.includes(id))) {
    throw new TypeError("copy setup.deck contains an undescribed card");
  }
  runtimeId(setup.copyCardId, "copy setup.copyCardId");
  const copyCard = cards.find(({ id }) => id === setup.copyCardId);
  if (!copyCard || !deck.includes(setup.copyCardId)) {
    throw new TypeError("copy card must be described and present in the deck");
  }
  if (!copyCard.excludedFromCopy) {
    throw new TypeError("copy card must be excluded from copying itself");
  }
  if (
    typeof setup.seed !== "string" &&
    !Number.isSafeInteger(setup.seed)
  ) {
    throw new TypeError("copy setup.seed must be a string or safe integer");
  }
  return {
    cards,
    copyCardId: setup.copyCardId,
    deck,
    seed: setup.seed,
  };
}

function validateCommand(value, index = null) {
  const label = index === null ? "copy command" : `commands[${index}]`;
  const command = exactRecord(value, COMMAND_KEYS, label);
  runtimeId(command.cardId, `${label}.cardId`);
  safeInteger(command.tick, 0, COPY_CARD_MAX_TICK - 1, `${label}.tick`);
  return { cardId: command.cardId, tick: command.tick };
}

function parseSnapshot(serialized) {
  if (typeof serialized !== "string") {
    throw new TypeError("copy snapshot must be a string");
  }
  if (utf8ByteLength(serialized) > MAX_SNAPSHOT_BYTES) {
    throw new RangeError("copy snapshot exceeds its size bound");
  }
  try {
    return JSON.parse(serialized);
  } catch {
    throw new TypeError("copy snapshot must be valid JSON");
  }
}

export function getPreviousCardCopyQuestions() {
  return clone(PREVIOUS_CARD_COPY_QUESTIONS);
}

/**
 * A narrow previous-card effect that composes DeckCycle for all hand and
 * queue mutation. It does not spend elixir or instantiate deployed entities;
 * effective cost/level are deterministic outputs for those shared systems.
 */
export class PreviousCardCopyMatch {
  #cards;
  #commands = [];
  #copyCardId;
  #cycle;
  #events = [];
  #pending = [];
  #previous = null;
  #setup;
  #tick = 0;

  constructor(options) {
    this.#setup = validateSetup(options);
    this.#cards = new Map(this.#setup.cards.map((card) => [card.id, card]));
    this.#copyCardId = this.#setup.copyCardId;
    this.#cycle = new DeckCycle({
      deck: this.#setup.deck,
      seed: this.#setup.seed,
    });
  }

  get state() {
    return clone({
      deck: this.#cycle.state,
      previous: this.#previous,
      tick: this.#tick,
    });
  }

  get replay() {
    return clone(this.#events);
  }

  schedulePlay(value) {
    const command = validateCommand(value);
    if (this.#commands.length >= DECK_MAX_PLAY_COMMANDS) {
      throw new RangeError("copy command limit exceeded");
    }
    if (command.tick < this.#tick) {
      throw new RangeError("cannot schedule a copy command in a resolved tick");
    }
    const recorded = { ...command, sequence: this.#commands.length };
    this.#commands.push(recorded);
    this.#pending.push(recorded);
    this.#pending.sort(
      (left, right) =>
        left.tick - right.tick || left.sequence - right.sequence,
    );
    return recorded.sequence;
  }

  advanceTicks(count) {
    safeInteger(
      count,
      0,
      COPY_CARD_MAX_TICK - this.#tick,
      "copy advance count",
    );
    const targetTick = this.#tick + count;
    let dueCount = 0;
    while (
      dueCount < this.#pending.length &&
      this.#pending[dueCount].tick < targetTick
    ) {
      dueCount += 1;
    }
    const due = this.#pending.splice(0, dueCount);
    const emitted = due.map((command) => this.#resolve(command));
    this.#tick = targetTick;
    return clone(emitted);
  }

  runToTick(targetTick) {
    safeInteger(targetTick, 0, COPY_CARD_MAX_TICK, "copy target tick");
    if (targetTick < this.#tick) {
      throw new RangeError("copy target tick is already resolved");
    }
    return this.advanceTicks(targetTick - this.#tick);
  }

  serialize() {
    const serialized = canonicalJson({
      commands: this.#commands.map(({ cardId, tick }) => ({ cardId, tick })),
      fixture: FIXTURE,
      setup: this.#setup,
      tick: this.#tick,
      version: COPY_CARD_RULE_VERSION,
    });
    if (utf8ByteLength(serialized) > MAX_SNAPSHOT_BYTES) {
      throw new RangeError("copy snapshot exceeds its size bound");
    }
    return serialized;
  }

  static restore(serialized) {
    const snapshot = exactRecord(
      parseSnapshot(serialized),
      SNAPSHOT_KEYS,
      "copy snapshot",
    );
    if (
      snapshot.fixture !== FIXTURE ||
      snapshot.version !== COPY_CARD_RULE_VERSION
    ) {
      throw new TypeError("copy snapshot uses an unsupported rule");
    }
    safeInteger(snapshot.tick, 0, COPY_CARD_MAX_TICK, "copy snapshot.tick");
    const commands = denseArray(
      snapshot.commands,
      DECK_MAX_PLAY_COMMANDS,
      "copy snapshot.commands",
    ).map(validateCommand);
    const match = new PreviousCardCopyMatch(snapshot.setup);
    for (const command of commands) match.schedulePlay(command);
    match.runToTick(snapshot.tick);
    if (match.serialize() !== serialized) {
      throw new TypeError("copy snapshot must use canonical serialization");
    }
    return match;
  }

  #reject(command, reason) {
    const event = {
      accepted: false,
      copiedCardId: null,
      drawnCard: null,
      effectiveCost: null,
      effectiveLevel: null,
      reason,
      requestedCardId: command.cardId,
      sequence: command.sequence,
      slot: null,
      tick: command.tick,
      type: "card-play",
    };
    this.#events.push(event);
    return event;
  }

  #resolve(command) {
    const card = this.#cards.get(command.cardId);
    if (!card) return this.#reject(command, "unknown_card");

    if (command.cardId === this.#copyCardId) {
      if (!this.#cycle.state.hand.includes(command.cardId)) {
        const deckEvent = this.#cycle.play(command.cardId);
        return this.#reject(command, deckEvent.reason);
      }
      if (this.#previous === null) {
        return this.#reject(command, "empty_history");
      }
      const previousCard = this.#cards.get(this.#previous.cardId);
      if (!previousCard || previousCard.excludedFromCopy) {
        return this.#reject(command, "excluded_previous_card");
      }
      const deckEvent = this.#cycle.play(command.cardId);
      if (!deckEvent.accepted) return this.#reject(command, deckEvent.reason);
      const event = {
        accepted: true,
        copiedCardId: previousCard.id,
        drawnCard: deckEvent.drawnCard,
        effectiveCost: Math.min(
          ELIXIR_CAPACITY,
          this.#previous.effectiveCost + 1,
        ),
        effectiveLevel: Math.min(
          MAX_LEVEL,
          this.#previous.effectiveLevel + 1,
        ),
        reason: "accepted_copy",
        requestedCardId: command.cardId,
        sequence: command.sequence,
        slot: deckEvent.slot,
        tick: command.tick,
        type: "card-play",
      };
      this.#events.push(event);
      return event;
    }

    const deckEvent = this.#cycle.play(command.cardId);
    if (!deckEvent.accepted) return this.#reject(command, deckEvent.reason);
    const event = {
      accepted: true,
      copiedCardId: null,
      drawnCard: deckEvent.drawnCard,
      effectiveCost: card.cost,
      effectiveLevel: card.level,
      reason: "accepted",
      requestedCardId: command.cardId,
      sequence: command.sequence,
      slot: deckEvent.slot,
      tick: command.tick,
      type: "card-play",
    };
    this.#previous = {
      cardId: card.id,
      effectiveCost: event.effectiveCost,
      effectiveLevel: event.effectiveLevel,
    };
    this.#events.push(event);
    return event;
  }
}
