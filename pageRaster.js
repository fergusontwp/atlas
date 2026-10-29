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

// ---- the native-detail ceiling
// The render is made at the page's own detail, and the byte budget (planCompression.js) decides what is saved. A page that
// is embedded images (a scan, a mosaic) has a native resolution: the images' own pixels per inch. A vector page has none,
// so it gets MAX_DPI. Whatever the ceiling, the render stays within the browser safety limits (MAX_CANVAS_SIDE, MAX_PIXELS).

const mul = (m, n) => [
  m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
];
const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

// What a page paints, from its pdf.js operator list (page.getOperatorList() in pdf.js 6.4.299, whose OPLIST intent
// leaves the operators ungrouped). OPS is pdf.js's own table of operator codes; viewport is
// page.getViewport({ scale: 1 }).transform, which takes PDF user space to page points (y down, rotation and crop box
// applied), the space crops are in.
// Images: paintImageXObject [objId, width, height], paintImageMaskXObject [{ width, height }] and
// paintInlineImageXObject [{ width, height }], each painted into the unit square of the current transform, which save /
// restore, transform, form XObjects (their matrix) and groups change. Images inside annotations (stamps) are skipped.
// Vector work: painted paths (constructPath whose first argument is a painting operator), shadings, and text drawn in a
// visible rendering mode (OCR text in a scan is invisible, mode 3 or 7, so it doesn't count).
// Returns { images: [{ w, h, m, dpi }], vector } where m maps the image's unit square to page points and dpi is its
// pixels per inch along its finer axis.
export function readPageContent({ fnArray, argsArray }, OPS, viewport) {
  const PAINT = new Set(["stroke", "closeStroke", "fill", "eoFill", "fillStroke", "eoFillStroke", "closeFillStroke", "closeEOFillStroke"].map((k) => OPS[k]));
  const TEXT = new Set(["showText", "showSpacedText", "nextLineShowText", "nextLineSetSpacingShowText"].map((k) => OPS[k]));
  let state = { m: [...viewport], textMode: 0 };
  const stack = [];
  const push = () => stack.push(state);
  const pop = () => { if (stack.length) state = stack.pop(); };
  const images = [];
  let vector = 0;
  let annotations = 0;
  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i];
    const args = argsArray[i] ?? [];
    if (fn === OPS.save || fn === OPS.beginGroup) push();
    else if (fn === OPS.restore || fn === OPS.endGroup || fn === OPS.paintFormXObjectEnd) pop();
    else if (fn === OPS.transform) state = { ...state, m: mul(state.m, args) };
    else if (fn === OPS.paintFormXObjectBegin) {
      push();
      if (args[0]) state = { ...state, m: mul(state.m, Array.from(args[0])) };
    } else if (fn === OPS.beginAnnotation) { push(); annotations++; }
    else if (fn === OPS.endAnnotation) { pop(); annotations = Math.max(0, annotations - 1); }
    else if (fn === OPS.setTextRenderingMode) state = { ...state, textMode: Number(args[0]) || 0 };
    else if (annotations) continue;
    else if (fn === OPS.constructPath) { if (PAINT.has(args[0])) vector++; }
    else if (fn === OPS.shadingFill) vector++;
    else if (TEXT.has(fn)) { if (state.textMode % 4 !== 3) vector++; }
    else if (fn === OPS.paintImageXObject || fn === OPS.paintImageMaskXObject || fn === OPS.paintInlineImageXObject) {
      const w = fn === OPS.paintImageXObject ? args[1] : args[0]?.width;
      const h = fn === OPS.paintImageXObject ? args[2] : args[0]?.height;
      if (!(w > 0 && h > 0)) continue;
      const m = state.m;
      const lenX = Math.hypot(m[0], m[1]);
      const lenY = Math.hypot(m[2], m[3]);
      if (!(lenX > 0 && lenY > 0)) continue;
      images.push({ w, h, m: [...m], dpi: 72 * Math.max(w / lenX, h / lenY) });
    }
  }
  return { images, vector };
}

// How much of a crop the images cover, and the finest resolution among those that cover a real part of it (at least
// minShare of it, so a small logo doesn't set the ceiling). Sampled on an n x n grid of points over the crop.
// Returns { cover, dpi } (dpi null when no image covers enough).
export function imageCover(images, crop, { n = 40, minShare = 0.005 } = {}) {
  const inverse = images.map(({ m }) => {
    const det = m[0] * m[3] - m[1] * m[2];
    if (!det) return null;
    return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det];
  });
  const hits = new Array(images.length).fill(0);
  let covered = 0;
  const w = crop.x1 - crop.x0;
  const h = crop.y1 - crop.y0;
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const x = crop.x0 + ((c + 0.5) / n) * w;
      const y = crop.y0 + ((r + 0.5) / n) * h;
      let any = false;
      inverse.forEach((inv, k) => {
        if (!inv) return;
        const [u, v] = apply(inv, x, y);
        if (u >= 0 && u <= 1 && v >= 0 && v <= 1) { hits[k]++; any = true; }
      });
      if (any) covered++;
    }
  }
  const total = n * n;
  const dpis = images.filter((_, k) => hits[k] / total >= minShare).map((im) => im.dpi);
  return { cover: covered / total, dpi: dpis.length ? Math.max(...dpis) : null };
}

