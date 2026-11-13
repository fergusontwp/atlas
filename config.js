// All the settings you'll touch for the link test live here.
export const CONFIG = {
  // Item ID of the AGOL web map (the 32-character string in the item URL).
  WEBMAP_ITEM_ID: "6e6d1a2403d64e0d855189d09059805c",

  // OAuth client ID from your AGOL developer credential / registered app.
  // Leave blank if the web map and its layers are public.
  APP_ID: "pHi2gvPG0YZPvmxf",

  PORTAL_URL: "https://www.arcgis.com",

  // Title of the parcel layer inside the web map. A warning shows if it isn't found.
  PARCEL_LAYER_TITLE: "Parcels Enrichment dev_v1_1-rest connection",

  // Friendly name for the parcel layer, shown in the legend and the layer list.
  PARCEL_LAYER_LABEL: "Parcels",

  // Give up waiting for the map after this many milliseconds.
  READY_TIMEOUT_MS: 20000,
};

// ---- Layer list ----
// Titles are the layer titles as they appear in the web map (open the app with
// ?debug=1 to see them). A title that matches nothing logs a console warning.
export const LAYER_LIST = {
  // Layers to leave out of the Layers list (they still draw on the map).
  HIDE: [],
  // Layers that start switched off, whatever the web map says.
  OFF: [],
  // The layers the user switched on or off in the Layers list, remembered per browser (section 53): an object
  // { <layer id in the web map>: true | false }, applied at startup after OFF, so a saved choice beats the config and the
  // web map default. App-driven changes (Print, the workspaces, plans, the table) are never saved.
  STORAGE_KEY: "parcelviewer.layerVisibility",
  // after a click or Enter in the Layers list, how long (ms) to wait for the SDK to switch the layers before comparing
  USER_CHANGE_MS: 250,
  TEXT: {
    RESET: "Reset layers to default", // the Layers block's action and the right-click menu item, shown only when something is saved
    RESET_DONE: "Layers reset to the map's default",
  },
};

// ---- Legend ----
// The legend lists the map's visible operational layers, in map order (the parcel entry follows the active symbology
// preset). Layers that can't have a legend, and switched-off layers, add nothing.
export const LEGEND = {
  EXCLUDE_TITLES: [], // layer titles to leave out of the legend (as in the Layers list; the parcel layer is "Parcels")
  MAX_HEIGHT_PERCENT: 45, // the legend scrolls inside once it is taller than this share of the map area
  TITLE: "Legend", // the header row's title; its chevron minimizes the legend to just this row
  MINIMIZED_DEFAULT: false, // used until the user has chosen
  STORAGE_KEY: "parcelviewer.legendMinimized", // localStorage key for the choice ("1" minimized, "0" open)
};

// ---- Parcel panel ----
export const PARCEL_PANEL = {
  // Attribute fields for the panel header, by exact field name. The first non-empty
  // value is the title; any others are joined into the subtitle. The pop-up's own
  // title still shows inside the content. The field must be one the pop-up uses.
  TITLE_FIELDS: ["TAXIDNUM"],
};

// The selected feature is always drawn as an outline with no fill (selectionOutline.js; the SDK's highlight isn't used),
// and so is a road search result. OUTLINE: a line in the highlight color (WIDTH px) over a casing just wider underneath
// (CASING_WIDTH px, CASING_ALPHA opaque) in a contrasting color: dark under a light highlight color, light under a dark
// one (printLeader.outlineColor's relative-luminance rule). A selected line gets the same pair as two lines, a point
// two rings RING_SIZE across. Chosen from docs/outline-candidates-1-600.png and -1-2400.png (candidate C; B, 2.5 on 4.5
// with ring 14, is the runner-up).
// The color: "Highlight color" at the top of the Symbology block (highlightColor.js), PRESETS plus Custom, Reset back to
// DEFAULT_COLOR; saved per browser under STORAGE_KEY (a #rrggbb string; anything else falls back to the default). It
// recolors the selection outline and the road search outline at once; markers keep their own colors.
// ---- Sign-out (section 59) ----
// Sign out revokes Atlas's token (IdentityManager.destroyCredentials: each OAuth credential posts to the portal's
// oauth2/revokeToken) and, with SIGNOUT_ENDS_SESSION, sends the browser to the portal's OAuth sign-out (SIGNOUT_PATH,
// with client_id and redirect_uri = the app's base URL, which must be registered on the app's credential) so the next
// sign-in asks for the sign-in details again. That endpoint couldn't be checked against the ArcGIS REST docs from the build
// container: if it fails on the real org, set SIGNOUT_ENDS_SESSION false (then the AGOL session stays, and the next
// sign-in may go straight through).
export const AUTH = {
  SIGNOUT_ENDS_SESSION: true,
  SIGNOUT_PATH: "/sharing/rest/oauth2/signout",
};

// ---- The app: theme, the header's user button and menu, sign-out, About (section 59) ----
export const APP = {
  // Light, Dark or Match system, saved per browser under STORAGE_KEY ("light" | "dark" | "system"; anything else is
  // "system"). The page's mode is the Calcite class on <html> (calcite-mode-light / calcite-mode-dark), set before the
  // first paint by the inline script at the top of index.html, which reads the same key (keep the two in step; a test
  // checks it). The map never changes with the theme.
  THEME: {
    STORAGE_KEY: "parcelviewer.theme",
    DEFAULT: "system",
    VALUES: ["light", "dark", "system"],
  },
  // The header (section 59): title | Follow-ups (n) | the user button. Below NAME_MIN_WIDTH of window width the button
  // shows the initials only. THUMBNAIL: use the portal user's picture (fetched with the user's sign-in; initials when
  // there is none or it fails).
  HEADER: { NAME_MIN_WIDTH: 900, THUMBNAIL: true },
  // About (section 59): FILE is written by tools/export_public.py at each export ({ version, commit, built }), read once
  // at startup and again (cache: "no-store") when the menu opens: a different commit means a newer copy is out.
  // RELEASE (section 60): this release's version, the release date YYYY.MM.DD, with .1, .2 for a second release the
  // same day (README, Versioning). The export writes it into FILE with the commit; when FILE can't be read it shows
  // alone (null: "Version unknown"). Set it, and add a CHANGELOG.md entry, for each release.
  // COMMIT_URL: a link for the commit (null: no link; the private repo isn't public, so its commits can't be linked).
  VERSION: { FILE: "version.json", RELEASE: "2026.11.13", COMMIT_URL: null },
  TEXT: {
    THEME: "Theme",
    THEME_LABELS: { light: "Light", dark: "Dark", system: "Match system" },
    USER_BUTTON: (name) => (name ? `Account and settings, ${name}` : "Account and settings"),
    ABOUT: "About Atlas",
    VERSION_LINE: (version, commit) => `Version ${version}${commit ? ` · ${commit}` : ""}`,
    VERSION_UNKNOWN: "Version unknown",
    NEWER: "A newer version is available.",
    RELOAD: "Reload",
    SIGN_OUT: "Sign out",
    SIGN_OUT_ASK: "You have unsaved notes. Sign out anyway?",
    SIGN_OUT_YES: "Sign out",
    SIGN_OUT_CANCEL: "Cancel",
    SIGNING_OUT: "Signing out…",
    MENU_HEADING: "Account and settings",
    NOT_SIGNED_IN: "Not signed in",
  },
};

export const HIGHLIGHT = {
  DEFAULT_COLOR: "#ffea00",
  PRESETS: [["Yellow", "#ffea00"], ["Cyan", "#00e5ff"], ["Magenta", "#ff2ec8"], ["Orange", "#ff8a00"], ["Red", "#ff2b2b"], ["Lime", "#7cff00"]],
  STORAGE_KEY: "parcelviewer.highlightColor",
  TEXT: { HEADING: "Highlight color", LABEL: "Highlight color", RESET: "Reset to yellow" },
  OUTLINE: { WIDTH: 3, CASING_WIDTH: 5.5, CASING_ALPHA: 0.85, JOIN: "round", CAP: "round", RING_SIZE: 16 },
};

// ---- Parcel filter ----
export const FILTER = {
  INCLUDE_FIELDS: [], // if non-empty: only these fields, in this order
  EXCLUDE_FIELDS: [], // never offered
  MAX_DISTINCT: 250, // above this a string field gets a plain text value box
  COUNT_LABEL: "parcels",
  DEFAULT_MATCH: "AND", // "AND" (all) or "OR" (any) when several conditions are used
};

// ---- Parcel search (box at the top of the map) and ?parcel=<id> ----
// Matching is case-insensitive "contains" on each field; a field the layer doesn't have is skipped with a warning.
// `normalize: true` is for IDs stored with punctuation (TAXIDNUM looks like 12-345-,678-,0000-): people can type the
// stored format or just the letters and digits. Owner names are searchable: review before any public view.
export const SEARCH = {
  FIELDS: [
    { field: "TAXIDNUM", label: "Parcel ID", normalize: true },
    { field: "Name", label: "Owner" },
    { field: "Location", label: "Address" },
  ],
  ID_FIELD: "TAXIDNUM", // used by ?parcel= and shown as the main text of a result
  MIN_CHARS: 3,
  DEBOUNCE_MS: 250,
  MAX_PER_FIELD: 8,
  MAX_RESULTS: 12,
  CANDIDATES: 50, // rows fetched per field before ranking (starts-with first) and cutting to MAX_PER_FIELD
  NORMALIZED_CANDIDATES: 1000, // same, for normalize fields: the pattern also finds look-alikes that are then dropped
  // Search modes: a segmented control above the box. Parcel is selected on every load; the text is kept on a switch.
  MODES: {
    PARCEL: { LABEL: "Parcel", PLACEHOLDER: "Search Parcel ID, Owner or Address" },
    ROAD: { LABEL: "Road", PLACEHOLDER: "Search street name or intersection" },
    LOCATION: { LABEL: "Location", PLACEHOLDER: "Search any location or place" },
    CONTROL_LABEL: "Search for",
  },
  // Road mode: street names from the road layer (no geocoder), matched in the browser; intersections from the
  // layer's own lines. LAYER_TITLE: the road layer's title in the web map; null finds the one line layer that has all
  // of NAME_FIELDS (the console says which; set the title to make it fixed). The full name is NAME_FIELDS joined in
  // order with single spaces, empty parts skipped ("N Atherton St").
  ROAD: {
    LAYER_TITLE: null,
    NAME_FIELDS: ["St_PreDir", "St_Name", "St_PosTyp"],
    MAX_RESULTS: 12,
    ZOOM_EXPAND: 1.2, // a street's extent is expanded by this factor
    INTERSECTION_TOL_FT: 5, // vertices or ends this close count as meeting
    INTERSECTION_MERGE_FT: 150, // meeting points this close are one intersection (a wide junction, a divided road)
    INTERSECTION_SCALE: 1200, // an intersection is shown at 1:1,200
    INTERSECTION_CANDIDATES: 3, // streets tried for each side of "A & B" (the best matches), so at most 3 x 3 pairs
    // Words matched as one: each abbreviation is read as its full word, in the typed text and in the names.
    ABBREVIATIONS: {
      ST: "STREET", AVE: "AVENUE", AV: "AVENUE", RD: "ROAD", DR: "DRIVE", LN: "LANE", CT: "COURT", BLVD: "BOULEVARD",
      PL: "PLACE", CIR: "CIRCLE", TER: "TERRACE", TERR: "TERRACE", HWY: "HIGHWAY", PKWY: "PARKWAY", WAY: "WAY", ALY: "ALLEY",
      TRL: "TRAIL", PIKE: "PIKE", SQ: "SQUARE", XING: "CROSSING", EXT: "EXTENSION", MT: "MOUNT", HTS: "HEIGHTS",
      N: "NORTH", S: "SOUTH", E: "EAST", W: "WEST", NE: "NORTHEAST", NW: "NORTHWEST", SE: "SOUTHEAST", SW: "SOUTHWEST",
    },
    TEXT: {
      SEGMENTS: (n) => `${n} segment${n === 1 ? "" : "s"}`,
      NO_MATCH: "No street matches.",
      NO_INTERSECTION: "No intersection found",
      TWO_STREETS: "Type two streets, for example College Ave & Atherton St.",
      OF: (i, n) => `${i} of ${n}`,
      LOADING: "Reading street names…",
      FAILED: "Road search failed",
    },
  },
  // Location mode: the World Geocoding Service (POINT_INFO.GEOCODE.URL) with the user's sign-in; results near the
  // township (the centre of the parcel layer's full extent) rank first, any place can be found. forStorage is never set.
  // Pennsylvania only: both requests are limited to STATE_EXTENT (WGS84 lon/lat) and COUNTRY_CODE, and since that box
  // reaches into the neighbouring states, a suggestion whose text names another state is dropped, and a picked result is
  // kept only when its RegionAbbr (asked for with OUT_FIELDS) is STATE_ABBR ("Outside Pennsylvania" otherwise).
  LOCATION: {
    MAX_SUGGESTIONS: 8,
    SCALE: 2400, // a result without an extent is shown at 1:2,400
    STATE_EXTENT: { xmin: -80.52, ymin: 39.72, xmax: -74.69, ymax: 42.27 },
    COUNTRY_CODE: "USA",
    STATE_ABBR: "PA",
    OUT_FIELDS: ["RegionAbbr", "Region"],
    // The ranking point (the parcel layer's extent centre) is sent in WGS84 lon/lat, rounded to this many decimals; one
    // outside STATE_EXTENT, or not a lon/lat at all, is dropped (no ranking point) with one console warning.
    BIAS_DECIMALS: 6,
    // The geocoder is asked for results in this wkid only (outSR {"wkid":3857}); never the view's spatial reference, whose
    // storage parameters from the web map (falseX, xyUnits, tolerances) made findAddressCandidates answer 502.
    OUT_WKID: 3857,
    TEXT: { NO_MATCH: "No place found in Pennsylvania.", FAILED: "Location search unavailable", OUTSIDE: "Outside Pennsylvania" },
  },
  // The road outline and the location marker (list-hidden graphics layers; the marker is point info's when it exists).
  ROAD_OUTLINE_LAYER_ID: "road-search-outline",
  LOCATION_MARKER_LAYER_ID: "location-search-marker",
};

