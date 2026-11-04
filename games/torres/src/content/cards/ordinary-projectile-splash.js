import { createCardCatalog } from "../schema.js";

const DEFINITIONS = [{
  id: "kilnkeeper",
  displayName: "Kilnkeeper",
  cost: 5,
  kind: "unit",
  rarity: "uncommon",
  hitpoints: 720,
  damage: 281,
  hitSpeedTicks: 84,
  firstHitTicks: 60,
  deployTimeTicks: 60,
  rangeMillitiles: 5_500,
  sightRangeMillitiles: 5_500,
  movementMillitilesPerSecond: 1_000,
  targetMode: "ground-and-air",
  count: 1,
  areaDamageRadiusMillitiles: null,
  components: [{
    id: "kilnkeeper",
    displayName: "Kilnkeeper",
    kind: "unit",
    role: "primary",
    hitpoints: 720,
    damage: 281,
    hitSpeedTicks: 84,
    firstHitTicks: 60,
    deployTimeTicks: 60,
    rangeMillitiles: 5_500,
    sightRangeMillitiles: 5_500,
    movementMillitilesPerSecond: 1_000,
    targetMode: "ground-and-air",
    count: 1,
    areaDamageRadiusMillitiles: null,
  }],
}];

/** Returns the original single-unit source row for the ordinary splash profile. */
export function createOrdinaryProjectileSplashCatalog() {
  return createCardCatalog(DEFINITIONS);
}
