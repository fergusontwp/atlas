// Notes: the pure parts, tested. No DOM and no SDK imports.
//
// A note belongs to a feature by a stable layer key (NOTES.SOURCES[].key) and an ID value built from the feature's own
// attributes (noteTarget), never by object id, item ID or layer title (an object id only as a flagged last resort).
// The pop-up will later join on source_layer and source_id in Arcade, so the ID stays simple: a field's value exactly as
// stored, or for a road the street name parts joined with single spaces, empty and null parts skipped
// (roadSearchLogic.streetName, the same rule as Road search).
import { NOTES } from "./config.js";
import { quote } from "./filterSql.js";
import { streetName } from "./roadSearchLogic.js";
import { normalizeNoteUrl } from "./noteUrl.js";

const present = (v) => v !== null && v !== undefined && String(v).trim() !== "";
// a layer's field by name, ignoring case (GlobalID is "globalid" on some services); its real name, or null
function fieldOf(layer, name) {
  if (name === "OBJECTID" && layer?.objectIdField) return layer.objectIdField;
  const lower = name.toLowerCase();
  return (layer?.fields ?? []).find((f) => f.name.toLowerCase() === lower)?.name ?? null;
}
// an attribute by field name, ignoring case; undefined when the attributes don't have the field at all
function attrOf(attributes, name) {
  if (!attributes) return undefined;
  if (name in attributes) return attributes[name];
  const key = Object.keys(attributes).find((k) => k.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : attributes[key];
}

// The configured source a selected feature belongs to, and the fields its ID is read from. subject: searchSubject.js
// ({ isParcel, layer, layerTitle, oid, label, ... }); cfg.SOURCES[].title is the resolved web map title (for roads, the
// Road search layer's, filled in at setup). Returns
//   { source, layerKey, fields: [real field names], idField, unstable }   or   { reason }.
// unstable: the ID is the object id, which an overwrite of the layer can change.
export function noteSource(subject, cfg = NOTES) {
  if (!subject) return { reason: "Nothing is selected." };
  // never a subject (the "Call log" view of the notes layer itself), before any source or the fallback
  if (!subject.isParcel && (cfg.EXCLUDE_TITLES ?? []).includes(subject.layerTitle)) return { reason: `"${subject.layerTitle}" doesn't take notes (NOTES.EXCLUDE_TITLES).` };
  const layer = subject.layer;
  const source = cfg.SOURCES.find((s) => (s.parcel ? subject.isParcel : !!s.title && s.title === subject.layerTitle));
  if (source) return withFields(source, source.key, source.idFields, layer, !!source.join);
  if (subject.isParcel) return { reason: "Parcels aren't configured for notes." };
  if (!cfg.FALLBACK?.ENABLED) return { reason: `"${subject.layerTitle}" isn't configured for notes.` };
  // a note must never be written under the fallback key for a layer that is about to get its own key
  const pending = cfg.SOURCES.filter((s) => !s.parcel && !s.title).map((s) => s.key);
  if (pending.length) return { reason: `"${subject.layerTitle}" isn't configured for notes (the fallback is off until NOTES.SOURCES has titles for ${pending.join(", ")}).` };
  const item = layer?.portalItem?.id;
  if (!item || layer.layerId === undefined || layer.layerId === null) return { reason: `"${subject.layerTitle}" has no portal item and layer id to key notes on.` };
  return withFields({ key: null, noun: cfg.FALLBACK.NOUN, fallback: true }, `${item}:${layer.layerId}`, cfg.FALLBACK.PREFER, layer, false);
}

function withFields(source, layerKey, idFields, layer, join) {
  if (join) {
    const fields = idFields.map((n) => fieldOf(layer, n));
    const missing = idFields.filter((_, i) => !fields[i]);
    if (missing.length) return { reason: `"${layer?.title ?? "The layer"}" has no ${missing.join(", ")} field.` };
    return { source, layerKey, fields, idField: fields.join("+"), unstable: false };
  }
  for (const name of idFields) {
    const field = fieldOf(layer, name);
    if (field) return { source, layerKey, fields: [field], idField: name === "OBJECTID" ? "OBJECTID" : field, unstable: name === "OBJECTID" };
  }
  return { reason: `"${layer?.title ?? "The layer"}" has none of the ID fields ${idFields.join(", ")}.` };
}

// Which notes belong to the selected feature. attributes: the feature's attributes (the click's, which can be a subset
// of the layer's fields, or a query's). Returns { target, reason, needs }:
//   target: { layerKey, idFields, idField, idValue, label, scope: "feature" | "group", noun, layerTitle, subtitle,
//             unstable, key } or null;
//   reason: why there is no target; needs: field names the attributes don't have at all, so the caller should read them
//   from the feature's own layer by object id and ask again (reason is set too).
// key identifies the target (the draft and a late answer are kept by it): every segment of a street has the same one.
export function noteTarget(subject, attributes, cfg = NOTES) {
  const found = noteSource(subject, cfg);
  if (!found.source) return { target: null, reason: found.reason, needs: [] };
  const { source, layerKey, fields, idField, unstable } = found;
  const needs = fields.filter((f) => attrOf(attributes, f) === undefined && !(unstable && subject.oid !== null && subject.oid !== undefined));
  if (needs.length) return { target: null, reason: `The selected feature's ${needs.join(", ")} wasn't in the pop-up's attributes.`, needs };
  let idValue;
  if (source.join) idValue = streetName(fields.map((f) => attrOf(attributes, f)));
  else if (unstable) idValue = present(attrOf(attributes, fields[0])) ? String(attrOf(attributes, fields[0])) : present(subject.oid) ? String(subject.oid) : "";
  else idValue = present(attrOf(attributes, fields[0])) ? String(attrOf(attributes, fields[0])) : "";
  if (!idValue) return { target: null, reason: `The selected feature has no ${idField} value.`, needs: [] };
  const group = !!source.group;
  const label = group ? idValue : sourceLabel(source, attributes, { oid: subject.oid, fallback: subject.label });
  const layerTitle = subject.layerTitle;
  return {
    target: {
      layerKey, idFields: fields, idField, idValue, label, scope: group ? "group" : "feature", noun: source.noun, layerTitle,
      subtitle: group ? cfg.TEXT.ALL_SEGMENTS(idValue) : layerTitle, unstable, key: `${layerKey}\n${idValue}`,
    },
    reason: "", needs: [],
  };
}

// What a feature is called in the Notes dialog and in source_label: the source's label rule ({ fields, prefix }: prefix +
// the first non-empty value of fields), else `fallback` (the layer's display field value, searchSubject's label). A
// result that is empty or has a brace ("{pocfirstname}", an unresolved template) is never shown: "#<oid>" instead.
export function sourceLabel(source, attributes, { oid = null, fallback = "" } = {}) {
  const rule = source?.label;
  let label = "";
  if (rule) {
    const value = (rule.fields ?? []).map((f) => attrOf(attributes, f)).find(present);
    label = present(value) ? `${rule.prefix ?? ""}${String(value).trim()}` : "";
  } else {
    label = String(fallback ?? "").trim();
  }
  if (label && !/[{}]/.test(label)) return label;
  return present(oid) ? `#${oid}` : "#?";
}

// The where clause for a target's notes: source_layer and source_id exactly, quotes doubled ("O'Brien Rd" works), and
// a status when given.
export function notesWhere(target, status = null, F = NOTES.FIELDS) {
  const parts = [`${F.SOURCE_LAYER} = ${quote(target.layerKey)}`, `${F.SOURCE_ID} = ${quote(target.idValue)}`];
  if (status) parts.push(`${F.STATUS} = ${quote(status)}`);
  return parts.join(" AND ");
}

// The attributes of a new note, or { error }. The text is trimmed; empty, or longer than cfg.MAX_CHARS, is refused (a
// link alone is not a note). url: the optional link, checked again (noteUrl.normalizeNoteUrl); an invalid one is refused,
// and note_url is written only when there is a link (no link leaves it null). lengths: the layer's field lengths by
// field name (from notesLayer's check), so a long label or name is cut to fit instead of the add failing. The author
// and time come from editor tracking on the server.
// entry: the activity log's fields, only when the layer has them: { entryType, eventDate (ms), origin, changesJson }. An
// entry with changes may have no text (a field change on its own is allowed; the composer hints at a sentence), and so
// may a contact (its fields say what happened; contactLogic.newContactRecord).
export function newNoteRecord(text, target, { authorName = null, lengths = {}, url = null, entry = null } = {}, cfg = NOTES) {
  const F = cfg.FIELDS;
  const body = String(text ?? "").trim();
  if (!body && !entry?.changesJson && entry?.entryType !== cfg.ENTRY_TYPES.CONTACT) return { error: cfg.TEXT.EMPTY_TEXT };
  if (body.length > cfg.MAX_CHARS) return { error: cfg.TEXT.TOO_LONG(cfg.MAX_CHARS) };
  if (!target) return { error: "No feature to add the note to." };
  const link = normalizeNoteUrl(url, cfg);
  if (!link.ok) return { error: link.reason };
  const cut = (field, v) => (v === null || v === undefined ? null : lengths[field] > 0 ? String(v).slice(0, lengths[field]) : String(v));
  return {
    attributes: {
      [F.TEXT]: body,
      [F.AUTHOR_NAME]: cut(F.AUTHOR_NAME, present(authorName) ? String(authorName).trim() : null),
      [F.SOURCE_LAYER]: target.layerKey,
      [F.SOURCE_ID]: target.idValue,
      [F.SOURCE_ID_FIELD]: cut(F.SOURCE_ID_FIELD, target.idField),
      [F.SOURCE_LABEL]: cut(F.SOURCE_LABEL, target.label),
      [F.STATUS]: cfg.STATUS.ACTIVE,
      ...(link.url ? { [F.URL]: link.url } : {}),
      ...(entry ? {
        [F.ENTRY_TYPE]: entry.entryType ?? cfg.ENTRY_TYPES.COMMENT,
        [F.EVENT_DATE]: Number.isFinite(entry.eventDate) ? entry.eventDate : null,
        [F.ORIGIN]: entry.origin ?? cfg.ORIGINS.APP,
        [F.CHANGES]: entry.changesJson ?? null,
      } : {}),
    },
  };
}

// What the Notes button says: "Notes", or "Notes (2)" for two active notes. 0, null and an unknown count give no number.
export const countLabel = (n, T = NOTES.TEXT) => (Number.isFinite(n) && n > 0 ? T.BUTTON_COUNT(n) : T.BUTTON);

// Whether the signed-in user may retract a note: their own (the creator from editor tracking, ignoring case), still
// active. No signed-in user: never. The layer setting "editors can update only their own features" is what enforces it.
export function canRetract(note, user, cfg = NOTES) {
  if (!note || !present(user) || !present(note.creator)) return false;
  if (note.status === cfg.STATUS.RETRACTED) return false;
  return String(note.creator).trim().toLowerCase() === String(user).trim().toLowerCase();
}

// A note from a feature's attributes. edit: the layer's editor tracking field names { creatorField, creationDateField,
// editorField, editDateField } (layer.editFieldsInfo). Dates are epoch milliseconds or null.
export function noteFrom(attributes, oidField, edit, F = NOTES.FIELDS) {
  const a = attributes ?? {};
  const ms = (v) => (v instanceof Date ? v.getTime() : Number.isFinite(v) ? v : null);
  return {
    objectId: a[oidField] ?? null,
    text: a[F.TEXT] ?? "",
    authorName: present(a[F.AUTHOR_NAME]) ? String(a[F.AUTHOR_NAME]).trim() : "",
    creator: edit?.creatorField ? a[edit.creatorField] ?? "" : "",
    created: edit?.creationDateField ? ms(a[edit.creationDateField]) : null,
    editor: edit?.editorField ? a[edit.editorField] ?? "" : "",
    edited: edit?.editDateField ? ms(a[edit.editDateField]) : null,
    status: a[F.STATUS] ?? "",
    url: a[F.URL] ?? null,
    // the activity log's raw fields (activityLogic.entryOf reads them with their defaults)
    entryType: a[F.ENTRY_TYPE] ?? null,
    eventDate: ms(a[F.EVENT_DATE] ?? null),
    origin: a[F.ORIGIN] ?? null,
    changesJson: a[F.CHANGES] ?? null,
  };
}

// The author to show: author_name, else the creator, else UNKNOWN_AUTHOR.
export const authorOf = (note, T = NOTES.TEXT) => note.authorName || note.creator || T.UNKNOWN_AUTHOR;

// Check the notes layer's schema. layer: { geometryType, fields: [{ name, type, length }], editFieldsInfo }. Returns
// { problems, warnings, lengths, edit, optional }: a problem turns the feature off (each names the field), a warning is
// only logged. lengths: string field lengths by name; edit: the editor tracking field names; optional: for each key of
// cfg.OPTIONAL_FIELDS, whether the layer has that field with its type (text unless cfg.FIELD_TYPES says otherwise; a
// missing one is a warning, not a problem); activity: whether every cfg.ACTIVITY_FIELDS field is there (one warning
// lists the missing ones).
export function checkNotesLayer(layer, cfg = NOTES) {
  const problems = [], warnings = [], lengths = {};
  if (layer?.geometryType !== "point") problems.push(`The notes layer has ${layer?.geometryType ?? "no"} geometry; points are needed.`);
  const byName = new Map((layer?.fields ?? []).map((f) => [f.name, f]));
  const optionalKeys = new Set(cfg.OPTIONAL_FIELDS ?? []);
  const activityKeys = new Set(cfg.ACTIVITY_FIELDS ?? []);
  const optional = {}, activityMissing = [];
  for (const [key, name] of Object.entries(cfg.FIELDS)) {
    if (typeof name !== "string") continue; // the CONTACT and FOLLOWUP groups: contactLogic.checkContactFields
    const f = byName.get(name);
    const type = cfg.FIELD_TYPES?.[key] ?? "string";
    const bad = !f ? `is missing the field ${name}` : f.type !== type ? `has the field ${name} as ${f.type}, not ${type === "string" ? "text" : type}` : "";
    if (optionalKeys.has(key)) {
      optional[key] = !bad;
      if (bad && activityKeys.has(key)) activityMissing.push(bad.replace(/^is missing the field /, "no "));
      else if (bad) warnings.push(`The notes layer ${bad}; notes work without it${key === "URL" ? " (no links)" : ""}.`);
    } else if (bad) problems.push(`The notes layer ${bad}.`);
    if (!bad && f.length > 0) lengths[name] = f.length;
  }
  const activity = activityKeys.size > 0 && activityMissing.length === 0;
  if (activityMissing.length) warnings.push(`The notes layer lacks the activity log fields (${activityMissing.join("; ")}); notes work, without field changes.`);
  const textLength = lengths[cfg.FIELDS.TEXT];
  if (textLength && textLength < cfg.MAX_CHARS) warnings.push(`The notes layer's ${cfg.FIELDS.TEXT} field holds ${textLength} characters, fewer than NOTES.MAX_CHARS (${cfg.MAX_CHARS}); longer notes will be refused by the layer.`);
  const urlLength = lengths[cfg.FIELDS.URL];
  if (urlLength && urlLength < cfg.URL_MAX_CHARS) warnings.push(`The notes layer's ${cfg.FIELDS.URL} field holds ${urlLength} characters, fewer than NOTES.URL_MAX_CHARS (${cfg.URL_MAX_CHARS}); longer links will be refused by the layer.`);
  const e = layer?.editFieldsInfo;
  const edit = { creatorField: e?.creatorField || null, creationDateField: e?.creationDateField || null, editorField: e?.editorField || null, editDateField: e?.editDateField || null };
  for (const [key, what] of [["creatorField", "creator"], ["creationDateField", "created date"], ["editorField", "last editor"], ["editDateField", "last edited date"]]) {
    if (!edit[key]) problems.push(`Editor tracking is off on the notes layer (no ${what} field).`);
    else if (!byName.has(edit[key])) problems.push(`The notes layer's editor tracking field ${edit[key]} isn't in its fields.`);
  }
  return { problems: [...new Set(problems)], warnings, lengths, edit, optional, activity };
}

// ---- the anchor point: one point per note, a snapshot of where the feature was
// geometry: { x, y } | { points } | { paths } | { rings } (plain coordinates, any planar spatial reference).
// ops.labelPoint(geometry) -> [x, y] (the SDK's labelPointOperator), optional; its point is used for a polygon only if
// it really lies inside. Returns [x, y], or null for an empty geometry.
export function anchorPoint(kind, geometry, ops = {}) {
  if (!geometry) return null;
  if (kind === "point") {
    if (Number.isFinite(geometry.x)) return [geometry.x, geometry.y];
    const p = geometry.points?.[0];
    return p ? [p[0], p[1]] : null;
  }
  if (kind === "line") return lineMidpoint(geometry.paths);
  const rings = geometry.rings ?? [];
  if (!rings.some((r) => r.length >= 3)) return null;
  const label = ops.labelPoint?.(geometry);
  if (label && pointInRings(rings, label)) return label;
  const c = centroidOf(rings);
  if (c && pointInRings(rings, c)) return c;
  return interiorPoint(rings);
}

// The point halfway along a polyline (its paths in order, as one length), on the line.
export function lineMidpoint(paths) {
  const segs = [];
  let total = 0;
  for (const path of paths ?? []) {
    for (let i = 1; i < path.length; i++) {
      const len = Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]);
      segs.push([path[i - 1], path[i], len]);
      total += len;
    }
  }
  if (!segs.length) {
    const p = (paths ?? []).find((path) => path.length)?.[0];
    return p ? [p[0], p[1]] : null;
  }
  let left = total / 2;
  for (const [a, b, len] of segs) {
    if (left <= len && len > 0) return [a[0] + ((b[0] - a[0]) * left) / len, a[1] + ((b[1] - a[1]) * left) / len];
    left -= len;
  }
  const [, b] = segs.at(-1);
  return [b[0], b[1]];
}

