import { BASEMAPS } from "./config.js";
import { opacityControl } from "./opacityControl.js";
import { h } from "./dom.js";

// Basemap section: a gallery of a curated list (BASEMAPS in config.js): SDK basemaps by id, and public cached map
// services by URL (one TileLayer each, such as PEMA's leaf-off imagery). The web map's own basemap is first (its
// imagery, without its labels), and an empty one ("No basemap", BASEMAPS.NONE_LABEL) last.
// Picking one swaps the basemap only; operational layers, the filter, labels and symbology are untouched.
// At the top of the block, a "Labels (roads and places)" switch: the web map basemap's own reference layers (taken off
// it at startup; BASEMAPS.LABELS.FALLBACK_ID's if it has none) as the current basemap's reference layers, a copy per
// basemap, or none. It carries over to the next basemap and is saved per browser; for a basemap whose labels are in its
// own style (ownLabels) it is disabled and adds nothing, so labels are never doubled. Below it an opacity slider (10%
// steps, reset to BASEMAPS.OPACITY) fades the base layers only, so the labels stay readable; it carries over too.
// The empty basemap's gallery picture: a pale grid.
const NONE_THUMBNAIL = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="133"><rect width="200" height="133" fill="#f7f7f7"/><path d="M0 33H200M0 66H200M0 99H200M50 0V133M100 0V133M150 0V133" stroke="#ddd"/></svg>')}`;
// A service entry without a thumbnail: a muted green-brown field with the same grid, for imagery.
const SERVICE_THUMBNAIL = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="133"><rect width="200" height="133" fill="#8a8f6e"/><path d="M0 33H200M0 66H200M0 99H200M50 0V133M100 0V133M150 0V133" stroke="#a3a787"/></svg>')}`;

