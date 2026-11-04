const SVG_NS = "http://www.w3.org/2000/svg";
const VIEWBOX_SIZE = 32;
const BODY_TOP = 2.575;
const BODY_BOTTOM = 28;
const BODY_HEIGHT_UNITS = BODY_BOTTOM - BODY_TOP;

const COLORS = Object.freeze({
  ink: "#211A19",
  stone: "#56625E",
  stoneLight: "#87918A",
  stoneDark: "#35443F",
  wood: "#5B392D",
  woodLight: "#A06B43",
  copper: "#C97639",
  copperLight: "#F0B75C",
  water: "#1E5E62",
  waterLight: "#79B49B",
  amber: "#FFD260",
  amberDark: "#E89425",
  outline: "#F3E9D5",
});

export const AETHER_WELL_TEAM_COLORS = Object.freeze({
  north: "#C6452E",
  south: "#2E7F86",
});

function node(document, name, part, attributes = {}) {
  const element = document.createElementNS(SVG_NS, name);
  element.dataset.part = part;
  for (const [key, value] of Object.entries(attributes)) {
    element.setAttribute(key, String(value));
  }
  return element;
}

function group(document, parent, part) {
  const element = node(document, "g", part);
  parent.appendChild(element);
  return element;
}

function path(document, parent, part, d, fill, stroke = COLORS.ink, strokeWidth = 0.85) {
  const attributes = { d, fill };
  if (stroke) {
    attributes.stroke = stroke;
    attributes["stroke-width"] = strokeWidth;
    attributes["stroke-linecap"] = "round";
    attributes["stroke-linejoin"] = "round";
  } else {
    attributes.stroke = "none";
  }
  const element = node(document, "path", part, attributes);
  parent.appendChild(element);
  return element;
}

function ellipse(document, parent, part, attributes) {
  const element = node(document, "ellipse", part, attributes);
  parent.appendChild(element);
  return element;
}

