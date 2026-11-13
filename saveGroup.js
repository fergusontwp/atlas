// Writing a plan (one piece, or a group of pieces) to the Plans layer, new or edited in place. No DOM and no SDK imports:
// it works on a store (plansStore.js), so a fake can stand in for the layer in tests. Never throws.
//
// Editing updates the plan's records in place (no superseded copy): pieces 1..N update the records with those numbers,
// new numbers are added, and records past N are deleted (planGroup.groupDiff). Attachments can't be part of an
// all-or-nothing request, so the order keeps every failure undoable:
//   1. one all-or-nothing request: add the new pieces, update the kept ones (attributes and footprint)
//   2. attach each piece's new files, then check what the layer holds
//   3. remove each updated piece's old files (the display prefers the newest file of a name, so a leftover is harmless)
//   4. delete the pieces that are no longer part of the plan
// A failure in 1 changes nothing. An essential file (image, tile, georef.json) that fails in 2 undoes everything done
// so far: the new files come off, and one request deletes the added pieces and puts the updated ones back as they were.
// If that fails too, the added pieces are marked "incomplete". Only the PDF failing keeps the save, with pdf_attached
// = "No" on its piece. Failures in 3 and 4 keep the save, with a warning naming the records to tidy.

import { groupDiff, keptStatus } from "./planGroup.js";

const msg = (err) => err?.message ?? String(err);

