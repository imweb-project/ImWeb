/**
 * Auto projection map audit — fitting ProjMapMesh from a structured-light scan.
 *
 * The claim under test: with the camera at the audience's position, the fitted
 * mesh puts every content point where the camera needs to see it. The residual
 * (fitted mesh, sampled through ProjMapMesh.sample() — the renderer's surface —
 * against the decoded correspondence) IS that claim, in projector pixels.
 *
 * Exactness first, on a camera→projector map that is a true homography: a
 * flat wall is exactly one projective quad, so a 2x2 fit must recover it to
 * rounding and any finer grid must reproduce it too (ProjMapMesh cells are
 * projective, so nodes ON a homography reproduce it). Then the simulated rig's
 * bump, which no 2x2 can follow — the positive control that grid size matters.
 *
 * Run:  node tests/audit-structured-light-fit.mjs
 */

import { fitHomography, fitProjectionMesh, fitAuto, meshResidual } from '../src/core/StructuredLightFit.js';
import { rejectOutliers } from '../src/core/StructuredLight.js';
import { ProjMapMesh } from '../src/inputs/ProjMapMesh.js';
import { makeRig, PW, PH, CW, CH } from './lib/procam-sim.mjs';

let failures = 0;
const check = (label, cond, detail = '') => {
  if (cond) { console.log(`  ok   ${label}`); }
  else { console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); failures++; }
};

// The test's OWN projective map. Not the module's applyH: truth derived from
// the code under test breaks in step with it — a mutation that made applyH
// affine passed every check here while it was imported.
const refH = (H, u, v) => {
  const w = H[6] * u + H[7] * v + H[8];
  return [(H[0] * u + H[1] * v + H[2]) / w, (H[3] * u + H[4] * v + H[5]) / w];
};

// A keystoned, slightly rotated wall: a genuine homography camera → projector.
const HT = [1.31, 0.06, 38, -0.04, 1.18, 22, 0.00031, 0.00042, 1];

function homographyScan(quantise, H = HT, cw = CW, ch = CH, pw = PW, ph = PH) {
  const x = new Float32Array(cw * ch), y = new Float32Array(cw * ch), valid = new Uint8Array(cw * ch).fill(1);
  for (let v = 0; v < ch; v++) for (let u = 0; u < cw; u++) {
    const i = v * cw + u;
    const [px, py] = refH(H, u + 0.5, v + 0.5);
    // The decoder returns pixel CENTRES; quantising the same way is what a
    // perfect decode of this wall would give.
    x[i] = quantise ? Math.floor(px) + 0.5 : px;
    y[i] = quantise ? Math.floor(py) + 0.5 : py;
  }
  return { camW: cw, camH: ch, projW: pw, projH: ph, x, y, valid, nValid: cw * ch };
}

const cornersErr = (H, Ht = HT, cw = CW, ch = CH) => Math.max(...[[0, 0], [cw, 0], [cw, ch], [0, ch]].map(([u, v]) => {
  const a = refH(H, u, v), b = refH(Ht, u, v);
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}));

