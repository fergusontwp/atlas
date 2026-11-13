import { printTiming } from "./printTiming.js";
import { LEGEND, PRINT } from "./config.js";

const label = (value) => {
  if (value == null) return "";
  if (typeof value !== "object") return String(value);
  if (value.colorName) return [value.colorName, value.bandName].filter(Boolean).join(" — ");
  if (value.value != null) return [value.value, value.unit].filter(Boolean).join(" ");
  const title = value.text ?? value.label ?? value.title;
  if (title) return title;
  if (value.field && value.normField) return `${value.field} / ${value.normField}${value.ratioPercent || value.normByPct ? " (%)" : ""}`;
  return value.field ?? "";
};
const plain = (value) => {
  const doc = new DOMParser().parseFromString(label(value), "text/html");
  return doc.body.textContent.trim();
};

// Snapshot the same ActiveLayerInfos as the on-screen legend, including already-pruned mirrors.
// Swatches are prepared once per framed extent, never on a text edit or Export.
export async function capturePrintLegend(mapEl, signal, timing = printTiming()) {
  const [reactive, symbols, request] = await timing.step("legend SDK imports", () => $arcgis.import([
    "@arcgis/core/core/reactiveUtils.js", "@arcgis/core/symbols/support/symbolUtils.js", "@arcgis/core/request.js",
  ]), { signal, timeoutMs: PRINT.TIMEOUT_MS.READY });
  let legend = mapEl.querySelector("arcgis-legend"), temporary = false;
  if (!legend) {
    legend = document.createElement("arcgis-legend"); legend.referenceElement = mapEl;
    legend.style.cssText = "position:absolute;visibility:hidden;pointer-events:none";
    mapEl.append(legend); temporary = true;
  }
  const images = new Map(); let sequence = 0;
  const toCanvas = async (preview, opacity = 1, signal) => {
    const canvas = document.createElement("canvas"); canvas.width = canvas.height = 96;
    const ctx = canvas.getContext("2d"); ctx.fillStyle = "white"; ctx.fillRect(0, 0, 96, 96); ctx.globalAlpha = opacity;
    const source = preview?.matches?.("svg,canvas,img") ? preview : preview?.querySelector?.("svg,canvas,img");
    if (!source) throw new Error("No printable symbol preview.");
    let image = source, url;
    try {
      if (source instanceof SVGElement) {
        const svg = source.cloneNode(true);
        svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
        // Make picture symbols self-contained, using the SDK request path for credentials/proxies.
        for (const node of svg.querySelectorAll("image")) {
          const href = node.getAttribute("href") ?? node.getAttributeNS("http://www.w3.org/1999/xlink", "href");
          if (href && !href.startsWith("data:")) {
            const response = await timing.step("swatch image fetch", (signal) => request(href, { responseType: "blob", signal }), { signal, timeoutMs: PRINT.TIMEOUT_MS.SWATCH });
            const data = await timing.step("swatch blob read", () => new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(response.data); }), { signal, timeoutMs: PRINT.TIMEOUT_MS.SWATCH });
            node.setAttribute("href", data); node.setAttributeNS("http://www.w3.org/1999/xlink", "href", data);
          }
        }
        url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(svg)], { type: "image/svg+xml" }));
        image = new Image(); image.src = url; await timing.step("swatch image decode", () => image.decode(), { signal, timeoutMs: PRINT.TIMEOUT_MS.SWATCH });
      } else if (source instanceof HTMLImageElement) {
        const response = await timing.step("swatch image fetch", (signal) => request(source.src, { responseType: "blob", signal }), { signal, timeoutMs: PRINT.TIMEOUT_MS.SWATCH });
        url = URL.createObjectURL(response.data); image = new Image(); image.src = url; await timing.step("swatch image decode", () => image.decode(), { signal, timeoutMs: PRINT.TIMEOUT_MS.SWATCH });
      }
      const width = image.naturalWidth || image.width?.baseVal?.value || image.width || 96;
      const height = image.naturalHeight || image.height?.baseVal?.value || image.height || 96;
      // A shared 24-point viewport preserves relative marker sizes (especially size ramps).
      const factor = Math.min(96 / Math.max(32, width), 96 / Math.max(32, height));
      ctx.drawImage(image, (96 - width * factor) / 2, (96 - height * factor) / 2, width * factor, height * factor);
      ctx.getImageData(0, 0, 1, 1); // detect a tainted CIM/picture preview now, rather than during PDF export
      signal.throwIfAborted(); return canvas;
    } catch (error) { canvas.width = canvas.height = 0; throw error; }
    finally { if (url) URL.revokeObjectURL(url); }
  };
  try {
    await timing.step("legend component ready", () => legend.componentOnReady(), { signal, timeoutMs: PRINT.TIMEOUT_MS.READY });
    await timing.step("legend view ready", (signal) => reactive.whenOnce(() => !!legend.view, { signal }), { signal, timeoutMs: PRINT.TIMEOUT_MS.READY });
    const visit = async (info, parents = [], ancestors = []) => {
      // ready means "has entries", not "finished loading" in SDK 5.1. Empty groups/leaves never become ready.
      if (info.layer?.legendEnabled === false || info.layer?.visible === false || info.layerView?.legendEnabled === false || LEGEND.EXCLUDE_TITLES.includes(info.layer?.title)) return [];
      const titles = [...parents, plain(info.title ?? info.layer?.title)].filter(Boolean);
      if (info.children?.length) return (await Promise.all([...info.children].map((child) => visit(child, titles, [...ancestors, info.layer?.uid ?? info.layer?.id])))).flat();
      if (info.layer?.type === "group") return [];
      const layer = { id: String(info.layer?.uid ?? [...ancestors, info.layer?.id].join("/")), title: titles.join(" / "), entries: [] };
      try {
        await timing.step(`legend info ${layer.title} (ready=${info.ready}, legend loading=${legend.loading})`,
          (signal) => reactive.whenOnce(() => info.ready || !legend.loading, { signal }), { signal, timeoutMs: PRINT.TIMEOUT_MS.LAYER });
      } catch (error) {
        if (signal.aborted) throw error;
        layer.entries.push({ label: "Legend unavailable", unavailable: true }); return [layer];
      }
      const add = async (entry, heading = "") => {
        signal.throwIfAborted();
        if (entry.type === "symbol-table") return (await Promise.all(entry.infos.map((child) => add(child, [heading, plain(entry.title)].filter(Boolean).join(" — "))))).flat();
        const row = { label: [heading, plain(entry.label ?? entry.title)].filter(Boolean).join(" — "), image: null };
        const id = `legend-${sequence++}`;
        try {
          let preview = entry.preview;
          if (entry.symbol && !preview) preview = await timing.step(`swatch render ${layer.title}: ${row.label}`, () => symbols.renderPreviewHTML(entry.symbol, {
            ...(entry.symbol.type?.includes("fill") || entry.symbol.type === "simple-line" ? { size: 24 } : {}),
            maxSize: 24, symbolConfig: { isSquareFill: true },
          }), { signal, timeoutMs: PRINT.TIMEOUT_MS.SWATCH });
          else if (entry.src) { preview = new Image(); preview.src = entry.src; }
          else if (entry.type === "relationship-ramp") preview = symbols.renderRelationshipRampPreviewHTML(info.layer.renderer);
          if (preview) images.set(id, await timing.step(`swatch ${layer.title}: ${row.label}`, (signal) => toCanvas(preview, (entry.opacity ?? 1) * (info.opacity ?? 1), signal), { signal, timeoutMs: PRINT.TIMEOUT_MS.SWATCH, onLate: (canvas) => { canvas.width = canvas.height = 0; } }));
          else if (entry.infos?.length && entry.infos.every((stop) => stop.color || Number.isFinite(stop.opacity))) {
            const canvas = document.createElement("canvas"); canvas.width = canvas.height = 96;
            const ctx = canvas.getContext("2d"); ctx.fillStyle = "white"; ctx.fillRect(0, 0, 96, 96);
            const gradient = ctx.createLinearGradient(0, 0, 0, 96);
            entry.infos.forEach((stop, i) => gradient.addColorStop(i / Math.max(1, entry.infos.length - 1), stop.color?.toCss?.(true) ?? `rgba(0,0,0,${stop.opacity})`));
            ctx.globalAlpha = info.opacity; ctx.fillStyle = gradient; ctx.fillRect(20, 0, 56, 96); images.set(id, canvas);
          } else if (entry.infos?.length) return (await Promise.all(entry.infos.map((child) => add(child, row.label)))).flat();
          else throw new Error("Unsupported legend preview.");
          row.image = id;
          if (entry.type?.endsWith("ramp") && entry.infos?.length) {
            const stops = entry.infos.map((stop) => plain(stop.label ?? stop.value)).filter(Boolean);
            row.label = [row.label, ...stops].join("; ");
          }
        } catch (error) {
          if (signal.aborted) throw error;
          timing.sync(`swatch fallback ${layer.title}: ${row.label} (${error.message})`, () => {});
          row.unavailable = true; row.label += " (symbol unavailable)";
        }
        return [row];
      };
      layer.entries = (await Promise.all((info.legendElements ?? []).map((entry) => add(entry)))).flat();
      return layer.entries.length ? [layer] : [];
    };
    const layers = (await Promise.all([...(legend.activeLayerInfos ?? [])].map((info) => visit(info)))).flat();
    return { layers, images, dispose() { images.forEach((canvas) => { canvas.width = canvas.height = 0; }); images.clear(); } };
  } catch (error) { images.forEach((canvas) => { canvas.width = canvas.height = 0; }); throw error; }
  finally { if (temporary) legend.remove(); }
}
