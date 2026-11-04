import { evaluateDeployment } from "./deployment.js";

export const SESSION_CARD_HISTORY_LIMIT = 20_000;
const authenticRuntimes = new WeakSet();

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
const clone = (value) => JSON.parse(JSON.stringify(value));
function freeze(value) { if (value && typeof value === "object" && !Object.isFrozen(value)) {
  for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value; }
function exact(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) throw new TypeError(`${label} must be a plain object`);
  const actual = Object.keys(value).sort(), expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${label} has an invalid shape`);
  }
  return value;
}
function parse(text, label, maximum = 2_000_000) {
  if (typeof text !== "string") throw new TypeError(`${label} must be canonical JSON text`);
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const low = text.charCodeAt(index + 1);
      if (!(low >= 0xdc00 && low <= 0xdfff)) throw new TypeError(`${label} contains a lone surrogate`);
      bytes += 4; index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new TypeError(`${label} contains a lone surrogate`);
    } else bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : 3;
  }
  if (bytes > maximum) throw new RangeError(`${label} exceeds its byte bound`);
  let value; try { value = JSON.parse(text); } catch { throw new TypeError(`${label} must be valid JSON`); }
  const stack = [{ depth: 0, value }]; let nodes = 0;
  while (stack.length) {
    const current = stack.pop(); nodes += 1;
    if (nodes > 10_000 || current.depth > 64) throw new RangeError(`${label} exceeds its graph bound`);
    const item = current.value;
    if (item === null || ["boolean", "number", "string"].includes(typeof item)) continue;
    if (!item || typeof item !== "object") throw new TypeError(`${label} contains invalid data`);
    const values = Array.isArray(item) ? item : Object.values(item);
    if (values.length > 20_000) throw new RangeError(`${label} exceeds its array/property bound`);
    for (let index = values.length - 1; index >= 0; index -= 1) {
      stack.push({ depth: current.depth + 1, value: values[index] });
    }
  }
  if (canonical(value) !== text) throw new TypeError(`${label} must be canonical JSON`);
  return value;
}
function checkedDeck(value) {
  if (!Array.isArray(value) || value.length !== 8 ||
      Object.getPrototypeOf(value) !== Array.prototype) {
    throw new TypeError("session card runtime deck must contain eight admission records");
  }
  const cards = value.map((raw, index) => {
    const card = exact(raw, ["cost", "id", "kind", "placementClass"],
      `session card runtime deck[${index}]`);
    if (!Number.isSafeInteger(card.cost) || card.cost < 1 || card.cost > 10 ||
        typeof card.id !== "string" || card.id.length === 0 ||
        !["effect", "structure", "unit"].includes(card.kind) ||
        card.placementClass !== (card.kind === "effect" ? "global_effect" : "ground_entity")) {
      throw new TypeError(`session card runtime deck[${index}] is invalid`);
    }
    return clone(card);
  });
  if (new Set(cards.map(({ id }) => id)).size !== 8) {
    throw new TypeError("session card runtime deck IDs must be unique");
  }
  return cards;
}
function checkedRoute(value) {
  const hasTarget = Object.hasOwn(value, "target");
  const route = exact(value, hasTarget
    ? ["cardId", "commandId", "point", "sequence", "side", "target", "tick"]
    : ["cardId", "commandId", "point", "sequence", "side", "tick"], "session card route");
  exact(route.point, ["x", "y"], "session card route.point");
  if (typeof route.cardId !== "string" || !["north", "south"].includes(route.side) ||
      !Number.isSafeInteger(route.commandId) || route.commandId < 0 ||
      !Number.isSafeInteger(route.sequence) || route.sequence < 0 ||
      !Number.isSafeInteger(route.tick) || route.tick < 0 ||
      !Number.isSafeInteger(route.point.x) || !Number.isSafeInteger(route.point.y)) {
    throw new TypeError("session card route is invalid");
  }
  if (!hasTarget) return clone(route);
  const target = exact(route.target, ["id", "kind"], "session card route.target");
  if (target.kind === "unit" && Number.isSafeInteger(target.id) && target.id > 0) {
    return { ...clone(route), target: { id: target.id, kind: target.kind } };
  }
  throw new TypeError("session card route.target must name one shared unit");
}

export function isAuthenticSessionCardRuntime(value) {
  return authenticRuntimes.has(value);
}

export class SessionCardRuntime {
  #cards;
  #admissions;
  #deck;
  #history = [];

  constructor(canonicalDeck) {
    const cards = checkedDeck(parse(canonicalDeck, "session card runtime deck", 16_384));
    this.#admissions = clone(cards);
    this.#deck = cards.map(({ id }) => id);
    this.#cards = new Map(cards.map((card) => [card.id, card]));
    if (new.target === SessionCardRuntime) authenticRuntimes.add(this);
  }

  get state() {
    const counts = { effect: 0, structure: 0, unit: 0 };
    for (const route of this.#history) counts[route.kind] += 1;
    return freeze({ cards: clone(this.#admissions), counts, deck: [...this.#deck],
      history: clone(this.#history) });
  }

  card(cardId) {
    if (typeof cardId !== "string") throw new TypeError("session runtime card ID must be primitive");
    const card = this.#cards.get(cardId);
    if (!card) throw new RangeError("session runtime card is not in the admitted deck");
    return freeze(clone(card));
  }

  route(canonicalRoute) {
    if (this.#history.length >= SESSION_CARD_HISTORY_LIMIT) {
      throw new RangeError("session card route history exceeds its bound");
    }
    const route = checkedRoute(parse(canonicalRoute, "session card route", 16_384));
    const card = this.card(route.cardId);
    if (this.#history.some((entry) => entry.sequence === route.sequence ||
        (entry.side === route.side && entry.commandId === route.commandId))) {
      throw new RangeError("session card route identity is duplicate");
    }
    const placement = evaluateDeployment({ destroyedOpposingLaneTowers: [],
      placementClass: card.placementClass, point: route.point, side: route.side });
    if (!placement.legal) throw new RangeError(`session card route is illegal: ${placement.reason}`);
    if (Object.hasOwn(route, "target") && card.kind !== "effect") {
      throw new TypeError("session card route target requires an effect card");
    }
    const event = { cardId: route.cardId, commandId: route.commandId,
      kind: card.kind, placementClass: card.placementClass, point: route.point,
      sequence: route.sequence, side: route.side, tick: route.tick,
      type: "session-card-routed" };
    if (Object.hasOwn(route, "target")) event.target = route.target;
    freeze(event);
    this.#history.push(clone(event));
    return event;
  }

  serialize() {
    return canonical({ cards: this.#admissions, history: this.#history, version: 1 });
  }

  fork() { return SessionCardRuntime.restore(this.serialize()); }

  static restore(serialized) {
    const value = exact(parse(serialized, "session card runtime snapshot"),
      ["cards", "history", "version"], "session card runtime snapshot");
    if (value.version !== 1 || !Array.isArray(value.history) ||
        value.history.length > SESSION_CARD_HISTORY_LIMIT) {
      throw new TypeError("session card runtime snapshot is unsupported or oversized");
    }
    const runtime = new SessionCardRuntime(canonical(value.cards));
    for (const route of value.history) {
      const input = exact(route, Object.hasOwn(route, "target")
        ? ["cardId", "commandId", "kind", "placementClass", "point", "sequence", "side",
          "target", "tick", "type"]
        : ["cardId", "commandId", "kind", "placementClass", "point", "sequence", "side",
          "tick", "type"], "session card history route");
      const card = runtime.card(input.cardId);
      if (input.type !== "session-card-routed" || input.kind !== card.kind ||
          input.placementClass !== card.placementClass) {
        throw new TypeError("session card history route diverges from its admitted card");
      }
      const reproduced = runtime.route(canonical({ cardId: input.cardId,
        commandId: input.commandId, point: input.point, sequence: input.sequence,
        side: input.side, ...(Object.hasOwn(input, "target") ? { target: input.target } : {}),
        tick: input.tick }));
      if (canonical(reproduced) !== canonical(input)) {
        throw new TypeError("session card history route is noncanonical");
      }
    }
    if (runtime.serialize() !== serialized) {
      throw new TypeError("session card runtime snapshot is noncanonical");
    }
    return runtime;
  }
}
