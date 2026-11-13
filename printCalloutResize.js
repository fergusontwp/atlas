// Resize in page points. Preserve the opposite edge where possible; text sets the minimum height.
import { PRINT } from "./config.js";
import { calloutBox } from "./printCalloutMath.js";
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
export function resizeCallout(item, map, handle, delta) {
  if (!["nw", "n", "ne", "e", "se", "s", "sw", "w"].includes(handle)
    || ![delta.x, delta.y].every(Number.isFinite)) throw new Error("Invalid callout resize.");
  const box = calloutBox(item, map), right = box.x + box.width, bottom = box.y + box.height;
  const minimum = Math.min(PRINT.CALLOUT.MIN_WIDTH_PT, map.width);
  let x = box.x, y = box.y, width = box.width, height = box.height;
  if (handle.includes("w")) { x = clamp(x + delta.x, map.x, right - minimum); width = right - x; }
  if (handle.includes("e")) width = clamp(width + delta.x, minimum, map.x + map.width - x);
  const textHeight = calloutBox({ ...item, width, height: 0 }, map).height;
  if (handle.includes("n")) { height = Math.max(textHeight, Math.min(bottom - map.y, height - delta.y)); y = bottom - height; }
  else if (handle.includes("s")) height = Math.max(textHeight, Math.min(map.y + map.height - y, height + delta.y));
  else height = Math.max(textHeight, Number(item.height) || 0);
  x = clamp(x, map.x, map.x + map.width - width); y = clamp(y, map.y, Math.max(map.y, map.y + map.height - height));
  return { width, height: /[ns]/.test(handle) ? height : Number(item.height) || 0, position: { x: (x - map.x) / map.width, y: (y - map.y) / map.height } };
}
