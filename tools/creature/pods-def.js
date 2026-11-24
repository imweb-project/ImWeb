// The pods: a string of soft, eyed, long-haired balls on a closed path. A swelling runs round the
// string (each ball in turn fills and slowly empties), the path bends from a ring into a figure
// eight, a flower or a knot, and the hair hangs, trails and blows. Pure maths, no three.js (see
// core.js for the contract).
//
// It began as a Blender study of a Cinema 4D cloner ("Abstract Ball": sixteen balls on a ring, a
// scale wave three times a loop); the numbers that gave that study its look are kept here.
//
// What it adds over the other creatures:
//   - NO BODY CHAIN. The balls are not bones of a chain: each is one bone the VIEW owns
//     (pods-view.js), placed by a full 3×4 matrix that pose() writes into P.parts.ball — so a ball
//     can be squashed along the path and still turn freely inside that squash (stretch · wobble is
//     not a position/turn/scale a bone could hold).
//   - HAIR IS CHAINS, one per hair, and the view hangs each on its ball's bone. A hair's placement
//     (a, rad, y, tilt) is therefore in its BALL's frame. pose() works out, for every hair root,
//     where it is in the world now and a moment ago, and bends the hair by what would pull on it:
//     its own weight, the water it is dragged through, and a slow gusting current. The engine's
//     joint springs then give the bend its lag from root to tip.
//   - ARC-LENGTH SPACING. The path is re-measured every frame and the balls are spread evenly along
//     its LENGTH, so they neither bunch nor gap when the path stretches or morphs.
import { TAU, M3 } from './core.js';

export const NAME = 'Pods';
export const LOOP_SECONDS = 12;

export const BALLS = 48;          // balls on the string (the study's figure eight had about as many)
export const HAIRS = 6;           // hairs per ball: each one a simulated string of bones (pods-view.js)
export const EYES = 22;           // eyes per ball (the same layout on every ball, each ball turned its own way)
export const BALL_R = 0.42;       // ball radius at full swell
export const HAIR_JOINTS = 12;                  // bones per hair: many short joints, so a hair curves instead of folding
export const HAIR_LEN = 1.0;      // a hair: about 2.4 ball radii
const BULGES = 3;                 // swellings on the string at once (constant: changing it would jump)
const RING = 2.0;                 // the unit the path shapes are written in (the path is then re-scaled, see SPACING)
// Neighbouring balls overlap, as on the original ring (sixteen balls of radius 1.67 on a ring of
// radius 3.32: 0.78 of a radius apart). Whatever the path's shape, it is scaled to this length.
const SPACING = 0.78 * BALL_R;

export const BODY = { radius: RING };

// ---- The same eyes and hair roots on every ball --------------------------------------------
// Seeded, so the view (which draws the eyes) and pose() (which roots the hairs) agree, and every
// run is the same. A site is a direction on the unit ball; eyes carry an angular radius.
function rng(seed) { let s = seed; return () => ((s = (s * 16807) % 2147483647) / 2147483647); }
function sites(n, seed, jitter) {
  const r = rng(seed), out = [];
  for (let i = 0; i < n; i++) {     // a Fibonacci spiral, shaken
    const y = 1 - 2 * (i + 0.5) / n, az = i * 2.39996323 + (r() - 0.5) * jitter, po = Math.acos(y) + (r() - 0.5) * jitter * 0.5;
    out.push([Math.sin(po) * Math.cos(az), Math.cos(po), Math.sin(po) * Math.sin(az)]);
  }
  return out;
}
export const EYE_SITES = (() => {
  const r = rng(77);
  return sites(EYES, 4242, 0.5).map(d => ({ d, rad: 0.13 + 0.10 * r() }));   // angular radius of the socket: small and large eyes
})();
// Hairs: spread over the ball, each rooted on open skin between the eyes.
export const HAIR_SITES = (() => {
  const clear = d => EYE_SITES.every(e => Math.acos(Math.max(-1, Math.min(1, d[0] * e.d[0] + d[1] * e.d[1] + d[2] * e.d[2]))) > e.rad * 1.25 + 0.05);
  const open = sites(HAIRS * 8, 99, 0.3).filter(clear), out = [];
  for (let i = 0; i < HAIRS; i++) out.push({ d: open[Math.floor((i + 0.5) * open.length / HAIRS)] });
  return out;
})();

