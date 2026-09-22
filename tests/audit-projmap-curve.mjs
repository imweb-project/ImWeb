/**
 * Projection-mesh curvature audit (Mesh Curve).
 *
 * Why this exists. `ProjMapMesh.sample()` is the ONE definition the renderer's
 * net, the calibration grid and `setGrid` all route through. Adding a second
 * surface behind it — a Catmull-Rom spline blended in by `projmap.meshCurve` —
 * puts four silent failures within one line of each other, and every one of
 * them looks like working code:
 *
 *   1. The flat path stops being bit-exact. A 2x2 mesh is asserted elsewhere
 *      byte-identical to the corner-pin path it replaced; a blend that merely
 *      *tends to* the projective sample at curve 0 breaks that with no visible
 *      symptom until someone diffs two renders.
 *   2. The surface stops passing through its own control points. Then a handle
 *      dragged onto a feature of the physical object no longer puts the image
 *      there, which is the entire job of a calibration mesh.
 *   3. 2x2 curves. Four corners carry no curvature information, so a spline
 *      over their extrapolated ghosts is exactly the BILINEAR surface — which
 *      on a keystoned quad differs from the projective one by a third of the
 *      frame. A calibrated wall would slide off itself.
 *   4. The end condition flattens the border. Clamping the ghost points
 *      (`P[-1] = P[0]`) gives a zero end tangent: the identity map stops being
 *      the identity in the boundary cells, by ~0.03 of the frame at the
 *      quarter point. It reads as a soft edge, not as a maths error.
 *
 * Every check below can fail, and the ones that assert over a collection also
 * assert the collection is non-empty — an `every()` over nothing is true, and
 * "nothing" is what a broken sampler produces.
 *
 * The curve is also MEASURED, not asserted: a sampler that ignored `curve`
 * entirely would pass checks 1-4 by construction, so the suite states how far
 * apart the two hypotheses actually are before trusting any verdict.
 *
 * Run:  node tests/audit-projmap-curve.mjs
 */

import { readFileSync } from 'node:fs';
import { ProjMapMesh } from '../src/inputs/ProjMapMesh.js';
import { ParameterSystem, registerCoreParameters } from '../src/controls/ParameterSystem.js';

let failures = 0;
const check = (label, cond, detail = '') => {
  if (cond) { console.log(`  ok   ${label}`); }
  else { console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); failures++; }
};

/**
 * Blank comments, and optionally string literals, in place — offsets and line
 * count survive either way.
 *
 * TWO views, deliberately. A check for `projmap.meshCurve` in main.js is
 * looking for a parameter ID, which only ever appears INSIDE a string literal,
 * so the strings-blanked view can never match it — the first run of this audit
 * reported "nothing reads the parameter" about code that reads it four lines
 * later. Comments still have to go, because this file's own prose names every
 * identifier it asserts on (LEARNED 2026-08-12 / 2026-08-14, paid for six
 * times).
 */
function sanitizeSource(src, blankStrings = true) {
  let out = '', i = 0, n = src.length;
  const keep = (c) => (c === '\n' ? '\n' : ' ');
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') out += keep(src[i++]); continue; }
    if (c === '/' && d === '*') {
      out += '  '; i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) out += keep(src[i++]);
      out += '  '; i += 2; continue;
    }
    if (blankStrings && (c === '"' || c === "'" || c === '`')) {
      const q = c; out += ' '; i++;
      while (i < n && src[i] !== q) {
        if (src[i] === '\\') { out += '  '; i += 2; continue; }
        out += keep(src[i++]);
      }
      out += ' '; i++; continue;
    }
    out += c; i++;
  }
  return out;
}

/** Deliberately keystoned 2x2 — the case where projective and bilinear diverge. */
const KEYSTONE = { tl: { x: 0.10, y: 0.05 }, tr: { x: 0.95, y: 0.20 },
                   br: { x: 0.80, y: 0.95 }, bl: { x: 0.25, y: 0.75 } };

