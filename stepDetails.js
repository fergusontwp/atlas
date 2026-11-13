import { h } from "./dom.js";
import { PLANS } from "./config.js";
import { bytesText, cleanServerPath, statedScaleText, validateDetails } from "./planRecord.js";
import { subjectText } from "./searchSubject.js";
import { field, kv, note } from "./wsUi.js";

// Step 4: what the plan is called and what it is. The source file, page, sheet size and stated scale are prefilled from
// the earlier steps (and can be corrected). The feature the workspace was opened from is shown for reference only; the
// record doesn't store it (the plan is found again by its footprint).
//
// The source PDF is attached only when "Attach source PDF" is ticked (off by default, PLANS.ATTACH_SOURCE_PDF_DEFAULT);
// otherwise the image gets the whole byte budget. The server location is where staff find the full PDF instead.
export function createStepDetails(ctx) {
  const { S } = ctx;
  const D = () => S.details;
  const limits = { nameMax: PLANS.NAME_MAX, notesMax: PLANS.NOTES_MAX, types: PLANS.TYPES, serverLocationMax: PLANS.SERVER_LOCATION_MAX };
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
  const attachBox = h("calcite-checkbox", {
    oncalciteCheckboxChange: (e) => {
      const on = e.target.checked;
      // Unticking on a plan saved with its PDF: the new version goes without it (the earlier version keeps its copy).
      if (!on && S.edit?.hadPdf && !window.confirm("This plan was saved with its source PDF attached. Save the new version without it? The earlier version keeps its copy.")) {
        e.target.checked = true;
        return;
      }
      S.attachPdf = on;
      ctx.markDirty();
      ctx.changed("attach");
      render();
    },
  });
  const attachNote = h("div", { class: "plan-note" });
  // Paste cleans the path at once (Windows "Copy as path" adds quotes); typing is cleaned when the value is committed,
  // so a space typed inside a folder name isn't trimmed away mid-word.
  const tidyLocation = (el) => { const clean = cleanServerPath(el.value); D().serverLocation = clean; if (el.value !== clean) el.value = clean; };
  const locationInput = h("calcite-input", {
    scale: "s", label: "Server location of the full PDF", placeholder: "\\\\server\\share\\Plans\\plan.pdf",
    oncalciteInputInput: (e) => { D().serverLocation = e.target.value; edited(); },
    oncalciteInputChange: (e) => { tidyLocation(e.target); edited(); },
    onpaste: (e) => { const el = e.currentTarget; setTimeout(() => { tidyLocation(el); edited(); }, 0); },
  });
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
    h("div", { class: "ws-step-title" }, "Source PDF"),
    h("calcite-label", { layout: "inline", scale: "s" }, attachBox, "Attach source PDF"),
    attachNote,
    field("Server location of the full PDF", locationInput, "The full path on the local server. Paste it from the file's \"Copy as path\"; quotes are removed."),
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
    sourceHost.replaceChildren(kv([["Opened from", subjectText(ctx.subject)], ["Source file", S.pdf?.name], ["Page", S.pdf ? `${S.pageNum} of ${S.pdf.numPages}` : ""]]));
    if (!locationInput.matches(":focus-within") && locationInput.value !== (d.serverLocation ?? "")) locationInput.value = d.serverLocation ?? "";
  }

  // The PDF's size when ticked (and whether it can go at all), and what that leaves the image.
  function renderAttach() {
    attachBox.checked = !!S.attachPdf;
    const size = S.pdf?.size;
    const b = ctx.imageBudget();
    const target = PLANS.COMPRESSION.TARGET_BYTES;
    attachNote.className = "plan-note";
    if (!S.attachPdf) attachNote.textContent = `Not attached${size ? ` (the PDF is ${bytesText(size)})` : ""}. ${bytesText(b.budget)} for the image.`;
    else if (!b.pdfAttached) { attachNote.textContent = `The PDF is ${bytesText(size)}, over the ${bytesText(target)} limit, so it can't be attached. Give its server location below.`; attachNote.className = "plan-note ws-note-warn"; }
    else attachNote.textContent = b.reserved ? `Attaches the ${bytesText(size)} PDF as it is, so the image gets ${bytesText(b.budget)} (${bytesText(target)} less the PDF).` : `Attaches the ${bytesText(size)} PDF as it is.`;
  }

  function render() {
    const { errors } = validateDetails(D(), limits);
    const bad = (key) => showErrors && errors[key];
    nameInput.status = bad("name") ? "invalid" : "idle";
    nameInput.validationMessage = bad("name") ? errors.name : "";
    nameInput.validationIcon = bad("name") ? "exclamation-mark-triangle" : false;
    dateInput.status = errors.date ? "invalid" : "idle";
    locationInput.status = errors.serverLocation ? "invalid" : "idle";
    problem.textContent = errors.date ?? errors.notes ?? errors.type ?? errors.serverLocation ?? "";
    renderAttach();
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
