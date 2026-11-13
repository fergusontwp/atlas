// Work in progress on a mosaic, kept in the browser (IndexedDB), so a page reload or a closed workspace doesn't lose a
// 10-view mosaic. One draft per PDF, keyed by its name and size; the clips' images aren't kept (they are rendered again
// from the PDF), only what was clipped and how the views were joined. Each call opens the database, so nothing stays
// open between saves; a browser without IndexedDB (or a private window that refuses it) just keeps no draft.

const DB = "atlas-mosaic", STORE = "drafts";

function open() {
  return new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) { reject(new Error("IndexedDB isn't available")); return; }
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function run(mode, fn) {
  const db = await open();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode), req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req?.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export const draftKey = (pdf) => `${pdf?.name ?? ""}|${pdf?.size ?? ""}`;
// The draft for a PDF, or null. Failures read as no draft.
export async function loadDraft(key) {
  try { return (await run("readonly", (s) => s.get(key))) ?? null; } catch (err) { console.warn("Couldn't read the mosaic draft:", err); return null; }
}
export async function saveDraft(key, data) {
  try { await run("readwrite", (s) => s.put({ ...data, saved: Date.now() }, key)); return true; } catch (err) { console.warn("Couldn't keep the mosaic draft:", err); return false; }
}
export async function clearDraft(key) {
  try { await run("readwrite", (s) => s.delete(key)); } catch (err) { console.warn("Couldn't remove the mosaic draft:", err); }
}
