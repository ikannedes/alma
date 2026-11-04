import {
  MATCH_MAX_TICKS,
  MATCH_REGULATION_TICKS,
  MATCH_TICKS_PER_SECOND,
} from "../sim/match.js";
import {
  ELIXIR_ACCUMULATOR_DENOMINATOR,
  ELIXIR_CAPACITY,
} from "../sim/elixir.js";
import { DECK_MAX_PLAY_COMMANDS, DECK_SIZE, HAND_SIZE } from "../sim/deck.js";
import { getCardPortrait } from "./card-portrait-art.js";

const SIDES = Object.freeze(["north", "south"]);
const SIDE_SET = new Set(SIDES);
const CARD_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const MATCH_KEYS = Object.freeze([
  "crowns",
  "destroyedTowerIds",
  "phase",
  "result",
  "tick",
  "towers",
]);
const TOWER_IDS = Object.freeze([
  "north:central",
  "north:lane:left",
  "north:lane:right",
  "south:central",
  "south:lane:left",
  "south:lane:right",
]);
const CANONICAL_VIEWS = new WeakSet();

function dataObject(value, keys, label) {
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
  const actual = Reflect.ownKeys(descriptors);
  if (
    actual.length !== keys.length ||
    actual.some((key) => typeof key !== "string" || !keys.includes(key))
  ) {
    throw new TypeError(`${label} has an invalid shape`);
  }
  const copy = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (
      !descriptor ||
      !descriptor.enumerable ||
      !Object.hasOwn(descriptor, "value")
    ) {
      throw new TypeError(`${label}.${key} must be an enumerable data property`);
    }
    copy[key] = descriptor.value;
  }
  return copy;
}

function dataArray(value, length, label) {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length !== length ||
    Object.getOwnPropertySymbols(value).length !== 0
  ) {
    throw new TypeError(`${label} must be a plain array of length ${length}`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const allowed = new Set([
    "length",
    ...Array.from({ length }, (_, index) => String(index)),
  ]);
  if (Reflect.ownKeys(descriptors).some((key) => !allowed.has(key))) {
    throw new TypeError(`${label} must contain only indexed data`);
  }
  return Array.from({ length }, (_, index) => {
    const descriptor = descriptors[String(index)];
    if (
      !descriptor ||
      !descriptor.enumerable ||
      !Object.hasOwn(descriptor, "value")
    ) {
      throw new TypeError(`${label}[${index}] must be an enumerable data property`);
    }
    return descriptor.value;
  });
}

function integer(value, minimum, maximum, label) {
  if (
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new TypeError(
      `${label} must be a safe integer from ${minimum} to ${maximum}`,
    );
  }
  return value;
}

function cardId(value, label) {
  if (typeof value !== "string" || !CARD_ID.test(value) || value.length > 80) {
    throw new TypeError(`${label} must be an original kebab-case card id`);
  }
  return value;
}

function displayName(value, label) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 80 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new TypeError(`${label} must be a bounded display name`);
  }
  return value;
}

function checkedCards(value) {
  const cards = dataArray(value, DECK_SIZE, "cards").map((raw, index) => {
    const card = dataObject(
      raw,
      ["cost", "displayName", "id"],
      `cards[${index}]`,
    );
    return {
      cost: integer(card.cost, 1, ELIXIR_CAPACITY, `cards[${index}].cost`),
      displayName: displayName(card.displayName, `cards[${index}].displayName`),
      id: cardId(card.id, `cards[${index}].id`),
    };
  });
  if (new Set(cards.map(({ id }) => id)).size !== DECK_SIZE) {
    throw new TypeError("cards must have eight unique ids");
  }
  return cards;
}

