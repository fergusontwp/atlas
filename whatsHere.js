import { LABELS, SEARCH, WHATS_HERE } from "./config.js";
import {
  activeEmphasis, activeItem, hoverAfter, sameItem, buildQueryOptions, countText, emphasisKind, emptyReason, fillSuppressed, hasVisibleOutline, isEligibleLayer, itemLabel,
  lengthText, outlineWidth, lineWidth, percentText, pickMatching, pointOutlineWidth, pointSize, validateRadius,
  buildTree, defaultOnIds, groupIds, groupState, toggleGroup, treeLeaves, visibleInMap,
} from "./whatsHereLogic.js";
import { h } from "./dom.js";
import { buildTable, exportFileName, exportMatrix, searchInfo } from "./tableModel.js";
import { toCsv } from "./csvWriter.js";
import { buildXlsx } from "./xlsxWriter.js";
import { saveFile } from "./download.js";
import { createResultsTable } from "./resultsTable.js";
import { gateBlock } from "./blockGate.js";

const RUN_DELAY_MS = 300;
const fmt = (n) => n.toLocaleString();

// What's in this parcel: features of other layers that intersect the selected parcel, or lie within N feet of it.
//
// Purely spatial: no field of a searched layer is named here. Results look like the source layer, only bolder: each
// searched layer gets a client-side copy of its matches (a "mirror") just above the source layer, with a clone of the
// layer's renderer whose simple symbols are thicker (same colors). While the source layer is drawing its own features
// the copy's polygon fills are transparent, so only a bolder outline is added; when the source is off or out of scale
// the copy shows the full symbol. Nothing is queried again when that changes. Only the classes the results map to
// are kept in the copy's renderer, so the legend lists just those when the copy is the layer's legend entry.
export async function setupWhatsHere(mapEl, parcel, panel, actions) {
  const [GraphicsLayer, FeatureLayer, Graphic, bufferOperator, projectOperator, intersectionOperator, areaOperator, lengthOperator, reactiveUtils] =
    await $arcgis.import([
      "@arcgis/core/layers/GraphicsLayer.js",
      "@arcgis/core/layers/FeatureLayer.js",
      "@arcgis/core/Graphic.js",
      "@arcgis/core/geometry/operators/bufferOperator.js",
      "@arcgis/core/geometry/operators/projectOperator.js",
      "@arcgis/core/geometry/operators/intersectionOperator.js",
      "@arcgis/core/geometry/operators/areaOperator.js",
      "@arcgis/core/geometry/operators/lengthOperator.js",
      "@arcgis/core/core/reactiveUtils.js",
    ]);
  const map = mapEl.map;
  const view = mapEl.view;
  const block = document.getElementById("here-block");
  const body = document.getElementById("here-body");
  const { RADIUS } = WHATS_HERE;

  // Only the dashed "Within" outline is drawn as a graphic. Above the parcels, below the edge-length labels (a plan
  // loaded later goes in just below those).
  const outlineLayer = new GraphicsLayer({ id: "whats-here-outline", title: "What's in this parcel", listMode: "hide" });
  const parcelAt = map.layers.indexOf(parcel);
  const edgeAt = () => map.layers.findIndex((l) => l.id === "edge-lengths");
  map.add(outlineLayer, parcelAt >= 0 ? parcelAt + 1 : edgeAt() >= 0 ? edgeAt() : undefined);

  // The emphasized item (hovered or picked) is drawn in a layer of its own that stays ABOVE every source layer and every
  // result copy (directly below the selection outline, else the edge lengths). It used to live in the outline layer
  // above the parcels, which is below all of them, so the source's own symbol and the copy's bolder outline covered it
  // and hovering a result changed almost nothing on screen. Plans and result copies are inserted just below the edge
  // lengths too, so the position is kept whenever the map's layers change.
  const activeLayer = new GraphicsLayer({ id: "whats-here-active", title: "Emphasized result", listMode: "hide", popupEnabled: false });
  map.add(activeLayer);
  const placeActive = () => {
    const above = map.layers.findIndex((l) => l.id === "selection-outline");
    const ceiling = above >= 0 ? above : edgeAt();
    const at = map.layers.indexOf(activeLayer);
    if (ceiling < 0 || at < 0) return;
    const want = at < ceiling ? ceiling - 1 : ceiling;
    if (at !== want) map.reorder(activeLayer, want);
  };
  map.layers.on("change", placeActive);
  placeActive();

  // ---- state
  const state = {
    mode: "intersects",
    radius: RADIUS.DEFAULT,
    checked: new Set(), // layer ids
    status: "",
    notes: [],
    groups: [], // see searchLayer
    emphasized: null, // { layerId, oid }: the item picked in the list
    parcelId: null, // the searched parcel's ID (SEARCH.ID_FIELD), for the download
    searchedAt: null,
    hovered: null, // { layerId, oid }: the item under the pointer or holding keyboard focus; shown instead of the picked one
  };
  const openGroups = new Set(); // layer ids whose item list is expanded
  const openMapGroups = new Set(); // map group layer ids expanded in the checklist (in memory only; groups start collapsed)
  let tree = []; // the checklist as the map's groups and layers (buildTree)
  let eligible = []; // its layers, in list order
  const knownLayers = new Set();
  let sourceViewGeometry = null; // the parcel, in the view's spatial reference, for Zoom to results
  const srNoted = new Set();

  const checkedLayers = () => eligible.filter((l) => state.checked.has(l.id));

  // ---- controls (built once)
  const viewTableButton = h("calcite-button", { scale: "s", appearance: "outline", iconStart: "table", hidden: true, onclick: () => table.open() }, "View table");
  const statusEl = h("div", { class: "plan-note", ariaLive: "polite" });
  const notesEl = h("div", { class: "plan-note" });
  const layerHost = h("div", { class: "here-layers" });
  const resultsHost = h("div", { class: "here-section" });
  const hintEl = h("div", { class: "plan-note" });
  const radiusMessage = h("div", { class: "plan-note", hidden: true });

  const radiusInput = h("calcite-input-number", {
    scale: "s", value: String(state.radius), suffixText: "ft", label: "Distance in feet", min: 1, max: RADIUS.MAX,
    oncalciteInputNumberInput: (e) => onRadius(e.target.value, false),
    oncalciteInputNumberChange: (e) => onRadius(e.target.value, true),
  });
  const presetRow = h("div", { class: "here-row" },
    ...RADIUS.PRESETS.map((n) =>
      h("calcite-button", { scale: "s", appearance: "outline", onclick: () => { radiusInput.value = String(n); onRadius(n, true); } }, `${fmt(n)} ft`)));
  const withinControls = h("div", { hidden: true }, h("div", { class: "here-row" }, radiusInput), presetRow, radiusMessage);

  const modeControl = h("calcite-segmented-control", {
    scale: "s", width: "full",
    oncalciteSegmentedControlChange: (e) => {
      state.mode = e.target.value;
      renderMode();
      scheduleRun();
    },
  }, h("calcite-segmented-control-item", { value: "intersects", checked: true }, "Intersects"),
     h("calcite-segmented-control-item", { value: "within" }, "Within"));

  body.replaceChildren(
    h("div", { class: "here-row" },
      h("calcite-label", { scale: "s" }, "Layers to search"),
      h("calcite-link", { onclick: () => setAll(true) }, "All"),
      h("calcite-link", { onclick: () => setAll(false) }, "None")),
    layerHost,
    modeControl,
    withinControls,
    hintEl,
    statusEl,
    notesEl,
    h("div", { class: "here-row" },
      h("calcite-button", { scale: "s", appearance: "outline", iconStart: "zoom-to-object", onclick: () => zoomToResults() }, "Zoom to results"),
      viewTableButton,
      h("calcite-button", { scale: "s", appearance: "outline", onclick: () => clearAll() }, "Clear")),
    resultsHost,
  );

  function renderMode() {
    const within = state.mode === "within";
    withinControls.hidden = !within;
    hintEl.textContent = within
      ? "Within the distance of the parcel boundary; anything overlapping the parcel is included."
      : WHATS_HERE.STRICT_TOLERANCE_FT > 0
        ? `Features overlapping the parcel by less than ${WHATS_HERE.STRICT_TOLERANCE_FT} ft are ignored.`
        : "";
  }

  function onRadius(raw, commit) {
    const r = validateRadius(raw, RADIUS);
    radiusMessage.hidden = r.valid && !r.clamped;
    if (!r.valid) {
      radiusMessage.textContent = `Enter a distance in feet (1 to ${fmt(RADIUS.MAX)}); using ${RADIUS.DEFAULT} ft until then.`;
    } else if (r.clamped) {
      radiusMessage.textContent = `The largest distance is ${fmt(RADIUS.MAX)} ft.`;
      if (commit) radiusInput.value = String(r.value);
    }
    state.radius = r.value;
    scheduleRun();
  }

  // ---- the layer checklist: the map's groups (collapsed to start with) and layers, in the Layers list order
  // Checked state is by layer id; a group's box is derived (all, some or none of what is under it) and clicking it checks
  // or unchecks everything under it. The boxes are updated in place, so a click doesn't rebuild the list under the pointer.
  let boxes = []; // [{ node, el }] for every box in the list
  function syncBoxes() {
    for (const { node, el } of boxes) {
      if (node.kind === "layer") {
        el.checked = state.checked.has(node.id);
      } else {
        const st = groupState(node, state.checked);
        el.checked = st === "checked";
        el.indeterminate = st === "indeterminate";
      }
    }
  }
  function nodeRow(node, depth) {
    if (node.kind === "layer") {
      const box = h("calcite-checkbox", { checked: state.checked.has(node.id), label: node.layer.title ?? "Untitled layer", oncalciteCheckboxChange: (e) => toggle(node.id, e.target.checked) });
      boxes.push({ node, el: box });
      return h("calcite-label", { layout: "inline", scale: "s", class: "here-leaf" }, box, node.layer.title ?? "Untitled layer");
    }
    const open = openMapGroups.has(node.id);
    const kids = h("div", { class: "here-group-kids", hidden: !open }, ...node.children.map((c) => nodeRow(c, depth + 1)));
    const chevron = h("calcite-action", {
      scale: "s", compact: true, icon: open ? "chevron-down" : "chevron-right", text: open ? `Collapse ${node.title}` : `Expand ${node.title}`, ariaExpanded: String(open),
      onclick: () => {
        const now = !openMapGroups.has(node.id);
        if (now) openMapGroups.add(node.id);
        else openMapGroups.delete(node.id);
        kids.hidden = !now;
        chevron.icon = now ? "chevron-down" : "chevron-right";
        chevron.text = now ? `Collapse ${node.title}` : `Expand ${node.title}`;
        chevron.ariaExpanded = String(now);
      },
    });
    const box = h("calcite-checkbox", {
      label: node.title,
      oncalciteCheckboxChange: () => { state.checked = toggleGroup(node, state.checked); syncBoxes(); scheduleRun(); },
    });
    boxes.push({ node, el: box });
    return h("div", { class: "here-group" },
      h("div", { class: "here-group-head" }, chevron, h("calcite-label", { layout: "inline", scale: "s" }, box, node.title)),
      kids);
  }
  function renderLayers() {
    boxes = [];
    if (eligible.length === 0) {
      layerHost.replaceChildren(h("div", { class: "plan-note" }, "No other layers in this map can be searched."));
      return;
    }
    layerHost.replaceChildren(...tree.map((n) => nodeRow(n, 0)));
    syncBoxes();
  }
  function toggle(id, on) {
    if (on) state.checked.add(id);
    else state.checked.delete(id);
    syncBoxes(); // the groups above it
    scheduleRun();
  }
  function setAll(on) {
    state.checked = on ? new Set(eligible.map((l) => l.id)) : new Set();
    syncBoxes();
    scheduleRun();
  }

  // Eligible: a queryable feature layer shown in the layer list that isn't the parcel layer, found through the map's
  // groups. Rebuilt when layers or groups are added, removed or renamed; choices and expanded groups are kept by id.
  let defaultsChecked = false;
  function rebuildLayers() {
    tree = buildTree(map.layers, parcel, WHATS_HERE.EXCLUDE_TITLES);
    eligible = treeLeaves(tree);
    const onByDefault = defaultOnIds(tree, WHATS_HERE.DEFAULT_ON_TITLES);
    for (const layer of eligible) {
      if (knownLayers.has(layer.id)) continue;
      knownLayers.add(layer.id);
      if (onByDefault.has(layer.id)) state.checked.add(layer.id);
    }
    if (!defaultsChecked) {
      defaultsChecked = true;
      const titles = new Set([...eligible.map((l) => l.title), ...map.allLayers.filter((l) => l.type === "group").map((g) => g.title)]);
      for (const title of WHATS_HERE.DEFAULT_ON_TITLES) {
        if (!titles.has(title)) console.warn(`WHATS_HERE.DEFAULT_ON_TITLES: no searchable layer or group titled "${title}"`);
      }
    }
    for (const id of [...state.checked]) if (!eligible.some((l) => l.id === id)) state.checked.delete(id);
    const live = new Set(groupIds(tree));
    for (const id of [...openMapGroups]) if (!live.has(id)) openMapGroups.delete(id);
    renderLayers();
    watchGroups();
    scheduleRun();
  }

  // A group's own layer collection isn't seen by reactiveUtils, so its change event is listened to directly (and again
  // after each rebuild, since groups come and go).
  let groupHandles = [];
  function watchGroups() {
    groupHandles.forEach((hnd) => hnd.remove());
    groupHandles = map.allLayers.filter((l) => l.type === "group").toArray().map((g) => g.layers.on("change", () => rebuildLayers()));
  }

  // ---- showing results: a mirror layer, always
  const EMPHASIS = WHATS_HERE.EMPHASIS;
  const ACTIVE = activeEmphasis(EMPHASIS);
  // A layer inside a group has its view inside the group's layer view, not in view.layerViews.
  const findView = (views, layer) => {
    for (const lv of views) {
      if (lv.layer === layer) return lv;
      const inner = lv.layerViews ? findView(lv.layerViews.toArray(), layer) : null;
      if (inner) return inner;
    }
    return null;
  };
  const viewFor = (layer) => findView(view.layerViews.toArray(), layer);
  const warned = new Set();
  const warnOnce = (key, message, err) => {
    if (warned.has(key)) return;
    warned.add(key);
    console.warn(message, err ?? "");
  };

  // Is the source layer drawing its own features? (On, and in its scale range: a switched-off or out-of-scale
  // layer's view is suspended, and a layer without a view draws nothing.)
  const sourceDrawn = (layer) => {
    const lv = viewFor(layer);
    return fillSuppressed({ sourceVisible: visibleInMap(layer, map), suspended: !lv || lv.suspended });
  };

  // A layer inside a group layer isn't in map.layers itself; its top-level ancestor is.
  const topLevel = (layer) => {
    let top = layer;
    while (top.parent && top.parent !== map) top = top.parent;
    return top;
  };

  // A clone of the source layer's renderer (simple, unique-value, class-breaks, Arcade-driven: whatever it has).
  // If it can't be cloned, fall back to the renderer's default (or first class) symbol and say so once.
  function cloneRenderer(layer) {
    try {
      return layer.renderer.clone();
    } catch (err) {
      warnOnce(`clone:${layer.id}`, `What's in this parcel: couldn't copy the renderer of "${layer.title}"; its results use a default symbol.`, err);
      const r = layer.renderer;
      const symbol = r?.symbol ?? r?.defaultSymbol ?? r?.uniqueValueInfos?.[0]?.symbol ?? r?.classBreakInfos?.[0]?.symbol;
      return symbol ? { type: "simple", symbol: symbol.clone() } : undefined;
    }
  }

  // A bolder copy of a symbol with the same colors and alpha. Fill symbols get a thicker outline (one in the fill color
  // if they have none) and, when noFill, a fully transparent fill; lines get wider and markers bigger. Symbols that can't
  // be made bolder safely (CIM, picture, text, 3D) come back unchanged, with one warning per layer.
  function boldSymbol(symbol, E, noFill, layer) {
    const kind = emphasisKind(symbol?.type);
    if (!kind) {
      if (symbol) warnOnce(`symbol:${layer.id}:${symbol.type}`, `What's in this parcel: "${layer.title}" has ${symbol.type} symbols, which can't be made bolder; its results use them as they are.`);
      return symbol;
    }
    const s = symbol.clone();
    if (kind === "polygon") {
      const o = s.outline;
      if (hasVisibleOutline({ present: !!o, width: o?.width, style: o?.style })) o.width = outlineWidth(o.width, E);
      else if (s.color) s.outline = { color: [s.color.r, s.color.g, s.color.b, 1], width: outlineWidth(0, E) }; // in the fill color
      if (noFill && s.color) s.color.a = 0;
    } else if (kind === "line") {
      s.width = lineWidth(s.width, E);
    } else {
      s.size = pointSize(s.size, E);
      if (s.outline) s.outline.width = pointOutlineWidth(s.outline.width, E);
    }
    return s;
  }

  // Replace every symbol of a (cloned) renderer with fn(symbol). False for renderer types it doesn't know.
  function mapSymbols(renderer, fn) {
    const swap = (holder) => {
      if (holder.symbol) holder.symbol = fn(holder.symbol);
    };
    const swapDefault = () => {
      if (renderer.defaultSymbol) renderer.defaultSymbol = fn(renderer.defaultSymbol);
    };
    if (renderer.type === "simple") swap(renderer);
    else if (renderer.type === "unique-value") {
      swapDefault();
      // The flat infos and the groups share their symbols, so only one of them is touched (twice would double it).
      if (renderer.uniqueValueGroups?.length) renderer.uniqueValueGroups.forEach((g) => g.classes.forEach(swap));
      else renderer.uniqueValueInfos?.forEach(swap);
    } else if (renderer.type === "class-breaks") {
      swapDefault();
      renderer.classBreakInfos?.forEach(swap);
    } else return false;
    return true;
  }

  // The renderer of the copy for the current state of the source layer.
  function emphasizedRenderer(group, noFill) {
    if (!group.pruned) return undefined; // a layer without a renderer draws its default symbol
    const renderer = group.pruned.clone();
    if (!mapSymbols(renderer, (symbol) => boldSymbol(symbol, EMPHASIS, noFill, group.layer))) {
      warnOnce(`renderer:${group.layer.id}`, `What's in this parcel: "${group.title}" uses a ${renderer.type} renderer, which can't be made bolder; its results use it as it is.`);
    }
    return renderer;
  }

  // Keep only the classes at least one result maps to, by the renderer's own classification of each result feature;
  // the default symbol stays only if some feature falls to it. Simple renderers stay as they are. A renderer type or a
  // lookup that fails keeps the full renderer, with one warning per layer.
  async function pruneRenderer(group) {
    if (!group.base) return null;
    const renderer = group.base.clone();
    try {
      if (renderer.type === "unique-value") {
        const matched = new Set();
        let usesDefault = false;
        for (const feature of group.features) {
          const info = await renderer.getUniqueValueInfo(feature); // undefined means the default class
          if (info) matched.add(String(info.value));
          else usesDefault = true;
        }
        if (renderer.uniqueValueGroups?.length) {
          renderer.uniqueValueGroups = renderer.uniqueValueGroups
            .map((g) => ({
              heading: g.heading,
              classes: pickMatching(g.classes, (c) => c.values.map((v) => v.value), matched)
                .map((c) => ({ label: c.label, symbol: c.symbol?.clone(), values: c.values.map((v) => ({ value: v.value })) })),
            }))
            .filter((g) => g.classes.length);
        } else {
          renderer.uniqueValueInfos = pickMatching(renderer.uniqueValueInfos, (i) => [i.value], matched)
            .map((i) => ({ value: i.value, label: i.label, description: i.description, symbol: i.symbol?.clone() }));
        }
        if (!usesDefault) renderer.defaultSymbol = null;
      } else if (renderer.type === "class-breaks") {
        const matched = new Set();
        let usesDefault = false;
        const key = (i) => `${i.minValue}|${i.maxValue}`;
        for (const feature of group.features) {
          const info = await renderer.getClassBreakInfo(feature);
          if (info) matched.add(key(info));
          else usesDefault = true;
        }
        renderer.classBreakInfos = pickMatching(renderer.classBreakInfos, (i) => [key(i)], matched)
          .map((i) => ({ minValue: i.minValue, maxValue: i.maxValue, label: i.label, description: i.description, symbol: i.symbol?.clone() }));
        if (!usesDefault) renderer.defaultSymbol = null;
      } else if (renderer.type !== "simple") {
        warnOnce(`prune:${group.layer.id}`, `What's in this parcel: the legend entry for "${group.title}" lists every class, because a ${renderer.type} renderer can't be narrowed to the results.`);
      }
    } catch (err) {
      warnOnce(`prune:${group.layer.id}`, `What's in this parcel: couldn't narrow the legend entry for "${group.title}" to the results; it lists every class.`, err);
      return group.base.clone();
    }
    return renderer;
  }

  // The mirror: the matches as a client-side layer just above the source (so draw order and legend order match). No
  // scale range, so it shows when the source is off or out of scale; no pop-up, so clicks still reach the parcel.
  function mirrorProps(group) {
    const drawn = sourceDrawn(group.layer);
    return {
      renderer: emphasizedRenderer(group, drawn),
      // One legend entry per layer: the source's own while it is drawing, the copy's (pruned) one when it isn't.
      legendEnabled: !drawn && group.layer.legendEnabled,
      mode: drawn ? "overlay" : "full",
    };
  }

  function addMirror(group) {
    const { layer } = group;
    const { renderer, legendEnabled, mode } = mirrorProps(group);
    group.mirror = new FeatureLayer({
      id: `whats-here-mirror-${layer.id}`,
      title: layer.title,
      source: group.features.filter((f) => f.geometry).map((f) => new Graphic({ geometry: f.geometry, attributes: { ...f.attributes } })),
      fields: layer.fields.map((f) => f.clone()),
      objectIdField: layer.objectIdField,
      geometryType: layer.geometryType,
      spatialReference: view.spatialReference,
      renderer,
      opacity: layer.opacity,
      legendEnabled,
      listMode: "hide",
      popupEnabled: false,
    });
    group.mode = mode;
    const at = map.layers.indexOf(topLevel(layer));
    map.add(group.mirror, at >= 0 ? at + 1 : edgeAt() >= 0 ? edgeAt() : undefined);
  }

  function removeMirror(group) {
    if (!group.mirror) return;
    map.remove(group.mirror);
    group.mirror.destroy();
    group.mirror = null;
  }

  // The source layer was switched or went in or out of scale: change how the copy draws, from what's in memory.
  function syncMirror(group) {
    if (!group.mirror) return;
    const { renderer, legendEnabled, mode } = mirrorProps(group);
    group.mirror.renderer = renderer;
    group.mirror.legendEnabled = legendEnabled;
    group.mode = mode;
    refreshActive({ force: true });
  }

  async function startGroup(group) {
    const token = group.token;
    group.pruned = await pruneRenderer(group);
    if (token !== group.token) return; // cleared or replaced while the classes were being worked out
    addMirror(group);
    group.watcher = reactiveUtils.watch(
      () => {
        const lv = viewFor(group.layer);
        return `${visibleInMap(group.layer, map)}|${!!lv}|${lv?.suspended}`;
      },
      () => syncMirror(group),
    );
  }

  function stopGroup(group) {
    group.token++;
    group.watcher?.remove();
    group.watcher = null;
    removeMirror(group);
  }

  // The item picked in the list: one extra graphic drawn from that feature's own symbol, bolder still (ACTIVE_FACTOR).
  let activeGraphic = null;
  let activeToken = 0;
  async function symbolOf(group, feature) {
    const r = group.base;
    if (!r) return null;
    try {
      if (r.type === "unique-value") return (await r.getUniqueValueInfo(feature))?.symbol ?? r.defaultSymbol;
      if (r.type === "class-breaks") return (await r.getClassBreakInfo(feature))?.symbol ?? r.defaultSymbol;
      return r.symbol ?? r.defaultSymbol;
    } catch {
      return null;
    }
  }
  // Which feature the emphasis graphic shows: the hovered item, else the picked one (activeItem). `drawn` is what the graphic
  // on the map is for, so an event that doesn't change it (hovering the item that is already picked) does nothing; `force`
  // redraws it anyway (the source layer started or stopped drawing, so the fill suppression changed). The new graphic
  // replaces the old one in one step, and a newer call makes an older one still working out its symbol give up, so quickly
  // moving between items never leaves a stale graphic. Nothing here queries or moves the map.
  let drawn = null;
  async function refreshActive({ force = false } = {}) {
    const target = activeItem({ hover: state.hovered, picked: state.emphasized });
    if (!force && sameItem(target, drawn) && !!activeGraphic === !!target) return;
    const token = ++activeToken;
    drawn = target;
    const group = target && state.groups.find((g) => g.layerId === target.layerId);
    const feature = group?.features.find((f) => f.attributes[group.layer.objectIdField] === target.oid);
    if (!feature?.geometry) {
      removeActiveGraphic();
      return;
    }
    const symbol = await symbolOf(group, feature);
    if (token !== activeToken) return;
    removeActiveGraphic();
    if (!symbol) return;
    activeGraphic = new Graphic({ geometry: feature.geometry, symbol: boldSymbol(symbol, ACTIVE, sourceDrawn(group.layer), group.layer) });
    activeLayer.add(activeGraphic);
  }
  function removeActiveGraphic() {
    if (activeGraphic) activeLayer.remove(activeGraphic);
    activeGraphic = null;
  }

  // Pointer enter and keyboard focus on a result item emphasize it, leave and blur put the picked item back.
  function hover(event, item) {
    const next = hoverAfter(state.hovered, event, item);
    if (sameItem(next, state.hovered) || (!next && !state.hovered)) return;
    state.hovered = next;
    refreshActive();
  }

  // Nothing of the current results is left on the map: no mirror layers, watchers, extra graphic or outline.
  function clearDrawn() {
    state.groups.forEach(stopGroup);
    state.groups = [];
    activeToken++;
    activeGraphic = null;
    drawn = null;
    outlineLayer.graphics.removeAll();
    activeLayer.graphics.removeAll();
    table.close(false); // its rows are gone: Clear, collapse, deselect, a hidden parcel layer or a new result set
    sourceViewGeometry = null;
    state.emphasized = null;
    state.hovered = null;
  }

  function clearAll() {
    sequence++;
    inflight?.abort();
    clearTimeout(timer);
    clearDrawn();
    state.notes = [];
    renderResults();
    setStatusText("");
  }

  function setStatusText(text) {
    state.status = text;
    statusEl.textContent = text;
    notesEl.replaceChildren(...state.notes.map((n) => h("div", {}, n)));
  }

  // ---- results table (resultsTable.js): the features already in memory, all fields, one tab per layer with results
  const plainField = (f) => ({
    name: f.name, alias: f.alias, type: f.type,
    domain: f.domain ? { type: f.domain.type, codedValues: f.domain.codedValues?.map((c) => ({ code: c.code, name: c.name })) } : null,
  });
  const tablesNow = () => state.groups.map((g) => buildTable({
    layerId: g.layerId, title: g.title, error: g.error, overflow: g.overflow,
    fields: g.layer.fields?.map(plainField) ?? [], objectIdField: g.layer.objectIdField,
    rows: g.features.map((f) => f.attributes),
    timeZoneOf: (name) => g.layer.fieldsIndex?.getTimeZone?.(name),
  }, { hideFields: WHATS_HERE.TABLE.HIDE_FIELDS })).filter(Boolean);
  // A row does what its item in the results list does: zoom to the feature and make it the picked item (and close).
  const table = createResultsTable({
    host: document.getElementById("map-host"), trigger: viewTableButton, getTables: tablesNow,
    onPick: (layerId, oid) => { table.close(); emphasize(layerId, oid); },
    onDownload: (kind) => download(kind),
  });

  // The Download menu. Same columns (and HIDE_FIELDS) as the table and the rows in each tab's current sort order, from the
  // features in memory (no query). CSV is the active tab; Excel is every layer with results, after a "Search info" sheet.
  function download(kind) {
    const shown = table.shown();
    if (!shown) return;
    try {
      const header = WHATS_HERE.TABLE.EXPORT_HEADER;
      const date = new Date();
      const parcelId = state.parcelId ?? "";
      if (kind === "csv") {
        const m = exportMatrix(shown.table, shown.order, { header });
        saveFile(toCsv(m.header, m.rows), exportFileName({ parcelId, layerTitle: shown.table.title, date, ext: "csv" }), "text/csv;charset=utf-8");
      } else {
        const info = searchInfo({
          parcelId, mode: state.mode, radius: state.radius, when: state.searchedAt ?? date, max: WHATS_HERE.MAX_FEATURES_PER_LAYER,
          layers: state.groups.map((g) => ({ title: g.title, count: g.count, overflow: g.overflow, error: g.error })),
        });
        const sheets = [{ name: "Search info", ...info }, ...shown.all.map((t) => ({ name: t.title, ...exportMatrix(t, shown.orderOf(t), { header }) }))];
        saveFile(buildXlsx(sheets, { date }), exportFileName({ parcelId, date, ext: "xlsx" }), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      }
    } catch (err) {
      console.warn("Couldn't make the download:", err);
      setStatusText(`Couldn't make the download: ${err?.message ?? err}`);
    }
  }

  // ---- results list
  function renderResults() {
    // The items under the pointer are about to be replaced and a replaced element sends no leave or blur, so drop the hover.
    if (state.hovered) {
      state.hovered = null;
      refreshActive();
    }
    viewTableButton.hidden = !state.groups.some((g) => !g.error && g.features.length > 0);
    resultsHost.replaceChildren(...state.groups.map((group) => {
      const open = openGroups.has(group.layerId);
      const head = h("button", { class: "here-group-head", type: "button", ariaExpanded: String(open), onclick: () => { open ? openGroups.delete(group.layerId) : openGroups.add(group.layerId); renderResults(); } },
        h("span", {}, group.title),
        h("span", { class: "here-group-count" }, group.error ? "Couldn't search" : [countText({ count: group.count, overflow: group.overflow, max: WHATS_HERE.MAX_FEATURES_PER_LAYER }), group.total].filter(Boolean).join(" · ")));
      const children = [head];
      if (group.error) children.push(h("div", { class: "here-error" }, group.error));
      if (open && !group.error && group.items.length) {
        const shown = group.items.slice(0, WHATS_HERE.MAX_LISTED_ITEMS);
        children.push(h("div", { class: "here-items" },
          ...shown.map((item) =>
            h("button", { class: `here-item${state.emphasized?.layerId === group.layerId && state.emphasized.oid === item.oid ? " emphasized" : ""}`, type: "button", onclick: () => emphasize(group.layerId, item.oid),
              onpointerenter: () => hover("enter", { layerId: group.layerId, oid: item.oid }), onpointerleave: () => hover("leave", { layerId: group.layerId, oid: item.oid }),
              onfocus: () => hover("enter", { layerId: group.layerId, oid: item.oid }), onblur: () => hover("leave", { layerId: group.layerId, oid: item.oid }) },
              h("span", {}, item.label), h("small", {}, item.amount ? `${item.amount} · ID ${item.oid}` : `ID ${item.oid}`))),
          group.items.length > shown.length ? h("div", { class: "plan-note" }, `Showing the first ${shown.length} of ${fmt(group.items.length)}.`) : null));
      }
      return h("div", { class: "here-group" }, ...children);
    }));
  }

  // Zoom to one result and give it the stronger emphasis until another is picked or the results are cleared.
  async function emphasize(layerId, oid) {
    const group = state.groups.find((g) => g.layerId === layerId);
    if (!group) return;
    state.emphasized = { layerId, oid };
    refreshActive();
    renderResults();
    const geometry = group.features.find((f) => f.attributes[group.layer.objectIdField] === oid)?.geometry;
    if (!geometry) return;
    try {
      await mapEl.goTo(geometry.type === "point" ? { target: geometry, scale: Math.min(view.scale, 1000) } : geometry.extent.clone().expand(1.5));
    } catch (err) {
      if (err?.name !== "AbortError") console.warn("Couldn't zoom to the feature:", err);
    }
  }

  async function zoomToResults() {
    let extent = sourceViewGeometry ? sourceViewGeometry.extent.clone() : null;
    for (const group of state.groups) {
      for (const feature of group.features) {
        if (feature.geometry) extent = extent ? extent.union(feature.geometry.extent) : feature.geometry.extent.clone();
      }
    }
    if (!extent) return;
    try {
      await mapEl.goTo(extent.clone().expand(1.3));
    } catch (err) {
      if (err?.name !== "AbortError") console.warn("Couldn't zoom to the results:", err);
    }
  }

  // ---- searching
  let sequence = 0; // only the latest run may touch the UI or the map
  let inflight = null;
  let timer;

  function scheduleRun() {
    clearTimeout(timer);
    timer = setTimeout(() => execute(), RUN_DELAY_MS);
  }

  function noteSpatialReference(layer) {
    if (srNoted.has(layer.id)) return;
    srNoted.add(layer.id);
    const sr = layer.spatialReference;
    if (sr && parcel.spatialReference && !sr.equals(parcel.spatialReference)) {
      console.info(`What's in this parcel: "${layer.title}" uses ${sr.wkid ?? "a custom spatial reference"} but the parcel layer uses ${parcel.spatialReference.wkid}. The service reprojects, so small offsets are possible.`);
    }
  }

  // One layer. Never throws: a failure becomes that layer's own error row. The group keeps the matched features
  // (full geometry in the view's spatial reference, all attributes) so results can switch between native and mirror
  // without a new query.
  async function searchLayer(layer, geometry, options, signal, bufferedFor) {
    const group = {
      layerId: layer.id, layer, kind: layer.geometryType, title: layer.title ?? "Untitled layer",
      count: 0, overflow: false, error: null, items: [], total: null, features: [], oids: [],
      mode: null, base: null, pruned: null, mirror: null, watcher: null, token: 0,
    };
    try {
      await layer.load();
      group.base = cloneRenderer(layer);
      noteSpatialReference(layer);
      const max = WHATS_HERE.MAX_FEATURES_PER_LAYER;
      const query = {
        spatialRelationship: options.spatialRelationship,
        returnGeometry: true,
        outSpatialReference: view.spatialReference,
        outFields: ["*"], // renderers that use fields or Arcade need them; the result set is capped, so it's small
        num: max + 1, // one extra, to know there are more
      };
      if (options.distance && layer.capabilities?.query?.supportsDistance !== false) {
        Object.assign(query, { geometry, distance: options.distance, units: options.units });
      } else if (options.distance) {
        query.geometry = bufferedFor(); // the service can't buffer the query: use a buffer made here
      } else {
        query.geometry = geometry;
      }
      const result = await layer.queryFeatures(query, { signal });
      const features = result.features;
      group.overflow = features.length > max;
      const kept = features.slice(0, max);
      group.count = kept.length;
      group.features = kept;
      kept.forEach((feature, i) => {
        const oid = feature.attributes[layer.objectIdField];
        const display = layer.displayField ? feature.attributes[layer.displayField] : undefined;
        group.oids.push(oid);
        group.items.push({ oid, label: itemLabel({ title: group.title, displayValue: display, n: i + 1 }) });
      });
    } catch (err) {
      if (err?.name === "AbortError") throw err;
      console.warn(`What's in this parcel: couldn't search "${layer.title}":`, err);
      group.error = err?.message ?? String(err);
    }
    return group;
  }

  // Intersects mode only: how much of each polygon or line lies inside the parcel. The matched features are fetched
  // again in the parcel's own (projected) spatial reference, since the copies kept for drawing are in the view's
  // (Web Mercator, which isn't a measuring surface). Planar, so approximate; points are just counted. A failure here only means no
  // amounts for that layer.
  async function addAmounts(group, parcelGeometry, signal) {
    if (group.error || group.items.length === 0 || (group.kind !== "polygon" && group.kind !== "polyline")) return;
    try {
      const { layer } = group;
      const { features } = await layer.queryFeatures(
        { objectIds: group.items.map((i) => i.oid), returnGeometry: true, outFields: [layer.objectIdField], outSpatialReference: parcel.spatialReference }, { signal });
      const byOid = new Map(features.map((f) => [f.attributes[layer.objectIdField], f.geometry]));
      const parcelArea = group.kind === "polygon" ? areaOperator.execute(parcelGeometry, { unit: "square-meters" }) : 0;
      let totalFeet = 0;
      for (const item of group.items) {
        const geometry = byOid.get(item.oid);
        if (!geometry) continue;
        const inside = intersectionOperator.execute(geometry, parcelGeometry);
        if (group.kind === "polygon") {
          item.amount = `${percentText((inside ? areaOperator.execute(inside, { unit: "square-meters" }) : 0) / parcelArea)} of parcel`;
        } else {
          const feet = inside ? lengthOperator.execute(inside, { unit: LABELS.EDGES.UNIT }) : 0;
          totalFeet += feet;
          item.amount = `${lengthText(feet)} inside`;
        }
      }
      if (group.kind === "polyline") group.total = `${lengthText(totalFeet)} inside`;
    } catch (err) {
      if (err?.name === "AbortError") throw err;
      console.warn(`What's in this parcel: couldn't work out amounts for "${group.title}":`, err);
    }
  }

  async function execute({ force = false } = {}) {
    const request = ++sequence;
    inflight?.abort();
    const oid = panel.selectedObjectId();
    const layers = checkedLayers();
    const reason = emptyReason({ expanded: force || block.expanded, parcelSelected: oid !== null, checkedCount: layers.length });
    if (reason) {
      clearDrawn();
      state.notes = [];
      renderResults();
      setStatusText(reason === "no-parcel" ? "Select a parcel to begin." : reason === "no-layers" ? "Choose layers to search." : "");
      return;
    }

    const controller = (inflight = new AbortController());
    const { signal } = controller;
    const stale = () => request !== sequence;
    setStatusText("Searching…");
    try {
      // The parcel itself, at full precision in its layer's own spatial reference.
      const idField = parcel.fields?.some((f) => f.name === SEARCH.ID_FIELD) ? [SEARCH.ID_FIELD] : [];
      const { features } = await parcel.queryFeatures(
        { objectIds: [oid], returnGeometry: true, outFields: idField, outSpatialReference: parcel.spatialReference }, { signal });
      if (stale()) return;
      const parcelGeometry = features[0]?.geometry;
      if (!parcelGeometry) {
        clearDrawn();
        renderResults();
        setStatusText("That parcel is no longer available.");
        return;
      }

      const options = buildQueryOptions({ mode: state.mode, radius: state.radius }, WHATS_HERE);
      const notes = [];
      let searchGeometry = parcelGeometry;
      if (options.shrinkMeters > 0) {
        try {
          const shrunk = bufferOperator.execute(parcelGeometry, -options.shrinkMeters, { unit: "meters" });
          if (shrunk && shrunk.extent) searchGeometry = shrunk;
          else notes.push("The parcel is too small for the overlap tolerance, so its full outline was used.");
        } catch (err) {
          console.warn("Couldn't shrink the parcel for the overlap tolerance; using its full outline:", err);
          notes.push("The overlap tolerance couldn't be applied, so the parcel's full outline was used.");
        }
      }
      // Only built if some layer's service can't buffer the query itself (and for the dashed outline).
      let buffered;
      const bufferedFor = () => (buffered ??= bufferOperator.execute(parcelGeometry, options.distance, { unit: options.units }));

      const groups = await Promise.all(layers.map((layer) => searchLayer(layer, searchGeometry, options, signal, bufferedFor)));
      if (stale()) return;
      if (state.mode === "intersects") {
        if (parcel.spatialReference?.isGeographic) {
          notes.push("Amounts need a projected coordinate system, so none are shown.");
        } else {
          await Promise.all(groups.map((group) => addAmounts(group, parcelGeometry, signal)));
          if (stale()) return;
          if (groups.some((g) => g.items.some((i) => i.amount))) notes.push("Amounts are approximate: planar, from the map geometry.");
        }
      }

      // Swap the old results for the new only now, so a stale run never leaves anything behind.
      if (!projectOperator.isLoaded()) await projectOperator.load();
      if (stale()) return;
      const toView = (g) => (g && !g.spatialReference.equals(view.spatialReference) ? projectOperator.execute(g, view.spatialReference) : g);
      clearDrawn();
      sourceViewGeometry = toView(parcelGeometry);
      state.groups = groups;
      state.parcelId = features[0]?.attributes?.[SEARCH.ID_FIELD] ?? panel.selectedValue(SEARCH.ID_FIELD) ?? null; // for the download's name and info sheet
      state.searchedAt = new Date();
      for (const group of groups) if (!group.error && group.oids.length) startGroup(group);
      if (state.mode === "within") {
        try {
          const outline = toView(bufferedFor());
          const { COLOR, WIDTH } = WHATS_HERE.DISTANCE_OUTLINE;
          if (outline) outlineLayer.add(new Graphic({ geometry: outline, symbol: { type: "simple-fill", color: [0, 0, 0, 0], outline: { color: COLOR, width: WIDTH, style: "dash" } } }));
        } catch (err) {
          console.warn("Couldn't draw the search distance:", err);
        }
      }

      state.notes = notes;
      renderResults();
      const found = groups.reduce((sum, g) => sum + g.count, 0);
      const failed = groups.filter((g) => g.error).length;
      setStatusText(`Searched ${layers.length} layer${layers.length === 1 ? "" : "s"}: ${found === 0 ? "nothing found" : `${fmt(found)} feature${found === 1 ? "" : "s"} found`}${failed ? `; ${failed} couldn't be searched` : ""}.`);
    } catch (err) {
      if (err?.name === "AbortError" || stale()) return;
      console.warn("What's in this parcel failed:", err);
      clearDrawn();
      renderResults();
      setStatusText(`Couldn't search: ${err?.message ?? err}`);
    }
  }

  // ---- entry point
  // The button at the top of the parcel panel (only while a parcel is selected) opens and closes this block. With no
  // parcel selected the block's header is faded and can't be opened (blockGate.js); it keeps hover, so its tooltip says why.
  const gate = gateBlock({ block, tooltip: document.getElementById("here-tooltip"), panel });
  actions.addBlockAction({
    id: "parcel-here-button", label: "What's in this parcel", shortLabel: "What's here", icon: "layers", block,
    // Once the others have folded away: put the cursor in the layer checklist.
    onOpened: () => layerHost.querySelector("calcite-checkbox")?.setFocus?.(),
  });

  // ---- wiring
  block.addEventListener("calciteBlockExpand", (e) => {
    if (e.target !== block || gate.gated) return;
    scheduleRun();
  });
  block.addEventListener("calciteBlockCollapse", (e) => {
    if (e.target !== block) return;
    clearAll(); // also when another block opens
  });
  panel.onSelectionChange(() => {
    scheduleRun(); // a click, a search, ?parcel=, a cleared selection or a hidden parcel layer
  });
  reactiveUtils.watch(
    // Only layers that could be listed, so adding or removing a mirror layer or an overlay never rebuilds the list.
    () => map.allLayers.toArray().filter((l) => l.type === "group" || isEligibleLayer(l, parcel, WHATS_HERE.EXCLUDE_TITLES)).map((l) => [l.id, l.title, l.listMode].join("|")).join("§"),
    rebuildLayers,
    { initial: true },
  );

  renderMode();
  block.hidden = false;

  return {
    run: () => execute({ force: true }),
    clear: clearAll,
    zoomToResults,
    emphasize,
    table,
    layer: outlineLayer,
    activeLayer,
    get state() {
      return {
        mode: state.mode,
        radius: state.radius,
        expanded: !!block.expanded,
        checked: eligible.filter((l) => state.checked.has(l.id)).map((l) => l.title),
        status: state.status,
        notes: [...state.notes],
        emphasized: state.emphasized ? `${state.emphasized.layerId}:${state.emphasized.oid}` : null,
        hovered: state.hovered ? `${state.hovered.layerId}:${state.hovered.oid}` : null,
        outline: outlineLayer.graphics.length,
        active: activeLayer.graphics.length,
        mirrors: map.allLayers.filter((l) => l.id.startsWith("whats-here-mirror-")).length,
        watchers: state.groups.filter((g) => g.watcher).length,
        groups: state.groups.map((g) => ({ layerId: g.layerId, title: g.title, mode: g.mode, count: g.count, overflow: g.overflow, error: g.error, total: g.total, items: g.items.map((i) => ({ ...i })) })),
      };
    },
  };
}
