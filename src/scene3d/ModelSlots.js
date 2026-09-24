/**
 * ModelSlots — extra imported models (slots 2–4) in the 3D scene.
 *
 * Slot 1 is SceneManager's own object (`sm.mesh`): geometry or an imported
 * model, driven by scene3d.* — the cloner, Hypercube adoption and material
 * swaps all assume it, so it stays exactly as it was. These slots are
 * additional pivots in the same scene, each driven by its own model2/3/4.*
 * params (show, position, rotation, spin, scale).
 *
 * They share the main material (sm.material), so Material, texture source and
 * mapping apply to every model. _rebuildMaterial() only re-points sm.mesh, so
 * apply() re-points the slots whenever sm.material has been replaced.
 *
 * Rendering needs nothing extra: the colour, depth and normal passes all draw
 * the whole scene.
 *
 * Wire (Main / Solid / Wire) without a second material: each slot mesh flips
 * `wireframe` on whatever material it is drawn with in onBeforeRender and
 * puts it back in onAfterRender. three.js reads the flag at draw time and it
 * is not part of the program key, so there is no recompile — and a cloned
 * material would lose the shared one's live texture and mapping uniforms.
 *
 * Animation: a mixer per slot on the model's clips. Skinned meshes were
 * flattened by _prepareGLTFScene (ANGLE/Metal bone-texture bug), so node
 * animation plays; skeletal deformation does not — as for the main slot.
 */

import * as THREE from 'three';

export const SLOT_PREFIXES = ['model2', 'model3', 'model4'];

/**
 * Anchor = Follow body: keep the animated body on the rotation point.
 *
 * What it tracks: for a rigged model, the bone nearest the rotation point
 * among the bones the clip actually MOVES — found the first time it is
 * needed by playing the clip through on a scratch mixer (pickAnchorBone).
 * Nearest alone picked Poser's BODY, which the clip animates with constant
 * values, so following it did nothing; among moving bones it lands on the
 * pelvis. Unrigged: the centre of the mesh box.
 *
 * Each frame the model is shifted inside its pivot so the tracked point stays
 * where it was at import: walks happen on the spot, steps and gestures
 * intact. Call after the mixer has updated; `follow` false restores the
 * model's own position.
 */
const _v = new THREE.Vector3(), _box = new THREE.Box3();
export function applyAnchor(pivot, follow, clip) {
  const ud = pivot.userData;
  const model = ud.model;
  if (!model || !ud.anchorBase) return;
  if (!follow) {
    if (ud.anchorOn) { model.position.copy(ud.anchorBase); ud.anchorOn = false; }
    return;
  }
  if (ud.bones?.length && clip && ud.anchorClip !== clip) {
    ud.anchorClip = clip;
    ud.anchorBone = pickAnchorBone(pivot, clip);
  }
  ud.anchorOn = true;
  pivot.updateMatrixWorld(true);
  let rest;
  if (ud.anchorBone) {
    ud.anchorBone.getWorldPosition(_v);
    rest = ud.boneRest.get(ud.anchorBone);
  } else {
    _box.setFromObject(model).getCenter(_v);
    rest = ud.anchorRest;
  }
  pivot.worldToLocal(_v);
  // _v includes the shift applied last frame; take it back out, then shift
  // by how far the tracked point has moved from where it was at import.
  _v.sub(model.position).add(ud.anchorBase);
  model.position.copy(ud.anchorBase).sub(_v.sub(rest));
}

