const INK = "#251a18";
const HAIR = "#8e3f2c";
const FACE = "#f3bd91";
const SLEEVE = "#bd5038";
const APRON = "#187c77";
const COPPER = "#f0a52d";
const WOOD = "#56352b";
const TROUSER = "#68433a";
const BOOT = "#4d302a";

const SVG_NS = "http://www.w3.org/2000/svg";
const VIEWBOX = 32;
const NATIVE_BODY_HEIGHT_UNITS = 28.4;
const PAINTED_BODY_FRACTION = 501 / 512;
const PAINTED_IMAGE = new URL(
  "../../public/assets/brackenwheel-battle-sprite.webp",
  import.meta.url,
).href;

function setArtMetadata(element, renderer, bodyCssPixels) {
  element.dataset.artId = "brackenwheel";
  element.dataset.renderer = renderer;
  element.dataset.bodyCssPixels = String(bodyCssPixels);
  element.setAttribute("aria-hidden", "true");
  element.setAttribute("focusable", "false");
  element.style.display = "block";
}

function setPart(element, part) {
  element.dataset.part = part;
  return element;
}

function createNativeArt(document, bodyCssPixels) {
  const svg = setPart(document.createElementNS(SVG_NS, "svg"), "figure");
  const frameCssPixels = bodyCssPixels * (VIEWBOX / NATIVE_BODY_HEIGHT_UNITS);
  svg.setAttribute("viewBox", "0 0 32 32");
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
  svg.style.width = `${frameCssPixels}px`;
  svg.style.height = `${frameCssPixels}px`;
  setArtMetadata(svg, "native-svg", bodyCssPixels);

  const group = (part, parent = svg) => {
    const element = setPart(document.createElementNS(SVG_NS, "g"), part);
    parent.appendChild(element);
    return element;
  };
  const path = (parent, part, d, fill, stroke = INK) => {
    const element = setPart(document.createElementNS(SVG_NS, "path"), part);
    element.setAttribute("d", d);
    element.setAttribute("fill", fill);
    if (stroke) {
      element.setAttribute("stroke", stroke);
      element.setAttribute("stroke-width", "1.2");
      element.setAttribute("stroke-linejoin", "round");
      element.setAttribute("stroke-linecap", "round");
    }
    parent.appendChild(element);
    return element;
  };

  const feet = group("legs");
  path(feet, "left-leg", "M17.0 19.7 L20.1 19.7 L19.2 26.3 L16.0 26.3 Z", TROUSER);
  path(feet, "right-leg", "M22.8 19.7 L25.9 19.7 L26.7 26.3 L23.6 26.3 Z", TROUSER);
  const boots = group("feet", feet);
  path(boots, "left-boot", "M16.3 25.7 L19.2 25.7 L19.2 28.2 L20.0 28.8 L20.0 29.4 L15.0 29.4 L15.0 29.0 L16.3 28.2 Z", BOOT);
  path(boots, "right-boot", "M23.5 25.7 L26.4 25.7 L27.6 28.2 L28.3 28.9 L28.3 29.4 L23.3 29.4 L23.3 28.9 L23.6 28.2 Z", BOOT);

  const torso = group("torso");
  path(torso, "neck", "M19.0 9.8 L23.0 9.8 L23.6 13.4 L18.5 13.4 Z", FACE);
  path(torso, "body", "M16.4 12.1 Q20.6 10.8 24.7 12.1 L25.3 21.3 L16.0 21.3 Z", SLEEVE);
  path(torso, "left-sleeve", "M17.3 12.0 Q15.2 11.8 14.3 13.7 L12.7 16.7 Q12.3 17.4 13.0 17.9 L14.1 18.4 Q14.7 18.6 15.1 18.0 L18.2 14.8 Z", SLEEVE);
  path(torso, "right-sleeve", "M23.7 12.0 Q26.2 11.5 27.5 13.7 L29.0 16.9 Q29.4 17.6 28.7 18.1 L27.6 18.8 Q26.8 19.1 26.3 18.2 L24.3 15.7 L22.9 14.2 Z", SLEEVE);
  const apron = group("apron", torso);
  path(apron, "apron-bib", "M17.0 12.1 L24.2 12.1 Q25.0 12.1 24.9 13.0 L24.3 20.9 Q20.6 22.0 16.8 20.9 L16.1 13.0 Q16.0 12.2 17.0 12.1 Z", APRON);

  const head = group("head");
  const hair = group("hair", head);
  path(hair, "curl-mass", "M14.6 8.0 C13.4 6.3 14.2 4.1 16.0 3.3 C16.6 2.3 18.3 2.2 19.4 2.9 C20.7 1.9 22.5 2.2 23.3 3.2 C25.5 2.7 27.0 4.2 26.5 6.2 C27.8 7.7 27.0 10.0 25.4 11.0 L16.0 11.0 C14.4 10.5 13.6 9.2 14.6 8.0 Z", HAIR);
  const face = group("face", head);
  path(face, "face-shape", "M16.7 6.4 C18.2 5.5 22.6 5.5 24.4 6.8 L24.1 9.0 Q23.4 10.5 20.6 10.6 Q17.8 10.4 16.5 9.1 Z", FACE, null);

  const tool = group("sickle");
  const hook = document.createElementNS(SVG_NS, "path");
  setPart(hook, "hook-blade");
  hook.setAttribute("d", "M10.0 4.3 C5.4 4.1 2.8 7.6 2.8 12.4 C2.8 17.3 5.1 20.1 9.4 20.3");
  hook.setAttribute("fill", "none");
  hook.setAttribute("stroke", INK);
  hook.setAttribute("stroke-width", "4.4");
  hook.setAttribute("stroke-linecap", "butt");
  hook.setAttribute("stroke-linejoin", "round");
  hook.dataset.openSide = "right";
  tool.appendChild(hook);
  const copper = document.createElementNS(SVG_NS, "path");
  setPart(copper, "hook-copper");
  copper.setAttribute("d", hook.getAttribute("d"));
  copper.setAttribute("fill", "none");
  copper.setAttribute("stroke", COPPER);
  copper.setAttribute("stroke-width", "2.8");
  copper.setAttribute("stroke-linecap", "butt");
  copper.setAttribute("stroke-linejoin", "round");
  tool.appendChild(copper);
  const shaft = document.createElementNS(SVG_NS, "path");
  setPart(shaft, "sickle-handle");
  shaft.setAttribute("d", "M9.1 19.6 L13.3 17.3");
  shaft.setAttribute("fill", "none");
  shaft.setAttribute("stroke", WOOD);
  shaft.setAttribute("stroke-width", "2.4");
  shaft.setAttribute("stroke-linecap", "round");
  tool.appendChild(shaft);
  const hand = group("grip", tool);
  path(hand, "hand", "M12.4 16.4 Q13.2 15.8 14.1 16.5 L14.5 17.4 Q14.4 18.2 13.6 18.4 L12.7 17.9 Q12.1 17.3 12.4 16.4 Z", FACE);

  return svg;
}

/** Choose a renderer from the requested body height without measuring browser layout. */
export function createBrackenwheelScaleArt(document, { bodyCssPixels = 13 } = {}) {
  if (!Number.isFinite(bodyCssPixels) || bodyCssPixels <= 0) {
    throw new RangeError("Brackenwheel bodyCssPixels must be a finite positive number");
  }
  if (typeof document?.createElementNS !== "function" || typeof document?.createElement !== "function") {
    throw new TypeError("Brackenwheel art requires a DOM document");
  }

  if (bodyCssPixels < 26) return createNativeArt(document, bodyCssPixels);

  const image = setPart(document.createElement("img"), "figure");
  const frameCssPixels = bodyCssPixels / PAINTED_BODY_FRACTION;
  image.setAttribute("src", PAINTED_IMAGE);
  image.setAttribute("alt", "");
  image.style.width = `${frameCssPixels}px`;
  image.style.height = `${frameCssPixels}px`;
  image.dataset.source = "frozen-painted-cutout";
  setArtMetadata(image, "painted-webp", bodyCssPixels);
  return image;
}
