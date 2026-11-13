// Left panel: only one block is open at a time. Opening a block collapses the others; any block can still be
// closed, so everything can be collapsed.
//
// calciteBlockExpand fires for programmatic changes as well as clicks (calciteBlockToggle only fires for clicks),
// so a block opened by code follows the same rule, and code that listens for calciteBlockCollapse (Measure, What's
// in this parcel) also runs when this rule closes a block. Closing a block only emits collapse events, never
// expand ones, so the rule can't loop.
export function setupSidebar() {
  const blocks = [...document.querySelectorAll('calcite-shell-panel[slot="panel-start"] > calcite-panel > calcite-block')];

  const closeOthers = (keep) => {
    for (const block of blocks) if (block !== keep && block.expanded) block.expanded = false;
  };

  for (const block of blocks) {
    // The blocks nested inside Labels bubble the same event; only a top-level block's own counts.
    block.addEventListener("calciteBlockExpand", (event) => {
      if (event.target === block) closeOthers(block);
    });
  }

  // Start state: if the markup opened several, the first (top to bottom) stays open.
  closeOthers(blocks.find((block) => block.expanded));
  return { blocks };
}
