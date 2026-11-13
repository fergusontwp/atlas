import { HIGHLIGHT } from "./config.js";
import { sanitizeColor } from "./selectionMode.js";
import { printColorControl } from "./printColorControl.js";
import { h } from "./dom.js";

// The highlight color: the selection outline's and the road search outline's (selectionOutline.js, roadSearch.js). One
// value for the page, saved per browser (HIGHLIGHT.STORAGE_KEY; the app works without storage). Changing it only
// rebuilds those outline graphics' symbols; HighlightOptions and the view's highlights are never touched.
let current = load();
const listeners = new Set();
function load() {
  try { return sanitizeColor(localStorage.getItem(HIGHLIGHT.STORAGE_KEY)); } catch { return HIGHLIGHT.DEFAULT_COLOR; }
}
export const highlightColor = {
  get: () => current,
  set(value) {
    const color = sanitizeColor(value);
    if (color === current) return;
    current = color;
    try {
      if (color === HIGHLIGHT.DEFAULT_COLOR) localStorage.removeItem(HIGHLIGHT.STORAGE_KEY);
      else localStorage.setItem(HIGHLIGHT.STORAGE_KEY, color);
    } catch { /* not saved: it still applies for this visit */ }
    listeners.forEach((cb) => cb(color));
  },
  onChange: (cb) => listeners.add(cb),
};

// "Highlight color" at the top of the Symbology block, above "Color parcels by": the print color control (presets and
// Custom) and a Reset action.
export function setupHighlightColor() {
  const block = document.getElementById("symbology-block");
  if (!block) return null;
  const T = HIGHLIGHT.TEXT;
  const control = printColorControl("highlight-color", T.LABEL, current, (value) => highlightColor.set(value), false, HIGHLIGHT.PRESETS);
  const reset = h("calcite-action", { icon: "reset", text: T.RESET, label: T.RESET, scale: "s", onclick: () => highlightColor.set(HIGHLIGHT.DEFAULT_COLOR) });
  const sync = () => { control.set(current); reset.disabled = current === HIGHLIGHT.DEFAULT_COLOR; };
  highlightColor.onChange(sync);
  sync();
  const node = h("div", { class: "highlight-color" },
    h("calcite-label", { class: "highlight-color-label" }, T.HEADING, h("div", { class: "highlight-color-row" }, control.node, reset)));
  block.prepend(node);
  return { node, control, reset };
}
