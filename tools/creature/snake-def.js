// The cobra: a long spine of 48 vertebra segments, a hood spread by real neck ribs, a jaw and a
// forked tongue. Pure maths, no three.js (see core.js for the contract every creature follows).
//
// What it adds over the centipede:
//   - A BODY FROM A CENTRELINE. pose() first decides where every joint of the spine should be
//     (a track on the ground, a coil, a raised hood…), then turns those points into bone turns
//     exactly: each segment gets a frame (its direction, and a back that stays up on the floor and
//     faces away from whatever the cobra faces when it rears), and each bone is the turn from the
//     frame before it to its own, as three.js Euler XYZ (core.js chainFK applies the same).
//   - ROOTED IN THE MIDDLE. The spine is two chains meeting at joint 20 (s = 2.0): one runs to the
//     head, one to the tail. The joint springs lag, and a lag adds up along a chain; from the
//     middle, the floor half of a rearing cobra stays planted while the raised half whips.
//   - ITS OWN GROUND. Getting around is worked out ON THE GROUND (no slip where the belly grips),
//     then the ground is slid back by exactly what the body gained, so the cobra stays in view and
//     loops: P.parts.ground is how far the ground has slid (the view scrolls its grit by it).
//       lateral undulation — every point follows the head's own S-track (or a circle);
//       concertina — the rear grips in folds while the front unfolds forward, then the front grips
//         and the rear is dragged up after it;
//       rectilinear — the body stays straight while waves of bunching run down it; bunched skin
//         grips, stretched skin slides (segment length `bl`).
//   - THE HOOD is eight pairs of neck ribs (chains `on` neck joints 1–8): spreading is each rib's
//     length (bl), so the skin it carries widens by exactly that factor; they also cup forward.
import { TAU, M3, makePose } from './core.js';

export const NAME = 'Cobra';
export const LOOP_SECONDS = 8;

// ---- Shape, shared with snake-view.js ------------------------------------------------------
const L = 0.1, NSEG = 48, MID = 20;
export const SPINE = { L, NSEG, MID, length: NSEG * L, snout: -0.115 };   // s: 0 at the back of the
                                                                          // jaw line… the snout tip is at s < 0
