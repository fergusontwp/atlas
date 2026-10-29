import { h } from "./dom.js";
import { GEOREF, PLANS } from "./config.js";
import { accuracyClass, expectedPerPt } from "./georefAnalysis.js";
import { errorText, verdictText } from "./georefMessages.js";
import { applyT } from "./georefTransform.js";
import { compressPlan } from "./compressClient.js";
import { footprintCoverage, projectPoints } from "./planCoverage.js";
import { summarizeCoverage, coverageSentence, classifyCoverage } from "./plansLogic.js";
import {
  ATTACHMENT, POLICY_TEXT, accuracyNotes, orientClockwise, buildPlanRecord, budgetText, bytesText, cleanServerPath, footprintSize, keepLayerFields,
  ceilingText, lowDpiText, optionalFields, resolutionText, savePolicy, tierText, validateDetails,
} from "./planRecord.js";
import { chainBlock, newGroupId, pieceCrops } from "./planGroup.js";
import { pieceDpi, renderDpi } from "./pageRaster.js";
import { haloFor, ptToPx } from "./thicken.js";
import { renderCrop } from "./pdfRaster.js";
import { createLayerStore } from "./plansStore.js";
import { saveGroup } from "./saveGroup.js";
import { field, fmt, kv, note } from "./wsUi.js";

const VERDICT_TONE = { good: "good", ok: "warn", review: "bad" };

