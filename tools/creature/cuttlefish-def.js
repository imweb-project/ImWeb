// The cuttlefish (Sepia officinalis): a rigid mantle stiffened by the cuttlebone, a ribbon fin
// along each side, eight short arms usually held together in a point, two feeding tentacles kept
// hidden until the strike, big eyes with W-shaped pupils, and a skin that is its main instrument.
// Pure maths, no three.js (see core.js for the contract every creature follows).
//
// BUILD space: the creature is built like the octopus, hanging — the arm crown at the origin,
// arms down (−y), head and mantle up (+y) — and the root pitches it horizontal (rz = π/2). So
// build −y points FORWARD, build +x is the BACK (dorsal), build ±z the sides. The view builds the
// head, mantle, fins and tentacles on these numbers (it imports SHAPE).
//
// What moves:
//   - FINS: a ribbon of short rays along each mantle edge; a travelling wave runs along them
//     (finH whole cycles per loop, finK waves along the fin). Left and right can run opposite ways
//     (finLR) to turn; folded under the belly for a jet (finFold).
//   - ARMS: a forward bundle (point), lowered (droop, settle), the first pair raised as a lure
//     (raise1), the fourth pair spread for the male display (show4), flared open (strike, flash).
//   - TENTACLES: hidden (a short stub inside the arm crown) until the strike, when their length
//     shoots out in a few frames, holds, and hauls back (strike, strikeAt).
//   - BODY: hovering bob and breathing, a circle (spin whole turns), jets backwards (jetH per loop),
//     ink: squirt, blanch and flee, glide back round the side.
//   - SKIN: every pattern is a uniform for the view's shader, driven from the same phase clock.
//   - INK: K puffs, each a pure function of the phase (birth point on the root path at its birth
//     phase, drift, growth, fade), in WORLD space so the cloud stays where it was squirted.
import { TAU, scatter } from './core.js';

export const NAME = 'Cuttlefish';
export const LOOP_SECONDS = 6;

const sst = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const fr = x => x - Math.floor(x);

// Smooth profile through knots [s, value]: cubic Hermite with Catmull-Rom slopes, flat ends.
function profile(pts) {
  const n = pts.length;
  const m = pts.map((p, i) => (i === 0 || i === n - 1) ? 0 : (pts[i + 1][1] - pts[i - 1][1]) / (pts[i + 1][0] - pts[i - 1][0]));
  return s => {
    if (s <= pts[0][0]) return pts[0][1];
    if (s >= pts[n - 1][0]) return pts[n - 1][1];
    let i = 0; while (s > pts[i + 1][0]) i++;
    const [x0, y0] = pts[i], [x1, y1] = pts[i + 1], h = x1 - x0, t = (s - x0) / h, t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * y0 + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * y1 + (t3 - t2) * h * m[i + 1];
  };
}
// Rounded ends: the mouth dome in front of the arm crown, the tail behind the mantle.
const cap = s => s < 0 ? Math.sqrt(Math.max(0, 1 - (s / 0.16) ** 2))
  : s > 1.82 ? Math.sqrt(Math.max(0, 1 - ((s - 1.82) / 0.18) ** 2)) : 1;
const Wk = profile([[0, 0.2], [0.08, 0.22], [0.2, 0.29], [0.33, 0.28], [0.43, 0.255], [0.56, 0.33], [0.8, 0.4], [1.2, 0.42], [1.55, 0.39], [1.82, 0.31], [2, 0.31]]);
const Hdk = profile([[0, 0.13], [0.08, 0.15], [0.2, 0.18], [0.33, 0.17], [0.43, 0.15], [0.56, 0.19], [0.9, 0.22], [1.3, 0.21], [1.6, 0.17], [1.82, 0.13], [2, 0.13]]);
const Hvk = profile([[0, 0.12], [0.08, 0.13], [0.2, 0.15], [0.33, 0.14], [0.43, 0.14], [0.56, 0.18], [0.9, 0.2], [1.3, 0.18], [1.6, 0.14], [1.82, 0.1], [2, 0.1]]);

// Shape, shared with cuttlefish-view.js (which imports it), so fins, eyes and siphon sit where
// pose() expects them. s runs along the body from the mouth (−0.16) to the tail tip (2.0).
export const SHAPE = {
  s0: -0.16, s1: 2.0,
  W: s => Wk(s) * cap(s),            // half-width (z)
  Hd: s => Hdk(s) * cap(s),          // dorsal half-height (+x)
  Hv: s => Hvk(s) * cap(s),          // ventral half-height (−x)
  // Cross-section point at angle th (0 = +z edge, π/2 = back, −π/2 = belly): a flattened oval
  // whose lateral edges sit at x = 0, where the fins attach.
  at(s, th) {
    const c = Math.cos(th), sn = Math.sin(th), e = 0.9, sp = (v, k) => Math.sign(v) * Math.pow(Math.abs(v), k);
    return [(sn >= 0 ? this.Hd(s) : this.Hv(s)) * sp(sn, e), s, this.W(s) * sp(c, e)];
  },
  crown: -0.02,                       // the head's skin ends in this rim; the arms grow on from it
  armA: j => TAU / 16 + j * TAU / 8,  // arm angle round the crown, 0 = the back: pair I is j = 0, 7
  // Arm root radius at angle a: well inside the crown's oval, so the arms fill it.
  ringAt(a) {
    const s = this.crown, H = Math.cos(a) >= 0 ? this.Hd(s) : this.Hv(s);
    return 0.6 / Math.hypot(Math.cos(a) / H, Math.sin(a) / this.W(s));
  },
  eye: { s: 0.19, th: 0.5, ball: 0.105, mound: 0.055, sigma: 0.1, slit: [0.086, 0.058] },
  fin: { s0: 0.5, s1: 1.965, n: 16, len: 0.125 },   // rays per side; full ray length (fin width)
  siphon: [-0.17, 0.05, 0],           // funnel tip, under the head, opening forward
  pivot: [0, 0.85, 0],                // the body turns about the middle of the mantle
  mantleO: [0.06, 0.5, 0],            // the mantle squeezes about this point (dorsal side, neck)
  neck: [0.38, 0.58],                 // head → mantle weight blend
};

