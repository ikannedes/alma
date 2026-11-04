import {
  createGameAudioRuntimeUiCapability,
  isAuthenticGameAudioRuntime,
} from "../audio/game-audio-runtime.js";
import { consumeArenaInputFeedbackReceipt } from "./input-controller.js";

const attachedInputs = new WeakSet();

function checkedRuntime(runtime) {
  if (!isAuthenticGameAudioRuntime(runtime)) {
    throw new TypeError("game audio UI bridge requires an authentic runtime");
  }
  return runtime;
}

function checkedResult(result, label) {
  if (result === null || typeof result !== "object" ||
      typeof result.accepted !== "boolean") {
    throw new TypeError(`${label} is not a canonical input result`);
  }
  return result;
}

/**
 * Bridge browser-only feedback receipts into the runtime's authenticated UI
 * command seam. It owns one deterministic command sequence for the lifetime
 * of a mounted browser graph; input remounts reuse that sequence rather than
 * creating a second audio authority.
 */
export function createGameAudioUiBridge(runtimeValue) {
  const runtime = checkedRuntime(runtimeValue);
  const capability = createGameAudioRuntimeUiCapability(runtime);
  let active = true;
  let nextSequence = 0;

  const dispatch = (kind, cardId = null) => {
    if (!active) throw new Error("game audio UI bridge is disposed");
    const command = {
      kind,
      sequence: nextSequence,
      tick: runtime.state.sessionTick,
    };
    if (cardId !== null) command.cardId = cardId;
    const result = runtime.submitUiCommand(capability, command);
    if (result.accepted === true || result.duplicate === true) nextSequence += 1;
    return result;
  };

  const attach = (input) => {
    if (!active) throw new Error("game audio UI bridge is disposed");
    if (input === null || (typeof input !== "object" && typeof input !== "function") ||
        typeof input.setFeedback !== "function") {
      throw new TypeError("game audio UI bridge requires a mounted arena input");
    }
    if (attachedInputs.has(input)) throw new RangeError("game audio UI bridge is already attached");
    attachedInputs.add(input);
    try {
      input.setFeedback({
        onPlace(receipt) {
          const payload = consumeArenaInputFeedbackReceipt(receipt);
          const result = checkedResult(payload.result, "arena placement feedback");
          if (result.accepted === true) {
            const cardId = result.command?.cardId;
            if (typeof cardId !== "string") {
              throw new TypeError("accepted placement feedback is missing cardId");
            }
            return dispatch("card-play", cardId);
          }
          return dispatch("ui-reject");
        },
        onSelect(result) {
          const checked = checkedResult(result, "arena selection feedback");
          if (checked.accepted === true) {
            if (typeof checked.cardId !== "string") {
              throw new TypeError("accepted selection feedback is missing cardId");
            }
            return dispatch("card-select", checked.cardId);
          }
          return dispatch("ui-reject", typeof checked.cardId === "string"
            ? checked.cardId : null);
        },
      });
    } catch (error) {
      attachedInputs.delete(input);
      throw error;
    }
    return true;
  };

  return Object.freeze({
    attach,
    confirm() { return dispatch("ui-confirm"); },
    dispose() {
      if (!active) return false;
      active = false;
      return true;
    },
    get state() {
      return Object.freeze({ active, sequence: nextSequence });
    },
    reject(cardId = null) { return dispatch("ui-reject", cardId); },
    toggle() { return dispatch("ui-toggle"); },
  });
}

export const createGameAudioInputAudioBridge = createGameAudioUiBridge;
