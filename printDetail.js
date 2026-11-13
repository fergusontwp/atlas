// Native map detail and whole-page memory guards. No requested/manual output DPI.
import { PRINT } from "./config.js";

export function effectiveDpi(pixels, inches) {
  if (![pixels, inches].every((n) => Number.isFinite(n) && n > 0)) throw new Error("Invalid map detail dimensions.");
  return pixels / inches;
}

export function detailMessage(dpi, warnDpi = PRINT.DETAIL_WARN_DPI) {
  if (!Number.isFinite(dpi) || dpi <= 0) throw new Error("Invalid map detail.");
  return { label: `Map detail: ~${Math.round(dpi)} dpi`,
    note: dpi < warnDpi ? "Soft at this page size; text and scale bar stay sharp" : "" };
}

export function pagePixels(page, mapWidthPx, mapHeightPx) {
  // The limiting axis avoids ever enlarging map pixels, including the frame's integral rounding.
  const pixelsPerPoint = Math.min(mapWidthPx / page.map.width, mapHeightPx / page.map.height);
  if (!Number.isFinite(pixelsPerPoint) || pixelsPerPoint <= 0) throw new Error("Invalid map pixel dimensions.");
  return { width: Math.ceil(page.width * pixelsPerPoint), height: Math.ceil(page.height * pixelsPerPoint), pixelsPerPoint,
    dpi: effectiveDpi(pixelsPerPoint, 1 / 72) };
}

export function captureSize(view, frame, page, limits = PRINT) {
  if (![view.width, view.height, frame.width, frame.height].every((n) => Number.isInteger(n) && n > 0)
    || ![frame.x, frame.y].every((n) => Number.isInteger(n) && n >= 0)
    || frame.x + frame.width > view.width || frame.y + frame.height > view.height) throw new Error("Invalid capture area.");
  const nativeLimit = Math.min(limits.NATIVE_MAX_PX, view.maxTextureSize ?? limits.NATIVE_MAX_PX);
  let multiplier = Math.floor(Math.min(limits.MAX_MULTIPLIER, nativeLimit / Math.max(view.width, view.height)));
  for (; multiplier >= 1; multiplier--) {
    const width = frame.width * multiplier, height = frame.height * multiplier;
    const output = pagePixels(page, width, height);
    if (output.width * output.height <= limits.MAX_PIXELS && Math.max(output.width, output.height) <= limits.MAX_SIDE_PX) {
      return { multiplier, width, height, area: { ...frame }, ignorePadding: true, output };
    }
  }
  // A full view exceeding the native ceiling has no safe INTEGER rerender multiplier. Never round it up to 1.
  throw new Error("The map is too large to capture safely. Reduce the window size and try again.");
}
