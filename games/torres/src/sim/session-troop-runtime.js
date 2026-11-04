/**
 * Profile-only troop reducer used by LiveBattle's shared-world host seam.
 *
 * It owns no dynamic match state: no tick, entity IDs, health, statuses,
 * action queue, receipt/history, deck, elixir, clock, or random source.
 * LiveBattle supplies one bounded host observation and is the only component
 * that can validate or apply the immutable intent returned here.
 */

export const SESSION_TROOP_RUNTIME_VERSION = 3;
export const SESSION_TROOP_RUNTIME_MOVEMENT_VERSION = 4;
export const SESSION_TROOP_RUNTIME_LEGACY_VERSION = 1;
export const SESSION_TROOP_RUNTIME_ACTION_PROFILE_VERSION = 2;
export const SESSION_TROOP_RUNTIME_MAX_PROFILES = 8;
export const SESSION_TROOP_RUNTIME_MAX_SOURCES = 1_024;

const MAX_BYTES = 16_384;
const MAX_GRAPH_DEPTH = 16;
const MAX_GRAPH_NODES = 512;
const MAX_STRING_LENGTH = 128;
const MOVEMENT_MAX_GRAPH_DEPTH = 64;
const MOVEMENT_MAX_GRAPH_NODES = 50_000;
const SESSION_TROOP_MOVEMENT_RUNTIME_RECEIPT_FINGERPRINT = "d3ae59740b427e22";
const SESSION_TROOP_MOVEMENT_RUNTIME_MAX_RECEIPT_BYTES = 1_048_576;
const MOVEMENT_MAX_STRING_LENGTH = SESSION_TROOP_MOVEMENT_RUNTIME_MAX_RECEIPT_BYTES;

function assertSessionTroopMovementAuthorityReceipt(serialized) {
  if (typeof serialized !== "string") {
    throw new TypeError("session troop movement receipt must be canonical JSON text");
  }
  const bytes = new TextEncoder().encode(serialized);
  let left = 2_166_136_261;
  let right = 2_166_136_261;
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index];
    left = Math.imul(left ^ byte, 16_777_619) >>> 0;
    right = Math.imul(right ^ (byte + ((index * 31) & 255)), 16_777_619) >>> 0;
  }
  const fingerprint = `${left.toString(16).padStart(8, "0")}${right.toString(16).padStart(8, "0")}`;
  if (fingerprint !== SESSION_TROOP_MOVEMENT_RUNTIME_RECEIPT_FINGERPRINT) {
    throw new TypeError("session troop movement receipt diverges from the exact passed HTMP receipt");
  }
}
const LEGACY_ACTION_KEYS = ["abilityCost", "id", "target"];
const PRIOR_ACTION_KEYS = ["abilityCost", "effect", "id", "target"];
const ACTION_TARGETS = new Set(["unit"]);
const PRIOR_ACTION_EFFECTS = new Set(["source-melee-contact"]);
const LEGACY_INTENT_PHASES = new Set(["deploy", "pre-move", "pre-combat", "post-combat"]);
const CURRENT_INTENT_PHASES = new Set([...LEGACY_INTENT_PHASES, "combat"]);
const PASS_PHASES = Object.freeze(["pre-move", "pre-combat", "post-combat"]);
const LEGACY_PROFILE_KEYS = ["action", "cardId", "claim", "deploy", "passes"];
const CURRENT_PROFILE_KEYS = ["cardId", "claim", "contact", "sourceProfile"];
const PROFILE_SET_KEYS = ["profiles", "version"];
const SOURCE_KEYS = ["cardId", "side", "sourceId"];
const ACTION_COMMAND_KEYS = [
  "actionId", "commandId", "point", "side", "sourceId", "targetId", "tick", "type",
];
const POINT_KEYS = ["x", "y"];
const CONTACT_KEYS = ["attackSequence", "sourceId", "targetId"];
const CONTACT_PROVENANCE_KEYS = ["confidence", "contentPiece", "verification"];
const CONTACT_KEYS_PROFILE = ["delivery", "effect", "provenance"];
const SOURCE_PROFILE_KEYS = ["combat", "entity"];
const SOURCE_PROFILE_COMBAT_KEYS = [
  "damage", "delivery", "deployTimeTicks", "firstHitTicks", "hitSpeedTicks", "layer",
  "rangeMillitiles", "sightRangeMillitiles", "targetMode",
];
const SOURCE_PROFILE_ENTITY_KEYS = ["archetypeId", "memberIndex", "role"];
const EMPTY_PROFILE_BYTES = '{"profiles":[],"version":1}';
const MOVEMENT_PROFILE_IDS = Object.freeze([
  "cinderback", "copperskiff", "emberlance", "railward", "skymaul",
  "stonevault", "veilrunner", "wayfinder",
]);
const MOVEMENT_PROFILE_CLAIMS = Object.freeze([
  Object.freeze({ id: "cinderback", claims: Object.freeze([
    Object.freeze({ claimFamily: "recoil", exportName: "createRecoilSpecialCatalog" }),
  ]) }),
  Object.freeze({ id: "copperskiff", claims: Object.freeze([
    Object.freeze({ claimFamily: "flight", exportName: "createBasicFlyingCatalog" }),
  ]) }),
  Object.freeze({ id: "emberlance", claims: Object.freeze([
    Object.freeze({ claimFamily: "charge-knockback-membership", exportName: "createChargeKnockbackCatalog" }),
    Object.freeze({ claimFamily: "charge", exportName: "createChargeSpecialCatalog" }),
  ]) }),
  Object.freeze({ id: "railward", claims: Object.freeze([
    Object.freeze({ claimFamily: "shield-form", exportName: "createShieldFormCatalog" }),
  ]) }),
  Object.freeze({ id: "skymaul", claims: Object.freeze([
    Object.freeze({ claimFamily: "flight", exportName: "createBasicFlyingCatalog" }),
  ]) }),
  Object.freeze({ id: "stonevault", claims: Object.freeze([
    Object.freeze({ claimFamily: "jump", exportName: "createJumpSpecialCatalog" }),
  ]) }),
  Object.freeze({ id: "veilrunner", claims: Object.freeze([
    Object.freeze({ claimFamily: "dash", exportName: "createDashSpecialCatalog" }),
  ]) }),
  Object.freeze({ id: "wayfinder", claims: Object.freeze([
    Object.freeze({ claimFamily: "retarget", exportName: "createRetargetSpecialCatalog" }),
  ]) }),
]);
const MOVEMENT_OCCURRENCES = Object.freeze([
  Object.freeze({ exportName: "createRecoilSpecialCatalog", id: "cinderback", status: "admitted" }),
  Object.freeze({ exportName: "createBasicFlyingCatalog", id: "copperskiff", status: "admitted" }),
  Object.freeze({ exportName: "createChargeKnockbackCatalog", id: "emberlance", status: "admitted" }),
  Object.freeze({ exportName: "createChargeSpecialCatalog", id: "emberlance", status: "admitted" }),
  Object.freeze({ exportName: "createShieldFormCatalog", id: "railward", status: "admitted" }),
  Object.freeze({ exportName: "createBasicFlyingCatalog", id: "skymaul", status: "admitted" }),
  Object.freeze({ exportName: "createJumpSpecialCatalog", id: "stonevault", status: "admitted" }),
  Object.freeze({ exportName: "createDashSpecialCatalog", id: "veilrunner", status: "admitted" }),
  Object.freeze({ exportName: "createRetargetSpecialCatalog", id: "wayfinder", status: "admitted" }),
]);
const MOVEMENT_COUNTS = Object.freeze({
  duplicatedIds: 1,
  ids: 8,
  occurrences: 9,
  profiles: 8,
  questionBearingClaims: 6,
  unresolvedOnlyClaims: 1,
});
const MOVEMENT_SOURCE_CARD_FIELDS = Object.freeze([
  "areaDamageRadiusMillitiles", "cost", "count", "damage", "deployTimeTicks",
  "displayName", "firstHitTicks", "hitSpeedTicks", "hitpoints", "id", "kind",
  "movementMillitilesPerSecond", "rangeMillitiles", "rarity", "sightRangeMillitiles",
  "targetMode",
]);
const MOVEMENT_SOURCE_ENTITY_FIELDS = Object.freeze([
  "areaDamageRadiusMillitiles", "count", "damage", "deployTimeTicks", "displayName",
  "firstHitTicks", "hitSpeedTicks", "hitpoints", "kind", "movementMillitilesPerSecond",
  "rangeMillitiles", "sightRangeMillitiles", "targetMode",
]);
const MOVEMENT_QUESTION_REASONS = Object.freeze({
  charge: "charge stage fields remain explicit QUESTION values",
  "charge-knockback-membership": "charge and knockback composition remains an explicit QUESTION",
  dash: "dash stage fields remain explicit QUESTION values",
  jump: "jump stage fields remain explicit QUESTION values",
  recoil: "recoil stage fields remain explicit QUESTION values",
  retarget: "retarget stage fields remain explicit QUESTION values",
  "shield-form": "shield/form fields remain unresolved QUESTION values",
});

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

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

