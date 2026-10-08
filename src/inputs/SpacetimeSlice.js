/**
 * ImWeb Spacetime Slice — an arbitrary plane through the frame history.
 *
 * `SpacetimeTap` reads the ring as t = m(u, v): every output pixel keeps its own
 * (x, y) and only chooses how far back to look. That form cannot express a plane
 * that CONTAINS the time axis — in an x–t cut the screen's vertical axis is time
 * itself, the photo-finish / KinoSlitscan picture. This reader is the general
 * affine form:
 *
 *     (x, y, τ) = C + u·U + v·V
 *
 * so each output pixel may sample anywhere in the volume. Axial (the plane
 * parallel to x–y) is a plain delay; Coronal (pitched 90°) puts time down the
 * screen; Sagittal (yawed 90°) puts it across; everything between is an oblique
 * cut, continuous, LFO-able. Blueprint: docs/ImWeb-Spacetime-Blueprint.md §13.
 *
 * Like the taps, it owns NO history — it samples the one `SpacetimeRing` it is
 * handed (Blueprint §2: one history, many cheap readers).
 *
 * ── Space ──
 * WORLD space is physical: the box is centred on the origin with extents
 * (A, 1, D) — A the frame aspect, D the time depth (`vol.depth`, 1 = as deep as
 * the frame is tall). +z is NEWER: the front face of the box is the newest frame.
 * VOLUME space P = (x, y, τ) ∈ [0,1]³, τ = 0 newest, τ = 1 the oldest frame
 * actually captured. `volFrame()` builds the plane in world space so rotations
 * are not sheared by the box's proportions; `volFromWorld` maps back.
 * `SpacetimeVolume` uses the same world space, which is what makes its cut face
 * and this source show the same picture.
 *
 * ── Between frames ──
 * A ring layer is a discrete time step, and `sampler2DArray` does not filter
 * across layers. A coronal cut over 120 frames on a 1080-row output would show
 * 9-row bands. KinoSlitscan's answer, taken here: fetch the two neighbouring
 * frames and crossfade (`vol.blend`).
 */

import * as THREE from 'three';
import { VERT } from '../shaders/index.js';

// ── Ring fetch, one per dialect ─────────────────────────────────────────────
// The ONLY dialect-local code. Everything that decides WHICH frame a point reads
// lives once, in VOL_SAMPLE_CHUNK — the DELAY_MAP_CHUNK rule in SpacetimeTap.

/** GLSL3 — layer index straight into the array texture. */
export const RING_FETCH_ARRAY = /* glsl */ `
  precision highp sampler2DArray;
  uniform sampler2DArray tRing;
  vec4 ringFetch(vec2 xy, float layer) { return texture(tRing, vec3(xy, layer)); }
`;

/**
 * GLSL1 — tile arithmetic into the atlas. Identical index math to
 * SpacetimeTap's ATLAS_READ_FRAG and SpacetimeRing._tileOf(), so write and read
 * agree about where a frame lives.
 */
export const RING_FETCH_ATLAS = /* glsl */ `
  uniform sampler2D tRing;
  uniform float uCols;       // tiles per row
  uniform vec2  uTileScale;  // (1/cols, 1/rows)
  uniform vec2  uInset;      // half-texel inset in tile-local uv
  vec4 ringFetch(vec2 xy, float idx) {
    vec2 tile  = vec2(mod(idx, uCols), floor(idx / uCols));
    vec2 local = clamp(xy, uInset, 1.0 - uInset);
    return texture2D(tRing, (tile + local) * uTileScale);
  }
`;

/**
 * Point sample of the volume, and the world→volume map. Dialect-neutral: float
 * index math only (GLSL1 has no integer %), and it reaches the ring solely
 * through ringFetch().
 *
 * Index convention is the ring's: head is the NEXT slot to write, so the newest
 * frame is head-1 and one frame older is one slot lower. `+ 2.0*uN` keeps the
 * mod() operand positive, as in the atlas tap.
 */
