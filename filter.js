import { FILTER } from "./config.js";
import { buildWhere, combineWithOriginal, kindOf, FilterError, OPERATORS } from "./filterSql.js";
import { h } from "./dom.js";

const fmt = (n) => n.toLocaleString();
const COUNTING_DELAY_MS = 250; // quick counts never flash "Counting…"

// Parcel filter: sets the parcel layer's definitionExpression (the web map's own expression
// AND the user's filter) and shows how many parcels are visible out of the total.
//
// One state, drawn by one renderer. `clearSelection` and `selectedObjectId` come from the parcel panel.
export async function setupFilter(mapEl, parcel, { clearSelection, selectedObjectId } = {}) {
  const block = document.getElementById("filter-block");
  const body = document.getElementById("filter-body");
  const countEl = document.getElementById("filter-count");
  const dialog = document.getElementById("filter-dialog");
  const dialogBody = document.getElementById("filter-dialog-body");
  const dialogCountEl = document.getElementById("filter-dialog-count");

  // Captured once; Clear puts exactly this back.
  const original = parcel.definitionExpression ?? null;
  // Counts always pass an explicit where, never relying on the layer's expression being applied.
  const countWhere = (expression) => (expression && String(expression).trim() ? expression : "1=1");

  // ---- fields on offer
  const fieldInfo = {}; // name -> { name, alias, kind, type, domain }
  const offered = [];
  const byName = new Map(parcel.fields.map((f) => [f.name, f]));
  const names = FILTER.INCLUDE_FIELDS.length ? FILTER.INCLUDE_FIELDS : parcel.fields.map((f) => f.name);
  for (const name of names) {
    const f = byName.get(name);
    if (!f) {
      console.warn(`FILTER.INCLUDE_FIELDS: no field named "${name}" on ${parcel.title}`);
      continue;
    }
    const kind = kindOf(f);
    if (!kind || FILTER.EXCLUDE_FIELDS.includes(name)) continue;
    fieldInfo[name] = { name, alias: f.alias || name, kind, type: f.type, domain: f.domain ?? null };
    offered.push(fieldInfo[name]);
  }

  // ---- state
  const blank = () => ({ field: "", op: "", value: "", value2: "" });
  const state = { match: FILTER.DEFAULT_MATCH, conditions: [blank()], rawSql: null };
  const resetState = () => {
    state.match = FILTER.DEFAULT_MATCH;
    state.conditions = [blank()];
    state.rawSql = null;
  };

  // ---- counts
  const counts = { total: null, visible: null, counting: false };
  let countingTimer;
  function renderCount() {
    const { total, visible, counting } = counts;
    const hidden = parcel.visible === false ? " (layer hidden)" : "";
    const text = counting
      ? "Counting…"
      : `${visible === null ? "—" : fmt(visible)} / ${total === null ? "—" : fmt(total)} ${FILTER.COUNT_LABEL} visible${hidden}`;
    const empty = !counting && visible === 0 && total !== 0;
    for (const el of [countEl, dialogCountEl]) {
      el.replaceChildren(...[
        counting ? h("calcite-loader", { inline: true, scale: "s", label: "Counting" }) : null,
        text,
        empty ? h("span", {}, " ", h("calcite-link", { onclick: () => clear() }, "Clear filter")) : null,
      ].filter((c) => c !== null));
      el.classList.toggle("empty", empty);
    }
    block.description = text; // stays visible when the block is collapsed
  }

  function beginCounting() {
    clearTimeout(countingTimer);
    countingTimer = setTimeout(() => {
      counts.counting = true;
      renderCount();
    }, COUNTING_DELAY_MS);
  }
  function endCounting() {
    clearTimeout(countingTimer);
    counts.counting = false;
  }

  // ---- messages (drawn under the builder, in both views)
  let messageData = null;
  function showMessage(kind, title, text) {
    messageData = { kind, title, text };
    render();
  }
  function clearMessage() {
    if (!messageData) return;
    messageData = null;
    render();
  }
  const messageNode = () =>
    messageData
      ? h("calcite-notice", { kind: messageData.kind, scale: "s", width: "auto", open: true },
          h("div", { slot: "title" }, messageData.title), h("div", { slot: "message" }, messageData.text))
      : null;

  // ---- suggestions for string fields: distinct values, fetched when a field is first chosen
  const distinct = new Map(); // field name -> string[] | null (null = too many, or the query failed)
  async function loadDistinct(name) {
    if (distinct.has(name)) return;
    distinct.set(name, undefined); // pending
    try {
      const result = await parcel.queryFeatures({
        where: countWhere(original),
        returnDistinctValues: true,
        returnGeometry: false,
        outFields: [name],
        orderByFields: [name],
        num: FILTER.MAX_DISTINCT + 1,
      });
      const values = result.features.map((f) => f.attributes[name]).filter((v) => v !== null && v !== undefined && v !== "");
      distinct.set(name, values.length > FILTER.MAX_DISTINCT ? null : values.map(String));
    } catch (err) {
      console.warn(`Couldn't list the values of ${name}; using a plain text box:`, err);
      distinct.set(name, null);
    }
  }

  // ---- builder UI (one renderer; `compact` shows only the first condition)
  function opsFor(cond) {
    const info = fieldInfo[cond.field];
    return info ? OPERATORS[info.kind] : [];
  }
  function onField(cond, name) {
    const before = fieldInfo[cond.field]?.kind;
    cond.field = name;
    const info = fieldInfo[name];
    if (!info) {
      cond.op = "";
    } else if (info.kind !== before || !opsFor(cond).some((o) => o.id === cond.op)) {
      cond.op = OPERATORS[info.kind][0].id;
    }
    cond.value = "";
    cond.value2 = "";
    render();
    if (info?.kind === "string" && !codedValues(info) && !distinct.has(name)) {
      loadDistinct(name).then(() => {
        if (state.conditions.some((c) => c.field === name)) render();
      });
    }
  }
  function onOp(cond, id) {
    const arity = (a) => a?.arity;
    const prev = arity(opsFor(cond).find((o) => o.id === cond.op));
    cond.op = id;
    const next = arity(opsFor(cond).find((o) => o.id === id));
    if (prev !== next) {
      cond.value = next === "list" ? [] : "";
      cond.value2 = "";
    }
    render();
  }

  const codedValues = (info) => (info?.domain?.type === "coded-value" ? info.domain.codedValues : null);

  // A combobox of { value, label } items. Multiple selection for "is one of".
  function combo({ items, multiple, custom, current, placeholder, disabled, onChange }) {
    const chosen = new Set((Array.isArray(current) ? current : [current]).map(String));
    return h("calcite-combobox", {
      selectionMode: multiple ? "multiple" : "single", allowCustomValues: custom, scale: "s",
      placeholder, label: placeholder, disabled: !!disabled,
      oncalciteComboboxChange: (e) =>
        onChange(multiple ? e.target.selectedItems.map((i) => i.value) : (e.target.value ?? "") || ""),
    }, items.map((i) => h("calcite-combobox-item", { value: i.value, heading: i.label, selected: chosen.has(String(i.value)) })));
  }

  function valueControls(cond) {
    const info = fieldInfo[cond.field];
    const operator = opsFor(cond).find((o) => o.id === cond.op);
    if (!info || !operator || operator.arity === 0) return [];
    const enter = (e) => e.key === "Enter" && apply();
    const list = operator.arity === "list";
    const pickable = ["eq", "ne", "in", "notIn"].includes(cond.op);

    if (info.kind === "date") {
      const range = operator.arity === 2;
      return [h("calcite-input-date-picker", {
        scale: "s", range, label: "Date", overlayPositioning: "fixed",
        value: range ? [cond.value || "", cond.value2 || ""] : cond.value || "",
        oncalciteInputDatePickerChange: (e) => {
          const v = e.target.value;
          if (range) [cond.value, cond.value2] = Array.isArray(v) ? [v[0] ?? "", v[1] ?? ""] : ["", ""];
          else cond.value = Array.isArray(v) ? v[0] ?? "" : v ?? "";
        },
      })];
    }

    const coded = codedValues(info);
    if (pickable && coded) {
      return [combo({
        items: coded.map((c) => ({ value: String(c.code), label: c.name })), multiple: list, custom: false,
        current: cond.value, placeholder: "Choose",
        onChange: (v) => (cond.value = v),
      })];
    }

    if (pickable && info.kind === "string") {
      const values = distinct.get(info.name);
      if (values !== null) {
        return [combo({
          items: (values ?? []).map((v) => ({ value: v, label: v })), multiple: list, custom: true,
          current: cond.value, disabled: values === undefined,
          placeholder: values === undefined ? "Loading values…" : list ? "Choose or type values" : "Choose or type a value",
          onChange: (v) => (cond.value = v),
        })];
      }
    }

    if (list) {
      return [h("calcite-input-text", {
        scale: "s", placeholder: "Separate values with commas",
        value: Array.isArray(cond.value) ? cond.value.join(", ") : "",
        oncalciteInputTextInput: (e) => (cond.value = e.target.value.split(/[,\n]/).map((s) => s.trim()).filter(Boolean)),
        onkeydown: enter,
      })];
    }
    const make = (key) => {
      if (info.kind === "numeric") {
        return h("calcite-input-number", {
          scale: "s", value: cond[key] ?? "", placeholder: key === "value2" ? "to" : "value",
          oncalciteInputNumberInput: (e) => (cond[key] = e.target.value), onkeydown: enter,
        });
      }
      return h("calcite-input-text", {
        scale: "s", value: cond[key] ?? "", placeholder: key === "value2" ? "to" : "value",
        oncalciteInputTextInput: (e) => (cond[key] = e.target.value), onkeydown: enter,
      });
    };
    return operator.arity === 2 ? [make("value"), make("value2")] : [make("value")];
  }

  function conditionRow(cond, { disabled = false, onRemove } = {}) {
    const field = h("calcite-combobox", {
      selectionMode: "single", scale: "s", placeholder: "Choose a field", label: "Field",
      oncalciteComboboxChange: (e) => onField(cond, e.target.value || ""),
    }, offered.map((f) => h("calcite-combobox-item", { value: f.name, heading: f.alias, selected: f.name === cond.field })));
    const ops = opsFor(cond);
    const op = h("calcite-select", {
      scale: "s", label: "Operator", disabled: ops.length === 0,
      oncalciteSelectChange: (e) => onOp(cond, e.target.value),
    }, ops.map((o) => h("calcite-option", { value: o.id, label: o.label, selected: o.id === cond.op })));
    const row = h("div", { class: "filter-row" },
      h("calcite-label", {}, "Field", field),
      h("div", { class: "filter-op-value" }, op, h("div", { class: "filter-values" }, valueControls(cond))),
      onRemove ? h("calcite-button", { class: "filter-remove", scale: "s", appearance: "transparent", kind: "danger", iconStart: "trash", onclick: onRemove }, "Remove") : null);
    if (disabled) {
      row.querySelectorAll("calcite-combobox, calcite-select, calcite-input-text, calcite-input-number, calcite-input-date-picker, calcite-button")
        .forEach((el) => (el.disabled = true));
    }
    return row;
  }

  const activeConditions = () => state.conditions.filter((c) => c.field);
  const isSimple = () => state.rawSql === null && activeConditions().length <= 1;

  function summaryText() {
    if (state.rawSql !== null) return "Custom SQL";
    const n = activeConditions().length;
    return `${n} conditions, match ${state.match === "OR" ? "any" : "all"}`;
  }

  const buttons = (compact) =>
    h("div", { class: "filter-buttons" },
      h("calcite-button", { scale: "s", onclick: () => apply() }, "Apply"),
      h("calcite-button", { scale: "s", appearance: "outline", onclick: () => clear() }, "Clear"),
      h("calcite-button", { scale: "s", appearance: "transparent", iconStart: "launch", label: compact ? "Expand" : "Open filter editor", title: "Open the larger filter editor", onclick: () => openDialog() }, compact ? "Expand" : null));

  // ---- the SQL section of the expanded view
  function previewSql() {
    try {
      return { sql: buildWhere({ ...state, rawSql: null }, fieldInfo) ?? "", error: null };
    } catch (err) {
      if (!(err instanceof FilterError)) throw err;
      return { sql: "", error: err.message };
    }
  }
  let previewEl = null;
  function updatePreview() {
    if (!previewEl || state.rawSql !== null) return;
    const { sql, error } = previewSql();
    previewEl.value = error ? `(incomplete: ${error})` : sql || "(no filter)";
  }

  function sqlSection() {
    const raw = state.rawSql !== null;
    const toggle = h("calcite-switch", {
      checked: raw, label: "Edit SQL directly",
      oncalciteSwitchChange: (e) => {
        state.rawSql = e.target.checked ? previewSql().sql : null;
        render();
      },
    });
    previewEl = h("calcite-text-area", {
      rows: 4, scale: "s", readOnly: !raw, label: "SQL where clause", placeholder: raw ? "e.g. pct_floodplain > 50" : "",
      value: raw ? state.rawSql : "",
      oncalciteTextAreaInput: (e) => {
        if (state.rawSql !== null) state.rawSql = e.target.value;
      },
    });
    updatePreview();
    return h("div", { class: "filter-sql" },
      h("calcite-label", { layout: "inline" }, "Edit SQL directly", toggle),
      previewEl,
      raw ? h("calcite-button", { scale: "s", appearance: "outline", onclick: () => { state.rawSql = null; render(); } }, "Back to builder") : null,
      h("div", { class: "plan-note" }, "Contains, starts with and ends with ignore case; % and _ typed in a value act as wildcards."));
  }

  // ---- one renderer for both views
  function renderBuilder(host, { compact }) {
    if (compact) {
      host.replaceChildren(...[
        isSimple()
          ? conditionRow(state.conditions[0])
          : h("div", {}, h("div", { class: "filter-summary" }, summaryText()),
              h("calcite-button", { scale: "s", appearance: "outline", iconStart: "pencil", onclick: () => openDialog() }, "Edit")),
        buttons(true),
        messageNode(),
      ].filter(Boolean));
      return;
    }
    const raw = state.rawSql !== null;
    const match = h("calcite-segmented-control", {
      scale: "s", disabled: raw,
      oncalciteSegmentedControlChange: (e) => {
        state.match = e.target.value;
        updatePreview();
      },
    }, h("calcite-segmented-control-item", { value: "AND", checked: state.match === "AND" }, "ALL"),
       h("calcite-segmented-control-item", { value: "OR", checked: state.match === "OR" }, "ANY"));
    host.replaceChildren(...[
      h("calcite-label", {}, "Match", match, " of these conditions"),
      ...state.conditions.map((c) =>
        conditionRow(c, {
          disabled: raw,
          onRemove: state.conditions.length > 1 ? () => { state.conditions.splice(state.conditions.indexOf(c), 1); render(); } : undefined,
        })),
      h("calcite-button", { scale: "s", appearance: "outline", iconStart: "plus", disabled: raw, onclick: () => { state.conditions.push(blank()); render(); } }, "Add condition"),
      sqlSection(),
      messageNode(),
    ].filter(Boolean));
  }

  function render() {
    renderBuilder(body, { compact: true });
    if (!dialog.closed) renderBuilder(dialogBody, { compact: false });
  }

  function openDialog() {
    dialog.closed = false;
    render();
    fitEditor();
  }
  function closeDialog() {
    dialog.closed = true;
  }

  // ---- keep the editor inside the map area and clear of the legend
  // The editor is anchored to the right edge of #map-host, so the shell layout moves it when the parcel
  // panel opens, closes or is resized. These helpers only cap its height (it scrolls inside) and
  // animate the move.
  const mapHost = document.getElementById("map-host");
  const GUTTER = 12;
  function fitEditor() {
    if (dialog.closed) return;
    const host = mapHost.getBoundingClientRect();
    // Where the editor will rest (its layout position, ignoring any slide in progress).
    const editorRight = host.right - GUTTER;
    const editorLeft = editorRight - dialog.offsetWidth;
    // The parcel search box sits in the top-left corner; when the map area is too narrow for both side by side,
    // the editor steps down below it.
    const search = mapHost.querySelector(".parcel-search");
    const searchBox = search ? search.getBoundingClientRect() : null;
    const top = searchBox && searchBox.right + GUTTER > editorLeft ? Math.ceil(searchBox.bottom - host.top + GUTTER) : GUTTER;
    let maxHeight = host.height - top - GUTTER;
    const legend = mapHost.querySelector("#legend-wrap");
    const legendBox = legend && legend.style.display !== "none" ? legend.getBoundingClientRect() : null;
    if (legendBox && legendBox.height > 0) {
      const sideBySide = legendBox.right <= editorLeft || legendBox.left >= editorRight;
      if (!sideBySide) maxHeight = Math.min(maxHeight, legendBox.top - host.top - top - GUTTER);
    }
    dialog.style.setProperty("--filter-editor-top", `${top}px`);
    dialog.style.setProperty("--filter-editor-max-height", `${Math.max(160, Math.floor(maxHeight))}px`);
  }
  let lastHostRight = mapHost.getBoundingClientRect().right;
  let lastHostChange = 0;
  const observer = new ResizeObserver(() => {
    const right = mapHost.getBoundingClientRect().right;
    const now = performance.now();
    const shift = lastHostRight - right;
    // A single jump (panel opened or closed) slides over 200 ms; a drag of the panel's handle just follows.
    if (!dialog.closed && Math.abs(shift) > 1 && now - lastHostChange > 120) {
      dialog.style.transition = "none";
      dialog.style.transform = `translateX(${shift}px)`;
      dialog.getBoundingClientRect(); // commit the starting position
      dialog.style.transition = "transform 200ms ease";
      dialog.style.transform = "";
    }
    lastHostRight = right;
    lastHostChange = now;
    fitEditor();
  });
  observer.observe(mapHost);
  const legendWatch = new MutationObserver(fitEditor);
  const watchLegend = () => {
    const legend = mapHost.querySelector("#legend-wrap");
    if (legend) {
      new ResizeObserver(fitEditor).observe(legend);
      legendWatch.observe(legend, { attributes: true, attributeFilter: ["style"] });
    }
  };
  watchLegend();
  mapHost.addEventListener("parcel-search-resize", fitEditor); // the search group's height (search modes, search.js)
  dialog.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeDialog();
  });

  // Zoom to whatever the applied filter shows, using the expression currently on the layer.
  async function zoomToResults() {
    try {
      const { extent, count: n } = await parcel.queryExtent({ where: countWhere(parcel.definitionExpression) });
      if (!extent || n === 0) {
        showMessage("warning", "Nothing to zoom to", "No parcels match the current filter.");
        return;
      }
      await mapEl.goTo(extent);
    } catch (err) {
      if (err?.name === "AbortError") return;
      console.warn("Couldn't zoom to the results:", err);
      showMessage("danger", "Couldn't zoom to the results", err?.message ?? String(err));
    }
  }
  document.getElementById("filter-dialog-zoom").addEventListener("click", zoomToResults);
  document.getElementById("filter-dialog-apply").addEventListener("click", () => apply());
  document.getElementById("filter-dialog-clear").addEventListener("click", () => clear());
  document.getElementById("filter-dialog-close").addEventListener("click", closeDialog);
  // Typing in a value doesn't redraw; keep the SQL preview current once the control's own handler has run.
  for (const type of ["calciteInputTextInput", "calciteInputNumberInput", "calciteComboboxChange", "calciteInputDatePickerChange", "calciteSelectChange"]) {
    dialogBody.addEventListener(type, () => setTimeout(updatePreview, 0));
  }

  // ---- apply / clear
  let sequence = 0; // only the latest apply may update the UI
  let inflight = null;

  async function apply(rawWhere) {
    if (typeof rawWhere === "string") state.rawSql = rawWhere;
    clearMessage();
    let userWhere;
    try {
      userWhere = buildWhere(state, fieldInfo);
    } catch (err) {
      if (!(err instanceof FilterError)) throw err;
      showMessage("danger", "Check the filter", err.message);
      return;
    }
    return commit(userWhere);
  }

  // Count with the exact expression first, then apply it, so a bad expression never reaches the layer.
  async function commit(userWhere) {
    const combined = combineWithOriginal(original, userWhere);
    const request = ++sequence;
    inflight?.abort();
    const controller = (inflight = new AbortController());
    beginCounting();
    try {
      const visible = await parcel.queryFeatureCount({ where: countWhere(combined) }, { signal: controller.signal });
      if (request !== sequence) return;
      parcel.definitionExpression = combined;
      counts.visible = visible;
      await dropFilteredOutSelection(combined, request, controller.signal);
    } catch (err) {
      if (request !== sequence || err?.name === "AbortError") return;
      console.warn("Filter query failed:", err);
      showMessage("danger", "That filter didn't work", err?.message ?? String(err));
    }
    if (request === sequence) {
      endCounting();
      renderCount();
    }
  }

  // If the selected parcel no longer passes the filter, clear it the same way hiding the layer does.
  async function dropFilteredOutSelection(combined, request, signal) {
    const oid = selectedObjectId?.();
    if (oid === null || oid === undefined) return;
    try {
      const stillThere = await parcel.queryFeatureCount({ objectIds: [oid], where: countWhere(combined) }, { signal });
      if (request === sequence && stillThere === 0) clearSelection?.();
    } catch (err) {
      if (err?.name !== "AbortError") console.warn("Couldn't check the selected parcel against the filter:", err);
    }
  }

  async function clear() {
    resetState();
    clearMessage();
    sequence++;
    inflight?.abort();
    endCounting();
    parcel.definitionExpression = original;
    if (counts.total !== null) {
      counts.visible = counts.total;
    } else {
      try {
        counts.total = counts.visible = await parcel.queryFeatureCount({ where: countWhere(original) });
      } catch (err) {
        console.warn("Couldn't count the parcels:", err);
      }
    }
    render();
    renderCount();
  }

  // ---- the count says so when the parcel layer is switched off in the layer list
  const { watch } = await $arcgis.import("@arcgis/core/core/reactiveUtils.js");
  watch(() => parcel.visible, renderCount);

  // ---- start
  try {
    counts.total = await parcel.queryFeatureCount({ where: countWhere(original) });
    counts.visible = counts.total;
  } catch (err) {
    console.warn("Couldn't count the parcels:", err);
  }
  render();
  renderCount();
  block.hidden = false;

  return {
    apply: (where) => apply(where),
    clear,
    zoomToResults,
    get state() {
      return JSON.parse(JSON.stringify(state));
    },
    get counts() {
      return { ...counts };
    },
    original,
  };
}
