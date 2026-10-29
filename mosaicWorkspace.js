import { h } from "./dom.js";
import { GEOREF, MOSAIC } from "./config.js";
import { openPage, renderCrop } from "./pdfRaster.js";
import { pieceDpi, renderDpi } from "./pageRaster.js";
import { createClipper } from "./mosaicClipper.js";
import { createJoin } from "./mosaicJoin.js";
import { defFromJoin, mosaicBlock } from "./mosaicModel.js";
import { clearDraft, draftKey, loadDraft, saveDraft } from "./mosaicDraft.js";
import { mosaicPdf } from "./mosaicExport.js";
import { saveFile } from "./download.js";
import { toast } from "./toast.js";

// The plan mosaic workspace: a road plan's views (map windows, often turned to fit the sheet, sometimes on several pages)
// clipped and joined into one sheet, before it is placed. It covers the map area (the sheet pane and the map) while open;
// the georeferencing workspace's left panel stays. Step 1 clips the views (mosaicClipper.js), step 2 joins them
// (mosaicJoin.js), "Use mosaic" hands the definition (mosaicModel.js, in PDF points) back to the georeferencing workspace,
// which places it like a page (mosaicPage.js).
//
// Work in progress is kept in the browser (mosaicDraft.js) per PDF, so a reload or a closed workspace doesn't lose it;
// opening the workspace again offers Resume or Start over.
//
// The clips are rendered for the join at one resolution: MOSAIC.JOIN_DPI, or less where the PDF holds less (a scan's own
// resolution) or a clip would pass MOSAIC.JOIN_MAX_PIXELS. That is only for joining; the placed and saved mosaic is
// rendered from the PDF again at whatever resolution it needs.
//
// open({ pdf (the workspace's S.pdf), onUse(def, { ftin, stint }), onClose() }): shows it; resolves once it is shown.
export function createMosaicWorkspace(container) {
  const status = h("div", { class: "mz-status", ariaLive: "polite" });
  const setStatus = (t) => { status.textContent = t; };
  const title = h("div", { class: "mz-title" });
  const stepSeg = h("calcite-segmented-control", { scale: "s", oncalciteSegmentedControlChange: (e) => goStep(e.target.value) },
    h("calcite-segmented-control-item", { value: "clip", checked: true }, "1. Clip views"),
    h("calcite-segmented-control-item", { value: "join" }, "2. Join"));
  const joinBtn = h("calcite-button", { scale: "s", iconEnd: "arrow-right", onclick: () => goStep("join") }, "Join the views");
  const useBtn = h("calcite-button", { scale: "s", iconStart: "check", onclick: () => use() }, "Use mosaic");
  const exportPdfItem = h("calcite-dropdown-item", { iconStart: "file-pdf", oncalciteDropdownItemSelect: () => exportPdf() }, "Export PDF");
  const exportJsonItem = h("calcite-dropdown-item", { iconStart: "file-code", oncalciteDropdownItemSelect: () => exportJson() }, "Export mosaic JSON");
  const testCaseItem = h("calcite-dropdown-item", { iconStart: "debug", oncalciteDropdownItemSelect: () => join?.saveTestCase() }, "Save test case (Auto join)");
  const startOverItem = h("calcite-dropdown-item", { iconStart: "reset", oncalciteDropdownItemSelect: () => startOver() }, "Start over");
  const more = h("calcite-dropdown", { scale: "s", placement: "bottom-end", widthScale: "m" },
    h("calcite-action", { slot: "trigger", icon: "ellipsis", text: "More", scale: "s" }),
    h("calcite-dropdown-group", { selectionMode: "none" }, exportPdfItem, exportJsonItem, testCaseItem, startOverItem));
  const closeBtn = h("calcite-action", { icon: "x", text: "Close the mosaic workspace", scale: "s", onclick: () => close() });
  const resumeBox = h("div", { class: "mz-resume", hidden: true });
  const clipHost = h("div", { class: "mz-step" }), joinHost = h("div", { class: "mz-step", hidden: true });
  const el = h("div", { class: "mosaic-ws", hidden: true, role: "dialog", ariaLabel: "Plan mosaic" },
    h("div", { class: "mz-top" }, h("div", { class: "mz-head" }, title, stepSeg, h("div", { class: "mz-spacer" }), joinBtn, useBtn, more, closeBtn), status, resumeBox),
    clipHost, joinHost);
  container.append(el);

  const prefs = {
    get: (k) => { try { return localStorage.getItem(`atlas.mosaic.${k}`); } catch { return null; } },
    set: (k, v) => { try { localStorage.setItem(`atlas.mosaic.${k}`, v); } catch { /* not kept */ } },
  };

  let pdf = null, onUse = null, onClose = null, clipper = null, join = null, step = "clip", key = "", rendered = "", saveTimer = 0;
  const pages = new Map();
  const pageInfo = (n) => { if (!pages.has(n)) pages.set(n, openPage(pdf, n).catch((err) => { pages.delete(n); throw err; })); return pages.get(n); };

  const clipsKey = () => JSON.stringify((clipper?.clips ?? []).map((c) => [c.page, c.rect_pt]));
  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (!pdf || !clipper) return;
      saveDraft(key, { pdf: { name: pdf.name, size: pdf.size }, step, clips: clipper.clips.map(({ label, page, rect_pt }) => ({ label, page, rect_pt })), joinFor: rendered, join: rendered && join ? join.state() : null });
    }, 500);
  }
  function renderControls() {
    stepSeg.querySelectorAll("calcite-segmented-control-item").forEach((i) => { i.checked = i.value === step; });
    joinBtn.hidden = step !== "clip";
    useBtn.hidden = step !== "join";
    useBtn.disabled = !join || join.placed.length < 2;
    exportPdfItem.disabled = exportJsonItem.disabled = !join || !join.placed.length || step !== "join";
    testCaseItem.disabled = step !== "join";
  }

  // The clips rendered for the join, all at one scale (px per point).
  async function renderViews(clips) {
    const limits = { maxDpi: GEOREF.MAX_DPI, raster: GEOREF.RASTER, maxSide: GEOREF.MAX_CANVAS_SIDE, maxPixels: GEOREF.MAX_PIXELS };
    let dpi = MOSAIC.JOIN_DPI;
    for (const c of clips) {
      const info = await pageInfo(c.page), crop = { x0: c.rect_pt.x, y0: c.rect_pt.y, x1: c.rect_pt.x + c.rect_pt.w, y1: c.rect_pt.y + c.rect_pt.h };
      dpi = Math.min(dpi, pieceDpi(renderDpi({ content: info.content, crop }, limits), GEOREF.MAX_DPI), 72 * Math.sqrt(MOSAIC.JOIN_MAX_PIXELS / (c.rect_pt.w * c.rect_pt.h)));
    }
    const out = [];
    for (const [i, c] of clips.entries()) {
      setStatus(`Rendering the views for the join: ${i + 1} of ${clips.length} at ${Math.round(dpi)} dpi…`);
      const info = await pageInfo(c.page);
      const r = await renderCrop(info, { x0: c.rect_pt.x, y0: c.rect_pt.y, x1: c.rect_pt.x + c.rect_pt.w, y1: c.rect_pt.y + c.rect_pt.h }, dpi);
      out.push({ label: c.label, canvas: r.canvas, clip: { page: c.page, rect_pt: c.rect_pt } });
    }
    return { views: out, s: dpi / 72 };
  }

  async function goStep(to, restoreJoin = null) {
    if (to === "join") {
      const clips = clipper.clips;
      if (clips.length < 2) { setStatus("Add at least two clips first (one per view, in road order)."); step = "clip"; renderControls(); return; }
      const want = clipsKey();
      if (want !== rendered) {
        if (join && join.placed.length > 1 && !restoreJoin && !window.confirm("The clips changed since the views were joined. Join them again from the start?")) { step = "clip"; renderControls(); return; }
        step = "join"; renderControls();
        clipHost.hidden = true; joinHost.hidden = false;
        try {
          const { views, s } = await renderViews(clips);
          join.setViews(views, s);
          rendered = want;
          if (restoreJoin) join.restore(restoreJoin);
        } catch (err) {
          console.warn("Couldn't render the views:", err);
          setStatus(`Couldn't render the views: ${err.message}`);
          step = "clip"; clipHost.hidden = false; joinHost.hidden = true; renderControls();
          return;
        }
      }
      step = "join";
      // the labels may have changed (they don't need a new render)
      join.views.forEach((v, i) => { if (clips[i]) v.label = clips[i].label; });
    } else step = "clip";
    clipHost.hidden = step !== "clip";
    joinHost.hidden = step !== "join";
    renderControls();
    requestAnimationFrame(() => (step === "join" ? join.resize() : clipper.resize()));
    if (step === "clip") setStatus("Drag a box around one view, label it, and Add clip. Clip order = road order. Click a box (or the pencil) to move or resize it.");
    else join && join.views.length && join.resize();
    scheduleSave();
  }

  function definition() {
    const clips = clipper.clips;
    return defFromJoin({ pdfName: pdf.name, pdfSize: pdf.size, s: join.scale, clips: join.placed.map((p) => clips[p.i]),
      placed: join.placed.map(({ a, b, tx, ty, seam }) => ({ a, b, tx, ty, seam })) });
  }
  function use() {
    if (!join || join.placed.length < 2) { setStatus("Add at least one more view to the mosaic first."); return; }
    const n = join.placed.length, all = join.views.length;
    if (n < all && !window.confirm(`Only ${n} of the ${all} views are in the mosaic. Use it as it is?`)) return;
    const def = definition();
    scheduleSave();
    hide();
    onUse?.(def, join.planScale);
  }
  async function exportPdf() {
    const src = join?.source;
    if (!src) return;
    setStatus("Building the PDF…");
    try {
      const out = await mosaicPdf(src, 72 * join.scale, (f) => setStatus(`Building the PDF… ${Math.round(f * 100)}%`));
      saveFile(out.blob, `${(pdf.name || "plan").replace(/\.pdf$/i, "")}-mosaic.pdf`, "application/pdf");
      setStatus(`PDF saved: ${src.width.toLocaleString("en-US")} × ${src.height.toLocaleString("en-US")} px${out.tiles > 1 ? ` (in ${out.tiles} side-by-side tiles)` : ""}, page ${(out.wpt / 72).toFixed(1)} × ${(out.hpt / 72).toFixed(1)} in, ${(out.blob.size / 1048576).toFixed(1)} MB. No resampling.${out.scaled ? ` The page was scaled down to the 200 in PDF limit (${Math.round(out.ppi)} pixels/inch); the pixels are not reduced.` : ""}`);
    } catch (err) {
      setStatus(`PDF export failed: ${err.message}. The mosaic may be too large for this browser.`);
    }
  }
  function exportJson() {
    if (!join || !join.placed.length) return;
    const def = definition();
    saveFile(JSON.stringify({ tool: "Atlas plan mosaic", note: "Views in PDF points: transform_pt maps view points (origin at the clip's top-left) to mosaic points (origin at the mosaic's top-left).", ...mosaicBlock(def), plan_scale: join.planScale }, null, 2),
      `${(pdf.name || "plan").replace(/\.pdf$/i, "")}-mosaic.json`, "application/json");
  }
  async function startOver() {
    if (!window.confirm("Start the mosaic over? The clips and joins for this PDF are removed.")) return;
    await clearDraft(key);
    rendered = "";
    clipper.setClips([]);
    join.setViews([], 1);
    resumeBox.hidden = true;
    goStep("clip");
  }

  function keydown(e) {
    if (el.hidden || step !== "join" || !join) return;
    const t = e.composedPath?.()[0] ?? e.target;
    if (["INPUT", "SELECT", "TEXTAREA"].includes(t?.tagName) || t?.isContentEditable || /^CALCITE-INPUT/.test(e.target?.tagName ?? "")) return;
    if (join.key(e)) e.preventDefault();
  }
  const onResize = () => { if (!el.hidden) (step === "join" ? join?.resize() : clipper?.resize()); };

  function hide() {
    el.hidden = true;
    document.removeEventListener("keydown", keydown);
    window.removeEventListener("resize", onResize);
  }
  function close() {
    hide();
    scheduleSave();
    onClose?.();
  }

  return {
    get open() { return !el.hidden; },
    async open({ pdf: p, onUse: use_, onClose: close_ }) {
      onUse = use_; onClose = close_;
      if (pdf !== p) {
        pdf = p; key = draftKey(p); pages.clear(); rendered = ""; step = "clip";
        clipper?.destroy(); join?.destroy();
        clipper = createClipper(clipHost, { pdf, pageInfo, setStatus, onChange: () => { scheduleSave(); renderControls(); }, prefs });
        join = createJoin(joinHost, { setStatus, onChange: () => { scheduleSave(); renderControls(); }, prefs });
      }
      title.textContent = `Plan mosaic: ${pdf.name}`;
      el.hidden = false;
      document.addEventListener("keydown", keydown);
      window.addEventListener("resize", onResize);
      clipHost.hidden = step !== "clip"; joinHost.hidden = step !== "join";
      renderControls();
      await clipper.start();
      setStatus("Drag a box around one view, label it, and Add clip. Clip order = road order. Click a box (or the pencil) to move or resize it.");
      // a draft for this PDF: offer to resume it (only when nothing is open in this session yet)
      const draft = !clipper.clips.length ? await loadDraft(key) : null;
      if (draft?.clips?.length) {
        const when = new Date(draft.saved).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
        const n = draft.join?.placed?.length ?? 0;
        resumeBox.replaceChildren(h("calcite-notice", { open: true, kind: "info", scale: "s", icon: "save" },
          h("div", { slot: "message" }, `There is unfinished work on this PDF from ${when}: ${draft.clips.length} clips${n > 1 ? `, ${n} views joined` : ""}.`),
          h("calcite-button", { slot: "actions-end", scale: "s", onclick: async () => { resumeBox.hidden = true; clipper.setClips(draft.clips); if (draft.step === "join" && draft.join) await goStep("join", draft.join); else goStep("clip"); toast("Mosaic resumed"); } }, "Resume"),
          h("calcite-button", { slot: "actions-end", scale: "s", appearance: "outline", onclick: async () => { resumeBox.hidden = true; await clearDraft(key); } }, "Start over")));
        resumeBox.hidden = false;
      }
    },
    close,
    destroy() { hide(); clipper?.destroy(); join?.destroy(); el.remove(); },
    // for the harness and the console
    get debug() { return { clipper, join, el, step }; },
  };
}