function checkedDeck(value, catalogIds) {
  const deck = dataObject(
    value,
    ["hand", "next", "queue", "sequence"],
    "deck",
  );
  const hand = dataArray(deck.hand, HAND_SIZE, "deck.hand").map((id, index) =>
    cardId(id, `deck.hand[${index}]`));
  const queue = dataArray(deck.queue, DECK_SIZE - HAND_SIZE, "deck.queue")
    .map((id, index) => cardId(id, `deck.queue[${index}]`));
  const all = [...hand, ...queue];
  if (
    new Set(all).size !== DECK_SIZE ||
    all.some((id) => !catalogIds.has(id))
  ) {
    throw new TypeError("deck hand and queue must partition the card catalog");
  }
  if (deck.next !== queue[0]) {
    throw new TypeError("deck.next must equal deck.queue[0]");
  }
  return {
    hand,
    next: deck.next,
    sequence: integer(
      deck.sequence,
      0,
      DECK_MAX_PLAY_COMMANDS,
      "deck.sequence",
    ),
  };
}

function checkedElixir(value) {
  const elixir = dataObject(value, ["sides", "tick"], "elixir");
  const sides = dataObject(elixir.sides, SIDES, "elixir.sides");
  const checkedSides = {};
  for (const side of SIDES) {
    const state = dataObject(
      sides[side],
      ["accumulator", "amount"],
      `elixir.sides.${side}`,
    );
    const amount = integer(
      state.amount,
      0,
      ELIXIR_CAPACITY,
      `elixir.sides.${side}.amount`,
    );
    const accumulator = integer(
      state.accumulator,
      0,
      ELIXIR_ACCUMULATOR_DENOMINATOR - 1,
      `elixir.sides.${side}.accumulator`,
    );
    if (amount === ELIXIR_CAPACITY && accumulator !== 0) {
      throw new TypeError(`elixir.sides.${side} cannot progress at capacity`);
    }
    checkedSides[side] = { accumulator, amount };
  }
  return {
    sides: checkedSides,
    tick: integer(elixir.tick, 0, MATCH_MAX_TICKS, "elixir.tick"),
  };
}

function checkedCrowns(value) {
  const crowns = dataObject(value, SIDES, "match.crowns");
  return {
    north: integer(crowns.north, 0, 3, "match.crowns.north"),
    south: integer(crowns.south, 0, 3, "match.crowns.south"),
  };
}

function checkedMatch(value) {
  const match = dataObject(value, MATCH_KEYS, "match");
  const tick = integer(match.tick, 0, MATCH_MAX_TICKS, "match.tick");
  const crowns = checkedCrowns(match.crowns);
  if (!["regulation", "overtime", "ended"].includes(match.phase)) {
    throw new TypeError("match.phase is invalid");
  }
  if (
    (match.phase === "regulation" && tick >= MATCH_REGULATION_TICKS) ||
    (match.phase === "overtime" &&
      (tick < MATCH_REGULATION_TICKS || tick >= MATCH_MAX_TICKS))
  ) {
    throw new TypeError("match.phase is inconsistent with match.tick");
  }
  if ((match.phase === "ended") !== (match.result !== null)) {
    throw new TypeError("match.result must exist exactly when the match ended");
  }

  const towers = dataArray(match.towers, TOWER_IDS.length, "match.towers");
  const destroyed = [];
  towers.forEach((raw, index) => {
    const tower = dataObject(
      raw,
      ["hitpoints", "id"],
      `match.towers[${index}]`,
    );
    if (tower.id !== TOWER_IDS[index]) {
      throw new TypeError(`match.towers[${index}].id is out of order`);
    }
    integer(
      tower.hitpoints,
      0,
      Number.MAX_SAFE_INTEGER,
      `match.towers[${index}].hitpoints`,
    );
    if (tower.hitpoints === 0) destroyed.push(tower.id);
  });
  const destroyedTowerIds = dataArray(
    match.destroyedTowerIds,
    destroyed.length,
    "match.destroyedTowerIds",
  );
  if (destroyedTowerIds.some((id, index) => id !== destroyed[index])) {
    throw new TypeError("match.destroyedTowerIds must match zero-hitpoint towers");
  }
  const derivedCrowns = { north: 0, south: 0 };
  for (const id of destroyed) {
    const destroyedSide = id.startsWith("north:") ? "north" : "south";
    const scorer = destroyedSide === "north" ? "south" : "north";
    if (id.endsWith(":central")) derivedCrowns[scorer] = 3;
    else if (derivedCrowns[scorer] < 3) derivedCrowns[scorer] += 1;
  }
  if (
    crowns.north !== derivedCrowns.north ||
    crowns.south !== derivedCrowns.south
  ) {
    throw new TypeError("match.crowns must be derived from destroyed towers");
  }

  if (match.result !== null) {
    const result = dataObject(
      match.result,
      ["crowns", "endedAtTick", "kind", "reason", "winner"],
      "match.result",
    );
    const resultCrowns = checkedCrowns(result.crowns);
    if (
      resultCrowns.north !== crowns.north ||
      resultCrowns.south !== crowns.south ||
      !Number.isSafeInteger(result.endedAtTick) ||
      result.endedAtTick < 0 ||
      result.endedAtTick > tick ||
      !["win", "draw"].includes(result.kind) ||
      ![null, ...SIDES].includes(result.winner) ||
      (result.kind === "draw") !== (result.winner === null) ||
      typeof result.reason !== "string" ||
      result.reason.length < 1 ||
      result.reason.length > 80
    ) {
      throw new TypeError("match.result is inconsistent");
    }
  }
  return { crowns, phase: match.phase, tick };
}