// The moving bone nearest the rotation point. Samples the clip on a scratch
// mixer and puts every bone back afterwards — the real mixer overwrites them
// on its next update anyway, but a paused model must not be left posed.
function pickAnchorBone(pivot, clip) {
  const { bones, boneRest, model } = pivot.userData;
  const saved = bones.map(b => [b.position.clone(), b.quaternion.clone(), b.scale.clone()]);
  const shift = model.position.clone();
  model.position.copy(pivot.userData.anchorBase);
  const mixer = new THREE.AnimationMixer(model);
  mixer.clipAction(clip).play();
  const moved = new Map(bones.map(b => [b, 0]));
  const N = 8;
  for (let k = 0; k <= N; k++) {
    mixer.setTime(clip.duration * k / N);
    pivot.updateMatrixWorld(true);
    for (const b of bones) {
      pivot.worldToLocal(b.getWorldPosition(_v));
      moved.set(b, Math.max(moved.get(b), _v.distanceTo(boneRest.get(b))));
    }
  }
  mixer.stopAllAction();
  mixer.uncacheRoot(model);
  bones.forEach((b, i) => { b.position.copy(saved[i][0]); b.quaternion.copy(saved[i][1]); b.scale.copy(saved[i][2]); });
  model.position.copy(shift);

  const scale = Math.max(...bones.map(b => boneRest.get(b).length()), 1e-6);
  let best = null, bestD = Infinity;
  for (const b of bones) {
    if (moved.get(b) < scale * 1e-3) continue;      // the clip leaves it where it is
    const d = boneRest.get(b).length();
    if (d < bestD) { bestD = d; best = b; }
  }
  return best;
}

/**
 * Plays one clip inside Anim Start / End — shared by the main object
 * (SceneManager) and the slots.
 *
 * The player sets each action's time itself and calls mixer.update(0), so the
 * pose drawn is always the one at the time it chose (three advancing the time
 * and a clamp pulling it back afterwards drew one frame outside the range).
 *
 * Loop mode, over the range [s, e]:
 *   Loop       wrap from e back to s (either direction with negative speed)
 *   Ping-pong  forward, then backward — never jumps
 *   Sine       ping-pong eased by a cosine: slows to rest at both ends, so the
 *              turn has no jolt. Same period as Ping-pong.
 *
 * Morph: when a new range would make the playhead JUMP — it is outside the
 * new range — the old loop keeps playing in its own range while the new one
 * starts at its Start and fades in over `morph` seconds (weights linear,
 * summing to 1, so the pose never sags toward the rest pose mid-blend). A
 * change that keeps the playhead inside the range (dragging End, say) just
 * retargets: nothing would jump, so there is nothing to blend. Up to
 * MAX_LANES loops blend at once; each extra one plays a twin clip that shares
 * the original's tracks (the mixer keeps one action per clip).
 *
 * Seam (Loop mode): the last `seam` seconds of the range blend into its
 * first `seam` seconds, as an audio loop crossfades its splice, so the wrap
 * never jumps whatever the take's end pose. The start region is heard only
 * inside the blend, so one cycle is (length − seam) long, and playback
 * enters at s + seam. Seam is capped at a third of the length, so at least
 * half of each cycle plays unblended (at half, the loop would blend
 * throughout). Blending needs a second action per lane — its `twin`,
 * from the same pool (MAX_ACTIONS); with none free the wrap is hard.
 *
 * Length (s, 0 = off) replaces End: the range is [Start, Start + Length],
 * held inside the clip. A range that moves without changing length keeps the
 * loop's PHASE, so sliding Start scrubs the window like an audio loop's start
 * point; a shift of more than SLIDE in one frame (a controller, a Segment
 * pick) is a jump and blends with Morph instead.
 */
export const LOOP_MODES = ['Loop', 'Ping-pong', 'Sine'];
const MAX_LANES = 4;
const MAX_ACTIONS = 8;     // lanes + their seam twins
const SLIDE = 0.1;         // s — a per-frame shift above this is a jump
const mod = (a, n) => ((a % n) + n) % n;

// Where lane l plays: main time t, and — inside a seam blend — the twin's
// time t2 and its share k (0..1).
function place(l) {
  const len = Math.max(l.e - l.s, 1e-3);
  if (l.mode === 0) {
    const sm = Math.min(l.seam, len / 3);
    if (!(sm > 0)) return { t: l.s + mod(l.u, len), k: 0 };
    const P = len - sm, x = mod(l.u, P), t = l.s + sm + x;
    if (x <= P - sm) return { t, k: 0 };
    const k = (x - (P - sm)) / sm;
    return { t, k, t2: l.s + k * sm };
  }
  const x = mod(l.u, 2 * len);
  if (l.mode === 1) return { t: l.s + (x <= len ? x : 2 * len - x), k: 0 };
  return { t: l.s + len * (1 - Math.cos(Math.PI * x / len)) / 2, k: 0 };
}

