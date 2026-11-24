/**
 * CreatureObject — a procedural creature as an object in the 3D scene.
 *
 * The creature itself (bones, skin, fur, springs, the walk through its
 * movement library) is tools/creature/engine.js — the SAME file the creature
 * test page runs (tools/creature/creature.html), so what is judged there is
 * what plays here. This file is only ImWeb's side of it: loading an animal's
 * two files when it is first asked for, placing it in the scene, following the
 * creature.* params, and the things a scene object owes this renderer — its
 * output encoding, its bounds, its own depth pass, and not freezing the
 * picture while its shaders compile.
 *
 * AT REST NOTHING OF THIS EXISTS. SceneManager imports this module the first
 * time creature.active is seen on (as it does the Hypercube), and an animal's
 * definition and view are fetched the first time that animal is chosen.
 *
 * The creature files stay in tools/creature/ — one home, edited there by the
 * sessions that build the animals and checked there by seam-check.mjs.
 */

import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { createCreature } from '../../tools/creature/engine.js';
import { VIEW_FOV } from '../../tools/creature/core.js';
import { CREATURE_KINDS, CREATURE_ADVANCE, CREATURE_SKINS } from './CreatureParams.js';
import { getCreatureCustom, applyCreatureFile, onCreatureCustomChange } from './CreatureCustom.js';

/**
 * Output encoding. ImWeb draws the 3D scene into a render target, and three.js
 * writes LINEAR light into a target (the sRGB curve is applied only when it
 * draws to the screen). The creature page draws to the screen, so every skin
 * colour was chosen, and approved, with that curve on: without it here the
 * same creature comes out much darker — a mid grey of 0.5 lands at 0.21.
 * So each creature material applies the curve itself, as its last step.
 * Raw ShaderMaterials are left alone: they write the values they mean.
 */
function encodeForTarget(m) {
  if (!m || m.isShaderMaterial || m.userData.creatureEncoded) return;
  m.userData.creatureEncoded = true;
  const base = m.onBeforeCompile, key = m.customProgramCacheKey();
  m.onBeforeCompile = (sh, renderer) => {
    base.call(m, sh, renderer);
    sh.fragmentShader = sh.fragmentShader.replace('#include <colorspace_fragment>',
      '#include <colorspace_fragment>\n\tgl_FragColor = sRGBTransferOETF( gl_FragColor );');
  };
  // three.js shares compiled programs by this key; the default key is the
  // onBeforeCompile source text, which is now the same wrapper for all of them.
  m.customProgramCacheKey = () => `${key}|creature-srgb`;
}

// An empty box: Box3.setFromObject() takes an object's own boundingBox when it
// has one, and an empty one adds nothing — see _make().
const NO_BOUNDS = new THREE.Box3();
const _Y = new THREE.Vector3(0, 1, 0);

export class CreatureObject {
  /**
   * @param {import('./SceneManager.js').SceneManager} sm
   * @param {(key: string) => Promise<{def: object, view: object}>} loadFiles
   *   fetches an animal's two modules — CreatureFiles.js in the app. Passed in,
   *   not imported: that file lists the creature files with Vite's
   *   import.meta.glob, which Node does not have, and tests/audit-creature.mjs
   *   runs this class for real with a loader of its own.
   */
  constructor(sm, loadFiles) {
    this.sm = sm;
    this._loadFiles = loadFiles;
    // root sits at the Transform's position and tips the creature toward the
    // camera (face()); turn carries the Transform's rotation and scale — a
    // turntable on that tipped stage. Each animal then has a `home` of its
    // own inside turn (see _make()).
    this.root = new THREE.Group(); this.root.name = 'creature';
    this.turn = new THREE.Group(); this.root.add(this.turn);
    this.root.visible = false;
    sm.scene.add(this.root);

    this._stage = null;      // the animal on screen: { kind, c, home, fit, pitch, solid, ghost, depthMat, normalMat }
    this._kept = new Map();  // every animal built so far, by kind (see _load)
    this._loading = -1;      // CREATURE_KINDS index of the one on its way (-1: none)
    this._failed = -1;       // … of one that did not load (not retried every frame)
    this._segSeen = 0;       // creature.segment as last acted on
    this._axis = new THREE.Vector3(1, 0, 0);
    this._ps = null;
    this._env = null;        // environment for the Chrome and Glassy skins, made on first use
    // A custom creature (CreatureCustom.js) replaces the movements and colours
    // of the animal it is built on. Loading or removing one makes the kept copy
    // of that animal stale: it is let go, and tick() builds it again.
    this._offCustom = onCreatureCustomChange((now, before) => {
      for (const key of new Set([now?.base, before?.base])) {
        const kind = CREATURE_KINDS.findIndex(k => k.key === key), kept = this._kept.get(kind);
        if (kind < 0) continue;
        if (this._failed === kind) this._failed = -1;
        if (!kept) continue;
        if (this._stage === kept) { this.turn.remove(kept.home); this._stage = null; }
        this._kept.delete(kind);
        this._free(kept);
      }
    });
  }

