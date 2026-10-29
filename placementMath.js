// The arithmetic behind "predicted next corner" and the working-CRS guard. No DOM and no SDK imports, so it can be
// tested alone. Ported from updateSuggestion in georeferencer/js/app/30-points.js (the maths only; the markers are the SDK's).

import { applyT, invertT } from "./georefTransform.js";

// Where does the current fit say a sheet point is on the map? { X, Y, snapped }: the nearest parcel corner within a
// tolerance of three times the fit's own error (and never under minTolFt) if there is one, else the predicted spot itself.
// nearest(X, Y, tol) is the vertex index's lookup.
export function suggestMapPoint({ T, x, y, rms = 0, looRms = 0, nearest, minTolFt = 8 }) {
  const [X, Y] = applyT(T, x, y);
  const slack = Math.max(rms || 0, looRms || 0) * 3;
  const hit = nearest?.(X, Y, Math.max(slack, minTolFt));
  return hit ? { X: hit.X, Y: hit.Y, snapped: true } : { X, Y, snapped: false };
}

// Where does the current fit put a map point on the sheet? [x, y] in page points, or null if the fit can't be inverted.
export function predictPagePoint(T, X, Y) {
  const inv = invertT(T);
  return inv ? inv.toPage(X, Y) : null;
}

// Why a working CRS can't be used (a sentence), or null. It must be projected and measured in feet, because the fit,
// the tolerances and the error are all in feet. sr: { isGeographic, metersPerUnit, wkid }.
export function workingCrsProblem(sr) {
  const feet = [0.3048, 1200 / 3937];
  if (!sr || sr.isGeographic) return `GEOREF.WORKING_WKID ${sr?.wkid ?? ""} is not a projected coordinate system. Use one measured in feet, such as 2271.`.replace("  ", " ");
  if (!feet.some((f) => Math.abs(sr.metersPerUnit - f) < 1e-6)) return `GEOREF.WORKING_WKID ${sr.wkid} is not measured in feet (a unit is ${sr.metersPerUnit} m). Use one in feet, such as 2271.`;
  return null;
}
