import { CONFIG } from "./config.js";
import { setupAuth } from "./auth.js";
import { setStatus, fillInventory, disableSymbology, signedInUser } from "./ui.js";
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
import { setupSelectionOutline } from "./selectionOutline.js";
import { setupHighlightColor } from "./highlightColor.js";
import { setupPointInfo } from "./pointInfo.js";
import { setupRoadSearch } from "./roadSearch.js";
import { setupLocationSearch } from "./locationSearch.js";
import { setupNotesLayer } from "./notesLayer.js";
import { setupNotes } from "./notes.js";
import { setupAttributeTable } from "./attributeTable.js";
import { setupFollowups } from "./followups.js";
import { setupTheme } from "./theme.js";
import { portalUserForMenu, setupUserMenu } from "./userMenu.js";
import { setupSignOut } from "./signOut.js";
import { setupAbout } from "./about.js";

function withTimeout(promise, ms, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
  ]);
}

// Light, Dark or Match system (section 59): first, so everything below is built in the right mode
const theme = setupTheme();
// The header's user button and menu (section 59), set up now so its Esc listener comes before the app's own
const userMenu = setupUserMenu({ theme });
setupAbout({ menu: userMenu });

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

  // the signed-in user in the header's button (its full name and picture from the portal; the username until then)
  if (signedInUser(esriId)) {
    userMenu.setUser({ username: signedInUser(esriId) });
    portalUserForMenu().then((u) => { if (u) userMenu.setUser(u); });
  }

  setupMapControls(mapEl);
  const panel = await setupParcelPanel(mapEl, parcel);
  const actions = setupParcelActions(panel);
  const layerList = await setupLayerList(mapEl, parcel, panel);
  if (parcel) await setupStyles(mapEl, parcel);
  else disableSymbology();
  const labels = parcel ? await setupLabels(mapEl, parcel, panel) : undefined;
  const filter = parcel
    ? await setupFilter(mapEl, parcel, { clearSelection: panel.close, selectedObjectId: panel.selectedObjectId })
    : undefined;
  const search = parcel ? await setupSearch(mapEl, parcel, panel) : undefined;
  let outline; // the selection is always an outline (selectionOutline.js), never the SDK's fill highlight
  const here = parcel ? await setupWhatsHere(mapEl, parcel, panel, actions) : undefined;
  const plansLayer = setupPlansLayer();
  const plans = parcel ? setupPlansBlock(parcel, panel, actions, plansLayer, mapEl) : undefined;
  const measure = await setupMeasure(mapEl, panel, { parcel, outline: () => outline, roadLayer: () => roadSearch?.road ?? null, obstacles: () => labels?.edges?.layer ?? null });
  const print = await setupPrintBlock(mapEl);
  const printEditor = setupPrintEditor({ mapEl, panel, print, measure, parcel });
  await setupBasemap(mapEl);
  const georef = parcel ? setupWorkspace({ mapEl, parcel, panel, plans: plansLayer, plansBlock: plans, measure, print }) : undefined;
  if (parcel) outline = await setupSelectionOutline({ mapEl, parcel, panel });
  setupHighlightColor();
  // "What's here?" on a right-click (after the panel, whose map-click suspension it follows)
  const pointInfo = await setupPointInfo({ mapEl, parcel, panel, filter });
  const roadSearch = search ? await setupRoadSearch({ mapEl, search, pointInfo }) : null;
  const locationSearch = search ? await setupLocationSearch({ mapEl, search, parcel, pointInfo }) : null;
  // Notes for any selected feature (after Road search, whose road layer the roads source uses when its title isn't set)
  const notesLayer = setupNotesLayer();
  const notes = setupNotes({ mapEl, panel, actions, notesLayer, roadLayer: roadSearch?.road ?? null, pointInfo, user: () => signedInUser(esriId) });
  // The follow-ups assigned to you (contact log, section 51): a header count and the Follow-ups block
  const followups = setupFollowups({ notesLayer, notes, user: () => signedInUser(esriId), openParcel: search ? (id) => search.openParcel(id) : null });
  // Sign out in the user menu (section 59), only when someone can be signed in
  if (signedInUser(esriId)) setupSignOut({ menu: userMenu, esriId, notes, followups });
  setupSidebar();
  // The attribute table under the map (section 50): "Open table" in the Layers list. Edits made through the Notes and
  // Plans layers (their own layer objects) also refresh a tab of the same service.
  const table = await setupAttributeTable({ mapEl, panel, parcel, layerList, extraLayers: () => [plansLayer.state?.layer, notesLayer.state?.layer].filter(Boolean) });

  // Handy for poking around in the browser console.
  window.viewer = { theme, userMenu, mapEl, map, parcel, filter, labels, search, here, measure, georef, print, printEditor, plans: plansLayer, pointInfo, roadSearch, locationSearch, notes, followups, table, get outline() { return outline; } };

  // ?entry=<GlobalID> opens that Notes entry (section 57, the follow-up email's link): its parcel selected and the
  // dialog scrolled to it. It wins over ?parcel=, which otherwise opens that parcel (after the style and everything else
  // are set up).
  const linked = await notes.openFromUrl({ openParcel: search ? (id) => search.openParcel(id) : null });
  if (!linked) await search?.openFromUrl();
}

main().catch((err) => {
  console.error(err);
  setStatus("danger", "Couldn't load the map", err.message ?? String(err));
});
