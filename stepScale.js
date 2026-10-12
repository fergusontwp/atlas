import { h } from "./dom.js";
import { GEOREF } from "./config.js";
import { expectedPerPt } from "./georefAnalysis.js";
import { cropInches, measureOnSheet, reductionFromKnown } from "./cropMath.js";
import { groundFtPerPx, rasterCost, rasterSize, suggestDpi } from "./pageRaster.js";
import { PLANS } from "./config.js";
import { US_SURVEY_FOOT_M } from "./georefTransform.js";
import { field, fmt, note, numberInput, setIfIdle } from "./wsUi.js";

// Step 2: the stated scale (1 in = N ft), "printed at" percent, and the render resolution with a scale-aware suggestion.
export function createStepScale(ctx) {
  const { S } = ctx;
  const limits = { dpi: GEOREF.DPI, maxPixels: GEOREF.MAX_PIXELS, maxSidePx: PLANS.COMPRESSION.MAX_SIDE_PX };

  // ---- the stated scale
  const presetSelect = h("calcite-select", { scale: "s", label: "Scale presets", oncalciteSelectChange: (e) => onPreset(e.target.value) },
    h("calcite-option", { value: "", label: "Choose a scale" }),
    ...GEOREF.SCALE_PRESETS.map((p, i) => h("calcite-option", { value: String(i), label: p.label })),
    h("calcite-option", { value: "other", label: "Other" }));
  const perInchInput = numberInput({ label: "Ground distance for 1 inch", min: 0, step: "any", onChange: () => readScale() });
  const unitSelect = h("calcite-select", { scale: "s", label: "Unit", width: "auto", oncalciteSelectChange: () => readScale() },
    h("calcite-option", { value: "ft", label: "ft", selected: true }), h("calcite-option", { value: "m", label: "m" }));
  const reductionInput = numberInput({ label: "Printed at", min: 1, max: 1000, step: "any", suffix: "%", onChange: () => readScale() });
  const scaleNote = h("div", { class: "plan-note" });

  // ---- measuring a known distance
  const measureButton = h("calcite-button", { appearance: "outline", scale: "s", iconStart: "measure", onclick: () => toggleMeasure() }, "Measure on the sheet");
  const measureOut = h("div", { class: "plan-note" });
  const knownInput = numberInput({ label: "Real distance", min: 0, step: "any", suffix: "ft", width: "9rem" });
  const useMeasured = h("calcite-button", { scale: "s", onclick: () => applyMeasured() }, "Use this scale");
  const knownRow = h("div", { class: "ws-row", hidden: true }, knownInput, useMeasured);
  let measured = null; // { inches }

  // ---- resolution
  const dpiSeg = h("calcite-segmented-control", { scale: "s", width: "full", oncalciteSegmentedControlChange: (e) => setDpi(Number(e.target.value), true) },
    ...GEOREF.DPI.PRESETS.map((d) => h("calcite-segmented-control-item", { value: String(d) }, String(d))));
  const dpiCustom = numberInput({ label: "Custom dpi", min: 36, max: 1200, step: 1, integer: true, suffix: "dpi", width: "9rem", onChange: (v) => Number(v) > 0 && setDpi(Number(v), true) });
  const suggestNote = h("div", { class: "plan-note" });
  const useSuggested = h("calcite-button", { appearance: "outline", scale: "s", onclick: () => setDpi(currentSuggestion().dpi, false), hidden: true }, "Use suggested");
  const resultNote = h("div", { class: "plan-note" });
  const costNote = h("div", { class: "plan-note" });

  const el = h("div", {},
    h("div", { class: "ws-step-title" }, "Stated scale"),
    note("Printed on the plan, for example 1 in = 40 ft. It sets the suggested resolution and checks the fit."),
    field("Scale", presetSelect),
    h("div", { class: "ws-row" }, h("span", {}, "1 in ="), perInchInput, unitSelect),
    field("Printed at", reductionInput, "Use less than 100 if the PDF is a reduced print of the original sheet."),
    scaleNote,
    h("div", { class: "ws-row" }, measureButton),
    measureOut, knownRow,
    h("div", { class: "ws-step-title" }, "Resolution"),
    field("Pixels per inch", dpiSeg), dpiCustom,
    suggestNote, useSuggested, resultNote, costNote,
  );

  // The stated scale in ground feet per page inch, once "printed at" is counted, or null.
  function feetPerPageInch() {
    const perPt = expectedPerPt(S.scale);
    return Number.isFinite(perPt) ? perPt * 72 : null;
  }
  function currentSuggestion() {
    const { w, h: hh } = cropInches(S.crop);
    return suggestDpi({ ftPerInch: feetPerPageInch(), cropWidthIn: w, cropHeightIn: hh }, limits);
  }

  function syncScaleFields() {
    const sc = S.scale;
    setIfIdle(perInchInput, sc.perInch ?? "");
    unitSelect.value = sc.unit;
    knownInput.suffixText = sc.unit === "m" ? "m" : "ft";
    setIfIdle(reductionInput, +sc.reduction.toFixed(2));
    const idx = GEOREF.SCALE_PRESETS.findIndex((p) => p.perInch === sc.perInch && p.unit === sc.unit);
    presetSelect.value = sc.perInch ? (idx >= 0 ? String(idx) : "other") : "";
    const fpi = feetPerPageInch();
    scaleNote.textContent = fpi
      ? Math.abs(sc.reduction - 100) > 0.05
        ? `Printed at ${+sc.reduction.toFixed(2)}%: 1 inch on this PDF is ${+(sc.perInch / (sc.reduction / 100)).toFixed(2)} ${sc.unit} on the ground.`
        : `1 inch on this PDF is ${sc.perInch} ${sc.unit} on the ground.`
      : "No scale yet. The fit works without one; with one it can warn about a wrong scale.";
  }

  function onPreset(value) {
    if (value === "" || value === "other") return;
    const p = GEOREF.SCALE_PRESETS[Number(value)];
    S.scale = { ...S.scale, perInch: p.perInch, unit: p.unit };
    scaleChanged();
  }
  function readScale() {
    const per = Number(perInchInput.value), red = Number(reductionInput.value);
    S.scale = { perInch: per > 0 ? per : null, unit: unitSelect.value === "m" ? "m" : "ft", reduction: red > 0 ? red : S.scale.reduction };
    scaleChanged();
  }
  function scaleChanged() {
    syncScaleFields();
    if (!S.dpiTouched) S.dpi = currentSuggestion().dpi;
    refreshResolution();
    ctx.invalidateRaster();
    ctx.changed("scale");
    ctx.markDirty();
  }

  function setDpi(v, touched) {
    S.dpi = Math.max(36, Math.min(1200, Math.round(v)));
    if (touched) S.dpiTouched = true;
    else S.dpiTouched = false;
    refreshResolution();
    ctx.invalidateRaster();
    ctx.changed("dpi");
    ctx.markDirty();
  }

  function refreshResolution() {
    if (!S.crop) return;
    const sug = currentSuggestion();
    const { W, H } = rasterSize(S.crop, S.dpi);
    const cost = rasterCost(W, H);
    dpiSeg.querySelectorAll("calcite-segmented-control-item").forEach((i) => { i.checked = Number(i.value) === S.dpi; });
    setIfIdle(dpiCustom, S.dpi);
    const fpi = feetPerPageInch();
    suggestNote.textContent = fpi
      ? `Suggested ${sug.wanted} dpi for 1 in = ${+(fpi).toFixed(2)} ft: ${groundFtPerPx(fpi, sug.wanted).toFixed(2)} ft per pixel.`
      : `No stated scale yet, so ${sug.wanted} dpi is the default.`;
    useSuggested.hidden = S.dpi === sug.dpi;
    useSuggested.textContent = `Use ${sug.dpi} dpi`;
    const lines = [];
    if (sug.capped) lines.push(sug.capped === "side" ? `Capped at ${fmt(limits.maxSidePx)} px: ${sug.dpi} dpi.` : `Capped at ${fmt(limits.maxPixels / 1e6)} megapixels: ${sug.dpi} dpi.`);
    resultNote.textContent = lines.join(" ");
    resultNote.hidden = lines.length === 0;
    const tooBig = Math.max(W, H) > limits.maxSidePx || W * H > limits.maxPixels;
    costNote.className = `plan-note${tooBig ? " ws-note-bad" : ""}`;
    costNote.textContent = `${fmt(W)} × ${fmt(H)} px · ${cost.megapixels.toFixed(1)} MP · about ${fmt(cost.memoryMB)} MB in memory${fpi ? ` · ${groundFtPerPx(fpi, S.dpi).toFixed(2)} ft per pixel` : ""}`
      + (tooBig ? `. Too large for this tool: lower the resolution or tighten the crop.` : "");
    S.resolutionOk = !tooBig;
    ctx.refreshNav();
  }

  // ---- measuring
  function toggleMeasure(on = !S.measuring) {
    S.measuring = on;
    measureButton.appearance = on ? "solid" : "outline";
    ctx.sheet.clearMeasure();
    measured = null;
    knownRow.hidden = true;
    measureOut.textContent = on ? "Click both ends of a distance you know, like the graphic bar scale." : "";
    showSheet();
  }
  ctx.sheet.onMeasure = (list) => {
    if (list.length < 2) { measureOut.textContent = "Click the other end."; knownRow.hidden = true; return; }
    const dPt = Math.hypot(list[1].xp - list[0].xp, list[1].yp - list[0].yp);
    const m = measureOnSheet(dPt, { perInch: S.scale.perInch ?? 1, unit: S.scale.unit, reduction: S.scale.reduction });
    measured = { inches: m.inches };
    measureOut.textContent = S.scale.perInch
      ? `${m.inches.toFixed(3)} in on the page = ${m.ground.toFixed(1)} ${S.scale.unit} at this scale.`
      : `${m.inches.toFixed(3)} in on the page. Enter the stated scale first.`;
    knownRow.hidden = !S.scale.perInch;
    knownInput.value = "";
    knownInput.setFocus?.();
  };
  function applyMeasured() {
    const red = reductionFromKnown({ inches: measured?.inches, perInch: S.scale.perInch, known: Number(knownInput.value) });
    if (red == null) { ctx.say("Type the real distance first.", "warn"); return; }
    S.scale = { ...S.scale, reduction: red };
    ctx.say(`Printed at ${red}% of the original sheet.`, "good");
    toggleMeasure(false);
    scaleChanged();
  }

  function showSheet() {
    ctx.showPreview({ mode: S.measuring ? "measure" : "view", crop: S.crop, editable: false });
  }

  return {
    el,
    onShow() { syncScaleFields(); refreshResolution(); showSheet(); },
    onHide() { if (S.measuring) toggleMeasure(false); },
    canNext: () => !!S.crop && S.resolutionOk !== false,
  };
}
