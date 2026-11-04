import { EntityStore } from "../../sim/entities.js";
import { layoutFormation } from "../../sim/formations.js";
import {
  MAX_SPATIAL_MILLITILES,
  validatePosition,
} from "../../sim/spatial.js";

const BATCH_KEYS = ["anchor", "children", "ownerId", "sourceId"];
const CHILD_KEYS = ["archetypeId", "radius", "role"];
const ENTITY_DATA_KEYS = [
  "archetypeId",
  "offset",
  "ownerId",
  "position",
  "radius",
  "role",
  "sourceId",
];
const MAX_CHILDREN = 15;
const MAX_BATCHES = 1024;
const QUESTION_SOURCE = "unsourced-spawn-placement-policy-fixture";
const SNAPSHOT_KEYS = ["batches", "store", "version"];
const SNAPSHOT_VERSION = 2;
export const SPAWN_ARCHETYPE_ID_MAX_CODE_POINTS = 128;
export const SPAWN_SNAPSHOT_MAX_BYTES = 131_072;

function deepFreeze(value) {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

const QUESTION_RECORDS = deepFreeze({
  order: {
    authoritative: false,
    confidence: "unverified",
    disposition: "question",
    key: "spawn-batch-order",
    source: QUESTION_SOURCE,
    value: "caller-child-order-maps-to-formation-slot-and-entity-id-order",
  },
  ownership: {
    authoritative: false,
    confidence: "unverified",
    disposition: "question",
    key: "spawn-child-attribution",
    source: QUESTION_SOURCE,
    value: "every-child-inherits-batch-owner-id-and-source-id",
  },
  placement: {
    authoritative: false,
    confidence: "unverified",
    disposition: "question",
    key: "spawn-formation-placement",
    source: QUESTION_SOURCE,
    value: "attached-layout-formation-at-literal-integer-anchor-with-no-rng",
  },
});

function exactDataObject(value, keys, label) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (
      Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null
    )
  ) {
    throw new TypeError(`${label} must be a plain object`);
  }
  if (Object.getOwnPropertySymbols(value).length !== 0) {
    throw new TypeError(`${label} must contain only string-keyed data`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const actual = Reflect.ownKeys(descriptors);
  if (
    actual.length !== keys.length ||
    actual.some((key) => (
      typeof key !== "string" ||
      !keys.includes(key) ||
      !descriptors[key].enumerable ||
      !Object.hasOwn(descriptors[key], "value")
    ))
  ) {
    throw new TypeError(`${label} has an invalid shape`);
  }
  return Object.fromEntries(keys.map((key) => [key, descriptors[key].value]));
}

function denseChildren(value) {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length < 1 ||
    value.length > MAX_CHILDREN
  ) {
    throw new RangeError("spawn children must be a plain array of 1 to 15 entries");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(descriptors).length !== value.length + 1 ||
    Array.from({ length: value.length }, (_, index) => index).some(
      (index) => (
        !descriptors[index]?.enumerable ||
        !Object.hasOwn(descriptors[index], "value")
      ),
    )
  ) {
    throw new TypeError("spawn children must contain only dense data properties");
  }
  return Array.from(
    { length: value.length },
    (_, index) => descriptors[index].value,
  );
}

function denseBatches(value) {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > MAX_BATCHES
  ) {
    throw new RangeError(
      `spawn snapshot batches must be a plain array of at most ${MAX_BATCHES} entries`,
    );
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(descriptors).length !== value.length + 1 ||
    Array.from({ length: value.length }, (_, index) => index).some(
      (index) => (
        !descriptors[index]?.enumerable ||
        !Object.hasOwn(descriptors[index], "value")
      ),
    )
  ) {
    throw new TypeError(
      "spawn snapshot batches must contain only dense data properties",
    );
  }
  return Array.from(
    { length: value.length },
    (_, index) => descriptors[index].value,
  );
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

function checkedId(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return value;
}

