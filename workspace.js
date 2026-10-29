import { h } from "./dom.js";
import { GEOREF, PARCEL_PANEL, PLANS } from "./config.js";
import { SheetView } from "./sheetView.js";
import { renderCrop } from "./pdfRaster.js";
import { pieceDpi, ptToPx, renderDpi } from "./pageRaster.js";
import { imageBudget } from "./planCompression.js";
import { createStepSheet } from "./stepSheet.js";
import { createStepScale } from "./stepScale.js";
import { createStepPlace } from "./stepPlace.js";
import { createStepDetails } from "./stepDetails.js";
import { createStepReview } from "./stepReview.js";
import { createPlacement } from "./placement.js";
import { PointsModel } from "./pointsModel.js";
import { ATTACHMENT, serverLocationOf, stateFromRecord } from "./planRecord.js";
import { editableAttributes, groupWhere } from "./planGroup.js";
import { thickenSettings } from "./thicken.js";
import { searchSubject } from "./searchSubject.js";
import { createMosaicWorkspace } from "./mosaicWorkspace.js";
import { openMosaicPage } from "./mosaicPage.js";
import { defaultCrop } from "./cropMath.js";

// The georeferencing workspace: a docked sheet pane beside the map and the steps in the left panel. Never a modal.
// It starts from a selected feature of any layer, the subject (searchSubject.js): a parcel, a road, a pipe, a point. The
// map is zoomed to it, it stays outlined for reference, and its vertices are snapping points (placement.js); nothing
// about it is stored on the plan. While it is open map clicks don't select parcels (panel.setSuspended under the owner "georef"),
// Measure is switched off, and the filter editor is hidden. Closing puts everything back.
//
// Steps: 1 Sheet (open the PDF, page, crop), 2 Scale and resolution, 3 Place, 4 Details, 5 Review and save.
const STEPS = [
  { id: "sheet", heading: "Sheet", title: "Open the plan PDF", create: createStepSheet },
  { id: "scale", heading: "Scale", title: "Scale", create: createStepScale },
  { id: "place", heading: "Place", title: "Place the sheet on the map", create: createStepPlace },
  { id: "details", heading: "Details", title: "Describe the plan", create: createStepDetails },
  { id: "review", heading: "Review", title: "Review and save", create: createStepReview },
];

const DPI_LIMITS = { maxDpi: GEOREF.MAX_DPI, raster: GEOREF.RASTER, maxSide: GEOREF.MAX_CANVAS_SIDE, maxPixels: GEOREF.MAX_PIXELS };
// the working render (placing): the page's native detail, smaller limits, and never the saved resolution's choice
const WORKING_LIMITS = { ...DPI_LIMITS, maxPixels: GEOREF.WORKING_MAX_PIXELS };

const freshState = () => ({
  pdf: null, pageNum: 1, page: null, crop: null, cropTouched: false,
  // the mosaic the sheet is (mosaicModel.js: several views of the PDF joined), or null for a page of the PDF; S.page is
  // then the mosaic as a page (mosaicPage.js) and every point and crop is in mosaic points
  mosaic: null,
  // dpi: the working render's (workingResolution(): the page's ceiling within WORKING_LIMITS); dpiChoice: a lower
  // resolution for the saved image, chosen in Review (null: the most that fits)
  scale: { perInch: null, unit: "ft", reduction: 100 }, dpi: null, dpiChoice: null, resolutionOk: true, measuring: false,
  raster: null, rasterKey: null,
  fitType: "similarity", model: new PointsModel(GEOREF.UNDO_STEPS), selId: null, analysis: null, confirmClass: null, saved: false, edit: null,
  // placement (placeSolve.js): what the solver gave; for a chain, whether the scale follows the pins; the road row on the
  // sheet (page y, null: the crop's middle); the line placement's direction and what the rough placement came from
  solve: null, chainExact: PLANS.CHAIN.FIT_EXACT_DEFAULT, baselineRow: null, seedFlip: false, seedInfo: null,
  // the line weight (thicken.js settings) applied to the saved image and the preview on the map; null: off
  thicken: thickenSettings(PLANS.THICKEN.DEFAULT, { presets: PLANS.THICKEN.PRESETS, levels: PLANS.THICKEN.LEVELS, color: PLANS.THICKEN.COLOR }, {}, PLANS.THICKEN.DEFAULT_SHARPEN),
  get points() { return this.model.points; },
  details: { name: "", type: "", date: "", notes: "", sheetSize: "", statedScale: "", serverLocation: "", sheetTouched: false, scaleTouched: false },
  attachPdf: PLANS.ATTACH_SOURCE_PDF_DEFAULT, // "Attach source PDF" (step 4); it decides the image's byte budget too
  dirty: false,
});

