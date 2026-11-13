import { TABLE } from "./config.js";
import { h } from "./dom.js";
import { cellDisplay, visibleWindow } from "./tableGridLogic.js";

// The attribute table's grid (attributeTable.js): a role="grid" with a sticky header and virtual rows. Only the rows in
// view plus TABLE.OVERSCAN above and below exist in the DOM; each is placed at its own offset in a spacer as tall as
// all rows, so the scroll bar is right for the whole id list. Rows not loaded yet show light placeholder bars; a page
// that failed shows one "Couldn't load rows. Retry" line. The checkbox column and the first visible column can stay put
// while scrolling sideways (sticky). Cells are text only (textContent); a value that is an http(s) URL is a link.
//
// The grid draws a model it is given (setModel) and asks it for rows; it owns no data:
//   model = { columns: [{ name, alias, kind, idLike, domain, timeZone, width, hint }], freeze, total, idAt(i), row(i),
//             pageStatus(i), ensure(start, end), isSelected(oid), activeOid, sort: [{ field, order }],
//             selectAll: "none" | "some" | "all", rowHeight, stripes, hoverOid }
// handlers = { onRow(event, index, oid, part), onHeader(event, field), onSelectAll(event), onRetry(index), onScroll(),
//              onResizeStart(event, field), onFit(field), onKey(event), onContext(event, index, oid, field), onHover(oid) }
export function createTableGrid(handlers = {}) {
  const T = TABLE.TEXT, C = TABLE.COL;
  const head = h("div", { class: "tgrid-head", role: "row", ariaRowIndex: "1" });
  const rowsEl = h("div", { class: "tgrid-rows", role: "rowgroup" });
  const space = h("div", { class: "tgrid-space" }, rowsEl);
  const el = h("div", { class: "tgrid", role: "grid", ariaReadOnly: "true", ariaMultiSelectable: "true" }, head, space);
  let model = null;
  let template = "";
  let totalWidth = 0;
  let version = 0; // bumps when what rows show changes (data, selection, columns): a row element is refilled then
  const pool = new Map(); // row index -> element
  let frame = 0;
  let focus = { row: 0, col: 0 }; // the focused cell (roving tabindex): row index, column index (0: the checkbox)

  const colsOf = () => model?.columns ?? [];
  function layoutColumns() {
    const cols = colsOf();
    template = [`${C.CHECK_PX}px`, ...cols.map((c) => `${c.width}px`)].join(" ");
    totalWidth = C.CHECK_PX + cols.reduce((s, c) => s + c.width, 0);
    el.style.setProperty("--tgrid-cols", template);
    el.style.setProperty("--tgrid-width", `${totalWidth}px`);
    el.style.setProperty("--tgrid-freeze-left", `${C.CHECK_PX}px`);
    el.classList.toggle("tgrid-freeze", !!model?.freeze);
    el.classList.toggle("stripes", model?.stripes !== false);
    if (model) el.style.setProperty("--tgrid-row-h", `${model.rowHeight}px`);
    el.setAttribute("aria-colcount", String(cols.length + 1));
  }

  function renderHead() {
    const cols = colsOf();
    const all = h("input", { type: "checkbox", class: "tgrid-check", tabIndex: -1, ariaLabel: T.SELECT_ALL, title: T.SELECT_ALL, onclick: (e) => handlers.onSelectAll?.(e) });
    all.checked = model?.selectAll === "all";
    all.indeterminate = model?.selectAll === "some";
    const cells = [h("div", { class: "tgrid-hcell tgrid-checkcell", role: "columnheader", ariaColIndex: "1", tabIndex: -1 }, all)];
    cols.forEach((c, i) => {
      const at = (model.sort ?? []).findIndex((s) => s.field === c.name);
      const sorted = at >= 0 ? model.sort[at] : null;
      const arrow = sorted ? h("span", { class: "tgrid-sort", ariaHidden: "true" }, sorted.order === "desc" ? "▼" : "▲", model.sort.length > 1 ? h("sub", {}, String(at + 1)) : null) : null;
      const cell = h("div", {
        class: `tgrid-hcell${c.kind === "number" && !c.idLike ? " num" : ""}${i === 0 ? " tgrid-first" : ""}`, role: "columnheader", ariaColIndex: String(i + 2), tabIndex: -1,
        ariaSort: sorted ? (sorted.order === "desc" ? "descending" : "ascending") : "none", title: T.HEADER_TIP(c.name, c.hint),
        onclick: (e) => { if (!e.target.closest(".tgrid-resize")) handlers.onHeader?.(e, c.name); },
      }, h("span", { class: "tgrid-htext" }, c.alias), h("span", { class: "tgrid-hint" }, c.hint), arrow,
        h("span", { class: "tgrid-resize", title: T.RESIZE_COLUMN, ariaHidden: "true",
          onpointerdown: (e) => handlers.onResizeStart?.(e, c.name), ondblclick: (e) => { e.stopPropagation(); handlers.onFit?.(c.name); } }));
      cell.dataset.field = c.name;
      cells.push(cell);
    });
    head.replaceChildren(...cells);
  }

  function fillRow(rowEl, i) {
    const cols = colsOf();
    const oid = model.idAt(i);
    const status = model.pageStatus(i);
    const data = model.row(i);
    const selected = oid !== undefined && model.isSelected(oid);
    rowEl.className = `tgrid-row${i % 2 ? " odd" : ""}${selected ? " selected" : ""}${oid !== undefined && oid === model.activeOid ? " active" : ""}${data ? "" : " pending"}`;
    rowEl.setAttribute("aria-rowindex", String(i + 2));
    rowEl.setAttribute("aria-selected", selected ? "true" : "false");
    rowEl.dataset.index = String(i);
    const check = h("input", { type: "checkbox", class: "tgrid-check", tabIndex: -1, ariaLabel: T.SELECT_ROW, checked: selected });
    const cells = [h("div", { class: "tgrid-cell tgrid-checkcell", role: "gridcell", ariaColIndex: "1", tabIndex: -1 }, check)];
    if (status === "error" && (i % TABLE.PAGE_SIZE === 0 || i === pool.firstIndex)) {
      cells.push(h("div", { class: "tgrid-cell tgrid-error", role: "gridcell" }, T.LOAD_FAILED, " ",
        h("button", { type: "button", class: "tgrid-retry", onclick: (e) => { e.stopPropagation(); handlers.onRetry?.(i); } }, T.RETRY)));
      rowEl.replaceChildren(...cells);
      return;
    }
    cols.forEach((c, k) => {
      const cls = `tgrid-cell${c.kind === "number" && !c.idLike && !c.domain ? " num" : ""}${k === 0 ? " tgrid-first" : ""}`;
      if (!data) { cells.push(h("div", { class: `${cls} tgrid-ph`, role: "gridcell", ariaColIndex: String(k + 2), tabIndex: -1 }, h("span", { class: "tgrid-bar" }))); return; }
      const shown = cellDisplay(data[c.name], c);
      let content;
      if (shown.kind === "null") content = h("span", { class: "tgrid-null", ariaLabel: "null" }, "–");
      else if (shown.link) content = h("a", { href: shown.link, target: "_blank", rel: "noopener noreferrer", tabIndex: -1 }, shown.text);
      else content = shown.text;
      const cell = h("div", { class: cls, role: "gridcell", ariaColIndex: String(k + 2), tabIndex: -1 }, content);
      if (shown.text.length > 18) cell.title = shown.text;
      cells.push(cell);
    });
    rowEl.replaceChildren(...cells);
  }

  // Draw the rows in view (keeping row elements whose content is unchanged), and ask the model to load their pages.
  function render() {
    frame = 0;
    if (!model) { rowsEl.replaceChildren(); return; }
    const hadFocus = el.contains(document.activeElement) && document.activeElement !== el;
    const rowH = model.rowHeight;
    const viewH = Math.max(0, el.clientHeight - head.offsetHeight);
    const win = visibleWindow(el.scrollTop, viewH, rowH, model.total, TABLE.OVERSCAN);
    space.style.height = `${win.height}px`;
    model.ensure(win.start, win.end);
    pool.firstIndex = Math.max(win.start, Math.floor(el.scrollTop / rowH));
    for (const [i, rowEl] of pool) {
      if (i < win.start || i >= win.end) { rowEl.remove(); pool.delete(i); }
    }
    for (let i = win.start; i < win.end; i++) {
      let rowEl = pool.get(i);
      const key = `${version}:${model.pageStatus(i)}`;
      if (!rowEl) {
        rowEl = h("div", { role: "row" });
        rowEl.style.transform = `translateY(${i * rowH}px)`;
        pool.set(i, rowEl);
        rowsEl.append(rowEl);
      }
      if (rowEl.dataset.key !== key) { fillRow(rowEl, i); rowEl.dataset.key = key; }
    }
    el.setAttribute("aria-rowcount", String(model.total + 1));
    markFocus();
    // a refilled row loses its focused cell: give the focus back to the same cell
    if (hadFocus && (!el.contains(document.activeElement) || document.activeElement === el)) cellAt(focus.row, focus.col)?.focus({ preventScroll: true });
  }
  const schedule = () => { if (!frame) frame = requestAnimationFrame(render); };
  el.addEventListener("scroll", () => { schedule(); handlers.onScroll?.(); }, { passive: true });
  new ResizeObserver(schedule).observe(el);

  // ---- focus: one cell in the tab order (roving tabindex)
  function cellAt(row, col) {
    const rowEl = row < 0 ? head : pool.get(row);
    return rowEl?.children[col] ?? null;
  }
  function markFocus() {
    for (const c of el.querySelectorAll('[tabindex="0"]')) if (c.classList.contains("tgrid-cell") || c.classList.contains("tgrid-hcell")) c.tabIndex = -1;
    const cell = cellAt(focus.row, focus.col) ?? (model?.total ? null : head.children[0]);
    if (cell) cell.tabIndex = 0;
    el.tabIndex = cell ? -1 : 0;
  }
  // Run a change that rebuilds cells (rows, the header) and give the focus back to the same cell if it was in the grid.
  function keepFocus(fn) {
    const had = el.contains(document.activeElement) && document.activeElement !== el;
    fn();
    if (had && (!el.contains(document.activeElement) || document.activeElement === el)) {
      markFocus();
      cellAt(focus.row, focus.col)?.focus({ preventScroll: true });
    }
  }
  // the grid itself takes focus when its focus cell isn't drawn (scrolled away): send it to that cell
  el.addEventListener("focus", () => { const c = cellAt(focus.row, focus.col); if (c) c.focus({ preventScroll: true }); else if (model?.total) scrollToIndex(focus.row); });

  // Scroll a row into view: "nearest" (only if outside), "center".
  function scrollToIndex(i, align = "nearest") {
    if (!model || i < 0) return;
    const rowH = model.rowHeight, headH = head.offsetHeight, viewH = el.clientHeight - headH;
    const top = i * rowH, bottom = top + rowH;
    if (align === "center") el.scrollTop = Math.max(0, top - (viewH - rowH) / 2);
    else if (top < el.scrollTop) el.scrollTop = top;
    else if (bottom > el.scrollTop + viewH) el.scrollTop = bottom - viewH;
    render();
  }

  // pointer events on rows: the part clicked (checkbox, link, cell)
  rowsEl.addEventListener("click", (e) => {
    const rowEl = e.target.closest(".tgrid-row");
    if (!rowEl || e.target.closest(".tgrid-retry")) return;
    const i = Number(rowEl.dataset.index);
    const oid = model?.idAt(i);
    if (oid === undefined) return;
    const part = e.target.closest(".tgrid-check") ? "check" : e.target.closest("a") ? "link" : "cell";
    const cellEl = e.target.closest(".tgrid-cell");
    if (cellEl) focus = { row: i, col: [...rowEl.children].indexOf(cellEl) };
    markFocus();
    if (part !== "link") cellAt(focus.row, focus.col)?.focus({ preventScroll: true });
    handlers.onRow?.(e, i, oid, part);
  });
  rowsEl.addEventListener("dblclick", (e) => {
    const rowEl = e.target.closest(".tgrid-row");
    if (!rowEl || e.target.closest(".tgrid-check, a, .tgrid-retry")) return;
    const i = Number(rowEl.dataset.index);
    const oid = model?.idAt(i);
    if (oid !== undefined) handlers.onRow?.(e, i, oid, "double");
  });
  rowsEl.addEventListener("mousedown", (e) => { if (e.shiftKey && e.target.closest(".tgrid-row")) e.preventDefault(); }); // no text selection on Shift-click
  rowsEl.addEventListener("contextmenu", (e) => {
    const rowEl = e.target.closest(".tgrid-row");
    if (!rowEl) return;
    const i = Number(rowEl.dataset.index);
    const oid = model?.idAt(i);
    if (oid === undefined) return;
    e.preventDefault();
    const cellEl = e.target.closest(".tgrid-cell");
    const col = cellEl ? [...rowEl.children].indexOf(cellEl) : 0;
    focus = { row: i, col };
    markFocus();
    handlers.onContext?.(e, i, oid, col > 0 ? colsOf()[col - 1]?.name ?? null : null);
  });
  rowsEl.addEventListener("pointerover", (e) => {
    if (e.pointerType === "touch") return;
    const rowEl = e.target.closest(".tgrid-row");
    handlers.onHover?.(rowEl ? model?.idAt(Number(rowEl.dataset.index)) ?? null : null);
  });
  rowsEl.addEventListener("pointerleave", () => handlers.onHover?.(null));
  el.addEventListener("keydown", (e) => handlers.onKey?.(e));

  return {
    el,
    setModel(next, { keepScroll = false, scrollTop = 0, scrollLeft = 0 } = {}) {
      keepFocus(() => {
        model = next;
        version++;
        for (const rowEl of pool.values()) rowEl.remove();
        pool.clear();
        layoutColumns();
        renderHead();
        focus = { row: Math.max(-1, Math.min(focus.row, (next?.total ?? 1) - 1)), col: Math.min(focus.col, next?.columns.length ?? 0) };
        if (!keepScroll) { el.scrollTop = scrollTop; el.scrollLeft = scrollLeft; }
        render();
      });
    },
    // the data or the selection changed: refill the rows in view (and the header's select-all box)
    refresh({ head: withHead = false } = {}) {
      version++;
      if (withHead) keepFocus(() => { layoutColumns(); renderHead(); markFocus(); });
      else {
        const all = head.querySelector(".tgrid-check");
        if (all && model) { all.checked = model.selectAll === "all"; all.indeterminate = model.selectAll === "some"; }
      }
      schedule();
    },
    // the column widths changed (resize): no refill needed
    relayout() { layoutColumns(); },
    render,
    scrollToIndex,
    get focus() { return focus; },
    setFocus(row, col, { move = true } = {}) {
      focus = { row, col };
      if (row >= 0) scrollToIndex(row);
      markFocus();
      if (move) cellAt(row, col)?.focus({ preventScroll: false });
    },
    // the focused cell's element (for placing a menu)
    cellEl: (row, col) => cellAt(row, col),
    get viewRows() { return model ? Math.max(1, Math.floor((el.clientHeight - head.offsetHeight) / model.rowHeight)) : 1; },
    get scroll() { return { top: el.scrollTop, left: el.scrollLeft }; },
    get model() { return model; },
    get rowsInDom() { return pool.size; },
    headCell: (field) => head.querySelector(`[data-field="${CSS.escape(field)}"]`),
    head,
  };
}
