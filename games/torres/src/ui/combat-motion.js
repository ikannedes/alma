import { isAuthenticGameSessionProjectionSnapshot } from '../sim/game-session.js';
import { createCombatEffectsViewModel, isCanonicalCombatEffectsViewModel } from './combat-effects.js';
import {
  createCombatArt,
  COMBAT_ART_ARCHETYPES,
  updateCopperskiffBattleArt,
} from './combat-art.js';
import { updateSkymaulBattleArt } from './skymaul-battle-sprite.js';
import {
  createStormkiteBattleArt,
  updateStormkiteBattleArt,
} from './stormkite-battle-sprite.js';

const VIEWS = new WeakSet();
const KINDS = new Set(COMBAT_ART_ARCHETYPES);
const TOWER_IDS = ['south:central', 'south:lane:west', 'south:lane:east', 'north:central', 'north:lane:west', 'north:lane:east'];
const targetKey = id => Number.isSafeInteger(id) && id >= Number.MAX_SAFE_INTEGER - 5
  ? TOWER_IDS[id - (Number.MAX_SAFE_INTEGER - 5)] : id;

export function getCopperskiffFacingDirection(unit, target) {
  if (!unit || !unit.position || !['north', 'south'].includes(unit.side)) {
    throw new TypeError('Copperskiff facing requires a canonical unit position and side');
  }
  if (!target) return unit.side === 'north' ? 'south' : 'north';
  if (!target.position) throw new TypeError('Copperskiff target requires a canonical position');
  const dx = target.position.x - unit.position.x;
  const dy = target.position.y - unit.position.y;
  // combat-state maps y with ARENA_LENGTH - worldY, so positive world y is
  // screen-up/north. This is the same world-axis contract as its link arrows.
  if (Math.abs(dy) >= Math.abs(dx)) {
    if (dy > 0) return 'north';
    if (dy < 0) return 'south';
  }
  if (dx > 0) return 'east';
  if (dx < 0) return 'west';
  return unit.side === 'north' ? 'south' : 'north';
}

export function getCopperskiffSpriteAction(pose) {
  if (typeof pose !== 'string') throw new TypeError('Copperskiff pose must be a string');
  return pose === 'attack' || pose === 'recoil' ? 'contact' : 'idle';
}

export function getSkymaulSpriteAction(pose) {
  if (typeof pose !== 'string') throw new TypeError('Skymaul pose must be a string');
  if (pose === 'move') return 'walk';
  return pose === 'attack' || pose === 'recoil' ? 'contact' : 'idle';
}

function currentStormkiteContacts(events, impacts, tick, battle) {
  const sourceIds = new Set(battle.units
    .filter((unit) => unit.cardId === 'stormkite')
    .map(({ id }) => id));
  if (sourceIds.size === 0) return sourceIds;
  const roots = new Map(events
    .filter((event) => event.phase === 'open' && event.parentId === null &&
      event.type === 'projectile')
    .map((event) => [event.rootId, event]));
  const contacts = new Set();
  for (const event of events) {
    if (event.phase !== 'contact' || event.payload.status !== 'contact' ||
        tick === 0 || event.tick !== tick - 1) continue;
    const root = roots.get(event.rootId);
    const sourceId = root?.type === 'projectile' ? root.payload.sourceId : null;
    if (sourceIds.has(sourceId)) contacts.add(sourceId);
  }
  for (const impact of impacts) {
    if (impact.kind !== 'contact' || typeof impact.key !== 'string') continue;
    const match = /^stormkite-chain-hop:([1-9]\d*):/u.exec(impact.key);
    if (match === null) continue;
    const sourceId = Number(match[1]);
    if (Number.isSafeInteger(sourceId) && String(sourceId) === match[1] &&
        sourceIds.has(sourceId)) contacts.add(sourceId);
  }
  return contacts;
}

