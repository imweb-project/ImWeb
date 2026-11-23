// The jellyfish: a lion's mane (Cyanea capillata), after the owner's three reference photos.
// Body plan, movement library, and the pose for any moment of a loop.
// Pure maths, no three.js (see core.js for the contract every creature follows).
//
//   BELL  — a round smooth dome, its rim curling under in 8 shallow scalloped lobes. It is not a separate mesh: 32 rib
//           chains (tube: false) run from the apex out to the margin, and views.js builds the bell
//           surface on them. The rib axis IS the underside (subumbrella); the jelly's thickness
//           all lies above it. A beat is the ribs bending: a quick contraction that travels from
//           apex to margin and round the rim from a pacemaker lobe, then a slow elastic relaxation
//           that rebounds a little past rest. No muscles drive the reopening: elasticity does.
//           The rim rows: it trails open while the bell squeezes, whips in as the stroke ends,
//           trails curled in while the bell reopens, and flips out last. Soft ribs (springs) and a
//           slow flutter round the lobes keep it jelly, not a hinged saucer.
//   HAIRS — hundreds of fine tentacles in 8 clusters, a horseshoe band under each lobe. They hang
//           from rib bones (on:), so they ride the margin as it rows.
//   ORAL  — four big frilled curtains from the mouth, the dominant mass (views.js builds the frills).
import { TAU } from './core.js';

export const NAME = 'Jellyfish';
// Slow and calm: a lion's mane drifts more than it swims.
export const LOOP_SECONDS = 12;

const NR = 32, RB = 8, RL = 1.2, SEG = RL / RB;     // ribs: how many, bones each, apex → margin
const LOBES = 8, PER_LOBE = NR / LOBES;             // rib 4k sits in the cleft between two lobes
// Hairs: bones, length, how many chains under each lobe. Each chain carries more strands than its
// own tube (views.js adds four, blended toward its neighbours), so there are 5× this many hairs
// for these bones: bones are the cost (three.js updates every one, every frame).
const HB = 8, HL = 6.0, PER_CLUSTER = 12;
// Oral arms: four arms from the mouth, each a bunch of curtains that move on their own (one bone
// chain per curtain: a curtain moving as one stiff sheet with its neighbours read as rigid).
const ARMS = 4, PER_ARM = 4, ORAL = ARMS * PER_ARM, OB = 9;
const Y0 = 0.3;                                      // the mouth: apex of the underside
export const BODY = { ribs: NR, apex: Y0 };

