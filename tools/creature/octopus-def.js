// The octopus: eight arms that can be addressed one at a time, a breathing mantle.
// Pure maths, no three.js (see core.js for the contract every creature follows).
//
// What it adds over the jellyfish:
//   - FOCUS: a soft mask over the arm ring (centre fArm, width fw). Focused arms reach, lift and
//     wave on their own; the rest can wrap up (wrap). One arm reaching, two arms walking and a
//     searching arm that travels round the ring (fRot whole turns per loop) are all this mask.
//   - TIP COIL: curl weighted toward the arm tips (t³), held (tip) or breathing (tipW).
//   - SPIN: the whole body turns spin whole turns per loop (integer, so still seamless).
//
// The arm as a muscular hydrostat (core.js per-bone twist `by` and segment length `bl`; the page
// thins a stretched segment so its volume stays the same):
//   - TWIST (tw, twW, fTw): bones turn about the arm's own axis. Twist turns the plane of every
//     bend after it, so a bent arm becomes a corkscrew and the sucker rows spiral round it.
//   - LENGTH (lw, lTip, pull): segments shorten and lengthen locally — a wave running out along
//     the arm, a reaching tip that stretches while the base bunches up, a stride that reaches long
//     and hauls short.
//   - BEND PROPAGATION (unroll): the reaching arm unrolls from a coil; the bend between the
//     straight base and the rolled tip runs out from root to tip (Gutfreund et al.).
//   - FETCHING (fetch): the arm grips, then folds at an elbow and a wrist into three near-rigid
//     pieces and brings the food to the mouth (Sumbre et al.). Angles fitted with core.js chainFK.
//   - EACH ARM ITS OWN (indep, ih): eight arms, eight programs: ROLE gives each arm its own mix of
//     reaching, twisting, probing, groping and resting, OWN its own timing, HARM its own rate.
import { TAU, scatter } from './core.js';

export const NAME = 'Octopus';
export const LOOP_SECONDS = 6;          // heavier, slower than the jellyfish

const ARMS = 8;
export const BODY = { ring: 0.24 };
export const CHAINS = [
  { group: 'arm', count: ARMS, bones: 18, length: 2.6, r0: 0.17, r1: 0.008, rs: 14 },
];

export const INT_KEYS = ['ph', 'wh', 'spin', 'fRot', 'uh', 'ih'];

export const DEFAULT = {
  pa: 0.05,     // mantle pulse (breathing / jetting)
  ph: 1,        // pulse harmonic
  mt: 1.0,      // mantle leans back behind the head (0 = upright)
  bob: 0,       // body bobs on each pulse
  sway: 0,      // body rocks sideways
  height: 0,    // body raised (+) or lowered
  spin: 0,      // whole turns per loop
  yaw: 0,       // heading: which way the body faces (radians), held, not turning
  spread: 1.1,  // arm angle at the root: 0 = straight down, π/2 = flat out
  lift: 0,      // arms rise and fall at the root (stepping)
  len: 1,       // arm length
  curl: 0,      // whole-arm bend: + inward/under
  tip: 0.2,     // held tip coil: + up and over, − down and under
  tipW: 0.15,   // breathing tip coil
  wa: 0.12,     // wave along the arms
  wh: 1,        // wave harmonic
  k: 0.3,       // lag per bone
  rot: 0,       // phase round the ring (1 = one wave travelling round)
  alt: 0,       // neighbouring arms half a cycle apart
  side: 0.6,    // sideways share of the wave
  irr: 0.4,     // per-arm phase scatter
  focus: 0,     // how strongly the focus mask applies (0 = all arms alike)
  fArm: 0,      // focus centre, in arms (0..8; fractional sits between two arms)
  fw: 0.5,      // focus width, in arms
  fRot: 0,      // focus travels this many whole turns round the ring per loop
  fLen: 0,      // focused arms lengthen
  fTilt: 0,     // focused arms rise
  fWave: 0,     // focused arms wave harder
  wrap: 0,      // unfocused arms wrap up
  fStill: 0,    // unfocused arms hold still (0 = they keep moving, 1 = frozen)
  uTilt: 0,     // unfocused arms gather in (−) or splay (+) at the root
  vary: 0.7,    // each arm its own fixed S-curve, tip direction and length (0 = eight identical arms)
  wander: 0.35, // slow irregular drifting of every arm (loop-safe: integer harmonics, random phases)
  blink: 1,     // blinks per loop (0 or 1)
  swirl: 0,     // every arm bends the same way sideways: curled arms make a pinwheel instead of
                // meeting head-on in the middle (the cheap answer to arms passing through each other)
  // The arm as a muscular hydrostat: twist about its own axis, segments that shorten and lengthen.
  tw: 0,        // held twist per bone (rad): with a bend, a corkscrew; the sucker rows spiral round the arm
  twAlt: 0,     // neighbouring arms twist opposite ways (0 = all one handedness, 1 = alternate)
  twW: 0,       // twist wave running out along every arm (rad per bone)
  fTw: 0,       // focused arms: an extra twist wave (a feeling tip that screws about)
  lw: 0,        // length wave: segments shorten and lengthen in a wave running out along the arm
  lk: 0.5,      // lag per bone of the length wave
  lTip: 0,      // base shortens while the tip stretches (reaching arms; follows the reach when unroll > 0)
  pull: 0,      // stepping arms reach long and haul short
  unroll: 0,    // bend propagation: reaching arms unroll from a coil, the bend running out to the tip
  uDir: -1,     // which way the unrolling arm is rolled: −1 under, suckers in (reaching); +1 up, suckers out (walking: the suckers roll onto the ground)
  uh: 1,        // reaches (unroll, fetch) per loop
  fetch: 0,     // fetching: grip, fold at an elbow and a wrist, bring the tip to the mouth, let go
  indep: 0,     // each arm its own program, timing and (with ih) rate (0 = all arms alike)
  ih: 0,        // with indep: each arm also waves at its own whole-number rate (0 or 1)
};