// in: {
//   store
//   pieces    [{ pieceNo, attributes, geometry: { rings, wkid }, files: [{ role, name, type, bytes, data }] }], 1..N in
//             order; files in attach order (image or tiles, then the PDF on the piece that carries it, then georef.json)
//   existing  the plan's records as they are now ([] for a new plan): [{ objectId, pieceNo, attributes, geometry:
//             { rings, wkid }, files: [{ id, name }] }]
//   keepOld   (pieceNo, file) -> true for an old file to keep on an updated piece (the PDF when it isn't replaced)
//   F         PLANS.FIELDS
//   onProgress(text)
// }
// Resolves to { ok: true, objectIds (by piece), added, updated, deleted, warnings } or
// { ok: false, stage, message, reverted, incomplete }.
export async function saveGroup({ store, pieces, existing = [], keepOld = () => false, F, onProgress = () => {} }) {
  const warnings = [];
  const diff = groupDiff(existing.map((r) => ({ objectId: r.objectId, pieceNo: r.pieceNo })), pieces.length);
  const old = new Map(existing.map((r) => [r.objectId, r]));
  const pieceOf = (no) => pieces[no - 1];
  const many = pieces.length > 1;
  const label = (no) => (many ? `piece ${no}` : "the plan");

  // 1. the records
  onProgress(many ? `Saving the ${pieces.length} plan records…` : "Saving the plan record…");
  const updates = diff.updates.map(({ pieceNo, objectId }) => {
    const p = pieceOf(pieceNo);
    return { objectId, attributes: { ...p.attributes, [F.STATUS]: keptStatus(old.get(objectId)?.attributes?.[F.STATUS]) }, rings: p.geometry.rings, wkid: p.geometry.wkid };
  });
  const adds = diff.adds.map((no) => { const p = pieceOf(no); return { attributes: p.attributes, rings: p.geometry.rings, wkid: p.geometry.wkid }; });
  let addIds;
  try {
    ({ addIds } = await store.edit({ adds, updates }));
  } catch (err) {
    return { ok: false, stage: "record", message: `The plan ${many ? "records" : "record"} couldn't be saved. ${msg(err)}`, reverted: true, incomplete: false };
  }
  const idOf = new Map([...diff.updates.map((u) => [u.pieceNo, u.objectId]), ...diff.adds.map((no, i) => [no, addIds[i]])]);
  const added = diff.adds.map((no) => idOf.get(no));
  const newFiles = new Map(); // objectId -> [{ id, name, bytes, role }]

  // undo everything done so far (an essential file failed)
  const revert = async (stage, message) => {
    for (const [objectId, list] of newFiles) {
      try { await store.detach(objectId, list.map((f) => f.id).filter((id) => id != null)); } catch { /* the records go back below either way */ }
    }
    try {
      await store.edit({
        deletes: added,
        updates: diff.updates.map(({ objectId }) => { const r = old.get(objectId); return { objectId, attributes: r.attributes, rings: r.geometry?.rings, wkid: r.geometry?.wkid }; }),
      });
      return { ok: false, stage, message: `${message} Nothing was changed on the layer.`, reverted: true, incomplete: false };
    } catch (err) {
      let marked = 0;
      for (const objectId of added) {
        try { await store.update(objectId, { [F.STATUS]: "incomplete" }); marked++; } catch { /* nothing more from here */ }
      }
      const ids = [...added, ...diff.updates.map((u) => u.objectId)];
      return {
        ok: false, stage, reverted: false, incomplete: marked > 0,
        message: `${message} The save couldn't be undone (${msg(err)})${marked ? "; the new records were marked incomplete" : ""}. Ask an admin to check records ${ids.join(", ")} in the Plans layer.`,
      };
    }
  };

  // 2. the files, then a check of what the layer holds
  const pdfLost = new Set();
  for (const p of pieces) {
    const objectId = idOf.get(p.pieceNo);
    const list = [];
    newFiles.set(objectId, list);
    for (const f of p.files) {
      onProgress(`Saving ${many ? `piece ${p.pieceNo}: ` : ""}${f.name}…`);
      try {
        const { id } = await store.attach(objectId, { name: f.name, type: f.type, data: f.data });
        list.push({ id, name: f.name, bytes: f.bytes, role: f.role });
      } catch (err) {
        if (f.role === "pdf") { pdfLost.add(p.pieceNo); continue; }
        return revert(f.role === "image" ? "image" : "georef", `${f.name} of ${label(p.pieceNo)} couldn't be saved. ${msg(err)}`);
      }
    }
  }
  onProgress("Checking the saved files…");
  for (const p of pieces) {
    const objectId = idOf.get(p.pieceNo);
    let held;
    try { held = await store.attachments(objectId); } catch (err) { return revert("verify", `The saved files couldn't be checked. ${msg(err)}`); }
    const has = (f) => held.some((a) => (f.id != null ? a.id === f.id : a.name === f.name) && Number(a.size) === Number(f.bytes));
    const sent = newFiles.get(objectId);
    const missing = p.files.filter((f) => f.role !== "pdf" && !sent.some((s) => s.name === f.name && has(s)));
    if (missing.length) return revert("verify", `${missing.map((f) => f.name).join(", ")} of ${label(p.pieceNo)} ${missing.length === 1 ? "is" : "are"} missing or the wrong size on the layer.`);
    const pdf = sent.find((s) => s.role === "pdf");
    if (pdf && !has(pdf)) pdfLost.add(p.pieceNo);
  }

  // the PDF alone failing keeps the save
  for (const no of pdfLost) {
    const objectId = idOf.get(no);
    try { await store.update(objectId, { [F.PDF_ATTACHED]: "No" }); } catch { warnings.push(`The PDF is not stored, and the record still says it is: set pdf_attached to No on record ${objectId}.`); }
    warnings.push("The original PDF couldn't be saved with the plan. Adjusting this plan later will need the PDF chosen again.");
  }

  // 3. the old files of updated pieces
  for (const { pieceNo, objectId } of diff.updates) {
    const stale = (old.get(objectId).files ?? []).filter((f) => !keepOld(pieceNo, f)).map((f) => f.id);
    if (!stale.length) continue;
    onProgress("Removing the previous files…");
    try { await store.detach(objectId, stale); } catch (err) {
      warnings.push(`Record ${objectId} still holds its previous files too (${msg(err)}). The new ones are shown; an admin can remove the older ones.`);
    }
  }

  // 4. the pieces that are no longer part of the plan
  if (diff.deletes.length) {
    onProgress(`Removing ${diff.deletes.length} piece${diff.deletes.length === 1 ? "" : "s"} that the plan no longer has…`);
    try { await store.edit({ deletes: diff.deletes }); } catch (err) {
      warnings.push(`Record${diff.deletes.length === 1 ? "" : "s"} ${diff.deletes.join(", ")} ${diff.deletes.length === 1 ? "is" : "are"} no longer part of the plan but couldn't be removed (${msg(err)}). Ask an admin to delete ${diff.deletes.length === 1 ? "it" : "them"} in the Plans layer.`);
    }
  }
  return { ok: true, objectIds: pieces.map((p) => idOf.get(p.pieceNo)), added, updated: diff.updates.map((u) => u.objectId), deleted: diff.deletes, warnings };
}
