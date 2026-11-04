import { DeckCycle } from "./deck.js";
import { evaluateDeployment } from "./deployment.js";
import { ElixirMatch } from "./elixir.js";
import { LiveBattle } from "./live-battle.js";
import { validateArenaPoint } from "./arena-geometry.js";

export const MAX_PLAYER_DEPLOY_COMMANDS = 10_000;
const MAX_SNAPSHOT_BYTES = 16_777_216;
const MAX_PARSED_DEPTH = 256;
const MAX_PARSED_NODES = 100_000;
const INTENTS = new WeakMap();
const PREPARED = new WeakMap();
const PLAYER_DEPLOY_BRIDGES = new WeakSet();
const RECEIPT_KEYS = [
  "accepted", "cardId", "commandId", "cost", "point", "side", "slot",
  "spendSequence", "tick", "type",
];

function plain(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype &&
       Object.getPrototypeOf(value) !== null) ||
      Object.getOwnPropertySymbols(value).length !== 0) {
    throw new TypeError(`${label} must be a plain string-keyed data object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
      throw new TypeError(`${label}.${key} must be an enumerable data property`);
    }
  }
  return descriptors;
}

function exact(value, keys, label) {
  const descriptors = plain(value, label);
  const actual = Reflect.ownKeys(descriptors).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length ||
      actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${label} has an invalid shape`);
  }
  return Object.fromEntries(keys.map((key) => [key, descriptors[key].value]));
}

function dense(value, label, maximum) {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new TypeError(`${label} must be a bounded array`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (key === "length") continue;
    if (typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key) ||
        Number(key) >= value.length) {
      throw new TypeError(`${label} must contain only indexed data`);
    }
  }
  return Array.from({ length: value.length }, (_, index) => {
    const descriptor = descriptors[index];
    if (descriptor === undefined || !descriptor.enumerable ||
        !Object.hasOwn(descriptor, "value")) {
      throw new TypeError(`${label}[${index}] must be an enumerable data property`);
    }
    return descriptor.value;
  });
}