/**
 * Probe points, in TWO families, because one of them is blind by construction.
 *
 * The a/8 lattice covers the edges and the corners — and lands exactly on the
 * knots of a 9x9 or 17x17 net, where every surface here agrees by definition
 * (each one interpolates its control points). A convergence check written on
 * that lattice alone passed at 4e-16 while measuring nothing at all, which is
 * the 2026-09-22 lesson arriving in this very file. The second family sits at
 * (a + 0.31)/13, which coincides with no knot of any net this audit builds, so
 * the behaviour BETWEEN control points is actually observed.
 */
const PROBES = [];
for (let a = 0; a <= 8; a++) for (let b = 0; b <= 8; b++) PROBES.push([a / 8, b / 8]);
for (let a = 0; a < 13; a++) for (let b = 0; b < 13; b++) {
  PROBES.push([(a + 0.31) / 13, (b + 0.31) / 13]);
}
const N_PROBES = PROBES.length;

// ── 1. The flat path is untouched at curve 0 ──────────────────────────────
console.log('\n§1 curve 0 is the projective surface, bit for bit');
{
  let probes = 0, worst = 0;
  for (const [C, R] of [[2, 2], [3, 3], [5, 3], [9, 5], [17, 17]]) {
    const m = new ProjMapMesh();
    m.setCorners(KEYSTONE);
    m.setGrid(C, R);
    m.setCurve(0);
    for (const [u, v] of PROBES) {
      const s = m.sample(u, v), f = m._sampleFlat(u, v);
      worst = Math.max(worst, Math.abs(s.x - f.x), Math.abs(s.y - f.y));
      probes++;
    }
  }
  check('probed a non-empty grid of samples', probes === N_PROBES * 5,
    `${probes} probes`);
  check('sample() === _sampleFlat() exactly at curve 0', worst === 0,
    `worst |delta| ${worst}`);
}

// ── 2. The surface interpolates every control point, at every curve ───────
console.log('\n§2 a control point is where the image lands, at any curve');
{
  const m = new ProjMapMesh();
  m.setCorners(KEYSTONE);
  m.setGrid(5, 4);
  // Shove the net around so the test is not run on a surface that is already
  // its own spline: an undisturbed resample of a homography is collinear per
  // row, which is exactly the case the two models agree on.
  m.setPoint(2, 1, 0.42, 0.30);
  m.setPoint(1, 2, 0.30, 0.70);
  m.setPoint(3, 2, 0.72, 0.52);
  let knots = 0, worst = 0;
  for (const a of [0, 0.25, 0.5, 1]) {
    m.setCurve(a);
    for (let j = 0; j < m.rows; j++) for (let i = 0; i < m.cols; i++) {
      const p = m.get(i, j);
      const s = m.sample(i / (m.cols - 1), j / (m.rows - 1));
      worst = Math.max(worst, Math.abs(s.x - p.x), Math.abs(s.y - p.y));
      knots++;
    }
  }
  check('probed every knot at four curve settings', knots === 5 * 4 * 4, `${knots} knots`);
  check('every control point is interpolated exactly', worst < 1e-12,
    `worst |delta| ${worst.toExponential(2)} — a surface that misses its own ` +
    'handles cannot calibrate against a physical object');
}

// ── 3. 2x2 does not curve, at any setting ─────────────────────────────────
console.log('\n§3 four corners carry no curvature, so they stay projective');
{
  const m = new ProjMapMesh();
  m.setCorners(KEYSTONE);
  let probes = 0, worst = 0;
  for (const [u, v] of PROBES) {
    m.setCurve(0); const flat = m.sample(u, v);
    m.setCurve(1); const bent = m.sample(u, v);
    worst = Math.max(worst, Math.abs(bent.x - flat.x), Math.abs(bent.y - flat.y));
    probes++;
  }
  check('probed a non-empty grid on the 2x2 case', probes === N_PROBES, `${probes}`);
  check('a 2x2 mesh is identical at curve 0 and curve 1', worst === 0,
    `worst |delta| ${worst} — curving 2x2 means blending toward BILINEAR, ` +
    'which slides a calibrated keystone off the wall');
  check('renderSub() stays 1 on a 2x2 mesh', new ProjMapMesh().renderSub() === 1);
}

