/**
 * ImWeb Structured Light — auto projection map: fit ProjMapMesh from a scan.
 *
 * Put the camera where the audience is. Then "the picture looks right from the
 * audience" means: content point (s, t) appears at camera point q(s, t) — a
 * target rectangle in the camera image. The scan already says which projector
 * pixel lights the surface the camera sees at q, so each mesh node is simply
 * that projector pixel. It uses the camera→projector map directly: no
 * inversion, no lens model, no depth. The same holds on any surface shape; a
 * finer grid follows it more closely, and the residual says how closely.
 *
 * Output is in ProjMapMesh's own convention — OUTPUT-WINDOW fractions, y down
 * — which equals projector pixels / projector size only while the output
 * window is fullscreen on the projector. That is the same condition the scan
 * itself requires, so it holds by construction when both are used together.
 *
 * Pure, like the rest of the scan code; ProjMapMesh is imported only to score
 * a fit with the very sample() the renderer draws from, so the residual is a
 * statement about the picture, not about a second copy of the surface maths.
 */

import { ProjMapMesh } from '../inputs/ProjMapMesh.js';

/** Solve A x = b in place (Gaussian elimination, partial pivoting). A is n×n
 *  row-major. Returns null when singular. */
function solve(A, b, n) {
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r * n + c]) > Math.abs(A[piv * n + c])) piv = r;
    if (Math.abs(A[piv * n + c]) < 1e-12) return null;
    if (piv !== c) {
      for (let k = 0; k < n; k++) { const t = A[c * n + k]; A[c * n + k] = A[piv * n + k]; A[piv * n + k] = t; }
      const t = b[c]; b[c] = b[piv]; b[piv] = t;
    }
    for (let r = c + 1; r < n; r++) {
      const f = A[r * n + c] / A[c * n + c];
      if (!f) continue;
      for (let k = c; k < n; k++) A[r * n + k] -= f * A[c * n + k];
      b[r] -= f * b[c];
    }
  }
  const x = new Float64Array(n);
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r];
    for (let k = r + 1; k < n; k++) s -= A[r * n + k] * x[k];
    x[r] = s / A[r * n + r];
  }
  return x;
}

export function applyH(H, u, v) {
  const w = H[6] * u + H[7] * v + H[8];
  return [(H[0] * u + H[1] * v + H[2]) / w, (H[3] * u + H[4] * v + H[5]) / w];
}

/** Similarity that moves the centroid to 0 and the mean radius to √2
 *  (Hartley). Measured, not assumed: on EXACT data the pivoted solve finds
 *  the homography with or without it (a mutation removing it passes the
 *  audit), but on quantised + ±1 px noisy data it cuts the corner error from
 *  0.063 to 0.043 px at 1280x720→1920x1080 and 0.051 to 0.042 at 4K. An
 *  accuracy gain, too small a gap to pin in a test without a threshold
 *  tuned to sit between two runs — so it is recorded here instead. */
function normaliser(a, b, idx) {
  let ma = 0;
  let mb = 0;
  for (const i of idx) { ma += a[i]; mb += b[i]; }
  ma /= idx.length; mb /= idx.length;
  let r = 0;
  for (const i of idx) r += Math.hypot(a[i] - ma, b[i] - mb);
  const s = Math.SQRT2 / ((r / idx.length) || 1);
  return { s, ma, mb };
}

function fitHOnce(cu, cv, px, py, idx) {
  const nc = normaliser(cu, cv, idx);
  const np = normaliser(px, py, idx);
  const A = new Float64Array(64);
  const b = new Float64Array(8);
  const row = new Float64Array(8);
  const acc = (rhs) => {
    for (let r = 0; r < 8; r++) {
      if (!row[r]) continue;
      for (let c = 0; c < 8; c++) A[r * 8 + c] += row[r] * row[c];
      b[r] += row[r] * rhs;
    }
  };
  for (const i of idx) {
    const u = (cu[i] - nc.ma) * nc.s;
    const v = (cv[i] - nc.mb) * nc.s;
    const x = (px[i] - np.ma) * np.s;
    const y = (py[i] - np.mb) * np.s;
    row.set([u, v, 1, 0, 0, 0, -u * x, -v * x]); acc(x);
    row.set([0, 0, 0, u, v, 1, -u * y, -v * y]); acc(y);
  }
  const h = solve(A, b, 8);
  if (!h) return null;
  // H = Tp⁻¹ · H' · Tc
  const Hn = [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
  const Tc = [nc.s, 0, -nc.s * nc.ma, 0, nc.s, -nc.s * nc.mb, 0, 0, 1];
  const Tpi = [1 / np.s, 0, np.ma, 0, 1 / np.s, np.mb, 0, 0, 1];
  const mul = (P, Q) => {
    const R = new Array(9).fill(0);
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) for (let k = 0; k < 3; k++) R[r * 3 + c] += P[r * 3 + k] * Q[k * 3 + c];
    return R;
  };
  const H = mul(Tpi, mul(Hn, Tc));
  return H.map(v => v / H[8]);
}

