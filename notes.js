import { CONFIG, GEOREF, NOTES, PARCEL_PANEL } from "./config.js";
import { anchorPoint, countLabel, noteSource, noteTarget } from "./notesLogic.js";
import { searchSubject } from "./searchSubject.js";
import { createNotesDialog } from "./notesDialog.js";
import { resolveActivity } from "./activityLogic.js";
import { createLayerRecordEditor } from "./recordEditor.js";
import { createFollowupEmail, createRoster, createStaffDirectory } from "./staffDirectory.js";
import { cleanName } from "./contactLogic.js";
import { parseEntryParam, storedTarget } from "./entryLink.js";
import { getParam, setParam } from "./urlParams.js";
import { setStatus } from "./ui.js";

// Notes: a historical note log for any selected feature (the notes layer: notesLayer.js, notesStore.js; the rules:
// notesLogic.js). A Notes button in the parcel panel's button row, for any selected feature whose layer takes notes
// (NOTES.SOURCES, or the fallback), with the count of active notes: "Notes (2)".
//
// The count: 300 ms (COUNT_DEBOUNCE_MS) after the selection settles, the target is worked out (noteTarget; the ID fields
// are read from the feature's own layer by object id when the click's attributes don't have them all) and the notes
// layer is asked for a count with an explicit where. A new selection aborts the request in flight and resets the label
// to "Notes", and an answer for an earlier selection (by the subject's key) is dropped, so paging between hits never
// shows a stale count. A failed count: no number, a console warning; the button still opens the dialog. The count is
// asked again after an add or a retract.
//
// The button opens the Notes dialog (notesDialog.js) for the selected feature's target.
//
// opts: { mapEl, panel, actions (parcelActions.js), notesLayer (notesLayer.js), roadLayer (Road search's layer, or
// null), pointInfo (closed when the dialog opens), user () -> the signed-in user name, authorName () -> Promise of their
// full name (default: the portal user's fullName), recordEditor (layer) -> the feature layer's editor for field changes
// (default recordEditor.createLayerRecordEditor), staffDirectory (the follow-up assignees, staffDirectory.js), roster (the
// staff roster for followup_to_email, staffDirectory.createRoster) }. Returns the console handle (viewer.notes): open(), close(), state
// ({ target, count, status, requests }), layer.
//
// The activity log: a source with `activity` (the requests layer) gets field changes in the dialog when the notes layer
// has the four activity fields, the source's config resolves against its layer (activityLogic.resolveActivity) and its
// `editsEnabled` is true; switched off, the timeline, its duration and received rows stay and the composer is the plain
// note box (one console line says so). While
// it doesn't (placeholders, a missing field), one console warning per layer says why and lists the layer's fields and
// status codes, so the real names can be put in config; the layer's notes still work.
export function setupNotes({ mapEl, panel, actions, notesLayer, roadLayer = null, pointInfo = null, user = () => null, authorName = portalFullName, recordEditor = createLayerRecordEditor, staffDirectory = createStaffDirectory(), roster = createRoster() }) {
  const cfg = resolveSources(mapEl.map, roadLayer, notesLayer.state.status);
  const off = () => ["off", "unconfigured", "error"].includes(notesLayer.state.status);
  const missing = new Map(); // subject key -> why it has no target (an ID read from its layer and still empty)
  const subjectOf = (selection) => searchSubject(selection, { titleFields: PARCEL_PANEL.TITLE_FIELDS });
  const takesNotes = (selection) => {
    if (off()) return false;
    const s = subjectOf(selection);
    return !!s && !!noteSource(s, cfg).source && !missing.has(s.key);
  };
  const requests = { count: 0, attributes: 0, page: 0 };
  const changedListeners = new Set(); // told after any add or retract in the dialog (the follow-ups count)
  const activities = new Map(); // feature layer -> { resolved, editor }, or null when its field changes are off
  function activityFor(s) {
    if (!s?.layer || !notesLayer.state.activity) return null;
    const { source } = noteSource(s, cfg);
    if (!source?.activity || typeof s.layer.applyEdits !== "function") return null;
    if (!activities.has(s.layer)) {
      const editor = recordEditor(s.layer);
      const resolved = resolveActivity(source.activity, { fields: editor.fields() });
      if (!resolved.ok) {
        const list = editor.fields().map((f) => `${f.name} (${f.type}${f.domain?.type === "coded-value" ? `: ${f.domain.codedValues.map((c) => c.code).join(", ")}` : ""})`).join("; ");
        console.warn(`Notes: field changes for "${s.layerTitle}" are off (${resolved.reason}); its notes still work. The layer's fields: ${list}.`);
      } else if (!resolved.editsEnabled) {
        console.info(NOTES.TEXT.EDITS_OFF(s.layerTitle));
      }
      activities.set(s.layer, resolved.ok ? { resolved, editor } : null);
    }
    const found = activities.get(s.layer);
    return found && { ...found, oid: s.oid };
  }
  const dialog = createNotesDialog({
    notesLayer, panel, pointInfo, requests, user, authorName,
    anchor: (s) => anchorFor(s, notesLayer.state.layer),
    onChanged: (t) => { recount(t); changedListeners.forEach((cb) => cb(t)); },
    staff: () => staffDirectory.load(),
    // a new follow-up's followup_to_email (section 57): the staff list's email, then the roster, else null
    followupEmail: createFollowupEmail({ staff: () => staffDirectory.load(), roster }),
  });

  let subject = null, target = null, count = null, abort = null, timer = 0;
  const button = actions.addAction({
    id: "parcel-notes-button", label: NOTES.TEXT.BUTTON, icon: "notepad", scope: "feature", when: takesNotes,
    onClick: () => open(),
  });
  const setCount = (n) => { count = n; button.setLabel(countLabel(n)); };

  // The target for a subject: from the click's attributes if they have every ID field, else from the feature's own
  // layer by object id (outFields: the ID fields and the label fields). null, with a console note, when it has none.
  async function targetOf(asked, attributes, signal) {
    let r = noteTarget(asked, attributes, cfg);
    if (r.needs.length && asked.layer?.queryFeatures && asked.oid !== null && asked.oid !== undefined) {
      const found = noteSource(asked, cfg);
      requests.attributes++;
      const { features } = await asked.layer.queryFeatures({
        objectIds: [asked.oid], outFields: [...new Set([...found.fields, ...(found.source.label?.fields ?? [])])], returnGeometry: false,
      }, { signal });
      r = noteTarget(asked, { ...attributes, ...(features[0]?.attributes ?? {}) }, cfg);
    }
    if (!r.target) {
      console.info(`Notes: no notes for this feature. ${r.reason}`);
      missing.set(asked.key, r.reason);
      actions.sync();
    } else if (r.target.unstable) {
      console.warn(`Notes on "${asked.layerTitle}" are keyed by the object id, which can change if the layer is overwritten. Add a GlobalID field to the layer.`);
    }
    return r.target;
  }

  async function refresh() {
    abort?.abort();
    const asked = subject;
    if (!asked || off() || missing.has(asked.key)) return;
    const controller = (abort = new AbortController());
    const { signal } = controller;
    const stale = () => signal.aborted || subject?.key !== asked.key;
    const state = await notesLayer.ensure();
    if (stale() || state.status !== "ready") return;
    let t;
    try {
      t = await targetOf(asked, panel.selectedFeature()?.graphic?.attributes ?? {}, signal);
    } catch (err) {
      if (err?.name === "AbortError" || stale()) return;
      console.warn(`Notes: couldn't read the selected feature's ID from "${asked.layerTitle}":`, err?.message ?? String(err));
      return;
    }
    if (stale()) return;
    target = t;
    if (!t) return;
    let n = null;
    try {
      requests.count++;
      n = await state.store.count(t, NOTES.STATUS.ACTIVE, { signal });
    } catch (err) {
      if (err?.name === "AbortError" || stale()) return;
      console.warn("Notes: couldn't count the notes for this feature:", err?.message ?? String(err));
    }
    if (stale()) return;
    setCount(n);
  }

  panel.onSelectionChange((selection) => {
    clearTimeout(timer);
    abort?.abort();
    subject = subjectOf(selection);
    target = null;
    setCount(null); // never a stale number
    if (!subject || !takesNotes(selection)) return;
    notesLayer.ensure();
    timer = setTimeout(refresh, NOTES.COUNT_DEBOUNCE_MS);
  });
  // ready shows the button, a failed load hides it
  notesLayer.onChange(() => actions.sync());

  // a recount after an add or a retract on `changed` (a target), if the selection's target is the same one
  async function recount(changed) {
    if (!target || !changed || changed.key !== target.key) return;
    clearTimeout(timer);
    await refresh();
  }
  // the target for the selection now (worked out if the count hasn't been yet), or null
  async function currentTarget() {
    if (target || !subject) return target;
    clearTimeout(timer);
    await refresh();
    return target;
  }
  // Open the dialog for the selected feature (the button, or viewer.notes.open() in the console). entry: an object id to
  // scroll to once the list is loaded (the Follow-ups list). Resolves to the target it opened for, or null.
  async function open({ entry = null, retracted = false } = {}) {
    if (dialog.state.open) return null;
    const t = await currentTarget();
    if (t && notesLayer.state.status === "ready") { dialog.open(t, button.button, subject, activityFor(subject), { entry, retracted }); return t; }
    return null;
  }

  // ?entry=<GlobalID> at startup (section 57; the follow-up email's link). After sign-in and the notes layer load, the
  // entry is read by GlobalID (any status). Its parcel is selected and zoomed to (openParcel, as Follow-ups and ?parcel=
  // do) and the dialog opens scrolled to it and flashing; a retracted one opens with "Show retracted" on. Another source
  // has no open path here, so its dialog opens on the entry without selecting anything. Not found, or not readable (signed
  // out, no access): one notice, "Couldn't find that entry.". A value that isn't a GUID: one console warning. The
  // parameter is removed when the dialog it opened closes (the address bar follows what is shown, as ?parcel= follows the
  // selection), and right away when nothing opened. Resolves to whether the link was taken (then ?parcel= is ignored).
  async function openFromUrl({ openParcel = null } = {}) {
    const P = NOTES.LINK.PARAM, T = NOTES.LINK.TEXT;
    const raw = getParam(location.search, P);
    const asked = parseEntryParam(raw);
    if (!asked) return false;
    if (asked.error) { console.warn(T.BAD(P)); setParam(P, null); return false; }
    const notFound = () => { setStatus("warning", T.NOT_FOUND, T.NOT_FOUND_DETAIL); setParam(P, null); return false; };
    const state = await notesLayer.ensure();
    if (state.status !== "ready" || !state.store?.entry) return notFound();
    let e;
    try {
      e = await state.store.entry(asked.gid);
    } catch (err) {
      console.warn("Notes: couldn't read the linked entry:", err?.message ?? String(err));
      return notFound();
    }
    const t = e && storedTarget(e);
    if (!t) return notFound();
    const retracted = e.status === NOTES.STATUS.RETRACTED;
    let opened = null;
    if (t.parcel && openParcel && (await openParcel(String(t.idValue)))) opened = await open({ entry: e.objectId, retracted });
    if (!opened && !dialog.state.open) { dialog.open(t, null, null, null, { entry: e.objectId, retracted }); opened = t; }
    if (!opened) return notFound();
    dialog.dialog.addEventListener("calciteDialogClose", () => setParam(P, null), { once: true });
    return true;
  }

  return {
    open, openFromUrl, close: () => dialog.close(), recount,
    unsaved: () => dialog.unsaved(), // sign-out's check (section 59)
    staff: () => staffDirectory.load(), // the assignee list (the same read the composer uses; followups.emailProbe counts it)
    onChanged: (cb) => changedListeners.add(cb),
    get target() { return target; },
    get layer() { return notesLayer.state.layer; },
    get state() { return { target, count, status: notesLayer.state.status, requests: { ...requests }, dialog: dialog.state }; },
    button: button.button,
  };
}

