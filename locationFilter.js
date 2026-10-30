// Location search (locationSearch.js): which results are in the state (Pennsylvania). Pure, tested; no DOM, no SDK.

// US states, territories and DC: abbreviation -> name.
const STATES = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado", CT: "Connecticut", DE: "Delaware",
  DC: "District of Columbia", FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa",
  KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan", MN: "Minnesota",
  MS: "Mississippi", MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey",
  NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon",
  PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah",
  VT: "Vermont", VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming", PR: "Puerto Rico",
};
const BY_NAME = Object.fromEntries(Object.entries(STATES).map(([abbr, name]) => [name.toUpperCase(), abbr]));

// The state a label names, as its abbreviation, or null: the last comma-separated part that is a state's abbreviation or
// full name ("Columbus, OH, USA" -> OH; "Washington, PA, USA" -> PA; "Main St, State College, Pennsylvania" -> PA).
export function stateOf(text) {
  const parts = String(text ?? "").split(",").map((p) => p.trim().toUpperCase()).filter(Boolean);
  for (let i = parts.length - 1; i >= 0; i--) {
    if (STATES[parts[i]]) return parts[i];
    if (BY_NAME[parts[i]]) return BY_NAME[parts[i]];
  }
  return null;
}

// Whether a suggestion may be in the state: dropped only when its text clearly names another state.
export const suggestionInState = (text, abbr) => { const s = stateOf(text); return s === null || s === abbr; };

// Whether a geocode candidate is in the state: its RegionAbbr (or Region, a full name) when the service gave one, else the
// state its address names; with neither it is kept (the search was already limited to the state's box).
// candidate: { address, attributes }.
export function candidateInState(candidate, abbr) {
  const a = candidate?.attributes ?? {};
  const region = String(a.RegionAbbr ?? "").trim().toUpperCase() || BY_NAME[String(a.Region ?? "").trim().toUpperCase()] || null;
  if (region) return region === abbr;
  const s = stateOf(candidate?.address);
  return s === null || s === abbr;
}

// The ranking point for the geocoder: the parcel layer's extent centre, already projected to WGS84 ({ x: lon, y: lat }),
// rounded to cfg.BIAS_DECIMALS, or null when it isn't a real lon/lat inside cfg.STATE_EXTENT (a centre left in its
// layer's own coordinates, UTM metres say, would be sent as a nonsense location). cfg: SEARCH.LOCATION.
export function biasPoint(lonLat, cfg) {
  const x = Number(lonLat?.x), y = Number(lonLat?.y), box = cfg.STATE_EXTENT;
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < -180 || x > 180 || y < -90 || y > 90) return null;
  if (x < box.xmin || x > box.xmax || y < box.ymin || y > box.ymax) return null;
  const f = 10 ** cfg.BIAS_DECIMALS, round = (v) => Math.round(v * f) / f;
  return { x: round(x), y: round(y) };
}

// Whether a failed find is worth one retry without the ranking point: no answer at all (the browser's "Failed to
// fetch", which a gateway error without CORS headers also gives) or a 5xx. Not a cancel, a sign-in or another 4xx.
export function retryWithoutBias(err) {
  if (!err || err.name === "AbortError") return false;
  const status = Number(err.details?.httpStatus ?? err.details?.raw?.error?.code ?? err.httpStatus ?? NaN);
  if (Number.isFinite(status) && status > 0) return status >= 500;
  return /failed to fetch|networkerror|network error|load failed|unable to load|timeout|timed out/i.test(String(err.message ?? err));
}