// No engine chains: the balls and the hair are both the view's own bones (pods-view.js).
export const CHAINS = [];

export const INT_KEYS = ['wv', 'turn', 'drift', 'roll'];

export const DEFAULT = {
  floatH: 2.0,   // height of the string's centre
  size: 1,       // the whole thing larger or smaller
  // the path: a ring, bent toward one (or a mix) of four shapes
  stretch: 0,    // an ellipse with a saddle bend
  eight: 0,      // a figure eight, one lobe over the other where they cross
  flower: 0,     // three lobes
  knot: 0,       // a trefoil knot
  lift: 0,       // the path rises and falls in a wave, once round per loop
  live: 1,       // how much the shape itself breathes during the loop (0 = it holds still)
  turn: 0,       // whole turns of the string per loop
  roll: 0,       // whole rolls head over heels per loop
  tip: 0,        // the plane of the string tipped toward the viewer
  drift: 0,      // laps the balls travel along the path per loop (0 = they stay; only the swelling travels)
  // the swelling
  wv: 3,         // times the swelling passes each ball per loop
  swell: 1,      // depth of the swelling: 0 = every ball full, 1 = they empty to almost nothing
  squash: 0.05,  // a filling ball stretches along the path, an emptying one flattens
  wob: 0.35,     // each ball slowly rocks
  // hair
  hair: 1,       // hair length
  grav: 0.8,     // the hair's weight
  drag: 1,       // hair trails behind what moves
  flow: 0.45,    // a slow gusting current
  // eyes
  blink: 1,      // how much the eyes blink (0 = never)
};

export const GROUPS = ['paths', 'travelling', 'still'];

export const SEGMENTS = [
  { name: 'Eight',   group: 'paths',      desc: 'a figure eight; the swelling runs round it three times a loop',
    s: { eight: 1 } },
  { name: 'Ring',    group: 'paths',      desc: 'the plain ring it began as, gently rising and falling',
    s: { lift: 0.09 } },
  { name: 'Stretch', group: 'paths',      desc: 'the ring pulled into an ellipse and bent like a saddle',
    s: { stretch: 1 } },
  { name: 'Flower',  group: 'paths',      desc: 'three lobes that travel slowly round',
    s: { flower: 1 } },
  { name: 'Knot',    group: 'paths',      desc: 'a trefoil knot',
    s: { knot: 1 } },
  { name: 'Travel',  group: 'travelling', desc: 'the balls themselves run round the figure eight, hair streaming behind',
    s: { eight: 1, drift: 1, wv: 2, swell: 0.7 } },
  { name: 'Tumble',  group: 'travelling', desc: 'the knot rolls over and turns',
    s: { knot: 1, turn: 1, roll: 1, tip: 0, swell: 0.8 } },
  { name: 'Full',    group: 'still',      desc: 'every ball full, hanging hair, only the eyes and a slow rocking',
    s: { swell: 0.12, wv: 1, wob: 0.5, flow: 0.5, eight: 0.5 } },
];

// ---- Maths ----------------------------------------------------------------------------------
const frac = v => v - Math.floor(v);
// One breath: a quick swell (about a third of the cycle), then a long slow release.
function pulse(p) { const u = 1 - Math.pow(1 - p, 1.8); return 0.5 - 0.5 * Math.cos(TAU * u); }

// Per ball, the same on every run: phase jitter, size, resting turn, rocking phases.
const SEED = (() => {
  const r = rng(7), out = [];
  for (let i = 0; i < BALLS; i++) out.push({ jit: (r() - 0.5) * 0.06, size: 0.85 + 0.25 * r(),
    rot: [r() * TAU, r() * TAU, r() * TAU], ph: [r() * TAU, r() * TAU, r() * TAU] });
  return out;
})();

