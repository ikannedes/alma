// Modificado para Alma, 2026-10-31: textos del resultado y de la fase en español
// (el norte es Alma y el sur es el dueño).
// Original: Moss & Ember, ThatXliner/clash-royale-clone, commit 75d30d1 (AGPL-3.0-only).
import { HUD_MOTION_STYLE } from "./hud-motion.js";

const FASE_ES = Object.freeze({ regulation: "tiempo", overtime: "prórroga", ended: "final" });
import { MatchClock } from "../sim/match.js";
import { isAuthenticGameSessionProjectionSnapshot } from "../sim/game-session.js";

export const MATCH_FEEDBACK_EVENT_LIMIT = 10_016;
export const MATCH_FEEDBACK_VIEW_VERSION = 1;

const TOWER_IDS = Object.freeze([
  "north:central",
  "north:lane:left",
  "north:lane:right",
  "south:central",
  "south:lane:left",
  "south:lane:right",
]);
const TOWER_ID_SET = new Set(TOWER_IDS);
const CANONICAL_VIEWS = new WeakSet();
const PHASES = new Set(["regulation", "overtime", "ended"]);
const REASONS = new Set([
  "central_destroyed",
  "overtime_sudden_death",
  "regulation_crowns",
  "tiebreak_exact_tie",
  "tiebreak_lowest_hp",
]);

const STYLE_TEXT = `.match-feedback{position:absolute;z-index:45;inset:0;overflow:hidden;pointer-events:none;color:#f7f2dc;font:800 18px/1 system-ui,sans-serif;text-shadow:0 2px 0 #172028}.match-feedback__score{position:absolute;top:12px;left:50%;display:flex;gap:12px;translate:-50% 0;padding:8px 12px;border:2px solid #e8dba9;border-radius:14px;background:#263843dd}.match-feedback__crown{min-width:2ch;text-align:center}.match-feedback__phase{position:absolute;top:58px;left:50%;translate:-50% 0;padding:5px 10px;border-radius:9px;background:#263843dd;text-transform:uppercase}.match-feedback__destruction{position:absolute;width:26px;height:26px;translate:-50% -50%;border:4px double #ffe68a;border-radius:50%;background:#e36b43aa;box-shadow:0 0 18px #fff3a8}.match-feedback__overlay{position:absolute;inset:31% 9%;display:grid;place-content:center;gap:12px;text-align:center;border:4px solid #e8dba9;border-radius:20px;background:#172832ed;font-size:34px}.match-feedback__result{font-size:18px;text-transform:uppercase}`;

export function getMatchFeedbackStyleText() {
  return STYLE_TEXT + LIFECYCLE_STYLE + HUD_MOTION_STYLE;
}

function record(value, keys, label) {
  if (
    value === null || typeof value !== "object" || Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) ||
    Object.getOwnPropertySymbols(value).length !== 0
  ) throw new TypeError(`${label} must be a plain data object`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const actual = Reflect.ownKeys(descriptors).sort();
  const wanted = [...keys].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new TypeError(`${label} has an invalid shape`);
  }
  const result = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
      throw new TypeError(`${label}.${key} must be an enumerable data property`);
    }
    result[key] = descriptor.value;
  }
  return result;
}

