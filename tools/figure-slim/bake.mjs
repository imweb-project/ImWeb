// Bake mudras (fingers) and rasas (face) into a looping figure file.
//
//   node tools/figure-slim/bake.mjs <loops.dae> <assignments.json> <out.dae>
//
// Each loop holds its mudra pair and its rasa for its whole length, a little softer at the
// join and full in the middle, so the loop still closes. Fingers and face are keyed three
// times per loop (start, middle, end) — not every frame — so the file barely grows. The
// rasa's head lift is added to the head's own motion.
import { readFileSync, writeFileSync } from 'node:fs';
import * as THREE from 'three';
import { MUDRAS, RELAXED, handQuats } from './mudras.mjs';
import { RASAS, facePose } from './rasas.mjs';

const [src, assignFile, dst] = process.argv.slice(2);
const SOFT_HAND = 0.8, SOFT_FACE = 0.6;        // how much of the pose is left at the loop's join
let text = readFileSync(src, 'utf8');
const assign = JSON.parse(readFileSync(assignFile, 'utf8')).loops;
const tk = text.match(/<imweb_takes>([^<]*)</)[1].trim().split(/\s+/).map(Number);
const takes = []; for (let i = 0; i < tk.length; i += 2) takes.push([tk[i], tk[i + 1]]);
if (assign.length !== takes.length) throw new Error(`${assign.length} assignments for ${takes.length} loops — re-make the proposal for this file`);

const D = Math.PI / 180, g = v => String(+(+v).toPrecision(7));
const nodeId = n => `Figure_1${n}_1_node`;
function nodeInfo(n) {
  const m = text.match(new RegExp(`<node id="${nodeId(n)}"[^>]*>([\\s\\S]*?)(?:<node|</node)`));
  if (!m) throw new Error('no joint ' + n);
  const order = [...m[1].matchAll(/<rotate sid="rotate([XYZ])"/g)].map(r => r[1]).join('');
  const tr = m[1].match(/<translate sid="translate">([^<]*)</);
  return { order, rest: tr ? tr[1].trim().split(/\s+/).map(Number) : [0, 0, 0] };
}

// channel store: target → [[time, value], …]
const chan = new Map();
const key = (n, sid, member, t, v) => { const k = `${nodeId(n)}/${sid}.${member}`; if (!chan.has(k)) chan.set(k, { n, sid, member, keys: [] }); chan.get(k).keys.push([t, v]); };
const near = (v, ref) => v + 360 * Math.round((ref - v) / 360);

// ── fingers ──
const NEXT = { Index1: 'Index2', Index2: 'Index3', Mid1: 'Mid2', Mid2: 'Mid3', Ring1: 'Ring2', Ring2: 'Ring3', Pinky1: 'Pinky2', Pinky2: 'Pinky3', Thumb1: 'Thumb2', Thumb2: 'Thumb3' };
const dirs = {}; for (const [a, b] of Object.entries(NEXT)) dirs[a] = new THREE.Vector3(...nodeInfo('l' + b).rest);
const dirOf = n => dirs[n] ?? dirs[n.replace('3', '2')];
const info = new Map(), last = new Map(), _e = new THREE.Euler();
const inf = n => { if (!info.has(n)) info.set(n, nodeInfo(n)); return info.get(n); };
function keyQuat(n, t, q) {
  const { order } = inf(n); _e.setFromQuaternion(q, order);
  const prev = last.get(n) ?? { X: 0, Y: 0, Z: 0 }, cur = {};
  for (const a of order) { cur[a] = near(_e[a.toLowerCase()] / D, prev[a]); key(n, 'rotate' + a, 'ANGLE', t, cur[a]); }
  last.set(n, cur);
}
takes.forEach(([s, e], i) => {
  const a = assign[i];
  for (const [side, name] of [['l', a.left], ['r', a.right]]) {
    const full = handQuats(MUDRAS[name] ?? RELAXED, side, dirOf), rest = handQuats(RELAXED, side, dirOf);
    for (const [t, w] of [[s, SOFT_HAND], [(s + e) / 2, 1], [e, SOFT_HAND]])
      for (const [bn, q] of full) keyQuat(bn, t, rest.get(bn).clone().slerp(q, w));
  }
  // ── face ──
  for (const [bn, p] of facePose(RASAS[a.rasa] ?? {})) {
    if (p.additive) continue;
    const { rest } = inf(bn), isEye = /Eye$/.test(bn);
    for (const [t, w] of [[s, SOFT_FACE], [(s + e) / 2, 1], [e, SOFT_FACE]]) {
      if (!isEye) 'XYZ'.split('').forEach((ax, k) => key(bn, 'translate', ax, t, rest[k] + p.t[k] * w));
      key(bn, 'rotateX', 'ANGLE', t, p.r[0] * w);
      if (isEye) key(bn, 'rotateY', 'ANGLE', t, p.r[1] * w);
    }
  }
});
// drop channels that never leave rest
for (const [k, c] of chan) {
  const rest = c.sid === 'translate' ? inf(c.n).rest['XYZ'.indexOf(c.member)] : 0;
  if (c.keys.every(([, v]) => Math.abs(v - rest) < 1e-7)) chan.delete(k);
}

