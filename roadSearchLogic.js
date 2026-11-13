// Road search (search.js, Road mode): the pure parts, tested. No DOM, no SDK.

// The full street name from its parts in order (St_PreDir, St_Name, St_PosTyp): trimmed, empty and null parts skipped,
// single spaces ("N Atherton St").
export const streetName = (parts) => parts.map((p) => (p === null || p === undefined ? "" : String(p).trim())).filter(Boolean).join(" ");

// A street name or typed text as words to compare: uppercase, punctuation as spaces, each abbreviation read as its full
// word (ST and STREET both become STREET). abbreviations: { ST: "STREET", ... }.
export function normalizeStreet(text, abbreviations) {
  return words(text).map((w) => abbreviations[w] ?? w).join(" ");
}
const words = (text) => String(text ?? "").toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim().split(" ").filter(Boolean);

// How a name matches typed text: 0 starts with it, 1 contains it, -1 no match. The last typed word may still be
// half-typed ("S" on its way to "SCIENCE"), so it is also tried as typed, not expanded.
export function streetRank(name, text, abbreviations) {
  const target = normalizeStreet(name, abbreviations), w = words(text);
  if (!w.length) return -1;
  const full = w.map((x) => abbreviations[x] ?? x).join(" ");
  const raw = [...w.slice(0, -1).map((x) => abbreviations[x] ?? x), w.at(-1)].join(" ");
  let best = -1;
  for (const q of new Set([full, raw])) {
    const r = target.startsWith(q) ? 0 : target.includes(q) ? 1 : -1;
    if (r >= 0 && (best < 0 || r < best)) best = r;
  }
  return best;
}

// Streets matching typed text: starts-with before contains, then alphabetical; at most max.
// streets: [{ name, ... }] (returned as given, with rank added).
export function matchStreets(streets, text, abbreviations, max) {
  const hits = [];
  for (const s of streets) {
    const rank = streetRank(s.name, text, abbreviations);
    if (rank >= 0) hits.push({ ...s, rank });
  }
  hits.sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));
  return hits.slice(0, max);
}

// Street names from grouped rows (one per distinct combination of the name fields, with its segment count, or 1 when
// counts weren't available): [{ name, combos: [[pre, name, type], ...], count }], combinations that join to the same
// name ("" and null parts) kept together. rows: [{ parts: [...], count }]. Rows with no name are dropped.
export function streetsFromRows(rows) {
  const byName = new Map();
  for (const { parts, count } of rows) {
    const name = streetName(parts);
    if (!name) continue;
    const s = byName.get(name) ?? { name, combos: [], count: 0 };
    s.combos.push(parts);
    s.count += Number.isFinite(count) ? count : 1;
    byName.set(name, s);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// The where clause for a street's segments: an exact match on each part (= 'x', or IS NULL), quotes doubled; several
// combinations joined with OR. Never a match on the joined name.
export function segmentWhere(fields, combos) {
  const one = (parts) => fields.map((f, i) => {
    const v = parts[i];
    return v === null || v === undefined ? `${f} IS NULL` : `${f} = '${String(v).replace(/'/g, "''")}'`;
  }).join(" AND ");
  return combos.length === 1 ? one(combos[0]) : combos.map((c) => `(${one(c)})`).join(" OR ");
}

// Typed text split into street parts on "&", "@", "/", " and " or " at " (any case). One part: a street; two: an
// intersection (the second may still be empty while typing); more: too many.
export function splitIntersection(text) {
  return String(text ?? "").split(/\s*[&@/]\s*|\s+(?:and|at)\s+/i).map((p) => p.trim());
}

// Where two streets meet, from their lines (in feet): [[x, y], ...], one per intersection, west to east.
// a, b: lists of polylines, each a list of paths, each a list of [x, y]. A point is found where a vertex or end of one
// lies within tolFt of the other's line (a shared vertex, an end on the other street, a near miss) or where two segments
// truly cross; points within mergeFt of each other are one intersection (their mean).
export function meetingPoints(a, b, { tolFt, mergeFt }) {
  const segs = (lines) => lines.flatMap((paths) => paths.flatMap((path) => path.slice(1).map((p, i) => [path[i], p])));
  const sa = segs(a), sb = segs(b);
  const hits = [];
  for (const s of sa) {
    for (const t of sb) {
      if (!boxesNear(s, t, tolFt)) continue;
      const x = crossing(s, t);
      if (x) { hits.push(x); continue; }
      for (const [p, seg] of [[s[0], t], [s[1], t], [t[0], s], [t[1], s]]) {
        if (distToSeg(p, seg) <= tolFt) hits.push(p);
      }
    }
  }
  // greedy clusters: each hit joins the first cluster whose first point is within mergeFt
  const clusters = [];
  for (const p of hits) {
    const c = clusters.find((k) => Math.hypot(k.first[0] - p[0], k.first[1] - p[1]) <= mergeFt);
    if (c) { c.sx += p[0]; c.sy += p[1]; c.n++; } else clusters.push({ first: p, sx: p[0], sy: p[1], n: 1 });
  }
  return clusters.map((c) => [c.sx / c.n, c.sy / c.n]).sort((p, q) => p[0] - q[0] || p[1] - q[1]);
}
function boxesNear([p, q], [r, s], tol) {
  return Math.min(p[0], q[0]) - tol <= Math.max(r[0], s[0]) && Math.min(r[0], s[0]) - tol <= Math.max(p[0], q[0])
    && Math.min(p[1], q[1]) - tol <= Math.max(r[1], s[1]) && Math.min(r[1], s[1]) - tol <= Math.max(p[1], q[1]);
}
// the point where two segments properly cross (not at an end, not parallel), else null
function crossing([p, q], [r, s]) {
  const d = (q[0] - p[0]) * (s[1] - r[1]) - (q[1] - p[1]) * (s[0] - r[0]);
  if (d === 0) return null;
  const u = ((r[0] - p[0]) * (s[1] - r[1]) - (r[1] - p[1]) * (s[0] - r[0])) / d;
  const v = ((r[0] - p[0]) * (q[1] - p[1]) - (r[1] - p[1]) * (q[0] - p[0])) / d;
  if (u <= 0 || u >= 1 || v <= 0 || v >= 1) return null;
  return [p[0] + u * (q[0] - p[0]), p[1] + u * (q[1] - p[1])];
}
function distToSeg(p, [a, b]) {
  const dx = b[0] - a[0], dy = b[1] - a[1], len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len)) : 0;
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}
