// This module deliberately knows no content imports, deck, elixir, clock,
// RNG, units, towers, or movement state. Its one receipt is copied verbatim
// from the content-side receipt producer and must be supplied by a canonical
// LiveBattle setup. LiveBattle owns every actual state mutation.

const MAX_ACTIONS = 1_024;
const MAX_EFFECT_ID = Number.MAX_SAFE_INTEGER - 1;
const PROFILE_ID = "isolated-sourced-instant-v1";
const RADIUS_PROFILE_ID = "squall-orb-radius-v2";

// Copied exactly from the content-side profile-boundary producer. It is kept
// outside the receipt itself so v1 profile receipt bytes remain replayable.
const UNPROFILED_ADMITTED_EFFECT_QUESTION = Object.freeze({
  disposition: "question",
  id: "admitted-effect-without-exact-executable-profile",
  profileId: PROFILE_ID,
  reason: "an admitted effect without an exact sourced executable profile remains QUESTION and cannot be staged",
  status: "question",
});

const CANONICAL_RECEIPTS = Object.freeze({
  exclusions: Object.freeze([
    Object.freeze({ id: "squall-orb-radius-target-knockback-travel-return",
      reason: "all radius, target-policy, knockback, travel, return, and four-facade composition fields remain QUESTION" }),
    Object.freeze({ id: "squall-orb-crown-tower-damage-modifier",
      reason: "crown-tower damage ratio and rounding remain QUESTION, so crown-tower targets are disabled" }),
    Object.freeze({ id: "periodic", reason: "cadence, duration, damage, radius, and target composition remain QUESTION" }),
    Object.freeze({ id: "spawn", reason: "spawn identities lack sourced kind/cost/deploy admission and all spawn mechanics remain QUESTION" }),
    Object.freeze({ id: "status", reason: "status duration, multiplier, target, refresh, and expiry mechanics remain QUESTION" }),
    Object.freeze({ id: "traveling", reason: "travel timing, geometry, damage, target, and return mechanics remain QUESTION" }),
  ]),
  profiles: Object.freeze([
    Object.freeze({
      claims: Object.freeze(["cardId", "kind", "cost", "count", "damage"]),
      fact: Object.freeze({
        cardId: "squall-orb",
        count: 1,
        cost: 4,
        damage: 689,
        kind: "effect",
        sourceExport: "createInstantSpellCatalog",
      }),
      mode: "isolated-direct-command-target-damage-not-card-composition",
      profileId: PROFILE_ID,
    }),
  ]),
  version: 1,
});

// Exact copy of the separately versioned content receipt. Keeping this small
// allowlist local avoids importing card catalogs into the reducer. Every
// QUESTION field remains visible in the receipt and the executable policy.
const CANONICAL_RADIUS_RECEIPTS = Object.freeze({
  exclusions: Object.freeze([
    Object.freeze({ id: "squall-orb-travel-and-knockback",
      reason: "one-tile Fireball pushback is publisher-corroborated; target eligibility and event ordering remain QUESTION, while activation and travel remain unresolved" }),
    Object.freeze({ id: "periodic", reason: "cadence, duration, damage, radius, and target composition remain QUESTION" }),
    Object.freeze({ id: "spawn", reason: "spawn identities lack sourced kind/cost/deploy admission and all spawn mechanics remain QUESTION" }),
    Object.freeze({ id: "status", reason: "status duration, multiplier, target, refresh, and expiry mechanics remain QUESTION" }),
    Object.freeze({ id: "other-traveling", reason: "travel timing, geometry, damage, target, and return mechanics remain QUESTION" }),
  ]),
  profiles: Object.freeze([
    Object.freeze({
      claims: Object.freeze(["cardId", "kind", "cost", "count", "damage", "areaDamageRadiusMillitiles",
        "targetMode", "crownTowerDamagePercent", "impactDelayTicks"]),
      fact: Object.freeze({
        cardId: "squall-orb", count: 1, cost: 4, damage: 689, kind: "effect",
        sourceExport: "createInstantSpellCatalog", areaDamageRadiusMillitiles: 2_500,
        crownTowerDamagePercent: -70, crownTowerRounding: "nearest-integer-half-up",
        impactDelayTicks: 2, targetMode: "ground-and-air",
      }),
      mode: "bounded-radius-center-cast-with-question-estimates",
      policies: Object.freeze({
        areaDamageRadiusMillitiles: Object.freeze({ authoritative: false, confidence: "medium",
          disposition: "question", source: "pinned-historical-spell-datamine-estimate", value: 2_500 }),
        crownTowerDamagePercent: Object.freeze({ authoritative: false, confidence: "medium",
          disposition: "question", source: "pinned-historical-projectile-datamine-estimate", value: -70 }),
        crownTowerRounding: Object.freeze({ authoritative: false, confidence: "unverified",
          disposition: "question", source: "runtime-damage-rounding-estimate",
          value: "nearest-integer-half-up" }),
        impactDelayTicks: Object.freeze({ authoritative: false, confidence: "unverified",
          disposition: "question", source: "runtime-impact-delay-estimate", value: 2 }),
        targetMode: Object.freeze({ authoritative: false, confidence: "medium",
          disposition: "question", source: "pinned-historical-spell-datamine-estimate",
          value: "ground-and-air" }),
      }),
      profileId: RADIUS_PROFILE_ID,
    }),
  ]),
  version: 2,
});

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.keys(value).sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

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

