/* joinSeam.js
 *
 * Join the next plan view to the last placed view at a seam, from geometry instead of overlap.
 * Pure functions, no DOM, no libraries. An ES module: the Atlas port of reference/plan-tools/join/join-seam.js (the
 * prototype), with the same code and API; the thresholds come from MOSAIC.SEAM in config.js (same values).
 *
 * The idea (see the sketch in the SITREP):
 *   - Road lines fix the ROTATION and the CROSS-ROAD position: each line in the next view must continue the same line
 *     in the last view.
 *   - Along the road, parallel lines match anywhere. The ALONG-ROAD position comes from one of:
 *       a shared point (the same tick or feature in both views),
 *       the station difference between a tick in each view (works with no overlap at all), or
 *       an overlap match that searches ONLY along the road (rotation and cross position are already fixed).
 *   - Extra constraints become the accuracy check, reported in feet.
 *
 * Images: { w, h, data: Float32Array }, 0 = paper, 1 = dark line. See fromRGBA().
 * Coordinates: continuous pixel coordinates, pixel centres at +0.5 (the same as a canvas click), y down.
 *
 * Transform "rel" maps a point p of the NEXT view (R) into the LAST view (L):
 *     q = s * Rot(theta) * p + (tx, ty)          stored as { a: s cos, b: s sin, tx, ty }  (same as T() in plan-mosaic)
 *
 * Road direction: stationing runs left to right in every view, so the forward road direction of a view is the line
 * direction with a positive x component in that view's own pixels. That removes the 180 degree ambiguity.
 */
import { MOSAIC } from './config.js';


const DEG = Math.PI / 180;
const INK = MOSAIC.SEAM.INK;                          // ink threshold (gray CAD lines are about 0.4)
const TICK_INK = MOSAIC.SEAM.TICK_INK;                // station ticks are often thin light-gray strokes

/* ---------------- images ---------------- */
function img(w, h) { return { w: w, h: h, data: new Float32Array(w * h) }; }

function fromRGBA(rgba, w, h) {                       // alpha over white, ink = 1 - luminance
  const o = img(w, h), d = o.data;
  for (let i = 0, j = 0; i < w * h; i++, j += 4) {
    const a = rgba[j + 3] / 255, lum = (0.299 * rgba[j] + 0.587 * rgba[j + 1] + 0.114 * rgba[j + 2]) / 255;
    d[i] = 1 - (a * lum + 1 - a);
  }
  return o;
}

function fromGray(g, w, h) { const o = img(w, h); for (let i = 0; i < w * h; i++) o.data[i] = 1 - g[i] / 255; return o; }

function sample(s, x, y) {                            // bilinear, 0 outside
  x -= 0.5; y -= 0.5;
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0, w = s.w, h = s.h, d = s.data;
  if (x0 >= 0 && y0 >= 0 && x0 + 1 < w && y0 + 1 < h) {
    const i = y0 * w + x0;
    return (1 - fy) * ((1 - fx) * d[i] + fx * d[i + 1]) + fy * ((1 - fx) * d[i + w] + fx * d[i + w + 1]);
  }
  const g = (i, j) => (i < 0 || j < 0 || i >= w || j >= h) ? 0 : d[j * w + i];
  return (1 - fy) * ((1 - fx) * g(x0, y0) + fx * g(x0 + 1, y0)) + fy * ((1 - fx) * g(x0, y0 + 1) + fx * g(x0 + 1, y0 + 1));
}

function inside(s, x, y, m) { m = m || 0; return x >= m && y >= m && x <= s.w - m && y <= s.h - m; }

function boxDown(s, f) {                              // box average by integer factor f
  if (f <= 1) return s;
  const w = Math.floor(s.w / f), h = Math.floor(s.h / f), o = img(w, h), k = 1 / (f * f);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let a = 0;
    for (let j = 0; j < f; j++) { const r = (y * f + j) * s.w + x * f; for (let i = 0; i < f; i++) a += s.data[r + i]; }
    o.data[y * w + x] = a * k;
  }
  return o;
}

function blur(s, sigma) {                             // separable gaussian
  const r = Math.max(1, Math.ceil(sigma * 3)), k = [];
  let sum = 0;
  for (let i = -r; i <= r; i++) { const v = Math.exp(-i * i / (2 * sigma * sigma)); k.push(v); sum += v; }
  for (let i = 0; i < k.length; i++) k[i] /= sum;
  const w = s.w, h = s.h, t = new Float32Array(w * h), o = img(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let a = 0; for (let i = -r; i <= r; i++) { const xx = x + i; if (xx >= 0 && xx < w) a += k[i + r] * s.data[y * w + xx]; }
    t[y * w + x] = a;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let a = 0; for (let i = -r; i <= r; i++) { const yy = y + i; if (yy >= 0 && yy < h) a += k[i + r] * t[yy * w + x]; }
    o.data[y * w + x] = a;
  }
  return o;
}

/* ---------------- small geometry ---------------- */
const dot = (a, b) => a.x * b.x + a.y * b.y;
const fwd = d => (d.x < 0 || (d.x === 0 && d.y < 0)) ? { x: -d.x, y: -d.y } : { x: d.x, y: d.y };   // stationing runs left to right
const nrm = d => ({ x: -d.y, y: d.x });
const ang = d => Math.atan2(d.y, d.x);
const unit = a => ({ x: Math.cos(a), y: Math.sin(a) });
function wrapPi(a) { while (a > Math.PI) a -= 2 * Math.PI; while (a <= -Math.PI) a += 2 * Math.PI; return a; }

function T(t, p) { return { x: t.a * p.x - t.b * p.y + t.tx, y: t.b * p.x + t.a * p.y + t.ty }; }
function Tdir(t, d) { const s = Math.hypot(t.a, t.b); return { x: (t.a * d.x - t.b * d.y) / s, y: (t.b * d.x + t.a * d.y) / s }; }
function compose(A, B) {                              // A after B
  return { a: A.a * B.a - A.b * B.b, b: A.a * B.b + A.b * B.a, tx: A.a * B.tx - A.b * B.ty + A.tx, ty: A.b * B.tx + A.a * B.ty + A.ty };
}
function invert(t) {
  const m = t.a * t.a + t.b * t.b, a = t.a / m, b = -t.b / m;
  return { a: a, b: b, tx: -(a * t.tx - b * t.ty), ty: -(b * t.tx + a * t.ty) };
}

function tls(pts, wts) {                              // total least squares line: centroid + unit direction
  let sw = 0, cx = 0, cy = 0;
  for (let i = 0; i < pts.length; i++) { const w = wts ? wts[i] : 1; sw += w; cx += w * pts[i].x; cy += w * pts[i].y; }
  cx /= sw; cy /= sw;
  let sxx = 0, sxy = 0, syy = 0;
  for (let i = 0; i < pts.length; i++) {
    const w = wts ? wts[i] : 1, dx = pts[i].x - cx, dy = pts[i].y - cy;
    sxx += w * dx * dx; sxy += w * dx * dy; syy += w * dy * dy;
  }
  const th = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  return { c: { x: cx, y: cy }, d: fwd(unit(th)) };
}

