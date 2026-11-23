// The centipede: a long segmented body with twenty pairs of legs, long trailing tail legs,
// antennae and venom claws. Pure maths, no three.js (see core.js for the contract).
//
// What it adds over the octopus:
//   - CHAINS ON CHAINS: every leg grows from a bone of the body chain, so when the body bends
//     the legs go with it (CHAINS `on`).
//   - METACHRONAL WAVE: each leg pair runs the same step cycle, k later than the pair in front.
//     k > 0 sends the wave from head to tail (a centipede's own, "retrograde"); k < 0 sends it
//     forward, as a millipede does. A step cycle is a push back with the foot planted (duty = the
//     share of the cycle spent planted, at one constant speed) and a lifted swing forward; duty
//     makes the swing quick and the push long (a slow, stable walk) or the two even (a run).
//     A negative step harmonic walks backwards.
//   - BODY SHAPE BY ANGLE: pose() writes the heading and pitch every body segment should have
//     (a travelling S-wave, a coil, a raised front) and turns them into joint bends.
//   - WEIGHT: pose() then works out exactly where that leaves the body and every foot (the same
//     forward kinematics the page applies, core.js chainFK) and places the body: centred on the
//     ground plan, with whatever is lowest — feet, or belly when the legs are folded — on the
//     floor. Take gravity away (grav → 0) and it floats round its own centre instead, free to
//     tumble and roll; the floor fades out with it.
import { TAU, scatter, chainLengths, chainFK, M3 } from './core.js';

export const NAME = 'Centipede';
export const LOOP_SECONDS = 4;

const SEGS = 22;                 // body segments: 0 = head, 21 = the last (tail legs)
const PAIRS = 20;                // walking leg pairs, on segments 1..20 (a Scolopendra has 21)
// Body-shape keys (undK, curl, coil, rearN, scan) are tuned per 1/16 of the body: SK converts, so
// changing SEGS changes how finely the body bends, not its shape.
const SK = 16 / SEGS;
export const BODY = { length: 4.0 };
const LEG = { bones: 5, length: 0.56 };
export const CHAINS = [
  { group: 'body', count: 1, bones: SEGS, length: BODY.length, r0: 0.15, r1: 0.15, rs: 12, decay: 1, tube: false, stiff: 1.4 },
  { group: 'leg', count: 2 * PAIRS, bones: LEG.bones, length: LEG.length, r0: 0.042, r1: 0.014, rs: 6, decay: 1, stiff: 4,
    on: { chain: 0, bone: j => 1 + (j >> 1) }, tint: 0xe49a2e, tipTint: 0x6a3812, art: 5, pinch: 0.13, dark: 0.4, rings: 25,
    fur: { len: 0.024, dens: 0.55, tip: 0.4 } },     // bristly legs (the plates stay bare)   // short sparse bristles (the plates stay bare)
  { group: 'tail', count: 2, bones: 6, length: 0.9, r0: 0.055, r1: 0.014, rs: 8, decay: 1, stiff: 1.6,
    on: { chain: 0, bone: () => SEGS - 1 }, tint: 0xa8481c, tipTint: 0x5a2410, art: 6, pinch: 0.2, dark: 0.4, rings: 30,
    fur: { len: 0.026, dens: 0.5, tip: 0.35 } },
  { group: 'antenna', count: 2, bones: 10, length: 1.0, r0: 0.024, r1: 0.008, rs: 6, decay: 0.93, stiff: 0.9,
    on: { chain: 0, bone: () => 0 }, tint: 0xd08a34, tipTint: 0x9a5a22, art: 18, pinch: 0.3, dark: 0.25, rings: 54,
    fur: { len: 0.013, dens: 0.65, tip: 0.45 } },     // antennae: a fine velvet
  // Venom claws (forcipules): big jointed hooks from under the head, black-tipped, curving in to meet.
  { group: 'fang', count: 2, bones: 4, length: 0.36, r0: 0.058, r1: 0.008, rs: 8, decay: 0.92, stiff: 4,
    on: { chain: 0, bone: () => 0 }, tint: 0x7a2412, tipTint: 0x0a0504, art: 4, pinch: 0.14, dark: 0.3, rings: 24 },
];
// Chain indices in P.chains, in CHAINS order.
const LEG0 = 1, TAIL0 = LEG0 + 2 * PAIRS, ANT0 = TAIL0 + 2, FANG0 = ANT0 + 2;

export const INT_KEYS = ['wh', 'spin', 'undH', 'jh', 'antH', 'tumble', 'roll'];

