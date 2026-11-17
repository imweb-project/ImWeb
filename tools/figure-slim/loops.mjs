// Rebuild a Poser COLLADA's long baked animation so every small animation in it
// (a "take", the stretch between two hard cuts) is a perfect loop.
//
//   node tools/figure-slim/loops.mjs <in.dae> <out.dae> [--slow=2] [--report]
//
// A take whose end already nearly meets its start keeps its motion; the small
// remaining gap is spread over the whole take so the last frame IS the first.
// A take that ends somewhere else is played there and back, eased to a stop at
// both turns. Cuts between takes stay hard, so ImWeb still finds the takes.
// Works on joint rotations as quaternions (Poser's Euler channels flip between
// equivalent triples, which is not motion) and writes Euler channels back in
// each joint's own rotation order.
import { readFileSync, writeFileSync } from 'node:fs';
import * as THREE from 'three';

const [src, dst, ...flags] = process.argv.slice(2);
const SLOW = Number(flags.find(f => f.startsWith('--slow='))?.slice(7) ?? 1);   // 2 = half speed, baked
const flag = flags.includes('--report') ? '--report' : '';
const FPS = 30, JUMP = 1.0, JUMP_RATIO = 3;      // as src/scene3d/ClipSegments.js
const CYCLIC_GAP = 0.12;      // end-to-start gap, as a share of the take's travel, that still counts as a loop
const CYCLIC_BONE = 0.9;      // rad/s — and no single joint asked to turn faster than this to close it
const CYCLIC_TURN = 40 * Math.PI / 180;   // and no joint bent further than this in all: closing a 120° gap is another movement, and it drove arms through the body
const EASE = 0.22;            // share of a there-and-back half spent easing at each turn

const text = readFileSync(src, 'utf8');
const A = text.indexOf('<library_animations'), B = text.indexOf('</library_animations>');
const lib = text.slice(A, B);

// ── channels ────────────────────────────────────────────────────────────────
const arrays = new Map();
for (const m of lib.matchAll(/<float_array id="([^"]+)"[^>]*>([^<]*)</g)) arrays.set(m[1], m[2]);
const chans = [];                       // { id, node, sid, member, values }
let times = null;
for (const m of lib.matchAll(/<animation id="([^"]+)">([\s\S]*?)<\/animation>/g)) {
  const body = m[2];
  const target = body.match(/<channel [^>]*target="([^"]+)"/)[1];
  const [, node, sid, member] = target.match(/^([^/]+)\/([^.]+)\.(\w+)$/);
  const out = body.match(/semantic="OUTPUT" source="#([^"]+)"/)[1];
  const inp = body.match(/semantic="INPUT" source="#([^"]+)"/)[1];
  const nums = k => arrays.get(k + '-array').trim().split(/\s+/).map(Number);
  times ??= nums(inp);
  chans.push({ id: m[1], base: out.replace(/-output$/, ''), node, sid, member, values: nums(out) });
}
const N = times.length;

// ── joints: rotation order from the node's own <rotate> elements ────────────
const joints = new Map();               // node → { order, rot:{X,Y,Z}, tr:{X,Y,Z} }
for (const c of chans) {
  let j = joints.get(c.node);
  if (!j) {
    const block = text.match(new RegExp(`<node id="${c.node}"[^>]*>([\\s\\S]*?)<node`))[1];
    const order = [...block.matchAll(/<rotate sid="rotate([XYZ])"/g)].map(r => r[1]).join('');
    joints.set(c.node, j = { order, rot: {}, tr: {} });
  }
  if (c.member === 'ANGLE') j.rot[c.sid.slice(-1)] = c; else j.tr[c.member] = c;
}
const D2R = Math.PI / 180;
const _e = new THREE.Euler();
for (const j of joints.values()) {
  j.q = Array.from({ length: N }, (_, k) => {
    _e.set((j.rot.X?.values[k] ?? 0) * D2R, (j.rot.Y?.values[k] ?? 0) * D2R, (j.rot.Z?.values[k] ?? 0) * D2R, j.order);
    return new THREE.Quaternion().setFromEuler(_e);
  });
  const t = ['X', 'Y', 'Z'].filter(a => j.tr[a]);
  if (t.length) {
    j.p = Array.from({ length: N }, (_, k) => new THREE.Vector3(j.tr.X?.values[k] ?? 0, j.tr.Y?.values[k] ?? 0, j.tr.Z?.values[k] ?? 0));
    const box = new THREE.Box3().setFromPoints(j.p);
    j.span = Math.max(box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z, 1e-6);
  }
}
const J = [...joints.values()];
const qAngle = (a, b) => 2 * Math.acos(Math.min(1, Math.abs(a.dot(b))));
const poseDiff = (i, k) => J.reduce((s, j) => s + qAngle(j.q[i], j.q[k]) + (j.p ? j.p[i].distanceTo(j.p[k]) / j.span : 0), 0);

