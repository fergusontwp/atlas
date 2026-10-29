// The sharp part of a saved plan image on the map (plansOnMap.js), the pure geometry: no SDK, no DOM. A saved image is
// shown at most PLAN.MAX_DIM on a side for the GPU, so a 12,000 px piece is drawn three times coarser than it was saved.
// When the map comes to rest, the part of each image in view is cut from the full-size image at the screen's own
// resolution and laid over it. These work out which part, at which scale.
//
// An image (or a tile of one) is placed by its four ground corners (savedPlan.tileLayout); image pixels run (0, 0) at
// its top-left outer corner to (w, h) at its bottom-right.

// The affine map between an image's pixels and the ground, from its corners [TL, TR, BR, BL] ([x, y] each) and size.
// perPx: ground units per image pixel (the square root of the area of one pixel).
export function cornerAffine([TL, TR, , BL], w, h) {
  const ax = (TR[0] - TL[0]) / w, ay = (TR[1] - TL[1]) / w, bx = (BL[0] - TL[0]) / h, by = (BL[1] - TL[1]) / h;
  const det = ax * by - bx * ay;
  return {
    toGround: (u, v) => [TL[0] + ax * u + bx * v, TL[1] + ay * u + by * v],
    toImage: (X, Y) => { const dx = X - TL[0], dy = Y - TL[1]; return [(by * dx - bx * dy) / det, (ax * dy - ay * dx) / det]; },
    perPx: Math.sqrt(Math.abs(det)),
  };
}

// The part of a w x h image to show sharp, or null. view: { corners: [[x, y] x 4] in the image's ground units,
// perDevicePx: ground units per device pixel }. shownK: the scale the whole image is shown at (image pixels drawn per
// image pixel, under 1). The part is the view with a margin (a share of its size each way), snapped outward to `grid`
// image pixels so small pans keep it, and clipped to the image. k: its scale, one image pixel per device pixel, never
// above 1 (finer than saved), and at most maxDim drawn pixels on a side. null when it is out of view or the whole image
// is already shown about as sharp (k within `gain` of shownK).
export function wantedPart(view, aff, w, h, { shownK = 1, grid = 256, margin = 0.15, maxDim = 4096, gain = 1.25 } = {}) {
  const px = view.corners.map(([x, y]) => aff.toImage(x, y));
  const xs = px.map((p) => p[0]), ys = px.map((p) => p[1]);
  const mx = (Math.max(...xs) - Math.min(...xs)) * margin, my = (Math.max(...ys) - Math.min(...ys)) * margin;
  const down = (v) => Math.floor(v / grid) * grid, up = (v) => Math.ceil(v / grid) * grid;
  const x0 = Math.max(0, down(Math.min(...xs) - mx)), x1 = Math.min(w, up(Math.max(...xs) + mx));
  const y0 = Math.max(0, down(Math.min(...ys) - my)), y1 = Math.min(h, up(Math.max(...ys) + my));
  if (x1 - x0 < 2 || y1 - y0 < 2) return null;
  let k = Math.min(1, aff.perPx / view.perDevicePx);
  if (k <= shownK * gain) return null;
  k = Math.min(k, maxDim / (x1 - x0), maxDim / (y1 - y0));
  return { x0, y0, x1, y1, k };
}

// Whether a part already made still serves what is wanted: it covers it, at a scale within [0.8, 1.6] of the wanted one.
export const partServes = (have, want) => have.x0 <= want.x0 && have.y0 <= want.y0 && have.x1 >= want.x1 && have.y1 >= want.y1
  && have.k >= want.k * 0.8 && have.k <= want.k * 1.6;

// The ground corners [TL, TR, BR, BL] of an image part.
export const partCorners = (aff, p) => [aff.toGround(p.x0, p.y0), aff.toGround(p.x1, p.y0), aff.toGround(p.x1, p.y1), aff.toGround(p.x0, p.y1)];
