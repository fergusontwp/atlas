// SDK 5.1 visibility fades last 200 ms and are not reflected in view.updating.
// Require a quiet interval beyond that duration and at least two frames; no private SDK access.
export async function waitPrintRender({ idle, nextFrame, now, signal, settleMs = 250 }) {
  let since = idle() ? now() : null, frames = 0;
  while (true) {
    signal?.throwIfAborted();
    await nextFrame(signal);
    signal?.throwIfAborted();
    if (!idle()) { since = null; frames = 0; continue; }
    since ??= now(); frames++;
    if (frames >= 2 && now() - since >= settleMs) return;
  }
}