/**
 * Least-squares homography camera → projector over every valid pixel, with
 * one trimming pass (drop residuals above 3x the median, min 1 px) so a few
 * bad decodes cannot tilt it. `stride` subsamples for speed.
 */
export function fitHomography(res, { stride = 2 } = {}) {
  const { camW, camH, x, y, valid } = res;
  const cu = new Float64Array(camW * camH);
  const cv = new Float64Array(camW * camH);
  let idx = [];
  for (let v = 0; v < camH; v += stride) for (let u = 0; u < camW; u += stride) {
    const i = v * camW + u;
    if (!valid[i]) continue;
    cu[i] = u + 0.5; cv[i] = v + 0.5;
    idx.push(i);
  }
  if (idx.length < 8) return null;
  let H = fitHOnce(cu, cv, x, y, idx);
  if (!H) return null;
  const r = idx.map(i => { const p = applyH(H, cu[i], cv[i]); return Math.hypot(p[0] - x[i], p[1] - y[i]); });
  const med = Float64Array.from(r).sort()[r.length >> 1];
  const cut = Math.max(1, 3 * med);
  const kept = idx.filter((_, k) => r[k] <= cut);
  if (kept.length >= 8 && kept.length < idx.length) {
    const H2 = fitHOnce(cu, cv, x, y, kept);
    if (H2) H = H2;
  }
  return H;
}

/**
 * Projector position of camera point (qu, qv) from the valid pixels around
 * it: Gaussian-weighted QUADRATIC least squares, radius R. Quadratic, not
 * affine: a projective map is curved, and an affine fit averages its
 * curvature into the value at the centre — measured 0.075 px off a true
 * homography at 5x5. The price is extrapolation: fitted from one side of a
 * hole, a quadratic lands 1.3 px off (the audit's shadow node) where affine
 * was 0.19 — so the support must SURROUND the point wherever the frame does.
 *
 * Null (caller grows R, then falls back) when:
 *   - fewer than 24 valid pixels;
 *   - any quadrant that lies inside the frame is under 30% valid — a hole on
 *     that side. Quadrants OUTSIDE the frame are ignored: at a frame edge or
 *     corner the data is one-sided by geometry, and the quadratic is exact
 *     there (measured on the homography wall).
 * Points beyond the frame never get here (fitProjectionMesh tests that
 * explicitly). A centroid-offset test used to sit alongside these; with the
 * frame test and the quadrant rule in place no input could reach it, and a
 * mutation run proved it by deleting it and watching nothing change.
 */
function localQuadratic(res, qu, qv, R) {
  const { camW, camH, x, y, valid } = res;
  const s2 = 2 * (R / 2) ** 2;
  const M = new Float64Array(36);
  const bx = new Float64Array(6);
  const by = new Float64Array(6);
  const inQ = [0, 0, 0, 0];
  const okQ = [0, 0, 0, 0];
  let n = 0;
  const u0 = Math.max(0, Math.floor(qu - R));
  const u1 = Math.min(camW - 1, Math.ceil(qu + R));
  const v0 = Math.max(0, Math.floor(qv - R));
  const v1 = Math.min(camH - 1, Math.ceil(qv + R));
  for (let v = v0; v <= v1; v++) for (let u = u0; u <= u1; u++) {
    const i = v * camW + u;
    const du = u + 0.5 - qu;
    const dv = v + 0.5 - qv;
    const d2 = du * du + dv * dv;
    if (d2 > R * R) continue;
    const quad = (du >= 0 ? 1 : 0) + (dv >= 0 ? 2 : 0);
    inQ[quad]++;
    if (!valid[i]) continue;
    okQ[quad]++;
    const w = Math.exp(-d2 / s2);
    const a = du / R, b = dv / R;       // unit scale keeps the 6x6 conditioned
    const f = [1, a, b, a * a, a * b, b * b];
    for (let r = 0; r < 6; r++) {
      for (let c = 0; c < 6; c++) M[r * 6 + c] += w * f[r] * f[c];
      bx[r] += w * f[r] * x[i];
      by[r] += w * f[r] * y[i];
    }
    n++;
  }
  if (n < 24) return null;
  for (let k = 0; k < 4; k++) if (inQ[k] >= 8 && okQ[k] < 0.3 * inQ[k]) return null;
  const ax = solve(Float64Array.from(M), bx, 6);
  const ay = solve(Float64Array.from(M), by, 6);
  if (!ax || !ay) return null;
  return [ax[0], ay[0], n];
}

const rectOf = (res, rect) => rect ?? { u0: 0, v0: 0, u1: res.camW, v1: res.camH };

