// Inputs are already projected into GEOREF.WORKING_WKID (2271, US survey feet). No Web Mercator scale math here.
export function groundScale(left, right, mapWidthPt) {
  if (![left?.x, left?.y, right?.x, right?.y, mapWidthPt].every(Number.isFinite) || mapWidthPt <= 0) {
    throw new Error("Invalid projected print scale measurement.");
  }
  const distanceFt = Math.hypot(right.x - left.x, right.y - left.y);
  if (distanceFt === 0) throw new Error("Print scale measurement has no ground distance.");
  const feetPerInch = distanceFt / (mapWidthPt / 72);
  return { distanceFt, feetPerInch, denominator: feetPerInch * 12 };
}

export function correctedViewScale(viewScale, measuredFeetPerInch, targetFeetPerInch) {
  if (![viewScale, measuredFeetPerInch, targetFeetPerInch].every((n) => Number.isFinite(n) && n > 0)) {
    throw new Error("Invalid print scale target.");
  }
  return viewScale * targetFeetPerInch / measuredFeetPerInch;
}

export function niceScaleBar(feetPerInch, availableWidthPt) {
  if (![feetPerInch, availableWidthPt].every((n) => Number.isFinite(n) && n > 0)) throw new Error("Invalid scale bar dimensions.");
  const maxFeet = availableWidthPt / 72 * feetPerInch;
  const miles = maxFeet >= 5280;
  const divisor = miles ? 5280 : 1, maxUnits = maxFeet / divisor;
  const power = 10 ** Math.floor(Math.log10(maxUnits));
  const units = [1, 2, 5].filter((n) => n * power <= maxUnits).pop() * power;
  const feet = units * divisor;
  return { feet, lengthPt: feet / feetPerInch * 72, units, unit: miles ? "mi" : "ft", segments: 4 };
}

// Own immutable JSON copies, not live SDK extent/viewpoint objects. The capture adapter supplies toJSON() values.
export function freezeCaptureState({ viewpoint, extent, frame, feetPerInch, rotation, snapToZoom }) {
  if (!viewpoint || !extent || !frame || !Number.isFinite(feetPerInch) || feetPerInch <= 0 || !Number.isFinite(rotation)
    || typeof snapToZoom !== "boolean") throw new Error("Invalid frozen print view.");
  const copy = JSON.parse(JSON.stringify({ viewpoint, extent, frame, feetPerInch, rotation, snapToZoom }));
  const freeze = (value) => {
    if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
    return value;
  };
  return freeze(copy);
}
