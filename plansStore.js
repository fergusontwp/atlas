
// The Plans layer behind a small interface, so the save logic (savePlan.js) can be tested with an in-memory fake.
//   add({ attributes, rings, wkid })   -> { objectId }       throws if the layer refuses the record
//   rollback(objectId)                 -> void               deletes a record; throws if it can't
//   attach(objectId, { name, type, data })                   adds one attachment; throws on failure
//   attachments(objectId)              -> [{ name, size }]   what is stored now
//   update(objectId, attributes)       -> void               changes some attributes of a record
//   get(objectId)                      -> attributes | null

// ---- the in-memory fake (also used by the tests). faults: { add, attach(name) -> bool, rollback, update, attachments }
export function createMemoryStore(faults = {}) {
  const records = new Map();
  const files = new Map();
  let next = 1;
  const fail = (what, arg) => {
    const f = faults[what];
    if (f && (typeof f === "function" ? f(arg) : true)) throw new Error(`${what} failed (fake)`);
  };
  return {
    records, files, faults,
    async add({ attributes, rings, wkid }) {
      fail("add");
      const objectId = next++;
      records.set(objectId, { attributes: { ...attributes }, rings, wkid });
      files.set(objectId, []);
      return { objectId };
    },
    async rollback(objectId) {
      fail("rollback");
      records.delete(objectId);
      files.delete(objectId);
    },
    async attach(objectId, { name, type, data }) {
      fail("attach", name);
      files.get(objectId).push({ name, type, size: data.byteLength ?? data.size });
    },
    async attachments(objectId) {
      fail("attachments");
      return (files.get(objectId) ?? []).map((f) => ({ name: f.name, size: f.size }));
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
}

// ---- the real one, on the SDK FeatureLayer (the layer is never on the map; applyEdits and attachments work regardless)
export async function createLayerStore(layer) {
  const [Graphic, Polygon, SpatialReference] = await $arcgis.import([
    "@arcgis/core/Graphic.js", "@arcgis/core/geometry/Polygon.js", "@arcgis/core/geometry/SpatialReference.js",
  ]);
  const oidField = layer.objectIdField;
  const one = (results, what) => {
    const r = results?.[0];
    if (!r) throw new Error(`${what}: the layer returned no result.`);
    if (r.error) throw new Error(`${what}: ${r.error.message ?? r.error.description ?? r.error.name ?? "the layer refused it"}`);
    return r;
  };
  return {
    async add({ attributes, rings, wkid }) {
      const graphic = new Graphic({ attributes, geometry: new Polygon({ rings, spatialReference: new SpatialReference({ wkid }) }) });
      const res = await layer.applyEdits({ addFeatures: [graphic] });
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
    },
    async attachments(objectId) {
      const res = await layer.queryAttachments({ objectIds: [objectId] });
      return (res[objectId] ?? []).map((a) => ({ name: a.name, size: a.size }));
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
}

