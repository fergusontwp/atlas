// World files and image placement: from a fitted transform to the six world-file numbers and the image's corners, and
// back from a world file to corners. No DOM and no SDK imports, so it can be tested alone.
// Ported from georeferencer/js/lib/core.js, with the reader moved here from plan.js so one module both writes and reads.
//
// Two coordinate systems for an image of W x H pixels:
//   - continuous pixel coordinates (u, v): origin at the OUTER corner of the top-left pixel, (W, H) at the far corner.
//     An "image transform" { A, B, C, D, E, F } maps (u, v) to map space:  X = A*u + B*v + C,  Y = D*u + E*v + F.
//   - a world file describes the CENTRE of the top-left pixel, so its C and F are half a pixel further in. Its six lines
//     are in the order A, D, B, E, C, F.
// The image itself is never rotated or resampled to fit: rotation lives in B and D.

// The image transform for an image rendered from `crop` (page points) at `dpi`, given the page-to-map transform T.
export function imageTransform(T, crop, dpi) {
  const s = dpi / 72;
  return {
    A: T.a / s, B: T.b / s, C: T.c + T.a * crop.x0 + T.b * crop.y0,
    D: T.d / s, E: T.e / s, F: T.f + T.d * crop.x0 + T.e * crop.y0,
  };
}

// Map-space corners [TL, TR, BR, BL] of a W x H image, at the pixels' outer edges.
export function imageCorners(t, W, H) {
  const at = (u, v) => [t.A * u + t.B * v + t.C, t.D * u + t.E * v + t.F];
  return [at(0, 0), at(W, 0), at(W, H), at(0, H)];
}

// The same image shrunk to W2 x H2 (a resample of the whole image): each new pixel covers W/W2 by H/H2 old ones. The
// outer corner doesn't move, so C and F stay.
export function resizeImageTransform(t, W, H, W2, H2) {
  const fx = W / W2;
  const fy = H / H2;
  return { A: t.A * fx, B: t.B * fy, C: t.C, D: t.D * fx, E: t.E * fy, F: t.F };
}

// A piece of the image whose top-left outer corner is at pixel (ox, oy) of the whole: the same pixels, a shifted origin.
export function offsetImageTransform(t, ox, oy) {
  return { ...t, C: t.C + t.A * ox + t.B * oy, F: t.F + t.D * ox + t.E * oy };
}

// The six world-file numbers in file order (A, D, B, E, C, F) for an image transform.
export function worldFileValuesOf(t) {
  return [t.A, t.D, t.B, t.E, t.C + 0.5 * (t.A + t.B), t.F + 0.5 * (t.D + t.E)];
}

export const worldFileValues = (T, crop, dpi) => worldFileValuesOf(imageTransform(T, crop, dpi));

// Ten decimals a line, one number per line, with a trailing newline.
export const worldFileText = (values) => `${values.map((v) => v.toFixed(10)).join("\n")}\n`;

// Map-space corners [TL, TR, BR, BL] of the image rendered from `crop` at `dpi` (W x H pixels).
export const footprintXY = (T, crop, dpi, W, H) => imageCorners(imageTransform(T, crop, dpi), W, H);

// ---- reading a world file

// The six numbers of a world file's text, in file order. Throws an Error whose message is meant to be shown after
// the file's name.
export function parseWorldFile(text) {
  const n = text.trim().split(/\s+/).slice(0, 6).map(Number);
  if (n.length < 6 || n.some((v) => !Number.isFinite(v))) throw new Error("a world file has six numbers, one per line.");
  const [A, D, B, E] = n;
  if (A * E - B * D === 0) throw new Error("its pixel size is zero.");
  return n;
}

// Map position of pixel (col, row) of a world file's six numbers; col and row are pixel-centre indices, and may be fractional.
export const worldFileXY = ([A, D, B, E, C, F], col, row) => [A * col + B * row + C, D * col + E * row + F];

// The four corners of a w x h image placed by a world file. The image edges sit half a pixel outside the pixel centres
// the file describes.
export function cornersFromWorldFile(wf, w, h) {
  return {
    topLeft: worldFileXY(wf, -0.5, -0.5),
    topRight: worldFileXY(wf, w - 0.5, -0.5),
    bottomLeft: worldFileXY(wf, -0.5, h - 0.5),
    bottomRight: worldFileXY(wf, w - 0.5, h - 0.5),
  };
}
