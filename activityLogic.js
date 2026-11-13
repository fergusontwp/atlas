// The activity log (notes with field changes): the pure parts, tested. No DOM and no SDK imports.
//
// A source with `activity` (NOTES.SOURCES) lets staff change some of the feature's own fields from the Notes dialog, in
// the same entry as a note. An entry stores what changed in changes_json: [{ field, label, from, to, fromLabel, toLabel }]
// (codes and their labels, so an old entry still reads right if a domain changes). The feature's layer stays the current
// state; the notes layer is its history.
import { NOTES } from "./config.js";

const DAY_MS = 86400000;

// A field name that is still a config placeholder (Jackson confirms the real one).
export const isPlaceholderField = (name) => !name || /^REQUESTS_/.test(String(name));

// A value as compared and stored: null for null, undefined and blank text; text trimmed; a Date as epoch ms.
export function normValue(v) {
  if (v === undefined || v === null) return null;
  if (v instanceof Date) return v.getTime();
  if (typeof v === "string") {
    const t = v.trim();
    return t === "" ? null : t;
  }
  return v;
}
// Equal as stored values ("3" and 3 are equal: a coded value read back from an input is text).
export function sameValue(a, b) {
  const x = normValue(a), y = normValue(b);
  return x === y || (x !== null && y !== null && String(x) === String(y));
}

// The source's activity config checked against its layer. layer: { fields: [{ name, type, editable, length, domain }] }.
// Returns { ok, reason, editsEnabled, edits, receivedField, legacyNotesField, closedStatuses, chips }: editsEnabled is
// the config's switch (only true turns field changes on; the edits are still resolved, since the timeline's duration
// reads the status field); edits with the layer's real field
// names (matched ignoring case), `editable` (the field's own flag), `length`, and for input "domain" its coded values
// [{ code, name }] (a field with no coded-value domain becomes a free "list"). Not ok while a field name is a
// placeholder or missing from the layer (the reason says which); notes still work then, without field changes.
export function resolveActivity(activity, layer) {
  if (!activity?.edits?.length) return { ok: false, reason: "", edits: [] };
  const fields = layer?.fields ?? [];
  const fieldOf = (name) => fields.find((f) => f.name.toLowerCase() === String(name ?? "").toLowerCase()) ?? null;
  const placeholders = [...activity.edits.map((e) => e.field), activity.receivedField]
    .filter((n) => n !== undefined && n !== null && isPlaceholderField(n));
  const chipCodes = (activity.chips ?? []).flatMap((c) => Object.values(c.set ?? {})).filter((v) => typeof v === "string" && isPlaceholderField(v));
  if (placeholders.length || chipCodes.length) return { ok: false, reason: `placeholders in config: ${[...placeholders, ...chipCodes].join(", ")}`, edits: [] };
  const missing = [...activity.edits.map((e) => e.field), activity.receivedField, activity.legacyNotesField].filter((n) => n && !fieldOf(n));
  if (missing.length) return { ok: false, reason: `the layer has no ${missing.join(", ")} field`, edits: [] };
  const edits = activity.edits.map((e) => {
    const f = fieldOf(e.field);
    const coded = f.domain?.type === "coded-value" ? f.domain.codedValues.map((c) => ({ code: c.code, name: String(c.name ?? c.code) })) : null;
    const input = e.input === "domain" && !coded ? "list" : e.input;
    return { ...e, field: f.name, input, codedValues: input === "domain" ? coded : null, list: e.list ?? [], editable: f.editable !== false, length: f.length > 0 ? f.length : null };
  });
  const byKey = new Map(edits.map((e) => [e.key, e]));
  const chips = (activity.chips ?? []).filter((c) => Object.keys(c.set ?? {}).every((k) => byKey.has(k)) && (!c.expand || byKey.has(c.expand)));
  return {
    ok: true, reason: "", editsEnabled: activity.editsEnabled === true, edits, chips,
    receivedField: activity.receivedField ? fieldOf(activity.receivedField).name : null,
    legacyNotesField: activity.legacyNotesField ? fieldOf(activity.legacyNotesField).name : null,
    closedStatuses: activity.closedStatuses ?? [],
  };
}

