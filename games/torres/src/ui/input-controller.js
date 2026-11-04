import {
  ARENA_LENGTH_MILLITILES,
  ARENA_WIDTH_MILLITILES,
  validateArenaPoint,
} from "../sim/arena-geometry.js";
import { evaluateDeployment } from "../sim/deployment.js";
import {
  DECK_MAX_PLAY_COMMANDS,
  DeckCycle,
} from "../sim/deck.js";
import { ElixirMatch } from "../sim/elixir.js";
import {
  isPlayerDeployBridge,
  createPlayerDeployIntent,
} from "../sim/game-player-deploy.js";

const LOCAL_SIDE = "south";
const MAX_ACTIONS = DECK_MAX_PLAY_COMMANDS * 3;
const COMMIT_ROLLBACK_FAULT = "commit_rollback_failed";
const AUTHORITATIVE_PROJECTION_FAULT = "authoritative_projection_failed";
const systemAuthorities = new WeakMap();
const deliveryControllers = new WeakSet();
const mutationControllers = new WeakSet();
const feedbackReceipts = new WeakMap();
const feedbackReaders = new WeakMap();
const feedbackSources = new WeakMap();
const commitReceipts = new WeakMap();
const commitSinkCapabilities = new WeakMap();
const consumedCommitSinkCapabilities = new WeakSet();
const mountedCommitStates = new WeakMap();
const commitSubscriptions = new WeakMap();
const hudCapabilities = new WeakMap();
const activeHudCapabilities = new WeakSet();
const consumedHudCapabilities = new WeakSet();
const bridgeWitnesses = new WeakMap();
const sinkAuthorities = new WeakMap();
const activeSinkAuthorities = new WeakSet();
const activeBridgeAuthorities = new WeakSet();
const controllerDisposalHooks = new WeakMap();
const FULL_CARD_KEYS = Object.freeze([
  "areaDamageRadiusMillitiles", "cost", "count", "damage", "deployTimeTicks",
  "displayName", "entities", "firstHitTicks", "formation", "hitSpeedTicks",
  "hitpoints", "id", "kind", "movementMillitilesPerSecond", "rangeMillitiles",
  "rarity", "sightRangeMillitiles", "targetMode",
]);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function freezeGraph(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Object.keys(value)) freezeGraph(value[key]);
    Object.freeze(value);
  }
  return value;
}

function systemSnapshot(deck, elixir) {
  return freezeGraph({
    deck: {
      bytes: deck.serializeJson(),
      state: clone(deck.state),
    },
    elixir: {
      bytes: elixir.serialize(),
      state: clone(elixir.state),
    },
  });
}

function frozenAggregate(message, codes) {
  const errors = codes.map((code) => Object.freeze(new Error(code)));
  const aggregate = new AggregateError(errors, message);
  Object.freeze(aggregate.errors);
  return Object.freeze(aggregate);
}

function issueArenaInputFeedbackReceipt(input, result, selectedCardIdBefore) {
  const snapshot = feedbackReaders.get(input)();
  const receipt = Object.freeze(Object.create(null));
  feedbackReceipts.set(receipt, {
    commands: snapshot.commands,
    elixir: snapshot.elixir,
    result: clone(result),
    selectedCardIdBefore,
    source: feedbackSources.get(input),
    spendSequenceProvenance: result.accepted
      ? result.command.spendSequence
      : null,
  });
  return receipt;
}

/**
 * Consume a single-use placement receipt issued inside the canonical browser
 * input seam. Plain objects and replayed receipts have no authority.
 */
export function consumeArenaInputFeedbackReceipt(receipt) {
  if (
    receipt === null ||
    typeof receipt !== "object" ||
    !feedbackReceipts.has(receipt)
  ) {
    throw new TypeError("arena input feedback receipt is invalid or consumed");
  }
  const payload = feedbackReceipts.get(receipt);
  feedbackReceipts.delete(receipt);
  return freezeGraph({
    commands: clone(payload.commands),
    elixir: payload.elixir,
    result: clone(payload.result),
    selectedCardIdBefore: payload.selectedCardIdBefore,
    source: payload.source,
    spendSequenceProvenance: payload.spendSequenceProvenance,
  });
}

/** Create a fieldless single-use authority for one trusted commit sink. */
export function createArenaInputCommitSinkCapability(sink) {
  if (arguments.length !== 1 || typeof sink !== "function") {
    throw new TypeError("arena input commit sink must be one function");
  }
  const capability = Object.freeze(Object.create(null));
  commitSinkCapabilities.set(capability, sink);
  return capability;
}

/** Bind exactly one command sink to one live mounted browser input. */
export function subscribeArenaInputCommits(browserInput, capability) {
  const state = mountedCommitStates.get(browserInput);
  const sink = commitSinkCapabilities.get(capability);
  if (state === undefined || !state.active) {
    throw new TypeError("arena input commit subscription requires a live mount");
  }
  if (sink === undefined) {
    if (consumedCommitSinkCapabilities.has(capability)) {
      throw new TypeError("arena input commit sink capability is consumed");
    }
    throw new TypeError("arena input commit sink capability is invalid");
  }
  commitSinkCapabilities.delete(capability);
  consumedCommitSinkCapabilities.add(capability);
  if (state.sink !== null) {
    throw new RangeError("arena input commit sink is already subscribed");
  }
  state.sink = sink;
  const subscription = Object.freeze(Object.create(null));
  commitSubscriptions.set(subscription, state);
  return subscription;
}

/** Remove a commit subscription without exposing its callback or mount. */
export function unsubscribeArenaInputCommits(subscription) {
  const state = commitSubscriptions.get(subscription);
  if (state === undefined) return false;
  commitSubscriptions.delete(subscription);
  if (state.sink === null) return false;
  state.sink = null;
  return true;
}

/** Consume one commit receipt issued only to the registered command sink. */
export function consumeArenaInputCommitReceipt(receipt) {
  const payload = commitReceipts.get(receipt);
  if (payload === undefined) {
    throw new TypeError("arena input commit receipt is invalid or consumed");
  }
  commitReceipts.delete(receipt);
  return freezeGraph(clone(payload));
}

