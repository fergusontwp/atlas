// Page-point geometry only. Stored stroke points are normalized to the map rectangle.
import { PRINT } from "./config.js";
const point = (p) => { if (![p?.x, p?.y].every(Number.isFinite)) throw new Error("Invalid sketch point."); return p; };
const rectangle = (box) => { if (![box?.x, box?.y, box?.width, box?.height].every(Number.isFinite) || box.width <= 0 || box.height <= 0) throw new Error("Invalid sketch map area."); return box; };
export function sketchToPage(p, box) { point(p); rectangle(box); return { x: box.x + p.x * box.width, y: box.y + p.y * box.height, ...(p.move ? { move: true } : {}) }; }
export function pageToSketch(p, box) { point(p); rectangle(box); return { x: (p.x - box.x) / box.width, y: (p.y - box.y) / box.height, ...(p.move ? { move: true } : {}) }; }
export function segmentDistance(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, length = dx * dx + dy * dy;
  const t = length ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length)) : 0;
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}
// Liang–Barsky clipping retains entry/exit points and separates excursions outside the map.
export function clipSketch(points, box) {
  rectangle(box); points.forEach(point);
  const result = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i], dx = b.x - a.x, dy = b.y - a.y;
    let first = 0, last = 1, visible = !b.move;
    for (const [p, q] of [[-dx, a.x - box.x], [dx, box.x + box.width - a.x], [-dy, a.y - box.y], [dy, box.y + box.height - a.y]]) {
      if (!p) { if (q < 0) visible = false; }
      else if (p < 0) first = Math.max(first, q / p); else last = Math.min(last, q / p);
    }
    if (!visible || first > last) continue;
    const start = { x: a.x + first * dx, y: a.y + first * dy }, end = { x: a.x + last * dx, y: a.y + last * dy }, previous = result.at(-1);
    if (!previous || Math.hypot(start.x - previous.x, start.y - previous.y) > 1e-7 || first > 0) result.push({ ...start, move: true });
    result.push(end);
  }
  return result;
}
const chunks = (points) => {
  const paths = [];
  for (const p of points) { if (!paths.length || p.move) paths.push([]); paths.at(-1).push(p); }
  return paths;
};
// Iterative Douglas–Peucker: no recursion overflow for long strokes; endpoints and subpaths survive.
export function reduceSketch(points, tolerance = PRINT.SKETCH.REDUCE_PT) {
  points.forEach(point); if (!Number.isFinite(tolerance) || tolerance < 0) throw new Error("Invalid sketch tolerance.");
  return chunks(points).flatMap((path) => {
    if (path.length < 3) return path.map((p) => ({ ...p }));
    const keep = new Set([0, path.length - 1]), stack = [[0, path.length - 1]];
    while (stack.length) {
      const [a, b] = stack.pop(); let distance = tolerance, at = -1;
      for (let i = a + 1; i < b; i++) { const d = segmentDistance(path[i], path[a], path[b]); if (d > distance) { distance = d; at = i; } }
      if (at !== -1) { keep.add(at); stack.push([a, at], [at, b]); }
    }
    return [...keep].sort((a, b) => a - b).map((i) => ({ ...path[i] }));
  });
}
// Midpoint quadratic smoothing expressed as cubic commands, shared by Canvas and PDF.
export function sketchPath(points) {
  points.forEach(point);
  return chunks(points).flatMap((path) => {
    if (!path.length) return [];
    const commands = [{ type: "move", ...path[0] }]; let from = path[0];
    for (let i = 1; i < path.length; i++) {
      const control = path[i - 1], end = i === path.length - 1 ? path[i] : { x: (control.x + path[i].x) / 2, y: (control.y + path[i].y) / 2 };
      commands.push({ type: "curve", x1: from.x + (control.x - from.x) * 2 / 3, y1: from.y + (control.y - from.y) * 2 / 3,
        x2: end.x + (control.x - end.x) * 2 / 3, y2: end.y + (control.y - end.y) * 2 / 3, x: end.x, y: end.y }); from = end;
    }
    return commands;
  });
}
export function sketchWeight(weight, tool = "pen") {
  const value = Number(weight), width = Number.isFinite(value) ? Math.max(PRINT.SKETCH.MIN_WEIGHT_PT, Math.min(PRINT.SKETCH.MAX_WEIGHT_PT, value)) : PRINT.SKETCH.WEIGHT_PT;
  return width * (tool === "highlighter" ? PRINT.SKETCH.HIGHLIGHTER_WIDTH_FACTOR : 1);
}
export function hitSketch(strokes, p, box, tolerance = 0) {
  point(p); rectangle(box); if (!Number.isFinite(tolerance) || tolerance < 0) throw new Error("Invalid sketch hit tolerance.");
  if (p.x < box.x || p.x > box.x + box.width || p.y < box.y || p.y > box.y + box.height) return -1;
  for (let index = strokes.length - 1; index >= 0; index--) {
    const stroke = strokes[index], radius = sketchWeight(stroke.weight, stroke.tool) / 2 + tolerance; let from;
    for (const command of sketchPath(stroke.points.map((value) => sketchToPage(value, box)))) {
      if (command.type === "move") { from = command; continue; }
      let previous = from;
      for (let i = 1; i <= PRINT.SKETCH.HIT_CURVE_STEPS; i++) {
        const t = i / PRINT.SKETCH.HIT_CURVE_STEPS, u = 1 - t;
        const next = { x: u ** 3 * from.x + 3 * u * u * t * command.x1 + 3 * u * t * t * command.x2 + t ** 3 * command.x,
          y: u ** 3 * from.y + 3 * u * u * t * command.y1 + 3 * u * t * t * command.y2 + t ** 3 * command.y };
        if (segmentDistance(p, previous, next) <= radius) return index; previous = next;
      }
      from = command;
    }
  }
  return -1;
}
