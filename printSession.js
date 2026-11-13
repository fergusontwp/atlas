// Print lifecycle over an injected map port; no DOM or SDK imports.
// save() owns a viewpoint clone; restore(viewpoint) awaits navigation. Snapping stays off until close.
export function createPrintSession({ save, setSnap, restore, beforeClose }) {
  let saved = null, phase = "closed", closing = null, controller = null;
  const pending = new Set();

  async function open() {
    if (closing) await closing;
    if (saved) return;
    saved = save();
    controller = new AbortController();
    phase = "framing";
    try { setSnap(false); }
    catch (error) { await close(); throw error; }
  }

  function close() {
    if (closing) return closing;
    if (!saved) return Promise.resolve();
    const original = saved;
    phase = "closing";
    controller.abort();
    closing = (async () => {
      try {
        try { beforeClose?.(); } // release any editor map lock before restoring, including task-failure closes
        finally {
          // Drain cancelled scale/capture operations before restoring, so late work cannot move the restored map.
          await Promise.allSettled([...pending]);
          await restore(original.viewpoint);
        }
      } finally {
        try { setSnap(original.snapToZoom); }
        finally { saved = null; phase = "closed"; controller = null; closing = null; }
      }
    })();
    return closing;
  }

  async function run(task) {
    if (!saved || phase === "closing") throw new Error("Print map is closed.");
    const original = saved, signal = controller.signal;
    const work = Promise.resolve().then(() => { signal.throwIfAborted(); return task(signal); });
    pending.add(work);
    let failure;
    try {
      const result = await work;
      signal.throwIfAborted();
      return result;
    } catch (error) { failure = error; }
    finally { pending.delete(work); }
    if (saved === original && phase !== "closing") await close();
    throw failure;
  }

  return {
    open, close, run,
    enterEditor() {
      if (phase !== "framing") throw new Error("Print map is not ready.");
      phase = "editor";
    },
    back() { if (phase === "editor") phase = "framing"; },
    get phase() { return phase; },
  };
}