// Hair roots, seeded so they are the same every run. One cluster under each lobe: a horseshoe
// band over the lobe's middle 60%, deeper in under its middle, nearer the margin toward its edges,
// so the clefts between lobes stay bare. Each hair hangs from the rib nearest it, placed in that
// rib bone's frame: −X is the underside, +Z runs round the rim.
const HAIRS = Array.from({ length: NR }, () => []);
{
  let sd = 4242; const rnd = () => ((sd = (sd * 16807) % 2147483647) / 2147483647);
  for (let lb = 0; lb < LOBES; lb++) for (let n = 0; n < PER_CLUSTER; n++) {
    const x = (rnd() * 2 - 1) * 0.6;                                  // −1..1 across the lobe
    const phi = (lb + 0.5 + 0.5 * x) * TAU / LOBES;
    const r = Math.min(lb * PER_LOBE + PER_LOBE - 1, Math.max(lb * PER_LOBE + 1, Math.round(phi * NR / TAU)));
    const s = RL * (0.6 + 0.22 * x * x + 0.07 * rnd());
    const bone = Math.min(RB - 1, Math.floor(s / SEG));
    const px = -0.006, pz = (phi - r * TAU / NR) * s;
    const h = { bone, a: Math.atan2(pz, px), rad: Math.hypot(px, pz), y: -(s - bone * SEG),
      len: 0.5 + 0.5 * Math.pow(rnd(), 0.7), x, sc: rnd() * 2 - 1, q: Array.from({ length: 5 }, () => rnd() * TAU) };
    // Everything per joint that never changes, worked out once (pose() runs ~3000 joints a frame):
    // the hair's own lie, and sin/cos of the drift phases, so drift is sin(φ + c) = sinφ·cos c + cosφ·sin c.
    h.ca = Math.cos(h.a); h.sa = Math.sin(h.a); h.cp = Math.cos(phi); h.sp = Math.sin(phi);
    h.lie = new Float64Array(2 * HB); h.dr = new Float64Array(6 * HB);
    for (let i = 0; i < HB; i++) {
      const u = (i + 0.5) / HB, q = h.q;
      h.lie[2 * i] = Math.sin(4.4 * u + q[1]); h.lie[2 * i + 1] = Math.sin(3.8 * u + q[2]);   // one long S
      const c1 = q[3] - 0.5 * i, c2 = q[4] - 0.8 * i, c3 = q[4] - 0.4 * i;
      h.dr.set([Math.cos(c1), Math.sin(c1), Math.cos(c2), Math.sin(c2), Math.cos(c3), Math.sin(c3)], 6 * i);
    }
    HAIRS[r].push(h);
  }
}
// Per hair joint: how hard the stroke is pulling it taut, and how slack it has gone since, as felt
// that far down the hair (see pose: water has mass).
const PSH = new Float64Array(HB), SLK = new Float64Array(HB);
// Per hair / oral joint: how far that part of it trails off plumb (x, z), from where the body was
// a moment ago and the current (see pose).
const TRX = new Float64Array(HB), TRZ = new Float64Array(HB), ORX = new Float64Array(OB), ORZ = new Float64Array(OB);
// Oral curtains: arm, angle off the arm, root radius, splay, length, phases. Seeded.
const CURT = [];
{
  let sd = 9191; const rnd = () => ((sd = (sd * 16807) % 2147483647) / 2147483647);
  for (let k = 0; k < ARMS; k++) for (let c = 0; c < PER_ARM; c++)
    CURT.push({ a: Math.PI / 4 + k * TAU / ARMS + (c - 1.5) * 0.24 + (rnd() - 0.5) * 0.12, rad: 0.04 + 0.05 * rnd(),
      splay: 0.7 + 0.6 * rnd(), len: 0.72 + 0.28 * rnd(), q: Array.from({ length: 5 }, () => rnd() * TAU) });
}

export const CHAINS = [
  // Soft, lively ribs: the springs give the bell its follow-through, the rim its whip, the jelly its wobble.
  { group: 'rib', count: NR, bones: RB, length: RL, r0: 0.02, r1: 0.02, rs: 4, decay: 1, tube: false, stiff: 0.45, damp: 0.4 },
  // Hairs: bones only (tube: false). views.js draws five curled strands on each chain.
  ...HAIRS.map((h, r) => h.length && { group: 'hair', count: h.length, bones: HB, length: HL, r0: 0.0035, r1: 0.0015, rs: 3,
    decay: 0.97, stiff: 0.26, damp: 1, tube: false, on: { chain: r, bone: j => h[j].bone } }).filter(Boolean),   // heavy: water
  // Oral arms: a soft core tube each; views.js wraps a ruffled ribbon round it.
  { group: 'oral', count: ORAL, bones: OB, length: 1.5, r0: 0.035, r1: 0.01, rs: 6, decay: 0.97, stiff: 0.22, damp: 1,
    tint: 0xf6b07e, tipTint: 0xfbdcc4, alpha: 0.7 },
];

export const INT_KEYS = ['ph', 'wh', 'prot'];

