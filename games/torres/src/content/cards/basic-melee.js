import { createCardCatalog } from "../schema.js";

const DEFINITIONS = [
  {
    id: "brackenwheel",
    displayName: "Brackenwheel",
    cost: 4,
    kind: "unit",
    rarity: "uncommon",
    hitpoints: 1908,
    damage: 267,
    hitSpeedTicks: 90,
    firstHitTicks: 84,
    deployTimeTicks: 60,
    rangeMillitiles: 1200,
    sightRangeMillitiles: 5500,
    movementMillitilesPerSecond: 1000,
    targetMode: "ground",
    count: 1,
    areaDamageRadiusMillitiles: 2000,
    components: [],
  },
  {
    id: "mossguard",
    displayName: "Mossguard",
    cost: 3,
    kind: "unit",
    rarity: "standard",
    hitpoints: 1766,
    damage: 202,
    hitSpeedTicks: 72,
    firstHitTicks: 42,
    deployTimeTicks: 60,
    rangeMillitiles: 1200,
    sightRangeMillitiles: 5500,
    movementMillitilesPerSecond: 1000,
    targetMode: "ground",
    count: 1,
    areaDamageRadiusMillitiles: null,
    components: [],
  },
  {
    id: "coilblade",
    displayName: "Coilblade",
    cost: 4,
    kind: "unit",
    rarity: "uncommon",
    hitpoints: 1361,
    damage: 720,
    hitSpeedTicks: 96,
    firstHitTicks: 66,
    deployTimeTicks: 60,
    rangeMillitiles: 800,
    sightRangeMillitiles: 5500,
    movementMillitilesPerSecond: 1500,
    targetMode: "ground",
    count: 1,
    areaDamageRadiusMillitiles: null,
    components: [],
  },
  {
    id: "ironroot",
    displayName: "Ironroot",
    cost: 7,
    kind: "unit",
    rarity: "special",
    hitpoints: 3760,
    damage: 816,
    hitSpeedTicks: 108,
    firstHitTicks: 78,
    deployTimeTicks: 60,
    rangeMillitiles: 1200,
    sightRangeMillitiles: 5000,
    movementMillitilesPerSecond: 750,
    targetMode: "ground",
    count: 1,
    areaDamageRadiusMillitiles: null,
    components: [],
  },
];

const PLACEMENT_KEYS = ["entityId", "position", "radius"];

function checkedPlacement(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    throw new TypeError("basic melee placement must be a plain object");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (
    keys.length !== PLACEMENT_KEYS.length ||
    keys.some((key) => (
      typeof key !== "string" ||
      !PLACEMENT_KEYS.includes(key) ||
      !descriptors[key].enumerable ||
      !Object.hasOwn(descriptors[key], "value")
    ))
  ) {
    throw new TypeError("basic melee placement has an invalid shape");
  }
  if (!Number.isSafeInteger(value.entityId) || value.entityId < 1) {
    throw new TypeError("basic melee entityId must be a positive safe integer");
  }
  if (!Number.isSafeInteger(value.position)) {
    throw new TypeError("basic melee position must be a safe integer");
  }
  if (!Number.isSafeInteger(value.radius) || value.radius < 0) {
    throw new TypeError("basic melee radius must be a non-negative safe integer");
  }
  return {
    entityId: value.entityId,
    position: value.position,
    radius: value.radius,
  };
}

/**
 * Returns a newly validated and isolated catalog of this slice's original
 * single-unit ground-melee definitions.
 */
export function createBasicMeleeCatalog() {
  return createCardCatalog(DEFINITIONS);
}

/**
 * Projects one runtime card into the existing deterministic melee integration.
 * Entity placement and body radius are battle state, not card statistics.
 */
export function createBasicMeleeCombatant(cardId, placement) {
  if (typeof cardId !== "string") {
    throw new TypeError("basic melee card id must be a string");
  }
  const card = createBasicMeleeCatalog().find(({ id }) => id === cardId);
  if (card === undefined) {
    throw new RangeError(`unknown basic melee card id: ${cardId}`);
  }
  if (card.areaDamageRadiusMillitiles !== null) {
    throw new RangeError(`${card.displayName} requires the shared battle area reducer`);
  }
  const checked = checkedPlacement(placement);
  return {
    damage: card.damage,
    deployTicks: card.deployTimeTicks,
    firstHitTicks: card.firstHitTicks,
    hitSpeedTicks: card.hitSpeedTicks,
    hitpoints: card.hitpoints,
    id: checked.entityId,
    position: checked.position,
    radius: checked.radius,
    reach: card.rangeMillitiles,
    sightRange: card.sightRangeMillitiles,
    speed: card.movementMillitilesPerSecond,
  };
}
