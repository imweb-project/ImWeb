/**
 * ImWeb Structured Light — bake: from a decoded scan to projector-space maps.
 *
 * Input is GrayDecoder.finish() output (camera space). Everything produced
 * here is in PROJECTOR space, row 0 = TOP, because projector space is where
 * the instrument draws: a mask, an edge or a relief value at projector pixel p
 * lands on the physical point that pixel lights, with no mesh in between.
 * Uploading flips rows (DataTexture row 0 is the bottom — the warp-map
 * convention); that happens at upload, not here.
 *
 * Pure functions on typed arrays, no DOM or GPU, like StructuredLight.js and
 * for the same reason: one definition, testable against the synthetic rig.
 *
 * Units: camera-space values (the inverted map, relief) are CAMERA pixels;
 * distances in the SDF are PROJECTOR pixels.
 */

/**
 * Camera→projector correspondence inverted into projector space by
 * RASTERISING it: the camera grid becomes triangles whose vertices sit at
 * their decoded projector positions, carrying their camera coordinates. The
 * rasteriser interpolates, so small gaps close by construction — and nothing
 * else closes: a triangle is dropped when a vertex is invalid or an edge is
 * longer than maxEdge, which is what a depth step looks like from here (the
 * two sides of the step decode far apart in projector space). A splat-and-fill
 * would bridge exactly those gaps and paint the object onto the wall behind.
 *
 * maxEdge defaults to 3x the median grid-edge length, floored at 3 px.
 * Where triangles overlap, `key` (per camera pixel, higher wins) decides; with
 * no key the first triangle keeps the pixel.
 */
export function invertToProjector(res, { key = null, maxEdge = null } = {}) {
  const { camW: cw, camH: ch, projW: pw, projH: ph, x, y, valid } = res;
  if (maxEdge == null) {
    const lens = [];
    for (let v = 0; v < ch; v++) for (let u = 0; u < cw; u++) {
      const i = v * cw + u;
      if (!valid[i]) continue;
      if (u + 1 < cw && valid[i + 1]) lens.push(Math.hypot(x[i + 1] - x[i], y[i + 1] - y[i]));
      if (v + 1 < ch && valid[i + cw]) lens.push(Math.hypot(x[i + cw] - x[i], y[i + cw] - y[i]));
    }
    lens.sort((a, b) => a - b);
    const med = lens.length ? lens[lens.length >> 1] : 1;
    maxEdge = Math.max(3, 3 * med);
  }
  const n = pw * ph;
  const outU = new Float32Array(n).fill(NaN);
  const outV = new Float32Array(n).fill(NaN);
  const outK = key ? new Float32Array(n).fill(-Infinity) : null;
  const outValid = new Uint8Array(n);
  const max2 = maxEdge * maxEdge;
  const d2 = (i, j) => (x[i] - x[j]) ** 2 + (y[i] - y[j]) ** 2;

  function tri(i, j, k) {
    if (!valid[i] || !valid[j] || !valid[k]) return;
    if (d2(i, j) > max2 || d2(j, k) > max2 || d2(k, i) > max2) return;
    const ax = x[i];
    const ay = y[i];
    const bx = x[j];
    const by = y[j];
    const cx = x[k];
    const cy = y[k];
    const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (Math.abs(area) < 1e-9) return;
    // Pixel centres (px + 0.5) inside the triangle's bounding box.
    const x0 = Math.max(0, Math.ceil(Math.min(ax, bx, cx) - 0.5));
    const x1 = Math.min(pw - 1, Math.floor(Math.max(ax, bx, cx) - 0.5));
    const y0 = Math.max(0, Math.ceil(Math.min(ay, by, cy) - 0.5));
    const y1 = Math.min(ph - 1, Math.floor(Math.max(ay, by, cy) - 0.5));
    const ui = i % cw + 0.5;
    const vi = (i / cw | 0) + 0.5;
    const uj = j % cw + 0.5;
    const vj = (j / cw | 0) + 0.5;
    const uk = k % cw + 0.5;
    const vk = (k / cw | 0) + 0.5;
    for (let py = y0; py <= y1; py++) {
      const Y = py + 0.5;
      for (let px = x0; px <= x1; px++) {
        const X = px + 0.5;
        const wa = ((bx - X) * (cy - Y) - (by - Y) * (cx - X)) / area;
        const wb = ((cx - X) * (ay - Y) - (cy - Y) * (ax - X)) / area;
        const wc = 1 - wa - wb;
        if (wa < -1e-6 || wb < -1e-6 || wc < -1e-6) continue;
        const p = py * pw + px;
        if (key) {
          const kv = wa * key[i] + wb * key[j] + wc * key[k];
          if (outValid[p] && kv <= outK[p]) continue;
          outK[p] = kv;
        } else if (outValid[p]) continue;
        outU[p] = wa * ui + wb * uj + wc * uk;
        outV[p] = wa * vi + wb * vj + wc * vk;
        outValid[p] = 1;
      }
    }
  }

  for (let v = 0; v + 1 < ch; v++) for (let u = 0; u + 1 < cw; u++) {
    const i = v * cw + u;
    tri(i, i + 1, i + cw + 1);
    tri(i, i + cw + 1, i + cw);
  }
  let nValid = 0;
  for (let p = 0; p < n; p++) nValid += outValid[p];
  return { projW: pw, projH: ph, camW: cw, camH: ch, u: outU, v: outV, key: outK, valid: outValid, nValid, maxEdge };
}

