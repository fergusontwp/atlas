import { h } from "./dom.js";
import { NOTES } from "./config.js";
import { authorOf, canRetract, newNoteRecord } from "./notesLogic.js";
import { normalizeNoteUrl, noteLink } from "./noteUrl.js";
import { changeLine, composerKind, encodeChanges, entryOf, openDuration, snapshotLine, staleFields } from "./activityLogic.js";
import { createActivityComposer } from "./activityComposer.js";
import { assigneeName, codeLabel, contactHref, contactSummary, defaultDueDay, dayValue, dueFromDay, followupState, formatPhone, gidKey, methodIcon, newContactRecord, newFollowupClose } from "./contactLogic.js";
import { createContactComposer } from "./contactComposer.js";
import { toast } from "./toast.js";
import { createNoteFiles } from "./notesFiles.js";
import { createFilePicker, pastedName } from "./notesUpload.js";
import { loggedText, timelineRows, timelineStackCss } from "./notesTimeline.js";
import { createFollowupBrackets } from "./notesBrackets.js";
import { noteDraftHasContent, unsavedWork } from "./draftLogic.js";
import { isLightboxOpen } from "./lightbox.js";
import { cssColor } from "./themeLogic.js";

// The Notes dialog: a modal calcite-dialog (scrim on, focus trapped by Calcite), about NOTES.DIALOG_WIDTH wide. Like the
// lightbox and the Print editor it covers the window on purpose (section 5's layout rule allows these three).
//
// Heading: "Notes: <label>", and under it the layer's title (for a road: "N Atherton St, all segments"), in the body's
// non-scrolling top, since the description slot didn't render in Calcite 5.1.2. The list: newest first by the creation
// date, PAGE_SIZE at a time with "Show older notes", each note's author (author_name, else the creator), date and time in
// the user's locale (DATE_FORMAT) and text, always as text (never HTML), line breaks kept. Retracted notes are hidden
// behind "Show retracted (n)", greyed with a "Retracted" tag and the retract time (and their link with them). A note's link
// is a row under its text: an anchor (new tab, rel "noopener noreferrer") showing the host name and an external-link
// icon, the full URL as its tooltip, its href only from the stored value checked again (noteUrl.noteLink); a stored
// value that fails the check (written by another tool) is shown as plain text. States: loading (a loader after
// LOADER_DELAY_MS), an error with a short reason, empty.
//
// The composer (section 52): hidden until "+ Add note" (or "+ Add note or contact") at the top right is pressed. Then the
// dialog doubles in width (NOTES.DIALOG_WIDTH_SPLIT) with the composer on the left and the list on the right, each
// scrolling on its own; with nothing in the list yet the composer takes the normal width alone. Cancel folds it away
// (asking first when something is typed, and then dropping the draft). A target with a draft opens with the composer
// shown. Adding a note folds the composer and shows the list; adding a contact closes the dialog (a toast confirms).
// In it: a text area with Calcite's own character counter (maxLength MAX_CHARS, so no more can be typed) and Add note;
// Ctrl+Enter adds too.
// Empty or whitespace-only text keeps Add disabled, and nothing over MAX_CHARS is sent. While sending, Add is disabled; on
// success the box is cleared and the list read again (the server sets the author and time); on failure the text stays
// and the message shows. A draft is kept per target in memory, and closing with unsent text asks first (inline). A user
// who can't add (notesLayer's canAdd: editing allowed for them and the add operation) gets one line instead.
// Under the text area, "Link (optional)": one single-line input, only when the layer has note_url (notesLayer's
// urlField). An invalid link (noteUrl.normalizeNoteUrl) shows its reason under the input and keeps Add disabled; a link
// alone is not a note. The draft keeps the link too; it is cleared after an add and kept after a failed one.
// Retract (an update of status, never a delete): on the signed-in user's own notes only (canRetract, the creator
// compared ignoring case), with an inline confirm step, when the layer lets them update. No text editing.
//
// The activity log (a source with `activity`, opened with its resolved config and the feature layer's record editor):
// entries sort by event date (else the creation date) and show it, with "logged <time>" when it was logged more than a
// day apart; a change's lines come before its note ("Status: New → Resolved", the stored labels); a snapshot reads
// "State when the log started" with its values; imported and detected entries are tagged; changes_json the app can't
// read is shown as plain text. Under the newest entries' list: "Request received <time>" (from the request's received
// field, not stored) and, until a snapshot exists, the request's own notes field. Under the heading: "Open for 12 days"
// or "Resolved in 5 days" (activityLogic.openDuration, from the request's current status read fresh on open).
//
// Field changes (activityComposer.js) sit around the note box, unless the source's activity has editsEnabled false (the
// plain note box then; the timeline and its rows stay); the note is optional only when a field changed. Submit,
// in this order (two services, so not atomic): (1) read the request again; if a field being changed differs from what
// the dialog showed, stop and say who changed it and when, with the new values, keeping everything typed; (2) update the
// request (only the changed fields); (3) add the log entry (a change entry with changes_json, or a comment), once more
// after a pause if it fails, then "Retry logging" with the request said to be saved. A log that says a change happened
// when it didn't is worse than a late entry (and can only be retracted, not deleted). A user who can add notes but not
// update the request gets the note box only.
//
// Life: the dialog keeps its own target; a selection that changes or clears while it is open doesn't retarget it. While
// open, map clicks do nothing (panel.setSuspended(true, "notes")) and point info is closed. Esc closes it through a
// window-level capture listener that exists only while it is open and stops propagation, so the app's own Esc (clearing
// the selection) never runs. On close, focus goes back to the button that opened it.
//
// opts: { notesLayer, panel, pointInfo, requests (counted here: page, add, retract), user () -> the signed-in user name,
// authorName () -> Promise of the user's full name or null, anchor(subject) -> Promise of { point: [x, y], wkid } (the
// note's point in the notes layer's spatial reference), onChanged(target) (a note was added or retracted) }.
// Returns { open(target, from, subject), close(), state }.
export function createNotesDialog({ notesLayer, panel, pointInfo = null, requests = {}, user = () => null, authorName = async () => null, anchor, onChanged = () => {}, staff = async () => ({ list: [], ok: false }), followupEmail = async () => null }) {
  const T = NOTES.TEXT;
  const dateFormat = new Intl.DateTimeFormat(undefined, NOTES.DATE_FORMAT);
  const when = (ms) => (Number.isFinite(ms) ? dateFormat.format(new Date(ms)) : "");
  const dayFormat = new Intl.DateTimeFormat(undefined, NOTES.CONTACT.DAY_FORMAT);
  const day = (ms) => (Number.isFinite(ms) ? dayFormat.format(new Date(ms)) : "");
  const CT = NOTES.CONTACT.TEXT;

  const subtitle = h("div", { class: "notes-subtitle" });
  const summary = h("div", { class: "notes-summary", hidden: true });
  const newButton = h("calcite-button", { scale: "s", iconStart: "plus", class: "notes-new", hidden: true, onclick: () => openComposer() }, T.NEW);
  const readOnly = h("div", { class: "plan-note notes-read-only", hidden: true }, T.READ_ONLY);
  // the question (closing or cancelling with something typed) sits in the non-scrolling top, so it is always in view
  const questionText = h("span", {});
  const questionYes = h("calcite-button", { scale: "s", class: "notes-discard-yes", onclick: () => answer(true) }, T.DISCARD_YES);
  const questionNo = h("calcite-button", { scale: "s", appearance: "outline", class: "notes-discard-no", onclick: () => answer(false) }, T.DISCARD_NO);
  const question = h("div", { class: "notes-question", hidden: true }, questionText, h("div", { class: "note-confirm" }, questionYes, questionNo));
  const top = h("div", { slot: "content-top", class: "notes-top" },
    h("div", { class: "notes-top-row" }, h("div", { class: "notes-top-text" }, subtitle, summary), newButton), readOnly, question);
  const composerHost = h("div", { class: "notes-composer" });
  // each pane's small heading, shown in the split view only (section 60)
  const composeHeading = h("h3", { class: "notes-pane-heading", id: "notes-pane-compose" }, T.PANE_COMPOSE);
  const listHeading = h("h3", { class: "notes-pane-heading", id: "notes-pane-list" }, T.PANE_LIST);
  const composerPane = h("section", { class: "notes-pane notes-compose-pane", hidden: true }, composeHeading, composerHost);
  const listHost = h("div", { class: "notes-list", ariaLive: "polite" });
  const listPane = h("section", { class: "notes-pane notes-list-pane" }, listHeading, listHost);
  const body = h("div", { class: "notes-body" }, composerPane, listPane);
  const dialog = h("calcite-dialog", { id: "notes-dialog", modal: true, escapeDisabled: true, scale: "m", width: "s" }, top, body);
  // imported entries' rule and tint (NOTES.STYLE.IMPORTED), as CSS variables the stylesheet reads
  const imported = NOTES.STYLE?.IMPORTED ?? {};
  // and the timeline's sizes (NOTES.TIMELINE), the same way
  const TL = NOTES.TIMELINE;
  for (const [name, value] of [["--note-imported-rule-width", imported.RULE_WIDTH], ["--note-imported-rule-color", imported.RULE_COLOR], ["--note-imported-tint", imported.TINT],
    ["--tl-date", TL.DATE_WIDTH], ["--tl-rail", TL.RAIL_WIDTH], ["--tl-gap", TL.GAP], ["--tl-card-padding", TL.CARD_PADDING], ["--tl-dot", TL.DOT_SIZE],
    ["--tl-hollow", TL.HOLLOW_SIZE], ["--tl-ring", TL.RING_WIDTH], ["--tl-line", TL.LINE_WIDTH], ["--tl-rail-color", cssColor(TL.RAIL_COLOR)],
    // the follow-up brackets (section 57)
    // the split view's panes (section 60)
    ["--notes-compose-bg", cssColor(NOTES.SPLIT?.COMPOSE_BACKGROUND)], ["--notes-list-bg", cssColor(NOTES.SPLIT?.LIST_BACKGROUND)],
    ["--notes-divider", cssColor(NOTES.SPLIT?.DIVIDER_COLOR)], ["--notes-divider-w", NOTES.SPLIT?.DIVIDER_WIDTH],
    ["--tl-lane-w", TL.FOLLOWUP?.LANE_WIDTH], ["--tl-bk-w", TL.FOLLOWUP?.LINE_WIDTH], ["--tl-tick-gap", TL.FOLLOWUP?.TICK_GAP], ["--tl-stub", TL.FOLLOWUP?.OPEN_STUB], ["--tl-dash", TL.FOLLOWUP?.DASH]]) {
    if (value) dialog.style.setProperty(name, value);
  }
  document.body.append(dialog);
  // the timeline's stacked layout below NOTES.TIMELINE.STACK_BELOW of list-pane width (a container query from config)
  if (!document.getElementById("notes-timeline-stack")) {
    const style = h("style", { id: "notes-timeline-stack" });
    style.textContent = timelineStackCss();
    document.head.append(style);
  }

  // ---- state
  let target = null, subject = null, returnTo = null, isOpen = false, sending = false, closing = false;
  // the activity log for this target: { resolved, editor, oid } (notes.js), and the record as read on open
  let activity = null, record = null, recordAbort = null;
  const drafts = new Map(); // target key -> { text, url } not yet added, until the page reloads
  let notes = [], more = false, status = "idle", message = "", showRetracted = false, retractedCount = 0, abort = null, loaderTimer = 0;
  let focusEntry = null; // an object id to scroll to once the first page is shown (the Follow-ups list)
  let composing = false; // the composer is shown
  let flashing = null; // { oid, until }: the card scrolled to from Follow-ups, flashing
  let pendingFiles = null; // { target, objectId, total, close }: the entry is saved, these files didn't go; Retry
  // the entries' files (section 55): one query per page, thumbnails and chips under the text, object URLs revoked on close
  const files = createNoteFiles({ notesLayer, root: () => listHost, changed: () => { if (isOpen) render(); }, dialog });
  // the follow-up brackets on the timeline (section 57), drawn again from every loaded entry on each render
  const brackets = createFollowupBrackets();

  // ---- the list
  // every string here goes in as text (dom.h appends strings as text nodes; textContent below): never as HTML
  const tag = (text) => h("calcite-chip", { scale: "s", kind: "neutral", class: "note-tag" }, text);
  const textDiv = (cls, value) => { const d = h("div", { class: cls }); d.textContent = value; return d; };

  // ---- the contact log's parts of a row (section 51)
  // A contact: the method's icon, one line ("Phone call · Developer · Zoning commercial"), "Spoke with: <staff>", the
  // permit answer, then (after the note) the customer's details behind a small "Customer" toggle: the name, the phone as
  // a tel: link and the email as a mailto: link, each href only after contactLogic.contactHref's check (anything odd is
  // plain text). Codes no longer in a domain show raw.
  function contactParts(note) {
    const c = note.contact;
    if (note.entryType !== NOTES.ENTRY_TYPES.CONTACT || !c) return { head: null, tail: null };
    const domains = notesLayer.state.contactDomains ?? {};
    const summaryLine = h("div", { class: "contact-summary" }, h("calcite-icon", { icon: methodIcon(c.method), scale: "s", class: "contact-icon" }),
      textDiv("contact-summary-text", contactSummary(c, domains) || NOTES.ENTRY_TYPES.CONTACT));
    const head = h("div", { class: "contact-head" }, summaryLine,
      c.staff ? textDiv("contact-line", CT.SPOKE_WITH(c.staff)) : null,
      c.permit ? textDiv("contact-line", CT.PERMIT_LINE(codeLabel(domains.permit, c.permit))) : null);
    const details = [];
    if (c.name) details.push(textDiv("contact-detail", c.name));
    // a phone shows through formatPhone (section 58), so older and backfilled numbers read the same; display only, the
    // stored value is never rewritten
    for (const [kind, value] of [["phone", formatPhone(c.phone)], ["email", c.email]]) {
      if (!value) continue;
      const href = contactHref(kind, value);
      if (href) { const a = h("a", { class: "contact-detail contact-link", href }); a.textContent = value; details.push(h("div", {}, a)); }
      else details.push(textDiv("contact-detail", value));
    }
    const tail = details.length ? h("details", { class: "contact-customer" }, h("summary", {}, CT.CUSTOMER), ...details) : null;
    return { head, tail };
  }
  // A follow-up on a row: "Follow up by Nov 6 · Dana" with Open, Overdue (past due, not closed) or "Done Nov 5 by Jo"
  // (from the closing entry). A closing entry: "Closed follow-up from <day>" with a link to the original.
  let states = new Map();
  function followupParts(note) {
    const parts = [];
    const s = notesLayer.state.followups ? states.get(gidKey(note.globalId)) : null;
    if (s) {
      const badge = s.state === "closed"
        ? h("span", { class: "followup-state followup-closed" }, (s.closing.entryType === NOTES.ENTRY_TYPES.CONTACT ? CT.STATE_DONE : CT.STATE_CLOSED)(day(s.closing.eventTime), authorOf(s.closing)))
        : h("calcite-chip", { scale: "s", kind: s.state === "overdue" ? "danger" : "brand", class: `followup-state followup-${s.state}` }, s.state === "overdue" ? CT.STATE_OVERDUE : CT.STATE_OPEN);
      parts.push(h("div", { class: `followup-line${s.state === "overdue" ? " overdue" : ""}` }, h("calcite-icon", { icon: "clock", scale: "s" }),
        h("span", {}, CT.FOLLOW_UP_BY(day(s.due), assigneeName(note.followup))), badge));
      if (s.state !== "closed") parts.push(followupActions(note));
    }
    if (notesLayer.state.followups && note.followup?.of) {
      const original = notes.find((n) => gidKey(n.globalId) === gidKey(note.followup.of));
      const line = h("div", { class: "followup-closes" }, h("calcite-icon", { icon: "check-circle", scale: "s" }), h("span", {}, CT.CLOSES(original ? day(original.eventTime) : "")));
      if (original) line.append(h("calcite-button", { appearance: "transparent", scale: "s", class: "followup-goto", onclick: () => scrollToEntry(original.objectId) }, CT.CLOSES_LINK));
      parts.push(line);
    }
    return parts;
  }
  // An open follow-up's actions, for anyone who can add notes (closing writes a NEW entry, never an update):
  //   Mark done: the Contact composer prefilled from the original (method, customer type, topics, customer details)
  //     with followup_of set; closing a follow-up is logging the call back.
  //   in the row's menu, Close without contact: a comment with followup_of and a required one-line reason;
  //   and Reassign: the same with "Reassigned to <name>" and a new follow-up (person and day) on that closing entry.
  function followupActions(note) {
    if (!notesLayer.state.canAdd || !notesLayer.state.followups || !note.globalId) return null;
    const host = h("div", { class: "followup-actions" });
    const idle = () => host.replaceChildren(
      contactAllowed() ? h("calcite-button", { scale: "s", appearance: "outline", iconStart: "check", class: "followup-done", onclick: () => markDone(note) }, CT.MARK_DONE) : null,
      h("calcite-dropdown", { scale: "s", placement: "bottom-end", overlayPositioning: "fixed", class: "followup-menu", widthScale: "m" },
        h("calcite-button", { slot: "trigger", scale: "s", appearance: "transparent", kind: "neutral", iconStart: "ellipsis", label: CT.FOLLOWUP_MENU, title: CT.FOLLOWUP_MENU, class: "followup-menu-button" }),
        h("calcite-dropdown-group", { selectionMode: "none" },
          h("calcite-dropdown-item", { class: "followup-close", oncalciteDropdownItemSelect: () => form(false) }, CT.CLOSE_NO_CONTACT),
          h("calcite-dropdown-item", { class: "followup-reassign", oncalciteDropdownItemSelect: () => form(true) }, CT.REASSIGN))));
    // the inline form: a reason, or (Reassign) a person and a day
    function form(reassign) {
      const msg = h("div", { class: "plan-note ws-note-bad followup-form-note", hidden: true });
      const reason = h("calcite-input-text", { scale: "s", label: CT.CLOSE_REASON, placeholder: CT.CLOSE_REASON, class: "followup-reason", maxLength: 500 });
      const who = h("calcite-combobox", { scale: "s", label: CT.REASSIGN_TO, placeholder: CT.STAFF_PLACEHOLDER, selectionMode: "single", allowCustomValues: false, overlayPositioning: "fixed", class: "followup-reassign-to" });
      const due = h("calcite-input-date-picker", { scale: "s", label: CT.DUE, overlayPositioning: "fixed", class: "followup-reassign-due", min: dayValue(Date.now()), value: defaultDueDay() });
      let people = [];
      if (reassign) staff().then((r) => {
        people = r.list ?? [];
        who.replaceChildren(...people.map((u) => h("calcite-combobox-item", { value: u.username, heading: u.isMe ? CT.STAFF_ME(u.name) : u.name, textLabel: u.name })));
        if (!r.ok) { msg.textContent = CT.STAFF_FAILED; msg.hidden = false; }
      });
      const yes = h("calcite-button", { scale: "s", kind: reassign ? "brand" : "danger", class: "followup-form-yes", onclick: () => submit() }, reassign ? CT.REASSIGN_YES : CT.CLOSE_YES);
      const no = h("calcite-button", { scale: "s", appearance: "outline", class: "followup-form-no", onclick: idle }, CT.CLOSE_NO);
      host.replaceChildren(h("div", { class: "followup-form" },
        ...(reassign ? [h("calcite-label", { scale: "s" }, CT.REASSIGN_TO, who), h("calcite-label", { scale: "s" }, CT.DUE, due)] : [h("calcite-label", { scale: "s" }, CT.CLOSE_REASON, reason)]),
        msg, h("div", { class: "note-confirm" }, yes, no)));
      requestAnimationFrame(() => (reassign ? who : reason).setFocus?.());
      async function submit() {
        let text = String(reason.value ?? ""), followup = null;
        if (reassign) {
          const to = Array.isArray(who.value) ? who.value[0] : who.value;
          const person = people.find((u) => u.username === to);
          followup = { to: to || null, toName: person?.fullName ?? null, due: dueFromDay(due.value) };
          text = CT.REASSIGNED(person?.name ?? to ?? "");
        }
        const asked = target, askedSubject = subject;
        const opts = { lengths: notesLayer.state.lengths, followup, emailField: !!notesLayer.state.followupEmail };
        const check = newFollowupClose(text, note, asked, opts);
        if (check.error) { msg.textContent = check.error; msg.hidden = false; return; }
        yes.loading = true;
        yes.disabled = no.disabled = true;
        try {
          const where = await anchor(askedSubject);
          const name = await authorName().catch(() => null);
          // the new assignee's email (section 57), never logged
          if (followup && opts.emailField) followup.toEmail = await followupEmail(followup.to).catch(() => null);
          const final = newFollowupClose(text, note, asked, { ...opts, authorName: name });
          if (final.error) throw new Error(final.error);
          requests.add = (requests.add ?? 0) + 1;
          await notesLayer.state.store.add({ attributes: final.attributes, point: where.point, wkid: where.wkid });
        } catch (err) {
          console.warn("Notes: couldn't close the follow-up:", err?.message ?? String(err));
          yes.loading = false;
          yes.disabled = no.disabled = false;
          msg.textContent = T.ADD_FAILED(err?.message ?? String(err));
          msg.hidden = false;
          return;
        }
        onChanged(asked);
        if (asked === target) load();
      }
    }
    idle();
    return host;
  }
  // Mark done: Contact mode, prefilled from the original, closing its follow-up
  async function markDone(note) {
    openComposer({ focus: false });
    setMode("contact");
    await contactC.prefill(note, day(note.eventTime));
    composerPane.scrollTop = 0;
    contactC.focus();
    saveDraft();
    syncComposer();
  }
  // Scroll the list to an entry and mark it for a moment. Only the list's own scroll area moves: scrollIntoView also
  // scrolled the dialog's outer container (inside Calcite's shadow DOM), which cut its heading off.
  function scrollToEntry(objectId) {
    const row = listHost.querySelector(`.note-row[data-oid="${CSS.escape(String(objectId))}"]`);
    if (!row) return false;
    const scroller = scrollArea(row);
    if (scroller) {
      const r = row.getBoundingClientRect(), a = scroller.getBoundingClientRect();
      scroller.scrollTop += r.top - a.top - Math.max(0, (a.height - r.height) / 2);
    }
    // the card flashes; remembered for its time, so a card rebuilt meanwhile (the files arriving re-render the list)
    // keeps it
    flashing = { oid: String(objectId), until: Date.now() + 1600 };
    row.classList.add("note-flash");
    setTimeout(() => listHost.querySelector(`.note-row[data-oid="${CSS.escape(String(objectId))}"]`)?.classList.remove("note-flash"), 1600);
    return true;
  }
  // the nearest ancestor of el that scrolls, through shadow roots and slots, and never past the dialog
  function scrollArea(el) {
    for (let n = el.assignedSlot ?? el.parentNode; n && n !== dialog; n = n.assignedSlot ?? (n instanceof ShadowRoot ? n.host : n.parentNode)) {
      if (!(n instanceof Element)) continue;
      const y = getComputedStyle(n).overflowY;
      if ((y === "auto" || y === "scroll") && n.scrollHeight > n.clientHeight) return n;
    }
    return null;
  }

  function noteRow(note) {
    const retracted = note.status === NOTES.STATUS.RETRACTED;
    // the date and "logged" are in the timeline's date column (timelineItem)
    const meta = h("div", { class: "note-meta" }, h("span", { class: "note-author" }, authorOf(note)));
    const clip = files.clipFor(note);
    if (clip) meta.append(clip);
    if (note.origin === NOTES.ORIGINS.IMPORT) meta.append(tag(T.TAG_IMPORTED));
    if (note.origin === NOTES.ORIGINS.DETECTED) meta.append(tag(T.TAG_DETECTED));
    if (retracted) meta.append(tag(T.RETRACTED_TAG), h("span", { class: "note-date" }, T.RETRACTED_AT(when(note.edited))));
    const snapshot = note.entryType === NOTES.ENTRY_TYPES.SNAPSHOT;
    const lines = note.changes.length ? h("ul", { class: `note-changes${snapshot ? " note-snapshot" : ""}` },
      ...note.changes.map((c) => h("li", {}, snapshot ? snapshotLine(c, T) : changeLine(c, T)))) : null;
    const bad = note.badChanges ? h("div", { class: "note-bad-changes plan-note" }, T.BAD_CHANGES, h("div", { class: "note-text" }, note.badChanges)) : null;
    // textContent only: a note is never parsed as HTML; white-space: pre-wrap keeps its line breaks
    const text = note.text ? h("div", { class: "note-text" }) : null;
    if (text) text.textContent = note.text;
    const contact = contactParts(note);
    // the card: a contact's summary on top (then its author), else the author; then the body as before
    const row = h("div", { class: `note-row tl-card${retracted ? " retracted" : ""}${note.origin === NOTES.ORIGINS.IMPORT ? " imported" : ""}${contact.head ? " note-contact" : ""}` }, ...(contact.head ? [contact.head, meta] : [meta]), snapshot ? h("div", { class: "note-snapshot-title" }, T.SNAPSHOT) : null, lines, bad, text, files.partsFor(note), contact.tail, noteLinkRow(note.url), ...followupParts(note));
    row.dataset.oid = String(note.objectId);
    if (flashing?.oid === row.dataset.oid && Date.now() < flashing.until) row.classList.add("note-flash");
    if (notesLayer.state.canUpdate && canRetract(note, user())) row.append(retractControl(note));
    return row;
  }

  // What the request adds under its entries, not stored (section 49): its notes field until a snapshot carries it, and
  // the time it was received. Drawn as the timeline's last rows, only once the oldest entries are shown.
  function recordData() {
    if (!activity || !record) return { legacy: null, received: null };
    const { receivedField, legacyNotesField } = activity.resolved;
    const legacy = legacyNotesField && !notes.some((n) => n.entryType === NOTES.ENTRY_TYPES.SNAPSHOT) ? String(record.values[legacyNotesField] ?? "") : null;
    const received = receivedField ? record.values[receivedField] : null;
    return { legacy, received: Number.isFinite(received) ? received : null };
  }

  // ---- the timeline (section 56): newest at the top; a date column, the rail with a dot per entry, a card per entry
  const fmtWith = (ms, options) => new Intl.DateTimeFormat(undefined, options).format(new Date(ms));
  const decorative = (el) => { el.setAttribute("aria-hidden", "true"); return el; };
  const span = (cls, value) => { const el = h("span", { class: cls }); el.textContent = value; return el; };
  // the date column: the day, the time under it, "logged <day>" when it shows; one line when stacked
  function dateCell(time, logged = null) {
    const cell = h("div", { class: "tl-date" });
    if (!Number.isFinite(time)) return cell;
    cell.append(h("time", { dateTime: new Date(time).toISOString() }, span("tl-day", fmtWith(time, TL.DAY)), span("tl-sep", TL.TEXT.SEPARATOR), span("tl-time", fmtWith(time, TL.TIME))));
    if (Number.isFinite(logged)) cell.append(span("tl-sep", TL.TEXT.SEPARATOR), span("tl-logged", loggedText(logged, time, fmtWith)));
    return cell;
  }
  const rail = (dot) => decorative(h("div", { class: "tl-rail" }, h("span", { class: `tl-dot ${dot}` })));
  function timelineItem(row) {
    if (row.kind === "year") {
      const li = h("li", { class: "tl-item tl-year", role: "separator" }, h("div", { class: "tl-date" }), decorative(h("div", { class: "tl-rail" }, span("tl-pill", TL.TEXT.YEAR_LABEL(row.year)))));
      li.setAttribute("aria-label", TL.TEXT.YEAR_LABEL(row.year));
      return li;
    }
    if (row.kind === "entry") {
      return h("li", { class: `tl-item tl-entry${row.retracted ? " retracted" : ""}${row.imported ? " imported" : ""}` }, dateCell(row.time, row.logged), rail(row.dot), noteRow(row.entry));
    }
    if (row.kind === "legacy") {
      const text = h("div", { class: "note-text" });
      text.textContent = row.text;
      return h("li", { class: "tl-item tl-record" }, dateCell(null), rail("plain"),
        h("div", { class: "note-row tl-card note-legacy" }, h("div", { class: "note-meta" }, h("span", { class: "note-author" }, T.LEGACY_NOTES)), text));
    }
    if (row.kind === "received") {
      return h("li", { class: "tl-item tl-record" }, dateCell(row.time), rail("plain"),
        h("div", { class: "note-row tl-card note-received" }, h("div", { class: "note-meta" }, h("span", { class: "note-author" }, T.RECEIVED))));
    }
    return null;
  }
  // The whole timeline: "Newest" at the top of the rail, the <ol> (one <li> per entry, year pills as separators), and at
  // the bottom "Show older notes" while more pages exist, else "Oldest". The line and dots are decorative.
  function timeline() {
    const r = recordData();
    const rows = timelineRows(notes, { now: Date.now(), hasMore: more, ...(status === "ready" ? r : {}) });
    const list = h("ol", { class: "tl-list" }, ...rows.map(timelineItem).filter(Boolean));
    list.setAttribute("aria-label", TL.TEXT.LIST_LABEL);
    const end = (cls, label, railContent, extra = null) => h("div", { class: `tl-item tl-end ${cls}` }, h("div", { class: "tl-date" }, label), decorative(h("div", { class: "tl-rail" }, railContent)), extra ?? h("div", {}));
    const top = end("tl-newest", TL.TEXT.NEWEST, h("calcite-icon", { icon: "arrow-up", scale: "s", class: "tl-arrow" }));
    const last = rows.at(-1)?.kind;
    const bottom = last === "older"
      ? end("tl-older", "", span("tl-cap", ""), h("calcite-button", { appearance: "outline", scale: "s", class: "notes-older", disabled: status.startsWith("loading"), onclick: () => load({ older: true }) }, T.SHOW_OLDER))
      : end("tl-oldest", TL.TEXT.OLDEST, span("tl-cap", ""));
    return h("div", { class: "notes-timeline" }, top, list, bottom);
  }

  // "Open for 12 days" / "Resolved in 5 days" under the heading (nothing without closed statuses or a received time)
  function renderSummary() {
    const statusEdit = activity?.resolved.edits.find((e) => e.key === "status");
    const d = activity && record && statusEdit ? openDuration({
      received: record.values[activity.resolved.receivedField], status: record.values[statusEdit.field], entries: notes,
      closedStatuses: activity.resolved.closedStatuses, statusField: statusEdit.field, now: Date.now(),
    }) : null;
    summary.textContent = !d ? "" : d.state === "open" ? T.OPEN_FOR(d.days) : d.days === null ? "" : T.RESOLVED_IN(d.days);
    summary.hidden = !summary.textContent;
  }

  function noteLinkRow(stored) {
    const link = noteLink(stored);
    if (!link) return null;
    if (!link.href) {
      const plain = h("div", { class: "note-link note-link-text" });
      plain.textContent = link.text;
      return plain;
    }
    const anchor = h("a", { class: "note-link-anchor", href: link.href, target: "_blank", rel: "noopener noreferrer", title: link.href },
      h("calcite-icon", { icon: "launch", scale: "s" }), h("span", {}, link.label));
    return h("div", { class: "note-link" }, anchor);
  }

  // Retract, then a confirm step in place of the button; the note leaves the count and the default list.
  function retractControl(note) {
    const host = h("div", { class: "note-actions" });
    const ask = () => host.replaceChildren(
      h("span", { class: "plan-note" }, note.changes?.length ? T.RETRACT_ASK_CHANGE : T.RETRACT_ASK),
      h("div", { class: "note-confirm" },
        h("calcite-button", { scale: "s", kind: "danger", class: "note-retract-yes", onclick: () => retract(note, host) }, T.RETRACT_YES),
        h("calcite-button", { scale: "s", appearance: "outline", class: "note-retract-no", onclick: idle }, T.RETRACT_NO)));
    const idle = () => host.replaceChildren(h("calcite-button", { scale: "s", appearance: "transparent", kind: "danger", iconStart: "undo", class: "note-retract", onclick: ask }, T.RETRACT));
    idle();
    return host;
  }
  async function retract(note, host) {
    const asked = target;
    host.querySelectorAll("calcite-button").forEach((b) => { b.disabled = true; });
    try {
      requests.retract = (requests.retract ?? 0) + 1;
      await notesLayer.state.store.retract(note.objectId);
    } catch (err) {
      console.warn("Notes: couldn't retract the note:", err?.message ?? String(err));
      host.replaceChildren(h("div", { class: "plan-note ws-note-bad" }, T.RETRACT_FAILED(err?.message ?? String(err))));
      return;
    }
    onChanged(asked);
    if (asked === target) load();
  }

  // ---- the composer (or the read-only line)
  const textArea = h("calcite-text-area", { label: T.PLACEHOLDER, placeholder: T.PLACEHOLDER, maxLength: NOTES.MAX_CHARS, rows: 4, resize: "vertical", scale: "m", class: "notes-text-area" });
  const addButton = h("calcite-button", { scale: "m", iconStart: "plus", class: "notes-add", disabled: true }, T.ADD);
  const composeNote = h("div", { class: "plan-note notes-compose-note" });
  const linkInput = h("calcite-input-text", { placeholder: T.LINK_PLACEHOLDER, label: T.LINK_LABEL, scale: "m", class: "notes-link-input" });
  const linkNote = h("div", { class: "plan-note ws-note-bad notes-link-note", ariaLive: "polite" });
  const linkRow = h("div", { class: "form-field notes-link" }, h("div", { class: "form-label" }, T.LINK_LABEL), linkInput, linkNote);
  const act = createActivityComposer({ me: async () => (await authorName().catch(() => null)) || user(), onChange: () => onInput() });
  const retryButton = h("calcite-button", { scale: "s", appearance: "outline", iconStart: "refresh", class: "notes-retry", hidden: true, onclick: () => retryLogging() }, T.RETRY_LOGGING);
  // Note | Contact (section 51): for a source in NOTES.CONTACT.SOURCES, when the notes layer has the contact fields and
  // the user can add. The last choice is kept per browser (CONTACT.MODE_KEY).
  const modeControl = h("calcite-segmented-control", { scale: "m", width: "full", label: CT.MODE_LABEL, class: "notes-mode", oncalciteSegmentedControlChange: () => setMode(modeControl.value) },
    h("calcite-segmented-control-item", { value: "note", checked: true, iconStart: "notepad" }, CT.MODE_NOTE),
    h("calcite-segmented-control-item", { value: "contact", iconStart: "phone" }, CT.MODE_CONTACT));
  const contactC = createContactComposer({ staff: () => staff(), me: async () => (await authorName().catch(() => null)) || user(), onChange: () => onInput() });
  const contactHint = h("div", { class: "plan-note contact-hint", hidden: true });
  const shortcutNote = h("span", { class: "plan-note notes-shortcut" }, T.SHORTCUT);
  const noteLabel = h("div", { class: "form-label notes-text-label", hidden: true }, CT.NOTE_LABEL);
  const cancelButton = h("calcite-button", { scale: "m", appearance: "outline", kind: "neutral", class: "notes-cancel", onclick: () => cancel() }, T.CANCEL);
  // Files (section 55): right after Link in both modes, for users who can add when the layer has attachments
  const AT = NOTES.ATTACH.TEXT;
  const picker = createFilePicker({ changed: () => { onInput(); filesDropped(); } });
  const filesAllowed = () => !!(target && notesLayer.state.canAdd && notesLayer.state.attachments);
  const retryFilesButton = h("calcite-button", { scale: "s", appearance: "outline", iconStart: "refresh", class: "notes-retry-files", hidden: true, onclick: () => retryFiles() }, AT.RETRY_UPLOAD);
  const composer = h("div", { class: "notes-compose" }, modeControl, contactC.top, act.chips,
    h("div", { class: "form-section notes-text-section" }, h("div", { class: "form-field" }, noteLabel, textArea), linkRow, picker.node),
    contactC.bottom, act.fields, act.foot, contactHint,
    h("div", { class: "notes-compose-row" }, shortcutNote, cancelButton, addButton), composeNote, retryButton, retryFilesButton);
  let mode = "note";
  const contactAllowed = () => !!(target && notesLayer.state.contact && notesLayer.state.canAdd && NOTES.CONTACT.SOURCES.includes(target.layerKey));
  const savedMode = () => { try { return localStorage.getItem(NOTES.CONTACT.MODE_KEY) === "contact" ? "contact" : "note"; } catch { return "note"; } };
  function setMode(m, { save = true } = {}) {
    mode = contactAllowed() && m === "contact" ? "contact" : "note";
    if (save) { try { localStorage.setItem(NOTES.CONTACT.MODE_KEY, mode); } catch { /* this visit only */ } }
    modeControl.querySelectorAll("calcite-segmented-control-item").forEach((i) => { i.checked = i.value === mode; });
    composer.classList.toggle("mode-contact", mode === "contact");
    contactC.top.hidden = contactC.bottom.hidden = mode !== "contact";
    noteLabel.hidden = mode !== "contact";
    textArea.placeholder = mode === "contact" ? CT.NOTE_PLACEHOLDER : T.PLACEHOLDER;
    textArea.label = mode === "contact" ? CT.NOTE_LABEL : T.PLACEHOLDER;
    shortcutNote.textContent = mode === "contact" ? CT.SHORTCUT : T.SHORTCUT;
    saveDraft();
    syncComposer();
  }

  // ---- showing the composer: the dialog's width and its two panes
  // the list has something to show beside the composer (notes, retracted ones, an error, the request's own rows)
  const listHasContent = () => notes.length > 0 || retractedCount > 0 || status === "error" || (() => { const r = recordData(); return !!(String(r.legacy ?? "").trim() || r.received); })();
  function layout() {
    const canAdd = !!target && notesLayer.state.canAdd;
    newButton.hidden = !canAdd || composing;
    newButton.textContent = contactAllowed() ? CT.NEW : T.NEW;
    readOnly.hidden = !target || canAdd;
    const shown = canAdd && composing;
    const split = shown && listHasContent();
    composerPane.hidden = !shown;
    listPane.hidden = shown && !split;
    body.classList.toggle("split", split);
    dialog.classList.toggle("notes-split", split);
    // a pane is named by its heading only while both are shown
    for (const [pane, heading] of [[composerPane, composeHeading], [listPane, listHeading]]) {
      if (split) pane.setAttribute("aria-labelledby", heading.id); else pane.removeAttribute("aria-labelledby");
    }
    const width = split ? NOTES.DIALOG_WIDTH_SPLIT : NOTES.DIALOG_WIDTH;
    dialog.style.setProperty("--calcite-dialog-max-size-x", `min(${width}, calc(100vw - 32px))`);
    dialog.style.setProperty("--calcite-dialog-min-size-x", `min(${width}, calc(100vw - 32px))`);
    // two panes scroll on their own: the dialog takes its full height so they have one to share
    dialog.style.setProperty("--calcite-dialog-min-size-y", split ? NOTES.DIALOG_HEIGHT_SPLIT : "");
  }
  const focusComposer = () => (mode === "contact" ? contactC.focus() : textArea.setFocus?.());
  function openComposer({ focus = true } = {}) {
    if (!target || !notesLayer.state.canAdd) return;
    composing = true;
    layout();
    if (focus) requestAnimationFrame(focusComposer);
  }
  function closeComposer() {
    composing = false;
    question.hidden = true;
    layout();
    requestAnimationFrame(() => newButton.setFocus?.());
  }
  // Cancel: with anything typed, ask first; yes drops the draft
  function cancel() {
    if (sending) return;
    if (unsent()) ask("cancel");
    else closeComposer();
  }
  function discard() {
    drafts.delete(target.key);
    renderComposer();
    applyRecord();
    closeComposer();
  }

  // The question: "close" (the dialog, keeping the draft) or "cancel" (the composer, dropping the draft).
  let asking = null;
  // with files that didn't upload (the entry is saved), both ask about those instead
  function ask(kind) {
    asking = kind;
    const files = !!pendingFiles;
    questionText.textContent = files ? AT.CLOSE_FAILED_ASK : kind === "close" ? T.DISCARD_ASK : T.CANCEL_ASK;
    questionYes.textContent = files ? AT.CLOSE_FAILED_YES : kind === "close" ? T.DISCARD_YES : T.CANCEL_YES;
    question.hidden = false;
    questionNo.setFocus?.();
  }
  function answer(yes) {
    const kind = asking;
    asking = null;
    question.hidden = true;
    if (!yes) { focusComposer(); return; }
    if (pendingFiles) { dropFailedFiles(kind === "close"); return; }
    if (kind === "close") { closing = true; dialog.open = false; }
    else if (kind === "cancel") discard();
  }

  // the field changes around the note box ("fields"), the note box with a line ("note"), or the plain note box
  const activityKind = () => (activity ? composerKind(activity.resolved, activity.editor.canUpdate) : "plain");
  const typed = () => String(textArea.value ?? "");
  const withLinks = () => !!notesLayer.state.urlField;
  const linkTyped = () => (withLinks() ? String(linkInput.value ?? "") : "");
  const unsent = () => !!(typed().trim() || linkTyped().trim() || act.changes().length || pendingLog || pendingFiles || (filesAllowed() && (picker.count || picker.busy)) || (mode === "contact" && contactC.dirty()));
  let restoring = false; // while a draft is put back, its own change events don't overwrite it
  const saveDraft = () => { if (target && !restoring && !pendingFiles) drafts.set(target.key, { text: typed(), url: linkTyped(), act: act.draft(), mode, contact: contactAllowed() ? contactC.draft() : null, files: filesAllowed() ? picker.items() : [] }); };
  function syncComposer() {
    const n = typed().trim().length;
    const link = normalizeNoteUrl(linkTyped());
    linkInput.status = link.ok ? "idle" : "invalid";
    linkNote.textContent = link.ok ? "" : link.reason;
    linkNote.hidden = link.ok;
    if (mode === "contact") {
      // the note is optional for a contact (a soft hint); the required fields and a complete follow-up aren't
      const r = contactC.ready();
      contactHint.textContent = !r.ok ? r.message : n === 0 ? T.HINT_NO_NOTE : "";
      contactHint.hidden = !contactHint.textContent;
      addButton.disabled = sending || !r.ok || n > NOTES.MAX_CHARS || !link.ok || picker.busy || !!pendingFiles;
    } else {
      contactHint.hidden = true;
      const changed = act.changes().length > 0;
      act.refresh(n === 0);
      addButton.disabled = sending || !!pendingLog || (n === 0 && !changed) || n > NOTES.MAX_CHARS || !link.ok || picker.busy || !!pendingFiles;
    }
    retryButton.hidden = !pendingLog;
    retryFilesButton.hidden = !pendingFiles;
    retryFilesButton.loading = sending && !!pendingFiles;
    retryFilesButton.disabled = sending;
    retryButton.loading = sending && !!pendingLog;
    addButton.loading = sending;
    addButton.textContent = sending ? T.ADDING : mode === "contact" ? CT.ADD : T.ADD;
  }
  const onInput = () => {
    saveDraft();
    composeNote.textContent = "";
    composeNote.classList.remove("ws-note-bad");
    syncComposer();
  };
  textArea.addEventListener("calciteTextAreaInput", onInput);
  linkInput.addEventListener("calciteInputTextInput", onInput);
  const onCtrlEnter = (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      add();
    }
  };
  textArea.addEventListener("keydown", onCtrlEnter);
  linkInput.addEventListener("keydown", onCtrlEnter);
  addButton.addEventListener("click", () => add());
  // a screenshot pasted into the note box becomes a file (text pasted with it still goes in as text)
  textArea.addEventListener("paste", (e) => {
    if (!filesAllowed() || pendingFiles) return;
    const images = [...(e.clipboardData?.files ?? [])].filter((f) => /^image\//.test(f.type));
    if (!images.length) return;
    if (!e.clipboardData.getData("text/plain")) e.preventDefault();
    picker.add(images.map((f) => new File([f], pastedName(f), { type: f.type, lastModified: f.lastModified })));
  });
  // files dropped anywhere on the dialog: added while the composer is shown, otherwise ignored (never opened in the tab)
  const draggingFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes("Files");
  const canDrop = () => composing && filesAllowed() && !pendingFiles;
  dialog.addEventListener("dragover", (e) => {
    if (!draggingFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = canDrop() ? "copy" : "none";
    composer.classList.toggle("drag-over", canDrop());
  });
  dialog.addEventListener("dragleave", (e) => { if (!dialog.contains(e.relatedTarget)) composer.classList.remove("drag-over"); });
  dialog.addEventListener("drop", (e) => {
    if (!draggingFiles(e)) return;
    e.preventDefault();
    composer.classList.remove("drag-over");
    if (canDrop()) picker.add([...e.dataTransfer.files]);
  });

  // the entry's changes_json fits the layer's field (or ACTIVITY.CHANGES_MAX_CHARS)
  const changesMax = () => Math.min(NOTES.ACTIVITY.CHANGES_MAX_CHARS, notesLayer.state.lengths[NOTES.FIELDS.CHANGES] || Infinity);
  // Step 3: the log entry, with its point and the author's name, once more after a pause if it fails.
  async function logEntry(p) {
    const once = async () => {
      p.where ??= await anchor(p.subject);
      p.name ??= await authorName().catch(() => null);
      const final = newNoteRecord(p.text, p.target, { authorName: p.name, lengths: notesLayer.state.lengths, url: p.url, entry: p.entry });
      if (final.error) throw new Error(final.error);
      requests.add = (requests.add ?? 0) + 1;
      p.objectId = (await notesLayer.state.store.add({ attributes: final.attributes, point: p.where.point, wkid: p.where.wkid }))?.objectId ?? null;
    };
    try {
      await once();
    } catch (err) {
      if (!p.retryable) throw err;
      console.warn("Notes: the log entry failed; trying once more:", err?.message ?? String(err)); // the message only: a request error carries its query (the edit)
      await new Promise((r) => setTimeout(r, NOTES.ACTIVITY.RETRY_DELAY_MS));
      await once();
    }
  }

  let pendingLog = null; // a log entry whose request change was saved but which couldn't be added: "Retry logging"
  async function add() {
    if (mode === "contact") return addContact();
    if (sending || pendingLog || !target || !notesLayer.state.canAdd) return;
    const asked = target, askedSubject = subject, askedActivity = activity;
    const url = linkTyped();
    const changes = act.changes();
    const entry = notesLayer.state.activity ? {
      entryType: changes.length ? NOTES.ENTRY_TYPES.CHANGE : NOTES.ENTRY_TYPES.COMMENT,
      eventDate: act.enabled ? act.eventDate() : Date.now(), origin: NOTES.ORIGINS.APP, changesJson: encodeChanges(changes, changesMax()),
    } : null;
    const check = newNoteRecord(typed(), asked, { lengths: notesLayer.state.lengths, url, entry });
    if (check.error) { say(check.error, true); return; }
    sending = true;
    act.showStale([]);
    syncComposer();
    const done = (message = "") => { sending = false; syncComposer(); if (message && asked === target) say(message, true); };
    if (changes.length) {
      const { editor, oid, resolved } = askedActivity;
      // 1. has anyone changed what is being changed?
      let fresh;
      try {
        fresh = await editor.read(oid, resolved.edits.map((e) => e.field));
        if (!fresh) throw new Error("the request is no longer in its layer");
      } catch (err) {
        console.warn("Notes: couldn't read the request again:", err?.message ?? String(err)); // the message only: a request error carries its query (the edit)
        done(T.REQUEST_FAILED(err?.message ?? String(err)));
        return;
      }
      const stale = staleFields(changes, record.values, fresh.values, resolved.edits);
      if (stale.length) {
        record = { ...record, values: { ...record.values, ...fresh.values } };
        act.setShown(fresh.values);
        act.showStale([T.STALE(fresh.editor, when(fresh.edited)), ...stale.map((x) => T.STALE_LINE(x.label, x.nowLabel ?? T.NONE))]);
        render();
        done();
        return;
      }
      // 2. the request
      try {
        requests.update = (requests.update ?? 0) + 1;
        await editor.update(oid, Object.fromEntries(changes.map((c) => [c.field, c.to])));
      } catch (err) {
        console.warn("Notes: couldn't update the request:", err?.message ?? String(err)); // the message only: a request error carries its query (the edit)
        done(T.REQUEST_FAILED(err?.message ?? String(err)));
        return;
      }
      record = { ...record, values: { ...record.values, ...Object.fromEntries(changes.map((c) => [c.field, c.to])) } };
      act.afterSaved(Object.fromEntries(resolved.edits.map((e) => [e.field, record.values[e.field]])));
    }
    // 3. the log entry
    const p = { target: asked, subject: askedSubject, text: typed(), url, entry, retryable: changes.length > 0, files: filesAllowed() ? picker.files() : [] };
    try {
      await logEntry(p);
    } catch (err) {
      console.warn("Notes: couldn't add the log entry:", err?.message ?? String(err)); // the message only: a request error carries its query (the edit)
      if (changes.length) {
        pendingLog = p;
        done(T.LOG_FAILED(err?.message ?? String(err)));
        if (asked === target) { render(); onChanged(asked); }
      } else {
        done(T.ADD_FAILED(err?.message ?? String(err)));
      }
      return;
    }
    if (!(await uploadAfterSave(p))) return;
    finishAdd(asked);
  }
  async function retryLogging() {
    if (!pendingLog || sending) return;
    const p = pendingLog, asked = p.target;
    sending = true;
    syncComposer();
    try {
      await logEntry({ ...p, retryable: false });
    } catch (err) {
      console.warn("Notes: logging failed again:", err?.message ?? String(err)); // the message only: a request error carries its query (the edit)
      sending = false;
      syncComposer();
      say(T.LOG_FAILED(err?.message ?? String(err)), true);
      return;
    }
    pendingLog = null;
    if (!(await uploadAfterSave(p))) return;
    finishAdd(asked);
  }
  // A contact (section 51): one entry, no field changes. The fields are checked first (contactLogic.newContactRecord);
  // then the point and the author's name, as for a note. Personal details are never logged here.
  async function addContact() {
    if (sending || !target || !notesLayer.state.canAdd) return;
    const asked = target, askedSubject = subject;
    const r = contactC.ready();
    if (!r.ok) { say(r.message, true); return; }
    const input = { ...contactC.values(), text: typed(), url: linkTyped() };
    const upload = filesAllowed() ? picker.files() : [];
    let objectId = null;
    const opts = { lengths: notesLayer.state.lengths, followups: !!notesLayer.state.followups, emailField: !!notesLayer.state.followupEmail, labels: { [NOTES.FIELDS.CONTACT.METHOD]: CT.METHOD } };
    const check = newContactRecord(input, asked, opts);
    if (check.error) { say(check.error, true); return; }
    sending = true;
    syncComposer();
    try {
      const where = await anchor(askedSubject);
      const name = await authorName().catch(() => null);
      // the assignee's email (section 57: the staff list, then the roster, else null), never logged
      if (input.followup && opts.emailField) input.followup = { ...input.followup, toEmail: await followupEmail(input.followup.to).catch(() => null) };
      const final = newContactRecord(input, asked, { ...opts, authorName: name });
      if (final.error) throw new Error(final.error);
      requests.add = (requests.add ?? 0) + 1;
      objectId = (await notesLayer.state.store.add({ attributes: final.attributes, point: where.point, wkid: where.wkid }))?.objectId ?? null;
    } catch (err) {
      console.warn("Notes: couldn't add the contact:", err?.message ?? String(err));
      sending = false;
      syncComposer();
      if (asked === target) say(T.ADD_FAILED(err?.message ?? String(err)), true);
      return;
    }
    // its files, one at a time; the dialog closes only once every one is up
    if (!(await uploadAfterSave({ target: asked, objectId, files: upload, close: true }))) return;
    // a contact is logged once per call: the dialog closes, and a toast says it was added
    if (asked === target) await contactC.reset();
    finishAdd(asked, { close: true });
    toast(CT.ADDED, asked.label, { kind: "success", duration: "fast" });
  }
  // ---- files (section 55), after the entry is saved: one at a time ("Uploading 2 of 3"), each tried once more after a
  // pause if it fails. No rollback: the layer is append only, so the entry stays whatever happens to its files.
  const attachOnce = (objectId, file) => {
    requests.attach = (requests.attach ?? 0) + 1;
    return notesLayer.state.store.attach(objectId, file);
  };
  async function uploadFiles(asked, objectId, files) {
    const failed = [];
    for (const [i, file] of files.entries()) {
      if (asked === target) say(AT.UPLOADING(i + 1, files.length));
      try {
        await attachOnce(objectId, file);
      } catch (err) {
        console.warn("Notes: a file didn't upload; trying once more:", err?.message ?? err);
        await new Promise((r) => setTimeout(r, NOTES.ACTIVITY.RETRY_DELAY_MS));
        try { await attachOnce(objectId, file); } catch (again) { console.warn("Notes: a file didn't upload:", again?.message ?? again); failed.push(file); }
      }
    }
    return failed;
  }
  // p: { target, objectId, files, close }. True when every file is up (or there were none); else the composer stays on
  // "Entry saved. 1 of 3 files did not upload: <name>." with Retry, the entry's text cleared (it is saved), and the
  // list shows the entry. A contact's dialog stays open.
  async function uploadAfterSave(p) {
    if (!p.files?.length) return true;
    if (!Number.isFinite(p.objectId)) { console.warn("Notes: the entry was saved without an object id; its files can't be added."); return true; }
    const failed = await uploadFiles(p.target, p.objectId, p.files);
    if (!failed.length) return true;
    pendingFiles = { target: p.target, objectId: p.objectId, total: p.files.length, close: !!p.close };
    sending = false;
    drafts.delete(p.target.key);
    if (p.target === target) {
      textArea.value = "";
      linkInput.value = "";
      if (p.close) await contactC.reset();
      picker.markFailed(failed);
      say(AT.UPLOAD_FAILED(failed.length, p.files.length, failed.map((f) => f.name).join(", ")), true);
      syncComposer();
      load();
    }
    onChanged(p.target);
    return false;
  }
  async function retryFiles() {
    if (!pendingFiles || sending) return;
    const p = pendingFiles, files = picker.files();
    sending = true;
    syncComposer();
    const failed = await uploadFiles(p.target, p.objectId, files);
    sending = false;
    if (failed.length) {
      picker.markFailed(failed);
      say(AT.UPLOAD_FAILED(failed.length, files.length, failed.map((f) => f.name).join(", ")), true);
      syncComposer();
      load();
      return;
    }
    pendingFiles = null;
    finishAdd(p.target, { close: p.close });
    if (p.close) toast(CT.ADDED, p.target.label, { kind: "success", duration: "fast" });
  }
  // the failed files given up (removed from the list, or "Close without them"): the entry is done as it is
  function dropFailedFiles(andClose = false) {
    const p = pendingFiles;
    if (!p) return;
    pendingFiles = null;
    picker.clear();
    finishAdd(p.target, { close: p.close || andClose });
  }
  // every failed file removed from the list by hand: the same as giving them up
  function filesDropped() {
    if (pendingFiles && !sending && picker.count === 0) dropFailedFiles();
  }

  // after an add: the draft goes; a note folds the composer and shows the list, a contact closes the dialog
  function finishAdd(asked, { close: andClose = false } = {}) {
    sending = false;
    drafts.delete(asked.key);
    if (asked === target) {
      textArea.value = "";
      linkInput.value = "";
      picker.clear();
      say("");
      syncComposer();
      composing = false;
      layout();
      if (andClose && isOpen) { closing = true; dialog.open = false; }
      else { load(); requestAnimationFrame(() => newButton.setFocus?.()); }
    }
    onChanged(asked);
  }
  function say(text, bad = false) {
    composeNote.textContent = text;
    composeNote.classList.toggle("ws-note-bad", bad);
  }
  // what a stored draft holds beyond the defaults (a target with one opens with the composer shown)
  const draftHasContent = noteDraftHasContent; // draftLogic.js (also sign-out's unsaved-work check)
  function renderComposer() {
    composerHost.replaceChildren(notesLayer.state.canAdd ? composer : "");
    question.hidden = true;
    asking = null;
    pendingLog = null;
    pendingFiles = null;
    act.clear();
    linkRow.hidden = !withLinks();
    const draft = drafts.get(target.key);
    picker.node.hidden = !filesAllowed();
    picker.restore(filesAllowed() ? draft?.files ?? [] : []);
    textArea.value = draft?.text ?? "";
    linkInput.value = withLinks() ? draft?.url ?? "" : "";
    say("");
    composing = notesLayer.state.canAdd && draftHasContent(draft);
    const allowed = contactAllowed();
    modeControl.hidden = !allowed;
    restoring = true;
    setMode(allowed ? draft?.mode ?? savedMode() : "note", { save: false });
    restoring = false;
    if (allowed) {
      const asked = target;
      contactC.set({ domains: notesLayer.state.contactDomains ?? {}, followups: !!notesLayer.state.followups });
      restoring = true;
      contactC.reset().then(() => (asked === target && draft?.contact ? contactC.restore(draft.contact) : null)).finally(() => {
        restoring = false;
        if (asked === target) syncComposer();
      });
    }
    syncComposer();
  }

  // Closing with unsent text asks first (the X, the scrim and Esc all come here); the draft is kept either way.
  dialog.beforeClose = () => {
    if (closing || !notesLayer.state.canAdd || !unsent()) return Promise.resolve();
    ask("close");
    return Promise.reject(new Error("unsent note"));
  };

  function render() {
    listHost.replaceChildren();
    if (!target) return;
    states = followupState(notes, Date.now());
    if (retractedCount > 0) {
      const toggle = h("calcite-switch", { checked: showRetracted, oncalciteSwitchChange: (e) => { showRetracted = e.target.checked; load(); } });
      listHost.append(h("calcite-label", { layout: "inline", scale: "s", class: "notes-toggle" }, toggle, T.SHOW_RETRACTED(retractedCount)));
    }
    if (status === "error") listHost.append(h("div", { class: "plan-note ws-note-bad notes-error" }, T.LOAD_FAILED(message)));
    if (status === "loading-slow" && !notes.length) listHost.append(h("calcite-loader", { inline: true, scale: "s", label: T.LOADING, text: T.LOADING }));
    if (status === "ready" && !notes.length) listHost.append(h("div", { class: "plan-note notes-empty" }, T.EMPTY(target.noun)));
    const r = recordData();
    brackets.detach();
    if (notes.length || (status === "ready" && (String(r.legacy ?? "").trim() || r.received))) {
      const tl = timeline();
      listHost.append(tl);
      brackets.attach(tl, notes, { hasMore: more, now: Date.now() });
    }
    renderSummary();
    layout();
  }

  // The first page (or the next one, older: true) for the dialog's target; the retracted count with it.
  async function load({ older = false } = {}) {
    abort?.abort();
    const controller = (abort = new AbortController());
    const { signal } = controller;
    const asked = target;
    const store = notesLayer.state.store;
    if (!older) { notes = []; more = false; }
    status = "loading";
    clearTimeout(loaderTimer);
    loaderTimer = setTimeout(() => { if (status === "loading") { status = "loading-slow"; render(); } }, NOTES.LOADER_DELAY_MS);
    render();
    try {
      requests.page = (requests.page ?? 0) + 1;
      const [page, retracted] = await Promise.all([
        store.page(asked, { status: showRetracted ? null : NOTES.STATUS.ACTIVE, start: older ? notes.length : 0, num: NOTES.PAGE_SIZE, signal }),
        older ? Promise.resolve(retractedCount) : store.count(asked, NOTES.STATUS.RETRACTED, { signal }),
      ]);
      if (signal.aborted || asked !== target) return;
      const entries = page.notes.map((n) => entryOf(n));
      notes = older ? [...notes, ...entries] : entries;
      more = page.more;
      retractedCount = retracted;
      if (!retractedCount) showRetracted = false;
      status = "ready";
      files.load(entries.map((e) => e.objectId)); // one attachment query for this page, shown when it answers
    } catch (err) {
      if (err?.name === "AbortError" || signal.aborted || asked !== target) return;
      console.warn("Notes: couldn't load the notes:", err?.message ?? String(err));
      status = "error";
      message = err?.message ?? String(err);
    } finally {
      if (abort === controller) clearTimeout(loaderTimer);
    }
    render();
    if (focusEntry !== null && status === "ready") {
      const id = focusEntry;
      // an entry on a page not loaded yet (an old one opened from Follow-ups or a link): the next page, until it is shown
      if (more && !notes.some((n) => String(n.objectId) === String(id))) { load({ older: true }); return; }
      focusEntry = null;
      requestAnimationFrame(() => scrollToEntry(id));
    }
  }

  // ---- open and close
  const onEscape = (e) => {
    if (e.key !== "Escape") return;
    // the lightbox (a file's image) over the dialog takes this Esc with its own capture listener, added after this one:
    // it closes only the lightbox
    if (isLightboxOpen()) return;
    e.stopImmediatePropagation();
    e.stopPropagation();
    e.preventDefault();
    // a second Esc while asking about the draft answers "Keep writing"
    if (!question.hidden) { answer(false); return; }
    close();
  };

  // The request's current values (the edited fields, the received time, its notes field), fresh from its layer.
  async function readRecord() {
    recordAbort?.abort();
    const controller = (recordAbort = new AbortController());
    const asked = target;
    const r = activity.resolved;
    const names = [...r.edits.map((e) => e.field), r.receivedField, r.legacyNotesField].filter(Boolean);
    try {
      const fresh = await activity.editor.read(activity.oid, names, { signal: controller.signal });
      if (controller.signal.aborted || asked !== target) return null;
      record = fresh;
      applyRecord();
    } catch (err) {
      if (err?.name === "AbortError" || controller.signal.aborted) return null;
      console.warn("Notes: couldn't read the request's current values:", err?.message ?? String(err));
      record = null;
    }
    render();
    return record;
  }

  // the request's values into the field changes (when the composer has them), with the draft's changes on top
  function applyRecord() {
    if (!activity || !record || !notesLayer.state.canAdd || activityKind() === "plain") return;
    const r = activity.resolved;
    act.set({ resolved: r, values: Object.fromEntries(r.edits.map((e) => [e.field, record.values[e.field] ?? null])), canUpdate: activity.editor.canUpdate });
    act.restore(drafts.get(target.key)?.act);
    syncComposer();
  }

  function open(t, from = null, s = null, a = null, { entry = null, retracted = false } = {}) {
    if (isOpen || !t) return;
    focusEntry = entry;
    target = t;
    subject = s;
    activity = a;
    record = null;
    returnTo = from;
    closing = false;
    isOpen = true;
    showRetracted = !!retracted; // a link to a retracted entry (?entry=) opens with "Show retracted" on
    retractedCount = 0;
    dialog.heading = T.HEADING(t.label);
    subtitle.textContent = t.subtitle;
    pointInfo?.close();
    panel.setSuspended(true, "notes");
    window.addEventListener("keydown", onEscape, true);
    notes = [];
    files.reset();
    status = "idle";
    renderComposer();
    layout();
    dialog.open = true;
    load();
    if (activity) readRecord();
  }
  // focus goes to the text area (or, read only, to the dialog) once it is shown
  dialog.addEventListener("calciteDialogOpen", () => {
    if (!isOpen) return;
    if (notesLayer.state.canAdd && composing) focusComposer();
    else if (notesLayer.state.canAdd) newButton.setFocus?.();
    else dialog.setFocus?.();
  });

  function close() {
    if (isOpen) dialog.open = false;
  }

  // the dialog's own close button and the scrim close it too; tidy up once it has closed
  dialog.addEventListener("calciteDialogClose", () => {
    if (!isOpen) return;
    isOpen = false;
    abort?.abort();
    recordAbort?.abort();
    clearTimeout(loaderTimer);
    files.reset(); // every object URL revoked
    brackets.detach();
    window.removeEventListener("keydown", onEscape, true);
    if (target && (typed() || linkTyped())) saveDraft();
    closing = false;
    panel.setSuspended(false, "notes");
    const back = returnTo;
    returnTo = null;
    if (back && document.contains(back) && !back.hidden) (back.setFocus ? back.setFocus() : back.focus());
  });

  return {
    open, close, dialog,
    // unsaved work, for sign-out (section 59): drafts with content, or files uploading or waiting for Retry
    unsaved: () => unsavedWork({ drafts: [...drafts.values()], uploading: sending || !!pendingFiles }),
    get state() { return { open: isOpen, target, status, notes: notes.length, more, showRetracted, retractedCount, sending, drafts: drafts.size, asking: !question.hidden, composing, split: body.classList.contains("split"), files: files.state, brackets: brackets.state }; },
  };
}