// A point of the path at parameter th (0..2π), in the string's own frame (y up).
const M = 240;                                    // samples of the path
const PX = new Float64Array(M + 1), PY = new Float64Array(M + 1), PZ = new Float64Array(M + 1), CUM = new Float64Array(M + 1);
// The shapes and how each BREATHES during the loop are the Blender study's own (paths.py), in units
// where its ring radius is RING: the ellipse swells and bends into a saddle and back, the eight's
// lobes widen while its crossing opens, the flower's lobes travel round, the knot deepens.
// S.live scales that breathing (0 = the shape holds still).
const F = RING / 3.32;                            // the study's lengths → these
function rawPath(S, phase) {
  const w0 = Math.max(0, 1 - (S.stretch + S.eight + S.flower + S.knot)), R = RING;
  const sp = S.live * Math.sin(phase), cp = S.live * Math.cos(phase);
  for (let m = 0; m <= M; m++) {
    const th = TAU * (m % M) / M, c = Math.cos(th), s = Math.sin(th);
    let x = w0 * R * c, y = 0, z = w0 * R * s;
    if (S.stretch) { x += S.stretch * R * (1 + 0.45 * sp) * c; z += S.stretch * R * (1 - 0.30 * sp) * s; y += S.stretch * 1.5 * F * sp * Math.cos(2 * th); }
    if (S.eight)   { x += S.eight * 1.55 * R * s; z += S.eight * 1.15 * R * s * c * (1 + 0.25 * sp); y += S.eight * 1.8 * F * c * (1 + 0.25 * cp); }
    if (S.flower)  { const a = 3 * th - S.live * phase, r = R * (1 + 0.28 * Math.cos(a)); x += S.flower * r * c; z += S.flower * r * s; y += S.flower * 0.8 * F * Math.sin(a); }
    if (S.knot)    { const k = 1.45 * F, h = (1.4 + 0.5 * sp) * F; x += S.knot * k * (s + 2 * Math.sin(2 * th)); z += S.knot * k * (c - 2 * Math.cos(2 * th)); y -= S.knot * h * Math.sin(3 * th); }
    y += S.lift * R * Math.sin(phase + 2 * th);
    PX[m] = x; PY[m] = y; PZ[m] = z;
    CUM[m] = m ? CUM[m - 1] + Math.hypot(x - PX[m - 1], y - PY[m - 1], z - PZ[m - 1]) : 0;
  }
  return CUM[M];
}
// One scale for the whole loop, so the balls sit SPACING apart where the path is LONGEST (a longer
// shape is drawn smaller, not thinned out) and close up a little as it breathes in — as the study
// counted its balls from the longest the path gets. Kept until the shape changes.
let scaleKey = '', scaleK = 1;
function pathScale(S) {
  const key = `${S.stretch}|${S.eight}|${S.flower}|${S.knot}|${S.lift}|${S.live}`;
  if (key !== scaleKey) {
    let L = 0; for (let j = 0; j < 8; j++) L = Math.max(L, rawPath(S, TAU * j / 8));
    scaleKey = key; scaleK = BALLS * SPACING / L;
  }
  return scaleK;
}
function samplePath(S, phase) {
  const k = pathScale(S); rawPath(S, phase);
  for (let m = 0; m <= M; m++) { PX[m] *= k; PY[m] *= k; PZ[m] *= k; CUM[m] *= k; }
}

