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
const LOOK      = 1.6;      // cells ahead a tip checks for another thread
const SIM_DT    = 1 / 60;   // fixed sim step, seconds
const SEED_W    = 128;      // stroke read-back grid (sprouting along strokes)

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
    this._metaA = new Float32Array(MAX_SEGS * 2);
    g.setAttribute('aSeg',  new THREE.InstancedBufferAttribute(this._segA, 4).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aMeta', new THREE.InstancedBufferAttribute(this._metaA, 2).setUsage(THREE.DynamicDrawUsage));
    g.instanceCount = 0;
    this._geom = g;
    this._segMat = new THREE.ShaderMaterial({
      vertexShader: GROWTH_CURVE_VERT, fragmentShader: GROWTH_CURVE_FRAG,
      uniforms: { uSize: { value: new THREE.Vector2(1, 1) }, uHalfW: { value: 0.8 } },
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
    this._seedRT = null;
    this._seedBuf = null;
    this._seedPrev = null;
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
    this._tips.push({ x, y, h, w: 0, stamp });
  }

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
    }
    if (tw !== this._tw || th !== this._th) {
      this._tw = tw; this._th = th;
      for (let i = 0; i < 2; i++) {
        if (this._t[i]) this._t[i].setSize(tw, th); else this._t[i] = this._target(tw, th);
      }
      this._needsClear = true;   // a resized float target holds no drawing
    }
  }

  // Occupancy: the stamp of the lineage whose thread is in a cell. Free if
  // empty or that lineage has faded out (the same rule as the view's fade).
  _free(stamp, o) {
    if (stamp <= 0) return true;
    if (o.growTime > 0 && o.now - stamp > o.growTime + o.fadeTime) return true;
    return o.penRate > 0 && Math.exp(-o.penRate * (o.now - stamp)) < 1 / 255;
  }
  _stopped(stamp, o) {
    if (o.growTime > 0 && o.now - stamp > o.growTime) return true;
    return o.penRate > 0 && Math.exp(-o.penRate * (o.now - stamp)) < 0.3;
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

  _mark(x0, y0, x1, y1, stamp) {
    const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 2));
    for (let i = 1; i <= n; i++) {
      const cx = Math.floor(x0 + (x1 - x0) * i / n), cy = Math.floor(y0 + (y1 - y0) * i / n);
      if (cx >= 0 && cy >= 0 && cx < this._gw && cy < this._gh) this._occ[cy * this._gw + cx] = stamp;
    }
  }

  _pushSeg(x0, y0, x1, y1, birth, stamp) {
    if (this._nSeg >= MAX_SEGS) return;
    const sx = this._tw / this._gw, sy = this._th / this._gh, i = this._nSeg++;
    this._segA[i * 4] = x0 * sx; this._segA[i * 4 + 1] = y0 * sy;
    this._segA[i * 4 + 2] = x1 * sx; this._segA[i * 4 + 3] = y1 * sy;
    this._metaA[i * 2] = birth; this._metaA[i * 2 + 1] = stamp;
  }

  /** One fixed sim step for every tip. */
  _step(o) {
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
      const step = speed * er;
      const dx = Math.cos(t.h), dy = Math.sin(t.h);
      const nx = t.x + dx * step, ny = t.y + dy * step;
      if (nx < 0 || ny < 0 || nx >= this._gw || ny >= this._gh) continue;
      // Look ahead: another thread there ends this one (they keep clear).
      const px = Math.floor(nx + dx * LOOK), py = Math.floor(ny + dy * LOOK);
      if (px >= 0 && py >= 0 && px < this._gw && py < this._gh && !this._free(this._occ[py * this._gw + px], o)) continue;
      this._mark(t.x, t.y, nx, ny, t.stamp);
      this._pushSeg(t.x, t.y, nx, ny, o.now, t.stamp);
      t.x = nx; t.y = ny;
      next.push(t);
      // A fork: a new tip off to one side, chance per cell of length.
      if (next.length + this._tips.length < MAX_TIPS * 2 && Math.random() < branch * 0.02 * step * er) {
        const side = Math.random() < 0.5 ? -1 : 1;
        const h = t.h + side * (0.6 + 0.5 * Math.random());
        next.push({ x: nx + Math.cos(h) * 0.8, y: ny + Math.sin(h) * 0.8, h, w: -t.w, stamp: t.stamp });
      }
    }
    this._tips = next.length > MAX_TIPS ? next.slice(0, MAX_TIPS) : next;
  }

  // Sprouting along strokes: a tiny read-back of the seed every few frames;
  // where a stroke has just ARRIVED a few tips start, heading anywhere.
  // ASYNC: a synchronous readPixels waits for the GPU to finish the frame —
  // measured ~10 ms each, 2.6–2.9 ms/frame averaged, when the whole tip
  // simulation cost 0.05 ms. So: readPixels into a pixel-pack buffer, fence,
  // and collect on a later frame once the fence has signalled.
  // Not three's readRenderTargetPixelsAsync: in r168 it leaves the pack
  // buffer BOUND while it waits, and every synchronous readPixels elsewhere
  // in the app then fails with INVALID_OPERATION (measured: GL error 1282).
  // Here the buffer is unbound straight after each use.
  _sprout(seedTex, seedAmt, o) {
    const gl = this.renderer.getContext();
    if (this._pend) {
      if (gl.getSyncParameter(this._pend.sync, gl.SYNC_STATUS) !== gl.SIGNALED) return;
      const p = this._pend;
      this._pend = null;
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, p.pbo);
      gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, p.buf);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      gl.deleteSync(p.sync);
      if (p.gw === this._gw && p.gh === this._gh && p.buf === this._seedBuf) this._sproutFrom(p);
    }
    if (!seedTex || seedAmt <= 0 || this._frame % 4) return;
    const sw = SEED_W, sh = Math.max(1, Math.round(SEED_W * this._gh / this._gw));
    if (!this._seedRT || this._seedRT.width !== sw || this._seedRT.height !== sh) {
      this._seedRT?.dispose();
      this._seedRT = new THREE.WebGLRenderTarget(sw, sh, { depthBuffer: false, stencilBuffer: false });
      this._seedBuf = new Uint8Array(sw * sh * 4);
      this._seedPrev = new Float32Array(sw * sh);
      if (this._pbo) gl.deleteBuffer(this._pbo);
      this._pbo = gl.createBuffer();
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this._pbo);
      gl.bufferData(gl.PIXEL_PACK_BUFFER, this._seedBuf.byteLength, gl.STREAM_READ);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    }
    o.copyMat.uniforms.uTexture.value = seedTex;
    this._blit(o.copyMat, this._seedRT);          // leaves _seedRT bound
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this._pbo);
    gl.readPixels(0, 0, sw, sh, gl.RGBA, gl.UNSIGNED_BYTE, 0);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    this._pend = { sync: gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0), pbo: this._pbo,
                   buf: this._seedBuf, sw, sh, gw: this._gw, gh: this._gh, seedAmt };
    gl.flush();
  }

  _sproutFrom({ buf, sw, sh, gw, gh, seedAmt }) {
    for (let i = 0; i < sw * sh; i++) {
      const l = (0.299 * buf[i * 4] + 0.587 * buf[i * 4 + 1] + 0.114 * buf[i * 4 + 2]) / 255 * seedAmt;
      if (l > 0.3 && l - this._seedPrev[i] > 0.1 && Math.random() < 0.08) {
        const x = ((i % sw) + Math.random()) / sw * gw, y = (Math.floor(i / sw) + Math.random()) / sh * gh;
        this._spawn(x, y, Math.random() * Math.PI * 2, this._now);
      }
      this._seedPrev[i] = l;
    }
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
      this._needsClear = false;
      this._acc = 0;
    }
    const oo = {
      now: o.now, growTime: o.growTime ?? 0, fadeTime: o.fadeTime ?? 3, penRate: o.penRate ?? 0,
      // Speed 16 (the Look) ≈ 24 cells/s: a spore reaches the frame in ~20 s.
      cellsPerSec: 1.5 * (o.speed ?? 16),
      wander: 0.4 + 2.6 * ((o.variation ?? 0) / 100),
      branch: o.branch ?? 0.3, edge: o.edge ?? 0,
    };
    this._now = o.now;   // stamp for tips an async stroke read-back spawns
    if (o.plant) this.plant(o.plant.x, o.plant.y, o.plant.r, o.now);
    this._sprout(o.seedTex, o.seedAmt ?? 0, { ...oo, copyMat: o.copyMat });
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
      // A thread is one sim cell wide, as Hyphae's is one grid pixel — but
      // anti-aliased, and never under a pixel.
      this._segMat.uniforms.uHalfW.value = Math.max(0.5, 0.5 * this._tw / this._gw);
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
    this._seedRT?.dispose();
    const gl = this.renderer.getContext();
    if (this._pend) gl.deleteSync(this._pend.sync);
    if (this._pbo) gl.deleteBuffer(this._pbo);
    this._geom.dispose();
    this._segMat.dispose();
    this._cleanMat.dispose();
  }
}
