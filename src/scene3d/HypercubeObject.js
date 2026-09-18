/**
 * HypercubeObject.js
 * Three.js wrapper for an N-dimensional hypercube (4D–12D).
 * Renders as LineSegments + Points with additive blending.
 */

import * as THREE from 'three';
import {
  MAX_DIM,
  DIMENSION_COLORS,
  generateVertices,
  generateEdges,
  rotationPlaneCount,
  defaultRotationSpeeds,
  vertexCount,
  edgeCount,
  createMorphState,
  morphStep,
  edgeOpacity,
} from './HypercubeGeometry.js';
import { HypercubeFaces } from './HypercubeFaces.js';
import { HypercubeInstancer } from './HypercubeInstancer.js';

export class HypercubeObject {
  /**
   * @param {THREE.Scene} scene
   * @param {object} options
   * @param {number}  [options.dim=4]
   * @param {number}  [options.wDistance=4]
   * @param {number}  [options.scale=1]
   * @param {string}  [options.projectionMode='perspective']
   * @param {string}  [options.renderMode='wireframe']  'wireframe'|'points'|'both'
   * @param {number}  [options.pointSize=3]
   * @param {number}  [options.edgeOpacity=1]
   */
  constructor(scene, options = {}) {
    this._scene          = scene;
    this._dim            = Math.max(3, Math.min(MAX_DIM, options.dim ?? 4));
    this._lastActiveEdgeIdx = 0;  // lazily computed in _updateBuffers on dim change
    this._cachedDimForRange = -1; // -1 forces compute on first frame
    this._wDistance      = options.wDistance      ?? 4.0;
    this._scale          = options.scale          ?? 1.0;
    this._projectionMode = options.projectionMode ?? 'perspective';
    this._renderMode     = options.renderMode     ?? 'none';
    this._pointSize      = options.pointSize      ?? 3.0;
    this._edgeOpacityMult = options.edgeOpacity   ?? 1.0;

    // N-D geometry
    // Generated once at MAX_DIM — never reallocated
    this._vertices = generateVertices(MAX_DIM);
    this._edges    = generateEdges(MAX_DIM);

    // Rotation state
    this._rotAngles = null;  // Float64Array – one angle per (i<j) plane
    this._rotSpeeds = null;  // Float64Array – rad/s per plane

    // Morph
    this._morphQueue        = [];
    this._morphState        = null;
    this._morphFromVertices = null;
    this._morphFromDim      = null;
    this._morphFromAngles   = null;

    // Vertex subscriber callbacks: Map<vertexIndex, callback[]>
    this._subscribers = new Map();

    // Three.js objects (set by _rebuildGeometry)
    this._lines  = null;
    this._points = null;

    // Permanent buffers — allocated once at MAX_DIM capacity, never reallocated
    const maxEdges = edgeCount(MAX_DIM);
    const maxVerts = vertexCount(MAX_DIM);
    this._linePosBuf = new Float32Array(maxEdges * 6);
    this._lineColBuf = new Float32Array(maxEdges * 6);

    // Quad buffers — 4 verts per edge, 2 triangles per edge
    this._quadEndABuf  = new Float32Array(maxEdges * 4 * 3);  // 4 verts × A.xyz
    this._quadEndBBuf  = new Float32Array(maxEdges * 4 * 3);  // 4 verts × B.xyz
    this._quadColBuf   = new Float32Array(maxEdges * 4 * 3);  // 4 verts × [r g b]
    this._quadSideBuf  = new Float32Array(maxEdges * 4);      // 4 verts × side (+1/-1)
    this._quadTBBuf    = new Float32Array(maxEdges * 4);      // 4 verts × T/B flag (0=A,1=B)
    this._quadIndexBuf = new Uint32Array(maxEdges * 6);       // 2 tris × 3 indices

    // Index buffer — fixed topology, build once
    for (let e = 0; e < maxEdges; e++) {
      const vi = e * 4;
      const ii = e * 6;
      this._quadIndexBuf[ii]     = vi;
      this._quadIndexBuf[ii + 1] = vi + 1;
      this._quadIndexBuf[ii + 2] = vi + 2;
      this._quadIndexBuf[ii + 3] = vi + 2;
      this._quadIndexBuf[ii + 4] = vi + 1;
      this._quadIndexBuf[ii + 5] = vi + 3;
    }

    // Side buffer — fixed (+1 = +extrude, -1 = -extrude), build once
    for (let e = 0; e < maxEdges; e++) {
      const vi = e * 4;
      this._quadSideBuf[vi]     =  1.0;  // vert 0: A end, +extrude
      this._quadSideBuf[vi + 1] =  1.0;  // vert 1: B end, +extrude
      this._quadSideBuf[vi + 2] = -1.0;  // vert 2: A end, -extrude
      this._quadSideBuf[vi + 3] = -1.0;  // vert 3: B end, -extrude
      this._quadTBBuf[vi]       = 0.0;   // vert 0: A end
      this._quadTBBuf[vi + 1]   = 1.0;   // vert 1: B end
      this._quadTBBuf[vi + 2]   = 0.0;   // vert 2: A end
      this._quadTBBuf[vi + 3]   = 1.0;   // vert 3: B end
    }
    this._ptPosBuf   = new Float32Array(maxVerts * 3);
    this._ptColBuf   = new Float32Array(maxVerts * 3);

    // Depth cue by w: per-vertex product of the dim→3 perspective scales (how
    // NEAR a vertex sits in the extra dimensions), normalised per frame to a
    // 0..1 cue, fed to the point and edge shaders. Idle at Depth Cue 0.
    this._depthCue    = 0;
    this._wBuf        = new Float64Array(maxVerts);
    this._morphFromW  = new Float64Array(maxVerts);
    this._morphToW    = new Float64Array(maxVerts);
    this._cueBuf      = new Float32Array(maxVerts);          // points: cue per vertex
    this._quadCueBuf  = new Float32Array(maxEdges * 4 * 2);  // edges: (cueA, cueB) per quad vertex

    // Zero-allocation projection buffers
    this._projBuf          = new Float64Array(maxVerts * 3); // flat xyz output per vertex
    this._scratchCoords    = new Float64Array(MAX_DIM);      // single-vertex scratch
    this._morphFromProjBuf = new Float64Array(maxVerts * 3); // from-projection during morph
    this._morphToProjBuf   = new Float64Array(maxVerts * 3); // to-projection during morph

    // Edge/point colors only change on dim, edgeOpacity or morph events — flag
    // gates color writes + GPU upload to skip ~half the per-frame bandwidth.
    this._colorsDirty = true;
    this._edgeWidth = 1.5;

    // Pre-computed RGB color table — eliminates _hexToRgb() per-frame allocations
    this._colorTable = new Float32Array(DIMENSION_COLORS.length * 3);
    for (let _i = 0; _i < DIMENSION_COLORS.length; _i++) {
      const _h = DIMENSION_COLORS[_i];
      this._colorTable[_i * 3]     = parseInt(_h.slice(1, 3), 16) / 255;
      this._colorTable[_i * 3 + 1] = parseInt(_h.slice(3, 5), 16) / 255;
      this._colorTable[_i * 3 + 2] = parseInt(_h.slice(5, 7), 16) / 255;
    }

    this._rebuild();
    this._hFaces = new HypercubeFaces(scene);
    this._hInstancer = new HypercubeInstancer(scene);
  }

