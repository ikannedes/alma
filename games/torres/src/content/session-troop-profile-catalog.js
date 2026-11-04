import * as content from "./index.js";
import { assertSafeCardCatalogGraph } from "./schema.js";
import { createSessionCardManifest } from "./session-card-catalog.js";
import { assertAuthoritativeProjectileSourceCatalogs } from "./session-troop-projectile-source-admission.js";

const VERSION = 1;
const QUESTION_REASON =
  "identity-only claim lacks sourced kind/cost/deploy admission fields";
const UNIT_QUESTION_CLASSIFICATIONS = Object.freeze([
  Object.freeze({ exportName: "DEATH_SPAWN_IDENTITY", id: "ashen-nest" }),
  Object.freeze({ exportName: "DEATH_CONVERSION_IDENTITY", id: "gloam-shepherd" }),
]);
const EXPECTED_COUNTS = Object.freeze({
  admittedIds: 41,
  admittedOccurrences: 43,
  claimedIds: 43,
  claimedOccurrences: 45,
  duplicateCompositionIds: 2,
  questionIds: 2,
  questionOccurrences: 2,
});
const EXPECTED_COMPOSITIONS = Object.freeze([
  Object.freeze({
    id: "aegis-sage",
    claims: Object.freeze([
      Object.freeze({
        claimFamily: "champion-ability",
        exportName: "createChampionAbilityCatalog",
      }),
      Object.freeze({
        claimFamily: "reflection-special",
        exportName: "createReflectionSpecialCatalog",
      }),
    ]),
  }),
  Object.freeze({
    id: "emberlance",
    claims: Object.freeze([
      Object.freeze({
        claimFamily: "charge-knockback",
        exportName: "createChargeKnockbackCatalog",
      }),
      Object.freeze({
        claimFamily: "charge-special",
        exportName: "createChargeSpecialCatalog",
      }),
    ]),
  }),
]);
const EXECUTION_QUESTION_FIELDS = Object.freeze([
  "abilityCost",
  "cancellation",
  "damage",
  "mechanicOrdering",
  "phaseTiming",
  "radius",
  "runtimeComposition",
  "targeting",
]);

function clone(value) {
  return structuredClone(value);
}

function freeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareOccurrences(left, right) {
  return compareText(left.id, right.id) || compareText(left.exportName, right.exportName);
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonical(value[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sourceRecords(exportName, authoritative = null) {
  if (authoritative !== null && Object.hasOwn(authoritative, exportName)) {
    return authoritative[exportName];
  }
  if (!Object.hasOwn(content, exportName)) {
    throw new Error(`session troop source export ${exportName} is missing`);
  }
  const value = content[exportName];
  const records = typeof value === "function"
    ? assertSafeCardCatalogGraph(value(), `${exportName} source catalog`)
    : Array.isArray(value)
    ? value
    : value !== null && typeof value === "object" && typeof value.id === "string"
    ? [value]
    : value !== null && typeof value === "object"
    ? Object.values(value)
    : null;
  if (!Array.isArray(records)) {
    throw new TypeError(`${exportName} does not provide source records`);
  }
  return records;
}

function sourceRecordFor(exportName, id, authoritative = null) {
  const matches = sourceRecords(exportName, authoritative).filter((record) =>
    record !== null && typeof record === "object" && record.id === id
  );
  if (matches.length !== 1) {
    throw new Error(`${exportName}/${id} does not provide exactly one source record`);
  }
  return matches[0];
}

function isCompleteUnitAdmissionRecord(record, id) {
  return record !== null &&
    typeof record === "object" &&
    !Array.isArray(record) &&
    record.id === id &&
    typeof record.displayName === "string" &&
    record.displayName.length > 0 &&
    record.kind === "unit" &&
    Number.isSafeInteger(record.cost) &&
    record.cost >= 1 &&
    record.cost <= 10 &&
    Number.isSafeInteger(record.deployTimeTicks) &&
    record.deployTimeTicks >= 0;
}

function unitAdmissionIdentity(record, exportName, id) {
  if (!isCompleteUnitAdmissionRecord(record, id)) {
    throw new TypeError(`${exportName}/${id} does not provide a complete unit admission record`);
  }
  return {
    cost: record.cost,
    deployTimeTicks: record.deployTimeTicks,
    displayName: record.displayName,
    id,
    kind: "unit",
    placementClass: "ground_entity",
  };
}

function cardAdmissionIdentity(card, id) {
  if (card === undefined || card.id !== id || card.kind !== "unit") {
    throw new Error(`session troop card ${id} is not an admitted unit`);
  }
  return {
    cost: card.cost,
    deployTimeTicks: card.deployTimeTicks,
    displayName: card.displayName,
    id: card.id,
    kind: card.kind,
    placementClass: card.placementClass,
  };
}

function assertExpectedCounts(counts) {
  if (canonical(counts) !== canonical(EXPECTED_COUNTS)) {
    throw new Error(
      `session troop profile counts diverge: expected=${canonical(EXPECTED_COUNTS)} actual=${canonical(counts)}`
    );
  }
}

function assertUniqueOccurrencePairs(occurrences, label) {
  const keys = occurrences.map(({ exportName, id }) => `${exportName}\u0000${id}`);
  if (new Set(keys).size !== keys.length) {
    throw new Error(`${label} contains a duplicate occurrence pair`);
  }
}

function assertQuestionClassification(cardManifest, questionRows, authoritative = null) {
  const allRows = cardManifest.occurrences;
  for (const classification of UNIT_QUESTION_CLASSIFICATIONS) {
    const rows = allRows.filter(({ exportName, id }) =>
      exportName === classification.exportName && id === classification.id
    );
    if (rows.length !== 1 || rows[0].status !== "question" ||
        rows[0].reason !== QUESTION_REASON) {
      throw new Error(
        `${classification.exportName}/${classification.id} no longer has its explicit QUESTION pin`
      );
    }
    if (cardManifest.cards.some(({ id }) => id === classification.id)) {
      throw new Error(`${classification.id} became an admitted session card; update its QUESTION pin`);
    }
    const record = sourceRecordFor(classification.exportName, classification.id, authoritative);
    if (isCompleteUnitAdmissionRecord(record, classification.id)) {
      throw new Error(`${classification.id} gained a complete unit admission record; update its QUESTION pin`);
    }
  }

  const expectedQuestions = UNIT_QUESTION_CLASSIFICATIONS.map(({ exportName, id }) =>
    ({ exportName, id, reason: QUESTION_REASON, status: "question" })
  ).sort(compareOccurrences);
  if (canonical(questionRows) !== canonical(expectedQuestions)) {
    throw new Error("session troop QUESTION rows diverge from the explicit unit classification");
  }
}

function assertDerivedTroopSurface(cardManifest, authoritative = null) {
  if (!Array.isArray(cardManifest.cards) || !Array.isArray(cardManifest.occurrences)) {
    throw new TypeError("session card manifest has no canonical card occurrence surface");
  }
  const unitIds = new Set(cardManifest.cards
    .filter(({ kind }) => kind === "unit")
    .map(({ id }) => id));
  const questionIds = new Set(UNIT_QUESTION_CLASSIFICATIONS.map(({ id }) => id));
  const derived = cardManifest.occurrences.filter(({ id }) =>
    unitIds.has(id) || questionIds.has(id)
  );
  assertUniqueOccurrencePairs(derived, "derived troop occurrence surface");

  const admitted = derived.filter(({ status }) => status === "admitted");
  const questions = derived.filter(({ status }) => status === "question")
    .map(({ exportName, id, reason, status }) => ({ exportName, id, reason, status }))
    .sort(compareOccurrences);
  assertQuestionClassification(cardManifest, questions, authoritative);

  for (const card of cardManifest.cards.filter(({ kind }) => kind === "unit")) {
    const exports = admitted.filter(({ id }) => id === card.id)
      .map(({ exportName }) => exportName)
      .sort(compareText);
    if (canonical(card.occurrenceExports) !== canonical(exports)) {
      throw new Error(`session card manifest occurrence exports for ${card.id} are stale`);
    }
  }

  const expectedCounts = {
    admittedIds: unitIds.size,
    admittedOccurrences: admitted.length,
    claimedIds: new Set(derived.map(({ id }) => id)).size,
    claimedOccurrences: derived.length,
    duplicateCompositionIds: cardManifest.cards.filter(({ kind, occurrenceExports }) =>
      kind === "unit" && occurrenceExports.length > 1
    ).length,
    questionIds: new Set(questions.map(({ id }) => id)).size,
    questionOccurrences: questions.length,
  };

  // The duplicate count is a property of the derived occurrence surface, not
  // a second roster list. Count each admitted ID whose source exports are
  // intentionally duplicated.
  assertExpectedCounts(expectedCounts);

  const occurrences = derived.map(({ exportName, id, status, reason }) =>
    status === "question"
      ? { exportName, id, reason, status }
      : { exportName, id, status }
  ).sort(compareOccurrences);
  const count = {
    ...expectedCounts,
    claimedOccurrences: occurrences.length,
  };
  return { admitted, count, occurrences, questions, unitIds };
}

function buildProfiles(cardManifest, admittedOccurrences, unitIds, authoritative = null) {
  const sourceIdentities = new Map();
  const occurrenceExports = new Map();
  for (const { exportName, id } of admittedOccurrences) {
    const record = sourceRecordFor(exportName, id, authoritative);
    const identity = unitAdmissionIdentity(record, exportName, id);
    const prior = sourceIdentities.get(id);
    if (prior !== undefined && canonical(prior) !== canonical(identity)) {
      throw new Error(`shared session troop identity ${id} has divergent admission records`);
    }
    sourceIdentities.set(id, identity);
    if (!occurrenceExports.has(id)) occurrenceExports.set(id, []);
    occurrenceExports.get(id).push(exportName);
  }

  const profiles = [...unitIds].map((id) => {
    const card = cardManifest.cards.find((candidate) => candidate.id === id);
    const manifestIdentity = cardAdmissionIdentity(card, id);
    const sourceIdentity = sourceIdentities.get(id);
    if (sourceIdentity === undefined || canonical(sourceIdentity) !== canonical(manifestIdentity)) {
      throw new Error(`session troop profile ${id} diverges from its source-backed admission identity`);
    }
    const exports = [...new Set(occurrenceExports.get(id) ?? [])].sort(compareText);
    if (exports.length === 0) throw new Error(`session troop profile ${id} has no occurrence export`);
    return { ...sourceIdentity, occurrenceExports: exports };
  }).sort((left, right) => compareText(left.id, right.id));

  if (profiles.length !== unitIds.size || new Set(profiles.map(({ id }) => id)).size !== profiles.length) {
    throw new Error("session troop profiles must be one-per-admitted-ID");
  }
  return profiles;
}

function buildComposition(id, claims, profiles) {
  const profile = profiles.find((candidate) => candidate.id === id);
  if (profile === undefined) throw new Error(`composition ${id} has no admitted troop profile`);
  const occurrenceExports = claims.map(({ exportName }) => exportName).sort(compareText);
  if (canonical(profile.occurrenceExports) !== canonical(occurrenceExports)) {
    throw new Error(`composition ${id} does not own exactly its duplicated occurrence exports`);
  }
  return {
    claims: claims.map(({ claimFamily, exportName }) => ({ claimFamily, exportName }))
      .sort((left, right) => compareText(left.exportName, right.exportName)),
    id,
    mode: "one-shared-session-profile-membership-only",
    occurrenceExports,
    questions: EXECUTION_QUESTION_FIELDS.map((field) => ({
      field,
      reason: "shared occurrence membership does not source this execution fact",
      status: "question",
    })),
  };
}

function buildManifest() {
  const authoritative = assertAuthoritativeProjectileSourceCatalogs();
  const cardManifest = createSessionCardManifest();
  const { admitted, count, occurrences, questions, unitIds } =
    assertDerivedTroopSurface(cardManifest, authoritative);
  const profiles = buildProfiles(cardManifest, admitted, unitIds, authoritative);
  const duplicateProfiles = profiles.filter(({ occurrenceExports }) => occurrenceExports.length > 1);
  const duplicateIds = duplicateProfiles.map(({ id }) => id).sort(compareText);
  const expectedDuplicateIds = EXPECTED_COMPOSITIONS.map(({ id }) => id).sort(compareText);
  if (canonical(duplicateIds) !== canonical(expectedDuplicateIds)) {
    throw new Error("session troop duplicate composition IDs diverge from the source surface");
  }
  const compositions = EXPECTED_COMPOSITIONS
    .map(({ id, claims }) => buildComposition(id, claims, profiles))
    .sort((left, right) => compareText(left.id, right.id));
  const compositionMembers = compositions.flatMap(({ id, occurrenceExports }) =>
    occurrenceExports.map((exportName) => `${exportName}\u0000${id}`)
  );
  if (new Set(compositionMembers).size !== compositionMembers.length ||
      compositionMembers.length !== duplicateProfiles.reduce(
        (total, { occurrenceExports }) => total + occurrenceExports.length, 0
      )) {
    throw new Error("session troop composition membership is not bijective");
  }

  const manifest = {
    compositions,
    counts: {
      admittedIds: count.admittedIds,
      admittedOccurrences: count.admittedOccurrences,
      claimedIds: count.claimedIds,
      claimedOccurrences: count.claimedOccurrences,
      duplicateCompositionIds: compositions.length,
      questionIds: count.questionIds,
      questionOccurrences: count.questionOccurrences,
    },
    occurrences,
    profiles,
    questions,
    version: VERSION,
  };
  assertExpectedCounts(manifest.counts);
  return freeze(manifest);
}

const MANIFEST = buildManifest();

function assertNoArguments(args, label) {
  if (args.length !== 0) throw new TypeError(`${label} takes no arguments`);
}

export function createSessionTroopProfileManifest(...args) {
  assertNoArguments(args, "session troop profile manifest");
  return freeze(clone(MANIFEST));
}

export function serializeSessionTroopProfileManifest(...args) {
  assertNoArguments(args, "session troop profile manifest serialization");
  return canonical(MANIFEST);
}

export function getSessionTroopProfile(id, ...args) {
  if (args.length !== 0) throw new TypeError("session troop profile lookup takes exactly one argument");
  if (typeof id !== "string") throw new TypeError("session troop profile ID must be a primitive string");
  const question = MANIFEST.questions.find((entry) => entry.id === id);
  if (question !== undefined) {
    throw new RangeError(`session troop profile ${id} remains an explicit QUESTION`);
  }
  const profile = MANIFEST.profiles.find((entry) => entry.id === id);
  if (profile === undefined) throw new RangeError("session troop profile ID is unknown or not admitted");
  return freeze(clone(profile));
}

export function getSessionTroopOccurrence(exportName, id, ...args) {
  if (args.length !== 0) throw new TypeError("session troop occurrence lookup takes exactly two arguments");
  if (typeof exportName !== "string" || typeof id !== "string") {
    throw new TypeError("session troop occurrence export and ID must be primitive strings");
  }
  const occurrence = MANIFEST.occurrences.find((entry) =>
    entry.exportName === exportName && entry.id === id
  );
  if (occurrence === undefined) throw new RangeError("session troop occurrence is unknown");
  return freeze(clone(occurrence));
}
