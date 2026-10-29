// The Plans layer behind a small interface, so the save logic (saveGroup.js) can be tested with an in-memory fake.
//   edit({ adds, updates, deletes })   -> { addIds }         one all-or-nothing request: adds [{ attributes, rings, wkid }],
//                                                            updates [{ objectId, attributes, rings?, wkid? }], deletes
//                                                            [objectId]; throws (and changes nothing) if any is refused
//   add({ attributes, rings, wkid })   -> { objectId }       one record (edit with a single add)
//   rollback(objectId)                 -> void               deletes a record; throws if it can't
//   attach(objectId, { name, type, data }) -> { id }         adds one attachment; throws on failure
//   detach(objectId, ids)              -> void               removes attachments by id; throws if any can't be removed
//   attachments(objectId)              -> [{ id, name, size }] what is stored now
//   update(objectId, attributes)       -> void               changes some attributes of a record
//   get(objectId)                      -> attributes | null

// ---- the in-memory fake (also used by the tests).
// faults: { edit(kind) -> bool (kind "adds" | "updates" | "deletes", for the parts of a request), attach(name) -> bool,
//           detach, rollback, update, attachments }; a fault given as true always fails.
export function createMemoryStore(faults = {}) {
  const records = new Map();
  const files = new Map();
  let next = 1, nextFile = 1;
  const fail = (what, arg) => {
    const f = faults[what];
    if (f && (typeof f === "function" ? f(arg) : true)) throw new Error(`${what} failed (fake)`);
  };
  const store = {
    records, files, faults,
    async edit({ adds = [], updates = [], deletes = [] }) {
      // all or nothing: check every part before changing anything
      if (adds.length) fail("edit", "adds");
      if (updates.length) fail("edit", "updates");
      if (deletes.length) fail("edit", "deletes");
      for (const u of updates) if (!records.has(u.objectId)) throw new Error(`no record ${u.objectId} (fake)`);
      for (const d of deletes) if (!records.has(d)) throw new Error(`no record ${d} (fake)`);
      const addIds = adds.map(({ attributes, rings, wkid }) => {
        const objectId = next++;
        records.set(objectId, { attributes: { ...attributes }, rings, wkid });
        files.set(objectId, []);
        return objectId;
      });
      for (const u of updates) {
        const r = records.get(u.objectId);
        Object.assign(r.attributes, u.attributes);
        if (u.rings) { r.rings = u.rings; r.wkid = u.wkid ?? r.wkid; }
      }
      for (const d of deletes) { records.delete(d); files.delete(d); }
      return { addIds };
    },
    async add({ attributes, rings, wkid }) {
      fail("add");
      const { addIds } = await store.edit({ adds: [{ attributes, rings, wkid }] });
      return { objectId: addIds[0] };
    },
    async rollback(objectId) {
      fail("rollback");
      records.delete(objectId);
      files.delete(objectId);
    },
    async attach(objectId, { name, type, data }) {
      fail("attach", name);
      if (!files.has(objectId)) throw new Error(`no record ${objectId} (fake)`);
      const id = nextFile++;
      files.get(objectId).push({ id, name, type, size: data.byteLength ?? data.size });
      return { id };
    },
    async detach(objectId, ids) {
      fail("detach", ids);
      const list = files.get(objectId) ?? [];
      files.set(objectId, list.filter((f) => !ids.includes(f.id)));
    },
    async attachments(objectId) {
      fail("attachments");
      return (files.get(objectId) ?? []).map((f) => ({ id: f.id, name: f.name, size: f.size }));
    },
    async update(objectId, attributes) {
      fail("update");
      const r = records.get(objectId);
      if (!r) throw new Error("no such record (fake)");
      Object.assign(r.attributes, attributes);
    },
    async get(objectId) {
      return records.get(objectId)?.attributes ?? null;
    },
  };
  return store;
}

