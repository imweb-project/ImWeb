/**
 * ImWeb Growth — Gray-Scott reaction-diffusion (source 33)
 *
 * Two chemicals on a grid: A is food, B eats A and multiplies (A + 2B → 3B),
 * both diffuse, A is fed in at `feed` and B is removed at `feed + kill`. Two
 * numbers, and the whole zoo falls out of them — coral, mitosis, mazes,
 * fingerprints, worms, solitons. This is the "texture" half of organic growth:
 * the surface that lichen, coral and cell colonies make.
 *
 * ── Seeded, not generated ───────────────────────────────────────────────────
 * Nothing happens on an empty grid — B has to be put somewhere first. That is
 * what makes this an instrument rather than a screensaver:
 *   - Seed src (Draw by default) injects B wherever the seed is bright, every
 *     frame. Paint a line and coral grows out of it; give Draw a fade and the
 *     seeds vanish while the growth carries on by itself. Any source works —
 *     a camera's highlights or the Motion matte make a live seed.
 *   - Plant drops one spore at (PlantX, PlantY): growth from a single point.
 *
 * ── The field: why lichen has zones ─────────────────────────────────────────
 * A real lichen is not one pattern, it is several, changing with the stone
 * under it. Field src (Noise by default) blends Pattern A → Pattern B PER
 * PIXEL, so one simulation grows mazes in one region and spots in the next,
 * with the boundary drifting as the noise moves. `feed`/`kill` offsets sit on
 * top as the performable knobs — an LFO on Kill makes a colony breathe, grow
 * back and die back.
 *
 * ── Why float, why a fixed step ─────────────────────────────────────────────
 * The state is an accumulator stepped by small differences, the exact case
 * MotionExtract documents: in 8 bits the per-step change rounds to nothing and
 * the pattern freezes. RGBA32F + NearestFilter (read 1:1, and float is not
 * filterable without OES_texture_float_linear).
 *
 * The integration step is FIXED (Δt = 1; Da = Scale ≤ 1, Db = Da/2 — stable
 * for the 9-point Laplacian). Frame rate changes how many steps run, never how
 * big one is: Speed is steps per 1/60 s, carried through an accumulator
 * against the real dt, so a 30 fps tab grows at the same rate, just coarser.
 *
 * The simulation grid takes the canvas ASPECT at a chosen resolution, so cells
 * are square on any output — a square grid stretched to 16:9 grows ellipses.
 */

import * as THREE from 'three';
import {
  VERT, GROWTH_RD_STEP, GROWTH_RD_VIEW, GROWTH_RD_INIT, GROWTH_MS_DOWN, GROWTH_MS_STEP,
  GROWTH_CR_AUX, GROWTH_CR_STEP, GROWTH_HY_STEP, PASSTHROUGH, GROWTH_UPSAMPLE,
} from '../shaders/index.js';
import { GROWTH_PATTERNS } from './GrowthPatterns.js';
import { GrowthCurves } from './GrowthCurves.js';

const MAX_STEPS_PER_FRAME = 64;   // a long dt must not stall the render loop
const MS_LEVELS = 6;              // pyramid depth: blur radii ~2 … 64 texels

// growth.mode values. APPEND-ONLY — the SELECT persists the index.
export const MODE_GRAY_SCOTT = 0;
export const MODE_MULTISCALE = 1;
export const MODE_CRYSTAL    = 2;
export const MODE_HYPHAE     = 3;
export const MODE_CURVES     = 4;

