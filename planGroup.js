// A long plan saved as a group of pieces: one Plans record per piece, tied by GROUP_ID and numbered by PIECE_NO (1 to N
// in sheet order). No DOM and no SDK imports, so it can be tested alone. A record without a group id is a one-piece
// plan (every record saved before groups existed).
//
// Every piece's transform_json carries the whole chain (schema_version 2, the `chain` block below), so any piece can
// reopen the group. Its `version` stays 1: the fields an older reader uses (page, crop, points, transform) keep their
// meaning, with `crop` the whole sheet and `transform` the piece's own.

export const SCHEMA_VERSION = 2;

// A new group id, in the braced upper-case form ArcGIS uses for GUIDs.
export const newGroupId = (uuid = globalThis.crypto.randomUUID()) => `{${String(uuid).toUpperCase()}}`;

// What saving N pieces does to the records already in the group. existing: [{ objectId, pieceNo }] (a one-piece plan
// without a group is piece 1). Pieces 1..N update the record with that number, numbers without a record are added, and
// records past N (or a second record with the same number, which shouldn't happen) are deleted.
// Returns { updates: [{ pieceNo, objectId }], adds: [pieceNo], deletes: [objectId] }, each in piece order.
export function groupDiff(existing, count) {
  const byNo = new Map();
  const deletes = [];
  for (const r of [...existing].sort((a, b) => a.objectId - b.objectId)) {
    const no = Number(r.pieceNo) || 1;
    if (no >= 1 && no <= count && !byNo.has(no)) byNo.set(no, r.objectId);
    else deletes.push(r.objectId);
  }
  const updates = [], adds = [];
  for (let no = 1; no <= count; no++) (byNo.has(no) ? updates.push({ pieceNo: no, objectId: byNo.get(no) }) : adds.push(no));
  return { updates, adds, deletes: deletes.sort((a, b) => a - b) };
}

// The page rectangle each piece's image shows. A piece runs between its pins' columns (page points from the crop's left
// edge); cuts are moved to whole pixels of the sheet at `pxPerPt` (the preview's), and every piece but the last takes
// overlapPx more pixels on its right (PLANS.CHAIN.PIECE_OVERLAP_PX) against a hairline gap. Together they cover the
// crop exactly. pieces: [{ c0, c1 }].
export function pieceCrops(crop, pieces, pxPerPt, overlapPx = 1) {
  const n = pieces.length;
  const at = (col) => crop.x0 + Math.round(col * pxPerPt) / pxPerPt;
  return pieces.map((p, i) => {
    const x0 = i === 0 ? crop.x0 : at(p.c0);
    const x1 = i === n - 1 ? crop.x1 : Math.min(crop.x1, at(p.c1) + overlapPx / pxPerPt);
    return { x0, y0: crop.y0, x1, y1: crop.y1 };
  });
}

// The chain block of one piece's transform_json.
//   crop          the whole sheet (page points); perPt the stated scale (feet per page point, or null)
//   exact         "Fit pins exactly"; baselineRow the road row (page y, or null)
//   seed          the rough placement { source: "line" | "manual" | null, flipped, start_xy, transform } (transform:
//                 the page-space similarity it last had, or null)
//   pins          the chain's pins in sheet order: [{ id, x, y, X, Y }] (page points and the working CRS)
//   index         the piece's place in the chain (0-based); col [c0, c1] its columns (page points from the crop's left
//                 edge, without the overlap); pieceCrop the page rectangle its image shows (with the overlap)
export function chainBlock({ crop, perPt, exact, baselineRow, seed, pins, index, col, pieceCrop }) {
  const t = seed?.transform;
  return {
    sheet_pt: [crop.x1 - crop.x0, crop.y1 - crop.y0],
    fpp_stated: Number.isFinite(perPt) ? perPt : null,
    exact: !!exact,
    baseline_row: Number.isFinite(baselineRow) ? baselineRow : null,
    seed: {
      source: seed?.source ?? null, flipped: !!seed?.flipped, start_xy: seed?.start_xy ?? null,
      transform: t ? { a: t.a, b: t.b, c: t.c, d: t.d, e: t.e, f: t.f } : null,
    },
    pins: pins.map((p) => ({ id: p.id, page_pt: [p.x, p.y], target_xy: [p.X, p.Y] })),
    piece_index: index,
    col_range: [col[0], col[1]],
    piece_crop: { x0: pieceCrop.x0, y0: pieceCrop.y0, x1: pieceCrop.x1, y1: pieceCrop.y1 },
  };
}

