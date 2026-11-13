import { TABLE } from "./config.js";
import { h } from "./dom.js";
import { tableColumns } from "./tableModel.js";
import { autoWidth, clampWidth, columnPrefs, popupFieldInfos, resolveColumns } from "./tableColumns.js";
import { andWhere, cellDisplay, footerText, nextSort, orderByFields, quickSearchWhere, stableLayerKey, tsv } from "./tableGridLogic.js";
import { clickRow, emptySelection, notShownCount, panelList, rangeTo, selectAll, setActive, toggleRow } from "./tableSelection.js";
import { createLayerBackend, createTableSource } from "./tableSource.js";
import { createTablePane, tableHide } from "./tablePane.js";
import { createTableGrid } from "./tableGrid.js";
import { createColumnChooser } from "./tableChooser.js";
import { exportTable } from "./tableExport.js";
import { layerVisibility, visibleInMap } from "./popupSelection.js";
import { setupTableMap } from "./tableMap.js";
import { toast } from "./toast.js";
import { setStatus } from "./ui.js";

// The attribute table (section 50): an "Open table" action in the Layers list opens a layer's attributes in a tab of a
// pane docked under the map (tablePane.js). Read only. One tab per layer; each tab keeps its own sort, filters,
// selection and scroll for the session (nothing about open tabs is saved). Rows come from tableSource.js (the ordered id
// list, then pages by id), columns from tableColumns.js (the user's changes, the Map Viewer setup, the pop-up's fields
// or all fields), cells from tableModel.js (the What's in this parcel table's rules).
//
// opts: { mapEl, panel, parcel, layerList (setupLayerList's return: setOpenTable), extraLayers () => [layers whose edits
// also refresh a tab of the same service] }
export async function setupAttributeTable({ mapEl, panel, parcel = null, layerList = null, extraLayers = () => [] }) {
  if (!TABLE.ENABLED) return null;
  const T = TABLE.TEXT;
  const map = mapEl.map;
  const requests = { ids: 0, idPage: 0, orderCheck: 0, rows: 0 }; // queries sent this session (viewer.table.requests)
  const tabs = [];
  let active = -1;

  const view = mapEl.view;
  const reactiveUtils = await $arcgis.import("@arcgis/core/core/reactiveUtils.js");
  const tableMap = await setupTableMap({ mapEl });
  const countRequest = (kind) => { requests[kind] = (requests[kind] ?? 0) + 1; };
  const pane = createTablePane({ mapEl, onCloseAll: () => closeAll(true), onStateChange: () => redraw() });

  // ---- the body: grid (with its loading / empty / error states) and footer
  const stateEl = h("div", { class: "table-state", hidden: true, role: "status" });
  const grid = createTableGrid({
    onRetry: (i) => { current()?.source.retry(i); },
    onRow: (e, i, oid, part) => rowClicked(e, oid, part),
    onSelectAll: () => toggleAll(),
    onHeader: (e, field) => sortBy(field, e.shiftKey),
    onResizeStart: (e, field) => resizeStart(e, field),
    onFit: (field) => fitColumn(field),
    onHover: (oid) => hovered(oid),
    onContext: (e, i, oid, field) => openMenu(oid, field, { x: e.clientX, y: e.clientY }),
    onKey: (e) => gridKey(e),
  });
  const gridWrap = h("div", { class: "table-grid-wrap" }, grid.el, stateEl);
  const footEl = h("div", { class: "table-foot", ariaLive: "polite" });
  // a download in progress: "Preparing 400 of 1,204" and Cancel, over the footer
  const progressText = h("span", {});
  const progressEl = h("div", { class: "table-progress", hidden: true, role: "status" },
    h("calcite-loader", { inline: true, scale: "s", label: T.DOWNLOAD }), progressText,
    h("button", { type: "button", class: "table-link", onclick: () => exporting?.abort() }, T.CANCEL));

  // ---- the toolbar (the active tab's): quick search, selection, Map extent, Columns, Download, More; then the filter chips
  const tip = (el, text) => { el.title = text; el.label = text; el.text = text; return el; };
  const searchBox = h("calcite-input-text", { class: "table-search", scale: "s", icon: "search", clearable: true, placeholder: T.SEARCH, label: T.SEARCH,
    oncalciteInputTextInput: () => searchTyped(), onkeydown: (e) => { if (e.key === "Escape" && searchBox.value) { e.stopPropagation(); e.preventDefault(); searchBox.value = ""; searchTyped(true); } } });
  const countChip = h("calcite-chip", { class: "table-count", scale: "s", hidden: true, icon: "check-square" });
  const zoomBtn = tip(h("calcite-action", { icon: "zoom-to-object", scale: "s", onclick: () => { const t = current(); if (t?.sel.ids.size) zoomTo(t, panelList(t.sel, t.source.ids)); } }), T.ZOOM_SELECTED);
  const onlyBtn = tip(h("calcite-action", { icon: "selection-filter", scale: "s", onclick: () => setFilter("selectedOnly", !current()?.filters.selectedOnly) }), T.SELECTED_ONLY);
  const clearBtn = tip(h("calcite-action", { icon: "selection-x", scale: "s", onclick: () => { const t = current(); if (t) applySelection(t, emptySelection()); } }), T.CLEAR_SELECTION);
  const extentBtn = tip(h("calcite-action", { icon: "extent", scale: "s", onclick: () => setFilter("extent", !current()?.filters.extent) }), T.MAP_EXTENT_TIP);
  const columnsBtn = tip(h("calcite-action", { icon: "column-settings", scale: "s", onclick: () => { const t = current(); if (!t) return; closeMenus(chooser); chooser.toggle(t); } }), T.COLUMNS);
  // More: row height, stripes, hover emphasis, reset columns. It stays open while you pick (closeOnSelectDisabled).
  // Calcite fires calciteDropdownItemSelect before it toggles the item's own check, so the checks are set again
  // from the saved preferences once it has (otherwise a check set here is flipped straight back).
  const menuItem = (label, onSelect, extra = {}) => h("calcite-dropdown-item", { oncalciteDropdownItemSelect: () => { onSelect(); setTimeout(syncMenu); }, ...extra }, label);
  const compactItem = menuItem(T.COMPACT, () => setPref("density", "compact"));
  const comfortableItem = menuItem(T.COMFORTABLE, () => setPref("density", "comfortable"));
  const stripesItem = menuItem(T.STRIPES, () => setPref("stripes", !prefs.stripes));
  const hoverItem = menuItem(T.HOVER, () => setPref("hover", !prefs.hover));
  const freezeItem = menuItem(T.FREEZE, () => setPref("freeze", !prefs.freeze));
  const moreBtn = tip(h("calcite-action", { icon: "ellipsis", scale: "s" }), T.MORE);
  const moreMenu = h("calcite-dropdown", { scale: "s", placement: "top-end", overlayPositioning: "fixed", referenceElement: moreBtn, widthScale: "m", closeOnSelectDisabled: true },
    h("calcite-dropdown-group", { groupTitle: T.DENSITY, selectionMode: "single" }, compactItem, comfortableItem),
    h("calcite-dropdown-group", { selectionMode: "multiple" }, stripesItem, hoverItem, freezeItem),
    h("calcite-dropdown-group", { selectionMode: "none" }, menuItem(T.RESET_COLUMNS, () => resetColumns())));
  // (the dropdown opens and closes itself from its referenceElement; a click handler toggling `open` as well undid it)
  function syncMenu() {
    compactItem.selected = prefs.density === "compact";
    comfortableItem.selected = prefs.density === "comfortable";
    stripesItem.selected = prefs.stripes;
    hoverItem.selected = prefs.hover;
    freezeItem.selected = prefs.freeze;
  }
  // Download: CSV or Excel, all matching rows or the selected ones (tableExport.js)
  const downloadBtn = tip(h("calcite-action", { icon: "download", scale: "s" }), T.DOWNLOAD);
  const dlItem = (label, format, which) => menuItem(label, () => download(format, which));
  const csvSelItem = dlItem(T.CSV_SELECTED, "csv", "selected"), xlsxSelItem = dlItem(T.XLSX_SELECTED, "xlsx", "selected");
  const downloadMenu = h("calcite-dropdown", { scale: "s", placement: "top-end", overlayPositioning: "fixed", referenceElement: downloadBtn, widthScale: "m" },
    h("calcite-dropdown-group", { selectionMode: "none" }, dlItem(T.CSV_ALL, "csv", "all"), csvSelItem, dlItem(T.XLSX_ALL, "xlsx", "all"), xlsxSelItem));
  downloadMenu.addEventListener("calciteDropdownBeforeOpen", () => {
    csvSelItem.disabled = xlsxSelItem.disabled = !current()?.sel.ids.size;
  });
  // One toolbar menu open at a time (Columns, Download, More). A dropdown with a referenceElement doesn't close itself
  // on an outside click or when another dropdown opens (Calcite 5.1 skips both for it), so it's done here.
  const dropdowns = [downloadMenu, moreMenu];
  function closeMenus(keep) {
    for (const d of dropdowns) if (d !== keep && d.open) d.open = false;
    if (keep !== chooser) chooser.hide();
  }
  for (const d of dropdowns) d.addEventListener("calciteDropdownBeforeOpen", () => closeMenus(d));
  document.addEventListener("pointerdown", (e) => {
    const path = e.composedPath();
    for (const d of dropdowns) if (d.open && !path.includes(d) && !path.includes(d.referenceElement)) d.open = false;
  }, true);
  const toolsEnd = h("div", { class: "table-tools-end" }, columnsBtn, downloadBtn, downloadMenu, moreBtn, moreMenu);
  const toolbar = h("div", { class: "table-toolbar", role: "toolbar", ariaLabel: T.PANE_LABEL },
    searchBox, h("div", { class: "table-tool-group" }, countChip, zoomBtn, onlyBtn, clearBtn), h("div", { class: "table-tool-group" }, extentBtn), toolsEnd);
  const chipsEl = h("div", { class: "table-chips", hidden: true });
  pane.body.append(toolbar, chipsEl, gridWrap, progressEl, footEl);
  const chooser = createColumnChooser({
    anchor: columnsBtn,
    onChange: (cols) => { const t = current(); if (t) setColumns(t, cols); },
    onReset: () => resetColumns(),
    onFreeze: (on) => setPref("freeze", on),
    getFreeze: () => prefs.freeze,
  });

  const current = () => tabs[active] ?? null;
  // view preferences, per browser (TABLE.PREFS_KEY): row height, stripes, hover emphasis, freezing the first column
  const prefs = { density: TABLE.DEFAULT_DENSITY, stripes: TABLE.STRIPES, hover: TABLE.HOVER.ENABLED, freeze: TABLE.COL.FREEZE_FIRST };
  try {
    const saved = JSON.parse(localStorage.getItem(TABLE.PREFS_KEY) ?? "null");
    if (saved && typeof saved === "object") {
      if (saved.density in TABLE.ROW_HEIGHT) prefs.density = saved.density;
      for (const k of ["stripes", "hover", "freeze"]) if (typeof saved[k] === "boolean") prefs[k] = saved[k];
    }
  } catch { /* the defaults */ }
  function setPref(key, value) {
    prefs[key] = value;
    try { localStorage.setItem(TABLE.PREFS_KEY, JSON.stringify(prefs)); } catch { /* applies for this visit */ }
    const tab = current();
    if (!tab) return;
    if (key === "density") {
      const first = Math.floor(grid.scroll.top / grid.model.rowHeight);
      grid.setModel(modelFor(tab), { scrollTop: first * rowHeight(), scrollLeft: grid.scroll.left });
    } else if (key === "hover") { if (!value) tableMap.setHover(null, null); }
    else grid.setModel(modelFor(tab), { keepScroll: true });
    syncMenu();
    chooser.refresh(tab);
  }
  syncMenu();
  const rowHeight = () => TABLE.ROW_HEIGHT[prefs.density] ?? TABLE.ROW_HEIGHT.compact;

  // ---- column setup for a layer
  function loadUserPrefs(key) {
    try { return JSON.parse(localStorage.getItem(TABLE.COL.STORAGE_KEY) ?? "{}")?.[key] ?? null; } catch { return null; }
  }
  function saveUserPrefs(key, value) {
    try {
      const all = JSON.parse(localStorage.getItem(TABLE.COL.STORAGE_KEY) ?? "{}") ?? {};
      if (value) all[key] = value; else delete all[key];
      localStorage.setItem(TABLE.COL.STORAGE_KEY, JSON.stringify(all));
    } catch { /* not saved: the change still applies now */ }
  }
  function columnsFor(tab) {
    const layer = tab.layer;
    const resolved = resolveColumns({
      fields: layer.fields,
      userPrefs: loadUserPrefs(tab.key),
      tableInfo: layer.attributeTableTemplate ?? null,
      popupFieldInfos: popupFieldInfos(layer.popupTemplate),
      objectIdField: layer.objectIdField,
      editFieldsInfo: layer.editFieldsInfo ?? null,
      overrides: TABLE.LAYERS[tab.key] ?? null,
    });
    if (resolved.dropped === "stale") { saveUserPrefs(tab.key, null); tab.notice = T.SHARED_CHANGED; }
    if (resolved.dropped === "bad") saveUserPrefs(tab.key, null);
    tab.resolved = resolved;
    tab.defaultSort = resolved.sort;
  }
  // The visible columns with their cell rules (tableModel.tableColumns) and widths.
  // A TABLE.LAYERS override's `freeze` field goes first (unless the user ordered the columns themselves).
  function visibleColumns(tab) {
    const out = tab.resolved.columns.filter((c) => c.visible && tab.meta.has(c.field)).map((c) => {
      const m = tab.meta.get(c.field);
      const hint = m.domain?.type === "coded-value" ? T.TYPE.coded : T.TYPE[m.kind] ?? T.TYPE.text;
      return { ...m, hint, width: c.width ?? tab.autoWidths.get(c.field) ?? TABLE.COL.DEFAULT_PX };
    });
    const f = tab.resolved.freeze;
    if (f && tab.resolved.source !== "user") {
      const i = out.findIndex((c) => c.name === f);
      if (i > 0) out.unshift(...out.splice(i, 1));
    }
    return out;
  }

  // ---- the user's column changes (chooser, resize): saved per layer with the fingerprint of the setup they change
  function setColumns(tab, columns, { save = true } = {}) {
    tab.resolved = { ...tab.resolved, columns, source: "user" };
    tab.notice = null;
    if (save) saveUserPrefs(tab.key, columnPrefs(columns, tab.resolved.fingerprint));
    applyColumns(tab);
  }
  function resetColumns(tab = current()) {
    if (!tab) return;
    saveUserPrefs(tab.key, null);
    tab.notice = null;
    tab.autoWidths.clear();
    columnsFor(tab);
    applyColumns(tab);
  }
  function applyColumns(tab) {
    tab.columns = visibleColumns(tab);
    tab.source.setOutFields([tab.layer.objectIdField, ...tab.columns.map((c) => c.name)]);
    if (tab === current()) { grid.refresh({ head: true }); updateFooter(tab); }
    chooser.refresh(tab);
  }
  // drag a header's right edge: the width follows (one layout per frame), saved on release
  function resizeStart(e, field) {
    const tab = current();
    if (!tab || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const handle = e.currentTarget ?? e.target;
    const start = e.clientX;
    const col = tab.columns.find((c) => c.name === field);
    if (!col) return;
    const w0 = col.width;
    let frame = 0, x = start;
    handle.setPointerCapture?.(e.pointerId);
    const moveTo = () => {
      frame = 0;
      col.width = clampWidth(w0 + (x - start));
      grid.relayout();
    };
    const onMove = (ev) => { x = ev.clientX; if (!frame) frame = requestAnimationFrame(moveTo); };
    const onUp = () => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onUp);
      cancelAnimationFrame(frame);
      moveTo();
      if (col.width !== w0) setColumns(tab, tab.resolved.columns.map((c) => (c.field === field ? { ...c, width: col.width } : c)));
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onUp);
  }
  // double-click a header's edge: fit the loaded rows (and the header)
  function fitColumn(field) {
    const tab = current();
    const col = tab?.columns.find((c) => c.name === field);
    if (!col) return;
    const family = getComputedStyle(grid.el).fontFamily || "sans-serif";
    let widest = measure(col.alias, `600 13px ${family}`) + measure(col.hint, `11px ${family}`) + 26;
    for (let i = 0; i < tab.source.total; i++) {
      const r = tab.source.row(i);
      if (r) widest = Math.max(widest, measure(cellDisplay(r[field], col).text, `13px ${family}`));
    }
    const width = clampWidth(widest + TABLE.COL.PAD_PX);
    setColumns(tab, tab.resolved.columns.map((c) => (c.field === field ? { ...c, width } : c)));
  }

  // ---- widths from the data: header and the first loaded page's text, measured once per column per tab
  const canvas = document.createElement("canvas").getContext("2d");
  function measure(text, font) {
    canvas.font = font;
    return canvas.measureText(text).width;
  }
  function measureWidths(tab) {
    const cols = visibleColumns(tab).filter((c) => !tab.autoWidths.has(c.name) && tab.resolved.columns.find((r) => r.field === c.name)?.width == null);
    if (!cols.length) return false;
    const n = Math.min(tab.source.total, TABLE.PAGE_SIZE);
    const rows = [];
    for (let i = 0; i < n; i++) { const r = tab.source.row(i); if (r) rows.push(r); }
    if (!rows.length && tab.source.total) return false;
    const family = getComputedStyle(grid.el).fontFamily || "sans-serif";
    for (const c of cols) {
      const header = measure(c.alias, `600 13px ${family}`) + measure(c.hint, `11px ${family}`) + 26;
      const cells = rows.map((r) => measure(cellDisplay(r[c.name], c).text, `13px ${family}`));
      tab.autoWidths.set(c.name, autoWidth(header, cells));
    }
    return true;
  }

  // ---- the model the grid draws for the active tab
  function modelFor(tab) {
    const src = tab.source;
    return {
      get columns() { return tab.columns; },
      freeze: prefs.freeze,
      total: src.status === "ready" ? src.total : 0,
      idAt: (i) => src.ids[i],
      row: (i) => src.row(i),
      pageStatus: (i) => src.pageStatus(i),
      ensure: (a, b) => src.ensure(a, b),
      isSelected: (oid) => tab.sel.ids.has(oid),
      get activeOid() { return tab.sel.active; },
      get sort() { return tab.sort.length ? tab.sort : tab.defaultSort; },
      get selectAll() { return selectAllState(tab); },
      rowHeight: rowHeight(),
      stripes: prefs.stripes,
    };
  }
  function selectAllState(tab) {
    if (!tab.sel.ids.size) return "none";
    const ids = tab.source.ids;
    return ids.length && ids.every((id) => tab.sel.ids.has(id)) ? "all" : "some";
  }

  // ---- tabs
  function tabLabel(tab) {
    const n = tab.source.status === "ready" ? ` (${tab.source.total.toLocaleString("en-US")})` : "";
    return `${tab.layer.title ?? T.PANE_LABEL}${n}`;
  }
  function renderTabs() {
    pane.tabsEl.replaceChildren(...tabs.map((tab, i) => {
      const close = h("calcite-action", { icon: "x", scale: "s", text: T.CLOSE_TAB, label: `${T.CLOSE_TAB}: ${tab.layer.title}`, title: T.CLOSE_TAB,
        onclick: (e) => { e.stopPropagation(); closeTab(tab); } });
      const el = h("div", {
        class: `table-tab${i === active ? " active" : ""}`, role: "tab", tabIndex: i === active ? 0 : -1, ariaSelected: i === active ? "true" : "false",
        title: tab.layer.title, onclick: () => activate(i),
        onauxclick: (e) => { if (e.button === 1) { e.preventDefault(); closeTab(tab); } },
        onmousedown: (e) => { if (e.button === 1) e.preventDefault(); }, // no autoscroll on a middle-click
        onkeydown: (e) => {
          if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
            const next = (i + (e.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
            activate(next);
            pane.tabsEl.children[next]?.focus();
            e.preventDefault();
          } else if (e.key === "Enter" || e.key === " ") { activate(i); e.preventDefault(); }
          else if (e.key === "Delete") { closeTab(tab); e.preventDefault(); }
        },
      }, h("span", { class: "table-tab-text" }, tabLabel(tab)), h("span", { class: "table-tab-dot", hidden: !tab.dot, title: T.FOOT_NOT_IN_ROWS }), close);
      tab.tabEl = el;
      return el;
    }));
    pane.tabsEl.children[active]?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  function activate(i) {
    if (i === active || !tabs[i]) { if (tabs[i]) renderTabs(); return; }
    const prev = current();
    if (prev) prev.scroll = grid.scroll;
    active = i;
    const tab = current();
    tab.dot = false;
    watchExtraLayers();
    hovered(null);
    closeMenu();
    chooser.hide();
    renderTabs();
    showTab(tab, { restoreScroll: true });
    watchActiveLayer();
    redraw();
    if (tab.stale) query(tab);
  }

  function showTab(tab, { restoreScroll = false } = {}) {
    tab.columns = visibleColumns(tab);
    grid.setModel(modelFor(tab), restoreScroll ? { scrollTop: tab.scroll.top, scrollLeft: tab.scroll.left } : { keepScroll: true });
    updateState(tab);
    updateFooter(tab);
  }

  // The tab's ordered id list again (where, sort or extent changed).
  async function query(tab) {
    const orderBy = orderByFields(tab.sort, tab.layer.objectIdField, tab.defaultSort);
    const f = tab.filters;
    // the layer's own filter is always in the where (as filter.js counts): the service applies it anyway, a client-side
    // layer's queryObjectIds doesn't
    const q = { where: andWhere(tab.layer.definitionExpression || null, tab.searchWhere ?? null), orderBy };
    if (f.extent && view.extent) q.geometry = view.extent.clone();
    if (f.selectedOnly) { if (tab.sel.ids.size) q.objectIds = [...tab.sel.ids]; else q.where = "1=0"; }
    tab.stale = false;
    clearTimeout(tab.loaderTimer);
    tab.loaderTimer = setTimeout(() => { tab.showLoader = true; if (tab === current()) updateState(tab); }, TABLE.LOADER_DELAY_MS);
    const res = await tab.source.setQuery(q);
    if (res.stale) return;
    clearTimeout(tab.loaderTimer);
    tab.showLoader = false;
    if (!tabs.includes(tab)) return;
    renderTabs();
    if (tab === current()) { showTab(tab); redraw(); }
  }

  function updateState(tab) {
    const src = tab.source;
    let content = null;
    if (src.status === "error") {
      content = [h("strong", {}, T.LAYER_ERROR), h("span", {}, ` ${src.error?.message ?? ""} `), h("button", { type: "button", class: "table-link", onclick: () => query(tab) }, T.RETRY)];
    } else if (src.status === "loading" && tab.showLoader) {
      content = [h("calcite-loader", { inline: true, scale: "s", label: T.LOADING }), h("span", {}, T.LOADING)];
    } else if (src.status === "ready" && src.total === 0) {
      content = [h("span", {}, T.EMPTY)];
      if (hasFilters(tab)) content.push(h("button", { type: "button", class: "table-link", onclick: () => clearFilters(tab) }, T.CLEAR_FILTERS));
    }
    stateEl.hidden = !content;
    if (content) stateEl.replaceChildren(...content);
  }

  function updateFooter(tab) {
    if (!tab) { footEl.textContent = ""; return; }
    const src = tab.source;
    footEl.textContent = footerText({
      total: src.status === "ready" ? src.total : null,
      selected: tab.sel.ids.size,
      notShown: notShownCount(tab.sel, src.ids),
      layerOff: !visibleInMap(tab.layer),
      drawnCap: tab.sel.ids.size > TABLE.MAX_DRAWN && visibleInMap(tab.layer) ? TABLE.MAX_DRAWN : null,
      notInRows: !!tab.notInRows,
      sortLocal: src.info.sortUnsupported && (tab.sort.length > 0 || tab.defaultSort.length > 0),
      extent: tab.filters.extent,
    });
    updateToolbar(tab);
  }

  // ---- filters: Map extent, selected only, quick search; each shows as a chip that removes it
  const hasFilters = (tab) => tab.filters.extent || tab.filters.selectedOnly || !!tab.searchWhere;
  function setFilter(name, on, tab = current()) {
    if (!tab || tab.filters[name] === on) return;
    if (name === "selectedOnly" && on && !tab.sel.ids.size) return;
    tab.filters[name] = on;
    updateToolbar(tab);
    query(tab);
  }
  function clearFilters(tab = current()) {
    if (!tab) return;
    tab.filters.extent = false;
    tab.filters.selectedOnly = false;
    tab.searchText = "";
    tab.searchInput = "";
    tab.searchWhere = null;
    if (tab === current()) searchBox.value = "";
    query(tab);
  }
  let searchTimer = 0;
  function searchTyped(now = false) {
    clearTimeout(searchTimer);
    const tab = current();
    if (!tab) return;
    const text = String(searchBox.value ?? "");
    tab.searchInput = text; // the box's text is kept per tab
    const run = () => {
      const where = quickSearchWhere(text, tab.columns, { minChars: TABLE.SEARCH.MIN_CHARS });
      if (where === tab.searchWhere) return;
      tab.searchText = where ? text.trim() : "";
      tab.searchWhere = where;
      query(tab);
    };
    if (now || !text.trim()) run();
    else searchTimer = setTimeout(run, TABLE.SEARCH.DEBOUNCE_MS);
  }
  function updateToolbar(tab) {
    if (!tab) return;
    const n = tab.sel.ids.size;
    countChip.hidden = !n;
    countChip.textContent = n ? T.SELECTED_CHIP(n) : "";
    for (const b of [zoomBtn, onlyBtn, clearBtn]) {
      b.disabled = !n && !(b === onlyBtn && tab.filters.selectedOnly);
      b.title = b.disabled ? `${b.label}: ${T.NOTHING_SELECTED}` : b.label;
    }
    onlyBtn.active = tab.filters.selectedOnly;
    extentBtn.active = tab.filters.extent;
    onlyBtn.setAttribute("aria-pressed", String(!!tab.filters.selectedOnly));
    extentBtn.setAttribute("aria-pressed", String(!!tab.filters.extent));
    if (searchBox.value !== (tab.searchInput ?? "")) searchBox.value = tab.searchInput ?? "";
    const chip = (text, remove) => h("calcite-chip", { scale: "s", closable: true, label: `${T.CHIP_REMOVE}: ${text}`, oncalciteChipClose: remove }, text);
    const chips = [];
    if (tab.filters.extent) chips.push(chip(T.CHIP_EXTENT, () => setFilter("extent", false, tab)));
    if (tab.filters.selectedOnly) chips.push(chip(T.CHIP_SELECTED, () => setFilter("selectedOnly", false, tab)));
    if (tab.searchWhere) chips.push(chip(T.CHIP_SEARCH(tab.searchText), () => { tab.searchInput = ""; searchBox.value = ""; tab.searchText = ""; tab.searchWhere = null; query(tab); }));
    chipsEl.replaceChildren(...chips);
    chipsEl.hidden = !chips.length;
  }

  // Map extent: the tabs with it on follow the view, once it stops moving (debounced); a tab not shown re-queries when
  // it is shown again.
  let extentTimer = 0;
  reactiveUtils.when(() => view.stationary, () => {
    clearTimeout(extentTimer);
    extentTimer = setTimeout(() => {
      for (const t of tabs) {
        if (!t.filters.extent) continue;
        if (t === current() && pane.shown) query(t);
        else t.stale = true;
      }
    }, TABLE.EXTENT_DEBOUNCE_MS);
  });

  // ---- sorting, on the server: a header click cycles ascending, descending, the default order; Shift adds a field
  function sortBy(field, add) {
    const tab = current();
    if (!tab) return;
    const now = tab.sort.length ? tab.sort : tab.defaultSort;
    const next = nextSort(now, field, { add });
    tab.sort = next;
    grid.refresh({ head: true });
    query(tab);
  }

  function onSourceChange(tab, what) {
    if (tab !== current()) { if (what === "ids") renderTabs(); return; }
    if (what === "rows") {
      if (measureWidths(tab)) { tab.columns = visibleColumns(tab); grid.refresh({ head: true }); }
      else grid.refresh();
    }
    if (what === "status") updateState(tab);
  }

  // ---- selection (tableSelection.js): the rows, the right panel's list and the map
  // Apply a new selection to a tab: the grid, the footer, the map, and (unless `panel` is false) the right panel, which
  // shows the active row and pages through the selected rows in table order.
  function applySelection(tab, next, { toPanel = true } = {}) {
    const prevActive = tab.sel.active;
    tab.sel = next;
    tab.notInRows = false;
    if (!next.ids.size && tab.filters.selectedOnly) { tab.filters.selectedOnly = false; query(tab); }
    if (tab === current()) { grid.refresh(); updateFooter(tab); }
    redraw();
    if (toPanel) showInPanel(tab, prevActive);
  }
  function showInPanel(tab, prevActive = null) {
    const list = panelList(tab.sel, tab.source.ids);
    const ours = panel.list?.layer === tab.layer;
    if (tab.sel.active === null) {
      // nothing selected any more: the panel keeps the feature it shows (Esc or Clear in the table never clears the
      // panel's selection), without the list to page through
      if (!list.length) {
        const shown = panel.selectedFeature();
        if (ours && shown?.layer === tab.layer && shown.oid !== null) panel.showList(tab.layer, [shown.oid], 0);
        return;
      }
      if (!ours) return;
      // the active row was deselected: the panel moves to the nearest selected row
      const was = panel.list.oids.indexOf(prevActive);
      tab.sel = setActive(tab.sel, list[Math.max(0, Math.min(was < 0 ? 0 : was, list.length - 1))]);
      if (tab === current()) grid.refresh();
    }
    const at = list.indexOf(tab.sel.active);
    panel.showList(tab.layer, list, at < 0 ? 0 : at, {
      onIndex: (j, oid) => { // paging in the panel moves the table's mark
        tab.sel = setActive(tab.sel, oid);
        if (tab !== current()) return;
        grid.refresh();
        const k = tab.source.indexOf(oid);
        if (k >= 0) grid.scrollToIndex(k);
      },
    });
  }
  const tooMany = () => toast(T.TOO_MANY(TABLE.MAX_SELECT), "", { kind: "warning" });
  function rowClicked(e, oid, part) {
    const tab = current();
    if (!tab || part === "link") return;
    if (part === "double") { zoomTo(tab, [oid]); return; }
    const order = tab.source.ids;
    let next;
    if (e.shiftKey) next = rangeTo(tab.sel, oid, order, { add: e.ctrlKey || e.metaKey || part === "check" });
    else if (part === "check" || e.ctrlKey || e.metaKey) next = toggleRow(tab.sel, oid);
    else next = clickRow(tab.sel, oid);
    if (next.ids.size > TABLE.MAX_SELECT) { tooMany(); grid.refresh(); return; }
    applySelection(tab, next);
  }
  // The header checkbox (and Ctrl+A): every matching row (up to MAX_SELECT), or none when all are selected.
  function toggleAll(selectOnly = false) {
    const tab = current();
    if (!tab || tab.source.status !== "ready") return;
    if (selectAllState(tab) === "all") { if (!selectOnly) applySelection(tab, emptySelection()); return; }
    const res = selectAll(tab.sel, tab.source.ids);
    if (!res.ok) { tooMany(); grid.refresh(); return; }
    applySelection(tab, res.state, { toPanel: panel.list?.layer === tab.layer });
  }

  // The active tab's selection on the map (tableMap.js): only while the pane shows and the layer is on.
  let drawToken = 0;
  let lastDraw = null;
  async function redraw() {
    const tab = current();
    const on = !!tab && pane.shown && visibleInMap(tab.layer);
    tableMap.setEnabled(on);
    if (!tab) return;
    const mine = ++drawToken;
    if (on) {
      const stats = await tableMap.show(tab, panelList(tab.sel, tab.source.ids), { onRequest: countRequest });
      if (mine === drawToken) lastDraw = stats;
    }
    if (tab === current()) updateFooter(tab);
  }
  // the active tab's layer switched on or off (through any parent): draw or stop drawing, and say so in the footer
  let activeWatch = null;
  function watchActiveLayer() {
    activeWatch?.remove();
    const tab = current();
    if (!tab) return;
    activeWatch = reactiveUtils.watch(() => layerVisibility(tab.layer), () => redraw());
  }

  // Zoom to rows: one feature to its own shape (a point to TABLE.POINT_ZOOM_SCALE), several to their extent from the
  // service (queryExtent), expanded by TABLE.ZOOM_EXPAND.
  async function zoomTo(tab, oids) {
    if (!oids.length) return;
    try {
      let target;
      if (oids.length === 1) {
        const g = await tableMap.geometryOf(tab, oids[0]);
        if (!g) return;
        target = g.type === "point" ? { target: g, scale: TABLE.POINT_ZOOM_SCALE } : { target: (g.extent ?? g).clone().expand(TABLE.ZOOM_EXPAND) };
      } else {
        countRequest("extent");
        const { extent } = await tab.layer.queryExtent({ objectIds: oids, outSpatialReference: view.spatialReference });
        if (!extent) return;
        target = extent.width === 0 && extent.height === 0 ? { target: extent.center, scale: TABLE.POINT_ZOOM_SCALE } : { target: extent.clone().expand(TABLE.ZOOM_EXPAND) };
      }
      await view.goTo(target.scale ? { target: target.target, scale: target.scale } : target.target);
    } catch (err) {
      if (err?.name !== "AbortError") console.warn("Attribute table: couldn't zoom:", err);
    }
  }

  // ---- map click sync: a feature shown in the panel by a click or a search marks its row in its open tab (the active
  // tab scrolls to it; another tab gets a dot). Closing the panel clears the active row. The table selection stays.
  panel.onSelectionChange((f) => {
    if (f?.source === "table") return;
    for (const t of tabs) {
      if (t.sel.active !== null && !(f && t.layer === f.layer && t.sel.active === f.oid)) t.sel = setActive(t.sel, null);
    }
    const tab = f ? tabs.find((t) => t.layer === f.layer) : null;
    if (tab && f.oid !== null && pane.shown) {
      tab.sel = setActive(tab.sel, f.oid);
      if (tab === current()) {
        const i = tab.source.indexOf(f.oid);
        tab.notInRows = i < 0;
        if (i >= 0) grid.scrollToIndex(i);
      } else { tab.dot = true; renderTabs(); }
    }
    if (current()) { grid.refresh(); updateFooter(current()); }
  });

  // ---- hover: the row under the pointer emphasized on the map after HOVER.DELAY_MS on the same row
  let hoverTimer = 0, hoverWant = null;
  function hovered(oid) {
    const tab = current();
    if (oid === hoverWant) return;
    hoverWant = oid;
    clearTimeout(hoverTimer);
    if (oid === null || !tab || !prefs.hover || !pane.shown || !visibleInMap(tab.layer)) { tableMap.setHover(null, null); return; }
    hoverTimer = setTimeout(() => { if (hoverWant === oid && current() === tab) tableMap.setHover(tab, oid); }, TABLE.HOVER.DELAY_MS);
  }

  // ---- copy: a cell's shown value, a row, the selected rows (tab-separated, a header line first)
  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      toast(T.COPIED, "", { kind: "success", duration: "fast" });
    } catch (err) {
      console.warn("Attribute table: couldn't copy:", err);
      setStatus("warning", T.COPY_FAILED, T.COPY_FAILED_MSG);
    }
  }
  const header = (tab) => tab.columns.map((c) => c.alias);
  const rowValues = (tab, attrs) => tab.columns.map((c) => cellDisplay(attrs?.[c.name], c).copy);
  async function rowsFor(tab, oids) { // attributes of rows by id, from the loaded pages, else from the layer
    const out = new Map();
    const missing = [];
    for (const oid of oids) { const i = tab.source.indexOf(oid); const r = i >= 0 ? tab.source.row(i) : undefined; if (r) out.set(oid, r); else missing.push(oid); }
    if (missing.length) {
      const got = await createLayerBackend(tab.layer, { onRequest: countRequest }).fetchRows(missing, [tab.layer.objectIdField, ...tab.columns.map((c) => c.name)]);
      for (const [k, v] of got) out.set(k, v);
    }
    return out;
  }
  async function copyRows(tab, oids) {
    const capped = oids.slice(0, TABLE.COPY_MAX_ROWS);
    try {
      const rows = await rowsFor(tab, capped);
      await copyText(tsv(header(tab), capped.map((oid) => rowValues(tab, rows.get(oid)))));
      if (oids.length > capped.length) toast(T.COPY_CAP(TABLE.COPY_MAX_ROWS), "", { kind: "warning" });
    } catch (err) {
      console.warn("Attribute table: couldn't read the rows to copy:", err);
      setStatus("warning", T.COPY_FAILED, err.message ?? String(err));
    }
  }
  function copyCell(tab, oid, field) {
    const col = tab.columns.find((c) => c.name === field);
    const i = tab.source.indexOf(oid);
    if (!col || i < 0) return;
    copyText(cellDisplay(tab.source.row(i)?.[field], col).copy);
  }

  // ---- the row menu (right-click, Shift+F10, the Menu key): over the map column only, never the browser's own menu
  const menuAction = (icon, text) => { const a = h("calcite-action", { icon, text, textEnabled: true, scale: "s" }); a.setAttribute("role", "menuitem"); return a; };
  const mZoom = menuAction("zoom-to-object", T.MENU_ZOOM), mShow = menuAction("information", T.MENU_SHOW), mSelect = menuAction("check-square", T.MENU_SELECT),
    mCopyValue = menuAction("copy", T.MENU_COPY_VALUE), mCopyRow = menuAction("copy", T.MENU_COPY_ROW), mCopySel = menuAction("copy", T.MENU_COPY_SELECTED);
  const menuEl = h("div", { class: "table-menu", role: "menu", hidden: true, ariaLabel: T.PANE_LABEL }, mZoom, mShow, mSelect, mCopyValue, mCopyRow, mCopySel);
  document.getElementById("map-column").append(menuEl);
  let menuFor = null; // { tab, oid, field }
  function openMenu(oid, field, at) {
    const tab = current();
    if (!tab) return;
    menuFor = { tab, oid, field };
    const selected = tab.sel.ids.has(oid);
    mSelect.text = selected ? T.MENU_DESELECT : T.MENU_SELECT;
    mSelect.icon = selected ? "square" : "check-square";
    mCopyValue.hidden = !field;
    mCopySel.hidden = tab.sel.ids.size < 2;
    menuEl.hidden = false;
    const col = document.getElementById("map-column").getBoundingClientRect(), r = menuEl.getBoundingClientRect();
    menuEl.style.left = `${Math.max(col.left, Math.min(at.x, col.right - r.width)) - col.left}px`;
    menuEl.style.top = `${Math.max(col.top, Math.min(at.y, col.bottom - r.height)) - col.top}px`;
    mZoom.setFocus();
  }
  function closeMenu(focusBack = false) {
    if (menuEl.hidden) return;
    menuEl.hidden = true;
    if (focusBack) grid.setFocus(grid.focus.row, grid.focus.col);
  }
  const fromMenu = (fn) => () => { const m = menuFor; closeMenu(true); if (m && m.tab === current()) fn(m); };
  mZoom.addEventListener("click", fromMenu((m) => zoomTo(m.tab, [m.oid])));
  mShow.addEventListener("click", fromMenu((m) => { const next = m.tab.sel.ids.has(m.oid) ? setActive(m.tab.sel, m.oid) : clickRow(m.tab.sel, m.oid); applySelection(m.tab, next); }));
  mSelect.addEventListener("click", fromMenu((m) => applySelection(m.tab, toggleRow(m.tab.sel, m.oid))));
  mCopyValue.addEventListener("click", fromMenu((m) => copyCell(m.tab, m.oid, m.field)));
  mCopyRow.addEventListener("click", fromMenu((m) => copyRows(m.tab, [m.oid])));
  mCopySel.addEventListener("click", fromMenu((m) => copyRows(m.tab, panelList(m.tab.sel, m.tab.source.ids))));
  menuEl.addEventListener("keydown", (e) => {
    const items = [...menuEl.children].filter((a) => !a.hidden);
    const at = items.findIndex((a) => a === e.target || a.contains(e.target));
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { items[(at + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.setFocus(); e.preventDefault(); }
    else if (e.key === "Escape" || e.key === "Tab") { e.preventDefault(); e.stopPropagation(); closeMenu(true); }
  });
  document.addEventListener("pointerdown", (e) => { if (!menuEl.hidden && !e.composedPath().includes(menuEl)) closeMenu(); }, true);
  // no browser menu over the table (a right-click on the grid's empty space, the header or the toolbar)
  pane.el.addEventListener("contextmenu", (e) => { if (!e.composedPath().some((n) => n?.tagName === "INPUT" || n?.tagName === "CALCITE-INPUT-TEXT")) e.preventDefault(); });

  // ---- keyboard on the grid (role="grid", one cell in the tab order): arrows, Home / End (Ctrl: first / last row),
  // Page Up / Down, Space toggles, Enter makes the row active (on a header: sorts), Ctrl+A selects all matching rows,
  // Ctrl+C copies the cell, Shift+F10 / Menu opens the row menu. Tab leaves the grid.
  function gridKey(e) {
    const tab = current();
    if (!tab || e.target.closest?.(".tgrid-check") && e.key === " ") return;
    const total = tab.source.total, cols = tab.columns.length + 1;
    const { row, col } = grid.focus;
    const ctrl = e.ctrlKey || e.metaKey;
    const go = (r, c) => { e.preventDefault(); grid.setFocus(Math.max(-1, Math.min(total - 1, r)), Math.max(0, Math.min(cols - 1, c))); };
    const oid = row >= 0 ? tab.source.ids[row] : undefined;
    switch (e.key) {
      case "ArrowDown": return go(row + 1, col);
      case "ArrowUp": return go(row - 1, col);
      case "ArrowRight": return go(row, col + 1);
      case "ArrowLeft": return go(row, col - 1);
      case "Home": return ctrl ? go(0, col) : go(row, 0);
      case "End": return ctrl ? go(total - 1, col) : go(row, cols - 1);
      case "PageDown": return go(row + grid.viewRows, col);
      case "PageUp": return go(Math.max(0, row - grid.viewRows), col);
      case " ":
        e.preventDefault();
        if (row < 0) { if (col === 0) toggleAll(); return; }
        if (oid !== undefined) applySelection(tab, e.shiftKey ? rangeTo(tab.sel, oid, tab.source.ids, { add: true }) : toggleRow(tab.sel, oid));
        return;
      case "Enter":
        e.preventDefault();
        if (row < 0) { if (col === 0) toggleAll(); else sortBy(tab.columns[col - 1].name, e.shiftKey); return; }
        if (oid !== undefined) applySelection(tab, tab.sel.ids.has(oid) ? setActive(tab.sel, oid) : toggleRow(tab.sel, oid));
        return;
      case "ContextMenu":
      case "F10":
        if (e.key === "F10" && !e.shiftKey) return;
        if (oid !== undefined) {
          e.preventDefault();
          const r = grid.cellEl(row, col)?.getBoundingClientRect();
          openMenu(oid, col > 0 ? tab.columns[col - 1]?.name : null, r ? { x: r.left + 8, y: r.bottom } : { x: 0, y: 0 });
        }
        return;
      default:
        if (ctrl && (e.key === "a" || e.key === "A")) { e.preventDefault(); toggleAll(true); return; }
        if (ctrl && (e.key === "c" || e.key === "C") && oid !== undefined && col > 0) { e.preventDefault(); copyCell(tab, oid, tab.columns[col - 1].name); }
    }
  }

  // ---- Esc inside the pane is the pane's (a capture listener only while focus is inside it, so the app's own Esc,
  // which clears the panel selection, never runs): menus first, then the quick search, then the selection, then a
  // maximized pane goes back to its height.
  function paneEscape(e) {
    if (e.key !== "Escape") return;
    if (!pane.el.contains(document.activeElement) && !menuEl.contains(document.activeElement)) return;
    e.stopPropagation();
    const tab = current();
    if (!menuEl.hidden) { e.preventDefault(); closeMenu(true); return; }
    if (moreMenu.open) { moreMenu.open = false; e.preventDefault(); return; }
    if (downloadMenu.open) { downloadMenu.open = false; e.preventDefault(); return; }
    if (chooser.open) return; // the chooser closes itself
    e.preventDefault();
    if (tab && (searchBox.value || tab.searchWhere)) { searchBox.value = ""; searchTyped(true); return; }
    if (tab && tab.sel.ids.size) { applySelection(tab, emptySelection()); return; }
    pane.restoreFromMaximized();
  }
  let escOn = false;
  const escListen = (on) => {
    if (on === escOn) return;
    escOn = on;
    if (on) window.addEventListener("keydown", paneEscape, true);
    else window.removeEventListener("keydown", paneEscape, true);
  };
  pane.el.addEventListener("focusin", () => escListen(true));
  pane.el.addEventListener("focusout", (e) => { if (!pane.el.contains(e.relatedTarget) && !menuEl.contains(e.relatedTarget)) escListen(false); });
  menuEl.addEventListener("focusin", () => escListen(true));

  // ---- downloads
  let exporting = null; // the AbortController of the download being prepared
  async function download(format, which) {
    const tab = current();
    if (!tab || exporting || tab.source.status !== "ready") return;
    const ids = which === "selected" ? panelList(tab.sel, tab.source.ids) : tab.source.ids;
    if (!ids.length) { toast(T.EXPORT_NOTHING, "", { kind: "warning" }); return; }
    if (ids.length > TABLE.EXPORT_MAX_ROWS) { toast(T.EXPORT_CAP(TABLE.EXPORT_MAX_ROWS), "", { kind: "warning" }); return; }
    const ctl = (exporting = new AbortController());
    downloadBtn.disabled = true;
    progressEl.hidden = false;
    const alias = (f) => tab.meta.get(f)?.alias ?? f;
    const sort = (tab.sort.length ? tab.sort : tab.defaultSort).map((x) => ({ field: alias(x.field), order: x.order }));
    const backend = createLayerBackend(tab.layer, { onRequest: countRequest });
    try {
      await exportTable({
        tab, ids, selected: which === "selected", format, signal: ctl.signal,
        fetchRows: (list, fields, opts) => backend.fetchRows(list, fields, opts),
        info: { where: tab.layer.definitionExpression ?? "", extent: tab.filters.extent, search: tab.searchText, selectedOnly: which === "selected" || tab.filters.selectedOnly, sort },
        onProgress: (done, total) => { progressText.textContent = T.PREPARING(done, total); },
      });
    } catch (err) {
      if (err?.name !== "AbortError") {
        console.warn("Attribute table: couldn't prepare the download:", err);
        setStatus("warning", T.EXPORT_FAILED, err.message ?? String(err));
      }
    } finally {
      exporting = null;
      downloadBtn.disabled = false;
      progressEl.hidden = true;
    }
  }

  // ---- lifecycle: the layer's own filter, its title, edits, removal from the map
  // A definitionExpression change (the parcel filter's Apply and Clear, or any layer's) re-queries the tab; a new title
  // renames it; edits through this layer object (applyEdits: the activity log's record editor, for one) reload its rows.
  function watchTab(tab) {
    const layer = tab.layer;
    return [
      reactiveUtils.watch(() => layer.definitionExpression, () => query(tab)),
      reactiveUtils.watch(() => layer.title, () => renderTabs()),
      layer.on?.("edits", (event) => edited(tab, event)),
    ];
  }
  // Layer objects that aren't on the map but write to the same service (the Notes and Plans layers): their edits refresh
  // a tab of that service too. Checked when a tab opens or is shown, since those layers load later.
  const watchedExtra = new WeakMap(); // layer -> handle
  function watchExtraLayers() {
    for (const layer of extraLayers() ?? []) {
      if (!layer || watchedExtra.has(layer) || typeof layer.on !== "function") continue;
      const key = stableLayerKey(layer);
      watchedExtra.set(layer, layer.on("edits", (event) => { for (const t of tabs) if (t.key === key && t.layer !== layer) edited(t, event); }));
    }
  }
  // Edits: added or deleted features change the id list (re-queried; the scroll and selection stay); updates reload the
  // rows and the edited features' geometry.
  function edited(tab, event) {
    const added = event?.addedFeatures?.length ?? 0, deleted = event?.deletedFeatures?.length ?? 0;
    tableMap.forget(tab);
    if (added || deleted) query(tab);
    else { tab.source.refresh(); if (tab === current()) redraw(); }
  }
  // A layer removed from the map: its tab closes and its drawing goes.
  map.allLayers.on("change", () => {
    for (const tab of [...tabs]) if (!map.allLayers.includes(tab.layer)) closeTab(tab);
  });

  // ---- open and close
  const eligible = (layer) => !!layer && panel.selectable.eligible(layer) && typeof layer.queryObjectIds === "function";
  const findLayer = (layerOrTitle) => (typeof layerOrTitle === "string"
    ? map.allLayers.find((l) => l.title === layerOrTitle) ?? null
    : layerOrTitle ?? null);

  function open(layerOrTitle) {
    const layer = findLayer(layerOrTitle);
    if (!eligible(layer)) { console.warn("Attribute table: this layer can't open a table (it needs a pop-up and queries).", layerOrTitle); return null; }
    const at = tabs.findIndex((t) => t.layer === layer);
    if (at >= 0) { activate(at); pane.setOpen(true); return tabs[at]; }
    const tab = {
      key: stableLayerKey(layer), layer, sort: [], defaultSort: [], sel: emptySelection(), scroll: { top: 0, left: 0 },
      autoWidths: new Map(), dot: false, notice: null, searchWhere: null, searchText: "", searchInput: "", stale: false,
      filters: { extent: false, selectedOnly: false },
      meta: new Map(tableColumns(layer.fields, { objectIdField: layer.objectIdField, timeZoneOf: (n) => layer.fieldsIndex?.getTimeZone?.(n) ?? null }).map((c) => [c.name, c])),
    };
    tab.source = createTableSource(createLayerBackend(layer, { onRequest: (kind) => { requests[kind] = (requests[kind] ?? 0) + 1; } }),
      { onChange: (what) => onSourceChange(tab, what) });
    columnsFor(tab);
    tab.columns = visibleColumns(tab);
    tab.source.setOutFields([layer.objectIdField, ...tab.columns.map((c) => c.name)]);
    tab.handles = watchTab(tab);
    watchExtraLayers();
    tabs.push(tab);
    pane.setOpen(true);
    if (active >= 0) current().scroll = grid.scroll;
    active = tabs.length - 1;
    renderTabs();
    showTab(tab);
    watchActiveLayer();
    query(tab);
    return tab;
  }

  function closeTab(tab) {
    const i = tabs.indexOf(tab);
    if (i < 0) return;
    tab.source.abort();
    clearTimeout(tab.loaderTimer);
    tableMap.forget(tab);
    for (const handle of tab.handles ?? []) handle?.remove?.();
    tabs.splice(i, 1);
    if (!tabs.length) {
      activeWatch?.remove();
      active = -1;
      grid.setModel(null);
      renderTabs();
      updateFooter(null);
      stateEl.hidden = true;
      pane.setOpen(false);
      return;
    }
    const wasActive = i === active;
    if (i < active) active--;
    else if (wasActive) active = Math.min(i, tabs.length - 1);
    renderTabs();
    if (wasActive) { showTab(current(), { restoreScroll: true }); watchActiveLayer(); redraw(); }
  }
  function closeAll(ask = false) {
    if (ask && tabs.length > 1 && !window.confirm(T.CLOSE_ALL_ASK(tabs.length))) return;
    for (const tab of [...tabs]) closeTab(tab);
  }

  layerList?.setOpenTable?.({ open, eligible });

  const api = {
    open: (layerOrTitle) => { open(layerOrTitle); return api.state; },
    close: (layerOrTitle) => { const layer = findLayer(layerOrTitle); const tab = tabs.find((t) => t.layer === layer); if (tab) closeTab(tab); },
    closeAll: () => closeAll(false),
    get state() {
      return {
        pane: pane.state, height: pane.height, hidden: tableHide.list,
        tabs: tabs.map((t, i) => ({
          key: t.key, title: t.layer.title, count: t.source.status === "ready" ? t.source.total : null, status: t.source.status, path: t.source.info.path,
          sort: t.sort.length ? t.sort : t.defaultSort, source: t.resolved.source, columns: t.columns.map((c) => c.name),
          filters: { search: t.searchText ?? "", extent: t.filters.extent, selectedOnly: t.filters.selectedOnly }, selected: t.sel.ids.size, activeRow: t.sel.active, active: i === active,
        })),
      };
    },
    requests,
    pane,
    grid,
    // select rows of the active tab by object id (as Ctrl-clicks would), the first one active
    select(oids) {
      const tab = current();
      if (!tab) return;
      let next = emptySelection();
      for (const oid of oids) next = toggleRow(next, oid);
      if (oids.length) next = setActive(next, oids[0]);
      if (next.ids.size > TABLE.MAX_SELECT) { tooMany(); return; }
      applySelection(tab, next);
    },
    zoomToSelected: () => { const tab = current(); if (tab) return zoomTo(tab, [...tab.sel.ids]); return null; },
    get layers() { return tableMap.layers; },
    get drawing() { return { ...tableMap.stats, last: lastDraw }; },
    get tabs() { return tabs; },
    get active() { return current(); },
  };
  return api;
}