function deliverArenaInputCommit(state, result, selectedCardIdBefore, slotBefore) {
  if (!result.accepted || state.sink === null) return;
  if (selectedCardIdBefore !== result.command.cardId ||
      !Number.isSafeInteger(slotBefore) || slotBefore < 0 || slotBefore > 3) {
    throw new Error("arena input commit provenance is inconsistent");
  }
  const receipt = Object.freeze(Object.create(null));
  commitReceipts.set(receipt, {
    cardId: result.command.cardId,
    commandId: result.command.id,
    point: clone(result.command.point),
    slot: slotBefore,
    tick: result.command.tick,
    type: result.command.type,
  });
  state.sink(receipt);
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

function parseBoundedCanonicalText(
  text,
  label,
  maxBytes = 65_536,
  maxNodes = 4_096,
  maxDepth = 32,
) {
  if (typeof text !== "string") throw new TypeError(`${label} must be canonical text`);
  if (new TextEncoder().encode(text).byteLength > maxBytes) {
    throw new RangeError(`${label} exceeds its byte bound`);
  }
  let parsed;
  try { parsed = JSON.parse(text); } catch {
    throw new TypeError(`${label} must be valid JSON`);
  }
  const stack = [{ depth: 0, value: parsed }];
  let nodes = 0;
  while (stack.length > 0) {
    const { depth, value } = stack.pop();
    nodes += 1;
    if (nodes > maxNodes) throw new RangeError(`${label} exceeds its node bound`);
    if (depth > maxDepth) throw new RangeError(`${label} exceeds its depth bound`);
    if (typeof value === "string") {
      for (let index = 0; index < value.length; index += 1) {
        const unit = value.charCodeAt(index);
        if (unit >= 0xd800 && unit <= 0xdbff) {
          const next = value.charCodeAt(index + 1);
          if (!(next >= 0xdc00 && next <= 0xdfff)) {
            throw new TypeError(`${label} contains an unpaired Unicode surrogate`);
          }
          index += 1;
        } else if (unit >= 0xdc00 && unit <= 0xdfff) {
          throw new TypeError(`${label} contains an unpaired Unicode surrogate`);
        }
      }
    } else if (value !== null && typeof value === "object") {
      for (const child of Array.isArray(value) ? value : Object.values(value)) {
        stack.push({ depth: depth + 1, value: child });
      }
    }
  }
  if (canonicalJson(parsed) !== text) throw new TypeError(`${label} must be canonical JSON`);
  return parsed;
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
  const actual = Object.keys(descriptors).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new TypeError(`${label} has an invalid shape`);
  }
  for (const key of actual) {
    if (
      !descriptors[key].enumerable ||
      !Object.hasOwn(descriptors[key], "value")
    ) {
      throw new TypeError(`${label}.${key} must be an enumerable data property`);
    }
  }
  return Object.fromEntries(
    expected.map((key) => [key, descriptors[key].value]),
  );
}

function safeInteger(value, label, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new TypeError(`${label} must be a safe integer of at least ${minimum}`);
  }
  return value;
}

function checkedCards(cards) {
  if (
    !Array.isArray(cards) ||
    Object.getPrototypeOf(cards) !== Array.prototype ||
    cards.length !== 8
  ) {
    throw new TypeError("arena input cards must contain exactly eight cards");
  }
  const checked = cards.map((value, index) => {
    const keys = Object.keys(Object.getOwnPropertyDescriptors(value ?? {}));
    const full = keys.length === FULL_CARD_KEYS.length;
    const card = exactRecord(value, full ? FULL_CARD_KEYS :
      ["cost", "displayName", "id"], `arena input card ${index}`);
    safeInteger(card.cost, `arena input card ${index}.cost`, 1);
    for (const key of ["displayName", "id"]) {
      if (typeof card[key] !== "string" || card[key].length === 0) {
        throw new TypeError(`arena input card ${index}.${key} is invalid`);
      }
    }
    return full ? JSON.parse(canonicalJson(card)) : card;
  });
  if (new Set(checked.map(({ id }) => id)).size !== checked.length) {
    throw new TypeError("arena input card IDs must be unique");
  }
  return clone(checked);
}

function checkedRect(value) {
  const rect = exactRecord(
    value,
    ["height", "left", "top", "width"],
    "arena client rectangle",
  );
  for (const key of ["height", "left", "top", "width"]) {
    if (typeof rect[key] !== "number" || !Number.isFinite(rect[key])) {
      throw new TypeError(`arena client rectangle.${key} must be finite`);
    }
  }
  if (rect.width <= 0 || rect.height <= 0) {
    throw new TypeError("arena client rectangle dimensions must be positive");
  }
  return rect;
}

function checkedClientPoint(value) {
  const point = exactRecord(
    value,
    ["clientX", "clientY"],
    "client point",
  );
  for (const key of ["clientX", "clientY"]) {
    if (typeof point[key] !== "number" || !Number.isFinite(point[key])) {
      throw new TypeError(`client point.${key} must be finite`);
    }
  }
  return point;
}

/**
 * Project one viewport point into the arena's integer millitile coordinate
 * space. The DOM's top edge is canonical north (y=32000), while its bottom
 * edge is canonical south (y=0). All four rectangle edges are inclusive.
 */
export function clientPointToArenaPoint(rectValue, pointValue) {
  const rect = checkedRect(rectValue);
  const point = checkedClientPoint(pointValue);
  const right = rect.left + rect.width;
  const bottom = rect.top + rect.height;
  if (
    point.clientX < rect.left ||
    point.clientX > right ||
    point.clientY < rect.top ||
    point.clientY > bottom
  ) {
    return null;
  }
  return {
    x: Math.min(
      ARENA_WIDTH_MILLITILES,
      Math.floor(
        (point.clientX - rect.left) *
        ARENA_WIDTH_MILLITILES /
        rect.width,
      ),
    ),
    y: Math.min(
      ARENA_LENGTH_MILLITILES,
      Math.floor(
        (bottom - point.clientY) *
        ARENA_LENGTH_MILLITILES /
        rect.height,
      ),
    ),
  };
}

function cardMap(cards) {
  return new Map(cards.map((card) => [card.id, card]));
}

function checkedDeckSystem(value) {
  if (value !== null &&
      (typeof value === "object" || typeof value === "function") &&
      Object.getPrototypeOf(value) === DeckCycle.prototype) return value;
  const snapshot = exactRecord(value, ["bytes", "state"], "arena input deck snapshot");
  if (typeof snapshot.bytes !== "string") {
    throw new TypeError("arena input deck snapshot bytes must be a string");
  }
  // The bytes are the sole authority; the nested view is intentionally never
  // traversed while reconstructing a remounted controller.
  return DeckCycle.restore(snapshot.bytes);
}

function checkedElixirSystem(value) {
  if (value !== null &&
      (typeof value === "object" || typeof value === "function") &&
      Object.getPrototypeOf(value) === ElixirMatch.prototype) return value;
  const snapshot = exactRecord(value, ["bytes", "state"], "arena input elixir snapshot");
  if (typeof snapshot.bytes !== "string") {
    throw new TypeError("arena input elixir snapshot bytes must be a string");
  }
  return ElixirMatch.restore(snapshot.bytes);
}