function exact(value, keys, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${label} must be a plain object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${label} has an invalid shape`);
  }
  return value;
}

function denseArray(value, maximum, label) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype ||
      value.length > maximum || Reflect.ownKeys(value).length !== value.length + 1) {
    throw new TypeError(`${label} must be a bounded dense array`);
  }
  return Array.from({ length: value.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) {
      throw new TypeError(`${label} must contain only data entries`);
    }
    return descriptor.value;
  });
}

function text(value, label, maximum = MAX_STRING_LENGTH) {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum ||
      value.normalize("NFC") !== value || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`${label} must be bounded normalized text`);
  }
  return value;
}

function integer(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label} must be a bounded safe integer`);
  }
  return value;
}

function checkedPoint(value, label, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  const point = exact(value, POINT_KEYS, label);
  return {
    x: integer(point.x, 0, Number.MAX_SAFE_INTEGER, `${label}.x`),
    y: integer(point.y, 0, Number.MAX_SAFE_INTEGER, `${label}.y`),
  };
}

function parse(textValue, label, {
  maximum = MAX_BYTES,
  graphDepth = MAX_GRAPH_DEPTH,
  graphNodes = MAX_GRAPH_NODES,
  stringLength = MAX_STRING_LENGTH,
} = {}) {
  if (typeof textValue !== "string") throw new TypeError(`${label} must be canonical JSON text`);
  if (new TextEncoder().encode(textValue).byteLength > maximum) {
    throw new RangeError(`${label} exceeds its byte bound`);
  }
  let value;
  try { value = JSON.parse(textValue); }
  catch { throw new TypeError(`${label} must be valid JSON`); }
  const stack = [{ depth: 0, value }];
  let nodes = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    nodes += 1;
    if (nodes > graphNodes || current.depth > graphDepth) {
      throw new RangeError(`${label} exceeds its graph bound`);
    }
    const entry = current.value;
    if (typeof entry === "string") {
      text(entry, label, stringLength);
      continue;
    }
    if (typeof entry === "number" && !Number.isSafeInteger(entry)) {
      throw new TypeError(`${label} contains a non-safe integer`);
    }
    if (entry === null || typeof entry === "boolean" || typeof entry === "number") continue;
    if (!entry || typeof entry !== "object") throw new TypeError(`${label} contains invalid data`);
    const children = Array.isArray(entry) ? entry : Object.values(entry);
    if (children.length > MAX_GRAPH_NODES) throw new RangeError(`${label} exceeds its member bound`);
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push({ depth: current.depth + 1, value: children[index] });
    }
  }
  if (canonical(value) !== textValue) throw new TypeError(`${label} must be canonical JSON`);
  return value;
}

function checkedLegacyActionProfile(value, label, version) {
  if (value === null) return null;
  const action = exact(value, version === SESSION_TROOP_RUNTIME_LEGACY_VERSION
    ? LEGACY_ACTION_KEYS : PRIOR_ACTION_KEYS, label);
  if (action.abilityCost !== null) {
    throw new TypeError(`${label}.abilityCost must remain explicit null until sourced`);
  }
  const target = text(action.target, `${label}.target`);
  if (!ACTION_TARGETS.has(target)) throw new TypeError(`${label}.target is unsupported`);
  const checked = { abilityCost: null, id: text(action.id, `${label}.id`), target };
  if (version === SESSION_TROOP_RUNTIME_LEGACY_VERSION) return checked;
  const effect = text(action.effect, `${label}.effect`);
  if (!PRIOR_ACTION_EFFECTS.has(effect)) throw new TypeError(`${label}.effect is unsupported`);
  return { abilityCost: null, effect, id: checked.id, target };
}

