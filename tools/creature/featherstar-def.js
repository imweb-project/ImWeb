// The feather star (a comatulid crinoid): a small cup, ten feathered arms in five pairs, and a
// ring of short jointed cirri underneath that hold on to the floor. Pure maths, no three.js
// (see core.js for the contract every creature follows).
//
// What it adds over the octopus:
//   - TWO SETS OF FIVE: one arm of every pair belongs to set A, the other to set B. Swimming, the
//     sets beat in turn. The recovery is muscle on the oral side curling the arm up, from the base
//     out, pinnules folded flat; the power stroke is the elastic ligaments flinging it down and
//     straight, pinnules spread at right angles. Each segment runs the root's stroke a little
//     later (a wave out along the arm), so the curl rolls up toward the tip and the fling cracks
//     out to it. Each power stroke lifts the body; it travels with its oral side leaning ahead.
//   - PINNULES, NOT CHAINS: the side branches are geometry skinned to the arm bones (the view
//     builds them). pose() only says how far they fold along the arm (P.parts.fold, per arm per
//     bone) and how far they lift into a V toward the oral side (P.parts.vee, per arm).
//   - A COIL FRONT: `coil` is how much of the arm, from the tip, is rolled up. Easing it in rolls
//     the arm from the tip; easing it out unrolls it from the base, as the animal does.
//   - FLIGHT: a burst of strokes, then a slow parachute sink with the arms held high; with `land`
//     the cirri let go for the flight, reach down as it comes in, and grip again (Settle).
//   - WEIGHT ON THE CIRRI: perched, pose() runs the cirri through the same forward kinematics the
//     page applies (core.js chainFK) and sets the body so the lowest cirrus rests on the floor;
//     the others bend down until they touch it too. Arms that would go through the floor are
//     lifted clear of it.
//   - CRAWLING ON THE ARM TIPS: the arms arch like legs, each tip solved onto the floor (planar
//     forward kinematics, a two-unknown Newton step), the two sets stepping in turn, and the
//     stance tips held still under a body that crawls round a small circle.
import { TAU, scatter, chainLengths, M3 } from './core.js';

export const NAME = 'Feather star';
export const LOOP_SECONDS = 8;

export const ARMS = 10, AB = 16, CIRRI = 15, CB = 5;
// Shared with featherstar-view.js (calyx, pinnules, band colours).
export const SHAPE = {
  rim: 0.125, rimY: 0.07,        // the calyx rim, where the arms leave it
  cdY: -0.045, cdR: 0.078,       // the centrodorsal knob under the cup, where the cirri grow
  arm: { len: 2.2, r0: 0.03, r1: 0.009 },
  cir: { len: 0.44, r0: 0.016, r1: 0.009 },
  pairGap: 0.17,                 // half the angle between the two arms of a pair, at the rim
};
export const BODY = SHAPE;

export const CHAINS = [
  { group: 'arm', count: ARMS, bones: AB, length: SHAPE.arm.len, r0: SHAPE.arm.r0, r1: SHAPE.arm.r1, rs: 8,
    decay: 0.97, stiff: 1.5, art: 30, pinch: 0.12, dark: 0.22, rings: 96, custom: [1, 0, 0, 0] },
  { group: 'cirrus', count: CIRRI, bones: CB, length: SHAPE.cir.len, r0: SHAPE.cir.r0, r1: SHAPE.cir.r1, rs: 6,
    decay: 1, stiff: 3, art: 12, pinch: 0.22, dark: 0.35, rings: 36, tint: 0x4a3f36, tipTint: 0xb0a490, custom: [3, 0, 0, 0] },
];
const CIR0 = ARMS;

// Cirri sockets on the centrodorsal: an outer ring of 9 near its equator, an inner ring of 6
// below, between them. pol: angle from the bottom of the knob; az: round the body.
const SOCK = Array.from({ length: CIRRI }, (_, c) => {
  const outer = c < 9, az = outer ? c * TAU / 9 : (c - 9 + 0.5) * TAU / 6, pol = outer ? 1.3 : 0.75;
  return { az, pol, outer, frac: az / TAU };
});

