// Fit, residuals, leave-one-out error and plain-language checks for a plan's control points. No DOM and no SDK
// imports, so it can be tested alone. Ported from PG.analyze in georeferencer/js/lib/core.js.
//
// Everything is in the working CRS, which is in US survey feet, so every distance here is in feet. The notes come back
// as data ({ code, level, values }); the wording lives in georefMessages.js.

import { US_SURVEY_FOOT_M, applyT, describeT, fitTransform, minPoints } from "./georefTransform.js";

// Points spanning less than this share of the crop's width or height get a "spread them out" note.
export const COVERAGE_MIN = 0.4;
// A fitted scale this far (as a fraction) from the stated one gets a note, and so does an affine whose X and Y scales differ by this much.
export const SCALE_MISMATCH = 0.02;
export const AFFINE_STRETCH = 0.003;

// Ground feet per PDF point implied by a stated scale: { perInch, unit: "ft" | "m", reduction } is "1 inch = perInch
// feet (or meters)", printed at `reduction` percent of the original sheet. NaN when it can't be worked out.
export function expectedPerPt(scale) {
  const perInch = Number(scale?.perInch);
  const reduction = (Number(scale?.reduction) || 100) / 100;
  if (!(perInch > 0) || !(reduction > 0)) return NaN;
  const feetPerInch = scale.unit === "m" ? perInch / US_SURVEY_FOOT_M : perInch;
  return feetPerInch / reduction / 72;
}

// The accuracy class stored on a plan: the verdict, relabelled. "none" (no fit yet) has no class.
export const ACCURACY_CLASS = { good: "A", ok: "B", review: "C", unchecked: "U" };
export const accuracyClass = (quality) => ACCURACY_CLASS[quality] ?? null;

// The error the verdict is based on: the larger of the RMS residual and the leave-one-out error, in feet.
export function worstError(analysis) {
  return Math.max(analysis.rms || 0, Number.isFinite(analysis.looRms) ? analysis.looRms : 0);
}

