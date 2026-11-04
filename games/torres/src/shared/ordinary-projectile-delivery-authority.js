const CATALOG_ID = "ordinary-projectile-squads-v1";
export const ORDINARY_PROJECTILE_SOURCE_CLAIMS = Object.freeze([
  Object.freeze({
    cardId: "sunthread-pair",
    archetypeId: "sunthread-warden",
    catalogId: CATALOG_ID,
    sourceExport: "createOrdinaryProjectileSquadCatalog",
  }),
  Object.freeze({
    cardId: "duskwing-trio",
    archetypeId: "duskwing",
    catalogId: CATALOG_ID,
    sourceExport: "createOrdinaryProjectileSquadCatalog",
  }),
  Object.freeze({
    cardId: "coppershade-flock",
    archetypeId: "coppershade",
    catalogId: CATALOG_ID,
    sourceExport: "createOrdinaryProjectileSquadCatalog",
  }),
  Object.freeze({
    cardId: "kilnkeeper",
    archetypeId: "kilnkeeper",
    catalogId: "ordinary-projectile-splash-v1",
    sourceExport: "createOrdinaryProjectileSplashCatalog",
  }),
  Object.freeze({
    cardId: "rime-adept",
    archetypeId: "rime-adept",
    catalogId: "ordinary-projectile-splash-v1",
    sourceExport: "createSlowSpecialCatalog",
  }),
]);
const QUESTION_HOMING_RUNTIME_POLICY = Object.freeze({
  pursuitSpeedMillitilesPerTick: 500,
  directionUpdateRule: "aim-after-unit-motion-each-boundary",
  directionRoundingRule: "ceil-distance-truncate-components-toward-zero",
  targetLockRule: "retain-launch-target-id",
  retargetRule: "never-reacquire",
  targetDeathRule: "fizzle-on-first-boundary-after-death",
  sourceDeathRule: "continue-after-launch",
  outOfRangeRule: "continue-after-launch-range",
  outOfBoundsRule: "continue-while-position-is-valid",
  contactRadiusRule: "target-body-radius",
  impactCenterRule: "live-target-center",
  intermediateCollisionRule: "no-intermediate-collision",
  arrivalBoundaryRule: "first-boundary-reaching-contact-radius",
  contactOrderRule: "after-motion-before-simultaneous-damage",
});
const SPLASH_SOURCE_PROFILES = Object.freeze([
  Object.freeze({
    archetypeId: "kilnkeeper",
    cardId: "kilnkeeper",
    catalogId: "ordinary-projectile-splash-v1",
    enemiesOnly: true,
    homing: true,
    homingRuntimePolicy: QUESTION_HOMING_RUNTIME_POLICY,
    radiusMillitiles: 1_500,
    sourceExport: "createOrdinaryProjectileSplashCatalog",
    targetLayers: Object.freeze(["air", "ground"]),
  }),
  Object.freeze({
    archetypeId: "rime-adept",
    cardId: "rime-adept",
    catalogId: "ordinary-projectile-splash-v1",
    enemiesOnly: true,
    homing: true,
    homingRuntimePolicy: QUESTION_HOMING_RUNTIME_POLICY,
    radiusMillitiles: 1_000,
    sourceExport: "createSlowSpecialCatalog",
    targetLayers: Object.freeze(["air", "ground"]),
  }),
]);
const POLICY_KEYS = Object.freeze([
  "archetypeId", "cardId", "catalogId", "delivery", "kind",
]);
const SPLASH_PROFILE_KEYS = Object.freeze([
  "archetypeId", "cardId", "catalogId", "enemiesOnly", "homing",
  "homingRuntimePolicy", "radiusMillitiles", "sourceExport", "targetLayers",
]);
const HOMING_RUNTIME_POLICY_KEYS = Object.freeze([
  "arrivalBoundaryRule", "contactOrderRule", "contactRadiusRule", "directionRoundingRule",
  "directionUpdateRule", "impactCenterRule", "intermediateCollisionRule",
  "outOfBoundsRule", "outOfRangeRule", "pursuitSpeedMillitilesPerTick",
  "retargetRule", "sourceDeathRule", "targetDeathRule", "targetLockRule",
]);
const WIZARD_PROJECTILE_DAMAGE_RECEIPT = Object.freeze({
  damage: 281,
  index: 8,
  linkedProjectileId: "chr_wizardProjectile",
  rarity: "rare",
  sourceCommit: "54fdef52c5086393b085f57faeeab8ef86b28160",
  sourceFile: "docs/json/cards_stats_projectile.json",
  sourceFileSha256: "c883516f54f6c17ee77c15cf484b01da9ded22602214c3b0d42b1ab823bd3197",
  sourceUri: "https://raw.githubusercontent.com/RoyaleAPI/cr-api-data/54fdef52c5086393b085f57faeeab8ef86b28160/docs/json/cards_stats_projectile.json",
  tournamentLevel: 11,
  speedRaw: 600,
  gravityRaw: null,
});
const RIME_PROJECTILE_SOURCE = Object.freeze({
  cardId: "rime-adept",
  productProjectileId: "rime-adept-projectile",
  linkedProjectileId: "ice_wizardProjectile",
  sourceCommit: "54fdef52c5086393b085f57faeeab8ef86b28160",
  sourceFile: "docs/json/cards_stats_projectile.json",
  sourceFileSha256: "c883516f54f6c17ee77c15cf484b01da9ded22602214c3b0d42b1ab823bd3197",
  sourceUri: "https://raw.githubusercontent.com/RoyaleAPI/cr-api-data/54fdef52c5086393b085f57faeeab8ef86b28160/docs/json/cards_stats_projectile.json",
});
const RIME_PROJECTILE_DAMAGE_RECEIPT = Object.freeze({
  damage: 90,
  index: 2,
  linkedProjectileId: RIME_PROJECTILE_SOURCE.linkedProjectileId,
  rarity: "legendary",
  sourceCommit: RIME_PROJECTILE_SOURCE.sourceCommit,
  sourceFile: RIME_PROJECTILE_SOURCE.sourceFile,
  sourceFileSha256: RIME_PROJECTILE_SOURCE.sourceFileSha256,
  sourceUri: RIME_PROJECTILE_SOURCE.sourceUri,
  tournamentLevel: 11,
  speedRaw: 700,
  gravityRaw: 50,
});
export const RIME_PROJECTILE_SOURCE_IDENTITY_RECEIPT = Object.freeze({
  cardId: RIME_PROJECTILE_SOURCE.cardId,
  productProjectileId: RIME_PROJECTILE_SOURCE.productProjectileId,
  sourceLinkedProjectileId: RIME_PROJECTILE_SOURCE.linkedProjectileId,
  sourceCommit: RIME_PROJECTILE_SOURCE.sourceCommit,
  sourceFile: RIME_PROJECTILE_SOURCE.sourceFile,
  sourceFileSha256: RIME_PROJECTILE_SOURCE.sourceFileSha256,
  sourceUri: RIME_PROJECTILE_SOURCE.sourceUri,
});
function exact(value, keys, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${label} must be a plain object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const actual = Reflect.ownKeys(descriptors).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length ||
      actual.some((key, index) => key !== expected[index]) ||
      Object.values(descriptors).some((descriptor) =>
        !descriptor.enumerable || !Object.hasOwn(descriptor, "value"))) {
    throw new TypeError(`${label} has an invalid shape`);
  }
  return Object.fromEntries(keys.map((key) => [key, descriptors[key].value]));
}

