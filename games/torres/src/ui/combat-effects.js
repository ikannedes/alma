import {
  ARENA_LENGTH_MILLITILES,
  ARENA_WIDTH_MILLITILES,
} from "../sim/arena-geometry.js";
import {
  combatEffectRootId,
  COMBAT_EFFECT_FEED_MAX_RECORDS,
  validateCombatEffectFeed,
} from "../sim/combat-effect-feed.js";
import {
  isAuthenticGameSession,
  isAuthenticGameSessionProjectionSnapshot,
} from "../sim/game-session.js";
import {
  assertOrdinaryProjectileSplashProfile,
} from "../shared/ordinary-projectile-delivery-authority.js";

// The feed is the bounded event source. The view deliberately keeps its old
// public names so the rest of the browser renderer does not need a second
// presentation protocol, but `events` now contains canonical feed records.
export const COMBAT_EFFECT_EVENT_LIMIT = COMBAT_EFFECT_FEED_MAX_RECORDS;
export const COMBAT_EFFECT_PRIMITIVE_LIMIT = 2_048;
export const COMBAT_EFFECT_VIEW_VERSION = 2;
export const COMBAT_EFFECT_VIEW_MAX_BYTES = 4_000_000;

const VIEWS = new WeakSet();
// Canonical event records are validated and deeply frozen before entering a
// view, so their bytes remain valid for every canonical view that shares them.
const CANONICAL_EVENT_BYTES = new WeakMap();
const PROJECTILE_DIRECTIONS = new Set([
  "pierce", "pellet", "projectile", "return", "tower-to-unit", "travel",
  "unit-to-tower", "unit-to-unit",
]);
const FEED_VERSION = 1;
const SPLASH_BURST_LIFETIME_TICKS = 8;
const UTF8 = new TextEncoder();

const STYLE_TEXT = `.combat-effects{position:absolute;z-index:35;inset:0;overflow:hidden;pointer-events:none}.combat-effects__frame{position:absolute;inset:0}.combat-effect-path{position:absolute;inset:0;width:100%;height:100%;overflow:visible}.combat-effect-path line{stroke:#d9f4d5aa;stroke-width:100;stroke-linecap:round;stroke-dasharray:210 130}.combat-effect-projectile,.combat-effect-impact,.combat-effect-area{position:absolute;left:calc(var(--effect-x-num)*100%/(18000*var(--effect-den)));top:calc(var(--effect-y-num)*100%/(32000*var(--effect-den)));translate:-50% -50%;border-radius:50%}.combat-effect-projectile{width:12px;height:12px;background:#fff0a5;border:2px solid #603d28;box-shadow:0 0 8px #ffcd65}.combat-effect-projectile[data-kind="return"]{border-radius:35% 65%;background:#8ce7dd}.combat-effect-projectile[data-kind="pellet"]{width:7px;height:7px}.combat-effect-impact{width:24px;height:24px;border:4px double #ffe6a0;background:#e8703655}.combat-effect-area{width:calc(var(--effect-radius)*200%/18000);aspect-ratio:1;border:3px solid #f2c66e;background:#d96f3933}.combat-effect-path{display:none}.combat-effect-projectile{width:15px;height:7px;border:1px solid #191D22;border-radius:0;background:#F4EBD6;clip-path:polygon(0 0,70% 18%,100% 50%,70% 82%,0 100%,20% 50%);box-shadow:none}.combat-effect-projectile[data-kind="return"]{background:#DCEDE9;clip-path:polygon(0 0,100% 35%,40% 100%,55% 40%)}.combat-effect-projectile[data-kind="pellet"]{width:8px;height:8px;clip-path:polygon(50% 0,100% 50%,50% 100%,0 50%)}.combat-effect-impact{width:30px;height:30px;border:0;border-radius:0;background:#E9A83A;clip-path:polygon(50% 0,60% 30%,87% 12%,72% 42%,100% 50%,70% 60%,89% 88%,59% 72%,50% 100%,40% 72%,12% 88%,28% 59%,0 50%,29% 40%,13% 12%,41% 28%)}.combat-effect-impact[data-kind="contact"]{width:22px;height:22px;background:#F4EBD6}.combat-effect-area{border:2px solid #E9A83A;background:repeating-conic-gradient(from 0deg,#5B4B8A33 0deg 20deg,transparent 20deg 40deg);box-shadow:inset 0 0 0 5px #191D2233}.combat-effect-area::after{content:"";position:absolute;inset:12%;border:1px dashed #F4EBD6;border-radius:50%}`;