const ARMS = 8, NR = SHAPE.fin.n;
export const BODY = { arms: ARMS, finRays: NR };
export const CHAINS = [
  // Arms: short, thick at the base. custom[0] = 5 tells the skin shader "arm".
  // Arms: the view grows them out of the head's skin (one surface, no join at the crown).
  { group: 'arm', count: ARMS, bones: 10, length: 0.6, r0: 0.056, r1: 0.008, rs: 12, decay: 0.93, tube: false },
  // Tentacles: the view builds a smooth stalk and a club on these bones. Even segments, so the
  // stalk stretches evenly when its length shoots out.
  { group: 'tentacle', count: 2, bones: 16, length: 1.5, r0: 0.03, r1: 0.02, rs: 8, tube: false, decay: 1, stiff: 1.4 },
  // Fin rays: 2 joints each, stiff (the ripple is fast); the view stretches a sheet between them.
  { group: 'fin', count: 2 * NR, bones: 2, length: SHAPE.fin.len, r0: 0.01, r1: 0.01, rs: 4, tube: false, decay: 1, stiff: 3.5 },
];

export const INT_KEYS = ['breathH', 'finH', 'waveH', 'spin', 'jetH', 'cloudH', 'zebH', 'flickH', 'papH', 'bloomH', 'cwH',
  'walkH', 'crabH', 'sigH', 'braidH', 'flingH', 'groomH'];

export const DEFAULT = {
  // body
  height: 1.0,   // pivot height above the floor
  bob: 0.03,     // bob with each breath
  breathe: 0.025,// mantle breathing (squeeze)
  breathH: 4,    // breaths per loop
  pitch: 0,      // nose up (+)
  yaw: 0,        // heading (rad)
  turn: 0,       // looks round: heading swings ± this
  drift: 0,      // sideways drift on the fins
  circ: 0,       // radius of a circling swim
  spin: 0,       // whole circles per loop
  creep: 0,      // stalking: creeps forward and eases back
  jet: 0,        // jet backwards: distance per jet
  jetH: 1,       // jets per loop
  ink: 0,        // squirt ink, blanch and flee
  // fins
  finA: 0.24,    // ripple amplitude (rad)
  finH: 10,      // ripple cycles per loop
  finK: 1.6,     // waves along the fin
  finLR: 0,      // right fin's wave reversed (0 → 1): turning on the spot
  finUp: 0.05,   // held fin angle (+ up)
  finFold: 0,    // fins wrapped under the belly (jetting)
  // arms
  spread: 0.06,  // arms open at the root
  point: 0.85,   // arms gathered into a forward point
  droop: 0.4,    // arms bend down (ventral)
  curl: 0.15,    // tips curl in (toward the mouth)
  wave: 0.12,    // arms stir
  waveH: 2,      // arm stirring per loop
  raise1: 0,     // first pair raised over the head, tips curling (the lure)
  show4: 0,      // fourth pair spread and lowered (male display)
  settle: 0,     // arms laid on the floor in front
  len: 1,        // arm length
  bloom: 0,      // arms open like a flower, tips curling back like petals
  bloomH: 2,     // opens per loop
  bloomP: 1,     // how much it opens and closes (0 = held open)
  bloomRot: 0,   // the opening runs round the crown (1 = one arm after another, all the way round)
  flush: 0,      // the skin flashes stripes as the arms open
  lift: 0,       // arms raised up over the head
  splay: 0,      // arms spread wide apart
  indep: 0,      // each arm its own: reaching, coiling, twisting, swaying at its own pace
  twist: 0,      // arms twist about themselves (neighbours opposite ways)
  cwave: 0,      // a wave of curling runs round the crown
  cwH: 2,        // curling waves per loop
  walk: 0,       // walks on the lower arms (pairs III, IV step in turn), upper arms held up and curled
  walkH: 4,      // steps per loop (each leg)
  crab: 0,       // hermit-crab mimic: arms bent down at a knee like legs, first pair raised as claws
  crabH: 4,      // crab steps per loop
  eat: 0,        // catch and eat once per loop: open, wrap the prey, pull it in, munch, let go
  sig: 0,        // wave signals: the first pair waves left and right in turn, like semaphore
  sigH: 3,       // waves per loop
  braid: 0,      // arms twist together into a spiral braid and unwind
  braidH: 1,     // braids per loop
  fling: 0,      // startle: all arms flick open and snap back
  flingH: 2,     // flicks per loop
  groom: 0,      // neighbouring arms stroke and rub against each other
  groomH: 3,     // strokes per loop
  stretch: 0,    // a slow stretching yawn once per loop: reach long and wide, flex, curl tight, relax
  // tentacles
  strike: 0,     // tentacle strike once per loop (0 = hidden)
  strikeAt: 0.45,// where in the loop it fires
  // skin
  mottle: 0.35, disrupt: 0, cloud: 0, cloudH: 10, zebra: 0, zebH: 2,
  flash: 0,      // deimatic: pale, dark eyespots, dark margins
  flick: 0,      // flashing: whole-body pale pulses
  flickH: 6,
  pale: 0, dark: 0,
  pap: 0,        // papillae raised
  papH: 0, papW: 0,   // papillae rise and fall (papH per loop, papW how much)
  iri: 0.6,      // iridescence
  chroma: 0.5,   // chromatophores expanded (speckle darkness)
};

