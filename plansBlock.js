import { h } from "./dom.js";
import { PLANS } from "./config.js";
import { gateBlock } from "./blockGate.js";
import { blockSummary, buttonLabel, coverageText, groupPlans } from "./plansLogic.js";
import { plansForParcel } from "./plansQuery.js";
import { createPlansOnMap } from "./plansOnMap.js";

// The Plans block in the left panel: it needs a selected parcel (the same faded header as What's in this parcel) and
// holds the Georeference plan PDF button; the plans for the parcel are listed here too. Its button in the parcel
// panel's row opens it. The Plans layer's state (plansLayer.js) decides what the block says and whether the button works.
export function setupPlansBlock(parcel, panel, actions, plans, mapEl, reasons) {
  const block = document.getElementById("plans-block");
  const body = document.getElementById("plans-body");
  const gate = gateBlock({ block, tooltip: document.getElementById("plans-tooltip"), panel });

  const status = h("div", { class: "plan-note", ariaLive: "polite" });
  const georeference = h("calcite-button", { id: "georef-open", width: "full", iconStart: "file-pdf", disabled: true }, "Georeference plan PDF");
  const help = h("div", { class: "plan-note" }, "Open a plan PDF, place it on the map using the parcel corners, check the error and save it as a georeferenced plan.");
  const listHost = h("div", { id: "plans-list", class: "here-section" });
  body.replaceChildren(georeference, status, help, listHost);
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

  // ---- the plans for the selected parcel
  let data = null, loadError = "", abort = null, timer = 0, showSuperseded = false, onMap = null, editHandler = null;
  const dateText = (ms) => (Number.isFinite(ms) ? new Date(ms).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" }) : "");
  const mapTools = async () => {
    if (!onMap) {
      onMap = await createPlansOnMap({ mapEl, plansLayer: plans.state.layer });
      onMap.onChange(() => reasons?.set("plansShown", onMap.count() > 0)); // a shown plan outlines the selection too
    }
    return onMap;
  };
  const say = (text) => { loadError = text; renderList(); };

  function row(plan, quiet) {
    const a = plan.attributes;
    const meta = [a[F.TYPE], dateText(a[F.DATE]), ACCURACY[a[F.ACCURACY_CLASS]], coverageText(plan.share), a[F.STATUS] === "superseded" ? "superseded" : ""].filter(Boolean).join(" · ");
    const shown = onMap?.isShown(plan.objectId);
    const showBtn = h("calcite-button", { scale: "s", appearance: "transparent", iconStart: shown ? "view-hide" : "view-visible",
      onclick: async () => { try { shown ? onMap.hide(plan.objectId) : await (await mapTools()).show(plan); } catch (err) { console.warn("Couldn't show the plan:", err); say(`Couldn't show that plan: ${err.message ?? err}`); } renderList(); } }, shown ? "Hide" : "Show on map");
    const zoomBtn = h("calcite-button", { scale: "s", appearance: "transparent", iconStart: "zoom-to-object", onclick: async () => { try { await (await mapTools()).zoom(plan); } catch (err) { console.warn(err); } } }, "Zoom");
    const editBtn = h("calcite-button", { scale: "s", appearance: "transparent", iconStart: "pencil", disabled: !plans.state.canAdd || !editHandler, title: plans.state.canAdd ? "" : plans.state.whyNot, onclick: () => editHandler?.(plan) }, "Edit");
    const opacity = shown ? h("calcite-slider", { min: 10, max: 100, value: Math.round(onMap.layerOf(plan.objectId).opacity * 100), label: "Plan opacity", oncalciteSliderInput: (e) => { onMap.layerOf(plan.objectId).opacity = e.target.value / 100; } }) : null;
    return h("div", { class: `plan-row${quiet ? " quiet" : ""}` }, h("div", { class: "plan-row-name" }, a[F.NAME]), h("div", { class: "plan-note" }, meta), h("div", { class: "plan-row-actions" }, showBtn, zoomBtn, editBtn), opacity);
  }

  function renderList() {
    listHost.replaceChildren();
    if (plans.state.status !== "ready" || panel.selectedObjectId() === null) return;
    if (loadError) listHost.append(h("div", { class: "plan-note ws-note-bad" }, loadError));
    if (!data) { if (!loadError) listHost.append(h("div", { class: "plan-note" }, "Looking for plans…")); return; }
    const g = groupPlans(data, { min: PLANS.COVER_MIN, F, showSuperseded });
    listHost.append(h("div", { class: "plan-note", id: "plans-summary" }, blockSummary({ on: g.on.length, neighbors: g.neighbors.length })));
    if (g.on.length) listHost.append(h("div", { class: "plans-group-title" }, "On this parcel"), ...g.on.map((p) => row(p, false)));
    if (g.neighbors.length) listHost.append(h("div", { class: "plans-group-title quiet" }, "Neighboring plan found"), ...g.neighbors.map((p) => row(p, true)));
    if (data.overflow) listHost.append(h("div", { class: "plan-note" }, `Only the first ${PLANS.LIST_MAX} plans are listed.`));
    if (data.some((p) => p.attributes[F.STATUS] === "superseded")) {
      listHost.append(h("calcite-label", { layout: "inline", scale: "s" }, h("calcite-switch", { checked: showSuperseded, oncalciteSwitchChange: (e) => { showSuperseded = e.target.checked; renderList(); } }), "Show superseded"));
    }
    parcelButton?.setLabel(buttonLabel(groupPlans(data, { min: PLANS.COVER_MIN, F }).on.length)); // superseded plans never count
  }

  async function refresh() {
    abort?.abort();
    loadError = "";
    const oid = panel.selectedObjectId();
    if (plans.state.status !== "ready" || oid === null) { data = null; parcelButton?.setLabel("Plans"); renderList(); return; }
    const controller = (abort = new AbortController());
    try {
      const list = await plansForParcel({ plansLayer: plans.state.layer, parcelLayer: parcel, objectId: oid, signal: controller.signal });
      if (controller.signal.aborted) return;
      data = list;
    } catch (err) {
      if (err?.name === "AbortError" || controller.signal.aborted) return;
      console.warn("Couldn't read the plans for this parcel:", err);
      data = null;
      loadError = `Couldn't read the plans for this parcel: ${err.message ?? err}`;
    }
    renderList();
  }
  function schedule() { clearTimeout(timer); timer = setTimeout(refresh, 250); }
  let parcelButton = null;

  // Load the layer when the block opens or a parcel is selected (not at app start).
  const load = () => plans.ensure();
  block.addEventListener("calciteBlockExpand", (e) => e.target === block && !gate.gated && load());
  panel.onSelectionChange(() => { data = null; if (panel.selectedObjectId() !== null) load(); renderList(); schedule(); });

  parcelButton = actions.addBlockAction({
    id: "parcel-plans-button", label: "Plans", icon: "file-text", block,
    onOpened: () => georeference.setFocus?.(),
  });

  render();
  block.hidden = false;
  return {
    block, list: listHost,
    // The workspace registers itself here; the button stays disabled until it does.
    onGeoreference(cb) {
      handler = cb;
      render();
    },
    // The workspace registers how a plan is reopened for editing.
    onEdit(cb) { editHandler = cb; renderList(); },
  };
}