  /** True while a creature is actually on screen (switched on AND built). */
  get shown() { return this.root.visible && !!this._stage; }
  /** The engine's creature on screen (debugging, audits). */
  get creature() { return this._stage?.c ?? null; }
  /** CREATURE_KINDS index of the animal on screen, -1 for none. */
  get kind() { return this._stage?.kind ?? -1; }

  /**
   * Once a frame, from SceneManager.applyParams, after Transform.
   * @param p      ParameterSystem
   * @param dt     seconds
   * @param mesh   the scene's own object, whose Transform the creature shares
   * @param scale  the plain Scale param (never an imported model's normalisation)
   * @param video  the texture creature.texsrc names, or null — for the Video skin
   */
  tick(p, dt, mesh, scale, video = null) {
    this._ps = p;
    if (!p.get('creature.active')?.value) {
      // Switched off: hidden, not torn down — back on is instant, and its GPU
      // memory is small beside one video frame.
      if (this.root.visible) this.root.visible = false;
      return;
    }
    const kind = Math.round(p.get('creature.kind').value);
    if (kind !== this.kind) {
      const kept = this._kept.get(kind);
      if (kept) this._show(kept);                                        // seen before: no wait, no pause
      else if (kind !== this._loading && kind !== this._failed) this._load(kind);
    }

    const st = this._stage;
    // The previous animal stays up while the next one is on its way — no empty frames.
    this.root.visible = !!st;
    if (!st) return;
    const c = st.c;

    const skin = CREATURE_SKINS[Math.round(p.get('creature.skin').value)] ?? 'soft';
    if (skin !== c.skin) c.setSkin(skin);
    c.setVideo(video);

    // While another animal is on its way, the one on screen is no longer the
    // one the params describe: creature.segment already means a movement of
    // the NEXT animal. Acting on it here sent a recalled "Cuttlefish, movement
    // 26" to the octopus still on screen, which has 21 — the engine wrapped it
    // to 5 and wrote 5 back over the recalled value. So an outgoing animal
    // takes no movement from the params and writes none: it just keeps looping.
    const current = kind === st.kind;

    // A movement nobody here set = somebody chose one (hand, MIDI, LFO, a
    // recall). Our own advance updates _segSeen as it writes the param.
    if (current) {
      const want = Math.round(p.get('creature.segment').value);
      if (want !== this._segSeen) {
        this._segSeen = want;
        if (want !== c.seg) c.jump(want);
      }
    }

    // The creature's clock. Clamped: after a hidden tab dt can be seconds, and
    // the joint springs run 240 substeps for each of them.
    const cdt = Math.min(0.1, Math.max(0, dt)) * (p.get('creature.speed')?.value ?? 1);
    c.step(cdt, {
      advance: current ? CREATURE_ADVANCE[Math.round(p.get('creature.advance')?.value ?? 1)] ?? 'next' : 'off',
      loops: Math.max(1, Math.round(p.get('creature.loops')?.value ?? 2)),
      springs: true,
    });

    // Ride the Transform the scene just gave its own object (as the Hypercube
    // instancer does with Show geometry).
    this.root.position.copy(mesh.position);
    this.turn.rotation.copy(mesh.rotation);
    this.turn.scale.setScalar(scale * (p.get('creature.scale')?.value ?? 1));
  }