/* ---------------- 1. snap a road line near a click ---------------- */
// Finds the long straight line that passes nearest the click, traces it both ways (across dashes and text breaks),
// stops at a bend, and fits it. Only the straight part around the click is used, so click near the seam.
function snapLine(im, click, o) {
  o = Object.assign({ seek: 6, win: 70, reach: 350, maxGap: 30, band: 2.5, bendTol: 1.5, maxWidth: 12, dirHint: null, dirTol: 30, thr: INK }, o || {});
  // seed: the longest continuous ink run through a point within `seek` px of the click. A road line runs through
  // the whole window; text strokes, ticks and hatch diagonals do not.
  const R = o.win, thrS = 0.6 * o.thr, hint = o.dirHint ? ang(fwd(o.dirHint)) : null;
  const runLen = (th, rho) => {
    const dx = Math.cos(th), dy = Math.sin(th), bx = click.x - dy * rho, by = click.y + dx * rho;
    let tot = 0, ink = 0;
    for (const sg of [1, -1]) {
      let miss = 0, last = 0;
      for (let t = 0; t <= R; t++) {
        const v = sample(im, bx + sg * dx * t, by + sg * dy * t);
        if (v >= thrS) { last = t; miss = 0; ink += v; } else if (++miss > 3) break;
      }
      tot += last;
    }
    return tot + 0.01 * ink;
  };
  let best = null;
  const tryAt = (th, rho) => {
    const sc = runLen(th, rho) * Math.exp(-0.5 * (rho / (0.8 * o.seek)) ** 2);
    if (!best || sc > best.s) best = { th: th, rho: rho, s: sc };
  };
  for (let t = -90; t < 90; t += 0.5) {
    const th = t * DEG;
    if (hint !== null && Math.abs(wrapPi(2 * (th - hint))) / 2 > o.dirTol * DEG) continue;
    for (let r = -o.seek; r <= o.seek; r += 0.5) tryAt(th, r);
  }
  if (!best || best.s < 15) return null;
  const b0 = best;
  for (let t = -0.6; t <= 0.6001; t += 0.1) for (let r = -0.75; r <= 0.7501; r += 0.25) tryAt(b0.th + t * DEG, b0.rho + r);
  let d = fwd(unit(best.th)), n = nrm(d);
  const p0 = { x: click.x + best.rho * n.x, y: click.y + best.rho * n.y };

  // trace
  const pts = [p0], step = 1.5;
  // Ink centre across the line near p: the run of ink (samples above the threshold) nearest the prediction, and
  // its ink-weighted centroid. A thick, double or stair-stepped line counts as one line; a separate neighbour does not.
  const peakAt = (p, nn) => {
    const K = Math.round((o.band + o.maxWidth / 2 + 1) * 4), vals = [];
    for (let k = -K; k <= K; k++) vals.push(sample(im, p.x + nn.x * k / 4, p.y + nn.y * k / 4));
    let best = null;
    for (let k = 0; k < vals.length;) {
      if (vals[k] < o.thr) { k++; continue; }
      let j = k, sw = 0, sk = 0;
      while (j < vals.length && vals[j] >= o.thr) { const w = vals[j] - 0.5 * o.thr; sw += w; sk += w * j; j++; }
      const c = (sk / sw - K) / 4, lo = (k - K) / 4, hi = (j - 1 - K) / 4;
      const dist = (lo <= 0 && hi >= 0) ? 0 : Math.min(Math.abs(lo), Math.abs(hi));
      if (dist <= o.band && (hi - lo) <= o.maxWidth && (!best || dist < best.dist || (dist === best.dist && Math.abs(c) < Math.abs(best.o)))) best = { o: c, dist: dist, v: sw };
      k = j;
    }
    return best;
  };
  let fit = { c: p0, d: d };
  const distTo = (p, f) => Math.abs(dot({ x: p.x - f.c.x, y: p.y - f.c.y }, nrm(f.d)));
  for (const sg of [1, -1]) {
    let pos = { x: p0.x, y: p0.y }, gap = 0, run = [], cnt = 0;
    for (;;) {
      const dd = { x: sg * fit.d.x, y: sg * fit.d.y }, nn = nrm(fit.d);
      // predict on the current fit, so a gap does not let the trace wander
      const along = dot({ x: pos.x + dd.x * step - fit.c.x, y: pos.y + dd.y * step - fit.c.y }, fit.d);
      pos = { x: fit.c.x + fit.d.x * along, y: fit.c.y + fit.d.y * along };
      if (!inside(im, pos.x, pos.y, 1) || Math.hypot(pos.x - p0.x, pos.y - p0.y) > o.reach) break;
      const pk = peakAt(pos, nn);
      if (!pk) { gap += step; if (gap > o.maxGap) break; continue; }
      gap = 0;
      const q = { x: pos.x + nn.x * pk.o, y: pos.y + nn.y * pk.o };
      pts.push(q); run.push(q); cnt++;
      if (cnt % 4 === 0) {
        const len = Math.hypot(q.x - p0.x, q.y - p0.y);
        if (len > 40 && run.length >= 12) {           // bend check: the last points drift to ONE side of the fit so far
          const nf = nrm(fit.d), tail = run.slice(-8);
          const md = tail.reduce((s, p) => s + dot({ x: p.x - fit.c.x, y: p.y - fit.c.y }, nf), 0) / tail.length;
          if (Math.abs(md) > o.bendTol) {             // drop the points back to where the drift started
            let k = run.length - 1;
            while (k > 0 && Math.abs(dot({ x: run[k].x - fit.c.x, y: run[k].y - fit.c.y }, nf)) > 0.5) k--;
            pts.splice(pts.length - (run.length - 1 - k), run.length - 1 - k);
            break;
          }
        }
        if (cnt % 8 === 0) fit = tls(pts);
      }
    }
  }
  if (pts.length < 12) return null;
  // robust final fit
  let use = pts.slice(), f = tls(use), rms = 0;
  for (let it = 0; it < 4; it++) {
    const r = use.map(p => distTo(p, f));
    rms = Math.sqrt(r.reduce((s, v) => s + v * v, 0) / r.length);
    const lim = Math.max(0.8, 2.5 * rms), keep = use.filter((p, i) => r[i] <= lim);
    if (keep.length === use.length || keep.length < 10) break;
    use = keep; f = tls(use);
  }
  // trim an end that curls away (a curve or curb return starting): the end's residuals all lean to one side
  for (let it = 0; it < 6 && use.length > 40; it++) {
    const al0 = use.map(p => dot({ x: p.x - f.c.x, y: p.y - f.c.y }, f.d)), lo = Math.min(...al0), hi = Math.max(...al0), cut = 0.12 * (hi - lo);
    const nf = nrm(f.d), sd = p => dot({ x: p.x - f.c.x, y: p.y - f.c.y }, nf);
    const endMean = sel => { const r = use.filter((p, i) => sel(al0[i])).map(sd); return { m: r.reduce((s, v) => s + v, 0) / Math.max(1, r.length), n: r.length }; };
    const eA = endMean(a => a < lo + cut), eB = endMean(a => a > hi - cut), lim = Math.max(0.35, 2.5 * rms / Math.sqrt(Math.max(1, Math.min(eA.n, eB.n))));
    const bad = Math.abs(eA.m) > lim || Math.abs(eB.m) > lim;
    if (!bad) break;
    const dropLo = Math.abs(eA.m) >= Math.abs(eB.m);
    use = use.filter((p, i) => dropLo ? al0[i] >= lo + cut : al0[i] <= hi - cut);
    f = tls(use);
    const r = use.map(p => distTo(p, f)); rms = Math.sqrt(r.reduce((s, v) => s + v * v, 0) / r.length);
  }
  const al = use.map(p => dot({ x: p.x - f.c.x, y: p.y - f.c.y }, f.d));
  const a0 = Math.min(...al), a1 = Math.max(...al);
  return { c: f.c, d: f.d, a0: a0, a1: a1, len: a1 - a0, rms: Math.max(rms, 0.15), n: use.length, pts: use,
           p0: { x: f.c.x + f.d.x * a0, y: f.c.y + f.d.y * a0 }, p1: { x: f.c.x + f.d.x * a1, y: f.c.y + f.d.y * a1 } };
}

/* ---------------- 1b. snap a point to a corner or a line (Point pair and Tick clicks) ---------------- */
// Near p (within r px): a CORNER where two strong straight lines at least minAngle apart cross within r of p; else the
// nearest point on a strong LINE within r; else nothing. Built on snapLine's seed (the longest ink run through the area),
// traced only locally. "Strong": at least minLen px long. Returns { x, y, kind: 'corner' | 'line' | 'none', lines }.
function snapPoint(im, p, o) {
  o = Object.assign({ r: 10, minAngle: 25, minLen: null, reach: null }, o || {});
  const r = o.r, minLen = o.minLen || Math.max(24, 3 * r), reach = o.reach || Math.max(60, 8 * r);
  const opts = { seek: r, win: Math.max(30, Math.min(70, 4 * r)), reach: reach };
  const near = ln => {                                   // the point of ln nearest p, if within r and on the traced part
    if (!ln || ln.len < minLen) return null;
    const a = dot({ x: p.x - ln.c.x, y: p.y - ln.c.y }, ln.d);
    if (a < ln.a0 - r || a > ln.a1 + r) return null;
    const q = { x: ln.c.x + ln.d.x * a, y: ln.c.y + ln.d.y * a };
    return Math.hypot(q.x - p.x, q.y - p.y) <= r ? q : null;
  };
  const L1 = snapLine(im, p, opts), q1 = near(L1);
  if (!q1) return { x: p.x, y: p.y, kind: 'none', lines: [] };
  // a second line, at least minAngle away from the first: seeded around the first's normal
  const half = 90 - o.minAngle;
  const L2 = snapLine(im, p, Object.assign({}, opts, { dirHint: nrm(L1.d), dirTol: half }));
  if (near(L2)) {
    const ang12 = Math.abs(wrapPi(2 * (ang(L1.d) - ang(L2.d)))) / 2 / DEG;
    const det = L1.d.x * L2.d.y - L1.d.y * L2.d.x;
    if (ang12 >= o.minAngle && Math.abs(det) > 1e-9) {
      const t = ((L2.c.x - L1.c.x) * L2.d.y - (L2.c.y - L1.c.y) * L2.d.x) / det;
      const X = { x: L1.c.x + L1.d.x * t, y: L1.c.y + L1.d.y * t };
      if (Math.hypot(X.x - p.x, X.y - p.y) <= r) return { x: X.x, y: X.y, kind: 'corner', lines: [L1, L2] };
    }
  }
  return { x: q1.x, y: q1.y, kind: 'line', lines: [L1] };
}

