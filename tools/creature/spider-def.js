// The peacock spider (Maratus volans, a jumping spider): a boxy cephalothorax with a flat face of
// huge forward eyes, an abdomen that rises and spreads side flaps into a patterned fan, eight legs
// (leg III long, black, white-tipped: the male's flags), short pedipalps. Pure maths, no three.js
// (see core.js for the contract). Its movement library is the male's courtship dance first.
//
// What it adds over the centipede:
//   - PLANTED FEET (inverse kinematics). The body follows a path (an orbit, hops, side-steps); each
//     foot holds one point on the floor through its stance and swings to the next, and every leg's
//     joints are solved to reach its foot: yaw at the hip, then a two-link solve in the leg's own
//     vertical plane (coxa + femur, then patella → tarsus with a fixed curl). Exact by chainFK.
//   - FLIGHTS. hopN short hops a loop: the feet leave the floor, the body arcs, lands, absorbs. A
//     foot never holds one point across a flight: each flight splits time into epochs and a
//     foot's hold is clamped into its own epoch, so it re-plants after landing.
//   - A FAN on bones. The abdomen hangs on a pedicel: pitch raises it upright behind the carapace
//     (its back then faces forward), twist wags it side to side. Ten short two-bone ribs along its
//     sides fold the flaps down round the belly or spread them out flat into the disc; the view
//     (spider-view.js) skins the fan over the ribs; the hinge outline both use is SHAPE, here, which
//     the view imports (view → def, never def → view: this file stays pure maths).
//   - LEG POSES on top: a raised leg is posed by angles and blended over its IK solution, so legs
//     III can be lifted and waved while the other six keep standing.
import { TAU, scatter, chainLengths, M3 } from './core.js';

// Abdomen and fan geometry, shared with the view (spider-view.js imports it). Carapace lengths; s
// runs back along the abdomen from the pedicel end, which is the bottom of the fan when it is
// raised. After the owner's photos (Maratus volans): the spread fan is a wide dome, about twice the
// carapace's width, widest a third of the way up, flat-ish at the bottom, round at the top.
export const SHAPE = {
  ped: 0.12, abd: 0.95, pedH: 0.15,      // pedicel, abdomen length; pedicel above the coxa line
  hw: 0.29, hp: 2.3,                     // hinge half-width at the widest; superellipse power
  ribs: [0.12, 0.31, 0.5, 0.69, 0.88],   // rib positions along the abdomen (fractions)
  ribLen: 0.56,
  fanMax: 0.8,                           // the spread fan's half-width at its widest
  hinge(s) { const x = Math.min(1, Math.abs(2 * s / this.abd - 1)); return this.hw * Math.pow(1 - Math.pow(x, this.hp), 1 / this.hp); },
  hingeD(s) { const e = 1e-4; return (this.hinge(s + e) - this.hinge(s - e)) / (2 * e); },
  fanW(s) {
    const y = s / this.abd, d = y < 0.35 ? (0.35 - y) / 0.42 : (y - 0.35) / 0.65;
    return this.fanMax * Math.sqrt(Math.max(0, 1 - d * d));
  },
};
const SH = SHAPE;

export const NAME = 'Peacock spider';
export const LOOP_SECONDS = 4;

const LC = 1;                        // carapace length (a male is ~4.5 mm long overall)
export const BODY = { length: LC };
// Hips (coxae) on the carapace's own frame: y along it (0 = the face, −LC = the back), rad out
// from its axis. The axis runs at coxa height, so the carapace shell rises mostly above it.
const HIP = [{ y: -0.32, rad: 0.24 }, { y: -0.46, rad: 0.27 }, { y: -0.6, rad: 0.27 }, { y: -0.74, rad: 0.23 }];
const LEGLEN = [1.2, 1.08, 1.7, 1.4];          // I, II, III (the male's long flag legs), IV
// Six equal bones per leg, stretched to spider proportions: coxa, femur, patella, tibia,
// metatarsus, tarsus. (Sum 6: the total length stays; the skin thickens where a bone is short.)
const BL = [0.45, 1.5, 0.6, 1.3, 1.25, 0.9];
const NRIB = SH.ribs.length;

