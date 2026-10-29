import { normCrop } from "./cropMath.js";
import { SheetPyramid } from "./sheetPyramid.js";

// The sheet pane's canvas: shows the plan page (or the rendered crop of it) and lets you pan, zoom, frame the crop,
// pick control points, drag them, measure a known distance and use a loupe. Canvas only; no SDK. A smaller rebuild of
// PlanView from georeferencer/js/app/10-plan-view.js. The source is drawn through a pyramid of levels and tiles
// (sheetPyramid.js): a render can be 26,000 px wide, and scaling it whole on every frame stalled the page.
// Zoomed in past the source's own pixels, the part in view is rendered again from the PDF at the screen's resolution
// (setDetail: who renders it, and the finest worth asking for), a moment after the view comes to rest, and drawn over it.
//
// View transform:  screen = t + z * (page point), z in screen pixels per PDF point. The source canvas covers the page
// rectangle [ox, ox + width / k0] x [oy, oy + height / k0], k0 being its own pixels per point.
//
// Modes: "view" (pan and zoom), "crop" (drag a rectangle; handles resize it), "pick" (click to place a point, drag a
// pin to move it, loupe on), "measure" (two clicks measure a distance). Middle or right button, or Space + drag, always pans.
//
// Callbacks (assign what you need): onCrop(crop, final, kind: "cropNew" | "cropMove" | "cropHandle"), onCropClick(pt), onPick(xp, yp, event), onSelect(id), onHover(id|null),
// onMovePoint(id, xp, yp, "start" | "move" | "end"), onMeasure([{ xp, yp }]), onCursor({ x, y } page point | null, event).
// Drawing hooks: onOverlay(ctx, view) draws over the sheet (screen pixels; view.toScreen(x, y)), onLoupe(ctx, loupe)
// draws in the loupe ({ cx, cy, R, toLoupe(x, y) }). The loupe can be turned off (loupe = false).
//
// The source is a canvas, or a virtual one { width, height, draw(ctx, sx, sy, sw, sh, dx, dy, dw, dh) } that draws the
// part [sx, sx + sw) x [sy, sy + sh) of itself (source pixels) into the screen rectangle: the mosaic pane draws its
// placed views that way, with no single canvas and no size limit.

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const HANDLE_HIT = 9;
const PIN_HIT = 14;

export class SheetView {
  constructor(host, canvas) {
    this.host = host;
    this.cv = canvas;
    this.ctx = canvas.getContext("2d");
    this.dpr = Math.max(1, window.devicePixelRatio || 1);
    this.w = 0;
    this.h = 0;
    this.src = null;
    this.z = 1; this.tx = 0; this.ty = 0; this.fitZ = 1;
    this.mode = "view";
    this.page = { w: 0, h: 0 };
    this.crop = null; this.cropEditable = false; this.cropDim = false;
    this.pins = []; this.pending = null; this.ghost = null;
    this.guides = null; // { cuts: [x pt], baseline: y pt | null, x0, x1 }: where a chained sheet is cut, and its road row
    this.measure = [];
    this.hoverId = null; this.selId = null;
    this.cursor = null; this.drag = null; this.spaceDown = false; this.userMoved = false;
    this.onCrop = this.onPick = this.onSelect = this.onHover = this.onMovePoint = this.onMeasure = this.onCursor = null;
    this.onOverlay = this.onLoupe = this.onCropClick = null;
    this.loupe = true;
    this.loupeIn = ["pick"]; // the modes that show it (the mosaic clipper adds "crop")
    this._raf = 0;
    this._needFit = false;
    this.detailSrc = null; // { render(rect, dpi, signal) -> Promise<{ canvas, crop, dpi }>, maxDpi() }
    this.detail = null; // { canvas, crop, dpi }: the sharp part in view
    this._detailTimer = 0; this._detailAbort = null; this._detailWant = "";
    this.readColors();
    this._bind();
    this._ro = new ResizeObserver(() => this.resize());
    this._ro.observe(host);
    this.resize();
  }

  destroy() {
    this.dropDetail();
    this.pyr?.destroy();
    this._ro.disconnect();
    cancelAnimationFrame(this._raf);
    this.cv.replaceWith(this.cv.cloneNode(false)); // drops the listeners
  }

