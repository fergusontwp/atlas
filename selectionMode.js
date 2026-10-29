// The selection outline's symbols (selectionOutline.js, and the search outlines). No DOM and no SDK imports.
import { HIGHLIGHT } from "./config.js";
import { outlineColor, printColor } from "./printLeader.js";

// A highlight color as #rrggbb (lowercase; #rgb is expanded), or the fallback for anything else (null, a name, rgb()).
export const sanitizeColor = (value, fallback = HIGHLIGHT.DEFAULT_COLOR) => (typeof value === "string" ? printColor(value, fallback) : fallback);

// The casing under a highlight color: black under a light color, white under a dark one (relative luminance), at
// `alpha`, as an [r, g, b, a] SDK color.
export function casingColor(color, alpha) {
  const hex = outlineColor(color);
  return [...[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)), alpha];
}

// The outline's two symbols for a geometry type, drawn in this order: the contrasting casing underneath, the line in the
// highlight color on top. A polygon gets no-fill outlines, a line two lines, a point (or multipoint) two rings.
// outline: HIGHLIGHT.OUTLINE; color: the highlight color (#rrggbb).
export function outlineSymbols(type, { color, outline }) {
  const { WIDTH, CASING_WIDTH, CASING_ALPHA, JOIN, CAP, RING_SIZE } = outline;
  const main = sanitizeColor(color), casing = casingColor(main, CASING_ALPHA);
  if (type === "polyline") {
    const line = (c, width) => ({ type: "simple-line", color: c, width, style: "solid", cap: CAP, join: JOIN });
    return [line(casing, CASING_WIDTH), line(main, WIDTH)];
  }
  if (type === "point" || type === "multipoint") {
    const ring = (c, width) => ({ type: "simple-marker", style: "circle", size: RING_SIZE, color: [0, 0, 0, 0], outline: { color: c, width } });
    return [ring(casing, CASING_WIDTH), ring(main, WIDTH)];
  }
  const fill = (c, width) => ({ type: "simple-fill", color: [0, 0, 0, 0], outline: { color: c, width, style: "solid", cap: CAP, join: JOIN } });
  return [fill(casing, CASING_WIDTH), fill(main, WIDTH)];
}
