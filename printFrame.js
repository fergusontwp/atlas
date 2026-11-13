// A DOM overlay inside the map host, never a map layer. Coordinates remain SDK view pixels.
import { frameRect } from "./printGeometry.js";

export function createPrintFrame(mapEl, onChange) {
  const host = document.getElementById("map-host");
  let overlay = null, outline = null, observer = null, page = null, rect = null, scheduled = 0;
  function sync() {
    if (!overlay) return;
    const view = mapEl.view;
    rect = view.width > 0 && view.height > 0 ? frameRect(view.width, view.height, page.map) : null;
    outline.hidden = !rect;
    if (rect) {
      const mapBox = mapEl.getBoundingClientRect(), hostBox = host.getBoundingClientRect();
      Object.assign(outline.style, { left: `${rect.x + mapBox.left - hostBox.left}px`,
        top: `${rect.y + mapBox.top - hostBox.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
    }
    onChange(rect);
  }
  function schedule() {
    if (scheduled || !overlay) return;
    scheduled = requestAnimationFrame(() => { scheduled = 0; sync(); });
  }
  function start(geometry) {
    page = geometry;
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.className = "print-frame-overlay"; overlay.setAttribute("aria-hidden", "true");
      outline = document.createElement("div"); outline.className = "print-frame"; overlay.append(outline);
      host.append(overlay);
      observer = new ResizeObserver(schedule); observer.observe(host); observer.observe(mapEl);
    }
    sync();
  }
  function stop() {
    observer?.disconnect(); observer = null;
    cancelAnimationFrame(scheduled); scheduled = 0;
    overlay?.remove(); overlay = outline = null; rect = null;
  }
  return { start, stop, sync, get rect() { return rect && { ...rect }; } };
}