/**
 * Relief from two inverted scans: the object, and the same rig looking at the
 * empty wall. For a fixed projector ray, moving the surface toward or away
 * from the rig slides the camera image of that ray along one direction (the
 * epipolar line, locally constant), so the displacement's component along
 * that direction is a monotonic stand-in for height. No lens calibration
 * needed. It is not metric, and a synthesizer mostly does not need metric.
 *
 * axis: unit [ax, ay] in camera space, or null to take the principal
 * direction of the displacement field. Auto sign makes the mean relief
 * positive (objects stand in front of the wall); `flip` inverts it.
 *
 * The null check is built in: scanning the wall twice must give ~0.
 */
export function reliefFromReference(obj, ref, { axis = null, flip = false } = {}) {
  if (obj.projW !== ref.projW || obj.projH !== ref.projH) {
    throw new Error(`scan sizes differ: ${obj.projW}x${obj.projH} vs ${ref.projW}x${ref.projH}`);
  }
  const n = obj.projW * obj.projH;
  const valid = new Uint8Array(n);
  const dx = new Float32Array(n);
  const dy = new Float32Array(n);
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (let p = 0; p < n; p++) {
    if (!obj.valid[p] || !ref.valid[p]) continue;
    valid[p] = 1;
    dx[p] = obj.u[p] - ref.u[p];
    dy[p] = obj.v[p] - ref.v[p];
    sxx += dx[p] * dx[p]; sxy += dx[p] * dy[p]; syy += dy[p] * dy[p];
  }
  let ax;
  let ay;
  if (axis) [ax, ay] = axis;
  else {
    const th = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    ax = Math.cos(th); ay = Math.sin(th);
  }
  const relief = new Float32Array(n).fill(NaN);
  let sum = 0;
  for (let p = 0; p < n; p++) {
    if (!valid[p]) continue;
    relief[p] = dx[p] * ax + dy[p] * ay;
    sum += relief[p];
  }
  let sign = !axis && sum < 0 ? -1 : 1;
  if (flip) sign = -sign;
  if (sign < 0) {
    for (let p = 0; p < n; p++) if (valid[p]) relief[p] = -relief[p];
    ax = -ax; ay = -ay;
  }
  return { relief, valid, axis: [ax, ay], w: obj.projW, h: obj.projH };
}

