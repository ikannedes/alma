import { layoutFormation } from "../../sim/formations.js";
import { createCardCatalog } from "../schema.js";

const DEFINITIONS = [
  {
    id: "gloamwing-cluster",
    displayName: "Gloamwing Cluster",
    cost: 2,
    kind: "unit",
    rarity: "standard",
    hitpoints: 81,
    damage: 81,
    hitSpeedTicks: 78,
    firstHitTicks: 42,
    deployTimeTicks: 60,
    rangeMillitiles: 1200,
    sightRangeMillitiles: 5500,
    movementMillitilesPerSecond: 2000,
    targetMode: "ground-and-air",
    count: 5,
    areaDamageRadiusMillitiles: null,
    components: [
      {
        id: "gloamwing",
        displayName: "Gloamwing",
        kind: "unit",
        role: "primary",
        hitpoints: 81,
        damage: 81,
        hitSpeedTicks: 78,
        firstHitTicks: 42,
        deployTimeTicks: 60,
        rangeMillitiles: 1200,
        sightRangeMillitiles: 5500,
        movementMillitilesPerSecond: 2000,
        targetMode: "ground-and-air",
        count: 5,
        areaDamageRadiusMillitiles: null,
      },
    ],
  },
  {
    id: "cinderlings",
    displayName: "Cinderlings",
    cost: 1,
    kind: "unit",
    rarity: "standard",
    hitpoints: 81,
    damage: 81,
    hitSpeedTicks: 60,
    firstHitTicks: 30,
    deployTimeTicks: 60,
    rangeMillitiles: 500,
    sightRangeMillitiles: 5500,
    movementMillitilesPerSecond: 1500,
    targetMode: "ground",
    count: 3,
    areaDamageRadiusMillitiles: null,
    components: [
      {
        id: "cinderling",
        displayName: "Cinderling",
        kind: "unit",
        role: "primary",
        hitpoints: 81,
        damage: 81,
        hitSpeedTicks: 60,
        firstHitTicks: 30,
        deployTimeTicks: 60,
        rangeMillitiles: 500,
        sightRangeMillitiles: 5500,
        movementMillitilesPerSecond: 1500,
        targetMode: "ground",
        count: 3,
        areaDamageRadiusMillitiles: null,
      },
    ],
  },
  {
    id: "cinder-host",
    displayName: "Cinder Host",
    cost: 3,
    kind: "unit",
    rarity: "special",
    hitpoints: 81,
    damage: 81,
    hitSpeedTicks: 60,
    firstHitTicks: 30,
    deployTimeTicks: 60,
    rangeMillitiles: 500,
    sightRangeMillitiles: 5500,
    movementMillitilesPerSecond: 1500,
    targetMode: "ground",
    count: 15,
    areaDamageRadiusMillitiles: null,
    components: [
      {
        id: "cinderling",
        displayName: "Cinderling",
        kind: "unit",
        role: "primary",
        hitpoints: 81,
        damage: 81,
        hitSpeedTicks: 60,
        firstHitTicks: 30,
        deployTimeTicks: 60,
        rangeMillitiles: 500,
        sightRangeMillitiles: 5500,
        movementMillitilesPerSecond: 1500,
        targetMode: "ground",
        count: 15,
        areaDamageRadiusMillitiles: null,
      },
    ],
  },
  {
    id: "briar-band",
    displayName: "Briar Band",
    cost: 3,
    kind: "unit",
    rarity: "standard",
    hitpoints: 202,
    damage: 120,
    hitSpeedTicks: 66,
    firstHitTicks: 42,
    deployTimeTicks: 60,
    rangeMillitiles: 500,
    sightRangeMillitiles: 5500,
    movementMillitilesPerSecond: 2000,
    targetMode: "ground",
    count: 6,
    areaDamageRadiusMillitiles: null,
    components: [
      {
        id: "briar-runner",
        displayName: "Briar Runner",
        kind: "unit",
        role: "primary",
        hitpoints: 202,
        damage: 120,
        hitSpeedTicks: 66,
        firstHitTicks: 42,
        deployTimeTicks: 60,
        rangeMillitiles: 500,
        sightRangeMillitiles: 5500,
        movementMillitilesPerSecond: 2000,
        targetMode: "ground",
        count: 3,
        areaDamageRadiusMillitiles: null,
      },
      {
        id: "briar-darter",
        displayName: "Briar Darter",
        kind: "unit",
        role: "secondary",
        hitpoints: 133,
        damage: 81,
        hitSpeedTicks: 102,
        firstHitTicks: 72,
        deployTimeTicks: 60,
        rangeMillitiles: 5000,
        sightRangeMillitiles: 5500,
        movementMillitilesPerSecond: 2000,
        targetMode: "ground-and-air",
        count: 3,
        areaDamageRadiusMillitiles: null,
      },
    ],
  },
  {
    id: "thornscouts",
    displayName: "Thornscouts",
    cost: 2,
    kind: "unit",
    rarity: "standard",
    hitpoints: 202,
    damage: 120,
    hitSpeedTicks: 66,
    firstHitTicks: 42,
    deployTimeTicks: 60,
    rangeMillitiles: 500,
    sightRangeMillitiles: 5500,
    movementMillitilesPerSecond: 2000,
    targetMode: "ground",
    count: 4,
    areaDamageRadiusMillitiles: null,
    components: [
      {
        id: "thornscout",
        displayName: "Thornscout",
        kind: "unit",
        role: "primary",
        hitpoints: 202,
        damage: 120,
        hitSpeedTicks: 66,
        firstHitTicks: 42,
        deployTimeTicks: 60,
        rangeMillitiles: 500,
        sightRangeMillitiles: 5500,
        movementMillitilesPerSecond: 2000,
        targetMode: "ground",
        count: 4,
        areaDamageRadiusMillitiles: null,
      },
    ],
  },
  {
    id: "forgeguard",
    displayName: "Forgeguard",
    cost: 5,
    kind: "unit",
    rarity: "standard",
    hitpoints: 670,
    damage: 192,
    hitSpeedTicks: 78,
    firstHitTicks: 54,
    deployTimeTicks: 60,
    rangeMillitiles: 700,
    sightRangeMillitiles: 5500,
    movementMillitilesPerSecond: 1000,
    targetMode: "ground",
    count: 5,
    areaDamageRadiusMillitiles: null,
    components: [
      {
        id: "forgeguard",
        displayName: "Forgeguard",
        kind: "unit",
        role: "primary",
        hitpoints: 670,
        damage: 192,
        hitSpeedTicks: 78,
        firstHitTicks: 54,
        deployTimeTicks: 60,
        rangeMillitiles: 700,
        sightRangeMillitiles: 5500,
        movementMillitilesPerSecond: 1000,
        targetMode: "ground",
        count: 5,
        areaDamageRadiusMillitiles: null,
      },
    ],
  },
];