export const INT_KEYS = ['sh', 'fh', 'wh', 'ph', 'steps'];

export const DEFAULT = {
  // body
  perch: 1,      // 1 = standing on its cirri on the floor; 0 = free in the water at `height`
  height: 1.8,   // body height when free (the floor is at 0)
  bob: 0,        // body bobs with each power stroke
  pitch: 0,      // oral side leans downstream (rad)
  rock: 0,       // and rocks back and forth (fh times a loop)
  path: 0,       // crawls round a circle of this radius, once a loop
  // arms
  elev: 0.6,     // arm elevation above horizontal at the root (rad)
  splay: 1,      // how far apart the two arms of a pair leave the cup (× SHAPE.pairGap)
  bend: 0,       // bend per bone: + toward the oral side (up and in), − away
  tipB: 0,       // bend weighted toward the tip (− recurves the tips outward)
  cur: 0,        // a current: arms lean and bend downstream (+z)
  gust: 0,       // the current strengthens and slackens (fh times a loop)
  surge: 0,      // the water rocks to and fro (fh times a loop): arms stream one way, then back
  wave: 0.04,    // gentle undulation along the arms
  wh: 1,         // its harmonic
  k: 0.35,       // lag per bone
  rot: 0,        // the wave travels round the ring
  irr: 0.6,      // per-arm phase scatter
  vary: 0.6,     // each arm its own fixed lean and curve
  wander: 0.3,   // slow irregular drifting of every arm (harmonics 1 and 2: loop-safe)
  // swimming
  swim: 0,       // stroke: how far the arm root sweeps either side of elev (rad)
  sCurl: 0,      // and how far the arm curls up toward its tip in the recovery (rad, at the tip)
  sLag: 0.12,    // the stroke reaches the tip this share of a stroke later than the root
  sh: 6,         // strokes per loop
  duty: 0.4,     // power-stroke share of each stroke
  pRec: 0,       // pinnules fold in the recovery stroke
  lean: 0,       // swimming: oral side leans toward where it is going (rad)
  rise: 0,       // and it climbs and sinks once a loop
  // flight: a burst of strokes, then a sink (fly 0 = strokes all loop long)
  fly: 0,
  bAt: 0, bLen: 0.35, sEnd: 1,   // burst start and length, sink ends (fractions of the loop)
  climb: 0,      // height gained in the burst
  chute: 0,      // arms raised while it sinks
  land: 0,       // cirri let go in flight, reach down coming in, grip on landing
  // coiling: held, plus a cycle (rAt start, rUp roll, rHold, rDn unroll; rInv starts rolled)
  coil: 0,
  roll: 0, rAt: 0, rUp: 0.15, rHold: 0.4, rDn: 0.35, rInv: 0,
  tight: 1,      // how tight the coil rolls
  // pinnules
  pFold: 0.3,    // folded along the arm toward the tip (0 = straight out, ~1.4 = flat against it)
  pV: 0.35,      // lifted into a V toward the oral side
  flick: 0,      // pinnules flutter in a wave out along the arm
  ph: 4,         // flutter harmonic
  // cirri
  cSpread: 1.1,  // tilt from straight down
  cCurl: 0.3,    // curve down and in, per bone
  cGrip: 0.5,    // claws hook in at the tip
  cWave: 0,      // cirri swing with the strokes
  cStep: 0,      // cirri let go and grip again one by one round the ring
  // crawling on the arm tips
  crawl: 0,
  steps: 4,      // steps per loop (each set)
  reach: 1.45,   // where the tips stand, from the body axis
  arch: 0.55,    // how high the arms rise at the root before arching down
  fh: 1,         // swell / sway harmonic
};

export const GROUPS = ['resting', 'feeding', 'swimming', 'settling', 'reacting', 'getting around'];

