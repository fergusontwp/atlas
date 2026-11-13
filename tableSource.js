// The attribute table's rows for one tab (attributeTable.js): the ordered object id list, pages of rows by id, a small
// least-recently-used page cache, and abort / sequence rules so an older answer never replaces a newer one. No DOM and
// no SDK imports: the data comes from a backend, either a layer (createLayerBackend, plain layer method calls) or an
// in-memory fake for tests (createMemoryBackend), like plansStore.js.
//
// backend: {
//   orderedIds(query, { signal }) -> { ids, path, sortUnsupported }   query: { where, geometry, objectIds, orderBy }
//   fetchRows(ids, outFields, { signal }) -> Map(oid -> attributes)
// }
import { TABLE } from "./config.js";

const abortError = () => Object.assign(new Error("Aborted"), { name: "AbortError" });

export function createTableSource(backend, { pageSize = TABLE.PAGE_SIZE, pageCache = TABLE.PAGE_CACHE, onChange = () => {} } = {}) {
  let ids = [];
  let index = null; // oid -> position, built on first use
  let status = "idle"; // "idle" | "loading" | "ready" | "error"
  let error = null;
  let info = { path: null, sortUnsupported: false };
  let seq = 0;
  let controller = null;
  let generation = 0; // bumps when the id list or the fields change: page answers from before are dropped
  let outFields = ["*"];
  const pages = new Map(); // page number -> { status: "loading" | "ok" | "error", rows: Map, controller } in LRU order

  function dropPages() {
    for (const p of pages.values()) p.controller?.abort();
    pages.clear();
    generation++;
  }

  // Re-query the ordered id list. Resolves to { ok, stale } (stale: a newer query replaced this one meanwhile).
  async function setQuery(query) {
    const mine = ++seq;
    controller?.abort();
    const ctl = (controller = new AbortController());
    status = "loading";
    error = null;
    onChange("status");
    try {
      const result = await backend.orderedIds(query, { signal: ctl.signal });
      if (mine !== seq) return { ok: false, stale: true };
      ids = result.ids;
      index = null;
      info = { path: result.path ?? null, sortUnsupported: !!result.sortUnsupported };
      dropPages();
      status = "ready";
      onChange("ids");
      return { ok: true, stale: false };
    } catch (err) {
      if (mine !== seq) return { ok: false, stale: true };
      if (err?.name === "AbortError") return { ok: false, stale: true };
      status = "error";
      error = err;
      onChange("status");
      return { ok: false, stale: false };
    }
  }

  const pageOf = (i) => Math.floor(i / pageSize);
  function touch(p) {
    const page = pages.get(p);
    pages.delete(p);
    pages.set(p, page);
  }
  function evict(keep) {
    for (const p of pages.keys()) {
      if (pages.size <= pageCache) break;
      if (keep.has(p) || pages.get(p).status === "loading") continue;
      pages.delete(p);
    }
  }
  async function load(p) {
    const gen = generation;
    const ctl = new AbortController();
    const slice = ids.slice(p * pageSize, (p + 1) * pageSize);
    const page = { status: "loading", rows: null, controller: ctl };
    pages.set(p, page);
    try {
      const rows = await backend.fetchRows(slice, outFields, { signal: ctl.signal });
      if (gen !== generation || pages.get(p) !== page) return;
      page.status = "ok";
      page.rows = rows;
    } catch (err) {
      if (gen !== generation || pages.get(p) !== page || err?.name === "AbortError") return;
      page.status = "error";
    } finally {
      if (pages.get(p) === page) page.controller = null;
    }
    onChange("rows");
  }

  // Load the pages that rows start..end-1 fall on (each page once), and keep them as the most recently used.
  function ensure(start, end) {
    if (status !== "ready" || !ids.length) return;
    const first = pageOf(Math.max(0, start)), last = pageOf(Math.max(0, Math.min(ids.length, end) - 1));
    const keep = new Set();
    for (let p = first; p <= last; p++) {
      keep.add(p);
      if (pages.has(p)) touch(p);
      else load(p);
    }
    evict(keep);
  }

  return {
    setQuery,
    ensure,
    // the row's attributes when its page is loaded, else undefined
    row(i) {
      const page = pages.get(pageOf(i));
      return page?.status === "ok" ? page.rows.get(ids[i]) : undefined;
    },
    pageStatus: (i) => pages.get(pageOf(i))?.status ?? "none",
    retry(i) {
      const p = pageOf(i);
      if (pages.get(p)?.status === "error") { pages.delete(p); load(p); }
    },
    // the fields to fetch (the visible columns plus the object id); a change reloads the pages
    setOutFields(fields) {
      const next = [...new Set(fields)];
      if (next.join(",") === outFields.join(",")) return;
      outFields = next;
      dropPages();
      onChange("rows");
    },
    // reload the rows (after an edit), keeping the id list
    refresh() { dropPages(); onChange("rows"); },
    indexOf(oid) {
      if (!index) index = new Map(ids.map((id, i) => [id, i]));
      return index.get(oid) ?? -1;
    },
    abort() { seq++; controller?.abort(); dropPages(); },
    get ids() { return ids; },
    get total() { return ids.length; },
    get status() { return status; },
    get error() { return error; },
    get info() { return info; },
    get loadedPages() { return [...pages.entries()].filter(([, p]) => p.status === "ok").map(([n]) => n); },
  };
}

