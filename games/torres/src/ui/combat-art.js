// Original Rivermark combat artwork, authored in repository; CC0-1.0.
// Vector paths are bounded to a 64 × 64 canvas. No external/reference assets.
const INK = '#191D22';
const BONE = '#F4EBD6';
const COPPER = '#E9A83A';
const WOOD = '#4A332A';
const LEAF = '#5C8A46';
const STONE = '#9BA5A2';
const SHALE = '#65716F';
const BRIAR_PAINTED_ATLAS = Object.freeze({
  cellSize: 313.5,
  height: 1254,
  image: new URL("../../public/assets/briar-runner-painted-sheet.png", import.meta.url).href,
  windowSize: 220,
  windowX: 46.75,
  windowYByDirection: Object.freeze({ north: 72, east: 62, south: 47, west: 14 }),
  width: 1254,
});
const EMBER_BASIN_BATTLE_IMAGE = new URL(
  "../../public/assets/ember-basin-battle-sprite.webp",
  import.meta.url,
).href;
const BURIED_COIL_HIDDEN_IMAGE = new URL(
  "../../public/assets/buried-coil-hidden.webp",
  import.meta.url,
).href;
const BURIED_COIL_REVEALED_IMAGE = new URL(
  "../../public/assets/buried-coil-revealed.svg",
  import.meta.url,
).href;
const KILNKEEPER_BATTLE_IMAGE = new URL(
  "../../public/assets/kilnkeeper-battle-sprite.webp",
  import.meta.url,
).href;
const SPRITE_DIRECTIONS = Object.freeze(['north', 'east', 'south', 'west']);
const COPPERSKIFF_FACING_DIRECTIONS = Object.freeze(['east', 'north', 'south', 'west']);
const COPPERSKIFF_ACTIONS = Object.freeze(['idle', 'contact']);
const COPPERSKIFF_ATLAS = Object.freeze({
  cellSize: 64,
  columns: Object.freeze({ east: 0, north: 1, south: 2, west: 3 }),
  height: 256,
  image: new URL("../../public/assets/copperskiff-battle-sprite.png", import.meta.url).href,
  rows: Object.freeze({
    ember: Object.freeze({ idle: 0, contact: 1 }),
    river: Object.freeze({ idle: 2, contact: 3 }),
  }),
  width: 256,
  pivot: Object.freeze({ x: 32, y: 54 }),
});
const shapes = {
  coilblade: [
    ['M20 43 18 57 27 57 31 43M36 43 38 57 47 57 44 42', WOOD],
    ['M18 24 42 24 48 44 15 44Z', 'team'],
    ['M24 13 37 13 41 26 22 26Z', BONE],
    ['M28 13 28 6 33 10 37 6 36 13', COPPER],
    ['M45 39 48 17 58 8 55 29 49 40Z', BONE],
    ['M41 39 53 42', COPPER],
    ['M25 21 36 21', INK],
  ],
  mossguard: [
    ['M16 42 13 56 25 56 30 43M35 43 39 56 50 56 46 41', WOOD],
    ['M14 24 40 19 49 43 19 48Z', LEAF],
    ['M22 14 36 10 43 22 31 29 20 24Z', WOOD],
    ['M21 16 15 8 27 12 32 4 35 13 45 9 40 20', LEAF],
    ['M9 26 27 29 25 49 16 54 7 44Z', 'team'],
    ['M16 34 16 45M11 38 21 38', BONE],
    ['M42 29 57 23 59 35 45 39Z', WOOD],
  ],
  brassbolt: [
    ['M24 42 20 57 29 57 34 43 37 57 45 57 40 41', WOOD],
    ['M22 26 38 24 43 44 22 45Z', 'team'],
    ['M23 14 38 14 38 27 25 27Z', BONE],
    ['M20 15 24 9 39 9 43 17Z', COPPER],
    ['M37 29 53 27 53 9 60 9 60 38 38 40Z', COPPER],
    ['M51 10 61 10M52 17 60 17M28 21 35 21', INK],
  ],
  reedsting: [
    ['M26 42 19 56 26 58 33 47 41 57 47 53 38 41', WOOD],
    ['M22 26 35 22 43 44 19 45Z', 'team'],
    ['M21 21 28 9 39 21 35 30 25 29Z', LEAF],
    ['M26 22 35 22', BONE],
    ['M45 7Q65 29 44 53L48 29Z', COPPER],
    ['M47 8 46 52M35 31 61 27M57 24 62 27 58 31', BONE],
  ],
  'briar-runner': [
    ['M23 41 15 54 24 57 31 45 42 55 49 50 37 38', WOOD],
    ['M20 25 36 22 43 42 21 44Z', 'team'],
    ['M19 24 16 13 24 17 28 8 33 17 44 15 39 27Z', LEAF],
    ['M26 22 34 22', BONE],
    ['M44 38 53 14 57 24 49 41Z', BONE],
  ],
  'briar-darter': [
    ['M22 44 20 55 28 55 33 44 38 55 46 55 40 43', WOOD],
    ['M20 28 35 23 43 43 20 45Z', 'team'],
    ['M22 26 18 16 26 18 34 8 37 18 44 21 35 29Z', LEAF],
    ['M32 30 57 15 61 20 35 36Z', WOOD],
    ['M52 18 56 23', COPPER],
    ['M23 23 29 23', BONE],
  ],
  cinderling: [
    ['M20 43 16 52 26 54 33 45 39 54 49 50 43 40', WOOD],
    ['M16 34 23 21 21 12 31 19 35 6 43 21 51 27 48 43 33 49 20 44Z', '#C6452E'],
    ['M23 35 30 28 34 17 40 29 42 39 33 44Z', COPPER],
    ['M18 39 47 39 44 46 23 48Z', 'team'],
    ['M26 31 29 31M37 31 40 31', INK],
  ],
  thornscout: [
    ['M21 42 17 56 27 57 32 45 39 56 49 53 43 41', WOOD],
    ['M17 25 42 23 47 45 19 46Z', 'team'],
    ['M22 22 20 11 28 16 33 7 37 17 44 13 41 25 29 30Z', LEAF],
    ['M21 29 43 28M25 37 34 37', BONE],
    ['M45 38 53 21 59 14 56 31 48 43Z', COPPER],
    ['M53 19 61 11', BONE],
  ],
  forgeguard: [
    ['M19 41 14 56 26 57 31 46 39 56 51 54 45 40', WOOD],
    ['M12 25 21 18 30 21 35 15 45 20 52 28 49 46 18 47 10 38Z', COPPER],
    ['M16 28 26 25 31 31 29 42 19 44 13 38Z', 'team'],
    ['M42 27 52 24 58 31 55 40 46 42 40 36Z', BONE],
    ['M22 20 24 12 30 17 35 9 41 17 47 14 48 24', WOOD],
    ['M25 31 28 31M47 32 50 32', INK],
    ['M25 47 43 47 47 52 21 53Z', SHALE],
  ],
  copperskiff: [
    ['M17 31 46 31 41 47 30 53 20 45Z', COPPER],
    ['M20 34 42 34 39 43 24 43Z', 'team'],
    ['M29 13 34 13 34 33 29 33Z', WOOD],
    ['M4 18Q17 8 31 17Q47 6 60 16L36 23 26 23Z', BONE],
    ['M27 43 35 43 35 58 27 58Z', WOOD],
    ['M24 29 27 22 37 22 40 30Z', COPPER],
  ],
  skymaul: [
    ['M21 29 41 29 46 43 32 52 18 42Z', 'team'],
    ['M22 28 15 10 4 17 13 34ZM40 28 49 8 61 16 51 34Z', '#5B4B8A'],
    ['M24 20 39 20 41 31 22 31Z', BONE],
    ['M30 43 34 43 36 59 29 59Z', WOOD],
    ['M19 51 46 51 49 61 17 61Z', COPPER],
    ['M27 26 36 26', INK],
  ],
  stonehauler: [
    ['M18 43 14 56 26 57 32 48 39 57 51 55 46 41', SHALE],
    ['M12 24 20 15 28 18 34 9 44 14 53 22 55 36 48 47 18 47 9 38Z', STONE],
    ['M12 25 5 32 8 45 18 46 24 35 21 24Z', SHALE],
    ['M44 23 52 18 60 23 59 38 51 44 45 37Z', SHALE],
    ['M23 14 32 9 41 14 42 25 35 31 24 26Z', '#B9C0B6'],
    ['M18 27 26 30 23 37 18 42 12 40 14 32Z', 'team'],
    ['M39 27 46 23 51 28 49 36 43 39 39 34Z', COPPER],
    ['M27 22 30 22M36 21 39 21', INK],
    ['M28 36 39 36 42 42 24 42Z', WOOD],
    ['M28 56 39 56', BONE],
  ],
  ironroot: [
    ['M17 43 12 57 25 59 32 47 40 59 53 56 46 42', WOOD],
    ['M10 24 19 17 27 20 33 10 40 18 49 18 56 27 53 45 14 46Z', SHALE],
    ['M13 27 5 28 3 39 11 46 22 41 21 29Z', STONE],
    ['M44 29 53 22 61 28 60 40 51 46 43 40Z', WOOD],
    ['M19 18 17 9 25 14 31 5 37 14 47 10 46 22 33 27Z', LEAF],
    ['M23 28 29 28M39 28 45 28', COPPER],
    ['M20 34 31 38 43 33 41 43 22 44Z', 'team'],
    ['M27 48 38 48 41 53 24 54Z', BONE],
  ],
  'bulwark-needle': [
    ['M8 48Q31 39 56 48L53 54Q31 59 10 54Z', '#344B43'],
    ['M12 40 20 33 44 33 52 40 49 51 15 51Z', SHALE],
    ['M17 36 20 22 27 18 40 18 47 24 49 38 44 45 20 45Z', STONE],
    ['M20 23 31 14 43 22 41 30 22 30Z', WOOD],
    ['M29 34 32 5 35 34Z', COPPER],
    ['M27 28 15 15 20 36 27 39Z', BONE],
    ['M38 28 49 14 45 36 38 39Z', BONE],
    ['M16 40 25 36 28 45 20 48ZM47 40 39 36 36 45 44 48Z', WOOD],
    ['M25 39 39 39 41 47 23 47Z', 'team'],
  ],
};
for (const paths of Object.values(shapes)) {
  for (const path of paths) Object.freeze(path);
  Object.freeze(paths);
}
export const COMBAT_ART_ARCHETYPES = Object.freeze([...Object.keys(shapes), 'kilnkeeper', 'stormkite']);
export const COMBAT_STRUCTURE_ART_IDS = Object.freeze(['bulwark-needle', 'buried-coil', 'ember-basin']);
Object.freeze(shapes);

