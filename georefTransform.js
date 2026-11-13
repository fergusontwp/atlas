// Pure transform maths for georeferencing a plan sheet. No DOM and no SDK imports, so it can be tested alone.
// Ported from georeferencer/js/lib/core.js (that app is untouched).
//
// Conventions (the same as the georeferencer, and not up for change):
//   - Page space is PDF points (1/72 in), origin top-left, y pointing DOWN. Control points are stored in page space
//     ({ id, x, y, X, Y, use }, X and Y in the working CRS) so they survive a change of crop or DPI.
//   - Map space is the working CRS, y UP, in US survey feet.
//   - A transform maps page space to map space:  X = a*x + b*y + c,  Y = d*x + e*y + f.
//     Similarity fits have d = b and e = -a (rotation, one scale, and the flip between y down and y up).

// Meters per US survey foot. The one place this constant lives.
export const US_SURVEY_FOOT_M = 1200 / 3937;

const RAD_TO_DEG = 180 / Math.PI;

export function mkT(type, a, b, c, d, e, f) {
  return { type, a, b, c, d, e, f };
}

export const applyT = (T, x, y) => [T.a * x + T.b * y + T.c, T.d * x + T.e * y + T.f];

// The inverse as { det, toPage(X, Y) }, or null when the transform is singular.
export function invertT(T) {
  const det = T.a * T.e - T.b * T.d;
  if (!(Math.abs(det) > 1e-18)) return null;
  return {
    det,
    toPage: (X, Y) => {
      const px = X - T.c;
      const py = Y - T.f;
      return [(T.e * px - T.b * py) / det, (-T.d * px + T.a * py) / det];
    },
  };
}

// Derived numbers for display: scales, ground units per page point, rotation, determinant.
export function describeT(T) {
  const scaleX = Math.hypot(T.a, T.d);
  const scaleY = Math.hypot(T.b, T.e);
  return {
    scaleX,
    scaleY,
    perPt: T.type === "affine" ? Math.sqrt(Math.abs(T.a * T.e - T.b * T.d)) : scaleX,
    rotationDeg: Math.atan2(T.d, T.a) * RAD_TO_DEG,
    det: T.a * T.e - T.b * T.d,
  };
}

function centroids(pts) {
  const n = pts.length;
  let mx = 0, my = 0, MX = 0, MY = 0;
  for (const p of pts) {
    mx += p.x; my += p.y; MX += p.X; MY += p.Y;
  }
  return [mx / n, my / n, MX / n, MY / n];
}

// Least-squares similarity (shift, rotation and ONE uniform scale), closed form on centred coordinates. With
// lockedPerPt > 0 the scale is fixed and only rotation and shift are fitted ("locked"). Needs two points.
export function fitSimilarity(pts, lockedPerPt) {
  if (pts.length < 2) return null;
  const [mx, my, MX, MY] = centroids(pts);
  let A = 0, B = 0, D = 0;
  for (const p of pts) {
    const u = p.x - mx, v = p.y - my, qx = p.X - MX, qy = p.Y - MY;
    A += qx * u - qy * v;
    B += qx * v + qy * u;
    D += u * u + v * v;
  }
  if (!(D > 1e-9)) return null;
  let a, b;
  if (lockedPerPt > 0) {
    const th = Math.atan2(B, A);
    a = lockedPerPt * Math.cos(th);
    b = lockedPerPt * Math.sin(th);
  } else {
    a = A / D;
    b = B / D;
  }
  return mkT(lockedPerPt > 0 ? "locked" : "similarity", a, b, MX - (a * mx + b * my), b, -a, MY - (b * mx - a * my));
}

// Full 6-parameter affine (normal equations on centred coordinates, Cramer's rule). Needs three points that aren't
// in a line; null otherwise.
export function fitAffine(pts) {
  if (pts.length < 3) return null;
  const [mx, my, MX, MY] = centroids(pts);
  let Suu = 0, Suv = 0, Svv = 0, Sux = 0, Svx = 0, Suy = 0, Svy = 0;
  for (const p of pts) {
    const u = p.x - mx, v = p.y - my, qx = p.X - MX, qy = p.Y - MY;
    Suu += u * u; Suv += u * v; Svv += v * v;
    Sux += u * qx; Svx += v * qx; Suy += u * qy; Svy += v * qy;
  }
  const det = Suu * Svv - Suv * Suv;
  if (!(det > 1e-9 * Math.max(Suu * Svv, 1e-12))) return null;
  const a = (Svv * Sux - Suv * Svx) / det;
  const b = (Suu * Svx - Suv * Sux) / det;
  const d = (Svv * Suy - Suv * Svy) / det;
  const e = (Suu * Svy - Suv * Suy) / det;
  return mkT("affine", a, b, MX - a * mx - b * my, d, e, MY - d * mx - e * my);
}

// type: "similarity" | "locked" | "affine". "locked" needs perPtForLock (ground feet per page point); without it
// the fit falls back to a similarity.
export function fitTransform(pts, type, perPtForLock) {
  if (type === "affine") return fitAffine(pts);
  if (type === "locked" && perPtForLock > 0) return fitSimilarity(pts, perPtForLock);
  return fitSimilarity(pts, 0);
}

// Fewest points a fit type can use.
export const minPoints = (type) => (type === "affine" ? 3 : 2);