// The phase u that puts lane l at time t in `mode` / `seam` over [s, e],
// keeping the direction it was travelling in.
function phaseOf(l, t, s, e, mode, seam) {
  const len = Math.max(e - s, 1e-3), y = Math.min(Math.max(t - s, 0), len);
  const oldLen = Math.max(l.e - l.s, 1e-3);
  const fwd = l.mode === 0 || mod(l.u, 2 * oldLen) <= oldLen;
  if (mode === 0) {
    const sm = Math.min(seam, len / 3);
    return sm > 0 ? Math.min(Math.max(y - sm, 0), len - sm - 1e-6) : y;
  }
  const a = mode === 1 ? y : len * Math.acos(Math.min(1, Math.max(-1, 1 - 2 * y / len))) / Math.PI;
  return fwd ? a : 2 * len - a;
}

export class RangePlayer {
  constructor(mixer) {
    this.mixer = mixer;
    this.clip = null;
    this.pool = [];        // actions for this clip: the original + twin clips
    this.lanes = [];       // { action, twin, s, e, mode, seam, u, w, w0 }
    this.cur = null;       // the lane fading in / playing
    this.fade = 1;         // 0→1 progress of the current morph
  }

  /** Where the playing loop is, in clip seconds (null when stopped) — for the timeline strip. */
  get time() { return this.cur ? place(this.cur).t : null; }

  stop() {
    for (const a of this.pool) a.stop();
    for (const l of this.lanes) l.twin = null;
    this.lanes = []; this.cur = null; this.clip = null;
  }

  /**
   * @param dt      real seconds since last frame (the morph runs on these)
   * @param speed   Anim Speed (playback runs on dt × speed)
   * @param action  the clip's action from the mixer
   * @param seam    s of wrap blend in Loop mode (0 = hard wrap)
   * @param lenSec  s; > 0 replaces End with Start + lenSec
   */
  update(dt, speed, action, startPct, endPct, mode, morph, seam = 0, lenSec = 0) {
    const clip = action.getClip(), d = clip.duration;
    if (!(d > 0)) return;
    let s, e;
    if (lenSec > 0) {
      const len = Math.min(lenSec, d);
      s = Math.min(startPct / 100 * d, d - len);
      e = s + len;
    } else {
      s = Math.min(startPct, endPct) / 100 * d;
      e = Math.max(startPct, endPct) / 100 * d;
    }
    if (clip !== this.clip) {
      this.stop();
      this.clip = clip;
      this.pool = [action];
      this.cur = this._lane(action, s, e, mode, seam);
      this.lanes = [this.cur];
      this.fade = 1;
    }
    const cur = this.cur;
    if (cur.s !== s || cur.e !== e || cur.mode !== mode || cur.seam !== seam) {
      const shift = Math.abs((e - s) - (cur.e - cur.s)) < 1e-6 && mode === cur.mode && seam === cur.seam;
      const t = place(cur).t;
      const inside = t >= s && t <= e;
      if (shift && (Math.abs(s - cur.s) <= SLIDE || !(morph > 0))) {
        cur.s = s; cur.e = e;                        // same loop, moved: keep its phase
      } else if (!shift && (inside || !(morph > 0))) {
        cur.u = inside ? phaseOf(cur, t, s, e, mode, seam) : 0;
        cur.s = s; cur.e = e; cur.mode = mode; cur.seam = seam;
      } else {
        this._switch(s, e, mode, seam, shift ? cur.u : 0);
      }
    }

    if (this.lanes.length > 1) {
      this.fade = morph > 0 ? Math.min(1, this.fade + dt / morph) : 1;
      if (this.fade >= 1) {
        for (const l of this.lanes) if (l !== this.cur) this._drop(l);
        this.lanes = [this.cur];
      }
    }
    for (const l of this.lanes) {
      l.w = l === this.cur ? (this.lanes.length > 1 ? this.fade : 1) : l.w0 * (1 - this.fade);
      l.u += dt * speed;
      const needTwin = l.mode === 0 && l.seam > 0;
      if (needTwin && !l.twin) { l.twin = this._acquire(); l.twin?.reset().play(); }
      if (!needTwin && l.twin) { l.twin.stop(); l.twin = null; }
      const at = place(l);
      const k = l.twin ? at.k : 0;
      l.action.time = at.t;
      l.action.setEffectiveWeight(l.w * (1 - k));
      if (l.twin) {
        l.twin.time = at.t2 ?? l.s;
        l.twin.setEffectiveWeight(l.w * k);
      }
    }
    this.mixer.update(0);
  }

