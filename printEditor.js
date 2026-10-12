import { createPrintSketch } from "./printSketch.js";
import { printTextControls } from "./printTextControls.js";
import { PRINT } from "./config.js";
import { printTiming } from "./printTiming.js";
import { h } from "./dom.js";
import { detailMessage } from "./printDetail.js";
import { printFilename } from "./printFilename.js";
import { printElements } from "./printElements/index.js";
import { createPrintCapture } from "./printCapture.js";
import { lockPrintView } from "./printLock.js";
import { renderPrintPage, exportPng, exportPdf, printFormats } from "./printExport.js";
import { capturePrintLegend } from "./printLegend.js";
import { createPrintCallouts } from "./printCallouts.js";
import { saveFile } from "./download.js";

// The registry supplies all element controls and drawing. No popup content or map data is rebuilt here.
export function setupPrintEditor({ mapEl, panel, print, measure, parcel }) {
  const capture = createPrintCapture({ mapEl, panel, measure, parcel });
  let editor = null, draft = null;
  print.onClose(() => { editor?.dispose(false); draft = null; });
  print.onContinue(async (api, signal) => {
    const timing = printTiming();
    const [reactive, Point] = await timing.step("editor SDK ready", () => $arcgis.import(["@arcgis/core/core/reactiveUtils.js", "@arcgis/core/geometry/Point.js"]), { signal, timeoutMs: PRINT.TIMEOUT_MS.READY });
    signal.throwIfAborted();
    const snapshot = api.beginEditor(), page = structuredClone(api.page);
    draft ??= Object.fromEntries(printElements.map((element) => [element.id,
      { ...structuredClone(element.defaultState), on: api.state.elements[element.id] ?? element.defaultState.on }]));
    for (const element of printElements) for (const control of element.controls) {
      if (control.type === "text-style") draft[element.id][control.key] ??= { ...api.state.styles[control.profile] };
    }
    editor = buildEditor(snapshot, page, draft, reactive, Point, timing);
    await editor.initialize(signal);
  });

  function buildEditor(snapshot, page, states, reactive, Point, timing) {
    let disposed = false, busy = false, exporting = false, current = null, rendered = null, scheduled = 0, legend = null;
    const abort = new AbortController(), cache = new Map(), unlock = lockPrintView(mapEl, panel, reactive);
    const context = { feetPerInch: snapshot.feetPerInch, rotation: snapshot.rotation, border: print.state.border,
      date: new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }), attribution: "", timing, legendStatus: "loading" };
    const now = new Date(), localDate = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, "0"), String(now.getDate()).padStart(2, "0")].join("-");
    const notice = h("div", { class: "plan-note", hidden: true }, "Owner names are visible on this map.");
    const detail = h("div", { class: "plan-note" }), overflow = h("div", { class: "print-overflow", role: "status" });
    const status = h("div", { id: "print-progress", class: "plan-note", role: "status", ariaLive: "polite" });
    const stage = h("div", { class: "print-preview", ariaLabel: "Print page preview" });
    const pageHost = h("div", { class: "print-page", tabIndex: 0, ariaLabel: "Map preview; click to place a callout" }); stage.append(pageHost);
    const section = (label) => h("section", { class: "print-controls-section", ariaLabel: label }, h("h3", { class: "print-controls-heading" }, label));
    const controls = h("div", { class: "print-editor-controls" }), elements = section("Elements"), calloutControls = section("Callouts"), outputControls = section("Output");
    const legendFields = h("div", { class: "print-legend-layers" });
    const callouts = createPrintCallouts({ host: pageHost, controls: calloutControls, page, frame: snapshot.frame, view: mapEl.view, Point,
      state: states.callouts, context, textStyle: print.state.styles.callout,
      rememberTextStyle: (style) => { print.state.styles.callout = style; print.remember(); }, changed: scheduleRender });
    const sketch = createPrintSketch({ host: pageHost, page, state: states.sketch, callouts: states.callouts, context,
      changed: scheduleRender, activate: () => { callouts.commit(); callouts.cancel(); } });
    calloutControls.querySelector("#print-add-callout").addEventListener("click", () => sketch.cancel());
    const include = h("calcite-checkbox", { id: "print-include-selection", checked: false,
      oncalciteCheckboxChange: () => run((signal) => loadCapture(include.checked, signal)).catch(() => {}) });
    if (panel.selectedObjectId() !== null) outputControls.append(h("calcite-label", { layout: "inline" }, include, "Include selected parcel"));
    for (const element of printElements) {
      if (element.required) continue;
      const fields = h("div", { class: "print-element-fields" });
      let expanded = element.id !== "legend" && element.controls.some((control) => ["text", "multiline"].includes(control.type));
      const more = element.controls.length ? h("calcite-action", { scale: "s", onclick: () => { expanded = !expanded; syncFields(); } }) : null;
      if (more) more.id = `print-options-${element.id}`;
      function syncFields() {
        fields.hidden = !states[element.id].on || !expanded || !fields.childElementCount;
        if (more) {
          more.hidden = !states[element.id].on; more.icon = expanded ? "chevron-down" : "chevron-right";
          more.text = more.title = `${expanded ? "Hide" : "Show"} ${element.label.toLowerCase()} options`;
          more.setAttribute("aria-expanded", String(!fields.hidden));
        }
      }
      const checkbox = h("calcite-checkbox", { id: `print-element-${element.id}`, checked: states[element.id].on,
        oncalciteCheckboxChange: () => {
          states[element.id].on = checkbox.checked;
          if (element.id === "sketch") { expanded = checkbox.checked; sketch.enable(checkbox.checked); }
          syncFields();
          if (element.id !== "sketch") { print.state.elements[element.id] = checkbox.checked; print.remember(); } scheduleRender();
        } });
      for (const control of element.controls) {
        if (control.type === "text-style") {
          const style = printTextControls(`print-${element.id}-${control.key}`, control.profile, states[element.id][control.key], (value) => {
            states[element.id][control.key] = value; print.state.styles[control.profile] = value; print.remember(); scheduleRender();
          }, control.label); fields.append(style.node); continue;
        }
        if (control.type === "sketch") { fields.append(sketch.node); continue; }
        if (control.type === "legend") { fields.append(legendFields); continue; }
        const input = h(control.type === "multiline" ? "calcite-text-area" : "calcite-input", {
          id: `print-${element.id}-${control.key}`, scale: "s", label: control.label, value: states[element.id][control.key], rows: 3,
        });
        input.addEventListener(control.type === "multiline" ? "calciteTextAreaInput" : "calciteInputInput", () => {
          states[element.id][control.key] = input.value; scheduleRender();
        });
        fields.append(control.label === element.label ? input : h("calcite-label", {}, control.label, input));
      }
      elements.append(h("div", { class: "print-element" },
        h("div", { class: "print-element-toggle" }, h("calcite-label", { layout: "inline" }, checkbox, element.label), more),
        element.controls.length ? fields : null));
      syncFields();
    }
    outputControls.append(notice, detail, overflow); controls.append(elements, calloutControls, outputControls);
    const back = h("calcite-button", { id: "print-back", appearance: "transparent", iconStart: "chevron-left", scale: "s", onclick: () => dispose(true) }, "Back");
    const close = h("calcite-action", { id: "print-editor-close", icon: "x", text: "Return to framing", scale: "s", onclick: () => dispose(true) });
    let format = printFormats.includes(print.state.format) ? print.state.format : printFormats[0];
    const formatPicker = h("calcite-select", { id: "print-format", label: "File format", scale: "s",
      oncalciteSelectChange: () => { format = formatPicker.value; print.state.format = format; print.remember(); } },
    printFormats.map((value) => h("calcite-option", { value, label: value.toUpperCase(), selected: value === format })));
    const filename = h("calcite-input", { id: "print-filename", scale: "s", value: printFilename("", "png", localDate).slice(0, -4), label: "File name" });
    const exportButton = h("calcite-button", { id: "print-export", iconStart: "download", scale: "s", disabled: true,
      onclick: () => run(async (signal) => {
        const outputFormat = format, outputName = filename.value;
        sketch.cancel(); callouts.commit(); callouts.syncTips();
        await loadCapture(include.checked, signal, true);
        status.textContent = "Preparing file…";
        const output = renderPrintPage(current, page, printElements, states, context);
        try {
          const outputContext = { ...context, legendImages: new Map(context.legendImages ?? []) };
          const blob = outputFormat === "pdf" ? await exportPdf(output, current, printElements, outputContext, states.title.text || outputName, signal) : await exportPng(output, signal, timing);
          signal.throwIfAborted();
          saveFile(blob, printFilename(outputName, outputFormat, localDate), outputFormat === "pdf" ? "application/pdf" : "image/png");
          status.textContent = "Map exported.";
        } finally { output.canvas.width = output.canvas.height = 0; }
      }, true).catch(() => {}) }, "Export");
    const heading = h("strong", {}, "Print map");
    const dialog = h("div", { class: "print-editor", role: "dialog", ariaModal: "true", ariaLabel: "Print map editor", tabIndex: -1 },
      h("div", { class: "print-editor-bar" }, back, heading, filename, formatPicker, exportButton, close),
      h("div", { class: "print-editor-main" }, stage, controls), status);
    document.body.append(dialog);
    const inert = [...document.body.children].filter((element) => element !== dialog).map((element) => [element, element.inert]);
    inert.forEach(([element]) => { element.inert = true; });
    const focusables = () => [...dialog.querySelectorAll("calcite-button, calcite-action, calcite-input, calcite-input-number, calcite-select, calcite-checkbox, calcite-text-area, calcite-color-picker, .print-text-style, textarea, .print-page, .print-callout-hit, .print-callout-handle")]
      .filter((element) => !element.disabled && !element.closest("[hidden]") && element.offsetParent !== null);
    const focus = (element) => element?.setFocus ? element.setFocus() : element?.focus();
    const keepFocus = (event) => { if (!dialog.contains(event.target)) focus(focusables()[0] ?? dialog); };
    const key = (event) => {
      if (event.key === "Escape") {
        event.preventDefault(); event.stopImmediatePropagation();
        const menu = dialog.querySelector("calcite-dropdown[open], calcite-popover[open]");
        if (sketch.cancel() || callouts.cancel()) return;
        if (menu) menu.open = false; else dispose(true);
      } else if (event.key === "Delete" && callouts.deleteSelected(event)) {
        event.preventDefault();
      } else if (event.key === "Tab") {
        const list = focusables(), index = list.indexOf(document.activeElement);
        event.preventDefault();
        const next = event.shiftKey ? (index <= 0 ? list.length - 1 : index - 1) : (index < 0 || index === list.length - 1 ? 0 : index + 1);
        focus(list[next] ?? dialog);
      }
    };
    window.addEventListener("keydown", key, true); document.addEventListener("focusin", keepFocus);
    const observer = new ResizeObserver(fit); observer.observe(stage);
    focus(back);

    function fit() {
      if (!rendered) return;
      const factor = Math.max(0, Math.min(rendered.pixels.pixelsPerPoint, (stage.clientWidth - 48) / page.width, (stage.clientHeight - 48) / page.height));
      pageHost.style.width = `${page.width * factor}px`; pageHost.style.height = `${page.height * factor}px`;
      callouts.refresh(); sketch.resize();
    }
    function updateControls() {
      dialog.querySelectorAll("calcite-input, calcite-input-number, calcite-select, calcite-checkbox, calcite-text-area, calcite-color-picker, #print-leader-apply-all, #print-add-callout, [id^=print-options-]").forEach((input) => { input.disabled = input !== formatPicker && busy; });
      sketch.setBusy(busy);
      pageHost.classList.toggle("print-page-busy", busy);
      exportButton.loading = exporting;
      const reason = exporting ? "Exporting map…" : !current ? "Waiting for map preview" : busy ? "Capturing map…" : rendered?.layout.overflow.length ? "Page text does not fit" : "";
      exportButton.disabled = !!reason; exportButton.title = reason || "Export map";
      exportButton.setAttribute("aria-label", reason ? `Export: ${reason}` : "Export map");
    }
    function render() {
      if (disposed || !current) return;
      rendered?.canvas.remove();
      if (rendered) rendered.canvas.width = rendered.canvas.height = 0;
      callouts.syncTips(); rendered = timing.sync("layout and canvas draw", () => renderPrintPage(current, page, printElements, states, context));
      rendered.canvas.id = "print-page-preview"; rendered.canvas.setAttribute("aria-label", "Finished print page");
      pageHost.prepend(rendered.canvas); fit();
      const message = detailMessage(rendered.pixels.dpi);
      detail.textContent = [message.label, message.note].filter(Boolean).join(". ");
      notice.hidden = !current.ownerNames;
      const cut = rendered.layout.placements.find((item) => item.id === "legend")?.measurement.cut ?? 0;
      const missing = states.legend.on ? (context.legend ?? []).filter((layer) => !states.legend.excluded.includes(layer.id)).flatMap((layer) => layer.entries).filter((entry) => entry.unavailable).length : 0;
      overflow.textContent = [rendered.layout.overflow.length ? `Doesn't fit on the page: ${rendered.layout.overflow.map((id) => printElements.find((element) => element.id === id).label).join(", ")}. Shorten the text or switch off an element.` : "",
        cut ? `Legend: ${cut} ${cut === 1 ? "entry doesn't" : "entries don't"} fit and will be left out. Exclude layers or switch off other elements to make room.` : "",
        states.legend.on && context.legendStatus !== "ready" ? `Legend unavailable${context.legendStatus === "loading" ? " while it loads" : ""}. You can still export.` : "",
        missing ? `${missing} legend ${missing === 1 ? "symbol is" : "symbols are"} unavailable and marked on the page.` : ""].filter(Boolean).join(" ");
      updateControls();
    }
    function scheduleRender() {
      if (scheduled || disposed) return;
      scheduled = requestAnimationFrame(() => { scheduled = 0; render(); });
    }
    async function loadLegend(combined) {
      legendFields.textContent = "Loading legend…";
      try {
        legend = await timing.step("legend snapshot", (signal) => capturePrintLegend(mapEl, signal, timing), { signal: combined, timeoutMs: PRINT.TIMEOUT_MS.LEGEND,
            fallback: () => ({ layers: [], images: new Map(), unavailable: true, dispose() {} }), onLate: (result) => result.dispose() });
        if (disposed) { legend.dispose(); return; }
        context.legendStatus = legend.unavailable ? "unavailable" : "ready";
        legendFields.replaceChildren();
        context.legend = legend.layers; context.legendImages = legend.images;
        for (const layer of legend.layers) {
          const checkbox = h("calcite-checkbox", { scale: "s", checked: !states.legend.excluded.includes(layer.id),
            oncalciteCheckboxChange: () => {
              states.legend.excluded = states.legend.excluded.filter((id) => id !== layer.id);
              if (!checkbox.checked) states.legend.excluded.push(layer.id);
              scheduleRender();
            } });
          checkbox.dataset.layerId = layer.id;
          legendFields.append(h("calcite-label", { layout: "inline" }, checkbox, layer.title));
        }
        if (legend.unavailable) legendFields.textContent = "Legend unavailable. You can still export.";
        scheduleRender();
      } catch (error) {
        if (combined.aborted || disposed) return;
        context.legendStatus = "unavailable"; legendFields.textContent = "Legend unavailable. You can still export.";
        scheduleRender();
      }
    }
    async function loadCapture(selected, signal, fresh = false) {
      status.textContent = "Capturing map…";
      let image = !fresh && cache.get(selected);
      if (!image) {
        image = await capture(snapshot, page, selected, signal, timing);
        const old = cache.get(selected);
        if (old) old.canvas.width = old.canvas.height = 0;
        cache.set(selected, image);
      }
      signal.throwIfAborted();
      current = image; context.attribution = image.attribution;
      render(); status.textContent = "";
    }
    async function run(task, isExport = false) {
      if (busy || disposed) return;
      busy = true; exporting = isExport; updateControls();
      try {
        return await print.run(async (signal) => {
          try { return await task(AbortSignal.any([signal, abort.signal])); }
          catch (error) { if (!abort.signal.aborted || signal.aborted) throw error; }
        });
      } finally { busy = false; exporting = false; if (!disposed) updateControls(); }
    }
    function dispose(returnToFrame) {
      if (disposed) return;
      disposed = true; abort.abort(); observer.disconnect(); cancelAnimationFrame(scheduled);
      sketch.dispose(); states.sketch.on = false;
      callouts.cancel(); callouts.dispose(); legend?.dispose();
      window.removeEventListener("keydown", key, true); document.removeEventListener("focusin", keepFocus);
      unlock(); inert.forEach(([element, wasInert]) => { element.inert = wasInert; });
      cache.forEach((image) => { image.canvas.width = image.canvas.height = 0; }); cache.clear();
      if (rendered) rendered.canvas.width = rendered.canvas.height = 0;
      dialog.remove(); editor = null;
      if (returnToFrame) print.back(); // the block returns focus once its frame/readout and Continue are ready
      else focus(document.getElementById("print-block"));
    }
    return {
      dispose,
      async initialize(signal) {
        busy = true; updateControls();
        try {
          const combined = AbortSignal.any([signal, abort.signal]);
          // Map and core marginalia draw first. Optional legend work never owns busy/Export.
          await loadCapture(false, combined);
          void loadLegend(combined);
        }
        catch (error) { if (!abort.signal.aborted || signal.aborted) throw error; }
        finally { busy = false; if (!disposed) updateControls(); }
      },
      get state() { return { snapshot, layout: rendered?.layout, pixels: rendered?.pixels, context: { ...context }, capture: current, busy }; },
    };
  }
  return { get state() { return editor?.state ?? null; }, close: () => editor?.dispose(true) };
}
