// The mosaic's slow seam searches off the main thread: Auto join (joinSeam.autoSeam) and Match overlap
// (joinSeam.slideMatch), 0.5 to 1.5 s each. A module worker; seamClient.js is the page's side.
// Message in:  { id, op: "autoSeam" | "slideMatch", args: [...] }  (images as { w, h, data: Float32Array })
// Message out: { id, ok: true, result } or { id, ok: false, message }
import { autoSeam, slideMatch } from "./joinSeam.js";

// What can be posted back: slideMatch's score_at is a function, and its curve isn't used by the page.
const plain = ({ score_at, curve, ...rest }) => rest;

self.onmessage = ({ data: { id, op, args } }) => {
  try {
    const result = op === "autoSeam" ? autoSeam(...args) : op === "slideMatch" ? plain(slideMatch(...args)) : null;
    if (!result) throw new Error(`Unknown seam job "${op}"`);
    self.postMessage({ id, ok: true, result });
  } catch (err) {
    self.postMessage({ id, ok: false, message: err?.message ?? String(err) });
  }
};
