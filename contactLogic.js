// The contact log (section 51): the pure parts, tested. No DOM and no SDK imports.
//
// A contact is a Notes entry (entry_type contact) with a few structured fields: how the customer got in touch (method),
// who they are (customer type), what about (topics), their details (personal: never in source_label, a heading, the
// console or a URL), whether a permit was submitted, and who spoke with them. It can carry a follow-up for a staff
// member (followup_due, followup_to, followup_to_name). A follow-up is closed by a NEW entry whose followup_of is the
// original's GlobalID (append only: an assignee may not be allowed to update someone else's entry); a retracted closing
// entry reopens it.
import { NOTES } from "./config.js";
import { quote } from "./filterSql.js";
import { newNoteRecord } from "./notesLogic.js";

const present = (v) => v !== null && v !== undefined && String(v).trim() !== "";
const text = (v) => (present(v) ? String(v).trim() : null);

// ---- codes and labels

// A coded value's label from a field's domain ({ type: "coded-value", codedValues: [{ code, name }] }). A code no longer
// in the domain (removed or renamed in AGOL; the stored rows keep it) is shown as the raw code, never blank. No code:
// null.
export function codeLabel(domain, code) {
  if (!present(code)) return null;
  const hit = domain?.type === "coded-value" ? domain.codedValues?.find((c) => String(c.code) === String(code)) : null;
  return hit ? String(hit.name ?? hit.code) : String(code);
}

// A domain's codes in its order, for the composer: only the current ones are offered.
export const domainCodes = (domain) => (domain?.type === "coded-value" ? domain.codedValues.map((c) => ({ code: c.code, label: String(c.name ?? c.code) })) : []);

// topics is a comma list of codes, as Survey123 stores a multi-select. decode: trimmed, empty parts dropped, each code
// once, unknown codes kept. encode: the codes in the given order, joined with "," (no spaces, as Survey123 writes them);
// null for none.
export function decodeTopics(stored) {
  if (!present(stored)) return [];
  return [...new Set(String(stored).split(",").map((s) => s.trim()).filter(Boolean))];
}
export function encodeTopics(codes) {
  const list = [...new Set((codes ?? []).map((c) => String(c ?? "").trim()).filter(Boolean))];
  return list.length ? list.join(",") : null;
}
// A topic's label (cfg TOPICS: [{ code, label }]); an unknown code shows raw.
export const topicLabel = (code, topics = NOTES.CONTACT.TOPICS) => topics.find((t) => String(t.code) === String(code))?.label ?? String(code);

// The one-line row text: "Phone call · Developer · Zoning commercial, Enforcement". contact: contactFrom(...).contact;
// domains: { method, customerType } (the notes layer's domains); missing parts are skipped.
export function contactSummary(contact, domains = {}, topics = NOTES.CONTACT.TOPICS) {
  if (!contact) return "";
  const parts = [codeLabel(domains.method, contact.method), codeLabel(domains.customerType, contact.customerType)];
  const t = (contact.topics ?? []).map((c) => topicLabel(c, topics)).join(", ");
  return [...parts, t].filter(present).join(" · ");
}

// The icon for a method code (cfg METHOD_ICONS, else DEFAULT_ICON).
export const methodIcon = (code, cfg = NOTES.CONTACT) => (present(code) && cfg.METHOD_ICONS?.[String(code)]) || cfg.DEFAULT_ICON;

// ---- customer details

// The href for a stored phone number or email address, or null when it looks odd (then it is shown as plain text). A
// phone: digits, spaces, + (leading only), - ( ) . and 7 to 15 digits, then optionally an extension ("x12", "ext. 12");
// the href keeps the + and the digits, and the extension as ";ext=12" (RFC 3966). An email: one @, a plain local part
// and a dotted domain, nothing that could be a scheme or markup.
export function contactHref(kind, stored) {
  const v = text(stored);
  if (!v || v.length > 255) return null;
  if (kind === "phone") {
    const m = /^(\+?[0-9 ().-]+?)(?:\s*(?:x|ext\.?|extension)\s*(\d{1,6}))?$/i.exec(v);
    if (!m) return null;
    const digits = m[1].replace(/\D/g, "");
    if (digits.length < 7 || digits.length > 15) return null;
    return `tel:${v.startsWith("+") ? "+" : ""}${digits}${m[2] ? `;ext=${m[2]}` : ""}`;
  }
  if (kind === "email") {
    if (!/^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(v)) return null;
    return `mailto:${v}`;
  }
  return null;
}
// The composer's checks of the customer's phone and email (cfg CONTACT.PATTERNS): empty is fine.
export const validPhone = (typed, pattern = NOTES.CONTACT.PATTERNS.PHONE) => !present(typed) || pattern.test(String(typed).trim());
export const validEmail = (typed, pattern = NOTES.CONTACT.PATTERNS.EMAIL) => !present(typed) || (String(typed).trim().length <= 254 && pattern.test(String(typed).trim()));

