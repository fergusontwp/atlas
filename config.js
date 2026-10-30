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
    TEXT: { NO_MATCH: "No place found in Pennsylvania.", FAILED: "Location search unavailable", OUTSIDE: "Outside Pennsylvania" },
  },
  // The road outline and the location marker (list-hidden graphics layers; the marker is point info's when it exists).
  ROAD_OUTLINE_LAYER_ID: "road-search-outline",
  LOCATION_MARKER_LAYER_ID: "location-search-marker",
};

// ---- What's in this parcel ----
// Finds features in other layers that intersect the selected parcel, or lie within a distance of it. It is purely
// spatial: no field of the searched layers is read except their display field (for item labels).
export const WHATS_HERE = {
  EXCLUDE_TITLES: [], // layer titles that never appear in the checklist
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
  LENGTH_UNIT: "us-feet", // US survey feet for Pennsylvania plans; use "feet" for the international foot
  AREA_UNIT: "acres",
  LENGTH_UNITS: ["feet", "us-feet", "yards", "miles", "meters"], // offered in the unit dropdown
  AREA_UNITS: ["square-feet", "acres", "square-miles", "square-meters", "hectares"],
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
// The layer is not in the web map: the app loads it by item ID when it is first needed. While ITEM_ID is still the
// placeholder the Plans features are off and everything else works.
export const PLANS = {
  ITEM_ID: "bc5d536d70444c7dbe3bf90906883ff4",
  LAYER_INDEX: 0,
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
