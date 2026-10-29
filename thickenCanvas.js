// A crop of a canvas at a scale, with the line weight applied (thicken.js). Shared by the compression worker (each size
// the budget search tries) and the Place step's overlay (the preview on the map). No SDK; the canvas is made by the
// caller's makeCanvas(w, h) (an OffscreenCanvas in the worker, a page canvas on the map).
//
// The core is the source's rectangle [left, left + w) x [top, top + h). It is resampled to round(w x scale) by
// round(h x scale) together with as many pixels around it as the thickening (and sharpen) needs at that size (haloFor), from what the
// source has there (a neighbouring piece, the rest of the sheet, or the halo rendered past a cut); the line weight is
// applied at that size's own pixels (ptToPx(P.pt, dpi x scale)), strip by strip; the extra pixels are trimmed off.
// Without P it is the plain resample. Pixels at the source's own edges count as edge pixels.

import { haloFor, processStrips, ptToPx } from "./thicken.js";

// src: the source canvas; left, w, top, h: the core (default the whole width and height); scale: linear (1 = full
// size); P: thicken.js settings or null; dpi: the source's resolution; makeCanvas(w, h). Returns the canvas.
export function thickenedCrop({ src, left = 0, w = src.width - left, top = 0, h = src.height - top, scale = 1, P = null, dpi, makeCanvas }) {
  const Wc = Math.max(1, Math.round(w * scale)), Hc = Math.max(1, Math.round(h * scale)), kx = Wc / w, ky = Hc / h;
  const px = P ? ptToPx(P.pt, dpi * scale) : 0;
  const need = P ? haloFor(px, P.sharpen) : 0;
  const right = src.width - left - w, bottom = src.height - top - h;
  const mL = Math.min(need, Math.floor(left * kx)), mR = Math.min(need, Math.floor(right * kx));
  const mT = Math.min(need, Math.floor(top * ky)), mB = Math.min(need, Math.floor(bottom * ky));
  const tw = Wc + mL + mR, th = Hc + mT + mB;
  const tmp = makeCanvas(tw, th);
  const tg = tmp.getContext("2d", { willReadFrequently: !!P });
  tg.fillStyle = "#fff";
  tg.fillRect(0, 0, tw, th);
  tg.imageSmoothingEnabled = true;
  tg.imageSmoothingQuality = "high";
  tg.drawImage(src, left - mL / kx, top - mT / ky, w + (mL + mR) / kx, h + (mT + mB) / ky, 0, 0, tw, th);
  if (!P) return tmp; // no line weight: no halo either
  const out = makeCanvas(Wc, Hc);
  const og = out.getContext("2d");
  // the strips cover the haloed block; only the core's rows and columns are written out
  processStrips((a, b) => tg.getImageData(0, a, tw, b - a).data, (y, rows) => {
    const n = rows.length / (tw * 4), r0 = Math.max(0, mT - y), r1 = Math.min(n, mT + Hc - y);
    if (r1 <= r0) return;
    const img = og.createImageData(Wc, r1 - r0);
    for (let r = r0; r < r1; r++) img.data.set(rows.subarray((r * tw + mL) * 4, (r * tw + mL + Wc) * 4), (r - r0) * Wc * 4);
    og.putImageData(img, 0, y + r0 - mT);
  }, tw, th, P, px);
  return out;
}