// ---- the assignee's email (section 57): personal data, never shown, logged or put in a URL

// An address to write: trimmed, and valid by validEmail (an empty value isn't); else null.
export const goodEmail = (v, cfg = NOTES) => (present(v) && validEmail(String(v).trim(), cfg.CONTACT.PATTERNS.EMAIL) ? String(v).trim() : null);

// The staff roster (a hosted table) as a Map from username (lower case) to email. rows: attribute objects; fields:
// { USERNAME, EMAIL } (NOTES.CONTACT.ROSTER.FIELDS). Rows without a username or a valid email are skipped; a username
// twice keeps the first good row.
export function rosterFrom(rows, fields = NOTES.CONTACT.ROSTER.FIELDS, cfg = NOTES) {
  const out = new Map();
  for (const r of rows ?? []) {
    const username = text(r?.[fields.USERNAME]);
    const email = goodEmail(r?.[fields.EMAIL], cfg);
    if (!username || !email || out.has(username.toLowerCase())) continue;
    out.set(username.toLowerCase(), email);
  }
  return out;
}

// The assignee's email, or null: the sources in order (cfg CONTACT.EMAIL_SOURCES), the first valid address wins.
// "portal": the staff list's user with this username (case ignored) and its email; "roster": the roster Map (rosterFrom)
// by username. Only ever by username, never by name, and never built from the username.
export function emailFor(username, { portalUsers = [], roster = null } = {}, sources = NOTES.CONTACT.EMAIL_SOURCES, cfg = NOTES) {
  const key = text(username)?.toLowerCase();
  if (!key) return null;
  for (const source of sources ?? []) {
    let found = null;
    if (source === "portal") found = goodEmail((portalUsers ?? []).find((u) => text(u?.username)?.toLowerCase() === key)?.email, cfg);
    else if (source === "roster") found = goodEmail(roster?.get?.(key), cfg);
    if (found) return found;
  }
  return null;
}

// A phone number that passes validPhone, written one way for reading (section 58): "(area) exchange-line", an extension
// as " ext. 12" (cfg CONTACT.TEXT.PHONE_FORMAT / PHONE_EXT); a leading +1 or 1 is dropped (the numbers are US). Anything
// that doesn't pass (or is empty) is returned unchanged, so a stored value is never lost. contactHref builds the same
// tel: link from the result (the digits, ";ext=12").
export function formatPhone(value, cfg = NOTES) {
  if (!present(value)) return value;
  const v = String(value).trim();
  if (!validPhone(v, cfg.CONTACT.PATTERNS.PHONE)) return value;
  const m = /^(.*?)(?:\s*(?:x|ext\.?|extension)\s*(\d{1,6}))?$/i.exec(v);
  const digits = m[1].replace(/\D/g, "").slice(-10);
  if (digits.length !== 10) return value;
  const T = cfg.CONTACT.TEXT;
  return T.PHONE_FORMAT(digits.slice(0, 3), digits.slice(3, 6), digits.slice(6)) + (m[2] ? T.PHONE_EXT(m[2]) : "");
}

// A person's name as shown and stored: runs of spaces (a portal full name can carry two, as "First  Last") become one.
export const cleanName = (v) => (present(v) ? String(v).replace(/\s+/g, " ").trim() : null);

// ---- reading an entry

