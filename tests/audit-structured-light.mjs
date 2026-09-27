/**
 * Structured-light audit — the Gray-code scan core against a synthetic
 * projector-camera rig.
 *
 * Why a simulator. The scan cannot be verified in automation (no camera, no
 * popup) and the owner's rig is not always set up, so the decoder is checked
 * against a scene whose answer is known: a keystoned camera view with a relief
 * bump, varying albedo, ambient light, sensor noise, a projector shadow, and a
 * concave corner where interreflection outshines the projector. Every
 * behavioural check is paired with a control that proves the scene can
 * separate the hypotheses (LEARNED 2026-09-22, 2026-09-26): the corner is
 * shown to break a naive decoder before the robust one is credited for
 * surviving it, and the settle gate is shown to have actually waited.
 *
 * Run:  node tests/audit-structured-light.mjs
 */

import {
  bitsFor, grayBit, grayToBinary, patternSet, patternUniforms,
  PATTERN_FRAG, GrayDecoder, rejectOutliers, SettleGate, cellMAD,
} from '../src/core/StructuredLight.js';
import { makeRig, rng, PW, PH, CW, CH, SIGMA, SHADOW } from './lib/procam-sim.mjs';

let failures = 0;
const check = (label, cond, detail = '') => {
  if (cond) { console.log(`  ok   ${label}`); }
  else { console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); failures++; }
};

// ── 1. Codes and the pattern set ────────────────────────────────────────────
console.log('\nGray code and pattern set');

let bitErr = 0;
for (let x = 0; x < 4096; x++) for (let k = 0; k < 12; k++) {
  if (grayBit(x, k) !== (((x ^ (x >> 1)) >> k) & 1)) bitErr++;
}
check('grayBit (shader form) equals the bitwise Gray code, x < 4096, k < 12', bitErr === 0, `${bitErr} mismatches`);

let rtErr = 0;
for (let x = 0; x < 4096; x++) if (grayToBinary(x ^ (x >> 1)) !== x) rtErr++;
check('grayToBinary inverts the Gray code', rtErr === 0, `${rtErr} mismatches`);

check('1080 rows need 11 bits, 1024 need 10, 1920 columns 11',
  bitsFor(1080) === 11 && bitsFor(1024) === 10 && bitsFor(1920) === 11);

const hd = patternSet(1920, 1080);
check('1920x1080 is 46 frames (white, black, 2x(11+11))', hd.length === 46, `got ${hd.length}`);
check('white and black come first', hd[0].kind === 'white' && hd[1].kind === 'black');
const pairsAdjacent = hd.slice(2).every((p, i, a) =>
  i % 2 ? (p.inv && a[i - 1].axis === p.axis && a[i - 1].bit === p.bit && !a[i - 1].inv) : !p.inv);
check('every pattern is immediately followed by its inverse', pairsAdjacent);
const bitsInOrder = hd.slice(2).map(p => p.bit);
check('finest bits first (separation bits arrive early)',
  bitsInOrder.every((b, i) => !i || b >= bitsInOrder[i - 1]));

check('pattern shader is highp', /precision\s+highp\s+float/.test(PATTERN_FRAG));
check('pattern shader counts rows from the top',
  PATTERN_FRAG.includes('floor(uRes.y - gl_FragCoord.y)'));
check('pattern shader uses the grayBit form with uP from JS',
  PATTERN_FRAG.includes('mod(floor((n + uP) / (2.0 * uP)), 2.0)') && !/exp2/.test(PATTERN_FRAG));
check('uniforms carry 2^bit exactly', patternUniforms({ kind: 'gray', axis: 1, bit: 10, inv: true }).uP === 1024);

// ── 2. Synthetic rig (tests/lib/procam-sim.mjs) ────────────────────────────
const { truth, inShadow, inCorner, inMild, scan } = makeRig();

