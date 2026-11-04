import * as content from "./index.js";
import { createDeathEffectsQuestions } from "./cards/death-effects.js";
import { createDefensiveBuildingRuntimeProfiles } from "./cards/buildings-defensive.js";
import { createSharedHostResourcePolicyRecords } from "./cards/buildings-resource.js";
import { createUndergroundTravelBuildingQuestionRecords } from "./cards/buildings-travel.js";
import { assertSessionBuildingProfileReceipt } from "../sim/session-building-profile-receipts.js";
import { assertSafeCardCatalogGraph } from "./schema.js";
import { assertAuthoritativeProjectileSourceCatalogs } from "./session-troop-projectile-source-admission.js";
import {
  createPlayableRoster,
} from "./playable-roster.js";

const CLAIMS = Object.freeze([
  ["createBasicFlyingCatalog", ["copperskiff", "skymaul"]],
  ["createBasicMeleeCatalog", ["brackenwheel", "coilblade", "ironroot", "mossguard"]],
  ["createBasicRangedCatalog", ["brassbolt", "reedsting"]],
  ["createOrdinaryProjectileSquadCatalog", ["coppershade-flock", "duskwing-trio", "sunthread-pair"]],
  ["createOrdinaryProjectileSplashCatalog", ["kilnkeeper"]],
  ["createSwarmCatalog", ["briar-band", "cinder-host", "cinderlings", "forgeguard", "gloamwing-cluster", "thornscouts"]],
  ["DEATH_SPAWN_IDENTITY", ["ashen-nest"]],
  ["DEATH_CONVERSION_IDENTITY", ["gloam-shepherd"]],
  ["createStructureSeekerCatalog", ["stonehauler"]],
  ["createShieldFormCatalog", ["railward"]],
  ["createChargeSpecialCatalog", ["emberlance"]],
  ["createDashSpecialCatalog", ["veilrunner"]],
  ["createJumpSpecialCatalog", ["stonevault"]],
  ["createRecoilSpecialCatalog", ["cinderback"]],
  ["createKnockbackSpecialCatalog", ["squall-orb"]],
  ["createRetargetSpecialCatalog", ["wayfinder"]],
  ["createChargeKnockbackCatalog", ["emberlance"]],
  ["createChainSpecialCatalog", ["stormkite"]],
  ["createPierceSpecialCatalog", ["prism-warden"]],
  ["createReturnSpecialCatalog", ["rune-reaver"]],
  ["createPelletSpecialCatalog", ["scatterguard"]],
  ["createReflectionSpecialCatalog", ["aegis-sage"]],
  ["createRampSpecialCatalog", ["cinder-ray"]],
  ["createResetSpecialCatalog", ["static-burst"]],
  ["createStunSpecialCatalog", ["pulse-sentry"]],
  ["createSlowSpecialCatalog", ["rime-adept"]],
  ["createRageSpecialCatalog", ["tempo-field"]],
  ["createSnareSpecialCatalog", ["tether-rider"]],
  ["createDeathEffectsCatalog", ["cinder-reliquary"]],
  ["createHealCatalog", ["bloom-wisp", "dawnmender"]],
  ["createInvisibilitySpecialCatalog", ["veil-prowler"]],
  ["createDefensiveBuildingCatalog", ["bulwark-needle", "buried-coil",
    "ember-basin", "horizon-caster", "prism-furnace"]],
  ["SPAWNER_BUILDING_IDENTITIES", ["bramble-cage", "ember-roost"]],
  ["createResourceBuildingCatalog", ["aether-well"]],
  ["createUndergroundTravelBuildingCatalog", ["burrow-rig"]],
  ["createInstantSpellCatalog", ["squall-orb"]],
  ["SPAWN_SPELL_IDENTITIES", ["cloudseed-flask", "hollowgarden"]],
  ["createPeriodicSpellCatalog", ["blight-ring", "fault-pulse", "gravity-well"]],
  ["createTravelingLineSpellCatalog", ["squall-orb"]],
  ["createReturningSpellCatalog", ["squall-orb"]],
  ["createThreeWaveTravelingSpellCatalog", ["skyshard-volley"]],
  ["createRollingSpellCatalog", ["ironbark-roller"]],
  ["createChampionAbilityCatalog", ["aegis-sage", "bone-regent", "dusk-ranger",
    "gilded-lancer", "iron-borer"]],
]);

