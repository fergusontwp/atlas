import { GEOREF, PLANS, WHATS_HERE } from "./config.js";
import { coverageShare } from "./plansLogic.js";
import { featureCoverage, lineCoverage } from "./planCoverage.js";
import { collectPlans, groupsWhere } from "./planGroup.js";

const FEET_TO_METERS = 1200 / 3937;

// A plan saved in pieces is one plan in the list (planGroup.collectPlans): a search finds the pieces that reach the
// feature, and the rest of each group found is read too (a group's other pieces can lie away from it), so its footprint
// (the union of its pieces) and coverage are the whole plan's. A layer without the group field lists records as before.
async function withWholeGroups(plansLayer, features, outSpatialReference, signal) {
  const F = PLANS.FIELDS;
  if (!F.GROUP_ID || !plansLayer.fieldsIndex?.has(F.GROUP_ID)) return features;
  const where = groupsWhere(F, features.map((f) => f.attributes[F.GROUP_ID]));
  if (!where) return features;
  const oid = plansLayer.objectIdField;
  const have = new Set(features.map((f) => f.attributes[oid]));
  const { features: more } = await plansLayer.queryFeatures({ where, outFields: ["*"], returnGeometry: true, outSpatialReference }, { signal });
  return [...features, ...more.filter((f) => !have.has(f.attributes[oid]))];
}
const recordsOf = (plansLayer, features) => features.map((f) => ({ objectId: f.attributes[plansLayer.objectIdField], attributes: f.attributes, geometry: f.geometry }));

// The plans whose footprints reach a parcel, with the share of the parcel each covers. The parcel is the full-precision
// geometry in its own spatial reference, shrunk inward by WHATS_HERE.STRICT_TOLERANCE_FT for the query (as What's in this
// parcel does), so a plan that only touches the boundary is ignored. Coverage is the area of footprint intersect parcel
// over the parcel's area, planar. Resolves to [{ objectId, attributes, geometry, share }] (geometry in the parcel's
// spatial reference), or null if the parcel is gone.
export async function plansForParcel({ plansLayer, parcelLayer, objectId, signal }) {
  const [bufferOperator, intersectionOperator, areaOperator, unionOperator] = await $arcgis.import([
    "@arcgis/core/geometry/operators/bufferOperator.js",
    "@arcgis/core/geometry/operators/intersectionOperator.js",
    "@arcgis/core/geometry/operators/areaOperator.js",
    "@arcgis/core/geometry/operators/unionOperator.js",
  ]);
  const sr = parcelLayer.spatialReference;
  const { features } = await parcelLayer.queryFeatures({ objectIds: [objectId], returnGeometry: true, outFields: [], outSpatialReference: sr }, { signal });
  const parcel = features[0]?.geometry;
  if (!parcel) return null;
  let search = parcel;
  const tol = Math.max(0, Number(WHATS_HERE.STRICT_TOLERANCE_FT) || 0) * FEET_TO_METERS;
  if (tol > 0) {
    try {
      const shrunk = bufferOperator.execute(parcel, -tol, { unit: "meters" });
      if (shrunk?.extent) search = shrunk;
    } catch (err) {
      console.warn("Couldn't shrink the parcel for the overlap tolerance; using its full outline:", err);
    }
  }
  const res = await plansLayer.queryFeatures(
    { geometry: search, spatialRelationship: "intersects", outFields: ["*"], returnGeometry: true, outSpatialReference: sr, num: PLANS.LIST_MAX + 1 },
    { signal },
  );
  const whole = Math.abs(areaOperator.execute(parcel, { unit: "square-meters" })); // abs: a ring wound the other way gives a negative area
  const found = await withWholeGroups(plansLayer, res.features.slice(0, PLANS.LIST_MAX), sr, signal);
  const list = collectPlans(recordsOf(plansLayer, found), PLANS.FIELDS, {
    union: (gs) => unionOperator.executeMany(gs),
    cover: (geometry) => {
      const inside = intersectionOperator.execute(geometry, parcel);
      const part = inside ? Math.abs(areaOperator.execute(inside, { unit: "square-meters" })) : 0;
      return { share: coverageShare(part, whole) };
    },
  });
  list.overflow = res.features.length > PLANS.LIST_MAX;
  return list;
}

