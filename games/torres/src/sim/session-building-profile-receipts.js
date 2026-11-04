/**
 * Canonical HBA profile receipts shared by content projection and the live
 * host. This data-only module remains inside the audited simulation graph:
 * content proves that it produces these receipts from source records, while
 * sim uses the same immutable bytes to reject caller-forged fresh metadata.
 *
 * The table itself is not exported. Consumers get only an assertion; no
 * caller-provided digest, brand, or opt-out can make a divergent profile pass.
 */
const RECEIPTS = Object.freeze({
  "aether-well": "{\"class\":\"resource\",\"deployTicks\":60,\"generationAmount\":1,\"generationCadenceTicks\":510,\"hitpoints\":1070,\"lifetimeTicks\":4200}",
  "bulwark-needle": "{\"areaDamageRadiusMillitiles\":null,\"class\":\"defensive\",\"damage\":212,\"deployTicks\":60,\"firstHitTicks\":0,\"hitSpeedTicks\":54,\"hitpoints\":824,\"lifetimeTicks\":1800,\"maxRangeMillitiles\":5500,\"minRangeMillitiles\":0,\"rampStages\":[212],\"rampThresholds\":[0],\"targetMode\":\"ground\",\"variant\":\"plain\"}",
  "buried-coil": "{\"areaDamageRadiusMillitiles\":null,\"class\":\"defensive\",\"damage\":230,\"deployTicks\":60,\"firstHitTicks\":42,\"hitSpeedTicks\":72,\"hitpoints\":1152,\"lifetimeTicks\":1800,\"maxRangeMillitiles\":5500,\"minRangeMillitiles\":0,\"rampStages\":[230],\"rampThresholds\":[0],\"targetMode\":\"air_and_ground\",\"variant\":\"hidden\"}",
  "burrow-rig": "{\"class\":\"travel\",\"deployTicks\":60,\"emergenceSpawnDelayTicks\":12,\"hitpoints\":1440,\"lifetimeTicks\":1800,\"travelSpeedMillitilesPerSecond\":1500}",
  "cinder-reliquary": "{\"class\":\"death-effect\",\"damage\":160,\"deathDamage\":200,\"deployTicks\":60,\"firstHitTicks\":60,\"hitSpeedTicks\":120,\"hitpoints\":1200,\"radius\":2000,\"rangeMillitiles\":4500,\"targetMode\":\"ground\",\"towerModifier\":{\"denominator\":100,\"numerator\":35}}",
  "ember-basin": "{\"areaDamageRadiusMillitiles\":1000,\"class\":\"defensive\",\"damage\":222,\"deployTicks\":60,\"firstHitTicks\":66,\"hitSpeedTicks\":96,\"hitpoints\":1356,\"lifetimeTicks\":1800,\"maxRangeMillitiles\":6000,\"minRangeMillitiles\":0,\"rampStages\":[222],\"rampThresholds\":[0],\"targetMode\":\"ground\",\"variant\":\"splash\"}",
  "horizon-caster": "{\"areaDamageRadiusMillitiles\":null,\"class\":\"defensive\",\"damage\":266,\"deployTicks\":210,\"firstHitTicks\":240,\"hitSpeedTicks\":300,\"hitpoints\":1369,\"lifetimeTicks\":1800,\"maxRangeMillitiles\":11500,\"minRangeMillitiles\":3000,\"rampStages\":[266],\"rampThresholds\":[0],\"targetMode\":\"ground\",\"variant\":\"siege\"}",
  "prism-furnace": "{\"areaDamageRadiusMillitiles\":null,\"class\":\"defensive\",\"damage\":42,\"deployTicks\":60,\"firstHitTicks\":72,\"hitSpeedTicks\":24,\"hitpoints\":1749,\"lifetimeTicks\":1800,\"maxRangeMillitiles\":6000,\"minRangeMillitiles\":0,\"rampStages\":[42,84,168],\"rampThresholds\":[0,2,4],\"targetMode\":\"air_and_ground\",\"variant\":\"ramp\"}",
});

