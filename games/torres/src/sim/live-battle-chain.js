export const LIVE_BATTLE_CHAIN_SCHEMA_VERSION = 1;
export const LIVE_BATTLE_CHAIN_MAX_PENDING_ROOTS = 1_024;

const POLICY_KIND = "execute-question-model-v1";
const POLICY_KEYS = ["cardId", "claimFamily", "kind", "questions"];
const QUESTION_KEYS = [
  "authoritative", "confidence", "disposition", "source", "value",
];
const IDENTITY_KEYS = ["attackSequence", "direction", "projectileId", "sourceId"];
const ROOT_KEYS = [
  "anchor", "dueTick", "identity", "launchTargetId", "launchTick", "ordinal",
  "phase", "sourceSide", "visited",
];
const ANCHOR_KEYS = ["owner", "position", "radius"];
const OWNER_KEYS = ["id", "kind"];
const SNAPSHOT_KEYS = ["configuration", "pending", "schemaVersion"];
const SOURCE_SIDES = new Set(["north", "south"]);
const PROJECTILE_DIRECTIONS = new Set(["unit-to-tower", "unit-to-unit"]);
const OWNER_KINDS = new Set(["building", "crown-tower", "unit"]);
const CHAIN_QUESTION_SOURCE = "unsourced-chained-target-attack-fixture";
function question(value) {
  return Object.freeze({
    authoritative: false,
    confidence: "unverified",
    disposition: "question",
    source: CHAIN_QUESTION_SOURCE,
    value,
  });
}
const QUESTION_FIXTURES = Object.freeze({
  attackerCancellationRule: question(
    "death-through-primary-boundary-cancels;death-after-primary-does-not-cancel",
  ),
  candidateDeathRule: question("dead-before-selection-is-ineligible"),
  damagePerHop: question(192),
  eventOrderRule: question(
    "commands-then-start-hit-damage-death-then-pending-or-complete",
  ),
  hopDelayTicks: question(1),
  hopRangeMillitiles: question(3000),
  lethalHopRule: question(
    "lethal-current-hit-keeps-snapshotted-origin-and-does-not-cancel-continuation",
  ),
  rangeRule: question("circle-edge-to-circle-edge-inclusive"),
  selectionRule: question(
    "explicit-primary-then-nearest-eligible-unhit-center-distance-stable-id",
  ),
  targetCap: question(3),
  targetEligibilityRule: question("alive-targetable-ground-or-air-troops-and-structures"),
});
const QUESTION_SOURCE = QUESTION_FIXTURES.damagePerHop.source;
const ATTRIBUTION_QUESTION_SOURCE = "unsourced-live-battle-chain-owner-attribution-question";

function deepFrozenQuestionCopy() {
  return Object.freeze(Object.fromEntries(
    Object.entries(QUESTION_FIXTURES).map(([key, record]) => [
      key,
      Object.freeze({ ...record }),
    ]),
  ));
}

export function createChainQuestionFixture(...args) {
  if (args.length !== 0) {
    throw new TypeError("chain question fixture does not accept overrides");
  }
  return deepFrozenQuestionCopy();
}

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

