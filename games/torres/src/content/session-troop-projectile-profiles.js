import {
  createChainQuestionFixture,
} from "./cards/special-projectiles-chain.js";
import {
  createPierceQuestionFixture,
} from "./cards/special-projectiles-pierce.js";
import {
  createReturnQuestionFixture,
} from "./cards/special-projectiles-return.js";
import {
  createPelletQuestionFixture,
} from "./cards/special-projectiles-pellets.js";
import {
  createReflectionQuestionFixture,
} from "./cards/special-projectiles-reflection.js";
import {
  AUTHORITATIVE_PROJECTILE_SOURCE_IDS_BY_EXPORT,
  assertAuthoritativeProjectileSourceCatalogs,
} from "./session-troop-projectile-source-admission.js";
import { createSessionTroopProfileManifest } from "./session-troop-profile-catalog.js";
import { createSessionTroopWitnessQuestions } from "./session-troop-roster.js";
import {
  getSessionTroopProjectileAuthorityReceipt,
} from "../shared/session-troop-projectile-authority.js";
import {
  ORDINARY_PROJECTILE_SOURCE_CLAIMS,
  getOrdinaryProjectileDeliveryPolicy,
} from "../shared/ordinary-projectile-delivery-authority.js";
import { createOrdinaryProjectileSquadCatalog } from "./cards/ordinary-projectile-squads.js";
import { createOrdinaryProjectileSplashCatalog } from "./cards/ordinary-projectile-splash.js";
import { createSlowSpecialCatalog } from "./cards/special-combat-slow.js";

const VERSION = 1;
const MAX_SOURCE_CATALOG_ROWS = 64;
const MAX_COMPONENTS = 16;
const MAX_QUESTION_RECORDS = 64;
const MAX_UNRESOLVED_DELIVERY_DEPENDENCIES = 16;
const MAX_ID_LENGTH = 128;
const SOURCE_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const SOURCE_RARITIES = new Set([
  "standard", "uncommon", "rare", "epic", "legendary", "mythic", "special", "heroic",
]);
const SOURCE_TARGET_MODES = new Set([
  "none", "ground", "air", "ground-and-air", "structures",
]);
const SOURCE_COMPONENT_ROLES = new Set([
  "primary", "secondary", "spawn", "spawn-over-time",
]);

const EXPECTED_COUNTS = Object.freeze({
  claimedOccurrencePairs: 5,
  uniqueCardIds: 5,
  ordinarySourceClaims: 0,
  specialSourceClaims: 5,
  questionBearingClaims: 5,
  unresolvedDeliveryDependencies: 4,
  duplicatedCompositionOwnedIds: 1,
});

const IDENTITY_FIELDS = Object.freeze([
  "attackSequence",
  "direction",
  "projectileId",
  "sourceId",
]);

const SHARED_HOST_INTEGRATION = Object.freeze({
  authority: "LiveBattle",
  status: "pending-shared-host-integration",
});

const IDENTITY_REQUIREMENTS = Object.freeze({
  authority: "GAME-001TH",
  fields: IDENTITY_FIELDS,
  minting: "shared-host-owned",
  state: "not-owned-by-this-receipt",
  status: "required-adapter-contract",
});

// The five claimed profile occurrences below are special projectile
// memberships. Ordinary delivery claims are classified independently by the
// shared source authority and do not enter this special-profile manifest.
const CLAIM_SPECS = Object.freeze([
  Object.freeze({
    archetype: "stormkite",
    claimFamily: "chain",
    componentId: null,
    exportName: "createChainSpecialCatalog",
    id: "stormkite",
    sourceKind: "special",
  }),
  Object.freeze({
    archetype: "prism-warden",
    claimFamily: "pierce",
    componentId: null,
    exportName: "createPierceSpecialCatalog",
    id: "prism-warden",
    sourceKind: "special",
  }),
  Object.freeze({
    archetype: "rune-reaver",
    claimFamily: "return",
    componentId: null,
    exportName: "createReturnSpecialCatalog",
    id: "rune-reaver",
    sourceKind: "special",
  }),
  Object.freeze({
    archetype: "scatterguard",
    claimFamily: "pellets",
    componentId: null,
    exportName: "createPelletSpecialCatalog",
    id: "scatterguard",
    sourceKind: "special",
  }),
  Object.freeze({
    archetype: "aegis-sage",
    claimFamily: "reflection",
    componentId: null,
    exportName: "createReflectionSpecialCatalog",
    id: "aegis-sage",
    sourceKind: "special",
  }),
]);

const UNRESOLVED_DELIVERY_SPECS = Object.freeze([
  Object.freeze({
    archetype: "brassbolt",
    claimFamily: "ordinary-single-projectile",
    componentId: null,
    exportName: "createBasicRangedCatalog",
    htoDeliveryQuestionKey: "brassbolt.delivery",
    htoDeliveryQuestionSource: "runtime-playability-estimate-not-comparison-corpus",
    htoDeliveryQuestionValue: 2,
    id: "brassbolt",
    sourceKind: "ordinary",
  }),
  Object.freeze({
    archetype: "briar-darter",
    claimFamily: "ordinary-component-projectile",
    componentId: "briar-darter",
    exportName: "createSwarmCatalog",
    htoDeliveryQuestionKey: "briar-darter.delivery",
    htoDeliveryQuestionSource: "runtime-playability-estimate-not-comparison-corpus",
    htoDeliveryQuestionValue: 2,
    id: "briar-band",
    sourceKind: "ordinary",
  }),
  Object.freeze({
    archetype: "copperskiff",
    claimFamily: "ordinary-single-projectile",
    componentId: null,
    exportName: "createBasicFlyingCatalog",
    htoDeliveryQuestionKey: "copperskiff.delivery",
    htoDeliveryQuestionSource: "runtime-playability-estimate-not-comparison-corpus",
    htoDeliveryQuestionValue: 2,
    id: "copperskiff",
    sourceKind: "ordinary",
  }),
  Object.freeze({
    archetype: "reedsting",
    claimFamily: "ordinary-single-projectile",
    componentId: null,
    exportName: "createBasicRangedCatalog",
    htoDeliveryQuestionKey: "reedsting.delivery",
    htoDeliveryQuestionSource: "runtime-playability-estimate-not-comparison-corpus",
    htoDeliveryQuestionValue: 2,
    id: "reedsting",
    sourceKind: "ordinary",
  }),
]);

