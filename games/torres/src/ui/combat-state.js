import { COMBAT_MOTION_STYLE, COMBAT_DEATH_STYLE } from "./combat-motion.js";
import {
  createBriarRunnerPaintedArt,
  createCopperskiffBattleArt,
  createCombatArt,
  COMBAT_ART_STYLE,
  COMBAT_STRUCTURE_ART_IDS,
} from "./combat-art.js";
import { createBrackenwheelScaleArt } from "./brackenwheel-art.js";
import { createAetherWellBattleArt } from "./aether-well-art.js";
import { createSkymaulBattleArt } from "./skymaul-battle-sprite.js";
import { createStormkiteBattleArt } from "./stormkite-battle-sprite.js";
import {
  ARENA_LENGTH_MILLITILES,
  ARENA_WIDTH_MILLITILES,
} from "../sim/arena-geometry.js";

export const COMBAT_ENTITY_LIMIT = 512;
export const COMBAT_EVENT_LIMIT = 2_048;
export const COMBAT_TOWER_LIMIT = 16;
export const COMBAT_TARGET_LINK_LIMIT = COMBAT_ENTITY_LIMIT + COMBAT_TOWER_LIMIT;
export const COMBAT_VIEW_VERSION = 2;

const CANONICAL_VIEWS = new WeakSet();
const SIDES = new Set(["north", "south"]);
const LAYERS = new Set(["air", "ground"]);
const ROLES = new Set(["central", "lane"]);
const TOKEN = /^[a-z][a-z0-9]*(?:[-:][a-z0-9]+)*$/u;

const COMBAT_STYLE_TEXT = `.combat-layer{position:absolute;z-index:7;inset:0;overflow:hidden;pointer-events:none}.combat-frame{position:absolute;inset:0}.combat-marker{position:absolute;left:calc(var(--combat-x)*100%/18000);top:calc(var(--combat-y)*100%/32000);width:28px;height:28px;translate:-50% -50%;border:3px solid #e4ead7;border-radius:50%;background:#42515a;box-shadow:0 3px 0 #0a1014aa}.combat-marker--tower{z-index:25;width:42px;height:42px;border-radius:9px}.combat-marker--entity-ground{z-index:20}.combat-marker--entity-air{z-index:30;border-style:double;box-shadow:0 8px 6px #0a101466}.combat-marker--north{background:#b95c4c}.combat-marker--south{background:#398ba4}.combat-marker[data-destroyed="true"]{opacity:.42;filter:grayscale(1)}.combat-health{position:absolute;left:50%;bottom:calc(100% + 6px);width:36px;height:5px;translate:-50% 0;transform:scaleX(calc(var(--combat-health)/var(--combat-health-max)));transform-origin:left center;border-radius:3px;background:#b7eb6c;box-shadow:0 0 0 2px #152018}.combat-target-link{position:absolute;z-index:10;inset:0;width:100%;height:100%;overflow:visible}.combat-target-link line{stroke:#f3f5d088;stroke-width:90;stroke-dasharray:180 150}` + COMBAT_ART_STYLE + COMBAT_MOTION_STYLE + COMBAT_DEATH_STYLE + `.combat-art--copperskiff,.combat-art--skymaul,.combat-art--stormkite{overflow:hidden}.combat-marker[data-kind="brackenwheel"]::before{content:"";position:absolute;z-index:-1;inset:-3px;border:2px solid;border-radius:50%;pointer-events:none}.combat-marker[data-kind="brackenwheel"][data-side="north"]::before{border-color:#b95c4c}.combat-marker[data-kind="brackenwheel"][data-side="south"]::before{border-color:#398ba4}`;

export function getCombatStyleText() {
  return COMBAT_STYLE_TEXT;
}