export const DEFAULT = {
  height: 0,     // extra clearance: 0 = whatever is lowest (feet, or belly) touches the floor
  len: 1,        // body length
  yaw: 0,        // heading (radians), held
  spin: 0,       // whole turns per loop
  orbit: 0,      // walks round a circle of this radius (with spin: once round per turn)
  // gravity
  grav: 1,       // 1 = stands on the floor, 0 = weightless (floats round its centre, floor fades)
  floatH: 1.3,   // where it floats
  tumble: 0,     // head-over-tail turns per loop
  roll: 0,       // turns round its own length per loop
  wobble: 0,     // slow drifting turns while weightless
  // legs
  wh: 4,         // steps per loop (negative walks backwards)
  stride: 0.3,   // how far each leg swings fore and aft
  liftH: 0.4,    // how high a leg lifts on its forward swing
  duty: 0.7,     // share of each step the foot spends planted (slow walks ~0.8, runs ~0.5)
  k: 0.55,       // phase lag per leg pair: + wave runs head → tail, − tail → head
  alt: 1,        // left and right legs half a cycle apart
  rake: 1,       // front legs point forward, back legs back
  spread: 0.15,  // legs angled down from the horizontal
  raise: 0.45,   // upper leg raised at the hip
  knee: 0.95,    // knee bend (down to the floor)
  fidget: 0,     // slow irregular shifting of each leg
  irr: 0.15,     // per-leg phase scatter
  paw: 0,        // legs of a raised front reach and paw the air
  reach: 0,      // legs straighten and fan out (nothing to stand on)
  plant: 1,      // planted feet stay where they landed while the body sways (0 = they ride with the hips)
  clutch: 0,     // once a loop every leg clutches in and the body curls round nothing
  // body
  undA: 0,       // side-to-side body wave
  undH: 1,       // body-wave harmonic
  undK: 0.4,     // body-wave phase per 16th of the body (wavelength)
  pitchA: 0,     // up-and-down body wave, a quarter cycle after the side-to-side one (a spiral)
  curl: 0,       // the body bends evenly to one side (heading change per 16th)
  coil: 0,       // the body rolls into a spiral, tightest at the head
  scan: 0,       // the head swings side to side, once a loop
  rear: 0,       // the front of the body rises
  rearN: 5,      // how much of the body rises, in 16ths of its length
  arch: 0,       // the middle rises and falls, once a loop (head and tail stay down)
  breathe: 0.02, // a faint arch, for resting
  jerk: 0,       // sudden S-shaped flinches
  jh: 3,         // flinches per loop
  strike: 0,     // the front draws back into an S and shoots forward, once a loop
  // appendages
  antA: 0.25,    // antenna sweep
  antH: 1,       // antenna sweeps per loop
  antAlt: 1,     // the two antennae sweep in turn
  antOut: 0.55,  // antennae spread from straight ahead
  antUp: 0.45,   // antennae raised
  antCurve: 0.5, // antennae curve outward along their length
  fang: 0.3,     // venom claws open
  tailA: 0.1,    // tail legs wave
  tailUp: 0,     // tail legs raised
};

export const GROUPS = ['resting', 'getting around', 'feeding', 'reacting', 'display', 'zero gravity'];

