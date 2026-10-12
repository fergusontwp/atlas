// One page-unit model for preview, PNG and PDF. Registry entries implement:
// { id, label, defaultSlot: header|body|footer|map, defaultState, controls,
//   measure(context), draw(drawing, box, state, context) }.
// measure gets context.box and context.state and returns { height, width?, weight? }.
// Header/footer rows collapse when off; body elements share the remaining strip.
export function layoutPage(page, registry, states = {}, context = {}, gap = 6) {
  if (!Number.isFinite(gap) || gap < 0) throw new Error("Invalid print layout gap.");
  const ids = new Set();
  const active = registry.filter((element) => {
    if (ids.has(element.id)) throw new Error("Duplicate print element.");
    ids.add(element.id);
    if (!["header", "body", "footer", "map"].includes(element.defaultSlot)) throw new Error("Invalid print element slot.");
    return element.required || (states[element.id]?.on ?? element.defaultState?.on ?? true);
  });
  const placements = [], overflow = [];
  const measure = (element, box) => {
    const state = { ...element.defaultState, ...states[element.id] };
    if (element.required) state.on = true;
    const result = element.measure({ ...context, page, box, state });
    if (!Number.isFinite(result.height) || result.height < 0
      || (result.width !== undefined && (!Number.isFinite(result.width) || result.width <= 0))
      || (result.weight !== undefined && (!Number.isFinite(result.weight) || result.weight <= 0))) throw new Error("Invalid print element measurement.");
    return { state, result };
  };
  const place = (element, box) => {
    const { state, result } = measure(element, box);
    if (result.overflow || result.height > box.height) overflow.push(element.id);
    placements.push({ id: element.id, box, state, measurement: result });
  };
  let top = page.strip.y, bottom = page.strip.y + page.strip.height;
  const rows = (slot) => active.filter((element) => element.defaultSlot === slot);
  for (const element of rows("header")) {
    const { result } = measure(element, page.strip);
    const height = Math.min(result.height, Math.max(0, bottom - top));
    place(element, { ...page.strip, y: top, height }); top = Math.min(bottom, top + height + gap);
  }
  // Reversed placement keeps registry order from top to bottom in the footer.
  for (const element of rows("footer").reverse()) {
    const { result } = measure(element, page.strip);
    const height = Math.min(result.height, Math.max(0, bottom - top));
    bottom -= height; place(element, { ...page.strip, y: bottom, height }); bottom = Math.max(top, bottom - gap);
  }
  const body = rows("body"), availableWidth = Math.max(0, page.strip.width - gap * Math.max(0, body.length - 1));
  const sizes = body.map((element) => measure(element, page.strip).result);
  const fixedWidth = sizes.reduce((sum, size) => sum + (size.width ?? 0), 0);
  const totalWeight = sizes.reduce((sum, size) => sum + (size.width ? 0 : size.weight ?? 1), 0);
  let x = page.strip.x;
  body.forEach((element, i) => {
    const size = sizes[i];
    const width = fixedWidth > availableWidth ? (size.width ?? 0) * availableWidth / fixedWidth
      : size.width ?? (availableWidth - fixedWidth) * (size.weight ?? 1) / totalWeight;
    place(element, { x, y: top, width, height: Math.max(0, bottom - top) }); x += width + gap;
  });
  for (const element of rows("map")) place(element, { ...page.map });
  return { page, placements, overflow };
}

// Drawing interface: rect(box, style), line(x1,y1,x2,y2,style), path(points,style),
// text(value,x,baselineY,style), image(id,box), clip(box,draw).
// Paths may use shared cubic smoothing, cap/join and opacity styles. All coordinates are page points, top-left origin.
export function drawLayout(drawing, layout, registry, { mapImage = "map", border = true, ...context } = {}) {
  const { page } = layout;
  drawing.rect({ x: 0, y: 0, width: page.width, height: page.height }, { fill: "#ffffff" });
  drawing.image(mapImage, page.map);
  if (border) drawing.rect(page.map, { stroke: "#333333", width: 0.5 });
  for (const placement of layout.placements) {
    registry.find((element) => element.id === placement.id).draw(drawing, placement.box, placement.state,
      { ...context, page, measurement: placement.measurement });
  }
}
