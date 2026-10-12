// Pure logic for the parcel labels: Arcade expression text and a LabelClass-shaped object.
// No DOM and no SDK imports, so it can be tested alone.
//
// A label "source" describes one line of label text:
//   { kind: "text",   field }
//   { kind: "number", field, decimals, thousands, prefix, suffix }
//   { kind: "scaled", field, divisor, decimals, thousands, prefix, suffix }
//       scaled = a number from a geometry field divided by a unit divisor (Shape__Area, Shape__Length)

// Arcade's Text() patterns that start with "0" cut off the integer part (Text(250000, "0") is "0" in the
// SDK's engine), so every pattern here starts with "#".
export function formatPattern(decimals = 0, thousands = true) {
  const places = Math.max(0, Math.min(6, Math.trunc(decimals) || 0));
  return (thousands ? "#,##0" : "###0") + (places > 0 ? `.${"0".repeat(places)}` : "");
}

// A double-quoted Arcade string literal.
export const arcadeString = (text) =>
  JSON.stringify(String(text)).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");

const fieldRef = (name) => `$feature[${arcadeString(name)}]`;

function numberFrom(src) {
  const divisor = src.kind === "scaled" ? Number(src.divisor) : 1;
  if (src.kind === "scaled" && !(Number.isFinite(divisor) && divisor > 0)) {
    throw new Error(`Label source ${src.field}: the unit divisor must be a positive number.`);
  }
  const ref = fieldRef(src.field);
  const value = src.kind === "scaled" ? `${ref} / ${divisor}` : ref;
  const parts = [];
  if (src.prefix) parts.push(arcadeString(src.prefix));
  parts.push(`Text(${value}, ${arcadeString(formatPattern(src.decimals, src.thousands !== false))})`);
  if (src.suffix) parts.push(arcadeString(src.suffix));
  return `IIf(IsEmpty(${ref}), "", ${parts.join(" + ")})`;
}

// One line: an Arcade expression that gives "" when the value is null or empty (never "null", never a stray prefix).
export function sourceExpression(src) {
  if (src.kind === "text") return `DefaultValue(${fieldRef(src.field)}, "")`;
  if (src.kind === "number" || src.kind === "scaled") return numberFrom(src);
  throw new Error(`Unknown label source kind: ${src.kind}`);
}

// One or two lines. A blank line is left out so there is no stray newline.
export function buildExpression(sources) {
  const lines = sources.filter(Boolean);
  if (lines.length === 0) return '""';
  if (lines.length === 1) return sourceExpression(lines[0]);
  return [
    `var l1 = ${sourceExpression(lines[0])};`,
    `var l2 = ${sourceExpression(lines[1])};`,
    'return IIf(l1 == "", l2, IIf(l2 == "", l1, l1 + TextFormatting.NewLine + l2));',
  ].join("\n");
}

// ---- the same text computed in JavaScript (tests and previews; the map uses the Arcade above)
export function formatNumber(value, { decimals = 0, thousands = true, prefix = "", suffix = "" } = {}) {
  if (value === null || value === undefined || value === "" || !Number.isFinite(Number(value))) return "";
  const places = Math.max(0, Math.min(6, Math.trunc(decimals) || 0));
  const fixed = Math.abs(Number(value)).toFixed(places);
  const [whole, frac] = fixed.split(".");
  const grouped = thousands ? whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",") : whole;
  const negative = Number(value) < 0 && Number(fixed) !== 0 ? "-" : "";
  return `${prefix}${negative}${grouped}${frac ? `.${frac}` : ""}${suffix}`;
}

export const convertArea = (squareMeters, divisor) =>
  squareMeters === null || squareMeters === undefined || squareMeters === "" ? null : Number(squareMeters) / divisor;
export const convertLength = (meters, divisor) =>
  meters === null || meters === undefined || meters === "" ? null : Number(meters) / divisor;

export function previewLine(src, attrs) {
  const raw = attrs?.[src.field];
  if (src.kind === "text") return raw === null || raw === undefined ? "" : String(raw);
  if (raw === null || raw === undefined || raw === "") return "";
  const n = src.kind === "scaled" ? Number(raw) / Number(src.divisor) : Number(raw);
  return formatNumber(n, src);
}

export function previewLabel(sources, attrs) {
  const [a, b] = sources.filter(Boolean).map((s) => previewLine(s, attrs));
  if (b === undefined) return a ?? "";
  return a === "" ? b : b === "" ? a : `${a}\n${b}`;
}

// ---- settings -> LabelClass
const clamp = (v, lo, hi, fallback) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : fallback);

// settings = { sources: [src, src?], font: { family, size, bold, italic }, color, halo: { on, color, size },
//              xoffset, yoffset, minScale, deconflict }
export function buildLabelClass(settings) {
  const font = settings.font ?? {};
  const halo = settings.halo ?? {};
  const haloSize = halo.on ? clamp(halo.size, 0, 4, 2) : 0;
  const symbol = {
    type: "text",
    color: settings.color,
    font: {
      family: font.family,
      size: clamp(font.size, 6, 40, 10),
      weight: font.bold ? "bold" : "normal",
      style: font.italic ? "italic" : "normal",
    },
    xoffset: clamp(settings.xoffset, -100, 100, 0),
    yoffset: clamp(settings.yoffset, -100, 100, 0),
  };
  if (haloSize > 0) {
    symbol.haloColor = halo.color;
    symbol.haloSize = haloSize;
  }
  return {
    name: "parcel-labels",
    labelPlacement: "always-horizontal", // the only placement polygons support
    labelExpressionInfo: { expression: buildExpression(settings.sources ?? []) },
    symbol,
    minScale: Math.max(0, Number(settings.minScale) || 0), // zoomed-out limit; 0 = no limit
    maxScale: 0,
    deconflictionStrategy: settings.deconflict === false ? "none" : "static",
  };
}
