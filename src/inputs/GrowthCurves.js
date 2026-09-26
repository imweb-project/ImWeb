/**
 * GrowthCurves — Growth engine 4, "Curves": hyphae as free-moving tips.
 *
 * Hyphae (engine 3) is a cellular automaton: a tip steps one cell in one of
 * eight directions, so every thread is a staircase of 45° runs, one grid
 * pixel wide, magnified to the canvas. Here each tip is an agent with a float
 * position, a heading and a turning rate that itself drifts, so threads
 * curve; each step is drawn as an anti-aliased segment straight into a
 * canvas-resolution target. Same state layout the Growth view reads —
 * r = coverage (0–1, not 0/1), b = birth time on the lineage clock, a =
 * lineage stamp — so Colour, Colonies, Fade, Details and Relief all work.
 *
 * Where a thread may go is decided on the CPU, against a coarse occupancy
 * grid (the "sim grid", sized by Size as Hyphae's grid is): a tip whose
 * look-ahead lands on another thread stops there, so threads keep clear of
 * each other as in Hyphae. Occupancy stores the lineage stamp, so a faded
 * lineage frees its ground without a GPU read-back.
 */
import * as THREE from 'three';
import { GROWTH_CURVE_VERT, GROWTH_CURVE_FRAG, GROWTH_CURVE_CLEAN } from '../shaders/index.js';

const MAX_TIPS  = 3000;     // no branching past this — Hyphae once hit 41 000
const MAX_SEGS  = 16384;    // segments drawn per frame (instance buffer size)
const SIM_DT    = 1 / 60;   // fixed sim step, seconds
const SEED_W    = 128;      // stroke read-back grid (sprouting along strokes)
const FIELD_W   = 64;       // field read-back grid (the light threads turn toward)
// Thickness by generation: a spore's (or stroke's) first threads are the
// thickest, each fork 28% thinner than the thread it left — trunk to
// hair, as real mycelium and roots taper. In sim cells, never under a pixel.
const W_TRUNK   = 2.2;
const W_TAPER   = 0.72;

// A GPU → CPU read-back that never stalls. A synchronous readPixels waits
// for the GPU to finish the frame — measured ~10 ms each for Curves' stroke
// read-back, 2.6–2.9 ms/frame averaged, when the whole tip simulation cost
// 0.05 ms. So: readPixels into a pixel-pack buffer, fence, and collect on a
// later frame once the fence has signalled (Chrome updates a fence only
// between tasks, so never within one frame). Not three's
// readRenderTargetPixelsAsync: in r168 it leaves the pack buffer BOUND while
// it waits, and every synchronous readPixels elsewhere in the app then fails
// with INVALID_OPERATION (measured: GL error 1282). Here the buffer is
// unbound straight after each use.
class AsyncRead {
  constructor(renderer, blit) {
    this.renderer = renderer;
    this._blit = blit;
    this._rt = null;
    this._pbo = null;
    this._pend = null;
  }
  /** The last request's pixels once they have landed ({ buf, w, h, tag }), else null. */
  poll() {
    if (!this._pend) return null;
    const gl = this.renderer.getContext();
    if (gl.getSyncParameter(this._pend.sync, gl.SYNC_STATUS) !== gl.SIGNALED) return null;
    const p = this._pend;
    this._pend = null;
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this._pbo);
    gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, p.buf);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    gl.deleteSync(p.sync);
    return p;
  }
  get busy() { return !!this._pend; }
  /** Copy `tex` down to w×h and start reading it back. `tag` comes back with the pixels. */
  request(tex, copyMat, w, h, tag) {
    if (this._pend) return;
    const gl = this.renderer.getContext();
    if (!this._rt || this._rt.width !== w || this._rt.height !== h) {
      this._rt?.dispose();
      this._rt = new THREE.WebGLRenderTarget(w, h, { depthBuffer: false, stencilBuffer: false });
      if (this._pbo) gl.deleteBuffer(this._pbo);
      this._pbo = gl.createBuffer();
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this._pbo);
      gl.bufferData(gl.PIXEL_PACK_BUFFER, w * h * 4, gl.STREAM_READ);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    }
    copyMat.uniforms.uTexture.value = tex;
    this._blit(copyMat, this._rt);            // leaves _rt bound for reading
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this._pbo);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, 0);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    this._pend = { sync: gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0), buf: new Uint8Array(w * h * 4), w, h, tag };
    gl.flush();
  }
  dispose() {
    const gl = this.renderer.getContext();
    if (this._pend) gl.deleteSync(this._pend.sync);
    if (this._pbo) gl.deleteBuffer(this._pbo);
    this._rt?.dispose();
  }
}

