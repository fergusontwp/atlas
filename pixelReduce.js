// Fewer bytes per pixel for a rendered plan: the lossless reductions (pixel-identical) and a median-cut palette
// quantizer (lossy, no dithering). No DOM and no SDK imports, so it runs in Node, a page or a worker.
// Input is RGBA bytes (a canvas's ImageData) with width * height pixels; the output feeds pngEncode.js.

const MAX_PALETTE = 256;
const BIN_BITS = 6; // colors are binned to 6 bits a channel (262,144 bins) for the share and the median cut
const BIN_SHIFT = 8 - BIN_BITS;
const binOf = (r, g, b) => ((r >> BIN_SHIFT) << (2 * BIN_BITS)) | ((g >> BIN_SHIFT) << BIN_BITS) | (b >> BIN_SHIFT);

// What the pixels contain: { opaque, gray, bw, colors, palette }.
//   opaque  every alpha is 255        gray  every pixel has R = G = B
//   bw      every pixel is pure black or pure white (and opaque)
//   colors  distinct RGBA values, counted up to maxColors + 1 (more than that is just "too many")
//   palette RGBA entries (4 bytes each, in order of first appearance) when colors <= maxColors, else null
export function scanPixels(rgba, maxColors = MAX_PALETTE) {
  let opaque = true, gray = true, bw = true;
  const seen = new Map();
  let tracking = true;
  let last = -1;
  const entries = [];
  for (let i = 0; i < rgba.length; i += 4) {
    const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2], a = rgba[i + 3];
    const key = ((r << 24) | (g << 16) | (b << 8) | a) >>> 0;
    if (key === last) continue; // runs of one color are common in line drawings
    last = key;
    if (a !== 255) opaque = false;
    if (r !== g || g !== b) gray = false;
    if (!(r === g && g === b && (r === 0 || r === 255) && a === 255)) bw = false;
    if (tracking && !seen.has(key)) {
      seen.set(key, seen.size);
      entries.push(r, g, b, a);
      if (seen.size > maxColors) tracking = false;
    }
  }
  const colors = seen.size;
  return { opaque, gray, bw, colors, palette: colors <= maxColors ? Uint8Array.from(entries) : null };
}

// Index of each pixel in a palette of RGBA entries (built by scanPixels).
function indexPixels(rgba, paletteRgba) {
  const lookup = new Map();
  for (let p = 0; p < paletteRgba.length; p += 4) {
    lookup.set(((paletteRgba[p] << 24) | (paletteRgba[p + 1] << 16) | (paletteRgba[p + 2] << 8) | paletteRgba[p + 3]) >>> 0, p / 4);
  }
  const out = new Uint8Array(rgba.length / 4);
  let lastKey = -1, lastIdx = 0;
  for (let i = 0, j = 0; i < rgba.length; i += 4, j++) {
    const key = ((rgba[i] << 24) | (rgba[i + 1] << 16) | (rgba[i + 2] << 8) | rgba[i + 3]) >>> 0;
    if (key !== lastKey) { lastKey = key; lastIdx = lookup.get(key); }
    out[j] = lastIdx;
  }
  return out;
}

function splitPalette(paletteRgba) {
  const n = paletteRgba.length / 4;
  const rgb = new Uint8Array(n * 3);
  const alpha = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    rgb.set(paletteRgba.subarray(i * 4, i * 4 + 3), i * 3);
    alpha[i] = paletteRgba[i * 4 + 3];
  }
  return { rgb, alpha };
}

// The smallest exact (pixel-identical) form of the image, as an argument for encodePng:
//   an unused alpha channel is dropped, then pure black and white becomes "gray1", R = G = B becomes "gray",
//   256 colors or fewer an exact "indexed" palette, and anything else "rgb" (or "rgba" if it really is transparent).
// `stats` may be passed if scanPixels has already run.
export function reduceLossless(rgba, width, height, stats = scanPixels(rgba)) {
  const n = width * height;
  if (stats.opaque) {
    if (stats.bw) {
      const data = new Uint8Array(n);
      for (let i = 0; i < n; i++) data[i] = rgba[i * 4] ? 1 : 0;
      return { width, height, format: "gray1", data };
    }
    if (stats.gray) {
      const data = new Uint8Array(n);
      for (let i = 0; i < n; i++) data[i] = rgba[i * 4];
      return { width, height, format: "gray", data };
    }
  }
  if (stats.palette) {
    const { rgb, alpha } = splitPalette(stats.palette);
    return { width, height, format: "indexed", data: indexPixels(rgba, stats.palette), palette: rgb, paletteAlpha: stats.opaque ? undefined : alpha };
  }
  if (stats.opaque) {
    const data = new Uint8Array(n * 3);
    for (let i = 0; i < n; i++) {
      data[i * 3] = rgba[i * 4];
      data[i * 3 + 1] = rgba[i * 4 + 1];
      data[i * 3 + 2] = rgba[i * 4 + 2];
    }
    return { width, height, format: "rgb", data };
  }
  return { width, height, format: "rgba", data: rgba };
}

