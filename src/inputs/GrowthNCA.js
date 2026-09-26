/**
 * GrowthNCA — Growth engine 5, "Neural": a texture Neural Cellular Automaton.
 *
 * The rule is a tiny network trained offline on one photo
 * (tools/nca/train_texture.py, after Niklasson et al., "Self-Organising
 * Textures", Distill 2021): every cell looks at its 3×3 neighbourhood through
 * four fixed filters, a 1-hidden-layer MLP turns that into a change of its 12
 * state channels, and a random half of the cells apply it each step. From an
 * empty grid the photo's texture emerges everywhere at once and keeps living;
 * wiped ground (Pen, Plant, Clear) heals from its surroundings. The grid wraps,
 * as in training, so the texture tiles.
 *
 * Pen plants lichen (owner, 2026-09-26): the frame starts as bare ground and
 * a colony MASK (screen coordinates, GROWTH_NCA_MASK) says where it lives.
 * Pen strokes and Plant sow the mask; it creeps outward on its own (an Eden
 * front); outside it the state is held empty. The PICTURE settles: a photo
 * of each cell follows it while young and holds once mature
 * (GROWTH_NCA_CAPTURE), so only the rim lives — while the rule itself always
 * runs at its trained rate (slowing it made wounds blow up).
 * The pen acts where a stroke arrives: it plants on bare rock and WOUNDS
 * lichen, which the colony regrows into from the wound's edges — the NCA's
 * self-repair made visible. Fade + Lifetime: Ring = cells die after Lifetime
 * and the rock is recolonised after Regrow delay (waves that never freeze);
 * Hold/Pen = colonies fade and stay gone; Off = forever.
 *
 * No Python at runtime: the exported JSON (public/nca/*.json) is packed into a
 * 16 × HID float texture on load. State: one render target with three RGBA
 * float attachments (channels 0–3, 4–7, 8–11), ping-ponged; one draw per step.
 * Channels 0–2 + 0.5 are the colour (GROWTH_NCA_VIEW).
 */
import * as THREE from 'three';
import { GROWTH_NCA_STEP, GROWTH_NCA_ZERO, GROWTH_NCA_VIEW, GROWTH_NCA_MASK, GROWTH_NCA_CAPTURE } from '../shaders/index.js';

const MAX_STEPS_PER_FRAME = 8;   // each step is a full MLP per cell
// Colony spread: chance per step per living neighbour that a bare cell joins.
// A straight front has ~3 living neighbours, so it advances ~3 × SPREAD cells
// a step — ~2 cells/s at 60 steps/s (Speed 16).
const SPREAD  = 0.012;
const FADE_IN = 1 / 60;          // a new cell's coverage reaches 1 in ~60 steps
const GROUND  = [0.08, 0.08, 0.09];   // bare rock
// Settling, in updates since a cell joined: the photo follows fully until 90
// (a texture forms in ~64–96), holds from 220. Updates, not seconds, so any
// Speed works.
// Shorter than it could be on purpose: lichenB's dark discs sink while
// young (owner: "leaking like raindrops"), so the young phase is kept brief.
const SETTLE  = [90, 220];

const VERT3 = /* glsl */ `
  void main() { gl_Position = vec4(position, 1.0); }
`;

