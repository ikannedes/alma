// Modificado para Alma, 2026-10-31: rótulo de la carta siguiente en español.
// Original: Moss & Ember, ThatXliner/clash-royale-clone, commit 75d30d1 (AGPL-3.0-only).
import { getCardPortrait, getCardPortraitIds } from "./card-portrait-art.js";

const CANVAS_WIDTH = 714;
const CANVAS_HEIGHT = 172;
const CARD_WIDTH = 136;
const CARD_HEIGHT = 162;
const CARD_X = Object.freeze([5, 147, 289, 431, 573]);
const CARD_Y = 5;
const PAINTER_REVISION = "hud-card-painter-1";

function roundedPath(context, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  context.beginPath();
  context.moveTo(x + r, y);
  context.arcTo(x + width, y, x + width, y + height, r);
  context.arcTo(x + width, y + height, x, y + height, r);
  context.arcTo(x, y + height, x, y, r);
  context.arcTo(x, y, x + width, y, r);
  context.closePath();
}

function clippedImage(context, image, source, x, y, width, height) {
  const sourceWidth = source.width;
  const sourceHeight = source.height;
  const sourceRatio = sourceWidth / sourceHeight;
  const targetRatio = width / height;
  let sx = source.x;
  let sy = source.y;
  let sw = sourceWidth;
  let sh = sourceHeight;
  if (sourceRatio > targetRatio) {
    sw = sourceHeight * targetRatio;
    sx += (sourceWidth - sw) / 2;
  } else if (sourceRatio < targetRatio) {
    sh = sourceWidth / targetRatio;
    sy += (sourceHeight - sh) / 2;
  }
  context.drawImage(image, sx, sy, sw, sh, x, y, width, height);
}

function imageSource(image, cell) {
  if (cell === null) {
    return { height: image.naturalHeight, width: image.naturalWidth, x: 0, y: 0 };
  }
  const width = image.naturalWidth / 4;
  const height = image.naturalHeight / 2;
  return {
    height,
    width,
    x: (cell % 4) * width,
    y: Math.floor(cell / 4) * height,
  };
}

function cardNameLines(context, name, maxWidth) {
  const words = name.split(/\s+/u);
  const lines = [];
  let line = "";
  for (const word of words) {
    const candidate = line.length === 0 ? word : `${line} ${word}`;
    if (line.length > 0 && context.measureText(candidate).width > maxWidth) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line.length > 0) lines.push(line);
  if (lines.length <= 2) return lines;
  return [lines[0], lines.slice(1).join(" ")];
}

function drawCost(context, x, y, cost, state) {
  const outer = state === "ended" ? "#191d22" : "#f4ebd6";
  const border = state === "insufficient" ? "#b455c4" : "#191d22";
  const fill = state === "ended" ? "#5d6468"
    : state === "insufficient" ? "#191d22" : "#743684";
  context.save();
  context.shadowColor = state === "ended" ? "transparent" : "#191d2288";
  context.shadowBlur = state === "ended" ? 0 : 3;
  context.shadowOffsetX = state === "ended" ? 0 : 2;
  context.shadowOffsetY = state === "ended" ? 0 : 3;
  context.beginPath();
  context.arc(x + 23, y + 23, 23, 0, Math.PI * 2);
  context.fillStyle = outer;
  context.fill();
  context.shadowColor = "transparent";
  context.beginPath();
  context.arc(x + 23, y + 23, 20, 0, Math.PI * 2);
  context.fillStyle = fill;
  context.fill();
  context.lineWidth = 3;
  context.strokeStyle = border;
  context.stroke();
  if (state === "normal") {
    const glow = context.createRadialGradient(x + 17, y + 16, 2, x + 23, y + 23, 22);
    glow.addColorStop(0, state === "insufficient" ? "#f2a9ed" : "#f2a9ed");
    glow.addColorStop(0.58, state === "insufficient" ? "#b455c4" : "#b455c4");
    glow.addColorStop(1, "#743684");
    context.beginPath();
    context.arc(x + 23, y + 23, 18.5, 0, Math.PI * 2);
    context.fillStyle = glow;
    context.fill();
  }
  context.fillStyle = state === "insufficient" ? "#f2a9ed" : "#fff";
  if (state === "ended") context.fillStyle = "#f4ebd6";
  context.font = '700 30px "Barlow Condensed", sans-serif';
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(String(cost), x + 23, y + 24);
  context.restore();
}

