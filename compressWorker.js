// Module Web Worker: turns the rendered plan (an ImageBitmap of the canvas) into the files to attach, using the ladder
// in planCompression.js. The heavy loops (quantizing, row filtering, resampling) run here so the page stays usable.
// Started by compressClient.js; the messages are:
//   in   { type: "start", bitmap, comp, budget, thicken? }   comp is PLANS.COMPRESSION, budget the bytes the image may use
//        { type: "probe", bitmap, thicken? }                  step 2's estimate: a probe render's PNG sizes
//        thicken: the line weight, or null: { P (thicken.js settings: pt, levels, bin, color), dpi (the bitmap's),
//                 trim?: { left, right } } (pixels of halo on the bitmap's sides, rendered past a piece's cuts and
//                 trimmed off after thickening)
//        { type: "cancel" }
//   out  { type: "progress", tier, scale?, quality?, attempt }
//        { type: "done", result }          result as runLadder's, plus { initialBytes }; each file { name, type, bytes, data }
//        { type: "probed", asis, bytes }   the probe as the first PNG and as the lossless rung
//        { type: "cancelled" }  or  { type: "error", message }
import { runLadder } from "./planCompression.js";
import { thickenedCrop } from "./thickenCanvas.js";
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
  const g = out.getContext("2d", { willReadFrequently: true }); // read back at once, and software is safe at any size
  g.fillStyle = "#fff";
  g.fillRect(0, 0, w, h);
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = "high";
  g.drawImage(canvas, 0, 0, w, h);
  return out;
}
const pixelsOf = (canvas) => canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;

// The image at a scale, as it is saved. Without a line weight: the bitmap resampled. With one (thickenCanvas.js): the
// bitmap's core (without the halo rendered past a piece's cuts) resampled to the size with the halo that size needs,
// the line weight applied at that size's own pixels (it depends on the resolution, so each size the search tries is
// thickened on its own), and the halo trimmed off. Scale 1 is kept: every same-size rung and the tiles use it.
function preparer(src, th) {
  if (!th?.P) return (scale) => scaled(src, scale);
  const left = th.trim?.left ?? 0, w = src.width - left - (th.trim?.right ?? 0);
  const makeCanvas = (cw, ch) => new OffscreenCanvas(cw, ch);
  let full = null;
  return (scale) => {
    if (scale === 1 && full) return full;
    const out = thickenedCrop({ src, left, w, scale, P: th.P, dpi: th.dpi, makeCanvas });
    if (scale === 1) full = out;
    return out;
  };
}

// The bitmap on a white canvas of its own (the bitmap is closed).
function canvasOf(bitmap) {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const g = canvas.getContext("2d", { willReadFrequently: true });
  g.fillStyle = "#fff";
  g.fillRect(0, 0, bitmap.width, bitmap.height);
  g.drawImage(bitmap, 0, 0);
  bitmap.close();
  return { canvas, g };
}

async function compress(bitmap, comp, budget, signal, thicken) {
  const { canvas: src } = canvasOf(bitmap);
  const at = preparer(src, thicken);
  const canvas = at(1);
  const g = canvas.getContext("2d", { willReadFrequently: true });
  const W = canvas.width, H = canvas.height;

  const first = await canvas.convertToBlob({ type: "image/png" }); // the first PNG: as rendered, and the tile grid's guess
  const initialBytes = first.size;

  const ops = {
    async asis() {
      return { files: [fileOf("plan.png", "image/png", new Uint8Array(await first.arrayBuffer()))], width: W, height: H };
    },
    async lossless({ scale }) {
      const c = at(scale);
      const png = await encodePng(reduceLossless(pixelsOf(c), c.width, c.height));
      return { files: [fileOf("plan.png", "image/png", png)], width: c.width, height: c.height };
    },
    async quantized({ scale }) {
      const c = at(scale);
      const px = pixelsOf(c);
      const q = quantize(px, c.width, c.height);
      // 256 colors or fewer is already exact, so use the smallest exact form (1-bit, gray or a palette) rather than the palette
      const png = await encodePng(q.exact ? reduceLossless(px, c.width, c.height) : q);
      return { files: [fileOf("plan.png", "image/png", png)], width: c.width, height: c.height };
    },
    async jpeg({ scale, quality }) {
      const c = at(scale);
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
    initialBytes, width: W, height: H, comp, ops, signal, budget,
    // a binarized line weight is two greys: the 1-bit lossless form comes before the browser's own PNG
    skipAsis: !!thicken?.P?.bin,
    // flat linework (never JPEG) is only worked out once the same-size PNGs have failed: it reads every pixel
    flat: async () => topColorShare(pixelsOf(canvas)) >= comp.FLAT_SHARE,
    onProgress: (p) => self.postMessage({ type: "progress", ...p }),
  });
  return { ...result, initialBytes };
}

// A probe render's sizes as the first PNG (the browser's, as the asis rung) and as the lossless rung.
async function probe(bitmap, thicken) {
  const canvas = preparer(canvasOf(bitmap).canvas, thicken)(1);
  const asis = (await canvas.convertToBlob({ type: "image/png" })).size;
  const bytes = (await encodePng(reduceLossless(pixelsOf(canvas), canvas.width, canvas.height))).length;
  return { asis, bytes };
}

self.onmessage = async (event) => {
  const msg = event.data;
  if (msg.type === "cancel") {
    controller?.abort();
    return;
  }
  if (msg.type === "probe") {
    try {
      self.postMessage({ type: "probed", ...(await probe(msg.bitmap, msg.thicken)) });
    } catch (err) {
      self.postMessage({ type: "error", message: err?.message ?? String(err) });
    }
    return;
  }
  if (msg.type !== "start") return;
  controller = new AbortController();
  try {
    const result = await compress(msg.bitmap, msg.comp, msg.budget, controller.signal, msg.thicken);
    const transfer = (result.files ?? []).map((f) => f.data.buffer);
    self.postMessage({ type: "done", result }, transfer);
  } catch (err) {
    if (err?.name === "AbortError") self.postMessage({ type: "cancelled" });
    else self.postMessage({ type: "error", message: err?.message ?? String(err) });
  }
};