function formatClock(remainingTicks) {
  const seconds = Math.ceil(remainingTicks / MATCH_TICKS_PER_SECOND);
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

function freezeView(value) {
  if (Array.isArray(value)) {
    value.forEach(freezeView);
  } else if (value !== null && typeof value === "object") {
    Object.values(value).forEach(freezeView);
  }
  return Object.freeze(value);
}

/**
 * Pure, bounded projection from canonical match/deck/elixir JSON state.
 * Selection is local UI state and never mutates any supplied snapshot.
 */
export function createHudViewModel(input) {
  const options = dataObject(
    input,
    ["cards", "deck", "elixir", "localSide", "match", "selectedCardId"],
    "HUD input",
  );
  if (!SIDE_SET.has(options.localSide)) {
    throw new TypeError("localSide must be north or south");
  }
  const cards = checkedCards(options.cards);
  const byId = new Map(cards.map((card) => [card.id, card]));
  const deck = checkedDeck(options.deck, new Set(byId.keys()));
  const elixir = checkedElixir(options.elixir);
  const match = checkedMatch(options.match);
  if (match.tick !== elixir.tick) {
    throw new TypeError("match and elixir ticks must agree");
  }
  if (
    options.selectedCardId !== null &&
    (typeof options.selectedCardId !== "string" ||
      !deck.hand.includes(options.selectedCardId))
  ) {
    throw new TypeError("selectedCardId must be null or a card in hand");
  }

  const localElixir = elixir.sides[options.localSide];
  const clockEnd =
    match.phase === "regulation" ? MATCH_REGULATION_TICKS : MATCH_MAX_TICKS;
  const remainingTicks =
    match.phase === "ended" ? 0 : Math.max(0, clockEnd - match.tick);
  const hand = deck.hand.map((id, slot) => {
    const card = byId.get(id);
    const insufficient = card.cost > localElixir.amount;
    return {
      cost: card.cost,
      disabled: match.phase === "ended" || insufficient,
      displayName: card.displayName,
      id,
      insufficient,
      selected: options.selectedCardId === id,
      slot,
    };
  });
  const next = byId.get(deck.next);
  const view = {
    crowns: match.crowns,
    deckSequence: deck.sequence,
    elixir: {
      accumulator: localElixir.accumulator,
      amount: localElixir.amount,
      capacity: ELIXIR_CAPACITY,
      side: options.localSide,
    },
    hand,
    next: {
      cost: next.cost,
      displayName: next.displayName,
      id: next.id,
    },
    phase: match.phase,
    tick: match.tick,
    timer: {
      remainingTicks,
      text: formatClock(remainingTicks),
    },
    version: 1,
  };
  CANONICAL_VIEWS.add(view);
  return freezeView(view);
}

export function serializeHudViewModel(viewModel) {
  return JSON.stringify(checkedViewModel(viewModel));
}

function escapeHtml(value) {
  let escaped = "";
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code === 38) escaped += "&amp;";
    else if (code === 60) escaped += "&lt;";
    else if (code === 62) escaped += "&gt;";
    else if (code === 34) escaped += "&quot;";
    else if (code === 39) escaped += "&#39;";
    else escaped += character;
  }
  return escaped;
}