// custom (read by the view's shader, spider-view.js): [kind, k, q, 0], kind 1 leg, 2 leg III,
// 3 palp. The shader recovers how far along the limb a point is (u, 0 → 1) from the tube's
// length count vSk.y: u = (1 − exp(−vSk.y·k)) / q, with q = 1 − r1/r0 and k = r0·q / length.
const limbFx = (c, kind) => { const q = 1 - c.r1 / c.r0; return { ...c, custom: [kind, c.r0 * q / c.length, q, 0] }; };
// Fur (the engine's shell fur; lengths in carapace lengths). Legs: hair combed toward the tip.
// Legs III: the same, then a dense black brush on the metatarsus and a white tuft on the tarsus
// (u: how far along the leg; the six bind segments are equal, so the metatarsus is 4/6..5/6).
// Sparse, as on the real animal (owner, twice: too dense): a few fine setae, not a coat. Fine
// cells (freq) with few of them growing a hair (dens): a strand is ~0.4 of its cell wide, so a
// coarser grid only makes thicker bristles.
const LEG_FUR = { len: 0.035, dens: 0.1, tip: 0.3, freq: 100 };
const FLAG_FUR = u => u > 0.85 ? { len: 0.05, dens: 0.3, tip: 0.5, freq: 110 }
  : u > 0.63 ? { len: 0.07, dens: 0.35, tip: 0, freq: 110 } : LEG_FUR;
const leg = (p, o) => limbFx({ group: 'leg ' + ['I', 'II', 'III', 'IV'][p], count: 2, bones: 6, length: LEGLEN[p], decay: 1, stiff: 4,
  on: { chain: 0, bone: () => 0 }, rs: 10, rings: 60, art: 6, pinch: 0.14, dark: 0.06, tint: 0xffffff, tipTint: 0xffffff,
  fur: p === 2 ? FLAG_FUR : LEG_FUR, ...o }, p === 2 ? 2 : 1);
export const CHAINS = [
  { group: 'body', count: 1, bones: 1, length: LC, r0: 0.3, r1: 0.3, rs: 8, decay: 1, tube: false, stiff: 3 },
  // Pedicel (the waist) + abdomen, from the back of the carapace, raised above its axis.
  { group: 'abdomen', count: 1, bones: 2, length: SH.ped + SH.abd, r0: 0.3, r1: 0.3, rs: 8, decay: SH.abd / SH.ped,
    tube: false, stiff: 3.5, on: { chain: 0, bone: () => 1 } },
  // Banded brown and white, hairy (the colour is the view's shader; tint stays white).
  leg(0, { r0: 0.064, r1: 0.026 }),
  leg(1, { r0: 0.058, r1: 0.024 }),
  leg(2, { r0: 0.068, r1: 0.042 }),     // leg III: thick to the end, a black brush and a white tip
  leg(3, { r0: 0.06, r1: 0.024 }),
  // Pedipalps: short, ending in big white fluffy pads that hang in front of the chelicerae.
  limbFx({ group: 'palp', count: 2, bones: 4, length: 0.3, r0: 0.034, r1: 0.1, rs: 10, decay: 1, stiff: 3,
    on: { chain: 0, bone: () => 0 }, tint: 0xffffff, tipTint: 0xffffff, art: 4, pinch: 0.1, dark: 0.1, rings: 28,
    fur: u => ({ len: u > 0.35 ? 0.055 : 0.03, dens: u > 0.35 ? 0.45 : 0.15, tip: 0.55, freq: 120 }) }, 3),   // the fluffiest part
  // Fan ribs: two bones each, from the abdomen's side edge outward; the view hangs the flaps on them.
  { group: 'flap', count: 2 * NRIB, bones: 2, length: SH.ribLen, r0: 0.01, r1: 0.01, rs: 4, decay: 1, tube: false, stiff: 2.4,
    on: { chain: 1, bone: () => 1 } },
];
const LEG0 = 2, PALP0 = LEG0 + 8, RIB0 = PALP0 + 2;

export const INT_KEYS = ['spin', 'goH', 'peerH', 'sideH', 'surgeH', 'hopN', 'wh', 'pitchH', 'rockH', 'bobH',
  'vibH', 'vibPH', 'flickH', 'wagH', 'l3H', 'l1H', 'groomH', 'palpH'];