function plain(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype &&
       Object.getPrototypeOf(value) !== null) || Object.getOwnPropertySymbols(value).length !== 0) {
    throw new TypeError(`${label} must be a plain string-keyed data object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
      throw new TypeError(`${label}.${key} must be an enumerable data property`);
    }
  }
  return descriptors;
}

function exact(value, keys, label) {
  const descriptors = plain(value, label);
  const actual = Reflect.ownKeys(descriptors).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length ||
      actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${label} has an invalid shape`);
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

function checkedQuestion(value, expected, key) {
  const label = `Stormkite chain QUESTION ${key}`;
  const record = exact(value, QUESTION_KEYS, label);
  if (record.authoritative !== false || record.confidence !== "unverified" ||
      record.disposition !== "question" || record.source !== expected.source ||
      canonical(record.value) !== canonical(expected.value)) {
    throw new TypeError(`${label} does not match its current non-authoritative record`);
  }
  return {
    authoritative: false,
    confidence: "unverified",
    disposition: "question",
    source: expected.source,
    value: clone(expected.value),
  };
}

function expectedQuestions() {
  return {
    ...createChainQuestionFixture(),
    simultaneousContactAttributionRule: {
      authoritative: false,
      confidence: "unverified",
      disposition: "question",
      source: ATTRIBUTION_QUESTION_SOURCE,
      value: "positive-same-target-contacts-share-any-positive-canonical-owner-loss-on-the-boundary",
    },
  };
}

export function createStormkiteChainQuestionPolicy() {
  const questions = expectedQuestions();
  return freeze({
    cardId: "stormkite",
    claimFamily: "chain",
    kind: POLICY_KIND,
    questions: Object.fromEntries(Object.keys(questions).sort().map((key) =>
      [key, clone(questions[key])])),
  });
}

export function admitStormkiteChainQuestionPolicy(value) {
  const policy = exact(value, POLICY_KEYS, "live battle chain question policy");
  if (policy.kind !== POLICY_KIND || policy.cardId !== "stormkite" ||
      policy.claimFamily !== "chain") {
    throw new TypeError("live battle chain policy must name the Stormkite chain question model");
  }
  const expected = expectedQuestions();
  const actual = plain(policy.questions, "live battle chain question policy.questions");
  const actualKeys = Reflect.ownKeys(actual).sort();
  const expectedKeys = Object.keys(expected).sort();
  if (actualKeys.length !== expectedKeys.length ||
      actualKeys.some((key, index) => key !== expectedKeys[index])) {
    throw new TypeError("live battle chain question policy must carry every exact QUESTION record");
  }
  const questions = Object.fromEntries(expectedKeys.map((key) =>
    [key, checkedQuestion(actual[key].value, expected[key], key)]));
  return freeze({ cardId: "stormkite", claimFamily: "chain", kind: POLICY_KIND, questions });
}

function checkedIdentity(value, label) {
  const identity = exact(value, IDENTITY_KEYS, label);
  if (!PROJECTILE_DIRECTIONS.has(identity.direction)) {
    throw new TypeError(`${label}.direction is invalid`);
  }
  return {
    attackSequence: integer(identity.attackSequence, 0, Number.MAX_SAFE_INTEGER,
      `${label}.attackSequence`),
    direction: identity.direction,
    projectileId: integer(identity.projectileId, 1, Number.MAX_SAFE_INTEGER,
      `${label}.projectileId`),
    sourceId: integer(identity.sourceId, 1, Number.MAX_SAFE_INTEGER, `${label}.sourceId`),
  };
}

function checkedOwner(value, label) {
  const owner = exact(value, OWNER_KEYS, label);
  if (!OWNER_KINDS.has(owner.kind)) throw new TypeError(`${label}.kind is invalid`);
  return {
    id: owner.kind === "crown-tower"
      ? checkedText(owner.id, `${label}.id`)
      : integer(owner.id, 1, Number.MAX_SAFE_INTEGER, `${label}.id`),
    kind: owner.kind,
  };
}

function checkedText(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.length > 128) {
    throw new TypeError(`${label} must be a bounded non-empty string`);
  }
  return value;
}

function checkedPosition(value, label) {
  const point = exact(value, ["x", "y"], label);
  return {
    x: integer(point.x, 0, Number.MAX_SAFE_INTEGER, `${label}.x`),
    y: integer(point.y, 0, Number.MAX_SAFE_INTEGER, `${label}.y`),
  };
}

function checkedAnchor(value, label) {
  const anchor = exact(value, ANCHOR_KEYS, label);
  return {
    owner: checkedOwner(anchor.owner, `${label}.owner`),
    position: checkedPosition(anchor.position, `${label}.position`),
    radius: integer(anchor.radius, 0, Number.MAX_SAFE_INTEGER, `${label}.radius`),
  };
}

function ownerKey(owner) {
  const id = typeof owner.id === "number" ? `n:${String(owner.id).padStart(16, "0")}` : `s:${owner.id}`;
  return `${owner.kind}:${id}`;
}

function identityKey(identity) {
  return `${identity.sourceId}:${identity.attackSequence}:${identity.projectileId}:${identity.direction}`;
}

function lineageKey(identity, ordinal) {
  return `${identityKey(identity)}:${ordinal}`;
}

function ingressSourceId(identity, ordinal) {
  return `chain:${lineageKey(identity, ordinal)}`;
}