// ── 4. End condition: extrapolated ghosts, not clamped ────────────────────
console.log('\n§4 the border does not go slack (linear extrapolation, not clamping)');
{
  // A regular net on the unit square IS the identity map. Both models must
  // reproduce it exactly; a clamped end tangent does not, and misses by ~0.03
  // of the frame in the boundary cells.
  const m = new ProjMapMesh(3, 3);
  m.setCurve(1);
  let probes = 0, worst = 0;
  for (const [u, v] of PROBES) {
    const s = m.sample(u, v);
    worst = Math.max(worst, Math.abs(s.x - u), Math.abs(s.y - v));
    probes++;
  }
  check('probed a non-empty grid on the identity net', probes === N_PROBES, `${probes}`);
  check('a regular net stays the identity map at curve 1', worst < 1e-12,
    `worst |delta| ${worst.toExponential(2)} — clamped ghosts miss by ~3e-2`);
}

// ── 5. The curve is real: measure the separation before believing §1-§4 ───
console.log('\n§5 separation — how far apart the two surfaces actually are');
{
  const m = new ProjMapMesh(3, 3);
  m.setPoint(1, 0, 0.50, 0.18);   // bow the top edge up
  m.setPoint(1, 1, 0.50, 0.42);
  m.setPoint(1, 2, 0.50, 0.82);   // and the bottom edge down
  let sep = 0, probes = 0;
  for (const [u, v] of PROBES) {
    m.setCurve(0); const flat = m.sample(u, v);
    m.setCurve(1); const bent = m.sample(u, v);
    sep = Math.max(sep, Math.hypot(bent.x - flat.x, bent.y - flat.y));
    probes++;
  }
  console.log(`       max separation flat vs spline: ${sep.toFixed(5)} of the frame`);
  check('probed a non-empty grid for separation', probes === N_PROBES, `${probes}`);
  check('curve 1 moves the surface by an order more than §2/§4 tolerate',
    sep > 1e-3,
    `separation ${sep.toExponential(2)} — with no separation, every check ` +
    'above passes against a sampler that ignores curve entirely');
  // And the blend is monotone through it, so the knob is usable.
  m.setCurve(0.5);
  const mid = m.sample(0.5, 0.25);
  m.setCurve(0); const f = m.sample(0.5, 0.25);
  m.setCurve(1); const b = m.sample(0.5, 0.25);
  check('curve 50% lands halfway between the two surfaces',
    Math.abs(mid.y - (f.y + b.y) / 2) < 1e-12,
    `${mid.y} vs ${(f.y + b.y) / 2}`);
}

// ── 6. renderNet: the popup is handed geometry, never maths ───────────────
console.log('\n§6 renderNet tessellates, and its knots are still the control points');
{
  const m = new ProjMapMesh(3, 3);
  m.setPoint(1, 1, 0.42, 0.30);
  m.setCurve(1);

  const flatNet = m.renderNet(1);
  check('renderNet(1) returns the control net verbatim',
    flatNet.cols === 3 && flatNet.rows === 3 && flatNet.pts.length === 9 &&
    flatNet.pts.every((p, k) => p.x === m.pts[k].x && p.y === m.pts[k].y),
    'the flat path must be unchanged, not merely equivalent');

  const sub = 4;
  const net = m.renderNet(sub);
  check('renderNet(4) has the right dimensions',
    net.cols === 9 && net.rows === 9 && net.pts.length === 81,
    `${net.cols}x${net.rows}, ${net.pts.length} pts`);
  let knots = 0, worst = 0;
  for (let j = 0; j < m.rows; j++) for (let i = 0; i < m.cols; i++) {
    const p = m.get(i, j);
    const q = net.pts[(j * sub) * net.cols + (i * sub)];
    worst = Math.max(worst, Math.abs(q.x - p.x), Math.abs(q.y - p.y));
    knots++;
  }
  check('probed every control point in the tessellated net', knots === 9, `${knots}`);
  check('every control point survives tessellation', worst < 1e-12,
    `worst |delta| ${worst.toExponential(2)}`);

  check('renderSub() is 1 while flat', (() => {
    const f = new ProjMapMesh(3, 3); return f.renderSub() === 1;
  })(), 'a flat net drawn at sub 1 is the path every existing measurement used');
  check('renderSub() subdivides once curved above 2x2', m.renderSub() > 1,
    `${m.renderSub()} — an untessellated curve draws as a fan of chords`);
  const big = new ProjMapMesh(17, 17); big.setCurve(1);
  const bigNet = big.renderNet(big.renderSub());
  check('a 17x17 curved net stays inside a fixed vertex budget',
    bigNet.pts.length <= 5000,
    `${bigNet.pts.length} points — the budget is total, not per cell`);
}

