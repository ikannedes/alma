import { bindHudMotion } from "./hud-motion.js";
import { createCombatMotionView, bindCombatMotion } from "./combat-motion.js";
import { createBriarRunnerPaintedArt } from "./combat-art.js";
import {
  GameSession,
  isAuthenticGameSession,
  isAuthenticGameSessionProjectionSnapshot,
} from "../sim/game-session.js";
import {
  bindCombatEffectsViewModel,
  createCombatEffectsViewModel,
  serializeCombatEffectsViewModel,
} from "./combat-effects.js";
import {
  bindCombatViewModel,
  createCombatViewModel,
  serializeCombatViewModel,
} from "./combat-state.js";
import {
  createHudViewModel,
  getHudMarkup,
  serializeHudViewModel,
} from "./hud-state.js";
import { COMBAT_STRUCTURE_ART_IDS } from "./combat-art.js";
import {
  bindMatchFeedback,
  createSessionMatchFeedbackViewModel,
  serializeMatchFeedbackViewModel,
} from "./match-feedback.js";

export const GAME_UI_FRAME_VERSION = 1;
export const GAME_UI_TERMINAL_PRESENTATION_TICKS = 24;

const FRAMES = new WeakSet();
const FRAME_PARTS = new WeakSet();
const FRAME_MOTION = new WeakMap();
const FRAME_HUD_RECEIPT = new WeakMap();
const FRAME_TERMINAL_TICK = new WeakMap();
const OPTIONS = new WeakSet();
const HUD_PAINTER_SURFACES = new WeakSet();
const STRUCTURE_IDS = new Map([
  [Number.MAX_SAFE_INTEGER - 5, "south:central"],
  [Number.MAX_SAFE_INTEGER - 4, "south:lane:west"],
  [Number.MAX_SAFE_INTEGER - 3, "south:lane:east"],
  [Number.MAX_SAFE_INTEGER - 2, "north:central"],
  [Number.MAX_SAFE_INTEGER - 1, "north:lane:west"],
  [Number.MAX_SAFE_INTEGER, "north:lane:east"],
]);

function ownRecord(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) ||
      Object.getOwnPropertySymbols(value).length !== 0) {
    throw new TypeError(`${label} must be a plain data object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const actual = Reflect.ownKeys(descriptors).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length ||
      actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${label} has an invalid shape`);
  }
  return Object.fromEntries(keys.map((key) => {
    const descriptor = descriptors[key];
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
      throw new TypeError(`${label}.${key} must be an enumerable data property`);
    }
    return [key, descriptor.value];
  }));
}

function freeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function checkedTick(value, label) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 18_000) {
    throw new TypeError(`${label} must be a canonical match tick`);
  }
  return value;
}

function targetId(value) {
  return STRUCTURE_IDS.get(value) ?? value;
}

function combatState(state, effectEvents) {
  const structures = state.battle.structures.filter(({ cardId }) =>
    cardId === "aether-well" || COMBAT_STRUCTURE_ART_IDS.includes(cardId));
  const aliveIds = new Set([
    ...state.battle.units.filter((unit) => unit.hitpoints > 0).map((unit) => unit.id),
    ...state.battle.towers.filter((tower) => tower.hitpoints > 0).map((tower) => tower.id),
    ...structures.filter((structure) => structure.alive && structure.hitpoints > 0)
      .map((structure) => structure.id),
  ]);
  const liveTargetId = (value) => {
    const mapped = targetId(value);
    return aliveIds.has(mapped) ? mapped : null;
  };
  const structureTargetId = (structure) => {
    if (typeof structure.targetKey !== "string") return null;
    const match = /^(?:unit|structure):([1-9][0-9]*)$/u.exec(structure.targetKey);
    if (match !== null) {
      const id = Number(match[1]);
      return Number.isSafeInteger(id) ? liveTargetId(id) : null;
    }
    if (structure.targetKey.startsWith("tower:")) {
      return liveTargetId(structure.targetKey.slice("tower:".length));
    }
    return null;
  };
  const entities = state.battle.units.map((unit) => ({
    hitpoints: unit.hitpoints,
    id: unit.id,
    kind: unit.archetypeId,
    layer: unit.layer,
    maxHitpoints: unit.maxHealth,
    position: unit.position,
    side: unit.side,
    targetId: liveTargetId(unit.targetId),
  })).concat(structures.map((structure) => ({
    hitpoints: structure.hitpoints,
    ...(structure.cardId === "buried-coil" ? { hidden: structure.hidden } : {}),
    id: structure.id,
    kind: structure.cardId,
    layer: "ground",
    maxHitpoints: structure.maxHitpoints,
    position: structure.position,
    side: structure.side,
    targetId: structure.alive ? structureTargetId(structure) : null,
  })));
  const towers = state.battle.towers.map((tower) => ({
    hitpoints: tower.hitpoints,
    id: tower.id,
    maxHitpoints: tower.maxHitpoints,
    position: tower.position,
    role: tower.role,
    side: tower.side,
    targetId: liveTargetId(tower.attack.targetId),
  }));
  const roots = new Map(effectEvents
    .filter(({ parentId, phase }) => parentId === null && phase === "open")
    .map((event) => [event.rootId, event]));
  const relevant = effectEvents.filter(({ phase }) =>
    ["contact", "damage", "death"].includes(phase));
  const tail = relevant.slice(-2_048);
  const events = tail.map((event, sequence) => ({
    entityId: event.phase === "contact"
      ? roots.get(event.rootId)?.payload.sourceId ?? event.payload.targetId
      : event.payload.targetId,
    sequence,
    tick: event.tick,
    type: event.phase === "contact" ? "target" : event.phase,
  }));
  return { entities, events, tick: state.tick, towers };
}

