import { NOTES } from "./config.js";
import { followupState, gidKey } from "./contactLogic.js";

// Follow-up brackets on the Notes timeline (section 57): pure. notesDialog.js draws them.
//
// followupChains(entries, { now, hasMore }) -> chains. entries: the loaded activity entries in their rendered order
// (newest first; retracted ones may be among them). A link joins an active entry X that has a follow-up (a due day and a
// GlobalID) to an active entry Y whose followup_of is X's GlobalID (braces and case ignored, as followupState compares
// them). A chain is everything joined by links, so a contact, "Reassigned to Zoe" (it closes the first follow-up and
// opens one) and Zoe's call back are ONE chain. An active follow-up with nothing joined to it yet is a chain of one.
// Retracted entries are never members (the bracket line passes them).
// Each chain: {
//   ids: the members' object ids, newest to oldest (the rendered order);
//   state: "open" | "overdue" while a follow-up in it is open (overdue when an open one is overdue), else "done"
//     (followupState's rules: closed by the earliest active closing; due today is not overdue);
//   openEnd: the newest member is a follow-up that is still open (it gets the dashed stub);
//   offPage: a member points at a follow-up that isn't loaded while more pages exist (the bracket runs on to "Show
//     older notes"). With every page loaded, a followup_of naming no loaded follow-up is no link (the original is
//     retracted, or not readable).
// }
export function followupChains(entries, { now = Date.now(), hasMore = false } = {}, cfg = NOTES) {
  const list = entries ?? [];
  const active = list.filter((e) => e && e.status !== cfg.STATUS.RETRACTED);
  const isFollowup = (e) => Number.isFinite(e.followup?.due) && gidKey(e.globalId) !== "";
  const byGid = new Map();
  for (const e of active) if (isFollowup(e)) byGid.set(gidKey(e.globalId), e);
  const loaded = new Set(list.map((e) => gidKey(e?.globalId)).filter(Boolean)); // retracted ones too

  // union-find over the active entries' object ids
  const parent = new Map();
  const find = (id) => { let r = id; while (parent.get(r) !== r) r = parent.get(r); parent.set(id, r); return r; };
  const join = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(rb, ra); };
  const member = new Set(), offPage = new Set();
  const add = (e) => { if (!parent.has(e.objectId)) parent.set(e.objectId, e.objectId); member.add(e.objectId); };
  for (const e of active) if (isFollowup(e)) add(e);
  for (const e of active) {
    const of = gidKey(e.followup?.of);
    if (!of) continue;
    const x = byGid.get(of);
    if (x && x !== e) { add(e); join(x.objectId, e.objectId); }
    else if (!x && hasMore && !loaded.has(of)) { add(e); offPage.add(e.objectId); }
  }

  const states = followupState(active, now, cfg);
  const groups = new Map();
  for (const e of list) {
    if (!e || !member.has(e.objectId) || e.status === cfg.STATUS.RETRACTED) continue;
    const root = find(e.objectId);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(e);
  }
  const chains = [];
  for (const members of groups.values()) {
    const fs = members.filter(isFollowup).map((e) => states.get(gidKey(e.globalId))).filter(Boolean);
    const open = fs.filter((s) => s.state !== "closed");
    const state = open.some((s) => s.state === "overdue") ? "overdue" : open.length ? "open" : "done";
    const newest = members[0];
    const newestState = isFollowup(newest) ? states.get(gidKey(newest.globalId))?.state : null;
    chains.push({
      ids: members.map((e) => e.objectId),
      state,
      openEnd: newestState === "open" || newestState === "overdue",
      offPage: members.some((e) => offPage.has(e.objectId)),
    });
  }
  return chains;
}

// Lanes for the chains, so that two chains whose spans overlap never share one. order: the object ids in the rendered
// order (a chain's span is its topmost and bottommost member's index; an off-page chain runs to the end of the list).
// Greedy, shortest span first (ties: the higher one first), each taking the lowest lane free over its whole span:
// a chain nested in a longer one sits nearer the cards (lane 0), so the longer one's ticks don't cross it. A chain that
// finds no lane under maxLanes gets lane null (no bracket; its cards keep their text lines).
// Returns { lanes: [lane or null, per chain, in the chains' order], used: the number of lanes in use, spans }.
export function assignLanes(chains, order, maxLanes = NOTES.TIMELINE.FOLLOWUP.MAX_LANES) {
  const index = new Map((order ?? []).map((id, i) => [id, i]));
  const end = (order ?? []).length; // the row below the last entry ("Show older notes")
  const spans = (chains ?? []).map((c) => {
    const at = c.ids.map((id) => index.get(id)).filter((i) => i !== undefined);
    if (!at.length) return null;
    return { top: Math.min(...at), bottom: c.offPage ? end : Math.max(...at) };
  });
  const lanes = spans.map(() => null);
  const taken = []; // per lane: the spans in it
  const byLength = spans.map((s, i) => i).filter((i) => spans[i]).sort((a, b) => (spans[a].bottom - spans[a].top) - (spans[b].bottom - spans[b].top) || spans[a].top - spans[b].top);
  for (const i of byLength) {
    const s = spans[i];
    for (let lane = 0; lane < Math.max(0, maxLanes); lane++) {
      taken[lane] ??= [];
      if (taken[lane].every((t) => t.bottom < s.top || t.top > s.bottom)) { taken[lane].push(s); lanes[i] = lane; break; }
    }
  }
  const used = lanes.reduce((m, l) => (l === null ? m : Math.max(m, l + 1)), 0);
  return { lanes, used, spans };
}

// A bracket's colors (as in config: a token name, a #rrggbb or { LIGHT, DARK }): its line and ticks take its lane's color (LANE_COLORS, round again past the
// end); its stub, drawn only at an open newest end, takes the lane color while the follow-up is open and OVERDUE_COLOR
// once it is overdue. stub null: no stub (a done chain, or one whose newest member isn't an open follow-up).
export function bracketColors(chain, lane, cfg = NOTES.TIMELINE.FOLLOWUP) {
  const colors = cfg.LANE_COLORS ?? [];
  const line = colors.length ? colors[((lane ?? 0) % colors.length + colors.length) % colors.length] : null;
  const stub = !chain?.openEnd ? null : chain.state === "overdue" ? cfg.OVERDUE_COLOR : line;
  return { line, stub };
}
