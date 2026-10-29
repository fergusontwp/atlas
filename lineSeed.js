// A rough placement of a long sheet along a selected line (a road centerline). No DOM and no SDK imports, so it can be
// tested alone; everything is planar in the working CRS (US survey feet).
//
// It returns ONE whole-sheet placement T = { cx, cy, fpp, theta } (chainFit.js) with the scale locked to the stated
// scale. It creates no pins: the user adds pins where the plan needs them. A centerline is only an approximation of where
// the plan's road row lies, so this is a starting point, not an accurate placement.
//
// How: walk the plan's length (W·fpp) along the line from the start the user clicked (or from the line's start when the
// line is about as long as the plan), take points every spacingFt of arc length, pair the point at arc length s with
// the sheet point at column s / fpp on the road row (the baseline), and fit one similarity through those pairs with the
// scale held (chainFit.fitWhole). On a curve that centres the straight sheet on the curve, so the miss is shared by both
// ends. The samples are internal: they are returned for checking, never shown or kept.

import { fitWhole } from "./chainFit.js";

const segLen = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);

// A path with repeated vertices dropped, and its cumulative lengths.
function measure(path) {
  const pts = [];
  for (const p of path ?? []) if (Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]) && (!pts.length || segLen(pts.at(-1), p) > 0)) pts.push([p[0], p[1]]);
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + segLen(pts[i - 1], pts[i]));
  return { pts, cum, length: cum.at(-1) ?? 0 };
}

// The point at arc length s (clamped to the path).
export function pointAt({ pts, cum, length }, s) {
  if (s <= 0) return pts[0].slice();
  if (s >= length) return pts.at(-1).slice();
  let i = 1;
  while (cum[i] < s) i++;
  const t = (s - cum[i - 1]) / (cum[i] - cum[i - 1]);
  return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t];
}

// The arc length of the point on the path nearest to xy, and how far xy is from it.
export function project({ pts, cum }, [x, y]) {
  let best = { s: 0, d: Infinity };
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1], [bx, by] = pts[i], dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L2));
    const d = Math.hypot(ax + dx * t - x, ay + dy * t - y);
    if (d < best.d) best = { s: cum[i - 1] + t * Math.sqrt(L2), d };
  }
  return best;
}

// in: {
//   paths         the line's parts, each an ordered list of [x, y] in the working CRS (full precision)
//   sheet         { W, H } in sheet units (the crop in page points)
//   fpp           the stated scale, feet per sheet unit
//   baselineRow   the road row on the sheet (sheet units from the top); default H / 2
//   click         [x, y] where the user put the plan's left end, or null
//   flipped       walk the line the other way (the sheet itself is not turned)
//   spacingFt     sample spacing along the line (PLANS.SEED.SAMPLE_SPACING_FT)
//   autoStartTol  a line within this share of the plan's length starts at its own start (PLANS.SEED.AUTO_START_TOL)
// }
// Returns { ok: true, T, pathIndex, startXY, lineFt, planFt, coveredFt, missingFt, autoStart, samples } or
// { ok: false, reason }: "no-line" (nothing to walk), "no-scale", "need-start" (a click is needed), "at-end" (the start is
// at the end of the line in the walking direction).
export function seedFromLine({ paths, sheet, fpp, baselineRow, click = null, flipped = false, spacingFt = 100, autoStartTol = 0.1 }) {
  if (!(fpp > 0)) return { ok: false, reason: "no-scale" };
  const parts = (paths ?? []).map(measure).map((m, i) => ({ ...m, i })).filter((m) => m.pts.length >= 2 && m.length > 0);
  if (!parts.length) return { ok: false, reason: "no-line" };
  // the part nearest the click, or the longest
  const part = click
    ? parts.reduce((best, m) => (project(m, click).d < project(best, click).d ? m : best))
    : parts.reduce((best, m) => (m.length > best.length ? m : best));
  const path = flipped ? measure([...part.pts].reverse()) : part;
  const lineFt = path.length, planFt = sheet.W * fpp;
  const autoStart = Math.abs(lineFt - planFt) <= autoStartTol * planFt;
  let s0;
  if (autoStart) s0 = 0;
  else if (click) s0 = project(path, click).s;
  else return { ok: false, reason: "need-start" };
  const coveredFt = Math.min(planFt, lineFt - s0);
  if (!(coveredFt > 1e-6)) return { ok: false, reason: "at-end" };
  const missingFt = planFt - coveredFt;
  const row = Number.isFinite(baselineRow) ? baselineRow : sheet.H / 2;
  const n = Math.max(1, Math.ceil(coveredFt / spacingFt));
  const samples = [];
  for (let k = 0; k <= n; k++) {
    const ds = Math.min(k * spacingFt, coveredFt);
    samples.push({ id: k, sheet_px: [ds / fpp, row], target_xy: pointAt(path, s0 + ds) });
  }
  const T = fitWhole(samples, sheet, { allowScale: false, fppStated: fpp });
  if (!T) return { ok: false, reason: "at-end" };
  return { ok: true, T, pathIndex: part.i, startXY: pointAt(path, s0), lineFt, planFt, coveredFt, missingFt, autoStart, samples };
}

// What a failed seed means, for the Place step.
export function seedProblemText(res) {
  if (!res || res.ok) return "";
  return {
    "no-line": "The selected feature isn't a line to place the sheet along.",
    "no-scale": "Set the plan's stated scale in step 2 first; the sheet is placed at that scale.",
    "need-start": "Click the map where the left end of the plan sits on the line.",
    "at-end": "That is the end of the line in this direction. Click nearer the other end, or flip the direction.",
  }[res.reason] ?? "The sheet couldn't be placed along the line.";
}
