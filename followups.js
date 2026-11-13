import { h } from "./dom.js";
import { NOTES } from "./config.js";
import { assigneeName, cleanName, codeLabel, emailCounts, followupState, isOverdue, methodIcon, sortFollowups } from "./contactLogic.js";

// Follow-ups (section 51): telling people about the follow-ups assigned to them, in Atlas, with no backend.
//
// At startup and every FOLLOWUP.POLL_MINUTES, the notes layer is asked for the active follow-ups assigned to the
// signed-in user (followup_to, ignoring case) and for the active entries that close any of them (followup_of); the open
// ones are worked out in the browser (contactLogic.followupState: a retracted closing reopens). Volumes are small.
// After any add or retract in the Notes dialog the count is asked again.
//
// A header button next to "Signed in as": "Follow-ups (3)", in the warning color when any is overdue, hidden at 0. The
// Follow-ups block's header shows the same count and color from the same refresh (no number at 0).
// It opens the Follow-ups block in the left panel (#followups-block, one block open at a time like the others): Mine and
// All open, overdue first, then oldest due first. A row: the due day, the parcel, the customer's name when the contact
// has one (section 52; shown only here and in the dialog, never in a heading, the console or a URL), the method icon,
// the customer type, the note's first line, and the assignee (All open). Clicking a row selects the parcel (as ?parcel= does), zooms to it
// and opens its Notes dialog scrolled to the entry.
//
// Off (nothing shown, nothing asked) when the notes layer has no follow-up fields or GlobalID, or no one is signed in.
// opts: { notesLayer, notes (notes.js), user () -> the signed-in username, openParcel (id) -> Promise of whether it was
// found (search.openParcel) }. Returns viewer.followups: { refresh(), state: { mine, open, overdue, requests } }.
export function setupFollowups({ notesLayer, notes, user = () => null, openParcel = null }) {
  const T = NOTES.CONTACT.TEXT;
  const dayFormat = new Intl.DateTimeFormat(undefined, NOTES.CONTACT.DAY_FORMAT);
  const day = (ms) => (Number.isFinite(ms) ? dayFormat.format(new Date(ms)) : "");
  const requests = { mine: 0, all: 0 };
  let mine = [], all = null, overdue = 0, tab = "mine", status = "idle", message = "", timer = 0, asking = null;

  // ---- the header button
  const headerButton = h("calcite-button", { id: "followups-button", scale: "s", appearance: "outline-fill", kind: "brand", iconStart: "clock", hidden: true, onclick: () => showBlock() });
  const userEl = document.getElementById("user");
  const headerGroup = h("div", { class: "header-end" });
  userEl.replaceWith(headerGroup);
  headerGroup.append(headerButton, userEl);

  // ---- the block (in the markup, so the one-open rule covers it)
  const block = document.getElementById("followups-block");
  block.heading = T.BLOCK;
  const tabs = h("calcite-segmented-control", { scale: "s", width: "full", label: T.BLOCK, class: "followups-tabs", oncalciteSegmentedControlChange: () => { tab = tabs.value; load(); } },
    h("calcite-segmented-control-item", { value: "mine", checked: true }, T.TAB_MINE),
    h("calcite-segmented-control-item", { value: "all" }, T.TAB_ALL));
  const refreshButton = h("calcite-action", { slot: "control", icon: "refresh", text: T.LIST_REFRESH, scale: "s", class: "followups-refresh", onclick: (e) => { e.stopPropagation(); load(); } });
  refreshButton.title = T.LIST_REFRESH;
  const list = h("div", { class: "followups-list", ariaLive: "polite" });
  const note = h("div", { class: "plan-note followups-note", hidden: true });
  block.append(refreshButton, tabs, note, list);
  block.addEventListener("calciteBlockExpand", (e) => { if (e.target === block) load(); });

  const on = () => notesLayer.state.status === "ready" && notesLayer.state.followups && !!user();

  // the open follow-ups among { entries, closings }
  const openOf = ({ entries, closings }) => sortFollowups([...followupState([...entries, ...closings]).values()].filter((s) => s.state !== "closed" && entries.includes(s.entry)));

  // my count, for the header
  async function refresh() {
    const state = await notesLayer.ensure();
    if (state.status !== "ready" || !state.followups || !user()) { setCount([]); block.hidden = true; return; }
    block.hidden = false;
    if (asking) return asking;
    asking = (async () => {
      try {
        requests.mine++;
        mine = openOf(await state.store.followups({ assignee: user() }));
        setCount(mine);
        if (!block.hidden && block.expanded && tab === "mine") render();
      } catch (err) {
        console.warn("Follow-ups: couldn't check your follow-ups:", err?.message ?? String(err));
      } finally {
        asking = null;
      }
    })();
    return asking;
  }
  function setCount(list) {
    const n = list.length;
    overdue = list.filter((s) => isOverdue(s.due)).length;
    headerButton.hidden = n === 0;
    headerButton.textContent = T.HEADER(n);
    headerButton.kind = overdue ? "danger" : "brand";
    headerButton.title = T.HEADER_TITLE(n, overdue);
    headerButton.classList.toggle("overdue", overdue > 0);
    // the block's header says the same (section 55): "Follow-ups (2)", no number at 0, the danger color when any is overdue
    block.heading = n ? T.HEADER(n) : T.BLOCK;
    block.label = n ? T.HEADER_TITLE(n, overdue) : T.BLOCK;
    block.classList.toggle("overdue", overdue > 0);
  }

  // the block's list (Mine or All open)
  async function load() {
    if (!on()) return;
    status = "loading";
    render();
    try {
      if (tab === "mine") await refresh();
      else { requests.all++; all = openOf(await notesLayer.state.store.followups({ assignee: null })); }
      status = "ready";
    } catch (err) {
      status = "error";
      message = err?.message ?? String(err);
      console.warn("Follow-ups: couldn't load the list:", message);
    }
    render();
  }

  function render() {
    const rows = tab === "mine" ? mine : all ?? [];
    note.hidden = status === "ready" && rows.length > 0;
    note.classList.toggle("ws-note-bad", status === "error");
    note.textContent = status === "loading" ? T.LIST_LOADING : status === "error" ? T.LIST_FAILED(message) : tab === "mine" ? T.LIST_EMPTY_MINE : T.LIST_EMPTY_ALL;
    if (status === "loading" && rows.length) note.hidden = true;
    list.replaceChildren(...rows.map(row));
  }

  function row(s) {
    const e = s.entry;
    const domains = notesLayer.state.contactDomains ?? {};
    const late = isOverdue(s.due);
    const first = String(e.text ?? "").split(/\r?\n/).find((l) => l.trim()) ?? "";
    const customer = cleanName(e.contact?.name);
    const text = (cls, value) => { const d = h("span", { class: cls }); d.textContent = value; return d; };
    const el = h("div", { class: `followups-row${late ? " overdue" : ""}`, role: "button", tabIndex: 0 },
      h("div", { class: "followups-row-head" }, text("followups-due", T.DUE_ON(day(s.due))), text("followups-label", e.source?.label ?? e.source?.idValue ?? "")),
      customer ? text("followups-customer", customer) : null,
      h("div", { class: "followups-row-line" }, h("calcite-icon", { icon: methodIcon(e.contact?.method), scale: "s" }),
        text("followups-type", codeLabel(domains.customerType, e.contact?.customerType) ?? codeLabel(domains.method, e.contact?.method) ?? ""),
        tab === "all" ? text("followups-who", assigneeName(e.followup)) : null),
      first ? text("followups-text", first) : null);
    el.addEventListener("click", () => openEntry(e));
    el.addEventListener("keydown", (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); openEntry(e); } });
    return el;
  }

  // select the entry's parcel, zoom to it, open its Notes dialog at the entry
  async function openEntry(e) {
    const src = NOTES.SOURCES.find((x) => x.key === e.source?.layerKey);
    if (!src?.parcel || !openParcel) { note.hidden = false; note.textContent = T.NOT_PARCEL(e.source?.label ?? ""); return; }
    notes.close();
    const found = await openParcel(String(e.source.idValue));
    if (!found) return;
    const t = await notes.open({ entry: e.objectId });
    if (t && (t.layerKey !== e.source.layerKey || t.idValue !== String(e.source.idValue))) console.warn("Follow-ups: the selected parcel isn't the entry's parcel.");
  }

  function showBlock() {
    const shell = block.closest("calcite-shell-panel");
    if (shell?.collapsed) shell.collapsed = false;
    tab = "mine";
    tabs.querySelectorAll("calcite-segmented-control-item").forEach((i) => { i.checked = i.value === "mine"; });
    block.expanded = true;
    block.scrollIntoView?.({ block: "nearest" });
  }

  // start: the layer (loaded now, not on the first selection), then every POLL_MINUTES; and after any add or retract
  notes.onChanged(() => { refresh(); if (block.expanded) load(); });
  notesLayer.onChange(() => refresh());
  refresh();
  timer = setInterval(refresh, NOTES.CONTACT.FOLLOWUP.POLL_MINUTES * 60000);

  // viewer.followups.emailProbe() (section 57), for Jackson to run as an admin and as a non-admin Editor: how many
  // members the assignee list holds, how many came with an email visible, and whether the signed-in user is an admin.
  // Counts only: never an address or a username. It uses the same staff-list read as the composer (cached).
  async function emailProbe() {
    const r = await notes.staff();
    const counts = { ...emailCounts(r.list), admin: !!r.admin, ok: !!r.ok };
    console.info(T.EMAIL_PROBE(counts));
    return counts;
  }

  return {
    refresh, load, emailProbe, button: headerButton, block,
    stop: () => clearInterval(timer),
    get state() { return { mine: mine.length, open: all ? all.length : null, overdue, status, requests: { ...requests } }; },
  };
}
