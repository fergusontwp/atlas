import { MEASURE } from "./config.js";
import { formatMeasure } from "./measureList.js";
import { alongParts, alongPath, leftNormal, partsLength, pathLengths, uprightAngle } from "./pathAngle.js";

// Measurement labels (section 57): pure. One set of settings for every label (MEASURE.LABELS); measure.js draws.
//
// Coordinates: map coordinates in the view's spatial reference (y up). resolution: map units per screen pixel;
// rotationDeg: the view's clockwise rotation (SDK MapView.rotation). Screen vectors are y down.

const L = (cfg) => cfg.LABELS;
const isBool = (v) => typeof v === "boolean";

// The saved settings, cleaned: every key of DEFAULTS, a bad or missing value replaced by its default, unknown keys
// dropped. raw: an object or its JSON text (anything else, or JSON that doesn't parse, gives the defaults).
export function sanitizeLabelSettings(raw, cfg = MEASURE) {
  const C = L(cfg), D = C.DEFAULTS;
  let o = raw;
  if (typeof raw === "string") { try { o = JSON.parse(raw); } catch { o = null; } }
  if (!o || typeof o !== "object" || Array.isArray(o)) o = {};
  const out = { ...D };
  for (const key of ["show", "bold", "halo", "number", "name", "value", "perimeter"]) if (isBool(o[key])) out[key] = o[key];
  if (Number.isInteger(o.size) && o.size >= C.SIZE_MIN && o.size <= C.SIZE_MAX) out.size = o.size;
  if (typeof o.offset === "number" && Number.isFinite(o.offset) && o.offset >= 0 && o.offset <= C.OFFSET_MAX) out.offset = o.offset;
  if (C.LINE_MODES.includes(o.line)) out.line = o.line;
  if (C.AREA_MODES.includes(o.area)) out.area = o.area;
  if (C.LINE_SIDES.includes(o.lineSide)) out.lineSide = o.lineSide;
  if (C.AREA_SIDES.includes(o.areaSide)) out.areaSide = o.areaSide;
  return out;
}
// Whether settings are the defaults (then nothing is stored).
export const isDefaultLabels = (s, cfg = MEASURE) => Object.entries(L(cfg).DEFAULTS).every(([k, v]) => s?.[k] === v);
// Something to draw: labels on and at least one part ticked (a line has no perimeter).
export const anyContent = (s, kind) => !!s?.show && !!(s.number || s.name || s.value || (kind === "area" && s.perimeter));

// The label's text from the settings: "2 · north setback · 1.24 ac" by default; an area may add its perimeter
// ("2 · 1.24 ac · 980.2 ft"). "" when nothing is ticked (no label is drawn).
export function labelContent(item, units, s, cfg = MEASURE) {
  if (!anyContent(s, item.kind)) return "";
  const length = formatMeasure(item.kind === "area" ? item.values.perimeter : item.values.length, units.length, cfg);
  const value = item.kind === "area" ? formatMeasure(item.values.area, units.area, cfg) : length;
  return [s.number ? String(item.n) : "", s.name ? item.name : "", s.value ? value : "", item.kind === "area" && s.perimeter ? length : ""].filter(Boolean).join(" · ");
}

// ---- screen geometry

const rad = (d) => (d * Math.PI) / 180;
// a map vector (y up) as a screen vector (y down, pixels), and back
export function toScreen(v, rotationDeg = 0, resolution = 1) {
  const r = rad(rotationDeg), c = Math.cos(r), s = Math.sin(r);
  return { x: (v.x * c + v.y * s) / resolution, y: (v.x * s - v.y * c) / resolution };
}
export function toMap(v, rotationDeg = 0, resolution = 1) {
  const r = rad(rotationDeg), c = Math.cos(r), s = Math.sin(r);
  return { x: (v.x * c + v.y * s) * resolution, y: (v.x * s - v.y * c) * resolution };
}
// the text's "up" on screen for a TextSymbol angle (clockwise degrees): perpendicular to its baseline
const textUp = (angleDeg) => ({ x: Math.sin(rad(angleDeg)), y: -Math.cos(rad(angleDeg)) });

// The estimated size of a label on screen, in pixels: width from the characters, height from the font size (points).
export function textBox(text, s, cfg = MEASURE) {
  const px = (s.size * 96) / 72;
  return { w: [...String(text ?? "")].length * px * (s.bold ? L(cfg).BOLD_CHAR_EM : L(cfg).CHAR_EM), h: px * 1.2 };
}

// The signed area of a ring (shoelace, y up): negative for a clockwise ring (an outer ring in ArcGIS).
export function signedArea(ring) {
  let a = 0;
  for (let i = 0, n = ring.length; i < n; i++) { const p = ring[i], q = ring[(i + 1) % n]; a += p[0] * q[1] - q[0] * p[1]; }
  return a / 2;
}

// ---- where a label goes

