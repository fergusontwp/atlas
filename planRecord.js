// The Plans layer record for a georeferenced plan, built from the workspace state. No DOM and no SDK imports, so it can
// be tested alone. Field names come from PLANS.FIELDS (the caller passes it in), so renaming a field is a config change.
// The footprint comes back in the working CRS; the caller projects it to the layer's spatial reference.

import { accuracyClass, worstError } from "./georefAnalysis.js";
import { pdfAttaches } from "./planCompression.js";
import { SCHEMA_VERSION, readChain } from "./planGroup.js";
import { mosaicBlock, readMosaicBlock } from "./mosaicModel.js";

// A plan placed from a mosaic (several views of the PDF joined, mosaicModel.js) is schema_version 3, with its `mosaic`
// block on every piece: an older Atlas then says it was saved by a newer version instead of reopening it on one page.
export const MOSAIC_SCHEMA_VERSION = 3;
import { renderBlock, settingsFromRender } from "./thicken.js";
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

// A server path as pasted: spaces and line breaks around it and the quotes Windows "Copy as path" adds are dropped
// ("\\server\plans\Main St.pdf", 'C:\Plans\a.pdf', “…”). Anything else is kept as typed. Not a string: "".
export function cleanServerPath(text) {
  let s = typeof text === "string" ? text.trim() : "";
  const pairs = { '"': '"', "'": "'", "\u201c": "\u201d", "\u2018": "\u2019" };
  while (s.length >= 2 && pairs[s[0]] && s.at(-1) === pairs[s[0]]) s = s.slice(1, -1).trim();
  return s;
}

// The optional fields Jackson adds by hand (PLANS.FIELDS). A layer without them still works: they read as empty and
// aren't written.
export const optionalFields = (F) => [F.GROUP_ID, F.PIECE_NO, F.SERVER_LOCATION].filter(Boolean);

// The attributes the layer can take: an optional field the layer doesn't have (yet) is left out, and reported in
// `dropped` when it had a value. Field names are matched without regard to case, as the layer does. layerFields: the
// layer's field names, or null when they aren't known (then nothing is dropped).
export function keepLayerFields(attributes, layerFields, optional) {
  if (!Array.isArray(layerFields)) return { attributes: { ...attributes }, dropped: [] };
  const has = new Set(layerFields.map((n) => String(n).toLowerCase()));
  const out = {}, dropped = [];
  for (const [k, v] of Object.entries(attributes)) {
    if (optional.includes(k) && !has.has(k.toLowerCase())) { if (v != null && v !== "") dropped.push(k); continue; }
    out[k] = v;
  }
  return { attributes: out, dropped };
}

// The server location stored on a record, cleaned; "" when the field is empty or the layer doesn't have it.
export const serverLocationOf = (attributes, F) => (F.SERVER_LOCATION ? cleanServerPath(attributes?.[F.SERVER_LOCATION]) : "");