export const DEFAULT = {
  pa: 0.12,     // beat strength: how far the bell closes
  ph: 2,        // beats per loop (a 6 s beat)
  tc: 0.32,     // share of a beat spent contracting; the rest is the slow elastic relaxation
  ov: 0.32,     // elastic rebound: the bell overshoots open as it relaxes
  wave: 0.7,    // the contraction travels from apex to margin (phase lag, radians)
  flex: 1,      // the rim rows: trails the bell's motion and whips round at each turn of the stroke
  jig: 0.9,     // jelly: a slow flutter round the lobes, a wobble as the stroke lets go, a slosh of the dome
  pace: 0.5,    // … and round the rim from the pacemaker lobe (a nerve net, not a brain)
  prot: 0,      // the pacemaker travels round the rim this many whole turns per loop
  open: 1,      // bell at rest: < 1 closed and domed, > 1 flattened open
  steer: 0,     // one side beats harder: the bell tilts and turns
  rise: 0.35,   // the body surges up on each beat and sinks back while relaxing
  travel: 0,    // swims up through the water, crown first, at this speed (units/s): surging on
                // each stroke, coasting between. The body stays in frame (a loop must end where
                // it began); the water moves past instead (views.js: drifting marine snow)
  current: 0.03,// a slow current through the water (units/s): the hairs and particles drift with it
  trail: 0.7,   // the hairs and oral arms trail where the body was a moment ago
  sway: 0,      // whole body rocks sideways
  len: 1,       // hair length
  drag: 0.4,    // how far the hairs swing with the rowing margin (0 = they always hang plumb)
  spread: 0.14, // hairs angle outward at the root
  billow: 0.9,  // hairs go slack and flare out after each stroke, drawn taut and gathered during it
  curl: 0,      // hairs bend: + in under the bell, − out and up
  wa: 0.18,     // wave amplitude along the hairs: slow sinuous waves running down them
  wh: 2,        // wave harmonic: ripples per loop
  k: 0.6,       // lag per bone: 0 = rigid swing, high = whip-like ripple
  rot: 0,       // wave phase round the rim
  alt: 0,       // neighbouring lobes half a cycle apart
  side: 0.5,    // sideways share of the wave (0 = flat, 1 = round, corkscrew)
  irr: 0.5,     // per-hair phase scatter (fixed per hair, so still periodic)
  twirl: 0.6,   // the hairs' curls (built into their strands, views.js) roll along them: twist per joint
  vary: 0.55,   // each hair its own fixed S-curve (0 = combed straight)
  wander: 0.7,  // slow irregular drifting of every hair (loop-safe: integer harmonics, random phases)
  oralA: 0.42,  // oral-arm sway: heavy cloth billowing, swirling, pushed back by each stroke
  oralS: 0.2,   // oral arms angle outward
  oralL: 1,     // oral-arm length
};

export const GROUPS = ['resting', 'getting around', 'feeding', 'reacting', 'display'];

// In this order they make one life: sleep, wake, travel, feed, get startled, show off, settle.
export const SEGMENTS = [
  { name: 'Sleep',    group: 'resting',        desc: 'barely beating, the hairs hang plumb',
    s: { pa: 0.025, ph: 1, rise: 0.05, wa: 0.03, k: 0.2, irr: 0.8, billow: 0.05, drag: 0.2, oralA: 0.05 } },
  { name: 'Drift',    group: 'resting',        desc: 'slow shallow beats, the hairs sway and billow',
    s: { pa: 0.07, travel: 0.04, rise: 0.15, wa: 0.08, sway: 0.4, billow: 0.25, oralA: 0.15 } },
  { name: 'Sink',     group: 'resting',        desc: 'stops rowing, bell flattens, hairs float up and out',
    s: { pa: 0.02, ph: 1, rise: -0.3, open: 1.12, spread: 0.45, curl: -0.25, billow: 0.35, wa: 0.06, k: 0.15, oralS: 0.42 } },
  { name: 'Glide',    group: 'getting around', desc: 'one hard stroke up, then a long coast',
    s: { pa: 0.2, tc: 0.25, travel: 0.22, rise: 0.25, spread: 0.02, billow: 0.1, k: 0.5, drag: 0.6 } },
  { name: 'Swim',     group: 'getting around', desc: 'steady rowing upward, the hairs stream behind',
    s: { pa: 0.2, ph: 4, tc: 0.35, travel: 0.3, rise: 0.15, wa: 0.14, wh: 4, k: 0.5, drag: 0.6 } },
  { name: 'Sprint',   group: 'getting around', desc: 'quick hard beats, everything streamlined',
    s: { pa: 0.26, ph: 6, tc: 0.4, travel: 0.55, rise: 0.15, spread: 0, open: 0.9, wh: 6, k: 0.6, billow: 0.05 } },
  { name: 'Turn',     group: 'getting around', desc: 'one side beats harder: the bell tilts and turns',
    s: { pa: 0.18, ph: 4, steer: 0.7, travel: 0.25, rise: 0.15, wa: 0.12, side: 0.8 } },
  { name: 'Hunt',     group: 'feeding',        desc: 'hairs stretch long and sweep, lobe by lobe',
    s: { pa: 0.05, len: 1.25, wa: 0.22, k: 0.15, alt: 1, side: 0.9, spread: 0.3, sway: 0.15 } },
  { name: 'Fish',     group: 'feeding',        desc: 'very long, very still: a net of hairs',
    s: { pa: 0.03, ph: 1, current: 0.07, rise: 0.05, len: 1.45, wa: 0.06, k: 0.1, spread: 0.35, billow: 0.35, irr: 0.9, oralA: 0.35 } },
  { name: 'Shiver',   group: 'reacting',       desc: 'fast small ripples run down every hair',
    s: { pa: 0.05, wa: 0.09, wh: 8, k: 0.9, side: 0.8, irr: 0.2 } },
  { name: 'Flinch',   group: 'reacting',       desc: 'quick startled beats, hairs shorten and curl under',
    s: { pa: 0.16, ph: 6, tc: 0.25, open: 0.85, len: 0.65, curl: 0.3, wa: 0.12, k: 0.3, spread: 0.2 } },
  { name: 'Recoil',   group: 'reacting',       desc: 'bell clenched, everything pulled in tight',
    s: { pa: 0.1, open: 0.72, len: 0.45, curl: 0.55, wa: 0.05, k: 0.2, spread: 0.3, oralA: 0.05, oralS: 0.05 } },
  { name: 'Spiral',   group: 'display',        desc: 'each beat runs round the rim: rotary rowing',
    s: { pa: 0.12, prot: 2, pace: 1.4, rot: 1, side: 1, wa: 0.26, k: 0.4, spread: 0.25 } },
  { name: 'Bloom',    group: 'display',        desc: 'bell opens wide, hairs fan outward',
    s: { pa: 0.08, open: 1.35, spread: 0.5, billow: 0.4, sway: 0.1, oralS: 0.42 } },
  { name: 'Fountain', group: 'display',        desc: 'hairs arc up and over in alternating waves',
    s: { pa: 0.12, open: 1.2, curl: -0.45, wa: 0.25, k: 0.35, alt: 1, spread: 0.8, oralA: 0.4 } },
];

