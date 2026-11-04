import { SeededRandom } from "./rng.js";

export const DECK_CYCLE_ALGORITHM = "fisher-yates-pcg32-deck-cycle-v1";
export const DECK_CYCLE_RULE_VERSION = 1;
export const DECK_SIZE = 8;
export const HAND_SIZE = 4;
export const DECK_MAX_PLAY_COMMANDS = 10_000;

const SHUFFLE_STREAM_NAME = "deck-cycle-v1";

function ownDataRecord(value, expectedKeys, label) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null) ||
    Object.getOwnPropertySymbols(value).length !== 0
  ) {
    throw new TypeError(`${label} must be a plain data object`);
  }

  const descriptors = Object.getOwnPropertyDescriptors(value);
  const actualKeys = Object.keys(descriptors).sort();
  const wantedKeys = [...expectedKeys].sort();
  if (
    actualKeys.length !== wantedKeys.length ||
    actualKeys.some((key, index) => key !== wantedKeys[index])
  ) {
    throw new TypeError(`${label} has an invalid shape`);
  }
  for (const key of actualKeys) {
    if (!Object.hasOwn(descriptors[key], "value")) {
      throw new TypeError(`${label}.${key} must be a data property`);
    }
  }
  return Object.fromEntries(
    actualKeys.map((key) => [key, descriptors[key].value]),
  );
}

function ownArrayValues(value, label, maximumLength = undefined) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new TypeError(`${label} must be a plain array`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const lengthDescriptor = descriptors.length;
  if (
    !lengthDescriptor ||
    !Object.hasOwn(lengthDescriptor, "value") ||
    !Number.isSafeInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 0 ||
    (maximumLength !== undefined && lengthDescriptor.value > maximumLength)
  ) {
    throw new TypeError(`${label} has an invalid length`);
  }

  const result = [];
  for (let index = 0; index < lengthDescriptor.value; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !Object.hasOwn(descriptor, "value")) {
      throw new TypeError(`${label}[${index}] must be a data property`);
    }
    result.push(descriptor.value);
  }
  const allowed = new Set([
    "length",
    ...Array.from({ length: lengthDescriptor.value }, (_, index) => String(index)),
  ]);
  if (
    Reflect.ownKeys(descriptors).some(
      (key) => typeof key !== "string" || !allowed.has(key),
    )
  ) {
    throw new TypeError(`${label} has unexpected properties`);
  }
  return result;
}

function isRuntimeCardId(value) {
  return (
    (typeof value === "string" && value.length > 0) ||
    (Number.isSafeInteger(value) && value > 0)
  );
}

function assertSeed(seed) {
  if (
    typeof seed !== "string" &&
    !Number.isSafeInteger(seed)
  ) {
    throw new TypeError("seed must be a string or safe integer");
  }
  return seed;
}

function validateDeck(deck) {
  const cards = ownArrayValues(deck, "deck");
  if (cards.length !== DECK_SIZE) {
    throw new TypeError("deck must contain exactly eight cards");
  }
  if (cards.some((card) => !isRuntimeCardId(card))) {
    throw new TypeError(
      "deck cards must be non-empty strings or positive safe integers",
    );
  }
  if (new Set(cards).size !== DECK_SIZE) {
    throw new TypeError("deck cards must be unique");
  }
  return cards;
}

function shuffledDeck(deck, seed) {
  const cards = [...deck];
  const random = new SeededRandom(seed).fork(SHUFFLE_STREAM_NAME);
  for (let index = cards.length - 1; index > 0; index -= 1) {
    const selected = random.int(index + 1);
    [cards[index], cards[selected]] = [cards[selected], cards[index]];
  }
  return cards;
}

function makeEvent(sequence, requestedCard, accepted, reason, slot, drawnCard) {
  return Object.freeze({
    accepted,
    cardId: isRuntimeCardId(requestedCard) ? requestedCard : null,
    drawnCard,
    reason,
    sequence,
    slot,
    type: "play",
  });
}