  /**
   * Once a frame, from SceneManager.applyParams, after the camera is placed.
   *
   * Most creatures were framed from above — a walker's view looks 20–30° down
   * at its floor — and the 3D camera's home is level: seen from there a cobra
   * is a line on the horizon of its own ground. So the creature is tipped
   * toward the camera by the angle its view looked down, about the camera's
   * own level side-to-side axis. Tipping a thing toward you is the same
   * picture as rising above it, so from ANY Orbit the creature looks as it did
   * on its page, Elevation adds to that as it always does, and nothing else in
   * the scene — the camera, the object, the models — is touched.
   */
  face(camera, target) {
    const st = this._stage;
    if (!st) return;
    // Level and square to the line of sight. Looking straight down or up
    // there is no such axis: keep the last one.
    const fx = target.x - camera.position.x, fz = target.z - camera.position.z, n = Math.hypot(fx, fz);
    if (n > 1e-6) this._axis.set(-fz / n, 0, fx / n);
    this.root.quaternion.setFromAxisAngle(this._axis, st.pitch);
  }

  /**
   * Fetch, build, warm, THEN swap — and keep.
   *
   * A creature's skin is a big shader, and three.js compiles a shader inside
   * the first frame that draws it: that stops ImWeb's whole output, not just
   * the 3D scene. Measured 2026-11-23 on the owner's machine (Radeon Pro
   * 5500M, headless Chrome, a constant salted into every shader so no cache
   * could answer): the frame an animal first appears in took 4.3 s for the
   * cobra, 3.7–4.5 s for the cuttlefish, 2.7 s for the octopus, 1.8–2.0 s for
   * the parotia. Two things are done about it:
   *
   *  - _warm() has the driver compile in the background while the animal
   *    already on screen plays on. Same test, alternated with the above:
   *    cobra 1.5–2.0 s, cuttlefish 1.65 s, octopus 0.82–0.85 s, parotia
   *    0.78 s. What is left is the driver finishing the program at first
   *    use (three.js reads its link log then); nothing in WebGL moves that
   *    off the frame. It is paid once per animal on a machine — the driver
   *    caches the result, and later sessions measured 0.1–0.3 s.
   *
   *  - an animal once built is KEPT, off the scene graph, so going back to it
   *    — a Display State recall in mid-performance — costs nothing at all.
   *    Seven animals are a few MB of geometry and a few 1024² textures each.
   *    If heavier ones join (the jellyfish), cap this map.
   */
  async _load(kind) {
    const K = CREATURE_KINDS[kind];
    if (!K) return;
    this._loading = kind;
    let stage = null;
    try {
      let { def, view } = await this._loadFiles(K.key);
      if (!this.sm) return;
      const custom = getCreatureCustom();
      if (custom?.base === K.key) ({ def, view } = applyCreatureFile(def, view, custom));
      stage = this._make(kind, def, view);
      stage.custom = custom?.base === K.key ? custom : null;
      await this._warm(stage);
      if (!this.sm) { this._free(stage); return; }
      // Built for a custom creature that was swapped or removed while this was
      // on its way: not the animal asked for any more. Let it go; tick() asks again.
      const cuNow = getCreatureCustom();
      if (stage.custom !== (cuNow?.base === K.key ? cuNow : null)) { this._free(stage); return; }
      this._kept.set(kind, stage);
      this._failed = -1;
      // Shown only if it is still the animal asked for — not `_loading`, which
      // only says a fetch is under way: the owner may have gone back to a kept
      // animal meanwhile, and this one must not take the stage from it.
      if (this._ps && Math.round(this._ps.get('creature.kind').value) === kind) this._show(stage);
    } catch (e) {
      console.error(`[Creature] ${K.label} did not load:`, e);
      if (stage) this._free(stage);
      this._failed = kind;
    } finally {
      if (this._loading === kind) this._loading = -1;
    }
  }

  /** Put a built animal on stage. The one it replaces leaves the scene graph but is kept. */
  _show(stage) {
    if (this._stage === stage) return;
    if (this._stage) this.turn.remove(this._stage.home);
    this.turn.add(stage.home);
    this._stage = stage;
    this._segSeen = stage.c.seg;
  }