export const GROUPS = ['hovering', 'walking', 'hunting', 'display', 'camouflage', 'escape'];

const SETTLED = { height: 0.23, settle: 1, finA: 0.05, finH: 4, finK: 1.2, finUp: -0.14, droop: 0.2, curl: 0.25,
  wave: 0.04, point: 0.75, breathe: 0.02, bob: 0.004, iri: 0.35 };

export const SEGMENTS = [
  { name: 'Hover',    group: 'hovering',   desc: 'holds still on rippling fins, arms gathered forward and stirring, breathing',
    s: { indep: 0.25, wave: 0.15 } },
  { name: 'Drift',    group: 'hovering',   desc: 'looks round: the fins run opposite ways and turn it, drifting sideways',
    s: { turn: 0.75, drift: 1, finLR: 0.7, finA: 0.2, wave: 0.2, indep: 0.35, point: 0.65, mottle: 0.45 } },
  { name: 'Cruise',   group: 'hovering',   desc: 'swims forward in a circle on strong fin waves, arms streamlined',
    s: { circ: 1.4, spin: 1, finA: 0.3, finH: 12, finK: 1.9, point: 1, droop: 0.15, wave: 0.05, pitch: -0.04, mottle: 0.2, chroma: 0.4, iri: 0.8 } },
  { name: 'Stretch',  group: 'hovering',   desc: 'a slow stretching yawn: arms reach long and wide, flex, curl tight, relax',
    s: { stretch: 1, wave: 0.08, indep: 0.15, finA: 0.18 } },
  { name: 'Walk',     group: 'walking',    desc: 'walks round on its lower arms, step by step; the upper arms held up and curled',
    s: { walk: 1, walkH: 4, circ: 0.9, spin: 1, height: 0.42, finA: 0.1, finH: 6, finUp: -0.08, point: 0, droop: 0, curl: 0,
         wave: 0.05, mottle: 0.6, chroma: 0.6, iri: 0.4 } },
  { name: 'Crab',     group: 'walking',    desc: 'hermit-crab mimic: arms bent down like legs, first pair raised as claws, scuttling sideways',
    s: { crab: 1, crabH: 4, drift: 1.2, height: 0.5, point: 0, droop: 0, curl: 0, wave: 0.03, finA: 0.06, finH: 6,
         mottle: 0.8, pap: 0.5, disrupt: 0.25, chroma: 0.6 } },
  { name: 'Stalk',    group: 'hunting',    desc: 'creeps forward, arms pointed, the first pair raised and curling; passing clouds',
    s: { raise1: 1, point: 1, droop: 0.12, wave: 0.05, finA: 0.07, finH: 8, creep: 1, cloud: 0.5, cloudH: 8,
         height: 0.75, pitch: -0.08, chroma: 0.65, mottle: 0.15 } },
  { name: 'Explore',  group: 'hunting',    desc: 'each arm its own: one reaches, one coils, one twists, one sways, each at its own pace',
    s: { indep: 1, point: 0.3, spread: 0.14, droop: 0.15, wave: 0.14, curl: 0.05, finA: 0.14, mottle: 0.5, chroma: 0.6 } },
  { name: 'Strike',   group: 'hunting',    desc: 'arms flare, the two tentacles shoot out and haul the prey back in',
    s: { strike: 1, point: 0.8, droop: 0.15, finA: 0.1, height: 0.75, pitch: -0.06, cloud: 0.25, cloudH: 8, chroma: 0.6 } },
  { name: 'Eat',      group: 'hunting',    desc: 'catch and eat: arms open, wrap the prey and pull it in, munch, then let go',
    s: { eat: 1, point: 0.7, droop: 0.12, finA: 0.12, height: 0.8, chroma: 0.6, cloud: 0.2, cloudH: 6 } },
  { name: 'Cloud',    group: 'display',    desc: 'passing cloud: dark bands sweep forward over the mantle and down the arms',
    s: { cloud: 1, cloudH: 12, point: 0.85, finA: 0.1, wave: 0.06, mottle: 0, chroma: 0.3, pale: 0.25, height: 0.85 } },
  { name: 'Zebra',    group: 'display',    desc: 'the male zebra display: black and white stripes pulsing, fourth arms spread',
    s: { zebra: 1, zebH: 3, show4: 1, spread: 0.16, point: 0.35, droop: 0.15, wave: 0.2, twist: 0.3, finA: 0.26, mottle: 0, chroma: 0.2, iri: 0.9 } },
  { name: 'Bloom',    group: 'display',    desc: 'the arms open like a flower, tips curling back, and close again; stripes flash as they open',
    s: { bloom: 1, bloomH: 2, bloomP: 1, point: 0.4, droop: 0.05, curl: 0, wave: 0.12, flush: 1, finA: 0.18, mottle: 0.15, chroma: 0.45 } },
  { name: 'Splay',    group: 'display',    desc: 'arms raised over the head and splayed, tips curling and twisting; banded arms',
    s: { lift: 1, splay: 1, point: 0, droop: 0, curl: 0.35, wave: 0.28, waveH: 2, twist: 0.5, indep: 0.3, pitch: 0.2,
         zebra: 0.45, zebH: 2, chroma: 0.8, mottle: 0.2, finA: 0.2 } },
  { name: 'Curl',     group: 'display',    desc: 'a wave of curling runs round the crown: each arm coils and uncoils in turn',
    s: { cwave: 1, cwH: 2, point: 0.3, spread: 0.22, droop: 0.06, curl: 0, wave: 0.08, twist: 0.25, cloud: 0.35, cloudH: 6, chroma: 0.5 } },
  { name: 'Wave',     group: 'display',    desc: 'wave signals: the first pair of arms waves left and right in turn, tips flicking',
    s: { sig: 1, sigH: 3, point: 0.6, droop: 0.12, finA: 0.18, zebra: 0.3, zebH: 3, chroma: 0.5 } },
  { name: 'Braid',    group: 'display',    desc: 'arms twist together into a spiral braid, then unwind',
    s: { braid: 1, braidH: 1, point: 0.8, droop: 0.05, curl: 0, wave: 0.05, cloud: 0.3, cloudH: 6 } },
  { name: 'Flash',    group: 'display',    desc: 'deimatic: pales, flashes dark eyespots, arms flung open and curled',
    s: { flash: 1, flick: 0.7, flickH: 6, bloom: 0.75, bloomP: 0.2, bloomH: 6, curl: 0.45, point: 0, droop: 0.05, finA: 0.04, finUp: -0.25,
         height: 0.9, mottle: 0, chroma: 0.1 } },
  { name: 'Settle',   group: 'camouflage', desc: 'sinks to the floor, arms laid down, mottles to match the ground',
    s: { ...SETTLED, mottle: 1, chroma: 0.6, indep: 0.15 } },
  { name: 'Algae',    group: 'camouflage', desc: 'on the floor, arms raised and swaying like seaweed, papillae up, mottled',
    s: { ...SETTLED, lift: 0.8, splay: 0.6, point: 0, wave: 0.35, waveH: 1, indep: 0.45, twist: 0.2, curl: 0.2,
         mottle: 1, pap: 0.7, papW: 0.1, papH: 1, chroma: 0.75 } },
  { name: 'Groom',    group: 'camouflage', desc: 'resting on the floor, neighbouring arms stroke and rub against each other',
    s: { ...SETTLED, groom: 1, groomH: 3, point: 0.6, mottle: 0.7, chroma: 0.55 } },
  { name: 'Disrupt',  group: 'camouflage', desc: 'disruptive pattern: white square, dark bars, white head bar',
    s: { ...SETTLED, mottle: 0.2, disrupt: 1, pap: 0.3 } },
  { name: 'Papillae', group: 'camouflage', desc: 'skin papillae rise into 3D bumps, mottled; it breathes and holds still',
    s: { ...SETTLED, mottle: 0.9, pap: 0.85, papW: 0.15, papH: 1, chroma: 0.7 } },
  { name: 'Flick',    group: 'escape',     desc: 'startled: all arms flick open and snap back, the skin flashing pale',
    s: { fling: 1, flingH: 2, point: 0.7, finA: 0.2, mottle: 0.2 } },
  { name: 'Jet',      group: 'escape',     desc: 'jets backwards twice: mantle squeezes, fins wrap, arms stream behind',
    s: { jet: 1.3, jetH: 2, finFold: 0.9, finA: 0.08, point: 1, droop: 0.05, wave: 0.02, curl: 0, chroma: 0.25, pale: 0.15 } },
  { name: 'Ink',      group: 'escape',     desc: 'darkens, squirts ink, blanches and flees, then glides back round the side',
    s: { ink: 1, finA: 0.18, point: 0.8 } },
];