export function getCombatEffectsStyleText() {
  return STYLE_TEXT;
}

function integer(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label} must be a safe integer from ${minimum} through ${maximum}`);
  }
  return value;
}

function plainDataObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be a plain data object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain data object`);
  }
  if (Object.getOwnPropertySymbols(value).length !== 0) {
    throw new TypeError(`${label} must contain only string keys`);
  }
  return value;
}

function exactDataObject(value, keys, label) {
  const object = plainDataObject(value, label);
  const descriptors = Object.getOwnPropertyDescriptors(object);
  const actual = Reflect.ownKeys(descriptors);
  const expected = [...keys].sort();
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

function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new TypeError("combat effect view numbers must be safe integers");
    }
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  throw new TypeError("combat effect view contains unsupported data");
}

function freeze(value, seen = new WeakSet()) {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) freeze(child, seen);
  return Object.freeze(value);
}

function projectionInput(value, suppliedTick) {
  if (suppliedTick !== undefined) {
    return { feed: value, tick: suppliedTick };
  }
  const object = plainDataObject(value, "combat effects projection input");
  const descriptors = Object.getOwnPropertyDescriptors(object);
  const actual = Reflect.ownKeys(descriptors);
  const matches = [
    ["feed", "tick"],
    ["combatEffectFeed", "tick"],
  ].find((keys) => {
    const expected = [...keys].sort();
    const sortedActual = [...actual].sort();
    return sortedActual.length === expected.length &&
      sortedActual.every((key, index) => key === expected[index]);
  });
  if (matches === undefined) {
    throw new TypeError("combat effects projection input has an invalid shape");
  }
  const result = {};
  for (const key of matches) {
    const descriptor = descriptors[key];
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
      throw new TypeError(`${key} must be an enumerable data property`);
    }
    result[key === "combatEffectFeed" ? "feed" : key] = descriptor.value;
  }
  return result;
}

function visualKind(direction) {
  if (!PROJECTILE_DIRECTIONS.has(direction)) {
    throw new TypeError("combat effect feed contains an unsupported projectile direction");
  }
  return direction;
}

function pointInterpolation(from, to, elapsed, duration) {
  if (duration === 0) return to;
  const fromDenominator = BigInt(from.denominator);
  const toDenominator = BigInt(to.denominator);
  const total = BigInt(duration);
  const at = BigInt(elapsed);
  const denominator = fromDenominator * toDenominator * total;
  const remaining = total - at;
  return {
    denominator: denominator.toString(),
    xNumerator: (
      BigInt(from.xNumerator) * toDenominator * remaining +
      BigInt(to.xNumerator) * fromDenominator * at
    ).toString(),
    yNumerator: (
      BigInt(from.yNumerator) * toDenominator * remaining +
      BigInt(to.yNumerator) * fromDenominator * at
    ).toString(),
  };
}

function carrierKey(rootId, segmentId = null) {
  return segmentId === null ? rootId : `${rootId}:segment:${segmentId}`;
}

function carrierEndpoints(root) {
  const payload = root.open.payload;
  if (payload.to !== null) {
    return [{ id: null, to: payload.to }];
  }
  return payload.segments.map(({ id, to }) => ({ id, to }));
}

function terminalTick(root) {
  let terminal = root.open.payload.impactTick;
  if (root.impact !== null && root.impact.tick < terminal) terminal = root.impact.tick;
  if (root.close !== null && root.close.tick < terminal) terminal = root.close.tick;
  return terminal;
}

