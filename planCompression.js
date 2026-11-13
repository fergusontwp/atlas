// Deciding how a rendered plan becomes an attachment that fits. No DOM and no SDK imports, so it can be tested alone;
// the encoders it calls are passed in (compressWorker.js supplies the real ones).
//
// The render is at the page's native detail (the ceiling, pageRaster.js), so the saved image's resolution comes from the
// byte budget: every same-size form is tried first, best first, and only when none fits is the size reduced.
//
//   asis        the first PNG (the browser's) as it is
//   lossless    pixel-identical, fewer bytes per pixel (no alpha, 1-bit, gray or an exact palette)
//   quantized   a palette of at most 256 colors, no dithering
//   jpeg        not for flat linework: full size, quality searched from JPEG_QUALITY_START down to JPEG_QUALITY_FLOOR
//   then, only if nothing above fits, the size is reduced:
//   downscaled  the palette PNG at the largest size that fits (always for flat linework)
//   jpeg        (scaleFactor < 1) the JPEG at the floor quality at the largest size that fits. For anything but flat
//               linework both are tried: one search step each, then the one whose bytes promise the larger size is
//               searched to the end (palette and JPEG bytes shrink at different rates, so the smaller at full size
//               isn't always the one that keeps more detail)
//   tiled       full-resolution PNG tiles, each within TILE_MAX_BYTES and TILE_MAX_SIDE_PX, attached to the same record
//
// The size search (searchScale) starts from the full-size attempt's bytes with s * sqrt(budget / bytes) * SAFETY, then
// follows the byte curve measured from its own attempts, and keeps the largest attempt that fit. It has no floor: an
// image that ends up under GEOREF.MIN_DPI is saved with a warning. A scale is never above 1: nothing is enlarged.

import { gridForBytes, refineGrid, tileGrid } from "./tiling.js";

export const TIERS = ["asis", "lossless", "quantized", "jpeg", "downscaled", "tiled"];

// The rungs in order. Flat linework never gets JPEG (a palette keeps its edges sharp). Anything else tries JPEG at full
// size, then is reduced in size as the palette PNG or the JPEG, whichever reaches the larger size ("reduced").
export const ladder = ({ flat = false } = {}) => (flat
  ? ["asis", "lossless", "quantized", "downscaled", "tiled"]
  : ["asis", "lossless", "quantized", "jpeg", "reduced", "tiled"]);

// Whether source.pdf goes on the record: a PDF over the cap is left off (pdf_attached = No).
export const pdfAttaches = (pdfBytes, pdfMaxBytes) => Number.isFinite(pdfBytes) && pdfBytes > 0 && pdfBytes <= pdfMaxBytes;

// The bytes the image may use. "combined" (the default, and anything but "per_file"): TARGET_BYTES less source.pdf when
// the PDF will be attached; "per_file": all of TARGET_BYTES. The PDF itself is attached unchanged, never padded.
// attach: whether the user asked for the PDF to be attached ("Attach source PDF"); not asked, the image gets all of
// TARGET_BYTES in either mode. Returns { budget, reserved, pdfAttached }.
export function imageBudget({ mode, targetBytes, pdfBytes, pdfMaxBytes = targetBytes, attach = true }) {
  const pdfAttached = !!attach && pdfAttaches(pdfBytes, pdfMaxBytes);
  const reserved = mode !== "per_file" && pdfAttached ? pdfBytes : 0;
  return { budget: Math.max(0, targetBytes - reserved), reserved, pdfAttached };
}

// The highest quality (to 0.01) whose output fits, between floor and start: start is tried first, then floor, then a
// binary search. encode(quality) resolves to { bytes, ... }. Resolves to { quality, result }, or null when even the
// floor is too big.
export async function searchQuality(encode, target, { start, floor }) {
  const hundredths = (q) => Math.round(q * 100);
  const attempt = async (h) => ({ h, result: await encode(h / 100) });
  const top = await attempt(hundredths(start));
  if (top.result.bytes <= target) return { quality: top.h / 100, result: top.result };
  let lo = await attempt(hundredths(floor)); // the best known that fits
  if (lo.result.bytes > target) return null;
  let hi = hundredths(start); // known not to fit
  while (hi - lo.h > 1) {
    const mid = Math.floor((lo.h + hi) / 2);
    const m = await attempt(mid);
    if (m.result.bytes <= target) lo = m;
    else hi = mid;
  }
  return { quality: lo.h / 100, result: lo.result };
}