// Gaits, after Manton's centipede studies: slow walks keep each foot down most of the cycle
// (long push, quick swing) with a long wave of steps; faster gaits even the swing and push out,
// shorten the wave (more phase lag between neighbours), and the body starts to swim side to side.
export const SEGMENTS = [
  { name: 'Rest',    group: 'resting',        desc: 'legs splayed, still, the antennae slowly feeling the air',
    s: { stride: 0, liftH: 0, wh: 1, fidget: 1, antA: 0.3, spread: 0.35, raise: 0.25, tailA: 0.05 } },
  { name: 'Coil',    group: 'resting',        desc: 'curled up in a spiral, legs folded, breathing',
    s: { coil: 1, stride: 0, liftH: 0, wh: 1, rake: 1.6, knee: 1.5, raise: 0.1, spread: 0.5, antA: 0.1, antOut: 1.1,
         tailUp: 0.4, breathe: 0.03 } },
  { name: 'Walk',    group: 'getting around', desc: 'an unhurried walk: long waves of steps run from head to tail',
    s: { wh: 4, stride: 0.3, liftH: 0.45, duty: 0.75, k: 0.6, undA: 0.04, undH: 4, undK: 0.35, antA: 0.25, antH: 2 } },
  { name: 'Run',     group: 'getting around', desc: 'legs blur in short quick waves, the body swims from side to side',
    s: { wh: 8, stride: 0.45, liftH: 0.35, duty: 0.5, k: 1.1, undA: 0.12, undH: 8, undK: 0.5, antA: 0.1, antH: 8,
         antOut: 0.35, knee: 0.85 } },
  { name: 'Creep',   group: 'getting around', desc: 'low and slow, long careful steps, the head turning',
    s: { wh: 2, stride: 0.4, liftH: 0.3, duty: 0.85, k: 0.5, knee: 1.25, raise: 0.6, scan: 0.2, antA: 0.15, antOut: 0.35 } },
  { name: 'Reverse', group: 'getting around', desc: 'backs away: the whole step cycle runs the other way',
    s: { wh: -4, stride: 0.3, liftH: 0.45, duty: 0.75, k: 0.6, undA: 0.04, undH: 4, antA: 0.35, antH: 2, antOut: 0.8, tailUp: 0.3 } },
  { name: 'Circle',  group: 'getting around', desc: 'walks round a circle, the body bent to follow it',
    s: { wh: 12, stride: 0.45, liftH: 0.4, duty: 0.6, k: 0.7, spin: 1, orbit: 1.25, curl: -0.2, antA: 0.2, antH: 3 } },
  { name: 'Ripple',  group: 'getting around', desc: 'millipede-style: the waves of steps run forward',
    s: { wh: 4, stride: 0.28, liftH: 0.5, k: -0.7, alt: 0, duty: 0.65, antA: 0.2, antH: 2 } },
  { name: 'Sense',   group: 'feeding',        desc: 'stands still, front lifted a little, antennae sweeping in turn',
    s: { stride: 0, liftH: 0, wh: 1, fidget: 0.6, rear: 0.25, rearN: 4, scan: 0.35, antA: 0.6, antH: 2, antOut: 0.6, antUp: 0.6 } },
  { name: 'Rear',    group: 'feeding',        desc: 'the front third rears up, its legs pawing the air',
    s: { rear: 1, rearN: 6, paw: 0.8, wh: 2, stride: 0.15, liftH: 0.2, k: 0.7, antA: 0.5, antH: 2, antUp: 0.8, fang: 0.6, scan: 0.15 } },
  { name: 'Strike',  group: 'feeding',        desc: 'draws the head back into an S and lunges, claws snapping shut',
    s: { strike: 1, stride: 0.05, liftH: 0.1, wh: 1, fang: 1, antA: 0.15, antOut: 0.9, rear: 0.2, rearN: 3 } },
  { name: 'Startle', group: 'reacting',       desc: 'three sudden flinches into an S, legs splaying',
    s: { jerk: 0.5, jh: 3, stride: 0.1, wh: 3, liftH: 0.2, spread: 0.15, antA: 0.6, antH: 3, tailUp: 0.4, tailA: 0.4 } },
  { name: 'Thrash',  group: 'reacting',       desc: 'whips its whole body, legs flailing',
    s: { undA: 0.45, undH: 2, undK: 0.22, pitchA: 0.08, wh: 10, stride: 0.5, liftH: 0.6, alt: 0.5, irr: 1.5, k: 0.3, duty: 0.5,
         antA: 0.8, antH: 4, tailA: 0.8, fang: 0.7 } },
  { name: 'Wave',    group: 'display',        desc: 'standing still, the legs rise in a wave that runs the length of the body',
    s: { stride: 0.05, liftH: 1.1, wh: 2, k: 0.45, alt: 0, duty: 0.35, antA: 0.35, antH: 2, antAlt: 0 } },
  { name: 'Snake',   group: 'display',        desc: 'legs folded back, it slithers like a snake',
    s: { undA: 0.5, undH: 1, undK: 0.42, rake: 2.2, spread: -0.3, knee: 0.25, raise: 0.25, stride: 0.04, liftH: 0, wh: 1, plant: 0,
         antA: 0.15, antOut: 0.3, antUp: 0.2, tailA: 0.3 } },
  { name: 'Arch',    group: 'display',        desc: 'the middle of the body rises and falls like an inchworm',
    s: { arch: 0.45, stride: 0.08, liftH: 0.15, wh: 2, k: 0.4, antA: 0.3, antH: 1, tailUp: 0.2 } },
  // Weightless: nothing to push against, so stepping goes nowhere; the legs reach for a hold.
  // With no friction a turn, once started, keeps going; twisting the body turns it the other way.
  { name: 'Float',     group: 'zero gravity', desc: 'weightless: drifts and slowly turns over, legs spread wide, feeling for a hold',
    s: { grav: 0, wobble: 1, reach: 0.6, wh: 1, stride: 0.15, liftH: 0.3, k: 0.35, alt: 0.5, irr: 0.8, fidget: 1,
         undA: 0.12, undH: 1, undK: 0.3, pitchA: 0.1, antA: 0.45, tailA: 0.35, tailUp: 0.2 } },
  { name: 'Tumble',    group: 'zero gravity', desc: 'turns head over tail once a loop, legs flung out like the spokes of a wheel',
    s: { grav: 0, tumble: 1, wobble: 0.3, reach: 0.9, arch: 0.25, wh: 2, stride: 0.1, liftH: 0.2, k: 0.3,
         antA: 0.3, antOut: 0.8, tailA: 0.4, tailUp: 0.3 } },
  { name: 'Corkscrew', group: 'zero gravity', desc: 'a spiral wave runs down the body; it rolls round its own length, legs paddling at nothing',
    s: { grav: 0, roll: 1, undA: 0.3, pitchA: 0.3, undH: 2, undK: 0.55, reach: 0.5, wh: 4, stride: 0.3, liftH: 0.4, k: 0.6,
         antA: 0.3, antH: 2, tailA: 0.4 } },
  { name: 'Grasp',     group: 'zero gravity', desc: 'reaches out with every leg for something to hold, then clutches, curling round nothing',
    s: { grav: 0, clutch: 1, wobble: 0.5, reach: 0.9, wh: 1, stride: 0.1, liftH: 0.2, antA: 0.6, antH: 2, antOut: 0.4,
         fang: 0.8, tailA: 0.3 } },
];