/* ---------------- 2. snap a station tick near a click ---------------- */
// A tick is a short stroke across the road. Returns the tick's position ALONG the road (that is what matters);
// the point returned lies on the tick at the click's cross position.
function snapTick(im, click, u, o) {
  o = Object.assign({ search: 10, cross: 22, thr: TICK_INK }, o || {});
  u = fwd(u); const n = nrm(u);
  const runAt = s => {                                 // longest ink run across the road at along-offset s
    let best = 0, lo = 0, cur = 0, curLo = 0, miss = 0;
    for (let k = -o.cross * 2; k <= o.cross * 2; k++) {
      const t = k / 2, v = sample(im, click.x + u.x * s + n.x * t, click.y + u.y * s + n.y * t);
      if (v >= o.thr) { if (cur === 0) curLo = t; cur = t - curLo + 0.5; miss = 0; if (cur > best) { best = cur; lo = curLo; } }
      else if (++miss > 2) cur = 0;
    }
    return { len: best, lo: lo, hi: lo + best };
  };
  let bs = 0, br = null;
  for (let s = -o.search; s <= o.search; s += 0.5) {
    const r = runAt(s), sc = r.len - 0.02 * Math.abs(s);
    if (!br || sc > br.sc) { br = r; br.sc = sc; bs = s; }
  }
  if (!br || br.len < 4) return null;
  // centroid of the stroke across the along direction
  let sw = 0, sa = 0, mn = Infinity; const prof = [];
  for (let s = bs - 3; s <= bs + 3.0001; s += 0.25) {
    let m = 0; for (let t = br.lo; t <= br.hi; t += 0.5) m += sample(im, click.x + u.x * s + n.x * t, click.y + u.y * s + n.y * t);
    prof.push([s, m]); mn = Math.min(mn, m);
  }
  for (const [s, m] of prof) { const w = m - mn; sw += w; sa += w * s; }
  const sc = sw > 0 ? sa / sw : bs;
  return { x: click.x + u.x * sc, y: click.y + u.y * sc, run: br.len,
           mid: { x: click.x + u.x * sc + n.x * (br.lo + br.hi) / 2, y: click.y + u.y * sc + n.y * (br.lo + br.hi) / 2 } };
}

/* ---------------- 3. road direction and cross profile (automatic) ---------------- */
function inkList(im, thr, f) {                        // ink pixels (x, y, v), optional filter f(x, y)
  const xs = [], ys = [], vs = [];
  for (let y = 0; y < im.h; y++) for (let x = 0; x < im.w; x++) {
    const v = im.data[y * im.w + x];
    if (v > thr && (!f || f(x + 0.5, y + 0.5))) { xs.push(x + 0.5); ys.push(y + 0.5); vs.push(v); }
  }
  return { x: Float32Array.from(xs), y: Float32Array.from(ys), v: Float32Array.from(vs), n: xs.length };
}

function profile(L, th, bin, sel) {                   // projection onto the normal of direction th
  const nx = -Math.sin(th), ny = Math.cos(th);
  let mn = Infinity, mx = -Infinity;
  for (let i = 0; i < L.n; i++) { if (sel && !sel[i]) continue; const c = L.x[i] * nx + L.y[i] * ny; if (c < mn) mn = c; if (c > mx) mx = c; }
  if (mn > mx) return { p: new Float32Array(1), c0: 0, bin: bin };
  const nb = Math.ceil((mx - mn) / bin) + 3, p = new Float32Array(nb), c0 = mn - bin;
  for (let i = 0; i < L.n; i++) {
    if (sel && !sel[i]) continue;
    const r = (L.x[i] * nx + L.y[i] * ny - c0) / bin, k = Math.floor(r), f = r - k;
    p[k] += L.v[i] * (1 - f); p[k + 1] += L.v[i] * f;
  }
  return { p: p, c0: c0, bin: bin };
}
const energy = pr => { let e = 0; for (let i = 0; i < pr.p.length; i++) e += pr.p[i] * pr.p[i]; return e; };

function refineAngle(L, th0, span, step, bin, sel) {  // maximise the profile energy (lines line up in the projection)
  let bt = th0, be = -1; const es = [];
  for (let t = -span; t <= span + 1e-9; t += step) { const e = energy(profile(L, th0 + t * DEG, bin, sel)); es.push(e); if (e > be) { be = e; bt = th0 + t * DEG; } }
  const k = Math.round((bt - th0) / DEG / step + span / step);
  if (k > 0 && k < es.length - 1) {
    const a = es[k - 1], b = es[k], c = es[k + 1], den = a - 2 * b + c;
    if (den < 0) bt += Math.max(-0.5, Math.min(0.5, 0.5 * (a - c) / den)) * step * DEG;
  }
  return { th: bt, e: be };
}

// Main road direction of a whole view (coarse, on a reduced image). Roads in these plans are drawn roughly
// horizontal, so steep directions are slightly penalised.
function roadDirection(im) {
  const f = Math.max(1, Math.ceil(Math.max(im.w, im.h) / 600)), sm = boxDown(im, f), L = inkList(sm, INK * 0.8);
  let bt = 0, be = -1;
  for (let t = -89; t <= 90; t += 1) {
    const e = energy(profile(L, t * DEG, 1)) * (1 - 0.3 * Math.abs(Math.sin(t * DEG)));
    if (e > be) { be = e; bt = t * DEG; }
  }
  return refineAngle(L, bt, 1.5, 0.1, 1).th;
}

function highpass(p, r) {                             // remove the slow part of a profile (text, trees, fills)
  const o = new Float32Array(p.length);
  for (let i = 0; i < p.length; i++) {
    let s = 0, n = 0; for (let j = Math.max(0, i - r); j <= Math.min(p.length - 1, i + r); j++) { s += p[j]; n++; }
    o[i] = Math.max(0, p[i] - s / n);
  }
  return o;
}

function peaks(p, minRel, minSep) {
  let mx = 0; for (const v of p) mx = Math.max(mx, v);
  const out = [];
  for (let i = 1; i < p.length - 1; i++) if (p[i] >= minRel * mx && p[i] >= p[i - 1] && p[i] > p[i + 1]) out.push({ i: i, v: p[i] });
  out.sort((a, b) => b.v - a.v);
  const keep = [];
  for (const q of out) if (keep.every(k => Math.abs(k.i - q.i) >= minSep)) keep.push(q);
  return keep;
}

