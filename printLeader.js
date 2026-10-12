// Per-callout leader settings and contrast, independent of DOM and SDK.
import { PRINT } from "./config.js";
export function printColor(value, fallback = "#000000") {
  const hex = String(value ?? "").trim();
  if (/^#[0-9a-f]{6}$/i.test(hex)) return hex.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(hex)) return "#" + [...hex.slice(1)].map((digit) => digit + digit).join("").toLowerCase();
  return fallback;
}
export function outlineColor(color) {
  const hex = printColor(color), rgb = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const linear = rgb.map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722 > PRINT.LEADER.CONTRAST_THRESHOLD ? "#000000" : "#ffffff";
}
export function leaderStyle(value = {}) {
  value = value && typeof value === "object" ? value : {};
  const defaults = PRINT.LEADER, color = printColor(value.color, defaults.COLOR);
  return { color, width: Math.max(defaults.MIN_WIDTH_PT, Math.min(defaults.MAX_WIDTH_PT, Number(value.width) || defaults.WIDTH_PT)),
    outline: typeof value.outline === "boolean" ? value.outline : defaults.OUTLINE,
    outlineColor: value.outlineColor ? printColor(value.outlineColor, outlineColor(color)) : null };
}
export function drawLeader(drawing, start, tip, value) {
  const style = leaderStyle(value);
  if (style.outline) drawing.line(start.x, start.y, tip.x, tip.y,
    { stroke: style.outlineColor ?? outlineColor(style.color), width: style.width + 2 * PRINT.LEADER.OUTLINE_PADDING_PT });
  drawing.line(start.x, start.y, tip.x, tip.y, { stroke: style.color, width: style.width });
  return style;
}
