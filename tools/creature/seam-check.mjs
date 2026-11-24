// Seam check for every creature's movement library: each segment must loop with no jump.
//   node tools/creature/seam-check.mjs
// Per segment: frequencies are integers, the pose at phase 0 equals the pose at 2π, and the pose
// is not frozen (a segment that cannot move would pass the seam test trivially).
import { existsSync } from 'node:fs';
import { TAU, segmentState, makePose, CREATURES as NAMES } from './core.js';

// Every registered creature whose definition exists (core.js CREATURES; one not written yet is
// skipped and said so). A definition that exists but fails to load is a failure, not a skip.
const CREATURES = [];
let loadFail = 0;
for (const k of NAMES) {
  if (!existsSync(new URL(`./${k}-def.js`, import.meta.url))) { console.log(`— ${k}: no ${k}-def.js yet, skipped`); continue; }
  try { CREATURES.push(await import(`./${k}-def.js`)); }
  catch (e) { console.log(`FAIL ${k}: ${k}-def.js does not load: ${e.message}`); loadFail++; }
}

// Every number in a pose, in a fixed order.
function flat(v, out = []) {
  if (typeof v === 'number') out.push(v);
  else if (ArrayBuffer.isView(v)) out.push(...v);
  else if (Array.isArray(v)) v.forEach(x => flat(x, out));
  else if (v && typeof v === 'object') Object.keys(v).sort().forEach(k => flat(v[k], out));
  return out;
}
const at = (def, S, phase) => flat(def.pose(S, phase, makePose(def)));

let fail = loadFail;
for (const def of CREATURES) {
  console.log(`— ${def.NAME} (${def.SEGMENTS.length} segments)`);
  const bad = (name, msg) => { console.log(`FAIL ${def.NAME}/${name}: ${msg}`); fail++; };
  for (let i = 0; i < def.SEGMENTS.length; i++) {
    const seg = def.SEGMENTS[i], S = segmentState(def, i), before = fail;
    for (const k of Object.keys(seg.s)) if (!(k in def.DEFAULT)) bad(seg.name, `unknown key ${k}`);
    if (!def.GROUPS.includes(seg.group)) bad(seg.name, `group "${seg.group}" not in GROUPS`);
    for (const k of def.INT_KEYS) if (!Number.isInteger(S[k])) bad(seg.name, `${k}=${S[k]} is not an integer`);
    const a = at(def, S, 0), b = at(def, S, TAU);
    if (a.length !== b.length || a.some(x => !Number.isFinite(x))) bad(seg.name, 'pose is not a fixed set of finite numbers');
    const seam = Math.max(...a.map((v, j) => Math.abs(v - b[j])));
    if (seam > 1e-9) bad(seg.name, `seam jump ${seam.toExponential(2)}`);
    let move = 0;
    for (let n = 1; n < 16; n++) { const c = at(def, S, TAU * n / 16); move = Math.max(move, ...c.map((v, j) => Math.abs(v - a[j]))); }
    if (move < 1e-3) bad(seg.name, `pose never changes (max ${move.toExponential(2)})`);
    console.log(`${fail > before ? '    ' : 'ok  '}${String(i + 1).padStart(2)} ${seg.name.padEnd(9)} seam ${seam.toExponential(1)}  motion ${move.toFixed(3)}`);
  }
}
// A creature with its own transitions (def.transition(from, target, x, phase, P), x linear 0..1)
// must start where it is and land where it is going: x = 0 equals pose(from), x = 1 equals
// pose(target), at any phase — or the creature jumps when a transition starts or ends. Checked for
// every segment to the next and to a few others.
for (const def of CREATURES) {
  if (!def.transition) continue;
  const N = def.SEGMENTS.length; let worst = 0, where = '';
  for (let i = 0; i < N; i++) for (const j of new Set([(i + 1) % N, (i + 5) % N, (i * 7 + 3) % N])) {
    if (j === i) continue;
    const a = segmentState(def, i), b = segmentState(def, j);
    for (const ph of [0, 1.3, 3.1, 5.2]) {
      const t0 = flat(def.transition(a, b, 0, ph, makePose(def))), p0 = at(def, a, ph);
      const t1 = flat(def.transition(a, b, 1, ph, makePose(def))), p1 = at(def, b, ph);
      const d = Math.max(...t0.map((v, k) => Math.abs(v - p0[k])), ...t1.map((v, k) => Math.abs(v - p1[k])));
      if (!(d <= worst)) { worst = d; where = `${def.SEGMENTS[i].name} → ${def.SEGMENTS[j].name} at phase ${ph}`; }
    }
  }
  if (worst > 1e-6) { console.log(`FAIL ${def.NAME} transition: ends ${worst.toExponential(2)} away from pose (${where})`); fail++; }
  else console.log(`ok  ${def.NAME} transitions start at pose(from) and end at pose(target) (max ${worst.toExponential(1)})`);
}

// ImWeb plays these creatures too (src/scene3d/), and its Movement menu holds a COPY of each
// animal's movement names — it must be right before the definition file has loaded, and the
// position of a name in it is what saved ImWeb states store. So a movement added, renamed, moved
// or removed here has to be followed there, or the menu shows the wrong names.
//   Added at the END, or renamed in place: update the list in CREATURE_KINDS, nothing else changes.
//   Inserted, reordered or removed: saved states now recall a different movement. Ask the owner
//   (through the session that owns the engine) before doing that to an animal ImWeb already has.
// An animal ImWeb does not list yet (the jellyfish, the peacock spider) is not checked.
{
  const { CREATURE_KINDS } = await import('../../src/scene3d/CreatureParams.js');
  const byName = new Map(CREATURES.map(d => [d.NAME, d]));
  const before = fail;
  for (const K of CREATURE_KINDS) {
    const def = byName.get(K.label);
    if (!def) { console.log(`FAIL ImWeb lists "${K.label}" (${K.key}), but no loaded definition has that NAME`); fail++; continue; }
    const names = def.SEGMENTS.map(s => s.name);
    if (names.join('|') === K.moves.join('|')) continue;
    const kept = K.moves.every((n, i) => names[i] === n);
    console.log(`FAIL ${def.NAME}: ImWeb's Movement menu is out of step with ${K.key}-def.js — ` +
      (kept ? `added at the end: ${names.slice(K.moves.length).join(', ')}. Append ${names.length - K.moves.length === 1 ? 'it' : 'them'} to "${K.key}" in src/scene3d/CreatureParams.js CREATURE_KINDS.`
            : `the existing movements changed (ImWeb has [${K.moves.join(', ')}]). A rename in place: update CREATURE_KINDS. A reorder, insert or removal changes what saved ImWeb states recall — ask first.`));
    fail++;
  }
  if (fail === before) console.log(`ok  ImWeb's Movement menus match (${CREATURE_KINDS.map(k => k.label).join(', ')})`);
}

const total = CREATURES.reduce((n, d) => n + d.SEGMENTS.length, 0);
console.log(fail ? `${fail} failure(s)` : `all ${total} segments of ${CREATURES.length} creatures loop seamlessly`);
process.exit(fail ? 1 : 0);
