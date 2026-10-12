// The Plans layer record for a georeferenced plan, built from the workspace state. No DOM and no SDK imports, so it can
// be tested alone. Field names come from PLANS.FIELDS (the caller passes it in), so renaming a field is a config change.
// The footprint comes back in the working CRS; the caller projects it to the layer's spatial reference.

import { accuracyClass, worstError } from "./georefAnalysis.js";
import { imageTransform, resizeImageTransform, worldFileText, worldFileValuesOf, imageCorners } from "./worldFile.js";

export const ATTACHMENT = { PDF: "source.pdf", GEOREF: "georef.json" };

// A date typed as yyyy-mm-dd, as the milliseconds a Date field stores. Noon UTC, so no time zone moves it to another day.
export function dateToEpoch(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso ?? "").trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = Date.UTC(y, mo - 1, d, 12);
  const back = new Date(t);
  return back.getUTCFullYear() === y && back.getUTCMonth() === mo - 1 && back.getUTCDate() === d ? t : null;
}

// "1 in = 40 ft" (with ", printed at 75%" when the PDF is a reduced print), or "" with no scale.
export function statedScaleText(scale) {
  if (!scale || !(scale.perInch > 0)) return "";
  const base = `1 in = ${+Number(scale.perInch).toFixed(4)} ${scale.unit === "m" ? "m" : "ft"}`;
  return Math.abs((scale.reduction ?? 100) - 100) > 0.05 ? `${base}, printed at ${+Number(scale.reduction).toFixed(2)}%` : base;
}

// details: { name, type, date, notes }; cfg: { nameMax, notesMax, types }. Returns { ok, errors: { name?, notes?, date?, type? } }.
export function validateDetails(details, cfg) {
  const errors = {};
  const name = String(details.name ?? "").trim();
  if (!name) errors.name = "Enter a name for the plan.";
  else if (name.length > cfg.nameMax) errors.name = `The name can be at most ${cfg.nameMax} characters.`;
  if (String(details.notes ?? "").length > cfg.notesMax) errors.notes = `Notes can be at most ${cfg.notesMax} characters.`;
  if (details.date && dateToEpoch(details.date) === null) errors.date = "Enter the date as year-month-day.";
  if (details.type && !cfg.types.includes(details.type)) errors.type = "Choose a type from the list.";
  return { ok: Object.keys(errors).length === 0, errors };
}

// Whether a plan of this class may be saved. Class C (the points disagree) and U (nothing could check the fit) need the
// user's confirmation; no class at all means there is no fit.
export function savePolicy({ accuracyClass: cls, confirmed }) {
  if (!cls) return { needsConfirm: false, canSave: false, reason: "no-fit" };
  const reason = cls === "C" ? "review" : cls === "U" ? "unchecked" : null;
  return { needsConfirm: !!reason, canSave: !reason || !!confirmed, reason };
}

export const POLICY_TEXT = {
  "no-fit": "There is no fit yet. Go back to Place and add points.",
  review: "The points disagree by more than the tolerance (class C). Check the placement before saving, or confirm that you want to save it as it is.",
  unchecked: "Nothing could check this fit (class U): it passes exactly through its points. Add a point to check it, or confirm that you want to save it as it is.",
};

// Plain notes about the points that bear on accuracy; [] when there is nothing to say.
export function accuracyNotes(points) {
  const used = points.filter((p) => p.use !== false);
  const free = used.filter((p) => !p.snapped).length;
  if (!free) return [];
  return [`${free === 1 ? "1 point was" : `${free} points were`} placed freely on the basemap rather than on a parcel corner, so accuracy is limited by the basemap.`];
}

// A closed ring with its vertices clockwise (y up), which is the outer-ring direction of Esri polygons: a counterclockwise
// ring would be read as a hole. A sheet's corners come out either way round depending on the fit.
export function orientClockwise(ring) {
  let twice = 0;
  for (let i = 0; i < ring.length - 1; i++) twice += (ring[i + 1][0] - ring[i][0]) * (ring[i + 1][1] + ring[i][1]);
  return twice >= 0 ? ring : [...ring].reverse(); // this sum is positive for a clockwise ring
}

const r = (v, d) => (Number.isFinite(v) ? Number(v.toFixed(d)) : null);

