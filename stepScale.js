import { h } from "./dom.js";
import { GEOREF } from "./config.js";
import { expectedPerPt } from "./georefAnalysis.js";
import { isWholePage, measureOnSheet, reductionFromKnown } from "./cropMath.js";
import { groundFtPerPx, renderProblem } from "./pageRaster.js";
import { field, fmt, note, numberInput, setIfIdle } from "./wsUi.js";

// Step 2: the stated scale (1 in = N ft) and "printed at" percent. The resolution isn't chosen here: the sheet is placed
// on a working render at the page's own detail (within GEOREF.WORKING_MAX_PIXELS, for speed), and close up the sheet pane
// and the map render the part in view from the PDF itself. The saved image's resolution is worked out, and can be
// lowered, in Review, once it is known whether the plan is one image or pieces.
export function createStepScale(ctx) {
  const { S } = ctx;

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

  // ---- the working render
  const workNote = h("div", { class: "plan-note" });

  const el = h("div", {},
    h("div", { class: "ws-step-title" }, "Stated scale"),
    note("Printed on the plan, for example 1 in = 40 ft. It checks the fit and gives the ground size of a pixel."),
    field("Scale", presetSelect),
    h("div", { class: "ws-row" }, h("span", {}, "1 in ="), perInchInput, unitSelect),
    field("Printed at", reductionInput, "Use less than 100 if the PDF is a reduced print of the original sheet."),
    scaleNote,
    h("div", { class: "ws-row" }, measureButton),
    measureOut, knownRow,
    h("div", { class: "ws-step-title" }, "Working render"),
    note("Placed on a render of the PDF; zoomed in, the sheet and the map show the PDF itself at your screen's detail. The saved resolution is set in Review."),
    workNote,
  );

  // The stated scale in ground feet per page inch, once "printed at" is counted, or null.
  function feetPerPageInch() {
    const perPt = expectedPerPt(S.scale);
    return Number.isFinite(perPt) ? perPt * 72 : null;
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
    refreshResolution(); // the scale only changes the feet per pixel shown, not the render
    ctx.changed("scale");
    ctx.markDirty();
  }

  // What the sheet is placed on (ctx.workingResolution), and whether it can be made.
  function refreshResolution() {
    if (!S.crop || !S.page) return;
    const r = ctx.workingResolution();
    const problem = renderProblem(r.W, r.H, { maxPixels: GEOREF.MAX_PIXELS, maxSide: GEOREF.MAX_CANVAS_SIDE });
    const fpi = feetPerPageInch();
    workNote.className = `plan-note${problem ? " ws-note-bad" : ""}`;
    workNote.textContent = problem
      ?? `${fmt(r.dpi)} dpi: ${fmt(r.W)} × ${fmt(r.H)} px${fpi ? ` · ${groundFtPerPx(fpi, r.dpi).toFixed(2)} ft per pixel` : ""}${r.capped ? ` · close up, up to ${fmt(ctx.finestDpi())} dpi` : ""}`;
    S.resolutionOk = !problem;
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
    const whole = S.page && isWholePage(S.crop, S.page.pageWidthPt, S.page.pageHeightPt);
    ctx.showPreview({ mode: S.measuring ? "measure" : "view", crop: whole ? null : S.crop, editable: false });
  }

  return {
    el,
    onShow() { syncScaleFields(); refreshResolution(); showSheet(); },
    onHide() {
      if (S.measuring) toggleMeasure(false);
    },
    canNext: () => !!S.crop && S.resolutionOk !== false,
  };
}
