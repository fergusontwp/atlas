// Pure logic for "What's in this parcel". No DOM and no SDK imports, so it can be tested alone.
//
// The block is purely spatial: nothing here reads a field of a searched layer. The only per-layer metadata used is
// generic (title, geometry type, object id field, display field).

export const FEET_TO_METERS = 0.3048;

// ---- which layers can be searched
// A feature layer that supports queries, is shown in the layer list, is not the parcel layer and is not excluded by title.
export function isEligibleLayer(layer, parcel, excludeTitles = []) {
  if (!layer || layer === parcel) return false;
  if (layer.type !== "feature") return false; // keeps out media (plans), graphics and tile layers
  if (layer.listMode === "hide") return false;
  if (layer.capabilities?.operations?.supportsQuery === false) return false;
  return !excludeTitles.includes(layer.title);
}

// ---- the checklist as a tree of the map's groups
// A node is { kind: "layer", id, layer } or { kind: "group", id, title, layer, children: [node] }. The tree follows the
// Layers list: top-most first, and the same inside a group. A group appears only if it has an eligible descendant; a
// group whose list mode is "hide" is skipped with its children, and "hide-children" keeps its children out of the list
// (so it has nothing to show). A group named in excludeTitles is skipped with everything under it. `layers` is the
// map's (or a group's) layer collection or an array, bottom-most first as the SDK keeps it.
const toArray = (c) => (!c ? [] : Array.isArray(c) ? c : c.toArray());

export function buildTree(layers, parcel, excludeTitles = []) {
  const nodes = [];
  for (const layer of toArray(layers).slice().reverse()) {
    if (layer.type === "group") {
      if (layer.listMode === "hide" || layer.listMode === "hide-children") continue;
      if (excludeTitles.includes(layer.title)) continue;
      const children = buildTree(layer.layers, parcel, excludeTitles);
      if (children.length) nodes.push({ kind: "group", id: layer.id, title: layer.title ?? "Untitled group", layer, children });
    } else if (isEligibleLayer(layer, parcel, excludeTitles)) {
      nodes.push({ kind: "layer", id: layer.id, layer });
    }
  }
  return nodes;
}

// The eligible layers under a node (a layer is its own), in list order.
export const leavesOf = (node) => (node.kind === "layer" ? [node.layer] : node.children.flatMap(leavesOf));
export const treeLeaves = (nodes) => nodes.flatMap(leavesOf);
// Every group id in the tree.
export const groupIds = (nodes) => nodes.flatMap((n) => (n.kind === "group" ? [n.id, ...groupIds(n.children)] : []));

// "checked" when all the eligible layers under the group are checked, "indeterminate" when some are, else "unchecked".
export function groupState(node, checked) {
  const ids = leavesOf(node).map((l) => l.id);
  const n = ids.filter((id) => checked.has(id)).length;
  return n === 0 ? "unchecked" : n === ids.length ? "checked" : "indeterminate";
}

// A new set of checked layer ids after clicking a group: everything under it checked, or unchecked if it already was.
export function toggleGroup(node, checked) {
  const next = new Set(checked);
  const on = groupState(node, checked) !== "checked";
  for (const l of leavesOf(node)) (on ? next.add(l.id) : next.delete(l.id));
  return next;
}

// The layer ids that start checked: a layer whose title is listed, or any layer under a group whose title is listed.
export function defaultOnIds(nodes, titles) {
  const ids = new Set();
  const visit = (node, inherited) => {
    const on = inherited || titles.includes(node.kind === "group" ? node.title : node.layer.title);
    if (node.kind === "layer") { if (on) ids.add(node.id); return; }
    node.children.forEach((c) => visit(c, on));
  };
  nodes.forEach((n) => visit(n, false));
  return ids;
}

// Whether a layer is on in the map: its own switch and those of the groups above it (a layer in a switched-off group
// has visible === true itself, but is not drawn).
export function visibleInMap(layer, map) {
  for (let l = layer; l && l !== map; l = l.parent) if (l.visible === false) return false;
  return true;
}

// ---- radius
// cfg = WHATS_HERE.RADIUS ({ DEFAULT, MAX }). Anything unusable falls back to DEFAULT and is reported as not valid;
// a too-large value is clamped to MAX.
export function validateRadius(raw, { DEFAULT, MAX }) {
  const text = typeof raw === "string" ? raw.trim() : raw;
  const n = text === "" || text === null || text === undefined ? NaN : Number(text);
  if (!Number.isFinite(n) || n <= 0) return { value: DEFAULT, valid: false, clamped: false };
  const rounded = Math.round(n * 100) / 100;
  if (rounded > MAX) return { value: MAX, valid: true, clamped: true };
  return { value: rounded, valid: true, clamped: false };
}

// ---- what to ask the service
// mode "intersects": the parcel is shrunk inward by the strict tolerance first, so a neighbour that only shares an
//   edge doesn't count (shrinkMeters; 0 means use the parcel as it is).
// mode "within": the query's own distance and units grow the search around the parcel, which also includes anything
//   that intersects it.
// cfg = WHATS_HERE.
export function buildQueryOptions({ mode, radius }, cfg) {
  if (mode === "within") {
    return { spatialRelationship: "intersects", distance: validateRadius(radius, cfg.RADIUS).value, units: cfg.RADIUS.UNIT, shrinkMeters: 0 };
  }
  const tolerance = Math.max(0, Number(cfg.STRICT_TOLERANCE_FT) || 0);
  return { spatialRelationship: "intersects", distance: undefined, units: undefined, shrinkMeters: tolerance * FEET_TO_METERS };
}