export const VOL_SAMPLE_CHUNK = /* glsl */ `
  uniform float uHead;       // next-write slot
  uniform float uN;          // slots
  uniform float uMaxBack;    // frames from newest to oldest captured (>= 1)
  uniform float uBlend;      // 0 nearest frame, 1 crossfade neighbours
  uniform vec2  uScale;      // world box extents: (A, D) — y is always 1

  vec3 volFromWorld(vec3 W) {
    return vec3(W.x / uScale.x + 0.5, W.y + 0.5, 0.5 - W.z / uScale.y);
  }

  // P must already be inside [0,1]^3 — edge handling is the caller's.
  vec4 volSample(vec3 P) {
    float d  = P.z * uMaxBack;
    // The epsilon makes a time position meant to land ON a frame do so: the
    // world round trip turns k/maxBack·maxBack into k − 1e-7, which floor()
    // would send one frame newer. Measured, tests/spacetime-volume.html.
    float f0 = min(floor(d + 1e-3), uMaxBack);
    float w  = max(d - f0, 0.0) * uBlend;
    float l0 = mod(uHead - 1.0 - f0 + 2.0 * uN, uN);
    vec4  a  = ringFetch(P.xy, l0);
    if (w <= 0.0) return a;                    // on a frame, or blend off: one fetch
    float l1 = mod(l0 - 1.0 + uN, uN);         // one frame older
    return mix(a, ringFetch(P.xy, l1), w);
  }
`;

/**
 * The volume's own keyer: which parts of the history are MATERIAL. Applied at
 * READ time to each sample, never at capture — the ring stays a plain record
 * (TimeDisp shares it), and moving a key control reshapes all 120 frames at
 * once instead of only those captured from now on.
 *
 * Same vocabulary and maths as the output keyer (src/shaders/index.js KEYER /
 * CHROMA_KEY): luma keeps the band between Black and White, chroma removes a
 * hue, desaturated pixels survive a chroma key. Invert flips the result.
 * Returns 1 for every sample when the key is Off, so callers need no branch.
 */
export const VOL_KEY_CHUNK = /* glsl */ `
  uniform int   uKeyMode;    // 0 off, 1 luma, 2 chroma, 3 both
  uniform float uKeyBlack;   // 0..1
  uniform float uKeyWhite;
  uniform float uKeySoft;
  uniform float uKeyHue;     // 0..1 turns
  uniform float uKeyRange;
  uniform float uKeyHueSoft;
  uniform int   uKeyInvert;

  vec3 volRgb2hsv(vec3 c) {
    vec4 K = vec4(0.0, -1.0/3.0, 2.0/3.0, -1.0);
    vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
    vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
    float d = q.x - min(q.w, q.y);
    return vec3(abs(q.z + (q.w - q.y) / (6.0*d + 1e-10)), d / (q.x + 1e-10), q.x);
  }

  float volKey(vec3 c) {
    if (uKeyMode == 0) return 1.0;
    float m = 1.0;
    if (uKeyMode != 2) {
      float l    = dot(c, vec3(0.2126, 0.7152, 0.0722));
      float soft = max(uKeySoft, 0.001);
      m *= smoothstep(uKeyBlack - soft, uKeyBlack + soft, l)
         * (1.0 - smoothstep(uKeyWhite - soft, uKeyWhite + soft, l));
    }
    if (uKeyMode != 1) {
      vec3  hsv     = volRgb2hsv(c);
      float hueDist = abs(fract(hsv.x - uKeyHue + 0.5) - 0.5) * 2.0;
      float a = smoothstep(uKeyRange, uKeyRange + max(uKeyHueSoft, 0.001), hueDist);
      m *= max(a, 1.0 - clamp(hsv.y * 4.0, 0.0, 1.0));
    }
    return uKeyInvert == 1 ? 1.0 - m : m;
  }
`;

/** Slice pass body — shared by both dialects. */
const SLICE_BODY = /* glsl */ `
  uniform mat3  uR;          // plane rotation (columns: U, V, normal)
  uniform vec3  uC;          // plane centre, world space
  uniform float uZoom;
  uniform float uAspectOut;  // output w/h
  uniform int   uEdge;       // 0 black, 1 clamp, 2 mirror

  vec4 sliceAt(vec2 uv) {
    vec2 s = vec2((uv.x - 0.5) * uAspectOut, uv.y - 0.5) / uZoom;
    vec3 P = volFromWorld(uC + uR * vec3(s, 0.0));
    if (uEdge == 1) {
      P = clamp(P, 0.0, 1.0);
    } else if (uEdge == 2) {
      P = 1.0 - abs(1.0 - mod(P, 2.0));        // triangle wave: reflect at 0 and 1
    } else if (any(lessThan(P, vec3(0.0))) || any(greaterThan(P, vec3(1.0)))) {
      return vec4(0.0, 0.0, 0.0, 1.0);         // outside the history: nothing there
    }
    vec4  c = volSample(P);
    float m = volKey(c.rgb);
    // Keyed-out is black AND transparent, so the output keyer's Alpha mode can
    // lay the cut over a background. Key Off: m = 1, the pre-key output exactly.
    return vec4(c.rgb * m, m);
  }
`;