export const DEFAULT = {
  // the path the body follows (the feet step to keep up)
  height: 0.36,  // hips above the floor
  crouch: 0,     // lowers the body
  yaw: 0,        // heading (radians), held
  spin: 0,       // whole turns per loop
  orbit: 0,      // walks round a circle of this radius (with spin)
  go: 0,         // stop-go: 0 = steady, 1 = full pauses between bursts
  goH: 4,        // bursts per loop
  peer: 0,       // turns to look left and right
  peerH: 1,
  side: 0,       // side-steps (a shuffle) left and right
  sideH: 1,
  surge: 0,      // forward and back
  surgeH: 1,
  // flights
  hop: 0,        // 1 = the feet leave the floor in each flight
  hopN: 1,       // flights per loop
  hopW: 0.2,     // share of each flight's cycle spent in the air
  hopD: 0,       // straight distance of each hop (along the heading it took off with)
  hopH: 0.5,     // height of the arc
  lunge: 0,      // share of the orbit covered in the flights (a pounce)
  reach: 0,      // legs I and II reach forward in the air
  // stepping
  wh: 4,         // steps per loop
  duty: 0.6,     // share of a step spent standing
  liftH: 0.12,   // foot lift on the swing
  alt: 1,        // alternating tetrapods (L1 R2 L3 R4 / R1 L2 R3 L4)
  lag: 0.15,     // each pair a little later than the one in front
  irr: 0.15,     // per-leg phase scatter
  // body attitude (the feet stay put)
  pitch: 0.03,   // nose up
  pitchA: 0, pitchH: 1,
  rock: 0,       // rolls and sways side to side
  rockH: 1,
  bob: 0,        // bounces up and down
  bobH: 2,
  breathe: 0.012,
  twitch: 0,     // one quick start a loop (palps, front legs)
  // abdomen and fan
  fan: 0,        // abdomen raised upright (1)
  pump: 0,       // raises and lowers once a loop
  flap: 0,       // flaps spread into the disc (1) or folded round the belly (0)
  flick: 0,      // the flaps snap half shut and open again
  flickH: 4,
  wag: 0,        // the fan sways side to side
  wagH: 2,
  vib: 0,        // the abdomen trembles (rumble)
  vibH: 48,
  vibP: 0,       // the tremble comes in pulses
  vibPH: 4,
  dance: 0,      // the whole courtship in one loop (gates wag, tremble, flicks, waving in turn)
  // legs III, the flags
  l3: 0,         // raised (1)
  l3A: 0,        // waved
  l3H: 2,
  l3Alt: 0,      // 0 together, 1 in turn (semaphore)
  l3Out: 0.3,    // 0 upright beside the fan, 1 out to the sides
  l3Wag: 0,      // the raised legs lean with the wagging fan
  // legs I
  l1: 0,         // raised forward (threat)
  l1A: 0,
  l1H: 2,
  groom: 0,      // legs I wipe the eyes
  groomH: 6,
  // pedipalps
  palpA: 0.08,   // flicking
  palpH: 2,
  palpAlt: 1,    // the two in turn
  palpUp: 0,     // raised
};

export const GROUPS = ['resting', 'getting around', 'feeding', 'reacting', 'display'];