// ---- any other selected feature (searchSubject.js): a polygon, a line or a point

// The shape the Plans layer is searched with, for a subject's kind, in the working CRS (feet). Pure: the operators are
// passed in, ops: { buffer(geometry, ft), generalize(geometry, ft) }, each returning a geometry or null.
// A polygon is shrunk inward by toleranceFt, so a plan that only touches its edge isn't found (its full outline when the
// shrink leaves nothing); a line is buffered by lineBufferFt and a point by pointBufferFt, since digitized centerlines and
// points sit a little off the plans. The result is generalized by generalizeFt, so a long line's thousands of vertices
// don't make a huge request (the coverage uses the full-precision geometry). Returns { geometry, fullOutline }:
// fullOutline is true when a polygon couldn't be shrunk.
export function queryShape(kind, geometry, ops, {
  toleranceFt = WHATS_HERE.STRICT_TOLERANCE_FT, lineBufferFt = PLANS.SEARCH.LINE_BUFFER_FT,
  pointBufferFt = PLANS.SEARCH.POINT_BUFFER_FT, generalizeFt = PLANS.SEARCH.QUERY_GENERALIZE_FT,
} = {}) {
  let shape = geometry;
  let fullOutline = false;
  if (kind === "polygon") {
    const tol = Math.max(0, Number(toleranceFt) || 0);
    if (tol > 0) {
      let shrunk = null;
      try { shrunk = ops.buffer(geometry, -tol); } catch { /* the full outline, below */ }
      if (shrunk) shape = shrunk;
      else fullOutline = true;
    }
  } else {
    shape = ops.buffer(geometry, kind === "line" ? lineBufferFt : pointBufferFt) ?? geometry;
  }
  if (generalizeFt > 0) {
    try { shape = ops.generalize(shape, generalizeFt) ?? shape; } catch { /* the shape as it is */ }
  }
  return { geometry: shape, fullOutline };
}

// Every plan the query matches, up to max, paging when the service stops at its own record limit
// (exceededTransferLimit). Pages only where the layer supports it (capabilities.query.supportsPagination); otherwise one
// request. Resolves to { features, overflow }: overflow when there were more than max (or more than the service would
// return without paging).
export async function queryPaged(layer, query, { max, signal }) {
  const pageable = layer.capabilities?.query?.supportsPagination === true;
  const features = [];
  for (;;) {
    const page = pageable ? { start: features.length, num: max + 1 - features.length } : { num: max + 1 };
    const res = await layer.queryFeatures({ ...query, ...page }, { signal });
    features.push(...res.features);
    if (features.length > max) return { features: features.slice(0, max), overflow: true };
    if (!res.exceededTransferLimit) return { features, overflow: false };
    if (!pageable || !res.features.length) return { features, overflow: true };
  }
}

