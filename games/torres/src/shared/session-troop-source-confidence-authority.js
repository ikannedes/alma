const SOURCE_CONFIDENCE_FIELDS = Object.freeze([
  Object.freeze({ field: "count", questionKeySuffix: "count", valueEncoding: "positive-integer" }),
  Object.freeze({ field: "damage", questionKeySuffix: "damage", valueEncoding: "positive-integer" }),
  Object.freeze({ field: "deployTimeTicks", questionKeySuffix: "deploy-time-ticks", valueEncoding: "positive-integer" }),
  Object.freeze({ field: "firstHitTicks", questionKeySuffix: "first-hit-ticks", valueEncoding: "positive-integer" }),
  Object.freeze({ field: "hitSpeedTicks", questionKeySuffix: "hit-speed-ticks", valueEncoding: "positive-integer" }),
  Object.freeze({ field: "hitpoints", questionKeySuffix: "hitpoints", valueEncoding: "positive-integer" }),
  Object.freeze({ field: "movementMillitilesPerSecond", questionKeySuffix: "movement-millitiles-per-second", valueEncoding: "positive-integer" }),
  Object.freeze({ field: "rangeMillitiles", questionKeySuffix: "range-millitiles", valueEncoding: "positive-integer" }),
  Object.freeze({ field: "sightRangeMillitiles", questionKeySuffix: "sight-range-millitiles", valueEncoding: "positive-integer" }),
  Object.freeze({ field: "targetMode", questionKeySuffix: "target-mode", valueEncoding: "target-mode-code" }),
]);
const RIME_PROJECTILE_SOURCE =
  "pinned-royaleapi-54fdef52:cards_stats_projectile#ice_wizardProjectile";
