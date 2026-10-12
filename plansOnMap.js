import { PLAN, PLANS } from "./config.js";
import { addBelowEdges } from "./layerOrder.js";
import { tileLayout } from "./savedPlan.js";

// Saved plans on the map. The Plans layer is private and not on the map, so a plan's image is fetched from its
// attachment with the SDK's own request (which adds the sign-in token) and drawn by a MediaLayer of its own: one
// ImageElement per tile, corners from the record's world file, multiply blend so the paper drops out. Shown plans are
// ordinary layers (in the Layers list and the legend), placed under the edge lengths like every plan image.
export async function createPlansOnMap({ mapEl, plansLayer }) {
  const [MediaLayer, ImageElement, CornersGeoreference, Point, SpatialReference, esriRequest] = await $arcgis.import([
    "@arcgis/core/layers/MediaLayer.js",
    "@arcgis/core/layers/support/ImageElement.js",
    "@arcgis/core/layers/support/CornersGeoreference.js",
    "@arcgis/core/geometry/Point.js",
    "@arcgis/core/geometry/SpatialReference.js",
    "@arcgis/core/request.js",
  ]);
  const F = PLANS.FIELDS;
  const shown = new Map(); // objectId -> { layer, extent, listeners }
  const listeners = new Set();
  const notify = () => listeners.forEach((cb) => cb());

  async function bitmapOf(url) {
    const { data } = await esriRequest(url, { responseType: "blob" });
    const bmp = await createImageBitmap(data);
    const longest = Math.max(bmp.width, bmp.height);
    if (longest <= PLAN.MAX_DIM) return bmp;
    const k = PLAN.MAX_DIM / longest; // the GPU's safe texture size is far below the saved image; corners still use the full size
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bmp.width * k);
    canvas.height = Math.round(bmp.height * k);
    canvas.getContext("2d").drawImage(bmp, 0, 0, canvas.width, canvas.height);
    bmp.close?.();
    return canvas;
  }

  async function show(plan) {
    if (shown.has(plan.objectId)) return;
    const a = plan.attributes;
    const res = await plansLayer.queryAttachments({ objectIds: [plan.objectId] });
    const items = res[plan.objectId] ?? [];
    const tiles = tileLayout(a[F.WORLD_FILE], a[F.IMG_WIDTH], a[F.IMG_HEIGHT], items.map((i) => i.name));
    const sr = new SpatialReference({ wkid: a[F.WKID] });
    const pt = ([x, y]) => new Point({ x, y, spatialReference: sr });
    const elements = await Promise.all(tiles.map(async (t) => {
      const item = items.find((i) => i.name === t.name);
      const [TL, TR, BR, BL] = t.corners;
      return new ImageElement({ image: await bitmapOf(item.url), georeference: new CornersGeoreference({ topLeft: pt(TL), topRight: pt(TR), bottomLeft: pt(BL), bottomRight: pt(BR) }) });
    }));
    if (shown.has(plan.objectId)) return; // shown by a faster click meanwhile
    const layer = new MediaLayer({ source: elements, title: `Plan: ${a[F.NAME]}`, opacity: PLAN.OPACITY, blendMode: "multiply" });
    await layer.load();
    addBelowEdges(mapEl.map, layer);
    shown.set(plan.objectId, { layer });
    notify();
  }

  function hide(objectId) {
    const s = shown.get(objectId);
    if (!s) return;
    mapEl.map.remove(s.layer);
    s.layer.destroy();
    shown.delete(objectId);
    notify();
  }

  // Zoom to a plan's footprint (the record's own geometry, so it works whether or not the image is shown).
  async function zoom(plan) {
    const g = plan.geometry;
    if (g) await mapEl.goTo(g.extent.clone().expand(1.15));
  }

  return {
    show, hide, zoom,
    isShown: (id) => shown.has(id),
    count: () => shown.size,
    layerOf: (id) => shown.get(id)?.layer ?? null,
    onChange: (cb) => listeners.add(cb),
    hideAll() { [...shown.keys()].forEach(hide); },
  };
}
