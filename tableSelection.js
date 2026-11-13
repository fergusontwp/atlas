// The attribute table's selection model, per tab (attributeTable.js). Pure: no DOM and no SDK imports.
//
// A state is { ids: Set of object ids, anchor, active }: `ids` the table selection, `anchor` the row a Shift range starts
// from, `active` the row shown in the right panel (or null). Every function returns a new state (or the same one when
// nothing changes). `order` is the tab's current ordered id list (all matching rows, loaded or not).
import { TABLE } from "./config.js";

export const emptySelection = () => ({ ids: new Set(), anchor: null, active: null });

// A plain click: the selection becomes that row, and it is the active row.
export const clickRow = (state, oid) => ({ ids: new Set([oid]), anchor: oid, active: oid });

// Ctrl/Cmd-click, the checkbox, Space: the row is added or removed. An added row becomes the active row; removing the
// active row leaves no active row.
export function toggleRow(state, oid) {
  const ids = new Set(state.ids);
  if (ids.has(oid)) {
    ids.delete(oid);
    return { ids, anchor: oid, active: state.active === oid ? null : state.active };
  }
  ids.add(oid);
  return { ids, anchor: oid, active: oid };
}

// Shift-click: the rows from the anchor to this one, in the current order (loaded or not). `add` (Ctrl+Shift) keeps
// the rows already selected. With no anchor in the current rows it is a plain click. The anchor stays; the clicked row
// is the active one.
export function rangeTo(state, oid, order, { add = false } = {}) {
  const to = order.indexOf(oid);
  const from = state.anchor === null ? -1 : order.indexOf(state.anchor);
  if (to < 0) return state;
  if (from < 0) return clickRow(state, oid);
  const [a, b] = from <= to ? [from, to] : [to, from];
  const ids = add ? new Set(state.ids) : new Set();
  for (let i = a; i <= b; i++) ids.add(order[i]);
  return { ids, anchor: state.anchor, active: oid };
}

// Select every matching row: { state, ok }. Over `max` rows nothing changes and ok is false (the caller says why).
export function selectAll(state, order, max = TABLE.MAX_SELECT) {
  if (order.length > max) return { state, ok: false };
  return { state: { ids: new Set(order), anchor: state.anchor, active: state.active }, ok: true };
}

export const clearSelection = () => emptySelection();

// Make a row the active one (Enter, a map click on it, paging in the panel), without changing the selection.
export const setActive = (state, oid) => (state.active === oid ? state : { ...state, active: oid });

// How many selected ids are not in the current rows (after the where or the extent changed: they stay selected).
export function notShownCount(state, order) {
  if (!state.ids.size) return 0;
  const inOrder = order instanceof Set ? order : new Set(order);
  let n = 0;
  for (const id of state.ids) if (!inOrder.has(id)) n++;
  return n;
}

// The selected ids in table order (what the right panel pages through), then any not in the current rows, in the order
// they were selected.
export function panelList(state, order) {
  const out = [];
  const seen = new Set();
  for (const id of order) if (state.ids.has(id)) { out.push(id); seen.add(id); }
  for (const id of state.ids) if (!seen.has(id)) out.push(id);
  return out;
}