// The size search, one step at a time: the largest linear scale, below start.scale, whose encode fits the budget.
// start: { scale, bytes } an attempt that didn't fit. next() gives the scale to encode next (null when the search is
// over) and record() takes what it came to; best is the largest attempt that fit so far, { scale, bytes, result }.
// Bytes are modelled as bytes(s) = ref.bytes * (s / ref.scale)^k from the latest attempt. The first step assumes k = 2
// (bytes follow the pixel count) and aims SAFETY² under the budget, which is s * sqrt(budget / bytes) * SAFETY; later
// steps measure k from the last two attempts and aim at the middle of the tolerance band. A step that would leave what is
// already known (above the smallest miss, or not above the largest fit) bisects instead. The search ends within the
// tolerance under the budget, after maxAttempts encodes, or when nothing is left to try.
// options: { maxAttempts, tolerance, safety, minScale }.
export function scaleSearch(budget, start, { maxAttempts = 5, tolerance = 0.03, safety = 0.97, minScale = 0 } = {}) {
  let fit = null;
  let miss = start.scale; // the smallest scale known not to fit
  let ref = start;
  let prev = null;
  let n = 0;
  let done = false;
  return {
    next() {
      if (done || n >= maxAttempts) return null;
      let k = 2;
      if (prev && prev.scale !== ref.scale && prev.bytes > 0 && ref.bytes > 0) {
        const measured = Math.log(prev.bytes / ref.bytes) / Math.log(prev.scale / ref.scale);
        if (Number.isFinite(measured)) k = Math.min(4, Math.max(0.5, measured));
      }
      const aim = n === 0 ? safety * safety : 1 - tolerance / 2;
      let s = ref.bytes > 0 ? ref.scale * Math.pow((aim * budget) / ref.bytes, 1 / k) : (fit ? (fit.scale + miss) / 2 : miss * safety);
      if (fit) {
        if (!(s > fit.scale && s < miss)) s = (fit.scale + miss) / 2;
      } else if (!(s < miss)) s = miss * safety * safety;
      s = Math.max(s, minScale);
      // the smallest allowed size didn't fit either, or nothing is left between what fits and what doesn't
      if (s >= miss || (fit && miss - fit.scale < 1e-4)) { done = true; return null; }
      return s;
    },
    record(scale, bytes, result) {
      n++;
      const attempt = { scale, bytes, result };
      if (bytes <= budget) {
        if (!fit || scale > fit.scale) fit = attempt;
        if (bytes >= (1 - tolerance) * budget) done = true;
      } else miss = Math.min(miss, scale);
      prev = ref;
      ref = attempt;
    },
    get best() { return fit; },
  };
}

// The whole search with one encoder: encode(scale) resolves to { bytes, ... }. Resolves to the largest attempt that fit,
// { scale, bytes, result }, or null when none did.
export async function searchScale(encode, budget, start, options) {
  const search = scaleSearch(budget, start, options);
  for (let s = search.next(); s !== null; s = search.next()) {
    const result = await encode(s);
    search.record(s, result.bytes, result);
  }
  return search.best;
}

// A byte count extrapolated from two probes { scale, [key] }: bytes follow p1[key] * (s / p1.scale)^k with k measured
// from the pair (about 1 for clean linework, whose bytes follow its edges; about 2 for a noisy scan, which follows the
// pixel count), clamped to 0.5..3. A single probe assumes k = 2. Returns { k, at(s) }.
function curve([p1, p2], key) {
  let k = 2;
  if (p2 && p1.scale !== p2.scale && p1[key] > 0 && p2[key] > 0) {
    const measured = Math.log(p1[key] / p2[key]) / Math.log(p1.scale / p2.scale);
    if (Number.isFinite(measured)) k = Math.min(3, Math.max(0.5, measured));
  }
  return { k, at: (s) => p1[key] * Math.pow(s / p1.scale, k) };
}

