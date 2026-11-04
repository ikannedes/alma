import { circlesOverlap } from "./spatial.js";
import { checkedMeleeAreaQuestionPolicy } from
  "../shared/session-troop-melee-area-authority.js";

const MAX_AREA_POLICY_UNITS = 1_024;
const POLICY_KEYS = Object.freeze([
  "authoritative", "center", "confidence", "geometry", "radiusMillitiles",
  "secondaryDamage", "structureTargets", "targetLayers", "version",
]);

function exactDataObject(value, keys, label) {
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

export function exactMeleeAreaSetup(value, keys, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype &&
       Object.getPrototypeOf(value) !== null)) {
    throw new TypeError(`${label} must be a plain object`);
  }
  const hasPolicies = Object.hasOwn(value, "meleeAreaPolicies");
  return exactDataObject(value, hasPolicies ? [...keys, "meleeAreaPolicies"] : keys, label);
}

function checkedArray(value, label, maximum) {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new TypeError(`${label} must be a bounded array`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (key === "length") continue;
    if (typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key) ||
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

function checkedPolicy(value, label) {
  const policy = exactDataObject(value, POLICY_KEYS, label);
  const layers = checkedArray(policy.targetLayers, `${label}.targetLayers`, 1);
  if (policy.authoritative !== false || policy.center !== "attacker" ||
      policy.confidence !== "question" || policy.geometry !== "circle-overlap-inclusive" ||
      policy.radiusMillitiles !== 2_000 || policy.secondaryDamage !== "base-attack" ||
      policy.structureTargets !== "exclude" || layers.length !== 1 || layers[0] !== "ground" ||
      policy.version !== "melee-area-question-v1") {
    throw new TypeError(`${label} is not the closed melee-area-question-v1 policy`);
  }
  return { ...policy, targetLayers: layers };
}

export function checkedMeleeAreaPolicies(value, units, label = "meleeAreaPolicies") {
  const entries = checkedArray(value, label, MAX_AREA_POLICY_UNITS);
  if (entries.length === 0) throw new TypeError(`${label} must be omitted when no unit opts in`);
  const unitById = new Map(units.map((unit) => [unit.id, unit]));
  const policies = entries.map((entry, index) => {
    const entryLabel = `${label}[${index}]`;
    const checked = exactDataObject(entry, ["attackerId", "policy"], entryLabel);
    if (!Number.isSafeInteger(checked.attackerId) || checked.attackerId < 1) {
      throw new TypeError(`${entryLabel}.attackerId must be a positive safe integer`);
    }
    const attacker = unitById.get(checked.attackerId);
    if (attacker === undefined || attacker.delivery !== "melee") {
      throw new TypeError(`${entryLabel} must identify an initial melee unit`);
    }
    return { attackerId: checked.attackerId,
      policy: checkedPolicy(checked.policy, `${entryLabel}.policy`) };
  }).sort((left, right) => left.attackerId - right.attackerId);
  if (new Set(policies.map(({ attackerId }) => attackerId)).size !== policies.length) {
    throw new TypeError(`${label} attacker IDs must be unique`);
  }
  return policies;
}

export function canonicalMeleeAreaSetup(setup, units, cloneValue, label) {
  const policies = Object.hasOwn(setup, "meleeAreaPolicies")
    ? checkedMeleeAreaPolicies(setup.meleeAreaPolicies, units,
      `${label}.meleeAreaPolicies`) : null;
  return { units: cloneValue(units),
    ...(policies === null ? {} : { meleeAreaPolicies: cloneValue(policies) }) };
}

export function canonicalMeleeTowerSetup(setup, units, label) {
  if (!Object.hasOwn(setup, "meleeAreaPolicies")) return setup;
  return { ...setup, meleeAreaPolicies: checkedMeleeAreaPolicies(
    setup.meleeAreaPolicies, units, `${label}.meleeAreaPolicies`) };
}

export function meleeAreaPolicyFor(policies, attackerId) {
  if (policies === undefined) return undefined;
  let low = 0;
  let high = policies.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    const id = policies[middle].attackerId;
    if (id < attackerId) low = middle + 1;
    else high = middle;
  }
  return policies[low]?.attackerId === attackerId ? policies[low].policy : undefined;
}

/** Shared pure victim selection for projectile splash and opted-in melee area hits. */
export function selectAreaTargets({ center, enemySide, primaryTargetId, profile, structures, units }) {
  const targets = [];
  const overlaps = (target) => circlesOverlap(
    { position: center, radius: profile.radiusMillitiles },
    { position: target.position, radius: target.radius },
  );
  for (const unit of units) {
    if (!unit.alive || !unit.targetable || unit.side !== enemySide ||
        unit.id === primaryTargetId || !profile.targetLayers.includes(unit.layer) ||
        !overlaps(unit)) continue;
    targets.push({ ...unit, targetKind: "unit" });
  }
  for (const structure of structures) {
    if (!structure.alive || !structure.targetable || structure.side !== enemySide ||
        structure.id === primaryTargetId || !profile.targetLayers.includes(structure.layer) ||
        !overlaps(structure)) continue;
    targets.push({ ...structure, targetKind: "structure" });
  }
  targets.sort((left, right) => left.id - right.id);
  return targets;
}

export function planMeleeAreaAttack({ attacker, attackSequence, isAlive, isTargetable,
  policy, primaryTargetId, units }) {
  const secondaryTargets = selectAreaTargets({
    center: attacker.position,
    enemySide: attacker.side === "north" ? "south" : "north",
    primaryTargetId,
    profile: policy,
    structures: [],
    units: units.map((unit) => ({
      alive: isAlive(unit.id),
      id: unit.id,
      layer: unit.layer,
      position: unit.position,
      radius: unit.radius,
      side: unit.side,
      targetable: isTargetable(unit.id),
    })),
  });
  return {
    hitSources: [
      { attackerId: attacker.id, delivery: "melee" },
      ...secondaryTargets.map(() => ({ attackerId: attacker.id, attackSequence,
        delivery: "melee", meleeAreaPolicyVersion: policy.version })),
    ],
    unitHits: [
      { amount: attacker.damage, targetId: primaryTargetId },
      ...secondaryTargets.map(({ id }) => ({ amount: attacker.damage, targetId: id })),
    ],
  };
}

export function planMeleeUnitAttack({ attacker, attackSequence, areaPolicies, controls,
  damage, primaryTargetId, units }) {
  const policy = attacker.meleeAreaPolicy === undefined
    ? meleeAreaPolicyFor(areaPolicies, attacker.id)
    : checkedMeleeAreaQuestionPolicy(attacker.meleeAreaPolicy,
      "battle combat attacker.meleeAreaPolicy");
  if (policy === undefined) {
    return {
      hitSources: [{ attackerId: attacker.id, delivery: "melee" }],
      unitHits: [{ amount: attacker.damage, targetId: primaryTargetId }],
    };
  }
  return planMeleeAreaAttack({
    attacker,
    attackSequence,
    isAlive: (id) => !damage.get(id).dead,
    isTargetable: (id) => controls.get(id)?.targetable ?? true,
    policy,
    primaryTargetId,
    units,
  });
}
