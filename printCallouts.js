import { textStyle as normalizeTextStyle, calloutTextStyle } from "./printTextStyle.js";
import { printTextControls } from "./printTextControls.js";
import { leaderStyle } from "./printLeader.js";
import { printColorControl } from "./printColorControl.js";
import { resizeCallout } from "./printCalloutResize.js";
import { h } from "./dom.js";
import { PRINT } from "./config.js";
import { calloutBox, placeCallout, screenToPage, pageToScreen, insideMap } from "./printCalloutMath.js";

// DOM interactions only. Map points and page geometry stay separate from drawing/export.
export function createPrintCallouts({ host, controls, page, frame, view, Point, state, context, textStyle, rememberTextStyle, changed }) {
  let lastLeader = leaderStyle(state.lastLeader), lastTextStyle = normalizeTextStyle(state.lastTextStyle ?? textStyle, "callout");
  let selected = null, placing = false, editing = null, draft = null, original = null, drag = null, signature = "";
  const abort = new AbortController(), listeners = { signal: abort.signal };
  const overlay = h("div", { class: "print-callout-overlay" });
  overlay.style.setProperty("--print-callout-handle-size", `${PRINT.CALLOUT.HANDLE_PX}px`); host.append(overlay);
  const add = h("calcite-button", { id: "print-add-callout", scale: "s", appearance: "outline", iconStart: "speech-bubble", onclick: () => {
    commit(); cancel(); placing = true; host.classList.add("print-placing-callout"); add.textContent = "Click the map preview"; host.focus();
  } }, "Add callout");
  const list = h("div", { id: "print-callout-list" }), tools = h("div", { class: "print-callout-tools", hidden: true });
  const textControls = printTextControls("print-callout", "callout", lastTextStyle, (style) => {
    const entry = item(); if (!entry) return;
    entry.textStyle = { ...style }; entry.size = style.size;
    lastTextStyle = { ...style }; state.lastTextStyle = { ...style }; rememberTextStyle?.({ ...style });
    changed(); refresh();
  });
  const arrow = h("calcite-checkbox", { id: "print-callout-arrow", oncalciteCheckboxChange: () => update({ arrowhead: arrow.checked }) });
  const style = h("calcite-select", { id: "print-callout-style", scale: "s", label: "Callout style", oncalciteSelectChange: () => update({ style: style.value }) },
    h("calcite-option", { value: "box", label: "White box with border" }), h("calcite-option", { value: "halo", label: "Text halo" }));
  tools.append(textControls.node, h("calcite-label", { layout: "inline" }, arrow, "Arrowhead"), style);
  const leaderColor = printColorControl("print-leader-color", "Line color", lastLeader.color, (color) => updateLeader({ color }));
  const leaderWidth = h("calcite-input-number", { id: "print-leader-width", scale: "s", min: PRINT.LEADER.MIN_WIDTH_PT, max: PRINT.LEADER.MAX_WIDTH_PT, step: 1,
    oncalciteInputNumberChange: () => updateLeader({ width: Number(leaderWidth.value) }) });
  const leaderOutline = h("calcite-checkbox", { id: "print-leader-outline", oncalciteCheckboxChange: () => updateLeader({ outline: leaderOutline.checked }) });
  const leaderOutlineColor = printColorControl("print-leader-outline-color", "Outline color", null, (outlineColor) => updateLeader({ outlineColor }), true);
  tools.append(h("h4", { class: "print-controls-heading" }, "Leader line"), h("calcite-label", {}, "Color", leaderColor.node),
    h("calcite-label", {}, "Width (pt)", leaderWidth), h("calcite-label", { layout: "inline" }, leaderOutline, "Outline"), leaderOutlineColor.node,
    h("calcite-button", { id: "print-leader-apply-all", scale: "s", appearance: "outline", onclick: () => {
      const current = item(); if (!current) return; lastLeader = leaderStyle(current.leader); state.lastLeader = { ...lastLeader };
      for (const entry of state.items) entry.leader = { ...lastLeader }; changed(); refresh();
    } }, "Apply to all callouts"));
  controls.append(add, list, tools);
  const item = () => state.items.find((entry) => entry.id === selected) ?? draft;
  const pagePoint = (event) => {
    const rect = host.getBoundingClientRect();
    return { x: (event.clientX - rect.left) * page.width / rect.width, y: (event.clientY - rect.top) * page.height / rect.height };
  };
  function updateLeader(values) {
    const entry = item(); if (!entry) return;
    entry.leader = leaderStyle({ ...leaderStyle(entry.leader), ...values }); lastLeader = { ...entry.leader }; state.lastLeader = { ...lastLeader };
    syncLeader(entry); changed(); refresh();
  }
  function syncLeader(entry) {
    const style = leaderStyle(entry.leader);
    leaderColor.set(style.color); leaderWidth.value = String(style.width); leaderOutline.checked = style.outline;
    leaderOutlineColor.set(style.outlineColor); leaderOutlineColor.node.hidden = !style.outline;
  }
  function update(values) { const entry = item(); if (entry) { Object.assign(entry, values); changed(); refresh(); } }
  function syncTips() {
    context.calloutTips = {};
    for (const entry of [...state.items, ...(draft ? [draft] : [])]) {
      const screen = view.toScreen(Point.fromJSON(entry.tip));
      if (screen) context.calloutTips[entry.id] = screenToPage(screen, frame, page.map);
    }
  }
  function select(id) {
    selected = id; const entry = item(); tools.hidden = !entry;
    if (entry) { syncLeader(entry); textControls.set(calloutTextStyle(entry)); arrow.checked = entry.arrowhead; style.value = entry.style; }
    refresh();
  }
  function refresh() {
    syncTips();
    const next = JSON.stringify([state.items, context.calloutTips, selected]);
    if (signature === next) { if (editing) positionInput(); return; }
    signature = next;
    const focusedGrip = document.activeElement?.classList.contains("print-callout-handle") ? document.activeElement.dataset.handle : null;
    const focusedHit = document.activeElement?.closest(".print-callout-hit")?.dataset.id;
    overlay.querySelectorAll(".print-callout-hit").forEach((node) => node.remove());
    for (const entry of state.items) {
      const tip = context.calloutTips[entry.id]; if (!insideMap(tip, page.map)) continue;
      const box = calloutBox(entry, page.map), hit = h("div", { class: "print-callout-hit", tabIndex: 0, role: "button", ariaLabel: `Callout: ${entry.text}`, title: "Drag to move; edit in the callout list" });
      hit.dataset.id = entry.id; hit.classList.toggle("selected", selected === entry.id);
      hit.style.cssText = `left:${box.x / page.width * 100}%;top:${box.y / page.height * 100}%;width:${box.width / page.width * 100}%;height:${box.height / page.height * 100}%`;
      hit.addEventListener("pointerdown", (event) => {
        if (event.button !== 0 || editing || event.target.closest(".print-callout-handle")) return;
        event.stopPropagation(); selected = entry.id;
        const point = pagePoint(event); drag = { id: entry.id, pointerId: event.pointerId, point, x: box.x, y: box.y };
        event.preventDefault();
        host.setPointerCapture(event.pointerId); host.focus(); tools.hidden = false;
        syncLeader(entry); textControls.set(calloutTextStyle(entry)); arrow.checked = entry.arrowhead; style.value = entry.style; refresh();
      }, listeners);
      hit.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); edit(entry.id); } }, listeners);
      if (entry.id === selected && !editing) for (const handle of ["nw", "n", "ne", "e", "se", "s", "sw", "w"]) {
        const grip = h("div", { class: "print-callout-handle", tabIndex: 0, role: "button", ariaLabel: `Resize callout ${handle}` });
        grip.dataset.handle = handle;
        grip.addEventListener("pointerdown", (event) => {
          if (event.button !== 0) return;
          event.preventDefault(); event.stopPropagation();
          drag = { id: entry.id, pointerId: event.pointerId, point: pagePoint(event), handle, original: structuredClone(entry) };
          host.setPointerCapture(event.pointerId); host.style.cursor = `${handle}-resize`;
        }, listeners);
        grip.addEventListener("keydown", (event) => {
          const axis = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
          if (!axis) return;
          event.preventDefault(); const step = PRINT.CALLOUT.RESIZE_STEP_PT * (event.shiftKey ? 10 : 1);
          Object.assign(entry, resizeCallout(entry, page.map, handle, { x: axis[0] * step, y: axis[1] * step })); changed(); refresh();
        }, listeners);
        hit.append(grip);
      }
      overlay.append(hit);
      if (entry.id === focusedHit) (focusedGrip ? hit.querySelector(`[data-handle="${focusedGrip}"]`) : hit)?.focus();
    }
    list.replaceChildren();
    for (const entry of state.items) {
      const outside = !insideMap(context.calloutTips[entry.id], page.map);
      const editButton = h("calcite-button", { scale: "s", appearance: "transparent", alignment: "start", onclick: () => edit(entry.id), title: "Edit callout" }, entry.text.slice(0, 45) + (outside ? " (outside frame)" : ""));
      list.append(h("div", { class: "print-callout-row" }, editButton,
        h("calcite-action", { icon: "trash", text: "Delete callout", scale: "s", onclick: () => remove(entry.id) })));
    }
    if (editing) positionInput();
  }
  function positionInput() {
    const entry = item(), box = calloutBox(entry, page.map), factor = host.clientWidth / page.width;
    const textStyle = calloutTextStyle(entry);
    editing.style.cssText = `left:${box.x / page.width * 100}%;top:${box.y / page.height * 100}%;width:${box.width / page.width * 100}%;height:${Math.max(box.height * factor, 48)}px;font-family:Helvetica,Arial,sans-serif;font-size:${textStyle.size * factor}px;font-weight:${textStyle.bold ? "bold" : "normal"};font-style:${textStyle.italic ? "italic" : "normal"};text-decoration:${textStyle.underline ? "underline" : "none"};color:${textStyle.color};text-align:${textStyle.align};line-height:${PRINT.TEXT.LEADING};padding:${PRINT.CALLOUT.PADDING_PT * factor}px`;
  }
  function beginText(entry, isNew) {
    selected = entry.id; original = isNew ? null : structuredClone(entry); draft = isNew ? entry : null;
    editing = h("textarea", { class: "print-callout-input", id: "print-callout-text", ariaLabel: "Callout text", placeholder: "Type a note…", value: entry.text, rows: 2 });
    editing.addEventListener("input", () => { entry.text = editing.value; changed(); positionInput(); }, listeners);
    editing.addEventListener("keydown", (event) => { if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); commit(); } }, listeners);
    overlay.append(editing); select(entry.id); positionInput(); editing.focus(); editing.select();
  }
  function commit() {
    const entry = item(); if (!entry || !editing) return;
    entry.text = editing.value.trim();
    if (draft && entry.text) {
      entry.position = placeCallout(context.calloutTips[entry.id], calloutBox(entry, page.map), page.map,
        state.items.map((value) => calloutBox(value, page.map)));
      state.items.push(entry);
    }
    else if (!entry.text && !draft) state.items = state.items.filter((value) => value.id !== entry.id);
    editing.remove(); editing = draft = original = null; placing = false;
    host.classList.remove("print-placing-callout"); add.textContent = "Add callout";
    changed(); select(entry.text ? entry.id : null); host.focus();
  }
  function edit(id) {
    commit(); placing = false; const entry = state.items.find((value) => value.id === id);
    if (entry) beginText(entry, false);
  }
  function remove(id) {
    if (selected === id) cancel();
    state.items = state.items.filter((entry) => entry.id !== id); selected = null; tools.hidden = true;
    changed(); refresh(); add.setFocus();
  }
  function cancel() {
    const active = placing || !!editing || selected !== null;
    endDrag();
    if (editing) {
      if (original) Object.assign(item(), original);
      editing.remove(); editing = draft = original = null; selected = null; tools.hidden = true; changed();
    }
    selected = null; tools.hidden = true; placing = false; host.classList.remove("print-placing-callout"); add.textContent = "Add callout"; refresh();
    if (active) add.setFocus(); return active;
  }
  host.addEventListener("click", (event) => {
    if (!placing || editing || event.target.closest(".print-callout-hit, textarea")) {
      if (!placing && !editing && !event.target.closest(".print-callout-hit, textarea")) select(null);
      return;
    }
    const tip = pagePoint(event); if (!insideMap(tip, page.map)) return;
    const mapPoint = view.toMap(pageToScreen(tip, frame, page.map)); if (!mapPoint) return;
    const entry = { id: crypto.randomUUID(), tip: mapPoint.toJSON(), text: "", size: lastTextStyle.size, textStyle: { ...lastTextStyle },
      leader: { ...lastLeader }, arrowhead: PRINT.CALLOUT.ARROWHEAD, style: PRINT.CALLOUT.BORDER ? "box" : "halo" };
    const box = calloutBox(entry, page.map);
    entry.position = placeCallout(tip, box, page.map, state.items.map((value) => calloutBox(value, page.map)));
    placing = false; host.classList.remove("print-placing-callout"); add.textContent = "Add callout";
    beginText(entry, true);
  }, listeners);
  host.addEventListener("pointermove", (event) => {
    if (!drag) return; const entry = state.items.find((value) => value.id === drag.id), point = pagePoint(event);
    if (drag.handle) { Object.assign(entry, resizeCallout(drag.original, page.map, drag.handle, { x: point.x - drag.point.x, y: point.y - drag.point.y })); changed(); refresh(); return; }
    entry.position = { x: (drag.x + point.x - drag.point.x - page.map.x) / page.map.width, y: (drag.y + point.y - drag.point.y - page.map.y) / page.map.height };
    const box = calloutBox(entry, page.map);
    entry.position = { x: (box.x - page.map.x) / page.map.width, y: (box.y - page.map.y) / page.map.height };
    changed(); refresh();
  }, listeners);
  function endDrag() {
    if (!drag) return;
    if (drag && host.hasPointerCapture(drag.pointerId)) host.releasePointerCapture(drag.pointerId);
    drag = null; host.style.cursor = "";
  }
  host.addEventListener("pointerup", endDrag, listeners);
  host.addEventListener("pointercancel", endDrag, listeners);
  host.addEventListener("lostpointercapture", () => { if (drag) { drag = null; host.style.cursor = ""; } }, listeners);
  refresh();
  return { syncTips, refresh, commit, cancel,
    deleteSelected(event) {
      if (!selected || editing || event.composedPath().some((node) => /^(INPUT|TEXTAREA|CALCITE-INPUT|CALCITE-TEXT-AREA|CALCITE-INPUT-NUMBER)$/.test(node.tagName))) return false;
      remove(selected); return true;
    },
    dispose() { endDrag(); abort.abort(); editing?.remove(); overlay.remove(); drag = null; },
  };
}