// The record that lets the fit be reopened (control points in page space, crop, DPI, page size, the transform).
export function buildTransformJson({ wkid, fit, page, crop, dpi, scale, image }) {
  const T = fit.analysis.T;
  return {
    version: 1,
    wkid,
    fitType: fit.type,
    transform: { a: T.a, b: T.b, c: T.c, d: T.d, e: T.e, f: T.f },
    page: { number: page.number, widthPt: page.widthPt, heightPt: page.heightPt },
    crop: { x0: crop.x0, y0: crop.y0, x1: crop.x1, y1: crop.y1 },
    dpi,
    stated: { perInch: scale?.perInch ?? null, unit: scale?.unit ?? "ft", reduction: scale?.reduction ?? 100 },
    points: fit.points.map((p) => ({ id: p.id, x: p.x, y: p.y, X: p.X, Y: p.Y, use: p.use !== false, snapped: !!p.snapped })),
    image: { width: image.width, height: image.height, scaleFactor: image.scaleFactor, tier: image.tier },
  };
}

// input: {
//   details  { name, type, date, notes, sheetSize, statedScale }
//   source   { pdfName, pageNumber, pageWidthPt, pageHeightPt, pdfBytes }   pdfBytes: size of the PDF file
//   fit      { type, wkid, analysis, points }                              the workspace's analysis and control points
//   raster   { W, H, dpi, crop }                                           the rendered crop the fit was placed on
//   scale    { perInch, unit, reduction }
//   image    runLadder's result { tier, scaleFactor, width, height, tileCount, origBytes, finalBytes, files }
// }
// F: PLANS.FIELDS; limits: { pdfMaxBytes, transformJsonMax }.
// Returns { attributes, ring, wkid, worldFile, transformJson, attachments: [{ role, name, type, bytes }], georefAttachment,
//           pdfAttached, accuracyClass, effectiveDpi }.
export function buildPlanRecord(input, F, limits) {
  const { details, source, fit, raster, scale, image } = input;
  const A = fit?.analysis;
  if (!A?.T) throw new Error("There is no fit to save yet.");
  if (!image || image.ok === false) throw new Error("The image hasn't been prepared.");
  const cls = accuracyClass(A.quality);

  // the saved image's own transform (the rendered crop, then resized if the compressor shrank it)
  const t0 = imageTransform(A.T, raster.crop, raster.dpi);
  const t = resizeImageTransform(t0, raster.W, raster.H, image.width, image.height);
  const world = worldFileText(worldFileValuesOf(t));
  const c = imageCorners(t0, raster.W, raster.H);
  const ring = orientClockwise([...c, c[0]]);

  const transformJson = buildTransformJson({
    wkid: fit.wkid, fit,
    page: { number: source.pageNumber, widthPt: source.pageWidthPt, heightPt: source.pageHeightPt },
    crop: raster.crop, dpi: raster.dpi, scale, image,
  });
  const json = JSON.stringify(transformJson);
  const georefAttachment = json.length > limits.transformJsonMax;

  const pdfAttached = Number.isFinite(source.pdfBytes) && source.pdfBytes > 0 && source.pdfBytes <= limits.pdfMaxBytes;
  const used = fit.points.filter((p) => p.use !== false);
  const name = String(details.name).trim();
  const attributes = {
    [F.NAME]: name,
    [F.TYPE]: details.type || null,
    [F.DATE]: dateToEpoch(details.date),
    [F.STATUS]: "draft",
    [F.NOTES]: String(details.notes ?? "").trim() || null,
    [F.SRC_PDF_NAME]: source.pdfName || null,
    [F.SRC_PAGE]: source.pageNumber,
    [F.SHEET_SIZE]: details.sheetSize || null,
    [F.STATED_SCALE]: details.statedScale || null,
    [F.WKID]: fit.wkid,
    [F.FIT_TYPE]: fit.type,
    [F.TRANSFORM_JSON]: georefAttachment ? null : json,
    [F.WORLD_FILE]: world,
    [F.RMS_FT]: r(A.rms, 3),
    [F.LOO_RMS_FT]: r(A.looRms, 3),
    [F.MAX_RES_FT]: r(A.maxRes, 3),
    [F.POINT_COUNT]: used.length,
    [F.SNAPPED_COUNT]: used.filter((p) => p.snapped).length,
    [F.ACCURACY_CLASS]: cls,
    [F.IMG_WIDTH]: image.width,
    [F.IMG_HEIGHT]: image.height,
    [F.RENDER_DPI]: Math.round(raster.dpi),
    [F.SCALE_FACTOR]: r(image.scaleFactor, 4),
    [F.COMPRESS_TIER]: image.tier,
    [F.ORIG_BYTES]: image.origBytes,
    [F.FINAL_BYTES]: image.finalBytes,
    [F.TILE_COUNT]: image.tileCount,
    [F.PDF_ATTACHED]: pdfAttached ? "Yes" : "No",
  };
  const attachments = [
    ...image.files.map((f) => ({ role: "image", name: f.name, type: f.type, bytes: f.bytes })),
    ...(pdfAttached ? [{ role: "pdf", name: ATTACHMENT.PDF, type: "application/pdf", bytes: source.pdfBytes }] : []),
    ...(georefAttachment ? [{ role: "georef", name: ATTACHMENT.GEOREF, type: "application/json", bytes: json.length }] : []),
  ];
  return {
    attributes, ring, wkid: fit.wkid, worldFile: world, transformJson, transformJsonText: json, attachments,
    georefAttachment, pdfAttached, accuracyClass: cls, effectiveDpi: raster.dpi * image.scaleFactor,
    worstErrorFt: worstError(A),
  };
}

