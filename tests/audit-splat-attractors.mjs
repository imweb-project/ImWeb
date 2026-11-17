/**
 * Splat attractors audit — every Shape must hold the whole picture, and bring
 * it home.
 *
 * Splat World's Scatter releases one point per pixel into a strange attractor.
 * The points do not start ON the attractor: they start wherever the picture
 * put them, far corners included. A field that is well behaved on its own
 * attractor can still throw such a point to infinity, and a NaN written into a
 * ping-pong target stays there. The shader has a last-resort guard for that;
 * this audit is what says the guard is not what the feature runs on.
 *
 * It integrates the SAME strings the shader is generated from
 * (SPLAT_ATTRACTORS[i].d — written in the subset that is both GLSL and JS), with
 * the same hold-and-pull wrapper and the same midpoint step as SIM_FRAG in
 * src/ai/SplatWorld.js, so there is no hand-copied twin of the maths to drift.
 *
 * Checks:
 *   1. The table is well formed, and splat.shape's menu IS the table, in order.
 *   2. Storm: from a grid of starts spanning the picture at its worst case
 *      (Relief 100 %, 21:9, far corners), 120 simulated seconds at Scatter
 *      100 % / Flow 200 %, at the frame times that matter — 1/50 s (the owner's
 *      display), 1/60 s and the 1/30 s clamp. Nothing may go non-finite, and
 *      everything must END inside the frame-sized ball the form is scaled to.
 *   3. Home: Scatter back to 0 for the settle time takes every offset below
 *      OFF_EPS — the claim the settle clock makes.
 *   4. The rest is not rest: the storm must actually MOVE points (vacuity).
 *
 * Run:  node tests/audit-splat-attractors.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ParameterSystem, registerCoreParameters } from '../src/controls/ParameterSystem.js';
import { SPLAT_ATTRACTORS, HOLD_PULL, attractorGLSL, PULL, OFF_MAX, OFF_EPS, SETTLE_S, MAX_DT } from '../src/ai/SplatAttractors.js';
import { fadeEnvelope } from '../src/ai/SplatWorld.js';

const fails = [];
let checks = 0;
const check = (msg, ok) => { checks++; if (!ok) fails.push(msg); };

// ── Constants: read from SplatWorld.js, never restated ───────────────────────
const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '../src/ai/SplatWorld.js'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const num = (name) => {
  const m = src.match(new RegExp(`const ${name} = ([^;]+);`));
  check(`SplatWorld.js declares const ${name}`, !!m);
  // eslint-disable-next-line no-new-func
  return m ? Function(`"use strict"; return (${m[1]});`)() : NaN;
};
const FIT = num('FIT'), NEAR_D = num('NEAR_D'), MAX_FAR = num('MAX_FAR'), FOV = num('FOV');
check('constants are finite', [FIT, PULL, OFF_MAX, OFF_EPS, MAX_DT, NEAR_D, MAX_FAR, FOV].every(Number.isFinite));
check('SETTLE_S is derived from OFF_MAX, OFF_EPS and PULL', SETTLE_S === Math.log(OFF_MAX / OFF_EPS) / PULL);

// ── 1. The table, and the menu made from it ──────────────────────────────────
const ps = new ParameterSystem();
registerCoreParameters(ps);
const menu = ps.get('splat.shape');
check('there are shapes to check (vacuity guard)', SPLAT_ATTRACTORS.length >= 2);
check('splat.shape exists', !!menu);
check('splat.shape menu is SPLAT_ATTRACTORS, in order',
  JSON.stringify(menu?.options) === JSON.stringify(SPLAT_ATTRACTORS.map(a => a.name)));
check('splat.shape is group splat (captured: the list is append-only)', menu?.group === 'splat');
check('shape names are unique', new Set(SPLAT_ATTRACTORS.map(a => a.name)).size === SPLAT_ATTRACTORS.length);
// APPEND-ONLY, held here and not only by a comment: splat.shape is saved as an
// index, so reordering or removing a shape would make every saved state recall
// a different one, silently. New shapes go on the END of both lists.
const SHIPPED = ['Thomas', 'Aizawa', 'Lorenz', 'Rössler'];
check(`the shipped shapes keep their indices (${SHIPPED.join(', ')} first, in that order)`,
  SHIPPED.every((n, i) => SPLAT_ATTRACTORS[i]?.name === n));
check('splat.scatter rests at 0 (a fresh patch shows the picture)', ps.get('splat.scatter')?.value === 0);
// The 3D scene's Shatter is the second consumer of the same table.
const shMenu = ps.get('scene3d.shatter.shape');
check('scene3d.shatter.shape menu is SPLAT_ATTRACTORS, in order',
  JSON.stringify(shMenu?.options) === JSON.stringify(SPLAT_ATTRACTORS.map(a => a.name)));
check('scene3d.shatter rests at 0 (a fresh scene is whole)', ps.get('scene3d.shatter')?.value === 0);
check('scene3d.shatter.flow exists', !!ps.get('scene3d.shatter.flow'));

// FadeScatter: the fade's own scatter. It must leave a fade's two ENDS alone —
// a fade that starts or lands on a half-dissolved picture is the failure — and
// it must actually reach full in the middle, or the control is inert.
const fs = ps.get('splat.fadeScatter');
check('splat.fadeScatter exists, group splat, rests at 0', fs?.group === 'splat' && fs?.value === 0);
check('fade envelope is 0 at the start of a fade', fadeEnvelope(0) === 0);
check('fade envelope is 0 at the end of a fade', Math.abs(fadeEnvelope(1)) < 1e-9);
check('fade envelope is full through the middle', [0.3, 0.5, 0.7].every(t => fadeEnvelope(t) === 1));
let envOk = true, envUp = true;
for (let i = 0; i <= 100; i++) {
  const e = fadeEnvelope(i / 100);
  if (!(e >= 0 && e <= 1)) envOk = false;
  if (i > 0 && i <= 50 && e < fadeEnvelope((i - 1) / 100)) envUp = false;
}
check('fade envelope stays within 0..1', envOk);
check('fade envelope only rises through the first half', envUp);
check('fade envelope clamps a position outside 0..1', fadeEnvelope(-1) === 0 && Math.abs(fadeEnvelope(2)) < 1e-9);

const INVOLUTIONS = ['xyz', 'xzy', 'yxz', 'zyx'];   // swizzles that undo themselves
const glsl = attractorGLSL();
SPLAT_ATTRACTORS.forEach((a, i) => {
  check(`${a.name}: d has three components`, Array.isArray(a.d) && a.d.length === 3);
  check(`${a.name}: axes is its own inverse (one string maps both ways)`, INVOLUTIONS.includes(a.axes));
  check(`${a.name}: extent, rate, hold are positive`, [a.extent, a.rate, a.hold].every(n => n > 0));
  check(`${a.name}: hold reaches past the form`, a.hold > a.extent);
  check(`${a.name}: centre is three numbers`, a.centre?.length === 3 && a.centre.every(Number.isFinite));
  // GLSL ES 1.00 has no implicit int → float: a bare integer literal in `d`
  // compiles in JS and fails in the shader, where nobody is looking.
  for (const e of a.d ?? []) {
    check(`${a.name}: "${e}" has no bare integer literal`, !/(^|[^\w.])\d+(?![\d.])/.test(e));
    check(`${a.name}: "${e}" uses only x y z sin() and arithmetic`, /^[\sxyz\d.+\-*/()]*$/.test(e.replace(/sin\(/g, '(')));
  }
  check(`${a.name}: the generated shader has its flow${i}()`, glsl.includes(`vec3 flow${i}(vec3 w)`));
});

