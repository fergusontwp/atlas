import { h } from "./dom.js";

// The row of buttons at the top of the parcel panel (in the non-scrolling content-top slot), shown only while a parcel
// is selected. Each module that has a left-panel block adds its own button with addBlockAction; the buttons share the
// row two to a line (width "half", small) and open and close their block the same way.
export function setupParcelActions(panel) {
  const bar = document.getElementById("parcel-actions");

  function sync() {
    const selected = panel.selectedObjectId() !== null;
    bar.hidden = !selected;
    // Out of the content-top slot while hidden, or the panel would reserve an empty band for it.
    if (selected) bar.slot = "content-top";
    else bar.removeAttribute("slot");
  }
  panel.onSelectionChange(sync);
  sync();

  const actions = [];
  // A label that doesn't fit its half of the row is replaced by its short one (the full text stays as the tooltip),
  // rather than being cut off. Checked whenever the row changes size.
  const truncated = (button) => {
    // Calcite clips the label in an element inside its button, so look at the button and everything in it.
    const inner = button.shadowRoot?.querySelector("button");
    return !!inner && [inner, ...inner.querySelectorAll("*")].some((el) => el.scrollWidth > el.clientWidth + 1);
  };
  function fit(action) {
    if (!action.shortLabel || bar.hidden) return;
    action.button.textContent = action.label;
    action.button.removeAttribute("title");
    if (truncated(action.button)) {
      action.button.textContent = action.shortLabel;
      action.button.title = action.label;
    }
  }
  new ResizeObserver(() => actions.forEach(fit)).observe(bar);

  // A button that toggles a left-panel block (the single-open rule in sidebar.js folds the others). It shows as pressed
  // (aria-pressed and an outline-filled look) while its block is open. onOpened runs once the other blocks have folded away.
  function addBlockAction({ id, label, shortLabel, icon, block, onOpened }) {
    const button = h("calcite-button", { id, width: "half", scale: "s", iconStart: icon }, label);
    button.setAttribute("aria-pressed", "false");
    const syncPressed = () => {
      const open = !!block.expanded;
      button.setAttribute("aria-pressed", String(open));
      button.appearance = open ? "outline-fill" : "solid";
    };
    block.addEventListener("calciteBlockExpand", (e) => e.target === block && syncPressed());
    block.addEventListener("calciteBlockCollapse", (e) => e.target === block && syncPressed());
    button.addEventListener("click", () => {
      if (block.expanded) {
        block.expanded = false;
        return;
      }
      block.expanded = true;
      setTimeout(() => {
        block.scrollIntoView({ block: "nearest", behavior: "smooth" });
        onOpened?.();
      }, 350);
    });
    bar.append(button);
    const action = { button, label, shortLabel };
    actions.push(action);
    return {
      button,
      setLabel(text) {
        action.label = text;
        button.textContent = text;
        fit(action);
      },
    };
  }

  return { addBlockAction };
}