const RESOURCE_V2_POLICY = Object.freeze({
  cadenceAnchorPolicy: { authoritative: false, confidence: "absent", disposition: "question",
    key: "cadenceAnchorPolicy", source: "pre-evolutions-resource-consumer-semantics-question",
    value: "placement-tick-multiples-after-deployment" },
  cadenceResetPolicy: { authoritative: false, confidence: "absent", disposition: "question",
    key: "cadenceResetPolicy", source: "pre-evolutions-resource-consumer-semantics-question",
    value: "nonlethal-damage-does-not-reset-placement-relative-cadence" },
  deployTicks: { authoritative: false, confidence: "unverified", disposition: "question",
    key: "deploy_time", source: "pinned-pre-march-2023-building-constants", value: 60 },
  destructionAmount: { authoritative: true, confidence: "high", disposition: "source-aligned",
    key: "mana_on_death", source: "https://supercell.com/en/games/clashroyale/blog/release-notes/balance-changes-april-2022/", value: 1 },
  expiryOrderingPolicy: { authoritative: false, confidence: "absent", disposition: "question",
    key: "expiryOrderingPolicy", source: "pre-evolutions-resource-consumer-semantics-question",
    value: "expiry-transition-suppresses-cadence-and-grants-after-the-destruction-event" },
  hitpoints: { authoritative: false, confidence: "unverified", disposition: "question",
    key: "hitpoints", source: "pinned-pre-march-2023-building-constants", value: 1_070 },
  generationAmount: { authoritative: false, confidence: "datamine-only", disposition: "question",
    key: "mana_collect_amount", source: "pinned-pre-march-2023-building-constants", value: 1 },
  generationCadenceTicks: { authoritative: true, confidence: "high", disposition: "source-aligned",
    key: "mana_generate_time_ms", source: "https://supercell.com/en/games/clashroyale/blog/release-notes/balance-changes-april-2022/", value: 540 },
  lifetimeTicks: { authoritative: true, confidence: "high", disposition: "source-aligned",
    key: "life_time", source: "https://supercell.com/en/games/clashroyale/blog/release-notes/balance-changes-april-2022/", value: 3_900 },
  placementPolicy: { authoritative: false, confidence: "absent", disposition: "question",
    key: "placementPolicy", source: "pre-evolutions-resource-consumer-semantics-question",
    value: "ordinary-ground-entity-deployment-mask-at-building-center" },
  recipientPolicy: { authoritative: false, confidence: "absent", disposition: "question",
    key: "resourceRecipient", source: "pre-evolutions-resource-consumer-semantics-question",
    value: "building-owner" },
  resourceCapacity: { authoritative: false, confidence: "absent", disposition: "question",
    key: "mana_generate_limit", source: "pre-evolutions-resource-consumer-semantics-question",
    value: 10 },
  sameTickOrderingPolicy: { authoritative: false, confidence: "absent", disposition: "question",
    key: "sameTickOrderingPolicy", source: "pre-evolutions-resource-consumer-semantics-question",
    value: "combat-destruction-suppresses-cadence;spends-before-natural-generation-before-building-grants" },
  simultaneousGenerationOrder: { authoritative: false, confidence: "absent", disposition: "question",
    key: "simultaneousGenerationOrder", source: "pre-evolutions-resource-consumer-semantics-question",
    value: "ascending-positive-building-id" },
  version: 2,
});
const RESOURCE_V2_PROFILE = Object.freeze({
  class: "resource", deployTicks: 60, destructionAmount: 1, generationAmount: 1,
  generationCadenceTicks: 540, hitpoints: 1_070, lifetimeTicks: 3_900,
  policy: RESOURCE_V2_POLICY,
});
const RESOURCE_V2_RECEIPT = canonical(RESOURCE_V2_PROFILE);

const NONDEFENSIVE_POLICIES = Object.freeze({
  "aether-well": Object.freeze({
    generationAmount: Object.freeze({ authoritative: false, confidence: "absent",
      disposition: "question", key: "generationAmount",
      source: "pre-evolutions-building-corpus-and-absent-resource-policy", value: 1 }),
    generationCadenceTicks: Object.freeze({ authoritative: false, confidence: "absent",
      disposition: "question", key: "generationCadenceTicks",
      source: "pre-evolutions-building-corpus-and-absent-resource-policy", value: 510 }),
    lifetimeTicks: Object.freeze({ authoritative: false, confidence: "absent",
      disposition: "question", key: "lifetimeTicks",
      source: "pre-evolutions-building-corpus-and-absent-resource-policy", value: 4200 }),
  }),
  "burrow-rig": Object.freeze({
    emergenceSpawnDelayTicks: Object.freeze({ authoritative: false, confidence: "unverified",
      disposition: "question", key: "emergenceSpawnDelayTicks",
      source: "pre-evolutions-building-corpus-and-unsourced-travel-policy", value: 12 }),
    lifetimeTicks: Object.freeze({ authoritative: false, confidence: "unverified",
      disposition: "question", key: "lifetimeTicks",
      source: "pre-evolutions-building-corpus-and-unsourced-travel-policy", value: 1800 }),
    travelSpeedMillitilesPerSecond: Object.freeze({ authoritative: false, confidence: "unverified",
      disposition: "question", key: "travelSpeedMillitilesPerSecond",
      source: "pre-evolutions-building-corpus-and-unsourced-travel-policy", value: 1500 }),
  }),
  // The schema card's `damage` field (160) remains the ordinary structure
  // attack value. This separate runtime `deathDamage` field carries the
  // isolated QUESTION record whose catalog key is also named `damage` (200).
  "cinder-reliquary": Object.freeze({
    deathDamage: Object.freeze({ authoritative: false, confidence: "unverified",
      disposition: "question", key: "damage", provenance: Object.freeze({
        accessed: "2026-07-30", document: "SOURCES.md", location: "Known limitations",
        statement: "Card abilities, including death damage and crown-tower damage multipliers, are outside the common schema.",
      }), value: 200 }),
    radius: Object.freeze({ authoritative: false, confidence: "unverified",
      disposition: "question", key: "radius", provenance: Object.freeze({
        accessed: "2026-07-30", document: "SOURCES.md", location: "Known limitations",
        statement: "Card abilities, including death damage and crown-tower damage multipliers, are outside the common schema.",
      }), value: 2000 }),
    towerModifier: Object.freeze({ authoritative: false, confidence: "unverified",
      disposition: "question", key: "towerModifier", provenance: Object.freeze({
        accessed: "2026-07-30", document: "SOURCES.md", location: "Known limitations",
        statement: "Card abilities, including death damage and crown-tower damage multipliers, are outside the common schema.",
      }), value: Object.freeze({ denominator: 100, numerator: 35 }) }),
  }),
});