/**
 * Masked, step-aware Gaussian: a pixel averages only valid neighbours whose
 * relief is within `step` of its own. Masking alone is not enough — a blur
 * that crosses a depth step turns it into a ramp, and the normals on that
 * ramp read as a fold 4-5 px away from the real edge (measured: 443 stray
 * crease pixels beside the audit rig's step). NaN where invalid.
 */
export function stepAwareBlur(f, valid, w, h, sigma, step) {
  const r = Math.max(1, Math.ceil(2 * sigma));
  const k = new Float32Array(2 * r + 1);
  for (let i = -r; i <= r; i++) k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma));
  const out = new Float32Array(w * h).fill(NaN);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const p = y * w + x;
    if (!valid[p]) continue;
    const c = f[p];
    let a = 0;
    let b = 0;
    for (let j = -r; j <= r; j++) {
      const yy = y + j;
      if (yy < 0 || yy >= h) continue;
      for (let i = -r; i <= r; i++) {
        const xx = x + i;
        if (xx < 0 || xx >= w) continue;
        const q = yy * w + xx;
        if (!valid[q] || Math.abs(f[q] - c) > step) continue;
        const wt = k[i + r] * k[j + r];
        a += wt * f[q];
        b += wt;
      }
    }
    out[p] = a / b;
  }
  return out;
}

/**
 * Surface normals from relief, Y UP (GL convention): rows here count down, so
 * ny = +scale·∂z/∂row. Relief is smoothed first — decoded relief carries
 * sub-pixel stair-steps that a raw Sobel turns into banded normals — and
 * neither the smoothing nor the differences reach across a step (see
 * stepAwareBlur). Central differences where both neighbours qualify,
 * one-sided where one does, flat where neither. Invalid pixels get (0, 0, 1);
 * use the valid mask to tell them apart.
 */
export function normalsFromRelief(relief, valid, w, h, { sigma = 2, scale = 1, step = 2 } = {}) {
  const s = stepAwareBlur(relief, valid, w, h, sigma, step);
  const ok = (p, q) => valid[q] && Math.abs(s[q] - s[p]) <= step;
  const out = new Float32Array(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const p = y * w + x;
    out[3 * p + 2] = 1;
    if (!valid[p]) continue;
    const l = x > 0 && ok(p, p - 1);
    const r = x + 1 < w && ok(p, p + 1);
    const u = y > 0 && ok(p, p - w);
    const d = y + 1 < h && ok(p, p + w);
    const gx = l && r ? (s[p + 1] - s[p - 1]) / 2 : r ? s[p + 1] - s[p] : l ? s[p] - s[p - 1] : 0;
    const gy = u && d ? (s[p + w] - s[p - w]) / 2 : d ? s[p + w] - s[p] : u ? s[p] - s[p - w] : 0;
    const nx = -scale * gx;
    const ny = scale * gy;
    const len = Math.hypot(nx, ny, 1);
    out[3 * p] = nx / len;
    out[3 * p + 1] = ny / len;
    out[3 * p + 2] = 1 / len;
  }
  return out;
}

/**
 * Edge masks, 4 bytes per pixel, 0 or 255:
 *   [0] valid       — the projector lights a surface the camera saw
 *   [1] silhouette  — valid, with an invalid 4-neighbour (frame edge excluded)
 *   [2] step        — relief jumps more than `step` to a valid 4-neighbour
 *   [3] crease      — normals turn more than creaseDeg to a valid neighbour
 * The step threshold is in relief units (camera px) and must sit above the
 * relief noise; the audit measures that noise on a wall-vs-wall scan.
 */
