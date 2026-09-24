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
 * Keep an action inside [start, end] (% of its clip), wrapping in either
 * direction so a negative Anim Speed loops the range backwards. Shared with
 * the main object (SceneManager).
 */
export function clampActionRange(action, startPct, endPct) {
  const d = action.getClip().duration;
  if (!(d > 0)) return;
  let s = Math.min(startPct, endPct) / 100 * d;
  let e = Math.max(startPct, endPct) / 100 * d;
  if (s <= 0 && e >= d) return;                  // whole clip: leave looping to three
  const len = Math.max(e - s, 1e-3);
  const t = action.time;
  if (t < s || t > e) action.time = s + (((t - s) % len) + len) % len;
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
    if (slot.mixer) slot.actions = clips.map(c => slot.mixer.clipAction(c));
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
        if (v('anim')) {
          if (ci !== s.cur) {
            s.actions[s.cur]?.stop();
            s.cur = ci;
            s.actions[ci]?.reset().play();
          }
          s.mixer.update(dt * v('animSpeed'));
          if (s.actions[ci]) clampActionRange(s.actions[ci], v('animStart'), v('animEnd'));
        } else if (s.cur !== -1) {
          s.actions[s.cur]?.stop();
          s.cur = -1;
        }
      }
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