function activeLeg(root, endpoint, tick) {
  const open = root.open;
  const plannedEnd = terminalTick(root);
  if (tick < open.tick || tick >= plannedEnd) return null;

  let from = open.payload.from;
  let launchTick = open.tick;
  let impactTick = plannedEnd;
  if (open.payload.direction === "return" && root.turn !== null) {
    if (tick >= root.turn.tick) {
      from = root.turn.payload.point;
      endpoint = { id: endpoint.id, to: open.payload.from };
      launchTick = root.turn.tick;
    } else {
      endpoint = { id: endpoint.id, to: open.payload.to };
      impactTick = root.turn.tick;
    }
  }
  if (impactTick <= launchTick || tick >= impactTick) return null;
  return {
    from,
    impactTick,
    key: carrierKey(open.rootId, endpoint.id),
    kind: visualKind(open.payload.direction),
    launchTick,
    sourceSequence: open.payload.sequence,
    to: endpoint.to,
  };
}

function projectilePoint(record, tick) {
  if (tick <= record.launchTick) return record.from;
  if (tick >= record.impactTick) return record.to;
  return pointInterpolation(
    record.from,
    record.to,
    tick - record.launchTick,
    record.impactTick - record.launchTick,
  );
}

function liveHomingProjectilePoints(value) {
  if (value === undefined) return new Map();
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype ||
      value.length > COMBAT_EFFECT_PRIMITIVE_LIMIT) {
    throw new TypeError("live projectile positions must be a bounded plain array");
  }
  const points = new Map();
  for (const [index, raw] of value.entries()) {
    const label = `live projectiles[${index}]`;
    const record = plainDataObject(raw, label);
    if (Object.getOwnPropertySymbols(record).length !== 0) {
      throw new TypeError(`${label} must contain only string keys`);
    }
    const descriptors = Object.getOwnPropertyDescriptors(record);
    const field = (key) => {
      const descriptor = descriptors[key];
      if (descriptor === undefined || !descriptor.enumerable ||
          !Object.hasOwn(descriptor, "value")) {
        throw new TypeError(`${label}.${key} must be an enumerable data property`);
      }
      return descriptor.value;
    };
    const splashDescriptor = descriptors.splashProfile;
    if (splashDescriptor === undefined) continue;
    if (!splashDescriptor.enumerable || !Object.hasOwn(splashDescriptor, "value")) {
      throw new TypeError(`${label}.splashProfile must be an enumerable data property`);
    }
    const splashProfile = splashDescriptor.value;
    if (splashProfile === undefined || splashProfile === null) continue;
    const profile = plainDataObject(splashProfile, `${label}.splashProfile`);
    const profileDescriptors = Object.getOwnPropertyDescriptors(profile);
    const homingDescriptor = profileDescriptors.homing;
    if (homingDescriptor === undefined || !homingDescriptor.enumerable ||
        !Object.hasOwn(homingDescriptor, "value")) {
      throw new TypeError(`${label}.splashProfile.homing must be an enumerable data property`);
    }
    if (homingDescriptor.value !== true) continue;

    const identity = exactDataObject(field("projectileIdentity"), [
      "attackSequence", "direction", "projectileId", "sourceId",
    ], `${label}.projectileIdentity`);
    for (const key of ["attackSequence", "direction", "projectileId", "sourceId"]) {
      if (field(key) !== identity[key]) {
        throw new TypeError(`${label}.${key} diverges from its typed projectile identity`);
      }
    }
    integer(identity.attackSequence, 1, Number.MAX_SAFE_INTEGER,
      `${label}.projectileIdentity.attackSequence`);
    integer(identity.projectileId, 1, Number.MAX_SAFE_INTEGER,
      `${label}.projectileIdentity.projectileId`);
    const rawPoint = exactDataObject(field("position"), ["x", "y"], `${label}.position`);
    const point = {
      denominator: "1",
      xNumerator: String(integer(rawPoint.x, 0, ARENA_WIDTH_MILLITILES, `${label}.position.x`)),
      yNumerator: String(integer(rawPoint.y, 0, ARENA_LENGTH_MILLITILES, `${label}.position.y`)),
    };
    const rootId = combatEffectRootId({
      direction: identity.direction,
      effectId: null,
      projectileId: identity.projectileId,
      sequence: identity.attackSequence,
      sourceId: identity.sourceId,
      type: "projectile",
    });
    if (points.has(rootId)) throw new TypeError(`${label} duplicates a live projectile identity`);
    points.set(rootId, point);
  }
  return points;
}

