import { CONFIG, NOTES } from "./config.js";
import { emailFor, rosterFrom, staffList } from "./contactLogic.js";

// The people a follow-up can be assigned to (section 51), read at run time with the user's own token: no list in config
// (the repo is public). Asked once per session, on the first need.
//
// Default: the organization's members. Portal.queryUsers with "orgid:<portal.id>" (the term the SDK itself adds to
// searches limited to an organization, Portal.extraQuery in 5.1), STAFF_PAGE at a time (100 at most), start/num until
// every result is read. A user search only returns members whose profile others may see, so members with a private
// profile can be missing for a non-admin: the API gives no count of them, so the console says how many were found and
// that private profiles aren't listed. Nothing is guessed.
// With NOTES.CONTACT.STAFF_SOURCE.GROUP_ID: that group's members instead (PortalGroup.fetchMembers gives usernames; the
// full names are then searched by username, and anyone the search doesn't return shows by username).
// Either way the signed-in user comes first ("@me", contactLogic.staffList), and if the list can't be read the picker
// offers only them, with one line and a console warning.
//
// Emails (section 57): each member's PortalUser.email is kept from the same search, with no second request. The SDK
// says personal details such as the email are returned only to the user and to their organization's administrators, so
// for a non-admin the list normally has only their own address. They are never shown or logged.
// opts: { portal () -> Promise of a loaded Portal (default: one with authMode "no-prompt", so this never starts a
// sign-in), groupId, pageSize }. Returns { load() -> Promise of { list, ok, source: "org" | "group", found, admin } }
// (admin: the signed-in user's role is org_admin).
export function createStaffDirectory({ portal = defaultPortal, groupId = NOTES.CONTACT.STAFF_SOURCE.GROUP_ID, pageSize = NOTES.CONTACT.STAFF_PAGE } = {}) {
  const num = Math.max(1, Math.min(100, pageSize));
  let loading = null;

  async function orgMembers(p) {
    if (!p.id) throw new Error("this portal has no organization to search");
    const pages = [];
    let start = 1, total = Infinity;
    for (let n = 0; n < 200 && start <= total; n++) {
      const r = await p.queryUsers({ query: `orgid:${p.id}`, num, start, sortField: "username", sortOrder: "asc" });
      const results = r.results ?? [];
      total = Number.isFinite(r.total) ? r.total : start + results.length - 1;
      pages.push(results.map((u) => ({ username: u.username, fullName: u.fullName, email: u.email })));
      if (!results.length) break;
      start += results.length;
    }
    return pages;
  }

  async function groupMembers(p) {
    const groups = await p.queryGroups({ query: `id:${groupId}`, num: 1 });
    const group = groups.results?.[0];
    if (!group) throw new Error(`no group ${groupId} (or it isn't shared with you)`);
    const m = await group.fetchMembers();
    const usernames = [...new Set([m.owner, ...(m.admins ?? []), ...(m.users ?? [])].filter(Boolean))];
    const named = [];
    for (let i = 0; i < usernames.length; i += 20) {
      const chunk = usernames.slice(i, i + 20);
      try {
        const r = await p.queryUsers({ query: chunk.map((u) => `username:${u}`).join(" OR "), num: 100 });
        named.push(...(r.results ?? []).map((u) => ({ username: u.username, fullName: u.fullName, email: u.email })));
      } catch (err) {
        console.warn("Assignee list: couldn't read the group members' full names; they show by user name:", err?.message ?? String(err)); // the message only: the query names colleagues
      }
    }
    // members the search didn't return (a private profile) still count, by username
    const byName = new Map(named.map((u) => [String(u.username).toLowerCase(), u]));
    return [usernames.map((u) => byName.get(u.toLowerCase()) ?? { username: u, fullName: null })];
  }

  async function load() {
    let p = null;
    try {
      p = await portal();
      const me = p.user ? { username: p.user.username, fullName: p.user.fullName, email: p.user.email } : null;
      const source = groupId ? "group" : "org";
      const pages = groupId ? await groupMembers(p) : await orgMembers(p);
      const list = staffList(pages, me);
      const found = new Set(pages.flat().map((u) => String(u.username ?? "").toLowerCase()).filter(Boolean)).size;
      console.info(source === "group" ? NOTES.CONTACT.TEXT.STAFF_FOUND_GROUP(found) : NOTES.CONTACT.TEXT.STAFF_FOUND(found));
      return { list, ok: true, source, found, admin: isAdmin(p) };
    } catch (err) {
      console.warn("Assignee list: couldn't load the staff list; only you can be chosen:", err?.message ?? String(err)); // the message only: the query names colleagues
      const me = p?.user ? { username: p.user.username, fullName: p.user.fullName, email: p.user.email } : null;
      return { list: me ? staffList([], me) : [], ok: false, source: groupId ? "group" : "org", found: 0, admin: isAdmin(p) };
    }
  }

  return {
    // the list, read once per session (a failed read is tried again next time)
    load() {
      loading ??= load().then((r) => { if (!r.ok) loading = null; return r; });
      return loading;
    },
  };
}