// The straight road strip at one end of a view: 'end' for the last view (forward end), 'start' for the next view.
// Returns the refined road direction there, the cross profile of the strip, and the along range of the road.
function roadEnd(im, which, o) {
  o = Object.assign({ th: null, strip: null, bin: 0.5 }, o || {});
  const L = inkList(im, INK);
  let th = o.th !== null ? o.th : roadDirection(im);
  let res = null;
  for (let pass = 0; pass < 2; pass++) {               // coarse only: the exact angle comes from traced lines
    const d = fwd(unit(th)), n = nrm(d);
    th = ang(d);
    // road band: strong lines in the whole-view profile
    const pr = profile(L, th, 1), hp = highpass(pr.p, 6), pk = peaks(hp, 0.3, 3);
    if (!pk.length) return null;
    const cs = pk.map(q => pr.c0 + q.i * pr.bin), cmin = Math.min(...cs) - 4, cmax = Math.max(...cs) + 4;
    // along extent of the band lines
    let amin = Infinity, amax = -Infinity;
    for (let i = 0; i < L.n; i++) {
      const c = L.x[i] * n.x + L.y[i] * n.y; if (c < cmin || c > cmax) continue;
      if (!cs.some(cc => Math.abs(cc - c) < 1.5)) continue;
      const a = L.x[i] * d.x + L.y[i] * d.y; if (a < amin) amin = a; if (a > amax) amax = a;
    }
    const W = o.strip || Math.max(120, Math.min(600, 0.45 * (amax - amin)));
    const lo = which === 'end' ? amax - W : amin, hi = which === 'end' ? amax : amin + W;
    const sel = new Uint8Array(L.n);
    for (let i = 0; i < L.n; i++) {
      const a = L.x[i] * d.x + L.y[i] * d.y, c = L.x[i] * n.x + L.y[i] * n.y;
      sel[i] = (a >= lo && a <= hi && c >= cmin - 15 && c <= cmax + 15) ? 1 : 0;
    }
    th = refineAngle(L, th, pass === 0 ? 3 : 0.4, pass === 0 ? 0.1 : 0.02, 1, sel).th;
    const dd = fwd(unit(th)), sp = profile(L, ang(dd), o.bin, sel);
    res = { th: ang(dd), d: dd, n: nrm(dd), prof: sp, band: [cmin, cmax], along: [amin, amax], strip: [lo, hi], W: W, L: L, sel: sel };
  }
  return res;
}

// Cross offset between two profiles: c_L = s * c_R + delta. Normalised cross-correlation of the high-passed profiles.
function matchProfiles(pL, pR, s) {
  const hL = highpass(pL.p, 8), bin = pL.bin;
  // resample right profile onto the left bin size, scaled by s
  const hR0 = highpass(pR.p, Math.max(2, Math.round(8 / s)));
  const nR = Math.ceil(hR0.length * pR.bin * s / bin) + 2, hR = new Float32Array(nR);
  for (let k = 0; k < nR; k++) { const r = k * bin / (s * pR.bin), i = Math.floor(r), f = r - i; hR[k] = (i + 1 < hR0.length) ? hR0[i] * (1 - f) + hR0[i + 1] * f : 0; }
  // c_L = cL0 + i*bin ; c_R*s = s*cR0 + k*bin  =>  delta = cL0 + i*bin - s*cR0 - k*bin
  const sc = [], lags = [];
  let eL = 0, eR = 0; for (const v of hL) eL += v * v; for (const v of hR) eR += v * v;
  for (let lag = -nR + 1; lag < hL.length; lag++) {   // i = k + lag
    let s1 = 0, l2 = 0, r2 = 0;
    for (let k = Math.max(0, -lag); k < nR && k + lag < hL.length; k++) { const a = hL[k + lag], b = hR[k]; s1 += a * b; l2 += a * a; r2 += b * b; }
    const ov = Math.min(l2 / (eL || 1), r2 / (eR || 1));              // share of each profile's lines inside the overlap
    sc.push(l2 > 0 && r2 > 0 ? s1 / Math.sqrt(l2 * r2) * Math.min(1, 1.5 * ov) : 0); lags.push(lag);
  }
  let bi = 0; for (let i = 1; i < sc.length; i++) if (sc[i] > sc[bi]) bi = i;
  let sub = 0;
  if (bi > 0 && bi < sc.length - 1) { const a = sc[bi - 1], b = sc[bi], c = sc[bi + 1], den = a - 2 * b + c; if (den < 0) sub = Math.max(-0.5, Math.min(0.5, 0.5 * (a - c) / den)); }
  let second = 0;
  for (let i = 0; i < sc.length; i++) if (Math.abs(i - bi) * bin >= 3 && sc[i] > second && (i === 0 || sc[i] >= sc[i - 1]) && (i === sc.length - 1 || sc[i] >= sc[i + 1])) second = sc[i];
  const lag = lags[bi] + sub;
  return { delta: pL.c0 + lag * bin - s * pR.c0, score: sc[bi], second: second, ratio: second > 0 ? sc[bi] / second : 99 };
}

