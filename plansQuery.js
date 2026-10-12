import { PLANS, WHATS_HERE } from "./config.js";
import { coverageShare } from "./plansLogic.js";

const FEET_TO_METERS = 1200 / 3937;

// The plans whose footprints reach a parcel, with the share of the parcel each covers. The parcel is the full-precision
// geometry in its own spatial reference, shrunk inward by WHATS_HERE.STRICT_TOLERANCE_FT for the query (as What's in this
// parcel does), so a plan that only touches the boundary is ignored. Coverage is the area of footprint intersect parcel
// over the parcel's area, planar. Resolves to [{ objectId, attributes, geometry, share }] (geometry in the parcel's
// spatial reference), or null if the parcel is gone.
export async function plansForParcel({ plansLayer, parcelLayer, objectId, signal }) {
  const [bufferOperator, intersectionOperator, areaOperator] = await $arcgis.import([
    "@arcgis/core/geometry/operators/bufferOperator.js",
    "@arcgis/core/geometry/operators/intersectionOperator.js",
    "@arcgis/core/geometry/operators/areaOperator.js",
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
  const list = res.features.slice(0, PLANS.LIST_MAX).map((f) => {
    const inside = f.geometry ? intersectionOperator.execute(f.geometry, parcel) : null;
    const part = inside ? Math.abs(areaOperator.execute(inside, { unit: "square-meters" })) : 0;
    return { objectId: f.attributes[plansLayer.objectIdField], attributes: f.attributes, geometry: f.geometry, share: coverageShare(part, whole) };
  });
  list.overflow = res.features.length > PLANS.LIST_MAX;
  return list;
}
