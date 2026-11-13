// Pointer/UI adapter only; no SDK APIs or graphics layers. Sketches live for one editor.
import { PRINT } from "./config.js";
import { h } from "./dom.js";
import { printColorControl } from "./printColorControl.js";
import { createCanvasDrawing } from "./printDraw.js";
import { drawSketch } from "./printElements/sketch.js";
import calloutElement from "./printElements/callouts.js";
import { createSketchHistory } from "./printSketchHistory.js";
import { clipSketch, reduceSketch, pageToSketch, hitSketch } from "./printSketchMath.js";

export function createPrintSketch({ host, page, state, callouts, context, changed, activate }) {
  const history = createSketchHistory(), abort = new AbortController(), listeners = { signal: abort.signal };
  const node = h("div", { class: "print-sketch-tools" }), buttons = new Map();
  const canvas = h("canvas", { class: "print-sketch-live", ariaHidden: "true", hidden: true }); host.append(canvas);
  let tool = null, active = null, scheduled = 0, enabled = false, busy = false, suppressClick = false;
  let weight = PRINT.SKETCH.WEIGHT_PT;
  const colors = { pen: PRINT.SKETCH.COLOR, highlighter: PRINT.SKETCH.HIGHLIGHTER_COLOR };
  for (const [id, label, icon] of [["pen", "Pen", "pencil"], ["highlighter", "Highlighter", "highlighter"], ["eraser", "Eraser", "erase"]]) {
    const button = h("calcite-button", { id: `print-sketch-${id}`, scale: "s", appearance: "outline", iconStart: icon, title: id === "eraser" ? "Click a stroke to erase it" : `Draw with ${label.toLowerCase()}; Escape turns it off`, onclick: () => setTool(tool === id ? null : id) }, label);
    buttons.set(id, button); node.append(button);
  }
  const color = printColorControl("print-sketch-color", "Sketch color", colors.pen, (value) => { colors[tool === "highlighter" ? "highlighter" : "pen"] = value; }, false, PRINT.SKETCH.COLORS);
  const number = h("calcite-input-number", { id: "print-sketch-weight", scale: "s", min: PRINT.SKETCH.MIN_WEIGHT_PT, max: PRINT.SKETCH.MAX_WEIGHT_PT, step: 1, value: String(weight),
    oncalciteInputNumberChange: () => { weight = Math.max(PRINT.SKETCH.MIN_WEIGHT_PT, Math.min(PRINT.SKETCH.MAX_WEIGHT_PT, Number(number.value) || PRINT.SKETCH.WEIGHT_PT)); number.value = String(weight); } });
  const settings = h("div", { class: "print-sketch-settings" }, h("calcite-label", {}, "Color", color.node), h("calcite-label", {}, "Weight (pt)", number));
  node.append(settings);
  const undo = h("calcite-button", { id: "print-sketch-undo", scale: "s", appearance: "outline", iconStart: "undo", onclick: () => { cancelStroke(); history.undo(); publish(); } }, "Undo");
  const redo = h("calcite-button", { id: "print-sketch-redo", scale: "s", appearance: "outline", iconStart: "redo", onclick: () => { cancelStroke(); history.redo(); publish(); } }, "Redo");
  const clear = h("calcite-button", { id: "print-sketch-clear", scale: "s", appearance: "outline", iconStart: "trash", onclick: () => { cancelStroke(); history.clear(); publish(); } }, "Clear all");
  node.append(h("div", { class: "print-sketch-history" }, undo, redo, clear));
  const point = (event, rect) => ({ x: (event.clientX - rect.left) * page.width / rect.width, y: (event.clientY - rect.top) * page.height / rect.height });
  const inside = (p) => p.x >= page.map.x && p.x <= page.map.x + page.map.width && p.y >= page.map.y && p.y <= page.map.y + page.map.height;
  function setTool(value) {
    cancelStroke(); tool = enabled && !busy ? value : null;
    if (tool) activate();
    host.dataset.sketchTool = tool ?? ""; host.classList.toggle("print-sketch-active", !!tool);
    host.style.cursor = PRINT.SKETCH.CURSORS[tool] ?? "";
    host.setAttribute("aria-label", tool ? `Sketch ${tool}; ${tool === "eraser" ? "click a stroke" : "drag on the map"}; Escape turns it off` : "Map preview; click to place a callout");
    settings.hidden = tool === "eraser";
    if (tool !== "eraser") color.set(colors[tool === "highlighter" ? "highlighter" : "pen"]);
    sync();
  }
  function sync() {
    buttons.forEach((button, id) => { button.disabled = !enabled || busy; button.appearance = tool === id ? "solid" : "outline"; button.setAttribute("aria-pressed", String(tool === id)); });
    undo.disabled = busy || !history.canUndo; redo.disabled = busy || !history.canRedo; clear.disabled = busy || !history.strokes.length;
  }
  function publish() { state.strokes = history.strokes; sync(); changed(); }
  function drawLive() {
    scheduled = 0; if (!active) return;
    const rect = host.getBoundingClientRect(), factor = rect.width / page.width;
    const ratio = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(rect.width * ratio)), height = Math.max(1, Math.round(rect.height * ratio));
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
    canvas.getContext("2d").clearRect(0, 0, width, height);
    const drawing = createCanvasDrawing(canvas, width / page.width, new Map());
    // Bound the live curve count; the original sampled points remain intact until commit.
    let points = active.points, tolerance = PRINT.SKETCH.SAMPLE_DISTANCE_PX / factor;
    while (points.length > PRINT.SKETCH.MAX_LIVE_POINTS) { points = reduceSketch(points, tolerance); tolerance *= 2; }
    const clipped = clipSketch(points, page.map).map((p) => pageToSketch(p, page.map));
    drawSketch(drawing, page.map, [{ ...active, points: clipped }]);
    // Callout ink stays above the live sketch, just as it does in the shared finished layout.
    calloutElement.draw(drawing, page.map, callouts, context);
  }
  function sample(event) {
    if (!active || event.pointerId !== active.pointerId) return;
    const events = event.getCoalescedEvents?.() ?? [], factor = active.rect.width / page.width;
    for (const item of events.length ? events : [event]) {
      const p = point(item, active.rect), last = active.points.at(-1);
      if (Math.hypot(p.x - last.x, p.y - last.y) * factor >= PRINT.SKETCH.SAMPLE_DISTANCE_PX) active.points.push(p);
    }
    if (!scheduled) scheduled = requestAnimationFrame(drawLive);
  }
  function cancelStroke() {
    const stroke = active; active = null; cancelAnimationFrame(scheduled); scheduled = 0;
    canvas.hidden = true; canvas.getContext("2d").clearRect(0, 0, canvas.width, canvas.height);
    if (stroke && host.hasPointerCapture(stroke.pointerId)) host.releasePointerCapture(stroke.pointerId);
  }
  function finish(event) {
    if (!active || event.pointerId !== active.pointerId) return;
    sample(event);
    const stroke = active, points = reduceSketch(clipSketch(stroke.points, page.map)).map((p) => pageToSketch(p, page.map));
    cancelStroke();
    if (points.length > 1) { history.add({ tool: stroke.tool, color: stroke.color, weight: stroke.weight, points }); publish(); }
  }
  host.addEventListener("pointerdown", (event) => {
    if (!tool || !enabled || busy || event.button !== 0 || active) return;
    const rect = host.getBoundingClientRect(), p = point(event, rect); if (!inside(p)) return;
    event.preventDefault(); event.stopImmediatePropagation(); suppressClick = true; host.focus();
    if (tool === "eraser") { const at = hitSketch(history.strokes, p, page.map, PRINT.SKETCH.HIT_TOLERANCE_PX * page.width / rect.width); history.remove(at); publish(); return; }
    active = { pointerId: event.pointerId, rect, points: [p], tool, color: colors[tool], weight };
    canvas.hidden = false; host.setPointerCapture(event.pointerId);
  }, { ...listeners, capture: true });
  host.addEventListener("pointermove", (event) => { if (active) { event.preventDefault(); event.stopImmediatePropagation(); sample(event); } }, { ...listeners, capture: true });
  host.addEventListener("pointerup", finish, { ...listeners, capture: true });
  host.addEventListener("pointercancel", cancelStroke, listeners);
  host.addEventListener("lostpointercapture", cancelStroke, listeners);
  host.addEventListener("click", (event) => {
    if (tool || suppressClick) { suppressClick = false; event.preventDefault(); event.stopImmediatePropagation(); }
  }, { ...listeners, capture: true });
  host.addEventListener("wheel", (event) => { if (active) event.preventDefault(); }, { ...listeners, passive: false });
  sync();
  return { node,
    enable(value) { enabled = value; setTool(value ? "pen" : null); },
    setBusy(value) { busy = value; if (busy) cancelStroke(); sync(); },
    resize() { const rect = host.getBoundingClientRect(); if (active && (Math.abs(rect.width - active.rect.width) > 0.5 || Math.abs(rect.height - active.rect.height) > 0.5)) cancelStroke(); },
    cancel() { if (!tool && !active) return false; setTool(null); return true; },
    dispose() { setTool(null); abort.abort(); canvas.width = canvas.height = 0; canvas.remove(); state.strokes = []; },
  };
}
