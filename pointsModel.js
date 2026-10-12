// The control points of a plan, with undo. No DOM and no SDK imports, so it can be tested alone.
// A point is { id, x, y, X, Y, use, snapped }: x, y in page space (PDF points, y down), X, Y in the working CRS (feet),
// use false leaves it out of the fit, snapped false means it was placed freely on the basemap (approximate).
// Every change that should be undoable first saves a snapshot; undo steps back through up to `limit` of them.

export class PointsModel {
  constructor(limit = 80) {
    this.limit = limit;
    this.points = [];
    this.nextId = 1;
    this.history = [];
    this._lastNudge = -Infinity;
  }

  _snapshot() { return JSON.stringify({ points: this.points, nextId: this.nextId }); }
  push() {
    this.history.push(this._snapshot());
    if (this.history.length > this.limit) this.history.shift();
  }
  byId(id) { return this.points.find((p) => p.id === id); }

  add({ x, y, X, Y, snapped }) {
    this.push();
    const p = { id: this.nextId++, x, y, X, Y, use: true, snapped: !!snapped };
    this.points.push(p);
    return p;
  }
  remove(id) {
    const i = this.points.findIndex((p) => p.id === id);
    if (i < 0) return false;
    this.push();
    this.points.splice(i, 1);
    return true;
  }
  setUse(id, on) {
    const p = this.byId(id);
    if (!p || p.use === !!on) return false;
    this.push();
    p.use = !!on;
    return true;
  }
  // Moves are applied while dragging (no snapshot each time): call push() once when a drag starts.
  setPage(id, x, y) { const p = this.byId(id); if (p) { p.x = x; p.y = y; } }
  setMap(id, X, Y, snapped) { const p = this.byId(id); if (p) { p.X = X; p.Y = Y; p.snapped = !!snapped; } }

  // Moves a point's sheet position by (dx, dy) page points, kept within bounds { w, h }. Repeated nudges within `mergeMs`
  // of each other are one undo step.
  nudge(id, dx, dy, bounds, now, mergeMs = 900) {
    const p = this.byId(id);
    if (!p) return false;
    if (now - this._lastNudge > mergeMs) this.push();
    this._lastNudge = now;
    p.x = Math.min(bounds.w, Math.max(0, p.x + dx));
    p.y = Math.min(bounds.h, Math.max(0, p.y + dy));
    return true;
  }

  undo() {
    const last = this.history.pop();
    if (last === undefined) return false;
    const s = JSON.parse(last);
    this.points = s.points;
    this.nextId = s.nextId;
    return true;
  }
  clear() {
    const n = this.points.length;
    if (!n) return 0;
    this.push();
    this.points = [];
    return n;
  }
  get snappedCount() { return this.points.filter((p) => p.snapped).length; }
  get usedCount() { return this.points.filter((p) => p.use).length; }
  toJSON() { return this.points.map((p) => ({ ...p })); }
}
