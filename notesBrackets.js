import { h } from "./dom.js";
import { NOTES } from "./config.js";
import { assignLanes, bracketColors, followupChains } from "./followupLinks.js";
import { cssColor } from "./themeLogic.js";

// Follow-up brackets on the Notes timeline (section 57): a second, smaller rail between the main rail and the cards
// that joins each follow-up chain (followupLinks.js), with a tick level with each member card's first line, in its lane's
// color (section 58; softer since section 60), thinner than the rail. Drawn after
// render from the cards' measured offsets, in an overlay inside the timeline (so it scrolls with the list), and drawn
// again, at most once per animation frame, whenever the timeline or any card changes size (files arriving late, the
// Customer toggle, a narrower window). The overlay is absolutely placed and never changes the layout, so a redraw can't
// start another. Decorative (aria-hidden): each card's text already says it ("Follow up by …", "Closed follow-up from
// …", "Show it").
//
// The lanes take room (used × LANE_WIDTH, as --tl-lanes-w on the timeline, read by the cards' margin) only when the
// loaded list has a chain that got a lane: a feature with no follow-ups looks as before.
export function createFollowupBrackets(cfg = NOTES.TIMELINE.FOLLOWUP) {
  let host = null, overlay = null, chains = [], lanes = [], used = 0, frame = 0, draws = 0;
  const ro = typeof ResizeObserver === "function" ? new ResizeObserver(() => schedule()) : null;

  function schedule() {
    if (frame || !host) return;
    frame = requestAnimationFrame(() => { frame = 0; draw(); });
  }

  // timeline: the .notes-timeline element just rendered; entries: every loaded entry in its rendered order
  function attach(timeline, entries, { hasMore = false, now = Date.now() } = {}) {
    detach();
    if (!cfg?.SHOW || !timeline) return;
    host = timeline;
    chains = followupChains(entries, { now, hasMore });
    const r = assignLanes(chains, entries.map((e) => e.objectId), cfg.MAX_LANES);
    lanes = r.lanes;
    used = r.used;
    if (!used) { host = null; return; }
    timeline.classList.add("has-brackets");
    timeline.style.setProperty("--tl-lanes-w", `calc(${used} * var(--tl-lane-w, ${cfg.LANE_WIDTH}))`);
    overlay = h("div", { class: "tl-brackets" });
    overlay.setAttribute("aria-hidden", "true");
    timeline.append(overlay);
    if (ro) {
      ro.observe(timeline);
      timeline.querySelectorAll(".tl-card").forEach((c) => ro.observe(c));
    }
    schedule();
  }
  function detach() {
    ro?.disconnect();
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    host = null;
    overlay = null;
    chains = [];
    lanes = [];
    used = 0;
  }

  // the middle of a card's first line, from the timeline's top (the main rail's dot sits at the same level)
  function firstLine(card, top) {
    const first = card.firstElementChild ?? card;
    const f = first.getBoundingClientRect();
    const lh = parseFloat(getComputedStyle(first).lineHeight);
    return f.top - top + Math.min(f.height, Number.isFinite(lh) ? lh : 20) / 2;
  }

  function draw() {
    if (!host || !overlay || !host.isConnected) return;
    draws++;
    const box = host.getBoundingClientRect();
    const cards = new Map([...host.querySelectorAll(".tl-card[data-oid]")].map((c) => [c.dataset.oid, c]));
    const anyCard = cards.values().next().value;
    if (!anyCard) { overlay.replaceChildren(); return; }
    const cardLeft = anyCard.getBoundingClientRect().left - box.left;
    const newest = host.querySelector(".tl-newest")?.getBoundingClientRect();
    const older = host.querySelector(".tl-older")?.getBoundingClientRect();
    const newestBottom = newest ? newest.bottom - box.top : 0;
    const olderMid = older ? older.top + older.height / 2 - box.top : null;
    const parts = [];
    const seg = (cls, color, style) => {
      const el = h("span", { class: `tl-bk ${cls}` });
      el.style.setProperty("--bk-color", cssColor(color)); // a token, a #rrggbb or { LIGHT, DARK } (section 60)
      Object.assign(el.style, style);
      parts.push(el);
    };
    // whole pixels everywhere (section 58): a line centred on a half pixel paints two pixel columns, as thick as the rail
    const css = getComputedStyle(host), px = (name, fallback) => { const v = parseFloat(css.getPropertyValue(name)); return Number.isFinite(v) ? v : fallback; };
    const lw = px("--tl-bk-w", parseFloat(cfg.LINE_WIDTH) || 1), laneW = px("--tl-lane-w", parseFloat(cfg.LANE_WIDTH) || 10), gap = px("--tl-tick-gap", 0);
    const R = Math.round;
    chains.forEach((c, i) => {
      const lane = lanes[i];
      if (lane === null || lane === undefined) return;
      const ys = c.ids.map((id) => cards.get(String(id))).filter(Boolean).map((card) => firstLine(card, box.top));
      if (!ys.length) return;
      const { line: color, stub } = bracketColors(c, lane, cfg);
      const xl = R(cardLeft - (lane + 1) * laneW - lw / 2), x = `${xl}px`;
      const top = Math.min(...ys), last = Math.max(...ys);
      const tickTop = (y) => R(y - lw / 2);
      // the line from the top tick's top to the bottom tick's bottom: square corners with both
      if (last > top) seg("tl-bk-line", color, { left: x, top: `${tickTop(top)}px`, height: `${tickTop(last) - tickTop(top) + lw}px` });
      if (c.offPage && olderMid !== null && olderMid > last) seg("tl-bk-line dashed", color, { left: x, top: `${tickTop(last) + lw}px`, height: `${R(olderMid) - tickTop(last) - lw}px` });
      for (const y of ys) seg("tl-bk-tick", color, { left: x, top: `${tickTop(y)}px`, width: `${R(cardLeft - gap) - xl}px` });
      if (stub) {
        const end = tickTop(top);
        const from = `max(${R(newestBottom)}px, calc(${end}px - var(--tl-stub)))`;
        seg("tl-bk-line dashed tl-bk-stub", stub, { left: x, top: from, height: `calc(${end}px - ${from})` });
      }
    });
    overlay.replaceChildren(...parts);
  }

  return {
    attach, detach, schedule,
    get state() { return { used, draws, chains: chains.map((c, i) => ({ ...c, lane: lanes[i] })) }; },
  };
}