// ── 7. setGrid: exact where the code claims it, measured where it does not ─
console.log('\n§7 subdivision preserves the shape');
{
  // The claim setGrid actually makes is about a net that came from ONE
  // projective map: "going 2x2 -> 3x3 must not move a single projected pixel".
  // That is the case every change of Mesh Cols/Rows hits on a freshly
  // corner-pinned mapping, and it must stay exact at curve 0.
  //
  // Exactness is a property of the PROJECTIVE surface and only of it: a cell
  // reproduces the global homography from its own four corners. A spline does
  // not subdivide losslessly and this audit must not claim it does — the first
  // version asserted exactness at both settings and went red at curve 1 on
  // correct code, which is the direction that teaches people to edit audits.
  const pinned = (a, cols, rows) => {
    const m = new ProjMapMesh(); m.setCorners(KEYSTONE);
    m.setGrid(3, 3); m.setCurve(a);
    if (cols) m.setGrid(cols, rows);
    return m;
  };
  const drift = (a, cols, rows) => {
    const before = pinned(a), after = pinned(a, cols, rows);
    let worst = 0, probes = 0;
    for (const [u, v] of PROBES) {
      const p = before.sample(u, v), q = after.sample(u, v);
      worst = Math.max(worst, Math.hypot(q.x - p.x, q.y - p.y));
      probes++;
    }
    return { worst, probes };
  };

  const flat = drift(0, 5, 5);
  check('probed a non-empty grid across subdivision at curve 0',
    flat.probes === N_PROBES, `${flat.probes}`);
  check('a homography-derived net subdivides EXACTLY at curve 0',
    flat.worst < 1e-12, `worst ${flat.worst.toExponential(2)}`);

  // And the curved case converges as the net gets finer, which is the
  // direction subdivision goes — so the trade is bounded rather than open.
  const c5 = drift(1, 5, 5), c9 = drift(1, 9, 9), c17 = drift(1, 17, 17);
  console.log(`       curve 1 from 3x3: ->5x5 ${c5.worst.toExponential(2)}, ` +
              `->9x9 ${c9.worst.toExponential(2)}, ->17x17 ${c17.worst.toExponential(2)}`);
  check('curved subdivision shifts the surface only slightly',
    c5.worst < 0.01, `worst ${c5.worst.toExponential(2)} of the frame`);
  check('curved subdivision converges as the net gets finer',
    c17.worst < c9.worst && c9.worst < c5.worst,
    `${c5.worst.toExponential(2)} -> ${c9.worst.toExponential(2)} -> ` +
    `${c17.worst.toExponential(2)} is not decreasing`);

  // A HAND-EDITED net is a different question, and the answer is not exact —
  // it never was. Measured against the pre-feature ProjMapMesh over this exact
  // probe set: 5.9715e-02 at curve 0, identical to five digits before and
  // after. See §10 for the mechanism.
  // Bounded rather than asserted exact, so a regression that made it worse
  // cannot pass as "expected drift".
  const edited = () => {
    const m = new ProjMapMesh(); m.setCorners(KEYSTONE);
    m.setGrid(3, 3); m.setPoint(1, 1, 0.48, 0.44); return m;
  };
  const shift = (a) => {
    const before = edited(); before.setCurve(a);
    const after = edited(); after.setCurve(a); after.setGrid(5, 5);
    let worst = 0;
    for (const [u, v] of PROBES) {
      const p = before.sample(u, v), q = after.sample(u, v);
      worst = Math.max(worst, Math.hypot(q.x - p.x, q.y - p.y));
    }
    return worst;
  };
  const flatShift = shift(0), curvedShift = shift(1);
  console.log(`       hand-edited 3x3 -> 5x5: curve 0 ${flatShift.toExponential(3)}, ` +
              `curve 1 ${curvedShift.toExponential(3)}`);
  check('the flat hand-edited case is no worse than the measured baseline',
    flatShift < 0.07, `${flatShift.toExponential(4)} vs baseline 5.9715e-2`);
  check('the curved hand-edited case is no worse than the flat one',
    curvedShift <= flatShift,
    `curve 1 ${curvedShift.toExponential(3)} > curve 0 ${flatShift.toExponential(3)} — ` +
    'the spline is C1 across cell edges and the flat surface is not, so ' +
    'curving should reduce this, never add to it');
}