function dataObject(value, keys, label, optionalKeys = []) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null) ||
    Object.getOwnPropertySymbols(value).length !== 0
  ) {
    throw new TypeError(`${label} must be a plain data object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const actual = Reflect.ownKeys(descriptors);
  const allowed = new Set([...keys, ...optionalKeys]);
  if (
    keys.some((key) => !Object.hasOwn(descriptors, key)) ||
    actual.length > keys.length + optionalKeys.length ||
    actual.some((key) => typeof key !== "string" || !allowed.has(key))
  ) {
    throw new TypeError(`${label} has an invalid shape`);
  }
  const result = {};
  for (const key of [...keys, ...optionalKeys.filter((key) => Object.hasOwn(descriptors, key))]) {
    const descriptor = descriptors[key];
    if (
      !descriptor ||
      !descriptor.enumerable ||
      !Object.hasOwn(descriptor, "value")
    ) {
      throw new TypeError(`${label}.${key} must be an enumerable data property`);
    }
    result[key] = descriptor.value;
  }
  return result;
}

function denseArray(value, maximum, label) {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    Object.getOwnPropertySymbols(value).length !== 0 ||
    value.length > maximum
  ) {
    throw new TypeError(`${label} must be a plain array of at most ${maximum} items`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (key === "length") continue;
    if (
      typeof key !== "string" ||
      !/^(0|[1-9]\d*)$/u.test(key) ||
      Number(key) >= value.length
    ) {
      throw new TypeError(`${label} must contain only indexed data`);
    }
  }
  return Array.from({ length: value.length }, (_, index) => {
    const descriptor = descriptors[String(index)];
    if (
      !descriptor ||
      !descriptor.enumerable ||
      !Object.hasOwn(descriptor, "value")
    ) {
      throw new TypeError(`${label}[${index}] must be an enumerable data property`);
    }
    return descriptor.value;
  });
}

function integer(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label} must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}

function token(value, label) {
  if (typeof value !== "string" || value.length > 96 || !TOKEN.test(value)) {
    throw new TypeError(`${label} must be a bounded original identifier`);
  }
  return value;
}

function checkedId(value, label) {
  if (Number.isSafeInteger(value) && value >= 1) {
    return { key: `n:${value}`, value };
  }
  const checked = token(value, label);
  return { key: `s:${checked}`, value: checked };
}

function checkedTargetId(value, label) {
  return value === null ? null : checkedId(value, label);
}

function point(value, label) {
  const checked = dataObject(value, ["x", "y"], label);
  return {
    x: integer(checked.x, 0, ARENA_WIDTH_MILLITILES, `${label}.x`),
    y: integer(checked.y, 0, ARENA_LENGTH_MILLITILES, `${label}.y`),
  };
}

function health(hitpoints, maxHitpoints, label) {
  const maximum = integer(maxHitpoints, 1, Number.MAX_SAFE_INTEGER, `${label}.maxHitpoints`);
  return {
    hitpoints: integer(hitpoints, 0, maximum, `${label}.hitpoints`),
    maxHitpoints: maximum,
  };
}

function checkedSide(value, label) {
  if (!SIDES.has(value)) throw new TypeError(`${label} must be north or south`);
  return value;
}

function compareKey(left, right) {
  if (typeof left.id === "number" && typeof right.id === "number") {
    return left.id - right.id;
  }
  if (typeof left.id === "number") return -1;
  if (typeof right.id === "number") return 1;
  return left.key < right.key ? -1 : left.key > right.key ? 1 : 0;
}

function checkedEvents(value, tick) {
  const events = denseArray(value, COMBAT_EVENT_LIMIT, "combat events")
    .map((raw, index) => {
      const label = `combat events[${index}]`;
      const event = dataObject(
        raw,
        ["entityId", "sequence", "tick", "type"],
        label,
      );
      const entity = checkedId(event.entityId, `${label}.entityId`);
      if (!new Set(["damage", "death", "target"]).has(event.type)) {
        throw new TypeError(`${label}.type is invalid`);
      }
      const eventTick = integer(event.tick, 0, tick, `${label}.tick`);
      if (event.sequence !== index) {
        throw new TypeError(`${label}.sequence must be contiguous`);
      }
      return {
        entityId: entity.value,
        entityKey: entity.key,
        sequence: index,
        tick: eventTick,
        type: event.type,
      };
    });
  for (let index = 1; index < events.length; index += 1) {
    if (events[index].tick < events[index - 1].tick) {
      throw new TypeError("combat event ticks must be nondecreasing");
    }
  }
  return events;
}

function checkedEntities(value) {
  const entities = denseArray(value, COMBAT_ENTITY_LIMIT, "combat entities")
    .map((raw, index) => {
      const label = `combat entities[${index}]`;
      const entity = dataObject(raw, [
        "hitpoints",
        "id",
        "kind",
        "layer",
        "maxHitpoints",
        "position",
        "side",
        "targetId",
      ], label, ["hidden"]);
      const hasHiddenState = Object.hasOwn(entity, "hidden");
      if ((entity.kind === "buried-coil") !== hasHiddenState ||
          (hasHiddenState && typeof entity.hidden !== "boolean")) {
        throw new TypeError(`${label}.hidden must be present only as a Buried Coil boolean`);
      }
      const id = checkedId(entity.id, `${label}.id`);
      const target = checkedTargetId(entity.targetId, `${label}.targetId`);
      const checkedHealth = health(entity.hitpoints, entity.maxHitpoints, label);
      if (!LAYERS.has(entity.layer)) {
        throw new TypeError(`${label}.layer must be air or ground`);
      }
      return {
        ...checkedHealth,
        hidden: hasHiddenState ? entity.hidden : false,
        id: id.value,
        key: id.key,
        kind: token(entity.kind, `${label}.kind`),
        layer: entity.layer,
        position: point(entity.position, `${label}.position`),
        side: checkedSide(entity.side, `${label}.side`),
        targetId: target?.value ?? null,
        targetKey: target?.key ?? null,
      };
    })
    .sort(compareKey);
  for (let index = 1; index < entities.length; index += 1) {
    if (entities[index - 1].key === entities[index].key) {
      throw new TypeError("combat entity IDs must be unique");
    }
  }
  return entities;
}

function checkedTowers(value) {
  const towers = denseArray(value, COMBAT_TOWER_LIMIT, "combat towers")
    .map((raw, index) => {
      const label = `combat towers[${index}]`;
      const tower = dataObject(raw, [
        "hitpoints",
        "id",
        "maxHitpoints",
        "position",
        "role",
        "side",
        "targetId",
      ], label);
      const id = checkedId(tower.id, `${label}.id`);
      const target = checkedTargetId(tower.targetId, `${label}.targetId`);
      if (!ROLES.has(tower.role)) {
        throw new TypeError(`${label}.role must be central or lane`);
      }
      return {
        ...health(tower.hitpoints, tower.maxHitpoints, label),
        id: id.value,
        key: id.key,
        position: point(tower.position, `${label}.position`),
        role: tower.role,
        side: checkedSide(tower.side, `${label}.side`),
        targetId: target?.value ?? null,
        targetKey: target?.key ?? null,
      };
    })
    .sort(compareKey);
  for (let index = 1; index < towers.length; index += 1) {
    if (towers[index - 1].key === towers[index].key) {
      throw new TypeError("combat tower IDs must be unique");
    }
  }
  return towers;
}

function freeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function marker(record) {
  return {
    healthDenominator: record.maxHitpoints,
    healthNumerator: record.hitpoints,
    id: record.id,
    key: record.key,
    side: record.side,
    x: record.position.x,
    y: record.position.y,
  };
}

export function createCombatViewModel(state) {
  const source = dataObject(state, ["entities", "events", "tick", "towers"], "combat state");
  const entities = checkedEntities(source.entities);
  const towers = checkedTowers(source.towers);
  const tick = integer(source.tick, 0, Number.MAX_SAFE_INTEGER, "combat state.tick");
  const events = checkedEvents(source.events, tick);
  const all = new Map();
  for (const record of [...entities, ...towers]) {
    if (all.has(record.key)) throw new TypeError("combat IDs must be globally unique");
    all.set(record.key, record);
  }
  const alive = new Map(
    [...all].filter(([, record]) => record.hitpoints > 0),
  );
  const links = [];
  for (const sourceRecord of [...entities, ...towers].sort(compareKey)) {
    if (sourceRecord.hitpoints === 0 || sourceRecord.targetKey === null) continue;
    const target = alive.get(sourceRecord.targetKey);
    if (!target) {
      throw new TypeError(`live combat source ${sourceRecord.key} targets a missing or dead ID`);
    }
    links.push({
      fromKey: sourceRecord.key,
      toKey: target.key,
      x1: sourceRecord.position.x,
      x2: target.position.x,
      y1: sourceRecord.position.y,
      y2: target.position.y,
    });
  }
  if (links.length > COMBAT_TARGET_LINK_LIMIT) {
    throw new RangeError("combat target link count exceeds its bound");
  }
  const view = {
    entities: entities.filter(({ hitpoints }) => hitpoints > 0).map((entity) => ({
      ...marker(entity),
      kind: entity.kind,
      layer: entity.layer,
      ...(entity.kind === "buried-coil" ? { hidden: entity.hidden } : {}),
    })),
    events,
    links,
    tick,
    towers: towers.map((tower) => ({
      ...marker(tower),
      destroyed: tower.hitpoints === 0,
      role: tower.role,
    })),
    version: COMBAT_VIEW_VERSION,
  };
  freeze(view);
  CANONICAL_VIEWS.add(view);
  return view;
}

function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new TypeError("combat view numbers must be safe integers");
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    ).join(",")}}`;
  }
  throw new TypeError("combat view contains an unsupported value");
}