// The largest dpi up to `dpi` whose render of the crop fits the safety limits { maxSide, maxPixels }. Returns
// { dpi, capped } with capped null, "side" or "pixels" (the limit that lowered it).
export function fitDpi(crop, dpi, { maxSide, maxPixels }) {
  const fits = (d) => {
    const { W, H } = rasterSize(crop, d);
    return Math.max(W, H) <= maxSide && W * H <= maxPixels;
  };
  if (fits(dpi)) return { dpi, capped: null };
  const wPt = crop.x1 - crop.x0;
  const hPt = crop.y1 - crop.y0;
  const bySide = (maxSide * 72) / Math.max(wPt, hPt);
  const byPixels = 72 * Math.sqrt(maxPixels / (wPt * hPt));
  let d = Math.min(dpi, bySide, byPixels);
  for (let i = 0; i < 200 && d > 1 && !fits(d); i++) d *= 1 - 1e-4; // rounding to whole pixels can still go one over
  return { dpi: d, capped: bySide <= byPixels ? "side" : "pixels" };
}

// The render resolution for a crop: the ceiling, then the user's lower choice if any.
//   content   readPageContent's result, or null when the page couldn't be read
//   crop      page points          choice   a lower dpi the user picked, or null for the ceiling
//   limits    { maxDpi, raster: { COVER, MAX_VECTOR_OPS }, maxSide, maxPixels }
// The ceiling: a crop covered (raster.COVER or more) by images is "raster" at their native dpi; with more than
// raster.MAX_VECTOR_OPS vector items on the page as well it is "mixed", at the larger of native and maxDpi; anything
// else is "vector" (or "unknown" when the page couldn't be read) at maxDpi. Then the safety limits.
// Returns { kind, nativeDpi, ceilingDpi, capped, dpi, W, H } (ceilingDpi after the limits, dpi after the choice).
export function renderDpi({ content, crop, choice = null }, { maxDpi, raster, maxSide, maxPixels }) {
  let kind = "unknown";
  let nativeDpi = null;
  let wanted = maxDpi;
  if (content) {
    const { cover, dpi } = content.images.length ? imageCover(content.images, crop) : { cover: 0, dpi: null };
    if (dpi && cover >= raster.COVER) {
      nativeDpi = dpi;
      kind = content.vector > raster.MAX_VECTOR_OPS ? "mixed" : "raster";
      wanted = kind === "mixed" ? Math.max(dpi, maxDpi) : dpi;
    } else kind = "vector";
  }
  const { dpi: ceilingDpi, capped } = fitDpi(crop, wanted, { maxSide, maxPixels });
  const dpi = choice > 0 && choice < ceilingDpi ? choice : ceilingDpi;
  const { W, H } = rasterSize(crop, dpi);
  return { kind, nativeDpi, ceilingDpi, capped, dpi, W, H };
}

// The resolution each piece of a plan in pieces is rendered at, before the browser's size limits (a piece is rendered
// on its own, so the limits that capped the whole crop rarely reach it): the page's native detail (renderDpi's kind
// and nativeDpi), or the lower resolution the user chose. r: renderDpi's result; maxDpi: GEOREF.MAX_DPI.
export function pieceDpi(r, maxDpi, choice = null) {
  const wanted = r.kind === "raster" ? r.nativeDpi : r.kind === "mixed" ? Math.max(r.nativeDpi, maxDpi) : maxDpi;
  return choice > 0 && choice < wanted ? choice : wanted;
}

// The scale (pixels per point) of the whole-page preview used for cropping: about targetPx on the long side, but never
// below 1 or above 4 pixels per point.
export const previewScale = (pageWidthPt, pageHeightPt, targetPx) => Math.min(4, Math.max(1, targetPx / Math.max(pageWidthPt, pageHeightPt)));

// Why a render of W x H pixels can't be made (a sentence to show), or null if it can.
export function renderProblem(W, H, { maxPixels, maxSide = Infinity, minSide = 8 }) {
  if (W < minSide || H < minSide) return "The crop is too small.";
  if (W * H > maxPixels) return `That is ${Math.round((W * H) / 1e6)} megapixels. Lower the DPI or tighten the crop (limit ${maxPixels / 1e6}).`;
  if (Math.max(W, H) > maxSide) return `That is ${Math.max(W, H).toLocaleString("en-US")} px on its longest side. Lower the DPI or tighten the crop (limit ${maxSide.toLocaleString("en-US")}).`;
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
