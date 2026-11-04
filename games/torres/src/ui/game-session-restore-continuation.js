// Modificado para Alma, 2026-10-31: reproduce también las órdenes externas del norte ("submit-north").
// Original: Moss & Ember, ThatXliner/clash-royale-clone, commit 75d30d1 (AGPL-3.0-only).
import {
  GAME_SESSION_MAX_SNAPSHOT_BYTES,
  GAME_SESSION_MAX_TRANSCRIPT,
  GameSession,
} from "../sim/game-session.js";

// This browser-private helper deliberately uses only the public GameSession
// facade. It owns no compact continuation authority and never changes the
// simulation kernel's private compact-handle boundary.
const SNAPSHOT_GRAPH_LIMITS = Object.freeze({ arrayLength: 20_000,
  containers: 100_000, depth: 128, keys: 1_024, nodes: 200_000,
  stringLength: 8_388_608 });
const CONTINUATIONS = new WeakMap();
const PREPARED_RESTORES = new WeakMap();

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.keys(value).sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function exact(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${label} must be a plain object`);
  }
  const actual = Object.keys(value).sort(), expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${label} has an invalid shape`);
  }
  return value;
}

function scalarByteLength(text, label) {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const low = text.charCodeAt(index + 1);
      if (!(low >= 0xdc00 && low <= 0xdfff)) {
        throw new TypeError(`${label} contains a lone surrogate`);
      }
      bytes += 4; index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new TypeError(`${label} contains a lone surrogate`);
    } else bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : 3;
  }
  return bytes;
}

function preflight(value, limits, label) {
  const stack = [{ depth: 0, value }];
  let containers = 0, nodes = 0;
  while (stack.length) {
    const current = stack.pop();
    nodes += 1;
    if (nodes > limits.nodes) throw new RangeError(`${label} exceeds its node bound`);
    if (current.depth > limits.depth) throw new RangeError(`${label} exceeds its depth bound`);
    const entry = current.value;
    if (typeof entry === "string") {
      if (entry.length > limits.stringLength) {
        throw new RangeError(`${label} exceeds its string bound`);
      }
      scalarByteLength(entry, label);
      continue;
    }
    if (typeof entry === "number" && (!Number.isSafeInteger(entry) || !Number.isFinite(entry))) {
      throw new TypeError(`${label} contains a non-safe integer`);
    }
    if (entry === null || typeof entry === "boolean" || typeof entry === "number") continue;
    if (!entry || typeof entry !== "object") {
      throw new TypeError(`${label} contains an invalid value`);
    }
    containers += 1;
    if (containers > limits.containers) {
      throw new RangeError(`${label} exceeds its container bound`);
    }
    if (Array.isArray(entry)) {
      if (entry.length > limits.arrayLength) {
        throw new RangeError(`${label} exceeds its array bound`);
      }
      for (let index = entry.length - 1; index >= 0; index -= 1) {
        stack.push({ depth: current.depth + 1, value: entry[index] });
      }
      continue;
    }
    if (Object.getPrototypeOf(entry) !== Object.prototype) {
      throw new TypeError(`${label} contains a non-plain object`);
    }
    const keys = Object.keys(entry);
    if (keys.length > limits.keys) throw new RangeError(`${label} exceeds its key bound`);
    for (let index = keys.length - 1; index >= 0; index -= 1) {
      const key = keys[index];
      if (key.length > limits.stringLength) {
        throw new RangeError(`${label} exceeds its string bound`);
      }
      scalarByteLength(key, label);
      if (["__proto__", "constructor", "prototype"].includes(key)) {
        throw new TypeError(`${label} contains a forbidden key`);
      }
      stack.push({ depth: current.depth + 1, value: entry[key] });
    }
  }
  return value;
}

function parsed(serialized, label) {
  if (typeof serialized !== "string") {
    throw new TypeError(`${label} must be canonical JSON text`);
  }
  if (scalarByteLength(serialized, label) > GAME_SESSION_MAX_SNAPSHOT_BYTES) {
    throw new RangeError(`${label} exceeds its byte bound`);
  }
  let value;
  try { value = JSON.parse(serialized); } catch {
    throw new TypeError(`${label} must be valid JSON`);
  }
  preflight(value, SNAPSHOT_GRAPH_LIMITS, label);
  if (canonical(value) !== serialized) {
    throw new TypeError(`${label} must be canonical JSON`);
  }
  return value;
}

function continuationState(continuation) {
  const state = CONTINUATIONS.get(continuation);
  if (state === undefined) {
    throw new TypeError("game session restore continuation is invalid");
  }
  return state;
}

