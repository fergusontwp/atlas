import { BASEMAPS } from "./config.js";

// Basemap section: a gallery of a curated list (BASEMAPS in config.js). The web map's own basemap is first.
// Picking one swaps the basemap only; operational layers, the filter, labels and symbology are untouched.
export async function setupBasemap(mapEl) {
  const [Basemap, LocalBasemapsSource] = await $arcgis.import([
    "@arcgis/core/Basemap.js",
    "@arcgis/core/widgets/BasemapGallery/support/LocalBasemapsSource.js",
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
  const original = mapEl.map.basemap;
  if (original) {
    // A clone, so the web map's basemap can be restored after the map swaps it out.
    const webMapDefault = original.clone();
    pinTitle(webMapDefault, BASEMAPS.DEFAULT_LABEL);
    basemaps.push(webMapDefault);
  }
  for (const { id, label } of BASEMAPS.OPTIONS) {
    const basemap = Basemap.fromId(id);
    if (!basemap) {
      console.warn(`BASEMAPS.OPTIONS: "${id}" isn't a known basemap id`);
      continue;
    }
    pinTitle(basemap, label);
    basemaps.push(basemap);
  }

  const gallery = document.createElement("arcgis-basemap-gallery");
  gallery.referenceElement = mapEl;
  gallery.source = new LocalBasemapsSource({ basemaps });
  document.getElementById("basemap-host").append(gallery);
  document.getElementById("basemap-block").hidden = false;
  return { gallery };
}
