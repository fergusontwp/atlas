import { h } from "./dom.js";
import { GEOREF } from "./config.js";
import { accuracyClass, expectedPerPt, worstError } from "./georefAnalysis.js";
import { errorText, noteText, verdictText } from "./georefMessages.js";
import { minPoints } from "./georefTransform.js";
import { note } from "./wsUi.js";

const FIT_DESC = {
  similarity: "Moves, turns and scales the sheet by one uniform factor. The right choice for a plan that was printed accurately. Use four or more points so mistakes can show.",
  locked: "Trusts the stated scale and fits only rotation and position. Works with two points. Use it when you are sure of the scale and the \"printed at\" percentage.",
  affine: "Also lets the sheet stretch or skew. Meant for scans or PDFs that were resized unevenly. Needs three points and can hide a bad one.",
};
const VERDICT_TONE = { good: "good", ok: "warn", review: "bad" };
const TONE = { good: "good", warn: "warn", bad: "bad" };
const SHORTCUTS = [
  ["Click", "a corner on the sheet, then the same corner on the map (or the other way round)"],
  ["Alt + click", "place a map point freely, without snapping to a parcel corner"],
  ["Enter", "take the dashed ring (the corner the fit predicts)"],
  ["Esc", "cancel a half-made pair"],
  ["Delete", "remove the selected point"],
  ["Arrow keys", "nudge the selected point on the sheet by one pixel (Shift: five)"],
  ["Ctrl or Cmd + Z", "undo"],
  ["Scroll", "zoom the sheet; drag with the right button (or Space + drag) to move it"],
];
const TYPING = /^(INPUT|TEXTAREA|SELECT|CALCITE-INPUT.*|CALCITE-TEXT-AREA|CALCITE-SELECT|CALCITE-COMBOBOX|CALCITE-SLIDER)$/;

