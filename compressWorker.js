// Module Web Worker: turns the rendered plan (an ImageBitmap of the canvas) into the files to attach, using the ladder
// in planCompression.js. The heavy loops (quantizing, row filtering, resampling) run here so the page stays usable.
// Started by compressClient.js; the messages are:
//   in   { type: "start", bitmap, comp }   comp is PLANS.COMPRESSION         { type: "cancel" }
//   out  { type: "progress", tier, scale?, quality?, attempt }
//        { type: "done", result }          result as runLadder's, plus { initialBytes, flat }; each file { name, type, bytes, data }
//        { type: "cancelled" }  or  { type: "error", message }
import { runLadder } from "./planCompression.js";
import { encodePng } from "./pngEncode.js";
import { quantize, reduceLossless, topColorShare } from "./pixelReduce.js";
import { tileGrid, tileName } from "./tiling.js";

let controller = null;

const fileOf = (name, type, data) => ({ name, type, bytes: data.length, data });
const size = (canvas, scale) => ({ w: Math.max(1, Math.round(canvas.width * scale)), h: Math.max(1, Math.round(canvas.height * scale)) });

// The canvas resampled to a linear scale (the canvas itself at scale 1), on white.
function scaled(canvas, scale) {
  if (scale === 1) return canvas;
  const { w, h } = size(canvas, scale);
  const out = new OffscreenCanvas(w, h);
  const g = out.getContext("2d");
  g.fillStyle = "#fff";
  g.fillRect(0, 0, w, h);
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = "high";
  g.drawImage(canvas, 0, 0, w, h);
  return out;
}
const pixelsOf = (canvas) => canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;

async function compress(bitmap, comp, signal) {
  const W = bitmap.width, H = bitmap.height;
  const canvas = new OffscreenCanvas(W, H);
  const g = canvas.getContext("2d", { willReadFrequently: true });
  g.fillStyle = "#fff";
  g.fillRect(0, 0, W, H);
  g.drawImage(bitmap, 0, 0);
  bitmap.close();

  const first = await canvas.convertToBlob({ type: "image/png" }); // the first PNG: its size picks the starting rung
  const initialBytes = first.size;
  // flat linework only matters where JPEG would be the start, so the pixels are only read then
  const flat = initialBytes > comp.TIER_LIMITS.QUANTIZED && initialBytes <= comp.TIER_LIMITS.JPEG
    ? topColorShare(pixelsOf(canvas)) >= comp.FLAT_SHARE : false;

  const ops = {
    async asis() {
      return { files: [fileOf("plan.png", "image/png", new Uint8Array(await first.arrayBuffer()))], width: W, height: H };
    },
    async lossless({ scale }) {
      const c = scaled(canvas, scale);
      const png = await encodePng(reduceLossless(pixelsOf(c), c.width, c.height));
      return { files: [fileOf("plan.png", "image/png", png)], width: c.width, height: c.height };
    },
    async quantized({ scale }) {
      const c = scaled(canvas, scale);
      const px = pixelsOf(c);
      const q = quantize(px, c.width, c.height);
      // 256 colors or fewer is already exact, so use the smallest exact form (1-bit, gray or a palette) rather than the palette
      const png = await encodePng(q.exact ? reduceLossless(px, c.width, c.height) : q);
      return { files: [fileOf("plan.png", "image/png", png)], width: c.width, height: c.height };
    },
    async jpeg({ scale, quality }) {
      const c = scaled(canvas, scale);
      const blob = await c.convertToBlob({ type: "image/jpeg", quality });
      return { files: [fileOf("plan.jpg", "image/jpeg", new Uint8Array(await blob.arrayBuffer()))], width: c.width, height: c.height };
    },
    async tile({ cols, rows }) {
      const files = [];
      for (const t of tileGrid(W, H, cols, rows)) {
        if (signal.aborted) throw new DOMException("Compression was cancelled", "AbortError");
        const rgba = g.getImageData(t.x, t.y, t.w, t.h).data;
        files.push(fileOf(tileName(t), "image/png", await encodePng(reduceLossless(rgba, t.w, t.h))));
      }
      return { files, width: W, height: H };
    },
  };

  const result = await runLadder({
    initialBytes, width: W, height: H, flat, comp, ops, signal,
    onProgress: (p) => self.postMessage({ type: "progress", ...p }),
  });
  return { ...result, initialBytes, flat };
}

self.onmessage = async (event) => {
  const msg = event.data;
  if (msg.type === "cancel") {
    controller?.abort();
    return;
  }
  if (msg.type !== "start") return;
  controller = new AbortController();
  try {
    const result = await compress(msg.bitmap, msg.comp, controller.signal);
    const transfer = (result.files ?? []).map((f) => f.data.buffer);
    self.postMessage({ type: "done", result }, transfer);
  } catch (err) {
    if (err?.name === "AbortError") self.postMessage({ type: "cancelled" });
    else self.postMessage({ type: "error", message: err?.message ?? String(err) });
  }
};