/* ---------------- 4. station tick lattice (automatic) ---------------- */
// Looks for short strokes across the road that repeat at the station interval P (px). Returns the ticks found
// (along position in this view's frame) and the measured interval.
function tickLattice(im, frame, o) {
  o = Object.assign({ P: null, Prange: 0.05, a: null, lines: null }, o || {});
  const d = frame.d, n = frame.n;
  const cmin = frame.band[0] - 30, cmax = frame.band[1] + 30;
  const a0 = o.a ? o.a[0] : frame.along[0], a1 = o.a ? o.a[1] : frame.along[1];
  const NA = Math.max(1, Math.floor(a1 - a0)), NC = Math.max(1, Math.floor(cmax - cmin));
  const Lmin = o.P ? Math.max(5, 0.04 * o.P) : 6, Lmax = o.P ? Math.max(Lmin + 8, 0.3 * o.P) : 70;
  // candidate station lines: the strongest lines of the road band (cross positions)
  let lines = o.lines;
  if (!lines) {
    const pr = frame.prof, hp = highpass(pr.p, Math.round(4 / pr.bin));
    lines = peaks(hp, 0.15, Math.round(3 / pr.bin)).slice(0, 12).map(q => pr.c0 + q.i * pr.bin);
  }
  // ink runs across the road for every along column; for each candidate line keep the run that crosses it
  const S = lines.map(() => new Float32Array(NA)), Sc = lines.map(() => new Float32Array(NA));
  for (let i = 0; i < NA; i++) {
    const a = a0 + i + 0.5, runs = [];
    let run = 0, start = 0, miss = 0;
    for (let j = 0; j <= NC; j++) {
      const c = cmin + j, v = j < NC ? sample(im, d.x * a + n.x * c, d.y * a + n.y * c) : 0;
      if (v >= TICK_INK) { if (run === 0) start = c; run = 1; miss = 0; }
      else if (run && ++miss > 1) { runs.push([start, c - miss + 1]); run = 0; }
    }
    for (let k = 0; k < lines.length; k++) {
      const cl = lines[k];
      for (const [r0, r1] of runs) {
        const len = r1 - r0;
        if (!(r0 <= cl + 1.5 && r1 >= cl - 1.5 && len >= Lmin && len <= Lmax && Math.max(cl - r0, r1 - cl) >= 3)) continue;
        // A station tick has a part past the line that stands alone (the other part may run through a label).
        // Hatch and text strokes have neighbours on both sides of the line. Line edges are measured beside the tick.
        let e0 = cl, e1 = cl;
        for (const off of [-6, 6]) {
          let lo = cl, hi = cl;
          while (lo > cl - 4 && sample(im, d.x * (a + off) + n.x * (lo - 0.5), d.y * (a + off) + n.y * (lo - 0.5)) >= TICK_INK) lo -= 0.5;
          while (hi < cl + 4 && sample(im, d.x * (a + off) + n.x * (hi + 0.5), d.y * (a + off) + n.y * (hi + 0.5)) >= TICK_INK) hi += 0.5;
          e0 = Math.min(e0, lo); e1 = Math.max(e1, hi);
        }
        let iso = 1;                                  // best (lowest) neighbour ink over the sides that stick out
        for (const [t0, t1] of [[r0, e0 - 1], [e1 + 1, r1]]) {
          if (t1 - t0 < 1.5) continue;
          let inkN = 0, tot = 0;
          for (const off of [-9, -7, -5, -4, 4, 5, 7, 9]) for (let c = t0; c <= t1 + 1e-9; c += 0.5) {
            tot++; if (sample(im, d.x * (a + off) + n.x * c, d.y * (a + off) + n.y * c) >= INK) inkN++;
          }
          iso = Math.min(iso, inkN / tot);
        }
        if (iso > 0.15) continue;
        S[k][i] = len; Sc[k][i] = (r0 + r1) / 2;
      }
    }
  }
  // lattice search per candidate line: interval P and phase
  const Ps = [];
  if (o.P) for (let P = o.P * (1 - o.Prange); P <= o.P * (1 + o.Prange); P += 0.1) Ps.push(P);
  else for (let P = 40; P <= Math.min(1200, NA / 1.5); P *= 1.003) Ps.push(P);
  let best = null;
  const mid = (frame.band[0] + frame.band[1]) / 2, half = Math.max(1, (frame.band[1] - frame.band[0]) / 2);
  const hitCount = S.map(Sk => { let h = 0; for (let i = 0; i < NA; i++) if (Sk[i] > 0 && !(i > 0 && Sk[i - 1] > 0)) h++; return h; });
  const nodeVal = (Sk, x) => { let m = 0, im2 = -1; for (let i = Math.max(0, Math.round(x) - 2); i <= Math.min(NA - 1, Math.round(x) + 2); i++) if (Sk[i] > m) { m = Sk[i]; im2 = i; } return [m, im2]; };
  for (let k = 0; k < lines.length; k++) for (const P of Ps) for (let ph = 0; ph < P; ph += 0.5) {
    let sum = 0, cnt = 0, nodes = 0;
    for (let x = ph; x < NA; x += P) { nodes++; const [m] = nodeVal(S[k], x); if (m > 0) { sum += Math.min(1, m / (2 * Lmin)); cnt++; } }
    // count ticks (long strokes such as hatch or text do not count more); an empty node costs half a tick,
    // so P/2, P/3 ... (same hits, more empty nodes) lose to P
    let sc = cnt >= 2 ? sum - 0.5 * (sum / cnt) * (nodes - cnt) : 0;
    if (sc <= 0) continue;
    sc -= 0.25 * (hitCount[k] - cnt);                  // a line with many hits off the pattern is text or hatch
    if (o.P) sc -= 0.3 * Math.abs(P / o.P - 1) / o.Prange;
    sc -= 0.2 * Math.abs(lines[k] - mid) / half;      // the station line is usually near the middle of the road
    if (!best || sc > best.sc) best = { sc: sc, P: P, ph: ph, cnt: cnt, k: k };
  }
  if (!best || best.cnt < 2) return { ticks: [], P: null, ok: false, _dbg: { lines: lines, hits: S.map(Sk => { const h = []; for (let i = 0; i < NA; i++) if (Sk[i] > 0 && !(Sk[i - 1] > 0)) h.push(+(a0 + i).toFixed(0)); return h; }) } };
  const Sk = S[best.k], Sck = Sc[best.k];
  // refine each tick: centroid of stroke ink across the along direction
  const ticks = [];
  for (let x = best.ph, k = 0; x < NA; x += best.P, k++) {
    const [m, i] = nodeVal(Sk, x); if (m <= 0) continue;
    const c = Sck[i], half = m / 2;
    let sw = 0, sa = 0, mn = Infinity; const pr = [];
    for (let s = i - 2.5; s <= i + 3.5; s += 0.25) {
      let v = 0; for (let t = c - half; t <= c + half; t += 0.5) v += sample(im, d.x * (a0 + s) + n.x * t, d.y * (a0 + s) + n.y * t);
      pr.push([s, v]); mn = Math.min(mn, v);
    }
    for (const [s, v] of pr) { sw += v - mn; sa += (v - mn) * s; }
    const a = a0 + (sw > 0 ? sa / sw : i + 0.5), cl = lines[best.k];
    ticks.push({ k: k, a: a, c: cl, run: m, x: d.x * a + n.x * cl, y: d.y * a + n.y * cl });
  }
  // straight-line fit a = A0 + k * P over the ticks (drop ones that do not fit, e.g. after a bend)
  let use = ticks.slice(), P = best.P, A0 = 0;
  for (let it = 0; it < 4 && use.length >= 2; it++) {
    const n2 = use.length, mk = use.reduce((s, t) => s + t.k, 0) / n2, ma = use.reduce((s, t) => s + t.a, 0) / n2;
    let sxy = 0, sxx = 0; for (const t of use) { sxy += (t.k - mk) * (t.a - ma); sxx += (t.k - mk) ** 2; }
    P = sxx > 0 ? sxy / sxx : best.P; A0 = ma - P * mk;
    const r = use.map(t => Math.abs(t.a - (A0 + P * t.k))), worst = Math.max(...r);
    if (worst < 1.5 || use.length <= 2) break;
    use = use.filter((t, i) => r[i] < worst);         // drop the worst one and refit
  }
  const res = use.map(t => t.a - (A0 + P * t.k)), rms = Math.sqrt(res.reduce((s, v) => s + v * v, 0) / Math.max(1, res.length));
  return { ticks: use, all: ticks, P: P, A0: A0, rms: rms, ok: use.length >= 2, line_c: lines[best.k], d: d, n: n,
           _dbg: { lines: lines, hits: S.map(Sk => { const h = []; for (let i = 0; i < NA; i++) if (Sk[i] > 0 && !(Sk[i - 1] > 0)) h.push(+(a0 + i).toFixed(0)); return h; }) } };
}

/* ---------------- 5. seam solver ---------------- */
// c = {
//   s:        scale R px -> L px (locked; ratio of render scales, or measured)
//   lines:    [{ L: line, R: line }]      lines from snapLine, same road line in both views
//   points:   [{ L: {x,y}, R: {x,y} }]    the same feature in both views (e.g. a shared tick)
//   stations: { L: {x,y}, R: {x,y}, dist_px }  ticks with known station difference (in L px), measured along the road
//   along:    number                      along-road shift override (L px), from slide match / lattice
//   anchor:   { L, R }                     along-only point pair (used when there are no points or stations)
//   theta, u: rotation and road direction, when there are no lines (e.g. kept from Auto join)
// }
function solveSeam(c) {
  const s = c.s || 1, lines = c.lines || [], points = c.points || [];
  let th = null, u = null;
  if (lines.length) {                                  // rotation: weighted mean of the angle differences
    let sx = 0, sy = 0;
    for (const lp of lines) {
      const w = lineWeight(lp.L) * lineWeight(lp.R) / (lineWeight(lp.L) + lineWeight(lp.R));
      const dlt = wrapPi(ang(fwd(lp.L.d)) - ang(fwd(lp.R.d)));
      sx += w * Math.cos(dlt); sy += w * Math.sin(dlt);
    }
    th = Math.atan2(sy, sx);
    u = fwd(lines.reduce((acc, lp) => ({ x: acc.x + lp.L.d.x * lp.L.len, y: acc.y + lp.L.d.y * lp.L.len }), { x: 0, y: 0 }));
    const m = Math.hypot(u.x, u.y); u = { x: u.x / m, y: u.y / m };
  } else if (c.theta !== undefined) { th = c.theta; u = c.u; }
  else if (points.length >= 2) {
    const r = similarity(points, s); if (!r) return null;
    return finish(r, c, 'points');
  } else return null;
  const a = s * Math.cos(th), b = s * Math.sin(th), rot = p => ({ x: a * p.x - b * p.y, y: b * p.x + a * p.y });
  // translation by weighted least squares on t (2 unknowns)
  let A11 = 0, A12 = 0, A22 = 0, B1 = 0, B2 = 0;
  const eq = (nx, ny, rhs, w) => { A11 += w * nx * nx; A12 += w * nx * ny; A22 += w * ny * ny; B1 += w * nx * rhs; B2 += w * ny * rhs; };
  for (const lp of lines) {                            // n_L . (rot(c_R) + t - c_L) = 0
    const nL = nrm(lp.L.d), rc = rot(lp.R.c), w = 1 / (lp.L.rms ** 2 + lp.R.rms ** 2 + 0.05);
    eq(nL.x, nL.y, nL.x * (lp.L.c.x - rc.x) + nL.y * (lp.L.c.y - rc.y), w);
  }
  for (const pp of points) {                           // point pairs: both components, 1 px
    const rp = rot(pp.R), w = pp.w || 1;
    eq(1, 0, pp.L.x - rp.x, w); eq(0, 1, pp.L.y - rp.y, w);
  }
  if (c.stations) {                                    // u . (rot(pB) + t - pA) = dist
    const st = c.stations, rp = rot(st.R), w = 4;
    eq(u.x, u.y, st.dist_px + u.x * (st.L.x - rp.x) + u.y * (st.L.y - rp.y), w);
  }
  if (c.anchor && !c.stations && !points.length) {    // along-only anchor (e.g. kept from Auto join): u . (rot(R) + t - L) = 0
    const rp = rot(c.anchor.R); eq(u.x, u.y, u.x * (c.anchor.L.x - rp.x) + u.y * (c.anchor.L.y - rp.y), 4);
  }
  let alongFixed = points.length > 0 || !!c.stations || !!c.anchor;
  if (c.along !== undefined && c.along !== null) {     // along-road shift of the origin, given
    eq(u.x, u.y, c.along, 4); alongFixed = true;
  }
  if (!alongFixed) {                                    // regularise: keep along shift 0 (flagged as unfixed)
    eq(u.x, u.y, 0, 1e-6);
  }
  const det = A11 * A22 - A12 * A12;
  if (Math.abs(det) < 1e-12) return null;
  const tx = (B1 * A22 - B2 * A12) / det, ty = (A11 * B2 - A12 * B1) / det;
  return finish({ a: a, b: b, tx: tx, ty: ty }, c, lines.length ? 'lines' : 'theta', u, alongFixed);
}
function lineWeight(l) { return l.n * l.len * l.len / (12 * l.rms * l.rms); }

