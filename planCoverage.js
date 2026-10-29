import { GEOREF, PLANS, WHATS_HERE } from "./config.js";
import { PLANS_TEXT, coverageShare, fillText } from "./plansLogic.js";

// ---- how a plan footprint relates to a selected feature that isn't a parcel (a parcel keeps plansQuery's own share)
// Pure: the geometry operators are passed in, so the rules can be tested with stand-ins. Everything is planar, in the
// working CRS (feet), with full-precision geometry.
//   ops: { intersection(a, b), area(g), length(g), contains(polygon, [x, y]), shrink(polygon, ft) }
// Each returns { group: "on" | "neighbor", detail, rank? }: detail is the list's text ("840 ft of the line"), rank orders
// the plans (along a line from its start; by distance from a point), and a polygon keeps the parcel order (none).

const pct = (v) => `${Math.max(1, Math.round(v * 100))}`;

// A polygon: on when the plan covers at least `min` of the feature, or at least `min` of the plan is inside the feature
// (a plan well inside a large zoning district). Areas are absolute: a ring wound the other way has a negative area.
export function polygonCoverage(feature, footprint, ops, { min = PLANS.COVER_MIN, text = PLANS_TEXT } = {}) {
  const inside = ops.intersection(footprint, feature);
  const part = inside ? Math.abs(ops.area(inside)) : 0;
  const share = coverageShare(part, Math.abs(ops.area(feature)));
  const footprintShare = coverageShare(part, Math.abs(ops.area(footprint)));
  const byFootprint = share < min && footprintShare >= min;
  return {
    group: share >= min || footprintShare >= min ? "on" : "neighbor",
    share, footprintShare,
    detail: byFootprint ? fillText(text.POLYGON_PLAN_INSIDE, { pct: pct(footprintShare) }) : fillText(text.POLYGON_SHARE, { pct: pct(share) }),
  };
}

// A line: the length of it inside the footprint, which is shrunk by toleranceFt first so a line along the footprint's
// edge doesn't count. On from minOverlapFt; anything less (a touch, or only inside the search buffer) is neighboring.
// rank: how far along the line, from its start, the overlap begins (or, with none, the nearest point to the footprint's
// middle), so a road's plans read from one end to the other.
export function lineCoverage(line, footprint, ops, { minOverlapFt = PLANS.SEARCH.LINE_MIN_OVERLAP_FT, toleranceFt = WHATS_HERE.STRICT_TOLERANCE_FT, text = PLANS_TEXT } = {}) {
  let inner = footprint;
  if (toleranceFt > 0) {
    try { inner = ops.shrink(footprint, toleranceFt) || footprint; } catch { /* a footprint too small to shrink keeps its outline */ }
  }
  const inside = ops.intersection(line, inner);
  const overlapFt = inside ? ops.length(inside) : 0;
  const starts = overlapFt > 0 ? (inside.paths ?? []).flat() : [];
  const rank = starts.length
    ? Math.min(...starts.map((v) => alongLine(line.paths, v)))
    : alongLine(line.paths, ringsCentroid(footprint.rings));
  return {
    group: overlapFt >= minOverlapFt ? "on" : "neighbor",
    overlapFt, rank,
    detail: overlapFt >= 1 ? fillText(text.LINE_OVERLAP, { ft: Math.round(overlapFt).toLocaleString("en-US") }) : text.LINE_NEAR,
  };
}

// A point (or the points of a multipoint): on when the footprint contains it, otherwise neighboring (it was only inside
// the search buffer). rank: the distance from the point to the footprint's middle.
export function pointCoverage(point, footprint, ops, { text = PLANS_TEXT } = {}) {
  const points = Array.isArray(point.points) ? point.points : [[point.x, point.y]];
  const inside = points.some((p) => ops.contains(footprint, p));
  const [cx, cy] = ringsCentroid(footprint.rings);
  const rank = Math.min(...points.map(([x, y]) => Math.hypot(x - cx, y - cy)));
  return { group: inside ? "on" : "neighbor", rank, detail: inside ? text.POINT_INSIDE : text.POINT_NEAR };
}

// The one for the subject's kind (searchSubject.js): "polygon", "line" or "point".
export function featureCoverage(kind, geometry, footprint, ops, cfg) {
  if (kind === "line") return lineCoverage(geometry, footprint, ops, cfg);
  if (kind === "point") return pointCoverage(geometry, footprint, ops, cfg);
  return polygonCoverage(geometry, footprint, ops, cfg);
}

// How far along a polyline (paths in order, each from its first vertex) the point on it nearest to [x, y] lies.
export function alongLine(paths, [x, y]) {
  let best = Infinity;
  let bestAlong = 0;
  let before = 0;
  for (const path of paths ?? []) {
    for (let i = 1; i < path.length; i++) {
      const [x0, y0] = path[i - 1];
      const [x1, y1] = path[i];
      const dx = x1 - x0, dy = y1 - y0;
      const len2 = dx * dx + dy * dy;
      const t = len2 > 0 ? Math.min(1, Math.max(0, ((x - x0) * dx + (y - y0) * dy) / len2)) : 0;
      const d = Math.hypot(x0 + t * dx - x, y0 + t * dy - y);
      if (d < best - 1e-9) { best = d; bestAlong = before + t * Math.sqrt(len2); }
      before += Math.sqrt(len2);
    }
  }
  return bestAlong;
}

