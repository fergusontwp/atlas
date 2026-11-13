import { HIGHLIGHT, MEASURE, PARCEL_PANEL, SEARCH } from "./config.js";
import { copyAllText, copyLine, createMeasureList, featureMeasureName, measureColor, measureKindOf, measureSymbols, sanitizeUnit, valueText } from "./measureList.js";
import { anchorPoint } from "./notesLogic.js";
import { anyContent, isDefaultLabels, labelContent, labelCorners, placeAlong, placeOnEdge, polygonsOverlap, sanitizeLabelSettings, textBox, toScreen } from "./measureLabels.js";
import { nearestOnParts } from "./pathAngle.js";
import { highlightColor } from "./highlightColor.js";
import { printColorControl } from "./printColorControl.js";
import { h } from "./dom.js";
import { toast } from "./toast.js";
import { setStatus } from "./ui.js";

const T = MEASURE.TEXT;

// Per-browser settings (MEASURE.STORAGE): every read and write in try/catch; without storage they last for the visit.
// A value equal to the default is removed rather than stored.
function readSetting(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function writeSetting(key, value, isDefault) {
  try {
    if (isDefault) localStorage.removeItem(key);
    else localStorage.setItem(key, String(value));
  } catch { /* not saved: it still applies for this visit */ }
}

// Measure section: length or area with the SDK's own measurement components (on-map drawing, live readout,
// unit dropdown). One tool at a time. Parcel selection is switched off while a measurement is in progress.
// The units are the user's, saved per browser: read at startup and applied to the components, saved when the user
// changes a component's own unit dropdown (it sets analysis.unit, watched here; arcgisPropertyChange doesn't name it).
// The scratch list (section 54): when a tool reports `measured`, its geometry becomes a numbered item, drawn with a label
// in the list-hidden "measure-scratch" layer, and the component is cleared. Values are computed the way the components do (geodesic in Web Mercator and geographic
// maps, planar in other projections) and kept in meters and square meters; the list is never stored.
// opts: parcel (the parcel layer, snapped to); outline() the selection outline (its selectedGeometry() for Add selected
// feature, set up after Measure); roadLayer() the road layer Road search found, when SEARCH.ROAD.LAYER_TITLE isn't set;
// obstacles() a graphics layer whose text labels "On the edge" avoids (the edge lengths, labels.edges.layer).
export async function setupMeasure(mapEl, panel, { parcel = null, outline = () => null, roadLayer = () => null, obstacles = () => null } = {}) {
  const block = document.getElementById("measure-block");
  const toolPicker = document.getElementById("measure-tool");
  const host = document.getElementById("measure-host");
  const newButton = document.getElementById("measure-new");
  const [reactiveUtils, GraphicsLayer, Graphic, Point, geodeticLength, geodeticArea, lengthOperator, areaOperator, labelPointOperator] = await $arcgis.import([
    "@arcgis/core/core/reactiveUtils.js", "@arcgis/core/layers/GraphicsLayer.js", "@arcgis/core/Graphic.js", "@arcgis/core/geometry/Point.js",
    "@arcgis/core/geometry/operators/geodeticLengthOperator.js", "@arcgis/core/geometry/operators/geodeticAreaOperator.js",
    "@arcgis/core/geometry/operators/lengthOperator.js", "@arcgis/core/geometry/operators/areaOperator.js",
    "@arcgis/core/geometry/operators/labelPointOperator.js",
  ]);
  const [projectOperator, Polygon] = await $arcgis.import(["@arcgis/core/geometry/operators/projectOperator.js", "@arcgis/core/geometry/Polygon.js"]);
  await Promise.all([geodeticLength, geodeticArea].map((op) => (op.isLoaded() ? null : op.load())));
  const map = mapEl.map;

  // A saved unit that is no longer offered (the international "feet", or anything unknown) falls back to the default
  // and the stale value is removed from storage.
  function savedUnit(kind, key) {
    const raw = readSetting(key);
    const unit = sanitizeUnit(raw, kind);
    if (raw !== null && raw !== unit) writeSetting(key, unit, true);
    return unit;
  }
  const units = {
    length: savedUnit("length", MEASURE.STORAGE.LENGTH_UNIT),
    area: savedUnit("area", MEASURE.STORAGE.AREA_UNIT),
  };
  const unitListeners = new Set();
  function unitChanged(kind, value) {
    if (!value || value === units[kind]) return;
    units[kind] = sanitizeUnit(value, kind);
    const key = kind === "length" ? MEASURE.STORAGE.LENGTH_UNIT : MEASURE.STORAGE.AREA_UNIT;
    writeSetting(key, units[kind], units[kind] === (kind === "length" ? MEASURE.LENGTH_UNIT : MEASURE.AREA_UNIT));
    unitListeners.forEach((cb) => cb(kind, units[kind]));
  }

  function make(kind, tag, unitOptions) {
    const el = document.createElement(tag);
    el.referenceElement = mapEl;
    el.unitOptions = unitOptions;
    el.unit = units[kind];
    el.autoDestroyDisabled = true; // keep the component if its block is moved or reconnected
    el.hideStartButton = true; // Atlas's own New measurement (disabled at the list's limit)
    let unitWatch = null;
    const watchUnit = () => {
      unitWatch?.remove();
      const analysis = el.analysis;
      unitWatch = analysis ? reactiveUtils.watch(() => analysis.unit, (value) => unitChanged(kind, value)) : null;
    };
    el.addEventListener("arcgisPropertyChange", (e) => {
      if (e.detail.name === "state") stateChanged(kind);
      if (e.detail.name === "analysis") watchUnit();
    });
    host.append(el);
    el.componentOnReady?.().then(watchUnit).catch(() => {});
    return el;
  }
  const tools = {
    length: make("length", "arcgis-distance-measurement-2d", MEASURE.LENGTH_UNITS),
    area: make("area", "arcgis-area-measurement-2d", MEASURE.AREA_UNITS),
  };
  let active = "length";

  // ---- the scratch list and its layer: kept on top, under only the What's here? marker (which keeps itself on top)
  // Each item has its own color (section 55), from its number: 1 is the highlight color when the session's first
  // measurement was made (kept for the session), the next go through HIGHLIGHT.PRESETS. Not stored.
  let startColor = null;
  const list = createMeasureList({ colorOf: (n) => measureColor(n, (startColor ??= highlightColor.get()), HIGHLIGHT.PRESETS) });
  const listListeners = new Set();
  const layer = new GraphicsLayer({ id: "measure-scratch", title: MEASURE.TEXT.LAYER_TITLE, listMode: "hide", popupEnabled: false, legendEnabled: false });
  map.add(layer);
  const place = () => {
    const at = map.layers.indexOf(layer);
    if (at < 0) return;
    const marker = map.layers.findIndex((l) => l.id === "point-info-marker");
    const want = marker < 0 ? map.layers.length - 1 : at < marker ? marker - 1 : marker;
    if (at !== want) map.reorder(layer, want);
  };
  map.layers.on("change", place);
  place();

  const geodesic = (sr) => !sr || sr.isWebMercator || sr.isGeographic;
  function valuesOf(kind, geometry) {
    const length = geodesic(geometry.spatialReference) ? geodeticLength.execute(geometry) : lengthOperator.execute(geometry, { unit: "meters" });
    if (kind === "length") return { length };
    const area = geodesic(geometry.spatialReference) ? geodeticArea.execute(geometry) : areaOperator.execute(geometry, { unit: "square-meters" });
    return { area: Math.abs(area), perimeter: length };
  }
  // where an item's label sits: halfway along a line; a point inside an area (Notes' anchor helper)
  function anchorOf(item) {
    const xy = anchorPoint(item.kind === "area" ? "polygon" : "line", item.geometry.toJSON(), {
      labelPoint: () => { const p = labelPointOperator.execute(item.geometry); return p ? [p.x, p.y] : null; },
    });
    return xy && new Point({ x: xy[0], y: xy[1], spatialReference: item.geometry.spatialReference });
  }
  let emphasized = null; // the id of the item whose row is hovered or focused

  // ---- the labels' settings (section 57): one set for every label, saved per browser (MEASURE.LABELS.STORAGE_KEY,
  // through sanitizeLabelSettings: defaults filled, bad or unknown values dropped). Only the settings are stored.
  const LB = MEASURE.LABELS;
  let labelSettings = (() => {
    const raw = readSetting(LB.STORAGE_KEY);
    const clean = sanitizeLabelSettings(raw);
    if (raw !== null && (isDefaultLabels(clean) || raw !== JSON.stringify(clean))) writeSetting(LB.STORAGE_KEY, JSON.stringify(clean), isDefaultLabels(clean));
    return clean;
  })();
  const labelListeners = new Set();
  function setLabels(next) {
    labelSettings = sanitizeLabelSettings(next);
    writeSetting(LB.STORAGE_KEY, JSON.stringify(labelSettings), isDefaultLabels(labelSettings));
    render();
    labelListeners.forEach((cb) => cb(labelSettings));
  }
  // Labels that sit along a line or on an edge depend on the view's scale and rotation: drawn again once it stops.
  const usesView = () => labelSettings.show && (labelSettings.line !== "center" || labelSettings.area !== "center") && list.count > 0;
  const viewRef = () => ({ rotationDeg: mapEl.view?.rotation || 0, resolution: mapEl.view?.resolution || 1 });

  // A label's text symbol, from the settings (size, bold, halo) and MEASURE.STYLE.LABEL (family, colors).
  function textSymbol(text, extra = {}) {
    const S = MEASURE.STYLE.LABEL;
    return { type: "text", text, color: S.COLOR, haloColor: labelSettings.halo ? S.HALO_COLOR : null, haloSize: labelSettings.halo ? S.HALO_SIZE : 0,
      font: { family: S.FAMILY, size: labelSettings.size, weight: labelSettings.bold ? "bold" : "normal" }, ...extra };
  }
  // the screen segments of every item's shape (pixels): "fewest-overlaps" counts the ones a label would cover
  function screenSegments(items, { rotationDeg, resolution }) {
    const out = [];
    for (const item of items) {
      const parts = item.kind === "area" ? item.geometry.rings : item.geometry.paths;
      for (const pts of parts ?? []) {
        for (let i = 0; i + 1 < pts.length; i++) {
          const a = toScreen({ x: pts[i][0], y: pts[i][1] }, rotationDeg, resolution), b = toScreen({ x: pts[i + 1][0], y: pts[i + 1][1] }, rotationDeg, resolution);
          out.push({ id: item.id, seg: [[a.x, a.y], [b.x, b.y]] });
        }
      }
    }
    return out;
  }

  // Every item's shapes first (oldest at the bottom), then every label, so no shape covers a label. The new graphics
  // go in before the old come out, so there is no frame without them.
  // A label: Center (today's: halfway along a line, OFFSET_Y above it, horizontal; an area's anchor point), Along the
  // line or On the edge (measureLabels.js: angled, upright, on the chosen side; an edge that doesn't fit the text falls
  // back to Center). A label dragged along its line or ring (item.labelAt, a measure; section 57) keeps that position.
  const placed = new Map(); // id -> { x, y, angleDeg, box, mode, parts, closed } of the labels as last drawn (dragging)
  function render() {
    const L = MEASURE.STYLE.LABEL;
    const shapes = [], labels = [];
    const view = viewRef();
    const items = list.items;
    const segments = labelSettings.area === "edge" && LB.EDGE_PICK === "fewest-overlaps" ? screenSegments(items, view) : [];
    const boxes = []; // labels placed so far, as screen corners
    // the edge lengths' labels, when shown, are in the way too ("fewest-overlaps")
    const avoid = labelSettings.area === "edge" && LB.EDGE_PICK === "fewest-overlaps" && obstacles()?.visible !== false
      ? (obstacles()?.graphics?.toArray() ?? []).filter((g) => g.symbol?.type === "text").map((g) =>
        labelCorners(g.geometry.x, g.geometry.y, g.symbol.angle ?? 0, textBox(g.symbol.text, { size: g.symbol.font?.size ?? 9, bold: g.symbol.font?.weight === "bold" }), view.rotationDeg, view.resolution))
      : [];
    placed.clear();
    for (const item of items) {
      for (const symbol of measureSymbols(item.kind, { color: item.color, emphasized: item.id === emphasized })) {
        shapes.push(new Graphic({ geometry: item.geometry, symbol, attributes: { measureId: item.id } }));
      }
      const text = labelContent(item, units, labelSettings);
      if (!text) continue;
      const box = textBox(text, labelSettings);
      const area = item.kind === "area";
      const mode = area ? labelSettings.area : labelSettings.line;
      let p = null;
      const parts = area ? item.geometry.rings : item.geometry.paths;
      if (mode === "along") p = placeAlong(parts, labelSettings, { ...view, box, measure: item.labelAt ?? null });
      else if (mode === "edge") {
        p = placeOnEdge(parts, labelSettings, { ...view, box, pick: LB.EDGE_PICK, measure: item.labelAt ?? null,
          others: { boxes: [...boxes, ...avoid], segments: segments.filter((x) => x.id !== item.id).map((x) => x.seg) } });
      }
      if (p) {
        const at = new Point({ x: p.x, y: p.y, spatialReference: item.geometry.spatialReference });
        labels.push(new Graphic({ geometry: at, attributes: { measureId: item.id, measureLabel: true },
          symbol: textSymbol(text, { angle: p.angleDeg, verticalAlignment: "middle", horizontalAlignment: "center" }) }));
        boxes.push(labelCorners(p.x, p.y, p.angleDeg, box, view.rotationDeg, view.resolution));
        placed.set(item.id, { x: p.x, y: p.y, angleDeg: p.angleDeg, box, mode, parts, closed: area });
        continue;
      }
      const at = anchorOf(item);
      if (!at) continue;
      const yoffset = area ? 0 : L.OFFSET_Y;
      // the optional dot in the item's color before the number (MEASURE.STYLE.LABEL.DOT, off by default): the label is
      // then left-aligned just after the dot, which sits on the anchor
      const dot = L.DOT?.SHOW;
      if (dot) labels.push(new Graphic({ geometry: at, attributes: { measureId: item.id }, symbol: {
        type: "simple-marker", style: "circle", size: L.DOT.SIZE, color: item.color, yoffset,
        outline: { color: L.DOT.OUTLINE_COLOR, width: L.DOT.OUTLINE_WIDTH } } }));
      labels.push(new Graphic({ geometry: at, attributes: { measureId: item.id, measureLabel: true }, symbol: textSymbol(text, {
        yoffset, ...(dot ? { horizontalAlignment: "left", xoffset: L.DOT.SIZE / 2 + L.DOT.GAP } : {}) }) }));
      // as a box for the overlap count: a little above the anchor (baseline alignment, yoffset in points)
      boxes.push(labelCorners(at.x, at.y, 0, box, view.rotationDeg, view.resolution).map(([x, y]) => [x, y - (yoffset * 4) / 3 - box.h / 3]));
    }
    const old = layer.graphics.toArray();
    layer.addMany([...shapes, ...labels]);
    layer.removeMany(old);
  }
  // ---- dragging a label along its line or ring (section 57). Only Along the line and On the edge labels, only while the
  // block is open and no tool is drawing, and only with the left button. The press must start on a label as drawn: the
  // view's drag event has to be stopped synchronously (so the map doesn't pan), and view.hitTest answers later, so the
  // label is found by a screen-space test of the boxes placed in render() (hitTest does return these text graphics in
  // 5.1, section 57, but too late to stop the pan). The label follows the pointer's nearest point on the item's paths, or
  // on the polygon's whole rings (so it can go round a corner onto the next edge); the position is kept on the item for
  // the session as a measure along them, so it survives zoom and rotation. A press that moves less than
  // DRAG_THRESHOLD_PX moves nothing; the view doesn't report a click after a drag, so a drag never selects.
  let dragging = null; // { id, origin }
  const canDrag = () => block.expanded && !Object.values(tools).some((t) => t.state === "measuring") && labelSettings.show;
  function labelAt(sx, sy) {
    const view = mapEl.view;
    const m = view.toMap({ x: sx, y: sy });
    if (!m) return null;
    const v = viewRef();
    const p = toScreen({ x: m.x, y: m.y }, v.rotationDeg, v.resolution), pad = 3;
    const probe = [[p.x - pad, p.y - pad], [p.x + pad, p.y - pad], [p.x + pad, p.y + pad], [p.x - pad, p.y + pad]];
    for (const [id, at] of [...placed.entries()].reverse()) { // the label drawn last is on top
      if (polygonsOverlap(probe, labelCorners(at.x, at.y, at.angleDeg, at.box, v.rotationDeg, v.resolution))) return id;
    }
    return null;
  }
  function dragTo(sx, sy) {
    const item = list.get(dragging.id), at = placed.get(dragging.id);
    const m = mapEl.view.toMap({ x: sx, y: sy });
    if (!item || !at || !m) return;
    const near = nearestOnParts(at.closed ? at.parts.map((r) => (r.length > 1 && r[0][0] === r.at(-1)[0] && r[0][1] === r.at(-1)[1] ? r.slice(0, -1) : r)) : at.parts, [m.x, m.y], { closed: at.closed });
    if (!near) return;
    item.labelAt = near.measure;
    if (!dragging.frame) dragging.frame = requestAnimationFrame(() => { if (dragging) dragging.frame = 0; render(); });
  }
  // where the button went down: the drag's own origin is where the pointer was once the drag was recognised, a few
  // pixels on, which can be off a small label
  let pressedAt = null;
  mapEl.view.on("pointer-down", (e) => { pressedAt = { x: e.x, y: e.y }; });
  mapEl.view.on("drag", (e) => {
    if (e.action === "start") {
      if (e.button !== 0 || !canDrag()) return;
      const at = pressedAt ?? e.origin;
      const id = labelAt(at.x, at.y);
      if (!id) return;
      dragging = { id, origin: { x: at.x, y: at.y }, moved: false, frame: 0 };
    }
    if (!dragging) return;
    e.stopPropagation(); // no pan while a label is dragged
    if (e.action === "update" || e.action === "end") {
      if (!dragging.moved && Math.hypot(e.x - dragging.origin.x, e.y - dragging.origin.y) >= LB.DRAG_THRESHOLD_PX) dragging.moved = true;
      if (dragging.moved) dragTo(e.x, e.y);
    }
    if (e.action === "end") {
      const moved = dragging.moved;
      dragging = null;
      if (moved) { render(); listListeners.forEach((cb) => cb()); } // the row gets "Reset label position"
    }
  });
  // a grab cursor over a label that can be dragged
  mapEl.view.on("pointer-move", (e) => {
    if (dragging) return;
    const over = canDrag() && placed.size > 0 && !!labelAt(e.x, e.y);
    mapEl.style.cursor = over ? "grab" : "";
  });
  function resetLabelPosition(item) {
    if (!item || item.labelAt === undefined) return;
    delete item.labelAt;
    changed();
  }

  // drawn again when the edge lengths change (they are in the way of "On the edge"), at most once a frame
  let obstacleFrame = 0, obstacleWatch = null;
  const watchObstacles = () => {
    const l = obstacles();
    if (!l?.graphics || obstacleWatch) return;
    obstacleWatch = l.graphics.on("change", () => {
      if (obstacleFrame || !usesView() || labelSettings.area !== "edge") return;
      obstacleFrame = requestAnimationFrame(() => { obstacleFrame = 0; render(); });
    });
  };
  watchObstacles();
  // drawn again when the view stops after a zoom or a rotation, while some label depends on it
  reactiveUtils.watch(() => [mapEl.view?.stationary, mapEl.view?.scale, mapEl.view?.rotation], ([stationary]) => { if (stationary && usesView()) render(); });
  function changed() {
    render();
    listListeners.forEach((cb) => cb());
  }
  unitListeners.add(render); // one unit per kind for the whole list: every label follows

  // When a tool reports `measured`: its geometry becomes an item, then the component is cleared (back to `ready`),
  // so it shows nothing of its own; the item draws it now. (hideVisualization was tried: the SDK's vertex handles, in
  // its internal sketch layer, stayed on the map.) The next shape needs New measurement again, so clicks select.
  let capturing = false;
  async function stateChanged(kind) {
    updateSuspension();
    const el = tools[kind];
    if (el.state !== "measured" || capturing) return;
    const geometry = el.analysis?.geometry?.clone();
    capturing = true;
    try {
      await new Promise((resolve) => setTimeout(resolve, 0)); // let the placement finish first (clearing inside the
      // state change logged SketchViewModel errors)
      await el.clear();
    } finally {
      capturing = false;
      updateSuspension();
    }
    if (!geometry) return;
    if (list.add({ kind, geometry, values: valuesOf(kind, geometry), source: "drawn" })) changed();
  }

  function showActive() {
    for (const [name, el] of Object.entries(tools)) el.hidden = name !== active;
  }
  function updateSuspension() {
    const measuring = Object.values(tools).some((t) => t.state === "measuring");
    panel.setSuspended(measuring, "measure");
    host.hidden = !measuring; // the component's readout and unit dropdown only while a shape is drawn
    syncEsc(measuring);
    syncNew();
  }
  // New measurement is faded while a shape is drawn (and at the list's limit); it comes back when the shape is
  // finished, cancelled (Esc), cleared, or the block closes.
  function syncNew() {
    newButton.disabled = list.full || Object.values(tools).some((t) => t.state === "measuring");
  }
  // Cancels a shape in progress (both tools); the finished items stay.
  async function clearAll() {
    await Promise.all(Object.values(tools).map((t) => t.clear()));
    updateSuspension();
  }
  // Esc while drawing cancels only the shape in progress. The listener exists only while drawing, on the window in the
  // capture phase, and stops the key there: the SDK would otherwise finish the shape, and the app's Esc would clear
  // the selection. The list stays.
  let escOn = false;
  function onEsc(e) {
    if (e.key !== "Escape") return;
    e.stopPropagation();
    e.preventDefault();
    clearAll();
  }
  function syncEsc(measuring) {
    if (measuring === escOn) return;
    escOn = measuring;
    if (measuring) window.addEventListener("keydown", onEsc, true);
    else window.removeEventListener("keydown", onEsc, true);
  }

  // Hide reasons for the scratch layer: "print" (unless the Print option includes measurements), "georef" (the
  // georeferencing workspace and the plan mosaic inside it). Shown again when none is left.
  const hiddenBy = new Set();
  function setHidden(on, reason) {
    if (on) hiddenBy.add(reason); else hiddenBy.delete(reason);
    layer.visible = hiddenBy.size === 0;
  }
  let printInclude = false; // Print's "Include measurements" (off each time the Print editor opens)

  // ---- the block: Length / Area, New measurement, Clear, the limit line, the hint
  const clearButton = document.getElementById("measure-clear");
  const limitNote = document.getElementById("measure-limit");
  toolPicker.querySelector('[value="length"]').textContent = T.LENGTH;
  toolPicker.querySelector('[value="area"]').textContent = T.AREA;
  newButton.textContent = T.NEW;
  clearButton.textContent = T.CLEAR;
  document.getElementById("measure-hint").textContent = T.HINT;

  // Snap (saved per browser, MEASURE.STORAGE.SNAP): the shape's own vertices, and the edges and vertices of the parcel
  // layer and of MEASURE.SNAP.LAYER_TITLES, the ones visible when a shape is started (a hidden layer isn't snapped to).
  const savedSnap = readSetting(MEASURE.STORAGE.SNAP);
  let snap = savedSnap === "true" ? true : savedSnap === "false" ? false : MEASURE.SNAP.DEFAULT;
  const shown = (layer) => { for (let l = layer; l && l !== map; l = l.parent) if (!l.visible) return false; return true; };
  function snapLayers() {
    const extra = map.allLayers.filter((l) => MEASURE.SNAP.LAYER_TITLES.includes(l.title)).toArray();
    return [...new Set([parcel, ...extra])].filter((l) => l && ["feature", "graphics", "geojson", "csv", "wfs"].includes(l.type) && shown(l));
  }
  function applySnapping() {
    const options = { enabled: snap, selfEnabled: true, featureEnabled: true, distance: MEASURE.SNAP.DISTANCE,
      featureSources: snapLayers().map((layer) => ({ layer, enabled: true })) };
    for (const el of Object.values(tools)) el.snappingOptions = options;
  }
  const snapSwitch = h("calcite-switch", { id: "measure-snap", checked: snap, scale: "s",
    oncalciteSwitchChange: () => {
      snap = snapSwitch.checked;
      writeSetting(MEASURE.STORAGE.SNAP, snap, snap === MEASURE.SNAP.DEFAULT);
      applySnapping();
    } });
  document.querySelector("#measure-block .measure-actions").after(
    h("calcite-label", { layout: "inline", scale: "s", class: "measure-snap" }, snapSwitch, T.SNAP));
  applySnapping();

  // New measurement starts the chosen tool and keeps the list (at the limit it is disabled, with the reason below)
  async function startTool() {
    if (list.full) return;
    applySnapping(); // the snap layers visible now
    for (const [name, el] of Object.entries(tools)) if (name !== active && el.state === "measuring") await el.clear();
    await tools[active].start();
    updateSuspension();
  }
  toolPicker.addEventListener("calciteSegmentedControlChange", async (e) => {
    active = e.target.value;
    for (const [name, el] of Object.entries(tools)) if (name !== active) await el.clear();
    showActive();
    await startTool();
  });
  newButton.addEventListener("click", startTool);

  // Add selected feature: the selected polygon or line at full precision (as the selection outline reads it), in the
  // view's spatial reference, as an item named like the panel names it (never a person's name). Disabled, with the
  // reason as its tooltip, for a point, nothing selected or a full list.
  const addButton = h("calcite-button", { id: "measure-add-selected", appearance: "outline", scale: "s", iconStart: "plus" }, T.ADD_SELECTED);
  const addWrap = h("span", { class: "measure-add-wrap" }, addButton);
  newButton.after(addWrap);
  const selectedKind = () => measureKindOf(panel.selectedFeature()?.graphic?.geometry?.type);
  function syncAdd() {
    const selection = panel.selectedFeature();
    const why = list.full ? T.LIMIT(list.max) : !selection ? T.ADD_SELECTED_NONE : !selectedKind() ? T.ADD_SELECTED_POINT : "";
    addButton.disabled = !!why || adding;
    addWrap.title = why;
  }
  let adding = false;
  async function addSelected() {
    const selection = panel.selectedFeature();
    const kind = selectedKind();
    if (!selection || !kind || list.full || adding) return null;
    adding = true;
    syncAdd();
    try {
      let geometry = (await outline()?.selectedGeometry?.()) ?? selection.graphic?.geometry ?? null;
      if (!geometry || panel.selectedFeature()?.graphic !== selection.graphic) return null; // gone or changed meanwhile
      const sr = mapEl.view.spatialReference;
      if (geometry.spatialReference && !geometry.spatialReference.equals(sr)) {
        if (!projectOperator.isLoaded()) await projectOperator.load();
        geometry = projectOperator.execute(geometry, sr);
      }
      if (geometry.type === "extent") geometry = Polygon.fromExtent(geometry);
      const layer = selection.layer;
      const road = roadLayer();
      const name = featureMeasureName({
        isParcel: selection.isParcel, isRoad: !!layer && (layer === road || (!!SEARCH.ROAD.LAYER_TITLE && layer.title === SEARCH.ROAD.LAYER_TITLE)),
        attributes: selection.graphic?.attributes ?? {}, layerTitle: layer?.title ?? "",
      }, { titleFields: PARCEL_PANEL.TITLE_FIELDS, roadFields: SEARCH.ROAD.NAME_FIELDS });
      const item = list.add({ kind, geometry: geometry.clone(), values: valuesOf(kind, geometry), source: "feature", name });
      if (item) changed();
      return item;
    } catch (err) {
      console.warn("Measure: couldn't add the selected feature:", err?.message ?? err);
      return null;
    } finally {
      adding = false;
      syncAdd();
    }
  }
  addButton.addEventListener("click", addSelected);
  panel.onSelectionChange(syncAdd);
  listListeners.add(syncAdd);
  syncAdd();
  // Clear: every item and a shape in progress; one confirm only for a long list
  clearButton.addEventListener("click", async () => {
    if (list.count >= MEASURE.CONFIRM_CLEAR_AT && !window.confirm(T.CLEAR_CONFIRM(list.count))) return;
    await clearAll();
    if (list.clear()) { emphasized = null; changed(); }
  });
  // collapsing the block cancels a shape in progress; the finished ones stay on the map and in the header count
  block.addEventListener("calciteBlockCollapse", clearAll);

  // ---- the list (newest first): units for the whole list, Copy all, and one row per item
  const wrap = document.getElementById("measure-list-wrap");
  const unitSelect = (kind) => {
    const select = h("calcite-select", { scale: "s", label: kind === "length" ? T.LENGTH_UNIT : T.AREA_UNIT,
      oncalciteSelectChange: () => setUnit(kind, select.value) },
    ...(kind === "length" ? MEASURE.LENGTH_UNITS : MEASURE.AREA_UNITS).map((u) =>
      h("calcite-option", { value: u, label: MEASURE.UNITS[u]?.NAME ?? u, selected: u === units[kind] }, MEASURE.UNITS[u]?.NAME ?? u)));
    return select;
  };
  const selects = { length: unitSelect("length"), area: unitSelect("area") };
  // a unit chosen here goes to the component too, so the readout and the list agree (its watch then saves it)
  function setUnit(kind, value) {
    unitChanged(kind, value);
    if (tools[kind].unit !== units[kind]) tools[kind].unit = units[kind];
  }
  unitListeners.add((kind, value) => { if (selects[kind].value !== value) selects[kind].value = value; });
  const copyAllAction = h("calcite-action", { icon: "copy", text: T.COPY_ALL, label: T.COPY_ALL, textEnabled: true, scale: "s",
    onclick: () => copyText(copyAllText(list.items, units), T.COPIED_ALL(list.count)) });
  const rows = h("div", { class: "measure-list", role: "list", ariaLabel: T.LIST_LABEL });
  const labelsAction = h("calcite-action", { icon: "label", text: LB.TEXT.BUTTON, label: LB.TEXT.BUTTON, textEnabled: true, scale: "s", id: "measure-labels-button",
    onclick: () => { labelsPopover.open = !labelsPopover.open; } });
  wrap.append(
    h("div", { class: "measure-units" },
      h("calcite-label", { scale: "s" }, T.LENGTH_UNIT, selects.length),
      h("calcite-label", { scale: "s" }, T.AREA_UNIT, selects.area)),
    h("div", { class: "measure-list-head" }, labelsAction, copyAllAction),
    rows);

  // ---- Label settings (section 57): a popover from the list's head, so the block stays compact. Every control is
  // keyboard-reachable; a change applies to every label at once and is saved (setLabels).
  const LT = LB.TEXT;
  const sw = (key, text) => {
    const el = h("calcite-switch", { scale: "s", checked: labelSettings[key], oncalciteSwitchChange: () => setLabels({ ...labelSettings, [key]: el.checked }) });
    return { el, row: h("calcite-label", { layout: "inline", scale: "s", class: "measure-labels-row" }, el, text), sync: (v) => { el.checked = v[key]; } };
  };
  const box = (key, text) => {
    const el = h("calcite-checkbox", { scale: "s", checked: labelSettings[key], oncalciteCheckboxChange: () => setLabels({ ...labelSettings, [key]: el.checked }) });
    return { el, row: h("calcite-label", { layout: "inline", scale: "s", class: "measure-labels-check" }, el, text), sync: (v) => { el.checked = v[key]; } };
  };
  const num = (key, text, min, max) => {
    const el = h("calcite-input-number", { scale: "s", min, max, step: 1, integer: key === "size", value: String(labelSettings[key]), label: text,
      oncalciteInputNumberChange: () => { const v = Number(el.value); if (Number.isFinite(v)) setLabels({ ...labelSettings, [key]: key === "size" ? Math.round(v) : v }); } });
    return { el, row: h("calcite-label", { scale: "s", class: "measure-labels-field" }, text, el), sync: (v) => { if (Number(el.value) !== v[key]) el.value = String(v[key]); } };
  };
  const seg = (key, text, values, names) => {
    const el = h("calcite-segmented-control", { scale: "s", width: "full", label: text, oncalciteSegmentedControlChange: () => setLabels({ ...labelSettings, [key]: el.value }) },
      ...values.map((v) => h("calcite-segmented-control-item", { value: v, checked: labelSettings[key] === v }, names[v])));
    return { el, row: h("calcite-label", { scale: "s", class: "measure-labels-field" }, text, el),
      sync: (v) => el.querySelectorAll("calcite-segmented-control-item").forEach((i) => { i.checked = i.value === v[key]; }) };
  };
  const controls = {
    show: sw("show", LT.SHOW), bold: sw("bold", LT.BOLD), halo: sw("halo", LT.HALO), size: num("size", LT.SIZE, LB.SIZE_MIN, LB.SIZE_MAX),
    number: box("number", LT.NUMBER), name: box("name", LT.NAME), value: box("value", LT.VALUE), perimeter: box("perimeter", LT.PERIMETER),
    line: seg("line", LT.LINES, LB.LINE_MODES, LT.LINE_MODE), lineSide: seg("lineSide", `${LT.LINES}: ${LT.SIDE.toLowerCase()}`, LB.LINE_SIDES, LT.LINE_SIDE),
    area: seg("area", LT.AREAS, LB.AREA_MODES, LT.AREA_MODE), areaSide: seg("areaSide", `${LT.AREAS}: ${LT.SIDE.toLowerCase()}`, LB.AREA_SIDES, LT.AREA_SIDE),
    offset: num("offset", LT.OFFSET, 0, LB.OFFSET_MAX),
  };
  const nothing = h("div", { class: "plan-note measure-labels-nothing", role: "status" }, LT.NOTHING);
  const dragHint = h("div", { class: "plan-note measure-labels-drag" }, LT.DRAG_HINT);
  const resetLabels = h("calcite-button", { scale: "s", appearance: "outline", width: "full", iconStart: "reset", class: "measure-labels-reset",
    onclick: () => { list.items.forEach((it) => { delete it.labelAt; }); setLabels({}); } }, LT.RESET);
  const labelsPopover = h("calcite-popover", { label: LT.HEADING, heading: LT.HEADING, scale: "s", autoClose: true, closable: true, triggerDisabled: true,
    overlayPositioning: "fixed", placement: "right-start", flipPlacements: ["bottom-end", "left-start"], referenceElement: labelsAction, class: "measure-labels-popover" },
  h("div", { class: "measure-labels-body" },
    controls.show.row,
    h("div", { class: "measure-labels-grid" }, controls.size.row, h("div", { class: "measure-labels-pair" }, controls.bold.row, controls.halo.row)),
    h("calcite-label", { scale: "s", class: "measure-labels-field" }, LT.CONTENT,
      h("div", { class: "measure-labels-checks" }, controls.number.row, controls.name.row, controls.value.row, controls.perimeter.row)),
    nothing,
    controls.line.row, controls.lineSide.row, controls.area.row, controls.areaSide.row, controls.offset.row,
    dragHint, resetLabels));
  labelsPopover.addEventListener("calcitePopoverOpen", () => labelsAction.active = true);
  labelsPopover.addEventListener("calcitePopoverClose", () => labelsAction.active = false);
  wrap.after(labelsPopover);
  function syncLabelControls(v = labelSettings) {
    Object.values(controls).forEach((c) => c.sync(v));
    nothing.hidden = !v.show || anyContent(v, "area");
    // the side and offset matter only off Center; the hint only where a label can be dragged
    controls.lineSide.row.hidden = v.line === "center";
    controls.areaSide.row.hidden = v.area === "center";
    controls.offset.row.hidden = v.line === "center" && v.area === "center";
    dragHint.hidden = !v.show || (v.line === "center" && v.area === "center");
  }
  labelListeners.add(syncLabelControls);
  syncLabelControls();

  async function copyText(text, done) {
    try {
      await navigator.clipboard.writeText(text);
      toast(done, "", { kind: "success", duration: "fast" });
    } catch (err) {
      console.warn("Measure: couldn't copy:", err?.name ?? err);
      setStatus("warning", T.COPY_FAILED, T.COPY_FAILED_MSG);
    }
  }
  function emphasize(id) {
    if (emphasized === id) return;
    emphasized = id;
    render();
  }
  // Zoom to: the item's extent, expanded, never closer than 1:ZOOM_MIN_SCALE (one move)
  function zoomTo(item) {
    const view = mapEl.view;
    const target = item.geometry.extent.clone().expand(MEASURE.ZOOM_EXPAND);
    const fit = view.scale * Math.max(target.width / view.extent.width, target.height / view.extent.height);
    return mapEl.goTo({ center: target.center, scale: Math.max(fit, MEASURE.ZOOM_MIN_SCALE) }).catch(() => {});
  }
  // Rename in place: Enter (or leaving the box) saves, Esc cancels; empty means no name. Text only, never HTML.
  function rename(item, row) {
    const nameEl = row.querySelector(".measure-name");
    const input = h("calcite-input-text", { scale: "s", value: item.name, maxLength: MEASURE.NAME_MAX, label: T.RENAME_LABEL, placeholder: T.UNTITLED });
    let done = false;
    const finish = (save) => {
      if (done) return;
      done = true;
      if (save) list.rename(item.id, input.value);
      changed();
      rows.querySelector(`[data-id="${item.id}"]`)?.focus();
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); finish(true); }
      else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finish(false); }
    });
    input.addEventListener("calciteInputTextChange", () => finish(true));
    input.addEventListener("focusout", () => setTimeout(() => { if (!input.contains(document.activeElement) && input !== document.activeElement) finish(true); }, 0));
    nameEl.replaceWith(input);
    requestAnimationFrame(() => input.setFocus?.());
  }
  function remove(item) {
    list.remove(item.id);
    if (emphasized === item.id) emphasized = null;
    changed();
  }
  // A row's color swatch opens one shared popover with the print color control (HIGHLIGHT.PRESETS and Custom). A change
  // re-colors that item at once; the rows aren't rebuilt for it (the popover stays anchored to the swatch).
  let colorItem = null;
  const colorControl = printColorControl("measure-color", T.COLOR_HEADING, HIGHLIGHT.DEFAULT_COLOR, (value) => {
    const item = colorItem && list.setColor(colorItem, value);
    if (!item) return;
    render();
    const swatch = rows.querySelector(`[data-id="${item.id}"] .measure-swatch`);
    if (swatch) swatch.style.background = item.color;
  }, false, HIGHLIGHT.PRESETS);
  const colorPopover = h("calcite-popover", { label: T.COLOR_HEADING, heading: T.COLOR_HEADING, scale: "s", autoClose: true, closable: true,
    triggerDisabled: true, overlayPositioning: "fixed", placement: "bottom-start", class: "measure-color-popover" },
  h("div", { class: "measure-color-body" }, colorControl.node));
  colorPopover.addEventListener("calcitePopoverClose", () => {
    const swatch = colorItem && rows.querySelector(`[data-id="${colorItem}"] .measure-swatch`);
    colorItem = null;
    swatch?.setAttribute("aria-expanded", "false");
  });
  wrap.after(colorPopover);
  function openColor(item, swatch) {
    if (colorPopover.open && colorItem === item.id) { colorPopover.open = false; return; }
    colorItem = item.id;
    colorControl.set(item.color);
    colorPopover.heading = T.COLOR_LABEL(item.n);
    colorPopover.referenceElement = swatch;
    swatch.setAttribute("aria-expanded", "true");
    colorPopover.open = true;
  }
  function rowFor(item) {
    const action = (icon, text, onclick) => h("calcite-action", { icon, text, label: text, scale: "s", onclick: (e) => { e.stopPropagation(); onclick(); } });
    const swatch = h("button", { type: "button", class: "measure-swatch", title: T.COLOR_LABEL(item.n), onclick: (e) => { e.stopPropagation(); openColor(item, swatch); } });
    swatch.setAttribute("aria-label", T.COLOR_LABEL(item.n));
    swatch.setAttribute("aria-haspopup", "dialog");
    swatch.setAttribute("aria-expanded", String(colorPopover.open && colorItem === item.id));
    swatch.style.background = item.color;
    const row = h("div", { class: "measure-row", role: "listitem", tabIndex: 0 },
      swatch,
      h("span", { class: "measure-n" }, String(item.n)),
      h("span", { class: `measure-name${item.name ? "" : " untitled"}`, title: item.name }, item.name || T.UNTITLED),
      h("div", { class: "measure-line" },
        h("span", { class: "measure-value" }, valueText(item, units)),
        h("div", { class: "measure-row-actions" },
          action("pencil", T.RENAME, () => rename(item, row)),
          action("zoom-to-object", T.ZOOM, () => zoomTo(item)),
          action("copy", T.COPY, () => copyText(copyLine(item, units), T.COPIED)),
          // a label dragged along its line or edge (section 57): back to where the settings put it
          item.labelAt !== undefined ? action("reset", LB.TEXT.RESET_POSITION, () => resetLabelPosition(item)) : null,
          action("trash", T.DELETE, () => remove(item)))));
    row.dataset.id = item.id;
    row.addEventListener("mouseenter", () => emphasize(item.id));
    row.addEventListener("mouseleave", () => { if (!row.contains(document.activeElement)) emphasize(null); });
    row.addEventListener("focusin", () => emphasize(item.id));
    row.addEventListener("focusout", (e) => { if (!row.contains(e.relatedTarget)) emphasize(null); });
    return row;
  }
  function syncList() {
    const items = list.items;
    const focusedId = document.activeElement?.closest?.(".measure-row")?.dataset.id;
    rows.replaceChildren(...items.slice().reverse().map(rowFor));
    if (focusedId) rows.querySelector(`[data-id="${focusedId}"]`)?.focus();
    // the color popover follows its item's new swatch, or closes when the item is gone
    if (colorPopover.open) {
      const swatch = colorItem && rows.querySelector(`[data-id="${colorItem}"] .measure-swatch`);
      if (swatch) { colorPopover.referenceElement = swatch; swatch.setAttribute("aria-expanded", "true"); } else colorPopover.open = false;
    }
    wrap.hidden = !items.length;
    block.heading = items.length ? T.HEADING_COUNT(items.length) : T.HEADING;
    syncNew();
    limitNote.hidden = !list.full;
    limitNote.textContent = list.full ? T.LIMIT(list.max) : "";
  }
  listListeners.add(syncList);
  unitListeners.add(syncList);
  syncList();

  showActive();
  updateSuspension();
  block.hidden = false;
  return {
    clearAll,
    get units() { return { ...units }; },
    get snap() { return snap; },
    onUnitChange: (cb) => unitListeners.add(cb),
    layer,
    addSelected,
    // the list as plain values (no geometry), for the console
    get items() { return list.items.map(({ id, n, kind, name, color, values, source }) => ({ id, n, kind, name, color, values: { ...values }, source })); },
    onListChange: (cb) => listListeners.add(cb),
    get count() { return list.count; },
    clear: async () => { await clearAll(); if (list.clear()) { emphasized = null; changed(); } },
    setHidden,
    get printInclude() { return printInclude; },
    setPrintInclude(on) { printInclude = !!on; },
    get state() { return { drawing: Object.values(tools).some((t) => t.state === "measuring"), count: list.count, units: { ...units }, snap, labels: { ...labelSettings } }; },
    // the label settings (section 57): labels.set({ line: "along" }) merges and saves, labels.reset() puts the defaults back
    labels: { get settings() { return { ...labelSettings }; }, set: (partial) => setLabels({ ...labelSettings, ...partial }), reset: () => { list.items.forEach((it) => { delete it.labelAt; }); setLabels({}); },
      // the item whose label is under a view point (pixels from the view's top left), as a drag would find it, or null
      hit: (x, y) => labelAt(x, y), get dragging() { return !!dragging; } },
    // Print: a shape in progress is never printed (the components' analysis views are hidden); the list is printed
    // only when "Include measurements" is ticked. The returned function restores both (printContent's try/finally).
    async hideForPrint() {
      const views = await Promise.all(Object.values(tools).map((tool) => mapEl.view.whenAnalysisView(tool.analysis)));
      const saved = views.map((view) => view.visible);
      views.forEach((view) => { view.visible = false; });
      if (!printInclude) setHidden(true, "print");
      return () => {
        views.forEach((view, i) => { view.visible = saved[i]; });
        setHidden(false, "print");
      };
    },
  };
}
