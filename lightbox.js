import { h } from "./dom.js";

// A full-window image lightbox: click/keyboard zoom and pan, Esc/X/scrim to close. Self-contained (its own overlay,
// appended to <body> on first use) so any caller can open it with just a URL - the popup's <img>.src or <a>.href,
// reused as-is, no extra fetch.
//
//   openLightbox(src, alt)  show src (alt as the accessible label and, when it fails to load, the shown text)

const MIN_SCALE = 1; // "fit": the size the image opens at (about 90% of the window)
const MAX_SCALE = 8;
const OPEN_FILL = 0.9; // share of the window the image fills on open
const MAX_OPEN_UPSCALE = 4; // small images are upscaled on open, but never past this multiple of natural size
const DOUBLE_TAP_SCALE = 2;
const WHEEL_STEP = 1.2;
const BUTTON_STEP = 1.5;

let overlay, scrim, img, dialog, closeButton, label;
let scale = MIN_SCALE, tx = 0, ty = 0; // translate in screen pixels from the window center, applied with scale
let fitWidth = 0, fitHeight = 0; // the image as drawn at scale 1 (the open size)
let returnFocus = null;
let dragging = null; // { startX, startY, startTx, startTy } for mouse/one-finger drag
let pinch = null; // { startDist, startScale } for two-finger pinch

function build() {
  if (overlay) return;
  label = h("span", { id: "lightbox-label", class: "lightbox-sr-only" }, "Image");
  closeButton = h("button", { type: "button", class: "lightbox-close", "aria-label": "Close", title: "Close", onclick: () => closeLightbox() });
  closeButton.innerHTML = '<svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true"><path d="M5 5l14 14M19 5L5 19" stroke="currentColor" stroke-width="3" stroke-linecap="round" fill="none"/></svg>';
  const zoomOut = h("calcite-action", { icon: "minus", text: "Zoom out", label: "Zoom out", scale: "m", class: "lightbox-zoom-out", onclick: () => zoomBy(1 / BUTTON_STEP) });
  const zoomIn = h("calcite-action", { icon: "plus", text: "Zoom in", label: "Zoom in", scale: "m", class: "lightbox-zoom-in", onclick: () => zoomBy(BUTTON_STEP) });
  const zoomFit = h("calcite-action", { icon: "zoom-to-object", text: "Fit", label: "Reset zoom to fit", scale: "m", class: "lightbox-zoom-fit", onclick: () => setScale(MIN_SCALE, true) });
  const toolbar = h("div", { class: "lightbox-toolbar" }, zoomOut, zoomFit, zoomIn);

  img = h("img", {
    class: "lightbox-img", draggable: false,
    onload: () => fitImage(),
    onerror: () => { img.hidden = true; fallback.hidden = false; },
    ondblclick: onDoubleClick,
  });
  const fallback = h("div", { class: "lightbox-fallback", hidden: true }, "This image couldn't be loaded.");

  dialog = h("div", {
    class: "lightbox-dialog", role: "dialog", ariaModal: "true", ariaLabelledby: "lightbox-label", tabindex: "-1",
  }, label, closeButton, toolbar, img, fallback);

  scrim = h("div", { class: "lightbox-scrim", onclick: (e) => { if (e.target === scrim) closeLightbox(); } }, dialog);
  overlay = h("div", { class: "lightbox-overlay", hidden: true, onkeydown: onKeyDown }, scrim);
  overlay.addEventListener("wheel", onWheel, { passive: false });
  overlay.addEventListener("pointerdown", onPointerDown);
  overlay.addEventListener("pointermove", onPointerMove);
  overlay.addEventListener("pointerup", onPointerUp);
  overlay.addEventListener("pointercancel", onPointerUp);
  document.body.append(overlay);
}

function fitImage() {
  const naturalW = img.naturalWidth || 1;
  const naturalH = img.naturalHeight || 1;
  const fitScale = Math.min(MAX_OPEN_UPSCALE, (window.innerWidth * OPEN_FILL) / naturalW, (window.innerHeight * OPEN_FILL) / naturalH);
  fitWidth = naturalW * fitScale;
  fitHeight = naturalH * fitScale;
  scale = MIN_SCALE;
  setScale(MIN_SCALE, true);
}

function clampPan() {
  const w = fitWidth * scale, h = fitHeight * scale;
  const maxX = Math.max(0, (w - window.innerWidth) / 2 + w * 0.02);
  const maxY = Math.max(0, (h - window.innerHeight) / 2 + h * 0.02);
  tx = Math.min(maxX, Math.max(-maxX, tx));
  ty = Math.min(maxY, Math.max(-maxY, ty));
}

function render() {
  img.style.width = `${fitWidth}px`;
  img.style.height = `${fitHeight}px`;
  img.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
  img.style.cursor = scale > MIN_SCALE ? "grab" : "default";
}