function drawCard(context, card, kind, x, y, phase, assets) {
  const ended = kind === "hand" && phase === "ended";
  const insufficient = kind === "hand" && !ended && card.insufficient;
  const selected = kind === "hand" && !ended && card.selected;
  const state = ended ? "ended" : insufficient ? "insufficient" : "normal";
  if (selected) {
    roundedPath(context, x - 5, y - 5, CARD_WIDTH + 10, CARD_HEIGHT + 10, 14);
    context.fillStyle = "#191d22";
    context.fill();
    roundedPath(context, x - 3, y - 3, CARD_WIDTH + 6, CARD_HEIGHT + 6, 12);
    context.fillStyle = "#e9a83a";
    context.fill();
  }

  context.save();
  roundedPath(context, x, y, CARD_WIDTH, CARD_HEIGHT, 10);
  context.fillStyle = ended ? "#5d6468" : "#18232c";
  context.fill();
  context.save();
  roundedPath(context, x + 3, y + 3, CARD_WIDTH - 6, CARD_HEIGHT - 6, 7);
  context.clip();
  const portrait = getCardPortrait(card.id);
  const image = assets.get(portrait.src);
  context.filter = kind === "next"
    ? "saturate(.85) brightness(.92)"
    : ended ? "grayscale(1) brightness(.6)"
      : insufficient ? "grayscale(.6) brightness(.55)" : "none";
  if (kind === "next") {
    clippedImage(context, image, imageSource(image, portrait.cell),
      x + 3, y + 23, 130, 84);
  } else {
    clippedImage(context, image, imageSource(image, portrait.cell),
      x + 3, y - 5, 130, 130);
  }
  context.filter = "none";
  context.fillStyle = ended ? "#8b8578" : selected ? "#e9a83a" : "#f4ebd6";
  context.fillRect(x + 3, y + 108, 130, 51);
  context.restore();

  context.lineWidth = 3;
  context.setLineDash(insufficient ? [7, 5] : []);
  context.strokeStyle = ended ? "#5d6468" : selected ? "#e9a83a"
    : insufficient ? "#8b8578" : "#191d22";
  roundedPath(context, x + 1.5, y + 1.5, CARD_WIDTH - 3, CARD_HEIGHT - 3, 9);
  context.stroke();
  context.setLineDash([]);
  if (kind === "next") {
    context.fillStyle = "#191d22";
    roundedPath(context, x + 3, y + 3, 130, 20, 7);
    context.fill();
    context.fillStyle = "#f4ebd6";
    context.font = '900 16px "Barlow Condensed", sans-serif';
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText("SIGUIENTE", x + 68, y + 13);
    context.strokeStyle = "#b8672e";
    context.lineWidth = 1;
    roundedPath(context, x + 4, y + 4, 128, 154, 6);
    context.stroke();
  }
  const name = card.displayName;
  context.fillStyle = ended ? "#f4ebd6" : "#191d22";
  context.font = '700 22px "Barlow Condensed", sans-serif';
  context.textAlign = "center";
  context.textBaseline = "middle";
  const lines = cardNameLines(context, name, 124);
  const lineHeight = 22;
  const startY = y + 134 - ((lines.length - 1) * lineHeight) / 2;
  for (let index = 0; index < lines.length; index += 1) {
    context.fillText(lines[index], x + 68, startY + index * lineHeight, 124);
  }
  if (kind === "hand") {
    drawCost(context, x + 8, y + 8, card.cost, state);
  } else {
    drawCost(context, x + 8, y + 28, card.cost, "normal");
  }
  context.restore();
}

function readPresentation(document) {
  const frameScale = Number(document.documentElement?.dataset?.combatFrameScale ?? 1);
  const ratio = Number(document.defaultView?.devicePixelRatio ?? 1);
  if (!Number.isFinite(frameScale) || frameScale <= 0 || frameScale > 8 ||
      !Number.isFinite(ratio) || ratio <= 0 || ratio > 8) {
    throw new TypeError("HUD painter presentation scale is invalid");
  }
  const scale = frameScale * ratio;
  return {
    height: Math.max(1, Math.round(CANVAS_HEIGHT * scale)),
    width: Math.max(1, Math.round(CANVAS_WIDTH * scale)),
  };
}

function renderKey(view, size) {
  const ended = view.phase === "ended";
  return JSON.stringify({
    assets: PAINTER_REVISION,
    height: size.height,
    hand: view.hand.map(({ cost, displayName, id, insufficient, selected }) =>
      [id, displayName, cost, ended ? false : selected, ended ? false : insufficient]),
    next: [view.next.id, view.next.displayName, view.next.cost],
    phase: view.phase,
    width: size.width,
  });
}

function makePlan(view, document) {
  const size = readPresentation(document);
  return { key: renderKey(view, size), size };
}