export class GrowthRD {
  constructor(renderer) {
    this.renderer = renderer;
    this._w = 0;
    this._h = 0;

    const mat = (fragmentShader, uniforms) => new THREE.ShaderMaterial({
      uniforms, vertexShader: VERT, fragmentShader,
      depthTest: false, depthWrite: false,
    });

    this._stepMat = mat(GROWTH_RD_STEP, {
      uState:    { value: null },
      uTexel:    { value: new THREE.Vector2(1, 1) },
      uSeed:     { value: null },
      uSeedAmt:  { value: 0 },
      uSeedPrev: { value: null },
      uField:    { value: null },
      uFieldAmt: { value: 0 },
      uFkA:      { value: new THREE.Vector2() },
      uFkB:      { value: new THREE.Vector2() },
      uFkOff:    { value: new THREE.Vector2() },
      uPoint:    { value: new THREE.Vector3(0.5, 0.5, 0) },
      uDiff:     { value: 1 },
      uVar:      { value: 0 },
      uZones:    { value: 0 },
      uVarP:     { value: new THREE.Vector3(3, 0, 1) },
      uEdge:     { value: 0 },
      uAgeDt:    { value: 0 },
      uLife:     { value: 0 },
      uRest:     { value: 0 },
      uNow:      { value: 0 },
      uGrowTime: { value: 0 },
      uFadeTime: { value: 3 }, uPenRate: { value: 0 },
    });
    this._viewMat = mat(GROWTH_RD_VIEW, {
      uState:    { value: null },
      uHue:      { value: 0 },
      uSat:      { value: 0 },
      uSpread:   { value: 0 },
      uColonies: { value: 0 },
      uContrast: { value: 4 },
      uMode:     { value: 0 },
      uNow:      { value: 0 },
      uGrowTime: { value: 0 },
      uFadeTime: { value: 3 }, uPenRate: { value: 0 },
      uTexel:    { value: new THREE.Vector2(1, 1) },
      uRelief:   { value: 0 },
      uLight:    { value: new THREE.Vector3(0, 0, 1) },
      uGloss:    { value: 0 },
      uGround:   { value: 0 },
      uBevel:    { value: 2 },
      uRings:    { value: 0 },
      uRingGap:  { value: 0.5 },
      uLines:    { value: 0 },
      uFill:     { value: 1 },
    });
    this._initMat = mat(GROWTH_RD_INIT, { uInit: { value: new THREE.Vector4(1, 0, 0, 1) } });

    // Multi-scale: pyramid downsample + step. Both built up front (cheap), the
    // pyramid TARGETS only when the mode is first used.
    this._downMat = mat(GROWTH_MS_DOWN, {
      uSrc: { value: null }, uSrcTexel: { value: new THREE.Vector2() }, uOff: { value: 1 },
    });
    const msU = {
      uState: { value: null }, uTexel: { value: new THREE.Vector2(1, 1) },
      uStep: { value: 1 }, uFine: { value: 0 }, uCoarse: { value: 4 }, uBias: { value: 0 },
      uField: { value: null }, uFieldAmt: { value: 0 },
      uSeed: { value: null }, uSeedAmt: { value: 0 },
      uPoint: { value: new THREE.Vector3(0.5, 0.5, 0) },
      uVar: { value: 0 }, uVarP: { value: new THREE.Vector3(3, 0, 1) }, uEdge: { value: 0 },
    };
    for (let l = 1; l <= MS_LEVELS; l++) {
      msU[`uL${l}`] = { value: null };
      msU[`uS${l}`] = { value: new THREE.Vector2(1, 1) };
    }
    this._msMat = mat(GROWTH_MS_STEP, msU);
    this._pyr   = null;

    // Crystal: aux pass (ε terms) + step. Aux target allocated on first use.
    this._crAuxMat = mat(GROWTH_CR_AUX, {
      uState: { value: null }, uTexel: { value: new THREE.Vector2(1, 1) },
      uAniso: { value: 0.04 }, uFold: { value: 6 }, uAngle: { value: 0 }, uDX: { value: 0.03 },
    });
    this._crMat = mat(GROWTH_CR_STEP, {
      uState: { value: null }, uAux: { value: null }, uTexel: { value: new THREE.Vector2(1, 1) },
      uHeat: { value: 1.6 }, uNoise: { value: 0.01 }, uSeedRand: { value: 0 }, uDX: { value: 0.03 },
      uSeed: { value: null }, uSeedAmt: { value: 0 }, uSeedPrev: { value: null },
      uPoint: { value: new THREE.Vector3(0.5, 0.5, 0) },
      uNow: { value: 0 }, uAgeDt: { value: 0 },
      uField: { value: null }, uFieldAmt: { value: 0 },
      uGrowTime: { value: 0 }, uFadeTime: { value: 3 }, uPenRate: { value: 0 },
      uVar: { value: 0 }, uVarP: { value: new THREE.Vector3(3, 0, 1) }, uEdge: { value: 0 },
    });
    this._aux = null;

    // Hyphae: one pass a step, no extra targets.
    this._hyMat = mat(GROWTH_HY_STEP, {
      uState: { value: null }, uTexel: { value: new THREE.Vector2(1, 1) },
      uNow: { value: 0 }, uAgeDt: { value: 0 }, uSeedRand: { value: 0 },
      uGrowP: { value: 0.7 }, uWander: { value: 1 }, uBranch: { value: 0.3 },
      uSeed: { value: null }, uSeedPrev: { value: null }, uSeedAmt: { value: 0 },
      uPoint: { value: new THREE.Vector3(0.5, 0.5, 0) },
      uGrowTime: { value: 0 }, uFadeTime: { value: 3 }, uPenRate: { value: 0 },
      uVar: { value: 0 }, uVarP: { value: new THREE.Vector3(3, 0, 1) }, uEdge: { value: 0 },
    });

    // Last frame's seed, so a step can tell a stroke ARRIVING at a pixel (a
    // rise) from one merely held there. 8-bit is plenty for a luma knee.
    this._copyMat  = mat(PASSTHROUGH, { uTexture: { value: null } });
    this._upMat    = mat(GROWTH_UPSAMPLE, { uSrc: { value: null }, uGrid: { value: new THREE.Vector2(1, 1) } });
    this._seedPrev = null;
    this._mode  = MODE_GRAY_SCOTT;

    this._geom  = new THREE.PlaneGeometry(2, 2);
    this._scene = new THREE.Scene();
    this._mesh  = new THREE.Mesh(this._geom, this._stepMat);
    this._scene.add(this._mesh);
    this._cam   = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    // Allocated on first render: a project that never routes Growth pays no VRAM.
    this._state = null;
    this._view  = null;
    this._cur   = 0;
    this._acc   = 0;          // fractional steps carried between frames
    this._needsInit = true;
    this._plant = null;       // pending one-shot spore {x, y, r}
  }

