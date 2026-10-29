// Callers supply the local calendar date (YYYY-MM-DD); filename generation has no clock or browser dependency.
export function printFilename(value, format, date) {
  if (!["png", "pdf"].includes(format)) throw new Error("Unknown print format.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("Invalid print date.");
  const base = String(value ?? "").replace(/\.(png|pdf)$/i, "").trim().replace(/\s+/g, "_")
    .replace(/[^A-Za-z0-9_-]/g, "").slice(0, 120);
  return `${base || `atlas-map_${date}`}.${format}`;
}
