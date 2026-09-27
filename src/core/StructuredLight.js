/**
 * ImWeb Structured Light — Gray-code projector-camera scan, the pure maths.
 *
 * No DOM, no WebGL, no timers: everything here runs unchanged in a Worker and
 * in node. A scan is a one-off bake of ~1-2 MP, so typed arrays are fast
 * enough, and ONE CPU definition can be tested against a synthetic scene where
 * a GPU twin would be a second source of truth (LEARNED 2026-09-22) read back
 * through the half-float traps of 2026-09-26.
 *
 * Conventions — one axis convention, as for the warp maps:
 *   - Projector columns x count left→right and rows y count TOP→down. Pixel n
 *     covers [n, n+1); decoded positions are returned at pixel CENTRES, n + 0.5.
 *     The pattern shader derives rows from gl_FragCoord, which is y-UP, so it
 *     flips: row = floor(H − gl_FragCoord.y).
 *   - Camera frames are 8-bit luma, row 0 = top (VideoFrame Y-plane order).
 *
 * What this file does NOT do: open windows, drive a camera or lock exposure.
 * It turns frames into correspondences, and decides when a frame is settled.
 */

/** Bits needed to address n positions. 1080 rows need 11, not 10. */
export function bitsFor(n) {
  let b = 1;
  while ((1 << b) < n) b++;
  return b;
}

/**
 * Bit k of the reflected Gray code of x, in the form the GLSL ES 1.00 shader
 * can evaluate without bitwise operators. Asserted equal to
 * `((x ^ (x >> 1)) >> k) & 1` exhaustively by the audit.
 */
export function grayBit(x, k) {
  const p = 2 ** k;
  return Math.floor((x + p) / (2 * p)) % 2;
}

export function grayToBinary(g) {
  let b = g;
  for (let s = g >> 1; s; s >>= 1) b ^= s;
  return b;
}

/**
 * The capture sequence. White and black references first (every pair needs
 * them), then pattern/inverse pairs ADJACENT — a gain drift between the two
 * halves of a pair is the one drift the pair cannot cancel — ordered FINEST
 * first, so the separation bits the classifier needs arrive early and the
 * decoder can stream instead of holding the whole scan.
 *
 * 1920x1080: 2 + 2·(11 + 11) = 46 frames.
 */
export function patternSet(projW, projH) {
  const nb = [bitsFor(projW), bitsFor(projH)];
  const out = [{ kind: 'white' }, { kind: 'black' }];
  for (let k = 0; k < Math.max(nb[0], nb[1]); k++) {
    for (let axis = 0; axis < 2; axis++) {
      if (k >= nb[axis]) continue;
      out.push({ kind: 'gray', axis, bit: k, inv: false });
      out.push({ kind: 'gray', axis, bit: k, inv: true });
    }
  }
  return out.map((p, index) => ({ ...p, index }));
}

/** JS reference of PATTERN_FRAG: 1 lit, 0 dark, at projector pixel (x, y). */
export function patternValue(pat, x, y) {
  if (pat.kind === 'white') return 1;
  if (pat.kind === 'black') return 0;
  const b = grayBit(pat.axis ? y : x, pat.bit);
  return pat.inv ? 1 - b : b;
}

/** Uniform values for PATTERN_FRAG. uP is passed rather than exp2()'d on the
 *  GPU, where exp2 of an integer is not guaranteed exact. */
export function patternUniforms(pat) {
  return {
    uMode: pat.kind === 'white' ? 1 : pat.kind === 'black' ? 2 : 0,
    uAxis: pat.axis ?? 0,
    uP: 2 ** (pat.bit ?? 0),
    uInv: pat.inv ? 1 : 0,
  };
}

/**
 * Pattern fragment shader, GLSL ES 1.00 (the output window is WebGL1).
 * highp is required, not a nicety: at mediump a column index above ~1024 is
 * rounded and the fine bits come out wrong. The canvas must be sized in DEVICE
 * pixels and drawn with no mesh, fade or CSS scaling, or one fragment is not
 * one projector pixel.
 */
export const PATTERN_FRAG = /* glsl */ `
precision highp float;
uniform float uMode;   // 0 gray code, 1 white, 2 black
uniform float uAxis;   // 0 columns, 1 rows counted from the TOP
uniform float uP;      // 2^bit
uniform float uInv;    // 1 = inverse pattern
uniform vec2 uRes;     // drawing-buffer size in device pixels
void main() {
  float v;
  if (uMode > 1.5) v = 0.0;
  else if (uMode > 0.5) v = 1.0;
  else {
    float n = uAxis < 0.5 ? floor(gl_FragCoord.x) : floor(uRes.y - gl_FragCoord.y);
    v = mod(floor((n + uP) / (2.0 * uP)), 2.0);
    v = abs(v - uInv);
  }
  gl_FragColor = vec4(vec3(v), 1.0);
}
`;

