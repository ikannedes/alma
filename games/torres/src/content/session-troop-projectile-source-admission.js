import { createBasicFlyingCatalog } from "./cards/basic-flying.js";
import { createBasicMeleeCatalog } from "./cards/basic-melee.js";
import { createBasicRangedCatalog } from "./cards/basic-ranged.js";
import { createSwarmCatalog } from "./cards/swarms.js";
import { createOrdinaryProjectileSplashCatalog } from "./cards/ordinary-projectile-splash.js";
import { createChainSpecialCatalog } from "./cards/special-projectiles-chain.js";
import { createPierceSpecialCatalog } from "./cards/special-projectiles-pierce.js";
import { createReturnSpecialCatalog } from "./cards/special-projectiles-return.js";
import { createPelletSpecialCatalog } from "./cards/special-projectiles-pellets.js";
import { createReflectionSpecialCatalog } from "./cards/special-projectiles-reflection.js";
import { assertSafeCardCatalogGraph } from "./schema.js";

const MAX_SOURCE_CATALOG_ROWS = 64;
const MAX_COMPONENTS = 16;
const SOURCE_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const SOURCE_RARITIES = new Set([
  "standard", "uncommon", "rare", "epic", "legendary", "mythic", "special", "heroic",
]);
const SOURCE_TARGET_MODES = new Set([
  "none", "ground", "air", "ground-and-air", "structures",
]);
const SOURCE_COMPONENT_ROLES = new Set([
  "primary", "secondary", "spawn", "spawn-over-time",
]);

const SOURCE_RECORD_FIELDS = Object.freeze([
  "areaDamageRadiusMillitiles",
  "components",
  "cost",
  "count",
  "damage",
  "deployTimeTicks",
  "displayName",
  "firstHitTicks",
  "hitSpeedTicks",
  "hitpoints",
  "id",
  "kind",
  "movementMillitilesPerSecond",
  "rangeMillitiles",
  "rarity",
  "sightRangeMillitiles",
  "targetMode",
]);

const COMPONENT_FIELDS = Object.freeze([
  "areaDamageRadiusMillitiles",
  "count",
  "damage",
  "deployTimeTicks",
  "displayName",
  "firstHitTicks",
  "hitSpeedTicks",
  "hitpoints",
  "id",
  "kind",
  "movementMillitilesPerSecond",
  "rangeMillitiles",
  "role",
  "sightRangeMillitiles",
  "targetMode",
]);

export const AUTHORITATIVE_PROJECTILE_SOURCE_IDS_BY_EXPORT = Object.freeze({
  createBasicMeleeCatalog: Object.freeze(["brackenwheel", "coilblade", "ironroot", "mossguard"]),
  createBasicRangedCatalog: Object.freeze(["brassbolt", "reedsting"]),
  createBasicFlyingCatalog: Object.freeze(["copperskiff", "skymaul"]),
  createSwarmCatalog: Object.freeze([
    "briar-band", "cinder-host", "cinderlings", "forgeguard", "gloamwing-cluster", "thornscouts",
  ]),
  createChainSpecialCatalog: Object.freeze(["stormkite"]),
  createPierceSpecialCatalog: Object.freeze(["prism-warden"]),
  createReturnSpecialCatalog: Object.freeze(["rune-reaver"]),
  createPelletSpecialCatalog: Object.freeze(["scatterguard"]),
  createReflectionSpecialCatalog: Object.freeze(["aegis-sage"]),
  createOrdinaryProjectileSplashCatalog: Object.freeze(["kilnkeeper"]),
});

const SOURCE_BINDINGS = Object.freeze({
  createBasicMeleeCatalog,
  createBasicRangedCatalog,
  createBasicFlyingCatalog,
  createSwarmCatalog,
  createChainSpecialCatalog,
  createPierceSpecialCatalog,
  createReturnSpecialCatalog,
  createPelletSpecialCatalog,
  createReflectionSpecialCatalog,
  createOrdinaryProjectileSplashCatalog,
});

function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).map((key) => [key, clone(value[key])]));
  }
  return value;
}

