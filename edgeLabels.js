// Pure geometry for per-edge length labels. No DOM and no SDK imports, so it can be tested alone.
//
// Rings are arrays of [x, y] vertices. Lengths are measured in the layer's own units (meters, planar) and shown in
// feet. Positions and angles come from the same rings projected into the view's spatial reference (viewRings: same
// vertex count and order), because map angles must be right on screen while UTM grid north differs a little.

export const METERS_PER_FOOT = { "us-feet": 0.3048006096, feet: 0.3048 };

const sameXY = (a, b) => a[0] === b[0] && a[1] === b[1];

// Length of one ring's boundary (the closing vertex may or may not be repeated).
export function ringPerimeter(ring) {
  let total = 0;
  const n = ring.length;
  if (n < 2) return 0;
  for (let i = 0; i < n - 1; i++) total += Math.hypot(ring[i + 1][0] - ring[i][0], ring[i + 1][1] - ring[i][1]);
  if (!sameXY(ring[0], ring[n - 1])) total += Math.hypot(ring[0][0] - ring[n - 1][0], ring[0][1] - ring[n - 1][1]);
  return total;
}

// A text angle (degrees, clockwise from horizontal, as TextSymbol.angle) for an edge going from a to b in map
// coordinates (y up), kept upright: always within -90..90, never upside down. TextSymbol.angle is relative to the
// screen, not the map, so a view rotated clockwise by rotationDeg turns every edge on screen by that much.
export function uprightAngle(a, b, rotationDeg = 0) {
  const math = (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI; // counterclockwise from east
  let angle = -math + rotationDeg; // clockwise, on screen
  angle = ((((angle + 90) % 180) + 180) % 180) - 90; // wrap into [-90, 90)
  if (angle === -90) angle = 90; // a vertical edge reads bottom to top; either is upright, keep one
  if (angle > 90) angle -= 180;
  else if (angle < -90) angle += 180;
  return Object.is(angle, -0) ? 0 : angle;
}

export function formatFeet(meters, { unit = "us-feet", decimals = 1 } = {}) {
  const feet = meters / (METERS_PER_FOOT[unit] ?? METERS_PER_FOOT["us-feet"]);
  return `${feet.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals })} ft`;
}

// options: { unit, decimals, viewRings?, unitsPerPixel?, minEdgePx?, rotationDeg? }
//   viewRings      projected copy of rings (same shape); positions and angles use it when given
//   unitsPerPixel  view map units per screen pixel; with minEdgePx, edges shorter than that on screen are dropped
// Returns [{ x, y, angleDeg, lengthM, text }]: one per edge of every ring (holes too), in view coordinates when
// viewRings is given, otherwise in the rings' own coordinates.
export function buildEdges(rings, options = {}) {
  const { unit = "us-feet", decimals = 1, viewRings, unitsPerPixel, minEdgePx, rotationDeg = 0 } = options;
  const out = [];
  rings.forEach((ring, r) => {
    const view = viewRings?.[r] ?? ring;
    const n = sameXY(ring[0], ring[ring.length - 1]) ? ring.length - 1 : ring.length; // skip the repeated closing vertex
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const lengthM = Math.hypot(ring[j][0] - ring[i][0], ring[j][1] - ring[i][1]);
      if (lengthM === 0) continue; // zero-length edge
      const a = view[i], b = view[j];
      if (unitsPerPixel && minEdgePx && Math.hypot(b[0] - a[0], b[1] - a[1]) / unitsPerPixel < minEdgePx) continue;
      out.push({
        x: (a[0] + b[0]) / 2,
        y: (a[1] + b[1]) / 2,
        angleDeg: uprightAngle(a, b, rotationDeg),
        lengthM,
        text: formatFeet(lengthM, { unit, decimals }),
      });
    }
  });
  return out;
}

export const countEdges = (rings) =>
  rings.reduce((t, ring) => t + (ring.length > 1 && sameXY(ring[0], ring[ring.length - 1]) ? ring.length - 1 : ring.length), 0);

