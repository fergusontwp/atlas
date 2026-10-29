// Pure SQL and matching rules for the parcel search and for ?parcel=. No DOM and no SDK imports, so it can be tested alone.
//
// entry = { field, label, normalize? } (a SEARCH.FIELDS entry). `normalize` is for IDs stored with punctuation,
// like "12-345-,678-,0000-": the user may type the stored format or only the letters and digits.
//
// The service is never asked to strip punctuation (REPLACE and friends weren't verifiable). Instead the typed
// letters and digits become a pattern with a wildcard between each ("%2%4%0%0%4%…%"), which finds every stored
// value containing them in order, and the browser then keeps only the values that really contain them as a run
// once punctuation is ignored (alnum(value).includes(alnum(text))).
import { quote } from "./filterSql.js";

export const clean = (text) => String(text ?? "").trim();
// Letters and digits only, uppercase: "12-345-,678-,0000-" -> "123456780000".
export const alnum = (text) => String(text ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
// % and _ typed by the user are wildcards, the same as in the filter box.
export const hasWildcard = (text) => /[%_]/.test(String(text ?? ""));
export const meetsMinChars = (text, min) => clean(text).length >= min;

export const containsWhere = (field, text) => `UPPER(${field}) LIKE ${quote(`%${clean(text).toUpperCase()}%`)}`;
export const exactWhere = (field, text) => `UPPER(${field}) = ${quote(clean(text).toUpperCase())}`;
export const looseWhere = (field, text) => `UPPER(${field}) LIKE ${quote(`%${[...alnum(text)].join("%")}%`)}`;

// True when this entry is searched by letters and digits only (so a typed wildcard keeps plain "contains").
export const usesLooseMatch = (entry, text) => !!entry.normalize && !hasWildcard(text) && alnum(text) !== "";

// The where clause for one configured field.
export const searchWhere = (entry, text) =>
  usesLooseMatch(entry, text) ? looseWhere(entry.field, text) : containsWhere(entry.field, text);

// -1: not a match (a false positive of the loose pattern), 0: starts with the text, 1: contains it.
// With typed wildcards the service's answer stands and nothing can be told apart, so that is 1.
export function matchRank(entry, value, text) {
  const t = clean(text);
  if (usesLooseMatch(entry, t)) {
    const at = alnum(value).indexOf(alnum(t));
    return at < 0 ? -1 : at === 0 ? 0 : 1;
  }
  if (hasWildcard(t)) return 1;
  const at = String(value ?? "").toUpperCase().indexOf(t.toUpperCase());
  return at < 0 ? -1 : at === 0 ? 0 : 1;
}

// ---- ?parcel=<id>
// An exact match on the ID as stored, else (when letters and digits were given) a loose query verified by sameId().
export function lookupWheres(field, text) {
  const t = clean(text);
  return { exact: exactWhere(field, t), loose: alnum(t) !== "" ? looseWhere(field, t) : null };
}
export const sameAsStored = (value, text) => clean(value).toUpperCase() === clean(text).toUpperCase();
export const sameId = (value, text) => alnum(value) !== "" && alnum(value) === alnum(text);
