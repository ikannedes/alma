export const ATTACK_CYCLE_TICKS_PER_SECOND = 60;

const CONFIG_KEYS = ["deployTicks", "firstHitTicks", "hitSpeedTicks"];
const INPUT_KEYS = ["targetEligible", "targetId"];
const STATE_KEYS = [
  "attackSequence",
  "config",
  "nextAttackTick",
  "nextTick",
  "phase",
  "targetId",
];
const PAUSED_STATE_KEYS = [...STATE_KEYS, "statusWork"];
const PHASES = new Set(["deploying", "idle", "winding", "cycling"]);

function assertExactDataObject(value, expectedKeys, label) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    throw new TypeError(`${label} must be a plain object`);
  }

  const descriptors = Object.getOwnPropertyDescriptors(value);
  const actualKeys = Reflect.ownKeys(descriptors);
  if (actualKeys.some((key) => typeof key !== "string")) {
    throw new TypeError(`${label} must contain only string-keyed data`);
  }
  const actual = actualKeys.sort();
  const expected = [...expectedKeys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new TypeError(`${label} has an invalid shape`);
  }
  const checked = {};
  for (const key of expectedKeys) {
    const descriptor = descriptors[key];
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
      throw new TypeError(`${label}.${key} must be an enumerable data property`);
    }
    checked[key] = descriptor.value;
  }
  return checked;
}

function assertSafeTick(value, label, { positive = false } = {}) {
  if (
    !Number.isSafeInteger(value) ||
    value < (positive ? 1 : 0)
  ) {
    throw new TypeError(
      `${label} must be a ${positive ? "positive" : "non-negative"} safe integer`,
    );
  }
}

function assertTargetId(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
}

function checkedConfig(value, label = "attack-cycle config") {
  const config = assertExactDataObject(value, CONFIG_KEYS, label);
  assertSafeTick(config.deployTicks, `${label}.deployTicks`);
  assertSafeTick(config.firstHitTicks, `${label}.firstHitTicks`);
  assertSafeTick(config.hitSpeedTicks, `${label}.hitSpeedTicks`, {
    positive: true,
  });
  return {
    deployTicks: config.deployTicks,
    firstHitTicks: config.firstHitTicks,
    hitSpeedTicks: config.hitSpeedTicks,
  };
}

function checkedInput(value, label = "attack-cycle input") {
  const input = assertExactDataObject(value, INPUT_KEYS, label);
  if (typeof input.targetEligible !== "boolean") {
    throw new TypeError(`${label}.targetEligible must be a boolean`);
  }
  if (input.targetId !== null) {
    assertTargetId(input.targetId, `${label}.targetId`);
  }
  if (input.targetEligible && input.targetId === null) {
    throw new TypeError(
      `${label}.targetId must identify a target when targetEligible is true`,
    );
  }
  return {
    targetEligible: input.targetEligible,
    targetId: input.targetId,
  };
}

