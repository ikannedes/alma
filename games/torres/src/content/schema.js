export const TICKS_PER_SECOND = 60;
export const MILLITILES_PER_TILE = 1_000;

export const CARD_KINDS = Object.freeze([
  "unit",
  "structure",
  "effect",
]);
export const CARD_RARITIES = Object.freeze([
  "standard",
  "uncommon",
  "special",
  "mythic",
  "heroic",
]);
export const TARGET_MODES = Object.freeze([
  "none",
  "ground",
  "air",
  "ground-and-air",
  "structures",
]);
export const COMPONENT_ROLES = Object.freeze([
  "primary",
  "secondary",
  "spawn",
  "spawn-over-time",
]);

const ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const COMBAT_KEYS = Object.freeze([
  "hitpoints",
  "damage",
  "hitSpeedTicks",
  "firstHitTicks",
  "deployTimeTicks",
  "rangeMillitiles",
  "sightRangeMillitiles",
  "movementMillitilesPerSecond",
  "targetMode",
  "count",
  "areaDamageRadiusMillitiles",
]);
const COMPONENT_KEYS = Object.freeze([
  "id",
  "displayName",
  "kind",
  "role",
  ...COMBAT_KEYS,
]);
const CARD_KEYS = Object.freeze([
  "id",
  "displayName",
  "cost",
  "kind",
  "rarity",
  ...COMBAT_KEYS,
  "components",
]);
const PRIMARY_FIELDS = Object.freeze([
  "kind",
  ...COMBAT_KEYS.filter((key) => key !== "count"),
]);

const hasOwn = (value, key) =>
  Object.prototype.hasOwnProperty.call(value, key);

// Catalog outputs stay mutable for caller isolation tests and runtime use, so
// structural shape alone cannot identify a safe-to-inspect source graph. Keep
// the capability private: consumers may ask whether a graph is one of our
// exact outputs, but no caller can brand a replacement object. This metadata
// proves graph construction and descriptor safety only; it never proves that
// the graph contains authoritative source values.
const SAFE_CATALOG_GRAPH = new WeakSet();
const SAFE_CATALOG_SHAPES = new WeakMap();