const ARRAY_FRAG = /* glsl */ `
  precision highp float;
  ${RING_FETCH_ARRAY}
  ${VOL_SAMPLE_CHUNK}
  ${VOL_KEY_CHUNK}
  ${SLICE_BODY}
  in  vec2 vUv;
  out vec4 outColor;
  void main() { outColor = sliceAt(vUv); }
`;

const ARRAY_VERT = /* glsl */ `
  out vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position, 1.0); }
`;

const ATLAS_FRAG = /* glsl */ `
  precision highp float;
  ${RING_FETCH_ATLAS}
  ${VOL_SAMPLE_CHUNK}
  ${VOL_KEY_CHUNK}
  ${SLICE_BODY}
  varying vec2 vUv;
  void main() { gl_FragColor = sliceAt(vUv); }
`;

/**
 * Neutral defaults: the axial plane at τ = 0 through the frame centre — the
 * newest frame, unchanged. All angles in degrees, positions 0..1.
 */
export const VOL_DEFAULTS = {
  yaw: 0, pitch: 0, roll: 0,
  cx: 0.5, cy: 0.5, time: 0,
  zoom: 1, depth: 1, blend: 1, edge: 0,
  // key: off by default — every sample is material, the pre-key behaviour
  key: 0, keyBlack: 0.1, keyWhite: 1.0, keySoft: 0.05,
  keyHue: 120, keyRange: 0.2, keyHueSoft: 0.1, keyInvert: 0,
};

const _euler = new THREE.Euler();
const _m4    = new THREE.Matrix4();

/**
 * The plane in world space — ONE definition, used by the slice and by the
 * volume's cutaway, so the cut face and the slice source cannot disagree.
 *
 * R = Ry(yaw)·Rx(pitch)·Rz(roll) (Euler order 'YXZ'): yaw turns the plane about
 * the vertical so x runs into time (sagittal), pitch tilts it about x so y runs
 * into time (coronal), roll spins it in its own plane.
 *
 * @returns {{ R: THREE.Matrix3, C: THREE.Vector3, A: number, D: number, maxBack: number }}
 */
export function volFrame(o, ring, out = { R: new THREE.Matrix3(), C: new THREE.Vector3() }) {
  const A = ring.bufW / ring.bufH;
  const D = Math.max(0.01, o.depth);
  const r = THREE.MathUtils.DEG2RAD;
  _euler.set(o.pitch * r, o.yaw * r, o.roll * r, 'YXZ');
  out.R.setFromMatrix4(_m4.makeRotationFromEuler(_euler));
  out.C.set((o.cx - 0.5) * A, o.cy - 0.5, (0.5 - o.time) * D);
  out.A = A;
  out.D = D;
  out.maxBack = Math.max(1, Math.min(ring.slots - 1, ring.count - 1));
  return out;
}

/**
 * Write the uniforms VOL_SAMPLE_CHUNK and RING_FETCH_* read. Shared with
 * SpacetimeVolume so the two readers address the ring identically.
 * Atlas layout uniforms only change when the ring reallocates — gated on `rev`,
 * as in SpacetimeTap, so a grid recompute cannot leave a stale geometry.
 */
export function applyRingUniforms(u, ring, frame, blend, seen) {
  if (!ring.useArray && seen.rev !== ring.rev) {
    u.uCols.value = ring.cols;
    u.uTileScale.value.set(1 / ring.cols, 1 / ring.rows);
    u.uInset.value.set(0.5 / ring.bufW, 0.5 / ring.bufH);
    seen.rev = ring.rev;
  }
  u.tRing.value    = ring.texture;
  u.uHead.value    = ring.head;
  u.uN.value       = ring.slots;
  u.uMaxBack.value = frame.maxBack;
  u.uBlend.value   = blend ? 1.0 : 0.0;
  u.uScale.value.set(frame.A, frame.D);
}

/** Uniforms for VOL_KEY_CHUNK. */
export function keyUniforms() {
  return {
    uKeyMode:    { value: 0 },
    uKeyBlack:   { value: 0.1 },
    uKeyWhite:   { value: 1.0 },
    uKeySoft:    { value: 0.05 },
    uKeyHue:     { value: 1 / 3 },
    uKeyRange:   { value: 0.2 },
    uKeyHueSoft: { value: 0.1 },
    uKeyInvert:  { value: 0 },
  };
}

/** Write VOL_KEY_CHUNK's uniforms from read options (see VOL_DEFAULTS). */
export function applyKeyUniforms(u, o) {
  u.uKeyMode.value    = o.key | 0;
  u.uKeyBlack.value   = o.keyBlack;
  u.uKeyWhite.value   = o.keyWhite;
  u.uKeySoft.value    = o.keySoft;
  u.uKeyHue.value     = o.keyHue / 360;
  u.uKeyRange.value   = o.keyRange;
  u.uKeyHueSoft.value = o.keyHueSoft;
  u.uKeyInvert.value  = o.keyInvert ? 1 : 0;
}