  // Colors come from the page's Calcite tokens, so the pane follows the rest of the viewer.
  readColors() {
    const cs = getComputedStyle(document.documentElement);
    const token = (n, fallback) => cs.getPropertyValue(n).trim() || fallback;
    this.colors = {
      brand: token("--calcite-color-brand", "#007ac2"),
      ink: token("--calcite-color-text-1", "#151515"),
      ok: token("--calcite-color-status-success", "#35ac46"),
      warn: token("--calcite-color-status-warning", "#edd317"),
      bad: token("--calcite-color-status-danger", "#d83020"),
      dim: token("--calcite-color-text-3", "#6a6a6a"),
      surface: token("--calcite-color-foreground-2", "#f3f3f3"),
    };
    this.requestDraw();
  }

  // ---- geometry
  get k0() { return this.src ? this.src.k0 : 1; }
  get k() { return this.z / this.k0; } // screen pixels per source pixel
  toScreen(xp, yp) { return { x: this.tx + this.z * xp, y: this.ty + this.z * yp }; }
  toPt(x, y) { return { x: (x - this.tx) / this.z, y: (y - this.ty) / this.z }; }
  imgRect() {
    const s = this.src;
    return { x: this.tx + this.z * s.ox, y: this.ty + this.z * s.oy, w: this.z * s.wPt, h: this.z * s.hPt };
  }
  insideImage(pt) {
    const s = this.src;
    return !!s && pt.x >= s.ox && pt.x <= s.ox + s.wPt && pt.y >= s.oy && pt.y <= s.oy + s.hPt;
  }

  // ---- source and view
  setSource(canvas, k0, ox, oy, keepView) {
    if (this.src?.canvas !== canvas && typeof canvas.draw === "function") {
      // a virtual source draws itself; nothing to cache
      this.pyr?.destroy();
      this.pyr = { draw: (ctx, sx, sy, sw, sh, dx, dy, dw, dh) => canvas.draw(ctx, sx, sy, sw, sh, dx, dy, dw, dh), dropTiles() {}, destroy() {} };
    } else if (this.src?.canvas !== canvas) {
      this.pyr?.destroy();
      const pyr = (this.pyr = new SheetPyramid(canvas));
      // make the coarser levels while the page is idle, one at a time, so the first zoom out doesn't wait for them
      const idle = window.requestIdleCallback ?? ((fn) => setTimeout(fn, 50));
      const next = (i) => idle(() => { if (this.pyr === pyr && i < pyr.sizes.length) { pyr.level(i); next(i + 1); } });
      next(1);
    }
    if (this.src?.canvas !== canvas) this.dropDetail();
    this.src = { canvas, k0, ox, oy, wPt: canvas.width / k0, hPt: canvas.height / k0 };
    if (keepView && this.fitZ > 0) this.requestDraw();
    else this.fit();
  }
  // Frees what can be made again (the pyramid's cached tiles), before memory-heavy work.
  trimMemory() { this.pyr?.dropTiles(); }
  clearSource() { this.dropDetail(); this.pyr?.destroy(); this.pyr = null; this.src = null; this.requestDraw(); }