// An estimate before the full render (no longer shown: the saved resolution moved to Review, which has the real sizes),
// following the ladder: two probes of the crop rendered at linear scales
// p1.scale > p2.scale of the render, each encoded as the first PNG ({ asis } bytes, optional) and as the lossless rung
// ({ bytes }). At full size the first PNG is used if it fits, else the lossless PNG; if neither fits, the size the
// lossless curve brings within the tolerance under the budget (the later rungs are smaller still, so this errs low).
// Returns { form: "asis" | "lossless" | "reduced", fullBytes, scale, bytes, k }: the lossless bytes at full size, and the
// scale (at most 1) and bytes expected.
export function estimateFromProbes(probes, budget, { tolerance = 0.03 } = {}) {
  const lossless = curve(probes, "bytes");
  const fullBytes = lossless.at(1);
  if (probes[0].asis > 0) {
    const asis = curve(probes, "asis").at(1);
    if (asis <= budget) return { form: "asis", fullBytes, scale: 1, bytes: asis, k: lossless.k };
  }
  if (fullBytes <= budget) return { form: "lossless", fullBytes, scale: 1, bytes: fullBytes, k: lossless.k };
  const [p1] = probes;
  const scale = Math.min(1, p1.scale * Math.pow(((1 - tolerance / 2) * budget) / p1.bytes, 1 / lossless.k));
  return { form: "reduced", fullBytes, scale, bytes: lossless.at(scale), k: lossless.k };
}

// The linear scales of the estimate's two probes for a W x H render: the larger at most maxPixels (the whole render when it
// is that small), the other half its size.
export function probeScales(W, H, maxPixels) {
  const s1 = Math.min(1, Math.sqrt(maxPixels / Math.max(1, W * H)));
  return [s1, s1 / 2];
}

const aborted = (signal) => {
  if (signal?.aborted) throw new DOMException("Compression was cancelled", "AbortError");
};

