import {
  assertSessionTroopProjectileAuthorityReceipt,
} from "../shared/session-troop-projectile-authority.js";

/**
 * Shared projectile-mechanic continuation for the admitted troop projectile
 * receipt.
 *
 * This module deliberately does not simulate combat.  BattleTowerCombat is
 * the only owner of the host clock, projectile IDs, unit/tower health and
 * combat transcript.  This reducer only records projectile-mechanic
 * continuation facts that are already minted by that host and refuses a
 * mechanic as soon as it would need a frozen QUESTION value.
 */

export const SESSION_TROOP_PROJECTILE_RUNTIME_VERSION = 1;
export const SESSION_TROOP_PROJECTILE_RUNTIME_MAX_PROFILES = 8;
export const SESSION_TROOP_PROJECTILE_RUNTIME_MAX_SOURCES = 1_024;
export const SESSION_TROOP_PROJECTILE_RUNTIME_MAX_PENDING = 1_024;
export const SESSION_TROOP_PROJECTILE_RUNTIME_MAX_HISTORY = 4_096;
export const SESSION_TROOP_PROJECTILE_RUNTIME_MAX_BYTES = 262_144;

const PROFILE_IDS = new Set([
  "aegis-sage",
  "prism-warden",
  "rune-reaver",
  "scatterguard",
  "stormkite",
]);
const CLAIM_FAMILIES = new Set([
  "chain", "ordinary-component-projectile", "ordinary-single-projectile", "pierce",
  "return", "pellets", "reflection",
]);
const SOURCE_CARD_KEYS = [
  "areaDamageRadiusMillitiles", "components", "cost", "count", "damage",
  "deployTimeTicks", "displayName", "firstHitTicks", "hitSpeedTicks", "hitpoints",
  "id", "kind", "movementMillitilesPerSecond", "rangeMillitiles", "rarity",
  "sightRangeMillitiles", "targetMode",
];
const SOURCE_COMPONENT_KEYS = [
  "areaDamageRadiusMillitiles", "count", "damage", "deployTimeTicks", "displayName",
  "firstHitTicks", "hitSpeedTicks", "hitpoints", "id", "kind",
  "movementMillitilesPerSecond", "rangeMillitiles", "role", "sightRangeMillitiles",
  "targetMode",
];
const ROSTER_CARD_KEYS = [
  "areaDamageRadiusMillitiles", "cost", "count", "damage", "deployTimeTicks",
  "displayName", "entities", "firstHitTicks", "formation", "hitSpeedTicks",
  "hitpoints", "id", "kind", "movementMillitilesPerSecond", "rangeMillitiles",
  "rarity", "sightRangeMillitiles", "targetMode",
];
const RUNTIME_SNAPSHOT_KEYS = ["configuration", "history", "pending", "version"];
const MECHANIC_COMMAND_KEYS = ["cardId", "sourceId", "targetId", "tick", "type"];
const HOST_SOURCE_KEYS = [
  "cardId", "damage", "delivery", "layer", "maxHealth", "projectileSpeed",
  "rangeMillitiles", "sightRangeMillitiles", "side", "sourceId", "targetMode",
];
const PROJECTILE_IDENTITY_KEYS = ["attackSequence", "direction", "projectileId", "sourceId"];
const PROJECTILE_DIRECTIONS = new Set(["unit-to-tower", "unit-to-unit"]);
const EVENT_TYPES = new Set([
  "projectile-impact", "projectile-launch", "damage", "death",
]);
const EVENT_ORDER = new Map([
  ["projectile-launch", 0],
  ["projectile-impact", 1],
  ["damage", 2],
  ["death", 3],
]);
const internalProjectilePlans = new WeakSet();

function clone(value) {
  return structuredClone(value);
}

function freeze(value, seen = new WeakSet()) {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) freeze(child, seen);
  return Object.freeze(value);
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new TypeError("projectile runtime data cannot contain undefined");
  return encoded;
}

function exact(value, keys, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype &&
       Object.getPrototypeOf(value) !== null)) {
    throw new TypeError(`${label} must be a plain object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const actual = Reflect.ownKeys(descriptors).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length ||
      actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${label} has an invalid shape`);
  }
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
      throw new TypeError(`${label}.${key} must be an enumerable data property`);
    }
  }
  return Object.fromEntries(keys.map((key) => [key, descriptors[key].value]));
}

function dense(value, maximum, label) {
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

function text(value, label, maximum = 256) {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum ||
      value.normalize("NFC") !== value || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`${label} must be bounded normalized text`);
  }
  return value;
}

function safeGraph(value, label) {
  const pending = [{ depth: 0, value }];
  let nodes = 0;
  while (pending.length > 0) {
    const { depth, value: entry } = pending.pop();
    nodes += 1;
    if (nodes > 20_000 || depth > 32) throw new RangeError(`${label} graph bound exceeded`);
    if (typeof entry === "string") {
      text(entry, label, 1_048_576);
      continue;
    }
    if (typeof entry === "number") {
      if (!Number.isFinite(entry)) throw new TypeError(`${label} numbers must be finite`);
      continue;
    }
    if (entry === null || typeof entry === "boolean") continue;
    if (typeof entry !== "object") throw new TypeError(`${label} contains invalid data`);
    const keys = Array.isArray(entry) ? Object.keys(entry) : Object.keys(entry);
    if (keys.length > 1_024) throw new RangeError(`${label} member bound exceeded`);
    for (const child of Array.isArray(entry) ? entry : Object.values(entry)) {
      pending.push({ depth: depth + 1, value: child });
    }
  }
}