export const TILE = 1;                     // the ground's grit repeats every TILE; it slides trav × TILE per loop
// The hood is two thin skin flaps on the ribs, rooted `inset` inside the neck's sides: shut, they
// lie folded away; spread, each reaches to w + hs · (max − w) (photo 7: a broad oval ~1.4× as long as wide).
export const HOOD = { ribs: 8, first: 1, ribL: 0.075, s0: 0.1, s1: 0.6, max: 0.2, inset: 0.012 };
const cl = (x, a, b) => Math.min(b, Math.max(a, x));
const ss = (a, b, x) => { const t = cl((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
export const SHAPE = {
  w0: 0.05, w1: 0.03,     // neck half-width, and how much the body thickens beyond it (owner: more girth)
  // Half-width of the body at arclength s from the head joint (neck → thick middle → vent → tail).
  w(s) {
    const body = this.w0 + this.w1 * ss(0.12, 1.6, s);
    const vent = 1 - 0.25 * ss(2.8, 4.0, s);
    const tail = s < 3.9 ? 1 : Math.pow(cl((4.81 - s) / 0.91, 0, 1), 0.85);
    return body * vent * tail;
  },
  hv(s) { return s < 0.1 ? 0.034 : 0.72 * this.w(s); },    // axis to belly
  // Hood outline along the neck, u = 0 at the back of the head → 1 at its end: widens fast, then
  // tapers slowly (Naja). Half-width = w + hood · hs(u) · (max − w).
  hs(u) { return u <= 0 || u >= 1 ? 0 : Math.pow(Math.sin(Math.PI * Math.pow(u, 0.6)), 0.6); },
};
const RIB_S = Array.from({ length: HOOD.ribs }, (_, k) => (HOOD.first + k) * L);

export const BODY = { length: SPINE.length };
export const CHAINS = [
  // The spine: front half (joint 20 → head) and rear half (joint 20 → tail). No tubes: the view
  // builds one skin over both (scales, head, hood).
  { group: 'front', count: 1, bones: MID, length: MID * L, decay: 1, tube: false, stiff: 3.2 },
  { group: 'rear', count: 1, bones: NSEG - MID, length: (NSEG - MID) * L, decay: 1, tube: false, stiff: 2.6 },
  // Lower jaw: hinged at the back of the head (front bone MID − 1 is the head).
  { group: 'jaw', count: 1, bones: 1, length: 0.13, decay: 1, tube: false, stiff: 5, on: { chain: 0, bone: () => MID - 1 } },
  // Tongue and its two tines: black, thin, quick.
  { group: 'tongue', count: 1, bones: 5, length: 0.21, r0: 0.0075, r1: 0.0045, rs: 7, decay: 1, stiff: 9,
    tint: 0x3a1418, tipTint: 0x22090c, on: { chain: 0, bone: () => MID - 1 } },
  { group: 'fork', count: 2, bones: 3, length: 0.07, r0: 0.0045, r1: 0.0014, rs: 6, decay: 1, stiff: 9,
    tint: 0x22090c, on: { chain: 3, bone: () => 5 } },
  // Hood ribs, one pair on each of neck joints 1..8 (lateral, in the bone's own frame).
  { group: 'rib', count: 2 * HOOD.ribs, bones: 1, length: HOOD.ribL, decay: 1, tube: false, stiff: 3,
    on: { chain: 0, bone: j => MID - (HOOD.first + (j >> 1)) } },
];
const FRONT = 0, REAR = 1, JAW = 2, TONGUE = 3, FORK0 = 4, RIB0 = 6;

export const INT_KEYS = ['trav', 'cyc', 'rw', 'undH', 'scH', 'swH', 'sk', 'tf', 'tOsc'];

export const DEFAULT = {
  yaw: -0.4,      // which way a still pose faces (radians; 0 = +x, the way it crawls)
  height: 0,      // extra clearance over the floor
  grav: 1,        // 1 = lies on the floor; 0 = weightless (floats, the floor fades)
  floatH: 0.6,    // where it floats
  // ---- getting around (loco 1): worked out on the ground -----------------------------------
  loco: 0,        // 0 = a still pose (below), 1 = getting around
  trav: 0,        // ground covered per loop, in TILEs (the ground slides back as far)
  round: 0,       // 0 = straight ahead (the ground slides), 1 = round a circle of radius Rc
  Rc: 12 / TAU,   // circle radius (one lap per loop: TAU · Rc = trav · TILE)
  fig: 0,         // 1 = round a figure of eight instead (needs round 1)
  Lf: 14,         //   its length (trav · TILE is a whole number of laps)
  B8: 0.5,        //   its width relative to its length
  cnc: 0,         // share of concertina
  rec: 0,         // share of rectilinear creeping (the rest is lateral undulation)
  amp: 0.3,       // lateral undulation: half-width of the S-track
  lam: 2.4,       //   its wavelength (trav · TILE is a whole number of them)
  hLift: 0.025,   //   the head held just off the ground
  surge: 1,       //   the speed surges with each push of a curve against the ground
  steady: 1,      //   the head runs steadier than the body: its wiggle grows into the full S along the neck
  cyc: 4,         // concertina: grip-and-reach cycles per loop
  cDel: 0,        //   fold depth (set by conc() so each cycle covers trav · TILE / cyc)
  cLam: 1.2,      //   fold wavelength
  cF: 2.2,        //   how much of the body reaches forward
  cRel: 0.5,      //   the dragged rear loosens its folds
  cPh: 0.3,       //   where the folds fall along the body (set by conc() so they balance)
  rw: 6,          // rectilinear: bunching waves per loop
  rLam: 2.4,      //   their wavelength along the body
  rDel: 0,        //   how much the skin bunches (set by rect())
  // ---- still poses: the body on the floor --------------------------------------------------
  sA: 0,          // loose S-curves (heading swing, radians)
  sL: 2.2,        //   their wavelength
  sP: 0,          //   their phase along the body
  fl0: 0,         // the curves of a still pose start this far down the body (a fixed point on it,
                  //   so lowering or raising the front never slides them along the body)
  curl: 0,        // the body bends evenly to one side (radians per unit)
  coil: 0,        // rolled into a flat spiral, tail at the centre, the head laid over the coils
  undA: 0,        // a travelling heading wave (swimming), growing toward the tail
  undH: 2,        //   waves per loop
  undK: 2.6,      //   radians per unit along the body (wavelength 2π / undK)
  pitchA: 0,      //   an up-and-down wave with it
  drift: 0,       // slow, loose 3D loops (weightless)
  scan: 0,        // the head and neck turn to look about
  scH: 1,         //   looks per loop
  neckUp: 0,      // the neck lifted off the floor (swimming, alert crawl)
  headUp: 0,      // the head pitched up (+) or down
  breathe: 0.008, // the head rises and falls with each breath
  tailW: 0.06,    // the tail tip stirs
  // ---- rearing -------------------------------------------------------------------------
  rear: 0,        // the front of the body rises (1 = a third of the body, vertical)
  lean: 0,        // the raised column leans back (+) or forward
  sCurve: 0,      // the raised neck bends in an S (photos 1, 3)
  idle: 0,        // never quite still: a slow drift of sway, head turn and breath
  sway: 0,        // it sways from side to side
  swH: 2,         //   sways per loop
  turn: 0,        // the raised part turns to follow
  strike: 0,      // draws back and lunges forward and down
  sk: 1,          //   strikes per loop
  bite: 1,        //   the mouth opens on the lunge (0 = a closed-mouth bluff)
  // ---- head ----------------------------------------------------------------------------
  hood: 0,        // hood spread (0 closed, 1 full)
  gape: 0,        // jaw held open (radians)
  tf: 3,          // tongue flicks per loop
  tA: 1,          // tongue activity (0 = keeps it in)
  tOsc: 64,       // tongue oscillations per loop while it is out (64 = 8 Hz)
};

export const GROUPS = ['resting', 'getting around', 'display', 'striking', 'swimming'];

// ---- Gait helpers: keep each gait's distance, track and ground slide in step -----------------
const und = (trav, waves, s) => ({ loco: 1, trav, lam: trav * TILE / waves, ...s });
const fig8 = (trav, laps, waves, s) => ({ loco: 1, round: 1, fig: 1, trav, Lf: trav * TILE / laps, lam: trav * TILE / laps / waves, ...s });
const circ = (trav, waves, s) => ({ loco: 1, round: 1, trav, Rc: trav * TILE / TAU, lam: trav * TILE / waves, ...s });
// Concertina fold profile, shared by pose() and conc(): w(s) ∈ [0,1], and how much of segment s
// belongs to the reaching front (mF).
const foldArg = (s, K) => TAU * s / K.cLam + K.cPh;
const foldW = (s, K) => { const a = Math.sin(foldArg(s, K)); return a * a * ss(0.25, 0.6, s) * (1 - ss(4.3, 4.75, s)); };
const frontM = (s, cF) => 1 - ss(cF - 0.4, cF + 0.4, s);
// Every segment's fold (cos, sin of its angle off the line of travel) for front fold share fe and
// rear fold share re; returns the summed (along, across) length. Fills FC/FS when asked.
function folds(K, fe, re, fill) {
  let P = 0, Q = 0;
  for (let j = 0; j < NSEG; j++) {
    const s = (j + 0.5) * L, mF = frontM(s, K.cF), sg = Math.sin(foldArg(s, K)) < 0 ? -1 : 1;
    const c = cl(1 - K.cDel * (mF * fe + (1 - mF) * re) * foldW(s, K), -0.99, 1), sn = sg * Math.sqrt(1 - c * c);
    if (fill) { FC[j] = c; FS[j] = sn; }
    P += L * c; Q += L * sn;
  }
  return [P, Q];
}
// Concertina keys: fold depth so each cycle covers trav·TILE/cyc, and the fold phase that makes
// the reaching front's folds balance (else it would crab sideways a little every cycle).
function conc(trav, cyc, s) {
  const K = { ...DEFAULT, ...s }, depth = () => {
    let W = 0; for (let j = 0; j < NSEG; j++) { const sm = (j + 0.5) * L; W += frontM(sm, K.cF) * foldW(sm, K); }
    K.cDel = trav * TILE / cyc / (L * W);
  };
  const drift = ph => { K.cPh = ph; depth(); return folds(K, 0, 1)[1] - folds(K, 1, 1)[1]; };
  let best = 0, bd = Infinity;
  for (let i = 0; i < 720; i++) { const ph = TAU * i / 720, d = Math.abs(drift(ph)); if (d < bd) { bd = d; best = ph; } }
  let a = best - TAU / 720, b = best + TAU / 720;               // refine: golden-section on |drift|
  for (let i = 0; i < 40; i++) { const m1 = a + (b - a) * 0.382, m2 = a + (b - a) * 0.618; if (Math.abs(drift(m1)) < Math.abs(drift(m2))) b = m2; else a = m1; }
  drift((a + b) / 2);
  return { loco: 1, cnc: 1, trav, cyc, ...s, cDel: K.cDel, cPh: K.cPh };
}
// Rectilinear bunching profile along one wave (u in wavelengths): flat-topped, so bunched skin
// holds still for a while; RC is its running integral of (1 − w), for the head's stop-go.
const rw_ = u => { const s = Math.sin(Math.PI * u); return ss(0.15, 0.6, s * s); };
const RCN = 2048, RC = new Float64Array(RCN + 1);
for (let i = 1; i <= RCN; i++) RC[i] = RC[i - 1] + (2 - rw_((i - 1) / RCN) - rw_(i / RCN)) / (2 * RCN);
const rcAt = f => { const x = f * RCN, i = Math.min(RCN - 1, Math.floor(x)); return RC[i] + (RC[i + 1] - RC[i]) * (x - i); };
const rect = (trav, rw, s) => ({ loco: 1, rec: 1, trav, rw, rDel: trav * TILE / (rw * (s.rLam ?? DEFAULT.rLam) * RC[RCN]), ...s });

export const SEGMENTS = [
  { name: 'Coil',     group: 'resting',        desc: 'rolled up in a flat spiral, the head laid over the coils, breathing, now and then tasting the air',
    s: { coil: 1, yaw: 0.6, tf: 2, tA: 1, breathe: 0.012, tailW: 0.03 } },
  { name: 'Bask',     group: 'resting',        desc: 'stretched out in loose curves, still, the tongue flicking',
    s: { sA: 0.55, sL: 2.3, sP: 0.6, yaw: 0.1, tf: 2, tailW: 0.08 } },
  { name: 'Slither',  group: 'getting around', desc: 'lateral undulation round a figure of eight: every point of the body follows the S-track the head lays down',
    s: fig8(14, 1, 6, { amp: 0.3, tf: 3, tA: 0.8 }) },
  { name: 'Circle',   group: 'getting around', desc: 'slithers round a circle, the ground still',
    s: circ(12, 5, { amp: 0.24, tf: 2 }) },
  { name: 'Hurry',    group: 'getting around', desc: 'fast: twice round the figure of eight, head low, tongue in',
    s: fig8(28, 2, 7, { amp: 0.38, hLift: 0.015, tA: 0 }) },
  { name: 'Concertina', group: 'getting around', desc: 'the rear grips in folds while the front reaches forward; then the front grips and hauls the rear up',
    s: conc(3, 3, { cLam: 1.0, cF: 2.2, tf: 2 }) },
  { name: 'Creep',    group: 'getting around', desc: 'rectilinear: straight as a rod, waves of bunched belly skin run down it and it inches forward',
    s: rect(1, 6, { rLam: 2.4, hLift: 0.012, tf: 1 }) },
  { name: 'Alert',    group: 'display',        desc: 'neck lifted, hood half open, looking about, tasting the air quickly',
    s: { rear: 0.35, hood: 0.35, scan: 0.45, scH: 2, curl: 0.25, sA: 0.3, sL: 2.6, fl0: 0.42, tf: 5, yaw: -0.7 } },
  { name: 'Hood',     group: 'display',        desc: 'rears a third of its length, hood fully spread, still and watching',
    s: { rear: 1, hood: 1, curl: 0.9, sA: 0.5, sL: 2.6, fl0: 1.2, sCurve: 0.3, idle: 1, lean: 0.1, tf: 2, yaw: -1.0, breathe: 0.01 } },
  { name: 'Sway',     group: 'display',        desc: 'the raised hood sways slowly from side to side, the head held level',
    s: { rear: 1, hood: 1, curl: 0.9, sA: 0.5, sL: 2.6, fl0: 1.2, sCurve: 0.3, idle: 1, lean: 0.1, sway: 0.22, swH: 2, turn: 0.15, tf: 2, yaw: -1.0 } },
  { name: 'Hiss',     group: 'display',        desc: 'rises higher and leans back, mouth open, hood pulsing',
    s: { rear: 1.15, hood: 1, curl: 0.9, sA: 0.5, sL: 2.6, fl0: 1.2, sCurve: 0.25, idle: 1, lean: 0.2, gape: 0.32, tA: 0, yaw: -1.0 } },
  { name: 'Strike',   group: 'striking',       desc: 'a long wind-up, leaning back into a tight S, then an explosive lunge forward at head height, mouth open, and recovers',
    s: { rear: 1, hood: 1, curl: 0.9, sA: 0.5, sL: 2.6, fl0: 1.2, sCurve: 0.3, idle: 1, lean: 0.1, strike: 1, sk: 1, bite: 1, tA: 0, yaw: -1.0 } },
  { name: 'Bluff',    group: 'striking',       desc: 'two quick closed-mouth strikes: a warning, not a bite',
    s: { rear: 1, hood: 1, curl: 0.9, sA: 0.5, sL: 2.6, fl0: 1.2, sCurve: 0.3, idle: 1, lean: 0.1, strike: 0.6, sk: 2, bite: 0, tA: 0, yaw: -1.0 } },
  { name: 'Swim',     group: 'swimming',       desc: 'weightless: swims round a circle, big waves down the body, head held up; every point follows the head',
    s: circ(12, 4, { grav: 0, amp: 0.5, hLift: 0.14, tf: 2 }) },
  { name: 'Drift',    group: 'swimming',       desc: 'weightless and still: the body drifts in slow loose loops',
    s: { grav: 0, drift: 1, undA: 0.15, undH: 1, undK: 1.3, neckUp: 0.2, yaw: -0.3, tf: 1, tailW: 0.15 } },
];

// ---- Scratch (pose() runs every frame) -----------------------------------------------------
const NJ = NSEG + 1;
const PX = new Float64Array(NJ), PY = new Float64Array(NJ), PZ = new Float64Array(NJ);   // target joints
const AX = new Float64Array(NJ), AY = new Float64Array(NJ), AZ = new Float64Array(NJ);   // a gait's joints
const BL = new Float64Array(NSEG);
const D = Array.from({ length: NSEG }, () => [0, 0, 0]);    // segment directions, head → tail
const N = Array.from({ length: NSEG }, () => [0, 0, 0]);    // segment backs (dorsal)
const J = Array.from({ length: NJ }, () => [0, 0, 0]);      // the joints as the chains will place them
const FC = new Float64Array(NSEG), FS = new Float64Array(NSEG), PSI = new Float64Array(NSEG), CHI = new Float64Array(NSEG);
const X_OFF = 2.2;
const WJ = Array.from({ length: NJ }, () => [0, 0, 0]);    // the joints as placed in the world, last pose()
const WBL = new Float64Array(NSEG);                         // …their segment lengths
let WGA = 0, TGA = 0;                                       // …the ground's slide angle; a transition's own                                          // a straight gait: the head this far ahead of centre
const T0 = [0, 0], T1 = [0, 0];

const { mul, mv, ry: RY, rz: RZ } = M3;
const tr = A => [A[0], A[3], A[6], A[1], A[4], A[7], A[2], A[5], A[8]];
const QREAR = mul(RY(-Math.PI), RZ(Math.PI / 2)), QFRONT = RZ(Math.PI / 2);
// three.js Euler XYZ from a rotation matrix (row-major), into chain C at bone i.
function euler(m, C, i) {
  const m13 = cl(m[2], -1, 1);
  C.by[i] = Math.asin(m13);
  if (Math.abs(m13) < 0.9999999) { C.bx[i] = Math.atan2(-m[5], m[8]); C.bz[i] = Math.atan2(-m[1], m[0]); }
  else { C.bx[i] = Math.atan2(m[7], m[4]); C.bz[i] = 0; }
}
const norm = v => { const l = Math.hypot(v[0], v[1], v[2]) || 1; v[0] /= l; v[1] /= l; v[2] /= l; return v; };
const wrap = x => x - TAU * Math.round(x / TAU);
// A narrow periodic bump at phase p0: quick to rise (ra), slower to fall (fa), seamless.
const bump = (ph, p0, ra, fa) => { const d = wrap(ph - p0), w = d < 0 ? ra : fa; return Math.exp(-(d * d) / (w * w)); };

// The S-track of lateral undulation at track coordinate q (ground frame slid back by `shift`):
// straight ahead along +x, or round a circle of radius Rc about the origin.
// …or round a figure of eight (x = sin t, z = B8 sin 2t, scaled to length Lf), wiggling about it.
const NT8 = 512, CUM8 = new Float64Array(NT8 + 1);
let fig8B = -1;
function fig8Table(B) {
  if (B === fig8B) return; fig8B = B;
  for (let i = 1; i <= NT8; i++) { const t = TAU * (i - 0.5) / NT8; CUM8[i] = CUM8[i - 1] + Math.hypot(Math.cos(t), 2 * B * Math.cos(2 * t)) * TAU / NT8; }
}
function fig8At(S, q, wig, out) {
  const Lf = S.Lf, f = (((q % Lf) + Lf) % Lf) / Lf * CUM8[NT8];
  let lo = 0, hi = NT8; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (CUM8[m] <= f) lo = m; else hi = m; }
  const t = TAU * (lo + (f - CUM8[lo]) / (CUM8[lo + 1] - CUM8[lo])) / NT8, k = Lf / CUM8[NT8];
  const tx = Math.cos(t), tz = 2 * S.B8 * Math.cos(2 * t), tl = Math.hypot(tx, tz);
  out[0] = k * Math.sin(t) - wig * tz / tl; out[1] = k * S.B8 * Math.sin(2 * t) + wig * tx / tl;
}
const F8 = [0, 0];
function trackPt(S, q, shift, out, amp = 1) {
  const wig = S.amp * amp * Math.sin(TAU * q / S.lam);
  const sx = q - shift + X_OFF, sz = wig;
  const a = q / S.Rc, r = S.Rc + wig, cx = r * Math.sin(a), cz = r * Math.cos(a);
  out[0] = sx + (cx - sx) * S.round; out[1] = sz + (cz - sz) * S.round;
  if (S.fig > 0) { fig8At(S, q, wig, F8); out[0] += (F8[0] - out[0]) * S.fig; out[1] += (F8[1] - out[1]) * S.fig; }
}

// pose(S, phase, P[, lay]): `lay` (transitions only) fills the target joints itself, at heights
// that are kept as they are.
export function pose(S, phase, P, lay) {
  const PI = Math.PI;
  const D_ = S.trav * TILE;                                 // ground covered per loop
  const tSeg = j => (j + 0.5) * L;

  // ======== 1. Where every joint should be ========================================================
  PX.fill(0); PY.fill(0); PZ.fill(0); BL.fill(1);
  if (lay) lay(); else {
  const wC = S.loco * S.cnc, wR = S.loco * S.rec, wU = S.loco * Math.max(0, 1 - S.cnc - S.rec), wS = 1 - S.loco;

  // ---- Lateral undulation: each joint on the head's track, one segment (chord) behind the last.
  if (wU > 0) {
    if (S.fig > 0) fig8Table(S.B8);
    const shift = D_ * phase / TAU * (1 - S.round);
    // Push-off: the head surges forward with each half-wave (each curve pushing on the ground), and
    // runs steadier than the body, the S growing to full size along the neck, so the neck visibly
    // pushes sideways as each wave forms (a perfectly even glide along a fixed curve read as sliding).
    const nW = Math.round(D_ / S.lam), amp = j => 1 - 0.65 * S.steady * (1 - ss(0, 0.9, j * L));
    let q = D_ * phase / TAU + S.surge * 0.02 * S.lam * Math.sin(2 * nW * phase);
    trackPt(S, q, shift, T0, amp(0));
    AX[0] = T0[0]; AZ[0] = T0[1];
    for (let j = 0; j < NSEG; j++) {
      let qn = q - L * 0.95;
      for (let it = 0; it < 4; it++) {                       // Newton on |T(qn) − T(q)| = L
        trackPt(S, qn, shift, T1, amp(j + 1)); const d0 = Math.hypot(T1[0] - AX[j], T1[1] - AZ[j]);
        trackPt(S, qn - 1e-4, shift, T1, amp(j + 1)); const d1 = Math.hypot(T1[0] - AX[j], T1[1] - AZ[j]);
        const g = (d1 - d0) / 1e-4; if (Math.abs(g) < 1e-6) break;
        qn += (d0 - L) / g;
      }
      trackPt(S, qn, shift, T1, amp(j + 1)); AX[j + 1] = T1[0]; AZ[j + 1] = T1[1]; q = qn;
    }
    for (let j = 0; j < NJ; j++) {
      const s = j * L, lift = S.hLift * (1 - ss(0.05, 0.6, s));
      PX[j] += wU * AX[j]; PY[j] += wU * lift; PZ[j] += wU * AZ[j];
    }
  }

  // ---- Concertina, on the ground: phase A (θ 0→π) the tail grips and the front unfolds forward;
  // phase B (θ π→2π) the head grips, the front folds again and the rear is hauled up. Each cycle
  // the whole body has moved Dc; the ground slides back by the same.
  if (wC > 0) {
    const th = S.cyc * phase, envF = 0.5 + 0.5 * Math.cos(th);
    const rB = Math.max(0, -Math.sin(th)), envR = 1 - S.cRel * rB * rB;
    const [P_, Q_] = folds(S, envF, envR, true);
    const [P0, Q0] = folds(S, 1, 1), [Ppi, Qpi] = folds(S, 0, 1);   // θ = 0 (all folded), θ = π (front straight)
    const Dc = Ppi - P0, n = Math.floor(th / TAU), thm = th - n * TAU;
    const A_ = thm <= PI;                                   // phase A: tail grips; B: head grips
    let Xh = n * Dc + (A_ ? P_ : Ppi) - P0;                 // head, ground frame (0 at the first cycle's start)
    let Zh = n * (Qpi - Q0) + (A_ ? Q_ : Qpi) - Q0;
    Xh -= Dc * th / TAU; Zh -= (Qpi - Q0) * th / TAU;       // slide the ground back: the body stays in view
    let x = Xh + X_OFF - 0.25, z = Zh;
    AX[0] = x; AZ[0] = z;
    for (let j = 0; j < NSEG; j++) { x -= L * FC[j]; z -= L * FS[j]; AX[j + 1] = x; AZ[j + 1] = z; }
    for (let j = 0; j < NJ; j++) {
      const s = j * L, lift = S.hLift * (1 - ss(0.05, 0.6, s));
      PX[j] += wC * AX[j]; PY[j] += wC * lift; PZ[j] += wC * AZ[j];
    }
  }

  // ---- Rectilinear: straight; segment j is E_j = 1 − rDel · w(…) long, the bunching running
  // tailward rw times a loop. Bunched skin grips, so a point moves only while its skin stretches:
  // the head has moved rDel · rLam · RC(waves passed so far); the ground slides back the average.
  if (wR > 0) {
    const xw = S.rw * phase / TAU, f = xw - Math.floor(xw);
    let x = X_OFF + S.rDel * S.rLam * (rcAt(f) - RC[RCN] * f);
    AX[0] = x;
    for (let j = 0; j < NSEG; j++) {
      const E = 1 - S.rDel * rw_(tSeg(j) / S.rLam - xw);
      BL[j] += wR * (E - 1); x -= L * E; AX[j + 1] = x;
    }
    for (let j = 0; j < NJ; j++) {
      const s = j * L, lift = S.hLift * (1 - ss(0.05, 0.6, s));
      PX[j] += wR * AX[j]; PY[j] += wR * lift;
    }
  }

  // ---- Still poses: a forward direction for every segment, integrated from the head ----------
  if (wS > 0) {
    const fx = Math.cos(S.yaw), fz = -Math.sin(S.yaw);      // facing
    // Strike: lean back (pre), then a fast lunge forward and down while the S straightens out
    // (that is the reach); a slower recovery.
    // Owner: more power, deeper anticipation, higher. A long, slow wind-up (leans far back, the S
    // coiling tighter, head tipping up) released straight into an explosive lunge that drives
    // forward at head height rather than down to the floor.
    const Bp = S.strike * bump(S.sk * phase, 3.45, 0.95, 0.16);
    const Bs = S.strike * bump(S.sk * phase, 4.1, 0.05, 0.55);
    const rearW = ss(0, 0.15, S.rear), R = 1.2 * S.rear;     // raised length (photo 7: ~0.8 high); fixed, so the
                                                             // body on the floor never slides along itself
    const chiV = PI / 2 * cl(0.35 + 0.65 * S.rear, 0, 1) + S.lean + 0.45 * Bp - 0.95 * Bs;
    const chiH = S.headUp - 0.12 * Bs + 0.14 * Bp + S.breathe * Math.sin(phase) + S.idle * 0.015 * Math.sin(phase);
    const lam = S.sway * Math.sin(S.swH * phase) + S.idle * 0.05 * Math.sin(phase + 0.7);
    // The column turns with the sway; the head does not, it keeps its gaze (it counter-turns on the
    // neck). Looking about (scan) turns the head itself, and the column with it.
    const nuCol = S.turn * Math.sin(S.swH * phase + 1.2) + S.idle * 0.1 * Math.sin(2 * phase + 1);
    const nuHead = S.scan * Math.sin(S.scH * phase);
    const sS = S.sCurve * (1 - Bs) * (1 + 1.3 * Bp + 0.2 * S.idle * Math.sin(phase)), sLen = Math.max(0.2, R - 0.3);
    // Floor heading, relative: curves begin at the base of the raised part.
    const coilR = u => Math.sqrt(0.12 * 0.12 + 0.18 * u / PI);   // turns 0.18 apart: the thicker body never overlaps
    let psiAcc = 0;
    for (let j = 0; j < NSEG; j++) {
      const s = tSeg(j), u = Math.max(0, s - S.fl0);         // distance behind where the curves start
      // curvature terms (accumulate), then heading terms (add)
      let k = S.curl * (1 - 0.55 * ss(3.7, 4.7, s))                                   // the tail runs out of the curve
        - S.coil * (1 / coilR(SPINE.length - s) + 2.6 * (1 - ss(0.25, 0.75, s)));     // spiral; the head turns in over the coils
      k += S.drift * 0.9 * Math.sin(phase) * Math.sin(1.3 * s + 0.5);   // flexes in place (a travelling wave slid the body through its own shape)
      psiAcc += k * L * ss(S.fl0 - 0.06, S.fl0 + 0.06, s);   // (soft: a hard cut stepped as fl0 moved in a blend)
      let psi = psiAcc + S.sA * Math.sin(TAU * u / S.sL + S.sP) * ss(0, 0.6, u)
        + S.undA * (0.3 + 0.7 * s / SPINE.length) * Math.sin(S.undH * phase - S.undK * s)
        + S.scan * (1 - rearW) * Math.sin(S.scH * phase) * (1 - ss(0.1, 0.9, s))
        + S.tailW * Math.sin(phase * 2 - 3 * s) * ss(4.1, 4.8, s);
      PSI[j] = psi;
      CHI[j] = S.neckUp * ss(0.05, 0.25, s) * (1 - ss(0.5, 1.0, s)) + (s < 0.1 ? chiH : 0)
        + S.coil * 0.4 * ss(0.15, 0.3, s) * (1 - ss(0.55, 0.8, s))       // climbs up onto the coils (clear of them)
        + S.pitchA * Math.sin(S.undH * phase - S.undK * s + PI / 2)
        + S.drift * 0.5 * Math.sin(phase + 1) * Math.sin(1.1 * s);
    }
    let x = 0, y = 0, z = 0;
    AX[0] = 0; AY[0] = 0; AZ[0] = 0;
    for (let j = 0; j < NSEG; j++) {
      const s = tSeg(j);
      // floor direction
      const ps = S.yaw + PSI[j], cc = Math.cos(CHI[j]);
      let Fx = Math.cos(ps) * cc, Fy = Math.sin(CHI[j]), Fz = -Math.sin(ps) * cc;
      // raised direction: up the column, bent over at the neck into a level head
      const mr = rearW * (1 - ss(R - 0.28, R + 0.05, s));
      if (mr > 0) {
        const nb = ss(0.06, 0.32, s);
        const chi = chiH + (chiV - chiH) * nb                                        // up the column, level head
          + sS * Math.sin(TAU * (s - 0.3) / sLen) * ss(0.25, 0.35, s) * (1 - ss(R - 0.15, R, s));   // the S
        let rx = Math.cos(chi) * fx, ryy = Math.sin(chi), rz = Math.cos(chi) * fz;
        // sway: lean the column about the facing axis (not the head)
        const l = lam * ss(0.1, 0.3, s) * (1 - ss(R - 0.3, R, s) * 0.6);
        if (l) { const c = Math.cos(l), sn = Math.sin(l);
          // rotate about f: up → side (side = f × up = (−fz·1… ) in xz-plane: (fz, 0, −fx)·−1)
          const sx = -fz, sz = fx;                               // side vector (left of facing)
          const along = rx * fx + rz * fz, side = rx * sx + rz * sz, up = ryy;
          const side2 = side * c - up * sn, up2 = side * sn + up * c;
          rx = along * fx + side2 * sx; rz = along * fz + side2 * sz; ryy = up2; }
        const tn = (nuCol * ss(0.08, 0.25, s) + nuHead) * (1 - ss(R - 0.4, R, s));   // turn the raised part about the vertical
        if (tn) { const c = Math.cos(tn), sn = Math.sin(tn), x0 = rx; rx = c * x0 + sn * rz; rz = -sn * x0 + c * rz; }
        Fx += (rx - Fx) * mr; Fy += (ryy - Fy) * mr; Fz += (rz - Fz) * mr;
      }
      const fl = Math.hypot(Fx, Fy, Fz) || 1;
      x -= L * Fx / fl; y -= L * Fy / fl; z -= L * Fz / fl;
      AX[j + 1] = x; AY[j + 1] = y; AZ[j + 1] = z;
    }
    // Place the still pose by the part lying on the floor, not by the whole body: that part keeps
    // its shape while the raised part sways or strikes, so it stays put (centring on the whole body
    // slid it about as the head moved; the owner saw it slide through itself).
    const s0 = Math.max(S.fl0, 0.6) + 0.2;
    let mx = 0, mz = 0, nm = 0;                              // (joints fade in and out of it: a hard cut stepped)
    for (let j = 0; j < NJ; j++) { const s = j * L, w = ss(s0 - 0.15, s0 + 0.15, s) * (1 - ss(4.15, 4.45, s)); mx += w * AX[j]; mz += w * AZ[j]; nm += w; }
    mx /= nm; mz /= nm;
    for (let j = 0; j < NJ; j++) { PX[j] += wS * (AX[j] - mx); PY[j] += wS * AY[j]; PZ[j] += wS * (AZ[j] - mz); }
  }
  }

  // ======== 2. Segment directions, and the joints as the two chains will lay them out ===========
  for (let j = 0; j < NSEG; j++) {
    const d = D[j]; d[0] = PX[j + 1] - PX[j]; d[1] = PY[j + 1] - PY[j]; d[2] = PZ[j + 1] - PZ[j];
    if (Math.hypot(d[0], d[1], d[2]) < 1e-9) { const e = D[Math.max(0, j - 1)]; d[0] = e[0] || -1; d[1] = e[1]; d[2] = e[2]; }
    norm(d);
  }
  J[MID][0] = PX[MID]; J[MID][1] = PY[MID]; J[MID][2] = PZ[MID];
  for (let j = MID; j < NSEG; j++) for (let c = 0; c < 3; c++) J[j + 1][c] = J[j][c] + L * BL[j] * D[j][c];
  for (let j = MID - 1; j >= 0; j--) for (let c = 0; c < 3; c++) J[j][c] = J[j + 1][c] - L * BL[j] * D[j][c];

  // ======== 3. Each segment's back: up on the floor, carried smoothly round bends ===============
  // Start at the middle (on the floor), carry the back along both ways (minimal twist), pulling
  // it toward world-up wherever the segment lies flat. On the raised column the pull vanishes, so
  // the back stays in the plane of the bend: the belly faces where the cobra faces.
  const proj = (n, d) => { const k = n[0] * d[0] + n[1] * d[1] + n[2] * d[2]; n[0] -= k * d[0]; n[1] -= k * d[1]; n[2] -= k * d[2]; return norm(n); };
  const carry = (from, j) => {
    const d = D[j], k = 0.3 * Math.pow(1 - d[1] * d[1], 2), n = N[j];
    n[0] = from[0]; n[1] = from[1] + k; n[2] = from[2]; proj(n, d);
  };
  { const n = N[MID]; n[0] = 0; n[1] = 1; n[2] = 0; proj(n, D[MID]); }
  for (let j = MID + 1; j < NSEG; j++) carry(N[j - 1], j);
  for (let j = MID - 1; j >= 0; j--) carry(N[j + 1], j);

  // ======== 4. Bone turns ======================================================================
  // Heading of the whole body = the middle segment's (it always lies on the floor or level).
  const fmx = -D[MID][0], fmz = -D[MID][2];
  const psi = Math.atan2(-fmz, fmx);
  const RT = tr(RY(psi));
  const frame = (j, front) => {                             // bone frame: x back, y along (−y = where the bone runs)
    const n = N[j], d = D[j], y = front ? d : [-d[0], -d[1], -d[2]];
    const z = [n[1] * y[2] - n[2] * y[1], n[2] * y[0] - n[0] * y[2], n[0] * y[1] - n[1] * y[0]];
    return [n[0], y[0], z[0], n[1], y[1], z[1], n[2], y[2], z[2]];
  };
  const CF = P.chains[FRONT], CR = P.chains[REAR];
  for (const [C, front, nb] of [[CF, true, MID], [CR, false, NSEG - MID]]) {
    C.a = front ? 0 : PI; C.rad = 0; C.y = 0; C.tilt = PI / 2; C.len = 1;
    let prev = null;
    for (let i = 0; i < nb; i++) {
      const j = front ? MID - 1 - i : MID + i, B = frame(j, front);
      euler(prev ? mul(tr(prev), B) : mul(tr(front ? QFRONT : QREAR), mul(RT, B)), C, i);
      C.bl[i] = BL[j];
      prev = B;
    }
  }

  // ======== 5. Weight: lowest belly point on the floor (or floating) ===========================
  let minY = Infinity, cy = 0;
  for (let j = 0; j < NJ; j++) {
    const a = N[Math.min(NSEG - 1, j)], b = N[Math.max(0, j - 1)], s = j * L, h = SHAPE.hv(s);
    const ny = (a[1] + b[1]) / 2, y = J[j][1] - ny * h;
    minY = Math.min(minY, y); cy += J[j][1];
  }
  { const d = D[0], n = N[0], y = J[0][1] - d[1] * 0.07 - n[1] * 0.022; minY = Math.min(minY, y); }   // under the chin
  cy /= NJ;
  P.root.x = J[MID][0]; P.root.z = J[MID][2];
  P.root.y = lay ? J[MID][1] : J[MID][1] + S.grav * (S.height - minY) + (1 - S.grav) * (S.floatH - cy);
  for (let j = 0; j < NJ; j++) { WJ[j][0] = J[j][0]; WJ[j][1] = J[j][1] + P.root.y - J[MID][1]; WJ[j][2] = J[j][2]; }
  WBL.set(BL);
  P.root.rx = 0; P.root.ry = psi; P.root.rz = 0;
  P.parts.floor = S.grav;
  // How far the ground has slid, as an angle (one TILE = 2π), stored as cos/sin so it loops.
  const ga = lay ? TGA : S.trav * phase * (1 - S.round);
  WGA = ga;
  P.parts.gc = Math.cos(ga); P.parts.gs = Math.sin(ga);

  // ======== 6. Head: jaw, tongue, hood ==========================================================
  const Bs = S.strike * bump(S.sk * phase, 4.12, 0.06, 0.4);
  {
    const C = P.chains[JAW];
    C.a = PI; C.rad = 0.02; C.y = -0.025; C.tilt = 0; C.len = 1;
    C.bz[0] = S.gape * (1 + 0.15 * Math.sin(3 * phase)) + 0.85 * S.bite * Bs; C.bx[0] = 0;
  }
  {
    // Flicks: out fast, waves up and down several times, back in.
    const e = S.tA * ss(0.72, 0.88, Math.cos(S.tf * phase - 1.0)), C = P.chains[TONGUE];
    C.a = PI; C.rad = 0.016; C.y = -0.11; C.len = 0.22 + 0.78 * e;
    C.tilt = 0.12 + 0.18 * e * Math.sin(3 * S.tf * phase - 1);
    for (let i = 0; i < C.bz.length; i++) { C.bz[i] = e * 0.3 * Math.sin(S.tOsc * phase - 0.9 * i); C.bx[i] = 0; }
    for (let t = 0; t < 2; t++) {
      const F = P.chains[FORK0 + t];
      F.a = t ? -PI / 2 : PI / 2; F.rad = 0; F.y = 0; F.len = 0.22 + 0.78 * e;
      F.tilt = 0.1 + 0.32 * e;
      for (let i = 0; i < F.bz.length; i++) { F.bz[i] = 0.05 * e * Math.sin(S.tOsc * phase - 1.2 * i + t * PI); F.bx[i] = 0; }
    }
  }
  {
    const pulse = 1 + 0.06 * Math.sin(3 * phase) * S.gape / 0.32;   // a hissing hood swells with each breath
    (P.parts.uniforms ??= {}).uHood = S.hood * pulse;              // the skin shader opens the gaps between hood scales
    for (let k = 0; k < HOOD.ribs; k++) {
      const s = RIB_S[k], u = (s - HOOD.s0) / (HOOD.s1 - HOOD.s0), w = SHAPE.w(s), h = S.hood * SHAPE.hs(u) * pulse;
      for (let t = 0; t < 2; t++) {
        const C = P.chains[RIB0 + 2 * k + t], sg = t ? -1 : 1;
        C.a = sg * PI / 2; C.rad = 0; C.y = 0; C.tilt = PI / 2; C.len = 1;
        C.bl[0] = 1 + h * (HOOD.max - w + HOOD.inset) / HOOD.ribL;   // the flap's edge reaches the outline
        C.bx[0] = -sg * 0.55 * h;                                     // cupped forward round the head
        C.bz[0] = -0.45 * h * Math.max(0, 1 - k / 3);                  // the top ribs sweep toward the head: shoulders beside it
      }
    }
  }
  return P;
}

// ---- Transitions: crawl into the next pose ---------------------------------------------------
// The page blends two segments' keys over one loop; blending keys moves every point of the body in
// a straight line to its new place, so the body glided sideways across the floor (owner: "slides
// between segments"). Instead, with both ends known (creature.html calls this while a transition
// runs; x is the linear progress 0..1 over one loop):
//   1. a raised cobra first lowers itself in place (only the raised part moves);
//   2. it crawls: the head leaves the old pose and travels along a smooth connecting curve to where
//      the next pose's tail lies, then along that pose from tail to head; every point of the body
//      follows the head's path, so nothing slides sideways;
//   3. if the next pose is raised, it rears up in place.
// Two poses that already lie in the same place (Hood, Sway, Hiss, Strike, Bluff) just blend: only
// the raised part moves.
const TP = makePose({ CHAINS });
const WJT = Float64Array.from({ length: NJ }, (_, j) => SHAPE.w(j * L));   // body half-width at each joint (the route scoring asked tens of thousands of times)
const JA = Array.from({ length: NJ }, () => [0, 0, 0]), JB = Array.from({ length: NJ }, () => [0, 0, 0]);
const PATH = [], CUMP = [];
const lowered = S => ({ ...S, rear: 0, lean: 0, sCurve: 0, strike: 0, sway: 0, turn: 0 });
// Continuous keys blend; whole numbers (tongue rhythm, gait counts) come from A until `half` ≥ 1.
const lerpS = (A, B, e, half) => { const o = {}; for (const k in DEFAULT) o[k] = INT_KEYS.includes(k) ? (half < 1 ? A : B)[k] : A[k] + (B[k] - A[k]) * e; return o; };
const ease = x => x * x * (3 - 2 * x);
const ABL = new Float64Array(NSEG), BBL = new Float64Array(NSEG);
const grab = (dst, dbl) => { for (let j = 0; j < NJ; j++) { dst[j][0] = WJ[j][0]; dst[j][1] = WJ[j][1]; dst[j][2] = WJ[j][2]; } dbl.set(WBL); return WGA; };
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

// ---- Dubins paths (LaValle, Planning Algorithms §15.3): shortest ground path from (p0, heading
// h0) to (p1, h1) with turns of radius r; CSC shapes only. Returns sampled [x, z] points, or null.
const DUB = ['LSL', 'RSR', 'LSR', 'RSL'];
const mod2 = a => ((a % TAU) + TAU) % TAU;
function dubins(p0, h0, p1, h1, r, type, ds = 0.04) {
  const dx = p1[0] - p0[0], dz = p1[2] - p0[2], d = Math.hypot(dx, dz) / r, th = Math.atan2(dz, dx);
  const a = mod2(h0 - th), b = mod2(h1 - th), sa = Math.sin(a), sb = Math.sin(b), ca = Math.cos(a), cb = Math.cos(b), cab = Math.cos(a - b);
  let t, p, q;
  if (type === 'LSL') { const p2 = 2 + d * d - 2 * cab + 2 * d * (sa - sb); if (p2 < 0) return null; const tmp = Math.atan2(cb - ca, d + sa - sb); t = mod2(-a + tmp); p = Math.sqrt(p2); q = mod2(b - tmp); }
  else if (type === 'RSR') { const p2 = 2 + d * d - 2 * cab + 2 * d * (sb - sa); if (p2 < 0) return null; const tmp = Math.atan2(ca - cb, d - sa + sb); t = mod2(a - tmp); p = Math.sqrt(p2); q = mod2(-b + tmp); }
  else if (type === 'LSR') { const p2 = -2 + d * d + 2 * cab + 2 * d * (sa + sb); if (p2 < 0) return null; p = Math.sqrt(p2); const tmp = Math.atan2(-ca - cb, d + sa + sb) - Math.atan2(-2, p); t = mod2(-a + tmp); q = mod2(-mod2(b) + tmp); }
  else { const p2 = -2 + d * d + 2 * cab - 2 * d * (sa + sb); if (p2 < 0) return null; p = Math.sqrt(p2); const tmp = Math.atan2(ca + cb, d - sa - sb) - Math.atan2(2, p); t = mod2(a - tmp); q = mod2(b - tmp); }
  // walk it: turn t, straight p, turn q (lengths in units of r), sampled every ~0.04
  const out = [[p0[0], p0[2]]]; let x = p0[0], z = p0[2], h = h0;
  const step = (kind, len) => {
    const n = Math.max(1, Math.ceil(len * r / ds));
    for (let i = 0; i < n; i++) {
      const ds = len * r / n;
      if (kind === 'S') { x += Math.cos(h) * ds; z += Math.sin(h) * ds; }
      else { const sg = kind === 'L' ? 1 : -1, dh = sg * ds / r, cx = x - sg * r * Math.sin(h), cz = z + sg * r * Math.cos(h);
        h += dh; x = cx + sg * r * Math.sin(h); z = cz - sg * r * Math.cos(h); }
      out.push([x, z]);
    }
  };
  step(type[0], t); step('S', p); step(type[2], q);
  if (Math.hypot(x - p1[0], z - p1[2]) > 1e-3 * Math.max(1, r)) return null;   // (a wrong-way shape for this case)
  return out;
}
let PLAN = null;
export function transition(A, B, x, phase, P) {
  x = cl(x, 0, 1);
  const ph0 = mod2(phase - TAU * x);                          // where the transition began
  if (!PLAN || PLAN.A !== A || PLAN.B !== B || Math.abs(wrap(PLAN.ph0 - ph0)) > 1e-6) PLAN = plan(A, B, ph0);
  // Whole-number keys switch where the loop wraps round (phase 0: every whole-number rhythm is
  // in step there), as the page does; a switch mid-loop made the body jump.
  const xs = ph0 < 1e-9 ? 1 : (TAU - ph0) / TAU, sw = x >= xs - 1e-12 ? 1 : 0;
  if (PLAN.blend) return pose(lerpS(A, B, ease(x), sw), phase, P);
  const { xa, xb, As, Bs, gA, gB, LA, Lt, m0, m1, path, cum, ABL: ABLp, BBL: BBLp } = PLAN;
  if (x < xa) return pose(lerpS(A, As, ease(x / xa), 0), phase, P);                 // lower the hood
  if (x > xb) return pose(lerpS(Bs, B, ease((x - xb) / (1 - xb)), 1), phase, P);   // rear up
  const y = (x - xa) / (xb - xa), y2 = y * y, y3 = y2 * y, e = ease(y);
  const g = (y3 - 2 * y2 + y) * m0 + (-2 * y3 + 3 * y2) + (y3 - y2) * m1;
  const sh = LA + Lt * g;
  // Each point a whole body-length behind the head along the path; on the old body at the start
  // and the new one at the end it sits exactly where that pose put it (the path IS those bodies).
  const pt = (sg, out) => {
    sg = cl(sg, 0, cum[cum.length - 1]);
    let lo = 0, hi = cum.length - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (cum[m] <= sg) lo = m; else hi = m; }
    const f = (sg - cum[lo]) / Math.max(1e-12, cum[hi] - cum[lo]), a = path[lo], b = path[hi];
    out[0] = a[0] + (b[0] - a[0]) * f; out[1] = a[1] + (b[1] - a[1]) * f; out[2] = a[2] + (b[2] - a[2]) * f;
  };
  // The joints lie at the path's own points while on either body (exact), by arclength between.
  const q = [0, 0, 0], cumA = j => cum[NSEG - j], cumB = j => cum[cum.length - 1 - j];
  // ground slide: from where A had it to where B will have it
  TGA = gA + wrap(gB - gA) * e;
  return pose(lerpS(As, Bs, e, sw), phase, P, () => {
    for (let j = 0; j < NSEG; j++) BL[j] = ABLp[j] + (BBLp[j] - ABLp[j]) * e;
    // Head on the path; each next joint the segment's straight length behind the last, also on
    // the path (so the chain lays exactly onto it, even round tight folds). On the old body at the
    // start and on the new one at the end these are those bodies' own joints.
    let sg = sh; pt(sg, q); PX[0] = q[0]; PY[0] = q[1]; PZ[0] = q[2];
    let i = 0; { let lo = 0, hi = cum.length - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (cum[m] <= sg) lo = m; else hi = m; } i = lo; }
    for (let j = 1; j < NJ; j++) {
      // walk back edge by edge from the last joint; the first point exactly c away (where the path
      // leaves the sphere round that joint) is the next joint
      const c = L * BL[j - 1], P0 = [PX[j - 1], PY[j - 1], PZ[j - 1]];
      let a = P0, sa = sg, found = false;
      for (; i >= 0 && !found; i--) {
        const b = path[i], sb = cum[i], e_ = sub(b, a), f_ = sub(a, P0);
        const A2 = e_[0] * e_[0] + e_[1] * e_[1] + e_[2] * e_[2];
        if (A2 > 1e-18) {
          const B2 = 2 * (e_[0] * f_[0] + e_[1] * f_[1] + e_[2] * f_[2]), C2 = f_[0] * f_[0] + f_[1] * f_[1] + f_[2] * f_[2] - c * c;
          const D2 = B2 * B2 - 4 * A2 * C2;
          if (D2 >= 0) {
            const t = (-B2 + Math.sqrt(D2)) / (2 * A2);
            if (t >= 0 && t <= 1 + 1e-12) { const tt = Math.min(1, t); q[0] = a[0] + e_[0] * tt; q[1] = a[1] + e_[1] * tt; q[2] = a[2] + e_[2] * tt; sg = sa - (sa - sb) * tt; found = true; break; }
          }
        }
        a = b; sa = sb;
      }
      if (!found) { pt(0, q); sg = 0; i = 0; }
      PX[j] = q[0]; PY[j] = q[1]; PZ[j] = q[2];
    }
  });
}