export class GrowthNCA {
  /** @param blit (material, target) => void — GrowthRD's full-screen pass */
  constructor(renderer, blit) {
    this.renderer = renderer;
    this._blit = blit;
    this._w = 0;
    this._h = 0;
    this._state = null;          // [RT, RT], each with 3 attachments
    this._cur = 0;
    this._acc = 0;
    this._step = 0;
    this._needsInit = true;
    this._model = null;          // { url, hidden, fire, tex } once loaded
    this._loading = null;
    this._stepMat = null;        // built when the model's HID is known
    this._zeroMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: VERT3, fragmentShader: GROWTH_NCA_ZERO,
      depthTest: false, depthWrite: false,
    });
    this._viewMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: {
        uPhoto: { value: null }, uMask: { value: null }, uGround: { value: new THREE.Vector3(...GROUND) },
        uLife: { value: 0 }, uFade: { value: 1 }, uRest: { value: 0 },
      },
      vertexShader: /* glsl */ `out vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position, 1.0); }`,
      fragmentShader: GROWTH_NCA_VIEW, depthTest: false, depthWrite: false,
    });
    this._maskMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: VERT3, fragmentShader: GROWTH_NCA_MASK,
      uniforms: {
        uMask: { value: null }, uSeed: { value: null }, uSeedPrev: { value: null },
        uSize: { value: new THREE.Vector2() },
        uStep: { value: 0 }, uSpread: { value: SPREAD }, uFadeIn: { value: FADE_IN },
        uSeedAmt: { value: 0 }, uPoint: { value: new THREE.Vector3() },
        uAgeDt: { value: 0 }, uLife: { value: 0 }, uFade: { value: 1 }, uRest: { value: 0 },
      },
      depthTest: false, depthWrite: false,
    });
    this._captureMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: VERT3, fragmentShader: GROWTH_NCA_CAPTURE,
      uniforms: {
        uS0: { value: null }, uMask: { value: null }, uPhoto: { value: null },
        uSettle: { value: new THREE.Vector2(...SETTLE) },
      },
      depthTest: false, depthWrite: false,
    });
    this._photo = null;          // [RT, RT], 8-bit: the settled picture
    this._pcur = 0;
    this._mask = null;           // [RT, RT], HalfFloat (see GROWTH_NCA_MASK)
    this._mcur = 0;
    this._seedPrev = null;       // the pen as of the last update (arrival test)
    // Resample copy for a Size change. Copied colony cells come back YOUNG
    // (b = 1): the state is emptied on resize, and a cell left settled would
    // hold that empty grey forever.
    this._copyMat = new THREE.ShaderMaterial({
      uniforms: { uT: { value: null } },
      vertexShader: /* glsl */ `varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position, 1.0); }`,
      fragmentShader: /* glsl */ `uniform sampler2D uT; varying vec2 vUv;
        void main() { vec4 m = texture2D(uT, vUv); gl_FragColor = m.b > 0.5 ? vec4(m.r, 0.0, 1.0, m.a) : vec4(min(m.r, 0.0), 0.0, 0.0, 0.0); }`,
      depthTest: false, depthWrite: false,
    });
    this._passMat = new THREE.ShaderMaterial({
      uniforms: { uT: { value: null } },
      vertexShader: /* glsl */ `varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position, 1.0); }`,
      fragmentShader: /* glsl */ `uniform sampler2D uT; varying vec2 vUv; void main() { gl_FragColor = texture2D(uT, vUv); }`,
      depthTest: false, depthWrite: false,
    });
  }

  get width()  { return this._w; }
  get height() { return this._h; }
  get ready()  { return !!(this._model && this._state); }

  /** Fetch a model JSON (once per url) and pack its weights. */
  load(url) {
    if (this._model?.url === url || this._loading === url) return;
    this._loading = url;
    fetch(url).then((r) => {
      if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
      return r.json();
    }).then((m) => {
      if (this._loading !== url) return;       // superseded
      this._setModel(url, m);
      this._loading = null;
    }).catch((e) => {
      console.error('[GrowthNCA] model load failed:', e);
      this._loading = null;
    });
  }

  _setModel(url, m) {
    if (m.kind !== 'texture-nca' || m.channels !== 12) {
      throw new Error(`[GrowthNCA] ${url}: need a 12-channel texture-nca, got ${m.kind}/${m.channels}`);
    }
    const H = m.hidden;
    const data = new Float32Array(16 * H * 4);
    for (let j = 0; j < H; j++) {
      const row = j * 16 * 4;
      // W1: texel t*4+k, component i = w1[j][(t*4+i)*4 + k]  (perception c*4+k)
      for (let t = 0; t < 3; t++) for (let k = 0; k < 4; k++) for (let i = 0; i < 4; i++) {
        data[row + (t * 4 + k) * 4 + i] = m.w1[j][(t * 4 + i) * 4 + k];
      }
      data[row + 12 * 4] = m.b1[j];
      // W2: texel 13+t, component i = w2[t*4+i][j]
      for (let t = 0; t < 3; t++) for (let i = 0; i < 4; i++) {
        data[row + (13 + t) * 4 + i] = m.w2[t * 4 + i][j];
      }
    }
    const tex = new THREE.DataTexture(data, 16, H, THREE.RGBAFormat, THREE.FloatType);
    tex.minFilter = tex.magFilter = THREE.NearestFilter;
    tex.needsUpdate = true;
    this._model?.tex.dispose();
    this._model = { url, hidden: H, fire: m.fire_rate ?? 0.5, tex };
    this._stepMat?.dispose();
    this._stepMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: VERT3, fragmentShader: GROWTH_NCA_STEP,
      defines: { HID: H },
      uniforms: {
        uS0: { value: null }, uS1: { value: null }, uS2: { value: null },
        uW: { value: tex }, uMask: { value: null },
        uSize: { value: new THREE.Vector2() },
        uStep: { value: 0 }, uFire: { value: this._model.fire },
      },
      depthTest: false, depthWrite: false,
    });
    this._needsInit = true;                    // a new rule starts from empty
  }

  _makeTarget() {
    return new THREE.WebGLRenderTarget(this._w, this._h, {
      count: 3, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
      format: THREE.RGBAFormat, type: THREE.FloatType,
      depthBuffer: false, stencilBuffer: false,
    });
  }

  _ensureSize(w, h) {
    if (this._state && w === this._w && h === this._h) return;
    this._w = w;
    this._h = h;
    this._state?.forEach((t) => t.dispose());
    this._state = [this._makeTarget(), this._makeTarget()];
    this._photo?.forEach((t) => t.dispose());
    this._photo = [0, 1].map(() => new THREE.WebGLRenderTarget(w, h, {
      minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false, stencilBuffer: false,
    }));
    // The mask is RESAMPLED, not wiped: a Size change keeps the colony's
    // shape (Linear copy, re-thresholded at 0.5 by the next mask pass).
    // HalfFloat: .b counts updates to 2048; still filterable for that copy.
    const old = this._mask;
    this._mask = [0, 1].map(() => new THREE.WebGLRenderTarget(w, h, {
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat, type: THREE.HalfFloatType, depthBuffer: false, stencilBuffer: false,
    }));
    const oldCur = this._mcur;
    this._mcur = 0;
    this._seedPrev?.setSize(w, h);
    if (old) {
      this._copyMat.uniforms.uT.value = old[oldCur].texture;
      this._blit(this._copyMat, this._mask[0]);
      old.forEach((t) => t.dispose());
      this._keepMask = true;
    }
    this._needsInit = true;                    // the texture regrows within the colony in ~1 s
  }

  /** Set the whole colony to v (0 = bare, 1 = covered). Restores the app's clear colour. */
  _fillMask(v) {
    const r = this.renderer, c = r.getClearColor(new THREE.Color()), al = r.getClearAlpha();
    r.setClearColor(new THREE.Color(v, v, v), 1);
    for (const t of this._mask) { r.setRenderTarget(t); r.clear(); }
    r.setClearColor(c, al);
  }

  /** Bare ground everywhere: state and colony both emptied. */
  clear() { this._needsInit = true; this._keepMask = false; }

  /**
   * @param o { w, h, dt, speed (0–40), seedTex, seedAmt (0–1), plant {x,y,r} | null,
   *            life (s, 0 = forever), fade (s), rest (s; < 0 = never regrow) }
   * Returns false until the model has loaded (nothing drawn yet).
   */
  render(o) {
    this._ensureSize(o.w, o.h);
    if (!this._model || !this._stepMat) return false;
    if (this._needsInit) {
      for (const t of this._state) this._blit(this._zeroMat, t);
      if (!this._keepMask) this._fillMask(0);
      this._keepMask = false;
      this._needsInit = false;
      this._acc = 0;
    }
    // Speed 16 (the Growth default) = 60 steps a second: one per frame at 60 Hz.
    this._acc += Math.max(0, o.speed) * 3.75 * Math.min(Math.max(o.dt, 0), 0.1);
    let n = Math.min(MAX_STEPS_PER_FRAME, Math.floor(this._acc));
    this._acc -= Math.floor(this._acc);
    if (o.plant && n === 0) n = 1;             // a Plant lands even while paused

    const u = this._stepMat.uniforms, mu = this._maskMat.uniforms;
    u.uSize.value.set(this._w, this._h);
    mu.uSize.value.set(this._w, this._h);
    mu.uSeed.value = o.seedTex;
    mu.uSeedPrev.value = this._seedPrev?.texture ?? null;   // null samples black: all arrives
    mu.uAgeDt.value = n > 0 ? Math.min(Math.max(o.dt, 0), 0.1) / n : 0;
    mu.uLife.value = o.life ?? 0;
    mu.uFade.value = Math.max(0.1, o.fade ?? 1);
    mu.uRest.value = o.rest ?? 0;
    for (let i = 0; i < n; i++) {
      this._step = (this._step + 1) % 16777216;
      // Colony first (screen coordinates): spread, pen, plant.
      mu.uMask.value = this._mask[this._mcur].texture;
      mu.uStep.value = this._step;
      if (i === 0 && o.plant) mu.uPoint.value.set(o.plant.x, o.plant.y, Math.max(1, o.plant.r * this._h));
      else mu.uPoint.value.z = 0;
      // The pen acts on the frame's FIRST update only: it compares against
      // the pen as of the last update, and a cell planted on update 0 must
      // not read as a stroke arriving on lichen (a wound) on update 1.
      mu.uSeedAmt.value = i === 0 && o.seedTex ? o.seedAmt : 0;
      this._blit(this._maskMat, this._mask[this._mcur ^ 1]);
      this._mcur ^= 1;
      if (i === 0 && o.seedTex) {
        this._seedPrev ??= new THREE.WebGLRenderTarget(this._w, this._h, { depthBuffer: false, stencilBuffer: false });
        this._passMat.uniforms.uT.value = o.seedTex;
        this._blit(this._passMat, this._seedPrev);
      }
      // Then the rule, held empty outside the colony, settling with age.
      const src = this._state[this._cur];
      u.uS0.value = src.textures[0];
      u.uS1.value = src.textures[1];
      u.uS2.value = src.textures[2];
      u.uMask.value = this._mask[this._mcur].texture;
      u.uStep.value = this._step;
      this._blit(this._stepMat, this._state[this._cur ^ 1]);
      this._cur ^= 1;
    }
    // The picture: follow the live colour where young, hold where settled.
    if (n > 0) {
      const c = this._captureMat.uniforms;
      c.uS0.value = this._state[this._cur].textures[0];
      c.uMask.value = this._mask[this._mcur].texture;
      c.uPhoto.value = this._photo[this._pcur].texture;
      this._blit(this._captureMat, this._photo[this._pcur ^ 1]);
      this._pcur ^= 1;
    }
    return true;
  }

  /** Draw the current state's colour into `target` (any size; Linear upscale). */
  view(target) {
    const v = this._viewMat.uniforms;
    v.uPhoto.value = this._photo[this._pcur].texture;
    v.uMask.value = this._mask[this._mcur].texture;
    v.uLife.value = this._maskMat.uniforms.uLife.value;
    v.uFade.value = this._maskMat.uniforms.uFade.value;
    v.uRest.value = this._maskMat.uniforms.uRest.value;
    this._blit(this._viewMat, target);
  }

  /** The three state attachments, for tests: [tex0, tex1, tex2]. */
  get stateTextures() { return this._state?.[this._cur].textures ?? null; }

  dispose() {
    this._state?.forEach((t) => t.dispose());
    this._mask?.forEach((t) => t.dispose());
    this._photo?.forEach((t) => t.dispose());
    this._captureMat.dispose();
    this._copyMat.dispose();
    this._passMat.dispose();
    this._seedPrev?.dispose();
    this._maskMat.dispose();
    this._model?.tex.dispose();
    this._stepMat?.dispose();
    this._zeroMat.dispose();
    this._viewMat.dispose();
  }
}