function parseCanonical(serialized, label, maximum = SESSION_TROOP_PROJECTILE_RUNTIME_MAX_BYTES) {
  if (typeof serialized !== "string") throw new TypeError(`${label} must be canonical JSON text`);
  if (new TextEncoder().encode(serialized).byteLength > maximum) {
    throw new RangeError(`${label} exceeds its byte bound`);
  }
  let value;
  try { value = JSON.parse(serialized); }
  catch { throw new TypeError(`${label} must be valid JSON`); }
  safeGraph(value, label);
  if (canonical(value) !== serialized) throw new TypeError(`${label} must be canonical JSON`);
  return value;
}

function sourceComponentFromEntity(entity) {
  const value = Object.fromEntries(SOURCE_COMPONENT_KEYS.map((key) => [key,
    key === "id" ? entity.archetypeId : entity[key]]));
  return value;
}

function rosterSourceCard(card, label) {
  const checked = exact(card, ROSTER_CARD_KEYS, label);
  if (checked.kind !== "unit") throw new TypeError(`${label} must be a unit card`);
  const components = checked.formation.totalCount === 0 ? [] : checked.entities.length === 1 &&
    checked.entities[0].archetypeId === checked.id && checked.entities[0].count === checked.count
    ? [] : checked.entities.map(sourceComponentFromEntity);
  return {
    areaDamageRadiusMillitiles: checked.areaDamageRadiusMillitiles,
    components,
    cost: checked.cost,
    count: checked.count,
    damage: checked.damage,
    deployTimeTicks: checked.deployTimeTicks,
    displayName: checked.displayName,
    firstHitTicks: checked.firstHitTicks,
    hitSpeedTicks: checked.hitSpeedTicks,
    hitpoints: checked.hitpoints,
    id: checked.id,
    kind: checked.kind,
    movementMillitilesPerSecond: checked.movementMillitilesPerSecond,
    rangeMillitiles: checked.rangeMillitiles,
    rarity: checked.rarity,
    sightRangeMillitiles: checked.sightRangeMillitiles,
    targetMode: checked.targetMode,
  };
}

function checkedIdentity(value, label) {
  const identity = exact(value, PROJECTILE_IDENTITY_KEYS, label);
  const direction = text(identity.direction, `${label}.direction`);
  if (!PROJECTILE_DIRECTIONS.has(direction)) throw new TypeError(`${label}.direction is invalid`);
  return {
    attackSequence: integer(identity.attackSequence, 1, Number.MAX_SAFE_INTEGER,
      `${label}.attackSequence`),
    direction,
    projectileId: integer(identity.projectileId, 1, Number.MAX_SAFE_INTEGER,
      `${label}.projectileId`),
    sourceId: integer(identity.sourceId, 1, Number.MAX_SAFE_INTEGER, `${label}.sourceId`),
  };
}

function identityKey(identity) {
  return canonical(identity);
}

function checkedQuestionRecord(value, key, label) {
  const record = exact(value,
    ["authoritative", "confidence", "disposition", "source", "value"], label);
  if (record.authoritative !== false || record.disposition !== "question") {
    throw new TypeError(`${label} must remain an explicit QUESTION`);
  }
  return {
    authoritative: false,
    confidence: text(record.confidence, `${label}.confidence`),
    disposition: "question",
    key: text(key, `${label}.key`),
    source: text(record.source, `${label}.source`),
    value: clone(record.value),
  };
}

function claimFor(profile, label) {
  if (!PROFILE_IDS.has(profile.id)) throw new TypeError(`${label}.id is not admitted`);
  if (!Array.isArray(profile.claims) || profile.claims.length !== 1) {
    throw new TypeError(`${label}.claims must contain one projectile claim`);
  }
  const claim = profile.claims[0];
  if (!CLAIM_FAMILIES.has(claim.claimFamily) || claim.archetype !== profile.id ||
      claim.component !== null || claim.delivery?.classification !== "sourced" ||
      claim.delivery?.delivery !== "projectile") {
    throw new TypeError(`${label}.claims[0] is not a sourced projectile claim`);
  }
  const questions = Object.fromEntries(Object.entries(claim.questions).map(([key, record]) =>
    [key, checkedQuestionRecord(record, key, `${label}.claims[0].questions.${key}`)]));
  return {
    claimFamily: claim.claimFamily,
    questions,
    source: clone(claim.source),
  };
}