// ── takes, as ClipSegments finds them ───────────────────────────────────────
const speed = Array.from({ length: N - 1 }, (_, k) => poseDiff(k, k + 1));
const jumps = [];
for (let k = 0; k < N - 1; k++) {
  if (speed[k] > JUMP && speed[k] > JUMP_RATIO * Math.max(speed[k - 1] ?? 0, speed[k + 1] ?? 0)) jumps.push(k);
}
const takes = [];
{ let a = 0; for (const k of [...jumps, N - 1]) { if (k - a >= 2) takes.push({ a, b: k }); a = k + 1; } }

// ── cycles hidden inside a take ─────────────────────────────────────────────
// A walk is the same step over and over, so some frame i and a later frame j hold the same
// pose (travelling forward aside). Such a stretch is looped as it is — it keeps walking —
// and what is left before or after it becomes a take of its own. Without this, a take that
// ends mid-stride would be played there and back, and the figure would walk backwards.
const MIN_CYCLE = 10, MIN_REST = 9, CYCLE_GAP = 0.05;
const turnDiff = (i, k) => J.reduce((s, j) => s + qAngle(j.q[i], j.q[k]) + (j.p ? Math.abs(j.p[i].y - j.p[k].y) / j.span : 0), 0);
const cum = [0]; for (let k = 0; k < N - 1; k++) cum.push(cum[k] + speed[k]);
const isNearLoop = t => { const tr = cum[t.b] - cum[t.a]; return tr < 0.02 || poseDiff(t.a, t.b) <= CYCLIC_GAP * tr; };
const pieces = [];
for (const t of takes) {
  let best = null;
  if (!isNearLoop(t)) {
    for (let i = t.a; i <= t.b - MIN_CYCLE; i++) for (let j = i + MIN_CYCLE; j <= t.b; j++) {
      const tr = cum[j] - cum[i]; if (tr < 3) continue;
      const d = turnDiff(i, j) + (j < t.b ? turnDiff(i + 1, j + 1) : turnDiff(i, j));
      if (d > 2 * CYCLE_GAP * tr) continue;
      if (!best || j - i > best.j - best.i || (j - i === best.j - best.i && d < best.d)) best = { i, j, d };
    }
  }
  if (!best) { pieces.push(t); continue; }
  if (best.i - t.a >= MIN_REST) pieces.push({ a: t.a, b: best.i, from: 'before a cycle' });
  pieces.push({ a: best.i, b: best.j, force: true });
  if (t.b - best.j >= MIN_REST) pieces.push({ a: best.j, b: t.b, from: 'after a cycle' });
}
takes.length = 0; takes.push(...pieces);