/** Uniform set for VOL_SAMPLE_CHUNK + a ring fetch (both dialects' superset). */
export function ringUniforms() {
  return {
    tRing:      { value: null },
    uHead:      { value: 0 },
    uN:         { value: 2 },
    uMaxBack:   { value: 1 },
    uBlend:     { value: 1 },
    uScale:     { value: new THREE.Vector2(1, 1) },
    uCols:      { value: 1 },
    uTileScale: { value: new THREE.Vector2(1, 1) },
    uInset:     { value: new THREE.Vector2(0, 0) },
  };
}

export class SpacetimeSlice {
  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {number} width   output width (follows the ring's tile size)
   * @param {number} height
   */
  constructor(renderer, width = 2, height = 2) {
    this.renderer = renderer;
    this._w = Math.max(1, Math.floor(width));
    this._h = Math.max(1, Math.floor(height));
    this._seen  = { rev: -1 };
    this._frame = { R: new THREE.Matrix3(), C: new THREE.Vector3() };

    this._cam  = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this._geom = new THREE.PlaneGeometry(2, 2);

    const sliceUniforms = () => ({
      ...ringUniforms(),
      ...keyUniforms(),
      uR:         { value: new THREE.Matrix3() },
      uC:         { value: new THREE.Vector3() },
      uZoom:      { value: 1 },
      uAspectOut: { value: 1 },
      uEdge:      { value: 0 },
    });
    const mk = (glsl3) => new THREE.ShaderMaterial({
      ...(glsl3 ? { glslVersion: THREE.GLSL3 } : {}),
      uniforms:       sliceUniforms(),
      vertexShader:   glsl3 ? ARRAY_VERT : VERT,
      fragmentShader: glsl3 ? ARRAY_FRAG : ATLAS_FRAG,
      depthTest: false, depthWrite: false,
    });
    this._arrayMat = mk(true);
    this._atlasMat = mk(false);
    this._arrayScene = new THREE.Scene();
    this._arrayScene.add(new THREE.Mesh(this._geom, this._arrayMat));
    this._atlasScene = new THREE.Scene();
    this._atlasScene.add(new THREE.Mesh(this._geom, this._atlasMat));

    this._outRT = new THREE.WebGLRenderTarget(this._w, this._h, {
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat, type: THREE.UnsignedByteType,
      depthBuffer: false, generateMipmaps: false,
    });
  }

  /**
   * Cut `ring` with the plane in `opts` (see VOL_DEFAULTS) and publish it.
   * The output follows the ring's tile size, so a buffer-resolution change
   * needs no call from main.js.
   */
  render(ring, opts = {}) {
    if (!ring.texture || ring.count < 1) return;
    if (ring.bufW !== this._w || ring.bufH !== this._h) this.setSize(ring.bufW, ring.bufH);

    const o = { ...VOL_DEFAULTS, ...opts };
    const f = volFrame(o, ring, this._frame);
    const useArray = ring.useArray;
    const u = (useArray ? this._arrayMat : this._atlasMat).uniforms;
    // Each material carries its own atlas layout; a strategy flip must re-apply.
    if (this._seenArray !== useArray) { this._seen.rev = -1; this._seenArray = useArray; }
    applyRingUniforms(u, ring, f, o.blend, this._seen);
    u.uR.value.copy(f.R);
    u.uC.value.copy(f.C);
    u.uZoom.value      = Math.max(0.01, o.zoom);
    u.uAspectOut.value = this._w / this._h;
    u.uEdge.value      = o.edge | 0;
    applyKeyUniforms(u, o);

    const r = this.renderer;
    const prevRT = r.getRenderTarget();
    r.setRenderTarget(this._outRT);
    r.render(useArray ? this._arrayScene : this._atlasScene, this._cam);
    r.setRenderTarget(prevRT);
  }

  get texture() { return this._outRT.texture; }
  get renderTarget() { return this._outRT; }
  get width()  { return this._w; }
  get height() { return this._h; }

  setSize(w, h) {
    w = Math.max(1, Math.floor(w));
    h = Math.max(1, Math.floor(h));
    if (w === this._w && h === this._h) return;
    this._w = w;
    this._h = h;
    this._outRT.setSize(w, h);
  }

  dispose() {
    this._outRT.dispose();
    this._arrayMat.dispose();
    this._atlasMat.dispose();
    this._geom.dispose();
  }
}