// Courtship after Girard, Kasumovic & Elias (2011) on Maratus volans: the male raises legs III and
// waves them, lifts the abdomen and spreads its flaps into the fan, flicks and wags it, shuffles
// from side to side in front of the female, and trembles the abdomen ("rumble-rumps").
export const SEGMENTS = [
  { name: 'Still',      group: 'resting',        desc: 'crouched, fan folded, palps barely moving',
    s: { wh: 2, liftH: 0 } },
  { name: 'Groom',      group: 'resting',        desc: 'wipes the big front eyes with the front legs and palps',
    s: { wh: 2, liftH: 0, groom: 1, groomH: 6, palpA: 0.25, palpH: 6, pitch: 0.12, crouch: 0.02 } },
  { name: 'Peer',       group: 'resting',        desc: 'turns the whole body to look left, then right, in small steps',
    s: { peer: 0.7, peerH: 1, wh: 8, duty: 0.55, liftH: 0.1, palpA: 0.2, palpH: 4, pitch: 0.08 } },
  { name: 'Walk',       group: 'getting around', desc: 'jerky bursts of walking round a circle',
    s: { orbit: 1.3, spin: 1, go: 0.7, goH: 3, wh: 12, duty: 0.55, liftH: 0.16, palpA: 0.15, palpH: 3 } },
  { name: 'Jump',       group: 'getting around', desc: 'a short hop, turning round in the air; and the hop back',
    s: { hop: 1, hopN: 2, hopW: 0.24, hopD: 0.75, hopH: 0.55, lunge: 1, spin: 1, wh: 2, liftH: 0, reach: 0.3 } },
  { name: 'Stalk',      group: 'feeding',        desc: 'low and slow, stopping and starting, front legs ready',
    s: { orbit: 0.55, spin: 1, go: 0.95, goH: 5, wh: 10, duty: 0.7, liftH: 0.08, crouch: 0.1, pitch: -0.04, l1: 0.3,
         palpA: 0.04 } },
  { name: 'Pounce',     group: 'feeding',        desc: 'creeps round, gathers, and leaps on its prey front legs first',
    s: { hop: 1, hopN: 1, hopW: 0.18, hopH: 0.35, lunge: 0.2, orbit: 0.9, spin: 1, wh: 6, duty: 0.65, liftH: 0.08,
         crouch: 0.06, reach: 1, l1: 0.15, palpA: 0.05 } },
  { name: 'Freeze',     group: 'reacting',       desc: 'goes still, pressed low; one start',
    s: { wh: 2, liftH: 0, crouch: 0.1, breathe: 0.004, palpA: 0, twitch: 1 } },
  { name: 'Threat',     group: 'reacting',       desc: 'rises up on its legs, front legs raised and waving',
    s: { wh: 2, liftH: 0, height: 0.44, pitch: 0.2, l1: 1, l1A: 0.4, l1H: 2, palpUp: 0.5, palpA: 0.2, palpH: 4, fan: 0.15 } },
  { name: 'Retreat',    group: 'reacting',       desc: 'backs away round a circle, front legs up',
    s: { orbit: 0.8, spin: -1, wh: 10, duty: 0.55, liftH: 0.14, l1: 0.8, l1A: 0.2, l1H: 4, pitch: 0.12, palpUp: 0.4 } },
  { name: 'Semaphore',  group: 'display',        desc: 'legs III up, waved in turn like flags; the fan half up',
    s: { l3: 1, l3A: 0.8, l3H: 2, l3Alt: 1, l3Out: 0.7, fan: 0.3, flap: 0.15, palpA: 0.3, palpH: 4 } },
  { name: 'Raise fan',  group: 'display',        desc: 'the abdomen lifts upright and the flaps spread into the fan; then it folds',
    s: { pump: 1, l3: 0.7, l3Out: 0.3, palpA: 0.15, palpH: 4 } },
  { name: 'Flick',      group: 'display',        desc: 'fan up, the flaps snap half shut and open again',
    s: { fan: 1, flap: 1, flick: 1, flickH: 6, l3: 1, l3Out: 0.15, l3A: 0.3, l3H: 6 } },
  { name: 'Fan wag',    group: 'display',        desc: 'the fan sways side to side, legs III framing it and moving with it',
    s: { fan: 1, flap: 1, wag: 0.55, wagH: 4, l3: 1, l3Out: 0, l3Wag: 1, l3A: 0.1, l3H: 4 } },
  { name: 'Shuffle',    group: 'display',        desc: 'side-steps left and right with the fan up',
    s: { fan: 1, flap: 1, side: 0.3, sideH: 2, wh: 8, duty: 0.5, liftH: 0.12, l3: 1, l3Out: 0.1, l3A: 0.2, l3H: 4 } },
  { name: 'Rock',       group: 'display',        desc: 'the body rocks from side to side under the fan',
    s: { fan: 0.95, flap: 1, rock: 1, rockH: 2, wag: 0.2, wagH: 2, l3: 1, l3Out: 0.1, l3A: 0.15, l3H: 2 } },
  { name: 'Bounce',     group: 'display',        desc: 'bobs up and down, legs III pumping',
    s: { fan: 0.9, flap: 1, bob: 0.07, bobH: 8, l3: 1, l3Out: 0.2, l3A: 0.35, l3H: 8 } },
  { name: 'Rumble',     group: 'display',        desc: 'fan up, the abdomen trembles in pulses',
    s: { fan: 1, flap: 1, vib: 1, vibH: 48, vibP: 1, vibPH: 4, l3: 1, l3Out: 0.05 } },
  { name: 'Dance',      group: 'display',        desc: 'the courtship in one phrase: flags, fan wag, shuffle, tremble, flicks',
    s: { dance: 1, fan: 0.9, flap: 0.95, l3: 1, l3A: 0.6, l3H: 4, l3Alt: 1, l3Out: 0.2, l3Wag: 1, wag: 0.45, wagH: 6,
         vib: 0.9, vibH: 48, bob: 0.06, bobH: 8, rock: 0.6, rockH: 3, flick: 0.6, flickH: 8, side: 0.18, sideH: 1,
         wh: 8, duty: 0.55, liftH: 0.1, palpA: 0.25, palpH: 8 } },
];