const INCOMPLETE = new Set([
  "ashen-nest", "bramble-cage", "cloudseed-flask", "ember-roost",
  "gloam-shepherd", "hollowgarden",
]);
const QUESTION_ONLY = Object.freeze([
  ["SpawnBatchMaterializer", "shared placement primitive has no exported runtime card identity"],
  ["DashKnockbackRetargetEncounter", "composition policies are corpus-absent QUESTION records"],
  ["LeapKnockbackRetargetEncounter", "composition policies are corpus-absent QUESTION records"],
  ["PreviousCardCopyMatch", "copy card identity and mechanics are intentionally unclaimed"],
  ["DeployedUnitCloneEncounter", "clone card identity and mechanics are intentionally unclaimed"],
]);
// These two effect rosters intentionally remain question-only records rather
// than schema catalogs: their effect rarity is outside the original runtime
// card schema. The supported unit/building/effect catalogs all enter through
// createCardCatalog and therefore use the private identity boundary below.
const UNBRANDED_QUESTION_CATALOG_EXPORTS = new Set([
  "createRollingSpellCatalog",
  "createThreeWaveTravelingSpellCatalog",
]);
const KINDS = new Set(["effect", "structure", "unit"]);
function clone(value) { return structuredClone(value); }

const DEFENSIVE_RUNTIME = createDefensiveBuildingRuntimeProfiles();
const SHARED_HOST_RESOURCE_POLICY_V2 = createSharedHostResourcePolicyRecords();
const TRAVEL_QUESTIONS = createUndergroundTravelBuildingQuestionRecords();
const DEATH_QUESTIONS = createDeathEffectsQuestions();

function questionPolicy(records, fields) {
  return Object.fromEntries(fields.map(([policyField, recordKey]) =>
    [policyField, clone(records[recordKey])]));
}

function buildingRuntimeProfile(id, source) {
  let profile;
  if (Object.hasOwn(DEFENSIVE_RUNTIME, id)) {
    profile = { class: "defensive", ...clone(DEFENSIVE_RUNTIME[id]) };
  } else if (id === "aether-well") {
    profile = { class: "resource", deployTicks: source.deployTimeTicks,
      destructionAmount: SHARED_HOST_RESOURCE_POLICY_V2.destructionAmount.value,
      generationAmount: SHARED_HOST_RESOURCE_POLICY_V2.generationAmount.value,
      generationCadenceTicks: SHARED_HOST_RESOURCE_POLICY_V2.generationCadenceTicks.value,
      hitpoints: source.hitpoints,
      lifetimeTicks: SHARED_HOST_RESOURCE_POLICY_V2.lifetimeTicks.value,
      policy: clone(SHARED_HOST_RESOURCE_POLICY_V2) };
  } else if (id === "burrow-rig") {
    profile = { class: "travel", deployTicks: source.deployTimeTicks,
      emergenceSpawnDelayTicks: TRAVEL_QUESTIONS.emergenceSpawnDelayTicks.value,
      hitpoints: source.hitpoints, lifetimeTicks: TRAVEL_QUESTIONS.lifetimeTicks.value,
      travelSpeedMillitilesPerSecond: TRAVEL_QUESTIONS.travelSpeedMillitilesPerSecond.value,
      policy: questionPolicy(TRAVEL_QUESTIONS, [
        ["emergenceSpawnDelayTicks", "emergenceSpawnDelayTicks"],
        ["lifetimeTicks", "lifetimeTicks"],
        ["travelSpeedMillitilesPerSecond", "travelSpeedMillitilesPerSecond"],
      ]) };
  } else if (id === "cinder-reliquary") {
    profile = { class: "death-effect", damage: source.damage, deployTicks: source.deployTimeTicks,
      firstHitTicks: source.firstHitTicks, hitSpeedTicks: source.hitSpeedTicks,
      hitpoints: source.hitpoints, deathDamage: DEATH_QUESTIONS.damage.value,
      radius: DEATH_QUESTIONS.radius.value,
      rangeMillitiles: source.rangeMillitiles, targetMode: "ground",
      towerModifier: clone(DEATH_QUESTIONS.towerModifier.value),
      policy: questionPolicy(DEATH_QUESTIONS, [
        ["deathDamage", "damage"],
        ["radius", "radius"],
        ["towerModifier", "towerModifier"],
      ]) };
  }
  if (profile !== undefined) assertSessionBuildingProfileReceipt(id, canonical(profile),
    "session card catalog building runtime profile");
  return profile ?? null;
}

