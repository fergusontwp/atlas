import { APP } from "./config.js";

// The theme (section 59): pure. theme.js applies it.

// A stored or chosen setting: "light", "dark" or "system"; anything else (unknown, empty, null) is "system".
export const sanitizeTheme = (value, cfg = APP.THEME) => (cfg.VALUES.includes(value) ? value : cfg.DEFAULT);

// The mode to show: "light" or "dark". Match system follows the OS (prefers-color-scheme: dark).
export const resolveTheme = (setting, systemPrefersDark) => {
  const s = sanitizeTheme(setting);
  return s === "system" ? (systemPrefersDark ? "dark" : "light") : s;
};

// The Calcite mode class for a resolved mode, and the one to remove.
export const modeClass = (resolved) => (resolved === "dark" ? "calcite-mode-dark" : "calcite-mode-light");
export const otherModeClass = (resolved) => (resolved === "dark" ? "calcite-mode-light" : "calcite-mode-dark");

// A colour from config as CSS (section 60): a Calcite token name ("--calcite-color-border-1") becomes var(…); anything
// else ("#rrggbb", "transparent") is used as it is; { LIGHT, DARK } becomes light-dark(…), which follows the mode's
// color-scheme (set on <html> with the mode class). Empty or missing: null.
export const cssColor = (value) => {
  if (value && typeof value === "object") {
    const light = cssColor(value.LIGHT), dark = cssColor(value.DARK);
    return light && dark ? `light-dark(${light}, ${dark})` : light ?? dark;
  }
  const v = typeof value === "string" ? value.trim() : "";
  return !v ? null : v.startsWith("--") ? `var(${v})` : v;
};

// WCAG contrast ratio of two #rrggbb colours (1 to 21), for the config checks in the tests.
export function contrastRatio(a, b) {
  const lum = (hex) => {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
    if (!m) return NaN;
    const [r, g, bl] = [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16) / 255)
      .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
