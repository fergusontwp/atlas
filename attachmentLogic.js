import { NOTES } from "./config.js";

// Files on a Notes entry (section 55): pure helpers. notesAttach.js does the picking, resizing, uploading and showing;
// every limit and text comes from NOTES.ATTACH (config.js).

// A file name's extension, lowercase, without the dot ("" for none).
export function extensionOf(name) {
  const m = /\.([^./\\]+)$/.exec(String(name ?? ""));
  return m ? m[1].toLowerCase() : "";
}

// A content type without parameters, lowercase ("Image/PNG; x=1" -> "image/png").
export const baseType = (contentType) => String(contentType ?? "").split(";")[0].trim().toLowerCase();

// The browser gives no type, or this one, for files it doesn't know (an Outlook .msg often): not a mismatch.
const GENERIC = new Set(["", "application/octet-stream"]);

// Why one file can't be attached, as a plain sentence, or "" when it can. The extension must be allowed (AGOL decides by
// it too), the content type the browser reports must fit that extension (or be generic), the file must not be empty
// and at most MAX_BYTES.
export function fileProblem(file, cfg = NOTES.ATTACH) {
  const T = cfg.TEXT;
  const types = cfg.ACCEPT[extensionOf(file?.name)];
  if (!types) return T.REJECT_TYPE;
  const type = baseType(file.type);
  if (!GENERIC.has(type) && !types.includes(type)) return T.REJECT_MISMATCH;
  if (!(Number(file.size) > 0)) return T.REJECT_EMPTY;
  if (file.size > cfg.MAX_BYTES) return T.REJECT_SIZE(fileSizeText(cfg.MAX_BYTES));
  return "";
}

// The files picked, dropped or pasted, checked: { accepted: [file], rejected: [{ file, message }] }, in their order. A
// rejected file never stops the others. `existing`: files the entry already holds; past MAX_FILES in all, the rest are
// rejected with the count message.
export function attachmentRules(files, cfg = NOTES.ATTACH, existing = 0) {
  const accepted = [], rejected = [];
  let room = Math.max(0, cfg.MAX_FILES - existing);
  for (const file of files ?? []) {
    const message = fileProblem(file, cfg);
    if (message) rejected.push({ file, message });
    else if (room <= 0) rejected.push({ file, message: cfg.TEXT.REJECT_COUNT(cfg.MAX_FILES) });
    else { room--; accepted.push(file); }
  }
  return { accepted, rejected };
}

// The content type to store with a file: the browser's, or the extension's first allowed type when the browser gave a
// generic one.
export function uploadType(file, cfg = NOTES.ATTACH) {
  const type = baseType(file?.type);
  return GENERIC.has(type) ? (cfg.ACCEPT[extensionOf(file?.name)]?.[0] ?? "application/octet-stream") : type;
}

// Whether a stored file may be shown inline (a thumbnail, the lightbox): only the raster types in INLINE_TYPES (png,
// jpeg, gif, webp), by content type. SVG, HTML, PDF and everything else are download only.
export function isInlineImage(contentType, cfg = NOTES.ATTACH) {
  const type = baseType(contentType);
  return !!type && cfg.INLINE_TYPES.includes(type);
}

// Whether a picked file is a photo the resize may redraw (RESIZABLE_TYPES, by content type; a GIF may be animated).
export const isResizable = (contentType, cfg = NOTES.ATTACH) => cfg.RESIZABLE_TYPES.includes(baseType(contentType));

// The size a photo of w x h pixels and `bytes` is redrawn at, or null to leave it as it is: only when resizing is on, the
// file is over ABOVE_BYTES and its long side is over MAX_SIDE. { width, height, quality, type: "image/jpeg" }, the long
// side MAX_SIDE, the aspect kept.
export function resizePlan(w, h, bytes, cfg = NOTES.ATTACH.RESIZE) {
  if (!cfg?.ENABLED || !(bytes > cfg.ABOVE_BYTES) || !(w > 0) || !(h > 0)) return null;
  const long = Math.max(w, h);
  if (long <= cfg.MAX_SIDE) return null;
  const scale = cfg.MAX_SIDE / long;
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)), quality: cfg.QUALITY, type: "image/jpeg" };
}

// A redrawn photo's name: the same name as a .jpg ("IMG_0042.HEIC.png" -> "IMG_0042.HEIC.jpg", "scan" -> "scan.jpg").
export function resizedName(name) {
  const base = String(name ?? "").replace(/\.[^./\\]+$/, "");
  return `${base || "photo"}.jpg`;
}

// A size as people read it: "512 B", "12 KB", "1.5 MB" (1 KB = 1024 bytes). "" for anything that isn't a size.
export function fileSizeText(bytes) {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// A file chip's icon, by the name's extension (NOTES.ATTACH.ICONS), else "file". An image icon only when the stored
// content type is an inline image too (a ".png" holding HTML gets the plain file icon).
export function fileIcon(name, contentType = null, cfg = NOTES.ATTACH) {
  const icon = cfg.ICONS?.[extensionOf(name)] ?? "file";
  return icon === "file-image" && contentType !== null && !isInlineImage(contentType, cfg) ? "file" : icon;
}
