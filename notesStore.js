// The notes layer behind a small interface, so the Notes UI and its tests can use an in-memory fake (like plansStore.js).
//   count(target, status, { signal })        -> number            notes for the target with that status (null: any)
//   page(target, { status, start, num, signal }) -> { notes, more }  newest first; notes as notesLogic.noteFrom makes
//                                                                  them; more: older ones exist. With the activity
//                                                                  log's event_date, newest first by event date (else
//                                                                  the creation date), sorted in the app (below)
//   add({ attributes, point: [x, y], wkid }) -> { objectId }      one new note (the server sets the author and time)
//   retract(objectId)                        -> void              status set to retracted (an update, never a delete)
//   followups({ assignee, signal })          -> { entries, closings }  the contact log's follow-ups: active entries with
//                                                                  a due day (assigned to `assignee`, ignoring case, or
//                                                                  all when null) and the active entries that close
//                                                                  any of them (followup_of). Volumes are small.
//   attachmentsOf(objectIds, { signal })    -> { [objectId]: [{ id, name, contentType, size, url }] }  the files on these
//                                                                  entries (section 55), one query for all of them
//   fetchAttachment(file, { signal })        -> Blob              a file's bytes (the layer is private: through the SDK
//                                                                  request, which adds the sign-in)
//   attach(objectId, file)                   -> { id }            adds one file to an entry; throws on failure
// Every entry also carries contactLogic.contactFrom's parts (globalId, contact, followup, source).
// Nothing here ever deletes a note or a file.
import { NOTES } from "./config.js";
import { noteFrom, notesWhere } from "./notesLogic.js";
import { entryOf, sortEntries } from "./activityLogic.js";
import { allOpenWhere, closingsWhere, contactFrom, gidKey, mineWhere } from "./contactLogic.js";
import { entryWhere } from "./entryLink.js";

// Every notes field name, the CONTACT and FOLLOWUP groups included.
export const noteFieldNames = (F = NOTES.FIELDS) => Object.values(F).flatMap((v) => (v && typeof v === "object" ? Object.values(v) : [v]));
// The most follow-ups (or closing entries) read at once.
const FOLLOWUPS_MAX = 2000;

// ---- the in-memory fake (also used by the tests). It plays editor tracking: the creator is `user` and the dates come
// from `clock` (default: one step per edit, so the order is certain). faults: { count, page, add, retract } -> true
// (always fails) or a function deciding per call.
export const FAKE_EDIT_FIELDS = { creatorField: "Creator", creationDateField: "CreationDate", editorField: "Editor", editDateField: "EditDate" };

// Files kept in memory, for the fake below and the browser harness: attachmentsOf, fetchAttachment, attach as the real
// store has them. faults: { attachments, fetch, attach } as for the store.
export function createMemoryAttachments({ faults = {} } = {}) {
  const files = new Map(); // objectId -> [{ id, name, contentType, size, url, blob }]
  let next = 1;
  const fail = (what, arg) => {
    const f = faults[what];
    if (f && (typeof f === "function" ? f(arg) : true)) throw new Error(`${what} failed (fake)`);
  };
  const info = ({ blob, ...rest }) => ({ ...rest });
  return {
    files,
    async attachmentsOf(objectIds) {
      fail("attachments", objectIds);
      const out = {};
      for (const oid of objectIds ?? []) if (files.get(oid)?.length) out[oid] = files.get(oid).map(info);
      return out;
    },
    async fetchAttachment(file) {
      fail("fetch", file);
      for (const list of files.values()) {
        const found = list.find((f) => f.id === file?.id);
        if (found) return found.blob;
      }
      throw new Error(`no file ${file?.id} (fake)`);
    },
    async attach(objectId, file) {
      fail("attach", { objectId, file });
      const id = next++;
      const list = files.get(objectId) ?? [];
      list.push({ id, name: file.name, contentType: file.type || "application/octet-stream", size: file.size, url: `memory:${objectId}/${id}`, blob: file });
      files.set(objectId, list);
      return { id };
    },
  };
}

