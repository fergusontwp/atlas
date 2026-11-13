// Only the approved browser preferences cross sessions. Text, callouts, names, margins and capture data do not.
import { printTextStyles } from "./printTextStyle.js";
import { PRINT } from "./config.js";
import { defaultOrientation } from "./printGeometry.js";

export function printSettings(stored, lastFrame) {
  const source = stored && typeof stored === "object" ? stored : {};
  return {
    pageSize: PRINT.PAGE_SIZES.some(([name]) => name === source.pageSize) ? source.pageSize : PRINT.DEFAULTS.pageSize,
    orientation: ["portrait", "landscape"].includes(source.orientation) ? source.orientation : defaultOrientation(lastFrame),
    border: typeof source.border === "boolean" ? source.border : PRINT.DEFAULTS.border,
    format: ["pdf", "png"].includes(source.format) ? source.format : PRINT.DEFAULTS.format,
    elements: Object.fromEntries(Object.entries(PRINT.DEFAULTS.elements).map(([id, on]) =>
      [id, typeof source.elements?.[id] === "boolean" ? source.elements[id] : on])),
    styles: printTextStyles(source.styles),
    marginIn: PRINT.MARGIN_IN,
  };
}

export function rememberedPrintSettings(settings) {
  const { pageSize, orientation, border, format, elements, styles } = printSettings(settings);
  return { pageSize, orientation, border, format, elements, styles };
}