  // ---- the sharp part
  setDetail(src) { this.detailSrc = src; this.dropDetail(); this.requestDraw(); }
  dropDetail() {
    clearTimeout(this._detailTimer);
    this._detailAbort?.abort();
    this._detailAbort = null;
    this._detailWant = "";
    if (this.detail) { this.detail.canvas.width = this.detail.canvas.height = 0; this.detail = null; }
  }
  // After a draw: is the view finer than the source and the sharp part (if any)? Then a render of what is in view, with a
  // margin, at the screen's resolution, once the view has been still for a moment.
  _wantDetail() {
    const s = this.src, D = this.detailSrc;
    if (!s || !D || this.w < 10) return;
    const srcDpi = s.k0 * 72, maxDpi = Math.min(D.maxDpi(), 1200);
    const dpi = Math.min(maxDpi, this.z * 72 * this.dpr);
    if (dpi < srcDpi * 1.2) return; // the source is about as sharp
    const a = this.toPt(0, 0), b = this.toPt(this.w, this.h), mx = (b.x - a.x) * 0.25, my = (b.y - a.y) * 0.25;
    const rect = {
      x0: Math.max(s.ox, a.x - mx), y0: Math.max(s.oy, a.y - my),
      x1: Math.min(s.ox + s.wPt, b.x + mx), y1: Math.min(s.oy + s.hPt, b.y + my),
    };
    if (rect.x1 - rect.x0 < 1 || rect.y1 - rect.y0 < 1) return;
    const d = this.detail;
    if (d && d.crop.x0 <= Math.max(s.ox, a.x) && d.crop.y0 <= Math.max(s.oy, a.y) && d.crop.x1 >= Math.min(s.ox + s.wPt, b.x)
      && d.crop.y1 >= Math.min(s.oy + s.hPt, b.y) && d.dpi >= dpi * 0.8 && d.dpi <= dpi * 1.6) return; // still good
    const fit = Math.min(1, 4096 / ((rect.x1 - rect.x0) * dpi / 72), 4096 / ((rect.y1 - rect.y0) * dpi / 72));
    const want = { rect, dpi: dpi * fit };
    const key = JSON.stringify(want);
    if (key === this._detailWant) return;
    clearTimeout(this._detailTimer);
    this._detailTimer = setTimeout(() => this._renderDetail(want, key), 250);
  }
  async _renderDetail({ rect, dpi }, key) {
    this._detailAbort?.abort();
    const abort = (this._detailAbort = new AbortController()), src = this.src;
    this._detailWant = key;
    let out;
    try {
      out = await this.detailSrc.render(rect, dpi, abort.signal);
    } catch (err) {
      if (err?.name !== "AbortError") console.warn("The close-up render failed; the working render is shown.", err);
      if (this._detailWant === key) this._detailWant = "";
      return;
    }
    if (abort.signal.aborted || this.src !== src) { out.canvas.width = out.canvas.height = 0; return; }
    // a plain canvas (the render's is kept in memory to be read back; this one only needs drawing, fast)
    const canvas = Object.assign(document.createElement("canvas"), { width: out.canvas.width, height: out.canvas.height });
    canvas.getContext("2d").drawImage(out.canvas, 0, 0);
    out.canvas.width = out.canvas.height = 0;
    if (this.detail) this.detail.canvas.width = this.detail.canvas.height = 0;
    this.detail = { canvas, crop: { ...rect }, dpi };
    this._detailAbort = null;
    this.requestDraw();
  }
  // Draws the sharp part's share of the page rectangle [px, px + pw] x [py, py + ph] (points) into [dx, dy, dw, dh].
  _drawDetail(ctx, px, py, pw, ph, dx, dy, dw, dh) {
    const d = this.detail;
    if (!d) return;
    const x0 = Math.max(px, d.crop.x0), y0 = Math.max(py, d.crop.y0), x1 = Math.min(px + pw, d.crop.x1), y1 = Math.min(py + ph, d.crop.y1);
    if (x1 <= x0 || y1 <= y0) return;
    const kx = d.canvas.width / (d.crop.x1 - d.crop.x0), ky = d.canvas.height / (d.crop.y1 - d.crop.y0);
    const fx = dw / pw, fy = dh / ph;
    ctx.drawImage(d.canvas, (x0 - d.crop.x0) * kx, (y0 - d.crop.y0) * ky, (x1 - x0) * kx, (y1 - y0) * ky,
      dx + (x0 - px) * fx, dy + (y0 - py) * fy, (x1 - x0) * fx, (y1 - y0) * fy);
  }

  fit(pad = 28) {
    if (!this.src) return;
    if (this.w < 10 || this.h < 10) { this._needFit = true; return; }
    this._needFit = false;
    this.userMoved = false;
    const s = this.src;
    this.fitZ = Math.min((this.w - 2 * pad) / s.wPt, (this.h - 2 * pad) / s.hPt);
    this.z = this.fitZ;
    this.tx = (this.w - s.wPt * this.z) / 2 - s.ox * this.z;
    this.ty = (this.h - s.hPt * this.z) / 2 - s.oy * this.z;
    this.requestDraw();
  }
  zoomAt(x, y, f) {
    if (!this.src) return;
    const z1 = clamp(this.z * f, this.fitZ * 0.4, 70 * this.k0);
    const r = z1 / this.z;
    this.tx = x - (x - this.tx) * r;
    this.ty = y - (y - this.ty) * r;
    this.z = z1;
    this.userMoved = true;
    this.requestDraw();
  }
  zoomBy(f) { this.zoomAt(this.w / 2, this.h / 2, f); }
  // Bring a page point into view; zoom in to at least minK screen pixels per source pixel when given.
  focus(xp, yp, minK) {
    if (!this.src || this.w < 10) return;
    if (minK && this.k < minK) this.z = minK * this.k0;
    const p = this.toScreen(xp, yp);
    const m = 70;
    if (p.x < m || p.x > this.w - m || p.y < m || p.y > this.h - m || minK) {
      this.tx = this.w / 2 - this.z * xp;
      this.ty = this.h / 2 - this.z * yp;
      this.userMoved = true;
    }
    this.requestDraw();
  }