function briarAttackContacts(state, motion) {
  const units = new Map(state.battle.units.map((unit) => [unit.id, unit]));
  const poses = new Map(motion.poses.map((pose) => [pose.id, pose.pose]));
  const contacts = [];
  for (const contact of motion.contacts) {
    const identity = /^([1-9][0-9]*):([1-9][0-9]*)$/u.exec(contact.id);
    if (identity === null) continue;
    const sourceId = Number(identity[1]);
    const sequence = Number(identity[2]);
    const source = units.get(sourceId);
    if (!source || source.archetypeId !== "briar-runner" ||
        source.delivery !== "melee" || !source.alive || source.hitpoints <= 0 ||
        poses.get(sourceId) !== "attack") continue;
    const cycle = source.attack;
    const sourceTick = source.spawnedAt + cycle.nextAttackTick - cycle.config.hitSpeedTicks;
    if (cycle.phase !== "cycling" || cycle.statusWork ||
        cycle.attackSequence !== sequence || cycle.targetId !== contact.targetId ||
        contact.tick !== sourceTick || contact.age !== state.tick - sourceTick ||
        contact.age < 0 || contact.age >= 4) continue;
    contacts.push(Object.freeze({
      sourceClass: source.delivery,
      sourceAge: contact.age,
      sourceId,
      sourceSequence: sequence,
      sourceTick,
    }));
  }
  return Object.freeze(contacts);
}

function bindBriarAttackFrames(combat, view, contacts) {
  if (contacts.length === 0) return;
  const frame = children(combat)[0];
  if (!frame) throw new TypeError("combat frame is missing while binding Briar attacks");
  const markers = new Map(children(frame).filter((node) =>
    node.dataset?.kind === "briar-runner")
    .map((node) => [Number(node.dataset.combatId), node]));
  for (const contact of contacts) {
    const marker = markers.get(contact.sourceId);
    if (!marker) throw new TypeError("Briar contact source is missing from the combat frame");
    const nodes = children(marker);
    const artIndex = nodes.findIndex((node) => node.dataset?.artId === "briar-runner");
    if (artIndex === -1) throw new TypeError("Briar contact source has no painted art");
    const currentArt = nodes[artIndex];
    const art = createBriarRunnerPaintedArt(marker.ownerDocument, {
      action: "attack",
      direction: currentArt.dataset.spriteDirection,
      reducedMotion: currentArt.dataset.reducedMotion === "true",
      side: marker.dataset.side,
      tick: contact.sourceAge,
    });
    art.dataset.simulationTick = String(view.tick);
    art.dataset.attackAnimationAge = String(contact.sourceAge);
    art.dataset.attackSourceId = String(contact.sourceId);
    art.dataset.attackSourceSequence = String(contact.sourceSequence);
    art.dataset.attackSourceTick = String(contact.sourceTick);
    art.dataset.attackSourceClass = contact.sourceClass;
    nodes[artIndex] = art;
    marker.replaceChildren(...nodes);
  }
}