function cardMarkup(card, kind, includePortrait = false) {
  const flags = kind === "hand"
    ? ` data-disabled="${card.disabled}" data-insufficient="${card.insufficient}" data-selected="${card.selected}" data-slot="${card.slot}"`
    : "";
  const portrait = includePortrait ? getCardPortrait(card.id) : null;
  const cell = portrait?.cell == null
    ? ""
    : ` data-portrait-cell="${portrait.cell}"`;
  const art = portrait === null
    ? ""
    : `<span class="hud-card__portrait" aria-hidden="true"><span class="hud-card__portrait-cell"><img class="hud-card__portrait-image" src="${escapeHtml(portrait.src)}"${cell} alt="" loading="lazy" decoding="sync" draggable="false"></span></span>`;
  const mark = portrait === null
    ? ""
    : ` data-portrait="${portrait.cell === null ? "image" : "atlas"}"`;
  return `<span class="hud-card" data-card-id="${escapeHtml(card.id)}" data-kind="${kind}"${flags}${mark}>${art}<b class="hud-card__cost">${card.cost}</b><span class="hud-card__name">${escapeHtml(card.displayName)}</span></span>`;
}

export function getHudMarkup(viewModel, options) {
  const view = checkedViewModel(viewModel);
  let includePortraits = false;
  if (options !== undefined) {
    const checkedOptions = dataObject(options, ["portraits"], "getHudMarkup options");
    if (typeof checkedOptions.portraits !== "boolean") {
      throw new TypeError("getHudMarkup options.portraits must be a boolean");
    }
    includePortraits = checkedOptions.portraits;
  }
  return `<section data-ui="hud-projection" data-phase="${view.phase}" data-tick="${view.tick}"><time data-ui="hud-timer">${view.timer.text}</time><span data-ui="hud-crowns" data-north="${view.crowns.north}" data-south="${view.crowns.south}"></span><span data-ui="hud-elixir" data-accumulator="${view.elixir.accumulator}" data-amount="${view.elixir.amount}" data-side="${view.elixir.side}"></span><div data-ui="hud-next">${cardMarkup(view.next, "next", includePortraits)}</div><div data-ui="hud-hand">${view.hand.map((card) => cardMarkup(card, "hand", includePortraits)).join("")}</div></section>`;
}

function checkedViewModel(value) {
  if (value === null || typeof value !== "object" || !CANONICAL_VIEWS.has(value)) {
    throw new TypeError("viewModel must come from createHudViewModel");
  }
  return value;
}

function callable(value, key, label) {
  const method = value[key];
  if (typeof method !== "function") {
    throw new TypeError(`${label}.${key} must be callable`);
  }
  return method;
}

function exactNodeList(value, count, label) {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) {
    throw new TypeError(`${label} must be a node collection`);
  }
  const length = value.length;
  if (!Number.isSafeInteger(length) || length !== count) {
    throw new TypeError(
      `${label} is missing or duplicated; expected exactly ${count} targets`,
    );
  }
  const nodes = [];
  for (let index = 0; index < count; index += 1) {
    const node = value[index];
    if (node === null || (typeof node !== "object" && typeof node !== "function")) {
      throw new TypeError(`${label}[${index}] must be a node`);
    }
    nodes.push(node);
  }
  if (new Set(nodes).size !== count) {
    throw new TypeError(`${label} targets must be unique`);
  }
  return nodes;
}

function selectExact(target, querySelectorAll, selector, count, label) {
  return exactNodeList(
    querySelectorAll.call(target, selector),
    count,
    label,
  );
}

