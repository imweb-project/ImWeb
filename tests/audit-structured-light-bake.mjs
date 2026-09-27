/**
 * Structured-light bake audit — camera-space scan → projector-space maps.
 *
 * Runs on the shared synthetic rig (tests/lib/procam-sim.mjs). Two kinds of
 * input, deliberately: `exact()` feeds the bake the TRUE correspondence, so a
 * failure there is the bake's own; `scan()` feeds it the real decoder's
 * output, so a failure only there is the interaction with decode noise.
 *
 * The null is load-bearing (LEARNED: calibrate by the null): the empty wall
 * scanned twice must give zero relief and NO edges. That run is also what
 * sets the step threshold's footing — its measured relief noise is printed.
 *
 * Run:  node tests/audit-structured-light-bake.mjs
 */

import {
  invertToProjector, reliefFromReference, normalsFromRelief, edgeMasks,
  edt, signedDistance, bake,
} from '../src/core/StructuredLightBake.js';
import { rejectOutliers } from '../src/core/StructuredLight.js';
import { makeRig, rng, PW, PH, CW, CH } from './lib/procam-sim.mjs';

let failures = 0;
const check = (label, cond, detail = '') => {
  if (cond) { console.log(`  ok   ${label}`); }
  else { console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); failures++; }
};
const quant = (arr, f) => {
  const s = Float64Array.from(arr).sort();
  return s.length ? s[Math.min(s.length - 1, Math.floor(f * s.length))] : NaN;
};

// ── 1. Distance transforms ──────────────────────────────────────────────────
console.log('\nDistance transforms');
{
  const R = rng(5);
  let worst = 0, trials = 0;
  for (const thr of [2.0, 1.3, 0.0]) for (let t = 0; t < 3; t++) {
    const w = 23 + t, h = 17 + 2 * t;
    const mask = Uint8Array.from({ length: w * h }, () => (R() > thr ? 1 : 0));
    const pts = [];
    for (let p = 0; p < w * h; p++) if (mask[p]) pts.push([p % w, (p / w) | 0]);
    const d = edt(mask, w, h);
    for (let p = 0; p < w * h; p++) {
      const x = p % w, y = (p / w) | 0;
      let best = Infinity;
      for (const [qx, qy] of pts) best = Math.min(best, Math.hypot(qx - x, qy - y));
      if (best === Infinity ? d[p] !== Infinity : Math.abs(d[p] - best) > worst) {
        worst = best === Infinity ? Infinity : Math.abs(d[p] - best);
      }
    }
    trials++;
  }
  check(`edt equals brute force on ${trials} random masks (sparse to dense)`, worst < 1e-4, `worst ${worst}`);
  check('edt of an empty mask is Infinity everywhere', edt(new Uint8Array(12), 4, 3).every(v => v === Infinity));
  check('edt of a full mask is 0 everywhere', edt(new Uint8Array(12).fill(1), 4, 3).every(v => v === 0));

  const w = 64, h = 48, cx = 30.5, cy = 20.5, r = 12;
  const inside = new Uint8Array(w * h);
  for (let p = 0; p < w * h; p++) inside[p] = Math.hypot(p % w + 0.5 - cx, ((p / w) | 0) + 0.5 - cy) < r ? 1 : 0;
  const sdf = signedDistance(inside, w, h);
  let err = 0, signOk = true;
  for (let p = 0; p < w * h; p++) {
    const tru = Math.hypot(p % w + 0.5 - cx, ((p / w) | 0) + 0.5 - cy) - r;
    err = Math.max(err, Math.abs(sdf[p] - tru));
    if (inside[p] ? sdf[p] >= 0 : sdf[p] <= 0) signOk = false;
  }
  check('signed distance: negative inside, positive outside', signOk);
  check('signed distance of a disc within 1 px of the analytic one', err <= 1, `max err ${err.toFixed(3)}`);
}