export class GrowthCurves {
  /** @param blit (material, target) → draws a full-screen quad, from GrowthRD */
  constructor(renderer, blit) {
    this.renderer = renderer;
    this._blit = blit;
    // Float32 MAX blending needs EXT_float_blend; without it later segments
    // overwrite (nicks where anti-aliased edges touch — acceptable fallback).
    this._maxBlend = !!renderer.extensions.get('EXT_float_blend');
    this._tips = [];
    this._occ = null;          // Float32Array gw×gh of lineage stamps
    this._occId = null;        // Int32Array: the tip that marked each cell …
    this._occT = null;         // Int32Array: … and on which sim step
    this._nextId = 1;
    this._simStep = 0;
    this._gw = 0; this._gh = 0;
    this._tw = 0; this._th = 0;
    this._t = [null, null];    // float targets (second only for cleaning)
    this._cur = 0;
    this._acc = 0;
    this._frame = 0;
    this._needsClear = true;

    // One quad per segment, instanced.
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
      -1, -1, 0,  1, -1, 0,  1, 1, 0,  -1, 1, 0]), 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    this._segA = new Float32Array(MAX_SEGS * 4);
    this._metaA = new Float32Array(MAX_SEGS * 3);
    g.setAttribute('aSeg',  new THREE.InstancedBufferAttribute(this._segA, 4).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aMeta', new THREE.InstancedBufferAttribute(this._metaA, 3).setUsage(THREE.DynamicDrawUsage));
    g.instanceCount = 0;
    this._geom = g;
    this._segMat = new THREE.ShaderMaterial({
      vertexShader: GROWTH_CURVE_VERT, fragmentShader: GROWTH_CURVE_FRAG,
      uniforms: { uSize: { value: new THREE.Vector2(1, 1) } },
      depthTest: false, depthWrite: false,
      blending: this._maxBlend ? THREE.CustomBlending : THREE.NoBlending,
      blendEquation: THREE.MaxEquation, blendEquationAlpha: THREE.MaxEquation,
      blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
      blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneFactor,
    });
    this._segMesh = new THREE.Mesh(g, this._segMat);
    this._segMesh.frustumCulled = false;
    this._scene = new THREE.Scene();
    this._scene.add(this._segMesh);
    this._cam = new THREE.Camera();
    this._nSeg = 0;

    // Clears pixels whose lineage has fully faded, so regrowth over the same
    // ground does not bring the old line back through MAX blending.
    this._cleanMat = new THREE.ShaderMaterial({
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: GROWTH_CURVE_CLEAN,
      uniforms: { uSrc: { value: null }, uNow: { value: 0 }, uGrowTime: { value: 0 },
                  uFadeTime: { value: 3 }, uPenRate: { value: 0 } },
      depthTest: false, depthWrite: false,
    });

    // Stroke read-back (small, every few frames).
    this._seedRead  = new AsyncRead(renderer, blit);
    this._seedPrev  = null;     // last stroke luma, for the arrival test
    this._fieldRead = new AsyncRead(renderer, blit);
    this._field     = null;     // { lum: Float32Array, w, h } — the light to grow toward
    this._copyMat = null;
  }

  // Nearest: float32 LINEAR needs OES_texture_float_linear, and without it
  // the texture is incomplete and samples black. The view is drawn at this
  // same size, so nothing here needs filtering.
  _target(w, h) {
    return new THREE.WebGLRenderTarget(w, h, {
      minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
      format: THREE.RGBAFormat, type: THREE.FloatType,
      depthBuffer: false, stencilBuffer: false,
    });
  }

  get texture() { return this._t[this._cur] ? this._t[this._cur].texture : null; }
  get width()  { return this._tw; }
  get height() { return this._th; }

  clear() { this._needsClear = true; }

  /** A spore: eight tips on a small ring, heading outward. uv, radius in uv of height. */
  plant(x, y, r, now) {
    const cx = x * this._gw, cy = y * this._gh;
    const R = Math.max(1.5, r * this._gh * 0.35);
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      this._spawn(cx + Math.cos(a) * R, cy + Math.sin(a) * R, a, now);
    }
  }

  _spawn(x, y, h, stamp) {
    if (this._tips.length >= MAX_TIPS) return;
    this._tips.push({ x, y, h, w: 0, stamp, gen: 0, stuck: 0, id: this._nextId++ });
  }

  /**
   * Is the cell `dist` cells ahead of (x, y) along heading h free for tip t?
   * A tip's OWN last few cells do not count: without that, a check had to
   * reach past the tip's fresh trail, and at a short look-ahead the "right
   * in front" test reached further than the look-ahead itself — so blocked
   * tips died instead of turning.
   */
  _clear(x, y, h, dist, o, t) {
    const px = Math.floor(x + Math.cos(h) * dist), py = Math.floor(y + Math.sin(h) * dist);
    if (px < 0 || py < 0 || px >= this._gw || py >= this._gh) return true;
    const c = py * this._gw + px;
    if (this._occId[c] === t.id && this._simStep - this._occT[c] < t.selfSteps) return true;
    return this._free(c, o);
  }

  /** Line width of a generation, in sim cells. */
  _width(gen) { return W_TRUNK * Math.pow(W_TAPER, gen); }

  _size(gridRes, aspect, viewRes) {
    const a = aspect > 0 && isFinite(aspect) ? aspect : 1;
    const gw = Math.max(8, Math.round(a >= 1 ? gridRes : gridRes * a));
    const gh = Math.max(8, Math.round(a >= 1 ? gridRes / a : gridRes));
    const long = Math.max(Math.min(2048, viewRes || 0), gridRes);
    const tw = Math.max(8, Math.round(a >= 1 ? long : long * a));
    const th = Math.max(8, Math.round(a >= 1 ? long / a : long));
    if (gw !== this._gw || gh !== this._gh) {
      // Size moved: keep the tips (scaled), start a fresh occupancy grid.
      if (this._gw) for (const t of this._tips) { t.x *= gw / this._gw; t.y *= gh / this._gh; }
      this._gw = gw; this._gh = gh;
      this._occ = new Float32Array(gw * gh);
      this._occId = new Int32Array(gw * gh);
      this._occT = new Int32Array(gw * gh);
      this._occB = new Float32Array(gw * gh);   // birth time of each cell's piece
    }
    if (tw !== this._tw || th !== this._th) {
      this._tw = tw; this._th = th;
      for (let i = 0; i < 2; i++) {
        if (this._t[i]) this._t[i].setSize(tw, th); else this._t[i] = this._target(tw, th);
      }
      this._needsClear = true;   // a resized float target holds no drawing
    }
  }

  // Occupancy: is cell c free? Empty, or its thread has faded out — the
  // same rules as the view. Hold fades a whole lineage from its planting
  // (the stamp); Pen fades each piece from when it was DRAWN (occB), so a
  // colony keeps a bright growing front with a fading wake (owner: under
  // the lineage clock the whole colony faded out at once).
  _free(c, o) {
    const stamp = this._occ[c];
    if (stamp <= 0) return true;
    if (o.growTime > 0 && o.now - stamp > o.growTime + o.fadeTime) return true;
    return o.penRate > 0 && Math.exp(-o.penRate * (o.now - this._occB[c])) < 1 / 255;
  }
  // Hold stops a lineage's tips after Grow time. Pen never stops them: the
  // front keeps growing while its trail fades.
  _stopped(stamp, o) {
    return o.growTime > 0 && o.now - stamp > o.growTime;
  }

  /** Room to grow, 1 inside → 0 at the frame (see edgeRoom in GROWTH_VAR_GLSL). */
  _edge(x, y, edge) {
    if (edge <= 0) return 1;
    const u = x / this._gw, v = y / this._gh, asp = this._gw / this._gh;
    const dx = Math.min(u, 1 - u) * asp, dy = Math.min(v, 1 - v);
    const k = 0.5 * edge;
    const dd = -k * Math.log(Math.exp(-dx / k) + Math.exp(-dy / k));
    const t = Math.min(1, Math.max(0, dd / edge));
    return t * t * (3 - 2 * t);
  }

  // Marks the cells a segment covers — a band as wide as the line, so a
  // neighbour keeps clear of a thick trunk's EDGE, not just its centre.
  _mark(x0, y0, x1, y1, stamp, width, id) {
    const len = Math.hypot(x1 - x0, y1 - y0);
    const n = Math.max(1, Math.ceil(len * 2));
    const nx = len > 0 ? -(y1 - y0) / len : 0, ny = len > 0 ? (x1 - x0) / len : 0;
    const r = Math.max(0, (width - 1) / 2);
    const m = Math.ceil(r * 2);
    for (let i = 1; i <= n; i++) {
      const px = x0 + (x1 - x0) * i / n, py = y0 + (y1 - y0) * i / n;
      for (let j = -m; j <= m; j++) {
        const o = m ? (j / m) * r : 0;
        const cx = Math.floor(px + nx * o), cy = Math.floor(py + ny * o);
        if (cx >= 0 && cy >= 0 && cx < this._gw && cy < this._gh) {
          const c = cy * this._gw + cx;
          this._occ[c] = stamp; this._occId[c] = id; this._occT[c] = this._simStep; this._occB[c] = this._now;
        }
      }
    }
  }

  _pushSeg(x0, y0, x1, y1, birth, stamp, width) {
    if (this._nSeg >= MAX_SEGS) return;
    const sx = this._tw / this._gw, sy = this._th / this._gh, i = this._nSeg++;
    this._segA[i * 4] = x0 * sx; this._segA[i * 4 + 1] = y0 * sy;
    this._segA[i * 4 + 2] = x1 * sx; this._segA[i * 4 + 3] = y1 * sy;
    this._metaA[i * 3] = birth; this._metaA[i * 3 + 1] = stamp;
    this._metaA[i * 3 + 2] = Math.max(0.5, 0.5 * width * sx);   // half width, target px
  }

  /** One fixed sim step for every tip. */
  _step(o) {
    this._simStep++;
    const speed = o.cellsPerSec * SIM_DT;
    const wander = o.wander, branch = o.branch;
    const next = [];
    for (const t of this._tips) {
      if (this._stopped(t.stamp, o)) continue;
      const er = this._edge(t.x, t.y, o.edge);
      if (er < 0.02) continue;
      // Turning rate drifts (a smoothed random walk) so a thread bends in
      // long arcs rather than jittering; it is damped back toward straight.
      t.w += (Math.random() - 0.5) * wander * 6 * SIM_DT;
      t.w *= 0.97;
      t.h += t.w * SIM_DT * 6;
      // Toward the light: turn along the field's brightness gradient,
      // harder where it is steeper, scaled by Field amt.
      if (o.fieldAmt > 0 && this._field) {
        const e = 2 * this._gw / this._field.w;         // ± two field cells
        const gx = this._lum(t.x + e, t.y) - this._lum(t.x - e, t.y);
        const gy = this._lum(t.x, t.y + e) - this._lum(t.x, t.y - e);
        const g = Math.hypot(gx, gy);
        if (g > 1e-3) t.h += o.fieldAmt * Math.min(1, g * 6) * Math.sin(Math.atan2(gy, gx) - t.h) * SIM_DT * 4;
      }
      const step = speed * er;
      let nx = t.x + Math.cos(t.h) * step, ny = t.y + Math.sin(t.h) * step;
      if (nx < 0 || ny < 0 || nx >= this._gw || ny >= this._gh) continue;
      // Avoidance, not collision: a tip whose look-ahead (Density sets how
      // far, past its own edge) finds another thread curves toward whichever
      // side is free and keeps growing. It dies only when another thread is
      // right against its edge, or it has turned away for ~25 steps without
      // finding room. A longer look-ahead means earlier warning, so more tips
      // survive to branch: that — not closer packing — is what makes the
      // colony denser (measured; see growth.hyDensity).
      const wd = this._width(t.gen), look = o.look + wd / 2;
      // Own trail: the steps this tip needs to leave its look-ahead behind.
      t.selfSteps = Math.ceil((look + wd) / Math.max(step, 1e-3)) + 2;
      if (!this._clear(nx, ny, t.h, look, o, t)) {
        const L = this._clear(nx, ny, t.h + 0.5, look, o, t), R = this._clear(nx, ny, t.h - 0.5, look, o, t);
        if (L || R) t.h += (L && (!R || Math.random() < 0.5) ? 1 : -1) * 0.12;
        t.w *= 0.5;
        // Dies only if another thread is right against its edge.
        if (++t.stuck > 25 || !this._clear(t.x, t.y, t.h, wd / 2 + 0.5, o, t)) continue;
        nx = t.x + Math.cos(t.h) * step; ny = t.y + Math.sin(t.h) * step;   // along the new heading
        if (nx < 0 || ny < 0 || nx >= this._gw || ny >= this._gh) continue;
      } else t.stuck = 0;
      this._mark(t.x, t.y, nx, ny, t.stamp, wd, t.id);
      this._pushSeg(t.x, t.y, nx, ny, o.now, t.stamp, wd);
      t.x = nx; t.y = ny;
      next.push(t);
      // A fork: a new tip off to one side, chance per cell of length.
      if (next.length + this._tips.length < MAX_TIPS * 2 && Math.random() < branch * 0.02 * step * er) {
        const side = Math.random() < 0.5 ? -1 : 1;
        const h = t.h + side * (0.6 + 0.5 * Math.random());
        const off = 0.8 + wd / 2;   // start clear of the parent's edge
        next.push({ x: nx + Math.cos(h) * off, y: ny + Math.sin(h) * off, h, w: -t.w, stamp: t.stamp, gen: t.gen + 1, stuck: 0, id: this._nextId++ });
      }
    }
    this._tips = next.length > MAX_TIPS ? next.slice(0, MAX_TIPS) : next;
  }

  // Sprouting along strokes: a small read-back of the seed every few frames;
  // where a stroke has just ARRIVED a few tips start, heading anywhere.
  _sprout(seedTex, seedAmt, copyMat) {
    const got = this._seedRead.poll();
    if (got && got.tag.gw === this._gw && got.tag.gh === this._gh) {
      const { buf, w, h } = got, n = w * h;
      if (!this._seedPrev || this._seedPrev.length !== n) this._seedPrev = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const l = (0.299 * buf[i * 4] + 0.587 * buf[i * 4 + 1] + 0.114 * buf[i * 4 + 2]) / 255 * got.tag.seedAmt;
        if (l > 0.3 && l - this._seedPrev[i] > 0.1 && Math.random() < 0.08) {
          const x = ((i % w) + Math.random()) / w * this._gw, y = (Math.floor(i / w) + Math.random()) / h * this._gh;
          this._spawn(x, y, Math.random() * Math.PI * 2, this._now);
        }
        this._seedPrev[i] = l;
      }
    }
    if (!seedTex || seedAmt <= 0 || this._frame % 4) return;
    const sh = Math.max(1, Math.round(SEED_W * this._gh / this._gw));
    this._seedRead.request(seedTex, copyMat, SEED_W, sh, { gw: this._gw, gh: this._gh, seedAmt });
  }

  // Field src as LIGHT: threads turn toward brighter parts of the field
  // (phototropism). A coarse luma copy, refreshed every 8 frames — light
  // moves slowly next to a thread tip, and 64 columns is plenty to steer by.
  _readField(fieldTex, fieldAmt, copyMat) {
    const got = this._fieldRead.poll();
    if (got) {
      const { buf, w, h } = got, lum = new Float32Array(w * h);
      for (let i = 0; i < w * h; i++) lum[i] = (0.299 * buf[i * 4] + 0.587 * buf[i * 4 + 1] + 0.114 * buf[i * 4 + 2]) / 255;
      this._field = { lum, w, h };
    }
    if (!fieldTex || fieldAmt <= 0) { this._field = null; return; }
    if (this._frame % 8) return;
    this._fieldRead.request(fieldTex, copyMat, FIELD_W, Math.max(1, Math.round(FIELD_W * this._gh / this._gw)), null);
  }

  /** Field luma at sim position (x, y), bilinear. */
  _lum(x, y) {
    const f = this._field;
    const fx = Math.min(f.w - 1.001, Math.max(0, x / this._gw * f.w - 0.5));
    const fy = Math.min(f.h - 1.001, Math.max(0, y / this._gh * f.h - 0.5));
    const ix = Math.floor(fx), iy = Math.floor(fy), tx = fx - ix, ty = fy - iy, L = f.lum, W = f.w;
    const a = L[iy * W + ix], b = L[iy * W + ix + 1], c = L[(iy + 1) * W + ix], d = L[(iy + 1) * W + ix + 1];
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
  }

  /**
   * @param o { gridRes, aspect, viewRes, dt, speed, variation, branch (0–1),
   *            edge (0–1), now, growTime, fadeTime, penRate, seedTex, seedAmt,
   *            plant: {x, y, r} | null, copyMat }
   */
  render(o) {
    this._size(o.gridRes, o.aspect, o.viewRes);
    const prev = this.renderer.getRenderTarget();
    if (this._needsClear) {
      for (const t of this._t) { this.renderer.setRenderTarget(t); this.renderer.setClearColor(0x000000, 0); this.renderer.clear(); }
      this._tips = [];
      this._occ.fill(0);
      this._occId.fill(0);
      this._needsClear = false;
      this._acc = 0;
    }
    const oo = {
      now: o.now, growTime: o.growTime ?? 0, fadeTime: o.fadeTime ?? 3, penRate: o.penRate ?? 0,
      // Speed 16 (the Look) ≈ 24 cells/s: a spore reaches the frame in ~20 s.
      cellsPerSec: 1.5 * (o.speed ?? 16),
      wander: 0.4 + 2.6 * ((o.variation ?? 0) / 100),
      branch: o.branch ?? 0.3, edge: o.edge ?? 0, fieldAmt: o.fieldAmt ?? 0,
      look: 0.5 + 3.5 * (o.density ?? 0.31),   // cells past its own edge a tip watches (Density)
    };
    this._now = o.now;   // stamp for tips an async stroke read-back spawns
    if (o.plant) this.plant(o.plant.x, o.plant.y, o.plant.r, o.now);
    this._sprout(o.seedTex, o.seedAmt ?? 0, o.copyMat);
    this._readField(o.fieldTex, o.fieldAmt ?? 0, o.copyMat);
    this._frame++;

    this._nSeg = 0;
    this._acc += Math.min(Math.max(o.dt, 0), 0.1);
    let n = 0;
    while (this._acc >= SIM_DT && n < 8) { this._step(oo); this._acc -= SIM_DT; n++; }
    if (n === 8) this._acc = 0;

    // Fully faded lineages are wiped from the drawing now and then.
    if ((oo.growTime > 0 || oo.penRate > 0) && this._frame % 10 === 0) {
      const c = this._cleanMat.uniforms;
      c.uSrc.value = this._t[this._cur].texture;
      c.uNow.value = oo.now; c.uGrowTime.value = oo.growTime; c.uFadeTime.value = oo.fadeTime; c.uPenRate.value = oo.penRate;
      this._blit(this._cleanMat, this._t[this._cur ^ 1]);
      this._cur ^= 1;
    }

    if (this._nSeg > 0) {
      this._geom.instanceCount = this._nSeg;
      this._geom.attributes.aSeg.needsUpdate = true;
      this._geom.attributes.aMeta.needsUpdate = true;
      this._segMat.uniforms.uSize.value.set(this._tw, this._th);
      this.renderer.setRenderTarget(this._t[this._cur]);
      const ac = this.renderer.autoClear;
      this.renderer.autoClear = false;
      this.renderer.render(this._scene, this._cam);
      this.renderer.autoClear = ac;
    }
    this.renderer.setRenderTarget(prev);
  }

  get tipCount() { return this._tips.length; }

  dispose() {
    for (const t of this._t) t?.dispose();
    this._seedRead.dispose();
    this._fieldRead.dispose();
    this._geom.dispose();
    this._segMat.dispose();
    this._cleanMat.dispose();
  }
}
