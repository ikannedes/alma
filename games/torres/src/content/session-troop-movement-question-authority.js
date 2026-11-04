// The six movement QUESTION factories and their graph authorities live here,
// independently of every card source module.  The card modules may re-export
// their exact factory bindings, but they do not own the admission identity.

const AUTHORITY_MODULE_URL = import.meta.url;
if (typeof AUTHORITY_MODULE_URL !== "string") {
  throw "movement QUESTION authority must be loaded from its canonical module URL";
}
for (let index = 0; index < AUTHORITY_MODULE_URL.length; index += 1) {
  const codeUnit = AUTHORITY_MODULE_URL[index];
  if (codeUnit === "?" || codeUnit === "#") {
    throw "movement QUESTION authority must be loaded from its canonical module URL";
  }
  if (codeUnit !== "%") continue;
  let encodedIndex = index + 1;
  while (
    encodedIndex + 1 < AUTHORITY_MODULE_URL.length &&
    AUTHORITY_MODULE_URL[encodedIndex] === "2" &&
    AUTHORITY_MODULE_URL[encodedIndex + 1] === "5"
  ) {
    encodedIndex += 2;
  }
  const encodedDelimiter = AUTHORITY_MODULE_URL[encodedIndex];
  const encodedDelimiterTail = AUTHORITY_MODULE_URL[encodedIndex + 1];
  if (
    (encodedDelimiter === "2" && encodedDelimiterTail === "3") ||
    (encodedDelimiter === "3" &&
      (encodedDelimiterTail === "F" || encodedDelimiterTail === "f")
    )
  ) {
    throw "movement QUESTION authority must be loaded from its canonical module URL";
  }
}

const QUESTION_GRAPH_NODES = new WeakSet();
const QUESTION_GRAPH_PROTOTYPES = new WeakMap();
const QUESTION_GRAPH_DOMAINS = new WeakMap();
const MAX_QUESTION_GRAPH_NODES = 4096;

const CHARGE_DOMAIN_TOKEN = Object.freeze({});
const CHARGE_KNOCKBACK_DOMAIN_TOKEN = Object.freeze({});
const DASH_DOMAIN_TOKEN = Object.freeze({});
const JUMP_DOMAIN_TOKEN = Object.freeze({});
const RECOIL_DOMAIN_TOKEN = Object.freeze({});
const RETARGET_DOMAIN_TOKEN = Object.freeze({});

function questionGraphError(label, message) {
  throw new TypeError(`${label} ${message}`);
}

function copyQuestionGraph(source, label, domainToken) {
  const active = new Set();
  const nodes = [];

  function copy(value, path) {
    if (value === null) return null;
    const type = typeof value;
    if (type === "string" || type === "boolean") return value;
    if (type === "number") {
      if (!Number.isFinite(value) || Object.is(value, -0)) {
        questionGraphError(path, "must contain finite JSON numbers");
      }
      return value;
    }
    if (type !== "object") questionGraphError(path, "must contain JSON data");
    if (active.has(value)) questionGraphError(path, "must not contain cycles");
    if (nodes.length >= MAX_QUESTION_GRAPH_NODES) {
      questionGraphError(path, "exceeds the graph node bound");
    }

    let isArray;
    let prototype;
    let descriptors;
    try {
      isArray = Array.isArray(value);
      prototype = Object.getPrototypeOf(value);
      descriptors = Object.getOwnPropertyDescriptors(value);
    } catch {
      questionGraphError(path, "must contain inspectable data");
    }
    const ownKeys = Reflect.ownKeys(descriptors);
    let keys;
    if (isArray) {
      const lengthDescriptor = descriptors.length;
      const length = lengthDescriptor?.value;
      if (
        prototype !== Array.prototype ||
        !lengthDescriptor ||
        !Object.hasOwn(lengthDescriptor, "value") ||
        lengthDescriptor.enumerable ||
        !Number.isSafeInteger(length) ||
        length < 0 ||
        length > 128 ||
        ownKeys.length !== length + 1
      ) {
        questionGraphError(path, "must be a dense bounded data array");
      }
      keys = Array.from({ length }, (_, index) => String(index));
      if (ownKeys.some((key) => key !== "length" && !keys.includes(key))) {
        questionGraphError(path, "must contain only indexed data");
      }
    } else {
      if (prototype !== Object.prototype && prototype !== null) {
        questionGraphError(path, "must use a plain object prototype");
      }
      keys = ownKeys;
      if (keys.some((key) => typeof key !== "string")) {
        questionGraphError(path, "must contain only string data keys");
      }
    }
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        !Object.hasOwn(descriptor, "value")
      ) {
        questionGraphError(path, "must contain enumerable data properties");
      }
    }

    const target = isArray
      ? []
      : prototype === null ? Object.create(null) : {};
    nodes.push({ prototype: isArray ? Array.prototype : prototype, target });
    active.add(value);
    try {
      for (const key of keys) {
        Object.defineProperty(target, key, {
          configurable: true,
          enumerable: true,
          value: copy(descriptors[key].value, `${path}.${key}`),
          writable: true,
        });
      }
    } finally {
      active.delete(value);
    }
    return target;
  }

  const result = copy(source, label);
  for (const { prototype, target } of nodes) {
    QUESTION_GRAPH_NODES.add(target);
    QUESTION_GRAPH_PROTOTYPES.set(target, prototype);
    QUESTION_GRAPH_DOMAINS.set(target, domainToken);
  }
  return result;
}

