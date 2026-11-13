// The selected feature's own layer (the requests layer) behind a small interface, for the activity log's field changes.
// Edits use the signed-in user's token, like every other edit in the app.
//   canUpdate                      the user can update features of this layer (effectiveEditingEnabled and the layer's
//                                  effective update operation; nothing guessed from the role name)
//   fields()                       [{ name, type, editable, length, domain }]: the layer's fields, each with its domain
//                                  (getFieldDomain, so a subtype-free layer's domain is the field's own)
//   read(oid, fields, { signal })  -> { values: { field: value }, editor, edited } fresh from the service; null if gone
//   update(oid, values)            -> void; only the given fields; throws with the layer's reason when refused
// createMemoryRecordEditor is the in-memory fake for tests.
export function createLayerRecordEditor(layer) {
  const oidField = layer.objectIdField;
  const ops = (layer.effectiveCapabilities ?? layer.capabilities)?.operations;
  const tracking = layer.editFieldsInfo ?? null;
  return {
    canUpdate: layer.effectiveEditingEnabled !== false && ops?.supportsUpdate !== false,
    fields: () => (layer.fields ?? []).map((f) => ({ name: f.name, type: f.type, editable: f.editable, length: f.length, domain: layer.getFieldDomain?.(f.name) ?? f.domain ?? null })),
    async read(oid, fields, { signal } = {}) {
      const extra = [tracking?.editorField, tracking?.editDateField].filter(Boolean);
      const { features } = await layer.queryFeatures({ objectIds: [oid], outFields: [...new Set([oidField, ...fields, ...extra])], returnGeometry: false }, { signal });
      const a = features[0]?.attributes;
      if (!a) return null;
      return { values: Object.fromEntries(fields.map((f) => [f, a[f] ?? null])), editor: tracking?.editorField ? a[tracking.editorField] ?? "" : "", edited: tracking?.editDateField ? a[tracking.editDateField] ?? null : null };
    },
    async update(oid, values) {
      const Graphic = await $arcgis.import("@arcgis/core/Graphic.js");
      const res = await layer.applyEdits({ updateFeatures: [new Graphic({ attributes: { ...values, [oidField]: oid } })] });
      const r = res.updateFeatureResults?.[0];
      if (!r) throw new Error("the layer returned no result");
      if (r.error) throw new Error(r.error.message ?? r.error.description ?? "the layer refused it");
    },
  };
}

// The fake: records { oid: attributes }; faults { read, update } -> true or a function; `user` and `clock` play editor
// tracking (editor, edited).
export function createMemoryRecordEditor({ records = {}, fields = [], canUpdate = true, user = "tester", clock = () => Date.now(), faults = {} } = {}) {
  const fail = (what, arg) => {
    const f = faults[what];
    if (f && (typeof f === "function" ? f(arg) : true)) throw new Error(`${what} failed (fake)`);
  };
  const meta = {};
  return {
    records, canUpdate,
    fields: () => fields,
    async read(oid, names) {
      fail("read", oid);
      const a = records[oid];
      if (!a) return null;
      return { values: Object.fromEntries(names.map((f) => [f, a[f] ?? null])), editor: meta[oid]?.editor ?? "", edited: meta[oid]?.edited ?? null };
    },
    async update(oid, values) {
      fail("update", values);
      if (!records[oid]) throw new Error(`no record ${oid} (fake)`);
      Object.assign(records[oid], values);
      meta[oid] = { editor: user, edited: clock() };
    },
    // someone else changes the record (for the stale check)
    touch(oid, values, editor = "someone_else") {
      Object.assign(records[oid], values);
      meta[oid] = { editor, edited: clock() };
    },
  };
}
