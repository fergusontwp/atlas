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