function measure(res, where) {
  const errs = [];
  let valid = 0, total = 0, gross = 0;
  for (let v = 0; v < CH; v++) for (let u = 0; u < CW; u++) {
    if (!where(u, v)) continue;
    total++;
    const i = v * CW + u;
    if (!res.valid[i]) continue;
    valid++;
    const ex = Math.abs(res.x[i] - truth[2 * i]), ey = Math.abs(res.y[i] - truth[2 * i + 1]);
    const bx = 2 ** (bitsFor(PW) - res.bitsX[i]), by = 2 ** (bitsFor(PH) - res.bitsY[i]);
    if (ex > bx + 2 || ey > by + 2) gross++;
    errs.push(Math.max(ex, ey));
  }
  errs.sort((a, b) => a - b);
  const q = (f) => errs.length ? errs[Math.min(errs.length - 1, Math.floor(f * errs.length))] : NaN;
  return { total, valid, gross, cover: valid / (total || 1), med: q(0.5), p99: q(0.99) };
}

console.log('\nDecoder on the synthetic rig');
const robust = scan({});
const naive = scan({ robust: false });

const plain = (u, v) => !inShadow(u + 0.5, v + 0.5) && !inCorner(u, v) && !inMild(u, v)
  && (u - SHADOW.u) ** 2 + (v - SHADOW.v) ** 2 > (SHADOW.r + 2) ** 2;
const mp = measure(robust, plain);
console.log(`       plain region: ${(mp.cover * 100).toFixed(2)}% valid, median err ${mp.med.toFixed(3)} px, p99 ${mp.p99.toFixed(3)} px`);
check('positive control: ≥ 97% of the plain lit region decodes', mp.total > 40000 && mp.cover >= 0.97,
  `${mp.valid}/${mp.total}`);
check('median error under 0.75 projector px', mp.med < 0.75, `${mp.med}`);
check('no gross errors in the plain region', mp.gross === 0, `${mp.gross}`);

{
  // Overexposed: gain 600 puts every lit pixel at 288-588 before the sensor
  // clips it to 255 (albedo 0.45-0.95, ambient 18). A saturation rule once
  // rejected every clipped white and would score ~0 here; the
  // pattern/inverse comparison does not need the lost headroom.
  const hot = makeRig({ gain: 600, gi: false });
  const r = hot.scan();
  let clipped = 0, lit = 0;
  const white = hot.capture({ kind: 'white' }, () => 0);
  for (let v = 0; v < CH; v++) for (let u = 0; u < CW; u++) {
    if (hot.inShadow(u + 0.5, v + 0.5)) continue;
    lit++;
    if (white[v * CW + u] === 255) clipped++;
  }
  const valid = r.nValid / lit;
  console.log(`       overexposed: ${(100 * clipped / lit).toFixed(1)}% of lit pixels clip; ${(100 * valid).toFixed(2)}% decode`);
  check('control: the overexposed rig really clips (≥ 99% of lit pixels at 255)', clipped >= 0.99 * lit);
  check('an overexposed (clipped) scan still decodes ≥ 97% of the lit surface', valid >= 0.97, `${valid}`);
}

const ms = measure(robust, (u, v) => inShadow(u + 0.5, v + 0.5));
check('the null: nothing decodes inside the projector shadow', ms.total > 500 && ms.valid === 0,
  `${ms.valid}/${ms.total} valid`);

const cornerN = measure(naive, inCorner), cornerR = measure(robust, inCorner);
console.log(`       corner: naive ${cornerN.gross} gross / ${cornerN.valid} valid; robust ${cornerR.gross} gross / ${cornerR.valid} valid`);
check('separation: interreflection breaks the naive decoder in the corner', cornerN.gross >= 100,
  `only ${cornerN.gross} gross errors — the scene cannot tell the classifiers apart`);
// Strong interreflection is beyond Gray codes; the robust rule's job there is
// to DROP the region rather than guess — so this check alone could pass on a
// classifier that rejects all bounced light. The mild region below is its
// positive control.
check('robust classifier makes no gross errors in the corner', cornerR.total > 2000 && cornerR.gross === 0, `${cornerR.gross}`);
const mildR = measure(robust, inMild);
console.log(`       mild interreflection: robust ${(mildR.cover * 100).toFixed(2)}% valid, ${mildR.gross} gross, median ${mildR.med.toFixed(3)} px`);
check('positive control: mild interreflection still decodes (≥ 95%) with no gross errors',
  mildR.total > 2000 && mildR.cover >= 0.95 && mildR.gross === 0, `${mildR.valid}/${mildR.total}, ${mildR.gross} gross`);
