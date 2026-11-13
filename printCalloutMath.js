import { calloutTextStyle } from "./printTextStyle.js";
import { textBlock } from "./pdfFonts.js";
import { PRINT } from "./config.js";
const clamp = (n, low, high) => Math.max(low, Math.min(high, n));
const overlap = (a, b) => Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x))
  * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));

export function calloutBox(item, map) {
  const style = calloutTextStyle(item), size = style.size;
  const width = clamp(Number(item.width) || PRINT.CALLOUT.WIDTH_PT, Math.min(PRINT.CALLOUT.MIN_WIDTH_PT, map.width), map.width);
  const text = textBlock(item.text || " ", Math.max(1, width - 2 * PRINT.CALLOUT.PADDING_PT), { ...style, leading: size * PRINT.TEXT.LEADING });
  const height = Math.max(text.height + 2 * PRINT.CALLOUT.PADDING_PT, Number(item.height) || 0);
  return { x: clamp(map.x + (item.position?.x ?? 0) * map.width, map.x, map.x + map.width - width),
    y: clamp(map.y + (item.position?.y ?? 0) * map.height, map.y, map.y + map.height - height), width, height, text };
}

export function leaderStart(box, tip) {
  const x = clamp(tip.x, box.x, box.x + box.width), y = clamp(tip.y, box.y, box.y + box.height);
  if (x !== tip.x || y !== tip.y) return { x, y };
  return [{ x: box.x, y }, { x: box.x + box.width, y }, { x, y: box.y }, { x, y: box.y + box.height }]
    .sort((a, b) => Math.hypot(a.x - tip.x, a.y - tip.y) - Math.hypot(b.x - tip.x, b.y - tip.y))[0];
}

// Try each side, then clear positions along that side. Distance decides among equally clear choices.
export function placeCallout(tip, size, map, occupied = []) {
  const { width, height } = size;
  const inset = 8, left = map.x + inset, right = map.x + map.width - size.width - inset;
  const top = map.y + inset, bottom = map.y + map.height - size.height - inset;
  const candidates = [];
  for (const y of [tip.y - size.height / 2, top, bottom, ...occupied.flatMap((box) => [box.y - size.height - inset, box.y + box.height + inset])]) {
    for (const x of [left, right]) candidates.push({ x, y: clamp(y, top, bottom), width, height });
  }
  for (const x of [tip.x - size.width / 2, left, right, ...occupied.flatMap((box) => [box.x - size.width - inset, box.x + box.width + inset])]) {
    for (const y of [top, bottom]) candidates.push({ x: clamp(x, left, right), y, width, height });
  }
  const score = (box) => occupied.reduce((sum, other) => sum + overlap(box, other), 0) * 100000
    + Math.hypot(leaderStart(box, tip).x - tip.x, leaderStart(box, tip).y - tip.y);
  const best = candidates.sort((a, b) => score(a) - score(b))[0];
  return { x: (best.x - map.x) / map.width, y: (best.y - map.y) / map.height };
}

export function screenToPage(point, frame, map) {
  return { x: map.x + (point.x - frame.x) * map.width / frame.width, y: map.y + (point.y - frame.y) * map.height / frame.height };
}
export function pageToScreen(point, frame, map) {
  return { x: frame.x + (point.x - map.x) * frame.width / map.width, y: frame.y + (point.y - map.y) * frame.height / map.height };
}
export const insideMap = (point, map) => point && point.x >= map.x && point.x <= map.x + map.width && point.y >= map.y && point.y <= map.y + map.height;
