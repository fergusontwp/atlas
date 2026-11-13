// Capture metadata, free of DOM and SDK. Scale limits use SDK scale only to determine visibility.
export function ownerNamesVisible(parcel, scale, fields) {
  if (!parcel?.visible || !parcel.labelsVisible) return false;
  const inScale = ({ minScale = 0, maxScale = 0 }) => (!minScale || scale <= minScale) && (!maxScale || scale >= maxScale);
  if (!inScale(parcel)) return false;
  return (parcel.labelingInfo ?? []).some((label) => {
    if (!inScale(label)) return false;
    const expression = label.labelExpressionInfo?.expression ?? label.labelExpression ?? "";
    return fields.some((field) => {
      const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`\\$feature\\s*(?:\\.\\s*${escaped}\\b|\\[\\s*["']${escaped}["']\\s*\\])|\\{${escaped}\\}`, "i").test(expression);
    });
  });
}

export async function withPrintExclusions({ panel, outline, hideMeasurements }, includeSelected, capture) {
  const highlightOff = panel?.highlightOff, visible = outline?.visible;
  let restoreMeasurements;
  try {
    restoreMeasurements = await hideMeasurements?.();
    if (!includeSelected) {
      if (panel) await panel.setHighlightOff(true);
      if (outline) outline.visible = false;
    }
    return await capture();
  } finally {
    if (outline && !includeSelected) outline.visible = visible;
    const results = await Promise.allSettled([
      Promise.resolve().then(() => restoreMeasurements?.()),
      Promise.resolve().then(() => !includeSelected && panel?.setHighlightOff(highlightOff)),
    ]);
    const failure = results.find((result) => result.status === "rejected");
    if (failure) throw failure.reason;
  }
}