const all = measure(robust, () => true);
check('no gross errors anywhere', all.gross === 0, `${all.gross}`);

// Outlier rejection: corrupt a scattered set, all of it must go, little else.
const corrupt = [];
for (let v = 10; v < CH - 10; v += 17) for (let u = 10; u < CW - 10; u += 23) {
  const i = v * CW + u;
  if (robust.valid[i] && plain(u, v)) { robust.x[i] += 100; corrupt.push(i); }
}
const before = robust.nValid;
const dropped = rejectOutliers(robust);
const caught = corrupt.filter(i => !robust.valid[i]).length;
check('outlier rejection removes every injected corruption', corrupt.length > 50 && caught === corrupt.length,
  `${caught}/${corrupt.length}`);
check('outlier rejection removes under 1% of good pixels', dropped - caught < 0.01 * before,
  `${dropped - caught} of ${before}`);

check('decoder refuses gray frames before the references', (() => {
  const d = new GrayDecoder({ camW: 2, camH: 1, projW: 64, projH: 64 });
  try { d.addFrame({ kind: 'gray', axis: 0, bit: 0, inv: false }, new Uint8Array(2)); return false; }
  catch { return true; }
})());

// ── 3. Settle gate ──────────────────────────────────────────────────────────
console.log('\nSettle gate');

// The plain per-pixel form cellMAD was optimised from, kept HERE as the
// reference: the fast one must match it bit for bit, including on sizes the
// cell grid does not divide evenly.
function cellMADRef(a, b, w, h, tw = 32, th = 18) {
  const out = new Float32Array(tw * th);
  const cnt = new Uint32Array(tw * th);
  for (let v = 0; v < h; v++) for (let u = 0; u < w; u++) {
    const t = Math.floor(v * th / h) * tw + Math.floor(u * tw / w);
    const i = v * w + u;
    out[t] += Math.abs(a[i] - b[i]);
    cnt[t]++;
  }
  for (let t = 0; t < out.length; t++) out[t] /= cnt[t] || 1;
  return out;
}
{
  let mismatches = 0, cases = 0;
  const R = rng(3);
  for (const [w, h, tw, th] of [[1280, 720, 32, 18], [321, 199, 32, 18], [160, 90, 32, 18], [97, 61, 7, 5]]) {
    const a = Uint8Array.from({ length: w * h }, () => Math.max(0, Math.min(255, 128 + 60 * R())));
    const b = Uint8Array.from({ length: w * h }, () => Math.max(0, Math.min(255, 128 + 60 * R())));
    const f = cellMAD(a, b, w, h, tw, th), r = cellMADRef(a, b, w, h, tw, th);
    for (let t = 0; t < f.length; t++) if (f[t] !== r[t]) mismatches++;
    cases++;
  }
  check(`cellMAD is bit-equal to the plain form on ${cases} sizes, even and uneven`, mismatches === 0, `${mismatches} cells differ`);
}
const GW = 160, GH = 90;
const stripes = (period, phase) => {
  const f = new Uint8Array(GW * GH);
  for (let v = 0; v < GH; v++) for (let u = 0; u < GW; u++) f[v * GW + u] = ((u + phase) % period) < period / 2 ? 200 : 30;
  return f;
};
const noisy = (f, noise) => Uint8Array.from(f, x => Math.max(0, Math.min(255, Math.round(x + SIGMA * noise()))));
// A rolling-shutter frame read out across the switch: rows above `row` new.
const torn = (oldF, newF, row) => Uint8Array.from(oldF, (x, i) => (Math.floor(i / GW) < row ? newF[i] : x));

