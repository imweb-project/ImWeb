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
 * front). The rule runs on the whole grid, as trained, and the mask only
 * says where it is SHOWN (holding bare cells empty ran away beside colonies
 * that stop growing — GROWTH_NCA_STEP). Spores (Lichen timelapse) land in
 * swarms and give each surviving colony its own genes (GROWTH_NCA_GENES).
 * The PICTURE settles: a photo
 * of each cell follows it while young and holds once mature
 * (GROWTH_NCA_CAPTURE), so only the rim lives — while the rule itself always
 * runs at its trained rate (slowing it made wounds blow up).
 * The pen acts where a stroke arrives: it plants on bare rock and WOUNDS
 * lichen, which the colony regrows into from the wound's edges — the NCA's
 * self-repair made visible. A colony wears the pen colour it was sown with
 * (the lichen's orange turned to the pen's hue; a white pen and Plant keep
 * the photo's colours), and the colour spreads and heals with it. Fade + Lifetime: Ring = cells die after Lifetime
 * and the rock is recolonised after Regrow delay (waves that never freeze);
 * Hold/Pen = colonies fade and stay gone; Off = forever.
 *
 * No Python at runtime: the exported JSON (public/nca/*.json) is packed into a
 * 16 × HID float texture on load. State: one render target with three RGBA
 * float attachments (channels 0–3, 4–7, 8–11), ping-ponged; one draw per step.
 * Channels 0–2 + 0.5 are the colour. The picture is drawn at SCREEN size
 * (view(): per-cell fields → B-spline up → coverage cut per pixel), so its
 * edges, plates and relief do not step in grid cells.
 */
import * as THREE from 'three';
import { GROWTH_NCA_STEP, GROWTH_NCA_ZERO, GROWTH_NCA_DOME, GROWTH_NCA_FIELDS, GROWTH_NCA_UP, GROWTH_NCA_VIEW, GROWTH_NCA_MASK, GROWTH_NCA_CAPTURE } from '../shaders/index.js';

// At most 2 updates a frame, the rest dropped: catching up after a slow
// frame made the next one slower still — at 9 fps it ran 8 full rule steps a
// frame (owner, 2026-09-27). Under load the timelapse slows, not the frame.
const MAX_STEPS_PER_FRAME = 2;
// Full rule steps after a Clear before a still model splits them (the
// texture forms in ~50).
const WARM_STEPS = 64;
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
// Spores: a swarm lands every ~SWARM_EVERY updates (3 s at Speed 16, jittered
// ±40%) as a cloud of SWARM_MAX × Spores spores around a random point; most
// wither (GROWTH_NCA_GENES). The first lands at once, from bare rock.
const SWARM_EVERY = 180;
const SWARM_MAX   = 60;

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
    const VUV = /* glsl */ `out vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position, 1.0); }`;
    // The picture, three passes: per-cell fields (grid) → B-spline up to
    // screen size → coverage cut and relief per screen pixel.
    this._fieldsMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: VERT3, fragmentShader: GROWTH_NCA_FIELDS,
      uniforms: {
        uPhoto: { value: null }, uMask: { value: null }, uTint: { value: null }, uGenes: { value: null },
        uLife: { value: 0 }, uFade: { value: 1 }, uRest: { value: 0 }, uDome: { value: null },
        uRelief: { value: 0 }, uGloss: { value: 0 }, uLight: { value: new THREE.Vector3(0, 0, 1) },
      },
      depthTest: false, depthWrite: false,
    });
    this._domeMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: VERT3, fragmentShader: GROWTH_NCA_DOME,
      uniforms: { uSrc: { value: null }, uDir: { value: new THREE.Vector2(1, 0) }, uFromPhoto: { value: true } },
      depthTest: false, depthWrite: false,
    });
    this._dome = null;           // [across, down] grid-size plate-dome blur targets
    this._upMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: VUV, fragmentShader: GROWTH_NCA_UP,
      uniforms: { uF: { value: null }, uGrid: { value: new THREE.Vector2() } },
      depthTest: false, depthWrite: false,
    });
    this._viewMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: VUV, fragmentShader: GROWTH_NCA_VIEW,
      uniforms: {
        uC: { value: null }, uF: { value: null }, uGridSize: { value: new THREE.Vector2() },
        uGround: { value: new THREE.Vector3(...GROUND) },
      },
      depthTest: false, depthWrite: false,
    });
    this._fields = null;         // grid-size fields, 2 × HalfFloat Linear (the B-spline filters them)
    this._up = null;             // the coverage field at screen size
    this._maskMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: VERT3, fragmentShader: GROWTH_NCA_MASK,
      uniforms: {
        uMask: { value: null }, uTint: { value: null }, uSeed: { value: null }, uSeedPrev: { value: null },
        uSize: { value: new THREE.Vector2() },
        uStep: { value: 0 }, uSpread: { value: SPREAD }, uFadeIn: { value: FADE_IN },
        uSeedAmt: { value: 0 }, uPoint: { value: new THREE.Vector3() },
        uAgeDt: { value: 0 }, uLife: { value: 0 }, uFade: { value: 1 }, uRest: { value: 0 },
        uGenes: { value: null }, uSwarm: { value: new THREE.Vector4() }, uSwarmSeed: { value: 0 },
        uVar: { value: 0 }, uColours: { value: 0 }, uS0: { value: null }, uWoundDone: { value: true },
      },
      depthTest: false, depthWrite: false,
    });
    this._swarmIn = 0;           // updates until the next swarm (0 = now)
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
    this._mask = null;           // [RT, RT], 3 × Float: mask, tint, genes (GROWTH_NCA_MASK)
    this._mcur = 0;
    this._seedPrev = null;       // the pen as of the last update (arrival test)
    // Resample copy for a Size change (mask and tint). Copied colony cells
    // come back YOUNG (b = 1): the state is emptied on resize, and the
    // picture must follow it again while it regrows.
    this._copyMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: { uT: { value: null }, uT2: { value: null }, uT3: { value: null } },
      vertexShader: /* glsl */ `out vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position, 1.0); }`,
      // Nearest (the targets are): a seed blended with its neighbour's is
      // another colony's seed.
      fragmentShader: /* glsl */ `precision highp float; uniform sampler2D uT, uT2, uT3; in vec2 vUv;
        layout(location = 0) out vec4 o; layout(location = 1) out vec4 ot; layout(location = 2) out vec4 og;
        void main() {
          vec4 m = texture(uT, vUv);
          bool on = m.b > 0.5;
          o = on ? vec4(m.r, 0.0, 1.0, m.a) : vec4(min(m.r, 0.0), 0.0, 0.0, 0.0);
          ot = on ? texture(uT2, vUv) : vec4(0.0);
          ivec2 sz = textureSize(uT3, 0);
          og = texelFetch(uT3, clamp(ivec2(vUv * vec2(sz)), ivec2(0), sz - 1), 0);
        }`,
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
        uStep: { value: 0 }, uFire: { value: this._model.fire }, uRot: { value: new THREE.Vector2(1, 0) },
        uD0: { value: null }, uD1: { value: null }, uD2: { value: null },
        uJ0: { value: 0 }, uJ1: { value: H }, uAcc: { value: false }, uApply: { value: true },
      },
      depthTest: false, depthWrite: false,
    });
    // A new rule starts from empty STATE — another model's state is foreign
    // to it — but keeps the colonies: the texture regrows under them in < 1 s.
    this._keepMask = !!this._state;
    this._needsInit = true;
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
    // shape (nearest copy). FLOAT, not HalfFloat: ages are seconds, and a
    // half float at 32 has a step of 1/32 s, so adding a 1/60 s frame rounded
    // back to 32 — every age stopped there and a Lifetime past ~27 s never
    // died (measured, runs/gltest/timelapse.html, 2026-09-26). The state
    // targets already need float rendering, so this asks nothing new.
    const old = this._mask;
    this._mask = [0, 1].map(() => new THREE.WebGLRenderTarget(w, h, {
      count: 3, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
      format: THREE.RGBAFormat, type: THREE.FloatType, depthBuffer: false, stencilBuffer: false,
    }));
    const oldCur = this._mcur;
    this._mcur = 0;
    this._seedPrev?.setSize(w, h);
    if (old) {
      this._copyMat.uniforms.uT.value = old[oldCur].textures[0];
      this._copyMat.uniforms.uT2.value = old[oldCur].textures[1];
      this._copyMat.uniforms.uT3.value = old[oldCur].textures[2];
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
  clear() { this._needsInit = true; this._keepMask = false; this._swarmIn = 0; }

  /**
   * @param o { w, h, dt, speed (0–40), seedTex, seedAmt (0–1), plant {x,y,r} | null,
   *            life (s, 0 = forever), fade (s), rest (s; < 0 = never regrow),
   *            rot (radians: the whole texture's turn, 0 = as trained),
   *            spores (0–1, 0 = none), variation (0–1), colours (0–1) }
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
      this._ruleSteps = 0;
      this._part = 0;
    }
    // Speed 16 (the Growth default) = 60 steps a second: one per frame at 60 Hz.
    this._acc += Math.max(0, o.speed) * 3.75 * Math.min(Math.max(o.dt, 0), 0.1);
    let n = Math.min(MAX_STEPS_PER_FRAME, Math.floor(this._acc));
    this._acc -= Math.floor(this._acc);
    if (o.plant && n === 0) n = 1;             // a Plant lands even while paused

    const u = this._stepMat.uniforms, mu = this._maskMat.uniforms;
    // A still model's step is SPLIT over `split` frames — a share of the
    // hidden units each, applied on the last — once the texture has formed:
    // the rule is ~85% of the frame (11.5 ms per step at 256 on the Intel UHD
    // 630) and a still texture barely changes in a step. Same step, as
    // trained, landing 15 times a second instead of 60; the colonies still
    // grow every update. A restless model (split 1) steps with every update.
    const split = (o.split ?? 1) > 1 && this._ruleSteps >= WARM_STEPS ? o.split : 1;
    u.uSize.value.set(this._w, this._h);
    u.uRot.value.set(Math.cos(o.rot ?? 0), Math.sin(o.rot ?? 0));
    mu.uSize.value.set(this._w, this._h);
    mu.uSeed.value = o.seedTex;
    mu.uSeedPrev.value = this._seedPrev?.texture ?? null;   // null samples black: all arrives
    mu.uAgeDt.value = n > 0 ? Math.min(Math.max(o.dt, 0), 0.1) / n : 0;
    mu.uLife.value = o.life ?? 0;
    mu.uFade.value = Math.max(0.1, o.fade ?? 1);
    mu.uRest.value = o.rest ?? 0;
    mu.uVar.value = o.variation ?? 0;
    mu.uColours.value = o.colours ?? 0;
    const spores = o.spores ?? 0;
    for (let i = 0; i < n; i++) {
      this._step = (this._step + 1) % 16777216;
      // Colony first (screen coordinates): spread, pen, plant.
      mu.uMask.value = this._mask[this._mcur].textures[0];
      mu.uTint.value = this._mask[this._mcur].textures[1];
      mu.uGenes.value = this._mask[this._mcur].textures[2];
      mu.uS0.value = this._state[this._cur].textures[0];
      mu.uStep.value = this._step;
      mu.uSwarm.value.w = 0;
      if (spores > 0 && --this._swarmIn <= 0) {
        this._swarmIn = Math.round(SWARM_EVERY * (0.6 + 0.8 * Math.random()));
        const short = Math.min(this._w, this._h);
        const R = short * (0.15 + 0.3 * Math.random());
        mu.uSwarm.value.set(Math.random() * this._w, Math.random() * this._h, R,
          Math.min(0.25, (SWARM_MAX * spores) / (Math.PI * R * R)));
        mu.uSwarmSeed.value = Math.floor(Math.random() * 0xffffff);
      }
      if (i === 0 && o.plant) mu.uPoint.value.set(o.plant.x, o.plant.y, Math.max(1, o.plant.r * this._h));
      else mu.uPoint.value.z = 0;
      // The pen acts on the frame's FIRST update only: it compares against
      // the pen as of the last update, and a cell planted on update 0 must
      // not read as a stroke arriving on lichen (a wound) on update 1.
      mu.uSeedAmt.value = i === 0 && o.seedTex ? o.seedAmt : 0;
      this._blit(this._maskMat, this._mask[this._mcur ^ 1]);
      this._mcur ^= 1;
      mu.uWoundDone.value = false;                 // until the next full step
      if (i === 0 && o.seedTex) {
        this._seedPrev ??= new THREE.WebGLRenderTarget(this._w, this._h, { depthBuffer: false, stencilBuffer: false });
        this._passMat.uniforms.uT.value = o.seedTex;
        this._blit(this._passMat, this._seedPrev);
      }
      // Then the rule — whole grid, as trained; wounds empty their cells.
      if (split === 1) { this._part = 0; this._rulePass(0, this._model.hidden, true); }
    }
    if (split > 1 && n > 0) {
      const H = this._model.hidden, k = this._part;
      this._rulePass(Math.round((k * H) / split), Math.round(((k + 1) * H) / split), k === split - 1, k > 0);
      this._part = (k + 1) % split;
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

  /**
   * Draw the picture into `target` — screen size, not grid size: coverage is
   * cut per target pixel, so edges and relief are smooth at any Size.
   * @param look { relief (normal depth, 0 = flat), gloss (0–1), light (Vector3, unit) }
   */
  view(target, look = {}) {
    const half = (w, h, count) => new THREE.WebGLRenderTarget(w, h, {
      count, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat, type: THREE.HalfFloatType, depthBuffer: false, stencilBuffer: false,
    });
    this._fields ??= half(this._w, this._h, 2);
    this._up ??= half(target.width, target.height, 1);
    this._fields.setSize(this._w, this._h);
    this._up.setSize(target.width, target.height);
    this._dome ??= [0, 1].map(() => new THREE.WebGLRenderTarget(this._w, this._h, {
      minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
      format: THREE.RGBAFormat, type: THREE.HalfFloatType, depthBuffer: false, stencilBuffer: false,
    }));
    const d = this._domeMat.uniforms;
    this._dome.forEach((t) => t.setSize(this._w, this._h));
    d.uSrc.value = this._photo[this._pcur].texture; d.uDir.value.set(1, 0); d.uFromPhoto.value = true;
    this._blit(this._domeMat, this._dome[0]);
    d.uSrc.value = this._dome[0].texture; d.uDir.value.set(0, 1); d.uFromPhoto.value = false;
    this._blit(this._domeMat, this._dome[1]);
    const f = this._fieldsMat.uniforms;
    f.uPhoto.value = this._photo[this._pcur].texture;
    f.uMask.value = this._mask[this._mcur].textures[0];
    f.uTint.value = this._mask[this._mcur].textures[1];
    f.uGenes.value = this._mask[this._mcur].textures[2];
    f.uLife.value = this._maskMat.uniforms.uLife.value;
    f.uFade.value = this._maskMat.uniforms.uFade.value;
    f.uRest.value = this._maskMat.uniforms.uRest.value;
    f.uDome.value = this._dome[1].texture;
    f.uRelief.value = look.relief ?? 0;
    f.uGloss.value = look.gloss ?? 0;
    if (look.light) f.uLight.value.copy(look.light);
    this._blit(this._fieldsMat, this._fields);
    const u = this._upMat.uniforms;
    u.uF.value = this._fields.textures[1];
    u.uGrid.value.set(this._w, this._h);
    this._blit(this._upMat, this._up);
    const v = this._viewMat.uniforms;
    v.uC.value = this._fields.textures[0];     // colour: bilinear from the grid (sharper)
    v.uF.value = this._up.texture;
    v.uGridSize.value.set(this._w, this._h);
    this._blit(this._viewMat, target);
  }

  /**
   * One pass of the rule over hidden units j0..j1. `apply`: add the change so
   * far (`acc`) and step the state; otherwise write the partial change.
   */
  _rulePass(j0, j1, apply, acc = false) {
    const u = this._stepMat.uniforms;
    const src = this._state[this._cur];
    u.uS0.value = src.textures[0];
    u.uS1.value = src.textures[1];
    u.uS2.value = src.textures[2];
    u.uMask.value = this._mask[this._mcur].texture;
    u.uStep.value = this._step;
    u.uJ0.value = j0; u.uJ1.value = j1;
    u.uAcc.value = acc; u.uApply.value = apply;
    if (acc) {
      const d = this._dacc[this._dcur].textures;
      u.uD0.value = d[0]; u.uD1.value = d[1]; u.uD2.value = d[2];
    }
    if (apply) {
      this._blit(this._stepMat, this._state[this._cur ^ 1]);
      this._cur ^= 1;
      this._ruleSteps++;
      this._maskMat.uniforms.uWoundDone.value = true;   // every flagged wound is now emptied
    } else {
      if (!this._dacc || this._dacc[0].width !== this._w || this._dacc[0].height !== this._h) {
        this._dacc?.forEach((t) => t.dispose());
        this._dacc = [this._makeTarget(), this._makeTarget()];
        this._dcur = 0;
      }
      this._blit(this._stepMat, this._dacc[this._dcur ^ 1]);
      this._dcur ^= 1;
    }
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
    this._dacc?.forEach((t) => t.dispose());
    this._zeroMat.dispose();
    this._viewMat.dispose();
    this._fieldsMat.dispose();
    this._upMat.dispose();
    this._domeMat.dispose();
    this._dome?.forEach((t) => t.dispose());
    this._fields?.dispose();
    this._up?.dispose();
  }
}
