import { HIGHLIGHT, MEASURE } from "./config.js";
import { casingColor, sanitizeColor } from "./selectionMode.js";
import { streetName } from "./roadSearchLogic.js";

// Measure's scratch list (section 54): pure helpers. Values are kept in base units (meters, square meters) and shown in
// the one length unit and one area unit in use; every text comes from MEASURE (config.js). measure.js does the drawing,
// the components and the storage.

const KIND_UNITS = { length: "LENGTH_UNITS", area: "AREA_UNITS" };
const KIND_DEFAULT = { length: "LENGTH_UNIT", area: "AREA_UNIT" };

// A saved unit for kind "length" | "area": kept if it is in that kind's list, else the config default (an unknown
// value, null, or the other kind's unit).
export function sanitizeUnit(value, kind, cfg = MEASURE) {
  const list = cfg[KIND_UNITS[kind]] ?? [];
  return typeof value === "string" && list.includes(value) ? value : cfg[KIND_DEFAULT[kind]];
}

// A value in base units as text in `unit`: "1,234.5 ft", "1.24 ac". Decimals and the short name from cfg.UNITS. An
// unknown unit or a value that isn't a finite number gives "".
export function formatMeasure(value, unit, cfg = MEASURE) {
  const u = cfg.UNITS?.[unit];
  if (!u || typeof value !== "number" || !Number.isFinite(value)) return "";
  const n = Math.abs(value) / u.PER; // a length or an area is never negative (a ring's orientation can make it so)
  return `${n.toLocaleString("en-US", { minimumFractionDigits: u.DECIMALS, maximumFractionDigits: u.DECIMALS })} ${u.ABBR}`;
}

// A name as typed: line breaks and runs of spaces become one space, trimmed, at most `max` characters. "" means no name.
export function cleanName(raw, max = MEASURE.NAME_MAX) {
  if (typeof raw !== "string") return "";
  return [...raw.replace(/\s+/g, " ").trim()].slice(0, max).join("").trim();
}

// What "Add selected feature" kind a selected geometry gives: "area" for a polygon (or extent), "length" for a line,
// null for a point or nothing.
export function measureKindOf(geometryType) {
  return { polygon: "area", extent: "area", polyline: "length" }[geometryType] ?? null;
}

// The default name of an added feature, as the panel calls it, but never from a field that could hold a person's name:
// a parcel by its title fields (the parcel ID), a road by its street name (NAME_FIELDS joined), anything else by its
// layer's title. A layer's display field is not used (a request's or contact's display field can be a name). Cleaned
// like a typed name; "" when nothing is left.
// feature: { isParcel, isRoad, attributes, layerTitle }; fields: { titleFields, roadFields }
export function featureMeasureName(feature, { titleFields = [], roadFields = [] } = {}, max = MEASURE.NAME_MAX) {
  const attrs = feature?.attributes ?? {};
  const text = (v) => (v === null || v === undefined ? "" : String(v).trim());
  let name = "";
  if (feature?.isParcel) name = titleFields.map((f) => text(attrs[f])).find(Boolean) ?? "";
  else if (feature?.isRoad) name = streetName(roadFields.map((f) => attrs[f]));
  if (!name || /[{}]/.test(name)) name = text(feature?.layerTitle);
  return cleanName(name, max);
}

// A measurement's color from its number (section 55): 1 is `startColor` (the highlight color when the session's first
// measurement was made); the next ones go through the presets in order, skipping the start color, then start again.
// From `n` alone, so a delete never shifts another item's color. presets: [[name, "#rrggbb"], ...] (HIGHLIGHT.PRESETS).
export function measureColor(n, startColor, presets = HIGHLIGHT.PRESETS) {
  const start = sanitizeColor(startColor);
  const cycle = (presets ?? []).map(([, hex]) => sanitizeColor(hex)).filter((hex, i, all) => hex !== start && all.indexOf(hex) === i);
  if (!Number.isInteger(n) || n <= 1 || !cycle.length) return start;
  return cycle[(n - 2) % cycle.length];
}