let wrongAccepts = 0, waited = true, cases = 0;
// 88 of 90: a tear confined to the LAST row of cells — the smallest tear
// there is, and the one the gate's moving-cell allowance must not swallow.
for (let L = 0; L <= 6; L++) for (const row of [10, 45, 80, 88]) {
  const noise = rng(99 + L * 7 + row);
  const oldF = stripes(4, 0), newF = stripes(4, 2);          // a fine pattern and its inverse
  const g = new SettleGate({ w: GW, h: GH, latency: L + 1 });   // measured: L old + the tear
  g.begin(noisy(oldF, noise));
  const stream = [];
  for (let k = 0; k < L; k++) stream.push(['old', noisy(oldF, noise)]);
  stream.push(['torn', noisy(torn(oldF, newF, row), noise)]);
  for (let k = 0; k < 6; k++) stream.push(['new', noisy(newF, noise)]);
  let got = null, at = 0;
  for (const [kind, f] of stream) { at++; if (g.push(f).accept) { got = kind; break; } }
  cases++;
  if (got !== 'new') wrongAccepts++;
  if (at < L + 3) waited = false;   // old frames, the tear, then TWO new ones
}
check(`never accepts an old or torn frame (${cases} latency × tear cases)`, wrongAccepts === 0, `${wrongAccepts} wrong`);
check('positive control: the gate waited past the latency and the tear', waited);

{
  // Local flicker: a patch of cells that changes EVERY frame (a person in a
  // corner, a TV, a flickering sensor pixel). Under the allowance it must not
  // stall the scan, and must never let an old or torn frame through; over it
  // the gate must hold out to its timeout rather than accept anything early.
  const flicker = (f, cellsWide, k) => {
    const out = Uint8Array.from(f);
    const pw = Math.round(cellsWide * GW / 32), ph = Math.round(GH / 18);
    for (let v = 0; v < ph; v++) for (let u = 0; u < pw; u++) out[v * GW + u] = (k + u + v) & 1 ? 255 : 0;
    return out;
  };
  const runFlicker = (cellsWide) => {
    const noise = rng(123 + cellsWide);
    const oldF = stripes(4, 0), newF = stripes(4, 2);
    const g = new SettleGate({ w: GW, h: GH, latency: 4, maxFrames: 30 });
    let k = 0;
    g.begin(flicker(noisy(oldF, noise), cellsWide, k++));
    const stream = [];
    for (let i = 0; i < 3; i++) stream.push(['old', flicker(noisy(oldF, noise), cellsWide, k++)]);
    stream.push(['torn', flicker(noisy(torn(oldF, newF, 60), noise), cellsWide, k++)]);
    for (let i = 0; i < 40; i++) stream.push(['new', flicker(noisy(newF, noise), cellsWide, k++)]);
    for (const [kind, f] of stream) { const r = g.push(f); if (r.accept) return { kind, ...r }; }
    return null;
  };
  const small = runFlicker(10);   // 10 cells of 576: 1.7%, under 0.4/18 = 2.2%
  const big = runFlicker(32);     // a full row of cells: 5.6%
  console.log(`       flicker 10 cells: accepted a ${small?.kind} frame at ${small?.frames}; flicker 32 cells: ${big?.timedOut ? 'held to the timeout' : `accepted a ${big?.kind} frame`}`);
  check('a flickering patch under the allowance does not stall the gate, and it accepts a NEW frame', small?.kind === 'new' && small.changed && !small.timedOut,
    JSON.stringify(small));
  check('a flickering patch over the allowance holds the gate to its timeout (never an early accept)', big?.timedOut === true,
    JSON.stringify(big));
}

check('the gate refuses to run without a measured latency', (() => {
  try { new SettleGate({ w: GW, h: GH }); return false; } catch { return true; }
})());

{
  // Pattern the camera cannot tell from the last one: quiet accept, flagged.
  const noise = rng(7);
  const same = stripes(4, 0);
  const g = new SettleGate({ w: GW, h: GH, latency: 4, quietRun: 3 });
  g.begin(noisy(same, noise));
  let r = null;
  for (let k = 0; k < 20 && !(r?.accept); k++) r = g.push(noisy(same, noise));
  check('an indistinguishable pattern is accepted quietly after the latency, flagged unchanged',
    r?.accept && r.changed === false && !r.timedOut && r.frames > 4, JSON.stringify(r));
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