// The contact and follow-up parts of an entry's attributes (alongside notesLogic.noteFrom). F: NOTES.FIELDS;
// globalIdField: the notes layer's GlobalID field (null when it has none). Topics decoded; dates as epoch ms.
export function contactFrom(attributes, F = NOTES.FIELDS, globalIdField = null) {
  const a = attributes ?? {};
  const C = F.CONTACT, U = F.FOLLOWUP;
  const ms = (v) => (v instanceof Date ? v.getTime() : Number.isFinite(v) ? v : null);
  const contact = {
    method: text(a[C.METHOD]), customerType: text(a[C.CUSTOMER_TYPE]), topics: decodeTopics(a[C.TOPICS]), permit: text(a[C.PERMIT]),
    name: text(a[C.NAME]), phone: text(a[C.PHONE]), email: text(a[C.EMAIL]), staff: text(a[C.STAFF]), legacyId: text(a[C.LEGACY_ID]),
  };
  const followup = { due: ms(a[U.DUE] ?? null), to: text(a[U.TO]), toName: text(a[U.TO_NAME]), of: text(a[U.OF]) };
  // which feature the entry is on (the Follow-ups list opens it)
  const source = { layerKey: text(a[F.SOURCE_LAYER]), idValue: a[F.SOURCE_ID] ?? null, label: text(a[F.SOURCE_LABEL]) };
  return { globalId: globalIdField ? text(a[globalIdField]) : null, contact, followup, source };
}

// The notes layer checked for the contact log. layer: { fields: [{ name, type, length }], globalIdField, domains:
// { field name: domain } (getFieldDomain, read on every load) }. Every field is optional on its own, but:
//   contact: every CONTACT field is there as text, and method, customer type and permit have coded-value domains
//     (their codes and labels come from there), else Log contact is off;
//   followups: every FOLLOWUP field is there (DUE a date) and the layer has a GlobalID (a closing entry points at it),
//     else follow-ups are off; contacts still work.
//   followupEmail: follow-ups are on and FOLLOWUP.TO_EMAIL is there as text (optional: without it, one info line in
//     `infos` and nothing is written there).
// Returns { contact, followups, followupEmail, globalIdField, domains: { method, customerType, permit }, lengths,
// warnings, infos } (each warning or info is logged once; none when everything is there).
export function checkContactFields(layer, cfg = NOTES) {
  const C = cfg.FIELDS.CONTACT, U = cfg.FIELDS.FOLLOWUP;
  const byName = new Map((layer?.fields ?? []).map((f) => [f.name, f]));
  const lengths = {}, warnings = [];
  const check = (name, type) => {
    const f = byName.get(name);
    if (!f) return `no ${name}`;
    if (f.type !== type) return `${name} is ${f.type}, not ${type === "string" ? "text" : type}`;
    if (f.length > 0) lengths[name] = f.length;
    return "";
  };
  const domainOf = (name) => {
    const d = layer?.domains?.[name] ?? byName.get(name)?.domain ?? null;
    return d?.type === "coded-value" ? d : null;
  };
  const contactBad = Object.values(C).map((n) => check(n, "string")).filter(Boolean);
  for (const name of [C.METHOD, C.CUSTOMER_TYPE, C.PERMIT]) if (byName.has(name) && !domainOf(name)) contactBad.push(`${name} has no coded-value domain`);
  const contact = contactBad.length === 0;
  if (!contact) warnings.push(`The notes layer lacks the contact log fields (${contactBad.join("; ")}); Log contact is off, notes work.`);
  // TO_EMAIL is optional (section 57): without it, follow-ups work and nothing is written there
  const followBad = Object.entries(U).filter(([key]) => key !== "TO_EMAIL").map(([key, n]) => check(n, key === "DUE" ? "date" : "string")).filter(Boolean);
  const gidField = layer?.globalIdField || (layer?.fields ?? []).find((f) => f.type === "global-id")?.name || null;
  if (!gidField) followBad.push("no GlobalID field");
  const followups = contact && followBad.length === 0;
  if (contact && followBad.length) warnings.push(`The notes layer lacks what follow-ups need (${followBad.join("; ")}); follow-ups are off, contacts work.`);
  const infos = [];
  const followupEmail = followups && !!U.TO_EMAIL && check(U.TO_EMAIL, "string") === "";
  if (followups && !followupEmail) infos.push(cfg.CONTACT.TEXT.EMAIL_FIELD_MISSING);
  return {
    contact, followups, followupEmail, globalIdField: gidField, lengths, warnings, infos,
    domains: { method: domainOf(C.METHOD), customerType: domainOf(C.CUSTOMER_TYPE), permit: domainOf(C.PERMIT) },
  };
}

