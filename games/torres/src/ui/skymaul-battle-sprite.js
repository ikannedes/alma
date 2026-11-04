const DIRECTIONS = Object.freeze(["east", "north", "south", "west"]);
const ACTIONS = Object.freeze(["idle", "walk", "contact"]);
const ATLAS = Object.freeze({
  cellSize: 64,
  columns: Object.freeze({ east: 0, north: 1, south: 2, west: 3 }),
  height: 384,
  image: new URL("../../public/assets/skymaul-battle-sprite.png", import.meta.url).href,
  pivot: Object.freeze({ x: 32, y: 54 }),
  rows: Object.freeze({
    river: Object.freeze({ idle: 0, walk: 1, contact: 2 }),
    ember: Object.freeze({ idle: 3, walk: 4, contact: 5 }),
  }),
  width: 256,
});

/** Resolve one fixed 64px atlas window from canonical team, pose, and facing. */
export function getSkymaulBattleFrame({
  action,
  direction,
  reducedMotion = false,
  side,
  tick,
} = {}) {
  if (!ACTIONS.includes(action)) {
    throw new RangeError("Skymaul action must be idle, walk, or contact");
  }
  if (!DIRECTIONS.includes(direction)) {
    throw new RangeError("Skymaul direction must be actor-facing cardinal");
  }
  if (side !== "north" && side !== "south") {
    throw new RangeError("Skymaul side must be north or south");
  }
  if (!Number.isSafeInteger(tick) || tick < 0) {
    throw new RangeError("Skymaul tick must be a non-negative safe integer");
  }
  if (typeof reducedMotion !== "boolean") {
    throw new TypeError("Skymaul reducedMotion must be a boolean");
  }

  const team = side === "north" ? "ember" : "river";
  const row = ATLAS.rows[team][action];
  const column = ATLAS.columns[direction];
  const x = column * ATLAS.cellSize;
  const y = row * ATLAS.cellSize;
  return Object.freeze({
    action,
    column,
    direction,
    id: `skymaul-${team}-${direction}-${action}`,
    reducedMotion,
    row,
    side,
    source: Object.freeze({
      height: ATLAS.cellSize,
      width: ATLAS.cellSize,
      x,
      y,
    }),
    team,
    tick,
    viewBox: `${x} ${y} ${ATLAS.cellSize} ${ATLAS.cellSize}`,
  });
}

/** Create a fixed-pivot atlas window around the unchanged combat marker. */
export function createSkymaulBattleArt(document, {
  action = "idle",
  bodyCssPixels = 13,
  direction,
  frameScale = 1,
  reducedMotion = false,
  side,
  tick,
} = {}) {
  if (typeof document?.createElementNS !== "function" ||
      typeof document?.createElement !== "function") {
    throw new TypeError("Skymaul battle art requires a DOM document");
  }
  if ((bodyCssPixels !== 13 && bodyCssPixels !== 26) ||
      !Number.isFinite(frameScale) || frameScale <= 0 || frameScale > 8) {
    throw new TypeError("Skymaul presentation context is invalid");
  }
  const frame = getSkymaulBattleFrame({
    action, direction, reducedMotion, side, tick,
  });
  const create = (tag) => document.createElementNS("http://www.w3.org/2000/svg", tag);
  const svg = create("svg");
  svg.setAttribute("viewBox", frame.viewBox);
  svg.setAttribute("class", "combat-art combat-art--skymaul");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.setAttribute("preserveAspectRatio", "none");
  svg.dataset.artId = "skymaul";
  svg.dataset.spriteAction = frame.action;
  svg.dataset.spriteDirection = frame.direction;
  svg.dataset.spriteFrame = frame.id;
  svg.dataset.spriteSide = frame.side;
  svg.dataset.spriteTeam = frame.team;
  svg.dataset.simulationTick = String(frame.tick);
  svg.dataset.reducedMotion = String(frame.reducedMotion);
  svg.dataset.pivot = `${ATLAS.pivot.x}:${ATLAS.pivot.y}`;
  svg.dataset.bodyCssPixels = String(bodyCssPixels);

  const image = create("image");
  image.dataset.part = "atlas";
  image.setAttribute("href", ATLAS.image);
  image.setAttribute("x", "0");
  image.setAttribute("y", "0");
  image.setAttribute("width", String(ATLAS.width));
  image.setAttribute("height", String(ATLAS.height));
  image.setAttribute("preserveAspectRatio", "none");
  svg.appendChild(image);

  const frameCssPixels = ATLAS.cellSize * bodyCssPixels / 13 / frameScale;
  svg.style.position = "absolute";
  svg.style.left = "50%";
  svg.style.top = "50%";
  svg.style.translate = "-50% -84.375%";
  svg.style.pointerEvents = "none";
  svg.style.width = `${frameCssPixels}px`;
  svg.style.height = `${frameCssPixels}px`;
  return svg;
}

/** Update only the source window and deterministic frame metadata. */
export function updateSkymaulBattleArt(art, {
  action,
  direction,
  reducedMotion = false,
  side,
  tick,
} = {}) {
  if (!art || art.dataset?.artId !== "skymaul" ||
      typeof art.setAttribute !== "function") {
    throw new TypeError("Skymaul battle art node is invalid");
  }
  const frame = getSkymaulBattleFrame({
    action, direction, reducedMotion, side, tick,
  });
  art.setAttribute("viewBox", frame.viewBox);
  art.dataset.spriteAction = frame.action;
  art.dataset.spriteDirection = frame.direction;
  art.dataset.spriteFrame = frame.id;
  art.dataset.spriteSide = frame.side;
  art.dataset.spriteTeam = frame.team;
  art.dataset.simulationTick = String(frame.tick);
  art.dataset.reducedMotion = String(frame.reducedMotion);
  return frame;
}
