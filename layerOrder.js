// Where a plan image goes in the map's draw order: directly below the edge-length labels (added at startup), so edge
// lengths stay readable over a plan, and above everything added before it (the parcel layer, What's in this parcel's
// outline and result copies). Used by the georeferencing workspace and saved plans.
export function addBelowEdges(map, layer) {
  const edgeAt = map.layers.findIndex((l) => l.id === "edge-lengths");
  map.add(layer, edgeAt >= 0 ? edgeAt : undefined);
}