// ---- Constants derived from the anatomy ------------------------------------------------
const PI = Math.PI;
const PIV = [-0.5, 0, 0];                       // the body turns and rocks about the carapace's middle
const HS = 0.4;                                 // a flight starts this far into its cycle
const SC = scatter(8, 777);
const LSEG = LEGLEN.map(L => chainLengths(6, L, 1).map((l, i) => l * BL[i]));   // posed segment lengths
// Where each foot stands, round its hip: angle from straight ahead, horizontal reach.
const FOOT = [{ ang: 0.5, r: 0.7 }, { ang: 1.15, r: 0.64 }, { ang: 1.95, r: 1.15 }, { ang: 2.55, r: 0.95 }];
const NX = [], NZ = [], FLY = [];
for (let j = 0; j < 8; j++) {
  const p = j >> 1, sg = j & 1 ? -1 : 1, F = FOOT[p];
  // body frame: x forward, y up, z the side (the carapace frame's sg = +1 side is body −z)
  const hx = HIP[p].y, hz = -sg * HIP[p].rad;
  NX[j] = hx + F.r * Math.cos(F.ang) - PIV[0]; NZ[j] = hz - sg * F.r * Math.sin(F.ang) - PIV[2];   // ground frame, from the pivot
  FLY[j] = [hx + 0.85 * F.r * Math.cos(F.ang), -0.05, hz - sg * 0.85 * F.r * Math.sin(F.ang)];     // in the air, tucked: body frame
}
// The carapace bone's frame in the body (chainFK of chain 0: a = π, tilt = π/2, no bends):
// its x is up, y forward, z the side.
const RB = M3.mul(M3.ry(-PI), M3.rz(PI / 2));
// Leg shape for the solve: femur raised this much from the coxa; patella → tarsus curl.
const T1 = 0.75, TD = [-0.25, -0.2, -0.15];
const LINK = LSEG.map(ls => {
  const ax = ls[0] + ls[1] * Math.cos(T1), ay = ls[1] * Math.sin(T1);
  let bx = 0, by = 0, a = 0;
  for (let i = 2; i < 6; i++) { if (i > 2) a += TD[i - 3]; bx += ls[i] * Math.cos(a); by += ls[i] * Math.sin(a); }
  return { LA: Math.hypot(ax, ay), aA: Math.atan2(ay, ax), LB: Math.hypot(bx, by), aB: Math.atan2(by, bx) };
});
// Posed legs, in each leg's own plane: tilt (π/2 straight out, more = forward), then bends (+ = up).
const POSE_L3 = { tilt: 1.35, th: [0.3, 0.95, -0.1, 0.1, 0.1, 0.05] };     // flag leg: up beside the fan in a V, nearly straight
const POSE_L1 = { tilt: 2.35, th: [0.25, 0.6, -0.75, -0.1, -0.1, -0.05] }; // front leg raised forward
const POSE_GROOM = { tilt: 3.35, th: [0.35, 0.75, -1.4, -0.3, -0.3, -0.1] };   // past π: turned in, tips meet in front
const POSE_REACH = { tilt: 2.45, th: [0.15, 0.35, -0.5, -0.05, -0.05, 0] };

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const ss = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const wrap = x => x - TAU * Math.round(x / TAU);                      // 2π·n → 0, so whole turns meet at the seam
const bump = (t, c, n) => Math.pow((1 + Math.cos(t - c)) / 2, n);    // periodic bump at c, narrower as n grows
const tmv = (A, v) => [A[0] * v[0] + A[3] * v[1] + A[6] * v[2], A[1] * v[0] + A[4] * v[1] + A[7] * v[2], A[2] * v[0] + A[5] * v[1] + A[8] * v[2]];