// Zooms keeping the screen point (px, py) fixed; defaults to the window center. The image is centered in the window,
// so a point's offset from the center scales with the zoom around the translate.
function setScale(next, resetPan = false, px = window.innerWidth / 2, py = window.innerHeight / 2) {
  const k = Math.min(MAX_SCALE, Math.max(MIN_SCALE, next)) / scale;
  const ox = px - window.innerWidth / 2, oy = py - window.innerHeight / 2;
  scale *= k;
  tx = ox - (ox - tx) * k;
  ty = oy - (oy - ty) * k;
  if (resetPan || scale === MIN_SCALE) { tx = 0; ty = 0; }
  clampPan();
  render();
}

function zoomBy(factor, px, py) {
  setScale(scale * factor, false, px, py);
}

function onDoubleClick(e) {
  e.preventDefault();
  if (scale > MIN_SCALE) setScale(MIN_SCALE, true);
  else setScale(DOUBLE_TAP_SCALE, false, e.clientX, e.clientY);
}

function onWheel(e) {
  if (overlay.hidden) return;
  e.preventDefault();
  zoomBy(e.deltaY < 0 ? WHEEL_STEP : 1 / WHEEL_STEP, e.clientX, e.clientY);
}

// Window-level, capture phase, only while open: Esc closes the lightbox and nothing else (the app's own Esc handlers
// for the feature selection, popup and panels never see it).
function onEscapeCapture(e) {
  if (e.key !== "Escape") return;
  e.stopImmediatePropagation();
  e.stopPropagation();
  e.preventDefault();
  closeLightbox();
}

function onKeyDown(e) {
  switch (e.key) {
    case "+":
    case "=":
      e.preventDefault();
      zoomBy(BUTTON_STEP);
      break;
    case "-":
    case "_":
      e.preventDefault();
      zoomBy(1 / BUTTON_STEP);
      break;
    case "0":
      e.preventDefault();
      setScale(MIN_SCALE, true);
      break;
    case "Tab": {
      const list = [closeButton, ...dialog.querySelectorAll("calcite-action")];
      const i = list.indexOf(document.activeElement);
      const next = e.shiftKey ? (i <= 0 ? list.length - 1 : i - 1) : i === list.length - 1 ? 0 : i + 1;
      e.preventDefault();
      list[next].focus();
      break;
    }
  }
}

function dist(a, b) {
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
}

const activePointers = new Map();

function onPointerDown(e) {
  if (overlay.hidden || e.target !== img) return;
  activePointers.set(e.pointerId, e);
  if (activePointers.size === 1 && scale > MIN_SCALE) {
    dragging = { startX: e.clientX, startY: e.clientY, startTx: tx, startTy: ty };
    img.setPointerCapture?.(e.pointerId);
  } else if (activePointers.size === 2) {
    dragging = null;
    const [a, b] = [...activePointers.values()];
    pinch = { startDist: dist(a, b) || 1, startScale: scale };
  }
}

function onPointerMove(e) {
  if (!activePointers.has(e.pointerId)) return;
  activePointers.set(e.pointerId, e);
  if (pinch && activePointers.size === 2) {
    const [a, b] = [...activePointers.values()];
    setScale(pinch.startScale * (dist(a, b) / pinch.startDist), false, (a.clientX + b.clientX) / 2, (a.clientY + b.clientY) / 2);
  } else if (dragging) {
    tx = dragging.startTx + (e.clientX - dragging.startX);
    ty = dragging.startTy + (e.clientY - dragging.startY);
    clampPan();
    render();
  }
}

function onPointerUp(e) {
  activePointers.delete(e.pointerId);
  if (activePointers.size < 2) pinch = null;
  if (activePointers.size === 0) dragging = null;
}

export function openLightbox(src, alt) {
  build();
  returnFocus = document.activeElement;
  label.textContent = alt || "Image";
  img.hidden = false;
  dialog.querySelector(".lightbox-fallback").hidden = true;
  img.alt = alt || "";
  img.src = src;
  scale = MIN_SCALE;
  tx = 0;
  ty = 0;
  overlay.hidden = false;
  window.addEventListener("keydown", onEscapeCapture, true);
  dialog.focus();
}

export function closeLightbox() {
  if (!overlay || overlay.hidden) return;
  overlay.hidden = true;
  window.removeEventListener("keydown", onEscapeCapture, true);
  img.src = "";
  activePointers.clear();
  dragging = null;
  pinch = null;
  const back = returnFocus;
  returnFocus = null;
  if (back && document.contains(back)) (back.setFocus ? back.setFocus() : back.focus());
}

export function isLightboxOpen() {
  return !!overlay && !overlay.hidden;
}
