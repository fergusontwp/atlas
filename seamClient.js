// The page's side of seamWorker.js: Auto join and Match overlap in a worker, so the page stays responsive. If a worker
// can't be started (or fails to load), the same function runs here instead, as in the prototype.
import { autoSeam, slideMatch } from "./joinSeam.js";

let worker = null, broken = false, nextId = 1;
const waiting = new Map(); // id -> { resolve, reject }

function workerNow() {
  if (worker || broken) return worker;
  try {
    worker = new Worker(new URL("./seamWorker.js", import.meta.url), { type: "module" });
    worker.onmessage = ({ data: { id, ok, result, message } }) => {
      const w = waiting.get(id);
      if (!w) return;
      waiting.delete(id);
      ok ? w.resolve(result) : w.reject(new Error(message));
    };
    worker.onerror = (e) => {
      console.warn("The seam worker failed; the seam searches run on the page instead.", e);
      broken = true;
      worker?.terminate();
      worker = null;
      for (const [, w] of waiting) w.reject(Object.assign(new Error("worker"), { retry: true }));
      waiting.clear();
    };
  } catch (err) {
    console.warn("Couldn't start the seam worker; the seam searches run on the page instead.", err);
    broken = true;
    worker = null;
  }
  return worker;
}

const LOCAL = { autoSeam, slideMatch: (...a) => { const { score_at, curve, ...rest } = slideMatch(...a); return rest; } };

async function run(op, args) {
  const w = workerNow();
  if (w) {
    try {
      return await new Promise((resolve, reject) => {
        const id = nextId++;
        waiting.set(id, { resolve, reject });
        w.postMessage({ id, op, args });
      });
    } catch (err) {
      if (!err.retry) throw err;
    }
  }
  await new Promise((r) => setTimeout(r, 30)); // let the busy state paint first
  return LOCAL[op](...args);
}

// joinSeam.autoSeam(imL, imR, o) and slideMatch(imL, imR, rel, u, range, o) (without score_at and curve), as promises.
export const autoSeamAsync = (imL, imR, o) => run("autoSeam", [imL, imR, o]);
export const slideMatchAsync = (imL, imR, rel, u, range, o) => run("slideMatch", [imL, imR, rel, u, range, o]);