  resize() {
    const r = this.host.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return; // hidden: keep the view as it is
    const ow = this.w, oh = this.h;
    this.w = r.width;
    this.h = r.height;
    this.dpr = Math.max(1, window.devicePixelRatio || 1);
    this.cv.width = Math.round(r.width * this.dpr);
    this.cv.height = Math.round(r.height * this.dpr);
    if (!this.src) { this.requestDraw(); return; }
    if (!ow || this._needFit || !this.userMoved) this.fit();
    else {
      this.tx += (this.w - ow) / 2;
      this.ty += (this.h - oh) / 2;
      this.requestDraw();
    }
  }
  requestDraw() { if (!this._raf) this._raf = requestAnimationFrame(() => { this._raf = 0; this.draw(); }); }

  // ---- state setters
  setMode(m) { this.mode = m; this.drag = null; this.updateCursor(); this.requestDraw(); }
  setPage(w, h) { this.page = { w, h }; }
  // editable: handles on and draggable (crop mode); dim: show the crop outline in other modes too.
  setCrop(c, editable, dim) { this.crop = c ? { ...c } : null; this.cropEditable = !!editable; this.cropDim = !!dim; this.requestDraw(); }
  setPins(list) { this.pins = list; this.requestDraw(); }
  setPending(p) { this.pending = p; this.requestDraw(); }
  setGhost(p) { this.ghost = p; this.requestDraw(); }
  setGuides(g) { this.guides = g; this.requestDraw(); }
  setHover(id) { this.hoverId = id; this.requestDraw(); }
  setSel(id) { this.selId = id; this.requestDraw(); }
  clearMeasure() { this.measure = []; this.requestDraw(); }

  // ---- drawing
  draw() {
    const ctx = this.ctx, w = this.w, h = this.h;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const s = this.src;
    if (!s || w < 2) return;
    const r = this.imgRect();
    ctx.fillStyle = "#fff";
    ctx.fillRect(r.x, r.y, r.w, r.h);
    const k = r.w / s.canvas.width; // screen pixels per source pixel
    const vx0 = Math.max(0, r.x), vy0 = Math.max(0, r.y), vx1 = Math.min(w, r.x + r.w), vy1 = Math.min(h, r.y + r.h);
    if (vx1 > vx0 && vy1 > vy0) {
      ctx.imageSmoothingEnabled = k < 2.5;
      ctx.imageSmoothingQuality = k < 1 ? "high" : "medium";
      this.pyr.draw(ctx, (vx0 - r.x) / k, (vy0 - r.y) / k, (vx1 - vx0) / k, (vy1 - vy0) / k, vx0, vy0, vx1 - vx0, vy1 - vy0);
      if (this.detail && this.detail.dpi > s.k0 * 72) {
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        const a = this.toPt(vx0, vy0), b = this.toPt(vx1, vy1);
        this._drawDetail(ctx, a.x, a.y, b.x - a.x, b.y - a.y, vx0, vy0, vx1 - vx0, vy1 - vy0);
      }
      this._wantDetail();
    }
    ctx.strokeStyle = "rgba(0,0,0,.3)";
    ctx.lineWidth = 1;
    ctx.strokeRect(r.x - 0.5, r.y - 0.5, r.w + 1, r.h + 1);

    if (this.crop && (this.mode === "crop" || this.cropDim)) this.drawCrop(ctx, r);
    this.drawMeasure(ctx);
    this.drawGuides(ctx, r);
    this.pins.forEach((p) => this.drawPin(ctx, p));
    if (this.onOverlay) { ctx.save(); this.onOverlay(ctx, this); ctx.restore(); }
    if (this.ghost) this.drawPin(ctx, { xp: this.ghost.xp, yp: this.ghost.yp, label: this.ghost.label || "", ghost: true });
    if (this.pending) this.drawPin(ctx, { xp: this.pending.xp, yp: this.pending.yp, label: this.pending.label || "", pending: true });
    this.drawLoupe(ctx);
  }