// ── the owner's edits (--edits=file), by source time so they survive renumbering ──
const editsFile = flags.find(f => f.startsWith('--edits='))?.slice(8);
const edits = editsFile ? JSON.parse(readFileSync(editsFile, 'utf8')) : {};
const at = sec => { const i = takes.findIndex(t => Math.abs(t.a / FPS - sec) < 0.02); if (i < 0) throw new Error(`no piece starts at ${sec} s`); return i; };
// The stretch of a piece that best comes back to its own start: what a walk or run is looped on.
function bestWindow(t, minLen, maxMiss) {
  let best = null; const len = t.b - t.a;
  for (let i = t.a; i <= t.b - minLen; i++) for (let j = i + minLen; j <= t.b; j++) {
    const tr = cum[j] - cum[i]; if (tr < 1) continue;
    const d = turnDiff(i, j) + (j < t.b ? turnDiff(i + 1, j + 1) : turnDiff(i, j));
    const score = d / (2 * tr) + 0.15 * (1 - (j - i) / len);
    if (!best || score < best.score) best = { i, j, score, miss: d / (2 * tr) };
  }
  return best && best.miss <= maxMiss ? best : null;
}
function forward(t, onlyIfCyclic) {
  const w = bestWindow(t, 6, onlyIfCyclic ? 0.12 : 0.3);
  if (w) return { a: w.i, b: w.j, force: true, from: 'forward only' };
  return onlyIfCyclic ? t : { ...t, force: true, from: 'forward only (no clean cycle: gap spread)' };
}
// Where a piece naturally divides: a soft cut (one frame much faster than its neighbours) or a pause.
function divide(t, into) {
  const MIN = 9, cand = [];
  const sm = k => { let s = 0, n = 0; for (let m = -2; m <= 2; m++) if (k + m >= t.a && k + m < t.b) { s += speed[k + m]; n++; } return s / n; };
  const all = []; for (let k = t.a; k < t.b; k++) all.push(speed[k]); all.sort((x, y) => x - y); const med = all[all.length >> 1] || 1e-6;
  for (let k = t.a + MIN; k < t.b - MIN; k++) {
    const nb = Math.max(speed[k - 1], speed[k + 1], 1e-6);
    if (speed[k] > 2.2 * nb && speed[k] > 0.25) cand.push({ k, cut: true, score: 10 + speed[k] / nb });
    else if (sm(k) <= sm(k - 1) && sm(k) < sm(k + 1)) cand.push({ k, cut: false, score: 1 - sm(k) / med });
  }
  cand.sort((x, y) => y.score - x.score);
  const picked = [];
  for (const c of cand) {
    if (into === 'auto' ? !(c.cut || c.score > 0.72) : picked.length >= into - 1) continue;
    if (picked.every(p => Math.abs(p.k - c.k) >= MIN)) picked.push(c);
  }
  if (into === 'auto' && !picked.length && cand.length) picked.push(cand[0]);
  picked.sort((x, y) => x.k - y.k);
  const out = []; let a = t.a;
  for (const c of picked) { out.push({ a, b: c.k, from: 'split' }); a = c.cut ? c.k + 1 : c.k; }
  out.push({ a, b: t.b, from: 'split' });
  return out;
}
for (const [s0, s1] of edits.join ?? []) { const i = at(s0), j = at(s1); takes.splice(i, j - i + 1, { a: takes[i].a, b: takes[j].b, from: `joined ${j - i + 1}` }); }
for (const sp of edits.split ?? []) {
  const i = at(sp.at); let parts = divide(takes[i], sp.into);
  if (sp.then) parts = parts.map(p => forward(p, sp.then === 'forward-if-cyclic'));
  takes.splice(i, 1, ...parts);
}
// drop: [from, to] in source seconds — frames to leave out (a burst of broken frames in the
// recording). A piece that runs into the stretch is cut short; one that contains it becomes two.
for (const [s0, s1] of edits.drop ?? []) {
  const a0 = Math.round(s0 * FPS), b0 = Math.round(s1 * FPS);
  for (let i = takes.length - 1; i >= 0; i--) { const t = takes[i]; if (t.b < a0 || t.a > b0) continue;
    const parts = []; if (a0 - 1 - t.a >= 2) parts.push({ ...t, b: a0 - 1 }); if (t.b - b0 - 1 >= 2) parts.push({ ...t, a: b0 + 1 });
    takes.splice(i, 1, ...parts); }
}
for (const sec of edits.forward ?? []) { const i = at(sec); takes[i] = forward(takes[i], false); }

// ── arms out of the body and legs (edits.collide) ───────────────────────────
// The joints as a tree, so a hand can be placed in the world: body parts are capsules between
// joints; where a hand or forearm is inside one, the shoulder turns just enough to bring it out,
// and that turn is blurred over neighbouring frames so nothing pops.
const tree = new Map();
{ const scene = text.slice(text.indexOf('<library_visual_scenes'), text.indexOf('</library_visual_scenes>')), stack = [];
  for (const m of scene.matchAll(/<node id="([^"]+)"[^>]*>|<\/node>|<(translate|rotate) sid="\w+">([^<]*)</g)) {
    if (m[1]) { tree.set(m[1], { parent: stack.at(-1) ?? null, off: new THREE.Vector3(), rot: new THREE.Quaternion() }); stack.push(m[1]); }
    else if (m[0] === '</node>') stack.pop();
    else { const n = tree.get(stack.at(-1)), v = m[3].trim().split(/\s+/).map(Number);
      if (m[2] === 'translate') n.off.add(new THREE.Vector3(v[0], v[1], v[2]));
      else n.rot.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(v[0], v[1], v[2]), v[3] * D2R)); } } }
