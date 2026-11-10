/**
 * Splat World — source 37: the Stills Buffer image on show, as a 3D world of
 * soft points pushed out by its own AI Depth map, seen by a slowly drifting
 * camera.
 *
 * Every point is one pixel of the picture, UNPROJECTED through a pinhole
 * camera: from the rest position the points reproject exactly onto the image,
 * and any drift away from it shows parallax. Depth Anything gives relative
 * INVERSE depth (white = near), so distance is 1 / mix(1/far, 1/near, d).
 * Holes open behind near things as the camera swings — the honest cost of a
 * world made from one view.
 *
 * Fades are per point, in step with the 2D Morph (DEPTH_MORPH): each point
 * moves from its place in world A to its place in world B, colour with it,
 * delayed by depth (near first) by reimagine.morph. Morph 0 moves every point
 * together. ONE definition of "which slots are showing": StillsBuffer's own
 * resolved readIndex / read2Index, as AI Depth uses.
 *
 * Scatter (splat.scatter / shape / flow) lets the points leave: each keeps an
 * OFFSET from its home in a float texture and flows along a strange attractor
 * (SplatAttractors.js) until called back. Home goes on moving underneath —
 * Relief, a fade to the next image — so points that left picture A can land
 * in picture B. At Scatter 0, once settled, none of it runs.
 *
 * Rendered only while something consumes source 37 (_srcUsed in main.js).
 */
import * as THREE from 'three';
import { attractorGLSL } from './SplatAttractors.js';

const DENSITY_ROWS = [180, 288, 432];   // splat.density Low / Mid / High
const FOV = 50;                         // degrees, vertical
const NEAR_D = 1.0;                     // distance of the nearest point
const MAX_FAR = 6.0;                    // far distance at Relief 100 %

const FIT = 0.8;                        // an attractor fills this much of the frame height
const PULL = 3.0;                       // 1/s: how hard Scatter 0 calls a point home
const OFF_MAX = 100.0;                  // the sim never stores an offset longer than this
const OFF_EPS = 1.0e-4;                 // … and one shorter than this is home (far below a pixel)
// At Scatter 0 an offset only decays, by exp(-PULL·dt) a step — so after this
// many simulated seconds every one of them is below OFF_EPS. A bound computed
// from the two limits above, not a guess at when things look settled.
const SETTLE_S = Math.log(OFF_MAX / OFF_EPS) / PULL;
const MAX_DT = 1 / 30;                  // a stalled tab must not become one giant step

// Where a point LIVES: its pixel unprojected through the pinhole, on its way
// from world A to world B. One definition, used by the vertex shader that
// draws the point and by the sim that moves it away from here and back.
const HOME = /* glsl */ `
  uniform sampler2D uDepA;
  uniform sampler2D uDepB;
  uniform float uT;          // fade 0..1 (FrameBlend)
  uniform float uMorph;      // 0..1
  uniform float uFar;
  uniform float uTanHalf;    // tan(fov/2)
  uniform float uAspect;

  vec3 unproject(vec2 uv, float d) {
    float dist = 1.0 / mix(1.0 / uFar, 1.0 / ${NEAR_D.toFixed(1)}, clamp(d, 0.0, 1.0));
    vec2 ndc = uv * 2.0 - 1.0;
    return vec3(ndc.x * uTanHalf * uAspect * dist, ndc.y * uTanHalf * dist, -dist);
  }

  // k: how far this point's own fade has got (0 = world A, 1 = world B).
  vec3 home(vec2 uv, out float k) {
    float dA = texture2D(uDepA, uv).r;
    float dB = texture2D(uDepB, uv).r;
    float spread = 0.7 * uMorph;
    float delay = (1.0 - max(dA, dB)) * spread;
    k = clamp((uT - delay) / (1.0 - spread), 0.0, 1.0);
    k = mix(k, smoothstep(0.0, 1.0, k), uMorph);
    return mix(unproject(uv, dA), unproject(uv, dB), k);
  }
`;