// ---- The path ------------------------------------------------------------------------
// Flight k of hopN: phase window [HS, HS + hopW] of its cycle. n counts the flights so far
// (with this one's progress), so it climbs 0 → hopN over a loop. The body only rises in the first
// LIFT of a flight and only settles in the last: it travels once the feet are off the floor, or
// the planted feet would be dragged after it.
const LIFT = 0.08;
function flight(S, t) {
  const c = S.hopN * t / TAU, k = Math.floor(c), f = c - k, x = clamp((f - HS) / S.hopW, 0, 1);
  const xt = clamp((x - LIFT) / (1 - 2 * LIFT), 0, 1);
  return { k, f, x, n: k + 0.5 * xt + 0.5 * ss(0, 1, xt) };
}
// Where the body's ground frame is at phase t: [x, z, heading]. Periodic in t (heading by whole turns).
function path(S, t) {
  const fl = flight(S, t);
  const g = t + S.go * Math.sin(S.goH * t) / S.goH;               // stop-go progress, 0 → 2π
  const q = (1 - S.lunge) * g + S.lunge * TAU * fl.n / S.hopN;    // the lunge share is covered only in flight
  const H0 = S.yaw + S.spin * q;
  let x = S.orbit * Math.sin(H0), z = S.orbit * Math.cos(H0);    // forward round the circle as H0 grows
  if (S.hopD) {
    const n = fl.n - S.hopN * Math.floor(t / TAU);                 // this loop's flights only
    for (let k = 0; k < S.hopN; k++) {
      const d = S.hopD * clamp(n - k, 0, 1), Hk = S.yaw + S.spin * TAU * k / S.hopN;
      x += d * Math.cos(Hk); z -= d * Math.sin(Hk);
    }
  }
  const sd = S.side * Math.sin(S.sideH * t), sf = S.surge * Math.sin(S.surgeH * t);
  x += sf * Math.cos(H0) + sd * Math.sin(H0); z += -sf * Math.sin(H0) + sd * Math.cos(H0);
  return [x, z, H0 + S.peer * Math.sin(S.peerH * t)];
}
// One leg's step at phase t: when (h) the point it stands on was under its neutral spot, and lift.
function step(S, t, off) {
  const c = (S.wh * t - off) / TAU, k = Math.floor(c), f = c - k, d = S.duty;
  let n = k + d / 2, s = 0;
  if (f >= d) { s = (f - d) / (1 - d); n += ss(0, 1, s); }
  return { h: (TAU * n + off) / S.wh, lift: s > 0 ? Math.sin(PI * s) : 0 };
}
// Flights split time into epochs (midpoint to midpoint); a foot's hold stays in its own epoch.
function holdClamp(S, t, h) {
  const w = TAU / S.hopN, k = Math.floor(t / w - (HS + S.hopW / 2));
  return clamp(h, (k + HS + S.hopW) * w, (k + 1 + HS) * w);
}

// ---- Leg solve -----------------------------------------------------------------------
// v: the foot target in the carapace frame. Fills th (bends, + = up), returns the hip tilt.
function solveLeg(v, p, sg, th) {
  const hp = HIP[p], L = LINK[p];
  const g = M3.mv(M3.ry(sg * PI / 2), [v[0], v[1] - hp.y, v[2] - sg * hp.rad]);   // undo Ry(−a)
  const tilt = Math.atan2(g[0], -g[1]);                                         // yaw the leg's plane onto it
  const u = Math.sin(tilt) * g[0] - Math.cos(tilt) * g[1], w = -sg * g[2];     // out, up, in that plane
  const D = clamp(Math.hypot(u, w), Math.abs(L.LA - L.LB) + 1e-4, L.LA + L.LB - 1e-4), ga = Math.atan2(w, u);
  const be = Math.acos(clamp((L.LA * L.LA + D * D - L.LB * L.LB) / (2 * L.LA * D), -1, 1));
  const pA = ga + be, kx = L.LA * Math.cos(pA), ky = L.LA * Math.sin(pA);     // knee up
  const pB = Math.atan2(D * Math.sin(ga) - ky, D * Math.cos(ga) - kx);
  th[0] = pA - L.aA; th[1] = T1; th[2] = pB - L.aB - th[0] - T1; th[3] = TD[0]; th[4] = TD[1]; th[5] = TD[2];
  return tilt;
}
const TH = new Float64Array(6);
function blendPose(pose, w, tilt, dt, dth) {
  if (w <= 0) return tilt;
  for (let i = 0; i < 6; i++) TH[i] += w * (pose.th[i] + (dth ? dth[i] : 0) - TH[i]);
  return tilt + w * (pose.tilt + dt - tilt);
}