  // ── Internal rebuild ──────────────────────────────────────────────────────

  _rebuild() {
    // vertices and edges are permanent MAX_DIM arrays — no regeneration needed
    this._remapRotation();
    this._colorsDirty = true;
    this._rebuildGeometry();
  }

  /**
   * Index of rotation plane (i,j), i<j, in a `dim`-dimensional cube — the
   * order _projectInPlace applies them: (0,1),(0,2)…(0,dim-1),(1,2)… So an
   * index names a DIFFERENT plane in every dimension: at 4D index 2 is (0,3),
   * XW; it is never YZ. Anything addressing a plane by meaning uses this.
   */
  static planeIndex(i, j, dim) {
    return i * (2 * dim - i - 1) / 2 + (j - i - 1);
  }

  /**
   * Size the rotation arrays to _dim, carrying each plane's angle and speed
   * across BY PLANE (i,j), not by index. Copying by index handed every plane
   * its neighbour's state on each dimension change — a jump at morph start
   * and speeds on the wrong planes. Param-driven speeds (setPlaneSpeed) win.
   */
  _remapRotation() {
    const dim = this._dim, from = this._planeDim ?? 0;
    const oldA = this._rotAngles, oldS = this._rotSpeeds;
    this._rotAngles = new Float64Array(rotationPlaneCount(dim));
    this._rotSpeeds = defaultRotationSpeeds(dim);
    const PI = HypercubeObject.planeIndex;
    if (oldA && oldS) {
      const top = Math.min(dim, from);
      for (let i = 0; i < top; i++) for (let j = i + 1; j < top; j++) {
        this._rotAngles[PI(i, j, dim)] = oldA[PI(i, j, from)];
        this._rotSpeeds[PI(i, j, dim)] = oldS[PI(i, j, from)];
      }
    }
    for (const [key, v] of this._pairSpeeds ?? []) {
      const [i, j] = key.split(',').map(Number);
      if (j < dim) this._rotSpeeds[PI(i, j, dim)] = v;
    }
    this._planeDim = dim;
  }