const N_ = n => `Figure_1${n}_1_node`;
function world(k) {
  const memo = new Map();
  const get = id => { if (memo.has(id)) return memo.get(id);
    const n = tree.get(id), j = joints.get(id), par = n.parent ? get(n.parent) : { p: new THREE.Vector3(), q: new THREE.Quaternion() };
    const off = j?.p ? n.off.clone().sub(new THREE.Vector3(...(hipRest ?? [0, 0, 0]))).add(j.p[k]) : n.off;
    const w = { p: off.clone().applyQuaternion(par.q).add(par.p), q: par.q.clone().multiply(j ? j.q[k] : n.rot) };
    memo.set(id, w); return w; };
  return n => get(N_(n));
}
// the hip's animated translate replaces its static one (its "origin" offset stays)
const hipRest = (() => { const m = text.match(new RegExp(`<node id="${N_('hip')}"[^>]*>[\\s\\S]*?<translate sid="translate">([^<]*)<`)); return m ? m[1].trim().split(/\s+/).map(Number) : null; })();
// Body parts as tapered capsules [from, to, radius at from, radius at to] (1 unit = 262 cm). Sized
// to the figure rather than generously: with a fat thigh and a fat hand, hands that REST on the
// thighs of a seated figure were lifted 8 cm into the air.
const CAPS = [['hip', 'chest', 0.044, 0.046], ['chest', 'neck', 0.048, 0.040], ['lThigh', 'lShin', 0.030, 0.022], ['rThigh', 'rShin', 0.030, 0.022], ['lShin', 'lFoot', 0.020, 0.013], ['rShin', 'rFoot', 0.020, 0.013]];
// The arm as two capsules: the forearm (without the stretch by the elbow, which lies against the
// waist by nature) and the hand out to the fingertips. Whole limbs are tested against whole
// limbs — a few sample points along the arm miss the place where a forearm cuts through a thigh.
function armSegs(W, side) {
  const hand = W(side + 'Hand').p, fore = W(side + 'ForeArm').p;
  const tip = tree.has(N_(side + 'Mid3')) ? W(side + 'Mid3').p : hand.clone().add(hand.clone().sub(fore).multiplyScalar(0.55));
  return [[fore.clone().lerp(hand, 0.3), hand, 0.011], [hand, tip, 0.006]];
}
// Closest points of two segments p1→q1 and p2→q2 (Ericson, Real-Time Collision Detection 5.1.9).
function closest(p1, q1, p2, q2) {
  const d1 = q1.clone().sub(p1), d2 = q2.clone().sub(p2), r = p1.clone().sub(p2), a = d1.lengthSq(), e = d2.lengthSq(), f = d2.dot(r);
  const c = d1.dot(r), b = d1.dot(d2), den = a * e - b * b, cl = x => Math.min(1, Math.max(0, x));
  let s = den > 1e-12 ? cl((b * f - c * e) / den) : 0, t = (b * s + f) / e;
  if (t < 0) { t = 0; s = cl(-c / a); } else if (t > 1) { t = 1; s = cl((b - c) / a); }
  return { pa: p1.clone().addScaledVector(d1, s), pb: p2.clone().addScaledVector(d2, t), t };
}
const UP = new THREE.Vector3(0, 1, 0);
// Every contact of one arm: where on the arm, how far it must go, and which way (n).
function contacts(W, side, mem, record) {
  const out = [], elbow = W(side + 'ForeArm').p;
  armSegs(W, side).forEach(([a0, a1, r], ai) => CAPS.forEach(([a, b, Ra, Rb], ci) => {
    const A = W(a).p, B = W(b).p, { pa, pb, t } = closest(a0, a1, A, B), R = Ra + (Rb - Ra) * t;
    const d = pa.clone().sub(pb), dist = d.length(), axis = B.clone().sub(A).normalize(), key = ai * 8 + ci;
    if (record) { if (dist >= 0.98 * (R + r)) mem.set(key, d.clone().divideScalar(dist)); return; }
    if (R + r - dist <= 0) return;
    let n = dist > 1e-6 ? d.clone().divideScalar(dist) : new THREE.Vector3(0, 0, 1);
    // `mem` holds the side of each body part each arm part was last on while it was outside: found
    // deep inside, it is pushed back THAT way. Its nearest surface flips from frame to frame once
    // it is near the part's axis, and corrections that alternate sides cancel when smoothed.
    const m = mem?.get(key);
    if (m) { if (dist < 0.6 * (R + r) || n.dot(m) < 0) n = m; }
    else if (dist < 0.85 * (R + r)) {
      // Inside with no history (the take begins that way): the arm reaches in from its elbow.
      const e = elbow.clone().sub(pb); e.addScaledVector(axis, -e.dot(axis));
      if (e.length() > 0.3 * R) n = e.normalize();
    }
    // A thigh that lies is a lap, and a forearm belongs ON it: up and over, wherever it came in.
    // Poser lets the forearms of a seated figure cut straight through the thighs.
    if (ai === 0 && ci >= 2 && ci <= 3) {
      // Up and a little outward: the arm leaves a lap over the outer side of the thigh, to hang by the hip.
      const out = new THREE.Vector3(side === 'l' ? 0.7 : -0.7, 0, 0).applyQuaternion(W('hip').q);
      const lying = 1 - Math.min(1, Math.max(0, (Math.abs(axis.y) - 0.5) / 0.3)), up = UP.clone().add(out); up.addScaledVector(axis, -up.dot(axis));
      if (lying > 0 && up.lengthSq() > 1e-6) n = n.clone().multiplyScalar(1 - lying).addScaledVector(up.normalize(), lying).normalize();
    }
    // how far along n until it is clear of the round surface
    const dn = d.dot(n), depth = -dn + Math.sqrt(Math.max(0, dn * dn - dist * dist + (R + r) * (R + r)));
    out.push({ p: pa, depth, n, raw: R + r - dist, part: a, seg: 'FH'[ai] });
  }));
  return out;
}
const deepest = (W, side, mem) => contacts(W, side, mem).reduce((w, c) => !w || c.depth > w.depth ? c : w, null);
const remember = (W, side, mem) => { contacts(W, side, mem, true); };
const ID = new THREE.Quaternion(), EASE_OFF = 0.18;       // share of a correction let go per frame once it is not needed
const qAng = q => 2 * Math.acos(Math.min(1, Math.abs(q.w)));
function decollide(t) {
  let fixed = 0, maxDepth = 0, left = 0;
  for (const side of 'lr') {
    const sj = joints.get(N_(side + 'Shldr')), n = t.b - t.a + 1;
    const orig = sj.q.slice(t.a, t.b + 1).map(q => q.clone());
    const put = (k, D) => { sj.q[k] = D.clone().multiply(orig[k - t.a]).normalize(); };
    // Turn the shoulder until the arm is clear at frame k, starting from correction D.
    const resolve = (k, D, mem) => {
      put(k, D);
      for (let it = 0; it < 14; it++) {
        const W = world(k), hit = deepest(W, side, mem); if (!hit) return true;
        const S = W(side + 'Shldr').p, P = W(side + 'Collar').q;
        const Rw = new THREE.Quaternion().setFromUnitVectors(hit.p.clone().sub(S).normalize(), hit.p.clone().addScaledVector(hit.n, hit.depth * 1.05 + 0.0005).sub(S).normalize());
        sj.q[k] = P.clone().invert().multiply(Rw).multiply(P).multiply(sj.q[k]).normalize();
      }
      return !deepest(world(k), side, mem);
    };
    const delta = k => sj.q[k].clone().multiply(orig[k - t.a].clone().invert());
    // 1. forward in time, each frame starting from the frame before: the arm stays on the side
    //    it came in from, and the correction is let go gradually once it is not needed
    const mem = new Map(), D = []; let prev = ID.clone();
    for (let k = t.a; k <= t.b; k++) {
      put(k, ID); const raw = deepest(world(k), side, mem);
      if (raw) { fixed++; maxDepth = Math.max(maxDepth, raw.depth); }
      const relaxed = prev.clone().slerp(ID, EASE_OFF);
      put(k, relaxed);
      if (deepest(world(k), side, mem)) resolve(k, prev, mem);
      remember(world(k), side, mem);
      D.push(prev = delta(k));
    }
    // 2. backward: lead INTO each correction as gradually as it is let go
    for (let i = n - 2; i >= 0; i--) { const lead = D[i + 1].clone().slerp(ID, EASE_OFF); if (qAng(lead) > qAng(D[i])) D[i] = lead; }
    // 3. soften the corners, then make sure of every frame (what is left to do here is millimetres)
    const soft = D.map((_, i) => { const acc = new THREE.Quaternion(0, 0, 0, 0);
      for (let m = -3; m <= 3; m++) { const d = D[Math.min(n - 1, Math.max(0, i + m))], w = 4 - Math.abs(m), sg = d.dot(D[i]) < 0 ? -1 : 1;
        acc.x += sg * w * d.x; acc.y += sg * w * d.y; acc.z += sg * w * d.z; acc.w += sg * w * d.w; }
      return acc.normalize(); });
    const mem2 = new Map();
    for (let k = t.a; k <= t.b; k++) {
      put(k, D[k - t.a]); remember(world(k), side, mem2);          // the side each point is on, from the sure version
      if (!resolve(k, soft[k - t.a], mem2)) left++;
    }
  }
  return { fixed, maxDepth, left };
}
// --contacts=<source second>: list, frame by frame, which part of an arm is inside which body part
// (F forearm, H hand) — before any correction, or after with --contacts-after.
const contactsAt = flags.find(f => f.startsWith('--contacts='))?.slice(11);
function listContacts(sec) { const t = takes[at(+sec)];
  for (let k = t.a; k <= t.b; k++) { const W = world(k); let line = String(k - t.a).padStart(3);
    for (const side of 'lr') for (const c of contacts(W, side)) line += `  ${side}${c.seg}>${c.part}:${(c.raw * 262).toFixed(1)}cm n(${c.n.x.toFixed(1)},${c.n.y.toFixed(1)},${c.n.z.toFixed(1)})`;
    console.log(line); }
}
if (contactsAt && !flags.includes('--contacts-after')) listContacts(contactsAt);
for (const sec of edits.collide ?? []) {
  const t = takes[at(sec)], sh = 'lr'.split('').map(s => joints.get(N_(s + 'Shldr'))), before = sh.map(j => j.q.slice(t.a, t.b + 1).map(q => q.clone()));
  const r = decollide(t);
  let turn = 0, jerk = 0;
  sh.forEach((j, si) => { for (let k = t.a; k <= t.b; k++) { turn = Math.max(turn, qAngle(j.q[k], before[si][k - t.a]));
    if (k > t.a) jerk = Math.max(jerk, Math.abs(qAngle(j.q[k], j.q[k - 1]) - qAngle(before[si][k - t.a], before[si][k - t.a - 1]))); } });
  console.log(`collide @${sec}s: ${r.fixed} arm-frames were inside (deepest ${(r.maxDepth * 262).toFixed(1)} cm), ${r.left} of ${t.b - t.a + 1} frames still touching; shoulder turned up to ${(turn / D2R).toFixed(0)}°, at most ${(jerk / D2R).toFixed(1)}° per frame faster than before`);
}
if (contactsAt && flags.includes('--contacts-after')) listContacts(contactsAt);