export function serializeCombatViewModel(view) {
  if (!CANONICAL_VIEWS.has(view)) {
    throw new TypeError("combat view must come from createCombatViewModel or restoreCombatViewModel");
  }
  return canonicalJson(view);
}

function stateFromView(raw) {
  const view = dataObject(raw, ["entities", "events", "links", "tick", "towers", "version"], "combat view");
  if (view.version !== COMBAT_VIEW_VERSION) throw new TypeError("combat view version is unsupported");
  const entities = denseArray(view.entities, COMBAT_ENTITY_LIMIT, "combat view.entities").map((rawEntity, index) => {
    const entity = dataObject(rawEntity, [
      "healthDenominator", "healthNumerator", "id", "key", "kind", "layer", "side", "x", "y",
    ], `combat view.entities[${index}]`, ["hidden"]);
    const hasHiddenState = Object.hasOwn(entity, "hidden");
    if ((entity.kind === "buried-coil") !== hasHiddenState ||
        (hasHiddenState && typeof entity.hidden !== "boolean")) {
      throw new TypeError(`combat view entity[${index}].hidden must be present only as a Buried Coil boolean`);
    }
    const id = checkedId(entity.id, `combat view.entities[${index}].id`);
    if (entity.key !== id.key) throw new TypeError("combat view entity key is noncanonical");
    return {
      hitpoints: entity.healthNumerator,
      id: entity.id,
      kind: entity.kind,
      layer: entity.layer,
      maxHitpoints: entity.healthDenominator,
      position: { x: entity.x, y: entity.y },
      side: entity.side,
      targetId: null,
      ...(hasHiddenState ? { hidden: entity.hidden } : {}),
    };
  });
  const towers = denseArray(view.towers, COMBAT_TOWER_LIMIT, "combat view.towers").map((rawTower, index) => {
    const tower = dataObject(rawTower, [
      "destroyed", "healthDenominator", "healthNumerator", "id", "key", "role", "side", "x", "y",
    ], `combat view.towers[${index}]`);
    const id = checkedId(tower.id, `combat view.towers[${index}].id`);
    if (tower.key !== id.key || tower.destroyed !== (tower.healthNumerator === 0)) {
      throw new TypeError("combat view tower identity or terminal state is noncanonical");
    }
    return {
      hitpoints: tower.healthNumerator,
      id: tower.id,
      maxHitpoints: tower.healthDenominator,
      position: { x: tower.x, y: tower.y },
      role: tower.role,
      side: tower.side,
      targetId: null,
    };
  });
  const events = denseArray(view.events, COMBAT_EVENT_LIMIT, "combat view.events").map((rawEvent, index) => {
    const event = dataObject(
      rawEvent,
      ["entityId", "entityKey", "sequence", "tick", "type"],
      `combat view.events[${index}]`,
    );
    const id = checkedId(event.entityId, `combat view.events[${index}].entityId`);
    if (event.entityKey !== id.key) throw new TypeError("combat view event key is noncanonical");
    return {
      entityId: event.entityId,
      sequence: event.sequence,
      tick: event.tick,
      type: event.type,
    };
  });
  const byKey = new Map([...entities, ...towers].map((record) => [checkedId(record.id, "combat restore id").key, record]));
  const links = denseArray(view.links, COMBAT_TARGET_LINK_LIMIT, "combat view.links");
  const sourceKeys = new Set();
  for (let index = 0; index < links.length; index += 1) {
    const link = dataObject(links[index], ["fromKey", "toKey", "x1", "x2", "y1", "y2"], `combat view.links[${index}]`);
    const from = byKey.get(link.fromKey);
    const to = byKey.get(link.toKey);
    if (!from || !to || sourceKeys.has(link.fromKey)) throw new TypeError("combat view link identity is invalid");
    if (
      link.x1 !== from.position.x || link.y1 !== from.position.y ||
      link.x2 !== to.position.x || link.y2 !== to.position.y
    ) throw new TypeError("combat view link geometry is noncanonical");
    from.targetId = to.id;
    sourceKeys.add(link.fromKey);
  }
  return { entities, events, tick: view.tick, towers };
}