// ── 2. Inversion to projector space ─────────────────────────────────────────
console.log('\nInversion (camera → projector space)');
const wall = makeRig({ bump: 0, gi: false });
const obj = makeRig({ gi: false });
const stepped = makeRig({ bump: 0, step: true, gi: false });

// Which projector pixels a camera actually sees, by forward-splatting an 8x8
// subsample of every lit camera pixel — independent of the rasteriser.
function seenByCamera(rig) {
  const hit = new Uint8Array(PW * PH);
  for (let v = 0; v < CH; v++) for (let u = 0; u < CW; u++) {
    if (rig.inShadow(u + 0.5, v + 0.5)) continue;
    for (let b = 0; b < 8; b++) for (let a = 0; a < 8; a++) {
      const [x, y] = rig.camToProj(u + (a + 0.5) / 8, v + (b + 0.5) / 8);
      const px = Math.floor(x), py = Math.floor(y);
      if (px >= 0 && py >= 0 && px < PW && py < PH) hit[py * PW + px] = 1;
    }
  }
  return hit;
}

function roundTrip(rig, inv) {
  const errs = [];
  for (let p = 0; p < PW * PH; p++) {
    if (!inv.valid[p]) continue;
    const [x, y] = rig.camToProj(inv.u[p], inv.v[p]);
    errs.push(Math.hypot(x - (p % PW + 0.5), y - (((p / PW) | 0) + 0.5)));
  }
  return { n: errs.length, med: quant(errs, 0.5), p99: quant(errs, 0.99) };
}

function coverage(inv, hit) {
  let miss = 0, seen = 0, falseFill = 0;
  for (let p = 0; p < PW * PH; p++) {
    if (hit[p]) { seen++; if (!inv.valid[p]) miss++; }
    else if (inv.valid[p]) falseFill++;
  }
  return { seen, miss, falseFill };
}

// A mesh through camera pixel CENTRES stops half a camera pixel short of the
// footprint the splat above counts — at every outline, and along both sides
// of a step, whose bridging triangles are (rightly) dropped. So a seen pixel
// may go unfilled for exactly two reasons: it is within 1 px of the unseen
// (rim), or only a bridging triangle would have covered it (seam). Anything
// else is a hole the inversion should not have left.
function unexplainedMisses(inv, bridged, hit) {
  const dUnseen = edt(Uint8Array.from(hit, h => (h ? 0 : 1)), PW, PH);
  let rim = 0, seam = 0, other = 0;
  for (let p = 0; p < PW * PH; p++) {
    if (!hit[p] || inv.valid[p]) continue;
    if (dUnseen[p] <= 1.5) rim++;
    else if (bridged.valid[p]) seam++;
    else other++;
  }
  return { rim, seam, other };
}

{
  const inv = invertToProjector(stepped.exact());
  const rt = roundTrip(stepped, inv);
  console.log(`       exact, stepped: round trip median ${rt.med.toFixed(4)} px, p99 ${rt.p99.toFixed(4)} px, maxEdge ${inv.maxEdge.toFixed(2)}`);
  check('round trip through the inverted map lands on the pixel (median < 0.1 px)', rt.n > 50000 && rt.med < 0.1, `${rt.med}`);
  check('round trip p99 < 0.5 px', rt.p99 < 0.5, `${rt.p99}`);

  const hit = seenByCamera(stepped);
  const c = coverage(inv, hit);
  const bridgedInv = invertToProjector(stepped.exact(), { maxEdge: Infinity });
  const bridged = coverage(bridgedInv, hit);
  const why = unexplainedMisses(inv, bridgedInv, hit);
  console.log(`       seen ${c.seen}, missed ${c.miss} (rim ${why.rim}, step seam ${why.seam}, other ${why.other}), false fills ${c.falseFill}; with bridging allowed: ${bridged.falseFill} false fills`);
  check('every unfilled seen pixel is a half-pixel rim or a step seam (other < 0.05%)',
    c.seen > 50000 && why.other < 0.0005 * c.seen, `${why.other}`);
  check('positive control: the rim and seam classes are populated', why.rim > 500 && why.seam > 100,
    `rim ${why.rim}, seam ${why.seam}`);
  check('separation: bridging triangles would paint the step gap (≥ 1000 false fills)', bridged.falseFill >= 1000,
    `${bridged.falseFill} — the step is not a test of anything`);
  check('does not paint what the camera cannot see (false fills < 0.3%)', c.falseFill < 0.003 * c.seen,
    `${c.falseFill}`);
}