function exact(value, keys, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype ||
      Object.getOwnPropertySymbols(value).length !== 0) {
    throw new TypeError(`${label} must be a plain string-keyed data object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const actual = Reflect.ownKeys(descriptors).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${label} has an invalid shape`);
  }
  for (const key of keys) {
    if (!descriptors[key].enumerable || !Object.hasOwn(descriptors[key], "value")) {
      throw new TypeError(`${label}.${key} must be an enumerable data property`);
    }
  }
  return Object.fromEntries(keys.map((key) => [key, descriptors[key].value]));
}

function checkedPoint(value, label) {
  const point = exact(value, ["x", "y"], label);
  if (!Number.isSafeInteger(point.x) || !Number.isSafeInteger(point.y)) {
    throw new TypeError(`${label} must contain safe integer coordinates`);
  }
  return { x: point.x, y: point.y };
}

function checkedTarget(value, label) {
  const target = exact(value, ["id", "kind"], label);
  if (target.kind === "unit" && Number.isSafeInteger(target.id) && target.id > 0) {
    return { id: target.id, kind: target.kind };
  }
  throw new TypeError(`${label} must name one shared unit; crown-tower modifiers are QUESTION`);
}

function checkedCommand(value, currentTick, version) {
  const command = exact(value, version === 1
    ? ["cardId", "point", "sequence", "side", "target", "tick"]
    : ["cardId", "point", "sequence", "side", "tick"], "live spell command");
  if (command.cardId !== "squall-orb" || !["north", "south"].includes(command.side) ||
      !Number.isSafeInteger(command.sequence) || command.sequence < 0 ||
      !Number.isSafeInteger(command.tick) || command.tick !== currentTick) {
    throw new TypeError("live spell command is invalid");
  }
  const checked = {
    cardId: command.cardId,
    point: checkedPoint(command.point, "live spell command.point"),
    sequence: command.sequence,
    side: command.side,
    tick: command.tick,
  };
  if (version === 1) checked.target = checkedTarget(command.target, "live spell command.target");
  return checked;
}

export function serializeSpellIntentProfileReceipts(...args) {
  if (args.length !== 0) throw new TypeError("spell intent profile receipt serialization takes no arguments");
  return canonical(CANONICAL_RECEIPTS);
}

/**
 * Accept only an exact content-produced receipt. This is intentionally not a
 * broad profile language: admitting arbitrary action values would turn a
 * source-honest authority seam into an unsupported spell roster.
 */
export function parseSpellIntentProfileReceipts(value) {
  exact(value, ["exclusions", "profiles", "version"], "live spell profile receipts");
  const expected = value.version === 1 ? CANONICAL_RECEIPTS
    : value.version === 2 ? CANONICAL_RADIUS_RECEIPTS : null;
  if (expected === null || canonical(value) !== canonical(expected)) {
    throw new TypeError("live spell profile receipts are not the exact sourced receipt");
  }
  return freeze(clone(expected));
}

export function getSpellIntentQuestionExclusions(...args) {
  if (args.length !== 0) throw new TypeError("spell intent question exclusions take no arguments");
  return freeze(clone(CANONICAL_RECEIPTS.exclusions));
}

/**
 * A profile-boundary refusal record, not a zero-effect fallback. LiveBattle
 * attaches this only after its own admitted roster identifies the card as an
 * effect and finds no exact executable profile for that identity.
 */
