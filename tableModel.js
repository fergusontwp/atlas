// Pure logic for the results table in What's in this parcel (no DOM, no SDK): which columns, how a cell reads, how a
// column sorts. The features are the ones already in memory from the last search; nothing here queries.
//
// A field is { name, alias, type, domain? } (domain: { type: "coded-value", codedValues: [{ code, name }] } or a range
// domain). A table is { layerId, title, columns, rows, count, capNote }: `rows` are the features' attribute objects.

const NEVER = new Set(["geometry", "blob", "raster", "xml"]);
const NUMBER_TYPES = new Set(["small-integer", "integer", "long", "big-integer", "single", "double"]);

// Names that look like identifiers (parcel and object ids, GUIDs, tax id numbers): numbers in them stay raw, with no
// thousands separators, so 12345678 never becomes 12,345,678.
const ID_NAME = /(^|[^a-z0-9])(id|oid|fid|gid|guid|uuid)([^a-z0-9]|$)|idnum|id_?number|^objectid|^globalid/i;
const ID_SUFFIX = /(ID|Id|OID|GUID)$/; // parcelID, TaxId (but not "Valid" or "Paid")

// All the layer's fields in its own order, minus geometry, blob, raster and xml fields and the fields in hideFields (names,
// case-insensitive; WHATS_HERE.TABLE.HIDE_FIELDS). Each column: { name, alias, type, domain, kind, idLike, timeZone }.
export function tableColumns(fields, { hideFields = [], objectIdField = null, timeZoneOf = () => null } = {}) {
  const hidden = new Set(hideFields.map((n) => String(n).toLowerCase()));
  const out = [];
  for (const f of fields ?? []) {
    if (!f?.name || NEVER.has(f.type) || hidden.has(f.name.toLowerCase())) continue;
    const idLike = f.type === "oid" || f.type === "global-id" || f.type === "guid" || f.name === objectIdField || ID_NAME.test(f.name) || ID_SUFFIX.test(f.name);
    const kind = f.type === "date" || f.type === "timestamp-offset" ? "date"
      : f.type === "date-only" ? "date-only"
      : NUMBER_TYPES.has(f.type) || f.type === "oid" ? "number"
      : "text";
    out.push({ name: f.name, alias: f.alias || f.name, type: f.type, domain: f.domain ?? null, kind, idLike, timeZone: kind === "date" ? timeZoneOf(f.name) ?? null : null });
  }
  return out;
}

const isEmpty = (v) => v === null || v === undefined || (typeof v === "string" && v.trim() === "");

// The description of a coded-value domain code (codes may be numbers in the data and strings in the domain, or the reverse).
export function domainLabel(domain, value) {
  if (domain?.type !== "coded-value" || !Array.isArray(domain.codedValues)) return null;
  const hit = domain.codedValues.find((c) => c.code === value) ?? domain.codedValues.find((c) => String(c.code) === String(value));
  return hit ? String(hit.name) : null;
}

// The calendar day a date value shows: { y, m, d }. A "date" field holds an instant (epoch milliseconds) that is read as a
// wall-clock day in the field's own time zone ("UTC" and anything unknown read as UTC, "system" as the browser's); a
// "date-only" field is already a "YYYY-MM-DD" string. Null for anything that isn't a date.
export function dateParts(value, kind, timeZone) {
  if (isEmpty(value)) return null;
  if (kind === "date-only" || typeof value === "string") {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value));
    return m ? { y: +m[1], m: +m[2], d: +m[3] } : null;
  }
  const ms = value instanceof Date ? value.getTime() : Number(value);
  if (!Number.isFinite(ms)) return null;
  const zone = !timeZone || timeZone === "unknown" || timeZone === "UTC" ? "UTC" : timeZone === "system" ? undefined : timeZone;
  let parts;
  try {
    parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(ms));
  } catch {
    parts = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(ms));
  }
  const pick = (t) => +parts.find((p) => p.type === t).value;
  return { y: pick("year"), m: pick("month"), d: pick("day") };
}

