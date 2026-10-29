import { h } from "./dom.js";

// An opacity slider in 10% steps that snaps to them, with its value and a reset to the default. Shared by the basemap
// block and the plans on the map. value and initial are 0 to 1; min (0 to 1) keeps a layer from vanishing where Hide does
// that instead. onInput(opacity 0 to 1) on every change, the reset included. Returns { el, set(opacity) }.
export function opacityControl({ label, value = 1, initial = 1, min = 0, disabled = false, onInput }) {
  const pct = (v) => Math.round(Math.max(min, Math.min(1, v)) * 10) * 10; // to the nearest 10%
  const out = h("span", { class: "opacity-value" });
  const show = (p) => { out.textContent = `${p}%`; reset.disabled = disabled || p === pct(initial); };
  const slider = h("calcite-slider", { min: Math.round(min * 100), max: 100, step: 10, snap: true, ticks: 10, value: pct(value), label, scale: "s", disabled,
    oncalciteSliderInput: (e) => { show(e.target.value); onInput(e.target.value / 100); } });
  const reset = h("calcite-action", { icon: "reset", text: `Reset to ${pct(initial)}%`, scale: "s", disabled,
    onclick: () => { slider.value = pct(initial); show(pct(initial)); onInput(pct(initial) / 100); } });
  show(pct(value));
  const el = h("div", { class: "opacity-control" }, h("span", { class: "opacity-label" }, label), slider, out, reset);
  return { el, set(v) { slider.value = pct(v); show(pct(v)); } };
}
