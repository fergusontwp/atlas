// Zoom buttons and the compass (north arrow; click it to reset the map to north).
// Both are children of the map element, so they're added once the map exists.
export function setupMapControls(mapEl) {
  for (const tag of ["arcgis-zoom", "arcgis-compass"]) {
    const el = document.createElement(tag);
    el.slot = "top-left";
    mapEl.append(el);
  }
}