  _lane(action, s, e, mode, seam, u = 0) {
    action.reset().play();
    return { action, twin: null, s, e, mode, seam, u, w: 1, w0: 1 };
  }

  _drop(l) {
    l.action.stop();
    l.twin?.stop();
    l.twin = null;
  }

  // An action of this clip no lane is using, or null when all MAX_ACTIONS are.
  _acquire() {
    const used = new Set(this.lanes.flatMap(l => [l.action, l.twin]));
    let a = this.pool.find(x => !used.has(x));
    if (!a && this.pool.length < MAX_ACTIONS) {
      const c = this.clip;
      a = this.mixer.clipAction(new THREE.AnimationClip(c.name, c.duration, c.tracks));
      this.pool.push(a);
    }
    return a ?? null;
  }

  _switch(s, e, mode, seam, u) {
    let a = this.lanes.length < MAX_LANES ? this._acquire() : null;
    if (!a) {                                  // no room: drop the faintest
      const out = this.lanes.filter(l => l !== this.cur).reduce((m, l) => l.w < m.w ? l : m);
      this._drop(out);
      this.lanes = this.lanes.filter(l => l !== out);
      a = out.action;
    }
    // Outgoing weights, renormalised: a dropped lane's share would otherwise
    // be lost and the blend would sag toward the rest pose.
    const sum = this.lanes.reduce((t, l) => t + l.w, 0) || 1;
    for (const l of this.lanes) l.w0 = l.w / sum;
    this.cur = this._lane(a, s, e, mode, seam, u);
    this.cur.w = 0;
    this.lanes.push(this.cur);
    this.fade = 0;
  }
}

export class ModelSlots {
  /** @param {import('./SceneManager.js').SceneManager} sm */
  constructor(sm) {
    this.sm = sm;
    // Per slot: { name, pivot, mat } or null
    this.slots = SLOT_PREFIXES.map(() => null);
    // Load token per slot — a slow load that a newer one has overtaken is
    // dropped instead of replacing the newer model when it finally resolves.
    this._tok = SLOT_PREFIXES.map(() => 0);
    this._lastRot = SLOT_PREFIXES.map(() => null);
    // Name a recalled state asked for but this browser does not hold — shown
    // in the panel so an empty slot explains itself.
    this.missing = SLOT_PREFIXES.map(() => null);
  }

  /** Model name per slot (null = empty) — what a state records. */
  names() { return this.slots.map(s => s?.name ?? null); }

  /**
   * Load a model into slot i (0-based: 0 = Model 2).
   * @param {File|string} src  File or bundled URL
   * @param {File[]} [extraFiles]
   * @returns {Promise<boolean>} false if a newer load overtook this one
   */
  async load(i, src, extraFiles = []) {
    const tok = ++this._tok[i];
    const pivot = await this.sm.parseModel(src, extraFiles);
    if (tok !== this._tok[i]) return false;
    this._remove(i);
    this.sm.scene.add(pivot);
    const clips = pivot.userData.clips ?? [];
    const slot = {
      name: typeof src === 'string' ? src : src.name, pivot, mat: this.sm.material,
      wire: 0,                       // 0 Main, 1 Solid, 2 Wire — set in apply()
      clips, mixer: clips.length ? new THREE.AnimationMixer(pivot.userData.model) : null,
      actions: [], cur: -1,
    };
    if (slot.mixer) {
      slot.actions = clips.map(c => slot.mixer.clipAction(c));
      slot.range = new RangePlayer(slot.mixer);
    }
    pivot.traverse(c => {
      if (!c.isMesh) return;
      c.onBeforeRender = (r, sc, cam, geo, mat) => {
        if (slot.wire === 0) return;
        c.userData._wirePrev = mat.wireframe;
        mat.wireframe = slot.wire === 2;
      };
      c.onAfterRender = (r, sc, cam, geo, mat) => {
        if (c.userData._wirePrev === undefined) return;
        mat.wireframe = c.userData._wirePrev;
        c.userData._wirePrev = undefined;
      };
    });
    this.slots[i] = slot;
    this.missing[i] = null;
    this._lastRot[i] = null;
    return true;
  }

