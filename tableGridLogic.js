// The attribute table's small rules (attributeTable.js): the virtual scroll window, the pane height, the hide reasons,
// cells (nulls, links), the quick search where clause, sorting, copy text, file names and the stable layer key.
// Pure: no DOM and no SDK imports.
import { TABLE } from "./config.js";
import { cellText } from "./tableModel.js";
import { containsWhere } from "./searchSql.js";
import { quote } from "./filterSql.js";

// The rows to draw: { start, end (exclusive), top (px offset of `start`), height (px of all rows) }. Rows in view plus
// `overscan` above and below, clamped to the list.
export function visibleWindow(scrollTop, viewportH, rowH, total, overscan = TABLE.OVERSCAN) {
  const n = Math.max(0, Math.floor(total) || 0);
  const h = Math.max(1, rowH);
  const first = Math.max(0, Math.floor(Math.max(0, scrollTop) / h));
  const last = Math.ceil((Math.max(0, scrollTop) + Math.max(0, viewportH)) / h); // exclusive
  const start = Math.min(n, Math.max(0, first - overscan));
  const end = Math.min(n, Math.max(start, last + overscan));
  return { start, end, top: start * h, height: n * h };
}

// The pane's height in px for a wanted height, inside a map column `columnPx` tall: at least minPx, and never so tall
// that the map gets less than minMapPx. When the column is too small for both, the map wins (the pane gets what is
// left, but never less than collapsedPx: its header).
export function clampPaneHeight(px, { columnPx, minPx = TABLE.PANE.MIN_PX, minMapPx = TABLE.PANE.MIN_MAP_PX, collapsedPx = TABLE.PANE.COLLAPSED_PX } = {}) {
  const max = Math.max(collapsedPx, columnPx - minMapPx);
  const want = Number.isFinite(px) ? px : minPx;
  if (max < minPx) return Math.round(max);
  return Math.round(Math.min(max, Math.max(minPx, want)));
}
// The maximized height: everything but the map's minimum.
export const maxPaneHeight = (columnPx, { minMapPx = TABLE.PANE.MIN_MAP_PX, collapsedPx = TABLE.PANE.COLLAPSED_PX } = {}) => Math.round(Math.max(collapsedPx, columnPx - minMapPx));
export const defaultPaneHeight = (columnPx, percent = TABLE.PANE.DEFAULT_PERCENT) => Math.round(columnPx * percent / 100);

// Why the pane is hidden (another tool owns the screen): a set of reasons. add/release return whether the hidden state
// flipped; onChange(hidden) is called when it does. Releasing an unknown reason does nothing.
export function createHideReasons(onChange = () => {}) {
  const reasons = new Set();
  const flip = (was) => {
    const now = reasons.size > 0;
    if (now !== was) onChange(now);
    return now !== was;
  };
  return {
    add(reason) { const was = reasons.size > 0; reasons.add(reason); return flip(was); },
    release(reason) { const was = reasons.size > 0; reasons.delete(reason); return flip(was); },
    has: (reason) => reasons.has(reason),
    get hidden() { return reasons.size > 0; },
    get list() { return [...reasons]; },
  };
}

// A value that is a web link: the whole value (trimmed) is an http or https URL with no spaces. Returns the URL text or
// null; any other scheme (javascript:, ftp:, mailto:) and text with a URL inside are not links.
export function cellLink(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!/^https?:\/\/[^\s]+$/i.test(text)) return null;
  try {
    const url = new URL(text);
    return url.protocol === "http:" || url.protocol === "https:" ? text : null;
  } catch {
    return null;
  }
}

// What a cell shows: { text, kind: "null" | "blank" | "value", link }. A null shows as a faint dash (kind "null"), blank
// text stays empty ("blank"), everything else as tableModel.cellText reads it. `copy` is what copying gives: "" for both
// null and blank.
export function cellDisplay(value, column) {
  if (value === null || value === undefined) return { text: "", kind: "null", link: null, copy: "" };
  if (typeof value === "string" && value.trim() === "") return { text: "", kind: "blank", link: null, copy: "" };
  const text = cellText(value, column);
  const link = column.domain?.type === "coded-value" ? null : cellLink(value);
  return { text, kind: "value", link, copy: text };
}

// The quick search's where clause over the visible columns, or null when the text is too short. Text columns:
// UPPER(field) LIKE '%X%' (quotes doubled; searchSql.containsWhere). Coded-value columns: the codes whose description
// contains the text. Numeric columns: an exact match when the text is a number. No column can match: "1=0".
export function quickSearchWhere(text, columns, { minChars = TABLE.SEARCH.MIN_CHARS } = {}) {
  const t = String(text ?? "").trim();
  if (t.length < minChars) return null;
  const parts = [];
  const num = /^[-+]?(\d+\.?\d*|\.\d+)$/.test(t.replace(/,/g, "")) ? Number(t.replace(/,/g, "")) : null;
  for (const c of columns) {
    const coded = c.domain?.type === "coded-value" ? c.domain.codedValues ?? [] : null;
    if (coded) {
      const hits = coded.filter((cv) => String(cv.name ?? "").toUpperCase().includes(t.toUpperCase())).map((cv) => cv.code);
      if (hits.length) parts.push(`${c.name} IN (${hits.map((v) => (typeof v === "number" ? String(v) : quote(v))).join(", ")})`);
      continue;
    }
    if (c.kind === "text") parts.push(containsWhere(c.name, t));
    else if (c.kind === "number" && num !== null && Number.isFinite(num)) parts.push(`${c.name} = ${num}`);
  }
  return parts.length ? parts.map((p) => `(${p})`).join(" OR ") : "1=0";
}

