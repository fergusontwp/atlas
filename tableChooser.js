import { TABLE } from "./config.js";
import { h } from "./dom.js";

// The attribute table's column chooser (attributeTable.js): a small panel over the map area, just above the table pane
// (a child of #map-column, so it never covers the left or right panel). A checkbox per field (alias, the field name in
// grey), a filter box for long lists, up / down buttons and drag to reorder, Show all, Reset to default, Freeze first
// column, and a line saying where the setup comes from.
//
// opts: { anchor (the Columns button), onChange(columns) (the new order and visibility: [{ field, visible, width }]),
//         onReset(), onFreeze(on), getFreeze() }
// open(tab) shows it for a tab: tab.resolved.columns, tab.meta (field -> { alias }), tab.resolved.source, tab.notice.
export function createColumnChooser({ anchor, onChange, onReset, onFreeze, getFreeze = () => true }) {
  const T = TABLE.TEXT;
  const column = document.getElementById("map-column");
  const sourceEl = h("div", { class: "tcols-source" });
  const noticeEl = h("div", { class: "tcols-notice", hidden: true, role: "status" });
  const filter = h("calcite-input-text", { scale: "s", icon: "filter", clearable: true, placeholder: T.CHOOSER_FILTER, label: T.CHOOSER_FILTER,
    oncalciteInputTextInput: () => render() });
  const list = h("ul", { class: "tcols-list", role: "list" });
  const freeze = h("input", { type: "checkbox", id: "tcols-freeze", onchange: () => onFreeze?.(freeze.checked) });
  const foot = h("div", { class: "tcols-foot" },
    h("calcite-button", { scale: "s", appearance: "outline", onclick: () => { cols = cols.map((c) => ({ ...c, visible: true })); commit(); } }, T.SHOW_ALL),
    h("calcite-button", { scale: "s", appearance: "outline", onclick: () => onReset?.() }, T.RESET),
    h("label", { class: "tcols-freeze" }, freeze, T.FREEZE));
  const close = h("calcite-action", { icon: "x", scale: "s", text: T.CHOOSER_TITLE, label: T.CHOOSER_TITLE, onclick: () => hide(true) });
  const el = h("div", { class: "tcols", hidden: true, role: "dialog", ariaLabel: T.CHOOSER_TITLE },
    h("div", { class: "tcols-head" }, h("strong", {}, T.CHOOSER_TITLE), close), sourceEl, noticeEl, filter, list, foot);
  column.append(el);

  let tab = null;
  let cols = [];
  let dragging = null;

  function commit() {
    onChange?.(cols.map((c) => ({ ...c })));
    render();
  }
  function move(field, delta) {
    const i = cols.findIndex((c) => c.field === field), j = i + delta;
    if (i < 0 || j < 0 || j >= cols.length) return;
    [cols[i], cols[j]] = [cols[j], cols[i]];
    commit();
    list.querySelector(`[data-field="${CSS.escape(field)}"] .tcols-${delta < 0 ? "up" : "down"}`)?.setFocus?.();
  }
  function render() {
    if (!tab) return;
    const q = String(filter.value ?? "").trim().toLowerCase();
    sourceEl.textContent = T.SOURCE[tab.resolved.source] ?? "";
    noticeEl.hidden = !tab.notice;
    noticeEl.textContent = tab.notice ?? "";
    freeze.checked = getFreeze();
    list.replaceChildren(...cols.map((c, i) => {
      const meta = tab.meta.get(c.field);
      const alias = meta?.alias ?? c.field;
      if (q && !alias.toLowerCase().includes(q) && !c.field.toLowerCase().includes(q)) return null;
      const box = h("input", { type: "checkbox", checked: !!c.visible, ariaLabel: alias, onchange: () => { cols[i] = { ...cols[i], visible: box.checked }; commit(); } });
      const li = h("li", { class: "tcols-item", draggable: !q },
        h("span", { class: "tcols-grip", ariaHidden: "true" }, "⋮⋮"),
        h("label", { class: "tcols-label" }, box, h("span", { class: "tcols-alias" }, alias), alias !== c.field ? h("span", { class: "tcols-name" }, c.field) : null),
        h("calcite-action", { class: "tcols-up", icon: "chevron-up", scale: "s", text: T.MOVE_UP, label: `${T.MOVE_UP}: ${alias}`, disabled: i === 0, onclick: () => move(c.field, -1) }),
        h("calcite-action", { class: "tcols-down", icon: "chevron-down", scale: "s", text: T.MOVE_DOWN, label: `${T.MOVE_DOWN}: ${alias}`, disabled: i === cols.length - 1, onclick: () => move(c.field, 1) }));
      li.dataset.field = c.field;
      li.addEventListener("dragstart", (e) => { dragging = c.field; e.dataTransfer.effectAllowed = "move"; li.classList.add("dragging"); });
      li.addEventListener("dragend", () => { dragging = null; li.classList.remove("dragging"); });
      li.addEventListener("dragover", (e) => { if (dragging && dragging !== c.field) { e.preventDefault(); li.classList.add("over"); } });
      li.addEventListener("dragleave", () => li.classList.remove("over"));
      li.addEventListener("drop", (e) => {
        e.preventDefault();
        li.classList.remove("over");
        const from = cols.findIndex((x) => x.field === dragging), to = cols.findIndex((x) => x.field === c.field);
        if (from < 0 || to < 0 || from === to) return;
        const [moved] = cols.splice(from, 1);
        cols.splice(to, 0, moved);
        commit();
      });
      return li;
    }).filter(Boolean));
  }

  // place it above the pane, right-aligned with the Columns button
  function place() {
    const colRect = column.getBoundingClientRect();
    const btn = anchor.getBoundingClientRect();
    const pane = document.getElementById("table-pane").getBoundingClientRect();
    el.style.right = `${Math.max(8, colRect.right - btn.right)}px`;
    el.style.bottom = `${Math.max(8, colRect.bottom - pane.top + 4)}px`;
    el.style.maxHeight = `${Math.max(160, pane.top - colRect.top - 16)}px`;
  }
  function onOutside(e) {
    if (el.hidden) return;
    const path = e.composedPath();
    if (!path.includes(el) && !path.includes(anchor)) hide();
  }
  function onKey(e) {
    if (e.key !== "Escape" || el.hidden) return;
    e.stopPropagation();
    e.preventDefault();
    hide(true);
  }
  function show(next) {
    tab = next;
    cols = tab.resolved.columns.map((c) => ({ ...c }));
    filter.value = "";
    el.hidden = false;
    place();
    render();
    document.addEventListener("pointerdown", onOutside, true);
    window.addEventListener("keydown", onKey, true);
    anchor.active = true;
    requestAnimationFrame(() => filter.setFocus?.());
  }
  function hide(focusBack = false) {
    if (el.hidden) return;
    el.hidden = true;
    tab = null;
    document.removeEventListener("pointerdown", onOutside, true);
    window.removeEventListener("keydown", onKey, true);
    anchor.active = false;
    if (focusBack) anchor.setFocus?.();
  }
  new ResizeObserver(() => { if (!el.hidden) place(); }).observe(column);

  return {
    el,
    toggle(next) { if (!el.hidden && tab === next) hide(true); else show(next); },
    // the tab's columns changed elsewhere (reset, a resize): show them again if open for it
    refresh(next) { if (!el.hidden && tab === next) { cols = next.resolved.columns.map((c) => ({ ...c })); render(); } },
    hide,
    get open() { return !el.hidden; },
  };
}
