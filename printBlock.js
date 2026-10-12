import { PRINT } from "./config.js";
import { h } from "./dom.js";
import { setStatus } from "./ui.js";
import { pageGeometry } from "./printGeometry.js";
import { freezeCaptureState } from "./printScaleMath.js";
import { printSettings, rememberedPrintSettings } from "./printSettings.js";
import { createPrintSession } from "./printSession.js";
import { createPrintFrame } from "./printFrame.js";
import { createPrintScale } from "./printScale.js";

// Stage 1. The later capture/editor registers onContinue and uses run/beginEditor/back on this same session.
export async function setupPrintBlock(mapEl) {
  const [reactive] = await $arcgis.import(["@arcgis/core/core/reactiveUtils.js"]);
  const block = document.getElementById("print-block"), body = document.getElementById("print-body");
  const view = mapEl.view, scale = createPrintScale(mapEl), host = document.getElementById("map-host");
  let stored;
  try { stored = JSON.parse(localStorage.getItem(PRINT.STORAGE_KEY)); } catch { /* preferences are optional */ }
  const settings = printSettings(stored);
  let page = pageGeometry(settings), measured = null, workspaceOpen = false, busy = false, destroyed = false;
  let watch = null, scheduled = 0, revision = 0, continueHandler = null, focusOnReady = false;
  const closeListeners = new Set();
  const session = createPrintSession({
    save: () => ({ viewpoint: view.viewpoint.clone(), snapToZoom: view.constraints.snapToZoom }),
    setSnap: (on) => { view.constraints.snapToZoom = on; },
    beforeClose: () => {
      try { closeListeners.forEach((callback) => callback()); }
      finally { host.classList.remove("print-framing"); }
    },
    restore: async (viewpoint) => {
      try { await view.goTo(viewpoint.clone(), { animate: false }); }
      catch { view.viewpoint = viewpoint.clone(); } // cancelled navigation still restores while snapping is off
    },
  });
  const frame = createPrintFrame(mapEl, scheduleReadout);
  const field = (label, ...controls) => h("calcite-label", {}, label, ...controls);
  const select = (id, label, value, options, change) => h("calcite-select", { id, label, scale: "s",
    oncalciteSelectChange: (event) => change(event.target.value) },
    options.map(([key, text]) => h("calcite-option", { value: String(key), label: text, selected: String(key) === String(value) })));
  const size = select("print-page-size", "Page size", settings.pageSize, PRINT.PAGE_SIZES.map(([name, width, height]) => [name, `${name} - ${width} x ${height} in`]),
    (value) => changePage("pageSize", value));
  const orientation = h("calcite-segmented-control", { id: "print-orientation", scale: "s", width: "full",
    oncalciteSegmentedControlChange: (event) => changePage("orientation", event.target.value) },
    ...["landscape", "portrait"].map((value) => h("calcite-segmented-control-item", { value, checked: settings.orientation === value },
      value === "landscape" ? "Landscape" : "Portrait")));
  const margins = select("print-margins", "Margins", settings.marginIn,
    PRINT.MARGINS_IN.map((value) => [value, value ? `${value} in` : "None"]), (value) => changePage("marginIn", Number(value)));
  const border = h("calcite-checkbox", { id: "print-border", checked: settings.border,
    oncalciteCheckboxChange: (event) => { settings.border = event.target.checked; remember(); } });
  const scaleText = h("div", { id: "print-scale", class: "print-scale", ariaLive: "polite" });
  const ratioText = h("div", { id: "print-ratio", class: "plan-note" });
  const preset = select("print-set-scale", "Set scale", "", [["", "Set scale…"],
    ...PRINT.SCALE_PRESETS.map((value) => [value, `1 in = ${value.toLocaleString("en-US")} ft`]), ["custom", "Custom…"]],
    (value) => {
      customRow.hidden = value !== "custom";
      if (value === "custom") custom.setFocus();
      else if (value) { preset.value = ""; applyScale(Number(value)).catch(() => {}); }
    });
  const custom = h("calcite-input-number", { id: "print-custom-scale", scale: "s", min: 0.01, step: "any", suffixText: "ft / in",
    onkeydown: (event) => { if (event.key === "Enter") { event.preventDefault(); applyCustom(); } } });
  const customRow = h("div", { class: "print-custom", hidden: true }, custom,
    h("calcite-button", { id: "print-apply-scale", scale: "s", appearance: "outline", onclick: applyCustom }, "Set"));
  const note = h("div", { class: "plan-note", ariaLive: "polite" });
  const next = h("calcite-button", { id: "print-continue", scale: "s", width: "full", iconEnd: "chevron-right", hidden: true,
    onclick: () => run((signal) => continueHandler(api, signal)).catch(() => {}) }, "Continue");
  body.replaceChildren(
    field("Page size", size), field("Margins", margins),
    field("Orientation", orientation),
    h("calcite-label", { layout: "inline" }, border, "Map border"),
    scaleText, ratioText, preset, customRow, note,
    h("div", { class: "plan-note" }, "Pan and zoom to frame the map. Closing Print returns to your starting view."),
    next,
  );

  function remember() {
    try { localStorage.setItem(PRINT.STORAGE_KEY, JSON.stringify(rememberedPrintSettings(settings))); } catch { /* optional */ }
  }
  function changePage(key, value) {
    settings[key] = value;
    try {
      page = pageGeometry(settings); remember();
      if (session.phase === "framing") frame.start(page);
    } catch (error) { fail(error); }
  }
  function refreshControls() {
    next.disabled = busy || !measured || !frame.rect || session.phase !== "framing";
    preset.disabled = busy || !measured || !frame.rect;
    size.disabled = margins.disabled = orientation.disabled = border.disabled = busy;
    custom.disabled = busy; next.loading = busy;
    if (focusOnReady && !next.hidden && !next.disabled) { focusOnReady = false; next.setFocus(); }
  }
  async function readout() {
    const token = ++revision, rect = frame.rect;
    if (session.phase !== "framing" || !rect) {
      measured = null; scaleText.textContent = ""; ratioText.textContent = ""; refreshControls(); return;
    }
    try {
      const result = await scale.measure(rect, page);
      if (token !== revision || session.phase !== "framing") return;
      measured = result;
      scaleText.textContent = `1 in = ${result.feetPerInch.toLocaleString("en-US", { maximumFractionDigits: result.feetPerInch < 10 ? 2 : 0 })} ft`;
      ratioText.textContent = `1:${Math.round(result.denominator).toLocaleString("en-US")}`;
      refreshControls();
    } catch (error) { if (token === revision && session.phase === "framing") await fail(error); }
  }
  function scheduleReadout() {
    if (scheduled || session.phase !== "framing") return;
    scheduled = requestAnimationFrame(() => { scheduled = 0; readout(); });
  }
  async function open() {
    if (workspaceOpen || destroyed) { block.expanded = false; return; }
    try {
      await session.open();
      if (!block.expanded || workspaceOpen || destroyed) { await close(); return; }
      host.classList.add("print-framing"); startFrame();
    } catch (error) { await fail(error); }
  }
  function startFrame() {
    frame.start(page);
    watch?.remove();
    watch = reactive.watch(() => [view.center?.x, view.center?.y, view.scale, view.rotation, view.width, view.height], () => frame.sync());
    scheduleReadout();
  }
  function stopFrame() {
    ++revision; measured = null;
    watch?.remove(); watch = null;
    cancelAnimationFrame(scheduled); scheduled = 0;
    frame.stop(); refreshControls();
  }
  async function close() {
    block.expanded = false;
    focusOnReady = false;
    try { stopFrame(); await session.close(); }
    finally { host.classList.remove("print-framing"); }
  }
  async function fail(error) {
    try { await close(); }
    finally { setStatus("danger", "Couldn't print map", error.message ?? String(error)); }
  }
  async function run(task) {
    busy = true; note.textContent = ""; refreshControls();
    try { return await session.run(task); }
    catch (error) {
      if (error.name !== "AbortError") await fail(error);
      throw error;
    } finally { busy = false; refreshControls(); }
  }
  async function applyScale(target) {
    if (!Number.isFinite(target) || target <= 0) { note.textContent = "Enter a scale greater than zero."; return; }
    if (busy || !frame.rect) return;
    await run(async (signal) => {
      measured = await scale.setScale(target, () => frame.rect, () => page, signal);
      scheduleReadout();
    });
  }
  function applyCustom() { applyScale(Number(custom.value)).catch(() => {}); }
  const expand = (event) => { if (event.target === block) open(); };
  const collapse = (event) => { if (event.target === block) close().catch((error) => setStatus("danger", "Couldn't restore map", error.message)); };
  block.addEventListener("calciteBlockExpand", expand); block.addEventListener("calciteBlockCollapse", collapse);
  block.hidden = false;
  const api = {
    close, run, applyScale, remember,
    async setWorkspaceOpen(on) { workspaceOpen = on; block.disabled = on; if (on) await close(); },
    onContinue(callback) { continueHandler = callback; next.hidden = !callback; refreshControls(); },
    onClose(callback) { closeListeners.add(callback); return () => closeListeners.delete(callback); },
    snapshot() {
      if (!frame.rect || !measured) throw new Error("The print frame is not ready.");
      const current = scale.measureNow(frame.rect, page); // fresh ground scale, using the already loaded projection
      return freezeCaptureState({ viewpoint: view.viewpoint.toJSON(), extent: view.extent.toJSON(), frame: frame.rect,
        feetPerInch: current.feetPerInch, rotation: view.rotation, snapToZoom: view.constraints.snapToZoom });
    },
    beginEditor() { const snapshot = api.snapshot(); session.enterEditor(); stopFrame(); return snapshot; },
    back() { session.back(); if (session.phase === "framing") { focusOnReady = true; startFrame(); } },
    get state() { return settings; }, get page() { return page; }, get frame() { return frame.rect; },
    get scale() { return measured; }, get phase() { return session.phase; },
    async destroy() {
      destroyed = true;
      try { await close(); }
      finally { block.removeEventListener("calciteBlockExpand", expand); block.removeEventListener("calciteBlockCollapse", collapse); body.replaceChildren(); }
    },
  };
  if (block.expanded) await open();
  return api;
}