export function getBriarRunnerPaintedFrameTransform({
  action, direction, reducedMotion = false, tick,
} = {}) {
  if (!['walk', 'attack'].includes(action)) throw new RangeError('Briar Runner action must be walk or attack');
  if (!SPRITE_DIRECTIONS.includes(direction)) throw new RangeError('Briar Runner direction must be cardinal');
  if (!Number.isSafeInteger(tick) || tick < 0) throw new RangeError('Briar Runner tick must be a non-negative safe integer');
  if (typeof reducedMotion !== 'boolean') throw new TypeError('Briar Runner reducedMotion must be a boolean');

  const frame = reducedMotion ? 0 : Math.floor(tick / (action === 'walk' ? 5 : 3)) % 2;
  const row = SPRITE_DIRECTIONS.indexOf(direction);
  const column = (action === 'walk' ? 0 : 2) + frame;
  const sourceX = column * BRIAR_PAINTED_ATLAS.cellSize + BRIAR_PAINTED_ATLAS.windowX;
  const sourceY = row * BRIAR_PAINTED_ATLAS.cellSize + BRIAR_PAINTED_ATLAS.windowYByDirection[direction];
  const positionDenominator = BRIAR_PAINTED_ATLAS.width - BRIAR_PAINTED_ATLAS.windowSize;
  const percent = (value) => `${(value / positionDenominator) * 100}%`;
  const backgroundSizePercent = (BRIAR_PAINTED_ATLAS.width / BRIAR_PAINTED_ATLAS.windowSize) * 100;
  return Object.freeze({
    action,
    backgroundPosition: `${percent(sourceX)} ${percent(sourceY)}`,
    backgroundSize: `${backgroundSizePercent}% ${backgroundSizePercent}%`,
    column,
    direction,
    frame,
    id: `briar-${action}-${direction}-${frame}`,
    row,
    source: Object.freeze({
      height: BRIAR_PAINTED_ATLAS.windowSize,
      width: BRIAR_PAINTED_ATLAS.windowSize,
      x: sourceX,
      y: sourceY,
    }),
  });
}