export function setupWorkspace({ mapEl, parcel, panel, plans, plansBlock, measure, print }) {
  const $ = (id) => document.getElementById(id);
  const wsPanel = $("workspace-panel");
  const leftShell = document.querySelector('calcite-shell-panel[slot="panel-start"]');
  const sheetPane = $("sheet-pane");
  const splitter = $("sheet-splitter");
  const measureBlock = $("measure-block");
  const parcelShell = $("parcel-shell-panel");

  let S = freshState();
  let sheet = null;
  let isOpen = false;
  let step = 1;
  let steps = []; // [{ def, mod, el }]
  let busyCount = 0;
  let sourceId = null; // what the sheet pane is showing
  let closers = [];
  const listeners = new Map();
  const saved = {};

  // ---- the context the steps work with
  const ctx = {
    get S() { return S; },
    get sheet() { return sheet; },
    mapEl, parcel, panel, plans,
    subject: null, // the selected feature the workspace was opened from (searchSubject.js)
    on(what, cb) { (listeners.get(what) ?? listeners.set(what, new Set()).get(what)).add(cb); },
    changed(what) { listeners.get(what)?.forEach((cb) => cb()); listeners.get("*")?.forEach((cb) => cb(what)); },
    onClose(fn) { closers.push(fn); },
    markDirty() { S.dirty = true; },
    close: () => close(true), restoreEdit, say, busy, go, refreshNav, invalidateRaster, ensureRaster, showPreview, showRender,
    openMosaic, leaveMosaic,
    resolution, workingResolution, finestDpi, renderRect, imageBudget: budgetNow, DPI_LIMITS,
    clearPoints() { S.model = new PointsModel(GEOREF.UNDO_STEPS); S.selId = null; S.analysis = null; S.seedInfo = null; ctx.placement?.refresh(); ctx.changed("points"); },
    placement: null,
    confirmClearPoints: () => window.confirm("This page has different corners. Clear the points placed so far?"),
  };

  // ---- panel chrome
  const status = h("div", { class: "plan-note", ariaLive: "polite" });
  const busyRow = h("div", { class: "ws-busy", hidden: true }, h("calcite-loader", { inline: true, label: "Working" }), h("span", {}));
  const confirmRow = h("div", { class: "ws-confirm", hidden: true },
    h("span", {}, "Discard this georeference? The points and details so far will be lost."),
    h("calcite-button", { scale: "s", appearance: "outline", onclick: () => (confirmRow.hidden = true) }, "Keep working"),
    h("calcite-button", { scale: "s", kind: "danger", onclick: () => close(true) }, "Discard"));
  const cancelButton = h("calcite-button", { scale: "s", appearance: "outline", onclick: () => close() }, "Cancel");
  const stepper = h("calcite-stepper", { scale: "s", layout: "horizontal", oncalciteStepperChange: (e) => {
    const i = [...e.target.querySelectorAll("calcite-stepper-item")].indexOf(e.target.selectedItem);
    if (i >= 0) go(i + 1);
  } }, ...STEPS.map((s) => h("calcite-stepper-item", { heading: s.heading })));
  const stepTitle = h("div", { class: "ws-step-title" });
  const stepHost = h("div", {});
  const backButton = h("calcite-button", { appearance: "outline", iconStart: "chevron-left", onclick: () => go(step - 1) }, "Back");
  const nextButton = h("calcite-button", { iconEnd: "chevron-right", onclick: () => go(step + 1) }, "Next");
  wsPanel.replaceChildren(
    h("div", { class: "ws-head" }, h("h2", { class: "ws-title" }, "Georeference plan PDF"), cancelButton),
    confirmRow, stepper, stepTitle, busyRow, status, stepHost,
    h("div", { class: "ws-nav" }, backButton, nextButton),
  );

  let statusTimer;
  function say(text, tone) {
    status.textContent = text;
    status.className = `plan-note${tone ? ` ws-note-${tone}` : ""}`;
    clearTimeout(statusTimer);
    if (text) statusTimer = setTimeout(() => (status.textContent = ""), 9000);
  }
  function busy(text) {
    busyCount++;
    busyRow.hidden = false;
    busyRow.querySelector("span").textContent = text;
    refreshNav();
    return () => {
      busyCount = Math.max(0, busyCount - 1);
      if (!busyCount) busyRow.hidden = true;
      refreshNav();
    };
  }

  // ---- steps
  const canGo = (n) => {
    const def = STEPS[n - 1];
    if (!def?.create || !steps[n - 1]) return false;
    if (n === 1) return true;
    // every step before it must be complete (a step that couldn't be built blocks the ones after it)
    return !!S.pdf && !!S.page && steps.slice(0, n - 1).every((s) => s && s.mod.canNext?.() !== false);
  };
  function refreshNav() {
    if (!isOpen) return;
    const items = [...stepper.querySelectorAll("calcite-stepper-item")];
    items.forEach((item, i) => {
      item.disabled = !canGo(i + 1) || busyCount > 0;
      item.selected = i + 1 === step;
      item.complete = i + 1 < step;
    });
    backButton.disabled = step <= 1 || busyCount > 0;
    const last = step >= STEPS.length;
    nextButton.hidden = last;
    nextButton.disabled = busyCount > 0 || !canGo(step + 1) || steps[step - 1]?.mod.canNext?.() === false;
    nextButton.textContent = STEPS[step]?.heading ? `Next: ${STEPS[step].heading.toLowerCase()}` : "Next";
  }
  async function go(n) {
    if (!isOpen || busyCount || n === step || n < 1 || n > STEPS.length) return;
    if (n > step && !canGo(n)) { refreshNav(); return; }
    steps[step - 1]?.mod.onHide?.();
    steps[step - 1]?.el.setAttribute("hidden", "");
    step = n;
    stepTitle.textContent = `${n}. ${STEPS[n - 1].title}`;
    const cur = steps[n - 1];
    cur.el.removeAttribute("hidden");
    status.textContent = "";
    try {
      await cur.mod.onShow?.();
    } catch (err) {
      console.warn("Couldn't show the step:", err);
      say(err.message ?? String(err), "bad");
      // back to the step before, so the user isn't left on an empty one
      cur.mod.onHide?.();
      cur.el.setAttribute("hidden", "");
      step = Math.max(1, n - 1);
      stepTitle.textContent = `${step}. ${STEPS[step - 1].title}`;
      steps[step - 1].el.removeAttribute("hidden");
      await steps[step - 1].mod.onShow?.();
    }
    refreshNav();
  }

  // ---- the sheet pane: the page preview (cropping, scale) or the rendered crop (placing)
  function showPreview({ mode, crop, editable }) {
    const p = S.page;
    if (!p) return;
    const id = S.mosaic ? `m:${S.pdf.name}:${JSON.stringify(S.mosaic.views.map((v) => [v.page, v.rect_pt, v.transform_pt]))}` : `p:${S.pdf.name}:${S.pageNum}`;
    if (sourceId !== id) {
      sheet.setSource(p.preview.canvas, p.preview.k, 0, 0, false);
      sourceId = id;
    }
    sheet.setPage(p.pageWidthPt, p.pageHeightPt);
    sheet.setCrop(crop, editable, !editable);
    sheet.setMode(mode);
    $("sheet-empty").hidden = true;
  }
  function showRender(mode) {
    const r = S.raster;
    if (!r) return;
    const id = `r:${S.rasterKey}`;
    if (sourceId !== id) {
      sheet.setSource(r.canvas, r.dpi / 72, r.crop.x0, r.crop.y0, false);
      sourceId = id;
    }
    sheet.setPage(r.pageWidthPt, r.pageHeightPt);
    sheet.setCrop(null);
    sheet.setMode(mode);
    $("sheet-empty").hidden = true;
  }
  function invalidateRaster() {
    S.raster = null;
    S.rasterKey = null;
    ctx.changed("raster");
  }
  // The render resolution for the page and crop (pageRaster.renderDpi): the native-detail ceiling within the browser's
  // safety limits, or the lower dpi the user chose. null before there is a page and crop.
  // That is the saved image's (a plan in one piece); the working render the sheet is placed on is workingResolution().
  function resolution() {
    if (!S.page || !S.crop) return null;
    return renderDpi({ content: S.page.content, crop: S.crop, choice: S.dpiChoice }, DPI_LIMITS);
  }
  function workingResolution() {
    if (!S.page || !S.crop) return null;
    return renderDpi({ content: S.page.content, crop: S.crop }, WORKING_LIMITS);
  }
  // The finest the page has to show (its native detail, as a piece would be saved at most), what the close-up views
  // render at, at most.
  function finestDpi() {
    const r = resolution();
    return r ? pieceDpi(r, GEOREF.MAX_DPI) : GEOREF.MAX_DPI;
  }
  // A part of the page rendered from the PDF (page points, at dpi), for the sharp views close up: the map overlay's and
  // the sheet pane's. One at a time (pdf.js renders of one page are queued here), cancelled with signal.
  let renderQueue = Promise.resolve();
  function renderRect(rect, dpi, signal) {
    const run = renderQueue.then(() => {
      if (signal?.aborted || !S.page) throw new DOMException("The render was cancelled", "AbortError");
      return renderCrop(S.page, rect, dpi, { signal });
    });
    renderQueue = run.catch(() => {});
    return run;
  }
  // The bytes the saved image may use (PLANS.COMPRESSION.BUDGET: combined with source.pdf, or per file). The PDF takes
  // its share only when "Attach source PDF" is ticked.
  function budgetNow() {
    return imageBudget({ mode: PLANS.COMPRESSION.BUDGET, targetBytes: PLANS.COMPRESSION.TARGET_BYTES, pdfBytes: S.pdf?.size, attach: S.attachPdf });
  }
  // The crop rendered at the resolution above (cached until the page, crop or resolution changes).
  async function ensureRaster() {
    const c = S.crop;
    S.dpi = workingResolution().dpi;
    const key = [S.pdf.name, S.pageNum, c.x0, c.y0, c.x1, c.y1, S.dpi].join("|");
    if (S.raster && S.rasterKey === key) return S.raster;
    const done = busy("Rendering the sheet…");
    try {
      await new Promise((r) => requestAnimationFrame(r)); // let the message paint before the heavy work
      S.raster = await renderCrop(S.page, c, S.dpi);
      S.rasterKey = key;
      ctx.changed("raster");
      return S.raster;
    } finally {
      done();
    }
  }

  // ---- the splitter between the sheet pane and the map
  function setPaneWidth(px) {
    const row = $("content-row").getBoundingClientRect().width;
    const min = 288;
    const max = row * 0.75;
    sheetPane.style.setProperty("--sheet-pane-width", `${Math.round(Math.min(max, Math.max(min, px)))}px`);
  }
  splitter.addEventListener("pointerdown", (e) => {
    splitter.setPointerCapture(e.pointerId);
    splitter.classList.add("dragging");
    const move = (ev) => setPaneWidth(ev.clientX - sheetPane.getBoundingClientRect().left);
    const up = () => {
      splitter.classList.remove("dragging");
      splitter.removeEventListener("pointermove", move);
      splitter.removeEventListener("pointerup", up);
    };
    splitter.addEventListener("pointermove", move);
    splitter.addEventListener("pointerup", up);
  });
  splitter.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    setPaneWidth(sheetPane.getBoundingClientRect().width + (e.key === "ArrowRight" ? 24 : -24));
  });

  // ---- the parcel panel at its narrowest while the workspace is open
  // Calcite keeps a dragged width as an inline size on the panel's internal content element (the CSS variable only sets
  // the starting width), so the narrowing is the handle's own Home key (the minimum width) and the way back is the inline
  // size it had before: empty, which falls back to the default width, unless the user had dragged it.
  const shellParts = () => ({ content: parcelShell.shadowRoot?.querySelector(".content"), handle: parcelShell.shadowRoot?.querySelector("[role=separator]") });
  function narrowParcelPanel() {
    const { content, handle } = shellParts();
    saved.panelWidth = null;
    if (!content || parcelShell.collapsed) return; // collapsed: nothing to narrow (and it stays as the user left it)
    saved.panelWidth = content.style.inlineSize;
    if (handle) handle.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true, composed: true }));
    if (content.getBoundingClientRect().width > parseFloat(getComputedStyle(content).minInlineSize) + 1) content.style.inlineSize = getComputedStyle(content).minInlineSize;
  }
  function restoreParcelPanel() {
    const { content } = shellParts();
    if (content && saved.panelWidth !== null && saved.panelWidth !== undefined) content.style.inlineSize = saved.panelWidth;
    saved.panelWidth = null;
  }

  // ---- the plan mosaic (mosaicWorkspace.js): a road plan's views clipped and joined into one sheet, placed like a page
  let mosaicWs = null;
  function openMosaic() {
    if (!S.pdf) return;
    mosaicWs ??= createMosaicWorkspace($("content-row"));
    mosaicWs.open({ pdf: S.pdf, onUse: useMosaic, onClose: () => sheet?.resize() });
  }
  // The mosaic in place of the page: its points (in page space) don't carry over, so they are cleared after asking.
  async function useMosaic(def, plan = {}) {
    if (S.points.length && !window.confirm("The mosaic is a new sheet. Clear the points placed so far?")) return;
    const done = busy("Rendering the mosaic…");
    try {
      const page = await openMosaicPage(S.pdf, def);
      page.sheetName = "";
      ctx.clearPoints();
      S.mosaic = def;
      S.page = page;
      S.pageNum = def.views[0].page;
      S.crop = defaultCrop(page.pageWidthPt, page.pageHeightPt);
      S.cropTouched = false;
      if (plan.ftin && !S.scale.perInch) S.scale = { ...S.scale, perInch: plan.ftin, unit: "ft" }; // the plan scale given in the join
      sheet.setPage(page.pageWidthPt, page.pageHeightPt);
      invalidateRaster();
      ctx.changed("page");
      ctx.changed("mosaic");
      S.dirty = true;
      say(`The mosaic of ${def.views.length} views is the sheet now (${(page.pageWidthPt / 72).toFixed(1)} × ${(page.pageHeightPt / 72).toFixed(1)} in). Crop it if needed, then Next.`, "good");
      if (step !== 1) go(1); else steps[0]?.mod.onShow?.();
    } catch (err) {
      console.warn("Couldn't build the mosaic:", err);
      say(`Couldn't build the mosaic: ${err.message ?? err}`, "bad");
    } finally {
      done();
    }
  }
  // Back to a page of the PDF (the sheet step reloads it).
  function leaveMosaic() {
    if (!S.mosaic) return;
    S.mosaic = null;
    ctx.changed("mosaic");
  }

  // ---- open and close
  const guard = (e) => { if (isOpen && S.dirty) { e.preventDefault(); e.returnValue = ""; } };
  window.addEventListener("beforeunload", guard);

  async function open(opts = {}) {
    if (isOpen) return;
    const subject = searchSubject(panel.selectedFeature(), { titleFields: PARCEL_PANEL.TITLE_FIELDS });
    if (!subject || plans.state.status !== "ready") return;
    ctx.subject = subject;
    isOpen = true;
    await print?.setWorkspaceOpen(true); // restore Print's starting view before workspace layout/navigation
    S = freshState();
    step = 1; sourceId = null; busyCount = 0; closers = []; listeners.clear();

    panel.setSuspended(true, "georef");
    await measure?.clearAll();
    saved.measureDisabled = measureBlock.disabled;
    measureBlock.expanded = false;
    measureBlock.disabled = true;
    leftShell.style.setProperty("--calcite-shell-panel-width", "22rem"); // a little wider than usual for the steps
    narrowParcelPanel();
    leftShell.classList.add("workspace-open");
    document.body.classList.add("workspace-open");
    sheetPane.hidden = false;
    splitter.hidden = false;
    wsPanel.hidden = false;
    confirmRow.hidden = true;
    status.textContent = "";
    $("sheet-readout").textContent = "";
    $("sheet-empty").hidden = false;

    sheet = new SheetView($("sheet-host"), $("sheet-canvas"));
    sheet.setDetail({ render: renderRect, maxDpi: finestDpi }); // zoomed in, the PDF itself at the screen's resolution
    $("sheet-zoom-in").onclick = () => sheet.zoomBy(1.4);
    $("sheet-zoom-out").onclick = () => sheet.zoomBy(1 / 1.4);
    $("sheet-fit").onclick = () => sheet.fit();
    sheet.onCursor = (pt) => {
      const el = $("sheet-readout");
      if (!pt) { el.textContent = ""; return; }
      let text = `x ${pt.x.toFixed(1)} pt   y ${pt.y.toFixed(1)} pt`;
      if (S.raster && sourceId?.startsWith("r:")) {
        const px = ptToPx(S.raster, pt.x, pt.y);
        text += `   col ${Math.round(px.col)}  row ${Math.round(px.row)} px`;
      }
      el.textContent = text;
    };

    ctx.placement = await createPlacement(ctx);
    if (ctx.placement.problem) { say(ctx.placement.problem, "bad"); console.warn(ctx.placement.problem); ctx.placement = null; }
    steps = STEPS.map((def) => {
      if (!def.create || (def.id === "place" && !ctx.placement)) return null;
      const mod = def.create(ctx);
      mod.el.setAttribute("hidden", "");
      stepHost.append(mod.el);
      return { def, mod, el: mod.el };
    });
    wsPanel.querySelector(".ws-title").textContent = "Georeference plan PDF";
    stepTitle.textContent = `1. ${STEPS[0].title}`;
    steps[0].el.removeAttribute("hidden");
    steps[0].mod.onShow?.();
    refreshNav();

    // Zoom the map to the feature once the layout has settled; it stays outlined for reference.
    setTimeout(() => zoomToSubject(subject), 300);
    ctx.changed("open");
    if (opts.edit) await beginEdit(opts.edit);
  }

  // The parcel as before (from the parcel layer); another feature from its own layer, or as it was clicked. A point (or
  // a feature with no width) is centred at a close scale instead.
  async function zoomToSubject(subject) {
    try {
      const source = subject.isParcel ? parcel : subject.layer;
      let geometry = subject.geometry;
      if (source?.queryFeatures && subject.oid !== null) {
        const { features } = await source.queryFeatures({ objectIds: [subject.oid], returnGeometry: true, outFields: [], outSpatialReference: mapEl.spatialReference });
        geometry = features[0]?.geometry ?? (subject.isParcel ? null : geometry);
      }
      if (!isOpen || !geometry) return;
      const extent = geometry.extent;
      if (extent && (extent.width > 0 || extent.height > 0)) await mapEl.goTo(extent.clone().expand(2.2));
      else await mapEl.goTo({ target: geometry, scale: Math.min(mapEl.scale || 1200, 1200) });
    } catch (err) {
      if (err?.name !== "AbortError") console.warn("Couldn't zoom to the selected feature:", err);
    }
  }

  // ---- reopening a saved plan (saving then updates it in place). A piece of a group reopens the whole group: every
  // piece is read (attributes, footprint in the layer's own spatial reference, attachment ids), so the save can update,
  // add and delete pieces, and undo itself if it fails.
  async function beginEdit(plan) {
    const F = PLANS.FIELDS;
    const a = plan.attributes;
    const done = busy("Opening the plan…");
    try {
      const layer = plans.state.layer;
      const oidField = layer.objectIdField;
      const groupId = (F.GROUP_ID && a[F.GROUP_ID]) || null;
      const { features } = await layer.queryFeatures({
        where: groupId ? groupWhere(F, groupId) : `${oidField} = ${Number(plan.objectId)}`,
        outFields: ["*"], returnGeometry: true, outSpatialReference: layer.spatialReference,
      });
      const ids = features.map((f) => f.attributes[oidField]);
      const files = ids.length ? await layer.queryAttachments({ objectIds: ids }) : {};
      const existing = features.map((f) => ({
        objectId: f.attributes[oidField],
        pieceNo: groupId ? Number(f.attributes[F.PIECE_NO]) || 1 : 1,
        attributes: editableAttributes(f.attributes, layer.fields),
        geometry: f.geometry ? { rings: f.geometry.rings, wkid: layer.spatialReference.wkid } : null,
        files: (files[f.attributes[oidField]] ?? []).map((i) => ({ id: i.id, name: i.name, size: i.size, url: i.url })),
      })).sort((p, q) => p.pieceNo - q.pieceNo);
      if (!existing.some((r) => r.objectId === plan.objectId)) throw new Error("The plan's record couldn't be read again.");
      const items = existing.find((r) => r.objectId === plan.objectId).files;
      const [esriRequest] = await $arcgis.import(["@arcgis/core/request.js"]);
      const fetchItem = async (item) => (await esriRequest(item.url, { responseType: "blob" })).data;
      let json = a[F.TRANSFORM_JSON];
      if (!json) {
        const g = items.find((i) => i.name === "georef.json");
        json = g ? await (await fetchItem(g)).text() : null;
      }
      let parsed = null;
      try { parsed = json ? JSON.parse(json) : null; } catch { /* reported below */ }
      const res = stateFromRecord(a, parsed, F, GEOREF.WORKING_WKID);
      if (!res.ok) { say(res.error, "bad"); S.edit = null; return; }
      // the PDF, on whichever piece holds it (piece 1 when saved by this version)
      const holder = existing.find((r) => r.attributes[F.PDF_ATTACHED] === "Yes" && r.files.some((f) => f.name === ATTACHMENT.PDF));
      const pdfItem = holder?.files.find((f) => f.name === ATTACHMENT.PDF);
      S.edit = { objectId: plan.objectId, groupId, existing, state: res.state, restored: false, hadPdf: !!pdfItem, pdf: null };
      S.attachPdf = !!pdfItem; // the attachment state it was saved with
      stepTitleEditing();
      if (pdfItem) {
        const blob = await fetchItem(pdfItem);
        const name = a[F.SRC_PDF_NAME] || ATTACHMENT.PDF;
        S.edit.pdf = { pieceNo: holder.pieceNo, name, size: blob.size }; // the same file still open keeps its attachment
        await steps[0].mod.openFile(new File([blob], name, { type: "application/pdf" }));
      } else {
        const where = serverLocationOf(a, F);
        say(`The original PDF isn't stored with this plan.${where ? ` It is at ${where}.` : ""} Choose the same PDF to continue.`, "warn");
      }
    } catch (err) {
      console.warn("Couldn't open the plan for editing:", err);
      say(`Couldn't open the plan: ${err.message ?? err}`, "bad");
      S.edit = null;
    } finally {
      done();
    }
  }
  const stepTitleEditing = () => { wsPanel.querySelector(".ws-title").textContent = "Edit georeferenced plan"; };

  // After the PDF is open: put back the crop, resolution, scale, fit, points and details, and go to Place.
  async function restoreEdit() {
    const e = S.edit, st = e.state;
    // a plan placed from a mosaic: the mosaic is built again from its saved definition (in PDF points), as the sheet
    if (st.mosaic) {
      try {
        if (st.mosaic.pdf_name && S.pdf.name !== st.mosaic.pdf_name) say(`This plan's mosaic was made from ${st.mosaic.pdf_name}; the views are taken from ${S.pdf.name} at the same places.`, "warn");
        const page = await openMosaicPage(S.pdf, st.mosaic);
        page.sheetName = "";
        S.mosaic = st.mosaic;
        S.page = page;
        sheet.setPage(page.pageWidthPt, page.pageHeightPt);
        ctx.changed("page");
        ctx.changed("mosaic");
      } catch (err) {
        console.warn("Couldn't rebuild the mosaic:", err);
        say(`Couldn't rebuild the mosaic this plan was placed as: ${err.message ?? err}`, "bad");
      }
    }
    const dw = Math.abs(S.page.pageWidthPt - st.page.widthPt), dh = Math.abs(S.page.pageHeightPt - st.page.heightPt);
    if (dw > 1 || dh > 1) say("This PDF's page is a different size from the one the plan was placed on (more than 1 pt), so the saved points may not line up.", "warn");
    S.crop = { ...st.crop }; S.cropTouched = true;
    S.dpiChoice = null; // re-rendered at the page's ceiling: the points are in page space, so they don't depend on it
    S.scale = { ...st.scale };
    S.fitType = st.fitType;
    // a plan saved in pieces: the chain's own settings and rough placement come back with its pins
    if (st.chain) {
      S.chainExact = st.chain.exact;
      S.baselineRow = st.chain.baselineRow;
      S.seedFlip = st.chain.seedFlip;
      S.seedInfo = st.chain.seedInfo;
    }
    S.model = new PointsModel(GEOREF.UNDO_STEPS);
    for (const p of st.points) { const added = S.model.add({ x: p.x, y: p.y, X: p.X, Y: p.Y, snapped: p.snapped }); if (p.use === false) S.model.setUse(added.id ?? S.model.points.at(-1).id, false); }
    if (st.chain?.seed) S.model.seed = { ...st.chain.seed };
    S.thicken = st.thicken ?? null; // the line weight it was saved with
    S.model.history.length = 0;
    S.selId = null;
    S.details = { ...S.details, ...st.details, sheetTouched: true, scaleTouched: true };
    e.restored = true;
    invalidateRaster();
    ctx.placement?.refresh();
    ctx.changed("points");
    S.dirty = false;
    const tryGo = () => (busyCount ? setTimeout(tryGo, 50) : go(3)); // once the opening work has released the busy lock
    setTimeout(tryGo, 0);
  }

  function close(force = false) {
    if (!isOpen) return;
    if (!force && S.dirty) { confirmRow.hidden = false; return; }
    isOpen = false;
    ctx.changed("close");
    closers.forEach((fn) => { try { fn(); } catch (err) { console.warn(err); } });
    closers = [];
    steps.forEach((s) => s?.mod.onHide?.());
    steps = [];
    ctx.placement?.destroy();
    ctx.placement = null;
    stepHost.replaceChildren();
    mosaicWs?.destroy();
    mosaicWs = null;
    S.pdf?.destroy?.();
    sheet?.destroy();
    sheet = null;
    S = freshState();
    sheetPane.hidden = true;
    splitter.hidden = true;
    sheetPane.style.removeProperty("--sheet-pane-width");
    wsPanel.hidden = true;
    restoreParcelPanel();
    leftShell.classList.remove("workspace-open");
    document.body.classList.remove("workspace-open");
    leftShell.style.removeProperty("--calcite-shell-panel-width");
    measureBlock.disabled = !!saved.measureDisabled;
    print?.setWorkspaceOpen(false);
    panel.setSuspended(false, "georef");
    // back to the Plans block, where the plans for the parcel (including one just saved) are listed
    const plansEl = $("plans-block");
    if (plansEl && !plansEl.hidden) { plansEl.expanded = false; requestAnimationFrame(() => { plansEl.expanded = true; }); }
  }

  plansBlock?.onGeoreference(() => open());
  plansBlock?.onEdit((plan) => open({ edit: plan }));

  return {
    open, close: () => close(true),
    get isOpen() { return isOpen; },
    get state() { return S; },
    get step() { return step; },
    // handles for debugging in the console
    get sheet() { return sheet; },
    get placement() { return ctx.placement; },
    get mosaic() { return mosaicWs; },
    go,
  };
}
