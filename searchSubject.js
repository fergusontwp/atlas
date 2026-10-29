// The selected feature as the Plans search sees it: what kind of shape it is, whether it is a parcel, and what to call
// it. The rest of the Plans code works with this instead of "the parcel". No DOM and no SDK imports, so it can be
// tested alone.
//
// selection: the parcel panel's selectedFeature(), { graphic, layer, oid, isParcel }, or null. isParcel is the panel's
// own check (the feature's layer is the configured parcel layer).
// options: { titleFields } the parcel panel's header fields (PARCEL_PANEL.TITLE_FIELDS), which name a parcel.
// Returns null when nothing (or nothing with a usable shape) is selected, otherwise
//   { kind: "polygon" | "line" | "point", isParcel, geometry, layer, layerTitle, oid, label, key }
// geometry is the graphic's, in the view's spatial reference (the search reads it again at full precision from the
// layer); key identifies the feature, so a late answer for an earlier selection can be recognized. A multipoint is a
// "point" subject: its points together.

const KINDS = { polygon: "polygon", extent: "polygon", polyline: "line", point: "point", multipoint: "point" };

const text = (v) => (v === null || v === undefined ? "" : String(v).trim());

export function subjectKind(geometry) {
  return KINDS[geometry?.type] ?? null;
}

export function searchSubject(selection, { titleFields = [] } = {}) {
  const graphic = selection?.graphic;
  const kind = subjectKind(graphic?.geometry);
  if (!graphic || !kind) return null;
  const layer = selection.layer ?? graphic.layer ?? graphic.sourceLayer ?? null;
  const isParcel = !!selection.isParcel;
  const oid = selection.oid ?? null;
  const attributes = graphic.attributes ?? {};
  const layerTitle = text(layer?.title) || "Selected feature";
  // a parcel by its header fields, anything else by its layer's display field; failing that, its object id
  const named = isParcel
    ? titleFields.map((f) => text(attributes[f])).find(Boolean)
    : text(layer?.displayField ? attributes[layer.displayField] : "");
  const label = named || (isParcel ? "Selected parcel" : oid !== null ? `#${oid}` : layerTitle);
  return { kind, isParcel, geometry: graphic.geometry, layer, layerTitle, oid, label, key: `${layer?.id ?? layerTitle}:${oid}` };
}

// "Main Street Reconstruction (Roads)": the feature and its layer, for the Plans block's header.
export const subjectText = (subject) => (subject ? `${subject.label} (${subject.layerTitle})` : "");
