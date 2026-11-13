// Drawing a large rendered sheet quickly in the sheet pane. The render (pdfRaster.renderCrop) can be 26,000 px wide and
// is kept in CPU memory (willReadFrequently, for the compression to read): drawing it whole on every frame, scaled
// down, or sampling it for the loupe, costs hundreds of milliseconds on the main thread and stalls the map as well,
// and a canvas wider than the GPU's texture limit (often 16,384) can't be drawn fast at all.
//
// So the pane draws from a pyramid: level i is the render at 1 / 2^i, made once when a zoom first needs it, each
// level from the one above (smoothed), stopping at about 512 px. A view picks the level whose pixels are at least as
// fine as the screen's; every level is drawn through tiles of TILE px, copied lazily (the render's own tiles too, so
// zoomed in only the visible part of it is ever touched), and the least recently used tiles are let go past MAX_TILES.
// The pure parts (level choice, tile ranges) are tested; the class needs a document.

export const TILE = 1024;
export const MAX_TILES = 24; // 24 tiles of 1024² are at most 96 MB

// The level for a scale k (screen pixels per render pixel): the coarsest whose pixels are still no larger than a
// screen pixel, so nothing is drawn from finer data than the screen can show. Never past `levels - 1`.
export function levelFor(k, levels = Infinity) {
  if (!(k > 0) || k >= 0.5) return 0;
  return Math.max(0, Math.min(levels - 1, Math.floor(Math.log2(1 / k))));
}

// The tiles a region [sx, sx + sw) x [sy, sy + sh) of a W x H image touches: [{ tx, ty, x, y, w, h }] with x, y, w, h the
// tile's own rectangle (edge tiles are smaller). Clipped to the image.
export function tilesFor(sx, sy, sw, sh, W, H, tile = TILE) {
  const x0 = Math.max(0, Math.floor(sx / tile)), y0 = Math.max(0, Math.floor(sy / tile));
  const x1 = Math.min(Math.ceil(W / tile) - 1, Math.floor((sx + sw - 1e-9) / tile));
  const y1 = Math.min(Math.ceil(H / tile) - 1, Math.floor((sy + sh - 1e-9) / tile));
  const out = [];
  for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) {
    const x = tx * tile, y = ty * tile;
    out.push({ tx, ty, x, y, w: Math.min(tile, W - x), h: Math.min(tile, H - y) });
  }
  return out;
}

// The size of each level of a W x H image: halving (rounded up) until the longest side is at most `min`.
export function levelSizes(W, H, min = 512) {
  const out = [{ w: W, h: H }];
  while (Math.max(out.at(-1).w, out.at(-1).h) > min) out.push({ w: Math.ceil(out.at(-1).w / 2), h: Math.ceil(out.at(-1).h / 2) });
  return out;
}

export class SheetPyramid {
  constructor(canvas, makeCanvas = (w, h) => Object.assign(document.createElement("canvas"), { width: w, height: h })) {
    this.base = canvas;
    this.make = makeCanvas;
    this.sizes = levelSizes(canvas.width, canvas.height);
    this.levels = [canvas];
    this.tiles = new Map(); // "level:tx:ty" -> canvas, in use order
  }

  level(i) {
    while (this.levels.length <= i && this.levels.length < this.sizes.length) {
      const prev = this.levels.at(-1), { w, h } = this.sizes[this.levels.length];
      const c = this.make(w, h), g = c.getContext("2d");
      g.fillStyle = "#fff";
      g.fillRect(0, 0, w, h);
      g.imageSmoothingEnabled = true;
      g.imageSmoothingQuality = "high";
      g.drawImage(prev, 0, 0, w, h);
      this.levels.push(c);
    }
    return this.levels[Math.min(i, this.levels.length - 1)];
  }

  tile(i, t) {
    const key = `${i}:${t.tx}:${t.ty}`;
    let c = this.tiles.get(key);
    if (c) { this.tiles.delete(key); this.tiles.set(key, c); return c; } // most recently used last
    c = this.make(t.w, t.h);
    c.getContext("2d").drawImage(this.level(i), t.x, t.y, t.w, t.h, 0, 0, t.w, t.h);
    this.tiles.set(key, c);
    while (this.tiles.size > MAX_TILES) {
      const [old, oc] = this.tiles.entries().next().value;
      oc.width = oc.height = 0;
      this.tiles.delete(old);
    }
    return c;
  }

  // Draws the region [sx, sx + sw) x [sy, sy + sh) of the render (render pixels) into ctx at [dx, dy, dw, dh], from the
  // level the scale calls for (or `level` when given: the loupe wants the render's own pixels).
  draw(ctx, sx, sy, sw, sh, dx, dy, dw, dh, level = null) {
    const i = level ?? levelFor(dw / sw, this.sizes.length);
    const L = this.sizes[i], fx = L.w / this.base.width, fy = L.h / this.base.height;
    const lx = sx * fx, ly = sy * fy, lw = sw * fx, lh = sh * fy;
    const kx = dw / lw, ky = dh / lh;
    for (const t of tilesFor(lx, ly, lw, lh, L.w, L.h)) {
      // the part of the region in this tile, in level pixels, then on screen
      const ax = Math.max(lx, t.x), ay = Math.max(ly, t.y), bx = Math.min(lx + lw, t.x + t.w), by = Math.min(ly + lh, t.y + t.h);
      if (bx <= ax || by <= ay) continue;
      // on-screen edges on whole pixels, so neighbouring tiles meet without an antialiased seam
      const X0 = Math.round(dx + (ax - lx) * kx), Y0 = Math.round(dy + (ay - ly) * ky), X1 = Math.round(dx + (bx - lx) * kx), Y1 = Math.round(dy + (by - ly) * ky);
      if (X1 > X0 && Y1 > Y0) ctx.drawImage(this.tile(i, t), ax - t.x, ay - t.y, bx - ax, by - ay, X0, Y0, X1 - X0, Y1 - Y0);
    }
  }

  // Lets the cached tiles go (they are copied again when drawn).
  dropTiles() {
    for (const c of this.tiles.values()) c.width = c.height = 0;
    this.tiles.clear();
  }

  destroy() {
    for (const c of this.tiles.values()) c.width = c.height = 0;
    this.tiles.clear();
    for (const c of this.levels.slice(1)) c.width = c.height = 0;
    this.levels = [this.base];
  }
}