// ---- the real one, on the SDK FeatureLayer (the layer is never on the map; applyEdits and attachments work regardless)
export async function createLayerStore(layer) {
  const [Graphic, Polygon, SpatialReference] = await $arcgis.import([
    "@arcgis/core/Graphic.js", "@arcgis/core/geometry/Polygon.js", "@arcgis/core/geometry/SpatialReference.js",
  ]);
  const oidField = layer.objectIdField;
  const why = (r) => r.error.message ?? r.error.description ?? r.error.name ?? "the layer refused it";
  const one = (results, what) => {
    const r = results?.[0];
    if (!r) throw new Error(`${what}: the layer returned no result.`);
    if (r.error) throw new Error(`${what}: ${why(r)}`);
    return r;
  };
  const feature = ({ attributes, rings, wkid }) => new Graphic({ attributes, geometry: rings ? new Polygon({ rings, spatialReference: new SpatialReference({ wkid }) }) : null });
  const store = {
    // rollbackOnFailureEnabled: the service applies the request only if every edit in it succeeds (a layer that can't
    // switch it off always works that way). A refused part shows as an error on its result, or as a rejected request.
    async edit({ adds = [], updates = [], deletes = [] }) {
      const res = await layer.applyEdits({
        addFeatures: adds.map(feature),
        updateFeatures: updates.map((u) => feature({ ...u, attributes: { ...u.attributes, [oidField]: u.objectId } })),
        deleteFeatures: deletes.map((objectId) => ({ objectId })),
      }, { rollbackOnFailureEnabled: true });
      const all = [["Adding", res.addFeatureResults, adds.length], ["Updating", res.updateFeatureResults, updates.length], ["Removing", res.deleteFeatureResults, deletes.length]];
      for (const [what, results, n] of all) {
        if ((results?.length ?? 0) !== n) throw new Error(`${what} plan records: the layer returned ${results?.length ?? 0} results for ${n}.`);
        const bad = results.find((r) => r.error);
        if (bad) throw new Error(`${what} plan records: ${why(bad)}`);
      }
      return { addIds: res.addFeatureResults.map((r) => r.objectId) };
    },
    async add({ attributes, rings, wkid }) {
      const res = await layer.applyEdits({ addFeatures: [feature({ attributes, rings, wkid })] });
      return { objectId: one(res.addFeatureResults, "Adding the plan").objectId };
    },
    async rollback(objectId) {
      const res = await layer.applyEdits({ deleteFeatures: [{ objectId }] });
      one(res.deleteFeatureResults, "Removing the plan");
    },
    async attach(objectId, { name, type, data }) {
      const form = new FormData();
      form.append("attachment", new File([data], name, { type }));
      const res = await layer.addAttachment(new Graphic({ attributes: { [oidField]: objectId } }), form);
      if (res?.error) throw new Error(`Attaching ${name}: ${res.error.message ?? "the layer refused it"}`);
      return { id: res?.objectId ?? null };
    },
    async detach(objectId, ids) {
      if (!ids.length) return;
      const res = await layer.deleteAttachments(new Graphic({ attributes: { [oidField]: objectId } }), ids);
      const bad = (res ?? []).find((r) => r.error);
      if (bad) throw new Error(`Removing an old file: ${why(bad)}`);
    },
    async attachments(objectId) {
      const res = await layer.queryAttachments({ objectIds: [objectId] });
      return (res[objectId] ?? []).map((a) => ({ id: a.id, name: a.name, size: a.size }));
    },
    async update(objectId, attributes) {
      const res = await layer.applyEdits({ updateFeatures: [new Graphic({ attributes: { ...attributes, [oidField]: objectId } })] });
      one(res.updateFeatureResults, "Updating the plan");
    },
    async get(objectId) {
      const { features } = await layer.queryFeatures({ objectIds: [objectId], outFields: ["*"], returnGeometry: false });
      return features[0]?.attributes ?? null;
    },
  };
  return store;
}