function mintFrameParts(snapshot, combat, effects, feedback, hud, motion, attacks) {
  if (!isAuthenticGameSessionProjectionSnapshot(snapshot)) {
    throw new TypeError("game UI frame parts require an authentic projection snapshot");
  }
  const parts = Object.freeze({ combat, effects, feedback, hud,
    sequence: snapshot.sequence, source: snapshot.source, tick: snapshot.state.tick,
    version: GAME_UI_FRAME_VERSION });
  FRAME_MOTION.set(parts, Object.freeze({ attacks, view: motion }));
  FRAME_HUD_RECEIPT.set(parts, snapshot.hudFeedback.lastCardPlay[hud.elixir.side]);
  FRAME_PARTS.add(parts);
  return parts;
}

export function composeGameUiFrame(value) {
  // WeakSet membership is deliberately the first and only operation on an
  // untrusted value. It rejects object, callable, cross-realm and revoked
  // proxies without invoking any proxy trap or accessor.
  if (!FRAME_PARTS.has(value)) {
    throw new TypeError("game UI frame parts must be minted by this module");
  }
  const frame = value;
  if (frame.version !== GAME_UI_FRAME_VERSION) {
    throw new TypeError("game UI frame version is unsupported");
  }
  const tick = checkedTick(frame.tick, "game UI frame.tick");
  // Serializers are capability checks: each view must have been admitted by
  // its own projector, not merely resemble one structurally.
  serializeHudViewModel(frame.hud);
  serializeCombatViewModel(frame.combat);
  serializeCombatEffectsViewModel(frame.effects);
  serializeMatchFeedbackViewModel(frame.feedback);
  if ([frame.hud.tick, frame.combat.tick, frame.effects.tick, frame.feedback.tick]
    .some((candidate) => candidate !== tick)) {
    throw new TypeError("all game UI projections must use the same tick");
  }
  if (!Number.isSafeInteger(frame.sequence) || frame.sequence < 0 ||
      !frame.source || typeof frame.source !== "object") {
    throw new TypeError("game UI frame identity is invalid");
  }
  const admitted = freeze({ ...frame, tick });
  FRAME_MOTION.set(admitted, FRAME_MOTION.get(frame));
  FRAME_HUD_RECEIPT.set(admitted, FRAME_HUD_RECEIPT.get(frame));
  FRAMES.add(admitted);
  return admitted;
}

export function createGameUiOptions(localSide = "south", selectedCardId = null, terminalPresentationTick = GAME_UI_TERMINAL_PRESENTATION_TICKS) {
  if ((localSide !== "north" && localSide !== "south") ||
      (selectedCardId !== null && typeof selectedCardId !== "string")) {
    throw new TypeError("game UI options are invalid");
  }
  if (!Number.isSafeInteger(terminalPresentationTick) || terminalPresentationTick < 0 || terminalPresentationTick > GAME_UI_TERMINAL_PRESENTATION_TICKS) {
    throw new TypeError("terminal presentation tick must be an integer from 0 to 24");
  }
  const options = Object.freeze({ localSide, selectedCardId, terminalPresentationTick });
  OPTIONS.add(options);
  return options;
}

const DEFAULT_GAME_UI_OPTIONS = createGameUiOptions();

export function createGameUiFrame(session, options = DEFAULT_GAME_UI_OPTIONS) {
  if (!isAuthenticGameSession(session)) {
    throw new TypeError("game UI frame requires an authentic GameSession");
  }
  // As with composed frames, membership is the only operation on untrusted
  // options. Proxies and accessors cannot participate in admission.
  if (!OPTIONS.has(options)) {
    throw new TypeError("game UI options must be minted by this module");
  }
  const snapshot = GameSession.prototype.projectionSnapshot.call(session);
  const state = snapshot.state;
  if (state.tick !== state.battle.tick || state.tick !== state.clock.tick ||
      state.tick !== state.elixir.tick) {
    throw new TypeError("game session projection ticks diverge");
  }
  const setup = snapshot.setup;
  const battleSetup = JSON.parse(setup.battleSetup);
  const cards = battleSetup.roster.map(({ cost, displayName, id }) => ({ cost, displayName, id }));
  const hud = createHudViewModel({
    cards,
    deck: state.decks[options.localSide],
    elixir: state.elixir,
    localSide: options.localSide,
    match: state.clock,
    selectedCardId: options.selectedCardId,
  });
  // Validate and normalize the closed producer feed before deriving any
  // combat presentation. The combat state and effects view share this one
  // admitted source; neither consumes the session replay dialect.
  const effects = createCombatEffectsViewModel(
    snapshot.combatEffectFeed,
    state.tick,
    state.battle.projectiles,
    snapshot,
    session,
  );
  const feedback = createSessionMatchFeedbackViewModel(snapshot);
  const motion = createCombatMotionView(snapshot, effects);
  const frame = composeGameUiFrame(mintFrameParts(
    snapshot,
    createCombatViewModel(combatState(state, effects.events)),
    effects,
    feedback,
    hud,
    motion,
    briarAttackContacts(state, motion),
  ));
  FRAME_TERMINAL_TICK.set(frame, options.terminalPresentationTick);
  return frame;
}

