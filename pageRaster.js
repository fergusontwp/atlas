// The contract between "a PDF page became an image" and the georeferencing maths, plus the pure arithmetic around it.
// No DOM and no SDK imports, so it can be tested alone.
//
// Whatever turns a PDF page into pixels must give the maths this record, and nothing else:
//   { pageWidthPt, pageHeightPt,   the page at scale 1 (rotation and crop box already applied), in PDF points
//     crop: { x0, y0, x1, y1 },    the part of the page that became the image, in points (page space, y down)
//     dpi,                         pixels per inch of the render (pixels per point = dpi / 72)
//     W, H,                        the raster's size in pixels = round(crop size in points * dpi / 72)
//     canvas }                     the pixels (not used by the maths, so tests can leave it out)
//
// Pixel indices are 0-based and refer to pixel CENTRES, like Paint and the world file: pixel (0, 0) is centred half a
// pixel in from the crop's top-left corner. Page points have no such offset, hence the +0.5 and -0.5 below.

// W and H for a crop rendered at a dpi.
export function rasterSize(crop, dpi) {
  const s = dpi / 72;
  return { W: Math.round((crop.x1 - crop.x0) * s), H: Math.round((crop.y1 - crop.y0) * s) };
}

// The record, with W and H worked out from the crop and dpi.
export function makeRaster({ pageWidthPt, pageHeightPt, crop, dpi, canvas = null }) {
  const { W, H } = rasterSize(crop, dpi);
  return { pageWidthPt, pageHeightPt, crop: { ...crop }, dpi, W, H, canvas };
}

// A pixel index (0-based, centre) in the raster to a page point.
export function pxToPt(raster, col, row) {
  const s = raster.dpi / 72;
  return { x: raster.crop.x0 + (col + 0.5) / s, y: raster.crop.y0 + (row + 0.5) / s };
}

// A page point to a pixel index (fractional) in the raster.
export function ptToPx(raster, x, y) {
  const s = raster.dpi / 72;
  return { col: (x - raster.crop.x0) * s - 0.5, row: (y - raster.crop.y0) * s - 0.5 };
}

// What a render would cost: pixels, megapixels and a rough memory figure (RGBA, plus about a third for the
// browser's own copies), the numbers step 2 shows before anything is rendered.
export function rasterCost(W, H) {
  const pixels = W * H;
  const megapixels = pixels / 1e6;
  return { pixels, megapixels, memoryMB: Math.round(megapixels * 4 * 1.34) };
}

// Ground feet per pixel for a stated scale (feet of ground per printed inch) at a dpi.
export const groundFtPerPx = (ftPerInch, dpi) => ftPerInch / dpi;

// The render resolution to suggest. input: { ftPerInch, cropWidthIn, cropHeightIn }, ftPerInch the stated scale in
// ground feet per printed inch ("1 in = 40 ft" is 40), or null/0 when none is stated yet.
// limits: { dpi: { DEFAULT, MIN, MAX, PRESETS, TARGET_FT_PER_PX }, maxPixels, maxSidePx }.
//
// The wish is TARGET_FT_PER_PX of ground per pixel (dpi = ftPerInch / target), kept within MIN..MAX and snapped to the
// nearest preset (a tie goes to the finer one); with no stated scale it is DEFAULT. Then the pixel caps lower it if the
// crop would be too big: the answer never produces a raster over maxPixels or with a side over maxSidePx.
// Returns { wanted, dpi, capped, W, H, groundFtPerPx } where
//   wanted  the resolution before the caps (a preset), dpi the one to use,
//   capped  null, "side" (maxSidePx lowered it) or "pixels" (maxPixels did).
export function suggestDpi({ ftPerInch, cropWidthIn, cropHeightIn }, { dpi: cfg, maxPixels, maxSidePx }) {
  let wanted = cfg.DEFAULT;
  if (ftPerInch > 0 && Number.isFinite(ftPerInch)) {
    const raw = Math.min(cfg.MAX, Math.max(cfg.MIN, ftPerInch / cfg.TARGET_FT_PER_PX));
    wanted = cfg.PRESETS.reduce((best, p) => {
      const d = Math.abs(p - raw);
      const bd = Math.abs(best - raw);
      return d < bd || (d === bd && p > best) ? p : best;
    }, cfg.PRESETS[0]);
  }

  // The largest dpi up to the wish whose rounded size fits both caps. The floors below are a starting guess; rounding
  // can allow one more or one less, so step from there.
  const area = cropWidthIn * cropHeightIn;
  const longest = Math.max(cropWidthIn, cropHeightIn);
  const sideLimit = longest > 0 ? Math.floor(maxSidePx / longest) : Infinity;
  const pixelLimit = area > 0 ? Math.floor(Math.sqrt(maxPixels / area)) : Infinity;
  const size = (d) => rasterSize({ x0: 0, y0: 0, x1: cropWidthIn * 72, y1: cropHeightIn * 72 }, d);
  const fits = (d) => {
    const { W, H } = size(d);
    return Math.max(W, H) <= maxSidePx && W * H <= maxPixels;
  };
  let dpi = Math.max(1, Math.min(wanted, sideLimit, pixelLimit));
  while (dpi < wanted && fits(dpi + 1)) dpi++;
  while (dpi > 1 && !fits(dpi)) dpi--;
  let capped = null;
  if (dpi < wanted) capped = Math.max(size(dpi + 1).W, size(dpi + 1).H) > maxSidePx ? "side" : "pixels";
  const { W, H } = size(dpi);
  return { wanted, dpi, capped, W, H, groundFtPerPx: ftPerInch > 0 ? groundFtPerPx(ftPerInch, dpi) : null };
}

// The scale (pixels per point) of the whole-page preview used for cropping: about targetPx on the long side, but never
// below 1 or above 4 pixels per point.
export const previewScale = (pageWidthPt, pageHeightPt, targetPx) => Math.min(4, Math.max(1, targetPx / Math.max(pageWidthPt, pageHeightPt)));

// Why a render of W x H pixels can't be made (a sentence to show), or null if it can.
export function renderProblem(W, H, { maxPixels, minSide = 8 }) {
  if (W < minSide || H < minSide) return "The crop is too small.";
  if (W * H > maxPixels) return `That is ${Math.round((W * H) / 1e6)} megapixels. Lower the DPI or tighten the crop (limit ${maxPixels / 1e6}).`;
  return null;
}

// The name of a standard sheet size (ANSI, ARCH, ISO) a page matches within 0.2 in either way round, or "".
// sheets: [[name, shortSideIn, longSideIn], ...]
export function sheetName(pageWidthPt, pageHeightPt, sheets) {
  const short = Math.min(pageWidthPt, pageHeightPt) / 72;
  const long = Math.max(pageWidthPt, pageHeightPt) / 72;
  const hit = sheets.find(([, a, b]) => Math.abs(a - short) < 0.2 && Math.abs(b - long) < 0.2);
  return hit ? hit[0] : "";
}