export const GROUPS = ['resting', 'getting around', 'feeding', 'reacting', 'display', 'many minds'];

// Arms are numbered round the ring; 1–2 point forward (toward the eyes), 5–6 point back.
export const SEGMENTS = [
  { name: 'Den',       group: 'resting',        desc: 'tucked in, arms curled under in a pinwheel, barely breathing',
    s: { pa: 0.03, spread: 0.95, curl: 0.3, swirl: 0.35, tip: -0.55, tipW: 0.05, wa: 0.03, len: 0.9, mt: 1.15 } },
  { name: 'Breathe',   group: 'resting',        desc: 'mantle swells and empties, tips curl and uncurl',
    s: { pa: 0.09, tipW: 0.6, wa: 0.05, spread: 1.2, irr: 0.7 } },
  { name: 'Bask',      group: 'resting',        desc: 'arms laid flat and loose, irregular little stirrings',
    s: { pa: 0.04, spread: 1.5, tip: 0.1, tipW: 0.25, wa: 0.06, k: 0.6, irr: 1, mt: 1.35 } },
  { name: 'Crawl',     group: 'getting around', desc: 'neighbouring arms step in turn, body rocks along',
    s: { pa: 0.04, spread: 1.2, lift: 0.3, alt: 1, wa: 0.14, k: 0.2, bob: 0.25, sway: 0.25, wh: 1 } },
  // Arms 5–6 point back; yaw −π/2 turns the body so they are seen side-on, eyes toward the camera.
  { name: 'Tiptoe',    group: 'getting around', desc: 'walks on two back arms, each rolling out along the ground from base to tip; the other six rolled up and twisted',
    s: { focus: 1, fArm: 5.5, fw: 0.42, wrap: 1.1, swirl: 0.3, uTilt: -0.35, fStill: 0.9,
         lift: 0.6, alt: 1, wh: 2, uh: 2, k: 0.15, fLen: 0.3, fTilt: 0.05, tip: 0.5,
         unroll: 0.8, uDir: 1, pull: 0.15, tw: 0.12,
         spread: 0.9, height: 0.45, bob: 0.3, sway: 0.25, mt: 0.6, yaw: -Math.PI / 2 } },
  { name: 'Haul',      group: 'getting around', desc: 'arm over arm: each arm in turn unrolls forward, plants, then shortens and hauls',
    s: { rot: 1, wh: 1, uh: 1, lift: 0.35, pull: 0.35, unroll: 0.5, spread: 1.15, k: 0.25,
         wa: 0.08, tip: -0.1, tipW: 0.1, bob: 0.2, sway: 0.15 } },
  { name: 'Jet',       group: 'getting around', desc: 'mantle squeezes hard, arms stream out behind',
    s: { pa: 0.3, spread: 0.12, curl: -0.05, wa: 0.22, k: 0.7, bob: 1, tip: 0, tipW: 0.05, mt: 0.4 } },
  { name: 'Swim',      group: 'getting around', desc: 'arms open and close like an umbrella',
    s: { pa: 0.14, spread: 0.7, lift: 0.45, wa: 0.25, k: 0.5, bob: 0.6, tip: -0.2 } },
  { name: 'Reach',     group: 'feeding',        desc: 'one front arm unrolls toward a target, a bend running out from base to tip; the tip stretches and feels, then it rolls back',
    s: { focus: 1, fArm: 1, fw: 0.4, fLen: 0.6, fTilt: 0.85, fWave: 0.15, fStill: 0.9, uTilt: -0.35, wrap: 0.15,
         swirl: 0.15, wa: 0.05, k: 0.45, tipW: 0.3, spread: 1.05,
         unroll: 1, lTip: 0.35, fTw: 0.08, lw: 0.1 } },
  { name: 'Fetch',     group: 'feeding',        desc: 'a front arm holds out, grips, folds at an elbow and a wrist and brings the food to the mouth',
    s: { focus: 1, fArm: 1, fw: 0.4, fetch: 1, fTilt: 0.6, fStill: 0.85, uTilt: -0.25, wrap: 0.1,
         swirl: 0.15, wa: 0.04, k: 0.45, tipW: 0.2, spread: 1.05 } },
  { name: 'Grope',     group: 'feeding',        desc: 'every tip probes and coils on its own, stretching and twisting as it feels',
    s: { tipW: 1, tip: 0.1, wa: 0.12, k: 0.6, irr: 1.4, rot: 0.5, spread: 1.25, wh: 2,
         lw: 0.18, lk: 0.6, twW: 0.1, indep: 0.3 } },
  { name: 'Probe',     group: 'feeding',        desc: 'arms explore by shortening and lengthening: bulges and necks run out along them',
    s: { lw: 0.45, lk: 0.5, wa: 0.08, k: 0.4, irr: 1, rot: 0.5, spread: 1.2, tipW: 0.4, tip: 0.15, twW: 0.05 } },
  { name: 'Search',    group: 'feeding',        desc: 'a reaching arm travels round the ring, its tip stretching out and screwing about',
    s: { focus: 0.9, fRot: 1, fw: 0.7, fLen: 0.45, fTilt: 0.6, fWave: 0.2, spread: 1.15, tipW: 0.3,
         lTip: 0.4, fTw: 0.15, lw: 0.08 } },
  { name: 'Startle',   group: 'reacting',       desc: 'triple gasp, arms snap in',
    s: { pa: 0.22, ph: 3, curl: 0.3, spread: 0.5, wa: 0.18, k: 0.2, bob: 0.3, tip: -0.3 } },
  { name: 'Ball',      group: 'reacting',       desc: 'rolled into a tight ball of arms, twisted and coiled round each other, suckers out',
    s: { pa: 0.05, curl: -0.75, swirl: 0.5, tip: 0.4, spread: 1.35, len: 0.85, wa: 0.02, tipW: 0, mt: 1.1, tw: 0.2 } },
  { name: 'Flare',     group: 'reacting',       desc: 'arms thrown out wide, tips curled back',
    s: { pa: 0.1, ph: 2, spread: 1.7, tip: 0.9, wa: 0.25, k: 0.3, mt: 0.6 } },
  { name: 'Spiral',    group: 'display',        desc: 'a wave travels round the ring; each arm twists about its length as it passes',
    s: { rot: 1, wa: 0.35, side: 1, k: 0.3, spread: 1.2, tip: 0.3, twW: 0.12, tw: 0.05 } },
  { name: 'Flower',    group: 'display',        desc: 'arms open like petals, tips rolled up',
    s: { pa: 0.06, spread: 1.45, tip: 1, tipW: 0.3, wa: 0.05, mt: 1.3 } },
  { name: 'Waltz',     group: 'display',        desc: 'turns once a loop, arms rise in pairs',
    s: { spin: 1, alt: 1, lift: 0.3, wa: 0.25, wh: 2, spread: 1.0, sway: 0.2 } },
  { name: 'Corkscrew', group: 'display',        desc: 'arms wind into helices, neighbours opposite ways, and unwind; the sucker rows spiral round them',
    // A visible corkscrew needs bend AND twist per bone near 0.6 : 0.3 (about two turns of a spring
    // whose pitch is ~3× its radius); twW with almost no lag winds and unwinds the whole arm at once.
    s: { curl: 2.2, tw: 0.28, twAlt: 1, twW: 0.2, k: 0.05, spread: 1.7, len: 1.15, wa: 0.05, tip: 0.25, tipW: 0.15, irr: 0.6 } },
  { name: 'Minds',     group: 'many minds',     desc: 'each arm its own program: one probes, one unrolls, one gropes, one corkscrews, one rests',
    s: { indep: 1, ih: 1, unroll: 1, uh: 1, tw: 0.25, twW: 0.18, lw: 0.42, tipW: 0.7, tip: 0.2,
         spread: 1.2, wa: 0.08, k: 0.4, irr: 0.6 } },
];