// The note's point (notesLogic.anchorPoint): the feature's full-precision geometry, read again from its own layer by
// object id in the working CRS (2271, planar feet; the clicked shape, projected, is the fallback), then a point for its
// kind: a point itself, a line's midpoint along the selected segment (for a road, only that segment), a polygon's
// labelPointOperator point if it is inside, else its centroid or a point inside. Projected to the notes layer's own
// spatial reference, by wkid only (never the view's spatial reference). Resolves to { point: [x, y], wkid }.
async function anchorFor(subject, notesFeatureLayer) {
  if (!subject) throw new Error("The feature for this note isn't known.");
  const [SpatialReference, Point, projectOperator, labelPointOperator] = await $arcgis.import([
    "@arcgis/core/geometry/SpatialReference.js", "@arcgis/core/geometry/Point.js",
    "@arcgis/core/geometry/operators/projectOperator.js", "@arcgis/core/geometry/operators/labelPointOperator.js",
  ]);
  if (!projectOperator.isLoaded()) await projectOperator.load();
  const workSR = new SpatialReference({ wkid: GEOREF.WORKING_WKID });
  let geometry = null;
  if (subject.layer?.queryFeatures && subject.oid !== null && subject.oid !== undefined) {
    try {
      const { features } = await subject.layer.queryFeatures({ objectIds: [subject.oid], returnGeometry: true, outFields: [], outSpatialReference: workSR });
      geometry = features[0]?.geometry ?? null;
    } catch (err) {
      console.warn(`Notes: couldn't read the feature from "${subject.layerTitle}" at full precision; using the clicked shape:`, err?.message ?? String(err));
    }
  }
  geometry ??= subject.geometry ? projectOperator.execute(subject.geometry, workSR) : null;
  const xy = geometry && anchorPoint(subject.kind, geometry.toJSON(), {
    labelPoint: () => { const p = labelPointOperator.execute(geometry); return p ? [p.x, p.y] : null; },
  });
  if (!xy) throw new Error("The feature has no shape to place the note on.");
  const wkid = notesFeatureLayer?.spatialReference?.wkid;
  if (!wkid) throw new Error("The notes layer's spatial reference has no wkid.");
  const target = new SpatialReference({ wkid });
  const p = target.equals(workSR) ? new Point({ x: xy[0], y: xy[1], spatialReference: workSR }) : projectOperator.execute(new Point({ x: xy[0], y: xy[1], spatialReference: workSR }), target);
  if (!p) throw new Error("The note's point couldn't be projected to the notes layer.");
  return { point: [p.x, p.y], wkid };
}

