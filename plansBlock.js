import { h } from "./dom.js";
import { PARCEL_PANEL, PLAN, PLANS } from "./config.js";
import { gateBlock } from "./blockGate.js";
import { PLANS_TEXT, blockSummary, buttonLabel, coverageText, fillText, groupPlans } from "./plansLogic.js";
import { serverLocationOf } from "./planRecord.js";
import { opacityControl } from "./opacityControl.js";
import { plansForSubject } from "./plansQuery.js";
import { createLayerStore } from "./plansStore.js";
import { createPlansOnMap } from "./plansOnMap.js";
import { searchSubject, subjectText } from "./searchSubject.js";

// The Plans block in the left panel: it needs a selected feature, from any layer, or a plan shown on the map (the same
// faded header as What's in this parcel, which needs a parcel otherwise) and holds the Georeference plan PDF button; the
// plans for the feature are listed here too, and the plans on the map: the whole block with nothing selected, a
// collapsed section at the bottom otherwise. Its button in the parcel panel's row opens it (beside What's in this parcel for a parcel, alone otherwise).
// The Plans layer's state (plansLayer.js) decides what the block says and whether the button works.
// A parcel is searched and listed exactly as before; any other feature by its shape (plansQuery.plansForSubject).
export function setupPlansBlock(parcel, panel, actions, plans, mapEl) {
  const block = document.getElementById("plans-block");
  const body = document.getElementById("plans-body");
  let onMap = null; // plansOnMap.js, made when a plan is first shown
  const gate = gateBlock({ block, tooltip: document.getElementById("plans-tooltip"), panel, requires: "feature", text: PLANS_TEXT.GATE, alsoOpen: () => (onMap?.count() ?? 0) > 0 });
  const T = PLANS_TEXT;

  const status = h("div", { class: "plan-note", ariaLive: "polite" });
  const georeference = h("calcite-button", { id: "georef-open", width: "full", iconStart: "file-pdf", disabled: true }, "Georeference plan PDF");
  const help = h("div", { class: "plan-note" }, T.HELP_PARCEL);
  const listHost = h("div", { id: "plans-list", class: "here-section" });
  const onMapHost = h("div", { id: "plans-on-map" });
  body.replaceChildren(georeference, status, help, listHost, onMapHost);
  const F = PLANS.FIELDS;
  const ACCURACY = { A: "Class A", B: "Class B", C: "Class C", U: "Class U" };

  let handler = null;
  georeference.addEventListener("click", () => handler?.());

  const render = () => {
    const { status: s, message } = plans.state;
    georeference.disabled = s !== "ready" || !handler;
    status.textContent = s === "unconfigured" ? "The Plans layer isn't configured yet."
      : s === "loading" || s === "idle" ? "Loading the Plans layer…"
      : s === "error" ? `The Plans layer isn't available: ${message}`
      : "";
  };
  plans.onChange(() => { render(); if (plans.state.status === "ready") schedule(); }); // also fires after a save (bump)

  // ---- the subject: the selected feature as the search sees it (searchSubject.js)
  const subjectNow = () => searchSubject(panel.selectedFeature(), { titleFields: PARCEL_PANEL.TITLE_FIELDS });
  let subject = subjectNow();
  // The header says which feature the list is for, when it isn't a parcel (a parcel's block reads as before).
  function renderHeader() {
    block.description = subject && !subject.isParcel ? fillText(T.HEADER, { subject: subjectText(subject) }) : "";
    help.textContent = subject && !subject.isParcel ? T.HELP_FEATURE : T.HELP_PARCEL;
  }

  // ---- the plans for the selected feature
  let data = null, loadError = "", abort = null, timer = 0, showSuperseded = false, editHandler = null, onMapOpen = false;
  const dateText = (ms) => (Number.isFinite(ms) ? new Date(ms).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" }) : "");
  const mapTools = async () => {
    if (!onMap) {
      onMap = await createPlansOnMap({ mapEl, plansLayer: plans.state.layer });
      onMap.onChange(() => {
        gate.sync(); // a plan on the map opens the block with nothing selected; the last one removed closes it again
        renderList();
      });
    }
    return onMap;
  };
  const say = (text) => { loadError = text; renderList(); };

  // Delete a plan: every record of it (a plan in pieces is one plan), in one all-or-nothing request, after asking.
  async function remove(plan) {
    const ids = (plan.pieces?.length ? plan.pieces : [plan]).map((p) => p.objectId);
    const name = plan.attributes[F.NAME] || "this plan";
    const ask = ids.length > 1 ? `Delete the whole plan "${name}" (${ids.length} pieces)? Its ${ids.length} records and their files are removed from the Plans layer.` : `Delete the plan "${name}"? Its record and files are removed from the Plans layer.`;
    if (!window.confirm(ask)) return;
    try {
      if (onMap?.isShown(plan.objectId)) onMap.hide(plan.objectId);
      await (await createLayerStore(plans.state.layer)).edit({ deletes: ids });
      plans.bump();
    } catch (err) {
      console.warn("Couldn't delete the plan:", err);
      say(`Couldn't delete that plan: ${err.message ?? err}`);
    }
  }

  function row(plan, quiet) {
    const a = plan.attributes;
    const pieces = plan.pieceCount > 1 ? `${plan.pieceCount} pieces` : "";
    const meta = [a[F.TYPE], dateText(a[F.DATE]), pieces, ACCURACY[a[F.ACCURACY_CLASS]], plan.detail ?? coverageText(plan.share), a[F.STATUS] === "superseded" ? "superseded" : ""].filter(Boolean).join(" · ");
    const shown = onMap?.isShown(plan.objectId);
    const showBtn = h("calcite-button", { scale: "s", appearance: "transparent", iconStart: shown ? "view-hide" : "view-visible",
      onclick: async () => { try { shown ? onMap.hide(plan.objectId) : await (await mapTools()).show(plan); } catch (err) { console.warn("Couldn't show the plan:", err); say(`Couldn't show that plan: ${err.message ?? err}`); } renderList(); } }, shown ? "Hide" : "Show on map");
    const zoomBtn = h("calcite-button", { scale: "s", appearance: "transparent", iconStart: "zoom-to-object", onclick: async () => { try { await (await mapTools()).zoom(plan); } catch (err) { console.warn(err); } } }, "Zoom");
    const editBtn = h("calcite-button", { scale: "s", appearance: "transparent", iconStart: "pencil", disabled: !plans.state.canEdit || !editHandler, title: plans.state.canEdit ? "" : plans.state.whyNot || "Your account can't change plans in the Plans layer.", onclick: () => editHandler?.(plan) }, "Edit");
    const deleteBtn = plans.state.canDelete ? h("calcite-button", { scale: "s", appearance: "transparent", kind: "danger", iconStart: "trash", onclick: () => remove(plan) }, "Delete") : null;
    const opacity = shown ? planOpacity(onMap.layerOf(plan.objectId)) : null;
    return h("div", { class: `plan-row${quiet ? " quiet" : ""}` }, h("div", { class: "plan-row-name" }, a[F.NAME]), h("div", { class: "plan-note" }, meta), serverPath(a), h("div", { class: "plan-row-actions" }, showBtn, zoomBtn, editBtn, deleteBtn), opacity);
  }

  // Where the full PDF is on the local server, with a Copy path button (a browser won't open a local path from the web
  // page: Chrome and Edge block it). Nothing when the record has none, or the layer doesn't have the field yet.
  function serverPath(a) {
    const path = serverLocationOf(a, F);
    if (!path) return null;
    let timer;
    const copy = h("calcite-button", { scale: "s", appearance: "transparent", iconStart: "copy", label: "Copy the server location",
      onclick: async () => {
        try {
          await navigator.clipboard.writeText(path);
          copy.iconStart = "check";
          copy.textContent = "Copied";
          clearTimeout(timer);
          timer = setTimeout(() => { copy.iconStart = "copy"; copy.textContent = "Copy path"; }, 1500);
        } catch (err) {
          console.warn("Couldn't copy the path:", err);
          say("Couldn't copy the path. Select it and copy it instead.");
        }
      } }, "Copy path");
    return h("div", { class: "plan-row-path" }, h("span", { class: "plan-note", title: path }, path), copy);
  }

  // A shown plan's opacity: 10% steps, reset to PLAN.OPACITY (Hide is the way to 0).
  const planOpacity = (layer, disabled = false) => opacityControl({ label: "Opacity", value: layer.opacity, initial: PLAN.OPACITY, min: 0.1, disabled, onInput: (v) => { layer.opacity = v; } }).el;

  // ---- the plans on the map: show or hide, opacity, zoom, remove from the map, and the server path
  function mapRow({ objectId, plan, layer }) {
    const a = plan.attributes;
    const meta = [a[F.TYPE], dateText(a[F.DATE]), plan.pieceCount > 1 ? `${plan.pieceCount} pieces` : "", ACCURACY[a[F.ACCURACY_CLASS]]].filter(Boolean).join(" · ");
    const visible = layer.visible;
    const toggle = h("calcite-button", { scale: "s", appearance: "transparent", iconStart: visible ? "view-hide" : "view-visible", onclick: () => onMap.setVisible(objectId, !visible) }, visible ? "Hide" : "Show");
    const zoomBtn = h("calcite-button", { scale: "s", appearance: "transparent", iconStart: "zoom-to-object", onclick: () => onMap.zoom(plan).catch((err) => console.warn(err)) }, "Zoom");
    const removeBtn = h("calcite-button", { scale: "s", appearance: "transparent", iconStart: "x", onclick: () => onMap.hide(objectId) }, "Remove from map");
    const opacity = planOpacity(layer, !visible);
    return h("div", { class: "plan-row" }, h("div", { class: "plan-row-name" }, a[F.NAME]), meta ? h("div", { class: "plan-note" }, meta) : null, serverPath(a),
      h("div", { class: "plan-row-actions" }, toggle, zoomBtn, removeBtn), opacity);
  }
  function renderOnMap() {
    const list = onMap?.list() ?? [];
    if (!list.length) { onMapHost.replaceChildren(); return; }
    if (!subject) {
      onMapHost.replaceChildren(h("div", { class: "plans-group-title" }, `${T.ON_MAP} (${list.length})`), ...list.map(mapRow));
      return;
    }
    // with a selection: a collapsed section under the plans for the feature
    const section = h("calcite-block", { heading: `${T.ON_MAP} (${list.length})`, collapsible: true, expanded: onMapOpen, scale: "s",
      oncalciteBlockExpand: (e) => { if (e.target === section) onMapOpen = true; }, oncalciteBlockCollapse: (e) => { if (e.target === section) onMapOpen = false; } }, ...list.map(mapRow));
    onMapHost.replaceChildren(section);
  }

  function renderList() {
    listHost.replaceChildren();
    // with nothing selected the block is the plans on the map (it is only open when there are some)
    georeference.hidden = help.hidden = !subject;
    renderOnMap();
    if (plans.state.status !== "ready" || !subject) return;
    if (loadError) listHost.append(h("div", { class: "plan-note ws-note-bad" }, loadError));
    if (!data) { if (!loadError) listHost.append(h("div", { class: "plan-note" }, "Looking for plans…")); return; }
    const g = groupPlans(data, { min: PLANS.COVER_MIN, F, showSuperseded });
    listHost.append(h("div", { class: "plan-note", id: "plans-summary" }, blockSummary({ on: g.on.length, neighbors: g.neighbors.length }, subject.isParcel ? "parcel" : "feature")));
    if (g.on.length) listHost.append(h("div", { class: "plans-group-title" }, subject.isParcel ? T.ON_PARCEL : T.ON_FEATURE), ...g.on.map((p) => row(p, false)));
    if (g.neighbors.length) listHost.append(h("div", { class: "plans-group-title quiet" }, T.NEIGHBORING), ...g.neighbors.map((p) => row(p, true)));
    if (data.overflow) listHost.append(h("div", { class: "plan-note" }, fillText(T.OVERFLOW, { n: subject.isParcel ? PLANS.LIST_MAX : PLANS.SEARCH.MAX_PLANS })));
    if (data.some((p) => p.attributes[F.STATUS] === "superseded")) {
      listHost.append(h("calcite-label", { layout: "inline", scale: "s" }, h("calcite-switch", { checked: showSuperseded, oncalciteSwitchChange: (e) => { showSuperseded = e.target.checked; renderList(); } }), "Show superseded"));
    }
    parcelButton?.setLabel(buttonLabel(groupPlans(data, { min: PLANS.COVER_MIN, F }).on.length)); // superseded plans never count
  }

  async function refresh() {
    abort?.abort();
    loadError = "";
    const asked = subjectNow();
    if (plans.state.status !== "ready" || !asked) { data = null; parcelButton?.setLabel("Plans"); renderList(); return; }
    const controller = (abort = new AbortController());
    try {
      const list = await plansForSubject({ plansLayer: plans.state.layer, parcelLayer: parcel, subject: asked, signal: controller.signal });
      // a newer selection (paging through hits quickly) owns the list now
      if (controller.signal.aborted || subjectNow()?.key !== asked.key) return;
      data = list;
    } catch (err) {
      if (err?.name === "AbortError" || controller.signal.aborted) return;
      console.warn("Couldn't read the plans for this feature:", err);
      data = null;
      loadError = fillText(T.LOAD_ERROR, { noun: asked.isParcel ? "parcel" : "feature", message: err.message ?? err });
    }
    renderList();
  }
  // The list and the button's count follow the selection, 300 ms after it settles (as What's in this parcel does).
  function schedule() { clearTimeout(timer); timer = setTimeout(refresh, 300); }
  let parcelButton = null;

  // Load the layer when the block opens or a feature is selected (not at app start).
  const load = () => plans.ensure();
  block.addEventListener("calciteBlockExpand", (e) => e.target === block && !gate.gated && load());
  panel.onSelectionChange(() => {
    abort?.abort(); // an older search never lands on the new selection
    subject = subjectNow();
    data = null;
    loadError = "";
    if (subject) load();
    renderHeader();
    renderList();
    schedule();
  });

  parcelButton = actions.addBlockAction({
    id: "parcel-plans-button", label: "Plans", icon: "file-text", block, scope: "feature",
    onOpened: () => georeference.setFocus?.(),
  });

  render();
  renderHeader();
  block.hidden = false;
  return {
    block, list: listHost,
    get subject() { return subject; },
    // The workspace registers itself here; the button stays disabled until it does.
    onGeoreference(cb) {
      handler = cb;
      render();
    },
    // The workspace registers how a plan is reopened for editing.
    onEdit(cb) { editHandler = cb; renderList(); },
  };
}
