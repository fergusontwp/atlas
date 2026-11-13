import { CONFIG, LAYER_LIST, TABLE } from "./config.js";
import { h } from "./dom.js";
import { applySaved, recordUserChanges, sanitizeSaved, visibilityOf } from "./layerMemory.js";
import { layerVisibility, popupOrigins, visibleInMap } from "./popupSelection.js";
import { toast } from "./toast.js";

// The web map's layers the user can switch in the Layers list, as a tree for layerMemory.js: list-hidden layers,
// graphics layers and the children of a "hide-children" layer are left out. A key is the layer's id in the web map
// (its operational layer id), never its title; a map image sublayer's is "<layer id>/<sublayer id>" (sublayer ids are
// only unique inside their layer). Built once at startup, so layers the app adds later (plans, the workspaces' layers,
// graphics) are never in it. targets: key -> the layer or sublayer.
function rememberedLayers(map) {
  const targets = new Map();
  const node = (key, target, children) => { targets.set(key, target); return { key, visible: !!target.visible, children }; };
  const subs = (layer, sublayers) => (sublayers?.toArray?.() ?? []).filter((s) => s.listMode !== "hide")
    .map((s) => node(`${layer.id}/${s.id}`, s, s.listMode === "hide-children" ? [] : subs(layer, s.sublayers)));
  const walk = (layers) => layers.filter((l) => l.listMode !== "hide" && l.type !== "graphics").map((l) => node(l.id, l,
    l.listMode === "hide-children" ? [] : l.type === "group" ? walk(l.layers.toArray()) : l.type === "map-image" ? subs(l, l.sublayers) : []));
  return { tree: walk(map.layers.toArray()), targets };
}

