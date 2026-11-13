import { TABLE } from "./config.js";
import { h } from "./dom.js";
import { clampPaneHeight, createHideReasons, defaultPaneHeight, maxPaneHeight } from "./tableGridLogic.js";

// The attribute table's pane (section 50): docked under the map in #map-column, so the map gets shorter and is never
// covered, and the pane is exactly as wide as the map area (it can't reach the left or right panel).
//
//   #map-column
//     #map-host        the map and everything that floats over it (unchanged)
//     #table-splitter  role="separator": drag, arrow keys (Shift: bigger steps), Home / End, double-click
//     #table-pane      header (tabs, pane buttons), then whatever attributeTable.js puts in the body
//
// States: "closed" (no tabs: no pane, no splitter; the state after a reload), "collapsed" (the header only),
// "normal" (the saved height, TABLE.PANE.STORAGE_KEY), "maximized" (the map keeps MIN_MAP_PX). Heights are clamped
// (clampPaneHeight) on every change, window resize and map column resize.

// ---- why the pane is hidden: another tool owns the screen (the georeferencing workspace, the plan mosaic, Print).
// Usable before the pane exists (it is set up after those tools). add() resolves once the map has finished growing, so
// Print computes its frame on the final map size; release() brings the pane back as it was.
const reasons = createHideReasons(() => onHiddenChange());
let onHiddenChange = () => {};
let settle = async () => {};
export const tableHide = {
  async add(reason) {
    if (reasons.add(reason)) await settle();
  },
  release(reason) { reasons.release(reason); },
  get hidden() { return reasons.hidden; },
  get list() { return reasons.list; },
};

// Waits until the map view has its container's size again (after the pane hid or came back), then one more frame.
async function waitForMapSize(mapEl, timeoutMs = 1500) {
  const view = mapEl.view;
  if (!view) return;
  const until = performance.now() + timeoutMs;
  const frame = () => new Promise(requestAnimationFrame);
  await frame();
  while (performance.now() < until) {
    if (Math.abs(view.width - mapEl.clientWidth) <= 1 && Math.abs(view.height - mapEl.clientHeight) <= 1) break;
    await frame();
  }
  await frame();
}