// ── rebuild each take ───────────────────────────────────────────────────────
const smooth = u => u * u * (3 - 2 * u);
// Eased there-half: position 0..1 along the take for u in 0..1; slope 0 at both ends.
function easedPos(u) {
  const v = 1 / (1 - EASE);
  if (u < EASE) return v * u * u / (2 * EASE);
  if (u > 1 - EASE) { const w = 1 - u; return 1 - v * w * w / (2 * EASE); }
  return v * (u - EASE / 2);
}
const outQ = J.map(() => []), outP = J.map(() => []);
const report = [];
for (const [ti, t] of takes.entries()) {
  const L = t.b - t.a;                                   // steps
  let travel = 0; for (let k = t.a; k < t.b; k++) travel += speed[k];
  const gap = poseDiff(t.a, t.b);
  const worst = Math.max(...J.map(j => qAngle(j.q[t.a], j.q[t.b])));
  const still = travel < 0.02;
  const cyclic = t.force || still || (gap <= CYCLIC_GAP * travel && worst / (L / FPS) <= CYCLIC_BONE && worst <= CYCLIC_TURN);
  const start = outQ[0].length;
  if (cyclic) {
    // Spread the gap: frame k is turned by the share w(k) of (end → start).
    const Lo = Math.max(2, Math.round(L * SLOW));
    for (let k = 0; k <= Lo; k++) {
      const w = smooth(k / Lo);
      const x = k / Lo * L, i = Math.min(Math.floor(x), L - 1), f = x - i;
      J.forEach((j, ji) => {
        const corr = j.q[t.b].clone().invert().multiply(j.q[t.a]);          // end⁻¹ · start
        if (corr.w < 0) corr.set(-corr.x, -corr.y, -corr.z, -corr.w);
        outQ[ji].push(j.q[t.a + i].clone().slerp(j.q[t.a + i + 1], f).multiply(new THREE.Quaternion().slerp(corr, w)));
        if (j.p) outP[ji].push(j.p[t.a + i].clone().lerp(j.p[t.a + i + 1], f).addScaledVector(j.p[t.a].clone().sub(j.p[t.b]), k / Lo));   // travel comes off evenly: it walks on the spot
      });
    }
  } else {
    // There and back, eased at both turns; the half is stretched so the middle keeps its speed.
    const H = Math.max(2, Math.round(L * SLOW / (1 - EASE)));
    for (let k = 0; k <= 2 * H; k++) {
      const u = k <= H ? k / H : (2 * H - k) / H;
      const x = easedPos(u) * L, i = Math.min(Math.floor(x), L - 1), f = x - i;
      J.forEach((j, ji) => {
        outQ[ji].push(j.q[t.a + i].clone().slerp(j.q[t.a + i + 1], f));
        if (j.p) outP[ji].push(j.p[t.a + i].clone().lerp(j.p[t.a + i + 1], f));
      });
    }
  }
  const end = outQ[0].length - 1;
  report.push({ f0: start, f1: end, why: t.from ?? '', take: ti, from: +(t.a / FPS).toFixed(2), len: +(L / FPS).toFixed(2), kind: still ? 'still' : t.force ? 'cycle' : cyclic ? 'loop' : 'there-and-back',
    gap: +gap.toFixed(2), worstJoint: Math.round(worst / D2R), travel: +travel.toFixed(1), newFrom: +(start / FPS).toFixed(2), newLen: +((end - start) / FPS).toFixed(2) });
}
const M = outQ[0].length;

