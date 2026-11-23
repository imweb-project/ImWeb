// The Western parotia (Parotia sefilata), a bird of paradise, dancing on its cleared court on the
// forest floor. Pure maths, no three.js (see core.js for the contract). The view is
// paradise-view.js; it imports SHAPE from here, never the other way round.
//
// The bird: velvet-black, blue-eyed, a white tuft over the bill, an iridescent breast shield and six
// racquet-tipped wires behind the eyes. Its flank plumes lie along its sides at rest and are raised
// into the skirt: a black disc round the body with the head and shield on top.
//
// What it adds over the earlier creatures:
//   - A BRANCHED SKELETON. Trunk → neck → head → six wires; trunk → sixteen skirt ribs, two wings,
//     tail; legs → toes. Every branch is a chain grown from another chain's bone (CHAINS `on`).
//   - FEATHERS AS SKIN. The skirt is one sheet over its ribs, the tail and wings are feather cards,
//     the racquets are cards on the wire tips (all skinned in the view's skin()). Few bones.
//   - FOLLOW-THROUGH IN THE MATHS. The joint springs act on joint angles, so a parent's motion
//     drags nothing behind it. The wires therefore lag the head explicitly: each segment takes the
//     head's turn of a moment earlier, so a head shake runs down them as a whip. The skirt's rim
//     lags the body the same way (it flares behind a sidestep, droops as the body rises).
//   - PLANTED FEET. Each foot holds a point on the floor through its stance and swings to the next.
//     Each leg is solved to reach it: the femur is held, the knee-to-foot pair is a two-link solve
//     in the leg's own plane, and the plane leans out to the foot. The toes are re-aimed every
//     frame, so they lie flat on the floor whatever the leg does.
import { TAU, M3, chainFK, chainLengths, scatter } from './core.js';

export const NAME = 'Parotia';
export const LOOP_SECONDS = 4;

// ---- Shape ------------------------------------------------------------------------------
const TR = 0.7;                    // trunk: hip joint → base of the neck
const NK = 0.28;                   // neck
const HD = 0.24;                   // head chain: back of the skull → bill tip
const LEGB = [0.12, 0.22, 0.22];   // femur (inside the body), tibiotarsus, tarsometatarsus
const LEG = LEGB[0] + LEGB[1] + LEGB[2];
const TOE = 0.11;
const NRIB = 16, RIB = 0.96;        // skirt ribs (the flank plumes), four bones each, and their length
const RIB_S = 0.68, RIB_R = 0.1;   // where they root (just under the shield): along the trunk, and out from its axis
const WIRE = 0.34;
// Shared with paradise-view.js: the view hangs feathers on these chains and needs their sizes.
export const SHAPE = { TR, NK, HD, NRIB, RIB, RIB_S, WIRE, TAIL: 0.5, WING: 0.46, TOE,
  neck: { r0: 0.12, r1: 0.095 } };
export const BODY = { length: TR };

