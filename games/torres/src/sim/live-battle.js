import {
  getLiveBattlePlayableCardIds,
  LiveBattle as KernelLiveBattle,
  MAX_LIVE_BATTLE_DEPLOYMENTS,
  MAX_LIVE_BATTLE_STEP_TICKS,
  MAX_LIVE_BATTLE_STRUCTURES,
  MAX_LIVE_BATTLE_UNITS,
  parseLiveBattleSetup,
} from "./battle-continuation-kernel.js";
import {
  admitSessionTroopProjectileRuntimeFromBattleSnapshot,
  admitSessionTroopProjectileRuntimeProfiles,
} from "./session-troop-projectile-runtime.js";

function projectilePlan(value) {
  return value === undefined ? undefined :
    admitSessionTroopProjectileRuntimeProfiles(value);
}

export class LiveBattle extends KernelLiveBattle {
  constructor(value, troopRuntimeProfiles = undefined, statusRuntimeProfiles = undefined,
    projectileRuntimeProfiles = undefined) {
    super(value, troopRuntimeProfiles, statusRuntimeProfiles, projectilePlan(projectileRuntimeProfiles));
  }

  static restore(serialized) {
    const plan = admitSessionTroopProjectileRuntimeFromBattleSnapshot(serialized);
    const restored = KernelLiveBattle.restore(serialized, plan);
    Object.setPrototypeOf(restored, LiveBattle.prototype);
    return restored;
  }
}

export {
  getLiveBattlePlayableCardIds,
  MAX_LIVE_BATTLE_DEPLOYMENTS,
  MAX_LIVE_BATTLE_STEP_TICKS,
  MAX_LIVE_BATTLE_STRUCTURES,
  MAX_LIVE_BATTLE_UNITS,
  parseLiveBattleSetup,
};