function checkedArchetypeId(value, label) {
  let codePoints = 0;
  const wellFormed = typeof value === "string" && value.isWellFormed();
  if (wellFormed) {
    for (const _codePoint of value) {
      codePoints += 1;
      if (codePoints > SPAWN_ARCHETYPE_ID_MAX_CODE_POINTS) break;
    }
  }
  if (
    !wellFormed ||
    codePoints < 1 ||
    codePoints > SPAWN_ARCHETYPE_ID_MAX_CODE_POINTS
  ) {
    throw new TypeError(
      `${label} must contain 1 to ${SPAWN_ARCHETYPE_ID_MAX_CODE_POINTS} well-formed Unicode code points`,
    );
  }
  return value;
}

function checkedChild(value, index) {
  const child = exactDataObject(value, CHILD_KEYS, `spawn child ${index}`);
  checkedArchetypeId(
    child.archetypeId,
    `spawn child ${index}.archetypeId`,
  );
  if (
    !Number.isSafeInteger(child.radius) ||
    child.radius < 0
  ) {
    throw new TypeError(
      `spawn child ${index}.radius must be a non-negative safe integer`,
    );
  }
  if (child.role !== "primary" && child.role !== "secondary") {
    throw new TypeError(
      `spawn child ${index}.role must be "primary" or "secondary"`,
    );
  }
  return child;
}

function checkedOffset(value, label) {
  const offset = exactDataObject(value, ["x", "y"], label);
  for (const axis of ["x", "y"]) {
    if (
      !Number.isSafeInteger(offset[axis]) ||
      Math.abs(offset[axis]) > MAX_SPATIAL_MILLITILES * 2
    ) {
      throw new TypeError(
        `${label}.${axis} must be a bounded safe integer millitile offset`,
      );
    }
  }
  return offset;
}

function checkedStoredEntityData(value, index) {
  const label = `spawn snapshot entity ${index}.data`;
  const data = exactDataObject(value, ENTITY_DATA_KEYS, label);
  checkedArchetypeId(data.archetypeId, `${label}.archetypeId`);
  const offset = checkedOffset(data.offset, `${label}.offset`);
  const position = validatePosition(data.position, `${label}.position`);
  checkedId(data.ownerId, `${label}.ownerId`);
  checkedId(data.sourceId, `${label}.sourceId`);
  if (
    !Number.isSafeInteger(data.radius) ||
    data.radius < 0 ||
    data.radius > MAX_SPATIAL_MILLITILES
  ) {
    throw new TypeError(
      `${label}.radius must be a non-negative safe integer within spatial bounds`,
    );
  }
  if (data.role !== "primary" && data.role !== "secondary") {
    throw new TypeError(
      `${label}.role must be "primary" or "secondary"`,
    );
  }
  validatePosition(
    {
      x: position.x - offset.x,
      y: position.y - offset.y,
    },
    `${label}.derivedAnchor`,
  );
}

function checkedSnapshotStore(value) {
  const serialized = canonicalJson(value);
  const store = EntityStore.restore(serialized);
  const entities = store.list();
  for (let index = 0; index < entities.length; index += 1) {
    checkedStoredEntityData(entities[index].data, index);
  }
  return store;
}

function checkedBatch(value, firstId) {
  // Every descriptor is checked before any caller-controlled property value is
  // read. This makes accessor rejection non-observing and keeps failure atomic.
  const batch = exactDataObject(value, BATCH_KEYS, "spawn batch");
  const children = denseChildren(batch.children);
  const childDescriptorSets = children.map((child, index) =>
    exactDataObject(child, CHILD_KEYS, `spawn child ${index}`));
  const checkedChildren = childDescriptorSets.map((child, index) =>
    checkedChild(child, index));

  const ownerId = checkedId(batch.ownerId, "spawn batch.ownerId");
  const sourceId = checkedId(batch.sourceId, "spawn batch.sourceId");
  if (children.length >= Number.MAX_SAFE_INTEGER - firstId) {
    throw new RangeError("spawn batch would exhaust the entity ID space");
  }

  const formation = layoutFormation(
    batch.anchor,
    checkedChildren.map(({ radius, role }, index) => ({
      id: firstId + index,
      radius,
      role,
    })),
  );
  const anchor = {
    x: formation[0].position.x - formation[0].offset.x,
    y: formation[0].position.y - formation[0].offset.y,
  };
  const ledgerBatch = {
    anchor,
    children: checkedChildren.map(({ archetypeId, radius, role }) => ({
      archetypeId,
      radius,
      role,
    })),
    ownerId,
    sourceId,
  };
  return { checkedChildren, formation, ledgerBatch, ownerId, sourceId };
}