  cropScreen() {
    if (!this.crop) return null;
    const a = this.toScreen(this.crop.x0, this.crop.y0), b = this.toScreen(this.crop.x1, this.crop.y1);
    return { x0: a.x, y0: a.y, x1: b.x, y1: b.y };
  }
  handleSpots(c) {
    const mx = (c.x0 + c.x1) / 2, my = (c.y0 + c.y1) / 2;
    return [
      { id: "nw", x: c.x0, y: c.y0 }, { id: "ne", x: c.x1, y: c.y0 }, { id: "se", x: c.x1, y: c.y1 }, { id: "sw", x: c.x0, y: c.y1 },
      { id: "n", x: mx, y: c.y0 }, { id: "e", x: c.x1, y: my }, { id: "s", x: mx, y: c.y1 }, { id: "w", x: c.x0, y: my },
    ];
  }
  drawCrop(ctx, r) {
    const c = this.cropScreen();
    ctx.save();
    ctx.beginPath();
    ctx.rect(r.x, r.y, r.w, r.h);
    ctx.rect(c.x0, c.y0, c.x1 - c.x0, c.y1 - c.y0);
    ctx.fillStyle = "rgba(20,20,20,.45)";
    ctx.fill("evenodd");
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = this.colors.brand;
    ctx.strokeRect(c.x0, c.y0, c.x1 - c.x0, c.y1 - c.y0);
    if (this.cropEditable) {
      for (const hp of this.handleSpots(c)) {
        ctx.fillStyle = this.colors.brand;
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.rect(hp.x - 4.5, hp.y - 4.5, 9, 9);
        ctx.fill();
        ctx.stroke();
      }
    }
    const label = `${((this.crop.x1 - this.crop.x0) / 72).toFixed(2)} × ${((this.crop.y1 - this.crop.y0) / 72).toFixed(2)} in`;
    ctx.font = `600 12px ${getComputedStyle(document.body).fontFamily}`;
    const tw = ctx.measureText(label).width + 14;
    const lx = c.x0 + 8, ly = Math.max(c.y0 + 8, 8);
    ctx.fillStyle = "rgba(20,20,20,.8)";
    ctx.fillRect(lx, ly, tw, 22);
    ctx.fillStyle = "#fff";
    ctx.textBaseline = "middle";
    ctx.fillText(label, lx + 7, ly + 11.5);
    ctx.restore();
  }

