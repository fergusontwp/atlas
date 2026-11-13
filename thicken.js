// Line weight: makes thin plan lines darker and thicker so they read over imagery. Ported from
// reference/plan-tools/line-thickener.html (the numbers, not the page). Typed arrays only: no DOM and no SDK, so it runs
// in the compression worker and in tests alone.
//
//   sharpen  an unsharp mask at the image's own pixels (before the levels): each value is pushed away from the 3 x 3
//            weighted mean around it by `sharpen` times the difference, so the core of a thin or downsampled line gets
//            darker and its fuzzy edge lighter. It adds no width (unlike thicken); a difference under SHARPEN_FLOOR is
//            left alone, so the paper's grain isn't raised. 0 is off.
//   levels   a lookup table: values at or below `black` go black, at or above `white` go white, the rest stretched
//            between with `gamma`; optionally binarized at `thresh` (below is black)
//   thicken  a grey-level minimum (dark lines on light paper): whole steps alternate a plus-shaped and a square 3x3
//            minimum (close to a round brush), and the fractional part blends one more step in, for soft edges
// The strength is in points of added line weight at the plan's print scale (PLANS.THICKEN); at a render of `dpi` it is
// ptToPx(pt, dpi) pixels, so a plan looks the same at any resolution. Pixels outside the image count as its edge
// pixels, so a crop (a strip, a piece) must be processed with haloFor(px, sharpen) pixels of its neighbours and then
// trimmed.

export const ptToPx = (pt, dpi) => (Number(pt) > 0 && Number(dpi) > 0 ? (pt * dpi) / 72 : 0);

// Pixels of context a crop needs on each side for `px` of thickening (and a sharpen, one pixel more) to match the whole
// image.
export const haloFor = (px, sharpen = 0) => (px > 0 ? Math.ceil(px) + 1 : 0) + (sharpen > 0 ? 1 : 0);

export const SHARPEN_FLOOR = 2;

// One plane (w x h) sharpened by `amount` (unsharp mask, radius one pixel: a [1 2 1] blur each way). Returns a plane (the
// input itself when amount is 0).
export function sharpenPlane(a, w, h, amount) {
  if (!(amount > 0)) return a;
  const len = w * h, t = new Uint16Array(len), out = new Uint8Array(len);
  for (let y = 0; y < h; y++) {
    const r = y * w;
    for (let x = 0; x < w; x++) t[r + x] = a[r + (x > 0 ? x - 1 : 0)] + 2 * a[r + x] + a[r + (x < w - 1 ? x + 1 : w - 1)];
  }
  for (let y = 0; y < h; y++) {
    const r = y * w, u = y > 0 ? r - w : r, n = y < h - 1 ? r + w : r;
    for (let x = 0; x < w; x++) {
      const v = a[r + x], d = v - (t[u + x] + 2 * t[r + x] + t[n + x]) / 16;
      const o = d > SHARPEN_FLOOR || d < -SHARPEN_FLOOR ? v + amount * d : v;
      out[r + x] = o < 0 ? 0 : o > 255 ? 255 : (o + 0.5) | 0;
    }
  }
  return out;
}

// The levels table. P: { black, white, gamma, bin, thresh }.
export function buildLut({ black = 0, white = 255, gamma = 1, bin = false, thresh = 128 } = {}) {
  const lut = new Uint8Array(256), B = black, W = Math.max(white, B + 1);
  for (let v = 0; v < 256; v++) {
    let x = (v - B) / (W - B);
    x = x < 0 ? 0 : x > 1 ? 1 : x;
    let o = Math.round(255 * Math.pow(x, gamma));
    if (bin) o = o < thresh ? 0 : 255;
    lut[v] = o;
  }
  return lut;
}

function erodeCross(s, d, w, h) {
  for (let y = 0; y < h; y++) {
    const r = y * w, u = y > 0 ? r - w : r, n = y < h - 1 ? r + w : r;
    for (let x = 0; x < w; x++) {
      const l = x > 0 ? x - 1 : 0, q = x < w - 1 ? x + 1 : w - 1;
      let m = s[r + x], v = s[r + l]; if (v < m) m = v;
      v = s[r + q]; if (v < m) m = v;
      v = s[u + x]; if (v < m) m = v;
      v = s[n + x]; if (v < m) m = v;
      d[r + x] = m;
    }
  }
}

function erodeSquare(s, d, t, w, h) {
  for (let y = 0; y < h; y++) {
    const r = y * w;
    for (let x = 0; x < w; x++) {
      const l = x > 0 ? x - 1 : 0, q = x < w - 1 ? x + 1 : w - 1;
      let m = s[r + x], v = s[r + l]; if (v < m) m = v;
      v = s[r + q]; if (v < m) m = v;
      t[r + x] = m;
    }
  }
  for (let y = 0; y < h; y++) {
    const r = y * w, u = y > 0 ? r - w : r, n = y < h - 1 ? r + w : r;
    for (let x = 0; x < w; x++) {
      let m = t[r + x], v = t[u + x]; if (v < m) m = v;
      v = t[n + x]; if (v < m) m = v;
      d[r + x] = m;
    }
  }
}