// Every other HTP occurrence is deliberately classified as outside this
// projectile receipt. Skymaul remains admitted by HTP but excluded here: its
// source and HTO projection do not prove projectile delivery.
const EXCLUDED_OCCURRENCE_SPECS = Object.freeze([
  {
    exportName: "createChampionAbilityCatalog",
    id: "aegis-sage",
    reason: "composition membership is owned by the reflection claim; it is not a second projectile occurrence",
    status: "admitted",
  },
  {
    exportName: "DEATH_SPAWN_IDENTITY",
    id: "ashen-nest",
    reason: "HTP identity QUESTION is not a sourced projectile claim",
    status: "question",
  },
  {
    exportName: "createHealCatalog",
    id: "bloom-wisp",
    reason: "the status/heal occurrence exports no projectile delivery claim",
    status: "admitted",
  },
  {
    exportName: "createChampionAbilityCatalog",
    id: "bone-regent",
    reason: "the champion occurrence exports no projectile delivery claim",
    status: "admitted",
  },
  {
    exportName: "createBasicMeleeCatalog",
    id: "brackenwheel",
    reason: "the melee area unit is outside the projectile claim surface",
    status: "admitted",
  },
  {
    exportName: "createRampSpecialCatalog",
    id: "cinder-ray",
    reason: "the status/combat occurrence exports no projectile delivery claim",
    status: "admitted",
  },
  {
    exportName: "createRecoilSpecialCatalog",
    id: "cinderback",
    reason: "the recoil occurrence exports movement displacement, not a projectile claim",
    status: "admitted",
  },
  {
    exportName: "createSwarmCatalog",
    id: "cinder-host",
    reason: "the melee swarm occurrence is outside the projectile claim surface",
    status: "admitted",
  },
  {
    exportName: "createSwarmCatalog",
    id: "cinderlings",
    reason: "the swarm occurrence exports component statistics without projectile delivery evidence",
    status: "admitted",
  },
  {
    exportName: "createBasicMeleeCatalog",
    id: "coilblade",
    reason: "the melee occurrence is outside the projectile claim surface",
    status: "admitted",
  },
  {
    exportName: "createHealCatalog",
    id: "dawnmender",
    reason: "the status/heal occurrence exports no projectile delivery claim",
    status: "admitted",
  },
  {
    exportName: "createChampionAbilityCatalog",
    id: "dusk-ranger",
    reason: "the champion occurrence exports no projectile delivery claim",
    status: "admitted",
  },
  {
    exportName: "createChargeKnockbackCatalog",
    id: "emberlance",
    reason: "the charge composition occurrence does not source projectile delivery",
    status: "admitted",
  },
  {
    exportName: "createChargeSpecialCatalog",
    id: "emberlance",
    reason: "the charge occurrence exports movement mechanics, not a projectile claim",
    status: "admitted",
  },
  {
    exportName: "createSwarmCatalog",
    id: "forgeguard",
    reason: "the ordinary melee squad is outside the projectile claim surface",
    status: "admitted",
  },
  {
    exportName: "createChampionAbilityCatalog",
    id: "gilded-lancer",
    reason: "the champion occurrence exports no projectile delivery claim",
    status: "admitted",
  },
  {
    exportName: "DEATH_CONVERSION_IDENTITY",
    id: "gloam-shepherd",
    reason: "HTP identity QUESTION is not a sourced projectile claim",
    status: "question",
  },
  {
    exportName: "createSwarmCatalog",
    id: "gloamwing-cluster",
    reason: "the melee flight swarm has no pinned projectile delivery source claim",
    status: "admitted",
  },
  {
    exportName: "createChampionAbilityCatalog",
    id: "iron-borer",
    reason: "the champion occurrence exports no projectile delivery claim",
    status: "admitted",
  },
  {
    exportName: "createBasicMeleeCatalog",
    id: "ironroot",
    reason: "the melee occurrence is outside the projectile claim surface",
    status: "admitted",
  },
  {
    exportName: "createBasicMeleeCatalog",
    id: "mossguard",
    reason: "the melee occurrence is outside the projectile claim surface",
    status: "admitted",
  },
  {
    exportName: "createStunSpecialCatalog",
    id: "pulse-sentry",
    reason: "the status occurrence exports no projectile delivery claim",
    status: "admitted",
  },
  {
    exportName: "createShieldFormCatalog",
    id: "railward",
    reason: "the shield/form occurrence exports no projectile delivery claim",
    status: "admitted",
  },
  {
    exportName: "createBasicFlyingCatalog",
    id: "skymaul",
    reason: "the source and HTO projection do not claim delivery for this card; name and range are not delivery evidence",
    status: "admitted",
  },
  {
    exportName: "createStructureSeekerCatalog",
    id: "stonehauler",
    reason: "the structure-seeker occurrence exports targeting/movement, not a projectile claim",
    status: "admitted",
  },
  {
    exportName: "createJumpSpecialCatalog",
    id: "stonevault",
    reason: "the jump occurrence exports movement mechanics, not a projectile claim",
    status: "admitted",
  },
  {
    exportName: "createSnareSpecialCatalog",
    id: "tether-rider",
    reason: "the status occurrence exports no projectile delivery claim",
    status: "admitted",
  },
  {
    exportName: "createSwarmCatalog",
    id: "thornscouts",
    reason: "the ordinary melee squad is outside the projectile claim surface",
    status: "admitted",
  },
  {
    exportName: "createInvisibilitySpecialCatalog",
    id: "veil-prowler",
    reason: "the status occurrence exports no projectile delivery claim",
    status: "admitted",
  },
  {
    exportName: "createDashSpecialCatalog",
    id: "veilrunner",
    reason: "the dash occurrence exports movement mechanics, not a projectile claim",
    status: "admitted",
  },
  {
    exportName: "createRetargetSpecialCatalog",
    id: "wayfinder",
    reason: "the retarget occurrence exports targeting mechanics, not a projectile claim",
    status: "admitted",
  },
]);

const SOURCE_RECORD_FIELDS = Object.freeze([
  "areaDamageRadiusMillitiles",
  "components",
  "cost",
  "count",
  "damage",
  "deployTimeTicks",
  "displayName",
  "firstHitTicks",
  "hitSpeedTicks",
  "hitpoints",
  "id",
  "kind",
  "movementMillitilesPerSecond",
  "rangeMillitiles",
  "rarity",
  "sightRangeMillitiles",
  "targetMode",
]);

const COMPONENT_FIELDS = Object.freeze([
  "areaDamageRadiusMillitiles",
  "count",
  "damage",
  "deployTimeTicks",
  "displayName",
  "firstHitTicks",
  "hitSpeedTicks",
  "hitpoints",
  "id",
  "kind",
  "movementMillitilesPerSecond",
  "rangeMillitiles",
  "role",
  "sightRangeMillitiles",
  "targetMode",
]);