const VERT = /* glsl */ `
  uniform sampler2D uColA;
  uniform sampler2D uColB;
  uniform sampler2D uOff;    // each point's offset from home (Scatter); zero at rest
  uniform float uFoot;       // world footprint per unit distance
  uniform float uPxPerUnit;  // target height px / (2 tan(fov/2))
  uniform float uSize;
  attribute vec2 aUv;
  #ifdef SURFACE
  varying vec2 vUv;
  varying float vK;
  #else
  varying vec3 vCol;
  #endif
  ${HOME}

  void main() {
    float k;
    vec3 h = home(aUv, k);
    #ifdef SURFACE
    vec3 p = h;
    #else
    vec3 p = h + texture2D(uOff, aUv).xyz;
    #endif
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    #ifdef SURFACE
    vUv = aUv;
    vK = k;
    #else
    vCol = mix(texture2D(uColA, aUv).rgb, texture2D(uColB, aUv).rgb, k);
    // A point covers its own pixel's footprint at ITS distance, seen from
    // where the camera now is — so the world stays closed at rest. The
    // distance is HOME's: a scattered point keeps the size of its pixel, and
    // one that has flowed behind the lens plane must not get a negative size.
    float foot = -h.z * uFoot * uSize;
    gl_PointSize = clamp(foot * uPxPerUnit / max(-mv.z, 0.05), 1.0, 64.0);
    #endif
  }
`;

// Scatter: one texel per point holds its OFFSET from home, not its position —
// so at offset zero the picture is exact by construction, and home is free to
// move (Relief, a fade to the next image) without the points having to chase
// it. Each step: flow along the attractor (midpoint rule), then decay toward
// home by how far Scatter is from 100 %.
const SIM_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const SIM_FRAG = /* glsl */ `
  uniform sampler2D uOff;
  uniform float uDt;
  uniform float uScatter;    // 0..1
  uniform float uFlow;       // 0..2
  uniform float uShape;
  uniform float uPivotD;     // the middle of the world is (0, 0, -uPivotD)
  uniform float uFrame;      // world units per frame unit at the pivot
  varying vec2 vUv;
  ${HOME}
  ${attractorGLSL()}

  void main() {
    float k;
    vec3 h = home(vUv, k);
    vec3 pivot = vec3(0.0, 0.0, -uPivotD);
    vec3 w = (h + texture2D(uOff, vUv).xyz - pivot) / uFrame;
    float hs = uScatter * uFlow * uDt;
    vec3 mid = w + flow(w, uShape) * hs * 0.5;
    w += flow(mid, uShape) * hs;
    vec3 off = (pivot + w * uFrame - h) * exp(-${PULL.toFixed(1)} * (1.0 - uScatter) * uDt);
    // NaN or a runaway would live in the ping-pong for good: send it home.
    // Written as !(a < b) so that NaN, which fails every comparison, is caught.
    if (!(dot(off, off) < ${(OFF_MAX * OFF_MAX).toFixed(1)})) off = vec3(0.0);
    gl_FragColor = vec4(off, 1.0);
  }
`;

// Surface: colour is read per PIXEL here, not per vertex, so the picture keeps
// its full resolution however coarse the grid that carries it.
const FRAG_SURFACE = /* glsl */ `
  uniform sampler2D uColA;
  uniform sampler2D uColB;
  varying vec2 vUv;
  varying float vK;
  void main() {
    gl_FragColor = vec4(mix(texture2D(uColA, vUv).rgb, texture2D(uColB, vUv).rgb, vK), 1.0);
  }
`;

const FRAG = /* glsl */ `
  varying vec3 vCol;
  void main() {
    vec2 c = gl_PointCoord * 2.0 - 1.0;
    float r2 = dot(c, c);
    if (r2 > 1.0) discard;
    // A little darker at the rim: reads as a soft splat, not a flat disc.
    gl_FragColor = vec4(vCol * (1.0 - 0.25 * r2), 1.0);
  }
`;