function checkedLegacyProfile(value, index, version) {
  const profile = exact(value, LEGACY_PROFILE_KEYS, `session troop profile[${index}]`);
  const action = checkedLegacyActionProfile(profile.action, `session troop profile[${index}].action`, version);
  const claim = text(profile.claim, `session troop profile[${index}].claim`);
  if (version === SESSION_TROOP_RUNTIME_LEGACY_VERSION && claim !== "unclaimed") {
    throw new TypeError(`session troop profile[${index}].claim must remain unclaimed`);
  }
  if (version === SESSION_TROOP_RUNTIME_ACTION_PROFILE_VERSION &&
      !["receipt-witness", "representative-mechanic"].includes(claim)) {
    throw new TypeError(`session troop profile[${index}].claim is unsupported`);
  }
  if (version === SESSION_TROOP_RUNTIME_ACTION_PROFILE_VERSION &&
      ((claim === "representative-mechanic") !== (action !== null))) {
    throw new TypeError(`session troop profile[${index}].claim/action must agree`);
  }
  if (profile.deploy !== "receipt-only") {
    throw new TypeError(`session troop profile[${index}].deploy must be receipt-only`);
  }
  const passes = denseArray(profile.passes, PASS_PHASES.length,
    `session troop profile[${index}].passes`).map((phase, phaseIndex) => {
    const checked = text(phase, `session troop profile[${index}].passes[${phaseIndex}]`);
    if (checked !== PASS_PHASES[phaseIndex]) {
      throw new TypeError(`session troop profile[${index}].passes must use canonical phase order`);
    }
    return checked;
  });
  if (passes.length !== PASS_PHASES.length) {
    throw new TypeError(`session troop profile[${index}].passes must cover every host phase`);
  }
  return {
    action,
    cardId: text(profile.cardId, `session troop profile[${index}].cardId`),
    claim,
    deploy: "receipt-only",
    passes,
  };
}

function checkedContactProvenance(value, label) {
  const provenance = exact(value, CONTACT_PROVENANCE_KEYS, label);
  return {
    confidence: text(provenance.confidence, `${label}.confidence`),
    contentPiece: text(provenance.contentPiece, `${label}.contentPiece`),
    verification: text(provenance.verification, `${label}.verification`),
  };
}

function checkedCurrentContact(value, label) {
  const contact = exact(value, CONTACT_KEYS_PROFILE, label);
  if (contact.delivery !== "melee" || contact.effect !== "ordinary-live-contact") {
    throw new TypeError(`${label} must identify the ordinary melee host contact`);
  }
  return {
    delivery: "melee",
    effect: "ordinary-live-contact",
    provenance: checkedContactProvenance(contact.provenance, `${label}.provenance`),
  };
}

function checkedSourceProfile(value, label) {
  const source = exact(value, SOURCE_PROFILE_KEYS, label);
  const combat = exact(source.combat, SOURCE_PROFILE_COMBAT_KEYS, `${label}.combat`);
  if (combat.delivery !== "melee" || !["air", "ground"].includes(combat.layer) ||
      !["air", "air_and_ground", "buildings", "ground", "none"].includes(combat.targetMode)) {
    throw new TypeError(`${label}.combat is not an ordinary melee source`);
  }
  const entity = exact(source.entity, SOURCE_PROFILE_ENTITY_KEYS, `${label}.entity`);
  if (entity.memberIndex !== 0) {
    throw new TypeError(`${label} source projection is inconsistent`);
  }
  return {
    combat: {
      damage: integer(combat.damage, 1, 1_000_000_000, `${label}.combat.damage`),
      delivery: "melee",
      deployTimeTicks: integer(combat.deployTimeTicks, 0, 1_000_000_000,
        `${label}.combat.deployTimeTicks`),
      firstHitTicks: integer(combat.firstHitTicks, 0, 1_000_000_000,
        `${label}.combat.firstHitTicks`),
      hitSpeedTicks: integer(combat.hitSpeedTicks, 1, 1_000_000_000,
        `${label}.combat.hitSpeedTicks`),
      layer: combat.layer,
      rangeMillitiles: integer(combat.rangeMillitiles, 0, 1_000_000_000,
        `${label}.combat.rangeMillitiles`),
      sightRangeMillitiles: integer(combat.sightRangeMillitiles, 0, 1_000_000_000,
        `${label}.combat.sightRangeMillitiles`),
      targetMode: combat.targetMode,
    },
    entity: {
      archetypeId: text(entity.archetypeId, `${label}.entity.archetypeId`),
      memberIndex: 0,
      role: text(entity.role, `${label}.entity.role`),
    },
  };
}

function checkedCurrentProfile(value, index) {
  const profile = exact(value, CURRENT_PROFILE_KEYS, `session troop profile[${index}]`);
  const cardId = text(profile.cardId, `session troop profile[${index}].cardId`);
  if (cardId !== "mossguard" || profile.claim !== "representative-live-contact") {
    throw new TypeError(`session troop profile[${index}] is not the current Mossguard contact profile`);
  }
  const contact = checkedCurrentContact(profile.contact, `session troop profile[${index}].contact`);
  const sourceProfile = checkedSourceProfile(profile.sourceProfile,
    `session troop profile[${index}].sourceProfile`);
  if (contact.delivery !== sourceProfile.combat.delivery ||
      sourceProfile.entity.archetypeId !== cardId || sourceProfile.entity.role !== "primary") {
    throw new TypeError(`session troop profile[${index}] contact/source profile diverges`);
  }
  return { cardId, claim: "representative-live-contact", contact, sourceProfile };
}

