import { textBlock } from "./pdfFonts.js";
import { printTiming } from "./printTiming.js";
import { pagePixels } from "./printDetail.js";
import { layoutPage, drawLayout } from "./printLayout.js";
import { createCanvasDrawing } from "./printDraw.js";
import { pngWithDpi } from "./printPng.js";
import { createPdfDrawing } from "./pdfWriter.js";
import { deflateZlib } from "./pngEncode.js";
import { flattenOnWhite } from "./printImage.js";
import { PRINT } from "./config.js";

export function renderPrintPage(capture, page, registry, states, context) {
  const pixels = pagePixels(page, capture.canvas.width, capture.canvas.height);
  const canvas = document.createElement("canvas"); canvas.width = pixels.width; canvas.height = pixels.height;
  const ctx = canvas.getContext("2d"); ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, canvas.width, canvas.height);
  const timing = context.timing ?? printTiming();
  timing.sync("fonts (system Helvetica/Arial; no asynchronous font dependency)", () => {});
  const layout = timing.sync("page layout", () => layoutPage(page, registry, states, context));
  timing.sync("canvas draw", () => drawLayout(createCanvasDrawing(canvas, pixels.pixelsPerPoint, new Map([["map", capture.canvas], ...(context.legendImages ?? [])])), layout, registry, context));
  return { canvas, layout, pixels };
}

export const printFormats = ["pdf", "png"];
export async function exportPng(rendered, signal, timing = printTiming()) {
  const blob = await timing.step("PNG encode", () => new Promise((resolve) => rendered.canvas.toBlob(resolve, "image/png")), { signal, timeoutMs: PRINT.TIMEOUT_MS.ENCODE });
  if (!blob) throw new Error("Couldn't encode the map image.");
  return pngWithDpi(new Uint8Array(await timing.step("PNG bytes", () => blob.arrayBuffer(), { signal, timeoutMs: PRINT.TIMEOUT_MS.ENCODE })), rendered.pixels.dpi);
}

export async function exportPdf(rendered, capture, registry, context, title, signal) {
  const timing = context.timing ?? printTiming();
  const jpeg = await timing.step("PDF map JPEG encode", () => new Promise((resolve) => capture.canvas.toBlob(resolve, "image/jpeg", PRINT.JPEG_QUALITY / 100)), { signal, timeoutMs: PRINT.TIMEOUT_MS.ENCODE });
  if (!jpeg) throw new Error("Couldn't encode the map image.");
  const images = [{ id: "map", width: capture.canvas.width, height: capture.canvas.height,
    filter: "DCTDecode", data: new Uint8Array(await timing.step("PDF map bytes", () => jpeg.arrayBuffer(), { signal, timeoutMs: PRINT.TIMEOUT_MS.ENCODE })) }];
  const used = new Set(rendered.layout.placements.find((item) => item.id === "legend")?.measurement.rows.map((row) => row.entry?.image).filter(Boolean));
  for (const [id, canvas] of context.legendImages ?? []) {
    if (!used.has(id)) continue;
    const rgba = flattenOnWhite(canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data);
    const rgb = new Uint8Array(canvas.width * canvas.height * 3);
    for (let i = 0, j = 0; i < rgba.length; i += 4) { rgb[j++] = rgba[i]; rgb[j++] = rgba[i + 1]; rgb[j++] = rgba[i + 2]; }
    const data = await timing.step(`PDF swatch ${id}`, () => deflateZlib(rgb), { signal, timeoutMs: PRINT.TIMEOUT_MS.SWATCH, fallback: () => null });
    if (data) images.push({ id, width: canvas.width, height: canvas.height, filter: "FlateDecode", data });
    else {
      for (const row of rendered.layout.placements.find((item) => item.id === "legend")?.measurement.rows ?? []) {
        if (row.entry?.image === id) { row.entry = { ...row.entry, image: null }; row.label = textBlock(`${row.entry.label} (symbol unavailable)`, Math.max(1, row.box.width - PRINT.LEGEND.SWATCH_PT - 5), row.label); }
      }
    }
  }
  signal?.throwIfAborted();
  const pdf = createPdfDrawing({ ...rendered.layout.page, title, images });
  drawLayout(pdf, rendered.layout, registry, context);
  return pdf.finish();
}
