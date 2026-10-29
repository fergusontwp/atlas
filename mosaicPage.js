import { mosaicContent, mul, viewCorners, viewMatrix, viewTouches } from "./mosaicModel.js";
import { openPage } from "./pdfRaster.js";
import { previewScale } from "./pageRaster.js";
import { GEOREF } from "./config.js";

// The plan mosaic as a page: the same record pdfRaster.openPage gives ({ page, pageWidthPt, pageHeightPt, preview,
// content }) with `page` a stand-in for a pdf.js page whose getViewport and render draw the mosaic (mosaicModel.js) in
// mosaic points. So everything after the sheet step (the working render, the close-ups, Review's pieces, the line weight)
// renders the mosaic from the PDF itself, at any resolution, exactly as it renders a page, and never as one big canvas:
// render() draws only the views that touch the canvas, each its source page through its clip.
//
// render({ canvasContext, viewport, transform }): as pdf.js (6.4.299) takes it. Each view, in road order, is rendered into
// a canvas of its own (its part of the target only), clipped to the view's rectangle, with transform = outer ∘ view (pdf.js
// applies it on top of the context's transform), and laid on the target with "darken": where views overlap, the darker
// pixel wins, so the white margins of a clip (a turned view's corners) never hide the line work of the view under it.
// The target is white to start with (as every render here is).
export async function openMosaicPage(pdf, def) {
  const pages = {};
  for (const n of [...new Set(def.views.map((v) => v.page))]) pages[n] = await openPage(pdf, n);
  const W = def.page_size_pt.w, H = def.page_size_pt.h;

  const page = {
    getViewport: ({ scale = 1 } = {}) => ({ scale, width: W * scale, height: H * scale, transform: [scale, 0, 0, scale, 0, 0] }),
    render({ canvasContext: ctx, viewport, transform = [1, 0, 0, 1, 0, 0] }) {
      let cancelled = false, current = null;
      const promise = (async () => {
        const outer = mul(transform, viewport.transform); // mosaic points -> canvas pixels (a scale and a shift)
        const kx = outer[0], ky = outer[3];
        const region = { x0: -outer[4] / kx, y0: -outer[5] / ky, x1: (ctx.canvas.width - outer[4]) / kx, y1: (ctx.canvas.height - outer[5]) / ky };
        for (const v of def.views) {
          if (cancelled) break;
          if (!viewTouches(v, region)) continue;
          // the view's corners on the canvas, and the part of the canvas they cover (whole pixels)
          const cs = viewCorners(v).map(([x, y]) => [outer[0] * x + outer[2] * y + outer[4], outer[1] * x + outer[3] * y + outer[5]]);
          const x0 = Math.max(0, Math.floor(Math.min(...cs.map((c) => c[0])))), y0 = Math.max(0, Math.floor(Math.min(...cs.map((c) => c[1]))));
          const x1 = Math.min(ctx.canvas.width, Math.ceil(Math.max(...cs.map((c) => c[0])))), y1 = Math.min(ctx.canvas.height, Math.ceil(Math.max(...cs.map((c) => c[1]))));
          if (x1 <= x0 || y1 <= y0) continue;
          const tmp = Object.assign(document.createElement("canvas"), { width: x1 - x0, height: y1 - y0 });
          const g = tmp.getContext("2d");
          g.fillStyle = "#fff";
          g.fillRect(0, 0, tmp.width, tmp.height);
          g.beginPath();
          cs.forEach(([x, y], i) => (i ? g.lineTo(x - x0, y - y0) : g.moveTo(x - x0, y - y0)));
          g.closePath();
          g.clip();
          try {
            const src = pages[v.page].page;
            current = src.render({ canvasContext: g, viewport: src.getViewport({ scale: 1 }), transform: mul([1, 0, 0, 1, -x0, -y0], viewMatrix(v, outer)) });
            await current.promise;
            if (cancelled) break;
            ctx.save();
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.globalCompositeOperation = "darken";
            ctx.drawImage(tmp, x0, y0);
            ctx.restore();
          } finally {
            current = null;
            tmp.width = tmp.height = 0;
          }
        }
        if (cancelled) throw Object.assign(new Error("Rendering cancelled"), { name: "RenderingCancelledException" });
      })();
      return { promise, cancel() { cancelled = true; current?.cancel(); } };
    },
  };

  // the whole-mosaic preview the sheet pane shows in the sheet and scale steps, as openPage makes a page's
  const k = previewScale(W, H, GEOREF.PREVIEW_PX);
  const canvas = Object.assign(document.createElement("canvas"), { width: Math.max(1, Math.round(W * k)), height: Math.max(1, Math.round(H * k)) });
  const g = canvas.getContext("2d");
  g.fillStyle = "#fff";
  g.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: g, viewport: page.getViewport({ scale: k }) }).promise;

  const content = mosaicContent(def.views, Object.fromEntries(Object.entries(pages).map(([n, p]) => [n, p.content])));
  return { page, pageWidthPt: W, pageHeightPt: H, preview: { canvas, k }, content, mosaic: def, sources: pages };
}