function freeze(value) { if (value && typeof value === "object" && !Object.isFrozen(value)) {
  for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value; }
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function records(exportName, authoritative = null) {
  if (authoritative !== null && Object.hasOwn(authoritative, exportName)) {
    return authoritative[exportName];
  }
  const value = content[exportName];
  if (typeof value === "function") {
    const catalog = value();
    if (!UNBRANDED_QUESTION_CATALOG_EXPORTS.has(exportName)) {
      assertSafeCardCatalogGraph(catalog, `${exportName} source catalog`);
    }
    return catalog;
  }
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object" && typeof value.id === "string") return [value];
  return Object.values(value);
}
function checkedCatalogRecord(record, exportName) {
  if (!record || typeof record !== "object" || !KINDS.has(record.kind) ||
      typeof record.id !== "string" || typeof record.displayName !== "string" ||
      !Number.isSafeInteger(record.cost) || record.cost < 1 || record.cost > 10 ||
      !(record.deployTimeTicks === null ||
        (Number.isSafeInteger(record.deployTimeTicks) && record.deployTimeTicks >= 0))) {
    throw new TypeError(`${exportName} does not provide a complete session admission record`);
  }
  return record;
}

function buildManifest() {
  const authoritative = assertAuthoritativeProjectileSourceCatalogs();
  const occurrences = [];
  const admittedById = new Map();
  for (const [exportName, expectedIds] of CLAIMS) {
    const byId = new Map(records(exportName, authoritative)
      .map((record) => [record.id, record]));
    if (canonical([...byId.keys()]) !== canonical(expectedIds)) {
      throw new Error(`${exportName} diverges from the canonical integration claim`);
    }
    for (const id of expectedIds) {
      if (INCOMPLETE.has(id)) {
        occurrences.push({ exportName, id, reason:
          "identity-only claim lacks sourced kind/cost/deploy admission fields", status: "question" });
        continue;
      }
      const source = checkedCatalogRecord(byId.get(id), exportName);
      const prior = admittedById.get(id);
      const identity = { cost: source.cost, deployTimeTicks: source.deployTimeTicks,
        displayName: source.displayName, id, kind: source.kind,
        placementClass: source.kind === "effect" ? "global_effect" : "ground_entity" };
      if (prior && canonical(prior.identity) !== canonical(identity)) {
        throw new Error(`shared session identity ${id} has divergent admission records`);
      }
      if (prior) prior.occurrenceExports.push(exportName);
      else admittedById.set(id, { identity, occurrenceExports: [exportName], source: clone(source) });
      occurrences.push({ exportName, id, status: "admitted" });
    }
  }
  const cards = [...admittedById.values()].map(({ identity, occurrenceExports }) => ({
    ...identity, occurrenceExports: [...occurrenceExports].sort(),
  })).sort((left, right) => left.id.localeCompare(right.id));
  const excludedClaims = occurrences.filter(({ status }) => status === "question")
    .sort((left, right) => left.id.localeCompare(right.id));
  const questionOnly = QUESTION_ONLY.map(([exportName, reason]) => ({ exportName, reason,
    status: "question-only" })).sort((left, right) => left.exportName.localeCompare(right.exportName));
  const admittedOccurrences = occurrences.filter(({ status }) => status === "admitted").length;
  return freeze({ cards, counts: {
    admittedIds: cards.length,
    admittedOccurrences,
    claimedIds: new Set(occurrences.map(({ id }) => id)).size,
    claimedOccurrences: occurrences.length,
    excludedClaimedIds: new Set(excludedClaims.map(({ id }) => id)).size,
    excludedClaimedOccurrences: excludedClaims.length,
    questionOnlyExports: questionOnly.length,
  }, excludedClaims, occurrences: occurrences.sort((left, right) =>
    left.id.localeCompare(right.id) || left.exportName.localeCompare(right.exportName)),
  questionOnly, version: 1 });
}

const MANIFEST = buildManifest();

export function createSessionCardManifest(...args) {
  if (args.length) throw new TypeError("session card manifest takes no arguments");
  return freeze(clone(MANIFEST));
}

export function serializeSessionCardManifest(...args) {
  if (args.length) throw new TypeError("session card manifest serialization takes no arguments");
  return canonical(MANIFEST);
}

export function getSessionCardAdmissionRecord(id) {
  if (typeof id !== "string") throw new TypeError("session card ID must be a primitive string");
  const excluded = MANIFEST.excludedClaims.find((entry) => entry.id === id);
  if (excluded) throw new RangeError(`session card ${id} remains an explicit QUESTION`);
  const card = MANIFEST.cards.find((entry) => entry.id === id);
  if (!card) throw new RangeError(`session card ${id} is not claimed`);
  return freeze(clone(card));
}

export function createSessionCardDeckWitnesses(...args) {
  if (args.length) throw new TypeError("session deck witnesses take no arguments");
  const ids = MANIFEST.cards.map(({ id }) => id);
  return freeze(ids.map((id) => ({
    cardId: id,
    deck: [id, ...ids.filter((candidate) => candidate !== id).slice(0, 7)],
  })));
}

export function projectSessionNonUnitBattleCard(id) {
  const authoritative = assertAuthoritativeProjectileSourceCatalogs();
  const admitted = getSessionCardAdmissionRecord(id);
  if (admitted.kind === "unit") throw new TypeError("unit runtime projection belongs to troop binding");
  const sourceExport = admitted.occurrenceExports[0];
  const source = records(sourceExport, authoritative).find((record) => record.id === id);
  const buildingRuntime = source.kind === "structure" ? buildingRuntimeProfile(id, source) : null;
  if (source.kind === "structure" && buildingRuntime === null) {
    throw new Error("admitted structure lacks a shared building runtime profile");
  }
  const projection = {
    areaDamageRadiusMillitiles: source.areaDamageRadiusMillitiles,
    cost: source.cost,
    count: source.count,
    damage: source.damage,
    deployTimeTicks: source.deployTimeTicks,
    displayName: source.displayName,
    entities: [],
    firstHitTicks: source.firstHitTicks,
    formation: { componentOrder: [], expansionOrder: "component-order-then-member-index",
      totalCount: 0 },
    hitSpeedTicks: source.hitSpeedTicks,
    hitpoints: source.hitpoints,
    id: source.id,
    kind: source.kind,
    movementMillitilesPerSecond: source.movementMillitilesPerSecond,
    rangeMillitiles: source.rangeMillitiles,
    rarity: source.rarity,
    sightRangeMillitiles: source.sightRangeMillitiles,
    targetMode: source.targetMode,
  };
  if (buildingRuntime !== null) projection.buildingRuntime = buildingRuntime;
  return freeze(projection);
}

function sourceProfileFromPlayableMossguard() {
  const roster = createPlayableRoster();
  const card = roster.find(({ id }) => id === "mossguard");
  const entity = card?.entities[0];
  if (card?.kind !== "unit" || card.entities.length !== 1 || entity?.role !== "primary" ||
      entity.delivery !== "melee") {
    throw new TypeError("CONTENT-002 mossguard production projection is unavailable");
  }

  // Every numeric field below is copied from the existing sourced combat
  // projection, never handwritten here. QUESTION-only body-radius and other
  // runtime-estimate fields intentionally do not enter this source receipt.
  // LiveBattle separately uses its existing shared geometry state for range
  // validation before a contact witness can be minted.
  return {
    combat: {
      damage: entity.damage,
      delivery: entity.delivery,
      deployTimeTicks: entity.deployTimeTicks,
      firstHitTicks: entity.firstHitTicks,
      hitSpeedTicks: entity.hitSpeedTicks,
      layer: entity.layer,
      rangeMillitiles: entity.rangeMillitiles,
      sightRangeMillitiles: entity.sightRangeMillitiles,
      targetMode: entity.targetMode,
    },
    entity: {
      archetypeId: entity.archetypeId,
      memberIndex: 0,
      role: entity.role,
    },
  };
}

/**
 * Produces the one narrow GAME-001HTA current profile: an observation of the
 * already projected CONTENT-002 Mossguard ordinary melee contact. It is not a
 * troop roster declaration, a player ability, a cost/cooldown rule, or a
 * second combat implementation. Damage and all mutable effect facts remain
 * host-derived from LiveBattle's existing shared unit graph.
 */
export function createSessionTroopRuntimeProfiles(...args) {
  if (args.length !== 0) {
    throw new TypeError("current session troop runtime profiles take no selection");
  }
  const admitted = getSessionCardAdmissionRecord("mossguard");
  if (admitted.kind !== "unit") {
    throw new TypeError("CONTENT-002 mossguard is not an admitted unit");
  }
  const sourceProfile = sourceProfileFromPlayableMossguard();
  return freeze(clone({
    profiles: [{
      cardId: admitted.id,
      claim: "representative-live-contact",
      contact: {
        delivery: sourceProfile.combat.delivery,
        effect: "ordinary-live-contact",
        provenance: {
          confidence: "medium-high-unverified-per-value",
          contentPiece: "CONTENT-002",
          verification: "cards-basic-melee",
        },
      },
      sourceProfile,
    }],
    version: 3,
  }));
}