// ---- What's in this parcel ----
// Finds features in other layers that intersect the selected parcel, or lie within a distance of it. It is purely
// spatial: no field of the searched layers is read except their display field (for item labels).
// The "Call log" hosted view of the notes layer (entry_type = 'contact', section 51), added to the web map by Jackson for
// browsing and export through the attribute table. It is never in What's in this parcel, never a Notes subject and
// never a Plans subject (WHATS_HERE, NOTES and PLANS EXCLUDE_TITLES). Change it here if the view's web map title differs.
const CALL_LOG_VIEW_TITLE = "Call log";

export const WHATS_HERE = {
  EXCLUDE_TITLES: [CALL_LOG_VIEW_TITLE], // layer titles that never appear in the checklist
  DEFAULT_ON_TITLES: [], // layer titles that start checked (nothing is checked otherwise)
  RADIUS: { UNIT: "feet", PRESETS: [25, 50, 100, 250], DEFAULT: 50, MAX: 2640 },
  // "Intersects" searches with the parcel shrunk inward by this much, so a neighbouring polygon that only shares an
  // edge isn't counted. 0 turns it off.
  STRICT_TOLERANCE_FT: 1,
  MAX_FEATURES_PER_LAYER: 200,
  MAX_LISTED_ITEMS: 50,
  // Results are shown with each source layer's own symbols and colors, only bolder: thicker outlines, lines and
  // markers (never a color or alpha change). OUTLINE_FACTOR (polygon outlines, at least MIN_OUTLINE_PX points),
  // LINE_FACTOR, POINT_FACTOR (marker size). ACTIVE_FACTOR is the stronger version for the item hovered or picked in the list, and ACTIVE_MIN_PX the thinnest outline or line it is drawn with (so it stands out against the copy's bolder outline).
  EMPHASIS: { OUTLINE_FACTOR: 1.75, LINE_FACTOR: 1.5, POINT_FACTOR: 1.25, MIN_OUTLINE_PX: 1.5, ACTIVE_FACTOR: 2.25, ACTIVE_MIN_PX: 3.5 },
  // The results table (View table): TABLE.HIDE_FIELDS are field names left out of every table (empty: every field but
  // geometry, blob, raster and xml is shown).
  // TABLE.EXPORT_HEADER is what the CSV and Excel header cells say: "alias" (the field's alias, as the table does) or "name".
  TABLE: { HIDE_FIELDS: [], EXPORT_HEADER: "alias" },
  // The dashed outline drawn for "Within" mode (a graphic, not layer symbology).
  DISTANCE_OUTLINE: { COLOR: "#282828", WIDTH: 1.5 },
};

// ---- "What's here?" (right-click on the map: pointInfo.js) ----
// A right-click (down and up with button 2, moved at most CLICK_MAX_MOVE_PX, within CLICK_MAX_MS, the map not rotated)
// opens a small card at the click: lat/long, the parcel's own address (PARCEL) and the nearest reverse-geocoded address
// (GEOCODE), an Open in Google Maps link and copy buttons. A right-drag still rotates the map.
// GEOCODE: the ArcGIS World Geocoding Service with the user's sign-in token; forStorage is never set, so a reverse
// geocode isn't stored and shouldn't use credits. One request per accepted right-click; the last CACHE_SIZE answers are
// kept in memory, keyed by the point rounded to CACHE_ROUND_FT (2271 feet), so a right-click within CACHE_ROUND_FT of
// one already asked sends nothing. TIMEOUT_MS: then "Address unavailable: timed out". The 5.1 parameters have no search
// radius. ENABLED false: coordinates and the parcel address only.
export const POINT_INFO = {
  ENABLED: true,
  CLICK_MAX_MOVE_PX: 5,
  CLICK_MAX_MS: 600,
  LATLON_DECIMALS: 6,
  PARCEL: { ADDRESS_FIELD: "Location", LABEL: "Parcel record" }, // the parcel ID comes from SEARCH.ID_FIELD
  GEOCODE: {
    ENABLED: true,
    LABEL: "Nearest address (geocoder, approximate)",
    URL: "https://geocode-api.arcgis.com/arcgis/rest/services/World/GeocodeServer",
    TIMEOUT_MS: 8000,
    CACHE_SIZE: 20,
    CACHE_ROUND_FT: 10,
  },
  GOOGLE_MAPS_URL: "https://www.google.com/maps/search/?api=1&query={lat}%2C{lon}",
  // the click's marker: a small ring in the highlight colours (yellow over a black halo)
  MARKER: { SIZE: 12, COLOR: [255, 234, 0, 0], OUTLINE: "#ffea00", OUTLINE_WIDTH: 2.5, HALO: "#000000", HALO_WIDTH: 4.5 },
  CARD: { GAP_PX: 14, MARGIN_PX: 8 }, // from the click to the card, and the card to the map's edges
  LOADER_DELAY_MS: 250,
  DISTANCE: { ROUND_FT: 10, MILE_FROM_FT: 1000 }, // "About 40 ft", and miles past 1,000 ft
};

// ---- Basemap selector ----
// The web map's own basemap is always first (cloned at startup, without its labels, and labeled DEFAULT_LABEL), then these.
// ownLabels: the basemap's labels are part of its own style (the vector basemaps), so the Labels switch is disabled for it.
// LABELS: the "Labels (roads and places)" switch at the top of the block. Its labels are the web map basemap's own
// reference layers, taken off it at startup (or, if it has none, FALLBACK_ID's); each basemap gets its own copies. On by
// default; saved per browser under STORAGE_KEY ("on" / "off").
// An entry is either { id, label }, an SDK basemap id (the Esri ones need a token: OAuth sign-in or an API key), or
// { label, url, copyright, thumbnail? }, a public cached map service (TileLayer) shown on its own as the basemap, with no
// reference layer. Its tiles must be in Web Mercator (3857) like the view. copyright is the map's credit line (and the
// print's), for services that publish none. thumbnail: the gallery picture (a tile URL); left out, one is drawn.
// NONE_LABEL: an empty basemap (just the parcels and plans on the background), last in the gallery; null to leave it out.
export const BASEMAPS = {
  DEFAULT_LABEL: "Imagery (Esri)",
  OPACITY: 1, // the base layers' opacity at start (not the labels'); the slider in the Basemap block resets to it
  NONE_LABEL: "No basemap",
  LABELS: {
    FALLBACK_ID: "hybrid",
    DEFAULT_ON: true,
    STORAGE_KEY: "parcelviewer.basemapLabels",
    TEXT: { SWITCH: "Labels (roads and places)", OWN: "This basemap has its own labels" },
  },
  OPTIONS: [
    { id: "streets-vector", label: "Streets", ownLabels: true },
    { id: "topo-vector", label: "Topographic", ownLabels: true },
    { id: "gray-vector", label: "Light gray", ownLabels: true },
    // PEMA Cycle 2 orthoimagery: 0.5 ft, 4-band, leaf-off, flown spring 2021 to 2023 (public, no token; served by PASDA).
    // The thumbnail is the level-15 tile over State College (/tile/{level}/{row}/{col}).
    { label: "PEMA leaf-off 2021–23", copyright: "PEMA / PASDA",
      url: "https://services.pasda.psu.edu/server/rest/services/PEMAImagery2021_2023cache/MapServer",
      thumbnail: "https://services.pasda.psu.edu/server/rest/services/PEMAImagery2021_2023cache/MapServer/tile/15/12310/9297" },
  ],
};

// ---- Parcel labels ----
// Edit FIELDS freely: each entry is { field, label, decimals?, prefix?, suffix? }. The field type comes from the
// layer, numbers get their own default format, and a field the layer doesn't have is skipped with a warning.
export const LABELS = {
  FIELDS: [
    { field: "TAXIDNUM", label: "Parcel ID" },
    { field: "Location", label: "Address" },
    { field: "Name", label: "Owner" }, // owner names: review before any public view of this viewer
    { field: "Lot", label: "Lot" },
    { field: "zoning_district", label: "Zoning" },
    { field: "dom_land_use", label: "Dominant land use" },
    { field: "frontage_road_name", label: "Frontage road" },
    { field: "Cama_acres", label: "Acres (CAMA, assessor record)", decimals: 2, suffix: " ac" },
    { field: "road_frontage_ft", label: "Road frontage", decimals: 0, suffix: " ft" },
    { field: "FMV", label: "Fair market value", decimals: 0, prefix: "$" },
    { field: "AssVal", label: "Assessed value", decimals: 0, prefix: "$" },
    { field: "pct_floodplain", label: "Floodplain %", decimals: 0, suffix: "%" },
    { field: "pct_forested", label: "Forested %", decimals: 0, suffix: "%" },
    { field: "pct_impervious", label: "Impervious %", decimals: 0, suffix: "%" },
  ],
  // Families offered in the font list. 2D labels draw from Esri's hosted glyph files, so a family that service
  // doesn't have falls back to a default font.
  FONTS: ["Arial Unicode MS", "Avenir Next LT Pro", "Noto Sans", "Merriweather"],
  // "Show labels when zoomed in past 1:[scale]" choices (a larger number is more zoomed out).
  SCALES: [2000, 5000, 10000, 24000],
  // GIS area and perimeter come from the layer's own Shape__Area / Shape__Length (meters and square meters in
  // NAD83 / UTM 17N, so planar), divided by a unit divisor. CAMA acres (assessor record) is the Cama_acres field above.
  GEOMETRY_AREA: { field: "Shape__Area", unitDivisors: { acres: 4046.8564224, "square-feet": 0.09290304 } },
  GEOMETRY_LENGTH: { field: "Shape__Length", unitDivisors: { "us-feet": 0.3048006096, feet: 0.3048 } },
  DEFAULTS: {
    field: "TAXIDNUM",
    field2: "", // optional second line (a source key); empty = none
    fontFamily: "Arial Unicode MS",
    fontSize: 10,
    bold: false,
    italic: false,
    color: "#444444",
    halo: { on: true, color: "#ffffff", size: 2 },
    xoffset: 0,
    yoffset: 0,
    minScale: 5000, // 0 = no limit
    deconflict: true, // hide overlapping labels
  },
  // Per-edge length labels (a separate overlay; always shown in feet).
  EDGES: {
    UNIT: "us-feet", // "us-feet" (Pennsylvania plans and deeds) or "feet"; labels always read " ft"
    MIN_EDGE_PX: 45, // no label for an edge shorter than this on screen
    MIN_SCALE: 1500, // only draw when zoomed in past 1:1,500 (a larger number is more zoomed out)
    MAX_PARCELS: 400, // draw nothing, and say so, with more parcels than this in view
    MAX_EDGES: 4000,
    DECIMALS: 1, // default; the Labels block offers 0 to 2
    FONT_SIZE: 9,
    // A curve digitized as many short segments gets one label with the summed length (edgeLabels.js explains the rules;
    // the counts of breaks by reason are in viewer.labels.edges.state.breaks, for tuning these on the real parcels).
    CURVE: {
      ENABLED: true, // false: one label per segment, as before
      JUNCTIONS: true, // another parcel's line meeting a vertex (3 or more directions) ends a curve
      JUNCTION_TOL_FT: 0.05, // vertices of neighboring parcels this close are the same vertex
      SAGITTA_MAX_FT: 0.5, // a bend whose sagitta is larger than this is a survey angle point, not a finely digitized arc
      CORNER_MIN_DEG: 25, // a turn is a corner when it exceeds this and CORNER_RATIO x the turns around it
      CORNER_RATIO: 3,
      LENGTH_RATIO: 4, // a segment this many times the median of the others in its run is a straight line, not part of the curve
      MIN_SEGMENTS: 3, // fewer segments than this keep their own labels
    },
  },
};