const KILNKEEPER_PROJECTILE_FIELDS = Object.freeze([
  Object.freeze({ field: "projectileSplashSourceFacts.characterAreaDamageRadiusMillitiles",
    questionKeySuffix: "character-area-damage-radius-millitiles", valueEncoding: "nonnegative-integer",
    source: "pinned-royaleapi-54fdef52:cards_stats_characters#wizard" }),
  Object.freeze({ field: "projectileSplashSourceFacts.radiusMillitiles",
    questionKeySuffix: "projectile-splash-radius-millitiles", valueEncoding: "positive-integer",
    source: "pinned-royaleapi-54fdef52:cards_stats_projectile#chr_wizardProjectile" }),
  Object.freeze({ field: "projectileSplashSourceFacts.speedRaw",
    questionKeySuffix: "projectile-speed-raw", valueEncoding: "positive-integer",
    source: "pinned-royaleapi-54fdef52:cards_stats_projectile#chr_wizardProjectile" }),
  Object.freeze({ field: "projectileSplashSourceFacts.homing",
    questionKeySuffix: "projectile-homing", valueEncoding: "boolean-code",
    source: "pinned-royaleapi-54fdef52:cards_stats_projectile#chr_wizardProjectile" }),
  Object.freeze({ field: "projectileSplashPolicy.homingRuntimePolicy.pursuitSpeedMillitilesPerTick",
    questionKeySuffix: "homing-pursuit-speed-millitiles-per-tick", valueEncoding: "positive-integer" }),
  Object.freeze({ field: "projectileSplashPolicy.homingRuntimePolicy.directionUpdateRule",
    questionKeySuffix: "homing-direction-update-rule", valueEncoding: "homing-runtime-policy-code" }),
  Object.freeze({ field: "projectileSplashPolicy.homingRuntimePolicy.directionRoundingRule",
    questionKeySuffix: "homing-direction-rounding-rule", valueEncoding: "homing-runtime-policy-code" }),
  Object.freeze({ field: "projectileSplashPolicy.homingRuntimePolicy.targetLockRule",
    questionKeySuffix: "homing-target-lock-rule", valueEncoding: "homing-runtime-policy-code" }),
  Object.freeze({ field: "projectileSplashPolicy.homingRuntimePolicy.retargetRule",
    questionKeySuffix: "homing-retarget-rule", valueEncoding: "homing-runtime-policy-code" }),
  Object.freeze({ field: "projectileSplashPolicy.homingRuntimePolicy.targetDeathRule",
    questionKeySuffix: "homing-target-death-rule", valueEncoding: "homing-runtime-policy-code" }),
  Object.freeze({ field: "projectileSplashPolicy.homingRuntimePolicy.sourceDeathRule",
    questionKeySuffix: "homing-source-death-rule", valueEncoding: "homing-runtime-policy-code" }),
  Object.freeze({ field: "projectileSplashPolicy.homingRuntimePolicy.outOfRangeRule",
    questionKeySuffix: "homing-out-of-range-rule", valueEncoding: "homing-runtime-policy-code" }),
  Object.freeze({ field: "projectileSplashPolicy.homingRuntimePolicy.outOfBoundsRule",
    questionKeySuffix: "homing-out-of-bounds-rule", valueEncoding: "homing-runtime-policy-code" }),
  Object.freeze({ field: "projectileSplashPolicy.homingRuntimePolicy.contactRadiusRule",
    questionKeySuffix: "homing-contact-radius-rule", valueEncoding: "homing-runtime-policy-code" }),
  Object.freeze({ field: "projectileSplashPolicy.homingRuntimePolicy.impactCenterRule",
    questionKeySuffix: "homing-impact-center-rule", valueEncoding: "homing-runtime-policy-code" }),
  Object.freeze({ field: "projectileSplashPolicy.homingRuntimePolicy.intermediateCollisionRule",
    questionKeySuffix: "homing-intermediate-collision-rule", valueEncoding: "homing-runtime-policy-code" }),
  Object.freeze({ field: "projectileSplashPolicy.homingRuntimePolicy.arrivalBoundaryRule",
    questionKeySuffix: "homing-arrival-boundary-rule", valueEncoding: "homing-runtime-policy-code" }),
  Object.freeze({ field: "projectileSplashPolicy.homingRuntimePolicy.contactOrderRule",
    questionKeySuffix: "homing-contact-order-rule", valueEncoding: "homing-runtime-policy-code" }),
  Object.freeze({ field: "projectileSplashSourceFacts.aoeToAir",
    questionKeySuffix: "projectile-aoe-to-air", valueEncoding: "boolean-code",
    source: "pinned-royaleapi-54fdef52:cards_stats_projectile#chr_wizardProjectile" }),
  Object.freeze({ field: "projectileSplashSourceFacts.aoeToGround",
    questionKeySuffix: "projectile-aoe-to-ground", valueEncoding: "boolean-code",
    source: "pinned-royaleapi-54fdef52:cards_stats_projectile#chr_wizardProjectile" }),
  Object.freeze({ field: "projectileSplashSourceFacts.onlyEnemies",
    questionKeySuffix: "projectile-only-enemies", valueEncoding: "boolean-code",
    source: "pinned-royaleapi-54fdef52:cards_stats_projectile#chr_wizardProjectile" }),
]);
const RIME_PROJECTILE_QUESTION_FIELDS = Object.freeze([
  Object.freeze({ field: "projectileSplashSourceFacts.speedRaw",
    questionKeySuffix: "projectile-speed-raw", valueEncoding: "positive-integer",
    source: RIME_PROJECTILE_SOURCE }),
  Object.freeze({ field: "projectileSplashSourceFacts.homing",
    questionKeySuffix: "projectile-homing", valueEncoding: "boolean-code",
    source: RIME_PROJECTILE_SOURCE }),
  Object.freeze({ field: "projectileSplashSourceFacts.gravityRaw",
    questionKeySuffix: "projectile-gravity-raw", valueEncoding: "positive-integer",
    source: RIME_PROJECTILE_SOURCE }),
  Object.freeze({ field: "projectileSplashPolicy.homingRuntimePolicy.pursuitSpeedMillitilesPerTick",
    questionKeySuffix: "homing-pursuit-speed-millitiles-per-tick", valueEncoding: "positive-integer" }),
  Object.freeze({ field: "projectileSplashPolicy.homingRuntimePolicy.directionUpdateRule",
    questionKeySuffix: "homing-direction-update-rule", valueEncoding: "homing-runtime-policy-code" }),
  Object.freeze({ field: "projectileSplashPolicy.homingRuntimePolicy.directionRoundingRule",
    questionKeySuffix: "homing-direction-rounding-rule", valueEncoding: "homing-runtime-policy-code" }),
  Object.freeze({ field: "projectileSplashPolicy.homingRuntimePolicy.targetLockRule",
    questionKeySuffix: "homing-target-lock-rule", valueEncoding: "homing-runtime-policy-code" }),
  Object.freeze({ field: "projectileSplashPolicy.homingRuntimePolicy.retargetRule",
    questionKeySuffix: "homing-retarget-rule", valueEncoding: "homing-runtime-policy-code" }),
  Object.freeze({ field: "projectileSplashPolicy.homingRuntimePolicy.targetDeathRule",
    questionKeySuffix: "homing-target-death-rule", valueEncoding: "homing-runtime-policy-code" }),
  Object.freeze({ field: "projectileSplashPolicy.homingRuntimePolicy.sourceDeathRule",
    questionKeySuffix: "homing-source-death-rule", valueEncoding: "homing-runtime-policy-code" }),
  Object.freeze({ field: "projectileSplashPolicy.homingRuntimePolicy.outOfRangeRule",
    questionKeySuffix: "homing-out-of-range-rule", valueEncoding: "homing-runtime-policy-code" }),
  Object.freeze({ field: "projectileSplashPolicy.homingRuntimePolicy.outOfBoundsRule",
    questionKeySuffix: "homing-out-of-bounds-rule", valueEncoding: "homing-runtime-policy-code" }),
  Object.freeze({ field: "projectileSplashPolicy.homingRuntimePolicy.contactRadiusRule",
    questionKeySuffix: "homing-contact-radius-rule", valueEncoding: "homing-runtime-policy-code" }),
  Object.freeze({ field: "projectileSplashPolicy.homingRuntimePolicy.impactCenterRule",
    questionKeySuffix: "homing-impact-center-rule", valueEncoding: "homing-runtime-policy-code" }),
  Object.freeze({ field: "projectileSplashPolicy.homingRuntimePolicy.intermediateCollisionRule",
    questionKeySuffix: "homing-intermediate-collision-rule", valueEncoding: "homing-runtime-policy-code" }),
  Object.freeze({ field: "projectileSplashPolicy.homingRuntimePolicy.arrivalBoundaryRule",
    questionKeySuffix: "homing-arrival-boundary-rule", valueEncoding: "homing-runtime-policy-code" }),
  Object.freeze({ field: "projectileSplashPolicy.homingRuntimePolicy.contactOrderRule",
    questionKeySuffix: "homing-contact-order-rule", valueEncoding: "homing-runtime-policy-code" }),
]);