function projectileIdentityRoot(value, label) {
  const identity = exactDataObject(value, [
    "attackSequence", "direction", "projectileId", "sourceId",
  ], label);
  return combatEffectRootId({
    direction: identity.direction,
    effectId: null,
    projectileId: identity.projectileId,
    sequence: identity.attackSequence,
    sourceId: identity.sourceId,
    type: "projectile",
  });
}

function ordinarySplashAreaRecords(snapshot, sessionOwner, feed, feedRecords, roots, tick) {
  if (snapshot === undefined) return [];
  if (!isAuthenticGameSessionProjectionSnapshot(snapshot) ||
      !isAuthenticGameSession(sessionOwner) ||
      snapshot.combatEffectFeed !== feed || snapshot.state.tick !== tick) {
    throw new TypeError("ordinary splash visuals require the matching authentic session snapshot");
  }

  // The authenticated setup catalog and immutable unit ledger carry the source
  // profile link. The renderer joins those to the primary contact in the closed
  // effect feed; it never reads the session's raw replay dialect.
  const battleSetup = JSON.parse(snapshot.setup.battleSetup);
  const definitions = new Map(battleSetup.roster.map((card) => [card.id, card]));
  const sourceProfiles = new Map();
  for (const unit of snapshot.state.battle.units) {
    const definition = definitions.get(unit.cardId);
    if (definition === undefined) continue;
    const component = definition.entities.find(({ archetypeId }) =>
      archetypeId === unit.archetypeId);
    if (component?.projectileSplashPolicy === undefined) continue;
    const profile = assertOrdinaryProjectileSplashProfile(
      component.projectileSplashPolicy, unit.cardId, unit.archetypeId,
    );
    if (sourceProfiles.has(unit.id)) {
      throw new TypeError("ordinary splash source unit identity is duplicated");
    }
    sourceProfiles.set(unit.id, profile);
  }
  if (sourceProfiles.size === 0) return [];

  const bursts = [];
  const burstRoots = new Set();
  for (const record of feedRecords) {
    if (record.phase !== "contact" || record.payload.status !== "contact" ||
        tick < record.tick || tick - record.tick >= SPLASH_BURST_LIFETIME_TICKS ||
        record.parentId === null) continue;
    const root = roots.get(record.rootId);
    if (root === undefined || root.open.type !== "projectile" ||
        record.parentId !== root.open.eventId) continue;
    const sourceId = root.open.payload.sourceId;
    const profile = sourceProfiles.get(sourceId);
    if (profile === undefined) continue;

    const identity = {
      attackSequence: root.open.payload.sequence,
      direction: root.open.payload.direction,
      projectileId: root.open.payload.projectileId,
      sourceId,
    };
    if (projectileIdentityRoot(identity, "ordinary splash feed root identity") !== record.rootId) {
      throw new TypeError("ordinary splash contact identity diverges from its typed feed root");
    }
    if (burstRoots.has(record.rootId)) {
      throw new TypeError("ordinary splash projectile has more than one primary feed contact");
    }
    burstRoots.add(record.rootId);
    bursts.push({
      key: `${record.rootId}:splash:${record.eventId}`,
      point: record.payload.point,
      radius: profile.radiusMillitiles,
      sourceSequence: identity.attackSequence,
    });
  }
  if (bursts.length > COMBAT_EFFECT_PRIMITIVE_LIMIT) {
    throw new RangeError("ordinary splash burst count exceeds its bound");
  }
  return bursts;
}

