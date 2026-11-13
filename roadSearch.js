import { GEOREF, HIGHLIGHT, SEARCH } from "./config.js";
import { matchStreets, meetingPoints, segmentWhere, splitIntersection, streetsFromRows } from "./roadSearchLogic.js";
import { outlineSymbols } from "./selectionMode.js";
import { highlightColor } from "./highlightColor.js";

// Road mode of the search box (search.js addMode): street names from the road layer, matched in the browser
// (roadSearchLogic.js), no geocoder. The layer is SEARCH.ROAD.LAYER_TITLE, or, while that is null, the one line layer that
// has all of NAME_FIELDS (the console says which, and lists the others). No such layer, or a field missing: no Road mode
// (its item stays hidden) and one warning.
//
// Names: on first use, one statistics query (a count per distinct combination of the name fields, the layer's own
// expression applied, no geometry), kept in memory; without statistics, distinct values (no counts). A street is
// queried by an exact match on its parts (segmentWhere), never on the joined name.
//
// Choosing a street outlines all its segments in a list-hidden graphics layer (road-search-outline, no popup, so a click
// on a segment still selects it as before) and zooms to them; nothing is selected in the panel.
//
// Intersections ("College Ave & Atherton", also @ / and at): computed from the road layer only once both parts are
// typed. The best INTERSECTION_CANDIDATES streets for each part are paired; each street's segments are read once
// (cached) and projected to 2271 feet, and roadSearchLogic.meetingPoints finds where each pair meets (within
// INTERSECTION_TOL_FT, or crossing). One row per meeting point ("1 of 2" when a pair meets more than once). Choosing
// one outlines both streets, zooms to the point at INTERSECTION_SCALE and opens point info there (its marker marks the
// point; without point info a ring in the outline layer does).
//
// opts: { mapEl, search, pointInfo }. Returns { clear, layer, state } or null.
export async function setupRoadSearch({ mapEl, search, pointInfo = null }) {
  const R = SEARCH.ROAD, T = R.TEXT;
  const map = mapEl.map;
  const lines = map.allLayers.toArray().filter((l) => l.type === "feature" && l.geometryType === "polyline");
  const fieldOf = (layer, name) => layer.fields?.find((f) => f.name.toLowerCase() === name.toLowerCase())?.name;
  const hasNames = (layer) => R.NAME_FIELDS.every((n) => fieldOf(layer, n));
  let road;
  if (R.LAYER_TITLE) {
    road = map.allLayers.find((l) => l.title === R.LAYER_TITLE);
    if (!road) { console.warn(`SEARCH.ROAD.LAYER_TITLE: no layer titled "${R.LAYER_TITLE}"; Road search is off.`); return null; }
    if (!hasNames(road)) { console.warn(`SEARCH.ROAD.NAME_FIELDS: "${road.title}" lacks ${R.NAME_FIELDS.filter((n) => !fieldOf(road, n)).join(", ")}; Road search is off.`); return null; }
  } else {
    const candidates = lines.filter(hasNames);
    console.info(`Road search: line layers in the web map: ${lines.map((l) => `"${l.title}"${hasNames(l) ? " (has the name fields)" : ""}`).join(", ") || "none"}.`);
    if (!candidates.length) { console.warn(`Road search is off: no line layer has ${R.NAME_FIELDS.join(", ")}. Set SEARCH.ROAD.LAYER_TITLE.`); return null; }
    road = candidates[0];
    console.info(`Road search uses "${road.title}"${candidates.length > 1 ? ` (the first of ${candidates.length})` : ""}. Set SEARCH.ROAD.LAYER_TITLE to confirm it.`);
  }
  const fields = R.NAME_FIELDS.map((n) => fieldOf(road, n));
  const own = () => road.definitionExpression || null; // the web map's expression on the road layer
  const withOwn = (w) => (own() ? `(${own()}) AND (${w})` : w);

  const [GraphicsLayer, Graphic, Point, SpatialReference, projectOperator] = await $arcgis.import(["@arcgis/core/layers/GraphicsLayer.js",
    "@arcgis/core/Graphic.js", "@arcgis/core/geometry/Point.js", "@arcgis/core/geometry/SpatialReference.js", "@arcgis/core/geometry/operators/projectOperator.js"]);
  const feet = new SpatialReference({ wkid: GEOREF.WORKING_WKID });
  const layer = new GraphicsLayer({ id: SEARCH.ROAD_OUTLINE_LAYER_ID, title: "Road search", listMode: "hide", popupEnabled: false });
  map.add(layer);
  keepNearTop(map, layer, [SEARCH.LOCATION_MARKER_LAYER_ID, "point-info-marker"]);

  // ---- street names, once
  let names = null;
  function loadNames() {
    names ??= (async () => {
      let rows;
      try {
        const { features } = await road.queryFeatures({
          where: own() ?? "1=1", returnGeometry: false, groupByFieldsForStatistics: fields,
          outStatistics: [{ statisticType: "count", onStatisticField: road.objectIdField, outStatisticFieldName: "seg_count" }],
        });
        rows = features.map((f) => ({ parts: fields.map((n) => f.attributes[n] ?? attr(f.attributes, n)), count: Number(attr(f.attributes, "seg_count")) }));
      } catch (err) {
        console.warn("Road search: counting segments per street failed; reading names without counts:", err);
        const { features } = await road.queryFeatures({ where: own() ?? "1=1", returnGeometry: false, returnDistinctValues: true, outFields: fields });
        rows = features.map((f) => ({ parts: fields.map((n) => f.attributes[n]), count: NaN }));
      }
      const streets = streetsFromRows(rows);
      if (rows.every((r) => !Number.isFinite(r.count))) streets.forEach((s) => (s.count = null));
      return streets;
    })();
    names.catch(() => (names = null)); // asked again next time
    return names;
  }
  const attr = (a, name) => a[Object.keys(a).find((k) => k.toLowerCase() === name.toLowerCase())];

  // ---- the mode
  async function suggest(text, signal) {
    const parts = splitIntersection(text);
    if (parts.length > 2) return { rows: [], note: T.TWO_STREETS };
    let streets;
    try {
      streets = await loadNames();
    } catch (err) {
      console.warn("Road search: the street names couldn't be read:", err);
      return { rows: [], error: true, note: `${T.FAILED}: ${err?.message ?? err}` };
    }
    signal.throwIfAborted();
    if (parts.length === 2 && parts[1]) return intersections(streets, parts, signal);
    const hits = matchStreets(streets, parts[0], R.ABBREVIATIONS, R.MAX_RESULTS);
    if (!hits.length) return { rows: [], note: T.NO_MATCH };
    return { rows: hits.map((s) => ({ main: s.name, tag: s.count === null ? null : T.SEGMENTS(s.count), street: s })) };
  }

  // A street's segments at full precision in the view's spatial reference (or another).
  async function segments(street, outSpatialReference = mapEl.view.spatialReference) {
    const { features, exceededTransferLimit } = await road.queryFeatures({
      where: withOwn(segmentWhere(fields, street.combos)), returnGeometry: true, outFields: [road.objectIdField], outSpatialReference,
    });
    if (exceededTransferLimit) console.warn(`Road search: "${street.name}" has more segments than one query returns; some aren't outlined.`);
    return features.map((f) => f.geometry).filter(Boolean);
  }

  // ---- intersections
  const lineCache = new Map(); // street name -> its segments as [[x, y], ...] paths in feet
  function linesInFeet(street) {
    if (!lineCache.has(street.name)) {
      const p = (async () => {
        const geometries = await segments(street);
        if (!projectOperator.isLoaded()) await projectOperator.load();
        return geometries.map((g) => projectOperator.execute(g, feet)?.paths ?? []);
      })();
      p.catch(() => lineCache.delete(street.name));
      lineCache.set(street.name, p);
    }
    return lineCache.get(street.name);
  }
  async function intersections(streets, [first, second], signal) {
    const n = R.INTERSECTION_CANDIDATES;
    const as = matchStreets(streets, first, R.ABBREVIATIONS, n), bs = matchStreets(streets, second, R.ABBREVIATIONS, n);
    const pairs = as.flatMap((a) => bs.filter((b) => b.name !== a.name).map((b) => [a, b]));
    if (!pairs.length) return { rows: [], note: T.NO_INTERSECTION };
    const lines = new Map(await Promise.all([...new Set(pairs.flat())].map(async (s) => [s.name, await linesInFeet(s)])));
    signal.throwIfAborted();
    const rows = [];
    for (const [a, b] of pairs) {
      const points = meetingPoints(lines.get(a.name), lines.get(b.name), { tolFt: R.INTERSECTION_TOL_FT, mergeFt: R.INTERSECTION_MERGE_FT });
      points.forEach(([x, y], i) => rows.push({ main: `${a.name} & ${b.name}`, tag: points.length > 1 ? T.OF(i + 1, points.length) : null, streets: [a, b], at: [x, y] }));
    }
    return rows.length ? { rows: rows.slice(0, R.MAX_RESULTS) } : { rows: [], note: T.NO_INTERSECTION };
  }

  let infoAt = null; // the point info card this mode opened (its coordinates), closed with the outline
  async function chooseIntersection(row) {
    const [a, b] = await Promise.all(row.streets.map((s) => segments(s)));
    if (!projectOperator.isLoaded()) await projectOperator.load();
    const point = projectOperator.execute(new Point({ x: row.at[0], y: row.at[1], spatialReference: feet }), mapEl.view.spatialReference);
    outline([...a, ...b]);
    // without point info, a ring marks the point (a marker: its own color, not the highlight color)
    if (!pointInfo) layer.addMany(outlineSymbols("point", { color: HIGHLIGHT.DEFAULT_COLOR, outline: HIGHLIGHT.OUTLINE }).map((symbol) => new Graphic({ geometry: point, symbol })));
    await mapEl.view.goTo({ target: point, scale: R.INTERSECTION_SCALE });
    if (pointInfo) {
      pointInfo.open(point);
      infoAt = pointInfo.state.latlon;
    }
  }

  // the street lines in the highlight color (rebuilt when it changes); an intersection's ring marker is left as it is
  function outline(geometries) {
    layer.removeAll();
    drawLines(geometries);
  }
  function drawLines(geometries) {
    for (const geometry of geometries) {
      layer.addMany(outlineSymbols("polyline", { color: highlightColor.get(), outline: HIGHLIGHT.OUTLINE }).map((symbol) => new Graphic({ geometry, symbol, attributes: { kind: "line" } })));
    }
  }
  highlightColor.onChange(() => {
    const old = layer.graphics.filter((g) => g.attributes?.kind === "line").toArray();
    if (!old.length) return;
    drawLines([...new Set(old.map((g) => g.geometry))]);
    layer.removeMany(old);
  });

  async function chooseStreet(street) {
    const geometries = await segments(street);
    if (!geometries.length) throw new Error(`No segments found for ${street.name}.`);
    outline(geometries);
    const extent = geometries.reduce((e, g) => (e ? e.union(g.extent) : g.extent.clone()), null);
    await mapEl.view.goTo(extent.expand(R.ZOOM_EXPAND));
  }

  const state = { layer: road.title, streets: null, chosen: null };
  search.addMode("road", {
    suggest,
    async choose(row) {
      state.chosen = row.main;
      if (row.street) await chooseStreet(row.street);
      else if (row.streets) await chooseIntersection(row);
    },
    clear() {
      layer.removeAll();
      state.chosen = null;
      if (infoAt && pointInfo?.state.open && pointInfo.state.latlon === infoAt) pointInfo.close();
      infoAt = null;
    },
  });

  return {
    layer, road,
    clear: () => layer.removeAll(),
    get state() { return { ...state, streets: names ? "loaded" : "not loaded", outlined: layer.graphics.length }; },
  };
}

// Keep a search layer at the top of the draw order, directly under the nearest of `aboveIds` that is on the map (the
// point info marker, the location marker), else last. Each layer only places itself under one above it, so the layers
// that do this never trade places.
export function keepNearTop(map, layer, aboveIds) {
  const place = () => {
    const at = map.layers.indexOf(layer);
    if (at < 0) return;
    const anchor = aboveIds.map((id) => map.layers.findIndex((l) => l.id === id)).find((i) => i >= 0) ?? -1;
    const want = anchor < 0 ? map.layers.length - 1 : at < anchor ? anchor - 1 : anchor;
    if (at !== want) map.reorder(layer, want);
  };
  map.layers.on("change", place);
  place();
}
