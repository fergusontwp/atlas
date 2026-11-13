import { NOTES } from "./config.js";

// The Notes dialog's entry list as a vertical timeline (section 56): pure. notesDialog.js draws the rows.
//
// timelineRows(entries, opts) -> rows, top to bottom, for entries already in their order (newest first; retracted ones
// stay where they are):
//   { kind: "newest" }                                  the top of the rail (left out when `previous` is given)
//   { kind: "year", year }                              a year pill before the first row of a year that differs from the
//                                                       row above (or, for the first row, from the current year)
//   { kind: "entry", entry, time, logged, dot, imported, retracted }
//       time: the event time (null when unknown); logged: the creation time when it shows "logged <day>", else null:
//       only for entries not imported (origin app, or detected as before) logged more than ACTIVITY.LATE_LOG_MS from
//       their event (entryOf's loggedLate); never for origin import (the backfill shares one import date).
//       dot: "hollow" for an imported entry, else "filled".
//   { kind: "legacy", text }                            the request's notes field (not stored), no date
//   { kind: "received", time }                          "Request received <time>" (not stored)
//   { kind: "older" } | { kind: "oldest" }              the bottom: "Show older notes" while more pages exist, else
//                                                       "Oldest"; the request rows only come with "Oldest"
// opts: { now (ms; its year is "the current year"), hasMore, legacy (text or null), received (ms or null), previous (the
// row above the first entry, when rows are built a page at a time: its year carries over and "newest" is left out) }.
export function timelineRows(entries, { now = Date.now(), hasMore = false, legacy = null, received = null, previous = null, cfg = NOTES } = {}) {
  const rows = [];
  const yearOf = (t) => (Number.isFinite(t) ? new Date(t).getFullYear() : null);
  let lastYear = previous ? yearOf(previous.eventTime ?? previous.time) ?? yearOf(now) : yearOf(now);
  const dated = (t) => {
    const y = yearOf(t);
    if (y === null) return;
    if (y !== lastYear) rows.push({ kind: "year", year: y });
    lastYear = y;
  };
  if (!previous) rows.push({ kind: "newest" });
  for (const entry of entries ?? []) {
    const time = Number.isFinite(entry?.eventTime) ? entry.eventTime : null;
    dated(time);
    const imported = entry.origin === cfg.ORIGINS.IMPORT;
    const logged = !imported && entry.loggedLate && Number.isFinite(entry.created) ? entry.created : null;
    rows.push({ kind: "entry", entry, time, logged, dot: imported ? "hollow" : "filled", imported, retracted: entry.status === cfg.STATUS.RETRACTED });
  }
  if (hasMore) {
    rows.push({ kind: "older" });
    return rows;
  }
  const text = typeof legacy === "string" ? legacy.trim() : "";
  if (text) rows.push({ kind: "legacy", text });
  if (Number.isFinite(received)) {
    dated(received);
    rows.push({ kind: "received", time: received });
  }
  rows.push({ kind: "oldest" });
  return rows;
}

// "logged Nov 2", with the year when it differs from the event's ("logged Jan 3, 2027"). fmt(ms, options) formats.
export function loggedText(logged, eventTime, fmt, cfg = NOTES) {
  if (!Number.isFinite(logged)) return "";
  const T = cfg.TIMELINE;
  const sameYear = Number.isFinite(eventTime) && new Date(eventTime).getFullYear() === new Date(logged).getFullYear();
  return T.TEXT.LOGGED(fmt(logged, sameYear ? T.LOGGED : { ...T.LOGGED, year: "numeric" }));
}

// The stacked layout as a container query on the list pane (container "notes-list"), at the configured width: CSS
// can't take a variable in an @container condition, so this one rule is built from config and added to the page once.
// Below STACK_BELOW the date sits above its card on one line ("Nov 9, 2026 · 2:14 PM"), and the rail and dots stay on
// the left edge.
export function timelineStackCss(cfg = NOTES) {
  const below = cfg.TIMELINE.STACK_BELOW;
  return `@container notes-list (max-width: ${below}) {
  .notes-timeline { --tl-first-line: 9px; }
  .notes-timeline::before { left: calc(var(--tl-rail, 29px) / 2 - var(--tl-line, 3px) / 2); }
  .tl-item { grid-template-columns: var(--tl-rail, 29px) minmax(0, 1fr); row-gap: 4px; }
  .tl-item > .tl-rail { grid-column: 1; grid-row: 1 / span 2; }
  .tl-item > .tl-date { grid-column: 2; grid-row: 1; text-align: left; padding-top: 0; }
  .notes-timeline.has-brackets .tl-item > .tl-date { margin-left: var(--tl-lanes-w, 0px); }
  .tl-item > .tl-card { grid-column: 2; grid-row: 2; }
  .tl-date .tl-day, .tl-date .tl-time, .tl-date .tl-logged, .tl-date .tl-sep { display: inline; }
  .tl-year > .tl-date { display: none; }
  .tl-year > .tl-rail { grid-row: 1; justify-content: flex-start; }
  .tl-end > .tl-rail { grid-row: 1; }
  .tl-end > .tl-date { grid-row: 1; }
  .tl-older > .notes-older { grid-column: 2; grid-row: 1; }
  .tl-older > .tl-date { display: none; }
}`;
}
