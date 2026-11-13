import { h } from "./dom.js";
import { NOTES } from "./config.js";
import { attachmentRules, extensionOf, fileIcon, fileSizeText, isResizable, resizedName, resizePlan } from "./attachmentLogic.js";

// Files on a Notes entry, the adding side (section 55): the composer's Files row (Note and Contact mode, right after
// Link). "Add files" (several at once), files dropped on the composer, and an image pasted into the note box (a
// screenshot) all come here. Each file is checked (attachmentLogic.attachmentRules: count, size, type); a rejected one
// shows its message beside it and never blocks the entry or the other files. A photo over RESIZE.ABOVE_BYTES whose long
// side is over RESIZE.MAX_SIDE is redrawn on a canvas as a JPEG (createImageBitmap with imageOrientation "from-image",
// so it stays upright), which also drops its EXIF data (location included); it shows "Resized to 2048 px". Other files
// are never changed. The files live in memory with the draft; notesDialog uploads them after the entry is saved.
//
// opts: { changed () -> the list changed }. Returns { node, add(files), settled() -> Promise once every file is ready,
// files() -> the File objects to upload, items(), restore(items), clear(), markFailed(files), remove(key), get count }.
export function createFilePicker({ changed = () => {} } = {}) {
  const A = NOTES.ATTACH, T = A.TEXT;
  let items = []; // { key, file, name, size, state: "ready" | "processing" | "rejected" | "failed", message, note }
  let next = 1;
  let pending = Promise.resolve();
  const accept = Object.keys(A.ACCEPT).map((ext) => `.${ext}`).join(",");
  const input = h("input", { type: "file", multiple: true, accept, hidden: true, class: "notes-file-input",
    onchange: () => { add([...input.files]); input.value = ""; } });
  const addButton = h("calcite-button", { scale: "s", appearance: "outline", iconStart: "attachment", class: "notes-add-files", onclick: () => input.click() }, T.ADD_FILES);
  const hint = h("span", { class: "plan-note notes-files-hint" }, T.FILES_HINT(A.MAX_FILES, fileSizeText(A.MAX_BYTES)));
  const list = h("ul", { class: "notes-file-list", ariaLive: "polite" });
  const node = h("div", { class: "form-field notes-files" },
    h("div", { class: "form-label" }, T.FILES_LABEL), h("div", { class: "notes-files-add" }, addButton, hint), input, list);

  const ready = () => items.filter((it) => it.state === "ready" || it.state === "failed");
  const text = (cls, value) => { const el = h("span", { class: cls }); el.textContent = value; return el; };
  function render() {
    list.replaceChildren(...items.map((it) => {
      const remove = h("calcite-action", { icon: "x", scale: "s", text: T.REMOVE(it.name), label: T.REMOVE(it.name), class: "notes-file-remove",
        onclick: () => removeItem(it.key) });
      const status = it.state === "processing" ? T.PREPARING : it.message || it.note || "";
      const li = h("li", { class: `notes-file-item ${it.state}` },
        h("calcite-icon", { icon: it.state === "rejected" || it.state === "failed" ? "exclamation-mark-triangle" : fileIcon(it.name, it.file?.type ?? null), scale: "s" }),
        text("notes-file-name", it.name), it.size ? text("notes-file-size", fileSizeText(it.size)) : null,
        status ? text("notes-file-status", status) : null, remove);
      li.dataset.key = it.key;
      return li;
    }));
    list.hidden = !items.length;
    addButton.disabled = ready().length >= A.MAX_FILES;
  }
  function removeItem(key) {
    items = items.filter((it) => it.key !== key);
    render();
    changed();
  }

  // a photo redrawn smaller, or the file itself
  async function prepare(file) {
    if (!isResizable(file.type) || !(file.size > A.RESIZE.ABOVE_BYTES) || typeof createImageBitmap !== "function") return { file, note: "" };
    let bitmap = null;
    try {
      bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
      const plan = resizePlan(bitmap.width, bitmap.height, file.size);
      if (!plan) return { file, note: "" };
      const canvas = h("canvas", { width: plan.width, height: plan.height });
      const ctx = canvas.getContext("2d");
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(bitmap, 0, 0, plan.width, plan.height);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, plan.type, plan.quality));
      if (!blob) return { file, note: "" };
      return { file: new File([blob], resizedName(file.name), { type: plan.type, lastModified: file.lastModified }), note: T.RESIZED(Math.max(plan.width, plan.height)) };
    } catch (err) {
      console.warn("Notes: couldn't resize a photo; it goes as it is:", err?.message ?? err);
      return { file, note: "" };
    } finally {
      bitmap?.close?.();
    }
  }

  // Files picked, dropped or pasted: each is shown at once ("Preparing…" while a photo is redrawn), then checked against
  // the rules with the files already ready.
  function add(files) {
    const incoming = [...(files ?? [])].filter(Boolean);
    if (!incoming.length) return pending;
    const fresh = incoming.map((file) => ({ key: `f${next++}`, file, name: file.name, size: file.size, state: "processing", message: "", note: "" }));
    items = [...items, ...fresh];
    render();
    changed();
    // one batch after another, so each is counted against the files ready before it
    const work = pending.then(async () => {
      const prepared = await Promise.all(fresh.map((it) => prepare(it.file)));
      fresh.forEach((it, i) => Object.assign(it, { file: prepared[i].file, name: prepared[i].file.name, size: prepared[i].file.size, note: prepared[i].note }));
      const { rejected } = attachmentRules(fresh.map((it) => it.file), A, ready().length);
      for (const it of fresh) {
        const r = rejected.find((x) => x.file === it.file);
        Object.assign(it, r ? { state: "rejected", message: r.message } : { state: "ready" });
      }
      if (items.some((it) => fresh.includes(it))) { render(); changed(); }
    });
    pending = work.catch((err) => console.warn("Notes: couldn't add the files:", err?.message ?? err));
    return pending;
  }

  return {
    node, add,
    settled: () => pending,
    // the files to upload (ready ones, and ones that failed before), in order
    files: () => ready().map((it) => it.file),
    items: () => items.map((it) => ({ ...it })),
    restore(saved) { items = (saved ?? []).filter((it) => it.state !== "processing").map((it) => ({ ...it })); render(); },
    clear() { items = []; render(); },
    // after an upload: only the files that didn't go stay, marked "Didn't upload"
    markFailed(files) {
      items = items.filter((it) => files.includes(it.file)).map((it) => ({ ...it, state: "failed", message: T.NOT_UPLOADED }));
      render();
    },
    remove: removeItem,
    get count() { return ready().length; },
    get busy() { return items.some((it) => it.state === "processing"); },
  };
}

// A pasted image's name: "Screenshot 2026-11-09 15.30.12.png" (the browser calls every pasted image "image.png").
export function pastedName(file, now = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}.${pad(now.getMinutes())}.${pad(now.getSeconds())}`;
  const ext = extensionOf(file?.name) || (file?.type === "image/jpeg" ? "jpg" : "png");
  return NOTES.ATTACH.TEXT.PASTED_NAME(stamp, ext);
}