// Even-odd point in polygon (holes count as outside).
export function pointInRings(rings, [x, y]) {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

function centroidOf(rings) {
  let a = 0, cx = 0, cy = 0;
  for (const ring of rings) {
    for (let i = 0; i < ring.length; i++) {
      const [x0, y0] = ring[i], [x1, y1] = ring[(i + 1) % ring.length];
      const cross = x0 * y1 - x1 * y0;
      a += cross; cx += (x0 + x1) * cross; cy += (y0 + y1) * cross;
    }
  }
  return Math.abs(a) > 1e-12 ? [cx / (3 * a), cy / (3 * a)] : null;
}

// A point inside a polygon: on a horizontal line through it, the middle of the widest inside span. Lines are tried at
// the centroid's height first, then across the polygon's height.
export function interiorPoint(rings) {
  const ys = rings.flat().map((p) => p[1]);
  const ymin = Math.min(...ys), ymax = Math.max(...ys);
  const tries = [centroidOf(rings)?.[1], ...Array.from({ length: 15 }, (_, k) => ymin + ((k + 0.5) / 15) * (ymax - ymin))];
  for (const y of tries) {
    if (!Number.isFinite(y)) continue;
    const xs = [];
    for (const ring of rings) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i], [xj, yj] = ring[j];
        if (yi > y !== yj > y) xs.push(xi + ((y - yi) * (xj - xi)) / (yj - yi));
      }
    }
    xs.sort((p, q) => p - q);
    let best = null;
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const w = xs[k + 1] - xs[k];
      if (w > 0 && (!best || w > best.w)) best = { w, x: (xs[k] + xs[k + 1]) / 2 };
    }
    if (best) return [best.x, y];
  }
  return null;
}
