import { PLANS } from "./config.js";
import { setStatus } from "./ui.js";

// The hosted Plans layer. It is NOT in the web map: it is loaded by item ID the first time it is needed (a parcel
// selected, or the Plans block opened) and used only for queries, edits and attachments, so it never shows in the Layers
// list, the legend or What's in this parcel. While PLANS.ITEM_ID is still the placeholder the Plans features are off:
// one console warning, no errors, everything else works. A layer that is configured but fails to load gets one status
// notice with the service's message and is treated the same way.
//
// state: { status: "unconfigured" | "idle" | "loading" | "ready" | "error", layer, message, canAdd, whyNot }
//   canAdd / whyNot: whether this user can add plans (editing allowed, adding allowed, attachments on), and why not.
const isPlaceholder = (id) => !id || /^PLANS_LAYER/.test(id);

export function setupPlansLayer() {
  const state = { status: isPlaceholder(PLANS.ITEM_ID) ? "unconfigured" : "idle", layer: null, message: "", canAdd: false, whyNot: "", version: 0 };
  const listeners = new Set();
  const set = (patch) => {
    Object.assign(state, patch);
    listeners.forEach((cb) => cb(state));
  };
  let loading = null;

  if (state.status === "unconfigured") {
    console.warn("PLANS.ITEM_ID is still the placeholder, so the Plans features are off. Set it in config.js to the hosted Plans layer's item ID.");
  }

  async function load() {
    set({ status: "loading", message: "" });
    let layer;
    try {
      const FeatureLayer = await $arcgis.import("@arcgis/core/layers/FeatureLayer.js");
      layer = new FeatureLayer({ portalItem: { id: PLANS.ITEM_ID }, layerId: PLANS.LAYER_INDEX });
      await layer.load();
      if (layer.geometryType !== "polygon") throw new Error(`The Plans layer has ${layer.geometryType} geometry; polygons are needed.`);
      const missing = Object.values(PLANS.FIELDS).filter((name) => !layer.fieldsIndex.has(name));
      if (missing.length) throw new Error(`The Plans layer is missing fields: ${missing.join(", ")}.`);
      const ops = (layer.effectiveCapabilities ?? layer.capabilities)?.operations;
      let whyNot = "";
      if (!layer.capabilities?.data?.supportsAttachment) whyNot = "Attachments aren't enabled on the Plans layer.";
      else if (ops?.supportsAdd === false || layer.effectiveEditingEnabled === false) whyNot = "Your account can't add features to the Plans layer.";
      set({ status: "ready", layer, canAdd: !whyNot, whyNot });
    } catch (err) {
      // A wrong item ID or no access is reported by the portal item; the layer itself only says it has no url.
      const message = layer?.portalItem?.loadError?.message ?? err?.message ?? String(err);
      console.warn("Couldn't load the Plans layer:", err);
      setStatus("warning", "Plans layer unavailable", message);
      set({ status: "error", message, layer: null, canAdd: false });
    }
    return state;
  }

  return {
    state,
    // Load the layer if it is configured and not loaded yet. Resolves to the state either way.
    ensure() {
      if (state.status !== "idle") return Promise.resolve(state);
      return (loading ??= load());
    },
    onChange: (cb) => listeners.add(cb),
    // Something was saved or changed: lists of plans should read the layer again.
    bump() { set({ version: state.version + 1 }); },
  };
}
