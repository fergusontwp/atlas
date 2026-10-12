import { PRINT } from "../config.js";
import { sketchToPage, sketchWeight } from "../printSketchMath.js";
export function drawSketch(drawing, box, strokes) {
  if (!strokes.length) return;
  drawing.clip(box, () => {
    for (const stroke of strokes) if (stroke.points.length > 1) drawing.path(stroke.points.map((p) => sketchToPage(p, box)), {
      stroke: stroke.color, width: sketchWeight(stroke.weight, stroke.tool), opacity: stroke.tool === "highlighter" ? PRINT.SKETCH.HIGHLIGHTER_OPACITY : 1,
      cap: "round", join: "round", smooth: true,
    });
  });
}
export default {
  id: "sketch", label: "Sketch", defaultSlot: "map", defaultState: { on: false, strokes: [] },
  controls: [{ type: "sketch", label: "Sketch tools" }], measure() { return { height: 0 }; },
  draw(drawing, box, state) { drawSketch(drawing, box, state.strokes); },
};
