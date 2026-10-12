import { HIGHLIGHT, PARCEL_PANEL } from "./config.js";
import { openLightbox } from "./lightbox.js";
import { h } from "./dom.js";
import { createSelectableLayers, featureLayer, orderPopupFeatures, popupOrigins } from "./popupSelection.js";

const DEFAULT_HEADING = "Selected parcel";
const LOADER_DELAY_MS = 250; // quick loads never flash the loading indicator

// All Web Map popup content uses the full-height, resizable right panel.
// Returns { clearSelection, close, selectedObjectId, selectedValue, selectByObjectId, setSuspended(on, owner), suspendedBy, setHighlightOff(off), onSelectionChange }
// for other parts of the UI.
export async function setupParcelPanel(mapEl, parcel) {
  const initialFeatureEl = document.getElementById("parcel-feature");
  let featureEl = initialFeatureEl;
  const shellPanel = document.getElementById("parcel-shell-panel");
  const card = document.getElementById("parcel-card");
  const emptyEl = document.getElementById("parcel-empty");
  const loadingEl = document.getElementById("parcel-loading");
  const errorEl = document.getElementById("parcel-error");
  const bodyEl = document.getElementById("parcel-body");
  featureEl.map = mapEl.map; // needed because the Arcade expressions use $map
  featureEl.spatialReference = mapEl.spatialReference;
  featureEl.autoDestroyDisabled = true; // cached renderers are released explicitly when the selection changes
  const renderedFeatures = new Map();

  function watchFeature(renderer) {
    renderer.addEventListener("arcgisPropertyChange", (event) => {
      if (renderer === featureEl && event.detail.name === "state") updateView();
    });
  }
  watchFeature(featureEl);

  // Keep the SDK's evaluated Web Map content, including Arcade and attachments, alongside each hit.
  // Hidden renderers load in the background; paging only changes which one is visible.
  function cacheFeature(hit) {
    if (renderedFeatures.has(hit)) return renderedFeatures.get(hit);
    const renderer = renderedFeatures.size ? h("arcgis-feature", {
      map: mapEl.map, spatialReference: mapEl.spatialReference, autoDestroyDisabled: true, hidden: true,
    }) : initialFeatureEl;
    if (renderer !== initialFeatureEl) {
      watchFeature(renderer);
      renderer.addEventListener("arcgisReady", () => {
        if (renderedFeatures.get(hit) === renderer && renderer.shadowRoot) watchShadow(renderer.shadowRoot);
      }, { once: true });
      bodyEl.append(renderer);
    }
    renderer.hidden = true;
    renderer.graphic = hit;
    renderedFeatures.set(hit, renderer);
    return renderer;
  }

  function releaseFeature(renderer) {
    if (renderer === initialFeatureEl) renderer.graphic = null;
    else {
      renderer.destroy();
      renderer.remove();
    }
  }

  function clearFeatureCache() {
    featureEl.removeAttribute("id");
    renderedFeatures.forEach(releaseFeature);
    renderedFeatures.clear();
    featureEl = initialFeatureEl;
    featureEl.id = "parcel-feature";
    featureEl.graphic = null;
    featureEl.hidden = false;
  }

  const previous = h("calcite-action", { icon: "chevron-left", text: "Previous feature", title: "Previous feature", scale: "s" });
  const next = h("calcite-action", { icon: "chevron-right", text: "Next feature", title: "Next feature", scale: "s" });
  const counter = h("span", { class: "popup-counter", ariaLive: "polite" });
  const pager = h("div", { class: "popup-pager", slot: "header-actions-end", hidden: true }, previous, counter, next);
  card.append(pager);
  let clickFeatures = [];
  let featureIndex = 0;
  let latestClick = 0;
  let inflight;
  const selectableListeners = new Set();
  const selectable = createSelectableLayers(mapEl.map, () => {
    close(); // changing the click scope also cancels an earlier click's pending response
    selectableListeners.forEach((cb) => cb());
  });

  function updatePager() {
    pager.hidden = clickFeatures.length < 2;
    counter.textContent = `${featureIndex + 1} of ${clickFeatures.length}`;
    previous.disabled = featureIndex === 0;
    next.disabled = featureIndex === clickFeatures.length - 1;
  }

  let selected = null; // the graphic shown in the panel, if any
  const selectionListeners = new Set();
  const notifySelection = () => selectionListeners.forEach((cb) => cb());
  let highlight;
  let highlightOff = false; // true while the selection is drawn as an outline instead (selectionOutline.js)
  let loaderTimer;

  // Exactly one of: empty state, loading, error, or the pop-up content.
  // The content only shows once the component reports "ready", so a previous
  // parcel's content (or a half-evaluated one) is never visible.
  function updateView() {
    clearTimeout(loaderTimer);
    const state = selected ? featureEl.state : "none";
    emptyEl.hidden = state !== "none";
    errorEl.hidden = state !== "error";
    bodyEl.hidden = state !== "ready";
    loadingEl.hidden = true;
    if (state === "loading" || state === "disabled") {
      loaderTimer = setTimeout(() => (loadingEl.hidden = false), LOADER_DELAY_MS);
    }
  }

  function setHeader(graphic) {
    const layer = graphic?.layer ?? graphic?.sourceLayer;
    if (graphic && layer !== parcel) {
      card.heading = layer?.title ?? "Selected feature";
      card.description = "";
      return;
    }
    const values = graphic
      ? PARCEL_PANEL.TITLE_FIELDS.map((f) => graphic.attributes?.[f]).filter((v) => v != null && String(v).trim() !== "")
      : [];
    if (graphic && values.length === 0) {
      console.warn(`PARCEL_PANEL.TITLE_FIELDS: none of ${PARCEL_PANEL.TITLE_FIELDS.join(", ")} has a value on this parcel's pop-up attributes.`);
    }
    card.heading = values.length ? String(values[0]) : DEFAULT_HEADING;
    card.description = graphic ? [layer?.title ?? DEFAULT_HEADING, ...values.slice(1)].join(" · ") : "";
  }

  // Nothing selected: drop the highlight and show the empty state. Leaves the panel open or closed as it was.
  function clearSelection() {
    ++latestClick;
    inflight?.abort();
    clickFeatures = [];
    updatePager();
    highlight?.remove();
    highlight = undefined;
    selected = null;
    clearFeatureCache();
    setHeader(null);
    updateView();
    notifySelection();
  }

  function close() {
    clearSelection();
    shellPanel.collapsed = true;
    card.closed = false; // the panel's own close button hides its content; undo that so it can reopen
  }

  // While a measurement is in progress, or the georeferencing workspace is open, map clicks must not select parcels.
  // Each caller suspends under its own owner name ("measure", "georef"), so one finishing can't re-enable clicks
  // while another still needs them off. Selection resumes when no owner is left.
  const suspendedBy = new Set();
  const setSuspended = (on, owner = "measure") => {
    if (on) {
      suspendedBy.add(owner);
      ++latestClick;
      inflight?.abort();
    }
    else suspendedBy.delete(owner);
    previous.disabled = next.disabled = suspendedBy.size > 0;
    if (!suspendedBy.size) updatePager();
  };

  const canHighlight = (hit, request) => request === latestClick && selected === hit
    && !(highlightOff && featureLayer(hit) === parcel) && !highlight;
  async function highlightFeature(hit, request) {
    try {
      const layerView = await mapEl.whenLayerView(featureLayer(hit));
      if (typeof layerView.highlight === "function") {
        if (canHighlight(hit, request)) highlight = layerView.highlight(hit);
        return;
      }
    } catch { /* Queryable sublayers may not have their own highlight-capable layer view. */ }
    if (!hit.geometry || !canHighlight(hit, request)) return;
    const Graphic = await $arcgis.import("@arcgis/core/Graphic.js");
    if (!canHighlight(hit, request)) return;
    const type = hit.geometry.type;
    const symbol = type === "polygon"
      ? { type: "simple-fill", color: [0, 0, 0, 0], outline: { color: HIGHLIGHT.color, width: HIGHLIGHT.OUTLINE.YELLOW_WIDTH } }
      : type === "polyline" ? { type: "simple-line", color: HIGHLIGHT.color, width: HIGHLIGHT.OUTLINE.YELLOW_WIDTH }
      : { type: "simple-marker", color: HIGHLIGHT.color, size: 12, outline: { color: HIGHLIGHT.haloColor, width: 2 } };
    const graphic = new Graphic({ geometry: hit.geometry, symbol });
    mapEl.graphics.add(graphic); // no popup template: this highlight cannot intercept a click
    highlight = { remove: () => mapEl.graphics.remove(graphic) };
  }

  // Show a feature in the panel and highlight it. `request` is the click or search that asked for it: a newer
  // one wins, so a slower earlier one never overwrites it.
  async function showFeature(hit, request) {
    if (request !== latestClick) return;
    highlight?.remove();
    highlight = undefined;
    selected = hit;
    card.closed = false;
    setHeader(hit);
    featureEl.hidden = true;
    featureEl.removeAttribute("id");
    featureEl = cacheFeature(hit);
    featureEl.id = "parcel-feature";
    featureEl.hidden = false;
    updateView();
    notifySelection();
    shellPanel.collapsed = false;
    updatePager();
    await highlightFeature(hit, request);
  }

  async function stepFeature(delta) {
    const index = featureIndex + delta;
    if (suspendedBy.size || index < 0 || index >= clickFeatures.length) return;
    featureIndex = index;
    await showFeature(clickFeatures[index], ++latestClick);
  }
  previous.addEventListener("click", () => stepFeature(-1));
  next.addEventListener("click", () => stepFeature(1));

  // The layer view's own highlight (the fill) is switched off and back on without touching HighlightOptions, which
  // intermittently throws when changed on a live view; only the handle is removed or re-requested.
  async function setHighlightOff(off) {
    highlightOff = off;
    if (off && featureLayer(selected) === parcel) {
      highlight?.remove();
      highlight = undefined;
      return;
    }
    const hit = selected;
    if (!hit || highlight) return;
    const click = latestClick;
    await highlightFeature(hit, click);
  }

  mapEl.addEventListener("arcgisViewClick", async (event) => {
    if (suspendedBy.size || event.detail.button === 2) return;
    selectable.sync();
    const click = ++latestClick;
    inflight?.abort();
    const controller = (inflight = new AbortController());
    try {
      const generator = await mapEl.fetchPopupFeatures(event.detail.screenPoint, {
        pointerType: event.detail.pointerType, signal: controller.signal,
      });
      const features = await Array.fromAsync(generator);
      if (click !== latestClick) return;
      clickFeatures = orderPopupFeatures(features, mapEl.map.layers);
      if (selectable.only) clickFeatures = clickFeatures.filter((g) => featureLayer(g) === selectable.only);
      featureIndex = 0;
      if (!clickFeatures.length) { close(); return; }
      clearFeatureCache();
      const showing = showFeature(clickFeatures[0], click);
      // Give the top feature a head start; don't wait for underlying details before showing it.
      const featuresToCache = clickFeatures;
      setTimeout(() => {
        if (clickFeatures === featuresToCache) featuresToCache.slice(1).forEach(cacheFeature);
      }, 0);
      await showing;
    } catch (err) {
      if (click !== latestClick || err?.name === "AbortError") return;
      close();
      console.warn("Couldn't fetch popup features:", err);
    }
  });

  // Select a parcel the way a click on it would (search and ?parcel=). Resolves to the parcel's geometry in the
  // view's spatial reference, or null if it no longer exists or a newer selection superseded this one.
  async function selectByObjectId(objectId) {
    const request = ++latestClick;
    inflight?.abort();
    clickFeatures = [];
    updatePager();
    const { features } = await parcel.queryFeatures({
      objectIds: [objectId],
      outFields: ["*"], // the pop-up's Arcade expressions read whatever fields they need
      returnGeometry: true,
      outSpatialReference: mapEl.spatialReference,
    });
    if (request !== latestClick || features.length === 0) return null;
    const hit = features[0];
    if (!hit.layer && !hit.sourceLayer) hit.layer = parcel;
    clearFeatureCache();
    await showFeature(hit, request);
    return hit.geometry ?? null;
  }

  card.addEventListener("calcitePanelClose", close);

  // Pop-up images (in arcgis-feature's shadow DOM, from the web map's own PopupTemplate media/attachments) open in a
  // full-screen lightbox. composedPath() finds the <img> itself; event.target would be retargeted to arcgis-feature.
  // preventDefault stops a click on an <img> inside a pop-up Link element from navigating.
  bodyEl.addEventListener("click", (event) => {
    const target = event.composedPath().find((node) => node?.tagName === "IMG");
    if (!target?.src) return;
    event.preventDefault();
    openLightbox(target.src, target.alt);
  });

  // Pop-up <img>s get a zoom-in cursor so they read as clickable. The pop-up content lives in (possibly nested)
  // shadow roots the SDK attaches lazily, so a single tagging pass isn't enough: watch every shadow root we find,
  // including ones that show up later, and re-tag whenever it changes.
  // Shadow roots attached after the first pass can be missed, so also tag an image the moment the pointer enters it.
  bodyEl.addEventListener("mouseover", (event) => {
    const img = event.composedPath().find((node) => node?.tagName === "IMG");
    if (img) img.style.cursor = "zoom-in";
  });
  const watchedRoots = new WeakSet();
  function tagImages(root) {
    for (const el of root.querySelectorAll("img")) el.style.cursor = "zoom-in";
    for (const el of root.querySelectorAll("*")) {
      if (el.shadowRoot) watchShadow(el.shadowRoot);
    }
  }
  function watchShadow(root) {
    if (watchedRoots.has(root)) return;
    watchedRoots.add(root);
    tagImages(root);
    new MutationObserver(() => tagImages(root)).observe(root, { childList: true, subtree: true });
  }
  (function waitForShadowRoot() {
    if (featureEl.shadowRoot) watchShadow(featureEl.shadowRoot);
    else setTimeout(waitForShadowRoot, 50);
  })();

  const { watch } = await $arcgis.import("@arcgis/core/core/reactiveUtils.js");
  function syncFeatures() {
    selectable.sync();
    const features = orderPopupFeatures(clickFeatures, mapEl.map.layers);
    if (!selected || !clickFeatures.length) return;
    if (!features.length) { close(); return; }
    const index = features.indexOf(selected);
    clickFeatures = features;
    featureIndex = index < 0 ? 0 : index;
    updatePager();
    if (index < 0) showFeature(features[0], ++latestClick);
    for (const [hit, renderer] of renderedFeatures) {
      if (features.includes(hit)) continue;
      releaseFeature(renderer);
      renderedFeatures.delete(hit);
    }
  }
  watch(() => popupOrigins(mapEl.map.layers).flatMap((layer) => {
    const values = [layer.popupEnabled, layer.popupTemplate];
    for (let parent = layer; parent; parent = parent.parent) values.push(parent.visible);
    return values;
  }), syncFeatures);
  mapEl.map.allLayers.on("change", syncFeatures);
  updateView();

  // Object id of the selected parcel, or null when nothing (or another layer's feature) is selected.
  function selectedObjectId() {
    if (!selected || (selected.layer ?? selected.sourceLayer) !== parcel) return null;
    return selected.getObjectId?.() ?? selected.attributes?.[parcel.objectIdField] ?? null;
  }

  // An attribute of the selected parcel as the pop-up fetched it, or null (also when another layer's feature is selected).
  function selectedValue(field) {
    if (!selected || (selected.layer ?? selected.sourceLayer) !== parcel) return null;
    return selected.attributes?.[field] ?? null;
  }

  return {
    clearSelection, close, selectedObjectId, selectedValue, selectByObjectId, setSuspended, suspendedBy, setHighlightOff,
    get highlightOff() { return highlightOff; },
    selectable, onSelectableChange: (cb) => selectableListeners.add(cb),
    onSelectionChange: (cb) => selectionListeners.add(cb),
  };
}