function checkedLayer(value, label) {
  if (!value || typeof value !== "object" || typeof value.replaceChildren !== "function" ||
      !value.ownerDocument || typeof value.ownerDocument.createElement !== "function") {
    throw new TypeError(`${label} must be a DOM layer`);
  }
  return value;
}

function children(layer) {
  return Array.from(layer.childNodes ?? layer.children ?? []);
}

function sameChildren(left, right) {
  return left.length === right.length && left.every((child, index) => child === right[index]);
}

function isHudPainterCanvas(node) {
  return node?.nodeType === 1 &&
    String(node.tagName ?? node.nodeName).toLowerCase() === "canvas" &&
    node.dataset?.ui === "hud-card-paint" && HUD_PAINTER_SURFACES.has(node);
}

function sameRenderedNode(left, right) {
  if (left === right) return true;
  return typeof left?.isEqualNode === "function" && left.isEqualNode(right);
}

function hasHudPainterCanvas(node) {
  if (isHudPainterCanvas(node)) return true;
  return Array.from(node?.childNodes ?? []).some(hasHudPainterCanvas);
}

function sameHudRenderedNode(left, right) {
  if (left === right) return true;
  if (!hasHudPainterCanvas(left) && !hasHudPainterCanvas(right)) {
    return sameRenderedNode(left, right);
  }
  if (!compatibleRenderedNode(left, right)) return false;
  if (left.nodeType !== 1) return sameRenderedNode(left, right);

  const a = renderedAttributeEntries(left);
  const b = renderedAttributeEntries(right);
  if (a === null || b === null) return false;
  a.sort(([leftName], [rightName]) => leftName.localeCompare(rightName));
  b.sort(([leftName], [rightName]) => leftName.localeCompare(rightName));
  if (a.length !== b.length || a.some(([name, value], index) =>
    b[index]?.[0] !== name || b[index]?.[1] !== value)) return false;
  const leftChildren = Array.from(left.childNodes ?? []);
  const rightChildren = Array.from(right.childNodes ?? []);
  return leftChildren.length === rightChildren.length &&
    leftChildren.every((child, index) => sameHudRenderedNode(child, rightChildren[index]));
}

function cloneRenderedNode(node) {
  if (typeof node?.cloneNode !== "function") {
    throw new TypeError("game UI HUD candidate node cannot be cloned");
  }
  const clone = node.cloneNode(true);
  if (!sameRenderedNode(clone, node)) {
    throw new Error("game UI HUD candidate clone changed its rendered content");
  }
  return clone;
}

function compatibleRenderedNode(left, right) {
  return left !== null && left !== undefined && right !== null && right !== undefined &&
    typeof left.nodeType === "number" && left.nodeType === right.nodeType &&
    left.nodeName === right.nodeName &&
    (left.namespaceURI ?? null) === (right.namespaceURI ?? null);
}

function renderedAttributeEntries(node) {
  if (!node?.attributes || typeof node.getAttribute !== "function" ||
      typeof node.setAttribute !== "function" || typeof node.removeAttribute !== "function") {
    return null;
  }
  return Array.from(node.attributes, (attribute) => Array.isArray(attribute)
    ? attribute : [attribute.name, attribute.value])
    .filter(([name]) => !isHudPainterCanvas(node) || (name !== "width" && name !== "height"));
}

