// Cutting a very large plan image into tiles. Pure geometry: no DOM and no SDK imports, so it can be tested alone.
//
// A tile is { row, col, x, y, w, h } in pixels of the whole image. A grid of cols x rows tiles covers the image exactly:
// no gaps, no overlaps, and tile sizes along an axis differ by at most one pixel.

import { imageCorners, offsetImageTransform } from "./worldFile.js";

// total pixels cut into `parts` spans [{ start, size }] of nearly equal size.
export function splitSpans(total, parts) {
  const spans = [];
  for (let i = 0; i < parts; i++) {
    const start = Math.round((i * total) / parts);
    const end = Math.round(((i + 1) * total) / parts);
    spans.push({ start, size: end - start });
  }
  return spans;
}

export function tileGrid(W, H, cols, rows) {
  const xs = splitSpans(W, cols);
  const ys = splitSpans(H, rows);
  const tiles = [];
  ys.forEach((yy, row) => xs.forEach((xx, col) => tiles.push({ row, col, x: xx.start, y: yy.start, w: xx.size, h: yy.size })));
  return tiles;
}

// Attachment name of a tile: plan_r0c0.png
export const tileName = (tile, ext = "png") => `plan_r${tile.row}c${tile.col}.${ext}`;

// The fewest tiles per axis that keep every tile's sides within maxSide.
export const minGrid = (W, H, maxSide) => ({ cols: Math.ceil(W / maxSide), rows: Math.ceil(H / maxSide) });

// A first guess at the grid for an image whose whole PNG is about estimatedBytes: enough tiles that each should come in
// under tileMaxBytes (with `safety` to spare), at least the side limit's minimum, and as close to square as the
// image's shape allows.
export function gridForBytes(W, H, { estimatedBytes, tileMaxBytes, maxSide, safety = 1.25 }) {
  const min = minGrid(W, H, maxSide);
  const want = Math.max(1, Math.ceil((estimatedBytes * safety) / tileMaxBytes));
  let cols = Math.max(min.cols, Math.round(Math.sqrt((want * W) / H)));
  let rows = Math.max(min.rows, Math.ceil(want / cols));
  while (cols * rows < want) {
    if (W / cols >= H / rows) cols++;
    else rows++;
  }
  return { cols, rows };
}

// One more cut along the longer tile side, for when a tile came out too big. null when the tiles are already as small
// as minSide allows.
export function refineGrid({ cols, rows }, W, H, minSide = 256) {
  const tw = W / cols;
  const th = H / rows;
  if (tw >= th && tw / 2 >= minSide) return { cols: cols + 1, rows };
  if (th / 2 >= minSide) return { cols, rows: rows + 1 };
  if (tw / 2 >= minSide) return { cols: cols + 1, rows };
  return null;
}

// Map-space corners [TL, TR, BR, BL] of a tile, from the image transform of the whole image.
export const tileCorners = (tile, imageTransform) => imageCorners(offsetImageTransform(imageTransform, tile.x, tile.y), tile.w, tile.h);