const LB = chainLengths(SEGS, BODY.length, 1);
const LL = chainLengths(LEG.bones, LEG.length, 1);
const SC = scatter(2 * PAIRS, 4242);
const PSI = new Float64Array(SEGS), CHI = new Float64Array(SEGS);
const ss = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
// Planted foot's fore-aft swing radius about the hip: shorter the more the knee bends (fitted to
// the forward kinematics: Walk and Creep planted feet match the floor speed within a few percent).
const footR = knee => 0.433 - 0.32 * (knee - 0.95);
const BELLY = 0.1;               // axis to belly (the view's shell: 0.65 × 0.15)

const tr = A => [A[0], A[3], A[6], A[1], A[4], A[7], A[2], A[5], A[8]];
// Solve M d = r for d, where M's COLUMNS are the three vectors in cols (Cramer's rule); null if singular.
function solve3(cols, r) {
  const [a, b, c] = cols;
  const det = (u, v, w) => u[0] * (v[1] * w[2] - v[2] * w[1]) - u[1] * (v[0] * w[2] - v[2] * w[0]) + u[2] * (v[0] * w[1] - v[1] * w[0]);
  const D = det(a, b, c); if (Math.abs(D) < 1e-10) return null;
  return [det(r, b, c) / D, det(a, r, c) / D, det(a, b, r) / D];
}

// Narrow periodic bumps (seamless): the strike and the clutch once a loop, flinches jh times.
const bumps = (S, phase) => ({
  strikeB: Math.pow((1 + Math.cos(phase - 3.6)) / 2, 24),
  clutchB: Math.pow((1 + Math.cos(phase - 3.6)) / 2, 6),
  jerkB: Math.pow((1 + Math.cos(S.jh * phase)) / 2, 10),
});