function stormkiteChainHopImpactRecords(snapshot, sessionOwner, feed, tick) {
  if (snapshot === undefined) return [];
  if (!isAuthenticGameSessionProjectionSnapshot(snapshot) ||
      !isAuthenticGameSession(sessionOwner) ||
      snapshot.combatEffectFeed !== feed || snapshot.state.tick !== tick) {
    throw new TypeError("Stormkite chain visuals require the matching authentic session snapshot");
  }
  if (tick === 0) return [];

  if (snapshot.setup.projectileRuntimeProfiles === undefined ||
      !snapshot.setup.deck.includes("stormkite")) return [];
  const battle = snapshot.state.battle;
  const stormkiteIds = new Set(battle.units
    .filter((unit) => unit.cardId === "stormkite")
    .map(({ id }) => id));
  if (stormkiteIds.size === 0) return [];

  const ownerPosition = (owner) => {
    const collection = owner?.kind === "crown-tower" ? battle.towers
      : owner?.kind === "unit" ? battle.units
        : owner?.kind === "building" ? battle.structures : null;
    if (collection === null) {
      throw new TypeError("Stormkite chain owner has an unsupported canonical kind");
    }
    const target = collection?.find(({ id }) => id === owner.id);
    if (target?.position === undefined ||
        !Number.isSafeInteger(target.position.x) || !Number.isSafeInteger(target.position.y)) {
      throw new TypeError("Stormkite chain owner has no canonical render position");
    }
    return target.position;
  };
  const impacts = [];
  const committedTick = tick - 1;
  // Session replay is appended in tick order. Walk back only through the most
  // recent committed boundary, then use its host-confirmed chain result.
  for (let index = snapshot.replay.length - 1; index >= 0; index -= 1) {
    const event = snapshot.replay[index];
    if (!Number.isSafeInteger(event.tick) || event.tick < committedTick) break;
    if (event.type !== "chain-hop-settled" || event.tick !== committedTick ||
        (event.status !== "pending" && event.status !== "complete")) continue;
    const identity = event.lineage?.primaryProjectileIdentity;
    if (!stormkiteIds.has(identity?.sourceId) ||
        !Number.isSafeInteger(identity.attackSequence) ||
        !Number.isSafeInteger(event.lineage.hopOrdinal) || event.lineage.hopOrdinal < 1) {
      continue;
    }
    const point = ownerPosition(event.owner);
    if (point === null) continue;
    impacts.push({
      key: `stormkite-chain-hop:${identity.sourceId}:${identity.attackSequence}:` +
        `${event.lineage.hopOrdinal}:${event.tick}`,
      kind: "contact",
      point: {
        denominator: "1",
        xNumerator: String(point.x),
        yNumerator: String(point.y),
      },
      sourceSequence: identity.attackSequence,
    });
    if (impacts.length > COMBAT_EFFECT_PRIMITIVE_LIMIT) {
      throw new RangeError("Stormkite chain contact count exceeds its bound");
    }
  }
  return impacts;
}

function liveHomingLeg(root, endpoint, tick) {
  const open = root.open;
  if (open.type !== "projectile" || open.payload.to === null ||
      open.payload.segments.length !== 0 || open.payload.direction === "return" ||
      tick < open.tick ||
      (root.impact !== null && root.impact.tick <= tick) ||
      (root.close !== null && root.close.tick <= tick)) {
    return null;
  }
  return {
    from: open.payload.from,
    impactTick: Math.max(open.payload.impactTick, tick + 1),
    key: carrierKey(open.rootId, endpoint.id),
    kind: visualKind(open.payload.direction),
    launchTick: open.tick,
    sourceSequence: open.payload.sequence,
    to: endpoint.to,
  };
}

function assertLiveHomingRootsAreActive(roots, livePositions, tick) {
  for (const rootId of livePositions.keys()) {
    const root = roots.get(rootId);
    if (root === undefined || root.open.type !== "projectile" ||
        !carrierEndpoints(root).some((endpoint) => liveHomingLeg(root, endpoint, tick) !== null)) {
      throw new TypeError("live homing projectile has no active full-identity effect root");
    }
  }
}

function impactRecord(root, record, suffix = null) {
  return {
    key: suffix === null ? root.open.rootId : `${root.open.rootId}:${suffix}:${record.eventId}`,
    kind: root.open.type === "contact" ? "contact" : visualKind(root.open.payload.direction),
    point: record.payload.point ?? record.payload.center,
    sourceSequence: root.open.payload.sequence,
  };
}

function areaRecord(root, point, radius) {
  return {
    key: root.open.rootId,
    point,
    radius,
    sourceSequence: root.open.payload.sequence,
  };
}

