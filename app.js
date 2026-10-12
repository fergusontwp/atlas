import { CONFIG, HIGHLIGHT } from "./config.js";
import { setupAuth } from "./auth.js";
import { setStatus, fillInventory, showUser, disableSymbology } from "./ui.js";
import { setupMapControls } from "./controls.js";
import { setupParcelPanel } from "./panel.js";
import { setupParcelActions } from "./parcelActions.js";
import { setupLayerList } from "./layers.js";
import { setupStyles } from "./styles.js";
import { setupLabels } from "./labels.js";
import { setupFilter } from "./filter.js";
import { setupSearch } from "./search.js";
import { setupWhatsHere } from "./whatsHere.js";
import { setupPlansLayer } from "./plansLayer.js";
import { setupPlansBlock } from "./plansBlock.js";
import { setupWorkspace } from "./workspace.js";
import { setupMeasure } from "./measure.js";
import { setupPrintBlock } from "./printBlock.js";
import { setupPrintEditor } from "./printEditor.js";
import { setupBasemap } from "./basemap.js";
import { setupSidebar } from "./sidebar.js";
import { createReasons } from "./selectionMode.js";
import { setupSelectionOutline } from "./selectionOutline.js";

function withTimeout(promise, ms, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
  ]);
}

async function main() {
  if (CONFIG.WEBMAP_ITEM_ID.startsWith("PASTE")) {
    setStatus("warning", "No web map set", "Add your web map item ID to config.js, then reload.");
    return;
  }

  await customElements.whenDefined("arcgis-map");
  const esriId = await setupAuth();

  // Create the map component here so auth is registered before the map loads.
  const mapEl = document.createElement("arcgis-map");
  mapEl.itemId = CONFIG.WEBMAP_ITEM_ID;
  mapEl.popupDisabled = true;
  // Set before the map mounts. Adding highlight options to a live view intermittently
  // throws inside the SDK's 2D worker (setHighlight), so replace the defaults up front.
  mapEl.highlights = [{ name: "default", ...HIGHLIGHT }];
  document.getElementById("map-host").append(mapEl);

  await withTimeout(
    mapEl.viewOnReady(),
    CONFIG.READY_TIMEOUT_MS,
    "The map didn't become ready. Check the item ID and that the map is shared with you.",
  );

  const map = mapEl.map;
  const mapTitle = map.portalItem?.title ?? "Untitled web map";

  const layers = map.allLayers.toArray();
  const tables = map.tables?.toArray() ?? [];
  await Promise.allSettled([...layers, ...tables].map((l) => l.load()));

  const parcel = layers.find((l) => l.title === CONFIG.PARCEL_LAYER_TITLE);
  fillInventory(
    layers,
    tables,
    `"${mapTitle}": ${layers.length} layers, ${tables.length} tables. Parcel layer ${parcel ? "found" : "NOT found"}.`,
  );
  if (!parcel) {
    setStatus(
      "warning",
      "Parcel layer not found",
      `Loaded "${mapTitle}", but no layer is titled "${CONFIG.PARCEL_LAYER_TITLE}". Check PARCEL_LAYER_TITLE in config.js. Open the app with ?debug=1 to list every layer title.`,
    );
  }

  showUser(esriId?.credentials?.[0]?.userId);

  setupMapControls(mapEl);
  const panel = await setupParcelPanel(mapEl, parcel);
  const actions = setupParcelActions(panel);
  await setupLayerList(mapEl, parcel, panel);
  if (parcel) await setupStyles(mapEl, parcel);
  else disableSymbology();
  const labels = parcel ? await setupLabels(mapEl, parcel, panel) : undefined;
  const filter = parcel
    ? await setupFilter(mapEl, parcel, { clearSelection: panel.close, selectedObjectId: panel.selectedObjectId })
    : undefined;
  const search = parcel ? await setupSearch(mapEl, parcel, panel) : undefined;
  // The selection is an outline, not a fill, while What's in this parcel, Plans, the workspace or a shown plan is in use.
  let outline;
  const reasons = createReasons(() => outline?.update());
  for (const [id, reason] of [["here-block", "whatsHere"], ["plans-block", "plans"]]) {
    const block = document.getElementById(id);
    block.addEventListener("calciteBlockExpand", (e) => e.target === block && reasons.set(reason, true));
    block.addEventListener("calciteBlockCollapse", (e) => e.target === block && reasons.set(reason, false));
  }
  const here = parcel ? await setupWhatsHere(mapEl, parcel, panel, actions) : undefined;
  const plansLayer = setupPlansLayer();
  const plans = parcel ? setupPlansBlock(parcel, panel, actions, plansLayer, mapEl, reasons) : undefined;
  const measure = await setupMeasure(mapEl, panel);
  const print = await setupPrintBlock(mapEl);
  const printEditor = setupPrintEditor({ mapEl, panel, print, measure, parcel });
  await setupBasemap(mapEl);
  const georef = parcel ? setupWorkspace({ mapEl, parcel, panel, plans: plansLayer, plansBlock: plans, measure, print, reasons }) : undefined;
  if (parcel) outline = await setupSelectionOutline({ mapEl, parcel, panel, reasons });
  setupSidebar();

  // Handy for poking around in the browser console.
  window.viewer = { mapEl, map, parcel, filter, labels, search, here, georef, print, printEditor, plans: plansLayer, reasons, get outline() { return outline; } };

  // ?parcel=<id> opens that parcel (after the style and everything else are set up).
  await search?.openFromUrl();
}

main().catch((err) => {
  console.error(err);
  setStatus("danger", "Couldn't load the map", err.message ?? String(err));
});
