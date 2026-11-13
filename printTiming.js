// Console-visible Print diagnostics. Abort waits on timeout; dispose late, non-cancellable results.
export function printTiming(log = (line) => console.info(line)) {
  const started = performance.now();
  const line = (step, result) => log(`[Print map +${Math.round(performance.now() - started)} ms] ${step}: ${result}`);
  return {
    sync(step, task) {
      const start = performance.now();
      try { const value = task(); line(step, `done (${Math.round(performance.now() - start)} ms)`); return value; }
      catch (error) { line(step, `failed (${Math.round(performance.now() - start)} ms): ${error.message}`); throw error; }
    },
    async step(step, task, { signal, timeoutMs = 15000, fallback, onLate } = {}) {
      const start = performance.now(), controller = new AbortController();
      const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
      line(step, "started");
      const watchdog = setTimeout(() => line(step, `still waiting on ${step} after 5 s`), 5000);
      const timer = setTimeout(() => controller.abort(new Error(`${step} timed out after ${timeoutMs / 1000} s`)), timeoutMs);
      let settled = false, cancel;
      const cancelled = new Promise((_, reject) => {
        cancel = () => reject(combined.reason);
        if (combined.aborted) cancel(); else combined.addEventListener("abort", cancel, { once: true });
      });
      const work = Promise.resolve().then(() => { combined.throwIfAborted(); return task(combined); });
      work.then((value) => { if (settled) onLate?.(value); }, () => {}).catch((error) => line(step, `late cleanup failed: ${error.message}`));
      try {
        const value = await Promise.race([work, cancelled]);
        line(step, `done (${Math.round(performance.now() - start)} ms)`); return value;
      } catch (error) {
        line(step, `failed (${Math.round(performance.now() - start)} ms): ${error.message}`);
        if (fallback && !signal?.aborted) { line(step, "using fallback"); return fallback(error); }
        throw error;
      } finally {
        settled = true; clearTimeout(watchdog); clearTimeout(timer); combined.removeEventListener("abort", cancel);
      }
    },
  };
}
