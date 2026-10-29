import { h } from "./dom.js";

// Small builders for the workspace panel, so every step reads the same.

// A labelled control with optional help text under it.
export const field = (label, control, help) =>
  h("div", { class: "ws-field" }, h("span", { class: "ws-label" }, label), control, help ? h("div", { class: "plan-note" }, help) : null);

// A line of small text. tone: "warn" | "bad" | "good" colors it (status colors only).
export const note = (text, tone) => h("div", { class: `plan-note${tone ? ` ws-note-${tone}` : ""}` }, text);

// A calcite-input-number. onInput runs while typing, onChange when the value is committed.
export function numberInput({ value, min, max, step, suffix, label, integer, onInput, onChange, width }) {
  const el = h("calcite-input-number", {
    scale: "s", value: value == null ? "" : String(value), min, max, step, suffixText: suffix, label, integer: !!integer,
    oncalciteInputNumberInput: (e) => onInput?.(e.target.value),
    oncalciteInputNumberChange: (e) => onChange?.(e.target.value),
  });
  if (width) el.style.width = width;
  return el;
}

// A definition list of label / value pairs; null values are left out.
export const kv = (pairs) => h("dl", { class: "ws-kv" }, ...pairs.filter(([, v]) => v != null && v !== "").flatMap(([k, v]) => [h("dt", {}, k), h("dd", {}, v)]));

// Sets a value on a calcite-input-number unless the user is typing in it.
export function setIfIdle(el, value) {
  if (el.matches(":focus-within")) return;
  el.value = value == null ? "" : String(value);
}

export const fmt = (n, d = 0) => Number(n).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