export function getUnprofiledAdmittedEffectProfileQuestion(cardId) {
  if (typeof cardId !== "string" || cardId.length === 0 || cardId.length > 128) {
    throw new TypeError("unprofiled admitted effect card ID must be a bounded primitive string");
  }
  return freeze({ cardId, ...clone(UNPROFILED_ADMITTED_EFFECT_QUESTION) });
}

class SpellIntentRuntime {
  #nextEffectId = 1;
  #pending = [];
  #receipts;

  constructor(receipts) {
    this.#receipts = parseSpellIntentProfileReceipts(receipts);
  }

  get state() {
    return freeze({ nextEffectId: this.#nextEffectId, pending: clone(this.#pending),
      version: this.#receipts.version });
  }

  hasCard(cardId) {
    return cardId === this.#receipts.profiles[0].fact.cardId;
  }

  get profileVersion() {
    return this.#receipts.version;
  }

  hasPendingSequence(tick, sequence) {
    return this.#pending.some((entry) => entry.tick === tick && entry.sequence === sequence);
  }

  validate(command, currentTick) {
    const checked = checkedCommand(command, currentTick, this.#receipts.version);
    if (!this.hasCard(checked.cardId)) throw new RangeError("spell card has no sourced profile");
    return freeze(clone(checked));
  }

  schedule(command, currentTick, admit) {
    const checked = this.validate(command, currentTick);
    if (typeof admit !== "function" || !admit(freeze(clone(checked)))) {
      throw new RangeError("live spell command is not admitted by the shared battle");
    }
    if (this.#pending.length >= MAX_ACTIONS) throw new RangeError("live spell action bound exceeded");
    if (this.#nextEffectId > MAX_EFFECT_ID) throw new RangeError("live spell effect ID space is exhausted");
    if (this.hasPendingSequence(checked.tick, checked.sequence)) {
      throw new RangeError("live spell tick/sequence is duplicate");
    }
    const effectId = this.#nextEffectId;
    this.#nextEffectId += 1;
    const radiusProfile = this.#receipts.version === 2;
    const profileId = radiusProfile ? RADIUS_PROFILE_ID : PROFILE_ID;
    this.#pending.push(radiusProfile
      ? { ...checked, effectId, impactTick: checked.tick +
        this.#receipts.profiles[0].fact.impactDelayTicks, profileId }
      : { ...checked, effectId, profileId });
    this.#pending.sort((left, right) => left.tick - right.tick ||
      left.sequence - right.sequence || left.effectId - right.effectId);
    return freeze({ cardId: checked.cardId, effectId, point: clone(checked.point),
      profileId, sequence: checked.sequence, side: checked.side,
      ...(radiusProfile ? {} : { target: clone(checked.target) }),
      tick: checked.tick, type: "spell-intent-scheduled" });
  }

  resolve(tick) {
    if (!Number.isSafeInteger(tick) || tick < 0) throw new TypeError("live spell resolve tick is invalid");
    const radiusProfile = this.#receipts.version === 2;
    const due = this.#pending.filter((entry) => (radiusProfile ? entry.impactTick : entry.tick) === tick);
    this.#pending = this.#pending.filter((entry) => (radiusProfile ? entry.impactTick : entry.tick) !== tick);
    const fact = this.#receipts.profiles[0].fact;
    return freeze(due.map((entry) => ({
      actionIndex: 0,
      cardId: entry.cardId,
      damage: fact.damage,
      effectId: entry.effectId,
      kind: radiusProfile ? "bounded-radius-center-damage" : "isolated-direct-target-damage",
      point: clone(entry.point),
      profileId: entry.profileId,
      sequence: entry.sequence,
      side: entry.side,
      ...(radiusProfile ? {
        areaDamageRadiusMillitiles: fact.areaDamageRadiusMillitiles,
        crownTowerDamagePercent: fact.crownTowerDamagePercent,
        crownTowerRounding: fact.crownTowerRounding,
        targetMode: fact.targetMode,
      } : { target: clone(entry.target) }),
      tick,
    })));
  }

  fork() {
    const copy = new SpellIntentRuntime(this.#receipts);
    copy.#nextEffectId = this.#nextEffectId;
    copy.#pending = clone(this.#pending);
    return copy;
  }
}

// The reducer is intentionally not exported as a public runtime capability.
// LiveBattle holds the only instance and owns its history, serialization, and
// application to shared authorities.
export function createSpellIntentRuntime(receipts) {
  return new SpellIntentRuntime(receipts);
}
