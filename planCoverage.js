import { GEOREF, PLANS, WHATS_HERE } from "./config.js";
import { coverageShare } from "./plansLogic.js";

// The SDK side of "which parcels does this footprint cover": the parcels it reaches, and the share of each it covers
// (area of footprint intersect parcel, over the parcel's area, planar in the parcel layer's own spatial reference, as
// What's in this parcel does its amounts). Like What's in this parcel, the footprint is shrunk inward by
// WHATS_HERE.STRICT_TOLERANCE_FT for the query, so a parcel the footprint only touches along an edge is ignored.
// The parcel layer's definitionExpression applies, so a filtered-out parcel isn't counted.

const FEET_TO_METERS = 1200 / 3937;

async function sdk() {
  const [Polygon, Multipoint, SpatialReference, projectOperator, bufferOperator, intersectionOperator, areaOperator] = await $arcgis.import([
    "@arcgis/core/geometry/Polygon.js",
    "@arcgis/core/geometry/Multipoint.js",
    "@arcgis/core/geometry/SpatialReference.js",
    "@arcgis/core/geometry/operators/projectOperator.js",
    "@arcgis/core/geometry/operators/bufferOperator.js",
    "@arcgis/core/geometry/operators/intersectionOperator.js",
    "@arcgis/core/geometry/operators/areaOperator.js",
  ]);
  if (!projectOperator.isLoaded()) await projectOperator.load();
  return { Polygon, Multipoint, SpatialReference, projectOperator, bufferOperator, intersectionOperator, areaOperator };
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

// parcel: the parcel FeatureLayer; ring: the footprint's closed ring in the working CRS.
// Resolves to { shares: [{ share, rings }], overflow, footprint } with rings and footprint in the parcel layer's spatial
// reference (so the Review step can draw them), shares sorted largest first.
export async function footprintCoverage({ parcel, ring, workWkid = GEOREF.WORKING_WKID, signal }) {
  const { Polygon, bufferOperator, intersectionOperator, areaOperator } = await sdk();
  const sr = parcel.spatialReference;
  const closed = await projectPoints(ring, sr, workWkid);
  const footprint = new Polygon({ rings: [closed], spatialReference: sr });
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
  return { shares, overflow, footprint: closed };
}
