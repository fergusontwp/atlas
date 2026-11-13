import { h } from "./dom.js";
import { NOTES } from "./config.js";
import { chipValues, diffChanges, labelOf, normValue, previewText, sameValue } from "./activityLogic.js";

// The field-change part of the Notes composer, for a source with `activity` (notesDialog.js places its pieces around
// the note box). Each edited field is prefilled with the request's current value ("Now: New") and counts as a change
// only when it differs (activityLogic.diffChanges), so "No change" is simply leaving it; a changed field shows a
// "Changed" tag and an Undo. Status: the layer's coded values, every one always available (a menu, not a path).
// Assigned to: the configured names, typing another is allowed. Resolution: a "Public" tag; collapsed behind a link
// unless it has a value, a chip expands it or the status is set to a closed one. Chips set fields in one click and never
// submit ("@me" is the signed-in user's full name). "Happened earlier?" opens a date for backdating (default now). A
// preview says what will be recorded, and a soft hint asks for a sentence when there are changes and no note.
// A user who can't update the feature's layer gets one line instead of the fields (the note box stays).
//
// opts: { me () -> Promise of the signed-in user's full name, onChange () }. Returns { chips, fields, foot, set,
// setShown, clear, changes, eventDate, refresh(noteEmpty), draft, restore, showStale, enabled }.
export function createActivityComposer({ me = async () => null, onChange = () => {} } = {}) {
  const T = NOTES.TEXT;
  const chips = h("div", { class: "activity-chips", hidden: true });
  const fields = h("div", { class: "activity-fields", hidden: true });
  const datePicker = h("calcite-input-date-picker", { scale: "s", label: T.HAPPENED_ON, overlayPositioning: "fixed", class: "activity-date" });
  const dateRow = h("div", { class: "activity-date-row", hidden: true }, h("calcite-label", { layout: "inline", scale: "s" }, T.HAPPENED_ON, datePicker));
  const dateLink = h("calcite-button", { appearance: "transparent", scale: "s", iconStart: "calendar", class: "activity-date-link", onclick: () => { dateLink.hidden = true; dateRow.hidden = false; } }, T.HAPPENED_LINK);
  const preview = h("div", { class: "plan-note activity-preview", hidden: true });
  const hint = h("div", { class: "plan-note activity-hint", hidden: true }, T.HINT_NO_NOTE);
  const stale = h("div", { class: "plan-note ws-note-bad activity-stale", hidden: true });
  const foot = h("div", { class: "activity-foot", hidden: true }, dateLink, dateRow, preview, hint, stale);

  let resolved = null, enabled = false, shown = {}, proposed = {};
  const rows = new Map(); // field -> { setInput(value), sync() }
  const expanded = new Set();

  const today = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  const resetDate = () => {
    dateLink.hidden = false;
    dateRow.hidden = true;
    datePicker.max = today();
    datePicker.value = today();
  };

  const isClosed = (v) => (resolved?.closedStatuses ?? []).some((c) => String(c) === String(v));
  function setValue(e, value, { fromInput = false } = {}) {
    proposed[e.field] = normValue(value);
    if (!fromInput) rows.get(e.field)?.setInput(proposed[e.field]);
    if (e.key === "status" && isClosed(proposed[e.field])) resolved.edits.filter((x) => x.collapsed).forEach((x) => expand(x));
    rows.forEach((r) => r.sync());
    onChange();
  }
  function expand(e) {
    expanded.add(e.field);
    rows.get(e.field)?.sync();
  }

  function fieldRow(e) {
    const now = h("span", { class: "activity-now plan-note" });
    const changedTag = h("calcite-chip", { scale: "s", kind: "brand", class: "activity-changed" }, T.CHANGED);
    const undo = h("calcite-button", { appearance: "transparent", scale: "s", class: "activity-undo", onclick: () => setValue(e, shown[e.field]) }, T.UNDO_FIELD);
    const publicTag = e.public ? h("calcite-chip", { scale: "s", kind: "neutral", icon: "globe", class: "activity-public", title: T.PUBLIC_TITLE }, T.PUBLIC_TAG) : null;
    const head = h("div", { class: "activity-row-head" }, h("span", { class: "activity-label" }, e.label), publicTag, now, changedTag, undo);
    let input = null, setInput = () => {};
    if (e.editable && e.input === "domain") {
      input = h("calcite-select", { scale: "s", label: e.label, class: "activity-input", oncalciteSelectChange: () => setValue(e, input.value === "" ? null : input.value, { fromInput: true }) });
      setInput = (v) => {
        const known = e.codedValues.some((c) => String(c.code) === String(v ?? ""));
        input.replaceChildren(...(v === null || !known ? [h("calcite-option", { value: "", label: v === null ? T.NONE : String(v), selected: true }, v === null ? T.NONE : String(v))] : []),
          ...e.codedValues.map((c) => h("calcite-option", { value: String(c.code), label: c.name, selected: v !== null && String(c.code) === String(v) }, c.name)));
      };
    } else if (e.editable && e.input === "list") {
      input = h("calcite-combobox", { scale: "s", label: e.label, selectionMode: "single", allowCustomValues: true, placeholder: T.NONE, class: "activity-input",
        oncalciteComboboxChange: () => setValue(e, Array.isArray(input.value) ? input.value[0] : input.value, { fromInput: true }) });
      setInput = (v) => {
        const names = [...new Set([...(e.list ?? []), ...(v === null ? [] : [String(v)])])];
        input.replaceChildren(...names.map((n) => h("calcite-combobox-item", { value: n, heading: n, selected: v !== null && n === String(v) })));
      };
    } else if (e.editable) {
      input = h("calcite-text-area", { scale: "s", rows: 2, resize: "vertical", label: e.label, class: "activity-input", maxLength: e.length ?? NOTES.MAX_CHARS,
        oncalciteTextAreaInput: () => setValue(e, input.value, { fromInput: true }) });
      setInput = (v) => { input.value = v ?? ""; };
    }
    const opener = e.collapsed && input ? h("calcite-button", { appearance: "transparent", scale: "s", iconStart: "pencil", class: "activity-expand", onclick: () => { expand(e); input.setFocus?.(); } }, T.SHOW_FIELD(e.label)) : null;
    const row = h("div", { class: "activity-row" }, head, opener, input);
    row.dataset.field = e.field;
    const sync = () => {
      const changed = !sameValue(proposed[e.field], shown[e.field]);
      const nowText = labelOf(e, shown[e.field]) ?? T.NONE;
      now.textContent = T.CURRENT(nowText.length > 80 ? `${nowText.slice(0, 80)}…` : nowText);
      changedTag.hidden = undo.hidden = !changed;
      const open = !e.collapsed || expanded.has(e.field) || normValue(shown[e.field]) !== null || changed;
      if (input) input.hidden = !open;
      if (opener) opener.hidden = open;
    };
    rows.set(e.field, { setInput, sync });
    return row;
  }

  // Fill for a feature: resolved activity config, its current values, whether the user may update its layer.
  function set({ resolved: r, values, canUpdate }) {
    resolved = r;
    enabled = !!canUpdate;
    shown = { ...values };
    proposed = { ...values };
    expanded.clear();
    rows.clear();
    fields.replaceChildren(...(enabled ? r.edits.map(fieldRow) : [h("div", { class: "plan-note activity-read-only" }, T.ACTIVITY_READ_ONLY)]));
    for (const e of r.edits) rows.get(e.field)?.setInput(proposed[e.field]);
    chips.replaceChildren(...(enabled ? r.chips.map((c) => h("calcite-chip", { scale: "s", kind: "neutral", class: "activity-chip", onclick: () => applyChip(c) }, c.label)) : []));
    chips.hidden = !enabled || !r.chips.length;
    fields.hidden = false;
    foot.hidden = !enabled;
    stale.hidden = true;
    resetDate();
    rows.forEach((x) => x.sync());
  }
  async function applyChip(chip) {
    const values = chipValues(chip, resolved.edits, await me());
    for (const [field, v] of Object.entries(values)) setValue(resolved.edits.find((e) => e.field === field), v);
    if (chip.expand) {
      const e = resolved.edits.find((x) => x.key === chip.expand);
      if (e) expand(e);
    }
    onChange();
  }

  return {
    chips, fields, foot,
    get enabled() { return enabled; },
    set,
    // the values the dialog now shows as current (after someone else changed the request); what the user set stays
    setShown(values) {
      shown = { ...values };
      rows.forEach((x) => x.sync());
      onChange();
    },
    clear() {
      resolved = null;
      enabled = false;
      chips.hidden = fields.hidden = foot.hidden = true;
      fields.replaceChildren();
      chips.replaceChildren();
    },
    changes: () => (enabled && resolved ? diffChanges(resolved.edits, shown, proposed) : []),
    // when it happened: now, or the chosen earlier day at the current time of day
    eventDate() {
      const v = enabled && !dateRow.hidden ? datePicker.value : "";
      if (!v || v === today()) return Date.now();
      const [y, m, d] = String(v).split("-").map(Number);
      const now = new Date();
      return new Date(y, m - 1, d, now.getHours(), now.getMinutes(), now.getSeconds()).getTime();
    },
    // the preview and the soft hint
    refresh(noteEmpty) {
      const c = enabled && resolved ? diffChanges(resolved.edits, shown, proposed) : [];
      preview.textContent = c.length ? T.PREVIEW(previewText(c, T)) : "";
      preview.hidden = !c.length;
      hint.hidden = !(c.length && noteEmpty);
    },
    draft: () => (enabled ? { proposed: Object.fromEntries(diffChanges(resolved.edits, shown, proposed).map((c) => [c.field, c.to])), date: dateRow.hidden ? null : datePicker.value } : null),
    restore(d) {
      if (!enabled || !d) return;
      for (const [field, v] of Object.entries(d.proposed ?? {})) {
        const e = resolved.edits.find((x) => x.field === field);
        if (e) setValue(e, v);
      }
      if (d.date) { dateLink.hidden = true; dateRow.hidden = false; datePicker.value = d.date; }
    },
    // someone else changed the request: what, by whom, when (lines are text)
    showStale(lines) {
      stale.replaceChildren(...lines.map((l) => h("div", {}, l)));
      stale.hidden = !lines.length;
    },
    afterSaved(values) {
      shown = { ...values };
      proposed = { ...values };
      expanded.clear();
      for (const e of resolved?.edits ?? []) rows.get(e.field)?.setInput(proposed[e.field]);
      resetDate();
      stale.hidden = true;
      rows.forEach((x) => x.sync());
    },
  };
}