{
  const res = obj.scan();
  rejectOutliers(res);
  const inv = invertToProjector(res);
  const rt = roundTrip(obj, inv);
  const c = coverage(inv, seenByCamera(obj));
  console.log(`       decoded, bump: round trip median ${rt.med.toFixed(3)} px, p99 ${rt.p99.toFixed(3)} px, coverage ${(100 - 100 * c.miss / c.seen).toFixed(2)}%`);
  check('decoded scan inverts to within 0.5 px median', rt.n > 50000 && rt.med < 0.5, `${rt.med}`);
  check('decoded scan p99 under 2 px', rt.p99 < 2, `${rt.p99}`);
  check('decoded scan covers ≥ 97% of what the camera sees', c.miss < 0.03 * c.seen, `${c.miss}/${c.seen}`);
}

// ── 3. Relief ───────────────────────────────────────────────────────────────
console.log('\nRelief');
const inv = (rig, seed) => {
  const r = rig.scan({}, seed);
  rejectOutliers(r);
  return invertToProjector(r);
};

let nullRel;
{
  nullRel = reliefFromReference(inv(wall, 1), inv(wall, 2));
  const vals = [], diffs = [];
  for (let p = 0; p < PW * PH; p++) {
    if (!nullRel.valid[p]) continue;
    vals.push(Math.abs(nullRel.relief[p]));
    if (p % PW + 1 < PW && nullRel.valid[p + 1]) diffs.push(Math.abs(nullRel.relief[p + 1] - nullRel.relief[p]));
  }
  const p99 = quant(vals, 0.99), med = quant(vals, 0.5), nd = quant(diffs, 0.999);
  console.log(`       null (wall vs wall): |relief| median ${med.toFixed(3)}, p99 ${p99.toFixed(3)}; neighbour diff p99.9 ${nd.toFixed(3)} (camera px)`);
  check('the null: wall scanned twice gives ~0 relief (median < 0.1, p99 < 1 camera px)',
    vals.length > 50000 && med < 0.1 && p99 < 1, `median ${med}, p99 ${p99}`);
  const n = normalsFromRelief(nullRel.relief, nullRel.valid, PW, PH);
  const e = edgeMasks(nullRel.relief, n, nullRel.valid, PW, PH);
  let steps = 0, creases = 0;
  for (let p = 0; p < PW * PH; p++) { if (e[4 * p + 2]) steps++; if (e[4 * p + 3]) creases++; }
  check('the null: no step or crease edges on a flat wall (default thresholds)', steps === 0 && creases === 0,
    `${steps} step, ${creases} crease pixels`);
}

{
  // The quiet null above cannot fail: at σ 1.5 no bit flips, and the decoder
  // snaps to projector pixels, so two scans agree to the bit. At σ 5 stripe-
  // edge bits DO flip between scans; this is the null that tests anything.
  const noisy = makeRig({ bump: 0, gi: false, sigma: 5 });
  const rel = reliefFromReference(inv(noisy, 11), inv(noisy, 12));
  const vals = [];
  let nonzero = 0;
  for (let p = 0; p < PW * PH; p++) if (rel.valid[p]) { vals.push(Math.abs(rel.relief[p])); if (rel.relief[p]) nonzero++; }
  const n = normalsFromRelief(rel.relief, rel.valid, PW, PH);
  const e = edgeMasks(rel.relief, n, rel.valid, PW, PH);
  let steps = 0, creases = 0;
  for (let p = 0; p < PW * PH; p++) { if (e[4 * p + 2]) steps++; if (e[4 * p + 3]) creases++; }
  console.log(`       noisy null (σ 5): ${nonzero} pixels differ, |relief| p99 ${quant(vals, 0.99).toFixed(3)}, p99.9 ${quant(vals, 0.999).toFixed(3)}; ${steps} step, ${creases} crease flags`);
  check('positive control: at σ 5 the two wall scans actually differ', nonzero > 100, `${nonzero}`);
  check('noisy null: relief p99 < 1 camera px', vals.length > 50000 && quant(vals, 0.99) < 1);
  check('noisy null: no step or crease flags', steps === 0 && creases === 0, `${steps} step, ${creases} crease`);
}