// ── 1. Exactness on a flat wall ─────────────────────────────────────────────
console.log('\nFlat wall (a true homography)');
{
  const exact = homographyScan(false);
  const H = fitHomography(exact);
  check('fitHomography recovers the wall (frame corners within 1e-6 px)', cornersErr(H) < 1e-6, `${cornersErr(H)}`);
  const f2 = fitProjectionMesh(exact, { cols: 2, rows: 2 });
  const f5 = fitProjectionMesh(exact, { cols: 5, rows: 5 });
  const f9 = fitProjectionMesh(exact, { cols: 9, rows: 5 });
  console.log(`       residual max: 2x2 ${f2.residual.max.toExponential(2)}, 5x5 ${f5.residual.max.toExponential(2)}, 9x5 ${f9.residual.max.toExponential(2)} px`);
  check('2x2 reproduces the wall exactly (max residual < 1e-4 px)', f2.residual.n > 10000 && f2.residual.max < 1e-4);
  check('finer grids reproduce it too — local fits land ON the homography (max < 0.01 px)',
    f5.residual.max < 0.01 && f9.residual.max < 0.01, `${f5.residual.max}, ${f9.residual.max}`);
  check('no node is extrapolated on a fully visible wall', f5.extrapolated.length === 0 && f9.extrapolated.length === 0);

  // Quantised to pixel centres, as a perfect decode would be. The residual
  // then has a FLOOR: even the true wall scores ~0.61 px p95 against its own
  // quantised decode. Assert against that floor, measured, not a guessed number.
  const q = homographyScan(true);
  const Hq = fitHomography(q);
  const fq = fitProjectionMesh(q, { cols: 5, rows: 5 });
  const floor = meshResidual(f2.mesh, q).p95;   // the exact wall's own mesh vs quantised data
  console.log(`       quantised to pixel centres: corners ${cornersErr(Hq).toFixed(3)} px; 5x5 p95 ${fq.residual.p95.toFixed(3)} px vs floor ${floor.toFixed(3)} px`);
  check('quantised decode: homography corners within 0.3 px', cornersErr(Hq) < 0.3, `${cornersErr(Hq)}`);
  check('quantised decode: 5x5 p95 within 0.02 px of the quantisation floor', fq.residual.p95 <= floor + 0.02,
    `${fq.residual.p95} vs ${floor}`);

  // Real sizes: a 1280x720 camera onto a 1920x1080 projector. The normal
  // equations of an UNnormalised DLT mix ~1e13 and 1 at this scale.
  const HB = [1.42, 0.05, 90, -0.03, 1.33, 40, 0.00012, 0.00017, 1];
  const big = homographyScan(false, HB, 1280, 720, 1920, 1080);
  const eb = cornersErr(fitHomography(big), HB, 1280, 720);
  const fb = fitProjectionMesh(big, { cols: 2, rows: 2 });
  console.log(`       1280x720 → 1920x1080: corners ${eb.toExponential(2)} px, 2x2 max ${fb.residual.max.toExponential(2)} px`);
  check('real-size rig: homography corners within 1e-4 px', eb < 1e-4, `${eb}`);

  // Gross decode errors that slipped past rejectOutliers: 3% of pixels thrown
  // 40-120 px. The trimming pass must keep them from tilting the wall.
  const dirty = homographyScan(false);
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
  for (let i = 0; i < dirty.x.length; i++) if (rnd() < 0.03) { dirty.x[i] += 40 + 80 * rnd(); dirty.y[i] -= 40 + 80 * rnd(); }
  const ed = cornersErr(fitHomography(dirty));
  console.log(`       3% gross outliers: homography corners ${ed.toFixed(4)} px`);
  check('3% gross outliers: homography corners within 0.05 px', ed < 0.05, `${ed}`);

  const back = new ProjMapMesh(2, 2);
  check('the fit deserializes into ProjMapMesh', back.deserialize(f9.mesh.serialize()) && back.cols === 9 && back.rows === 5);
  let knot = 0;
  for (let j = 0; j < 5; j++) for (let i = 0; i < 9; i++) {
    const s = f9.mesh.sample(i / 8, j / 4), p = f9.pts[j * 9 + i];
    knot = Math.max(knot, Math.hypot(s.x - p.x, s.y - p.y));
  }
  check('the mesh passes through the fitted nodes (sample at knots)', knot < 1e-12, `${knot}`);
  check('window fractions, y DOWN: node 0 is top-left of the last node',
    f9.pts[0].x < f9.pts[44].x && f9.pts[0].y < f9.pts[44].y);
}

// ── 2. A shaped surface, decoded ────────────────────────────────────────────
console.log('\nBumped surface, decoded through the real pipeline');
const rig = makeRig({ gi: false });
const res = rig.scan();
rejectOutliers(res);
{
  const rows = [2, 3, 5, 9, 17].map(n => ({ n, r: fitProjectionMesh(res, { cols: n, rows: n }).residual }));
  console.log('       grid   p95 px   rms px   max px');
  for (const { n, r } of rows) console.log(`       ${String(n).padStart(2)}x${String(n).padEnd(3)} ${r.p95.toFixed(3).padStart(6)}  ${r.rms.toFixed(3).padStart(6)}  ${r.max.toFixed(3).padStart(6)}`);
  const p = rows.map(x => x.r.p95);
  check('positive control: a 2x2 cannot follow the bump (p95 > 2 px)', p[0] > 2, `${p[0]}`);
  check('residual falls as the grid refines, 2 → 3 → 5 → 9', p[1] < p[0] && p[2] < p[1] && p[3] < p[2], p.map(v => v.toFixed(3)).join(' '));
  check('17x17 lands within 1 projector px (p95)', p[4] <= 1, `${p[4]}`);
}

