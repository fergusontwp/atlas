// A grid hash of parcel corners, for snapping a click to the nearest one. No DOM and no SDK imports, so it can be
// tested alone. Ported from newModel / modelAdd / snapNearest in georeferencer/js/app/21-parcels.js, with the
// coordinate system turned into a parameter: coordinates are whatever unit the caller uses (here working-CRS feet), and
// `cell` is the grid cell size in that unit (a cell about the snapping distance keeps lookups to a few cells).

export function createVertexIndex(cell = 20) {
  const grid = new Map();
  let count = 0;
  const key = (x, y) => `${Math.floor(x / cell)},${Math.floor(y / cell)}`;

  return {
    // rings: an array of rings (arrays of [x, y]); a ring's repeated closing vertex is skipped, and a corner shared by
    // several parcels is stored once.
    addRings(rings) {
      for (const ring of rings) {
        ring.forEach((v, i) => {
          if (i === ring.length - 1 && i > 0 && v[0] === ring[0][0] && v[1] === ring[0][1]) return;
          const k = key(v[0], v[1]);
          let cellList = grid.get(k);
          if (!cellList) grid.set(k, (cellList = []));
          if (cellList.some((u) => u[0] === v[0] && u[1] === v[1])) return;
          cellList.push([v[0], v[1]]);
          count++;
        });
      }
    },
    // The stored corner nearest to (X, Y) within tol, as { X, Y } with its exact stored coordinates, or null.
    nearest(X, Y, tol) {
      const r = Math.ceil(tol / cell);
      const cx = Math.floor(X / cell), cy = Math.floor(Y / cell);
      let best = null, bestD = tol * tol;
      for (let i = cx - r; i <= cx + r; i++) {
        for (let j = cy - r; j <= cy + r; j++) {
          const list = grid.get(`${i},${j}`);
          if (!list) continue;
          for (const v of list) {
            const d = (v[0] - X) ** 2 + (v[1] - Y) ** 2;
            if (d < bestD) { bestD = d; best = v; }
          }
        }
      }
      return best ? { X: best[0], Y: best[1] } : null;
    },
    get size() { return count; },
    clear() { grid.clear(); count = 0; },
  };
}

// ---- which points a map click can snap to, for the subject the workspace opened from (searchSubject.js)

// A parcel keeps today's snapping: the parcel corners in view, and nothing else. Any other subject uses `sources`
// (PLANS.SNAP.SOURCES): "selected" (the feature's own vertices) and "parcels_in_view" (parcel corners, only while the
// view is small enough). Returns { parcels: "all" | "limited" | null, selected }.
export function snapPlan(subject, sources = []) {
  if (!subject || subject.isParcel) return { parcels: "all", selected: false };
  return { parcels: sources.includes("parcels_in_view") ? "limited" : null, selected: sources.includes("selected") };
}

// A geometry's vertices as lists of [x, y] the index can take: a polyline's paths, a polygon's rings, a multipoint's
// points or a point, each point a list of its own.
export function geometryParts(g) {
  if (!g) return [];
  if (Array.isArray(g.paths)) return g.paths;
  if (Array.isArray(g.rings)) return g.rings;
  if (Array.isArray(g.points)) return g.points.map((p) => [p]);
  return Number.isFinite(g.x) && Number.isFinite(g.y) ? [[[g.x, g.y]]] : [];
}

// The point lists to index for a plan: the parcel rings (at most maxCorners vertices of them for "limited"), then the
// selected feature's parts when the plan includes them. A parcel subject gets its parcel rings exactly as they came.
export function snapRings({ plan, parcelRings = [], featureParts = [], maxCorners = Infinity }) {
  let rings = plan.parcels ? parcelRings : [];
  if (plan.parcels === "limited" && Number.isFinite(maxCorners)) {
    let left = maxCorners;
    rings = [];
    for (const ring of parcelRings) {
      if (left <= 0) break;
      rings.push(ring.length <= left ? ring : ring.slice(0, left));
      left -= ring.length;
    }
  }
  return plan.selected ? [...rings, ...featureParts] : rings;
}