// Step 5: the last look before anything is written. Shows the footprint and what it covers, the error and its class,
// prepares the image (the compression planner runs on the final render, made from the PDF at the saved resolution:
// the most that fits, or a lower one chosen here), and previews the save: the exact records and
// attachments, with nothing written. Then saves (saveGroup.js).
//
// A plan placed in one piece is one record. A plan placed in pieces (the chain solver) is a group: one record per piece,
// each rendered from the PDF for its own columns at its own resolution (so a long sheet isn't held back by the browser's
// canvas limits), with its own byte budget (piece 1 carries the PDF when it is attached, and its budget is reduced by
// it), its own image, footprint and world file, and the whole chain in its transform_json. Editing saves in place.
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
  // the saved resolution: the most that fits (null), or a lower one. Only the saved image depends on it; the sheet is
  // placed on the working render, so it can be changed here without placing again.
  const dpiSelect = h("calcite-select", { scale: "s", label: "Saved resolution", oncalciteSelectChange: (e) => setChoice(Number(e.target.value) || null) });
  const ceilingNote = h("div", { class: "plan-note" });
  const cancelCompress = h("calcite-button", { scale: "s", appearance: "outline", hidden: true, onclick: () => abortCompress?.abort() }, "Cancel");
  const saveButton = h("calcite-button", { iconStart: "save", onclick: () => save() }, "Save plan");
  const dryButton = h("calcite-button", { appearance: "outline", iconStart: "file-text", onclick: () => dryRun() }, "Preview the save");
  const dryWhy = h("div", { class: "plan-note" });
  const dryOut = h("div", {});
  const saveOut = h("div", { ariaLive: "polite" });
  let saving = false;

  const editNote = note("");
  editNote.hidden = true;
  const el = h("div", {},
    editNote,
    summaryHost,
    h("div", { class: "ws-step-title" }, "Footprint"),
    canvas, canvasNote, coverageHost,
    warnHost, confirmRow,
    h("div", { class: "ws-step-title" }, "Image"),
    field("Saved resolution", dpiSelect, "The most that fits the size limit, never more than the PDF holds. Choose a lower one only to save a smaller file."),
    ceilingNote,
    imageHost, h("div", { class: "ws-row" }, cancelCompress),
    h("div", { class: "ws-step-title" }, "Save"),
    h("div", { class: "ws-row" }, saveButton, dryButton), dryWhy, saveOut, dryOut,
  );

  // ---- what is saved: one sheet for a whole-sheet fit, one per piece for a chain
  const chained = () => S.fitType === "chain";
  // [{ crop (page points), Tp (page transform), piece? }]
  function jobsNow() {
    const r = S.raster;
    if (!r) return [];
    if (!chained()) return S.analysis?.T ? [{ crop: r.crop, Tp: S.analysis.T }] : [];
    const pieces = S.solve?.chain?.ok ? S.solve.chain.pieces : [];
    const crops = pieceCrops(r.crop, pieces, r.dpi / 72, PLANS.CHAIN.PIECE_OVERLAP_PX);
    return pieces.map((piece, i) => ({ crop: crops[i], Tp: piece.Tp, piece }));
  }
  // The footprint ring of each sheet in the working CRS (closed, clockwise), before the image is made.
  const ringOf = (job) => {
    const c = job.crop;
    const pts = [[c.x0, c.y0], [c.x1, c.y0], [c.x1, c.y1], [c.x0, c.y1]].map(([x, y]) => applyT(job.Tp, x, y));
    return orientClockwise([...pts, pts[0]]);
  };
  const ringsNow = () => {
    if (!chained()) { const c = ctx.placement?.footprint(); return c ? [orientClockwise([...c, c[0]])] : []; }
    return jobsNow().map(ringOf);
  };

  // ---- derived values
  const classNow = () => accuracyClass(S.analysis?.quality);
  const policyNow = () => savePolicy({ accuracyClass: classNow(), confirmed: S.confirmClass !== null && S.confirmClass === classNow() });
  // The layer's field names, or null before it is loaded. An optional field it doesn't have yet isn't written.
  const layerFieldNames = () => ctx.plans.state.layer?.fields?.map((f) => f.name) ?? null;
  const layerHas = (name) => { const n = layerFieldNames(); return !n || n.some((x) => x.toLowerCase() === String(name).toLowerCase()); };
  // A group id: the plan's own when it has one, a new one for a new plan in pieces (kept for the preview and the save).
  const groupIdNow = () => (S.edit?.groupId ?? (chained() ? (S.newGroupId ??= newGroupId()) : null));
  // The PDF stays on piece 1 as it is (not sent again) when the plan had it there and the same file is still open.
  const keepPdfNow = () => !!(S.attachPdf && S.edit?.pdf?.pieceNo === 1 && S.pdf && S.pdf.size === S.edit.pdf.size && S.pdf.name === S.edit.pdf.name);

  // ---- coverage of parcels (async, cached by footprint)
  let cov = { key: null, status: "idle", data: null, error: null };
  let abortCoverage = null;
  async function ensureCoverage() {
    const rings = ringsNow();
    if (!rings.length) return;
    const key = JSON.stringify(rings);
    if (cov.key === key && cov.status !== "error") return;
    abortCoverage?.abort();
    const controller = (abortCoverage = new AbortController());
    cov = { key, status: "running", data: null, error: null };
    render();
    try {
      const data = await footprintCoverage({ parcel: ctx.parcel, rings, signal: controller.signal });
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

  // ---- the images (compression planner on each final render, cached by render, cuts and budget)
  // comp.results: [{ raster: { W, H, dpi, crop, kind }, result }], one per sheet
  let comp = { key: null, status: "idle", results: null, progress: "", error: null };
  let abortCompress = null;
  const budgetFor = (i) => (i === 0 ? ctx.imageBudget().budget : PLANS.COMPRESSION.TARGET_BYTES);
  const compKey = () => (S.rasterKey ? `${S.rasterKey}|${ctx.imageBudget().budget}|${S.dpiChoice}|${JSON.stringify(jobsNow().map((j) => j.crop))}|${JSON.stringify(S.thicken)}` : null);
  async function ensureImage() {
    const key = compKey();
    if (key && comp.key === key && (comp.status === "running" || comp.status === "done")) return;
    abortCompress?.abort();
    const controller = (abortCompress = new AbortController());
    const signal = controller.signal;
    comp = { key: null, status: "running", results: null, progress: "Preparing the image…", error: null };
    render();
    try {
      const whole = await ctx.ensureRaster();
      if (signal.aborted) return;
      ctx.sheet?.trimMemory?.(); // the sheet pane's cached tiles go back while the images are made
      comp.key = compKey();
      const jobs = jobsNow();
      const results = [];
      for (const [i, job] of jobs.entries()) {
        const head = jobs.length > 1 ? `Piece ${i + 1} of ${jobs.length}: ` : "";
        let raster = whole, kind = ctx.resolution()?.kind, trim = null;
        if (!chained()) {
          // one piece: the crop at the saved resolution (the working render when it is the same)
          const res = ctx.resolution();
          if (Math.abs(res.dpi - whole.dpi) > 0.01) {
            comp.progress = `Rendering at ${fmt(res.dpi)} dpi…`;
            renderImage();
            await new Promise((r) => requestAnimationFrame(r));
            raster = await renderCrop(S.page, whole.crop, res.dpi, { signal });
          }
        } else {
          // each piece from the PDF, for its own columns, at its own resolution; with a line weight, rendered a few
          // pixels past its cuts (as far as the sheet goes) so lines beside a cut thicken into it as on the whole sheet,
          // and trimmed after
          const res = renderDpi({ content: S.page.content, crop: job.crop, choice: S.dpiChoice }, ctx.DPI_LIMITS);
          kind = res.kind;
          comp.progress = `${head}rendering at ${fmt(res.dpi)} dpi…`;
          renderImage();
          await new Promise((r) => requestAnimationFrame(r));
          const s = res.dpi / 72, sheet = whole.crop;
          const m = S.thicken ? haloFor(ptToPx(S.thicken.pt, res.dpi), S.thicken.sharpen) + 4 : 0;
          const left = Math.min(m, Math.floor((job.crop.x0 - sheet.x0) * s + 1e-9)), right = Math.min(m, Math.floor((sheet.x1 - job.crop.x1) * s + 1e-9));
          raster = await renderCrop(S.page, { ...job.crop, x0: job.crop.x0 - left / s, x1: job.crop.x1 + right / s }, res.dpi, { signal });
          if (left || right) { trim = { left, right }; raster.W -= left + right; raster.crop = { ...job.crop }; }
        }
        const result = await compressPlan(raster.canvas, PLANS.COMPRESSION, {
          budget: budgetFor(i),
          thicken: S.thicken ? { P: S.thicken, dpi: raster.dpi, trim } : null,
          release: raster !== whole, // a piece's render isn't needed once the worker has its copy
          signal,
          onProgress: (m) => {
            comp.progress = `${head}trying ${tierText(m.tier).toLowerCase()}${m.scale && m.scale < 1 ? ` at ${fmt(raster.dpi * m.scale)} dpi` : ""}${m.quality ? `, quality ${Math.round(m.quality * 100)}` : ""}…`;
            renderImage();
          },
        });
        if (signal.aborted) return;
        if (!result.ok) throw new Error(`The image${jobs.length > 1 ? ` of piece ${i + 1}` : ""} is too large to save, even in tiles. Choose a smaller crop or a lower resolution.`);
        results.push({ raster: { W: raster.W, H: raster.H, dpi: raster.dpi, crop: raster.crop, kind }, result });
        if (raster !== whole) { raster.canvas.width = 0; raster.canvas.height = 0; } // let the piece's render go
      }
      comp = { key: comp.key, status: "done", results, progress: "", error: null };
    } catch (err) {
      if (err?.name === "AbortError") { comp = { key: null, status: "cancelled", results: null, progress: "", error: null }; }
      else { console.warn("Couldn't prepare the image:", err); comp = { key: null, status: "error", results: null, progress: "", error: err }; }
    }
    render();
  }

  // ---- the saved resolution
  // The ceiling a choice is below: the whole crop's (one piece), or the page's native detail (pieces are each rendered
  // on their own, so the browser's limits on the whole crop rarely reach them).
  const ceilingNow = () => { const r = ctx.resolution(); return r ? (chained() ? pieceDpi(r, GEOREF.MAX_DPI) : r.ceilingDpi) : null; };
  function syncChoices() {
    const r = ctx.resolution(), top = ceilingNow();
    if (!r) { dpiSelect.replaceChildren(); ceilingNote.textContent = ""; return; }
    if (S.dpiChoice && S.dpiChoice >= top - 0.5) S.dpiChoice = null; // a new crop or fit can lower the ceiling
    const options = [h("calcite-option", { value: "", label: `The most that fits (up to ${fmt(top)} dpi)`, selected: !S.dpiChoice })];
    for (const d of GEOREF.DPI_CHOICES.filter((v) => v < top - 0.5)) options.push(h("calcite-option", { value: String(d), label: `${d} dpi`, selected: S.dpiChoice === d }));
    dpiSelect.replaceChildren(...options);
    ceilingNote.textContent = chained() ? ceilingText({ ...r, capped: null, ceilingDpi: top }, ctx.DPI_LIMITS) : ceilingText(r, ctx.DPI_LIMITS);
  }
  function setChoice(dpi) {
    if (dpi === S.dpiChoice) return;
    S.dpiChoice = dpi;
    ctx.changed("dpi");
    ctx.markDirty();
    syncChoices();
    ensureImage();
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
    const fps = data.footprints ?? [data.footprint];
    const all = fps.flat();
    const xs = all.map((p) => p[0]), ys = all.map((p) => p[1]);
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
    for (const fp of fps) { path(fp); g.stroke(); }
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
    const jobs = jobsNow();
    if (!jobs.length) { summaryHost.replaceChildren(note(chained() ? "The chain isn't complete. Go back to Place and add pins." : "There is no fit yet. Go back to Place and add points.", "bad")); return; }
    const used = S.points.filter((p) => p.use !== false);
    const cls = classNow();
    const rings = ringsNow();
    const size = !chained() && rings[0] ? footprintSize(rings[0]) : null;
    const lengthFt = chained() ? S.solve.chain.pieces.reduce((s, p) => s + (p.c1 - p.c0) * p.T.fpp, 0) : null;
    const quality = A.type === "chain" && A.quality === "unchecked" ? "Exact at every pin (nothing checks it)" : verdictText(A.quality, Math.max(A.rms || 0, Number.isFinite(A.looRms) ? A.looRms : 0));
    const verdict = h("span", { class: VERDICT_TONE[A.quality] ? `ws-note-${VERDICT_TONE[A.quality]}` : "" }, `Class ${cls} · ${quality}`);
    summaryHost.replaceChildren(kv([
      ["Plan", S.details.name.trim() || "(no name yet)"],
      ["Accuracy", verdict],
      ["Error", `RMS ${errorText(A.rms)}${Number.isFinite(A.looRms) ? `, check ${errorText(A.looRms)}` : ""}`],
      ["Points", `${used.length} in the fit, ${used.filter((p) => p.snapped).length} snapped to ${ctx.subject?.isParcel === false ? "corners or vertices" : "parcel corners"}`],
      ["Fit", chained() ? `Chain: ${jobs.length} piece${jobs.length === 1 ? "" : "s"}, ${jobs.length} record${jobs.length === 1 ? "" : "s"}` : ({ similarity: "Similarity", locked: "Locked scale", affine: "Affine" }[S.fitType] ?? S.fitType)],
      ["On the ground", size ? `${fmt(size.width)} × ${fmt(size.height)} ft` : lengthFt ? `${fmt(lengthFt)} ft along the plan` : ""],
    ]));
  }

  function renderCoverage() {
    if (cov.status === "running") { coverageHost.textContent = "Checking which parcels the footprint covers…"; canvasNote.textContent = ""; }
    else if (cov.status === "error") { coverageHost.textContent = "Couldn't check which parcels the footprint covers. You can still save."; coverageHost.className = "plan-note ws-note-warn"; return; }
    else if (cov.status === "done") {
      const sum = summarizeCoverage(cov.data.shares.map((s) => s.share), PLANS.COVER_MIN);
      coverageHost.textContent = `${coverageSentence(sum, PLANS.COVER_MIN)}${cov.data.overflow ? ` (Only the first ${PLANS.REVIEW_MAX_PARCELS} parcels were counted.)` : ""}`;
      canvasNote.textContent = `Dashed: the footprint${chained() ? " of each piece" : ""}. Shaded: parcels it covers 80% or more of. Dots: your points (open dots were placed freely).`;
    }
    coverageHost.className = "plan-note";
  }

  function renderWarnings() {
    const pol = policyNow();
    warnHost.replaceChildren();
    // an exact chain is class U by construction (Jackson: kept, saved with the confirmation); another pin only adds a piece
    const chainU = chained() && pol.reason === "unchecked";
    if (pol.reason) warnHost.append(note(chainU ? "Every piece meets its two pins exactly, so nothing checks the placement (class U). Look over the pieces on the map, then confirm that you want to save it." : POLICY_TEXT[pol.reason], "warn"));
    for (const text of accuracyNotes(S.points)) warnHost.append(note(text));
    const lost = keepLayerFields({ [F.SERVER_LOCATION]: cleanServerPath(S.details.serverLocation) }, layerFieldNames(), optionalFields(F)).dropped;
    if (lost.length) warnHost.append(note(`The Plans layer has no ${F.SERVER_LOCATION} field yet, so the server location won't be saved.`, "warn"));
    confirmRow.hidden = !pol.needsConfirm;
    confirmBox.checked = pol.needsConfirm && pol.canSave;
  }

  function renderImage() {
    cancelCompress.hidden = comp.status !== "running";
    if (comp.status === "running") { imageHost.replaceChildren(h("div", { class: "ws-busy" }, h("calcite-loader", { inline: true, label: "Preparing" }), h("span", {}, comp.progress))); return; }
    if (comp.status === "error") { imageHost.replaceChildren(note(comp.error?.message ?? "The image couldn't be prepared.", "bad"), h("calcite-button", { scale: "s", appearance: "outline", onclick: () => ensureImage() }, "Try again")); return; }
    if (comp.status === "cancelled") { imageHost.replaceChildren(note("Preparing the image was cancelled."), h("calcite-button", { scale: "s", appearance: "outline", onclick: () => ensureImage() }, "Prepare again")); return; }
    const list = comp.results;
    if (!list?.length) { imageHost.replaceChildren(); return; }
    const P = S.thicken, sharp = P?.sharpen > 0 ? `sharpened (${fmt(P.sharpen, 1)})` : "";
    const weight = !P ? null : P.name === "off"
      ? note(`No line weight; ${sharp || "levels only"}${P.bin ? ", binarized" : ""}. The PDF isn't changed.`)
      : note(`Line weight: ${P.name === "custom" ? "custom" : P.name}, ${fmt(P.pt, 2)} pt (${fmt(ptToPx(P.pt, list[0].raster.dpi * list[0].result.scaleFactor), 1)} px at the saved ${fmt(list[0].raster.dpi * list[0].result.scaleFactor)} dpi${list.length > 1 ? " of piece 1" : ""})${sharp ? `, ${sharp}` : ""}${P.bin ? ", binarized" : ""}. The PDF isn't changed.`);
    const budget = note(budgetText(ctx.imageBudget(), PLANS.COMPRESSION.TARGET_BYTES, { attach: S.attachPdf, pdfBytes: S.pdf?.size }) + (list.length > 1 ? " That is for piece 1; every other piece has the whole budget." : ""));
    if (list.length === 1) {
      const { raster, result: r } = list[0];
      const dpi = raster.dpi * r.scaleFactor;
      const low = lowDpiText(dpi, GEOREF.MIN_DPI);
      imageHost.replaceChildren(...[kv([
        ["Format", tierText(r.tier) + (r.quality ? ` (quality ${Math.round(r.quality * 100)})` : "")],
        ["Resolution", resolutionText({ dpi, renderDpi: raster.dpi, kind: raster.kind, chosen: !!S.dpiChoice, bytes: r.finalBytes, budget: r.budget, estimate: false })],
        ["Size", `${fmt(r.width)} × ${fmt(r.height)} px`],
        ["File size", `${bytesText(r.finalBytes)}${r.origBytes > r.finalBytes ? ` (${bytesText(r.origBytes)} as first rendered)` : ""}`],
        ["Files", r.tileCount > 1 ? `${r.tileCount} tiles` : "1 image"],
      ]),
      budget, weight,
      low ? note(low, "warn") : null,
      (r.scaleFactor < 0.95 || ctx.resolution()?.capped) && !S.dpiChoice
        ? note(`That is the plan as one image. Placed in pieces (Chain, in Place), each piece is rendered on its own at up to ${fmt(pieceDpi(ctx.resolution(), GEOREF.MAX_DPI))} dpi and has its own ${bytesText(PLANS.COMPRESSION.TARGET_BYTES)}, so a long plan keeps more of its detail.`)
        : null,
      r.tier === "tiled" ? note(`No single image fit, so the plan is saved as ${r.tileCount} full-resolution tiles of at most ${bytesText(PLANS.COMPRESSION.TILE_MAX_BYTES)} each; together they are over the limit above.`, "warn") : null].filter(Boolean));
      return;
    }
    const low = list.some(({ raster, result }) => lowDpiText(raster.dpi * result.scaleFactor, GEOREF.MIN_DPI));
    imageHost.replaceChildren(...[
      h("table", { class: "ws-points" },
        h("thead", {}, h("tr", {}, h("th", {}, "Piece"), h("th", {}, "Resolution"), h("th", {}, "Size"), h("th", {}, "File"), h("th", {}, "Format"))),
        h("tbody", {}, ...list.map(({ raster, result: r }, i) => h("tr", {},
          h("td", {}, String(i + 1)),
          h("td", { title: r.scaleFactor < 0.9995 ? `Reduced from ${fmt(raster.dpi)} dpi to fit` : "" }, `${fmt(raster.dpi * r.scaleFactor)} dpi`),
          h("td", {}, `${fmt(r.width)} × ${fmt(r.height)}`),
          h("td", {}, `${bytesText(r.finalBytes)}${r.tileCount > 1 ? `, ${r.tileCount} tiles` : ""}`),
          h("td", {}, tierText(r.tier).replace(/ \(.*\)$/, "")))))),
      budget, weight,
      low ? note(`A piece is under ${GEOREF.MIN_DPI} dpi: small text may be hard to read.`, "warn") : null,
    ].filter(Boolean));
  }

  function blockers() {
    const list = [];
    if (!jobsNow().length) list.push(chained() ? "The chain isn't complete." : "There is no fit yet.");
    if (chained() && !(layerHas(F.GROUP_ID) && layerHas(F.PIECE_NO))) list.push(`The Plans layer needs the ${F.GROUP_ID} and ${F.PIECE_NO} fields to save a plan in pieces.`);
    if (!validateDetails(S.details, { nameMax: PLANS.NAME_MAX, notesMax: PLANS.NOTES_MAX, types: PLANS.TYPES, serverLocationMax: PLANS.SERVER_LOCATION_MAX }).ok) list.push("Add a plan name or fix the details in step 4.");
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

  // ---- the records to write (shared by the preview and the save): one per sheet, in piece order
  async function build() {
    const jobs = jobsNow(), results = comp.results;
    const groupId = groupIdNow();
    const keepPdf = keepPdfNow();
    const layerSR = ctx.plans.state.layer?.spatialReference;
    const perPt = expectedPerPt(S.scale);
    const pins = S.points.filter((p) => p.use !== false).sort((a, b) => a.x - b.x);
    const seed = { source: S.seedInfo?.source ?? null, flipped: !!S.seedFlip, start_xy: S.seedInfo?.start_xy ?? null, transform: S.model.seed };
    const out = [];
    for (const [i, job] of jobs.entries()) {
      const { raster, result } = results[i];
      const rec = buildPlanRecord({
        details: S.details,
        source: { pdfName: S.pdf.name, pageNumber: S.pageNum, pageWidthPt: S.page.pageWidthPt, pageHeightPt: S.page.pageHeightPt, pdfBytes: S.pdf.size, attachPdf: S.attachPdf && i === 0 },
        fit: { type: S.fitType, wkid: ctx.placement.workingWkid, analysis: chained() ? { ...S.analysis, T: job.Tp } : S.analysis, points: S.points },
        raster: { W: raster.W, H: raster.H, dpi: raster.dpi, crop: raster.crop },
        scale: S.scale, image: result,
        group: groupId ? { groupId, pieceNo: i + 1 } : null,
        chain: chained() ? chainBlock({ crop: S.raster.crop, perPt, exact: S.chainExact, baselineRow: S.baselineRow, seed, pins, index: i, col: [job.piece.c0, job.piece.c1], pieceCrop: job.crop }) : null,
        sheetCrop: chained() ? S.raster.crop : null,
        thicken: S.thicken,
        mosaic: S.mosaic, // a mosaic sheet: its definition on every piece (Jackson, 2026-10-26)
      }, F, { pdfMaxBytes: PLANS.COMPRESSION.TARGET_BYTES, transformJsonMax: PLANS.TRANSFORM_JSON_MAX_CHARS });
      rec.attributes = keepLayerFields(rec.attributes, layerFieldNames(), optionalFields(F)).attributes;
      const wkid = layerSR?.wkid ?? rec.wkid;
      const ring = layerSR ? await projectPoints(rec.ring, layerSR, rec.wkid) : rec.ring;
      // the files in the order they are attached, with their bytes (a PDF kept on piece 1 isn't sent again)
      const data = { pdf: S.pdf.bytes, georef: new TextEncoder().encode(rec.transformJsonText) };
      const files = rec.attachments.filter((a) => !(keepPdf && a.role === "pdf"))
        .map((a) => ({ ...a, data: a.role === "image" ? result.files.find((f) => f.name === a.name).data : data[a.role] }));
      out.push({ rec, geometry: { rings: [ring], wkid }, files });
    }
    return out;
  }

  async function save() {
    if (saveBlockers().length) return;
    saving = true;
    saveOut.replaceChildren(h("div", { class: "ws-busy" }, h("calcite-loader", { inline: true, label: "Saving" }), h("span", {}, "Saving…")));
    render();
    const done = ctx.busy("Saving the plan…");
    let result, n = 0;
    try {
      const built = await build();
      n = built.length;
      const store = await createLayerStore(ctx.plans.state.layer);
      const keepPdf = keepPdfNow();
      result = await saveGroup({
        store, F,
        pieces: built.map((b, i) => ({ pieceNo: i + 1, attributes: b.rec.attributes, geometry: b.geometry, files: b.files })),
        existing: S.edit?.existing ?? [],
        keepOld: (pieceNo, f) => keepPdf && pieceNo === 1 && f.name === ATTACHMENT.PDF,
        onProgress: (text) => saveOut.querySelector("span") && (saveOut.querySelector("span").textContent = text),
      });
    } catch (err) {
      console.warn("Couldn't save the plan:", err);
      result = { ok: false, message: err.message ?? String(err), reverted: true };
    } finally {
      done();
      saving = false;
    }
    if (result.ok) {
      S.saved = true;
      S.dirty = false;
      ctx.plans.bump();
      const what = n > 1 ? `${n} records, one per piece (${result.objectIds.join(", ")})` : `record ${result.objectIds[0]}`;
      const edited = S.edit ? ` Updated in place${result.added.length ? `, ${result.added.length} piece${result.added.length === 1 ? "" : "s"} added` : ""}${result.deleted.length ? `, ${result.deleted.length} removed` : ""}.` : "";
      saveOut.replaceChildren(
        note(`Saved as ${S.edit ? "" : "a draft plan, "}${what}.${edited}`, "good"),
        ...result.warnings.map((w) => note(w, "warn")),
        h("calcite-button", { scale: "s", onclick: () => ctx.close() }, "Close the workspace"));
    } else {
      saveOut.replaceChildren(
        note(`Not saved. ${result.message}`, "bad"),
        note(result.reverted ? "Your work here is intact. You can try again." : "Your work here is intact."));
    }
    render();
  }

  // ---- the preview: the exact records and attachments, nothing written
  async function dryRun() {
    const why = blockers();
    if (why.length) return;
    dryOut.replaceChildren(h("div", { class: "ws-busy" }, h("calcite-loader", { inline: true, label: "Working" }), h("span", {}, "Building the record…")));
    try {
      const built = await build();
      const layerSR = ctx.plans.state.layer?.spatialReference;
      const out = built.map(({ rec, geometry, files }) => ({
        attributes: rec.attributes,
        geometry: { type: "polygon", spatialReference: layerSR ? { wkid: layerSR.wkid, latestWkid: layerSR.latestWkid } : { wkid: rec.wkid }, rings: geometry.rings },
        attachments: files.map(({ role, name, type, bytes }) => ({ role, name, type, bytes })),
      }));
      const rows = out.flatMap((r, i) => r.attachments.map((a) => h("tr", {}, h("td", {}, built.length > 1 ? `${i + 1}: ${a.name}` : a.name), h("td", {}, a.type), h("td", {}, bytesText(a.bytes)))));
      const ex = S.edit?.existing?.length ?? 0;
      const head = S.edit
        ? `Preview only; nothing was written. Saving updates the plan in place: ${built.length} record${built.length === 1 ? "" : "s"}${built.length > ex ? ` (${built.length - ex} added)` : ""}${ex > built.length ? `, ${ex - built.length} removed` : ""}.`
        : `Preview only; nothing was written. Saving adds ${built.length > 1 ? `${built.length} "draft" records, one per piece` : 'a new "draft" record'}.`;
      const pdfNote = built[0].rec.pdfAttached ? (keepPdfNow() ? " The PDF already on the plan stays as it is." : "") : S.attachPdf ? " The PDF is over the size cap and would be left out (pdf_attached = No)." : " The source PDF isn't attached (pdf_attached = No).";
      dryOut.replaceChildren(
        note(head + pdfNote, "good"),
        h("table", { class: "ws-points" }, h("thead", {}, h("tr", {}, h("th", {}, "Attachment"), h("th", {}, "Type"), h("th", {}, "Size"))), h("tbody", {}, ...rows)),
        h("div", { class: "ws-label" }, built.length > 1 ? "Records" : "Record"),
        h("pre", { class: "ws-pre" }, JSON.stringify(built.length > 1 ? out : out[0], null, 2)),
        h("div", { class: "ws-label" }, `transform_json${built.length > 1 ? " of piece 1" : ""}, formatted`),
        h("pre", { class: "ws-pre" }, JSON.stringify(built[0].rec.transformJson, null, 2)),
      );
      S.lastDryRun = built.length > 1 ? out : out[0];
    } catch (err) {
      console.warn("Couldn't build the record:", err);
      dryOut.replaceChildren(note(err.message ?? String(err), "bad"));
    }
  }

  ["details", "points", "raster", "attach"].forEach((what) => ctx.on(what, () => { if (!el.hidden) render(); }));

  return {
    el,
    onShow() {
      editNote.hidden = !S.edit;
      const n = S.edit?.existing?.length ?? 0;
      editNote.textContent = n > 1 ? `You are editing a saved plan in ${n} pieces. Saving updates its records in place.` : "You are editing a saved plan. Saving updates it in place.";
      saveButton.textContent = S.edit ? "Save changes" : "Save plan";
      dryOut.replaceChildren();
      if (!S.saved) saveOut.replaceChildren();
      syncChoices();
      render();
      ensureCoverage();
      ensureImage();
    },
    onHide() {
      abortCoverage?.abort();
      abortCompress?.abort();
      if (comp.status === "running") comp = { key: null, status: "idle", results: null, progress: "", error: null };
      if (cov.status === "running") cov = { key: null, status: "idle", data: null, error: null };
    },
  };
}