function checkedCardId(cardId) {
  if (typeof cardId !== "string") {
    throw new TypeError("squad card id must be a string");
  }
  const card = createSwarmCatalog().find(({ id }) => id === cardId);
  if (card === undefined) {
    throw new RangeError(`unknown squad card id: ${cardId}`);
  }
  return card;
}

function checkedFirstEntityId(firstEntityId, count) {
  if (!Number.isSafeInteger(firstEntityId) || firstEntityId < 1) {
    throw new TypeError(
      "squad first entity id must be a positive safe integer",
    );
  }
  if (count - 1 > Number.MAX_SAFE_INTEGER - firstEntityId) {
    throw new RangeError("squad entity id range exceeds safe integers");
  }
}

/**
 * Returns a newly validated and isolated catalog for this small squad slice.
 *
 * These definitions claim only component statistics and initial member counts.
 * They do not claim formation radius, projectile travel, or full-match behavior.
 */
export function createSwarmCatalog() {
  return createCardCatalog(DEFINITIONS);
}

/**
 * Expands initial components in declared component order and then member order.
 * The projection contains card combat data only; position and radius are battle
 * geometry and are intentionally absent.
 */
export function createSquadMembers(cardId, firstEntityId) {
  const card = checkedCardId(cardId);
  checkedFirstEntityId(firstEntityId, card.count);

  const members = [];
  let id = firstEntityId;
  for (const component of card.components) {
    for (let index = 0; index < component.count; index += 1) {
      members.push({
        cardId: card.id,
        componentId: component.id,
        damage: component.damage,
        deployTicks: component.deployTimeTicks,
        firstHitTicks: component.firstHitTicks,
        hitSpeedTicks: component.hitSpeedTicks,
        hitpoints: component.hitpoints,
        id,
        range: component.rangeMillitiles,
        role: component.role,
        sightRange: component.sightRangeMillitiles,
        speed: component.movementMillitilesPerSecond,
        targetMode: component.targetMode,
      });
      id += 1;
    }
  }
  return members;
}

/**
 * Places the canonical member expansion with caller-supplied battle geometry.
 * Validation of the radius, anchor, dense members, and spatial bounds is
 * delegated to the deterministic formation boundary. This adapter claims that
 * delegation only, not comparison-target parity for formation or its radius.
 */
export function layoutSquad(cardId, firstEntityId, radius, anchor) {
  const members = createSquadMembers(cardId, firstEntityId);
  return layoutFormation(
    anchor,
    members.map(({ id, role }) => ({ id, radius, role })),
  );
}