// What the composer shows for a feature with an activity log: "fields" (the field changes around the note box), "note"
// (the note box and one line saying the account can't change the feature) or "plain" (the plain note box: no
// activity, or its field edits switched off).
export function composerKind(resolved, canUpdate) {
  if (!resolved?.ok || !resolved.editsEnabled) return "plain";
  return canUpdate ? "fields" : "note";
}

// A value as shown: a coded value's name, else the text; null for no value.
export function labelOf(edit, value) {
  const v = normValue(value);
  if (v === null) return null;
  const coded = edit?.codedValues?.find((c) => String(c.code) === String(v));
  return coded ? coded.name : String(v);
}

// What would change: for each edit whose field is in `proposed` and differs from `current` (values by field name),
// { field, label, from, to, fromLabel, toLabel }. Unchanged fields are left out; a cleared field has to: null.
export function diffChanges(edits, current, proposed) {
  const out = [];
  for (const e of edits) {
    if (!proposed || !(e.field in proposed)) continue;
    const from = normValue(current?.[e.field]);
    let to = normValue(proposed[e.field]);
    if (sameValue(from, to)) continue;
    // keep a coded value's own type (a number code stays a number)
    const coded = e.codedValues?.find((c) => String(c.code) === String(to));
    if (coded) to = coded.code;
    out.push({ field: e.field, label: e.label, from, to, fromLabel: labelOf(e, from), toLabel: labelOf(e, to) });
  }
  return out;
}

// The fields being changed that someone else changed since the dialog showed them: [{ field, label, now, nowLabel }].
// Fields the user isn't changing are ignored.
export function staleFields(changes, shown, fresh, edits = []) {
  return (changes ?? []).filter((c) => !sameValue(shown?.[c.field], fresh?.[c.field])).map((c) => {
    const e = edits.find((x) => x.field === c.field);
    return { field: c.field, label: c.label, now: normValue(fresh?.[c.field]), nowLabel: labelOf(e, fresh?.[c.field]) };
  });
}

const VALUE_KEYS = ["from", "to", "fromLabel", "toLabel"];
// changes_json for an entry, or null for no changes. Longer than maxChars: long text values are shortened (with "…",
// the change flagged truncated) until it fits.
export function encodeChanges(changes, maxChars = NOTES.ACTIVITY.CHANGES_MAX_CHARS) {
  if (!changes?.length) return null;
  let json = JSON.stringify(changes);
  for (let cap = 2000; json.length > maxChars && cap >= 10; cap = Math.floor(cap / 2)) {
    json = JSON.stringify(changes.map((c) => {
      const o = { ...c };
      for (const k of VALUE_KEYS) {
        if (typeof o[k] === "string" && o[k].length > cap) { o[k] = `${o[k].slice(0, cap)}…`; o.truncated = true; }
      }
      return o;
    }));
  }
  return json.length <= maxChars ? json : null;
}

// changes_json read tolerantly: { changes, bad }. bad is the stored text when it isn't a list of changes this app can
// read (shown as plain text); never throws.
export function decodeChanges(text) {
  if (text === null || text === undefined || String(text).trim() === "") return { changes: [], bad: null };
  let value;
  try {
    value = JSON.parse(String(text));
  } catch {
    return { changes: [], bad: String(text) };
  }
  const list = Array.isArray(value) ? value : null;
  if (!list) return { changes: [], bad: String(text) };
  const str = (v) => (v === null || v === undefined ? null : typeof v === "object" ? JSON.stringify(v) : String(v));
  const changes = list.filter((c) => c && typeof c === "object" && typeof c.field === "string").map((c) => ({
    field: c.field, label: str(c.label) ?? c.field, from: c.from ?? null, to: c.to ?? null,
    fromLabel: str(c.fromLabel) ?? str(c.from), toLabel: str(c.toLabel) ?? str(c.to), truncated: !!c.truncated,
  }));
  return { changes, bad: changes.length === list.length ? null : String(text) };
}