function freeze(value, seen = new WeakSet()) {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) freeze(value[key], seen);
  Object.freeze(value);
  return value;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort(compareText).map((key) =>
      `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new TypeError("canonical data cannot contain undefined");
  return encoded;
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sourceRecordKey(exportName, id) {
  return `${exportName}\u0000${id}`;
}

// This is the one closed authoritative witness for every admitted source catalog.
// It is a complete canonical serialization, not a collision-prone digest.
const EXPECTED_SOURCE_WITNESS_MAP = Object.freeze({
  [sourceRecordKey("createBasicMeleeCatalog", "brackenwheel")]: canonical({
    areaDamageRadiusMillitiles: 2000,
    components: [],
    cost: 4,
    count: 1,
    damage: 267,
    deployTimeTicks: 60,
    displayName: "Brackenwheel",
    firstHitTicks: 84,
    hitSpeedTicks: 90,
    hitpoints: 1908,
    id: "brackenwheel",
    kind: "unit",
    movementMillitilesPerSecond: 1000,
    rangeMillitiles: 1200,
    rarity: "uncommon",
    sightRangeMillitiles: 5500,
    targetMode: "ground",
  }),
  [sourceRecordKey("createBasicMeleeCatalog", "coilblade")]: canonical({
    areaDamageRadiusMillitiles: null,
    components: [],
    cost: 4,
    count: 1,
    damage: 720,
    deployTimeTicks: 60,
    displayName: "Coilblade",
    firstHitTicks: 66,
    hitSpeedTicks: 96,
    hitpoints: 1361,
    id: "coilblade",
    kind: "unit",
    movementMillitilesPerSecond: 1500,
    rangeMillitiles: 800,
    rarity: "uncommon",
    sightRangeMillitiles: 5500,
    targetMode: "ground",
  }),
  [sourceRecordKey("createBasicMeleeCatalog", "ironroot")]: canonical({
    areaDamageRadiusMillitiles: null,
    components: [],
    cost: 7,
    count: 1,
    damage: 816,
    deployTimeTicks: 60,
    displayName: "Ironroot",
    firstHitTicks: 78,
    hitSpeedTicks: 108,
    hitpoints: 3760,
    id: "ironroot",
    kind: "unit",
    movementMillitilesPerSecond: 750,
    rangeMillitiles: 1200,
    rarity: "special",
    sightRangeMillitiles: 5000,
    targetMode: "ground",
  }),
  [sourceRecordKey("createBasicMeleeCatalog", "mossguard")]: canonical({
    areaDamageRadiusMillitiles: null,
    components: [],
    cost: 3,
    count: 1,
    damage: 202,
    deployTimeTicks: 60,
    displayName: "Mossguard",
    firstHitTicks: 42,
    hitSpeedTicks: 72,
    hitpoints: 1766,
    id: "mossguard",
    kind: "unit",
    movementMillitilesPerSecond: 1000,
    rangeMillitiles: 1200,
    rarity: "standard",
    sightRangeMillitiles: 5500,
    targetMode: "ground",
  }),
  [sourceRecordKey("createBasicRangedCatalog", "brassbolt")]: canonical({
    areaDamageRadiusMillitiles: null,
    components: [],
    cost: 4,
    count: 1,
    damage: 218,
    deployTimeTicks: 60,
    displayName: "Brassbolt",
    firstHitTicks: 12,
    hitSpeedTicks: 60,
    hitpoints: 720,
    id: "brassbolt",
    kind: "unit",
    movementMillitilesPerSecond: 1000,
    rangeMillitiles: 6000,
    rarity: "uncommon",
    sightRangeMillitiles: 6000,
    targetMode: "ground-and-air",
  }),
  [sourceRecordKey("createBasicRangedCatalog", "reedsting")]: canonical({
    areaDamageRadiusMillitiles: null,
    components: [],
    cost: 3,
    count: 1,
    damage: 131,
    deployTimeTicks: 60,
    displayName: "Reedsting",
    firstHitTicks: 21,
    hitSpeedTicks: 42,
    hitpoints: 260,
    id: "reedsting",
    kind: "unit",
    movementMillitilesPerSecond: 2000,
    rangeMillitiles: 6500,
    rarity: "uncommon",
    sightRangeMillitiles: 7500,
    targetMode: "ground-and-air",
  }),
  [sourceRecordKey("createBasicFlyingCatalog", "copperskiff")]: canonical({
    areaDamageRadiusMillitiles: null,
    components: [],
    cost: 4,
    count: 1,
    damage: 171,
    deployTimeTicks: 60,
    displayName: "Copperskiff",
    firstHitTicks: 36,
    hitSpeedTicks: 66,
    hitpoints: 614,
    id: "copperskiff",
    kind: "unit",
    movementMillitilesPerSecond: 1500,
    rangeMillitiles: 6000,
    rarity: "uncommon",
    sightRangeMillitiles: 6000,
    targetMode: "ground-and-air",
  }),
  [sourceRecordKey("createBasicFlyingCatalog", "skymaul")]: canonical({
    areaDamageRadiusMillitiles: null,
    components: [],
    cost: 3,
    count: 1,
    damage: 311,
    deployTimeTicks: 60,
    displayName: "Skymaul",
    firstHitTicks: 72,
    hitSpeedTicks: 96,
    hitpoints: 837,
    id: "skymaul",
    kind: "unit",
    movementMillitilesPerSecond: 1000,
    rangeMillitiles: 1600,
    rarity: "uncommon",
    sightRangeMillitiles: 5500,
    targetMode: "ground-and-air",
  }),
  [sourceRecordKey("createSwarmCatalog", "briar-band")]: canonical({
    areaDamageRadiusMillitiles: null,
    components: [
      {
        areaDamageRadiusMillitiles: null,
        count: 3,
        damage: 120,
        deployTimeTicks: 60,
        displayName: "Briar Runner",
        firstHitTicks: 42,
        hitSpeedTicks: 66,
        hitpoints: 202,
        id: "briar-runner",
        kind: "unit",
        movementMillitilesPerSecond: 2000,
        rangeMillitiles: 500,
        role: "primary",
        sightRangeMillitiles: 5500,
        targetMode: "ground",
      },
      {
        areaDamageRadiusMillitiles: null,
        count: 3,
        damage: 81,
        deployTimeTicks: 60,
        displayName: "Briar Darter",
        firstHitTicks: 72,
        hitSpeedTicks: 102,
        hitpoints: 133,
        id: "briar-darter",
        kind: "unit",
        movementMillitilesPerSecond: 2000,
        rangeMillitiles: 5000,
        role: "secondary",
        sightRangeMillitiles: 5500,
        targetMode: "ground-and-air",
      },
    ],
    cost: 3,
    count: 6,
    damage: 120,
    deployTimeTicks: 60,
    displayName: "Briar Band",
    firstHitTicks: 42,
    hitSpeedTicks: 66,
    hitpoints: 202,
    id: "briar-band",
    kind: "unit",
    movementMillitilesPerSecond: 2000,
    rangeMillitiles: 500,
    rarity: "standard",
    sightRangeMillitiles: 5500,
    targetMode: "ground",
  }),
  [sourceRecordKey("createSwarmCatalog", "gloamwing-cluster")]: canonical({
    areaDamageRadiusMillitiles: null,
    components: [{
      areaDamageRadiusMillitiles: null,
      count: 5,
      damage: 81,
      deployTimeTicks: 60,
      displayName: "Gloamwing",
      firstHitTicks: 42,
      hitSpeedTicks: 78,
      hitpoints: 81,
      id: "gloamwing",
      kind: "unit",
      movementMillitilesPerSecond: 2000,
      rangeMillitiles: 1200,
      role: "primary",
      sightRangeMillitiles: 5500,
      targetMode: "ground-and-air",
    }],
    cost: 2,
    count: 5,
    damage: 81,
    deployTimeTicks: 60,
    displayName: "Gloamwing Cluster",
    firstHitTicks: 42,
    hitSpeedTicks: 78,
    hitpoints: 81,
    id: "gloamwing-cluster",
    kind: "unit",
    movementMillitilesPerSecond: 2000,
    rangeMillitiles: 1200,
    rarity: "standard",
    sightRangeMillitiles: 5500,
    targetMode: "ground-and-air",
  }),
  [sourceRecordKey("createSwarmCatalog", "cinderlings")]: canonical({
    areaDamageRadiusMillitiles: null,
    components: [{
      areaDamageRadiusMillitiles: null,
      count: 3,
      damage: 81,
      deployTimeTicks: 60,
      displayName: "Cinderling",
      firstHitTicks: 30,
      hitSpeedTicks: 60,
      hitpoints: 81,
      id: "cinderling",
      kind: "unit",
      movementMillitilesPerSecond: 1500,
      rangeMillitiles: 500,
      role: "primary",
      sightRangeMillitiles: 5500,
      targetMode: "ground",
    }],
    cost: 1,
    count: 3,
    damage: 81,
    deployTimeTicks: 60,
    displayName: "Cinderlings",
    firstHitTicks: 30,
    hitSpeedTicks: 60,
    hitpoints: 81,
    id: "cinderlings",
    kind: "unit",
    movementMillitilesPerSecond: 1500,
    rangeMillitiles: 500,
    rarity: "standard",
    sightRangeMillitiles: 5500,
    targetMode: "ground",
  }),
  [sourceRecordKey("createSwarmCatalog", "cinder-host")]: canonical({
    areaDamageRadiusMillitiles: null,
    components: [{
      areaDamageRadiusMillitiles: null,
      count: 15,
      damage: 81,
      deployTimeTicks: 60,
      displayName: "Cinderling",
      firstHitTicks: 30,
      hitSpeedTicks: 60,
      hitpoints: 81,
      id: "cinderling",
      kind: "unit",
      movementMillitilesPerSecond: 1500,
      rangeMillitiles: 500,
      role: "primary",
      sightRangeMillitiles: 5500,
      targetMode: "ground",
    }],
    cost: 3,
    count: 15,
    damage: 81,
    deployTimeTicks: 60,
    displayName: "Cinder Host",
    firstHitTicks: 30,
    hitSpeedTicks: 60,
    hitpoints: 81,
    id: "cinder-host",
    kind: "unit",
    movementMillitilesPerSecond: 1500,
    rangeMillitiles: 500,
    rarity: "special",
    sightRangeMillitiles: 5500,
    targetMode: "ground",
  }),
  [sourceRecordKey("createSwarmCatalog", "thornscouts")]: canonical({
    areaDamageRadiusMillitiles: null,
    components: [{
      areaDamageRadiusMillitiles: null,
      count: 4,
      damage: 120,
      deployTimeTicks: 60,
      displayName: "Thornscout",
      firstHitTicks: 42,
      hitSpeedTicks: 66,
      hitpoints: 202,
      id: "thornscout",
      kind: "unit",
      movementMillitilesPerSecond: 2000,
      rangeMillitiles: 500,
      role: "primary",
      sightRangeMillitiles: 5500,
      targetMode: "ground",
    }],
    cost: 2,
    count: 4,
    damage: 120,
    deployTimeTicks: 60,
    displayName: "Thornscouts",
    firstHitTicks: 42,
    hitSpeedTicks: 66,
    hitpoints: 202,
    id: "thornscouts",
    kind: "unit",
    movementMillitilesPerSecond: 2000,
    rangeMillitiles: 500,
    rarity: "standard",
    sightRangeMillitiles: 5500,
    targetMode: "ground",
  }),
  [sourceRecordKey("createSwarmCatalog", "forgeguard")]: canonical({
    areaDamageRadiusMillitiles: null,
    components: [{
      areaDamageRadiusMillitiles: null,
      count: 5,
      damage: 192,
      deployTimeTicks: 60,
      displayName: "Forgeguard",
      firstHitTicks: 54,
      hitSpeedTicks: 78,
      hitpoints: 670,
      id: "forgeguard",
      kind: "unit",
      movementMillitilesPerSecond: 1000,
      rangeMillitiles: 700,
      role: "primary",
      sightRangeMillitiles: 5500,
      targetMode: "ground",
    }],
    cost: 5,
    count: 5,
    damage: 192,
    deployTimeTicks: 60,
    displayName: "Forgeguard",
    firstHitTicks: 54,
    hitSpeedTicks: 78,
    hitpoints: 670,
    id: "forgeguard",
    kind: "unit",
    movementMillitilesPerSecond: 1000,
    rangeMillitiles: 700,
    rarity: "standard",
    sightRangeMillitiles: 5500,
    targetMode: "ground",
  }),
  [sourceRecordKey("createChainSpecialCatalog", "stormkite")]: canonical({
    areaDamageRadiusMillitiles: null,
    components: [],
    cost: 5,
    count: 1,
    damage: 192,
    deployTimeTicks: 60,
    displayName: "Stormkite",
    firstHitTicks: 84,
    hitSpeedTicks: 126,
    hitpoints: 950,
    id: "stormkite",
    kind: "unit",
    movementMillitilesPerSecond: 1000,
    rangeMillitiles: 3500,
    rarity: "special",
    sightRangeMillitiles: 5500,
    targetMode: "ground-and-air",
  }),
  [sourceRecordKey("createPierceSpecialCatalog", "prism-warden")]: canonical({
    areaDamageRadiusMillitiles: null,
    components: [],
    cost: 4,
    count: 1,
    damage: 134,
    deployTimeTicks: 60,
    displayName: "Prism Warden",
    firstHitTicks: 36,
    hitSpeedTicks: 66,
    hitpoints: 532,
    id: "prism-warden",
    kind: "unit",
    movementMillitilesPerSecond: 1000,
    rangeMillitiles: 7000,
    rarity: "mythic",
    sightRangeMillitiles: 7500,
    targetMode: "ground-and-air",
  }),
  [sourceRecordKey("createReturnSpecialCatalog", "rune-reaver")]: canonical({
    areaDamageRadiusMillitiles: null,
    components: [],
    cost: 5,
    count: 1,
    damage: 169,
    deployTimeTicks: 60,
    displayName: "Rune Reaver",
    firstHitTicks: 24,
    hitSpeedTicks: 54,
    hitpoints: 1280,
    id: "rune-reaver",
    kind: "unit",
    movementMillitilesPerSecond: 1000,
    rangeMillitiles: 4500,
    rarity: "special",
    sightRangeMillitiles: 5500,
    targetMode: "ground-and-air",
  }),
  [sourceRecordKey("createPelletSpecialCatalog", "scatterguard")]: canonical({
    areaDamageRadiusMillitiles: 70,
    components: [],
    cost: 4,
    count: 1,
    damage: 84,
    deployTimeTicks: 60,
    displayName: "Scatterguard",
    firstHitTicks: 84,
    hitSpeedTicks: 132,
    hitpoints: 838,
    id: "scatterguard",
    kind: "unit",
    movementMillitilesPerSecond: 1000,
    rangeMillitiles: 4000,
    rarity: "special",
    sightRangeMillitiles: 5500,
    targetMode: "ground-and-air",
  }),
  [sourceRecordKey("createReflectionSpecialCatalog", "aegis-sage")]: canonical({
    areaDamageRadiusMillitiles: null,
    components: [],
    cost: 5,
    count: 1,
    damage: 140,
    deployTimeTicks: 60,
    displayName: "Aegis Sage",
    firstHitTicks: 36,
    hitSpeedTicks: 48,
    hitpoints: 2000,
    id: "aegis-sage",
    kind: "unit",
    movementMillitilesPerSecond: 1000,
    rangeMillitiles: 1200,
    rarity: "heroic",
    sightRangeMillitiles: 5500,
    targetMode: "ground",
  }),
  [sourceRecordKey("createOrdinaryProjectileSplashCatalog", "kilnkeeper")]: canonical({
    areaDamageRadiusMillitiles: null,
    components: [{
      areaDamageRadiusMillitiles: null,
      count: 1,
      damage: 281,
      deployTimeTicks: 60,
      displayName: "Kilnkeeper",
      firstHitTicks: 60,
      hitSpeedTicks: 84,
      hitpoints: 720,
      id: "kilnkeeper",
      kind: "unit",
      movementMillitilesPerSecond: 1000,
      rangeMillitiles: 5500,
      role: "primary",
      sightRangeMillitiles: 5500,
      targetMode: "ground-and-air",
    }],
    cost: 5,
    count: 1,
    damage: 281,
    deployTimeTicks: 60,
    displayName: "Kilnkeeper",
    firstHitTicks: 60,
    hitSpeedTicks: 84,
    hitpoints: 720,
    id: "kilnkeeper",
    kind: "unit",
    movementMillitilesPerSecond: 1000,
    rangeMillitiles: 5500,
    rarity: "uncommon",
    sightRangeMillitiles: 5500,
    targetMode: "ground-and-air",
  }),
});

function exactKeys(value, expected, label) {
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const actual = Reflect.ownKeys(descriptors);
  if (
    actual.length !== expected.length ||
    actual.some((key) => typeof key !== "string" || !expected.includes(key)) ||
    expected.some((key) => {
      const descriptor = descriptors[key];
      return !descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value");
    })
  ) {
    throw new TypeError(`${label} has an invalid field surface`);
  }
}

function assertPrimitiveFields(value, fields, label) {
  for (const field of fields) {
    const fieldValue = Object.getOwnPropertyDescriptor(value, field).value;
    if (fieldValue !== null && (typeof fieldValue === "object" || typeof fieldValue === "function")) {
      throw new TypeError(`${label}.${field} must be a primitive source value`);
    }
  }
}

function safeIntegerOrNull(value, label, minimum = 0) {
  if (value !== null && (!Number.isSafeInteger(value) || value < minimum)) {
    throw new TypeError(`${label} must be a safe integer or null`);
  }
}

function validateComponent(component, label) {
  exactKeys(component, COMPONENT_FIELDS, label);
  assertPrimitiveFields(component, COMPONENT_FIELDS, label);
  if (
    typeof component.id !== "string" ||
    component.id.length === 0 ||
    !SOURCE_ID_PATTERN.test(component.id) ||
    typeof component.displayName !== "string" ||
    component.displayName.length === 0 ||
    component.displayName.length > 80 ||
    component.displayName.trim() !== component.displayName ||
    component.kind !== "unit" ||
    !SOURCE_COMPONENT_ROLES.has(component.role) ||
    !SOURCE_TARGET_MODES.has(component.targetMode) ||
    !Number.isSafeInteger(component.count) ||
    component.count < 1
  ) {
    throw new TypeError(`${label} is not a complete source component`);
  }
  for (const [field, minimum] of [
    ["damage", 1],
    ["deployTimeTicks", 0],
    ["firstHitTicks", 0],
    ["hitSpeedTicks", 1],
    ["hitpoints", 1],
    ["movementMillitilesPerSecond", 0],
    ["rangeMillitiles", 0],
    ["sightRangeMillitiles", 1],
    ["areaDamageRadiusMillitiles", 0],
  ]) safeIntegerOrNull(component[field], `${label}.${field}`, minimum);
}

function validateSourceRecord(record, label) {
  exactKeys(record, SOURCE_RECORD_FIELDS, label);
  assertPrimitiveFields(record, SOURCE_RECORD_FIELDS.filter((field) => field !== "components"), label);
  if (
    typeof record.id !== "string" ||
    record.id.length === 0 ||
    !SOURCE_ID_PATTERN.test(record.id) ||
    typeof record.displayName !== "string" ||
    record.displayName.length === 0 ||
    record.displayName.length > 80 ||
    record.displayName.trim() !== record.displayName ||
    record.kind !== "unit" ||
    !SOURCE_RARITIES.has(record.rarity) ||
    !SOURCE_TARGET_MODES.has(record.targetMode) ||
    !Number.isSafeInteger(record.cost) ||
    record.cost < 1 ||
    record.cost > 10 ||
    !Number.isSafeInteger(record.count) ||
    record.count < 1
  ) {
    throw new TypeError(`${label} is not a complete source unit record`);
  }
  for (const [field, minimum] of [
    ["damage", 1],
    ["deployTimeTicks", 0],
    ["firstHitTicks", 0],
    ["hitSpeedTicks", 1],
    ["hitpoints", 1],
    ["movementMillitilesPerSecond", 0],
    ["rangeMillitiles", 0],
    ["sightRangeMillitiles", 1],
    ["areaDamageRadiusMillitiles", 0],
  ]) safeIntegerOrNull(record[field], `${label}.${field}`, minimum);
  const components = Object.getOwnPropertyDescriptor(record, "components").value;
  if (!Array.isArray(components) || components.length > MAX_COMPONENTS) {
    throw new TypeError(`${label}.components must be bounded`);
  }
  for (let index = 0; index < components.length; index += 1) {
    validateComponent(components[index], `${label}.components[${index}]`);
  }
}

function denseCatalog(value, label) {
  if (!Array.isArray(value) || value.length > MAX_SOURCE_CATALOG_ROWS) {
    throw new TypeError(`${label} must be a bounded source catalog`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const expected = new Set([
    "length",
    ...Array.from({ length: value.length }, (_, index) => String(index)),
  ]);
  if (
    Reflect.ownKeys(descriptors).length !== expected.size ||
    [...Reflect.ownKeys(descriptors)].some((key) =>
      typeof key !== "string" || !expected.has(key)) ||
    !descriptors.length ||
    descriptors.length.enumerable ||
    !Object.hasOwn(descriptors.length, "value") ||
    descriptors.length.value !== value.length ||
    Array.from({ length: value.length }, (_, index) => String(index)).some((key) =>
      !descriptors[key].enumerable || !Object.hasOwn(descriptors[key], "value"))
  ) {
    throw new TypeError(`${label} must contain dense data properties`);
  }
}

function inspectSafeCatalog(value, exportName) {
  assertSafeCardCatalogGraph(value, `${exportName} source catalog`);
  denseCatalog(value, `${exportName} source catalog`);
  for (let index = 0; index < value.length; index += 1) {
    validateSourceRecord(value[index], `${exportName}[${index}]`);
  }
  return value;
}

function assertExpectedIds(exportName, rows) {
  const actual = rows.map((row) => row.id).sort(compareText);
  const expected = [...AUTHORITATIVE_PROJECTILE_SOURCE_IDS_BY_EXPORT[exportName]].sort(compareText);
  if (canonical(actual) !== canonical(expected)) {
    throw new Error(`${exportName} source catalog has a missing, stale, or extra source record`);
  }
}

function assertFreshReads(exportName, firstValue, secondValue, firstRows, secondRows) {
  if (
    firstValue === secondValue ||
    firstRows.length !== secondRows.length ||
    firstRows.some((row, index) =>
      row === secondRows[index] ||
      row.components === secondRows[index].components ||
      row.components.some((component, componentIndex) =>
        component === secondRows[index].components[componentIndex]))
  ) {
    throw new Error(`${exportName} source catalog reads are not fresh`);
  }
  if (canonical(firstRows) !== canonical(secondRows)) {
    throw new Error(`${exportName} source catalog changed between reads`);
  }
}

function assertWitness(exportName, rows) {
  for (const row of rows) {
    const expected = EXPECTED_SOURCE_WITNESS_MAP[sourceRecordKey(exportName, row.id)];
    if (typeof expected !== "string" || canonical(row) !== expected) {
      throw new Error(`${exportName}/${row.id} differs from its authoritative source witness`);
    }
  }
}

function assertWitnessCoverage() {
  const expectedKeys = Object.entries(AUTHORITATIVE_PROJECTILE_SOURCE_IDS_BY_EXPORT)
    .flatMap(([exportName, ids]) => ids.map((id) => sourceRecordKey(exportName, id)))
    .sort(compareText);
  const actualKeys = Object.keys(EXPECTED_SOURCE_WITNESS_MAP).sort(compareText);
  if (canonical(actualKeys) !== canonical(expectedKeys)) {
    throw new Error("projectile source witness key set is missing, stale, or extra");
  }
}

function buildRegistry() {
  const registry = {};
  for (const exportName of Object.keys(AUTHORITATIVE_PROJECTILE_SOURCE_IDS_BY_EXPORT)) {
    const factory = SOURCE_BINDINGS[exportName];
    const firstValue = factory();
    const firstRows = inspectSafeCatalog(firstValue, exportName);
    const secondValue = factory();
    const secondRows = inspectSafeCatalog(secondValue, exportName);
    assertExpectedIds(exportName, firstRows);
    assertExpectedIds(exportName, secondRows);
    assertFreshReads(exportName, firstValue, secondValue, firstRows, secondRows);
    assertWitness(exportName, firstRows);
    assertWitness(exportName, secondRows);
    registry[exportName] = firstRows.map(clone);
  }
  return freeze(registry);
}

/**
 * Verifies the closed projectile source witness and returns detached frozen
 * snapshots for shared consumers. It accepts no caller-supplied authority:
 * callers can verify the closed witness, but cannot register or mint one.
 */
export function assertAuthoritativeProjectileSourceCatalogs(...args) {
  if (args.length !== 0) {
    throw new TypeError("authoritative projectile source admission takes no arguments");
  }
  assertWitnessCoverage();
  return buildRegistry();
}