// ── back to Euler channels, each angle kept near the frame before it ────────
const R2D = 180 / Math.PI;
const near = (v, ref) => v + 360 * Math.round((ref - v) / 360);
J.forEach((j, ji) => {
  const prev = { X: 0, Y: 0, Z: 0 };
  for (const a of 'XYZ') if (j.rot[a]) j.rot[a].out = new Array(M);
  for (const a of 'XYZ') if (j.tr[a]) j.tr[a].out = new Array(M);
  for (let k = 0; k < M; k++) {
    _e.setFromQuaternion(outQ[ji][k], j.order);
    for (const a of 'XYZ') {
      if (!j.rot[a]) continue;
      let v = _e[a.toLowerCase()] * R2D;
      if (k) v = near(v, prev[a]);
      prev[a] = v; j.rot[a].out[k] = v;
    }
    if (j.p) for (const a of 'XYZ') if (j.tr[a]) j.tr[a].out[k] = outP[ji][k][a.toLowerCase()];
  }
});

// --speeds=<from>-<to> (source seconds): how fast the pose and the shoulders turn, frame by frame.
{ const sp = flags.find(f => f.startsWith('--speeds='))?.slice(9).split('-').map(Number);
  if (sp) for (let k = Math.round(sp[0] * FPS); k < Math.round(sp[1] * FPS); k++)
    console.log(`src ${(k / FPS).toFixed(2)}s  pose ${speed[k].toFixed(2)}  lShldr ${(qAngle(joints.get(N_('lShldr')).q[k], joints.get(N_('lShldr')).q[k + 1]) / D2R).toFixed(0)}°  rShldr ${(qAngle(joints.get(N_('rShldr')).q[k], joints.get(N_('rShldr')).q[k + 1]) / D2R).toFixed(0)}°  ${takes.some(t => t.a === k) ? '← piece starts' : takes.some(t => t.b === k) ? '← piece ends' : ''}`); }
