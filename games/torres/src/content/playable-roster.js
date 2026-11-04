import { createBasicMeleeCatalog } from "./cards/basic-melee.js";
import { assertAuthoritativeProjectileSourceCatalogs } from "./session-troop-projectile-source-admission.js";
import {
  encodeSessionTroopSourceConfidenceValue,
  getSessionTroopSourceConfidencePolicy,
} from "../shared/session-troop-source-confidence-authority.js";

export const PLAYABLE_CARD_IDS = Object.freeze([
  "coilblade",
  "mossguard",
  "copperskiff",
  "skymaul",
  "brassbolt",
  "reedsting",
  "briar-band",
  "cinderlings",
]);

const QUESTION_SOURCE = "runtime-playability-estimate-not-comparison-corpus";
const QUESTION_VALUES = Object.freeze({
  "briar-darter.body-radius-millitiles": 300,
  "briar-darter.projectile-speed-millitiles-per-tick": 500,
  "briar-runner.body-radius-millitiles": 300,
  "brassbolt.body-radius-millitiles": 400,
  "brassbolt.projectile-speed-millitiles-per-tick": 500,
  "cinderling.body-radius-millitiles": 250,
  "coilblade.body-radius-millitiles": 500,
  "copperskiff.body-radius-millitiles": 500,
  "copperskiff.projectile-speed-millitiles-per-tick": 500,
  "mossguard.body-radius-millitiles": 500,
  "reedsting.body-radius-millitiles": 300,
  "reedsting.projectile-speed-millitiles-per-tick": 500,
  "skymaul.body-radius-millitiles": 500,
});

const LAYERS = Object.freeze({
  copperskiff: "air",
  skymaul: "air",
});

