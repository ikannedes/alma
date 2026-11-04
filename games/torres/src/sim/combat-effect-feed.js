/*
 * Closed, source-owned visual transcript for projectile and area effects.
 *
 * This module deliberately keeps the append authority out of the returned
 * feed object. Source runtimes retain that object privately and use the
 * module-owned append helper at their authoritative event boundary. Consumers
 * receive only an immutable snapshot or canonical bytes.
 */

const COMBAT_EFFECT_FEED_VERSION = 1;
const COMBAT_EFFECT_FEED_COMPACT_VERSION = 2;
const COMBAT_EFFECT_FEED_MAX_RECORDS = 16_384;
const COMBAT_EFFECT_FEED_MAX_BYTES = 1_048_576;
const COMBAT_EFFECT_FEED_MAX_DEPTH = 16;
const COMBAT_EFFECT_FEED_MAX_STRING_LENGTH = 256;
// Root IDs carry a bounded, injective encoding of every admitted identity.
// They are intentionally allowed to be longer than ordinary payload text:
// a 256-code-unit identity can need up to four UTF-8 bytes per code unit and
// four base64url characters per three bytes. Keeping this bound explicit makes
// the identity representation finite without falling back to a lossy hash.
const COMBAT_EFFECT_FEED_MAX_ROOT_ID_LENGTH = 8192;
const COMBAT_EFFECT_FEED_MAX_COORDINATE = 65_536;
const COMBAT_EFFECT_FEED_MAX_DENOMINATOR = 1_000_000;
const FEED_SNAPSHOT_PREFIX = "{\"records\":[";
const FEED_SNAPSHOT_SUFFIX = "],\"version\":1}";
const FEED_COMPACT_SNAPSHOT_SUFFIX = "],\"version\":2}";
const UTF8 = new TextEncoder();

const RECORD_KEYS = [
  "eventId", "parentId", "payload", "phase", "rootId", "tick", "type",
];
const SNAPSHOT_KEYS = ["records", "version"];
const PAYLOAD_OPEN_KEYS = [
  "direction", "effectId", "from", "impactTick", "projectileId", "radius",
  "segments", "sequence", "sourceId", "to",
];
const PAYLOAD_DIRECT_CONTACT_OPEN_KEYS = ["point", "sequence", "sourceId", "targetId"];
const PAYLOAD_TURN_KEYS = ["point"];
const PAYLOAD_CONTACT_KEYS = ["point", "status", "subId", "targetId"];
const PAYLOAD_IMPACT_KEYS = ["center", "radius", "targetIds"];
const PAYLOAD_DAMAGE_KEYS = [
  "amount", "currentHealthAfter", "currentHealthBefore", "targetId",
];
const PAYLOAD_DEATH_KEYS = ["targetId"];
const PAYLOAD_CLOSE_KEYS = ["reason"];

const TYPES = new Set(["area", "projectile", "contact"]);
const PROJECTILE_DIRECTIONS = new Set([
  "pierce", "pellet", "projectile", "return", "tower-to-unit", "travel",
  "unit-to-tower", "unit-to-unit",
]);
const PROJECTILE_PHASES = new Set([
  "close", "contact", "damage", "death", "impact", "open", "turn",
]);
const AREA_PHASES = new Set(["close", "damage", "death", "impact", "open"]);
const DIRECT_CONTACT_PHASES = new Set(["close", "contact", "damage", "death", "open"]);
const CONTACT_STATUSES = new Set([
  "contact", "target-dead", "target-missing", "observed",
]);
const CLOSE_REASONS = new Set([
  "complete", "impact-resolved", "launch-cancelled", "source-dead",
  "explicit-cancel", "target-missing", "cancelled",
]);
const ROOT_ID_TOKEN = /^[a-z][A-Za-z0-9.%_~!\-]*(?:\.[A-Za-z0-9.%_~!\-]+){5}$/u;

const FEED_STATES = new WeakMap();
const NORMALIZED_SNAPSHOT_ROOTS = new WeakSet();
const NORMALIZED_SNAPSHOT_WIRE_VERSIONS = new WeakMap();
const COMPACT_TYPES = ["area", "projectile", "contact"];
const COMPACT_PHASES = ["open", "contact", "damage", "death", "impact", "turn", "close"];

function clone(value) {
  return JSON.parse(canonicalJson(value));
}

function freeze(value, seen = new WeakSet()) {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) freeze(child, seen);
  return Object.freeze(value);
}

function exact(value, keys, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be a plain data object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain data object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const actual = Reflect.ownKeys(descriptors);
  const expected = [...keys].sort();
  if (actual.some((key) => typeof key !== "string")) {
    throw new TypeError(`${label} must contain only string keys`);
  }
  const sortedActual = [...actual].sort();
  if (sortedActual.length !== expected.length ||
      sortedActual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${label} has an invalid shape`);
  }
  const result = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
      throw new TypeError(`${label}.${key} must be an enumerable data property`);
    }
    result[key] = descriptor.value;
  }
  return result;
}

function dense(value, maximum, label) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype ||
      value.length > maximum) {
    throw new TypeError(`${label} must be a bounded plain array`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const actual = Reflect.ownKeys(descriptors);
  if (actual.some((key) => key !== "length" &&
      (typeof key !== "string" || !/^(0|[1-9]\d*)$/u.test(key) ||
        Number(key) >= value.length))) {
    throw new TypeError(`${label} must contain only indexed data`);
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[index];
    if (descriptor === undefined || !descriptor.enumerable ||
        !Object.hasOwn(descriptor, "value")) {
      throw new TypeError(`${label}[${index}] must be an enumerable data property`);
    }
  }
  return Array.from({ length: value.length }, (_, index) => descriptors[index].value);
}

function integer(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label} must be a safe integer from ${minimum} through ${maximum}`);
  }
  return value;
}

function boundedText(value, label, maximum = COMBAT_EFFECT_FEED_MAX_STRING_LENGTH) {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum ||
      value.normalize("NFC") !== value || /[\u0000-\u001f\u007f\ud800-\udfff]/u.test(value)) {
    throw new TypeError(`${label} must be bounded normalized text`);
  }
  return value;
}