export const SEGMENTS = [
  { name: 'Perch', group: 'resting', desc: 'on its cirri, arms raised loosely, tips rolled, pinnules folded: resting by day',
    s: { elev: 0.75, coil: 0.3, tight: 1.1, pFold: 0.75, pV: 0.5, wave: 0.03, wander: 0.45, cSpread: 1.15, cCurl: 0.3, cGrip: 0.6 } },
  { name: 'Feed', group: 'feeding', desc: 'a fan held across the current, pinnules spread into a filter, swaying gently',
    s: { elev: 0.3, pitch: 0.28, rock: 0.07, cur: 0.7, gust: 0.4, bend: 0.025, pFold: 0.2, pV: 0.3, flick: 0.1, ph: 5,
         wave: 0.035, wander: 0.25 } },
  { name: 'Bowl', group: 'feeding', desc: 'still water: arms raised in a bowl, tips turned outward, a slow wave round the ring',
    s: { elev: 1.0, tipB: -0.05, pFold: 0.15, pV: 0.3, flick: 0.08, ph: 3, wave: 0.07, rot: 1, k: 0.25, wander: 0.2 } },
  { name: 'Swim', group: 'swimming', desc: 'the two sets of five beat in turn: each arm curls up from the base, then flings down straight; every stroke lifts it, and it travels',
    s: { perch: 0, height: 1.9, elev: 0.05, swim: 0.6, sCurl: 1.3, sLag: 0.14, sh: 6, duty: 0.4, pRec: 1.15, pFold: 0.1, bob: 0.1,
         path: 0.9, lean: 0.3, rise: 0.2,
         cSpread: 0.3, cCurl: 0.1, cGrip: 0.15, cWave: 0.12, wave: 0, wander: 0.1, irr: 0.2 } },
  { name: 'Parachute', group: 'swimming', desc: 'a few strokes up, then the arms held high like a parachute while it sinks slowly',
    s: { perch: 0, height: 1.5, fly: 1, bAt: 0, bLen: 0.36, sEnd: 1, climb: 0.9, chute: 0.65, elev: 0.1, swim: 0.6, sCurl: 1.2, sLag: 0.14, sh: 8,
         duty: 0.4, pRec: 1.15, pFold: 0.05, bob: 0.08, cSpread: 0.3, cCurl: 0.1, cGrip: 0.15, cWave: 0.1,
         wave: 0.03, wander: 0.2, irr: 0.2 } },
  { name: 'Escape', group: 'swimming', desc: 'fleeing: quick, deep strokes, leaning hard into a fast climbing circle',
    s: { perch: 0, height: 2.0, elev: 0.05, swim: 0.75, sCurl: 1.5, sLag: 0.1, sh: 10, duty: 0.36, pRec: 1.3, pFold: 0.15, bob: 0.16,
         path: 1.3, lean: 0.4, rise: 0.3,
         cSpread: 0.2, cCurl: 0.2, cGrip: 0.3, cWave: 0.15, wave: 0, wander: 0.05, irr: 0.1 } },
  { name: 'Settle', group: 'settling', desc: 'lifts off, sinks with arms raised, cirri reach down, touch and grip; the arms open again',
    s: { fly: 1, land: 1, bAt: 0.06, bLen: 0.22, sEnd: 0.72, climb: 0.85, chute: 0.45, elev: 0.45, swim: 0.55, sCurl: 1.1, sLag: 0.12, sh: 8,
         duty: 0.4, pRec: 1.1, pFold: 0.3, bob: 0.06, cWave: 0.08, wave: 0.03, irr: 0.2 } },
  { name: 'Regrip', group: 'settling', desc: 'the cirri let go and take hold again, one after another round the ring',
    s: { cStep: 1, elev: 0.55, pFold: 0.45, wave: 0.03, rock: 0.05, cSpread: 1.1, cCurl: 0.32, cGrip: 0.7 } },
  { name: 'Cling', group: 'settling', desc: 'a surge: cirri clamp hard, body crouches, the arms stream to and fro with the water',
    s: { elev: 0.15, surge: 1.1, fh: 2, rock: 0.12, pFold: 0.9, pV: 0.55, coil: 0.12, cSpread: 1.25, cCurl: 0.45, cGrip: 1.0,
         wave: 0.04, k: 0.5 } },
  { name: 'Curl', group: 'reacting', desc: 'disturbed: the arms snap into coils from the tips, hold tight, then slowly open',
    s: { roll: 0.8, rAt: 0.03, rUp: 0.1, rHold: 0.45, rDn: 0.38, tight: 1.05, elev: 0.6, pFold: 0.3, wave: 0.02, cGrip: 0.8 } },
  { name: 'Unfurl', group: 'reacting', desc: 'the coils unroll slowly from the base, the pinnules open last; a touch rolls them up again',
    s: { roll: 0.8, rInv: 1, rAt: 0, rUp: 0.62, rHold: 0.22, rDn: 0.12, tight: 1.05, elev: 0.6, pFold: 0.2, wave: 0.03, cGrip: 0.6 } },
  { name: 'Crawl', group: 'getting around', desc: 'walks on its arm tips, body raised, the two sets stepping in turn round a small circle',
    s: { perch: 0, height: 0.62, crawl: 1, path: 0.28, steps: 4, reach: 1.45, arch: 0.55, pFold: 0.7, pV: 0.5,
         cSpread: 0.35, cCurl: 0.5, cGrip: 0.8, wave: 0, wander: 0.05 } },
];