// --wild: per take, the fastest any joint turns between two frames, and the worst disagreement
// between the written Euler channels blended halfway (what a player does between keys) and the
// true halfway turn. A big second number is an Euler flip: right at the keys, wild between them.
if (flags.includes('--wild')) {
  const names = [...joints.keys()].map(n => n.replace(/^Figure_1|_1_node$/g, ''));
  for (const [ri, r] of report.entries()) {
    let fast = 0, fj = '', fk = 0, flip = 0, pj = '', pk = 0;
    J.forEach((j, ji) => { for (let k = r.f0; k < r.f1; k++) {
      const a = qAngle(outQ[ji][k], outQ[ji][k + 1]); if (a > fast) { fast = a; fj = names[ji]; fk = k; }
      const e = ax => j.rot[ax] ? (j.rot[ax].out[k] + j.rot[ax].out[k + 1]) / 2 * D2R : 0;
      const mid = new THREE.Quaternion().setFromEuler(_e.set(e('X'), e('Y'), e('Z'), j.order));
      const b = qAngle(mid, outQ[ji][k].clone().slerp(outQ[ji][k + 1], 0.5)); if (b > flip) { flip = b; pj = names[ji]; pk = k; }
    } });
    console.log(`seg ${String(ri + 1).padStart(2)} ${r.kind.padEnd(14)} fastest ${(fast / D2R).toFixed(0).padStart(3)}°/frame ${fj}@${(fk / FPS).toFixed(2)}s   between keys off by ${(flip / D2R).toFixed(0).padStart(3)}° ${pj}@${(pk / FPS).toFixed(2)}s`);
  }
}

