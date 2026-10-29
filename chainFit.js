// Placing a long plan sheet on the ground: one rigid placement for the whole sheet, or a chain of pieces, one per pair of
// neighbouring pins. Ported from reference/plan-tools/plan-placer.html (the numbers, not the page). No DOM and no SDK
// imports; everything is planar in the working CRS (GEOREF.WORKING_WKID, US survey feet).
//
// Sheet pixels to ground is a similarity transform written with complex numbers, w = m·z + t:
//   z = (col − W/2) + i·(−(row − H/2))      sheet pixels, centred, y up
//   w = easting + i·northing
//   m = fpp·e^(−iθ)                         fpp: feet per sheet pixel; θ: clockwise rotation in degrees
// A placement is T = { cx, cy, fpp, theta }: the ground point under the sheet's centre, the scale and the rotation.
//
// A pin ties a sheet spot to a ground spot: { id, sheet_px: [col, row], target_xy: [x, y] } (the shape transform_json
// stores). The sheet is { W, H } in the same pixels as sheet_px.
//
// Chain mode: pins sorted by column; piece k runs between pin k and pin k+1 and is fitted rigidly through those two. The
// first piece reaches the sheet's left edge (column 0), the last its right edge (column W). Neighbouring pieces meet at
// their shared pin's column; seamStats says how much they disagree along that cut.

const rad = (d) => (d * Math.PI) / 180;
const wrap180 = (d) => ((((d + 180) % 360) + 360) % 360) - 180;

const zOf = (pin, sheet) => ({ re: pin.sheet_px[0] - sheet.W / 2, im: -(pin.sheet_px[1] - sheet.H / 2) });
const wOf = (pin) => ({ re: pin.target_xy[0], im: pin.target_xy[1] });
const mean = (a) => ({ re: a.reduce((s, z) => s + z.re, 0) / a.length, im: a.reduce((s, z) => s + z.im, 0) / a.length });
const mul = (a, b) => ({ re: a.re * b.re - a.im * b.im, im: a.re * b.im + a.im * b.re });
// T from m and t (w = m·z + t)
const toT = (m, t) => ({ cx: t.re, cy: t.im, fpp: Math.hypot(m.re, m.im), theta: (-Math.atan2(m.im, m.re) * 180) / Math.PI });
const mOf = (fpp, theta) => ({ re: fpp * Math.cos(rad(theta)), im: -fpp * Math.sin(rad(theta)) });

// Sheet pixel (col, row) to ground [x, y].
export function sheetToGround(T, sheet, col, row) {
  const c = Math.cos(rad(T.theta)), s = Math.sin(rad(T.theta)), u = col - sheet.W / 2, v = row - sheet.H / 2;
  return [T.cx + T.fpp * (u * c - v * s), T.cy + T.fpp * (-u * s - v * c)];
}

// Ground [x, y] to sheet pixel [col, row].
export function groundToSheet(T, sheet, x, y) {
  const c = Math.cos(rad(T.theta)), s = Math.sin(rad(T.theta)), dx = (x - T.cx) / T.fpp, dy = (y - T.cy) / T.fpp;
  return [dx * c - dy * s + sheet.W / 2, -dx * s - dy * c + sheet.H / 2];
}

// One rigid fit through two pins. allowScale: exact at both pins (the scale follows them). Otherwise the scale stays at
// fppStated and the two pins are matched at their midpoint, so each misses by half the length difference. null when the
// pins are closer than minPinPx sheet pixels (no direction to fit). opts: { sheet: { W, H }, allowScale, fppStated, minPinPx }.
export function fitPair(pinA, pinB, { sheet, allowScale = true, fppStated, minPinPx = 3 }) {
  const z1 = zOf(pinA, sheet), z2 = zOf(pinB, sheet), w1 = wOf(pinA), w2 = wOf(pinB);
  const dz = { re: z2.re - z1.re, im: z2.im - z1.im }, dw = { re: w2.re - w1.re, im: w2.im - w1.im };
  const den = dz.re * dz.re + dz.im * dz.im;
  if (!(den >= minPinPx * minPinPx)) return null;
  let m = { re: (dw.re * dz.re + dw.im * dz.im) / den, im: (dw.im * dz.re - dw.re * dz.im) / den };
  let zc = z1, wc = w1;
  if (!allowScale) {
    const k = fppStated / Math.hypot(m.re, m.im);
    if (!Number.isFinite(k)) return null; // the two targets coincide: no direction
    m = { re: m.re * k, im: m.im * k };
    zc = mean([z1, z2]);
    wc = mean([w1, w2]);
  }
  const mz = mul(m, zc);
  return toT(m, { re: wc.re - mz.re, im: wc.im - mz.im });
}

// The pieces for a set of pins (chain mode). Pins are sorted by column (a copy; the input is not changed).
// Returns { ok: true, pins, pieces } with piece = { k, a, b, c0, c1, T } (a, b: indexes into the sorted pins), or
// { ok: false, reason, pins } where reason is "few-pins" (fewer than 2) or "too-close" (two neighbouring pins less than
// minPinPx columns apart; `ids` names them). opts: { allowScale, fppStated, minPinPx }.
export function buildChain(pins, sheet, opts = {}) {
  const minPinPx = opts.minPinPx ?? 3;
  const sorted = [...pins].sort((p, q) => p.sheet_px[0] - q.sheet_px[0]);
  if (sorted.length < 2) return { ok: false, reason: "few-pins", pins: sorted };
  const pieces = [];
  const n = sorted.length;
  for (let k = 0; k < n - 1; k++) {
    const A = sorted[k], B = sorted[k + 1];
    const T = B.sheet_px[0] - A.sheet_px[0] >= minPinPx ? fitPair(A, B, { ...opts, sheet, minPinPx }) : null;
    if (!T) return { ok: false, reason: "too-close", ids: [A.id, B.id], pins: sorted };
    pieces.push({ k, a: k, b: k + 1, c0: k === 0 ? 0 : A.sheet_px[0], c1: k === n - 2 ? sheet.W : B.sheet_px[0], T });
  }
  return { ok: true, pins: sorted, pieces };
}