  /** Build an animal, off the scene graph, with everything a scene object owes this renderer sorted out. */
  _make(kind, def, view) {
    const K = CREATURE_KINDS[kind], ps = this._ps, sm = this.sm;
    // The menu was filled from CREATURE_KINDS before this file arrived; if the
    // two disagree the menu is showing the wrong names (tests/audit-creature.mjs
    // and tools/creature/seam-check.mjs both fail on this — say so here too).
    const names = def.SEGMENTS.map(s => s.name);
    if (!def.CUSTOM && names.join('|') !== K.moves.join('|'))
      console.warn(`[Creature] ${K.label}: the Movement menu (CreatureParams.js CREATURE_KINDS) is out of step with ${K.key}-def.js`);

    // home: the creature's own stage, and the engine's `world` — where a view
    // leaves ink, water, its ground and the like. Framed as its view was
    // framed on the creature page: turned so the side the page's camera looked
    // at faces the 3D camera's home position (+z), with the point the page
    // looked at on the Transform's own centre, and tipped toward the camera by
    // the angle that camera looked down (face()).
    const home = new THREE.Group();
    const t = new THREE.Vector3(...view.camera.target);
    const e = new THREE.Vector3(...view.camera.pos).sub(t);
    const d = e.length() || 1, az = Math.atan2(e.x, e.z);
    // Size: what the page showed top to bottom at the creature (its stage)
    // fills the 3D camera's picture top to bottom at ITS defaults, so the
    // creature is as big in the frame as it was approved. The defaults, not
    // the live values: Distance and FOV must go on working.
    const stageR = d * Math.tan(VIEW_FOV * Math.PI / 360);
    const camD = ps?.get('scene3d.cam.dist')?.defaultValue ?? 5, camF = ps?.get('scene3d.cam.fov')?.defaultValue ?? 60;
    const fit = camD * Math.tan(camF * Math.PI / 360) / stageR;
    home.rotation.set(0, -az, 0);
    home.scale.setScalar(fit);
    home.position.copy(t).applyAxisAngle(_Y, -az).multiplyScalar(-fit);

    const seg = Math.min(Math.round(ps?.get('creature.segment')?.value ?? 0), names.length - 1);
    const c = createCreature(THREE, def, view, {
      world: home, segment: seg, shadows: false,
      envMap: () => this._environment(),
      onMaterial: encodeForTarget,
    });
    const stage = { kind, c, home, fit, pitch: Math.asin(Math.max(-1, Math.min(1, e.y / d))), solid: [], ghost: [], depthMat: null, normalMat: null };
    // The engine moved on by itself (Advance), or was told to: the Movement
    // row follows. No check here for "is this still the animal the params
    // describe": tick() is the one place that decides that, and an outgoing
    // animal is neither jumped nor advanced, so it never gets here.
    c.onSegment = i => {
      this._segSeen = i;
      const p = this._ps;
      if (p && Math.round(p.get('creature.segment').value) !== i) p.set('creature.segment', i);
    };
    const sk = CREATURE_SKINS[Math.round(ps?.get('creature.skin')?.value ?? 0)] ?? 'soft';
    if (sk !== c.skin) c.setSkin(sk);      // before _warm(): the skin it will be seen in is the one to compile

    // Encoding for what the VIEW made (the engine's own materials came through onMaterial).
    const touch = o => { for (const m of [].concat(o.material || [])) encodeForTarget(m); };
    c.body.traverse(touch); c.worldAdded.forEach(o => o.traverse(touch));

    // Bounds. 3D Depth stretches its greys over the scene's bounding box
    // (SceneManager.render), from Box3.setFromObject — which, for a skinned
    // mesh with no box of its own, skins every vertex on the CPU to make one,
    // and counts hidden things (a water sheet waiting for the breach) too.
    // So: the skin gets a box from its rest pose, grown a little for the poses
    // that reach further, and everything else of the creature gets an empty
    // one and so adds nothing.
    const box = new THREE.Box3().setFromBufferAttribute(c.limbs.geometry.attributes.position);
    const ctr = box.getCenter(new THREE.Vector3()), half = box.getSize(new THREE.Vector3()).multiplyScalar(0.65);
    c.limbs.boundingBox = box.set(ctr.clone().sub(half), ctr.add(half));

    // The depth pass (see depthDraw): solid things are drawn, with the
    // stretch-aware material if they are skinned; fur, sprites and whatever
    // the view left in the world are not.
    const world = new Set(); c.worldAdded.forEach(o => o.traverse(x => world.add(x)));
    home.traverse(o => {
      if (!o.geometry) return;
      if (o !== c.limbs) o.boundingBox = NO_BOUNDS;
      if (o.isMesh && !world.has(o) && !c.furShells.includes(o)) stage.solid.push({ o, skinned: !!o.isSkinnedMesh, was: null });
      else stage.ghost.push({ o, was: true });
    });
    // Per animal, not shared: the patch binds THIS skeleton's stretch texture
    // into the material's uniforms when it compiles.
    stage.depthMat = new THREE.MeshDepthMaterial({ depthPacking: THREE.BasicDepthPacking, side: THREE.DoubleSide });
    stage.depthMat.onBeforeCompile = sh => { sm._depthMat.onBeforeCompile(sh); c.patchVertex(sh); };
    stage.depthMat.customProgramCacheKey = () => 'creature-depth';
    stage.normalMat = new THREE.MeshNormalMaterial({ side: THREE.DoubleSide });
    stage.normalMat.onBeforeCompile = sh => c.patchVertex(sh);
    stage.normalMat.customProgramCacheKey = () => 'creature-normal';
    return stage;
  }

