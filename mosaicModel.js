// The plan mosaic's definition and geometry: pure, no DOM, no pdf.js. Tested.
//
// A mosaic is several views (map windows) clipped from the pages of one PDF and joined into one long sheet. It is kept
// in PDF points, independent of any render: each view is its clip (page, rect_pt { x, y, w, h } in page points, y down)
// and a similarity transform_pt { a, b, tx, ty } from view points (origin at the clip's top-left) to mosaic points
//     X = a·x − b·y + tx,   Y = b·x + a·y + ty       (the same form as joinSeam.T)
// with the mosaic's origin at its top-left. At any render scale s (pixels per point), mosaic px = s × mosaic pt, so it
// can be rendered again from the PDF at any resolution (mosaicPage.js). The join works in pixels of the clips rendered
// at one scale s; defFromJoin turns that into points.

const T = (t, x, y) => [t.a * x - t.b * y + t.tx, t.b * x + t.a * y + t.ty];

// A station "13+50" (or plain feet "1350") in feet, or null.
export function parseStation(s) {
  const m = /^\s*(\d+)\s*\+\s*(\d{1,2}(?:\.\d+)?)\s*$/.exec(s || "");
  if (m) return parseInt(m[1], 10) * 100 + parseFloat(m[2]);
  return /^\s*\d+(?:\.\d+)?\s*$/.test(s || "") ? parseFloat(s) : null;
}
// Feet as a station: 1350 -> "13+50".
export function fmtSta(ft) {
  if (ft === null || ft === undefined || !Number.isFinite(ft)) return "";
  const h = Math.floor(ft / 100), r = ft - h * 100;
  return `${h}+${r < 10 ? "0" : ""}${Math.round(r * 100) / 100}`;
}

// The corners [TL, TR, BR, BL] of a view in mosaic points.
export const viewCorners = (v) => [[0, 0], [v.rect_pt.w, 0], [v.rect_pt.w, v.rect_pt.h], [0, v.rect_pt.h]].map(([x, y]) => T(v.transform_pt, x, y));

// The mosaic's extent in points: { x0, y0, x1, y1, w, h }.
export function mosaicBounds(views) {
  const cs = views.flatMap(viewCorners);
  const x0 = Math.min(...cs.map((c) => c[0])), y0 = Math.min(...cs.map((c) => c[1]));
  const x1 = Math.max(...cs.map((c) => c[0])), y1 = Math.max(...cs.map((c) => c[1]));
  return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0 };
}

// The definition from the join: clips [{ label, page, rect_pt }] and, for each placed view, its transform in pixels
// [{ a, b, tx, ty }] (view px -> mosaic px, both at s px per point, any origin) and its seam record. The result's
// mosaic origin is its top-left corner. { version, pdf_name, pdf_size, join_scale, page_size_pt: { w, h }, views }
export function defFromJoin({ pdfName, pdfSize, s, clips, placed }) {
  const views = placed.map((p, i) => ({
    label: clips[i].label, page: clips[i].page, rect_pt: { ...clips[i].rect_pt },
    transform_pt: { a: p.a, b: p.b, tx: p.tx / s, ty: p.ty / s }, seam: p.seam ?? null,
  }));
  const b = mosaicBounds(views);
  for (const v of views) { v.transform_pt.tx -= b.x0; v.transform_pt.ty -= b.y0; }
  return { version: 1, pdf_name: pdfName, pdf_size: pdfSize ?? null, join_scale: s, page_size_pt: { w: b.w, h: b.h }, views };
}

// Whether a view's rectangle in the mosaic touches the rectangle r { x0, y0, x1, y1 } (mosaic points): a box test on
// its corners, enough to skip views that are far away.
export function viewTouches(v, r) {
  const cs = viewCorners(v), xs = cs.map((c) => c[0]), ys = cs.map((c) => c[1]);
  return Math.max(...xs) >= r.x0 && Math.min(...xs) <= r.x1 && Math.max(...ys) >= r.y0 && Math.min(...ys) <= r.y1;
}

