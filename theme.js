import { APP } from "./config.js";
import { modeClass, otherModeClass, resolveTheme, sanitizeTheme } from "./themeLogic.js";

// Light, Dark or Match system (section 59). The mode is Calcite's class on <html>: calcite-mode-light or
// calcite-mode-dark. Calcite's tokens and the 5.1 map components' own CSS follow it (the components read the closest
// .calcite-mode-* ancestor; their stylesheet is built on Calcite tokens), so no SDK theme stylesheet is swapped. <html>,
// not <body>: the inline script at the top of index.html sets it before <body> exists, so the first paint is already in
// the right mode, and top-layer dialogs and popovers sit under <html> too. The map itself never changes.
// Match system follows prefers-color-scheme live. The setting is saved under APP.THEME.STORAGE_KEY (try/catch; with
// storage blocked it lasts for the visit and Match system still works).
// Returns viewer.theme: { get(), set(value), state: { setting, resolved }, onChange(cb) }. A change of the shown mode
// also fires "parcelviewer-theme" on window, for canvases drawn in the page's colours.
export function setupTheme({ root = document.documentElement, media = matchMedia("(prefers-color-scheme: dark)") } = {}) {
  const key = APP.THEME.STORAGE_KEY;
  let setting = APP.THEME.DEFAULT;
  try { setting = sanitizeTheme(localStorage.getItem(key)); } catch { /* storage blocked: Match system */ }
  const listeners = new Set();
  let resolved = null;
  function apply() {
    const next = resolveTheme(setting, media.matches);
    root.classList.remove(otherModeClass(next));
    root.classList.add(modeClass(next));
    if (next === resolved) return;
    resolved = next;
    listeners.forEach((cb) => cb(state()));
    // for anything drawn once in the page's colours (a canvas) that should be drawn again
    window.dispatchEvent(new CustomEvent("parcelviewer-theme", { detail: state() }));
  }
  const state = () => ({ setting, resolved });
  media.addEventListener?.("change", () => { if (setting === "system") apply(); });
  apply();
  return {
    get: () => setting,
    set(value) {
      setting = sanitizeTheme(value);
      try {
        if (setting === APP.THEME.DEFAULT) localStorage.removeItem(key);
        else localStorage.setItem(key, setting);
      } catch { /* not saved: it still applies for this visit */ }
      apply();
      listeners.forEach((cb) => cb(state()));
      return state();
    },
    get state() { return state(); },
    onChange: (cb) => listeners.add(cb),
  };
}

// A Calcite token's LIGHT-mode value, whatever the page's mode (section 59): for colours drawn on the map or on paper
// (plan sheets, the placement marks), which never change with the theme. Read from a hidden element carrying
// calcite-mode-light, so it is exactly what the token was before dark mode existed. fallback: when Calcite isn't there.
let lightProbe = null;
export function lightToken(name, fallback) {
  if (typeof document === "undefined") return fallback;
  if (!lightProbe || !lightProbe.isConnected) {
    lightProbe = document.createElement("span");
    lightProbe.className = "calcite-mode-light";
    lightProbe.hidden = true;
    lightProbe.setAttribute("aria-hidden", "true");
    document.body.append(lightProbe);
  }
  return getComputedStyle(lightProbe).getPropertyValue(name).trim() || fallback;
}
