import { h } from "./dom.js";
import { PRINT } from "./config.js";
import { textStyle } from "./printTextStyle.js";
import { printColorControl } from "./printColorControl.js";
export function printTextControls(prefix, profile, initial, changed, heading = "Text style") {
  let style = textStyle(initial, profile);
  const node = h("calcite-block", { class: "print-text-style", heading, collapsible: true, expanded: false, scale: "s" });
  function update(values) { style = textStyle({ ...style, ...values }, profile); changed({ ...style }); }
  const size = h("calcite-input-number", { id: `${prefix}-size`, scale: "s", min: PRINT.TEXT.MIN_SIZE_PT, max: PRINT.TEXT.MAX_SIZE_PT, step: 1,
    oncalciteInputNumberChange: () => update({ size: Number(size.value) }) });
  const flags = {}, choices = profile === "legend" || profile === "scaleBar" ? ["bold"] : ["bold", "italic", "underline"];
  node.append(h("calcite-label", {}, "Size (pt)", size));
  for (const key of choices) {
    flags[key] = h("calcite-checkbox", { id: `${prefix}-${key}`, oncalciteCheckboxChange: () => update({ [key]: flags[key].checked }) });
    node.append(h("calcite-label", { layout: "inline" }, flags[key], key[0].toUpperCase() + key.slice(1)));
  }
  let color, align;
  if (choices.length > 1) {
    color = printColorControl(`${prefix}-color`, "Text color", style.color, (color) => update({ color }));
    align = h("calcite-select", { id: `${prefix}-align`, label: "Alignment", scale: "s", oncalciteSelectChange: () => update({ align: align.value }) },
      ["left", "center", "right"].map((value) => h("calcite-option", { value, label: value[0].toUpperCase() + value.slice(1) })));
    node.append(h("calcite-label", {}, "Color", color.node), h("calcite-label", {}, "Alignment", align));
  }
  function set(value) {
    style = textStyle(value, profile); size.value = String(style.size);
    for (const key of choices) flags[key].checked = style[key];
    color?.set(style.color); if (align) align.value = style.align;
  }
  set(style); return { node, set };
}