export function createBriarRunnerPaintedArt(document, {
  action = 'walk', direction, reducedMotion = false, side, tick,
} = {}) {
  if (!['walk', 'attack'].includes(action)) throw new RangeError('Briar Runner action must be walk or attack');
  if (!SPRITE_DIRECTIONS.includes(direction)) throw new RangeError('Briar Runner direction must be cardinal');
  if (side !== 'north' && side !== 'south') throw new RangeError('Briar Runner side must be north or south');
  const transform = getBriarRunnerPaintedFrameTransform({
    action, direction, reducedMotion, tick,
  });
  const { x: sourceX, y: sourceY } = transform.source;
  const create = typeof document?.createElementNS === 'function'
    ? (tag) => document.createElementNS('http://www.w3.org/2000/svg', tag)
    : (tag) => document.createElement(tag);
  const svg = create('svg');
  svg.setAttribute('viewBox', `${sourceX} ${sourceY} ${BRIAR_PAINTED_ATLAS.windowSize} ${BRIAR_PAINTED_ATLAS.windowSize}`);
  svg.setAttribute('class', 'combat-art');
  svg.setAttribute('aria-hidden', 'true');
  svg.dataset.artId = 'briar-runner';
  svg.dataset.spriteAction = action;
  svg.dataset.spriteDirection = direction;
  svg.dataset.spriteFrame = transform.id;
  svg.dataset.spriteSide = side;
  svg.dataset.simulationTick = String(tick);
  svg.dataset.reducedMotion = String(reducedMotion);

  const footShadow = create('ellipse');
  footShadow.setAttribute('cx', String(sourceX + 110));
  footShadow.setAttribute('cy', String(sourceY + 190));
  footShadow.setAttribute('rx', '87');
  footShadow.setAttribute('ry', '28');
  footShadow.setAttribute('fill', INK);
  footShadow.setAttribute('aria-hidden', 'true');
  svg.appendChild(footShadow);

  const teamFootring = create('rect');
  teamFootring.dataset.teamColor = side;
  teamFootring.setAttribute('x', String(sourceX + 3));
  teamFootring.setAttribute('y', String(sourceY + 154));
  teamFootring.setAttribute('width', '214');
  teamFootring.setAttribute('height', '72');
  teamFootring.setAttribute('rx', '36');
  teamFootring.setAttribute('fill', side === 'north' ? '#C6452E' : '#2E7F86');
  teamFootring.setAttribute('stroke', BONE);
  teamFootring.setAttribute('stroke-width', '5');
  teamFootring.setAttribute('aria-hidden', 'true');

  const image = create('image');
  image.setAttribute('href', BRIAR_PAINTED_ATLAS.image);
  image.setAttribute('x', '0');
  image.setAttribute('y', '0');
  image.setAttribute('width', String(BRIAR_PAINTED_ATLAS.width));
  image.setAttribute('height', String(BRIAR_PAINTED_ATLAS.height));
  image.setAttribute('preserveAspectRatio', 'none');
  svg.appendChild(image);
  // Keep the opaque team identifier in front of the painted atlas so its color
  // remains visible after the real playfield scales a unit down to phone size.
  svg.appendChild(teamFootring);
  return svg;
}