const SOURCE_BINDINGS = new Map([
  ["createBasicMeleeCatalog", {
    evidence: {
      delivery: "not-sourced",
      verification: "cards-basic-melee",
      sourceExports: ["createBasicMeleeCatalog"],
      sourceModule: "cards/basic-melee",
    },
  }],
  ["createBasicRangedCatalog", {
    evidence: {
      delivery: "not-sourced",
      verification: "cards-basic-ranged",
      sourceExports: ["createBasicRangedCatalog"],
      sourceModule: "cards/basic-ranged",
    },
  }],
  ["createBasicFlyingCatalog", {
    evidence: {
      delivery: "not-sourced",
      verification: "cards-basic-flying",
      sourceExports: ["createBasicFlyingCatalog"],
      sourceModule: "cards/basic-flying",
    },
  }],
  ["createSwarmCatalog", {
    evidence: {
      delivery: "not-sourced",
      verification: "cards-swarms",
      sourceExports: ["createSwarmCatalog"],
      sourceModule: "cards/swarms",
    },
  }],
  ["createOrdinaryProjectileSplashCatalog", {
    evidence: {
      delivery: "ordinary-splash-projectile",
      verification: "game-roster-troops-ordinary",
      sourceExports: ["createOrdinaryProjectileSplashCatalog"],
      sourceModule: "cards/ordinary-projectile-splash",
    },
  }],
  ["createChainSpecialCatalog", {
    evidence: {
      delivery: "special-projectile",
      verification: "special-projectiles-chain",
      sourceExports: ["createChainSpecialCatalog", "createChainQuestionFixture"],
      sourceModule: "cards/special-projectiles-chain",
    },
    questionFactory: createChainQuestionFixture,
    questionSource: "unsourced-chained-target-attack-fixture",
  }],
  ["createPierceSpecialCatalog", {
    evidence: {
      delivery: "special-projectile",
      verification: "special-projectiles-pierce",
      sourceExports: ["createPierceSpecialCatalog", "createPierceQuestionFixture"],
      sourceModule: "cards/special-projectiles-pierce",
    },
    questionFactory: createPierceQuestionFixture,
    questionSource: "unsourced-linear-through-shot-fixture",
  }],
  ["createReturnSpecialCatalog", {
    evidence: {
      delivery: "special-projectile",
      verification: "special-projectiles-return",
      sourceExports: ["createReturnSpecialCatalog", "createReturnQuestionFixture"],
      sourceModule: "cards/special-projectiles-return",
    },
    questionFactory: createReturnQuestionFixture,
    questionSource: "unsourced-outbound-returning-projectile-fixture",
  }],
  ["createPelletSpecialCatalog", {
    evidence: {
      delivery: "special-projectile",
      verification: "special-projectiles-pellets",
      sourceExports: ["createPelletSpecialCatalog", "createPelletQuestionFixture"],
      sourceModule: "cards/special-projectiles-pellets",
    },
    questionFactory: createPelletQuestionFixture,
    questionSource: "unsourced-fixed-fan-pellet-volley-fixture",
  }],
  ["createReflectionSpecialCatalog", {
    evidence: {
      delivery: "special-projectile",
      verification: "special-projectiles-reflection",
      sourceExports: ["createReflectionSpecialCatalog", "createReflectionQuestionFixture"],
      sourceModule: "cards/special-projectiles-reflection",
    },
    questionFactory: createReflectionQuestionFixture,
    questionSource: "unsourced-projectile-reflection-fixture",
  }],
]);

const QUESTION_SPECS = Object.freeze({
  chain: {
    exportName: "createChainSpecialCatalog",
    keys: [
      "attackerCancellationRule", "candidateDeathRule", "damagePerHop",
      "eventOrderRule", "hopDelayTicks", "hopRangeMillitiles", "lethalHopRule",
      "rangeRule", "selectionRule", "targetCap", "targetEligibilityRule",
    ],
  },
  pierce: {
    exportName: "createPierceSpecialCatalog",
    keys: [
      "attackerDeathAfterLaunchRule", "attackerDeathThroughLaunchRule",
      "collisionGeometryRule", "corridorHalfWidthMillitiles",
      "damageApplicationRule", "eventOrderRule", "hitOrderRule",
      "interruptionAfterLaunchRule", "interruptionThroughLaunchRule",
      "movingCollisionRule", "oneHitRule", "pierceLengthMillitiles",
      "projectionRule", "projectileSpeedMillitilesPerTick", "sameBoundaryRule",
      "targetDeathRule", "targetEligibilityRule",
    ],
  },
  return: {
    exportName: "createReturnSpecialCatalog",
    keys: [
      "attackerDeathAfterLaunchRule", "attackerDeathThroughLaunchRule",
      "collisionGeometryRule", "collisionWidthMillitiles", "damagePerPass",
      "damagePerPassRule", "eventOrderRule", "inboundTimingRule",
      "interruptionAfterLaunchRule", "interruptionThroughLaunchRule",
      "launchTimingTicks", "movingTargetRule", "obstacleRule", "oneHitPerLegRule",
      "projectileSpeedMillitilesPerTick", "sameBoundaryRule", "targetDeathRule",
      "targetEligibilityRule", "turnDistanceMillitiles", "turnaroundTimingRule",
    ],
  },
  pellets: {
    exportName: "createPelletSpecialCatalog",
    keys: [
      "aggregateDamageOrderRule", "areaDamageRadiusMillitiles",
      "attackerDeathAfterLaunchRule", "attackerDeathThroughLaunchRule",
      "collisionWidthMillitiles", "count", "damage", "damagePerPellet",
      "deployTimeTicks", "firstContactObstructionRule", "firstHitTicks",
      "hitSpeedTicks", "hitpoints", "interruptionAfterLaunchRule",
      "interruptionThroughLaunchRule", "launchSnapshotRule",
      "movementMillitilesPerSecond", "pelletCount", "pelletIdRule",
      "pelletRangeMillitiles", "pelletSpeedMillitilesPerTick", "rangeMillitiles",
      "rayPattern", "rayPatternNorm", "sameBoundaryRule", "sightRangeMillitiles",
      "targetDeathRule", "targetEligibilityRule", "targetMode", "volleyDamageRule",
    ],
  },
  reflection: {
    exportName: "createReflectionSpecialCatalog",
    keys: [
      "benchmarkCount", "benchmarkDamage", "benchmarkDeployTimeSeconds",
      "benchmarkFirstHitSeconds", "benchmarkHitSpeedSeconds", "benchmarkHitpoints",
      "benchmarkMovementSpeed", "benchmarkMovementSpeedTilesPerSecond",
      "benchmarkRangeTiles", "benchmarkSightRangeTiles", "benchmarkTargets",
      "eventOrderRule", "geometryRule", "integerPathDomainRule", "invalidReflectorRule",
      "lifecycleRule", "loopPolicy", "maximumReflections", "movingTargetRule",
      "reflectedDamageRule", "reflectedOwnershipRule", "reflectedSpeedRule",
      "reflectedTargetRule", "reflectionEligibilityRule", "reflectionRadiusMillitiles",
      "reflectionTimingRule", "selfReflectionRule", "simultaneousReflectionRule",
      "sourceDeathRule", "sourceProvenanceRule", "targetDeathRule",
    ],
  },
});

const QUESTION_FAMILY_ORDER = Object.freeze([
  "chain", "pierce", "return", "pellets", "reflection",
]);

const AEGIS_COMPOSITION_PENDING = Object.freeze({
  abilityCost: Object.freeze({ owner: "GAME-001HTC", status: "pending" }),
  cancellation: Object.freeze({ owner: "GAME-001HTC", status: "pending" }),
  compositionWithChampionAbility: Object.freeze({ owner: "GAME-001HTC", status: "pending" }),
  loopPolicy: Object.freeze({ owner: "GAME-001HTC", status: "pending" }),
  mechanicOrdering: Object.freeze({ owner: "GAME-001HTC", status: "pending" }),
  sameBoundaryTiming: Object.freeze({ owner: "GAME-001HTC", status: "pending" }),
  targetOwnership: Object.freeze({ owner: "GAME-001HTC", status: "pending" }),
});

