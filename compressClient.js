// The page's side of compressWorker.js: hand it a rendered canvas, get back the files to attach.
// A module worker started with new URL(..., import.meta.url), so no bundler is needed.

// canvas: the rendered plan; comp: PLANS.COMPRESSION; options: { onProgress, signal }.
// Resolves to runLadder's result ({ ok, tier, scaleFactor, quality?, files: [{ name, type, bytes, data }], width, height,
// tileCount, origBytes, finalBytes, attempts, initialBytes, flat }). Rejects with an AbortError when cancelled, and
// with an Error if the worker fails. The worker is always stopped afterwards.
export async function compressPlan(canvas, comp, { onProgress = () => {}, signal } = {}) {
  if (signal?.aborted) throw new DOMException("Compression was cancelled", "AbortError");
  const bitmap = await createImageBitmap(canvas);
  const worker = new Worker(new URL("./compressWorker.js", import.meta.url), { type: "module" });
  try {
    return await new Promise((resolve, reject) => {
      const cancel = () => {
        worker.postMessage({ type: "cancel" }); // lets the worker stop at the next checkpoint...
        setTimeout(() => reject(new DOMException("Compression was cancelled", "AbortError")), 0); // ...but the caller needn't wait for it
      };
      signal?.addEventListener("abort", cancel, { once: true });
      worker.onmessage = (e) => {
        const m = e.data;
        if (m.type === "progress") onProgress(m);
        else if (m.type === "done") resolve(m.result);
        else if (m.type === "cancelled") reject(new DOMException("Compression was cancelled", "AbortError"));
        else if (m.type === "error") reject(new Error(m.message));
      };
      worker.onerror = (e) => reject(new Error(e.message || "The compression worker failed"));
      worker.postMessage({ type: "start", bitmap, comp }, [bitmap]);
    });
  } finally {
    worker.terminate();
  }
}