// ---- Measure (length and area) ----
export const MEASURE = {
  LENGTH_UNIT: "us-feet", // US survey feet for Pennsylvania plans (the international foot is not offered)
  AREA_UNIT: "acres",
  LENGTH_UNITS: ["us-feet", "yards", "miles", "meters"], // offered in the unit dropdown
  AREA_UNITS: ["square-feet", "acres", "square-miles", "square-meters", "hectares"],
  // Each unit in the lists above: its size in meters (or square meters), as the SDK converts (core/units.js), the short
  // name shown after a value, the decimals, and its name in the list's unit menus. A saved unit no longer listed (the
  // international "feet", dropped in section 55) falls back to the default and is removed from storage.
  UNITS: {
    "us-feet": { PER: 1200 / 3937, ABBR: "ft", DECIMALS: 1, NAME: "Feet (US survey)" },
    yards: { PER: 0.9144, ABBR: "yd", DECIMALS: 1, NAME: "Yards" },
    miles: { PER: 1609.344, ABBR: "mi", DECIMALS: 3, NAME: "Miles" },
    meters: { PER: 1, ABBR: "m", DECIMALS: 2, NAME: "Meters" },
    "square-feet": { PER: 0.09290304, ABBR: "sq ft", DECIMALS: 0, NAME: "Square feet" },
    acres: { PER: 4046.8564224, ABBR: "ac", DECIMALS: 2, NAME: "Acres" },
    "square-miles": { PER: 2589988.110336, ABBR: "sq mi", DECIMALS: 4, NAME: "Square miles" },
    "square-meters": { PER: 1, ABBR: "m²", DECIMALS: 1, NAME: "Square meters" },
    hectares: { PER: 10000, ABBR: "ha", DECIMALS: 3, NAME: "Hectares" },
  },
  // Saved per browser (try/catch; the app works without storage). Nothing about the measurements themselves is stored.
  STORAGE: { LENGTH_UNIT: "parcelviewer.measureLengthUnit", AREA_UNIT: "parcelviewer.measureAreaUnit", SNAP: "parcelviewer.measureSnap" },
  MAX_ITEMS: 50, // the scratch list's limit; at it, New measurement and Add selected feature are disabled
  NAME_MAX: 40, // characters in a measurement's optional name
  CONFIRM_CLEAR_AT: 5, // Clear asks first when the list has this many measurements or more
  ZOOM_EXPAND: 1.5, // Zoom to: the measurement's extent times this
  ZOOM_MIN_SCALE: 600, // Zoom to never goes closer than 1:this
  SNAP: {
    DEFAULT: true, // the Snap switch's value until the user changes it
    LAYER_TITLES: [], // more layers to snap to besides the parcels (web map titles), e.g. the road centerlines
    DISTANCE: 5, // pixels (the SDK's SnappingOptions.distance)
  },
  // The measurements on the map: a dashed line in the measurement's own color (section 55: 1 is the highlight color when
  // the first measurement is made, the next go through HIGHLIGHT.PRESETS) over the cased outline (HIGHLIGHT.OUTLINE),
  // so a measurement doesn't read as the selected feature; areas get a light fill. One halo label per measurement.
  STYLE: {
    DASH: "dash",
    FILL_ALPHA: 0.08,
    EMPHASIS_WIDTH: 2, // added to the line and casing widths while its row is hovered or focused
    LABEL: { FAMILY: "Arial Unicode MS", COLOR: "#111111", HALO_COLOR: "#ffffff", HALO_SIZE: 1.5, SIZE: 10, WEIGHT: "bold", OFFSET_Y: 8,
      // a small dot in the measurement's color before the number (the label is then left-aligned after it); off for now
      DOT: { SHOW: false, SIZE: 8, OUTLINE_COLOR: "#ffffff", OUTLINE_WIDTH: 1.25, GAP: 3 } },
  },
  // Measurement labels (section 57): one set of settings for every label at once, saved per browser under STORAGE_KEY
  // (only these settings: never the list, positions, names or values). DEFAULTS are today's look: "2 · north setback ·
  // 1.24 ac", bold, white halo, size STYLE.LABEL.SIZE, at the center. line: "center" (halfway along, OFFSET_Y above,
  // horizontal) or "along" (angled with the line where it sits, upright, following the view's rotation); area: "center"
  // (at the anchor point) or "edge" (riding one edge, angled with it). lineSide above | on | below, areaSide outside | on
  // | inside, offset: pixels between the line and the text. EDGE_PICK: which edge "On the edge" uses (see measureLabels.js):
  // "fewest-overlaps" (ties: the longest), "longest" or "lowest" on screen; the text must fit the edge (FIT_MARGIN_PX
  // each end), else the next edge, else Center. Text widths are estimated from the font size (CHAR_EM, BOLD_CHAR_EM).
  // An edge is a run that stays within MERGE_TOL_PX of its chord on screen and has no turn of CORNER_DEG or more.
  // DRAG_THRESHOLD_PX: a press that moves less is a click.
  LABELS: {
    STORAGE_KEY: "parcelviewer.measureLabels",
    DEFAULTS: { show: true, size: 10, bold: true, halo: true, number: true, name: true, value: true, perimeter: false,
      line: "center", area: "center", lineSide: "above", areaSide: "outside", offset: 6 },
    SIZE_MIN: 8,
    SIZE_MAX: 16,
    OFFSET_MAX: 40,
    LINE_MODES: ["center", "along"],
    AREA_MODES: ["center", "edge"],
    LINE_SIDES: ["above", "on", "below"],
    AREA_SIDES: ["outside", "on", "inside"],
    EDGE_PICK: "fewest-overlaps",
    EDGE_PICKS: ["fewest-overlaps", "longest", "lowest"],
    FIT_MARGIN_PX: 6,
    CHAR_EM: 0.58,
    BOLD_CHAR_EM: 0.62,
    MERGE_TOL_PX: 3,
    CORNER_DEG: 30,
    DRAG_THRESHOLD_PX: 4,
    TEXT: {
      BUTTON: "Label settings",
      HEADING: "Measurement labels",
      SHOW: "Show labels",
      SIZE: "Size (pt)",
      BOLD: "Bold",
      HALO: "Halo",
      CONTENT: "Show",
      NUMBER: "Number",
      NAME: "Name",
      VALUE: "Value",
      PERIMETER: "Perimeter (areas)",
      LINES: "Lines",
      AREAS: "Areas",
      LINE_MODE: { center: "Center", along: "Along the line" },
      AREA_MODE: { center: "Center", edge: "On the edge" },
      SIDE: "Side",
      LINE_SIDE: { above: "Above", on: "On", below: "Below" },
      AREA_SIDE: { outside: "Outside", on: "On", inside: "Inside" },
      OFFSET: "Offset (px)",
      RESET: "Reset labels",
      NOTHING: "Nothing is ticked under Show, so no labels are drawn.",
      DRAG_HINT: "Drag a label to slide it along its line or edge.",
      RESET_POSITION: "Reset label position",
    },
  },
  TEXT: {
    LENGTH: "Length",
    AREA: "Area",
    NEW: "New measurement",
    CLEAR: "Clear",
    CLEAR_CONFIRM: (n) => `Clear all ${n} measurements?`,
    HINT: "Clicks on the map measure instead of selecting while a measurement is in progress. Esc cancels the one being drawn.",
    HEADING: "Measure",
    HEADING_COUNT: (n) => `Measure (${n})`,
    LIMIT: (n) => `The list holds ${n} measurements. Delete some to add more.`,
    ADD_SELECTED: "Add selected feature",
    ADD_SELECTED_NONE: "Select a parcel, road or other line or area first",
    ADD_SELECTED_POINT: "A point has no length or area",
    SNAP: "Snap to parcel edges and corners",
    COPY_ALL: "Copy all",
    LENGTH_UNIT: "Length unit",
    AREA_UNIT: "Area unit",
    COPIED: "Copied",
    COPIED_ALL: (n) => `Copied ${n} measurements`,
    COPY_FAILED: "Couldn't copy",
    COPY_FAILED_MSG: "The browser didn't allow copying. Read the values from the Measure list instead.",
    UNTITLED: "Untitled",
    PERIMETER: "perimeter",
    RENAME: "Rename",
    RENAME_LABEL: "Measurement name",
    ZOOM: "Zoom to",
    COPY: "Copy",
    DELETE: "Delete",
    LIST_LABEL: "Measurements",
    PRINT_INCLUDE: "Include measurements",
    LAYER_TITLE: "Measurements",
    COLOR_HEADING: "Measurement color",
    COLOR_LABEL: (n) => `Color of measurement ${n}`,
  },
};

// ---- Print map ----
export const PRINT = {
  TIMEOUT_MS: { READY: 15000, CAPTURE: 60000, LEGEND: 30000, LAYER: 10000, SWATCH: 7000, ENCODE: 30000 },
  PAGE_SIZES: [["Letter", 8.5, 11], ["Legal", 8.5, 14], ["11x17", 11, 17]], // inches, short side first
  MARGIN_IN: 0.25,
  MARGINS_IN: [0, 0.25, 0.5],
  STRIP_HEIGHT_PERCENT: 20, // fixed share of the page inside the margins, reserved before framing
  FRAME_INSET_PX: 24,
  // Mirror SDK 5.1 screenshot internals; the integer multiplier also depends on the FULL view size.
  NATIVE_MAX_PX: 4096,
  MAX_MULTIPLIER: 4,
  MAX_PIXELS: 32000000, // memory guards for the whole output page, not detail targets
  MAX_SIDE_PX: 8192,
  DETAIL_WARN_DPI: 150,
  JPEG_QUALITY: 98, // flatten the native map image onto white before encoding
  SCALE_PRESETS: [25, 50, 100, 200, 400, 1000], // feet per page inch
  DEFAULT_DISCLAIMER: "For reference only. Not a survey or legal document. Parcel boundaries are approximate.",
  OWNER_NAME_FIELDS: ["Name"], // notice when visible parcel labels use these sources
  DEFAULTS: {
    pageSize: "Letter", orientation: "landscape", border: true, format: "pdf",
    elements: { title: false, scaleBar: true, northArrow: true, legend: true, date: false, notes: true },
  },
  TEXT: { MIN_SIZE_PT: 6, MAX_SIZE_PT: 72, LEADING: 1.2, UNDERLINE_OFFSET: 0.14, UNDERLINE_WIDTH: 0.055, MIN_UNDERLINE_PT: 0.5 },
  TEXT_STYLES: {
    title: { size: 16, bold: true, italic: false, underline: false, color: "#000000", align: "left" },
    subtitle: { size: 10, bold: false, italic: false, underline: false, color: "#000000", align: "left" },
    date: { size: 8, bold: false, italic: false, underline: false, color: "#000000", align: "left" },
    notes: { size: 8, bold: false, italic: false, underline: false, color: "#000000", align: "left" },
    callout: { size: 11, bold: false, italic: false, underline: false, color: "#333333", align: "left" },
    legend: { size: 8, bold: false }, scaleBar: { size: 8, bold: false },
  },
  COLOR_PRESETS: [["Black", "#000000"], ["White", "#ffffff"], ["Yellow", "#ffff00"], ["Red", "#ff0000"], ["Blue", "#0000ff"]],
  LEADER: { COLOR: "#000000", WIDTH_PT: 2, MIN_WIDTH_PT: 1, MAX_WIDTH_PT: 8, OUTLINE: true,
    OUTLINE_PADDING_PT: 1.5, CONTRAST_THRESHOLD: 0.179 },
  CALLOUT: { WIDTH_PT: 160, MIN_WIDTH_PT: 48, PADDING_PT: 5, HANDLE_PX: 8,
    RESIZE_STEP_PT: 1, ARROWHEAD: true, BORDER: true, FILL: "#ffffff" },
  SKETCH: { COLOR: "#000000", HIGHLIGHTER_COLOR: "#ffff00", WEIGHT_PT: 3, MIN_WEIGHT_PT: 1, MAX_WEIGHT_PT: 16,
    COLORS: [["Black", "#000000"], ["White", "#ffffff"], ["Yellow", "#ffff00"], ["Red", "#ff0000"], ["Blue", "#0000ff"], ["Green", "#008000"]],
    CURSORS: {"pen": "url(\"data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2224%22%20height%3D%2224%22%20viewBox%3D%220%200%2016%2016%22%3E%3Cpath%20fill%3D%22white%22%20stroke%3D%22white%22%20stroke-width%3D%222%22%20d%3D%22M15.721%204.007a.965.965%200%200%200-.03-1.385l-1.413-1.414a.965.965%200%200%200-1.385-.03L2.841%2011.23l-1.756%204.097a.371.371%200%200%200%20.488.487L5.67%2014.06l8.607-8.609zM2.624%2014.276l.554-1.294.74.74zm2.338-.924L3.55%2011.937l8.007-8.008%201.414%201.415zm8.716-8.716-1.414-1.414%201.09-1.09a.306.306%200%200%201%20.433%200l.981.98a.306.306%200%200%201%200%20.434z%22%2F%3E%3Cpath%20fill%3D%22%23222%22%20d%3D%22M15.721%204.007a.965.965%200%200%200-.03-1.385l-1.413-1.414a.965.965%200%200%200-1.385-.03L2.841%2011.23l-1.756%204.097a.371.371%200%200%200%20.488.487L5.67%2014.06l8.607-8.609zM2.624%2014.276l.554-1.294.74.74zm2.338-.924L3.55%2011.937l8.007-8.008%201.414%201.415zm8.716-8.716-1.414-1.414%201.09-1.09a.306.306%200%200%201%20.433%200l.981.98a.306.306%200%200%201%200%20.434z%22%2F%3E%3C%2Fsvg%3E\") 1 22, crosshair", "highlighter": "url(\"data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2224%22%20height%3D%2224%22%20viewBox%3D%220%200%2016%2016%22%3E%3Cpath%20fill%3D%22white%22%20stroke%3D%22white%22%20stroke-width%3D%222%22%20d%3D%22M15.04%202.332%2013.667.961A1%201%200%200%200%2012.34.883L3.033%208.23l-.504%203.533L.574%2013.72l2.561.853%201.1-1.1%203.534-.505%207.348-9.308a1%201%200%200%200-.078-1.327zM3.853%209.561l2.585%202.585-2.262.324-.647-.647zm-.99%203.867-.438-.147.574-.574.293.293zm4.592-1.68L4.25%208.545l8.71-6.876%201.371%201.371z%22%2F%3E%3Cpath%20fill%3D%22%23222%22%20d%3D%22M15.04%202.332%2013.667.961A1%201%200%200%200%2012.34.883L3.033%208.23l-.504%203.533L.574%2013.72l2.561.853%201.1-1.1%203.534-.505%207.348-9.308a1%201%200%200%200-.078-1.327zM3.853%209.561l2.585%202.585-2.262.324-.647-.647zm-.99%203.867-.438-.147.574-.574.293.293zm4.592-1.68L4.25%208.545l8.71-6.876%201.371%201.371z%22%2F%3E%3C%2Fsvg%3E\") 1 22, crosshair", "eraser": "url(\"data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2224%22%20height%3D%2224%22%20viewBox%3D%220%200%2016%2016%22%3E%3Cpath%20fill%3D%22white%22%20stroke%3D%22white%22%20stroke-width%3D%222%22%20d%3D%22M8.037%2014.625a.705.705%200%200%200%20.778.162l6.738-2.773c.941-.383.173-2.43-.285-3.63l-.22-.576-7.2-6.473a.72.72%200%200%200-.489-.191.6.6%200%200%200-.213.034L.026%203.213%200%203.94a10.4%2010.4%200%200%200%20.889%203.207.7.7%200%200%200%20.154.247zm.58-.838L1.805%206.743l-.125-.33a17%2017%200%200%201-.53-1.556l5.454%205.454a2.19%202.19%200%200%200%202.318.502l5.425-2.034a7.8%207.8%200%200%201%20.659%202.378zM7.29%202.177l6.42%205.773-5.14%201.927a1.19%201.19%200%200%201-1.259-.273l-5.78-5.781z%22%2F%3E%3Cpath%20fill%3D%22%23222%22%20d%3D%22M8.037%2014.625a.705.705%200%200%200%20.778.162l6.738-2.773c.941-.383.173-2.43-.285-3.63l-.22-.576-7.2-6.473a.72.72%200%200%200-.489-.191.6.6%200%200%200-.213.034L.026%203.213%200%203.94a10.4%2010.4%200%200%200%20.889%203.207.7.7%200%200%200%20.154.247zm.58-.838L1.805%206.743l-.125-.33a17%2017%200%200%201-.53-1.556l5.454%205.454a2.19%202.19%200%200%200%202.318.502l5.425-2.034a7.8%207.8%200%200%201%20.659%202.378zM7.29%202.177l6.42%205.773-5.14%201.927a1.19%201.19%200%200%201-1.259-.273l-5.78-5.781z%22%2F%3E%3C%2Fsvg%3E\") 1 22, crosshair"}, // tool icons with a white halo for imagery
    HIGHLIGHTER_OPACITY: 0.4, HIGHLIGHTER_WIDTH_FACTOR: 4, REDUCE_PT: 0.3, SAMPLE_DISTANCE_PX: 1.5,
    MAX_LIVE_POINTS: 2048, HIT_TOLERANCE_PX: 5, HIT_CURVE_STEPS: 12, HISTORY_LIMIT: 80,
  },
  LEGEND: { MIN_COLUMN_PT: 100, GAP_PT: 8, SWATCH_PT: 16 },
  STORAGE_KEY: "parcelviewer.printSettings",
};