// What a failed chain means, for the Place step (the prototype fell back silently; IMPROVEMENTS.md).
export function chainProblemText(res) {
  if (!res || res.ok) return "";
  if (res.reason === "few-pins") return "Chain mode needs at least two pins.";
  const [a, b] = res.ids ?? [];
  return `Pins ${a} and ${b} are too close together on the sheet to place a piece between them. Move one of them, or delete one.`;
}

// x = A·u + B·v + C, y = D·u + E·v + F, with u right and v down from the sheet's top-left corner, for a pixel q sheet
// pixels wide (q = 1: sheet pixels; q > 1 for a coarser image of the same sheet).
export function affineFromT(T, sheet, q = 1) {
  const c = Math.cos(rad(T.theta)), s = Math.sin(rad(T.theta)), f = T.fpp * q;
  return {
    A: f * c, B: -f * s, C: T.cx + T.fpp * ((-sheet.W / 2) * c + (sheet.H / 2) * s),
    D: -f * s, E: -f * c, F: T.cy + T.fpp * ((sheet.W / 2) * s + (sheet.H / 2) * c),
  };
}

// The ground corners of a piece: top-left, top-right, bottom-right, bottom-left (the order of the SDK's corner
// georeference). A whole-sheet placement is the piece { c0: 0, c1: W, T }.
export function pieceCorners(piece, sheet) {
  const { T, c0, c1 } = piece;
  return [sheetToGround(T, sheet, c0, 0), sheetToGround(T, sheet, c1, 0), sheetToGround(T, sheet, c1, sheet.H), sheetToGround(T, sheet, c0, sheet.H)];
}

// The sheet pixel under a ground point, read through the piece that owns that part of the sheet: the piece whose column
// range holds it, otherwise the nearest by columns (a point in the wedge between two pieces). { piece, col, row }, or
// null with no pieces.
export function locatePiece(pieces, sheet, x, y) {
  let best = null, bestD = Infinity;
  for (const piece of pieces ?? []) {
    const [col, row] = groundToSheet(piece.T, sheet, x, y);
    const d = col < piece.c0 ? piece.c0 - col : col > piece.c1 ? col - piece.c1 : 0;
    if (d < bestD) { bestD = d; best = { piece, col, row }; if (d === 0) break; }
  }
  return best;
}

// How neighbouring pieces disagree along their shared cut (column c, the shared pin's). For each seam:
//   at       the shared pin's id
//   kink     θB − θA, degrees (−180..180)
//   jogPin   feet between where A and B put the shared pin's pixel (0 with an exact fit)
//   jogEdge  the larger of that distance at sheet row 0 and row H
// pins: the sorted pins the pieces index into (buildChain's).
export function seamStats(pieces, sheet, pins) {
  const out = [];
  for (let k = 0; k < pieces.length - 1; k++) {
    const A = pieces[k], B = pieces[k + 1], c = A.c1, pin = pins[A.b];
    const d = (r) => {
      const p = sheetToGround(A.T, sheet, c, r), q = sheetToGround(B.T, sheet, c, r);
      return Math.hypot(p[0] - q[0], p[1] - q[1]);
    };
    out.push({ at: pin.id, kink: wrap180(B.T.theta - A.T.theta), jogPin: d(pin.sheet_px[1]), jogEdge: Math.max(d(0), d(sheet.H)) });
  }
  return out;
}

// One placement for the whole sheet through all the pins (chain mode off): least squares of w = m·z + t. One pin only
// shifts the current placement. With two or more and allowScale off, the scale is held at fppStated (or the current
// placement's) and only the rotation and shift are fitted. opts: { allowScale, current: T, fppStated }.
// Returns T, or null with no pins (or pins that all sit on one sheet spot).
export function fitWhole(pins, sheet, { allowScale = true, current, fppStated } = {}) {
  if (!pins?.length) return null;
  const z = pins.map((p) => zOf(p, sheet)), w = pins.map(wOf), zc = mean(z), wc = mean(w);
  let m;
  if (pins.length === 1) {
    if (!current) return null;
    m = mOf(current.fpp, current.theta);
  } else {
    let nr = 0, ni = 0, den = 0;
    for (let i = 0; i < z.length; i++) {
      const dz = { re: z[i].re - zc.re, im: z[i].im - zc.im }, dw = { re: w[i].re - wc.re, im: w[i].im - wc.im };
      nr += dz.re * dw.re + dz.im * dw.im;
      ni += dz.re * dw.im - dz.im * dw.re;
      den += dz.re * dz.re + dz.im * dz.im;
    }
    if (den < 1e-9) return null;
    m = { re: nr / den, im: ni / den };
    if (!allowScale) {
      const k = (fppStated ?? current?.fpp) / Math.hypot(m.re, m.im);
      if (!Number.isFinite(k)) return null;
      m = { re: m.re * k, im: m.im * k };
    }
  }
  const mz = mul(m, zc);
  return toT(m, { re: wc.re - mz.re, im: wc.im - mz.im });
}