// ── The sim, as SIM_FRAG runs it ─────────────────────────────────────────────
const SWZ = { xyz: [0, 1, 2], xzy: [0, 2, 1], yxz: [1, 0, 2], zyx: [2, 1, 0] };
function makeFlow(a) {
  // eslint-disable-next-line no-new-func
  const d = Function('x', 'y', 'z', `const sin = Math.sin; return [${a.d.join(', ')}];`);
  const ix = SWZ[a.axes];
  const k = a.rate / a.extent;
  return (w) => {
    const q0 = [w[ix[0]] * a.extent, w[ix[1]] * a.extent, w[ix[2]] * a.extent];
    const r = Math.hypot(...q0);
    const m = Math.min(1, a.hold / Math.max(r, 1e-4));
    const q = [q0[0] * m, q0[1] * m, q0[2] * m];
    const v = d(q[0] + a.centre[0], q[1] + a.centre[1], q[2] + a.centre[2]);
    const o = [0, 1, 2].map(j => (v[j] - (q0[j] - q[j]) * HOLD_PULL) * k);
    return [o[ix[0]], o[ix[1]], o[ix[2]]];
  };
}
// One step for a point with home `h` and offset `off`; returns the new offset.
function step(flow, h, off, s, flowAmt, dt, pivot, frame) {
  let w = [0, 1, 2].map(j => (h[j] + off[j] - pivot[j]) / frame);
  const hs = s * flowAmt * dt;
  const f1 = flow(w);
  const mid = w.map((c, j) => c + f1[j] * hs * 0.5);
  const f2 = flow(mid);
  w = w.map((c, j) => c + f2[j] * hs);
  const decay = Math.exp(-PULL * (1 - s) * dt);
  const o = [0, 1, 2].map(j => (pivot[j] + w[j] * frame - h[j]) * decay);
  const d2 = o[0] * o[0] + o[1] * o[1] + o[2] * o[2];
  if (!(d2 < OFF_MAX * OFF_MAX)) return { off: [0, 0, 0], guarded: true };
  return { off: o, guarded: false };
}