  _makeTarget(float) {
    const filter = float ? THREE.NearestFilter : THREE.LinearFilter;
    return new THREE.WebGLRenderTarget(this._w, this._h, {
      minFilter: filter, magFilter: filter,
      format: THREE.RGBAFormat,
      type: float ? THREE.FloatType : THREE.UnsignedByteType,
      depthBuffer: false, stencilBuffer: false,
    });
  }

  _blit(m, target) {
    this._mesh.material = m;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this._scene, this._cam);
  }

  /** Size the grid: `res` along the longer axis, the other from the aspect. */
  _ensureSize(res, aspect) {
    const a = aspect > 0 && isFinite(aspect) ? aspect : 1;
    const w = Math.max(8, Math.round(a >= 1 ? res : res * a));
    const h = Math.max(8, Math.round(a >= 1 ? res / a : res));
    if (this._state && w === this._w && h === this._h) return;
    this._w = w;
    this._h = h;
    if (this._pyr) this._sizePyramid();
    if (this._aux) this._aux.setSize(w, h);
    if (!this._state) {
      this._state = [this._makeTarget(true), this._makeTarget(true)];
      this._view  = this._makeTarget(false);
      this._needsInit = true;
      return;
    }
    // RESAMPLE, don't wipe: Size crosses between the 512 and 256 grids live,
    // and wiping the colony at the crossing would make Size unplayable. The
    // old state is copied into the new grid (nearest, float — values, ages
    // and lineage stamps carry over); the pattern then re-settles at the new
    // scale, which reads as the growth swelling or tightening.
    const old = this._state;
    this._state = [this._makeTarget(true), this._makeTarget(true)];
    const prev = this.renderer.getRenderTarget();
    this._copyMat.uniforms.uTexture.value = old[this._cur].texture;
    this._blit(this._copyMat, this._state[0]);
    this._blit(this._copyMat, this._state[1]);
    this.renderer.setRenderTarget(prev);
    for (const t of old) t.dispose();
    this._cur = 0;
    this._view.setSize(w, h);
  }

  // HalfFloat + Linear: the pyramid is SAMPLED between texels (that is the
  // blur), so it must be filterable — RGBA32F is not without an extension,
  // RGBA16F is in WebGL2. Half precision is ample for an averaged value.
  _sizePyramid() {
    const mk = () => new THREE.WebGLRenderTarget(1, 1, {
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat, type: THREE.HalfFloatType,
      depthBuffer: false, stencilBuffer: false,
    });
    if (!this._pyr) this._pyr = Array.from({ length: MS_LEVELS }, mk);
    let w = this._w, h = this._h;
    for (const t of this._pyr) {
      w = Math.max(1, Math.ceil(w / 2));
      h = Math.max(1, Math.ceil(h / 2));
      t.setSize(w, h);
    }
  }

  /** Queue one spore. x, y in 0–1 (y up), r as a fraction of grid height. */
  plant(x, y, r) { this._plant = { x, y, r }; }

  /** Wipe back to pure food (A = 1, B = 0) on the next render. */
  clear() { this._needsInit = true; this._curves?.clear(); }

  /**
   * @param {number} dt  seconds since the last frame
   * @param {object} o
   *   res, aspect, speed (steps per 1/60 s), seedTex, seedAmt (0–1),
   *   fieldTex, fieldAmt (0–1), patternA, patternB (indices), feed, kill
   *   (offsets), hue (deg), sat, spread, colonies, contrast
   */
  render(dt, o) {
    this._ensureSize(o.res, o.aspect);
    const prevTarget = this.renderer.getRenderTarget();

    // The two modes read the state channels differently, so a switch starts
    // from that mode's own empty state rather than reinterpreting the other's.
    const mode = [MODE_MULTISCALE, MODE_CRYSTAL, MODE_HYPHAE, MODE_CURVES].includes(o.mode) ? o.mode : MODE_GRAY_SCOTT;
    if (mode !== this._mode) { this._mode = mode; this._needsInit = true; }
    if (mode === MODE_MULTISCALE && !this._pyr) this._sizePyramid();
    if (mode === MODE_CRYSTAL && !this._aux) this._aux = this._makeTarget(true);

    if (this._needsInit) {
      // x: A = 1 (Gray-Scott food) · v = −1 (multi-scale) · p = 0 (crystal: all
      // melt, at T = 0 — undercooled). w: lineage stamp 0.
      const x0 = mode === MODE_MULTISCALE ? -1 : (mode === MODE_CRYSTAL || mode === MODE_HYPHAE) ? 0 : 1;
      this._initMat.uniforms.uInit.value.set(x0, 0, 0, 0);
      this._blit(this._initMat, this._state[0]);
      this._blit(this._initMat, this._state[1]);
      this._needsInit = false;
      this._acc = 0;
    }

    // Same clamp as MotionExtract: a hidden tab returning with a multi-second
    // dt must not dump hundreds of steps into one frame.
    const step = Math.min(Math.max(dt, 0), 0.1);
    // A multi-scale step moves ~0.01–0.05 of the full range and costs seven
    // passes (six pyramid levels + the step); at the Gray-Scott rate a spore
    // filled the frame in ~3 s for 25 ms/frame on an Intel iGPU. Quarter rate
    // keeps one Speed dial meaning "how fast it grows" in both modes.
    // Crystal: two passes a step, trig per pixel. Half rate puts a whole
    // Kobayashi crystal (~4000 steps) at ~8 s at default Speed; 4× rate grew
    // it in ~1 s and cost 55 ms/frame at 256 (Intel UHD 630).
    // Hyphae: a tip moves up to one cell a step, so full rate crossed the
    // frame in about a second; a quarter makes growth watchable.
    this._acc += o.speed * step * 60 * (mode === MODE_MULTISCALE || mode === MODE_HYPHAE ? 0.25 : mode === MODE_CRYSTAL ? 0.5 : 1);
    let n = Math.min(MAX_STEPS_PER_FRAME, Math.floor(this._acc));
    this._acc -= Math.floor(this._acc);
    // A pending spore must land even while Speed is 0 — planting into a
    // paused colony and then releasing it is a real gesture.
    if (this._plant && n === 0) n = 1;

    const u = this._stepMat.uniforms;
    const A = GROWTH_PATTERNS[o.patternA] ?? GROWTH_PATTERNS[0];
    const B = GROWTH_PATTERNS[o.patternB] ?? A;
    u.uTexel.value.set(1 / this._w, 1 / this._h);
    u.uSeed.value     = o.seedTex;
    u.uSeedAmt.value  = o.seedTex ? o.seedAmt : 0;
    u.uSeedPrev.value = this._seedPrevTex();
    u.uField.value    = o.fieldTex;
    u.uFieldAmt.value = o.fieldTex ? o.fieldAmt : 0;
    u.uFkA.value.set(A.f, A.k);
    u.uFkB.value.set(B.f, B.k);
    u.uFkOff.value.set(o.feed, o.kill);
    u.uDiff.value = o.diff ?? 1;
    u.uZones.value = (o.zones ?? 0) / 100;
    // The frame's real time is shared across its steps, so age is in real
    // seconds whatever Speed is — and a paused colony (no steps) stops ageing.
    u.uAgeDt.value = n > 0 ? step / n : 0;
    u.uLife.value  = o.life ?? 0;
    u.uRest.value  = o.rest ?? 0;
    // Lineage clock: monotonic across Clear (stamps only compare), advanced a
    // little even when paused so a Plant into a paused colony is still newer.
    this._clock = (this._clock ?? 0) + Math.max(step, 1e-2);
    u.uNow.value   = this._clock;
    u.uGrowTime.value = o.growTime ?? 0;
    u.uFadeTime.value = o.fadeTime ?? 3;
    u.uPenRate.value  = o.penRate ?? 0;

    // Variation — shared by all three step materials, set once per frame.
    // Drift runs on the lineage clock (real seconds).
    const varAmt = (o.variation ?? 0) / 100;
    const varT   = this._clock * (o.varDrift ?? 0.05);
    for (const m of [this._stepMat, this._msMat, this._crMat, this._hyMat]) {
      m.uniforms.uVar.value = varAmt;
      m.uniforms.uVarP.value.set(o.varSize ?? 3, varT, this._w / this._h);
      m.uniforms.uEdge.value = (o.edge ?? 0) / 100;
    }

    if (mode === MODE_MULTISCALE) {
      this._stepMultiScale(n, o);
    } else if (mode === MODE_CRYSTAL) {
      this._stepCrystal(n, o, u.uAgeDt.value, u.uNow.value);
    } else if (mode === MODE_HYPHAE) {
      this._stepHyphae(n, o, u.uAgeDt.value, u.uNow.value);
    } else if (mode === MODE_CURVES) {
      // Curves runs its own fixed-step clock on real time (see GrowthCurves).
      this._curves ??= new GrowthCurves(this.renderer, (m, t) => this._blit(m, t));
      this._curves.render({
        gridRes: this._w >= this._h ? this._w : this._h, aspect: o.aspect, viewRes: o.viewRes,
        dt: o.speed > 0 ? step : 0, speed: o.speed, variation: o.variation,
        branch: (o.hyBranch ?? 30) / 100, edge: (o.edge ?? 0) / 100,
        now: this._clock, growTime: o.growTime, fadeTime: o.fadeTime, penRate: o.penRate,
        seedTex: o.seedTex, seedAmt: o.seedTex ? o.seedAmt : 0,
        plant: this._plant, copyMat: this._copyMat,
      });
      this._plant = null;
    } else for (let i = 0; i < n; i++) {
      // The spore is applied on the FIRST step only; after that the reaction
      // carries it. Radius in texels, measured against the grid height.
      if (i === 0 && this._plant) {
        u.uPoint.value.set(this._plant.x, this._plant.y, Math.max(1, this._plant.r * this._h));
        this._plant = null;
      } else {
        u.uPoint.value.z = 0;
      }
      u.uState.value = this._state[this._cur].texture;
      this._blit(this._stepMat, this._state[this._cur ^ 1]);
      this._cur ^= 1;
    }

    // Remember this frame's seed for next frame's arrival test.
    if (o.seedTex) {
      if (!this._seedPrev) this._seedPrev = this._makeTarget(false);
      if (this._seedPrev.width !== this._w || this._seedPrev.height !== this._h) this._seedPrev.setSize(this._w, this._h);
      this._copyMat.uniforms.uTexture.value = o.seedTex;
      this._blit(this._copyMat, this._seedPrev);
    }

    const v = this._viewMat.uniforms;
    v.uState.value    = this._state[this._cur].texture;
    v.uHue.value      = o.hue / 360;
    v.uSat.value      = o.sat;
    v.uSpread.value   = o.spread;
    v.uColonies.value = o.colonies ?? 0;
    v.uContrast.value = o.contrast;
    v.uMode.value     = mode;
    v.uNow.value      = this._clock;
    v.uGrowTime.value = o.growTime ?? 0;
    v.uFadeTime.value = o.fadeTime ?? 3;
    v.uPenRate.value  = o.penRate ?? 0;
    // Details: first half = line strength (outlines; Frost rings), second
    // half = the fill fading until only line art remains.
    const det = (o.details ?? 0) / 100;
    v.uRings.value    = Math.min(1, det * 2);
    v.uRingGap.value  = Math.max(0.05, o.crRingGap ?? 0.5);
    v.uLines.value    = Math.min(1, det * 2);
    v.uFill.value     = 1 - Math.max(0, det * 2 - 1);
    // Relief 0–100 → normal depth 0–24 against a per-texel gradient (a
    // full-range rise over 2 texels then tilts the normal ~85°). Light: azimuth from Light angle (0° = from
    // the right, 90° = from above, screen y up), fixed 40° elevation.
    v.uTexel.value.set(1 / this._w, 1 / this._h);
    v.uRelief.value = ((o.relief ?? 0) / 100) * 24;
    v.uBevel.value  = Math.max(1, o.bevel ?? 2);
    const az = ((o.lightAngle ?? 135) * Math.PI) / 180, el = (40 * Math.PI) / 180;
    v.uLight.value.set(Math.cos(az) * Math.cos(el), Math.sin(az) * Math.cos(el), Math.sin(el));
    v.uGloss.value  = (o.gloss ?? 0) / 100;
    v.uGround.value = (o.ground ?? 0) / 100;
    // Nested draws at output resolution: the state goes through a smoothed
    // copy (HalfFloat + Linear, as the B-spline needs filtered taps and the
    // float state is Nearest) up to view size (GROWTH_UPSAMPLE), and the view
    // reads THAT as its state. The other engines draw at grid size.
    // uTexel stays one GRID texel, so Relief and Details keep their widths.
    let vw = this._w, vh = this._h;
    if (mode === MODE_MULTISCALE) {
      const k = Math.max(1, Math.min(2048, o.viewRes ?? 0) / Math.max(this._w, this._h));
      vw = Math.round(this._w * k);
      vh = Math.round(this._h * k);
      const half = (w, h) => new THREE.WebGLRenderTarget(w, h, {
        minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
        format: THREE.RGBAFormat, type: THREE.HalfFloatType,
        depthBuffer: false, stencilBuffer: false,
      });
      this._smooth ??= half(this._w, this._h);
      this._up     ??= half(vw, vh);
      this._smooth.setSize(this._w, this._h);
      this._up.setSize(vw, vh);
      this._copyMat.uniforms.uTexture.value = this._state[this._cur].texture;
      this._blit(this._copyMat, this._smooth);
      this._upMat.uniforms.uSrc.value = this._smooth.texture;
      this._upMat.uniforms.uGrid.value.set(this._w, this._h);
      this._blit(this._upMat, this._up);
      v.uState.value = this._up.texture;
    }
    // Curves draws its threads at output resolution already: the view reads
    // that target 1:1, and a texel is one of ITS pixels (Details lines stay
    // one pixel wide on screen).
    if (mode === MODE_CURVES && this._curves?.texture) {
      vw = this._curves.width;
      vh = this._curves.height;
      v.uState.value = this._curves.texture;
      v.uTexel.value.set(1 / vw, 1 / vh);
    }
    this._view.setSize(vw, vh);
    this._blit(this._viewMat, this._view);

    this.renderer.setRenderTarget(prevTarget);
  }

  // Null before the first copy: it samples black, so every seed reads as
  // arriving — which on the first frame it has.
  _seedPrevTex() { return this._seedPrev ? this._seedPrev.texture : null; }

  /** n hyphae steps. Variation sets how much threads bend. */
  _stepHyphae(n, o, ageDt, now) {
    const u = this._hyMat.uniforms;
    u.uTexel.value.set(1 / this._w, 1 / this._h);
    u.uNow.value      = now;
    u.uAgeDt.value    = ageDt;
    u.uWander.value   = 0.4 + 2.6 * ((o.variation ?? 0) / 100);
    u.uBranch.value   = (o.hyBranch ?? 30) / 100;
    u.uSeed.value     = o.seedTex;
    u.uSeedAmt.value  = o.seedTex ? o.seedAmt : 0;
    u.uSeedPrev.value = this._seedPrevTex();
    u.uGrowTime.value = o.growTime ?? 0;
    u.uFadeTime.value = o.fadeTime ?? 3;
    u.uPenRate.value  = o.penRate ?? 0;
    // The flow field is always on for hyphae — it is what makes neighbouring
    // threads run together — so it does not wait for Variation.
    u.uVar.value = 1;
    for (let i = 0; i < n; i++) {
      if (i === 0 && this._plant) {
        u.uPoint.value.set(this._plant.x, this._plant.y, Math.max(1, this._plant.r * this._h));
        this._plant = null;
      } else {
        u.uPoint.value.z = 0;
      }
      u.uSeedRand.value = Math.random() * 1000;
      u.uState.value = this._state[this._cur].texture;
      this._blit(this._hyMat, this._state[this._cur ^ 1]);
      this._cur ^= 1;
    }
  }

  /** n crystal steps: ε terms into the aux target, then the phase/heat step. */
  _stepCrystal(n, o, ageDt, now) {
    const a = this._crAuxMat.uniforms;
    const u = this._crMat.uniforms;
    a.uTexel.value.set(1 / this._w, 1 / this._h);
    a.uAniso.value = o.crAniso ?? 0.04;
    a.uFold.value  = o.crFold ?? 6;
    a.uAngle.value = ((o.crAngle ?? 0) * Math.PI) / 180;
    // Size in Frost = grid spacing: features are ~1/DX pixels, so a bigger
    // Size (o.diff, 0–1 here) is a smaller DX — 0.045 at 0 down to the 0.02
    // floor near 1, below which the heat equation's explicit step
    // (dt 1e-4 / dx²) goes unstable.
    const dx = Math.min(0.05, Math.max(0.02, 0.045 * Math.pow(0.5, 1.2 * (o.diff ?? 0.37))));
    a.uDX.value = dx;
    this._crMat.uniforms.uDX.value = dx;
    u.uTexel.value.set(1 / this._w, 1 / this._h);
    u.uAux.value      = this._aux.texture;
    u.uSeedPrev.value = this._seedPrevTex();
    u.uHeat.value     = o.crHeat ?? 1.6;
    u.uNoise.value    = o.crNoise ?? 0.01;
    u.uSeed.value     = o.seedTex;
    u.uSeedAmt.value  = o.seedTex ? o.seedAmt : 0;
    u.uField.value    = o.fieldTex;
    u.uFieldAmt.value = o.fieldTex ? o.fieldAmt : 0;
    u.uNow.value      = now;
    u.uAgeDt.value    = ageDt;
    u.uGrowTime.value = o.growTime ?? 0;
    u.uFadeTime.value = o.fadeTime ?? 3;
    u.uPenRate.value  = o.penRate ?? 0;
    for (let i = 0; i < n; i++) {
      a.uState.value = this._state[this._cur].texture;
      this._blit(this._crAuxMat, this._aux);
      if (i === 0 && this._plant) {
        u.uPoint.value.set(this._plant.x, this._plant.y, Math.max(1, this._plant.r * this._h));
        this._plant = null;
      } else {
        u.uPoint.value.z = 0;
      }
      u.uSeedRand.value = Math.random() * 1000;
      u.uState.value = this._state[this._cur].texture;
      this._blit(this._crMat, this._state[this._cur ^ 1]);
      this._cur ^= 1;
    }
  }

  /** n multi-scale steps: rebuild the pyramid from the state, then step. */
  _stepMultiScale(n, o) {
    const d = this._downMat.uniforms;
    const u = this._msMat.uniforms;
    u.uTexel.value.set(1 / this._w, 1 / this._h);
    u.uStep.value     = o.msStep ?? 1;
    u.uFine.value     = Math.min(o.msFine ?? 1, o.msCoarse ?? 5) - 1;
    u.uCoarse.value   = Math.max(o.msFine ?? 1, o.msCoarse ?? 5) - 1;
    u.uBias.value     = o.msBias ?? 0;
    u.uField.value    = o.fieldTex;
    u.uFieldAmt.value = o.fieldTex ? o.fieldAmt : 0;
    u.uSeed.value     = o.seedTex;
    u.uSeedAmt.value  = o.seedTex ? o.seedAmt : 0;
    for (let l = 0; l < MS_LEVELS; l++) {
      u[`uL${l + 1}`].value = this._pyr[l].texture;
      u[`uS${l + 1}`].value.set(this._pyr[l].width, this._pyr[l].height);
    }

    for (let i = 0; i < n; i++) {
      let src = this._state[this._cur];
      for (let l = 0; l < MS_LEVELS; l++) {
        d.uSrc.value = src.texture;
        d.uSrcTexel.value.set(1 / src.width, 1 / src.height);
        d.uOff.value = l === 0 ? 0.5 : 1.0;   // level 1 reads the NEAREST-filtered state
        this._blit(this._downMat, this._pyr[l]);
        src = this._pyr[l];
      }
      if (i === 0 && this._plant) {
        u.uPoint.value.set(this._plant.x, this._plant.y, Math.max(1, this._plant.r * this._h));
        this._plant = null;
      } else {
        u.uPoint.value.z = 0;
      }
      u.uState.value = this._state[this._cur].texture;
      this._blit(this._msMat, this._state[this._cur ^ 1]);
      this._cur ^= 1;
    }
  }

  /**
   * The coloured view. ONE target, updated in place, so a texture handed out
   * before render() this frame (the inputs bag) still shows this frame's growth.
   * Null until the first render — callers fall back explicitly.
   */
  get texture() { return this._view ? this._view.texture : null; }

  dispose() {
    for (const t of [...(this._state ?? []), ...(this._view ? [this._view] : []), ...(this._pyr ?? [])]) t.dispose();
    this._downMat.dispose();
    this._msMat.dispose();
    this._aux?.dispose();
    this._seedPrev?.dispose();
    this._smooth?.dispose();
    this._up?.dispose();
    this._curves?.dispose();
    this._upMat.dispose();
    this._copyMat.dispose();
    this._crAuxMat.dispose();
    this._hyMat.dispose();
    this._crMat.dispose();
    this._geom.dispose();
    this._stepMat.dispose();
    this._viewMat.dispose();
    this._initMat.dispose();
  }
}