const PROJECTILE_ARCHETYPES = new Set([
  "brassbolt",
  "briar-darter",
  "copperskiff",
  "reedsting",
]);
const POLICY_KEYS = Object.freeze(["kind", "questionKey"]);
const QUESTION_RECORD_KEYS = Object.freeze([
  "authoritative",
  "confidence",
  "disposition",
  "key",
  "source",
  "value",
]);

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function clone(value) {
  return structuredClone(value);
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

function exactDataRecord(value, keys, label) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new TypeError(`${label} must be a plain data record`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const actual = Reflect.ownKeys(descriptors);
  if (
    actual.length !== keys.length ||
    actual.some((key) => (
      typeof key !== "string" ||
      !keys.includes(key) ||
      !descriptors[key].enumerable ||
      !Object.hasOwn(descriptors[key], "value")
    ))
  ) {
    throw new TypeError(`${label} must contain only exact enumerable data properties`);
  }
  return Object.fromEntries(keys.map((key) => [key, descriptors[key].value]));
}

function denseDataArray(value, expectedLength, label) {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype
  ) {
    throw new TypeError(`${label} must be a plain array`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const actual = Reflect.ownKeys(descriptors);
  const lengthDescriptor = descriptors.length;
  if (
    actual.length !== expectedLength + 1 ||
    !lengthDescriptor ||
    !Object.hasOwn(lengthDescriptor, "value") ||
    lengthDescriptor.enumerable ||
    lengthDescriptor.value !== expectedLength
  ) {
    throw new TypeError(`${label} must be one exact dense data array`);
  }
  const result = [];
  for (let index = 0; index < expectedLength; index += 1) {
    const descriptor = descriptors[index];
    if (
      !descriptor?.enumerable ||
      !Object.hasOwn(descriptor, "value")
    ) {
      throw new TypeError(`${label} must contain only dense data elements`);
    }
    result.push(descriptor.value);
  }
  return result;
}

function checkedQuestionRecord(value, index) {
  const label = `playable roster question ${index}`;
  const record = exactDataRecord(value, QUESTION_RECORD_KEYS, label);
  if (record.authoritative !== false) {
    throw new TypeError(`${label}.authoritative must be false`);
  }
  if (record.confidence !== "unverified") {
    throw new TypeError(`${label}.confidence must be unverified`);
  }
  if (record.disposition !== "question") {
    throw new TypeError(`${label}.disposition must be question`);
  }
  if (typeof record.key !== "string") {
    throw new TypeError(`${label}.key must be a primitive string`);
  }
  if (record.source !== QUESTION_SOURCE) {
    throw new TypeError(`${label}.source must identify the runtime estimate source`);
  }
  if (!Number.isSafeInteger(record.value) || record.value < 1) {
    throw new TypeError(`${label}.value must be a positive safe integer`);
  }
  return record;
}

function sameQuestionRecord(left, right) {
  return QUESTION_RECORD_KEYS.every((key) => left[key] === right[key]);
}

function catalog() {
  const authoritative = assertAuthoritativeProjectileSourceCatalogs();
  const cards = [
    ...createBasicMeleeCatalog(),
    ...authoritative.createBasicFlyingCatalog,
    ...authoritative.createBasicRangedCatalog,
    ...authoritative.createSwarmCatalog,
  ];
  return new Map(cards.map((card) => [card.id, card]));
}

function checkedCardIds(value) {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length !== PLAYABLE_CARD_IDS.length ||
    Reflect.ownKeys(value).length !== value.length + 1
  ) {
    throw new TypeError("playable roster ids must be one dense plain eight-card array");
  }
  for (let index = 0; index < PLAYABLE_CARD_IDS.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (
      !descriptor?.enumerable ||
      !Object.hasOwn(descriptor, "value") ||
      descriptor.value !== PLAYABLE_CARD_IDS[index]
    ) {
      throw new TypeError("playable roster ids must exactly match the shell deck order");
    }
  }
  return [...PLAYABLE_CARD_IDS];
}

function questionKey(archetypeId, field) {
  return `${archetypeId}.${field}`;
}

function entityProjection(card, component) {
  const source = component ?? {
    ...card,
    id: card.id,
    role: "primary",
  };
  const archetypeId = source.id;
  const projectile = PROJECTILE_ARCHETYPES.has(archetypeId);
  const sourceConfidencePolicy = getSessionTroopSourceConfidencePolicy(card.id, archetypeId);
  return {
    archetypeId,
    areaDamageRadiusMillitiles: source.areaDamageRadiusMillitiles,
    bodyRadiusPolicy: {
      kind: "question",
      questionKey: questionKey(archetypeId, "body-radius-millitiles"),
    },
    count: source.count,
    damage: source.damage,
    delivery: projectile ? "projectile" : "melee",
    deployTimeTicks: source.deployTimeTicks,
    displayName: source.displayName,
    firstHitTicks: source.firstHitTicks,
    hitSpeedTicks: source.hitSpeedTicks,
    hitpoints: source.hitpoints,
    kind: source.kind,
    layer: LAYERS[archetypeId] ?? "ground",
    movementMillitilesPerSecond: source.movementMillitilesPerSecond,
    projectileSpeedPolicy: projectile
      ? {
        kind: "question",
        questionKey: questionKey(
          archetypeId,
          "projectile-speed-millitiles-per-tick",
        ),
      }
      : { kind: "not-applicable", questionKey: null },
    rangeMillitiles: source.rangeMillitiles,
    role: source.role,
    sightRangeMillitiles: source.sightRangeMillitiles,
    ...(sourceConfidencePolicy === null ? {} : { sourceConfidencePolicy }),
    targetMode: source.targetMode,
  };
}

function cardProjection(card) {
  const components = card.components.length === 0
    ? [entityProjection(card, null)]
    : card.components.map((component) => entityProjection(card, component));
  return {
    areaDamageRadiusMillitiles: card.areaDamageRadiusMillitiles,
    cost: card.cost,
    count: card.count,
    damage: card.damage,
    deployTimeTicks: card.deployTimeTicks,
    displayName: card.displayName,
    entities: components,
    firstHitTicks: card.firstHitTicks,
    formation: {
      componentOrder: components.map(({ archetypeId }) => archetypeId),
      expansionOrder: "component-order-then-member-index",
      totalCount: components.reduce((sum, component) => sum + component.count, 0),
    },
    hitSpeedTicks: card.hitSpeedTicks,
    hitpoints: card.hitpoints,
    id: card.id,
    kind: card.kind,
    movementMillitilesPerSecond: card.movementMillitilesPerSecond,
    rangeMillitiles: card.rangeMillitiles,
    rarity: card.rarity,
    sightRangeMillitiles: card.sightRangeMillitiles,
    targetMode: card.targetMode,
  };
}

/**
 * Projects the exact eight-card browser shell deck into self-contained live
 * archetypes. Only existing catalog facts are copied here. Runtime-only sizes
 * and projectile speeds remain references to separately exposed QUESTIONs.
 */
export function createPlayableRoster(cardIds = PLAYABLE_CARD_IDS) {
  const checkedIds = checkedCardIds(cardIds);
  const byId = catalog();
  const cards = checkedIds.map((id) => {
    const card = byId.get(id);
    if (card === undefined) {
      throw new Error(`playable roster catalog is missing ${id}`);
    }
    return cardProjection(card);
  });
  return deepFreeze(cards);
}

/** Returns fresh recursively frozen non-authoritative runtime estimates. */
export function createPlayableRosterQuestionRecords(...args) {
  if (args.length !== 0) {
    throw new TypeError("playable roster question records take no arguments");
  }
  const estimateQuestions = Object.entries(QUESTION_VALUES).map(([key, value]) => ({
    authoritative: false,
    confidence: "unverified",
    disposition: "question",
    key,
    source: QUESTION_SOURCE,
    value,
  }));
  const sourceQuestions = createPlayableRoster().flatMap(({ entities }) => entities.flatMap((entity) =>
    (entity.sourceConfidencePolicy?.fields ?? []).map(({ field, questionKey, valueEncoding }) => ({
      authoritative: false,
      confidence: "unverified",
      disposition: "question",
      key: questionKey,
      source: QUESTION_SOURCE,
      value: encodeSessionTroopSourceConfidenceValue(valueEncoding, entity[field]),
    }))));
  return deepFreeze([...estimateQuestions, ...sourceQuestions]);
}

/** Canonical bytes for repeatability checks and future deterministic replay. */
export function serializePlayableRoster(...args) {
  if (args.length !== 0) {
    throw new TypeError("playable roster serialization takes no arguments");
  }
  return canonicalJson({
    cards: createPlayableRoster(),
    questions: createPlayableRosterQuestionRecords(),
    version: 1,
  });
}

/** Resolve a policy reference only at the live-runtime boundary. */
export function resolvePlayableRosterQuestion(policy, questions) {
  const checkedPolicy = exactDataRecord(
    policy,
    POLICY_KEYS,
    "playable roster policy",
  );
  if (
    checkedPolicy.kind !== "question" ||
    typeof checkedPolicy.questionKey !== "string"
  ) {
    throw new TypeError("playable roster policy must be an exact question reference");
  }

  const canonicalQuestions = createPlayableRosterQuestionRecords();
  const checkedQuestions = denseDataArray(
    questions,
    canonicalQuestions.length,
    "playable roster questions",
  ).map(checkedQuestionRecord);
  for (let index = 0; index < canonicalQuestions.length; index += 1) {
    if (!sameQuestionRecord(checkedQuestions[index], canonicalQuestions[index])) {
      throw new TypeError("playable roster questions must exactly match the canonical set");
    }
  }
  const canonical = canonicalQuestions.find(
    ({ key }) => key === checkedPolicy.questionKey,
  );
  if (canonical === undefined) {
    throw new TypeError("playable roster policy must resolve exactly one question");
  }
  return clone(canonical).value;
}