export function restoreCombatViewModel(bytes) {
  if (typeof bytes !== "string" || bytes.length > 2_000_000) {
    throw new TypeError("combat view bytes must be a bounded string");
  }
  let raw;
  try {
    raw = JSON.parse(bytes);
  } catch {
    throw new TypeError("combat view bytes must be valid JSON");
  }
  const restored = createCombatViewModel(stateFromView(raw));
  if (serializeCombatViewModel(restored) !== bytes) {
    throw new TypeError("combat view bytes must use canonical encoding");
  }
  return restored;
}

function setCommonNode(node, record, type) {
  node.className = `combat-marker combat-marker--${type} combat-marker--${record.side}`;
  node.dataset.combatId = String(record.id);
  node.dataset.combatKey = record.key;
  node.dataset.side = record.side;
  node.style.setProperty("--combat-health", String(record.healthNumerator));
  node.style.setProperty("--combat-health-max", String(record.healthDenominator));
  node.style.setProperty("--combat-x", String(record.x));
  node.style.setProperty("--combat-y", String(ARENA_LENGTH_MILLITILES - record.y));
  const healthNode = node.ownerDocument.createElement("i");
  healthNode.className = "combat-health";
  healthNode.setAttribute("aria-hidden", "true");
  node.appendChild(healthNode);
}