// ── head lift, added to the head's own channels ──
const head = nodeInfo('head');
const arr = id => { const m = text.match(new RegExp(`(<float_array id="${id}"[^>]*>)([^<]*)<`)); return { m, v: m[2].trim().split(/\s+/).map(Number) }; };
const hc = {}; for (const ax of head.order) hc[ax] = arr(`Figure_1head_1${ax.toLowerCase()}rot-rotate${ax}_ANGLE-output-array`);
const times = arr(`Figure_1head_1${head.order[0].toLowerCase()}rot-rotate${head.order[0]}_ANGLE-input-array`).v;
let ti = 0; const prev = {};
times.forEach((t, k) => {
  while (ti < takes.length - 1 && t > takes[ti][1] + 1e-6) ti++;
  const [s, e] = takes[ti], lift = RASAS[assign[ti].rasa]?.head ?? 0;
  const u = Math.min(1, Math.max(0, (t - s) / (e - s))), w = SOFT_FACE + (1 - SOFT_FACE) * (1 - Math.abs(2 * u - 1));
  _e.set((hc.X?.v[k] ?? 0) * D, (hc.Y?.v[k] ?? 0) * D, (hc.Z?.v[k] ?? 0) * D, head.order);
  const q = new THREE.Quaternion().setFromEuler(_e).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -lift * w * D));
  _e.setFromQuaternion(q, head.order);
  for (const ax of head.order) { let v = _e[ax.toLowerCase()] / D; if (k) v = near(v, prev[ax]); prev[ax] = v; hc[ax].v[k] = v; }
});
for (const ax of head.order) text = text.replace(hc[ax].m[0], hc[ax].m[1] + hc[ax].v.map(g).join(' ') + '<');

// ── write the new channels ──
let xml = '';
for (const c of chan.values()) {
  const b = `Figure_1${c.n}_1-${c.sid}${c.member}`, M = c.keys.length;
  xml += `<animation id="${b}">` +
    `<source id="${b}-input"><float_array id="${b}-input-array" count="${M}">${c.keys.map(k => g(k[0])).join(' ')}</float_array><technique_common><accessor count="${M}" source="#${b}-input-array"><param name="TIME" type="float"/></accessor></technique_common></source>` +
    `<source id="${b}-output"><float_array id="${b}-output-array" count="${M}">${c.keys.map(k => g(k[1])).join(' ')}</float_array><technique_common><accessor count="${M}" source="#${b}-output-array"><param name="${c.member}" type="float"/></accessor></technique_common></source>` +
    `<source id="${b}-interpolations"><Name_array id="${b}-interpolations-array" count="${M}">${Array(M).fill('LINEAR').join(' ')}</Name_array><technique_common><accessor count="${M}" source="#${b}-interpolations-array"><param name="INTERPOLATION" type="Name"/></accessor></technique_common></source>` +
    `<sampler id="${b}-sampler"><input semantic="INPUT" source="#${b}-input"/><input semantic="OUTPUT" source="#${b}-output"/><input semantic="INTERPOLATION" source="#${b}-interpolations"/></sampler>` +
    `<channel source="#${b}-sampler" target="${nodeId(c.n)}/${c.sid}.${c.member}"/></animation>\n`;
}
text = text.replace('</library_animations>', xml + '</library_animations>');
writeFileSync(dst, text);
console.log(`${takes.length} loops, ${chan.size} new channels (${new Set([...chan.values()].map(c => c.n)).size} joints), head lift on ${assign.filter(a => RASAS[a.rasa]?.head).length} loops`);
