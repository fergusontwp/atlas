import { HIGHLIGHT } from "./config.js";

// The selected parcel as an outline with no fill, for while something is drawn over or under it (What's in this parcel,
// Plans, the georeferencing workspace, a shown plan). Two polygon graphics of the parcel's full-precision geometry in a
// small graphics layer: a thick yellow outline underneath, a thinner black one on top, so yellow shows on both sides.
// The layer sits directly under the edge-length text (above plans, result copies and the "Within" outline) and never
// takes clicks (no popup, no fill to hit). While the mode is on the layer view's highlight is switched off (panel.js).
// reasons: selectionMode.createReasons().
export async function setupSelectionOutline({ mapEl, parcel, panel, reasons }) {
  const [GraphicsLayer, Graphic] = await $arcgis.import(["@arcgis/core/layers/GraphicsLayer.js", "@arcgis/core/Graphic.js"]);
  const map = mapEl.map;
  const O = HIGHLIGHT.OUTLINE;
  const layer = new GraphicsLayer({ id: "selection-outline", title: "Selected parcel", listMode: "hide", popupEnabled: false });
  map.add(layer);

  // Directly below the edge lengths, however many plan or result layers are added later (they are inserted just
  // below the edge lengths too, which would otherwise land them above this one).
  const place = () => {
    const edge = map.layers.findIndex((l) => l.id === "edge-lengths");
    const at = map.layers.indexOf(layer);
    if (edge < 0 || at < 0) return;
    const want = at < edge ? edge - 1 : edge;
    if (at !== want) map.reorder(layer, want);
  };
  map.layers.on("change", place);
  place();

  const symbol = (color, width) => ({ type: "simple-fill", color: [0, 0, 0, 0], outline: { color, width, style: "solid", cap: "round", join: "round" } });
  let shownOid = null;
  let token = 0;

  async function sync() {
    const mine = ++token;
    const oid = reasons.active ? panel.selectedObjectId() : null;
    if (oid === null) {
      shownOid = null;
      layer.removeAll();
      return;
    }
    if (oid === shownOid) return;
    try {
      const { features } = await parcel.queryFeatures({ objectIds: [oid], returnGeometry: true, outFields: [], outSpatialReference: mapEl.spatialReference });
      if (mine !== token) return; // a newer selection or the mode ended meanwhile
      const geometry = features[0]?.geometry;
      if (!geometry) { layer.removeAll(); shownOid = null; return; }
      // the new outline goes in before the old one comes out, so there is no frame without one
      const fresh = [new Graphic({ geometry, symbol: symbol(HIGHLIGHT.color, O.YELLOW_WIDTH) }), new Graphic({ geometry, symbol: symbol(O.BLACK, O.BLACK_WIDTH) })];
      const old = layer.graphics.toArray();
      layer.addMany(fresh);
      layer.removeMany(old);
      shownOid = oid;
    } catch (err) {
      if (err?.name !== "AbortError") console.warn("Couldn't outline the selected parcel:", err);
    }
  }

  const update = () => {
    panel.setHighlightOff(reasons.active);
    sync();
  };
  panel.onSelectionChange(sync);
  return { update, layer, get shown() { return shownOid; } };
}
