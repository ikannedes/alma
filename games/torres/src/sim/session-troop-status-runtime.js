import {
  assertSessionTroopSourceConfidencePolicy,
  assertSessionTroopSourceConfidenceQuestions,
  encodeSessionTroopSourceConfidenceValue,
} from "../shared/session-troop-source-confidence-authority.js";
import {
  assertOrdinaryProjectileDeliveryPolicy,
  assertOrdinaryProjectileSplashProfile,
  getOrdinaryProjectileDeliveryPolicy,
  getOrdinaryProjectileSplashProfile,
  getOrdinaryProjectileSplashSourceFacts,
} from "../shared/ordinary-projectile-delivery-authority.js";
import {
  ordinaryProjectileSplashEntityFields,
  ordinaryProjectileSplashEntityShape,
} from "./ordinary-projectile-splash.js";

export const SESSION_TROOP_STATUS_RUNTIME_VERSION = 1;
export const SESSION_TROOP_STATUS_RUNTIME_MAX_COMMANDS = 1_024;
export const SESSION_TROOP_STATUS_RUNTIME_MAX_SOURCES = 1_024;
export const SESSION_TROOP_STATUS_RUNTIME_MAX_RECEIPT_BYTES = 1_048_576;

const PROFILE_IDS = Object.freeze([
  "aegis-sage",
  "bloom-wisp",
  "dawnmender",
  "pulse-sentry",
  "railward",
  "rime-adept",
  "tether-rider",
  "veil-prowler",
]);
const PHASES = new Set(["pre-move"]);
const FAMILIES = new Set([
  "heal",
  "invisibility",
  "reflection",
  "shield-form",
  "slow",
  "snare",
  "stun",
]);
const SOURCE_KEYS = ["cardId", "side", "sourceId"];
const TARGET_KEYS = ["alive", "id", "kind", "layer", "side", "targetable"];
const COMMAND_KEYS = [
  "actionId", "commandId", "side", "sourceId", "targetId", "tick", "type",
];
const OBSERVATION_KEYS = ["commands", "phase", "sources", "targets", "tick"];
const INTENT_KEYS = [
  "actionId", "cardId", "commandId", "effect", "parameters", "phase", "side",
  "sourceId", "targetId", "tick", "type",
];

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function freeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function exact(value, keys, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype &&
       Object.getPrototypeOf(value) !== null) ||
      Object.getOwnPropertySymbols(value).length !== 0) {
    throw new TypeError(`${label} must be a plain string-keyed object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const actual = Reflect.ownKeys(descriptors).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${label} has an invalid shape`);
  }
  for (const key of expected) {
    const descriptor = descriptors[key];
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
      throw new TypeError(`${label}.${key} must be an enumerable data property`);
    }
  }
  return Object.fromEntries(keys.map((key) => [key, descriptors[key].value]));
}

function boundedArray(value, label, maximum) {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new TypeError(`${label} must be a bounded array`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (key === "length") continue;
    if (typeof key !== "string" || !/^(0|[1-9]\d*)$/u.test(key) ||
        Number(key) >= value.length) {
      throw new TypeError(`${label} must contain only indexed data`);
    }
  }
  return Array.from({ length: value.length }, (_, index) => {
    const descriptor = descriptors[index];
    if (descriptor === undefined || !descriptor.enumerable ||
        !Object.hasOwn(descriptor, "value")) {
      throw new TypeError(`${label}[${index}] must be an enumerable data property`);
    }
    return descriptor.value;
  });
}