function movementManifestFromReceipt(receipt) {
  const manifest = parse(receipt.manifest, "session troop movement source manifest", {
    graphDepth: MOVEMENT_MAX_GRAPH_DEPTH,
    graphNodes: MOVEMENT_MAX_GRAPH_NODES,
    maximum: SESSION_TROOP_MOVEMENT_RUNTIME_MAX_RECEIPT_BYTES,
    stringLength: MOVEMENT_MAX_STRING_LENGTH,
  });
  const checkedManifest = exact(manifest,
    ["counts", "occurrences", "profiles", "version"],
    "session troop movement source manifest");
  if (checkedManifest.version !== 1 || canonical(checkedManifest.counts) !==
      canonical(MOVEMENT_COUNTS)) {
    throw new TypeError("session troop movement source manifest counts are not the HTMP receipt");
  }
  const occurrences = denseArray(checkedManifest.occurrences, MOVEMENT_OCCURRENCES.length,
    "session troop movement source manifest.occurrences");
  if (canonical(occurrences) !== canonical(MOVEMENT_OCCURRENCES)) {
    throw new TypeError("session troop movement source manifest occurrences diverge");
  }
  const profiles = denseArray(checkedManifest.profiles, MOVEMENT_PROFILE_IDS.length,
    "session troop movement source manifest.profiles");
  if (profiles.length !== MOVEMENT_PROFILE_IDS.length) {
    throw new TypeError("session troop movement source manifest profile count diverges");
  }
  for (let index = 0; index < profiles.length; index += 1) {
    const expected = MOVEMENT_PROFILE_CLAIMS[index];
    const profile = exact(profiles[index], [
      "claims", ...(expected.id === "emberlance" ? ["composition"] : []),
      "cost", "deployTimeTicks", "displayName", "id", "kind",
      "occurrenceExports", "placementClass", "sourceRecords",
    ], `session troop movement source manifest.profiles[${index}]`);
    if (profile.id !== expected.id || profile.kind !== "unit" ||
        profile.placementClass !== "ground_entity" ||
        canonical(profile.occurrenceExports) !== canonical(
          expected.claims.map(({ exportName }) => exportName),
        )) {
      throw new TypeError("session troop movement source manifest profile identity diverges");
    }
    const claims = denseArray(profile.claims, expected.claims.length,
      `session troop movement source manifest.profiles[${index}].claims`);
    if (claims.length !== expected.claims.length) {
      throw new TypeError("session troop movement source manifest claim count diverges");
    }
    for (let claimIndex = 0; claimIndex < claims.length; claimIndex += 1) {
      const claim = claims[claimIndex];
      const expectedClaim = expected.claims[claimIndex];
      if (claim === null || typeof claim !== "object" ||
          claim.claimFamily !== expectedClaim.claimFamily ||
          claim.exportName !== expectedClaim.exportName ||
          typeof claim.sourceRecordCanonical !== "string") {
        throw new TypeError("session troop movement source manifest claim diverges");
      }
      if (claim.claimFamily === "flight") {
        const behavior = exact(claim.flightBehavior,
          ["excludedMechanics", "exportedFunctions", "pathScope", "roundTrip",
            "sourceTest", "speedField"],
          `session troop movement flight claim ${profile.id}.flightBehavior`);
        if (behavior.pathScope !== "axis-aligned-only" ||
            behavior.speedField !== "movementMillitilesPerSecond" ||
            behavior.roundTrip !== "serialize-restore-byte-stable") {
          throw new TypeError("session troop movement flight behavior is not source-authoritative");
        }
      } else if (claim.claimFamily === "shield-form") {
        if (claim.unresolvedOnly !== true || !Array.isArray(claim.unresolvedFields) ||
            claim.unresolvedFields.length !== 5 || typeof claim.unresolvedReason !== "string") {
          throw new TypeError("session troop movement shield/form claim is not unresolved-only");
        }
      } else if (claim.questionPolicy === null ||
          !Array.isArray(claim.questionPolicy.records)) {
        throw new TypeError("session troop movement QUESTION claim lacks its receipt records");
      }
      movementSourceRecord(claim, `session troop movement claim ${profile.id}`);
    }
  }
  return { manifest: checkedManifest, profiles };
}

function movementSourceRecord(claim, label) {
  const source = parse(claim.sourceRecordCanonical, `${label}.sourceRecordCanonical`, {
    graphDepth: MOVEMENT_MAX_GRAPH_DEPTH,
    graphNodes: MOVEMENT_MAX_GRAPH_NODES,
    maximum: SESSION_TROOP_MOVEMENT_RUNTIME_MAX_RECEIPT_BYTES,
    stringLength: MOVEMENT_MAX_STRING_LENGTH,
  });
  exact(source, [
    "areaDamageRadiusMillitiles", "components", "cost", "count", "damage",
    "deployTimeTicks", "displayName", "firstHitTicks", "hitSpeedTicks", "hitpoints",
    "id", "kind", "movementMillitilesPerSecond", "rangeMillitiles", "rarity",
    "sightRangeMillitiles", "targetMode",
  ], `${label}.sourceRecord`);
  if (source.kind !== "unit" || !Array.isArray(source.components) ||
      source.components.length > 16) {
    throw new TypeError(`${label}.sourceRecord is not a bounded unit record`);
  }
  return source;
}

function movementProfilePublic(profile) {
  return {
    claims: profile.claims.map((claim) => {
      const publicClaim = {
        claimFamily: claim.claimFamily,
        exportName: claim.exportName,
        sourceRecordCanonical: claim.sourceRecordCanonical,
      };
      if (claim.flightBehavior !== undefined) {
        publicClaim.flightBehavior = clone(claim.flightBehavior);
      }
      if (claim.questionPolicy !== null && claim.questionPolicy !== undefined) {
        publicClaim.questionKeys = denseArray(claim.questionPolicy.records,
          MOVEMENT_MAX_GRAPH_NODES, "session troop movement QUESTION records")
          .map((record, index) => exact(record,
            ["authoritative", "confidence", "disposition", "key", "source", "value"],
            `session troop movement QUESTION record ${index}`).key)
          .sort();
      }
      if (claim.unresolvedOnly === true) {
        publicClaim.unresolvedFields = clone(claim.unresolvedFields);
        publicClaim.unresolvedOnly = true;
        publicClaim.unresolvedReason = claim.unresolvedReason;
      }
      return publicClaim;
    }),
    id: profile.id,
  };
}