// Drops later edges that sit on top of an earlier one (same midpoint to about 5 cm in map units, same text), as the
// shared boundary of two parcels does.
export function dedupeEdges(edges, tolerance = 0.05) {
  const seen = new Set();
  return edges.filter((e) => {
    const key = `${Math.round(e.x / tolerance)}|${Math.round(e.y / tolerance)}|${e.text}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Curves: a parcel curve is digitized as many short segments, and labelling each one is noise. A "run" is a stretch of
// consecutive segments that is one curve; a run of at least CURVE.MIN_SEGMENTS segments gets ONE label (the summed
// length, halfway along). Everything is decided from the layer's own coordinates (planar, meters); only the label's
// position and angle use the view's projected vertices.
//
// A run starts at a vertex (a "break") when any of these is true; when several are, the first in this list is the
// reason that is counted:
//   junction    another line meets this vertex: at least 3 distinct edge directions leave it across the queried parcels
//   sharp       the turn exceeds max(CORNER_MIN_DEG, CORNER_RATIO x the median turn of the 2 vertices on each side)
//   sagitta     the bend is too coarse to be a finely digitized arc: (min(l1, l2) / 2) x tan(turn / 4) > SAGITTA_MAX_FT
//   inflection  the turn direction flips (turns under 1 degree are noise), so an S-curve splits where it changes sides
// Afterwards a segment more than LENGTH_RATIO times the median of the others in its run is cut out of it ("length",
// the straight tangent that flows into a curve), and a single short chord left next to a curve is merged into it.

const DEG = 180 / Math.PI;
const DIRECTION_TOL_DEG = 0.5; // two edges leaving a vertex within this angle are the same direction
const NOISE_TURN_DEG = 1; // turns under this are digitizing noise when looking for a change of turn direction

const median = (values) => {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// The ring's distinct vertices: the repeated closing vertex and repeated points are dropped. Returns original indices.
function distinctIndices(ring) {
  const idx = [];
  for (let i = 0; i < ring.length; i++) {
    if (idx.length && sameXY(ring[idx[idx.length - 1]], ring[i])) continue;
    idx.push(i);
  }
  if (idx.length > 1 && sameXY(ring[idx[0]], ring[idx[idx.length - 1]])) idx.pop();
  return idx;
}

// Vertices matched within a tolerance get one id, and remember the directions of the edges that leave them.
function makeVertexIndex(tol) {
  const cells = new Map();
  const entries = [];
  const key = (cx, cy) => `${cx},${cy}`;
  const find = (x, y) => {
    const cx = Math.floor(x / tol), cy = Math.floor(y / tol);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const e of cells.get(key(cx + dx, cy + dy)) ?? []) if (Math.hypot(e.x - x, e.y - y) <= tol) return e;
      }
    }
    return null;
  };
  const at = (x, y) => {
    let e = find(x, y);
    if (!e) {
      e = { id: entries.length, x, y, dirs: [] };
      entries.push(e);
      const k = key(Math.floor(x / tol), Math.floor(y / tol));
      if (!cells.has(k)) cells.set(k, []);
      cells.get(k).push(e);
    }
    return e;
  };
  const distinctDirections = (e) => {
    if (!e || e.dirs.length === 0) return 0;
    const a = [...e.dirs].sort((p, q) => p - q);
    let clusters = 1;
    for (let i = 1; i < a.length; i++) if (a[i] - a[i - 1] > DIRECTION_TOL_DEG) clusters++;
    if (clusters > 1 && a[0] + 360 - a[a.length - 1] <= DIRECTION_TOL_DEG) clusters--; // first and last meet across north
    return clusters;
  };
  return { at, find, distinctDirections };
}

// Register every ring's vertices and the directions of their edges.
function registerRings(index, rings) {
  for (const ring of rings) {
    const idx = distinctIndices(ring);
    const n = idx.length;
    if (n < 2) continue;
    for (let k = 0; k < n; k++) {
      const p = ring[idx[k]], prev = ring[idx[(k + n - 1) % n]], next = ring[idx[(k + 1) % n]];
      const e = index.at(p[0], p[1]);
      const dir = (q) => ((Math.atan2(q[1] - p[1], q[0] - p[0]) * DEG) + 360) % 360;
      e.dirs.push(dir(prev), dir(next));
    }
  }
}

const turnDeg = (a, b, c) => {
  const ux = b[0] - a[0], uy = b[1] - a[1], vx = c[0] - b[0], vy = c[1] - b[1];
  return Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy) * DEG;
};

// Break reasons for one ring's vertices and the runs between them. See the block comment above.
function analyzeRing(ring, ctx) {
  const { curve, feetPerMeter, index } = ctx;
  const idx = distinctIndices(ring);
  const n = idx.length;
  const P = idx.map((i) => ring[i]);
  const len = P.map((p, i) => Math.hypot(P[(i + 1) % n][0] - p[0], P[(i + 1) % n][1] - p[1])); // segment i: vertex i to i + 1
  const reasons = new Array(n).fill(null);
  if (n < 3) return { idx, n, P, len, reasons, runs: P.map((_, i) => ({ segs: [i] })) };

  const turn = P.map((p, i) => turnDeg(P[(i + n - 1) % n], p, P[(i + 1) % n]));
  const sharp = new Array(n).fill(false);
  const sagitta = new Array(n).fill(false);
  const junction = new Array(n).fill(false);
  for (let i = 0; i < n; i++) {
    if (curve.JUNCTIONS && index.distinctDirections(index.find(P[i][0], P[i][1])) >= 3) junction[i] = true;
    const near = [];
    for (const d of [-2, -1, 1, 2]) {
      const j = (((i + d) % n) + n) % n;
      if (j !== i && !near.includes(j)) near.push(j);
    }
    const limit = Math.max(curve.CORNER_MIN_DEG, curve.CORNER_RATIO * median(near.map((j) => Math.abs(turn[j]))));
    const a = Math.abs(turn[i]);
    sharp[i] = a > limit;
    const shortFeet = Math.min(len[(i + n - 1) % n], len[i]) * feetPerMeter;
    sagitta[i] = (shortFeet / 2) * Math.tan((a / 4) / DEG) > curve.SAGITTA_MAX_FT;
  }

  // A change of turn direction is judged against the last significant turn since the run began, so the walk starts at a
  // break (a reflex corner followed by a curve is then not an "inflection").
  let start = 0;
  for (let i = 0; i < n; i++) if (junction[i] || sharp[i] || sagitta[i]) { start = i; break; }
  let lastSign = 0;
  for (let k = 0; k < n; k++) {
    const i = (start + k) % n;
    const sign = Math.abs(turn[i]) >= NOISE_TURN_DEG ? Math.sign(turn[i]) : 0;
    const flips = sign !== 0 && lastSign !== 0 && sign !== lastSign;
    // When a bend is both too coarse for an arc and a change of direction, it is counted as the coarse bend: a corner at
    // the end of a curve flips the turn direction too, and "inflection" should only count real S-curves.
    reasons[i] = junction[i] ? "junction" : sharp[i] ? "sharp" : sagitta[i] ? "sagitta" : flips ? "inflection" : null;
    if (junction[i] || sharp[i] || sagitta[i]) lastSign = 0; // a new run starts here: nothing to compare with yet
    else if (sign !== 0) lastSign = sign;
  }

  // Runs: the segments between consecutive breaks, starting at a break so a run never straddles the ring's first vertex.
  const breaksNow = () => reasons.map((r, i) => (r ? i : -1)).filter((i) => i >= 0);
  const runsFrom = (breaks) => {
    if (breaks.length === 0) return [{ segs: Array.from({ length: n }, (_, i) => i) }];
    return breaks.map((from, b) => {
      const to = breaks[(b + 1) % breaks.length];
      const segs = [];
      let i = from;
      do {
        segs.push(i);
        i = (i + 1) % n;
      } while (i !== to);
      return { segs };
    });
  };
  let runs = runsFrom(breaksNow());

  // A segment far longer than the others in its run (a straight tangent flowing into a curve) is cut out of it: the
  // vertices on either side of it become breaks, then the runs are found again.
  const cyclic = runs.length === 1 && breaksNow().length === 0;
  let cutAny = false;
  for (const run of runs) {
    if (run.segs.length < 2) continue;
    run.segs.forEach((s, k) => {
      const others = run.segs.filter((_, q) => q !== k).map((q) => len[q]);
      if (!(len[s] > curve.LENGTH_RATIO * median(others))) return;
      if (cyclic || k > 0) { if (!reasons[s]) { reasons[s] = "length"; cutAny = true; } }
      if (cyclic || k < run.segs.length - 1) { const v = (s + 1) % n; if (!reasons[v]) { reasons[v] = "length"; cutAny = true; } }
    });
  }
  if (cutAny) runs = runsFrom(breaksNow());

  // A short orphan chord next to a curve joins it, unless the break between them is a junction or a change of direction.
  if (runs.length > 1) {
    for (let r = 0; r < runs.length; r++) {
      const run = runs[r];
      if (!run || run.segs.length !== 1) continue;
      const seg = run.segs[0];
      const options = [];
      for (const [other, joint, before] of [[(r + runs.length - 1) % runs.length, seg, true], [(r + 1) % runs.length, (seg + 1) % n, false]]) {
        const o = runs[other];
        if (!o || other === r || o.segs.length < curve.MIN_SEGMENTS) continue;
        if (reasons[joint] !== "sharp" && reasons[joint] !== "sagitta") continue;
        if (len[seg] >= median(o.segs.map((q) => len[q]))) continue;
        options.push({ other, joint, before, turn: Math.abs(turn[joint]) });
      }
      if (options.length === 0) continue;
      options.sort((p, q) => p.turn - q.turn);
      const { other, joint, before } = options[0];
      runs[other] = { segs: before ? [...runs[other].segs, seg] : [seg, ...runs[other].segs] };
      reasons[joint] = null; // the orphan's far end stays a break
      runs[r] = null;
    }
    runs = runs.filter(Boolean);
  }
  return { idx, n, P, len, reasons, runs };
}

// The plan for a set of polygons, from their rings alone (no view coordinates): which segments make which labels.
//   polygons   [[ring, ...], ...] the parcels to label
//   neighbors  [[ring, ...], ...] other parcels whose vertices count only for junction detection (not labeled)
//   options    { unit, curve }; curve.ENABLED false gives the plain one-label-per-edge plan
// plan.count is the number of labels it would produce (runs, before the on-screen size filter and the shared-boundary
// dedupe), plan.breaks the number of breaks by reason.
export function planEdges(polygons, { neighbors = [], unit = "us-feet", curve = {} } = {}) {
  if (!curve.ENABLED) {
    return { legacy: true, polygons, count: polygons.reduce((t, rings) => t + countEdges(rings), 0), breaks: emptyBreaks() };
  }
  const feetPerMeter = 1 / (METERS_PER_FOOT[unit] ?? METERS_PER_FOOT["us-feet"]);
  const tol = Math.max((curve.JUNCTION_TOL_FT ?? 0.05) / feetPerMeter, 1e-9);
  const index = makeVertexIndex(tol);
  registerRings(index, polygons.flat());
  if (curve.JUNCTIONS) for (const rings of neighbors) registerRings(index, rings);
  const ctx = { curve, feetPerMeter, index };
  const breaks = emptyBreaks();
  let count = 0;
  const parcels = polygons.map((rings) => {
    const units = [];
    rings.forEach((ring, ringIndex) => {
      const a = analyzeRing(ring, ctx);
      for (const r of a.reasons) if (r) breaks[r]++;
      for (const run of a.runs) {
        const groups = run.segs.length >= curve.MIN_SEGMENTS ? [run.segs] : run.segs.map((s) => [s]);
        for (const segs of groups) {
          const vertices = [...segs.map((s) => s), (segs[segs.length - 1] + 1) % a.n]; // vertex positions in a.idx
          const ids = vertices.map((v) => index.at(a.P[v][0], a.P[v][1]).id);
          const lengths = segs.map((s) => a.len[s]);
          const lengthM = lengths.reduce((t, l) => t + l, 0);
          if (lengthM === 0) continue;
          units.push({
            ringIndex,
            ringVertices: vertices.map((v) => a.idx[v]), // indices into the original ring (and its projected copy)
            lengths,
            lengthM,
            keys: segs.map((_, k) => (ids[k] < ids[k + 1] ? `${ids[k]}|${ids[k + 1]}` : `${ids[k + 1]}|${ids[k]}`)),
          });
          count++;
        }
      }
    });
    return units;
  });
  return { legacy: false, polygons, parcels, count, breaks };
}

export const emptyBreaks = () => ({ junction: 0, sharp: 0, inflection: 0, sagitta: 0, length: 0 });

// The labels for a plan: [{ x, y, angleDeg, lengthM, text, segments }]. `viewPolygons` is `polygons` projected into the
// view (same shape); positions and angles come from it. A run is labeled halfway along its length with the angle of the
// segment there. Runs are accepted shortest first, and a run is dropped when every one of its segments is already
// covered by an accepted run, so a boundary shared by parcels is labeled once but a long run never replaces two shorter
// ones, and a run only partly covered is kept.
export function labelEdges(plan, options = {}) {
  const { unit = "us-feet", decimals = 1, viewPolygons, unitsPerPixel, minEdgePx, rotationDeg = 0 } = options;
  if (plan.legacy) {
    const all = plan.polygons.flatMap((rings, i) =>
      buildEdges(rings, { unit, decimals, viewRings: viewPolygons?.[i], unitsPerPixel, minEdgePx, rotationDeg }));
    return dedupeEdges(all);
  }
  const candidates = [];
  plan.parcels.forEach((units, p) => {
    for (const u of units) {
      const view = viewPolygons?.[p]?.[u.ringIndex] ?? plan.polygons[p][u.ringIndex];
      const pts = u.ringVertices.map((i) => view[i]);
      const onScreen = pts.slice(1).reduce((t, q, k) => t + Math.hypot(q[0] - pts[k][0], q[1] - pts[k][1]), 0);
      if (unitsPerPixel && minEdgePx && onScreen / unitsPerPixel < minEdgePx) continue;
      candidates.push({ u, pts });
    }
  });
  candidates.sort((a, b) => a.u.lengthM - b.u.lengthM); // stable: ties keep parcel order
  const covered = new Set();
  const out = [];
  for (const { u, pts } of candidates) {
    if (u.keys.every((k) => covered.has(k))) continue;
    u.keys.forEach((k) => covered.add(k));
    let x, y, a, b;
    if (u.lengths.length === 1) {
      [a, b] = pts;
      x = (a[0] + b[0]) / 2;
      y = (a[1] + b[1]) / 2;
    } else {
      let target = u.lengthM / 2;
      let s = 0;
      while (s < u.lengths.length - 1 && target > u.lengths[s]) target -= u.lengths[s++];
      const t = u.lengths[s] === 0 ? 0 : Math.min(1, target / u.lengths[s]);
      a = pts[s];
      b = pts[s + 1];
      x = a[0] + t * (b[0] - a[0]);
      y = a[1] + t * (b[1] - a[1]);
    }
    out.push({ x, y, angleDeg: uprightAngle(a, b, rotationDeg), lengthM: u.lengthM, text: formatFeet(u.lengthM, { unit, decimals }), segments: u.lengths.length });
  }
  return out;
}