  /**
   * Have the driver compile the animal's shaders before it is shown.
   * compileAsync builds the programs now and resolves when the driver says
   * they are linked (KHR_parallel_shader_compile; without it this resolves at
   * once and the first frame pays, as before). A program is keyed by where it
   * draws — a target gets linear output, the screen does not — so the 3D
   * scene's own target is bound while the programs are made, or they would be
   * the wrong ones and the real ones would still compile on the first frame.
   */
  async _warm(stage) {
    const r = this.sm.renderer, prev = r.getRenderTarget();
    let ready;
    r.setRenderTarget(this.sm.target);
    try { ready = r.compileAsync(stage.home, this.sm.camera, this.sm.scene); }
    finally { r.setRenderTarget(prev); }
    await ready;
  }

  /** The Chrome and Glassy skins reflect a room; built the first time one is worn. */
  _environment() {
    if (!this._env) {
      const pm = new THREE.PMREMGenerator(this.sm.renderer), room = new RoomEnvironment();
      this._env = pm.fromScene(room, 0.04).texture;
      room.dispose?.(); pm.dispose();
    }
    return this._env;
  }

  // ── Depth pass ────────────────────────────────────────────────────────────
  // The scene's depth pass draws everything with ONE override material, which
  // knows nothing of a creature's stretch and thinning (done in its vertex
  // shader): a stretched arm would come out its rest length and thickness, and
  // 3D Depth would not line up with 3D Scene. So the creature steps out of
  // that pass and draws itself into the same target, with its own depth
  // material carrying the same vertex patch as its skin.

  /** Step out of the override pass. Returns true if depthDraw() must follow. */
  depthBegin() {
    if (!this.shown) return false;
    this.root.visible = false;
    return true;
  }

  /** Draw the creature alone into the current (depth) target, over what is there. */
  depthDraw(renderer, camera, normals) {
    const sm = this.sm, st = this._stage;
    this.root.visible = true;
    for (const g of st.ghost) { g.was = g.o.visible; g.o.visible = false; }
    for (const s of st.solid) {
      s.was = s.o.material;
      s.o.material = s.skinned ? (normals ? st.normalMat : st.depthMat) : (normals ? sm._normalMat : sm._depthMat);
    }
    const autoClear = renderer.autoClear;
    renderer.autoClear = false;            // keep the scene's depth map and its depth buffer
    renderer.render(this.root, camera);    // three.js renders any Object3D as a root
    renderer.autoClear = autoClear;
    for (const s of st.solid) s.o.material = s.was;
    for (const g of st.ghost) g.o.visible = g.was;
  }

  _free(stage) {
    if (!stage) return;
    stage.c.dispose();
    stage.depthMat.dispose(); stage.normalMat.dispose();
    stage.home.parent?.remove(stage.home);
    if (this._kept.get(stage.kind) === stage) this._kept.delete(stage.kind);
    if (this._stage === stage) this._stage = null;
  }

  dispose() {
    this._offCustom?.();
    for (const st of [...this._kept.values()]) this._free(st);
    this._env?.dispose(); this._env = null;
    this.sm.scene.remove(this.root);
    this.sm = null;
  }
}
