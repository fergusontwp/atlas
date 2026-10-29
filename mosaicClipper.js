import { h } from "./dom.js";
import { SheetView } from "./sheetView.js";
import { renderCrop } from "./pdfRaster.js";
import { pieceDpi, renderDpi } from "./pageRaster.js";
import { GEOREF } from "./config.js";

// Step 1 of the mosaic workspace: clip the views. As the prototype's clipper (plan-mosaic.html): page navigation, zoom,
// drag a box, label it, Add clip; a list of the clips with thumbnails, reorder and delete. Clip order = road order.
// Unlike the prototype, a clip's box can be moved and resized after it is added (select it in the list or click it on
// the page), the page shows whole (no starting crop), zoomed in it is rendered again from the PDF (the sheet pane's
// close-ups), and there is no render-scale choice: the clips are rendered when the join starts (mosaicWorkspace.js).
//
// A clip: { id, label, page, rect_pt: { x, y, w, h } } in page points.
// opts: { pdf, pageInfo(n) -> Promise<openPage record>, setStatus(text), onChange(), prefs }
export function createClipper(host, { pdf, pageInfo, setStatus, onChange = () => {}, prefs }) {
  let clips = [], selected = null, draft = null, pageNum = 1, info = null, nextId = 1;

  const prevBtn = h("calcite-action", { icon: "chevron-left", text: "Previous page", scale: "s", onclick: () => goPage(pageNum - 1) });
  const nextBtn = h("calcite-action", { icon: "chevron-right", text: "Next page", scale: "s", onclick: () => goPage(pageNum + 1) });
  const pageText = h("span", { class: "mz-lbl" });
  const label = h("calcite-input-text", { scale: "s", placeholder: "view 1", label: "Clip label", onkeydown: (e) => { if (e.key === "Enter") addClip(); } });
  const addBtn = h("calcite-button", { scale: "s", iconStart: "plus", onclick: () => addClip() }, "Add clip");
  const hint = h("span", { class: "mz-mut" }, "Drag a box around one view, label it, and Add clip. Clip the views in road order.");
  const loupeSw = h("calcite-switch", { scale: "s", checked: prefs?.get("loupe") !== "off", oncalciteSwitchChange: (e) => { sheet.loupe = e.target.checked; prefs?.set("loupe", e.target.checked ? "on" : "off"); } });
  const bar = h("div", { class: "mz-row" }, prevBtn, pageText, nextBtn, label, addBtn, h("calcite-label", { layout: "inline", scale: "s", class: "mz-sw" }, loupeSw, "Magnifier"), hint);
  const canvas = h("canvas", { class: "mz-canvas" });
  const sheetBox = h("div", { class: "mz-pane-host" }, canvas);
  const list = h("div", { class: "mz-cliplist" });
  host.replaceChildren(bar, h("div", { class: "mz-clipwrap" }, h("div", { class: "mz-pane" }, sheetBox), list));
  const sheet = new SheetView(sheetBox, canvas);
  sheet.loupeIn = ["crop"];
  sheet.loupe = prefs?.get("loupe") !== "off";

  // the active box (handles): the selected clip's, or the one being drawn
  const toCrop = (r) => ({ x0: r.x, y0: r.y, x1: r.x + r.w, y1: r.y + r.h });
  const toRect = (c) => ({ x: c.x0, y: c.y0, w: c.x1 - c.x0, h: c.y1 - c.y0 });
  function syncActive() {
    const c = selected ? clips.find((x) => x.id === selected) : null;
    sheet.setCrop(c && c.page === pageNum ? toCrop(c.rect_pt) : draft && draft.page === pageNum ? toCrop(draft.rect_pt) : null, true);
    addBtn.disabled = !draft;
    renderList();
  }
  sheet.onCrop = (crop, final, kind) => {
    if (kind === "cropNew" && selected) selected = null; // dragging a new box leaves the selected clip as it was
    const c = selected ? clips.find((x) => x.id === selected) : null;
    if (c) {
      c.rect_pt = toRect(crop);
      if (final) { c.thumb = null; renderList(); onChange(); }
    } else draft = { page: pageNum, rect_pt: toRect(crop) };
    addBtn.disabled = !draft;
    sheet.requestDraw();
  };
  sheet.onCropClick = (pt) => {
    const hit = [...clips].reverse().find((c) => c.page === pageNum && pt.x >= c.rect_pt.x && pt.x <= c.rect_pt.x + c.rect_pt.w && pt.y >= c.rect_pt.y && pt.y <= c.rect_pt.y + c.rect_pt.h);
    selected = hit ? hit.id : null;
    if (hit) draft = null;
    syncActive();
  };
  // the other clips on this page: dashed boxes with their number and label
  sheet.onOverlay = (ctx, v) => {
    clips.forEach((c, i) => {
      if (c.page !== pageNum || c.id === selected) return;
      const a = v.toScreen(c.rect_pt.x, c.rect_pt.y), b = v.toScreen(c.rect_pt.x + c.rect_pt.w, c.rect_pt.y + c.rect_pt.h);
      ctx.save();
      ctx.setLineDash([8, 5]); ctx.lineWidth = 2; ctx.strokeStyle = v.colors.brand;
      ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
      ctx.fillStyle = v.colors.brand; ctx.font = "bold 14px sans-serif";
      ctx.fillText(`${i + 1} ${c.label}`, a.x + 4, a.y + 16);
      ctx.restore();
    });
  };

  async function goPage(n) {
    if (!(n >= 1 && n <= pdf.numPages)) return;
    pageNum = n;
    info = await pageInfo(n);
    if (pageNum !== n) return;
    sheet.setPage(info.pageWidthPt, info.pageHeightPt);
    sheet.setSource(info.preview.canvas, info.preview.k, 0, 0, false);
    // zoomed in, the page is rendered again from the PDF for what is in view
    const pinfo = info;
    sheet.setDetail({ render: (rect, dpi, signal) => renderCrop(pinfo, rect, dpi, { signal }), maxDpi: () => pieceDpi(renderDpi({ content: pinfo.content, crop: { x0: 0, y0: 0, x1: pinfo.pageWidthPt, y1: pinfo.pageHeightPt } }, { maxDpi: GEOREF.MAX_DPI, raster: GEOREF.RASTER, maxSide: GEOREF.MAX_CANVAS_SIDE, maxPixels: GEOREF.MAX_PIXELS }), GEOREF.MAX_DPI) });
    sheet.setMode("crop");
    pageText.textContent = `Page ${n} of ${pdf.numPages}`;
    prevBtn.disabled = n <= 1; nextBtn.disabled = n >= pdf.numPages;
    syncActive();
  }

  function addClip() {
    if (!draft) { setStatus("Drag a box on the page first."); return; }
    const c = { id: nextId++, label: String(label.value || "").trim() || `view ${clips.length + 1}`, page: draft.page, rect_pt: draft.rect_pt };
    clips.push(c);
    draft = null; label.value = "";
    syncActive();
    onChange();
    setStatus(`Clip ${clips.length} added (${(c.rect_pt.w / 72).toFixed(1)} × ${(c.rect_pt.h / 72).toFixed(1)} in on page ${c.page}). Clip the views in road order, then Join the views.`);
  }

  // a thumbnail from the page's preview (the clip is rendered at full resolution only when the join starts)
  async function thumbOf(c) {
    if (c.thumb) return c.thumb;
    const p = await pageInfo(c.page), k = p.preview.k, r = c.rect_pt;
    const t = h("canvas", { class: "mz-thumb", width: 90, height: Math.max(1, Math.round((90 * r.h) / r.w)) });
    t.getContext("2d").drawImage(p.preview.canvas, r.x * k, r.y * k, r.w * k, r.h * k, 0, 0, t.width, t.height);
    c.thumb = t;
    return t;
  }
  function renderList() {
    label.placeholder = `view ${clips.length + 1}`;
    if (!clips.length) { list.replaceChildren(h("div", { class: "mz-mut" }, "No clips yet.")); return; }
    list.replaceChildren(...clips.map((c, i) => {
      const holder = h("div", { class: "mz-thumbbox" });
      thumbOf(c).then((t) => holder.replaceChildren(t)).catch(() => {});
      const name = h("calcite-input-text", { scale: "s", value: c.label, label: `Label of clip ${i + 1}`, oncalciteInputTextChange: (e) => { c.label = e.target.value; sheet.requestDraw(); onChange(); } });
      const move = (d) => { const j = i + d; if (j < 0 || j >= clips.length) return; [clips[i], clips[j]] = [clips[j], clips[i]]; renderList(); sheet.requestDraw(); onChange(); };
      const row = h("div", { class: `mz-clip${c.id === selected ? " mz-sel" : ""}` },
        h("span", { class: "mz-num" }, `${i + 1}.`), holder, name, h("span", { class: "mz-mut" }, `p.${c.page}`),
        h("calcite-action", { icon: "chevron-up", text: "Earlier in the road", scale: "s", disabled: i === 0, onclick: () => move(-1) }),
        h("calcite-action", { icon: "chevron-down", text: "Later in the road", scale: "s", disabled: i === clips.length - 1, onclick: () => move(1) }),
        h("calcite-action", { icon: "pencil", text: "Move or resize the box", scale: "s", onclick: async () => { selected = c.id; draft = null; if (c.page !== pageNum) await goPage(c.page); syncActive(); } }),
        h("calcite-action", { icon: "trash", text: "Delete the clip", scale: "s", onclick: () => { clips.splice(i, 1); if (selected === c.id) selected = null; syncActive(); sheet.requestDraw(); onChange(); } }));
      return row;
    }));
  }

  return {
    start() { renderList(); return goPage(pageNum); },
    get clips() { return clips.map(({ id, label: l, page, rect_pt }) => ({ id, label: l, page, rect_pt: { ...rect_pt } })); },
    setClips(list) {
      clips = (list ?? []).map((c) => ({ id: nextId++, label: c.label, page: c.page, rect_pt: { ...c.rect_pt } }));
      selected = null; draft = null;
      syncActive();
    },
    resize() { sheet.resize(); },
    destroy() { sheet.destroy(); },
    get sheet() { return sheet; },
    get page() { return pageNum; },
  };
}
