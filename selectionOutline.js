import { HIGHLIGHT } from "./config.js";
import { outlineSymbols } from "./selectionMode.js";
import { highlightColor } from "./highlightColor.js";

// The selected feature, always as an outline with no fill (the SDK's highlight is never requested for the selection).
// Two graphics in a small graphics layer: a thick yellow outline underneath, a thinner black one on top, so yellow shows
// on both sides. It is drawn at once from the clicked or queried graphic's geometry, then replaced by the feature's
// full-precision geometry when that arrives (new graphics added before the old are removed, so there is no gap). A
// polygon (the parcel, as before) gets no-fill outlines, a line two lines, a point two rings (selectionMode.outlineSymbols),
// so a selected road or hydrant stays visible above a multiply plan image too.
// The layer sits directly under the edge-length text (above plans, result copies and the "Within" outline) and never
// takes clicks (no popup, nothing filled to hit).
export async function setupSelectionOutline({ mapEl, parcel, panel }) {
  const [GraphicsLayer, Graphic] = await $arcgis.import(["@arcgis/core/layers/GraphicsLayer.js", "@arcgis/core/Graphic.js"]);
  const map = mapEl.map;
  const layer = new GraphicsLayer({ id: "selection-outline", title: "Selected feature", listMode: "hide", popupEnabled: false });
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

  let shownKey = null;
  let token = 0;

  // The feature's full-precision geometry in the view's spatial reference: the parcel from the parcel layer (as before),
  // anything else from its own layer by object id, or the clicked shape when the layer can't be asked.
  async function geometryOf(selection) {
    const source = selection.isParcel ? parcel : selection.layer;
    if (source?.queryFeatures && selection.oid !== null) {
      try {
        const { features } = await source.queryFeatures({ objectIds: [selection.oid], returnGeometry: true, outFields: [], outSpatialReference: mapEl.spatialReference });
        return features[0]?.geometry ?? null;
      } catch (err) {
        if (selection.isParcel || err?.name === "AbortError") throw err;
        console.warn("Couldn't read the selected feature at full precision; outlining the clicked shape:", err);
      }
    }
    return selection.graphic?.geometry ?? null;
  }

  // the new outline goes in before the old one comes out, so there is no frame without one
  let drawn = null; // the geometry outlined now
  function draw(geometry) {
    drawn = geometry;
    const fresh = outlineSymbols(geometry.type, { color: highlightColor.get(), outline: HIGHLIGHT.OUTLINE }).map((symbol) => new Graphic({ geometry, symbol }));
    const old = layer.graphics.toArray();
    layer.addMany(fresh);
    layer.removeMany(old);
  }

  let precise = false; // whether the outline shown is the full-precision one
  async function sync() {
    const selection = panel.selectedFeature();
    const key = selection && `${selection.layer?.id}:${selection.oid}`;
    if (selection && key === shownKey) return; // the same feature again (paging back, a repeat notice): keep it
    const mine = ++token;
    shownKey = key;
    precise = false;
    if (!selection) { layer.removeAll(); drawn = null; return; }
    // at once: the clicked or queried shape
    if (selection.graphic?.geometry) draw(selection.graphic.geometry);
    else { layer.removeAll(); drawn = null; }
    try {
      const geometry = await geometryOf(selection);
      if (mine !== token) return; // a newer selection meanwhile
      if (geometry) { draw(geometry); precise = true; }
    } catch (err) {
      if (err?.name !== "AbortError") console.warn("Couldn't outline the selected feature at full precision:", err);
    }
  }

  panel.onSelectionChange(sync);
  highlightColor.onChange(() => { if (drawn) draw(drawn); }); // a new color: the same outline, new symbols
  return { layer, get shown() { return shownKey; }, get precise() { return precise; } };
}