function movementFlightProfile(profile) {
  const claim = profile.claims.find(({ claimFamily }) => claimFamily === "flight");
  if (claim === undefined) return null;
  const source = movementSourceRecord(claim, `session troop movement flight ${profile.id}`);
  if (!Number.isSafeInteger(source.movementMillitilesPerSecond) ||
      source.movementMillitilesPerSecond < 0) {
    throw new TypeError(`session troop movement flight ${profile.id} has no sourced speed`);
  }
  return {
    cardId: profile.id,
    claimFamily: "flight",
    layer: "air",
    pathScope: claim.flightBehavior.pathScope,
    sourceRecordCanonical: claim.sourceRecordCanonical,
    speed: source.movementMillitilesPerSecond,
  };
}

function movementQuestionKeys(claim) {
  if (claim.unresolvedOnly === true) return [...claim.unresolvedFields].sort();
  if (claim.questionPolicy === null || claim.questionPolicy === undefined) return [];
  return denseArray(claim.questionPolicy.records, MOVEMENT_MAX_GRAPH_NODES,
    "session troop movement QUESTION records")
    .map((record, index) => exact(record,
      ["authoritative", "confidence", "disposition", "key", "source", "value"],
      `session troop movement QUESTION record ${index}`).key)
    .sort();
}

function movementClaim(profile, claimFamily) {
  const claim = profile.claims.find(({ claimFamily: candidate }) => candidate === claimFamily);
  if (claim === undefined) {
    throw new RangeError("session troop movement claim family is not admitted for this card");
  }
  return claim;
}

function checkedMovementCommand(value) {
  const command = exact(value,
    ["cardId", "claimFamily", "phase", "side", "sourceId", "tick", "type"],
    "session troop movement command");
  if (command.type !== "troop-movement") {
    throw new TypeError("session troop movement command.type is invalid");
  }
  const phase = text(command.phase, "session troop movement command.phase");
  if (!CURRENT_INTENT_PHASES.has(phase)) {
    throw new TypeError("session troop movement command.phase is invalid");
  }
  const side = text(command.side, "session troop movement command.side");
  if (side !== "north" && side !== "south") {
    throw new TypeError("session troop movement command.side is invalid");
  }
  return {
    cardId: text(command.cardId, "session troop movement command.cardId"),
    claimFamily: text(command.claimFamily, "session troop movement command.claimFamily"),
    phase,
    side,
    sourceId: integer(command.sourceId, 1, Number.MAX_SAFE_INTEGER,
      "session troop movement command.sourceId"),
    tick: integer(command.tick, 0, Number.MAX_SAFE_INTEGER,
      "session troop movement command.tick"),
    type: "troop-movement",
  };
}

function movementQuestion({ cardId, claim, phase, side, sourceId, tick }) {
  return freeze({
    cardId,
    claimFamily: claim.claimFamily,
    disposition: "question",
    phase,
    questionKeys: movementQuestionKeys(claim),
    reason: claim.unresolvedOnly === true
      ? claim.unresolvedReason
      : MOVEMENT_QUESTION_REASONS[claim.claimFamily],
    side,
    sourceId,
    tick,
    type: "troop-movement-question",
  });
}

function movementAdmission({ cardId, claim, flight, phase, side, sourceId, tick }) {
  return freeze({
    cardId,
    claimFamily: claim.claimFamily,
    disposition: "admitted",
    layer: flight.layer,
    pathScope: flight.pathScope,
    phase,
    side,
    sourceId,
    tick,
    type: "troop-movement-admission",
  });
}

function assertMovementSourceRoster(roster, profiles) {
  if (!Array.isArray(roster) || roster.length > 8) {
    throw new TypeError("session troop movement source roster must be a bounded array");
  }
  const cards = new Map(roster.map((card) => [card.id, card]));
  for (const profile of profiles) {
    const card = cards.get(profile.id);
    if (card === undefined) continue;
    if (card.kind !== "unit") {
      throw new TypeError(`session troop movement source ${profile.id} is not a unit`);
    }
    const source = movementSourceRecord(profile.claims[0],
      `session troop movement source ${profile.id}`);
    for (const field of MOVEMENT_SOURCE_CARD_FIELDS) {
      if (canonical(card[field]) !== canonical(source[field])) {
        throw new TypeError(`session troop movement source ${profile.id}.${field} diverges from HTMP`);
      }
    }
    const expectedEntities = source.components.length === 0
      ? [{ ...source, id: source.id, role: "primary" }]
      : source.components;
    if (!Array.isArray(card.entities) || card.entities.length !== expectedEntities.length) {
      throw new TypeError(`session troop movement source ${profile.id} entity join diverges`);
    }
    for (let index = 0; index < expectedEntities.length; index += 1) {
      const expected = expectedEntities[index];
      const entity = card.entities[index];
      if (entity.archetypeId !== expected.id || entity.role !== expected.role) {
        throw new TypeError(`session troop movement source ${profile.id} entity identity diverges`);
      }
      for (const field of MOVEMENT_SOURCE_ENTITY_FIELDS) {
        if (canonical(entity[field]) !== canonical(expected[field])) {
          throw new TypeError(`session troop movement source ${profile.id} entity field diverges`);
        }
      }
    }
    const flight = movementFlightProfile(profile);
    if (flight !== null && card.entities.some(({ layer }) => layer !== "air")) {
      throw new TypeError(`session troop movement flight source ${profile.id} is not in the air layer`);
    }
  }
  return true;
}

function checkedMovementBoundary(value) {
  const boundary = exact(value, ["phase", "sources", "tick"],
    "session troop movement boundary");
  const phase = text(boundary.phase, "session troop movement boundary.phase");
  if (!CURRENT_INTENT_PHASES.has(phase)) {
    throw new TypeError("session troop movement boundary.phase is invalid");
  }
  const sources = checkedSources(boundary.sources);
  if (canonical(sources) !== canonical(boundary.sources)) {
    throw new TypeError("session troop movement boundary sources must use canonical source order");
  }
  return {
    phase,
    sources,
    tick: integer(boundary.tick, 0, Number.MAX_SAFE_INTEGER,
      "session troop movement boundary.tick"),
  };
}

