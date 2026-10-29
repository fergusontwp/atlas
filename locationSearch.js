import { HIGHLIGHT, POINT_INFO, SEARCH } from "./config.js";
import { geocodeFailure } from "./pointInfoLogic.js";
import { candidateInState, suggestionInState } from "./locationFilter.js";
import { outlineSymbols } from "./selectionMode.js";
import { keepNearTop } from "./roadSearch.js";

// Location mode of the search box (search.js addMode): any address or place, through the ArcGIS World Geocoding
// Service (POINT_INFO.GEOCODE.URL, the one geocoder URL in config) with the user's sign-in, as point info does:
// authMode "no-prompt" (a search never starts a sign-in), no API key, forStorage never set, nothing stored.
//
// While typing (after MIN_CHARS and the box's debounce; a newer search aborts the older): suggestLocations. Choosing a
// row: one addressToLocations with that suggestion's magicKey. Results near the township rank first: both requests pass
// the centre of the parcel layer's full extent as `location` (read once here); nothing is limited to it (no
// searchExtent), so any place can be found. A result zooms to its extent, or to its point at LOCATION.SCALE, and is
// marked: point info opens there (its marker) when it exists, else a ring in location-search-marker.
// Pennsylvania only (SEARCH.LOCATION): both requests carry the state's box as searchExtent and the country code; a
// suggestion naming another state is dropped, and a pick outside the state (its RegionAbbr) says "Outside
// Pennsylvania" in the list instead of zooming (locationFilter.js).
//
// opts: { mapEl, search, parcel, pointInfo }.
export async function setupLocationSearch({ mapEl, search, parcel, pointInfo = null }) {
  const L = SEARCH.LOCATION, URL = POINT_INFO.GEOCODE.URL;
  const [locator, GraphicsLayer, Graphic, Extent] = await $arcgis.import(["@arcgis/core/rest/locator.js", "@arcgis/core/layers/GraphicsLayer.js", "@arcgis/core/Graphic.js", "@arcgis/core/geometry/Extent.js"]);
  const stateBox = new Extent({ ...L.STATE_EXTENT, spatialReference: { wkid: 4326 } });
  const limits = { searchExtent: stateBox, countryCode: L.COUNTRY_CODE };
  const near = parcel?.fullExtent?.center ?? null;
  if (!near) console.warn("Location search: the parcel layer's extent isn't available, so results aren't ranked by the township.");

  let layer = null; // only without point info
  if (!pointInfo) {
    layer = new GraphicsLayer({ id: SEARCH.LOCATION_MARKER_LAYER_ID, title: "Location search", listMode: "hide", popupEnabled: false });
    mapEl.map.add(layer);
    keepNearTop(mapEl.map, layer, ["point-info-marker"]);
  }
  const options = (signal) => ({ signal, authMode: "no-prompt" });
  const REASONS = { timeout: "timed out", signin: "not signed in", error: "the geocoder didn't answer", none: "nothing found" };
  const failed = (err) => ({ rows: [], error: true, note: `${L.TEXT.FAILED}: ${REASONS[geocodeFailure(err)] ?? REASONS.error}` });
  const state = { requests: { suggest: 0, find: 0 }, chosen: null };

  async function suggest(text, signal) {
    let suggestions;
    try {
      state.requests.suggest++;
      suggestions = await locator.suggestLocations(URL, { text, location: near, maxSuggestions: L.MAX_SUGGESTIONS, ...limits }, options(signal));
    } catch (err) {
      if (err?.name === "AbortError" || signal.aborted) throw err;
      console.warn("Location search: suggestions failed:", err);
      return failed(err);
    }
    const rows = suggestions.filter((s) => s.text && s.magicKey && suggestionInState(s.text, L.STATE_ABBR)).map((s) => ({ main: s.text, magicKey: s.magicKey }));
    return rows.length ? { rows } : { rows: [], note: L.TEXT.NO_MATCH };
  }

  let infoAt = null; // the point info card this mode opened (its coordinates), closed with the marker
  async function choose(row) {
    state.requests.find++;
    const [candidate] = await locator.addressToLocations(URL, {
      address: { SingleLine: row.main }, magicKey: row.magicKey, location: near, maxLocations: 1, ...limits,
      outFields: L.OUT_FIELDS, outSpatialReference: mapEl.view.spatialReference,
    }, options());
    if (!candidate?.location) throw new Error(L.TEXT.NO_MATCH);
    if (!candidateInState(candidate, L.STATE_ABBR)) return { note: L.TEXT.OUTSIDE }; // shown in the list; no zoom, no marker
    state.chosen = candidate.address ?? row.main;
    const point = candidate.location;
    if (candidate.extent) await mapEl.view.goTo(candidate.extent);
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