const CUR_DIR = 0.5;                     // the current's heading in the x–z plane (radians from +x)
const PACE_AT = 0.6;                     // the pacemaker lobe, where each beat starts (rim angle)
const RIB_A = Array.from({ length: NR }, (_, r) => r * TAU / NR);
// Per rib bone, filled by the bell and read by the hairs: rest angle below horizontal, the
// contraction's extra angle, and how contracted that bone is (0..1).
const TH_REST = new Float64Array(NR * RB), TH_BEAT = new Float64Array(NR * RB), BEAT = new Float64Array(NR * RB);

// One beat, x in radians (period 2π): a quick contraction over the first tc of the cycle, then a
// slow elastic relaxation that rebounds a little past rest (ov). 0 = relaxed, 1 = contracted.
// Flat at every joint and periodic, so the seam holds for any tc and ov.
function beat(x, tc, ov) {
  let t = x / TAU; t -= Math.floor(t);
  if (t < tc) { const q = t / tc; return q * q * (3 - 2 * q); }
  const r = (t - tc) / (1 - tc), m = 1 - r;
  return m * m * m * (1 + 3 * r) - ov * 16 * r * r * m * m;
}
// Its rate of change per radian (periodic, so seamless): + while squeezing, − while reopening.
const dbeat = (x, tc, ov) => (beat(x + 0.02, tc, ov) - beat(x - 0.02, tc, ov)) / 0.04;
// The jelly's wobble as the stroke lets go: zero while contracting, two quick dying shivers after,
// flat at both ends of the relaxation (so it joins the beat smoothly).
function wobble(x, tc) {
  let t = x / TAU; t -= Math.floor(t);
  if (t < tc) return 0;
  const r = (t - tc) / (1 - tc), m = 1 - r;
  return 6 * r * m * m * m * Math.sin(4 * Math.PI * r);
}
// How many strokes have been swum by th (= ph·phase), counting each stroke's progress by its
// speed: fast while the bell pushes, slow while it coasts. Integer at every stroke boundary.
const NQ = 48, CUM = new Float64Array(NQ + 1);
function strokes(th, tc, ov) {
  CUM[0] = 0;
  let v0 = 0.2 + Math.max(0, beat(-0.5, tc, ov));
  for (let j = 1; j <= NQ; j++) {
    const v1 = 0.2 + Math.max(0, beat(j * TAU / NQ - 0.5, tc, ov));
    CUM[j] = CUM[j - 1] + (v0 + v1) / 2; v0 = v1;
  }
  const n = Math.floor(th / TAU), f = (th - n * TAU) / TAU * NQ, j = Math.min(NQ - 1, Math.floor(f));
  return n + (CUM[j] + (CUM[j + 1] - CUM[j]) * (f - j)) / CUM[NQ];
}
// After each stroke the push lets go: 0 while contracting, rising then dying away over the
// relaxation (peak 1 at 40% of it), flat at both ends.
function slack(x, tc) {
  let t = x / TAU; t -= Math.floor(t);
  if (t < tc) return 0;
  const r = (t - tc) / (1 - tc), m = 1 - r;
  return 28.935 * r * r * m * m * m;
}
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