/** Resolve one fixed 64px atlas window from canonical pose state. */
export function getCopperskiffBattleFrame({
  action, direction, reducedMotion = false, side, tick,
} = {}) {
  if (!COPPERSKIFF_ACTIONS.includes(action)) {
    throw new RangeError('Copperskiff action must be idle or contact');
  }
  if (!COPPERSKIFF_FACING_DIRECTIONS.includes(direction)) {
    throw new RangeError('Copperskiff direction must be actor-facing cardinal');
  }
  if (side !== 'north' && side !== 'south') {
    throw new RangeError('Copperskiff side must be north or south');
  }
  if (!Number.isSafeInteger(tick) || tick < 0) {
    throw new RangeError('Copperskiff tick must be a non-negative safe integer');
  }
  if (typeof reducedMotion !== 'boolean') {
    throw new TypeError('Copperskiff reducedMotion must be a boolean');
  }

  // Frozen model frames are already static poses; reduced motion preserves the
  // state cue and merely avoids any CSS displacement or frame cycling.
  const team = side === 'north' ? 'ember' : 'river';
  const row = COPPERSKIFF_ATLAS.rows[team][action];
  const column = COPPERSKIFF_ATLAS.columns[direction];
  const x = column * COPPERSKIFF_ATLAS.cellSize;
  const y = row * COPPERSKIFF_ATLAS.cellSize;
  return Object.freeze({
    action,
    column,
    direction,
    id: `copperskiff-${team}-${direction}-${action}`,
    reducedMotion,
    row,
    side,
    source: Object.freeze({
      height: COPPERSKIFF_ATLAS.cellSize,
      width: COPPERSKIFF_ATLAS.cellSize,
      x,
      y,
    }),
    team,
    tick,
    viewBox: `${x} ${y} ${COPPERSKIFF_ATLAS.cellSize} ${COPPERSKIFF_ATLAS.cellSize}`,
  });
}