export function pose(S, t, P) {
  // ---- The dance phrase: its parts come in turn over the loop ---------------------------
  const D = S.dance, gate = c => 1 - D + D * bump(t, c, 3);
  const wagA = S.wag * gate(2.3), vibA = S.vib * gate(3.9), flickA = S.flick * gate(5.5);
  const l3A = S.l3A * gate(0.8), rockA = S.rock * gate(5.2), bobA = S.bob * gate(3.9);

  // ---- Flight and body ------------------------------------------------------------------
  const fl = flight(S, t), inW = fl.f >= HS && fl.f <= HS + S.hopW;
  const air = inW ? S.hop * ss(0, LIFT, fl.x) * (1 - ss(1 - LIFT, 1, fl.x)) : 0;   // feet off before it travels
  const arc = inW ? S.hop * Math.sin(PI * fl.x) : 0;
  const dip = S.hop * (Math.exp(-(((fl.f - HS) / 0.05) ** 2)) + Math.exp(-(((fl.f - HS - S.hopW) / 0.06) ** 2)));
  const [gx, gz, H] = path(S, t);
  const tw = S.twitch * bump(t, 2, 80);
  const raise = clamp(S.fan + S.pump * ss(0.12, 0.88, 0.5 - 0.5 * Math.cos(t)), 0, 1.1), ru = Math.min(1, raise);
  // (+ 0.07·ru: it stands tall while it displays)
  const y = S.height + 0.07 * ru - S.crouch - 0.07 * dip + S.hopH * arc + bobA * (0.5 - 0.5 * Math.cos(S.bobH * t))
    + S.breathe * Math.sin(t) + 0.004 * vibA * Math.sin(S.vibH * t) + 0.02 * tw;
  const pitch = S.pitch + S.pitchA * Math.sin(S.pitchH * t)      // nose up off the floor, down to land (less on a low hop)
    + (inW ? 0.22 * S.hop * Math.min(1, S.hopH / 0.55) * Math.sin(TAU * fl.x) : 0);
  const roll = 0.2 * rockA * Math.sin(S.rockH * t);
  const sway = 0.09 * rockA * Math.sin(S.rockH * t);
  const R = M3.mul(M3.mul(M3.ry(H), M3.rz(pitch)), M3.rx(roll));
  const o = M3.mv(R, PIV);
  const rp = [gx + sway * Math.sin(H) - o[0], y - o[1], gz + sway * Math.cos(H) - o[2]];
  P.root.x = rp[0]; P.root.y = rp[1]; P.root.z = rp[2];
  P.root.ry = wrap(H); P.root.rz = pitch; P.root.rx = roll;
  P.parts.floor = 1;

  const C0 = P.chains[0];
  C0.a = PI; C0.rad = 0; C0.y = 0; C0.tilt = PI / 2; C0.len = 1;
  const Rc = M3.mul(R, RB);                      // the carapace frame in the world

  // ---- Legs ---------------------------------------------------------------------------
  const lw = ss(0, 0.3, S.hop);
  const wagV = wagA * Math.sin(S.wagH * t);
  for (let j = 0; j < 8; j++) {
    const p = j >> 1, side = j & 1, sg = side ? -1 : 1, C = P.chains[LEG0 + j];
    const off = S.alt * PI * ((p + side) % 2) + S.lag * p + S.irr * 0.5 * Math.sin(SC[j]);
    const st = step(S, t, off);
    const h = st.h + lw * (holdClamp(S, t, st.h) - st.h);
    const [hx, hz, hH] = path(S, h), c = Math.cos(hH), s = Math.sin(hH);
    let F = [hx + c * NX[j] + s * NZ[j], S.liftH * st.lift, hz - s * NX[j] + c * NZ[j]];
    if (air > 0) {
      const A = M3.mv(R, FLY[j]);
      for (let i = 0; i < 3; i++) F[i] += air * (rp[i] + A[i] - F[i]);
    }
    let tilt = solveLeg(tmv(Rc, [F[0] - rp[0], F[1] - rp[1], F[2] - rp[2]]), p, sg, TH);
    if (p === 2) {                               // the flags
      const wv = Math.sin(S.l3H * t + side * S.l3Alt * PI), lean = -sg * S.l3Wag * 0.8 * wagV * ru;
      tilt = blendPose(POSE_L3, S.l3, tilt, 0.6 * S.l3Out + 0.25 * l3A * Math.cos(S.l3H * t + side * S.l3Alt * PI),
        [0.35 * l3A * wv + lean - 0.25 * S.l3Out, 0.3 * l3A * wv + 0.5 * lean - 0.2 * S.l3Out, 0, 0, 0, 0]);
    }
    if (p === 0) {
      const wv = Math.sin(S.l1H * t + side * PI);
      tilt = blendPose(POSE_L1, S.l1, tilt, 0, [0.25 * S.l1A * wv, 0.3 * S.l1A * wv, 0, 0, 0, 0]);
      const rub = Math.sin(S.groomH * t + side * PI);
      tilt = blendPose(POSE_GROOM, S.groom, tilt, 0.1 * rub, [0.08 * rub, 0, 0.2 * rub, 0.1 * rub, 0, 0]);
      if (tw) for (let i = 0; i < 2; i++) TH[i] += 0.25 * tw;
    }
    if (p < 2) tilt = blendPose(POSE_REACH, S.reach * air, tilt, p ? -0.4 : 0, null);
    C.a = sg * PI / 2; C.rad = HIP[p].rad; C.y = HIP[p].y; C.tilt = tilt; C.len = 1;
    for (let i = 0; i < 6; i++) { C.bx[i] = sg * TH[i]; C.by[i] = 0; C.bz[i] = 0; C.bl[i] = BL[i]; }
  }

  // ---- Pedipalps ------------------------------------------------------------------------
  for (let j = 0; j < 2; j++) {
    const C = P.chains[PALP0 + j], sg = j ? -1 : 1;
    // Grooming, they rise in front of the face and wipe up and down over the big eyes, in turn.
    const fk = S.palpA * Math.sin(S.palpH * t + j * S.palpAlt * PI) + 0.5 * tw, wipe = S.groom * (0.5 + 0.5 * Math.sin(S.groomH * t + j * PI));
    C.a = sg * PI / 2; C.rad = 0.08; C.y = -0.05; C.tilt = PI - 0.3 - 0.15 * S.groom; C.len = 1;
    C.bx[0] = sg * (-0.3 + S.palpUp + 0.5 * fk + S.groom * 0.9 + 0.5 * wipe); C.bx[1] = sg * (-0.75 + 0.3 * S.palpUp + 0.4 * S.groom);
    C.bx[2] = sg * (-0.1 - 0.6 * wipe); C.bx[3] = sg * (0.15 - 0.3 * wipe);
  }

  // ---- Abdomen and fan ------------------------------------------------------------------
  // Pedicel pitch (bz) lifts the abdomen; once upright, twist about the carapace's long axis (by)
  // sways it side to side, and while it lies flat the sway is a yaw (bx).
  // Raised, the waist stretches so the fan clears the carapace and stands over it like a shield,
  // leaning a little forward (the photos and reels).
  const C1 = P.chains[1];
  const vib = vibA * Math.sin(S.vibH * t) * (1 - S.vibP + S.vibP * bump(S.vibPH * t, 0, 4));
  C1.a = 0; C1.rad = SH.pedH; C1.y = -0.03; C1.tilt = 0; C1.len = 1; C1.bl[0] = 1 + 1.6 * ru;
  C1.bz[0] = 0.1 + 1.1 * raise + 0.06 * vib + 0.02 * Math.sin(t + 0.5) * (1 - ru);
  C1.by[0] = 0.5 * wagV * ru; C1.bx[0] = 0.3 * wagV * (1 - ru);
  C1.bz[1] = -0.08 + 0.58 * raise + 0.04 * vib; C1.by[1] = 0; C1.bx[1] = 0;
  // Flaps: open spreads every rib out flat with a slight dish; shut folds it down round the belly,
  // its outer half curling under. A flick snaps them half shut.
  const fk = flickA * Math.pow(0.5 + 0.5 * Math.sin(S.flickH * t), 4);
  const open = clamp(S.flap + S.pump * ss(0.4, 0.95, 0.5 - 0.5 * Math.cos(t)) - 0.55 * fk, 0, 1);
  for (let j = 0; j < 2 * NRIB; j++) {
    const r = j >> 1, sg = j & 1 ? -1 : 1, C = P.chains[RIB0 + j], s = SH.ribs[r] * SH.abd, e = Math.abs(2 * SH.ribs[r] - 1);
    C.a = sg * PI / 2; C.rad = SH.hinge(s); C.y = -s; C.tilt = PI / 2 + Math.atan(SH.hingeD(s)); C.len = 1;
    C.bx[0] = sg * (open * (0.1 - 0.06 * e) - (1 - open) * (1.5 + 0.2 * e));
    C.bx[1] = sg * (open * 0.06 - (1 - open) * 1.4);
  }
  return P;
}