  drawPin(ctx, p) {
    const c = this.colors;
    const q = this.toScreen(p.xp, p.yp);
    if (q.x < -40 || q.y < -40 || q.x > this.w + 40 || q.y > this.h + 40) return;
    const sel = p.id != null && p.id === this.selId;
    const hov = p.id != null && p.id === this.hoverId;
    const col = p.ghost ? c.dim : p.off ? c.dim : c.brand;
    const r = sel || hov ? 12 : 9.5;
    ctx.save();
    const strokeBoth = (fn) => {
      ctx.lineWidth = 4; ctx.strokeStyle = "rgba(255,255,255,.9)"; fn();
      ctx.lineWidth = 1.7; ctx.strokeStyle = col; fn();
    };
    if (p.pending || p.ghost) ctx.setLineDash([4, 3]);
    strokeBoth(() => { ctx.beginPath(); ctx.arc(q.x, q.y, r, 0, Math.PI * 2); ctx.stroke(); });
    ctx.setLineDash([]);
    strokeBoth(() => {
      ctx.beginPath();
      ctx.moveTo(q.x - r - 6, q.y); ctx.lineTo(q.x - 3, q.y); ctx.moveTo(q.x + 3, q.y); ctx.lineTo(q.x + r + 6, q.y);
      ctx.moveTo(q.x, q.y - r - 6); ctx.lineTo(q.x, q.y - 3); ctx.moveTo(q.x, q.y + 3); ctx.lineTo(q.x, q.y + r + 6);
      ctx.stroke();
    });
    // the residual dot: the verdict color for this point (the only color besides the brand)
    const dot = p.res === "ok" ? c.ok : p.res === "warn" ? c.warn : p.res === "bad" ? c.bad : col;
    ctx.fillStyle = dot; ctx.strokeStyle = "#fff"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(q.x, q.y, 2.6, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    if (p.label) {
      ctx.font = `700 12px ${getComputedStyle(document.body).fontFamily}`;
      const tw = Math.max(18, ctx.measureText(p.label).width + 10), tx = q.x + r + 3, ty = q.y - r - 20;
      ctx.fillStyle = sel ? col : "rgba(255,255,255,.95)"; ctx.strokeStyle = col; ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.rect(tx, ty, tw, 18); ctx.fill(); ctx.stroke();
      ctx.fillStyle = sel ? "#fff" : c.ink; ctx.textBaseline = "middle"; ctx.textAlign = "center";
      ctx.fillText(p.label, tx + tw / 2, ty + 9.5);
    }
    ctx.restore();
  }

  // Dashed lines: the piece cuts (vertical, the full height of the image) and the road row (horizontal).
  drawGuides(ctx, r) {
    const g = this.guides;
    if (!g) return;
    ctx.save();
    ctx.setLineDash([6, 4]);
    const line = (x0, y0, x1, y1, color) => {
      ctx.lineWidth = 3; ctx.strokeStyle = "rgba(255,255,255,.8)";
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
      ctx.lineWidth = 1.2; ctx.strokeStyle = color;
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
    };
    for (const x of g.cuts ?? []) { const q = this.toScreen(x, 0); line(q.x, r.y, q.x, r.y + r.h, this.colors.brand); }
    if (Number.isFinite(g.baseline)) {
      const a = this.toScreen(g.x0 ?? 0, g.baseline), b = this.toScreen(g.x1 ?? this.page.w, g.baseline);
      line(a.x, a.y, b.x, b.y, this.colors.dim);
    }
    ctx.restore();
  }

  drawMeasure(ctx) {
    if (!this.measure.length) return;
    const pts = this.measure.map((m) => this.toScreen(m.xp, m.yp));
    ctx.save();
    ctx.strokeStyle = this.colors.brand; ctx.fillStyle = this.colors.brand; ctx.lineWidth = 2;
    if (pts.length === 2) { ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y); ctx.lineTo(pts[1].x, pts[1].y); ctx.stroke(); }
    for (const p of pts) {
      ctx.beginPath(); ctx.arc(p.x, p.y, 4.5, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = "#fff"; ctx.lineWidth = 1.2; ctx.stroke();
    }
    ctx.restore();
  }

  // A round magnifier beside the cursor while picking, so a corner can be hit exactly.
  drawLoupe(ctx) {
    if (!this.loupeIn.includes(this.mode) || !this.loupe || !this.cursor || !this.src) return;
    // not while the sheet is panned; in pick mode not while anything is dragged (as before); framing a crop shows it
    if (this.drag && (this.mode === "pick" || this.drag.kind === "pan")) return;
    const R = 68, k = this.k, Z = Math.max(6, k * 4);
    let cx = this.cursor.x + R + 28, cy = this.cursor.y - R - 28;
    if (cx + R > this.w - 6) cx = this.cursor.x - R - 28;
    if (cy - R < 6) cy = this.cursor.y + R + 28;
    const r = this.imgRect();
    const u = (this.cursor.x - r.x) / k, v = (this.cursor.y - r.y) / k;
    ctx.save();
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.clip();
    ctx.fillStyle = "#fff"; ctx.fillRect(cx - R, cy - R, 2 * R, 2 * R);
    ctx.imageSmoothingEnabled = false;
    this.pyr.draw(ctx, u - R / Z, v - R / Z, (2 * R) / Z, (2 * R) / Z, cx - R, cy - R, 2 * R, 2 * R, 0); // the render's own pixels
    if (this.detail && this.detail.dpi > this.k0 * 72) {
      const k0 = this.k0;
      this._drawDetail(ctx, this.src.ox + (u - R / Z) / k0, this.src.oy + (v - R / Z) / k0, (2 * R) / Z / k0, (2 * R) / Z / k0, cx - R, cy - R, 2 * R, 2 * R);
    }
    if (this.onLoupe) {
      // page point -> loupe pixel: the cursor's point is the loupe's centre, Z screen pixels per source pixel
      const at = this.toPt(this.cursor.x, this.cursor.y), f = Z * this.k0;
      this.onLoupe(ctx, { cx, cy, R, toLoupe: (x, y) => ({ x: cx + (x - at.x) * f, y: cy + (y - at.y) * f }) });
    }
    ctx.restore();
    ctx.save();
    ctx.lineWidth = 3; ctx.strokeStyle = "rgba(0,0,0,.4)"; ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();
    ctx.lineWidth = 1.5; ctx.strokeStyle = this.colors.brand; ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx - R + 8, cy); ctx.lineTo(cx - 5, cy); ctx.moveTo(cx + 5, cy); ctx.lineTo(cx + R - 8, cy);
    ctx.moveTo(cx, cy - R + 8); ctx.lineTo(cx, cy - 5); ctx.moveTo(cx, cy + 5); ctx.lineTo(cx, cy + R - 8);
    ctx.stroke();
    ctx.restore();
  }

