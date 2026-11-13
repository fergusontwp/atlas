// A left-panel block that needs a selection. With nothing (suitable) selected the header is faded (a normal element with
// aria-disabled, so hover still works) and a tooltip says why; clicks and keys on it do nothing, and opening it from
// code is undone. When the selection clears while it is open it collapses and fades again.
// Shared by "What's in this parcel" (needs a parcel) and the Plans block (any selected feature). The block keeps its own
// content and behavior; this owns only the gate.

// Whether the block is faded for a selection (the parcel panel's selectedFeature(): { isParcel, ... } or null).
// requires: "parcel" (only a parcel opens it) or "feature" (any selected feature, from any layer). open: something
// else that opens it whatever is selected (the Plans block: a plan shown on the map). Pure.
export function gateState(selection, requires = "feature", open = false) {
  return { gated: !open && (requires === "parcel" ? !selection?.isParcel : !selection) };
}

// options: { block, tooltip, panel, requires, text, alsoOpen }   tooltip is a calcite-tooltip already in the page; panel
// is the parcel panel's handle; requires as above ("parcel" unless said); text, if given, replaces the tooltip's wording;
// alsoOpen(), if given, opens the block whatever is selected (call sync() when it changes). Returns { sync(), gated }.
export function gateBlock({ block, tooltip, panel, requires = "parcel", text, alsoOpen = null }) {
  let gated = true;
  if (text) tooltip.textContent = text;

  function sync(selection = panel.selectedFeature()) {
    gated = gateState(selection, requires, !!alsoOpen?.()).gated;
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