function finish(t, c, method, u, alongFixed) {
  return { a: t.a, b: t.b, tx: t.tx, ty: t.ty, method: method, u: u || null, alongFixed: alongFixed !== false };
}

function similarity(prs, s) {                          // least squares rotation + shift, scale locked to s
  const n = prs.length; let pcx = 0, pcy = 0, wcx = 0, wcy = 0;
  for (const q of prs) { pcx += q.R.x; pcy += q.R.y; wcx += q.L.x; wcy += q.L.y; }
  pcx /= n; pcy /= n; wcx /= n; wcy /= n;
  let re = 0, im = 0;
  for (const q of prs) { const px = q.R.x - pcx, py = q.R.y - pcy, wx = q.L.x - wcx, wy = q.L.y - wcy; re += px * wx + py * wy; im += px * wy - py * wx; }
  const m = Math.hypot(re, im); if (m < 1e-9) return null;
  const a = s * re / m, b = s * im / m;
  return { a: a, b: b, tx: wcx - (a * pcx - b * pcy), ty: wcy - (b * pcx + a * pcy) };
}

/* ---------------- 6. overlap match along the road only ---------------- */
// Rotation and cross position are fixed; search the along-road shift that best matches the ink that is NOT parallel
// to the road (ticks, text, symbols, dash ends). Parallel road lines are ignored because they match anywhere.
function alongGrad(im, u) {
  const g = img(im.w, im.h), b = blur(im, 0.8);
  for (let y = 1; y < im.h - 1; y++) for (let x = 1; x < im.w - 1; x++) {
    const i = y * im.w + x, gx = (b.data[i + 1] - b.data[i - 1]) / 2, gy = (b.data[i + im.w] - b.data[i - im.w]) / 2;
    g.data[i] = Math.abs(gx * u.x + gy * u.y);
  }
  return g;
}

// Score of a shift: how well the across-road edges (ticks, text, symbols, dash ends) of each view land on those of
// the other view, inside the area both views cover. Checked both ways, so ink that only one view has counts against.
function slideMatch(imL, imR, rel, u, range, o) {
  o = Object.assign({ step: 1, minN: 60, maxPts: 40000 }, o || {});
  const uR = Tdir(invert(rel), u);
  const rawL = alongGrad(imL, u), rawR = alongGrad(imR, uR), bL = blur(rawL, 1.0), bR = blur(rawR, 1.0);
  const pick = g => {
    let mx = 0; for (let i = 0; i < g.data.length; i += 5) mx = Math.max(mx, g.data[i]);
    const thr = 0.15 * mx, all = [];
    for (let y = 1; y < g.h - 1; y++) for (let x = 1; x < g.w - 1; x++) { const v = g.data[y * g.w + x]; if (v > thr) all.push(x + 0.5, y + 0.5, v); }
    const st = Math.max(1, Math.ceil(all.length / 3 / o.maxPts)), out = [];
    for (let i = 0; i < all.length; i += 3 * st) out.push(all[i], all[i + 1], all[i + 2]);
    return out;
  };
  const pR = pick(rawR), pL = pick(rawL);
  const one = (pts, t, imTo, gTo) => {
    let s1 = 0, a2 = 0, b2 = 0, n = 0;
    for (let i = 0; i < pts.length; i += 3) {
      const q = T(t, { x: pts[i], y: pts[i + 1] });
      if (!inside(imTo, q.x, q.y, 3)) continue;
      const v = sample(gTo, q.x, q.y); s1 += v * pts[i + 2]; a2 += pts[i + 2] ** 2; b2 += v * v; n++;
    }
    return { s: (a2 > 0 && b2 > 0) ? s1 / Math.sqrt(a2 * Math.max(b2, 0.25 * a2)) : 0, n: n };
  };
  const score = sh => {
    const t = { a: rel.a, b: rel.b, tx: rel.tx + sh * u.x, ty: rel.ty + sh * u.y };
    const f = one(pR, t, imL, bL), b = one(pL, invert(t), imR, bR);
    const ok = f.n >= o.minN && b.n >= o.minN;
    return { s: ok ? Math.sqrt(Math.max(0, f.s) * Math.max(0, b.s)) : 0, n: Math.min(f.n, b.n) };
  };
  const curve = [];
  for (let sh = range[0]; sh <= range[1]; sh += o.step) { const r = score(sh); curve.push({ sh: sh, s: r.s, n: r.n }); }
  let bi = 0; for (let i = 1; i < curve.length; i++) if (curve[i].s > curve[bi].s) bi = i;
  let bsh = curve[bi].sh, bsc = curve[bi].s;
  for (let sh = bsh - o.step; sh <= bsh + o.step + 1e-9; sh += 0.25) { const r = score(sh); if (r.s > bsc) { bsc = r.s; bsh = sh; } }
  let second = 0;                                      // best other peak, at least 12 px away
  for (let i = 0; i < curve.length; i++) if (Math.abs(curve[i].sh - bsh) > 12 && curve[i].s > second &&
      (i === 0 || curve[i].s >= curve[i - 1].s) && (i === curve.length - 1 || curve[i].s >= curve[i + 1].s)) second = curve[i].s;
  return { shift: bsh, score: bsc, second: second, ratio: second > 0 ? bsc / second : 99, n: score(bsh).n, curve: curve, score_at: sh => score(sh).s };
}