// points: [{ id, x, y, X, Y, use }]  (x, y page points, y down; X, Y working CRS feet; use === false leaves a point out)
// cfg: { type, expectedPerPt, reduction, crop: { x0, y0, x1, y1 }, tolGood, tolWarn }   tolerances in feet
//
// Returns { type, minN, n, nAll, T, info, rows, rms, looRms, maxRes, scale, coverage, quality, notes }:
//   rows[i]  { id, used, res: { rx, ry, mag } | null, loo, indep }   predicted minus true, for every point (used or not)
//   rms, maxRes  over the points used; looRms  the leave-one-out RMS (NaN until there is one more point than the minimum)
//   quality  "none" (no fit) | "unchecked" (the fit passes exactly through the points) | "good" | "ok" | "review"
//   notes    [{ code, level: "info" | "good" | "warn" | "bad", values }]
export function analyze(points, cfg) {
  const { tolGood, tolWarn } = cfg;
  if (!(tolGood > 0) || !(tolWarn >= tolGood)) throw new Error("analyze needs the tolerances in feet: 0 < tolGood <= tolWarn");
  const type = cfg.type || "similarity";
  const minN = minPoints(type);
  const used = points.filter((p) => p.use !== false);
  const res = {
    type, minN, n: used.length, nAll: points.length, T: null, info: null,
    rows: points.map((p) => ({ id: p.id, used: p.use !== false, res: null, loo: null, indep: false })),
    rms: NaN, looRms: NaN, maxRes: NaN, scale: null, coverage: null, quality: "none", notes: [],
  };
  const note = (code, level, values = {}) => res.notes.push({ code, level, values });

  if (used.length < minN) {
    note("need-points", "info", { missing: minN - used.length });
    return res;
  }
  const T = fitTransform(used, type, cfg.expectedPerPt);
  if (!T) {
    note("degenerate", "bad");
    return res;
  }
  res.T = T;
  res.info = describeT(T);

  // residuals (predicted minus true) for every point, used or not
  res.rows.forEach((row, i) => {
    const p = points[i];
    const [px, py] = applyT(T, p.x, p.y);
    const rx = px - p.X;
    const ry = py - p.Y;
    row.res = { rx, ry, mag: Math.hypot(rx, ry) };
    if (!row.used) {
      row.loo = row.res.mag; // a point left out of the fit is already an independent check
      row.indep = true;
    }
  });
  const usedRows = res.rows.filter((r) => r.used);
  res.rms = Math.sqrt(usedRows.reduce((s, r) => s + r.res.mag * r.res.mag, 0) / usedRows.length);
  res.maxRes = Math.max(...usedRows.map((r) => r.res.mag));

  // leave-one-out: fit without point i, then see how far off it lands
  if (used.length - 1 >= minN) {
    let ss = 0;
    let count = 0;
    points.forEach((p, i) => {
      if (p.use === false) return;
      const Ti = fitTransform(used.filter((q) => q !== p), type, cfg.expectedPerPt);
      if (!Ti) return;
      const [px, py] = applyT(Ti, p.x, p.y);
      const m = Math.hypot(px - p.X, py - p.Y);
      res.rows[i].loo = m;
      ss += m * m;
      count++;
    });
    if (count) res.looRms = Math.sqrt(ss / count);
  }

  // the fitted scale against the stated one
  if (cfg.expectedPerPt > 0) {
    res.scale = { perPt: res.info.perPt, expectedPerPt: cfg.expectedPerPt, ratio: res.info.perPt / cfg.expectedPerPt };
  }

  // how much of the crop do the points cover?
  if (cfg.crop) {
    const xs = used.map((p) => p.x);
    const ys = used.map((p) => p.y);
    const cw = cfg.crop.x1 - cfg.crop.x0;
    const ch = cfg.crop.y1 - cfg.crop.y0;
    res.coverage = {
      x: cw > 0 ? (Math.max(...xs) - Math.min(...xs)) / cw : 0,
      y: ch > 0 ? (Math.max(...ys) - Math.min(...ys)) / ch : 0,
    };
  }

  // the verdict
  if (used.length <= minN) res.quality = "unchecked";
  else {
    const m = worstError(res);
    res.quality = m <= tolGood ? "good" : m <= tolWarn ? "ok" : "review";
  }

  // plain-language notes
  if (used.length === minN) note("exact-fit", "warn", { n: used.length });
  if (res.coverage && (res.coverage.x < COVERAGE_MIN || res.coverage.y < COVERAGE_MIN)) {
    note("poor-coverage", "warn", { x: res.coverage.x, y: res.coverage.y });
  }
  if (res.scale && type !== "locked" && Math.abs(res.scale.ratio - 1) > SCALE_MISMATCH) {
    note("scale-mismatch", "warn", { ratio: res.scale.ratio, suggestedReduction: (cfg.reduction || 100) / res.scale.ratio });
  }
  if (type === "affine") {
    const stretch = res.info.scaleX / res.info.scaleY - 1;
    if (Math.abs(stretch) > AFFINE_STRETCH) note("affine-stretch", "warn", { stretch });
    if (res.info.det > 0) note("affine-mirror", "bad");
  }
  // An outlier is a point its neighbours can't explain: its leave-one-out error is large in absolute terms and clearly
  // bigger than everyone else's. (Plain residuals hide it, because a least-squares fit bends toward the bad point.)
  const looList = [];
  points.forEach((p, i) => {
    if (res.rows[i].used && res.rows[i].loo != null) looList.push({ i, v: res.rows[i].loo });
  });
  if (looList.length >= 4) {
    looList.sort((a, b) => b.v - a.v);
    const rest = looList.slice(1).map((o) => o.v).sort((a, b) => a - b);
    const median = rest[Math.floor(rest.length / 2)];
    const top = looList[0];
    if (top.v > tolWarn && top.v > 2 * median) note("outlier", "bad", { id: points[top.i].id, loo: top.v });
  }
  if (res.quality === "review") note("residuals-large", "bad", { value: worstError(res) });
  if (res.quality === "good") note("agree", "good", { value: worstError(res) });
  return res;
}