function exactLayers(value, expected) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype ||
      value.length !== expected.length) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== expected.length + 1 ||
      !Object.hasOwn(descriptors, "length") || descriptors.length.value !== expected.length ||
      descriptors.length.enumerable || Object.hasOwn(descriptors, Symbol.iterator)) return false;
  return expected.every((layer, index) => {
    const descriptor = descriptors[String(index)];
    return descriptor !== undefined && descriptor.enumerable &&
      Object.hasOwn(descriptor, "value") && descriptor.value === layer;
  });
}

function claimFor(cardId, archetypeId) {
  return ORDINARY_PROJECTILE_SOURCE_CLAIMS.find((claim) => claim.cardId === cardId &&
    claim.archetypeId === archetypeId);
}

export function getOrdinaryProjectileDeliveryPolicy(cardId, archetypeId) {
  if (typeof cardId !== "string" || typeof archetypeId !== "string") {
    throw new TypeError("ordinary projectile source identities must be strings");
  }
  const claim = claimFor(cardId, archetypeId);
  if (claim === undefined) return null;
  return {
    archetypeId: claim.archetypeId,
    cardId: claim.cardId,
    catalogId: claim.catalogId,
    delivery: "projectile",
    kind: "source-backed",
  };
}

export function getOrdinaryProjectileSplashProfile(cardId, archetypeId) {
  if (typeof cardId !== "string" || typeof archetypeId !== "string") {
    throw new TypeError("ordinary projectile splash identities must be strings");
  }
  const sourceProfile = SPLASH_SOURCE_PROFILES.find((candidate) =>
    candidate.cardId === cardId && candidate.archetypeId === archetypeId);
  if (sourceProfile === undefined) return null;
  return {
    ...sourceProfile,
    homingRuntimePolicy: { ...sourceProfile.homingRuntimePolicy },
    targetLayers: [...sourceProfile.targetLayers],
  };
}

