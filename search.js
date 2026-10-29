import { SEARCH } from "./config.js";
import { combineWithOriginal } from "./filterSql.js";
import { searchWhere, usesLooseMatch, matchRank, meetsMinChars, lookupWheres, sameAsStored, sameId, clean } from "./searchSql.js";
import { getParam, setParam } from "./urlParams.js";
import { setStatus } from "./ui.js";
import { h } from "./dom.js";

const PARAM = "parcel";
const filled = (v) => v !== null && v !== undefined && String(v).trim() !== "";

// Parcel search: a box in the map area's top-left corner (above the zoom buttons) with an inline results list, plus
// ?parcel=<id> on load and the address bar kept in step with the selected parcel.
//
// Queries go through parcel.queryFeatures with the layer's current definitionExpression in the where, so a parcel
// the filter hides is not found. Choosing a result selects it exactly as a click does (panel.selectByObjectId)
// and then zooms to it.
//
// Search modes: a segmented control above the box (Parcel, Road, Location; Parcel on every load). Parcel is the search
// above, unchanged. The others plug in with addMode(key, { suggest(text, signal), choose(row), clear() }): suggest
// resolves to { rows: [{ main, tag?, sub? }], note?, error? }, choose acts on a row (and may resolve to { note }, shown in
// the list instead), clear removes what the mode drew.
// An item stays hidden until its mode is added. A switch keeps the text and runs it again in the new mode; what any mode
// drew is cleared on a switch, on choosing any result, by the clear button, by Escape in an empty box, and whenever a
// feature is selected by any means (a map click, paging, a parcel search, ?parcel=, a What's in this parcel pick).
export async function setupSearch(mapEl, parcel, panel) {
  const byName = new Map(parcel.fields.map((f) => [f.name, f]));
  const entries = SEARCH.FIELDS.filter((entry) => {
    if (byName.has(entry.field)) return true;
    console.warn(`SEARCH.FIELDS: no field named "${entry.field}" on ${parcel.title}; skipped`);
    return false;
  });
  const idEntry = entries.find((e) => e.field === SEARCH.ID_FIELD);
  if (!idEntry) console.warn(`SEARCH.ID_FIELD: no field named "${SEARCH.ID_FIELD}" on ${parcel.title}; ?parcel= won't work`);
  const oidField = parcel.objectIdField;
  const original = parcel.definitionExpression ?? null; // anything else on the layer later is the user's filter
  const filterActive = () => (parcel.definitionExpression ?? null) !== original;
  const where = (w) => combineWithOriginal(parcel.definitionExpression, w);
  const supportsOrderBy = parcel.capabilities?.query?.supportsOrderBy !== false;

  // ---- UI
  const MODES = { parcel: SEARCH.MODES.PARCEL, road: SEARCH.MODES.ROAD, location: SEARCH.MODES.LOCATION };
  const modes = new Map(); // the added modes (road, location)
  let mode = "parcel";
  const items = Object.fromEntries(Object.entries(MODES).map(([key, m]) =>
    [key, h("calcite-segmented-control-item", { value: key, checked: key === "parcel", hidden: key !== "parcel" }, m.LABEL)]));
  const control = h("calcite-segmented-control", { class: "parcel-search-modes", scale: "s", width: "full", ariaLabel: SEARCH.MODES.CONTROL_LABEL,
    oncalciteSegmentedControlChange: () => setMode(control.value) }, ...Object.values(items));
  const input = h("calcite-input-text", {
    class: "parcel-search-input", icon: "search", clearable: true, scale: "m", autocomplete: "off",
    label: "Search parcels", placeholder: MODES.parcel.PLACEHOLDER,
  });
  const list = h("div", { class: "parcel-search-results", role: "listbox", hidden: true });
  // A sibling of the map inside #map-host (not in the map's own top-left slot): the map element is one stacking layer,
  // so anything inside it would always paint under the filter editor. index.html offsets the zoom buttons below it.
  const root = h("div", { class: "parcel-search" }, control, input, list);
  const mapHost = document.getElementById("map-host");
  mapHost.append(root);
  // its real height for the zoom buttons' offset (index.html) and the filter editor (filter.js fitEditor)
  new ResizeObserver(() => {
    mapHost.style.setProperty("--parcel-search-height", `${root.offsetHeight}px`);
    mapHost.dispatchEvent(new CustomEvent("parcel-search-resize"));
  }).observe(root);

  // ---- state
  const state = { text: "", status: "idle", message: "", results: [] }; // status: idle | searching | results | empty | error | hidden-layer
  let active = -1; // index of the keyboard-highlighted row
  let currentRows = []; // the rows behind the list, for Enter
  let sequence = 0; // only the latest search may touch the UI
  let inflight = null;
  let timer;

  const hideList = () => (list.hidden = true);
  const idOf = (row) => (filled(row.attributes[SEARCH.ID_FIELD]) ? String(row.attributes[SEARCH.ID_FIELD]) : `Parcel ${row.oid}`);

  function note(text) {
    currentRows = [];
    list.replaceChildren(h("div", { class: "parcel-search-note" }, text));
    list.hidden = false;
    active = -1;
  }

  function setActive(index) {
    active = index;
    [...list.querySelectorAll(".parcel-search-row")].forEach((el, i) => {
      el.classList.toggle("active", i === active);
      el.ariaSelected = String(i === active);
      if (i === active) el.scrollIntoView({ block: "nearest" });
    });
  }

  function rowNode(row, index) {
    const secondary = entries
      .filter((e) => e.field !== SEARCH.ID_FIELD)
      .map((e) => row.attributes[e.field])
      .filter(filled)
      .join(" · ");
    return h("button", { class: "parcel-search-row", type: "button", role: "option", ariaSelected: "false", onclick: () => choose(row), onmousemove: () => active !== index && setActive(index) },
      h("span", { class: "parcel-search-main" }, idOf(row)),
      h("span", { class: "parcel-search-tag" }, row.entry.label),
      secondary ? h("span", { class: "parcel-search-sub" }, secondary) : null);
  }

  function showResults(results, more) {
    list.replaceChildren(...results.map(rowNode), ...(more ? [h("div", { class: "parcel-search-note" }, "More parcels match. Keep typing to narrow the search.")] : []));
    list.hidden = false;
    active = -1;
  }

  // ---- searching
  async function queryField(entry, text, signal) {
    const loose = usesLooseMatch(entry, text); // the pattern also finds look-alikes, so fetch more to filter
    const response = await parcel.queryFeatures({
      where: where(searchWhere(entry, text)),
      outFields: [oidField, ...entries.map((e) => e.field)],
      returnGeometry: false,
      num: loose ? SEARCH.NORMALIZED_CANDIDATES : SEARCH.CANDIDATES,
      ...(supportsOrderBy ? { orderByFields: [entry.field] } : {}),
    }, { signal });
    const rows = [];
    for (const feature of response.features) {
      const rank = matchRank(entry, feature.attributes[entry.field], text);
      if (rank < 0) continue; // a look-alike the letters-and-digits pattern let through
      rows.push({ oid: feature.attributes[oidField], attributes: feature.attributes, entry, rank });
    }
    const value = (r) => String(r.attributes[entry.field] ?? "");
    rows.sort((a, b) => a.rank - b.rank || value(a).localeCompare(value(b)));
    return { rows, truncated: !!response.exceededTransferLimit };
  }

  async function run(text) {
    const q = clean(text);
    const request = ++sequence;
    inflight?.abort();
    state.text = q;
    input.loading = false;
    if (!meetsMinChars(q, SEARCH.MIN_CHARS)) {
      Object.assign(state, { status: "idle", message: "", results: [] });
      hideList();
      return [];
    }
    if (mode !== "parcel") return runMode(q, request);
    if (parcel.visible === false) {
      Object.assign(state, { status: "hidden-layer", message: "The parcel layer is hidden. Turn it on to search.", results: [] });
      note(state.message);
      return [];
    }

    const controller = (inflight = new AbortController());
    state.status = "searching";
    input.loading = true;
    const settled = await Promise.allSettled(entries.map((entry) => queryField(entry, q, controller.signal)));
    if (request !== sequence) return []; // a newer search (or a choice) took over
    input.loading = false;

    const failed = settled.filter((s) => s.status === "rejected");
    failed.forEach((s) => console.warn("Parcel search query failed:", s.reason));
    if (failed.length === settled.length && failed.length > 0) {
      const reason = failed[0].reason;
      Object.assign(state, { status: "error", message: `Search failed: ${reason?.message ?? reason}`, results: [] });
      note(state.message);
      return [];
    }

    // Field order, then starts-with first (already sorted per field); one row per parcel, under the first field that matched.
    const seen = new Set();
    const merged = [];
    let more = false;
    for (const s of settled) {
      if (s.status !== "fulfilled") continue;
      more ||= s.value.truncated || s.value.rows.length > SEARCH.MAX_PER_FIELD;
      for (const row of s.value.rows.slice(0, SEARCH.MAX_PER_FIELD)) {
        if (seen.has(row.oid)) continue;
        seen.add(row.oid);
        merged.push(row);
      }
    }
    more ||= merged.length > SEARCH.MAX_RESULTS;
    const results = merged.slice(0, SEARCH.MAX_RESULTS);
    state.results = results.map((r) => ({ oid: r.oid, id: idOf(r), field: r.entry.field, attributes: { ...r.attributes } }));
    if (results.length === 0) {
      state.status = "empty";
      state.message = filterActive() ? "No match. A filter is active." : "No match.";
      note(state.message);
    } else {
      state.status = "results";
      state.message = "";
      currentRows = results;
      showResults(results, more);
    }
    return state.results;
  }

  // ---- the other modes: their rows in the same list
  async function runMode(q, request) {
    const m = modes.get(mode), controller = (inflight = new AbortController());
    Object.assign(state, { status: "searching", message: "", results: [] });
    input.loading = true;
    let answer;
    try {
      answer = await m.suggest(q, controller.signal);
    } catch (err) {
      if (request !== sequence || err?.name === "AbortError") return [];
      console.warn(`${MODES[mode].LABEL} search failed:`, err);
      answer = { rows: [], error: true, note: `Search failed: ${err?.message ?? err}` };
    }
    if (request !== sequence) return [];
    input.loading = false;
    const rows = answer.rows ?? [];
    state.results = rows.map(({ main, tag = null, sub = null }) => ({ main, tag, sub }));
    if (!rows.length) {
      Object.assign(state, { status: answer.error ? "error" : "empty", message: answer.note ?? "No match." });
      note(state.message);
      return [];
    }
    Object.assign(state, { status: "results", message: answer.note ?? "" });
    currentRows = rows;
    list.replaceChildren(...rows.map((row, index) => h("button", { class: "parcel-search-row", type: "button", role: "option", ariaSelected: "false",
      onclick: () => chooseMode(row), onmousemove: () => active !== index && setActive(index) },
    h("span", { class: "parcel-search-main" }, row.main),
    row.tag ? h("span", { class: "parcel-search-tag" }, row.tag) : null,
    row.sub ? h("span", { class: "parcel-search-sub" }, row.sub) : null)),
    ...(answer.note ? [h("div", { class: "parcel-search-note" }, answer.note)] : []));
    list.hidden = false;
    active = -1;
    return state.results;
  }
  async function chooseMode(row) {
    const m = modes.get(mode);
    sequence++;
    inflight?.abort();
    clearTimeout(timer);
    input.loading = false;
    input.value = row.main;
    state.text = clean(input.value);
    hideList();
    clearMarks();
    try {
      const answer = await m.choose(row);
      if (answer?.note) {
        Object.assign(state, { status: "empty", message: answer.note, results: [] });
        note(answer.note);
      }
    } catch (err) {
      if (err?.name === "AbortError") return;
      console.warn(`Couldn't show the ${MODES[mode].LABEL.toLowerCase()} result:`, err);
      setStatus("warning", `Couldn't show that ${MODES[mode].LABEL.toLowerCase()}`, err?.message ?? String(err));
    }
  }
  const clearMarks = () => modes.forEach((m) => m.clear());
  panel.onSelectionChange((feature) => { if (feature) clearMarks(); }); // a selection, from anywhere, clears what search drew
  const pick = (row) => (mode === "parcel" ? choose(row) : chooseMode(row));

  // A switch keeps the text and runs it again in the new mode (rerun false: just switch, as ?parcel= does).
  function setMode(key, rerun = true) {
    if (key !== "parcel" && !modes.has(key)) key = "parcel";
    if (control.value !== key) control.value = key;
    if (key === mode) return;
    mode = key;
    input.placeholder = MODES[key].PLACEHOLDER;
    clearMarks();
    clearTimeout(timer);
    if (!rerun) {
      sequence++;
      inflight?.abort();
      input.loading = false;
      Object.assign(state, { status: "idle", message: "", results: [] });
      hideList();
      return;
    }
    run(input.value ?? "");
  }

  // ---- choosing a parcel
  async function zoomTo(geometry) {
    try {
      await mapEl.goTo(geometry.extent.clone().expand(2));
    } catch (err) {
      if (err?.name !== "AbortError") console.warn("Couldn't zoom to the parcel:", err);
    }
  }

  async function openByObjectId(oid) {
    const geometry = await panel.selectByObjectId(oid);
    if (geometry) await zoomTo(geometry);
    return !!geometry;
  }

  async function choose(row) {
    sequence++; // a search still in flight must not reopen the list
    inflight?.abort();
    clearTimeout(timer);
    input.loading = false;
    input.value = idOf(row);
    state.text = clean(input.value);
    hideList();
    clearMarks();
    try {
      await openByObjectId(row.oid);
    } catch (err) {
      console.warn("Couldn't open the parcel:", err);
      setStatus("warning", "Couldn't open that parcel", err?.message ?? String(err));
    }
  }

  function reset() {
    sequence++;
    inflight?.abort();
    clearTimeout(timer);
    input.value = "";
    Object.assign(state, { text: "", status: "idle", message: "", results: [] });
    input.loading = false;
    hideList();
  }

  // ---- input handling
  input.addEventListener("calciteInputTextInput", (event) => {
    const text = event.target.value ?? "";
    clearTimeout(timer);
    if (text === "") clearMarks(); // the clear button (or the box emptied)
    if (!meetsMinChars(text, SEARCH.MIN_CHARS)) {
      run(text); // cancels anything in flight and hides the list
      return;
    }
    timer = setTimeout(() => run(text), SEARCH.DEBOUNCE_MS);
  });
  input.addEventListener("keydown", (event) => {
    const rows = [...list.querySelectorAll(".parcel-search-row")];
    if (event.key === "Escape") {
      if (!clean(input.value)) clearMarks();
      reset();
    } else if (event.key === "ArrowDown" && rows.length) {
      event.preventDefault();
      setActive((active + 1) % rows.length);
    } else if (event.key === "ArrowUp" && rows.length) {
      event.preventDefault();
      setActive(active <= 0 ? rows.length - 1 : active - 1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (rows.length && currentRows.length) pick(currentRows[Math.max(active, 0)]); // the highlighted row, else the first
    }
  });
  input.addEventListener("focusin", () => {
    if (state.status !== "idle" && state.status !== "searching" && list.childElementCount) list.hidden = false;
  });
  document.addEventListener("pointerdown", (event) => {
    if (!root.contains(event.target)) hideList();
  });

  // ---- ?parcel=<id>: the address bar follows the selection
  const copyLink = document.getElementById("parcel-copy-link");
  let urlRequest = 0;
  async function syncUrl() {
    const request = ++urlRequest;
    const oid = panel.selectedObjectId();
    if (copyLink) copyLink.hidden = oid === null;
    if (oid === null) {
      setParam(PARAM, null);
      return;
    }
    let id = panel.selectedValue(SEARCH.ID_FIELD); // the pop-up usually carries it; if not, ask once
    if (!filled(id) && idEntry) {
      try {
        const { features } = await parcel.queryFeatures({ objectIds: [oid], outFields: [SEARCH.ID_FIELD], returnGeometry: false });
        id = features[0]?.attributes?.[SEARCH.ID_FIELD];
      } catch (err) {
        console.warn("Couldn't read the parcel ID for the address bar:", err);
      }
    }
    if (request === urlRequest) setParam(PARAM, filled(id) ? String(id).trim() : null);
  }
  panel.onSelectionChange(syncUrl);

  if (copyLink) {
    let resetTimer;
    copyLink.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(location.href);
        copyLink.icon = "check";
        copyLink.text = "Link copied";
        clearTimeout(resetTimer);
        resetTimer = setTimeout(() => {
          copyLink.icon = "link";
          copyLink.text = "Copy link";
        }, 1500);
      } catch (err) {
        console.warn("Couldn't copy the link:", err);
        setStatus("warning", "Couldn't copy the link", "Copy the address from the browser's address bar instead.");
      }
    });
  }

  // The parcel's object id for an ID typed as stored, or with only letters and digits. First match by object id.
  async function findObjectId(id) {
    if (!idEntry) return null;
    const field = SEARCH.ID_FIELD;
    const { exact, loose } = lookupWheres(field, id);
    const query = (w, num) => parcel.queryFeatures({ where: where(w), outFields: [oidField, field], returnGeometry: false, num });
    let hits = (await query(exact, SEARCH.CANDIDATES)).features.filter((f) => sameAsStored(f.attributes[field], id));
    if (hits.length === 0 && loose) {
      hits = (await query(loose, SEARCH.NORMALIZED_CANDIDATES)).features.filter((f) => sameId(f.attributes[field], id));
    }
    if (hits.length === 0) return null;
    const oids = hits.map((f) => f.attributes[oidField]).sort((a, b) => a - b);
    if (oids.length > 1) console.warn(`${PARAM}=${id} matches ${oids.length} parcels; using object id ${oids[0]}.`);
    return oids[0];
  }

  // Select and zoom to a parcel by its ID, as a search result would. Resolves to whether it was found.
  async function openParcel(id) {
    const text = clean(id);
    setMode("parcel", false);
    try {
      const oid = await findObjectId(text);
      if (oid === null) {
        setStatus("warning", "Parcel not found", `Parcel ${text} not found`);
        return false;
      }
      input.value = text;
      return await openByObjectId(oid);
    } catch (err) {
      console.warn("Couldn't open the parcel:", err);
      setStatus("warning", "Couldn't open that parcel", err?.message ?? String(err));
      return false;
    }
  }

  async function openFromUrl() {
    const id = getParam(location.search, PARAM);
    if (id && clean(id)) await openParcel(id);
  }

  return {
    async run(text) {
      input.value = text;
      clearTimeout(timer);
      return run(text);
    },
    get state() {
      return { ...JSON.parse(JSON.stringify(state)), mode };
    },
    get mode() { return mode; },
    setMode,
    // A search mode (road, location): its item shows once it is added.
    addMode(key, impl) {
      modes.set(key, impl);
      items[key].hidden = false;
    },
    openParcel,
    openFromUrl,
    clear: reset,
  };
}