function validateSerializedTree(value, label, depth = 0, budget = { nodes: 0 }) {
  budget.nodes += 1;
  if (budget.nodes > 100_000 || depth > 24) {
    throw new RangeError(`${label} exceeds its data bound`);
  }
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "string") {
    if (value.length > 16_384) throw new RangeError(`${label} string exceeds its bound`);
    return;
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new TypeError(`${label} numbers must be safe integers`);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > COMBAT_EFFECT_EVENT_LIMIT) {
      throw new RangeError(`${label} exceeds its array bound`);
    }
    for (const [index, child] of value.entries()) {
      validateSerializedTree(child, `${label}[${index}]`, depth + 1, budget);
    }
    return;
  }
  if (typeof value === "object") {
    const keys = Object.keys(value);
    if (keys.length > 128) throw new RangeError(`${label} has too many properties`);
    for (const key of keys) validateSerializedTree(value[key], `${label}.${key}`, depth + 1, budget);
    return;
  }
  throw new TypeError(`${label} contains unsupported data`);
}

function buildView(input, suppliedTick, suppliedLiveProjectiles, sessionSnapshot, sessionOwner) {
  const { feed, tick: rawTick } = projectionInput(input, suppliedTick);
  const tick = integer(rawTick, 0, Number.MAX_SAFE_INTEGER, "combat effects view.tick");
  const livePoints = liveHomingProjectilePoints(suppliedLiveProjectiles);
  // UI-002CP owns the complete feed schema, lifecycle state machine, byte
  // bound, and record normalization. Stormkite's hop contact is joined below
  // only from the matching branded session snapshot's persisted host receipt.
  const normalized = validateCombatEffectFeed(feed);
  const records = normalized.records;
  const roots = new Map();
  const impactVisuals = [];
  const areaVisuals = [];

  for (const record of records) {
    if (record.tick > tick) {
      throw new TypeError("combat effect feed contains a record after the view tick");
    }
    let root = roots.get(record.rootId);
    if (record.parentId === null) {
      root = {
        close: null,
        impact: null,
        open: record,
        turn: null,
      };
      roots.set(record.rootId, root);
    } else if (root === undefined) {
      // This is defensive after the shared validator; keeping the check here
      // makes the projector fail closed if the validator contract changes.
      throw new TypeError("combat effect child names an unknown root");
    }

    if (record.phase === "turn") {
      root.turn = record;
    } else if (record.phase === "impact") {
      root.impact = record;
      if (record.tick === tick && record.type === "area") {
        areaVisuals.push(areaRecord(root, record.payload.center, record.payload.radius));
      } else if (record.tick === tick && record.type === "projectile") {
        impactVisuals.push(impactRecord(root, record));
      }
    } else if (record.phase === "contact") {
      if (root.open.type === "contact" && tick > 0 && record.tick === tick - 1) {
        impactVisuals.push(impactRecord(root, record, "contact"));
      } else if (root.open.type === "projectile" && record.tick === tick) {
        impactVisuals.push(impactRecord(root, record, "contact"));
      }
    } else if (record.phase === "close") {
      root.close = record;
    }
  }

  // An area root is itself a valid open prefix. If its impact child has not
  // arrived yet, show its canonical placement for exactly its opening tick.
  for (const root of roots.values()) {
    if (root.open.type === "area" && root.open.tick === tick &&
        (root.impact === null || root.impact.tick !== tick)) {
      areaVisuals.push(areaRecord(root, root.open.payload.from, root.open.payload.radius));
    }
  }

  areaVisuals.push(...ordinarySplashAreaRecords(
    sessionSnapshot, sessionOwner, feed, records, roots, tick,
  ));
  impactVisuals.push(...stormkiteChainHopImpactRecords(
    sessionSnapshot, sessionOwner, feed, tick,
  ));

  assertLiveHomingRootsAreActive(roots, livePoints, tick);

  const paths = [];
  const projectiles = [];
  for (const root of roots.values()) {
    if (root.open.type !== "projectile") continue;
    for (const endpoint of carrierEndpoints(root)) {
      const livePoint = livePoints.get(root.open.rootId);
      const active = livePoint === undefined
        ? activeLeg(root, endpoint, tick)
        : liveHomingLeg(root, endpoint, tick);
      if (active === null) continue;
      paths.push({
        from: active.from,
        impactTick: active.impactTick,
        key: active.key,
        kind: active.kind,
        launchTick: active.launchTick,
        sourceSequence: active.sourceSequence,
        to: active.to,
      });
      projectiles.push({
        key: active.key,
        kind: active.kind,
        point: livePoint ?? projectilePoint(active, tick),
        sourceSequence: active.sourceSequence,
      });
    }
  }

  if (paths.length + areaVisuals.length + impactVisuals.length > COMBAT_EFFECT_PRIMITIVE_LIMIT) {
    throw new RangeError("combat effect view primitive count exceeds its bound");
  }
  const view = {
    areas: areaVisuals,
    events: records,
    impacts: impactVisuals,
    paths,
    projectiles,
    tick,
    version: COMBAT_EFFECT_VIEW_VERSION,
  };
  freeze(view);
  VIEWS.add(view);
  return view;
}