// ---- Root: one pure function of the phase, so ink puffs can ask where the body was ---------
// Heading frame: forward d = (cos ry, 0, −sin ry) (three.js Ry turns +x that way), side n.
// Rotation R = Ry(ry)·Rz(rz), rx = 0 (core.js root order Y·Z·X).
function rot(ry, rz, v) {
  const cz = Math.cos(rz), sz = Math.sin(rz), cy = Math.cos(ry), sy = Math.sin(ry);
  const x = v[0] * cz - v[1] * sz, y = v[0] * sz + v[1] * cz, z = v[2];
  return [x * cy + z * sy, y, -x * sy + z * cy];
}
// Ink timeline (loop fraction): alarm 0.05–0.13, squirt 0.13–0.19, flee 0.19–0.3, glide back.
const INK = { a0: 0.05, s0: 0.13, s1: 0.19, f1: 0.3, back: 2.1 };
function inkPath(x) {
  const flee = 1 - Math.pow(1 - sst(INK.s1, INK.f1, x), 2);   // fast out, easing to a stop
  const ret = sst(INK.f1 + 0.04, 0.97, x), arc = Math.sin(Math.PI * ret);
  return { back: INK.back * flee * (1 - ret), side: 1.0 * arc, up: 0.25 * arc };
}
// Strike timeline, xs = loop fraction since the strike fired.
function strikeT(xs) {
  const ext = xs < 0.022 ? 1 - (1 - xs / 0.022) ** 2 : 1 - sst(0.06, 0.24, xs);       // shoot, hold, haul back
  const flare = Math.max(sst(0.86, 0.995, xs), 1 - sst(0.03, 0.12, xs));              // arms open to let them through
  const grasp = sst(0.14, 0.24, xs) * (1 - sst(0.4, 0.65, xs));                       // arms close on the prey
  const lunge = xs > 0.5 ? sst(0.7, 0.99, xs) : 1 - sst(0.05, 0.45, xs);
  return { ext, flare, grasp, lunge };
}
// Catch and eat, once per loop: open, wrap the prey, munch (10 per loop: whole number), let go.
function eatT(x) {
  const open = sst(0.03, 0.12, x) * (1 - sst(0.13, 0.2, x)), close = sst(0.14, 0.24, x) * (1 - sst(0.84, 0.97, x));
  return { open, close, munch: close * (0.5 + 0.5 * Math.sin(TAU * 10 * x)) };
}
// Startle flick: snap open, hold an instant, close again (xf = loop fraction since it fired).
const flingT = xf => xf < 0.04 ? 1 - (1 - xf / 0.04) ** 2 : 1 - sst(0.1, 0.32, xf);
// Stretch, once per loop: reach long and wide, flex the tips back, curl them tight, relax.
function stretchT(x) {
  return { ext: sst(0.08, 0.4, x) * (1 - sst(0.55, 0.75, x)), spread: sst(0.1, 0.42, x) * (1 - sst(0.6, 0.85, x)),
    flex: sst(0.35, 0.5, x) * (1 - sst(0.55, 0.65, x)), curl: sst(0.58, 0.7, x) * (1 - sst(0.8, 0.97, x)) };
}
function jetT(xj) {
  const D = xj < 0.1 ? 1 - (1 - xj / 0.1) ** 2 : 1 - sst(0.1, 1, xj);                 // shoot back, glide forward
  const squeeze = sst(0, 0.03, xj) * (1 - sst(0.05, 0.16, xj)) - 0.6 * sst(0.75, 0.97, xj) * (1 - sst(0.97, 1, xj));
  return { D, squeeze };
}