function decimal(value, label, signed = false) {
  const pattern = signed ? /^(?:0|-?[1-9]\d*)$/u : /^(?:0|[1-9]\d*)$/u;
  if (typeof value !== "string" || value.length > 32 || !pattern.test(value)) {
    throw new TypeError(`${label} must be a canonical decimal string`);
  }
  return BigInt(value);
}

function canonicalPoint(value, label, allowOutside = true) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be a point`);
  }
  const keys = Object.keys(value);
  if (keys.length === 2 && Object.hasOwn(value, "x") && Object.hasOwn(value, "y")) {
    const raw = exact(value, ["x", "y"], label);
    const margin = allowOutside ? COMBAT_EFFECT_FEED_MAX_COORDINATE : 0;
    integer(raw.x, -margin, 18_000 + margin, `${label}.x`);
    integer(raw.y, -margin, 32_000 + margin, `${label}.y`);
    return {
      denominator: "1",
      xNumerator: String(raw.x),
      yNumerator: String(raw.y),
    };
  }
  const raw = exact(value, ["denominator", "xNumerator", "yNumerator"], label);
  const denominator = decimal(raw.denominator, `${label}.denominator`);
  if (denominator < 1n || denominator > BigInt(COMBAT_EFFECT_FEED_MAX_DENOMINATOR)) {
    throw new RangeError(`${label}.denominator is outside the feed bound`);
  }
  const x = decimal(raw.xNumerator, `${label}.xNumerator`, true);
  const y = decimal(raw.yNumerator, `${label}.yNumerator`, true);
  const margin = BigInt(allowOutside ? COMBAT_EFFECT_FEED_MAX_COORDINATE : 0);
  if (x < -margin * denominator || x > (18_000n + margin) * denominator ||
      y < -margin * denominator || y > (32_000n + margin) * denominator) {
    throw new RangeError(`${label} lies outside the feed coordinate bound`);
  }
  return {
    denominator: denominator.toString(),
    xNumerator: x.toString(),
    yNumerator: y.toString(),
  };
}

function checkedIdentity(value, label, nullable = true) {
  if (nullable && value === null) return null;
  if (Number.isSafeInteger(value) && value >= 1) return value;
  if (typeof value === "string" && value.length > 0 && value.length <= 256 &&
      value.normalize("NFC") === value && !/[\u0000-\u001f\u007f\ud800-\udfff]/u.test(value)) return value;
  throw new TypeError(`${label} must be a positive bounded identity`);
}

function identityPart(value) {
  if (value === null) return "none";
  if (typeof value === "number") return String(value);
  // checkedIdentity admits normalized text and rejects lone surrogates, so
  // encodeURIComponent is a total, injective representation here.  Keeping
  // the historical `s` prefix preserves all short root bytes while allowing
  // long identities to remain exact instead of collapsing them through FNV.
  const bytes = UTF8.encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const base64 = btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
  // encodeURIComponent intentionally leaves RFC punctuation such as `.` and
  // `*` untouched. A dot cannot remain inside a component because dots delimit
  // the six root fields; apostrophe/parentheses/asterisk are outside the root
  // token alphabet. Percent-escape all five explicitly so component encoding
  // remains both token-safe and injective across field boundaries.
  const encoded = encodeURIComponent(value)
    .replaceAll(".", "%2E")
    .replaceAll("'", "%27")
    .replaceAll("(", "%28")
    .replaceAll(")", "%29")
    .replaceAll("*", "%2A");
  const uriPart = `s${encoded}`;
  const base64Part = `b${base64}`;
  // Percent encoding is compact for ordinary source IDs but expands every
  // non-ASCII byte to three characters. Choose the shorter of two injective,
  // explicitly tagged encodings so four independently maximal identities
  // still fit the bound on the complete root ID, not merely each component.
  return uriPart.length <= base64Part.length ? uriPart : base64Part;
}

function combatEffectRootId(value) {
  const raw = exact(value, [
    "direction", "effectId", "projectileId", "sequence", "sourceId", "type",
  ], "combat effect root identity");
  const { direction, type } = raw;
  if (!TYPES.has(type)) throw new TypeError("combat effect root type is invalid");
  if ((type === "area" && direction !== "area") ||
      (type === "projectile" && !PROJECTILE_DIRECTIONS.has(direction)) ||
      (type === "contact" && direction !== "contact")) {
    throw new TypeError("combat effect root direction is unsupported");
  }
  boundedText(direction, "combat effect root direction");
  const sourceId = checkedIdentity(raw.sourceId, "combat effect root sourceId");
  const effectId = checkedIdentity(raw.effectId, "combat effect root effectId");
  const projectileId = checkedIdentity(raw.projectileId, "combat effect root projectileId");
  const sequence = checkedIdentity(raw.sequence, "combat effect root sequence");
  if (type === "area" &&
      (sourceId !== null || effectId === null || projectileId !== null || sequence !== null)) {
    throw new TypeError("combat effect area root identity is not canonical");
  }
  if (type === "projectile" && sourceId === null) {
    throw new TypeError("combat effect projectile root identity is not canonical");
  }
  if (type === "contact" &&
      (sourceId === null || effectId === null || projectileId !== null || sequence === null)) {
    throw new TypeError("combat effect direct contact root identity is not canonical");
  }
  return `${type}.${direction}.${identityPart(sourceId)}.${identityPart(effectId)}.${identityPart(projectileId)}.${identityPart(sequence)}`;
}

function rootIdentity(type, payload) {
  if (type === "contact") {
    return combatEffectRootId({
      direction: "contact",
      effectId: payload.targetId,
      projectileId: null,
      sequence: payload.sequence,
      sourceId: payload.sourceId,
      type,
    });
  }
  return combatEffectRootId({
    direction: payload.direction,
    effectId: payload.effectId,
    projectileId: payload.projectileId,
    sequence: payload.sequence,
    sourceId: payload.sourceId,
    type,
  });
}

function checkedSegments(value, label) {
  const segments = dense(value, 64, label).map((entry, index) => {
    const raw = exact(entry, ["id", "to"], `${label}[${index}]`);
    return {
      id: integer(raw.id, 1, Number.MAX_SAFE_INTEGER, `${label}[${index}].id`),
      to: canonicalPoint(raw.to, `${label}[${index}].to`),
    };
  });
  segments.sort((left, right) => left.id - right.id);
  for (let index = 1; index < segments.length; index += 1) {
    if (segments[index - 1].id === segments[index].id) {
      throw new TypeError(`${label} IDs must be unique`);
    }
  }
  return segments;
}

function checkedOpenPayload(value, label, type, tick) {
  if (type === "contact") {
    const raw = exact(value, PAYLOAD_DIRECT_CONTACT_OPEN_KEYS, label);
    boundedText(raw.sequence, `${label}.sequence`);
    const sequence = /^(0|[1-9][0-9]*):(0|[1-9][0-9]*)$/u.exec(raw.sequence);
    if (sequence === null || sequence[1] !== String(tick) ||
        !Number.isSafeInteger(Number(sequence[2])) || String(Number(sequence[2])) !== sequence[2]) {
      throw new TypeError(`${label}.sequence must identify its contact tick and ordinal`);
    }
    return {
      point: canonicalPoint(raw.point, `${label}.point`),
      sequence: raw.sequence,
      sourceId: integer(raw.sourceId, 1, Number.MAX_SAFE_INTEGER, `${label}.sourceId`),
      targetId: integer(raw.targetId, 1, Number.MAX_SAFE_INTEGER, `${label}.targetId`),
    };
  }
  const raw = exact(value, PAYLOAD_OPEN_KEYS, label);
  if (!PROJECTILE_DIRECTIONS.has(raw.direction) &&
      !(type === "area" && raw.direction === "area")) {
    throw new TypeError(`${label}.direction is unsupported`);
  }
  const sourceId = checkedIdentity(raw.sourceId, `${label}.sourceId`);
  const effectId = checkedIdentity(raw.effectId, `${label}.effectId`);
  const projectileId = checkedIdentity(raw.projectileId, `${label}.projectileId`);
  const sequence = checkedIdentity(raw.sequence, `${label}.sequence`);
  integer(raw.impactTick, tick, Number.MAX_SAFE_INTEGER, `${label}.impactTick`);
  integer(raw.radius, 0, COMBAT_EFFECT_FEED_MAX_COORDINATE, `${label}.radius`);
  const from = canonicalPoint(raw.from, `${label}.from`);
  const to = raw.to === null ? null : canonicalPoint(raw.to, `${label}.to`);
  const segments = checkedSegments(raw.segments, `${label}.segments`);
  if (type === "area") {
    if (raw.direction !== "area" || sourceId !== null || effectId === null ||
        projectileId !== null || sequence !== null || to !== null || segments.length !== 0) {
      throw new TypeError(`${label} is not a canonical area root`);
    }
  } else {
    if (sourceId === null || to === null && segments.length === 0 ||
        to !== null && segments.length !== 0) {
      throw new TypeError(`${label} is not a canonical projectile root`);
    }
    if (raw.direction === "area") throw new TypeError(`${label}.direction is invalid`);
  }
  return {
    direction: raw.direction,
    effectId,
    from,
    impactTick: raw.impactTick,
    projectileId,
    radius: raw.radius,
    segments,
    sequence,
    sourceId,
    to,
  };
}

function checkedPayload(value, type, phase, tick, label) {
  if (phase === "open") return checkedOpenPayload(value, label, type, tick);
  if (phase === "turn") {
    return { point: canonicalPoint(exact(value, PAYLOAD_TURN_KEYS, label).point, `${label}.point`) };
  }
  if (phase === "contact") {
    const raw = exact(value, PAYLOAD_CONTACT_KEYS, label);
    if (!CONTACT_STATUSES.has(raw.status)) throw new TypeError(`${label}.status is invalid`);
    const subId = checkedIdentity(raw.subId, `${label}.subId`);
    return {
      point: canonicalPoint(raw.point, `${label}.point`),
      status: raw.status,
      subId,
      targetId: integer(raw.targetId, 1, Number.MAX_SAFE_INTEGER, `${label}.targetId`),
    };
  }
  if (phase === "impact") {
    const raw = exact(value, PAYLOAD_IMPACT_KEYS, label);
    const targetIds = dense(raw.targetIds, COMBAT_EFFECT_FEED_MAX_RECORDS, `${label}.targetIds`)
      .map((targetId, index) => integer(targetId, 1, Number.MAX_SAFE_INTEGER, `${label}.targetIds[${index}]`));
    for (let index = 1; index < targetIds.length; index += 1) {
      if (targetIds[index - 1] >= targetIds[index]) throw new TypeError(`${label}.targetIds must be strictly ascending`);
    }
    return {
      center: canonicalPoint(raw.center, `${label}.center`),
      radius: integer(raw.radius, 0, COMBAT_EFFECT_FEED_MAX_COORDINATE, `${label}.radius`),
      targetIds,
    };
  }
  if (phase === "damage") {
    const raw = exact(value, PAYLOAD_DAMAGE_KEYS, label);
    const amount = integer(raw.amount, 0, Number.MAX_SAFE_INTEGER, label + ".amount");
    const currentHealthAfter = integer(
      raw.currentHealthAfter,
      0,
      Number.MAX_SAFE_INTEGER,
      label + ".currentHealthAfter",
    );
    const currentHealthBefore = integer(
      raw.currentHealthBefore,
      0,
      Number.MAX_SAFE_INTEGER,
      label + ".currentHealthBefore",
    );
    if (currentHealthAfter > currentHealthBefore ||
        currentHealthBefore - currentHealthAfter > amount) {
      throw new TypeError(label + " is not a canonical damage transition");
    }
    return {
      amount,
      currentHealthAfter,
      currentHealthBefore,
      targetId: integer(raw.targetId, 1, Number.MAX_SAFE_INTEGER, `${label}.targetId`),
    };
  }
  if (phase === "death") {
    const raw = exact(value, PAYLOAD_DEATH_KEYS, label);
    return { targetId: integer(raw.targetId, 1, Number.MAX_SAFE_INTEGER, `${label}.targetId`) };
  }
  if (phase === "close") {
    const raw = exact(value, PAYLOAD_CLOSE_KEYS, label);
    boundedText(raw.reason, `${label}.reason`, 64);
    if (!CLOSE_REASONS.has(raw.reason)) throw new TypeError(`${label}.reason is unsupported`);
    return { reason: raw.reason };
  }
  throw new TypeError(`${label}.phase is unsupported`);
}

function checkedRecord(value, label) {
  const raw = exact(value, RECORD_KEYS, label);
  const eventId = integer(raw.eventId, 1, Number.MAX_SAFE_INTEGER, `${label}.eventId`);
  const parentId = raw.parentId === null
    ? null
    : integer(raw.parentId, 1, Number.MAX_SAFE_INTEGER, `${label}.parentId`);
  const rootId = boundedText(raw.rootId, `${label}.rootId`, COMBAT_EFFECT_FEED_MAX_ROOT_ID_LENGTH);
  if (!ROOT_ID_TOKEN.test(rootId)) throw new TypeError(`${label}.rootId is not canonical`);
  const tick = integer(raw.tick, 0, Number.MAX_SAFE_INTEGER, `${label}.tick`);
  if (!TYPES.has(raw.type)) throw new TypeError(`${label}.type is unsupported`);
  const phases = raw.type === "area" ? AREA_PHASES :
    raw.type === "contact" ? DIRECT_CONTACT_PHASES : PROJECTILE_PHASES;
  if (!phases.has(raw.phase)) throw new TypeError(`${label}.phase is unsupported`);
  const payload = checkedPayload(raw.payload, raw.type, raw.phase, tick, `${label}.payload`);
  return { eventId, parentId, payload, phase: raw.phase, rootId, tick, type: raw.type };
}

function appendChecked(state, record) {
  const checked = checkedRecord(record, "combat effect record");
  if (checked.eventId !== state.nextEventId) {
    throw new TypeError("combat effect event IDs must be contiguous and monotonic");
  }
  // Area resolutions are the authoritative global timeline. Projectile
  // sources may interleave roots whose terminal close is emitted after a
  // batch of later impacts, so their causal order is checked per root below.
  if (checked.type === "area" && checked.tick < state.lastAreaTick) {
    throw new TypeError("combat effect event ticks must be monotonic");
  }
  if (state.records.length >= COMBAT_EFFECT_FEED_MAX_RECORDS) {
    throw new RangeError("combat effect feed record bound exceeded");
  }
  const nextRecordBytes = state.recordBytes +
    (state.records.length === 0 ? 0 : 1) +
    UTF8.encode(canonicalJson(checked)).byteLength;
  const nextSnapshotBytes = UTF8.encode(FEED_SNAPSHOT_PREFIX).byteLength +
    nextRecordBytes + UTF8.encode(FEED_SNAPSHOT_SUFFIX).byteLength;
  const compactRecord = compactRecordFor(checked);
  const nextCompactRecordBytes = state.compactRecordBytes +
    (state.records.length === 0 ? 0 : 1) +
    UTF8.encode(canonicalJson(compactRecord)).byteLength;
  const nextCompactSnapshotBytes = UTF8.encode(FEED_SNAPSHOT_PREFIX).byteLength +
    nextCompactRecordBytes + UTF8.encode(FEED_COMPACT_SNAPSHOT_SUFFIX).byteLength;
  let nextWireVersion = state.wireVersion;
  if (nextWireVersion === COMBAT_EFFECT_FEED_VERSION &&
      nextSnapshotBytes > COMBAT_EFFECT_FEED_MAX_BYTES) {
    if (nextCompactSnapshotBytes > COMBAT_EFFECT_FEED_MAX_BYTES) {
      throw new RangeError("combat effect feed exceeds its byte bound");
    }
    nextWireVersion = COMBAT_EFFECT_FEED_COMPACT_VERSION;
  } else if (nextWireVersion === COMBAT_EFFECT_FEED_COMPACT_VERSION &&
      nextCompactSnapshotBytes > COMBAT_EFFECT_FEED_MAX_BYTES) {
    throw new RangeError("combat effect feed exceeds its byte bound");
  }

  const root = state.roots.get(checked.rootId);
  if (checked.parentId === null) {
    if (checked.phase !== "open") throw new TypeError("combat effect roots must open with phase open");
    if (root !== undefined) throw new TypeError("combat effect root is duplicated");
    if (rootIdentity(checked.type, checked.payload) !== checked.rootId) {
      throw new TypeError("combat effect root identity does not match its source identity");
    }
    state.roots.set(checked.rootId, {
      closed: false,
      contactTargets: new Map(),
      damagedTargets: new Set(),
      deathTargets: new Set(),
      impactTargets: new Set(),
      impactSeen: false,
      lastEventId: checked.eventId,
      lastTick: checked.tick,
      phase: "open",
      turnSeen: false,
      type: checked.type,
      payload: checked.payload,
    });
  } else {
    if (root === undefined) throw new TypeError("combat effect child names a missing root");
    if (root.closed) throw new TypeError("combat effect records after close are forbidden");
    if (checked.phase === "open") {
      throw new TypeError("combat effect roots may only open at the root boundary");
    }
    if (checked.tick < root.lastTick) {
      throw new TypeError("combat effect child tick cannot precede its root");
    }
    if (checked.parentId >= checked.eventId) throw new TypeError("combat effect parent must be earlier");
    const parent = state.records[checked.parentId - 1];
    if (parent === undefined || parent.rootId !== checked.rootId) {
      throw new TypeError("combat effect parent must belong to the same root");
    }
    if (checked.parentId !== root.lastEventId) {
      throw new TypeError("combat effect child must extend the active lineage");
    }
    if (checked.type !== root.type) throw new TypeError("combat effect child type diverges from its root");
    const allowedParents = checked.type === "area"
      ? {
        damage: new Set(["damage", "impact"]),
        death: new Set(["damage", "death"]),
        impact: new Set(["open"]),
        close: new Set(["damage", "death", "impact"]),
      }
      : checked.type === "contact" ? {
        contact: new Set(["open"]),
        damage: new Set(["contact"]),
        death: new Set(["damage"]),
        close: new Set(["damage", "death"]),
      } : {
        contact: new Set(["contact", "damage", "death", "impact", "open", "turn"]),
        damage: new Set(["contact", "damage", "impact"]),
        death: new Set(["damage", "death"]),
        impact: new Set(["contact", "open", "turn"]),
        turn: new Set(["contact", "damage", "death", "open"]),
        close: new Set(["contact", "damage", "death", "impact", "open", "turn"]),
      };
    if (!allowedParents[checked.phase]?.has(parent.phase)) {
      throw new TypeError(`combat effect ${checked.phase} has an invalid parent phase or closed lineage (parent ${parent.phase})`);
    }
    if (checked.phase === "turn" &&
        !new Set(["return", "travel"]).has(root.payload.direction)) {
      throw new TypeError("combat effect turn is unsupported for this source direction");
    }
    if (checked.phase === "damage") {
      const targetId = checked.payload.targetId;
      if (checked.type === "contact" && targetId !== root.payload.targetId) {
        throw new TypeError("combat effect direct contact damage target diverges from its root");
      }
      if (root.deathTargets.has(targetId)) {
        throw new TypeError("combat effect damage follows target death");
      }
      if (!root.damagedTargets.has(targetId) &&
          !root.contactTargets.has(targetId) && !root.impactTargets.has(targetId)) {
        throw new TypeError("combat effect damage target has no causal contact or impact");
      }
      if (root.contactTargets.get(targetId) === "target-dead" ||
          root.contactTargets.get(targetId) === "target-missing") {
        throw new TypeError("combat effect damage target was not contactable");
      }
      root.damagedTargets.add(targetId);
    } else if (checked.phase === "death") {
      if (checked.type === "contact" && checked.payload.targetId !== root.payload.targetId) {
        throw new TypeError("combat effect direct contact death target diverges from its root");
      }
      if (!root.damagedTargets.has(checked.payload.targetId)) {
        throw new TypeError("combat effect death target has no causal damage");
      }
      if (root.deathTargets.has(checked.payload.targetId)) {
        throw new TypeError("combat effect death target is duplicated");
      }
      root.deathTargets.add(checked.payload.targetId);
    } else if (checked.phase === "contact") {
      if (checked.type === "contact" &&
          (root.contactTargets.size !== 0 || checked.payload.targetId !== root.payload.targetId ||
           checked.payload.status !== "contact" ||
           canonicalJson(checked.payload.point) !== canonicalJson(root.payload.point))) {
        throw new TypeError("combat effect direct contact child diverges from its root");
      }
      const previousStatus = root.contactTargets.get(checked.payload.targetId);
      if (previousStatus !== undefined &&
          previousStatus !== "contact" &&
          previousStatus !== "observed") {
        throw new TypeError("combat effect contact follows an uncontactable target");
      }
      root.contactTargets.set(checked.payload.targetId, checked.payload.status);
    } else if (checked.phase === "impact") {
      if (root.impactSeen) throw new TypeError("combat effect impact is duplicated");
      root.impactSeen = true;
      for (const targetId of checked.payload.targetIds) root.impactTargets.add(targetId);
    } else if (checked.phase === "turn") {
      if (root.turnSeen) throw new TypeError("combat effect turn is duplicated");
      if (root.impactSeen) throw new TypeError("combat effect turn follows terminal impact");
      root.turnSeen = true;
    }
    if (checked.phase === "close") {
      if (checked.type === "area" && !root.impactSeen) {
        throw new TypeError("combat effect area close requires a preceding impact");
      }
      if (checked.type === "contact" && !root.damagedTargets.has(root.payload.targetId)) {
        throw new TypeError("combat effect direct contact close requires a preceding damage");
      }
      if (checked.type === "projectile" &&
          !root.contactTargets.size && !root.impactSeen && !root.turnSeen) {
        const cancellation = new Set([
          "cancelled", "explicit-cancel", "launch-cancelled", "source-dead",
          "target-missing",
        ]);
        if (root.phase !== "open" || !cancellation.has(checked.payload.reason)) {
          throw new TypeError("combat effect projectile close requires a preceding contact, impact, turn, or authentic cancellation");
        }
      }
      root.closed = true;
    }
    root.phase = checked.phase;
    root.lastEventId = checked.eventId;
    root.lastTick = checked.tick;
  }
  state.records.push(freeze(checked));
  state.recordBytes = nextRecordBytes;
  state.compactRecordBytes = nextCompactRecordBytes;
  state.wireVersion = nextWireVersion;
  state.nextEventId += 1;
  if (checked.type === "area") state.lastAreaTick = checked.tick;
  return checked;
}

function emptyState(wireVersion = COMBAT_EFFECT_FEED_VERSION) {
  return {
    compactRecordBytes: 0,
    lastAreaTick: -1,
    nextEventId: 1,
    recordBytes: 0,
    records: [],
    roots: new Map(),
    wireVersion,
  };
}

function snapshotState(value, wireVersion = COMBAT_EFFECT_FEED_VERSION) {
  const snapshot = exact(value, SNAPSHOT_KEYS, "combat effect feed snapshot");
  if (snapshot.version !== COMBAT_EFFECT_FEED_VERSION) {
    throw new TypeError("combat effect feed version is unsupported");
  }
  const records = dense(snapshot.records, COMBAT_EFFECT_FEED_MAX_RECORDS, "combat effect feed records");
  const state = emptyState(wireVersion);
  for (let index = 0; index < records.length; index += 1) {
    const checked = checkedRecord(records[index], `combat effect feed records[${index}]`);
    appendChecked(state, checked);
  }
  return state;
}

// Compact v2 is a wire projection only. Roots encode [tick, typeCode, payload];
// children encode [parentId, tick, phaseCode, payload]. Array position supplies
// the contiguous event ID, root payloads supply their injective root ID, and
// children inherit type and root identity from their authenticated parent.
function compactRecordFor(record) {
  if (record.parentId === null) {
    return [record.tick, COMPACT_TYPES.indexOf(record.type), record.payload];
  }
  return [record.parentId, record.tick, COMPACT_PHASES.indexOf(record.phase), record.payload];
}

function snapshotStateFromCompact(value) {
  const snapshot = exact(value, SNAPSHOT_KEYS, "compact combat effect feed snapshot");
  if (snapshot.version !== COMBAT_EFFECT_FEED_COMPACT_VERSION) {
    throw new TypeError("compact combat effect feed version is unsupported");
  }
  const rows = dense(snapshot.records, COMBAT_EFFECT_FEED_MAX_RECORDS,
    "compact combat effect feed records");
  const state = emptyState(COMBAT_EFFECT_FEED_COMPACT_VERSION);
  for (let index = 0; index < rows.length; index += 1) {
    const row = dense(rows[index], 4, `compact combat effect feed records[${index}]`);
    const eventId = index + 1;
    let record;
    if (row.length === 3) {
      const [tick, typeCode, payload] = row;
      if (!Number.isSafeInteger(typeCode) || typeCode < 0 || typeCode >= COMPACT_TYPES.length) {
        throw new TypeError(`compact combat effect feed records[${index}] type code is invalid`);
      }
      const type = COMPACT_TYPES[typeCode];
      record = {
        eventId,
        parentId: null,
        payload,
        phase: "open",
        rootId: rootIdentity(type, payload),
        tick,
        type,
      };
    } else if (row.length === 4) {
      const [parentId, tick, phaseCode, payload] = row;
      if (!Number.isSafeInteger(parentId) || parentId < 1 || parentId >= eventId) {
        throw new TypeError(`compact combat effect feed records[${index}] parent ID is invalid`);
      }
      if (!Number.isSafeInteger(phaseCode) || phaseCode < 0 || phaseCode >= COMPACT_PHASES.length) {
        throw new TypeError(`compact combat effect feed records[${index}] phase code is invalid`);
      }
      const parent = state.records[parentId - 1];
      if (parent === undefined) {
        throw new TypeError(`compact combat effect feed records[${index}] parent is missing`);
      }
      record = {
        eventId,
        parentId,
        payload,
        phase: COMPACT_PHASES[phaseCode],
        rootId: parent.rootId,
        tick,
        type: parent.type,
      };
    } else {
      throw new TypeError(`compact combat effect feed records[${index}] has an invalid row shape`);
    }
    appendChecked(state, record);
  }
  return state;
}

function snapshotFromState(state) {
  // Normalized records are frozen at admission, so snapshots can share them
  // safely while retaining an independent array for future appends.
  const snapshot = Object.freeze({
    version: COMBAT_EFFECT_FEED_VERSION,
    records: Object.freeze([...state.records]),
  });
  NORMALIZED_SNAPSHOT_ROOTS.add(snapshot);
  NORMALIZED_SNAPSHOT_WIRE_VERSIONS.set(snapshot, state.wireVersion);
  return snapshot;
}

function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new TypeError("combat effect feed numbers must be safe integers");
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  throw new TypeError("combat effect feed contains unsupported data");
}

function apiForState(state) {
  const api = Object.create(null);
  Object.defineProperties(api, {
    bytes: { enumerable: false, get: () => serializeState(state) },
    fork: { enumerable: false, value: () => apiForState(forkState(state)) },
    records: { enumerable: false, get: () => snapshotFromState(state).records },
    serialize: { enumerable: false, value: () => serializeState(state) },
    snapshot: { enumerable: false, value: () => snapshotFromState(state) },
    version: { enumerable: false, get: () => COMBAT_EFFECT_FEED_VERSION },
  });
  Object.freeze(api);
  FEED_STATES.set(api, state);
  return api;
}

function forkState(state) {
  // This is only reachable through an authenticated feed API. Its records and
  // normalized payloads are module-owned and never exposed by reference, so a
  // structural copy avoids revalidating the complete transcript on every
  // transactional source fork while preserving independent append state.
  return {
    compactRecordBytes: state.compactRecordBytes,
    lastAreaTick: state.lastAreaTick,
    nextEventId: state.nextEventId,
    recordBytes: state.recordBytes,
    records: [...state.records],
    roots: new Map([...state.roots].map(([rootId, root]) => [rootId, {
      ...root,
      contactTargets: new Map(root.contactTargets),
      damagedTargets: new Set(root.damagedTargets),
      deathTargets: new Set(root.deathTargets),
      impactTargets: new Set(root.impactTargets),
    }])),
    wireVersion: state.wireVersion,
  };
}

function serializeState(state) {
  const serialized = state.wireVersion === COMBAT_EFFECT_FEED_VERSION
    ? canonicalJson(snapshotFromState(state))
    : canonicalJson({
      records: state.records.map(compactRecordFor),
      version: COMBAT_EFFECT_FEED_COMPACT_VERSION,
    });
  if (new TextEncoder().encode(serialized).byteLength > COMBAT_EFFECT_FEED_MAX_BYTES) {
    throw new RangeError("combat effect feed exceeds its byte bound");
  }
  return serialized;
}

function createCombatEffectFeed() {
  return apiForState(emptyState());
}

function appendCombatEffectEvent(feed, value) {
  const state = FEED_STATES.get(feed);
  if (state === undefined) throw new TypeError("combat effect feed authority is invalid");
  const raw = exact(value, ["parentId", "payload", "phase", "rootId", "tick", "type"],
    "combat effect append");
  const root = state.roots.get(raw.rootId);
  // The original pierce and pellet adapters have a valid no-contact terminal
  // path: a launched carrier reaches its endpoint and closes without a target
  // contact. Materialize that terminal observation at the protocol boundary
  // so the public transcript still has an explicit impact predecessor while
  // the private primitive remains untouched.
  if (raw.phase === "close" && raw.type === "projectile" &&
      raw.parentId !== null && root !== undefined && !root.closed &&
      root.phase === "open" && raw.parentId === root.lastEventId &&
      raw.payload !== null && typeof raw.payload === "object" &&
      !Array.isArray(raw.payload) && raw.payload.reason === "complete" &&
      (root.payload.direction === "pierce" || root.payload.direction === "pellet")) {
    const center = root.payload.to ?? root.payload.segments.at(-1)?.to;
    if (center === undefined || center === null) {
      throw new TypeError("combat effect no-contact close has no terminal point");
    }
    const impact = {
      eventId: state.nextEventId,
      parentId: raw.parentId,
      payload: {
        center,
        radius: root.payload.radius,
        targetIds: [],
      },
      phase: "impact",
      rootId: raw.rootId,
      tick: raw.tick,
      type: raw.type,
    };
    const close = {
      eventId: state.nextEventId + 1,
      parentId: impact.eventId,
      payload: raw.payload,
      phase: raw.phase,
      rootId: raw.rootId,
      tick: raw.tick,
      type: raw.type,
    };
    // Validate both records on a detached state before adopting either one;
    // this keeps the synthetic terminal pair atomic at the feed boundary.
    const preview = forkState(state);
    appendChecked(preview, impact);
    appendChecked(preview, close);
    appendChecked(state, impact);
    const checkedClose = appendChecked(state, close);
    return freeze(clone(checkedClose));
  }
  const candidate = { eventId: state.nextEventId, ...raw };
  const checked = appendChecked(state, candidate);
  return freeze(clone(checked));
}

function appendCombatEffectRoot(feed, value) {
  const directContact = value !== null && typeof value === "object" &&
    Object.getOwnPropertyDescriptor(value, "type")?.value === "contact";
  const raw = exact(value, directContact ? [
    "point", "sequence", "sourceId", "targetId", "tick", "type",
  ] : [
    "direction", "effectId", "from", "impactTick", "projectileId", "radius",
    "segments", "sequence", "sourceId", "to", "tick", "type",
  ], "combat effect root");
  const type = raw.type;
  const payload = type === "contact" ? {
    point: raw.point,
    sequence: raw.sequence,
    sourceId: raw.sourceId,
    targetId: raw.targetId,
  } : {
    direction: raw.direction,
    effectId: raw.effectId,
    from: raw.from,
    impactTick: raw.impactTick,
    projectileId: raw.projectileId,
    radius: raw.radius,
    segments: raw.segments,
    sequence: raw.sequence,
    sourceId: raw.sourceId,
    to: raw.to,
  };
  const checkedPayload = checkedOpenPayload(
    payload,
    "combat effect root.payload",
    type,
    raw.tick,
  );
  return appendCombatEffectEvent(feed, {
    parentId: null,
    payload: checkedPayload,
    phase: "open",
    rootId: rootIdentity(type, checkedPayload),
    tick: raw.tick,
    type,
  });
}

function appendCombatEffectChild(feed, root, phase, payload, tick, type = "projectile") {
  const child = appendCombatEffectEvent(feed, {
    parentId: root.lastEventId,
    payload,
    phase,
    rootId: root.rootId,
    tick,
    type,
  });
  root.lastEventId = child.eventId;
  return child;
}

function appendCombatEffectProjectileRoot(feed, projectile, from, to, tick, impactTick, radius = 0) {
  const identity = projectile.projectileIdentity;
  const root = appendCombatEffectRoot(feed, {
    direction: identity.direction,
    effectId: null,
    from,
    impactTick,
    projectileId: identity.projectileId,
    radius,
    segments: [],
    sequence: identity.attackSequence,
    sourceId: identity.sourceId,
    tick,
    to,
    type: "projectile",
  });
  return { lastEventId: root.eventId, rootId: root.rootId };
}

function appendCombatEffectDirectContact(feed, value) {
  const state = FEED_STATES.get(feed);
  if (state === undefined) throw new TypeError("combat effect feed authority is invalid");
  const raw = exact(value, [
    "amount", "currentHealthAfter", "currentHealthBefore", "death", "ordinal", "point",
    "sourceId", "targetId", "tick",
  ], "combat effect direct contact");
  const tick = integer(raw.tick, 0, Number.MAX_SAFE_INTEGER, "direct contact.tick");
  const ordinal = integer(raw.ordinal, 0, Number.MAX_SAFE_INTEGER, "direct contact.ordinal");
  if (typeof raw.death !== "boolean") throw new TypeError("direct contact.death must be boolean");
  const point = canonicalPoint(raw.point, "direct contact.point");
  const sourceId = integer(raw.sourceId, 1, Number.MAX_SAFE_INTEGER, "direct contact.sourceId");
  const targetId = integer(raw.targetId, 1, Number.MAX_SAFE_INTEGER, "direct contact.targetId");
  const amount = integer(raw.amount, 0, Number.MAX_SAFE_INTEGER, "direct contact.amount");
  const currentHealthBefore = integer(
    raw.currentHealthBefore, 0, Number.MAX_SAFE_INTEGER, "direct contact.currentHealthBefore",
  );
  const currentHealthAfter = integer(
    raw.currentHealthAfter, 0, Number.MAX_SAFE_INTEGER, "direct contact.currentHealthAfter",
  );
  if (currentHealthAfter > currentHealthBefore ||
      currentHealthBefore - currentHealthAfter > amount ||
      raw.death && (currentHealthBefore === 0 || currentHealthAfter !== 0)) {
    throw new TypeError("direct contact is not a canonical damage transition");
  }
  const preview = forkState(state);
  const previewFeed = apiForState(preview);
  const rootRecord = appendCombatEffectRoot(previewFeed, {
    point,
    sequence: `${tick}:${ordinal}`,
    sourceId,
    targetId,
    tick,
    type: "contact",
  });
  const root = { lastEventId: rootRecord.eventId, rootId: rootRecord.rootId };
  appendCombatEffectChild(previewFeed, root, "contact",
    { point, status: "contact", subId: null, targetId }, tick, "contact");
  appendCombatEffectChild(previewFeed, root, "damage",
    { amount, currentHealthAfter, currentHealthBefore, targetId }, tick, "contact");
  if (raw.death) appendCombatEffectChild(previewFeed, root, "death", { targetId }, tick, "contact");
  appendCombatEffectChild(previewFeed, root, "close", { reason: "complete" }, tick, "contact");
  const staged = FEED_STATES.get(previewFeed);
  if (staged === undefined) throw new TypeError("combat effect preview authority is invalid");
  Object.assign(state, staged);
  return Object.freeze(state.records.slice(-(raw.death ? 5 : 4)));
}

function appendCombatEffectStructureContacts(feed, value) {
  const state = FEED_STATES.get(feed);
  if (state === undefined) throw new TypeError("combat effect feed authority is invalid");
  const raw = exact(value, [
    "acceptedHits", "events", "hits", "knownStructures", "tick", "units",
  ], "direct structure contacts");
  const tick = integer(raw.tick, 0, Number.MAX_SAFE_INTEGER, "direct structure contacts.tick");
  const contacts = raw.events.filter((event) => event.tick === tick &&
    event.type === "external-unit-contact");
  const damages = raw.events.filter((event) => event.tick === tick && event.type === "damage");
  const usedContacts = new Set();
  const usedDamages = new Set();
  const usedAcceptedHits = new Set();
  const resolved = [];
  for (const [ordinal, hit] of raw.hits.entries()) {
    if (hit.targetKind !== "unit") continue;
    const sourceId = `building:${hit.sourceId}`;
    const source = raw.knownStructures.find(({ id }) => id === hit.sourceId);
    if (source === undefined || source.structureId !== sourceId ||
        source.kind !== "structure" || source.layer !== "ground") {
      throw new TypeError("direct structure contact source is not admitted");
    }
    const contactIndex = contacts.findIndex((event, index) => !usedContacts.has(index) &&
      event.contactTick === tick && event.damage === hit.amount && event.delivery === "melee" &&
      event.sourceId === sourceId && event.targetUnitId === hit.targetId);
    if (contactIndex === -1) {
      const missed = raw.events.some((event) => event.tick === tick &&
        event.type === "building-contact-missed" && event.amount === hit.amount &&
        event.origin === hit.origin && event.sourceId === hit.sourceId &&
        event.targetId === hit.targetId && event.targetKind === "unit");
      if (missed) continue;
      throw new TypeError("direct structure contact has no resolved contact event");
    }
    const acceptedIndex = raw.acceptedHits.findIndex((entry, index) =>
      !usedAcceptedHits.has(index) && entry.damage === hit.amount &&
      entry.delivery === "melee" && entry.sourceId === sourceId &&
      entry.targetUnitId === hit.targetId);
    if (acceptedIndex === -1) {
      throw new TypeError("direct structure contact source is not admitted");
    }
    const damageIndex = damages.findIndex((event, index) => !usedDamages.has(index) &&
      event.externalSourceId === sourceId && event.amount === hit.amount &&
      event.targetId === hit.targetId);
    const target = raw.units.find(({ id }) => id === hit.targetId);
    if (damageIndex === -1 || target === undefined) {
      throw new TypeError("direct structure contact has no resolved damage event");
    }
    usedContacts.add(contactIndex);
    usedDamages.add(damageIndex);
    usedAcceptedHits.add(acceptedIndex);
    const damage = damages[damageIndex];
    const death = damage.currentHealthBefore > 0 && damage.currentHealthAfter === 0;
    if (death && !raw.events.some((event) => event.tick === tick &&
        event.type === "death" && event.targetId === hit.targetId)) {
      throw new TypeError("lethal structure contact has no resolved death event");
    }
    resolved.push({
      amount: damage.amount,
      currentHealthAfter: damage.currentHealthAfter,
      currentHealthBefore: damage.currentHealthBefore,
      death,
      ordinal,
      point: target.position,
      sourceId: hit.sourceId,
      targetId: hit.targetId,
      tick,
    });
  }
  const preview = apiForState(forkState(state));
  for (const contact of resolved) appendCombatEffectDirectContact(preview, contact);
  Object.assign(state, FEED_STATES.get(preview));
}

function validateCombatEffectFeed(value) {
  if (NORMALIZED_SNAPSHOT_ROOTS.has(value)) return value;
  const trusted = FEED_STATES.get(value);
  if (trusted !== undefined) {
    return snapshotFromState(snapshotState(snapshotFromState(trusted), trusted.wireVersion));
  }
  return snapshotFromState(snapshotState(value));
}

function serializeCombatEffectFeed(value) {
  const state = FEED_STATES.get(value);
  if (state !== undefined) return serializeState(state);
  const wireVersion = NORMALIZED_SNAPSHOT_WIRE_VERSIONS.get(value) ?? COMBAT_EFFECT_FEED_VERSION;
  return serializeState(snapshotState(value, wireVersion));
}

function restoreCombatEffectFeed(serialized) {
  const state = parseSerializedFeed(serialized);
  return snapshotFromState(state);
}

function parseSerializedFeed(serialized) {
  if (typeof serialized !== "string") throw new TypeError("combat effect feed bytes must be a string");
  if (new TextEncoder().encode(serialized).byteLength > COMBAT_EFFECT_FEED_MAX_BYTES) {
    throw new RangeError("combat effect feed bytes exceed their bound");
  }
  let raw;
  try { raw = JSON.parse(serialized); }
  catch { throw new TypeError("combat effect feed bytes must be valid JSON"); }
  const envelope = exact(raw, SNAPSHOT_KEYS, "combat effect feed snapshot");
  const state = envelope.version === COMBAT_EFFECT_FEED_VERSION
    ? snapshotState(raw)
    : envelope.version === COMBAT_EFFECT_FEED_COMPACT_VERSION
      ? snapshotStateFromCompact(raw)
      : (() => { throw new TypeError("combat effect feed version is unsupported"); })();
  if (serializeState(state) !== serialized) throw new TypeError("combat effect feed bytes must be canonical JSON");
  return state;
}

function combatEffectFeedSnapshot(value) {
  const state = FEED_STATES.get(value);
  if (state !== undefined) return snapshotFromState(state);
  return validateCombatEffectFeed(value);
}

export {
  COMBAT_EFFECT_FEED_VERSION,
  COMBAT_EFFECT_FEED_MAX_RECORDS,
  COMBAT_EFFECT_FEED_MAX_BYTES,
  COMBAT_EFFECT_FEED_MAX_DEPTH,
  COMBAT_EFFECT_FEED_MAX_STRING_LENGTH,
  COMBAT_EFFECT_FEED_MAX_COORDINATE,
  COMBAT_EFFECT_FEED_MAX_DENOMINATOR,
  COMBAT_EFFECT_FEED_MAX_ROOT_ID_LENGTH,
  appendCombatEffectChild,
  appendCombatEffectEvent,
  appendCombatEffectStructureContacts,
  appendCombatEffectProjectileRoot,
  appendCombatEffectRoot,
  combatEffectFeedSnapshot,
  combatEffectRootId,
  createCombatEffectFeed,
  restoreCombatEffectFeed,
  serializeCombatEffectFeed,
  validateCombatEffectFeed,
};