// ---- Body at any moment of the loop: bends into C0, then where that leaves it ----------------
// Heading (PSI) + turns the head→tail direction toward +z; pitch (CHI) + tilts it up. Returns the
// body's joints in its own frame (head joint at the origin), its turn R and centre (turned, Rc),
// and the heading H. Root height is not here: it needs the feet (see pose).
function bodyAt(S, phase, C0) {
  const B = SEGS, PI = Math.PI, free = 1 - S.grav, { strikeB, clutchB, jerkB } = bumps(S, phase);
  let coilAcc = 0;
  for (let i = 0; i < B; i++) {
    const t = i / (B - 1), ik = i * SK;            // ik: position along the body in 16ths
    coilAcc += S.coil * 0.5 * SK * (1.25 - 0.85 * t) * (1 + 0.03 * Math.sin(phase));
    PSI[i] = S.undA * Math.sin(S.undH * phase - S.undK * ik) * (0.6 + 0.4 * t)
      + S.curl * ik + coilAcc
      + S.scan * Math.sin(phase) * (1 - ss(0, 4, ik))
      + S.jerk * jerkB * Math.sin(TAU * t)
      + S.strike * 0.55 * (1 - strikeB) * Math.sin(TAU * Math.min(1, ik / 6));
    CHI[i] = -S.rear * 0.9 * (1 - ss(0, S.rearN, ik))
      + (S.arch * (0.5 - 0.5 * Math.cos(phase)) + S.breathe * Math.sin(phase) + S.clutch * 1.3 * clutchB) * Math.cos(PI * t)
      + S.pitchA * Math.sin(S.undH * phase - S.undK * ik + PI / 2)
      - S.strike * 0.25 * strikeB * (1 - ss(0, 3, ik));
  }
  C0.a = PI; C0.rad = 0; C0.y = 0; C0.tilt = PI / 2; C0.len = S.len;   // lies along −x, head at the origin
  for (let i = 0; i < B; i++) { C0.bx[i] = PSI[i] - (i ? PSI[i - 1] : 0); C0.bz[i] = CHI[i] - (i ? CHI[i - 1] : 0); }
  const J = chainFK(C0, LB);
  let cx = 0, cy = 0, cz = 0, hs = 0, W = 0;
  for (let i = 0; i < B; i++) {
    const w = LB[i] * (0.3 + i / (B - 1));           // weighted toward the tail: a lunging head moves forward
    cx += w * (J[i].p[0] + J[i + 1].p[0]) / 2; cy += w * (J[i].p[1] + J[i + 1].p[1]) / 2; cz += w * (J[i].p[2] + J[i + 1].p[2]) / 2;
    hs += w * PSI[i]; W += w;
  }
  // Turns. Whole turns wrap (2π is 0 at the seam); the drift only while weightless.
  const H = S.yaw + S.spin * phase;                 // where the head points (radians)
  const ry = (S.spin * phase) % TAU + S.yaw - hs / W;
  const rz = (S.tumble * phase) % TAU + free * S.wobble * 0.35 * Math.sin(phase + 1);
  const rx = (S.roll * phase) % TAU + free * S.wobble * 0.6 * Math.sin(phase);
  const R = M3.mul(M3.mul(M3.ry(ry), M3.rz(rz)), M3.rx(rx));
  return { J, R, Rc: M3.mv(R, [cx / W, cy / W, cz / W]), H, rx, ry, rz };
}

