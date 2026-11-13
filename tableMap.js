import { HIGHLIGHT, TABLE } from "./config.js";
import { outlineSymbols } from "./selectionMode.js";
import { highlightColor } from "./highlightColor.js";

// The attribute table on the map (attributeTable.js): the active tab's selection and the hovered row. Never the SDK's
// highlight (HighlightOptions are never touched on a live view; section 44).
//
//   table-selection  a list-hidden group directly under selection-outline, re-placed when the map's layers change. It
//                    holds two graphics layers, the casings under the lines, so neighbouring features never cover each
//                    other's line: the highlight color, thinner than the active outline (TABLE.SELECTION_SYMBOL), on the
//                    same contrasting casing (casingColor); no fill; points as small rings.
//   table-hover      one feature emphasized while the pointer is over its row: above table-selection, below
//                    selection-outline (the selection outline's own symbols).
//
// Geometry is queried by object id in batches, generalized to the view (maxAllowableOffset = the view's resolution) and
// cached per tab; past TABLE.SELECTION_FULL_PRECISION_SCALE the features in view are read again at full precision. At
// most TABLE.MAX_DRAWN are drawn (the first in table order).
export async function setupTableMap({ mapEl }) {
  const [GraphicsLayer, GroupLayer, Graphic, reactiveUtils] = await $arcgis.import([
    "@arcgis/core/layers/GraphicsLayer.js", "@arcgis/core/layers/GroupLayer.js", "@arcgis/core/Graphic.js", "@arcgis/core/core/reactiveUtils.js",
  ]);
  const map = mapEl.map, view = mapEl.view;
  const casings = new GraphicsLayer({ id: "table-selection-casing", title: "Table selection (casing)", listMode: "hide" });
  const lines = new GraphicsLayer({ id: "table-selection-line", title: "Table selection (line)", listMode: "hide" });
  const selection = new GroupLayer({ id: "table-selection", title: "Table selection", listMode: "hide", layers: [casings, lines] });
  const hover = new GraphicsLayer({ id: "table-hover", title: "Table hover", listMode: "hide" });
  map.addMany([selection, hover]);

  // directly under selection-outline (selectionOutline.js keeps that one under the edge lengths), hover between them
  // (map.reorder(layer, i): i counts from the bottom; moving a layer that sits below the target goes to target - 1, as in
  // selectionOutline.js)
  let placing = false;
  function place() {
    if (placing) return;
    placing = true;
    try {
      const idx = (l) => map.layers.indexOf(l);
      const below = (layer, ref) => { // put `layer` directly under `ref`
        const at = idx(layer), r = idx(ref);
        if (at < 0 || r < 0 || at === r - 1) return false;
        map.reorder(layer, at < r ? r - 1 : r);
        return true;
      };
      const outline = map.layers.find((l) => l.id === "selection-outline");
      for (let k = 0; k < 4; k++) {
        let moved = false;
        if (outline) moved = below(hover, outline);
        else if (idx(hover) !== map.layers.length - 1) { map.reorder(hover, map.layers.length - 1); moved = true; }
        moved = below(selection, hover) || moved;
        if (!moved) break;
      }
    } finally { placing = false; }
  }
  map.layers.on("change", () => place());
  place();

  const S = TABLE.SELECTION_SYMBOL;
  const selectionOutline = { ...HIGHLIGHT.OUTLINE, WIDTH: S.WIDTH, CASING_WIDTH: S.CASING_WIDTH, CASING_ALPHA: S.CASING_ALPHA, RING_SIZE: S.RING_SIZE };
  const symbols = (type) => outlineSymbols(type, { color: highlightColor.get(), outline: selectionOutline });

  // ---- geometry: per tab cache { oid -> { geometry, offset } }
  const caches = new WeakMap();
  const cacheOf = (tab) => { if (!caches.has(tab)) caches.set(tab, new Map()); return caches.get(tab); };
  const wantOffset = () => (view.scale <= TABLE.SELECTION_FULL_PRECISION_SCALE ? 0 : view.resolution);
  async function fetchGeometry(layer, ids, offset, { signal, extent = null, onRequest } = {}) {
    const batch = Math.max(1, Math.min(TABLE.SELECTION_BATCH, layer.capabilities?.query?.maxRecordCount ?? TABLE.SELECTION_BATCH));
    const out = new Map();
    for (let i = 0; i < ids.length; i += batch) {
      onRequest?.("geometry");
      const q = { objectIds: ids.slice(i, i + batch), outFields: [layer.objectIdField], returnGeometry: true, outSpatialReference: view.spatialReference };
      if (offset > 0) q.maxAllowableOffset = offset;
      if (extent) { q.geometry = extent; q.spatialRelationship = "intersects"; }
      const { features } = await layer.queryFeatures(q, { signal });
      for (const f of features) out.set(f.attributes[layer.objectIdField], f.geometry);
    }
    return out;
  }

  // ---- drawing the active tab's selection
  let shown = null; // { tab, ids: [drawn oids in order] }
  let drawn = new Map(); // oid -> [casing graphic, line graphic]
  let controller = null;
  let enabled = true; // false while the pane is hidden or the tab's layer is off
  let lastStats = { requested: 0, drawn: 0, ms: 0, capped: false };

  function clear() {
    casings.removeAll();
    lines.removeAll();
    drawn = new Map();
  }
  function graphicsFor(geometry) {
    const [c, l] = symbols(geometry.type);
    return [new Graphic({ geometry, symbol: c }), new Graphic({ geometry, symbol: l })];
  }
  // Draw what is cached for the wanted ids: graphics are added and removed by difference, never rebuilt wholesale.
  function sync(ids) {
    const cache = cacheOf(shown.tab);
    const want = new Set(ids);
    const removeC = [], removeL = [];
    for (const [oid, [c, l]] of drawn) {
      const entry = cache.get(oid);
      if (!want.has(oid) || !entry || c.geometry !== entry.geometry) { removeC.push(c); removeL.push(l); drawn.delete(oid); }
    }
    casings.removeMany(removeC);
    lines.removeMany(removeL);
    const addC = [], addL = [];
    for (const oid of ids) {
      if (drawn.has(oid)) continue;
      const entry = cache.get(oid);
      if (!entry?.geometry) continue;
      const pair = graphicsFor(entry.geometry);
      drawn.set(oid, pair);
      addC.push(pair[0]); addL.push(pair[1]);
    }
    casings.addMany(addC);
    lines.addMany(addL);
  }

  // Show `tab`'s selection: ids in table order (attributeTable's panelList), capped at MAX_DRAWN. Resolves when drawn.
  async function show(tab, orderedIds, { onRequest } = {}) {
    controller?.abort();
    if (!tab || !enabled || !orderedIds.length) {
      if (shown?.tab !== tab) clear();
      shown = tab ? { tab, ids: [] } : null;
      if (!orderedIds?.length || !enabled) clear();
      lastStats = { requested: orderedIds?.length ?? 0, drawn: 0, ms: 0, capped: false };
      return lastStats;
    }
    if (shown?.tab !== tab) clear();
    const ids = orderedIds.slice(0, TABLE.MAX_DRAWN);
    shown = { tab, ids, onRequest };
    const ctl = (controller = new AbortController());
    const t0 = performance.now();
    const cache = cacheOf(tab);
    const offset = wantOffset();
    const missing = ids.filter((oid) => !cache.has(oid));
    sync(ids); // what is cached already shows at once
    try {
      if (missing.length) {
        const got = await fetchGeometry(tab.layer, missing, offset, { signal: ctl.signal, onRequest });
        for (const [oid, geometry] of got) cache.set(oid, { geometry, offset });
        if (ctl.signal.aborted) return lastStats;
        sync(ids);
      }
      await refine(ctl.signal);
    } catch (err) {
      if (err?.name !== "AbortError") console.warn("Attribute table: couldn't draw the selection on the map:", err);
    }
    lastStats = { requested: orderedIds.length, drawn: drawn.size, ms: Math.round(performance.now() - t0), capped: orderedIds.length > ids.length };
    return lastStats;
  }
  // Zoomed in past what the cached geometry was generalized for: the selected features in view, read again finer.
  async function refine(signal) {
    if (!shown?.ids.length) return;
    const offset = wantOffset();
    const cache = cacheOf(shown.tab);
    const coarse = shown.ids.filter((oid) => { const e = cache.get(oid); return e && e.offset > Math.max(offset * 1.5, 0); });
    if (!coarse.length) return;
    const got = await fetchGeometry(shown.tab.layer, coarse, offset, { signal, extent: view.extent, onRequest: shown.onRequest });
    if (signal?.aborted) return;
    for (const [oid, geometry] of got) cache.set(oid, { geometry, offset });
    sync(shown.ids);
  }
  reactiveUtils.when(() => view.stationary, () => {
    if (!shown?.ids.length || !enabled) return;
    controller?.abort();
    const ctl = (controller = new AbortController());
    refine(ctl.signal).catch((err) => { if (err?.name !== "AbortError") console.warn("Attribute table: couldn't refine the selection's geometry:", err); });
  });

  // a new highlight color: the same graphics, new symbols
  highlightColor.onChange(() => {
    for (const [, [c, l]] of drawn) {
      const [sc, sl] = symbols(c.geometry.type);
      c.symbol = sc;
      l.symbol = sl;
    }
    if (hoverGraphics.length) setHover(hoverOid.tab, hoverOid.oid, true);
  });

  // ---- hover: one feature, its geometry cached per tab (TABLE.HOVER.CACHE ids, least recently used dropped)
  const hoverCaches = new WeakMap();
  let hoverGraphics = [];
  let hoverOid = { tab: null, oid: null };
  let hoverCtl = null;
  async function setHover(tab, oid, force = false) {
    if (!force && hoverOid.tab === tab && hoverOid.oid === oid) return;
    hoverOid = { tab, oid };
    hoverCtl?.abort();
    if (oid === null || oid === undefined || !tab || !enabled) { hover.removeAll(); hoverGraphics = []; return; }
    if (!hoverCaches.has(tab)) hoverCaches.set(tab, new Map());
    const cache = hoverCaches.get(tab);
    let geometry = cache.get(oid) ?? cacheOf(tab).get(oid)?.geometry ?? null;
    if (!geometry) {
      const ctl = (hoverCtl = new AbortController());
      try {
        geometry = (await fetchGeometry(tab.layer, [oid], view.resolution, { signal: ctl.signal, onRequest: shown?.onRequest })).get(oid) ?? null;
      } catch (err) {
        if (err?.name !== "AbortError") console.warn("Attribute table: couldn't read the hovered row's geometry:", err);
        return;
      }
      if (ctl.signal.aborted || hoverOid.oid !== oid) return;
      if (geometry) {
        cache.set(oid, geometry);
        if (cache.size > TABLE.HOVER.CACHE) cache.delete(cache.keys().next().value);
      }
    } else { cache.delete(oid); cache.set(oid, geometry); }
    if (!geometry) return;
    const fresh = outlineSymbols(geometry.type, { color: highlightColor.get(), outline: HIGHLIGHT.OUTLINE }).map((symbol) => new Graphic({ geometry, symbol }));
    const old = hover.graphics.toArray();
    hover.addMany(fresh);
    hover.removeMany(old);
    hoverGraphics = fresh;
  }

  // A feature's geometry for zooming (from the caches, else the layer).
  async function geometryOf(tab, oid) {
    const cached = cacheOf(tab).get(oid)?.geometry ?? hoverCaches.get(tab)?.get(oid);
    if (cached) return cached;
    return (await fetchGeometry(tab.layer, [oid], 0)).get(oid) ?? null;
  }

  return {
    show,
    setHover,
    geometryOf,
    // drawing off (the pane is hidden, or the tab's layer is switched off) and back on (the caller calls show again)
    setEnabled(on) {
      enabled = on;
      if (!on) { controller?.abort(); clear(); hover.removeAll(); hoverGraphics = []; hoverOid = { tab: null, oid: null }; }
    },
    forget(tab) { caches.delete(tab); hoverCaches.delete(tab); if (shown?.tab === tab) { shown = null; clear(); } if (hoverOid.tab === tab) setHover(null, null); },
    layers: { selection, casings, lines, hover },
    get stats() { return { ...lastStats, graphics: casings.graphics.length + lines.graphics.length }; },
  };
}