/**
 * Project a canonical combat-effect feed at a match tick.
 *
 * The preferred form is `(feed, tick)`. The object form
 * `{ feed, tick }` is accepted for callers that pass a named projection
 * input. No legacy `{ events, tick }` input is admitted.
 */
export function createCombatEffectsViewModel(
  feedOrInput, suppliedTick, liveProjectiles, sessionSnapshot, sessionOwner,
) {
  return buildView(feedOrInput, suppliedTick, liveProjectiles, sessionSnapshot, sessionOwner);
}

export function isCanonicalCombatEffectsViewModel(view) {
  return VIEWS.has(view);
}

function canonicalViewJson(view) {
  const entries = Object.keys(view).sort().map((key) => {
    if (key !== "events") {
      return `${JSON.stringify(key)}:${canonicalJson(view[key])}`;
    }
    const records = view.events.map((record) => {
      const cached = CANONICAL_EVENT_BYTES.get(record);
      if (cached !== undefined) return cached;
      const bytes = canonicalJson(record);
      CANONICAL_EVENT_BYTES.set(record, bytes);
      return bytes;
    });
    return `${JSON.stringify(key)}:[${records.join(",")}]`;
  });
  return `{${entries.join(",")}}`;
}

export function serializeCombatEffectsViewModel(view) {
  if (!VIEWS.has(view)) throw new TypeError("combat effects view is not canonical");
  const bytes = canonicalViewJson(view);
  if (UTF8.encode(bytes).byteLength > COMBAT_EFFECT_VIEW_MAX_BYTES) {
    throw new RangeError("combat effects view exceeds its byte bound");
  }
  return bytes;
}

export function restoreCombatEffectsViewModel(
  bytes, liveProjectiles, sessionSnapshot, sessionOwner,
) {
  if (typeof bytes !== "string" || UTF8.encode(bytes).byteLength > COMBAT_EFFECT_VIEW_MAX_BYTES) {
    throw new TypeError("combat effects bytes must be a bounded string");
  }
  let raw;
  try {
    raw = JSON.parse(bytes);
  } catch {
    throw new TypeError("combat effects bytes must be valid JSON");
  }
  validateSerializedTree(raw, "combat effects view");
  const source = exactDataObject(
    raw,
    ["areas", "events", "impacts", "paths", "projectiles", "tick", "version"],
    "combat effects view",
  );
  if (source.version !== COMBAT_EFFECT_VIEW_VERSION || canonicalJson(source) !== bytes) {
    throw new TypeError("combat effects bytes are noncanonical or unsupported");
  }

  // Only the feed records are replayable authority. Rebuilding the complete
  // view from them makes forged geometry, lifecycle records, and identities
  // fail the same causal validation as a live projection.
  let restored;
  try {
    restored = createCombatEffectsViewModel({
      feed: sessionSnapshot?.combatEffectFeed ??
        { records: source.events, version: FEED_VERSION },
      tick: source.tick,
    }, undefined, liveProjectiles, sessionSnapshot, sessionOwner);
  } catch (error) {
    throw new TypeError(`combat effects view is not causally derivable: ${error.message}`);
  }
  if (serializeCombatEffectsViewModel(restored) !== bytes) {
    throw new TypeError("combat effects view is not causally derivable from its feed");
  }
  return restored;
}

