import { h } from "./dom.js";
import { cellText, sortedIndexes, tabLabel } from "./tableModel.js";

// The results table: a large overlay over the MAP AREA (a child of #map-host, positioned inside it, so the shell's own
// layout moves and resizes it with the map and it can never cover the left panel or the parcel panel; not a viewport
// dialog) with a scrim over the map. One tab per searched layer that has results, one table at a time, built lazily from
// the features already in memory. Nothing here queries or changes the results.
//
//   host       #map-host
//   getTables  () => [table] (tableModel.buildTable), called when it opens
//   onPick     (layerId, oid): a row was clicked
//   onDownload ("csv" | "xlsx"): a Download menu item was chosen (the files are made by the caller from shown())
//   trigger    the button that opens it, where focus returns on close
export function createResultsTable({ host, getTables, onPick, onDownload, trigger }) {
  let tables = [];
  let active = 0; // tab index
  let returnFocus = null;
  const sorts = new Map(); // layerId -> { name, dir }, kept per tab while the overlay is open

  const tabsEl = h("div", { class: "here-table-tabs", role: "tablist", ariaLabel: "Searched layers" });
  // The Download menu: the active layer as CSV, or every layer as one Excel workbook.
  const downloadButton = h("calcite-button", { scale: "s", appearance: "outline", iconStart: "download", label: "Download" }, "Download");
  const item = (label, kind) => h("calcite-dropdown-item", { oncalciteDropdownItemSelect: () => onDownload?.(kind) }, label);
  const downloadMenu = h("calcite-dropdown", { scale: "s", placement: "bottom-end", referenceElement: downloadButton },
    h("calcite-dropdown-group", { selectionMode: "none" }, item("CSV: this layer", "csv"), item("Excel: all layers", "xlsx")));
  const actionsEl = h("div", { class: "here-table-actions" }, downloadButton, downloadMenu);
  const closeButton = h("calcite-action", { icon: "x", text: "Close", label: "Close the table", scale: "s", onclick: () => close() });
  const scroll = h("div", { class: "here-table-scroll", tabindex: "0", role: "region", ariaLabel: "Results table" });
  const footEl = h("div", { class: "here-table-foot", ariaLive: "polite" });
  const scrim = h("div", { class: "here-table-scrim", onclick: () => close() });
  const panel = h("div", { class: "here-table-panel", role: "dialog", ariaModal: "true", ariaLabel: "What's in this parcel: results table", tabindex: "-1" },
    h("div", { class: "here-table-head" }, h("div", { class: "here-table-title" }, "Results"), actionsEl, closeButton),
    tabsEl, scroll, footEl);
  const overlay = h("div", { class: "here-table-overlay", hidden: true, onkeydown: onKey }, scrim, panel);
  host.append(overlay);

  const FOCUSABLE = 'button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"]), calcite-action, calcite-button, calcite-dropdown';
  const focusables = () => [...panel.querySelectorAll(FOCUSABLE)].filter((el) => !el.hidden && !el.disabled && el.offsetParent !== null);
  function onKey(e) {
    if (e.key === "Escape") {
      e.stopPropagation();
      if (downloadMenu.open) downloadMenu.open = false; // the first Escape only closes the menu
      else close();
    } else if (e.key === "Tab") {
      const list = focusables();
      if (list.length === 0) return e.preventDefault();
      const i = list.findIndex((el) => el === e.target || el.contains(e.target));
      const next = e.shiftKey ? (i <= 0 ? list.length - 1 : i - 1) : i === list.length - 1 ? 0 : i + 1;
      e.preventDefault();
      list[next].focus();
    }
  }
  // Focus can't leave while it is open (a click on something outside is stopped by the scrim; this catches the rest).
  const keepFocus = (e) => {
    if (!overlay.hidden && !overlay.contains(e.target)) (focusables()[0] ?? panel).focus();
  };

  const current = () => tables[active];

  function renderTabs() {
    tabsEl.replaceChildren(...tables.map((t, i) =>
      h("button", { class: `here-table-tab${i === active ? " active" : ""}`, type: "button", role: "tab", ariaSelected: String(i === active), tabindex: i === active ? "0" : "-1",
        onclick: () => select(i),
        onkeydown: (e) => {
          if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
            e.preventDefault();
            e.stopPropagation();
            select((i + (e.key === "ArrowRight" ? 1 : tables.length - 1)) % tables.length, true);
          }
        } }, tabLabel(t.title, t.count))));
  }

  function order(table) {
    const s = sorts.get(table.layerId);
    const col = s && table.columns.find((c) => c.name === s.name);
    return col ? sortedIndexes(table.rows, col, s.dir) : table.rows.map((_, i) => i);
  }

  // Only the active tab's table exists in the DOM.
  function renderTable() {
    const t = current();
    if (!t) return scroll.replaceChildren();
    const s = sorts.get(t.layerId);
    const head = h("tr", {}, ...t.columns.map((c) => {
      const dir = s?.name === c.name ? s.dir : null;
      return h("th", { scope: "col", class: c.kind === "number" ? "num" : "", ariaSort: dir ? (dir === "asc" ? "ascending" : "descending") : "none" },
        h("button", { class: "here-th", type: "button", title: c.name, onclick: () => sortBy(c.name) },
          h("span", {}, c.alias), h("span", { class: "here-sort", ariaHidden: "true" }, dir === "asc" ? "▲" : dir === "desc" ? "▼" : "")));
    }));
    const rows = order(t).map((i) => {
      const row = t.rows[i];
      const oid = row[t.objectIdField];
      return h("tr", { class: "here-row-pick", tabindex: "0", onclick: () => onPick(t.layerId, oid), onkeydown: (e) => { if (e.key === "Enter") { e.preventDefault(); onPick(t.layerId, oid); } } },
        ...t.columns.map((c) => {
          const text = cellText(row[c.name], c);
          return h("td", { class: c.kind === "number" ? "num" : "", title: text.length > 30 ? text : "" }, text);
        }));
    });
    scroll.replaceChildren(h("table", { class: "here-table" }, h("thead", {}, head), h("tbody", {}, ...rows)));
    scroll.scrollTop = 0;
    footEl.textContent = [t.capNote, `${t.count.toLocaleString("en-US")} row${t.count === 1 ? "" : "s"}`].filter(Boolean).join(" · ");
  }

  function sortBy(name) {
    const t = current();
    const s = sorts.get(t.layerId);
    sorts.set(t.layerId, { name, dir: s?.name === name && s.dir === "asc" ? "desc" : "asc" });
    const top = scroll.scrollTop, left = scroll.scrollLeft;
    renderTable();
    scroll.scrollTop = top;
    scroll.scrollLeft = left;
    scroll.querySelector(`.here-th[title="${CSS.escape(name)}"]`)?.focus();
  }

  function select(i, focusTab = false) {
    active = i;
    renderTabs();
    renderTable();
    if (focusTab) tabsEl.children[i]?.focus();
  }

  function open() {
    if (!overlay.hidden) return;
    tables = getTables();
    if (tables.length === 0) return;
    returnFocus = document.activeElement;
    active = 0;
    sorts.clear();
    overlay.hidden = false;
    renderTabs();
    renderTable();
    document.addEventListener("focusin", keepFocus);
    (tabsEl.children[0] ?? panel).focus();
  }

  // restoreFocus is false when the results themselves went away (the button is hidden then).
  function close(restoreFocus = true) {
    if (overlay.hidden) return;
    overlay.hidden = true;
    downloadMenu.open = false;
    document.removeEventListener("focusin", keepFocus);
    scroll.replaceChildren();
    tabsEl.replaceChildren();
    tables = [];
    sorts.clear();
    const back = trigger && !trigger.hidden ? trigger : returnFocus;
    if (restoreFocus && back) (back.setFocus ? back.setFocus() : back.focus());
  }

  return {
    open,
    close,
    actionsHost: actionsEl,
    // The table on show and its rows in the order they are shown (what a download uses).
    shown: () => (current() ? { table: current(), order: order(current()), all: tables, orderOf: order } : null),
    get state() {
      const t = current();
      const s = t && sorts.get(t.layerId);
      return { open: !overlay.hidden, tabs: tables.map((x) => tabLabel(x.title, x.count)), active, sort: s ? { ...s } : null, rows: t ? scroll.querySelectorAll("tbody tr").length : 0 };
    },
  };
}