// Everything that depends only on the two ends (both poses, the route, the path) is worked out once
// per transition and kept: the page passes the same from/target objects every frame (it cost
// 11–22 ms a frame recomputed).
function plan(A, B, ph0) {
  const xa = A.rear > 0.05 ? 0.22 : 0, xb = B.rear > 0.05 ? 0.78 : 1;
  const As = xa ? lowered(A) : A, Bs = xb < 1 ? lowered(B) : B;   // the crawl runs between these
  const gA = (pose(As, ph0 + TAU * xa, TP), grab(JA, ABL));       // …where the lowering ends
  const gB = (pose(Bs, ph0 + TAU * xb, TP), grab(JB, BBL));       // …where the rearing begins
  let far = 0; for (let j = 0; j < NJ; j++) far += Math.hypot(...sub(JA[j], JB[j])) / NJ;   // how far the body moves, on average
  // Blend instead of crawling where a snake would not crawl either: two poses that mostly lie in the
  // same place (it rearranges itself there; a crawl would have to go round a lap to re-lay itself),
  // curling up into a coil (it curls where it lies), one gait in place to another (concertina
  // straightening out), and settling from weightless (nothing to grip).
  const inPlace = S => S.loco > 0.5 && S.round < 0.5;
  if (far < 0.6 || B.coil > 0.5 || (inPlace(A) && inPlace(B)) || (A.grav < 0.5 && A.loco < 0.5))
    return { A, B, ph0, blend: true };
  // The path: the old body tail → head, a connector, the new body tail → head.
  PATH.length = 0;
  for (let j = NSEG; j >= 0; j--) PATH.push(JA[j]);
  // Connector: a Dubins path on the ground (turn, straight, turn, never tighter than radius r)
  // from the old head to the new tail: a snake cannot hairpin, and a hairpin made the following
  // body cut across it. Of the four turn-straight-turn shapes at a few radii, the one that runs
  // least over the old body (still lying there until the head is a body-length on) and over its
  // own trailing body (while the head lays down the new pose) wins; then shortest.
  const p0 = JA[0], p1 = JB[NSEG], t0 = norm(sub(JA[0], JA[1])), t1 = norm(sub(JB[NSEG - 1], JB[NSEG]));
  let best = null;
  for (const r of [0.3, 0.55, 0.9]) for (const type of DUB) {
    const pts = dubins(p0, Math.atan2(t0[2], t0[0]), p1, Math.atan2(t1[2], t1[0]), r, type, 0.12);   // coarse, to score
    if (!pts) continue;
    let len = 0, cost = 0; const n = pts.length, cum = [0];
    for (let i = 1; i < n; i++) { const ex = pts[i][0] - pts[i - 1][0], ez = pts[i][1] - pts[i - 1][1]; cum.push(cum[i - 1] + Math.sqrt(ex * ex + ez * ez)); }
    len = cum[n - 1];
    for (let i = 0; i < n; i++) {                                                 // scored every ~12 cm, every other joint
      const [x, z] = pts[i];
      if (cum[i] > 0.5 && cum[i] < SPINE.length) for (let j = 6; j < NJ; j += 2) {  // the old body, still there
        const ex = x - JA[j][0], ez = z - JA[j][2], d = Math.sqrt(ex * ex + ez * ez); cost += Math.max(0, WJT[j] + 0.07 - d); }
      const e = len - cum[i];                                                    // still occupied while the head lays…
      if (e < SPINE.length) for (let j = NSEG; j >= 0 && (NSEG - j) * L <= SPINE.length - e; j -= 2) {   // …the new tail end
        const ex = x - JB[j][0], ez = z - JB[j][2], d = Math.sqrt(ex * ex + ez * ez); cost += Math.max(0, WJT[j] + 0.07 - d); }
    }
    const score = len + 60 * cost;                                           // shortest wins unless it runs badly over itself (owner: detours too long)
    if (!best || score < best.score) best = { score, pts, len, r, type };
  }
  if (best) best.pts = dubins(p0, Math.atan2(t0[2], t0[0]), p1, Math.atan2(t1[2], t1[0]), best.r, best.type);   // the winner, fine
  // heights: from the old head's to the new tail's, climbing over the old body where it must
  const seg = [], bp = best ? best.pts : [[p0[0], p0[2]], [p1[0], p1[2]]], bl = best ? best.len : Math.hypot(p1[0] - p0[0], p1[2] - p0[2]);
  let run = 0;
  for (let i = 1; i < bp.length - 1; i++) {
    run += Math.hypot(bp[i][0] - bp[i - 1][0], bp[i][1] - bp[i - 1][1]);
    const u = run / Math.max(bl, 1e-9), q = [bp[i][0], p0[1] + (p1[1] - p0[1]) * ss(0, 1, u), bp[i][1]];
    let lift = 0;
    for (let j = 6; j < NJ; j++) {
      const ex = q[0] - JA[j][0], ez = q[2] - JA[j][2], d = Math.sqrt(ex * ex + ez * ez), rr = WJT[j] + 0.06;
      if (d < 2 * rr) lift = Math.max(lift, (JA[j][1] + 0.12 - q[1]) * ss(2 * rr, rr, d));
    }
    q[1] += Math.max(0, lift) * ss(0, 0.6, run);
    seg.push(q);
  }
  for (let i = 1; i + 1 < seg.length; i++) seg[i][1] = Math.max(seg[i][1], (seg[i - 1][1] + seg[i + 1][1]) / 2);   // no kinks
  for (const q of seg) PATH.push(q);
  for (let j = NSEG; j >= 0; j--) PATH.push(JB[j]);
  // Round the corners: the two bodies are polylines that turn up to ~35° at a joint (a concertina
  // fold); following such corners the chain behind stuck, then caught up a whole segment at once.
  // Catmull-Rom points between the joints smooth it; the joints themselves stay, so the ends are exact.
  { const src = PATH.slice(), m = src.length; PATH.length = 0;
    const smooth = (i0, i1) => i0 < NSEG && i1 <= NSEG || i0 >= m - NJ;   // within A's or B's body
    for (let i = 0; i < m; i++) {
      PATH.push(src[i]);
      if (i + 1 < m && smooth(i, i + 1)) {
        const p0 = src[Math.max(0, i - 1)], p1 = src[i], p2 = src[i + 1], p3 = src[Math.min(m - 1, i + 2)];
        for (const t of [0.25, 0.5, 0.75]) {
          const t2 = t * t, t3 = t2 * t;
          PATH.push([0, 1, 2].map(c => 0.5 * (2 * p1[c] + (-p0[c] + p2[c]) * t + (2 * p0[c] - 5 * p1[c] + 4 * p2[c] - p3[c]) * t2 + (-p0[c] + 3 * p1[c] - 3 * p2[c] + p3[c]) * t3)));
        }
      }
    }
  }
  CUMP.length = 0; CUMP.push(0);
  for (let i = 1; i < PATH.length; i++) { const a = PATH[i], b = PATH[i - 1], ex = a[0] - b[0], ey = a[1] - b[1], ez = a[2] - b[2]; CUMP.push(CUMP[i - 1] + Math.sqrt(ex * ex + ey * ey + ez * ez)); }
  const LA = CUMP[4 * NSEG], Lt = CUMP[CUMP.length - 1] - LA;
  // Head along the path: a cubic that starts and ends at the speeds the two gaits move at.
  const Tp = (xb - xa) * LOOP_SECONDS, sp = S => S.loco * S.round * S.trav * TILE / LOOP_SECONDS;
  const m0 = Math.min(2.5, (xa ? 0 : sp(A)) * Tp / Lt), m1 = Math.min(2.5, (xb < 1 ? 0 : sp(B)) * Tp / Lt);
  return { A, B, ph0, xa, xb, As, Bs, gA, gB, LA, Lt, m0, m1, path: PATH.slice(), cum: CUMP.slice(), ABL: ABL.slice(), BBL: BBL.slice() };
}