let exRel;
{
  exRel = reliefFromReference(invertToProjector(obj.exact()), invertToProjector(wall.exact()));
  const dec = reliefFromReference(inv(obj, 3), inv(wall, 4));
  let peak = -Infinity;
  const diffs = [];
  for (let p = 0; p < PW * PH; p++) {
    if (exRel.valid[p]) peak = Math.max(peak, exRel.relief[p]);
    if (exRel.valid[p] && dec.valid[p]) diffs.push(Math.abs(exRel.relief[p] - dec.relief[p]));
  }
  console.log(`       bump: true peak ${peak.toFixed(2)} camera px; decoded vs true |diff| median ${quant(diffs, 0.5).toFixed(3)}, p99 ${quant(diffs, 0.99).toFixed(3)}; axis [${dec.axis.map(a => a.toFixed(3))}]`);
  check('positive control: the bump has relief (true peak ≥ 8 camera px)', peak >= 8, `${peak}`);
  check('decoded relief matches the true relief (median |diff| < 0.3, p99 < 1.5)',
    diffs.length > 50000 && quant(diffs, 0.5) < 0.3 && quant(diffs, 0.99) < 1.5);
  check('auto axis finds the horizontal baseline', Math.abs(dec.axis[1]) < 0.1 && dec.axis[0] !== 0, `${dec.axis}`);
  check('auto sign makes the bump stand OUT (positive)', peak > 0 && quant(
    Array.from(dec.relief).filter(Number.isFinite), 0.999) > 5);
}

// ── 4. Normals ──────────────────────────────────────────────────────────────
console.log('\nNormals');
{
  const { relief, valid } = exRel;
  let pk = -1;
  for (let p = 0; p < PW * PH; p++) if (valid[p] && (pk < 0 || relief[p] > relief[pk])) pk = p;
  const n = normalsFromRelief(relief, valid, PW, PH);
  const at = (dx, dy) => { const p = pk + dy * PW + dx; return valid[p] ? [n[3 * p], n[3 * p + 1]] : [NaN, NaN]; };
  const R = at(28, 0), L = at(-28, 0), U = at(0, -28), D = at(0, 28), F = at(170, 0);
  console.log(`       peak (${pk % PW}, ${(pk / PW) | 0}); nx right ${R[0].toFixed(3)} left ${L[0].toFixed(3)}; ny above ${U[1].toFixed(3)} below ${D[1].toFixed(3)}; far ${F.map(v => v.toFixed(3))}`);
  check('normals right of the bump lean right, left of it lean left', R[0] > 0.1 && L[0] < -0.1);
  check('normals above the bump lean UP (y-up), below it down', U[1] > 0.1 && D[1] < -0.1);
  // Not a mirror check: the bump pushes projector x one way, so its relief
  // is skewed in projector space and the two flanks legitimately differ. The
  // normal is instead held to the analytic slope of the unsmoothed relief.
  let worst = 0, probes = 0;
  for (const [dx, dy] of [[28, 0], [-28, 0], [0, -28], [0, 28], [20, 20], [-20, -20]]) {
    const p = pk + dy * PW + dx;
    if (![p - 3, p + 3, p - 3 * PW, p + 3 * PW].every(q => valid[q])) continue;
    const gx = (relief[p + 3] - relief[p - 3]) / 6, gy = (relief[p + 3 * PW] - relief[p - 3 * PW]) / 6;
    const len = Math.hypot(gx, gy, 1);
    worst = Math.max(worst, Math.abs(n[3 * p] - (-gx / len)), Math.abs(n[3 * p + 1] - (gy / len)));
    probes++;
  }
  check('normals match the analytic slope of the relief (within 0.03)', probes >= 5 && worst < 0.03,
    `worst ${worst.toFixed(4)} over ${probes} probes`);
  check('normals on the flat wall face the projector', Math.abs(F[0]) < 0.02 && Math.abs(F[1]) < 0.02, `${F}`);
}