function integer(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label} must be a safe integer from ${minimum} through ${maximum}`);
  }
  return value;
}

function text(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.length > 256 ||
      value.normalize("NFC") !== value || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`${label} must be bounded normalized text`);
  }
  return value;
}

// The content-side receipt builder supplies the exact manifest and question
// records. Keeping the admission witness here as a digest lets the shared
// kernel validate that receipt without importing content back through the
// public content index (which would create an ESM initialization cycle).
// This value is filled from the pinned content receipt and is intentionally
// checked over the complete canonical receipt, not just the executable fields.
const RECEIPT_FINGERPRINT = "5ce7a9c35c0be1b9";
const PROFILE_ID_SET = new Set(PROFILE_IDS);
const RECEIPT_MAX_DEPTH = 64;
const RECEIPT_MAX_NODES = 50_000;
const SOURCE_RECORD_KEYS = Object.freeze([
  "areaDamageRadiusMillitiles", "components", "cost", "count", "damage",
  "deployTimeTicks", "displayName", "firstHitTicks", "hitSpeedTicks",
  "hitpoints", "id", "kind", "movementMillitilesPerSecond", "rangeMillitiles",
  "rarity", "sightRangeMillitiles", "targetMode",
]);
const SOURCE_COMPONENT_KEYS = Object.freeze([
  "areaDamageRadiusMillitiles", "count", "damage", "deployTimeTicks",
  "displayName", "firstHitTicks", "hitSpeedTicks", "hitpoints", "id", "kind",
  "movementMillitilesPerSecond", "rangeMillitiles", "role", "sightRangeMillitiles",
  "targetMode",
]);
const SOURCE_CARD_FIELDS = Object.freeze(SOURCE_RECORD_KEYS.filter((key) =>
  key !== "components"));
const SOURCE_ENTITY_FIELDS = Object.freeze(SOURCE_COMPONENT_KEYS.filter((key) =>
  key !== "id" && key !== "role"));
const STATUS_CARD_KEYS = Object.freeze([
  ...SOURCE_RECORD_KEYS.filter((key) => key !== "components"), "entities", "formation",
]);
const STATUS_ENTITY_KEYS = Object.freeze([
  "archetypeId", "areaDamageRadiusMillitiles", "bodyRadiusPolicy", "count",
  "damage", "delivery", "deployTimeTicks", "displayName", "firstHitTicks",
  "hitSpeedTicks", "hitpoints", "kind", "layer", "movementMillitilesPerSecond",
  "projectileSpeedPolicy", "rangeMillitiles", "role", "sightRangeMillitiles",
  "targetMode", "deliveryPolicy", "layerPolicy",
]);
const STATUS_SOURCE_CONFIDENCE_ENTITY_KEYS = Object.freeze([
  "sourceConfidencePolicy",
]);
const STATUS_QUESTION_KEYS = Object.freeze([
  "authoritative", "confidence", "disposition", "key", "source", "value",
]);
const STATUS_QUESTION_SOURCE = "runtime-playability-estimate-not-comparison-corpus";
const KILNKEEPER_AREA_RADIUS_KEY = "kilnkeeper.character-area-damage-radius-millitiles";
const KILNKEEPER_AREA_RADIUS_SOURCE =
  "pinned-royaleapi-54fdef52:cards_stats_characters#wizard";
const STATUS_LAYER_RESOLUTION = 1;
const STATUS_PROJECTILE_SPEED_RESOLUTION = 500;
const STATUS_MAX_QUESTIONS = 256;

function fingerprint(serialized) {
  const bytes = new TextEncoder().encode(serialized);
  let left = 2_166_136_261;
  let right = 2_166_136_261;
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index];
    left = Math.imul(left ^ byte, 16_777_619) >>> 0;
    right = Math.imul(right ^ (byte + ((index * 31) & 255)), 16_777_619) >>> 0;
  }
  return `${left.toString(16).padStart(8, "0")}${right.toString(16).padStart(8, "0")}`;
}

function dataTree(value, label, state = { depth: 0, nodes: 0 }, depth = 0) {
  state.nodes += 1;
  if (state.nodes > RECEIPT_MAX_NODES || depth > RECEIPT_MAX_DEPTH) {
    throw new RangeError(`${label} exceeds the receipt graph bound`);
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    if (typeof value === "string" && value.length > SESSION_TROOP_STATUS_RUNTIME_MAX_RECEIPT_BYTES) {
      throw new RangeError(`${label} exceeds the receipt text bound`);
    }
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) {
      throw new TypeError(`${label} must contain only finite bounded numbers`);
    }
    return value;
  }
  if (typeof value !== "object") throw new TypeError(`${label} contains an invalid value`);

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null && !Array.isArray(value)) {
    throw new TypeError(`${label} must contain only plain data objects`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.getOwnPropertySymbols(value).length !== 0) {
    throw new TypeError(`${label} must not contain symbols`);
  }
  if (Array.isArray(value)) {
    const keys = Reflect.ownKeys(descriptors);
    const lengthDescriptor = descriptors.length;
    if (lengthDescriptor === undefined || !Object.hasOwn(lengthDescriptor, "value") ||
        !Number.isSafeInteger(lengthDescriptor.value)) {
      throw new TypeError(`${label} has an invalid array length`);
    }
    const length = lengthDescriptor.value;
    if (keys.some((key) => key !== "length" &&
        (typeof key !== "string" || !/^(0|[1-9]\d*)$/u.test(key) || Number(key) >= length))) {
      throw new TypeError(`${label} must contain only indexed data`);
    }
    return Array.from({ length }, (_, index) => {
      const descriptor = descriptors[index];
      if (descriptor === undefined || !descriptor.enumerable ||
          !Object.hasOwn(descriptor, "value")) {
        throw new TypeError(`${label}[${index}] must be an enumerable data property`);
      }
      return dataTree(descriptor.value, `${label}[${index}]`, state, depth + 1);
    });
  }
  const keys = Reflect.ownKeys(descriptors).sort();
  if (keys.some((key) => typeof key !== "string")) {
    throw new TypeError(`${label} must contain only string keys`);
  }
  return Object.fromEntries(keys.map((key) => {
    const descriptor = descriptors[key];
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
      throw new TypeError(`${label}.${key} must be an enumerable data property`);
    }
    return [key, dataTree(descriptor.value, `${label}.${key}`, state, depth + 1)];
  }));
}

function checkedReceiptObject(value, label) {
  const normalized = dataTree(value, label);
  const receipt = exact(normalized, ["manifest", "profiles", "version"], label);
  if (receipt.version !== SESSION_TROOP_STATUS_RUNTIME_VERSION ||
      typeof receipt.manifest !== "string" || receipt.manifest.length === 0) {
    throw new TypeError(`${label} is not the exact passed status profile receipt`);
  }
  const profiles = boundedArray(receipt.profiles, `${label}.profiles`, PROFILE_IDS.length);
  if (profiles.length !== PROFILE_IDS.length ||
      profiles.some((profile, index) =>
        profile === null || typeof profile !== "object" ||
        profile.id !== PROFILE_IDS[index])) {
    throw new TypeError(`${label} diverges from the exact passed status profile identities`);
  }
  let manifestValue;
  try {
    manifestValue = JSON.parse(receipt.manifest);
  } catch {
    throw new TypeError(`${label} has an invalid canonical source manifest`);
  }
  if (canonical(manifestValue) !== receipt.manifest ||
      !Array.isArray(manifestValue.profiles) ||
      manifestValue.profiles.length !== PROFILE_IDS.length ||
      manifestValue.profiles.some((profile, index) => profile.id !== PROFILE_IDS[index])) {
    throw new TypeError(`${label} has an invalid canonical source manifest`);
  }
  const serialized = canonical(receipt);
  if (fingerprint(serialized) !== RECEIPT_FINGERPRINT) {
    throw new TypeError(`${label} diverges from the exact passed status profile manifest`);
  }
  return clone(receipt);
}

function statusRosterData(value) {
  const normalized = dataTree(value, "status runtime source roster");
  if (!Array.isArray(normalized) || normalized.length > 8) {
    throw new TypeError("status runtime source roster must be a bounded array");
  }
  return normalized;
}

function assertKilnkeeperAreaRadiusClosure(record, roster) {
  if (record.source !== KILNKEEPER_AREA_RADIUS_SOURCE || record.value !== 0) {
    throw new TypeError("kilnkeeper area radius QUESTION diverges from its pinned source receipt");
  }
  const matches = roster.flatMap((card) => card.id === "kilnkeeper"
    ? card.entities.filter(({ archetypeId }) => archetypeId === "kilnkeeper")
      .map((entity) => ({ card, entity }))
    : []);
  if (matches.length !== 1) {
    throw new TypeError("kilnkeeper area radius QUESTION has no unique source confidence closure");
  }
  const [{ card, entity }] = matches;
  const policy = assertSessionTroopSourceConfidencePolicy(
    entity.sourceConfidencePolicy, card.id, entity.archetypeId,
  );
  const confidenceField = policy.fields.find(({ questionKey }) =>
    questionKey === KILNKEEPER_AREA_RADIUS_KEY);
  const sourceProfile = getOrdinaryProjectileSplashProfile(card.id, entity.archetypeId);
  const sourceFacts = getOrdinaryProjectileSplashSourceFacts(card.id, entity.archetypeId);
  if (confidenceField === undefined || confidenceField.field !==
      "projectileSplashSourceFacts.characterAreaDamageRadiusMillitiles" ||
      confidenceField.valueEncoding !== "nonnegative-integer" ||
      confidenceField.source !== KILNKEEPER_AREA_RADIUS_SOURCE || sourceProfile === null ||
      canonical(assertOrdinaryProjectileSplashProfile(entity.projectileSplashPolicy,
        card.id, entity.archetypeId)) !== canonical(sourceProfile) ||
      canonical(entity.projectileSplashSourceFacts) !== canonical(sourceFacts) ||
      encodeSessionTroopSourceConfidenceValue(confidenceField.valueEncoding,
        entity.projectileSplashSourceFacts.characterAreaDamageRadiusMillitiles) !== record.value) {
    throw new TypeError("kilnkeeper area radius QUESTION has an invalid source confidence closure");
  }
}

function statusQuestionData(value, roster) {
  const normalized = dataTree(value, "status runtime question inventory");
  if (!Array.isArray(normalized) || normalized.length > STATUS_MAX_QUESTIONS) {
    throw new TypeError("status runtime question inventory must be a bounded array");
  }
  const records = normalized.map((raw, index) => {
    const record = exact(raw, STATUS_QUESTION_KEYS,
      `status runtime question inventory[${index}]`);
    if (record.authoritative !== false || record.confidence !== "unverified" ||
        record.disposition !== "question" || typeof record.key !== "string" ||
        record.key.length === 0 || typeof record.source !== "string" ||
        record.source.length === 0) {
      throw new TypeError(`status runtime question inventory[${index}] is not an unresolved QUESTION`);
    }
    if (record.key === KILNKEEPER_AREA_RADIUS_KEY) {
      assertKilnkeeperAreaRadiusClosure(record, roster);
    }
    return {
      authoritative: false,
      confidence: "unverified",
      disposition: "question",
      key: record.key,
      source: record.source,
      value: integer(record.value,
        record.key === KILNKEEPER_AREA_RADIUS_KEY ? 0 : 1, Number.MAX_SAFE_INTEGER,
        `status runtime question inventory[${index}].value`),
    };
  });
  if (new Set(records.map(({ key }) => key)).size !== records.length) {
    throw new TypeError("status runtime question inventory keys must be unique");
  }
  return new Map(records.map((record) => [record.key, record]));
}

function policy(value, label) {
  const checked = exact(value, ["kind", "questionKey"], label);
  return { kind: checked.kind, questionKey: checked.questionKey };
}

function assertQuestionPolicy(value, expectedKey, label) {
  const checked = policy(value, label);
  if (checked.kind !== "question" || checked.questionKey !== expectedKey) {
    throw new TypeError(`${label} diverges from its pinned QUESTION path`);
  }
}

function assertProjectilePolicy(value, entity, label) {
  const checked = policy(value, label);
  if (entity.delivery === "projectile") {
    if (checked.kind !== "question" ||
        checked.questionKey !== `${entity.archetypeId}.projectile-speed-millitiles-per-tick`) {
      throw new TypeError(`${label} diverges from its pinned projectile QUESTION path`);
    }
    return;
  }
  if (entity.delivery !== "melee" || checked.kind !== "not-applicable" ||
      checked.questionKey !== null) {
    throw new TypeError(`${label} diverges from its pinned delivery policy`);
  }
}


function statusDeliveryResolution(profile, label) {
  if (profile.claimFamily === "reflection" &&
      profile.sourceExport === "createReflectionSpecialCatalog") {
    return "projectile";
  }
  if (profile.id === "rime-adept" && profile.claimFamily === "slow" &&
      profile.sourceExport === "createSlowSpecialCatalog") {
    const policy = getOrdinaryProjectileDeliveryPolicy(profile.id, profile.id);
    if (policy === null || policy.delivery !== "projectile") {
      throw new TypeError(`${label} has no matching source-backed projectile delivery claim`);
    }
    return policy.delivery;
  }
  if (["heal", "invisibility", "shield-form", "slow", "snare", "stun"].includes(
    profile.claimFamily)) {
    return "melee";
  }
  throw new RangeError(`${label} has no receipt-authorized delivery resolution`);
}

function statusQuestionResolution(profile, source, suffix, label) {
  if (suffix === "body-radius-millitiles") {
    return source.count === 1 ? 500 : 300;
  }
  if (suffix === "delivery") {
    return statusDeliveryResolution(profile, label) === "projectile" ? 2 : 1;
  }
  if (suffix === "layer") {
    // The passed status receipt contains no air-layer claim. Its canonical
    // status projection therefore pins the unresolved layer to the existing
    // ground witness; an air layer needs a new sourced receipt.
    if (profile.sourceRecord.targetMode === "air") return 2;
    if (["ground", "ground-and-air", "structures"].includes(
      profile.sourceRecord.targetMode)) return STATUS_LAYER_RESOLUTION;
    throw new RangeError(`${label} has no receipt-authorized layer resolution`);
  }
  if (suffix === "projectile-speed-millitiles-per-tick") {
    if (statusDeliveryResolution(profile, label) !== "projectile") {
      throw new TypeError(`${label} has a projectile QUESTION without a delivery claim`);
    }
    return STATUS_PROJECTILE_SPEED_RESOLUTION;
  }
  throw new TypeError(`${label} has an unsupported status projection QUESTION`);
}

function assertPinnedProjectionQuestion(questionMap, key, value, label) {
  if (questionMap === null) return;
  const actual = questionMap.get(key);
  const expected = {
    authoritative: false,
    confidence: "unverified",
    disposition: "question",
    key,
    source: STATUS_QUESTION_SOURCE,
    value,
  };
  if (actual === undefined || canonical(actual) !== canonical(expected)) {
    throw new TypeError(`${label} diverges from its pinned QUESTION resolution`);
  }
}

function assertStatusSourceConfidenceQuestions(entity, cardId, archetypeId,
  questionMap, label) {
  const policy = assertSessionTroopSourceConfidencePolicy(
    entity.sourceConfidencePolicy, cardId, archetypeId,
  );
  if (questionMap === null) return policy;
  const records = [...questionMap.values()];
  assertSessionTroopSourceConfidenceQuestions({
    present: true,
    value: policy,
    cardId,
    archetypeId,
    entity,
    questionKeys: new Set(questionMap.keys()),
    questionValues: new Map(records.map(({ key, value }) => [key, value])),
    questionSources: new Map(records.map(({ key, source }) => [key, source])),
    referencedQuestionKeys: new Set(),
    label,
  });
  return policy;
}

function assertReceiptStatusEntityPolicies(entity, profile, source, questionMap, label) {
  if (typeof entity.archetypeId !== "string" || entity.archetypeId.length === 0) {
    throw new TypeError(`${label}.archetypeId is invalid`);
  }
  const rimeProjectileClaim = profile.id === "rime-adept" &&
    profile.claimFamily === "slow" &&
    profile.sourceExport === "createSlowSpecialCatalog";
  const hasSourceConfidencePolicy = rimeProjectileClaim &&
    Object.hasOwn(entity, "sourceConfidencePolicy");
  const splashShape = rimeProjectileClaim
    ? ordinaryProjectileSplashEntityShape(entity, [
      ...STATUS_ENTITY_KEYS,
      ...(hasSourceConfidencePolicy ? STATUS_SOURCE_CONFIDENCE_ENTITY_KEYS : []),
    ])
    : { hasProfile: false, keys: STATUS_ENTITY_KEYS };
  exact(entity, splashShape.keys, label);
  if (rimeProjectileClaim && (!splashShape.hasProfile || !hasSourceConfidencePolicy)) {
    throw new TypeError(`${label} lacks the Rime source-confidence/projectile claim`);
  }
  const delivery = statusDeliveryResolution(profile, label);
  const layer = STATUS_LAYER_RESOLUTION === 2 ? "air" : "ground";
  if (entity.delivery !== delivery || entity.layer !== layer) {
    throw new TypeError(`${label} diverges from the receipt-derived delivery/layer tuple`);
  }
  const sourceDeliveryPolicy = rimeProjectileClaim
    ? assertOrdinaryProjectileDeliveryPolicy(
      entity.deliveryPolicy, profile.id, entity.archetypeId, entity.delivery,
    )
    : null;
  assertQuestionPolicy(entity.bodyRadiusPolicy,
    `${entity.archetypeId}.body-radius-millitiles`, `${label}.bodyRadiusPolicy`);
  assertProjectilePolicy(entity.projectileSpeedPolicy, entity,
    `${label}.projectileSpeedPolicy`);
  if (sourceDeliveryPolicy === null) {
    assertQuestionPolicy(entity.deliveryPolicy, `${entity.archetypeId}.delivery`,
      `${label}.deliveryPolicy`);
  }
  assertQuestionPolicy(entity.layerPolicy, `${entity.archetypeId}.layer`,
    `${label}.layerPolicy`);
  if (rimeProjectileClaim) {
    ordinaryProjectileSplashEntityFields(entity, profile.id, entity.archetypeId, label);
    assertStatusSourceConfidenceQuestions(
      entity, profile.id, entity.archetypeId, questionMap, label,
    );
    if (questionMap?.has(`${entity.archetypeId}.delivery`)) {
      throw new TypeError(`${label} has a delivery QUESTION despite its source-backed claim`);
    }
  }
  const questionSuffixes = ["body-radius-millitiles",
    ...(sourceDeliveryPolicy === null ? ["delivery"] : []), "layer",
    ...(delivery === "projectile" ? ["projectile-speed-millitiles-per-tick"] : [])];
  for (const suffix of questionSuffixes) {
    const key = `${entity.archetypeId}.${suffix}`;
    assertPinnedProjectionQuestion(questionMap,
      key,
      statusQuestionResolution(profile, source, suffix, label),
      `${label}.${suffix}`);
  }
}

function comparePinnedFields(live, pinned, fields, label) {
  for (const field of fields) {
    if (canonical(live[field]) !== canonical(pinned[field])) {
      throw new TypeError(`${label}.${field} diverges from the pinned status source`);
    }
  }
}

function assertPinnedStatusCard(card, profile, questionMap = null) {
  const label = `status runtime source ${profile.id}`;
  if (card === null || typeof card !== "object" || Array.isArray(card) ||
      card.id !== profile.id || card.kind !== "unit") {
    throw new TypeError(`${label} card identity is not admitted`);
  }
  exact(card, STATUS_CARD_KEYS, label);
  const source = exact(profile.sourceRecord, SOURCE_RECORD_KEYS, `${label}.sourceRecord`);
  if (source.id !== profile.id || source.kind !== "unit" ||
      typeof profile.sourceWitness !== "string" ||
      profile.sourceWitness !== canonical(source)) {
    throw new TypeError(`${label} source provenance is not the pinned record`);
  }
  comparePinnedFields(card, source, SOURCE_CARD_FIELDS, label);

  const sourceComponents = boundedArray(source.components, `${label}.components`, 16);
  const entities = boundedArray(card.entities, `${label}.entities`, 16);
  const expectedComponents = sourceComponents.length === 0
    ? [{ ...source, id: source.id, role: "primary" }]
    : sourceComponents.map((component) => exact(component, SOURCE_COMPONENT_KEYS,
      `${label}.components`));
  if (entities.length !== expectedComponents.length) {
    throw new TypeError(`${label}.entity/component inventory diverges from the pinned source`);
  }
  const expectedOrder = expectedComponents.map(({ id }) => id);
  const formation = exact(card.formation, ["componentOrder", "expansionOrder", "totalCount"],
    `${label}.formation`);
  const componentOrder = boundedArray(formation.componentOrder,
    `${label}.formation.componentOrder`, 16);
  if (formation.expansionOrder !== "component-order-then-member-index" ||
      canonical(componentOrder) !== canonical(expectedOrder)) {
    throw new TypeError(`${label}.component order diverges from the pinned source`);
  }
  let totalCount = 0;
  for (let index = 0; index < expectedComponents.length; index += 1) {
    const expected = expectedComponents[index];
    const entity = entities[index];
    if (entity === null || typeof entity !== "object" || Array.isArray(entity) ||
        entity.archetypeId !== expected.id ||
        entity.role !== expected.role) {
      throw new TypeError(`${label}.entities[${index}] identity/order diverges from the pinned source`);
    }
    comparePinnedFields(entity, expected, SOURCE_ENTITY_FIELDS,
      `${label}.entities[${index}]`);
    assertReceiptStatusEntityPolicies(entity, profile, expected, questionMap,
      `${label}.entities[${index}]`);
    totalCount += entity.count;
  }
  if (formation.totalCount !== totalCount || card.count !== totalCount) {
    throw new TypeError(`${label}.formation count diverges from the pinned source`);
  }
}

function statusSignals(roster) {
  const cards = roster.filter((card) => card !== null && typeof card === "object" &&
    !Array.isArray(card));
  const cardIds = new Set();
  const entityClaims = [];
  for (const card of cards) {
    if (typeof card.id === "string" && PROFILE_ID_SET.has(card.id)) cardIds.add(card.id);
    if (!Array.isArray(card.entities)) continue;
    for (const entity of card.entities) {
      if (entity !== null && typeof entity === "object" && !Array.isArray(entity) &&
          typeof entity.archetypeId === "string" && PROFILE_ID_SET.has(entity.archetypeId)) {
        entityClaims.push({ cardId: card.id, entityId: entity.archetypeId });
      }
    }
  }
  return { cardIds, cards, entityClaims };
}

function validateSourceRoster(roster, receipt, questions = undefined) {
  const normalized = statusRosterData(roster);
  const questionMap = questions === undefined ? null : statusQuestionData(questions, normalized);
  const { cardIds, cards, entityClaims } = statusSignals(normalized);
  if (receipt === undefined) {
    // Legacy ordinary projections can contain a card that later gained a
    // sourced status family. They remain inert until the status runtime is
    // explicitly profiled; the command route still fails closed because it
    // has no runtime to inspect or schedule the effect.
    return;
  }
  const profiles = new Map(receipt.profiles.map((profile) => [profile.id, profile]));
  if (cardIds.size === 0) {
    throw new RangeError("status profile receipt has no live status source card");
  }
  for (const claim of entityClaims) {
    if (claim.cardId !== claim.entityId) {
      throw new TypeError("live status entity claims another supported status identity");
    }
  }
  for (const cardId of cardIds) {
    const profile = profiles.get(cardId);
    const matchingCards = cards.filter((candidate) => candidate.id === cardId);
    if (profile === undefined || matchingCards.length !== 1) {
      throw new TypeError(`status source ${cardId} has no pinned profile`);
    }
    assertPinnedStatusCard(matchingCards[0], profile, questionMap);
  }
}

export function parseSessionTroopStatusRuntimeProfiles(serialized) {
  if (typeof serialized !== "string") {
    throw new TypeError("session troop status runtime profiles must be canonical JSON text");
  }
  if (new TextEncoder().encode(serialized).byteLength > SESSION_TROOP_STATUS_RUNTIME_MAX_RECEIPT_BYTES) {
    throw new RangeError("session troop status runtime profiles exceed their byte bound");
  }
  let value;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new TypeError("session troop status runtime profiles must be valid JSON");
  }
  if (canonical(value) !== serialized) {
    throw new TypeError("session troop status runtime profiles must be canonical JSON");
  }
  return checkedReceiptObject(value, "session troop status runtime profiles");
}

export function serializeSessionTroopStatusRuntimeProfiles(value) {
  const receipt = checkedReceiptObject(value, "session troop status runtime profiles");
  return canonical(receipt);
}

export function assertSessionTroopStatusSourceRoster(
  roster, serialized = undefined, questions = undefined,
) {
  if (serialized === undefined) {
    validateSourceRoster(roster, undefined, questions);
    return;
  }
  if (typeof serialized !== "string") {
    throw new TypeError("session troop status source receipt must be canonical JSON text");
  }
  const receipt = parseSessionTroopStatusRuntimeProfiles(serialized);
  validateSourceRoster(roster, receipt, questions);
}

function checkedSource(value, index) {
  const source = exact(value, SOURCE_KEYS, `status runtime source ${index}`);
  const sourceId = integer(source.sourceId, 1, Number.MAX_SAFE_INTEGER,
    `status runtime source ${index}.sourceId`);
  if (typeof source.cardId !== "string" || !PROFILE_ID_SET.has(source.cardId) ||
      !["north", "south"].includes(source.side)) {
    throw new TypeError(`status runtime source ${index} is invalid`);
  }
  return { cardId: source.cardId, side: source.side, sourceId };
}

// Target facts are resolved by LiveBattle from its authoritative shared
// state. The reducer only authenticates the bounded host witness that it is
// handed; it never looks up units, towers, health, teams, layers, or time.
function checkedTarget(value, index) {
  if (value === null) return null;
  const target = exact(value, TARGET_KEYS, `status runtime target ${index}`);
  const id = integer(target.id, 1, Number.MAX_SAFE_INTEGER,
    `status runtime target ${index}.id`);
  if (target.kind !== "unit" || !["air", "ground"].includes(target.layer) ||
      !["north", "south"].includes(target.side) ||
      typeof target.alive !== "boolean" || typeof target.targetable !== "boolean") {
    throw new TypeError(`status runtime target ${index} is invalid`);
  }
  if (!target.alive) {
    throw new RangeError(`status runtime target ${index} is not an admitted live host fact`);
  }
  return { alive: true, id, kind: "unit", layer: target.layer,
    side: target.side, targetable: target.targetable };
}

function checkedCommand(value, currentTick, index) {
  const command = exact(value, COMMAND_KEYS, `status runtime command ${index}`);
  if (command.type !== "status") throw new TypeError("status runtime command.type is invalid");
  const actionId = text(command.actionId, `status runtime command ${index}.actionId`);
  const commandId = integer(command.commandId, 0, Number.MAX_SAFE_INTEGER,
    `status runtime command ${index}.commandId`);
  const sourceId = integer(command.sourceId, 1, Number.MAX_SAFE_INTEGER,
    `status runtime command ${index}.sourceId`);
  const targetId = command.targetId === null ? null : integer(command.targetId, 1,
    Number.MAX_SAFE_INTEGER, `status runtime command ${index}.targetId`);
  const tick = integer(command.tick, currentTick, currentTick,
    `status runtime command ${index}.tick`);
  if (!["north", "south"].includes(command.side)) {
    throw new TypeError(`status runtime command ${index}.side is invalid`);
  }
  return { actionId, commandId, side: command.side, sourceId, targetId, tick, type: "status" };
}

function checkedPhase(value) {
  if (typeof value !== "string" || !PHASES.has(value)) {
    throw new TypeError("status runtime phase is not an admitted canonical phase");
  }
  return value;
}

function checkedFamily(profile, label) {
  if (!FAMILIES.has(profile.claimFamily)) throw new TypeError(`${label}.claimFamily is invalid`);
  return profile.claimFamily;
}

function question(profile, key, label) {
  const record = profile.questions?.[key];
  if (record === undefined || record === null || !Object.hasOwn(record, "value")) {
    throw new RangeError(`${label} remains an explicit QUESTION (${key})`);
  }
  return record.value;
}

function checkedRate(value, label) {
  const rate = exact(value, ["denominator", "numerator"], label);
  return {
    denominator: integer(rate.denominator, 1, Number.MAX_SAFE_INTEGER, `${label}.denominator`),
    numerator: integer(rate.numerator, 1, rate.denominator - 1, `${label}.numerator`),
  };
}

function resolveAction(profile, actionId) {
  const family = checkedFamily(profile, `status profile ${profile.id}`);
  if (profile.resolution !== "question-bearing" || profile.questionReceipt === null ||
      profile.questions === null) {
    throw new RangeError(`status ${profile.id} remains an explicit QUESTION (${family})`);
  }
  if (family === "heal" && actionId === "heal") {
    const amountKey = profile.id === "bloom-wisp" ? "bloomWispHealAmount" : "dawnmenderHealAmount";
    return {
      effect: "heal",
      parameters: { amount: integer(question(profile, amountKey, `status ${profile.id}`), 0,
        Number.MAX_SAFE_INTEGER, `status ${profile.id}.${amountKey}`) },
    };
  }
  if (family === "stun" && actionId === "stun") {
    return {
      effect: "stun",
      parameters: { durationTicks: integer(question(profile, "durationTicks", `status ${profile.id}`),
        1, Number.MAX_SAFE_INTEGER, `status ${profile.id}.durationTicks`) },
    };
  }
  if (family === "slow" && actionId === "slow") {
    return {
      effect: "slow",
      parameters: {
        attackRate: checkedRate(question(profile, "attackProgressRate", `status ${profile.id}`),
          `status ${profile.id}.attackProgressRate`),
        durationTicks: integer(question(profile, "durationTicks", `status ${profile.id}`),
          1, Number.MAX_SAFE_INTEGER, `status ${profile.id}.durationTicks`),
        movementRate: checkedRate(question(profile, "movementProgressRate", `status ${profile.id}`),
          `status ${profile.id}.movementProgressRate`),
      },
    };
  }
  if (family === "snare" && actionId === "snare") {
    return {
      effect: "snare",
      parameters: { durationTicks: integer(question(profile, "durationTicks", `status ${profile.id}`),
        1, Number.MAX_SAFE_INTEGER, `status ${profile.id}.durationTicks`) },
    };
  }
  if (family === "invisibility" && (actionId === "hide" || actionId === "reveal")) {
    const key = actionId === "hide" ? "hideDurationTicks" : "revealDurationTicks";
    return {
      effect: actionId,
      parameters: { durationTicks: integer(question(profile, key, `status ${profile.id}`),
        1, Number.MAX_SAFE_INTEGER, `status ${profile.id}.${key}`) },
    };
  }
  throw new RangeError(`status ${profile.id} ${actionId} remains an explicit QUESTION (${family})`);
}

export class SessionTroopStatusRuntime {
  #receipt;

  constructor(serialized) {
    this.#receipt = parseSessionTroopStatusRuntimeProfiles(serialized);
  }

  get hasProfiles() {
    return true;
  }

  get state() {
    return clone(this.#receipt);
  }

  serialize() {
    return canonical(this.#receipt);
  }

  fork() {
    return new SessionTroopStatusRuntime(this.serialize());
  }

  assertSourceRoster(roster, questions = undefined) {
    validateSourceRoster(roster, this.#receipt, questions);
  }

  profile(cardId) {
    if (typeof cardId !== "string") throw new TypeError("status runtime card ID must be a primitive string");
    const profile = this.#receipt.profiles.find((entry) => entry.id === cardId);
    return profile === undefined ? null : clone(profile);
  }

  inspect({ actionId, cardId, sourceId, targetId }) {
    const profile = this.profile(cardId);
    if (profile === null) throw new RangeError(`status ${cardId} remains an explicit QUESTION (unadmitted)`);
    const resolved = resolveAction(profile, actionId);
    const needsTarget = resolved.effect !== "hide" && resolved.effect !== "reveal";
    if (needsTarget && targetId === null) {
      throw new RangeError(`status ${cardId} remains an explicit QUESTION (targeting)`);
    }
    if (!needsTarget && targetId !== null) {
      throw new RangeError(`status ${cardId} remains an explicit QUESTION (targeting)`);
    }
    integer(sourceId, 1, Number.MAX_SAFE_INTEGER, "status runtime sourceId");
    return clone(resolved);
  }

  reduce(observation) {
    const checked = exact(observation, OBSERVATION_KEYS, "status runtime observation");
    const tick = integer(checked.tick, 0, Number.MAX_SAFE_INTEGER, "status runtime observation.tick");
    const phase = checkedPhase(checked.phase);
    const sources = boundedArray(checked.sources, "status runtime observation.sources",
      SESSION_TROOP_STATUS_RUNTIME_MAX_SOURCES).map(checkedSource);
    if (new Set(sources.map(({ sourceId }) => sourceId)).size !== sources.length) {
      throw new TypeError("status runtime observation source IDs must be unique");
    }
    const sourceById = new Map(sources.map((source) => [source.sourceId, source]));
    const commands = boundedArray(checked.commands, "status runtime observation.commands",
      SESSION_TROOP_STATUS_RUNTIME_MAX_COMMANDS).map((command, index) =>
      checkedCommand(command, tick, index));
    const targets = boundedArray(checked.targets, "status runtime observation.targets",
      SESSION_TROOP_STATUS_RUNTIME_MAX_COMMANDS).map(checkedTarget);
    if (targets.length !== commands.length) {
      throw new TypeError("status runtime observation targets must align with commands");
    }
    const commandIdentities = new Set(commands.map(({ commandId, side }) =>
      `${side}:${commandId}`));
    if (commandIdentities.size !== commands.length) {
      throw new TypeError("status runtime observation command identities must be unique");
    }
    const intents = commands.map((command, index) => {
      const source = sourceById.get(command.sourceId);
      if (source === undefined || source.cardId === undefined || source.side !== command.side) {
        throw new RangeError("status runtime command source is not admitted");
      }
      if (source.cardId === "aegis-sage" || source.cardId === "railward") {
        throw new RangeError(`status ${source.cardId} remains an explicit QUESTION (${source.cardId === "aegis-sage" ? "reflection composition" : "shield/form"})`);
      }
      if (checked.phase !== "pre-move") throw new TypeError("status runtime command phase is not canonical");
      const resolved = this.inspect({
        actionId: command.actionId,
        cardId: source.cardId,
        sourceId: command.sourceId,
        targetId: command.targetId,
      });
      if (command.actionId !== "hide" && command.actionId !== "reveal" && command.targetId === null) {
        throw new RangeError("status runtime command target is an explicit QUESTION");
      }
      const target = targets[index];
      if (command.targetId === null) {
        if (target !== null) {
          throw new TypeError("status runtime command target witness is noncanonical");
        }
      } else if (target === null || target.id !== command.targetId) {
        throw new RangeError("status runtime command target witness is stale");
      }
      return {
        actionId: command.actionId,
        cardId: source.cardId,
        commandId: command.commandId,
        effect: resolved.effect,
        parameters: resolved.parameters,
        phase,
        side: command.side,
        sourceId: command.sourceId,
        targetId: command.targetId,
        tick,
        type: "troop-status-intent",
      };
    });
    return freeze(intents.sort((left, right) =>
      left.commandId - right.commandId || left.sourceId - right.sourceId));
  }
}