// ---- the layer backend (FeatureLayer and anything with queryObjectIds / queryFeatures)
// Whether a layer's server returns ids in orderByFields order, learned once per layer (see orderedIds).
const honorsOrder = new WeakMap();

// opts: { objectIdField, onRequest(kind) (counts requests for viewer.table.requests), idPage, checkRows, maxIds }
export function createLayerBackend(layer, { objectIdField = layer.objectIdField, onRequest = () => {}, idPage = TABLE.ID_PAGE,
  checkRows = TABLE.ORDER_CHECK_ROWS, maxIds = TABLE.EXPORT_MAX_ROWS * 5 } = {}) {
  const oidLower = String(objectIdField).toLowerCase();
  const caps = () => layer.capabilities?.query ?? {};
  const maxRecords = () => Math.max(1, layer.capabilities?.query?.maxRecordCount ?? layer.maxRecordCount ?? 1000);
  const base = (q) => {
    const out = { where: q.where || "1=1" };
    if (q.geometry) { out.geometry = q.geometry; out.spatialRelationship = "intersects"; }
    if (q.objectIds) out.objectIds = q.objectIds;
    return out;
  };
  const isDefault = (orderBy) => !orderBy?.length || orderBy.every((o) => o.split(/\s+/)[0].toLowerCase() === oidLower);
  const idOf = (f) => f.attributes?.[objectIdField] ?? f.attributes?.[Object.keys(f.attributes ?? {}).find((k) => k.toLowerCase() === oidLower)];

  async function defaultIds(q, signal, desc = false) {
    onRequest("ids");
    const ids = await layer.queryObjectIds(base(q), { signal });
    const sorted = [...(ids ?? [])].sort((a, b) => (typeof a === "number" && typeof b === "number" ? a - b : String(a).localeCompare(String(b))));
    return desc ? sorted.reverse() : sorted;
  }
  // The ordered list read in pages of ids: always in the server's sort order.
  async function pagedIds(q, signal) {
    const num = Math.min(idPage, maxRecords());
    const out = [];
    for (let start = 0; out.length < maxIds; start += num) {
      onRequest("idPage");
      const res = await layer.queryFeatures({ ...base(q), orderByFields: q.orderBy, start, num, outFields: [objectIdField], returnGeometry: false }, { signal });
      const got = res.features.map(idOf);
      out.push(...got);
      if (got.length < num && !res.exceededTransferLimit) break;
      if (!got.length) break;
    }
    return out;
  }

  return {
    // The ordered id list: { ids, path, sortUnsupported }.
    // - the default order (object id only): queryObjectIds, sorted here (one request)
    // - another sort: queryObjectIds with orderByFields (one request). The first time for a layer, its first rows are
    //   also read with a paged, sorted queryFeatures and compared: a server that doesn't sort the id list is then read in
    //   pages of ids instead (path "paged"), every time after for this layer
    // - a layer that can't sort on the server (supportsOrderBy false, or no pagination when its ids aren't sorted):
    //   the default order, sortUnsupported
    async orderedIds(q, { signal } = {}) {
      if (isDefault(q.orderBy)) {
        const desc = /\sdesc$/i.test(q.orderBy?.[0] ?? "");
        return { ids: await defaultIds(q, signal, desc), path: "default", sortUnsupported: false };
      }
      if (caps().supportsOrderBy === false) return { ids: await defaultIds(q, signal), path: "default", sortUnsupported: true };
      let honor = honorsOrder.get(layer);
      if (honor !== false) {
        onRequest("ids");
        const ids = await layer.queryObjectIds({ ...base(q), orderByFields: q.orderBy }, { signal });
        if (honor === undefined && ids.length > 1 && caps().supportsPagination !== false) {
          onRequest("orderCheck");
          const n = Math.min(checkRows, ids.length);
          const head = await layer.queryFeatures({ ...base(q), orderByFields: q.orderBy, start: 0, num: n, outFields: [objectIdField], returnGeometry: false }, { signal });
          honor = head.features.length === n && head.features.every((f, i) => idOf(f) === ids[i]);
          honorsOrder.set(layer, honor);
          if (!honor) console.info(`Attribute table: "${layer.title}" doesn't sort its id list on the server; reading sorted ids in pages instead.`);
        }
        if (honor !== false) return { ids, path: "ids", sortUnsupported: false };
      }
      if (caps().supportsPagination === false) return { ids: await defaultIds(q, signal), path: "default", sortUnsupported: true };
      return { ids: await pagedIds(q, signal), path: "paged", sortUnsupported: false };
    },
    async fetchRows(ids, outFields, { signal } = {}) {
      const rows = new Map();
      const chunk = Math.min(maxRecords(), Math.max(1, ids.length));
      for (let i = 0; i < ids.length; i += chunk) {
        if (signal?.aborted) throw abortError();
        onRequest("rows");
        const res = await layer.queryFeatures({ objectIds: ids.slice(i, i + chunk), outFields, returnGeometry: false }, { signal });
        for (const f of res.features) rows.set(idOf(f), f.attributes);
      }
      return rows;
    },
  };
}