function integer(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label} must be a safe integer from ${minimum} through ${maximum}`);
  }
  return value;
}

function string(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.length > 128) {
    throw new TypeError(`${label} must be a bounded non-empty string`);
  }
  return value;
}

function clone(value) { return JSON.parse(JSON.stringify(value)); }

function freeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function assertUnicodeScalars(value, label) {
  if (typeof value !== "string") return;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new TypeError(`${label} contains an unpaired Unicode surrogate`);
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new TypeError(`${label} contains an unpaired Unicode surrogate`);
    }
  }
}

function preflightGraph(root, label) {
  const pending = [{ depth: 0, value: root }];
  let nodes = 0;
  while (pending.length > 0) {
    const { depth, value } = pending.pop();
    nodes += 1;
    if (nodes > MAX_PARSED_NODES) throw new RangeError(`${label} node bound exceeded`);
    if (depth > MAX_PARSED_DEPTH) throw new RangeError(`${label} depth bound exceeded`);
    if (typeof value === "string") assertUnicodeScalars(value, label);
    if (value === null || typeof value !== "object") continue;
    for (const [key, child] of Object.entries(value)) {
      assertUnicodeScalars(key, label);
      pending.push({ depth: depth + 1, value: child });
    }
  }
}

function parseBoundedCanonical(text, label, maximumBytes = MAX_SNAPSHOT_BYTES) {
  if (typeof text !== "string") throw new TypeError(`${label} must be primitive JSON text`);
  if (new TextEncoder().encode(text).byteLength > maximumBytes) {
    throw new RangeError(`${label} exceeds its byte bound`);
  }
  let parsed;
  try { parsed = JSON.parse(text); }
  catch { throw new TypeError(`${label} must be valid JSON`); }
  preflightGraph(parsed, label);
  if (canonical(parsed) !== text) throw new TypeError(`${label} must be canonical JSON`);
  return parsed;
}

function checkedCards(value) {
  const cards = dense(value, "player deploy cards", 8).map((raw, index) => {
    const card = exact(raw, ["cost", "id"], `player deploy card ${index}`);
    return {
      cost: integer(card.cost, 1, 10, `player deploy card ${index}.cost`),
      id: string(card.id, `player deploy card ${index}.id`),
    };
  });
  if (cards.length !== 8 || new Set(cards.map(({ id }) => id)).size !== 8) {
    throw new TypeError("player deploy cards must contain eight unique identities");
  }
  return cards;
}

function checkedReceipt(value) {
  const receipt = exact(value, RECEIPT_KEYS, "player deploy receipt");
  if (receipt.accepted !== true || !["deploy", "spell"].includes(receipt.type)) {
    throw new TypeError("player deploy receipt must be accepted deploy or spell intent");
  }
  const point = validateArenaPoint(receipt.point, "player deploy receipt.point");
  if (receipt.side !== "south") {
    throw new TypeError("player deploy receipt.side must be south");
  }
  return {
    accepted: true,
    cardId: string(receipt.cardId, "player deploy receipt.cardId"),
    commandId: integer(receipt.commandId, 1, MAX_PLAYER_DEPLOY_COMMANDS,
      "player deploy receipt.commandId"),
    cost: integer(receipt.cost, 1, 10, "player deploy receipt.cost"),
    point: { ...point },
    side: "south",
    slot: integer(receipt.slot, 0, 3, "player deploy receipt.slot"),
    spendSequence: integer(receipt.spendSequence, 0, Number.MAX_SAFE_INTEGER,
      "player deploy receipt.spendSequence"),
    tick: integer(receipt.tick, 0, 18_000, "player deploy receipt.tick"),
    type: receipt.type,
  };
}

/** Create the browser-portable opaque pre-commit intent authority. */
export function createPlayerDeployIntent(value) {
  const checked = checkedReceipt(value);
  const intent = Object.freeze(Object.create(null));
  INTENTS.set(intent, checked);
  return intent;
}

function receiptFromAuthority(value) {
  if (typeof value === "string") {
    return checkedReceipt(parseBoundedCanonical(value,
      "player deploy intent", 16_384));
  }
  if (value !== null && typeof value === "object" && INTENTS.has(value)) {
    return clone(INTENTS.get(value));
  }
  throw new TypeError("player deploy intent must be canonical JSON text or a private branded intent");
}

function derivedRoster(battleBytes) {
  const parsed = JSON.parse(battleBytes);
  return parsed.setup.roster.map(({ cost, id }) => ({ cost, id }));
}

function derivedHudRoster(battleBytes) {
  return JSON.parse(battleBytes).setup.roster;
}

/**
 * Single authority for a player's deck, elixir and live-battle mutations.
 *
 * A receipt is pre-commit browser intent/provenance. The browser input layer
 * must not separately commit its private deck or elixir state before routing
 * the intent here; doing so would create two authorities and double-spend.
 */
export class PlayerDeployBridge {
  #battle;
  #cards;
  #deck;
  #elixir;
  #events = [];
  #epoch = 0;
  #history = [];
  #initial;
  #results = new Map();
  #outstanding = null;

  constructor(options) {
    if (new.target !== PlayerDeployBridge) {
      throw new TypeError("player deploy bridge subclass construction is forbidden");
    }
    const checked = exact(options, ["battle", "cards", "deck", "elixir"],
      "player deploy options");
    if (Object.getPrototypeOf(checked.battle) !== LiveBattle.prototype ||
        Object.getPrototypeOf(checked.deck) !== DeckCycle.prototype ||
        Object.getPrototypeOf(checked.elixir) !== ElixirMatch.prototype) {
      throw new TypeError("player deploy systems must be exact canonical system instances");
    }
    this.#cards = checkedCards(checked.cards);
    const battleBytes = checked.battle.serialize();
    const deckBytes = checked.deck.serializeJson();
    const elixirBytes = checked.elixir.serialize();
    if (canonical(derivedRoster(battleBytes)) !== canonical(this.#cards)) {
      throw new TypeError("player deploy cards must exactly match the live battle roster");
    }
    if (canonical(JSON.parse(deckBytes).deck) !==
        canonical(this.#cards.map(({ id }) => id))) {
      throw new TypeError("player deploy deck must exactly match the live battle roster order");
    }
    this.#battle = LiveBattle.restore(battleBytes);
    this.#deck = DeckCycle.restore(deckBytes);
    this.#elixir = ElixirMatch.restore(elixirBytes);
    if (this.#battle.state.tick !== this.#elixir.tick) {
      throw new RangeError("player deploy battle and elixir ticks must agree");
    }
    this.#initial = { battle: battleBytes, deck: deckBytes, elixir: elixirBytes };
    Object.freeze(this);
    PLAYER_DEPLOY_BRIDGES.add(this);
  }

  get state() {
    return freeze({
      battle: clone(this.#battle.state),
      deck: clone(this.#deck.state),
      elixir: clone(this.#elixir.state),
      processedCommandIds: [...this.#results.keys()].sort((a, b) => a - b),
      tick: this.#battle.state.tick,
    });
  }

  get replay() { return freeze(clone(this.#events)); }

  get deckBytes() { return this.#deck.serializeJson(); }
  get elixirBytes() { return this.#elixir.serialize(); }
  get rosterBytes() { return canonical(derivedHudRoster(this.#battle.serialize())); }

  play(receiptValue) {
    const prepared = this.prepare(receiptValue);
    return this.commitPrepared(prepared);
  }

  prepare(receiptValue) {
    if (this.#outstanding !== null) {
      throw new RangeError("player deploy already has an outstanding prepared transaction");
    }
    const receipt = receiptFromAuthority(receiptValue);
    const baseBytes = this.serialize();
    const prior = this.#results.get(receipt.commandId);
    if (prior !== undefined) {
      if (prior.receiptBytes !== canonical(receipt)) {
        throw new RangeError("player deploy command identity has divergent payload");
      }
      const token = Object.freeze(Object.create(null));
      PREPARED.set(token, { baseBytes, candidate: null, epoch: this.#epoch,
        owner: this, result: clone(prior.result) });
      this.#outstanding = token;
      return token;
    }
    if (this.#history.length >= MAX_PLAYER_DEPLOY_COMMANDS) {
      throw new RangeError("player deploy command history bound exceeded");
    }
    const candidate = this.#runtimeClone();
    const result = candidate.#apply(receipt);
    const token = Object.freeze(Object.create(null));
    PREPARED.set(token, { baseBytes, candidate, epoch: this.#epoch,
      owner: this, result: clone(result) });
    this.#outstanding = token;
    return token;
  }

  preparedResult(token) {
    const prepared = PREPARED.get(token);
    if (prepared === undefined || prepared.owner !== this ||
        this.#outstanding !== token || prepared.epoch !== this.#epoch ||
        prepared.baseBytes !== this.serialize()) {
      throw new TypeError("player deploy prepared transaction is invalid or consumed");
    }
    const systems = prepared.candidate ?? this;
    return freeze({
      deckBytes: systems.#deck.serializeJson(),
      elixirBytes: systems.#elixir.serialize(),
      result: clone(prepared.result),
    });
  }

  commitPrepared(token) {
    const prepared = PREPARED.get(token);
    if (prepared === undefined || prepared.owner !== this ||
        this.#outstanding !== token || prepared.epoch !== this.#epoch ||
        prepared.baseBytes !== this.serialize()) {
      throw new TypeError("player deploy prepared transaction is invalid or consumed");
    }
    PREPARED.delete(token);
    this.#outstanding = null;
    if (prepared.candidate !== null) this.#adopt(prepared.candidate);
    this.#epoch += 1;
    return freeze(clone(prepared.result));
  }

  step() { return this.stepMany(1); }

  stepMany(ticks) {
    integer(ticks, 0, 18_000, "player deploy step ticks");
    if (this.state.tick + ticks > 18_000 ||
        this.#history.length + ticks > MAX_PLAYER_DEPLOY_COMMANDS) {
      throw new RangeError("player deploy step/history bound exceeded");
    }
    const candidate = this.#runtimeClone();
    const results = [];
    for (let count = 0; count < ticks; count += 1) {
      const tick = candidate.#battle.state.tick;
      const elixirEvents = candidate.#elixir.step();
      const battleEvents = candidate.#battle.step(tick);
      const event = { battleEventCount: battleEvents.length,
        elixirEventCount: elixirEvents.length, tick, type: "step" };
      candidate.#events.push(event);
      candidate.#history.push({ tick, type: "step" });
      results.push(event);
    }
    this.#adopt(candidate);
    this.#outstanding = null;
    this.#epoch += 1;
    return freeze(clone(results));
  }

  serialize() {
    const bytes = canonical({
      cards: this.#cards,
      history: this.#history,
      initial: this.#initial,
      version: 1,
    });
    if (new TextEncoder().encode(bytes).byteLength > MAX_SNAPSHOT_BYTES) {
      throw new RangeError("serialized player deploy bridge exceeds byte bound");
    }
    return bytes;
  }

  static restore(serialized) {
    const snapshot = parseBoundedCanonical(serialized,
      "serialized player deploy bridge");
    const checked = exact(snapshot, ["cards", "history", "initial", "version"],
      "player deploy snapshot");
    if (checked.version !== 1) throw new TypeError("unsupported player deploy snapshot version");
    const initial = exact(checked.initial, ["battle", "deck", "elixir"],
      "player deploy snapshot.initial");
    for (const key of ["battle", "deck", "elixir"]) {
      if (typeof initial[key] !== "string") throw new TypeError(`snapshot.initial.${key} is invalid`);
    }
    const bridge = new PlayerDeployBridge({
      battle: LiveBattle.restore(initial.battle),
      cards: checked.cards,
      deck: DeckCycle.restore(initial.deck),
      elixir: ElixirMatch.restore(initial.elixir),
    });
    const history = dense(checked.history, "player deploy snapshot.history",
      MAX_PLAYER_DEPLOY_COMMANDS);
    for (let index = 0; index < history.length; index += 1) {
      const operation = history[index];
      plain(operation, `player deploy snapshot.history[${index}]`);
      if (operation.type === "play") {
        const entry = exact(operation, ["receipt", "type"], `history[${index}]`);
        bridge.play(canonical(entry.receipt));
      } else if (operation.type === "step") {
        const entry = exact(operation, ["tick", "type"], `history[${index}]`);
        if (entry.tick !== bridge.state.tick) throw new TypeError("noncausal player deploy step");
        bridge.step();
      } else throw new TypeError(`player deploy snapshot.history[${index}] is invalid`);
    }
    if (bridge.serialize() !== serialized) {
      throw new TypeError("player deploy snapshot is not canonical or causal");
    }
    return bridge;
  }

  #apply(receipt) {
    if (receipt.tick !== this.#battle.state.tick || receipt.tick !== this.#elixir.tick) {
      throw new RangeError("player deploy receipt tick is stale or future");
    }
    const card = this.#cards.find(({ id }) => id === receipt.cardId);
    if (card === undefined || card.cost !== receipt.cost) {
      throw new TypeError("player deploy receipt card/cost does not match the catalog");
    }
    if (this.#deck.state.hand[receipt.slot] !== receipt.cardId) {
      throw new RangeError("player deploy receipt card does not match its explicit hand slot");
    }
    const hasRadiusProfile = this.#battle.hasRadiusSpellProfile(receipt.cardId);
    const spell = receipt.type === "spell";
    if (spell !== hasRadiusProfile) {
      throw new RangeError("player spell receipt does not match an admitted radius profile");
    }
    const decision = evaluateDeployment({
      destroyedOpposingLaneTowers: [], placementClass: spell ? "global_effect" : "ground_entity",
      point: receipt.point, side: receipt.side,
    });
    if (!decision.legal) throw new RangeError(`player deploy placement is illegal: ${decision.reason}`);

    const spendSequence = this.#elixir.scheduleSpend(receipt.tick, receipt.side, receipt.cost);
    if (spendSequence !== receipt.spendSequence) {
      throw new RangeError("player deploy receipt spend sequence is noncanonical");
    }
    const deckEvent = this.#deck.play(receipt.cardId);
    if (!deckEvent.accepted || deckEvent.slot !== receipt.slot) {
      throw new Error("player deploy deck rejected a prevalidated receipt");
    }
    const intent = spell
      ? this.#battle.scheduleSpell({ cardId: receipt.cardId, point: receipt.point,
        sequence: receipt.commandId, side: receipt.side, tick: receipt.tick })
      : null;
    if (!spell) this.#battle.scheduleDeploy(canonical({
      cardId: receipt.cardId, point: receipt.point, sequence: receipt.commandId,
      side: receipt.side, tick: receipt.tick,
    }));
    const elixirEvents = this.#elixir.step();
    const spend = elixirEvents.find((event) => event.type === "spend" &&
      event.sequence === spendSequence);
    if (spend === undefined || !spend.accepted) {
      throw new RangeError("player deploy has insufficient elixir");
    }
    const battleEvents = this.#battle.step(receipt.tick);
    const deployment = spell ? null : battleEvents.find((event) => event.type === "deployed" &&
      event.sequence === receipt.commandId);
    if (!spell && (deployment === undefined || deployment.cardId !== receipt.cardId)) {
      throw new Error("player deploy battle did not materialize the receipt exactly once");
    }
    const event = spell ? {
      cardId: receipt.cardId, commandId: receipt.commandId, deck: clone(deckEvent),
      intent: clone(intent), point: { ...receipt.point }, receipt: clone(receipt),
      spend: clone(spend), tick: receipt.tick, type: "player-spell-cast",
    } : {
      cardId: receipt.cardId, commandId: receipt.commandId, deck: clone(deckEvent),
      deployment: clone(deployment), point: { ...receipt.point }, receipt: clone(receipt),
      spend: clone(spend), tick: receipt.tick, type: "player-deployed",
    };
    const result = spell ? {
      accepted: true, cardId: receipt.cardId, commandId: receipt.commandId,
      effectId: intent.effectId, point: { ...receipt.point }, tick: receipt.tick,
      type: "player-spell-result",
    } : {
      accepted: true, cardId: receipt.cardId, commandId: receipt.commandId,
      entityIds: clone(deployment.entityIds), point: { ...receipt.point },
      tick: receipt.tick, type: "player-deploy-result",
    };
    this.#events.push(event);
    this.#history.push({ receipt: clone(receipt), type: "play" });
    this.#results.set(receipt.commandId, {
      receiptBytes: canonical(receipt), result: clone(result),
    });
    return result;
  }

  #runtimeClone() {
    const candidate = new PlayerDeployBridge({
      battle: LiveBattle.restore(this.#battle.serialize()),
      cards: this.#cards,
      deck: DeckCycle.restore(this.#deck.serializeJson()),
      elixir: ElixirMatch.restore(this.#elixir.serialize()),
    });
    candidate.#events = clone(this.#events);
    candidate.#epoch = this.#epoch;
    candidate.#history = clone(this.#history);
    candidate.#initial = clone(this.#initial);
    candidate.#results = new Map([...this.#results].map(([id, value]) => [id, clone(value)]));
    candidate.#outstanding = null;
    return candidate;
  }

  #adopt(candidate) {
    this.#battle = candidate.#battle;
    this.#cards = candidate.#cards;
    this.#deck = candidate.#deck;
    this.#elixir = candidate.#elixir;
    this.#events = candidate.#events;
    this.#history = candidate.#history;
    this.#initial = candidate.#initial;
    this.#results = candidate.#results;
  }
}

/** Trap-free authenticity check owned by the bridge module itself. */
export function isPlayerDeployBridge(value) {
  return PLAYER_DEPLOY_BRIDGES.has(value);
}

Object.freeze(PlayerDeployBridge.prototype);

export const GamePlayerDeploy = PlayerDeployBridge;