/** Create a sprite window whose common pivot stays on the canonical marker. */
export function createCopperskiffBattleArt(document, {
  action = 'idle',
  bodyCssPixels = 13,
  direction,
  frameScale = 1,
  reducedMotion = false,
  side,
  tick,
} = {}) {
  if (typeof document?.createElementNS !== 'function' || typeof document?.createElement !== 'function') {
    throw new TypeError('Copperskiff battle art requires a DOM document');
  }
  if ((bodyCssPixels !== 13 && bodyCssPixels !== 26) ||
      !Number.isFinite(frameScale) || frameScale <= 0 || frameScale > 8) {
    throw new TypeError('Copperskiff presentation context is invalid');
  }
  const frame = getCopperskiffBattleFrame({
    action, direction, reducedMotion, side, tick,
  });
  const create = (tag) => document.createElementNS('http://www.w3.org/2000/svg', tag);
  const svg = create('svg');
  svg.setAttribute('viewBox', frame.viewBox);
  svg.setAttribute('class', 'combat-art combat-art--copperskiff');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.dataset.artId = 'copperskiff';
  svg.dataset.spriteAction = frame.action;
  svg.dataset.spriteDirection = frame.direction;
  svg.dataset.spriteFrame = frame.id;
  svg.dataset.spriteSide = frame.side;
  svg.dataset.spriteTeam = frame.team;
  svg.dataset.simulationTick = String(frame.tick);
  svg.dataset.reducedMotion = String(frame.reducedMotion);
  svg.dataset.pivot = `${COPPERSKIFF_ATLAS.pivot.x}:${COPPERSKIFF_ATLAS.pivot.y}`;
  svg.dataset.bodyCssPixels = String(bodyCssPixels);

  const image = create('image');
  image.dataset.part = 'atlas';
  image.setAttribute('href', COPPERSKIFF_ATLAS.image);
  image.setAttribute('x', '0');
  image.setAttribute('y', '0');
  image.setAttribute('width', String(COPPERSKIFF_ATLAS.width));
  image.setAttribute('height', String(COPPERSKIFF_ATLAS.height));
  image.setAttribute('preserveAspectRatio', 'none');
  svg.appendChild(image);

  // This is the same one-time iframe compensation used by the other battle
  // sprites. The outer canonical marker (and its health bar) keeps its size.
  const frameCssPixels = COPPERSKIFF_ATLAS.cellSize * bodyCssPixels / 13 / frameScale;
  svg.style.position = 'absolute';
  svg.style.left = '50%';
  svg.style.top = '50%';
  svg.style.translate = '-50% -84.375%';
  svg.style.pointerEvents = 'none';
  svg.style.width = `${frameCssPixels}px`;
  svg.style.height = `${frameCssPixels}px`;
  return svg;
}

