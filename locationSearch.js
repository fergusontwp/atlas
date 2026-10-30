import { HIGHLIGHT, POINT_INFO, SEARCH } from "./config.js";
import { geocodeFailure } from "./pointInfoLogic.js";
import { biasPoint, candidateInState, retryWithoutBias, suggestionInState } from "./locationFilter.js";
import { findParams, suggestParams } from "./geocodeParams.js";
import { outlineSymbols } from "./selectionMode.js";
import { keepNearTop } from "./roadSearch.js";

// Location mode of the search box (search.js addMode): any address or place, through the ArcGIS World Geocoding
// Service (POINT_INFO.GEOCODE.URL, the one geocoder URL in config) with the user's sign-in, as point info does:
// authMode "no-prompt" (a search never starts a sign-in), no API key, forStorage never set, nothing stored.
//
// While typing (after MIN_CHARS and the box's debounce; a newer search aborts the older): suggestLocations. Choosing a
// row: one addressToLocations with that suggestion's magicKey. Results near the township rank first: both requests pass
// the centre of the parcel layer's full extent as `location`, projected once here to WGS84 lon/lat (the layer's own
// coordinates, UTM metres, made the find fail with a 502) and checked by locationFilter.biasPoint; nothing else is
// limited to it, so any place in the state can be found. If a find with it fails without an answer or with a 5xx, it is
// Spatial references sent are only ever { wkid } (geocodeParams.js): results come back in SEARCH.LOCATION.OUT_WKID
// (3857) and are projected to the view here if it isn't Web Mercator; the view's own spatial reference, with the web
// map's storage parameters (falseX, xyUnits, ...), is never sent (it made findAddressCandidates answer 502). A result zooms to its extent, or to its point at LOCATION.SCALE, and is
// asked once more without `location` (the same pick: one result shown, nothing stored). A result zooms to its extent, or to its point at LOCATION.SCALE, and is
// marked: point info opens there (its marker) when it exists, else a ring in location-search-marker.
// Pennsylvania only (SEARCH.LOCATION): both requests carry the state's box as searchExtent and the country code; a
// suggestion naming another state is dropped, and a pick outside the state (its RegionAbbr) says "Outside
// Pennsylvania" in the list instead of zooming (locationFilter.js).
//
// opts: { mapEl, search, parcel, pointInfo }.
export async function setupLocationSearch({ mapEl, search, parcel, pointInfo = null }) {
  const L = SEARCH.LOCATION, URL = POINT_INFO.GEOCODE.URL;
  const [locator, GraphicsLayer, Graphic, Point, SpatialReference, projectOperator] = await $arcgis.import(["@arcgis/core/rest/locator.js",
    "@arcgis/core/layers/GraphicsLayer.js", "@arcgis/core/Graphic.js", "@arcgis/core/geometry/Point.js",
    "@arcgis/core/geometry/SpatialReference.js", "@arcgis/core/geometry/operators/projectOperator.js"]);
  // the ranking point: the extent centre in WGS84, once
  let near = null;
  const centre = parcel?.fullExtent?.center ?? null;
  if (centre) {
    try {
      if (!projectOperator.isLoaded()) await projectOperator.load();
      const p = biasPoint(projectOperator.execute(centre, SpatialReference.WGS84), L);
      if (p) near = new Point({ x: p.x, y: p.y, spatialReference: SpatialReference.WGS84 });
    } catch (err) {
      console.warn("Location search: the parcel layer's extent centre couldn't be projected to WGS84:", err?.message ?? err);
    }
  }
  if (!near) console.warn("Location search: no ranking point (the parcel layer's extent centre isn't a lon/lat in Pennsylvania), so results aren't ranked by the township.");

  let layer = null; // only without point info
  if (!pointInfo) {
    layer = new GraphicsLayer({ id: SEARCH.LOCATION_MARKER_LAYER_ID, title: "Location search", listMode: "hide", popupEnabled: false });
    mapEl.map.add(layer);
    keepNearTop(mapEl.map, layer, ["point-info-marker"]);
  }
  const options = (signal) => ({ signal, authMode: "no-prompt" });
  const REASONS = { timeout: "timed out", signin: "not signed in", error: "the geocoder didn't answer", none: "nothing found" };
  const failed = (err) => ({ rows: [], error: true, note: `${L.TEXT.FAILED}: ${REASONS[geocodeFailure(err)] ?? REASONS.error}` });
  const state = { requests: { suggest: 0, find: 0, retries: 0 }, chosen: null };

  async function suggest(text, signal) {
    let suggestions;
    try {
      state.requests.suggest++;
      suggestions = await locator.suggestLocations(URL, suggestParams({ text, location: near }, L), options(signal));
    } catch (err) {
      if (err?.name === "AbortError" || signal.aborted) throw err;
      console.warn("Location search: suggestions failed:", err);
      return failed(err);
    }
    const rows = suggestions.filter((s) => s.text && s.magicKey && suggestionInState(s.text, L.STATE_ABBR)).map((s) => ({ main: s.text, magicKey: s.magicKey }));
    return rows.length ? { rows } : { rows: [], note: L.TEXT.NO_MATCH };
  }

  let infoAt = null; // the point info card this mode opened (its coordinates), closed with the marker
    // a result (in OUT_WKID) in the view's spatial reference: as it is when both are Web Mercator, else projected
  async function toView(geometry) {
    const viewSr = mapEl.view.spatialReference, sr = geometry?.spatialReference;
    if (!geometry || !sr || sr.equals(viewSr) || (sr.isWebMercator && viewSr.isWebMercator)) return geometry;
    if (!projectOperator.isLoaded()) await projectOperator.load();
    return projectOperator.execute(geometry, viewSr) ?? geometry;
  }
  async function choose(row) {
    state.requests.find++; // one pick, even if it is asked twice
    // the retry is a different request (no location; outSR is clean in both), never the same one again
    const find = (location) => locator.addressToLocations(URL, findParams({ text: row.main, magicKey: row.magicKey, location }, L), options());
        let found;
    try {
      found = await find(near);
    } catch (err) {
      if (!near || !retryWithoutBias(err)) throw err;
      // not err.message: the SDK puts the request URL, token included, in it
      console.warn(`Location search: the find failed with the ranking point (${err?.details?.httpStatus || "no answer"}); asking once more without it.`);
      state.requests.retries++;
      found = await find(null);
    }
    const [candidate] = found;
    if (!candidate?.location) throw new Error(L.TEXT.NO_MATCH);
    if (!candidateInState(candidate, L.STATE_ABBR)) return { note: L.TEXT.OUTSIDE }; // shown in the list; no zoom, no marker
    state.chosen = candidate.address ?? row.main;
    const point = await toView(candidate.location), extent = candidate.extent ? await toView(candidate.extent) : null;
    if (extent) await mapEl.view.goTo(extent);
    else await mapEl.view.goTo({ target: point, scale: L.SCALE });
    if (pointInfo) {
      pointInfo.open(point);
      infoAt = pointInfo.state.latlon;
    } else {
      // a marker: its own color, not the highlight color
      layer.addMany(outlineSymbols("point", { color: HIGHLIGHT.DEFAULT_COLOR, outline: HIGHLIGHT.OUTLINE }).map((symbol) => new Graphic({ geometry: point, symbol })));
    }
  }

  function clear() {
    layer?.removeAll();
    if (infoAt && pointInfo?.state.open && pointInfo.state.latlon === infoAt) pointInfo.close();
    infoAt = null;
    state.chosen = null;
  }

  search.addMode("location", { suggest, choose, clear });
  return { clear, layer, near, get state() { return JSON.parse(JSON.stringify(state)); } };
}