// Runs the ladder.
//   initialBytes  the size of the rendered canvas as one PNG        width, height  the render's size in pixels
//   flat          true for flat linework (no JPEG), or an async function that works it out (only called once the
//                 same-size PNG rungs have failed, since it reads every pixel)
//   budget        bytes the image may use (imageBudget; defaults to comp.TARGET_BYTES)
//   comp          PLANS.COMPRESSION
//   ops           the encoders, each resolving to a candidate { files: [{ name, type, bytes, ... }], width, height }:
//                   asis()
//                   lossless({ scale })     quantized({ scale })     jpeg({ scale, quality })
//                   tile({ cols, rows })    (full-resolution tiles of the whole image)
//                 scale is the linear factor against the render (1 = full size). Everything but asis and tile is
//                 resampled to it.
//   onProgress    ({ tier, scale?, quality?, attempt }) before each encode      signal  an AbortSignal
//   skipAsis      start at the lossless rung (a binarized line weight: its 1-bit form beats the browser's PNG)
// Resolves to { ok: true, tier, scaleFactor, quality?, files, width, height, tileCount, origBytes, finalBytes, budget,
// flat, attempts } or { ok: false, reason: "too-large", attempts } when nothing fits (even the smallest tiles).
export async function runLadder({ initialBytes, width, height, flat = false, budget, comp, ops, onProgress = () => {}, signal, skipAsis = false }) {
  const limit = Number.isFinite(budget) ? budget : comp.TARGET_BYTES;
  const S = { MAX_ATTEMPTS: 5, TOLERANCE: 0.03, SAFETY: 0.97, ...comp.SEARCH };
  const searchOptions = { maxAttempts: S.MAX_ATTEMPTS, tolerance: S.TOLERANCE, safety: S.SAFETY, minScale: Math.min(1, 16 / Math.max(width, height)) };
  const attempts = [];
  let isFlat = typeof flat === "function" ? null : !!flat;
  const sum = (c) => c.files.reduce((n, f) => n + f.bytes, 0);
  const fits = (c) => sum(c) <= limit;
  const note = (tier, extra, candidate, ok) => attempts.push({ tier, ...extra, bytes: candidate ? sum(candidate) : null, fits: ok });
  const done = (tier, scaleFactor, candidate, extra = {}) => ({
    ok: true, tier, scaleFactor, ...extra, files: candidate.files, width: candidate.width, height: candidate.height,
    tileCount: candidate.files.length, origBytes: initialBytes, finalBytes: sum(candidate), budget: limit, flat: isFlat, attempts,
  });
  const progress = (info) => {
    aborted(signal);
    onProgress({ ...info, attempt: attempts.length + 1 });
    aborted(signal); // a cancel may come from the progress callback itself
  };
  // one same-size or resized encode, recorded
  const tryEncode = async (tier, op, args) => {
    progress({ tier, ...args });
    const c = await ops[op](args);
    note(tier, args, c, fits(c));
    return c;
  };

  // ---- the same size, best first
  if (!skipAsis) {
    progress({ tier: "asis" });
    const first = await ops.asis();
    note("asis", { scale: 1 }, first, fits(first));
    if (fits(first)) return done("asis", 1, first);
  }
  const lossless = await tryEncode("lossless", "lossless", { scale: 1 });
  if (fits(lossless)) return done("lossless", 1, lossless);
  const palette = await tryEncode("quantized", "quantized", { scale: 1 });
  if (fits(palette)) return done("quantized", 1, palette);

  if (isFlat === null) {
    aborted(signal);
    isFlat = !!(await flat());
  }

  // ---- JPEG at full size, quality searched (never for flat linework)
  let jpegFloorBytes = null;
  if (!isFlat) {
    const found = await searchQuality(async (quality) => {
      const c = await tryEncode("jpeg", "jpeg", { scale: 1, quality });
      if (Math.round(quality * 100) === Math.round(comp.JPEG_QUALITY_FLOOR * 100)) jpegFloorBytes = sum(c);
      return { bytes: sum(c), candidate: c };
    }, limit, { start: comp.JPEG_QUALITY_START, floor: comp.JPEG_QUALITY_FLOOR });
    if (found) return done("jpeg", 1, found.result.candidate, { quality: found.quality });
  }

  // ---- only now a smaller size: the largest that fits
  const q = comp.JPEG_QUALITY_FLOOR;
  const ways = [{ tier: "downscaled", op: "quantized", args: (scale) => ({ scale }), search: scaleSearch(limit, { scale: 1, bytes: sum(palette) }, searchOptions) }];
  if (!isFlat && jpegFloorBytes > 0) ways.push({ tier: "jpeg", op: "jpeg", args: (scale) => ({ scale, quality: q }), quality: q, search: scaleSearch(limit, { scale: 1, bytes: jpegFloorBytes }, searchOptions) });
  const step = async (way) => {
    const scale = way.search.next();
    if (scale === null) return false;
    const c = await tryEncode(way.tier, way.op, way.args(scale));
    way.search.record(scale, sum(c), c);
    return true;
  };
  // one step each, then the one that promises the larger size (palette first on a tie) goes on to the end
  for (const way of ways) await step(way);
  const promise = (way) => Math.max(way.search.best?.scale ?? 0, way.search.next() ?? 0);
  const lead = ways.reduce((a, b) => (promise(b) > promise(a) ? b : a));
  while (await step(lead)) { /* searching */ }
  let winner = null;
  for (const way of ways) if (way.search.best && !(winner && winner.search.best.scale >= way.search.best.scale)) winner = way;
  if (winner) return done(winner.tier, winner.search.best.scale, winner.search.best.result, winner.quality ? { quality: winner.quality } : {});

  // ---- full-resolution tiles, the last resort
  let grid = gridForBytes(width, height, { estimatedBytes: initialBytes, tileMaxBytes: comp.TILE_MAX_BYTES, maxSide: comp.TILE_MAX_SIDE_PX });
  while (grid) {
    progress({ tier: "tiled" });
    const c = await ops.tile(grid);
    const ok = c.files.every((f) => f.bytes <= comp.TILE_MAX_BYTES);
    note("tiled", { cols: grid.cols, rows: grid.rows }, c, ok);
    if (ok) return done("tiled", 1, c);
    grid = refineGrid(grid, width, height);
  }
  return { ok: false, reason: "too-large", attempts };
}

// Tile descriptors for a grid, for the encoder that implements ops.tile.
export const tilesFor = (width, height, { cols, rows }) => tileGrid(width, height, cols, rows);