// ---- One leg at any moment, in the frame of its body segment --------------------------------
// There a = ±(π/2 + spread) points the leg out to one side and down; tilt π/2 is square to the
// body, more is forward; bx bends round the body's axis: σ·bx > 0 lifts, < 0 lowers.
// landing: the pose the leg has the instant its foot touches down (end of the swing).
function legAt(S, phase, j, C, landing) {
  const PI = Math.PI, p = j >> 1, sg = j & 1 ? -1 : 1, u = p / (PAIRS - 1);
  const off = S.k * p + (j & 1) * S.alt * PI + S.irr * 0.5 * Math.sin(SC[j]);
  const ph = S.wh * phase - off;
  // Step cycle: planted for `duty` of it, pushing back at one constant speed (a floor scrolling at
  // that speed leaves the foot truly still), then lifted and swung forward, easing in and out.
  const cyc = ((ph / TAU) % 1 + 1) % 1, beta = Math.min(0.92, Math.max(0.2, S.duty));
  let fore, up;
  if (landing) { fore = S.wh < 0 ? -1 : 1; up = 0; }
  else if (cyc < beta) { fore = 1 - 2 * cyc / beta; up = 0; }
  else { const sw = (cyc - beta) / (1 - beta); fore = -Math.cos(Math.PI * sw); up = Math.sin(Math.PI * sw); }
  const raised = S.rear * (1 - ss(0, S.rearN, (1 + p) * SK));     // this leg's segment is off the floor
  const paw = raised * S.paw * (0.5 + 0.5 * Math.sin(ph));
  const fid = S.fidget * 0.09 * Math.sin(phase + SC[j]);
  const cl = S.clutch * bumps(S, phase).clutchB;
  C.a = sg * (PI / 2 + S.spread * (1 - 0.6 * raised) * (1 - S.reach)); C.rad = 0.15; C.y = -0.5 * LB[1 + p] * S.len;
  C.len = 1 + 0.25 * u;
  C.tilt = PI / 2 + S.rake * (1 - 0.6 * S.reach) * (0.25 - 0.9 * u) + S.stride * fore * (1 - raised) + fid + paw * 0.9;
  const lift = S.raise * (1 - S.reach) + S.liftH * up * up + paw * 0.6 + fid * 0.5 - 0.6 * cl;
  const kn = S.knee * (1 - 0.6 * raised) * (1 - 0.85 * S.reach) + 1.6 * cl;
  setKnee(C, sg, lift, kn);
  C.bz.fill(-0.07 * (1 - S.reach)); C.bz[0] = 0;   // each leg arches a little toward the tail
  return { cyc, beta, raised, sg };
}
function setKnee(C, sg, lift, kn) {
  C.bx[0] = sg * lift; C.bx[1] = -sg * kn; C.bx[2] = -sg * kn * 0.25; C.bx[3] = -sg * kn * 0.12; C.bx[4] = -sg * kn * 0.1;
}
// A leg's foot in its parent's frame: the same maths as chainFK, unrolled and allocation-free,
// because the planting solve calls it a dozen times per foot per frame.
const _R = new Float64Array(9), _S = new Float64Array(9), _M = new Float64Array(9), _tip = [0, 0, 0];
function mulInto(A, B, O) {
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) _M[r * 3 + c] = A[r * 3] * B[c] + A[r * 3 + 1] * B[3 + c] + A[r * 3 + 2] * B[6 + c];
  O.set(_M);
}
function rxz(x, z, O) {                       // Rx(x)·Rz(z), three.js Euler XYZ (x, 0, z)
  const cx = Math.cos(x), sx = Math.sin(x), cz = Math.cos(z), sz = Math.sin(z);
  O[0] = cz; O[1] = -sz; O[2] = 0; O[3] = cx * sz; O[4] = cx * cz; O[5] = -sx; O[6] = sx * sz; O[7] = sx * cz; O[8] = cx;
}
function legTip(C) {
  const ca = Math.cos(-C.a), sa = Math.sin(-C.a), ct = Math.cos(C.tilt), st = Math.sin(C.tilt);
  // Ry(−a)·Rz(tilt)
  _R[0] = ca * ct; _R[1] = -ca * st; _R[2] = sa; _R[3] = st; _R[4] = ct; _R[5] = 0; _R[6] = -sa * ct; _R[7] = sa * st; _R[8] = ca;
  rxz(C.bx[0], C.bz[0], _S); mulInto(_R, _S, _R);
  let x = Math.cos(C.a) * C.rad, y = C.y, z = Math.sin(C.a) * C.rad;
  const B = C.bz.length;
  for (let i = 1; i <= LL.length; i++) {
    const l = LL[i - 1] * C.len;
    x -= _R[1] * l; y -= _R[4] * l; z -= _R[7] * l;
    if (i < B) { rxz(C.bx[i], C.bz[i], _S); mulInto(_R, _S, _R); }
  }
  _tip[0] = x; _tip[1] = y; _tip[2] = z; return _tip;
}
const mkPlace = n => ({ a: 0, rad: 0, y: 0, tilt: 0, len: 1, bx: new Float64Array(n), bz: new Float64Array(n) });
const CLD = mkPlace(LEG.bones);   // scratch: a leg at touch-down

