import { h } from "./dom.js";
import { NOTES } from "./config.js";
import { baseType, fileIcon, fileSizeText, isInlineImage } from "./attachmentLogic.js";
import { lightboxElement, openLightbox } from "./lightbox.js";

// Files on Notes entries, the reading side (section 55). After each page of entries loads, one attachment query for that
// page's object ids (store.attachmentsOf); an entry with files gets a paperclip ("attachment" icon) in its meta line and, under its text,
// its images as small thumbnails (fetched when scrolled into view) and its other files as name-and-size chips.
//
// The layer is private: every file is fetched through the store (the SDK request, which signs it in) as a blob and shown
// from an object URL; every object URL is revoked when the dialog closes (reset()). Only raster images (png, jpeg, gif,
// webp), decided by the stored content type and never the name, are shown inline; a thumbnail opens in the lightbox.
// Everything else (SVG and HTML included) is download only, saved under its original name from an
// application/octet-stream blob, so it never opens in a tab. File names are text, never HTML. A file that fails to load
// shows its chip with "Couldn't load" and Retry.
//
// opts: { notesLayer, root () -> the element the rows are in (to update thumbnails in place), changed () -> the files
// of the shown entries changed (the dialog renders again), dialog: the calcite-dialog the rows are in (its focus trap
// lets the lightbox in while it is open) }.
export function createNoteFiles({ notesLayer, root = () => document, changed = () => {}, dialog = null }) {
  const T = NOTES.ATTACH.TEXT;
  const files = new Map(); // objectId (string) -> [{ id, name, contentType, size, url }]
  const thumbs = new Map(); // "<objectId>/<id>" -> { url, state: "loading" | "ready" | "failed", promise }
  const urls = new Set(); // every object URL made, revoked on reset()
  let controller = new AbortController();
  let queries = 0;
  const on = () => !!notesLayer.state.attachments && typeof notesLayer.state.store?.attachmentsOf === "function";
  const keyOf = (oid, f) => `${oid}/${f.id}`;
  const text = (cls, value) => { const el = h("span", { class: cls }); el.textContent = value; return el; };

  // One query for a page's entries; merged into what is known, then the dialog renders again.
  async function load(objectIds) {
    if (!on() || !objectIds?.length) return;
    const { signal } = controller;
    try {
      queries++;
      const found = await notesLayer.state.store.attachmentsOf(objectIds, { signal });
      if (signal.aborted) return;
      for (const oid of objectIds) files.set(String(oid), found?.[oid] ?? found?.[String(oid)] ?? []);
      changed();
    } catch (err) {
      if (err?.name === "AbortError" || signal.aborted) return;
      console.warn("Notes: couldn't read the entries' files:", err?.message ?? err);
    }
  }

  // the bytes as an object URL of `type` (tracked, so reset() revokes it)
  async function objectUrl(f, type) {
    const blob = await notesLayer.state.store.fetchAttachment(f, { signal: controller.signal });
    const url = URL.createObjectURL(new Blob([blob], { type }));
    urls.add(url);
    return url;
  }

  // ---- thumbnails: fetched when they come into view, kept for the dialog's life
  const observer = typeof IntersectionObserver === "function" ? new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      observer.unobserve(e.target);
      e.target.loadThumb?.();
    }
  }, { rootMargin: "200px" }) : null;
  function loadThumb(key, f) {
    let entry = thumbs.get(key);
    if (entry && entry.state !== "failed") return entry.promise;
    entry = { url: null, state: "loading", promise: null };
    thumbs.set(key, entry);
    const mine = controller;
    entry.promise = objectUrl(f, baseType(f.contentType)).then((url) => {
      if (mine.signal.aborted) return null;
      Object.assign(entry, { url, state: "ready" });
      for (const img of root().querySelectorAll(`.note-thumb[data-file="${CSS.escape(key)}"] img`)) img.src = url;
      return url;
    }, (err) => {
      if (mine.signal.aborted) return null;
      entry.state = "failed";
      console.warn("Notes: couldn't load a file:", err?.message ?? err);
      for (const el of root().querySelectorAll(`.note-thumb[data-file="${CSS.escape(key)}"]`)) el.replaceWith(failedChip(key, f));
      return null;
    });
    return entry.promise;
  }
  function thumb(oid, f) {
    const key = keyOf(oid, f);
    const entry = thumbs.get(key);
    if (entry?.state === "failed") return failedChip(key, f);
    const img = h("img", { alt: f.name, draggable: false });
    const el = h("button", { type: "button", class: "note-thumb", title: f.name, onclick: () => openImage(key, f) }, img);
    el.dataset.file = key;
    el.setAttribute("aria-label", T.OPEN_IMAGE(f.name));
    el.style.setProperty("--note-thumb-px", `${NOTES.ATTACH.THUMB_PX}px`);
    if (entry?.url) img.src = entry.url;
    else {
      el.loadThumb = () => loadThumb(key, f);
      if (observer) observer.observe(el); else el.loadThumb();
    }
    return el;
  }
  async function openImage(key, f) {
    const url = thumbs.get(key)?.url ?? await loadThumb(key, f);
    if (!url) return;
    await dialog?.updateFocusTrapElements?.([lightboxElement()]);
    openLightbox(url, f.name, { onClose: () => dialog?.updateFocusTrapElements?.([]) });
  }

  // ---- other files: a chip; a click downloads it under its own name
  async function download(f, chip) {
    chip.classList.add("loading");
    try {
      const url = await objectUrl(f, "application/octet-stream");
      // the anchor goes beside the chip, inside the dialog: a click outside an open Calcite dialog's focus trap is cancelled
      const a = h("a", { href: url, download: f.name || T.UNNAMED, rel: "noopener", hidden: true });
      (chip.parentElement ?? document.body).append(a);
      a.click();
      a.remove();
      chip.classList.remove("loading");
    } catch (err) {
      if (err?.name === "AbortError") return;
      console.warn("Notes: couldn't download a file:", err?.message ?? err);
      chip.replaceWith(failedChip(null, f, true));
    }
  }
  function chip(f) {
    const el = h("button", { type: "button", class: "note-file", title: T.DOWNLOAD(f.name) },
      h("calcite-icon", { icon: fileIcon(f.name, f.contentType), scale: "s" }), text("note-file-name", f.name || T.UNNAMED), text("note-file-size", fileSizeText(f.size)));
    el.setAttribute("aria-label", T.DOWNLOAD(f.name));
    el.addEventListener("click", () => download(f, el));
    return el;
  }
  // a file that couldn't be loaded: its name, "Couldn't load" and Retry (a thumbnail tries again; a download again)
  function failedChip(key, f, isDownload = false) {
    const el = h("span", { class: "note-file failed" }, h("calcite-icon", { icon: "exclamation-mark-triangle", scale: "s" }), text("note-file-name", f.name || T.UNNAMED),
      text("note-file-status", T.LOAD_FAILED));
    const retry = h("calcite-button", { appearance: "transparent", scale: "s", class: "note-file-retry" }, T.RETRY);
    retry.addEventListener("click", () => {
      if (isDownload) { const fresh = chip(f); el.replaceWith(fresh); download(f, fresh); return; }
      thumbs.delete(key);
      const fresh = thumb(key.slice(0, key.lastIndexOf("/")), f);
      el.replaceWith(fresh);
      fresh.loadThumb?.();
    });
    el.append(retry);
    return el;
  }

  // An entry's files under its text, images first; null when it has none (or files are off).
  function partsFor(note) {
    const list = files.get(String(note.objectId));
    if (!list?.length) return null;
    const images = list.filter((f) => isInlineImage(f.contentType));
    const others = list.filter((f) => !isInlineImage(f.contentType));
    return h("div", { class: "note-files" },
      images.length ? h("div", { class: "note-thumbs" }, ...images.map((f) => thumb(note.objectId, f))) : null,
      others.length ? h("div", { class: "note-file-chips" }, ...others.map(chip)) : null);
  }
  // the paperclip in an entry's meta line
  function clipFor(note) {
    const n = files.get(String(note.objectId))?.length ?? 0;
    if (!n) return null;
    const icon = h("calcite-icon", { icon: "attachment", scale: "s", class: "note-clip", textLabel: T.HAS_FILES(n) });
    icon.title = T.HAS_FILES(n);
    return icon;
  }

  // The dialog closed (or opened on another target): stop loading, revoke every object URL, forget the files.
  function reset() {
    controller.abort();
    controller = new AbortController();
    observer?.disconnect();
    for (const url of urls) URL.revokeObjectURL(url);
    urls.clear();
    thumbs.clear();
    files.clear();
  }

  return {
    load, partsFor, clipFor, reset, on,
    filesOf: (objectId) => files.get(String(objectId)) ?? [],
    get state() { return { on: on(), entries: [...files.values()].filter((l) => l.length).length, files: [...files.values()].reduce((n, l) => n + l.length, 0), objectUrls: urls.size, queries }; },
  };
}
