import { NOTES } from "./config.js";
import { checkNotesLayer } from "./notesLogic.js";
import { checkContactFields } from "./contactLogic.js";
import { createLayerNotesStore } from "./notesStore.js";
import { setStatus } from "./ui.js";

// The hosted notes layer, the same pattern as the Plans layer (plansLayer.js). It is NOT in the web map: it is loaded by
// item ID the first time a feature is selected and used only for queries and edits, so it never shows in the Layers
// list, the legend or What's in this parcel. While NOTES.ITEM_ID is still the placeholder the Notes button is hidden:
// one console warning, nothing else. A layer that fails to load, or fails the field check (a missing field, editor
// tracking off), gets one console warning and one status notice naming the problem, and Notes stays off.
//
// state: { status: "off" | "unconfigured" | "idle" | "loading" | "ready" | "error", layer, store, message, edit, lengths,
//          canAdd, canUpdate, whyNot, urlField }
//   urlField: the layer has the optional note_url field (NOTES.FIELDS.URL); without it notes have no link input, with
//   one console warning, and everything else works.
//   activity: the layer has the activity log's four fields (NOTES.ACTIVITY_FIELDS); without them a source's field
//   changes are off and its notes are plain notes: one console warning, and one status notice when a source has
//   `activity` configured.
//   contact: the layer has the contact log's fields (NOTES.FIELDS.CONTACT, with coded-value domains on method, customer
//   type and permit), so sources in NOTES.CONTACT.SOURCES offer Log contact; followups: it also has the FOLLOWUP fields
//   and a GlobalID (globalIdField). contactDomains: { method, customerType, permit }, read with getFieldDomain on every
//   load (Jackson edits them in AGOL). Without them: one console warning (and one status notice for contacts).
//   attachments: the layer supports attachments (capabilities.data.supportsAttachment), so entries can carry files
//   (section 55); without: no file controls, one console warning, everything else works.
//   canAdd: the signed-in user can add notes (the layer allows editing for them and supports adding); whyNot says why
//   not. canUpdate: they can update (Retract). Viewers can only read. Never guessed from the role name.
const isPlaceholder = (id) => !id || /^NOTES_LAYER/.test(id);

// The contact log's check (contactLogic.checkContactFields) with the layer's domains read now; its warnings logged, and
// one status notice when Log contact is off for a source that offers it.
export function contactCheck(layer) {
  const C = NOTES.FIELDS.CONTACT;
  const domains = Object.fromEntries([C.METHOD, C.CUSTOMER_TYPE, C.PERMIT].map((name) => [name, layer.getFieldDomain?.(name) ?? null]));
  const c = checkContactFields({ fields: layer.fields ?? [], globalIdField: layer.globalIdField, domains });
  c.warnings.forEach((w) => console.warn(w));
  c.infos?.forEach((m) => console.info(m));
  if (!c.contact && NOTES.CONTACT.SOURCES.length) setStatus("warning", NOTES.TEXT.LAYER_UNAVAILABLE, NOTES.CONTACT.TEXT.CONTACT_OFF);
  return c;
}

// Whether entries can carry files (section 55): the layer supports attachments (capabilities.data.supportsAttachment).
// Without: one console warning; the file controls stay hidden and everything else works.
export function attachmentCheck(layer) {
  const ok = !!layer?.capabilities?.data?.supportsAttachment;
  if (!ok) console.warn("The notes layer doesn't support attachments, so entries can't have files. Enable attachments on the layer in ArcGIS Online to add them.");
  return ok;
}

export function setupNotesLayer() {
  const initial = !NOTES.ENABLED ? "off" : isPlaceholder(NOTES.ITEM_ID) ? "unconfigured" : "idle";
  const state = { status: initial, layer: null, store: null, message: "", edit: null, lengths: {}, canAdd: false, canUpdate: false, whyNot: "", urlField: false, activity: false, contact: false, followups: false, followupEmail: false, globalIdField: null, contactDomains: {}, attachments: false };
  const listeners = new Set();
  const set = (patch) => {
    Object.assign(state, patch);
    listeners.forEach((cb) => cb(state));
  };
  let loading = null;

  if (state.status === "unconfigured") {
    console.warn("NOTES.ITEM_ID is still the placeholder, so Notes is off. Set it in config.js to the hosted notes layer's item ID.");
  }

  async function load() {
    set({ status: "loading", message: "" });
    let layer;
    try {
      const FeatureLayer = await $arcgis.import("@arcgis/core/layers/FeatureLayer.js");
      layer = new FeatureLayer({ portalItem: { id: NOTES.ITEM_ID }, layerId: NOTES.LAYER_INDEX });
      await layer.load();
      const { problems, warnings, lengths, edit, optional, activity } = checkNotesLayer(layer);
      if (problems.length) throw new Error(problems.join(" "));
      warnings.forEach((w) => console.warn(w));
      if (!activity && NOTES.SOURCES.some((src) => src.activity)) setStatus("warning", NOTES.TEXT.LAYER_UNAVAILABLE, NOTES.TEXT.ACTIVITY_FIELDS_MISSING);
      const ops = (layer.effectiveCapabilities ?? layer.capabilities)?.operations;
      const editable = layer.effectiveEditingEnabled !== false;
      const canAdd = editable && ops?.supportsAdd !== false;
      const canUpdate = editable && ops?.supportsUpdate !== false;
      const c = contactCheck(layer);
      const store = await createLayerNotesStore(layer, edit);
      const attachments = attachmentCheck(layer);
      set({ status: "ready", layer, store, edit, lengths: { ...lengths, ...c.lengths }, canAdd, canUpdate, whyNot: canAdd ? "" : NOTES.TEXT.READ_ONLY, urlField: !!optional.URL, activity,
        contact: c.contact && activity, followups: c.followups && activity, followupEmail: c.followupEmail && activity, globalIdField: c.globalIdField, contactDomains: c.domains, attachments });
    } catch (err) {
      // A wrong item ID or no access is reported by the portal item; the layer itself only says it has no url.
      const message = layer?.portalItem?.loadError?.message ?? err?.message ?? String(err);
      console.warn("Couldn't load the notes layer:", err?.message ?? String(err));
      setStatus("warning", NOTES.TEXT.LAYER_UNAVAILABLE, message);
      set({ status: "error", message, layer: null, store: null, canAdd: false, canUpdate: false });
    }
    return state;
  }

  return {
    state,
    // Load the layer if it is configured and not loaded yet. Resolves to the state once it is settled (a call while it
    // loads waits for that load).
    ensure() {
      if (loading) return loading;
      if (state.status !== "idle") return Promise.resolve(state);
      return (loading = load());
    },
    onChange: (cb) => listeners.add(cb),
  };
}