function assertSafeDataRecord(value, keys, label) {
  if (Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${label} is not a canonical catalog record`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const actual = Reflect.ownKeys(descriptors);
  if (
    actual.length !== keys.length ||
    actual.some((key) => typeof key !== "string" || !keys.includes(key)) ||
    keys.some((key) => (
      !hasOwn(descriptors, key) ||
      !descriptors[key].enumerable ||
      !hasOwn(descriptors[key], "value")
    ))
  ) {
    throw new TypeError(`${label} is not a canonical catalog record`);
  }
}

function assertSafeDataArray(value, expectedValues, label) {
  if (Object.getPrototypeOf(value) !== Array.prototype) {
    throw new TypeError(`${label} is not a canonical catalog array`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const expectedKeys = new Set([
    "length",
    ...expectedValues.map((_, index) => String(index)),
  ]);
  const actualKeys = Reflect.ownKeys(descriptors);
  if (
    actualKeys.length !== expectedKeys.size ||
    actualKeys.some((key) => typeof key !== "string" || !expectedKeys.has(key)) ||
    !hasOwn(descriptors, "length") ||
    descriptors.length.enumerable ||
    !hasOwn(descriptors.length, "value") ||
    descriptors.length.value !== expectedValues.length
  ) {
    throw new TypeError(`${label} is not a canonical catalog array`);
  }
  for (let index = 0; index < expectedValues.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (
      !descriptor ||
      !descriptor.enumerable ||
      !hasOwn(descriptor, "value") ||
      !SAFE_CATALOG_GRAPH.has(descriptor.value) ||
      descriptor.value !== expectedValues[index]
    ) {
      throw new TypeError(`${label} graph identity changed`);
    }
  }
}

function assertSafeCatalogGraph(catalog, shape, label) {
  const expectedCards = shape.cards.map(({ card }) => card);
  assertSafeDataArray(catalog, expectedCards, label);
  for (let index = 0; index < shape.cards.length; index += 1) {
    const expected = shape.cards[index];
    const card = expectedCards[index];
    if (!SAFE_CATALOG_GRAPH.has(card) || card !== expected.card) {
      throw new TypeError(`${label} graph identity changed`);
    }
    assertSafeDataRecord(card, CARD_KEYS, `${label}[${index}]`);
    const components = Object.getOwnPropertyDescriptor(card, "components").value;
    if (
      !SAFE_CATALOG_GRAPH.has(components) ||
      components !== expected.components
    ) {
      throw new TypeError(`${label}[${index}].components graph identity changed`);
    }
    assertSafeDataArray(
      components,
      expected.components,
      `${label}[${index}].components`,
    );
    for (let componentIndex = 0; componentIndex < expected.components.length; componentIndex += 1) {
      const component = expected.components[componentIndex];
      if (!SAFE_CATALOG_GRAPH.has(component)) {
        throw new TypeError(`${label}[${index}].components graph identity changed`);
      }
      assertSafeDataRecord(
        component,
        COMPONENT_KEYS,
        `${label}[${index}].components[${componentIndex}]`,
      );
    }
  }
}

/**
 * Admits only a safe-to-inspect catalog graph produced by createCardCatalog.
 * The initial
 * WeakSet check is intentionally the first operation so Proxy wrappers are
 * rejected without invoking any proxy trap; descriptor inspection happens
 * only after exact graph identity has been established.
 */
export function assertSafeCardCatalogGraph(catalog, label = "card catalog") {
  if (!SAFE_CATALOG_GRAPH.has(catalog)) {
    throw new TypeError(`${label} was not produced by the canonical catalog constructor`);
  }
  const shape = SAFE_CATALOG_SHAPES.get(catalog);
  if (shape === undefined) {
    throw new TypeError(`${label} is not a canonical catalog root`);
  }
  assertSafeCatalogGraph(catalog, shape, label);
  return catalog;
}

// Compatibility name for existing internal callers. This is deliberately only
// the safe graph admission check above, not an authoritative-value admission.
export const assertTrustedCardCatalog = assertSafeCardCatalogGraph;

function registerSafeCatalog(catalog) {
  const cards = catalog.map((card) => ({
    card,
    components: card.components,
  }));
  SAFE_CATALOG_GRAPH.add(catalog);
  for (const { card, components } of cards) {
    SAFE_CATALOG_GRAPH.add(card);
    SAFE_CATALOG_GRAPH.add(components);
    for (const component of components) SAFE_CATALOG_GRAPH.add(component);
  }
  SAFE_CATALOG_SHAPES.set(catalog, { cards });
  return catalog;
}

function assertPlainExactRecord(value, keys, label) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    throw new TypeError(`${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain object`);
  }

  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== keys.length ||
    ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))
  ) {
    throw new TypeError(`${label} must have exactly the required own properties`);
  }

  for (const key of keys) {
    if (!hasOwn(value, key)) {
      throw new TypeError(`${label} must have exactly the required own properties`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      !hasOwn(descriptor, "value") ||
      !descriptor.enumerable
    ) {
      throw new TypeError(
        `${label}.${key} must be an enumerable data property`,
      );
    }
  }
}

function assertDensePlainArray(value, label) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new TypeError(`${label} must be a plain array`);
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new TypeError(`${label} must not have symbol properties`);
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!hasOwn(value, index)) {
      throw new TypeError(`${label} must be dense`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!hasOwn(descriptor, "value") || !descriptor.enumerable) {
      throw new TypeError(`${label}[${index}] must be an enumerable data property`);
    }
  }
  const allowed = new Set([
    "length",
    ...Array.from({ length: value.length }, (_, index) => String(index)),
  ]);
  if (Reflect.ownKeys(value).some((key) => !allowed.has(key))) {
    throw new TypeError(`${label} must not have extra properties`);
  }
}

function assertEnum(value, allowed, label) {
  if (!allowed.includes(value)) {
    throw new TypeError(`${label} must be one of: ${allowed.join(", ")}`);
  }
}

function assertIdentity(id, displayName, label) {
  if (typeof id !== "string" || !ID_PATTERN.test(id)) {
    throw new TypeError(`${label}.id must be an original kebab-case id`);
  }
  if (
    typeof displayName !== "string" ||
    displayName.length < 1 ||
    displayName.length > 80 ||
    displayName.trim() !== displayName ||
    /[\u0000-\u001f\u007f]/u.test(displayName)
  ) {
    throw new TypeError(`${label}.displayName must be a non-empty display name`);
  }
}

function assertInteger(value, { allowNull, minimum }, label) {
  if (allowNull && value === null) return;
  if (!Number.isSafeInteger(value) || value < minimum) {
    const nullable = allowNull ? " or null" : "";
    throw new TypeError(
      `${label} must be a safe integer >= ${minimum}${nullable}`,
    );
  }
}

function assertCombatFields(value, label) {
  assertInteger(value.hitpoints, { allowNull: true, minimum: 1 }, `${label}.hitpoints`);
  assertInteger(value.damage, { allowNull: true, minimum: 1 }, `${label}.damage`);
  assertInteger(value.hitSpeedTicks, { allowNull: true, minimum: 1 }, `${label}.hitSpeedTicks`);
  assertInteger(value.firstHitTicks, { allowNull: true, minimum: 0 }, `${label}.firstHitTicks`);
  assertInteger(value.deployTimeTicks, { allowNull: true, minimum: 0 }, `${label}.deployTimeTicks`);
  assertInteger(value.rangeMillitiles, { allowNull: true, minimum: 0 }, `${label}.rangeMillitiles`);
  assertInteger(value.sightRangeMillitiles, { allowNull: true, minimum: 1 }, `${label}.sightRangeMillitiles`);
  assertInteger(
    value.movementMillitilesPerSecond,
    { allowNull: true, minimum: 0 },
    `${label}.movementMillitilesPerSecond`,
  );
  assertInteger(value.count, { allowNull: false, minimum: 1 }, `${label}.count`);
  assertInteger(
    value.areaDamageRadiusMillitiles,
    { allowNull: true, minimum: 1 },
    `${label}.areaDamageRadiusMillitiles`,
  );
  assertEnum(value.targetMode, TARGET_MODES, `${label}.targetMode`);

  if (value.kind === "structure") {
    if (value.movementMillitilesPerSecond !== 0) {
      throw new TypeError(
        `${label} structure movement must be zero`,
      );
    }
  } else if (
    value.kind === "effect" &&
    (
      value.hitpoints !== null ||
      value.movementMillitilesPerSecond !== null
    )
  ) {
    throw new TypeError(
      `${label} effect hitpoints and movement must be null`,
    );
  }
}

function canonicalCombat(value) {
  return {
    hitpoints: value.hitpoints,
    damage: value.damage,
    hitSpeedTicks: value.hitSpeedTicks,
    firstHitTicks: value.firstHitTicks,
    deployTimeTicks: value.deployTimeTicks,
    rangeMillitiles: value.rangeMillitiles,
    sightRangeMillitiles: value.sightRangeMillitiles,
    movementMillitilesPerSecond: value.movementMillitilesPerSecond,
    targetMode: value.targetMode,
    count: value.count,
    areaDamageRadiusMillitiles: value.areaDamageRadiusMillitiles,
  };
}

function validateComponent(component, index) {
  const label = `card.components[${index}]`;
  assertPlainExactRecord(component, COMPONENT_KEYS, label);
  assertIdentity(component.id, component.displayName, label);
  assertEnum(component.kind, CARD_KINDS, `${label}.kind`);
  assertEnum(component.role, COMPONENT_ROLES, `${label}.role`);
  assertCombatFields(component, label);
  return {
    id: component.id,
    displayName: component.displayName,
    kind: component.kind,
    role: component.role,
    ...canonicalCombat(component),
  };
}

function assertMixedSemantics(card) {
  const initial = card.components.filter(
    ({ role }) => role === "primary" || role === "secondary",
  );
  const primary = card.components.filter(({ role }) => role === "primary");
  if (primary.length > 1 || (initial.length > 0 && primary.length !== 1)) {
    throw new TypeError(
      "card.components must have exactly one primary when initial components exist",
    );
  }
  if (initial.length > 0) {
    const initialCount = initial.reduce((sum, component) => {
      if (!Number.isSafeInteger(sum + component.count)) {
        throw new TypeError("card initial component count exceeds safe integer range");
      }
      return sum + component.count;
    }, 0);
    if (card.count !== initialCount) {
      throw new TypeError(
        "card.count must equal primary and secondary component counts",
      );
    }
    for (const field of PRIMARY_FIELDS) {
      if (card[field] !== primary[0][field]) {
        throw new TypeError(
          `card.${field} must match the primary component`,
        );
      }
    }
  }
}

/**
 * Validates one original runtime definition and returns an isolated,
 * canonical-key-order JSON value. This validates definitions only; it does not
 * implement any card, ability, interaction, art, audio, or UI behavior.
 */
export function validateCardDefinition(definition) {
  assertPlainExactRecord(definition, CARD_KEYS, "card");
  assertIdentity(definition.id, definition.displayName, "card");
  assertInteger(definition.cost, { allowNull: false, minimum: 1 }, "card.cost");
  if (definition.cost > 10) {
    throw new TypeError("card.cost must be between 1 and 10");
  }
  assertEnum(definition.kind, CARD_KINDS, "card.kind");
  assertEnum(definition.rarity, CARD_RARITIES, "card.rarity");
  assertCombatFields(definition, "card");
  assertDensePlainArray(definition.components, "card.components");

  const components = definition.components.map(validateComponent);
  const componentIds = new Set();
  const componentNames = new Set();
  for (const component of components) {
    const foldedName = component.displayName.toLowerCase();
    if (componentIds.has(component.id) || componentNames.has(foldedName)) {
      throw new TypeError("card component ids and display names must be unique");
    }
    componentIds.add(component.id);
    componentNames.add(foldedName);
  }

  const card = {
    id: definition.id,
    displayName: definition.displayName,
    cost: definition.cost,
    kind: definition.kind,
    rarity: definition.rarity,
    ...canonicalCombat(definition),
    components,
  };
  assertMixedSemantics(card);
  return card;
}

/**
 * Returns validated definitions sorted by original runtime id. The returned
 * catalog and every nested value are newly allocated.
 */
export function createCardCatalog(definitions) {
  assertDensePlainArray(definitions, "card catalog");
  const cards = definitions.map(validateCardDefinition);
  const ids = new Set();
  const names = new Set();
  for (const card of cards) {
    const foldedName = card.displayName.toLowerCase();
    if (ids.has(card.id)) {
      throw new TypeError(`duplicate card id: ${card.id}`);
    }
    if (names.has(foldedName)) {
      throw new TypeError(`duplicate card display name: ${card.displayName}`);
    }
    ids.add(card.id);
    names.add(foldedName);
  }
  cards.sort((left, right) => (
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0
  ));
  return registerSafeCatalog(cards.map((card) => validateCardDefinition(card)));
}

function exactScale(value, scale, label) {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    !Number.isSafeInteger(value * scale)
  ) {
    throw new TypeError(
      `${label} must be a non-negative value exactly representable at scale ${scale}`,
    );
  }
  return value * scale;
}

/**
 * Converts a finite non-negative number when it round-trips through exactly
 * one safe integer tick count. The accepted representation is the JavaScript
 * number produced by `ticks / 60`; nearby decimal approximations are rejected.
 */
export function secondsToTicksExact(seconds) {
  if (
    typeof seconds !== "number" ||
    !Number.isFinite(seconds) ||
    seconds < 0
  ) {
    throw new TypeError(
      "seconds must be exactly representable: round-trip to one non-negative safe integer tick count",
    );
  }

  // Search the integer domain instead of multiplying seconds by 60. At large
  // magnitudes that multiplication can round to a half-integer even when one
  // (and only one) safe tick count divides back to `seconds`.
  let firstLow = 0;
  let firstHigh = Number.MAX_SAFE_INTEGER;
  while (firstLow < firstHigh) {
    const middle = firstLow + Math.floor((firstHigh - firstLow) / 2);
    if (middle / TICKS_PER_SECOND < seconds) {
      firstLow = middle + 1;
    } else {
      firstHigh = middle;
    }
  }

  const ticks = firstLow;
  if (ticks / TICKS_PER_SECOND !== seconds) {
    throw new TypeError(
      "seconds must be exactly representable: round-trip to one non-negative safe integer tick count",
    );
  }

  // Find the other end of the complete equality interval. Integer division by
  // a positive constant is monotonic, so the input identifies a unique tick
  // exactly when the lower and upper boundaries coincide.
  let lastLow = ticks;
  let lastHigh = Number.MAX_SAFE_INTEGER;
  while (lastLow < lastHigh) {
    const middle =
      lastLow + Math.ceil((lastHigh - lastLow) / 2);
    if (middle / TICKS_PER_SECOND > seconds) {
      lastHigh = middle - 1;
    } else {
      lastLow = middle;
    }
  }
  if (lastLow !== ticks) {
    throw new TypeError(
      "seconds must be exactly representable: round-trip to one non-negative safe integer tick count",
    );
  }

  return ticks === 0 ? 0 : ticks;
}

export function tilesToMillitilesExact(tiles) {
  return exactScale(tiles, MILLITILES_PER_TILE, "tiles");
}
