import { printTiming } from "./printTiming.js";
import { PRINT } from "./config.js";
import { captureSize } from "./printDetail.js";
import { flattenOnWhite } from "./printImage.js";
import { ownerNamesVisible, withPrintExclusions } from "./printContent.js";
import { waitPrintRender } from "./printCaptureWait.js";

export function createPrintCapture({ mapEl, panel, measure, parcel }) {
  return async function capture(snapshot, page, includeSelected = false, signal, timing = printTiming()) {
    const view = mapEl.view;
    signal?.throwIfAborted();
    const [reactive] = await timing.step("capture SDK ready", () => $arcgis.import(["@arcgis/core/core/reactiveUtils.js"]), { signal, timeoutMs: PRINT.TIMEOUT_MS.READY });
    await timing.step("capture view idle", (signal) => reactive.whenOnce(() => view.stationary && !view.updating, { signal }), { signal, timeoutMs: PRINT.TIMEOUT_MS.CAPTURE });
    const sizing = captureSize(view, snapshot.frame, page);
    const selection = panel && { highlightOff: panel.highlightOff, setHighlightOff: (off) => timing.step(off ? "hide selection" : "restore selection", () => panel.setHighlightOff(off), { timeoutMs: PRINT.TIMEOUT_MS.READY }) };
    const screenshot = await withPrintExclusions({ panel: selection, outline: mapEl.map.findLayerById("selection-outline"),
      hideMeasurements: () => timing.step("hide measurements", () => measure?.hideForPrint(), { signal, timeoutMs: PRINT.TIMEOUT_MS.READY, onLate: (restore) => restore?.() }) }, includeSelected, async () => {
      signal?.throwIfAborted();
      await timing.step("capture visibility settle", (signal) => waitPrintRender({ idle: () => view.stationary && !view.updating, now: () => performance.now(), signal,
        nextFrame: (signal) => new Promise((resolve, reject) => {
          const cancel = () => { cancelAnimationFrame(id); reject(signal.reason); };
          const id = requestAnimationFrame(() => { signal?.removeEventListener("abort", cancel); resolve(); });
          signal?.addEventListener("abort", cancel, { once: true });
        }),
      }), { signal, timeoutMs: PRINT.TIMEOUT_MS.CAPTURE });
      if (JSON.stringify(view.viewpoint.toJSON()) !== JSON.stringify(snapshot.viewpoint)) throw new Error("The framed map changed. Go Back and frame it again.");
      return timing.step("map screenshot", () => view.takeScreenshot({ area: sizing.area, width: sizing.width, height: sizing.height, ignorePadding: true, format: "png" }), { signal, timeoutMs: PRINT.TIMEOUT_MS.CAPTURE });
    });
    signal?.throwIfAborted();
    if (screenshot.data.width !== sizing.width || screenshot.data.height !== sizing.height) throw new Error("The map capture returned an unexpected size.");
    const canvas = document.createElement("canvas"); canvas.width = sizing.width; canvas.height = sizing.height;
    canvas.getContext("2d").putImageData(new ImageData(flattenOnWhite(screenshot.data.data), canvas.width, canvas.height), 0, 0);
    const attribution = timing.sync("attribution", () => [...new Set((view.attributionItems ?? []).map(({ text }) =>
      new DOMParser().parseFromString(text, "text/html").body.textContent.trim()).filter(Boolean))].join("; "));
    let visible = !!parcel?.visible;
    for (let parent = parcel?.parent; parent?.type === "group"; parent = parent.parent) visible &&= parent.visible;
    const ownerNames = ownerNamesVisible(parcel && { visible, labelsVisible: parcel.labelsVisible, minScale: parcel.minScale,
      maxScale: parcel.maxScale, labelingInfo: parcel.labelingInfo }, view.scale, PRINT.OWNER_NAME_FIELDS);
    return { canvas, sizing, attribution, ownerNames };
  };
}
