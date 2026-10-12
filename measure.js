import { MEASURE } from "./config.js";

// Measure section: length or area with the SDK's own measurement components (on-map drawing, live readout,
// unit dropdown). One tool at a time. Parcel selection is switched off while a measurement is in progress.
export function setupMeasure(mapEl, panel) {
  const block = document.getElementById("measure-block");
  const toolPicker = document.getElementById("measure-tool");
  const host = document.getElementById("measure-host");

  function make(tag, unit, unitOptions) {
    const el = document.createElement(tag);
    el.referenceElement = mapEl;
    el.unitOptions = unitOptions;
    el.unit = unit;
    el.autoDestroyDisabled = true; // keep the component if its block is moved or reconnected
    el.addEventListener("arcgisPropertyChange", (e) => {
      if (e.detail.name === "state") updateSuspension();
    });
    host.append(el);
    return el;
  }
  const tools = {
    length: make("arcgis-distance-measurement-2d", MEASURE.LENGTH_UNIT, MEASURE.LENGTH_UNITS),
    area: make("arcgis-area-measurement-2d", MEASURE.AREA_UNIT, MEASURE.AREA_UNITS),
  };
  let active = "length";

  function showActive() {
    for (const [name, el] of Object.entries(tools)) el.hidden = name !== active;
  }
  function updateSuspension() {
    panel.setSuspended(Object.values(tools).some((t) => t.state === "measuring"), "measure");
  }
  async function clearAll() {
    await Promise.all(Object.values(tools).map((t) => t.clear()));
    updateSuspension();
  }

  toolPicker.addEventListener("calciteSegmentedControlChange", async (e) => {
    active = e.target.value;
    for (const [name, el] of Object.entries(tools)) if (name !== active) await el.clear();
    showActive();
    await tools[active].start();
    updateSuspension();
  });
  document.getElementById("measure-clear").addEventListener("click", async () => {
    await tools[active].clear();
    updateSuspension();
  });
  block.addEventListener("calciteBlockCollapse", clearAll); // collapsing the block cancels measuring

  showActive();
  block.hidden = false;
  return {
    clearAll,
    async hideForPrint() {
      const views = await Promise.all(Object.values(tools).map((tool) => mapEl.view.whenAnalysisView(tool.analysis)));
      const saved = views.map((view) => view.visible);
      views.forEach((view) => { view.visible = false; });
      return () => views.forEach((view, i) => { view.visible = saved[i]; });
    },
  };
}
