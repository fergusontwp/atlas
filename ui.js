const statusEl = document.getElementById("status");
const inventoryEl = document.getElementById("inventory");
const debugBlock = document.getElementById("debug-block");

// Open the app with ?debug=1 to see the layer and table inventory.
export const DEBUG = new URLSearchParams(location.search).get("debug") === "1";

// The notice only appears for problems. Successful steps stay quiet.
export function setStatus(kind, title, message) {
  statusEl.kind = kind; // info | success | warning | danger
  statusEl.querySelector('[slot="title"]').textContent = title;
  statusEl.querySelector('[slot="message"]').textContent = message;
  statusEl.open = kind === "warning" || kind === "danger";
}

function addRow(label, description) {
  const item = document.createElement("calcite-list-item");
  item.label = label;
  item.description = description;
  inventoryEl.append(item);
}

export function fillInventory(layers, tables, summary) {
  if (!DEBUG) return;
  debugBlock.hidden = false;
  debugBlock.description = summary;
  inventoryEl.replaceChildren();
  for (const layer of layers) {
    const rels = layer.relationships?.length;
    const relText = rels === undefined ? "" : ` · ${rels} relationship${rels === 1 ? "" : "s"}`;
    addRow(layer.title ?? "Untitled layer", `Layer · ${layer.type}${relText}`);
  }
  for (const table of tables) {
    addRow(table.title ?? "Untitled table", `Table · ${table.relationships?.length ?? 0} relationships`);
  }
}

// Nothing to style when the parcel layer wasn't found.
export function disableSymbology() {
  document.getElementById("symbology-block").disabled = true;
}

// The signed-in user's name (the identity manager's first credential), or null. Notes' Retract (only on your own
// notes), Follow-ups and the header's user button (section 59; it replaced the "Signed in as" line) use it.
export const signedInUser = (esriId) => esriId?.credentials?.[0]?.userId ?? null;