// ---- Georeferencing plan PDFs (the workspace) ----
// Everything is fitted, measured and stored in one ground-true working CRS, in US survey feet. The map's Web Mercator
// is for display only. Don't change WORKING_WKID unless the new CRS is projected and in feet; saved plans keep their
// own wkid, so old plans don't move.
export const GEOREF = {
  WORKING_WKID: 2271, // NAD83 / Pennsylvania North (ftUS)
  TOLERANCE_FT: { GOOD: 1, WARN: 3 }, // fit error up to GOOD is class A, up to WARN class B, above that C
  // Render resolution. The page is rendered at its native detail (the ceiling) and the saved image's resolution comes
  // from the byte budget (PLANS.COMPRESSION), not from a fixed size. The ceiling: a page that is embedded images (a scan,
  // a mosaic) at those images' own pixels per inch; a vector page (or one whose images can't be read) at MAX_DPI.
  MAX_DPI: 300,
  MIN_DPI: 100, // a saved image below this gets a warning ("small text may be hard to read"); it still saves
  DPI_CHOICES: [100, 150, 200, 250, 300, 400, 600], // a lower resolution the user can pick in step 2 (only those below the ceiling are offered)
  // A crop at least COVER covered by embedded images is a raster page (ceiling: the images' own resolution). With more
  // than MAX_VECTOR_OPS painted paths and visible text runs on the page as well it is mixed, and its ceiling is the larger
  // of the images' resolution and MAX_DPI. (A scan's OCR text is invisible, so it doesn't count.)
  RASTER: { COVER: 0.9, MAX_VECTOR_OPS: 25 },
  // Browser safety limits only (not a resolution target). The render and every canvas made from it stay within both:
  // Firefox refuses a canvas side over 32,767 px; Chrome and desktop Safari refuse an area over 16,384² (268 MP) and older
  // Firefox about 11,180² (125 MP). MAX_PIXELS also bounds memory (a 100 MP canvas is 400 MB, and the save makes copies).
  // iOS Safari stops at 4,096² (16.8 MP): the workspace is desktop only. A render the browser can't make is reported.
  MAX_CANVAS_SIDE: 32000,
  MAX_PIXELS: 100e6,
  // The working render the sheet is placed on (the sheet pane and the map overlay) is smaller, for speed: close up, both
  // show the PDF itself rendered for the part in view at the screen's detail. The saved image keeps MAX_PIXELS.
  WORKING_MAX_PIXELS: 40e6,
  MIN_CROP_PT: 8, // the smallest crop, in PDF points
  PREVIEW_PX: 3000, // the whole-page preview used for cropping is about this many pixels on its long side
  // pdf.js (loaded from the CDN the first time the workspace opens, never at app start). The legacy build also runs on
  // browsers a little behind current. Bump VERSION only after trying a plan PDF.
  PDFJS: { VERSION: "6.4.299", BASE: "https://cdn.jsdelivr.net/npm/pdfjs-dist@6.4.299/" },
  // Sheet sizes the workspace can name (inches, short side first) and the stated scales offered as presets.
  SHEETS: [
    ["Letter", 8.5, 11], ["Tabloid", 11, 17], ["ANSI C", 17, 22], ["ANSI D", 22, 34], ["ANSI E", 34, 44],
    ["ARCH B", 12, 18], ["ARCH C", 18, 24], ["ARCH D", 24, 36], ["ARCH E1", 30, 42], ["ARCH E", 36, 48],
    ["A4", 8.27, 11.69], ["A3", 11.69, 16.54], ["A2", 16.54, 23.39], ["A1", 23.39, 33.11], ["A0", 33.11, 46.81],
  ],
  SCALE_PRESETS: [10, 20, 30, 40, 50, 60, 100, 200].map((perInch) => ({ perInch, unit: "ft", label: `1 in = ${perInch} ft` })),
  UNDO_STEPS: 80,
  SNAP_PX: 14, // a map click within this many pixels of a parcel corner snaps to it (Alt places freely)
};

// ---- Plans layer (hosted feature layer of georeferenced plans) ----
// The layer is not in the web map: the app loads it by item ID when it is first needed. With no ITEM_ID (empty, or a
// placeholder starting with PLANS_LAYER) the Plans features are off and everything else works.
export const PLANS = {
  ITEM_ID: "bc5d536d70444c7dbe3bf90906883ff4",
  LAYER_INDEX: 0,
  EXCLUDE_TITLES: [CALL_LOG_VIEW_TITLE], // layer titles whose features Plans never offers (the Call log view, section 51)
  COVER_MIN: 0.8, // a plan covering at least this share of the selected parcel is "on" it, otherwise "neighboring"
  // The plans search for a selected feature that isn't a parcel (a parcel keeps its own: shrunk by
  // WHATS_HERE.STRICT_TOLERANCE_FT, coverage COVER_MIN). A polygon is searched shrunk the same way and is "on" when a plan
  // covers COVER_MIN of it or COVER_MIN of the plan is inside it. A line is searched buffered by LINE_BUFFER_FT and is
  // "on" with at least LINE_MIN_OVERLAP_FT of it inside a plan; a point, buffered by POINT_BUFFER_FT, when a plan
  // contains it (digitized centerlines and points sit a little off the plans). The search shape is generalized by
  // QUERY_GENERALIZE_FT; coverage uses the full-precision geometry. At most MAX_PLANS are read.
  SEARCH: { LINE_BUFFER_FT: 15, POINT_BUFFER_FT: 10, LINE_MIN_OVERLAP_FT: 5, MAX_PLANS: 200, QUERY_GENERALIZE_FT: 1 },
  // Where map clicks snap to in the workspace for a subject that isn't a parcel: "selected" (its own vertices) and
  // "parcels_in_view" (parcel corners in view, only while the view is at most MAX_EXTENT_FT across, at most MAX_CORNERS).
  // A parcel keeps today's snapping (the parcel corners in view).
  SNAP: { SOURCES: ["selected", "parcels_in_view"], MAX_EXTENT_FT: 2500, MAX_CORNERS: 5000 },
  // The rough placement of a long sheet along a selected line (lineSeed.js): one whole-sheet placement at the stated
  // scale, fitted through points every SAMPLE_SPACING_FT of the line (internal, never pins). A line within
  // AUTO_START_TOL of the plan's length starts at its own start (or end, flipped) without a click.
  SEED: { SAMPLE_SPACING_FT: 100, AUTO_START_TOL: 0.1 },
  // Long road plans placed as a chain of pieces (chainFit.js): pins along the road cut the sheet, and each piece is fitted
  // rigidly between its two pins. FIT_EXACT_DEFAULT: "Fit pins exactly" (the scale follows the pins) starts ticked;
  // unticked, each piece keeps the stated scale and splits its miss between its pins. Two pins closer than MIN_PIN_PX
  // sheet pixels (columns) can't hold a piece. PIECE_OVERLAP_PX: extra source pixels on the right of each cut, against a
  // hairline gap. The readout is flagged when a piece's scale is off the stated one by more than WARN_SCALE_PCT, a seam
  // jogs at its pin by more than WARN_JOG_FT or at the sheet edges by more than WARN_EDGE_JOG_FT, or kinks by more than
  // WARN_KINK_DEG (guesses, to tune on real plans).
  CHAIN: {
    FIT_EXACT_DEFAULT: true, MIN_PIN_PX: 3, PIECE_OVERLAP_PX: 1, MAX_PINS: 16,
    WARN_SCALE_PCT: 0.5, WARN_JOG_FT: 2, WARN_EDGE_JOG_FT: 5, WARN_KINK_DEG: 0.5,
  },
  // Line weight (thicken.js): darker, thicker lines so a plan reads over imagery, for any plan, in the PNG only (the PDF
  // is never changed). PRESETS: Light / Medium / Heavy in points of added line weight at the plan's print scale (pixels =
  // pt x dpi / 72 at each size the budget search tries; tune by eye). LEVELS: the levels applied with any preset (at or
  // below BLACK goes black, at or above WHITE goes white, GAMMA between; THRESH when "Binarize" is ticked). COLOR false:
  // the image is made grey (smaller); true keeps colours (each channel thickened). DEFAULT: the starting choice.
  THICKEN: {
    PRESETS: { LIGHT: 0.35, MEDIUM: 0.7, HEAVY: 1.2 },
    // Sharpen: an unsharp mask at the saved image's own pixels, for fidelity without width (thicken.sharpenPlane). The
    // amount scales each pixel's difference from the mean around it (1 doubles it). With or without a line weight;
    // DEFAULT_SHARPEN is the amount a new plan starts with (0, off).
    SHARPEN: { LIGHT: 0.5, MEDIUM: 1, STRONG: 2 },
    DEFAULT_SHARPEN: 0,
    LEVELS: { BLACK: 90, WHITE: 225, GAMMA: 1, THRESH: 128 },
    COLOR: false,
    DEFAULT: "off",
  },
  // Field names on the layer, one place to rename them.
  FIELDS: {
    NAME: "plan_name", TYPE: "plan_type", DATE: "plan_date", STATUS: "status", NOTES: "notes", SUPERSEDES: "supersedes",
    SRC_PDF_NAME: "src_pdf_name", SRC_PAGE: "src_page", SHEET_SIZE: "sheet_size", STATED_SCALE: "stated_scale",
    WKID: "wkid", FIT_TYPE: "fit_type", TRANSFORM_JSON: "transform_json", WORLD_FILE: "world_file",
    RMS_FT: "rms_ft", LOO_RMS_FT: "loo_rms_ft", MAX_RES_FT: "max_res_ft", POINT_COUNT: "point_count",
    SNAPPED_COUNT: "snapped_count", ACCURACY_CLASS: "accuracy_class", IMG_WIDTH: "img_width", IMG_HEIGHT: "img_height",
    RENDER_DPI: "render_dpi", SCALE_FACTOR: "scale_factor", COMPRESS_TIER: "compress_tier", ORIG_BYTES: "orig_bytes",
    FINAL_BYTES: "final_bytes", TILE_COUNT: "tile_count", PDF_ATTACHED: "pdf_attached",
    // Added by hand in ArcGIS Online for long road plans; all allow null, and the code works while they don't exist yet
    // (a missing field reads as empty and isn't written). GROUP_ID: String 64, the same GUID on every piece of one plan
    // (empty: a one-piece plan). PIECE_NO: Integer, 1 to N in sheet order. SERVER_LOCATION: String 1,000, the full path of
    // the original PDF on the local server, written to every piece.
    GROUP_ID: "group_id", PIECE_NO: "piece_no", SERVER_LOCATION: "server_location",
  },
  TYPES: ["Subdivision", "Land development", "As-built", "Survey", "Stormwater", "Utility", "Other", "Capital Project - Paving"], // the plan type list
  NAME_MAX: 200, // field lengths on the layer
  NOTES_MAX: 1000,
  SERVER_LOCATION_MAX: 1000,
  // Whether "Attach source PDF" starts ticked. Off: the PDF stays on the server (SERVER_LOCATION) and the image gets the
  // whole byte budget. A plan being edited keeps the state it was saved with.
  ATTACH_SOURCE_PDF_DEFAULT: false,
  // transform_json longer than this goes in a georef.json attachment instead (the layer's own limit is whatever the field was made with)
  TRANSFORM_JSON_MAX_CHARS: 32000,
  LIST_MAX: 200, // plans read for one parcel
  REVIEW_MAX_PARCELS: 500, // parcels read when the Review step counts what a footprint covers
  // The saved image's resolution comes from this byte budget: the largest that fits, never above the page's native
  // detail. Every same-size form is tried first (as rendered, lossless, a 256-color palette, then JPEG for scans and
  // photos); only then is the size reduced, by a search on the byte ratio. Tiles are the last resort.
  COMPRESSION: {
    TARGET_BYTES: 9500000, // under 10 MB and under 10 MiB
    // "combined": the image gets TARGET_BYTES less the source.pdf when the PDF is attached ("Attach source PDF" ticked; the
    // limit is for both together), and all of TARGET_BYTES when it isn't;
    // "per_file": the image gets all of TARGET_BYTES. A PDF over TARGET_BYTES isn't attached, so then nothing is reserved.
    BUDGET: "combined",
    // The size search: the first step is s * sqrt(budget / bytes) * SAFETY, later ones use the measured byte curve; it
    // stops within TOLERANCE under the budget or after MAX_ATTEMPTS encodes, keeping the largest attempt that fit.
    SEARCH: { MAX_ATTEMPTS: 5, TOLERANCE: 0.03, SAFETY: 0.97 },
    PROBE_MAX_PIXELS: 12e6, // step 2's size estimate renders and encodes two probes of the crop, the larger at most this big
    JPEG_QUALITY_START: 0.95,
    JPEG_QUALITY_FLOOR: 0.85, // also the quality a JPEG is reduced in size at
    TILE_MAX_BYTES: 8000000, // each tile of a tiled plan
    TILE_MAX_SIDE_PX: 8192, // longest side of a tile (tiles only; a single image is shown downscaled to PLAN.MAX_DIM)
    FLAT_SHARE: 0.95, // linework with this share of its pixels in 16 colors counts as flat: it is reduced to a palette, never JPEG
  },
};