export function createMemoryNotesStore({ user = "tester", clock = null, faults = {}, cfg = NOTES } = {}) {
  const F = cfg.FIELDS, E = FAKE_EDIT_FIELDS, U = F.FOLLOWUP;
  const toEntry = (a) => ({ ...entryOf(noteFrom(a, "OBJECTID", E, F), cfg), ...contactFrom(a, F, "GlobalID") });
  const records = new Map();
  let next = 1, tick = 0;
  const now = () => (clock ? clock() : ++tick * 1000);
  const fail = (what, arg) => {
    const f = faults[what];
    if (f && (typeof f === "function" ? f(arg) : true)) throw new Error(`${what} failed (fake)`);
  };
  const matches = (a, target, status) => a[F.SOURCE_LAYER] === target.layerKey && a[F.SOURCE_ID] === target.idValue && (!status || a[F.STATUS] === status);
  const store = {
    ...createMemoryAttachments({ faults }),
    records, edit: E, oidField: "OBJECTID",
    get user() { return user; },
    set user(u) { user = u; },
    async count(target, status = null) {
      fail("count", target);
      return [...records.values()].filter((r) => matches(r.attributes, target, status)).length;
    },
    async page(target, { status = null, start = 0, num = cfg.PAGE_SIZE } = {}) {
      fail("page", target);
      const all = sortEntries([...records.values()].filter((r) => matches(r.attributes, target, status)).map((r) => toEntry(r.attributes)));
      return { notes: all.slice(start, start + num), more: all.length > start + num };
    },
    async entry(gid) {
      fail("entry", gid);
      const a = [...records.values()].map((r) => r.attributes).find((x) => gidKey(x.GlobalID) === gidKey(gid));
      return a ? toEntry(a) : null;
    },
    async followups({ assignee = null } = {}) {
      fail("followups", assignee);
      const active = (a) => a[F.STATUS] === cfg.STATUS.ACTIVE;
      const rows = [...records.values()].map((r) => r.attributes);
      const entries = rows.filter((a) => active(a) && Number.isFinite(a[U.DUE]) && (assignee === null || String(a[U.TO] ?? "").toLowerCase() === String(assignee).toLowerCase())).map(toEntry);
      const keys = new Set(entries.map((e) => gidKey(e.globalId)));
      const closings = rows.filter((a) => active(a) && keys.has(gidKey(a[U.OF]))).map(toEntry);
      return { entries, closings };
    },
    async add({ attributes, point, wkid }) {
      fail("add", attributes);
      const objectId = next++;
      const t = now();
      const GlobalID = `{00000000-0000-4000-8000-${String(objectId).padStart(12, "0")}}`;
      records.set(objectId, {
        attributes: { ...attributes, OBJECTID: objectId, GlobalID, [E.creatorField]: user, [E.creationDateField]: t, [E.editorField]: user, [E.editDateField]: t },
        point, wkid,
      });
      return { objectId };
    },
    async retract(objectId) {
      fail("retract", objectId);
      const r = records.get(objectId);
      if (!r) throw new Error(`no note ${objectId} (fake)`);
      Object.assign(r.attributes, { [F.STATUS]: cfg.STATUS.RETRACTED, [E.editorField]: user, [E.editDateField]: now() });
    },
  };
  return store;
}

// ---- the real one, on the SDK FeatureLayer (never on the map). edit: the layer's editor tracking field names
// (notesLogic.checkNotesLayer). Counts and pages are service queries with an explicit where (notesLogic.notesWhere).
// With event_date, a page can't be ordered by the service (old rows have none, and where nulls sort is the database's
// choice), so a feature's entries are read whole, up to ACTIVITY.TIMELINE_MAX, in chunks the service allows, and sorted
// here (activityLogic.sortEntries): a feature's log is short.

