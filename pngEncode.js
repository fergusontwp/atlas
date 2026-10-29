// A minimal PNG encoder for the saved plan image. No DOM and no SDK imports, so it runs in Node, a page or a worker.
// The zlib stream comes from the platform's CompressionStream('deflate') (zlib framing, checked); everything else is here.
//
// Formats (the `data` layout each one takes):
//   "rgba"     RGBA bytes, 4 per pixel
//   "rgb"      RGB bytes, 3 per pixel
//   "gray"     one byte per pixel (8-bit grayscale)
//   "gray1"    one byte per pixel, 0 (black) or 1 (white); packed to 1 bit per pixel here
//   "indexed"  one byte per pixel, an index into `palette` (RGB bytes, 3 per entry); `paletteAlpha` (one byte per entry,
//              optional) makes entries transparent
// Rows are filtered adaptively (the filter that leaves the smallest sum of absolute residuals wins) for rgba, rgb and
// gray; 1-bit and indexed rows are left unfiltered, as the PNG specification advises for them.

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

const FORMATS = {
  rgba: { colorType: 6, bitDepth: 8, bytesPerPixel: 4, adaptive: true },
  rgb: { colorType: 2, bitDepth: 8, bytesPerPixel: 3, adaptive: true },
  gray: { colorType: 0, bitDepth: 8, bytesPerPixel: 1, adaptive: true },
  gray1: { colorType: 0, bitDepth: 1, bytesPerPixel: 1, adaptive: false },
  indexed: { colorType: 3, bitDepth: 8, bytesPerPixel: 1, adaptive: false },
};

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes, start = 0, end = bytes.length) {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// zlib-framed deflate of some bytes, with the platform's CompressionStream.
export async function deflateZlib(bytes) {
  const stream = new CompressionStream("deflate");
  const writer = stream.writable.getWriter();
  writer.write(bytes);
  writer.close();
  return new Uint8Array(await new Response(stream.readable).arrayBuffer());
}

function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}

const paeth = (a, b, c) => {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};
const absByte = (v) => (v < 128 ? v : 256 - v); // a filtered byte read as signed

// Every row prefixed with its filter type. With adaptive off the type is always 0 (none). bytesPerPixel is the filter's
// "bpp": whole bytes per pixel, at least 1.
export function filterRows(data, rowBytes, height, bytesPerPixel, adaptive) {
  const out = new Uint8Array(height * (rowBytes + 1));
  if (!adaptive) {
    for (let y = 0; y < height; y++) out.set(data.subarray(y * rowBytes, (y + 1) * rowBytes), y * (rowBytes + 1) + 1);
    return out;
  }
  const zero = new Uint8Array(rowBytes);
  const cand = [null, new Uint8Array(rowBytes), new Uint8Array(rowBytes), new Uint8Array(rowBytes), new Uint8Array(rowBytes)];
  const bpp = bytesPerPixel;
  for (let y = 0; y < height; y++) {
    const row = data.subarray(y * rowBytes, (y + 1) * rowBytes);
    const prev = y ? data.subarray((y - 1) * rowBytes, y * rowBytes) : zero;
    let s0 = 0, s1 = 0, s2 = 0, s3 = 0, s4 = 0;
    for (let i = 0; i < rowBytes; i++) {
      const x = row[i];
      const a = i >= bpp ? row[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      const f1 = (x - a) & 255;
      const f2 = (x - b) & 255;
      const f3 = (x - ((a + b) >> 1)) & 255;
      const f4 = (x - paeth(a, b, c)) & 255;
      cand[1][i] = f1; cand[2][i] = f2; cand[3][i] = f3; cand[4][i] = f4;
      s0 += absByte(x); s1 += absByte(f1); s2 += absByte(f2); s3 += absByte(f3); s4 += absByte(f4);
    }
    let best = 0;
    let bestSum = s0;
    for (const [type, sum] of [[1, s1], [2, s2], [3, s3], [4, s4]]) {
      if (sum < bestSum) { best = type; bestSum = sum; }
    }
    const o = y * (rowBytes + 1);
    out[o] = best;
    out.set(best === 0 ? row : cand[best], o + 1);
  }
  return out;
}

// Pixels of a "gray1" image (one byte each, 0 or 1) packed 8 to a byte, most significant bit first, rows padded.
function packBits(data, width, height) {
  const rowBytes = Math.ceil(width / 8);
  const out = new Uint8Array(rowBytes * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) if (data[y * width + x]) out[y * rowBytes + (x >> 3)] |= 0x80 >> (x & 7);
  }
  return out;
}

// image: { width, height, format, data, palette?, paletteAlpha? }; options: { deflate } (async, zlib-framed; the default
// is CompressionStream). Returns the PNG file's bytes.
export async function encodePng({ width, height, format, data, palette, paletteAlpha }, { deflate = deflateZlib } = {}) {
  const f = FORMATS[format];
  if (!f) throw new Error(`Unknown PNG format "${format}"`);
  if (!(width > 0 && height > 0)) throw new Error("PNG needs a width and height");
  const need = width * height * (format === "rgba" ? 4 : format === "rgb" ? 3 : 1);
  if (data.length !== need) throw new Error(`PNG data is ${data.length} bytes; ${width} x ${height} ${format} needs ${need}`);
  if (format === "indexed" && !(palette?.length >= 3 && palette.length <= 768 && palette.length % 3 === 0)) throw new Error("An indexed PNG needs a palette of 1 to 256 RGB entries");

  const samples = format === "gray1" ? packBits(data, width, height) : data;
  const rowBytes = format === "gray1" ? Math.ceil(width / 8) : width * f.bytesPerPixel;
  const filtered = filterRows(samples, rowBytes, height, f.bytesPerPixel, f.adaptive);
  const idat = await deflate(filtered);

  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = f.bitDepth;
  ihdr[9] = f.colorType;
  const parts = [Uint8Array.from(SIGNATURE), chunk("IHDR", ihdr)];
  if (format === "indexed") {
    parts.push(chunk("PLTE", palette));
    if (paletteAlpha) {
      // trailing fully opaque entries can be left out
      let n = paletteAlpha.length;
      while (n > 0 && paletteAlpha[n - 1] === 255) n--;
      if (n > 0) parts.push(chunk("tRNS", paletteAlpha.subarray(0, n)));
    }
  }
  parts.push(chunk("IDAT", idat), chunk("IEND", new Uint8Array(0)));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