/** Move the fixed atlas window without changing its pixel or anchor mapping. */
export function updateCopperskiffBattleArt(art, {
  action, direction, reducedMotion = false, side, tick,
} = {}) {
  if (!art || art.dataset?.artId !== 'copperskiff' ||
      typeof art.setAttribute !== 'function') {
    throw new TypeError('Copperskiff battle art node is invalid');
  }
  const frame = getCopperskiffBattleFrame({
    action, direction, reducedMotion, side, tick,
  });
  art.setAttribute('viewBox', frame.viewBox);
  art.dataset.spriteAction = frame.action;
  art.dataset.spriteDirection = frame.direction;
  art.dataset.spriteFrame = frame.id;
  art.dataset.spriteSide = frame.side;
  art.dataset.spriteTeam = frame.team;
  art.dataset.simulationTick = String(frame.tick);
  art.dataset.reducedMotion = String(frame.reducedMotion);
  return frame;
}

export function createCombatArt(document, kind, side, layer, hidden = false) {
  if (typeof hidden !== 'boolean' || (kind !== "buried-coil" && hidden)) {
    throw new TypeError("combat art hidden state must be a Buried Coil boolean");
  }
  const create = typeof document.createElementNS === 'function'
    ? (tag) => document.createElementNS('http://www.w3.org/2000/svg', tag)
    : (tag) => document.createElement(tag);
  const svg = create('svg');
  svg.setAttribute('viewBox', '0 0 64 64');
  svg.setAttribute('class', 'combat-art');
  svg.setAttribute('aria-hidden', 'true');
  svg.dataset.artId = Object.hasOwn(shapes, kind) ||
    kind === "ember-basin" || kind === "buried-coil" || kind === "kilnkeeper"
    ? kind : `witness-${layer}`;
  if (kind === "kilnkeeper") {
    svg.setAttribute('viewBox', '0 0 512 512');
    const teamRing = create('ellipse');
    teamRing.setAttribute('cx', '256');
    teamRing.setAttribute('cy', '486');
    teamRing.setAttribute('rx', '182');
    teamRing.setAttribute('ry', '15');
    teamRing.setAttribute('fill', 'none');
    teamRing.setAttribute('stroke', side === 'north' ? '#C6452E' : '#2E7F86');
    teamRing.setAttribute('stroke-width', '34');
    teamRing.setAttribute('aria-hidden', 'true');
    svg.appendChild(teamRing);
    const image = create('image');
    image.setAttribute('href', KILNKEEPER_BATTLE_IMAGE);
    image.setAttribute('x', '0');
    image.setAttribute('y', '0');
    image.setAttribute('width', '512');
    image.setAttribute('height', '512');
    image.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    svg.appendChild(image);
    return svg;
  }
  if (kind === 'ember-basin') {
    svg.setAttribute('viewBox', '0 0 512 512');
    const teamRing = create('ellipse');
    teamRing.setAttribute('cx', '256');
    teamRing.setAttribute('cy', '486');
    teamRing.setAttribute('rx', '182');
    teamRing.setAttribute('ry', '12');
    teamRing.setAttribute('fill', 'none');
    teamRing.setAttribute('stroke', side === 'north' ? '#C6452E' : '#2E7F86');
    teamRing.setAttribute('stroke-width', '24');
    teamRing.setAttribute('aria-hidden', 'true');
    svg.appendChild(teamRing);
    const image = create('image');
    image.setAttribute('href', EMBER_BASIN_BATTLE_IMAGE);
    image.setAttribute('x', '0');
    image.setAttribute('y', '0');
    image.setAttribute('width', '512');
    image.setAttribute('height', '512');
    image.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    svg.appendChild(image);
    return svg;
  }
  if (kind === "buried-coil") {
    svg.setAttribute('viewBox', '0 0 512 512');
    svg.dataset.hidden = String(hidden);
    svg.dataset.form = hidden ? "hidden" : "revealed";
    svg.dataset.teamColor = side;
    // The team plate sits beyond the approved artwork on the home-facing edge.
    const teamPlate = create('rect');
    teamPlate.dataset.teamColor = side;
    teamPlate.setAttribute('x', '38');
    teamPlate.setAttribute('y', side === 'north' ? '-512' : '512');
    teamPlate.setAttribute('width', '436');
    teamPlate.setAttribute('height', '88');
    teamPlate.setAttribute('rx', '44');
    teamPlate.setAttribute('fill', side === 'north' ? '#C6452E' : '#2E7F86');
    teamPlate.setAttribute('shape-rendering', 'crispEdges');
    teamPlate.setAttribute('aria-hidden', 'true');
    const image = create('image');
    image.setAttribute('href', hidden ? BURIED_COIL_HIDDEN_IMAGE : BURIED_COIL_REVEALED_IMAGE);
    image.setAttribute('x', '0');
    image.setAttribute('y', '0');
    image.setAttribute('width', '512');
    image.setAttribute('height', '512');
    image.setAttribute('preserveAspectRatio', 'none');
    svg.appendChild(image);
    svg.appendChild(teamPlate);
    return svg;
  }
  // Unshipped witness-only kinds use an explicit family silhouette.
  const paths = Object.hasOwn(shapes, kind) ? shapes[kind] : shapes[layer === 'air' ? 'copperskiff' : 'coilblade'];
  for (const [d, fill] of paths) {
    const node = create('path');
    node.setAttribute('d', d);
    node.setAttribute('fill', fill === 'team' ? (side === 'north' ? '#C6452E' : '#2E7F86') : fill);
    node.setAttribute('stroke', INK);
    node.setAttribute('stroke-width', '2');
    node.setAttribute('stroke-linejoin', 'round');
    node.setAttribute('stroke-linecap', 'round');
    svg.appendChild(node);
  }
  const crest = create('path');
  crest.setAttribute('d', side === 'north' ? 'M28 35 32 30 36 35Z' : 'M27 33Q32 39 37 33');
  crest.setAttribute('fill', side === 'north' ? COPPER : 'none');
  crest.setAttribute('stroke', side === 'north' ? COPPER : '#DCEDE9');
  crest.setAttribute('stroke-width', '2');
  svg.appendChild(crest);
  return svg;
}

