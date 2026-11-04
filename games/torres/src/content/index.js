export {
  CARD_KINDS,
  CARD_RARITIES,
  COMPONENT_ROLES,
  MILLITILES_PER_TILE,
  TARGET_MODES,
  TICKS_PER_SECOND,
  createCardCatalog,
  secondsToTicksExact,
  tilesToMillitilesExact,
  validateCardDefinition,
} from "./schema.js";

export {
  createBasicMeleeCatalog,
  createBasicMeleeCombatant,
} from "./cards/basic-melee.js";

export {
  BasicRangedDuel,
  createBasicRangedCatalog,
  createBasicRangedCombatant,
} from "./cards/basic-ranged.js";

export {
  BasicFlyingDuel,
  acquireBasicFlyingTarget,
  advanceBasicFlyingMovement,
  createBasicFlyingCatalog,
  createBasicFlyingCombatant,
  createBasicFlyingMovement,
  restoreBasicFlyingMovement,
  serializeBasicFlyingMovement,
} from "./cards/basic-flying.js";

export {
  createSquadMembers,
  createSwarmCatalog,
  layoutSquad,
} from "./cards/swarms.js";

export {
  createOrdinaryProjectileSquadCatalog,
} from "./cards/ordinary-projectile-squads.js";

export {
  createOrdinaryProjectileSplashCatalog,
} from "./cards/ordinary-projectile-splash.js";

export {
  SpawnBatchMaterializer,
  createSpawnPlacementQuestionRecords,
} from "./cards/spawn-placement.js";

export {
  DEATH_SPAWN_IDENTITY,
  DeathSpawnEncounter,
  createDeathSpawnFixture,
  createDeathSpawnQuestionRecords,
} from "./cards/death-spawns.js";

export {
  DEATH_CONVERSION_IDENTITY,
  DeathConversionEncounter,
  createDeathConversionFixture,
  createDeathConversionQuestionRecords,
} from "./cards/death-conversion.js";

export {
  StructureSeekerEncounter,
  createStructureSeekerCatalog,
  createStructureSeekerFixture,
} from "./cards/structure-seeker.js";

export {
  ShieldFormEncounter,
  createShieldFormCatalog,
} from "./cards/shields-forms.js";

export {
  ChargeSpecialEncounter,
  createChargeQuestionFixture,
  createChargeSpecialCatalog,
  createChargeSpecialFixture,
  evaluateChargeQuestionBoundary,
} from "./cards/special-movement-charge.js";

export {
  DashEncounter,
  createDashQuestionFixture,
  createDashSpecialCatalog,
  createDashSpecialFixture,
  evaluateDashQuestionBoundary,
} from "./cards/special-movement-dash.js";

export {
  JumpEncounter,
  createJumpQuestionFixture,
  createJumpSpecialCatalog,
  createJumpSpecialFixture,
  evaluateJumpQuestionBoundary,
} from "./cards/special-movement-jump.js";

export {
  RecoilEncounter,
  createRecoilQuestionFixture,
  createRecoilSpecialCatalog,
  createRecoilSpecialFixture,
  evaluateRecoilQuestionBoundary,
} from "./cards/special-movement-recoil.js";

export {
  ForcedKnockbackEncounter,
  createKnockbackQuestionRecords,
  createKnockbackSpecialCatalog,
  createKnockbackSpecialFixture,
  evaluateForcedKnockbackQuestionBoundary,
} from "./cards/special-movement-knockback.js";

export {
  RetargetAttackEncounter,
  createRetargetFixture,
  createRetargetQuestionRecords,
  createRetargetSpecialCatalog,
} from "./cards/special-movement-retarget.js";

export {
  ChargeKnockbackRetargetEncounter,
  createChargeKnockbackCatalog,
  createChargeKnockbackFixture,
  createChargeKnockbackQuestionRecords,
} from "./cards/special-movement-charge-knockback.js";

export {
  DashKnockbackRetargetEncounter,
  createDashKnockbackFixture,
  createDashKnockbackQuestionRecords,
} from "./cards/special-movement-dash-knockback.js";

export {
  LeapKnockbackRetargetEncounter,
  createLeapKnockbackFixture,
  createLeapKnockbackQuestionRecords,
} from "./cards/special-movement-leap-knockback.js";

export {
  ChainEncounter,
  createChainQuestionFixture,
  createChainSpecialCatalog,
  createChainSpecialFixture,
} from "./cards/special-projectiles-chain.js";

export {
  PierceEncounter,
  createPierceQuestionFixture,
  createPierceSpecialCatalog,
  createPierceSpecialFixture,
} from "./cards/special-projectiles-pierce.js";

export {
  ReturnEncounter,
  createReturnQuestionFixture,
  createReturnSpecialCatalog,
  createReturnSpecialFixture,
} from "./cards/special-projectiles-return.js";

export {
  PelletEncounter,
  createPelletQuestionFixture,
  createPelletSpecialCatalog,
  createPelletSpecialFixture,
} from "./cards/special-projectiles-pellets.js";

export {
  ReflectionEncounter,
  createReflectionQuestionFixture,
  createReflectionSpecialCatalog,
  createReflectionSpecialFixture,
} from "./cards/special-projectiles-reflection.js";

export {
  ConsecutiveTargetRampEncounter,
  createRampFixture,
  createRampQuestionRecords,
  createRampSpecialCatalog,
} from "./cards/special-combat-ramp.js";