// GlobalIDs compared as the same: braces and letter case ignored ("{ABC-1}" and "abc-1").
export const gidKey = (g) => (present(g) ? String(g).trim().replace(/^\{|\}$/g, "").toUpperCase() : "");
export const sameGlobalId = (a, b) => gidKey(a) !== "" && gidKey(a) === gidKey(b);

// ---- writing an entry

// The attributes of a new contact, or { error }. input: { text, url, eventDate (ms), method, customerType, topics:
// [codes], permit, name, phone, email, staff, followup: { to, toName, due (ms) } | null, followupOf: GlobalID | null }.
// opts: { authorName, lengths (field lengths by name), require (field names that must be set, cfg.CONTACT.REQUIRE),
// followups (the layer has the follow-up fields and a GlobalID), emailField (it also has FOLLOWUP.TO_EMAIL), labels
// ({ field name: label } for the message) }. followup.toEmail: the assignee's email (emailFor), written only when valid,
// else null; with emailField false the field is left out.
// The note text is optional for a contact. A follow-up needs both a person and a day. Personal details go only into
// their own fields: source_label is the target's label, as for any note.
export function newContactRecord(input, target, { authorName = null, lengths = {}, require = NOTES.CONTACT.REQUIRE, followups = true, emailField = false, labels = {} } = {}, cfg = NOTES) {
  const F = cfg.FIELDS, C = F.CONTACT, U = F.FOLLOWUP, T = cfg.CONTACT.TEXT;
  const i = input ?? {};
  const values = {
    [C.METHOD]: text(i.method), [C.CUSTOMER_TYPE]: text(i.customerType), [C.TOPICS]: encodeTopics(i.topics), [C.PERMIT]: text(i.permit),
    [C.NAME]: cleanName(i.name), [C.PHONE]: formatPhone(text(i.phone), cfg), [C.EMAIL]: text(i.email), [C.STAFF]: cleanName(i.staff),
  };
  const missing = (require ?? []).filter((name) => name in values ? !present(values[name]) : false);
  if (missing.length) return { error: T.REQUIRED(missing.map((n) => labels[n] ?? n)) };
  if (!validPhone(values[C.PHONE], cfg.CONTACT.PATTERNS.PHONE)) return { error: T.PHONE_BAD };
  if (!validEmail(values[C.EMAIL], cfg.CONTACT.PATTERNS.EMAIL)) return { error: T.EMAIL_BAD };
  const f = i.followup;
  if (f && (!present(f.to) || !Number.isFinite(f.due))) return { error: T.FOLLOWUP_INCOMPLETE };
  const base = newNoteRecord(i.text, target, {
    authorName, lengths, url: i.url ?? null,
    entry: { entryType: cfg.ENTRY_TYPES.CONTACT, eventDate: Number.isFinite(i.eventDate) ? i.eventDate : Date.now(), origin: cfg.ORIGINS.APP, changesJson: null },
  }, cfg);
  if (base.error) return base;
  const cut = (field, v) => (v === null || v === undefined ? null : lengths[field] > 0 ? String(v).slice(0, lengths[field]) : v);
  const attributes = { ...base.attributes };
  for (const [field, v] of Object.entries(values)) attributes[field] = cut(field, v);
  if (followups) {
    attributes[U.DUE] = f ? f.due : null;
    attributes[U.TO] = f ? cut(U.TO, text(f.to)) : null;
    attributes[U.TO_NAME] = f ? cut(U.TO_NAME, cleanName(f.toName)) : null;
    attributes[U.OF] = present(i.followupOf) ? cut(U.OF, String(i.followupOf).trim()) : null;
    if (emailField && U.TO_EMAIL) attributes[U.TO_EMAIL] = f ? cut(U.TO_EMAIL, goodEmail(f.toEmail, cfg)) : null;
  }
  return { attributes };
}

