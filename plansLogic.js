// How a plan relates to parcels, as plain logic. No DOM and no SDK imports, so it can be tested alone.
// The Review step (what a new footprint will cover) and the plan list (what covers the selected parcel) both use it.
// A "share" is the part of one parcel's area that a footprint covers: 0 to 1.

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

// ---- the Plans block's wording, in one place (with the parcel sentences below)
export const PLANS_TEXT = {
  GATE: "Select a feature first, or show a plan on the map", // the faded block's tooltip
  ON_MAP: "Plans on the map", // the list of the plans shown on the map (the whole block with nothing selected)
  ON_PARCEL: "On this parcel",
  ON_FEATURE: "On this feature",
  NEIGHBORING: "Neighboring plan found",
  HEADER: "Plans for: {subject}", // the block's description for a feature that isn't a parcel
  POLYGON_SHARE: "covers {pct}% of the feature",
  POLYGON_PLAN_INSIDE: "{pct}% of the plan is inside the feature",
  LINE_OVERLAP: "{ft} ft of the line",
  LINE_NEAR: "near the line",
  POINT_INSIDE: "contains the point",
  POINT_NEAR: "near the point",
  OVERFLOW: "Only the first {n} plans are listed.",
  LOAD_ERROR: "Couldn't read the plans for this {noun}: {message}",
  HELP_PARCEL: "Open a plan PDF, place it on the map using the parcel corners, check the error and save it as a georeferenced plan.",
  HELP_FEATURE: "Open a plan PDF, place it on the map using the selected feature's vertices and the parcel corners in view, check the error and save it as a georeferenced plan.",
};

// A wording template with its {name} slots filled: fillText("{ft} ft of the line", { ft: 840 }).
export const fillText = (template, values = {}) => String(template ?? "").replace(/\{(\w+)\}/g, (m, k) => (k in values ? String(values[k]) : m));

// Intersection area over parcel area, 0 to 1. A parcel with no area covers nothing.
export function coverageShare(intersectionArea, parcelArea) {
  if (!(parcelArea > 0) || !(intersectionArea > 0)) return 0;
  return Math.min(1, intersectionArea / parcelArea);
}

// "on" when the footprint covers at least `min` of the parcel, else "neighbor".
export const classifyCoverage = (share, min) => (share >= min ? "on" : "neighbor");

// How many parcels a footprint is "on" and how many it only touches, from the share for each parcel it reaches.
export function summarizeCoverage(shares, min) {
  let on = 0;
  let neighbors = 0;
  for (const s of shares) {
    if (!(s > 0)) continue;
    if (classifyCoverage(s, min) === "on") on++;
    else neighbors++;
  }
  return { on, neighbors };
}

const percent = (v) => `${Math.round(v * 100)}%`;

// "Covers 3 parcels, 80% or more of each, and touches 5 others."
export function coverageSentence({ on, neighbors }, min) {
  const at = percent(min);
  if (!on && !neighbors) return "This footprint doesn't reach any parcel in the layer. Check the placement.";
  if (!on) return `This footprint covers no parcel to ${at} or more, and touches ${plural(neighbors, "parcel")}.`;
  const head = `Covers ${plural(on, "parcel")}, ${at} or more of ${on === 1 ? "it" : "each"}`;
  if (!neighbors) return `${head}.`;
  return `${head}, and touches ${neighbors} other${neighbors === 1 ? "" : "s"}.`;
}

// ---- the plan list for the selected feature
// A plan for a parcel is { objectId, attributes, share }: its record and the share of the parcel it covers (0 to 1).
// A plan for any other feature also has { group: "on" | "neighbor", detail, rank? } (planCoverage.js): the group decides
// where it is listed, and rank, when there is one, orders it (along a line, or by distance from a point).

// "covers 34% of this parcel"; a plan over the whole parcel says so.
export function coverageText(share) {
  if (share >= 0.995) return "covers all of this parcel";
  return `covers ${Math.max(1, Math.round(share * 100))}% of this parcel`;
}

const dateMs = (plan, F) => (Number.isFinite(plan.attributes[F.DATE]) ? plan.attributes[F.DATE] : -Infinity);

// On this parcel / feature (share at or above `min`, or group "on") and Neighboring plan found. Plans with a rank are in
// rank order; the others (a parcel's, a polygon's) newest plan date first (undated last, then larger coverage first).
// Superseded plans are left out unless showSuperseded.
export function groupPlans(plans, { min, F, showSuperseded = false }) {
  const shown = plans.filter((p) => showSuperseded || p.attributes[F.STATUS] !== "superseded");
  const groupOf = (p) => p.group ?? classifyCoverage(p.share, min);
  const rank = (p) => (Number.isFinite(p.rank) ? p.rank : 0);
  const order = (a, b) => rank(a) - rank(b) || dateMs(b, F) - dateMs(a, F) || (b.share ?? 0) - (a.share ?? 0) || a.objectId - b.objectId;
  const on = shown.filter((p) => groupOf(p) === "on").sort(order);
  const neighbors = shown.filter((p) => groupOf(p) === "neighbor").sort(order);
  return { on, neighbors, hiddenSuperseded: plans.length - shown.length };
}

// The parcel-panel button: "Plans" or "Plans (2)". Only plans on the parcel are counted.
export const buttonLabel = (onCount) => (onCount > 0 ? `Plans (${onCount})` : "Plans");

// "2 plans, 3 neighboring"; "No plans for this parcel" (or feature, the noun) when there are none of either kind.
export function blockSummary({ on, neighbors }, noun = "parcel") {
  if (!on && !neighbors) return `No plans for this ${noun}.`;
  const parts = [];
  if (on) parts.push(plural(on, "plan"));
  if (neighbors) parts.push(`${neighbors} neighboring`);
  return parts.join(", ");
}
