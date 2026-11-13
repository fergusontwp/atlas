// Popup origins in the Layers list's order: reverse each collection, including nested groups and sublayers.
const array = (layers) => layers?.toArray?.() ?? layers ?? [];
export const featureLayer = (graphic) => graphic?.layer ?? graphic?.sourceLayer;

export function popupOrigins(layers) {
  return [...array(layers)].reverse().flatMap((layer) => {
    const children = layer.layers ?? layer.sublayers;
    return children ? popupOrigins(children) : [layer];
  });
}

// Read every ancestor even when a nearer one is off, so reactive watches track the full chain.
export function layerVisibility(layer) {
  const values = [];
  for (let parent = layer; parent; parent = parent.parent) values.push(parent.visible);
  return values;
}

export function visibleInMap(layer) {
  return layerVisibility(layer).every((visible) => visible !== false);
}

// Keep non-queryable overlays and layers without Web Map popup content out of selection.
export function canSelectLayer(layer) {
  return !!layer?.popupTemplate && typeof layer.queryFeatures === "function"
    && layer.capabilities?.operations?.supportsQuery !== false;
}

export function orderPopupFeatures(features, layers) {
  const origins = popupOrigins(layers);
  const rank = new Map(origins.map((layer, index) => [layer, index]));
  return features.filter((graphic) => {
    const layer = featureLayer(graphic);
    return rank.has(layer) && canSelectLayer(layer) && layer.popupEnabled !== false && visibleInMap(layer);
  }).sort((a, b) => rank.get(featureLayer(a)) - rank.get(featureLayer(b)));
}

// fetchPopupFeatures has no include option in SDK 5.1. Temporarily disabling other origins' popups keeps its
// queries scoped to the chosen layer without hiding layers or replacing their templates. Restore exact flags.
export function createSelectableLayers(map, onChange = () => {}) {
  let only = null;
  const saved = new Map();
  const eligible = (layer) => canSelectLayer(layer) && (saved.has(layer) ? saved.get(layer) : layer.popupEnabled) !== false;
  const restore = () => {
    for (const [layer, enabled] of saved) layer.popupEnabled = enabled;
    saved.clear();
  };
  function reset() {
    if (!only) return;
    only = null;
    restore();
    onChange();
  }
  function sync() {
    const origins = popupOrigins(map.layers);
    if (only && (!origins.includes(only) || !visibleInMap(only) || !eligible(only) || only.popupEnabled === false)) {
      reset();
      return;
    }
    if (!only) return;
    for (const layer of origins) {
      if (layer === only || !("popupEnabled" in layer)) continue;
      if (!saved.has(layer)) saved.set(layer, layer.popupEnabled);
      layer.popupEnabled = false;
    }
  }
  function set(layer) {
    if (layer === only || !eligible(layer) || !visibleInMap(layer) || !popupOrigins(map.layers).includes(layer)) return;
    restore();
    only = layer;
    sync();
    onChange();
  }
  return { set, reset, sync, eligible, get only() { return only; } };
}