// A point along the line or ring with the text angled to it and moved to its side. `side`: +1 the text's up side
// ("above"), -1 below, 0 on, for a line; for an area, "outside" | "on" | "inside" (outward from the ring's orientation).
// Returns { x, y, angleDeg, measure }.
function onPath(at, { side, area, ring, s, box, rotationDeg, resolution }) {
  const { x, y, angleDeg, a, b } = at;
  let dir = 0, up = null;
  if (area) {
    if (s.areaSide !== "on") {
      // a clockwise ring has its inside on the right: the left normal points out
      const out = leftNormal(a, b), cw = signedArea(ring) < 0, sign = (cw ? 1 : -1) * (s.areaSide === "outside" ? 1 : -1);
      up = { x: out.x * sign, y: out.y * sign };
      dir = 1;
    }
  } else if (side) {
    up = toMap(textUp(angleDeg), rotationDeg, 1); // a unit map vector
    dir = side;
  }
  if (!dir || !up) return { x, y, angleDeg };
  const dist = (s.offset + box.h / 2) * resolution * dir;
  const len = Math.hypot(up.x, up.y) || 1;
  return { x: x + (up.x / len) * dist, y: y + (up.y / len) * dist, angleDeg };
}

// A line's label "along the line": at `measure` (default: halfway along all its parts), angled with the line there.
export function placeAlong(parts, s, { measure = null, rotationDeg = 0, resolution = 1, box = { w: 0, h: 0 } } = {}) {
  const total = partsLength(parts);
  if (!(total > 0)) return null;
  const m = measure === null || !Number.isFinite(measure) ? total / 2 : Math.max(0, Math.min(total, measure));
  const at = alongParts(parts, m, { rotationDeg });
  if (!at) return null;
  const side = s.lineSide === "above" ? 1 : s.lineSide === "below" ? -1 : 0;
  return { ...onPath(at, { side, area: false, s, box, rotationDeg, resolution }), measure: m };
}

// The straight edges of an area's outer rings, as runs that are straight on screen: consecutive segments are one run
// while every vertex in it stays within MERGE_TOL_PX of the run's chord and no vertex turns by CORNER_DEG or more (a
// lot line digitized with small wiggles, or a gentle bend, is one edge; a corner always ends one). Straight text on the
// chord then stays on the line. edgeLabels.js's curve runs are not reused: they join a whole curve, whose chord leaves
// the line, and their tests are in the layer's own units, not on screen.
// Each run: { ring, part, from, to (measures along the rings, in map units), lengthPx (the chord on screen), mid: { x,
// y, angleDeg, a, b } (the chord's middle and upright angle), lowY (screen y of the middle; larger is lower) }.
export function areaEdges(rings, { rotationDeg = 0, resolution = 1, cfg = MEASURE } = {}) {
  const C = L(cfg), tol = C.MERGE_TOL_PX * resolution;
  const outer = rings.filter((r) => signedArea(r) < 0);
  const use = outer.length ? outer : rings;
  const out = [];
  let before = 0;
  rings.forEach((ring, part) => {
    const pts = ring.length > 1 && ring[0][0] === ring.at(-1)[0] && ring[0][1] === ring.at(-1)[1] ? ring.slice(0, -1) : ring;
    const n = pts.length;
    const lens = pathLengths(pts, { closed: true });
    const ringLen = lens.reduce((t, v) => t + v, 0);
    if (use.includes(ring) && n > 2) {
      const P = (i) => pts[((i % n) + n) % n];
      const turn = (i) => {
        const a = P(i - 1), b = P(i), c = P(i + 1);
        let d = Math.abs(Math.atan2(c[1] - b[1], c[0] - b[0]) - Math.atan2(b[1] - a[1], b[0] - a[0])) * (180 / Math.PI);
        return d > 180 ? 360 - d : d;
      };
      const offChord = (a, b, q) => { const len = Math.hypot(b[0] - a[0], b[1] - a[1]); return len === 0 ? Math.hypot(q[0] - a[0], q[1] - a[1]) : Math.abs((b[0] - a[0]) * (a[1] - q[1]) - (a[0] - q[0]) * (b[1] - a[1])) / len; };
      // start at the sharpest corner, so a side never straddles the ring's first vertex
      let start = 0;
      for (let i = 1; i < n; i++) if (turn(i) > turn(start)) start = i;
      const measureAt = (i) => lens.slice(0, ((i % n) + n) % n).reduce((t, v) => t + v, 0);
      let s0 = start;
      const flush = (s, e) => {
        if (e <= s) return;
        const a = P(s), b = P(e);
        const runLen = Array.from({ length: e - s }, (_, k) => lens[((s + k) % n + n) % n]).reduce((t, v) => t + v, 0);
        const chord = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (chord === 0) return;
        const mid = { x: (a[0] + b[0]) / 2, y: (a[1] + b[1]) / 2, angleDeg: uprightAngle(a, b, rotationDeg), a, b };
        const from = before + measureAt(s);
        out.push({ ring, part, from, to: from + runLen, lengthPx: chord / resolution, mid, lowY: toScreen({ x: mid.x, y: mid.y }, rotationDeg, resolution).y });
      };
      for (let e = start + 1; e <= start + n; e++) {
        const a = P(s0), b = P(e);
        const straight = turn(e - 1) < C.CORNER_DEG || e - 1 === s0;
        let within = straight;
        for (let k = s0 + 1; within && k < e; k++) within = offChord(a, b, P(k)) <= tol;
        if (!within) { flush(s0, e - 1); s0 = e - 1; }
      }
      flush(s0, start + n);
    }
    before += ringLen;
  });
  return out;
}