// ---- wording for the Review step

const TIER_TEXT = {
  asis: "PNG as rendered",
  lossless: "Lossless PNG (identical pixels)",
  quantized: "PNG with a reduced palette",
  downscaled: "Reduced-size PNG",
  jpeg: "JPEG",
  tiled: "Tiled PNG",
};
export const tierText = (tier) => TIER_TEXT[tier] ?? String(tier ?? "");

// 9,500,000 -> "9.5 MB" (decimal megabytes, the way the layer's limit is quoted); small sizes in KB.
export function bytesText(n) {
  if (!Number.isFinite(n)) return "";
  if (n >= 1e6) return `${+(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)} MB`;
  return `${Math.max(1, Math.round(n / 1e3)).toLocaleString("en-US")} KB`;
}

// "none" for 1, otherwise the linear size as a percent of the rendered image: "81% of the rendered size".
export function scaleFactorText(f) {
  if (!Number.isFinite(f) || f >= 0.9995) return "none";
  return `${Math.round(f * 100)}% of the rendered size`;
}

// Width and height of the footprint in feet along its own edges (corners [TL, TR, BR, BL], closed or not).
export function footprintSize(ring) {
  const d = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
  return { width: d(ring[0], ring[1]), height: d(ring[1], ring[2]) };
}

// ---- reopening a saved plan
// The workspace state a saved plan reopens with, from its record and its transform_json (an object). `workingWkid` is
// the coordinate system this version of the workspace fits in; a plan saved in another one can't be reopened here.
// Returns { ok: true, state: { pageNumber, page, crop, dpi, scale, fitType, points, details } } or { ok: false, error }.
export function stateFromRecord(attributes, json, F, workingWkid) {
  if (!json || json.version !== 1 || !json.crop || !Array.isArray(json.points) || !json.page) return { ok: false, error: "This plan's saved placement can't be read." };
  const wkid = json.wkid ?? attributes[F.WKID];
  if (wkid !== workingWkid) return { ok: false, error: `This plan was placed in coordinate system ${wkid}, and this version edits plans in ${workingWkid} only.` };
  const stamp = attributes[F.DATE];
  return {
    ok: true,
    state: {
      pageNumber: json.page.number, page: { widthPt: json.page.widthPt, heightPt: json.page.heightPt },
      crop: { ...json.crop }, dpi: json.dpi, scale: { perInch: json.stated?.perInch ?? null, unit: json.stated?.unit ?? "ft", reduction: json.stated?.reduction ?? 100 },
      fitType: json.fitType, points: json.points.map((p) => ({ ...p })),
      details: {
        name: attributes[F.NAME] ?? "", type: attributes[F.TYPE] ?? "", notes: attributes[F.NOTES] ?? "",
        date: Number.isFinite(stamp) ? new Date(stamp).toISOString().slice(0, 10) : "",
        sheetSize: attributes[F.SHEET_SIZE] ?? "", statedScale: attributes[F.STATED_SCALE] ?? "",
      },
    },
  };
}