const BLACK = 0x0d0c10, GREY = 0x55535c;
export const CHAINS = [
  // 0 trunk: the body sheet is the view's (tube: false)
  { group: 'body', count: 1, bones: 2, length: TR, r0: 0.15, r1: 0.15, rs: 8, decay: 1, tube: false, stiff: 4 },
  // 1 neck, from the top of the trunk
  { group: 'neck', count: 1, bones: 3, length: NK, r0: SHAPE.neck.r0, r1: SHAPE.neck.r1, rs: 18, rings: 14, decay: 1, stiff: 4,
    tint: BLACK, on: { chain: 0, bone: () => 2 } },
  // 2 head: one bone, the skull, bill and eyes are the view's
  { group: 'head', count: 1, bones: 1, length: HD, r0: 0.05, r1: 0.05, rs: 8, decay: 1, tube: false, stiff: 6,
    on: { chain: 1, bone: () => 3 } },
  // 3, 4 legs (right, left), from the hips
  { group: 'leg', count: 2, bones: 3, length: LEG, r0: 0.034, r1: 0.012, rs: 10, rings: 36, decay: 1, stiff: 6,
    tint: 0x2a282e, tipTint: GREY, custom: [6, 0, 0, 0] },
  // 5–8 toes of the right foot, 9–12 of the left: three forward, one back
  { group: 'toes', count: 4, bones: 2, length: TOE, r0: 0.012, r1: 0.006, rs: 6, rings: 10, decay: 1, stiff: 5,
    tint: GREY, tipTint: 0x1c1a1e, custom: [6, 0, 0, 0], on: { chain: 3, bone: () => 3 } },
  { group: 'toes', count: 4, bones: 2, length: TOE, r0: 0.012, r1: 0.006, rs: 6, rings: 10, decay: 1, stiff: 5,
    tint: GREY, tipTint: 0x1c1a1e, custom: [6, 0, 0, 0], on: { chain: 4, bone: () => 3 } },
  // 13 tail, from the hip end of the trunk (feather cards in the view)
  { group: 'tail', count: 1, bones: 3, length: SHAPE.TAIL, r0: 0.03, r1: 0.03, rs: 6, decay: 1, tube: false, stiff: 1.6,
    on: { chain: 0, bone: () => 0 } },
  // 14, 15 folded wings (right, left), from the shoulders
  { group: 'wing', count: 2, bones: 2, length: SHAPE.WING, r0: 0.03, r1: 0.03, rs: 6, decay: 1, tube: false, stiff: 3,
    on: { chain: 0, bone: () => 1 } },
  // 16–21 the six wires, three behind each eye (right first); racquets are the view's cards
  { group: 'wire', count: 6, bones: 5, length: WIRE, r0: 0.005, r1: 0.0035, rs: 5, rings: 30, decay: 1, stiff: 4,
    tint: 0x0a0a0c, custom: [7, 0, 0, 0], on: { chain: 2, bone: () => 0 } },
  // 22–37 skirt ribs round the trunk: the flank plumes; the view skins one sheet over them
  { group: 'skirt', count: NRIB, bones: 4, length: RIB, r0: 0.02, r1: 0.02, rs: 4, decay: 1, tube: false, stiff: 2.4,
    on: { chain: 0, bone: () => 1 } },
];
const NECK = 1, HEAD = 2, LEG0 = 3, TOE0 = 5, TAILC = 13, WING0 = 14, WIRE0 = 16, RIB0 = 22;

export const INT_KEYS = ['spin', 'sideH', 'surgeH', 'turnH', 'swayH', 'bobH', 'stepH', 'bowH', 'lookH', 'tiltH',
  'shakeH', 'shakePH', 'peckH', 'wireH', 'pulseH', 'trembleH', 'tailH', 'wingH'];

export const DEFAULT = {
  // display: 0 sleek, 1 the full display posture (upright, skirt raised, wires forward, head up)
  display: 0,
  pump: 0,       // the display rises and falls once a loop (the transformation)
  dance: 0,      // the whole courtship in one loop: raise, ballerina, freeze, head shake, lower
  // where the body goes (the feet step to keep up)
  height: 0.38,  // hips above the floor
  crouch: 0,
  yaw: -0.5,     // heading, held
  spin: 0,       // whole turns round the court per loop
  orbit: 0,      // radius of that circle
  go: 0,         // stop-go: the body moves while a foot swings, pauses while both stand
  side: 0,       // sidesteps left and right (the ballerina's shuffle)
  sideH: 1,
  surge: 0,      // forward and back
  surgeH: 1,
  turnA: 0,      // turns to and fro
  turnH: 1,
  snap: 0,       // 0 smooth turns and sidesteps, 1 quick ones held between (the pivot)
  sway: 0,       // rolls from side to side
  swayH: 1,
  swayPh: 0,     // where in its cycle the roll starts (π/2 with swayH = sideH: leans into each sidestep)
  bob: 0,        // dips
  bobH: 2,
  stepBob: 0,    // the body rises with each step and drops onto the landing foot
  nod: 0,        // the head nods with each step
  breathe: 0.006,
  // stepping
  stepH: 4,      // steps per foot per loop
  duty: 0.55,    // share of a step spent standing
  lift: 0,       // foot lift
  sync: 0,       // 0 the feet alternate, 1 together (hops)
  hop: 0,        // height of a hop, when the feet swing together
  // trunk, neck, head (offsets on top of the display posture)
  lean: 0,
  bow: 0,        // bows forward and down
  bowA: 0,       // bows again and again
  bowH: 1,
  headUp: 0,     // looks up (at the female on her perch)
  look: 0,       // head turned, held
  lookA: 0,      // looks about: quick turns, held between
  lookH: 1,
  cock: 0,       // head tilted, held
  counter: 0,    // the head tilts against the body's roll (counterpoint), on top of holding level
  headLat: 0,    // the head is left behind as the body sidesteps, then catches up (the neck shifts it)
  pop: 0,        // the neck lengthens with each step: the head pops up
  tiltA: 0,      // tilts from side to side, held between
  tiltH: 1,
  shake: 0,      // head shake (waggle): the wires whip
  shakeH: 28,
  shakeP: 0,     // the shake comes in bursts
  shakePH: 2,
  peck: 0,       // pecks at the floor (clearing the court)
  peckH: 2,
  stab: 0.8,     // the head holds still while the body turns and rolls under it
  // wires
  wires: 0,      // raised forward, on top of the display
  wireFan: 0.5,  // how far the three of a side spread when raised
  wireA: 0,      // slow waving
  wireH: 1,
  whip: 0.8,     // how much the wires lag the head
  // skirt
  skirt: 0,      // raised, on top of the display
  pulse: 0,      // the rim flares and settles
  pulseH: 4,
  tremble: 0,    // the plumes shiver
  trembleH: 36,
  skirtTilt: 0.1,// the disc tips forward
  bell: 0.6,     // raised skirt: 0 a flat brim, 1 a deep bell
  lag: 1,        // the rim lags the body
  // tail, wings
  tail: 0,
  tailA: 0,
  tailH: 2,
  wingA: 0,      // wing flicks
  wingH: 1,
};