export async function createLayerNotesStore(layer, edit, cfg = NOTES) {
  const [Graphic, Point, SpatialReference, esriRequest] = await $arcgis.import([
    "@arcgis/core/Graphic.js", "@arcgis/core/geometry/Point.js", "@arcgis/core/geometry/SpatialReference.js", "@arcgis/core/request.js",
  ]);
  const F = cfg.FIELDS;
  const oidField = layer.objectIdField;
  const gidField = layer.globalIdField || null;
  // only fields the layer has: an optional one (note_url, the contact log's) may be missing, and asking for it would
  // fail the query
  const has = (name) => !layer.fieldsIndex?.has || layer.fieldsIndex.has(name);
  // followup_to_email is written, never read back (section 57: never shown or logged)
  const outFields = [...new Set([oidField, gidField, ...noteFieldNames(F), ...Object.values(edit).filter(Boolean)])].filter((n) => n && has(n) && n !== F.FOLLOWUP.TO_EMAIL);
  const toEntry = (a) => ({ ...entryOf(noteFrom(a, oidField, edit, F), cfg), ...contactFrom(a, F, gidField) });
  // every row of a where clause, in the chunks the service allows, up to `max`
  async function readAll(where, max, signal) {
    const chunk = Math.min(layer.capabilities?.query?.maxRecordCount || 1000, max);
    const rows = [];
    while (rows.length < max) {
      const { features, exceededTransferLimit } = await layer.queryFeatures({
        where, outFields, returnGeometry: false, orderByFields: [`${edit.creationDateField} DESC`, `${oidField} DESC`], start: rows.length, num: chunk,
      }, { signal });
      rows.push(...features);
      if (!features.length || (features.length < chunk && !exceededTransferLimit)) break;
    }
    return rows.slice(0, max);
  }
  const why = (r) => r.error?.message ?? r.error?.description ?? r.error?.name ?? "the layer refused it";
  const one = (results, what) => {
    const r = results?.[0];
    if (!r) throw new Error(`${what}: the layer returned no result.`);
    if (r.error) throw new Error(`${what}: ${why(r)}`);
    return r;
  };
  return {
    edit, oidField,
    count: (target, status = null, { signal } = {}) => layer.queryFeatureCount({ where: notesWhere(target, status, F) }, { signal }),
    async page(target, { status = null, start = 0, num = cfg.PAGE_SIZE, signal } = {}) {
      if (has(F.EVENT_DATE)) {
        const rows = await readAll(notesWhere(target, status, F), cfg.ACTIVITY.TIMELINE_MAX, signal);
        const all = sortEntries(rows.map((f) => toEntry(f.attributes)));
        return { notes: all.slice(start, start + num), more: all.length > start + num };
      }
      // one more than asked, to know whether older notes exist
      const { features } = await layer.queryFeatures({
        where: notesWhere(target, status, F), outFields, returnGeometry: false,
        orderByFields: [`${edit.creationDateField} DESC`, `${oidField} DESC`], start, num: num + 1,
      }, { signal });
      return { notes: features.slice(0, num).map((f) => ({ ...noteFrom(f.attributes, oidField, edit, F), ...contactFrom(f.attributes, F, gidField) })), more: features.length > num };
    },
    // one entry by GlobalID, whatever its status (?entry=, section 57), or null
    async entry(gid, { signal } = {}) {
      if (!gidField) return null;
      const { features } = await layer.queryFeatures({ where: entryWhere(gid, gidField), outFields, returnGeometry: false, num: 1 }, { signal });
      return features[0] ? toEntry(features[0].attributes) : null;
    },
    async followups({ assignee = null, signal } = {}) {
      const rows = await readAll(assignee === null ? allOpenWhere(F, cfg) : mineWhere(assignee, F, cfg), FOLLOWUPS_MAX, signal);
      const entries = rows.map((f) => toEntry(f.attributes));
      const ids = entries.map((e) => e.globalId).filter(Boolean);
      const closings = [];
      for (let i = 0; i < ids.length; i += 100) {
        const found = await readAll(closingsWhere(ids.slice(i, i + 100), F, cfg), FOLLOWUPS_MAX, signal);
        closings.push(...found.map((f) => toEntry(f.attributes)));
      }
      return { entries, closings };
    },
    async add({ attributes, point: [x, y], wkid }) {
      const geometry = new Point({ x, y, spatialReference: new SpatialReference({ wkid }) });
      const res = await layer.applyEdits({ addFeatures: [new Graphic({ attributes, geometry })] });
      return { objectId: one(res.addFeatureResults, "Adding the note").objectId };
    },
    async retract(objectId) {
      const res = await layer.applyEdits({ updateFeatures: [new Graphic({ attributes: { [oidField]: objectId, [F.STATUS]: cfg.STATUS.RETRACTED } })] });
      one(res.updateFeatureResults, "Retracting the note");
    },
    // One queryAttachments for a page's entries (in chunks of 100), or one per entry when the layer can't query
    // attachments for several features at once (capabilities.operations.supportsQueryAttachments false).
    async attachmentsOf(objectIds, { signal } = {}) {
      const ids = [...new Set(objectIds ?? [])].filter(Number.isFinite);
      const out = {};
      const ask = async (chunk) => {
        const res = await layer.queryAttachments({ objectIds: chunk }, { signal });
        for (const [oid, list] of Object.entries(res ?? {})) {
          out[oid] = (list ?? []).map((a) => ({ id: a.id, name: a.name ?? "", contentType: a.contentType ?? "", size: a.size ?? null, url: a.url }));
        }
      };
      const many = layer.capabilities?.operations?.supportsQueryAttachments !== false;
      if (many) for (let i = 0; i < ids.length; i += 100) await ask(ids.slice(i, i + 100));
      else for (const id of ids) await ask([id]);
      return out;
    },
    async fetchAttachment(file, { signal } = {}) {
      const { data } = await esriRequest(file.url, { responseType: "blob", signal });
      return data;
    },
    // the same call as Plans (plansStore.attach): addAttachment with the file in a FormData
    async attach(objectId, file) {
      const form = new FormData();
      form.append("attachment", file, file.name);
      const res = await layer.addAttachment(new Graphic({ attributes: { [oidField]: objectId } }), form);
      if (res?.error) throw new Error(`Attaching ${file.name}: ${res.error.message ?? "the layer refused it"}`);
      return { id: res?.objectId ?? null };
    },
  };
}