function checkedPlan(value) {
  if (!internalProjectilePlans.has(value)) {
    throw new TypeError("projectile runtime requires a private admitted host plan");
  }
  const plan = exact(value, ["configuration", "profiles", "questions"],
    "projectile runtime host plan");
  const configuration = parseCanonical(plan.configuration, "projectile runtime host configuration");
  const profiles = dense(plan.profiles, SESSION_TROOP_PROJECTILE_RUNTIME_MAX_PROFILES,
    "projectile runtime host profiles").map((profile, index) => {
    const checked = exact(profile, ["claimFamily", "id", "questions", "sourceCard"],
      `projectile runtime host profile[${index}]`);
    if (!PROFILE_IDS.has(checked.id) || !CLAIM_FAMILIES.has(checked.claimFamily)) {
      throw new TypeError(`projectile runtime host profile[${index}] identity is invalid`);
    }
    const questions = exact(checked.questions, Object.keys(checked.questions),
      `projectile runtime host profile[${index}].questions`);
    const checkedQuestions = Object.fromEntries(Object.entries(questions).map(([key, record]) =>
      [key, checkedQuestionRecord(record, key,
        `projectile runtime host profile[${index}].questions.${key}`)]));
    checkedSourceCard(checked.sourceCard,
      `projectile runtime host profile[${index}].sourceCard`);
    return {
      claimFamily: checked.claimFamily,
      id: checked.id,
      questions: checkedQuestions,
      sourceCard: clone(checked.sourceCard),
    };
  }).sort((left, right) => left.id.localeCompare(right.id));
  const questions = dense(plan.questions, SESSION_TROOP_PROJECTILE_RUNTIME_MAX_PROFILES * 4,
    "projectile runtime host questions").map((dependency, index) => {
    const checked = exact(dependency, ["cardId", "claimFamily", "questions"],
      `projectile runtime host question[${index}]`);
    if (!CLAIM_FAMILIES.has(checked.claimFamily)) {
      throw new TypeError(`projectile runtime host question[${index}] claim family is invalid`);
    }
    const questionRecords = exact(checked.questions, Object.keys(checked.questions),
      `projectile runtime host question[${index}].questions`);
    return {
      cardId: text(checked.cardId, `projectile runtime host question[${index}].cardId`),
      claimFamily: checked.claimFamily,
      questions: Object.fromEntries(Object.entries(questionRecords).map(([key, record]) =>
        [key, checkedQuestionRecord(record, key,
          `projectile runtime host question[${index}].questions.${key}`)])),
    };
  }).sort((left, right) => left.cardId.localeCompare(right.cardId));
  if (profiles.length !== 5 || new Set(profiles.map(({ id }) => id)).size !== profiles.length ||
      canonical(profiles.map(({ id }) => id)) !== canonical([...PROFILE_IDS].sort()) ||
      new Set(questions.map(({ cardId }) => cardId)).size !== questions.length) {
    throw new TypeError("projectile runtime host plan is incomplete or duplicated");
  }
  return freeze({ bytes: plan.configuration, configuration, profiles, questions });
}

function checkedSourceCard(value, label) {
  const card = exact(value, SOURCE_CARD_KEYS, label);
  text(card.id, `${label}.id`);
  text(card.displayName, `${label}.displayName`);
  for (const field of ["cost", "count", "damage", "deployTimeTicks", "firstHitTicks",
    "hitSpeedTicks", "hitpoints", "movementMillitilesPerSecond", "rangeMillitiles",
    "sightRangeMillitiles"]) {
    integer(card[field], 0, Number.MAX_SAFE_INTEGER, `${label}.${field}`);
  }
  if (card.kind !== "unit") throw new TypeError(`${label}.kind must be unit`);
  text(card.rarity, `${label}.rarity`);
  text(card.targetMode, `${label}.targetMode`);
  if (card.areaDamageRadiusMillitiles !== null) {
    integer(card.areaDamageRadiusMillitiles, 0, Number.MAX_SAFE_INTEGER,
      `${label}.areaDamageRadiusMillitiles`);
  }
  dense(card.components, 16, `${label}.components`).forEach((component, index) => {
    const checked = exact(component, SOURCE_COMPONENT_KEYS, `${label}.components[${index}]`);
    text(checked.id, `${label}.components[${index}].id`);
    text(checked.displayName, `${label}.components[${index}].displayName`);
    for (const field of ["count", "damage", "deployTimeTicks", "firstHitTicks",
      "hitSpeedTicks", "hitpoints", "movementMillitilesPerSecond", "rangeMillitiles",
      "sightRangeMillitiles"]) {
      integer(checked[field], 0, Number.MAX_SAFE_INTEGER,
        `${label}.components[${index}].${field}`);
    }
    if (checked.kind !== "unit") {
      throw new TypeError(`${label}.components[${index}].kind must be unit`);
    }
    text(checked.role, `${label}.components[${index}].role`);
    text(checked.targetMode, `${label}.components[${index}].targetMode`);
    if (checked.areaDamageRadiusMillitiles !== null) {
      integer(checked.areaDamageRadiusMillitiles, 0, Number.MAX_SAFE_INTEGER,
        `${label}.components[${index}].areaDamageRadiusMillitiles`);
    }
  });
  return card;
}

function privatePlanFromReceipt(serialized) {
  assertSessionTroopProjectileAuthorityReceipt(serialized);
  let manifest;
  try { manifest = JSON.parse(serialized); }
  catch { throw new TypeError("projectile runtime authority receipt is invalid"); }
  const profiles = manifest.profiles.map((profile) => ({
    claimFamily: profile.claims[0].claimFamily,
    id: profile.id,
    questions: clone(profile.claims[0].questions),
    sourceCard: clone(profile.sourceCard),
  }));
  const questions = manifest.unresolvedDeliveryDependencies.flatMap((dependency) => {
    const dependencyQuestions = Object.fromEntries(Object.entries(dependency.questions).map(
      ([key, record]) => {
        const { key: _questionKey, ...withoutKey } = record;
        return [key, withoutKey];
      }));
    const base = {
      claimFamily: dependency.claimFamily,
      questions: dependencyQuestions,
    };
    return [
      { cardId: dependency.id, ...base },
      ...(dependency.component === null || dependency.component === undefined ? [] : [
        { cardId: dependency.component.id, ...base },
      ]),
    ];
  });
  return { configuration: serialized, profiles, questions };
}

function admitPlanFromReceipt(serialized) {
  const candidate = privatePlanFromReceipt(serialized);
  const checkedCandidate = exact(candidate, ["configuration", "profiles", "questions"],
    "projectile runtime admitted plan");
  const plan = freeze(clone(checkedCandidate));
  internalProjectilePlans.add(plan);
  checkedPlan(plan);
  return plan;
}