export {
  InstantaneousCombatResetEncounter,
  createResetFixture,
  createResetQuestionRecords,
  createResetSpecialCatalog,
} from "./cards/special-combat-reset.js";

export {
  TimedFullDisableStunEncounter,
  createStunFixture,
  createStunQuestionRecords,
  createStunSpecialCatalog,
} from "./cards/combat-status-stun.js";

export {
  TimedMovementAttackSlowEncounter,
  createSlowFixture,
  createSlowQuestionRecords,
  createSlowSpecialCatalog,
} from "./cards/special-combat-slow.js";

export {
  TimedMovementAttackRageEncounter,
  createRageFixture,
  createRageQuestionRecords,
  createRageSpecialCatalog,
} from "./cards/special-combat-rage.js";

export {
  TimedMovementOnlySnareEncounter,
  createSnareFixture,
  createSnareQuestionRecords,
  createSnareSpecialCatalog,
} from "./cards/special-combat-snare.js";

export {
  DeathEffectsEncounter,
  createDeathEffectsCatalog,
  createDeathEffectsFixture,
  createDeathEffectsQuestions,
} from "./cards/death-effects.js";

export {
  InstantHealingEncounter,
  createHealCatalog,
  createHealFixture,
  createHealQuestionRecords,
} from "./cards/combat-status-heal.js";

export {
  InvisibilityRevealEncounter,
  createInvisibilityFixture,
  createInvisibilityMappedFieldQuestionRecords,
  createInvisibilityQuestionRecords,
  createInvisibilitySpecialCatalog,
} from "./cards/combat-status-invisibility.js";

export {
  DefensiveBuildingEncounter,
  createDefensiveBuildingCatalog,
  createDefensiveBuildingCorpusRecords,
  createDefensiveBuildingFixture,
  createDefensiveBuildingQuestionRecords,
} from "./cards/buildings-defensive.js";

export {
  SPAWNER_BUILDING_IDENTITIES,
  SpawnerBuildingEncounter,
  createSpawnerBuildingCorpusRecords,
  createSpawnerBuildingFixture,
  createSpawnerBuildingQuestionRecords,
} from "./cards/buildings-spawner.js";

export {
  ResourceBuildingEncounter,
  createResourceBuildingCatalog,
  createResourceBuildingCorpusRecords,
  createResourceBuildingFixture,
  createResourceBuildingQuestionRecords,
} from "./cards/buildings-resource.js";

export {
  UndergroundTravelBuildingEncounter,
  createUndergroundTravelBuildingCatalog,
  createUndergroundTravelBuildingCorpusRecords,
  createUndergroundTravelBuildingFixture,
  createUndergroundTravelBuildingQuestionRecords,
} from "./cards/buildings-travel.js";

export {
  InstantRadiusSpellEncounter,
  createInstantSpellCatalog,
  createInstantSpellFixture,
  createInstantSpellQuestionRecords,
} from "./cards/spells-instant.js";

export {
  createUnprofiledAdmittedEffectProfileQuestion,
  createSessionSpellProfileReceipts,
  serializeSessionSpellProfileReceipts,
} from "./session-spell-profile-receipts.js";

export {
  COPY_CARD_MAX_TICK,
  COPY_CARD_RULE_VERSION,
  PREVIOUS_CARD_COPY_QUESTIONS,
  PreviousCardCopyMatch,
  getPreviousCardCopyQuestions,
} from "./cards/spells-copy-card.js";

export {
  DeployedUnitCloneEncounter,
  createCloneUnitEntityFromShieldForm,
  getCloneUnitQuestionRecords,
  getCloneUnitRules,
} from "./cards/spells-clone-unit.js";

export {
  SPAWN_SPELL_COUNTS,
  SPAWN_SPELL_IDENTITIES,
  SpawnSpellEncounter,
  createSpawnSpellFixture,
  createSpawnSpellQuestionRecords,
} from "./cards/spells-spawn.js";

export {
  PeriodicAreaSpellEncounter,
  createPeriodicSpellCatalog,
  createPeriodicSpellFixture,
  createPeriodicSpellQuestionRecords,
} from "./cards/spells-periodic.js";

export {
  TravelingLineSpellEncounter,
  createTravelingLineSpellCatalog,
  createTravelingLineSpellFixture,
  createTravelingLineSpellQuestionRecords,
} from "./cards/spells-travel-line.js";

export {
  ReturningSpellEncounter,
  createReturningSpellCatalog,
  createReturningSpellFixture,
  createReturningSpellQuestionRecords,
} from "./cards/spells-return.js";

export {
  ThreeWaveTravelingSpellEncounter,
  createThreeWaveTravelingSpellCatalog,
  createThreeWaveTravelingSpellFixture,
  createThreeWaveTravelingSpellQuestionRecords,
} from "./cards/spells-three-wave.js";

export {
  RollingSpellEncounter,
  createRollingSpellCatalog,
  createRollingSpellFixture,
  createRollingSpellQuestionRecords,
} from "./cards/spells-roll.js";

export {
  ChampionAbilityController,
  createChampionAbilityCatalog,
  createChampionAbilityFixture,
  createChampionAbilityQuestionRecords,
  createChampionMappedFieldQuestionRecords,
  probeChampionAbilityAdapters,
} from "./cards/champion-abilities.js";