// The plans for a selected feature (searchSubject.js). A parcel is searched exactly as before (plansForParcel). Anything
// else: its full-precision geometry is read from its own layer in the working CRS, searched with queryShape (projected to
// the Plans layer's spatial reference), and each plan's footprint (read back in the working CRS) is measured against it
// with planCoverage.featureCoverage (a plan in pieces: its union, ordered along a line by its first piece). Resolves to
// [{ objectId, attributes, geometry, pieces, pieceCount, group, detail, rank?, share? }] with list.overflow and
// list.fullOutline, or null when the feature is gone.
export async function plansForSubject({ plansLayer, parcelLayer, subject, signal }) {
  if (subject.isParcel) return plansForParcel({ plansLayer, parcelLayer, objectId: subject.oid, signal });
  const [SpatialReference, Point, projectOperator, bufferOperator, generalizeOperator, intersectionOperator, areaOperator, lengthOperator, containsOperator, unionOperator] = await $arcgis.import([
    "@arcgis/core/geometry/SpatialReference.js",
    "@arcgis/core/geometry/Point.js",
    "@arcgis/core/geometry/operators/projectOperator.js",
    "@arcgis/core/geometry/operators/bufferOperator.js",
    "@arcgis/core/geometry/operators/generalizeOperator.js",
    "@arcgis/core/geometry/operators/intersectionOperator.js",
    "@arcgis/core/geometry/operators/areaOperator.js",
    "@arcgis/core/geometry/operators/lengthOperator.js",
    "@arcgis/core/geometry/operators/containsOperator.js",
    "@arcgis/core/geometry/operators/unionOperator.js",
  ]);
  if (!projectOperator.isLoaded()) await projectOperator.load();
  const workSR = new SpatialReference({ wkid: GEOREF.WORKING_WKID });
  const geometry = await subjectGeometry(subject, workSR, projectOperator, signal);
  if (!geometry) return null;

  // distances and lengths in the working CRS's own unit (US survey feet)
  const shape = queryShape(subject.kind, geometry, {
    buffer: (g, ft) => bufferOperator.execute(g, ft),
    generalize: (g, ft) => generalizeOperator.execute(g, ft),
  });
  const plansSR = plansLayer.spatialReference;
  const search = plansSR && !plansSR.equals(workSR) ? projectOperator.execute(shape.geometry, plansSR) ?? shape.geometry : shape.geometry;
  const { features, overflow } = await queryPaged(plansLayer,
    { geometry: search, spatialRelationship: "intersects", outFields: ["*"], returnGeometry: true, outSpatialReference: workSR },
    { max: PLANS.SEARCH.MAX_PLANS, signal });

  const ops = {
    intersection: (a, b) => intersectionOperator.execute(a, b),
    area: (g) => areaOperator.execute(g),
    length: (g) => lengthOperator.execute(g),
    contains: (polygon, [x, y]) => containsOperator.execute(polygon, new Point({ x, y, spatialReference: workSR })),
    shrink: (g, ft) => bufferOperator.execute(g, -ft),
  };
  const found = await withWholeGroups(plansLayer, features, workSR, signal);
  const list = collectPlans(recordsOf(plansLayer, found), PLANS.FIELDS, {
    union: (gs) => unionOperator.executeMany(gs),
    cover: (footprint, g) => {
      const c = featureCoverage(subject.kind, geometry, footprint, ops);
      // along a line, a plan in pieces is placed by where its first piece is
      if (subject.kind === "line" && g.pieces.length > 1 && g.first.geometry) c.rank = lineCoverage(geometry, g.first.geometry, ops).rank;
      return c;
    },
  });
  list.overflow = overflow;
  list.fullOutline = shape.fullOutline;
  return list;
}

// The subject's geometry at full precision in the working CRS: read again from its layer by object id (a click's geometry
// can be generalized for drawing); the click's own, projected, when the layer can't be asked.
async function subjectGeometry(subject, workSR, projectOperator, signal) {
  const { layer, oid } = subject;
  if (layer?.queryFeatures && oid !== null && oid !== undefined) {
    try {
      const { features } = await layer.queryFeatures({ objectIds: [oid], returnGeometry: true, outFields: [], outSpatialReference: workSR }, { signal });
      if (features[0]?.geometry) return features[0].geometry;
      return null; // the feature is gone
    } catch (err) {
      if (err?.name === "AbortError") throw err;
      console.warn(`Couldn't read the selected feature from "${subject.layerTitle}" at full precision; using the clicked shape:`, err);
    }
  }
  return subject.geometry ? projectOperator.execute(subject.geometry, workSR) : null;
}
