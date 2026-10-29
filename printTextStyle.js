// Only style properties cross browser sessions. Text and callout geometry are never preferences.
import { PRINT } from "./config.js";
import { printColor } from "./printLeader.js";
export function textStyle(value, id = "notes") {
  const defaults = PRINT.TEXT_STYLES[id];
  if (!defaults) throw new Error("Unknown print text style.");
  const source = value && typeof value === "object" ? value : {};
  const size = Number(source.size);
  const style = { size: Number.isFinite(size) && size > 0 ? Math.max(PRINT.TEXT.MIN_SIZE_PT, Math.min(PRINT.TEXT.MAX_SIZE_PT, size)) : defaults.size,
    bold: typeof source.bold === "boolean" ? source.bold : defaults.bold };
  if (id === "legend" || id === "scaleBar") return style;
  return { ...style, italic: typeof source.italic === "boolean" ? source.italic : defaults.italic,
    underline: typeof source.underline === "boolean" ? source.underline : defaults.underline,
    color: printColor(source.color, defaults.color), align: ["left", "center", "right"].includes(source.align) ? source.align : defaults.align };
}
export function printTextStyles(source) {
  return Object.fromEntries(Object.keys(PRINT.TEXT_STYLES).map((id) => [id, textStyle(source?.[id], id)]));
}
export function calloutTextStyle(item) { return textStyle({ size: item.size, ...item.textStyle }, "callout"); }
