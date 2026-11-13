// "Export PDF" in the mosaic workspace: the whole mosaic as one PDF page, for use outside Atlas. Ported from the
// prototype (plan-mosaic.html, buildPdf / deflateTile): one page, the image split into column tiles at most 8192 px wide
// placed side by side (each overlapping the next by 1 px, so no hairline shows), each tile a lossless Flate image with
// the PNG "Up" predictor, drawn strip by strip and compressed as it goes (CompressionStream), so no big canvas is made.
//
// M: { width, height, draw(ctx, sx, sy, sw, sh, dx, dy, dw, dh) } (the mosaic pane's source, at the join resolution);
// ppi: pixels per inch of the page (the join resolution keeps the plan's own size).

const TILE_W = 8192;

async function deflateTile(M, tx0, tw, onRows) {
  const H = M.height, rowLen = tw * 3;
  const cs = new CompressionStream("deflate"); // zlib format, as FlateDecode expects
  const writer = cs.writable.getWriter(), reader = cs.readable.getReader();
  const chunks = [];
  let total = 0;
  const pump = (async () => { for (;;) { const r = await reader.read(); if (r.done) break; chunks.push(r.value); total += r.value.length; } })();
  const rows = Math.max(1, Math.floor(3e6 / tw));
  const sc = Object.assign(document.createElement("canvas"), { width: tw, height: Math.min(rows, H) });
  const g = sc.getContext("2d", { willReadFrequently: true });
  let prev = new Uint8Array(rowLen), cur = new Uint8Array(rowLen);
  for (let y0 = 0; y0 < H; y0 += rows) {
    const h = Math.min(rows, H - y0);
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = "#fff";
    g.fillRect(0, 0, tw, sc.height);
    M.draw(g, tx0, y0, tw, h, 0, 0, tw, h);
    const d = g.getImageData(0, 0, tw, h).data;
    const buf = new Uint8Array(h * (rowLen + 1));
    for (let r = 0, o = 0, s = 0; r < h; r++) {
      for (let x = 0, j = 0; x < tw; x++, s += 4) { cur[j++] = d[s]; cur[j++] = d[s + 1]; cur[j++] = d[s + 2]; }
      buf[o++] = 2; // PNG filter "Up"
      for (let j = 0; j < rowLen; j++) buf[o++] = (cur[j] - prev[j]) & 255;
      const t = prev; prev = cur; cur = t;
    }
    await writer.write(buf);
    onRows(h);
  }
  await writer.close();
  await pump;
  sc.width = sc.height = 0;
  return { chunks, total };
}

// Resolves to { blob, wpt, hpt, tiles, ppi, scaled } (scaled: the page was shrunk to 200 in, the PDF readers' limit).
export async function mosaicPdf(M, ppi, onProgress = () => {}) {
  if (typeof CompressionStream === "undefined") throw new Error("This browser can't build the PDF. Use a current Chrome, Edge, Firefox or Safari.");
  let scaled = false;
  if ((Math.max(M.width, M.height) * 72) / ppi > 14400) { ppi = Math.max(M.width, M.height) / 200; scaled = true; } // 200 in
  const W = M.width, H = M.height, enc = new TextEncoder(), f = 72 / ppi;
  const wpt = (W * f).toFixed(3), hpt = (H * f).toFixed(3);
  const tiles = [];
  for (let x0 = 0; x0 < W; x0 += TILE_W) tiles.push({ x0, w: Math.min(TILE_W + 1, W - x0) });
  let done = 0;
  const all = tiles.length * H;
  for (const t of tiles) t.img = await deflateTile(M, t.x0, t.w, (h) => { done += h; onProgress(done / all); });
  const parts = [], offs = [];
  let pos = 0;
  const put = (x) => { const b = typeof x === "string" ? enc.encode(x) : x; parts.push(b); pos += b.length; };
  const obj = (n) => { offs[n] = pos; };
  const first = 6, nObj = first + tiles.length - 1; // 1 catalog, 2 pages, 3 page, 4 content, 5 info, 6.. tiles
  put("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");
  obj(1); put("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
  obj(2); put("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n");
  obj(3); put(`3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${wpt} ${hpt}] /Resources << /XObject << ${tiles.map((t, i) => `/Im${i} ${first + i} 0 R`).join(" ")} >> >> /Contents 4 0 R >>\nendobj\n`);
  const content = tiles.map((t, i) => `q ${(t.w * f).toFixed(3)} 0 0 ${hpt} ${(t.x0 * f).toFixed(3)} 0 cm /Im${i} Do Q\n`).join("");
  obj(4); put(`4 0 obj\n<< /Length ${content.length} >>\nstream\n${content}endstream\nendobj\n`);
  obj(5); put("5 0 obj\n<< /Producer (Atlas plan mosaic) /Title (Plan view mosaic) >>\nendobj\n");
  tiles.forEach((t, i) => {
    const n = first + i;
    obj(n);
    put(`${n} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${t.w} /Height ${H} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /DecodeParms << /Predictor 15 /Colors 3 /BitsPerComponent 8 /Columns ${t.w} >> /Length ${t.img.total} >>\nstream\n`);
    t.img.chunks.forEach((c) => put(c));
    put("\nendstream\nendobj\n");
  });
  const xref = pos;
  let x = `xref\n0 ${nObj + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= nObj; n++) x += `${String(offs[n]).padStart(10, "0")} 00000 n \n`;
  put(`${x}trailer\n<< /Size ${nObj + 1} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return { blob: new Blob(parts, { type: "application/pdf" }), wpt: +wpt, hpt: +hpt, tiles: tiles.length, ppi, scaled };
}
