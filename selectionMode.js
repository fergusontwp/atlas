// Which things want the selected parcel drawn as an outline instead of a filled highlight. No DOM and no SDK imports.
// Several can be true at once (a block open and a plan shown); the mode lasts until the last one is gone.
//   set(reason, on)  adds or removes a reason; onChange(active) runs only when the mode itself flips.
export function createReasons(onChange = () => {}) {
  const reasons = new Set();
  return {
    set(reason, on) {
      const was = reasons.size > 0;
      if (on) reasons.add(reason);
      else reasons.delete(reason);
      const now = reasons.size > 0;
      if (now !== was) onChange(now);
    },
    has: (reason) => reasons.has(reason),
    get active() { return reasons.size > 0; },
    get list() { return [...reasons]; },
  };
}