const SCATTER = scatter(ARMS, 777);
// Per-arm character, fixed for this individual: six random phases per arm.
const SHAPE = Array.from({ length: ARMS }, (_, j) => scatter(6, 1000 + 97 * j));

// Each arm its own (indep): every arm's share of [reach (unroll), twist, length probe, tip grope,
// rest], its own timing (OWN, any phase) and its own extra wave rate and reach rate (whole numbers).
const ROLE = [
  [0, 0, 1, 0.5, 0],      // 0 probes: stretches and bunches up
  [1, 0.3, 0, 0, 0],      // 1 reaches out, unrolling, twice a loop
  [0, 0, 0.3, 1, 0],      // 2 gropes with its tip
  [0, 1, 0, 0.6, 0],      // 3 corkscrews its tip
  [0, 0, 0, 0, 1],        // 4 rests
  [0, 0, 1, 1, 0],        // 5 probes and gropes
  [0, 1, 0.5, 0.6, 0],    // 6 twists and stretches
  [1, 0, 0, 0.5, 0.3],    // 7 reaches, slowly
];
const OWN = scatter(ARMS, 4242);
const HARM = [1, 0, 2, 0, 0, 1, 1, 0];
const UHARM = [0, 1, 0, 0, 0, 0, 0, 0];

const sstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
// Fetching: the arm's bends, per bone, when folded (elbow round bone 5, wrist round bone 12) and
// when gripping (the hand hooks round the food). Fitted with core.js chainFK: at tilt FETCH_TILT
// the wrist lands under the mouth and the hand points up into it.
const FETCH_TILT = 0.9;
const FOLD = (() => {
  const B = CHAINS[0].bones, bump = (i, c) => Math.exp(-((i - c) ** 2) / 1.28);
  let n5 = 0, n12 = 0; for (let i = 0; i < B; i++) { n5 += bump(i, 5); n12 += bump(i, 12); }
  return Array.from({ length: B }, (_, i) => -3.05 * bump(i, 5) / n5 + 0.7 * bump(i, 12) / n12);
})();
const GRIP = Array.from({ length: CHAINS[0].bones }, (_, i) => 0.42 * sstep(0.6, 0.95, (i + 1) / CHAINS[0].bones));