/**
 * Streaming Gray-code decoder: feed frames in patternSet() order, then finish().
 *
 * Bits are classified with the direct/global rule of Xu & Aliaga (2007), as
 * used by Moreno & Taubin (2012), rather than a bare `pos > inv`. The FINE
 * patterns (sepBits) are averaged by interreflection, so per pixel they give
 * Ld = max − min (direct light) and Lg = 2·(min − black) (global light). A
 * coarse bit in a concave corner can then be LIT BY ITS NEIGHBOUR more than by
 * the projector, and a bare comparison decodes it confidently wrong; this rule
 * returns "uncertain" there instead, which drops or coarsens the pixel.
 *
 * With pixel lit:  P ∈ [Ld, Ld+Lg], N ∈ [0, Lg]; dark: the reverse. So:
 *   Ld − Lg > eps           → compare P and N
 *   P > Lg+m or N < Ld−m → 1;  N > Lg+m or P < Ld−m → 0;  both/neither → uncertain
 * eps is a noise margin (3·√2·σ); m adds 5% of Ld+Lg for the model being only
 * approximately true. A borderline pixel is dropped, not guessed.
 *
 * Ld and Lg are MEANS over the separation pairs, not the max and min over
 * their captures. Extremes of noisy samples bias Ld up and Lg down — exactly
 * the direction that makes `N < Ld − m` fire on a dark pixel whose inverse is
 * pure direct light. Measured in the corner of the audit's rig: 218 confident
 * wrong codes from extremes, 0 from means.
 *
 * sepBits must be RESOLVED by the camera (stripe 2^(k+1) projector px across
 * several camera px) yet fine against the interreflection kernel. The default
 * [2, 3] is 8/16 px stripes; if the camera cannot see them, Ld collapses and
 * coverage falls — which shows up as low coverage, not as wrong codes.
 */
export class GrayDecoder {
  constructor({ camW, camH, projW, projH, sepBits = [2, 3], minContrast = 12,
                noise = 2, minBits = null, robust = true }) {
    Object.assign(this, { camW, camH, projW, projH, minContrast, robust });
    this.eps = 3 * Math.SQRT2 * noise;
    this.nb = [bitsFor(projW), bitsFor(projH)];
    // A pixel keeps a coarse code when only its finest bits are uncertain.
    this.minBits = this.nb.map(n => minBits ?? Math.max(1, n - 3));
    const N = camW * camH;
    this.W = null;
    this.B = null;
    this.sumHi = new Uint16Array(N);   // Σ max(P, N) over separation pairs
    this.sumLo = new Uint16Array(N);   // Σ min(P, N)
    this.nSep = 0;
    this.gray = [new Uint16Array(N), new Uint16Array(N)];
    this.known = [new Uint16Array(N), new Uint16Array(N)];
    this._sepBits = new Set(sepBits);
    this._sepWant = new Set();
    for (const k of sepBits) for (let a = 0; a < 2; a++) if (k < this.nb[a]) this._sepWant.add(`${a}:${k}`);
    if (!this._sepWant.size) throw new Error(`sepBits ${sepBits} lie outside the pattern set`);
    this._pos = new Map();   // positive frames waiting for their inverse
    this._held = [];         // complete pairs waiting for the separation bits
    this.pairs = 0;
  }

  addFrame(pat, luma) {
    if (luma.length !== this.camW * this.camH) {
      throw new Error(`frame is ${luma.length} px, expected ${this.camW * this.camH}`);
    }
    if (pat.kind === 'white') { this.W = Uint8Array.from(luma); return; }
    if (pat.kind === 'black') { this.B = Uint8Array.from(luma); return; }
    if (!this.W || !this.B) throw new Error('white and black references must come first');
    const key = `${pat.axis}:${pat.bit}`;
    if (!pat.inv) { this._pos.set(key, Uint8Array.from(luma)); return; }
    const p = this._pos.get(key);
    if (!p) throw new Error(`inverse of ${key} arrived without its positive`);
    this._pos.delete(key);
    const n = Uint8Array.from(luma);
    if (this._sepBits.has(pat.bit)) {
      const { sumHi, sumLo } = this;
      for (let i = 0; i < n.length; i++) {
        if (p[i] > n[i]) { sumHi[i] += p[i]; sumLo[i] += n[i]; }
        else { sumHi[i] += n[i]; sumLo[i] += p[i]; }
      }
      this.nSep++;
      this._sepWant.delete(key);
    }
    if (this._sepWant.size) { this._held.push([pat.axis, pat.bit, p, n]); return; }
    for (const h of this._held.splice(0)) this._classify(...h);
    this._classify(pat.axis, pat.bit, p, n);
  }

