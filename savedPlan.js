// Where a saved plan's image (or each tile of it) goes on the map. Pure: no DOM and no SDK imports.
// The record's world_file describes the whole saved image (or the whole mosaic of tiles), in the record's wkid.

import { parseWorldFile } from "./worldFile.js";
import { tileCorners, tileGrid } from "./tiling.js";

const TILE_RE = /^plan_r(\d+)c(\d+)\.(png|jpe?g)$/i;
const IMAGE_RE = /^plan\.(png|jpe?g)$/i;

// worldFileText: the record's world_file; width, height: img_width, img_height; names: the attachment names.
// Returns [{ name, x, y, w, h, corners }] with corners [TL, TR, BR, BL] in the record's coordinate system, or throws an
// Error naming what is missing.
export function tileLayout(worldFileText, width, height, names) {
  const [A, D, B, E, Cc, Fc] = parseWorldFile(worldFileText);
  // the world file points at the centre of the first pixel; an image transform at its outer corner
  const t = { A, B, D, E, C: Cc - 0.5 * (A + B), F: Fc - 0.5 * (D + E) };
  const single = names.find((n) => IMAGE_RE.test(n));
  if (single) {
    const tile = { name: single, row: 0, col: 0, x: 0, y: 0, w: width, h: height };
    return [{ name: single, x: 0, y: 0, w: width, h: height, corners: tileCorners(tile, t) }];
  }
  const tiles = names.map((n) => ({ n, m: TILE_RE.exec(n) })).filter((x) => x.m);
  if (!tiles.length) throw new Error("This plan has no image attachment.");
  const cols = Math.max(...tiles.map((x) => Number(x.m[2]))) + 1;
  const rows = Math.max(...tiles.map((x) => Number(x.m[1]))) + 1;
  if (tiles.length !== cols * rows) throw new Error(`This plan has ${tiles.length} of its ${cols * rows} image tiles.`);
  const grid = tileGrid(width, height, cols, rows);
  return tiles.map(({ n, m }) => {
    const tile = grid.find((g) => g.row === Number(m[1]) && g.col === Number(m[2]));
    return { name: n, x: tile.x, y: tile.y, w: tile.w, h: tile.h, corners: tileCorners(tile, t) };
  });
}