/** Create a deterministic, static Aether Well silhouette for a measured body size. */
export function createAetherWellBattleArt(document, {
  bodyCssPixels = 13,
  side = "south",
} = {}) {
  if (!Number.isFinite(bodyCssPixels) || bodyCssPixels <= 0) {
    throw new RangeError("Aether Well bodyCssPixels must be a finite positive number");
  }
  if (side !== "north" && side !== "south") {
    throw new RangeError("Aether Well side must be north or south");
  }
  if (typeof document?.createElementNS !== "function") {
    throw new TypeError("Aether Well art requires a DOM document");
  }

  const svg = node(document, "svg", "figure", {
    viewBox: `0 0 ${VIEWBOX_SIZE} ${VIEWBOX_SIZE}`,
    preserveAspectRatio: "xMidYMid meet",
    class: "combat-art combat-art--aether-well",
    "aria-hidden": "true",
    focusable: "false",
  });
  const frameCssPixels = bodyCssPixels * (VIEWBOX_SIZE / BODY_HEIGHT_UNITS);
  svg.style.display = "block";
  svg.style.width = `${frameCssPixels}px`;
  svg.style.height = `${frameCssPixels}px`;
  svg.dataset.artId = "aether-well";
  svg.dataset.renderer = "native-svg";
  svg.dataset.side = side;
  svg.dataset.teamColor = AETHER_WELL_TEAM_COLORS[side];
  svg.dataset.bodyCssPixels = String(bodyCssPixels);
  svg.dataset.bodyBoundsUnits = `${BODY_TOP}:${BODY_BOTTOM}`;
  svg.dataset.motion = "static";

  const teamColor = AETHER_WELL_TEAM_COLORS[side];
  const ground = group(document, svg, "grounding");
  ellipse(document, ground, "ground-shadow", {
    cx: 16, cy: 27.35, rx: 12.4, ry: 0.58, fill: "#142320",
  });
  // Nested, un-stroked ellipses keep the team band inside the exact 25.425-unit body bounds.
  ellipse(document, ground, "team-ring", {
    cx: 16, cy: 27.4, rx: 12.3, ry: 0.6, fill: teamColor,
  });
  ellipse(document, ground, "team-ring-inset", {
    cx: 16, cy: 27.4, rx: 11.8, ry: 0.28, fill: COLORS.outline,
  });
  ellipse(document, ground, "team-ring-center", {
    cx: 16, cy: 27.4, rx: 11.4, ry: 0.12, fill: teamColor,
  });

  const structure = group(document, svg, "well-structure");
  const posts = group(document, structure, "rootwood-uprights");
  path(document, posts, "left-rootwood-post",
    "M8.1 4.9 Q9.3 3.9 10.6 4.2 L11.7 17.3 Q11.2 20.3 9.3 22.3 L7.1 21.5 Q8.8 18.6 7.7 15.8 Z",
    COLORS.wood);
  path(document, posts, "right-rootwood-post",
    "M21.4 4.2 Q22.7 3.9 23.9 4.9 L24.3 15.8 Q23.2 18.6 24.9 21.5 L22.7 22.3 Q20.8 20.3 20.3 17.3 Z",
    COLORS.wood);
  path(document, posts, "left-root-grain", "M9.7 6.2 Q9.1 10.4 10.1 15.4", "none", COLORS.woodLight, 0.65);
  path(document, posts, "right-root-grain", "M22.2 6.2 Q22.8 10.4 21.8 15.4", "none", COLORS.woodLight, 0.65);

  const beam = group(document, structure, "crossbeam");
  path(document, beam, "rootwood-crossbeam",
    "M9.5 3.15 Q16 2 22.5 3.15 L22.1 5.25 Q16 4.2 9.9 5.25 Z",
    COLORS.wood, null);
  path(document, beam, "crossbeam-grain", "M11.1 3.65 Q16 2.9 20.9 3.65", "none", COLORS.woodLight, 0.62);
  path(document, beam, "left-copper-collar", "M9.5 3.05 L11.2 3.18 L11.4 5.08 L9.8 4.82 Z", COLORS.copper, COLORS.ink, 0.55);
  path(document, beam, "right-copper-collar", "M20.6 3.18 L22.3 3.05 L22.0 4.82 L20.4 5.08 Z", COLORS.copper, COLORS.ink, 0.55);
  ellipse(document, beam, "left-collar-rivet", { cx: 10.35, cy: 3.95, rx: 0.34, ry: 0.34, fill: COLORS.copperLight });
  ellipse(document, beam, "right-collar-rivet", { cx: 21.65, cy: 3.95, rx: 0.34, ry: 0.34, fill: COLORS.copperLight });

  const crank = group(document, structure, "copper-crank");
  ellipse(document, crank, "crank-wheel-rim", {
    cx: 26.2, cy: 8.4, rx: 2.15, ry: 2.15, fill: COLORS.ink,
  });
  ellipse(document, crank, "crank-wheel", {
    cx: 26.2, cy: 8.4, rx: 1.55, ry: 1.55, fill: COLORS.copper,
  });
  ellipse(document, crank, "crank-hub", {
    cx: 26.2, cy: 8.4, rx: 0.58, ry: 0.58, fill: COLORS.copperLight,
  });
  path(document, crank, "crank-handle", "M27.2 7.3 L29.4 5.7 L30.1 6.5 L28.1 8.1 L29.3 9.4 L28.5 10.2 L26.8 8.7 Z", COLORS.wood);
  ellipse(document, crank, "crank-grip", { cx: 29.85, cy: 6.05, rx: 0.72, ry: 0.55, fill: COLORS.woodLight });

  const basin = group(document, svg, "stone-and-copper-basin");
  path(document, basin, "stone-well-body",
    "M5.4 17.9 Q16 21.2 26.6 17.9 L25.3 23.7 Q16 27 6.7 23.7 Z",
    COLORS.stone);
  path(document, basin, "left-stone-block",
    "M6.7 20.7 L12.7 22.25 L12.1 25.45 L7.1 24.15 Z", COLORS.stoneDark, COLORS.ink, 0.7);
  path(document, basin, "center-stone-block",
    "M12.7 22.25 L19.3 22.25 L19.8 25.45 L12.1 25.45 Z", COLORS.stoneLight, COLORS.ink, 0.7);
  path(document, basin, "right-stone-block",
    "M19.3 22.25 L25.3 20.7 L24.9 24.15 L19.8 25.45 Z", COLORS.stoneDark, COLORS.ink, 0.7);
  path(document, basin, "stone-footing",
    "M7.1 24.1 Q16 26.8 24.9 24.1 L23.7 26.25 Q16 27.4 8.3 26.25 Z", COLORS.stoneDark);
  path(document, basin, "copper-lip", "M5.3 17.8 Q16 21.1 26.7 17.8", "none", COLORS.copperLight, 1.3);
  ellipse(document, basin, "copper-basin-rim", {
    cx: 16, cy: 17.75, rx: 10.7, ry: 3.15, fill: COLORS.copper,
  });
  ellipse(document, basin, "still-water", {
    cx: 16, cy: 17.55, rx: 9.25, ry: 2.12, fill: COLORS.water,
  });
  path(document, basin, "water-glint", "M10.1 17.05 Q12.2 16.3 14 16.72", "none", COLORS.waterLight, 0.55);
  ellipse(document, basin, "emberseed-left", {
    cx: 12.5, cy: 17.85, rx: 0.8, ry: 0.62, fill: COLORS.amber,
  });
  ellipse(document, basin, "emberseed-center", {
    cx: 16, cy: 17.18, rx: 0.94, ry: 0.72, fill: COLORS.amber,
  });
  ellipse(document, basin, "emberseed-right", {
    cx: 19.45, cy: 17.82, rx: 0.72, ry: 0.57, fill: COLORS.amberDark,
  });
  ellipse(document, basin, "emberseed-center-glow", {
    cx: 16.2, cy: 17.03, rx: 0.34, ry: 0.25, fill: COLORS.outline,
  });

  const lift = group(document, svg, "seed-lift");
  path(document, lift, "chain", "M16 5.35 L16 12.35", "none", COLORS.ink, 1.05);
  path(document, lift, "chain-light", "M16 5.55 L16 12.15", "none", COLORS.copperLight, 0.42);
  path(document, lift, "copper-scoop",
    "M13.55 12.1 Q16 13.15 18.45 12.1 L17.8 14.35 Q16 15.25 14.2 14.35 Z",
    COLORS.copper, COLORS.ink, 0.65);
  ellipse(document, lift, "scoop-emberseed", {
    cx: 16, cy: 12.55, rx: 0.72, ry: 0.55, fill: COLORS.amber,
  });

  const team = group(document, svg, "team-identity");
  path(document, team, "team-badge",
    "M11.3 22.15 Q16 21.2 20.7 22.15 L20 25.1 Q16 26.1 12 25.1 Z",
    teamColor, COLORS.outline, 0.6);
  ellipse(document, team, "team-badge-seed", {
    cx: 16, cy: 23.7, rx: 0.55, ry: 0.55, fill: COLORS.copperLight,
  });

  return svg;
}