// "Close without contact": a comment that closes a follow-up, with a required one-line reason, or { error }. original:
// the entry whose follow-up it closes (its globalId). entry: { eventDate } (default now); followup: a new follow-up on
// this closing entry (Reassign: { to, toName, due, toEmail }), or null. emailField: as for newContactRecord.
export function newFollowupClose(reason, original, target, { authorName = null, lengths = {}, followup = null, emailField = false, eventDate = Date.now() } = {}, cfg = NOTES) {
  const F = cfg.FIELDS, U = F.FOLLOWUP, T = cfg.CONTACT.TEXT;
  const line = String(reason ?? "").replace(/\s+/g, " ").trim();
  if (!line) return { error: T.CLOSE_REASON_NEEDED };
  if (!present(original?.globalId)) return { error: "The follow-up to close has no GlobalID." };
  if (followup && (!present(followup.to) || !Number.isFinite(followup.due))) return { error: T.FOLLOWUP_INCOMPLETE };
  const base = newNoteRecord(line, target, { authorName, lengths, entry: { entryType: cfg.ENTRY_TYPES.COMMENT, eventDate, origin: cfg.ORIGINS.APP, changesJson: null } }, cfg);
  if (base.error) return base;
  const cut = (field, v) => (v === null || v === undefined ? null : lengths[field] > 0 ? String(v).slice(0, lengths[field]) : v);
  return {
    attributes: {
      ...base.attributes,
      [U.OF]: cut(U.OF, String(original.globalId).trim()),
      [U.DUE]: followup ? followup.due : null,
      [U.TO]: followup ? cut(U.TO, text(followup.to)) : null,
      [U.TO_NAME]: followup ? cut(U.TO_NAME, cleanName(followup.toName)) : null,
      ...(emailField && U.TO_EMAIL ? { [U.TO_EMAIL]: followup ? cut(U.TO_EMAIL, goodEmail(followup.toEmail, cfg)) : null } : {}),
    },
  };
}

// ---- days

// A local calendar day as a number (20261106), for comparing days whatever the time.
export const dayKey = (ms) => { const d = new Date(ms); return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate(); };
// A follow-up is overdue once its due day is behind today (due today is not overdue).
export const isOverdue = (due, now = Date.now()) => Number.isFinite(due) && dayKey(due) < dayKey(now);
// "2026-11-06" (an <input type=date> / calcite-input-date-picker value) for a day; and back, as that day at `hour`
// local time (noon: the stored day reads the same in any time zone).
export const dayValue = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
export function dueFromDay(value, hour = NOTES.CONTACT.FOLLOWUP.DUE_HOUR) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? ""));
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), hour, 0, 0, 0);
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}
// The default due day: `days` calendar days after today.
export const defaultDueDay = (now = Date.now(), days = NOTES.CONTACT.FOLLOWUP.DEFAULT_DAYS) => { const d = new Date(now); d.setDate(d.getDate() + days); return dayValue(d.getTime()); };

// ---- follow-up state

// Each follow-up's state among `entries` (activity entries with globalId, status, followup, eventTime, created,
// objectId). Returns a Map from gidKey(original) to { entry, state: "open" | "overdue" | "closed", due, dueToday,
// closing }. A follow-up is an active entry with a due day; it is closed by the earliest active entry whose followup_of
// is its GlobalID (two closings: still closed, by the first). A retracted closing entry doesn't count, so the follow-up
// is open again. A retracted entry's follow-up is no follow-up at all. Entries without a GlobalID can't be closed and
// are left out.
export function followupState(entries, now = Date.now(), cfg = NOTES) {
  const active = (e) => e.status !== cfg.STATUS.RETRACTED;
  const t = (v) => (Number.isFinite(v) ? v : Infinity);
  const closings = new Map();
  for (const e of entries ?? []) {
    const of = gidKey(e.followup?.of);
    if (!of || !active(e)) continue;
    const prev = closings.get(of);
    if (!prev || t(e.eventTime) < t(prev.eventTime) || (t(e.eventTime) === t(prev.eventTime) && t(e.created) < t(prev.created))) closings.set(of, e);
  }
  const out = new Map();
  for (const e of entries ?? []) {
    const key = gidKey(e.globalId);
    if (!key || !active(e) || !Number.isFinite(e.followup?.due)) continue;
    const closing = closings.get(key) ?? null;
    const due = e.followup.due;
    const state = closing ? "closed" : isOverdue(due, now) ? "overdue" : "open";
    out.set(key, { entry: e, state, due, dueToday: dayKey(due) === dayKey(now), closing });
  }
  return out;
}