function setPoint(node, point) {
  node.style.setProperty("--effect-den", point.denominator);
  node.style.setProperty("--effect-x-num", point.xNumerator);
  const inverted = BigInt(ARENA_LENGTH_MILLITILES) * BigInt(point.denominator) - BigInt(point.yNumerator);
  node.style.setProperty("--effect-y-num", inverted.toString());
}

function checkedLayer(layer) {
  if (!layer || typeof layer !== "object" || typeof layer.replaceChildren !== "function" ||
      typeof layer.ownerDocument?.createElement !== "function") {
    throw new TypeError("combat effects layer must be a DOM element");
  }
  return layer;
}

export function bindCombatEffectsViewModel(layer, view) {
  if (!VIEWS.has(view)) throw new TypeError("combat effects view is not canonical");
  checkedLayer(layer);
  const document = layer.ownerDocument;
  const frame = document.createElement("div");
  frame.className = "combat-effects__frame";
  frame.dataset.tick = String(view.tick);
  const nodes = [];

  for (const record of view.paths) {
    const create = typeof document.createElementNS === "function"
      ? (name) => document.createElementNS("http://www.w3.org/2000/svg", name)
      : (name) => document.createElement(name);
    const svg = create("svg");
    svg.setAttribute("class", "combat-effect-path");
    svg.dataset.effectKey = record.key;
    svg.dataset.kind = record.kind;
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("preserveAspectRatio", "none");
    const common = BigInt(record.from.denominator) * BigInt(record.to.denominator);
    svg.setAttribute("viewBox", `0 0 ${BigInt(ARENA_WIDTH_MILLITILES) * common} ${BigInt(ARENA_LENGTH_MILLITILES) * common}`);
    const line = create("line");
    line.setAttribute("x1", (BigInt(record.from.xNumerator) * BigInt(record.to.denominator)).toString());
    line.setAttribute("y1", ((BigInt(ARENA_LENGTH_MILLITILES) * BigInt(record.from.denominator) - BigInt(record.from.yNumerator)) * BigInt(record.to.denominator)).toString());
    line.setAttribute("x2", (BigInt(record.to.xNumerator) * BigInt(record.from.denominator)).toString());
    line.setAttribute("y2", ((BigInt(ARENA_LENGTH_MILLITILES) * BigInt(record.to.denominator) - BigInt(record.to.yNumerator)) * BigInt(record.from.denominator)).toString());
    svg.appendChild(line);
    nodes.push(svg);
  }
  for (const record of view.areas) {
    const node = document.createElement("span");
    node.className = "combat-effect-area";
    node.dataset.effectKey = record.key;
    node.style.setProperty("--effect-radius", String(record.radius));
    setPoint(node, record.point);
    nodes.push(node);
  }
  for (const record of view.impacts) {
    const node = document.createElement("span");
    node.className = "combat-effect-impact";
    node.dataset.effectKey = record.key;
    node.dataset.kind = record.kind;
    setPoint(node, record.point);
    nodes.push(node);
  }
  for (const record of view.projectiles) {
    const node = document.createElement("span");
    node.className = "combat-effect-projectile";
    node.dataset.effectKey = record.key;
    node.dataset.kind = record.kind;
    setPoint(node, record.point);
    nodes.push(node);
  }

  // Every node is built off-layer. If rendering or the final replacement
  // fails, the caller's live layer remains untouched.
  for (const node of nodes) frame.appendChild(node);
  layer.replaceChildren(frame);
  return view;
}

export function mountCombatEffectsLayer(shell) {
  if (!shell || typeof shell.querySelector !== "function") throw new TypeError("combat effects shell must be a DOM element");
  const combat = shell.querySelector('[data-ui="combat-layer"]');
  if (!combat || typeof combat.appendChild !== "function" || typeof combat.ownerDocument?.createElement !== "function") {
    throw new TypeError("combat effects shell must contain the combat layer");
  }
  const style = combat.ownerDocument.createElement("style");
  style.dataset.ui = "combat-effects-style";
  style.textContent = STYLE_TEXT;
  const layer = combat.ownerDocument.createElement("div");
  layer.className = "combat-effects";
  layer.dataset.ui = "combat-effects";
  layer.setAttribute("aria-live", "off");
  combat.appendChild(style);
  combat.appendChild(layer);
  return layer;
}