function checkedRoot(value, index) {
  const label = `live battle chain pending[${index}]`;
  const root = exact(value, ROOT_KEYS, label);
  const phase = root.phase;
  if (phase !== "primary-flight" && phase !== "hop-pending") {
    throw new TypeError(`${label}.phase is invalid`);
  }
  const sourceSide = root.sourceSide;
  if (!SOURCE_SIDES.has(sourceSide)) throw new TypeError(`${label}.sourceSide is invalid`);
  const identity = checkedIdentity(root.identity, `${label}.identity`);
  const launchTick = integer(root.launchTick, 0, 18_000, `${label}.launchTick`);
  const launchTargetId = root.launchTargetId === null ? null : integer(root.launchTargetId, 1,
    Number.MAX_SAFE_INTEGER, `${label}.launchTargetId`);
  const visited = dense(root.visited, 16, `${label}.visited`)
    .map((owner, ownerIndex) => checkedOwner(owner, `${label}.visited[${ownerIndex}]`));
  if (new Set(visited.map(ownerKey)).size !== visited.length) {
    throw new TypeError(`${label}.visited identities must be unique`);
  }
  if (phase === "primary-flight") {
    if (root.anchor !== null || root.dueTick !== null || root.ordinal !== 0 || visited.length !== 0 ||
        launchTargetId === null) {
      throw new TypeError(`${label} primary flight state is inconsistent`);
    }
    return { anchor: null, dueTick: null, identity, launchTargetId, launchTick, ordinal: 0,
      phase, sourceSide, visited };
  }
  const anchor = checkedAnchor(root.anchor, `${label}.anchor`);
  const dueTick = integer(root.dueTick, launchTick, 18_000, `${label}.dueTick`);
  const ordinal = integer(root.ordinal, 1, 16, `${label}.ordinal`);
  if (launchTargetId !== null || visited.length !== ordinal ||
      ownerKey(visited.at(-1)) !== ownerKey(anchor.owner)) {
    throw new TypeError(`${label} pending hop lineage is inconsistent`);
  }
  return { anchor, dueTick, identity, launchTargetId: null, launchTick, ordinal, phase, sourceSide, visited };
}

function distanceSquared(left, right) {
  const dx = BigInt(left.x) - BigInt(right.x);
  const dy = BigInt(left.y) - BigInt(right.y);
  return dx * dx + dy * dy;
}

function checkedCandidate(value, index) {
  const label = `live battle chain candidate[${index}]`;
  const candidate = exact(value, ["alive", "hostId", "layer", "owner", "position", "radius", "side",
    "targetable"], label);
  if (typeof candidate.alive !== "boolean" || typeof candidate.targetable !== "boolean") {
    throw new TypeError(`${label} liveness flags are invalid`);
  }
  if (!SOURCE_SIDES.has(candidate.side)) throw new TypeError(`${label}.side is invalid`);
  if (candidate.layer !== "air" && candidate.layer !== "ground") {
    throw new TypeError(`${label}.layer is invalid`);
  }
  const owner = checkedOwner(candidate.owner, `${label}.owner`);
  if (owner.kind !== "unit" && candidate.layer !== "ground") {
    throw new TypeError(`${label} structure layer is invalid`);
  }
  const hostId = integer(candidate.hostId, 1, Number.MAX_SAFE_INTEGER, `${label}.hostId`);
  return {
    alive: candidate.alive,
    hostId,
    layer: candidate.layer,
    owner,
    position: checkedPosition(candidate.position, `${label}.position`),
    radius: integer(candidate.radius, 0, Number.MAX_SAFE_INTEGER, `${label}.radius`),
    side: candidate.side,
    targetable: candidate.targetable,
  };
}

function checkedSnapshotRoot(value, index) {
  return checkedRoot(value, index);
}

export class LiveBattleChainContinuation {
  #configuration;
  #pending = [];

  constructor(policy) {
    this.#configuration = admitStormkiteChainQuestionPolicy(policy);
  }

  get policy() {
    return this.#configuration;
  }

  get pendingCount() {
    return this.#pending.length;
  }

