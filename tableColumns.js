// The attribute table's columns (attributeTable.js): which fields show, in which order, how wide, and where that setup
// comes from. Pure: no DOM and no SDK imports (SDK objects are read like plain objects).
//
// A layer's columns come from, first match wins (brief section 8a):
//   1. "user"  the user's own changes in this browser (hide, reorder, resize), kept with a fingerprint of the setup they
//              were made on; when that setup changes the changes are dropped (sanitizeColumnPrefs)
//   2. "map"   the shared setup saved in Map Viewer: the web map's (or layer item's) attributeTableInfo, which SDK 5.1
//              reads onto the layer as `attributeTableTemplate` (elements in order, orderByFields)
//   3. "popup" the pop-up's visible fields, in their order
//   4. "all"   every field in the layer's order
// The automatic rules (autoHidden: the object id, guid fields, editor tracking, AUTO_HIDE patterns) apply in 3 and 4
// only; what was set on purpose wins. Fields the source doesn't mention are added at the end, hidden.
import { TABLE } from "./config.js";

export const SKIP_TYPES = new Set(["geometry", "blob", "raster", "xml"]);

// Every field a table can offer (all but geometry, blob, raster and xml), in the layer's order.
export const offerableFields = (fields) => (fields ?? []).filter((f) => f?.name && !SKIP_TYPES.has(f.type));

// Hidden by default in the "popup" and "all" cases: the object id, global-id / guid fields, the editor tracking fields
// (editFieldsInfo), and names matching AUTO_HIDE (case-insensitive).
export function autoHidden(field, { objectIdField = null, editFieldsInfo = null, patterns = TABLE.AUTO_HIDE } = {}) {
  const name = String(field?.name ?? "");
  const lower = name.toLowerCase();
  if (field?.type === "oid" || field?.type === "global-id" || field?.type === "guid") return true;
  if (objectIdField && lower === String(objectIdField).toLowerCase()) return true;
  const tracking = Object.values(editFieldsInfo ?? {}).filter((v) => typeof v === "string").map((v) => v.toLowerCase());
  if (tracking.includes(lower)) return true;
  return (patterns ?? []).some((p) => {
    try { return new RegExp(p, "i").test(name); } catch { return false; }
  });
}

// The shared setup: { fields: [names in order], sort: [{ field, order: "asc" | "desc" }] } from an
// attributeTableTemplate (SDK object) or its attributeTableInfo JSON, or null when it names no fields. Group elements are
// flattened in order; relationship and attachment elements are not fields and are skipped.
export function readTableInfo(info) {
  if (!info) return null;
  const names = [];
  const walk = (elements) => {
    for (const e of elements ?? []) {
      if (!e) continue;
      if (e.type === "group") walk(e.elements);
      else if ((e.type === "field" || e.type === undefined) && typeof e.fieldName === "string" && e.fieldName) names.push(e.fieldName);
    }
  };
  walk(info.elements);
  const sort = (info.orderByFields ?? [])
    .filter((o) => typeof o?.field === "string" && o.field)
    .map((o) => ({ field: o.field, order: String(o.order ?? "asc").toLowerCase() === "desc" ? "desc" : "asc" }));
  return names.length || sort.length ? { fields: names, sort } : null;
}

// The pop-up's field infos as [{ fieldName, visible }]: from its first "fields" content element that lists some, else
// the template's own fieldInfos. Arcade expressions ("expression/…") are left out (they aren't layer fields).
export function popupFieldInfos(popupTemplate) {
  if (!popupTemplate) return [];
  const content = Array.isArray(popupTemplate.content) ? popupTemplate.content : [];
  const element = content.find((c) => c?.type === "fields" && (c.fieldInfos?.length ?? 0) > 0);
  const infos = element?.fieldInfos ?? popupTemplate.fieldInfos ?? [];
  return [...infos]
    .filter((i) => typeof i?.fieldName === "string" && !i.fieldName.startsWith("expression/"))
    .map((i) => ({ fieldName: i.fieldName, visible: i.visible !== false }));
}

// A short, stable hash (FNV-1a, base 36) of a text.
export function shortHash(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

// The fingerprint of a resolved setup (fields, visibility, order, sort): stored with a user's changes, so changes made on
// an older shared setup are recognized.
export const setupFingerprint = (columns, sort = []) =>
  shortHash(JSON.stringify([columns.map((c) => [c.field, !!c.visible]), sort.map((s) => [s.field, s.order])]));

// A user's saved changes for one layer, checked: { prefs: { fingerprint, columns: [{ field, visible, width }] } | null,
// dropped: null | "bad" | "stale" }. Unknown fields are dropped, a field the layer gained since is added at the end
// hidden, duplicates and bad widths are cleaned. Text is parsed (bad JSON: dropped "bad"). With `fingerprint`, saved
// changes made on another setup are dropped "stale".
export function sanitizeColumnPrefs(saved, fields, fingerprint = null, cfg = TABLE.COL) {
  let value = saved;
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { return { prefs: null, dropped: "bad" }; }
  }
  if (value === null || value === undefined) return { prefs: null, dropped: null };
  if (typeof value !== "object" || !Array.isArray(value.columns)) return { prefs: null, dropped: "bad" };
  if (fingerprint !== null && value.fingerprint !== fingerprint) return { prefs: null, dropped: "stale" };
  const known = new Map(offerableFields(fields).map((f) => [f.name.toLowerCase(), f.name]));
  const seen = new Set();
  const columns = [];
  for (const c of value.columns) {
    const name = known.get(String(c?.field ?? "").toLowerCase());
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const width = Number.isFinite(c.width) && c.width > 0 ? clampWidth(c.width, cfg) : null;
    columns.push({ field: name, visible: c.visible !== false, width });
  }
  if (!columns.length) return { prefs: null, dropped: "bad" };
  for (const name of known.values()) if (!seen.has(name)) columns.push({ field: name, visible: false, width: null });
  return { prefs: { fingerprint: value.fingerprint ?? null, columns }, dropped: null };
}