function planRenderedNodePatch(current, candidate, operations = []) {
  if (!compatibleRenderedNode(current, candidate)) return null;
  if (current.nodeType === 3 || current.nodeType === 4 || current.nodeType === 8) {
    if (current.nodeValue !== candidate.nodeValue) {
      operations.push({ kind: "value", node: current, value: candidate.nodeValue });
    }
    return operations;
  }
  if (current.nodeType !== 1) {
    return sameRenderedNode(current, candidate) ? operations : null;
  }

  const currentAttributes = renderedAttributeEntries(current);
  const candidateAttributes = renderedAttributeEntries(candidate);
  if (currentAttributes === null || candidateAttributes === null) return null;
  const expectedAttributes = new Map(candidateAttributes);
  for (const [name] of currentAttributes) {
    if (!expectedAttributes.has(name)) operations.push({ kind: "attribute", node: current, name, value: null });
  }
  for (const [name, value] of candidateAttributes) {
    if (current.getAttribute(name) !== value) {
      operations.push({ kind: "attribute", node: current, name, value });
    }
  }

  if (!current.childNodes || !candidate.childNodes) return null;
  const currentChildren = Array.from(current.childNodes);
  const candidateChildren = Array.from(candidate.childNodes);
  const sharedLength = Math.min(currentChildren.length, candidateChildren.length);
  for (let index = 0; index < sharedLength; index += 1) {
    const prior = currentChildren[index];
    const next = candidateChildren[index];
    if (compatibleRenderedNode(prior, next)) {
      if (planRenderedNodePatch(prior, next, operations) === null) return null;
    } else {
      if (typeof current.replaceChild !== "function") return null;
      operations.push({ kind: "replace", parent: current, prior, next });
    }
  }
  for (let index = currentChildren.length - 1; index >= candidateChildren.length; index -= 1) {
    if (typeof current.removeChild !== "function") return null;
    operations.push({ kind: "remove", parent: current, prior: currentChildren[index] });
  }
  for (let index = sharedLength; index < candidateChildren.length; index += 1) {
    if (typeof current.appendChild !== "function") return null;
    operations.push({ kind: "append", parent: current, next: candidateChildren[index] });
  }
  return operations;
}

function applyRenderedNodePatch(operations, undo) {
  for (const operation of operations) {
    if (operation.kind === "attribute") {
      const prior = operation.node.getAttribute(operation.name);
      undo.push(() => {
        if (prior === null) operation.node.removeAttribute(operation.name);
        else operation.node.setAttribute(operation.name, prior);
        if (operation.node.getAttribute(operation.name) !== prior) {
          throw new Error("game UI HUD attribute rollback did not restore its value");
        }
      });
      if (operation.value === null) operation.node.removeAttribute(operation.name);
      else operation.node.setAttribute(operation.name, operation.value);
    } else if (operation.kind === "value") {
      const prior = operation.node.nodeValue;
      undo.push(() => {
        operation.node.nodeValue = prior;
        if (operation.node.nodeValue !== prior) {
          throw new Error("game UI HUD text rollback did not restore its value");
        }
      });
      operation.node.nodeValue = operation.value;
    } else if (operation.kind === "replace") {
      const { parent, prior, next } = operation;
      // Keep the detached candidate tree intact for the final exact comparison.
      const replacement = cloneRenderedNode(next);
      const following = prior.nextSibling;
      undo.push(() => {
        if (prior.parentNode === parent) return;
        if (replacement.parentNode === parent) parent.replaceChild(prior, replacement);
        else parent.insertBefore(prior, following?.parentNode === parent ? following : null);
        if (prior.parentNode !== parent) {
          throw new Error("game UI HUD replacement rollback did not restore its node");
        }
      });
      parent.replaceChild(replacement, prior);
    } else if (operation.kind === "remove") {
      const { parent, prior } = operation;
      const next = prior.nextSibling;
      undo.push(() => {
        if (prior.parentNode === parent) return;
        parent.insertBefore(prior, next?.parentNode === parent ? next : null);
        if (prior.parentNode !== parent) {
          throw new Error("game UI HUD removal rollback did not restore its node");
        }
      });
      parent.removeChild(prior);
    } else {
      const { parent, next } = operation;
      // Appending a candidate node directly would detach it from the staged
      // tree before the post-commit equality check.
      const inserted = cloneRenderedNode(next);
      undo.push(() => {
        if (inserted.parentNode === parent) parent.removeChild(inserted);
        if (inserted.parentNode === parent) {
          throw new Error("game UI HUD insertion rollback did not remove its node");
        }
      });
      parent.appendChild(inserted);
    }
  }
}

function stage(layer) {
  return layer.ownerDocument.createElement("div");
}