function inspectQuestionNode(value, label, requireFrozen, domainToken) {
  // WeakSet.has is the first operation on every object.  It cannot invoke a
  // Proxy trap, so hostile aliases fail before reflection or property reads.
  if (!QUESTION_GRAPH_NODES.has(value)) {
    questionGraphError(label, "must be source-admitted data");
  }
  // The domain identity check must precede every reflective operation.  A
  // graph admitted by another mechanic factory is not interchangeable even
  // when its shape and values happen to be identical.
  if (QUESTION_GRAPH_DOMAINS.get(value) !== domainToken) {
    questionGraphError(
      label,
      "must be source-admitted data for its exact mechanic domain",
    );
  }
  if (requireFrozen && !Object.isFrozen(value)) {
    questionGraphError(label, "must be deeply frozen source data");
  }
  const expectedPrototype = QUESTION_GRAPH_PROTOTYPES.get(value);
  let actualPrototype;
  let descriptors;
  try {
    actualPrototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    questionGraphError(label, "must contain inspectable data");
  }
  if (actualPrototype !== expectedPrototype) {
    questionGraphError(label, "must retain its source-admitted prototype");
  }
  const ownKeys = Reflect.ownKeys(descriptors);
  if (expectedPrototype === Array.prototype) {
    const lengthDescriptor = descriptors.length;
    const length = lengthDescriptor?.value;
    if (
      !lengthDescriptor ||
      !Object.hasOwn(lengthDescriptor, "value") ||
      lengthDescriptor.enumerable ||
      !Number.isSafeInteger(length) ||
      length < 0 ||
      length > 128 ||
      ownKeys.length !== length + 1
    ) {
      questionGraphError(label, "must be a dense bounded data array");
    }
    const keys = Array.from({ length }, (_, index) => String(index));
    if (ownKeys.some((key) => key !== "length" && !keys.includes(key))) {
      questionGraphError(label, "must contain only indexed data");
    }
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) {
        questionGraphError(label, "must contain dense data properties");
      }
    }
    return keys;
  }
  if (ownKeys.some((key) => typeof key !== "string")) {
    questionGraphError(label, "must contain only string data keys");
  }
  for (const key of ownKeys) {
    const descriptor = descriptors[key];
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
      questionGraphError(label, "must contain enumerable data properties");
    }
  }
  return ownKeys;
}