  _classify(axis, bit, p, n) {
    const { B, sumHi, sumLo, nSep, eps, robust, minContrast } = this;
    const g = this.gray[axis];
    const kn = this.known[axis];
    const mask = 1 << bit;
    for (let i = 0; i < p.length; i++) {
      const P = p[i] - B[i];
      const N = n[i] - B[i];
      let v = -1;
      if (!robust) {
        if (P - N > eps) v = 1; else if (N - P > eps) v = 0;
      } else {
        const ld = (sumHi[i] - sumLo[i]) / nSep;
        const lg = 2 * Math.max(0, sumLo[i] / nSep - B[i]);
        if (ld < minContrast) v = -1;
        else if (ld - lg > eps) {
          if (P - N > eps) v = 1; else if (N - P > eps) v = 0;
        } else {
          const m = eps + 0.05 * (ld + lg);
          const one = P > lg + m || N < ld - m;
          const zero = N > lg + m || P < ld - m;
          if (one && !zero) v = 1; else if (zero && !one) v = 0;
        }
      }
      if (v < 0) continue;
      kn[i] |= mask;
      if (v) g[i] |= mask;
    }
    this.pairs++;
  }

  /**
   * Per camera pixel: projector x, y (pixel-centre units, NaN when invalid),
   * the number of reliable bits per axis, and a validity mask. A pixel with
   * its low bits uncertain gets the CENTRE of its bucket, so bitsX/bitsY say
   * how far to trust it.
   *
   * A pixel straddling a stripe edge sees half of each side, so that one bit
   * is honestly uncertain — at ANY level, the MSB included. Gray code changes
   * exactly one bit across an edge, so if trying both values of the first
   * uncertain bit gives ADJACENT codes, the pixel is on that edge and its
   * position is the edge. Without this, every coarse stripe boundary cut an
   * invalid band through the scan (5.7% of a clean surface in the audit rig).
   * Non-adjacent candidates mean the doubt is not geometric (interreflection,
   * noise) and the pixel stays truncated.
   */
  finish() {
    if (this._pos.size || this._sepWant.size || this._held.length) {
      throw new Error(`scan incomplete: ${this._pos.size} unpaired, ${this._sepWant.size} separation pairs missing`);
    }
    const { camW, camH, projW, projH, W, B, minContrast } = this;
    const N = camW * camH;
    const x = new Float32Array(N).fill(NaN);
    const y = new Float32Array(N).fill(NaN);
    const bits = [new Uint8Array(N), new Uint8Array(N)];
    const valid = new Uint8Array(N);
    const lim = [projW, projH];
    const pos = [0, 0];
    let nValid = 0;
    for (let i = 0; i < N; i++) {
      // No saturation rule. A clipped white was once rejected outright, which
      // erased every pixel of a real noise-free capture (white = 255) and
      // would erase any bright surface under a mid-grey exposure lock — the
      // simulator never clipped, so nothing noticed. A Gray bit is a
      // COMPARISON of pattern and inverse, and 255 against 18 is a clear one;
      // where clipping really costs (black clipped too, or bounced light
      // lifting the dark half) the contrast test and the direct/global rule
      // already refuse the pixel.
      if (W[i] - B[i] < minContrast) continue;
      let ok = true;
      for (let a = 0; a < 2; a++) {
        const nb = this.nb[a];
        const g = this.gray[a][i];
        const kn = this.known[a][i];
        let r = 0;
        while (r < nb && ((kn >> (nb - 1 - r)) & 1)) r++;
        if (r < nb) {
          const q = nb - 1 - r;           // the first uncertain bit
          let r2 = 0;
          while (r2 < q && ((kn >> (q - 1 - r2)) & 1)) r2++;
          const s2 = q - r2;              // bits still unknown below it
          const g0 = (g >> s2) & ~(1 << (q - s2));
          const g1 = g0 | (1 << (q - s2));
          const c0 = grayToBinary(g0);
          const c1 = grayToBinary(g1);
          if (Math.abs(c0 - c1) === 1) {
            const edge = Math.max(c0, c1) * 2 ** s2;
            const eff = r + 1 + r2;
            if (eff < this.minBits[a] || edge >= lim[a]) { ok = false; break; }
            pos[a] = edge;
            bits[a][i] = eff;
            continue;
          }
        }
        if (r < this.minBits[a]) { ok = false; break; }
        const s = nb - r;
        const lo = grayToBinary(g >> s) * 2 ** s;
        // A code no projector pixel emits is corruption, not a far column.
        if (lo >= lim[a]) { ok = false; break; }
        pos[a] = (lo + Math.min(lo + 2 ** s, lim[a])) / 2;
        bits[a][i] = r;
      }
      if (!ok) continue;
      x[i] = pos[0]; y[i] = pos[1]; valid[i] = 1; nValid++;
    }
    return { camW, camH, projW, projH, x, y, bitsX: bits[0], bitsY: bits[1], valid, nValid };
  }
}