export const GROUPS = ['resting', 'court', 'prelude', 'ballerina', 'head', 'climax'];

// Display after Scholes (2008) on the parotias' courtship, and film of P. sefilata: the male clears
// a court on the forest floor and dances there for the female perched above. He raises the flank
// plumes into the skirt, brings the wires forward, and sidesteps left and right in the "ballerina
// dance", bobbing; he sways, bounces, and waggles his head so the wires whip and the shield
// flashes; he freezes in the display between bouts.
export const SEGMENTS = [
  { name: 'Rest',       group: 'resting',   desc: 'standing on the court, plumes sleek, wires laid back; looks about',
    s: { lookA: 0.3, lookH: 1, tailA: 0.04, tailH: 2 } },
  { name: 'Look up',    group: 'resting',   desc: 'cocks the head to watch the female on her perch above',
    s: { headUp: 0.55, cock: 0.3, lookA: 0.2, lookH: 2, tiltA: 0.25, tiltH: 1, wingA: 0.25, wingH: 1 } },
  { name: 'Clear',      group: 'court',     desc: 'clears the court: steps about and pecks at the leaves',
    s: { peck: 1, peckH: 3, side: 0.12, sideH: 1, lift: 0.05, stepH: 4, lookA: 0.15, lookH: 1 } },
  { name: 'Hop round',  group: 'court',     desc: 'hops round the court, both feet together',
    s: { orbit: 0.45, spin: 1, yaw: -Math.PI / 2, sync: 1, hop: 0.2, stepH: 4, duty: 0.5, go: 0.9, crouch: 0.03,
         tailA: 0.08, tailH: 4 } },
  { name: 'Bow',        group: 'prelude',   desc: 'bows low to the female, again and again; plumes still down, wires swung forward, tail up',
    s: { display: 0.1, bow: 0.45, bowA: 0.45, bowH: 2, wires: 0.6, tail: 0.25, lean: 0.05 } },
  { name: 'Raise',      group: 'prelude',   desc: 'the transformation: rises into the display and sinks out of it, once a loop',
    s: { display: 1, pump: 1, pulse: 0.05, pulseH: 4 } },
  { name: 'Ballerina',  group: 'ballerina', desc: 'skirt up: skipping sidesteps (step, close) one way, a beat, then back; leaning into them, the head in counterpoint',
    s: { display: 1, side: 0.36, sideH: 2, snap: 0.3, stepH: 10, go: 0.6, sync: 0.7, hop: 0.025, lift: 0.045,
         stepBob: 0.035, nod: 0.05, pop: 0.12, sway: 0.09, swayH: 2, swayPh: Math.PI / 2, counter: 0.8, headLat: 0.6,
         wireA: 0.08, wireH: 4, bell: 0.45 } },
  { name: 'Sway',       group: 'ballerina', desc: 'skirt up: the body sways and turns under a steady head',
    s: { display: 1, sway: 0.16, swayH: 2, side: 0.05, sideH: 2, turnA: 0.22, turnH: 1, stepH: 4, lift: 0.03 } },
  { name: 'Pivot',      group: 'ballerina', desc: 'skirt up: the body snaps round to one side and back; the head stays on the female',
    s: { display: 1, turnA: 0.75, turnH: 2, snap: 0.7, stepH: 8, go: 0.6, lift: 0.04, stepBob: 0.02, stab: 0.95, bell: 0.55 } },
  { name: 'Bounce',     group: 'ballerina', desc: 'skirt up: small bounces in place, the skirt flaring',
    s: { display: 1, sync: 1, hop: 0.11, stepH: 6, duty: 0.55, pulse: 0.03, pulseH: 6 } },
  { name: 'Head shake', group: 'head',      desc: 'still body, head waggled in bursts: the wires whip, the shield flashes',
    s: { display: 1, shake: 0.32, shakeH: 28, shakeP: 1, shakePH: 2, whip: 1 } },
  { name: 'Head tilt',  group: 'head',      desc: 'tilts the head from side to side and holds; the body turns with it, flashing the shield',
    s: { display: 1, tiltA: 0.5, tiltH: 2, lookA: 0.15, lookH: 2, headUp: 0.1, wireA: 0.12, wireH: 2,
         turnA: 0.28, turnH: 2, snap: 0.5, stab: 0.4, stepH: 4, lift: 0.03 } },
  { name: 'Hold',       group: 'climax',    desc: 'the display held, frozen; the plumes shiver and the skirt breathes',
    s: { display: 1, tremble: 0.035, trembleH: 40, pulse: 0.06, pulseH: 2, breathe: 0.012, bell: 0.7 } },
  { name: 'Full dance', group: 'climax',    desc: 'one whole bout: rise, ballerina, freeze, head shake, freeze, pivot, freeze, sink',
    s: { display: 1, dance: 1, side: 0.32, sideH: 6, snap: 0.3, stepH: 12, go: 0.6, sync: 0.7, hop: 0.025, lift: 0.045,
         stepBob: 0.035, nod: 0.05, pop: 0.12, sway: 0.08, swayH: 6, swayPh: Math.PI / 2, counter: 0.8, headLat: 0.6, turnA: 0.6, turnH: 6, shake: 0.32, shakeH: 28, whip: 1, stab: 0.95,
         tremble: 0.03, trembleH: 40, bell: 0.55 } },
];