class GameSessionRestoreContinuation {
  constructor(serialized) {
    const value = exact(parsed(serialized, "game session snapshot"),
      ["setup", "transcript", "version"], "game session snapshot");
    if (value.version !== 2 || !Array.isArray(value.transcript) ||
        value.transcript.length > GAME_SESSION_MAX_TRANSCRIPT) {
      throw new TypeError("unsupported or oversized game session snapshot");
    }
    CONTINUATIONS.set(this, { bytes: serialized, complete: false, index: 0,
      issued: false, ready: value.transcript.length === 0,
      session: new GameSession(canonical(value.setup)), transcript: value.transcript });
    Object.freeze(this);
  }

  get complete() { return continuationState(this).complete; }

  get ready() { return continuationState(this).ready; }

  get session() {
    const state = continuationState(this);
    if (!state.complete) throw new Error("game session restore continuation is incomplete");
    return state.session;
  }

  /** Apply one canonical transcript operation, or exactly one public simulation tick. */
  advance() {
    const state = continuationState(this);
    if (state.complete) return Object.freeze({ complete: true, index: state.index });
    if (state.ready) {
      throw new Error("game session restore continuation requires finalization");
    }
    const operation = state.transcript[state.index];
    if (!operation || typeof operation !== "object" || Array.isArray(operation)) {
      throw new TypeError("game session transcript operation is invalid");
    }
    if (operation.type === "step") {
      exact(operation, ["type"], "game session step operation");
      const sessionState = state.session.state;
      if (sessionState.paused || sessionState.terminal) {
        throw new TypeError("game session transcript contains an uncaused step");
      }
      state.session.stepMany(1);
    } else if (operation.type === "submit") {
      exact(operation, ["command", "type"], "game session submit operation");
      state.session.submitPlayerCommand(canonical(operation.command));
    } else if (operation.type === "submit-north") {
      // Alma: orden externa del lado norte.
      exact(operation, ["command", "type"], "game session north submit operation");
      state.session.submitNorthCommand(canonical(operation.command));
    } else if (operation.type === "pause") {
      exact(operation, ["type"], "game session pause operation");
      if (state.session.state.paused) {
        throw new TypeError("game session transcript contains an uncaused pause");
      }
      state.session.pause();
    } else if (operation.type === "resume") {
      exact(operation, ["type"], "game session resume operation");
      if (!state.session.state.paused) {
        throw new TypeError("game session transcript contains an uncaused resume");
      }
      state.session.resume();
    } else {
      throw new TypeError("game session transcript operation type is invalid");
    }
    state.index += 1;
    state.ready = state.index === state.transcript.length;
    return Object.freeze({ complete: state.complete, index: state.index, ready: state.ready });
  }

  /** Perform the final exact canonical-byte witness in its own yielded task. */
  finalize() {
    const state = continuationState(this);
    if (!state.ready) throw new Error("game session restore continuation is incomplete");
    if (!state.complete) {
      if (state.session.serialize() !== state.bytes) {
        throw new TypeError("game session transcript did not reproduce its snapshot");
      }
      state.complete = true;
    }
    return Object.freeze({ complete: state.complete, index: state.index });
  }
}

export function createGameSessionRestoreContinuation(serialized) {
  return new GameSessionRestoreContinuation(serialized);
}

/** Mint one opaque exact-byte handoff for a complete cursor and one loop owner. */
export function createGameBrowserRestoreCapability(continuation, browserBytes, sessionBytes, owner) {
  const state = CONTINUATIONS.get(continuation);
  if (state === undefined || !state.complete || state.issued || state.bytes !== sessionBytes ||
      typeof browserBytes !== "string" || owner === null ||
      (typeof owner !== "object" && typeof owner !== "function")) {
    throw new TypeError("game session restore continuation cannot mint a capability");
  }
  const capability = Object.freeze({});
  state.issued = true;
  PREPARED_RESTORES.set(capability, { bytes: browserBytes, owner, session: state.session });
  return capability;
}

/** Consume one matching opaque handoff without reading any attacker properties. */
export function consumeGameBrowserRestoreCapability(capability, bytes, owner) {
  const state = PREPARED_RESTORES.get(capability);
  if (state === undefined || state.bytes !== bytes || state.owner !== owner) {
    throw new TypeError("game browser restore capability is invalid, reused, or cross-loop");
  }
  PREPARED_RESTORES.delete(capability);
  return state.session;
}