function briarFacingDirection(entity, link) {
  if (!link) return entity.side === "north" ? "south" : "north";
  const dx = link.x2 - link.x1;
  const dy = link.y2 - link.y1;
  if (Math.abs(dy) >= Math.abs(dx)) {
    if (dy > 0) return "north";
    if (dy < 0) return "south";
  }
  if (dx > 0) return "east";
  if (dx < 0) return "west";
  return entity.side === "north" ? "south" : "north";
}

function brackenwheelPresentation(document) {
  const dataset = document.documentElement?.dataset;
  if (dataset?.combatBodyCssPixels === undefined && dataset?.combatFrameScale === undefined) {
    return { bodyCssPixels: 13, frameScale: 1 };
  }
  const bodyCssPixels = Number(dataset.combatBodyCssPixels);
  const frameScale = Number(dataset.combatFrameScale);
  if ((bodyCssPixels !== 13 && bodyCssPixels !== 26) ||
      !Number.isFinite(frameScale) || frameScale <= 0 || frameScale > 8) {
    throw new TypeError("Brackenwheel presentation context is invalid");
  }
  return { bodyCssPixels, frameScale };
}

function copperskiffPresentation(document) {
  const dataset = document.documentElement?.dataset;
  if (dataset?.combatBodyCssPixels === undefined && dataset?.combatFrameScale === undefined) {
    return { bodyCssPixels: 13, frameScale: 1 };
  }
  const bodyCssPixels = Number(dataset.combatBodyCssPixels);
  const frameScale = Number(dataset.combatFrameScale);
  if ((bodyCssPixels !== 13 && bodyCssPixels !== 26) ||
      !Number.isFinite(frameScale) || frameScale <= 0 || frameScale > 8) {
    throw new TypeError("Copperskiff presentation context is invalid");
  }
  return { bodyCssPixels, frameScale };
}