const median = (a) => {
  const s = a.slice().sort((p, q) => p - q);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * Drop decoded pixels that disagree with their 3x3 neighbourhood by more than
 * tol projector px, and isolated pixels with fewer than three valid
 * neighbours. Erodes a pixel or so off depth steps, where the median comes
 * from the other side — acceptable, since steps are re-derived from the
 * inverted map anyway. Mutates res; returns the number dropped.
 */
export function rejectOutliers(res, tol = 6) {
  const { camW: w, camH: h, x, y, valid } = res;
  const drop = [];
  const nx = [];
  const ny = [];
  for (let v = 0; v < h; v++) for (let u = 0; u < w; u++) {
    const i = v * w + u;
    if (!valid[i]) continue;
    nx.length = 0; ny.length = 0;
    for (let dv = -1; dv <= 1; dv++) for (let du = -1; du <= 1; du++) {
      if (!du && !dv) continue;
      const uu = u + du;
      const vv = v + dv;
      if (uu < 0 || vv < 0 || uu >= w || vv >= h) continue;
      const j = vv * w + uu;
      if (valid[j]) { nx.push(x[j]); ny.push(y[j]); }
    }
    if (nx.length < 3 || Math.abs(x[i] - median(nx)) > tol || Math.abs(y[i] - median(ny)) > tol) drop.push(i);
  }
  for (const i of drop) { valid[i] = 0; x[i] = NaN; y[i] = NaN; }
  res.nValid -= drop.length;
  return drop.length;
}

/**
 * Per-cell mean ABSOLUTE difference of two frames. Absolute before averaging
 * on purpose: a cell averaged first cannot tell a fine stripe pattern from its
 * inverse (both are 50% grey), so a thumbnail-of-means gate times out on
 * every fine bit.
 */
const _colCells = new Map();

/** Column → cell lookup, cached per (w, tw): the per-pixel floor and divide
 *  it replaces were most of cellMAD's cost. */
function colCells(w, tw) {
  const key = w * 4096 + tw;
  let m = _colCells.get(key);
  if (!m) {
    m = new Uint16Array(w);
    for (let u = 0; u < w; u++) m[u] = Math.floor(u * tw / w);
    _colCells.set(key, m);
  }
  return m;
}

export function cellMAD(a, b, w, h, tw = 32, th = 18) {
  // Runs twice per camera frame in the scan loop, so it is written for
  // speed: integer sums into a cell accumulator, no per-pixel division.
  // Measured at 1280x720: 15.1 ms → 7.8 ms per call, against a 33 ms frame
  // budget it is spent twice in. Bit-equal to the plain per-pixel form,
  // which the audit keeps as a reference and compares on odd sizes.
  const sum = new Uint32Array(tw * th);
  const cc = colCells(w, tw);
  for (let v = 0; v < h; v++) {
    const row = Math.floor(v * th / h) * tw;
    const base = v * w;
    for (let u = 0; u < w; u++) {
      const d = a[base + u] - b[base + u];
      sum[row + cc[u]] += d < 0 ? -d : d;
    }
  }
  // Pixel counts per cell depend only on the geometry.
  const rowsIn = new Uint32Array(th);
  for (let v = 0; v < h; v++) rowsIn[Math.floor(v * th / h)]++;
  const colsIn = new Uint32Array(tw);
  for (let u = 0; u < w; u++) colsIn[cc[u]]++;
  const out = new Float32Array(tw * th);
  for (let r = 0; r < th; r++) for (let c = 0; c < tw; c++) {
    const n = rowsIn[r] * colsIn[c];
    out[r * tw + c] = n ? sum[r * tw + c] / n : 0;
  }
  return out;
}

/**
 * Decides when the camera shows a newly projected pattern, by CONTENT rather
 * than by counting frames. No web API reports when a WebGL frame reaches the
 * glass, and projector processing plus camera buffering add a delay nothing
 * in the page can see — so a fixed "flush N frames" is a guess that fails the
 * day the projector or the camera changes.
 *
 * Accept a frame when it agrees with the frame before it (a rolling-shutter
 * frame torn across the switch never agrees with its successor) AND differs
 * from the previous pattern's accepted capture. A pattern the camera cannot
 * distinguish from the last one (fine stripes it cannot resolve, a view with
 * nothing lit) never "changes"; it is accepted quietly once the measured
 * latency has passed and the picture has held still for quietRun frames, and
 * flagged changed:false so the caller knows. maxFrames is the last resort,
 * flagged timedOut.
 *
 * `latency` is REQUIRED — frames after begin() before the camera can show the
 * new pattern, measured once per rig (black→white flash) plus a margin. It
 * has no safe default: at 0, a projector slower than quietRun frames gets its
 * OLD pattern quietly accepted as the new one (9 of 21 cases in the audit).
 *
 * Frames must be distinct buffers: the gate keeps a reference to the last one.
 */
/**
 * Is `frame` still (against the frame before it), and what fraction of the
 * picture has changed against `ref`? The one definition of both, shared by
 * SettleGate and LatencyProbe.
 *
 * Robust to LOCAL flicker — a flickering sensor pixel, a person crossing a
 * corner, a TV in shot. Demanding that EVERY cell be still let 300 flickering
 * pixels stall a scan until its white reference timed out; and counting a
 * flickering cell as "changed" would let it accept an old frame as a new
 * pattern. So:
 *   stable   at most `maxUnstable` of the cells moved. Default 0.4 / rows:
 *            under ONE row of cells, because a rolling-shutter tear always
 *            spans at least a full row of cells (they are full-width), so
 *            no tear can hide inside the allowance;
 *   changed  counted only over cells that are themselves still — a cell
 *            that is moving cannot vote on what the pattern is.
 */
export function frameStats(frame, last, ref, w, h, { stableTol = 4, changeTol = 12, cells = [32, 18], maxUnstable = null } = {}) {
  const [tw, th] = cells;
  const still = cellMAD(frame, last, w, h, tw, th);
  let unstable = 0;
  for (let t = 0; t < still.length; t++) if (still[t] > stableTol) unstable++;
  const stable = unstable <= (maxUnstable ?? 0.4 / th) * still.length;
  let changed = 0;
  if (ref) {
    const d = cellMAD(frame, ref, w, h, tw, th);
    for (let t = 0; t < d.length; t++) if (d[t] > changeTol && still[t] <= stableTol) changed++;
  }
  return { stable, changed: changed / still.length, unstable: unstable / still.length };
}

export class SettleGate {
  constructor({ w, h, stableTol = 4, changeTol = 12, minChanged = 0.005,
                latency, quietRun = 3, maxFrames = 60, cells = [32, 18], maxUnstable = null }) {
    if (!Number.isFinite(latency) || latency < 0) {
      throw new Error('SettleGate needs the measured latency in frames');
    }
    Object.assign(this, { w, h, stableTol, changeTol, minChanged, latency, quietRun, maxFrames, cells, maxUnstable });
    this.begin(null);
  }

  /** prev: the accepted frame of the previous pattern, or the view before the scan. */
  begin(prev) {
    this.prev = prev;
    this.last = null;
    this.frames = 0;
    this.run = 0;
  }

  push(frame) {
    const n = ++this.frames;
    const last = this.last;
    this.last = frame;
    if (n >= this.maxFrames) return { accept: true, frames: n, changed: false, timedOut: true };
    if (!last) return { accept: false, frames: n };
    const st = frameStats(frame, last, this.prev, this.w, this.h, this);
    this.run = st.stable ? this.run + 1 : 0;
    if (!st.stable) return { accept: false, frames: n };
    const nCells = this.cells[0] * this.cells[1];
    const changed = !this.prev || st.changed * nCells >= Math.max(1, this.minChanged * nCells);
    if (changed) return { accept: true, frames: n, changed: true, timedOut: false };
    if (n > this.latency && this.run >= this.quietRun) return { accept: true, frames: n, changed: false, timedOut: false };
    return { accept: false, frames: n };
  }
}
