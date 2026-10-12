import { h } from "./dom.js";
import { GEOREF } from "./config.js";
import { cropFits, cropFromInputs, cropInches, defaultCrop } from "./cropMath.js";
import { sheetName } from "./pageRaster.js";
import { openPage, openPdf } from "./pdfRaster.js";
import { field, fmt, kv, note, numberInput, setIfIdle } from "./wsUi.js";

// Step 1: open the plan PDF, choose the page, frame the plan view (crop) on the page preview.
export function createStepSheet(ctx) {
  const { S } = ctx;
  const message = h("calcite-notice", { kind: "danger", scale: "s", width: "auto", open: true, hidden: true },
    h("div", { slot: "title" }), h("div", { slot: "message" }));
  const fileInput = h("input", { type: "file", accept: ".pdf,application/pdf", hidden: true });
  const chooseButton = h("calcite-button", { appearance: "outline", scale: "s", onclick: () => fileInput.click() }, "Choose PDF");
  const drop = h("div", { class: "plan-drop" },
    h("calcite-icon", { icon: "upload", scale: "m" }), h("span", {}, "Drop a plan PDF here"), chooseButton, fileInput);
  const info = h("div", {});
  const pageBox = h("div", { hidden: true });
  const pageInput = numberInput({ value: 1, min: 1, step: 1, integer: true, label: "Page", width: "7rem", onChange: (v) => changePage(Number(v)) });
  const pageOf = h("span", { class: "plan-note" });
  pageBox.append(field("Page", h("div", { class: "ws-row" }, pageInput, pageOf)));
  const cropBox = h("div", { hidden: true });
  const cropInputs = ["x0", "y0", "x1", "y1"].map((key, i) => numberInput({
    label: ["Left", "Top", "Right", "Bottom"][i], step: 1, suffix: "pt", onChange: () => applyCropInputs(),
  }));
  const cropSize = h("div", { class: "plan-note" });
  const hint = note("Drag on the sheet to frame the plan view. Leave out the title block and tables. Scroll to zoom; drag with the right button to move the sheet.");
  cropBox.append(
    h("div", { class: "ws-step-title" }, "Crop"), hint,
    h("div", { class: "ws-grid2" }, ...cropInputs.map((el, i) => field(["Left", "Top", "Right", "Bottom"][i], el))),
    cropSize,
    h("calcite-button", { appearance: "outline", scale: "s", onclick: () => { S.crop = defaultCrop(S.page.pageWidthPt, S.page.pageHeightPt); S.cropTouched = false; cropChanged(); } }, "Reset crop"),
  );
  const el = h("div", {}, message, drop, info, pageBox, cropBox);

  function showError(title, text) {
    message.querySelector('[slot="title"]').textContent = title;
    message.querySelector('[slot="message"]').textContent = text;
    message.hidden = false;
  }

  function syncCropInputs() {
    if (!S.crop) return;
    [S.crop.x0, S.crop.y0, S.crop.x1, S.crop.y1].forEach((v, i) => setIfIdle(cropInputs[i], +v.toFixed(2)));
    const { w, h: hh } = cropInches(S.crop);
    cropSize.textContent = `${w.toFixed(2)} × ${hh.toFixed(2)} in`;
  }
  function cropChanged() {
    syncCropInputs();
    ctx.sheet.setCrop(S.crop, true);
    ctx.invalidateRaster();
    ctx.changed("crop");
  }
  function applyCropInputs() {
    const r = cropFromInputs(cropInputs.map((i) => i.value), S.page.pageWidthPt, S.page.pageHeightPt, GEOREF.MIN_CROP_PT);
    if (r.error) { ctx.say(r.error, "warn"); syncCropInputs(); return; }
    S.crop = r.crop;
    S.cropTouched = true;
    cropChanged();
  }

  function renderInfo() {
    const p = S.page;
    const size = `${(p.pageWidthPt / 72).toFixed(2)} × ${(p.pageHeightPt / 72).toFixed(2)} in${p.sheetName ? ` (${p.sheetName})` : ""}`;
    info.replaceChildren(kv([["File", S.pdf.name], ["Page size", size], ["File size", `${fmt(S.pdf.size / 1024)} KB`]]));
    pageBox.hidden = S.pdf.numPages < 2;
    pageInput.max = S.pdf.numPages;
    pageInput.value = String(S.pageNum);
    pageOf.textContent = `of ${S.pdf.numPages}`;
    cropBox.hidden = false;
  }

  async function loadPage(n) {
    const done = ctx.busy("Reading the page…");
    try {
      const info = await openPage(S.pdf, n);
      info.sheetName = sheetName(info.pageWidthPt, info.pageHeightPt, GEOREF.SHEETS);
      S.page = info;
      S.pageNum = n;
      if (!(S.crop && cropFits(S.crop, info.pageWidthPt, info.pageHeightPt, GEOREF.MIN_CROP_PT))) S.crop = defaultCrop(info.pageWidthPt, info.pageHeightPt);
      ctx.invalidateRaster();
      ctx.sheet.setPage(info.pageWidthPt, info.pageHeightPt);
      renderInfo();
      syncCropInputs();
      show();
      ctx.changed("page");
    } finally {
      done();
    }
  }

  async function changePage(n) {
    if (!S.pdf || !(n >= 1 && n <= S.pdf.numPages) || n === S.pageNum) return;
    if (S.points.length && !ctx.confirmClearPoints?.()) { pageInput.value = String(S.pageNum); return; }
    ctx.clearPoints?.();
    try { await loadPage(n); } catch (err) { showError("Couldn't read that page", err.message ?? String(err)); }
  }

  async function openFile(file) {
    message.hidden = true;
    if (!file) return;
    if (!/\.pdf$/i.test(file.name) && file.type !== "application/pdf") { showError("That isn't a PDF", `${file.name} doesn't look like a PDF file.`); return; }
    const done = ctx.busy("Opening the PDF…");
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const pdf = await openPdf(bytes);
      S.pdf?.destroy?.();
      S.pdf = { ...pdf, name: file.name, size: file.size, bytes };
      const editing = !!S.edit && !S.edit.restored; // reopening a saved plan: its own page, crop and points come back
      if (!editing) { S.crop = null; ctx.clearPoints?.(); }
      await loadPage(editing ? Math.min(S.edit.state.pageNumber, pdf.numPages) : 1);
      if (editing) { await ctx.restoreEdit(); return; }
      ctx.markDirty();
      if (pdf.numPages > 1) ctx.say(`This PDF has ${pdf.numPages} pages. Using page 1; change it above.`);
    } catch (err) {
      console.warn("Couldn't open the PDF:", err);
      showError("Couldn't open that PDF", err.message ?? String(err));
    } finally {
      done();
    }
  }

  fileInput.addEventListener("change", () => {
    const [file] = fileInput.files;
    fileInput.value = ""; // so choosing the same file again still fires
    openFile(file);
  });
  const dropTarget = (target) => {
    target.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("dragging"); });
    target.addEventListener("dragleave", () => drop.classList.remove("dragging"));
    target.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("dragging"); openFile(e.dataTransfer.files[0]); });
  };
  dropTarget(drop);
  dropTarget(document.getElementById("sheet-pane"));

  function show() {
    ctx.showPreview({ mode: "crop", crop: S.crop, editable: true });
  }
  ctx.sheet.onCrop = (crop, final) => {
    S.crop = crop;
    S.cropTouched = true;
    syncCropInputs();
    if (final) { ctx.invalidateRaster(); ctx.changed("crop"); }
    ctx.markDirty();
  };

  return {
    el,
    onShow() { if (S.page) { renderInfo(); syncCropInputs(); show(); } },
    canNext: () => !!S.pdf && !!S.page,
    openFile,
  };
}