function checkedSystems(options) {
  const optionDescriptors = Object.getOwnPropertyDescriptors(options);
  const authoritative = Object.hasOwn(optionDescriptors, "deployBridge");
  const continued = Object.hasOwn(optionDescriptors, "commandIdOffset");
  const checked = exactRecord(
    options,
    ["cards", "commitSystems", ...(continued ? ["commandIdOffset"] : []), "deck",
      ...(authoritative ? ["deployBridge"] : []), "elixir", "hudUpdate"],
    "arena input options",
  );
  const cards = checkedCards(checked.cards);
  const deck = checkedDeckSystem(checked.deck);
  const elixir = checkedElixirSystem(checked.elixir);
  if (typeof checked.hudUpdate !== "function") {
    throw new TypeError("arena input hudUpdate must be a function");
  }
  if (typeof checked.commitSystems !== "function") {
    throw new TypeError("arena input commitSystems must be a function");
  }
  if (authoritative && !isPlayerDeployBridge(checked.deployBridge)) {
    throw new TypeError("arena input deployBridge must be an exact PlayerDeployBridge");
  }
  if (continued && (!Number.isSafeInteger(checked.commandIdOffset) ||
      checked.commandIdOffset < 0 || checked.commandIdOffset > MAX_ACTIONS)) {
    throw new TypeError("arena input command ID offset is invalid");
  }
  return {
    cards,
    commitSystems: checked.commitSystems,
    commandIdOffset: continued ? checked.commandIdOffset : 0,
    deck,
    deployBridge: authoritative ? checked.deployBridge : null,
    elixir,
    hudUpdate: checked.hudUpdate,
  };
}

/**
 * Serialize a trusted card catalog for the primitive-only HUD boundary.
 */
export function serializeArenaInputCards(cards) {
  return canonicalJson(checkedCards(cards));
}

/** Create an opaque witness for an already trusted live bridge. */
export function createArenaInputBridgeWitness(bridge) {
  if (!isPlayerDeployBridge(bridge)) {
    throw new TypeError("arena input bridge witness requires an exact bridge");
  }
  const witness = Object.freeze(Object.create(null));
  bridgeWitnesses.set(witness, bridge);
  return witness;
}

/**
 * Create a single-use browser-mount authority from canonical primitive state.
 * A mount attempt consumes the token permanently, including failed attempts,
 * so stale state can never be rewound by retrying it.
 */
export function createArenaInputHudCapability(
  cardsText,
  deckBytes,
  elixirBytes,
  replaceInteractionSystems,
  update,
  bridgeWitness = null,
  commandIdOffset = 0,
) {
  // All untrusted state positions are rejected by typeof alone before any
  // parse or object operation. typeof on a Proxy executes no traps.
  if (typeof cardsText !== "string" || typeof deckBytes !== "string" ||
      typeof elixirBytes !== "string") {
    throw new TypeError("arena input HUD state witnesses must be canonical strings");
  }
  if (typeof replaceInteractionSystems !== "function" || typeof update !== "function") {
    throw new TypeError("arena input HUD callbacks must be functions");
  }
  if (!Number.isSafeInteger(commandIdOffset) || commandIdOffset < 0 ||
      commandIdOffset > MAX_ACTIONS) {
    throw new TypeError("arena input command ID offset is invalid");
  }
  // Sink identity is the exact pair of function objects. Wrapper/alias
  // functions intentionally describe a distinct authority; production keeps
  // the original stable sink pair when minting sequential capabilities.
  let updateAuthorities = sinkAuthorities.get(replaceInteractionSystems);
  if (updateAuthorities === undefined) {
    updateAuthorities = new WeakMap();
    sinkAuthorities.set(replaceInteractionSystems, updateAuthorities);
  }
  let sinkAuthority = updateAuthorities.get(update);
  if (sinkAuthority === undefined) {
    sinkAuthority = Object.freeze(Object.create(null));
    updateAuthorities.set(update, sinkAuthority);
  }
  const deployBridge = bridgeWitness === null ? null : bridgeWitnesses.get(bridgeWitness);
  if (bridgeWitness !== null && deployBridge === undefined) {
    throw new TypeError("arena input bridge witness is invalid");
  }
  if (bridgeWitness !== null) bridgeWitnesses.delete(bridgeWitness);
  const cards = checkedCards(parseBoundedCanonicalText(cardsText,
    "arena input cards witness"));
  parseBoundedCanonicalText(deckBytes, "arena input deck witness",
    16_777_216, 100_000, 64);
  parseBoundedCanonicalText(elixirBytes, "arena input elixir witness",
    16_777_216, 100_000, 64);
  const deck = DeckCycle.restore(deckBytes);
  const elixir = ElixirMatch.restore(elixirBytes);
  const checked = checkedSystems(deployBridge === null ? {
    cards,
    commitSystems: replaceInteractionSystems,
    commandIdOffset,
    deck,
    elixir,
    hudUpdate: update,
  } : {
    cards,
    commitSystems: replaceInteractionSystems,
    commandIdOffset,
    deck,
    deployBridge,
    elixir,
    hudUpdate: update,
  });
  const token = Object.freeze(Object.create(null));
  hudCapabilities.set(token, Object.freeze({
    ...checked,
    cards: freezeGraph(clone(checked.cards)),
    cardsText,
    commandIdOffset,
    sinkAuthority,
  }));
  return token;
}

/** Mint a single-use remount cursor whose next browser command ID is exact. */
export function createArenaInputSessionContinuationCapability(
  cardsText,
  deckBytes,
  elixirBytes,
  nextCommandId,
  replaceInteractionSystems,
  update,
) {
  if (!Number.isSafeInteger(nextCommandId) || nextCommandId < 1 ||
      nextCommandId > MAX_ACTIONS + 1) {
    throw new TypeError("arena input next command ID is invalid");
  }
  return createArenaInputHudCapability(cardsText, deckBytes, elixirBytes,
    replaceInteractionSystems, update, null, nextCommandId - 1);
}

export class ArenaInputController {
  #actions = [];
  #cards;
  #claimedSystems;
  #commands = [];
  #commandIdOffset = 0;
  #commitSystems;
  #deck;
  #deployBridge;
  #disposed = false;
  #elixir;
  #faultCode = null;
  #hudUpdate;
  #initialDeck;
  #initialElixir;
  #selectedCardId = null;
  #operationActive = false;