// Step 3: place the sheet. Pick corners on the sheet and on the map, watch the overlay move, read the error.
export function createStepPlace(ctx) {
  const { S } = ctx;

  const fitSeg = h("calcite-segmented-control", { scale: "s", width: "full", oncalciteSegmentedControlChange: (e) => { ctx.placement.edit.setFitType(e.target.value); render(); } },
    h("calcite-segmented-control-item", { value: "similarity" }, "Similarity"),
    h("calcite-segmented-control-item", { value: "locked" }, "Locked scale"),
    h("calcite-segmented-control-item", { value: "affine" }, "Affine"));
  const fitDesc = note("");

  const opacity = h("calcite-slider", { min: 0, max: 100, value: Math.round(ctx.placement.overlay.options.opacity * 100), label: "Sheet opacity", oncalciteSliderInput: (e) => ctx.placement.overlay.set({ opacity: e.target.value / 100 }) });
  const showSheet = h("calcite-switch", { checked: true, label: "Show the sheet", oncalciteSwitchChange: (e) => ctx.placement.overlay.set({ visible: e.target.checked }) });
  const showOutline = h("calcite-switch", { checked: true, label: "Show the outline", oncalciteSwitchChange: (e) => ctx.placement.overlay.set({ outline: e.target.checked }) });
  const switchRow = (control, text) => h("calcite-label", { layout: "inline", scale: "s" }, control, text);

  const pairStatus = h("div", { class: "plan-note", ariaLive: "polite" });
  const snapStatus = note("");
  const verdictHost = h("div", { class: "ws-row" });
  const notesHost = h("div", {});
  const tableHost = h("div", {});
  const emptyNote = note("No points yet.");

  const undoButton = h("calcite-button", { scale: "s", appearance: "outline", iconStart: "undo", onclick: () => ctx.placement.edit.undo() }, "Undo");
  const clearButton = h("calcite-button", { scale: "s", appearance: "outline", kind: "danger", iconStart: "trash", onclick: () => ctx.placement.edit.clear() }, "Clear");
  const zoomButton = h("calcite-button", { scale: "s", appearance: "outline", iconStart: "zoom-to-object", onclick: () => ctx.placement.overlay.zoomToSheet() }, "Zoom to sheet");
  const helpAction = h("calcite-action", { id: "ws-help-action", icon: "question", text: "Shortcuts", scale: "s", textEnabled: true });
  const helpPopover = h("calcite-popover", { referenceElement: "ws-help-action", placement: "bottom", scale: "s", closable: true, heading: "Shortcuts" },
    h("div", { style: "padding: 8px 12px; max-width: 20rem; font-size: 13px;" },
      ...SHORTCUTS.map(([k, v]) => h("div", { style: "margin-bottom: 6px;" }, h("b", {}, k), ` ${v}`))));

  const el = h("div", {},
    h("div", { class: "ws-field" }, h("span", { class: "ws-label" }, "Fit"), fitSeg, fitDesc),
    h("div", { class: "ws-step-title" }, "Points"),
    pairStatus, snapStatus,
    h("div", { class: "ws-row" }, undoButton, clearButton, helpAction, helpPopover),
    verdictHost, notesHost, tableHost, emptyNote,
    h("div", { class: "ws-step-title" }, "Sheet on the map"),
    h("div", { class: "ws-field" }, h("span", { class: "ws-label" }, "Opacity"), opacity),
    switchRow(showSheet, "Show the sheet"), switchRow(showOutline, "Show the outline"),
    h("div", { class: "ws-row" }, zoomButton),
  );

  // ---- rendering
  function pairText() {
    const { plan, map } = ctx.placement.pending;
    const A = S.analysis;
    const snapped = ctx.placement.suggestion?.snapped;
    if (plan) return `Now click the same corner on the map.${ctx.placement.suggestion ? (snapped ? " The dashed ring is where the fit expects it; press Enter to take it." : " The dashed ring is where the fit expects it.") : ""} Press Esc to cancel.`;
    if (map) return "Now click that corner on the sheet. Press Esc to cancel.";
    if (!S.model.points.length) return "Click a sharp corner on the sheet, then the same corner on the map. You can start from either side.";
    if (!A?.T) return `${S.model.points.length} point${S.model.points.length === 1 ? "" : "s"}. Add ${A ? A.notes[0]?.values?.missing ?? 1 : 1} more to see the sheet on the map.`;
    return `${A.n} point${A.n === 1 ? "" : "s"} in the fit. ${A.n < 4 ? "Add a few more, spread toward the edges." : "Spread them out and zoom to a corner you didn't use as a final check."}`;
  }

  function renderTable() {
    const A = S.analysis;
    const pts = S.model.points;
    emptyNote.hidden = pts.length > 0;
    if (!pts.length) { tableHost.replaceChildren(); return; }
    const tbody = h("tbody", {}, ...pts.map((p, i) => {
      const row = A?.rows[i];
      const tr = h("tr", { class: `${p.id === S.selId ? "sel " : ""}${p.use ? "" : "off"}`, onclick: () => ctx.placement.edit.select(p.id, { fromTable: true }) },
        h("td", {}, `${p.id}${p.snapped ? "" : " *"}`),
        h("td", {}, errorText(row?.res?.mag)),
        h("td", { title: row?.indep ? "Left out of the fit, so this is an independent check" : "" }, errorText(row?.loo)),
        h("td", {}, h("calcite-checkbox", { checked: p.use, label: `Use point ${p.id} in the fit`, scale: "s", onclick: (e) => e.stopPropagation(), oncalciteCheckboxChange: (e) => ctx.placement.edit.setUse(p.id, e.target.checked) })),
        h("td", {}, h("calcite-action", { icon: "x", text: `Delete point ${p.id}`, scale: "s", compact: true, onclick: (e) => { e.stopPropagation(); ctx.placement.edit.remove(p.id); } })));
      return tr;
    }));
    tableHost.replaceChildren(h("table", { class: "ws-points" },
      h("thead", {}, h("tr", {}, h("th", {}, "#"), h("th", { title: "How far the fitted position is from where the point was placed" }, "Error"), h("th", { title: "Leave-one-out: how far it lands when the fit is made without it" }, "Check"), h("th", {}, "Use"), h("th", {}))),
      tbody));
    if (pts.some((p) => !p.snapped)) tableHost.append(note("* placed freely on the basemap, so only as exact as the imagery.", "warn"));
  }

  function renderVerdict() {
    const A = S.analysis;
    verdictHost.replaceChildren();
    notesHost.replaceChildren();
    if (!A) return;
    if (A.T) {
      verdictHost.append(
        h("div", { class: `ws-verdict${VERDICT_TONE[A.quality] ? ` ws-note-${VERDICT_TONE[A.quality]}` : ""}` }, verdictText(A.quality, worstError(A))),
        h("span", { class: "plan-note" }, `Class ${accuracyClass(A.quality) ?? ""}  ·  RMS ${errorText(A.rms)}${Number.isFinite(A.looRms) ? `  ·  check ${errorText(A.looRms)}` : ""}`));
    }
    for (const n of A.notes) {
      const { level, text } = noteText(n);
      notesHost.append(note(text, TONE[level]));
    }
  }

  function render() {
    const A = S.analysis;
    fitSeg.querySelectorAll("calcite-segmented-control-item").forEach((i) => { i.checked = i.value === S.fitType; });
    const hasScale = Number.isFinite(expectedPerPt(S.scale));
    [...fitSeg.querySelectorAll("calcite-segmented-control-item")].find((i) => i.value === "locked").disabled = !hasScale;
    if (!hasScale && S.fitType === "locked") { S.fitType = "similarity"; ctx.placement.edit.setFitType("similarity"); return; }
    fitDesc.textContent = FIT_DESC[S.fitType] + (hasScale ? "" : " Locked scale needs a stated scale (step 2).");
    pairStatus.textContent = pairText();
    snapStatus.textContent = ctx.placement.snapStatus;
    renderTable();
    renderVerdict();
    clearButton.hidden = S.model.points.length === 0;
    undoButton.disabled = S.model.history.length === 0;
    zoomButton.disabled = !A?.T;
    ctx.refreshNav();
  }
  ["points", "pairing", "selection", "snap"].forEach((what) => ctx.on(what, () => { if (!el.hidden) render(); }));

  // ---- keyboard (only on this step, and not while typing in a field)
  function onKey(e) {
    if (e.composedPath().some((n) => n.tagName && TYPING.test(n.tagName))) return;
    const edit = ctx.placement.edit;
    const key = e.key;
    let handled = true;
    if ((e.ctrlKey || e.metaKey) && key.toLowerCase() === "z") edit.undo();
    else if (e.ctrlKey || e.metaKey || e.altKey) handled = false;
    else if (key === "Escape") ctx.placement.cancelPending();
    else if (key === "Enter") handled = ctx.placement.acceptSuggestion();
    else if (key === "Delete" || key === "Backspace") { if (S.selId != null) edit.remove(S.selId); else handled = false; }
    else if (key.startsWith("Arrow")) {
      const step = e.shiftKey ? 5 : 1;
      const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[key];
      handled = edit.nudge(d[0], d[1]);
    } else handled = false;
    if (handled) { e.preventDefault(); e.stopPropagation(); }
  }

  return {
    el,
    async onShow() {
      await ctx.ensureRaster();
      ctx.showRender("pick");
      ctx.placement.start();
      document.addEventListener("keydown", onKey, true);
      render();
    },
    onHide() {
      document.removeEventListener("keydown", onKey, true);
      ctx.placement?.stop();
    },
    // Step 4 needs a fit with at least the minimum number of points.
    canNext: () => !!S.analysis?.T && S.analysis.n >= minPoints(S.fitType),
  };
}
