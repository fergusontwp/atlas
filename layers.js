import { CONFIG, LAYER_LIST } from "./config.js";
import { h } from "./dom.js";
import { layerVisibility, popupOrigins, visibleInMap } from "./popupSelection.js";

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

  // Staff see the friendly name, not the service-style web map title.
  if (parcel) parcel.title = CONFIG.PARCEL_LAYER_LABEL;

  const list = document.createElement("arcgis-layer-list");
  const { watch } = await $arcgis.import("@arcgis/core/core/reactiveUtils.js");
  const selectable = panel.selectable;
  const items = new Set();
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
      item.actionsSections = [[
        { id: "only-selectable", type: "button", title: "Make only selectable layer", icon: active ? "check" : "cursor-click",
          disabled: active || !selectable.eligible(item.layer) || !visibleInMap(item.layer) },
        ...(selectable.only ? [{ id: "reset-selectable", type: "button", title: "Reset selectable layers", icon: "reset" }] : []),
      ]];
    }
    syncBadges();
  }
  list.listItemCreatedFunction = ({ item }) => {
    items.add(item);
    syncItems();
  };
  list.addEventListener("arcgisTriggerAction", ({ detail }) => {
    if (detail.action.id === "only-selectable") selectable.set(detail.item.layer);
    if (detail.action.id === "reset-selectable") selectable.reset();
  });

  // SDK 5.1 renders Calcite list rows with value = layer.uid. Use that identity, never a title or a row index.
  function layerForRow(row) {
    return popupOrigins(map.layers).find((layer) => layer.uid === row?.value);
  }
  function syncBadges() {
    for (const row of list.shadowRoot?.querySelectorAll("calcite-list-item") ?? []) {
      const badge = row.querySelector(":scope > .selectable-badge");
      const active = layerForRow(row) === selectable.only && selectable.only !== null;
      if (!active) badge?.remove();
      else if (!badge) row.append(h("calcite-icon", {
        class: "selectable-badge", slot: "content-end", icon: "cursor-click", scale: "s", title: "Only selectable layer",
      }));
    }
  }
  list.addEventListener("arcgisReady", () => {
    if (list.shadowRoot) new MutationObserver(syncBadges).observe(list.shadowRoot, { childList: true, subtree: true });
    syncBadges();
  });

  const makeOnly = h("calcite-action", { text: "Make only selectable layer", textEnabled: true, icon: "cursor-click" });
  const reset = h("calcite-action", { text: "Reset selectable layers", textEnabled: true, icon: "reset" });
  const menu = h("div", { class: "selectable-menu", role: "menu", hidden: true }, makeOnly, reset);
  makeOnly.setAttribute("role", "menuitem");
  reset.setAttribute("role", "menuitem");
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
    menu.hidden = false;
    const rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(0, Math.min(event.clientX, innerWidth - rect.width))}px`;
    menu.style.top = `${Math.max(0, Math.min(event.clientY, innerHeight - rect.height))}px`;
    (makeOnly.disabled ? reset : makeOnly).setFocus();
  });
  makeOnly.addEventListener("click", () => { selectable.set(contextLayer); dismiss(true); });
  reset.addEventListener("click", () => { selectable.reset(); dismiss(true); });
  document.addEventListener("pointerdown", (event) => { if (!event.composedPath().includes(menu)) dismiss(); }, true);
  menu.addEventListener("keydown", (event) => {
    if (event.key === "Escape" || event.key === "Tab") { dismiss(event.key === "Escape"); event.stopPropagation(); }
    if (event.key === "ArrowDown" && !reset.hidden) { reset.setFocus(); event.preventDefault(); }
    if (event.key === "ArrowUp" && !makeOnly.disabled) { makeOnly.setFocus(); event.preventDefault(); }
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
}
