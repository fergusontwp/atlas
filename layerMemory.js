// Remembered layer visibility (section 53): pure helpers. The saved value is { <stable layer key>: true | false } holding
// only the layers the user switched in the Layers list and left different from the web map's default (LAYER_LIST.OFF
// applied). A key is the layer's id in the web map (its operational layer id), never its title; a map image sublayer's
// is "<layer id>/<sublayer id>". layers.js does the reading, writing and applying.

const plainObject = (v) => !!v && typeof v === "object" && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

// The stored value (a JSON string, an already parsed value, or nothing) as a clean { key: boolean }: anything that isn't
// an object of booleans under non-empty keys is dropped, entry by entry; garbage gives {}.
export function sanitizeSaved(raw) {
  let value = raw;
  if (typeof raw === "string") {
    try { value = JSON.parse(raw); } catch { return {}; }
  }
  if (!plainObject(value)) return {};
  const out = {};
  for (const [key, visible] of Object.entries(value)) {
    if (typeof key !== "string" || !key || key === "__proto__" || typeof visible !== "boolean") continue;
    out[key] = visible;
  }
  return out;
}

// Each node of a layer tree [{ key, visible, children? }] (groups and their children, any depth) as { key: visible }.
export function visibilityOf(tree) {
  const out = {};
  const walk = (nodes) => {
    for (const node of nodes ?? []) {
      if (node?.key) out[node.key] = !!node.visible;
      walk(node?.children);
    }
  };
  walk(tree);
  return out;
}

// The entries of `current` that differ from `defaults`, for keys `defaults` knows.
export function diffFromDefault(current, defaults) {
  const out = {};
  for (const [key, visible] of Object.entries(current ?? {})) {
    if (Object.hasOwn(defaults ?? {}, key) && defaults[key] !== visible) out[key] = visible;
  }
  return out;
}

// After a user gesture in the Layers list: the layers whose visibility went from `before` to `after` (an exclusive
// group's other children included) are the user's. They join `saved`; then anything equal to the default (switched
// back) or unknown is dropped.
export function recordUserChanges(saved, before, after, defaults) {
  const next = { ...sanitizeSaved(saved) };
  for (const [key, visible] of Object.entries(after ?? {})) {
    if (Object.hasOwn(before ?? {}, key) && before[key] !== visible) next[key] = visible;
  }
  return diffFromDefault(next, defaults);
}

// At startup: which saved choices to apply to the layer tree, and the saved value to keep. Keys for layers that no
// longer exist are dropped quietly; a choice that now equals the layer's current state is kept but needs no change.
// Returns { apply: { key: visible } (only real changes), kept: { key: visible }, dropped: [key] }.
export function applySaved(saved, tree) {
  const current = visibilityOf(tree);
  const apply = {}, kept = {}, dropped = [];
  for (const [key, visible] of Object.entries(sanitizeSaved(saved))) {
    if (!Object.hasOwn(current, key)) { dropped.push(key); continue; }
    kept[key] = visible;
    if (current[key] !== visible) apply[key] = visible;
  }
  return { apply, kept, dropped };
}
