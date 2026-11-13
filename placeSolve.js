// One placement tool, two solvers. No DOM and no SDK imports, so it can be tested alone.
//
// The pins are the workspace's control points ({ id, x, y, X, Y, use, snapped }: x, y in page points, y down; X, Y in
// the working CRS). The Place step's fit type picks the solver:
//   "similarity" | "locked" | "affine"   one transform for the whole sheet (georefAnalysis.analyze, as before)
//   "chain"                              a rigid piece between each pair of neighbouring pins (chainFit.js)
// Before a solver has enough pins, a rough whole-sheet placement (the seed: from the selected line, or placed by hand)
// shows the sheet. One pin shifts the seed onto that pin; from the fit's minimum (two for a chain) the solver decides.
//
// Transforms here are page space to ground, X = a·x + b·y + c, Y = d·x + e·y + f (georefTransform's form). A seed is
// always a similarity in that form, so it survives a change of crop like the points do. chainFit works on a "sheet":
// the crop, in page points from its top-left corner ({ W, H } = the crop's size), with pins as sheet_px / target_xy.

import { analyze } from "./georefAnalysis.js";
import { applyT, mkT } from "./georefTransform.js";
import { affineFromT, buildChain, chainProblemText, seamStats } from "./chainFit.js";

export const FIT_TYPES = ["similarity", "locked", "affine", "chain"];

const rad = (d) => (d * Math.PI) / 180;

// The sheet chainFit works on: the crop in page points.
export const cropSheet = (crop) => ({ W: crop.x1 - crop.x0, H: crop.y1 - crop.y0 });

// The used points as chainFit pins, on the crop's sheet.
export const pinsOf = (points, crop) => points.filter((p) => p.use !== false).map((p) => ({ id: p.id, sheet_px: [p.x - crop.x0, p.y - crop.y0], target_xy: [p.X, p.Y] }));

// A sheet placement { cx, cy, fpp, theta } (fpp in feet per page point) as a page-space similarity.
export function toPageT(T, crop) {
  const t = affineFromT(T, cropSheet(crop));
  return mkT("similarity", t.A, t.B, t.C - t.A * crop.x0 - t.B * crop.y0, t.D, t.E, t.F - t.D * crop.x0 - t.E * crop.y0);
}

// A page-space similarity as a sheet placement: the ground point under the crop's centre, feet per page point and the
// clockwise rotation in degrees (−180..180).
export function fromPageT(Tp, crop) {
  const [cx, cy] = applyT(Tp, (crop.x0 + crop.x1) / 2, (crop.y0 + crop.y1) / 2);
  return { cx, cy, fpp: Math.hypot(Tp.a, Tp.b), theta: (Math.atan2(-Tp.b, Tp.a) * 180) / Math.PI };
}

// The seed shifted so a page point lands on a ground point (one pin only shifts the sheet).
export function shiftTo(Tp, x, y, X, Y) {
  const [px, py] = applyT(Tp, x, y);
  return { ...Tp, c: Tp.c + X - px, f: Tp.f + Y - py };
}

// ---- hand placement of the seed (whole sheet, scale kept)
// Moved by (dX, dY) feet.
export const moveSeed = (Tp, dX, dY) => ({ ...Tp, c: Tp.c + dX, f: Tp.f + dY });
// Turned clockwise by dDeg about a ground point (the sheet's centre, or the one pin).
export function rotateSeed(Tp, dDeg, [px, py]) {
  const c = Math.cos(rad(dDeg)), s = Math.sin(rad(dDeg));
  // clockwise on the ground (y up): (x, y) -> (x·c + y·s, −x·s + y·c), about the pivot
  const rot = (X, Y) => [px + (X - px) * c + (Y - py) * s, py - (X - px) * s + (Y - py) * c];
  const [c2, f2] = rot(Tp.c, Tp.f);
  return mkT(Tp.type ?? "similarity", Tp.a * c + Tp.d * s, Tp.b * c + Tp.e * s, c2, -Tp.a * s + Tp.d * c, -Tp.b * s + Tp.e * c, f2);
}
// The sheet's centre put at a ground point, its rotation set (degrees clockwise) and the scale fpp.
export const seedAt = (crop, { cx, cy, theta = 0, fpp }) => toPageT({ cx, cy, theta, fpp }, crop);