// Ordinary default-deck cycles only. These local cycle deadlines are not an
// authority for status-modified witness attacks or projectile contact timing.
export function createCombatMotionView(snapshot, effects) {
  if (!isAuthenticGameSessionProjectionSnapshot(snapshot)) {
    throw new TypeError('combat motion requires an authentic projection snapshot');
  }
  const { battle, tick } = snapshot.state;
  effects ??= createCombatEffectsViewModel(snapshot.combatEffectFeed, tick);
  if (!isCanonicalCombatEffectsViewModel(effects)) throw new TypeError('combat motion effects are not canonical');
  if (effects.tick !== tick) throw new TypeError('combat motion effect tick mismatch');
  const targets = new Map([...battle.towers, ...battle.units].map(record => [record.id, record]));
  const stormkiteContacts = currentStormkiteContacts(effects.events, effects.impacts, tick, battle);
  const recentHits = new Map();
  for (const event of effects.events) {
    if (event.phase === 'damage' && tick >= event.tick && tick - event.tick < 6) {
      recentHits.set(event.payload.targetId, event.tick);
    }
  }
  const poses = [];
  const contacts = [];
  for (const unit of battle.units) {
    if (!unit.alive || unit.hitpoints <= 0 || !KINDS.has(unit.archetypeId)) continue;
    const stormkite = unit.cardId === 'stormkite';
    const cycle = unit.attack;
    const target = targets.get(targetKey(cycle.targetId));
    const age = tick - unit.spawnedAt;
    const lastStrike = unit.spawnedAt + cycle.nextAttackTick - cycle.config.hitSpeedTicks;
    const strikeAge = tick - lastStrike;
    const direction = target ? Math.sign(target.position.x - unit.position.x) || (unit.side === 'north' ? 1 : -1) : 0;
    let pose = 'idle';
    let tilt = 0;
    let lift = 0;
    let scale = 100;
    if (!stormkite) {
      if (cycle.phase === 'deploying' && age >= 0 && age < cycle.config.deployTicks) {
        pose = 'deploy';
        scale = 65 + Math.floor(35 * age / Math.max(1, cycle.config.deployTicks));
      } else if (!cycle.statusWork && cycle.phase === 'cycling' && cycle.attackSequence > 0 &&
          Number.isSafeInteger(cycle.nextAttackTick) && lastStrike >= unit.spawnedAt &&
          strikeAge >= 0 && strikeAge < 8 && target) {
        pose = 'attack'; tilt = direction * (28 - strikeAge * 3);
        if (unit.delivery === 'melee') contacts.push(Object.freeze({
          id: `${unit.id}:${cycle.attackSequence}`, targetId: target.id,
          tick: lastStrike, x: target.position.x, y: target.position.y, age: strikeAge,
        }));
      } else if (!cycle.statusWork && cycle.phase === 'winding' && target &&
          cycle.nextAttackTick - cycle.nextTick >= 0 && cycle.nextAttackTick - cycle.nextTick < 10) {
        pose = 'anticipate'; tilt = -direction * 14;
      } else if (cycle.phase === 'idle' && unit.movement.speed > 0 && unit.movement.segmentLength > 0 &&
          unit.movement.segmentProgress > 0 && unit.movement.segmentProgress < unit.movement.segmentLength) {
        pose = 'move';
        const stride = Math.floor(unit.movement.segmentProgress / 125) % 4;
        tilt = [0, -5, 0, 5][stride]; lift = [0, -2, 0, -2][stride];
      }
      if (pose === 'attack' && strikeAge >= 4) {
        pose = 'recoil'; tilt = -direction * (8 - strikeAge) * 2;
      }
    }
    const hitAge = tick - recentHits.get(unit.id);
    const hit = Number.isFinite(hitAge);
    if (hit && pose !== 'deploy') { lift -= (6 - hitAge) / 2; }
    const copperskiff = unit.archetypeId === 'copperskiff';
    const skymaul = unit.archetypeId === 'skymaul';
    const spritePose = getCopperskiffSpriteAction(pose);
    poses.push(Object.freeze({
      id: unit.id,
      pose,
      tilt,
      lift,
      scale,
      hit,
      ...(copperskiff ? {
        spriteAction: spritePose,
        spriteDirection: getCopperskiffFacingDirection(unit, target),
      } : {}),
      ...(skymaul ? {
        spriteAction: getSkymaulSpriteAction(pose),
        spriteDirection: getCopperskiffFacingDirection(unit, target),
      } : {}),
      ...(stormkite ? {
        spriteAction: stormkiteContacts.has(unit.id) ? 'contact' : 'idle',
        spriteDirection: getCopperskiffFacingDirection(unit, target),
      } : {}),
    }));
  }
  const residualsByPoint = new Map();
  const sourceEvents = new Map(snapshot.combatEffectFeed.records.map(event => [event.eventId, event]));
  const roots = new Map(effects.events.filter(event => event.phase === "open" && event.parentId === null).map(event => [event.rootId, event]));
  for (const event of effects.events) {
    const age = tick - event.tick;
    if (age < 1 || age >= 8 || !['contact', 'impact'].includes(event.phase)) continue;
    if (event.phase === 'contact' && event.payload.status !== 'contact') continue;
    const point = event.payload.point ?? event.payload.center;
    if (!point) continue;
    if (JSON.stringify(sourceEvents.get(event.eventId)) !== JSON.stringify(event)) throw new TypeError('combat motion impact source mismatch');
    const key = `${event.rootId}:${point.xNumerator}:${point.yNumerator}:${point.denominator}`;
    residualsByPoint.set(key, Object.freeze({ key, tick: event.tick, point, kind: roots.get(event.rootId)?.payload.direction ?? event.type }));
  }
  const residuals = Object.freeze([...residualsByPoint.values()]);
  const deathsById = new Map();
  for (const event of effects.events) {
    if (event.phase !== 'death' || tick - event.tick < 0 || tick - event.tick >= 18) continue;
    const unit = targets.get(event.payload.targetId);
    if (!unit || unit.alive || unit.hitpoints !== 0 || !KINDS.has(unit.archetypeId)) continue;
    const source = sourceEvents.get(event.eventId);
    if (!source || JSON.stringify(source) !== JSON.stringify(event)) throw new TypeError('combat motion death source mismatch');
    if (deathsById.has(unit.id)) continue;
    deathsById.set(unit.id, Object.freeze({ id: unit.id, kind: unit.archetypeId,
      side: unit.side, layer: unit.layer, x: unit.position.x, y: unit.position.y,
      ...(unit.cardId === 'stormkite' ? {
        spriteDirection: getCopperskiffFacingDirection(unit,
          targets.get(targetKey(unit.attack.targetId))),
      } : {}),
      tick: event.tick, age: tick - event.tick }));
  }
  const deaths = Object.freeze([...deathsById.values()].sort((a, b) => a.id - b.id));
  const view = Object.freeze({ residuals, deaths, tick, poses: Object.freeze(poses), contacts: Object.freeze(contacts) });
  VIEWS.add(view);
  return view;
}

