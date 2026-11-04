const hasOwn = (value, key) =>
  Object.prototype.hasOwnProperty.call(value, key);

function assertEntityId(id, label = "entity id") {
  if (!Number.isSafeInteger(id) || id < 1) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
}

function cloneJson(value, path = "$", ancestors = new Set()) {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(`${path} must contain only finite numbers`);
    }
    return Object.is(value, -0) ? 0 : value;
  }

  if (typeof value !== "object") {
    throw new TypeError(`${path} must be plain JSON data`);
  }
  if (ancestors.has(value)) {
    throw new TypeError(`${path} must not contain cycles`);
  }

  const prototype = Object.getPrototypeOf(value);
  if (
    !Array.isArray(value) &&
    prototype !== Object.prototype &&
    prototype !== null
  ) {
    throw new TypeError(`${path} must contain only plain objects`);
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new TypeError(`${path} must not contain symbol properties`);
  }

  ancestors.add(value);
  let result;
  if (Array.isArray(value)) {
    result = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!hasOwn(value, index)) {
        throw new TypeError(`${path} must not contain sparse arrays`);
      }
      result.push(cloneJson(value[index], `${path}[${index}]`, ancestors));
    }
    const extraKeys = Object.keys(value).filter(
      (key) => !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length,
    );
    if (extraKeys.length > 0) {
      throw new TypeError(`${path} must not contain non-index properties`);
    }
  } else {
    result = {};
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of Object.keys(descriptors).sort()) {
      const descriptor = descriptors[key];
      if (!descriptor.enumerable || !hasOwn(descriptor, "value")) {
        throw new TypeError(`${path}.${key} must be an enumerable data property`);
      }
      Object.defineProperty(result, key, {
        configurable: true,
        enumerable: true,
        value: cloneJson(descriptor.value, `${path}.${key}`, ancestors),
        writable: true,
      });
    }
  }
  ancestors.delete(value);
  return result;
}

function canonicalJson(value) {
  return JSON.stringify(cloneJson(value));
}

function assertExactKeys(value, expected, label) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    throw new TypeError(`${label} has an invalid shape`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    throw new TypeError(`${label} has an invalid shape`);
  }
}

/**
 * Deterministic entity lifecycle storage.
 *
 * Operations are synchronous. A batch is resolved strictly from index 0 upward,
 * and every observable entity list is in ascending ID (spawn) order. Therefore
 * same-tick callers should pass one ordered operation array to apply(); ordering
 * never depends on object, Map, Set, or hash iteration.
 */
export class EntityStore {
  #entities;
  #nextId;

  constructor() {
    this.#entities = [];
    this.#nextId = 1;
  }

  get size() {
    return this.#entities.length;
  }

  get nextId() {
    return this.#nextId;
  }

  spawn(data) {
    if (this.#nextId >= Number.MAX_SAFE_INTEGER) {
      throw new RangeError("entity id space is exhausted");
    }
    const entity = {
      data: cloneJson(data, "spawn data"),
      id: this.#nextId,
    };
    this.#nextId += 1;
    this.#entities.push(entity);
    return cloneJson(entity);
  }

  /**
   * Returns true exactly once for a live ID. Missing and already-despawned IDs
   * return false and do not otherwise mutate the store.
   */
  despawn(id) {
    assertEntityId(id);
    const index = this.#findIndex(id);
    if (index === -1) {
      return false;
    }
    this.#entities.splice(index, 1);
    return true;
  }

  has(id) {
    assertEntityId(id);
    return this.#findIndex(id) !== -1;
  }

  get(id) {
    assertEntityId(id);
    const index = this.#findIndex(id);
    return index === -1 ? null : cloneJson(this.#entities[index]);
  }

  list() {
    return cloneJson(this.#entities);
  }

  /**
   * Applies a same-tick lifecycle batch in array order.
   *
   * Each result is an isolated spawned entity or the boolean result of despawn.
   * A malformed operation aborts before that operation, while prior operations
   * remain applied; callers that need validation without mutation can validate
   * their command schema before handing the batch to the lifecycle layer.
   */
  apply(operations) {
    if (!Array.isArray(operations)) {
      throw new TypeError("lifecycle operations must be an array");
    }

    const results = [];
    for (let index = 0; index < operations.length; index += 1) {
      const operation = operations[index];
      if (
        operation === null ||
        typeof operation !== "object" ||
        Array.isArray(operation)
      ) {
        throw new TypeError(`lifecycle operation ${index} has an invalid shape`);
      }
      if (operation.type === "spawn") {
        assertExactKeys(
          operation,
          ["data", "type"],
          `lifecycle operation ${index}`,
        );
        results.push(this.spawn(operation.data));
      } else if (operation.type === "despawn") {
        assertExactKeys(
          operation,
          ["id", "type"],
          `lifecycle operation ${index}`,
        );
        results.push(this.despawn(operation.id));
      } else {
        throw new TypeError(`lifecycle operation ${index} has an unknown type`);
      }
    }
    return cloneJson(results);
  }

  serialize() {
    return canonicalJson({
      entities: this.#entities,
      nextId: this.#nextId,
      version: 1,
    });
  }

  static restore(serialized) {
    if (typeof serialized !== "string") {
      throw new TypeError("serialized entity snapshot must be a string");
    }

    let raw;
    try {
      raw = JSON.parse(serialized);
    } catch {
      throw new TypeError("serialized entity snapshot must be valid JSON");
    }

    const snapshot = cloneJson(raw, "entity snapshot");
    assertExactKeys(
      snapshot,
      ["entities", "nextId", "version"],
      "entity snapshot",
    );
    if (snapshot.version !== 1 || !Array.isArray(snapshot.entities)) {
      throw new TypeError("entity snapshot has an invalid shape");
    }
    assertEntityId(snapshot.nextId, "snapshot nextId");
    if (snapshot.nextId >= Number.MAX_SAFE_INTEGER) {
      throw new TypeError("snapshot nextId is outside the supported ID space");
    }

    let previousId = 0;
    for (let index = 0; index < snapshot.entities.length; index += 1) {
      const entity = snapshot.entities[index];
      assertExactKeys(entity, ["data", "id"], `snapshot entity ${index}`);
      assertEntityId(entity.id, `snapshot entity ${index} id`);
      if (entity.id <= previousId || entity.id >= snapshot.nextId) {
        throw new TypeError(
          "snapshot entities must have unique ascending issued IDs",
        );
      }
      previousId = entity.id;
    }

    const store = new EntityStore();
    store.#entities = cloneJson(snapshot.entities);
    store.#nextId = snapshot.nextId;
    return store;
  }

  #findIndex(id) {
    let low = 0;
    let high = this.#entities.length - 1;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const candidate = this.#entities[middle].id;
      if (candidate === id) {
        return middle;
      }
      if (candidate < id) {
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    return -1;
  }
}
