// Atlas's Calcite color picker appears only for Custom; presets stay a compact select.
import { PRINT } from "./config.js";
import { h } from "./dom.js";
import { printColor } from "./printLeader.js";
export function printColorControl(id, label, initial, changed, automatic = false, presets = PRINT.COLOR_PRESETS) {
  const select = h("calcite-select", { id, label, scale: "s" },
    automatic ? h("calcite-option", { value: "auto", label: "Automatic contrast" }) : null,
    presets.map(([name, value]) => h("calcite-option", { value, label: name })),
    h("calcite-option", { value: "custom", label: "Custom…" }));
  const picker = h("calcite-color-picker", { id: `${id}-custom`, scale: "s", format: "hex", label,
    channelsDisabled: true, savedDisabled: true, hidden: true });
  const node = h("div", { class: "print-color-control" }, select, picker);
  function set(value) {
    const color = value ? printColor(value) : null;
    select.value = automatic && !color ? "auto" : presets.some(([, hex]) => hex === color) ? color : "custom";
    picker.value = color ?? PRINT.LEADER.COLOR; picker.hidden = select.value !== "custom";
  }
  select.addEventListener("calciteSelectChange", () => {
    picker.hidden = select.value !== "custom";
    if (!picker.hidden) changed(printColor(picker.value));
    else changed(select.value === "auto" ? null : select.value);
  });
  picker.addEventListener("calciteColorPickerChange", () => changed(printColor(picker.value)));
  set(initial); return { node, set };
}
