// Tiny element builder: properties are set directly, which is how Calcite components are driven.
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k[2].toLowerCase() + k.slice(3), v); // onclick -> click, oncalciteSelectChange -> calciteSelectChange
    else el[k] = v;
  }
  el.append(...children.flat().filter((c) => c !== null && c !== undefined));
  return el;
}
