/**
 * ImWeb Spacetime Volume — the frame history seen as an object.
 *
 * Woody and Steina's "Time/Energy Object", rendered: the ring is drawn as a box
 * in (x, y, t) and a camera orbits it. Front face = the newest frame; the side
 * faces are the slit-scans of the frame's edges; the top is the history of its
 * top row. Blueprint: docs/ImWeb-Spacetime-Blueprint.md §13.
 *
 * Technique after three.js's VolumeRenderShader1 (examples/jsm/shaders/
 * VolumeShader.js): rasterise the box, cast one ray per fragment, step through.
 * Two deliberate differences —
 *   - it reads the `sampler2DArray` ring rather than a `sampler3D`. Render-to-
 *     layer is already proven and probed there; the price is interpolating
 *     across time by hand (VOL_SAMPLE_CHUNK, shared with SpacetimeSlice).
 *   - the BACK faces are rasterised and the entry point is found by a slab
 *     test, so the picture survives the camera entering the box (wide fov).
 *
 * Render modes (`vol.render`):
 *   Solid   — the box as an opaque block: the first sample inside. Analytic, one
 *             fetch per pixel, and with Cut on it is the CT picture.
 *   Glow    — front-to-back alpha; opacity from luminance above a threshold, so
 *             dark history turns clear and bright motion becomes tubes.
 *   Max     — brightest value along the ray (MIP): a long exposure from the side.
 *   Average — mean along the ray: the time smear.
 *
 * Cut (`vol.cut`): everything on the camera's side of the slice plane is
 * removed. The plane is the same `volFrame()` the Slice source uses, so the cut
 * face in Solid mode IS the slice — one source of truth.
 *
 * Camera: orbit (yaw, pitch) at a framing that stays constant as fov changes —
 * the distance follows the fov — so fov is "how much perspective", and below 1°
 * it becomes an OrthographicCamera at the same framing: front / side / top
 * orthogonal views from the same controls.
 *
 * ARRAY PATH ONLY. The atlas fallback could address frames, but stepping
 * hundreds of tile lookups per pixel on hardware that already failed the
 * render-to-layer probe is the wrong trade; main.js publishes the Slice there
 * and says so once in the console.
 */

import * as THREE from 'three';
import { RING_FETCH_ARRAY, VOL_SAMPLE_CHUNK, VOL_KEY_CHUNK, VOL_DEFAULTS, volFrame,
         applyRingUniforms, ringUniforms, keyUniforms, applyKeyUniforms } from './SpacetimeSlice.js';

const VOL_VERT = /* glsl */ `
  out vec3 vW;
  void main() {
    vec4 w = modelMatrix * vec4(position, 1.0);
    vW = w.xyz;
    gl_Position = projectionMatrix * viewMatrix * w;
  }
`;

const MAX_STEPS = 1024;