// Every ball at one phase: A (3×3, row-major: frame · squash · rocking), R (3×3: the same without
// the squash, for directions), c (centre), s (swell 0..1 × its size) — all in WORLD space, the
// string's turn, roll and tip included.
function layout(S, phase, out) {
  const { mul, rx, ry, rz, mv } = M3, x = phase / TAU;
  samplePath(S, phase);
  const W = mul(mul(ry(S.turn * phase), rx(S.tip + S.roll * phase)), [S.size, 0, 0, 0, S.size, 0, 0, 0, S.size]);   // whole-string turn
  const total = CUM[M], LAG = 0.05;
  for (let i = 0; i < BALLS; i++) {
    const K = SEED[i], o = out[i];
    // where along the length
    const d = frac(i / BALLS + S.drift * x) * total;
    let lo = 0, hi = M; while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (CUM[mid] <= d) lo = mid; else hi = mid; }
    const f = (d - CUM[lo]) / Math.max(1e-9, CUM[hi] - CUM[lo]);
    const c = [PX[lo] + (PX[hi] - PX[lo]) * f, PY[lo] + (PY[hi] - PY[lo]) * f, PZ[lo] + (PZ[hi] - PZ[lo]) * f];
    // the path's direction there (a wide difference, so it turns smoothly from sample to sample)
    // … blended between the two samples either side, so it does not step when a ball sits exactly
    // on a sample (which sample it then counts as is a coin toss, and differs across the loop seam).
    const l0 = (lo + M - 2) % M, l1 = (lo + 2) % M, h0 = (hi + M - 2) % M, h1 = (hi + 2) % M;
    let tx = (PX[l1] - PX[l0]) * (1 - f) + (PX[h1] - PX[h0]) * f, ty = (PY[l1] - PY[l0]) * (1 - f) + (PY[h1] - PY[h0]) * f,
      tz = (PZ[l1] - PZ[l0]) * (1 - f) + (PZ[h1] - PZ[h0]) * f, tl = Math.hypot(tx, ty, tz) || 1; tx /= tl; ty /= tl; tz /= tl;
    // frame: y along the path, x as near "up" as that allows, z across
    let nx = -ty * tx, ny = 1 - ty * ty, nz = -ty * tz, nl = Math.hypot(nx, ny, nz) || 1; nx /= nl; ny /= nl; nz /= nl;
    const bx = ny * tz - nz * ty, by = nz * tx - nx * tz, bz = nx * ty - ny * tx;
    const F = [nx, tx, bx, ny, ty, by, nz, tz, bz];
    // the swelling
    const p = frac(S.wv * x + BULGES * i / BALLS + K.jit);
    const g = pulse(p), rate = (g - pulse(frac(p - LAG))) / LAG;
    const s = (1 - S.swell * 0.94 * (1 - g)) * K.size;
    const e = 1 + S.squash * rate * S.swell, q = s / Math.sqrt(e);
    const wob = mul(mul(rx(K.rot[0] + S.wob * Math.sin(phase + K.ph[0])), ry(K.rot[1] + S.wob * Math.sin(phase + K.ph[1]))),
      rz(K.rot[2] + S.wob * Math.sin(phase + K.ph[2])));
    const FR = mul(W, F);
    o.R = mul(mul(FR, [1 / S.size, 0, 0, 0, 1 / S.size, 0, 0, 0, 1 / S.size]), wob);
    o.A = mul(mul(FR, [q, 0, 0, 0, s * e, 0, 0, 0, q]), wob);
    o.c = mv(W, c); o.c[1] += S.floatH; o.s = s;
  }
  return out;
}
const blank = () => Array.from({ length: BALLS }, () => ({ A: null, R: null, c: null, s: 1 }));
const NOW = blank();

export function pose(S, phase, P) {
  const parts = P.parts;
  const ball = parts.ball || (parts.ball = new Float64Array(BALLS * 12));   // per ball: A (9, row-major), centre (3)
  layout(S, phase, NOW);
  P.root.x = P.root.y = P.root.z = 0; P.root.rx = P.root.ry = P.root.rz = 0;   // the balls carry the whole motion

  // The hair is SIMULATED, in pods-view.js: here a hair only gets its place on its ball, and the
  // view is told what acts on it (the clock, weight, water drag, current, length).
  for (let i = 0; i < BALLS; i++) { const n = NOW[i]; ball.set(n.A, i * 12); ball.set(n.c, i * 12 + 9); }
  // (the clock as a point on a circle, so it is the same at both ends of the loop)
  const sim = parts.sim || (parts.sim = new Float64Array(6));
  sim[0] = Math.sin(phase); sim[1] = S.grav; sim[2] = S.drag; sim[3] = S.flow; sim[4] = S.hair; sim[5] = Math.cos(phase);
  (parts.uniforms || (parts.uniforms = {})).uBlinkAmt = S.blink;
  return P;
}