function mutableRecord(value, label) {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) {
    throw new TypeError(`${label} must be mutable`);
  }
  return value;
}

function requireMutableSlot(value, key, label) {
  if (!(key in value)) {
    throw new TypeError(`${label}.${key} must be a mutable property`);
  }
}

function checkedShell(target) {
  if (target === null || (typeof target !== "object" && typeof target !== "function")) {
    throw new TypeError("HUD target must be a mounted arena shell");
  }
  const querySelectorAll = callable(target, "querySelectorAll", "HUD target");
  const timer = selectExact(
    target,
    querySelectorAll,
    '[data-ui="timer"]',
    1,
    "HUD timer hooks",
  )[0];
  const north = selectExact(
    target,
    querySelectorAll,
    '[data-ui="opponent-hud"] .crown-track',
    1,
    "HUD opponent crown hooks",
  )[0];
  const south = selectExact(
    target,
    querySelectorAll,
    '[data-ui="player-hud"] .crown-track',
    1,
    "HUD player crown hooks",
  )[0];
  const hand = selectExact(
    target,
    querySelectorAll,
    '[data-ui="card-slot"]',
    HAND_SIZE,
    "HUD hand hooks",
  );
  const next = selectExact(
    target,
    querySelectorAll,
    '[data-ui="next-card"]',
    1,
    "HUD next-card hooks",
  )[0];
  const rail = selectExact(
    target,
    querySelectorAll,
    '[data-ui="elixir-rail"]',
    1,
    "HUD elixir hooks",
  )[0];

  const railQuerySelectorAll = callable(
    rail,
    "querySelectorAll",
    "HUD elixir hook",
  );
  const fill = selectExact(
    rail,
    railQuerySelectorAll,
    ".elixir-fill",
    1,
    "HUD elixir fill hooks",
  )[0];
  const output = selectExact(
    rail,
    railQuerySelectorAll,
    "output",
    1,
    "HUD elixir output hooks",
  )[0];
  const northQuerySelectorAll = callable(
    north,
    "querySelectorAll",
    "HUD opponent crown hook",
  );
  const southQuerySelectorAll = callable(
    south,
    "querySelectorAll",
    "HUD player crown hook",
  );
  const opponentCrowns = selectExact(
    north,
    northQuerySelectorAll,
    "i",
    3,
    "HUD opponent crown markers",
  );
  const playerCrowns = selectExact(
    south,
    southQuerySelectorAll,
    "i",
    3,
    "HUD player crown markers",
  );

  const allTargets = [
    timer,
    north,
    south,
    ...hand,
    next,
    rail,
    fill,
    output,
    ...opponentCrowns,
    ...playerCrowns,
  ];
  if (new Set(allTargets).size !== allTargets.length) {
    throw new TypeError("HUD hooks must resolve to distinct targets");
  }

  const datasets = new Map();
  for (const [label, node] of [
    ["HUD timer dataset", timer],
    ...opponentCrowns.map((node) => ["HUD opponent crown dataset", node]),
    ...playerCrowns.map((node) => ["HUD player crown dataset", node]),
    ...hand.map((node) => ["HUD hand dataset", node]),
    ["HUD next-card dataset", next],
    ["HUD elixir dataset", rail],
  ]) {
    datasets.set(node, mutableRecord(node.dataset, label));
  }
  const fillStyle = mutableRecord(fill.style, "HUD elixir fill style");
  requireMutableSlot(timer, "textContent", "HUD timer hook");
  hand.forEach((node, index) => {
    requireMutableSlot(node, "innerHTML", `HUD hand hook ${index}`);
  });
  requireMutableSlot(next, "innerHTML", "HUD next-card hook");
  requireMutableSlot(fillStyle, "width", "HUD elixir fill style");
  requireMutableSlot(output, "value", "HUD elixir output hook");
  requireMutableSlot(output, "textContent", "HUD elixir output hook");

  return {
    datasets,
    fill,
    fillStyle,
    hand,
    next,
    opponentCrowns,
    output,
    playerCrowns,
    rail,
    timer,
  };
}