// A label's corners on screen (pixels, from the map origin): the box centered on (x, y), turned by angleDeg.
export function labelCorners(x, y, angleDeg, box, rotationDeg = 0, resolution = 1) {
  const c = toScreen({ x, y }, rotationDeg, resolution);
  const along = { x: Math.cos(rad(angleDeg)), y: Math.sin(rad(angleDeg)) }, up = textUp(angleDeg);
  const hw = box.w / 2, hh = box.h / 2;
  return [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([u, v]) => [c.x + along.x * u - up.x * v, c.y + along.y * u - up.y * v]);
}
// whether two convex polygons (screen corners) overlap (separating axes)
export function polygonsOverlap(p, q) {
  for (const poly of [p, q]) {
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length], nx = b[1] - a[1], ny = a[0] - b[0];
      const proj = (pts) => pts.map((v) => v[0] * nx + v[1] * ny);
      const pp = proj(p), qq = proj(q);
      if (Math.max(...pp) < Math.min(...qq) || Math.max(...qq) < Math.min(...pp)) return false;
    }
  }
  return true;
}
// whether a screen segment crosses a convex polygon
function segmentHits(poly, a, b) {
  return polygonsOverlap(poly, [a, b, b, a]);
}

// The label for an area "on the edge": the edges whose run is long enough on screen for the text (box.w plus
// FIT_MARGIN_PX at each end), ranked by `pick`:
//   "longest"          the longest edge on screen;
//   "lowest"           the lowest edge on screen;
//   "fewest-overlaps"  the edge whose label overlaps the fewest other labels (others.boxes: screen corners; the other
//                      measurements' labels and, when shown, the edge lengths) and other shapes (others.segments:
//                      screen [a, b]); ties go to the lowest edge (horizontal text on the bottom side read best in the
//                      comparison of section 57), then the longest.
// measure: a dragged position along the rings (it wins: no fit rule). null when no edge fits (the caller draws it at
// the center). Returns { x, y, angleDeg, measure, edge }.
export function placeOnEdge(rings, s, { measure = null, rotationDeg = 0, resolution = 1, box, pick = MEASURE.LABELS.EDGE_PICK, others = { boxes: [], segments: [] }, cfg = MEASURE } = {}) {
  const closedRings = rings.map((r) => (r.length > 1 && r[0][0] === r.at(-1)[0] && r[0][1] === r.at(-1)[1] ? r.slice(0, -1) : r));
  if (measure !== null && Number.isFinite(measure)) {
    const at = alongParts(closedRings, measure, { closed: true, rotationDeg });
    if (!at) return null;
    return { ...onPath(at, { area: true, ring: closedRings[at.part], s, box, rotationDeg, resolution }), measure, edge: null };
  }
  const need = box.w + 2 * L(cfg).FIT_MARGIN_PX;
  const fits = areaEdges(rings, { rotationDeg, resolution, cfg }).filter((e) => e.lengthPx >= need);
  if (!fits.length) return null;
  const placed = fits.map((e) => {
    const p = onPath(e.mid, { area: true, ring: closedRings[e.part], s, box, rotationDeg, resolution });
    const corners = labelCorners(p.x, p.y, p.angleDeg, box, rotationDeg, resolution);
    const hits = pick === "fewest-overlaps"
      ? (others.boxes ?? []).filter((o) => polygonsOverlap(corners, o)).length + (others.segments ?? []).filter(([a, b]) => segmentHits(corners, a, b)).length
      : 0;
    return { e, p, hits };
  });
  const by = {
    longest: (u, v) => v.e.lengthPx - u.e.lengthPx,
    lowest: (u, v) => v.e.lowY - u.e.lowY || v.e.lengthPx - u.e.lengthPx,
    "fewest-overlaps": (u, v) => u.hits - v.hits || v.e.lowY - u.e.lowY || v.e.lengthPx - u.e.lengthPx,
  }[pick] ?? ((u, v) => v.e.lengthPx - u.e.lengthPx);
  const best = placed.sort(by)[0];
  return { ...best.p, measure: (best.e.from + best.e.to) / 2, edge: best.e, hits: best.hits };
}
