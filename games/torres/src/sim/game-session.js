import {
  GAME_SESSION_MAX_BATCH_TICKS,
  GAME_SESSION_MAX_SETUP_BYTES,
  GAME_SESSION_MAX_SNAPSHOT_BYTES,
  GAME_SESSION_MAX_TRANSCRIPT,
  GAME_SESSION_SETUP_GRAPH_LIMITS,
  GAME_SESSION_SNAPSHOT_GRAPH_LIMITS,
  GameSession as KernelGameSession,
  getGameSessionAudioReplay,
  isAuthenticGameSession,
  isAuthenticGameSessionProjectionSnapshot,
} from "./battle-continuation-kernel.js";
import {
  admitSessionTroopProjectileRuntimeFromGameSnapshot,
  admitSessionTroopProjectileRuntimeFromSetup,
} from "./session-troop-projectile-runtime.js";

export class GameSession extends KernelGameSession {
  constructor(canonicalSetup, restoreCapability = null) {
    super(canonicalSetup, restoreCapability,
      admitSessionTroopProjectileRuntimeFromSetup(canonicalSetup));
  }

  static restore(serialized) {
    const plan = admitSessionTroopProjectileRuntimeFromGameSnapshot(serialized);
    const restored = KernelGameSession.restore(serialized, plan);
    Object.setPrototypeOf(restored, GameSession.prototype);
    return restored;
  }

  fork() {
    const forked = super.fork();
    Object.setPrototypeOf(forked, GameSession.prototype);
    return forked;
  }
}

export {
  GAME_SESSION_MAX_BATCH_TICKS,
  GAME_SESSION_MAX_SETUP_BYTES,
  GAME_SESSION_MAX_SNAPSHOT_BYTES,
  GAME_SESSION_MAX_TRANSCRIPT,
  GAME_SESSION_SETUP_GRAPH_LIMITS,
  GAME_SESSION_SNAPSHOT_GRAPH_LIMITS,
  getGameSessionAudioReplay,
  isAuthenticGameSession,
  isAuthenticGameSessionProjectionSnapshot,
};