// ── 8. A morph target is resampled on the SAME surface ────────────────────
console.log('\n§8 a crossfade starts AND lands on the surface the curve describes');
{
  const store = {};
  globalThis.localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
  };
  // The saved slot is deliberately a DIFFERENT grid size from the live mesh.
  // With both at 5x5 the target's setGrid is a no-op, so a target resampled on
  // the wrong surface is indistinguishable from a correct one — the first
  // version of this section was built that way and a mutation walked straight
  // through it. The sizes must differ or the check tests nothing.
  const src = new ProjMapMesh(3, 3);
  src.setPoint(1, 1, 0.28, 0.66);
  src.setPoint(1, 0, 0.55, 0.12);
  src.save(3);

  const live = new ProjMapMesh(5, 5);
  live.setPoint(2, 2, 0.62, 0.38);
  live.setCurve(1);

  const startRef = new ProjMapMesh(5, 5);
  startRef.setPoint(2, 2, 0.62, 0.38);
  startRef.setCurve(1);

  const began = live.beginMorph(3, 2);
  check('beginMorph accepts a populated slot', began === true);
  check('beginMorph leaves the live mesh on the finer common net',
    live.cols === 5 && live.rows === 5, `${live.cols}x${live.rows}`);
  check('beginMorph keeps the live curve', live.curve === 1, `${live.curve}`);

  // (a) The morph starts at t=0, so the live surface must still be exactly
  //     where it was — resampled on the curved surface, not a flat one.
  let worst = 0, probes = 0;
  for (const [u, v] of PROBES) {
    const p = startRef.sample(u, v), q = live.sample(u, v);
    worst = Math.max(worst, Math.hypot(q.x - p.x, q.y - p.y));
    probes++;
  }
  check('probed a non-empty grid across the morph start', probes === N_PROBES, `${probes}`);
  check('the morph STARTS from the curved surface', worst < 0.01,
    `worst ${worst.toExponential(2)} — a live mesh resampled at curve 0 makes ` +
    'the crossfade jump on its first frame');

  // (b) And it must LAND on the saved shape as the live curve renders it.
  //     This is the half the target's own resampling decides, and nothing
  //     above can see it.
  live.tickMorph(2);
  check('the morph runs to completion', live.morphing === false);
  const endRef = new ProjMapMesh();
  endRef.curve = 1;
  endRef.deserialize(JSON.parse(store['imweb-projmesh'])[3]);
  endRef.setGrid(5, 5);
  let wEnd = 0, pEnd = 0;
  for (const [u, v] of PROBES) {
    const p = endRef.sample(u, v), q = live.sample(u, v);
    wEnd = Math.max(wEnd, Math.hypot(q.x - p.x, q.y - p.y));
    pEnd++;
  }
  check('probed a non-empty grid at the morph end', pEnd === N_PROBES, `${pEnd}`);
  check('the morph LANDS on the saved shape as the live curve renders it',
    wEnd < 1e-9,
    `worst ${wEnd.toExponential(2)} — a target resampled at curve 0 lands on a ` +
    'surface the instrument is not showing');

  // Separation guard: the two references must actually differ, or (b) passes
  // because there was nothing to get wrong.
  let sep = 0;
  for (const [u, v] of PROBES) {
    const p = startRef.sample(u, v), q = endRef.sample(u, v);
    sep = Math.max(sep, Math.hypot(q.x - p.x, q.y - p.y));
  }
  check('the morph endpoints are far enough apart to be told apart',
    sep > 0.05, `separation ${sep.toExponential(2)}`);
  delete globalThis.localStorage;
}