export class SplatWorld {
  constructor(renderer, width, height) {
    this.renderer = renderer;
    this.width = width; this.height = height;
    this.target = new THREE.WebGLRenderTarget(width, height, {
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat, type: THREE.UnsignedByteType,
      generateMipmaps: false, depthBuffer: true,
    });
    const black = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1, THREE.RGBAFormat);
    black.needsUpdate = true;
    this._black = black;
    this._mat = new THREE.ShaderMaterial({
      uniforms: {
        uColA: { value: black }, uColB: { value: black },
        uDepA: { value: black }, uDepB: { value: black },
        uT: { value: 0 }, uMorph: { value: 0 }, uFar: { value: 3 },
        uTanHalf: { value: Math.tan(THREE.MathUtils.degToRad(FOV / 2)) },
        uAspect: { value: width / height }, uFoot: { value: 0 },
        uPxPerUnit: { value: 1 }, uSize: { value: 1 },
        uOff: { value: black },
      },
      vertexShader: VERT, fragmentShader: FRAG,
      depthTest: true, depthWrite: true,
    });
    // The same uniforms object, so render() fills one set for both materials.
    // Two-sided: Orbit reaches 180°, and the skin must not vanish from behind.
    this._matSurface = new THREE.ShaderMaterial({
      uniforms: this._mat.uniforms,
      defines: { SURFACE: 1 },
      vertexShader: VERT, fragmentShader: FRAG_SURFACE,
      depthTest: true, depthWrite: true, side: THREE.DoubleSide,
    });
    this._scene = new THREE.Scene();
    this._camera = new THREE.PerspectiveCamera(FOV, width / height, 0.05, 50);
    this._points = null;
    this._grid = null;   // "rows x cols" the geometry was built for
    this._t = 0;