function assertQuestionGraph(
  value,
  label = "QUESTION graph",
  requireFrozen = false,
  domainToken,
) {
  if (value === null || typeof value !== "object") {
    questionGraphError(label, "must be a source-admitted graph");
  }
  const active = new Set();
  let count = 0;

  function visit(candidate, path) {
    if (candidate === null) return;
    const type = typeof candidate;
    if (type === "string" || type === "boolean") return;
    if (type === "number") {
      if (!Number.isFinite(candidate) || Object.is(candidate, -0)) {
        questionGraphError(path, "must contain finite JSON numbers");
      }
      return;
    }
    if (type !== "object") questionGraphError(path, "must contain JSON data");
    const keys = inspectQuestionNode(candidate, path, requireFrozen, domainToken);
    if (active.has(candidate)) questionGraphError(path, "must not contain cycles");
    count += 1;
    if (count > MAX_QUESTION_GRAPH_NODES) {
      questionGraphError(path, "exceeds the graph node bound");
    }
    active.add(candidate);
    try {
      for (const key of keys) {
        visit(
          Object.getOwnPropertyDescriptor(candidate, key).value,
          `${path}.${key}`,
        );
      }
    } finally {
      active.delete(candidate);
    }
  }

  visit(value, label);
  return value;
}

function recursivelyFreezeQuestionGraph(value, label, domainToken) {
  assertQuestionGraph(value, label, false, domainToken);
  const active = new Set();

  function freezeNode(candidate) {
    if (candidate === null || typeof candidate !== "object" || active.has(candidate)) {
      return;
    }
    active.add(candidate);
    const descriptors = Object.getOwnPropertyDescriptors(candidate);
    for (const key of Reflect.ownKeys(descriptors)) {
      if (key !== "length") freezeNode(descriptors[key].value);
    }
    Object.freeze(candidate);
    active.delete(candidate);
  }

  freezeNode(value);
  return value;
}

function cloneQuestionValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function createQuestionRecordsDraft(values, source, label, domainToken) {
  return copyQuestionGraph(
    Object.fromEntries(
      Object.entries(values).map(([key, value]) => [
        key,
        {
          authoritative: false,
          confidence: "unverified",
          disposition: "question",
          key,
          source,
          value: cloneQuestionValue(value),
        },
      ]),
    ),
    label,
    domainToken,
  );
}

const CHARGE_QUESTION_PROVENANCE = Object.freeze({
  confidence: "unverified",
  disposition: "question",
  source: "unsourced-special-mechanic-fixture",
});
const CHARGE_QUESTION_VALUES = Object.freeze({
  armDistanceMillitiles: 3500,
  authoritative: false,
  bonusDamage: 392,
  chargedMovementMillitilesPerSecond: 2000,
  confidence: "unverified",
  disposition: "question",
  provenance: Object.freeze({
    armDistanceMillitiles: CHARGE_QUESTION_PROVENANCE,
    bonusDamage: CHARGE_QUESTION_PROVENANCE,
    chargedMovementMillitilesPerSecond: CHARGE_QUESTION_PROVENANCE,
  }),
  source: "unsourced-special-mechanic-fixture",
});

const CHARGE_KNOCKBACK_QUESTION_VALUES = Object.freeze({
  attackAfterDisplacement: "reach-is-recomputed-before-readiness",
  attackBoundaryInclusive: true,
  attackDamageOrder: "damage-then-death-then-charge-consumption",
  chargeArmDistanceMillitiles: 3500,
  chargeBonusDamage: 392,
  chargeConsumption: "first-ready-strike-only",
  chargeResetOnDisplacement: "any-applied-forced-displacement",
  chargeResetOnTargetChange: "any-loss-or-different-id-reacquisition",
  chargedMovementMillitilesPerSecond: 2000,
  commandPriority: "all-commands-before-selection-movement-and-readiness",
  deathInvalidation: "dead-target-is-lost-on-next-boundary",
  displacementEligibility: "living-charger-only",
  displacementGeometry: "delegate-exact-forced-knockback-projection",
  displacementRoutePolicy: "reanchor-manhattan-route-from-exact-displaced-position",
  eventOrdering: Object.freeze([
    "forced-knockback",
    "target-lost",
    "target-acquired",
    "charge-reset",
    "move",
    "charge-armed",
    "reached",
    "attack",
    "death",
    "charge-consumed",
  ]),
  firstHitAfterReacquisition: "full-54-tick-windup",
  knockbackAttackCancellation: "reach-loss-cancels-current-windup",
  movementAfterCommand: "same-boundary-after-selection",
  retargetPolicy: "sticky-valid-then-nearest-with-ascending-stable-id-ties",
  routeDistanceCompatibility: "undisplaced-trace-identical-to-content-008c",
  sightBoundaryInclusive: true,
  sightRangeCompositionMillitiles: 7000,
  targetHealthFixture: 5000,
  targetMode: "ground",
});