export function pose(S, phase, P) {
  const th = S.ph * phase;
  const pacer = PACE_AT + S.prot * phase;          // whole turns per loop: still seamless
  const cb = beat(th - 0.5, S.tc, S.ov);           // the body answers the bell a little late
  P.root.x = S.sway * 0.25 * Math.sin(phase);
  P.root.y = S.rise * 0.3 * (cb - 0.35);           // surge on the stroke, sink back while relaxing
  P.root.z = 0; P.root.ry = 0;
  P.root.rz = S.sway * 0.1 * Math.sin(phase + 1) + S.steer * (0.22 + 0.1 * cb);
  // Swimming up: how far it has swum this loop, counted stroke by stroke (fast while the bell
  // pushes, slow while it coasts). Given to the view as an angle round the loop, so it is seamless;
  // the view moves the water (marine snow) past by the difference from frame to frame.
  const swum = strokes(th, S.tc, S.ov) / S.ph;
  P.parts.flow = [Math.cos(TAU * swum), Math.sin(TAU * swum), S.travel * LOOP_SECONDS];
  P.parts.clock = [Math.cos(phase), Math.sin(phase)];
  P.parts.drift = [S.current * Math.cos(CUR_DIR) * LOOP_SECONDS, S.current * Math.sin(CUR_DIR) * LOOP_SECONDS];   // per loop

  // Trailing: each joint down a hair (or oral arm) lies where the body's motion and the current
  // left it a moment ago — further down, longer ago. Its slant off plumb is the water's sideways
  // speed past the body then, over how fast the body was rising through it then (plus a little
  // sink of its own): sideways movement drapes the hairs, swimming up combs them straight.
  const mean = CUM[NQ] / NQ, wps = TAU / LOOP_SECONDS;                             // phase per second
  const slant = (dt, out, i) => {
    const ph0 = phase - dt * wps;
    const vx = S.sway * 0.25 * Math.cos(ph0) * wps;                                   // the body's own sideways speed
    const up = S.travel * (0.2 + Math.max(0, beat(S.ph * ph0 - 0.5, S.tc, S.ov))) / mean;
    const k = S.trail / (0.12 + up);
    out[0][i] = Math.max(-0.9, Math.min(0.9, k * (S.current * Math.cos(CUR_DIR) - vx)));
    out[1][i] = Math.max(-0.9, Math.min(0.9, k * S.current * Math.sin(CUR_DIR)));
  };
  for (let i = 0; i < HB; i++) slant(0.3 * (i + 0.5), [TRX, TRZ], i);
  for (let i = 0; i < OB; i++) slant(0.4 * (i + 0.5), [ORX, ORZ], i);

  // Bell. Each rib bends so its direction at u (0 apex → 1 margin) is a deep dome curling down
  // to the rim, plus the contraction, which bends the outer half most. Bone i's bend is the
  // change in direction from the previous segment's middle to this one's.
  const thM = 1.45 / Math.pow(S.open, 1.5);
  for (let r = 0; r < NR; r++) {
    const C = P.chains[r], a = RIB_A[r];
    C.a = a; C.rad = 0; C.y = Y0; C.tilt = Math.PI / 2; C.len = 1;
    const lag = S.pace * 0.5 * (1 - Math.cos(a - pacer));                       // the beat reaches this rib late
    const gain = 1 + S.steer * Math.cos(a);                                       // steering: this side harder
    const shape = thM * (1 + 0.05 * Math.sin(2 * a + 1) + 0.03 * Math.sin(3 * a + 2));   // no two lobes alike
    // Flutter: a slow undulation round the lobes, whole harmonics in time and round the rim, so
    // it is seamless in both.
    const flut = S.jig * 0.07 * (Math.sin(2 * phase + 3 * a + 1.3) + 0.6 * Math.sin(3 * phase - 5 * a + 0.4));
    // Slosh: the whole dome leans and sags a little, slowly, this way and that — soft, not rigid.
    const slosh = S.jig * 0.06 * (Math.sin(phase + a + 0.7) + 0.6 * Math.sin(2 * phase - a + 2.1));
    let prev = 0;
    for (let i = 0; i < RB; i++) {
      const u = (i + 0.5) / RB, n = r * RB + i, rim = smooth(0.5, 1, u);
      const x = th - lag - S.wave * u - 0.25 * rim;                                  // the rim moves last
      const c = beat(x, S.tc, S.ov);
      TH_REST[n] = shape * Math.pow(u, 1.3);
      // Rowing: the rim's angle trails the bell's motion (opens while it squeezes, curls in while
      // it reopens); when the stroke turns, the springs let it whip through.
      const row = -S.flex * S.pa * 2.2 * rim * dbeat(x, S.tc, S.ov);
      TH_BEAT[n] = S.pa * 3.2 * gain * c * Math.pow(u, 1.3) + row
        + rim * (S.jig * S.pa * 1.5 * wobble(x, S.tc) + flut) + slosh * u;
      BEAT[n] = c;
      const tot = TH_REST[n] + TH_BEAT[n];
      C.bz[i] = -(tot - prev); C.bx[i] = 0; prev = tot;
    }
  }

  // Hairs. Bends are worked out in the rib bone's frame — oz toward its outer face (+X: outward,
  // once the hair hangs), ox across (toward −Z) — then turned into the hair's own frame, which the
  // engine rotates by −a about Y to place the root round the bone.
  // Water has mass. What a stroke does reaches each joint of a hair later the further down it is
  // (0.45 s a joint). While the push is on, the hairs are drawn taut and gathered in; when it lets
  // go they go slack — they drift on up into the room the bell has left, flare out and buckle into
  // waves — and settle again as the next stroke draws them taut. Harder strokes, and swimming,
  // pull harder.
  // Swimming fast keeps them streaming: there is no time to go slack between quick strokes.
  const pull = Math.min(1.5, S.pa * 4 * (1 + 2 * S.travel)), loose = Math.min(1.2, S.pa * 5) / (1 + 2 * S.travel);
  for (let i = 0; i < HB; i++) {
    const x = th - S.ph * (TAU / LOOP_SECONDS) * 0.6 * (i + 0.5) - 0.5;
    PSH[i] = Math.max(0, beat(x, S.tc, S.ov)) * pull; SLK[i] = slack(x, S.tc) * loose;
  }
  const s1 = Math.sin(phase), c1 = Math.cos(phase), s2 = Math.sin(2 * phase), c2 = Math.cos(2 * phase);
  const lie = S.vary * 0.11, drift = S.wander * 0.11, ck = Math.cos(S.k), sk = Math.sin(S.k);
  const C13 = Math.cos(1.3), S13 = Math.sin(1.3);
  let k = NR;
  for (let r = 0; r < NR; r++) {
    const H = HAIRS[r]; if (!H.length) continue;
    const lobe = Math.floor(r / PER_LOBE);
    for (let j = 0; j < H.length; j++, k++) {
      const h = H[j], C = P.chains[k], n = r * RB + h.bone;
      C.a = h.a; C.rad = h.rad; C.y = h.y; C.tilt = 0;
      C.len = S.len * h.len;
      const hang = Math.PI / 2 - TH_REST[n] - (1 - S.drag) * TH_BEAT[n];   // from along the rib to plumb
      const swing = S.drag * TH_BEAT[n];                                     // how far the root rows with the rim
      const off = S.rot * RIB_A[r] + S.alt * Math.PI * (lobe % 2) + S.irr * h.q[0] + 0.9;
      // The wave w = wh·phase − k·i − off, stepped joint to joint by rotating (sin w, cos w) by −k.
      let sw = Math.sin(S.wh * phase - off), cw = Math.cos(S.wh * phase - off);
      const L = h.lie, D = h.dr;
      for (let i = 0; i < HB; i++) {
        const u = (i + 0.5) / HB, d = 6 * i;
        const A = S.wa * 0.2 * (0.3 + u) * (1 + 2.5 * SLK[i]) * (1 - 0.25 * PSH[i]);   // slack buckles, taut combs
        // This hair's own lie (a fixed S-curve) and a slow drift (harmonics 1 and 2 only), both
        // small per joint: they add up over the length. The drift grows toward the free end.
        const dw = drift * (0.4 + 1.2 * u);
        // Slack lifts the upper hair outward more than the tip, which the water holds back.
        let oz = -S.curl * 0.09 + S.billow * (0.1 * SLK[i] * (1 - 0.6 * u) - 0.05 * PSH[i]) + A * sw + lie * L[2 * i]
          + dw * (s1 * D[d] + c1 * D[d + 1] + 0.5 * (s2 * D[d + 2] + c2 * D[d + 3]));
        let ox = S.side * A * (sw * C13 + cw * S13) + lie * L[2 * i + 1] + dw * (s1 * D[d + 4] + c1 * D[d + 5])
          - (i > 2 ? 0.05 * h.x : 0);                                          // the bunch fans out below
        // Trailing, turned from the water's x/z into this hair's outward/across directions.
        const dx = TRX[i] - (i ? TRX[i - 1] : 0), dz = TRZ[i] - (i ? TRZ[i - 1] : 0);
        oz += dx * h.cp + dz * h.sp; ox -= -dx * h.sp + dz * h.cp;
        if (i === 0) { oz += -hang + S.spread * (1 + 0.3 * h.sc); ox += 0.15 * h.x; }   // gathered at the root
        // Below the root the water holds the hair: joints 1–2 bend back by what the root swung, so
        // only its top rows with the rim (the springs let the swing run a little way down). Without
        // this, a quick stroke flapped the whole long hair open like a rod.
        else if (i === 1) oz += 0.65 * swing;
        else if (i === 2) oz += 0.35 * swing;
        // Twist about the hair itself: turns its built-in curls, so they roll and travel down it.
        C.by[i] = S.twirl * (0.35 * Math.sin(S.wh * phase - 0.7 * i + h.q[2]) + 0.15 * Math.sin(phase + h.q[3] - 0.3 * i)) * (1 + 0.6 * SLK[i]);
        C.bx[i] = ox * h.ca + oz * h.sa;
        C.bz[i] = -ox * h.sa + oz * h.ca;
        const t = sw * ck - cw * sk; cw = cw * ck + sw * sk; sw = t;
      }
    }
  }

  // Oral arms: sixteen curtains in four bunches, each moving on its own. Heavy cloth in water:
  // each stroke squeezes them in and the push runs down them as a wave; between strokes they
  // billow out. On top, every curtain its own slow sway, flutter and swirl (twist about itself),
  // whole harmonics with its own phases, so the bunch never moves as one: loose, a little chaotic.
  const ow = S.oralA;
  for (let j = 0; j < ORAL; j++, k++) {
    const C = P.chains[k], c = CURT[j], q = c.q;
    C.a = c.a; C.rad = c.rad; C.y = Y0 - 0.01;
    C.tilt = S.oralS * c.splay + 0.5 * S.pa * (0.5 - cb);
    C.len = S.oralL * c.len;
    const ca = Math.cos(c.a), sa = Math.sin(c.a);
    for (let i = 0; i < OB; i++) {
      const w = S.wh * phase - S.k * 0.5 * i - q[0];
      // The same water: squeezed in while the push is on, billowing out slack after it, later the
      // further down (0.55 s a joint).
      const xo = th - S.ph * (TAU / LOOP_SECONDS) * 0.55 * (i + 0.5) - 0.6;
      const push = pull * Math.max(0, beat(xo, S.tc, S.ov)), loose = pull * slack(xo, S.tc);
      const dx = 0.6 * (ORX[i] - (i ? ORX[i - 1] : 0)), dz = 0.6 * (ORZ[i] - (i ? ORZ[i - 1] : 0));
      C.bz[i] = -S.curl * 0.03 - 0.04 * push + 0.03 * loose + dx * ca + dz * sa
        + ow * (1 + 0.5 * loose) * (0.12 * Math.sin(w) + 0.1 * Math.sin(phase + q[1] - 0.45 * i) + 0.05 * Math.sin(3 * phase + q[2] - 0.8 * i));
      C.bx[i] = -(-dx * sa + dz * ca) + ow * (0.09 * Math.sin(w + 2.1) + 0.07 * Math.sin(2 * phase + q[3] - 0.6 * i));
      C.by[i] = ow * 0.12 * Math.sin(phase + q[4] - 0.5 * i);
    }
  }
  return P;
}