// opts: { mapEl, onClose(): close every tab (the Close all button), onStateChange(state) }
// Returns { header, body, tabsEl, setOpen(on), state, height, toggleCollapsed(), toggleMaximized(), hidden, el }.
export function createTablePane({ mapEl, onCloseAll, onStateChange = () => {} }) {
  const T = TABLE.TEXT, P = TABLE.PANE;
  const column = document.getElementById("map-column");
  const pane = document.getElementById("table-pane");
  const splitter = document.getElementById("table-splitter");
  let state = "closed";
  let height = loadHeight(); // the normal height, px (null: the default share of the column)
  let before = "normal"; // the state Maximize returns to

  function loadHeight() {
    try {
      const v = Number(localStorage.getItem(P.STORAGE_KEY));
      return Number.isFinite(v) && v > 0 ? v : null;
    } catch { return null; }
  }
  function saveHeight() {
    try { localStorage.setItem(P.STORAGE_KEY, String(Math.round(height))); } catch { /* not saved: still applies now */ }
  }

  const tabsEl = h("div", { class: "table-tabs", role: "tablist", ariaLabel: T.TABS_LABEL });
  const action = (icon, text, onclick) => h("calcite-action", { icon, text, label: text, title: text, scale: "s", onclick });
  const collapseBtn = action("chevron-down", T.COLLAPSE, () => toggleCollapsed());
  const maxBtn = action("chevron-up", T.MAXIMIZE, () => toggleMaximized());
  const closeBtn = action("x", T.CLOSE_ALL, () => onCloseAll?.());
  const header = h("div", { class: "table-pane-head" }, tabsEl, h("div", { class: "table-pane-buttons" }, collapseBtn, maxBtn, closeBtn));
  const body = h("div", { class: "table-pane-body" });
  pane.setAttribute("role", "region");
  pane.setAttribute("aria-label", T.PANE_LABEL);
  pane.replaceChildren(header, body);
  splitter.setAttribute("aria-label", T.SPLITTER);
  splitter.setAttribute("aria-controls", "table-pane");

  // the room the pane and the map share: the column less the splitter (counted even while collapsed hides it)
  const splitPx = () => splitter.offsetHeight || 7;
  const columnPx = () => column.clientHeight - (splitter.hidden ? 0 : splitPx());
  const normalPx = () => clampPaneHeight(height ?? defaultPaneHeight(columnPx()), { columnPx: columnPx() });
  const shown = () => state !== "closed" && !reasons.hidden;

  // Apply the state: the pane's height, what is shown, the buttons and the separator's values.
  function layout() {
    const visible = shown();
    pane.hidden = !visible;
    splitter.hidden = !visible || state === "collapsed";
    column.classList.toggle("table-open", visible);
    if (!visible) return;
    const px = state === "collapsed" ? P.COLLAPSED_PX : state === "maximized" ? maxPaneHeight(columnPx()) : normalPx();
    pane.style.height = `${px}px`;
    pane.classList.toggle("collapsed", state === "collapsed");
    collapseBtn.icon = state === "collapsed" ? "chevron-up" : "chevron-down";
    collapseBtn.text = collapseBtn.label = collapseBtn.title = state === "collapsed" ? T.RESTORE : T.COLLAPSE;
    maxBtn.icon = state === "maximized" ? "chevrons-down" : "chevrons-up";
    maxBtn.text = maxBtn.label = maxBtn.title = state === "maximized" ? T.UNMAXIMIZE : T.MAXIMIZE;
    splitter.setAttribute("aria-valuenow", String(Math.round(px)));
    splitter.setAttribute("aria-valuemin", String(Math.min(P.MIN_PX, maxPaneHeight(columnPx()))));
    splitter.setAttribute("aria-valuemax", String(maxPaneHeight(columnPx())));
  }
  function setState(next) {
    if (next === state) return;
    state = next;
    layout();
    onStateChange(state);
  }

  // Open (the first tab) at the saved height, or close (the last tab went).
  function setOpen(on) {
    if (on && state === "closed") setState("normal");
    if (!on) setState("closed");
  }
  function toggleCollapsed() {
    if (state === "closed") return;
    setState(state === "collapsed" ? "normal" : "collapsed");
  }
  function toggleMaximized() {
    if (state === "closed") return;
    if (state === "maximized") setState(before === "maximized" ? "normal" : before);
    else { before = state; setState("maximized"); }
  }

  // A new normal height (drag, keys): clamped, applied, saved.
  function setHeight(px, save = true) {
    height = clampPaneHeight(px, { columnPx: columnPx() });
    if (state !== "normal") { state = "normal"; onStateChange(state); }
    layout();
    if (save) saveHeight();
  }

  // ---- the splitter: one layout change per animation frame while dragging
  let drag = null, frame = 0, pendingY = 0;
  splitter.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    splitter.setPointerCapture(e.pointerId);
    drag = { y: e.clientY, start: pane.getBoundingClientRect().height };
    splitter.classList.add("dragging");
  });
  splitter.addEventListener("pointermove", (e) => {
    if (!drag) return;
    pendingY = e.clientY;
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (drag) setHeight(drag.start + (drag.y - pendingY), false);
    });
  });
  const endDrag = () => {
    if (!drag) return;
    cancelAnimationFrame(frame);
    frame = 0;
    if (pendingY) setHeight(drag.start + (drag.y - pendingY), true);
    drag = null;
    pendingY = 0;
    splitter.classList.remove("dragging");
  };
  splitter.addEventListener("pointerup", endDrag);
  splitter.addEventListener("pointercancel", endDrag);
  splitter.addEventListener("lostpointercapture", endDrag);
  splitter.addEventListener("dblclick", () => toggleCollapsed());
  splitter.addEventListener("keydown", (e) => {
    const step = e.shiftKey ? P.KEY_STEP_BIG_PX : P.KEY_STEP_PX;
    const now = pane.getBoundingClientRect().height;
    if (e.key === "ArrowUp") setHeight(now + step);
    else if (e.key === "ArrowDown") setHeight(now - step);
    else if (e.key === "Home") setHeight(P.MIN_PX);
    else if (e.key === "End") setHeight(maxPaneHeight(columnPx()));
    else if (e.key === "Enter") toggleCollapsed();
    else return;
    e.preventDefault();
  });

  // re-clamp when the window or the map column changes size
  new ResizeObserver(() => { if (shown()) layout(); }).observe(column);

  onHiddenChange = () => {
    layout();
    onStateChange(state);
  };
  settle = () => waitForMapSize(mapEl);
  layout();

  return {
    el: pane, header, body, tabsEl, splitter,
    setOpen, toggleCollapsed, toggleMaximized, setHeight,
    restoreFromMaximized() { if (state === "maximized") toggleMaximized(); },
    get state() { return state; },
    get height() { return Math.round(pane.getBoundingClientRect().height); },
    get hidden() { return reasons.hidden; },
    get shown() { return shown(); },
    settle: () => waitForMapSize(mapEl),
  };
}