// ---- helpers ------------------------------------------------------------------------------
const frac = v => v - Math.floor(v);
const sstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const win = (x, a, b, e) => sstep(a, a + e, x) * (1 - sstep(b - e, b, x));   // 0 → 1 → 0 between a and b

const LA = chainLengths(AB, SHAPE.arm.len, CHAINS[0].decay);
const LC = chainLengths(CB, SHAPE.cir.len, 1);
const SC = scatter(ARMS, 909);
const SHP = Array.from({ length: ARMS }, (_, j) => scatter(6, 3100 + 53 * j));
const CSC = scatter(CIRRI, 5150);
const CY = new Float64Array(CIRRI), CH = new Float64Array(CIRRI);

// One stroke cycle at stroke phase th: u −1 raised … +1 down; pw 1 in the power stroke (down,
// quick, straight, pinnules spread), 0 in the recovery (up, slow); rec: recovery speed (0..1).
// u = −cos(π w) with w piecewise linear stays smooth at the turns (its slope is zero there).
const STK = { u: 0, pw: 0 };
function stroke(th, d) {
  const xs = frac(th / TAU), w = xs < d ? xs / d : 1 + (xs - d) / (1 - d);
  STK.u = -Math.cos(Math.PI * w); STK.pw = sstep(-0.3, 0.3, Math.sin(Math.PI * w));
  return STK;
}
const PHI = new Float64Array(AB), PW = new Float64Array(AB);

// The coil cycle: 0 open → 1 rolled → 0 (rInv: starts rolled). Periodic in x.
function rollEnv(S, x) {
  const y = frac(x - S.rAt), b = S.rUp + S.rHold, c = Math.min(1, b + Math.max(0.01, S.rDn));
  const e = sstep(0, Math.max(0.01, S.rUp), y) * (1 - sstep(b, c, y));
  return S.rInv + (1 - 2 * S.rInv) * e;
}