function serializeSnapshot(store, batches) {
  return canonicalJson({
    batches,
    store: JSON.parse(store.serialize()),
    version: SNAPSHOT_VERSION,
  });
}

/**
 * Materializes attached spawn batches through the deterministic formation and
 * entity lifecycle primitives. It intentionally has no clock, cadence, death
 * trigger, or random source.
 */
export class SpawnBatchMaterializer {
  #batches;
  #store;

  constructor() {
    this.#batches = [];
    this.#store = new EntityStore();
  }

  get nextId() {
    return this.#store.nextId;
  }

  list() {
    return this.#store.list();
  }

  materialize(batch) {
    const {
      checkedChildren,
      formation,
      ledgerBatch,
      ownerId,
      sourceId,
    } = checkedBatch(batch, this.#store.nextId);
    if (this.#batches.length >= MAX_BATCHES) {
      throw new RangeError(`spawn materializer supports at most ${MAX_BATCHES} batches`);
    }

    const operations = formation.map((placed, index) => ({
      data: {
        archetypeId: checkedChildren[index].archetypeId,
        offset: placed.offset,
        ownerId,
        position: placed.position,
        radius: placed.radius,
        role: placed.role,
        sourceId,
      },
      type: "spawn",
    }));

    // Stage the whole operation against an isolated candidate lifecycle. This
    // keeps schema, spatial, ID, and resulting snapshot-size failures atomic.
    const candidate = EntityStore.restore(this.#store.serialize());
    const result = candidate.apply(operations);
    const candidateBatches = [...this.#batches, ledgerBatch];
    const serialized = serializeSnapshot(candidate, candidateBatches);
    if (new TextEncoder().encode(serialized).byteLength > SPAWN_SNAPSHOT_MAX_BYTES) {
      throw new RangeError(
        `spawn batch would exceed the ${SPAWN_SNAPSHOT_MAX_BYTES}-byte snapshot bound`,
      );
    }
    this.#batches = candidateBatches;
    this.#store = candidate;
    return result;
  }

  serialize() {
    return serializeSnapshot(this.#store, this.#batches);
  }

  static restore(serialized) {
    if (typeof serialized !== "string") {
      throw new TypeError("serialized spawn snapshot must be a string");
    }
    if (new TextEncoder().encode(serialized).byteLength > SPAWN_SNAPSHOT_MAX_BYTES) {
      throw new RangeError(
        `serialized spawn snapshot exceeds ${SPAWN_SNAPSHOT_MAX_BYTES} UTF-8 bytes`,
      );
    }

    let raw;
    try {
      raw = JSON.parse(serialized);
    } catch {
      throw new TypeError("serialized spawn snapshot must be valid JSON");
    }
    if (canonicalJson(raw) !== serialized) {
      throw new TypeError(
        "serialized spawn snapshot must use exact canonical bytes",
      );
    }
    const snapshot = exactDataObject(raw, SNAPSHOT_KEYS, "spawn snapshot");
    if (snapshot.version !== SNAPSHOT_VERSION) {
      throw new TypeError("serialized spawn snapshot version is unsupported");
    }
    const batches = denseBatches(snapshot.batches);
    checkedSnapshotStore(snapshot.store);

    const replayed = new SpawnBatchMaterializer();
    for (const ledgerBatch of batches) {
      replayed.materialize(ledgerBatch);
    }
    if (replayed.serialize() !== serialized) {
      throw new TypeError(
        "serialized spawn snapshot is not reproducible from its batch ledger",
      );
    }
    return replayed;
  }
}

/**
 * Returns fresh deeply immutable records. These policies are absent from the
 * comparison corpus and must never be presented as authoritative parity.
 */
export function createSpawnPlacementQuestionRecords(...args) {
  if (args.length !== 0) {
    throw new TypeError("spawn placement question records take no arguments");
  }
  return deepFreeze(structuredClone(QUESTION_RECORDS));
}