function checkedSource(value, index) {
  const source = exact(value, HOST_SOURCE_KEYS, `projectile runtime source[${index}]`);
  if (!(source.delivery === "projectile" || source.projectileSpeed === null)) {
    throw new TypeError(`projectile runtime source[${index}] delivery is invalid`);
  }
  return {
    cardId: text(source.cardId, `projectile runtime source[${index}].cardId`),
    damage: integer(source.damage, 0, Number.MAX_SAFE_INTEGER,
      `projectile runtime source[${index}].damage`),
    delivery: text(source.delivery, `projectile runtime source[${index}].delivery`),
    layer: text(source.layer, `projectile runtime source[${index}].layer`),
    maxHealth: integer(source.maxHealth, 1, Number.MAX_SAFE_INTEGER,
      `projectile runtime source[${index}].maxHealth`),
    projectileSpeed: source.projectileSpeed === null ? null : integer(source.projectileSpeed, 1,
      Number.MAX_SAFE_INTEGER, `projectile runtime source[${index}].projectileSpeed`),
    rangeMillitiles: integer(source.rangeMillitiles, 0, Number.MAX_SAFE_INTEGER,
      `projectile runtime source[${index}].rangeMillitiles`),
    sightRangeMillitiles: integer(source.sightRangeMillitiles, 0, Number.MAX_SAFE_INTEGER,
      `projectile runtime source[${index}].sightRangeMillitiles`),
    side: text(source.side, `projectile runtime source[${index}].side`),
    sourceId: integer(source.sourceId, 1, Number.MAX_SAFE_INTEGER,
      `projectile runtime source[${index}].sourceId`),
    targetMode: text(source.targetMode, `projectile runtime source[${index}].targetMode`),
  };
}

function eventPriority(event) {
  return EVENT_ORDER.get(event.type) ?? 99;
}

function eventIdentity(event, label) {
  if (event.projectileIdentity !== undefined) {
    if (event.projectileIdentity?.direction === "tower-to-unit") return null;
    return checkedIdentity(event.projectileIdentity, `${label}.projectileIdentity`);
  }
  if (event.projectile !== undefined && event.projectile?.projectileIdentity !== undefined) {
    if (event.projectile.projectileIdentity?.direction === "tower-to-unit") return null;
    return checkedIdentity(event.projectile.projectileIdentity, `${label}.projectile.projectileIdentity`);
  }
  return null;
}

function checkedEvent(value, index) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`projectile runtime event[${index}] must be an object`);
  }
  const type = value.type;
  if (!EVENT_TYPES.has(type)) return null;
  if (!Number.isSafeInteger(value.tick) || value.tick < 0) {
    throw new TypeError(`projectile runtime event[${index}].tick is invalid`);
  }
  const identity = eventIdentity(value, `projectile runtime event[${index}]`);
  if (identity === null) return null;
  const nestedTargetId = value.projectile !== undefined && value.projectile !== null &&
    Number.isSafeInteger(value.projectile.targetId) ? value.projectile.targetId : null;
  return {
    identity,
    status: typeof value.status === "string" ? value.status : null,
    targetId: Number.isSafeInteger(value.targetId) ? value.targetId : nestedTargetId,
    tick: value.tick,
    type,
  };
}

function questionKeys(profile) {
  return Object.keys(profile.questions).sort();
}

function questionWitness(profile, sourceId, targetId, tick, reason) {
  return {
    cardId: profile.id,
    claimFamily: profile.claimFamily,
    disposition: "question",
    questions: questionKeys(profile).map((key) => ({
      ...clone(profile.questions[key]),
      key,
    })),
    reason,
    sourceId,
    targetId,
    tick,
    type: "projectile-runtime-question",
  };
}

function checkedMechanicCommand(value) {
  const command = exact(value, MECHANIC_COMMAND_KEYS, "projectile mechanic command");
  if (command.type !== "projectile-mechanic") {
    throw new TypeError("projectile mechanic command.type is invalid");
  }
  return {
    cardId: text(command.cardId, "projectile mechanic command.cardId"),
    sourceId: integer(command.sourceId, 1, Number.MAX_SAFE_INTEGER,
      "projectile mechanic command.sourceId"),
    targetId: command.targetId === null ? null : integer(command.targetId, 1,
      Number.MAX_SAFE_INTEGER, "projectile mechanic command.targetId"),
    tick: integer(command.tick, 0, Number.MAX_SAFE_INTEGER, "projectile mechanic command.tick"),
    type: "projectile-mechanic",
  };
}

function checkedPending(value, index) {
  const pending = exact(value,
    ["cardId", "claimFamily", "identity", "launchTick", "targetId"],
    `projectile runtime pending[${index}]`);
  const identity = checkedIdentity(pending.identity, `projectile runtime pending[${index}].identity`);
  return {
    cardId: text(pending.cardId, `projectile runtime pending[${index}].cardId`),
    claimFamily: text(pending.claimFamily, `projectile runtime pending[${index}].claimFamily`),
    identity,
    launchTick: integer(pending.launchTick, 0, Number.MAX_SAFE_INTEGER,
      `projectile runtime pending[${index}].launchTick`),
    targetId: integer(pending.targetId, 1, Number.MAX_SAFE_INTEGER,
      `projectile runtime pending[${index}].targetId`),
  };
}

