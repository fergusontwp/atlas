// Straight text along a path, kept upright and following the view's rotation (section 57): pure, shared by the edge
// lengths (edgeLabels.js) and the Measure labels (measure.js). No DOM and no SDK imports.
//
// Points are [x, y] in map coordinates (y up). TextSymbol.angle is clockwise on screen, relative to the screen, not the
// map, so a view rotated clockwise by rotationDeg turns every edge on screen by that much.

// A text angle (degrees, clockwise from horizontal, as TextSymbol.angle) for an edge going from a to b in map
// coordinates (y up), kept upright: always within -90..90, never upside down.
export function uprightAngle(a, b, rotationDeg = 0) {
  const math = (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI; // counterclockwise from east
  let angle = -math + rotationDeg; // clockwise, on screen
  angle = ((((angle + 90) % 180) + 180) % 180) - 90; // wrap into [-90, 90)
  if (angle === -90) angle = 90; // a vertical edge reads bottom to top; either is upright, keep one
  if (angle > 90) angle -= 180;
  else if (angle < -90) angle += 180;
  return Object.is(angle, -0) ? 0 : angle;
}

// The segment lengths of a path (closed: the segment back from the last point to the first is added, unless the last
// point repeats the first).
export function pathLengths(pts, { closed = false } = {}) {
  const out = [];
  for (let i = 0; i < pts.length - 1; i++) out.push(Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]));
  const n = pts.length;
  if (closed && n > 1 && (pts[0][0] !== pts[n - 1][0] || pts[0][1] !== pts[n - 1][1])) out.push(Math.hypot(pts[0][0] - pts[n - 1][0], pts[0][1] - pts[n - 1][1]));
  return out;
}

// The point at `measure` along a path, with the upright angle of the segment it falls on. lengths: the segments'
// lengths in the units `measure` is given in (default: from the points themselves; the edge lengths pass the layer's
// own lengths while the points are the view's). closed: the path is a ring; the measure wraps around it. A measure past
// either end stays on the end segment. One segment at exactly half its length gives the exact midpoint, (a + b) / 2.
// Returns { x, y, angleDeg, index (the segment), t (0..1 along it), a, b } or null for a path with no segment.
export function alongPath(pts, measure, { lengths = null, closed = false, rotationDeg = 0 } = {}) {
  const L = lengths ?? pathLengths(pts, { closed });
  if (!L.length) return null;
  const at = (i) => pts[i % pts.length];
  let target = measure;
  if (closed) {
    const total = L.reduce((t, v) => t + v, 0);
    if (total > 0) target = ((target % total) + total) % total;
  }
  let s = 0;
  while (s < L.length - 1 && target > L[s]) target -= L[s++];
  const a = at(s), b = at(s + 1);
  if (L.length === 1 && measure === L[0] / 2) {
    return { x: (a[0] + b[0]) / 2, y: (a[1] + b[1]) / 2, angleDeg: uprightAngle(a, b, rotationDeg), index: 0, t: 0.5, a, b };
  }
  const t = L[s] === 0 ? 0 : Math.max(0, Math.min(1, target / L[s]));
  return { x: a[0] + t * (b[0] - a[0]), y: a[1] + t * (b[1] - a[1]), angleDeg: uprightAngle(a, b, rotationDeg), index: s, t, a, b };
}

// The point on a path nearest to p, and its measure along the path (the path's own units): { measure, x, y, index, t,
// dist } or null. closed: the ring's closing segment counts too. Used to slide a dragged label along its line or ring.
export function nearestOnPath(pts, p, { closed = false } = {}) {
  const L = pathLengths(pts, { closed });
  let best = null, before = 0;
  for (let i = 0; i < L.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const dx = b[0] - a[0], dy = b[1] - a[1], len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
    const x = a[0] + t * dx, y = a[1] + t * dy, dist = Math.hypot(p[0] - x, p[1] - y);
    if (!best || dist < best.dist) best = { measure: before + t * L[i], x, y, index: i, t, dist };
    before += L[i];
  }
  return best;
}

// A unit normal to the segment a -> b on screen, for putting text on one side of it: { x, y } in map units (y up),
// pointing to the left of the direction a -> b. The caller flips it for the other side.
export function leftNormal(a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy);
  return len === 0 ? { x: 0, y: 1 } : { x: -dy / len, y: dx / len };
}

// A multi-part line (a Polyline's paths, or a Polygon's rings): one measure runs through the parts in order, with no
// gap between them. alongParts gives alongPath's result plus `part`; nearestOnParts gives nearestOnPath's plus `part`,
// its measure counted the same way. closed: every part is a ring.
export function alongParts(parts, measure, { closed = false, rotationDeg = 0 } = {}) {
  const lens = (parts ?? []).map((p) => pathLengths(p, { closed }).reduce((t, v) => t + v, 0));
  const total = lens.reduce((t, v) => t + v, 0);
  if (!(total > 0)) return null;
  let m = Math.max(0, Math.min(total, measure));
  for (let k = 0; k < parts.length; k++) {
    if (lens[k] === 0) continue;
    const last = k === parts.length - 1 || lens.slice(k + 1).every((v) => v === 0);
    if (m <= lens[k] || last) {
      const r = alongPath(parts[k], Math.min(m, lens[k]), { closed, rotationDeg });
      return r && { ...r, part: k };
    }
    m -= lens[k];
  }
  return null;
}
export function nearestOnParts(parts, p, { closed = false } = {}) {
  let best = null, before = 0;
  (parts ?? []).forEach((pts, k) => {
    const r = nearestOnPath(pts, p, { closed });
    if (r && (!best || r.dist < best.dist)) best = { ...r, measure: before + r.measure, part: k };
    before += pathLengths(pts, { closed }).reduce((t, v) => t + v, 0);
  });
  return best;
}
// The total length of a multi-part line (the measure's range).
export const partsLength = (parts, { closed = false } = {}) => (parts ?? []).reduce((t, p) => t + pathLengths(p, { closed }).reduce((s, v) => s + v, 0), 0);