// Homes: the picture at its worst case — Relief 100 %, an ultrawide frame.
const tanHalf = Math.tan((FOV / 2) * Math.PI / 180);
const far = NEAR_D + 0.001 + (MAX_FAR - NEAR_D);
const aspect = 21 / 9;
const pivotD = 1 / ((1 / far + 1 / NEAR_D) / 2);
const pivot = [0, 0, -pivotD];
const frame = FIT * tanHalf * pivotD;
const homes = [];
const N = 7;
for (let j = 0; j < N; j++) for (let c = 0; c < N; c++) for (const d of [0, 0.25, 0.5, 0.75, 1]) {
  const u = (c + 0.5) / N, v = (j + 0.5) / N;
  const dist = 1 / ((1 - d) / far + d / NEAR_D);
  homes.push([(u * 2 - 1) * tanHalf * aspect * dist, (v * 2 - 1) * tanHalf * dist, -dist]);
}
check('the start grid is not trivial', homes.length >= 200);

for (const a of SPLAT_ATTRACTORS) {
  // A malformed row has already FAILED above; it cannot be integrated, and
  // crashing here would replace that named failure with a stack trace.
  if (!SWZ[a.axes] || a.d?.length !== 3) continue;
  const flow = makeFlow(a);
  for (const dt of [1 / 50, 1 / 60, MAX_DT]) {
    const tag = `${a.name} @ dt 1/${Math.round(1 / dt)}`;
    let guarded = 0, nonFinite = 0, worstEnd = 0, moved = 0, worstHome = 0, onForm = 0, atRim = 0;
    for (const h of homes) {
      let off = [0, 0, 0];
      // 2. Storm: 120 s free in the attractor at twice the flow.
      for (let t = 0; t < 120; t += dt) {
        const r = step(flow, h, off, 1, 2, dt, pivot, frame);
        if (r.guarded) guarded++;
        off = r.off;
        if (!off.every(Number.isFinite)) { nonFinite++; break; }
      }
      const w = [0, 1, 2].map(j => (h[j] + off[j] - pivot[j]) / frame);
      worstEnd = Math.max(worstEnd, Math.hypot(...w));
      if (Math.hypot(...w) <= 1.15) onForm++;
      if (Math.hypot(...w) >= 0.97 * a.hold / a.extent) atRim++;
      if (Math.hypot(...off) > 0.05) moved++;
      // 3. Home: Scatter 0 for the settle time.
      for (let t = 0; t < SETTLE_S; t += dt) off = step(flow, h, off, 0, 2, dt, pivot, frame).off;
      worstHome = Math.max(worstHome, Math.hypot(...off));
    }
    check(`${tag}: nothing went non-finite (${nonFinite})`, nonFinite === 0);
    check(`${tag}: the blow-up guard never fired (${guarded} times)`, guarded === 0);
    // Frame units: 1 is the edge the form is scaled to. hold/extent is as far
    // as a point can be held; ending inside it means it was caught, not lost.
    check(`${tag}: every point ends inside the hold radius (worst ${worstEnd.toFixed(2)} of ${(a.hold / a.extent).toFixed(2)})`,
      worstEnd <= a.hold / a.extent);
    // Caught is not enough: a start outside the basin can be HELD at the rim for
    // good, pushed out by the field and pulled in by the hold, and never join
    // the form — a shell of stragglers around the shape. `extent` is the
    // form's own reach, so ending within it (with a little room) is "on it".
    check(`${tag}: every point ends ON the form, none parked at the rim (${onForm}/${homes.length} on, ${atRim} at the rim)`,
      onForm === homes.length && atRim === 0);
    // Nearly all: a point may happen to pass its own home at the 120 s mark.
    check(`${tag}: the storm moved the points (${moved}/${homes.length})`, moved >= homes.length * 0.9);
    check(`${tag}: home again within OFF_EPS after the settle time (worst ${worstHome.toExponential(1)})`,
      worstHome < OFF_EPS);
  }
}

if (fails.length) {
  console.error(`audit-splat-attractors: FAIL (${fails.length} of ${checks})`);
  for (const f of fails) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log(`audit-splat-attractors: PASS (${checks} checks, ${SPLAT_ATTRACTORS.length} shapes, ${homes.length} starts)`);
