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
  bitsFor, grayBit, grayToBinary, patternSet, patternValue, patternUniforms,
  PATTERN_FRAG, GrayDecoder, rejectOutliers, SettleGate,
} from '../src/core/StructuredLight.js';

let failures = 0;
const check = (label, cond, detail = '') => {
  if (cond) { console.log(`  ok   ${label}`); }
  else { console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); failures++; }
};

// Deterministic noise: mulberry32 + Box-Muller.
function rng(seed) {
  let s = seed >>> 0;
  const u = () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return () => Math.sqrt(-2 * Math.log(u() || 1e-12)) * Math.cos(2 * Math.PI * u());
}

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

// ── 2. Synthetic rig ────────────────────────────────────────────────────────
const PW = 480, PH = 270, CW = 320, CH = 200;
const AMBIENT = 18, GAIN = 190, SIGMA = 1.5, KAPPA = 1.5, KERNEL = 32;
const SHADOW = { u: 250, v: 150, r: 18 };
const CORNER = { u0: 20, u1: 70, v0: 120, v1: 180 };   // strong interreflection: outshines the projector
const MILD = { u0: 200, u1: 250, v0: 20, v1: 70 };      // mild: bounced light below direct
const KAPPA_MILD = 0.6;
const PARTNER = 60;                                      // projector px to the reflecting wall

// Ground-truth camera→projector map: keystone, slight shear, relief bump in x.
function camToProj(u, v) {
  const s = u / CW, t = v / CH, k = 0.12 * (1 - t);
  let x = PW * (0.06 + 0.88 * (k + s * (1 - 2 * k)));
  const y = PH * (0.05 + 0.9 * t + 0.03 * s);
  const du = u - 110, dv = v - 90;
  x += 14 * Math.exp(-(du * du + dv * dv) / (2 * 28 * 28));
  return [x, y];
}
const inShadow = (u, v) => (u - SHADOW.u) ** 2 + (v - SHADOW.v) ** 2 < SHADOW.r ** 2;
const inRect = (R) => (u, v) => u >= R.u0 && u < R.u1 && v >= R.v0 && v < R.v1;
const inCorner = inRect(CORNER), inMild = inRect(MILD);
const albedo = (u, v) => inCorner(u, v) ? 0.3 : inMild(u, v) ? 0.6
  : 0.45 + 0.5 * (0.5 + 0.5 * Math.sin(u / 17) * Math.cos(v / 23));

// Per camera pixel: 4x4 subsample footprint in projector space (so fine
// stripes blur the way a real lens and sensor blur them) and the truth at
// the pixel centre.
const SUB = 4;
const foot = new Int32Array(CW * CH * SUB * SUB * 2);
const truth = new Float32Array(CW * CH * 2);
for (let v = 0; v < CH; v++) for (let u = 0; u < CW; u++) {
  const i = v * CW + u;
  const [tx, ty] = camToProj(u + 0.5, v + 0.5);
  truth[2 * i] = tx; truth[2 * i + 1] = ty;
  for (let b = 0; b < SUB; b++) for (let a = 0; a < SUB; a++) {
    const [px, py] = camToProj(u + (a + 0.5) / SUB, v + (b + 0.5) / SUB);
    const o = ((i * SUB * SUB) + b * SUB + a) * 2;
    foot[o] = Math.floor(px); foot[o + 1] = Math.floor(py);
  }
}

function capture(pat, noise) {
  // 1-D pattern along its axis, and its prefix sum for the reflecting patch.
  const len = pat.kind === 'gray' && pat.axis ? PH : PW;
  const line = new Float64Array(len), pre = new Float64Array(len + 1);
  for (let n = 0; n < len; n++) {
    line[n] = pat.kind === 'gray' ? patternValue(pat, pat.axis ? 0 : n, pat.axis ? n : 0) : patternValue(pat, 0, 0);
    pre[n + 1] = pre[n] + line[n];
  }
  const patch = (c) => {
    const a = Math.max(0, Math.min(len, Math.round(c - KERNEL / 2)));
    const b = Math.max(0, Math.min(len, Math.round(c + KERNEL / 2)));
    return b > a ? (pre[b] - pre[a]) / (b - a) : 0;
  };
  const out = new Uint8Array(CW * CH);
  for (let v = 0; v < CH; v++) for (let u = 0; u < CW; u++) {
    const i = v * CW + u, al = albedo(u, v);
    let direct = 0;
    if (!inShadow(u + 0.5, v + 0.5)) {
      for (let s = 0; s < SUB * SUB; s++) {
        const o = (i * SUB * SUB + s) * 2;
        const n = pat.kind === 'gray' && pat.axis ? foot[o + 1] : foot[o];
        direct += line[Math.max(0, Math.min(len - 1, n))];
      }
      direct /= SUB * SUB;
    }
    let global = 0;
    if (inCorner(u, v) || inMild(u, v)) {
      const c = (pat.kind === 'gray' && pat.axis ? truth[2 * i + 1] : truth[2 * i] + PARTNER);
      global = (inCorner(u, v) ? KAPPA : KAPPA_MILD) * GAIN * al * patch(c);
    }
    const val = AMBIENT + GAIN * al * direct + global + SIGMA * noise();
    out[i] = Math.max(0, Math.min(255, Math.round(val)));
  }
  return out;
}

function scan(opts) {
  const noise = rng(1234);
  const dec = new GrayDecoder({ camW: CW, camH: CH, projW: PW, projH: PH, noise: SIGMA, ...opts });
  for (const pat of patternSet(PW, PH)) dec.addFrame(pat, capture(pat, noise));
  return dec.finish();
}

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
for (let L = 0; L <= 6; L++) for (const row of [10, 45, 80]) {
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
