import { isAuthenticGameSession } from "../sim/game-session.js";
import {
  consumeArenaInputCommitReceipt,
  createArenaInputCommitSinkCapability,
  subscribeArenaInputCommits,
  unsubscribeArenaInputCommits,
} from "./input-controller.js";

const MAX_DELIVERIES = 10_000;

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function clone(value) { return JSON.parse(JSON.stringify(value)); }

function freeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function checkedSnapshot(bytes) {
  if (typeof bytes !== "string" || new TextEncoder().encode(bytes).byteLength > 1_048_576) {
    throw new TypeError("game input bridge snapshot must be bounded canonical text");
  }
  let value;
  try { value = JSON.parse(bytes); } catch {
    throw new TypeError("game input bridge snapshot must be valid JSON");
  }
  if (canonical(value) !== bytes || value === null || Array.isArray(value) ||
      Object.keys(value).sort().join(",") !== "deliveries,version" ||
      value.version !== 1 || !Array.isArray(value.deliveries) ||
      value.deliveries.length > MAX_DELIVERIES) {
    throw new TypeError("game input bridge snapshot is invalid");
  }
  for (const [index, delivery] of value.deliveries.entries()) {
    const spell = delivery?.command?.type === "spell";
    const commandKeys = delivery?.command && typeof delivery.command === "object"
      ? Object.keys(delivery.command).sort().join(",") : "";
    if (delivery === null || Array.isArray(delivery) ||
        Object.keys(delivery).sort().join(",") !== "admission,command" ||
        delivery.command === null || Array.isArray(delivery.command) ||
        commandKeys !== (spell
          ? "cardId,commandId,point,side,slot,tick,type"
          : "cardId,commandId,point,slot,tick,type") ||
        delivery.admission === null || Array.isArray(delivery.admission) ||
        delivery.admission.commandId !== delivery.command.commandId ||
        delivery.command.commandId !== index + 1) {
      throw new TypeError("game input bridge delivery history is invalid");
    }
    if (!['deploy', 'spell'].includes(delivery.command.type)) {
      throw new TypeError("game input bridge delivery type is invalid");
    }
    if (spell && delivery.command.side !== "south") {
      throw new TypeError("game input bridge spell side is invalid");
    }
  }
  return clone(value);
}

export class GameInputBridge {
  #active = true;
  #deliveries = [];
  #session;
  #subscription;

  constructor(browserInput, session) {
    if (!isAuthenticGameSession(session)) {
      throw new TypeError("game input bridge requires one exact GameSession");
    }
    this.#session = session;
    const capability = createArenaInputCommitSinkCapability(
      (receipt) => this.#deliver(receipt),
    );
    this.#subscription = subscribeArenaInputCommits(browserInput, capability);
    Object.freeze(this);
  }

  #deliver(receipt) {
    if (!this.#active) throw new Error("game input bridge is unsubscribed");
    if (this.#deliveries.length >= MAX_DELIVERIES) {
      throw new RangeError("game input bridge delivery bound exceeded");
    }
    const payload = consumeArenaInputCommitReceipt(receipt);
    const command = {
      cardId: payload.cardId,
      commandId: payload.commandId,
      point: clone(payload.point),
      slot: payload.slot,
      ...(payload.type === "spell" ? { side: "south" } : {}),
      tick: payload.tick,
      type: payload.type,
    };
    const before = this.#session.serialize();
    let admission;
    try {
      admission = this.#session.submitPlayerCommand(canonical(command));
    } catch (error) {
      if (this.#session.serialize() !== before) {
        this.#active = false;
        throw new AggregateError([error],
          "game input bridge session submission split authority");
      }
      throw error;
    }
    this.#deliveries.push(freeze({ admission: clone(admission), command }));
    return admission;
  }

  get state() {
    return freeze({ active: this.#active, deliveries: clone(this.#deliveries) });
  }

  serialize() {
    return canonical({ deliveries: this.#deliveries, version: 1 });
  }

  unsubscribe() {
    if (!this.#active) return false;
    this.#active = false;
    unsubscribeArenaInputCommits(this.#subscription);
    return true;
  }

  static restore(bytes, browserInput, session) {
    const snapshot = checkedSnapshot(bytes);
    if (!isAuthenticGameSession(session)) {
      throw new TypeError("game input bridge restore requires one exact GameSession");
    }
    const transcript = JSON.parse(session.serialize()).transcript;
    for (const delivery of snapshot.deliveries) {
      if (!transcript.some((operation) => operation.type === "submit" &&
          canonical(operation.command) === canonical(delivery.command))) {
        throw new TypeError("game input bridge history diverges from session");
      }
    }
    const bridge = new GameInputBridge(browserInput, session);
    bridge.#deliveries = snapshot.deliveries.map((delivery) => freeze(delivery));
    if (bridge.serialize() !== bytes) {
      bridge.unsubscribe();
      throw new TypeError("game input bridge snapshot did not restore canonically");
    }
    return bridge;
  }
}