// A note (notesLogic.noteFrom) as an activity entry, with the defaults for old rows (nulls in the four fields): type
// comment, origin app, event time = the creation date, no changes. loggedLate: logged more than LATE_LOG_MS after (or
// before) the event.
export function entryOf(note, cfg = NOTES) {
  const types = Object.values(cfg.ENTRY_TYPES), origins = Object.values(cfg.ORIGINS);
  const entryType = types.includes(note.entryType) ? note.entryType : cfg.ENTRY_TYPES.COMMENT;
  const origin = origins.includes(note.origin) ? note.origin : cfg.ORIGINS.APP;
  const eventTime = Number.isFinite(note.eventDate) ? note.eventDate : note.created ?? null;
  const { changes, bad } = decodeChanges(note.changesJson);
  const loggedLate = Number.isFinite(note.eventDate) && Number.isFinite(note.created) && Math.abs(note.created - note.eventDate) > cfg.ACTIVITY.LATE_LOG_MS;
  return { ...note, entryType, origin, eventTime, changes, badChanges: bad, loggedLate };
}

// Newest first by event time (then logged time, then object id); entries with no time last.
export function sortEntries(entries) {
  const t = (v) => (Number.isFinite(v) ? v : -Infinity);
  return [...entries].sort((a, b) => t(b.eventTime) - t(a.eventTime) || t(b.created) - t(a.created) || (b.objectId ?? 0) - (a.objectId ?? 0));
}

// "Open for 12 days" or "Resolved in 5 days": { state: "open" | "closed", days } or null. The state comes from the
// feature's current status; a closed one is timed to the latest entry that moved the status into a closed one (a
// reopened and closed-again request counts from its last closing). Snapshots don't count (their time isn't the
// closing time): closed with no such entry gives days null. No closed statuses configured, no received time, or a
// closing before the request was received (bad data): null.
export function openDuration({ received, status, entries = [], closedStatuses = [], statusField, now }) {
  if (!closedStatuses.length || !Number.isFinite(received)) return null;
  const closed = (v) => v !== null && v !== undefined && closedStatuses.some((c) => String(c) === String(v));
  if (!closed(status)) return received > now ? null : { state: "open", days: Math.floor((now - received) / DAY_MS) };
  const closings = entries.filter((e) => e.entryType !== NOTES.ENTRY_TYPES.SNAPSHOT && Number.isFinite(e.eventTime)
    && e.changes.some((c) => c.field === statusField && closed(c.to) && !closed(c.from)));
  if (!closings.length) return { state: "closed", days: null };
  const last = Math.max(...closings.map((e) => e.eventTime));
  if (last < received) return null;
  return { state: "closed", days: Math.floor((last - received) / DAY_MS) };
}

// "Status: New → Resolved"; a value longer than max is shortened. T: NOTES.TEXT.
export function changeLine(change, T = NOTES.TEXT, max = Infinity) {
  const v = (s) => (s === null || s === undefined ? T.NONE : s.length > max ? `${s.slice(0, max)}…` : s);
  return `${change.label}: ${v(change.fromLabel)} → ${v(change.toLabel)}`;
}
// A snapshot's line: "Status: New".
export const snapshotLine = (change, T = NOTES.TEXT) => `${change.label}: ${change.toLabel ?? T.NONE}`;
// The composer's preview: "Status: New → Resolved. Assigned to: (none) → Dana."
// (A line that already ends in a full stop doesn't get a second one.)
export const previewText = (changes, T = NOTES.TEXT, max = 60) => changes.map((c) => changeLine(c, T, max).replace(/[.!?…]?$/, (m) => m || ".")).join(" ");

// The fields a chip sets, by field name: { field: value }. "@me" is `me` (the signed-in user's full name); a chip asking
// for "@me" with no name known sets nothing for that field.
export function chipValues(chip, edits, me) {
  const out = {};
  for (const [key, value] of Object.entries(chip.set ?? {})) {
    const e = edits.find((x) => x.key === key);
    if (!e) continue;
    const v = value === "@me" ? normValue(me) : value;
    if (v !== null) out[e.field] = v;
  }
  return out;
}