// The chain settings a piece reopens with, from its transform_json; null for a plan saved without one.
// Returns { exact, baselineRow, seed (a page transform or null), seedInfo, seedFlip, index, col }.
export function readChain(json) {
  const c = json?.chain;
  if (!c || (json.schema_version ?? 0) < 2) return null;
  const t = c.seed?.transform;
  const seed = t && ["a", "b", "c", "d", "e", "f"].every((k) => Number.isFinite(t[k])) ? { type: "similarity", ...t } : null;
  return {
    exact: c.exact !== false,
    baselineRow: Number.isFinite(c.baseline_row) ? c.baseline_row : null,
    seed,
    seedInfo: c.seed?.source ? { source: c.seed.source, flipped: !!c.seed.flipped, start_xy: c.seed.start_xy ?? null } : null,
    seedFlip: !!c.seed?.flipped,
    index: Number.isInteger(c.piece_index) ? c.piece_index : null,
    col: Array.isArray(c.col_range) ? c.col_range.slice(0, 2) : null,
  };
}

// The status an updated piece keeps: its own, except a half-saved one ("incomplete") or none, which becomes "draft".
export const keptStatus = (status) => (status && status !== "incomplete" ? status : "draft");

// ---- plan lists: records grouped into plans (phase 6 uses these)

// The plans in a list of records: one per group id (pieces in piece order), one per record without one.
// records: [{ objectId, attributes, ... }]. Returns [{ key, groupId, pieces: [record...], first }] in the order the
// first piece of each appears.
export function groupRecords(records, F) {
  const out = [], byId = new Map();
  for (const r of records) {
    const gid = F.GROUP_ID ? r.attributes?.[F.GROUP_ID] : null;
    if (!gid) { out.push({ key: `oid:${r.objectId}`, groupId: null, pieces: [r] }); continue; }
    let g = byId.get(gid);
    if (!g) { g = { key: `group:${gid}`, groupId: gid, pieces: [] }; byId.set(gid, g); out.push(g); }
    g.pieces.push(r);
  }
  const no = (r) => Number(r.attributes?.[F.PIECE_NO]) || 0;
  for (const g of out) {
    g.pieces.sort((a, b) => no(a) - no(b) || a.objectId - b.objectId);
    g.first = g.pieces[0];
  }
  return out;
}

// ---- reopening a group

// The query for every piece of a group: GROUP_ID = '<id>' (quotes doubled).
export const groupWhere = (F, groupId) => `${F.GROUP_ID} = '${String(groupId).replace(/'/g, "''")}'`;

// The attributes an update may write back (undoing an edit): the layer's editable fields only, never the object id,
// global id or the service's own shape fields. fields: the layer's [{ name, type, editable }].
export function editableAttributes(attributes, fields) {
  const ok = new Set((fields ?? []).filter((f) => f.editable !== false && f.type !== "oid" && f.type !== "global-id").map((f) => f.name));
  return Object.fromEntries(Object.entries(attributes ?? {}).filter(([k]) => ok.has(k)));
}

// The query for the rest of the groups a search found: GROUP_ID IN ('a', 'b') (quotes doubled); null with none.
export function groupsWhere(F, groupIds) {
  const ids = [...new Set(groupIds.filter(Boolean))];
  return ids.length ? `${F.GROUP_ID} IN (${ids.map((g) => `'${String(g).replace(/'/g, "''")}'`).join(", ")})` : null;
}

// The plans in a list of records, for the Plans list: one per group (or record without one), its footprint the union
// of its pieces', its coverage worked out on that union. The plan carries its first piece's record (objectId,
// attributes: its name, status and dates are the plan's) and every piece. Pure: the operators are passed in.
//   ops: { union(geometries) -> geometry, cover(geometry, group) -> { share } | { group, detail, rank? } }
// Returns [{ objectId, attributes, geometry, groupId, pieces, pieceCount, ...coverage }].
export function collectPlans(records, F, { union, cover }) {
  return groupRecords(records, F).map((g) => {
    const geoms = g.pieces.map((r) => r.geometry).filter(Boolean);
    const geometry = geoms.length > 1 ? union(geoms) ?? geoms[0] : geoms[0] ?? null;
    return {
      objectId: g.first.objectId, attributes: g.first.attributes, geometry, groupId: g.groupId, pieces: g.pieces, pieceCount: g.pieces.length,
      ...(geometry ? cover(geometry, g) : { group: "neighbor", detail: "" }),
    };
  });
}
