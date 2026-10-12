import { GEOREF, LABELS, PLAN } from "./config.js";
import { analyze, expectedPerPt } from "./georefAnalysis.js";
import { suggestMapPoint, predictPagePoint, workingCrsProblem } from "./placementMath.js";
import { createVertexIndex } from "./vertexIndex.js";
import { footprintXY } from "./worldFile.js";
import { addBelowEdges } from "./layerOrder.js";

// Placement: the SDK side of putting a plan sheet on the map. Control points are picked in pairs (a corner on the sheet,
// the same corner on the map, in either order), snapped to parcel corners, fitted, and shown live as an overlay.
//
// Everything is computed in the working CRS (GEOREF.WORKING_WKID, US survey feet). Parcel corners are read in the parcel
// layer's own spatial reference and projected once per rebuild, as one Multipoint, so a snapped point keeps the parcel's
// own coordinates. A free click arrives in the view's spatial reference (Web Mercator) and is projected to the working
// CRS; it is recorded as snapped: false, because the basemap is only as exact as the imagery.
// Graphics and the overlay carry their working-CRS spatial reference and the SDK projects them to the view.
export async function createPlacement(ctx) {
  const [GraphicsLayer, Graphic, Point, Polygon, Multipoint, SpatialReference, projectOperator, MediaLayer, ImageElement, CornersGeoreference, reactiveUtils] =
    await $arcgis.import([
      "@arcgis/core/layers/GraphicsLayer.js",
      "@arcgis/core/Graphic.js",
      "@arcgis/core/geometry/Point.js",
      "@arcgis/core/geometry/Polygon.js",
      "@arcgis/core/geometry/Multipoint.js",
      "@arcgis/core/geometry/SpatialReference.js",
      "@arcgis/core/geometry/operators/projectOperator.js",
      "@arcgis/core/layers/MediaLayer.js",
      "@arcgis/core/layers/support/ImageElement.js",
      "@arcgis/core/layers/support/CornersGeoreference.js",
      "@arcgis/core/core/reactiveUtils.js",
    ]);
  const { S, mapEl, parcel } = ctx;
  const view = mapEl.view;
  const workSR = new SpatialReference({ wkid: GEOREF.WORKING_WKID });
  const problem = workingCrsProblem(workSR);
  if (problem) return { problem };
  if (!projectOperator.isLoaded()) await projectOperator.load();

  const css = getComputedStyle(document.documentElement);
  const BRAND = css.getPropertyValue("--calcite-color-brand").trim() || "#007ac2";
  const DIM = css.getPropertyValue("--calcite-color-text-3").trim() || "#6a6a6a";
  const toWork = (g) => projectOperator.execute(g, workSR);
  const workPoint = (X, Y) => new Point({ x: X, y: Y, spatialReference: workSR });

  // ---- graphics: point rings and labels, the pending and predicted rings, the snap ring, the sheet outline
  const markers = new GraphicsLayer({ id: "georef-markers", title: "Georeferencing points", listMode: "hide" });
  // the number labels sit in a layer of their own: a text symbol waits on its glyph font, and the rings must not
  const labels = new GraphicsLayer({ id: "georef-labels", title: "Georeferencing point numbers", listMode: "hide" });
  ctx.mapEl.map.add(markers);
  ctx.mapEl.map.add(labels);
  const ringSymbol = (color, style = "solid", size = 15, width = 2) => ({ type: "simple-marker", style: "circle", size, color: [255, 255, 255, 0.01], outline: { color, width, style } });
  const labelSymbol = (text, color) => ({ type: "text", text, color, haloColor: "white", haloSize: 2, xoffset: 11, yoffset: 8, horizontalAlignment: "left", font: { family: LABELS.DEFAULTS.fontFamily, size: 11, weight: "bold" } });
  let hoverRing = null, pendingRing = null, ghostRing = null, outline = null;
  const drop = (g) => { if (g && markers.graphics.includes(g)) markers.remove(g); };

  // ---- state
  const pending = { plan: null, map: null }; // the half-made pair
  let suggest = null; // where the fit predicts the pending sheet point should land: { X, Y, snapped }
  let active = false;
  let altDown = false;
  const handles = [];
  const options = { opacity: PLAN.OPACITY, outline: true, visible: true };
  let snapStatus = "";

  // ---- snapping: the parcel corners in view, in the working CRS
  const index = createVertexIndex(20);
  let indexSeq = 0, indexAbort = null, indexTimer = 0;
  async function rebuildIndex() {
    const seq = ++indexSeq;
    indexAbort?.abort();
    const controller = (indexAbort = new AbortController());
    try {
      if (!parcel.visible) { index.clear(); snapStatus = "The parcel layer is hidden, so there are no corners to snap to."; ctx.changed("snap"); return; }
      const where = parcel.definitionExpression && String(parcel.definitionExpression).trim() ? parcel.definitionExpression : "1=1";
      const { features } = await parcel.queryFeatures(
        { where, geometry: view.extent, spatialRelationship: "intersects", returnGeometry: true, outFields: [], num: LABELS.EDGES.MAX_PARCELS + 1, outSpatialReference: parcel.spatialReference },
        { signal: controller.signal },
      );
      if (seq !== indexSeq) return;
      index.clear();
      if (features.length > LABELS.EDGES.MAX_PARCELS) {
        snapStatus = `More than ${LABELS.EDGES.MAX_PARCELS} parcels in view. Zoom in to snap to parcel corners.`;
        ctx.changed("snap");
        return;
      }
      const polygons = features.map((f) => f.geometry?.rings ?? []);
      const flat = polygons.flatMap((rings) => rings.flat());
      let projected = flat;
      if (flat.length && !parcel.spatialReference.equals(workSR)) {
        const mp = projectOperator.execute(new Multipoint({ points: flat, spatialReference: parcel.spatialReference }), workSR);
        if (!mp || mp.points.length !== flat.length) throw new Error("Couldn't project the parcel corners into the working coordinate system.");
        projected = mp.points;
      }
      let k = 0;
      for (const rings of polygons) index.addRings(rings.map((ring) => ring.map(() => projected[k++])));
      snapStatus = index.size ? `Snapping to ${index.size.toLocaleString()} parcel corners in view. Hold Alt to place a point freely.` : "No parcel corners in view to snap to.";
      ctx.changed("snap");
    } catch (err) {
      if (err?.name === "AbortError" || seq !== indexSeq) return;
      console.warn("Couldn't read the parcel corners:", err);
      index.clear();
      snapStatus = "Couldn't read the parcel corners, so points will not snap.";
      ctx.changed("snap");
    }
  }
  const scheduleIndex = () => { clearTimeout(indexTimer); indexTimer = setTimeout(rebuildIndex, 250); };

  // Ground feet in the working CRS covered by SNAP_PX screen pixels at a screen position.
  function snapToleranceFt(x, y) {
    const a = toWork(view.toMap({ x, y }));
    const b = toWork(view.toMap({ x: x + GEOREF.SNAP_PX, y }));
    return a && b ? Math.hypot(b.x - a.x, b.y - a.y) : 0;
  }
  // The working-CRS position of a map click: the parcel corner it snaps to, or the click itself (Alt places freely).
  function resolveMapPoint(mapPoint, screen, free) {
    const g = toWork(mapPoint);
    if (!g) return { X: NaN, Y: NaN, snapped: false };
    if (!free) {
      const hit = index.nearest(g.x, g.y, snapToleranceFt(screen.x, screen.y));
      if (hit) return { X: hit.X, Y: hit.Y, snapped: true };
    }
    return { X: g.x, Y: g.y, snapped: false };
  }

  // ---- the fit
  function recompute() {
    S.analysis = analyze(S.model.points, {
      type: S.fitType, expectedPerPt: expectedPerPt(S.scale), reduction: S.scale.reduction, crop: S.crop,
      tolGood: GEOREF.TOLERANCE_FT.GOOD, tolWarn: GEOREF.TOLERANCE_FT.WARN,
    });
  }
  const resClass = (mag) => (mag == null || !Number.isFinite(mag) ? null : mag <= GEOREF.TOLERANCE_FT.GOOD ? "ok" : mag <= GEOREF.TOLERANCE_FT.WARN ? "warn" : "bad");

  function syncSheet() {
    const A = S.analysis;
    ctx.sheet.setPins(S.model.points.map((p, i) => ({
      id: p.id, label: String(p.id), xp: p.x, yp: p.y, off: !p.use, res: p.use && A?.rows[i]?.res ? resClass(A.rows[i].res.mag) : null,
    })));
    ctx.sheet.setSel(S.selId);
  }

  function syncMarkers() {
    markers.graphics.removeAll();
    labels.graphics.removeAll();
    hoverRing = pendingRing = ghostRing = outline = null;
    for (const p of S.model.points) {
      const color = p.use ? BRAND : DIM;
      const attributes = { pointId: p.id };
      markers.add(new Graphic({ geometry: workPoint(p.X, p.Y), symbol: ringSymbol(color, p.snapped ? "solid" : "dash", p.id === S.selId ? 19 : 15, p.id === S.selId ? 3 : 2), attributes }));
      labels.add(new Graphic({ geometry: workPoint(p.X, p.Y), symbol: labelSymbol(String(p.id), color), attributes }));
    }
    const A = S.analysis;
    if (options.outline && A?.T && S.raster) {
      const c = footprintXY(A.T, S.raster.crop, S.raster.dpi, S.raster.W, S.raster.H);
      outline = new Graphic({ geometry: new Polygon({ rings: [[...c, c[0]]], spatialReference: workSR }), symbol: { type: "simple-fill", color: [0, 0, 0, 0], outline: { color: BRAND, width: 1.5, style: "dash" } } });
      markers.add(outline);
    }
    drawPending();
  }
  function drawPending() {
    drop(pendingRing); drop(ghostRing);
    pendingRing = ghostRing = null;
    if (pending.map) {
      pendingRing = new Graphic({ geometry: workPoint(pending.map.X, pending.map.Y), symbol: ringSymbol(BRAND, "dash", 17) });
      markers.add(pendingRing);
    }
    if (suggest && pending.plan) {
      ghostRing = new Graphic({ geometry: workPoint(suggest.X, suggest.Y), symbol: ringSymbol(DIM, suggest.snapped ? "solid" : "dash", 21, 1.5) });
      markers.add(ghostRing);
    }
  }

  // ---- the overlay: the sheet on the map, live
  let overlay = null, element = null, overlayKey = null, shownOnce = false;
  function overlayImage() {
    const c = S.raster.canvas;
    const longest = Math.max(c.width, c.height);
    if (longest <= PLAN.MAX_DIM) return c;
    const f = PLAN.MAX_DIM / longest;
    const out = document.createElement("canvas");
    out.width = Math.round(c.width * f);
    out.height = Math.round(c.height * f);
    const g = out.getContext("2d");
    g.imageSmoothingQuality = "high";
    g.drawImage(c, 0, 0, out.width, out.height);
    return out;
  }
  async function syncOverlay() {
    const A = S.analysis;
    if (!A?.T || !S.raster) {
      if (overlay) overlay.visible = false;
      return;
    }
    const c = footprintXY(A.T, S.raster.crop, S.raster.dpi, S.raster.W, S.raster.H);
    const georeference = new CornersGeoreference({ topLeft: workPoint(...c[0]), topRight: workPoint(...c[1]), bottomRight: workPoint(...c[2]), bottomLeft: workPoint(...c[3]) });
    if (!overlay) {
      element = new ImageElement({ image: overlayImage(), georeference });
      overlayKey = S.rasterKey;
      overlay = new MediaLayer({ source: [element], title: "Plan being georeferenced", opacity: options.opacity, blendMode: "multiply", listMode: "hide" });
      addBelowEdges(mapEl.map, overlay);
    } else {
      if (overlayKey !== S.rasterKey) {
        element.image = overlayImage();
        overlayKey = S.rasterKey;
      }
      element.georeference = georeference;
    }
    overlay.visible = options.visible;
    if (!shownOnce) {
      shownOnce = true;
      ctx.say("The sheet is on the map. Keep adding corners toward the edges.", "good");
      const polygon = new Polygon({ rings: [[...c, c[0]]], spatialReference: workSR });
      mapEl.goTo(polygon.extent.clone().expand(1.6)).catch(() => {});
    }
  }

  function refresh() {
    recompute();
    syncSheet();
    syncMarkers();
    syncOverlay();
    updateSuggestion();
    ctx.changed("points");
  }

  // ---- the predicted next corner (the dashed ring)
  function updateSuggestion(pan = false) {
    suggest = null;
    const A = S.analysis;
    ctx.sheet.setGhost(null);
    if (A?.T && pending.plan) {
      suggest = suggestMapPoint({ T: A.T, x: pending.plan.x, y: pending.plan.y, rms: A.rms, looRms: A.looRms, nearest: index.nearest });
      if (pan) {
        const s = view.toScreen(workPoint(suggest.X, suggest.Y));
        if (s.x < 40 || s.y < 40 || s.x > view.width - 40 || s.y > view.height - 40) mapEl.goTo(workPoint(suggest.X, suggest.Y)).catch(() => {});
      }
    } else if (A?.T && pending.map) {
      const q = predictPagePoint(A.T, pending.map.X, pending.map.Y);
      if (q) {
        ctx.sheet.setGhost({ xp: q[0], yp: q[1], label: String(S.model.nextId) });
        if (pan) ctx.sheet.focus(q[0], q[1]);
      }
    }
    drawPending();
    ctx.changed("pairing");
  }

  // ---- picking
  function setPendingSheet(x, y) {
    pending.plan = { x, y };
    ctx.sheet.setPending({ xp: x, yp: y, label: String(S.model.nextId) });
    updateSuggestion(true);
  }
  function setPendingMap(m) {
    pending.map = m;
    updateSuggestion(true);
  }
  function cancelPending() {
    pending.plan = pending.map = null;
    suggest = null;
    ctx.sheet.setPending(null);
    ctx.sheet.setGhost(null);
    drawPending();
    ctx.changed("pairing");
  }
  function addPoint(x, y, m) {
    const p = S.model.add({ x, y, X: m.X, Y: m.Y, snapped: m.snapped });
    S.selId = p.id;
    ctx.markDirty();
    pending.plan = pending.map = null;
    ctx.sheet.setPending(null);
    refresh();
    return p;
  }
  function pickOnSheet(x, y) {
    if (!active) return;
    if (pending.map) addPoint(x, y, pending.map);
    else setPendingSheet(x, y);
  }
  function pickOnMap(mapPoint, screen, free) {
    if (!active) return;
    const m = resolveMapPoint(mapPoint, screen, free);
    if (!Number.isFinite(m.X)) return;
    if (pending.plan) addPoint(pending.plan.x, pending.plan.y, m);
    else setPendingMap(m);
  }
  // Enter: take the dashed ring, if it sits on a parcel corner.
  function acceptSuggestion() {
    if (!pending.plan) return false;
    if (!suggest?.snapped) { ctx.say("No parcel corner near the predicted spot. Click the map instead.", "warn"); return true; }
    addPoint(pending.plan.x, pending.plan.y, suggest);
    return true;
  }

  // ---- point edits
  const edit = {
    select(id, { fromTable = false, fromMap = false } = {}) {
      S.selId = id;
      syncSheet();
      syncMarkers();
      const p = S.model.byId(id);
      if (!p) return;
      if (fromTable || fromMap) ctx.sheet.focus(p.x, p.y);
      if (fromTable) {
        const s = view.toScreen(workPoint(p.X, p.Y));
        if (s.x < 20 || s.y < 20 || s.x > view.width - 20 || s.y > view.height - 20) mapEl.goTo(workPoint(p.X, p.Y)).catch(() => {});
      }
      ctx.changed("selection");
    },
    remove(id) { if (S.model.remove(id)) { if (S.selId === id) S.selId = null; ctx.markDirty(); refresh(); } },
    setUse(id, on) { if (S.model.setUse(id, on)) { ctx.markDirty(); refresh(); } },
    undo() {
      if (!S.model.undo()) { ctx.say("Nothing to undo."); return; }
      if (!S.model.byId(S.selId)) S.selId = null;
      cancelPending();
      ctx.markDirty();
      refresh();
    },
    clear() {
      const n = S.model.clear();
      if (!n) return;
      S.selId = null;
      cancelPending();
      ctx.markDirty();
      refresh();
      ctx.say(`Cleared ${n} point${n === 1 ? "" : "s"}. Ctrl+Z brings them back.`);
    },
    // Nudge the selected point's place on the sheet by whole pixels of the rendered image.
    nudge(dxPx, dyPx) {
      const p = S.model.byId(S.selId);
      if (!p || !S.raster) return false;
      const s = S.raster.dpi / 72;
      S.model.nudge(p.id, dxPx / s, dyPx / s, { w: S.page.pageWidthPt, h: S.page.pageHeightPt }, performance.now());
      ctx.markDirty();
      refresh();
      return true;
    },
    setFitType(type) { S.fitType = type; ctx.markDirty(); refresh(); },
    // sheet pin dragging
    movePin(id, x, y, phase) {
      if (phase === "start") { S.model.push(); return; }
      if (phase === "end") return;
      S.model.setPage(id, Math.min(S.page.pageWidthPt, Math.max(0, x)), Math.min(S.page.pageHeightPt, Math.max(0, y)));
      ctx.markDirty();
      refresh();
    },
  };

  // ---- the overlay controls
  const overlayControls = {
    get options() { return { ...options }; },
    set(partial) {
      Object.assign(options, partial);
      if (overlay) { overlay.opacity = options.opacity; overlay.visible = options.visible && !!S.analysis?.T; }
      syncMarkers();
    },
    zoomToSheet() {
      const A = S.analysis;
      if (!A?.T || !S.raster) return;
      const c = footprintXY(A.T, S.raster.crop, S.raster.dpi, S.raster.W, S.raster.H);
      mapEl.goTo(new Polygon({ rings: [[...c, c[0]]], spatialReference: workSR }).extent.clone().expand(1.3)).catch(() => {});
    },
  };

  // ---- map events (only while picking)
  let draggingId = null;
  // The control point whose ring is under a screen position (decided at once, so a drag can stop the map panning).
  function markerAt(x, y) {
    let best = null, bd = 12;
    for (const p of S.model.points) {
      const s = view.toScreen(workPoint(p.X, p.Y));
      const d = Math.hypot(s.x - x, s.y - y);
      if (d < bd) { bd = d; best = p.id; }
    }
    return best;
  }
  handles.push(view.on("click", (event) => {
    if (!active || event.button !== 0) return;
    event.stopPropagation();
    const near = markerAt(event.x, event.y);
    if (near !== null && !pending.plan) { edit.select(near, { fromMap: true }); return; } // a click on a ring selects that point
    pickOnMap(event.mapPoint, { x: event.x, y: event.y }, altDown || event.native?.altKey);
  }));
  let moveFrame = 0, lastMove = null;
  handles.push(view.on("pointer-move", (event) => {
    if (!active) return;
    lastMove = event;
    if (moveFrame) return;
    moveFrame = requestAnimationFrame(() => {
      moveFrame = 0;
      drop(hoverRing);
      hoverRing = null;
      if (!lastMove || draggingId !== null || altDown || lastMove.native?.altKey) return;
      const g = toWork(view.toMap({ x: lastMove.x, y: lastMove.y }));
      const hit = g && index.nearest(g.x, g.y, snapToleranceFt(lastMove.x, lastMove.y));
      if (hit) {
        hoverRing = new Graphic({ geometry: workPoint(hit.X, hit.Y), symbol: { type: "simple-marker", style: "circle", size: 22, color: [0, 0, 0, 0], outline: { color: BRAND, width: 1 } } });
        markers.add(hoverRing);
      }
    });
  }));
  // dragging a point's ring on the map moves that point (to a parcel corner if one is near; Alt places it freely)
  handles.push(view.on("drag", (event) => {
    if (!active) return;
    if (event.action === "start") {
      const id = markerAt(event.x, event.y);
      if (id === null) return;
      draggingId = id;
      event.stopPropagation(); // stops the map panning
      S.model.push();
      edit.select(id);
      return;
    }
    if (draggingId === null) return;
    event.stopPropagation();
    const mp = view.toMap({ x: event.x, y: event.y });
    if (mp) {
      const m = resolveMapPoint(mp, { x: event.x, y: event.y }, altDown || event.native?.altKey);
      S.model.setMap(draggingId, m.X, m.Y, m.snapped);
      ctx.markDirty();
    }
    if (event.action === "end") draggingId = null;
    refresh();
  }));
  const keyState = (e) => { altDown = e.altKey; };
  window.addEventListener("keydown", keyState);
  window.addEventListener("keyup", keyState);
  handles.push({ remove: () => { window.removeEventListener("keydown", keyState); window.removeEventListener("keyup", keyState); } });
  handles.push(reactiveUtils.watch(() => view.stationary, (stationary) => { if (stationary && active) scheduleIndex(); }));

  // ---- sheet events
  ctx.sheet.onPick = (x, y) => pickOnSheet(x, y);
  ctx.sheet.onSelect = (id) => edit.select(id);
  ctx.sheet.onHover = () => {};
  ctx.sheet.onMovePoint = (id, x, y, phase) => edit.movePin(id, x, y, phase);

  return {
    problem: null,
    start() {
      active = true;
      ctx.sheet.setMode("pick");
      rebuildIndex();
      refresh();
    },
    stop() {
      active = false;
      cancelPending();
      drop(hoverRing);
      hoverRing = null;
    },
    destroy() {
      active = false;
      clearTimeout(indexTimer);
      indexAbort?.abort();
      handles.forEach((hnd) => hnd.remove());
      mapEl.map.remove(markers);
      mapEl.map.remove(labels);
      markers.destroy();
      labels.destroy();
      if (overlay) { mapEl.map.remove(overlay); overlay.destroy(); }
    },
    refresh, edit, cancelPending, acceptSuggestion, overlay: overlayControls,
    get pending() { return { plan: pending.plan, map: pending.map }; },
    get suggestion() { return suggest; },
    get snapStatus() { return snapStatus; },
    get index() { return index; },
    toWork, workSR, workingWkid: GEOREF.WORKING_WKID,
    // for the harness and the review step: the overlay's current corners in the working CRS
    footprint() {
      const A = S.analysis;
      return A?.T && S.raster ? footprintXY(A.T, S.raster.crop, S.raster.dpi, S.raster.W, S.raster.H) : null;
    },
  };
}