export function edgeMasks(relief, normals, valid, w, h, { step = 2, creaseDeg = 30 } = {}) {
  const out = new Uint8Array(w * h * 4);
  const cosT = Math.cos(creaseDeg * Math.PI / 180);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const p = y * w + x;
    if (!valid[p]) continue;
    out[4 * p] = 255;
    let sil = false;
    let stp = false;
    let cr = false;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const xx = x + dx;
      const yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
      const q = yy * w + xx;
      if (!valid[q]) { sil = true; continue; }
      if (Math.abs(relief[p] - relief[q]) > step) { stp = true; continue; }
      const dot = normals[3 * p] * normals[3 * q] + normals[3 * p + 1] * normals[3 * q + 1]
        + normals[3 * p + 2] * normals[3 * q + 2];
      if (dot < cosT) cr = true;
    }
    if (sil) out[4 * p + 1] = 255;
    if (stp) out[4 * p + 2] = 255;
    if (cr) out[4 * p + 3] = 255;
  }
  return out;
}

const EDT_INF = 1e20;

function edt1d(f, n, d, v, z) {
  let k = 0;
  v[0] = 0; z[0] = -Infinity; z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q; z[k] = s; z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    d[q] = (q - v[k]) ** 2 + f[v[k]];
  }
}

/**
 * Exact Euclidean distance transform (Felzenszwalb & Huttenlocher 2012): for
 * every pixel, the distance in pixels to the nearest pixel where mask is set.
 * Infinity when the mask is empty. O(n), exact — checked against brute force
 * in the audit, which is why a jump-flood approximation is not used here.
 */
export function edt(mask, w, h) {
  const m = Math.max(w, h);
  const f = new Float64Array(m);
  const d = new Float64Array(m);
  const z = new Float64Array(m + 1);
  const v = new Int32Array(m);
  const g = new Float64Array(w * h);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = mask[y * w + x] ? 0 : EDT_INF;
    edt1d(f, h, d, v, z);
    for (let y = 0; y < h; y++) g[y * w + x] = d[y];
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) f[x] = g[y * w + x];
    edt1d(f, w, d, v, z);
    for (let x = 0; x < w; x++) out[y * w + x] = d[x] >= EDT_INF / 2 ? Infinity : Math.sqrt(d[x]);
  }
  return out;
}

/**
 * Signed distance to the boundary of `inside`: negative inside, positive
 * outside, crossing zero on the boundary between pixel centres (so the
 * pixels either side read ∓0.5). Projector pixels.
 */
export function signedDistance(inside, w, h) {
  const outside = new Uint8Array(w * h);
  for (let p = 0; p < w * h; p++) outside[p] = inside[p] ? 0 : 1;
  const toIn = edt(inside, w, h);
  const toOut = edt(outside, w, h);
  const out = new Float32Array(w * h);
  for (let p = 0; p < w * h; p++) out[p] = inside[p] ? 0.5 - toOut[p] : toIn[p] - 0.5;
  return out;
}

/**
 * The whole bake from two decoded scans (object, empty-wall reference).
 * Returns projector-space arrays, row 0 = top:
 *   relief    Float32 (NaN invalid)       — camera px of disparity
 *   normals   Float32 x3, y UP
 *   edges     Uint8 x4  [valid, silhouette, step, crease]
 *   sdf       Float32   — signed distance to the surface outline, px
 *   edgeDist  Float32   — distance to the nearest edge of any kind, px
 */
export function bake(objScan, refScan, opts = {}) {
  const obj = invertToProjector(objScan, opts.invert);
  const ref = invertToProjector(refScan, opts.invert);
  const { relief, valid, axis, w, h } = reliefFromReference(obj, ref, opts.relief);
  // One step threshold for both, unless given separately: what the edge mask
  // calls a step is exactly what the normals must not smooth across.
  const step = opts.step ?? 2;
  const normals = normalsFromRelief(relief, valid, w, h, { step, ...opts.normals });
  const edges = edgeMasks(relief, normals, valid, w, h, { step, ...opts.edges });
  const any = new Uint8Array(w * h);
  for (let p = 0; p < w * h; p++) any[p] = edges[4 * p + 1] | edges[4 * p + 2] | edges[4 * p + 3] ? 1 : 0;
  return {
    w, h, axis, relief, valid, normals, edges,
    sdf: signedDistance(valid, w, h),
    edgeDist: edt(any, w, h),
    obj, ref,
  };
}
