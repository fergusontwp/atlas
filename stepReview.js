import { h } from "./dom.js";
import { PLANS } from "./config.js";
import { accuracyClass } from "./georefAnalysis.js";
import { errorText, verdictText } from "./georefMessages.js";
import { compressPlan } from "./compressClient.js";
import { footprintCoverage, projectPoints } from "./planCoverage.js";
import { summarizeCoverage, coverageSentence, classifyCoverage } from "./plansLogic.js";
import {
  POLICY_TEXT, accuracyNotes, orientClockwise, buildPlanRecord, bytesText, footprintSize, savePolicy, scaleFactorText, tierText, validateDetails,
} from "./planRecord.js";
import { createLayerStore } from "./plansStore.js";
import { savePlan } from "./savePlan.js";
import { fmt, kv, note } from "./wsUi.js";

const VERDICT_TONE = { good: "good", ok: "warn", review: "bad" };

// Step 5: the last look before anything is written. Shows the footprint and what it covers, the error and its class,
// prepares the image (the compression planner runs on the final render), and previews the save: the exact record and
// attachments, with nothing written. (Writing to the Plans layer is the next phase.)
export function createStepReview(ctx) {
  const { S } = ctx;
  const F = PLANS.FIELDS;

  const summaryHost = h("div", {});
  const canvas = h("canvas", { class: "ws-preview", width: 10, height: 10 });
  const canvasNote = note("");
  const coverageHost = h("div", { class: "plan-note" });
  const warnHost = h("div", {});
  const confirmBox = h("calcite-checkbox", { oncalciteCheckboxChange: (e) => { S.confirmClass = e.target.checked ? classNow() : null; render(); } });
  const confirmRow = h("calcite-label", { layout: "inline", scale: "s", hidden: true }, confirmBox, "I've checked the placement and want to save it as it is");
  const imageHost = h("div", {});
  const cancelCompress = h("calcite-button", { scale: "s", appearance: "outline", hidden: true, onclick: () => abortCompress?.abort() }, "Cancel");
  const saveButton = h("calcite-button", { iconStart: "save", onclick: () => save() }, "Save plan");
  const dryButton = h("calcite-button", { appearance: "outline", iconStart: "file-text", onclick: () => dryRun() }, "Preview the save");
  const dryWhy = h("div", { class: "plan-note" });
  const dryOut = h("div", {});
  const saveOut = h("div", { ariaLive: "polite" });
  let saving = false;

  const editNote = note("You are editing a saved plan. Saving adds a new version and marks the earlier one superseded.");
  editNote.hidden = true;
  const el = h("div", {},
    editNote,
    summaryHost,
    h("div", { class: "ws-step-title" }, "Footprint"),
    canvas, canvasNote, coverageHost,
    warnHost, confirmRow,
    h("div", { class: "ws-step-title" }, "Image"),
    imageHost, h("div", { class: "ws-row" }, cancelCompress),
    h("div", { class: "ws-step-title" }, "Save"),
    h("div", { class: "ws-row" }, saveButton, dryButton), dryWhy, saveOut, dryOut,
  );

  // ---- derived values
  const classNow = () => accuracyClass(S.analysis?.quality);
  const ringNow = () => {
    const c = ctx.placement?.footprint();
    return c ? orientClockwise([...c, c[0]]) : null;
  };
  const policyNow = () => savePolicy({ accuracyClass: classNow(), confirmed: S.confirmClass !== null && S.confirmClass === classNow() });

  // ---- coverage of parcels (async, cached by footprint)
  let cov = { key: null, status: "idle", data: null, error: null };
  let abortCoverage = null;
  async function ensureCoverage() {
    const ring = ringNow();
    if (!ring) return;
    const key = JSON.stringify(ring);
    if (cov.key === key && cov.status !== "error") return;
    abortCoverage?.abort();
    const controller = (abortCoverage = new AbortController());
    cov = { key, status: "running", data: null, error: null };
    render();
    try {
      const data = await footprintCoverage({ parcel: ctx.parcel, ring, signal: controller.signal });
      if (controller.signal.aborted) return;
      const pts = await projectPoints(S.points.filter((p) => p.use !== false).map((p) => [p.X, p.Y]), ctx.parcel.spatialReference);
      cov = { key, status: "done", data: { ...data, points: S.points.filter((p) => p.use !== false).map((p, i) => ({ xy: pts[i], snapped: !!p.snapped })) }, error: null };
    } catch (err) {
      if (err?.name === "AbortError" || controller.signal.aborted) return;
      console.warn("Couldn't work out what the footprint covers:", err);
      cov = { key, status: "error", data: null, error: err };
    }
    render();
  }

  // ---- the image (compression planner on the final render, cached by render)
  let comp = { key: null, status: "idle", result: null, progress: "", error: null };
  let abortCompress = null;
  async function ensureImage() {
    const key = S.rasterKey;
    if (key && comp.key === key && (comp.status === "running" || comp.status === "done")) return;
    abortCompress?.abort();
    const controller = (abortCompress = new AbortController());
    comp = { key: null, status: "running", result: null, progress: "Preparing the image…", error: null };
    render();
    try {
      const raster = await ctx.ensureRaster();
      if (controller.signal.aborted) return;
      comp.key = S.rasterKey;
      const result = await compressPlan(raster.canvas, PLANS.COMPRESSION, {
        signal: controller.signal,
        onProgress: (m) => {
          comp.progress = `Trying ${tierText(m.tier).toLowerCase()}${m.scale && m.scale < 1 ? ` at ${Math.round(m.scale * 100)}%` : ""}${m.quality ? `, quality ${Math.round(m.quality * 100)}` : ""}…`;
          renderImage();
        },
      });
      if (controller.signal.aborted) return;
      comp = { key, status: result.ok ? "done" : "error", result: result.ok ? result : null, progress: "", error: result.ok ? null : new Error("The image is too large to save, even in tiles. Choose a smaller crop or a lower resolution.") };
    } catch (err) {
      if (err?.name === "AbortError") { comp = { key: null, status: "cancelled", result: null, progress: "", error: null }; }
      else { console.warn("Couldn't prepare the image:", err); comp = { key: null, status: "error", result: null, progress: "", error: err }; }
    }
    render();
  }

  // ---- drawing the footprint preview
  function drawPreview() {
    const data = cov.status === "done" ? cov.data : null;
    const css = getComputedStyle(document.documentElement);
    const brand = css.getPropertyValue("--calcite-color-brand").trim() || "#007ac2";
    const dim = css.getPropertyValue("--calcite-color-text-3").trim() || "#6a6a6a";
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(200, canvas.parentElement?.clientWidth || el.clientWidth || 300);
    const hgt = 190;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${hgt}px`;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(hgt * dpr);
    const g = canvas.getContext("2d");
    g.scale(dpr, dpr);
    g.clearRect(0, 0, w, hgt);
    if (!data) return;
    const fp = data.footprint;
    const xs = fp.map((p) => p[0]), ys = fp.map((p) => p[1]);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    const pad = 10;
    const k = Math.min((w - 2 * pad) / Math.max(1e-9, x1 - x0), (hgt - 2 * pad) / Math.max(1e-9, y1 - y0));
    const ox = (w - k * (x1 - x0)) / 2, oy = (hgt - k * (y1 - y0)) / 2;
    const px = (p) => [ox + (p[0] - x0) * k, hgt - (oy + (p[1] - y0) * k)];
    const path = (ring) => { g.beginPath(); ring.forEach((p, i) => { const [a, b] = px(p); i ? g.lineTo(a, b) : g.moveTo(a, b); }); g.closePath(); };
    for (const parcel of data.shares) {
      const on = classifyCoverage(parcel.share, PLANS.COVER_MIN) === "on";
      g.globalAlpha = on ? 0.28 : 0.1;
      g.fillStyle = on ? brand : dim;
      for (const ring of parcel.rings) { path(ring); g.fill(); }
      g.globalAlpha = on ? 0.9 : 0.5;
      g.strokeStyle = on ? brand : dim;
      g.lineWidth = 1;
      for (const ring of parcel.rings) { path(ring); g.stroke(); }
    }
    g.globalAlpha = 1;
    g.setLineDash([5, 4]);
    g.strokeStyle = brand;
    g.lineWidth = 1.5;
    path(fp);
    g.stroke();
    g.setLineDash([]);
    for (const p of data.points) {
      const [a, b] = px(p.xy);
      g.beginPath();
      g.arc(a, b, 3.5, 0, Math.PI * 2);
      g.fillStyle = p.snapped ? brand : "#fff";
      g.fill();
      g.strokeStyle = brand;
      g.lineWidth = 1.5;
      g.stroke();
    }
  }

  // ---- rendering
  function renderSummary() {
    const A = S.analysis;
    if (!A?.T) { summaryHost.replaceChildren(note("There is no fit yet. Go back to Place and add points.", "bad")); return; }
    const used = S.points.filter((p) => p.use !== false);
    const cls = classNow();
    const ring = ringNow();
    const size = ring ? footprintSize(ring) : null;
    const verdict = h("span", { class: VERDICT_TONE[A.quality] ? `ws-note-${VERDICT_TONE[A.quality]}` : "" }, `Class ${cls} · ${verdictText(A.quality, Math.max(A.rms || 0, Number.isFinite(A.looRms) ? A.looRms : 0))}`);
    summaryHost.replaceChildren(kv([
      ["Plan", S.details.name.trim() || "(no name yet)"],
      ["Accuracy", verdict],
      ["Error", `RMS ${errorText(A.rms)}${Number.isFinite(A.looRms) ? `, check ${errorText(A.looRms)}` : ""}`],
      ["Points", `${used.length} in the fit, ${used.filter((p) => p.snapped).length} snapped to parcel corners`],
      ["Fit", { similarity: "Similarity", locked: "Locked scale", affine: "Affine" }[S.fitType] ?? S.fitType],
      ["On the ground", size ? `${fmt(size.width)} × ${fmt(size.height)} ft` : ""],
    ]));
  }

  function renderCoverage() {
    if (cov.status === "running") { coverageHost.textContent = "Checking which parcels the footprint covers…"; canvasNote.textContent = ""; }
    else if (cov.status === "error") { coverageHost.textContent = "Couldn't check which parcels the footprint covers. You can still save."; coverageHost.className = "plan-note ws-note-warn"; return; }
    else if (cov.status === "done") {
      const sum = summarizeCoverage(cov.data.shares.map((s) => s.share), PLANS.COVER_MIN);
      coverageHost.textContent = `${coverageSentence(sum, PLANS.COVER_MIN)}${cov.data.overflow ? ` (Only the first ${PLANS.REVIEW_MAX_PARCELS} parcels were counted.)` : ""}`;
      canvasNote.textContent = "Dashed: the footprint. Shaded: parcels it covers 80% or more of. Dots: your points (open dots were placed freely).";
    }
    coverageHost.className = "plan-note";
  }

  function renderWarnings() {
    const cls = classNow();
    const pol = policyNow();
    warnHost.replaceChildren();
    if (pol.reason) warnHost.append(note(POLICY_TEXT[pol.reason], "warn"));
    for (const text of accuracyNotes(S.points)) warnHost.append(note(text));
    confirmRow.hidden = !pol.needsConfirm;
    confirmBox.checked = pol.needsConfirm && pol.canSave;
    void cls;
  }

  function renderImage() {
    cancelCompress.hidden = comp.status !== "running";
    if (comp.status === "running") { imageHost.replaceChildren(h("div", { class: "ws-busy" }, h("calcite-loader", { inline: true, label: "Preparing" }), h("span", {}, comp.progress))); return; }
    if (comp.status === "error") { imageHost.replaceChildren(note(comp.error?.message ?? "The image couldn't be prepared.", "bad")); return; }
    if (comp.status === "cancelled") { imageHost.replaceChildren(note("Preparing the image was cancelled."), h("calcite-button", { scale: "s", appearance: "outline", onclick: () => ensureImage() }, "Prepare again")); return; }
    const r = comp.result;
    if (!r) { imageHost.replaceChildren(); return; }
    imageHost.replaceChildren(kv([
      ["Format", tierText(r.tier) + (r.quality ? ` (quality ${Math.round(r.quality * 100)})` : "")],
      ["Size", `${fmt(r.width)} × ${fmt(r.height)} px`],
      ["File size", `${bytesText(r.finalBytes)}${r.origBytes > r.finalBytes ? ` (was ${bytesText(r.origBytes)})` : ""}`],
      ["Reduced to", scaleFactorText(r.scaleFactor)],
      ["Files", r.tileCount > 1 ? `${r.tileCount} tiles` : "1 image"],
      ["Resolution", `${fmt(S.raster.dpi * r.scaleFactor)} dpi`],
    ]));
  }

  function blockers() {
    const list = [];
    if (!S.analysis?.T) list.push("There is no fit yet.");
    if (!validateDetails(S.details, { nameMax: PLANS.NAME_MAX, notesMax: PLANS.NOTES_MAX, types: PLANS.TYPES }).ok) list.push("Add a plan name or fix the details in step 4.");
    const pol = policyNow();
    if (pol.needsConfirm && !pol.canSave) list.push("Tick the box above to save a plan of this class.");
    if (comp.status === "running") list.push("The image is still being prepared.");
    else if (comp.status !== "done") list.push("The image isn't ready.");
    return list;
  }
  const saveBlockers = () => {
    const list = blockers();
    if (ctx.plans.state.status !== "ready") list.push("The Plans layer isn't available.");
    else if (!ctx.plans.state.canAdd) list.push(ctx.plans.state.whyNot || "You can't add plans to the Plans layer.");
    if (saving) list.push("Saving…");
    if (S.saved) list.push("This plan is saved.");
    return list;
  };

  function render() {
    renderSummary();
    renderCoverage();
    renderWarnings();
    renderImage();
    drawPreview();
    const why = blockers();
    dryButton.disabled = why.length > 0 || saving;
    const sWhy = saveBlockers();
    saveButton.disabled = sWhy.length > 0;
    dryWhy.textContent = [...new Set([...sWhy.filter((t) => t !== "Saving…" && t !== "This plan is saved.")])].join(" ");
    ctx.refreshNav();
  }

  // ---- the record to write (shared by the preview and the save)
  async function build() {
    const rec = buildPlanRecord({
      details: S.details,
      source: { pdfName: S.pdf.name, pageNumber: S.pageNum, pageWidthPt: S.page.pageWidthPt, pageHeightPt: S.page.pageHeightPt, pdfBytes: S.pdf.size },
      fit: { type: S.fitType, wkid: ctx.placement.workingWkid, analysis: S.analysis, points: S.points },
      raster: { W: S.raster.W, H: S.raster.H, dpi: S.raster.dpi, crop: S.raster.crop },
      scale: S.scale, image: comp.result,
    }, F, { pdfMaxBytes: PLANS.COMPRESSION.TARGET_BYTES, transformJsonMax: PLANS.TRANSFORM_JSON_MAX_CHARS });
    const layerSR = ctx.plans.state.layer?.spatialReference;
    const wkid = layerSR?.wkid ?? rec.wkid;
    const ring = layerSR ? await projectPoints(rec.ring, layerSR, rec.wkid) : rec.ring;
    const geometry = { rings: [ring], wkid };
    // the files in the order they are attached, with their bytes
    const data = { image: comp.result.files, pdf: S.pdf.bytes, georef: new TextEncoder().encode(rec.transformJsonText) };
    const files = rec.attachments.map((a) => ({ ...a, data: a.role === "image" ? comp.result.files.find((f) => f.name === a.name).data : data[a.role] }));
    return { rec, geometry, files };
  }

  async function save() {
    if (saveBlockers().length) return;
    saving = true;
    saveOut.replaceChildren(h("div", { class: "ws-busy" }, h("calcite-loader", { inline: true, label: "Saving" }), h("span", {}, "Saving…")));
    render();
    const done = ctx.busy("Saving the plan…");
    let result;
    try {
      const { rec, geometry, files } = await build();
      const store = await createLayerStore(ctx.plans.state.layer);
      result = await savePlan({
        store, record: rec, geometry, files, F, supersedes: S.edit?.objectId ?? null,
        onProgress: (text) => saveOut.querySelector("span") && (saveOut.querySelector("span").textContent = text),
      });
    } catch (err) {
      console.warn("Couldn't save the plan:", err);
      result = { ok: false, message: err.message ?? String(err), rolledBack: true };
    } finally {
      done();
      saving = false;
    }
    if (result.ok) {
      S.saved = true;
      S.dirty = false;
      ctx.plans.bump();
      saveOut.replaceChildren(
        note(`Saved as a draft plan (record ${result.objectId}).${S.edit ? " The earlier version is now marked superseded." : ""}`, "good"),
        ...result.warnings.map((w) => note(w, "warn")),
        h("calcite-button", { scale: "s", onclick: () => ctx.close() }, "Close the workspace"));
    } else {
      saveOut.replaceChildren(
        note(`Not saved. ${result.message}`, "bad"),
        note(result.rolledBack ? "Nothing was left on the layer, and your work here is intact. You can try again." : "Your work here is intact."));
    }
    render();
  }

  // ---- the preview: the exact record and attachments, nothing written
  async function dryRun() {
    const why = blockers();
    if (why.length) return;
    dryOut.replaceChildren(h("div", { class: "ws-busy" }, h("calcite-loader", { inline: true, label: "Working" }), h("span", {}, "Building the record…")));
    try {
      const { rec, geometry } = await build();
      const layerSR = ctx.plans.state.layer?.spatialReference;
      const sr = layerSR ? { wkid: layerSR.wkid, latestWkid: layerSR.latestWkid } : { wkid: rec.wkid };
      const out = { attributes: rec.attributes, geometry: { type: "polygon", spatialReference: sr, rings: geometry.rings }, attachments: rec.attachments };
      const attachmentRows = rec.attachments.map((a) => h("tr", {}, h("td", {}, a.name), h("td", {}, a.type), h("td", {}, bytesText(a.bytes))));
      dryOut.replaceChildren(
        note(`Preview only; nothing was written. Saving adds a new "draft" record with ${rec.attachments.length} attachment${rec.attachments.length === 1 ? "" : "s"}${rec.pdfAttached ? "" : "; the PDF is over the size cap and would be left out (pdf_attached = No)"}.`, "good"),
        h("table", { class: "ws-points" }, h("thead", {}, h("tr", {}, h("th", {}, "Attachment"), h("th", {}, "Type"), h("th", {}, "Size"))), h("tbody", {}, ...attachmentRows)),
        h("div", { class: "ws-label" }, "Record"),
        h("pre", { class: "ws-pre" }, JSON.stringify(out, null, 2)),
        h("div", { class: "ws-label" }, "transform_json, formatted"),
        h("pre", { class: "ws-pre" }, JSON.stringify(rec.transformJson, null, 2)),
      );
      S.lastDryRun = out;
    } catch (err) {
      console.warn("Couldn't build the record:", err);
      dryOut.replaceChildren(note(err.message ?? String(err), "bad"));
    }
  }

  ["details", "points", "raster"].forEach((what) => ctx.on(what, () => { if (!el.hidden) render(); }));

  return {
    el,
    onShow() {
      editNote.hidden = !S.edit;
      saveButton.textContent = S.edit ? "Save as a new version" : "Save plan";
      dryOut.replaceChildren();
      if (!S.saved) saveOut.replaceChildren();
      render();
      ensureCoverage();
      ensureImage();
    },
    onHide() {
      abortCoverage?.abort();
      abortCompress?.abort();
      if (comp.status === "running") comp = { key: null, status: "idle", result: null, progress: "", error: null };
      if (cov.status === "running") cov = { key: null, status: "idle", data: null, error: null };
    },
  };
}