const isAdmin = (p) => p?.user?.role === "org_admin";

// The staff roster (section 57): a hosted table Jackson keeps (NOTES.CONTACT.ROSTER), read once per session with the
// user's own sign-in, as a Map from username (lower case) to email (contactLogic.rosterFrom: rows without a username or
// a valid email are skipped). No roster configured: null, nothing asked. A failed read: one console warning (the
// message only) and null for the rest of the session; it is tried again next session.
// opts: { cfg (NOTES.CONTACT.ROSTER), query (cfg) -> Promise of attribute rows (default: the table through the SDK) }.
export function createRoster({ cfg = NOTES.CONTACT.ROSTER, query = queryRoster } = {}) {
  let loading = null;
  return {
    load() {
      if (!cfg || (!cfg.ITEM_ID && !cfg.URL)) return Promise.resolve(null);
      loading ??= query(cfg).then((rows) => rosterFrom(rows, cfg.FIELDS)).catch((err) => {
        console.warn(NOTES.CONTACT.TEXT.ROSTER_FAILED, err?.message ?? String(err)); // the message only: rows name colleagues
        return null;
      });
      return loading;
    },
  };
}
async function queryRoster(cfg) {
  const FeatureLayer = await $arcgis.import("@arcgis/core/layers/FeatureLayer.js");
  const layer = cfg.ITEM_ID ? new FeatureLayer({ portalItem: { id: cfg.ITEM_ID }, layerId: cfg.LAYER_INDEX ?? 0 }) : new FeatureLayer({ url: cfg.URL });
  await layer.load();
  const outFields = [cfg.FIELDS.USERNAME, cfg.FIELDS.EMAIL];
  const rows = [];
  const num = Math.max(1, Math.min(1000, layer.maxRecordCount || 1000));
  for (let start = 0, n = 0; n < 50; n++, start += num) {
    const r = await layer.queryFeatures({ where: "1=1", outFields, returnGeometry: false, start, num });
    rows.push(...r.features.map((f) => f.attributes));
    if (!r.exceededTransferLimit && r.features.length < num) break;
  }
  return rows;
}

// The assignee's email for a new follow-up (section 57), or null: NOTES.CONTACT.EMAIL_SOURCES in order through
// contactLogic.emailFor, from the staff list already read (staff()) and the roster (read only when a source needs it).
// Never logged.
export function createFollowupEmail({ staff, roster = createRoster(), sources = NOTES.CONTACT.EMAIL_SOURCES } = {}) {
  return async (username) => {
    const portalUsers = sources.includes("portal") ? ((await staff().catch(() => null))?.list ?? []) : [];
    const r = sources.includes("roster") ? await roster.load() : null;
    return emailFor(username, { portalUsers, roster: r }, sources);
  };
}

let shared = null;
function defaultPortal() {
  shared ??= (async () => {
    const Portal = await $arcgis.import("@arcgis/core/portal/Portal.js");
    const p = new Portal({ url: CONFIG.PORTAL_URL, authMode: "no-prompt" });
    await p.load();
    return p;
  })().catch((err) => { shared = null; throw err; });
  return shared;
}