const DASH_QUESTION_PROVENANCE = Object.freeze({
  confidence: "unverified",
  disposition: "question",
  source: "unsourced-targeted-dash-fixture",
});
const DASH_QUESTION_VALUES = Object.freeze({
  authoritative: false,
  bonusDamage: 193,
  confidence: "unverified",
  disposition: "question",
  inclusiveLaunchBoundary: true,
  interruptionRule: "cancel-at-last-completed-position",
  interpolationRule: "integer-truncate-toward-zero",
  launchMaximumMillitiles: 6000,
  launchMinimumMillitiles: 3500,
  provenance: Object.freeze({
    bonusDamage: DASH_QUESTION_PROVENANCE,
    inclusiveLaunchBoundary: DASH_QUESTION_PROVENANCE,
    interruptionRule: DASH_QUESTION_PROVENANCE,
    interpolationRule: DASH_QUESTION_PROVENANCE,
    launchMaximumMillitiles: DASH_QUESTION_PROVENANCE,
    launchMinimumMillitiles: DASH_QUESTION_PROVENANCE,
    targetDeathRule: DASH_QUESTION_PROVENANCE,
    transitTicks: DASH_QUESTION_PROVENANCE,
    untargetableDuringTransit: DASH_QUESTION_PROVENANCE,
  }),
  source: "unsourced-targeted-dash-fixture",
  targetDeathRule: "continue-to-snapshot-and-skip-damage",
  transitTicks: 30,
  untargetableDuringTransit: true,
});

const JUMP_QUESTION_PROVENANCE = Object.freeze({
  confidence: "unverified",
  disposition: "question",
  source: "unsourced-targeted-jump-fixture",
});
const JUMP_QUESTION_VALUES = Object.freeze({
  authoritative: false,
  commandsResolveBeforeMovement: true,
  confidence: "unverified",
  destinationRule: "snapshot-at-takeoff",
  disposition: "question",
  inclusiveTriggerBoundary: true,
  interpolationRule: "integer-truncate-toward-zero",
  interruptionRule: "cancel-at-last-completed-position-without-impact",
  landingDamage: 536,
  landingMode: "ground",
  landingRadiusMillitiles: 1300,
  provenance: Object.freeze({
    commandsResolveBeforeMovement: JUMP_QUESTION_PROVENANCE,
    destinationRule: JUMP_QUESTION_PROVENANCE,
    inclusiveTriggerBoundary: JUMP_QUESTION_PROVENANCE,
    interpolationRule: JUMP_QUESTION_PROVENANCE,
    interruptionRule: JUMP_QUESTION_PROVENANCE,
    landingDamage: JUMP_QUESTION_PROVENANCE,
    landingMode: JUMP_QUESTION_PROVENANCE,
    landingRadiusMillitiles: JUMP_QUESTION_PROVENANCE,
    targetDeathRule: JUMP_QUESTION_PROVENANCE,
    transitTicks: JUMP_QUESTION_PROVENANCE,
    triggerMaximumMillitiles: JUMP_QUESTION_PROVENANCE,
    triggerMinimumMillitiles: JUMP_QUESTION_PROVENANCE,
    untargetableDuringTransit: JUMP_QUESTION_PROVENANCE,
  }),
  source: "unsourced-targeted-jump-fixture",
  targetDeathRule:
    "cancel-before-takeoff; continue-to-snapshot-after-takeoff-and-exclude-dead-target",
  transitTicks: 36,
  triggerMaximumMillitiles: 5000,
  triggerMinimumMillitiles: 3500,
  untargetableDuringTransit: true,
});