  constructor(options) {
    const checked = checkedSystems(options);
    this.#cards = checked.cards;
    this.#claimedSystems = checked.deployBridge === null
      ? [checked.deck, checked.elixir]
      : [checked.deck, checked.elixir, checked.deployBridge];
    this.#commitSystems = checked.commitSystems;
    this.#commandIdOffset = checked.commandIdOffset;
    this.#deck = checked.deck;
    this.#deployBridge = checked.deployBridge;
    this.#elixir = checked.elixir;
    this.#hudUpdate = checked.hudUpdate;
    this.#initialDeck = JSON.parse(this.#deck.serializeJson());
    this.#initialElixir = JSON.parse(this.#elixir.serialize());
    if (this.#deployBridge !== null) this.#seedAuthoritativeHistory();
    feedbackSources.set(this, Object.freeze(Object.create(null)));
    feedbackReaders.set(this, () => ({
      cards: clone(this.#cards),
      commands: clone(this.#commands),
      deck: clone(this.#deck.state),
      elixir: this.#elixir.serialize(),
      selectedCardId: this.#selectedCardId,
    }));
    for (const system of this.#claimedSystems) {
      if (systemAuthorities.has(system)) {
        throw new RangeError("arena input systems already have an input authority");
      }
    }
    const claimed = [];
    try {
      for (const system of this.#claimedSystems) {
        systemAuthorities.set(system, this);
        claimed.push(system);
      }
    } catch (error) {
      for (const system of claimed) {
        if (systemAuthorities.get(system) === this) systemAuthorities.delete(system);
      }
      throw error;
    }
  }

  get selectedCardId() {
    return this.#selectedCardId;
  }

  get commands() {
    return freezeGraph(clone(this.#commands));
  }

  get deck() {
    return systemSnapshot(this.#deck, this.#elixir).deck;
  }

  get elixir() {
    return systemSnapshot(this.#deck, this.#elixir).elixir;
  }

  get faultCode() {
    return this.#faultCode;
  }

  dispose() {
    if (deliveryControllers.has(this) || mutationControllers.has(this)) {
      throw new Error("arena input reentrant disposal rejected");
    }
    if (this.#disposed) return false;
    this.#disposed = true;
    for (const system of this.#claimedSystems) {
      if (systemAuthorities.get(system) === this) systemAuthorities.delete(system);
    }
    const disposalHook = controllerDisposalHooks.get(this);
    if (disposalHook !== undefined) {
      controllerDisposalHooks.delete(this);
      disposalHook();
    }
    return true;
  }

  get replay() {
    return freezeGraph(clone(this.#actions));
  }

  #seedAuthoritativeHistory() {
    if (this.#deck.serializeJson() !== this.#deployBridge.deckBytes ||
        this.#elixir.serialize() !== this.#deployBridge.elixirBytes) {
      throw new RangeError("arena input systems do not match the authoritative bridge");
    }
    if (canonicalJson(this.#cards) !== this.#deployBridge.rosterBytes) {
      throw new RangeError("arena input cards do not match the authoritative bridge");
    }
    const deployments = this.#deployBridge.replay.filter(
      ({ type }) => type === "player-deployed" || type === "player-spell-cast",
    );
    for (const [index, deployment] of deployments.entries()) {
      const receipt = deployment.receipt;
      if (receipt.commandId !== index + 1) {
        throw new RangeError("arena input bridge command history is noncontiguous");
      }
      this.#actions.push({
        accepted: true,
        cardId: receipt.cardId,
        selectedCardId: receipt.cardId,
        sequence: this.#actions.length,
        type: "select",
      });
      this.#commands.push({
        cardId: receipt.cardId,
        cost: receipt.cost,
        id: receipt.commandId,
        point: clone(receipt.point),
        sequence: this.#commands.length,
        side: receipt.side,
        spendSequence: receipt.spendSequence,
        tick: receipt.tick,
        type: receipt.type,
      });
      this.#actions.push({
        commandId: receipt.commandId,
        point: clone(receipt.point),
        sequence: this.#actions.length,
        type: "place",
      });
    }
  }

  select(cardId) {
    return this.#runMutation(() => this.#selectActive(cardId));
  }

  #selectActive(cardId) {
    if (typeof cardId !== "string" || cardId.length === 0) {
      throw new TypeError("selected card ID must be a non-empty string");
    }
    if (!this.#deck.state.hand.includes(cardId)) {
      return freezeGraph({
        accepted: false,
        cardId,
        reason: "not_in_hand",
        selectedCardId: this.#selectedCardId,
        type: "select",
      });
    }
    const card = cardMap(this.#cards).get(cardId);
    if (card === undefined) {
      throw new TypeError("selected card is missing from the runtime catalog");
    }
    if (this.#availableElixir() < card.cost) {
      return freezeGraph({
        accepted: false,
        cardId,
        reason: "insufficient_elixir",
        selectedCardId: this.#selectedCardId,
        type: "select",
      });
    }
    if (this.#selectedCardId === cardId) return this.#cancelActive();
    this.#assertActionCapacity();
    const previous = this.#selectedCardId;
    this.#selectedCardId = cardId;
    try {
      this.#hudUpdate(cardId);
    } catch (error) {
      this.#selectedCardId = previous;
      throw error;
    }
    const event = {
      accepted: true,
      cardId,
      sequence: this.#actions.length,
      selectedCardId: cardId,
      type: "select",
    };
    this.#actions.push(event);
    return freezeGraph(clone(event));
  }

  cancel() {
    return this.#runMutation(() => this.#cancelActive());
  }

  #cancelActive() {
    if (this.#selectedCardId === null) {
      return freezeGraph({
        accepted: false,
        reason: "nothing_selected",
        selectedCardId: null,
        type: "cancel",
      });
    }
    this.#assertActionCapacity();
    const cardId = this.#selectedCardId;
    this.#selectedCardId = null;
    try {
      this.#hudUpdate(null);
    } catch (error) {
      this.#selectedCardId = cardId;
      throw error;
    }
    const event = {
      accepted: true,
      cardId,
      sequence: this.#actions.length,
      selectedCardId: null,
      type: "cancel",
    };
    this.#actions.push(event);
    return freezeGraph(clone(event));
  }

  placeArenaPoint(pointValue) {
    return this.#runMutation(() => this.#placeArenaPointActive(pointValue));
  }

  #placeArenaPointActive(pointValue) {
    const point = validateArenaPoint(pointValue, "arena input point");
    const selected = this.#selectedCardId;
    if (selected === null) {
      return freezeGraph({
        accepted: false,
        point,
        reason: "nothing_selected",
        type: "place",
      });
    }
    const card = cardMap(this.#cards).get(selected);
    if (card === undefined || !this.#deck.state.hand.includes(selected)) {
      return freezeGraph({
        accepted: false,
        point,
        reason: "card_unavailable",
        type: "place",
      });
    }
    if (this.#availableElixir() < card.cost) {
      return freezeGraph({
        accepted: false,
        point,
        reason: "insufficient_elixir",
        type: "place",
      });
    }
    const decision = evaluateDeployment({
      destroyedOpposingLaneTowers: [],
      placementClass: card.kind === "effect" ? "global_effect" : "ground_entity",
      point,
      side: LOCAL_SIDE,
    });
    if (!decision.legal) {
      return freezeGraph({
        accepted: false,
        confidence: decision.confidence,
        point,
        reason: decision.reason,
        type: "place",
      });
    }
    this.#assertActionCapacity();
    if (this.#deck.state.sequence >= DECK_MAX_PLAY_COMMANDS) {
      throw new RangeError("arena input deck command limit reached");
    }
    const tick = this.#elixir.tick;
    const slot = this.#deck.state.hand.indexOf(selected);
    if (this.#deployBridge !== null) {
      const parsedElixir = JSON.parse(this.#elixir.serialize());
      const spendSequence = parsedElixir.commands.length +
        (Array.isArray(parsedElixir.grants) ? parsedElixir.grants.length : 0);
      const commandId = this.#commandIdOffset + this.#commands.length + 1;
      const type = card.kind === "effect" ? "spell" : "deploy";
      const intent = createPlayerDeployIntent({
        accepted: true,
        cardId: selected,
        commandId,
        cost: card.cost,
        point,
        side: LOCAL_SIDE,
        slot,
        spendSequence,
        tick,
        type,
      });
      const prepared = this.#deployBridge.prepare(intent);
      const projection = this.#deployBridge.preparedResult(prepared);
      const command = {
        cardId: selected,
        cost: card.cost,
        id: commandId,
        point,
        sequence: this.#commands.length,
        side: LOCAL_SIDE,
        spendSequence,
        tick,
        type,
      };
      const action = {
        commandId,
        point,
        sequence: this.#actions.length,
        type: "place",
      };
      this.#deployBridge.commitPrepared(prepared);
      this.#deck = DeckCycle.restore(this.#deployBridge.deckBytes);
      this.#elixir = ElixirMatch.restore(this.#deployBridge.elixirBytes);
      this.#commands.push(command);
      this.#selectedCardId = null;
      this.#actions.push(action);
      const immutableProjection = systemSnapshot(
        DeckCycle.restore(projection.deckBytes),
        ElixirMatch.restore(projection.elixirBytes),
      );
      try {
        const hudResult = this.#hudUpdate(null, immutableProjection);
        if (hudResult !== null &&
            (typeof hudResult === "object" || typeof hudResult === "function") &&
            typeof hudResult.then === "function") {
          throw new TypeError("arena input authoritative HUD returned a thenable");
        }
        const commitResult = this.#commitSystems(immutableProjection);
        if (commitResult !== null &&
            (typeof commitResult === "object" || typeof commitResult === "function") &&
            typeof commitResult.then === "function") {
          throw new TypeError("arena input authoritative system publisher returned a thenable");
        }
      } catch (error) {
        this.#faultCode = AUTHORITATIVE_PROJECTION_FAULT;
        throw frozenAggregate(
          "arena input authoritative state committed but projection failed",
          ["authoritative projection callback failed"],
        );
      }
      return freezeGraph({
        accepted: true,
        command: clone(command),
        confidence: decision.confidence,
        reason: decision.reason,
        type: "place",
      });
    }
    // Build the complete next canonical state on isolated causal restores.
    // Neither live systems nor controller state changes unless HUD binding
    // succeeds for that exact projected state.
    const nextDeck = DeckCycle.restore(this.#deck.serializeJson());
    const nextElixir = ElixirMatch.restore(this.#elixir.serialize());
    const spendSequence = nextElixir.scheduleSpend(
      tick,
      LOCAL_SIDE,
      card.cost,
    );
    const deckEvent = nextDeck.play(selected);
    if (!deckEvent.accepted) {
      throw new Error("canonical deck rejected a prevalidated arena play");
    }
    const nextProjection = systemSnapshot(nextDeck, nextElixir);
    this.#hudUpdate(null, nextProjection);
    try {
      this.#commitSystems(nextProjection);
    } catch (error) {
      const rollbackErrors = [];
      const rollbackProjection = systemSnapshot(this.#deck, this.#elixir);
      try {
        this.#commitSystems(rollbackProjection);
      } catch (caught) {
        rollbackErrors.push(caught);
      }
      try {
        this.#hudUpdate(selected, rollbackProjection);
      } catch (caught) {
        rollbackErrors.push(caught);
      }
      if (rollbackErrors.length > 0) {
        this.#faultCode = COMMIT_ROLLBACK_FAULT;
        throw frozenAggregate(
          "arena input commit failed and could not be fully rolled back",
          ["candidate publication failed", ...rollbackErrors.map(() => "rollback callback failed")],
        );
      }
      throw error;
    }
    const command = {
      cardId: selected,
      cost: card.cost,
      id: this.#commandIdOffset + this.#commands.length + 1,
      point,
      sequence: this.#commands.length,
      side: LOCAL_SIDE,
      spendSequence,
      tick,
      type: card.kind === "effect" ? "spell" : "deploy",
    };
    const action = {
      commandId: command.id,
      point,
      sequence: this.#actions.length,
      type: "place",
    };
    this.#deck = nextDeck;
    this.#elixir = nextElixir;
    this.#commands.push(command);
    this.#selectedCardId = null;
    this.#actions.push(action);
    return freezeGraph({
      accepted: true,
      command: clone(command),
      confidence: decision.confidence,
      reason: decision.reason,
      type: "place",
    });
  }

  placeClientPoint(rect, point) {
    return this.#runMutation(() => this.#placeClientPointActive(rect, point));
  }

  #placeClientPointActive(rect, point) {
    const arenaPoint = clientPointToArenaPoint(rect, point);
    if (arenaPoint === null) {
      return freezeGraph({
        accepted: false,
        point: null,
        reason: "outside_client_bounds",
        type: "place",
      });
    }
    return this.#placeArenaPointActive(arenaPoint);
  }

  serialize() {
    // Snapshots are continuation capabilities, so terminally faulted or
    // disposed controllers deliberately cannot serialize/restore a runnable
    // continuation. Immutable last-committed deck/elixir getters remain
    // available for diagnostics.
    this.#assertHealthy();
    return canonicalJson({
      actions: this.#actions,
      commands: this.#commands,
      deck: JSON.parse(this.#deck.serializeJson()),
      elixir: JSON.parse(this.#elixir.serialize()),
      initialDeck: this.#initialDeck,
      initialElixir: this.#initialElixir,
      selectedCardId: this.#selectedCardId,
      version: 1,
    });
  }

  static restore(serialized, options) {
    if (typeof serialized !== "string") {
      throw new TypeError("serialized arena input must be a string");
    }
    let snapshot;
    try {
      snapshot = JSON.parse(serialized);
    } catch {
      throw new TypeError("serialized arena input must be valid JSON");
    }
    const checked = exactRecord(
      snapshot,
      [
        "actions",
        "commands",
        "deck",
        "elixir",
        "initialDeck",
        "initialElixir",
        "selectedCardId",
        "version",
      ],
      "arena input snapshot",
    );
    if (checked.version !== 1) {
      throw new TypeError("arena input snapshot has an unsupported version");
    }
    if (
      !Array.isArray(checked.actions) ||
      checked.actions.length > MAX_ACTIONS
    ) {
      throw new TypeError("arena input snapshot actions are invalid");
    }
    const restoreOptions = exactRecord(
      options,
      ["cards", "hudUpdate"],
      "arena input restore options",
    );
    const controller = new ArenaInputController({
      cards: restoreOptions.cards,
      commitSystems() {},
      deck: DeckCycle.restore(canonicalJson(checked.initialDeck)),
      elixir: ElixirMatch.restore(canonicalJson(checked.initialElixir)),
      hudUpdate() {},
    });
    for (let index = 0; index < checked.actions.length; index += 1) {
      const action = checked.actions[index];
      if (action?.type === "select") {
        const entry = exactRecord(
          action,
          ["accepted", "cardId", "selectedCardId", "sequence", "type"],
          `arena input action ${index}`,
        );
        if (
          entry.accepted !== true ||
          entry.sequence !== index ||
          entry.selectedCardId !== entry.cardId
        ) {
          throw new TypeError(`arena input action ${index} is incoherent`);
        }
        controller.select(entry.cardId);
      } else if (action?.type === "cancel") {
        const entry = exactRecord(
          action,
          ["accepted", "cardId", "selectedCardId", "sequence", "type"],
          `arena input action ${index}`,
        );
        if (
          entry.accepted !== true ||
          entry.sequence !== index ||
          entry.selectedCardId !== null
        ) {
          throw new TypeError(`arena input action ${index} is incoherent`);
        }
        controller.cancel();
      } else if (action?.type === "place") {
        const entry = exactRecord(
          action,
          ["commandId", "point", "sequence", "type"],
          `arena input action ${index}`,
        );
        if (
          entry.sequence !== index ||
          entry.commandId !== controller.#commands.length + 1
        ) {
          throw new TypeError(`arena input action ${index} is incoherent`);
        }
        const result = controller.placeArenaPoint(entry.point);
        if (!result.accepted || result.command.id !== entry.commandId) {
          throw new TypeError(`arena input action ${index} cannot be replayed`);
        }
      } else {
        throw new TypeError(`arena input action ${index} has an invalid type`);
      }
    }
    if (controller.serialize() !== canonicalJson(checked)) {
      throw new TypeError("arena input snapshot is not a canonical causal state");
    }
    controller.#hudUpdate = restoreOptions.hudUpdate;
    controller.#hudUpdate(
      controller.#selectedCardId,
      systemSnapshot(controller.#deck, controller.#elixir),
    );
    return controller;
  }

  #assertActionCapacity() {
    if (this.#actions.length >= MAX_ACTIONS) {
      throw new RangeError("arena input action history limit reached");
    }
  }

  #assertHealthy() {
    if (this.#disposed) throw new Error("arena input is disposed");
    if (this.#faultCode !== null) {
      throw new Error(`arena input is poisoned: ${this.#faultCode}`);
    }
  }

  #runMutation(operation) {
    if (deliveryControllers.has(this)) {
      throw new Error("arena input reentrant feedback delivery rejected");
    }
    if (this.#operationActive) throw new Error("arena input reentrant operation rejected");
    this.#assertHealthy();
    this.#operationActive = true;
    mutationControllers.add(this);
    try {
      return operation();
    } finally {
      mutationControllers.delete(this);
      this.#operationActive = false;
    }
  }

  #availableElixir() {
    const state = this.#elixir.state;
    const amount = state.sides[LOCAL_SIDE].amount;
    const reserved = this.#commands
      .filter(({ tick }) => tick === state.tick)
      .reduce((total, { cost }) => total + cost, 0);
    return amount - reserved;
  }
}

function exactNodes(target, selector, count, label) {
  if (
    target === null ||
    (typeof target !== "object" && typeof target !== "function") ||
    typeof target.querySelectorAll !== "function"
  ) {
    throw new TypeError(`${label} target is invalid`);
  }
  const values = Array.from(target.querySelectorAll(selector));
  if (values.length !== count || new Set(values).size !== count) {
    throw new TypeError(`${label} must resolve to exactly ${count} unique nodes`);
  }
  return values;
}

function eventClientPoint(event, touch) {
  if (event === null || typeof event !== "object") {
    throw new TypeError("arena input event must be an object");
  }
  if (!touch) {
    return checkedClientPoint({
      clientX: event.clientX,
      clientY: event.clientY,
    });
  }
  const touches = event.changedTouches;
  if (
    touches === null ||
    typeof touches !== "object" ||
    touches.length !== 1
  ) {
    throw new TypeError("arena touch event must contain exactly one changed touch");
  }
  return checkedClientPoint({
    clientX: touches[0].clientX,
    clientY: touches[0].clientY,
  });
}

function arenaClientRect(arena) {
  const measured = arena.getBoundingClientRect();
  if (
    measured === null ||
    (typeof measured !== "object" && typeof measured !== "function")
  ) {
    throw new TypeError("arena border rectangle must be an object");
  }
  const border = checkedRect({
    height: measured.height,
    left: measured.left,
    top: measured.top,
    width: measured.width,
  });
  const metrics = {
    height: arena.clientHeight,
    left: arena.clientLeft,
    top: arena.clientTop,
    width: arena.clientWidth,
  };
  for (const [key, value] of Object.entries(metrics)) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new TypeError(`arena client metric ${key} must be finite`);
    }
  }
  if (
    metrics.left < 0 ||
    metrics.top < 0 ||
    metrics.width <= 0 ||
    metrics.height <= 0 ||
    metrics.left + metrics.width > border.width ||
    metrics.top + metrics.height > border.height
  ) {
    throw new TypeError("arena client metrics exceed the border box");
  }
  return checkedRect({
    height: metrics.height,
    left: border.left + metrics.left,
    top: border.top + metrics.top,
    width: metrics.width,
  });
}

function arenaEventFamily(arena) {
  const view = arena.ownerDocument?.defaultView;
  return (
    view !== null &&
    typeof view === "object" &&
    typeof view.PointerEvent === "function"
  ) ? "pointer" : "legacy";
}

function sameClientPoint(left, right) {
  return (
    left !== null &&
    left.clientX === right.clientX &&
    left.clientY === right.clientY
  );
}

/**
 * Browser seam: bind the four hand slots and arena to one deterministic input
 * controller. Returned direct handlers are also the browser smoke-test seam.
 */
export function mountArenaInputController(shell, hudCapability) {
  const admitted = hudCapabilities.get(hudCapability);
  if (admitted === undefined) {
    throw new TypeError("arena input HUD capability is invalid");
  }
  if (consumedHudCapabilities.has(hudCapability)) {
    throw new RangeError("arena input HUD capability is consumed");
  }
  // Consumption precedes construction and listener registration. Every mount
  // attempt is therefore exactly once, whether it succeeds or fails.
  consumedHudCapabilities.add(hudCapability);
  if (activeSinkAuthorities.has(admitted.sinkAuthority) ||
      (admitted.deployBridge !== null &&
       activeBridgeAuthorities.has(admitted.deployBridge))) {
    throw new RangeError("arena input HUD authority is already mounted");
  }
  activeSinkAuthorities.add(admitted.sinkAuthority);
  if (admitted.deployBridge !== null) activeBridgeAuthorities.add(admitted.deployBridge);
  activeHudCapabilities.add(hudCapability);
  const commitState = { active: true, sink: null };
  let authorityClaimed = true;
  const releaseMountAuthority = () => {
    if (!authorityClaimed) return;
    authorityClaimed = false;
    activeHudCapabilities.delete(hudCapability);
    activeSinkAuthorities.delete(admitted.sinkAuthority);
    if (admitted.deployBridge !== null) {
      activeBridgeAuthorities.delete(admitted.deployBridge);
    }
  };
  let arena;
  let hand;
  try {
    arena = exactNodes(shell, '[data-ui="arena"]', 1, "arena input arena")[0];
    hand = exactNodes(shell, '[data-ui="card-slot"]', 4, "arena input hand");
    if (
      typeof arena.getBoundingClientRect !== "function" ||
      typeof arena.addEventListener !== "function" ||
      hand.some((node) => typeof node.addEventListener !== "function")
    ) {
      throw new TypeError("arena input hooks must support browser events");
    }
  } catch {
    releaseMountAuthority();
    throw frozenAggregate("arena input mount shell validation failed",
      ["shell validation failed"]);
  }
  let input;
  try {
    const inputOptions = {
      cards: admitted.cards,
      commitSystems: admitted.commitSystems,
      commandIdOffset: admitted.commandIdOffset,
      deck: admitted.deck,
      elixir: admitted.elixir,
      hudUpdate: admitted.hudUpdate,
    };
    if (admitted.deployBridge !== null) inputOptions.deployBridge = admitted.deployBridge;
    input = new ArenaInputController(inputOptions);
    controllerDisposalHooks.set(input, () => {
      commitState.active = false;
      commitState.sink = null;
      releaseMountAuthority();
    });
  } catch {
    releaseMountAuthority();
    throw frozenAggregate("arena input mount controller construction failed",
      ["HUD controller registration failed"]);
  }
  const trustedReader = feedbackReaders.get(input);
  const placeClientPoint = input.placeClientPoint.bind(input);
  const selectCard = input.select.bind(input);
  let eventFamily;
  try {
    eventFamily = arenaEventFamily(arena);
  } catch {
    input.dispose();
    releaseMountAuthority();
    throw frozenAggregate("arena input mount initialization failed",
      ["event family detection failed"]);
  }
  let pendingTouchRelease = null;
  let feedback = null;
  let lastPreviewPoint = null;
  let spellPreview = null;
  if (arena.ownerDocument !== null && typeof arena.ownerDocument === "object" &&
      typeof arena.ownerDocument.createElement === "function" &&
      typeof arena.appendChild === "function") {
    spellPreview = arena.ownerDocument.createElement("div");
    spellPreview.className = "squall-orb-radius-preview";
    spellPreview.setAttribute("aria-hidden", "true");
    Object.assign(spellPreview.style, {
      background: "rgba(243, 117, 47, 0.19)",
      border: "2px solid rgba(255, 198, 117, 0.92)",
      borderRadius: "50%",
      display: "none",
      pointerEvents: "none",
      position: "absolute",
      transform: "translateZ(0)",
      zIndex: "18",
    });
    arena.appendChild(spellPreview);
  }
  const updateSpellPreview = (clientPoint = lastPreviewPoint) => {
    if (spellPreview === null) return;
    const selectedCardId = trustedReader().selectedCardId;
    const card = cardMap(admitted.cards).get(selectedCardId);
    const radius = card?.kind === "effect" ? card.areaDamageRadiusMillitiles : null;
    if (!Number.isSafeInteger(radius) || radius <= 0) {
      spellPreview.style.display = "none";
      return;
    }
    const rect = arenaClientRect(arena);
    const point = clientPoint ?? {
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
    };
    if (point.clientX < rect.left || point.clientX > rect.left + rect.width ||
        point.clientY < rect.top || point.clientY > rect.top + rect.height) {
      spellPreview.style.display = "none";
      return;
    }
    const radiusPixels = radius * rect.width / ARENA_WIDTH_MILLITILES;
    spellPreview.style.width = `${radiusPixels * 2}px`;
    spellPreview.style.height = `${radiusPixels * 2}px`;
    spellPreview.style.left = `${point.clientX - rect.left - radiusPixels}px`;
    spellPreview.style.top = `${point.clientY - rect.top - radiusPixels}px`;
    spellPreview.dataset.radiusMillitiles = String(radius);
    spellPreview.style.display = "block";
  };
  let teardownMounted;
  const assertSeamMutation = () => {
    if (deliveryControllers.has(input) || mutationControllers.has(input)) {
      throw new Error("arena input reentrant browser mutation rejected");
    }
  };
  const notify = (
    method,
    result,
    selectedCardIdBefore = null,
    slotBefore = -1,
  ) => {
    if (deliveryControllers.has(input)) {
      throw new Error("arena input reentrant feedback delivery rejected");
    }
    deliveryControllers.add(input);
    try {
      if (method === "onPlace") {
        deliverArenaInputCommit(
          commitState,
          result,
          selectedCardIdBefore,
          slotBefore,
        );
      }
      if (feedback !== null) {
        if (method === "onPlace") {
          feedback.onPlace(issueArenaInputFeedbackReceipt(
            input,
            result,
            selectedCardIdBefore,
          ));
        } else {
          feedback.onSelect(result, trustedReader().selectedCardId);
        }
      }
      if (method === "onPlace" || method === "onSelect") updateSpellPreview();
      return result;
    } finally {
      deliveryControllers.delete(input);
    }
  };
  const onCard = (event) => {
    assertSeamMutation();
    return notify(
      "onSelect",
      selectCard(event.currentTarget.dataset.cardId),
    );
  };
  const onPointer = (event) => {
    assertSeamMutation();
    const before = trustedReader();
    const selectedCardIdBefore = before.selectedCardId;
    return notify(
      "onPlace",
      placeClientPoint(
        arenaClientRect(arena),
        eventClientPoint(event, false),
      ),
      selectedCardIdBefore,
      before.deck.hand.indexOf(selectedCardIdBefore),
    );
  };
  const onPointerMove = (event) => {
    lastPreviewPoint = eventClientPoint(event, false);
    updateSpellPreview(lastPreviewPoint);
  };
  const onTouch = (event) => {
    assertSeamMutation();
    const before = trustedReader();
    const selectedCardIdBefore = before.selectedCardId;
    const point = eventClientPoint(event, true);
    pendingTouchRelease = point;
    return notify(
      "onPlace",
      placeClientPoint(
        arenaClientRect(arena),
        point,
      ),
      selectedCardIdBefore,
      before.deck.hand.indexOf(selectedCardIdBefore),
    );
  };
  const onTouchMove = (event) => {
    lastPreviewPoint = eventClientPoint(event, true);
    updateSpellPreview(lastPreviewPoint);
  };
  const onMouse = (event) => {
    assertSeamMutation();
    const point = eventClientPoint(event, false);
    if (
      event.sourceCapabilities?.firesTouchEvents === true ||
      sameClientPoint(pendingTouchRelease, point)
    ) {
      pendingTouchRelease = null;
      return Object.freeze({
        accepted: false,
        point: null,
        reason: "compatibility_mouse_suppressed",
        type: "place",
      });
    }
    pendingTouchRelease = null;
    const before = trustedReader();
    const selectedCardIdBefore = before.selectedCardId;
    return notify(
      "onPlace",
      placeClientPoint(arenaClientRect(arena), point),
      selectedCardIdBefore,
      before.deck.hand.indexOf(selectedCardIdBefore),
    );
  };
  const onMouseMove = (event) => {
    lastPreviewPoint = eventClientPoint(event, false);
    updateSpellPreview(lastPreviewPoint);
  };
  const setFeedback = (next) => {
    if (!mounted) throw new Error("arena input mount is disposed");
    assertSeamMutation();
    if (next === null) {
      feedback = null;
      return;
    }
    let checked;
    try {
      checked = exactRecord(next, ["onPlace", "onSelect"],
        "arena input feedback hook");
    } catch {
      const cleanupErrors = teardownMounted();
      throw frozenAggregate("arena input feedback registration failed: invalid hook",
        ["feedback hook is invalid", ...cleanupErrors]);
    }
    if (typeof checked.onPlace !== "function" || typeof checked.onSelect !== "function") {
      const cleanupErrors = teardownMounted();
      throw frozenAggregate("arena input feedback registration failed: invalid hook",
        ["feedback hook is invalid", ...cleanupErrors]);
    }
    feedback = Object.freeze(checked);
  };
  const getClientRect = () => arenaClientRect(arena);
  const registrations = [];
  const register = (node, type, listener) => {
    // Record first: a hostile hook may install and then throw.
    registrations.push({ listener, node, type });
    node.addEventListener(type, listener);
  };
  const unregisterAll = () => {
    const errors = [];
    for (let index = registrations.length - 1; index >= 0; index -= 1) {
      const { listener, node, type } = registrations[index];
      try {
        node.removeEventListener?.(type, listener);
      } catch {
        errors.push("listener removal failed");
        // A hook may throw after, or transiently before, detaching. Retry once
        // while still reporting the deterministic teardown fault.
        try { node.removeEventListener?.(type, listener); } catch {
          errors.push("listener removal retry failed");
        }
      }
    }
    registrations.length = 0;
    try { spellPreview?.remove?.(); } catch { errors.push("spell preview removal failed"); }
    return errors;
  };
  try {
    for (const node of hand) register(node, "click", onCard);
    if (eventFamily === "pointer") {
      register(arena, "pointermove", onPointerMove);
      register(arena, "pointerup", onPointer);
    } else {
      register(arena, "touchmove", onTouchMove);
      register(arena, "mousemove", onMouseMove);
      register(arena, "touchend", onTouch);
      register(arena, "mouseup", onMouse);
    }
  } catch {
    const cleanupErrors = unregisterAll();
    try { input.dispose(); } catch { cleanupErrors.push("controller disposal failed"); }
    releaseMountAuthority();
    throw frozenAggregate(
      "arena input mount registration failed",
      ["listener registration failed", ...cleanupErrors],
    );
  }
  let mounted = true;
  teardownMounted = () => {
    if (!mounted) return [];
    const cleanupErrors = [];
    try { input.dispose(); } catch { cleanupErrors.push("controller disposal failed"); }
    mounted = false;
    feedback = null;
    commitState.active = false;
    commitState.sink = null;
    releaseMountAuthority();
    cleanupErrors.push(...unregisterAll());
    return cleanupErrors;
  };
  const cleanup = () => {
    if (!mounted) return false;
    // Reentrant disposal rejects before teardownMounted can alter mount state.
    input.dispose();
    const cleanupErrors = teardownMounted();
    if (cleanupErrors.length > 0) {
      throw frozenAggregate("arena input mount cleanup failed", cleanupErrors);
    }
    return true;
  };
  const createContinuationCapability = () => {
    if (mounted) {
      throw new Error("arena input continuation requires cleanup first");
    }
    if (admitted.deployBridge === null) {
      throw new Error("legacy arena input has no authoritative continuation cursor");
    }
    return createArenaInputHudCapability(
      admitted.cardsText,
      admitted.deployBridge.deckBytes,
      admitted.deployBridge.elixirBytes,
      admitted.commitSystems,
      admitted.hudUpdate,
      createArenaInputBridgeWitness(admitted.deployBridge),
    );
  };
  const browserInput = Object.freeze({
    cards: Object.freeze(
      trustedReader().cards.map(({ cost, displayName, id }) =>
        Object.freeze({ cost, displayName, id })),
    ),
    cleanup,
    createContinuationCapability,
    eventFamily,
    getClientRect,
    input,
    onCard,
    onMouse,
    onPointer,
    onTouch,
    get selectedCardId() { return trustedReader().selectedCardId; },
    setFeedback,
  });
  mountedCommitStates.set(browserInput, commitState);
  return browserInput;
}