export const COMBAT_ART_STYLE = `.combat-target-link{display:none}.combat-target-link[data-from-structure="true"]{display:block}.combat-target-link[data-from-structure="true"] line{stroke:#E9A83A99;stroke-width:70;stroke-dasharray:190 125}.combat-marker[class]{border:0;background:none;border-radius:0;box-shadow:none;width:6.2%;height:auto;aspect-ratio:1}.combat-marker--entity-ground{filter:drop-shadow(0 2px 0 #191d2244)}.combat-marker--entity-air::before{content:"";position:absolute;left:18%;right:18%;height:13%;bottom:-15%;border-radius:50%;background:#191d2244}.combat-art{display:block;width:100%;height:100%;overflow:visible}.combat-marker[data-kind="mossguard"],.combat-marker[data-kind="skymaul"]{width:7.5%}.combat-marker[data-kind="stonehauler"]{width:8.2%}.combat-marker[data-kind="bulwark-needle"],.combat-marker[data-kind="buried-coil"],.combat-marker[data-kind="ember-basin"]{width:8.4%;z-index:21}.combat-marker--structure[data-targeting="true"] .combat-art{filter:drop-shadow(0 0 7px #E9A83A)}.combat-marker[data-kind="briar-runner"],.combat-marker[data-kind="briar-darter"],.combat-marker[data-kind="cinderling"]{width:4.8%}.combat-marker--tower[class]{width:7%;height:0;aspect-ratio:auto}.combat-marker[class] .combat-health{width:80%;height:4px;bottom:105%;border-radius:1px;background:#DCEDE9;box-shadow:0 0 0 1px #191D22}.combat-marker--north[class] .combat-health{background:#E9A83A}.combat-marker--tower[class] .combat-health{bottom:28px;height:4px;border-radius:0;box-shadow:0 0 0 1px #191D22;transform:translateZ(0) scaleX(calc(var(--combat-health)/var(--combat-health-max)))}.combat-marker[data-reaction="damage"] .combat-art{filter:brightness(1.7)}.combat-marker[data-reaction="target"] .combat-art{transform:rotate(-7deg)}.combat-marker--north[data-reaction="target"] .combat-art{transform:rotate(7deg)}`;