const RECOIL_QUESTION_PROVENANCE = Object.freeze({
  confidence: "unverified",
  disposition: "question",
  source: "unsourced-attack-recoil-fixture",
});
const RECOIL_QUESTION_VALUES = Object.freeze({
  authoritative: false,
  boundsRule: "clamp-center-to-radius-inset-closed-arena",
  commandsResolveBeforeLaunch: true,
  confidence: "unverified",
  directionRule: "opposite-snapshotted-target-vector",
  displacementProjectionRule:
    "euclidean-components-divide-by-exact-integer-vector-length",
  disposition: "question",
  interruptionRule:
    "interrupt-at-or-before-launch-boundary-suppresses-projectile-and-recoil",
  launchBoundaryTick: 144,
  projectileDamage: 1,
  projectileRadiusMillitiles: 0,
  projectileSpeedMillitilesPerTick: 100,
  provenance: Object.freeze({
    boundsRule: RECOIL_QUESTION_PROVENANCE,
    commandsResolveBeforeLaunch: RECOIL_QUESTION_PROVENANCE,
    directionRule: RECOIL_QUESTION_PROVENANCE,
    displacementProjectionRule: RECOIL_QUESTION_PROVENANCE,
    interruptionRule: RECOIL_QUESTION_PROVENANCE,
    launchBoundaryTick: RECOIL_QUESTION_PROVENANCE,
    projectileDamage: RECOIL_QUESTION_PROVENANCE,
    projectileRadiusMillitiles: RECOIL_QUESTION_PROVENANCE,
    projectileSpeedMillitilesPerTick: RECOIL_QUESTION_PROVENANCE,
    recoilDistanceMillitiles: RECOIL_QUESTION_PROVENANCE,
    targetDeathRule: RECOIL_QUESTION_PROVENANCE,
    timingRule: RECOIL_QUESTION_PROVENANCE,
    zeroVectorRule: RECOIL_QUESTION_PROVENANCE,
  }),
  recoilDistanceMillitiles: 2000,
  source: "unsourced-attack-recoil-fixture",
  targetDeathRule:
    "death-after-launch-does-not-undo-recoil-or-remove-in-flight-projectile",
  timingRule: "same-boundary-immediately-after-projectile-launch",
  zeroVectorRule: "reject-undefined-direction",
});

const RETARGET_QUESTION_VALUES = Object.freeze({
  attackBoundaryInclusive: true,
  attackReachEligibility: "independent-from-sight-retention",
  attackerPosition: Object.freeze({ x: 0, y: 0 }),
  attackerRadiusMillitiles: 300,
  candidateMutationPriority: "commands-before-selection",
  damageApplication: "ready-event-applies-one-damage-value",
  deathInvalidation: true,
  deathOnReadyBoundarySuppression: true,
  differentIdReacquisition: "full-first-hit-windup",
  distanceMetric: "exact-bigint-squared-center-distance",
  eligibilityLossCancellation: true,
  eligibilityReentry: "full-first-hit-windup",
  eventOrdering: Object.freeze([
    "target-lost",
    "target-acquired",
    "attack-ready",
    "damage",
    "death",
  ]),
  idLossCancellation: true,
  missingIdInvalidation: true,
  modeInvalidation: true,
  readinessPriority: "selection-before-readiness",
  sameIdReentry: "full-first-hit-windup",
  sightBoundaryInclusive: true,
  sightInvalidation: true,
  stickyRetention: "valid-current-target-is-retained",
  syntheticCandidateHealth: 1000,
  targetableInvalidation: true,
  tieBreak: "ascending-stable-id",
});

function createChargeQuestionFixture(...args) {
  if (args.length !== 0) {
    throw new TypeError("charge question fixture does not accept overrides");
  }
  return recursivelyFreezeQuestionGraph(
    copyQuestionGraph(CHARGE_QUESTION_VALUES, "charge question fixture", CHARGE_DOMAIN_TOKEN),
    "charge question fixture",
    CHARGE_DOMAIN_TOKEN,
  );
}

function assertChargeQuestionGraph(value, label = "charge question graph") {
  return assertQuestionGraph(value, label, true, CHARGE_DOMAIN_TOKEN);
}

