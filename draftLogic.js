// Notes drafts and sign-out (section 59): pure.

const blank = (v) => !String(v ?? "").trim();

// What a stored Contact draft holds beyond the defaults (contactComposer's draft()).
export const contactDraftHasContent = (d) => !!d && !!(d.method?.length || d.customerType?.length || d.topics?.length || [d.name, d.phone, d.email].some((v) => !blank(v))
  || d.permit || (d.staff !== null && d.staff !== undefined) || d.follow || d.closing || d.when);

// What a stored Notes draft holds beyond the defaults (notesDialog's saveDraft: { text, url, act, mode, contact, files }):
// text, a link, proposed field changes, files (files alone count), or a Contact draft with content.
export const noteDraftHasContent = (d) => !!d && !!(!blank(d.text) || !blank(d.url) || Object.keys(d.act?.proposed ?? {}).length || d.files?.length
  || (d.mode === "contact" && contactDraftHasContent(d.contact)));

// Unsaved work before signing out: any draft with content, or an entry's files still uploading (or failed and waiting
// for Retry). Returns { unsaved, drafts (how many have content), uploading }.
export function unsavedWork({ drafts = [], uploading = false } = {}) {
  const n = (drafts ?? []).filter(noteDraftHasContent).length;
  return { unsaved: n > 0 || !!uploading, drafts: n, uploading: !!uploading };
}

// Where sign-out sends the browser: the app's base URL (no query, so no ?parcel=, ?entry= or ?style=, and no hash), or,
// with endSession, the portal's OAuth sign-out first, which then returns there (redirect_uri must be registered on the
// app's credential).
export function signOutUrl({ href, portalUrl, appId, endSession = true, path = "/sharing/rest/oauth2/signout" }) {
  const u = new URL(href);
  const base = `${u.origin}${u.pathname}`;
  if (!endSession || !appId || !portalUrl) return base;
  const out = new URL(String(portalUrl).replace(/^http:/i, "https:").replace(/\/+$/, "") + path);
  out.searchParams.set("client_id", appId);
  out.searchParams.set("redirect_uri", base);
  return out.toString();
}