// ---- Plan mosaic (several plan views on one page, joined into one sheet: mosaic*.js, joinSeam.js) ----
export const MOSAIC = {
  // joinSeam.js thresholds, as in the prototype (reference/plan-tools/join): ink 0 = paper .. 1 = black. INK: what counts
  // as a line (grey CAD lines are about 0.4); TICK_INK: station ticks, often thin light-grey strokes. Auto join searches
  // views larger than REDUCED_MAX_DIM px on a reduced copy, then refines at full size.
  SEAM: { INK: 0.25, TICK_INK: 0.12, REDUCED_MAX_DIM: 1300 },
  // The clips are rendered for joining at JOIN_DPI (the prototype's 2x is 144 dpi), less where the PDF holds less or a
  // clip would pass JOIN_MAX_PIXELS. Only for the join: the mosaic is rendered from the PDF again for placing and saving.
  JOIN_DPI: 150,
  JOIN_MAX_PIXELS: 16e6,
  // Point pair and tick clicks snap to a corner or a line within this many screen pixels (Alt: no snap).
  SNAP_PX: 10,
};

// ---- Plan display (saved plans on the map, plansOnMap.js) ----
export const PLAN = {
  WKID: GEOREF.WORKING_WKID, // coordinate system of the world file: the one working CRS (2271, NAD83 / Pennsylvania North, ftUS)
  MAX_DIM: 4096, // longest side in pixels; bigger images are scaled down for the GPU
  OPACITY: 1, // a plan shown on the map starts at this, and its opacity slider resets to it
  PLACING_OPACITY: 0.7, // the sheet being placed in the georeferencing workspace (the map shows through it)
  // Zoomed in on a shown plan, the part in view is cut from the full-size saved image (planDetail.js). Full-size images
  // are decoded for that and kept, most recently used first, up to DETAIL_CACHE_MP megapixels (4 bytes each in memory).
  DETAIL_CACHE_MP: 64,
};

// ---- Notes (a historical note log for any selected feature: notesLogic.js, notesLayer.js, notesStore.js, notes.js) ----
// A hosted POINT layer created by hand in AGOL (append only: users add and update, never hard delete), loaded by item ID
// and never added to the map. With no ITEM_ID (empty, or a placeholder starting with NOTES_LAYER) the button is hidden,
// with one console warning.
// A note belongs to a feature by SOURCE_LAYER (a key below) and SOURCE_ID (the feature's ID value, exactly as built),
// never by object id, item ID or layer title, so the pop-up can later join on those two fields in Arcade.
// FIELDS: the app's own fields. The author and time come from editor tracking (the layer's editFieldsInfo), which must
// be on. STATUS: a note is never deleted; Retract sets it to RETRACTED.
// OPTIONAL_FIELDS: keys of FIELDS a layer may lack: without one, Notes works and leaves that part out (URL: no link input),
// with one console warning. URL: one optional link per note (noteUrl.js): at most URL_MAX_CHARS, URL_PROTOCOLS only;
// a link with no scheme that looks like a domain gets https://.
// ENTRY_TYPE, EVENT_DATE, ORIGIN, CHANGES: the activity log's fields (activityLogic.js). Without all four, a source's
// `activity` (field changes) is off and its notes are plain notes, with one warning and one status notice. Old rows
// with nulls read as ENTRY_TYPES.COMMENT, the creation date, ORIGINS.APP and no changes. FIELD_TYPES: a field's type
// when it isn't text.

// Names for the assignee list of the Citizen Requests activity (Jackson fills it). Typing another name stays allowed:
// the layer field is plain text.
export const ASSIGNEES = [];