{
  const f = fitProjectionMesh(res, { cols: 9, rows: 9 });
  let worst = 0, worstShadow = NaN;
  for (let j = 0; j < 9; j++) for (let i = 0; i < 9; i++) {
    const k = j * 9 + i;
    if (f.extrapolated.includes(k)) continue;
    const qu = CW * i / 8, qv = CH * j / 8;
    const [tx, ty] = rig.camToProj(qu, qv);
    const e = Math.hypot(f.pts[k].x * PW - tx, f.pts[k].y * PH - ty);
    worst = Math.max(worst, e);
    if (rig.inShadow(qu, qv)) worstShadow = e;
  }
  console.log(`       9x9 nodes vs ground truth: worst ${worst.toFixed(3)} px; the node inside the shadow ${worstShadow.toFixed(3)} px; extrapolated ${f.extrapolated.length}`);
  check('every fitted node is within 1 px of where the true surface puts it', worst < 1, `${worst}`);
  check('a node inside the projector shadow is still placed (from its surroundings) within 1 px',
    Number.isFinite(worstShadow) && worstShadow < 1, `${worstShadow}`);
}

{
  // At 17x17 SIX nodes sit inside the shadow and the spacing is small, so the
  // support radius has to grow well past the node spacing to surround them.
  // Capping it sent all six to the global homography, 2-3 px off — while
  // every other check here stayed green.
  const f = fitProjectionMesh(res, { cols: 17, rows: 17 });
  let worst = 0, inHole = 0;
  for (let j = 0; j < 17; j++) for (let i = 0; i < 17; i++) {
    const qu = CW * i / 16, qv = CH * j / 16;
    if (rig.inShadow(qu, qv)) inHole++;
    const [tx, ty] = rig.camToProj(qu, qv);
    const p = f.pts[j * 17 + i];
    worst = Math.max(worst, Math.hypot(p.x * PW - tx, p.y * PH - ty));
  }
  console.log(`       17x17: ${inHole} nodes inside the shadow, ${f.extrapolated.length} extrapolated, worst node ${worst.toFixed(3)} px`);
  check('17x17: nodes inside a hole are filled from around it, not extrapolated', inHole >= 4 && f.extrapolated.length === 0,
    `${f.extrapolated.length} extrapolated`);
  check('17x17: every node within 1 px of the true surface', worst < 1, `${worst}`);
}

{
  // Content target larger than the camera frame: the outer nodes have no data.
  const rect = { u0: -40, v0: -25, u1: CW + 40, v1: CH + 25 };
  const f = fitProjectionMesh(res, { cols: 9, rows: 9, rect });
  const finite = f.pts.every(p => Number.isFinite(p.x) && Number.isFinite(p.y));
  console.log(`       target beyond the frame: ${f.extrapolated.length} of 81 nodes extrapolated`);
  const outside = [];
  for (let j = 0; j < 9; j++) for (let i = 0; i < 9; i++) {
    const qu = rect.u0 + (rect.u1 - rect.u0) * i / 8, qv = rect.v0 + (rect.v1 - rect.v0) * j / 8;
    if (qu < 0 || qu > CW || qv < 0 || qv > CH) outside.push(j * 9 + i);
  }
  check('exactly the nodes beyond the camera frame are extrapolated, and reported',
    outside.length > 0 && JSON.stringify(f.extrapolated) === JSON.stringify(outside),
    `${f.extrapolated.length} reported, ${outside.length} outside`);
  check('every node is finite', finite);
  const inner = f.extrapolated.filter(k => { const i = k % 9, j = (k / 9) | 0; return i > 1 && i < 7 && j > 1 && j < 7; });
  check('interior nodes are not extrapolated', inner.length === 0, `${inner}`);
}

{
  const a = fitAuto(res, { tol: 1 });
  console.log(`       auto (tol 1 px): ${a.cols}x${a.rows}, p95 ${a.residual.p95.toFixed(3)}; tried ${a.tried.map(t => `${t.n}:${t.p95.toFixed(2)}`).join(' ')}`);
  check('auto picks the smallest grid that meets the tolerance', a.met && a.residual.p95 <= 1
    && a.tried.slice(0, -1).every(t => t.p95 > 1), JSON.stringify(a.tried));
  check('auto needed more than 2x2 on a shaped surface', a.cols > 2);
  check('meshResidual scores the returned mesh (same numbers)', meshResidual(a.mesh, res).p95 === a.residual.p95);
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
