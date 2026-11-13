// The parameters of the geocoder requests (locationSearch.js, pointInfo.js): pure, tested. Spatial references in them are
// only ever { wkid }: a view's spatial reference read from the web map also carries storage parameters (falseX, falseY,
// xyUnits, xyTolerance, ...), which the SDK writes into outSR and into a point's JSON, and the World Geocoding Service
// answered findAddressCandidates with a 502 when outSR had them.

// { wkid } of a spatial reference (its wkid, else its latestWkid), or null when it has neither.
export function cleanSpatialReference(sr) {
  const wkid = Number(sr?.wkid ?? sr?.latestWkid);
  return Number.isInteger(wkid) && wkid > 0 ? { wkid } : null;
}

// A point as { x, y, spatialReference: { wkid } }, or null (no finite x / y, or no wkid).
export function cleanPoint(point) {
  const x = Number(point?.x), y = Number(point?.y), spatialReference = cleanSpatialReference(point?.spatialReference);
  return Number.isFinite(x) && Number.isFinite(y) && spatialReference ? { x, y, spatialReference } : null;
}

// The state's box and country (SEARCH.LOCATION), for both Location requests.
const limits = (cfg) => ({ searchExtent: { ...cfg.STATE_EXTENT, spatialReference: { wkid: 4326 } }, countryCode: cfg.COUNTRY_CODE });

// suggestLocations: the typed text, the ranking point when there is one. cfg: SEARCH.LOCATION.
export function suggestParams({ text, location = null }, cfg) {
  const p = cleanPoint(location);
  return { text, ...(p ? { location: p } : {}), maxSuggestions: cfg.MAX_SUGGESTIONS, ...limits(cfg) };
}

// addressToLocations for a picked suggestion: its text and magicKey, the ranking point when there is one, one result,
// the region fields, and outSR exactly { wkid: cfg.OUT_WKID }. The retry is the same call with location null.
export function findParams({ text, magicKey, location = null }, cfg) {
  const p = cleanPoint(location);
  return { address: { SingleLine: text }, magicKey, ...(p ? { location: p } : {}), maxLocations: 1, ...limits(cfg),
    outFields: cfg.OUT_FIELDS, outSpatialReference: { wkid: cfg.OUT_WKID } };
}

// locationToAddress (point info): the clicked point with a clean spatial reference; no outSR (the answer comes in WGS84).
export function reverseParams(point) {
  const p = cleanPoint(point);
  return p ? { location: p } : null;
}