export const isoDay = ({ y, m, d }) => `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
const shownDay = ({ y, m, d }) => new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });

// What a cell shows. Null and empty text show as an empty cell; coded values as their description; dates as a local
// calendar date ("Jan 5, 2024"); numbers with thousands separators except identifier-like fields, which stay raw.
export function cellText(value, column) {
  if (isEmpty(value)) return "";
  const coded = domainLabel(column.domain, value);
  if (coded !== null) return coded;
  if (column.kind === "date" || column.kind === "date-only") {
    const parts = dateParts(value, column.kind, column.timeZone);
    return parts ? shownDay(parts) : String(value);
  }
  if (column.kind === "number" && typeof value === "number" && Number.isFinite(value)) {
    return column.idLike ? String(value) : value.toLocaleString("en-US", { maximumFractionDigits: 6 });
  }
  return String(value);
}

// The sort key of a value in a column: { n } for numbers and dates (compared numerically), { s } for text, null for nothing.
// Coded values sort by the description that is shown.
export function sortKey(value, column) {
  if (isEmpty(value)) return null;
  const coded = domainLabel(column.domain, value);
  if (coded !== null) return { s: coded };
  if (column.kind === "date" || column.kind === "date-only") {
    const p = dateParts(value, column.kind, column.timeZone);
    return p ? { n: Date.UTC(p.y, p.m - 1, p.d) } : { s: String(value) };
  }
  if (typeof value === "number" && Number.isFinite(value)) return { n: value };
  if (column.kind === "number" && !Number.isNaN(Number(value))) return { n: Number(value) };
  return { s: String(value) };
}

// Row indexes in sorted order. Numbers sort numerically, text with a locale compare (numbers before text when a column
// mixes them), nulls are always last whichever way it sorts, and equal rows keep their original order.
export function sortedIndexes(rows, column, direction = "asc") {
  const sign = direction === "desc" ? -1 : 1;
  const keys = rows.map((r) => sortKey(r?.[column.name], column));
  return rows.map((_, i) => i).sort((a, b) => {
    const ka = keys[a], kb = keys[b];
    if (!ka && !kb) return a - b;
    if (!ka) return 1;
    if (!kb) return -1;
    let c;
    if (ka.n !== undefined && kb.n !== undefined) c = ka.n - kb.n;
    else if (ka.s !== undefined && kb.s !== undefined) c = ka.s.localeCompare(kb.s, undefined, { numeric: true, sensitivity: "base" });
    else c = ka.n !== undefined ? -1 : 1;
    return c === 0 ? a - b : c * sign;
  });
}

// "Parcels (12)" for a tab.
export const tabLabel = (title, count) => `${title} (${count.toLocaleString("en-US")})`;

// The note under a table whose layer hit its cap.
export const capNote = (count, overflow) => (overflow ? `Showing the first ${count.toLocaleString("en-US")}` : "");

// One table from a searched layer's group: { layerId, title, fields, objectIdField, rows, overflow, timeZoneOf }. Layers with an
// error or no features give null (they are not tabs).
export function buildTable(g, { hideFields = [] } = {}) {
  if (g.error || !g.rows || g.rows.length === 0) return null;
  return {
    layerId: g.layerId,
    title: g.title,
    objectIdField: g.objectIdField,
    columns: tableColumns(g.fields, { hideFields, objectIdField: g.objectIdField, timeZoneOf: g.timeZoneOf }),
    rows: g.rows,
    count: g.rows.length,
    overflow: !!g.overflow,
    capNote: capNote(g.rows.length, g.overflow),
  };
}

// ---- export (what the Download menu writes: the table's columns, in its order, with real values rather than display text)
// A cell is { t: "s", v } text, { t: "n", v } number, { t: "d", y, m, d } calendar day, or { t: "e" } for nothing. Numbers are
// full precision; coded values are the description the table shows; dates are the same calendar day the table shows;
// identifier-like numbers (the object id, parcel ids) and all text are text.
export function exportCell(value, column) {
  if (isEmpty(value)) return { t: "e" };
  const coded = domainLabel(column.domain, value);
  if (coded !== null) return { t: "s", v: coded };
  if (column.kind === "date" || column.kind === "date-only") {
    const p = dateParts(value, column.kind, column.timeZone);
    return p ? { t: "d", ...p } : { t: "s", v: String(value) };
  }
  if (column.kind === "number" && !column.idLike && typeof value === "number" && Number.isFinite(value)) return { t: "n", v: value };
  return { t: "s", v: String(value) };
}

// header: "alias" (default) or "name". `order` is the row order on screen (sortedIndexes, or every index).
export function exportMatrix(table, order, { header = "alias" } = {}) {
  return {
    header: table.columns.map((c) => (header === "name" ? c.name : c.alias)),
    rows: order.map((i) => table.columns.map((c) => exportCell(table.rows[i]?.[c.name], c))),
  };
}

// "whats-in-parcel_12_345__678__0000__2026-10-08.xlsx" and, for CSV, "..._<layer>_<date>.csv": anything that is not a
// letter or digit becomes an underscore. `date` is a Date (its local day is used).
const safe = (text) => String(text ?? "").replace(/[^\p{L}\p{N}]/gu, "_");
export const localDay = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
export function exportFileName({ parcelId, layerTitle, date, ext }) {
  return ["whats-in-parcel", safe(parcelId), layerTitle === undefined ? null : safe(layerTitle), localDay(date)].filter((p) => p !== null).join("_") + `.${ext}`;
}

// The "Search info" sheet: what was searched. `layers`: [{ title, count, overflow, error }] for every layer searched,
// `max` the per-layer cap. Returns { header, rows } in the same cell format.
export function searchInfo({ parcelId, mode, radius, when, layers, max }) {
  const s = (v) => ({ t: "s", v: String(v) });
  const rows = [
    [s("Parcel ID"), s(parcelId ?? "")],
    [s("Mode"), s(mode === "within" ? `Within ${radius} ft` : "Intersects")],
    [s("Searched"), s(`${localDay(when)} ${String(when.getHours()).padStart(2, "0")}:${String(when.getMinutes()).padStart(2, "0")}`)],
  ];
  for (const l of layers) rows.push([s(`Layer: ${l.title}`), s(l.error ? "couldn't be searched" : `${l.count.toLocaleString("en-US")} feature${l.count === 1 ? "" : "s"}`)]);
  for (const l of layers) if (l.overflow) rows.push([s("Note"), s(`"${l.title}": only the first ${max} features are included (the layer has more).`)]);
  return { header: ["Item", "Value"], rows };
}