export function getOrdinaryProjectileSplashSourceFacts(cardId, archetypeId) {
  const profile = getOrdinaryProjectileSplashProfile(cardId, archetypeId);
  if (profile === null) return null;
  const damageReceipt = cardId === "rime-adept"
    ? RIME_PROJECTILE_DAMAGE_RECEIPT
    : WIZARD_PROJECTILE_DAMAGE_RECEIPT;
  const facts = {
    aoeToAir: profile.targetLayers.includes("air"),
    aoeToGround: profile.targetLayers.includes("ground"),
    characterAreaDamageRadiusMillitiles: 0,
    homing: true,
    onlyEnemies: profile.enemiesOnly,
    projectileDamage: damageReceipt.damage,
    projectileDamagePerLevelIndex: damageReceipt.index,
    projectileDamageLinkedProjectileId: damageReceipt.linkedProjectileId,
    projectileDamageRarity: damageReceipt.rarity,
    projectileDamageSourceCommit: damageReceipt.sourceCommit,
    projectileDamageSourceFile: damageReceipt.sourceFile,
    projectileDamageSourceFileSha256: damageReceipt.sourceFileSha256,
    projectileDamageSourceUri: damageReceipt.sourceUri,
    projectileDamageTournamentLevel: damageReceipt.tournamentLevel,
    radiusMillitiles: profile.radiusMillitiles,
    speedRaw: damageReceipt.speedRaw,
  };
  if (cardId === "rime-adept") {
    facts.gravityRaw = damageReceipt.gravityRaw;
    facts.projectileLinked = true;
  }
  return facts;
}

export function assertOrdinaryProjectileSplashProfile(value, cardId, archetypeId) {
  const profile = exact(value, SPLASH_PROFILE_KEYS, "ordinary projectile splash profile");
  const homingRuntimePolicy = exact(profile.homingRuntimePolicy,
    HOMING_RUNTIME_POLICY_KEYS, "ordinary projectile homing runtime QUESTION policy");
  const expected = getOrdinaryProjectileSplashProfile(cardId, archetypeId);
  if (expected === null || profile.archetypeId !== expected.archetypeId ||
      profile.cardId !== expected.cardId || profile.catalogId !== expected.catalogId ||
      profile.enemiesOnly !== expected.enemiesOnly ||
      profile.homing !== expected.homing ||
      HOMING_RUNTIME_POLICY_KEYS.some((key) =>
        homingRuntimePolicy[key] !== expected.homingRuntimePolicy[key]) ||
      profile.radiusMillitiles !== expected.radiusMillitiles ||
      profile.sourceExport !== expected.sourceExport ||
      !exactLayers(profile.targetLayers, expected.targetLayers)) {
    throw new TypeError("ordinary projectile splash profile differs from its admitted source claim");
  }
  return expected;
}

function createAdmittedPolicy(cardId, archetypeId) {
  const policy = getOrdinaryProjectileDeliveryPolicy(cardId, archetypeId);
  if (policy === null) throw new RangeError("ordinary projectile source identity is not admitted");
  return policy;
}

export function assertOrdinaryProjectileDeliveryPolicy(
  value, cardId, archetypeId, delivery,
) {
  const policy = exact(value, POLICY_KEYS, "ordinary projectile delivery policy");
  const expected = createAdmittedPolicy(cardId, archetypeId);
  if (policy.kind !== expected.kind || policy.catalogId !== expected.catalogId ||
      policy.cardId !== expected.cardId || policy.archetypeId !== expected.archetypeId ||
      policy.delivery !== expected.delivery || delivery !== expected.delivery) {
    throw new TypeError("ordinary projectile delivery policy differs from its admitted source claim");
  }
  return expected;
}
