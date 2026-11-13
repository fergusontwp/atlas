import { h } from "./dom.js";
import { GEOREF, PLANS } from "./config.js";
import { accuracyClass, expectedPerPt, worstError } from "./georefAnalysis.js";
import { errorText, noteText, verdictText } from "./georefMessages.js";
import { minPoints } from "./georefTransform.js";
import { chainReadout } from "./placeSolve.js";
import { ptToPx, thickenSettings } from "./thicken.js";
import { fmt, note, numberInput, setIfIdle } from "./wsUi.js";

const FIT_DESC = {
  similarity: "Moves, turns and scales the sheet by one uniform factor. The right choice for a plan that was printed accurately. Use four or more points so mistakes can show.",
  locked: "Trusts the stated scale and fits only rotation and position. Works with two points. Use it when you are sure of the scale and the \"printed at\" percentage.",
  affine: "Also lets the sheet stretch or skew. Meant for scans or PDFs that were resized unevenly. Needs three points and can hide a bad one.",
  chain: "For long road plans: the pins cut the sheet into pieces, and each piece is placed rigidly between its two pins. Add pins at both ends first, then where the plan drifts or the road bends.",
};
const VERDICT_TONE = { good: "good", ok: "warn", review: "bad" };
const TONE = { good: "good", warn: "warn", bad: "bad" };
const SHORTCUTS = [
  ["Click", "a corner on the sheet, then the same corner on the map (or the other way round)"],
  ["Alt + click", "place a map point freely, without snapping to a corner or vertex"],
  ["Enter", "take the dashed ring (the corner the fit predicts)"],
  ["Esc", "cancel a half-made pair, or go back to pins from Move, Rotate or a line start"],
  ["Delete", "remove the selected point"],
  ["Arrow keys", "nudge the selected point on the sheet by one pixel (Shift: five)"],
  ["Ctrl or Cmd + Z", "undo"],
  ["Scroll", "zoom the sheet; drag with the right button (or Space + drag) to move it"],
];
const TYPING = /^(INPUT|TEXTAREA|SELECT|CALCITE-INPUT.*|CALCITE-TEXT-AREA|CALCITE-SELECT|CALCITE-COMBOBOX|CALCITE-SLIDER)$/;

