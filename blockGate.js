// A left-panel block that needs a selected parcel. With nothing selected the header is faded (a normal element with
// aria-disabled, so hover still works) and a tooltip says why; clicks and keys on it do nothing, and opening it from
// code is undone. When the selection clears while it is open it collapses and fades again.
// Shared by "What's in this parcel" and the Plans block. The block keeps its own content and behavior; this owns only the gate.
//
// options: { block, tooltip, panel }   tooltip is a calcite-tooltip already in the page; panel is the parcel panel's handle.
// Returns { sync(), gated }.
export function gateBlock({ block, tooltip, panel }) {
  let gated = true;

  function sync() {
    gated = panel.selectedObjectId() === null;
    block.classList.toggle("block-faded", gated);
    block.setAttribute("aria-disabled", String(gated));
    tooltip.referenceElement = gated ? block : null;
    if (gated && block.expanded) block.expanded = false; // the selection went away: collapse
  }

  // A click on a faded header does nothing (caught before the block's own toggle sees it).
  block.addEventListener("click", (e) => {
    if (!gated) return;
    e.preventDefault();
    e.stopPropagation();
  }, true);

  // Opened by code with nothing selected.
  block.addEventListener("calciteBlockExpand", (e) => {
    if (e.target === block && gated) block.expanded = false;
  });

  panel.onSelectionChange(sync);
  sync();
  return { sync, get gated() { return gated; } };
}