  clear(i) {
    ++this._tok[i];            // also cancels a load in flight
    this._remove(i);
    this.missing[i] = null;
  }

  _remove(i) {
    const s = this.slots[i];
    if (!s) return;
    this.sm.scene.remove(s.pivot);
    s.mixer?.stopAllAction();
    // Geometry and the model's own textures belong to this slot alone; the
    // material is shared with the main object, so it is left alone.
    s.pivot.traverse(c => { if (c.isMesh) c.geometry?.dispose(); });
    this.slots[i] = null;
  }

  /** Per frame: visibility, transform, shared-material sync. */
  apply(ps, dt) {
    const toRad = Math.PI / 180;
    SLOT_PREFIXES.forEach((pre, i) => {
      const s = this.slots[i];
      if (!s) return;
      const v = (k) => ps.get(`${pre}.${k}`).value;
      const p = s.pivot;
      p.visible = !!v('visible');
      if (!p.visible) return;

      if (s.mat !== this.sm.material) {
        p.traverse(c => { if (c.isMesh) c.material = this.sm.material; });
        s.mat = this.sm.material;
      }

      // Same rule as the main object: spin accumulates, and a CHANGE to any
      // rotation value re-bases the orientation from there.
      const rx = v('rot.x'), ry = v('rot.y'), rz = v('rot.z');
      const sx = v('spin.x'), sy = v('spin.y'), sz = v('spin.z');
      const lr = this._lastRot[i];
      if (sx || sy || sz) {
        if (!lr || lr.x !== rx || lr.y !== ry || lr.z !== rz) p.rotation.set(rx * toRad, ry * toRad, rz * toRad);
        p.rotation.x += sx * toRad * dt;
        p.rotation.y += sy * toRad * dt;
        p.rotation.z += sz * toRad * dt;
      } else {
        p.rotation.set(rx * toRad, ry * toRad, rz * toRad);
      }
      this._lastRot[i] = { x: rx, y: ry, z: rz };

      p.position.set(v('pos.x'), v('pos.y'), v('pos.z'));
      // Normalize (default 2 = the main object's default Normalization), so a
      // slot at Scale 1 comes in the same size as a model imported into M1.
      p.scale.setScalar(v('scale') * v('norm') * (p.userData.baseScale ?? 1));

      s.wire = v('wire');

      if (s.mixer) {
        const ci = Math.min(Math.round(v('clip')) - 1, s.actions.length - 1);
        if (v('anim') && s.actions[ci]) {
          s.cur = ci;
          s.range.update(dt, v('animSpeed'), s.actions[ci], v('animStart'), v('animEnd'), v('animLoop'), v('animMorph'), v('animSeam'), v('animLen'));
        } else if (s.cur !== -1) {
          s.range.stop();
          s.cur = -1;
        }
      }
      applyAnchor(p, v('anchor') === 1, s.actions[s.cur]?.getClip() ?? s.clips[0]);
    });
  }

  /** Clip count and the name of the clip Clip currently points at. */
  clipInfo(i, ps) {
    const s = this.slots[i];
    if (!s?.clips.length) return null;
    const n = s.clips.length;
    const ci = Math.min(Math.round(ps.get(`${SLOT_PREFIXES[i]}.clip`).value), n);
    const d = s.clips[ci - 1]?.duration ?? 0;
    return { n, index: ci, name: s.clips[ci - 1]?.name || `Anim ${ci}`, duration: d };
  }
}