function checkedHistory(value, index) {
  const entry = exact(value,
    ["cardId", "claimFamily", "disposition", "identity", "reason", "status", "targetId",
      "tick", "type"],
    `projectile runtime history[${index}]`);
  const identity = checkedIdentity(entry.identity, `projectile runtime history[${index}].identity`);
  if (![
    "projectile-runtime-contact", "projectile-runtime-launch", "projectile-runtime-question",
  ].includes(entry.type)) throw new TypeError(`projectile runtime history[${index}].type is invalid`);
  if (![
    "contact", "launched", "question", "target_dead", "target_missing",
  ].includes(entry.status)) throw new TypeError(`projectile runtime history[${index}].status is invalid`);
  if ((entry.type === "projectile-runtime-launch" && entry.status !== "launched") ||
      (entry.type === "projectile-runtime-contact" &&
        !["contact", "target_dead", "target_missing"].includes(entry.status)) ||
      (entry.type === "projectile-runtime-question" && entry.status !== "question")) {
    throw new TypeError(`projectile runtime history[${index}] type and status diverge`);
  }
  if (!["sourced", "question"].includes(entry.disposition)) {
    throw new TypeError(`projectile runtime history[${index}].disposition is invalid`);
  }
  return {
    cardId: text(entry.cardId, `projectile runtime history[${index}].cardId`),
    claimFamily: text(entry.claimFamily, `projectile runtime history[${index}].claimFamily`),
    disposition: text(entry.disposition, `projectile runtime history[${index}].disposition`),
    identity,
    reason: entry.reason === null ? null : text(entry.reason,
      `projectile runtime history[${index}].reason`),
    status: entry.status,
    targetId: integer(entry.targetId, 1, Number.MAX_SAFE_INTEGER,
      `projectile runtime history[${index}].targetId`),
    tick: integer(entry.tick, 0, Number.MAX_SAFE_INTEGER,
      `projectile runtime history[${index}].tick`),
    type: entry.type,
  };
}

function checkedSnapshot(value) {
  const snapshot = exact(value, RUNTIME_SNAPSHOT_KEYS, "projectile runtime snapshot");
  if (snapshot.version !== SESSION_TROOP_PROJECTILE_RUNTIME_VERSION) {
    throw new TypeError("projectile runtime snapshot version is unsupported");
  }
  const configuration = parseCanonical(snapshot.configuration,
    "projectile runtime snapshot.configuration");
  const pending = dense(snapshot.pending, SESSION_TROOP_PROJECTILE_RUNTIME_MAX_PENDING,
    "projectile runtime snapshot.pending").map(checkedPending);
  const history = dense(snapshot.history, SESSION_TROOP_PROJECTILE_RUNTIME_MAX_HISTORY,
    "projectile runtime snapshot.history").map(checkedHistory);
  const launches = new Map();
  const contacts = new Map();
  const questions = new Map();
  const pendingIdentities = new Set();
  for (const entry of history) {
    const key = identityKey(entry.identity);
    const records = entry.type === "projectile-runtime-launch" ? launches
      : entry.type === "projectile-runtime-contact" ? contacts : questions;
    if (records.has(key)) {
      throw new TypeError("projectile runtime snapshot contains a duplicate projectile identity");
    }
    records.set(key, entry);
    if (entry.type === "projectile-runtime-question" && launches.has(key) && !contacts.has(key)) {
      throw new TypeError("projectile runtime snapshot question repeats a sourced identity");
    }
  }
  for (const entry of pending) {
    const key = identityKey(entry.identity);
    if (pendingIdentities.has(key)) {
      throw new TypeError("projectile runtime snapshot contains a duplicate pending identity");
    }
    pendingIdentities.add(key);
    const launch = launches.get(key);
    if (launch === undefined || contacts.has(key) || questions.has(key) ||
        launch.cardId !== entry.cardId || launch.claimFamily !== entry.claimFamily ||
        launch.targetId !== entry.targetId || launch.tick !== entry.launchTick) {
      throw new TypeError("projectile runtime snapshot pending identity is not causally open");
    }
  }
  for (const [key, entry] of contacts) {
    const launch = launches.get(key);
    if (launch === undefined || entry.tick < launch.tick) {
      throw new TypeError("projectile runtime snapshot contact has no causal launch");
    }
  }
  for (const [key, entry] of questions) {
    if (entry.type !== "projectile-runtime-question") {
      throw new TypeError("projectile runtime snapshot question type is invalid");
    }
    const launch = launches.get(key);
    const contact = contacts.get(key);
    if (launch !== undefined && contact === undefined) {
      throw new TypeError("projectile runtime snapshot sourced question has no contact");
    }
    if (launch !== undefined && entry.tick < launch.tick ||
        contact !== undefined && entry.tick < contact.tick) {
      throw new TypeError("projectile runtime snapshot question precedes its launch");
    }
  }
  for (let index = 1; index < history.length; index += 1) {
    if (history[index - 1].tick > history[index].tick) {
      throw new TypeError("projectile runtime snapshot history is not causally ordered");
    }
  }
  return { configuration: { bytes: snapshot.configuration }, history, pending };
}