const MELEE_AREA_QUESTION_FIELDS = Object.freeze([
  Object.freeze({ field: "areaDamageRadiusMillitiles",
    questionKeySuffix: "area-damage-radius-millitiles", valueEncoding: "positive-integer" }),
  Object.freeze({ field: "meleeAreaPolicy.contactOrder",
    questionKeySuffix: "melee-area-contact-order", valueEncoding: "melee-area-contact-order-code" }),
]);

const SOURCE_CONFIDENCE_CLAIMS = Object.freeze([
  Object.freeze({ cardId: "brackenwheel", archetypeId: "brackenwheel" }),
  Object.freeze({ cardId: "briar-band", archetypeId: "briar-runner" }),
  Object.freeze({ cardId: "briar-band", archetypeId: "briar-darter" }),
  Object.freeze({ cardId: "gloamwing-cluster", archetypeId: "gloamwing" }),
  Object.freeze({ cardId: "kilnkeeper", archetypeId: "kilnkeeper" }),
  Object.freeze({ cardId: "rime-adept", archetypeId: "rime-adept" }),
  Object.freeze({ cardId: "coppershade-flock", archetypeId: "coppershade" }),
  Object.freeze({ cardId: "duskwing-trio", archetypeId: "duskwing" }),
  Object.freeze({ cardId: "forgeguard", archetypeId: "forgeguard" }),
  Object.freeze({ cardId: "sunthread-pair", archetypeId: "sunthread-warden" }),
  Object.freeze({ cardId: "thornscouts", archetypeId: "thornscout" }),
]);
const DEPLOYMENT_INTERVAL = Object.freeze({
  milliseconds: 100,
  sourceId: "supercell-2020-06-02-multi-unit-deployment",
  ticks: 6,
});

