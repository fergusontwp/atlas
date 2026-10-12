import { h } from "./dom.js";
import { PLANS } from "./config.js";
import { statedScaleText, validateDetails } from "./planRecord.js";
import { field, kv, note } from "./wsUi.js";

// Step 4: what the plan is called and what it is. The source file, page, sheet size and stated scale are prefilled from
// the earlier steps (and can be corrected); nothing here names a parcel.
export function createStepDetails(ctx) {
  const { S } = ctx;
  const D = () => S.details;
  const limits = { nameMax: PLANS.NAME_MAX, notesMax: PLANS.NOTES_MAX, types: PLANS.TYPES };
  let showErrors = false;

  const edited = () => { ctx.markDirty(); ctx.changed("details"); render(); };

  const nameInput = h("calcite-input", {
    scale: "s", label: "Plan name", placeholder: "For example, Lot 4 as-built plan", maxLength: PLANS.NAME_MAX, required: true,
    oncalciteInputInput: (e) => { D().name = e.target.value; edited(); },
    oncalciteInputChange: () => { showErrors = true; render(); },
  });
  const typeSelect = h("calcite-select", { scale: "s", label: "Plan type", oncalciteSelectChange: (e) => { D().type = e.target.value; edited(); } },
    h("calcite-option", { value: "", label: "Choose a type" }),
    ...PLANS.TYPES.map((t) => h("calcite-option", { value: t, label: t })));
  const dateInput = h("calcite-input-date-picker", {
    scale: "s", overlayPositioning: "fixed", placement: "bottom-start",
    oncalciteInputDatePickerChange: (e) => { D().date = String(e.target.value ?? ""); edited(); },
  });
  const notesInput = h("calcite-text-area", {
    scale: "s", label: "Notes", rows: 3, maxLength: PLANS.NOTES_MAX,
    oncalciteTextAreaInput: (e) => { D().notes = e.target.value; edited(); },
  });
  const sheetInput = h("calcite-input", {
    scale: "s", label: "Sheet size", oncalciteInputInput: (e) => { D().sheetSize = e.target.value; D().sheetTouched = true; edited(); },
  });
  const scaleInput = h("calcite-input", {
    scale: "s", label: "Stated scale", oncalciteInputInput: (e) => { D().statedScale = e.target.value; D().scaleTouched = true; edited(); },
  });
  const sourceHost = h("div", {});
  const problem = h("div", { class: "plan-note ws-note-bad" });

  const el = h("div", {},
    note("Saved with the plan so staff can find it later. Only the name is required."),
    field("Plan name", nameInput),
    field("Type", typeSelect),
    field("Plan date", dateInput, "The date on the sheet, if it has one."),
    field("Notes", notesInput),
    h("div", { class: "ws-step-title" }, "From the sheet"),
    sourceHost,
    field("Sheet size", sheetInput),
    field("Stated scale", scaleInput),
    problem,
  );

  function sync() {
    const d = D();
    if (nameInput.value !== d.name) nameInput.value = d.name;
    typeSelect.value = d.type ?? "";
    if ((dateInput.value ?? "") !== d.date) dateInput.value = d.date ?? "";
    if (notesInput.value !== d.notes) notesInput.value = d.notes;
    if (sheetInput.value !== d.sheetSize) sheetInput.value = d.sheetSize ?? "";
    if (scaleInput.value !== d.statedScale) scaleInput.value = d.statedScale ?? "";
    sourceHost.replaceChildren(kv([["Source file", S.pdf?.name], ["Page", S.pdf ? `${S.pageNum} of ${S.pdf.numPages}` : ""]]));
  }

  function render() {
    const { errors } = validateDetails(D(), limits);
    const bad = (key) => showErrors && errors[key];
    nameInput.status = bad("name") ? "invalid" : "idle";
    nameInput.validationMessage = bad("name") ? errors.name : "";
    nameInput.validationIcon = bad("name") ? "exclamation-mark-triangle" : false;
    dateInput.status = errors.date ? "invalid" : "idle";
    problem.textContent = errors.date ?? errors.notes ?? errors.type ?? "";
    ctx.refreshNav();
  }

  return {
    el,
    canNext: () => validateDetails(D(), limits).ok,
    onShow() {
      const d = D();
      // prefill from the sheet and scale steps unless the user has already corrected them
      if (!d.sheetTouched) d.sheetSize = S.page?.sheetName ?? "";
      if (!d.scaleTouched) d.statedScale = statedScaleText(S.scale);
      showErrors = false;
      sync();
      render();
    },
    onHide() { showErrors = false; },
  };
}