export function bindCombatMotion(combat, effects, view) {
  if (!VIEWS.has(view)) throw new TypeError('combat motion view is not canonical');
  const children = node => Array.from(node.childNodes ?? node.children ?? []);
  const frame = children(combat)[0];
  const reducedMotion = combat.ownerDocument?.defaultView?.matchMedia?.(
    '(prefers-reduced-motion: reduce)',
  )?.matches === true;
  const byId = new Map(view.poses.map(pose => [String(pose.id), pose]));
  for (const node of children(frame)) {
    const pose = byId.get(node.dataset?.combatId);
    if (!pose) continue;
    node.dataset.pose = pose.pose;
    node.dataset.hit = String(pose.hit);
    node.style.setProperty('--pose-tilt', `${pose.tilt}deg`);
    node.style.setProperty('--pose-lift', `${pose.lift}px`);
    node.style.setProperty('--pose-scale', String(pose.scale / 100));
    const copperskiff = children(node).find((child) => child.dataset?.artId === 'copperskiff');
    if (copperskiff) {
      updateCopperskiffBattleArt(copperskiff, {
        action: pose.spriteAction,
        direction: pose.spriteDirection,
        reducedMotion,
        side: node.dataset.side,
        tick: view.tick,
      });
    }
    const skymaul = children(node).find((child) => child.dataset?.artId === 'skymaul');
    if (skymaul) {
      updateSkymaulBattleArt(skymaul, {
        action: pose.spriteAction,
        direction: pose.spriteDirection,
        reducedMotion,
        side: node.dataset.side,
        tick: view.tick,
      });
    }
    const stormkite = children(node).find((child) => child.dataset?.artId === 'stormkite');
    if (stormkite) {
      updateStormkiteBattleArt(stormkite, {
        action: pose.spriteAction,
        direction: pose.spriteDirection,
        reducedMotion,
        side: node.dataset.side,
        tick: view.tick,
      });
    }
  }
  const effectFrame = children(effects)[0];
  for (const residual of view.residuals) {
    const node = effects.ownerDocument.createElement('span');
    node.className = 'combat-effect-impact';
    node.dataset.residualImpact = residual.key;
    node.dataset.kind = residual.kind;
    node.dataset.impactTick = String(residual.tick);
    node.setAttribute('aria-hidden', 'true');
    node.style.setProperty('--effect-den', residual.point.denominator);
    node.style.setProperty('--effect-x-num', residual.point.xNumerator);
    node.style.setProperty('--effect-y-num', (32000n * BigInt(residual.point.denominator) - BigInt(residual.point.yNumerator)).toString());
    effectFrame.appendChild(node);
  }
  for (const death of view.deaths) {
    const node = effects.ownerDocument.createElement('span');
    node.className = 'combat-death-remnant';
    node.dataset.deathId = String(death.id);
    node.dataset.deathTick = String(death.tick);
    node.dataset.kind = death.kind;
    node.dataset.side = death.side;
    node.setAttribute('aria-hidden', 'true');
    node.style.setProperty('--combat-x', String(death.x));
    node.style.setProperty('--combat-y', String(32000 - death.y));
    node.style.setProperty('--death-opacity', String((18 - death.age) / 18));
    node.style.setProperty('--death-tilt', `${(death.side === 'north' ? 1 : -1) * (65 + death.age)}deg`);
    node.style.setProperty('--death-drift', `${death.age / 2}px`);
    const art = death.kind === 'stormkite'
      ? createStormkiteBattleArt(effects.ownerDocument, {
        action: 'idle',
        bodyCssPixels: 13,
        direction: death.spriteDirection,
        frameScale: 1,
        reducedMotion,
        side: death.side,
        tick: view.tick,
      })
      : createCombatArt(effects.ownerDocument, death.kind, death.side, death.layer);
    node.appendChild(art);
    effectFrame.appendChild(node);
  }
  for (const contact of view.contacts) {
    const node = effects.ownerDocument.createElement('span');
    node.className = 'combat-melee-contact';
    node.dataset.contactId = contact.id;
    node.dataset.contactTick = String(contact.tick);
    node.dataset.targetId = String(contact.targetId);
    node.style.setProperty('--combat-x', String(contact.x));
    node.style.setProperty('--combat-y', String(32000 - contact.y));
    node.style.setProperty('--contact-scale', String((12 - contact.age) / 12));
    effectFrame.appendChild(node);
  }
}

