import { GEOREF } from "./config.js";
import { makeRaster, previewScale, rasterSize, renderProblem } from "./pageRaster.js";

// A PDF page to pixels with pdf.js, in the two resolutions the workspace needs: a low-resolution preview of the whole
// page (to crop on, and to read the page size) and a full-DPI render of just the crop (the image that gets saved).
// pdf.js comes from the CDN the first time it is needed (GEOREF.PDFJS, a pinned version), never at app start; its worker
// is started by pdf.js itself (it handles a cross-origin script).

const FILES = () => {
  const base = `${GEOREF.PDFJS.BASE}legacy/build/`;
  return { lib: `${base}pdf.min.mjs`, worker: `${base}pdf.worker.min.mjs`, fonts: `${GEOREF.PDFJS.BASE}standard_fonts/`, wasm: `${GEOREF.PDFJS.BASE}wasm/`, cmaps: `${GEOREF.PDFJS.BASE}cmaps/` };
};

let libPromise = null;
export function loadPdfJs() {
  if (!libPromise) {
    const files = FILES();
    libPromise = import(files.lib).then(
      (lib) => {
        lib.GlobalWorkerOptions.workerSrc = files.worker;
        return lib;
      },
      (err) => {
        libPromise = null; // so a later try can succeed
        throw new Error(`Couldn't load the PDF reader (pdf.js ${GEOREF.PDFJS.VERSION}) from the network. Check the connection and try again. ${err?.message ?? ""}`.trim());
      },
    );
  }
  return libPromise;
}

// Opens a PDF from its bytes. Resolves to { doc, numPages, destroy() }. (pdf.js takes the bytes over, so a copy is passed.)
export async function openPdf(bytes) {
  const lib = await loadPdfJs();
  const files = FILES();
  const task = lib.getDocument({ data: bytes.slice(), standardFontDataUrl: files.fonts, wasmUrl: files.wasm, cMapUrl: files.cmaps, cMapPacked: true });
  const doc = await task.promise;
  return { doc, numPages: doc.numPages, destroy: () => task.destroy() };
}

// One page: its size at scale 1 (rotation and crop box applied, in points) and the whole-page preview canvas.
// Resolves to { page, pageWidthPt, pageHeightPt, preview: { canvas, k } } with k pixels per point.
export async function openPage(pdf, pageNum) {
  const page = await pdf.doc.getPage(pageNum);
  const vp = page.getViewport({ scale: 1 });
  const k = previewScale(vp.width, vp.height, GEOREF.PREVIEW_PX);
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(vp.width * k);
  canvas.height = Math.round(vp.height * k);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport: page.getViewport({ scale: k }) }).promise;
  return { page, pageWidthPt: vp.width, pageHeightPt: vp.height, preview: { canvas, k } };
}

// Renders `crop` (page points) at `dpi` into a canvas whose pixel (0, 0) is the crop's top-left corner. Resolves to the
// raster record (pageRaster.js). Throws an Error with a sentence to show if the crop is too small or the render too big.
// options: { signal } to cancel.
export async function renderCrop(pageInfo, crop, dpi, { signal } = {}) {
  const { W, H } = rasterSize(crop, dpi);
  const problem = renderProblem(W, H, { maxPixels: GEOREF.MAX_PIXELS });
  if (problem) throw new Error(problem);
  const s = dpi / 72;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d", { willReadFrequently: true }); // read back for the overlay copy and the compression
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, W, H);
  const task = pageInfo.page.render({ canvasContext: ctx, viewport: pageInfo.page.getViewport({ scale: s }), transform: [1, 0, 0, 1, -crop.x0 * s, -crop.y0 * s] });
  const stop = () => task.cancel();
  signal?.addEventListener("abort", stop, { once: true });
  try {
    await task.promise;
  } catch (err) {
    if (signal?.aborted) throw new DOMException("The render was cancelled", "AbortError");
    throw err;
  } finally {
    signal?.removeEventListener("abort", stop);
  }
  return makeRaster({ pageWidthPt: pageInfo.pageWidthPt, pageHeightPt: pageInfo.pageHeightPt, crop, dpi, canvas });
}
