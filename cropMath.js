// Pure arithmetic for the sheet: cropping and the stated scale. No DOM and no SDK imports, so it can be tested alone.
// Ported from PlanView.normCrop and from onMeasure / useMeasuredScale in the georeferencer, which did this inline.
// Page space is PDF points, origin top-left, y down. A crop is { x0, y0, x1, y1 } in points.

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// A crop kept inside the page, with x0 < x1 and y0 < y1, at least `min` points on each side.
export function normCrop(x0, y0, x1, y1, pageW, pageH, min = 8) {
  let a = clamp(Math.min(x0, x1), 0, pageW);
  let b = clamp(Math.max(x0, x1), 0, pageW);
  let c = clamp(Math.min(y0, y1), 0, pageH);
  let d = clamp(Math.max(y0, y1), 0, pageH);
  if (b - a < min) {
    b = Math.min(pageW, a + min);
    a = b - min;
  }
  if (d - c < min) {
    d = Math.min(pageH, c + min);
    c = d - min;
  }
  return { x0: a, y0: c, x1: b, y1: d };
}

// The crop a freshly opened page starts with: the whole page (no crop until the user draws one). margin: a share of the
// page left off each side, 0 by default.
export const defaultCrop = (pageW, pageH, margin = 0) => ({ x0: pageW * margin, y0: pageH * margin, x1: pageW * (1 - margin), y1: pageH * (1 - margin) });

// Whether a crop is the whole page (within `tol` points), i.e. no crop: the sheet pane then shows no crop frame, and a
// drag on the page draws a new one.
export const isWholePage = (crop, pageW, pageH, tol = 0.5) => !!crop && crop.x0 <= tol && crop.y0 <= tol && crop.x1 >= pageW - tol && crop.y1 >= pageH - tol;

// Is a crop (from an earlier page or a saved plan) still good for this page?
export function cropFits(crop, pageW, pageH, min = 8) {
  return !!crop && crop.x0 >= 0 && crop.y0 >= 0 && crop.x1 <= pageW + 0.5 && crop.y1 <= pageH + 0.5 && crop.x1 - crop.x0 > min && crop.y1 - crop.y0 > min;
}

// The crop from four typed numbers (strings or numbers): { crop } or { error } when one isn't a number or the crop is too small.
export function cropFromInputs([a, b, c, d], pageW, pageH, min = 8) {
  const v = [a, b, c, d].map((x) => (x === "" || x === null || x === undefined ? NaN : Number(x)));
  if (v.some((x) => !Number.isFinite(x))) return { error: "Enter four numbers for the crop." };
  const crop = { x0: clamp(Math.min(v[0], v[2]), 0, pageW), y0: clamp(Math.min(v[1], v[3]), 0, pageH), x1: clamp(Math.max(v[0], v[2]), 0, pageW), y1: clamp(Math.max(v[1], v[3]), 0, pageH) };
  if (crop.x1 - crop.x0 < min || crop.y1 - crop.y0 < min) return { error: `The crop needs to be at least ${min} points wide and tall.` };
  return { crop };
}

export const cropInches = (crop) => ({ w: (crop.x1 - crop.x0) / 72, h: (crop.y1 - crop.y0) / 72 });

// ---- the stated scale

// The reductions a print is usually made at; a measured value close to one snaps to it.
export const REDUCTION_PRESETS = [100, 75, 66.67, 50, 33.33, 25];

// scale: { perInch, unit: "ft" | "m", reduction } ("1 in = perInch, printed at reduction % of the original sheet").
// Two clicks on the sheet, dPt points apart, read as inches on the page and as ground distance at that scale.
export function measureOnSheet(dPt, scale) {
  const inches = dPt / 72;
  return { inches, ground: (inches * scale.perInch) / (scale.reduction / 100) };
}

// The "printed at" percentage that makes a measured distance (inches on the page) equal a known ground distance, given
// the stated 1 in = perInch. Within 1.5% of a usual reduction it snaps to it. Rounded to two decimals; null if unusable.
export function reductionFromKnown({ inches, perInch, known }) {
  if (!(inches > 0) || !(perInch > 0) || !(known > 0)) return null;
  let red = ((inches * perInch) / known) * 100;
  const snap = REDUCTION_PRESETS.find((v) => Math.abs(red / v - 1) < 0.015);
  if (snap) red = snap;
  return +red.toFixed(2);
}
