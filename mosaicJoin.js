import { h } from "./dom.js";
import { MOSAIC } from "./config.js";
import { SheetView } from "./sheetView.js";
import { T, Tdir, compose, invert, fromRGBA, guessScale, nudge as nudgeRel, pxPerFt as pxPerFtOf, roadDirection, roadEnd, seamReport, snapLine, snapPoint, snapTick, solveSeam, tickLattice } from "./joinSeam.js";
import { autoSeamAsync, slideMatchAsync } from "./seamClient.js";
import { fmtSta, parseStation } from "./mosaicModel.js";
import { zip } from "./zipWriter.js";
import { saveFile } from "./download.js";

// Step 2 of the mosaic workspace: join the views, one seam at a time. Ported from the prototype (plan-mosaic.html,
// update 3: the seam join with joinSeam.js) with the same behaviour and wording; the panes are SheetViews (pan, zoom,
// the loupe), the left one drawing only the visible part of the mosaic so far (no big canvas, no size limit).
//
// Units: every view is its clip rendered at one scale s (pixels per PDF point), so the join is in pixels and the scale
// between views is 1. A placed view's { a, b, tx, ty } maps its pixels to mosaic pixels (the first view: identity). The
// seam's rel maps next-view pixels to last-view pixels (joinSeam.js). The left pane's coordinates are mosaic pixels, the
// right pane's the next view's pixels.
//
// Kept exactly (prototype bug fixes): a line pair alone doesn't place the view (only once the along-road position is set:
// ticks + stations, a point pair, Auto join or Match overlap); Clear seam also clears point pairs and turns the overlay
// off; Undo removes a whole Auto join or Match overlap; Point clicks work with the overlay on.
//
// opts: { setStatus(text), onChange() (something to keep in the draft), prefs: { get(k), set(k, v) } }
export function createJoin(host, { setStatus, onChange = () => {}, prefs }) {
  let views = [];   // [{ label, canvas, clip }]: the clips rendered at s, in road order
  let s = 1;        // px per point of the renders
  let placed = [];  // [{ i, a, b, tx, ty, seam, ties }]
  let k = 0;        // the next view to place
  let pairs = [];   // point pairs [{ w: { x, y } mosaic px, p: { x, y } next-view px }]
  let pendingW = null;
  let seam = newSeam(), seamBusy = false;
  let tool = "line", preview = false;
  let snapOn = prefs.get("snap") !== "off", loupeOn = prefs.get("loupe") !== "off";
  let hover = null; // { side, p (view px), kind } the snap under the pointer
  let leftM = null; // the left pane's source: { minX, minY, width, height, list, ghostLast }

  function newSeam() {
    return { lines: [], pend: null, ticks: { L: null, R: null }, anchor: null, auto: null, theta: null, u: null,
      nudge: { rot: 0, along: 0, across: 0 }, rel: null, base: null, report: null, overlapCheck: null, log: [] };
  }

  // ---- controls (the seam bar)
  const btn = (text, onclick, props = {}) => h("calcite-button", { scale: "s", appearance: "outline", onclick, ...props }, text);
  const num = (props) => h("calcite-input-number", { scale: "s", ...props });
  const autoBtn = btn("Auto join", () => runAutoJoin(), { appearance: "solid", iconStart: "magic-wand", title: "Find the road lines across the seam, join them, and set the along-road position from the ticks or the overlap" });
  const betaChip = h("calcite-chip", { scale: "s", kind: "neutral", appearance: "outline-fill", label: "Beta" }, "beta");
  const toolSeg = h("calcite-segmented-control", { scale: "s", oncalciteSegmentedControlChange: (e) => { tool = e.target.value; seam.pend = null; pendingW = null; hover = null; refresh(); } },
    h("calcite-segmented-control-item", { value: "line", checked: true }, "Line"),
    h("calcite-segmented-control-item", { value: "tick" }, "Tick"),
    h("calcite-segmented-control-item", { value: "point" }, "Point pair"));
  const stL = h("calcite-input-text", { scale: "s", placeholder: "13+50", label: "Station of the tick in the mosaic", oncalciteInputTextInput: (e) => { if (seam.ticks.L) seam.ticks.L.station = e.target.value; refresh(); } });
  const stR = h("calcite-input-text", { scale: "s", placeholder: "14+00", label: "Station of the tick in the next view", oncalciteInputTextInput: (e) => { if (seam.ticks.R) seam.ticks.R.station = e.target.value; refresh(); } });
  const clearBtn = btn("Clear seam", () => { seam = newSeam(); pairs = []; pendingW = null; preview = false; previewSw.checked = false; stL.value = ""; stR.value = ""; refresh(); });
  const snapSw = h("calcite-switch", { scale: "s", checked: snapOn, oncalciteSwitchChange: (e) => { snapOn = e.target.checked; prefs.set("snap", snapOn ? "on" : "off"); hover = null; redraw(); } });
  const loupeSw = h("calcite-switch", { scale: "s", checked: loupeOn, oncalciteSwitchChange: (e) => { loupeOn = e.target.checked; prefs.set("loupe", loupeOn ? "on" : "off"); paneL.loupe = paneR.loupe = loupeOn; redraw(); } });
  const previewSw = h("calcite-switch", { scale: "s", oncalciteSwitchChange: (e) => { preview = e.target.checked; refresh(); } });
  const sel = (options, value, label) => h("calcite-select", { scale: "s", label, width: "auto" }, ...options.map((o) => h("calcite-option", { value: String(o), label: String(o), selected: o === value })));
  const stepRot = sel([0.01, 0.05, 0.2, 1], 0.05, "Rotation step");
  const stepFt = sel([0.25, 0.5, 2, 10], 0.5, "Shift step");
  const nb = (icon, title, kind, sign) => h("calcite-action", { icon, text: title, scale: "s", onclick: () => seamNudge(kind, sign) });
  const ftin = num({ min: 1, step: "any", placeholder: "?", label: "Plan scale: feet per inch", oncalciteInputNumberChange: () => refresh() });
  const stint = num({ min: 1, step: "any", value: "50", label: "Distance between station ticks", oncalciteInputNumberChange: () => refresh() });
  const testBtn = btn("Test scale", () => testScale(), { title: "Measure the tick spacing in the last and next view and suggest the plan scale" });
  const overlapBtn = btn("Match overlap", () => checkOverlap(), { title: "Lines only: set the along-road position from the overlap. Already set: check it against the overlap" });
  const resetBtn = btn("Reset nudges", () => { seam.nudge = { rot: 0, along: 0, across: 0 }; seam.overlapCheck = null; refresh(); });
  const undoBtn = btn("Undo", () => undo(), { iconStart: "undo", title: "Undo the last point, line or tick (z)" });
  const undoViewBtn = btn("Undo last view", () => undoView());
  const addBtn = btn("Add view", () => commit(), { appearance: "solid", iconStart: "plus", title: "Add the next view to the mosaic (Enter)" });
  const readoutSw = h("calcite-switch", { scale: "s", checked: prefs.get("readout") !== "off", oncalciteSwitchChange: (e) => { prefs.set("readout", e.target.checked ? "on" : "off"); readout.hidden = !e.target.checked; } });
  const readout = h("div", { class: "mz-readout" });
  readout.hidden = prefs.get("readout") === "off";
  const lbl = (text, ...kids) => h("span", { class: "mz-grp" }, text ? h("span", { class: "mz-lbl" }, text) : null, ...kids);
  const sw = (control, text) => h("calcite-label", { layout: "inline", scale: "s", class: "mz-sw" }, control, text);
  const bar = h("div", { class: "mz-seambar" },
    h("div", { class: "mz-row" }, lbl("", autoBtn, betaChip), lbl("Click tool", toolSeg), lbl("Stations: mosaic", stL), lbl("next", stR), clearBtn,
      sw(snapSw, "Snap (Alt: off)"), sw(loupeSw, "Magnifier"), sw(previewSw, "Preview overlay")),
    h("div", { class: "mz-row" },
      lbl("Rotate", btn("⟲", () => seamNudge("rot", -1), { title: "Rotate counter-clockwise ([)" }), btn("⟳", () => seamNudge("rot", 1), { title: "Rotate clockwise (])" }), stepRot, h("span", {}, "°")),
      lbl("Along", nb("chevron-left", "Back along the road (←)", "along", -1), nb("chevron-right", "On along the road (→)", "along", 1)),
      lbl("Across", nb("chevron-up", "Across (↑)", "across", -1), nb("chevron-down", "Across (↓)", "across", 1), stepFt, h("span", {}, "ft")),
      btn("◀ 1 station", () => seamNudge("station", -1)), btn("1 station ▶", () => seamNudge("station", 1)), resetBtn, overlapBtn),
    h("div", { class: "mz-row" }, lbl('1" =', ftin, h("span", {}, "ft")), lbl("Ticks every", stint, h("span", {}, "ft")), testBtn,
      undoBtn, undoViewBtn, addBtn, sw(readoutSw, "Readout")),
    readout);

  // ---- the panes
  const pane = (title) => {
    const head = h("div", { class: "mz-pane-title" }, title);
    const canvas = h("canvas", { class: "mz-canvas" });
    const box = h("div", { class: "mz-pane-host" }, canvas);
    const el = h("div", { class: "mz-pane" }, head, box);
    return { el, head, box, canvas };
  };
  const pl = pane("Mosaic so far (click a point here first)"), pr = pane("Next view (then click the same point here)");
  host.replaceChildren(bar, h("div", { class: "mz-panes" }, pl.el, pr.el));
  const paneL = new SheetView(pl.box, pl.canvas), paneR = new SheetView(pr.box, pr.canvas);
  for (const p of [paneL, paneR]) { p.setMode("pick"); p.loupe = loupeOn; }
  paneL.onPick = (x, y, e) => click("L", { x, y }, e);
  paneR.onPick = (x, y, e) => click("R", { x, y }, e);
  paneL.onCursor = (pt, e) => hoverAt("L", pt, e);
  paneR.onCursor = (pt, e) => hoverAt("R", pt, e);
  paneL.onOverlay = (ctx, v) => drawLeft(ctx, v);
  paneR.onOverlay = (ctx, v) => drawRight(ctx, v);
  paneL.onLoupe = (ctx, L) => drawSnapIn(ctx, "L", L.toLoupe);
  paneR.onLoupe = (ctx, L) => drawSnapIn(ctx, "R", L.toLoupe);

  // ---- views and the mosaic so far
  const lastView = () => placed[placed.length - 1];
  const viewOf = (pl) => views[pl.i];
  const nextView = () => (k < views.length ? views[k] : null);
  const interval = () => Number(stint.value) || 50;
  function inkOf(v) {
    if (!v.ink) {
      const c = v.canvas, g = c.getContext("2d", { willReadFrequently: true });
      v.ink = fromRGBA(g.getImageData(0, 0, c.width, c.height).data, c.width, c.height);
    }
    return v.ink;
  }
  // only the last placed view's and the next view's ink are kept (a clip's ink is 4 bytes a pixel)
  function trimInk() { views.forEach((v, i) => { if (i !== lastView()?.i && i !== k) v.ink = null; }); }
  function pxPerFtLast() {
    const fi = Number(ftin.value);
    if (fi > 0) return pxPerFtOf(fi, s);
    if (seam.auto && seam.auto.P) return seam.auto.P / interval();
    return null;
  }
  const corners = (pl) => { const c = viewOf(pl).canvas; return [[0, 0], [c.width, 0], [c.width, c.height], [0, c.height]].map(([x, y]) => T(pl, { x, y })); };
  function stack(list, ghostLast) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of list) for (const c of corners(p)) { minX = Math.min(minX, c.x); minY = Math.min(minY, c.y); maxX = Math.max(maxX, c.x); maxY = Math.max(maxY, c.y); }
    const W = Math.ceil(maxX - minX), H = Math.ceil(maxY - minY);
    // no size limit: the mosaic is never one canvas. This only catches a join that went wild.
    if (!Number.isFinite(W) || !Number.isFinite(H) || W > 1e6 || H > 1e6) throw new Error(`The mosaic would be ${W} × ${H} px. That looks wrong: check the last join.`);
    return { minX, minY, width: W, height: H, list: list.slice(), ghostLast: !!ghostLast };
  }
  // Draws the part [sx, sx + sw) x [sy, sy + sh) of the mosaic (px from its top-left) into [dx, dy, dw, dh]: only the
  // views that touch it.
  function drawViews(M, ctx, sx, sy, sw, sh, dx, dy, dw, dh) {
    const f = dw / sw;
    ctx.save();
    ctx.beginPath(); ctx.rect(dx, dy, dw, dh); ctx.clip();
    ctx.transform(f, 0, 0, f, dx - sx * f, dy - sy * f);
    M.list.forEach((p, i) => {
      const cs = corners(p), xs = cs.map((c) => c.x - M.minX), ys = cs.map((c) => c.y - M.minY);
      if (Math.max(...xs) < sx || Math.min(...xs) > sx + sw || Math.max(...ys) < sy || Math.min(...ys) > sy + sh) return;
      ctx.save();
      ctx.globalAlpha = M.ghostLast && i === M.list.length - 1 ? 0.5 : 1;
      ctx.globalCompositeOperation = "darken"; // a clip's white margins don't hide the view under it (as mosaicPage.js)
      ctx.transform(p.a, p.b, -p.b, p.a, p.tx - M.minX, p.ty - M.minY);
      ctx.drawImage(viewOf(p).canvas, 0, 0);
      ctx.restore();
    });
    ctx.restore();
  }
  const sourceOf = (M) => ({ width: M.width, height: M.height, draw: (...a) => drawViews(M, ...a) });

  function candidate() {
    if (k >= views.length || !placed.length) return null;
    let t = null;
    if (seamActive()) {                                          // the seam join (lines, ticks, Auto join) wins
      t = seamWorld();
      return t ? { i: k, a: t.a, b: t.b, tx: t.tx, ty: t.ty } : null;
    }
    if (pairs.length) t = solvePairs(pairs);
    return t ? { i: k, ...t } : null;
  }
  // point pairs only (no line): rotation and shift, scale 1 (the prototype's solve with the scale locked)
  function solvePairs(prs) {
    const n = prs.length;
    if (n === 1) { const q = prs[0]; return { a: 1, b: 0, tx: q.w.x - q.p.x, ty: q.w.y - q.p.y }; }
    let pcx = 0, pcy = 0, wcx = 0, wcy = 0;
    for (const q of prs) { pcx += q.p.x; pcy += q.p.y; wcx += q.w.x; wcy += q.w.y; }
    pcx /= n; pcy /= n; wcx /= n; wcy /= n;
    let re = 0, im = 0;
    for (const q of prs) { const px = q.p.x - pcx, py = q.p.y - pcy, wx = q.w.x - wcx, wy = q.w.y - wcy; re += px * wx + py * wy; im += px * wy - py * wx; }
    const m = Math.hypot(re, im);
    if (m < 1e-9) return null;
    const a = re / m, b = im / m;
    return { a, b, tx: wcx - (a * pcx - b * pcy), ty: wcy - (b * pcx + a * pcy) };
  }
  const residuals = (t, prs) => prs.map((q) => { const r = T(t, q.p); return Math.hypot(r.x - q.w.x, r.y - q.w.y); });

  // ---- the seam (joinSeam.js): road lines, station ticks, Auto join, nudges, readout
  const seamActive = () => k < views.length && placed.length && (seam.lines.length || seam.auto || seam.pend || seam.ticks.L || seam.ticks.R);
  function dirFor(side) {                                      // road direction in that view's pixels
    const ln = seam.lines[0];
    if (ln) return side === "L" ? ln.L.d : ln.R.d;
    if (seam.auto) return side === "L" ? seam.auto.u : Tdir(invert(seam.auto.rel), seam.auto.u);
    const v = side === "L" ? viewOf(lastView()) : nextView();
    if (v.dir === undefined) v.dir = roadDirection(inkOf(v));
    return { x: Math.cos(v.dir), y: Math.sin(v.dir) };
  }
  const sizeOf = (v) => ({ w: v.canvas.width, h: v.canvas.height });

  // Solves the seam from everything given. Result in seam.rel (next -> last view px).
  function seamUpdate() {
    seam.rel = seam.base = seam.report = null;
    seam.info = "";
    if (!seamActive()) return;
    const last = lastView(), inv = invert(last), ppf = pxPerFtLast();
    const c = { s: 1, lines: seam.lines, points: pairs.map((q) => ({ L: T(inv, q.w), R: q.p })) };
    const a = seam.ticks.L && parseStation(seam.ticks.L.station), b = seam.ticks.R && parseStation(seam.ticks.R.station);
    let stationUse = null;
    if (seam.ticks.L && seam.ticks.R && a !== null && b !== null) {
      if (ppf) { c.stations = { L: seam.ticks.L.pt, R: seam.ticks.R.pt, dist_px: (b - a) * ppf }; stationUse = b - a; }
      else seam.info = 'Enter the plan scale (1" = ? ft) to use the stations.';
    }
    if (seam.anchor) c.anchor = seam.anchor;
    if (!c.lines.length) {
      if (seam.theta !== null) { c.theta = seam.theta; c.u = seam.u; }
      else if (c.points.length < 2) return;
    }
    const base = solveSeam(c);
    if (!base) return;
    const u = base.u || seam.u || dirFor("L");
    const vL = sizeOf(viewOf(last)), vR = sizeOf(nextView());
    // pivot for rotation nudges: where the road leaves the last view
    const r0 = seamReport({ rel: base, u, pxPerFt: ppf || 1, lines: seam.lines, viewL: vL, viewR: vR });
    const pivot = r0.seam || { x: vL.w, y: vL.h / 2 };
    const nd = seam.nudge, f = ppf || 1;
    if (!base.alongFixed && r0.gap_ft !== null) {             // nothing fixes the along position yet: butt the views
      const g = r0.gap_ft * (ppf || 1); base.tx -= g * u.x; base.ty -= g * u.y;
    }
    const rel = nudgeRel(base, { rot: (nd.rot * Math.PI) / 180, along: nd.along * f, across: nd.across * f }, pivot, u);
    seam.base = base; seam.rel = rel; seam.u = u; seam.pivot = pivot;
    seam.report = seamReport({ rel, u, pxPerFt: f, lines: seam.lines, points: c.points, stations: c.stations,
      ticksL: seam.auto && seam.auto.ticksL, ticksR: seam.auto && seam.auto.ticksR, viewL: vL, viewR: vR });
    seam.report.units = ppf ? "ft" : "px";
    seam.report.stationUse = stationUse;
    seam.report.alongFixed = base.alongFixed;
    seam.provisional = !base.alongFixed;                       // lines only: the next view is NOT placed until the along position is set
    if (!seam.provisional && !seam.wasComplete) {              // just became complete: show the overlay and the seam
      seam.wasComplete = true; preview = true; previewSw.checked = true; seam.scrollPending = true;
    }
    if (seam.provisional) seam.wasComplete = false;
  }
  const seamWorld = () => (!seam.rel || seam.provisional ? null : compose(lastView(), seam.rel));

  // ---- clicks and the snap
  function inView(side, p) {
    const v = side === "L" ? viewOf(lastView()) : nextView();
    return p.x >= 0 && p.y >= 0 && p.x <= v.canvas.width && p.y <= v.canvas.height;
  }
  const toViewPx = (side, pt) => (side === "L" ? T(invert(lastView()), pt) : pt);
  const toPanePx = (side, p) => (side === "L" ? T(lastView(), p) : p);
  const paneOf = (side) => (side === "L" ? paneL : paneR);
  const radius = (side, px) => px / Math.max(1e-6, paneOf(side).z); // screen px -> view px (scale 1 between views)
  const snapping = (e) => snapOn && !e?.altKey && (tool === "point" || tool === "tick");
  let hoverTimer = 0, hoverWanted = null;
  function hoverAt(side, pt, e) {
    if (!pt || !snapping(e) || !placed.length || k >= views.length) { if (hover) { hover = null; redraw(); } return; }
    hoverWanted = { side, pt };
    if (hoverTimer) return;
    hoverTimer = setTimeout(() => {
      hoverTimer = 0;
      const w = hoverWanted, p = toViewPx(w.side, w.pt);
      if (!inView(w.side, p)) { hover = null; redraw(); return; }
      const v = w.side === "L" ? viewOf(lastView()) : nextView();
      const r = snapPoint(inkOf(v), p, { r: radius(w.side, MOSAIC.SNAP_PX) });
      hover = r.kind === "none" ? null : { side: w.side, p: { x: r.x, y: r.y }, kind: r.kind };
      redraw();
    }, 40);
  }
  function click(side, pt, e) {
    if (!placed.length || k >= views.length) return;
    let p = toViewPx(side, pt);
    if (snapping(e) && inView(side, p)) {
      const v = side === "L" ? viewOf(lastView()) : nextView();
      const r = snapPoint(inkOf(v), p, { r: radius(side, MOSAIC.SNAP_PX) });
      if (r.kind !== "none") p = { x: r.x, y: r.y };
    }
    if (tool === "point") {
      if (side === "L") pendingW = toPanePx("L", p);
      else if (!pendingW) { setStatus("Click the point on the mosaic (left) first."); return; }
      else { pairs.push({ w: pendingW, p, station: "" }); pendingW = null; }
      refresh();
      return;
    }
    seamClick(side, p);
  }
  function seamClick(side, p) {
    const v = side === "L" ? viewOf(lastView()) : nextView();
    if (!inView(side, p)) { setStatus(`Click inside the ${side === "L" ? "last placed view" : "next view"}.`); return; }
    const seek = Math.max(3, radius(side, 9));
    if (tool === "line") {
      const ln = snapLine(inkOf(v), p, { seek });
      if (!ln) { setStatus("No straight line found there. Click right on a long line: edge of pavement, curb, centerline."); return; }
      if (side === "L") seam.pend = { L: ln };
      else if (!seam.pend) { setStatus("Click the line in the mosaic (left) first, then the same line here."); return; }
      else {
        const dA = Math.abs(((Math.atan2(seam.pend.L.d.y, seam.pend.L.d.x) - Math.atan2(ln.d.y, ln.d.x)) * 180 / Math.PI + 540) % 360 - 180);
        seam.lines.push({ L: seam.pend.L, R: ln }); seam.pend = null; seam.log.push("line");
        if (seam.lines.length === 1 && dA > 60) setStatus(`Note: the two lines differ by ${dA.toFixed(0)}°. That is fine if the road turns between the views.`);
      }
    } else if (tool === "tick") {
      const t = snapTick(inkOf(v), p, dirFor(side), { search: Math.max(6, seek) });
      if (!t) { setStatus("No station tick found there. Click on the short tick mark across the station line."); return; }
      const old = seam.ticks[side];
      let sta = old ? old.station : "";
      if (!sta) {                                              // suggest: next view = mosaic tick + one interval
        const o = seam.ticks[side === "L" ? "R" : "L"], os = o && parseStation(o.station);
        if (os !== null && os !== undefined && o) sta = fmtSta(os + (side === "R" ? interval() : -interval()));
      }
      seam.ticks[side] = { pt: t, station: sta }; seam.log.push(`tick${side}`);
      (side === "L" ? stL : stR).value = sta;
      if (!sta) (side === "L" ? stL : stR).setFocus?.();
    }
    refresh();
  }

  function seamUndo() {
    if (seam.pend) { seam.pend = null; return true; }
    const a = seam.log.pop();
    if (!a) return false;
    if (a === "auto") {                                        // undo the whole Auto join
      seam = seam.undoTo || newSeam(); seam.wasComplete = false;
      stL.value = seam.ticks.L ? seam.ticks.L.station : ""; stR.value = seam.ticks.R ? seam.ticks.R.station : "";
      return true;
    }
    if (a === "anchor") { seam.anchor = null; seam.overlapCheck = null; return true; }
    if (a === "line") seam.lines.pop();
    else if (a === "tickL") { seam.ticks.L = null; stL.value = ""; }
    else if (a === "tickR") { seam.ticks.R = null; stR.value = ""; }
    return true;
  }
  function undo() {
    if (pendingW) pendingW = null;
    else if (tool === "point" && pairs.length) pairs.pop();
    else if (!seamUndo()) pairs.pop();
    refresh();
  }

  async function runAutoJoin() {
    if (!placed.length || k >= views.length || seamBusy) return;
    seamBusy = true; renderButtons(); setStatus("Auto join: finding the road lines and station ticks at the seam…");
    try {
      const ppf = Number(ftin.value) > 0 ? pxPerFtOf(Number(ftin.value), s) : null;
      const r = await autoSeamAsync(inkOf(viewOf(lastView())), inkOf(nextView()), { s: 1, P: ppf ? ppf * interval() : null });
      if (!r.ok) { setStatus(`Auto join: ${r.notes.join(" ")}`); return; }
      const before = seam;
      seam = newSeam(); seam.ticks = before.ticks;
      seam.undoTo = before; seam.log = before.log.concat(["auto"]);
      seam.lines = r.lines.map((l) => ({ L: l.L, R: l.R }));
      const nv = nextView(), cR = { x: nv.canvas.width / 2, y: nv.canvas.height / 2 };
      seam.anchor = { L: T(r.rel, cR), R: cR };
      seam.theta = Math.atan2(r.rel.b, r.rel.a); seam.u = r.u;
      seam.auto = { method: r.method, confidence: r.confidence, notes: r.notes, P: r.P, u: r.u, rel: r.rel, ticksL: r.ticksL, ticksR: r.ticksR,
        slide: r.slide, gap_px: r.gap_px, profile: r.profile, reduced: r.reduced || 1 };
      pairs = []; pendingW = null; seam.scrollPending = true;
    } catch (err) {
      setStatus(`Auto join failed: ${err.message}`); console.error(err);
    } finally {
      seamBusy = false;
      refresh();
    }
  }

  function seamNudge(kind, sign) {
    if (!seamActive()) return;
    const ppf = pxPerFtLast();
    if (kind === "rot") seam.nudge.rot += sign * Number(stepRot.value);
    else if (kind === "station") {
      if (!ppf) { setStatus('Enter the plan scale (1" = ? ft) to move by one station.'); return; }
      if (seam.ticks.L && seam.ticks.R && parseStation(seam.ticks.R.station) !== null) { // stations given: change the next view's station
        seam.ticks.R.station = fmtSta(parseStation(seam.ticks.R.station) + sign * interval()); stR.value = seam.ticks.R.station;
      } else seam.nudge.along += sign * interval();
    } else {
      const step = ppf ? Number(stepFt.value) : Number(stepFt.value) * 4;       // no scale: steps in px
      seam.nudge[kind] += sign * step;
    }
    seam.overlapCheck = null;
    refresh();
  }

  // Match overlap. With lines only (along position not set yet): search the whole overlap and SET the along position.
  // With the along position already set: search half a station each way and REPORT (an independent check).
  async function checkOverlap() {
    if (!seam.rel) { setStatus("Snap at least one line pair first (Line tool), or press Auto join."); return; }
    if (seamBusy) return;
    const setIt = seam.provisional;
    seamBusy = true; renderButtons();
    setStatus(setIt ? "Matching the overlap along the road…" : "Checking the overlap along the road…");
    try {
      const ppf = pxPerFtLast(), f = ppf || 1, P = ppf ? interval() * ppf : 150;
      const L = viewOf(lastView()).canvas, R = nextView().canvas, u = seam.u;
      let range = [-0.45 * P, 0.45 * P];
      if (setIt) {                                             // from "next view fully over the last view" to "just touching"
        const al = (pts, t) => pts.map((p) => { const q = t ? T(t, p) : p; return q.x * u.x + q.y * u.y; });
        const rl = al([{ x: 0, y: 0 }, { x: L.width, y: 0 }, { x: 0, y: L.height }, { x: L.width, y: L.height }]);
        const rr = al([{ x: 0, y: 0 }, { x: R.width, y: 0 }, { x: 0, y: R.height }, { x: R.width, y: R.height }], seam.rel);
        range = [Math.min(...rl) - Math.max(...rr) + 20, Math.max(...rl) - Math.min(...rr) - 10];
      }
      const rel0 = seam.rel;
      const sm = await slideMatchAsync(inkOf(viewOf(lastView())), inkOf(nextView()), rel0, u, range, { step: 1, minN: 80 });
      const clear = sm.score >= 0.5 && (sm.ratio > 1.3 || sm.score - sm.second > 0.1);
      if (!clear) {
        seam.overlapCheck = null; refresh();
        setStatus(`${setIt ? "Match overlap" : "Overlap check"}: no clear match${sm.score > 0 ? ` (best ${Math.round(sm.score * 100)}%, next ${Math.round(sm.second * 100)}%)` : ""}. The views may not overlap, or the overlap repeats. Use the Tick tool: click a station tick in each view and type the stations.`);
        return;
      }
      if (setIt) {                                             // keep it as an along-only anchor, as Auto join does
        const t = { a: rel0.a, b: rel0.b, tx: rel0.tx + sm.shift * u.x, ty: rel0.ty + sm.shift * u.y };
        const cR = { x: R.width / 2, y: R.height / 2 };
        seam.anchor = { L: T(t, cR), R: cR }; seam.log.push("anchor");
        seam.overlapCheck = { shift_ft: 0, score: sm.score };
        refresh();
        setStatus(`Match overlap: along-road position set from the overlap (${Math.round(sm.score * 100)}% match, next best ${Math.round(sm.second * 100)}%). Check the overlay.`);
        return;
      }
      seam.overlapCheck = { shift_ft: sm.shift / f, score: sm.score };
      refresh();
      setStatus(`Overlap check: the overlap fits best ${(sm.shift / f).toFixed(2)}${ppf ? " ft" : " px"} along the road from here (${Math.round(sm.score * 100)}% match).${Math.abs(sm.shift / f) > 0.5 ? " Use the Along buttons to move it, if the overlay agrees." : ""}`);
    } catch (err) {
      setStatus(`Match overlap failed: ${err.message}`); console.error(err);
    } finally {
      seamBusy = false;
      renderButtons();
    }
  }

  function testScale() {
    if (!views.length) return;
    const list = [placed.length ? viewOf(lastView()) : null, nextView()].filter(Boolean);
    const out = list.map((v) => {
      const ink = inkOf(v), e = roadEnd(ink, "end");
      const t = e ? tickLattice(ink, e, { P: null }) : { ok: false };
      return { name: v.label, t, g: t.ok ? guessScale(t.P, interval(), s) : null };
    });
    const ok = out.filter((o) => o.t.ok && o.t.ticks.length >= 3);
    const txt = out.map((o) => `${o.name}: ${o.t.ok ? `${o.t.ticks.length} ticks, every ${o.t.P.toFixed(1)} px = 1" : ${o.g.ft_per_inch.toFixed(2)} ft` : "no tick pattern"}`).join("; ");
    const sure = ok.length && ok.every((o) => o.g.nearest === ok[0].g.nearest) && ok.every((o) => Math.abs(o.g.off_pct) < 2);
    if (sure) ftin.value = String(ok[0].g.nearest);
    refresh();
    setStatus(`Scale test: ${txt}${sure ? `. Set 1" = ${ok[0].g.nearest} ft. Check it against the plan.` : ". Not sure. Type the plan scale from the title block."}`);
  }

  function seamInfoForJson() {
    const r = seam.report;
    if (!r) return null;
    return { method: seam.auto ? `auto: ${seam.auto.method}` : "manual", confidence: seam.auto ? seam.auto.confidence : null,
      line_pairs: seam.lines.length, units: r.units, rotation_deg: r.rotation_deg, gap: r.gap_ft,
      lines: r.lines, station: r.station || null, points: r.points, tick_phase: r.tick_phase_ft ?? null,
      stations: { last: seam.ticks.L ? seam.ticks.L.station : null, next: seam.ticks.R ? seam.ticks.R.station : null },
      along_from: r.stationUse !== null && !seam.lines.length ? "stations" : r.stationUse !== null ? "stations (not a check)" : pairs.length ? "point pairs" : seam.anchor ? (seam.auto ? "auto join" : "overlap") : null,
      nudge: { ...seam.nudge }, overlap_check: seam.overlapCheck, notes: seam.auto ? seam.auto.notes : [] };
  }

  // ---- adding and removing views
  function commit() {
    const c = candidate();
    if (!c) return;
    const res = residuals(c, pairs);
    c.ties = pairs.map((q, i) => ({ station: q.station, w: q.w, p: q.p, residual_px: res[i] }));
    c.seam = seamActive() ? seamInfoForJson() : { method: "point pairs", points: pairs.length };
    try { stack([...placed, c], false); } catch (err) { setStatus(err.message); return; }
    placed.push(c);
    k++; pairs = []; pendingW = null; preview = false; previewSw.checked = false;
    seam = newSeam(); stL.value = ""; stR.value = ""; hover = null;
    trimInk();
    refresh({ fitRight: true });
    // show the new seam end of the mosaic
    const M = leftM;
    if (M) { const cs = corners(lastView()); paneL.focus(Math.max(...cs.map((q) => q.x)), (Math.min(...cs.map((q) => q.y)) + Math.max(...cs.map((q) => q.y))) / 2); }
  }
  function undoView() {
    if (placed.length < 2) return;
    placed.pop(); k--;
    pairs = []; pendingW = null; seam = newSeam(); stL.value = ""; stR.value = ""; hover = null;
    refresh({ fitRight: true });
  }

  // ---- drawing (screen pixels; v.toScreen maps the pane's coordinates)
  const LINE_COL = ["#e0007a", "#008f5a", "#d26a00", "#6b3fd4", "#0088aa", "#9a7b00"];
  const line = (ctx, a, b, col, dash) => { ctx.save(); ctx.strokeStyle = col; ctx.lineWidth = 3; ctx.globalAlpha = 0.85; if (dash) ctx.setLineDash([10, 6]); ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); ctx.restore(); };
  function tick(ctx, p, d, col, label) {
    const n = { x: -d.y, y: d.x }, r = 14;
    ctx.save(); ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.moveTo(p.x - n.x * r, p.y - n.y * r); ctx.lineTo(p.x + n.x * r, p.y + n.y * r); ctx.stroke();
    ctx.beginPath(); ctx.arc(p.x, p.y, 4, 0, Math.PI * 2); ctx.stroke();
    if (label) { ctx.font = "bold 14px sans-serif"; ctx.fillText(label, p.x + 6, p.y - 8); }
    ctx.restore();
  }
  function marker(ctx, p, n, hollow) {
    const r = 8;
    ctx.save(); ctx.lineWidth = 2; ctx.strokeStyle = "#e01010"; ctx.fillStyle = "#e01010";
    ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.stroke();
    if (!hollow) { ctx.beginPath(); ctx.arc(p.x, p.y, 2, 0, Math.PI * 2); ctx.fill(); }
    ctx.beginPath(); ctx.moveTo(p.x - r * 1.6, p.y); ctx.lineTo(p.x + r * 1.6, p.y); ctx.moveTo(p.x, p.y - r * 1.6); ctx.lineTo(p.x, p.y + r * 1.6); ctx.stroke();
    ctx.font = "bold 15px sans-serif"; ctx.fillText(String(n), p.x + r * 1.2, p.y - r * 1.2);
    ctx.restore();
  }
  // the snap marker: a square on a corner, a diamond on a line
  function snapMark(ctx, q, kind, size = 7) {
    ctx.save(); ctx.lineWidth = 3; ctx.strokeStyle = "rgba(255,255,255,.9)";
    const path = () => { ctx.beginPath(); if (kind === "corner") ctx.rect(q.x - size, q.y - size, 2 * size, 2 * size); else { ctx.moveTo(q.x, q.y - size - 2); ctx.lineTo(q.x + size + 2, q.y); ctx.lineTo(q.x, q.y + size + 2); ctx.lineTo(q.x - size - 2, q.y); ctx.closePath(); } };
    path(); ctx.stroke(); ctx.lineWidth = 1.5; ctx.strokeStyle = "#e01010"; path(); ctx.stroke();
    ctx.restore();
  }
  function drawSnapIn(ctx, side, toScreen) {
    if (!hover || hover.side !== side) return;
    const q = toPanePx(side, hover.p), sp = toScreen(q.x, q.y);
    snapMark(ctx, sp, hover.kind);
  }
  function drawLeft(ctx, v) {
    if (!placed.length) return;
    const W = (p) => { const q = T(lastView(), p); return v.toScreen(q.x, q.y); };
    if (k < views.length) {
      seam.lines.forEach((lp, i) => line(ctx, W(lp.L.p0), W(lp.L.p1), LINE_COL[i % 6]));
      if (seam.pend) line(ctx, W(seam.pend.L.p0), W(seam.pend.L.p1), LINE_COL[seam.lines.length % 6], true);
      const dW = (d) => Tdir(lastView(), d);
      if (seam.auto && seam.auto.ticksL) for (const t of seam.auto.ticksL.ticks) tick(ctx, W(t), dW(seam.auto.u), "#00a0c0");
      if (seam.ticks.L) tick(ctx, W(seam.ticks.L.pt), dW(dirFor("L")), "#e01010", seam.ticks.L.station);
    }
    pairs.forEach((q, i) => marker(ctx, v.toScreen(q.w.x, q.w.y), i + 1, false));
    if (pendingW) marker(ctx, v.toScreen(pendingW.x, pendingW.y), pairs.length + 1, true);
    drawSnapIn(ctx, "L", v.toScreen.bind(v));
  }
  function drawRight(ctx, v) {
    if (!placed.length || k >= views.length) return;
    const S = (p) => v.toScreen(p.x, p.y);
    seam.lines.forEach((lp, i) => line(ctx, S(lp.R.p0), S(lp.R.p1), LINE_COL[i % 6]));
    if (seam.auto && seam.auto.ticksR) for (const t of seam.auto.ticksR.ticks) tick(ctx, S(t), dirFor("R"), "#00a0c0");
    if (seam.ticks.R) tick(ctx, S(seam.ticks.R.pt), dirFor("R"), "#e01010", seam.ticks.R.station);
    pairs.forEach((q, i) => marker(ctx, S(q.p), i + 1, false));
    drawSnapIn(ctx, "R", v.toScreen.bind(v));
  }
  const redraw = () => { paneL.requestDraw(); paneR.requestDraw(); };

  // ---- refresh: solve, panes, readout, status
  let leftKey = "";
  function refresh({ fitRight = false } = {}) {
    seamUpdate();
    if (placed.length) {
      let M = stack(placed, false);
      const cand = candidate();
      if (preview && cand) { try { M = stack([...placed, cand], true); } catch (err) { setStatus(err.message); } }
      leftM = M;
      const key = `${M.minX}|${M.minY}|${M.width}|${M.height}|${M.list.length}|${M.ghostLast}|${M.list.map((p) => `${p.a},${p.b},${p.tx},${p.ty}`).join(";")}`;
      const first = !paneL.src;
      if (key !== leftKey) { paneL.setSource(sourceOf(M), 1, M.minX, M.minY, !first); leftKey = key; }
    }
    const nv = nextView();
    if (nv && (fitRight || paneR.src?.canvas !== nv.canvas)) paneR.setSource(nv.canvas, 1, 0, 0, false);
    pr.head.textContent = nv ? `Next view: ${nv.label} (then click the same point here)` : "No more views";
    pr.el.classList.toggle("mz-done", !nv);
    redraw();
    renderReadout();
    renderButtons();
    renderStatus();
    if (seam.scrollPending) { seam.scrollPending = false; scrollToSeam(); }
    onChange();
  }
  function scrollToSeam() {
    if (!seam.pivot || k >= views.length) return;
    const w = T(lastView(), seam.pivot);
    paneL.focus(w.x, w.y);
    const ln = seam.lines[0];
    if (ln) { const p = ln.R.p0.x < ln.R.p1.x ? ln.R.p0 : ln.R.p1; paneR.focus(p.x, p.y); }
  }

  function renderButtons() {
    const hasNext = k < views.length;
    addBtn.disabled = !candidate();
    autoBtn.disabled = !(placed.length && hasNext) || seamBusy;
    autoBtn.loading = seamBusy;
    overlapBtn.disabled = !seam.rel || seamBusy;
    undoBtn.disabled = !(pairs.length || pendingW || seam.log.length || seam.pend);
    undoViewBtn.disabled = placed.length < 2;
    bar.querySelectorAll(".mz-row")[1].querySelectorAll("calcite-action, calcite-button").forEach((b) => { if (b !== overlapBtn) b.disabled = !seamActive() || !seam.rel; });
    overlapBtn.disabled = !seam.rel || seamBusy;
  }

  function seamText() {
    const r = seam.report;
    if (seam.pend) return "Line picked in the mosaic. Now click the SAME line in the next view (right).";
    if (!r) {
      if (!seam.lines.length && !seam.auto) return tool === "line" ? "Click a road line in the mosaic (left), then the same line in the next view (right). Or press Auto join."
        : tool === "tick" ? "Click a station tick in the mosaic (left) and one in the next view (right), and type their stations." : "";
      return seam.info || "Add a station tick in each view (or a point pair) to fix the position along the road.";
    }
    let t = `Seam: ${seam.lines.length ? `${seam.lines.length} line pair(s)` : "auto rotation"}`;
    t += r.stationUse !== null ? `, stations ${r.stationUse.toFixed(1)} ft apart` : pairs.length ? `, ${pairs.length} point pair(s)` : seam.anchor ? ", along-road from Auto join or the overlap" : "";
    if (!r.alongFixed) t += ". Now set the along-road position: Tick tool (a tick in each view + stations), a point pair, or Match overlap. The view is placed after that.";
    else t += ". Check the overlay, nudge if needed, then Add view.";
    return t;
  }
  function renderStatus() {
    if (!views.length) { setStatus("Clip the views first."); return; }
    if (k >= views.length) { setStatus(`All ${views.length} views placed. Use the mosaic, or export it.`); return; }
    const cand = candidate();
    let t = `View ${k + 1} of ${views.length}. `;
    if (seamActive() || tool !== "point") t += seamText();
    else if (!cand) t += pendingW ? "Now click the SAME point in the next view (right)." : "Click a point on the mosaic (left), then the same point in the next view (right). Use 2 or more pairs, or use the Line and Tick tools.";
    else {
      const res = residuals(cand, pairs), rms = Math.sqrt(res.reduce((x, y) => x + y * y, 0) / res.length);
      t += `${pairs.length} pair(s). Rotation ${(Math.atan2(cand.b, cand.a) * 180 / Math.PI).toFixed(2)}°${pairs.length > 1 ? `, RMS error ${rms.toFixed(1)} px.` : ". (1 pair = shift only; add a 2nd pair.)"} Turn on Preview overlay to check, then add the view.`;
    }
    setStatus(t);
  }

  // the readout: per-line side offset and angle, flags, and the along-road control (honest about what is a check)
  function renderReadout() {
    const r = seam.report, a = seam.auto;
    readout.replaceChildren();
    if (!r) {
      if (a?.notes?.length) readout.append(h("div", { class: "mz-warn" }, ...a.notes.flatMap((n, i) => (i ? [h("br"), n] : [n]))));
      return;
    }
    const u = r.units, f = (v) => (v === null || v === undefined || !Number.isFinite(v) ? "-" : Math.abs(v) < 0.005 ? "0.00" : v.toFixed(2));
    const bad = (v, lim) => (Math.abs(v) > lim ? "mz-bad" : "");
    const rows = [];
    const row = (name, value, meaning, cls = "") => rows.push(h("tr", { title: meaning }, h("td", {}, name), h("td", { class: cls }, value), h("td", { class: "mz-mut" }, meaning)));
    if (a) row("Auto join", h("span", {}, `${a.method} `, h("b", { class: `mz-q-${a.confidence}` }, a.confidence)), [a.slide ? `overlap match ${Math.round(a.slide.score * 100)}%` : "", a.ticksL ? `ticks ${a.ticksL.ticks.length} / ${a.ticksR ? a.ticksR.ticks.length : 0}` : ""].filter(Boolean).join(", "));
    row("Rotation", `${r.rotation_deg.toFixed(3)}°`, "next view, relative to the last view");
    if (seam.provisional) row("Along road", "not set", "the next view is not placed yet", "mz-bad");
    else if (r.gap_ft !== null) row(r.gap_ft >= 0 ? "Gap" : "Overlap", `${f(Math.abs(r.gap_ft))} ${u}`, "measured along line 1, between the clip edges");
    r.lines.forEach((l, i) => {
      const drop = h("calcite-action", { icon: "x", text: "Remove this line pair", scale: "s", onclick: () => { seam.lines.splice(i, 1); const j = seam.log.lastIndexOf("line"); if (j >= 0) seam.log.splice(j, 1); refresh(); } });
      rows.push(h("tr", { title: "side offset at the seam, angle difference" },
        h("td", {}, h("span", { class: "mz-swatch", style: `background:${LINE_COL[i % 6]}` }), `Line ${i + 1}`, drop),
        h("td", {}, h("span", { class: bad(l.offset_ft, u === "ft" ? 0.5 : 2) }, `${f(l.offset_ft)} ${u}`), ", ", h("span", { class: bad(l.angle_deg, 0.1) }, `${l.angle_deg.toFixed(3)}°`)),
        h("td", { class: "mz-mut" }, "side offset at the seam, angle difference")));
    });
    if (r.station) row("Stations", `${f(r.station.along_ft)} ${u}`, `${seam.lines.length ? "sets the along-road position (not a check)" : "along-road error"}; ticks ${f(r.station.cross_ft)} ${u} apart across the road`);
    r.points.forEach((p, i) => row(`Point ${i + 1}`, `${f(p.along_ft)} / ${f(p.cross_ft)} ${u}`, "along / across error", bad(Math.hypot(p.along_ft, p.cross_ft), u === "ft" ? 1 : 3)));
    if (r.tick_phase_ft !== undefined) row("Tick spacing", `${f(r.tick_phase_ft)} ${u}`, "next view ticks vs the last view tick spacing (0 = on a station; a whole station off is not visible here)", bad(r.tick_phase_ft, u === "ft" ? 0.5 : 2));
    if (seam.overlapCheck) { const o = seam.overlapCheck; row("Overlap check", `${f(o.shift_ft)} ${u}`, `overlap match prefers this along-road shift (${Math.round(o.score * 100)}% match)`, bad(o.shift_ft, u === "ft" ? 0.5 : 2)); }
    const nd = seam.nudge;
    if (nd.rot || nd.along || nd.across) row("Nudges", `${nd.rot.toFixed(2)}°, ${nd.along.toFixed(2)} / ${nd.across.toFixed(2)} ${u}`, "rotation, along, across");
    const table = h("table", { class: "mz-table" }, h("tbody", {}, ...rows));
    readout.append(table);
    if (!r.alongFixed) readout.append(h("div", { class: "mz-bad mz-next" }, "Next: set the along-road position. Tick tool: click a station tick in each view and type the stations. Or Point pair, or Match overlap if the views overlap."));
    const notes = [...(a?.notes ?? []), seam.info].filter(Boolean);
    if (notes.length) readout.append(h("div", { class: "mz-warn" }, ...notes.flatMap((n, i) => (i ? [h("br"), n] : [n]))));
  }

  // ---- keyboard (the workspace passes keys here while the join is shown and focus isn't in a text box)
  function key(e) {
    const map = { z: () => undo(), Enter: () => commit(), "[": () => seamNudge("rot", -1), "]": () => seamNudge("rot", 1),
      ArrowLeft: () => seamNudge("along", -1), ArrowRight: () => seamNudge("along", 1), ArrowUp: () => seamNudge("across", -1), ArrowDown: () => seamNudge("across", 1),
      Escape: () => { pendingW = null; seam.pend = null; refresh(); } };
    const fn = map[e.key];
    if (!fn || e.ctrlKey || e.metaKey) return false;
    fn();
    return true;
  }

  // ---- the test case: the two view PNGs and the seam, for Auto join cases that fail
  async function saveTestCase() {
    if (!placed.length || k >= views.length) { setStatus("Save test case needs a seam: a placed view and a next view."); return; }
    const png = async (c) => new Uint8Array(await (await new Promise((res) => c.toBlob(res, "image/png"))).arrayBuffer());
    const L = viewOf(lastView()), R = nextView();
    const strip = (o) => JSON.parse(JSON.stringify(o, (key, v) => (key === "pts" || key === "undoTo" || key === "_dbg" || key === "all" ? undefined : v)));
    const data = {
      tool: "Atlas plan mosaic, Save test case", saved: new Date().toISOString(), render_px_per_pt: s,
      plan_scale_ft_per_in: Number(ftin.value) || null, tick_interval_ft: interval(),
      last: { label: L.label, clip: L.clip, file: "last.png", w: L.canvas.width, h: L.canvas.height },
      next: { label: R.label, clip: R.clip, file: "next.png", w: R.canvas.width, h: R.canvas.height },
      seam: strip({ lines: seam.lines, ticks: seam.ticks, anchor: seam.anchor, nudge: seam.nudge, auto: seam.auto, rel: seam.rel, report: seam.report, overlap_check: seam.overlapCheck }),
      point_pairs: pairs.map((q) => ({ last_px: T(invert(lastView()), q.w), next_px: q.p })),
    };
    const bytes = zip([{ name: "last.png", data: await png(L.canvas) }, { name: "next.png", data: await png(R.canvas) }, { name: "seam.json", data: JSON.stringify(data, null, 2) }]);
    saveFile(bytes, `mosaic-test-${(L.label || "last").replace(/[^\w-]+/g, "_")}-${(R.label || "next").replace(/[^\w-]+/g, "_")}.zip`, "application/zip");
    setStatus("Test case saved: the two views and the seam, in one zip.");
  }

  // ---- the draft (mosaicDraft.js): everything but the images
  function state() {
    const strip = (o) => JSON.parse(JSON.stringify(o ?? null, (key, v) => (key === "undoTo" ? undefined : v)));
    return { k, placed: placed.map(({ i, a, b, tx, ty, seam: sm, ties }) => ({ i, a, b, tx, ty, seam: sm, ties })), pairs, pendingW,
      seam: strip(seam), tool, preview, ftin: ftin.value, stint: stint.value };
  }
  function restore(st) {
    if (!st) return;
    k = Math.min(st.k ?? 1, views.length);
    placed = (st.placed ?? []).filter((p) => p.i < views.length);
    if (!placed.length && views.length) placed = [{ i: 0, a: 1, b: 0, tx: 0, ty: 0, seam: null, ties: [] }];
    k = Math.max(k, placed.length);
    pairs = st.pairs ?? []; pendingW = st.pendingW ?? null;
    seam = st.seam ? { ...newSeam(), ...st.seam } : newSeam();
    tool = st.tool ?? "line";
    toolSeg.querySelectorAll("calcite-segmented-control-item").forEach((i) => { i.checked = i.value === tool; });
    preview = !!st.preview; previewSw.checked = preview;
    if (st.ftin) ftin.value = st.ftin;
    if (st.stint) stint.value = st.stint;
    stL.value = seam.ticks.L?.station ?? ""; stR.value = seam.ticks.R?.station ?? "";
    refresh({ fitRight: true });
    paneL.fit();
  }

  return {
    // views: [{ label, canvas, clip }] rendered at px per point `scale`; starts the mosaic with the first view
    setViews(list, scale) {
      views = list; s = scale;
      placed = list.length ? [{ i: 0, a: 1, b: 0, tx: 0, ty: 0, seam: null, ties: [] }] : [];
      k = list.length ? 1 : 0; pairs = []; pendingW = null; seam = newSeam(); preview = false; previewSw.checked = false; hover = null;
      leftKey = ""; paneL.clearSource(); paneR.clearSource();
      refresh({ fitRight: true });
      paneL.fit();
    },
    restore, state, key, saveTestCase,
    get placed() { return placed; },
    get views() { return views; },
    get scale() { return s; },
    get planScale() { return { ftin: Number(ftin.value) || null, stint: interval() }; },
    get source() { return leftM && !leftM.ghostLast ? sourceOf(leftM) : placed.length ? sourceOf(stack(placed, false)) : null; },
    resize() { paneL.resize(); paneR.resize(); },
    get panes() { return { L: paneL, R: paneR }; },
    get seam() { return seam; },
    destroy() { paneL.destroy(); paneR.destroy(); clearTimeout(hoverTimer); },
  };
}