  launch({ identity: rawIdentity, primaryTargetId, sourceSide, tick }) {
    const identity = checkedIdentity(rawIdentity, "live battle chain primary identity");
    const targetId = integer(primaryTargetId, 1, Number.MAX_SAFE_INTEGER,
      "live battle chain primary target ID");
    if (!SOURCE_SIDES.has(sourceSide)) throw new TypeError("live battle chain source side is invalid");
    const launchTick = integer(tick, 0, 18_000, "live battle chain primary launch tick");
    if (this.#pending.some((root) => identityKey(root.identity) === identityKey(identity))) {
      throw new RangeError("live battle chain primary identity is already pending");
    }
    if (this.#pending.length >= LIVE_BATTLE_CHAIN_MAX_PENDING_ROOTS) {
      throw new RangeError("live battle chain pending root bound exceeded");
    }
    this.#pending.push({ anchor: null, dueTick: null, identity, launchTargetId: targetId,
      launchTick, ordinal: 0, phase: "primary-flight", sourceSide, visited: [] });
    this.#pending.sort((left, right) => {
      const leftKey = identityKey(left.identity);
      const rightKey = identityKey(right.identity);
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    });
  }

  hasPrimaryFlight(rawIdentity) {
    const identity = checkedIdentity(rawIdentity, "live battle chain launch lookup identity");
    return this.#pending.some((root) => root.phase === "primary-flight" &&
      identityKey(root.identity) === identityKey(identity));
  }

  primarySourceSide(rawIdentity) {
    const identity = checkedIdentity(rawIdentity, "live battle chain source-side lookup identity");
    return this.#pending.find((root) => root.phase === "primary-flight" &&
      identityKey(root.identity) === identityKey(identity))?.sourceSide ?? null;
  }

  planDue(tick, rawCandidates) {
    const currentTick = integer(tick, 0, 18_000, "live battle chain planning tick");
    const candidates = dense(rawCandidates, 4_096, "live battle chain candidates")
      .map(checkedCandidate);
    const plans = [];
    for (const root of this.#pending) {
      if (root.phase !== "hop-pending") continue;
      if (root.dueTick < currentTick) throw new RangeError("live battle chain pending hop is overdue");
      if (root.dueTick !== currentTick) continue;
      const visited = new Set(root.visited.map(ownerKey));
      const eligible = candidates.filter((candidate) => candidate.alive && candidate.targetable &&
        candidate.side !== root.sourceSide && OWNER_KINDS.has(candidate.owner.kind) &&
        (candidate.owner.kind !== "unit" || candidate.layer === "ground" || candidate.layer === "air") &&
        !visited.has(ownerKey(candidate.owner)));
      const range = this.#configuration.questions.hopRangeMillitiles.value;
      const inRange = eligible.filter((candidate) => {
        const reach = BigInt(root.anchor.radius) + BigInt(range) + BigInt(candidate.radius);
        return distanceSquared(root.anchor.position, candidate.position) <= reach * reach;
      });
      inRange.sort((left, right) => {
        const distanceOrder = distanceSquared(root.anchor.position, left.position) -
          distanceSquared(root.anchor.position, right.position);
        if (distanceOrder !== 0n) return distanceOrder < 0n ? -1 : 1;
        if (left.hostId !== right.hostId) return left.hostId < right.hostId ? -1 : 1;
        const leftKey = ownerKey(left.owner);
        const rightKey = ownerKey(right.owner);
        return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
      });
      const target = inRange[0] ?? null;
      plans.push({
        damage: this.#configuration.questions.damagePerHop.value,
        identity: clone(root.identity),
        ingressSourceId: ingressSourceId(root.identity, root.ordinal),
        lineage: { primaryProjectileIdentity: clone(root.identity), hopOrdinal: root.ordinal },
        ordinal: root.ordinal,
        sourceSide: root.sourceSide,
        target: target === null ? null : clone(target),
      });
    }
    return plans;
  }

  settlePrimary(rawIdentity, { ownerConfirmed, sourceAlive, target, tick }) {
    const identity = checkedIdentity(rawIdentity, "live battle chain primary settlement identity");
    const rootIndex = this.#pending.findIndex((root) => root.phase === "primary-flight" &&
      identityKey(root.identity) === identityKey(identity));
    if (rootIndex === -1) throw new RangeError("live battle chain primary settlement has no launch");
    const root = this.#pending[rootIndex];
    const currentTick = integer(tick, root.launchTick, 18_000, "live battle chain primary settlement tick");
    if (typeof ownerConfirmed !== "boolean" || typeof sourceAlive !== "boolean") {
      throw new TypeError("live battle chain primary settlement result is invalid");
    }
    if (!ownerConfirmed || !sourceAlive || target === null) {
      this.#pending.splice(rootIndex, 1);
      return { status: ownerConfirmed ? "cancelled" : "miss", target: null };
    }
    const anchor = checkedAnchor(target, "live battle chain primary target");
    const visited = [anchor.owner];
    if (this.#configuration.questions.targetCap.value <= visited.length) {
      this.#pending.splice(rootIndex, 1);
      return { status: "complete", target: anchor };
    }
    this.#pending[rootIndex] = {
      ...root,
      anchor,
      dueTick: currentTick + this.#configuration.questions.hopDelayTicks.value,
      launchTargetId: null,
      ordinal: 1,
      phase: "hop-pending",
      visited,
    };
    return { status: "pending", target: anchor };
  }

  settleHop(plan, { ownerConfirmed, tick }) {
    const lineage = exact(plan.lineage, ["hopOrdinal", "primaryProjectileIdentity"],
      "live battle chain settlement lineage");
    const identity = checkedIdentity(lineage.primaryProjectileIdentity,
      "live battle chain settlement primary identity");
    const ordinal = integer(lineage.hopOrdinal, 1, 16, "live battle chain settlement ordinal");
    const rootIndex = this.#pending.findIndex((root) => root.phase === "hop-pending" &&
      identityKey(root.identity) === identityKey(identity));
    if (rootIndex === -1 || this.#pending[rootIndex].ordinal !== ordinal) {
      throw new RangeError("live battle chain settlement does not match pending lineage");
    }
    const root = this.#pending[rootIndex];
    const currentTick = integer(tick, root.dueTick, 18_000, "live battle chain settlement tick");
    if (currentTick !== root.dueTick || typeof ownerConfirmed !== "boolean") {
      throw new TypeError("live battle chain settlement result is invalid");
    }
    if (!ownerConfirmed || plan.target === null) {
      this.#pending.splice(rootIndex, 1);
      return "complete";
    }
    const target = checkedCandidate(plan.target, 0);
    const visited = [...root.visited, target.owner];
    if (visited.length >= this.#configuration.questions.targetCap.value) {
      this.#pending.splice(rootIndex, 1);
      return "complete";
    }
    this.#pending[rootIndex] = {
      ...root,
      anchor: { owner: target.owner, position: target.position, radius: target.radius },
      dueTick: currentTick + this.#configuration.questions.hopDelayTicks.value,
      ordinal: ordinal + 1,
      visited,
    };
    return "pending";
  }

  fork() {
    const copy = new LiveBattleChainContinuation(this.#configuration);
    copy.#pending = clone(this.#pending);
    return copy;
  }

  serialize() {
    return canonical({
      configuration: this.#configuration,
      pending: clone(this.#pending),
      schemaVersion: LIVE_BATTLE_CHAIN_SCHEMA_VERSION,
    });
  }

  static restore(serialized, policy) {
    if (typeof serialized !== "string") throw new TypeError("live battle chain witness must be canonical JSON text");
    let snapshot;
    try { snapshot = JSON.parse(serialized); }
    catch { throw new TypeError("live battle chain witness must be valid JSON"); }
    if (canonical(snapshot) !== serialized) throw new TypeError("live battle chain witness must be canonical JSON");
    const checked = exact(snapshot, SNAPSHOT_KEYS, "live battle chain witness");
    if (checked.schemaVersion !== LIVE_BATTLE_CHAIN_SCHEMA_VERSION) {
      throw new TypeError("live battle chain witness schema version is unsupported");
    }
    const configuration = admitStormkiteChainQuestionPolicy(policy);
    if (canonical(configuration) !== canonical(checked.configuration)) {
      throw new TypeError("live battle chain witness policy diverges from its admitted setup");
    }
    const pending = dense(checked.pending, LIVE_BATTLE_CHAIN_MAX_PENDING_ROOTS,
      "live battle chain witness.pending").map(checkedSnapshotRoot);
    const identities = pending.map(({ identity }) => identityKey(identity));
    if (new Set(identities).size !== identities.length ||
        identities.some((identity, index) => index > 0 && identities[index - 1] > identity)) {
      throw new TypeError("live battle chain witness roots must be unique and canonically ordered");
    }
    const restored = new LiveBattleChainContinuation(configuration);
    restored.#pending = pending;
    if (restored.serialize() !== serialized) {
      throw new TypeError("live battle chain witness is not canonical or causal");
    }
    return restored;
  }
}