export async function setupBasemap(mapEl) {
  const [Basemap, LocalBasemapsSource, TileLayer] = await $arcgis.import([
    "@arcgis/core/Basemap.js",
    "@arcgis/core/widgets/BasemapGallery/support/LocalBasemapsSource.js",
    "@arcgis/core/layers/TileLayer.js",
  ]);

  const { watch } = await $arcgis.import("@arcgis/core/core/reactiveUtils.js");
  // The SDK replaces a basemap's title with its portal item's once it loads; keep the configured label.
  const pinTitle = (basemap, label) => {
    basemap.title = label;
    watch(() => basemap.title, (title) => {
      if (title !== label) basemap.title = label;
    });
  };

  const basemaps = [];
  const L = BASEMAPS.LABELS;
  const original = mapEl.map.basemap;
  // ---- the labels: the web map basemap's reference layers, kept in a holder basemap; each basemap gets its own copies
  // (Basemap.clone deep-clones its layers; layers themselves have no public clone in 5.1)
  const added = new WeakMap(); // basemap -> the label layers this module put on it
  let holder = null;
  if (original?.referenceLayers.length) {
    added.set(original, original.referenceLayers.toArray()); // the map shows them now: they count as added
    holder = original.clone();
  } else {
    holder = Basemap.fromId(L.FALLBACK_ID) ?? null; // its layers are made when it loads (no request for that)
    await holder?.load().catch((err) => console.warn(`BASEMAPS.LABELS: "${L.FALLBACK_ID}" didn't load:`, err));
  }
  holder?.baseLayers.removeAll();
  const sourceCount = holder?.referenceLayers.length ?? 0;
  if (!sourceCount) console.warn(`BASEMAPS.LABELS: the web map's basemap has no labels and "${L.FALLBACK_ID}" gives none; the Labels switch is off.`);
  const labelCopies = () => holder.clone().referenceLayers.toArray();
  if (original) {
    // A clone without its labels, so the web map's basemap can be restored after the map swaps it out.
    const webMapDefault = original.clone();
    webMapDefault.referenceLayers.removeAll();
    pinTitle(webMapDefault, BASEMAPS.DEFAULT_LABEL);
    basemaps.push(webMapDefault);
  }
  const ownLabels = new WeakSet(); // basemaps whose labels are in their own style
  // A service entry: one TileLayer as the only base layer, no reference layer. The configured copyright is the credit
  // in the map's attribution, and so in print exports (both read view.attributionItems); resampling (the SDK default)
  // draws a coarser tile enlarged where the cache has none, rather than a blank.
  const serviceBasemap = ({ label, url, copyright, thumbnail }) => new Basemap({
    id: `basemap-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`, title: label, thumbnailUrl: thumbnail ?? SERVICE_THUMBNAIL,
    baseLayers: [new TileLayer({ url, title: label, copyright: copyright ?? null })],
  });
  for (const entry of BASEMAPS.OPTIONS) {
    const basemap = entry.url ? serviceBasemap(entry) : Basemap.fromId(entry.id);
    if (!basemap) {
      console.warn(`BASEMAPS.OPTIONS: "${entry.id}" isn't a known basemap id`);
      continue;
    }
    pinTitle(basemap, entry.label);
    if (entry.ownLabels) ownLabels.add(basemap);
    basemaps.push(basemap);
  }
  // a service that fails when picked (down, moved, or not in Web Mercator) says which one
  watch(() => mapEl.map.basemap, (bm) => {
    for (const layer of bm?.baseLayers ?? []) if (layer.type === "tile") layer.load().catch((err) => console.warn(`The basemap "${bm.title}" couldn't load:`, err));
  });

  if (BASEMAPS.NONE_LABEL) {
    // no layers: the parcels, plans and graphics on the map's plain background
    const none = new Basemap({ id: "no-basemap", title: BASEMAPS.NONE_LABEL, baseLayers: [], thumbnailUrl: NONE_THUMBNAIL });
    pinTitle(none, BASEMAPS.NONE_LABEL);
    basemaps.push(none);
  }

  // ---- the Labels switch (saved per browser; the app works without storage)
  let labelsOn = L.DEFAULT_ON;
  try {
    const saved = localStorage.getItem(L.STORAGE_KEY);
    if (saved === "on" || saved === "off") labelsOn = saved === "on";
  } catch { /* no storage: the default */ }
  const labelsSwitch = h("calcite-switch", { label: L.TEXT.SWITCH, checked: labelsOn, scale: "s" });
  const labelsRow = h("calcite-label", { id: "basemap-labels", class: "basemap-labels", layout: "inline" }, labelsSwitch, L.TEXT.SWITCH);
  const labelsTip = h("calcite-tooltip", { referenceElement: "basemap-labels", placement: "bottom", hidden: true }, L.TEXT.OWN);
  function applyLabels() {
    const bm = mapEl.map.basemap;
    if (!bm) return;
    const own = ownLabels.has(bm);
    labelsSwitch.disabled = own || !sourceCount;
    labelsTip.hidden = !own;
    const mine = added.get(bm) ?? [];
    const want = labelsOn && !own && sourceCount > 0;
    if (want && !mine.length) {
      const copies = labelCopies();
      bm.referenceLayers.addMany(copies);
      added.set(bm, copies);
    } else if (!want && mine.length) {
      bm.referenceLayers.removeMany(mine);
      added.delete(bm);
    }
  }
  labelsSwitch.addEventListener("calciteSwitchChange", () => {
    labelsOn = labelsSwitch.checked;
    try { localStorage.setItem(L.STORAGE_KEY, labelsOn ? "on" : "off"); } catch { /* not saved */ }
    applyLabels();
  });

  // ---- opacity: the current basemap's base layers (not its labels), kept when the basemap changes
  let opacity = BASEMAPS.OPACITY;
  const apply = () => {
    const bm = mapEl.map.basemap;
    if (!bm) return;
    for (const layer of bm.baseLayers) layer.opacity = opacity;
  };
  const control = opacityControl({ label: "Opacity", value: opacity, initial: BASEMAPS.OPACITY, onInput: (v) => { opacity = v; apply(); } });
  watch(() => mapEl.map.basemap, applyLabels, { initial: true });
  watch(() => [mapEl.map.basemap, mapEl.map.basemap?.baseLayers.length], apply, { initial: true });
  document.getElementById("basemap-host").before(labelsRow, labelsTip, control.el);

  const gallery = document.createElement("arcgis-basemap-gallery");
  gallery.referenceElement = mapEl;
  gallery.source = new LocalBasemapsSource({ basemaps });
  document.getElementById("basemap-host").append(gallery);
  document.getElementById("basemap-block").hidden = false;
  return { gallery, get labels() { return { on: labelsOn, source: sourceCount, disabled: labelsSwitch.disabled, current: mapEl.map.basemap?.referenceLayers.length ?? 0 }; } };
}