function array(value, maximum, label) {
  if (
    !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype ||
    Object.getOwnPropertySymbols(value).length !== 0 || value.length > maximum
  ) throw new TypeError(`${label} must be a plain array of at most ${maximum} items`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (key === "length") continue;
    if (typeof key !== "string" || !/^(0|[1-9]\d*)$/u.test(key) || Number(key) >= value.length) {
      throw new TypeError(`${label} must contain only indexed data`);
    }
  }
  return Array.from({ length: value.length }, (_, index) => {
    const descriptor = descriptors[String(index)];
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) {
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

function side(value, nullable, label) {
  if ((nullable && value === null) || value === "north" || value === "south") return value;
  throw new TypeError(`${label} must be north${nullable ? ", south, or null" : " or south"}`);
}

function towerIds(value, label) {
  const ids = array(value, TOWER_IDS.length, label);
  let previous = -1;
  return ids.map((id, index) => {
    const order = TOWER_IDS.indexOf(id);
    if (typeof id !== "string" || order < 0 || order <= previous) {
      throw new TypeError(`${label}[${index}] must use unique canonical tower order`);
    }
    previous = order;
    return id;
  });
}

function crowns(value, label) {
  const checked = record(value, ["north", "south"], label);
  return {
    north: integer(checked.north, 0, 3, `${label}.north`),
    south: integer(checked.south, 0, 3, `${label}.south`),
  };
}

function result(value, label) {
  if (value === null) return null;
  const checked = record(value, ["crowns", "endedAtTick", "kind", "reason", "winner"], label);
  const checkedCrowns = crowns(checked.crowns, `${label}.crowns`);
  if (checked.kind !== "win" && checked.kind !== "draw") throw new TypeError(`${label}.kind is invalid`);
  if (!REASONS.has(checked.reason)) throw new TypeError(`${label}.reason is invalid`);
  const winner = side(checked.winner, true, `${label}.winner`);
  if ((checked.kind === "draw") !== (winner === null)) throw new TypeError(`${label} kind and winner disagree`);
  return {
    crowns: checkedCrowns,
    endedAtTick: integer(checked.endedAtTick, 0, 18_000, `${label}.endedAtTick`),
    kind: checked.kind,
    reason: checked.reason,
    winner,
  };
}

function checkedState(value) {
  const state = record(value, ["crowns", "destroyedTowerIds", "phase", "result", "tick", "towers"], "match state");
  const tick = integer(state.tick, 0, 18_000, "match state.tick");
  if (!PHASES.has(state.phase)) throw new TypeError("match state.phase is invalid");
  const checkedCrowns = crowns(state.crowns, "match state.crowns");
  const towers = array(state.towers, TOWER_IDS.length, "match state.towers").map((value, index) => {
    const tower = record(value, ["hitpoints", "id"], `match state.towers[${index}]`);
    if (tower.id !== TOWER_IDS[index]) throw new TypeError(`match state.towers[${index}].id is noncanonical`);
    return { hitpoints: integer(tower.hitpoints, 0, Number.MAX_SAFE_INTEGER, `match state.towers[${index}].hitpoints`), id: tower.id };
  });
  if (towers.length !== TOWER_IDS.length) throw new TypeError("match state must contain all six towers");
  const destroyedTowerIds = towerIds(state.destroyedTowerIds, "match state.destroyedTowerIds");
  const zeros = towers.filter(({ hitpoints }) => hitpoints === 0).map(({ id }) => id);
  if (canonicalJson(destroyedTowerIds) !== canonicalJson(zeros)) throw new TypeError("match state destroyed towers disagree with hitpoints");
  const scored = { north: 0, south: 0 };
  for (const id of destroyedTowerIds) {
    const scorer = id.startsWith("north:") ? "south" : "north";
    scored[scorer] = id.endsWith(":central") ? 3 : Math.min(3, scored[scorer] + 1);
  }
  if (canonicalJson(scored) !== canonicalJson(checkedCrowns)) {
    throw new TypeError("match state crowns disagree with destroyed towers");
  }
  const checkedResult = result(state.result, "match state.result");
  if ((state.phase === "ended") !== (checkedResult !== null)) throw new TypeError("match state phase and result disagree");
  if (checkedResult && (canonicalJson(checkedResult.crowns) !== canonicalJson(checkedCrowns) || checkedResult.endedAtTick > tick)) {
    throw new TypeError("match state result disagrees with current state");
  }
  return { crowns: checkedCrowns, destroyedTowerIds, phase: state.phase, result: checkedResult, tick, towers };
}

function checkedEvents(value, state) {
  const events = array(value, MATCH_FEEDBACK_EVENT_LIMIT, "match events");
  const sequences = new Set();
  let priorTick = -1;
  let priorEvidenceSequence = -1;
  let priorEvidenceTick = -1;
  return events.map((raw, index) => {
    const base = record(raw, Object.keys(raw), `match events[${index}]`);
    if (typeof base.type !== "string") throw new TypeError(`match events[${index}].type is invalid`);
    let event;
    if (base.type === "tower_evidence" && base.accepted === true) {
      event = record(raw, ["accepted", "destroyedTowerIds", "sequence", "tick", "type"], `match events[${index}]`);
      event.destroyedTowerIds = towerIds(event.destroyedTowerIds, `match events[${index}].destroyedTowerIds`);
    } else if (base.type === "tower_evidence" && base.accepted === false) {
      event = record(raw, ["accepted", "reason", "sequence", "tick", "type"], `match events[${index}]`);
      if (event.reason !== "match_ended") throw new TypeError(`match events[${index}].reason is invalid`);
    } else if (base.type === "overtime_started") {
      event = record(raw, ["tick", "type"], `match events[${index}]`);
      if (event.tick !== 10_800) throw new TypeError("overtime must start at tick 10800");
    } else if (base.type === "match_end") {
      event = record(raw, ["result", "tick", "type"], `match events[${index}]`);
      event.result = result(event.result, `match events[${index}].result`);
      if (event.result === null || event.result.endedAtTick !== event.tick) throw new TypeError("match end result is noncanonical");
    } else if (base.type === "tiebreak") {
      event = record(raw, ["drainedTowerIds", "minima", "result", "tick", "type"], `match events[${index}]`);
      event.drainedTowerIds = towerIds(event.drainedTowerIds, `match events[${index}].drainedTowerIds`);
      const minima = record(event.minima, ["north", "south"], `match events[${index}].minima`);
      event.minima = {
        north: integer(minima.north, 1, Number.MAX_SAFE_INTEGER, `match events[${index}].minima.north`),
        south: integer(minima.south, 1, Number.MAX_SAFE_INTEGER, `match events[${index}].minima.south`),
      };
      event.result = result(event.result, `match events[${index}].result`);
      if (event.tick !== 18_000 || event.result?.endedAtTick !== 18_000) throw new TypeError("tiebreak is noncanonical");
    } else {
      throw new TypeError(`match events[${index}].type is invalid`);
    }
    event.tick = integer(event.tick, 0, state.tick, `match events[${index}].tick`);
    if (event.tick < priorTick) throw new TypeError("match event ticks must be nondecreasing");
    if (event.type === "tower_evidence") {
      event.sequence = integer(event.sequence, 0, 9_999, `match events[${index}].sequence`);
      if (sequences.has(event.sequence)) throw new TypeError("match evidence sequences must be unique");
      if (event.tick === priorEvidenceTick && event.sequence <= priorEvidenceSequence) {
        throw new TypeError("same-tick match evidence must use sequence order");
      }
      sequences.add(event.sequence);
      priorEvidenceTick = event.tick;
      priorEvidenceSequence = event.sequence;
    }
    priorTick = event.tick;
    return event;
  });
}

function freeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new TypeError("match feedback numbers must be safe integers");
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  throw new TypeError("match feedback contains an unsupported value");
}

function checkedCausalSource(value, state, events) {
  const source = record(value, ["replayBytes", "snapshot"], "match causal source");
  if (typeof source.snapshot !== "string" || source.snapshot.length > 4_000_000) {
    throw new TypeError("match causal snapshot must be a bounded string");
  }
  if (typeof source.replayBytes !== "string" || source.replayBytes.length > 4_000_000) {
    throw new TypeError("match causal replay bytes must be a bounded string");
  }
  const restored = MatchClock.restore(source.snapshot);
  if (restored.serialize() !== source.snapshot) {
    throw new TypeError("match causal snapshot must use canonical encoding");
  }
  if (restored.replayBytes() !== source.replayBytes) {
    throw new TypeError("match causal replay bytes disagree with the snapshot");
  }
  if (!same(restored.state, state) || !same(restored.eventLog, events)) {
    throw new TypeError("match causal source disagrees with projected state or events");
  }
  const raw = JSON.parse(source.snapshot);
  let preTiebreakTowers = raw.initialTowers;
  for (const entry of restored.replayLog) {
    if (entry.event.accepted && entry.command.tick < 18_000) {
      preTiebreakTowers = entry.command.evidence.towers;
    }
  }
  return {
    preTiebreakTowers,
    replayBytes: source.replayBytes,
    snapshot: source.snapshot,
  };
}

function same(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function resultFromLosses(crownsValue, losingSides, reason, tick) {
  let kind;
  let winner;
  if (losingSides.size === 2) {
    if (crownsValue.north === crownsValue.south) {
      kind = "draw";
      winner = null;
    } else {
      kind = "win";
      winner = crownsValue.north > crownsValue.south ? "north" : "south";
    }
  } else {
    kind = "win";
    winner = losingSides.has("north") ? "south" : "north";
  }
  return {
    crowns: { ...crownsValue },
    endedAtTick: tick,
    kind,
    reason,
    winner,
  };
}

function awardCrowns(crownsValue, ids) {
  for (const id of ids) {
    const scorer = id.startsWith("north:") ? "south" : "north";
    crownsValue[scorer] = id.endsWith(":central")
      ? 3
      : Math.min(3, crownsValue[scorer] + 1);
  }
}

function deriveTiebreak(event, state, destroyed, crownsValue, preTiebreakTowers) {
  const losingSides = event.minima.north === event.minima.south
    ? new Set(["north", "south"])
    : new Set([event.minima.north < event.minima.south ? "north" : "south"]);
  const hitpoints = new Map(preTiebreakTowers.map((tower) => [tower.id, tower.hitpoints]));
  for (const id of event.drainedTowerIds) {
    if (destroyed.has(id) || !losingSides.has(id.startsWith("north:") ? "north" : "south")) {
      throw new TypeError("tiebreak drained towers are causally impossible");
    }
  }
  const expectedDrained = [];
  for (const sideName of ["north", "south"]) {
    const alive = TOWER_IDS.filter((id) => id.startsWith(`${sideName}:`) && !destroyed.has(id));
    if (alive.length === 0) throw new TypeError("tiebreak requires a surviving tower on each side");
    const values = alive.map((id) => hitpoints.get(id));
    if (values.some((value) => !Number.isSafeInteger(value) || value <= 0)) {
      throw new TypeError("tiebreak tower hitpoints are causally impossible");
    }
    if (Math.min(...values) !== event.minima[sideName]) {
      throw new TypeError("tiebreak minima disagree with canonical tower hitpoints");
    }
    if (losingSides.has(sideName)) {
      expectedDrained.push(...alive.filter((id) => hitpoints.get(id) === event.minima[sideName]));
    }
  }
  if (!same(expectedDrained, event.drainedTowerIds)) {
    throw new TypeError("tiebreak drained towers disagree with minima");
  }
  for (const tower of state.towers) {
    const expected = event.drainedTowerIds.includes(tower.id) ? 0 : hitpoints.get(tower.id);
    if (tower.hitpoints !== expected) {
      throw new TypeError("terminal tower hitpoints disagree with the causal tiebreak drain");
    }
  }
  awardCrowns(crownsValue, event.drainedTowerIds);
  const winner = losingSides.size === 2 ? null : losingSides.has("north") ? "south" : "north";
  return {
    crowns: { ...crownsValue },
    endedAtTick: 18_000,
    kind: winner === null ? "draw" : "win",
    reason: winner === null ? "tiebreak_exact_tie" : "tiebreak_lowest_hp",
    winner,
  };
}

function deriveMatch(events, state, causal) {
  const destroyed = new Set();
  const crownsValue = { north: 0, south: 0 };
  const effects = [];
  let currentTick = -1;
  let newlyAtTick = [];
  let overtime = false;
  let derivedResult = null;
  for (let ordinal = 0; ordinal < events.length; ordinal += 1) {
    const event = events[ordinal];
    if (event.tick !== currentTick) {
      if (
        derivedResult === null && newlyAtTick.length > 0 &&
        (overtime || newlyAtTick.some((id) => id.endsWith(":central")))
      ) throw new TypeError("match events omit a required destruction result");
      currentTick = event.tick;
      newlyAtTick = [];
    }
    if (event.type === "tower_evidence") {
      if (event.accepted) {
        if (derivedResult !== null || event.tick === 18_000) {
          throw new TypeError("accepted tower evidence occurs after the match ended");
        }
        for (const id of destroyed) {
          if (!event.destroyedTowerIds.includes(id)) {
            throw new TypeError("tower evidence revives a previously destroyed tower");
          }
        }
        const newlyDestroyed = [];
        for (const towerId of event.destroyedTowerIds) {
          if (!destroyed.has(towerId)) {
            destroyed.add(towerId);
            newlyAtTick.push(towerId);
            newlyDestroyed.push(towerId);
            effects.push({ ordinal, tick: event.tick, towerId, type: "tower_destroyed" });
          }
        }
        awardCrowns(crownsValue, newlyDestroyed);
      } else if (derivedResult === null) {
        throw new TypeError("rejected tower evidence precedes the match result");
      }
      continue;
    }
    if (event.type === "overtime_started") {
      if (derivedResult !== null || overtime || crownsValue.north !== crownsValue.south) {
        throw new TypeError("overtime transition is causally impossible");
      }
      overtime = true;
      continue;
    }
    if (event.type === "match_end") {
      if (derivedResult !== null) throw new TypeError("match events contain multiple results");
      const losingSides = new Set(newlyAtTick.map((id) => id.startsWith("north:") ? "north" : "south"));
      if (newlyAtTick.some((id) => id.endsWith(":central"))) {
        if (event.tick >= 10_800 && !overtime) {
          throw new TypeError("match events omit the regulation boundary before destruction");
        }
        derivedResult = resultFromLosses(crownsValue, losingSides, "central_destroyed", event.tick);
      } else if (overtime && newlyAtTick.length > 0) {
        derivedResult = resultFromLosses(crownsValue, losingSides, "overtime_sudden_death", event.tick);
      } else if (event.tick === 10_800 && !overtime && crownsValue.north !== crownsValue.south) {
        const winner = crownsValue.north > crownsValue.south ? "north" : "south";
        derivedResult = {
          crowns: { ...crownsValue }, endedAtTick: 10_800, kind: "win",
          reason: "regulation_crowns", winner,
        };
      } else {
        throw new TypeError("match end has no canonical causal trigger");
      }
      if (!same(derivedResult, event.result)) throw new TypeError("match end result disagrees with causal history");
      newlyAtTick = [];
      continue;
    }
    if (event.type === "tiebreak") {
      if (derivedResult !== null || !overtime || newlyAtTick.length > 0) {
        throw new TypeError("tiebreak transition is causally impossible");
      }
      derivedResult = deriveTiebreak(
        event,
        state,
        destroyed,
        crownsValue,
        causal.preTiebreakTowers,
      );
      if (!same(derivedResult, event.result)) throw new TypeError("tiebreak result disagrees with causal history");
      for (const towerId of event.drainedTowerIds) {
        destroyed.add(towerId);
        effects.push({ ordinal, tick: event.tick, towerId, type: "tower_destroyed" });
      }
    }
  }
  if (
    derivedResult === null && newlyAtTick.length > 0 &&
    (overtime || newlyAtTick.some((id) => id.endsWith(":central")))
  ) throw new TypeError("match events omit a required destruction result");
  if (!same([...destroyed].sort((a, b) => TOWER_IDS.indexOf(a) - TOWER_IDS.indexOf(b)), state.destroyedTowerIds)) {
    throw new TypeError("match events do not account for canonical destroyed towers");
  }
  if (!same(crownsValue, state.crowns)) throw new TypeError("match events do not account for canonical crowns");
  if (!same(derivedResult, state.result)) throw new TypeError("match events do not account for canonical result");
  if (derivedResult === null) {
    const expectedPhase = overtime ? "overtime" : "regulation";
    if (state.phase !== expectedPhase) throw new TypeError("match events do not account for canonical phase");
    if (state.tick >= 10_800 && !overtime) throw new TypeError("match events omit the regulation boundary result");
    if (state.tick === 18_000) throw new TypeError("match events omit the terminal tiebreak");
  } else if (state.phase !== "ended") {
    throw new TypeError("match result requires ended phase");
  }
  return { effects };
}

function buildView(state, events, causal) {
  const { effects } = deriveMatch(events, state, causal);
  const view = {
    crowns: state.crowns,
    effects,
    overlay: state.result === null ? null : {
      crowns: state.result.crowns,
      endedAtTick: state.result.endedAtTick,
      kind: state.result.kind,
      reason: state.result.reason,
      winner: state.result.winner,
    },
    phase: state.phase,
    tick: state.tick,
    version: MATCH_FEEDBACK_VIEW_VERSION,
  };
  freeze(view);
  CANONICAL_VIEWS.add(view);
  return view;
}

/**
 * Project feedback from an authentic, causally restorable whole-game session.
 * This adapter does not weaken the MatchClock snapshot path used by the
 * standalone projector; it supplies the same pre-tiebreak tower evidence from
 * the session's authoritative battle state.
 */
export function createSessionMatchFeedbackViewModel(snapshot) {
  if (!isAuthenticGameSessionProjectionSnapshot(snapshot)) {
    throw new TypeError("match feedback requires an authentic GameSession projection snapshot");
  }
  const source = record(snapshot.matchFeedback,
    ["events", "replayBytes", "snapshot"], "session match feedback source");
  const projector = new MatchFeedbackProjector();
  return projector.project(snapshot.state.clock, source.events, {
    replayBytes: source.replayBytes,
    snapshot: source.snapshot,
  });
}

export class MatchFeedbackProjector {
  #causal = null;
  #events = [];
  #state = null;
  #view = null;

  get view() { return this.#view; }
  get terminal() { return this.#state?.phase === "ended"; }

  project(stateValue, eventChunk, causalValue) {
    if (this.terminal) throw new RangeError("terminal match feedback is immutable");
    const state = checkedState(stateValue);
    if (this.#state && state.tick < this.#state.tick) throw new RangeError("match feedback tick cannot move backward");
    const chunk = array(eventChunk, MATCH_FEEDBACK_EVENT_LIMIT, "match event chunk");
    if (this.#events.length + chunk.length > MATCH_FEEDBACK_EVENT_LIMIT) throw new RangeError("match feedback event limit exceeded");
    const events = checkedEvents([...this.#events, ...chunk], state);
    const causal = checkedCausalSource(causalValue, state, events);
    const view = buildView(state, events, causal);
    this.#causal = {
      replayBytes: causal.replayBytes,
      snapshot: causal.snapshot,
    };
    this.#events = events;
    this.#state = state;
    this.#view = view;
    return view;
  }

  serialize() {
    if (this.#state === null) throw new TypeError("match feedback has no projected state");
    return canonicalJson({ causal: this.#causal, events: this.#events, state: this.#state, version: MATCH_FEEDBACK_VIEW_VERSION });
  }

  static restore(bytes) {
    if (typeof bytes !== "string" || bytes.length > 4_000_000) throw new TypeError("match feedback bytes must be a bounded string");
    let raw;
    try { raw = JSON.parse(bytes); } catch { throw new TypeError("match feedback bytes must be valid JSON"); }
    const snapshot = record(raw, ["causal", "events", "state", "version"], "match feedback snapshot");
    if (snapshot.version !== MATCH_FEEDBACK_VIEW_VERSION) throw new TypeError("match feedback snapshot version is unsupported");
    const projector = new MatchFeedbackProjector();
    projector.project(snapshot.state, snapshot.events, snapshot.causal);
    if (projector.serialize() !== bytes) throw new TypeError("match feedback bytes must use canonical encoding");
    return projector;
  }
}

export function serializeMatchFeedbackViewModel(view) {
  if (!CANONICAL_VIEWS.has(view)) throw new TypeError("match feedback view must come from a projector");
  return canonicalJson(view);
}

const TOWER_POSITIONS = Object.freeze({
  "north:central": [9_000, 29_000], "north:lane:left": [3_500, 24_500], "north:lane:right": [14_500, 24_500],
  "south:central": [9_000, 3_000], "south:lane:left": [3_500, 7_500], "south:lane:right": [14_500, 7_500],
});

export function bindMatchFeedback(layer, view) {
  if (!layer || typeof layer.replaceChildren !== "function" || typeof layer.ownerDocument?.createElement !== "function") {
    throw new TypeError("match feedback layer must be a DOM element");
  }
  if (!CANONICAL_VIEWS.has(view)) throw new TypeError("match feedback view must come from a projector");
  const document = layer.ownerDocument;
  const frame = document.createElement("div");
  frame.className = "match-feedback__frame";
  frame.dataset.phase = view.phase;
  frame.dataset.tick = String(view.tick);
  const score = document.createElement("div");
  score.className = "match-feedback__score";
  for (const name of ["north", "south"]) {
    const node = document.createElement("span");
    node.className = "match-feedback__crown";
    node.dataset.side = name;
    node.textContent = String(view.crowns[name]);
    score.appendChild(node);
  }
  frame.appendChild(score);
  const phase = document.createElement("div");
  phase.className = "match-feedback__phase";
  phase.textContent = FASE_ES[view.phase] ?? view.phase;
  frame.appendChild(phase);
  const field = document.createElement("div");
  field.className = "match-feedback__field";
  frame.appendChild(field);
  for (const effect of view.effects) {
    const node = document.createElement("i");
    node.className = "match-feedback__destruction";
    node.dataset.ordinal = String(effect.ordinal);
    node.dataset.tick = String(effect.tick);
    node.dataset.towerId = effect.towerId;
    const age = view.tick - effect.tick;
    node.dataset.age = String(age);
    node.dataset.stage = age < 24 ? "collapse" : "rubble";
    node.style.setProperty("--collapse", String(Math.min(24, age) / 24));
    node.style.setProperty("--dust-opacity", String(Math.max(0, 1 - age / 36)));
    node.setAttribute("aria-hidden", "true");
    for (let index = 0; index < 5; index += 1) {
      const stone = document.createElement("b");
      stone.style.setProperty("--stone-index", String(index));
      node.appendChild(stone);
    }
    if (age < 60) {
      const crown = document.createElement("span");
      crown.className = "match-feedback__crown-flight";
      crown.dataset.scorer = effect.towerId.startsWith("north:") ? "south" : "north";
      crown.dataset.tick = String(effect.tick);
      crown.textContent = effect.towerId.endsWith(":central") ? "♛ 3" : "♛ +1";
      crown.style.setProperty("--crown-rise", `${Math.min(age, 48) * 1.5}px`);
      crown.style.setProperty("--crown-opacity", String(Math.min(1, (60 - age) / 12)));
      node.appendChild(crown);
    }
    const [x, y] = TOWER_POSITIONS[effect.towerId];
    node.style.setProperty("left", `${x * 100 / 18_000}%`);
    node.style.setProperty("top", `${(32_000 - y) * 100 / 32_000}%`);
    field.appendChild(node);
  }
  if (view.overlay) {
    const overlay = document.createElement("section");
    overlay.className = "match-feedback__overlay";
    overlay.dataset.kind = view.overlay.kind;
    overlay.dataset.reason = view.overlay.reason;
    overlay.dataset.winner = view.overlay.winner ?? "draw";
    const title = document.createElement("strong");
    title.textContent = view.overlay.winner === null ? "Empate"
      : view.overlay.winner === "north" ? "Gana Alma" : "¡Ganas tú!";
    overlay.appendChild(title);
    const detail = document.createElement("span");
    detail.className = "match-feedback__result";
    detail.textContent = `Alma ${view.overlay.crowns.north} – ${view.overlay.crowns.south} Tú`;
    overlay.appendChild(detail);
    frame.appendChild(overlay);
  }
  layer.replaceChildren(frame);
  return view;
}

export function mountMatchFeedback(shell) {
  if (!shell || typeof shell.querySelector !== "function") throw new TypeError("match feedback shell must be a DOM element");
  const arena = shell.querySelector('[data-ui="arena"]');
  if (!arena || typeof arena.appendChild !== "function" || typeof arena.ownerDocument?.createElement !== "function") {
    throw new TypeError("match feedback shell must contain an arena element");
  }
  const style = arena.ownerDocument.createElement("style");
  style.dataset.ui = "match-feedback-style";
  style.textContent = getMatchFeedbackStyleText();
  const layer = arena.ownerDocument.createElement("div");
  layer.className = "match-feedback";
  layer.dataset.ui = "match-feedback";
  layer.setAttribute("aria-live", "polite");
  arena.appendChild(style);
  arena.appendChild(layer);
  let active = true;
  return {
    bind(view) {
      if (!active) throw new RangeError("match feedback mount is cleaned up");
      return bindMatchFeedback(layer, view);
    },
    cleanup() {
      if (!active) return false;
      active = false;
      layer.replaceChildren();
      if (typeof layer.remove === "function") layer.remove();
      if (typeof style.remove === "function") style.remove();
      return true;
    },
    layer,
    style,
  };
}

// The staged destruction nodes are the only authority for hiding shell art.
// Removing a frame (including restart/rollback) restores the original body.
const DESTROYED_TOWER_STYLE = TOWER_IDS.map(id => {
  const suffix = id.replaceAll(":", "-").replace("lane-left", "west").replace("lane-right", "east");
  const combatId = id.replace(":left", ":west").replace(":right", ":east");
  return `.battle-shell:has(.match-feedback__destruction[data-tower-id="${id}"]) :is(.tower-pad--${suffix},.combat-marker[data-combat-id="${combatId}"]){visibility:hidden}`;
}).join("");
const LIFECYCLE_STYLE = DESTROYED_TOWER_STYLE + `
.match-feedback__overlay[data-presentation-tick]{transform:translateY(var(--terminal-lift)) scale(var(--terminal-scale));opacity:var(--terminal-opacity);transform-origin:50% 65%}
@media(prefers-reduced-motion:reduce){.match-feedback__overlay[data-presentation-tick]{transform:none;opacity:1}}

.match-feedback__field{position:absolute;inset:0}
.game-browser-layer--feedback .match-feedback__field{inset:auto;left:var(--arena-left);top:var(--arena-top);width:var(--arena-width);height:var(--arena-height)}
.combat-marker--tower[data-destroyed="true"]{visibility:hidden}

.match-feedback__destruction{width:12%;height:7%;border:0;border-radius:50%;background:#4A332A55;box-shadow:none;isolation:isolate}
.match-feedback__destruction b{position:absolute;left:calc(8% + var(--stone-index)*17%);top:calc(15% + var(--collapse)*35%);width:25%;height:35%;border:2px solid #191D22;background:#8B8578;box-shadow:inset 0 4px #E3CD9E;transform:translateY(calc((1 - var(--collapse))*-18px)) rotate(calc(var(--stone-index)*31deg));clip-path:polygon(12% 0,80% 0,100% 25%,90% 100%,0 85%,0 20%)}
.match-feedback__destruction::after{content:"";position:absolute;inset:-15%;border:5px solid #E3CD9E;border-radius:50%;opacity:var(--dust-opacity);transform:scale(calc(.6 + var(--collapse)*.7));z-index:-1}
.match-feedback__crown-flight{position:absolute;bottom:85%;left:50%;white-space:nowrap;translate:-50% 0;transform:translateY(calc(-1 * var(--crown-rise)));opacity:var(--crown-opacity);color:#E9A83A;font:bold 25px Georgia,serif;text-shadow:0 2px #191D22,2px 0 #191D22,-2px 0 #191D22}
@media(prefers-reduced-motion:reduce){.match-feedback__destruction b{top:50%;transform:none}.match-feedback__destruction::after{transform:none}.match-feedback__crown-flight{transform:none;opacity:1}}
`;