function assertSnapshotPlan(configuration, snapshot) {
  const profiles = new Map(configuration.profiles.map((profile) => [profile.id, profile]));
  const questions = new Map(configuration.questions.map((question) => [question.cardId, question]));
  const byIdentity = new Map();
  for (const entry of snapshot.history) {
    const key = identityKey(entry.identity);
    const records = byIdentity.get(key) ?? [];
    records.push(entry);
    byIdentity.set(key, records);
    const profile = profiles.get(entry.cardId);
    const dependency = questions.get(entry.cardId);
    if (entry.disposition === "sourced") {
      if (profile === undefined || entry.claimFamily !== profile.claimFamily) {
        throw new TypeError("projectile runtime snapshot sourced history is not in its host plan");
      }
    } else if (dependency === undefined && profile === undefined) {
      throw new TypeError("projectile runtime snapshot QUESTION is not in its host plan");
    } else if (profile !== undefined && entry.claimFamily !== profile.claimFamily ||
        dependency !== undefined && entry.claimFamily !== dependency.claimFamily) {
      throw new TypeError("projectile runtime snapshot history claim diverges from its host plan");
    }
    if (entry.type === "projectile-runtime-question") {
      const expectedReason = profile === undefined
        ? "projectile delivery remains an explicit QUESTION"
        : "projectile continuation requires unresolved authoritative facts";
      if (entry.disposition !== "question" || entry.reason !== expectedReason) {
        throw new TypeError("projectile runtime snapshot QUESTION witness is invalid");
      }
    } else if (entry.reason !== null || entry.disposition !== "sourced") {
      throw new TypeError("projectile runtime snapshot sourced witness is invalid");
    }
  }
  for (const [key, records] of byIdentity) {
    const cardIds = new Set(records.map(({ cardId }) => cardId));
    const claimFamilies = new Set(records.map(({ claimFamily }) => claimFamily));
    const targetIds = new Set(records.map(({ targetId }) => targetId));
    if (cardIds.size !== 1 || claimFamilies.size !== 1 || targetIds.size !== 1) {
      throw new TypeError("projectile runtime snapshot identity lineage diverges");
    }
    const launch = records.find(({ type }) => type === "projectile-runtime-launch");
    const contact = records.find(({ type }) => type === "projectile-runtime-contact");
    const question = records.find(({ type }) => type === "projectile-runtime-question");
    if (records.length > 1 && launch === undefined &&
        records.some(({ disposition }) => disposition === "sourced")) {
      throw new TypeError("projectile runtime snapshot sourced lineage has no launch");
    }
    if (question !== undefined && profiles.has(question.cardId) && contact === undefined) {
      throw new TypeError("projectile runtime snapshot sourced QUESTION has no contact");
    }
    if (launch !== undefined && contact !== undefined && contact.tick < launch.tick ||
        contact !== undefined && question !== undefined && question.tick < contact.tick) {
      throw new TypeError("projectile runtime snapshot lineage ticks are not causal");
    }
    if (launch !== undefined && launch.identity.projectileId !==
        records[0].identity.projectileId) {
      throw new TypeError("projectile runtime snapshot identity lineage is malformed");
    }
  }
  for (const pending of snapshot.pending) {
    const profile = profiles.get(pending.cardId);
    if (profile === undefined || pending.claimFamily !== profile.claimFamily) {
      throw new TypeError("projectile runtime snapshot pending source is not in its host plan");
    }
  }
}

function checkedRoster(value) {
  const roster = dense(value, 8, "projectile runtime roster");
  const ids = new Set();
  return roster.map((card, index) => {
    const checked = exact(card, ROSTER_CARD_KEYS, `projectile runtime roster[${index}]`);
    if (ids.has(checked.id)) throw new TypeError("projectile runtime roster IDs must be unique");
    ids.add(checked.id);
    return checked;
  });
}

function assertLiveSource(profile, source, label) {
  const expected = profile.sourceCard;
  if (source.cardId !== profile.id || source.delivery !== "projectile" ||
      source.damage !== expected.damage || source.maxHealth !== expected.hitpoints ||
      source.rangeMillitiles !== expected.rangeMillitiles ||
      source.sightRangeMillitiles !== expected.sightRangeMillitiles ||
      source.targetMode !== (expected.targetMode === "ground-and-air"
        ? "air_and_ground" : expected.targetMode)) {
    throw new TypeError(`${label} diverges from the admitted projectile source receipt`);
  }
}

function cloneQuestionResult(value) {
  return freeze(clone(value));
}

/**
 * The runtime is a reducer over host observations.  The only dynamic values
 * it retains are host-minted identities and mechanic receipts.
 */
export class SessionTroopProjectileRuntime {
  #plan;
  #configuration;
  #history = [];
  #pending = [];

  constructor(configuration) {
    this.#plan = configuration;
    this.#configuration = checkedPlan(configuration);
  }

  static fromReceipt(serialized) {
    return new SessionTroopProjectileRuntime(admitPlanFromReceipt(serialized));
  }

  get configuration() {
    return this.#configuration.bytes;
  }

  get hasProfiles() {
    return this.#configuration.profiles.length > 0;
  }