function createChargeKnockbackQuestionRecords(...args) {
  if (args.length !== 0) {
    throw new TypeError("composition question records do not accept overrides");
  }
  return recursivelyFreezeQuestionGraph(
    createQuestionRecordsDraft(
      CHARGE_KNOCKBACK_QUESTION_VALUES,
      "unsourced-charge-forced-knockback-retarget-composition",
      "question records",
      CHARGE_KNOCKBACK_DOMAIN_TOKEN,
    ),
    "question records",
    CHARGE_KNOCKBACK_DOMAIN_TOKEN,
  );
}

function assertChargeKnockbackQuestionGraph(
  value,
  label = "charge-knockback question graph",
) {
  return assertQuestionGraph(value, label, true, CHARGE_KNOCKBACK_DOMAIN_TOKEN);
}

function createDashQuestionFixture(...args) {
  if (args.length !== 0) {
    throw new TypeError("dash question fixture does not accept overrides");
  }
  return recursivelyFreezeQuestionGraph(
    copyQuestionGraph(DASH_QUESTION_VALUES, "QUESTION fixture", DASH_DOMAIN_TOKEN),
    "QUESTION fixture",
    DASH_DOMAIN_TOKEN,
  );
}

function assertDashQuestionGraph(value, label = "dash question graph") {
  return assertQuestionGraph(value, label, true, DASH_DOMAIN_TOKEN);
}

function createJumpQuestionFixture(...args) {
  if (args.length !== 0) {
    throw new TypeError("jump question fixture does not accept overrides");
  }
  return recursivelyFreezeQuestionGraph(
    copyQuestionGraph(JUMP_QUESTION_VALUES, "QUESTION fixture", JUMP_DOMAIN_TOKEN),
    "QUESTION fixture",
    JUMP_DOMAIN_TOKEN,
  );
}

function assertJumpQuestionGraph(value, label = "jump question graph") {
  return assertQuestionGraph(value, label, true, JUMP_DOMAIN_TOKEN);
}

function createRecoilQuestionFixture(...args) {
  if (args.length !== 0) {
    throw new TypeError("recoil question fixture does not accept overrides");
  }
  return recursivelyFreezeQuestionGraph(
    copyQuestionGraph(RECOIL_QUESTION_VALUES, "QUESTION fixture", RECOIL_DOMAIN_TOKEN),
    "QUESTION fixture",
    RECOIL_DOMAIN_TOKEN,
  );
}

function assertRecoilQuestionGraph(value, label = "recoil question graph") {
  return assertQuestionGraph(value, label, true, RECOIL_DOMAIN_TOKEN);
}

function createRetargetQuestionRecords(...args) {
  if (args.length !== 0) {
    throw new TypeError("retarget question records do not accept overrides");
  }
  return recursivelyFreezeQuestionGraph(
    createQuestionRecordsDraft(
      RETARGET_QUESTION_VALUES,
      "unsourced-retarget-attack-lifecycle-composition",
      "retarget question records",
      RETARGET_DOMAIN_TOKEN,
    ),
    "question records",
    RETARGET_DOMAIN_TOKEN,
  );
}

function assertRetargetQuestionGraph(
  value,
  label = "retarget question graph",
) {
  return assertQuestionGraph(value, label, true, RETARGET_DOMAIN_TOKEN);
}

export {
  CHARGE_QUESTION_VALUES as CHARGE_QUESTION_RUNTIME,
  DASH_QUESTION_VALUES as DASH_QUESTION_RUNTIME,
  JUMP_QUESTION_VALUES as JUMP_QUESTION_RUNTIME,
  RECOIL_QUESTION_VALUES as RECOIL_QUESTION_RUNTIME,
  assertChargeKnockbackQuestionGraph,
  assertChargeQuestionGraph,
  assertDashQuestionGraph,
  assertJumpQuestionGraph,
  assertRecoilQuestionGraph,
  assertRetargetQuestionGraph,
  createChargeKnockbackQuestionRecords,
  createChargeQuestionFixture,
  createDashQuestionFixture,
  createJumpQuestionFixture,
  createRecoilQuestionFixture,
  createRetargetQuestionRecords,
};