const VOL_FRAG = /* glsl */ `
  precision highp float;
  ${RING_FETCH_ARRAY}
  ${VOL_SAMPLE_CHUNK}
  ${VOL_KEY_CHUNK}
  uniform mat3  uR;         // slice plane (cut): column 2 is its normal
  uniform vec3  uC;
  uniform vec3  uHalf;      // box half extents (A/2, 1/2, D/2)
  uniform int   uOrtho;
  uniform vec3  uCamDir;    // forward, for the orthographic ray
  uniform int   uRender;    // 0 solid, 1 glow, 2 max, 3 average
  uniform int   uCut;
  uniform float uStep;      // world units per step
  uniform float uThresh;    // glow: luminance where opacity starts
  uniform float uSigma;     // glow: extinction per world unit
  uniform float uFrame;     // jitter seed
  uniform int   uShade;     // keyed Solid: light the surface from its key gradient
  uniform int   uShape;     // 0 box, 1 cylinder, 2 sphere, 3 tunnel, 4 ring
  uniform vec3  uRing;      // ring: (major radius, cross-section half width, half height)
  in  vec3 vW;
  out vec4 outColor;

  float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }
  // Inside the box by construction; the clamp absorbs face round-off, which
  // would otherwise read as black speckle along every edge.
  vec4 at(vec3 W) { return volSample(clamp(volFromWorld(W), 0.0, 1.0)); }

  // ── Shapes: which world points are inside the object, and which frame
  // pixel each one shows. Box is the plain block. The others carve it, or for
  // Ring bend it: a world point maps to volume coords P and an inside value
  // that is soft over one ray step, so the shading has a gradient to follow.
  //   Cylinder — each frame cut to a disc: a tube of time
  //   Sphere   — the ellipsoid inscribed in the block
  //   Tunnel   — older frames shrink: the past recedes like a perspective
  //   Ring     — time runs round a circle; newest meets oldest at the front
  vec3 shapeP(vec3 W, out float inside) {
    float e = uStep;
    float d;
    vec3  P;
    if (uShape == 4) {
      float ang = atan(W.x, W.z);                         // 0 at the front (+z)
      float rho = length(W.xz) - uRing.x;                 // across the tube
      P = vec3(0.5 + rho / (2.0 * uRing.y), 0.5 + W.y / (2.0 * uRing.z),
               fract(ang / 6.2831853));
      d = max(abs(rho) - uRing.y, abs(W.y) - uRing.z);
    } else {
      P = volFromWorld(W);
      vec2 q = (P.xy - 0.5) * vec2(uScale.x, 1.0);        // frame coords, height units
      if (uShape == 0) {
        inside = 1.0;
        return P;
      } else if (uShape == 1) {
        d = length(q) - 0.5;
      } else if (uShape == 2) {
        d = (length((P - 0.5) * 2.0) - 1.0) * 0.5 * min(min(uScale.x, uScale.y), 1.0);
      } else {
        float sc = 1.0 - 0.85 * P.z;                      // 1 now → 0.15 at the oldest
        P.xy = 0.5 + (P.xy - 0.5) / sc;
        d = max(abs(q.x) - 0.5 * uScale.x * sc, abs(q.y) - 0.5 * sc);
      }
    }
    inside = 1.0 - smoothstep(-e, e, d);
    return P;
  }
  // Material at W: inside the shape AND kept by the key. Outside the shape
  // nothing is fetched at all.
  float matAt(vec3 W, out vec3 c) {
    float inside;
    vec3 P = shapeP(W, inside);
    if (inside <= 0.0) { c = vec3(0.0); return 0.0; }
    c = volSample(clamp(P, 0.0, 1.0)).rgb;
    return inside * volKey(c);
  }
  float matAt(vec3 W) { vec3 c; return matAt(W, c); }

  void main() {
    vec3 rd = uOrtho == 1 ? normalize(uCamDir) : normalize(vW - cameraPosition);
    vec3 ro = uOrtho == 1 ? vW - rd * 100.0 : cameraPosition;

    // Slab test. A zero direction component gives ±inf, which min/max order
    // correctly; nudge it so 0 * inf never makes a NaN.
    vec3 inv = 1.0 / (rd + vec3(equal(rd, vec3(0.0))) * 1e-7);
    vec3 ta = (-uHalf - ro) * inv, tb = (uHalf - ro) * inv;
    vec3 tmin = min(ta, tb), tmax = max(ta, tb);
    float tn = max(max(tmin.x, tmin.y), max(tmin.z, 0.0));
    float tf = min(min(tmax.x, tmax.y), tmax.z);

    if (uCut == 1) {
      // Keep the half-space AWAY from the camera: s(t) = side·dot(p − C, n) ≤ 0.
      vec3  n    = uR[2];
      float side = dot(ro - uC, n) >= 0.0 ? 1.0 : -1.0;
      float s0   = side * dot(ro - uC, n);
      float sd   = side * dot(rd, n);
      if (abs(sd) < 1e-6) { if (s0 > 0.0) tf = -1.0; }
      else {
        float tp = -s0 / sd;
        if (sd > 0.0) tf = min(tf, tp); else tn = max(tn, tp);
      }
    }
    // Outside the material is transparent once a key is on, so the output
    // keyer's Alpha mode can stand the sculpture on a background. Key Off keeps
    // the opaque black this view always had.
    float bgA = uKeyMode == 0 ? 1.0 : 0.0;
    if (tf <= tn) { outColor = vec4(0.0, 0.0, 0.0, bgA); return; }

    // Unkeyed Solid box: the block's faces are analytic — one sample, no march.
    if (uRender == 0 && uKeyMode == 0 && uShape == 0) { outColor = vec4(at(ro + rd * tn).rgb, 1.0); return; }

    if (uRender == 0) {
      // SOLID SURFACE — a keyed sculpture and/or a shape. March to the first
      // sample that is material (>= 0.5), then bisect between it and the
      // previous step so the surface sits on the 50% crossing rather than on
      // the step grid. The frame crossfade interpolates the key too, which is
      // what makes that surface smooth along time instead of stepped.
      float tPrev = tn, tHit = -1.0;
      for (int i = 0; i < ${MAX_STEPS}; i++) {
        float t = min(tn + float(i) * uStep, tf);
        if (matAt(ro + rd * t) >= 0.5) { tHit = t; break; }
        tPrev = t;
        if (t >= tf) break;
      }
      if (tHit < 0.0) { outColor = vec4(0.0, 0.0, 0.0, bgA); return; }
      bool face = tHit <= tn;           // material reaches the box face / cut plane
      if (!face) {
        float a = tPrev, b = tHit;
        for (int k = 0; k < 6; k++) {
          float mid = 0.5 * (a + b);
          if (matAt(ro + rd * mid) >= 0.5) b = mid; else a = mid;
        }
        tHit = b;
      }
      vec3 W = ro + rd * tHit;
      vec3 col;
      matAt(W, col);
      // A face is a flat cut through material — it keeps its picture unlit, as
      // the cut face does unkeyed. Elsewhere the key's gradient is the normal.
      if (uShade == 1 && !face) {
        float h = 1.5 * uStep;
        vec3 g = vec3(
          matAt(W + vec3(h, 0, 0)) - matAt(W - vec3(h, 0, 0)),
          matAt(W + vec3(0, h, 0)) - matAt(W - vec3(0, h, 0)),
          matAt(W + vec3(0, 0, h)) - matAt(W - vec3(0, 0, h)));
        if (dot(g, g) > 1e-8) {
          vec3 n = -normalize(g);                          // key rises INTO material
          vec3 L = normalize(-rd + vec3(0.0, 0.6, 0.0));   // headlight, from above
          col *= 0.35 + 0.65 * max(dot(n, L), 0.0);
        }
      }
      outColor = vec4(col, 1.0);
      return;
    }

    // March. Jittered start so the step layers do not show as rings.
    float t0 = tn + hash12(gl_FragCoord.xy + uFrame) * uStep;
    float a1 = 1.0 - exp(-uSigma * uStep);    // glow opacity of one step at full mask
    vec4  acc = vec4(0.0);
    vec3  mx  = vec3(0.0), sum = vec3(0.0);
    float cnt = 0.0, mMax = 0.0;
    for (int i = 0; i < ${MAX_STEPS}; i++) {
      float t = t0 + float(i) * uStep;
      if (t > tf) break;
      vec3  c;
      float m = matAt(ro + rd * t, c);  // shape × key; 1 inside a box with the key Off
      if (m <= 0.0) continue;
      if (uRender == 1) {
        // The key decides what glows once it is on; Off keeps the threshold.
        float l = dot(c, vec3(0.299, 0.587, 0.114));
        float a = (uKeyMode == 0 ? m * smoothstep(uThresh, uThresh + 0.1, l) : m) * a1;
        acc.rgb += (1.0 - acc.a) * a * c;
        acc.a   += (1.0 - acc.a) * a;
        if (acc.a > 0.98) break;
      } else if (uRender == 2) {
        mx = max(mx, c * m); mMax = max(mMax, m);
      } else {
        sum += c * m; cnt += m;           // keyed-out samples carry no weight
      }
    }
    vec3  col = uRender == 1 ? acc.rgb : uRender == 2 ? mx : sum / max(cnt, 1e-3);
    float cov = uRender == 1 ? acc.a : uRender == 2 ? mMax : min(cnt, 1.0);
    outColor = vec4(col, uKeyMode == 0 ? 1.0 : cov);
  }
`;

