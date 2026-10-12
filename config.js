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

// Highlight drawn on the selected parcel (HighlightOptions; replaces the SDK's "default" highlight).
export const HIGHLIGHT = {
  color: "#ffea00",
  haloColor: "#000000",
  haloOpacity: 1,
  fillOpacity: 0.35,
  // While What's in this parcel, Plans, the georeferencing workspace or a shown plan is in use the fill would hide what
  // they draw, so the selection becomes an outline with no fill: a black line (width in px) over a wider yellow one
  // (the highlight color, opaque), so yellow shows on both sides of the black.
  OUTLINE: { BLACK_WIDTH: 3.5, YELLOW_WIDTH: 9, BLACK: "#000000" },
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

// ---- Basemap selector ----
// The web map's own basemap is always first (cloned at startup and labeled DEFAULT_LABEL), then these.
// ids are SDK basemap ids; the Esri ones need a token (OAuth sign-in or an API key) to load.
export const BASEMAPS = {
  DEFAULT_LABEL: "Web map default",
  OPTIONS: [
    { id: "streets-vector", label: "Streets" },
    { id: "topo-vector", label: "Topographic" },
    { id: "satellite", label: "Imagery" },
    { id: "gray-vector", label: "Light gray" },
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
  MAX_PIXELS: 100e6, // the largest render (width x height) the workspace will make
  // Render resolution. The suggestion aims for TARGET_FT_PER_PX of ground per pixel, snaps to PRESETS and stays within
  // MIN and MAX; the pixel caps (MAX_PIXELS here, MAX_SIDE_PX in PLANS.COMPRESSION) can lower it further.
  DPI: { DEFAULT: 200, MIN: 150, MAX: 300, PRESETS: [150, 200, 250, 300], TARGET_FT_PER_PX: 0.2 },
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
  // Field names on the layer, one place to rename them.
  FIELDS: {
    NAME: "plan_name", TYPE: "plan_type", DATE: "plan_date", STATUS: "status", NOTES: "notes", SUPERSEDES: "supersedes",
    SRC_PDF_NAME: "src_pdf_name", SRC_PAGE: "src_page", SHEET_SIZE: "sheet_size", STATED_SCALE: "stated_scale",
    WKID: "wkid", FIT_TYPE: "fit_type", TRANSFORM_JSON: "transform_json", WORLD_FILE: "world_file",
    RMS_FT: "rms_ft", LOO_RMS_FT: "loo_rms_ft", MAX_RES_FT: "max_res_ft", POINT_COUNT: "point_count",
    SNAPPED_COUNT: "snapped_count", ACCURACY_CLASS: "accuracy_class", IMG_WIDTH: "img_width", IMG_HEIGHT: "img_height",
    RENDER_DPI: "render_dpi", SCALE_FACTOR: "scale_factor", COMPRESS_TIER: "compress_tier", ORIG_BYTES: "orig_bytes",
    FINAL_BYTES: "final_bytes", TILE_COUNT: "tile_count", PDF_ATTACHED: "pdf_attached",
  },
  TYPES: ["Subdivision", "Land development", "As-built", "Survey", "Stormwater", "Utility", "Other"], // the plan type list
  NAME_MAX: 200, // field lengths on the layer
  NOTES_MAX: 1000,
  // transform_json longer than this goes in a georef.json attachment instead (the layer's own limit is whatever the field was made with)
  TRANSFORM_JSON_MAX_CHARS: 32000,
  LIST_MAX: 200, // plans read for one parcel
  REVIEW_MAX_PARCELS: 500, // parcels read when the Review step counts what a footprint covers
  // The saved image must fit a hosted attachment (about 10 MB). The size of the first PNG only picks where to start; every
  // attempt is checked against TARGET_BYTES and falls through to the next rung until it fits. The tier limits are
  // estimates (a PNG of linework shrinks a lot when it is reduced to a palette, much less as a JPEG).
  COMPRESSION: {
    TARGET_BYTES: 9500000, // under 10 MB and under 10 MiB
    MAX_SIDE_PX: 8192, // longest side of any saved image or tile (a bigger image silently fails to draw on some GPUs)
    TIER_LIMITS: { LOSSLESS: 25e6, QUANTIZED: 60e6, JPEG: 150e6 }, // initial PNG bytes up to which that rung is the start
    DOWNSCALE_STEP: 0.9, // linear factor per attempt
    DOWNSCALE_FLOOR: 0.6, // never reduce below this linear scale
    JPEG_QUALITY_START: 0.95,
    JPEG_QUALITY_FLOOR: 0.85,
    TILE_MAX_BYTES: 8000000, // each tile of a tiled plan
    FLAT_SHARE: 0.95, // linework with this share of its pixels in 16 colors counts as flat: it is reduced to a palette, never JPEG
  },
};

// ---- Plan display (saved plans on the map, plansOnMap.js) ----
export const PLAN = {
  WKID: GEOREF.WORKING_WKID, // coordinate system of the world file: the one working CRS (2271, NAD83 / Pennsylvania North, ftUS)
  MAX_DIM: 4096, // longest side in pixels; bigger images are scaled down for the GPU
  OPACITY: 0.7,
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
