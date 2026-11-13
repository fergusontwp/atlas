// "What's here?" (pointInfo.js): the pure parts, tested. No DOM, no SDK.

// Whether a button-2 press and release was a click (not a rotate or a long press). down/up: { x, y, t (ms), button,
// rotation (the view's, degrees) }. cfg: { CLICK_MAX_MOVE_PX, CLICK_MAX_MS }.
export function isRightClick(down, up, cfg) {
  if (!down || !up || down.button !== 2 || up.button !== 2) return false;
  if (Math.hypot(up.x - down.x, up.y - down.y) > cfg.CLICK_MAX_MOVE_PX) return false;
  if (up.t - down.t > cfg.CLICK_MAX_MS) return false;
  return up.rotation === down.rotation;
}

// "40.793412, -77.860123": lat, long in decimal degrees (the order Google Maps and staff paste). The same text is copied.
export const latLonText = (lat, lon, decimals) => `${lat.toFixed(decimals)}, ${lon.toFixed(decimals)}`;

// Google's documented Maps URL for a point, from the template's {lat} and {lon}.
export const googleMapsUrl = (template, lat, lon, decimals) =>
  template.replace("{lat}", encodeURIComponent(lat.toFixed(decimals))).replace("{lon}", encodeURIComponent(lon.toFixed(decimals)));

// The address to show from a reverse geocode (AddressCandidate: attributes are the service's `address` object): its full
// label, else Match_addr, else the candidate's address; null when there is none.
export function geocodeLabel(candidate) {
  const a = candidate?.attributes ?? {};
  for (const v of [a.LongLabel, a.Match_addr, candidate?.address]) {
    const s = typeof v === "string" ? v.trim() : "";
    if (s) return s;
  }
  return null;
}

// Why a reverse geocode failed: "none" (the service found no address near the point), "timeout", "signin", or "error".
export function geocodeFailure(err, { timedOut = false } = {}) {
  if (timedOut) return "timeout";
  const text = [err?.message, ...(err?.details?.messages ?? []), err?.details?.raw?.error?.message].filter(Boolean).join(" ");
  if (/unable to find address|no address|address not found/i.test(text)) return "none";
  const code = err?.details?.httpStatus ?? err?.details?.raw?.error?.code ?? err?.details?.code;
  if ([401, 403, 498, 499].includes(code) || /token|sign.?in|not authorized|permission/i.test(text)) return "signin";
  return "error";
}

// The parcel section from a query's features (attributes only): { status: "none" | "empty" | "ok", address, id,
// multiple }. Two or more hits (overlapping parcels): the lowest object id, and multiple = the count.
export function parcelSection(features, { addressField, idField, oidField }) {
  const list = (features ?? []).filter((f) => f?.attributes);
  if (!list.length) return { status: "none", address: null, id: null, multiple: 0 };
  const f = list.length > 1 ? [...list].sort((p, q) => Number(p.attributes[oidField]) - Number(q.attributes[oidField]))[0] : list[0];
  const raw = f.attributes[addressField], address = raw === null || raw === undefined ? "" : String(raw).trim();
  const id = f.attributes[idField] ?? null;
  return { status: address ? "ok" : "empty", address: address || null, id: id === null ? null : String(id), multiple: list.length > 1 ? list.length : 0 };
}

// "About 40 ft from the click." / "About 0.2 mi from the click." (past mileFromFt). cfg: { ROUND_FT, MILE_FROM_FT }.
export function distanceText(ft, cfg) {
  if (!Number.isFinite(ft)) return "";
  if (ft < cfg.ROUND_FT) return `Less than ${cfg.ROUND_FT} ft from the click.`;
  if (ft <= cfg.MILE_FROM_FT) return `About ${(Math.round(ft / cfg.ROUND_FT) * cfg.ROUND_FT).toLocaleString("en-US")} ft from the click.`;
  const mi = ft / 5280;
  return `About ${mi < 10 ? mi.toFixed(1) : Math.round(mi).toLocaleString("en-US")} mi from the click.`;
}

// The cache key of a point in feet (2271): the point rounded to a grid of roundFt.
export const cacheKey = (x, y, roundFt) => `${Math.round(x / roundFt)}:${Math.round(y / roundFt)}`;

// The cached answer for a point (x, y in feet): one asked within roundFt of it, the nearest if several, else undefined.
// Answers are stored under cacheKey and carry the point they were asked for ({ x, y, ... }); the point's own cell and
// its eight neighbours are looked at, so two clicks a few feet apart on either side of a grid line still match.
export function cacheFind(cache, x, y, roundFt) {
  const cx = Math.round(x / roundFt), cy = Math.round(y / roundFt);
  let best = null, bestD = Infinity;
  for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
    const k = `${cx + i}:${cy + j}`, v = cache.peek(k);
    const d = v ? Math.hypot(v.x - x, v.y - y) : Infinity;
    if (d <= roundFt && d < bestD) { best = k; bestD = d; }
  }
  return best ? cache.get(best) : undefined;
}

// A small in-memory cache that forgets the least recently used past `size`. get() refreshes an entry.
export function createCache(size) {
  const m = new Map();
  return {
    get(k) { if (!m.has(k)) return undefined; const v = m.get(k); m.delete(k); m.set(k, v); return v; },
    peek: (k) => m.get(k),
    set(k, v) { m.delete(k); m.set(k, v); while (m.size > size) m.delete(m.keys().next().value); },
    has: (k) => m.has(k),
    get size() { return m.size; },
    clear: () => m.clear(),
  };
}

// Where the card goes: upper right of the click by default; flipped left or down when it would leave the map area, then
// clamped inside it. point: { x, y } in the map area's pixels; card: { w, h }; area: { w, h }; opts: { gap, margin }.
// Returns { left, top, side: { x: "right" | "left", y: "up" | "down" } } (side: where the card is from the point, for its tail).
export function placeCard(point, card, area, { gap, margin }) {
  let x = "right", y = "up";
  let left = point.x + gap, top = point.y - gap - card.h;
  if (left + card.w > area.w - margin) { x = "left"; left = point.x - gap - card.w; }
  if (top < margin) { y = "down"; top = point.y + gap; }
  left = Math.max(margin, Math.min(left, area.w - margin - card.w));
  top = Math.max(margin, Math.min(top, area.h - margin - card.h));
  return { left, top, side: { x, y } };
}