// ── write ───────────────────────────────────────────────────────────────────
const g = v => String(+v.toPrecision(7));
const timeStr = Array.from({ length: M }, (_, k) => g(k / FPS)).join(' ');
const interp = Array(M).fill('LINEAR').join(' ');
let outLib = '<library_animations>\n';
for (const c of chans) {
  const b = c.base, pname = c.member === 'ANGLE' ? 'ANGLE' : c.member;
  outLib += `<animation id="${c.id}">` +
    `<source id="${b}-input"><float_array id="${b}-input-array" count="${M}">${timeStr}</float_array><technique_common><accessor count="${M}" source="#${b}-input-array"><param name="TIME" type="float"/></accessor></technique_common></source>` +
    `<source id="${b}-output"><float_array id="${b}-output-array" count="${M}">${c.out.map(g).join(' ')}</float_array><technique_common><accessor count="${M}" source="#${b}-output-array"><param name="${pname}" type="float"/></accessor></technique_common></source>` +
    `<source id="${b}-interpolations"><Name_array id="${b}-interpolations-array" count="${M}">${interp}</Name_array><technique_common><accessor count="${M}" source="#${b}-interpolations-array"><param name="INTERPOLATION" type="Name"/></accessor></technique_common></source>` +
    `<sampler id="${b}-sampler"><input semantic="INPUT" source="#${b}-input"/><input semantic="OUTPUT" source="#${b}-output"/><input semantic="INTERPOLATION" source="#${b}-interpolations"/></sampler>` +
    `<channel source="#${b}-sampler" target="${c.node}/${c.sid}.${c.member}"/></animation>\n`;
}
// The takes, declared: ImWeb reads these instead of hunting for cuts, so two takes that start
// from the same pose stay two.
const marks = report.map(r => `${g(r.f0 / FPS)} ${g(r.f1 / FPS)}`).join(' ');
const head = text.slice(0, A).replace(/<extra><technique profile="ImWeb">[\s\S]*?<\/extra>\s*/, '')
  .replace('</asset>', `<extra><technique profile="ImWeb"><imweb_takes>${marks}</imweb_takes></technique></extra>\n\t</asset>`);
writeFileSync(dst, head + outLib + text.slice(B));

const count = k => report.filter(r => r.kind === k).length;
console.log(`${takes.length} takes: ${count('loop')} already near a loop (gap closed), ${count('cycle')} repeating cycles found inside a take, ${count('there-and-back')} made there-and-back, ${count('still')} still`);
console.log(`${(N / FPS).toFixed(1)} s → ${(M / FPS).toFixed(1)} s, ${joints.size} joints`);
if (flag === '--report') console.table(report);
