// The wording for the analysis notes and verdicts, in one place. No DOM and no SDK imports, so it can be tested alone.
// The wording is the georeferencer's, apart from plain punctuation. Distances are US survey feet.

import { COVERAGE_MIN } from "./georefAnalysis.js";

const ft = (v) => `${v.toFixed(2)} ft`;
const pct = (v) => `${Math.round(v * 100)}%`;
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

const WORDING = {
  "need-points": ({ missing }) => `Add ${plural(missing, "more point")} to see the overlay.`,
  degenerate: () => "These points can't define a transform: they are (nearly) on top of each other or in a straight line. Add points elsewhere on the sheet.",
  "exact-fit": ({ n }) => `With ${n} points the fit passes through them exactly, so residuals can't reveal a mistake. Add at least one more.`,
  "poor-coverage": ({ x, y }) => {
    const spans = [];
    if (x < COVERAGE_MIN) spans.push(`${pct(x)} of the width`);
    if (y < COVERAGE_MIN) spans.push(`${pct(y)} of the height`);
    return `Your points span only ${spans.join(" and ")} of the crop. Spread them toward the edges to pin down rotation and scale.`;
  },
  "scale-mismatch": ({ ratio, suggestedReduction }) =>
    `The fitted scale is ${(ratio * 100).toFixed(1)}% of the stated one. If the PDF is a reduced or enlarged print, set "Printed at" to about ${suggestedReduction.toFixed(suggestedReduction < 10 ? 1 : 0)}%; otherwise check the scale or a bad point.`,
  "affine-stretch": ({ stretch }) => `X and Y scale differ by ${(Math.abs(stretch) * 100).toFixed(2)}%, so the sheet may have been stretched when printed.`,
  "affine-mirror": () => "The affine fit mirrors the sheet. Two points are probably paired with the wrong corners.",
  outlier: ({ id, loo }) => `Point ${id} stands out (${ft(loo)} from where the other points put it). Recheck its pair, or untick it to see the fit without it.`,
  "residuals-large": ({ value }) => `Residuals are large (${ft(value)}). Recheck the points or try the affine fit.`,
  agree: ({ value }) => `Points agree to within ${ft(value)}. For an independent check, zoom to a corner you did not use.`,
};

// { level, text } for one note from analyze().
export function noteText(note) {
  const make = WORDING[note.code];
  return { level: note.level, text: make ? make(note.values ?? {}) : note.code };
}

export const VERDICT_LABEL = { good: "Good", ok: "Okay", review: "Needs a look", unchecked: "Unchecked" };

// The text of the verdict chip: "Good · 0.42 ft", or "Unchecked · add a point" when the fit can't check itself.
export function verdictText(quality, errorFt) {
  const word = VERDICT_LABEL[quality];
  if (!word) return "";
  return quality === "unchecked" ? `${word} · add a point` : `${word} · ${ft(errorFt)}`;
}

// What a point's error is called in the residual table, or a dash when there is none.
export const errorText = (v) => (Number.isFinite(v) ? ft(v) : "—");

export const ACCURACY_CLASS_LABEL = { A: "Class A", B: "Class B", C: "Class C", U: "Unchecked" };