// ---- text
// "None", "1 feature", "3 features", or, when the layer returned one more than the cap, "200+, showing the first 200".
export function countText({ count, overflow, max }) {
  if (overflow) return `${max}+, showing the first ${max}`;
  if (count === 0) return "None";
  return `${count} feature${count === 1 ? "" : "s"}`;
}

// A list item's label: the layer's display field value when it has one, else "<layer title> #<n>". The object id is
// always shown too, in small text, by the caller.
export function itemLabel({ title, displayValue, n }) {
  const has = displayValue !== null && displayValue !== undefined && String(displayValue).trim() !== "";
  return has ? String(displayValue).trim() : `${title} #${n}`;
}

// ---- emphasis: results look like the source layer, only bolder
// Results are drawn by a copy of the source layer whose symbols are the layer's own, with the same colors and alpha,
// but thicker outlines, lines and markers. Only simple fill, line and marker symbols can be made bolder safely.
export const emphasisKind = (symbolType) => ({ "simple-fill": "polygon", "simple-line": "line", "simple-marker": "marker" })[symbolType] ?? null;

const positive = (v, fallback) => (Number.isFinite(v) && v > 0 ? v : fallback);

// E = WHATS_HERE.EMPHASIS. Widths and sizes are in points.
export const outlineWidth = (width, { OUTLINE_FACTOR, MIN_OUTLINE_PX }) => Math.max(MIN_OUTLINE_PX, positive(width, 0) * OUTLINE_FACTOR);
export const lineWidth = (width, { LINE_FACTOR, MIN_LINE_PX = 0 }) => Math.max(MIN_LINE_PX, positive(width, 1) * LINE_FACTOR);
export const pointSize = (size, { POINT_FACTOR }) => positive(size, 8) * POINT_FACTOR;
// A marker's outline grows half as much as its size.
export const pointOutlineWidth = (width, { POINT_FACTOR }) => positive(width, 0) * (1 + (POINT_FACTOR - 1) / 2);

// The stronger version, for the emphasized item (hovered or picked): the same math with ACTIVE_FACTOR for every kind, and
// outlines and lines never thinner than ACTIVE_MIN_PX, so it still stands out against the copy's own bolder outline
// when the source layer is drawing (a factor alone only adds a fraction of a point to a thin outline).
export const activeEmphasis = (E) => ({
  ...E,
  OUTLINE_FACTOR: E.ACTIVE_FACTOR,
  LINE_FACTOR: E.ACTIVE_FACTOR,
  POINT_FACTOR: E.ACTIVE_FACTOR,
  MIN_OUTLINE_PX: Math.max(E.MIN_OUTLINE_PX ?? 0, E.ACTIVE_MIN_PX ?? 0),
  MIN_LINE_PX: E.ACTIVE_MIN_PX ?? 0,
});

// A polygon symbol that has no outline to thicken (none, style "none" or zero width) is given one in the fill color.
export const hasVisibleOutline = ({ present, width, style }) => !!present && style !== "none" && Number.isFinite(width) && width > 0;

// While the source layer is drawing its own features (on, and in its scale range so its view isn't suspended) the copy
// only adds a bolder outline, so its fill is made fully transparent: stacked translucent fills would look twice as opaque.
export const fillSuppressed = ({ sourceVisible, suspended }) => !!sourceVisible && !suspended;

// The items of `items` that at least one of `wanted` (a Set of strings) matches, by the keys `keysOf(item)` gives.
export const pickMatching = (items, keysOf, wanted) => (items ?? []).filter((item) => keysOf(item).some((k) => wanted.has(String(k))));

// ---- when to search
// Auto-run only while the block is open, a parcel is selected and at least one layer is checked.
export function emptyReason({ expanded, parcelSelected, checkedCount }) {
  if (!expanded) return "closed";
  if (!parcelSelected) return "no-parcel";
  if (checkedCount === 0) return "no-layers";
  return null;
}

// ---- amounts (Intersects mode only; approximate, planar, from the map geometry)
// A share of the parcel: "50%", "<1%" for slivers, "100%" when it covers (almost) all of it.
export function percentText(fraction) {
  if (!Number.isFinite(fraction) || fraction <= 0) return "0%";
  const p = fraction * 100;
  if (p < 1) return "<1%";
  if (p >= 99.5) return "100%";
  return `${Math.round(p)}%`;
}

// A length in feet: "131 ft", "<1 ft" for slivers.
export function lengthText(feet) {
  if (!Number.isFinite(feet) || feet <= 0) return "0 ft";
  if (feet < 1) return "<1 ft";
  return `${Math.round(feet).toLocaleString("en-US")} ft`;
}

// ---- hover and picked emphasis
// A result item is { layerId, oid }. Hovering (or focusing) an item emphasizes that feature on the map; the picked item
// (the last one clicked) is emphasized when nothing is hovered. Only one emphasis graphic exists at a time.
export const sameItem = (a, b) => !!a && !!b && a.layerId === b.layerId && a.oid === b.oid;

// Which feature is emphasized: the hovered one, else the picked one, else none.
export const activeItem = ({ hover, picked }) => hover ?? picked ?? null;

// The hover after a pointer or focus event on `item`. A leave only counts if that item is still the hovered one, so
// moving quickly from one item to the next (the old item's leave arriving after the new one's enter) leaves the new
// hover in place and nothing stale behind.
export function hoverAfter(hover, event, item) {
  if (event === "enter") return item;
  if (event === "leave") return sameItem(hover, item) ? null : (hover ?? null);
  return hover ?? null;
}