function checkedState(value, label = "attack-cycle state") {
  const descriptors = value === null || typeof value !== "object" || Array.isArray(value)
    ? null
    : Object.getOwnPropertyDescriptors(value);
  const actual = descriptors === null ? [] : Reflect.ownKeys(descriptors).sort();
  const base = [...STATE_KEYS].sort();
  const extended = [...PAUSED_STATE_KEYS].sort();
  const expected = actual.length === extended.length &&
    actual.every((key, index) => key === extended[index]) ? PAUSED_STATE_KEYS : STATE_KEYS;
  const state = assertExactDataObject(value, expected, label);
  let statusWork = null;
  if (expected === PAUSED_STATE_KEYS) {
    statusWork = assertExactDataObject(state.statusWork, ["mode"], `${label}.statusWork`);
    if (statusWork.mode !== "paused") {
      throw new TypeError(`${label}.statusWork.mode is invalid`);
    }
  }
  const config = checkedConfig(state.config, `${label}.config`);
  assertSafeTick(state.nextTick, `${label}.nextTick`);
  assertSafeTick(state.attackSequence, `${label}.attackSequence`);
  if (!PHASES.has(state.phase)) {
    throw new TypeError(`${label}.phase is invalid`);
  }
  if (state.targetId !== null) {
    assertTargetId(state.targetId, `${label}.targetId`);
  }
  if (state.nextAttackTick !== null) {
    assertSafeTick(state.nextAttackTick, `${label}.nextAttackTick`);
  }

  if (state.phase === "deploying") {
    if (
      state.nextTick > config.deployTicks ||
      state.attackSequence !== 0 ||
      state.targetId !== null ||
      state.nextAttackTick !== null
    ) {
      throw new TypeError(`${label} has an inconsistent deploying phase`);
    }
  } else if (state.phase === "idle") {
    if (state.targetId !== null || state.nextAttackTick !== null) {
      throw new TypeError(`${label} has an inconsistent idle phase`);
    }
  } else if (
    state.targetId === null ||
    state.nextAttackTick === null ||
    state.nextAttackTick < state.nextTick
  ) {
    throw new TypeError(`${label} has an inconsistent attack phase`);
  }
  if (
    state.phase === "winding" &&
    (config.firstHitTicks === 0 ||
      (statusWork === null && state.nextAttackTick - state.nextTick >= config.firstHitTicks))
  ) {
    throw new TypeError(`${label} has an inconsistent winding deadline`);
  }
  if (
    state.phase === "cycling" &&
    (state.attackSequence === 0 ||
      (statusWork === null && state.nextAttackTick - state.nextTick >= config.hitSpeedTicks))
  ) {
    throw new TypeError(`${label} has an inconsistent cadence deadline`);
  }

  if (
    state.nextTick < config.deployTicks &&
    state.phase !== "deploying"
  ) {
    throw new TypeError(`${label} leaves deployment before its deadline`);
  }

  const checked = {
    attackSequence: state.attackSequence,
    config,
    nextAttackTick: state.nextAttackTick,
    nextTick: state.nextTick,
    phase: state.phase,
    targetId: state.targetId,
  };
  if (statusWork !== null) checked.statusWork = { mode: statusWork.mode };
  return checked;
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

function parseDecimalSeconds(seconds) {
  if (typeof seconds !== "string" && typeof seconds !== "number") {
    throw new TypeError("seconds must be a non-negative decimal string or number");
  }
  const text = typeof seconds === "number" ? String(seconds) : seconds;
  if (
    (typeof seconds === "number" && (!Number.isFinite(seconds) || seconds < 0)) ||
    !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(text)
  ) {
    throw new TypeError("seconds must be a non-negative plain decimal");
  }
  const [wholeText, fractionText = ""] = text.split(".");
  const denominator = 10n ** BigInt(fractionText.length);
  const numerator =
    BigInt(wholeText) * denominator +
    BigInt(fractionText === "" ? "0" : fractionText);
  return { denominator, numerator };
}

/**
 * Converts a plain reference decimal to an exact 60 Hz tick duration.
 *
 * Strings avoid any dependence on binary floating-point representation.
 * Durations that do not land on a simulation boundary are rejected rather
 * than rounded. For example, "0.8" is 48 ticks and "0.9" is 54 ticks.
 */
export function attackSecondsToTicks(seconds) {
  const { denominator, numerator } = parseDecimalSeconds(seconds);
  const tickNumerator = numerator * BigInt(ATTACK_CYCLE_TICKS_PER_SECOND);
  if (tickNumerator % denominator !== 0n) {
    throw new RangeError("seconds must resolve to an exact 60 Hz tick duration");
  }
  const ticks = tickNumerator / denominator;
  if (ticks > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError("seconds resolve beyond the safe tick range");
  }
  return Number(ticks);
}

function advanceChecked(state, input) {
  const tick = state.nextTick;
  const events = [];

  if (state.phase === "deploying" && tick >= state.config.deployTicks) {
    state.phase = "idle";
  }

  if (state.phase !== "deploying") {
    const eligibleId = input.targetEligible ? input.targetId : null;
    if (state.targetId !== eligibleId) {
      state.targetId = eligibleId;
      if (eligibleId === null) {
        state.phase = "idle";
        state.nextAttackTick = null;
      } else {
        state.phase = "winding";
        state.nextAttackTick = tick + state.config.firstHitTicks;
        if (!Number.isSafeInteger(state.nextAttackTick)) {
          throw new RangeError("next attack tick exceeds the safe integer range");
        }
      }
    }

    if (
      state.targetId !== null &&
      state.nextAttackTick === tick
    ) {
      if (state.attackSequence === Number.MAX_SAFE_INTEGER) {
        throw new RangeError("attack sequence exceeds the safe integer range");
      }
      state.attackSequence += 1;
      events.push({
        sequence: state.attackSequence,
        targetId: state.targetId,
        tick,
        type: "attack-ready",
      });
      state.phase = "cycling";
      state.nextAttackTick = tick + state.config.hitSpeedTicks;
      if (!Number.isSafeInteger(state.nextAttackTick)) {
        throw new RangeError("next attack tick exceeds the safe integer range");
      }
    }
  }

  if (tick === Number.MAX_SAFE_INTEGER) {
    throw new RangeError("attack-cycle tick exceeds the safe integer range");
  }
  state.nextTick += 1;
  return events;
}

function pauseChecked(state, input) {
  const tick = state.nextTick;
  if (state.phase === "deploying" && tick >= state.config.deployTicks) {
    state.phase = "idle";
  }

  const eligibleId = input.targetEligible ? input.targetId : null;
  if (state.targetId !== eligibleId) {
    state.targetId = eligibleId;
    if (eligibleId === null) {
      state.phase = "idle";
      state.nextAttackTick = null;
    } else {
      state.phase = "winding";
      state.nextAttackTick = tick + state.config.firstHitTicks;
      if (!Number.isSafeInteger(state.nextAttackTick)) {
        throw new RangeError("next attack tick exceeds the safe integer range");
      }
    }
  } else if (state.targetId !== null && state.nextAttackTick !== null) {
    if (state.nextAttackTick === Number.MAX_SAFE_INTEGER) {
      throw new RangeError("next attack tick exceeds the safe integer range");
    }
    state.nextAttackTick += 1;
  }

  if (tick === Number.MAX_SAFE_INTEGER) {
    throw new RangeError("attack-cycle tick exceeds the safe integer range");
  }
  state.nextTick += 1;
  state.statusWork = { mode: "paused" };
  return [];
}

/**
 * Deterministic target-to-attack timing at 60 boundaries per second.
 *
 * `step(input)` processes boundary `nextTick`, then advances it by one. A unit
 * remains locked out through boundaries below `deployTicks`. Acquisition at
 * boundary T schedules its first attack-ready event at T + firstHitTicks;
 * later events occur exactly hitSpeedTicks apart. Losing eligibility, even for
 * one boundary, cancels the cycle. A different target (or a reacquired target)
 * starts a fresh first-hit windup. Retaining the same eligible ID preserves the
 * current deadline.
 *
 * This module does not find targets or apply attacks. Callers explicitly supply
 * the target observation for every processed boundary and consume JSON events.
 */
export class AttackCycle {
  #state;

  constructor(config) {
    const checked = checkedConfig(config);
    this.#state = {
      attackSequence: 0,
      config: checked,
      nextAttackTick: null,
      nextTick: 0,
      phase: checked.deployTicks === 0 ? "idle" : "deploying",
      targetId: null,
    };
  }

  get state() {
    return JSON.parse(JSON.stringify(this.#state));
  }

  /**
   * Returns an independent continuation of this already-authentic cycle.
   *
   * This is intentionally an ordinary AttackCycle instance, not a compact
   * capability or a restore shortcut: construction and serialized restore
   * retain their full hostile-input validation paths. The private state is
   * known-valid because it can only originate in this constructor, stepMany,
   * or restore; copying it avoids a serialize/parse/validate round trip for
   * internal transactional runtime clones.
   */
  fork() {
    const copy = new AttackCycle(this.#state.config);
    copy.#state = {
      attackSequence: this.#state.attackSequence,
      config: { ...this.#state.config },
      nextAttackTick: this.#state.nextAttackTick,
      nextTick: this.#state.nextTick,
      phase: this.#state.phase,
      targetId: this.#state.targetId,
    };
    if (this.#state.statusWork !== undefined) {
      copy.#state.statusWork = { ...this.#state.statusWork };
    }
    return copy;
  }

  step(input) {
    return this.stepMany([input]);
  }

  /**
   * Advances one boundary while preserving the current target and exact
   * remaining attack deadline. LiveBattle uses this for a host-owned disable
   * or rational progress slice; ordinary attack-cycle callers retain the
   * original six-field state and byte format until this method is used.
   */
  stepPaused(input) {
    const checked = checkedInput(input);
    const candidate = checkedState(this.#state);
    const events = pauseChecked(candidate, checked);
    this.#state = candidate;
    return events;
  }

  /**
   * Processes a chunk of per-boundary observations atomically.
   *
   * All inputs are validated before the live state changes. The result is the
   * ordered flat event stream, making chunked and one-step execution identical.
   */
  stepMany(inputs) {
    if (!Array.isArray(inputs)) {
      throw new TypeError("attack-cycle inputs must be an array");
    }
    const descriptors = Object.getOwnPropertyDescriptors(inputs);
    for (const key of Reflect.ownKeys(descriptors)) {
      if (key === "length") continue;
      if (
        typeof key !== "string" ||
        !/^(0|[1-9]\d*)$/.test(key) ||
        Number(key) >= inputs.length
      ) {
        throw new TypeError("attack-cycle inputs must contain only indexed data");
      }
    }
    const checked = [];
    for (let index = 0; index < inputs.length; index += 1) {
      const descriptor = descriptors[index];
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        !Object.hasOwn(descriptor, "value")
      ) {
        throw new TypeError(
          `attack-cycle input ${index} must be an enumerable data property`,
        );
      }
      checked.push(
        checkedInput(descriptor.value, `attack-cycle input ${index}`),
      );
    }
    const candidate = checkedState(this.#state);
    const events = [];
    for (const input of checked) {
      events.push(...advanceChecked(candidate, input));
    }
    this.#state = candidate;
    return events;
  }

  serialize() {
    return canonicalJson({
      state: checkedState(this.#state),
      version: 1,
    });
  }

  static restore(serialized) {
    if (typeof serialized !== "string") {
      throw new TypeError("serialized attack-cycle state must be a string");
    }
    let snapshot;
    try {
      snapshot = JSON.parse(serialized);
    } catch {
      throw new TypeError("serialized attack-cycle state must be valid JSON");
    }
    const checked = assertExactDataObject(
      snapshot,
      ["state", "version"],
      "attack-cycle snapshot",
    );
    if (checked.version !== 1) {
      throw new TypeError("attack-cycle snapshot has an unsupported version");
    }
    const restored = checkedState(
      checked.state,
      "attack-cycle snapshot.state",
    );
    const cycle = new AttackCycle(restored.config);
    cycle.#state = restored;
    return cycle;
  }
}