function drawFrame(context, view, assets) {
  context.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
  const cards = [view.next, ...view.hand];
  for (let index = 0; index < cards.length; index += 1) {
    drawCard(context, cards[index], index === 0 ? "next" : "hand",
      CARD_X[index], CARD_Y, view.phase, assets);
  }
}

function createPainter(document, assets) {
  const scratch = document.createElement("canvas");
  const scratchContext = scratch.getContext("2d", { willReadFrequently: true });
  if (!scratchContext) throw new TypeError("HUD painter requires a Canvas 2D context");
  scratchContext.imageSmoothingEnabled = true;
  scratchContext.imageSmoothingQuality = "high";
  let committedKey = null;
  let disposed = false;

  return Object.freeze({
    dispose() {
      if (disposed) return false;
      disposed = true;
      scratch.width = 0;
      scratch.height = 0;
      committedKey = null;
      return true;
    },
    stage(view, canvas) {
      if (disposed) throw new RangeError("HUD painter is disposed");
      const { key, size } = makePlan(view, document);
      if (canvas?.ownerDocument !== document || canvas?.dataset?.ui !== "hud-card-paint") {
        throw new TypeError("HUD painter Canvas target is invalid");
      }
      const unchanged = key === committedKey && canvas.width === size.width &&
        canvas.height === size.height;
      if (unchanged) return Object.freeze({
        commit() { return false; },
        finalize() {},
        rollback() {},
      });

      scratch.width = size.width;
      scratch.height = size.height;
      const scaleX = size.width / CANVAS_WIDTH;
      const scaleY = size.height / CANVAS_HEIGHT;
      scratchContext.setTransform(scaleX, 0, 0, scaleY, 0, 0);
      drawFrame(scratchContext, view, assets);
      scratchContext.setTransform(1, 0, 0, 1, 0, 0);
      const pixels = scratchContext.getImageData(0, 0, size.width, size.height);
      let oldPixels = null;
      let oldKey = committedKey;
      let oldWidth = canvas.width;
      let oldHeight = canvas.height;
      let attempted = false;
      let restored = false;
      return Object.freeze({
        commit() {
          if (attempted) throw new Error("HUD painter transaction already committed");
          attempted = true;
          oldWidth = canvas.width;
          oldHeight = canvas.height;
          oldPixels = oldWidth > 0 && oldHeight > 0
            ? canvas.getContext("2d", { willReadFrequently: true })
              ?.getImageData(0, 0, oldWidth, oldHeight) ?? null
            : null;
          canvas.width = size.width;
          canvas.height = size.height;
          const context = canvas.getContext("2d", { willReadFrequently: true });
          if (!context) throw new TypeError("HUD painter live Canvas context is unavailable");
          if (canvas.width !== size.width || canvas.height !== size.height) {
            throw new Error("HUD painter live Canvas backing size did not match its staged plan");
          }
          context.putImageData(pixels, 0, 0);
          committedKey = key;
          return true;
        },
        finalize() {
          oldPixels = null;
          oldKey = null;
        },
        rollback() {
          if (!attempted || restored) return false;
          canvas.width = oldWidth;
          canvas.height = oldHeight;
          if (oldPixels !== null) {
            const context = canvas.getContext("2d", { willReadFrequently: true });
            if (!context) throw new TypeError("HUD painter rollback Canvas context is unavailable");
            context.putImageData(oldPixels, 0, 0);
          }
          committedKey = oldKey;
          restored = true;
          return true;
        },
      });
    },
  });
}

export async function prepareHudCardPainter(document) {
  if (!document || typeof document.createElement !== "function" ||
      !document.fonts || typeof document.fonts.load !== "function") {
    throw new TypeError("HUD painter preparation requires a browser Document");
  }
  const assets = new Map();
  const sources = new Set(getCardPortraitIds().map((id) => getCardPortrait(id).src));
  await Promise.all([...sources].map(async (src) => {
    const image = document.createElement("img");
    image.decoding = "sync";
    image.loading = "eager";
    image.src = src;
    if (typeof image.decode !== "function") {
      throw new TypeError("HUD painter requires image decoding support");
    }
    await image.decode();
    if (image.naturalWidth < 1 || image.naturalHeight < 1) {
      throw new TypeError("HUD painter image decoded without pixels");
    }
    assets.set(src, image);
  }));
  await Promise.all([
    document.fonts.load('700 22px "Barlow Condensed"'),
    document.fonts.load('900 16px "Barlow Condensed"'),
    document.fonts.ready,
  ]);
  if (!document.fonts.check('700 22px "Barlow Condensed"') ||
      !document.fonts.check('900 16px "Barlow Condensed"')) {
    throw new TypeError("HUD painter font did not become ready");
  }
  const factory = Object.freeze({
    create() {
      return createPainter(document, assets);
    },
  });
  return factory;
}
