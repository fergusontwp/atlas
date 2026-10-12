// Print geometry in PDF points (72 per inch), with a top-left origin. No DOM or SDK.
import { PRINT } from "./config.js";

export function pageGeometry({ pageSize = PRINT.DEFAULTS.pageSize, orientation = PRINT.DEFAULTS.orientation,
  marginIn = PRINT.MARGIN_IN, stripPercent = PRINT.STRIP_HEIGHT_PERCENT } = {}) {
  const size = PRINT.PAGE_SIZES.find(([name]) => name === pageSize);
  if (!size) throw new Error("Unknown print page size.");
  if (!["portrait", "landscape"].includes(orientation)) throw new Error("Unknown page orientation.");
  if (!Number.isFinite(marginIn) || marginIn < 0 || !Number.isFinite(stripPercent) || stripPercent <= 0 || stripPercent >= 100) {
    throw new Error("Invalid print margins or strip height.");
  }
  const [, short, long] = size;
  const width = (orientation === "landscape" ? long : short) * 72;
  const height = (orientation === "landscape" ? short : long) * 72;
  const margin = marginIn * 72;
  const innerWidth = width - 2 * margin, innerHeight = height - 2 * margin;
  if (innerWidth <= 0 || innerHeight <= 0) throw new Error("Print margins leave no map area.");
  const stripHeight = innerHeight * stripPercent / 100;
  return {
    width, height, margin,
    map: { x: margin, y: margin, width: innerWidth, height: innerHeight - stripHeight },
    strip: { x: margin, y: height - margin - stripHeight, width: innerWidth, height: stripHeight },
  };
}

// SDK screenshot areas use integral view pixels. Round inward; the aspect error is at most one pixel.
export function frameRect(viewWidth, viewHeight, map, inset = PRINT.FRAME_INSET_PX) {
  if (![viewWidth, viewHeight, map.width, map.height].every((n) => Number.isFinite(n) && n > 0) || !Number.isFinite(inset) || inset < 0) {
    throw new Error("Invalid print frame dimensions.");
  }
  const availableWidth = Math.floor(viewWidth - 2 * inset), availableHeight = Math.floor(viewHeight - 2 * inset);
  if (availableWidth < 1 || availableHeight < 1) return null;
  const fit = Math.min(availableWidth / map.width, availableHeight / map.height);
  const width = Math.max(1, Math.floor(map.width * fit)), height = Math.max(1, Math.floor(map.height * fit));
  return { x: Math.floor((viewWidth - width) / 2), y: Math.floor((viewHeight - height) / 2), width, height };
}

export function defaultOrientation(lastFrame) {
  const ratio = lastFrame?.width / lastFrame?.height;
  // Ignore absent, nearly square, or implausibly thin frames.
  return Number.isFinite(ratio) && ratio >= 0.4 && ratio < 0.98 ? "portrait" : "landscape";
}

export function frameMidline(frame) {
  const y = frame.y + frame.height / 2;
  return [{ x: frame.x, y }, { x: frame.x + frame.width, y }];
}