// ---- the in-memory fake, for tests
// rows: attribute objects with the object id field. query.filter(row) narrows (stands in for where / extent);
// orderBy strings "FIELD ASC|DESC" are applied. delays: a queue of milliseconds, one per orderedIds call.
export function createMemoryBackend(rows, { objectIdField = "OBJECTID", delays = [] } = {}) {
  const calls = { ids: 0, rows: 0 };
  const wait = (ms, signal) => new Promise((resolve, reject) => {
    if (!ms) { resolve(); return; }
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); reject(abortError()); }, { once: true });
  });
  return {
    calls,
    async orderedIds(q, { signal } = {}) {
      calls.ids++;
      await wait(delays.shift() ?? 0, signal);
      let list = rows.filter((r) => (q.filter ? q.filter(r) : true));
      if (q.objectIds) list = list.filter((r) => q.objectIds.includes(r[objectIdField]));
      const keys = (q.orderBy ?? [`${objectIdField} ASC`]).map((s) => { const [f, d = "ASC"] = s.split(/\s+/); return { f, d: d.toUpperCase() === "DESC" ? -1 : 1 }; });
      list = [...list].sort((a, b) => {
        for (const { f, d } of keys) {
          const x = a[f], y = b[f];
          if (x === y) continue;
          if (x === null || x === undefined) return 1;
          if (y === null || y === undefined) return -1;
          return (x < y ? -1 : 1) * d;
        }
        return 0;
      });
      return { ids: list.map((r) => r[objectIdField]), path: "memory" };
    },
    async fetchRows(ids, outFields, { signal } = {}) {
      calls.rows++;
      await wait(0, signal);
      const want = new Set(ids);
      const out = new Map();
      for (const r of rows) {
        if (!want.has(r[objectIdField])) continue;
        out.set(r[objectIdField], outFields.includes("*") ? { ...r } : Object.fromEntries(outFields.map((f) => [f, r[f]])));
      }
      return out;
    },
  };
}