// details: { name, type, date, notes, serverLocation }; cfg: { nameMax, notesMax, types, serverLocationMax }.
// Returns { ok, errors: { name?, notes?, date?, type?, serverLocation? } }.
export function validateDetails(details, cfg) {
  const errors = {};
  const name = String(details.name ?? "").trim();
  if (!name) errors.name = "Enter a name for the plan.";
  else if (name.length > cfg.nameMax) errors.name = `The name can be at most ${cfg.nameMax} characters.`;
  if (String(details.notes ?? "").length > cfg.notesMax) errors.notes = `Notes can be at most ${cfg.notesMax} characters.`;
  if (details.date && dateToEpoch(details.date) === null) errors.date = "Enter the date as year-month-day.";
  if (details.type && !cfg.types.includes(details.type)) errors.type = "Choose a type from the list.";
  if (cfg.serverLocationMax && cleanServerPath(details.serverLocation).length > cfg.serverLocationMax) errors.serverLocation = `The server location can be at most ${cfg.serverLocationMax} characters.`;
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

// The record that lets the fit be reopened (control points in page space, crop, DPI, page size, the transform). A piece
// of a group adds schema_version 2 and its chain block (planGroup.chainBlock); `crop` is then the whole sheet and
// `transform` the piece's own.
// `render` is the line weight the image was made with (thicken.js), when there was one. `mosaic` (mosaicModel.mosaicBlock)
// is the mosaic the sheet was, when it was one: `page` and `crop` are then in mosaic points.
export function buildTransformJson({ wkid, fit, page, crop, dpi, scale, image, chain = null, thicken = null, mosaic = null }) {
  const T = fit.analysis.T;
  return {
    version: 1,
    ...(mosaic ? { schema_version: MOSAIC_SCHEMA_VERSION } : chain ? { schema_version: SCHEMA_VERSION } : {}),
    wkid,
    fitType: fit.type,
    transform: { a: T.a, b: T.b, c: T.c, d: T.d, e: T.e, f: T.f },
    page: { number: page.number, widthPt: page.widthPt, heightPt: page.heightPt },
    crop: { x0: crop.x0, y0: crop.y0, x1: crop.x1, y1: crop.y1 },
    dpi,
    stated: { perInch: scale?.perInch ?? null, unit: scale?.unit ?? "ft", reduction: scale?.reduction ?? 100 },
    points: fit.points.map((p) => ({ id: p.id, x: p.x, y: p.y, X: p.X, Y: p.Y, use: p.use !== false, snapped: !!p.snapped })),
    image: { width: image.width, height: image.height, scaleFactor: image.scaleFactor, tier: image.tier, dpi: r(dpi * image.scaleFactor, 2) },
    ...(chain ? { chain } : {}),
    ...(thicken ? { render: renderBlock(thicken) } : {}),
    ...(mosaic ? { mosaic: mosaicBlock(mosaic) } : {}),
  };
}

// input: {
//   details  { name, type, date, notes, sheetSize, statedScale, serverLocation }
//   source   { pdfName, pageNumber, pageWidthPt, pageHeightPt, pdfBytes, attachPdf }   pdfBytes: size of the PDF file;
//            attachPdf: "Attach source PDF" (default true); the PDF is attached only when asked and within the cap
//   fit      { type, wkid, analysis, points }                              the workspace's analysis and control points
//   raster   { W, H, dpi, crop }                                           the rendered crop the fit was placed on
//   scale    { perInch, unit, reduction }
//   image    runLadder's result { tier, scaleFactor, width, height, tileCount, origBytes, finalBytes, files }
//   group    a piece of a group: { groupId, pieceNo } (omit for a one-piece plan without a group)
//   chain    the piece's chain block (planGroup.chainBlock), with raster.crop the piece's own and sheetCrop the whole
//   sheetCrop the whole sheet's crop, stored as transform_json's crop for a piece (default raster.crop)
//   thicken  the line weight the image was made with (thicken.js settings), or null
// }
// The saved image can be smaller than the render (the budget chose a smaller size): the world file, the corners and the
// dpi, scale factor, tier and byte fields all describe the saved image. render_dpi holds the saved image's resolution
// (the render's times the scale factor); transform_json keeps the render's dpi, which its page-space points refer to.
// F: PLANS.FIELDS; limits: { pdfMaxBytes, transformJsonMax }.
// Returns { attributes, ring, wkid, worldFile, transformJson, attachments: [{ role, name, type, bytes }], georefAttachment,
//           pdfAttached, accuracyClass, effectiveDpi }.
export function buildPlanRecord(input, F, limits) {
  const { details, source, fit, raster, scale, image, group = null, chain = null, sheetCrop = null, thicken = null, mosaic = null } = input;
  const A = fit?.analysis;
  if (!A?.T) throw new Error("There is no fit to save yet.");
  if (!image || image.ok === false) throw new Error("The image hasn't been prepared.");
  const cls = accuracyClass(A.quality);

  // the saved image's own transform (the rendered crop, then resized if the compressor shrank it); the world file and the
  // footprint both come from it at the saved size (resizing keeps the outer corners where they were)
  const t0 = imageTransform(A.T, raster.crop, raster.dpi);
  const t = resizeImageTransform(t0, raster.W, raster.H, image.width, image.height);
  const world = worldFileText(worldFileValuesOf(t));
  const c = imageCorners(t, image.width, image.height);
  const ring = orientClockwise([...c, c[0]]);
  const effectiveDpi = raster.dpi * image.scaleFactor;

  const transformJson = buildTransformJson({
    wkid: fit.wkid, fit,
    page: { number: source.pageNumber, widthPt: source.pageWidthPt, heightPt: source.pageHeightPt },
    crop: sheetCrop ?? raster.crop, dpi: raster.dpi, scale, image, chain, thicken, mosaic,
  });
  const json = JSON.stringify(transformJson);
  const georefAttachment = json.length > limits.transformJsonMax;

  const pdfAttached = source.attachPdf !== false && pdfAttaches(source.pdfBytes, limits.pdfMaxBytes);
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
    [F.RENDER_DPI]: Math.round(effectiveDpi),
    [F.SCALE_FACTOR]: r(image.scaleFactor, 4),
    [F.COMPRESS_TIER]: image.tier,
    [F.ORIG_BYTES]: image.origBytes,
    [F.FINAL_BYTES]: image.finalBytes,
    [F.TILE_COUNT]: image.tileCount,
    [F.PDF_ATTACHED]: pdfAttached ? "Yes" : "No",
  };
  if (F.SERVER_LOCATION) attributes[F.SERVER_LOCATION] = cleanServerPath(details.serverLocation) || null;
  if (group) { attributes[F.GROUP_ID] = group.groupId; attributes[F.PIECE_NO] = group.pieceNo; }
  const attachments = [
    ...image.files.map((f) => ({ role: "image", name: f.name, type: f.type, bytes: f.bytes })),
    ...(pdfAttached ? [{ role: "pdf", name: ATTACHMENT.PDF, type: "application/pdf", bytes: source.pdfBytes }] : []),
    ...(georefAttachment ? [{ role: "georef", name: ATTACHMENT.GEOREF, type: "application/json", bytes: json.length }] : []),
  ];
  return {
    attributes, ring, wkid: fit.wkid, worldFile: world, transformJson, transformJsonText: json, attachments,
    georefAttachment, pdfAttached, accuracyClass: cls, effectiveDpi,
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

// ---- wording for the resolution (the Review step; ceilingText for its note)

const dpiText = (d) => `${Math.round(d).toLocaleString("en-US")} dpi`;

// What the render's ceiling is and why. r: pageRaster.renderDpi's result; limits: { maxDpi, maxSide, maxPixels }.
// "Ceiling 228 dpi: the resolution of the images the page is made of."
export function ceilingText(r, { maxDpi, maxSide, maxPixels }) {
  const wanted = r.kind === "raster" ? r.nativeDpi : r.kind === "mixed" ? Math.max(r.nativeDpi, maxDpi) : maxDpi;
  const why = {
    raster: "the resolution of the images the page is made of",
    mixed: `the page's images (${dpiText(r.nativeDpi)}) with vector linework over them`,
    vector: "a vector page",
    unknown: "the page's images couldn't be read",
  }[r.kind] ?? "";
  const head = `Ceiling ${dpiText(wanted)}: ${why}.`;
  if (!r.capped) return head;
  const limit = r.capped === "side" ? `${maxSide.toLocaleString("en-US")} px side` : `${maxPixels / 1e6} megapixel`;
  return `${head} Lowered to ${dpiText(r.ceilingDpi)} by the browser's ${limit} limit.`;
}

// The resolution line: "About 150 dpi, native size, about 6 MB of 7.3 MB." (an estimate) or, from the real result,
// "212 dpi, reduced from 300 dpi to fit, 7.2 MB of 7.3 MB."
//   dpi the saved image's, renderDpi the render's, kind pageRaster's ("raster" is native size), chosen true when the user
//   picked a lower resolution, bytes and budget the image's bytes and what it may use.
export function resolutionText({ dpi, renderDpi, kind, chosen = false, bytes, budget, estimate = true }) {
  const how = dpi < renderDpi - 0.5 ? `reduced from ${dpiText(renderDpi)} to fit`
    : chosen ? "as chosen" : kind === "raster" ? "native size" : "full size";
  return estimate
    ? `About ${dpiText(dpi)}, ${how}, about ${bytesText(bytes)} of ${bytesText(budget)}.`
    : `${dpiText(dpi)}, ${how}, ${bytesText(bytes)} of ${bytesText(budget)}.`;
}

// What the image may use: "7.3 MB for the image: 9.5 MB less the 2.2 MB PDF, which is attached as it is." b is
// planCompression.imageBudget's result; attach and pdfBytes: whether "Attach source PDF" is ticked and the PDF's size.
export function budgetText(b, targetBytes, { attach = true, pdfBytes } = {}) {
  if (b.reserved) return `${bytesText(b.budget)} for the image: ${bytesText(targetBytes)} less the ${bytesText(b.reserved)} PDF, which is attached as it is.`;
  const head = `${bytesText(b.budget)} for the image.`;
  if (!attach) return `${head} The source PDF isn't attached (Details can attach it).`;
  if (!b.pdfAttached && pdfBytes > 0) return `${head} The ${bytesText(pdfBytes)} PDF is over the ${bytesText(targetBytes)} limit, so it won't be attached.`;
  return head;
}

// A warning when the saved image falls under the minimum resolution, or null. It never blocks saving.
export function lowDpiText(dpi, minDpi) {
  if (!(dpi < minDpi - 0.5)) return null;
  return `Under ${dpiText(minDpi)}: small text may be hard to read. A tighter crop keeps more detail.`;
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
// Returns { ok: true, state: { pageNumber, page, crop, dpi, scale, fitType, points, details, attachPdf, chain, thicken } } or
// { ok: false, error }. attachPdf is this record's own (a group carries the PDF on piece 1).
export function stateFromRecord(attributes, json, F, workingWkid) {
  if (!json || json.version !== 1 || !json.crop || !Array.isArray(json.points) || !json.page) return { ok: false, error: "This plan's saved placement can't be read." };
  if ((json.schema_version ?? 1) > MOSAIC_SCHEMA_VERSION) return { ok: false, error: "This plan was saved by a newer version of Atlas. Reload the page to edit it." };
  const mosaic = json.mosaic ? readMosaicBlock(json.mosaic) : null;
  if (json.mosaic && !mosaic) return { ok: false, error: "This plan's mosaic (its joined views) can't be read." };
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
        serverLocation: serverLocationOf(attributes, F),
      },
      attachPdf: attributes[F.PDF_ATTACHED] === "Yes",
      chain: readChain(json), // null for a plan saved in one piece
      thicken: settingsFromRender(json.render), // the line weight it was saved with, or null
      mosaic, // the mosaic it was placed as (mosaicModel.js), or null for a page
    },
  };
}