export const clampWidth = (px, cfg = TABLE.COL) => Math.round(Math.min(cfg.MAX_PX, Math.max(cfg.MIN_PX, px)));

// A column's starting width: the larger of its header and the AUTO_WIDTH_PERCENTILE of its loaded cells' text widths,
// plus PAD_PX (cell padding), clamped to MIN_PX..MAX_PX. All in CSS pixels.
export function autoWidth(headerPx, cellPxList, cfg = TABLE.COL) {
  const cells = (cellPxList ?? []).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  let p = 0;
  if (cells.length) {
    const rank = Math.max(1, Math.ceil(cfg.AUTO_WIDTH_PERCENTILE * cells.length)); // nearest rank
    p = cells[rank - 1];
  }
  return clampWidth(Math.max(Number(headerPx) || 0, p) + cfg.PAD_PX, cfg);
}

// The columns for a layer. Returns { columns: [{ field, visible, width }], sort: [{ field, order }], source,
// baseSource, fingerprint, freeze, dropped }:
// - columns cover every offerable field (hidden ones too), in order; width null means "measure it" (autoWidth)
// - sort is the shared setup's sort (the tab's default sort), else []
// - source is where the columns came from ("user" | "map" | "popup" | "all"); baseSource the same without the user's
//   changes; fingerprint the base setup's (to store with the user's changes)
// - dropped: "stale" when the user's changes were made on another setup (the caller removes them and says so)
// overrides: TABLE.LAYERS[key] ({ widths, freeze }), used where the user has no width of their own.
export function resolveColumns({ fields, userPrefs = null, tableInfo = null, popupFieldInfos: popupInfos = [], objectIdField = null,
  editFieldsInfo = null, overrides = null, cfg = TABLE } = {}) {
  const offer = offerableFields(fields);
  const byLower = new Map(offer.map((f) => [f.name.toLowerCase(), f]));
  const real = (name) => byLower.get(String(name ?? "").toLowerCase())?.name ?? null;
  const auto = (f) => autoHidden(f, { objectIdField, editFieldsInfo, patterns: cfg.AUTO_HIDE });
  const finish = (listed) => { // listed: [{ field, visible }] in order; everything else appended hidden
    const seen = new Set(listed.map((c) => c.field));
    return [...listed, ...offer.filter((f) => !seen.has(f.name)).map((f) => ({ field: f.name, visible: false }))];
  };

  let base = null, baseSource = "all", sort = [];
  const shared = readTableInfo(tableInfo);
  if (shared) {
    const listed = [];
    for (const name of shared.fields) {
      const field = real(name);
      if (field && !listed.some((c) => c.field === field)) listed.push({ field, visible: true });
    }
    sort = shared.sort.map((s) => ({ field: real(s.field), order: s.order })).filter((s) => s.field);
    if (listed.length || sort.length) {
      base = listed.length ? finish(listed) : offer.map((f) => ({ field: f.name, visible: !auto(f) }));
      baseSource = "map";
    }
  }
  if (!base) {
    const listed = [];
    for (const info of popupInfos ?? []) {
      const field = real(info.fieldName);
      if (!field || listed.some((c) => c.field === field)) continue;
      listed.push({ field, visible: info.visible !== false && !auto(byLower.get(field.toLowerCase())) });
    }
    if (listed.some((c) => c.visible)) { base = finish(listed); baseSource = "popup"; }
  }
  if (!base) base = offer.map((f) => ({ field: f.name, visible: !auto(f) }));
  const fingerprint = setupFingerprint(base, sort);

  let columns = base.map((c) => ({ ...c, width: null }));
  let source = baseSource, dropped = null;
  if (userPrefs !== null && userPrefs !== undefined) {
    const checked = sanitizeColumnPrefs(userPrefs, fields, fingerprint, cfg.COL);
    dropped = checked.dropped;
    if (checked.prefs) { columns = checked.prefs.columns.map((c) => ({ ...c })); source = "user"; }
  }
  for (const c of columns) {
    const w = overrides?.widths?.[c.field];
    if (c.width === null && Number.isFinite(w)) c.width = clampWidth(w, cfg.COL);
  }
  const freezeField = real(overrides?.freeze);
  return { columns, sort, source, baseSource, fingerprint, freeze: freezeField, dropped };
}

// The user's changes to store for a layer: { fingerprint, columns }.
export const columnPrefs = (columns, fingerprint) => ({ fingerprint, columns: columns.map(({ field, visible, width }) => ({ field, visible: !!visible, width: width ?? null })) });
