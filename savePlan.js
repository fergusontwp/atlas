// Writing a plan to the Plans layer, in the order the design requires, with the failure handling that keeps the layer
// clean. No DOM and no SDK imports: it works on a store (plansStore.js), so a fake can stand in for the layer in tests.
//
// Order: add the record, then the attachments (the image or each tile, then the PDF, then georef.json if the transform
// is too long for its field), then check what the layer actually holds, and only then mark an older plan superseded.
//   - The image or georef.json fails, or is missing/short when checked: the new record is deleted (rolled back). If that
//     delete fails too, the record is set to status "incomplete" so nobody trusts it.
//   - Only the PDF fails: the record stays with pdf_attached = "No".
//   - Marking the old plan superseded fails: the new plan stays, with a warning.
// Resolves to { ok: true, objectId, warnings } or { ok: false, stage, message, rolledBack, incomplete }. Never throws.

const msg = (err) => err?.message ?? String(err);

// record: buildPlanRecord's result; geometry: { rings, wkid } in the layer's spatial reference;
// files: [{ role, name, type, bytes, data }] in attach order (image/tiles, pdf if any, georef if any);
// supersedes: the objectId of the plan this replaces, or null.
export async function savePlan({ store, record, geometry, files, F, supersedes = null, onProgress = () => {} }) {
  const warnings = [];
  const attributes = { ...record.attributes };
  if (supersedes != null) attributes[F.SUPERSEDES] = String(supersedes);

  onProgress("Saving the plan record…");
  let objectId;
  try {
    ({ objectId } = await store.add({ attributes, rings: geometry.rings, wkid: geometry.wkid }));
  } catch (err) {
    return { ok: false, stage: "record", message: `The plan record couldn't be saved. ${msg(err)}`, rolledBack: true, incomplete: false };
  }

  // an essential file (image, tile, georef.json) that can't be stored undoes the whole save
  const undo = async (stage, message) => {
    try {
      await store.rollback(objectId);
      return { ok: false, stage, message, rolledBack: true, incomplete: false };
    } catch (err) {
      let incomplete = false;
      try {
        await store.update(objectId, { [F.STATUS]: "incomplete" });
        incomplete = true;
      } catch { /* nothing more can be done from here */ }
      return {
        ok: false, stage, rolledBack: false, incomplete,
        message: `${message} The half-saved record couldn't be removed${incomplete ? " and was marked incomplete" : ""}; ask an admin to delete record ${objectId} in the Plans layer.`,
      };
    }
  };

  let pdfLost = false;
  for (const f of files) {
    onProgress(`Saving ${f.name}…`);
    try {
      await store.attach(objectId, { name: f.name, type: f.type, data: f.data });
    } catch (err) {
      if (f.role === "pdf") { pdfLost = true; continue; }
      return undo(f.role === "image" ? "image" : "georef", `${f.name} couldn't be saved. ${msg(err)}`);
    }
  }

  // check what the layer holds
  onProgress("Checking the saved files…");
  let held = null;
  try {
    held = await store.attachments(objectId);
  } catch (err) {
    return undo("verify", `The saved files couldn't be checked. ${msg(err)}`);
  }
  const has = (f) => held.some((a) => a.name === f.name && Number(a.size) === Number(f.bytes));
  const essentialMissing = files.filter((f) => f.role !== "pdf" && !has(f));
  if (essentialMissing.length) return undo("verify", `${essentialMissing.map((f) => f.name).join(", ")} ${essentialMissing.length === 1 ? "is" : "are"} missing or the wrong size on the layer.`);
  const pdf = files.find((f) => f.role === "pdf");
  if (pdf && (pdfLost || !has(pdf))) {
    try {
      await store.update(objectId, { [F.PDF_ATTACHED]: "No" });
    } catch (err) {
      warnings.push(`The PDF is not stored, and the record still says it is: set pdf_attached to No on record ${objectId}.`);
    }
    warnings.push("The original PDF couldn't be saved with the plan. Adjusting this plan later will need the PDF uploaded again.");
  }

  if (supersedes != null) {
    onProgress("Marking the older plan as superseded…");
    try {
      await store.update(supersedes, { [F.STATUS]: "superseded" });
    } catch (err) {
      warnings.push(`The new plan is saved, but the older one couldn't be marked superseded (${msg(err)}). Set its status to superseded in the Plans layer.`);
    }
  }
  return { ok: true, objectId, warnings };
}
