const UINT32_RANGE = 0x1_0000_0000;
const UINT64_MASK = 0xffff_ffff_ffff_ffffn;
const PCG_MULTIPLIER = 6_364_136_223_846_793_005n;
const FNV_OFFSET = 14_695_981_039_346_656_037n;
const FNV_PRIME = 1_099_511_628_211n;

export const RNG_ALGORITHM = "pcg32-xsh-rr-v1";

function assertSeed(seed) {
  if (typeof seed === "string") {
    return `string:${seed.length}:${seed}`;
  }
  if (Number.isSafeInteger(seed)) {
    return `integer:${seed}`;
  }
  throw new TypeError("seed must be a string or safe integer");
}

function assertForkName(name) {
  if (typeof name !== "string" || name.length === 0) {
    throw new TypeError("fork name must be a non-empty string");
  }
  return name;
}

function hash64(text) {
  let hash = FNV_OFFSET;
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= BigInt(byte);
    hash = (hash * FNV_PRIME) & UINT64_MASK;
  }

  // FNV provides stable byte ingestion; this fixed avalanche makes nearby
  // human-readable seeds less correlated before they initialize PCG.
  hash ^= hash >> 30n;
  hash = (hash * 13_785_878_976_378_269_325n) & UINT64_MASK;
  hash ^= hash >> 27n;
  hash = (hash * 10_766_465_646_473_572_057n) & UINT64_MASK;
  hash ^= hash >> 31n;
  return hash & UINT64_MASK;
}

function toHex64(value) {
  return value.toString(16).padStart(16, "0");
}

function parseHex64(value, label) {
  if (typeof value !== "string" || !/^[0-9a-f]{16}$/.test(value)) {
    throw new TypeError(`${label} must be a 16-character lowercase hex string`);
  }
  return BigInt(`0x${value}`);
}

function deriveKey(material) {
  return toHex64(hash64(`key\0${material}`));
}

function initializeState(key) {
  const initialState = hash64(`state\0${key}`);
  const increment = ((hash64(`stream\0${key}`) << 1n) | 1n) & UINT64_MASK;
  let state = 0n;

  state = (state * PCG_MULTIPLIER + increment) & UINT64_MASK;
  state = (state + initialState) & UINT64_MASK;
  state = (state * PCG_MULTIPLIER + increment) & UINT64_MASK;
  return { increment, state };
}

/**
 * Stable deterministic PCG32 (XSH-RR) stream for simulation.
 *
 * The algorithm identifier and pinned test vectors are part of the replay
 * format. Changing its seed encoding, hashing, transition, or output function
 * requires a new algorithm version rather than silently changing this class.
 */
export class SeededRandom {
  #forkKey;
  #increment;
  #state;

  constructor(seed) {
    this.#forkKey = deriveKey(assertSeed(seed));
    const initialized = initializeState(this.#forkKey);
    this.#increment = initialized.increment;
    this.#state = initialized.state;
  }

  /**
   * Returns an unsigned 32-bit integer and advances the stream once.
   */
  nextUint32() {
    const oldState = this.#state;
    this.#state =
      (oldState * PCG_MULTIPLIER + this.#increment) & UINT64_MASK;

    const shifted = Number(
      (((oldState >> 18n) ^ oldState) >> 27n) & 0xffff_ffffn,
    );
    const rotation = Number(oldState >> 59n);
    return (
      (shifted >>> rotation) |
      (shifted << ((-rotation) & 31))
    ) >>> 0;
  }

  /**
   * Returns an integer in [0, maxExclusive). Rejection sampling avoids the
   * modulo bias that would otherwise occur when the bound does not divide 2^32.
   */
  int(maxExclusive) {
    if (
      !Number.isSafeInteger(maxExclusive) ||
      maxExclusive < 1 ||
      maxExclusive > UINT32_RANGE
    ) {
      throw new RangeError(
        "maxExclusive must be an integer from 1 through 4294967296",
      );
    }

    const rejectionLimit =
      UINT32_RANGE - (UINT32_RANGE % maxExclusive);
    let value;
    do {
      value = this.nextUint32();
    } while (value >= rejectionLimit);
    return value % maxExclusive;
  }

  /**
   * Creates a named child stream. Derivation uses only the parent's immutable
   * fork key and the exact name, so parent draws and sibling fork call order
   * cannot affect the child sequence.
   */
  fork(name) {
    const checkedName = assertForkName(name);
    return SeededRandom.#fromKey(
      deriveKey(`fork\0${this.#forkKey}\0${checkedName.length}:${checkedName}`),
    );
  }

  /**
   * Returns a plain JSON-safe snapshot containing every replay-relevant field.
   */
  serialize() {
    return {
      algorithm: RNG_ALGORITHM,
      forkKey: this.#forkKey,
      increment: toHex64(this.#increment),
      state: toHex64(this.#state),
      version: 1,
    };
  }

  static restore(serialized) {
    let snapshot = serialized;
    if (typeof serialized === "string") {
      try {
        snapshot = JSON.parse(serialized);
      } catch {
        throw new TypeError("serialized RNG snapshot must be valid JSON");
      }
    }

    if (
      snapshot === null ||
      typeof snapshot !== "object" ||
      Array.isArray(snapshot) ||
      snapshot.algorithm !== RNG_ALGORITHM ||
      snapshot.version !== 1
    ) {
      throw new TypeError("serialized RNG snapshot has an invalid shape");
    }

    const keys = Object.keys(snapshot).sort();
    if (
      keys.join(",") !==
      "algorithm,forkKey,increment,state,version"
    ) {
      throw new TypeError("serialized RNG snapshot has an invalid shape");
    }

    const rng = SeededRandom.#fromKey(snapshot.forkKey);
    rng.#state = parseHex64(snapshot.state, "snapshot state");
    const increment = parseHex64(
      snapshot.increment,
      "snapshot increment",
    );
    if ((increment & 1n) !== 1n) {
      throw new TypeError("snapshot increment must be odd");
    }
    rng.#increment = increment;
    return rng;
  }

  static #fromKey(forkKey) {
    parseHex64(forkKey, "fork key");
    const rng = new SeededRandom(0);
    rng.#forkKey = forkKey;
    const initialized = initializeState(forkKey);
    rng.#increment = initialized.increment;
    rng.#state = initialized.state;
    return rng;
  }
}