/** Volume-only defaults; the plane fields come from VOL_DEFAULTS. */
export const VOLUME_DEFAULTS = {
  ...VOL_DEFAULTS,
  render: 0, cut: 0,
  camYaw: 35, camPitch: 20, camZoom: 1, fov: 35, panX: 0, panY: 0,
  camSmooth: 0.12, dt: 1 / 60,   // camera easing time constant (s); 0 = none
  threshold: 0.2, density: 0.3, steps: 200, box: 1, shade: 1, shape: 0,
};

export class SpacetimeVolume {
  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {number} width   output width (canvas × vol.res)
   * @param {number} height
   */
  constructor(renderer, width = 2, height = 2) {
    this.renderer = renderer;
    this._w = Math.max(1, Math.floor(width));
    this._h = Math.max(1, Math.floor(height));
    this._seen  = { rev: -1 };
    this._frame = { R: new THREE.Matrix3(), C: new THREE.Vector3() };
    this._n = 0;
    this._clearCol = new THREE.Color();

    this._persp = new THREE.PerspectiveCamera(35, 1, 0.01, 100);
    this._ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 200);

    this._mat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: {
        ...ringUniforms(),
        ...keyUniforms(),
        uShade:  { value: 1 },
        uShape:  { value: 0 },
        uRing:   { value: new THREE.Vector3(1, 0.5, 0.25) },
        uR:      { value: new THREE.Matrix3() },
        uC:      { value: new THREE.Vector3() },
        uHalf:   { value: new THREE.Vector3(0.5, 0.5, 0.5) },
        uOrtho:  { value: 0 },
        uCamDir: { value: new THREE.Vector3(0, 0, -1) },
        uRender: { value: 0 },
        uCut:    { value: 0 },
        uStep:   { value: 0.01 },
        uThresh: { value: 0.2 },
        uSigma:  { value: 20 },
        uFrame:  { value: 0 },
      },
      vertexShader:   VOL_VERT,
      fragmentShader: VOL_FRAG,
      side: THREE.BackSide,
      depthTest: false, depthWrite: false,
    });
    this._boxGeom = new THREE.BoxGeometry(1, 1, 1);
    this._box  = new THREE.Mesh(this._boxGeom, this._mat);
    this._edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(this._boxGeom),
      new THREE.LineBasicMaterial({ color: 0x6a7d90, depthTest: false }),
    );
    this._edges.renderOrder = 1;
    this._scene = new THREE.Scene();
    this._scene.add(this._box, this._edges);

    this._outRT = new THREE.WebGLRenderTarget(this._w, this._h, {
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat, type: THREE.UnsignedByteType,
      depthBuffer: false, generateMipmaps: false,
    });
  }

  /** Render `ring` as a box seen through the camera in `opts` (VOLUME_DEFAULTS). */
  render(ring, opts = {}) {
    if (!ring.texture || !ring.useArray || ring.count < 1) return;
    const o = { ...VOLUME_DEFAULTS, ...opts };
    const f = volFrame(o, ring, this._frame);
    const u = this._mat.uniforms;
    applyRingUniforms(u, ring, f, o.blend, this._seen);

    // Bounds: the block for every shape but Ring, which bends the block round
    // a circle. Ring keeps the frame's proportions in its cross-section (half
    // the block's height) and turns Time depth into the circle's size, so
    // "how long the time path is" still means the same thing.
    const shape = o.shape | 0;
    let bx = f.A, by = 1, bz = f.D;
    if (shape === 4) {
      const hh = 0.25, hw = hh * f.A;            // cross-section half height / width
      const R = hw + 0.4 * f.D;                  // inner radius 0.4·D, never closed
      u.uRing.value.set(R, hw, hh);
      bx = bz = 2 * (R + hw);
      by = 2 * hh;
    }
    u.uShape.value = shape;
    this._box.scale.set(bx, by, bz);
    this._edges.scale.copy(this._box.scale);
    this._edges.visible = !!o.box;
    u.uHalf.value.set(bx / 2, by / 2, bz / 2);
    u.uR.value.copy(f.R);
    u.uC.value.copy(f.C);
    u.uRender.value = o.render | 0;
    u.uCut.value    = o.cut ? 1 : 0;
    u.uShade.value  = o.shade ? 1 : 0;
    applyKeyUniforms(u, o);
    // Step length from the box diagonal, so `steps` means "samples across the
    // whole object" whatever its proportions.
    const diag = Math.hypot(bx, by, bz);
    u.uStep.value   = diag / Math.max(8, Math.min(o.steps, 1024));
    u.uThresh.value = o.threshold;
    u.uSigma.value  = 200 * o.density * o.density;   // squared: the useful range is low
    u.uFrame.value  = (this._n = (this._n + 1) % 997);

    // ── Camera smoothing ──
    // The params are the truth (saved, recalled, mapped); what is RENDERED
    // eases toward them with time constant camSmooth. Done here rather than in
    // the gesture code so mouse, touch, MIDI, LFOs and state recalls all glide
    // the same way. Frame-rate independent: k = 1 − e^(−dt/τ). Yaw takes the
    // short way round, so 350° → 10° turns 20°, not 340°.
    const cs = this._camS;
    const k = o.camSmooth > 0 && cs ? 1 - Math.exp(-Math.min(o.dt, 0.25) / o.camSmooth) : 1;
    if (!cs || k >= 1) {
      this._camS = { yaw: o.camYaw, pitch: o.camPitch, zoom: o.camZoom, panX: o.panX, panY: o.panY };
    } else {
      cs.yaw   += ((((o.camYaw - cs.yaw) % 360) + 540) % 360 - 180) * k;
      cs.pitch += (o.camPitch - cs.pitch) * k;
      cs.zoom  *= Math.pow(o.camZoom / cs.zoom, k);   // zoom eases in ratio, not in steps
      cs.panX  += (o.panX - cs.panX) * k;
      cs.panY  += (o.panY - cs.panY) * k;
    }
    const c = this._camS;

    // ── Camera: orbit about the box centre, framing independent of fov ──
    const r = THREE.MathUtils.DEG2RAD;
    const yaw = c.yaw * r, pitch = THREE.MathUtils.clamp(c.pitch, -89, 89) * r;
    const dir = new THREE.Vector3(
      Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch));
    // Frame the box's bounding sphere at 100% zoom, whatever its proportions —
    // a wide frame or a deep history otherwise overhangs the view. A portrait
    // output fits the width instead.
    const aspect = this._w / this._h;
    const radius = 0.5 * diag;
    const halfH  = (1.05 * radius / Math.max(0.05, c.zoom)) / Math.min(1, aspect);
    let cam;
    if (o.fov < 1) {
      cam = this._ortho;
      cam.left = -halfH * aspect; cam.right = halfH * aspect;
      cam.top = halfH; cam.bottom = -halfH;
      cam.position.copy(dir).multiplyScalar(50);
      u.uOrtho.value = 1;
    } else {
      cam = this._persp;
      cam.fov = Math.min(o.fov, 150);
      cam.aspect = aspect;
      const dist = halfH / Math.tan((cam.fov * r) / 2);
      cam.near = 0.01;
      cam.far  = dist + 50;
      cam.position.copy(dir).multiplyScalar(dist);
      u.uOrtho.value = 0;
    }
    cam.up.set(0, 1, 0);
    cam.lookAt(0, 0, 0);
    // Pan: slide camera AND target along the view's own right/up axes, in
    // half-view-heights, so a drag moves the picture under the pointer.
    if (c.panX || c.panY) {
      cam.updateMatrixWorld();
      const m = cam.matrixWorld.elements;          // columns 0/1 = right/up
      const off = new THREE.Vector3(
        m[0] * c.panX + m[4] * c.panY,
        m[1] * c.panX + m[5] * c.panY,
        m[2] * c.panX + m[6] * c.panY).multiplyScalar(halfH);
      cam.position.add(off);
      cam.lookAt(off);
    }
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
    cam.getWorldDirection(u.uCamDir.value);

    const rr = this.renderer;
    const prevRT = rr.getRenderTarget();
    // Clear to transparent when keyed (the sculpture stands on nothing), opaque
    // black otherwise. Done by hand rather than scene.background so the alpha
    // can differ; the renderer's clear state is shared, so restore it.
    const prevCol = rr.getClearColor(this._clearCol);
    const prevA   = rr.getClearAlpha();
    rr.setRenderTarget(this._outRT);
    rr.setClearColor(0x000000, o.key ? 0 : 1);
    rr.clear(true, false, false);
    const prevAuto = rr.autoClear;
    rr.autoClear = false;
    rr.render(this._scene, cam);
    rr.autoClear = prevAuto;
    rr.setClearColor(prevCol, prevA);
    rr.setRenderTarget(prevRT);
  }

  get texture() { return this._outRT.texture; }
  get renderTarget() { return this._outRT; }

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
    this._mat.dispose();
    this._boxGeom.dispose();
    this._edges.geometry.dispose();
    this._edges.material.dispose();
  }
}