// Layers section: a checkbox list of the web map's layers (tables aren't listed by this component).
export async function setupLayerList(mapEl, parcel, panel) {
  const map = mapEl.map;

  function forTitles(titles, key, apply) {
    for (const title of titles) {
      const matches = map.allLayers.filter((l) => l.title === title);
      if (matches.length === 0) console.warn(`LAYER_LIST.${key}: no layer titled "${title}"`);
      matches.forEach(apply);
    }
  }
  forTitles(LAYER_LIST.HIDE, "HIDE", (l) => (l.listMode = "hide"));
  forTitles(LAYER_LIST.OFF, "OFF", (l) => (l.visible = false));

  // ---- remembered visibility (section 53). The defaults are the web map's with OFF applied; the user's saved choices
  // are applied over them; keys for layers no longer in the map drop out of the saved value quietly.
  const remembered = rememberedLayers(map);
  const defaults = visibilityOf(remembered.tree);
  const readStored = () => { try { return localStorage.getItem(LAYER_LIST.STORAGE_KEY); } catch { return null; } };
  const writeSaved = (value) => {
    try {
      if (Object.keys(value).length) localStorage.setItem(LAYER_LIST.STORAGE_KEY, JSON.stringify(value));
      else localStorage.removeItem(LAYER_LIST.STORAGE_KEY);
    } catch { /* not remembered: this visit only */ }
  };
  const stored = readStored();
  const startup = applySaved(sanitizeSaved(stored), remembered.tree);
  for (const [key, visible] of Object.entries(startup.apply)) remembered.targets.get(key).visible = visible;
  let saved = startup.kept;
  if (stored !== null && stored !== JSON.stringify(saved)) writeSaved(saved); // dropped keys or a bad value: clean it
  const snapshot = () => Object.fromEntries([...remembered.targets].map(([key, target]) => [key, !!target.visible]));

  // Staff see the friendly name, not the service-style web map title.
  if (parcel) parcel.title = CONFIG.PARCEL_LAYER_LABEL;

  const list = document.createElement("arcgis-layer-list");
  const { watch } = await $arcgis.import("@arcgis/core/core/reactiveUtils.js");
  const selectable = panel.selectable;
  const items = new Set();
  let table = null; // { open(layer), eligible(layer) } from attributeTable.js (setOpenTable), once it is set up
  const resetChip = h("calcite-chip", { class: "selectable-reset", scale: "s", closable: true, hidden: true });
  resetChip.title = "Reset selectable layers";
  resetChip.addEventListener("calciteChipClose", () => selectable.reset());
  // A direct child of the panel: content-top stays visible while the sidebar scrolls or Layers is collapsed.
  document.getElementById("layers-block").before(resetChip);

  function syncItems() {
    resetChip.closed = false; // Calcite closes the chip itself; allow a later restriction to show it again
    resetChip.hidden = !selectable.only;
    if (selectable.only) resetChip.slot = "content-top";
    else resetChip.removeAttribute("slot"); // avoid reserving an empty band when no restriction is active
    resetChip.textContent = selectable.only ? `Selecting only: ${selectable.only.title}` : "";
    for (const item of items) {
      const active = item.layer === selectable.only;
      // One SDK action per row, so the SDK shows it as an icon (with two or more it folds them into a "..." menu).
      // Reset is on the "Selecting only" chip and in the right-click menu; Open table is the row's own icon (syncRows).
      item.actionsSections = [[
        { id: "only-selectable", type: "button", title: "Make only selectable layer", icon: active ? "check" : "cursor-click",
          disabled: active || !selectable.eligible(item.layer) || !visibleInMap(item.layer) },
      ]];
    }
    syncRows();
  }
  list.listItemCreatedFunction = ({ item }) => {
    items.add(item);
    syncItems();
  };
  // Only the user's switching in the list is saved. arcgis-layer-list has no visibility event, so a click or Enter on a
  // row (its checkbox, a group's checkbox, or the row itself) takes a snapshot first (capture phase, before the SDK's
  // handler) and compares once the SDK has switched the layers (USER_CHANGE_MS). Every other change (Print capture and
  // framing, the workspaces, plans, the table, the selectable reset) happens outside the list and is never compared.
  // Our own row actions (Open table, Make only selectable) never switch a layer and are skipped.
  let before = null, settle = 0;
  function userGesture(event) {
    if (event.type === "keydown" && event.key !== "Enter" && event.key !== " ") return;
    const path = event.composedPath();
    if (!path.some((el) => el?.tagName === "CALCITE-LIST-ITEM")) return;
    if (path.some((el) => el?.tagName === "CALCITE-ACTION" && (el.classList.contains("open-table-action") || el.hasAttribute("data-action-id")))) return;
    before ??= snapshot();
    clearTimeout(settle);
    settle = setTimeout(() => {
      const next = recordUserChanges(saved, before, snapshot(), defaults);
      before = null;
      if (JSON.stringify(next) === JSON.stringify(saved)) return;
      saved = next;
      writeSaved(saved);
      syncResetLayers();
    }, LAYER_LIST.USER_CHANGE_MS);
  }
  list.addEventListener("click", userGesture, true);
  list.addEventListener("keydown", userGesture, true);
  // Reset: every remembered layer back to its default, and nothing saved
  const resetLayersAction = h("calcite-action", { slot: "actions-end", icon: "reset", text: LAYER_LIST.TEXT.RESET, scale: "s", class: "reset-layers", hidden: true });
  resetLayersAction.title = LAYER_LIST.TEXT.RESET;
  document.getElementById("layers-block").append(resetLayersAction);
  function resetLayers() {
    clearTimeout(settle);
    before = null;
    for (const [key, visible] of Object.entries(defaults)) remembered.targets.get(key).visible = visible;
    saved = {};
    writeSaved(saved);
    syncResetLayers();
    toast(LAYER_LIST.TEXT.RESET_DONE, "", { kind: "success", duration: "fast" });
  }
  resetLayersAction.addEventListener("click", (event) => { event.stopPropagation(); resetLayers(); });

  list.addEventListener("arcgisTriggerAction", ({ detail }) => {
    if (detail.action.id === "only-selectable") selectable.set(detail.item.layer);
  });

  // SDK 5.1 renders Calcite list rows with value = layer.uid. Use that identity, never a title or a row index.
  function layerForRow(row) {
    return popupOrigins(map.layers).find((layer) => layer.uid === row?.value);
  }
  // The rows the SDK renders get two extras of ours: the "only selectable" badge, and the "Open table" icon (any layer
  // with a pop-up and queries, switched on or off, whatever the selectable restriction) just left of the SDK's
  // "Make only selectable layer" icon. Re-applied whenever the SDK re-renders a row; each change is made only when
  // needed, so the observer settles.
  function syncRows() {
    for (const row of list.shadowRoot?.querySelectorAll("calcite-list-item") ?? []) {
      const layer = layerForRow(row);
      const badge = row.querySelector(":scope > .selectable-badge");
      const active = layer === selectable.only && selectable.only !== null;
      if (!active) badge?.remove();
      else if (!badge) row.append(h("calcite-icon", {
        class: "selectable-badge", slot: "content-end", icon: "cursor-click", scale: "s", title: "Only selectable layer",
      }));
      let tableAction = row.querySelector(":scope > .open-table-action");
      if (!table?.eligible(layer)) { tableAction?.remove(); continue; }
      if (!tableAction) {
        tableAction = h("calcite-action", {
          class: "open-table-action", slot: "actions-end", appearance: "transparent", scale: "m", icon: "table", text: TABLE.TEXT.OPEN,
        });
        tableAction.title = TABLE.TEXT.OPEN;
        tableAction.addEventListener("click", (event) => {
          event.stopPropagation(); // not a row click
          table?.open(layerForRow(tableAction.parentElement));
        });
      }
      const sdkAction = row.querySelector(':scope > [slot="actions-end"]:not(.open-table-action)');
      if (sdkAction ? tableAction.nextElementSibling !== sdkAction : tableAction.parentElement !== row) row.insertBefore(tableAction, sdkAction);
    }
  }
  list.addEventListener("arcgisReady", () => {
    if (list.shadowRoot) new MutationObserver(syncRows).observe(list.shadowRoot, { childList: true, subtree: true });
    syncRows();
  });

  const makeOnly = h("calcite-action", { text: "Make only selectable layer", textEnabled: true, icon: "cursor-click" });
  const reset = h("calcite-action", { text: "Reset selectable layers", textEnabled: true, icon: "reset" });
  const openTable = h("calcite-action", { text: TABLE.TEXT.OPEN, textEnabled: true, icon: "table", hidden: true });
  const resetLayersItem = h("calcite-action", { text: LAYER_LIST.TEXT.RESET, textEnabled: true, icon: "layers", hidden: true });
  const menu = h("div", { class: "selectable-menu", role: "menu", hidden: true }, makeOnly, reset, openTable, resetLayersItem);
  for (const item of [makeOnly, reset, openTable, resetLayersItem]) item.setAttribute("role", "menuitem");
  function syncResetLayers() {
    const any = Object.keys(saved).length > 0;
    resetLayersAction.hidden = !any;
    resetLayersItem.hidden = !any;
  }
  syncResetLayers();
  document.getElementById("layer-list-host").append(menu);
  let contextLayer;
  let contextRow;
  const dismiss = (focus = false) => {
    menu.hidden = true;
    if (focus) contextRow?.setFocus?.();
  };
  list.addEventListener("contextmenu", (event) => {
    const row = event.composedPath().find((el) => el?.tagName === "CALCITE-LIST-ITEM");
    if (!row) return;
    event.preventDefault();
    contextRow = row;
    contextLayer = layerForRow(row);
    makeOnly.disabled = !selectable.eligible(contextLayer) || !visibleInMap(contextLayer);
    reset.hidden = !selectable.only;
    openTable.hidden = !table?.eligible(contextLayer);
    menu.hidden = false;
    const rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(0, Math.min(event.clientX, innerWidth - rect.width))}px`;
    menu.style.top = `${Math.max(0, Math.min(event.clientY, innerHeight - rect.height))}px`;
    (!makeOnly.disabled ? makeOnly : !reset.hidden ? reset : !openTable.hidden ? openTable : !resetLayersItem.hidden ? resetLayersItem : makeOnly).setFocus();
  });
  makeOnly.addEventListener("click", () => { selectable.set(contextLayer); dismiss(true); });
  reset.addEventListener("click", () => { selectable.reset(); dismiss(true); });
  openTable.addEventListener("click", () => { dismiss(false); table?.open(contextLayer); });
  resetLayersItem.addEventListener("click", () => { dismiss(true); resetLayers(); });
  document.addEventListener("pointerdown", (event) => { if (!event.composedPath().includes(menu)) dismiss(); }, true);
  menu.addEventListener("keydown", (event) => {
    if (event.key === "Escape" || event.key === "Tab") { dismiss(event.key === "Escape"); event.stopPropagation(); }
    // up and down move through the enabled items
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const list = [makeOnly, reset, openTable, resetLayersItem].filter((a) => !a.hidden && !a.disabled);
      const at = list.findIndex((a) => a === event.target || a.contains(event.target));
      const next = list[at + (event.key === "ArrowDown" ? 1 : -1)];
      if (next) next.setFocus();
      event.preventDefault();
    }
  });
  document.addEventListener("scroll", () => dismiss(), true);
  window.addEventListener("resize", () => dismiss());
  panel.onSelectableChange(syncItems);
  // syncItems reads ancestor visibility outside the reactive expression; track those inputs here too.
  watch(() => popupOrigins(map.layers).flatMap((layer) =>
    [layer, layer.title, layer.popupEnabled, layer.popupTemplate, ...layerVisibility(layer)]), syncItems);
  map.allLayers.on("change", syncItems);
  list.referenceElement = mapEl;
  list.visibilityAppearance = "checkbox";
  document.getElementById("layer-list-host").append(list);
  document.getElementById("layers-block").hidden = false;

  // arcgis-layer-list has no visibility event, so watch the layer directly.
  // A hidden parcel layer can't be selected, so drop the selection and close the panel.
  if (parcel) {
    watch(
      () => parcel.visible,
      (visible) => {
        if (!visible && panel.selectedObjectId() !== null) panel.close();
      },
    );
  }

  return {
    // the attribute table's "Open table" row icon and menu item (attributeTable.js calls this once it is set up)
    setOpenTable(handler) { table = handler; syncItems(); },
  };
}