  // ---- interaction
  _bind() {
    const cv = this.cv;
    cv.addEventListener("pointerdown", (e) => this._down(e));
    cv.addEventListener("pointermove", (e) => this._move(e));
    cv.addEventListener("pointerup", (e) => this._up(e));
    cv.addEventListener("pointercancel", (e) => this._up(e));
    cv.addEventListener("pointerleave", () => {
      if (!this.drag) {
        this.cursor = null;
        this.requestDraw();
        if (this.hoverId != null) { this.hoverId = null; this.onHover?.(null); }
      }
      this.onCursor?.(null);
    });
    cv.addEventListener("wheel", (e) => this._wheel(e), { passive: false });
    cv.addEventListener("contextmenu", (e) => e.preventDefault());
  }
  _pos(e) {
    const r = this.cv.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }
  hitCrop(x, y) {
    const c = this.cropScreen();
    if (!c) return null;
    if (this.cropEditable) for (const hp of this.handleSpots(c)) if (Math.abs(x - hp.x) <= HANDLE_HIT && Math.abs(y - hp.y) <= HANDLE_HIT) return hp.id;
    if (x > c.x0 && x < c.x1 && y > c.y0 && y < c.y1) return "move";
    return null;
  }
  hitPin(x, y) {
    for (let i = this.pins.length - 1; i >= 0; i--) {
      const p = this.pins[i], q = this.toScreen(p.xp, p.yp);
      if (Math.hypot(x - q.x, y - q.y) < PIN_HIT) return p;
    }
    return null;
  }
  clampPt(pt) { return { x: clamp(pt.x, 0, this.page.w), y: clamp(pt.y, 0, this.page.h) }; }
  norm(x0, y0, x1, y1) { return normCrop(x0, y0, x1, y1, this.page.w, this.page.h); }

  updateCursor(p) {
    let cur = "grab";
    if (this.spaceDown) cur = "grab";
    else if (this.mode === "pick" || this.mode === "measure") cur = "crosshair";
    else if (this.mode === "crop") {
      cur = "crosshair";
      if (p && this.crop) {
        const map = { nw: "nwse-resize", se: "nwse-resize", ne: "nesw-resize", sw: "nesw-resize", n: "ns-resize", s: "ns-resize", e: "ew-resize", w: "ew-resize", move: "move" };
        const hit = this.hitCrop(p.x, p.y);
        if (hit) cur = map[hit];
      }
    }
    if (this.drag && this.drag.kind === "pan") cur = "grabbing";
    this.cv.style.cursor = cur;
  }

  _down(e) {
    if (!this.src) return;
    const p = this._pos(e);
    this.cv.setPointerCapture(e.pointerId);
    const d = (this.drag = { pid: e.pointerId, x0: p.x, y0: p.y, tx0: this.tx, ty0: this.ty, moved: false, button: e.button, kind: null });
    if (e.button === 1 || e.button === 2 || this.spaceDown) { d.kind = "pan"; this.updateCursor(); return; }
    if (e.button !== 0) return;
    if (this.mode === "crop") {
      const hit = this.crop && this.hitCrop(p.x, p.y);
      if (hit) {
        d.kind = hit === "move" ? "cropMove" : "cropHandle";
        d.handle = hit; d.crop0 = { ...this.crop }; d.pt0 = this.toPt(p.x, p.y);
        return;
      }
      d.kind = "cropNew";
      d.anchor = this.clampPt(this.toPt(p.x, p.y));
      return;
    }
    if (this.mode === "pick") {
      const hp = this.hitPin(p.x, p.y);
      if (hp) {
        const pt = this.toPt(p.x, p.y);
        d.kind = "pin"; d.pinId = hp.id; d.started = false; d.off = { x: pt.x - hp.xp, y: pt.y - hp.yp };
        this.onSelect?.(hp.id);
        return;
      }
      d.kind = "pickOrPan";
      return;
    }
    d.kind = this.mode === "measure" ? "measureOrPan" : "pan";
  }