// The share of pixels (0 to 1) that fall in the `top` most common colors (colors binned to 6 bits a channel). Line
// drawings are nearly all paper and ink, so this is close to 1; a photograph's is small.
export function topColorShare(rgba, top = 16) {
  const count = new Uint32Array(1 << (3 * BIN_BITS));
  for (let i = 0; i < rgba.length; i += 4) count[binOf(rgba[i], rgba[i + 1], rgba[i + 2])]++;
  const biggest = Array.from(count).filter((c) => c > 0).sort((a, b) => b - a).slice(0, top);
  return biggest.reduce((s, c) => s + c, 0) / (rgba.length / 4);
}

// ---- median cut


// A palette of at most maxColors colors for the image, and the index of every pixel. Lossy, no dithering. Pixels with
// transparency are laid over white first (a rendered page is opaque, so this is only a safeguard). An image that
// already has maxColors colors or fewer is returned exactly. Otherwise the colors are cut by median cut on a 6-bit
// histogram, each palette entry is the average of the real colors it stands for, and the most common color (the paper)
// is kept exactly, so white stays white. Returns { width, height, format: "indexed", data, palette, exact }.
export function quantize(rgba, width, height, maxColors = MAX_PALETTE) {
  const n = width * height;
  const flat = new Uint8Array(rgba); // over white, so alpha can be ignored from here on
  for (let i = 0; i < flat.length; i += 4) {
    const a = flat[i + 3];
    if (a !== 255) {
      for (let c = 0; c < 3; c++) flat[i + c] = Math.round((flat[i + c] * a + 255 * (255 - a)) / 255);
      flat[i + 3] = 255;
    }
  }
  const stats = scanPixels(flat, maxColors);
  if (stats.palette) {
    const { rgb } = splitPalette(stats.palette);
    return { width, height, format: "indexed", data: indexPixels(flat, stats.palette), palette: rgb, exact: true };
  }

  // histogram (count and color sums per bin), and the majority color by Boyer-Moore voting
  const BINS = 1 << (3 * BIN_BITS);
  const count = new Float64Array(BINS), sumR = new Float64Array(BINS), sumG = new Float64Array(BINS), sumB = new Float64Array(BINS);
  let candidate = -1, votes = 0;
  for (let i = 0; i < flat.length; i += 4) {
    const r = flat[i], g = flat[i + 1], b = flat[i + 2];
    const bin = binOf(r, g, b);
    count[bin]++; sumR[bin] += r; sumG[bin] += g; sumB[bin] += b;
    const key = (r << 16) | (g << 8) | b;
    if (votes === 0) { candidate = key; votes = 1; } else if (key === candidate) votes++; else votes--;
  }
  const occupied = [];
  for (let bin = 0; bin < BINS; bin++) if (count[bin]) occupied.push(bin);
  const channel = (bin, c) => (c === 0 ? sumR[bin] : c === 1 ? sumG[bin] : sumB[bin]) / count[bin]; // mean of one channel in a bin

  // a box is a list of bins; its score is population times its widest channel range
  const boxOf = (bins) => {
    let pop = 0;
    const lo = [255, 255, 255], hi = [0, 0, 0];
    for (const bin of bins) {
      pop += count[bin];
      for (let c = 0; c < 3; c++) {
        const v = channel(bin, c);
        if (v < lo[c]) lo[c] = v;
        if (v > hi[c]) hi[c] = v;
      }
    }
    const ranges = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
    const axis = ranges.indexOf(Math.max(...ranges));
    return { bins, pop, axis, range: ranges[axis] };
  };
  const boxes = [boxOf(occupied)];
  while (boxes.length < maxColors) {
    let pick = -1, best = 0;
    boxes.forEach((box, i) => {
      const score = box.bins.length > 1 && box.range > 0 ? box.pop * box.range : 0;
      if (score > best) { best = score; pick = i; }
    });
    if (pick < 0) break;
    const { bins, pop, axis } = boxes[pick];
    const sorted = [...bins].sort((p, q) => channel(p, axis) - channel(q, axis));
    let acc = 0, cut = 1;
    for (let i = 0; i < sorted.length - 1; i++) {
      acc += count[sorted[i]];
      cut = i + 1;
      if (acc >= pop / 2) break;
    }
    boxes.splice(pick, 1, boxOf(sorted.slice(0, cut)), boxOf(sorted.slice(cut)));
  }

  // palette entries and the bin-to-entry map; the majority color's entry is that exact color
  const palette = new Uint8Array(boxes.length * 3);
  const binToIndex = new Uint16Array(BINS);
  const candidateBin = binOf(candidate >> 16, (candidate >> 8) & 255, candidate & 255);
  boxes.forEach((box, k) => {
    let pop = 0, r = 0, g = 0, b = 0;
    for (const bin of box.bins) {
      pop += count[bin]; r += sumR[bin]; g += sumG[bin]; b += sumB[bin];
      binToIndex[bin] = k;
    }
    const pinned = box.bins.includes(candidateBin);
    palette[k * 3] = pinned ? candidate >> 16 : Math.round(r / pop);
    palette[k * 3 + 1] = pinned ? (candidate >> 8) & 255 : Math.round(g / pop);
    palette[k * 3 + 2] = pinned ? candidate & 255 : Math.round(b / pop);
  });
  const data = new Uint8Array(n);
  for (let i = 0, j = 0; i < flat.length; i += 4, j++) data[j] = binToIndex[binOf(flat[i], flat[i + 1], flat[i + 2])];
  return { width, height, format: "indexed", data, palette, exact: false };
}
