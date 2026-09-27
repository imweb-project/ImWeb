/**
 * ImWeb Structured Light — pack a bake into GPU textures.
 *
 * bake() produces projector-space arrays with row 0 = TOP. A DataTexture has
 * flipY false, so its row 0 is the BOTTOM of the screen (the warp-map
 * convention, CLAUDE.md) — every array is flipped here, once, so no shader
 * ever has to know which way a scan was stored.
 *
 * Formats, and why (LEARNED 2026-08-04; tests/audit-texture-upload-formats):
 *   relief   R16F     linear   normalised to [-1, 1] by its own peak, so half
 *                              precision scales with the object (step ≤ 1/2048
 *                              of the peak) instead of coarsening as it grows
 *   normals  RGBA16F  linear   xyz (y UP) + valid in w
 *   edges    RGBA8    linear   [valid, silhouette, step, crease]
 *   dist     RG16F    linear   signed distance to the outline, distance to
 *                              any edge — projector px, capped at DIST_CAP
 *   camUV    RG32F    NEAREST  where the camera saw each projector pixel, in
 *                              camera-texture UV (y UP, as a flipY VideoTexture
 *                              samples); -1 where unseen. 32-bit because half
 *                              rounds 1919.5 to 1919 — a whole pixel at 1080p,
 *                              two at 4K — and Nearest because RG32F needs
 *                              OES_texture_float_linear to filter, and samples
 *                              black without it
 * Only RED/RG/RGBA: three sizes those; an RGB float upload is rejected
 * silently and samples black.
 *
 * packBake() is pure data (Worker-safe apart from three's half conversion);
 * toDataTextures() wraps the result for the main thread.
 */

import {
  DataTexture, DataUtils, RedFormat, RGFormat, RGBAFormat,
  HalfFloatType, FloatType, UnsignedByteType, LinearFilter, NearestFilter, ClampToEdgeWrapping,
} from 'three';

export const DIST_CAP = 4096;

/**
 * Spacing of representable half-floats around v — the precision budget.
 * Note three's DataUtils.toHalfFloat TRUNCATES toward zero (measured: 100.31
 * → 100.25 though 100.3125 is representable), so the stored error reaches a
 * full step, not half, and leans toward zero. At 2^-11 of the relief peak
 * that is far below decode precision; it is written down so nobody reads the
 * bias as a bug in the scan.
 */
export function halfStep(v) {
  const a = Math.abs(v);
  return a < 2 ** -14 ? 2 ** -24 : 2 ** (Math.floor(Math.log2(a)) - 10);
}

/** Copy rows bottom-up: row r of the result is row h-1-r of the input. */
function flipRows(src, w, h, ch, Out) {
  const out = new Out(w * h * ch);
  const stride = w * ch;
  for (let r = 0; r < h; r++) out.set(src.subarray((h - 1 - r) * stride, (h - r) * stride), r * stride);
  return out;
}

function toHalfArray(f32) {
  const out = new Uint16Array(f32.length);
  for (let i = 0; i < f32.length; i++) out[i] = DataUtils.toHalfFloat(f32[i]);
  return out;
}

/**
 * bake → { meta, relief, normals, edges, dist, camUV }, each
 * { data, width, height, format, type, filter }. The camera-uv map comes from
 * the OBJECT scan's inversion (bake().obj), which is the one the camera saw.
 */
export function packBake(b) {
  const { w, h, relief, valid, normals, edges, sdf, edgeDist, obj } = b;
  const n = w * h;
  let peak = 0;
  for (let p = 0; p < n; p++) if (valid[p]) peak = Math.max(peak, Math.abs(relief[p]));
  const scale = peak || 1;

  const r1 = new Float32Array(n);
  const nrm = new Float32Array(n * 4);
  const dst = new Float32Array(n * 2);
  const uv = new Float32Array(n * 2);
  for (let p = 0; p < n; p++) {
    const ok = !!valid[p];
    r1[p] = ok ? relief[p] / scale : 0;
    nrm[4 * p] = normals[3 * p];
    nrm[4 * p + 1] = normals[3 * p + 1];
    nrm[4 * p + 2] = normals[3 * p + 2];
    nrm[4 * p + 3] = ok ? 1 : 0;
    dst[2 * p] = Math.max(-DIST_CAP, Math.min(DIST_CAP, sdf[p]));
    dst[2 * p + 1] = Math.min(DIST_CAP, edgeDist[p]);
    if (obj.valid[p]) {
      uv[2 * p] = obj.u[p] / obj.camW;
      uv[2 * p + 1] = 1 - obj.v[p] / obj.camH;
    } else {
      uv[2 * p] = -1;
      uv[2 * p + 1] = -1;
    }
  }
  const tex = (data, ch, Out, format, type, filter) => ({
    data: flipRows(data, w, h, ch, Out), width: w, height: h, format, type, filter,
  });
  return {
    meta: { projW: w, projH: h, camW: obj.camW, camH: obj.camH, reliefScale: scale, axis: b.axis, distCap: DIST_CAP },
    relief: tex(toHalfArray(r1), 1, Uint16Array, RedFormat, HalfFloatType, LinearFilter),
    normals: tex(toHalfArray(nrm), 4, Uint16Array, RGBAFormat, HalfFloatType, LinearFilter),
    edges: tex(edges, 4, Uint8Array, RGBAFormat, UnsignedByteType, LinearFilter),
    dist: tex(toHalfArray(dst), 2, Uint16Array, RGFormat, HalfFloatType, LinearFilter),
    camUV: tex(uv, 2, Float32Array, RGFormat, FloatType, NearestFilter),
  };
}

/** Wrap packBake() output as three DataTextures, ready to bind. */
export function toDataTextures(packed) {
  const out = {};
  for (const k of ['relief', 'normals', 'edges', 'dist', 'camUV']) {
    const t = packed[k];
    const tex = new DataTexture(t.data, t.width, t.height, t.format, t.type);
    tex.minFilter = t.filter;
    tex.magFilter = t.filter;
    tex.wrapS = ClampToEdgeWrapping;
    tex.wrapT = ClampToEdgeWrapping;
    tex.generateMipmaps = false;
    tex.flipY = false;
    tex.needsUpdate = true;
    out[k] = tex;
  }
  return out;
}