export function pose(S, phase, P) {
  const B = SEGS, PI = Math.PI, free = 1 - S.grav, { strikeB, clutchB } = bumps(S, phase);
  const C0 = P.chains[0], body = bodyAt(S, phase, C0), J = body.J, R = body.R;
  const legs = [];
  for (let j = 0; j < 2 * PAIRS; j++) legs.push(legAt(S, phase, j, P.chains[LEG0 + j], false));

  // ---- Weight: where the body and feet are, and so where the body goes --------------------
  // What can touch the floor: every foot, and the belly under every joint.
  const pts = [];
  for (let j = 0; j < 2 * PAIRS; j++) { const L = chainFK(P.chains[LEG0 + j], LL, J[1 + (j >> 1)]); pts.push(L[L.length - 1].p); }
  for (let i = 0; i <= B; i++) { const d = M3.mv(J[i].R, [-BELLY, 0, 0]); pts.push([J[i].p[0] + d[0], J[i].p[1] + d[1], J[i].p[2] + d[2]]); }
  P.root.rx = body.rx; P.root.ry = body.ry; P.root.rz = body.rz;
  // Floor: soft minimum of the turned contact points (smooth, so the body never jumps).
  const beta = 60; let m = Infinity; const ys = pts.map(v => M3.mv(R, v)[1]);
  for (const y of ys) m = Math.min(m, y);
  let acc = 0; for (const y of ys) acc += Math.exp(-beta * (y - m));
  const ground = m - Math.log(acc / ys.length) / beta;
  const H = body.H, c = body.Rc;
  P.root.x = S.orbit * Math.sin(H) - c[0];
  P.root.z = S.orbit * Math.cos(H) - c[2];
  P.root.y = S.grav * (S.height - ground) + free * (S.floatH - c[1]);
  P.parts.floor = S.grav;
  // Treadmill: planted feet push back at one steady speed; the floor scrolls with them (the page
  // moves its texture by P.parts.floorVel, world units per second), so a planted foot stays put on
  // it. No scroll when the body really travels (orbit) or floats.
  const dutyF = Math.min(0.92, Math.max(0.2, S.duty));
  const vFeet = 2 * Math.sin(S.stride) * footR(S.knee) * S.wh / (dutyF * LOOP_SECONDS) * S.grav * (1 - Math.min(1, S.orbit / 0.5));
  const fv = [-Math.cos(H) * vFeet, Math.sin(H) * vFeet];            // toward the tail
  P.parts.floorVel = fv;

  // ---- Planting: a foot on the ground stays where it landed ------------------------------
  // The step cycle alone moves a planted foot with its hip, so whenever the body sways, bends or
  // circles, the foot is dragged over the floor. Instead: find where this foot touched down
  // (the whole body and this leg, evaluated at that moment of the loop), carry that spot along
  // with the scrolling floor since then, and bend the leg to reach it (hip swing, hip lift and
  // knee, a few Newton steps). Eased out just before the foot lifts, so the swing starts clean.
  // All of it is a function of the phase, so the loops stay seamless.
  const plantW = S.plant * S.grav;
  if (plantW > 0.001 && S.wh !== 0) {
    const T = [P.root.x, P.root.y, P.root.z], wh = Math.abs(S.wh);
    // The body at a few moments back over the longest stance; each foot's touch-down moment is
    // read between them (cheap: a handful of whole-body evaluations, not one per foot).
    const back = Math.min(0.92, Math.max(0.2, S.duty)) / wh, K = 6, samples = [];
    for (let k = 0; k < K; k++) {
      const b = bodyAt(S, phase - TAU * back * k / (K - 1), mkPlace(SEGS));
      samples.push({ J: b.J, R: b.R, Rc: b.Rc });
    }
    const lerpA = (A, B, f) => A.map((v, i) => v + (B[i] - v) * f);
    for (let j = 0; j < 2 * PAIRS; j++) {
      const L = legs[j]; if (L.cyc >= L.beta) continue;             // swinging
      const e = S.wh > 0 ? L.cyc : L.beta - L.cyc;                  // share of the cycle since touch-down
      const ramp = ss(0, 0.2 * L.beta, L.beta - e);               // 1 → 0 over the last fifth of the stance
      if (plantW * (1 - L.raised) < 0.001) continue;
      const n = 1 + (j >> 1), tE = e / wh, phd = phase - tE * TAU;  // tE: loops since touch-down
      const kf = Math.min(K - 1.000001, tE / back * (K - 1)), k0 = Math.floor(kf), fk = kf - k0, s0 = samples[k0], s1 = samples[k0 + 1];
      const hip = { p: lerpA(s0.J[n].p, s1.J[n].p, fk), R: lerpA(s0.J[n].R, s1.J[n].R, fk) };
      const Rd = lerpA(s0.R, s1.R, fk), Rcd = lerpA(s0.Rc, s1.Rc, fk), Hd = S.yaw + S.spin * phd;
      legAt(S, phd, j, CLD, true);
      const tip = chainFK(CLD, LL, hip), lt = M3.mv(Rd, tip[tip.length - 1].p);
      const Td = [S.orbit * Math.sin(Hd) - Rcd[0], P.root.y, S.orbit * Math.cos(Hd) - Rcd[2]];
      const sec = tE * LOOP_SECONDS;
      const G = [Td[0] + lt[0] + fv[0] * sec, Td[1] + lt[1], Td[2] + lt[2] + fv[1] * sec];
      // Only feet that landed on the floor are held there (folded or raised feet are left alone).
      const w = plantW * (1 - L.raised) * ramp * ss(0.07, 0.025, G[1]);
      if (w < 0.001) continue;
      // That spot in this leg's parent frame (its body segment, now).
      const gb = M3.mv(tr(R), [G[0] - T[0], G[1] - T[1], G[2] - T[2]]);
      const q = M3.mv(tr(J[n].R), [gb[0] - J[n].p[0], gb[1] - J[n].p[1], gb[2] - J[n].p[2]]);
      // Solve hip swing (tilt), hip lift (bx0) and knee for the foot to sit on q.
      const C = P.chains[LEG0 + j], sg = L.sg;
      const x0 = [C.tilt, sg * C.bx[0], -sg * C.bx[1]], x = x0.slice();
      const f = v => { C.tilt = v[0]; setKnee(C, sg, v[1], v[2]); const t = legTip(C); return [t[0] - q[0], t[1] - q[1], t[2] - q[2]]; };
      // Damped least squares, pulled toward the leg's own pose: it bends smoothly and never flips
      // to another solution between frames (a plain Newton solve did, near the edge of its reach).
      const lam = 0.004;
      for (let it = 0; it < 2; it++) {
        const r = f(x), Jc = [];
        for (let k = 0; k < 3; k++) { const xh = x.slice(); xh[k] += 1e-3; const rh = f(xh); Jc.push([(rh[0] - r[0]) / 1e-3, (rh[1] - r[1]) / 1e-3, (rh[2] - r[2]) / 1e-3]); }
        const dot = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
        const A = [0, 1, 2].map(a => [0, 1, 2].map(b => dot(Jc[a], Jc[b]) + (a === b ? lam : 0)));
        const g = [0, 1, 2].map(k => dot(Jc[k], r) + lam * (x[k] - x0[k]));
        const d = solve3(A, g);
        if (!d) break;
        for (let k = 0; k < 3; k++) x[k] -= Math.max(-0.3, Math.min(0.3, d[k]));
      }
      x[2] = Math.max(0, Math.min(2.2, x[2]));                       // a knee bends one way, and not too far
      // As the hold eases out the foot rises, so it returns to its own stride in the air, not by
      // sliding over the floor, and is back on its own path (on the floor) the instant it lifts.
      const pre = 4 * ramp * (1 - ramp) * Math.max(0.2, S.liftH) * 0.8;   // a bump: zero again at lift-off
      C.tilt = x0[0] + (x[0] - x0[0]) * w;
      setKnee(C, sg, x0[1] + (x[1] - x0[1]) * w + pre, x0[2] + (x[2] - x0[2]) * w);
    }
  }

  // ---- Tail legs: long, trailing back from the last segment ------------------------------
  for (let j = 0; j < 2; j++) {
    const C = P.chains[TAIL0 + j], sg = j ? -1 : 1;
    C.a = sg * (PI / 2 + 0.25 * (1 - S.reach)); C.rad = 0.12; C.y = -0.75 * LB[B - 1] * S.len; C.len = 1;
    C.tilt = 0.5 + 0.3 * S.reach + 0.15 * S.tailA * Math.sin(S.undH * phase + j * PI);
    for (let i = 0; i < C.bz.length; i++) {
      C.bx[i] = sg * (S.tailUp * 0.12 + S.tailA * 0.1 * Math.sin(S.undH * phase - 0.5 * i + j * PI));
      C.bz[i] = 0.03;
    }
  }

  // ---- Antennae and venom claws: on the head -------------------------------------------
  for (let j = 0; j < 2; j++) {
    const C = P.chains[ANT0 + j], sg = j ? -1 : 1, o = j * S.antAlt * PI;
    const sw = Math.sin(S.antH * phase + o);
    // From the front corners of the head shield.
    C.a = sg * (PI / 2 - S.antUp); C.rad = 0.1; C.y = -0.03; C.len = 1;
    C.tilt = PI - S.antOut - S.antA * 0.5 * sw;
    for (let i = 0; i < C.bz.length; i++) {
      C.bz[i] = -S.antCurve * 0.06 + S.antA * 0.08 * Math.sin(S.antH * phase - 0.45 * i + o);
      C.bx[i] = -sg * 0.04;
    }
    // Claws: from under the back of the head, forward past its sides; tilt past π and bz curve
    // them in until the black tips meet in front. Open swings them out; a strike snaps them shut.
    const F = P.chains[FANG0 + j], open = Math.max(0, S.fang * (1 - S.strike * strikeB) - 0.6 * S.clutch * clutchB);
    F.a = sg * (PI / 2 + 0.45); F.rad = 0.12; F.y = -0.11; F.len = 1;
    F.tilt = PI - 0.22 - 0.55 * open;
    for (let i = 0; i < F.bz.length; i++) { F.bz[i] = (0.44 - 0.16 * open) * (i ? 1 : 0.3); F.bx[i] = 0; }
  }
  return P;
}
