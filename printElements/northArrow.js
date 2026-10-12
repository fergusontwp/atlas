export function northPoints(box, rotation) {
  const a = rotation * Math.PI / 180, x = box.x + box.width / 2, y = box.y + 16;
  return [[0, -12], [-5, 9], [0, 5], [5, 9]].map(([px, py]) =>
    ({ x: x + px * Math.cos(a) - py * Math.sin(a), y: y + px * Math.sin(a) + py * Math.cos(a) }));
}
export default {
  id: "northArrow", label: "North arrow", defaultSlot: "body", defaultState: { on: true }, controls: [],
  measure() { return { height: 38, width: 52 }; },
  draw(drawing, box, state, { rotation }) {
    if (box.height < 38) return;
    drawing.path(northPoints(box, rotation), { fill: "#222222", stroke: "#222222", close: true });
    drawing.text("N", box.x + box.width / 2 - 3.25, box.y + 38, { size: 9, bold: true });
  },
};