const TARGET_MODE_CODES = Object.freeze({
  buildings: 1,
  ground: 2,
  "ground-and-air": 3,
  structures: 4,
});
const DEFAULT_QUESTION_SOURCE = "runtime-playability-estimate-not-comparison-corpus";
const KILNKEEPER_DAMAGE_SOURCE =
  "pinned-royaleapi-54fdef52:cards_stats_projectile#chr_wizardProjectile";
const ZERO_QUESTION_KEYS = new Set([
  "kilnkeeper.character-area-damage-radius-millitiles",
]);
const HOMING_RUNTIME_POLICY_CODES = Object.freeze({
  "aim-after-unit-motion-each-boundary": 1,
  "after-motion-before-simultaneous-damage": 2,
  "ceil-distance-truncate-components-toward-zero": 3,
  "continue-after-launch": 4,
  "continue-after-launch-range": 5,
  "continue-while-position-is-valid": 6,
  "first-boundary-reaching-contact-radius": 7,
  "fizzle-on-first-boundary-after-death": 8,
  "live-target-center": 9,
  "never-reacquire": 10,
  "no-intermediate-collision": 11,
  "retain-launch-target-id": 12,
  "target-body-radius": 13,
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

function expectedPolicy(archetypeId) {
  const fields = archetypeId === "rime-adept"
    ? RIME_PROJECTILE_QUESTION_FIELDS
    : [...SOURCE_CONFIDENCE_FIELDS,
      ...(archetypeId === "brackenwheel" ? MELEE_AREA_QUESTION_FIELDS : []),
      ...(archetypeId === "kilnkeeper" ? KILNKEEPER_PROJECTILE_FIELDS : [])];
  return {
    ...(archetypeId === "brackenwheel" || archetypeId === "rime-adept"
      ? {} : { deploymentInterval: { ...DEPLOYMENT_INTERVAL } }),
    fields: fields.map(({ field, questionKeySuffix, valueEncoding, source }) => {
      const provenance = source ?? (archetypeId === "kilnkeeper" && field === "damage"
        ? KILNKEEPER_DAMAGE_SOURCE
        : undefined);
      return {
        field,
        questionKey: `${archetypeId}.${questionKeySuffix}`,
        valueEncoding,
        ...(provenance === undefined ? {} : { source: provenance }),
      };
    }),
  };
}

export function getSessionTroopSourceConfidencePolicy(cardId, archetypeId) {
  if (typeof cardId !== "string" || typeof archetypeId !== "string") {
    throw new TypeError("session troop confidence identities must be strings");
  }
  const cardClaims = SOURCE_CONFIDENCE_CLAIMS.filter((candidate) => candidate.cardId === cardId);
  if (cardClaims.length === 0) return null;
  const claim = cardClaims.find((candidate) => candidate.archetypeId === archetypeId);
  if (claim === undefined) {
    throw new TypeError("session troop source confidence archetype diverges from its card identity");
  }
  return expectedPolicy(archetypeId);
}

export function assertSessionTroopSourceConfidencePolicy(value, cardId, archetypeId) {
  const expected = getSessionTroopSourceConfidencePolicy(cardId, archetypeId);
  if (expected === null) {
    throw new RangeError("session troop source confidence identity is not admitted");
  }
  const expectedShape = expected.deploymentInterval === undefined
    ? ["fields"] : ["deploymentInterval", "fields"];
  const policy = exact(value, expectedShape, "session troop source confidence policy");
  if (!Array.isArray(policy.fields) || policy.fields.length !== expected.fields.length) {
    throw new TypeError("session troop source confidence field inventory is incomplete");
  }
  const fields = policy.fields.map((raw, index) => {
    const reference = expected.fields[index];
    const record = exact(raw, reference.source === undefined
      ? ["field", "questionKey", "valueEncoding"]
      : ["field", "questionKey", "source", "valueEncoding"],
      `session troop source confidence policy.fields[${index}]`);
    if (record.field !== reference.field || record.questionKey !== reference.questionKey ||
        record.valueEncoding !== reference.valueEncoding || record.source !== reference.source) {
      throw new TypeError("session troop source confidence field inventory diverges");
    }
    return { field: record.field, questionKey: record.questionKey,
      valueEncoding: record.valueEncoding,
      ...(reference.source === undefined ? {} : { source: reference.source }) };
  });
  if (expected.deploymentInterval === undefined) return { fields };
  const interval = exact(policy.deploymentInterval, ["milliseconds", "sourceId", "ticks"],
    "session troop deployment interval receipt");
  if (interval.milliseconds !== DEPLOYMENT_INTERVAL.milliseconds ||
      interval.sourceId !== DEPLOYMENT_INTERVAL.sourceId ||
      interval.ticks !== DEPLOYMENT_INTERVAL.ticks) {
    throw new TypeError("session troop deployment interval receipt diverges");
  }
  return { deploymentInterval: interval, fields };
}

export function encodeSessionTroopSourceConfidenceValue(valueEncoding, value) {
  if (valueEncoding === "nonnegative-integer") {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError("session troop source confidence value must be a nonnegative integer");
    }
    return value;
  }
  if (valueEncoding === "positive-integer") {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new TypeError("session troop source confidence value must be a positive integer");
    }
    return value;
  }
  if (valueEncoding === "target-mode-code") {
    if (typeof value !== "string" || !Object.hasOwn(TARGET_MODE_CODES, value)) {
      throw new TypeError("session troop source confidence target mode is invalid");
    }
    return TARGET_MODE_CODES[value];
  }
  if (valueEncoding === "boolean-code") {
    if (typeof value !== "boolean") {
      throw new TypeError("session troop source confidence boolean is invalid");
    }
    return value ? 1 : 0;
  }
  if (valueEncoding === "melee-area-contact-order-code") {
    if (value !== "ascending-entity-id") {
      throw new TypeError("session troop melee-area contact order QUESTION is invalid");
    }
    return 1;
  }
  if (valueEncoding === "homing-runtime-policy-code") {
    if (typeof value !== "string" || !Object.hasOwn(HOMING_RUNTIME_POLICY_CODES, value)) {
      throw new TypeError("session troop homing runtime QUESTION policy is invalid");
    }
    return HOMING_RUNTIME_POLICY_CODES[value];
  }
  throw new TypeError("session troop source confidence value encoding is not admitted");
}

