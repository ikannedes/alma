const POLICY_KEYS = Object.freeze([
  "authoritative", "center", "confidence", "contactOrder", "geometry",
  "radiusMillitiles", "secondaryDamage", "structureTargets", "targetLayers", "version",
]);
const AREA_POLICY = Object.freeze({
  authoritative: false,
  center: "attacker",
  confidence: "question",
  contactOrder: "ascending-entity-id",
  geometry: "circle-overlap-inclusive",
  radiusMillitiles: 2_000,
  secondaryDamage: "base-attack",
  structureTargets: "exclude",
  targetLayers: Object.freeze(["ground"]),
  version: "melee-area-question-v1",
});

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
      actual.some((key, index) => key !== expected[index]) ||
      Object.values(descriptors).some((descriptor) =>
        !descriptor.enumerable || !Object.hasOwn(descriptor, "value"))) {
    throw new TypeError(`${label} has an invalid shape`);
  }
  return Object.fromEntries(keys.map((key) => [key, descriptors[key].value]));
}

export function checkedMeleeAreaQuestionPolicy(value, label = "melee-area QUESTION policy") {
  const policy = exact(value, POLICY_KEYS, label);
  if (policy.authoritative !== false || policy.center !== AREA_POLICY.center ||
      policy.confidence !== "question" || policy.contactOrder !== AREA_POLICY.contactOrder ||
      policy.geometry !== AREA_POLICY.geometry ||
      policy.radiusMillitiles !== AREA_POLICY.radiusMillitiles ||
      policy.secondaryDamage !== AREA_POLICY.secondaryDamage ||
      policy.structureTargets !== AREA_POLICY.structureTargets ||
      policy.version !== AREA_POLICY.version || !Array.isArray(policy.targetLayers) ||
      policy.targetLayers.length !== 1 || policy.targetLayers[0] !== "ground") {
    throw new TypeError(`${label} is not the closed melee-area-question-v1 policy`);
  }
  return { ...policy, targetLayers: ["ground"] };
}

export function getSessionTroopMeleeAreaQuestionPolicy(cardId, archetypeId) {
  if (typeof cardId !== "string" || typeof archetypeId !== "string") {
    throw new TypeError("melee-area QUESTION identities must be strings");
  }
  if (cardId !== "brackenwheel") return null;
  if (archetypeId !== "brackenwheel") {
    throw new TypeError("melee-area QUESTION archetype diverges from its card identity");
  }
  return { ...AREA_POLICY, targetLayers: ["ground"] };
}

export function assertSessionTroopMeleeAreaQuestionPolicy(value, cardId, archetypeId, label) {
  const expected = getSessionTroopMeleeAreaQuestionPolicy(cardId, archetypeId);
  if (expected === null) {
    throw new RangeError(`${label} melee-area QUESTION identity is not admitted`);
  }
  const policy = checkedMeleeAreaQuestionPolicy(value, label);
  if (POLICY_KEYS.some((key) => Array.isArray(expected[key])
    ? expected[key].length !== policy[key].length ||
      expected[key].some((entry, index) => entry !== policy[key][index])
    : expected[key] !== policy[key])) {
    throw new TypeError(`${label} melee-area QUESTION diverges from its canonical card policy`);
  }
  return policy;
}
