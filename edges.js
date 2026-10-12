import { LABELS } from "./config.js";
import { emptyBreaks, labelEdges, planEdges } from "./edgeLabels.js";

const REBUILD_DELAY_MS = 250;

// Edge length overlay: a text graphic at the middle of every parcel edge, in feet, rotated along the edge.
// It is a separate GraphicsLayer (a parcel label can't follow an edge). Lengths are planar in the layer's own
// spatial reference (UTM 17N, meters); positions and angles use the vertices projected into the view's.
// style() supplies the shared text look (font, color, halo) from the parcel label settings.
export async function setupEdges(mapEl, parcel, panel, { style, onStatus = () => {} }) {
  const [GraphicsLayer, Graphic, Point, Multipoint, projectOperator, reactiveUtils] = await $arcgis.import([
    "@arcgis/core/layers/GraphicsLayer.js",
    "@arcgis/core/Graphic.js",
    "@arcgis/core/geometry/Point.js",
    "@arcgis/core/geometry/Multipoint.js",
    "@arcgis/core/geometry/operators/projectOperator.js",
    "@arcgis/core/core/reactiveUtils.js",
  ]);
  const view = mapEl.view;
  const { EDGES } = LABELS;
  const state = { on: false, scope: "view", decimals: EDGES.DECIMALS, fontSize: EDGES.FONT_SIZE, status: "" };
  let breaks = emptyBreaks(); // breaks between curve runs by reason, from the last rebuild (for tuning EDGES.CURVE)

  const layer = new GraphicsLayer({ id: "edge-lengths", title: "Edge lengths", listMode: "hide", visible: false });
  mapEl.map.add(layer);

  const setStatus = (text) => {
    state.status = text;
    onStatus(text);
  };
  // Counts always pass an explicit where, like the filter does.
  const where = () => (parcel.definitionExpression && String(parcel.definitionExpression).trim() ? parcel.definitionExpression : "1=1");

  let sequence = 0;
  let inflight = null;
  let timer;

  function clearGraphics() {
    layer.graphics.removeAll();
    breaks = emptyBreaks();
  }

  async function rebuild() {
    const request = ++sequence;
    inflight?.abort();
    const controller = (inflight = new AbortController());
    const stale = () => request !== sequence;

    if (!state.on) {
      layer.visible = false;
      clearGraphics();
      setStatus("");
      return;
    }
    layer.visible = parcel.visible;
    if (!parcel.visible) {
      clearGraphics();
      setStatus("The parcel layer is hidden.");
      return;
    }
    if (view.scale > EDGES.MIN_SCALE) {
      clearGraphics();
      setStatus(`Zoom in to 1:${EDGES.MIN_SCALE.toLocaleString()} to see edge lengths.`);
      return;
    }

    try {
      const base = { where: where(), signal: controller.signal };
      let query;
      if (state.scope === "selected") {
        const oid = panel.selectedObjectId();
        if (oid === null || oid === undefined) {
          clearGraphics();
          setStatus("Select a parcel to see its edge lengths.");
          return;
        }
        query = { ...base, objectIds: [oid] };
      } else {
        query = { ...base, geometry: view.extent, spatialRelationship: "intersects" };
      }

      const parcels = await parcel.queryFeatureCount(query, { signal: controller.signal });
      if (stale()) return;
      if (parcels > EDGES.MAX_PARCELS) {
        clearGraphics();
        setStatus(`Too many parcels in view (${parcels.toLocaleString()}, max ${EDGES.MAX_PARCELS.toLocaleString()}). Zoom in.`);
        return;
      }
      // Full, ungeneralized geometry from the layer itself (no maxAllowableOffset, no layer-view query).
      const result = await parcel.queryFeatures(
        { ...query, returnGeometry: true, outFields: [], num: EDGES.MAX_PARCELS, outSpatialReference: parcel.spatialReference },
        { signal: controller.signal },
      );
      if (stale()) return;

      const polygons = result.features.map((f) => f.geometry?.rings ?? []);

      // Curve detection also looks at the parcels around the selected one (their vertices tell where a lot line meets
      // a curve); they are not labeled. With all parcels in view they are among the queried parcels already.
      let neighbors = [];
      if (EDGES.CURVE.ENABLED && EDGES.CURVE.JUNCTIONS && state.scope === "selected" && result.features[0]?.geometry) {
        try {
          const oidField = parcel.objectIdField;
          const around = await parcel.queryFeatures(
            { where: where(), geometry: result.features[0].geometry, spatialRelationship: "intersects", returnGeometry: true, outFields: [oidField], num: EDGES.MAX_PARCELS, outSpatialReference: parcel.spatialReference },
            { signal: controller.signal },
          );
          if (stale()) return;
          neighbors = around.features.filter((f) => f.attributes?.[oidField] !== query.objectIds[0]).map((f) => f.geometry?.rings ?? []);
        } catch (err) {
          if (stale() || err?.name === "AbortError") return;
          console.warn("Couldn't load the parcels around the selected one; curves are found without them:", err);
        }
      }

      // Which segments make which labels (curves are merged), from the layer's own coordinates.
      const plan = planEdges(polygons, { neighbors, unit: EDGES.UNIT, curve: EDGES.CURVE });
      if (plan.count > EDGES.MAX_EDGES) {
        clearGraphics();
        setStatus(`Too many edges (${plan.count.toLocaleString()}, max ${EDGES.MAX_EDGES.toLocaleString()}). Zoom in.`);
        return;
      }

      // Project every vertex into the view's spatial reference in one call (same count and order).
      const layerSr = parcel.spatialReference;
      const viewSr = view.spatialReference;
      let viewPolygons = polygons;
      if (!layerSr.equals(viewSr)) {
        if (!projectOperator.isLoaded()) await projectOperator.load();
        if (stale()) return;
        const flat = polygons.flatMap((rings) => rings.flat());
        const projected = flat.length ? projectOperator.execute(new Multipoint({ points: flat, spatialReference: layerSr }), viewSr)?.points : [];
        if (!projected || projected.length !== flat.length) throw new Error(`Couldn't project the parcel vertices into the map's coordinate system. (${flat.length} in, ${projected?.length} out)`);
        let k = 0;
        viewPolygons = polygons.map((rings) => rings.map((ring) => ring.map(() => projected[k++])));
      }

      const look = style();
      const graphics = [];
      // A boundary shared by two parcels would otherwise draw its label twice, on top of itself.
      const labelsOut = labelEdges(plan, {
        unit: EDGES.UNIT,
        decimals: state.decimals,
        viewPolygons,
        unitsPerPixel: view.resolution,
        minEdgePx: EDGES.MIN_EDGE_PX,
        rotationDeg: view.rotation || 0,
      });
      for (const e of labelsOut) {
        graphics.push(new Graphic({
          geometry: new Point({ x: e.x, y: e.y, spatialReference: viewSr }),
          symbol: {
            type: "text", text: e.text, angle: e.angleDeg, color: look.color,
            haloColor: look.haloSize > 0 ? look.haloColor : undefined, haloSize: look.haloSize,
            font: { family: look.family, size: state.fontSize, weight: look.bold ? "bold" : "normal", style: look.italic ? "italic" : "normal" },
          },
        }));
      }
      if (stale()) return;
      layer.graphics.removeAll();
      layer.graphics.addMany(graphics);
      breaks = plan.breaks;
      const n = graphics.length;
      setStatus(`Showing ${n.toLocaleString()} edge${n === 1 ? "" : "s"} on ${result.features.length.toLocaleString()} parcel${result.features.length === 1 ? "" : "s"}`);
    } catch (err) {
      if (stale() || err?.name === "AbortError") return;
      console.warn("Couldn't build the edge length labels:", err);
      clearGraphics();
      setStatus("Couldn't load edge lengths.");
    }
  }

  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(rebuild, REBUILD_DELAY_MS);
  };

  // Rebuild when the view settles, the filter or selection changes, or the parcel layer is shown or hidden.
  reactiveUtils.watch(() => view.stationary, (stationary) => stationary && state.on && schedule());
  reactiveUtils.watch(() => parcel.definitionExpression, () => state.on && schedule());
  reactiveUtils.watch(() => parcel.visible, () => state.on && schedule());
  panel.onSelectionChange(() => state.on && state.scope === "selected" && schedule());

  return {
    on() {
      state.on = true;
      schedule();
    },
    off() {
      state.on = false;
      schedule();
    },
    set(partial) {
      Object.assign(state, partial);
      schedule();
    },
    refresh: schedule,
    now: rebuild,
    layer,
    get state() {
      return { ...state, graphics: layer.graphics.length, breaks: { ...breaks } };
    },
  };
}