/* ---------------- 7. automatic seam ---------------- */
// Finds the road lines that cross the seam in both views, joins them (rotation + cross position), then sets the
// along-road position from the station ticks and/or the overlap. Everything it finds is returned so the UI can show
// it and the user can correct it.
// o: s (scale R px -> L px), P (expected station interval in L px, from the plan scale; null = unknown)
function autoSeamCore(imL, imR, o) {
  o = Object.assign({ s: 1, P: null, maxLines: 6 }, o || {});
  const notes = [], s = o.s;
  const eL = roadEnd(imL, 'end'), eR = roadEnd(imR, 'start');
  if (!eL || !eR) return { ok: false, notes: ['No road lines found near the seam. Snap the lines by hand.'] };

  // 1. cross offset from the pattern of parallel lines: c_L = s * c_R + delta
  const pm = matchProfiles(eL.prof, eR.prof, s);
  // 2. line pairs: strong lines in the left strip with a partner at the matched cross position
  const linePeaks = e => { const pr = e.prof, hp = highpass(pr.p, Math.round(4 / pr.bin)); return peaks(hp, 0.15, Math.round(3 / pr.bin)).slice(0, 12).map(q => pr.c0 + q.i * pr.bin); };
  const cLs = linePeaks(eL), cRs = linePeaks(eR);
  const trace = (im, e, c, which) => {
    let best = null;
    for (const f of [0.25, 0.5, 0.75]) {
      const a = which === 'end' ? e.strip[1] - f * e.W : e.strip[0] + f * e.W;
      const ln = snapLine(im, { x: e.d.x * a + e.n.x * c, y: e.d.y * a + e.n.y * c }, { dirHint: e.d, dirTol: 3, seek: 2, reach: Math.max(200, 2 * e.W) });
      if (!ln) continue;
      const cc = dot(ln.c, e.n), da = Math.abs(wrapPi(2 * (ang(ln.d) - e.th))) / 2 / DEG;
      if (Math.abs(cc - c) > 2.5 || da > 1.5 || ln.len < 40) continue;
      if (!best || ln.len > best.len) best = ln;
    }
    return best;
  };
  let pairs = [];
  for (const cL of cLs) {
    const want = (cL - pm.delta) / s;
    let cR = null; for (const c of cRs) if (Math.abs(c - want) * s < 2.5 && (cR === null || Math.abs(c - want) < Math.abs(cR - want))) cR = c;
    if (cR === null) continue;
    const lL = trace(imL, eL, cL, 'end'), lR = lL && trace(imR, eR, cR, 'start');
    if (lL && lR) pairs.push({ L: lL, R: lR, cL: cL, cR: cR });
    if (pairs.length >= o.maxLines) break;
  }
  if (!pairs.length) return { ok: false, notes: ['No line continues across the seam. Snap the lines by hand.'], endL: eL, startR: eR };
  // drop pairs whose angle difference disagrees with the others (wrong partner, a bend near the cut)
  if (pairs.length >= 3) {                           // weighted median of the angle differences, keep pairs near it
    const dl = pairs.map(p => ({ v: wrapPi(ang(fwd(p.L.d)) - ang(fwd(p.R.d))), w: Math.min(p.L.len, p.R.len) })).sort((a, b) => a.v - b.v);
    const tot = dl.reduce((s2, x) => s2 + x.w, 0); let acc = 0, med = dl[0].v;
    for (const x of dl) { acc += x.w; if (acc >= tot / 2) { med = x.v; break; } }
    const keep = pairs.filter(p => Math.abs(wrapPi(ang(fwd(p.L.d)) - ang(fwd(p.R.d))) - med) < 0.15 * DEG);
    if (keep.length >= 2) pairs = keep;
  }
  const base = solveSeam({ s: s, lines: pairs });     // rotation + cross position; along shift = 0 for now
  if (!base) return { ok: false, notes: ['Could not solve the seam from the lines.'] };
  const u = base.u, rel0 = { a: base.a, b: base.b, tx: base.tx, ty: base.ty };
  const shifted = sg => ({ a: rel0.a, b: rel0.b, tx: rel0.tx + sg * u.x, ty: rel0.ty + sg * u.y });
  if (pm.ratio < 1.15) notes.push('The line pattern is not unique across the road. Check the cross-road position.');

  // along extents (L units): road in each view, and the whole image rectangles
  const alongPts = (pts, t) => pts.map(p => dot(t ? T(t, p) : p, u));
  const rectL = alongPts([{ x: 0, y: 0 }, { x: imL.w, y: 0 }, { x: imL.w, y: imL.h }, { x: 0, y: imL.h }]);
  const rectR = alongPts([{ x: 0, y: 0 }, { x: imR.w, y: 0 }, { x: imR.w, y: imR.h }, { x: 0, y: imR.h }], rel0);
  // where each paired line leaves the last view / enters the next view (image edges, not where the trace stopped)
  const exitL = pairs.map(p => { const e = rectExit(imL, p.L.c, fwd(p.L.d), 1); return e ? dot(e, u) : dot(p.L.p1, u); });
  const entR = pairs.map(p => { const e = rectExit(imR, p.R.c, fwd(p.R.d), -1); return dot(T(rel0, e || p.R.p0), u); });
  const endL = Math.max(...exitL), startR = Math.min(...entR);
  const lenL = Math.max(...rectL) - Math.min(...rectL), lenR = Math.max(...rectR) - Math.min(...rectR);
  const gap = sg => startR + sg - endL;              // > 0: gap along the road, < 0: overlap (L px)

  // 3. station ticks
  const okP = (t, Pexp) => t.ok && (!Pexp || Math.abs(t.P / Pexp - 1) < 0.015);
  const tL = tickLattice(imL, eL, { P: o.P }), tR = tickLattice(imR, eR, { P: o.P ? o.P / s : null });
  // with no plan scale, use ticks only when both views agree on 3+ evenly spaced ticks (dashed-line text can fool it)
  const agree = tL.ok && tR.ok && tL.ticks.length >= 3 && tR.ticks.length >= 3 && Math.abs(tL.P / (tR.P * s) - 1) < 0.01;
  const useL = o.P ? okP(tL, o.P) : agree, useR = o.P ? okP(tR, o.P / s) : agree;
  const P = useL ? tL.P : (useR ? tR.P * s : o.P);
  if (useL && useR && Math.abs(tL.P / (tR.P * s) - 1) > 0.01) notes.push('Station spacing differs between the views by ' + ((tL.P / (tR.P * s) - 1) * 100).toFixed(1) + '%. Check the scale.');
  let cands = [];
  if (useL && useR) {
    let cx = 0, cy = 0;                                // circular mean of the phase that puts R ticks on L ticks
    for (const tk of tR.ticks) { const ph = (tL.A0 - dot(T(rel0, tk), u)) / P * 2 * Math.PI; cx += Math.cos(ph); cy += Math.sin(ph); }
    const sg0 = Math.atan2(cy, cx) / (2 * Math.PI) * P;
    for (let k = -60; k <= 60; k++) {
      const sg = sg0 + k * P, g = gap(sg);
      if (g < -0.95 * Math.min(lenL, lenR) || g > 3 * P) continue;
      cands.push({ along: sg, gap: g });
    }
  }

  // 4. overlap match, searching only along the road
  let sm = null;
  const lo = Math.max(Math.min(...rectL) - Math.max(...rectR), endL - startR - 0.9 * Math.min(lenL, lenR));
  const hi = Math.max(...rectL) - Math.min(...rectR) - 10;
  if (hi - lo > 8) {
    sm = slideMatch(imL, imR, rel0, u, [lo, hi], { step: 1, minN: 120 });
  }
  let along = null, method = null, confidence = 'check';
  if (cands.length) {
    // Tick candidates are one station apart. Ticks line up at every candidate, so a wrong candidate can also score
    // well where the views overlap; only a clear lead over the next candidate counts.
    const ov = cands.filter(c => c.gap < -5 && sm).map(c => { c.score = sm.score_at(c.along); return c; }).filter(c => c.score > 0).sort((a, b) => b.score - a.score);
    const lead = ov.length ? ov[0].score - (ov.length > 1 ? ov[1].score : 0.6) : 0;
    if (ov.length && ov[0].score >= 0.5 && lead >= 0.1) {
      along = ov[0].along; method = 'ticks + overlap'; confidence = lead >= 0.2 ? 'good' : 'check';
    } else {
      const noOv = cands.filter(c => c.gap >= -5).sort((a, b) => a.gap - b.gap);
      if (noOv.length) {
        along = noOv[0].along; method = 'ticks, smallest gap';
        notes.push('Along-road position from the tick spacing, with the smallest gap between the views. Check the station labels (use the station buttons if it is one station off).');
      }
    }
  }
  if (along === null && sm && sm.score > 0.35 && (sm.ratio > 1.3 || sm.score - sm.second > 0.1)) {
    along = sm.shift; method = 'overlap'; confidence = sm.score > 0.5 && sm.ratio > 1.5 ? 'good' : 'check';
  }
  if (along === null) {
    along = endL - startR; method = 'none (views butted)'; confidence = 'poor';
    notes.push('No along-road control found. Click a station tick in each view and enter the stations.');
  }
  const rel = shifted(along);
  return { ok: true, rel: rel, rel0: rel0, u: u, method: method, confidence: confidence, along: along, P: P, gap_px: gap(along),
           lines: pairs, profile: { score: pm.score, ratio: pm.ratio },
           ticksL: useL ? tL : null, ticksR: useR ? tR : null, cands: cands,
           slide: sm ? { shift: sm.shift, score: sm.score, ratio: sm.ratio, n: sm.n } : null, notes: notes };
}