function propertyMutation(target, key, value, deleteIfAbsent = false) {
  const hadOwnProperty = Object.hasOwn(target, key);
  const previous = target[key];
  return {
    apply() {
      target[key] = value;
    },
    rollback() {
      if (deleteIfAbsent && !hadOwnProperty) {
        delete target[key];
      } else {
        target[key] = previous;
      }
    },
  };
}

function applyTransaction(mutations) {
  const attempted = [];
  try {
    for (const mutation of mutations) {
      attempted.push(mutation);
      mutation.apply();
    }
  } catch (error) {
    let rollbackError = null;
    for (let index = attempted.length - 1; index >= 0; index -= 1) {
      try {
        attempted[index].rollback();
      } catch (caught) {
        rollbackError ??= caught;
      }
    }
    if (rollbackError !== null) {
      throw new AggregateError(
        [error, rollbackError],
        "HUD binding failed and could not be fully rolled back",
      );
    }
    throw error;
  }
}

/**
 * Bind one already-validated projection. All target discovery and markup
 * generation completes before the first DOM mutation.
 */
export function bindHudViewModel(target, viewModel) {
  const view = checkedViewModel(viewModel);
  const nodes = checkedShell(target);
  const handMarkup = view.hand.map((card) => cardMarkup(card, "hand"));
  const nextMarkup = cardMarkup(view.next, "next");
  const fillUnits =
    view.elixir.amount * ELIXIR_ACCUMULATOR_DENOMINATOR +
    view.elixir.accumulator;
  const fillMaximum = ELIXIR_CAPACITY * ELIXIR_ACCUMULATOR_DENOMINATOR;
  const fillPercent = (fillUnits * 100 / fillMaximum).toFixed(6);
  const opponentSide = view.elixir.side === "south" ? "north" : "south";
  const mutations = [
    propertyMutation(nodes.timer, "textContent", view.timer.text),
    propertyMutation(nodes.datasets.get(nodes.timer), "phase", view.phase, true),
    propertyMutation(
      nodes.datasets.get(nodes.timer),
      "tick",
      String(view.tick),
      true,
    ),
  ];
  nodes.opponentCrowns.forEach((node, index) => {
    mutations.push(propertyMutation(
      nodes.datasets.get(node),
      "earned",
      String(index < view.crowns[opponentSide]),
      true,
    ));
  });
  nodes.playerCrowns.forEach((node, index) => {
    mutations.push(propertyMutation(
      nodes.datasets.get(node),
      "earned",
      String(index < view.crowns[view.elixir.side]),
      true,
    ));
  });
  nodes.hand.forEach((node, index) => {
    const dataset = nodes.datasets.get(node);
    mutations.push(
      propertyMutation(node, "innerHTML", handMarkup[index]),
      propertyMutation(dataset, "cardId", view.hand[index].id, true),
      propertyMutation(
        dataset,
        "disabled",
        String(view.hand[index].disabled),
        true,
      ),
      propertyMutation(
        dataset,
        "insufficient",
        String(view.hand[index].insufficient),
        true,
      ),
      propertyMutation(
        dataset,
        "selected",
        String(view.hand[index].selected),
        true,
      ),
    );
  });
  const nextDataset = nodes.datasets.get(nodes.next);
  const railDataset = nodes.datasets.get(nodes.rail);
  mutations.push(
    propertyMutation(nodes.next, "innerHTML", nextMarkup),
    propertyMutation(nextDataset, "cardId", view.next.id, true),
    propertyMutation(railDataset, "side", view.elixir.side, true),
    propertyMutation(
      railDataset,
      "amount",
      String(view.elixir.amount),
      true,
    ),
    propertyMutation(
      railDataset,
      "accumulator",
      String(view.elixir.accumulator),
      true,
    ),
    propertyMutation(nodes.fillStyle, "width", `${fillPercent}%`),
    propertyMutation(nodes.output, "value", String(view.elixir.amount)),
    propertyMutation(nodes.output, "textContent", String(view.elixir.amount)),
  );
  applyTransaction(mutations);
  return target;
}