    // Scatter sim. It shares the HOME uniforms with the draw BY OBJECT, so
    // render() fills them once and the two can never disagree about where
    // home is. Its targets are allocated the first time Scatter leaves 0.
    const mu = this._mat.uniforms;
    this._simMat = new THREE.ShaderMaterial({
      uniforms: {
        uDepA: mu.uDepA, uDepB: mu.uDepB, uT: mu.uT, uMorph: mu.uMorph,
        uFar: mu.uFar, uTanHalf: mu.uTanHalf, uAspect: mu.uAspect,
        uOff: { value: black }, uDt: { value: 0 }, uScatter: { value: 0 },
        uFlow: { value: 1 }, uShape: { value: 0 },
        uPivotD: { value: 1 }, uFrame: { value: 1 },
      },
      vertexShader: SIM_VERT, fragmentShader: SIM_FRAG,
      depthTest: false, depthWrite: false, blending: THREE.NoBlending,
    });
    this._simScene = new THREE.Scene();
    this._simQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this._simMat);
    this._simQuad.frustumCulled = false;
    this._simScene.add(this._simQuad);
    this._simCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this._off = null;    // [target, target], ping-pong
    this._offKey = '';   // "rows x cols" they were built for
    this._offCur = 0;
    this._settle = 0;    // simulated seconds until every offset is home
  }

  /** True while any point may be away from home. */
  get scattered() { return this._settle > 0; }

  // Both targets at `rows x cols`, both zero: every point at home.
  _ensureOff(rows, cols) {
    const key = `${rows}x${cols}`;
    if (this._off && key === this._offKey) return;
    this._off?.forEach(rt => rt.dispose());
    const opts = {
      minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
      format: THREE.RGBAFormat, type: THREE.FloatType,
      generateMipmaps: false, depthBuffer: false,
    };
    this._off = [
      new THREE.WebGLRenderTarget(cols, rows, opts),
      new THREE.WebGLRenderTarget(cols, rows, opts),
    ];
    this._offKey = key;
    this._offCur = 0;
    this._zeroOff();
  }

  _zeroOff() {
    const r = this.renderer;
    const prev = r.getRenderTarget();
    const prevClear = r.getClearColor(new THREE.Color());
    const prevAlpha = r.getClearAlpha();
    r.setClearColor(0x000000, 0);
    for (const rt of this._off) { r.setRenderTarget(rt); r.clear(true, false, false); }
    r.setClearColor(prevClear, prevAlpha);
    r.setRenderTarget(prev);
  }

  // One step of the Scatter sim; returns the texture of offsets to draw with.
  // `dt` is already clamped — the same number the settle clock counts down by.
  _stepScatter(ps, s, dt, pivotD) {
    const u = this._simMat.uniforms;
    u.uOff.value = this._off[this._offCur].texture;
    u.uDt.value = dt;
    u.uScatter.value = s;
    u.uFlow.value = ps.get('splat.flow').value / 100;
    u.uShape.value = Math.round(ps.get('splat.shape').value);
    u.uPivotD.value = pivotD;
    u.uFrame.value = FIT * u.uTanHalf.value * pivotD;
    const next = 1 - this._offCur;
    const prev = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(this._off[next]);
    this.renderer.render(this._simScene, this._simCam);
    this.renderer.setRenderTarget(prev);
    this._offCur = next;
    return this._off[next].texture;
  }

  get texture() { return this.target.texture; }

  _ensureGrid(rows, surface) {
    const cols = Math.max(2, Math.round(rows * this.width / this.height));
    const key = `${rows}x${cols}${surface ? 's' : 'p'}`;
    if (key === this._grid) return;
    if (this._points) { this._scene.remove(this._points); this._points.geometry.dispose(); }
    const n = rows * cols;
    const uv = new Float32Array(n * 2);
    for (let j = 0, i = 0; j < rows; j++) {
      for (let c = 0; c < cols; c++, i++) {
        // Points sit at texel centres, as the warp map is authored (CLAUDE.md,
        // Phase 24). A surface's vertices run edge to edge, or the skin would
        // stop half a cell short of the picture's border.
        uv[i * 2] = surface ? c / (cols - 1) : (c + 0.5) / cols;
        uv[i * 2 + 1] = surface ? j / (rows - 1) : (j + 0.5) / rows;
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('aUv', new THREE.BufferAttribute(uv, 2));
    // Position is computed in the shader; three still wants an attribute
    // named position for its draw-count and bounds.
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    if (surface) {
      const idx = new Uint32Array((rows - 1) * (cols - 1) * 6);
      let k = 0;
      for (let j = 0; j < rows - 1; j++) {
        for (let c = 0; c < cols - 1; c++) {
          const a = j * cols + c, b = a + 1, d = a + cols, e = d + 1;
          idx[k++] = a; idx[k++] = b; idx[k++] = e;
          idx[k++] = a; idx[k++] = e; idx[k++] = d;
        }
      }
      g.setIndex(new THREE.BufferAttribute(idx, 1));
      this._points = new THREE.Mesh(g, this._matSurface);
    } else {
      this._points = new THREE.Points(g, this._mat);
    }
    this._points.frustumCulled = false;
    this._scene.add(this._points);
    this._grid = key;
    this._rows = rows;
    this._cols = cols;
  }

  /**
   * @param {import('../inputs/StillsBuffer.js').StillsBuffer} sb
   * @param {import('./AIDepth.js').AIDepth} depth
   */
  render(ps, sb, depth, dt) {
    const rows = DENSITY_ROWS[Math.round(ps.get('splat.density').value)] ?? DENSITY_ROWS[1];
    // Scatter above 0 (re)starts the settle clock; at 0 it runs down, below,
    // by the time the sim actually steps. While it is running, points may be out.
    const scatter = ps.get('splat.scatter').value / 100;
    const simDt = Math.min(Math.max(dt, 0), MAX_DT);
    const wasOut = this._settle > 0;
    if (scatter > 0) this._settle = SETTLE_S;
    const out = this._settle > 0;
    // A skin of scattered vertices is a screenful of giant triangles, so while
    // points are out the world is drawn as Points whatever Draw says.
    this._ensureGrid(rows, !out && Math.round(ps.get('splat.draw').value) === 1);
    const a = sb.readIndex, b = sb.read2Index;
    const fb = ps.get('buffer.frameblend').value / 100;
    const u = this._mat.uniforms;
    const colA = sb._hasFrame[a] ? sb.frames[a].texture : null;
    const colB = sb._hasFrame[b] ? sb.frames[b].texture : null;
    // Not fading (or nothing to fade to): show world A whole.
    const fading = fb > 0 && colB;
    u.uColA.value = colA ?? this._black;
    u.uColB.value = fading ? colB : u.uColA.value;
    u.uDepA.value = depth.map(a) ?? this._black;
    u.uDepB.value = fading ? (depth.map(b) ?? this._black) : u.uDepA.value;
    u.uT.value = fading ? fb : 0;
    u.uMorph.value = ps.get('reimagine.morph').value / 100;
    const relief = ps.get('splat.relief').value / 100;
    u.uFar.value = NEAR_D + 0.001 + relief * (MAX_FAR - NEAR_D);
    u.uAspect.value = this.width / this.height;
    u.uFoot.value = 1.6 * 2 * u.uTanHalf.value / this._rows;
    u.uPxPerUnit.value = this.height / (2 * u.uTanHalf.value);
    u.uSize.value = ps.get('splat.size').value / 100;
    // The middle of the world: what the camera orbits, and where an attractor sits.
    const pivotD = 1 / ((1 / u.uFar.value + 1 / NEAR_D) / 2);

    if (out) {
      this._ensureOff(this._rows, this._cols);
      // Coming back from rest: what the targets hold is below OFF_EPS, not
      // zero. Start clean, so rest always means exactly the picture.
      if (!wasOut) this._zeroOff();
      u.uOff.value = this._stepScatter(ps, scatter, simDt, pivotD);
      if (scatter <= 0) this._settle -= simDt;
    } else {
      u.uOff.value = this._black;
    }

    // Camera: it orbits a PIVOT in the middle of the world, so the parallax is
    // around the subject rather than the lens. Orbit/Tilt are the owner's
    // angle, Sway the automatic swing on top. Distance from the pivot: rest is
    // pivotD (camera at the lens, picture exact); Dolly moves in up to the
    // pivot, Fly travels on in and back out through the world. The camera's
    // ORIENTATION comes from the angles alone, never lookAt(pivot) — lookAt
    // flips the view the moment the camera passes through the pivot.
    this._t += dt * ps.get('splat.speed').value;
    const ph = this._t * Math.PI * 2;
    const D2R = Math.PI / 180;
    const sway = ps.get('splat.sway').value * D2R;
    const yaw = ps.get('splat.orbit').value * D2R + sway * Math.sin(ph);
    const pitch = ps.get('splat.tilt').value * D2R + sway * 0.4 * Math.sin(ph * 0.63 + 1.1);
    const dolly = ps.get('splat.dolly').value / 100;
    const fly = ps.get('splat.fly').value / 100;
    const r = pivotD * (1 - dolly)
      - fly * 0.9 * u.uFar.value * (0.5 - 0.5 * Math.cos(ph * 0.5));
    const cam = this._camera;
    cam.aspect = this.width / this.height;
    cam.updateProjectionMatrix();
    cam.position.set(
      r * Math.sin(yaw) * Math.cos(pitch),
      r * Math.sin(pitch),
      -pivotD + r * Math.cos(yaw) * Math.cos(pitch),
    );
    cam.rotation.set(-pitch, yaw, 0, 'YXZ');

    const prev = this.renderer.getRenderTarget();
    const prevClear = this.renderer.getClearColor(new THREE.Color());
    const prevAlpha = this.renderer.getClearAlpha();
    this.renderer.setRenderTarget(this.target);
    this.renderer.setClearColor(0x000000, 1);
    this.renderer.clear(true, true, false);
    this.renderer.render(this._scene, cam);
    this.renderer.setClearColor(prevClear, prevAlpha);
    this.renderer.setRenderTarget(prev);
  }

  resize(w, h) {
    this.width = w; this.height = h;
    this.target.setSize(w, h);
    this._grid = null;   // the grid follows the aspect
  }
}