// The lowest joint of a chain (from joint `from` on), as world height through yRow (the root
// turn's middle row), and that joint's horizontal distance from the chain root. The same maths as
// core.js chainFK, but in place: chainFK allocates a matrix per joint, and pose() runs this ~50
// times a frame. R is right-multiplied by Rx(bx)·Ry(by)·Rz(bz), which touches two columns each.
const R9 = new Float64Array(9);
function rmul(i, j, sg, t) {   // columns i, j of R9 turned by t (sg −1 for Ry)
  if (t === 0) return;
  const c = Math.cos(t), s = Math.sin(t) * sg, R = R9;
  for (let r = 0; r < 9; r += 3) {
    const a = R[r + i], b = R[r + j];
    R[r + i] = a * c + b * s; R[r + j] = b * c - a * s;
  }
}
const rx = t => rmul(1, 2, 1, t), ry = t => rmul(0, 2, -1, t), rz = t => rmul(0, 1, 1, t);
const LOW = { y: 0, h: 0 };
function lowest(C, L, yRow, from) {
  const R = R9, ca = Math.cos(C.a), sa = Math.sin(C.a);
  R[0] = ca; R[1] = 0; R[2] = -sa; R[3] = 0; R[4] = 1; R[5] = 0; R[6] = sa; R[7] = 0; R[8] = ca;   // Ry(−a)
  rz(C.tilt); rx(C.bx[0]); ry(C.by[0]); rz(C.bz[0]);
  const x0 = ca * C.rad, z0 = sa * C.rad;
  let px = x0, py = C.y, pz = z0, B = C.bz.length;
  LOW.y = Infinity; LOW.h = 0;
  for (let i = 1; i <= L.length; i++) {
    const l = L[i - 1] * C.len * C.bl[i - 1];
    px -= R[1] * l; py -= R[4] * l; pz -= R[7] * l;
    if (i >= from) {
      const wy = yRow[0] * px + yRow[1] * py + yRow[2] * pz;
      if (wy < LOW.y) { LOW.y = wy; LOW.h = Math.hypot(px - x0, pz - z0); }
    }
    if (i < B) { rx(C.bx[i]); ry(C.by[i]); rz(C.bz[i]); }
  }
  return LOW;
}

// Planar forward kinematics of one arm in its own radial plane (bz bends only): the tip's
// distance from the body axis and its height, in the body frame. Same maths as chainFK.
function tip2(T, c, tuck, len) {
  let th = T, r = SHAPE.rim, y = SHAPE.rimY;
  for (let i = 0; i < AB; i++) {
    if (i > 0) th += c + (i >= AB - 3 ? tuck : 0);
    r += LA[i] * len * Math.sin(th); y -= LA[i] * len * Math.cos(th);
  }
  return [r, y];
}
// Root tilt T and per-bone arch c that put the tip at (rho, yT): a few Newton steps from a fixed
// start (no memory of the last frame, so the pose stays a pure function of the phase).
function solveArch(rho, yT, tuck, len, T0) {
  let T = T0, c = -0.12;
  for (let n = 0; n < 6; n++) {
    const [r, y] = tip2(T, c, tuck, len), e1 = r - rho, e2 = y - yT;
    if (e1 * e1 + e2 * e2 < 1e-8) break;
    const h = 1e-4, [rT, yT1] = tip2(T + h, c, tuck, len), [rc, yc] = tip2(T, c + h, tuck, len);
    const a = (rT - r) / h, b = (rc - r) / h, cc = (yT1 - y) / h, dd = (yc - y) / h, det = a * dd - b * cc;
    if (Math.abs(det) < 1e-9) break;
    let dT = (dd * e1 - b * e2) / det, dc = (-cc * e1 + a * e2) / det;
    const m = Math.max(Math.abs(dT) / 0.4, Math.abs(dc) / 0.08, 1); dT /= m; dc /= m;   // no wild steps
    T -= dT; c -= dc;
  }
  return [T, c];
}