export function mountGameUiProjection(value, readyPainterFactory = null) {
  const layers = ownRecord(value, ["combat", "effects", "feedback", "hud"],
    "game UI projection layers");
  for (const name of ["combat", "effects", "feedback", "hud"]) {
    layers[name] = checkedLayer(layers[name], `game UI ${name} layer`);
  }
  // The shipped browser entry resolves this optional capability from its
  // private per-Document preparation bank before calling the loop. Keeping
  // projection independent of the painter module preserves standalone and
  // headless import isolation.
  const painter = readyPainterFactory === null ? null : readyPainterFactory.create();
  let active = true;
  let poisoned = false;
  let lastTick = -1;
  let lastSequence = -1;
  let source = null;
  let lastChildren = Object.fromEntries(Object.keys(layers).map((name) => [name, []]));
  const projectFrame = (frame, handoff) => {
    if (!active) throw new RangeError("game UI projection is cleaned up");
    if (poisoned) throw new Error("game UI projection is poisoned");
    if (!frame || typeof frame !== "object" || !FRAMES.has(frame)) {
      throw new TypeError("game UI projection requires a canonical session frame");
    }
    if (handoff) {
      if (source === null || frame.source === source) {
        throw new RangeError("game UI session handoff requires a different mounted session");
      }
    } else {
      if (frame.tick < lastTick) throw new RangeError("game UI frame tick cannot move backward");
      if (source !== null && frame.source !== source) {
        throw new RangeError("game UI frame belongs to a different session");
      }
      if (frame.sequence <= lastSequence) {
        throw new RangeError("game UI frame sequence must advance strictly");
      }
    }

    const prior = Object.fromEntries(Object.entries(layers)
      .map(([name, layer]) => [name, children(layer)]));

    // Complete every projection against detached layers before the first
    // write to live DOM. A hostile document therefore cannot partially
    // advance any visible subsystem.
    const staged = {
      combat: stage(layers.combat),
      effects: stage(layers.effects),
      feedback: stage(layers.feedback),
      hud: stage(layers.hud),
    };
    bindCombatViewModel(staged.combat, frame.combat);
    bindCombatEffectsViewModel(staged.effects, frame.effects);
    const motion = FRAME_MOTION.get(frame);
    bindCombatMotion(staged.combat, staged.effects, motion.view);
    bindBriarAttackFrames(staged.combat, motion.view, motion.attacks);
    bindMatchFeedback(staged.feedback, frame.feedback);
    if (frame.feedback.overlay) {
      const panel = children(children(staged.feedback)[0]).find(node => node.className === "match-feedback__overlay");
      const age = FRAME_TERMINAL_TICK.get(frame) ?? GAME_UI_TERMINAL_PRESENTATION_TICKS;
      const remaining = (GAME_UI_TERMINAL_PRESENTATION_TICKS - age) / GAME_UI_TERMINAL_PRESENTATION_TICKS;
      panel.dataset.presentationTick = String(age);
      panel.style.setProperty("--terminal-scale", String(1 - remaining * .12));
      panel.style.setProperty("--terminal-lift", `${remaining * 28}px`);
      panel.style.setProperty("--terminal-opacity", String(1 - remaining * .55));
    }
    const hudFrame = layers.hud.ownerDocument.createElement("div");
    hudFrame.className = "game-ui-hud-frame";
    hudFrame.dataset.tick = String(frame.tick);
    hudFrame.innerHTML = getHudMarkup(frame.hud, {
      portraits: layers.hud.ownerDocument.body?.dataset?.appFrame === "true",
    });
    if (painter !== null) {
      const canvas = layers.hud.ownerDocument.createElement("canvas");
      canvas.className = "game-ui-hud-painter";
      canvas.dataset.ui = "hud-card-paint";
      canvas.dataset.painterRevision = "hud-card-painter-1";
      canvas.setAttribute("aria-hidden", "true");
      HUD_PAINTER_SURFACES.add(canvas);
      hudFrame.appendChild(canvas);
    }
    bindHudMotion(hudFrame, frame.hud, FRAME_HUD_RECEIPT.get(frame));
    staged.hud.replaceChildren(hudFrame);

    let paintTransaction = null;
    if (painter !== null) {
      let priorCanvas = null;
      if (prior.hud.length > 0) {
        const priorCanvases = Array.from(prior.hud[0]?.querySelectorAll?.("canvas") ?? []);
        if (priorCanvases.length !== 1 || !isHudPainterCanvas(priorCanvases[0]) ||
            priorCanvases[0].ownerDocument !== layers.hud.ownerDocument) {
          throw new TypeError("game UI prior HUD painter surface is not authentic");
        }
        priorCanvas = priorCanvases[0];
      }
      const candidateCanvas = hudFrame.querySelector?.('canvas[data-ui="hud-card-paint"]');
      paintTransaction = painter.stage(frame.hud, priorCanvas ?? candidateCanvas);
    }

    const committed = [];
    const inPlaceUndo = new Map();
    let paintAttempted = false;
    try {
      for (const name of ["combat", "effects", "feedback", "hud"]) {
        const candidate = children(staged[name]);
        const sameProjectedNode = name === "hud" ? sameHudRenderedNode : sameRenderedNode;
        // HUD cards sit on a fractionally scaled layer, so retain their parent
        // chain through state rewinds even when the projected attributes change.
        if (name === "hud" && prior[name].length === 1 && candidate.length === 1 &&
            compatibleRenderedNode(prior[name][0], candidate[0])) {
          const patch = planRenderedNodePatch(prior[name][0], candidate[0]);
          if (patch !== null) {
            if (patch.length === 0 && sameProjectedNode(prior[name][0], candidate[0])) continue;
            committed.push(name);
            const undo = [];
            inPlaceUndo.set(name, undo);
            applyRenderedNodePatch(patch, undo);
            if (!sameProjectedNode(prior[name][0], candidate[0])) {
              throw new Error("game UI hud layer did not match its in-place candidate");
            }
            continue;
          }
        }
        // Re-rendering a semantically identical projection should not detach
        // and reattach its painted subtree. A restored session may have a new
        // private source identity while its authenticated presentation bytes
        // remain identical, so handoff and ordinary projection share this
        // exact DOM equality check.
        if (sameChildren(prior[name], lastChildren[name]) &&
            prior[name].length === candidate.length &&
            prior[name].every((node, index) => sameProjectedNode(node, candidate[index]))) {
          continue;
        }
        // Register the layer before invoking hostile DOM. A conforming or
        // adversarial replaceChildren may mutate and then throw.
        committed.push(name);
        layers[name].replaceChildren(...candidate);
        if (!sameChildren(children(layers[name]), candidate)) {
          throw new Error(`game UI ${name} layer did not commit its candidate`);
        }
      }
      if (paintTransaction !== null) {
        paintAttempted = true;
        paintTransaction.commit();
      }
      paintTransaction?.finalize();
    } catch (error) {
      const rollbackErrors = [];
      if (paintAttempted) {
        try { paintTransaction.rollback(); }
        catch (caught) { rollbackErrors.push(caught); }
      }
      for (let index = committed.length - 1; index >= 0; index -= 1) {
        const name = committed[index];
        const inPlace = inPlaceUndo.get(name);
        if (inPlace !== undefined) {
          for (let undoIndex = inPlace.length - 1; undoIndex >= 0; undoIndex -= 1) {
            try { inPlace[undoIndex](); } catch (caught) { rollbackErrors.push(caught); }
          }
          if (!sameChildren(children(layers[name]), prior[name])) {
            rollbackErrors.push(new Error(`game UI ${name} did not restore its prior children`));
          }
          continue;
        }
        try {
          layers[name].replaceChildren(...prior[name]);
          if (!sameChildren(children(layers[name]), prior[name])) {
            throw new Error(`game UI ${name} layer did not restore its prior children`);
          }
        } catch (caught) {
          rollbackErrors.push(caught);
        }
      }
      if (rollbackErrors.length > 0) {
        poisoned = true;
        throw new AggregateError([error, ...rollbackErrors],
          "game UI projection is poisoned after rollback failure");
      }
      paintTransaction?.finalize();
      throw error;
    }
    lastTick = frame.tick;
    lastSequence = frame.sequence;
    source = frame.source;
    lastChildren = Object.fromEntries(Object.keys(layers)
      .map((name) => [name, children(layers[name])]));
    return frame;
  };
  return Object.freeze({
    canHandoff() { return active && !poisoned; },
    cleanup() {
      if (!active) return false;
      if (poisoned) {
        try { painter?.dispose(); } catch {}
        active = false;
        return true;
      }
      for (const name of ["hud", "feedback", "effects", "combat"]) {
        layers[name].replaceChildren();
      }
      painter?.dispose();
      active = false;
      return true;
    },
    project(frame) { return projectFrame(frame, false); },
    handoff(frame) { return projectFrame(frame, true); },
  });
}