// ---- the two solvers
// cfg: { fitType, crop, seed (page T or null), perPt (stated feet per page point, NaN without a scale), exact (chain:
//        the scale follows the pins), minPinPt, analyze: the georefAnalysis cfg without type (tolerances, crop, scale) }
// Returns {
//   mode      "none" (nothing to show) | "seed" (the rough placement, shifted by one pin) | "fit" (one transform) | "chain"
//   T         the whole-sheet page transform for "seed" and "fit", else null
//   analysis  georefAnalysis's result for a whole-sheet fit, or chainAnalysis's for a chain (T null there)
//   chain     for fitType "chain": { ok, pieces, seams, problem } (pieces: { k, a, b, c0, c1, T, Tp, ids }, columns in
//             page points from the crop's left edge; T the sheet placement, Tp the page transform)
// }
// A chain that can't be built (two pins too close) falls back to one similarity through all the pins and says why.
export function solvePlacement(points, cfg) {
  const { fitType, crop, seed, perPt, exact = true, minPinPt = 0 } = cfg;
  const used = points.filter((p) => p.use !== false);
  const seedFor = () => {
    if (!seed) return null;
    return used.length === 1 ? shiftTo(seed, used[0].x, used[0].y, used[0].X, used[0].Y) : seed;
  };
  const whole = (type) => {
    const analysis = analyze(points, { ...cfg.analyze, type });
    if (analysis.T) return { mode: "fit", T: analysis.T, analysis };
    const T = seedFor();
    return { mode: T ? "seed" : "none", T, analysis };
  };

  if (fitType !== "chain") return { ...whole(fitType), chain: null };
  if (used.length < 2) return { ...whole("similarity"), chain: { ok: false, pieces: [], seams: [], problem: "" } };

  const sheet = cropSheet(crop);
  const allowScale = exact || !(perPt > 0);
  const res = buildChain(pinsOf(points, crop), sheet, { allowScale, fppStated: perPt, minPinPx: minPinPt });
  if (!res.ok) return { ...whole("similarity"), chain: { ok: false, pieces: [], seams: [], problem: chainProblemText(res) } };
  const pieces = res.pieces.map((p) => ({ ...p, Tp: toPageT(p.T, crop), ids: [res.pins[p.a].id, res.pins[p.b].id] }));
  const seams = seamStats(res.pieces, sheet, res.pins);
  return { mode: "chain", T: null, analysis: chainAnalysis(points, pieces, cfg.analyze), chain: { ok: true, pieces, seams, problem: "" } };
}

// The piece that holds a page x (by its column on the sheet; the nearest at the ends).
export function pieceAtPage(pieces, crop, x) {
  if (!pieces?.length) return null;
  const col = x - crop.x0;
  if (col <= pieces[0].c1) return pieces[0];
  return pieces.find((p) => col <= p.c1) ?? pieces.at(-1);
}

// The analysis of a chain, in georefAnalysis's shape so the Place step's table and verdict read it the same way. Each
// used pin's error is the larger miss of the (one or two) pieces that use it: 0 with an exact fit, half a piece's length
// difference with the scale held. No leave-one-out check: every pin defines the pieces. quality: "unchecked" when every
// pin is exact (nothing checks the placement), otherwise good / ok / review by the worst miss and the tolerances.
// cfg: { tolGood, tolWarn }.
export function chainAnalysis(points, pieces, { tolGood, tolWarn }) {
  const used = points.filter((p) => p.use !== false);
  const miss = new Map();
  for (const piece of pieces) {
    for (const id of piece.ids) {
      const p = used.find((q) => q.id === id);
      const [X, Y] = applyT(piece.Tp, p.x, p.y);
      const r = { rx: X - p.X, ry: Y - p.Y, mag: Math.hypot(X - p.X, Y - p.Y) };
      if (!miss.has(id) || miss.get(id).mag < r.mag) miss.set(id, r);
    }
  }
  const rows = points.map((p) => ({ id: p.id, used: p.use !== false, res: miss.get(p.id) ?? null, loo: NaN, indep: false }));
  const mags = [...miss.values()].map((r) => r.mag);
  const rms = mags.length ? Math.sqrt(mags.reduce((s, m) => s + m * m, 0) / mags.length) : NaN;
  const maxRes = mags.length ? Math.max(...mags) : NaN;
  const quality = !mags.length ? "none" : maxRes < 1e-6 ? "unchecked" : maxRes <= tolGood ? "good" : maxRes <= tolWarn ? "ok" : "review";
  return { type: "chain", minN: 2, n: used.length, nAll: points.length, T: null, info: null, rows, rms, looRms: NaN, maxRes, scale: null, coverage: null, quality, notes: [] };
}

// The readout for the Place step. Per piece: its pins, length on the ground (feet), scale against the stated scale (as a
// percent change; null without a stated scale) and rotation; per seam: kink, jog at the pin and at the sheet edges. Each
// value outside its limit is flagged. warn: PLANS.CHAIN's { WARN_SCALE_PCT, WARN_JOG_FT, WARN_EDGE_JOG_FT, WARN_KINK_DEG }.
export function chainReadout({ pieces, seams }, perPt, warn) {
  const rows = pieces.map((p) => {
    const lengthFt = (p.c1 - p.c0) * p.T.fpp;
    const scalePct = perPt > 0 ? (p.T.fpp / perPt - 1) * 100 : null;
    return { ids: p.ids, lengthFt, scalePct, theta: p.T.theta, warnScale: scalePct !== null && Math.abs(scalePct) > warn.WARN_SCALE_PCT };
  });
  const seamRows = seams.map((s) => ({
    ...s,
    warnKink: Math.abs(s.kink) > warn.WARN_KINK_DEG, warnJog: s.jogPin > warn.WARN_JOG_FT, warnEdge: s.jogEdge > warn.WARN_EDGE_JOG_FT,
  }));
  return { pieces: rows, seams: seamRows };
}
