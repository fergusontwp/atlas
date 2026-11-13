import { NOTES } from "./config.js";
import { quote } from "./filterSql.js";

// Opening one Notes entry from a link (section 57): <app URL>?entry=<GlobalID>, the link a follow-up email carries.
// Pure: the parameter, the where clause and the entry's target. notes.js opens it.

const GUID = /^\{?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\}?$/i;

// The ?entry= value: null when absent or empty; { gid } (braced, upper case, as AGOL stores a GlobalID) for a GUID with
// or without braces in any case; { error } for anything else (it is ignored, with one console warning).
export function parseEntryParam(value) {
  const v = value === null || value === undefined ? "" : String(value).trim();
  if (!v) return null;
  const m = GUID.exec(v);
  if (!m || (v.startsWith("{") !== v.endsWith("}"))) return { error: "not a GlobalID" };
  return { gid: `{${m[1].toUpperCase()}}` };
}

// The where clause for one entry by GlobalID: the braced and unbraced forms, so a layer storing either matches.
export const entryWhere = (gid, gidField) => {
  const bare = String(gid).replace(/^\{|\}$/g, "");
  return `${gidField} IN (${quote(`{${bare}}`)}, ${quote(bare)})`;
};

// The Notes target an entry belongs to, from its stored source fields (contactFrom's `source`: layerKey, idValue,
// label), for opening the dialog without a selection; null when the source isn't one in cfg SOURCES.
export function storedTarget(entry, cfg = NOTES) {
  const src = entry?.source;
  const source = cfg.SOURCES.find((s) => s.key === src?.layerKey);
  if (!source || src.idValue === null || src.idValue === undefined || String(src.idValue) === "") return null;
  const idValue = String(src.idValue);
  const group = !!source.group;
  return {
    layerKey: source.key, idFields: source.idFields, idField: source.idFields?.[0] ?? null, idValue, label: src.label || idValue,
    scope: group ? "group" : "feature", noun: source.noun, layerTitle: source.title ?? "", subtitle: group ? cfg.TEXT.ALL_SEGMENTS(idValue) : source.title ?? "",
    unstable: false, key: `${source.key}\n${idValue}`, parcel: !!source.parcel,
  };
}