export const NOTES = {
  ENABLED: true,
  ITEM_ID: "359b860d4ee54f9192124232591ce590",
  LAYER_INDEX: 0,
  FIELDS: {
    TEXT: "note_text", AUTHOR_NAME: "author_name", SOURCE_LAYER: "source_layer",
    SOURCE_ID: "source_id", SOURCE_ID_FIELD: "source_id_field",
    SOURCE_LABEL: "source_label", STATUS: "status", URL: "note_url",
    ENTRY_TYPE: "entry_type", EVENT_DATE: "event_date", ORIGIN: "origin", CHANGES: "changes_json",
    // The contact log (section 51). All nullable: old rows keep null. CONTACT: a logged phone call, email or visit
    // (entry_type contact); NAME, PHONE and EMAIL are personal: never in source_label, the dialog heading, the console or
    // a URL. LEGACY_ID: the Call Log record's GlobalID (the backfill only). FOLLOWUP: reaching back out to the customer;
    // DUE a date, TO the assignee's portal username, TO_NAME their full name (for display), OF on a closing entry: the
    // GlobalID of the entry whose follow-up it closes. Checked separately (contactLogic.checkContactFields): a missing
    // CONTACT field turns Log contact off, a missing FOLLOWUP field (or no GlobalID) turns follow-ups off.
    CONTACT: {
      METHOD: "contact_method", CUSTOMER_TYPE: "customer_type", TOPICS: "topics", PERMIT: "permit_submitted",
      NAME: "contact_name", PHONE: "contact_phone", EMAIL: "contact_email", STAFF: "staff_contact", LEGACY_ID: "legacy_id",
    },
    // TO_EMAIL (section 57): the assignee's email for a Power Automate flow, written when Atlas can find a valid one,
    // else null; never shown, logged or read back. Optional: without it on the layer, nothing is written and follow-ups
    // work as before.
    FOLLOWUP: { DUE: "followup_due", TO: "followup_to", TO_NAME: "followup_to_name", OF: "followup_of", TO_EMAIL: "followup_to_email" },
  },
  OPTIONAL_FIELDS: ["URL", "ENTRY_TYPE", "EVENT_DATE", "ORIGIN", "CHANGES"],
  ACTIVITY_FIELDS: ["ENTRY_TYPE", "EVENT_DATE", "ORIGIN", "CHANGES"],
  FIELD_TYPES: { EVENT_DATE: "date" },
  ENTRY_TYPES: { COMMENT: "comment", CHANGE: "change", SNAPSHOT: "snapshot", CONTACT: "contact" },
  ORIGINS: { APP: "app", IMPORT: "import", DETECTED: "detected" },
  // How imported entries (origin import: the Call Log backfill and the requests snapshots) stand out in the timeline,
  // beyond their "Imported" tag (section 55): a rule down the left edge and a faint tint behind the whole entry. Any CSS
  // color, ideally a Calcite token so dark mode follows. Retracted entries are greyed on top of this; detected entries
  // keep the plain look. The candidates compared are in docs/notes-imported-candidates.png.
  STYLE: {
    IMPORTED: { RULE_WIDTH: "3px", RULE_COLOR: "var(--calcite-color-status-info)",
      TINT: "color-mix(in srgb, var(--calcite-color-status-info) 7%, var(--calcite-color-foreground-1))" },
  },
  // Files on an entry (section 55): every Notes source, Note and Contact mode. The notes layer's attachments (it must
  // support them; without, no file controls and one console warning). MAX_FILES per entry; MAX_BYTES per file (hosted
  // attachments are capped near 10 MB). ACCEPT: the extensions allowed and the content types each may carry (the browser
  // may give none, or application/octet-stream, which is fine); kept conservative, AGOL blocks some types. Only
  // INLINE_TYPES are ever shown inline (thumbnails, the lightbox), decided by the stored content type, never the name;
  // every other file (SVG and HTML among them) is download only. RESIZE: a photo (RESIZABLE_TYPES) larger than
  // ABOVE_BYTES whose long side is over MAX_SIDE is redrawn on a canvas as a JPEG at QUALITY, its orientation kept; this
  // also drops its EXIF data (location included). Other files are never changed. THUMB_PX: a thumbnail's box.
  ATTACH: {
    MAX_FILES: 5,
    MAX_BYTES: 9.5 * 1024 * 1024,
    ACCEPT: {
      png: ["image/png"], jpg: ["image/jpeg"], jpeg: ["image/jpeg"], gif: ["image/gif"], webp: ["image/webp"],
      pdf: ["application/pdf"],
      docx: ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
      xlsx: ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
      msg: ["application/vnd.ms-outlook"], eml: ["message/rfc822"],
      csv: ["text/csv", "application/vnd.ms-excel"], txt: ["text/plain"],
    },
    INLINE_TYPES: ["image/png", "image/jpeg", "image/gif", "image/webp"],
    RESIZABLE_TYPES: ["image/png", "image/jpeg", "image/webp"],
    RESIZE: { ENABLED: true, MAX_SIDE: 2048, QUALITY: 0.85, ABOVE_BYTES: 1.5 * 1024 * 1024 },
    THUMB_PX: 96,
    // a file chip's Calcite icon by extension (any other: "file")
    ICONS: { pdf: "file-pdf", docx: "file-word", xlsx: "file-excel", csv: "file-csv", txt: "file-text", msg: "envelope", eml: "envelope",
      png: "file-image", jpg: "file-image", jpeg: "file-image", gif: "file-image", webp: "file-image" },
    TEXT: {
      REJECT_TYPE: "This kind of file can't be attached. Images, PDF, Word, Excel, Outlook email, CSV and text files can.",
      REJECT_MISMATCH: "The file's type doesn't match its name.",
      REJECT_EMPTY: "The file is empty.",
      REJECT_SIZE: (max) => `Too large: a file can be at most ${max}.`,
      REJECT_COUNT: (n) => `An entry can have at most ${n} files.`,
      HAS_FILES: (n) => `${n} file${n === 1 ? "" : "s"} attached`,
      OPEN_IMAGE: (name) => `Open ${name || "image"}`,
      DOWNLOAD: (name) => `Download ${name || "file"}`,
      LOAD_FAILED: "Couldn't load",
      RETRY: "Retry",
      UNNAMED: "file",
      // the composer's Files row and the upload
      FILES_LABEL: "Files (optional)",
      ADD_FILES: "Add files",
      FILES_HINT: (n, max) => `Up to ${n}, ${max} each. Drop files here or paste a screenshot into the note.`,
      REMOVE: (name) => `Remove ${name}`,
      PREPARING: "Preparing…",
      RESIZED: (px) => `Resized to ${px} px`,
      NOT_UPLOADED: "Didn't upload",
      PASTED_NAME: (stamp, ext) => `Screenshot ${stamp}.${ext}`,
      UPLOADING: (i, n) => `Uploading ${i} of ${n}…`,
      UPLOAD_FAILED: (failed, total, names) => `Entry saved. ${failed} of ${total} file${total === 1 ? "" : "s"} did not upload: ${names}.`,
      RETRY_UPLOAD: "Retry",
      CLOSE_FAILED_ASK: "Some files didn't upload. Close anyway? The entry is saved without them.",
      CLOSE_FAILED_YES: "Close without them",
    },
  },
  // The activity timeline: at most TIMELINE_MAX entries of a feature are read (sorted in the app by event date, else the
  // creation date, since old rows have no event date); "logged <time>" shows when an entry's event and creation dates
  // differ by more than LATE_LOG_MS. CHANGES_MAX_CHARS: changes_json is cut to fit (long values shortened, flagged), or
  // to the layer field's length if that is shorter. A failed log entry is tried again once after RETRY_DELAY_MS.
  ACTIVITY: { TIMELINE_MAX: 500, LATE_LOG_MS: 86400000, CHANGES_MAX_CHARS: 10000, RETRY_DELAY_MS: 1000 },
  URL_MAX_CHARS: 1000,
  URL_PROTOCOLS: ["https:", "http:"],
  // Layer titles that are never a Notes subject (checked before the fallback): the "Call log" view of the notes layer
  // itself (section 51), so a logged contact can't get notes of its own.
  EXCLUDE_TITLES: [CALL_LOG_VIEW_TITLE],
  // ---- The contact log (section 51): Log contact in the Notes dialog, follow-ups, and the Follow-ups block.
  // SOURCES: the NOTES.SOURCES keys that offer Log contact (the composer is source-neutral: another source is a config
  // change). The codes and labels of contact_method, customer_type and permit_submitted come from the notes layer's
  // domains, read on every load (Jackson edits them in AGOL; a stored code no longer in a domain shows as the raw code).
  // METHOD_ICONS: a Calcite icon per contact_method code (DEFAULT_ICON for any other). TOPICS: topics is a comma list,
  // so it can't carry a domain: its codes and labels, in form order (codes as the Call Log stores them; the backfill's
  // dry run prints the real ones). REQUIRE: field names that must be set before Add contact (the note is optional).
  // STAFF_SOURCE.GROUP_ID: an AGOL group whose members are the follow-up assignees, instead of the organization's
  // members (null). STAFF_PAGE: users per portal query page. FOLLOWUP: DEFAULT_DAYS from today for a new follow-up's
  // due day; POLL_MINUTES between checks for my follow-ups; DUE_HOUR: the hour of the due day stored (noon, so the day
  // reads the same in any time zone). No usernames or names here: the repo is public.
  CONTACT: {
    SOURCES: ["parcels"],
    METHOD_ICONS: { "Phone Call": "phone", Email: "envelope", "In-person": "walking", "Citizen Request Center": "speech-bubbles" },
    DEFAULT_ICON: "speech-bubble",
    TOPICS: [
      { code: "Zoning Residential", label: "Zoning residential" },
      { code: "Zoning Commercial", label: "Zoning commercial" },
      { code: "Economic Development", label: "Economic development" },
      { code: "Enforcement", label: "Enforcement" },
      { code: "Other", label: "Other" },
    ],
    REQUIRE: ["contact_method"],
    STAFF_SOURCE: { GROUP_ID: "b458fc405d4840a985cca02194282ea8" },
    STAFF_PAGE: 100,
    // Where a new follow-up's followup_to_email comes from (section 57), in order; the first valid address wins, else
    // null (never guessed, never built from a username). "portal": the assignee's PortalUser.email from the staff list's
    // own search (an org admin sees everyone's; others see only their own). "roster": the table below.
    EMAIL_SOURCES: ["portal", "roster"],
    // A hosted table Jackson keeps (one row per staff member), read once per session with the user's own sign-in and
    // matched on the username exactly (case ignored), never on a name. ITEM_ID (and LAYER_INDEX) or URL; both null: no
    // roster. FIELDS: the table's field names.
    ROSTER: { ITEM_ID: "9dac20e1151042c1b27fbeb3fb013268", LAYER_INDEX: 0, URL: null, FIELDS: { USERNAME: "username", NAME: "full_name", EMAIL: "email" } },
    FOLLOWUP: { DEFAULT_DAYS: 2, POLL_MINUTES: 10, DUE_HOUR: 12 },
    MODE_KEY: "parcelviewer.notesComposerMode", // the last composer mode (Note | Contact), per browser
    DAY_FORMAT: { month: "short", day: "numeric" }, // a follow-up's day ("Nov 6"), Intl.DateTimeFormat options
    // What the composer accepts in the customer's phone and email (empty is always fine). PHONE: a US number, 10 digits
    // (+1 or 1 may come first) with spaces, dots or dashes and the area code optionally in brackets, then an optional
    // extension ("x12", "ext. 12"). EMAIL: name@domain.tld, no spaces, no dot at either end of the name or two in a row.
    PATTERNS: {
      PHONE: /^(?:\+?1[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]?\d{3}[\s.-]?\d{4}(?:\s*(?:x|ext\.?|extension)\s*\d{1,6})?$/i,
      EMAIL: /^[A-Za-z0-9%+_-]+(?:\.[A-Za-z0-9%+_-]+)*@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*\.[A-Za-z]{2,}$/,
    },
    TEXT: {
      MODE_NOTE: "Note",
      MODE_CONTACT: "Contact",
      MODE_LABEL: "What to add",
      NEW: "Add note or contact",
      ADDED: "Contact added",
      WHEN: "When",
      WHEN_DATE: "Date of the contact",
      WHEN_TIME: "Time of the contact",
      METHOD: "Method",
      CUSTOMER_TYPE: "Customer type",
      TOPICS: "Topics",
      WHO: "Add customer details",
      NAME: "Name",
      PHONE: "Phone",
      EMAIL: "Email",
      PHONE_EXAMPLE: "814-555-0123",
      // how a valid phone number is shown and stored (contactLogic.formatPhone, section 58): "(area) exchange-line",
      // then " ext. N" for an extension
      PHONE_FORMAT: (area, exchange, line) => `(${area}) ${exchange}-${line}`,
      PHONE_EXT: (ext) => ` ext. ${ext}`,
      EMAIL_EXAMPLE: "name@example.com",
      EMAIL_BAD: "Enter an email address like name@example.com.",
      PHONE_BAD: "Enter a 10-digit number, like 814-555-0123.",
      PERMIT: "Permit or application submitted",
      PERMIT_YES: "Yes",
      PERMIT_NO: "No",
      PERMIT_UNASKED: "Not asked",
      STAFF: "Staff contact",
      STAFF_HINT: "Who spoke with the customer",
      NOTE_LABEL: "What was discussed",
      NOTE_PLACEHOLDER: "Optional",
      NEEDS_FOLLOWUP: "Needs a follow-up",
      ASSIGNEE: "Assign to",
      DUE: "Due by",
      STAFF_ME: (name) => `Me (${name})`,
      STAFF_FAILED: "Couldn't load the staff list. You can assign to yourself.",
      EMAIL_FIELD_MISSING: "The notes layer has no followup_to_email field (NOTES.FIELDS.FOLLOWUP.TO_EMAIL), so follow-ups are saved without the assignee's email.",
      ROSTER_FAILED: "Couldn't read the staff roster (NOTES.CONTACT.ROSTER); follow-up emails come from the portal only this session:",
      STAFF_FOUND: (n) => `Assignee list: ${n} members found; members with a private profile are not listed.`,
      STAFF_FOUND_GROUP: (n) => `Assignee list: ${n} members of NOTES.CONTACT.STAFF_SOURCE.GROUP_ID.`,
      // viewer.followups.emailProbe() (section 57): counts only, never an address or a username
      EMAIL_PROBE: ({ members, withEmail, admin, ok }) => `Email probe: ${members} member${members === 1 ? "" : "s"} in the assignee list, ${withEmail} with an email visible (you included); signed in as an admin: ${admin ? "yes" : "no"}${ok ? "" : "; the staff list couldn't be read"}.`,
      STAFF_PLACEHOLDER: "Type a name",
      ADD: "Add contact",
      SHORTCUT: "Ctrl+Enter adds the contact.",
      REQUIRED: (labels) => `Choose ${labels.join(" and ").toLowerCase()} first.`,
      FOLLOWUP_INCOMPLETE: "A follow-up needs a person and a day.",
      SPOKE_WITH: (name) => `Spoke with: ${name}`,
      CUSTOMER: "Customer",
      PERMIT_LINE: (label) => `Permit or application submitted: ${label}`,
      FOLLOW_UP_BY: (day, who) => `Follow up by ${day}${who ? ` · ${who}` : ""}`,
      STATE_OPEN: "Open",
      STATE_OVERDUE: "Overdue",
      STATE_DONE: (day, who) => `Done ${day}${who ? ` by ${who}` : ""}`,
      STATE_CLOSED: (day, who) => `Closed ${day}${who ? ` by ${who}` : ""}`,
      CLOSES: (day) => `Closed follow-up from ${day}`,
      CLOSES_LINK: "Show it",
      MARK_DONE: "Mark done",
      CLOSE_NO_CONTACT: "Close without contact",
      REASSIGN: "Reassign",
      FOLLOWUP_MENU: "Follow-up actions",
      CLOSE_REASON: "Why it's closed (one line)",
      CLOSE_REASON_NEEDED: "Type a reason first.",
      CLOSE_YES: "Close follow-up",
      CLOSE_NO: "Cancel",
      REASSIGN_TO: "Reassign to",
      REASSIGN_YES: "Reassign",
      REASSIGNED: (name) => `Reassigned to ${name}`,
      CLOSING_FOR: (day) => `Closing the follow-up from ${day}`,
      CLOSING_CANCEL: "Don't close it",
      CONTACT_OFF: "The notes layer lacks contact fields, so Log contact is off. Notes still work.",
      FOLLOWUPS_OFF: "The notes layer lacks follow-up fields or a GlobalID, so follow-ups are off. Contacts still work.",
      HEADER: (n) => `Follow-ups (${n})`,
      HEADER_TITLE: (n, overdue) => `${n} open follow-up${n === 1 ? "" : "s"} for you${overdue ? `, ${overdue} overdue` : ""}`,
      BLOCK: "Follow-ups",
      TAB_MINE: "Mine",
      TAB_ALL: "All open",
      LIST_EMPTY_MINE: "No open follow-ups for you.",
      LIST_EMPTY_ALL: "No open follow-ups.",
      LIST_LOADING: "Loading follow-ups…",
      LIST_FAILED: (message) => `Couldn't load the follow-ups: ${message}`,
      LIST_REFRESH: "Refresh",
      DUE_ON: (day) => `Due ${day}`,
      NOT_PARCEL: (label) => `${label} can't be opened from here.`,
    },
  },
  STATUS: { ACTIVE: "Active", RETRACTED: "Retracted" },
  MAX_CHARS: 4000,
  PAGE_SIZE: 50,
  COUNT_DEBOUNCE_MS: 300, // the count is asked this long after the selection settles
  LOADER_DELAY_MS: 250,
  // Which layers take notes, matched in this order. THE KEYS NEVER CHANGE ONCE NOTES EXIST: they are stored in every
  // note's source_layer. A parcel is matched as the panel's parcel (the parcel layer's title is renamed for the session);
  // roads by SEARCH.ROAD.LAYER_TITLE, or, while that is null, the layer Road search found; the others by their web map
  // title. idFields: the ID, as stored. With `join`, all of them are parts of one ID joined with it, empty and null parts
  // skipped (a road's full street name: every segment of a street shares its notes, `group`); without, the first one the
  // layer has ("OBJECTID" stands for the layer's object id field, flagged as able to change on an overwrite).
  // `title: null` is unconfirmed: that source takes no notes, and FALLBACK stays off, so a note is never written under
  // the wrong key before the title is set. noun: "No notes yet for this {noun}."
  // label: how the dialog names the feature and what is stored in source_label: prefix + the first non-empty value of
  // `fields`. Never a personal field (a requester's name): source_label is stored in the notes layer. Without a rule, the
  // layer's display field is the last fallback; anything empty or with a brace becomes "#<object id>".
  SOURCES: [
    { key: "parcels", parcel: true, idFields: [SEARCH.ID_FIELD], label: { fields: PARCEL_PANEL.TITLE_FIELDS, prefix: "" }, noun: "parcel" },
    { key: "roads", road: true, title: SEARCH.ROAD.LAYER_TITLE, idFields: SEARCH.ROAD.NAME_FIELDS, join: " ", group: true, noun: "street" },
    { key: "stormpipes", title: 'Storm Pipes', idFields: ["GlobalID", "OBJECTID"], noun: "pipe" }, // title: Jackson confirms
    { key: "inlets", title: 'Storm Structures', idFields: ["GlobalID", "OBJECTID"], noun: "inlet" },
    // activity: notes with field changes (the activity log). edits: the fields staff change from the dialog, each with a
    // key (for chips), the layer field, its label and input ("domain": the field's coded values, every one always
    // available; "list": `list` names plus free typing; "text"), public: shown to the public (a "Public" tag), collapsed:
    // hidden behind a link unless it has a value, a chip expands it or the status is set to a closed one. Field
    // names starting with REQUESTS_ are placeholders until Jackson confirms them: while any is, field changes are off
    // for this layer (its notes still work), with one console warning listing the layer's real fields.
    // closedStatuses: status codes that mean closed ("Resolved in 5 days"); receivedField: the Survey123 submission time
    // ("Request received"); legacyNotesField: the layer's own notes text. chips: one click sets fields (never submits);
    // "@me" is the signed-in user's full name; expand opens a collapsed field.
    // editsEnabled: false turns the field changes off (no status, assignee or resolution rows, no chips, no stale check:
    // the composer is the plain note box). The timeline, its change lines, "Open for N days" and "Request received" stay.
    { key: "requests", title: 'Citizen Requests', idFields: ["reqid"], label: { fields: ["reqid"], prefix: "Request " }, noun: "request",
      activity: {
        editsEnabled: false, // watch, don't edit (Jackson, 2026-11-04); the code stays for later
        edits: [
          { key: "status", field: "status", label: "Status", input: "domain" },
          { key: "assignedTo", field: "assignedto", label: "Assigned to", input: "list", list: ASSIGNEES },
          { key: "resolution", field: "resolution", label: "Resolution", input: "text", public: true, collapsed: true },
        ],
        closedStatuses: ["Completed", "Cancelled"], // Jackson confirms the codes
        receivedField: "status",
        legacyNotesField: "notes",
        chips: [
          { label: "Assigned to me", set: { assignedTo: "@me" } },
          { label: "Resolved", set: { status: "Completed" }, expand: "resolution" },
        ],
      } },
  ],
  // Any other layer (the weaker fallback): key "<portal item id>:<layerId>", ID the first of PREFER the layer has.
  FALLBACK: { ENABLED: true, PREFER: ["GlobalID", "OBJECTID"], NOUN: "feature" },
  DATE_FORMAT: { dateStyle: "medium", timeStyle: "short" }, // Intl.DateTimeFormat options, in the user's locale
  // The entry list as a vertical timeline, newest first (section 56): a date column, a rail (one line with a dot per
  // entry, year pills where the year changes, "Newest" at the top, "Oldest" or "Show older notes" at the bottom) and a
  // card per entry. Widths and spaces are CSS lengths. Below STACK_BELOW of list-pane width the date moves above its
  // card ("Nov 9, 2026 · 2:14 PM") and the rail stays on the left edge. DAY, TIME, LOGGED: Intl.DateTimeFormat options.
  TIMELINE: {
    DATE_WIDTH: "7.5rem",
    // RAIL_WIDTH, DOT_SIZE and HOLLOW_SIZE odd and LINE_WIDTH odd (section 60): the rail's middle is then on a half pixel,
    // as are the dots' and a 3px line's, so line and dots sit on whole pixels and line up exactly
    RAIL_WIDTH: "29px",
    GAP: "14px", // between entries
    CARD_PADDING: "8px 12px",
    DOT_SIZE: "13px", // a filled dot (app, detected, comments, changes, contacts) in the accent color
    HOLLOW_SIZE: "11px", // an imported entry's hollow dot, with a RING_WIDTH ring in the secondary text color
    RING_WIDTH: "2px",
    // the rail leads (section 60): the thickest and darkest line on the timeline, near black in light mode and near white
    // in dark mode. A Calcite token or #rrggbb.
    LINE_WIDTH: "3px",
    RAIL_COLOR: "--calcite-color-text-1",
    STACK_BELOW: "30rem",
    // Follow-up brackets (section 57): a second, smaller rail between the main rail and the cards that joins a
    // follow-up chain (a contact, its closings, a Reassign and its call back), with a tick to each member's card. Lane 0
    // is nearest the cards; the lanes take room only when the loaded list has a chain. A chain that gets no lane (more
    // than MAX_LANES overlapping) has no bracket; its cards keep their text lines.
    FOLLOWUP: {
      SHOW: true,
      MAX_LANES: 3,
      LANE_WIDTH: "10px", // per lane used
      // the bracket line, its ticks and the stub (square corners): thinner than the rail (LINE_WIDTH above). 1px, placed on
      // whole pixels, is one device pixel on an ordinary screen; 1.5px drew two there, as thick as the rail (section 58)
      LINE_WIDTH: "1px",
      TICK_GAP: "0px", // between a tick's end and the card's edge
      OPEN_STUB: "1.5rem", // the dashed line up from an open follow-up's tick (it stops at the "Newest" row)
      DASH: "4px", // the dash and gap of the stub and of an end that runs on to "Show older notes"
      // A chain's line, ticks and open stub take its lane's color, so overlapping brackets (always in different lanes)
      // are easy to trace. Soft on purpose (section 60), so the rail leads: muted blue, sage green and ochre, told apart
      // from each other, from the rail and from OVERDUE_COLOR, each at least 3:1 against the list's background in both
      // modes (the table in section 60). Each is a Calcite token, a #rrggbb, or { LIGHT, DARK } for one per mode. The state
      // is not the line's color: an open follow-up's stub is in the lane color, an overdue one's in OVERDUE_COLOR (the
      // Follow-ups count's warning color), and a done chain has no stub.
      LANE_COLORS: [
        { LIGHT: "#5b84ad", DARK: "#86a9cc" },
        { LIGHT: "#4f8a66", DARK: "#79b08f" },
        { LIGHT: "#94763a", DARK: "#c4a66a" },
      ],
      OVERDUE_COLOR: "--calcite-color-status-danger",
    },
    DAY: { month: "short", day: "numeric", year: "numeric" },
    TIME: { hour: "numeric", minute: "2-digit" },
    LOGGED: { month: "short", day: "numeric" }, // "logged Nov 2"; the year is added when it differs from the event's
    TEXT: {
      NEWEST: "Newest",
      OLDEST: "Oldest",
      LIST_LABEL: "Entries, newest first",
      YEAR_LABEL: (year) => `${year}`,
      LOGGED: (day) => `logged ${day}`,
      SEPARATOR: " · ",
    },
  },
  // A link that opens one entry (section 57): <app URL>?entry=<GlobalID>, for the follow-up email. The GlobalID only:
  // nothing else about the entry goes in the URL.
  LINK: {
    PARAM: "entry",
    TEXT: {
      NOT_FOUND: "Couldn't find that entry.",
      NOT_FOUND_DETAIL: "The link may be old, or you may not have access to the activity log.",
      BAD: (param) => `?${param}= isn't a GlobalID; it is ignored.`,
    },
  },
  DIALOG_WIDTH: "40rem", // never wider than the window less 32px (38rem until section 60)
  // with the composer open beside the list (section 52; 76rem since section 60): two panes, and the height they share
  DIALOG_WIDTH_SPLIT: "76rem",
  // the two panes in the split view (section 60): each with its own background, a full-height divider between them,
  // and a small heading at the top of each (TEXT.PANE_COMPOSE, TEXT.PANE_LIST). Calcite tokens or #rrggbb.
  SPLIT: {
    COMPOSE_BACKGROUND: "--calcite-color-foreground-2",
    LIST_BACKGROUND: "--calcite-color-foreground-1",
    DIVIDER_COLOR: "--calcite-color-border-1",
    DIVIDER_WIDTH: "1px",
  },
  DIALOG_HEIGHT_SPLIT: "calc(100vh - 64px)",
  TEXT: {
    BUTTON: "Activity Log",
    PANE_COMPOSE: "New entry", // the split view's pane headings (section 60)
    PANE_LIST: "History",
    BUTTON_COUNT: (n) => `Activity Log (${n})`,
    HEADING: (label) => `Activity Log: ${label}`,
    ALL_SEGMENTS: (street) => `${street}, all segments`,
    PLACEHOLDER: "Add a note",
    NEW: "Add note",
    ADD: "Add note",
    CANCEL: "Cancel",
    CANCEL_ASK: "Discard what you've typed?",
    CANCEL_YES: "Discard",
    ADDING: "Adding…",
    SHORTCUT: "Ctrl+Enter adds the note.",
    EMPTY_TEXT: "Type a note first.",
    TOO_LONG: (max) => `A note can have at most ${max.toLocaleString()} characters.`,
    ADD_FAILED: (message) => `Couldn't add the note: ${message}`,
    READ_ONLY: "You can read notes. Your account can't add them.",
    LOADING: "Loading notes…",
    LOAD_FAILED: (message) => `Couldn't load the notes: ${message}`,
    EMPTY: (noun) => `No notes yet for this ${noun}.`,
    SHOW_OLDER: "Show older notes",
    SHOW_RETRACTED: (n) => `Show retracted (${n})`,
    RETRACTED_TAG: "Retracted",
    RETRACTED_AT: (when) => `Retracted ${when}`,
    RETRACT: "Retract",
    RETRACT_ASK: "Retract this note? It stays in the history, greyed, and leaves the count.",
    RETRACT_YES: "Retract",
    RETRACT_NO: "Keep",
    RETRACT_FAILED: (message) => `Couldn't retract the note: ${message}`,
    UNKNOWN_AUTHOR: "Unknown author",
    DISCARD_ASK: "You have a note that isn't added yet. Close anyway? It is kept as a draft until you reload the page.",
    DISCARD_YES: "Close",
    DISCARD_NO: "Keep writing",
    CLOSE: "Close",
    LAYER_UNAVAILABLE: "Notes layer unavailable",
    LINK_LABEL: "Link (optional)",
    LINK_PLACEHOLDER: "https://...",
    LINK_SPACES: "A link can't contain spaces.",
    LINK_PATH: "File and network paths can't be links (work PCs block them). Use a web address.",
    LINK_SCHEME: "Only http and https links are allowed.",
    LINK_CREDENTIALS: "A link can't contain a user name or password.",
    LINK_TOO_LONG: (max) => `A link can have at most ${max.toLocaleString()} characters.`,
    LINK_INVALID: "This isn't a web address.",
    // the activity log
    NONE: "(none)",
    NOTE_OR_CHANGE: "Type a note or change a field.",
    HINT_NO_NOTE: "Add a sentence for context.",
    PREVIEW: (text) => `Will record: ${text}`,
    CURRENT: (value) => `Now: ${value}`,
    CHANGED: "Changed",
    UNDO_FIELD: "Undo",
    PUBLIC_TAG: "Public",
    PUBLIC_TITLE: "Shown to the public",
    SHOW_FIELD: (label) => `Edit ${label.toLowerCase()}`,
    HAPPENED_ON: "Happened on",
    HAPPENED_LINK: "Happened earlier?",
    RECEIVED: "Request received",
    SNAPSHOT: "State when the log started",
    LEGACY_NOTES: "The request's notes field",
    TAG_IMPORTED: "Call Log Import",
    TAG_DETECTED: "Detected change",
    LOGGED_AT: (when) => `logged ${when}`,
    OPEN_FOR: (days) => (days < 1 ? "Open for less than a day" : `Open for ${days} day${days === 1 ? "" : "s"}`),
    RESOLVED_IN: (days) => (days < 1 ? "Resolved the same day" : `Resolved in ${days} day${days === 1 ? "" : "s"}`),
    STALE: (who, when) => `This request was changed by ${who || "someone"} at ${when}. Review and try again.`,
    STALE_LINE: (label, value) => `${label} is now ${value}.`,
    REQUEST_FAILED: (message) => `Couldn't save the request: ${message}`,
    LOG_FAILED: (message) => `The request was saved, but its log entry wasn't: ${message}`,
    RETRY_LOGGING: "Retry logging",
    RETRACT_ASK_CHANGE: "Retract this entry? This hides the entry. It does not undo the change.",
    ACTIVITY_READ_ONLY: "Your account can add notes but can't change this request.",
    BAD_CHANGES: "Changes recorded in a form this app can't read:",
    EDITS_OFF: (title) => `${title}: field edits are off (NOTES activity.editsEnabled).`,
    ACTIVITY_FIELDS_MISSING: "The notes layer has no activity log fields yet (entry_type, event_date, origin, changes_json), so notes can't record field changes. Notes still work.",
  },
};

// ---- Attribute table (attributeTable.js; section 50) ----
// A table pane docked under the map for any layer with a pop-up (the "Open table" action in Layers). Read only. Open
// tables are session only; the pane height, column changes and the view preferences are kept per browser.
// Rows: the layer's ordered object id list (queried once per where / sort / extent), then pages of PAGE_SIZE rows by id,
// at most PAGE_CACHE pages kept per tab. OVERSCAN rows are drawn above and below the view.
// Selection: MAX_SELECT ids at most (Select all, Ctrl+A); MAX_DRAWN of them drawn on the map (first in table order), in
// the highlight color with SELECTION_SYMBOL (thinner than the active outline, HIGHLIGHT.OUTLINE); geometry generalized
// to the view, full precision past SELECTION_FULL_PRECISION_SCALE. HOVER: the row under the pointer emphasized on the
// map after DELAY_MS (CACHE geometries kept per tab). Zoom to selected: the extent times ZOOM_EXPAND; one point at
// POINT_ZOOM_SCALE.
// Columns (section 8 of the brief): the user's own changes, else the shared setup saved in Map Viewer (the layer's
// attributeTableTemplate), else the pop-up's fields, else all fields. AUTO_HIDE (regular expressions, case-insensitive,
// matched against field names) are hidden in the last two cases, with the object id, guid fields and editor tracking.
// LAYERS: rare overrides by stable layer key ("<service url>/<layer id>"): { widths: { field: px }, freeze: "field" }.
export const TABLE = {
  ENABLED: true,
  PAGE_SIZE: 100,
  PAGE_CACHE: 20,
  OVERSCAN: 10,
  ROW_HEIGHT: { compact: 28, comfortable: 36 },
  DEFAULT_DENSITY: "compact",
  STRIPES: true,
  MAX_SELECT: 10000,
  MAX_DRAWN: 7000,
  SELECTION_FULL_PRECISION_SCALE: 2400,
  SELECTION_BATCH: 2000, // ids per geometry query (never above the layer's maxRecordCount)
  SELECTION_SYMBOL: { WIDTH: 2, CASING_WIDTH: 3.5, CASING_ALPHA: 0.7, RING_SIZE: 12 },
  HOVER: { ENABLED: true, DELAY_MS: 150, CACHE: 200 },
  ZOOM_EXPAND: 1.2,
  POINT_ZOOM_SCALE: 1200,
  EXTENT_DEBOUNCE_MS: 400,
  SEARCH: { MIN_CHARS: 2, DEBOUNCE_MS: 300 },
  ID_PAGE: 2000, // ids per request when the id list has to be read in pages (a server that ignores the sort for ids)
  ORDER_CHECK_ROWS: 50, // rows compared once per layer to learn whether the server sorts the id list
  COPY_MAX_ROWS: 500,
  EXPORT_MAX_ROWS: 20000,
  EXPORT_PAGE: 1000, // rows per request while preparing a download
  LOADER_DELAY_MS: 250,
  PANE: { DEFAULT_PERCENT: 40, MIN_PX: 120, MIN_MAP_PX: 160, COLLAPSED_PX: 40, KEY_STEP_PX: 10, KEY_STEP_BIG_PX: 50, STORAGE_KEY: "parcelviewer.tablePaneHeight" },
  COL: { MIN_PX: 60, MAX_PX: 480, DEFAULT_PX: 140, PAD_PX: 24, AUTO_WIDTH_PERCENTILE: 0.9, CHECK_PX: 34, FREEZE_FIRST: true, STORAGE_KEY: "parcelviewer.tableColumns" },
  AUTO_HIDE: ["^Shape__", "^GlobalID$", "^Shape_Length$", "^Shape_Area$", "^Shape\\.(STArea|STLength)\\(\\)$"], // plus the object id, guid fields and editFieldsInfo fields
  LAYERS: {}, // rare overrides by stable layer key: { widths: { field: px }, freeze: "field" } (section 8c)
  PREFS_KEY: "parcelviewer.tablePrefs", // density, stripes, hover
  TEXT: {
    OPEN: "Open table",
    PANE_LABEL: "Attribute table",
    TABS_LABEL: "Open tables",
    CLOSE_TAB: "Close this table",
    COLLAPSE: "Collapse the table",
    RESTORE: "Restore the table",
    MAXIMIZE: "Maximize the table",
    UNMAXIMIZE: "Restore the table's height",
    CLOSE_ALL: "Close all tables",
    CLOSE_ALL_ASK: (n) => `Close all ${n} tables?`,
    SPLITTER: "Resize the table",
    SEARCH: "Search this table",
    SEARCH_HINT: (n) => `Type ${n} or more characters`,
    ZOOM_SELECTED: "Zoom to selected",
    SELECTED_ONLY: "Show selected only",
    CLEAR_SELECTION: "Clear selection",
    NOTHING_SELECTED: "Select rows first",
    SELECTED_CHIP: (n) => `${n.toLocaleString("en-US")} selected`,
    MAP_EXTENT: "Map extent",
    MAP_EXTENT_TIP: "Only rows in the map's current extent",
    COLUMNS: "Columns",
    DOWNLOAD: "Download",
    MORE: "More",
    DENSITY: "Row height",
    COMPACT: "Compact",
    COMFORTABLE: "Comfortable",
    STRIPES: "Striped rows",
    HOVER: "Highlight on hover",
    RESET_COLUMNS: "Reset columns",
    CHIP_EXTENT: "Map extent",
    CHIP_SELECTED: "Selected only",
    CHIP_SEARCH: (text) => `Search: ${text}`,
    CHIP_REMOVE: "Remove this filter",
    ROWS: (n) => `${n.toLocaleString("en-US")} row${n === 1 ? "" : "s"}`,
    FOOT_SELECTED: (n, hidden) => `${n.toLocaleString("en-US")} selected${hidden ? `, ${hidden.toLocaleString("en-US")} not shown` : ""}`,
    FOOT_EXTENT: "Map extent on",
    FOOT_LAYER_OFF: "Layer is off: nothing drawn on the map",
    FOOT_DRAWN: (n) => `Drawing the first ${n.toLocaleString("en-US")} selected`,
    FOOT_NOT_IN_ROWS: "Not in the current rows",
    FOOT_SORT_LOCAL: "This layer can't sort on the server; shown in the default order",
    LOADING: "Loading rows…",
    LOAD_FAILED: "Couldn't load rows.",
    RETRY: "Retry",
    EMPTY: "No rows match",
    CLEAR_FILTERS: "Clear filters",
    LAYER_ERROR: "Couldn't read this layer",
    SELECT_ROW: "Select row",
    SELECT_ALL: "Select all matching rows",
    TOO_MANY: (max) => `Only ${max.toLocaleString("en-US")} rows can be selected at once. Narrow the rows with a search, Map extent or the filter first.`,
    TYPE: { text: "text", number: "number", date: "date", "date-only": "date", coded: "coded" },
    SORT_ASC: "ascending",
    SORT_DESC: "descending",
    HEADER_TIP: (name, type) => `${name} (${type}). Click to sort, Shift+click to add a sort.`,
    RESIZE_COLUMN: "Resize the column (double-click to fit)",
    CHOOSER_TITLE: "Columns",
    CHOOSER_FILTER: "Find a field",
    SHOW_ALL: "Show all",
    RESET: "Reset to default",
    MOVE_UP: "Move up",
    MOVE_DOWN: "Move down",
    FREEZE: "Freeze first column",
    SOURCE: { user: "Your changes", map: "Shared setup from the map", popup: "From the pop-up", all: "All fields" },
    SHARED_CHANGED: "The shared setup for this layer changed. Your changes were reset.",
    MENU_ZOOM: "Zoom to",
    MENU_SHOW: "Show in panel",
    MENU_SELECT: "Select",
    MENU_DESELECT: "Deselect",
    MENU_COPY_VALUE: "Copy value",
    MENU_COPY_ROW: "Copy row",
    MENU_COPY_SELECTED: "Copy selected rows",
    COPIED: "Copied",
    COPY_FAILED: "Couldn't copy",
    COPY_FAILED_MSG: "The browser didn't allow copying. Select the text and press Ctrl+C.",
    COPY_CAP: (max) => `Only the first ${max.toLocaleString("en-US")} selected rows were copied.`,
    CSV_ALL: "CSV: all rows",
    CSV_SELECTED: "CSV: selected rows",
    XLSX_ALL: "Excel: all rows",
    XLSX_SELECTED: "Excel: selected rows",
    PREPARING: (done, total) => `Preparing ${done.toLocaleString("en-US")} of ${total.toLocaleString("en-US")}`,
    CANCEL: "Cancel",
    EXPORT_CAP: (max) => `Downloads are limited to ${max.toLocaleString("en-US")} rows. Narrow the rows first.`,
    EXPORT_FAILED: "Couldn't prepare the download",
    EXPORT_NOTHING: "There are no rows to download.",
    INFO_SHEET: "Export info",
    INFO: { LAYER: "Layer", TIME: "Exported", ROWS: "Rows", WHERE: "Layer filter", EXTENT: "Map extent", SEARCH: "Search", SELECTED: "Selected rows only", SORT: "Sort", NONE: "None", YES: "Yes", DEFAULT_SORT: "Default (object id)" },
  },
};

// ---- Symbology presets ----
const OUTLINE = { color: [110, 110, 110, 0.5], width: 0.4 };
const fill = (color) => ({ type: "simple-fill", color, outline: OUTLINE });
const NO_DATA = [200, 200, 200, 0.2]; // the default symbol for null values, under "No data" in the legend
const EPS = 0.000001;

// None / up to 25% / 26 to 50% / over 50% of the parcel
function percentStyle(field, title, colors) {
  const labels = ["None", "Up to 25%", "26 to 50%", "Over 50%"];
  const ranges = [[0, 0], [EPS, 25], [25 + EPS, 50], [50 + EPS, 100]];
  return {
    type: "class-breaks",
    field,
    legendOptions: { title },
    defaultSymbol: fill(NO_DATA),
    defaultLabel: "No data",
    classBreakInfos: ranges.map(([minValue, maxValue], i) => ({
      minValue,
      maxValue,
      label: labels[i],
      symbol: fill(colors[i]),
    })),
  };
}

const BLUE = [[225, 225, 225, 0.35], [198, 219, 239, 0.85], [107, 174, 214, 0.9], [8, 81, 156, 0.95]];
const GREEN = [[225, 225, 225, 0.35], [199, 233, 192, 0.85], [116, 196, 118, 0.9], [0, 109, 44, 0.95]];
const ORANGE = [[225, 225, 225, 0.35], [253, 208, 162, 0.85], [253, 141, 60, 0.9], [166, 54, 3, 0.95]];
const BROWN = [[225, 225, 225, 0.35], [237, 224, 190, 0.85], [196, 160, 100, 0.9], [120, 78, 30, 0.95]];
const GREY = [[225, 225, 225, 0.35], [205, 205, 205, 0.85], [135, 135, 135, 0.9], [50, 50, 50, 0.95]];
// Five classes, light to dark, for the natural-breaks presets (no "None" class, so no neutral first color)
const PURPLE = [[242, 240, 247, 0.85], [203, 201, 226, 0.85], [158, 154, 200, 0.9], [117, 107, 177, 0.9], [84, 39, 143, 0.95]];

export const DEFAULT_STYLE = "original";

export const STYLES = {
  original: { label: "Original" },
  assessed: {
    label: "Assessed Value",
    field: "AssVal",
    breaks: { classes: 5, colors: PURPLE, format: "currency", title: "Assessed value ($)" },
  },
  floodplain: {
    label: "% in Floodplain",
    field: "pct_floodplain",
    renderer: percentStyle("pct_floodplain", "Floodplain share of parcel", BLUE),
  },
  ag: {
    label: "% with Ag. Soils",
    field: "total_pct_ag_soil",
    renderer: percentStyle("total_pct_ag_soil", "Ag soil share of parcel", BROWN),
  },
  forested: {
    label: "% Forested",
    field: "pct_forested",
    renderer: percentStyle("pct_forested", "Forested share of parcel", GREEN),
  },
  slope: {
    label: "% with Steep Slopes",
    field: "pct_slope_25_plus",
    renderer: percentStyle("pct_slope_25_plus", "Share of parcel over 25% slope", ORANGE),
  },
  impervious: {
    label: "% with Impervious",
    field: "pct_impervious",
    renderer: percentStyle("pct_impervious", "Impervious surface share of parcel", GREY),
  },
  karst: {
    label: "Karst Geology Density",
    field: "interpolated_karst_density",
    breaks: { classes: 5, colors: PURPLE, format: "number", title: "Interpolated karst density" },
  },
};

// Natural-breaks presets (`breaks`): the SDK computes the breaks once over the whole parcel layer the first time the
// preset is used; give up after this long and go back to what is drawn.
export const STYLE_BREAKS = { TIMEOUT_MS: 20000 };

// Used by classBreaks.js to build the natural-breaks renderers with the same look as the percent presets.
export const fillSymbol = fill;
export const NO_DATA_COLOR = NO_DATA;