// Where clauses joined with AND (empty parts skipped); "1=1" for none.
export function andWhere(...parts) {
  const list = parts.filter((p) => typeof p === "string" && p.trim() !== "");
  if (!list.length) return "1=1";
  return list.length === 1 ? list[0] : list.map((p) => `(${p})`).join(" AND ");
}

// A header click: [{ field, order }] after clicking `field`. Plain click: ascending, then descending, then back to
// the default order (empty). Shift (add): the field is added ascending as a further sort, or its order flips, or (from
// descending) it is removed.
export function nextSort(sort, field, { add = false } = {}) {
  const at = sort.findIndex((s) => s.field === field);
  if (!add) {
    if (sort.length === 1 && at === 0) return sort[0].order === "asc" ? [{ field, order: "desc" }] : [];
    return [{ field, order: "asc" }];
  }
  if (at < 0) return [...sort, { field, order: "asc" }];
  if (sort[at].order === "asc") return sort.map((s, i) => (i === at ? { field, order: "desc" } : s));
  return sort.filter((_, i) => i !== at);
}
// The query's orderByFields: the sort (or the default sort when it is empty), then the object id as a tie breaker.
export function orderByFields(sort, objectIdField, defaultSort = []) {
  const list = sort.length ? sort : defaultSort;
  const out = list.map((s) => `${s.field} ${s.order === "desc" ? "DESC" : "ASC"}`);
  if (!list.some((s) => s.field.toLowerCase() === String(objectIdField).toLowerCase())) out.push(`${objectIdField} ASC`);
  return out;
}

// Tab-separated text for the clipboard: a header line, then one line per row. Tabs and line breaks inside values become
// spaces; nulls are empty.
export function tsv(header, rows) {
  const clean = (v) => (v === null || v === undefined ? "" : String(v).replace(/[\t\r\n]+/g, " "));
  return [header, ...rows].map((r) => r.map(clean).join("\t")).join("\r\n");
}

const safe = (text) => String(text ?? "").replace(/[^\p{L}\p{N}]/gu, "_");
const localDay = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
// "<layer title>_<YYYY-MM-DD>.csv", or "<layer title>_selected_<YYYY-MM-DD>.xlsx"; anything that is not a letter or
// digit becomes "_".
export const tableFileName = ({ title, selected = false, date, ext }) => `${[safe(title) || "table", selected ? "selected" : null, localDay(date)].filter(Boolean).join("_")}.${ext}`;

// The layer's stable key, never its title (titles change): its service URL plus layer id, else the portal item id plus
// layer id, else its id in the web map.
export function stableLayerKey(layer) {
  if (!layer) return null;
  const id = layer.layerId ?? null;
  if (layer.url) {
    let url = String(layer.url).split("?")[0].replace(/\/+$/, "");
    const tail = /\/(\d+)$/.exec(url);
    if (tail && (id === null || String(id) === tail[1])) url = url.slice(0, -tail[0].length);
    return `${url}/${id ?? (tail ? tail[1] : 0)}`;
  }
  if (layer.portalItem?.id) return `item:${layer.portalItem.id}/${id ?? 0}`;
  return `id:${layer.id}`;
}

// The footer line: parts joined with " · ".
export function footerText({ total = null, selected = 0, notShown = 0, extent = false, layerOff = false, drawnCap = null, notInRows = false, sortLocal = false }, T = TABLE.TEXT) {
  const parts = [];
  if (total !== null) parts.push(T.ROWS(total));
  if (selected) parts.push(T.FOOT_SELECTED(selected, notShown));
  if (extent) parts.push(T.FOOT_EXTENT);
  if (layerOff) parts.push(T.FOOT_LAYER_OFF);
  if (drawnCap) parts.push(T.FOOT_DRAWN(drawnCap));
  if (notInRows) parts.push(T.FOOT_NOT_IN_ROWS);
  if (sortLocal) parts.push(T.FOOT_SORT_LOCAL);
  return parts.join(" · ");
}

// The "Export info" sheet of a download: { header, rows } in tableModel's export cell format. info: { title, when (Date),
// rows (count), where (the layer's own filter, or ""), extent (bool), search (text, or ""), selectedOnly (bool),
// sort ([{ field, order }] with aliases as field names, [] for the default order) }.
export function exportInfoSheet(info, T = TABLE.TEXT.INFO) {
  const s = (v) => ({ t: "s", v: String(v) });
  const when = info.when;
  const time = `${localDay(when)} ${String(when.getHours()).padStart(2, "0")}:${String(when.getMinutes()).padStart(2, "0")}`;
  const sort = info.sort?.length ? info.sort.map((x) => `${x.field} ${x.order === "desc" ? "descending" : "ascending"}`).join(", ") : T.DEFAULT_SORT;
  return {
    header: ["Item", "Value"],
    rows: [
      [s(T.LAYER), s(info.title)],
      [s(T.TIME), s(time)],
      [s(T.ROWS), s(Number(info.rows).toLocaleString("en-US"))],
      [s(T.WHERE), s(info.where || T.NONE)],
      [s(T.EXTENT), s(info.extent ? T.YES : T.NONE)],
      [s(T.SEARCH), s(info.search || T.NONE)],
      [s(T.SELECTED), s(info.selectedOnly ? T.YES : T.NONE)],
      [s(T.SORT), s(sort)],
    ],
  };
}
