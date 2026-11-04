// Modificado para Alma, 2026-10-31: textos del botón de sonido en español.
// Original: Moss & Ember, ThatXliner/clash-royale-clone, commit 75d30d1 (AGPL-3.0-only).
import { isAuthenticGameAudioRuntime } from "../audio/game-audio-runtime.js";
import { isAuthenticBrowserPcmAudioSink } from "../audio/browser-audio.js";

const activeShells = new WeakSet();

function exactToggle(shell) {
  if (shell === null || typeof shell !== "object" ||
      typeof shell.querySelectorAll !== "function" ||
      typeof shell.addEventListener !== "function" ||
      typeof shell.removeEventListener !== "function") {
    throw new TypeError("game audio controls require a browser shell");
  }
  const toggles = Array.from(shell.querySelectorAll('[data-ui="audio-toggle"]'));
  if (toggles.length !== 1 || typeof toggles[0].addEventListener !== "function" ||
      typeof toggles[0].removeEventListener !== "function" ||
      typeof toggles[0].setAttribute !== "function") {
    throw new TypeError("game audio controls require one audio toggle");
  }
  return toggles[0];
}

export function mountGameAudioControls(shell, browserAudio, runtime, uiBridge = null) {
  if (!isAuthenticBrowserPcmAudioSink(browserAudio) ||
      !isAuthenticGameAudioRuntime(runtime)) {
    throw new TypeError("game audio controls require authentic audio authorities");
  }
  if (uiBridge !== null &&
      (typeof uiBridge !== "object" || typeof uiBridge.toggle !== "function")) {
    throw new TypeError("game audio controls UI bridge is invalid");
  }
  if (activeShells.has(shell)) throw new RangeError("game audio controls are already mounted");
  const toggle = exactToggle(shell);
  let active = true;
  const render = () => {
    const muted = runtime.state.muted;
    toggle.setAttribute("aria-pressed", String(muted));
    toggle.setAttribute("aria-label", muted ? "Activar sonido" : "Silenciar sonido");
    toggle.textContent = muted ? "Sonido no" : "Sonido sí";
  };
  const unlock = (event) => {
    if (!active || event?.isTrusted !== true) return false;
    return browserAudio.unlock(event);
  };
  const onGesture = (event) => {
    const result = unlock(event);
    if (result !== false) void result.catch(() => {});
    return result;
  };
  const onToggle = (event) => {
    if (!active || event?.isTrusted !== true) return false;
    void browserAudio.unlock(event).catch(() => {});
    if (uiBridge !== null) uiBridge.toggle();
    runtime.setMuted(!runtime.state.muted);
    render();
    return true;
  };
  const gestureTypes = ["keydown", "mousedown", "pointerdown", "touchend"];
  const mountedGestureTypes = [];
  let toggleMounted = false;
  try {
    for (const type of gestureTypes) {
      mountedGestureTypes.push(type);
      shell.addEventListener(type, onGesture);
    }
    toggleMounted = true;
    toggle.addEventListener("click", onToggle);
    activeShells.add(shell);
    render();
  } catch (error) {
    active = false;
    for (const type of mountedGestureTypes) {
      try { shell.removeEventListener(type, onGesture); } catch {}
    }
    if (toggleMounted) {
      try { toggle.removeEventListener("click", onToggle); } catch {}
    }
    activeShells.delete(shell);
    throw error;
  }
  return Object.freeze({
    dispose() {
      if (!active) return false;
      active = false;
      const errors = [];
      for (const type of gestureTypes) {
        try { shell.removeEventListener(type, onGesture); } catch (error) { errors.push(error); }
      }
      try { toggle.removeEventListener("click", onToggle); } catch (error) { errors.push(error); }
      activeShells.delete(shell);
      try { runtime.dispose(); } catch (error) { errors.push(error); }
      try { browserAudio.dispose(); } catch (error) { errors.push(error); }
      if (errors.length > 0) {
        throw new AggregateError(errors, "game audio controls cleanup failed");
      }
      return true;
    },
    setGainBasisPoints(value) {
      if (!active) throw new Error("game audio controls are disposed");
      const state = runtime.setGainBasisPoints(value);
      render();
      return state;
    },
    get state() {
      const audio = browserAudio.state;
      const runtimeState = runtime.state;
      return Object.freeze({
        active,
        audio,
        gainBasisPoints: runtimeState.gainBasisPoints,
        muted: runtimeState.muted,
      });
    },
    unlock,
  });
}
