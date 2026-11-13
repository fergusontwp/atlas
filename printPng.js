// Preserve native PNG image bytes, replacing only density metadata so physical page scale is available to print tools.
import { crc32 } from "./zipWriter.js";
const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
export function pngWithDpi(bytes, dpi) {
  if (!(bytes instanceof Uint8Array) || !SIGNATURE.every((byte, i) => bytes[i] === byte) || !Number.isFinite(dpi) || dpi <= 0) throw new Error("Invalid PNG density input.");
  const density = new Uint8Array(21), view = new DataView(density.buffer), ppm = Math.round(dpi / 0.0254);
  if (ppm < 1 || ppm > 0xffffffff) throw new Error("Invalid PNG density.");
  view.setUint32(0, 9); density.set([112, 72, 89, 115], 4);
  view.setUint32(8, ppm); view.setUint32(12, ppm); density[16] = 1;
  view.setUint32(17, crc32(density.subarray(4, 17)));
  const chunks = [bytes.subarray(0, 8)], input = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let ended = false;
  for (let offset = 8; offset < bytes.length;) {
    if (offset + 12 > bytes.length) throw new Error("Invalid PNG chunk.");
    const length = input.getUint32(offset), end = offset + length + 12;
    if (end > bytes.length) throw new Error("Invalid PNG chunk.");
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (type !== "pHYs") chunks.push(bytes.subarray(offset, end));
    if (offset === 8) {
      if (type !== "IHDR" || length !== 13) throw new Error("Invalid PNG header.");
      chunks.push(density);
    }
    if (type === "IEND") { ended = true; if (end !== bytes.length) throw new Error("Invalid PNG end."); }
    offset = end;
  }
  if (!ended) throw new Error("Missing PNG end.");
  const output = new Uint8Array(chunks.reduce((length, chunk) => length + chunk.length, 0));
  let offset = 0; chunks.forEach((chunk) => { output.set(chunk, offset); offset += chunk.length; });
  return output;
}
