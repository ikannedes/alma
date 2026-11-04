import {
  createPlayableRoster,
  createPlayableRosterQuestionRecords,
  PLAYABLE_CARD_IDS,
} from "./playable-roster.js";
import {
  EDITABLE_DECK_CARD_IDS,
  createEditableDeckWitness,
  createSessionTroopWitnessQuestions,
  projectSessionTroopBattleCard,
} from "./session-troop-roster.js";
import { projectSessionNonUnitBattleCard } from "./session-card-catalog.js";
import { createSessionRadiusSpellProfileReceipts } from "./session-spell-profile-receipts.js";
import { serializeSessionTroopProjectileProfileManifest } from
  "./session-troop-projectile-profiles.js";
import { createStormkiteChainQuestionPolicy } from "../sim/live-battle-chain.js";

export { EDITABLE_DECK_CARD_IDS };

const EDITABLE_SESSION_MIXED_DECK_CARD_IDS = Object.freeze([
  ...EDITABLE_DECK_CARD_IDS,
  "squall-orb",
  "ember-basin",
  "buried-coil",
  "aether-well",
]);
export const EDITABLE_MIXED_DECK_CARD_IDS = Object.freeze([
  ...EDITABLE_DECK_CARD_IDS,
  "squall-orb",
  "ember-basin",
  "buried-coil",
  "aether-well",
]);

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sameIds(left, right) {
  return left.length === right.length &&
    left.every((id, index) => id === right[index]);
}

function checkedSeed(seed) {
  if (typeof seed !== "string" && !Number.isSafeInteger(seed)) {
    throw new TypeError("editable deck seed must be a string or safe integer");
  }
  return seed;
}

function checkedEditableIds(deckIds) {
  if (!Array.isArray(deckIds) || Object.getPrototypeOf(deckIds) !== Array.prototype ||
      deckIds.length !== 8) {
    throw new TypeError("editable deck IDs must be one plain eight-card array");
  }
  const descriptors = Object.getOwnPropertyDescriptors(deckIds);
  const keys = Reflect.ownKeys(descriptors).filter((key) => key !== "length");
  if (keys.length !== 8 || keys.some((key, index) => key !== String(index))) {
    throw new TypeError("editable deck IDs must be a dense indexed array");
  }
  const ids = descriptors && Array.from({ length: 8 }, (_, index) => {
    const descriptor = descriptors[index];
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value") ||
        typeof descriptor.value !== "string") {
      throw new TypeError(`editable deck ID ${index} must be a primitive string`);
    }
    return descriptor.value;
  });
  if (new Set(ids).size !== ids.length) throw new TypeError("editable deck cards must be unique");
  return ids;
}

/**
 * Composes mixed decks from admitted troop, spell, and structure projections.
 * The troop witness API remains closed to eight-card troop decks.
 */
export function createEditableMixedDeckWitness(deckIds, ...args) {
  if (args.length !== 0) throw new TypeError("editable mixed deck witness takes exactly one argument");
  const ids = checkedEditableIds(deckIds);
  if (ids.every((id) => EDITABLE_DECK_CARD_IDS.includes(id)) ||
      ids.some((id) => !EDITABLE_SESSION_MIXED_DECK_CARD_IDS.includes(id))) {
    throw new RangeError("mixed editable deck requires an admitted spell or structure and supported cards");
  }
  const roster = ids.map((id) => id === "squall-orb"
    ? projectSessionNonUnitBattleCard(id)
    : EDITABLE_DECK_CARD_IDS.includes(id)
      ? projectSessionTroopBattleCard(id)
      : projectSessionNonUnitBattleCard(id));
  const referencedQuestionKeys = new Set(
    roster.flatMap(({ entities }) => entities.flatMap((entity) => [
      ...[entity.bodyRadiusPolicy, entity.projectileSpeedPolicy, entity.deliveryPolicy,
        entity.layerPolicy, entity.damagePolicy]
        .filter((policy) => policy?.kind === "question")
        .map(({ questionKey }) => questionKey),
      ...(entity.sourceConfidencePolicy?.fields ?? [])
        .map(({ questionKey }) => questionKey),
    ])),
  );
  const questionRecords = ids.filter((id) => EDITABLE_DECK_CARD_IDS.includes(id))
    .flatMap((id) => createSessionTroopWitnessQuestions(id));
  const byKey = new Map(questionRecords.map((record) => [record.key, record]));
  const questions = [...referencedQuestionKeys].sort().map((key) => {
    const record = byKey.get(key);
    if (record === undefined) throw new Error(`mixed editable deck lacks troop question ${key}`);
    return record;
  });
  return deepFreeze({ initialWindupTicks: { central: 0, lane: 0 }, questions, roster });
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * Builds the canonical GameSession setup for a selected editable deck.
 * The exact standard order keeps the legacy shipped roster and question bytes.
 */
export function createEditableGameSessionSetup(deckIds, seed = 0, ...args) {
  if (args.length !== 0) {
    throw new TypeError("editable game session setup takes at most two arguments");
  }
  const checkedIds = checkedEditableIds(deckIds);
  const mixed = checkedIds.some((id) => !EDITABLE_DECK_CARD_IDS.includes(id));
  const witness = mixed
    ? createEditableMixedDeckWitness(checkedIds)
    : createEditableDeckWitness(checkedIds);
  const checked = checkedSeed(seed);
  const selectedIds = witness.roster.map(({ id }) => id);
  const standard = sameIds(selectedIds, PLAYABLE_CARD_IDS);
  const roster = standard ? createPlayableRoster() : witness.roster;
  const questions = standard
    ? createPlayableRosterQuestionRecords()
    : witness.questions;
  const initialWindupTicks = standard
    ? { central: 0, lane: 0 }
    : witness.initialWindupTicks;
  const stormkiteSelected = selectedIds.includes("stormkite");
  const battleSetup = canonical({
    initialWindupTicks,
    questions,
    roster,
    ...(mixed && checkedIds.includes("squall-orb")
      ? { spellProfileReceipts: createSessionRadiusSpellProfileReceipts() }
      : {}),
    ...(stormkiteSelected
      ? { chainQuestionPolicy: createStormkiteChainQuestionPolicy() }
      : {}),
  });
  return canonical({
    ...(stormkiteSelected
      ? { projectileRuntimeProfiles: serializeSessionTroopProjectileProfileManifest() }
      : {}),
    battleSetup,
    deck: selectedIds,
    legalNorthDeployments: selectedIds.map((cardId) => ({
      cardId,
      point: { x: 3_500, y: 17_500 },
    })).sort((left, right) => left.cardId.localeCompare(right.cardId)),
    rosterWitness: canonical({ questions, roster }),
    seed: checked,
    startingElixir: { north: 10, south: 10 },
    thinkIntervalTicks: 60,
    thinkOffsetTicks: 0,
  });
}