// ── 5. Edges and the full bake ──────────────────────────────────────────────
console.log('\nEdges');
{
  const b = bake(stepped.exact(), wall.exact());
  const { relief, valid, edges } = b;
  // Transition = a valid "band" pixel (relief above half the step) touching a
  // non-band or invalid pixel. Every one must be flagged step or silhouette.
  let half = 0;
  for (let p = 0; p < PW * PH; p++) if (valid[p]) half = Math.max(half, relief[p]);
  half /= 2;
  const band = (p) => valid[p] && relief[p] > half;
  let trans = 0, flagged = 0;
  const hi = new Uint8Array(PW * PH), lo = new Uint8Array(PW * PH);
  for (let y = 0; y < PH; y++) for (let x = 0; x < PW; x++) {
    const p = y * PW + x;
    if (band(p)) hi[p] = 1; else lo[p] = 1;
    if (!band(p)) continue;
    const touches = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => {
      const xx = x + dx, yy = y + dy;
      return xx >= 0 && yy >= 0 && xx < PW && yy < PH && !band(yy * PW + xx);
    });
    if (!touches) continue;
    trans++;
    if (edges[4 * p + 1] || edges[4 * p + 2]) flagged++;
  }
  console.log(`       step band: half-height ${half.toFixed(2)} camera px, ${trans} transition pixels, ${flagged} flagged`);
  check('positive control: the step band exists and has an outline', half > 5 && trans > 200, `${half}, ${trans}`);
  check('every band transition is flagged step or silhouette', flagged === trans, `${flagged}/${trans}`);
  const dHi = edt(hi, PW, PH), dLo = edt(lo, PW, PH);
  let stray = 0, steps = 0;
  for (let p = 0; p < PW * PH; p++) {
    if (!(edges[4 * p + 2] || edges[4 * p + 3])) continue;
    steps++;
    if (dHi[p] > 3 || dLo[p] > 3) stray++;
  }
  check('no step or crease flags away from the step', steps > 0 && stray === 0, `${stray} of ${steps}`);

  // Both sides of the step are flat planes, so every normal — including the
  // pixels right beside the step — must face the projector. A gradient taken
  // ACROSS the step tilts exactly those pixels: a 1-px mis-lit line along
  // every edge, invisible to the crease check because it sits on the step.
  let tilt = 0, besideStep = 0;
  for (let p = 0; p < PW * PH; p++) {
    if (!valid[p]) continue;
    tilt = Math.max(tilt, Math.hypot(b.normals[3 * p], b.normals[3 * p + 1]));
    if (edges[4 * p + 2]) besideStep++;
  }
  check('normals beside a step stay flat on flat planes (tilt < 0.1)', besideStep > 20 && tilt < 0.1,
    `max tilt ${tilt.toFixed(3)} (${besideStep} step pixels)`);

  let signBad = 0;
  for (let p = 0; p < PW * PH; p++) if ((b.sdf[p] < 0) !== !!valid[p]) signBad++;
  check('bake SDF is negative exactly on the valid surface', signBad === 0, `${signBad}`);
  check('bake edge distance is 0 on edges and finite elsewhere',
    b.edgeDist.every((d, p) => (edges[4 * p + 1] | edges[4 * p + 2] | edges[4 * p + 3] ? d === 0 : d > 0 && d < Infinity)));
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