// The scratch list. Items, oldest first: { id, n, kind, name, color, geometry, values, source }. `n` counts up for the
// session and is never reused after a delete or a Clear, so "3" always means the same shape. add() returns the item, or
// null at the limit or for a bad kind. colorOf(n) gives a new item's color (#rrggbb); setColor() changes one.
export function createMeasureList({ max = MEASURE.MAX_ITEMS, nameMax = MEASURE.NAME_MAX, colorOf = () => HIGHLIGHT.DEFAULT_COLOR } = {}) {
  let items = [];
  let next = 1;
  return {
    get items() { return items.slice(); },
    get count() { return items.length; },
    get full() { return items.length >= max; },
    get max() { return max; },
    get(id) { return items.find((it) => it.id === id) ?? null; },
    add({ kind, geometry = null, values = {}, source = "drawn", name = "" }) {
      if (items.length >= max || !KIND_UNITS[kind]) return null;
      const n = next++;
      const item = { id: `m${n}`, n, kind, name: cleanName(name, nameMax), color: sanitizeColor(colorOf(n)), geometry, values: { ...values }, source: source === "feature" ? "feature" : "drawn" };
      items = [...items, item];
      return item;
    },
    rename(id, name) {
      const item = items.find((it) => it.id === id);
      if (!item) return null;
      item.name = cleanName(name, nameMax);
      return item;
    },
    setColor(id, color) {
      const item = items.find((it) => it.id === id);
      if (!item) return null;
      item.color = sanitizeColor(color, item.color);
      return item;
    },
    remove(id) {
      const before = items.length;
      items = items.filter((it) => it.id !== id);
      return items.length < before;
    },
    clear() { const had = items.length; items = []; return had; },
  };
}

// units: { length, area } (the units in use)
const areaText = (item, units, cfg) => formatMeasure(item.values.area, units.area, cfg);
const lengthText = (item, units, cfg) => formatMeasure(item.kind === "area" ? item.values.perimeter : item.values.length, units.length, cfg);

// The value as a row shows it: "1.24 ac · 980.2 ft" for an area (with its perimeter), "245.3 ft" for a length.
export function valueText(item, units, cfg = MEASURE) {
  return item.kind === "area" ? [areaText(item, units, cfg), lengthText(item, units, cfg)].filter(Boolean).join(" · ") : lengthText(item, units, cfg);
}

// The map label: "2 · north setback · 1.24 ac", or "2 · 1.24 ac" without a name. An area's label shows the area only.
export function labelText(item, units, cfg = MEASURE) {
  const value = item.kind === "area" ? areaText(item, units, cfg) : lengthText(item, units, cfg);
  return [String(item.n), item.name, value].filter(Boolean).join(" · ");
}

// One line for the clipboard: "2 north setback: 1.24 ac, perimeter 980.2 ft", "3: 245.3 ft".
export function copyLine(item, units, cfg = MEASURE) {
  const head = item.name ? `${item.n} ${item.name}` : String(item.n);
  if (item.kind !== "area") return `${head}: ${lengthText(item, units, cfg)}`;
  const perimeter = lengthText(item, units, cfg);
  return `${head}: ${areaText(item, units, cfg)}${perimeter ? `, ${cfg.TEXT.PERIMETER} ${perimeter}` : ""}`;
}

// Copy all: one line per item, oldest first (by number), in the units in use.
export function copyAllText(items, units, cfg = MEASURE) {
  return [...(items ?? [])].sort((a, b) => a.n - b.n).map((it) => copyLine(it, units, cfg)).join("\n");
}

// A measurement's symbols, drawn in this order: an area's light fill (with no outline), the contrasting casing
// (HIGHLIGHT.OUTLINE widths; black under a light color, white under a dark one, as printLeader.js decides), then a
// dashed line in the measurement's own color on top; the dash tells a measurement from the selected feature.
// emphasized (its row hovered or focused) widens both lines.
export function measureSymbols(kind, { color, emphasized = false, outline = HIGHLIGHT.OUTLINE, style = MEASURE.STYLE } = {}) {
  const main = sanitizeColor(color), casing = casingColor(main, outline.CASING_ALPHA);
  const extra = emphasized ? style.EMPHASIS_WIDTH : 0;
  const line = (c, width, dash) => ({ type: "simple-line", color: c, width: width + extra, style: dash ? style.DASH : "solid", cap: outline.CAP, join: outline.JOIN });
  if (kind !== "area") return [line(casing, outline.CASING_WIDTH, false), line(main, outline.WIDTH, true)];
  const rgb = [1, 3, 5].map((i) => parseInt(main.slice(i, i + 2), 16));
  return [
    { type: "simple-fill", color: [...rgb, style.FILL_ALPHA], outline: null },
    { type: "simple-fill", color: [0, 0, 0, 0], outline: line(casing, outline.CASING_WIDTH, false) },
    { type: "simple-fill", color: [0, 0, 0, 0], outline: line(main, outline.WIDTH, true) },
  ];
}