/**
 * How far the fitted mesh puts the picture from where the scan says it
 * should be, over every valid camera pixel inside the target rectangle, in
 * projector pixels. Scored through ProjMapMesh.sample() — the renderer's own
 * surface.
 */
export function meshResidual(mesh, res, rect = null, stride = 2) {
  const R = rectOf(res, rect);
  const { camW, camH, projW, projH, x, y, valid } = res;
  const errs = [];
  for (let v = 0; v < camH; v += stride) for (let u = 0; u < camW; u += stride) {
    const i = v * camW + u;
    if (!valid[i]) continue;
    const s = (u + 0.5 - R.u0) / (R.u1 - R.u0);
    const t = (v + 0.5 - R.v0) / (R.v1 - R.v0);
    if (s < 0 || s > 1 || t < 0 || t > 1) continue;
    const p = mesh.sample(s, t);
    errs.push(Math.hypot(p.x * projW - x[i], p.y * projH - y[i]));
  }
  if (!errs.length) return { n: 0, rms: NaN, p95: NaN, max: NaN };
  const sorted = Float64Array.from(errs).sort();
  let ss = 0;
  for (const e of errs) ss += e * e;
  return { n: errs.length, rms: Math.sqrt(ss / errs.length),
           p95: sorted[Math.floor(0.95 * (sorted.length - 1))], max: sorted[sorted.length - 1] };
}

/**
 * Fit a cols×rows ProjMapMesh (curve 0) so content fills `rect` of the camera
 * image — by default the whole camera frame — undistorted from the camera.
 *
 * 2x2 takes its corners from the global homography: a 2x2 mesh IS one
 * projective quad, so the least-squares homography is its best fit, where
 * reading the four corner pixels would trust the four noisiest places in the
 * scan. Above 2x2 every node is a local quadratic fit around its camera point;
 * a node with no trustworthy support (off the surface, beyond the frame, deep
 * in a shadow) falls back to the global homography and is listed in
 * `extrapolated`, so the UI can say which handles were guessed.
 */
export function fitProjectionMesh(res, { cols = 5, rows = 5, rect = null, H = null } = {}) {
  const R = rectOf(res, rect);
  H = H ?? fitHomography(res);
  const spacing = Math.min((R.u1 - R.u0) / (cols - 1), (R.v1 - R.v0) / (rows - 1));
  const r0 = Math.max(3, 0.5 * spacing);
  const rMax = Math.max(res.camW, res.camH) / 2;
  const pts = [];
  const extrapolated = [];
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    const qu = R.u0 + (R.u1 - R.u0) * i / (cols - 1);
    const qv = R.v0 + (R.v1 - R.v0) * j / (rows - 1);
    let p = null;
    // Beyond the camera frame there is nothing local to fit — said explicitly
    // rather than left to the centroid test, which a big enough radius fools.
    // Inside it, the radius doubles until the support surrounds the node: a
    // node inside a hole needs a radius larger than the hole, and capping it
    // at 4x spacing sent the six shadow nodes of a 17x17 to the global
    // homography, 2-3 px off a surface it knows nothing about.
    const inFrame = qu >= 0 && qu <= res.camW && qv >= 0 && qv <= res.camH;
    if ((cols > 2 || rows > 2) && inFrame) {
      for (let r = r0; r <= rMax; r *= 2) { p = localQuadratic(res, qu, qv, r); if (p) break; }
    }
    if (!p) {
      if (!H) throw new Error('no homography: too few valid pixels in the scan');
      p = applyH(H, qu, qv);
      if (cols > 2 || rows > 2) extrapolated.push(j * cols + i);
    }
    pts.push({ x: p[0] / res.projW, y: p[1] / res.projH });
  }
  const mesh = new ProjMapMesh(2, 2);
  mesh.deserialize({ cols, rows, pts: pts.map(p => [p.x, p.y]) });
  return { cols, rows, pts, extrapolated, mesh, H, residual: meshResidual(mesh, res, rect) };
}

/**
 * The smallest square grid whose p95 residual is within `tol` projector
 * pixels, from 2x2 up to 17x17 (ProjMapMesh's limit). Returns that fit plus
 * every size tried, so the UI can show the trade rather than just the pick.
 * If nothing reaches tol, the finest fit is returned with `met: false`.
 */
export function fitAuto(res, { tol = 1, rect = null, sizes = [2, 3, 5, 9, 17] } = {}) {
  const H = fitHomography(res);
  const tried = [];
  let fit = null;
  for (const n of sizes) {
    fit = fitProjectionMesh(res, { cols: n, rows: n, rect, H });
    tried.push({ n, p95: fit.residual.p95, rms: fit.residual.rms, extrapolated: fit.extrapolated.length });
    if (fit.residual.p95 <= tol) return { ...fit, tried, met: true };
  }
  return { ...fit, tried, met: false };
}