function movementIntent({ cardId, claim, flight, side, sourceId, tick }) {
  return freeze({
    cardId,
    claimFamily: claim.claimFamily,
    kind: "flight",
    layer: flight.layer,
    pathScope: flight.pathScope,
    phase: "pre-move",
    side,
    sourceId,
    tick,
    type: "troop-runtime-intent",
  });
}

function checkedMovementReceipt(value) {
  const receipt = exact(value, ["manifest", "profiles", "version"],
    "session troop movement runtime receipt");
  if (receipt.version !== SESSION_TROOP_RUNTIME_MOVEMENT_VERSION ||
      typeof receipt.manifest !== "string") {
    throw new TypeError("session troop movement runtime receipt version is unsupported");
  }
  const { profiles: manifestProfiles } = movementManifestFromReceipt(receipt);
  const profiles = denseArray(receipt.profiles, MOVEMENT_PROFILE_IDS.length,
    "session troop movement runtime receipt.profiles").map((profile, index) => {
    const expected = MOVEMENT_PROFILE_CLAIMS[index];
    const checked = exact(profile, ["claims", "id"],
      `session troop movement runtime receipt.profiles[${index}]`);
    const claims = denseArray(checked.claims, expected.claims.length,
      `session troop movement runtime receipt.profiles[${index}].claims`).map((claim, claimIndex) => {
      const expectedClaim = expected.claims[claimIndex];
      const value = exact(claim, ["claimFamily", "exportName"],
        `session troop movement runtime receipt claim ${index}/${claimIndex}`);
      if (value.claimFamily !== expectedClaim.claimFamily ||
          value.exportName !== expectedClaim.exportName) {
        throw new TypeError("session troop movement runtime receipt claim diverges");
      }
      return { claimFamily: value.claimFamily, exportName: value.exportName };
    });
    if (checked.id !== expected.id || canonical(claims) !== canonical(expected.claims) ||
        manifestProfiles[index].id !== expected.id) {
      throw new TypeError("session troop movement runtime receipt profile diverges");
    }
    return { claims, id: checked.id };
  });
  const normalized = {
    manifest: receipt.manifest,
    profiles,
    version: SESSION_TROOP_RUNTIME_MOVEMENT_VERSION,
  };
  if (canonical(normalized) !== canonical(receipt)) {
    throw new TypeError("session troop movement runtime receipt is not canonical");
  }
  assertSessionTroopMovementAuthorityReceipt(canonical(normalized));
  return freeze(normalized);
}

function checkedProfiles(value) {
  if (value !== null && typeof value === "object" && value.version ===
      SESSION_TROOP_RUNTIME_MOVEMENT_VERSION) {
    return checkedMovementReceipt(value);
  }
  const set = exact(value, PROFILE_SET_KEYS, "session troop profiles");
  if (![SESSION_TROOP_RUNTIME_LEGACY_VERSION, SESSION_TROOP_RUNTIME_ACTION_PROFILE_VERSION,
    SESSION_TROOP_RUNTIME_VERSION].includes(set.version)) {
    throw new TypeError("session troop profiles version is unsupported");
  }
  const version = set.version;
  const rawProfiles = denseArray(set.profiles, SESSION_TROOP_RUNTIME_MAX_PROFILES,
    "session troop profiles.profiles");
  if (version === SESSION_TROOP_RUNTIME_VERSION) {
    if (rawProfiles.length !== 1) {
      throw new TypeError("current session troop runtime requires exactly one source profile");
    }
    return freeze({ profiles: [checkedCurrentProfile(rawProfiles[0], 0)], version });
  }
  const profiles = rawProfiles.map((profile, index) => checkedLegacyProfile(profile, index, version))
    .sort((left, right) => left.cardId.localeCompare(right.cardId));
  if (new Set(profiles.map(({ cardId }) => cardId)).size !== profiles.length) {
    throw new TypeError("session troop profiles must have unique card IDs");
  }
  return freeze({ profiles, version });
}

function checkedSource(value, index) {
  const source = exact(value, SOURCE_KEYS, `session troop runtime source[${index}]`);
  const side = text(source.side, `session troop runtime source[${index}].side`);
  if (side !== "north" && side !== "south") {
    throw new TypeError(`session troop runtime source[${index}].side is invalid`);
  }
  return {
    cardId: text(source.cardId, `session troop runtime source[${index}].cardId`),
    side,
    sourceId: integer(source.sourceId, 1, Number.MAX_SAFE_INTEGER,
      `session troop runtime source[${index}].sourceId`),
  };
}

function checkedSources(value) {
  const sources = denseArray(value, SESSION_TROOP_RUNTIME_MAX_SOURCES,
    "session troop runtime boundary.sources").map(checkedSource)
    .sort((left, right) => left.sourceId - right.sourceId);
  if (new Set(sources.map(({ sourceId }) => sourceId)).size !== sources.length) {
    throw new TypeError("session troop runtime boundary sources must be unique");
  }
  return sources;
}

function checkedActionCommand(value, label = "session troop action") {
  const action = exact(value, ACTION_COMMAND_KEYS, label);
  if (action.type !== "ability") throw new TypeError(`${label}.type is invalid`);
  const side = text(action.side, `${label}.side`);
  if (side !== "north" && side !== "south") throw new TypeError(`${label}.side is invalid`);
  const targetId = action.targetId === null ? null : integer(action.targetId, 1,
    Number.MAX_SAFE_INTEGER, `${label}.targetId`);
  return {
    actionId: text(action.actionId, `${label}.actionId`),
    commandId: integer(action.commandId, 0, Number.MAX_SAFE_INTEGER, `${label}.commandId`),
    point: checkedPoint(action.point, `${label}.point`, { nullable: true }),
    side,
    sourceId: integer(action.sourceId, 1, Number.MAX_SAFE_INTEGER, `${label}.sourceId`),
    targetId,
    tick: integer(action.tick, 0, Number.MAX_SAFE_INTEGER, `${label}.tick`),
    type: "ability",
  };
}

function checkedContact(value, index) {
  const contact = exact(value, CONTACT_KEYS, `session troop runtime contact[${index}]`);
  const sourceId = integer(contact.sourceId, 1, Number.MAX_SAFE_INTEGER,
    `session troop runtime contact[${index}].sourceId`);
  const targetId = integer(contact.targetId, 1, Number.MAX_SAFE_INTEGER,
    `session troop runtime contact[${index}].targetId`);
  if (targetId === sourceId) {
    throw new TypeError(`session troop runtime contact[${index}] self-targets`);
  }
  return {
    attackSequence: integer(contact.attackSequence, 1, Number.MAX_SAFE_INTEGER,
      `session troop runtime contact[${index}].attackSequence`),
    sourceId,
    targetId,
  };
}