// One plane (w x h, 0 dark .. 255 light) thickened by t pixels. Returns a plane (the input itself when t is 0).
export function thickenPlane(a, w, h, t) {
  if (!(t > 0)) return a;
  const n = Math.floor(t), f = t - n, len = w * h;
  let cur = a, other = new Uint8Array(len), tmp = null;
  const stepInto = (from, to, i) => {
    if (i % 2 === 0) erodeCross(from, to, w, h);
    else { if (!tmp) tmp = new Uint8Array(len); erodeSquare(from, to, tmp, w, h); }
  };
  for (let i = 0; i < n; i++) { stepInto(cur, other, i); const z = cur; cur = other; other = z; }
  if (f > 1e-6) {
    stepInto(cur, other, n);
    for (let j = 0; j < len; j++) other[j] = (cur[j] + (other[j] - cur[j]) * f + 0.5) | 0;
    return other;
  }
  return cur;
}

// An RGBA block (w x h) through the sharpen, the levels and the thickening, as RGBA. P: { black, white, gamma, bin, thresh,
// color, sharpen }
// (color: each channel on its own; otherwise grey). px: the thickening in pixels. lut: buildLut(P), passed in to reuse.
// rows [y0, y1): only those rows are returned (the rest of the block is halo). Alpha comes out opaque.
export function processRgba(rgba, w, h, P, px, { lut = buildLut(P), y0 = 0, y1 = h } = {}) {
  const n = w * h, comps = P.color ? 3 : 1, planes = [];
  for (let c = 0; c < comps; c++) {
    let a = new Uint8Array(n);
    if (comps === 1) for (let i = 0, p = 0; i < n; i++, p += 4) a[i] = (rgba[p] * 77 + rgba[p + 1] * 151 + rgba[p + 2] * 28) >> 8;
    else for (let i = 0, p = c; i < n; i++, p += 4) a[i] = rgba[p];
    // sharpened before the levels, so a thin grey line made darker survives a binarize
    a = sharpenPlane(a, w, h, P.sharpen);
    for (let i = 0; i < n; i++) a[i] = lut[a[i]];
    planes.push(thickenPlane(a, w, h, px));
  }
  const rows = y1 - y0, out = new Uint8ClampedArray(w * rows * 4);
  for (let i = 0, src = y0 * w, q = 0; i < w * rows; i++, src++, q += 4) {
    if (comps === 1) { const v = planes[0][src]; out[q] = v; out[q + 1] = v; out[q + 2] = v; }
    else { out[q] = planes[0][src]; out[q + 1] = planes[1][src]; out[q + 2] = planes[2][src]; }
    out[q + 3] = 255;
  }
  return out;
}

// A whole image (w x h), strip by strip so a large one never needs the whole thing in planes at once. read(y0, y1)
// gives the RGBA rows [y0, y1) of the source (never changed by write), write(y, rgba) takes processed rows from y.
// Each strip reads haloFor(px, sharpen) rows above and below it, so the result equals processing the image whole.
export function processStrips(read, write, w, h, P, px, stripRows = 512) {
  const lut = buildLut(P), halo = haloFor(px, P.sharpen);
  for (let y = 0; y < h; y += stripRows) {
    const a = Math.max(0, y - halo), b = Math.min(h, y + stripRows + halo), end = Math.min(h, y + stripRows);
    write(y, processRgba(read(a, b), w, b - a, P, px, { lut, y0: y - a, y1: end - a }));
  }
}

// The settings a preset stands for. presets: PLANS.THICKEN.PRESETS (points), levels: PLANS.THICKEN.LEVELS.
// name: "off" | "light" | "medium" | "heavy" | "custom" (custom: the advanced values as given). sharpen: the sharpen
// amount (PLANS.THICKEN.SHARPEN), kept whatever the line weight. Returns null when both are off; with the line weight off
// and a sharpen, the sharpen alone (no line weight, levels left as they are).
export function thickenSettings(name, { presets, levels, color = false }, custom = {}, sharpen = 0) {
  const sh = Number(sharpen) > 0 ? Number(sharpen) : 0;
  if (!name || name === "off") return sh ? { name: "off", black: 0, white: 255, gamma: 1, bin: false, thresh: levels.THRESH, color, pt: 0, sharpen: sh } : null;
  const base = { black: levels.BLACK, white: levels.WHITE, gamma: levels.GAMMA, bin: false, thresh: levels.THRESH, color, sharpen: sh };
  if (name === "custom") return { name, ...base, pt: presets.MEDIUM, ...custom };
  const pt = presets[name.toUpperCase()];
  return Number.isFinite(pt) ? { name, ...base, pt } : null;
}

// The line weight as transform_json stores it (`render`: not needed to show the plan, kept to render it again), and back.
// sharpen is written only when on, so a plan saved without it reads as before (and an older record, without it, as 0).
export const renderBlock = (P) => (P ? { line_weight: P.name, pt: P.pt, black: P.black, white: P.white, gamma: P.gamma, binarize: !!P.bin, threshold: P.thresh, color: !!P.color, ...(P.sharpen > 0 ? { sharpen: P.sharpen } : {}) } : null);
export const settingsFromRender = (r) => (r && Number.isFinite(r.pt)
  ? { name: r.line_weight ?? "custom", pt: r.pt, black: r.black, white: r.white, gamma: r.gamma, bin: !!r.binarize, thresh: r.threshold, color: !!r.color, sharpen: Number(r.sharpen) > 0 ? Number(r.sharpen) : 0 }
  : null);