function clone(value) {
  return structuredClone(value);
}

function freeze(value, seen = new WeakSet()) {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) freeze(value[key], seen);
  Object.freeze(value);
  return value;
}

function deepFreezeClone(value) {
  return freeze(clone(value));
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort(compareText).map((key) =>
      `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new TypeError("canonical data cannot contain undefined");
  return encoded;
}

function isArray(value) {
  try {
    return Array.isArray(value);
  } catch {
    return false;
  }
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareOccurrences(left, right) {
  return compareText(left.id, right.id) ||
    compareText(left.exportName, right.exportName) ||
    compareText(left.archetype ?? "", right.archetype ?? "");
}

function compareClaims(left, right) {
  return compareOccurrences(left, right) ||
    compareText(left.claimFamily, right.claimFamily);
}

function exactKeys(value, expected, label, { exactPrototype = false } = {}) {
  if (
    value === null ||
    typeof value !== "object" ||
    isArray(value)
  ) {
    throw new TypeError(`${label} must be a plain data object`);
  }
  if (exactPrototype && Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${label} must be a plain data object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const actual = Reflect.ownKeys(descriptors);
  const expectedSorted = [...expected].sort(compareText);
  const actualSorted = actual.filter((key) => typeof key === "string").sort(compareText);
  if (
    actual.length !== expectedSorted.length ||
    actualSorted.length !== actual.length ||
    actualSorted.some((key, index) => key !== expectedSorted[index]) ||
    Object.values(descriptors).some((descriptor) =>
      !descriptor.enumerable || !Object.hasOwn(descriptor, "value"))
  ) {
    throw new TypeError(`${label} has an invalid field surface`);
  }
  return value;
}

function denseArray(value, maximum, label) {
  if (
    !isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > maximum
  ) {
    throw new TypeError(`${label} must be a bounded plain array`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const expected = new Set([
    "length",
    ...Array.from({ length: value.length }, (_, index) => String(index)),
  ]);
  if (
    Reflect.ownKeys(descriptors).length !== expected.size ||
    [...Reflect.ownKeys(descriptors)].some((key) =>
      typeof key !== "string" || !expected.has(key)) ||
    !Object.hasOwn(descriptors, "length") ||
    descriptors.length.enumerable ||
    !Object.hasOwn(descriptors.length, "value") ||
    descriptors.length.value !== value.length ||
    Array.from({ length: value.length }, (_, index) => String(index)).some((key) =>
      !descriptors[key].enumerable || !Object.hasOwn(descriptors[key], "value"))
  ) {
    throw new TypeError(`${label} must contain dense data properties`);
  }
  return value;
}

function deepFrozen(value, seen = new WeakSet()) {
  if (value === null || typeof value !== "object" || seen.has(value)) return true;
  seen.add(value);
  return Object.isFrozen(value) && Reflect.ownKeys(value).every((key) =>
    deepFrozen(value[key], seen));
}

function safeIntegerOrNull(value, label, minimum = 0) {
  if (value !== null && (!Number.isSafeInteger(value) || value < minimum)) {
    throw new TypeError(`${label} must be a safe integer or null`);
  }
}

function sourceRecordKey(exportName, id) {
  return `${exportName}\u0000${id}`;
}

function validateComponent(component, label) {
  exactKeys(component, COMPONENT_FIELDS, label, { exactPrototype: true });
  if (
    typeof component.id !== "string" ||
    component.id.length === 0 ||
    component.id.length > MAX_ID_LENGTH ||
    !SOURCE_ID_PATTERN.test(component.id) ||
    typeof component.displayName !== "string" ||
    component.displayName.length === 0 ||
    component.displayName.length > 80 ||
    component.displayName.trim() !== component.displayName ||
    component.kind !== "unit" ||
    !SOURCE_COMPONENT_ROLES.has(component.role) ||
    !SOURCE_TARGET_MODES.has(component.targetMode) ||
    !Number.isSafeInteger(component.count) ||
    component.count < 1
  ) {
    throw new TypeError(`${label} is not a complete source component`);
  }
  for (const [field, minimum] of [
    ["damage", 1],
    ["deployTimeTicks", 0],
    ["firstHitTicks", 0],
    ["hitSpeedTicks", 1],
    ["hitpoints", 1],
    ["movementMillitilesPerSecond", 0],
    ["rangeMillitiles", 0],
    ["sightRangeMillitiles", 1],
    ["areaDamageRadiusMillitiles", 0],
  ]) safeIntegerOrNull(component[field], `${label}.${field}`, minimum);
  return component;
}

function validateSourceRecord(record, label) {
  exactKeys(record, SOURCE_RECORD_FIELDS, label, { exactPrototype: true });
  if (
    typeof record.id !== "string" ||
    record.id.length === 0 ||
    record.id.length > MAX_ID_LENGTH ||
    !SOURCE_ID_PATTERN.test(record.id) ||
    typeof record.displayName !== "string" ||
    record.displayName.length === 0 ||
    record.displayName.length > 80 ||
    record.displayName.trim() !== record.displayName ||
    record.kind !== "unit" ||
    !SOURCE_RARITIES.has(record.rarity) ||
    !SOURCE_TARGET_MODES.has(record.targetMode) ||
    !Number.isSafeInteger(record.cost) ||
    record.cost < 1 ||
    record.cost > 10 ||
    !Number.isSafeInteger(record.count) ||
    record.count < 1
  ) {
    throw new TypeError(`${label} is not a complete source unit record`);
  }
  for (const [field, minimum] of [
    ["damage", 1],
    ["deployTimeTicks", 0],
    ["firstHitTicks", 0],
    ["hitSpeedTicks", 1],
    ["hitpoints", 1],
    ["movementMillitilesPerSecond", 0],
    ["rangeMillitiles", 0],
    ["sightRangeMillitiles", 1],
    ["areaDamageRadiusMillitiles", 0],
  ]) safeIntegerOrNull(record[field], `${label}.${field}`, minimum);
  denseArray(record.components, MAX_COMPONENTS, `${label}.components`);
  for (let index = 0; index < record.components.length; index += 1) {
    validateComponent(record.components[index], `${label}.components[${index}]`);
  }
  try {
    structuredClone(record);
  } catch {
    throw new TypeError(`${label} must contain cloneable data`);
  }
  return record;
}

function validateSourceCatalog(value, binding) {
  denseArray(value, MAX_SOURCE_CATALOG_ROWS, `${binding.exportName} result`);
  return value.map((record, index) =>
    validateSourceRecord(record, `${binding.exportName}[${index}]`));
}

function assertExpectedSourceIds(binding, rows) {
  const actual = rows.map(({ id }) => id);
  if (new Set(actual).size !== actual.length) {
    throw new Error(`${binding.exportName} source catalog has duplicate IDs`);
  }
  const expected = [...AUTHORITATIVE_PROJECTILE_SOURCE_IDS_BY_EXPORT[binding.exportName]]
    .sort(compareText);
  if (canonical([...actual].sort(compareText)) !== canonical(expected)) {
    throw new Error(`${binding.exportName} source catalog has a missing, stale, or extra source record`);
  }
}

function buildSourceCatalogCache() {
  const authoritative = assertAuthoritativeProjectileSourceCatalogs();
  const cache = new Map();
  for (const [exportName, binding] of SOURCE_BINDINGS) {
    if (cache.has(exportName) || !Object.hasOwn(authoritative, exportName)) {
      throw new Error(`${exportName} source catalog binding is invalid or duplicated`);
    }
    const rows = validateSourceCatalog(authoritative[exportName], { ...binding, exportName });
    assertExpectedSourceIds({ ...binding, exportName }, rows);
    const records = rows.map(clone);
    cache.set(exportName, {
      byId: new Map(records.map((record) => [record.id, record])),
      records,
    });
  }
  if (cache.size !== Object.keys(AUTHORITATIVE_PROJECTILE_SOURCE_IDS_BY_EXPORT).length) {
    throw new Error("projectile source catalog cache is incomplete");
  }
  return cache;
}

function sourceBinding(exportName) {
  const binding = SOURCE_BINDINGS.get(exportName);
  if (binding === undefined) throw new Error(`projectile source binding ${exportName} is missing`);
  return binding;
}

function sourceRecordFor(sourceCache, exportName, id) {
  const catalog = sourceCache.get(exportName);
  if (catalog === undefined) throw new Error(`no cached source catalog for ${exportName}`);
  const record = catalog.byId.get(id);
  if (record === undefined) {
    throw new Error(`${exportName}/${id} does not provide exactly one source record`);
  }
  return record;
}

function htpOccurrenceMap(manifest) {
  if (
    manifest === null ||
    typeof manifest !== "object" ||
    !Array.isArray(manifest.occurrences) ||
    manifest.occurrences.length > MAX_SOURCE_CATALOG_ROWS
  ) {
    throw new TypeError("HTP occurrence surface is missing or unbounded");
  }
  const map = new Map();
  for (const occurrence of manifest.occurrences) {
    const fields = occurrence?.status === "question"
      ? ["exportName", "id", "reason", "status"]
      : ["exportName", "id", "status"];
    exactKeys(occurrence, fields, "HTP occurrence");
    if (
      typeof occurrence.exportName !== "string" ||
      typeof occurrence.id !== "string" ||
      !["admitted", "question"].includes(occurrence.status)
    ) {
      throw new TypeError("HTP occurrence has an invalid identity or status");
    }
    const key = sourceRecordKey(occurrence.exportName, occurrence.id);
    if (map.has(key)) throw new Error("HTP occurrence surface contains a duplicate pair");
    map.set(key, occurrence);
  }
  return map;
}

function occurrenceKey(spec) {
  return sourceRecordKey(spec.exportName, spec.id);
}

function assertUnresolvedSpecSurface() {
  if (
    UNRESOLVED_DELIVERY_SPECS.length === 0 ||
    UNRESOLVED_DELIVERY_SPECS.length > MAX_UNRESOLVED_DELIVERY_DEPENDENCIES
  ) throw new RangeError("projectile unresolved delivery spec collection is unbounded or empty");
  const keys = new Set();
  const archetypes = new Set();
  for (const spec of UNRESOLVED_DELIVERY_SPECS) {
    exactKeys(spec, [
      "archetype", "claimFamily", "componentId", "exportName",
      "htoDeliveryQuestionKey", "htoDeliveryQuestionSource",
      "htoDeliveryQuestionValue", "id", "sourceKind",
    ], "unresolved delivery spec");
    const key = occurrenceKey(spec);
    if (keys.has(key)) throw new Error("unresolved delivery specs contain a duplicate occurrence");
    keys.add(key);
    if (archetypes.has(spec.archetype)) {
      throw new Error("unresolved delivery specs contain duplicate archetypes");
    }
    archetypes.add(spec.archetype);
    if (
      spec.sourceKind !== "ordinary" ||
      typeof spec.htoDeliveryQuestionKey !== "string" ||
      spec.htoDeliveryQuestionKey !== `${spec.archetype}.delivery` ||
      spec.htoDeliveryQuestionSource !== "runtime-playability-estimate-not-comparison-corpus" ||
      spec.htoDeliveryQuestionValue !== 2 ||
      (spec.componentId !== null && typeof spec.componentId !== "string")
    ) {
      throw new Error(`unresolved delivery spec ${spec.exportName}/${spec.id} is not a pinned HTO question`);
    }
  }
  const expectedOrder = [...UNRESOLVED_DELIVERY_SPECS].sort(compareOccurrences);
  if (canonical(UNRESOLVED_DELIVERY_SPECS) !== canonical(expectedOrder)) {
    throw new Error("unresolved delivery dependencies are not canonically ordered");
  }
  return keys;
}

function assertHtpJoin(htpMap, spec, label) {
  const occurrence = htpMap.get(occurrenceKey(spec));
  if (occurrence === undefined || occurrence.status !== "admitted") {
    throw new Error(`${label} is missing an admitted HTP occurrence`);
  }
  return occurrence;
}

function htpProfileFor(htpManifest, spec, label) {
  if (!Array.isArray(htpManifest.profiles)) throw new TypeError("HTP profile surface is missing");
  const matches = htpManifest.profiles.filter(({ id }) => id === spec.id);
  if (matches.length !== 1) throw new Error(`${label} has no unique HTP profile join`);
  const profile = matches[0];
  exactKeys(profile, [
    "cost", "deployTimeTicks", "displayName", "id", "kind",
    "occurrenceExports", "placementClass",
  ], `${label} HTP profile`);
  if (
    !Array.isArray(profile.occurrenceExports) ||
    profile.occurrenceExports.some((exportName) => typeof exportName !== "string") ||
    new Set(profile.occurrenceExports).size !== profile.occurrenceExports.length ||
    [...profile.occurrenceExports].sort(compareText).join("\u0000") !==
      profile.occurrenceExports.join("\u0000") ||
    !profile.occurrenceExports.includes(spec.exportName)
  ) {
    throw new Error(`${label} HTP profile membership is stale`);
  }
  return profile;
}

function assertHtpSurface(htpManifest) {
  const htpMap = htpOccurrenceMap(htpManifest);
  const unresolvedKeys = assertUnresolvedSpecSurface();
  const claimedKeys = CLAIM_SPECS.map(occurrenceKey);
  const excludedKeys = EXCLUDED_OCCURRENCE_SPECS.map(occurrenceKey);
  const ordinarySourceKeys = assertOrdinarySourceClaims(htpManifest, htpMap);
  const classified = [
    ...claimedKeys,
    ...unresolvedKeys,
    ...ordinarySourceKeys,
    ...excludedKeys,
  ];
  if (new Set(classified).size !== classified.length) {
    throw new Error("projectile HTP classification contains a duplicate pair");
  }
  if (canonical([...htpMap.keys()].sort(compareText)) !==
      canonical([...classified].sort(compareText))) {
    throw new Error("projectile HTP classification has a stale, missing, or extra occurrence");
  }
  const admittedIds = [...new Set([...htpMap.values()]
    .filter(({ status }) => status === "admitted")
    .map(({ id }) => id))].sort(compareText);
  const profileIds = (htpManifest.profiles ?? []).map(({ id }) => id).sort(compareText);
  if (
    canonical(profileIds) !== canonical(admittedIds) ||
    new Set(profileIds).size !== profileIds.length
  ) {
    throw new Error("projectile HTP profile ID surface is stale");
  }
  for (const spec of CLAIM_SPECS) {
    assertHtpJoin(htpMap, spec, `${spec.exportName}/${spec.id}`);
    htpProfileFor(htpManifest, spec, `${spec.exportName}/${spec.id}`);
  }
  for (const spec of UNRESOLVED_DELIVERY_SPECS) {
    assertHtpJoin(htpMap, spec, `${spec.exportName}/${spec.id}`);
    htpProfileFor(htpManifest, spec, `${spec.exportName}/${spec.id}`);
  }
  for (const spec of EXCLUDED_OCCURRENCE_SPECS) {
    const occurrence = htpMap.get(occurrenceKey(spec));
    if (occurrence?.status !== spec.status) {
      throw new Error(`projectile exclusion status changed for ${spec.exportName}/${spec.id}`);
    }
  }
  return { htpMap };
}

function assertOrdinarySourceClaims(htpManifest, htpMap) {
  if (ORDINARY_PROJECTILE_SOURCE_CLAIMS.length !== 5) {
    throw new Error("ordinary projectile source admission must contain exactly five claims");
  }
  const catalogs = new Map([
    ["createOrdinaryProjectileSquadCatalog", {
      catalogId: "ordinary-projectile-squads-v1",
      rows: createOrdinaryProjectileSquadCatalog(),
    }],
    ["createOrdinaryProjectileSplashCatalog", {
      catalogId: "ordinary-projectile-splash-v1",
      rows: createOrdinaryProjectileSplashCatalog(),
    }],
    ["createSlowSpecialCatalog", {
      catalogId: "ordinary-projectile-splash-v1",
      rows: createSlowSpecialCatalog(),
    }],
  ]);
  const rowMaps = new Map();
  for (const [exportName, { rows }] of catalogs) {
    if (!Array.isArray(rows)) {
      throw new Error(`${exportName} must return an ordinary projectile source catalog`);
    }
    rowMaps.set(exportName, new Map(rows.map((row) => [row.id, row])));
  }
  const pairs = [];
  for (const claim of ORDINARY_PROJECTILE_SOURCE_CLAIMS) {
    exactKeys(claim, ["archetypeId", "cardId", "catalogId", "sourceExport"],
      "ordinary projectile source claim", { exactPrototype: true });
    const catalog = catalogs.get(claim.sourceExport);
    if (catalog === undefined || claim.catalogId !== catalog.catalogId) {
      throw new Error("ordinary projectile source claim is not bound to its canonical catalog");
    }
    const spec = { exportName: claim.sourceExport, id: claim.cardId };
    const key = occurrenceKey(spec);
    if (pairs.includes(key)) throw new Error("ordinary projectile source claims duplicate a card occurrence");
    const occurrence = htpMap.get(key);
    if (occurrence?.status !== "admitted") {
      throw new Error(`${claim.sourceExport}/${claim.cardId} is missing an admitted HTP occurrence`);
    }
    const profile = htpProfileFor(htpManifest, spec,
      `${claim.sourceExport}/${claim.cardId}`);
    const sourceCard = rowMaps.get(claim.sourceExport).get(claim.cardId);
    const directUnit = sourceCard?.components?.length === 0 && sourceCard.count === 1 &&
      sourceCard.id === claim.archetypeId;
    const singleComponent = sourceCard?.components?.length === 1 &&
      sourceCard.count === sourceCard.components[0].count &&
      sourceCard.components[0].id === claim.archetypeId &&
      sourceCard.components[0].role === "primary";
    if (sourceCard === undefined || (!directUnit && !singleComponent)) {
      throw new Error(`${claim.cardId} source component does not match its admitted archetype`);
    }
    assertAdmissionIdentity(profile, sourceCard, `${claim.sourceExport}/${claim.cardId}`);
    const deliveryPolicy = getOrdinaryProjectileDeliveryPolicy(
      claim.cardId, claim.archetypeId,
    );
    if (deliveryPolicy === null || deliveryPolicy.catalogId !== claim.catalogId ||
        deliveryPolicy.delivery !== "projectile") {
      throw new Error(`${claim.cardId} has no canonical ordinary projectile delivery claim`);
    }
    pairs.push(key);
  }
  const expectedPairs = ORDINARY_PROJECTILE_SOURCE_CLAIMS
    .map(({ cardId, sourceExport }) => sourceRecordKey(sourceExport, cardId))
    .sort(compareText);
  const rowsMatchClaims = [...catalogs.keys()].every((exportName) =>
    canonical([...rowMaps.get(exportName).keys()].sort(compareText)) === canonical(
      ORDINARY_PROJECTILE_SOURCE_CLAIMS.filter(({ sourceExport }) => sourceExport === exportName)
        .map(({ cardId }) => cardId).sort(compareText)));
  if (canonical(pairs.slice().sort(compareText)) !== canonical(expectedPairs) || !rowsMatchClaims) {
    throw new Error("ordinary projectile source claim pairs do not exactly match their catalog rows");
  }
  return pairs;
}

function assertAdmissionIdentity(profile, record, label) {
  for (const field of ["id", "displayName", "kind", "cost", "deployTimeTicks"]) {
    if (profile[field] !== record[field]) {
      throw new Error(`${label} diverges from its HTP/source identity at ${field}`);
    }
  }
}

function componentFor(record, componentId, expectedRole, label) {
  if (!Array.isArray(record.components) || record.components.length > MAX_COMPONENTS) {
    throw new TypeError(`${label} has an invalid component surface`);
  }
  const matches = record.components.filter(({ id }) => id === componentId);
  if (matches.length !== 1 || matches[0].role !== expectedRole) {
    throw new Error(`${label} component identity or role is stale`);
  }
  return matches[0];
}

function validateUnresolvedComponent(record, spec) {
  if (spec.componentId === null) return null;
  const component = componentFor(
    record,
    spec.componentId,
    "secondary",
    `${spec.exportName}/${spec.id}`,
  );
  if (record.id !== "briar-band" || record.count !== 6 || component.count !== 3) {
    throw new Error(`${spec.componentId} ownership surface is stale`);
  }
  return component;
}

function validateQuestionFactory(binding, spec) {
  if (typeof binding.questionFactory !== "function") {
    throw new TypeError(`${spec.claimFamily} question factory is missing`);
  }
  const first = binding.questionFactory();
  const second = binding.questionFactory();
  if (
    first === second ||
    canonical(first) !== canonical(second) ||
    !deepFrozen(first) ||
    !deepFrozen(second)
  ) {
    throw new Error(`${spec.claimFamily} question fixture is not fresh, stable, and frozen`);
  }
  const questionSpec = QUESTION_SPECS[spec.claimFamily];
  if (questionSpec === undefined || questionSpec.exportName !== spec.exportName) {
    throw new Error(`${spec.claimFamily} question key mapping is stale`);
  }
  exactKeys(first, questionSpec.keys, `${spec.claimFamily} question fixture`);
  if (Object.keys(first).length > MAX_QUESTION_RECORDS) {
    throw new RangeError(`${spec.claimFamily} question fixture exceeds its bound`);
  }
  for (const [key, record] of Object.entries(first)) {
    exactKeys(record, ["authoritative", "confidence", "disposition", "source", "value"],
      `${spec.claimFamily}.${key}`);
    if (
      record.authoritative !== false ||
      record.confidence !== "unverified" ||
      record.disposition !== "question" ||
      record.source !== binding.questionSource
    ) {
      throw new Error(`${spec.claimFamily}.${key} lost its non-authoritative provenance`);
    }
  }
  let rejected = false;
  try {
    binding.questionFactory({ override: true });
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error(`${spec.claimFamily} question factory accepts overrides`);
  return clone(first);
}

function validateQuestionFixtures() {
  const fixtures = {};
  for (const family of QUESTION_FAMILY_ORDER) {
    const spec = CLAIM_SPECS.find(({ claimFamily }) => claimFamily === family);
    if (spec === undefined) throw new Error(`question family ${family} has no claim`);
    fixtures[family] = validateQuestionFactory(sourceBinding(spec.exportName), spec);
  }
  return fixtures;
}

function deliveryEvidence(binding) {
  return {
    classification: "sourced",
    delivery: "projectile",
    evidence: {
      sourceExports: [...binding.evidence.sourceExports],
      sourceModule: binding.evidence.sourceModule,
      verification: binding.evidence.verification,
    },
  };
}

function sourceReceipt(binding, exportName, record, component = null) {
  return {
    catalogExport: exportName,
    component: component === null ? null : clone(component),
    evidence: clone(binding.evidence),
    record: clone(record),
  };
}

function specialQuestionFor(claimFamily, fixtures) {
  const fixture = fixtures[claimFamily];
  if (fixture === undefined) throw new Error(`${claimFamily} has no question fixture`);
  return clone(fixture);
}

function buildClaim(spec, htpProfile, record, fixtures) {
  const binding = sourceBinding(spec.exportName);
  const component = spec.componentId === null
    ? null
    : componentFor(record, spec.componentId, "secondary", `${spec.exportName}/${spec.id}`);
  assertAdmissionIdentity(htpProfile, record, `${spec.exportName}/${spec.id}`);
  return {
    archetype: spec.archetype,
    claimFamily: spec.claimFamily,
    component: component === null ? null : clone(component),
    delivery: deliveryEvidence(binding),
    questions: specialQuestionFor(spec.claimFamily, fixtures),
    source: sourceReceipt(binding, spec.exportName, record, component),
  };
}

function buildAegisComposition(reflectionRecord, htpProfile) {
  const expectedExports = ["createChampionAbilityCatalog", "createReflectionSpecialCatalog"];
  if (
    canonical([...htpProfile.occurrenceExports].sort(compareText)) !==
    canonical([...expectedExports].sort(compareText))
  ) {
    throw new Error("Aegis Sage composition membership is stale");
  }
  // Champion membership is retained as a pending composition receipt. The
  // projectile source authority is the reflection catalog only; no champion
  // catalog row is bound into the projectile source witness domain.
  return {
    ownedId: "aegis-sage",
    sourceExports: expectedExports,
    sourceRecords: [
      {
        exportName: "createChampionAbilityCatalog",
        record: clone(reflectionRecord),
      },
      {
        exportName: "createReflectionSpecialCatalog",
        record: clone(reflectionRecord),
      },
    ],
    pending: clone(AEGIS_COMPOSITION_PENDING),
  };
}

function assertHtoQuestion(question, spec, expectedKey, expectedValue, label) {
  if (question === undefined) throw new Error(`${label} is missing from the HTO witness`);
  exactKeys(question, ["authoritative", "confidence", "disposition", "key", "source", "value"], label);
  if (
    question.key !== expectedKey ||
    question.value !== expectedValue ||
    question.authoritative !== false ||
    question.confidence !== "unverified" ||
    question.disposition !== "question" ||
    question.source !== spec.htoDeliveryQuestionSource
  ) {
    throw new Error(`${label} is not the exact HTO delivery QUESTION record`);
  }
  return question;
}

function htoQuestionPair(spec) {
  const first = createSessionTroopWitnessQuestions(spec.id);
  const second = createSessionTroopWitnessQuestions(spec.id);
  if (
    !Array.isArray(first) ||
    !Array.isArray(second) ||
    first === second ||
    canonical(first) !== canonical(second)
  ) {
    throw new Error(`${spec.archetype} HTO witness is not fresh and deterministic`);
  }
  const deliveryQuestions = first.filter(({ key }) => key === spec.htoDeliveryQuestionKey);
  if (deliveryQuestions.length !== 1) {
    throw new Error(`${spec.archetype} HTO delivery question mapping is stale`);
  }
  const delivery = assertHtoQuestion(
    deliveryQuestions[0],
    spec,
    spec.htoDeliveryQuestionKey,
    spec.htoDeliveryQuestionValue,
    `${spec.archetype}.delivery`,
  );
  const speedKey = `${spec.archetype}.projectile-speed-millitiles-per-tick`;
  const speedQuestions = first.filter(({ key }) => key === speedKey);
  if (speedQuestions.length !== 1) {
    throw new Error(`${spec.archetype} HTO projectile speed question mapping is stale`);
  }
  const speed = speedQuestions[0];
  exactKeys(speed, ["authoritative", "confidence", "disposition", "key", "source", "value"],
    `${spec.archetype}.projectile-speed-millitiles-per-tick`);
  if (
    speed.key !== speedKey ||
    speed.value !== 500 ||
    speed.authoritative !== false ||
    speed.confidence !== "unverified" ||
    speed.disposition !== "question" ||
    speed.source !== spec.htoDeliveryQuestionSource
  ) {
    throw new Error(`${spec.archetype} HTO projectile speed QUESTION record is stale`);
  }
  return { delivery, speed };
}

function buildUnresolvedDependency(htpManifest, htpMap, sourceCache, spec) {
  const occurrence = assertHtpJoin(htpMap, spec, `${spec.exportName}/${spec.id}`);
  const htpProfile = htpProfileFor(htpManifest, spec, `${spec.exportName}/${spec.id}`);
  const record = sourceRecordFor(sourceCache, spec.exportName, spec.id);
  assertAdmissionIdentity(htpProfile, record, `${spec.exportName}/${spec.id}`);
  const component = validateUnresolvedComponent(record, spec);
  const { delivery, speed } = htoQuestionPair(spec);
  return {
    archetype: spec.archetype,
    claimFamily: spec.claimFamily,
    component: component === null ? null : clone(component),
    delivery: {
      classification: "question",
      estimateOnly: true,
      evidence: "HTO-delivery-estimate-not-source-proof",
      value: null,
    },
    htpOccurrence: clone(occurrence),
    htpProfile: clone(htpProfile),
    id: spec.id,
    questions: {
      delivery: clone(delivery),
      projectileSpeedMillitilesPerTick: clone(speed),
    },
    source: sourceReceipt(sourceBinding(spec.exportName), spec.exportName, record, component),
    status: "question",
  };
}

function buildExclusions(htpMap) {
  return EXCLUDED_OCCURRENCE_SPECS.map((spec) => {
    const occurrence = htpMap.get(occurrenceKey(spec));
    if (occurrence === undefined) throw new Error(`missing pinned exclusion ${occurrenceKey(spec)}`);
    return {
      archetype: null,
      exportName: spec.exportName,
      htpReason: occurrence.reason ?? null,
      htpStatus: occurrence.status,
      id: spec.id,
      reason: spec.reason,
      status: "excluded",
    };
  }).sort(compareOccurrences);
}

function buildManifest() {
  const sourceCache = buildSourceCatalogCache();
  const htpManifest = createSessionTroopProfileManifest();
  const { htpMap } = assertHtpSurface(htpManifest);
  const fixtures = validateQuestionFixtures();

  const claims = CLAIM_SPECS.map((spec) => {
    const htpOccurrence = assertHtpJoin(htpMap, spec, `${spec.exportName}/${spec.id}`);
    const htpProfile = htpProfileFor(htpManifest, spec, `${spec.exportName}/${spec.id}`);
    const record = sourceRecordFor(sourceCache, spec.exportName, spec.id);
    const claim = buildClaim(spec, htpProfile, record, fixtures);
    return { claim, htpOccurrence, htpProfile, record, spec };
  }).sort(({ spec: left }, { spec: right }) => compareClaims(left, right));

  const unresolved = UNRESOLVED_DELIVERY_SPECS
    .map((spec) => buildUnresolvedDependency(htpManifest, htpMap, sourceCache, spec))
    .sort(compareOccurrences);
  const exclusions = buildExclusions(htpMap);

  const profileIds = [...new Set(claims.map(({ spec }) => spec.id))].sort(compareText);
  const profiles = profileIds.map((id) => {
    const profileClaims = claims.filter(({ spec }) => spec.id === id);
    const htpProfile = profileClaims[0].htpProfile;
    const sourceCard = profileClaims[0].record;
    const profile = {
      id,
      identityRequirements: clone(IDENTITY_REQUIREMENTS),
      occurrenceExports: [...htpProfile.occurrenceExports].sort(compareText),
      sharedHostIntegration: clone(SHARED_HOST_INTEGRATION),
      sourceCard: clone(sourceCard),
      sourceIdentity: clone(htpProfile),
      claims: profileClaims.map(({ claim }) => claim).sort(compareClaims),
    };
    profile.composition = id === "aegis-sage"
      ? buildAegisComposition(sourceCard, htpProfile)
      : null;
    return profile;
  });
  if (
    profiles.length !== EXPECTED_COUNTS.uniqueCardIds ||
    new Set(profiles.map(({ id }) => id)).size !== profiles.length
  ) {
    throw new Error("projectile profiles must be one-per-claimed-card-ID");
  }

  const occurrences = claims.map(({ spec }) => ({
    archetype: spec.archetype,
    claimFamily: spec.claimFamily,
    componentId: spec.componentId,
    exportName: spec.exportName,
    id: spec.id,
    status: "claimed",
  })).sort(compareOccurrences);
  const questionFixtures = Object.fromEntries(QUESTION_FAMILY_ORDER.map((family) =>
    [family, clone(fixtures[family])]));
  const compositionOwnedIds = profiles.filter(({ composition }) => composition !== null)
    .map(({ id }) => id).sort(compareText);
  const counts = {
    claimedOccurrencePairs: occurrences.length,
    uniqueCardIds: profiles.length,
    ordinarySourceClaims: claims.filter(({ spec }) => spec.sourceKind === "ordinary").length,
    specialSourceClaims: claims.filter(({ spec }) => spec.sourceKind === "special").length,
    questionBearingClaims: claims.filter(({ claim }) => Object.keys(claim.questions).length > 0).length,
    unresolvedDeliveryDependencies: unresolved.length,
    duplicatedCompositionOwnedIds: compositionOwnedIds.length,
  };
  if (canonical(counts) !== canonical(EXPECTED_COUNTS)) {
    throw new Error(`projectile profile counts diverge: expected=${canonical(EXPECTED_COUNTS)} actual=${canonical(counts)}`);
  }
  if (canonical(compositionOwnedIds) !== canonical(["aegis-sage"])) {
    throw new Error("projectile composition ownership is stale");
  }

  return freeze({
    compositionOwnedIds,
    counts,
    excludedOccurrences: exclusions,
    identityRequirements: clone(IDENTITY_REQUIREMENTS),
    occurrences,
    profiles,
    questionFixtures,
    unresolvedDeliveryDependencies: unresolved,
    version: VERSION,
  });
}

const MANIFEST = (() => {
  const manifest = buildManifest();
  if (canonical(manifest) !== getSessionTroopProjectileAuthorityReceipt()) {
    throw new TypeError("projectile profile manifest diverges from the closed HTJP authority");
  }
  return manifest;
})();

function assertNoArguments(args, label) {
  if (args.length !== 0) throw new TypeError(`${label} takes no arguments`);
}

export function createSessionTroopProjectileProfileManifest(...args) {
  assertNoArguments(args, "session troop projectile profile manifest");
  return deepFreezeClone(MANIFEST);
}

export function serializeSessionTroopProjectileProfileManifest(...args) {
  assertNoArguments(args, "session troop projectile profile serialization");
  return getSessionTroopProjectileAuthorityReceipt();
}

export function getSessionTroopProjectileProfile(id, ...args) {
  if (args.length !== 0) {
    throw new TypeError("session troop projectile profile lookup takes exactly one argument");
  }
  if (typeof id !== "string") {
    throw new TypeError("session troop projectile profile ID must be a primitive string");
  }
  if (id.length === 0 || id.length > MAX_ID_LENGTH) {
    throw new RangeError("session troop projectile profile ID is out of bounds");
  }
  const profile = MANIFEST.profiles.find((candidate) => candidate.id === id);
  if (profile === undefined) {
    const unresolved = MANIFEST.unresolvedDeliveryDependencies.find(({ id: dependencyId, component }) =>
      dependencyId === id || component?.id === id);
    if (unresolved !== undefined) {
      throw new RangeError("session troop projectile profile remains an explicit QUESTION");
    }
    throw new RangeError("session troop projectile profile ID is unknown or not admitted");
  }
  return deepFreezeClone(profile);
}