function checkedLegacyBoundary(value) {
  const boundary = exact(value, ["action", "phase", "sources", "tick"],
    "session troop runtime boundary");
  const phase = text(boundary.phase, "session troop runtime boundary.phase");
  if (!LEGACY_INTENT_PHASES.has(phase)) {
    throw new TypeError("session troop runtime boundary.phase is invalid");
  }
  const action = boundary.action === null ? null : checkedActionCommand(boundary.action,
    "session troop runtime boundary.action");
  if (action !== null && phase !== "pre-combat") {
    throw new TypeError("session troop runtime actions are pre-combat only");
  }
  return {
    action,
    phase,
    sources: checkedSources(boundary.sources),
    tick: integer(boundary.tick, 0, Number.MAX_SAFE_INTEGER,
      "session troop runtime boundary.tick"),
  };
}

function checkedCurrentBoundary(value) {
  const boundary = exact(value, ["contacts", "phase", "sources", "tick"],
    "session troop runtime boundary");
  const phase = text(boundary.phase, "session troop runtime boundary.phase");
  if (!CURRENT_INTENT_PHASES.has(phase)) {
    throw new TypeError("session troop runtime boundary.phase is invalid");
  }
  const contacts = denseArray(boundary.contacts, SESSION_TROOP_RUNTIME_MAX_SOURCES,
    "session troop runtime boundary.contacts").map(checkedContact)
    .sort((left, right) => left.sourceId - right.sourceId || left.targetId - right.targetId ||
      left.attackSequence - right.attackSequence);
  if (canonical(contacts) !== canonical(boundary.contacts) ||
      new Set(contacts.map(({ attackSequence, sourceId, targetId }) =>
        `${sourceId}:${targetId}:${attackSequence}`)).size !== contacts.length) {
    throw new TypeError("session troop runtime contacts must be unique and canonically ordered");
  }
  if (phase !== "combat" && contacts.length !== 0) {
    throw new TypeError("session troop runtime contacts belong only to combat");
  }
  return {
    contacts,
    phase,
    sources: checkedSources(boundary.sources),
    tick: integer(boundary.tick, 0, Number.MAX_SAFE_INTEGER,
      "session troop runtime boundary.tick"),
  };
}

function legacyIntent({ action = null, cardId, phase, side, sourceId, tick, type }) {
  return freeze({
    actionId: action?.actionId ?? null,
    cardId,
    commandId: action?.commandId ?? null,
    kind: type,
    phase,
    point: action?.point ?? null,
    side,
    sourceId,
    targetId: action?.targetId ?? null,
    tick,
    type: "troop-runtime-intent",
  });
}

function contactIntent({ attackSequence, cardId, side, sourceId, targetId, tick }) {
  return freeze({
    attackSequence,
    cardId,
    kind: "contact",
    phase: "combat",
    side,
    sourceId,
    targetId,
    tick,
    type: "troop-runtime-intent",
  });
}

export function parseSessionTroopRuntimeProfiles(serialized) {
  if (typeof serialized !== "string") {
    throw new TypeError("session troop profiles must be canonical JSON text");
  }
  const bytes = new TextEncoder().encode(serialized).byteLength;
  const parsed = parse(serialized, "session troop profiles", bytes > MAX_BYTES ? {
    graphDepth: MOVEMENT_MAX_GRAPH_DEPTH,
    graphNodes: MOVEMENT_MAX_GRAPH_NODES,
    maximum: SESSION_TROOP_MOVEMENT_RUNTIME_MAX_RECEIPT_BYTES,
    stringLength: MOVEMENT_MAX_STRING_LENGTH,
  } : undefined);
  if (parsed.version === SESSION_TROOP_RUNTIME_MOVEMENT_VERSION) {
    const receipt = checkedMovementReceipt(parsed);
    if (canonical(receipt) !== serialized) {
      throw new TypeError("session troop movement runtime receipt must be canonical JSON");
    }
    return receipt;
  }
  if (bytes > MAX_BYTES) {
    throw new RangeError("session troop profiles exceeds its byte bound");
  }
  const checked = checkedProfiles(parsed);
  if (canonical(checked) !== serialized) {
    throw new TypeError("session troop profiles must use canonical profile ordering");
  }
  return checked;
}

export function serializeSessionTroopRuntimeProfiles(value) {
  if (value !== null && typeof value === "object" && value.version ===
      SESSION_TROOP_RUNTIME_MOVEMENT_VERSION) {
    return canonical(checkedMovementReceipt(value));
  }
  return canonical(checkedProfiles(value));
}

/** A deterministic, configuration-only reducer. */
export class SessionTroopRuntime {
  #profiles;
  #byCard;
  #movementProfiles = null;

