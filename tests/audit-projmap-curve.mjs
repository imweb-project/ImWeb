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
console.log('\n§4 the border does not go slack (extrapolated ghosts, not clamped)');
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
  // Exact OR converging. Demanding a strict decrease was wrong: with the
  // quadratic end condition this case became exact, and three values sitting
  // at float noise are not ordered — so the check went red on code that had
  // just got better, which is the direction that teaches people to edit
  // audits (2026-09-13).
  const EXACT = 1e-12;
  check('curved subdivision is exact, or converges as the net gets finer',
    c5.worst < EXACT
      ? (c9.worst < EXACT && c17.worst < EXACT)
      : (c17.worst < c9.worst && c9.worst < c5.worst),
    `${c5.worst.toExponential(2)} -> ${c9.worst.toExponential(2)} -> ` +
    `${c17.worst.toExponential(2)}`);

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

  // ── the curve-handle wire, both ends ──
  check('main.js accepts a dragged handle from the output window',
    /projmesh-tangent/.test(main) && /projMesh\.setTangent\(/.test(main),
    'the handle would move on screen and change nothing');
  check('main.js accepts a handle RESET from the output window',
    /projMesh\.clearTangent\(/.test(main),
    'a dragged handle could never be put back');
  check('main.js posts the effective tangents',
    /projMesh\.tangent\(i, j, "u"\)/.test(main) && /\.tans = _pmTans/.test(main),
    'the popup cannot place a handle it was never told about');
  check('the output window draws handles and their arms',
    /class="th"/.test(main.replace(/\s+/g, ' ')) || /'th'/.test(main) ||
    /drawTanArms\(\)/.test(main),
    'no handle widget');
  // Anchored on the PROPERTY — the message carries a vector — not on which
  // variable holds the index. The first version pinned `i:selPt.i`, and went
  // red the day handles learned to belong to a point other than the selected
  // one, against correct code (LEARNED 2026-09-13: strict in the middle,
  // open-ended at the ends).
  check('the output window sends the tangent VECTOR, not a screen position',
    /type:'projmesh-tangent'[\s\S]{0,140}dx:dx,dy:dy/.test(main),
    'posting a position would put the 1/3 handle scale on both sides of the ' +
    'wire, and the two copies would drift');
  check('a handle edits ITS OWN point, not whichever is selected',
    /h\.i=t\.i; h\.j=t\.j;/.test(main) && /const hi=h\.i, hj=h\.j;/.test(main),
    'with every point showing handles, reading selPt would send every drag to ' +
    'the same point — the one you happened to click last');
  check('showing all handles follows the control points visibility rule',
    /isEdge\(i,j\)\|\|inSelCell\(i,j\)/.test(main) && /lastAllHandles/.test(main),
    'all N*M points would be 1156 circles at 17x17; tied to the visible ring ' +
    'the count grows with the perimeter instead');
  check('the All Handles button posts to the opener rather than holding a boolean',
    /projmap-handles-toggle/.test(main) && /projmap\.meshAllHandles/.test(main),
    'a local copy and the panel row would drift, which this subsystem has ' +
    'already paid for once');
  check('rebuilding the handle layer drops the curve handles with it',
    /ho\.innerHTML='';handles=\[\];tanHandles=\[\];/.test(main),
    'innerHTML= detaches the curve handles too, and an array still holding ' +
    'them positions elements that are no longer in the document — they stop ' +
    'appearing the moment the grid size changes, with nothing logged');
  check('the opener fills tangents row-major and the popup reads them so',
    /for \(let j = 0; j < projMesh\.rows; j\+\+\) \{[\s\S]{0,120}for \(let i = 0; i < projMesh\.cols; i\+\+\)/.test(main) &&
    /lastTans\[j\*lastMesh\.cols\+i\]/.test(main),
    'a transposed read puts every handle on the wrong point, which on a ' +
    'symmetric net looks like a subtle bug rather than an index error');
  // The Bezier 1/3 factor must live in exactly ONE place. Two copies is how
  // the handle ends up somewhere the surface is not.
  const thirds = (main.match(/\/3\b/g) ?? []).length;
  check('the 1/3 handle scale appears only in the popup drawing and its inverse',
    thirds > 0 && thirds <= 8, `${thirds} occurrences of /3 in main.js`);
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

// ── 12. The basis swap is the SAME surface ───────────────────────────────
console.log('\n§12 Hermite with derived tangents == the Catmull-Rom it replaced');
{
  // This is the one duplicate in the file, and it is deliberate. The sampler
  // moved from a Catmull-Rom basis to a Hermite one so that a handle could
  // replace a tangent — a change to shipped geometry that nothing else would
  // have caught, because both bases look equally plausible in review. Where a
  // duplicate is genuinely unavoidable, assert the equality (2026-09-22).
  const cr = (p0, p1, p2, p3, t) => {
    const t2 = t * t, t3 = t2 * t;
    return 0.5 * ((2 * p1) + (-p0 + p2) * t
      + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2
      + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
  };
  const crSample = (m, u, v) => {
    const C = m.cols, R = m.rows;
    const gu = u * (C - 1), gv = v * (R - 1);
    const cu = Math.max(0, Math.min(C - 2, Math.floor(gu)));
    const cv = Math.max(0, Math.min(R - 2, Math.floor(gv)));
    const lu = gu - cu, lv = gv - cv;
    const rx = [], ry = [];
    for (let n = -1; n <= 2; n++) {
      const a = m._ctl(cu - 1, cv + n), b = m._ctl(cu,     cv + n);
      const c = m._ctl(cu + 1, cv + n), d = m._ctl(cu + 2, cv + n);
      rx.push(cr(a.x, b.x, c.x, d.x, lu));
      ry.push(cr(a.y, b.y, c.y, d.y, lu));
    }
    return { x: cr(rx[0], rx[1], rx[2], rx[3], lv),
             y: cr(ry[0], ry[1], ry[2], ry[3], lv) };
  };

  let worst = 0, probes = 0;
  for (const [C, R] of [[3, 3], [5, 4], [9, 9], [17, 17]]) {
    const m = new ProjMapMesh(); m.setCorners(KEYSTONE); m.setGrid(C, R);
    m.setPoint(1, 1, 0.42, 0.30);
    if (C > 3) m.setPoint(2, 2, 0.61, 0.58);
    for (const [u, v] of PROBES) {
      const a = m._sampleSpline(u, v), b = crSample(m, u, v);
      worst = Math.max(worst, Math.abs(a.x - b.x), Math.abs(a.y - b.y));
      probes++;
    }
  }
  check('probed a non-empty grid across four net sizes',
    probes === N_PROBES * 4, `${probes}`);
  check('an untouched mesh samples identically in either basis', worst < 1e-14,
    `worst ${worst.toExponential(2)} — the surface moved when the basis did`);
  // The twist term is what makes that true. Zeroing it is the usual shortcut
  // and produces a DIFFERENT surface, so prove the difference is visible —
  // otherwise the check above passes for the wrong reason.
  const m2 = new ProjMapMesh(); m2.setCorners(KEYSTONE); m2.setGrid(3, 3);
  m2.setPoint(1, 1, 0.42, 0.30);
  const realTwist = m2._twist(1, 1);
  check('the twist term is non-zero on a shaped net, so §12 is not vacuous',
    Math.hypot(realTwist.x, realTwist.y) > 1e-3,
    `|twist| ${Math.hypot(realTwist.x, realTwist.y).toExponential(2)}`);
}

// ── 13. Tangent overrides ────────────────────────────────────────────────
console.log('\n§13 a dragged handle bends the surface and nothing else');
{
  const build = () => {
    const m = new ProjMapMesh(3, 3);
    m.setPoint(1, 1, 0.42, 0.30);
    m.setCurve(1);
    return m;
  };
  const plain = build();
  const bent = build();
  bent.setTangent(1, 0, 'u', 0.05, -0.35);

  check('a fresh mesh overrides nothing', plain.tangentCount === 0,
    `${plain.tangentCount}`);
  check('setTangent records one override', bent.tangentCount === 1,
    `${bent.tangentCount}`);
  check('tangent() reports an override as explicit',
    bent.tangent(1, 0, 'u').explicit === true &&
    plain.tangent(1, 0, 'u').explicit === false);

  let sep = 0, probes = 0, knotWorst = 0;
  for (const [u, v] of PROBES) {
    const a = plain.sample(u, v), b = bent.sample(u, v);
    sep = Math.max(sep, Math.hypot(b.x - a.x, b.y - a.y));
    probes++;
  }
  check('probed a non-empty grid for the handle effect', probes === N_PROBES, `${probes}`);
  check('a dragged handle visibly bends the surface', sep > 0.02,
    `separation ${sep.toExponential(2)} — with none, every check here is vacuous`);

  for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) {
    const p = bent.get(i, j), q = bent.sample(i / 2, j / 2);
    knotWorst = Math.max(knotWorst, Math.abs(q.x - p.x), Math.abs(q.y - p.y));
  }
  check('control points are STILL interpolated exactly with a handle dragged',
    knotWorst < 1e-12, `worst ${knotWorst.toExponential(2)} — a handle must ` +
    'bend the curve between points, never move the points themselves');

  check('overriding u leaves the v tangent at that point derived',
    bent.tangent(1, 0, 'v').explicit === false);

  // Locality: a tangent at (1,0) must not reach the far side of the net.
  let farSide = 0;
  for (const [u, v] of PROBES) {
    if (v < 0.5) continue;                       // only the row away from it
    const a = plain.sample(u, v), b = bent.sample(u, v);
    farSide = Math.max(farSide, Math.hypot(b.x - a.x, b.y - a.y));
  }
  check('a handle reaches its own spans, not the whole surface', farSide < sep / 2,
    `far side ${farSide.toExponential(2)} vs peak ${sep.toExponential(2)}`);

  // Clearing must restore the derived surface EXACTLY, or "undo" is a reshape.
  bent.clearTangent(1, 0, 'u');
  check('clearTangent removes the entry entirely', bent.tangentCount === 0,
    `${bent.tangentCount}`);
  let back = 0;
  for (const [u, v] of PROBES) {
    const a = plain.sample(u, v), b = bent.sample(u, v);
    back = Math.max(back, Math.hypot(b.x - a.x, b.y - a.y));
  }
  check('clearing a handle restores the derived surface exactly', back === 0,
    `worst ${back.toExponential(2)}`);

  // Tangents mean nothing on a flat surface, and must not leak into one.
  const flat = build(); flat.setCurve(0);
  flat.setTangent(1, 0, 'u', 0.05, -0.35);
  const flatRef = build(); flatRef.setCurve(0);
  let leak = 0;
  for (const [u, v] of PROBES) {
    const a = flatRef.sample(u, v), b = flat.sample(u, v);
    leak = Math.max(leak, Math.hypot(b.x - a.x, b.y - a.y));
  }
  check('a handle has no effect at curve 0', leak === 0, `worst ${leak.toExponential(2)}`);
}

// ── 14. Persistence, resize and the crossfade ────────────────────────────
console.log('\n§14 handles survive a save, and do not survive a resize');
{
  const m = new ProjMapMesh(3, 3);
  m.setPoint(1, 1, 0.42, 0.30);
  m.setCurve(1);

  const clean = m.serialize();
  check('a mesh with no handles writes no tans key at all', !('tans' in clean),
    'an older build must still read a mesh shaped without handles');

  m.setTangent(1, 0, 'u', 0.05, -0.35);
  m.setTangent(0, 1, 'v', -0.11, 0.22);
  const d = m.serialize();
  check('a mesh with handles writes them', !!d.tans && Object.keys(d.tans).length === 2,
    `${d.tans ? Object.keys(d.tans).length : 0} entries`);

  const round = new ProjMapMesh();
  round.curve = 1;
  check('deserialize accepts the round trip', round.deserialize(d) === true);
  check('the round trip preserves both overrides', round.tangentCount === 2,
    `${round.tangentCount}`);
  let rt = 0, probes = 0;
  for (const [u, v] of PROBES) {
    const a = m.sample(u, v), b = round.sample(u, v);
    rt = Math.max(rt, Math.hypot(b.x - a.x, b.y - a.y));
    probes++;
  }
  check('probed a non-empty grid across the round trip', probes === N_PROBES, `${probes}`);
  check('the reloaded mesh is the same surface', rt < 1e-6,
    `worst ${rt.toExponential(2)} (serialize rounds to 6 decimals)`);

  // A file that names a point the net does not have must not be trusted.
  const junk = new ProjMapMesh();
  junk.deserialize({ cols: 3, rows: 3, pts: d.pts, tans: { 99: { u: [1, 1] }, 4: { u: [0.1, 0.1] } } });
  check('deserialize drops a tangent on an index the net has no point for',
    junk.tangentCount === 1, `${junk.tangentCount} — 99 is outside a 3x3`);

  // A resize re-keys every index, so overrides cannot come with it.
  const resized = new ProjMapMesh(3, 3);
  resized.setCurve(1);
  resized.setTangent(1, 0, 'u', 0.05, -0.35);
  resized.setGrid(5, 5);
  check('setGrid drops overrides rather than re-keying them by luck',
    resized.tangentCount === 0, `${resized.tangentCount}`);

  // A crossfade between two shapes that carry handles.
  const store = {};
  globalThis.localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
  };
  const target = new ProjMapMesh(3, 3);
  target.setPoint(1, 1, 0.30, 0.68);
  target.setTangent(1, 0, 'u', -0.20, 0.30);
  target.save(5);

  const live = new ProjMapMesh(3, 3);
  live.setPoint(1, 1, 0.42, 0.30);
  live.setCurve(1);
  live.setTangent(1, 0, 'u', 0.05, -0.35);
  check('beginMorph accepts a slot that carries handles', live.beginMorph(5, 2) === true);
  live.tickMorph(1);                       // halfway
  check('the tangents are pinned explicitly mid-fade', live.tangentCount > 0,
    'a derived tangent would chase the moving points instead of travelling');
  live.tickMorph(1);                       // land
  check('the crossfade completes', live.morphing === false);
  check('it lands on the TARGET handle set, not the one it started with',
    live.tangentCount === 1 &&
    Math.abs(live.tangent(1, 0, 'u').x - (-0.20)) < 1e-9,
    `u tangent ${live.tangent(1, 0, 'u').x}`);

  // And a target with NO handles must land with none, rather than inheriting
  // a frozen copy of the shape it faded from.
  const plainTarget = new ProjMapMesh(3, 3);
  plainTarget.setPoint(1, 1, 0.55, 0.55);
  plainTarget.save(6);
  const live2 = new ProjMapMesh(3, 3);
  live2.setCurve(1);
  live2.setTangent(1, 0, 'u', 0.05, -0.35);
  live2.beginMorph(6, 2);
  live2.tickMorph(2);
  check('fading to a handle-less shape leaves no handles behind',
    live2.tangentCount === 0, `${live2.tangentCount}`);
  delete globalThis.localStorage;
}

// ── 15. Nothing non-finite may ever reach a vertex buffer ────────────────
console.log('\n§15 a bad tangent cannot fault the GPU');
{
  // This is not hypothetical and not defensive tidiness. An unvalidated NaN
  // tangent put 456 of 625 render-net vertices non-finite; a Float32Array of
  // NaN handed to drawArrays is a driver fault, and Chrome runs ONE GPU
  // process for every window — so the output window taking that fault lost
  // the MAIN window's WebGL context and the whole instrument went black from
  // a single handle drag. The popup divides by `window.innerWidth`, which is
  // 0 for a frame while a window goes fullscreen, so Infinity was one resize
  // away the entire time this shipped.
  const build = () => {
    const m = new ProjMapMesh(3, 3);
    m.setPoint(1, 1, 0.42, 0.30);
    m.setCurve(1);
    return m;
  };

  const rejected = [];
  for (const [dx, dy, label] of [
    [NaN, 0, 'NaN'], [0, NaN, 'NaN in y'],
    [Infinity, 0, 'Infinity'], [0, -Infinity, '-Infinity'],
    [undefined, 0, 'undefined'],
  ]) {
    const m = build();
    rejected.push([label, m.setTangent(1, 0, 'u', dx, dy) === false && m.tangentCount === 0]);
  }
  check('probed a non-empty set of bad tangents', rejected.length === 5, `${rejected.length}`);
  check('setTangent refuses every non-finite vector',
    rejected.every(r => r[1]),
    `accepted: ${rejected.filter(r => !r[1]).map(r => r[0]).join(', ')}`);

  // Huge but finite is clamped rather than refused — a drag can legitimately
  // leave the window, and refusing would make the handle stick.
  const big = build();
  check('a huge finite tangent is accepted', big.setTangent(1, 0, 'u', 900, -900) === true);
  const t = big.tangent(1, 0, 'u');
  check('a huge finite tangent is CLAMPED, not stored raw',
    Math.hypot(t.x, t.y) <= 4 + 1e-9 && Math.hypot(t.x, t.y) > 3,
    `|T| = ${Math.hypot(t.x, t.y)}`);

  // The vertex boundary holds even against a mesh corrupted past the setters.
  const forced = build();
  forced.tans[forced.idx(1, 0)] = { u: [NaN, 0] };
  const net = forced.renderNet(forced.renderSub());
  const bad = net.pts.filter(p => !Number.isFinite(p.x) || !Number.isFinite(p.y)).length;
  check('renderNet emits a non-empty net', net.pts.length > 100, `${net.pts.length}`);
  check('renderNet emits NO non-finite vertex even from a corrupted mesh',
    bad === 0, `${bad} of ${net.pts.length} — this is the line the GPU is behind`);
  // ...and prove the corruption was real, or the check above is vacuous.
  check('the forced corruption does reach sample(), so §15 is not vacuous',
    !Number.isFinite(forced.sample(0.25, 0.0).x),
    'the planted NaN never affected the surface, so nothing was guarded');

  const loaded = new ProjMapMesh();
  loaded.deserialize({ cols: 3, rows: 3,
    pts: [[0,0],[0.5,0],[1,0],[0,0.5],[0.5,0.5],[1,0.5],[0,1],[0.5,1],[1,1]],
    tans: { 1: { u: [NaN, 0] }, 3: { v: [1e400, 0] }, 4: { u: [0.1, 0.1] } } });
  check('deserialize drops non-finite tangents and keeps the good one',
    loaded.tangentCount === 1, `${loaded.tangentCount} — a file, a hand edit ` +
    'or an in-memory copy that never went through JSON can all carry one');

  const main15 = sanitizeSource(readFileSync('src/main.js', 'utf8'), false);
  check('the output window refuses to draw a net it cannot trust',
    /if\(!isFinite\(pos\[n\]\)\)/.test(main15),
    'the CSS fallback is a worse picture; a driver fault is a dead browser');
  check('the popup never divides by a zero viewport',
    /window\.innerWidth\|\|1/.test(main15),
    'innerWidth is 0 for a frame during a fullscreen transition');
  check('there is a way back from a mesh whose handles are wrong',
    /projmap\.meshHandlesClear/.test(main15) && /clearTangents\(\)/.test(main15),
    'otherwise recovery means resizing the grid and losing the shape');
}

// ── 16. The end condition, measured the way it was chosen ────────────────
console.log('\n§16 a bow is a bow, not two straights and a corner');
{
  // The owner's report was "it is not making a perfect bow when wanted, has a
  // bit of a corner to it". The number behind that is how much the TURN RATE
  // varies along a bowed edge: a true circular arc is 1.0x, and the shipped
  // linear end condition gave 12.2x — the edge left each corner aimed straight
  // at the next point and did all its bending in the middle. That is not a
  // matter of taste, it is a measurable property of the end tangent, so it is
  // asserted rather than eyeballed.
  const bowed = () => {
    const m = new ProjMapMesh(3, 3);
    m.setCurve(1);
    m.pts[1] = { x: 0.5, y: -0.18 };      // raise the top-middle point
    return m;
  };
  const turnRatio = (m) => {
    const dir = (u) => {
      const e = 1e-4;
      const a = m.sample(u - e, 0), b = m.sample(u + e, 0);
      return Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI;
    };
    const rates = [];
    for (let i = 1; i < 10; i++) {
      const u = i / 10;
      rates.push(Math.abs(dir(u + 0.005) - dir(u - 0.005)));
    }
    return { ratio: Math.max(...rates) / Math.min(...rates), n: rates.length };
  };
  const r = turnRatio(bowed());
  console.log(`       turn-rate variation along a bowed edge: ${r.ratio.toFixed(2)}x (a circle is 1.00x)`);
  check('sampled a non-empty set of points along the edge', r.n === 9, `${r.n}`);
  check('a bowed edge turns at a nearly constant rate', r.ratio < 3,
    `${r.ratio.toFixed(2)}x — the chord end condition scored 12.2x and was ` +
    'reported as "a bit of a corner"; anything near that is the same defect');

  // The quadratic ghost must not cost the flat case anything.
  const reg = new ProjMapMesh(3, 3); reg.setCurve(1);
  let idw = 0;
  for (const [u, v] of PROBES) {
    const p = reg.sample(u, v);
    idw = Math.max(idw, Math.abs(p.x - u), Math.abs(p.y - v));
  }
  check('a regular net is still exactly the identity map', idw < 1e-12,
    `worst ${idw.toExponential(2)}`);

  // Two points on an axis cannot fit a parabola, so that axis must fall back.
  const thin = new ProjMapMesh(2, 5);
  thin.setCurve(1);
  let thinBad = 0, thinW = 0;
  for (const [u, v] of PROBES) {
    const p = thin.sample(u, v);
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) thinBad++;
    thinW = Math.max(thinW, Math.abs(p.x - u), Math.abs(p.y - v));
  }
  check('a 2-wide net falls back to the linear ghost instead of reading past the end',
    thinBad === 0 && thin.cols === 2 && thin.rows === 5,
    `${thinBad} non-finite — _ctl(-1) would otherwise want a third column`);
  // And the fallback must be an EXTRAPOLATION, not a clamp. A clamped ghost
  // halves the end tangent, so the surface goes slack along that axis — on a
  // 2-wide net that is the whole of the u direction, and it would not show up
  // anywhere else in this file, because every other fixture has 3+ columns.
  check('the 2-wide fallback keeps a regular net the exact identity map',
    thinW < 1e-12, `worst ${thinW.toExponential(2)} — a clamped ghost gives ` +
    'half the chord, and the image compresses toward the border');

  // The docstring claims the axes commute. Assert it rather than assuming.
  const com = new ProjMapMesh(4, 4);
  com.setPoint(1, 1, 0.40, 0.28); com.setPoint(2, 2, 0.62, 0.71);
  const corner = com._ctl(-1, -1);
  const byRowsThenCols = (() => {
    const g = (i, j) => com._ctl(i, j);
    // extrapolate along j first, then along i, by hand
    const col = (i) => _q3(g(i, 0), g(i, 1), g(i, 2));
    return _q3(col(0), col(1), col(2));
  })();
  function _q3(a, b, c) {
    return { x: 3 * a.x - 3 * b.x + c.x, y: 3 * a.y - 3 * b.y + c.y };
  }
  check('a corner ghost is the same value whichever axis is extrapolated first',
    Math.abs(corner.x - byRowsThenCols.x) < 1e-12 &&
    Math.abs(corner.y - byRowsThenCols.y) < 1e-12,
    `${corner.x},${corner.y} vs ${byRowsThenCols.x},${byRowsThenCols.y}`);
}

console.log(`\n${failures === 0 ? 'PASS' : `FAILED: ${failures}`}`);
process.exit(failures === 0 ? 0 : 1);
