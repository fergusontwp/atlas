import { GEOREF, LABELS, PLAN, PLANS } from "./config.js";
import { expectedPerPt } from "./georefAnalysis.js";
import { applyT, invertT } from "./georefTransform.js";
import { suggestMapPoint, workingCrsProblem } from "./placementMath.js";
import { cropSheet, fromPageT, moveSeed, pieceAtPage, rotateSeed, seedAt, solvePlacement, toPageT } from "./placeSolve.js";
import { seedFromLine, seedProblemText } from "./lineSeed.js";
import { createVertexIndex, geometryParts, snapPlan, snapRings } from "./vertexIndex.js";
import { footprintXY, imageTransform } from "./worldFile.js";
import { addBelowEdges } from "./layerOrder.js";
import { thickenedCrop } from "./thickenCanvas.js";
import { haloFor, ptToPx } from "./thicken.js";

// Placement: the SDK side of putting a plan sheet on the map. Control points are picked in pairs (a corner on the sheet,
// the same corner on the map, in either order), snapped to parcel corners (and, for a subject that isn't a parcel, to
// its own vertices), fitted, and shown live as an overlay.
//
// Everything is computed in the working CRS (GEOREF.WORKING_WKID, US survey feet). Parcel corners are read in the parcel
// layer's own spatial reference and projected once per rebuild, as one Multipoint, so a snapped point keeps the parcel's
// own coordinates. A free click arrives in the view's spatial reference (Web Mercator) and is projected to the working
// CRS; it is recorded as snapped: false, because the basemap is only as exact as the imagery.
// Graphics and the overlay carry their working-CRS spatial reference and the SDK projects them to the view.
//
// One tool, two solvers (placeSolve.js): the fit type is a whole-sheet fit (similarity, locked, affine) or a chain (one
// rigid piece between each pair of neighbouring pins, drawn as one image element per piece). Before there are enough
// pins, the sheet can be placed roughly by hand (move, turn, x/y, at the map centre) or along the selected line
// (lineSeed.js); that rough placement is the seed, and one pin shifts it. The map tool is "pins" (pairing points, as
// before), "move" or "rotate" (dragging the map moves or turns the seed) or "start" (the next click is where the plan's
// left end sits on the line).
export async function createPlacement(ctx) {
  const [GraphicsLayer, Graphic, Point, Polygon, Polyline, Multipoint, SpatialReference, projectOperator, MediaLayer, ImageElement, CornersGeoreference, reactiveUtils] =
    await $arcgis.import([
      "@arcgis/core/layers/GraphicsLayer.js",
      "@arcgis/core/Graphic.js",
      "@arcgis/core/geometry/Point.js",
      "@arcgis/core/geometry/Polygon.js",
      "@arcgis/core/geometry/Polyline.js",
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
  // the piece outlines and the pins' miss lines: a few lines, redrawn whole
  const lines = new GraphicsLayer({ id: "georef-lines", title: "Georeferencing outlines", listMode: "hide" });
  ctx.mapEl.map.add(lines);
  ctx.mapEl.map.add(markers);
  ctx.mapEl.map.add(labels);
  const ringSymbol = (color, style = "solid", size = 15, width = 2) => ({ type: "simple-marker", style: "circle", size, color: [255, 255, 255, 0.01], outline: { color, width, style } });
  const labelSymbol = (text, color) => ({ type: "text", text, color, haloColor: "white", haloSize: 2, xoffset: 11, yoffset: 8, horizontalAlignment: "left", font: { family: LABELS.DEFAULTS.fontFamily, size: 11, weight: "bold" } });
  let hoverRing = null, pendingRing = null, ghostRing = null;
  const drop = (g) => { if (g && markers.graphics.includes(g)) markers.remove(g); };

  // ---- state
  const pending = { plan: null, map: null }; // the half-made pair
  let suggest = null; // where the fit predicts the pending sheet point should land: { X, Y, snapped }
  let active = false;
  let altDown = false;
  const handles = [];
  const options = { opacity: PLAN.PLACING_OPACITY, outline: true, visible: true };
  let snapStatus = "";

  // ---- snapping, in the working CRS: for a parcel subject the parcel corners in view, as before; for any other subject
  // (a road, a pipe, a point) its own vertices and, while the view is small enough, the parcel corners in view
  // (PLANS.SNAP; vertexIndex.snapPlan)
  const index = createVertexIndex(20);
  const plan = snapPlan(ctx.subject, PLANS.SNAP.SOURCES);
  const snapNoun = plan.selected ? "corner or vertex" : "parcel corner";
  let indexSeq = 0, indexAbort = null, indexTimer = 0, featureParts = null;

  // The parcel rings in view in the working CRS, or why there are none: { rings, why } with why "hidden", "wide" (the
  // view is over SNAP.MAX_EXTENT_FT across; only for another subject) or "many" (over MAX_PARCELS parcels in view).
  async function parcelRingsInView(signal) {
    if (!parcel.visible) return { rings: [], why: "hidden" };
    if (plan.parcels === "limited") {
      const e = toWork(view.extent);
      if (!e || Math.max(e.width, e.height) > PLANS.SNAP.MAX_EXTENT_FT) return { rings: [], why: "wide" };
    }
    const where = parcel.definitionExpression && String(parcel.definitionExpression).trim() ? parcel.definitionExpression : "1=1";
    const { features } = await parcel.queryFeatures(
      { where, geometry: view.extent, spatialRelationship: "intersects", returnGeometry: true, outFields: [], num: LABELS.EDGES.MAX_PARCELS + 1, outSpatialReference: parcel.spatialReference },
      { signal },
    );
    if (features.length > LABELS.EDGES.MAX_PARCELS) return { rings: [], why: "many" };
    const polygons = features.map((f) => f.geometry?.rings ?? []);
    const flat = polygons.flatMap((rings) => rings.flat());
    let projected = flat;
    if (flat.length && !parcel.spatialReference.equals(workSR)) {
      const mp = projectOperator.execute(new Multipoint({ points: flat, spatialReference: parcel.spatialReference }), workSR);
      if (!mp || mp.points.length !== flat.length) throw new Error("Couldn't project the parcel corners into the working coordinate system.");
      projected = mp.points;
    }
    let k = 0;
    return { rings: polygons.flatMap((rings) => rings.map((ring) => ring.map(() => projected[k++]))), why: null };
  }

  // The subject's own vertices in the working CRS, read once at full precision from its layer (the clicked shape when
  // the layer can't be asked).
  async function subjectParts(signal) {
    if (featureParts) return featureParts;
    const s = ctx.subject;
    let g = null;
    if (s?.layer?.queryFeatures && s.oid !== null) {
      try {
        const { features } = await s.layer.queryFeatures({ objectIds: [s.oid], returnGeometry: true, outFields: [], outSpatialReference: workSR }, { signal });
        g = features[0]?.geometry ?? null;
      } catch (err) {
        if (err?.name === "AbortError") throw err;
        console.warn("Couldn't read the selected feature's vertices at full precision; using the clicked shape:", err);
      }
    }
    if (!g && s?.geometry) g = toWork(s.geometry);
    featureParts = geometryParts(g);
    return featureParts;
  }

  async function rebuildIndex() {
    const seq = ++indexSeq;
    indexAbort?.abort();
    const controller = (indexAbort = new AbortController());
    let parcelsFailed = false;
    try {
      const parcels = plan.parcels
        ? await parcelRingsInView(controller.signal).catch((err) => {
          if (err?.name === "AbortError" || !plan.selected) throw err;
          console.warn("Couldn't read the parcel corners:", err);
          parcelsFailed = true;
          return { rings: [], why: null };
        })
        : { rings: [], why: null };
      const parts = plan.selected ? await subjectParts(controller.signal) : [];
      if (seq !== indexSeq) return;
      index.clear();
      index.addRings(snapRings({ plan, parcelRings: parcels.rings, maxCorners: PLANS.SNAP.MAX_CORNERS }));
      const corners = index.size;
      if (plan.selected) index.addRings(parts);
      snapStatus = snapText({ corners, vertices: index.size - corners, why: parcels.why, failed: parcelsFailed });
      ctx.changed("snap");
    } catch (err) {
      if (err?.name === "AbortError" || seq !== indexSeq) return;
      console.warn("Couldn't read the parcel corners:", err);
      index.clear();
      snapStatus = "Couldn't read the parcel corners, so points will not snap.";
      ctx.changed("snap");
    }
  }

  // The Place step's line about snapping (a parcel subject's wording is as before).
  function snapText({ corners, vertices, why, failed }) {
    const free = "Hold Alt to place a point freely.";
    if (!plan.selected) {
      if (why === "hidden") return "The parcel layer is hidden, so there are no corners to snap to.";
      if (why === "many") return `More than ${LABELS.EDGES.MAX_PARCELS} parcels in view. Zoom in to snap to parcel corners.`;
      return corners ? `Snapping to ${corners.toLocaleString()} parcel corners in view. ${free}` : "No parcel corners in view to snap to.";
    }
    const parts = [vertices ? `${vertices.toLocaleString()} vertices of the selected feature` : "", corners ? `${corners.toLocaleString()} parcel corners in view` : ""].filter(Boolean);
    const head = parts.length ? `Snapping to ${parts.join(" and ")}. ${free}` : "Nothing in view to snap to.";
    const parcelsNote = !plan.parcels ? ""
      : failed ? " Couldn't read the parcel corners."
      : why === "wide" ? ` Zoom in to within ${PLANS.SNAP.MAX_EXTENT_FT.toLocaleString()} ft to snap to parcel corners too.`
      : why === "many" ? ` More than ${LABELS.EDGES.MAX_PARCELS} parcels in view: zoom in to snap to their corners too.`
      : why === "hidden" ? " The parcel layer is hidden." : "";
    return head + parcelsNote;
  }
  const scheduleIndex = () => { clearTimeout(indexTimer); indexTimer = setTimeout(rebuildIndex, 250); };

  // Ground feet in the working CRS covered by SNAP_PX screen pixels at a screen position.
  function snapToleranceFt(x, y) {
    const a = toWork(view.toMap({ x, y }));
    const b = toWork(view.toMap({ x: x + GEOREF.SNAP_PX, y }));
    return a && b ? Math.hypot(b.x - a.x, b.y - a.y) : 0;
  }
  // The working-CRS position of a map click: the corner or vertex it snaps to, or the click itself (Alt places freely).
  function resolveMapPoint(mapPoint, screen, free) {
    const g = toWork(mapPoint);
    if (!g) return { X: NaN, Y: NaN, snapped: false };
    if (!free) {
      const hit = index.nearest(g.x, g.y, snapToleranceFt(screen.x, screen.y));
      if (hit) return { X: hit.X, Y: hit.Y, snapped: true };
    }
    return { X: g.x, Y: g.y, snapped: false };
  }

  // ---- the fit: the solver for the fit type (placeSolve.js). S.solve holds what is drawn, S.analysis the table and verdict.
  const cropNow = () => S.raster?.crop ?? S.crop;
  function recompute() {
    const perPt = expectedPerPt(S.scale);
    const crop = cropNow();
    S.solve = solvePlacement(S.model.points, {
      fitType: S.fitType, crop, seed: S.model.seed, perPt, exact: S.chainExact,
      // MIN_PIN_PX is in rendered pixels; the pins are in page points
      minPinPt: (PLANS.CHAIN.MIN_PIN_PX * 72) / (S.raster?.dpi ?? 72),
      analyze: { expectedPerPt: perPt, reduction: S.scale.reduction, crop, tolGood: GEOREF.TOLERANCE_FT.GOOD, tolWarn: GEOREF.TOLERANCE_FT.WARN },
    });
    S.analysis = S.solve.analysis;
  }
  // What is drawn: one entry per image element, { c0, c1 (page points from the crop's left edge), Tp (page transform) }.
  function shownPieces() {
    const sol = S.solve, crop = cropNow();
    if (!sol || !crop) return [];
    if (sol.mode === "chain") return sol.chain.pieces;
    return sol.T ? [{ c0: 0, c1: cropSheet(crop).W, Tp: sol.T }] : [];
  }
  // Ground under a page point, through the piece that holds it; null with nothing placed.
  function groundOf(x, y) {
    const pieces = shownPieces();
    const piece = pieces.length > 1 ? pieceAtPage(pieces, cropNow(), x) : pieces[0];
    return piece ? applyT(piece.Tp, x, y) : null;
  }
  // The page point under a ground point: through the piece whose columns hold it (the nearest by columns otherwise).
  function pageOf(X, Y) {
    const crop = cropNow();
    let best = null, bestD = Infinity;
    for (const piece of shownPieces()) {
      const q = invertT(piece.Tp)?.toPage(X, Y);
      if (!q) continue;
      const col = q[0] - crop.x0, d = col < piece.c0 ? piece.c0 - col : col > piece.c1 ? col - piece.c1 : 0;
      if (d < bestD) { bestD = d; best = q; }
    }
    return best;
  }
  const resClass = (mag) => (mag == null || !Number.isFinite(mag) ? null : mag <= GEOREF.TOLERANCE_FT.GOOD ? "ok" : mag <= GEOREF.TOLERANCE_FT.WARN ? "warn" : "bad");

  function syncSheet() {
    const A = S.analysis;
    ctx.sheet.setPins(S.model.points.map((p, i) => ({
      id: p.id, label: String(p.id), xp: p.x, yp: p.y, off: !p.use, res: p.use && A?.rows[i]?.res ? resClass(A.rows[i].res.mag) : null,
    })));
    ctx.sheet.setSel(S.selId);
  }

  // The pins' rings and numbers are kept and moved (a text symbol is slow to make, and removing and re-adding every
  // graphic on each pointer move made dragging stutter); only what changed is set.
  const pinGraphics = new Map(); // point id -> { ring, label, geo, style }
  const OUTLINE_SYMBOL = { type: "simple-fill", color: [0, 0, 0, 0], outline: { color: BRAND, width: 1.5, style: "dash" } };
  const MISS_LINE = { type: "simple-line", color: BRAND, width: 1.2, style: "dash" };
  const MISS_DOT = { type: "simple-marker", style: "circle", size: 6, color: BRAND, outline: { color: "white", width: 1 } };
  function syncMarkers() {
    const seen = new Set();
    for (const p of S.model.points) {
      seen.add(p.id);
      const color = p.use ? BRAND : DIM, sel = p.id === S.selId;
      const geo = `${p.X},${p.Y}`, style = `${color}|${p.snapped}|${sel}`;
      let g = pinGraphics.get(p.id);
      if (!g) {
        g = { ring: new Graphic({ attributes: { pointId: p.id } }), label: new Graphic({ attributes: { pointId: p.id } }) };
        markers.add(g.ring);
        labels.add(g.label);
        pinGraphics.set(p.id, g);
      }
      if (g.geo !== geo) { const pt = workPoint(p.X, p.Y); g.ring.geometry = pt; g.label.geometry = pt; g.geo = geo; }
      if (g.style !== style) {
        g.ring.symbol = ringSymbol(color, p.snapped ? "solid" : "dash", sel ? 19 : 15, sel ? 3 : 2);
        g.label.symbol = labelSymbol(String(p.id), color);
        g.style = style;
      }
    }
    for (const [id, g] of pinGraphics) if (!seen.has(id)) { markers.remove(g.ring); labels.remove(g.label); pinGraphics.delete(id); }
    // the outline of the sheet, or of each piece, and where the placement puts each pin's sheet spot, joined to the pin
    // by a dashed line when they differ (a rough placement, a held scale, or a whole-sheet fit that can't meet every pin)
    const add = [];
    if (options.outline && S.raster) {
      for (const piece of shownPieces()) {
        const c = pieceCorners(piece);
        add.push(new Graphic({ geometry: new Polygon({ rings: [[...c, c[0]]], spatialReference: workSR }), symbol: OUTLINE_SYMBOL }));
      }
    }
    for (const p of S.model.points) {
      if (!p.use) continue;
      const g = groundOf(p.x, p.y);
      if (!g || Math.hypot(g[0] - p.X, g[1] - p.Y) < 0.05) continue;
      add.push(new Graphic({ geometry: new Polyline({ paths: [[g, [p.X, p.Y]]], spatialReference: workSR }), symbol: MISS_LINE }));
      add.push(new Graphic({ geometry: workPoint(g[0], g[1]), symbol: MISS_DOT }));
    }
    lines.removeAll();
    if (add.length) lines.addMany(add);
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

  // ---- the overlay: the sheet on the map, live. One image element per piece (one for a whole-sheet placement), each a
  // crop of the render by columns, cut at whole rendered pixels so its corners stay exact; every piece but the last takes
  // PLANS.CHAIN.PIECE_OVERLAP_PX more on its right against a hairline gap at the cut.
  let overlay = null, overlayKey = null, shownOnce = false, overlayFrame = 0;
  let sheetDrag = false, lastSpans = null; // while a pin is dragged on the sheet, the pieces keep their cuts (see drawOverlay)
  const cropCache = new Map(); // "rasterKey|p0|p1" -> canvas
  // The pixel columns [p0, p1) of the render a piece shows, and its four corners on the ground (given columns, or its own).
  function pieceSpan(piece, last, cols) {
    const r = S.raster, s = r.dpi / 72;
    const p0 = cols ? cols.p0 : Math.max(0, Math.min(r.W - 1, Math.round(piece.c0 * s)));
    const p1 = cols ? cols.p1 : Math.max(p0 + 1, Math.min(r.W, Math.round(piece.c1 * s) + (last ? 0 : PLANS.CHAIN.PIECE_OVERLAP_PX)));
    const t = imageTransform(piece.Tp, r.crop, r.dpi);
    const at = (u, v) => [t.A * u + t.B * v + t.C, t.D * u + t.E * v + t.F];
    return { p0, p1, corners: [at(p0, 0), at(p1, 0), at(p1, r.H), at(p0, r.H)] };
  }
  const pieceCorners = (piece) => pieceSpan(piece, true).corners;
  // The render's columns [p0, p1), scaled down to PLAN.MAX_DIM on its longest side for the GPU. With a line weight it
  // is applied at that displayed size's own pixels (thickenCanvas.js), reading the neighbouring columns as its halo, so
  // the preview on the map looks as the saved image will at that resolution.
  const thickenKey = () => (S.thicken ? JSON.stringify(S.thicken) : "");
  function cropImage(p0, p1) {
    const key = `${S.rasterKey}|${p0}|${p1}|${thickenKey()}`;
    if (cropCache.has(key)) return cropCache.get(key);
    const src = S.raster.canvas, w = p1 - p0, H = src.height;
    const f = Math.min(1, PLAN.MAX_DIM / Math.max(w, H));
    let out = src;
    if (S.thicken) {
      out = thickenedCrop({ src, left: p0, w, scale: f, P: S.thicken, dpi: S.raster.dpi, makeCanvas: (cw, ch) => Object.assign(document.createElement("canvas"), { width: cw, height: ch }) });
    } else if (p0 !== 0 || p1 !== src.width || f < 1) {
      out = document.createElement("canvas");
      out.width = Math.max(1, Math.round(w * f));
      out.height = Math.max(1, Math.round(H * f));
      const g = out.getContext("2d");
      g.imageSmoothingQuality = "high";
      g.drawImage(src, p0, 0, w, H, 0, 0, out.width, out.height);
    }
    if (cropCache.size > 64) cropCache.clear();
    cropCache.set(key, out);
    return out;
  }
  // Redrawn once per animation frame at most (dragging a pin calls refresh on every pointer move).
  function syncOverlay() {
    if (overlayFrame) return;
    overlayFrame = requestAnimationFrame(() => { overlayFrame = 0; drawOverlay(); });
  }
  function drawOverlay() {
    const pieces = S.raster ? shownPieces() : [];
    if (!pieces.length) {
      if (overlay) overlay.visible = false;
      return;
    }
    // Cutting a piece out of a wide render is the slow part (hundreds of ms for a 5,000 px piece without a GPU canvas).
    // While a pin is dragged on the sheet the cut moves every frame, so the pieces keep their old cuts, placed by the new
    // fits (each image stays exact on the ground; only where it ends lags), and are cut again when the drag ends.
    const keep = sheetDrag && lastSpans?.length === pieces.length;
    const spans = pieces.map((piece, i) => pieceSpan(piece, i === pieces.length - 1, keep ? lastSpans[i] : null));
    lastSpans = spans;
    const georef = (c) => new CornersGeoreference({ topLeft: workPoint(...c[0]), topRight: workPoint(...c[1]), bottomRight: workPoint(...c[2]), bottomLeft: workPoint(...c[3]) });
    const key = `${S.rasterKey}|${spans.map((sp) => `${sp.p0}-${sp.p1}`).join(",")}|${thickenKey()}`;
    if (!overlay) {
      overlay = new MediaLayer({ source: [], title: "Plan being georeferenced", opacity: options.opacity, blendMode: "multiply", listMode: "hide" });
      addBelowEdges(mapEl.map, overlay);
    }
    const elements = overlay.source.elements;
    lastPieces = pieces;
    if (overlayKey !== key) {
      // the cuts changed (a pin moved on the sheet, added or removed, or a new render): new elements
      clearDetail();
      elements.removeAll();
      coarse = spans.map((sp) => new ImageElement({ image: cropImage(sp.p0, sp.p1), georeference: georef(sp.corners) }));
      elements.addMany(coarse);
      overlayKey = key;
    } else {
      coarse.forEach((el, i) => { el.georeference = georef(spans[i].corners); });
      // the sharp parts follow their pieces too
      for (const d of detail) if (pieces[d.i]) d.el.georeference = georef(rectCorners(pieces[d.i], d));
    }
    overlay.visible = options.visible;
    scheduleDetail();
    if (!shownOnce) {
      shownOnce = true;
      ctx.say(S.solve.mode === "seed" ? "The sheet is on the map. Add pins to bring it onto the ground." : "The sheet is on the map. Keep adding corners toward the edges.", "good");
      zoomToPieces(1.6);
    }
  }
  // ---- the sharp part. The pieces above are at most PLAN.MAX_DIM on a side for the GPU, so a long sheet is shown far
  // coarser than its render (a 27,000 px sheet at 4,096 px is 6.6 times coarser): too blurry to place pins by. So
  // whenever the map comes to rest, the part of each piece in view (with a margin) is laid over its coarse image in the
  // same layer at the screen's own resolution (device pixels), with the line weight if there is one: cut from the
  // working render when that is fine enough, otherwise rendered from the PDF itself for that part (up to the page's
  // finest detail, ctx.finestDpi), with the render's cut shown meanwhile. A part that still covers the view at a close
  // enough resolution is kept. Parts are in the render's pixels (x0..x1, y0..y1); k is image pixels per render pixel.
  let coarse = [], detail = [], lastPieces = [], detailTimer = 0;
  const DETAIL_GRID = 256; // render pixels: the cut is snapped outward to this grid, so small pans keep it
  const rectCorners = (piece, d) => {
    const t = imageTransform(piece.Tp, S.raster.crop, S.raster.dpi);
    const at = (u, v) => [t.A * u + t.B * v + t.C, t.D * u + t.E * v + t.F];
    return [at(d.x0, d.y0), at(d.x1, d.y0), at(d.x1, d.y1), at(d.x0, d.y1)];
  };
  const freeDetail = (d) => { d.abort?.abort(); d.canvas.width = 0; d.canvas.height = 0; };
  function clearDetail() {
    if (overlay && detail.length) overlay.source.elements.removeMany(detail.map((d) => d.el));
    detail.forEach(freeDetail);
    detail = [];
  }
  function scheduleDetail() { clearTimeout(detailTimer); detailTimer = setTimeout(updateDetail, 150); }
  const makeCanvas = (cw, ch) => Object.assign(document.createElement("canvas"), { width: cw, height: ch });
  const georefOf = (c) => new CornersGeoreference({ topLeft: workPoint(...c[0]), topRight: workPoint(...c[1]), bottomRight: workPoint(...c[2]), bottomLeft: workPoint(...c[3]) });
  function updateDetail() {
    if (!overlay || !overlay.visible || !S.raster || !lastPieces.length || !view.extent) { clearDetail(); return; }
    // not while something is being dragged or the map moves: it is made once things are still
    if (sheetDrag || handDrag || draggingId !== null || !view.stationary) { scheduleDetail(); return; }
    const r = S.raster, s = r.dpi / 72, dpr = window.devicePixelRatio || 1, e = view.extent;
    const corners = [[e.xmin, e.ymin], [e.xmax, e.ymin], [e.xmax, e.ymax], [e.xmin, e.ymax]]
      .map(([x, y]) => toWork(new Point({ x, y, spatialReference: e.spatialReference })));
    if (corners.some((c) => !c)) return;
    const ftPerDevicePx = Math.hypot(corners[1].x - corners[0].x, corners[1].y - corners[0].y) / (view.width * dpr);
    const kMax = Math.max(1, (ctx.finestDpi?.() ?? r.dpi) / r.dpi); // the PDF's finest, in render pixels
    const key = `${S.rasterKey}|${thickenKey()}`;
    const want = [];
    lastPieces.forEach((piece, i) => {
      const inv = invertT(piece.Tp), sp = lastSpans[i];
      if (!inv || !sp) return;
      const px = corners.map((c) => inv.toPage(c.x, c.y)).map(([x, y]) => [(x - r.crop.x0) * s, (y - r.crop.y0) * s]);
      const xs = px.map((p) => p[0]), ys = px.map((p) => p[1]);
      const mx = (Math.max(...xs) - Math.min(...xs)) * 0.15, my = (Math.max(...ys) - Math.min(...ys)) * 0.15;
      const snapDown = (v) => Math.floor(v / DETAIL_GRID) * DETAIL_GRID, snapUp = (v) => Math.ceil(v / DETAIL_GRID) * DETAIL_GRID;
      const x0 = Math.max(sp.p0, snapDown(Math.min(...xs) - mx)), x1 = Math.min(sp.p1, snapUp(Math.max(...xs) + mx));
      const y0 = Math.max(0, snapDown(Math.min(...ys) - my)), y1 = Math.min(r.H, snapUp(Math.max(...ys) + my));
      if (x1 - x0 < 2 || y1 - y0 < 2) return;
      // image pixels per render pixel for one image pixel per device pixel, never finer than the PDF has
      const ftPerRenderPx = Math.sqrt(Math.abs(piece.Tp.a * piece.Tp.e - piece.Tp.b * piece.Tp.d)) / s;
      let k = Math.min(kMax, ftPerRenderPx / ftPerDevicePx);
      const coarseK = Math.min(1, PLAN.MAX_DIM / Math.max(sp.p1 - sp.p0, r.H));
      if (k <= coarseK * 1.25) return; // the coarse image is already about as sharp here
      k = Math.min(k, PLAN.MAX_DIM / (x1 - x0), PLAN.MAX_DIM / (y1 - y0));
      want.push({ i, x0, x1, y0, y1, k, pdf: k > 1.1 });
    });
    // keep a part that still covers what is wanted at a resolution within 20% (or finer); make the rest
    const keep = [], make = [];
    for (const w of want) {
      const old = detail.find((d) => d.i === w.i && d.x0 <= w.x0 && d.x1 >= w.x1 && d.y0 <= w.y0 && d.y1 >= w.y1 && d.k >= w.k * 0.8 && d.k <= w.k * 1.6 && d.key === key);
      (old ? keep : make).push(old ?? w);
    }
    const drop = detail.filter((d) => !keep.includes(d));
    if (drop.length) overlay.source.elements.removeMany(drop.map((d) => d.el));
    drop.forEach(freeDetail);
    const made = make.map((w) => {
      // the render's own pixels first (at most full size); a part wanting more is then rendered from the PDF
      const kNow = Math.min(w.k, 1);
      const canvas = thickenedCrop({ src: r.canvas, left: w.x0, w: w.x1 - w.x0, top: w.y0, h: w.y1 - w.y0, scale: kNow, P: S.thicken, dpi: r.dpi, makeCanvas });
      return { ...w, kNow, canvas, key, el: new ImageElement({ image: canvas, georeference: georefOf(rectCorners(lastPieces[w.i], w)) }) };
    });
    if (made.length) overlay.source.elements.addMany(made.map((d) => d.el));
    detail = [...keep, ...made];
    for (const d of made) if (d.pdf && ctx.renderRect) sharpen(d);
  }
  // A part rendered from the PDF at k times the render's resolution, with the line weight (its halo rendered as well),
  // swapped in for its cut when done, unless it was dropped or the render changed meanwhile.
  async function sharpen(d) {
    const r = S.raster, s = r.dpi / 72, dpi = r.dpi * d.k;
    const halo = S.thicken ? haloFor(ptToPx(S.thicken.pt, dpi), S.thicken.sharpen) : 0, hPt = (halo * 72) / dpi;
    const rect = { x0: r.crop.x0 + d.x0 / s - hPt, y0: r.crop.y0 + d.y0 / s - hPt, x1: r.crop.x0 + d.x1 / s + hPt, y1: r.crop.y0 + d.y1 / s + hPt };
    d.abort = new AbortController();
    let out;
    try {
      out = await ctx.renderRect(rect, dpi, d.abort.signal);
    } catch (err) {
      if (err?.name !== "AbortError") console.warn("The close-up render failed; the working render is shown.", err);
      return;
    }
    if (d.abort.signal.aborted || !active || !overlay || !detail.includes(d) || S.raster !== r) { out.canvas.width = out.canvas.height = 0; return; }
    let canvas = out.canvas;
    if (S.thicken) {
      canvas = thickenedCrop({ src: out.canvas, left: halo, w: out.W - 2 * halo, top: halo, h: out.H - 2 * halo, P: S.thicken, dpi, makeCanvas });
      out.canvas.width = out.canvas.height = 0;
    }
    const el = new ImageElement({ image: canvas, georeference: georefOf(rectCorners(lastPieces[d.i] ?? lastPieces[0], d)) });
    overlay.source.elements.add(el);
    overlay.source.elements.remove(d.el);
    d.canvas.width = d.canvas.height = 0;
    Object.assign(d, { el, canvas, kNow: d.k, abort: null });
  }
  handles.push(reactiveUtils.watch(() => view.stationary, (still) => { if (still && active) scheduleDetail(); }));

  function zoomToPieces(expand) {
    const rings = shownPieces().map((piece) => { const c = pieceCorners(piece); return [...c, c[0]]; });
    if (rings.length) mapEl.goTo(new Polygon({ rings, spatialReference: workSR }).extent.clone().expand(expand)).catch(() => {});
  }
  // The sheet pane: where a chain is cut, and the road row the line placement uses.
  function syncGuides() {
    const crop = cropNow();
    if (!crop) { ctx.sheet.setGuides(null); return; }
    const cuts = S.solve?.mode === "chain" ? S.solve.chain.pieces.slice(1).map((p) => p.c0 + crop.x0) : [];
    const baseline = S.seedInfo?.source === "line" || tool === "baseline" ? baselineY() : null;
    ctx.sheet.setGuides(cuts.length || baseline !== null ? { cuts, baseline, x0: crop.x0, x1: crop.x1 } : null);
  }

  // The fit is worked out at once (the steps read it); what is drawn from it (the sheet pane, the graphics, the
  // overlay, the guides, the step's panel) at most once per animation frame, however many pointer events come.
  let refreshFrame = 0;
  function refresh() {
    recompute();
    if (refreshFrame) return;
    refreshFrame = requestAnimationFrame(() => {
      refreshFrame = 0;
      syncSheet();
      syncMarkers();
      cancelAnimationFrame(overlayFrame);
      overlayFrame = 0;
      drawOverlay();
      syncGuides();
      updateSuggestion();
      ctx.changed("points");
    });
  }

  // ---- the predicted next corner (the dashed ring)
  function updateSuggestion(pan = false) {
    suggest = null;
    const A = S.analysis;
    const pieces = shownPieces();
    ctx.sheet.setGhost(null);
    if (pieces.length && pending.plan) {
      const piece = pieces.length > 1 ? pieceAtPage(pieces, cropNow(), pending.plan.x) : pieces[0];
      suggest = suggestMapPoint({ T: piece.Tp, x: pending.plan.x, y: pending.plan.y, rms: A?.rms, looRms: A?.looRms, nearest: index.nearest });
      if (pan) {
        const s = view.toScreen(workPoint(suggest.X, suggest.Y));
        if (s.x < 40 || s.y < 40 || s.x > view.width - 40 || s.y > view.height - 40) mapEl.goTo(workPoint(suggest.X, suggest.Y)).catch(() => {});
      }
    } else if (pieces.length && pending.map) {
      const q = pageOf(pending.map.X, pending.map.Y);
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
  // Enter: take the dashed ring, if it sits on a corner (or vertex) to snap to.
  function acceptSuggestion() {
    if (!pending.plan) return false;
    if (!suggest?.snapped) { ctx.say(`No ${snapNoun} near the predicted spot. Click the map instead.`, "warn"); return true; }
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
      if (!S.model.seed) S.seedInfo = null;
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
    // chain: "Fit pins exactly" (the scale follows the pins) or the stated scale held for every piece
    setChainExact(on) { S.chainExact = !!on; ctx.markDirty(); refresh(); },
    // the line weight (thicken.js settings, or null for off): the preview on the map is made again
    setThicken(P) { S.thicken = P ? { ...P } : null; cropCache.clear(); ctx.markDirty(); syncOverlay(); ctx.changed("thicken"); },
    // sheet pin dragging
    movePin(id, x, y, phase) {
      if (phase === "start") { S.model.push(); sheetDrag = true; return; }
      if (phase === "end") { sheetDrag = false; syncOverlay(); return; }
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
      if (overlay) { overlay.opacity = options.opacity; overlay.visible = options.visible && shownPieces().length > 0; }
      syncMarkers();
    },
    zoomToSheet() { zoomToPieces(1.3); },
  };

  // ---- the rough placement (the seed): by hand, or along the selected line. Only while fewer than two pins are in use:
  // from two on, the solver places the sheet. One pin holds the sheet in place (it can still be turned about that pin).
  let tool = "pins"; // "pins" | "move" | "rotate" | "start" (click the plan's left end on the line) | "baseline" (click the road row on the sheet)
  let handDrag = null;
  const usedPins = () => S.model.points.filter((p) => p.use !== false);
  const perPtNow = () => expectedPerPt(S.scale);
  // The road row on the sheet, in page points (the crop's middle until the user picks one).
  const baselineY = () => { const c = cropNow(); return Number.isFinite(S.baselineRow) ? S.baselineRow : c ? (c.y0 + c.y1) / 2 : null; };
  // Why the sheet can't be placed by hand now: "no-scale", "pins" (two or more in use), or "".
  const handBlocked = () => (!(perPtNow() > 0) ? "no-scale" : usedPins().length >= 2 ? "pins" : "");
  const CURSOR = { pins: "", move: "move", rotate: "grab", start: "crosshair", baseline: "" };
  function setTool(t) {
    if ((t === "move" || t === "rotate") && !S.model.seed) { ctx.say("Put the sheet on the map first: at the map centre or along the line.", "warn"); t = "pins"; }
    if (t === "move" && usedPins().length === 1) { ctx.say("The pin holds the sheet in place. Turn it, drag the pin, or add a second pin.", "warn"); t = "pins"; }
    tool = t;
    if (view.container) view.container.style.cursor = CURSOR[t] ?? "";
    if (t !== "pins") cancelPending();
    syncGuides();
    ctx.changed("tool");
  }
  // A new seed (one undo step) and what it came from.
  function putSeed(Tp, info) {
    S.model.setSeed(Tp);
    if (info) S.seedInfo = info;
    ctx.markDirty();
    refresh();
  }
  const seedNow = () => (S.model.seed ? fromPageT(S.model.seed, cropNow()) : null);
  // The pivot for turning: the one pin's ground spot, else the sheet's centre.
  const pivotNow = () => { const u = usedPins(); if (u.length === 1) return [u[0].X, u[0].Y]; const t = seedNow(); return t ? [t.cx, t.cy] : null; };

  async function placeAlongLine(click) {
    const why = handBlocked();
    if (why) { ctx.say(why === "no-scale" ? seedProblemText({ reason: "no-scale" }) : "The pins place the sheet now. Delete pins to place it along the line again.", "warn"); return; }
    let paths;
    try { paths = await subjectParts(); } catch (err) { if (err?.name !== "AbortError") ctx.say("Couldn't read the selected line.", "bad"); return; }
    const crop = cropNow();
    const res = seedFromLine({
      paths, sheet: cropSheet(crop), fpp: perPtNow(), baselineRow: baselineY() - crop.y0, click, flipped: !!S.seedFlip,
      spacingFt: PLANS.SEED.SAMPLE_SPACING_FT, autoStartTol: PLANS.SEED.AUTO_START_TOL,
    });
    if (!res.ok) {
      if (res.reason === "need-start") { setTool("start"); ctx.say(seedProblemText(res)); }
      else ctx.say(seedProblemText(res), "warn");
      return;
    }
    tool = "pins";
    if (view.container) view.container.style.cursor = "";
    const first = !S.model.seed;
    putSeed(toPageT(res.T, crop), {
      source: "line", flipped: !!S.seedFlip, click, start_xy: res.startXY, autoStart: res.autoStart,
      lineFt: res.lineFt, planFt: res.planFt, missingFt: res.missingFt,
    });
    ctx.changed("tool");
    if (first) zoomToPieces(1.2);
  }

  const seed = {
    get tool() { return tool; },
    setTool,
    get blocked() { return handBlocked(); },
    get placement() { return seedNow(); },
    get shown() { return S.solve?.mode === "seed" && S.solve.T ? fromPageT(S.solve.T, cropNow()) : null; },
    get info() { return S.seedInfo ?? null; },
    get onLine() { return ctx.subject?.kind === "line"; },
    // the whole sheet at the map's centre, at the stated scale (turned as it was, or square to the map)
    atCenter() {
      if (handBlocked()) return;
      const c = toWork(view.center);
      if (!c) return;
      putSeed(seedAt(cropNow(), { cx: c.x, cy: c.y, theta: seedNow()?.theta ?? 0, fpp: perPtNow() }), { source: "manual" });
      zoomToPieces(1.2);
    },
    setXY(cx, cy) {
      const t = seedNow();
      if (!t || handBlocked() || usedPins().length || !Number.isFinite(cx) || !Number.isFinite(cy)) return;
      putSeed(seedAt(cropNow(), { ...t, cx, cy }));
    },
    setRotation(deg) {
      const t = seedNow();
      if (!t || handBlocked() || !Number.isFinite(deg)) return;
      putSeed(rotateSeed(S.model.seed, deg - t.theta, pivotNow()));
    },
    turn(dDeg) {
      if (!S.model.seed || handBlocked()) return;
      putSeed(rotateSeed(S.model.seed, dDeg, pivotNow()));
    },
    alongLine() { placeAlongLine(null); },
    flip() {
      S.seedFlip = !S.seedFlip;
      if (S.seedInfo?.source === "line" && !handBlocked()) placeAlongLine(S.seedInfo.autoStart ? null : S.seedInfo.click);
      else ctx.changed("tool");
    },
    pickBaseline() { setTool("baseline"); ctx.say("Click the road's centerline on the sheet."); },
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
    if (tool === "start") { const g = toWork(event.mapPoint); if (g) placeAlongLine([g.x, g.y]); return; }
    if (tool !== "pins") return; // moving or turning the sheet, or picking the road row on the sheet
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
      // one ring, moved and shown or hidden (not a new graphic on every move)
      const hide = () => { if (hoverRing) hoverRing.visible = false; };
      if (!lastMove || draggingId !== null || altDown || lastMove.native?.altKey || tool !== "pins") return hide();
      const g = toWork(view.toMap({ x: lastMove.x, y: lastMove.y }));
      const hit = g && index.nearest(g.x, g.y, snapToleranceFt(lastMove.x, lastMove.y));
      if (!hit) return hide();
      if (!hoverRing || !markers.graphics.includes(hoverRing)) {
        hoverRing = new Graphic({ symbol: { type: "simple-marker", style: "circle", size: 22, color: [0, 0, 0, 0], outline: { color: BRAND, width: 1 } } });
        markers.add(hoverRing);
      }
      if (hoverRing.geometry?.x !== hit.X || hoverRing.geometry?.y !== hit.Y) hoverRing.geometry = workPoint(hit.X, hit.Y);
      hoverRing.visible = true;
    });
  }));
  let downAt = null; // where the last pointer went down on the map
  handles.push(view.on("pointer-down", (event) => { downAt = { x: event.x, y: event.y }; }));
  // dragging a point's ring on the map moves that point (to a parcel corner if one is near; Alt places it freely)
  handles.push(view.on("drag", (event) => {
    if (!active) return;
    // moving or turning the whole sheet by hand
    if (tool === "move" || tool === "rotate") {
      const g = toWork(view.toMap({ x: event.x, y: event.y }));
      if (event.action === "start") {
        handDrag = null;
        // measured from where the pointer went down: the start event (and its origin) comes a few pixels into the drag
        const o = toWork(view.toMap(downAt ?? { x: event.x, y: event.y }));
        if (!o || !S.model.seed || handBlocked() || (tool === "move" && usedPins().length)) return; // the map pans
        handDrag = { seed0: { ...S.model.seed }, g0: [o.x, o.y], pivot: pivotNow() };
        S.model.push();
      }
      if (!handDrag) return;
      event.stopPropagation();
      if (g) {
        const { seed0, g0, pivot } = handDrag;
        if (tool === "move") S.model.setSeedLive(moveSeed(seed0, g.x - g0[0], g.y - g0[1]));
        else {
          const a0 = Math.atan2(g0[1] - pivot[1], g0[0] - pivot[0]), a1 = Math.atan2(g.y - pivot[1], g.x - pivot[0]);
          S.model.setSeedLive(rotateSeed(seed0, (-(a1 - a0) * 180) / Math.PI, pivot)); // counterclockwise pointer angle -> clockwise turn
        }
        ctx.markDirty();
      }
      if (event.action === "end") handDrag = null;
      refresh();
      return;
    }
    if (tool !== "pins") return;
    if (event.action === "start") {
      const at = downAt ?? event; // the ring under the pointer when it went down, not a few pixels into the drag
      const id = markerAt(at.x, at.y);
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
  ctx.sheet.onPick = (x, y) => {
    if (tool !== "baseline") { if (tool === "pins") pickOnSheet(x, y); return; }
    const c = cropNow();
    S.baselineRow = Math.min(c.y1, Math.max(c.y0, y));
    setTool("pins");
    if (S.seedInfo?.source === "line" && !handBlocked()) placeAlongLine(S.seedInfo.autoStart ? null : S.seedInfo.click);
    else { syncGuides(); ctx.say("Road row set. Place the sheet along the line to use it."); }
  };
  ctx.sheet.onSelect = (id) => edit.select(id);
  ctx.sheet.onHover = () => {};
  ctx.sheet.onMovePoint = (id, x, y, phase) => edit.movePin(id, x, y, phase);

  return {
    problem: null,
    start() {
      active = true;
      tool = "pins";
      ctx.sheet.setMode("pick");
      rebuildIndex();
      refresh();
    },
    stop() {
      active = false;
      handDrag = null;
      tool = "pins";
      if (view.container) view.container.style.cursor = "";
      ctx.sheet.setGuides(null);
      cancelPending();
      drop(hoverRing);
      hoverRing = null;
    },
    destroy() {
      active = false;
      cancelAnimationFrame(overlayFrame);
      if (view.container) view.container.style.cursor = "";
      clearTimeout(indexTimer);
      indexAbort?.abort();
      handles.forEach((hnd) => hnd.remove());
      cancelAnimationFrame(refreshFrame);
      clearTimeout(detailTimer);
      clearDetail();
      mapEl.map.remove(lines);
      mapEl.map.remove(markers);
      mapEl.map.remove(labels);
      lines.destroy();
      markers.destroy();
      labels.destroy();
      if (overlay) { mapEl.map.remove(overlay); overlay.destroy(); }
    },
    refresh, edit, cancelPending, acceptSuggestion, overlay: overlayControls, seed,
    get pending() { return { plan: pending.plan, map: pending.map }; },
    get suggestion() { return suggest; },
    get snapStatus() { return snapStatus; },
    get index() { return index; },
    toWork, workSR, workingWkid: GEOREF.WORKING_WKID,
    // for the harness and the review step: the overlay's current corners in the working CRS (a whole-sheet fit only; a
    // rough placement isn't a fit, and a chain's footprint is its pieces')
    footprint() {
      const T = S.solve?.mode === "fit" ? S.solve.T : null;
      return T && S.raster ? footprintXY(T, S.raster.crop, S.raster.dpi, S.raster.W, S.raster.H) : null;
    },
    // each piece's corners in the working CRS (one for a whole-sheet placement)
    pieceFootprints() { return S.raster ? shownPieces().map((p, i, all) => pieceSpan(p, i === all.length - 1).corners) : []; },
  };
}