  _rebuildGeometry() {
    // ShaderMaterial created once
    if (!this._pointMat) {
      this._pointMat = new THREE.ShaderMaterial({
        uniforms: { opacity: { value: 0.8 }, uPointSize: { value: this._pointSize }, uDepthCue: { value: 0 } },
        vertexShader: `
          attribute vec3 color;
          attribute float aCue;
          varying vec3 vColor;
          uniform float uPointSize;
          uniform float uDepthCue;
          void main() {
            // Depth cue by w: far in the extra dimensions = dimmer and smaller.
            float k = 1.0 - uDepthCue * (1.0 - aCue);
            vColor = color * k;
            vec4 mv = modelViewMatrix * vec4(position, 1.0);
            gl_Position = projectionMatrix * mv;
            gl_PointSize = uPointSize * (60.0 / max(-mv.z, 0.1)) * mix(1.0, k, 0.7);
          }
        `,
        fragmentShader: `
          varying vec3 vColor;
          uniform float opacity;
          void main() {
            vec2 uv = gl_PointCoord - vec2(0.5);
            if (length(uv) > 0.5) discard;
            gl_FragColor = vec4(vColor, opacity);
          }
        `,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
    }

    if (this._lines) {
      // Buffers permanent at MAX_DIM. Edges aren't sorted by dimAxis, so we
      // must always draw the full range and rely on the cull-zero in
      // _updateBuffers to hide inactive edges.
      this._lines.geometry.setDrawRange(0, edgeCount(MAX_DIM) * 6);
    } else {
      const quadGeo = new THREE.BufferGeometry();
      quadGeo.setAttribute('aEndA', new THREE.BufferAttribute(this._quadEndABuf, 3));
      quadGeo.setAttribute('aEndB', new THREE.BufferAttribute(this._quadEndBBuf, 3));
      quadGeo.setAttribute('aSide', new THREE.BufferAttribute(this._quadSideBuf, 1));
      quadGeo.setAttribute('aTB',   new THREE.BufferAttribute(this._quadTBBuf,   1));
      quadGeo.setAttribute('color', new THREE.BufferAttribute(this._quadColBuf,  3));
      quadGeo.setAttribute('aCue',  new THREE.BufferAttribute(this._quadCueBuf,  2));
      quadGeo.setIndex(new THREE.BufferAttribute(this._quadIndexBuf, 1));
      quadGeo.setDrawRange(0, edgeCount(MAX_DIM) * 6);

      const lineMat = new THREE.ShaderMaterial({
        glslVersion:  THREE.GLSL3,
        transparent: true,
        depthWrite:  false,
        blending:    THREE.AdditiveBlending,
        side:        THREE.DoubleSide,
        uniforms: {
          uEdgeWidth:  { value: 1.5 },
          uResolution: { value: new THREE.Vector2(800, 600) },
          uDepthCue:   { value: 0 },
        },
        vertexShader: `
          in vec3 aEndA;
          in vec3 aEndB;
          in float aSide;
          in float aTB;
          in vec3 color;
          in vec2 aCue;                 // depth cue at end A, end B
          out vec3 vColor;
          uniform float uEdgeWidth;
          uniform vec2 uResolution;
          uniform float uDepthCue;
          void main() {
            gl_Position = vec4(2.0, 0.0, 0.0, 1.0); // default: off-screen
            vColor = vec3(0.0);
            vec4 clipA = projectionMatrix * modelViewMatrix * vec4(aEndA, 1.0);
            vec4 clipB = projectionMatrix * modelViewMatrix * vec4(aEndB, 1.0);
            vec2 ndcA  = clipA.xy / clipA.w;
            vec2 ndcB  = clipB.xy / clipB.w;
            vec2 delta = (ndcB - ndcA) * uResolution;
            // 1.0 px threshold: sub-pixel edges are invisible; guards normalize() against NaN under ANGLE/Metal
            if (dot(delta, delta) >= 1.0) {
              // Depth cue by w, per END: an edge fades along its length.
              float k      = 1.0 - uDepthCue * (1.0 - mix(aCue.x, aCue.y, round(aTB)));
              vColor = color * k;
              vec2 dir     = normalize(delta);
              vec2 perp    = vec2(-dir.y, dir.x);
              vec4 clipPos = mix(clipA, clipB, round(aTB));
              clipPos.xy  += perp * aSide * uEdgeWidth * mix(1.0, k, 0.7) / uResolution * clipPos.w;
              gl_Position  = clipPos;
            }
          }
        `,
        fragmentShader: `
          in vec3 vColor;
          out vec4 fragColor;
          void main() {
            fragColor = vec4(vColor, 1.0);
          }
        `,
      });
      this._lines = new THREE.Mesh(quadGeo, lineMat);
      this._lineMat = lineMat;
      this._lines.frustumCulled = false;
      this._scene.add(this._lines);
    }

    if (this._points) {
      this._points.geometry.setDrawRange(0, vertexCount(this._dim));
    } else {
      const ptGeo = new THREE.BufferGeometry();
      ptGeo.setAttribute('position', new THREE.BufferAttribute(this._ptPosBuf, 3));
      ptGeo.setAttribute('color',    new THREE.BufferAttribute(this._ptColBuf, 3));
      ptGeo.setAttribute('aCue',     new THREE.BufferAttribute(this._cueBuf, 1));
      this._points = new THREE.Points(ptGeo, this._pointMat);
      this._points.frustumCulled = false;
      this._scene.add(this._points);
    }

    this._updateVisibility();
  }

  /**
   * Zero-allocation projection: rotates and perspective-projects every active vertex
   * into outBuf as flat [x0,y0,z0, x1,y1,z1, ...] Float64 values.
   */
  _projectInPlace(vertices, dim, rotAngles, wDistance, outBuf, wOut = null) {
    const scratch = this._scratchCoords;
    const nVerts  = vertexCount(dim);
    for (let vi = 0; vi < nVerts; vi++) {
      const v = vertices[vi];
      // Copy active coords into scratch
      for (let d = 0; d < dim; d++) scratch[d] = v[d];
      // Apply all Givens rotation planes (inlined for zero call overhead)
      let planeIdx = 0;
      for (let i = 0; i < dim; i++) {
        for (let j = i + 1; j < dim; j++) {
          const angle = rotAngles[planeIdx++] ?? 0;
          const c = Math.cos(angle), s = Math.sin(angle);
          const xi = scratch[i], xj = scratch[j];
          scratch[i] =  c * xi - s * xj;
          scratch[j] =  s * xi + c * xj;
        }
      }
      // Perspective project dim → 3 (in-place on scratch)
      let wScale = 1;
      for (let d = dim - 1; d >= 3; d--) {
        const scale = wDistance / (wDistance - scratch[d]);
        for (let k = 0; k < d; k++) scratch[k] *= scale;
        wScale *= scale;
      }
      if (wOut) wOut[vi] = wScale;
      // Write result
      outBuf[vi * 3]     = scratch[0];
      outBuf[vi * 3 + 1] = scratch[1];
      outBuf[vi * 3 + 2] = scratch[2];
    }
  }

  _updateVisibility() {
    // renderMode picks wireframe vs points ONLY. Faces and instancer have
    // their own toggles and do not answer to it — 'none' used to hide them
    // too, so switching Faces on showed nothing until Mode was changed.
    const show = this._renderMode !== 'none';
    if (this._lines)  this._lines.visible  = show && this._renderMode !== 'points';
    if (this._points) this._points.visible = show && this._renderMode !== 'wireframe';
  }

  // ── Update ────────────────────────────────────────────────────────────────

  update(deltaMs) {
    // Skip all CPU work when nothing is visible.
    // renderMode='none' hides lines/points; faces/instancer are gated by their own toggles.
    const linesOn     = this._lines?.visible;
    const pointsOn    = this._points?.visible;
    const facesOn     = this._hFaces?._visible;
    const instancerOn = this._hInstancer?._visible;
    if (!linesOn && !pointsOn && !facesOn && !instancerOn) return;
    const dt = deltaMs / 1000;

    // Advance morph
    if (this._morphState) {
      if (!this._morphState.done) {
        morphStep(this._morphState, deltaMs);
      }
      if (this._morphState.done) {
        if (this._morphState.toDim < this._morphState.fromDim) {
          this._rebuild();
        }
        this._morphState = null;
        if (this._morphQueue.length > 0) this._startNextMorph();
      }
    } else if (this._morphQueue.length > 0) {
      this._startNextMorph();
    }

    // Advance rotation angles
    for (let i = 0; i < this._rotAngles.length; i++) {
      this._rotAngles[i] += this._rotSpeeds[i] * dt;
    }

    // Project — zero-allocation path
    if (this._morphState && this._morphFromVertices) {
      this._projectMorphInterp();
    } else {
      this._projectInPlace(this._vertices, this._dim, this._rotAngles, this._projW(), this._projBuf, this._wBuf);
    }

    this._updateBuffers();
    this._notifySubscribers();
    if (facesOn)     this._hFaces.update(this._projBuf, this._dim, this._scale);
    if (instancerOn) this._hInstancer.update(this._projBuf, this._dim, this._scale);
  }

  _projectMorphInterp() {
    // fromAngles may be longer than fromDim needs — _projectInPlace only reads
    // rotationPlaneCount(fromDim) entries, so passing the full array is safe.
    const fromAngles = this._morphFromAngles ?? this._rotAngles;
    this._projectInPlace(this._morphFromVertices, this._morphFromDim, fromAngles,    this._projW(), this._morphFromProjBuf, this._morphFromW);
    this._projectInPlace(this._vertices,          this._dim,          this._rotAngles, this._projW(), this._morphToProjBuf,   this._morphToW);

    const t         = this._morphState.t;
    const mt        = 1 - t;
    const fromCount = vertexCount(this._morphFromDim);
    const toCount   = vertexCount(this._dim);
    const count     = Math.min(fromCount, toCount);

    for (let i = 0; i < count; i++) {
      const bi = i * 3;
      this._projBuf[bi]     = this._morphFromProjBuf[bi]     * mt + this._morphToProjBuf[bi]     * t;
      this._projBuf[bi + 1] = this._morphFromProjBuf[bi + 1] * mt + this._morphToProjBuf[bi + 1] * t;
      this._projBuf[bi + 2] = this._morphFromProjBuf[bi + 2] * mt + this._morphToProjBuf[bi + 2] * t;
      this._wBuf[i] = this._morphFromW[i] * mt + this._morphToW[i] * t;
    }
    for (let i = count; i < toCount; i++) {
      const bi = i * 3;
      this._projBuf[bi]     = this._morphToProjBuf[bi];
      this._projBuf[bi + 1] = this._morphToProjBuf[bi + 1];
      this._projBuf[bi + 2] = this._morphToProjBuf[bi + 2];
      this._wBuf[i] = this._morphToW[i];
    }
  }

  /**
   * Normalise this frame's w-scales to a 0..1 cue (nearest vertex 1, farthest
   * 0) and upload it for the live points and edges. Per frame, because it
   * moves with every rotation; skipped entirely at Depth Cue 0, where the
   * shaders ignore the attribute. Orthographic has no w-perspective — every
   * scale is 1 — so the cue is uniformly 1 there: nothing to cue by.
   */
  _updateDepthCue(nVerts, ceiling) {
    const amt = this._depthCue;
    if (this._lineMat) this._lineMat.uniforms.uDepthCue.value = amt;
    if (this._pointMat) this._pointMat.uniforms.uDepthCue.value = amt;
    if (amt <= 0) return;
    const w = this._wBuf, cue = this._cueBuf;
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < nVerts; i++) { const v = w[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
    // RELATIVE threshold: orthographic sets W distance to 1e9, where scales
    // still differ by ~2e-9 — normalising that noise would dim half the cube
    // at random. The narrowest real spread (W distance 20) is ~0.1 of hi.
    const span = hi - lo;
    const flat = !(span > 1e-6 * hi);
    for (let i = 0; i < nVerts; i++) cue[i] = flat ? 1 : (w[i] - lo) / span;

    const edges = this._edges, qc = this._quadCueBuf;
    for (let e = 0; e < ceiling; e++) {
      const [a, b] = edges[e];
      const ca = a < nVerts ? cue[a] : 1, cb = b < nVerts ? cue[b] : 1;
      const q = e * 8;
      qc[q] = ca; qc[q + 1] = cb; qc[q + 2] = ca; qc[q + 3] = cb;
      qc[q + 4] = ca; qc[q + 5] = cb; qc[q + 6] = ca; qc[q + 7] = cb;
    }
    if (this._lines?.visible) {
      const at = this._lines.geometry.attributes.aCue;
      at.clearUpdateRanges(); at.addUpdateRange(0, ceiling * 8); at.needsUpdate = true;
    }
    if (this._points?.visible) {
      const at = this._points.geometry.attributes.aCue;
      at.clearUpdateRanges(); at.addUpdateRange(0, nVerts); at.needsUpdate = true;
    }
  }

  _computeLastActiveEdge() {
    const nActive = vertexCount(this._dim);
    let last = 0;
    for (let e = 0; e < this._edges.length; e++) {
      const [a, , d] = this._edges[e];
      if (d < this._dim && a < nActive) last = e;
    }
    return last;
  }

  _updateBuffers() {
    const s             = this._scale;
    const projBuf       = this._projBuf;
    const edges         = this._edges;
    const colorTable    = this._colorTable;
    const colLen        = colorTable.length / 3 | 0;
    const nActiveVerts  = vertexCount(this._dim);
    const writeColors   = this._colorsDirty;

    // Both edge loops stop at the last live edge: nothing past it is drawn
    // (setDrawRange below), and walking all 12D edges cost 768× the work at
    // 4D. The ceiling moves only with _dim, and every _dim change sets
    // _colorsDirty, so edges it newly admits get their colours that frame.
    if (this._cachedDimForRange !== this._dim) {
      this._lastActiveEdgeIdx = this._computeLastActiveEdge();
      this._cachedDimForRange = this._dim;
    }
    const ceiling = this._lastActiveEdgeIdx + 1;

    // ── Line buffer ───────────────────────────────────────────────────────
    const lp = this._linePosBuf;
    const lc = this._lineColBuf;

    for (let e = 0; e < ceiling; e++) {
      const [a, b, dimAxis] = edges[e];
      const base = e * 6;
      // Cull edges that belong to inactive dimensions OR reference vertex
      // indices outside the active vertex set (stale projBuf data otherwise).
      if (dimAxis >= this._dim || a >= nActiveVerts || b >= nActiveVerts) {
        lp[base] = lp[base+1] = lp[base+2] = 0;
        lp[base+3] = lp[base+4] = lp[base+5] = 0;
        if (writeColors) {
          lc[base] = lc[base+1] = lc[base+2] = 0;
          lc[base+3] = lc[base+4] = lc[base+5] = 0;
        }
        continue;
      }
      const ai = a * 3, bi = b * 3;
      lp[base]     = projBuf[ai]     * s; lp[base + 1] = projBuf[ai + 1] * s; lp[base + 2] = projBuf[ai + 2] * s;
      lp[base + 3] = projBuf[bi]     * s; lp[base + 4] = projBuf[bi + 1] * s; lp[base + 5] = projBuf[bi + 2] * s;

      if (writeColors) {
        const ci = Math.min(dimAxis, colLen - 1) * 3;
        const op = edgeOpacity(dimAxis, this._dim) * this._edgeOpacityMult;
        const cr = colorTable[ci] * op, cg = colorTable[ci + 1] * op, cb = colorTable[ci + 2] * op;
        lc[base]     = cr; lc[base + 1] = cg; lc[base + 2] = cb;
        lc[base + 3] = cr; lc[base + 4] = cg; lc[base + 5] = cb;
      }
    }

    // ── Quad buffer (screen-space width mesh) ────────────────────────────
    const qa = this._quadEndABuf;
    const qb = this._quadEndBBuf;
    const qc = this._quadColBuf;

    for (let e = 0; e < ceiling; e++) {
      const [a, b, dimAxis] = edges[e];
      const base6 = e * 6;
      if (dimAxis >= this._dim || a >= nActiveVerts || b >= nActiveVerts) {
        // Culled edge — zero all quad verts so the degenerate quad clips cleanly
        for (let v = 0; v < 4; v++) {
          const qi3 = (e * 4 + v) * 3;
          qa[qi3] = qa[qi3+1] = qa[qi3+2] = 0;
          qb[qi3] = qb[qi3+1] = qb[qi3+2] = 0;
          if (writeColors) { qc[qi3] = qc[qi3+1] = qc[qi3+2] = 0; }
        }
        continue;
      }
      const ax = lp[base6],     ay = lp[base6+1], az = lp[base6+2];
      const bx = lp[base6+3],   by = lp[base6+4], bz = lp[base6+5];
      for (let v = 0; v < 4; v++) {
        const qi3 = (e * 4 + v) * 3;
        qa[qi3] = ax; qa[qi3+1] = ay; qa[qi3+2] = az;
        qb[qi3] = bx; qb[qi3+1] = by; qb[qi3+2] = bz;
        if (writeColors) {
          qc[qi3]   = lc[base6];
          qc[qi3+1] = lc[base6+1];
          qc[qi3+2] = lc[base6+2];
        }
      }
    }

    if (this._lines?.visible) {
      const uploadFloats = ceiling * 4 * 3;
      this._lines.geometry.setDrawRange(0, ceiling * 6);
      const aEndA = this._lines.geometry.attributes.aEndA;
      const aEndB = this._lines.geometry.attributes.aEndB;
      aEndA.clearUpdateRanges(); aEndA.addUpdateRange(0, uploadFloats); aEndA.needsUpdate = true;
      aEndB.clearUpdateRanges(); aEndB.addUpdateRange(0, uploadFloats); aEndB.needsUpdate = true;
      if (writeColors) {
        const aCol = this._lines.geometry.attributes.color;
        aCol.clearUpdateRanges(); aCol.addUpdateRange(0, uploadFloats); aCol.needsUpdate = true;
      }
    }

    // ── Point buffer ──────────────────────────────────────────────────────
    const pp  = this._ptPosBuf;
    const pc  = this._ptColBuf;
    const nVerts = nActiveVerts;

    if (writeColors) {
      const dci = Math.min(this._dim - 1, colLen - 1) * 3;
      const dcr = colorTable[dci], dcg = colorTable[dci + 1], dcb = colorTable[dci + 2];
      for (let i = 0; i < nVerts; i++) {
        const pi = i * 3;
        pp[pi]     = projBuf[pi]     * s;
        pp[pi + 1] = projBuf[pi + 1] * s;
        pp[pi + 2] = projBuf[pi + 2] * s;
        pc[pi]     = dcr;
        pc[pi + 1] = dcg;
        pc[pi + 2] = dcb;
      }
    } else {
      for (let i = 0; i < nVerts; i++) {
        const pi = i * 3;
        pp[pi]     = projBuf[pi]     * s;
        pp[pi + 1] = projBuf[pi + 1] * s;
        pp[pi + 2] = projBuf[pi + 2] * s;
      }
    }

    if (this._points?.visible) {
      this._points.geometry.attributes.position.needsUpdate = true;
      if (writeColors) this._points.geometry.attributes.color.needsUpdate = true;
    }

    this._updateDepthCue(nActiveVerts, ceiling);

    if (writeColors) this._colorsDirty = false;
    if (this._lineMat) {
      this._lineMat.uniforms.uEdgeWidth.value = this._edgeWidth ?? 1.5;
    }
  }

  _notifySubscribers() {
    if (this._subscribers.size === 0) return;
    const s = this._scale;
    for (const [vi, callbacks] of this._subscribers) {
      const pi = vi * 3;
      const wx = this._projBuf[pi] * s, wy = this._projBuf[pi + 1] * s, wz = this._projBuf[pi + 2] * s;
      for (const cb of callbacks) cb(wx, wy, wz);
    }
  }

  // ── Morph ──────────────────────────────────────────────────────────────────

  /**
   * Queue a morph to toDim.
   * @param {number} toDim
   * @param {{durationMs?:number, easing?:string}} options
   */
  morphTo(toDim, options = {}) {
    toDim = Math.max(3, Math.min(MAX_DIM, toDim));
    const { durationMs = 800, easing = 'easeInOut' } = options;
    this._morphQueue.push({ toDim, durationMs, easing });
    if (!this._morphState) this._startNextMorph();
  }

  /**
   * Go to `toDim`, dropping any morph still waiting in the queue — a
   * controller moves the target continuously, and queueing every step would
   * leave the cube seconds behind it. A running morph finishes first, unless
   * this is a jump (durationMs 0), which lands NOW: a recall must not wait
   * out an animation.
   */
  morphToLatest(toDim, options = {}) {
    toDim = Math.max(3, Math.min(MAX_DIM, toDim));
    this._morphQueue.length = 0;
    if (!options.durationMs && this._morphState) {
      if (this._morphState.toDim < this._morphState.fromDim) this._rebuild();
      this._morphState = null;
    }
    if (this.targetDim === toDim) return;
    this.morphTo(toDim, options);
  }

  _startNextMorph() {
    if (this._morphQueue.length === 0) return;
    const { toDim, durationMs, easing } = this._morphQueue.shift();

    // Snapshot the current state as "from"
    this._morphFromDim      = this._dim;
    this._morphFromVertices = this._vertices;
    this._morphFromAngles   = this._rotAngles.slice();

    // Switch to target dimension
    this._dim = toDim;
    // For upward morphs: rebuild immediately so new geometry exists during animation
    // For downward morphs: keep old geometry, defer rebuild to avoid ghost doubling
    if (toDim > this._morphFromDim) {
      this._rebuild();
    } else {
      // ...but the ROTATION arrays follow _dim now in both directions: the
      // to-projection reads them at toDim, and their layout is per-dimension.
      this._remapRotation();
    }
    // dim changed → edge colors and dim cull mask must be rewritten next frame
    this._colorsDirty = true;
    this._morphState = createMorphState(this._morphFromDim, toDim, durationMs, easing);
  }

  // ── Pub/sub ───────────────────────────────────────────────────────────────

  /**
   * Subscribe to world-position updates for vertex vi.
   * Returns an unsubscribe function.
   * @param {number} vi
   * @param {(x:number,y:number,z:number)=>void} callback
   */
  subscribeVertex(vi, callback) {
    if (!this._subscribers.has(vi)) this._subscribers.set(vi, []);
    this._subscribers.get(vi).push(callback);
    return () => {
      const arr = this._subscribers.get(vi);
      if (arr) {
        const idx = arr.indexOf(callback);
        if (idx !== -1) arr.splice(idx, 1);
      }
    };
  }

  // ── Setters ───────────────────────────────────────────────────────────────

  setRenderMode(mode) {
    this._renderMode = mode;
    this._updateVisibility();
  }

  // _wDistance is the user's value in BOTH modes; orthographic is applied at
  // projection time. They used to share the field (ortho wrote 1e9 into it),
  // so W-dist moved while in ortho silently dropped to perspective, and
  // selecting ortho twice saved 1e9 as the distance to return to.
  setProjectionMode(mode) {
    this._projectionMode = mode;
  }

  _projW() {
    return this._projectionMode === 'orthographic' ? 1e9 : this._wDistance;
  }

  setWDistance(d) {
    this._wDistance = Math.max(1.1, d);
  }

  setScale(s) {
    this._scale = s;
  }

  setVisible(visible) {
    if (this._lines)  this._lines.visible  = visible && this._renderMode !== 'points';
    if (this._points) this._points.visible = visible && this._renderMode !== 'wireframe';
  }

  /** 0 = off; 1 = the farthest vertex in w goes dark and small. */
  setDepthCue(v) { this._depthCue = Math.max(0, Math.min(1, v)); }

  setPointSize(size) {
    this._pointSize = size;
    if (this._pointMat && this._pointMat.uniforms) {
      this._pointMat.uniforms.uPointSize.value = size;
    }
  }

  setEdgeOpacity(v) {
    this._edgeOpacityMult = v;
    this._colorsDirty = true;
  }

  setEdgeWidth(w) {
    this._edgeWidth = Math.max(0.5, Math.min(8.0, w));
  }

  setFaceTexture(tex)       { this._hFaces?.setFaceTexture(tex); }
  setFaceOpacity(v)         { this._hFaces?.setOpacity(v); }
  setFacesVisible(v)        { this._hFaces?.setVisible(v); }
  setFaceBlending(idx)      { this._hFaces?.setBlending(idx); }
  setFaceMaskTexture(tex)   { this._hFaces?.setMaskTexture(tex); }
  setFaceMaskInvert(v)      { this._hFaces?.setMaskInvert(v); }
  setFaceMaskLevel(v)       { this._hFaces?.setMaskLevel(v); }
  setFaceHue(hue360, sat100) {
    const h = hue360 / 360;
    const s = sat100 / 100;
    const c = new THREE.Color().setHSL(h, s, s > 0 ? 0.5 : 1.0);
    this._hFaces?.setColor(c.r, c.g, c.b);
  }

  setInstancerVisible(v)   { this._hInstancer?.setVisible(v); }
  setInstancerOpacity(v)   { this._hInstancer?.setOpacity(v); }
  setInstancerGeoType(t)   { this._hInstancer?.setGeoType(t); }
  setInstancerScale(v)     { this._hInstancer?.setInstanceScale(v); }
  setInstancerBudget(m)    { this._hInstancer?.setVertexBudget(m); }
  setInstancerTexture(tex) { this._hInstancer?.setTexture(tex); }

  /**
   * Set rotation speed (rad/s) for one rotation plane by index.
   */
  /**
   * Speed of plane (i,j) — what the Rot XY/XZ/YZ/XW params mean. Remembered
   * per plane, so it survives dimension changes and applies once a morph
   * brings the plane into existence.
   */
  setPlaneSpeed(i, j, speedRadPerSec) {
    (this._pairSpeeds ??= new Map()).set(`${i},${j}`, speedRadPerSec);
    if (j < this._planeDim) this._rotSpeeds[HypercubeObject.planeIndex(i, j, this._planeDim)] = speedRadPerSec;
  }

  /**
   * The Plane Bank: REPLACE every param-driven plane speed at once
   * (Map "i,j" → speed). A plane no slot names any more goes back to its
   * default speed — per-plane setPlaneSpeed could never take one away.
   */
  setPlaneSpeeds(map) {
    const dim = this._planeDim;
    const defaults = defaultRotationSpeeds(dim);
    const PI = HypercubeObject.planeIndex;
    for (const key of this._pairSpeeds?.keys() ?? []) {
      const [i, j] = key.split(',').map(Number);
      if (j < dim) this._rotSpeeds[PI(i, j, dim)] = defaults[PI(i, j, dim)];
    }
    this._pairSpeeds = new Map(map);
    for (const [key, v] of this._pairSpeeds) {
      const [i, j] = key.split(',').map(Number);
      if (j < dim) this._rotSpeeds[PI(i, j, dim)] = v;
    }
  }

  /** By INDEX into the current dimension's plane order (see planeIndex). */
  setRotationSpeed(planeIdx, speedRadPerSec) {
    if (planeIdx >= 0 && planeIdx < this._rotSpeeds.length) {
      this._rotSpeeds[planeIdx] = speedRadPerSec;
    }
  }

  get dim() { return this._dim; }

  /** The dimension the cube will settle at once queued morphs finish. */
  get targetDim() {
    return this._morphQueue.length ? this._morphQueue[this._morphQueue.length - 1].toDim : this._dim;
  }

  // ── Dispose ───────────────────────────────────────────────────────────────

  dispose() {
    if (this._lines) {
      this._scene.remove(this._lines);
      this._lines.geometry.dispose();
      this._lines.material.dispose();
      this._lines = null;
    }
    if (this._points) {
      this._scene.remove(this._points);
      this._points.geometry.dispose();
      this._points.material.dispose();
      this._points = null;
    }
    if (this._hFaces) { this._hFaces.dispose(); this._hFaces = null; }
    if (this._hInstancer) { this._hInstancer.dispose(); this._hInstancer = null; }
    this._subscribers.clear();
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _hexToRgb(hex) {
  return [
    parseInt(hex.slice(1, 3), 16) / 255,
    parseInt(hex.slice(3, 5), 16) / 255,
    parseInt(hex.slice(5, 7), 16) / 255,
  ];
}