// The open follow-ups in list order: overdue first, then oldest due first (then oldest logged).
export function sortFollowups(list, now = Date.now()) {
  const t = (v) => (Number.isFinite(v) ? v : Infinity);
  return [...list].sort((a, b) => Number(isOverdue(b.due, now)) - Number(isOverdue(a.due, now)) || t(a.due) - t(b.due) || t(a.entry?.created) - t(b.entry?.created));
}

// ---- the follow-up queries (the header count and the Follow-ups block)

// Follow-ups assigned to `username` (ignoring case), with a due day, active.
export function mineWhere(username, F = NOTES.FIELDS, cfg = NOTES) {
  return `UPPER(${F.FOLLOWUP.TO}) = ${quote(String(username ?? "").trim().toUpperCase())} AND ${F.FOLLOWUP.DUE} IS NOT NULL AND ${F.STATUS} = ${quote(cfg.STATUS.ACTIVE)}`;
}
// Every active follow-up (the "All open" tab).
export const allOpenWhere = (F = NOTES.FIELDS, cfg = NOTES) => `${F.FOLLOWUP.DUE} IS NOT NULL AND ${F.STATUS} = ${quote(cfg.STATUS.ACTIVE)}`;
// Active entries that close any of these GlobalIDs: each one with and without braces, upper case (followup_of is
// compared in upper case, as stored text may differ in case). null for no ids.
export function closingsWhere(globalIds, F = NOTES.FIELDS, cfg = NOTES) {
  const keys = [...new Set((globalIds ?? []).map(gidKey).filter(Boolean))];
  if (!keys.length) return null;
  const values = keys.flatMap((k) => [quote(`{${k}}`), quote(k)]);
  return `UPPER(${F.FOLLOWUP.OF}) IN (${values.join(", ")}) AND ${F.STATUS} = ${quote(cfg.STATUS.ACTIVE)}`;
}

// ---- the assignee list

// The people a follow-up can be assigned to: pages of portal users ([{ username, fullName }]) merged, each username once
// (ignoring case; the first full name seen wins), sorted by name (the username when there is no full name), with the
// signed-in user (`me`: { username, fullName }) first even when the search didn't return them.
// Returns [{ username, fullName, name, isMe }] (name: what to show), with `email` when the search returned one (personal
// data: never shown, never logged; section 57 writes it to followup_to_email).
export function staffList(pages, me = null) {
  const seen = new Map();
  for (const u of (pages ?? []).flat()) {
    const username = text(u?.username);
    if (!username || seen.has(username.toLowerCase())) continue;
    const email = text(u.email);
    seen.set(username.toLowerCase(), { username, fullName: cleanName(u.fullName), ...(email ? { email } : {}) });
  }
  const meKey = text(me?.username)?.toLowerCase() ?? null;
  const name = (u) => u.fullName || u.username;
  const others = [...seen.entries()].filter(([k]) => k !== meKey).map(([, u]) => ({ ...u, name: name(u), isMe: false }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.username.localeCompare(b.username));
  if (!meKey) return others;
  const mine = seen.get(meKey) ?? { username: text(me.username), fullName: text(me.fullName) };
  const myEmail = mine.email || text(me.email);
  const meRow = { username: mine.username, fullName: mine.fullName || cleanName(me.fullName), ...(myEmail ? { email: myEmail } : {}), isMe: true };
  return [{ ...meRow, name: name(meRow) }, ...others];
}

// The email probe's counts (section 57): how many people the assignee list holds and how many came with an email
// address. Counts only: no address or username leaves this.
export const emailCounts = (list) => ({ members: (list ?? []).length, withEmail: (list ?? []).filter((u) => present(u?.email)).length });

// A follow-up's assignee as shown: followup_to_name as stored, else the username.
export const assigneeName = (followup) => followup?.toName || followup?.to || "";