export function rootAt(S, phase) {
  const x = phase / TAU;
  const th = TAU * fr(S.spin * x);                         // circle angle: whole turns, seamless
  const ry = S.yaw + th + S.turn * Math.sin(phase);
  const rz = Math.PI / 2 + S.pitch - 0.05 * S.jet * jetT(fr(S.jetH * x)).squeeze;
  const d = [Math.cos(ry), 0, -Math.sin(ry)], n = [Math.sin(ry), 0, Math.cos(ry)];
  // Circle, centred on the origin (Ry(yaw)·(sin θ, 0, cos θ)·circ is tangent to the heading).
  const cx = S.circ * Math.sin(th), cz0 = S.circ * Math.cos(th);
  let px = Math.cos(S.yaw) * cx + Math.sin(S.yaw) * cz0, pz = -Math.sin(S.yaw) * cx + Math.cos(S.yaw) * cz0;
  let py = S.height + S.bob * Math.sin(S.breathH * phase - 0.6);
  // Along the heading: jets back, ink flight, strike lunge, stalking creep; sideways drift.
  const J = S.jet * jetT(fr(S.jetH * x)).D;
  const I = inkPath(x), st = strikeT(fr(x - S.strikeAt));
  const ea = eatT(x), fl = S.fling * flingT(fr(S.flingH * x));
  const fwd = -J - S.ink * I.back + 0.14 * S.strike * st.lunge - 0.25 * S.creep * Math.cos(phase) + 0.08 * S.drift * Math.sin(2 * phase)
    + 0.12 * S.eat * sst(0.08, 0.16, x) * (1 - sst(0.3, 0.9, x)) - 0.07 * fl;
  const side = S.ink * I.side + 0.35 * S.drift * Math.sin(phase);
  px += d[0] * fwd + n[0] * side; pz += d[2] * fwd + n[2] * side;
  py += S.ink * I.up + S.walk * 0.02 * Math.sin(2 * S.walkH * phase) + S.crab * 0.015 * Math.sin(2 * S.crabH * phase)
    + 0.012 * S.eat * ea.munch;
  return { p: [px, py, pz], ry, rz };
}

// Ink puffs: K per squirt, born along the squirt at the funnel tip, in world space.
const K = 12, IR = [scatter(K, 31), scatter(K, 32), scatter(K, 33), scatter(K, 34)].map(a => a.map(v => v / TAU));
export const INK_PUFFS = K;

const ARM_LEN = [0.8, 0.9, 1.0, 1.06];          // pairs I (the back) … IV (the belly)
// Each arm its own (indep): shares of [reach, coil, twist, sway], timing, whole-number rate.
const ROLE = [[1, 0.3, 0, 0.5], [0.2, 1, 0.5, 0], [0, 0.5, 1, 0.6], [0.7, 0, 0.3, 1],
  [0.3, 1, 0, 0.4], [1, 0, 0.6, 0.2], [0, 0.7, 0.4, 1], [0.5, 0.5, 1, 0]];