const DEFENSIVE_CARD_IDS = new Set([
  "bulwark-needle", "buried-coil", "ember-basin", "horizon-caster", "prism-furnace",
]);
const CORPUS_FIELDS = Object.freeze([
  "cost", "damage", "deployTicks", "firstHitTicks", "hitSpeedTicks",
  "hitpoints", "maxRange", "mode", "sightRange",
]);
const CORPUS_VALUES = Object.freeze({
  "bulwark-needle": Object.freeze([3, 212, 60, null, 54, 824, 5500, "ground", 5500]),
  "buried-coil": Object.freeze([4, 230, 60, 42, 72, 1152, 5500, "air_and_ground", 5500]),
  "ember-basin": Object.freeze([4, 222, 60, 66, 96, 1356, 6000, "ground", 6000]),
  "horizon-caster": Object.freeze([4, 266, 210, 240, 300, 1369, 11500, "ground", 11500]),
  "prism-furnace": Object.freeze([5, 42, 60, 72, 24, 1749, 6000, "air_and_ground", 6000]),
});
const BUILDING_POLICY_SOURCE = "pre-evolutions-building-corpus-and-unsourced-policy-fixture";
const BUILDING_CORPUS_SOURCE = "pinned-pre-march-2023-building-constants";
const CARD_IDENTITY_SOURCE = "pinned-pre-march-2023-card-roster-identity";

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.keys(value).sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function defensivePolicy(cardId) {
  const values = CORPUS_VALUES[cardId];
  const corpusFields = Object.fromEntries(CORPUS_FIELDS.map((field, index) => {
    const authoritative = field === "cost" || cardId === "bulwark-needle" && field === "hitSpeedTicks";
    return [field, {
      authoritative,
      confidence: authoritative ? "high" : "unverified",
      source: field === "cost" ? CARD_IDENTITY_SOURCE : BUILDING_CORPUS_SOURCE,
      value: values[index],
    }];
  }));
  return {
    confidence: "unverified",
    corpusFields,
    disposition: "question",
    source: BUILDING_POLICY_SOURCE,
  };
}

/**
 * Accepts only the exact canonical JSON receipt associated with `cardId`.
 * The receipt is always derived by a safe local serializer after the caller's
 * outer boundary has accepted canonical JSON text.  Taking text rather than a
 * caller object makes this assertion itself non-observing for hostile object
 * values: it never reflects, enumerates, or reads a profile supplied here.
 */
export function assertSessionBuildingProfileReceipt(cardId, receipt, label = "building runtime profile") {
  if (typeof cardId !== "string" || typeof receipt !== "string" ||
      !Object.hasOwn(RECEIPTS, cardId)) {
    throw new TypeError(`${label} diverges from its canonical session-card receipt`);
  }
  if (DEFENSIVE_CARD_IDS.has(cardId)) {
    let profile;
    try { profile = JSON.parse(receipt); } catch {
      throw new TypeError(`${label} diverges from its canonical session-card receipt`);
    }
    const policy = profile?.policy;
    if (profile === null || Array.isArray(profile) || typeof profile !== "object" ||
        !Object.hasOwn(profile, "policy") || canonical(profile) !== receipt) {
      throw new TypeError(`${label} diverges from its canonical session-card receipt`);
    }
    delete profile.policy;
    if (canonical(profile) !== RECEIPTS[cardId] ||
        canonical(policy) !== canonical(defensivePolicy(cardId))) {
      throw new TypeError(`${label} diverges from its canonical session-card receipt`);
    }
    return;
  }
  if (cardId === "aether-well" && receipt === RESOURCE_V2_RECEIPT) return;
  if (Object.hasOwn(NONDEFENSIVE_POLICIES, cardId)) {
    let profile;
    try { profile = JSON.parse(receipt); } catch {
      throw new TypeError(`${label} diverges from its canonical session-card receipt`);
    }
    if (profile === null || Array.isArray(profile) || typeof profile !== "object" ||
        !Object.hasOwn(profile, "policy") || canonical(profile) !== receipt) {
      throw new TypeError(`${label} diverges from its canonical session-card receipt`);
    }
    const policy = profile.policy;
    delete profile.policy;
    if (canonical(profile) !== RECEIPTS[cardId] ||
        canonical(policy) !== canonical(NONDEFENSIVE_POLICIES[cardId])) {
      throw new TypeError(`${label} diverges from its canonical session-card receipt`);
    }
    return;
  }
  if (receipt !== RECEIPTS[cardId]) {
    throw new TypeError(`${label} diverges from its canonical session-card receipt`);
  }
}