// The area-weighted middle of a polygon's rings (the mean of its vertices when it has no area).
export function ringsCentroid(rings) {
  let a = 0, cx = 0, cy = 0, n = 0, sx = 0, sy = 0;
  for (const ring of rings ?? []) {
    for (let i = 0; i < ring.length; i++) {
      const [x0, y0] = ring[i];
      const [x1, y1] = ring[(i + 1) % ring.length];
      const cross = x0 * y1 - x1 * y0;
      a += cross;
      cx += (x0 + x1) * cross;
      cy += (y0 + y1) * cross;
      sx += x0; sy += y0; n++;
    }
  }
  if (Math.abs(a) > 1e-9) return [cx / (3 * a), cy / (3 * a)];
  return n ? [sx / n, sy / n] : [0, 0];
}

// The SDK side of "which parcels does this footprint cover": the parcels it reaches, and the share of each it covers
// (area of footprint intersect parcel, over the parcel's area, planar in the parcel layer's own spatial reference, as
// What's in this parcel does its amounts). Like What's in this parcel, the footprint is shrunk inward by
// WHATS_HERE.STRICT_TOLERANCE_FT for the query, so a parcel the footprint only touches along an edge is ignored.
// The parcel layer's definitionExpression applies, so a filtered-out parcel isn't counted.

const FEET_TO_METERS = 1200 / 3937;

async function sdk() {
  const [Polygon, Multipoint, SpatialReference, projectOperator, bufferOperator, intersectionOperator, areaOperator, unionOperator] = await $arcgis.import([
    "@arcgis/core/geometry/Polygon.js",
    "@arcgis/core/geometry/Multipoint.js",
    "@arcgis/core/geometry/SpatialReference.js",
    "@arcgis/core/geometry/operators/projectOperator.js",
    "@arcgis/core/geometry/operators/bufferOperator.js",
    "@arcgis/core/geometry/operators/intersectionOperator.js",
    "@arcgis/core/geometry/operators/areaOperator.js",
    "@arcgis/core/geometry/operators/unionOperator.js",
  ]);
  if (!projectOperator.isLoaded()) await projectOperator.load();
  return { Polygon, Multipoint, SpatialReference, projectOperator, bufferOperator, intersectionOperator, areaOperator, unionOperator };
}

// Points [[x, y], ...] in the working CRS as points in another spatial reference (the points go in one Multipoint).
export async function projectPoints(points, targetSR, workWkid = GEOREF.WORKING_WKID) {
  const { Multipoint, SpatialReference, projectOperator } = await sdk();
  const from = new SpatialReference({ wkid: workWkid });
  if (from.equals(targetSR)) return points.map((p) => [p[0], p[1]]);
  const out = projectOperator.execute(new Multipoint({ points, spatialReference: from }), targetSR);
  if (!out || out.points.length !== points.length) throw new Error("Couldn't project the footprint into the layer's coordinate system.");
  return out.points;
}

// parcel: the parcel FeatureLayer; ring: the footprint's closed ring in the working CRS, or rings: one per piece of a
// plan saved in pieces (their union is the footprint).
// Resolves to { shares: [{ share, rings }], overflow, footprint, footprints } with rings, footprint (the first ring) and
// footprints (every ring) in the parcel layer's spatial reference (so the Review step can draw them), shares sorted
// largest first.
export async function footprintCoverage({ parcel, ring, rings, workWkid = GEOREF.WORKING_WKID, signal }) {
  const { Polygon, bufferOperator, intersectionOperator, areaOperator, unionOperator } = await sdk();
  const sr = parcel.spatialReference;
  const list = rings ?? [ring];
  const closedAll = await Promise.all(list.map((r) => projectPoints(r, sr, workWkid)));
  const closed = closedAll[0];
  const parts = closedAll.map((r) => new Polygon({ rings: [r], spatialReference: sr }));
  const footprint = parts.length > 1 ? unionOperator.executeMany(parts) ?? parts[0] : parts[0];
  let search = footprint;
  const tol = Math.max(0, Number(WHATS_HERE.STRICT_TOLERANCE_FT) || 0) * FEET_TO_METERS;
  if (tol > 0) {
    try {
      const shrunk = bufferOperator.execute(footprint, -tol, { unit: "meters" });
      if (shrunk?.extent) search = shrunk;
    } catch (err) {
      console.warn("Couldn't shrink the footprint for the overlap tolerance; using its full outline:", err);
    }
  }
  const where = parcel.definitionExpression && String(parcel.definitionExpression).trim() ? parcel.definitionExpression : "1=1";
  const max = PLANS.REVIEW_MAX_PARCELS;
  const { features } = await parcel.queryFeatures(
    { where, geometry: search, spatialRelationship: "intersects", returnGeometry: true, outFields: [], num: max + 1, outSpatialReference: sr },
    { signal },
  );
  const overflow = features.length > max;
  const shares = features.slice(0, max).filter((f) => f.geometry).map((f) => {
    const whole = Math.abs(areaOperator.execute(f.geometry, { unit: "square-meters" }));
    const inside = intersectionOperator.execute(f.geometry, footprint);
    const part = inside ? Math.abs(areaOperator.execute(inside, { unit: "square-meters" })) : 0;
    return { share: coverageShare(part, whole), rings: f.geometry.rings };
  });
  shares.sort((a, b) => b.share - a.share);
  return { shares, overflow, footprint: closed, footprints: closedAll };
}