// The canvas matrix [a, b, c, d, e, f] (as ctx.transform takes it) that draws a view's page, in page points, into the
// mosaic: outer ∘ transform_pt ∘ translate(−rect.x, −rect.y). outer: mosaic points -> canvas pixels, [a, b, c, d, e, f].
export function viewMatrix(v, outer) {
  const t = v.transform_pt, r = v.rect_pt;
  const inner = [t.a, t.b, -t.b, t.a, t.tx - (t.a * r.x - t.b * r.y), t.ty - (t.b * r.x + t.a * r.y)];
  return mul(outer, inner);
}
export function mul(m, n) {
  return [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
}

// What the mosaic paints, for the native-detail ceiling (pageRaster.renderDpi): each source page's content
// (readPageContent: { images: [{ w, h, m, dpi }], vector }) seen through each view that uses it. An image's m (its unit
// square to page points) is carried into mosaic points; images outside the clip are left out (a box test); dpi is
// unchanged (the transform is a rotation, scale 1). vector: the views' pages' counts, each page once.
export function mosaicContent(views, contentByPage) {
  const images = [];
  let vector = 0, any = false;
  const seen = new Set();
  for (const v of views) {
    const c = contentByPage[v.page];
    if (!c) continue;
    any = true;
    if (!seen.has(v.page)) { seen.add(v.page); vector += c.vector; }
    const r = v.rect_pt, M = viewMatrix(v, [1, 0, 0, 1, 0, 0]);
    for (const im of c.images) {
      const m = im.m, ps = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([u, w]) => [m[0] * u + m[2] * w + m[4], m[1] * u + m[3] * w + m[5]]);
      const xs = ps.map((p) => p[0]), ys = ps.map((p) => p[1]);
      if (Math.max(...xs) < r.x || Math.min(...xs) > r.x + r.w || Math.max(...ys) < r.y || Math.min(...ys) > r.y + r.h) continue;
      images.push({ ...im, m: mul(M, m) });
    }
  }
  return any ? { images, vector } : null;
}

// ---- the saved block (transform_json.mosaic, on every piece of the plan; Jackson, 2026-10-26)
// { version, pdf_name, pdf_size, join_scale, page_size_pt, views: [{ label, page, rect_pt, transform_pt, seam }] }
const num = (v) => typeof v === "number" && Number.isFinite(v);
export const mosaicBlock = (def) => (def ? JSON.parse(JSON.stringify({
  version: def.version ?? 1, pdf_name: def.pdf_name, pdf_size: def.pdf_size ?? null, join_scale: def.join_scale ?? null,
  page_size_pt: def.page_size_pt, views: def.views.map(({ label, page, rect_pt, transform_pt, seam }) => ({ label, page, rect_pt, transform_pt, seam: seam ?? null })),
})) : null);

// The definition back from a saved block, or null when it isn't one this version can use.
export function readMosaicBlock(b) {
  if (!b || typeof b !== "object" || !Array.isArray(b.views) || !b.views.length || (b.version ?? 1) > 1) return null;
  const ok = b.views.every((v) => Number.isInteger(v.page) && v.page >= 1 && v.rect_pt && ["x", "y", "w", "h"].every((k) => num(v.rect_pt[k]))
    && v.rect_pt.w > 0 && v.rect_pt.h > 0 && v.transform_pt && ["a", "b", "tx", "ty"].every((k) => num(v.transform_pt[k])));
  if (!ok) return null;
  const views = b.views.map((v) => ({ label: String(v.label ?? ""), page: v.page, rect_pt: { ...v.rect_pt }, transform_pt: { ...v.transform_pt }, seam: v.seam ?? null }));
  const bb = mosaicBounds(views);
  return { version: 1, pdf_name: b.pdf_name ?? "", pdf_size: b.pdf_size ?? null, join_scale: b.join_scale ?? null, page_size_pt: { w: bb.w, h: bb.h }, views };
}
