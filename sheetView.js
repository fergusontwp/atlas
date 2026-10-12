import { normCrop } from "./cropMath.js";

// The sheet pane's canvas: shows the plan page (or the rendered crop of it) and lets you pan, zoom, frame the crop,
// pick control points, drag them, measure a known distance and use a loupe. Canvas only; no SDK. A smaller rebuild of
// PlanView from georeferencer/js/app/10-plan-view.js (no mip levels: the browser scales the canvas, which is fast
// enough so far).
//
// View transform:  screen = t + z * (page point), z in screen pixels per PDF point. The source canvas covers the page
// rectangle [ox, ox + width / k0] x [oy, oy + height / k0], k0 being its own pixels per point.
//
// Modes: "view" (pan and zoom), "crop" (drag a rectangle; handles resize it), "pick" (click to place a point, drag a
// pin to move it, loupe on), "measure" (two clicks measure a distance). Middle or right button, or Space + drag, always pans.
//
// Callbacks (assign what you need): onCrop(crop, final), onPick(xp, yp), onSelect(id), onHover(id|null),
// onMovePoint(id, xp, yp, "start" | "move" | "end"), onMeasure([{ xp, yp }]), onCursor({ x, y } page point | null).

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
    this.measure = [];
    this.hoverId = null; this.selId = null;
    this.cursor = null; this.drag = null; this.spaceDown = false; this.userMoved = false;
    this.onCrop = this.onPick = this.onSelect = this.onHover = this.onMovePoint = this.onMeasure = this.onCursor = null;
    this._raf = 0;
    this._needFit = false;
    this.readColors();
    this._bind();
    this._ro = new ResizeObserver(() => this.resize());
    this._ro.observe(host);
    this.resize();
  }

  destroy() {
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
    this.src = { canvas, k0, ox, oy, wPt: canvas.width / k0, hPt: canvas.height / k0 };
    if (keepView && this.fitZ > 0) this.requestDraw();
    else this.fit();
  }
  clearSource() { this.src = null; this.requestDraw(); }

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
      ctx.drawImage(s.canvas, (vx0 - r.x) / k, (vy0 - r.y) / k, (vx1 - vx0) / k, (vy1 - vy0) / k, vx0, vy0, vx1 - vx0, vy1 - vy0);
    }
    ctx.strokeStyle = "rgba(0,0,0,.3)";
    ctx.lineWidth = 1;
    ctx.strokeRect(r.x - 0.5, r.y - 0.5, r.w + 1, r.h + 1);

    if (this.crop && (this.mode === "crop" || this.cropDim)) this.drawCrop(ctx, r);
    this.drawMeasure(ctx);
    this.pins.forEach((p) => this.drawPin(ctx, p));
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
    if (this.mode !== "pick" || !this.cursor || this.drag || !this.src) return;
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
    ctx.drawImage(this.src.canvas, u - R / Z, v - R / Z, (2 * R) / Z, (2 * R) / Z, cx - R, cy - R, 2 * R, 2 * R);
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
            this.onCrop?.(this.crop, false);
          }
          break;
        case "cropMove": {
          const q = this.toPt(p.x, p.y), c0 = d.crop0, cw = c0.x1 - c0.x0, ch = c0.y1 - c0.y0;
          const nx = clamp(c0.x0 + (q.x - d.pt0.x), 0, this.page.w - cw), ny = clamp(c0.y0 + (q.y - d.pt0.y), 0, this.page.h - ch);
          this.crop = { x0: nx, y0: ny, x1: nx + cw, y1: ny + ch };
          this.onCrop?.(this.crop, false);
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
          this.onCrop?.(this.crop, false);
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
    this.onCursor?.(this.insideImage(pt) ? pt : null);
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
      // a plain click does nothing
    } else if (d.kind === "cropNew" || d.kind === "cropMove" || d.kind === "cropHandle") {
      this.onCrop?.(this.crop, true);
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