export const COMBAT_MOTION_STYLE = `.combat-marker[data-hit="true"] .combat-art{filter:brightness(1.65)}.combat-marker[data-pose] .combat-art{transform:translateY(var(--pose-lift)) rotate(var(--pose-tilt)) scale(var(--pose-scale));transform-origin:50% 80%}.combat-marker[data-pose="deploy"]::after{content:"";position:absolute;inset:45% -10% -5%;border:2px solid #F4EBD6;border-radius:50%;opacity:.65}.combat-melee-contact{position:absolute;left:calc(var(--combat-x)*100%/18000);top:calc(var(--combat-y)*100%/32000);width:38px;height:38px;translate:-50% -50%;transform:scale(var(--contact-scale));background:#F4EBD6;filter:drop-shadow(0 0 3px #E9A83A);clip-path:polygon(50% 0,60% 32%,90% 10%,72% 43%,100% 50%,70% 60%,90% 90%,59% 72%,50% 100%,39% 70%,10% 90%,28% 58%,0 50%,29% 40%,10% 10%,40% 28%)}@media(prefers-reduced-motion:reduce){.combat-marker[data-pose] .combat-art{transform:none}.combat-melee-contact{transform:none}.combat-marker[data-pose="deploy"]::after{opacity:1}}.combat-marker[data-kind="copperskiff"][data-pose] .combat-art{transform:none;transform-origin:50% 84.375%}.combat-marker[data-kind="stormkite"][data-pose] .combat-art{transform:none;transform-origin:50% 84.375%}`;

// Corpse art is presentation only: no combatId, targetId, health or hit region.
const DEATH_STYLE = `.combat-death-remnant{position:absolute;pointer-events:none;left:calc(var(--combat-x)*100%/18000);top:calc(var(--combat-y)*100%/32000);width:6.2%;aspect-ratio:1;translate:-50% -50%;opacity:var(--death-opacity)}.combat-death-remnant .combat-art{transform:rotate(var(--death-tilt)) scale(.8);filter:saturate(.65)}.combat-death-remnant::after{content:"";position:absolute;inset:-4px;transform:translateY(calc(-1 * var(--death-drift)));background:#E9A83A;clip-path:polygon(12% 25%,18% 15%,24% 25%,18% 35%,12% 25%,70% 5%,75% 0,80% 5%,75% 10%,70% 5%,85% 65%,92% 58%,98% 65%,92% 72%,85% 65%)}.combat-death-remnant[data-side="south"]::after{background:#DCEDE9}@media(prefers-reduced-motion:reduce){.combat-death-remnant .combat-art{transform:rotate(75deg) scale(.8)}.combat-death-remnant::after{transform:none}.combat-death-remnant{opacity:.8}}`;
export const COMBAT_DEATH_STYLE = DEATH_STYLE;