// ── 9. The parameter, and the two ends of the wire ────────────────────────
console.log('\n§9 registry and wiring');
{
  const ps = new ParameterSystem();
  registerCoreParameters(ps);
  const p = ps.get('projmap.meshCurve');
  check('projmap.meshCurve is registered', !!p);
  check('projmap.meshCurve is group "projmap"', p?.group === 'projmap',
    `is "${p?.group}" — this is geometry: it belongs in a project file and ` +
    'must be stripped from Display State recall by the mapping lock');
  check('projmap.meshCurve defaults to 0', p?.value === 0,
    `is ${p?.value} — any other default changes every existing project`);
  check('projmap.meshCurve spans 0..100', p?.min === 0 && p?.max === 100,
    `${p?.min}..${p?.max}`);

  const main = sanitizeSource(readFileSync('src/main.js', 'utf8'), false);
  check('main.js drives the mesh from the param',
    /projmap\.meshCurve"\s*\)\s*\?\.onChange/.test(main),
    'nothing reads the parameter');
  check('main.js raises the grid when the curve is lifted off a 2x2',
    /projMesh\.isQuad[\s\S]{0,200}projmap\.meshCols/.test(main),
    'the row would move while nothing happened, which reads as broken');
  // Anchored on the CALL, not on the variable that receives it: the property
  // under test is that the opener samples the surface, and a rename of the
  // local would fail this against correct code.
  check('main.js posts a sampled render net to the output window',
    /projMesh\.renderNet\(/.test(main) && /\.renderMesh\s*=\s*_pmRenderMesh/.test(main),
    'the popup would have to re-derive the surface, which is the bug this ' +
    'subsystem already paid for on 2026-09-22');
  check('the output window draws the posted net',
    /GL\.renderMesh\(netM\)/.test(main),
    'a tessellated net that nothing draws is not a tessellation');
  check('the output window keeps control net and render net apart',
    /lastRenderMesh/.test(main) && /lastMesh/.test(main),
    'handles belong on control points, not on tessellated vertices');
  // §11 measures the MECHANISM (that _rev is stable across idle frames and
  // bumps on a change) by replaying the comparison. This is the other half:
  // that main.js actually makes that comparison rather than posting every
  // frame. Without it §11 would be asserting about a replica of the gate,
  // which is the second-source-of-truth shape this audit exists to prevent.
  check('main.js gates the repost on the mesh revision',
    /projMesh\._rev !== _pmNetRev/.test(main),
    'an ungated repost posts ~2400 points on every idle frame at 17x17');
}

// ── 10. The seam the flat surface has and the spline does not ────────────
console.log('\n§10 interior cell edges (a PRE-EXISTING property, recorded here)');
{
  // Two neighbouring cells share an edge and both map it onto the same straight
  // segment between the same two control points — but each does so with its own
  // projective parametrisation, so they agree only at the endpoints. The image
  // therefore SLIDES along every interior cell edge of a hand-edited net.
  // Measured at 4.8e-3 of the frame here, which is ~9 px across 1920.
  //
  // This is not introduced by Mesh Curve and is not fixed by it. It is recorded
  // because it is the reason §7's hand-edited flat case cannot be exact, and
  // because anyone reading that number deserves to know it is a seam and not a
  // rounding error. The spline has no such seam: it is C1 by construction.
  const m = new ProjMapMesh(); m.setCorners(KEYSTONE);
  m.setGrid(3, 3); m.setPoint(1, 1, 0.48, 0.44);
  const jump = (curve) => {
    m.setCurve(curve);
    let worst = 0, n = 0;
    for (let k = 1; k < 8; k++) {
      const v = k / 16;
      const L = m.sample(0.5 - 1e-9, v), R = m.sample(0.5 + 1e-9, v);
      worst = Math.max(worst, Math.hypot(R.x - L.x, R.y - L.y));
      n++;
    }
    return { worst, n };
  };
  const flat = jump(0), bent = jump(1);
  console.log(`       seam at u=0.5: flat ${flat.worst.toExponential(3)}, ` +
              `curve 1 ${bent.worst.toExponential(3)} over ${flat.n} probes`);
  check('probed a non-empty set of points along the interior edge', flat.n === 7, `${flat.n}`);
  check('the flat surface really does have a seam (so §7 is explained, not excused)',
    flat.worst > 1e-4,
    `${flat.worst.toExponential(3)} — if this ever reaches 0, the flat sampler ` +
    'changed and §7 should go back to asserting exactness');
  check('the spline closes that seam', bent.worst < flat.worst / 10,
    `curve 1 ${bent.worst.toExponential(3)} vs flat ${flat.worst.toExponential(3)}`);
}

// ── 11. The repost gate, COUNTED rather than read ────────────────────────
console.log('\n§11 the render net is reposted only when it changes');
{
  // A dirty-check that silently never fires reads exactly like one that works
  // (LEARNED 2026-09-13: a gate promising 1 call in 7 ticks made 6). This
  // replays the frame loop's own decision — the same `_rev`/`sub` comparison —
  // and counts the sends, because a curved 17x17 net is ~2400 points and
  // posting it on every idle frame is the cost this gate exists to avoid.
  //
  // Note what this does and does not establish. It exercises the MECHANISM:
  // that `_rev` holds still across idle frames and moves on every mutation,
  // and that `renderSub()` is stable. It is a replica of the comparison, not
  // the comparison main.js makes — so §9 anchors that call site separately,
  // and neither check is sufficient alone.
  const replay = (mesh, frames, onFrame) => {
    let rev = -1, sub = -1, sends = 0, ticks = 0, lastN = 0;
    for (let f = 0; f < frames; f++) {
      onFrame?.(f);
      const sb = mesh.renderSub();
      ticks++;
      if (mesh._rev !== rev || sb !== sub) {
        rev = mesh._rev; sub = sb;
        lastN = mesh.renderNet(sb).pts.length;
        sends++;
      }
    }
    return { sends, ticks, lastN };
  };

  const idle = new ProjMapMesh(3, 3);
  idle.setPoint(1, 1, 0.42, 0.30);
  idle.setCurve(1);
  const r1 = replay(idle, 30);
  console.log(`       idle curved 3x3: ${r1.sends} send(s) over ${r1.ticks} frames, ${r1.lastN} pts`);
  check('an idle curved mesh reposts once, not every frame', r1.sends === 1,
    `${r1.sends} sends over ${r1.ticks} frames`);

  const moving = new ProjMapMesh(3, 3);
  moving.setPoint(1, 1, 0.42, 0.30);
  moving.setCurve(1);
  const r2 = replay(moving, 30, (f) => {
    if (f === 10) moving.setPoint(1, 1, 0.44, 0.32);
    if (f === 20) moving.setCurve(0.5);
  });
  check('a moved point and a curve change each force exactly one repost',
    r2.sends === 3, `${r2.sends} sends (expected 1 initial + 2 changes)`);

  // At 2x2 the frame loop calls setCorners every frame and that bumps _rev
  // unconditionally, so the gate cannot fire there. That is deliberate and
  // harmless — a 2x2 net is four points — but it is the kind of thing that
  // should be stated rather than discovered, so it is asserted.
  const quad = new ProjMapMesh();
  const r3 = replay(quad, 30, () => quad.setCorners({
    tl: { x: 0, y: 0 }, tr: { x: 1, y: 0 }, br: { x: 1, y: 1 }, bl: { x: 0, y: 1 },
  }));
  check('the 2x2 path reposts every frame, and its net is four points',
    r3.sends === r3.ticks && r3.lastN === 4,
    `${r3.sends}/${r3.ticks} sends, ${r3.lastN} pts`);

  const big = new ProjMapMesh(17, 17); big.setCurve(1);
  const r4 = replay(big, 30);
  console.log(`       idle curved 17x17: ${r4.sends} send(s) over ${r4.ticks} frames, ${r4.lastN} pts`);
  check('the gate is worth having at 17x17', r4.sends === 1 && r4.lastN > 1000,
    `${r4.sends} sends, ${r4.lastN} pts — without the gate that is ` +
    `${r4.lastN * 30} points posted over ${r4.ticks} idle frames`);
}

console.log(`\n${failures === 0 ? 'PASS' : `FAILED: ${failures}`}`);
process.exit(failures === 0 ? 0 : 1);
