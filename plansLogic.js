// How a plan relates to parcels, as plain logic. No DOM and no SDK imports, so it can be tested alone.
// The Review step (what a new footprint will cover) and the plan list (what covers the selected parcel) both use it.
// A "share" is the part of one parcel's area that a footprint covers: 0 to 1.

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

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

// ---- the plan list for a selected parcel
// A plan is { objectId, attributes, share }: its record and the share of the selected parcel it covers (0 to 1).

// "covers 34% of this parcel"; a plan over the whole parcel says so.
export function coverageText(share) {
  if (share >= 0.995) return "covers all of this parcel";
  return `covers ${Math.max(1, Math.round(share * 100))}% of this parcel`;
}

const dateMs = (plan, F) => (Number.isFinite(plan.attributes[F.DATE]) ? plan.attributes[F.DATE] : -Infinity);

// On this parcel (share at or above `min`) and Neighboring plan found, each newest plan date first (undated last, then
// larger coverage first). Superseded plans are left out unless showSuperseded.
export function groupPlans(plans, { min, F, showSuperseded = false }) {
  const shown = plans.filter((p) => showSuperseded || p.attributes[F.STATUS] !== "superseded");
  const order = (a, b) => dateMs(b, F) - dateMs(a, F) || b.share - a.share || a.objectId - b.objectId;
  const on = shown.filter((p) => classifyCoverage(p.share, min) === "on").sort(order);
  const neighbors = shown.filter((p) => classifyCoverage(p.share, min) === "neighbor").sort(order);
  return { on, neighbors, hiddenSuperseded: plans.length - shown.length };
}

// The parcel-panel button: "Plans" or "Plans (2)". Only plans on the parcel are counted.
export const buttonLabel = (onCount) => (onCount > 0 ? `Plans (${onCount})` : "Plans");

// "2 plans, 3 neighboring"; "No plans for this parcel" when there are none of either kind.
export function blockSummary({ on, neighbors }) {
  if (!on && !neighbors) return "No plans for this parcel.";
  const parts = [];
  if (on) parts.push(plural(on, "plan"));
  if (neighbors) parts.push(`${neighbors} neighboring`);
  return parts.join(", ");
}