export function pose(S, phase, P) {
  const th = S.ph * phase;
  const p = Math.sin(th + 0.3 * Math.sin(th));
  P.parts.mantle = { sx: 1 - S.pa * p, sy: 1 + 0.9 * S.pa * p, pitch: S.mt + 0.15 * S.pa * p };
  // One quick blink late in the loop: a narrow periodic bump, so it is seamless too.
  P.parts.blink = Math.min(1, S.blink * Math.pow((1 + Math.cos(phase - 4.4)) / 2, 60) * 1.6);
  P.root.y = S.height + S.bob * 0.2 * Math.sin(th - 0.5);
  P.root.x = S.sway * 0.25 * Math.sin(phase);
  P.root.rz = S.sway * 0.1 * Math.sin(phase + 1);
  P.root.ry = (S.spin * phase + S.yaw) % TAU;   // whole turns: 2π is 0, so the seam check compares like with like

  const fc = S.fArm + S.fRot * ARMS * phase / TAU;
  for (let j = 0; j < ARMS; j++) {
    const a = j * TAU / ARMS + TAU / 16, C = P.chains[j], B = C.bz.length;
    let d = (((j - fc) % ARMS) + ARMS) % ARMS; d = Math.min(d, ARMS - d);
    const m = S.focus * Math.exp(-(d * d) / (2 * S.fw * S.fw));
    const uf = S.focus - m;                       // how "unfocused" this arm is (0..1)
    const wrapJ = S.wrap * (1 - m);
    const R = ROLE[j], rl = b => 1 - S.indep + S.indep * R[b];   // this arm's share of a behaviour
    const still = (1 - S.fStill * uf) * (1 - 0.85 * S.indep * R[4]);   // unfocused (or resting) arms quieten
    const off = S.rot * a + S.alt * Math.PI * (j % 2) + S.irr * 0.5 * Math.sin(SCATTER[j]) + S.indep * OWN[j];
    const hj = S.wh + S.ih * HARM[j], uhj = S.uh + S.ih * UHARM[j];   // whole numbers: seamless
    const step = Math.sin(hj * phase - off);
    // Reaching arms: every arm when nothing is focused, else the focused one(s).
    const sel = 1 - S.focus + m;
    // The reach: 0 rolled up → 1 stretched out → back, lingering out at full stretch.
    const ut = uhj * phase - off;
    const reach = sstep(0.06, 0.9, 0.5 - 0.5 * Math.cos(ut + 0.45 * Math.sin(ut)));
    const U = S.unroll * sel * rl(0);
    const bend = 1.12 * reach - 0.06;             // where the straight base meets the rolled tip (0..1)
    // Fetching, once per reach: hold out → grip → fold to the mouth → hold there → let go and open.
    const fx = (((ut / TAU) % 1) + 1) % 1;
    const Fw = S.fetch * sel, F = sstep(0.32, 0.55, fx) * (1 - sstep(0.8, 0.97, fx)), G = sstep(0.18, 0.3, fx) * (1 - sstep(0.84, 0.95, fx));
    const hand = 1 - 2 * S.twAlt * (j % 2);       // twist handedness
    C.a = a; C.rad = BODY.ring * (1 - 0.3 * S.pa * p); C.y = 0.02;
    C.tilt = S.spread + S.lift * step * still * (1 - 0.8 * wrapJ) + S.fTilt * m + S.uTilt * uf - 0.6 * S.pa * p * (1 - m);
    C.tilt += Fw * F * (FETCH_TILT - C.tilt) - 0.5 * U * (1 - reach)    // a rolled arm is held low
      - 0.4 * S.indep * R[4];                                             // a resting arm lies slack
    const sh = SHAPE[j];
    C.len = S.len * (1 + S.fLen * m) * (1 + S.vary * 0.08 * Math.sin(sh[0]));
    const amp = (S.wa * still + S.fWave * m) * 0.25;
    const swirl = (S.swirl + 0.3 * wrapJ) * 0.12;
    const twA = S.twW * still * rl(1) + S.fTw * m;
    const tipL = S.lTip * sel * (1 - S.unroll + S.unroll * reach);
    for (let i = 0; i < B; i++) {
      const t = (i + 1) / B, t3 = t * t * t;
      const w = hj * phase - S.k * i - off;
      const coil = (S.tip + S.vary * 0.45 * Math.sin(sh[1])) * t3 + S.tipW * still * rl(3) * t3 * Math.sin(hj * phase - off - 1.0);
      const A = amp * (0.3 + t);
      // This arm's own S-curve and sideways lean, then a slow wander (harmonics 1 and 2 only).
      // Per-joint amounts are small on purpose: they add up over 18 joints.
      const shapeZ = S.vary * 0.045 * Math.sin(Math.PI * 1.6 * t + sh[2]);
      const shapeX = S.vary * 0.03 * Math.sin(Math.PI * 1.2 * t + sh[3]);
      const wz = S.wander * still * 0.035 * (Math.sin(phase + sh[4] - 0.35 * i) + 0.5 * Math.sin(2 * phase + sh[5] - 0.6 * i));
      const wx = S.wander * still * 0.04 * Math.sin(phase + sh[5] - 0.3 * i);
      // Unrolling: beyond the bend the arm is rolled up (uDir: under or over; tighter toward the
      // tip); before it, straight.
      const rolled = sstep(bend - 0.12, bend + 0.12, t);
      const g = 1 - 0.7 * U * (1 - rolled);
      let z = -(S.curl + wrapJ) * 0.22 + g * (coil * 0.9 + A * Math.sin(w) + shapeZ + wz) + S.uDir * U * rolled * (0.15 + 0.45 * t);
      // Each arm its own: a twisting arm also bends its outer part, so it screws into a corkscrew.
      z -= S.indep * R[1] * S.tw * 1.8 * sstep(0.25, 0.6, t);

      let x = swirl + g * (S.side * A * Math.sin(w + 1.3) + shapeX + wx);
      // Fetching: three near-rigid pieces, the bends gathered at the elbow and the wrist.
      z = z * (1 - 0.85 * Fw) + Fw * (F * FOLD[i] + G * GRIP[i]);
      x = x * (1 - 0.85 * Fw);
      C.bz[i] = z; C.bx[i] = x;
      C.by[i] = hand * (S.tw * rl(1) + twA * (0.3 + t) * Math.sin(w + 0.7));
      // Local length: a wave out along the arm, a stretching tip over a bunching base, the stride.
      const L = 1 + S.lw * still * rl(2) * Math.sin(hj * phase - S.lk * i - off - 0.5)
        + tipL * (1.6 * t - 0.5) + S.pull * still * step * (0.4 + 0.6 * t);
      C.bl[i] = Math.min(1.9, Math.max(0.45, L));
    }
  }
  return P;
}