const OWN = scatter(ARMS, 4242), RATE = [1, 2, 1, 3, 2, 1, 3, 2];
const OFF = scatter(ARMS, 515), FOFF = scatter(2, 77);

export function pose(S, phase, P) {
  const x = phase / TAU;
  // ---- Root (build origin = arm crown) from the pivot path
  const R = rootAt(S, phase), pv = rot(R.ry, R.rz, SHAPE.pivot);
  P.root.x = R.p[0] - pv[0]; P.root.y = R.p[1] - pv[1]; P.root.z = R.p[2] - pv[2];
  P.root.rx = 0; P.root.ry = R.ry; P.root.rz = R.rz;

  // ---- Mantle: breathing, jets, the squirt
  const jt = jetT(fr(S.jetH * x)), st = strikeT(fr(x - S.strikeAt));
  const squirt = sst(INK.s0, INK.s0 + 0.01, x) * (1 - sst(INK.s1, INK.s1 + 0.03, x));
  const inkJet = sst(INK.s1, INK.s1 + 0.015, x) * (1 - sst(INK.s1 + 0.04, INK.f1, x));
  P.parts.squeeze = S.breathe * Math.sin(S.breathH * phase) + 0.1 * S.jet * jt.squeeze / 1.3
    + S.ink * (0.04 * squirt * Math.sin(TAU * 12 * x) ** 2 + 0.11 * inkJet);
  P.parts.blink = Math.min(1, Math.pow((1 + Math.cos(phase - 2.2)) / 2, 80) * 1.6);

  // ---- Arms
  const flare = S.strike * st.flare, grasp = S.strike * st.grasp;
  const ea = eatT(x), fl = S.fling * flingT(fr(S.flingH * x));
  for (let j = 0; j < ARMS; j++) {
    const C = P.chains[j], B = C.bz.length, a = SHAPE.armA(j), ca = Math.cos(a), sa = Math.sin(a);
    const pr = Math.min(j, 7 - j), sg = sa >= 0 ? 1 : -1, first = pr === 0 ? 1 : 0, fourth = pr === 3 ? 1 : 0;
    // Flower: opens and closes (bloomP), each arm a little later round the crown (bloomRot).
    const op = S.bloom * (1 - S.bloomP * (0.5 + 0.5 * Math.cos(S.bloomH * phase - S.bloomRot * TAU * j / ARMS)));
    // Curling wave: each arm coils in turn round the crown.
    const cw = S.cwave * (0.5 - 0.5 * Math.cos(S.cwH * phase - TAU * j / ARMS));
    // Each arm its own: its share of reaching, coiling, twisting and swaying, its own timing and
    // its own whole-number rate (seamless).
    const R = ROLE[j], ph = RATE[j] * phase - OWN[j];
    const reach = S.indep * R[0] * (0.5 - 0.5 * Math.cos(ph)) * 1.3;
    const coil = S.indep * R[1] * Math.sin(ph + 0.9);
    const twist = S.indep * R[2] * Math.sin(ph - 0.6) + S.twist * (j % 2 ? -1 : 1) * (0.6 + 0.4 * Math.sin(S.waveH * phase - OFF[j]));
    const sway = S.indep * R[3] * Math.sin(ph + 2.1);
    // Walking: pairs III and IV are legs, stepping in turn (left/right half a step apart, III a
    // quarter after IV); pairs I and II are held up and curled.
    const leg = S.walk * (pr >= 2 ? 1 : 0), held = S.walk * (pr < 2 ? 1 : 0);
    const stepPh = S.walkH * phase - (sg > 0 ? 0 : Math.PI) - (pr === 3 ? 0 : Math.PI / 2);
    const swing = Math.max(0, Math.sin(stepPh)), sweep = Math.cos(stepPh);
    // Crab mimic: pairs II–IV bend down at a knee and splay, stepping alternately; pair I are claws.
    const crabLeg = S.crab * (pr >= 1 ? 1 : 0), claw = S.crab * first;
    const cst = Math.sin(S.crabH * phase + (j % 2 ? Math.PI : 0) + pr * 0.6);
    // Wave signals: the first pair (and a little the second) sweeps side to side, left and right in turn.
    const sigW = S.sig * (first ? 1 : pr === 1 ? 0.4 : 0), sp = Math.sin(S.sigH * phase + (sg > 0 ? 0 : Math.PI) + pr * 0.8);
    // Catch and eat, braid, startle flick, grooming, stretch.
    const eOpen = S.eat * ea.open, eClose = S.eat * ea.close, eMunch = S.eat * ea.munch;
    const br = S.braid * (0.5 - 0.5 * Math.cos(S.braidH * phase));
    const gp = S.groom * Math.sin(S.groomH * phase + (j % 2 ? Math.PI : 0) + pr * 0.4);
    const SX = stretchT(x), sEx = S.stretch * SX.ext, sSp = S.stretch * SX.spread;
    const point = Math.min(1.4, S.point + grasp + 0.7 * eClose + 0.7 * br) * (1 - 0.8 * flare) * (1 - op) * (1 - 0.6 * reach)
      * (1 - leg) * (1 - crabLeg) * (1 - fl) * (1 - sSp) * (1 - eOpen);
    C.a = a; C.rad = SHAPE.ringAt(a); C.y = SHAPE.crown;
    C.tilt = S.spread - 0.2 * point + 0.75 * flare + first * S.raise1 * 0.95 + fourth * S.show4 * 0.4
      + S.settle * 0.12 + 0.03 * S.wave * Math.sin(S.waveH * phase - OFF[j])
      + 1.25 * op + 0.7 * S.splay + 0.3 * reach + 0.1 * sway
      + leg * (0.35 + 0.22 * sweep - 0.25 * swing) + 0.55 * held + sigW * (0.85 + 0.25 * sp)
      + 1.0 * eOpen + 0.06 * eMunch + crabLeg * (0.45 + 0.1 * cst) + 0.7 * claw - 0.15 * br + 1.35 * fl + 0.7 * sSp;
    C.len = S.len * ARM_LEN[pr] * (1 + 0.22 * fourth * S.show4) * (1 + 0.15 * first * S.raise1) * (1 + 0.3 * reach)
      * (1 - 0.22 * eClose) * (1 + 0.08 * gp * (j % 2 ? 1 : -1)) * (1 + 0.35 * sEx) * (1 + 0.1 * leg);
    const amp = S.wave * 0.07;
    const lift = S.lift * (1 - 0.3 * first * S.raise1);
    for (let i = 0; i < B; i++) {
      const t = (i + 1) / B, t2 = t * t, t3 = t2 * t, w = S.waveH * phase - 0.7 * i - OFF[j];
      // radial (+ out), tangential, ventral (down), lateral (out to the side), dorsal (up) per joint
      let rd = -S.curl * 0.5 * t3 + amp * (0.3 + t) * Math.sin(w) + 0.25 * flare * t3 - 0.012 * point
        + op * (0.13 * t2 - 0.02)                  // petals: the outer half curls back
        - cw * 0.85 * Math.pow(t, 2.2)             // the curling wave coils the tip in
        - coil * 0.7 * t3 - reach * 0.03 * (1 - t);
      let tg = amp * (0.3 + t) * Math.sin(w + 1.4) + sway * 0.11 * (0.3 + t) * Math.sin(ph + 1.0 - 0.5 * i);   // own rate: whole cycles, seamless
      let ven = (S.droop * 0.05 * (1 - first * S.raise1) + S.settle * 0.07 * (1 - 0.6 * t)) * (1 - 0.8 * op) * (1 - lift) - 0.02 * flare;
      let lat = fourth * S.show4 * 0.06 * (1 - t);
      let up = lift * 0.11 * (1 - 0.55 * t) + held * 0.08 * (1 - t) + claw * 0.06 * (1 - t);
      const knee = Math.exp(-((i - 3) ** 2) / 1.2);                 // crab legs bend down here
      rd += (leg * 0.2 + crabLeg * 0.25) * t3                       // a leg's tip turns out flat to plant
        - held * 0.45 * t3 - claw * 0.75 * t3                       // held arms and claws curl
        - sigW * 0.4 * t3 * (0.6 + 0.4 * Math.sin(2 * S.sigH * phase - i))   // the signalling tip flicks
        - eClose * 0.75 * t2 - eMunch * 0.12 * t                    // wrap the prey, munch
        + fl * 0.16 * t2 + S.stretch * (0.1 * SX.flex * t2 - 0.6 * SX.curl * t3);
      ven += leg * (0.13 * (1 - 0.5 * t) - 0.08 * swing) + crabLeg * (0.6 * knee - 0.12 * Math.max(0, cst) * knee);
      tg += sigW * 0.15 * sp * (1 - 0.6 * t) + br * 0.22 * t + gp * 0.09 * (0.3 + t);
      lat += crabLeg * 0.1 * (1 - t);
      // The lure: the raised first pair arches back and its tips curl and twitch.
      if (first) {
        rd += S.raise1 * (0.05 * (1 - t) - 0.55 * t3 * (0.75 + 0.25 * Math.sin(S.waveH * 2 * phase - 2 * i - OFF[j])));
        tg += S.raise1 * 0.06 * t3 * Math.sin(S.waveH * phase - 1.5 * i);
      }
      C.bz[i] = rd - ven * ca + lat * Math.abs(sa) + up * ca;
      C.bx[i] = -tg - ven * sa - lat * sg * ca + up * sa;
      C.by[i] = twist * 0.13 * (0.3 + t) + 0.04 * cw * t + br * 0.5 * t + gp * 0.25 + claw * 0.15 * t;
      C.bl[i] = 1;
    }
  }

  // ---- Tentacles: a stub hidden in the crown; the strike shoots them straight ahead
  const e = S.strike * st.ext;
  P.parts.club = 0.3 + 0.7 * sst(0, 0.5, e);
  for (let j = 0; j < 2; j++) {
    const C = P.chains[ARMS + j], B = C.bz.length, a = j ? 5 * TAU / 8 : 3 * TAU / 8, ca = Math.cos(a), sa = Math.sin(a);
    C.a = a; C.rad = 0.065; C.y = SHAPE.crown;
    C.tilt = -0.05 - 0.12 * S.point * (1 - e);
    C.len = 0.07 + 0.98 * e;
    for (let i = 0; i < B; i++) {
      const t = (i + 1) / B;
      // hidden: follows the arms' droop; out: nearly straight, sagging a little, wobbling as it hauls
      const ven = (1 - e) * S.droop * 0.05 + e * 0.012 + S.settle * 0.04 * (1 - e);
      const wob = 0.03 * e * Math.sin(TAU * 3 * x - 0.8 * i + FOFF[j]) * t;
      C.bz[i] = -ven * ca + wob;
      C.bx[i] = -ven * sa;
      C.by[i] = 0; C.bl[i] = 1;
    }
  }

  // ---- Fins: a travelling wave along each side's rays
  const c = P.parts.squeeze;
  for (let side = 0; side < 2; side++) for (let k = 0; k < NR; k++) {
    const C = P.chains[ARMS + 2 + side * NR + k], t = k / (NR - 1);
    const s = SHAPE.fin.s0 + (SHAPE.fin.s1 - SHAPE.fin.s0) * t;
    const sg = side ? -1 : 1;                                 // + = up on both sides
    C.a = side ? -Math.PI / 2 : Math.PI / 2;
    C.rad = Math.max(0.02, SHAPE.W(s) * (1 - c) - 0.012); C.y = s;
    C.tilt = Math.PI / 2 + 0.95 * sst(0.72, 1, t) - 0.3 * (1 - sst(0, 0.18, t));   // the ends sweep round
    C.len = 0.08 + 0.92 * Math.pow(sst(0, 0.32, t), 0.75) * Math.sqrt(1 - sst(0.86, 1, t));   // narrow in front, rounded lobe behind
    const dir = side ? 1 - 2 * S.finLR : 1;
    const env = 0.45 + 0.55 * Math.sin(Math.PI * t);
    const wv = S.finA * env * Math.sin(S.finH * phase - dir * TAU * S.finK * t + side * 0.6);
    const fold = S.finFold * (0.55 + 0.25 * t);
    C.bx[0] = sg * (S.finUp + 0.55 * wv - fold); C.bx[1] = sg * (0.75 * wv - fold);
    C.bz[0] = 0; C.bz[1] = 0; C.by[0] = 0; C.by[1] = 0; C.bl[0] = 1; C.bl[1] = 1;
  }

  // ---- Skin: pattern amounts and phases for the view's shader
  const pulse = (h, sharp) => Math.pow(0.5 + 0.5 * Math.sin(h * phase), sharp);
  const alarm = S.ink * sst(INK.a0, INK.s0, x) * (1 - sst(INK.s1, INK.s1 + 0.03, x));
  const blanch = S.ink * sst(INK.s1 - 0.01, INK.s1 + 0.02, x) * (1 - sst(0.4, 0.75, x));
  P.parts.uniforms = {
    uCloud: S.cloud, uCloudPh: TAU * fr(S.cloudH * x),
    uZebra: Math.min(1, S.zebra * (0.72 + 0.28 * Math.sin(S.zebH * phase))
      + S.flush * S.bloom * (1 - S.bloomP * (0.5 + 0.5 * Math.cos(S.bloomH * phase))) * 0.85),
    uMot: S.mottle, uDis: S.disrupt,
    uFlash: S.flash * (0.75 + 0.25 * pulse(S.flickH, 2)),
    uPale: Math.min(1, S.pale + S.flick * pulse(S.flickH, 6) + 0.6 * blanch + 0.55 * S.fling * flingT(fr(S.flingH * x)) + 0.2 * S.stretch * stretchT(x).ext + 0.35 * S.jet / 1.3 * sst(0, 0.04, fr(S.jetH * x)) * (1 - sst(0.2, 0.6, fr(S.jetH * x)))),
    uDark: Math.min(1, S.dark + 0.75 * alarm),
    uPap: Math.max(0, S.pap + S.papW * Math.sin(S.papH * phase - 1.2)),
    uIri: S.iri, uChroma: S.chroma,
  };

  // ---- Ink: K puffs [x, y, z, size, opacity], world space
  const ink = P.parts.ink || (P.parts.ink = new Float64Array(K * 5));
  for (let k = 0; k < K; k++) {
    const xb = INK.s0 + (INK.s1 - INK.s0) * k / (K - 1), a = fr(x - xb);
    const Rb = rootAt(S, TAU * xb), off = rot(Rb.ry, Rb.rz, SHAPE.siphon.map((v, i) => v - SHAPE.pivot[i]));
    const fw = rot(Rb.ry, Rb.rz, [-0.25 * (IR[1][k] - 0.5), -1, 0.5 * (IR[2][k] - 0.5)]);
    const D = (0.45 + 0.5 * IR[0][k]) * (1 - Math.exp(-a / 0.035));
    const o = k * 5;
    ink[o] = Rb.p[0] + off[0] + fw[0] * D + 0.25 * (IR[3][k] - 0.5) * a;
    ink[o + 1] = Rb.p[1] + off[1] + fw[1] * D - 0.22 * a;
    ink[o + 2] = Rb.p[2] + off[2] + fw[2] * D + 0.25 * (IR[2][k] - 0.5) * a;
    ink[o + 3] = 0.05 + (0.45 + 0.3 * IR[3][k]) * Math.sqrt(a);
    ink[o + 4] = S.ink * sst(0, 0.008, a) * (1 - sst(0.3, 0.8, a)) * (0.7 + 0.3 * IR[0][k]);
  }
  return P;
}
