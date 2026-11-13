import { GEOREF, POINT_INFO, SEARCH } from "./config.js";
import { reverseParams } from "./geocodeParams.js";
import { cacheFind, cacheKey, createCache, distanceText, geocodeFailure, geocodeLabel, googleMapsUrl, isRightClick, latLonText, parcelSection, placeCard } from "./pointInfoLogic.js";
import { h } from "./dom.js";
import { setStatus } from "./ui.js";

// "What's here?": a right-click on the map opens a small card at the click (coordinates, the parcel's own address, the
// nearest reverse-geocoded address, Open in Google Maps, copy buttons). A right-drag still rotates the map. Named "point
// info" in code (whatsHere.js is What's in this parcel).
//
// The gesture: the view's own pointer-down and pointer-up events (5.1: they carry button, x, y and timestamp). A press
// and release of button 2 that moved at most CLICK_MAX_MOVE_PX, took at most CLICK_MAX_MS and left the rotation as it was
// is a right-click (pointInfoLogic.isRightClick). The view's click event does fire for button 2 (panel.js ignores it),
// but it has none of these limits, and a long press still clicks; the pointer events give the exact rule. The listeners
// only read the events: nothing stops their propagation, so the SDK's right-drag rotation is untouched. The browser's
// context menu is already prevented on the map surface by the SDK (MapViewInputManager installs "prevent-context-menu"),
// so nothing is added for it, and the search box, filter editor and this card keep their own menus.
//
// The card: a child of #map-host (a sibling of the map, so it stays in the map area and never covers the parcel panel),
// z-index above the filter editor and below the search box. It follows its point when the map pans, zooms or rotates
// (at most once a frame), hides while the point is out of view and shows again when it comes back (nothing is asked
// again). Focus stays on the map; the card is reachable with Tab. Esc closes it through a window-level capture listener
// that exists only while it is open, so the app's own Esc (clearing the selection) doesn't run.
//
// The parcel record: the parcel layer queried at the point (no credits) for its address (PARCEL.ADDRESS_FIELD) and ID
// (SEARCH.ID_FIELD). The user's filter is ignored: the query goes to one clone of the layer made at setup with only the
// web map's own expression (filter.original), as styles.js classifies, so a parcel the filter hides, or with the layer
// switched off, is still reported. A layer that can't be cloned (built from in-memory features) is queried itself, and
// then the filter applies.
//
// The nearest address: the SDK's locator.locationToAddress against the ArcGIS World Geocoding Service (GEOCODE.URL),
// the click point as given (the service reprojects), the address's own location back (the default locationType) for the
// distance. Credits kept low: forStorage is never set (the SDK leaves it out of the request), nothing is stored but an
// in-memory cache of the last CACHE_SIZE answers keyed by the point rounded to CACHE_ROUND_FT in 2271 feet (a found
// address or "none"; never a failure; a click within CACHE_ROUND_FT of an asked point uses its answer, across a grid
// line too), and exactly one request per accepted right-click that the cache can't answer.
// The token is the user's sign-in, added by the identity manager; authMode "no-prompt" so a right-click never starts a
// sign-in (not signed in: "Address unavailable: not signed in"). The distance is planar in 2271 feet.
//
// Off (and closed) while Measure measures, the georeferencing workspace is open or the print editor is up (all suspend
// map clicks through panel.setSuspended), and while the Print block is open. The workspace's own right-button handling
// (its sheet pane's pan and context menu, placement's left-button picks) is untouched: these listeners only read.
//
// opts: { mapEl, parcel, panel, filter }. Returns the handle kept as viewer.pointInfo.
export async function setupPointInfo({ mapEl, parcel, panel, filter }) {
  if (!POINT_INFO.ENABLED) return null;
  const [GraphicsLayer, Graphic, reactiveUtils] = await $arcgis.import(["@arcgis/core/layers/GraphicsLayer.js", "@arcgis/core/Graphic.js", "@arcgis/core/core/reactiveUtils.js"]);
  const view = mapEl.view, map = mapEl.map;

  // ---- the marker: one ring at the click, in a list-hidden layer kept at the top of the draw order
  const layer = new GraphicsLayer({ id: "point-info-marker", title: "Point info", listMode: "hide" });
  map.add(layer);
  const keepOnTop = () => { const at = map.layers.indexOf(layer); if (at >= 0 && at !== map.layers.length - 1) map.reorder(layer, map.layers.length - 1); };
  map.layers.on("change", keepOnTop);
  const M = POINT_INFO.MARKER;
  const ring = (size, color, width) => ({ type: "simple-marker", style: "circle", size, color: M.COLOR, outline: { color, width } });

  // ---- the parcel layer to ask: a clone with only the web map's own expression
  const PC = POINT_INFO.PARCEL;
  const hasField = (layer, name) => !!layer?.fields?.some((f) => f.name.toLowerCase() === String(name).toLowerCase());
  let parcelSource = null, parcelNote = "";
  if (!parcel) parcelNote = "no parcel layer";
  else if (!hasField(parcel, PC.ADDRESS_FIELD)) console.warn(`POINT_INFO.PARCEL.ADDRESS_FIELD: the parcel layer has no "${PC.ADDRESS_FIELD}" field, so What's here? shows no parcel record.`);
  else {
    try {
      parcelSource = parcel.clone();
      parcelSource.definitionExpression = filter ? filter.original : (parcel.definitionExpression ?? null);
    } catch {
      parcelSource = parcel; // a client-side layer: the filter applies to its query
      console.warn("What's here?: the parcel layer can't be cloned, so a parcel hidden by the filter isn't reported.");
    }
  }

  // ---- the geocoder (none when GEOCODE.ENABLED is false); the projection engine loads in the background
  const GC = POINT_INFO.GEOCODE;
  let geocoder = null;
  if (GC.ENABLED) {
    const [locator, projectOperator, SpatialReference] = await $arcgis.import(["@arcgis/core/rest/locator.js",
      "@arcgis/core/geometry/operators/projectOperator.js", "@arcgis/core/geometry/SpatialReference.js"]);
    const feet = new SpatialReference({ wkid: GEOREF.WORKING_WKID });
    geocoder = {
      locator,
      ready: projectOperator.isLoaded() ? Promise.resolve() : projectOperator.load(),
      toFeet: (p) => { const q = p && projectOperator.execute(p, feet); return q ? { x: q.x, y: q.y } : null; },
    };
  }
  const answers = createCache(GC.CACHE_SIZE);
  let requests = 0; // geocode requests sent this session (viewer.pointInfo.requests, for the credit check)

  // ---- the card
  const host = document.getElementById("map-host");
  const closeBtn = h("calcite-action", { icon: "x", text: "Close What's here?", label: "Close What's here?", scale: "s", onclick: () => close() });
  const coords = h("span", { class: "pi-coords" });
  const coordsCopy = copyAction("Copy the coordinates", () => state.latlon);
  const parcelBox = h("section", { class: "pi-section", ariaLive: "polite" });
  const geocodeBox = h("section", { class: "pi-section", ariaLive: "polite" });
  const google = h("a", { class: "pi-google", target: "_blank", rel: "noopener noreferrer" }, "Open in Google Maps", h("calcite-icon", { icon: "launch", scale: "s" }));
  const tail = h("div", { class: "pi-tail" });
  const card = h("div", { class: "point-info", role: "dialog", ariaLabel: "What's here?", hidden: true },
    h("div", { class: "pi-head" }, h("span", { class: "pi-title" }, "What's here?"), closeBtn),
    h("div", { class: "pi-row" }, coords, coordsCopy),
    parcelBox, geocodeBox, google, tail);
  host.append(card);

  // A copy action: the text from get() on the clipboard, "Copied" for a moment; on failure the app's notice.
  function copyAction(label, get) {
    let timer;
    const a = h("calcite-action", { icon: "copy", text: label, label, scale: "s", onclick: async () => {
      const text = get();
      if (!text) return;
      try {
        await navigator.clipboard.writeText(text);
        a.icon = "check"; a.text = "Copied";
        clearTimeout(timer);
        timer = setTimeout(() => { a.icon = "copy"; a.text = label; }, 1500);
      } catch (err) {
        console.warn("Couldn't copy:", err);
        setStatus("warning", "Couldn't copy", "Select the text in the What's here? card and copy it instead.");
      }
    } });
    return a;
  }
  // A section: its heading, then the address with a copy action (status "ok"), or a status line (a loader once it has
  // taken LOADER_DELAY_MS), and a secondary line.
  function section(box, heading, { status, text, sub, copy, loading }) {
    const parts = [h("div", { class: "pi-heading" }, heading)];
    if (status === "ok") parts.push(h("div", { class: "pi-row" }, h("span", { class: "pi-address" }, text), copy));
    else if (status === "loading") parts.push(h("div", { class: "pi-status" }, loading ? h("calcite-loader", { inline: true, scale: "s", label: text }) : null, h("span", {}, text)));
    else parts.push(h("div", { class: `pi-status${status === "error" ? " pi-error" : ""}` }, text));
    if (sub) parts.push(h("div", { class: "pi-sub" }, sub));
    box.replaceChildren(...parts);
  }

  const closed = () => ({ open: false, point: null, latlon: null, parcel: { status: "off" }, geocode: { status: "off" } });
  let state = closed();
  let abort = null, run = 0;
  const parcelCopy = copyAction("Copy the parcel's address", () => state.parcel.address);
  const geocodeCopy = copyAction("Copy the nearest address", () => state.geocode.address);

  // ---- the parcel section
  function renderParcel() {
    const p = state.parcel, idLine = p.id ? `Parcel ${p.id}` : "";
    if (p.status === "off") { parcelBox.replaceChildren(); schedule(); return; }
    if (p.status === "loading") section(parcelBox, PC.LABEL, { status: "loading", text: "Looking up the parcel…", loading: p.slow });
    else if (p.status === "ok") section(parcelBox, PC.LABEL, { status: "ok", text: p.address, sub: idLine, copy: parcelCopy });
    else if (p.status === "none") section(parcelBox, PC.LABEL, { status: "none", text: "Not in a parcel" });
    else if (p.status === "empty") section(parcelBox, PC.LABEL, { status: "empty", text: "No address on the parcel record", sub: idLine });
    else section(parcelBox, PC.LABEL, { status: "error", text: `Parcel lookup unavailable${p.reason ? `: ${p.reason}` : ""}` });
    schedule();
  }
  async function lookUpParcel(point, mine, signal) {
    if (!parcelSource) { state.parcel = { status: "off" }; renderParcel(); return; }
    state.parcel = { status: "loading", slow: false };
    renderParcel();
    const slow = setTimeout(() => { if (mine === run && state.parcel.status === "loading") { state.parcel.slow = true; renderParcel(); } }, POINT_INFO.LOADER_DELAY_MS);
    try {
      const oid = parcel.objectIdField;
      const { features } = await parcelSource.queryFeatures({ geometry: point, spatialRelationship: "intersects", returnGeometry: false,
        outFields: [PC.ADDRESS_FIELD, SEARCH.ID_FIELD, oid].filter(Boolean), num: 2 }, { signal });
      if (mine !== run) return; // a newer right-click owns the card
      const r = parcelSection(features, { addressField: PC.ADDRESS_FIELD, idField: SEARCH.ID_FIELD, oidField: oid });
      if (r.multiple) console.warn(`What's here?: ${r.multiple} parcels at this point; showing the one with the lowest object id.`);
      state.parcel = { status: r.status, address: r.address, id: r.id };
    } catch (err) {
      if (mine !== run || err?.name === "AbortError") return;
      console.warn("What's here?: the parcel lookup failed:", err);
      state.parcel = { status: "error", reason: err?.message ? String(err.message).slice(0, 80) : "" };
    } finally {
      clearTimeout(slow);
    }
    renderParcel();
  }

  // ---- the nearest-address section
  function renderGeocode() {
    const g = state.geocode;
    if (g.status === "off") geocodeBox.replaceChildren();
    else if (g.status === "loading") section(geocodeBox, GC.LABEL, { status: "loading", text: "Finding address…", loading: g.slow });
    else if (g.status === "ok") section(geocodeBox, GC.LABEL, { status: "ok", text: g.address, sub: distanceText(g.distanceFt, POINT_INFO.DISTANCE), copy: geocodeCopy });
    else if (g.status === "none") section(geocodeBox, GC.LABEL, { status: "none", text: "No address found near this point" });
    else section(geocodeBox, GC.LABEL, { status: "error", text: `Address unavailable: ${g.reason}` });
    schedule();
  }
  const REASONS = { timeout: "timed out", signin: "not signed in", error: "service error" };
  async function lookUpAddress(point, mine, signal) {
    if (!geocoder) { state.geocode = { status: "off" }; renderGeocode(); return; }
    state.geocode = { status: "loading", slow: false };
    renderGeocode();
    const slow = setTimeout(() => { if (mine === run && state.geocode.status === "loading") { state.geocode.slow = true; renderGeocode(); } }, POINT_INFO.LOADER_DELAY_MS);
    let timedOut = false;
    try {
      await geocoder.ready;
      if (mine !== run) return;
      const at = geocoder.toFeet(point);
      let answer = at ? cacheFind(answers, at.x, at.y, GC.CACHE_ROUND_FT) : undefined;
      const cached = !!answer;
      if (!answer) {
        // its own controller: aborted by a new right-click or a close (the run's signal) or by the timeout
        const own = new AbortController(), stop = () => own.abort();
        signal.addEventListener("abort", stop, { once: true });
        const timer = setTimeout(() => { timedOut = true; own.abort(); }, GC.TIMEOUT_MS);
        requests++;
        try {
          // the point with only its wkid (geocodeParams.js): the view's spatial reference carries the web map's storage parameters
          const candidate = await geocoder.locator.locationToAddress(GC.URL, reverseParams(point), { signal: own.signal, authMode: "no-prompt" });
          const label = geocodeLabel(candidate);
          answer = label ? { status: "ok", address: label, at: geocoder.toFeet(candidate.location) } : { status: "none" };
        } catch (err) {
          if (signal.aborted || geocodeFailure(err, { timedOut }) !== "none") throw err;
          answer = { status: "none" }; // the service's "Unable to find address" is an answer, not a failure
        } finally {
          clearTimeout(timer);
          signal.removeEventListener("abort", stop);
        }
        if (at) answers.set(cacheKey(at.x, at.y, GC.CACHE_ROUND_FT), { ...answer, x: at.x, y: at.y });
      }
      if (mine !== run) return;
      const distanceFt = answer.at && at ? Math.hypot(answer.at.x - at.x, answer.at.y - at.y) : null;
      state.geocode = { status: answer.status, address: answer.address ?? null, distanceFt, cached };
    } catch (err) {
      if (mine !== run || signal.aborted) return;
      const why = geocodeFailure(err, { timedOut });
      console.warn("What's here?: the reverse geocode failed:", why, err);
      state.geocode = { status: "error", reason: REASONS[why] ?? REASONS.error };
    } finally {
      clearTimeout(slow);
    }
    renderGeocode();
  }

  let frame = 0;
  function place() {
    frame = 0;
    if (!state.open) return;
    const sp = view.toScreen(state.point);
    const inView = sp && sp.x >= 0 && sp.y >= 0 && sp.x <= view.width && sp.y <= view.height;
    card.hidden = !inView; // out of view: hidden until the point comes back (nothing is asked again)
    if (!inView) return;
    const hr = host.getBoundingClientRect(), vr = view.container.getBoundingClientRect();
    const pt = { x: sp.x + vr.left - hr.left, y: sp.y + vr.top - hr.top };
    const at = placeCard(pt, { w: card.offsetWidth, h: card.offsetHeight }, { w: hr.width, h: hr.height }, { gap: POINT_INFO.CARD.GAP_PX, margin: POINT_INFO.CARD.MARGIN_PX });
    card.style.left = `${at.left}px`;
    card.style.top = `${at.top}px`;
    card.dataset.side = `${at.side.x}-${at.side.y}`;
    // the tail points at the click, along the card's edge nearest it (kept on the card)
    tail.style.left = `${Math.max(10, Math.min(card.offsetWidth - 22, pt.x - at.left - 6))}px`;
    tail.style.top = at.side.y === "up" ? `${card.offsetHeight - 7}px` : "-7px";
  }
  const schedule = () => { if (!frame) frame = requestAnimationFrame(place); };
  reactiveUtils.watch(() => [view.extent, view.rotation, view.width, view.height], () => { if (state.open) schedule(); });

  const onEscape = (e) => {
    if (e.key !== "Escape") return;
    e.stopImmediatePropagation(); e.stopPropagation(); e.preventDefault();
    close();
  };

  function open(mapPoint) {
    close();
    if (!mapPoint) return;
    const lat = mapPoint.latitude, lon = mapPoint.longitude, d = POINT_INFO.LATLON_DECIMALS;
    state = { ...closed(), open: true, point: mapPoint, latlon: latLonText(lat, lon, d) };
    layer.addMany([
      new Graphic({ geometry: mapPoint, symbol: ring(M.SIZE, M.HALO, M.HALO_WIDTH) }),
      new Graphic({ geometry: mapPoint, symbol: ring(M.SIZE, M.OUTLINE, M.OUTLINE_WIDTH) }),
    ]);
    coords.textContent = state.latlon;
    google.href = googleMapsUrl(POINT_INFO.GOOGLE_MAPS_URL, lat, lon, d);
    parcelBox.replaceChildren();
    geocodeBox.replaceChildren();
    card.hidden = false;
    window.addEventListener("keydown", onEscape, true);
    place();
    // the lookups, each on its own, both cancelled by a new right-click or a close
    const mine = ++run, controller = (abort = new AbortController());
    lookUpParcel(mapPoint, mine, controller.signal);
    lookUpAddress(mapPoint, mine, controller.signal);
  }
  function close() {
    if (!state.open) return;
    run++;
    abort?.abort();
    abort = null;
    layer.removeAll();
    card.hidden = true;
    window.removeEventListener("keydown", onEscape, true);
    cancelAnimationFrame(frame); frame = 0;
    state = closed();
  }

  // ---- the gesture (see above); off while any owner suspends map clicks (Measure, the workspace, the print editor) and
  // while the Print block is open (its frame is on the map); opening either closes the card, so the marker is never printed
  const printBlock = document.getElementById("print-block");
  const active = () => POINT_INFO.ENABLED && !panel.suspended && !printBlock?.expanded;
  let down = null;
  const stamp = (e) => ({ x: e.x, y: e.y, t: e.timestamp ?? performance.now(), button: e.button, rotation: view.rotation });
  view.on("pointer-down", (e) => { down = active() && e.button === 2 ? stamp(e) : null; });
  view.on("pointer-up", (e) => {
    const d = down;
    down = null;
    if (!d || !active() || !isRightClick(d, stamp(e), POINT_INFO)) return;
    open(view.toMap({ x: e.x, y: e.y }));
  });
  // a left click on the map closes it (and then selects as before: panel.js has its own listener)
  view.on("click", (e) => { if (e.button === 0) close(); });
  panel.onSuspendedChange?.((on) => { if (on) close(); });
  printBlock?.addEventListener("calciteBlockExpand", (e) => { if (e.target === printBlock) close(); });

  return {
    open, close, layer,
    get state() {
      const { status, address = null, id = null } = state.parcel, g = state.geocode;
      return { open: state.open, latlon: state.latlon, parcel: { status, address, id },
        geocode: { status: g.status, address: g.address ?? null, distanceFt: g.distanceFt ?? null, cached: !!g.cached } };
    },
    get requests() { return requests; },
    card,
  };
}