// Large views (clips rendered at 2x or more) are searched on a reduced copy, then every paired line is snapped
// again at full size and the rotation and cross position are solved again. The along shift keeps the coarse value
// (moved to the nearest tick spacing when ticks were used).
function autoSeam(imL, imR, o) {
  o = Object.assign({ s: 1, P: null, maxDim: MOSAIC.SEAM.REDUCED_MAX_DIM }, o || {});
  const f = Math.max(1, Math.ceil(Math.max(imL.w, imL.h, imR.w, imR.h) / o.maxDim));
  if (f === 1) return autoSeamCore(imL, imR, o);
  const r = autoSeamCore(boxDown(imL, f), boxDown(imR, f), Object.assign({}, o, { P: o.P ? o.P / f : null }));
  if (!r.ok) return r;
  const up = p => ({ x: p.x * f, y: p.y * f });
  const lines = [];
  for (const lp of r.lines) {                          // re-snap each line at full size near its coarse centre
    const L = snapLine(imL, up(lp.L.c), { dirHint: lp.L.d, dirTol: 1, seek: 1.5 * f, reach: lp.L.len * f });
    const R = snapLine(imR, up(lp.R.c), { dirHint: lp.R.d, dirTol: 1, seek: 1.5 * f, reach: lp.R.len * f });
    if (L && R) lines.push({ L: L, R: R });
  }
  const fine = lines.length ? solveSeam({ s: o.s, lines: lines }) : null;
  const coarse = { a: r.rel.a, b: r.rel.b, tx: r.rel.tx * f, ty: r.rel.ty * f };
  let rel = coarse;
  if (fine) {                                          // keep the coarse along position, take rotation + cross from fine
    const u = fine.u, pivot = up(r.lines[0].L.c);
    const a0 = dot(T(coarse, T(invert(coarse), pivot)), u);
    const fineAt = T(fine, T(invert(coarse), pivot));
    const sh = a0 - dot(fineAt, u);
    rel = { a: fine.a, b: fine.b, tx: fine.tx + sh * u.x, ty: fine.ty + sh * u.y };
  }
  const scaleTicks = t => t && Object.assign({}, t, { P: t.P * f, A0: t.A0 * f, ticks: t.ticks.map(k => Object.assign({}, k, { a: k.a * f, x: k.x * f, y: k.y * f })) });
  // refine the along shift at full size
  const u = fine ? fine.u : r.u;
  if (fine && r.ticksL && r.ticksR && /ticks/.test(r.method)) {
    const tl = r.ticksL.ticks[r.ticksL.ticks.length - 1], tr = r.ticksR.ticks[0], uR = Tdir(invert(rel), u);
    const a = snapTick(imL, up(tl), u, { search: 2 * f }), b = snapTick(imR, up(tr), uR, { search: 2 * f });
    if (a && b) { const P = r.P * f, d = dot({ x: T(rel, b).x - a.x, y: T(rel, b).y - a.y }, u), want = Math.round(d / P) * P;
      rel = { a: rel.a, b: rel.b, tx: rel.tx + (want - d) * u.x, ty: rel.ty + (want - d) * u.y }; }
  } else if (fine && /overlap/.test(r.method)) {
    const sm = slideMatch(imL, imR, rel, u, [-2 * f, 2 * f], { step: 0.5, minN: 120 });
    if (sm.score > 0) rel = { a: rel.a, b: rel.b, tx: rel.tx + sm.shift * u.x, ty: rel.ty + sm.shift * u.y };
  }
  return Object.assign({}, r, { rel: rel, lines: lines.length ? lines : r.lines, u: u, P: r.P ? r.P * f : null, gap_px: r.gap_px * f,
                                along: r.along * f, ticksL: scaleTicks(r.ticksL), ticksR: scaleTicks(r.ticksR), reduced: f });
}

/* ---------------- 8. accuracy check at the seam ---------------- */
// r: { rel, u (forward road dir in L), pxPerFt (L px per ft), lines, points, stations, ticksL, ticksR, P, viewL:{w,h}, viewR:{w,h} }
function seamReport(r) {
  const t = r.rel, out = { lines: [], points: [], notes: [] }, f = 1 / r.pxPerFt;
  const u = r.u || fwd(Tdir(t, { x: 1, y: 0 })), n = nrm(u);
  // seam point: where the road leaves L / enters R (on the first line, or the image centre lines)
  const exitL = rectExit(r.viewL, r.lines && r.lines[0] ? r.lines[0].L.c : { x: r.viewL.w / 2, y: r.viewL.h / 2 }, u, +1);
  const rc = r.lines && r.lines[0] ? T(t, r.lines[0].R.c) : T(t, { x: r.viewR.w / 2, y: r.viewR.h / 2 });
  const entR = rectExitT(r.viewR, t, rc, u, -1);
  out.gap_ft = (exitL && entR) ? dot({ x: entR.x - exitL.x, y: entR.y - exitL.y }, u) * f : null;
  const m = (exitL && entR) ? { x: (exitL.x + entR.x) / 2, y: (exitL.y + entR.y) / 2 } : exitL || entR;
  out.seam = m;
  for (const lp of (r.lines || [])) {
    const dR = Tdir(t, fwd(lp.R.d)), cR = T(t, lp.R.c), dL = fwd(lp.L.d), nL = nrm(dL);
    const angD = wrapPi(ang(dR) - ang(dL)) / DEG;
    // lateral offset of the two lines, at the seam point
    const tR = dot({ x: m.x - cR.x, y: m.y - cR.y }, dR), onR = { x: cR.x + dR.x * tR, y: cR.y + dR.y * tR };
    const off = dot({ x: onR.x - lp.L.c.x, y: onR.y - lp.L.c.y }, nL);
    out.lines.push({ angle_deg: angD, offset_ft: off * f });
  }
  for (const pp of (r.points || [])) {
    const q = T(t, pp.R), dv = { x: q.x - pp.L.x, y: q.y - pp.L.y };
    out.points.push({ along_ft: dot(dv, u) * f, cross_ft: dot(dv, n) * f });
  }
  if (r.stations) {
    const q = T(t, r.stations.R), dist = dot({ x: q.x - r.stations.L.x, y: q.y - r.stations.L.y }, u);
    out.station = { along_ft: (dist - r.stations.dist_px) * f, cross_ft: dot({ x: q.x - r.stations.L.x, y: q.y - r.stations.L.y }, n) * f };
  }
  if (r.ticksL && r.ticksL.ok && r.ticksR && r.ticksR.ok) {   // do the next view's ticks fall on the last view's tick spacing?
    const P = r.ticksL.P, A0 = r.ticksL.A0, res = [];
    for (const tk of r.ticksR.ticks) {
      const q = T(t, { x: tk.x, y: tk.y }), a = dot(q, u), k = Math.round((a - A0) / P);
      res.push(a - (A0 + k * P));
    }
    const mean = res.reduce((s, v) => s + v, 0) / res.length;
    out.tick_phase_ft = mean * f;
  }
  out.rotation_deg = Math.atan2(t.b, t.a) / DEG;
  return out;
}

function rectExit(view, p, u, sg) {                   // where the line through p along sg*u leaves the rectangle
  let best = Infinity;
  const dx = sg * u.x, dy = sg * u.y;
  if (dx > 1e-9) best = Math.min(best, (view.w - p.x) / dx); if (dx < -1e-9) best = Math.min(best, -p.x / dx);
  if (dy > 1e-9) best = Math.min(best, (view.h - p.y) / dy); if (dy < -1e-9) best = Math.min(best, -p.y / dy);
  return isFinite(best) ? { x: p.x + dx * best, y: p.y + dy * best } : null;
}
function rectExitT(view, t, q, u, sg) {               // same, for a rectangle placed by t (point q and dir u in L)
  const it = invert(t), p = T(it, q), uu = Tdir(it, u), e = rectExit(view, p, uu, sg);
  return e ? T(t, e) : null;
}

// Nudge a seam result: rotate by rot (rad) about pivot, then shift along/across (L px).
function nudge(rel, nd, pivot, u) {
  const c = Math.cos(nd.rot || 0), s = Math.sin(nd.rot || 0), n = nrm(u);
  const R = { a: c, b: s, tx: pivot.x - (c * pivot.x - s * pivot.y), ty: pivot.y - (s * pivot.x + c * pivot.y) };
  const out = compose(R, rel);
  out.tx += (nd.along || 0) * u.x + (nd.across || 0) * n.x; out.ty += (nd.along || 0) * u.y + (nd.across || 0) * n.y;
  return out;
}

// Plan scale -> px per ft:  render_scale * 72 px per inch / (ft per inch)
function pxPerFt(ftPerInch, renderScale) { return 72 * (renderScale || 1) / ftPerInch; }
const STD_SCALES = [5, 10, 20, 25, 30, 40, 50, 60, 100, 200];
function guessScale(P, interval_ft, renderScale) {     // from a measured tick interval (px)
  const fpi = 72 * (renderScale || 1) * interval_ft / P;
  let best = STD_SCALES[0]; for (const s of STD_SCALES) if (Math.abs(Math.log(s / fpi)) < Math.abs(Math.log(best / fpi))) best = s;
  return { ft_per_inch: fpi, nearest: best, off_pct: (best / fpi - 1) * 100 };
}

export { fromRGBA, fromGray, sample, snapLine, snapPoint, snapTick, roadDirection, roadEnd, boxDown, matchProfiles, tickLattice,
  solveSeam, slideMatch, autoSeam, seamReport, nudge, T, Tdir, compose, invert, fwd, pxPerFt, guessScale };
