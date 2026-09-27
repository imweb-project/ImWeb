/**
 * Synthetic projector-camera rig, shared by the structured-light audits so the
 * decoder and the bake are tested against ONE scene definition.
 *
 * A keystoned camera view of a projected surface with an optional relief
 * bump and an optional depth step, varying albedo, ambient light, sensor
 * noise, a projector shadow, and (optionally) two interreflection regions —
 * a strong one that outshines the projector and a mild one below direct.
 *
 * Geometry is expressed as the ground-truth camera→projector map, in pixel
 * units with pixel centres at n + 0.5, the convention StructuredLight.js uses.
 */

import { GrayDecoder, patternSet, patternValue } from '../../src/core/StructuredLight.js';

export const PW = 480, PH = 270, CW = 320, CH = 200;
export const AMBIENT = 18, GAIN = 190, SIGMA = 1.5;
export const KAPPA = 1.5, KAPPA_MILD = 0.6, KERNEL = 32, PARTNER = 60;
export const SHADOW = { u: 250, v: 150, r: 18 };
export const CORNER = { u0: 20, u1: 70, v0: 120, v1: 180 };  // strong interreflection
export const MILD = { u0: 200, u1: 250, v0: 20, v1: 70 };    // mild interreflection
export const BUMP = { u: 110, v: 90, sigma: 28 };
// A depth step: camera pixels right of u0 inside the band land dx projector
// px further right, leaving a projector gap the camera cannot see.
export const STEP = { u0: 160, v0: 20, v1: 100, dx: 20 };

// Deterministic noise: mulberry32 + Box-Muller.
export function rng(seed) {
  let s = seed >>> 0;
  const u = () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return () => Math.sqrt(-2 * Math.log(u() || 1e-12)) * Math.cos(2 * Math.PI * u());
}

const inRect = (R) => (u, v) => u >= R.u0 && u < R.u1 && v >= R.v0 && v < R.v1;

export function makeRig({ bump = 14, step = false, gi = true, sigma = SIGMA } = {}) {
  function camToProj(u, v) {
    const s = u / CW, t = v / CH, k = 0.12 * (1 - t);
    let x = PW * (0.06 + 0.88 * (k + s * (1 - 2 * k)));
    const y = PH * (0.05 + 0.9 * t + 0.03 * s);
    const du = u - BUMP.u, dv = v - BUMP.v;
    x += bump * Math.exp(-(du * du + dv * dv) / (2 * BUMP.sigma ** 2));
    if (step && u >= STEP.u0 && v >= STEP.v0 && v < STEP.v1) x += STEP.dx;
    return [x, y];
  }
  const inShadow = (u, v) => (u - SHADOW.u) ** 2 + (v - SHADOW.v) ** 2 < SHADOW.r ** 2;
  const inCorner = gi ? inRect(CORNER) : () => false;
  const inMild = gi ? inRect(MILD) : () => false;
  const albedo = (u, v) => inCorner(u, v) ? 0.3 : inMild(u, v) ? 0.6
    : 0.45 + 0.5 * (0.5 + 0.5 * Math.sin(u / 17) * Math.cos(v / 23));

  // Per camera pixel: 4x4 subsample footprint in projector space (so fine
  // stripes blur the way a real lens and sensor blur them) and the truth at
  // the pixel centre.
  const SUB = 4;
  const foot = new Int32Array(CW * CH * SUB * SUB * 2);
  const truth = new Float32Array(CW * CH * 2);
  for (let v = 0; v < CH; v++) for (let u = 0; u < CW; u++) {
    const i = v * CW + u;
    const [tx, ty] = camToProj(u + 0.5, v + 0.5);
    truth[2 * i] = tx; truth[2 * i + 1] = ty;
    for (let b = 0; b < SUB; b++) for (let a = 0; a < SUB; a++) {
      const [px, py] = camToProj(u + (a + 0.5) / SUB, v + (b + 0.5) / SUB);
      const o = ((i * SUB * SUB) + b * SUB + a) * 2;
      foot[o] = Math.floor(px); foot[o + 1] = Math.floor(py);
    }
  }

  function capture(pat, noise) {
    // 1-D pattern along its axis, and its prefix sum for the reflecting patch.
    const len = pat.kind === 'gray' && pat.axis ? PH : PW;
    const line = new Float64Array(len), pre = new Float64Array(len + 1);
    for (let n = 0; n < len; n++) {
      line[n] = pat.kind === 'gray' ? patternValue(pat, pat.axis ? 0 : n, pat.axis ? n : 0) : patternValue(pat, 0, 0);
      pre[n + 1] = pre[n] + line[n];
    }
    const patch = (c) => {
      const a = Math.max(0, Math.min(len, Math.round(c - KERNEL / 2)));
      const b = Math.max(0, Math.min(len, Math.round(c + KERNEL / 2)));
      return b > a ? (pre[b] - pre[a]) / (b - a) : 0;
    };
    const out = new Uint8Array(CW * CH);
    for (let v = 0; v < CH; v++) for (let u = 0; u < CW; u++) {
      const i = v * CW + u, al = albedo(u, v);
      let direct = 0;
      if (!inShadow(u + 0.5, v + 0.5)) {
        for (let s = 0; s < SUB * SUB; s++) {
          const o = (i * SUB * SUB + s) * 2;
          const n = pat.kind === 'gray' && pat.axis ? foot[o + 1] : foot[o];
          direct += line[Math.max(0, Math.min(len - 1, n))];
        }
        direct /= SUB * SUB;
      }
      let global = 0;
      if (inCorner(u, v) || inMild(u, v)) {
        const c = (pat.kind === 'gray' && pat.axis ? truth[2 * i + 1] : truth[2 * i] + PARTNER);
        global = (inCorner(u, v) ? KAPPA : KAPPA_MILD) * GAIN * al * patch(c);
      }
      const val = AMBIENT + GAIN * al * direct + global + sigma * noise();
      out[i] = Math.max(0, Math.min(255, Math.round(val)));
    }
    return out;
  }

  /** Full simulated scan through the real decoder. */
  function scan(opts = {}, seed = 1234) {
    const noise = rng(seed);
    const dec = new GrayDecoder({ camW: CW, camH: CH, projW: PW, projH: PH, noise: sigma, ...opts });
    for (const pat of patternSet(PW, PH)) dec.addFrame(pat, capture(pat, noise));
    return dec.finish();
  }

  /** The decoder's output format, straight from the truth — no patterns, no
   *  noise. Isolates the bake from the decode. */
  function exact() {
    const x = new Float32Array(CW * CH), y = new Float32Array(CW * CH), valid = new Uint8Array(CW * CH);
    let nValid = 0;
    for (let v = 0; v < CH; v++) for (let u = 0; u < CW; u++) {
      const i = v * CW + u;
      if (inShadow(u + 0.5, v + 0.5)) { x[i] = NaN; y[i] = NaN; continue; }
      x[i] = truth[2 * i]; y[i] = truth[2 * i + 1]; valid[i] = 1; nValid++;
    }
    return { camW: CW, camH: CH, projW: PW, projH: PH, x, y, valid, nValid };
  }

  return { camToProj, truth, inShadow, inCorner, inMild, albedo, capture, scan, exact };
}