// Step 3: place the sheet. Pick corners on the sheet and on the map, watch the overlay move, read the error.
// One tool, two solvers (placeSolve.js): a whole-sheet fit, or a chain of pieces between the pins. Before there are two
// pins the sheet can be placed roughly: along the selected line, or by hand (move, turn, x/y, at the map centre).
export function createStepPlace(ctx) {
  const { S } = ctx;

  const fitSeg = h("calcite-segmented-control", { scale: "s", width: "full", oncalciteSegmentedControlChange: (e) => { ctx.placement.edit.setFitType(e.target.value); render(); } },
    h("calcite-segmented-control-item", { value: "similarity" }, "Similarity"),
    h("calcite-segmented-control-item", { value: "locked" }, "Locked scale"),
    h("calcite-segmented-control-item", { value: "affine" }, "Affine"),
    h("calcite-segmented-control-item", { value: "chain" }, "Chain"));
  const fitDesc = note("");
  const exactBox = h("calcite-checkbox", { checked: true, oncalciteCheckboxChange: (e) => ctx.placement.edit.setChainExact(e.target.checked) });
  const exactRow = h("calcite-label", { layout: "inline", scale: "s" }, exactBox, "Fit pins exactly");
  const exactNote = note("");

  // ---- rough placement (the whole sheet, before the pins take over)
  const seedApi = () => ctx.placement.seed;
  const roughNote = note("");
  const lineButton = h("calcite-button", { scale: "s", appearance: "outline", iconStart: "line", onclick: () => seedApi().alongLine() }, "Along the selected line");
  const flipButton = h("calcite-button", { scale: "s", appearance: "outline", iconStart: "reverse", onclick: () => seedApi().flip() }, "Flip direction");
  const rowButton = h("calcite-button", { scale: "s", appearance: "outline", iconStart: "crosshair", onclick: () => seedApi().pickBaseline() }, "Set the road row");
  const lineRow = h("div", { class: "ws-row" }, lineButton, flipButton, rowButton);
  const centerButton = h("calcite-button", { scale: "s", appearance: "outline", iconStart: "center-vertical", onclick: () => seedApi().atCenter() }, "At the map centre");
  const toolSeg = h("calcite-segmented-control", { scale: "s", oncalciteSegmentedControlChange: (e) => { seedApi().setTool(e.target.value); render(); } },
    h("calcite-segmented-control-item", { value: "pins", iconStart: "pin" }, "Pins"),
    h("calcite-segmented-control-item", { value: "move", iconStart: "move" }, "Move"),
    h("calcite-segmented-control-item", { value: "rotate", iconStart: "rotate" }, "Rotate"));
  const xInput = numberInput({ label: "Sheet centre x (ft)", suffix: "x", step: 1, width: "9.5rem", onChange: (v) => seedApi().setXY(Number(v), seedApi().placement?.cy) });
  const yInput = numberInput({ label: "Sheet centre y (ft)", suffix: "y", step: 1, width: "9.5rem", onChange: (v) => seedApi().setXY(seedApi().placement?.cx, Number(v)) });
  const rotInput = numberInput({ label: "Rotation (degrees clockwise)", suffix: "°", step: 0.1, width: "6.5rem", onChange: (v) => seedApi().setRotation(Number(v)) });
  const turnLeft = h("calcite-button", { scale: "s", appearance: "outline", title: "Turn 1° counterclockwise", onclick: () => seedApi().turn(-1) }, "−1°");
  const turnRight = h("calcite-button", { scale: "s", appearance: "outline", title: "Turn 1° clockwise", onclick: () => seedApi().turn(1) }, "+1°");
  const handHost = h("div", {},
    h("div", { class: "ws-row" }, centerButton, toolSeg),
    h("div", { class: "ws-row" }, xInput, yInput),
    h("div", { class: "ws-row" }, rotInput, turnLeft, turnRight));
  const chainHost = h("div", {});

  const opacity = h("calcite-slider", { min: 0, max: 100, value: Math.round(ctx.placement.overlay.options.opacity * 100), label: "Sheet opacity", oncalciteSliderInput: (e) => ctx.placement.overlay.set({ opacity: e.target.value / 100 }) });
  const showSheet = h("calcite-switch", { checked: true, label: "Show the sheet", oncalciteSwitchChange: (e) => ctx.placement.overlay.set({ visible: e.target.checked }) });
  const showOutline = h("calcite-switch", { checked: true, label: "Show the outline", oncalciteSwitchChange: (e) => ctx.placement.overlay.set({ outline: e.target.checked }) });
  const switchRow = (control, text) => h("calcite-label", { layout: "inline", scale: "s" }, control, text);

  // ---- line weight (thicken.js): presets in points of line weight at the plan's scale, and the raw settings
  const TH = PLANS.THICKEN;
  const thCfg = { presets: TH.PRESETS, levels: TH.LEVELS, color: TH.COLOR };
  let thTimer = 0;
  const setWeight = (P, wait = 0) => { clearTimeout(thTimer); thTimer = setTimeout(() => ctx.placement.edit.setThicken(P), wait); };
  // an advanced change: the current settings (Medium when the line weight is off) with one value changed, now "custom"
  const weightOrMedium = () => (S.thicken && S.thicken.name !== "off" ? S.thicken : thickenSettings("medium", thCfg, {}, S.thicken?.sharpen ?? 0));
  const tweak = (patch) => { S.thicken = { ...weightOrMedium(), ...patch, name: "custom" }; renderWeight(); setWeight(S.thicken, 250); };
  const sharpenNow = () => S.thicken?.sharpen ?? 0;
  const weightSeg = h("calcite-segmented-control", { scale: "s", width: "full", oncalciteSegmentedControlChange: (e) => { S.thicken = thickenSettings(e.target.value, thCfg, {}, sharpenNow()); renderWeight(); setWeight(S.thicken); } },
    ...["off", "light", "medium", "heavy"].map((v) => h("calcite-segmented-control-item", { value: v }, v[0].toUpperCase() + v.slice(1))));
  const weightNote = note("");
  // sharpen (thicken.sharpenPlane): fidelity without width, with or without a line weight; kept when the weight changes
  const SH = TH.SHARPEN;
  const setSharpen = (amount, wait = 0) => {
    const a = Math.max(0, Number(amount) || 0), P = S.thicken;
    S.thicken = P && (P.name !== "off" || a > 0) ? { ...P, sharpen: a } : thickenSettings("off", thCfg, {}, a);
    renderWeight();
    setWeight(S.thicken, wait);
  };
  const sharpenSeg = h("calcite-segmented-control", { scale: "s", width: "full", oncalciteSegmentedControlChange: (e) => setSharpen(e.target.value === "off" ? 0 : SH[e.target.value.toUpperCase()]) },
    ...["off", "light", "medium", "strong"].map((v) => h("calcite-segmented-control-item", { value: v }, v[0].toUpperCase() + v.slice(1))));
  const sharpenInput = numberInput({ label: "Sharpen amount", min: 0, max: 4, step: 0.1, width: "6rem", onChange: (v) => setSharpen(v, 250) });
  const advSwitch = h("calcite-switch", { scale: "s", oncalciteSwitchChange: () => renderWeight() });
  const ptInput = numberInput({ label: "Line weight (points)", suffix: "pt", min: 0, max: 3, step: 0.05, width: "7rem", onChange: (v) => tweak({ pt: Math.max(0, Number(v) || 0) }) });
  const gammaInput = numberInput({ label: "Gamma", suffix: "γ", min: 0.3, max: 3, step: 0.05, width: "6rem", onChange: (v) => tweak({ gamma: Math.min(3, Math.max(0.3, Number(v) || 1)) }) });
  const slider = (label, min, max, key) => h("calcite-slider", { min, max, label, labelHandles: true, scale: "s", oncalciteSliderChange: (e) => tweak({ [key]: Number(e.target.value) }) });
  const blackSlider = slider("Black point", 0, 254, "black"), whiteSlider = slider("White point", 1, 255, "white"), threshSlider = slider("Binarize threshold", 1, 254, "thresh");
  const binBox = h("calcite-checkbox", { oncalciteCheckboxChange: (e) => tweak({ bin: e.target.checked }) });
  const colorBox = h("calcite-checkbox", { oncalciteCheckboxChange: (e) => tweak({ color: e.target.checked }) });
  const advHost = h("div", { hidden: true },
    h("div", { class: "ws-row" }, ptInput, gammaInput, sharpenInput),
    h("div", { class: "ws-field" }, h("span", { class: "ws-label" }, "Black point (darker goes black)"), blackSlider),
    h("div", { class: "ws-field" }, h("span", { class: "ws-label" }, "White point (lighter goes white)"), whiteSlider),
    h("calcite-label", { layout: "inline", scale: "s" }, binBox, "Binarize (black and white only; the smallest files)"),
    threshSlider,
    h("calcite-label", { layout: "inline", scale: "s" }, colorBox, "Keep colours"));
  function renderWeight() {
    const P = S.thicken;
    weightSeg.querySelectorAll("calcite-segmented-control-item").forEach((i) => { i.checked = (P?.name ?? "off") === i.value; });
    advHost.hidden = !advSwitch.checked;
    const dpi = S.raster?.dpi;
    const sh = P?.sharpen > 0 ? P.sharpen : 0;
    const shName = Object.keys(TH.SHARPEN).find((k) => TH.SHARPEN[k] === sh)?.toLowerCase();
    sharpenSeg.querySelectorAll("calcite-segmented-control-item").forEach((i) => { i.checked = (sh ? shName : "off") === i.value; });
    setIfIdle(sharpenInput, sh);
    weightNote.textContent = !P ? "Off: the image is saved as rendered."
      : P.name === "off" ? `No line weight; sharpened (${fmt(sh, 1)}): line edges crisper, no wider, at the saved image's own pixels. The saved image only; the PDF isn't changed.`
      : `${P.name === "custom" ? "Custom: adds" : "Adds"} ${fmt(P.pt, 2)} pt of line weight${dpi ? ` (${fmt(ptToPx(P.pt, dpi), 1)} px at the render's ${fmt(dpi)} dpi)` : ""}${sh ? `, sharpened (${fmt(sh, 1)})` : ""}${P.bin ? ", binarized" : ""}${P.color ? "" : ", in grey"}. The saved image only; the PDF isn't changed.`;
    const v = weightOrMedium();
    setIfIdle(ptInput, v.pt); setIfIdle(gammaInput, v.gamma);
    blackSlider.value = v.black; whiteSlider.value = v.white; threshSlider.value = v.thresh;
    binBox.checked = !!v.bin; colorBox.checked = !!v.color;
    threshSlider.disabled = !v.bin;
  }

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
    h("div", { class: "ws-field" }, h("span", { class: "ws-label" }, "Fit"), fitSeg, fitDesc, exactRow, exactNote),
    h("div", { class: "ws-step-title" }, "Rough placement"),
    roughNote, lineRow, handHost,
    h("div", { class: "ws-step-title" }, "Points"),
    pairStatus, snapStatus,
    h("div", { class: "ws-row" }, undoButton, clearButton, helpAction, helpPopover),
    verdictHost, notesHost, chainHost, tableHost, emptyNote,
    h("div", { class: "ws-step-title" }, "Sheet on the map"),
    h("div", { class: "ws-field" }, h("span", { class: "ws-label" }, "Opacity"), opacity),
    switchRow(showSheet, "Show the sheet"), switchRow(showOutline, "Show the outline"),
    h("div", { class: "ws-field" }, h("span", { class: "ws-label" }, "Line weight"), weightSeg),
    h("div", { class: "ws-field" }, h("span", { class: "ws-label" }, "Sharpen (no added width)"), sharpenSeg, weightNote, switchRow(advSwitch, "Adjust"), advHost),
    h("div", { class: "ws-row" }, zoomButton),
  );

  // ---- rendering
  function pairText() {
    const { plan, map } = ctx.placement.pending;
    const A = S.analysis;
    const snapped = ctx.placement.suggestion?.snapped;
    if (plan) return `Now click the same corner on the map.${ctx.placement.suggestion ? (snapped ? " The dashed ring is where the fit expects it; press Enter to take it." : " The dashed ring is where the fit expects it.") : ""} Press Esc to cancel.`;
    if (map) return "Now click that corner on the sheet. Press Esc to cancel.";
    const tool = ctx.placement.seed.tool;
    if (tool === "start") return "Click the map where the left end of the plan sits on the line. Press Esc to cancel.";
    if (tool === "baseline") return "Click the road's centerline on the sheet. Press Esc to cancel.";
    if (tool === "move") return "Drag the map to move the sheet. Choose Pins to add pins.";
    if (tool === "rotate") return "Drag around the sheet to turn it. Choose Pins to add pins.";
    if (!S.model.points.length) return "Click a sharp corner on the sheet, then the same corner on the map. You can start from either side.";
    if (S.fitType === "chain") {
      const n = A?.n ?? 0;
      if (S.solve?.mode === "chain") return `${n} pins, ${n - 1} piece${n === 2 ? "" : "s"}. Drag a pin onto the feature it marks; add one where the plan drifts or the road bends.`;
      if (n < 2) return `${n} pin. Add a second pin to start the chain${S.solve?.mode === "seed" ? "; one pin only shifts the sheet" : ""}.`;
    }
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
    if (A.T || (A.type === "chain" && A.quality !== "none")) {
      // an exact chain meets every pin by construction: nothing checks it, and another pin only makes another piece
      const verdict = A.type === "chain" && A.quality === "unchecked" ? "Exact at every pin" : verdictText(A.quality, worstError(A));
      verdictHost.append(
        h("div", { class: `ws-verdict${VERDICT_TONE[A.quality] ? ` ws-note-${VERDICT_TONE[A.quality]}` : ""}` }, verdict),
        h("span", { class: "plan-note" }, `Class ${accuracyClass(A.quality) ?? ""}  ·  RMS ${errorText(A.rms)}${Number.isFinite(A.looRms) ? `  ·  check ${errorText(A.looRms)}` : ""}`));
    }
    for (const n of A.notes) {
      // with the sheet already on the map (placed roughly), the points fit it rather than show it
      if (n.code === "need-points" && S.solve?.mode === "seed") { notesHost.append(note(`Add ${n.values.missing} more point${n.values.missing === 1 ? "" : "s"} to fit the sheet to them.`)); continue; }
      const { level, text } = noteText(n);
      notesHost.append(note(text, TONE[level]));
    }
  }

  // The chain readout: per piece its length, scale against the stated scale and rotation; per seam the kink and jogs.
  // Values over PLANS.CHAIN's limits are flagged.
  function renderChain() {
    chainHost.replaceChildren();
    const ch = S.solve?.chain;
    if (S.fitType !== "chain" || !ch) return;
    if (ch.problem) { chainHost.append(note(ch.problem, "bad")); return; }
    if (!ch.ok) return;
    const out = chainReadout(ch, expectedPerPt(S.scale), PLANS.CHAIN);
    const cell = (text, warn, title) => h("td", { class: warn ? "ws-note-warn" : "", title: title ?? "" }, text);
    const sign = (v, d) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${fmt(Math.abs(v), d)}`;
    chainHost.append(...[
      h("table", { class: "ws-points" },
        h("thead", {}, h("tr", {}, h("th", {}, "Piece"), h("th", {}, "Length"), h("th", { title: "Scale against the stated scale" }, "Scale"), h("th", { title: "Clockwise from east" }, "Rotation"))),
        h("tbody", {}, ...out.pieces.map((p) => h("tr", {},
          h("td", {}, `${p.ids[0]}–${p.ids[1]}`), h("td", {}, `${fmt(p.lengthFt)} ft`),
          cell(p.scalePct === null ? "" : `${sign(p.scalePct, 2)}%`, p.warnScale, p.warnScale ? `More than ${PLANS.CHAIN.WARN_SCALE_PCT}% off the stated scale: check the pins` : ""),
          h("td", {}, `${sign(p.theta, 2)}°`))))),
      out.seams.length ? h("table", { class: "ws-points" },
        h("thead", {}, h("tr", {}, h("th", {}, "Seam"), h("th", { title: "How much the neighbouring pieces turn at the pin" }, "Kink"), h("th", { title: "How far apart the two pieces put the pin" }, "At pin"), h("th", { title: "How far apart they are at the top and bottom of the sheet" }, "At edges"))),
        h("tbody", {}, ...out.seams.map((m) => h("tr", {},
          h("td", {}, `at ${m.at}`),
          cell(`${sign(m.kink, 2)}°`, m.warnKink), cell(`${fmt(m.jogPin, 2)} ft`, m.warnJog), cell(`${fmt(m.jogEdge, 1)} ft`, m.warnEdge))))) : null,
      out.seams.some((m) => m.warnEdge) ? note(`At a flagged seam the pieces part by more than ${PLANS.CHAIN.WARN_EDGE_JOG_FT} ft at the sheet's edges: a pin between them, where the road bends, makes the kinks smaller.`) : null,
    ].filter(Boolean));
  }

  // The rough placement controls: available while fewer than two pins are in use, and with a stated scale.
  function renderRough() {
    const api = seedApi();
    const why = api.blocked;
    const pins = S.model.points.filter((p) => p.use !== false).length;
    const shown = api.shown ?? api.placement;
    lineRow.hidden = !api.onLine;
    const off = !!why;
    for (const b of [lineButton, rowButton, centerButton]) b.disabled = off;
    flipButton.disabled = off || api.info?.source !== "line";
    toolSeg.disabled = off;
    toolSeg.querySelectorAll("calcite-segmented-control-item").forEach((i) => { i.checked = i.value === api.tool; });
    const noSeed = !api.placement;
    xInput.disabled = yInput.disabled = off || noSeed || pins > 0;
    rotInput.disabled = turnLeft.disabled = turnRight.disabled = off || noSeed;
    setIfIdle(xInput, shown ? shown.cx.toFixed(2) : "");
    setIfIdle(yInput, shown ? shown.cy.toFixed(2) : "");
    setIfIdle(rotInput, shown ? shown.theta.toFixed(2) : "");
    let text;
    if (why === "no-scale") text = "Set the plan's stated scale in step 2 to place the sheet along the line or by hand. Or pair corners below.";
    else if (why === "pins") text = S.fitType === "chain" ? "The pins place each piece now. Drag a pin to adjust, or delete pins to place the sheet by hand again." : "The pins place the sheet now. Delete pins to place it by hand again.";
    else if (noSeed) text = api.onLine ? "Place the whole sheet first, at the stated scale: along the selected line (click where the plan's left end sits), or at the map centre and then by hand. No pins are made." : "Place the whole sheet first, at the stated scale: at the map centre, then move and turn it. Or pair corners below.";
    else {
      const i = api.info;
      const from = i?.source === "line" ? `Placed along the line${i.autoStart ? ` from its ${i.flipped ? "end" : "start"} (the line is about as long as the plan)` : ""}. A centerline is only an approximation: add pins to bring the plan onto real features.` : "Placed by hand.";
      const short = i?.source === "line" && i.missingFt > 1 ? ` The line ends ${fmt(i.missingFt)} ft before the plan does.` : "";
      text = `${from}${short}${pins === 1 ? " One pin holds the sheet; it turns about that pin." : ""}`;
    }
    roughNote.textContent = text;
    roughNote.className = `plan-note${why === "no-scale" ? " ws-note-warn" : ""}`;
  }

  function render() {
    const A = S.analysis;
    fitSeg.querySelectorAll("calcite-segmented-control-item").forEach((i) => { i.checked = i.value === S.fitType; });
    const hasScale = Number.isFinite(expectedPerPt(S.scale));
    [...fitSeg.querySelectorAll("calcite-segmented-control-item")].find((i) => i.value === "locked").disabled = !hasScale;
    if (!hasScale && S.fitType === "locked") { S.fitType = "similarity"; ctx.placement.edit.setFitType("similarity"); return; }
    fitDesc.textContent = FIT_DESC[S.fitType] + (hasScale ? "" : " Locked scale needs a stated scale (step 2).");
    exactRow.hidden = exactNote.hidden = S.fitType !== "chain";
    exactBox.checked = !!S.chainExact;
    exactBox.disabled = !hasScale;
    exactNote.textContent = !hasScale ? "Without a stated scale every piece follows its pins."
      : S.chainExact ? "Each piece meets both its pins; its scale follows them." : "Each piece keeps the stated scale; the miss is split between its two pins.";
    pairStatus.textContent = pairText();
    snapStatus.textContent = ctx.placement.snapStatus;
    renderRough();
    renderWeight();
    renderTable();
    renderVerdict();
    renderChain();
    clearButton.hidden = S.model.points.length === 0;
    undoButton.disabled = S.model.history.length === 0;
    zoomButton.disabled = !S.solve || S.solve.mode === "none";
    ctx.refreshNav();
  }
  // The panel's tables are rebuilt from Calcite components, which is slow: while a pin or the sheet is dragged (a
  // change every frame) it is rendered at most every RENDER_MS, and once more when the changes stop.
  const RENDER_MS = 150;
  let lastRender = 0, renderTimer = 0;
  const renderSoon = () => {
    if (el.hidden) return;
    clearTimeout(renderTimer);
    const wait = lastRender + RENDER_MS - performance.now();
    if (wait <= 0) { lastRender = performance.now(); render(); }
    else renderTimer = setTimeout(() => { lastRender = performance.now(); if (!el.hidden) render(); }, wait);
  };
  ctx.on("points", renderSoon);
  ["pairing", "selection", "snap", "tool"].forEach((what) => ctx.on(what, () => { if (!el.hidden) render(); }));

  // ---- keyboard (only on this step, and not while typing in a field)
  function onKey(e) {
    if (e.composedPath().some((n) => n.tagName && TYPING.test(n.tagName))) return;
    const edit = ctx.placement.edit;
    const key = e.key;
    let handled = true;
    if ((e.ctrlKey || e.metaKey) && key.toLowerCase() === "z") edit.undo();
    else if (e.ctrlKey || e.metaKey || e.altKey) handled = false;
    else if (key === "Escape") { ctx.placement.cancelPending(); ctx.placement.seed.setTool("pins"); }
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
    // Step 4 needs a fit with at least the minimum number of points (a chain: two pins and every piece built).
    canNext: () => (S.fitType === "chain" ? S.solve?.mode === "chain" : !!S.analysis?.T && S.analysis.n >= minPoints(S.fitType)),
  };
}