  get state() {
    return freeze({
      configuration: this.configuration,
      history: clone(this.#history),
      pending: clone(this.#pending),
      version: SESSION_TROOP_PROJECTILE_RUNTIME_VERSION,
    });
  }

  profile(cardId) {
    if (typeof cardId !== "string") throw new TypeError("projectile profile card ID must be primitive");
    const profile = this.#configuration.profiles.find((candidate) => candidate.id === cardId);
    return profile === undefined ? null : freeze(clone(profile));
  }

  question(cardId) {
    if (typeof cardId !== "string") throw new TypeError("projectile question card ID must be primitive");
    const dependency = this.#configuration.questions.find(({ cardId: dependencyCardId }) =>
      dependencyCardId === cardId);
    return dependency === undefined ? null : freeze(clone(dependency));
  }

  assertSourceRoster(value) {
    const roster = checkedRoster(value);
    const byId = new Map(roster.map((card) => [card.id, card]));
    for (const profile of this.#configuration.profiles) {
      const card = byId.get(profile.id);
      if (card === undefined) continue;
      if (canonical(rosterSourceCard(card, `projectile roster ${profile.id}`)) !==
          canonical(profile.sourceCard)) {
        throw new TypeError(`projectile source roster ${profile.id} diverges from its receipt`);
      }
    }
    return true;
  }

  inspectMechanic(value, sources = []) {
    const command = checkedMechanicCommand(value);
    const profile = this.profile(command.cardId);
    if (profile === null) {
      const question = this.question(command.cardId);
      if (question !== null) {
        return cloneQuestionResult({
          cardId: command.cardId,
          claimFamily: question.claimFamily,
          disposition: "question",
          questions: Object.entries(question.questions).map(([key, record]) => ({
            ...clone(record), key,
          })),
          reason: "projectile delivery remains an explicit QUESTION",
          sourceId: command.sourceId,
          targetId: command.targetId,
          tick: command.tick,
          type: "projectile-runtime-question",
        });
      }
      throw new RangeError("projectile mechanic card is not admitted by the profile receipt");
    }
    const checkedSources = dense(sources, SESSION_TROOP_PROJECTILE_RUNTIME_MAX_SOURCES,
      "projectile mechanic sources").map(checkedSource);
    const source = checkedSources.find(({ sourceId }) => sourceId === command.sourceId);
    if (source === undefined) throw new RangeError("projectile mechanic source is not live");
    assertLiveSource(profile, source, "projectile mechanic source");
    return cloneQuestionResult(questionWitness(profile, command.sourceId, command.targetId,
      command.tick, "projectile continuation requires unresolved authoritative facts"));
  }

  scheduleMechanic(value, sources = []) {
    const result = this.inspectMechanic(value, sources);
    if (result.disposition === "question") {
      throw new RangeError(`${result.cardId} projectile ${result.claimFamily} remains an explicit QUESTION`);
    }
    return result;
  }

  step(value) {
    const candidate = this.fork();
    const events = candidate.#reduce(value);
    this.#history = candidate.#history;
    this.#pending = candidate.#pending;
    return freeze(clone(events));
  }

  #reduce(value) {
    const input = exact(value, ["events", "sources", "tick"], "projectile runtime boundary");
    const tick = integer(input.tick, 0, Number.MAX_SAFE_INTEGER, "projectile runtime boundary.tick");
    const sources = dense(input.sources, SESSION_TROOP_PROJECTILE_RUNTIME_MAX_SOURCES,
      "projectile runtime boundary.sources").map(checkedSource);
    const sourceById = new Map(sources.map((source) => [source.sourceId, source]));
    const rawEvents = dense(input.events, 4_096, "projectile runtime boundary.events");
    const events = rawEvents.map(checkedEvent).filter((event) => event !== null)
      .sort((left, right) => eventPriority(left) - eventPriority(right) ||
        left.identity.projectileId - right.identity.projectileId ||
        left.identity.sourceId - right.identity.sourceId);
    if (this.#history.at(-1)?.tick > tick) {
      throw new RangeError("projectile runtime boundary tick is stale");
    }
    const profiles = new Map(this.#configuration.profiles.map((profile) => [profile.id, profile]));
    const seen = new Set([
      ...this.#pending.map(({ identity }) => identityKey(identity)),
      ...this.#history.map(({ identity }) => identityKey(identity)),
    ]);
    const output = [];
    for (const event of events) {
      const source = sourceById.get(event.identity.sourceId);
      if (source === undefined) continue;
      const profile = profiles.get(source.cardId);
      if (profile === undefined) {
        const unresolved = this.#configuration.questions.find(({ cardId }) =>
          cardId === source.cardId);
        if (unresolved !== undefined && event.type === "projectile-launch") {
          const receipt = {
            ...questionWitness({
              claimFamily: unresolved.claimFamily,
              id: unresolved.cardId,
              questions: unresolved.questions,
            }, source.sourceId, event.targetId, tick, "projectile delivery remains an explicit QUESTION"),
            identity: clone(event.identity),
          };
          output.push(receipt);
          seen.add(identityKey(event.identity));
          this.#appendHistory({
            cardId: source.cardId,
            claimFamily: receipt.claimFamily,
            disposition: "question",
            identity: clone(event.identity),
            reason: receipt.reason,
            status: "question",
            targetId: event.targetId ?? 1,
            tick,
            type: "projectile-runtime-question",
          });
        }
        continue;
      }
      assertLiveSource(profile, source, `projectile runtime source ${source.sourceId}`);
      const key = identityKey(event.identity);
      if (event.type === "projectile-launch") {
        if (seen.has(key)) throw new RangeError("projectile runtime launch identity is duplicate");
        seen.add(key);
        const targetId = event.targetId;
        if (targetId === null || targetId < 1) {
          throw new RangeError("projectile runtime launch target is not causal");
        }
        this.#pending.push({
          cardId: profile.id,
          claimFamily: profile.claimFamily,
          identity: clone(event.identity),
          launchTick: tick,
          targetId,
        });
        this.#appendHistory({
          cardId: profile.id,
          claimFamily: profile.claimFamily,
          disposition: "sourced",
          identity: clone(event.identity),
          reason: null,
          status: "launched",
          targetId,
          tick,
          type: "projectile-runtime-launch",
        });
        output.push({
          cardId: profile.id,
          claimFamily: profile.claimFamily,
          disposition: "sourced",
          identity: clone(event.identity),
          sourceId: event.identity.sourceId,
          targetId,
          tick,
          type: "projectile-runtime-receipt",
        });
      } else if (event.type === "projectile-impact") {
        const pendingIndex = this.#pending.findIndex(({ identity }) => identityKey(identity) === key);
        if (pendingIndex === -1) {
          if (seen.has(key)) throw new RangeError("projectile runtime contact identity is duplicate or terminal");
          throw new RangeError("projectile runtime contact has no causal launch");
        }
        const pending = this.#pending[pendingIndex];
        this.#pending.splice(pendingIndex, 1);
        const status = ["contact", "target_dead", "target_missing"].includes(event.status ?? "")
          ? event.status : "target_missing";
        this.#appendHistory({
          cardId: profile.id,
          claimFamily: profile.claimFamily,
          disposition: "sourced",
          identity: clone(event.identity),
          reason: null,
          status: status === "contact" ? "contact" : status,
          targetId: event.targetId ?? pending.targetId,
          tick,
          type: "projectile-runtime-contact",
        });
        output.push({
          cardId: profile.id,
          claimFamily: profile.claimFamily,
          disposition: "sourced",
          identity: clone(event.identity),
          sourceId: event.identity.sourceId,
          status,
          targetId: event.targetId ?? pending.targetId,
          tick,
          type: "projectile-runtime-receipt",
        });
        output.push({
          ...questionWitness(profile, event.identity.sourceId,
            event.targetId ?? pending.targetId, tick,
            "projectile continuation requires unresolved authoritative facts"),
          identity: clone(event.identity),
        });
        this.#appendHistory({
          cardId: profile.id,
          claimFamily: profile.claimFamily,
          disposition: "question",
          identity: clone(event.identity),
          reason: "projectile continuation requires unresolved authoritative facts",
          status: "question",
          targetId: event.targetId ?? pending.targetId,
          tick,
          type: "projectile-runtime-question",
        });
      }
    }
    if (this.#pending.length > SESSION_TROOP_PROJECTILE_RUNTIME_MAX_PENDING) {
      throw new RangeError("projectile runtime pending bound exceeded");
    }
    return output;
  }

  #appendHistory(entry) {
    if (this.#history.length >= SESSION_TROOP_PROJECTILE_RUNTIME_MAX_HISTORY) {
      throw new RangeError("projectile runtime history bound exceeded");
    }
    this.#history.push(entry);
  }

  serialize() {
    const serialized = canonical({
      configuration: this.configuration,
      history: this.#history,
      pending: this.#pending,
      version: SESSION_TROOP_PROJECTILE_RUNTIME_VERSION,
    });
    if (new TextEncoder().encode(serialized).byteLength > SESSION_TROOP_PROJECTILE_RUNTIME_MAX_BYTES) {
      throw new RangeError("serialized projectile runtime exceeds its byte bound");
    }
    return serialized;
  }

  static restore(serialized, configuration) {
    const snapshot = parseCanonical(serialized, "serialized projectile runtime");
    const checked = checkedSnapshot(snapshot);
    const plan = typeof configuration === "string"
      ? admitPlanFromReceipt(configuration) : configuration;
    const restored = new SessionTroopProjectileRuntime(plan);
    assertSnapshotPlan(restored.#configuration, checked);
    if (restored.configuration !== checked.configuration.bytes) {
      throw new TypeError("projectile runtime snapshot configuration diverges from its host plan");
    }
    restored.#history = checked.history.map(clone);
    restored.#pending = checked.pending.map(clone);
    if (restored.serialize() !== serialized) {
      throw new TypeError("projectile runtime snapshot is not canonical or causal");
    }
    return restored;
  }

  fork() {
    const candidate = new SessionTroopProjectileRuntime(this.#plan);
    candidate.#history = clone(this.#history);
    candidate.#pending = clone(this.#pending);
    return candidate;
  }
}

function parseAuthorityEnvelope(serialized) {
  if (typeof serialized !== "string") return undefined;
  try { return JSON.parse(serialized); }
  catch { return undefined; }
}

export function admitSessionTroopProjectileRuntimeProfiles(serialized) {
  assertSessionTroopProjectileAuthorityReceipt(serialized);
  return serialized;
}

export function admitSessionTroopProjectileRuntimeFromSetup(serializedSetup) {
  const setup = parseAuthorityEnvelope(serializedSetup);
  if (setup === null || typeof setup !== "object" || Array.isArray(setup) ||
      !Object.hasOwn(setup, "projectileRuntimeProfiles")) return undefined;
  return admitSessionTroopProjectileRuntimeProfiles(setup.projectileRuntimeProfiles);
}

export function admitSessionTroopProjectileRuntimeFromGameSnapshot(serializedSnapshot) {
  const snapshot = parseAuthorityEnvelope(serializedSnapshot);
  if (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot) ||
      !Object.hasOwn(snapshot, "setup")) return undefined;
  return admitSessionTroopProjectileRuntimeFromSetup(canonical(snapshot.setup));
}

export function admitSessionTroopProjectileRuntimeFromBattleSnapshot(serializedSnapshot) {
  const snapshot = parseAuthorityEnvelope(serializedSnapshot);
  if (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot) ||
      !Object.hasOwn(snapshot, "projectileRuntime")) return undefined;
  let runtime;
  try { runtime = JSON.parse(snapshot.projectileRuntime); }
  catch { throw new TypeError("live battle projectile runtime witness is invalid"); }
  if (runtime === null || typeof runtime !== "object" || Array.isArray(runtime)) {
    throw new TypeError("live battle projectile runtime witness is invalid");
  }
  return admitSessionTroopProjectileRuntimeProfiles(runtime.configuration);
}
