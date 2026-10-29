import { PLAN, PLANS } from "./config.js";
import { addBelowEdges } from "./layerOrder.js";
import { newestByName, tileLayout } from "./savedPlan.js";
import { cornerAffine, partCorners, partServes, wantedPart } from "./planDetail.js";

// Saved plans on the map. The Plans layer is private and not on the map, so a plan's image is fetched from its
// attachment with the SDK's own request (which adds the sign-in token) and drawn by a MediaLayer of its own: one
// ImageElement per tile, corners from the record's world file, multiply blend so the paper drops out. Shown plans are
// ordinary layers (in the Layers list and the legend), placed under the edge lengths like every plan image.
// A plan saved in pieces is one layer: every piece's image (or tiles) as elements of its own, with the same blend, so
// showing, opacity and hiding act on the whole plan. Each piece's corners come from its own world file.
//
// Each image is drawn at most PLAN.MAX_DIM on a side (the GPU's safe size), which for a long piece is several times
// coarser than it was saved. So when the map comes to rest, the part of each shown image in view is cut from the
// full-size image at the screen's own resolution (planDetail.js) and laid over it in the same layer. The saved file is
// kept (compressed) for that; the full-size decode is cached up to PLAN.DETAIL_CACHE_MP.
export async function createPlansOnMap({ mapEl, plansLayer }) {
  const [MediaLayer, ImageElement, CornersGeoreference, Point, SpatialReference, esriRequest, projectOperator, reactiveUtils] = await $arcgis.import([
    "@arcgis/core/layers/MediaLayer.js",
    "@arcgis/core/layers/support/ImageElement.js",
    "@arcgis/core/layers/support/CornersGeoreference.js",
    "@arcgis/core/geometry/Point.js",
    "@arcgis/core/geometry/SpatialReference.js",
    "@arcgis/core/request.js",
    "@arcgis/core/geometry/operators/projectOperator.js",
    "@arcgis/core/core/reactiveUtils.js",
  ]);
  if (!projectOperator.isLoaded()) await projectOperator.load();
  const view = mapEl.view;
  const F = PLANS.FIELDS;
  const shown = new Map(); // objectId -> { layer, images: [{ blob, w, h, sr, aff, shownK }], parts: [{ img, x0, y0, x1, y1, k, el, bmp }] }
  const listeners = new Set();
  const notify = () => listeners.forEach((cb) => cb());

  // The image at most PLAN.MAX_DIM on its longest side. A saved image can now be far bigger (its size comes from the
  // byte budget, up to GEOREF.MAX_CANVAS_SIDE), so when the record says it is, it is decoded straight to the smaller
  // size; the fallback below decodes it whole and draws it smaller.
  async function bitmapOf(data, w, h) {
    const k0 = w > 0 && h > 0 ? PLAN.MAX_DIM / Math.max(w, h) : 1;
    if (k0 < 1) {
      try {
        return await createImageBitmap(data, { resizeWidth: Math.max(1, Math.round(w * k0)), resizeHeight: Math.max(1, Math.round(h * k0)), resizeQuality: "high" });
      } catch (err) {
        console.warn("Couldn't decode the plan image at a reduced size; decoding it whole:", err);
      }
    }
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
    const records = plan.pieces?.length ? plan.pieces : [plan];
    const res = await plansLayer.queryAttachments({ objectIds: records.map((r) => r.objectId) });
    let elements = (await Promise.all(records.map(async (r) => {
      const ra = r.attributes;
      // the newest file of each name: an edit adds the new files before removing the old ones
      const items = newestByName(res[r.objectId] ?? []);
      const tiles = tileLayout(ra[F.WORLD_FILE], ra[F.IMG_WIDTH], ra[F.IMG_HEIGHT], items.map((i) => i.name));
      const sr = new SpatialReference({ wkid: ra[F.WKID] });
      const pt = ([x, y]) => new Point({ x, y, spatialReference: sr });
      return Promise.all(tiles.map(async (t) => {
        const item = items.find((i) => i.name === t.name);
        const [TL, TR, BR, BL] = t.corners;
        const { data } = await esriRequest(item.url, { responseType: "blob" });
        const image = await bitmapOf(data, t.w, t.h);
        const el = new ImageElement({ image, georeference: new CornersGeoreference({ topLeft: pt(TL), topRight: pt(TR), bottomLeft: pt(BL), bottomRight: pt(BR) }) });
        return { el, img: { blob: data, w: t.w, h: t.h, sr, aff: cornerAffine(t.corners, t.w, t.h), shownK: image.width / t.w } };
      }));
    }))).flat();
    if (shown.has(plan.objectId)) return; // shown by a faster click meanwhile
    const images = elements.map((e) => e.img);
    elements = elements.map((e) => e.el);
    const n = records.length;
    const layer = new MediaLayer({ source: elements, title: `Plan: ${a[F.NAME]}${n > 1 ? ` (${n} pieces)` : ""}`, opacity: PLAN.OPACITY, blendMode: "multiply" });
    await layer.load();
    addBelowEdges(mapEl.map, layer);
    shown.set(plan.objectId, { layer, images, parts: [], plan });
    notify();
    scheduleDetail();
  }

  // ---- the sharp parts
  const decoded = new Map(); // image -> full-size ImageBitmap, least recently used first
  async function fullSize(img) {
    const had = decoded.get(img);
    if (had) { decoded.delete(img); decoded.set(img, had); return had; }
    const bmp = await createImageBitmap(img.blob);
    decoded.set(img, bmp);
    let total = [...decoded.values()].reduce((s, b) => s + b.width * b.height, 0);
    for (const [k, b] of decoded) {
      if (total <= PLAN.DETAIL_CACHE_MP * 1e6 || k === img) continue;
      total -= b.width * b.height;
      b.close();
      decoded.delete(k);
    }
    return bmp;
  }
  function forget(img) { decoded.get(img)?.close(); decoded.delete(img); }
  const dropPart = (s, p) => { s.layer.source.elements.remove(p.el); p.bmp.close(); };

  // The part [x0, x1) x [y0, y1) of a full-size image at scale k, as an ImageBitmap (a canvas where resizing a bitmap
  // isn't supported).
  async function cut(full, p) {
    const sw = p.x1 - p.x0, sh = p.y1 - p.y0, W = Math.max(1, Math.round(sw * p.k)), H = Math.max(1, Math.round(sh * p.k));
    try {
      return await createImageBitmap(full, p.x0, p.y0, sw, sh, { resizeWidth: W, resizeHeight: H, resizeQuality: "high" });
    } catch {
      const c = Object.assign(document.createElement("canvas"), { width: W, height: H }), g = c.getContext("2d");
      g.imageSmoothingQuality = "high";
      g.drawImage(full, p.x0, p.y0, sw, sh, 0, 0, W, H);
      return createImageBitmap(c);
    }
  }

  let detailTimer = 0, run = 0;
  function scheduleDetail() { clearTimeout(detailTimer); detailTimer = setTimeout(updateDetail, 200); }
  // The view in a coordinate system: its corners and ground units per device pixel, or null.
  function viewIn(sr) {
    const e = view?.extent;
    if (!e || !view.width) return null;
    const c = [[e.xmin, e.ymin], [e.xmax, e.ymin], [e.xmax, e.ymax], [e.xmin, e.ymax]]
      .map(([x, y]) => projectOperator.execute(new Point({ x, y, spatialReference: e.spatialReference }), sr));
    if (c.some((p) => !p)) return null;
    const dpr = window.devicePixelRatio || 1;
    return { corners: c.map((p) => [p.x, p.y]), perDevicePx: Math.hypot(c[1].x - c[0].x, c[1].y - c[0].y) / (view.width * dpr) };
  }
  async function updateDetail() {
    if (!view) return;
    if (!view.stationary) { scheduleDetail(); return; }
    const mine = ++run, views = new Map();
    for (const [id, s] of shown) {
      const want = [];
      if (s.layer.visible) {
        for (const img of s.images) {
          const key = img.sr.wkid;
          if (!views.has(key)) views.set(key, viewIn(img.sr));
          const v = views.get(key);
          const p = v && wantedPart(v, img.aff, img.w, img.h, { shownK: img.shownK, maxDim: PLAN.MAX_DIM });
          if (p) want.push({ img, ...p });
        }
      }
      const keep = s.parts.filter((p) => want.some((w) => w.img === p.img && partServes(p, w)));
      s.parts.filter((p) => !keep.includes(p)).forEach((p) => dropPart(s, p));
      s.parts = keep;
      for (const w of want.filter((w) => !keep.some((p) => p.img === w.img && partServes(p, w)))) {
        try {
          const full = await fullSize(w.img);
          if (mine !== run || shown.get(id) !== s) return; // the view or the plans changed meanwhile
          const bmp = await cut(full, w);
          if (mine !== run || shown.get(id) !== s) { bmp.close(); return; }
          const pt = ([x, y]) => new Point({ x, y, spatialReference: w.img.sr });
          const [TL, TR, BR, BL] = partCorners(w.img.aff, w);
          const el = new ImageElement({ image: bmp, georeference: new CornersGeoreference({ topLeft: pt(TL), topRight: pt(TR), bottomLeft: pt(BL), bottomRight: pt(BR) }) });
          s.layer.source.elements.add(el);
          s.parts.push({ ...w, el, bmp });
        } catch (err) {
          console.warn("Couldn't show the plan sharper here; it stays as it is:", err);
        }
      }
    }
  }
  if (view) reactiveUtils.watch(() => view.stationary, (still) => { if (still && shown.size) scheduleDetail(); });

  function hide(objectId) {
    const s = shown.get(objectId);
    if (!s) return;
    s.parts.forEach((p) => p.bmp.close());
    s.images.forEach(forget);
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
    // the plans on the map, in the order they were shown: [{ objectId, plan, layer }]
    list: () => [...shown].map(([objectId, s]) => ({ objectId, plan: s.plan, layer: s.layer })),
    // show or hide a plan that stays on the map (its images stay loaded)
    setVisible(id, visible) {
      const s = shown.get(id);
      if (!s) return;
      s.layer.visible = visible;
      if (visible) scheduleDetail();
      notify();
    },
    onChange: (cb) => listeners.add(cb),
    hideAll() { [...shown.keys()].forEach(hide); },
  };
}
