// The page's side of compressWorker.js: hand it a rendered canvas, get back the files to attach.
// A module worker started with new URL(..., import.meta.url), so no bundler is needed.

const cancelled = () => new DOMException("Compression was cancelled", "AbortError");

const WORKER_URL = new URL("./compressWorker.js", import.meta.url);
// The worker's own modules, to name the one that won't load.
const WORKER_FILES = ["compressWorker.js", "planCompression.js", "thickenCanvas.js", "thicken.js", "pngEncode.js", "pixelReduce.js", "tiling.js", "worldFile.js"];

// Why the worker failed, as a sentence. A worker's error event has a message for an exception in its code; it has none
// when a file of it can't be loaded or the browser stopped it (most often for memory), so the files are checked.
// size: the image's "W × H px".
async function workerFailure(e, size) {
  if (e?.message) return new Error(`The compression worker failed: ${e.message}${e.filename ? ` (${String(e.filename).split("/").pop()}, line ${e.lineno})` : ""}`);
  for (const name of WORKER_FILES) {
    try {
      const res = await fetch(new URL(`./${name}`, WORKER_URL), { cache: "no-store" });
      if (!res.ok) return new Error(`The compression worker couldn't be loaded: ${name} answered HTTP ${res.status}. Reload the page; if it keeps happening, the app's files are incomplete.`);
    } catch {
      return new Error(`The compression worker couldn't be loaded: ${name} couldn't be fetched. Check the connection and reload the page.`);
    }
  }
  return new Error(`The browser stopped the compression worker without a reason, most likely for lack of memory with a ${size} image. Close other tabs, or choose a lower saved resolution above, and try again.`);
}

// One job on a fresh worker, which is always stopped afterwards. onMessage(m, resolve, reject) handles the replies.
// release: free the canvas as soon as its copy for the worker is made (a piece's render, not needed again), so the
// page doesn't hold the image twice while the worker works on it.
async function withWorker(canvas, message, { signal, release = false } = {}, onMessage) {
  if (signal?.aborted) throw cancelled();
  const size = `${canvas.width.toLocaleString("en-US")} × ${canvas.height.toLocaleString("en-US")} px`;
  const bitmap = await createImageBitmap(canvas);
  if (release) { canvas.width = 0; canvas.height = 0; }
  const worker = new Worker(WORKER_URL, { type: "module" });
  try {
    return await new Promise((resolve, reject) => {
      const cancel = () => {
        worker.postMessage({ type: "cancel" }); // lets the worker stop at the next checkpoint...
        setTimeout(() => reject(cancelled()), 0); // ...but the caller needn't wait for it
      };
      signal?.addEventListener("abort", cancel, { once: true });
      worker.onmessage = (e) => {
        const m = e.data;
        if (m.type === "cancelled") reject(cancelled());
        else if (m.type === "error") reject(new Error(m.message));
        else onMessage(m, resolve, reject);
      };
      worker.onerror = (e) => {
        e.preventDefault?.();
        console.warn("The compression worker failed:", e.message || "(no message)", e.filename ?? "", e.lineno ?? "", e);
        workerFailure(e, size).then(reject);
      };
      worker.onmessageerror = () => reject(new Error("The compression worker's answer couldn't be read."));
      worker.postMessage({ ...message, bitmap }, [bitmap]);
    });
  } finally {
    worker.terminate();
  }
}

// canvas: the rendered plan; comp: PLANS.COMPRESSION; options: { budget, onProgress, signal, thicken }, budget the bytes
// the image may use (planCompression.imageBudget; comp.TARGET_BYTES when left out), thicken the line weight
// (compressWorker.js: { P, dpi, trim? }) or null, release true to free the canvas once its copy is handed over.
// Resolves to runLadder's result ({ ok, tier, scaleFactor, quality?, files: [{ name, type, bytes, data }], width, height,
// tileCount, origBytes, finalBytes, budget, flat, attempts, initialBytes }). Rejects with an AbortError when cancelled,
// and with an Error if the worker fails.
export function compressPlan(canvas, comp, { budget, onProgress = () => {}, signal, thicken = null, release = false } = {}) {
  return withWorker(canvas, { type: "start", comp, budget, thicken }, { signal, release }, (m, resolve) => {
    if (m.type === "progress") onProgress(m);
    else if (m.type === "done") resolve(m.result);
  });
}

// A probe render's sizes, for an estimate (estimateFromProbes). Resolves to { asis, bytes }: as the first PNG and as the lossless rung.
export function probeBytes(canvas, { signal, thicken = null } = {}) {
  return withWorker(canvas, { type: "probe", thicken }, { signal }, (m, resolve) => {
    if (m.type === "probed") resolve({ asis: m.asis, bytes: m.bytes });
  });
}