// The signed-in user's full name for author_name (shown on the note; editor tracking keeps the trusted creator), its
// runs of spaces made one (contactLogic.cleanName: a portal full name can read "First  Last"). The
// portal is asked once, with authMode "no-prompt" so this never starts a sign-in; null when it can't say.
let portalUser = null;
function portalFullName() {
  portalUser ??= (async () => {
    const Portal = await $arcgis.import("@arcgis/core/portal/Portal.js");
    const portal = new Portal({ url: CONFIG.PORTAL_URL, authMode: "no-prompt" });
    await portal.load();
    return cleanName(portal.user?.fullName);
  })().catch((err) => {
    console.warn("Notes: couldn't read your full name from the portal; notes show your user name instead:", err?.message ?? String(err));
    return null;
  });
  return portalUser;
}

// NOTES with each source's title resolved: roads from SEARCH.ROAD.LAYER_TITLE, else the layer Road search found. A title
// that matches no layer is a console warning; unconfirmed sources (title null) get a console note listing the line and
// point layers with a GlobalID field, as candidates (only when the notes layer is configured).
function resolveSources(map, roadLayer, status) {
  const SOURCES = NOTES.SOURCES.map((s) => (s.road && !s.title && roadLayer ? { ...s, title: roadLayer.title } : s));
  if (status === "off" || status === "unconfigured") return { ...NOTES, SOURCES };
  const layers = map.allLayers.toArray().filter((l) => l.type === "feature");
  for (const s of SOURCES) {
    if (s.title && !layers.some((l) => l.title === s.title)) console.warn(`NOTES.SOURCES "${s.key}": no layer titled "${s.title}"; that source takes no notes.`);
  }
  const pending = SOURCES.filter((s) => !s.parcel && !s.title).map((s) => s.key);
  if (pending.length) {
    const candidates = layers.filter((l) => ["point", "multipoint", "polyline"].includes(l.geometryType) && l.fields?.some((f) => f.name.toLowerCase() === "globalid"));
    console.info(`Notes: set the web map title for ${pending.join(", ")} in NOTES.SOURCES (until then they take no notes, and the fallback for other layers is off). Line and point layers with a GlobalID: ${candidates.map((l) => `"${l.title}"`).join(", ") || "none"}.`);
  }
  return { ...NOTES, SOURCES };
}