  _move(e) {
    const p = this._pos(e);
    this.cursor = p;
    const d = this.drag;
    if (d && d.pid === e.pointerId) {
      const dx = p.x - d.x0, dy = p.y - d.y0;
      if (!d.moved && Math.hypot(dx, dy) > 4) d.moved = true;
      if ((d.kind === "pickOrPan" || d.kind === "measureOrPan") && d.moved) d.kind = "pan";
      switch (d.kind) {
        case "pan":
          this.tx = d.tx0 + dx; this.ty = d.ty0 + dy; this.userMoved = true; this.updateCursor();
          break;
        case "cropNew":
          if (d.moved) {
            const q = this.clampPt(this.toPt(p.x, p.y));
            this.crop = this.norm(d.anchor.x, d.anchor.y, q.x, q.y);
            this.onCrop?.(this.crop, false, d.kind);
          }
          break;
        case "cropMove": {
          const q = this.toPt(p.x, p.y), c0 = d.crop0, cw = c0.x1 - c0.x0, ch = c0.y1 - c0.y0;
          const nx = clamp(c0.x0 + (q.x - d.pt0.x), 0, this.page.w - cw), ny = clamp(c0.y0 + (q.y - d.pt0.y), 0, this.page.h - ch);
          this.crop = { x0: nx, y0: ny, x1: nx + cw, y1: ny + ch };
          this.onCrop?.(this.crop, false, d.kind);
          break;
        }
        case "cropHandle": {
          const q = this.toPt(p.x, p.y), hd = d.handle;
          let { x0, y0, x1, y1 } = d.crop0;
          if (hd.includes("w")) x0 = q.x;
          if (hd.includes("e")) x1 = q.x;
          if (hd.includes("n")) y0 = q.y;
          if (hd.includes("s")) y1 = q.y;
          this.crop = this.norm(x0, y0, x1, y1);
          this.onCrop?.(this.crop, false, d.kind);
          break;
        }
        case "pin":
          if (d.moved) {
            const q = this.toPt(p.x, p.y);
            if (!d.started) { d.started = true; this.onMovePoint?.(d.pinId, null, null, "start"); }
            this.onMovePoint?.(d.pinId, q.x - d.off.x, q.y - d.off.y, "move");
          }
          break;
        default:
          break;
      }
    } else {
      this.updateCursor(p);
      const hp = this.mode === "pick" ? this.hitPin(p.x, p.y) : null;
      const id = hp ? hp.id : null;
      if (id !== this.hoverId) { this.hoverId = id; this.onHover?.(id); }
    }
    const pt = this.toPt(p.x, p.y);
    this.onCursor?.(this.insideImage(pt) ? pt : null, e);
    this.requestDraw();
  }

  _up(e) {
    const d = this.drag;
    if (!d || d.pid !== e.pointerId) return;
    this.drag = null;
    try { this.cv.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    if (d.kind === "pickOrPan" && !d.moved && d.button === 0) {
      const pt = this.toPt(d.x0, d.y0);
      if (this.insideImage(pt)) this.onPick?.(pt.x, pt.y, e);
    } else if (d.kind === "measureOrPan" && !d.moved) {
      const pt = this.toPt(d.x0, d.y0);
      if (this.measure.length >= 2) this.measure = [];
      this.measure.push({ xp: pt.x, yp: pt.y });
      this.onMeasure?.(this.measure.slice());
    } else if (d.kind === "pin" && d.started) {
      this.onMovePoint?.(d.pinId, null, null, "end");
    } else if (d.kind === "cropNew" && !d.moved) {
      // a plain click draws nothing; it can pick something drawn by onOverlay (the clipper's boxes)
      this.onCropClick?.(this.toPt(d.x0, d.y0));
    } else if (d.kind === "cropNew" || d.kind === "cropMove" || d.kind === "cropHandle") {
      this.onCrop?.(this.crop, true, d.kind);
    }
    this.updateCursor(this._pos(e));
    this.requestDraw();
  }

  _wheel(e) {
    if (!this.src) return;
    e.preventDefault();
    const p = this._pos(e);
    const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 120 : e.deltaY;
    this.zoomAt(p.x, p.y, Math.exp(-dy * (e.ctrlKey ? 0.012 : 0.0018)));
  }
}