export function pose(S, phase, P) {
  const x = frac(phase / TAU), parts = P.parts;
  const fold = parts.fold || (parts.fold = new Float64Array(ARMS * (AB + 1)));
  const vee = parts.vee || (parts.vee = new Float64Array(ARMS));
  parts.floor = 1;

  // ---- timeline: flight (burst, sink, landing) and the coil cycle ------------------------
  const Fw = S.fly, bEnd = S.bAt + S.bLen;
  const strokeOn = 1 - Fw + Fw * win(x, S.bAt, bEnd, 0.05);
  const Yp = sstep(S.bAt, bEnd + 0.04, x) - sstep(bEnd + 0.04, S.sEnd, x);   // height gained, then lost
  const sink = Fw * win(x, bEnd - 0.04, Math.min(1, S.sEnd + 0.1), 0.08);   // arms held high
  const away = Fw * S.land * win(x, S.bAt + 0.03, Math.min(1, S.sEnd + 0.03), 0.05);   // cirri let go
  const reachIn = Fw * S.land * win(x, S.sEnd - 0.22, Math.min(1, S.sEnd + 0.05), 0.08);   // and reach down
  const coilT = Math.min(1.05, S.coil + S.roll * rollEnv(S, x));

  // ---- body turn (the floor maths needs it before the height) ------------------------------
  const sw = Math.sin(S.fh * phase + 0.4);
  const RX = S.pitch + S.rock * sw + 0.03 * S.wander * Math.sin(phase + 1.3);
  const RZ = 0.03 * S.wander * Math.sin(2 * phase + 0.2) + 0.04 * S.swim * strokeOn * Math.sin(S.sh * phase + 0.9);
  // Travelling round its circle (along (−sin φ, 0, cos φ)), the oral side leans ahead.
  const RXl = RX + S.lean * Math.cos(phase), RZl = RZ + S.lean * Math.sin(phase);
  P.root.rx = RXl; P.root.rz = RZl; P.root.ry = 0;
  const yRow = [Math.sin(RZl), Math.cos(RZl) * Math.cos(RXl), -Math.cos(RZl) * Math.sin(RXl)];   // world height of a body-frame point

  // ---- cirri ------------------------------------------------------------------------------
  const cSpread = S.cSpread * (1 - 0.55 * away) + 0.45 * reachIn;
  const cCurl = S.cCurl * (1 - 0.7 * away) - 0.12 * reachIn;
  const cGrip = S.cGrip * (1 - away);
  const strokeBody = S.sh * phase;
  for (let c = 0; c < CIRRI; c++) {
    const C = P.chains[CIR0 + c], K = SOCK[c];
    // Regrip: each cirrus in turn lifts clear, swings and takes hold again.
    const lift = S.cStep * win(frac(x - K.frac), 0, 0.16, 0.06);
    C.a = K.az; C.rad = SHAPE.cdR * Math.sin(K.pol); C.y = SHAPE.cdY - SHAPE.cdR * Math.cos(K.pol);
    C.tilt = (K.outer ? 0 : -0.35) + cSpread + 0.55 * lift + 0.05 * Math.sin(CSC[c]);
    for (let i = 0; i < CB; i++) {
      const t = (i + 1) / CB;
      const wv = S.cWave * strokeOn * Math.sin(2 * strokeBody - 0.8 * i - CSC[c]);
      C.bz[i] = -(cCurl * (1 - 0.6 * lift) + cGrip * (1 - lift) * 2.2 * t * t * t * t) + wv;
      C.bx[i] = 0.04 * Math.sin(CSC[c] + i); C.by[i] = 0; C.bl[i] = 1;
    }
  }
  // Weight on the cirri: the lowest cirrus point rests on the floor; every other planted cirrus
  // turns down at its root until it reaches the same height (two correction steps).
  // A cirrus lifted to regrip does not carry the body (or its straightened claw would lift it).
  const liftOf = c => S.cStep * win(frac(x - SOCK[c].frac), 0, 0.16, 0.06);
  let low = 0;
  const cy = CY, ch = CH;
  for (let c = 0; c < CIRRI; c++) {
    const r = lowest(P.chains[CIR0 + c], LC, yRow, 2);
    cy[c] = r.y; ch[c] = Math.max(0.15, r.h); low = Math.min(low, r.y + 0.5 * liftOf(c));
  }
  const planted = S.perch * (1 - away);
  if (planted > 0) for (let c = 0; c < CIRRI; c++) {
    // Planted cirri come down to the floor; a lifted one is held clear of it, 14 cm at the top.
    const lift = liftOf(c), C = P.chains[CIR0 + c], tgt = low + 0.14 * lift;
    let m = cy[c], h = ch[c];
    for (let n = 0; n < 2 && Math.abs(m - tgt) > 0.004; n++) {
      C.tilt -= Math.max(-0.5, Math.min(0.5, (m - tgt) / h)) * planted;
      const r = lowest(C, LC, yRow, 2); m = r.y; h = Math.max(0.15, r.h);
    }
  }

  // ---- body height and place -------------------------------------------------------------
  const perchY = -low + 0.012;
  const bobY = S.bob * strokeOn * Math.sin(2 * strokeBody - 1.2);
  P.root.y = S.perch * perchY + (1 - S.perch) * S.height + S.climb * Fw * Yp + bobY + S.rise * Math.sin(phase + 0.6)
    + 0.03 * S.crawl * Math.sin(2 * S.steps * phase);
  P.root.x = S.path * Math.cos(phase);
  P.root.z = S.path * Math.sin(phase);

  // Downstream (+z, toward the camera) in the body frame, for the current.
  const Rr = M3.mul(M3.rz(RZl), M3.rx(RXl));
  const D = [Rr[6], Rr[7], Rr[8]];   // Rrᵀ · (0, 0, 1)
  const cw = S.cur * (1 + S.gust * Math.sin(S.fh * phase - 0.6)) + S.surge * sw;

  // ---- arms -------------------------------------------------------------------------------
  const vRad = phase;                                   // crawl: travel direction angle (+90°)
  const stride = TAU * S.path * 0.6 / Math.max(1, S.steps);
  for (let j = 0; j < ARMS; j++) {
    const C = P.chains[j], ray = j >> 1, side = j & 1 ? 1 : -1, set = j & 1, sh = SHP[j];
    let a = ray * TAU / 5 + TAU / 20 + side * SHAPE.pairGap * S.splay;
    const off = S.rot * ray * TAU / 5 + S.irr * 0.5 * Math.sin(SC[j]);
    // The stroke as a wave out along the arm: segment i runs the root's stroke sLag·t later.
    // PHI[i]: how far segment i is turned up from the mean elevation — the root's sweep, plus the
    // oral curl it gathers toward the tip as the recovery lifts it, which the power stroke lets go.
    const th0 = S.sh * phase - set * Math.PI - 0.15 * S.irr * Math.sin(SC[j]);
    const amp = S.swim * strokeOn, kap = S.sCurl * strokeOn;
    for (let i = 0; i < AB; i++) {
      const t = (i + 1) / AB, k = stroke(th0 - TAU * S.sLag * t, S.duty);
      PHI[i] = -amp * k.u + kap * t * Math.pow(0.5 - 0.5 * k.u, 1.5);
      PW[i] = k.pw;
    }
    let elev = S.elev + PHI[0] + S.chute * sink + S.vary * 0.08 * Math.sin(sh[0])
      + S.wander * 0.05 * (Math.sin(phase + sh[1]) + 0.5 * Math.sin(2 * phase + sh[2]));
    let T = Math.PI / 2 + elev;
    // Current: lean the whole arm downstream, and bend it more toward its tip.
    const cT = Math.cos(T), sT = Math.sin(T);
    const dx = D[0] * Math.cos(a) * cT + D[1] * sT + D[2] * Math.sin(a) * cT;   // along the oral side
    const dz = -D[0] * Math.sin(a) + D[2] * Math.cos(a);                          // round the ring
    T += 0.25 * cw * dx; a += 0.12 * cw * dz;
    C.a = a; C.rad = SHAPE.rim; C.y = SHAPE.rimY; C.tilt = T;
    C.len = 1 + S.vary * 0.04 * Math.sin(sh[3]);

    for (let i = 0; i < AB; i++) {
      const t = (i + 1) / AB;
      const w = S.wh * phase - S.k * i - off;
      // The coil front: bones beyond 1 − coilT are rolled toward the oral side, tighter at the tip.
      const rolled = sstep(1 - coilT - 0.1, 1 - coilT + 0.06, t);
      let z = S.bend + S.tipB * 3 * t * t + S.wave * (0.3 + t) * Math.sin(w)
        + S.vary * 0.025 * Math.sin(Math.PI * 1.4 * t + sh[4])
        + S.wander * 0.02 * Math.sin(phase + sh[5] - 0.3 * i)
        + (i > 0 ? PHI[i] - PHI[i - 1] : 0)                       // the stroke wave
        + 0.06 * cw * dx * (0.4 + t)
        + rolled * S.tight * (0.5 + 0.75 * t);
      let bx = -0.05 * cw * dz * (0.4 + t) + S.vary * 0.015 * Math.sin(sh[2] + 2 * t)
        + S.wander * 0.02 * Math.sin(phase + sh[3] - 0.4 * i);
      C.bz[i] = z; C.bx[i] = bx * (1 - rolled); C.by[i] = 0; C.bl[i] = 1;
    }

    // Crawling: the arm arches onto its tip; stance tips stay put while the body moves on.
    if (S.crawl > 0) {
      const g = frac(S.steps * x - set * 0.5 - 0.06 * Math.sin(SC[j]));
      let o, lift;
      if (g < 0.6) { o = 0.5 - g / 0.6; lift = 0; }                       // stance: tip slides back under the body
      else { const tt = (g - 0.6) / 0.4; o = -0.5 + sstep(0, 1, tt); lift = 0.16 * Math.sin(Math.PI * tt); }   // swing forward
      // Travel is along (−sin φ, 0, cos φ); split into this arm's radial and round-the-ring parts.
      const rho = S.reach + stride * o * Math.sin(a - vRad), tang = stride * o * Math.cos(a - vRad);
      const [Ts, cs] = solveArch(rho, -P.root.y + lift + 0.02, 0.1, C.len, Math.PI / 2 + S.arch);
      const cw2 = S.crawl;
      C.tilt += (Ts - C.tilt) * cw2;
      C.a += cw2 * tang / S.reach;
      for (let i = 0; i < AB; i++) {
        const tgt = i === 0 ? 0 : cs + (i >= AB - 3 ? 0.1 : 0);
        C.bz[i] += (tgt - C.bz[i]) * cw2; C.bx[i] *= 1 - cw2;
      }
    }

    // Pinnules: fold in the recovery stroke, in a coil, and while the coil is still unrolling
    // (they open last); flutter in a wave out along the arm.
    const fb = j * (AB + 1);
    for (let i = 0; i <= AB; i++) {
      const t = i / AB, ii = Math.min(i, AB - 1);
      const rolled = sstep(1 - coilT - 0.1, 1 - coilT + 0.06, t);
      let f = S.pFold + S.pRec * strokeOn * Math.min(1, S.swim / 0.3) * (1 - PW[ii]) * (0.6 + 0.4 * t)
        + 1.2 * rolled + 1.0 * sstep(0, 0.35, coilT) * (1 - rolled)
        + S.flick * Math.sin(S.ph * phase - 0.9 * ii - off) - 0.25 * sink;
      fold[fb + i] = Math.min(1.45, Math.max(-0.35, f));
    }
    vee[j] = S.pV + 0.25 * coilT;
  }

  // Arms clear of the floor: lift any arm whose lowest joint dips below a margin (pinnules too).
  // A crawling arm's tip is on the floor by construction, so the lift fades out with crawl.
  if (P.root.y < SHAPE.arm.len + 0.3 && S.crawl < 1) {
    for (let j = 0; j < ARMS; j++) {
      const C = P.chains[j];
      for (let n = 0; n < 3; n++) {
        const r = lowest(C, LA, yRow, 2), worst = 0.09 - (P.root.y + r.y);
        if (worst <= 0) break;
        C.tilt += (1 - S.crawl) * worst / Math.max(0.35, r.h);
      }
    }
  }
  return P;
}
