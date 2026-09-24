/**
 * ColladaChannels — animation for COLLADA files that animate transform
 * COMPONENTS (rotateX.ANGLE, translate.X, …) instead of whole matrices.
 *
 * three.js's ColladaLoader (0.168) only builds tracks for `matrix` channels;
 * for translate / rotate / scale it logs "Animation transform type … not yet
 * implemented" and drops them. Poser exports exactly those, so a Poser .dae
 * loaded as a still pose while a 3ds Max one (matrix channels) moved.
 *
 * This reads the channels itself, grouped per node: at every key time it
 * rebuilds the node's transform list in document order — COLLADA composes a
 * node's <translate>/<rotate>/<scale>/<matrix> children left to right — with
 * the animated members substituted, and decomposes the result into position /
 * quaternion / scale tracks. Tracks are named `<uuid>.<property>`, as
 * ColladaLoader names its own, and the object is found the way ColladaLoader
 * names it: a JOINT by its sid, any other node by its name.
 *
 * Values between keys are sampled linearly. Poser keys densely (every frame),
 * so this matches its Bézier curves visually; sparse Bézier channels are
 * approximated.
 */

import * as THREE from 'three';

const TRANSFORM_TAGS = new Set(['matrix', 'translate', 'rotate', 'scale']);
const MEMBER_INDEX = { X: 0, Y: 1, Z: 2, ANGLE: 3 };

/** True when the file animates components that ColladaLoader ignores. */
export function hasComponentChannels(text) {
  return /<channel\b[^>]*target="[^"]*\/[^"/]*\.(ANGLE|X|Y|Z)"/.test(text);
}

const floats = el => el.textContent.trim().split(/\s+/).map(Number);

/**
 * Build a clip from the component channels, or null if there are none.
 * @param {string} text  the .dae source
 * @param {THREE.Object3D} root  collada.scene as ColladaLoader built it
 */
export function buildComponentClip(text, root, name = 'Animation') {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  const byId = new Map();
  for (const el of doc.querySelectorAll('[id]')) byId.set(el.getAttribute('id'), el);
  const ref = s => byId.get((s ?? '').replace(/^#/, ''));

  // channels grouped per node → sid → member → {times, values}
  const perNode = new Map();
  for (const ch of doc.getElementsByTagName('channel')) {
    const target = ch.getAttribute('target') ?? '';
    const m = target.match(/^([^/]+)\/([^.(]+)(?:\.(\w+))?$/);
    if (!m) continue;
    const [, nodeId, sid, member] = m;
    const sampler = ref(ch.getAttribute('source'));
    if (!sampler) continue;
    let times = null, values = null, stride = 1;
    for (const inp of sampler.getElementsByTagName('input')) {
      const src = ref(inp.getAttribute('source'));
      const arr = src?.getElementsByTagName('float_array')[0];
      if (!arr) continue;
      if (inp.getAttribute('semantic') === 'INPUT') times = floats(arr);
      if (inp.getAttribute('semantic') === 'OUTPUT') {
        values = floats(arr);
        stride = Number(src.getElementsByTagName('accessor')[0]?.getAttribute('stride') ?? 1);
      }
    }
    if (!times || !values) continue;
    if (!perNode.has(nodeId)) perNode.set(nodeId, new Map());
    perNode.get(nodeId).set(`${sid}.${member ?? ''}`, { sid, member, times, values, stride });
  }
  if (!perNode.size) return null;

  // Objects as ColladaLoader named them
  const byName = new Map();
  root.traverse(o => { if (o.name && !byName.has(o.name)) byName.set(o.name, o); });

  const tracks = [];
  let duration = 0;
  const M = new THREE.Matrix4(), T = new THREE.Matrix4();
  const pos = new THREE.Vector3(), quat = new THREE.Quaternion(), scl = new THREE.Vector3();
  const prevQ = new THREE.Quaternion();

  for (const [nodeId, chans] of perNode) {
    const node = byId.get(nodeId);
    if (!node) continue;
    // Skip nodes with a whole-matrix channel: ColladaLoader already did those.
    if ([...chans.values()].some(c => node.querySelector(`:scope > matrix[sid="${c.sid}"]`))) continue;
    const objName = node.getAttribute('type') === 'JOINT' ? node.getAttribute('sid') : node.getAttribute('name');
    const obj = byName.get(objName);
    if (!obj) continue;

    const transforms = [...node.children]
      .filter(c => TRANSFORM_TAGS.has(c.nodeName))
      .map(c => ({ type: c.nodeName, sid: c.getAttribute('sid'), base: floats(c) }));

    const allTimes = [...new Set([...chans.values()].flatMap(c => c.times))].sort((a, b) => a - b);
    duration = Math.max(duration, allTimes[allTimes.length - 1] ?? 0);

    const P = [], Q = [], S = [];
    let first = true;
    for (const t of allTimes) {
      M.identity();
      for (const tr of transforms) {
        const v = tr.base.slice();
        for (const c of chans.values()) {
          if (c.sid !== tr.sid) continue;
          if (c.member) {
            const k = MEMBER_INDEX[c.member];
            if (k !== undefined) v[k] = sample(c, t, 0);
          } else {
            for (let j = 0; j < c.stride; j++) v[j] = sample(c, t, j);
          }
        }
        if (tr.type === 'translate') T.makeTranslation(v[0], v[1], v[2]);
        else if (tr.type === 'rotate') T.makeRotationAxis(new THREE.Vector3(v[0], v[1], v[2]).normalize(), THREE.MathUtils.degToRad(v[3]));
        else if (tr.type === 'scale') T.makeScale(v[0], v[1], v[2]);
        else T.fromArray(v).transpose();
        M.multiply(T);
      }
      M.decompose(pos, quat, scl);
      // Keep consecutive rotations on the short arc so slerp never spins the
      // long way round between two keys.
      if (!first && prevQ.dot(quat) < 0) quat.set(-quat.x, -quat.y, -quat.z, -quat.w);
      prevQ.copy(quat);
      first = false;
      P.push(pos.x, pos.y, pos.z);
      Q.push(quat.x, quat.y, quat.z, quat.w);
      S.push(scl.x, scl.y, scl.z);
    }
    tracks.push(new THREE.VectorKeyframeTrack(`${obj.uuid}.position`, allTimes, P));
    tracks.push(new THREE.QuaternionKeyframeTrack(`${obj.uuid}.quaternion`, allTimes, Q));
    tracks.push(new THREE.VectorKeyframeTrack(`${obj.uuid}.scale`, allTimes, S));
  }
  if (!tracks.length) return null;
  return new THREE.AnimationClip(name, duration, tracks);
}

// Linear sample of channel c's component j at time t (clamped at the ends).
function sample(c, t, j) {
  const { times, values, stride } = c;
  const n = times.length;
  if (t <= times[0]) return values[j];
  if (t >= times[n - 1]) return values[(n - 1) * stride + j];
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (times[mid] <= t) lo = mid; else hi = mid; }
  const f = (t - times[lo]) / (times[hi] - times[lo]);
  return values[lo * stride + j] * (1 - f) + values[hi * stride + j] * f;
}
