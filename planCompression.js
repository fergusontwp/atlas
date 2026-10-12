// Deciding how a rendered plan becomes an attachment that fits. No DOM and no SDK imports, so it can be tested alone;
// the encoders it calls are passed in (compressWorker.js supplies the real ones).
//
// The size of the first PNG (the rendered canvas encoded once) only picks the starting rung. After every attempt the
// real size is checked against the target, and a miss falls through to the next rung until something fits:
//
//   asis        the first PNG as it is
//   lossless    pixel-identical, fewer bytes per pixel (no alpha, 1-bit, gray or an exact palette)
//   quantized   a palette of at most 256 colors, no dithering
//   downscaled  the same palette PNG, smaller by DOWNSCALE_STEP each try down to DOWNSCALE_FLOOR (linear)
//   jpeg        full size, quality searched down to JPEG_QUALITY_FLOOR (never for flat linework: reduced PNG looks better)
//   tiled       full-resolution PNG tiles, each at most TILE_MAX_BYTES, attached to the same record
//
// The longest side is always capped at MAX_SIDE_PX first (a bigger image silently fails to draw on some GPUs), except
// for tiles, which are each within it.

import { gridForBytes, refineGrid, tileGrid } from "./tiling.js";

export const TIERS = ["asis", "lossless", "quantized", "downscaled", "jpeg", "tiled"];

// The rung to start at for a first PNG of initialBytes. Flat linework skips the JPEG rung.
export function startTier(initialBytes, comp, { flat = false } = {}) {
  const { TARGET_BYTES, TIER_LIMITS } = comp;
  let tier;
  if (initialBytes <= TARGET_BYTES) tier = "asis";
  else if (initialBytes <= TIER_LIMITS.LOSSLESS) tier = "lossless";
  else if (initialBytes <= TIER_LIMITS.QUANTIZED) tier = "quantized";
  else if (initialBytes <= TIER_LIMITS.JPEG) tier = "jpeg";
  else tier = "tiled";
  return tier === "jpeg" && flat ? "quantized" : tier;
}

// Linear scales to try after the full-size palette PNG: 0.9, 0.81, ... then the floor itself.
export function downscaleScales(step, floor) {
  const scales = [];
  let s = 1;
  while (s * step > floor + 1e-9) {
    s *= step;
    scales.push(s);
  }
  if (floor < 1) scales.push(floor);
  return scales;
}

// The linear factor that brings the longest side to maxSide (1 if it is within it already).
export const capScale = (W, H, maxSide) => Math.min(1, maxSide / Math.max(W, H));

// The rungs to try, in order, from the starting one. Flat linework never gets the JPEG rung.
export function ladder(start, { flat = false } = {}) {
  const from = TIERS.indexOf(start);
  if (from < 0) throw new Error(`Unknown compression tier "${start}"`);
  return TIERS.slice(from).filter((t) => !(t === "jpeg" && flat));
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

const aborted = (signal) => {
  if (signal?.aborted) throw new DOMException("Compression was cancelled", "AbortError");
};

// Runs the ladder.
//   initialBytes  the size of the rendered canvas as one PNG        width, height  the render's size in pixels
//   flat          true for flat linework (no JPEG)                   comp           PLANS.COMPRESSION
//   ops           the encoders, each resolving to a candidate { files: [{ name, type, bytes, ... }], width, height }:
//                   asis()
//                   lossless({ scale })     quantized({ scale })     jpeg({ scale, quality })
//                   tile({ cols, rows })    (full-resolution tiles of the whole image)
//                 scale is the linear factor against the render (1 = full size). Everything but asis and tile is
//                 resampled to it.
//   onProgress    ({ tier, scale?, quality?, attempt }) before each encode      signal  an AbortSignal
// Resolves to { ok: true, tier, scaleFactor, quality?, files, width, height, tileCount, origBytes, finalBytes, attempts }
// or { ok: false, reason: "too-large", attempts } when nothing fits (even the smallest tiles).
export async function runLadder({ initialBytes, width, height, flat = false, comp, ops, onProgress = () => {}, signal }) {
  const cap = capScale(width, height, comp.MAX_SIDE_PX);
  const attempts = [];
  const sum = (c) => c.files.reduce((n, f) => n + f.bytes, 0);
  const note = (tier, extra, candidate, fits) => attempts.push({ tier, ...extra, bytes: candidate ? sum(candidate) : null, fits });
  const done = (tier, scaleFactor, candidate, extra = {}) => ({
    ok: true, tier, scaleFactor, ...extra, files: candidate.files, width: candidate.width, height: candidate.height,
    tileCount: candidate.files.length, origBytes: initialBytes, finalBytes: sum(candidate), attempts,
  });
  const fitsOne = (c) => sum(c) <= comp.TARGET_BYTES;
  const progress = (info) => {
    aborted(signal);
    onProgress({ ...info, attempt: attempts.length + 1 });
    aborted(signal); // a cancel may come from the progress callback itself
  };

  // The first PNG can only be used as it is when no resampling is needed.
  const rungs = ladder(startTier(initialBytes, comp, { flat }), { flat }).filter((t) => !(t === "asis" && cap < 1));
  for (const tier of rungs) {
    if (tier === "asis") {
      progress({ tier });
      const c = await ops.asis();
      note(tier, { scale: 1 }, c, fitsOne(c));
      if (fitsOne(c)) return done(tier, 1, c);
    } else if (tier === "lossless" || tier === "quantized") {
      progress({ tier, scale: cap });
      const c = await ops[tier]({ scale: cap });
      note(tier, { scale: cap }, c, fitsOne(c));
      if (fitsOne(c)) return done(tier, cap, c);
    } else if (tier === "downscaled") {
      for (const s of downscaleScales(comp.DOWNSCALE_STEP, comp.DOWNSCALE_FLOOR)) {
        const scale = cap * s;
        progress({ tier, scale });
        const c = await ops.quantized({ scale });
        note(tier, { scale }, c, fitsOne(c));
        if (fitsOne(c)) return done(tier, scale, c);
      }
    } else if (tier === "jpeg") {
      progress({ tier, scale: cap });
      const found = await searchQuality(async (quality) => {
        progress({ tier, scale: cap, quality });
        const c = await ops.jpeg({ scale: cap, quality });
        note(tier, { scale: cap, quality }, c, fitsOne(c));
        return { bytes: sum(c), candidate: c };
      }, comp.TARGET_BYTES, { start: comp.JPEG_QUALITY_START, floor: comp.JPEG_QUALITY_FLOOR });
      if (found) return done(tier, cap, found.result.candidate, { quality: found.quality });
    } else if (tier === "tiled") {
      let grid = gridForBytes(width, height, { estimatedBytes: initialBytes, tileMaxBytes: comp.TILE_MAX_BYTES, maxSide: comp.MAX_SIDE_PX });
      while (grid) {
        progress({ tier });
        const c = await ops.tile(grid);
        const fits = c.files.every((f) => f.bytes <= comp.TILE_MAX_BYTES);
        note(tier, { cols: grid.cols, rows: grid.rows }, c, fits);
        if (fits) return done(tier, 1, c);
        grid = refineGrid(grid, width, height);
      }
    }
  }
  return { ok: false, reason: "too-large", attempts };
}

// Tile descriptors for a grid, for the encoder that implements ops.tile.
export const tilesFor = (width, height, { cols, rows }) => tileGrid(width, height, cols, rows);
