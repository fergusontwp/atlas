const statusEl = document.getElementById("status");
const inventoryEl = document.getElementById("inventory");
const debugBlock = document.getElementById("debug-block");
const userEl = document.getElementById("user");

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

export function showUser(userId) {
  if (userId) userEl.textContent = `Signed in as ${userId}`;
}