export function sessionTroopSourceQuestionMinimum(key) {
  return ZERO_QUESTION_KEYS.has(key) ? 0 : 1;
}

function confidenceFieldValue(entity, path) {
  return path.split(".").reduce((value, key) => value?.[key], entity);
}

export function assertSessionTroopSourceConfidenceQuestions({
  present, value, cardId, archetypeId, entity, questionKeys, questionValues, questionSources,
  referencedQuestionKeys, label,
}) {
  const expected = getSessionTroopSourceConfidencePolicy(cardId, archetypeId);
  if ((expected !== null) !== present) {
    throw new TypeError(`${label} source confidence policy is missing or unexpected`);
  }
  if (!present) return null;
  const policy = assertSessionTroopSourceConfidencePolicy(value, cardId, archetypeId);
  for (const field of policy.fields) {
    if (!questionKeys.has(field.questionKey)) {
      throw new TypeError(`${label} source confidence field lacks a QUESTION record`);
    }
    const expectedValue = encodeSessionTroopSourceConfidenceValue(
      field.valueEncoding, confidenceFieldValue(entity, field.field),
    );
    if (questionValues.get(field.questionKey) !== expectedValue) {
      throw new TypeError(`${label} source confidence QUESTION diverges from its estimate`);
    }
    if (questionSources.get(field.questionKey) !== (field.source ?? DEFAULT_QUESTION_SOURCE)) {
      throw new TypeError(`${label} source confidence QUESTION provenance diverges`);
    }
    referencedQuestionKeys.add(field.questionKey);
  }
  return policy;
}
