const hasOwn = (value, key) =>
  Object.prototype.hasOwnProperty.call(value, key);

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

function assertId(id, label = "entity id") {
  if (!Number.isSafeInteger(id) || id < 1) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
}

function assertHealth(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
}

function assertDamage(value, label = "damage") {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
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

/**
 * Deterministic, armor-free health and damage storage.
 *
 * Sequential hits resolve immediately. A simultaneous batch first validates
 * every command, then determines eligibility from the pre-batch alive state.
 * Its damage events retain input order; deaths follow them in ascending entity
 * ID order. Thus mutual lethal hits always trade, regardless of input order.
 */
export class DamageSystem {
  #combatants = [];

  get size() {
    return this.#combatants.length;
  }

  add(id, maxHealth, currentHealth = maxHealth) {
    assertId(id);
    assertHealth(maxHealth, "maxHealth");
    assertHealth(currentHealth, "currentHealth");
    if (currentHealth > maxHealth) {
      throw new RangeError("currentHealth must not exceed maxHealth");
    }
    if (this.#findIndex(id) !== -1) {
      throw new RangeError(`entity ${id} already has health`);
    }

    const combatant = {
      currentHealth,
      dead: false,
      id,
      maxHealth,
    };
    const insertion = this.#combatants.findIndex((entry) => entry.id > id);
    if (insertion === -1) {
      this.#combatants.push(combatant);
    } else {
      this.#combatants.splice(insertion, 0, combatant);
    }
    return clone(combatant);
  }

  get(id) {
    assertId(id);
    const index = this.#findIndex(id);
    return index === -1 ? null : clone(this.#combatants[index]);
  }

  list() {
    return clone(this.#combatants);
  }

  /**
   * Resolves one hit immediately.
   *
   * Missing and dead targets are valid no-op results. A lethal hit emits its
   * one death event here; all later hits return "dead" without another event.
   */
  damage(targetId, amount) {
    const batch = this.damageSimultaneously([{ amount, targetId }]);
    return {
      events: batch.events,
      ...batch.results[0],
    };
  }

  /**
   * Resolves one health restoration without ever reviving a dead combatant.
   * Missing and dead targets are valid no-op results, matching damage's
   * deterministic admission behavior.
   */
  heal(targetId, amount) {
    assertId(targetId, "heal targetId");
    assertDamage(amount, "heal amount");
    const index = this.#findIndex(targetId);
    if (index === -1) {
      return {
        amount,
        currentHealth: null,
        events: [],
        status: "missing",
        targetId,
      };
    }
    const combatant = this.#combatants[index];
    if (combatant.dead) {
      return {
        amount,
        currentHealth: 0,
        events: [],
        status: "dead",
        targetId,
      };
    }
    const before = combatant.currentHealth;
    const room = combatant.maxHealth - before;
    const applied = Math.min(room, amount);
    combatant.currentHealth += applied;
    const event = {
      amount: applied,
      currentHealthAfter: combatant.currentHealth,
      currentHealthBefore: before,
      requestedAmount: amount,
      targetId,
      type: "heal",
    };
    return {
      amount,
      appliedAmount: applied,
      currentHealth: combatant.currentHealth,
      events: [event],
      status: "applied",
      targetId,
    };
  }

  /**
   * Resolves hits from one simultaneous timing window.
   *
   * All input is validated before mutation. Every target that was alive before
   * the batch accepts every hit aimed at it, even if an earlier input is
   * lethal. Multiple hits are accumulated per ID with safe-integer arithmetic.
   */
  damageSimultaneously(hits) {
    if (!Array.isArray(hits)) {
      throw new TypeError("simultaneous hits must be an array");
    }

    const checked = hits.map((hit, index) => {
      assertExactKeys(hit, ["amount", "targetId"], `hit ${index}`);
      assertId(hit.targetId, `hit ${index} targetId`);
      assertDamage(hit.amount, `hit ${index} amount`);
      return { amount: hit.amount, targetId: hit.targetId };
    });

    const totals = new Map();
    const preBatch = new Map(
      this.#combatants.map((combatant) => [combatant.id, { ...combatant }]),
    );
    for (const hit of checked) {
      const target = preBatch.get(hit.targetId);
      if (target !== undefined && !target.dead) {
        const total = totals.get(hit.targetId) ?? 0;
        if (hit.amount > Number.MAX_SAFE_INTEGER - total) {
          throw new RangeError(
            `total damage for entity ${hit.targetId} exceeds safe integer range`,
          );
        }
        totals.set(hit.targetId, total + hit.amount);
      }
    }

    const cumulative = new Map();
    const damageEvents = [];
    const results = checked.map((hit) => {
      const target = preBatch.get(hit.targetId);
      if (target === undefined) {
        return {
          amount: hit.amount,
          currentHealth: null,
          status: "missing",
          targetId: hit.targetId,
        };
      }
      if (target.dead) {
        return {
          amount: hit.amount,
          currentHealth: 0,
          status: "dead",
          targetId: hit.targetId,
        };
      }

      const priorDamage = cumulative.get(hit.targetId) ?? 0;
      const before = Math.max(0, target.currentHealth - priorDamage);
      const nextDamage = priorDamage + hit.amount;
      cumulative.set(hit.targetId, nextDamage);
      const after = Math.max(0, target.currentHealth - nextDamage);
      damageEvents.push({
        amount: hit.amount,
        currentHealthAfter: after,
        currentHealthBefore: before,
        targetId: hit.targetId,
        type: "damage",
      });
      return {
        amount: hit.amount,
        currentHealth: after,
        status: "applied",
        targetId: hit.targetId,
      };
    });

    const deaths = [];
    for (const [id, total] of [...totals].sort(
      ([left], [right]) => left - right,
    )) {
      const index = this.#findIndex(id);
      const combatant = this.#combatants[index];
      combatant.currentHealth = Math.max(0, combatant.currentHealth - total);
      if (combatant.currentHealth === 0) {
        combatant.dead = true;
        deaths.push({ targetId: id, type: "death" });
      }
    }

    return clone({
      events: [...damageEvents, ...deaths],
      results,
    });
  }

  serialize() {
    return canonicalJson({
      combatants: this.#combatants,
      version: 1,
    });
  }

  static restore(serialized) {
    if (typeof serialized !== "string") {
      throw new TypeError("serialized damage snapshot must be a string");
    }
    let snapshot;
    try {
      snapshot = JSON.parse(serialized);
    } catch {
      throw new TypeError("serialized damage snapshot must be valid JSON");
    }
    assertExactKeys(snapshot, ["combatants", "version"], "damage snapshot");
    if (snapshot.version !== 1 || !Array.isArray(snapshot.combatants)) {
      throw new TypeError("damage snapshot has an invalid shape");
    }

    const system = new DamageSystem();
    let previousId = 0;
    for (let index = 0; index < snapshot.combatants.length; index += 1) {
      const combatant = snapshot.combatants[index];
      assertExactKeys(
        combatant,
        ["currentHealth", "dead", "id", "maxHealth"],
        `snapshot combatant ${index}`,
      );
      assertId(combatant.id, `snapshot combatant ${index} id`);
      assertHealth(combatant.maxHealth, `snapshot combatant ${index} maxHealth`);
      if (combatant.id <= previousId) {
        throw new TypeError("snapshot combatants must have unique ascending IDs");
      }
      if (typeof combatant.dead !== "boolean") {
        throw new TypeError(`snapshot combatant ${index} dead must be boolean`);
      }
      if (combatant.dead) {
        if (combatant.currentHealth !== 0) {
          throw new TypeError("dead snapshot combatants must have zero health");
        }
      } else {
        assertHealth(
          combatant.currentHealth,
          `snapshot combatant ${index} currentHealth`,
        );
      }
      if (combatant.currentHealth > combatant.maxHealth) {
        throw new TypeError(
          "snapshot currentHealth must not exceed maxHealth",
        );
      }
      system.#combatants.push({ ...combatant });
      previousId = combatant.id;
    }
    return system;
  }

  #findIndex(id) {
    let low = 0;
    let high = this.#combatants.length - 1;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const candidate = this.#combatants[middle].id;
      if (candidate === id) return middle;
      if (candidate < id) low = middle + 1;
      else high = middle - 1;
    }
    return -1;
  }
}

export const HealthStore = DamageSystem;