function sizeBrackenwheelArt(node, art, frameScale) {
  const frameWidth = Number.parseFloat(art.style.width);
  const frameHeight = Number.parseFloat(art.style.height);
  if (!Number.isFinite(frameWidth) || !Number.isFinite(frameHeight)) {
    throw new TypeError("Brackenwheel art frame dimensions are invalid");
  }
  art.setAttribute("class", "combat-art");
  art.style.width = `${frameWidth / frameScale}px`;
  art.style.height = `${frameHeight / frameScale}px`;
  node.style.width = art.style.width;
  node.style.height = art.style.height;
}

function sizeAetherWellArt(node, art, frameScale) {
  const frameWidth = Number.parseFloat(art.style.width);
  const frameHeight = Number.parseFloat(art.style.height);
  if (!Number.isFinite(frameWidth) || !Number.isFinite(frameHeight)) {
    throw new TypeError("Aether Well art frame dimensions are invalid");
  }
  art.style.width = `${frameWidth / frameScale}px`;
  art.style.height = `${frameHeight / frameScale}px`;
  node.style.width = art.style.width;
  node.style.height = art.style.height;
}

export function bindCombatViewModel(layer, view) {
  if (
    layer === null || typeof layer !== "object" ||
    typeof layer.replaceChildren !== "function" ||
    layer.ownerDocument === null || typeof layer.ownerDocument?.createElement !== "function"
  ) throw new TypeError("combat layer must be a DOM element");
  if (!CANONICAL_VIEWS.has(view)) {
    throw new TypeError(
      "combat view must come from createCombatViewModel or restoreCombatViewModel",
    );
  }
  const canonical = view;
  const frame = layer.ownerDocument.createElement("div");
  frame.className = "combat-frame";
  frame.dataset.tick = String(canonical.tick);
  const nodes = [];
  const structureKeys = new Set(canonical.entities
    .filter(({ kind }) => kind === "aether-well" || COMBAT_STRUCTURE_ART_IDS.includes(kind))
    .map(({ key }) => key));
  const targetingStructureKeys = new Set(canonical.links
    .filter(({ fromKey }) => structureKeys.has(fromKey))
    .map(({ fromKey }) => fromKey));
  const linksBySource = new Map(canonical.links.map((link) => [link.fromKey, link]));
  const brackenwheelContext = brackenwheelPresentation(layer.ownerDocument);
  const copperskiffContext = copperskiffPresentation(layer.ownerDocument);
  const reducedMotion = layer.ownerDocument.defaultView?.matchMedia?.(
    "(prefers-reduced-motion: reduce)",
  )?.matches === true;
  for (const link of canonical.links) {
    const createSvg = typeof layer.ownerDocument.createElementNS === "function"
      ? (name) => layer.ownerDocument.createElementNS("http://www.w3.org/2000/svg", name)
      : (name) => layer.ownerDocument.createElement(name);
    const node = createSvg("svg");
    node.setAttribute("class", "combat-target-link");
    node.dataset.from = link.fromKey;
    node.dataset.fromStructure = String(structureKeys.has(link.fromKey));
    node.dataset.to = link.toKey;
    node.setAttribute("aria-hidden", "true");
    node.setAttribute("preserveAspectRatio", "none");
    node.setAttribute("viewBox", `0 0 ${ARENA_WIDTH_MILLITILES} ${ARENA_LENGTH_MILLITILES}`);
    const line = createSvg("line");
    line.setAttribute("x1", String(link.x1));
    line.setAttribute("x2", String(link.x2));
    line.setAttribute("y1", String(ARENA_LENGTH_MILLITILES - link.y1));
    line.setAttribute("y2", String(ARENA_LENGTH_MILLITILES - link.y2));
    node.appendChild(line);
    nodes.push(node);
  }
  for (const tower of canonical.towers) {
    const node = layer.ownerDocument.createElement("span");
    setCommonNode(node, tower, "tower");
    node.dataset.destroyed = String(tower.destroyed);
    node.dataset.role = tower.role;
    nodes.push(node);
  }
  const reactions = new Map();
  for (const event of canonical.events) {
    if (canonical.tick - event.tick < 5) reactions.set(event.entityKey, event.type);
  }
  for (const entity of canonical.entities) {
    const node = layer.ownerDocument.createElement("span");
    setCommonNode(node, entity, `entity-${entity.layer}`);
    node.dataset.kind = entity.kind;
    node.dataset.layer = entity.layer;
    if (entity.kind === "buried-coil") node.dataset.hidden = String(entity.hidden);
    const reaction = reactions.get(entity.key) ?? "idle";
    node.dataset.reaction = reaction;
    if (structureKeys.has(entity.key)) {
      node.className += " combat-marker--structure";
      node.dataset.structure = "true";
      node.dataset.targeting = String(targetingStructureKeys.has(entity.key));
    }
    const art = entity.kind === "briar-runner"
      ? createBriarRunnerPaintedArt(layer.ownerDocument, {
        // Generic effect reactions do not prove this unit's own primary
        // attack. The authenticated GameSession motion projection upgrades a
        // Briar to its attack frame only when it supplies a real melee contact.
        action: "walk",
        direction: briarFacingDirection(entity, linksBySource.get(entity.key)),
        reducedMotion,
        side: entity.side,
        tick: canonical.tick,
      })
      : entity.kind === "copperskiff"
        ? createCopperskiffBattleArt(layer.ownerDocument, {
          bodyCssPixels: copperskiffContext.bodyCssPixels,
          direction: briarFacingDirection(entity, linksBySource.get(entity.key)),
          frameScale: copperskiffContext.frameScale,
          reducedMotion,
          side: entity.side,
          tick: canonical.tick,
        })
      : entity.kind === "skymaul"
        ? createSkymaulBattleArt(layer.ownerDocument, {
          action: "idle",
          bodyCssPixels: copperskiffContext.bodyCssPixels,
          direction: briarFacingDirection(entity, linksBySource.get(entity.key)),
          frameScale: copperskiffContext.frameScale,
          reducedMotion,
          side: entity.side,
          tick: canonical.tick,
        })
      : entity.kind === "stormkite"
        ? createStormkiteBattleArt(layer.ownerDocument, {
          action: "idle",
          bodyCssPixels: copperskiffContext.bodyCssPixels,
          direction: briarFacingDirection(entity, linksBySource.get(entity.key)),
          frameScale: copperskiffContext.frameScale,
          reducedMotion,
          side: entity.side,
          tick: canonical.tick,
        })
      : entity.kind === "brackenwheel"
        ? createBrackenwheelScaleArt(layer.ownerDocument, {
          bodyCssPixels: brackenwheelContext.bodyCssPixels,
        })
        : entity.kind === "aether-well"
          ? createAetherWellBattleArt(layer.ownerDocument, {
            bodyCssPixels: brackenwheelContext.bodyCssPixels,
            side: entity.side,
          })
          : createCombatArt(layer.ownerDocument, entity.kind, entity.side, entity.layer, entity.hidden);
    if (entity.kind === "brackenwheel") {
      sizeBrackenwheelArt(node, art, brackenwheelContext.frameScale);
    } else if (entity.kind === "aether-well") {
      sizeAetherWellArt(node, art, brackenwheelContext.frameScale);
    }
    node.appendChild(art);
    nodes.push(node);
  }
  for (const node of nodes) frame.appendChild(node);
  layer.replaceChildren(frame);
  return canonical;
}

export function mountCombatLayer(shell) {
  if (shell === null || typeof shell !== "object" || typeof shell.querySelector !== "function") {
    throw new TypeError("combat shell must be a DOM element");
  }
  const arena = shell.querySelector('[data-ui="arena"]');
  if (!arena || typeof arena.appendChild !== "function" || typeof arena.ownerDocument?.createElement !== "function") {
    throw new TypeError("combat shell must contain an arena element");
  }
  const layer = arena.ownerDocument.createElement("div");
  const style = arena.ownerDocument.createElement("style");
  style.dataset.ui = "combat-style";
  style.textContent = COMBAT_STYLE_TEXT;
  layer.className = "combat-layer";
  layer.dataset.ui = "combat-layer";
  layer.setAttribute("aria-live", "off");
  arena.appendChild(style);
  arena.appendChild(layer);
  return layer;
}
