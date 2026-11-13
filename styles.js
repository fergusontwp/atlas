import { LEGEND, STYLES, DEFAULT_STYLE, STYLE_BREAKS, fillSymbol, NO_DATA_COLOR } from "./config.js";
import { breaksRenderer } from "./classBreaks.js";
import { setStatus } from "./ui.js";
import { setParam } from "./urlParams.js";

const STYLE_PARAM = "style";
const STORAGE_KEY = "parcelviewer.style";

// localStorage can throw (private windows, blocked site data), so nothing depends on it.
function readRemembered() {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function remember(key) {
  try {
    localStorage.setItem(STORAGE_KEY, key);
  } catch {
    // not remembered; the picker still works
  }
}

// Keep the address bar in step with the picker so a copied link reproduces the view.
function writeUrl(key) {
  setParam(STYLE_PARAM, key);
}

// ?style=<id> beats the remembered choice, which beats DEFAULT_STYLE.
function initialStyle(available) {
  const fromUrl = new URLSearchParams(location.search).get(STYLE_PARAM);
  if (fromUrl !== null) {
    if (available.has(fromUrl)) return { key: fromUrl, source: "url" };
    console.warn(`Ignoring ?${STYLE_PARAM}=${fromUrl}: not an available style (${[...available].join(", ")}).`);
  }
  const remembered = readRemembered();
  if (remembered && available.has(remembered)) return { key: remembered, source: "remembered" };
  if (!available.has(DEFAULT_STYLE)) {
    console.warn(`DEFAULT_STYLE "${DEFAULT_STYLE}" isn't an available style; using "original".`);
    return { key: "original", source: "default" };
  }
  return { key: DEFAULT_STYLE, source: "default" };
}

export async function setupStyles(mapEl, layer) {
  const picker = document.getElementById("style-picker");
  const fieldNames = new Set(layer.fields.map((f) => f.name));
  const cache = { original: layer.renderer.clone() };

  // The web map's own expression, before any filter: natural breaks are computed over the whole layer, so a filter that
  // is on when a preset is first picked must not shape the classes (setupStyles runs before the filter is set up).
  const baseExpression = layer.definitionExpression ?? null;

  // Breaks for a natural-breaks preset, computed once and then cached with the renderer (a filter change never
  // recomputes them, so the legend stays put while filtering). The SDK's smart-mapping class-breaks creator does the
  // classification; the labels and symbols are ours (classBreaks.js).
  async function naturalBreaks(style) {
    const [color] = await $arcgis.import(["@arcgis/core/smartMapping/renderers/color.js"]);
    // With a filter on, classify a copy of the layer that has only the web map's own expression. A layer built from
    // in-memory features can't be cloned; then the layer itself is used with the filter lifted for the moment it takes.
    const keptExpression = layer.definitionExpression ?? null;
    let source = layer;
    let lifted = false;
    if (keptExpression !== baseExpression) {
      try {
        source = layer.clone();
        source.definitionExpression = baseExpression;
      } catch {
        source = layer;
        layer.definitionExpression = baseExpression;
        lifted = true;
      }
    }
    const abort = new AbortController();
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        abort.abort();
        reject(new Error(`Computing the classes for ${style.label} took longer than ${STYLE_BREAKS.TIMEOUT_MS / 1000} seconds.`));
      }, STYLE_BREAKS.TIMEOUT_MS);
    });
    try {
      const { renderer } = await Promise.race([
        color.createClassBreaksRenderer({
          layer: source,
          view: mapEl.view,
          field: style.field,
          classificationMethod: "natural-breaks",
          numClasses: style.breaks.classes,
          signal: abort.signal,
        }),
        timeout,
      ]);
      return breaksRenderer({
        field: style.field,
        title: style.breaks.title,
        format: style.breaks.format,
        colors: style.breaks.colors,
        infos: renderer.classBreakInfos,
        fill: fillSymbol,
        noData: NO_DATA_COLOR,
      });
    } finally {
      clearTimeout(timer);
      // Put the filter back, unless the user applied another one in the meantime.
      if (lifted && (layer.definitionExpression ?? null) === baseExpression) layer.definitionExpression = keptExpression;
    }
  }

  const loading = { count: 0, el: null };
  function showLoading(on) {
    loading.count += on ? 1 : -1;
    if (loading.el) loading.el.hidden = loading.count <= 0;
  }

  const building = {}; // key -> promise, so two quick picks of the same preset compute its breaks once
  async function rendererFor(key) {
    if (cache[key]) return cache[key];
    const style = STYLES[key];
    if (style.unique) {
      const mod = await $arcgis.import("@arcgis/core/smartMapping/renderers/type.js");
      const createRenderer = mod.createRenderer ?? mod.default?.createRenderer;
      const { renderer } = await createRenderer({ layer, view: mapEl.view, field: style.field });
      return (cache[key] = renderer);
    }
    if (style.breaks) {
      if (!building[key]) {
        showLoading(true);
        building[key] = naturalBreaks(style)
          .then((renderer) => (cache[key] = renderer))
          .catch((err) => {
            console.warn(`Couldn't compute the classes for "${style.label}":`, err);
            throw err;
          })
          .finally(() => {
            delete building[key]; // a failure is not cached, so picking the preset again retries
            showLoading(false);
          });
      }
      return building[key];
    }
    return (cache[key] = style.renderer);
  }

  const available = new Set();
  for (const [key, style] of Object.entries(STYLES)) {
    if (style.field && !fieldNames.has(style.field)) {
      console.warn(`Skipping "${style.label}": no field named ${style.field} on ${layer.title}`);
      continue;
    }
    available.add(key);
  }

  // The picker's loading state, shown while a natural-breaks preset's classes are being computed (the picker itself
  // stays usable: the last pick wins).
  loading.el = document.createElement("calcite-loader");
  loading.el.inline = true;
  loading.el.scale = "s";
  loading.el.text = "Computing classes…";
  loading.el.label = "Computing classes";
  loading.el.hidden = true;
  picker.closest("calcite-label").after(loading.el);

  const initial = initialStyle(available);
  for (const key of available) {
    const item = document.createElement("calcite-segmented-control-item");
    item.value = key;
    item.textContent = STYLES[key].label;
    item.checked = key === initial.key;
    picker.append(item);
  }

  function select(key) {
    for (const item of picker.querySelectorAll("calcite-segmented-control-item")) {
      item.checked = item.value === key;
    }
  }

  function reportFailure(err) {
    console.error(err);
    setStatus("warning", "Couldn't apply that style", err.message ?? String(err));
  }

  let current = "original"; // what the layer is drawing now
  let latest = 0; // lets a newer pick win over a slower earlier one
  async function applyStyle(key) {
    const request = ++latest;
    const renderer = await rendererFor(key);
    if (request !== latest) return false;
    layer.renderer = renderer;
    current = key;
    return true;
  }

  picker.addEventListener("calciteSegmentedControlChange", async (event) => {
    const key = event.target.value;
    try {
      if (!(await applyStyle(key))) return;
      remember(key);
      writeUrl(key);
    } catch (err) {
      reportFailure(err);
      select(current);
    }
  });

  // Legend for the map's visible operational layers, in map order. With no layerInfos the component lists every layer
  // that has a legend and is on and in scale, and updates by itself as layers are added, removed or switched. The
  // parcel entry is the parcel layer, so it follows the renderer the symbology picker sets (and ?style=). The parcel
  // layer's title is already "Parcels" (layers.js). Graphics layers (edge lengths, "Within" outline), the plan
  // overlay and the layer list's hidden helpers have no legend entry.
  for (const title of LEGEND.EXCLUDE_TITLES) {
    const matches = mapEl.map.allLayers.filter((l) => l.title === title);
    if (matches.length === 0) console.warn(`LEGEND.EXCLUDE_TITLES: no layer titled "${title}"`);
    matches.forEach((l) => (l.legendEnabled = false));
  }
  // The legend sits in a wrapper of ours that carries the height cap and the scrolling: capping the component itself
  // lets its (unconstrained) content spill past the cap and leaves a white patch over the map.
  const wrap = document.createElement("div");
  wrap.id = "legend-wrap";
  wrap.slot = "bottom-left";
  wrap.style.overflowY = "auto";
  const legend = document.createElement("arcgis-legend");
  // A header row stays at the top (sticky, so it shows while a long legend scrolls) with a chevron that minimizes the
  // legend to just that row. The legend element stays mounted, only hidden, so nothing is rebuilt when it comes back.
  const toggle = document.createElement("calcite-action");
  toggle.id = "legend-toggle";
  toggle.scale = "s";
  toggle.compact = true;
  const head = document.createElement("div");
  head.className = "legend-head";
  const title = document.createElement("span");
  title.className = "legend-title";
  title.textContent = LEGEND.TITLE;
  head.append(title, toggle);
  const tip = document.createElement("calcite-tooltip");
  tip.referenceElement = toggle;
  tip.placement = "top";
  wrap.append(head, tip, legend);
  mapEl.append(wrap);

  const readMinimized = () => {
    try {
      const v = localStorage.getItem(LEGEND.STORAGE_KEY);
      return v === null ? !!LEGEND.MINIMIZED_DEFAULT : v === "1";
    } catch {
      return !!LEGEND.MINIMIZED_DEFAULT;
    }
  };
  let minimized = readMinimized();
  function renderMinimized() {
    legend.style.display = minimized ? "none" : ""; // not the hidden attribute: the component sets its own display
    wrap.classList.toggle("legend-minimized", minimized);
    const label = minimized ? "Show the legend" : "Minimize the legend";
    toggle.icon = minimized ? "chevron-up" : "chevron-down";
    toggle.text = label;
    toggle.label = label;
    toggle.setAttribute("aria-expanded", String(!minimized));
    tip.textContent = label;
  }
  toggle.addEventListener("click", () => {
    minimized = !minimized;
    try {
      localStorage.setItem(LEGEND.STORAGE_KEY, minimized ? "1" : "0");
    } catch { /* private window or blocked storage: the choice just isn't remembered */ }
    renderMinimized();
  });
  renderMinimized();

  // A tall legend scrolls inside instead of growing over the map.
  const mapHost = document.getElementById("map-host");
  const fitLegend = () => {
    wrap.style.maxHeight = `${Math.floor((mapHost.getBoundingClientRect().height * LEGEND.MAX_HEIGHT_PERCENT) / 100)}px`;
  };
  new ResizeObserver(fitLegend).observe(mapHost);
  fitLegend();

  // With nothing to list the component would show an empty "No legend" box, so hide it then. activeLayerInfos is a
  // collection the component fills as layers load and switch; reactiveUtils doesn't see it, its change event does.
  const hideWhenEmpty = () => {
    wrap.style.display = legend.activeLayerInfos?.length === 0 ? "none" : "";
  };
  legend.addEventListener("arcgisReady", () => {
    hideWhenEmpty();
    legend.activeLayerInfos?.on("change", hideWhenEmpty);
  });

  // Start in the chosen style. A link without ?style= that opened on a remembered
  // style gets the parameter added, so the address bar matches what's on screen.
  try {
    if (initial.key !== "original") await applyStyle(initial.key);
    if (initial.source === "remembered") writeUrl(initial.key);
  } catch (err) {
    reportFailure(err);
    select("original");
  }
}