// ---- Helpers -----------------------------------------------------------------------------
const cl = (x, a, b) => Math.min(b, Math.max(a, x));
const lerp = (a, b, x) => a + (b - a) * x;
const sstep = (a, b, x) => { const t = cl((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const frac = x => x - Math.floor(x);
const sq = (x, k = 4) => Math.tanh(k * Math.sin(x)) / Math.tanh(k);   // holds, then turns quickly
const wrap = x => x - TAU * Math.round(x / TAU);                      // 2π·n → 0: whole turns meet at the seam
const soft = (x, m) => m * Math.tanh(x / m);                          // follows x, never past ±m
const mvT = (A, v) => [A[0] * v[0] + A[3] * v[1] + A[6] * v[2], A[1] * v[0] + A[4] * v[1] + A[7] * v[2], A[2] * v[0] + A[5] * v[1] + A[8] * v[2]];
const norm = v => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };

const LL = chainLengths(3, LEG, 1), LBL = LEGB.map(l => l / (LEG / 3));
const HIPY = -0.02, HW = 0.07;     // hip joints: just below the trunk's root, either side
const FX = -0.04, FW = 0.085;       // where a foot stands, from under its hip
const ANK = 0.017;                 // ankle height when standing (the toes lie on the floor)
// The femur's angle forward of straight down, held: leaning at rest the knee sits forward under the
// breast; upright in display it comes under the hip, so the knee stays inside the belly and only the
// shank shows, running down and back to the heel (a forward knee there poked out as a hook).
const PHI1 = [0.45, 0.1];
const RSC = scatter(NRIB, 4242);   // per-rib phase, so the plumes do not shiver in step
const WDT = 0.006;                 // wire lag per segment (a loop fraction: 24 ms)
const LAG = 0.025;                 // how far back the skirt rim looks at the body's path
const SWING = 3;                   // how far the rim trails the body's turn (sign: it must trail)
// The raised skirt's profile, each rib segment's angle above level (radians), between two shapes
// from the photos: a flat brim tipping down at its edge (side view), and a deep bell whose sides
// fall almost straight (front view). The brim's ribs are also shorter (Rb.len).
const BRIM = [0.05, -0.12, -0.35, -0.75];
const BELL = [0.1, -0.5, -1.15, -1.45];

// The whole bout (dance = 1), as gates over one loop t ∈ [0, 1): the display rises; the ballerina
// sidesteps; freeze; the head shake; freeze; the pivot snaps round and back; freeze; it sinks.
// The feet step only while the body travels or turns (`step`), so the freezes stand still.
const PROG = {
  disp:  t => sstep(0.01, 0.08, t) * (1 - sstep(0.92, 0.98, t)),
  move:  t => sstep(0.08, 0.12, t) * (1 - sstep(0.4, 0.44, t)),
  shake: t => sstep(0.49, 0.51, t) * (1 - sstep(0.65, 0.67, t)),
  turn:  t => sstep(0.71, 0.73, t) * (1 - sstep(0.85, 0.87, t)),
};
PROG.step = t => Math.max(PROG.move(t), PROG.turn(t));
const gate = (S, k, t) => lerp(1, PROG[k](frac(t)), S.dance);

// How far into the display posture the bird is at time t (a loop fraction).
function displayAt(S, t) {
  const pumpG = sstep(0.12, 0.88, 0.5 - 0.5 * Math.cos(TAU * t));
  return S.display * gate(S, 'disp', t) * lerp(1, pumpG, S.pump);
}

// Where the body is at time t: position on the floor, heading, the turn and roll on top.
function path(S, t) {
  const m = gate(S, 'move', t), N = S.stepH;
  // stop-go: the body moves while a foot swings and waits while the feet stand. Feet together
  // (hops): one surge a cycle, mid-flight; feet in turn: one surge per step, mid-swing of each.
  const G = (M, ph) => (Math.sin(TAU * M * t + ph) - Math.sin(ph)) / (TAU * M);
  const tau = N ? t - S.go * (S.sync * G(N, -Math.PI * S.duty) + (1 - S.sync) * G(2 * N, -Math.PI - TAU * S.duty)) : t;
  const wave = x => lerp(Math.sin(x), sq(x, 6), S.snap);   // snap: quick moves, held between
  const th = TAU * S.spin * tau, base = S.yaw - th;
  const sd = S.side * m * wave(TAU * S.sideH * tau), sg = S.surge * m * Math.sin(TAU * S.surgeH * tau);
  const c = Math.cos(base), s = Math.sin(base), turn = S.turnA * gate(S, 'turn', t) * wave(TAU * S.turnH * tau);
  return { x: S.orbit * Math.cos(th) + c * sg + s * sd, z: S.orbit * Math.sin(th) - s * sg + c * sd,
    ry: base + turn, turn, sd, rx: S.sway * m * Math.sin(TAU * S.swayH * tau + S.swayPh) };
}

// Foot k's step at time t: u the place in its cycle, n its stance, air the swing's arc (0 standing).
function stepOf(S, k, t) {
  const N = Math.max(1, S.stepH), off = k * 0.5 * (1 - S.sync);
  const c = N * t + off, n = Math.floor(c), u = c - n;
  const air = u < S.duty ? 0 : Math.sin(Math.PI * (u - S.duty) / (1 - S.duty));
  const land = u < S.duty ? Math.sin(Math.PI * u / S.duty) : 0;
  return { N, off, n, u, air, land };
}
function footAt(S, k, t) {
  const st = stepOf(S, k, t), side = k ? -1 : 1;
  // a stance's hold: where the foot would stand under the body at the middle of that stance
  const hold = m => {
    const p = path(S, (m + S.duty / 2 - st.off) / st.N), c = Math.cos(p.ry), s = Math.sin(p.ry);
    return [p.x + c * FX + s * side * FW, p.z - s * FX + c * side * FW];
  };
  if (st.u < S.duty) { const h = hold(st.n); return { p: [h[0], ANK, h[1]], air: 0 }; }
  const w = (st.u - S.duty) / (1 - S.duty), e = w * w * (3 - 2 * w), A = hold(st.n), B = hold(st.n + 1);
  return { p: [A[0] + (B[0] - A[0]) * e, ANK + (S.lift * gate(S, 'step', t) + 0.85 * S.hop) * st.air, A[1] + (B[1] - A[1]) * e], air: st.air };
}
const peckAt = (S, t) => S.peck * Math.pow(Math.max(0, Math.sin(TAU * S.peckH * t)), 4);
function yAt(S, t) {
  const st = stepOf(S, 0, t), d = displayAt(S, t), st1 = stepOf(S, 1, t);
  return S.height + 0.16 * d - S.crouch - 0.12 * peckAt(S, t)   // display: stands tall; a peck crouches
    - S.bob * gate(S, 'move', t) * (0.5 - 0.5 * Math.cos(TAU * S.bobH * t))
    + S.hop * (st.air - 0.3 * st.land) + S.breathe * Math.sin(TAU * t)
    + S.stepBob * gate(S, 'step', t) * (st.air + (1 - S.sync) * st1.air - 0.3 * (st.land + (1 - S.sync) * st1.land));
}

// The head's own turn (yaw, about the neck) and tilt (roll, about the bill), over the posture.
function headDyn(S, t) {
  const p = path(S, t);
  const shA = S.shake * gate(S, 'shake', t) * (1 - S.shakeP + S.shakeP * sstep(0.1, 0.8, Math.sin(TAU * S.shakePH * t)));
  const yaw = S.look + S.lookA * (0.65 * sq(TAU * S.lookH * t + 0.4) + 0.35 * sq(TAU * 2 * S.lookH * t + 1.9))
    + 0.7 * shA * Math.sin(TAU * S.shakeH * t) - S.stab * p.turn;
  const roll = S.cock + S.tiltA * sq(TAU * S.tiltH * t + 0.8, 2.5) + shA * Math.sin(TAU * S.shakeH * t + 1.1) - (S.stab + S.counter) * p.rx;
  return { yaw, roll };
}

// ---- Pose --------------------------------------------------------------------------------
export function pose(S, phase, P) {
  const t = phase / TAU, C = P.chains;
  const disp = displayAt(S, t);

  // Root: the body's place, heading and roll; the legs are solved in this frame.
  const pth = path(S, t);
  const root = P.root;
  root.x = pth.x; root.y = yAt(S, t); root.z = pth.z; root.ry = wrap(pth.ry); root.rz = 0; root.rx = pth.rx;
  const R = M3.mul(M3.mul(M3.ry(root.ry), M3.rz(0)), M3.rx(root.rx));

  // ---- trunk, neck, head: the head stays level whatever the body does -----------------
  const bow = S.bow + S.bowA * (0.5 - 0.5 * Math.cos(TAU * S.bowH * t));
  const peck = peckAt(S, t);
  const lean = lerp(0.7, 0.1, disp) + S.lean + 0.55 * bow + 0.45 * peck;
  const T = C[0];
  T.a = 0; T.rad = 0; T.y = 0; T.tilt = Math.PI - lean;      // the trunk rises from the hips, leaning forward
  T.bz[0] = 0; T.bz[1] = -(0.35 * bow + 0.2 * peck);         // −: the upper trunk bends forward
  const s0 = stepOf(S, 0, t), s1 = stepOf(S, 1, t), stepG = gate(S, 'step', t);
  const air = stepG * (s0.air + (1 - S.sync) * s1.air);                    // a foot is swinging
  const Nk = C[NECK], nb = lerp(0.24, 0.03, disp) - 0.25 * bow - 0.75 * peck;   // +: bends back, upright
  Nk.a = 0; Nk.rad = 0; Nk.y = 0; Nk.tilt = 0; Nk.len = lerp(0.9, 0.6, disp) + 0.4 * peck + S.pop * air;   // display: the head sits down on the shield
  for (let i = 0; i < 3; i++) Nk.bz[i] = nb;
  // headLat: an S-bend (out at the base, back at the top) shifts the head sideways, still upright.
  // It answers the sidestep's recent travel, so the head is left behind as the body sets off and
  // catches up as it stops. (+bx at the base shifts the head toward the body's left, −z.)
  const lat = soft(S.headLat * (pth.sd - path(S, t - 0.05).sd) / 0.15, 0.6);
  Nk.bx[0] = lat; Nk.bx[1] = 0; Nk.bx[2] = -lat;
  // angle of the neck's tip from straight up (forward +): the head pitches against it
  const neckAng = lean - T.bz[1] - 3 * nb;
  const nod = S.nod * stepG * (s0.land + (1 - S.sync) * s1.land - 0.6);   // dips onto each landing
  const pitchUp = lerp(0, 0.42, disp) + S.headUp - 0.9 * bow - 1.1 * peck - nod;
  const dyn = [];
  for (let i = 0; i <= 5; i++) dyn.push(headDyn(S, t - i * WDT));   // now, and a little earlier, for the wires
  const H = C[HEAD];
  H.a = dyn[0].yaw; H.rad = 0; H.y = 0; H.tilt = -Math.PI / 2 + neckAng + pitchUp;   // + raises the bill
  H.by[0] = dyn[0].roll; H.bz[0] = 0; H.bx[0] = 0;

  // ---- wires: from back along the head (rest) to raised, forward and fanned (display) ------
  // Head frame: −y the bill, +x the crown, +z the bird's right.
  const wr = sstep(0, 1, cl(disp + S.wires, 0, 1));
  for (let w = 0; w < 6; w++) {
    const side = w < 3 ? 1 : -1, m = w % 3, W = C[WIRE0 + w];
    const rest = norm([0.12 - 0.2 * m, 1, side * 0.25]);
    const up = norm([1, -0.3 + 0.1 * m, side * (0.55 + S.wireFan * 0.6 * m)]);   // up and out, a fan each side
    const wave = S.wireA * Math.sin(TAU * S.wireH * t + 1.3 * m + (side > 0 ? 0 : 0.7));
    const d = norm([lerp(rest[0], up[0], wr) + wave, lerp(rest[1], up[1], wr), lerp(rest[2], up[2], wr)]);
    W.a = Math.atan2(d[2], d[0]); W.tilt = Math.atan2(Math.hypot(d[0], d[2]), -d[1]); W.rad = 0.072; W.y = -0.07;
    // the head's turn and tilt axes, in this wire's own frame (small-angle bends about them)
    const Wm = M3.mul(M3.ry(-W.a), M3.rz(W.tilt)), uy = mvT(Wm, [1, 0, 0]), ur = mvT(Wm, [0, 1, 0]);
    for (let i = 0; i < 5; i++) {
      const g = S.whip * (1 + 0.3 * i);
      const ey = g * (dyn[i + 1].yaw - dyn[i].yaw), er = g * (dyn[i + 1].roll - dyn[i].roll);
      W.bx[i] = ey * uy[0] + er * ur[0];
      W.by[i] = ey * uy[1] + er * ur[1];
      W.bz[i] = ey * uy[2] + er * ur[2] + (i ? 0.045 : 0);       // a gentle curve along the wire
    }
  }

  // ---- skirt: folded down the flanks, or raised into the disc; the rim lags the body -------
  const sk = cl(disp + S.skirt, 0, 1);
  const p0 = [pth.x, root.y, pth.z], q = path(S, t - LAG), p1 = [q.x, yAt(S, t - LAG), q.z];
  const cr = Math.cos(root.ry), sr = Math.sin(root.ry), dx = p0[0] - p1[0], dz = p0[2] - p1[2];
  const lag = [cr * dx - sr * dz, p0[1] - p1[1], sr * dx + cr * dz];   // the body's recent move, in its own frame
  const lg = S.lag * (0.3 + 0.7 * sk);
  const spin = wrap(pth.ry - q.ry);                                    // the body's recent turn
  const pulse = S.pulse * sk * Math.sin(TAU * S.pulseH * t);
  const bell = cl(S.bell + 2 * pulse, 0, 1);      // a pulse also deepens and flattens the skirt
  for (let r = 0; r < NRIB; r++) {
    const Rb = C[RIB0 + r], a = TAU * r / NRIB, front = -Math.cos(a), lat = Math.sin(a);
    // the rim folds down on the side the body moves toward, flares on the side it leaves; it
    // droops as the body rises, lifts as it drops
    const droop = soft(lg * (3 * lag[1] + 1.8 * (front * lag[0] + lat * lag[2])), 0.45) + pulse;   // plumes held erect: they give, then stiffen
    const tr = S.tremble * sk * Math.sin(TAU * S.trembleH * t + RSC[r]);
    Rb.a = a; Rb.rad = RIB_R; Rb.y = -(RIB_S - TR / 2);
    // Folded, the plume's four segments lie out over the breast and flank and curl in under the
    // rump (a cocoon). Raised, each segment's angle below level is the brim's or the bell's,
    // mixed by `bell`; bz is the bend between neighbours (+ bends down).
    const A = BRIM.map((b, i) => lerp(b, BELL[i], bell));
    Rb.tilt = lerp(Math.PI - 0.45, Math.PI / 2 - A[0], sk) + S.skirtTilt * front * sk;
    Rb.len = lerp(1, lerp(0.75, 1, bell), sk);
    Rb.bz[0] = 0;
    Rb.bz[1] = lerp(0.33, A[0] - A[1], sk) + 0.3 * droop;
    Rb.bz[2] = lerp(0.27, A[1] - A[2], sk) + 0.5 * droop;
    Rb.bz[3] = lerp(0.35, A[2] - A[3], sk) + 0.4 * droop + tr;
    const sw = soft(SWING * lg * spin, 0.5);                            // the rim trails a turn, so far
    Rb.bx[1] = 0.3 * sw; Rb.bx[2] = 0.5 * sw + 0.6 * tr; Rb.bx[3] = 0.5 * sw + 0.03 * Math.sin(RSC[r] * 3);
  }

  // ---- tail and wings --------------------------------------------------------------------
  const Tl = C[TAILC];
  Tl.a = 0; Tl.rad = 0.09; Tl.y = 0.03;   // from the rump, behind the legs
  Tl.tilt = Math.PI - (lerp(0.35, 0.8, disp) + S.tail + S.tailA * Math.sin(TAU * S.tailH * t));   // +: back, off the floor
  Tl.bz[0] = 0; Tl.bz[1] = 0.06; Tl.bz[2] = 0.06;
  const flick = S.wingA * Math.pow(Math.max(0, Math.sin(TAU * S.wingH * t)), 6);
  for (let k = 0; k < 2; k++) {
    const Wg = C[WING0 + k];
    Wg.a = k ? -Math.PI / 2 : Math.PI / 2; Wg.rad = 0.125; Wg.y = -0.28;
    Wg.tilt = Math.PI - 0.14 - 0.6 * flick; Wg.bz[0] = 0; Wg.bz[1] = 0.08; Wg.by[0] = 0.3 * flick;
  }

  // ---- legs: planted feet, solved; toes laid flat on the floor -----------------------------
  const L1 = LEGB[0], L2 = LEGB[1], L3 = LEGB[2];
  for (let k = 0; k < 2; k++) {
    const side = k ? -1 : 1, Lg = C[LEG0 + k], F = footAt(S, k, t);
    const f = mvT(R, [F.p[0] - root.x, F.p[1] - root.y, F.p[2] - root.z]);   // foot in the body frame
    const v = [f[0], f[1] - HIPY, f[2] - side * HW];                           // … from the hip
    const gam = Math.atan2(v[2], -v[1]), down = Math.hypot(v[1], v[2]);       // the leg's plane leans out to it
    const phi1 = lerp(PHI1[0], PHI1[1], disp);
    const Kx = L1 * Math.sin(phi1), Ky = -L1 * Math.cos(phi1);                 // knee (forward, up)
    const ex = v[0] - Kx, ey = -down - Ky, dd = Math.hypot(ex, ey);
    const dc = cl(dd, Math.abs(L2 - L3) + 1e-4, L2 + L3 - 1e-4);
    const beta = Math.atan2(ex, -ey);
    const psi = Math.acos(cl((L2 * L2 + dc * dc - L3 * L3) / (2 * L2 * dc), -1, 1));
    const a2 = beta - psi;                                                     // the heel joint points back
    const Jx = Kx + L2 * Math.sin(a2), Jy = Ky - L2 * Math.cos(a2);
    const a3 = Math.atan2(v[0] - Jx, -(-down - Jy));
    Lg.a = side * Math.PI / 2; Lg.rad = HW; Lg.y = HIPY; Lg.tilt = side * gam; Lg.by[0] = Lg.a;
    Lg.bz[0] = phi1; Lg.bz[1] = a2 - phi1; Lg.bz[2] = a3 - a2;
    Lg.bl.set(LBL);
    // toes: aimed along the floor, in the tarsus's own frame
    const tip = chainFK(Lg, LL)[3], curl = 0.9 * F.air * cl((S.lift + S.hop) / 0.04, 0, 1);   // curl only when it leaves the floor
    const TOEYAW = [side * 0.45, 0, -side * 0.42, Math.PI];
    for (let m = 0; m < 4; m++) {
      const To = C[TOE0 + 4 * k + m], psiT = root.ry + TOEYAW[m], dip = 0.05;
      const Dw = [Math.cos(psiT) * Math.cos(dip), -Math.sin(dip), -Math.sin(psiT) * Math.cos(dip)];
      const d = mvT(tip.R, mvT(R, Dw));
      To.a = Math.atan2(d[2], d[0]); To.tilt = Math.atan2(Math.hypot(d[0], d[2]), -d[1]); To.rad = 0; To.y = 0;
      To.len = m === 3 ? 0.75 : m === 1 ? 1.1 : 1;
      To.bz[0] = -0.4 * curl; To.bz[1] = -0.2 - curl;
    }
  }

  P.parts.floor = 1;
  P.parts.uniforms = { uFlash: 1 + 0.3 * disp };
  return P;
}
