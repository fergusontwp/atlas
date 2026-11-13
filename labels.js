import { LABELS } from "./config.js";
import { buildLabelClass } from "./labelExpr.js";
import { kindOf } from "./filterSql.js";
import { h } from "./dom.js";
import { setupEdges } from "./edges.js";

const clone = (o) => JSON.parse(JSON.stringify(o));
const APPLY_DELAY_MS = 60; // sliders fire constantly; labels are redrawn once they settle

// Labels section: turn parcel labels on and off, choose what they show, and style them.
// Labels are one LabelClass on the parcel layer (layer.labelingInfo + layer.labelsVisible). The renderer,
// STYLES and the legend are not touched, and labels follow the parcel filter because only visible parcels draw.
export async function setupLabels(mapEl, parcel, panel) {
  const block = document.getElementById("labels-block");
  const body = document.getElementById("labels-body");

  // What the web map had, kept so "Use web map labels" can put it back (the layer has none today).
  const originalInfo = (parcel.labelingInfo ?? []).map((c) => c.clone());
  const originalVisible = parcel.labelsVisible;
  const hadWebMapLabels = originalInfo.length > 0;

  // ---- label sources: the curated fields that exist on this layer
  const sources = []; // { key, label, kind: "text" | "number", format: {...} }
  const byName = new Map(parcel.fields.map((f) => [f.name, f]));
  for (const entry of LABELS.FIELDS) {
    const f = byName.get(entry.field);
    if (!f) {
      console.warn(`LABELS.FIELDS: no field named "${entry.field}" on ${parcel.title}; skipped`);
      continue;
    }
    const numeric = kindOf(f) === "numeric";
    sources.push({
      key: `field:${entry.field}`, field: entry.field, label: entry.label ?? f.alias ?? entry.field,
      kind: numeric ? "number" : "text",
      format: { decimals: entry.decimals ?? 0, thousands: true, prefix: entry.prefix ?? "", suffix: entry.suffix ?? "" },
    });
  }
  // GIS area (acres or square feet) and perimeter (feet), computed from Shape__Area / Shape__Length.
  const geometrySource = (key, label, field, divisor, decimals, suffix, hint) => {
    if (!byName.has(field)) {
      console.warn(`LABELS: no field named "${field}" on ${parcel.title}; "${label}" skipped`);
      return;
    }
    sources.push({ key, label, kind: "scaled", field, divisor, hint, format: { decimals, thousands: true, prefix: "", suffix } });
  };
  const planar = "Calculated from the parcel shape (planar, NAD83 UTM 17N). It differs slightly from the assessor's acreage (CAMA).";
  geometrySource("geom:area:acres", "Area, GIS: acres (calculated from parcel shape)", LABELS.GEOMETRY_AREA.field, LABELS.GEOMETRY_AREA.unitDivisors.acres, 2, " ac", planar);
  geometrySource("geom:area:square-feet", "Area, GIS: square feet (calculated from parcel shape)", LABELS.GEOMETRY_AREA.field, LABELS.GEOMETRY_AREA.unitDivisors["square-feet"], 0, " sq ft", planar);
  geometrySource("geom:perimeter", "Perimeter, GIS (ft)", LABELS.GEOMETRY_LENGTH.field, LABELS.GEOMETRY_LENGTH.unitDivisors[LABELS.EDGES.UNIT], 0, " ft",
    "Total length of the parcel boundary from the parcel shape (planar, NAD83 UTM 17N), in feet.");
  const sourceByKey = new Map(sources.map((s) => [s.key, s]));
  if (sources.length === 0) {
    block.hidden = true;
    return { apply() {}, reset() {}, get state() { return null; } };
  }

  // ---- state
  const defaults = () => {
    const d = clone(LABELS.DEFAULTS);
    const primary = sourceByKey.has(`field:${d.field}`) ? `field:${d.field}` : sources[0].key;
    const second = d.field2 && sourceByKey.has(`field:${d.field2}`) ? `field:${d.field2}` : "";
    return { ...d, show: true, field: primary, field2: second, fmt1: clone(sourceByKey.get(primary).format), fmt2: second ? clone(sourceByKey.get(second).format) : null };
  };
  const state = { ...defaults(), show: hadWebMapLabels ? originalVisible : false };
  let usingWebMap = hadWebMapLabels;

  // ---- edge lengths overlay (shares the font, color and halo of the parcel labels)
  const edgeStatus = h("div", { class: "plan-note", role: "status" });
  const edges = await setupEdges(mapEl, parcel, panel, {
    style: () => ({ color: state.color, haloColor: state.halo.color, haloSize: state.halo.on ? state.halo.size : 0, family: state.fontFamily, bold: state.bold, italic: state.italic }),
    onStatus: (text) => (edgeStatus.textContent = text),
  });

  // ---- apply to the layer
  const describe = (key, fmt) => {
    const s = sourceByKey.get(key);
    if (!s) return null;
    if (s.kind === "text") return { kind: "text", field: s.field };
    return s.kind === "scaled" ? { kind: "scaled", field: s.field, divisor: s.divisor, ...fmt } : { kind: "number", field: s.field, ...fmt };
  };
  function labelSettings() {
    return {
      sources: [describe(state.field, state.fmt1), state.field2 ? describe(state.field2, state.fmt2) : null].filter(Boolean),
      font: { family: state.fontFamily, size: state.fontSize, bold: state.bold, italic: state.italic },
      color: state.color,
      halo: state.halo,
      xoffset: state.xoffset,
      yoffset: state.yoffset,
      minScale: state.minScale,
      deconflict: state.deconflict,
    };
  }
  function applyNow() {
    if (!state.show) {
      parcel.labelsVisible = false;
      return;
    }
    usingWebMap = false;
    parcel.labelingInfo = [buildLabelClass(labelSettings())];
    parcel.labelsVisible = true;
  }
  let timer;
  const apply = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      try {
        applyNow();
      } catch (err) {
        console.error(err);
      }
      renderNotes();
      edges.refresh();
    }, APPLY_DELAY_MS);
  };

  // ---- controls
  const field = (label, ...controls) => h("calcite-label", {}, label, ...controls);
  const set = (key, transform = (v) => v) => (e) => {
    state[key] = transform(e.target.value);
    apply();
  };
  const select = (value, options, onChange, label) =>
    h("calcite-select", { scale: "s", label, oncalciteSelectChange: onChange },
      options.map((o) => h("calcite-option", { value: String(o.value), label: o.label, selected: String(o.value) === String(value) })));
  const check = (label, checked, onChange) =>
    h("calcite-label", { layout: "inline" }, h("calcite-checkbox", { checked, oncalciteCheckboxChange: onChange }), label);
  const slider = (value, min, max, onInput, label) =>
    h("calcite-slider", { value, min, max, step: 1, labelHandles: true, label, oncalciteSliderInput: onInput });
  const picker = (value, onChange, label) =>
    h("calcite-color-picker", { value, scale: "s", format: "hex", fieldDisabled: true, channelsDisabled: true, savedDisabled: true, label, oncalciteColorPickerChange: onChange });

  function formatRow(source, fmt) {
    if (!source || source.kind === "text") return null;
    return h("div", { class: "labels-format" },
      source.hint ? h("div", { class: "plan-note", style: "grid-column: 1 / -1" }, source.hint) : null,
      field("Decimals", h("calcite-input-number", { scale: "s", min: 0, max: 4, integer: true, value: String(fmt.decimals), oncalciteInputNumberInput: (e) => { fmt.decimals = Number(e.target.value) || 0; apply(); } })),
      check("1,000s separator", fmt.thousands, (e) => { fmt.thousands = e.target.checked; apply(); }),
      field("Before", h("calcite-input-text", { scale: "s", value: fmt.prefix, oncalciteInputTextInput: (e) => { fmt.prefix = e.target.value; apply(); } })),
      field("After", h("calcite-input-text", { scale: "s", value: fmt.suffix, oncalciteInputTextInput: (e) => { fmt.suffix = e.target.value; apply(); } })));
  }

  function onSource(which, key) {
    if (which === 1) {
      state.field = key;
      state.fmt1 = clone(sourceByKey.get(key).format);
    } else {
      state.field2 = key;
      state.fmt2 = key ? clone(sourceByKey.get(key).format) : null;
    }
    apply();
    render();
  }

  const noteEl = h("div", { class: "plan-note" });
  function renderNotes() {
    noteEl.textContent = usingWebMap
      ? "Showing the web map's own labels. Change a setting to replace them."
      : state.show
        ? "Labels follow the parcel filter and draw only when zoomed in past the chosen scale."
        : "";
  }

  function render() {
    const scaleOptions = [...LABELS.SCALES.map((s) => ({ value: s, label: `1:${s.toLocaleString()}` })), { value: 0, label: "Always (no limit)" }];
    if (state.minScale && !LABELS.SCALES.includes(state.minScale)) scaleOptions.unshift({ value: state.minScale, label: `1:${state.minScale.toLocaleString()}` });
    const sourceOptions = sources.map((s) => ({ value: s.key, label: s.label }));
    const src1 = sourceByKey.get(state.field);
    const src2 = state.field2 ? sourceByKey.get(state.field2) : null;

    body.replaceChildren(...[
      h("calcite-label", { layout: "inline" },
        h("calcite-switch", { checked: state.show, label: "Show labels", oncalciteSwitchChange: (e) => { state.show = e.target.checked; apply(); } }), "Show labels"),
      field("Label by", select(state.field, sourceOptions, (e) => onSource(1, e.target.value), "Label by")),
      formatRow(src1, state.fmt1),
      field("Second line (optional)", select(state.field2, [{ value: "", label: "None" }, ...sourceOptions], (e) => onSource(2, e.target.value), "Second line")),
      formatRow(src2, state.fmt2),
      h("calcite-block", { heading: "Text", collapsible: true },
        field("Font", select(state.fontFamily, [...new Set([...LABELS.FONTS, state.fontFamily])].map((f) => ({ value: f, label: f })), set("fontFamily"), "Font")),
        field("Size", slider(state.fontSize, 8, 24, set("fontSize", Number), "Font size")),
        h("div", { class: "labels-inline" },
          check("Bold", state.bold, (e) => { state.bold = e.target.checked; apply(); }),
          check("Italic", state.italic, (e) => { state.italic = e.target.checked; apply(); })),
        field("Color", picker(state.color, (e) => { state.color = String(e.target.value); apply(); }, "Text color"))),
      h("calcite-block", { heading: "Halo", collapsible: true },
        check("Halo", state.halo.on, (e) => { state.halo.on = e.target.checked; apply(); }),
        field("Halo color", picker(state.halo.color, (e) => { state.halo.color = String(e.target.value); apply(); }, "Halo color")),
        field("Halo size", slider(state.halo.size, 0, 4, (e) => { state.halo.size = Number(e.target.value); apply(); }, "Halo size"))),
      h("calcite-block", { heading: "Position and visibility", collapsible: true },
        h("div", { class: "labels-inline" },
          field("Horizontal offset", h("calcite-input-number", { scale: "s", value: String(state.xoffset), oncalciteInputNumberInput: set("xoffset", Number) })),
          field("Vertical offset", h("calcite-input-number", { scale: "s", value: String(state.yoffset), oncalciteInputNumberInput: set("yoffset", Number) }))),
        field("Show labels when zoomed in past", select(state.minScale, scaleOptions, set("minScale", Number), "Scale limit")),
        check("Hide overlapping labels", state.deconflict, (e) => { state.deconflict = e.target.checked; apply(); }),
        h("div", { class: "plan-note" }, "Polygon labels are always centered horizontally; offsets are in points.")),
      h("calcite-block", { heading: "Edge lengths (ft)", collapsible: true, expanded: edges.state.on },
        h("calcite-label", { layout: "inline" },
          h("calcite-switch", { checked: edges.state.on, label: "Edge lengths", oncalciteSwitchChange: (e) => (e.target.checked ? edges.on() : edges.off()) }), "Show the length of each side"),
        field("Which parcels", select(edges.state.scope, [{ value: "view", label: "All parcels in view" }, { value: "selected", label: "Selected parcel only" }], (e) => edges.set({ scope: e.target.value }), "Which parcels")),
        // Stacked like the Text block's fields: inside the inline flex row the slider's label shrank to the slider's minimum width.
        field("Decimals", select(edges.state.decimals, [0, 1, 2].map((d) => ({ value: d, label: String(d) })), (e) => edges.set({ decimals: Number(e.target.value) }), "Decimals")),
        field("Size", slider(edges.state.fontSize, 6, 16, (e) => edges.set({ fontSize: Number(e.target.value) }), "Edge font size")),
        edgeStatus,
        h("div", { class: "plan-note" }, "Lengths come from the map geometry (planar, NAD83 UTM 17N), so extra decimals won't match a deed or plat call exactly. A curve drawn as many short segments shows one label with the summed length. Text style is shared with the parcel labels.")),
      h("div", { class: "filter-buttons" },
        h("calcite-button", { scale: "s", appearance: "outline", onclick: () => reset() }, "Reset"),
        hadWebMapLabels ? h("calcite-button", { scale: "s", appearance: "outline", onclick: () => useWebMapLabels() }, "Use web map labels") : null),
      noteEl,
    ].filter(Boolean));
    renderNotes();
  }

  function reset() {
    Object.assign(state, defaults());
    usingWebMap = false;
    applyNow();
    render();
  }
  function useWebMapLabels() {
    clearTimeout(timer);
    parcel.labelingInfo = originalInfo.map((c) => c.clone());
    parcel.labelsVisible = originalVisible;
    state.show = originalVisible;
    usingWebMap = true;
    render();
  }

  render();
  block.hidden = false;

  return {
    // Console handle: apply({ field: "field:FMV", fontSize: 12, ... }) merges into the state and applies it.
    apply(partial = {}) {
      Object.assign(state, partial, { show: partial.show ?? true });
      // A new source brings its own default format unless the call gives one.
      if (partial.field && !partial.fmt1 && sourceByKey.has(partial.field)) state.fmt1 = clone(sourceByKey.get(partial.field).format);
      if (partial.field2 && !partial.fmt2 && sourceByKey.has(partial.field2)) state.fmt2 = clone(sourceByKey.get(partial.field2).format);
      if (partial.field2 === "") state.fmt2 = null;
      applyNow();
      render();
    },
    reset,
    // Console handle for the edge overlay: viewer.labels.edges.on() / off() / state.
    edges: { on: () => { edges.on(); render(); }, off: () => { edges.off(); render(); }, now: edges.now, get state() { return edges.state; }, layer: edges.layer },
    get state() {
      return clone(state);
    },
    get layerInfo() {
      return { labelsVisible: parcel.labelsVisible, labelingInfo: (parcel.labelingInfo ?? []).map((c) => c.toJSON()) };
    },
  };
}