  constructor(canonicalProfiles = EMPTY_PROFILE_BYTES) {
    this.#profiles = parseSessionTroopRuntimeProfiles(canonicalProfiles);
    if (this.#profiles.version === SESSION_TROOP_RUNTIME_MOVEMENT_VERSION) {
      const manifest = movementManifestFromReceipt(this.#profiles);
      this.#movementProfiles = manifest.profiles;
      this.#byCard = new Map(this.#movementProfiles.map((profile) => [profile.id, profile]));
      return;
    }
    this.#byCard = new Map(this.#profiles.profiles.map((profile) => [profile.cardId, profile]));
  }

  get state() {
    return freeze(clone(this.#profiles));
  }

  get configuration() {
    return this.state;
  }

  get hasProfiles() {
    return this.#profiles.profiles.length > 0;
  }

  get version() {
    return this.#profiles.version;
  }

  get allowsLegacyActions() {
    return this.#profiles.version === SESSION_TROOP_RUNTIME_LEGACY_VERSION ||
      this.#profiles.version === SESSION_TROOP_RUNTIME_ACTION_PROFILE_VERSION;
  }

  profile(cardId) {
    if (typeof cardId !== "string") throw new TypeError("session troop profile card ID must be primitive");
    const profile = this.#byCard.get(cardId);
    if (profile === undefined) return null;
    return this.#movementProfiles === null
      ? freeze(clone(profile))
      : freeze(clone(movementProfilePublic(profile)));
  }

  movementProfile(cardId) {
    if (this.#movementProfiles === null) return null;
    if (typeof cardId !== "string") {
      throw new TypeError("session troop movement profile card ID must be primitive");
    }
    const profile = this.#byCard.get(cardId);
    return profile === undefined ? null : freeze(clone(movementProfilePublic(profile)));
  }

  flightProfile(cardId) {
    if (this.#movementProfiles === null) return null;
    if (typeof cardId !== "string") {
      throw new TypeError("session troop flight profile card ID must be primitive");
    }
    const profile = this.#byCard.get(cardId);
    return profile === undefined ? null : freeze(clone(movementFlightProfile(profile)));
  }

  assertSourceRoster(roster) {
    if (this.#movementProfiles === null) return true;
    return assertMovementSourceRoster(roster, this.#movementProfiles);
  }

  inspectMovement(value) {
    if (this.#movementProfiles === null) {
      throw new RangeError("session troop runtime has no movement receipt");
    }
    const command = checkedMovementCommand(value);
    if (command.phase !== "pre-move") {
      throw new RangeError("session troop movement invocation must be pre-move");
    }
    const profile = this.#byCard.get(command.cardId);
    if (profile === undefined) {
      throw new RangeError("session troop movement card is not admitted by the HTMP receipt");
    }
    const claim = movementClaim(profile, command.claimFamily);
    const flight = command.claimFamily === "flight" ? movementFlightProfile(profile) : null;
    if (flight !== null) {
      return movementAdmission({ ...command, claim, flight });
    }
    return movementQuestion({ ...command, claim });
  }

  inspectAction({ action, source }) {
    if (!this.allowsLegacyActions) {
      throw new RangeError("current session troop runtime does not admit player actions");
    }
    const checkedAction = checkedActionCommand(action, "session troop action inspection.action");
    const checkedSourceFact = checkedSource(source, 0);
    if (checkedSourceFact.sourceId !== checkedAction.sourceId ||
        checkedSourceFact.side !== checkedAction.side) {
      throw new RangeError("session troop action source is not causal");
    }
    const profile = this.#byCard.get(checkedSourceFact.cardId);
    if (profile?.action === null || profile === undefined || profile.action.id !== checkedAction.actionId) {
      throw new RangeError("session troop action is not admitted for its source card");
    }
    if (profile.action.abilityCost !== null) {
      throw new TypeError("session troop action cost is not sourced");
    }
    if (profile.action.target === "unit" && (checkedAction.targetId === null || checkedAction.point !== null)) {
      throw new RangeError("session troop action requires exactly one unit target");
    }
    const inspected = {
      abilityCost: null,
      actionId: checkedAction.actionId,
      cardId: checkedSourceFact.cardId,
      sourceId: checkedSourceFact.sourceId,
      target: profile.action.target,
    };
    if (this.#profiles.version === SESSION_TROOP_RUNTIME_ACTION_PROFILE_VERSION) {
      inspected.effect = profile.action.effect;
    }
    return freeze(inspected);
  }

  reduce(boundary) {
    if (this.#profiles.version === SESSION_TROOP_RUNTIME_MOVEMENT_VERSION) {
      const checked = checkedMovementBoundary(boundary);
      if (checked.phase !== "pre-move") return freeze([]);
      const intents = [];
      for (const source of checked.sources) {
        const profile = this.#byCard.get(source.cardId);
        if (profile === undefined) continue;
        const claim = profile.claims.find(({ claimFamily }) => claimFamily === "flight");
        if (claim === undefined) continue;
        intents.push(movementIntent({ ...source, claim,
          flight: movementFlightProfile(profile), tick: checked.tick }));
      }
      return freeze(intents);
    }
    if (this.#profiles.version === SESSION_TROOP_RUNTIME_VERSION) {
      const checked = checkedCurrentBoundary(boundary);
      if (checked.phase !== "combat") return freeze([]);
      const intents = [];
      for (const contact of checked.contacts) {
        const source = checked.sources.find(({ sourceId }) => sourceId === contact.sourceId);
        if (source === undefined) {
          throw new RangeError("session troop contact source is absent from its host boundary");
        }
        const profile = this.#byCard.get(source.cardId);
        if (profile === undefined || profile.contact === undefined) {
          throw new RangeError("session troop contact source is not profiled");
        }
        intents.push(contactIntent({ ...contact, cardId: source.cardId, side: source.side,
          sourceId: source.sourceId, tick: checked.tick }));
      }
      return freeze(intents);
    }

    const checked = checkedLegacyBoundary(boundary);
    const intents = [];
    if (checked.action !== null) {
      const source = checked.sources.find(({ sourceId }) => sourceId === checked.action.sourceId);
      if (source === undefined) throw new RangeError("session troop action source is absent from its host boundary");
      this.inspectAction({ action: checked.action, source });
      intents.push(legacyIntent({ action: checked.action, cardId: source.cardId,
        phase: checked.phase, side: source.side, sourceId: source.sourceId,
        tick: checked.tick, type: "action" }));
      return freeze(intents);
    }
    for (const source of checked.sources) {
      const profile = this.#byCard.get(source.cardId);
      if (profile === undefined) continue;
      if (checked.phase === "deploy" && profile.deploy === "receipt-only") {
        intents.push(legacyIntent({ cardId: source.cardId, phase: checked.phase,
          side: source.side, sourceId: source.sourceId, tick: checked.tick, type: "deploy" }));
      } else if (checked.phase !== "deploy" && profile.passes.includes(checked.phase)) {
        intents.push(legacyIntent({ cardId: source.cardId, phase: checked.phase,
          side: source.side, sourceId: source.sourceId, tick: checked.tick, type: "pass" }));
      }
    }
    return freeze(intents);
  }

  serialize() {
    return canonical(this.#profiles);
  }

  fork() {
    return SessionTroopRuntime.restore(this.serialize());
  }

  static restore(serialized) {
    return new SessionTroopRuntime(serialized);
  }
}