/**
 * Original deterministic deck-cycle contract.
 *
 * The reference corpus does not establish the target game's shuffle or hand
 * algorithm. This centralized, versioned rule is intentionally configurable
 * replay infrastructure pending footage-based validation; it is not a
 * mechanical-fidelity claim.
 */
export class DeckCycle {
  #deck;
  #events = [];
  #hand;
  #plays = [];
  #queue;
  #seed;

  constructor(options) {
    const record = ownDataRecord(options, ["deck", "seed"], "options");
    this.#seed = assertSeed(record.seed);
    this.#deck = validateDeck(record.deck);
    const order = shuffledDeck(this.#deck, this.#seed);
    this.#hand = order.slice(0, HAND_SIZE);
    this.#queue = order.slice(HAND_SIZE);
  }

  get state() {
    return {
      hand: [...this.#hand],
      next: this.#queue[0],
      queue: [...this.#queue],
      sequence: this.#plays.length,
    };
  }

  get events() {
    return this.#events.map((event) => ({ ...event }));
  }

  play(cardId) {
    if (this.#plays.length >= DECK_MAX_PLAY_COMMANDS) {
      throw new RangeError(
        `deck play history cannot exceed ${DECK_MAX_PLAY_COMMANDS} commands`,
      );
    }

    const sequence = this.#plays.length;
    const recordedCard = isRuntimeCardId(cardId) ? cardId : null;
    let event;
    if (recordedCard === null) {
      event = makeEvent(
        sequence,
        recordedCard,
        false,
        "invalid_card",
        null,
        null,
      );
    } else {
      const slot = this.#hand.indexOf(recordedCard);
      if (slot === -1) {
        event = makeEvent(
          sequence,
          recordedCard,
          false,
          "not_in_hand",
          null,
          null,
        );
      } else {
        const drawnCard = this.#queue.shift();
        this.#hand[slot] = drawnCard;
        this.#queue.push(recordedCard);
        event = makeEvent(
          sequence,
          recordedCard,
          true,
          "accepted",
          slot,
          drawnCard,
        );
      }
    }

    this.#plays.push(recordedCard);
    this.#events.push(event);
    return { ...event };
  }

  serialize() {
    return {
      algorithm: DECK_CYCLE_ALGORITHM,
      deck: [...this.#deck],
      plays: [...this.#plays],
      ruleVersion: DECK_CYCLE_RULE_VERSION,
      seed: this.#seed,
    };
  }

  serializeJson() {
    return JSON.stringify(this.serialize());
  }

  static restore(serialized) {
    let snapshot = serialized;
    if (typeof serialized === "string") {
      try {
        snapshot = JSON.parse(serialized);
      } catch {
        throw new TypeError("deck snapshot must be valid JSON");
      }
    }
    const record = ownDataRecord(
      snapshot,
      ["algorithm", "deck", "plays", "ruleVersion", "seed"],
      "deck snapshot",
    );
    if (
      record.algorithm !== DECK_CYCLE_ALGORITHM ||
      record.ruleVersion !== DECK_CYCLE_RULE_VERSION
    ) {
      throw new TypeError("deck snapshot uses an unsupported rule");
    }
    const commands = ownArrayValues(
      record.plays,
      "deck snapshot plays",
      DECK_MAX_PLAY_COMMANDS,
    );
    if (
      commands.some(
        (cardId) => cardId !== null && !isRuntimeCardId(cardId),
      )
    ) {
      throw new TypeError("deck snapshot contains an invalid play command");
    }

    const cycle = new DeckCycle({ deck: record.deck, seed: record.seed });
    for (const cardId of commands) cycle.play(cardId);
    return cycle;
  }
}

export function getDeckCycleRules() {
  return Object.freeze({
    algorithm: DECK_CYCLE_ALGORITHM,
    fidelity: "original_configurable_rule_pending_footage_validation",
    handSize: HAND_SIZE,
    maxPlayCommands: DECK_MAX_PLAY_COMMANDS,
    shuffle: "descending-fisher-yates",
    shuffleStream: SHUFFLE_STREAM_NAME,
    version: DECK_CYCLE_RULE_VERSION,
  });
}
