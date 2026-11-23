// The manta ray (Mobula birostris / alfredi): the first creature whose body is a SHEET, not chains.
// Pure maths, no three.js (see core.js for the contract every creature follows).
//
// Body frame: forward +X, up +Y, span ±Z. Nose at x = +0.5, tail base at x = −0.5, wingtips at
// z = ±1.25 (the disc is ~2.5 wide and ~1 long, as in the owner's top-view photos).
//
// The skeleton:
//   - SPINE: one chain from the nose back to the tail base. Bone 0 is the head; the others arch
//     the body (a somersault curls it dorsal-side in, a breach arches it the other way).
//   - RIBS: seven span-wise rays a side, parented on the spine bones at their chord positions,
//     rooted at the body's edge and running straight out to the wingtip line. The view skins the
//     disc between neighbouring ribs, so a wing is a membrane, not a tube. Each rib flaps at its
//     root (the hinge along the body's side) and flexes along its length. The FLAP WAVE: every
//     bone lags by where it sits in the LOCAL chord (fc: the leading edge leads, the trailing edge
//     follows) and how far out it is (fk: the wave runs out to the tips).
//   - CEPHALIC FINS (the "horns"): each a paddle — a medial-edge chain carrying five cross-chains
//     that run across its width. Curling the cross-chains rolls the paddle into a spiral horn
//     (furl 1, cruising); flat, they open into the feeding funnel either side of the mouth.
//   - JAW: one bone hinged at the back of the mouth floor; gape drops it (the mouth cavity is
//     skinned between the head and the jaw, so it opens into a dark, gill-rakered box).
//   - TAIL: a whip, a tube chain on the last spine bone.
//
// Whole-body paths, all seamless (whole turns are integers, wrapped so 2π meets 0):
//   - turns: whole heading turns per loop round a circle of radius tr (banking turns)
//   - roll:  backward somersaults per loop round an ellipse lx × ly above the dorsal side; warp
//            speeds up the top of the loop. Small and round = barrel-roll feeding; tall, fast at
//            the top and out through the water surface = a backflip breach.
//   - weave: heading swings (wv whole swings per loop), the body side-slipping with it.
import { TAU, chainLengths } from './core.js';

export const NAME = 'Manta ray';
export const LOOP_SECONDS = 6;

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const wrap = x => x - TAU * Math.round(x / TAU);   // 2π·n → 0: whole turns meet at the seam

// ---- Shape (shared with manta-view.js) -------------------------------------------------------
// Outline of one side as x(z): the leading edge (head front, head corner with eye and fin base,
// then the swept wing to the falcate tip) and the trailing edge (tail notch, pelvic lobe, concave
// trailing edge back out to the same tip). Cubic Hermite through the points.
function curve(pts) {
  const n = pts.length;
  const m = pts.map((p, i) => { const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)]; return (b[1] - a[1]) / (b[0] - a[0]); });
  return z => {
    z = clamp(z, 0, pts[n - 1][0]);
    let i = 0; while (i < n - 2 && z > pts[i + 1][0]) i++;
    const [z0, x0] = pts[i], [z1, x1] = pts[i + 1], h = z1 - z0, t = (z - z0) / h, t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * x0 + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * x1 + (t3 - t2) * h * m[i + 1];
  };
}
const NOSE = 0.5, TIP = 1.25;
const LE = curve([[0, 0.5], [0.1, 0.5], [0.15, 0.493], [0.19, 0.472], [0.23, 0.44], [0.3, 0.385], [0.45, 0.285],
  [0.65, 0.15], [0.85, 0.02], [1.0, -0.085], [1.1, -0.17], [1.17, -0.245], [1.215, -0.31], [1.24, -0.365], [TIP, -0.41]]);
const TE = curve([[0, -0.5], [0.04, -0.53], [0.08, -0.555], [0.115, -0.54], [0.15, -0.5], [0.19, -0.455], [0.25, -0.42],
  [0.4, -0.365], [0.6, -0.3], [0.8, -0.26], [0.96, -0.25], [1.07, -0.265], [1.16, -0.3], [1.22, -0.35], [TIP, -0.41]]);
// Half-thickness above and below the mid-plane at the thickest point of the section, by span.
const Htop = z => 0.003 + 0.052 * Math.exp(-((z / 0.3) ** 2)) + 0.018 * Math.max(0, 1 - z / TIP);
const Hbot = z => 0.002 + 0.03 * Math.exp(-((z / 0.28) ** 2)) + 0.012 * Math.max(0, 1 - z / TIP);
// Section thickness along the chord, v = 0 trailing edge → 1 leading edge, max 1 (NACA 00xx,
// closed trailing edge). Near the midline the body is blunter: the head and the pelvic region.
function section(v, z) {
  const x = clamp(1 - v, 0, 1);
  const naca = 10 * (0.2969 * Math.sqrt(x) - 0.126 * x - 0.3516 * x * x + 0.2843 * x ** 3 - 0.1036 * x ** 4);
  const b = 0.55 * Math.exp(-((z / 0.2) ** 2));
  return Math.max(0, (1 - b) * naca + b * Math.pow(Math.max(0, Math.sin(Math.PI * Math.min(1, v * 1.02))), 0.45));
}

// Spine: nose → tail base, six equal segments.
const SPINE_SEG = 6, SPINE_LEN = 1.0, SEG = SPINE_LEN / SPINE_SEG;
// Ribs: chord positions, root distance from the midline (further out at the head corner, behind
// the eye), length out past the tip line. Each rib hangs off the spine bone over its position.
const RIB_X = [0.38, 0.245, 0.11, -0.025, -0.16, -0.295, -0.43], NR = RIB_X.length;
const ribZr = x => 0.2 + 0.06 * smooth(0.2, 0.42, x);
const RIB_ZR = RIB_X.map(ribZr);
const RIB_BONES = 8, RIB_LEN = 1.07, RIB_DECAY = 0.92;
const RIB_N = RIB_X.map(x => Math.min(SPINE_SEG - 1, Math.floor((NOSE - x) / SEG)));
const RIB_Y = RIB_X.map((x, k) => -((NOSE - x) - RIB_N[k] * SEG));
// Mouth and jaw: the mouth spans |z| < MOUTH at the head front; the jaw hinges HINGE behind it.
const MOUTH = 0.15, HINGE = 0.16;
// Cephalic fins: base on the head corner, medial edge at z = ±LOBE_Z, width LOBE_W, length LOBE_L.
const LOBE_X = 0.47, LOBE_Z = 0.18, LOBE_W = 0.14, LOBE_L = 0.34, LOBE_BONES = 4, CROSS = LOBE_BONES + 1, CROSS_BONES = 5;

export const SHAPE = { NOSE, TIP, LE, TE, Htop, Hbot, section, RIB_X, RIB_ZR, NR, ribZr, MOUTH, HINGE,
  LOBE_X, LOBE_Z, LOBE_W, LOBE_L, CROSS, SPINE_LEN };

export const BODY = { nose: NOSE, tip: TIP };

// ---- Chains (order matters: a parent comes before the chains that grow on it) -------------
export const IDX = { spine: 0, rib: 1, jaw: 1 + 2 * NR, lobe: 2 + 2 * NR, lobeX: [4 + 2 * NR, 4 + 2 * NR + CROSS], tail: 4 + 2 * NR + 2 * CROSS, NR };
export const CHAINS = [
  { group: 'spine', count: 1, bones: SPINE_SEG, length: SPINE_LEN, decay: 1, tube: false, stiff: 2.5, r0: 0.05, r1: 0.05, rs: 4 },
  // +Z ribs first (j < NR), then −Z
  { group: 'rib', count: 2 * NR, bones: RIB_BONES, length: RIB_LEN, decay: RIB_DECAY, tube: false, stiff: 1,
    on: { chain: IDX.spine, bone: j => RIB_N[j % NR] }, r0: 0.02, r1: 0.02, rs: 4 },
  { group: 'jaw', count: 1, bones: 1, length: HINGE, decay: 1, tube: false, stiff: 2, on: { chain: IDX.spine, bone: () => 0 }, r0: 0.02, r1: 0.02, rs: 4 },
  // lobe 0 on the +Z side, lobe 1 on −Z
  { group: 'lobe', count: 2, bones: LOBE_BONES, length: LOBE_L, decay: 0.95, tube: false, stiff: 1.6,
    on: { chain: IDX.spine, bone: () => 0 }, r0: 0.02, r1: 0.02, rs: 4 },
  { group: 'lobeR', count: CROSS, bones: CROSS_BONES, length: LOBE_W, decay: 0.85, tube: false, stiff: 2.2,
    on: { chain: IDX.lobe, bone: j => j }, r0: 0.01, r1: 0.01, rs: 4 },
  { group: 'lobeL', count: CROSS, bones: CROSS_BONES, length: LOBE_W, decay: 0.85, tube: false, stiff: 2.2,
    on: { chain: IDX.lobe + 1, bone: j => j }, r0: 0.01, r1: 0.01, rs: 4 },
  // custom: region 4 for the view's shader (keeps the chain tint)
  { group: 'tail', count: 1, bones: 12, length: 1.0, decay: 0.96, r0: 0.02, r1: 0.0035, rs: 6, tint: 0x1d1d22, stiff: 0.7,
    custom: [1, 4, 0, 0], on: { chain: IDX.spine, bone: () => SPINE_SEG } },
];

// Placement of every chain, constant (only the bends move). Frames, worked through in the
// comments so the bend signs below are not guesses (checked with core.js chainFK):
//   spine (a π, tilt π/2): local x = up, local y = forward, −y runs back to the tail.
//   rib on the +Z side (a −π/2): bx about forward; −bx lifts it (+Z) — so "up" = −side·bx.
//   jaw (tilt π): points forward; bz > 0 drops it.
//   lobe (tilt π, a ∓π/2): points forward; bz > 0 turns it inward; σ·bx tips it down; −σ·by turns its outer edge down.
//   cross-chain (a π, tilt π/2): runs out across the fin; −σ·bx rolls its outer edge down and under.
const PLACE = [];
PLACE.push({ a: Math.PI, rad: -NOSE, y: 0, tilt: Math.PI / 2 });
for (let j = 0; j < 2 * NR; j++) { const k = j % NR, side = j < NR ? 1 : -1;
  PLACE.push({ a: -side * Math.PI / 2, rad: RIB_ZR[k], y: RIB_Y[k], tilt: Math.PI / 2 }); }
PLACE.push({ a: 0, rad: 0, y: -HINGE, tilt: Math.PI });
PLACE.push({ a: -Math.PI / 2, rad: LOBE_Z, y: -(NOSE - LOBE_X), tilt: Math.PI });
PLACE.push({ a: Math.PI / 2, rad: LOBE_Z, y: -(NOSE - LOBE_X), tilt: Math.PI });
for (let j = 0; j < 2 * CROSS; j++) PLACE.push({ a: Math.PI, rad: 0, y: 0, tilt: Math.PI / 2 });
PLACE.push({ a: 0, rad: 0, y: 0, tilt: 0 });

// Where each rib bone sits in its LOCAL chord (0 = leading edge, 1 = trailing edge): the flap
// wave's chordwise lag. Computed from the outline, so it is right near the tip too, where the
// leading and trailing edges are only a rib apart.
const RIB_L = chainLengths(RIB_BONES, RIB_LEN, RIB_DECAY), RIB_CUM = [0];
RIB_L.forEach(l => RIB_CUM.push(RIB_CUM[RIB_CUM.length - 1] + l));
const LAG = RIB_X.map((x, k) => RIB_L.map((l, i) => {
  const z = Math.min(TIP - 0.03, RIB_ZR[k] + RIB_CUM[i] + l / 2), le = LE(z), te = TE(z);
  return clamp((le - x) / Math.max(0.03, le - te), 0, 1);
}));
// Flex along the wing (bones 1..7): more toward the tip, sums to 1.
const FLEX = [0, 0.09, 0.12, 0.14, 0.15, 0.16, 0.17, 0.17];
// A rolled cephalic fin: bend per cross-chain bone (sums past 2π).
const ROLL = [0.4, 1.5, 1.5, 1.5, 1.55];

// The breach, as one lap per loop (u = 0..1): rise steeply, burst out near-vertical, tip forward
// into a belly-flop, U-turn under water, swim back, U-turn, rise again. Keyframes: u, x, y, z,
// pitch, heading (one whole turn per lap), airborne. Periodic cubic Hermite through them.
const LAP = [
  [0.00, -0.55, -1.2, 0.0, 0.18, 0, 0],
  [0.13, -0.05, -0.85, 0.0, 0.75, 0, 0],
  [0.25, 0.3, 0.0, 0.0, 1.25, 0, 0],
  [0.32, 0.42, 1.05, 0.0, 1.42, 0, 0.7],
  [0.40, 0.5, 1.9, 0.0, 1.5, 0, 1],
  [0.48, 0.6, 1.6, 0.0, 0.8, 0, 1],
  [0.56, 0.74, 0.36, 0.0, 0.02, 0, 0.6],
  [0.65, 0.98, -0.25, -0.15, -0.3, 0.45 * Math.PI, 0],
  [0.75, 0.75, -0.85, -0.7, -0.12, Math.PI, 0],
  [0.85, -0.25, -1.1, -0.75, 0.0, Math.PI, 0],
  [0.94, -0.85, -1.2, -0.35, 0.05, 1.55 * Math.PI, 0],
];
export const LAP_SURFACE = 0.32, LAP_EXIT = 0.27, LAP_FLOP = 0.56;    // water line; when it breaks the surface
function lap(u) {
  const n = LAP.length, K = i => { const k = ((i % n) + n) % n, w = Math.floor(i / n), r = LAP[k].slice(); r[0] += w; r[5] += w * TAU; return r; };
  let i = 0; while (i < n - 1 && u >= LAP[i + 1][0]) i++;
  const a = K(i - 1), b = K(i), c = K(i + 1), d = K(i + 2), h = c[0] - b[0], t = (u - b[0]) / h, t2 = t * t, t3 = t2 * t;
  const out = [];
  for (let j = 1; j < 7; j++) {
    const m1 = (c[j] - a[j]) / (c[0] - a[0]) * h, m2 = (d[j] - b[j]) / (d[0] - b[0]) * h;
    out.push((2 * t3 - 3 * t2 + 1) * b[j] + (t3 - 2 * t2 + t) * m1 + (-2 * t3 + 3 * t2) * c[j] + (t3 - t2) * m2);
  }
  return out;   // x, y, z, pitch, heading, air
}

export const INT_KEYS = ['fh', 'turns', 'roll', 'wv', 'lap'];

export const DEFAULT = {
  // wings
  fh: 1,        // wing beats per loop
  fa: 0.3,      // flap at the hinge (rad)
  ft: 1.05,     // bend along the wing with the beat (rad, root to tip): most of the stroke is bending, not hinging
  fk: 0.21,     // lag per rib bone: the wave runs out to the tips (≈ a quarter beat at the tip)
  fc: 1.3,      // lag across the local chord: the leading edge leads, the trailing edge follows
  fe: 0.6,      // the thin trailing edge bends more than the thick leading edge (ripples after it)
  sk: 0.35,     // stroke asymmetry: the power downstroke is quick (~40% of the beat), the recovery slow
  dih: 0.05,    // wings held up (+) or down at the hinge
  droop: 0,     // wings held bent along their length: + tips curl up (dorsal), − arch down
  asym: 0,      // + the +Z wing beats harder, the −Z wing softer (turning)
  sweep: 0,     // wings swept forward (+) or back at the hinge
  // body
  heave: 0.06,  // body bobs against the beat
  bp: 0.035,    // body pitches with the beat
  arch: 0,      // body arched: + dorsal side in (head and tail up)
  archW: 0.05,  // body arch breathing with the beat
  pitch: 0,     // held pitch (+ nose up)
  // head
  furl: 1,      // cephalic fins: 1 rolled into horns, 0 open paddles
  cup: 0.06,    // open fins cupped
  ldn: 0.05,    // fins tipped down
  lin: 0.12,    // fins curve in toward each other
  ltw: 0,       // fins turned on their axis, outer edge down and under: open, the white inner faces turn toward the mouth (the feeding funnel)
  lw: 0.04,     // fins stir
  gape: 0,      // mouth open (0..1)
  // path
  yaw: 0,       // held heading
  turns: 0,     // whole heading turns per loop round a circle (sign = direction)
  tr: 0,        // radius of that circle
  bank: 0,      // held bank (roll), − = the −Z wing down
  rock: 0,      // gentle side-to-side roll
  weave: 0,     // heading swings
  wv: 1,        // heading swings per loop
  wb: 0,        // bank with the swings
  flow: 0,      // turns breathe: bank, height, radius and pitch swell and ease with each beat (not a fixed rail)
  roll: 0,      // backward somersaults per loop
  lx: 0.55,     // somersault loop: reach along the heading
  ly: 0.55,     //   and height (loop centre is above the dorsal side)
  warp: 0,      //   faster over the top of the loop
  air: 0,       // over the top of each loop the wings arch down and stop beating (airborne)
  hy: 0,        // height
  leap: 0,      // breach lap (0..1 blends it in)
  lap: 0,       // the lap's whole heading turn (0 or 1; switches at a loop boundary)
  surf: 0,      // water surface shown (breach)
  floor: 0,     // reef floor shown (cleaning station)
};

export const GROUPS = ['cruising', 'turning', 'feeding', 'leaping', 'resting'];

export const SEGMENTS = [
  { name: 'Cruise',    group: 'cruising', desc: 'slow deep flaps: each beat runs from the leading edge to the trailing edge and out to the tips; horns rolled',
    s: {} },
  { name: 'Glide',     group: 'cruising', desc: 'wings held, arched down at the tips, a slow rocking; only the tips stir',
    s: { fa: 0.03, ft: 0.16, fk: 0.3, dih: 0.1, droop: -0.35, heave: 0.01, bp: 0.01, archW: 0, rock: 0.08, pitch: -0.05 } },
  { name: 'Bank',      group: 'turning',  desc: 'a full banking turn: rolls into the circle, the outer wing beating harder',
    s: { turns: 1, tr: 1.15, bank: -0.45, asym: 0.35, flow: 1, fa: 0.27, ft: 0.95, sweep: 0.04 } },
  { name: 'Swoop',     group: 'turning',  desc: 'S-curves: banks one way, then the other, side-slipping through the water',
    s: { weave: 0.55, wv: 1, wb: 0.42, flow: 1, fa: 0.27, ft: 0.95, heave: 0.05 } },
  { name: 'Chain',     group: 'feeding',  desc: 'chain feeding: mouth wide, fins opened into a funnel, steady beats, weaving after the one in front',
    s: { gape: 1, furl: 0, ldn: 0.7, lin: 0.65, ltw: 1.9, cup: 0.12, lw: 0.08, fa: 0.22, ft: 0.75, weave: 0.22, wv: 2, wb: 0.12, pitch: 0.06 } },
  { name: 'Somersault', group: 'feeding', desc: 'barrel-roll feeding: backward somersaults on the spot, belly out, wings and body curled dorsal-side in, mouth open',
    s: { roll: 1, lx: 0.5, ly: 0.5, gape: 1, furl: 0, ldn: 0.35, lin: 0.6, ltw: 1.9, cup: 0.12, fh: 2, fa: 0.22, ft: 0.75, droop: 0.22, dih: 0.12, arch: 0.22, heave: 0.02 } },
  { name: 'Breach',    group: 'leaping',  desc: 'rises fast from below, bursts out through the surface, flips over backward in the air with wings arched down, dives back in',
    s: { leap: 1, lap: 1, air: 1, surf: 1, hy: -0.45, fh: 3, fa: 0.36, ft: 0.95, sk: 0.4, heave: 0.03, furl: 1 } },
  { name: 'Clean',     group: 'resting',  desc: 'hovering over a cleaning station: barely moving, only ripples along the wing margins, fins half unrolled',
    s: { fa: 0.04, ft: 0.32, fk: 0.45, fc: 1.4, fe: 1.0, sk: 0.15, dih: 0.03, droop: 0.06, heave: 0.01, bp: 0.01, archW: 0.01, furl: 0.4, ldn: 0.35, lin: 0.25,
         weave: 0.12, wv: 1, wb: 0.04, hy: 0.7, floor: 1 } },
];

export function pose(S, ph, P) {
  const C = P.chains;
  for (let k = 0; k < C.length; k++) {
    const q = PLACE[k], c = C[k];
    c.a = q.a; c.rad = q.rad; c.y = q.y; c.tilt = q.tilt; c.len = 1;
    c.bz.fill(0); c.bx.fill(0); c.by.fill(0); c.bl.fill(1);
  }
  const phi = S.fh * ph;
  // The beat's own clock, warped: quick through the power downstroke (sin falling), slow through
  // the recovery. x − sk·sin x is monotone for sk < 1 and gains exactly 2π a beat, so it loops.
  const beat = x => Math.sin(x - S.sk * Math.sin(x));

  // ---- Whole-body path ----------------------------------------------------------------------
  // Somersault / breach loop: the angle round the loop runs one whole turn per somersault, warped
  // faster over the top; the body follows the loop's tangent (pitch), dorsal side toward its centre.
  const A0 = S.roll * ph, al = A0 - S.warp * Math.sin(A0), sa = Math.sin(al), ca = Math.cos(al);
  const kk = S.ly / S.lx, tang = al + Math.atan2((kk - 1) * sa * ca, ca * ca + kk * sa * sa);
  const lpx = S.lx * sa, lpy = S.ly * (1 - ca);
  const u = (ph / TAU) % 1, L = lap(u), lp = S.leap;
  const air = S.air * Math.max(Math.pow(0.5 - 0.5 * Math.cos(A0), 4), lp * clamp(L[5], 0, 1));   // over the top of each loop / out of the water
  const hc = S.turns * ph, wv = S.wv * ph, sw = Math.sin(wv);
  const head = hc + S.yaw + S.weave * Math.cos(wv);
  const arch = S.arch - 0.35 * air;
  // breach lap: blended in by leap; its heading turns only with the integer lap (no pop mid-loop)
  // flow: the turn is flown, not railed — each power stroke rolls it deeper and lifts it a little
  const fl = S.flow, fb = beat(phi + 0.4), f2 = Math.sin(2 * ph + 0.7);
  const lh = S.lap * L[4], dh = S.lap * (lap(Math.min(u + 0.005, 0.9999))[4] - lap(Math.max(u - 0.005, 0))[4]) / 0.01;
  const tr = S.tr * (1 + 0.18 * fl * f2);
  P.root.x = (tr * Math.sin(hc) + lpx * Math.cos(head)) * (1 - lp) + lp * L[0];
  P.root.z = (tr * Math.cos(hc) - lpx * Math.sin(head) - 0.45 * S.weave * sw) * (1 - lp) + lp * L[2];
  P.root.y = S.hy + lpy * (1 - lp) + lp * L[1] - S.heave * (1 - air) * beat(phi - 0.9) + fl * (0.14 * Math.sin(2 * wv + 0.3) + 0.1 * f2);
  P.root.ry = wrap(head + lh);
  P.root.rz = wrap(tang * (1 - lp) + lp * L[3] + S.pitch + arch / 2 + S.bp * (1 - air) * Math.cos(phi) + fl * (0.16 * Math.cos(2 * wv + 0.3) + 0.1 * Math.cos(2 * ph + 0.7)));
  P.root.rx = (S.bank + S.wb * sw) * (1 + 0.28 * fl * fb) + fl * 0.06 * f2 + S.rock * Math.sin(ph + 0.6) - lp * 0.06 * dh;   // bank into the U-turns
  // the turn sets which wing beats harder: the circle's asym, and the swing's (outer wing while turning)
  const asym = S.asym - 0.8 * S.wb * sw;

  // ---- Wings ------------------------------------------------------------------------------
  for (let j = 0; j < 2 * NR; j++) {
    const k = j % NR, side = j < NR ? 1 : -1, up = -side, c = C[IDX.rib + j], lag = LAG[k];
    const amp = Math.max(0, 1 + side * asym) * (1 - air);
    c.bx[0] = up * (S.dih + S.fa * amp * beat(phi - S.fc * lag[0]));
    c.bz[0] = S.sweep;
    const held = S.droop - 1.35 * air;
    for (let i = 1; i < RIB_BONES; i++)
      c.bx[i] = up * FLEX[i] * (held + S.ft * amp * (1 + S.fe * (lag[i] - 0.5)) * beat(phi - S.fc * lag[i] - S.fk * i));
  }

  // ---- Body: bone 0 is the head, the joints behind it arch the body ----------------------
  const sp = C[IDX.spine];
  for (let i = 1; i < SPINE_SEG; i++) {
    sp.bz[i] = arch / (SPINE_SEG - 1) + S.archW / (SPINE_SEG - 1) * beat(phi - 0.6 - 0.3 * i);
    sp.bx[i] = 0.04 * (S.bank + S.wb * sw);                      // a little lateral curve into turns
  }
  C[IDX.jaw].bz[0] = 0.85 * S.gape;

  // ---- Cephalic fins ----------------------------------------------------------------------
  for (let s = 0; s < 2; s++) {
    const sg = s === 0 ? 1 : -1, lb = C[IDX.lobe + s];
    const st = S.lw * Math.sin(2 * ph + 1.3 * s), st2 = S.lw * Math.sin(3 * ph + 0.7 + 2.1 * s);
    // Rolled, a horn: shorter (the roll takes up its length), turned in and down, curving in.
    const fu = S.furl;
    // Bone 0 tips the fin down (before the twist), then turns it on its axis (ltw); every later
    // bend happens in that turned frame, so "in" (toward the other fin) and "down" are mixed back
    // out of it with cos/sin of the twist — otherwise a turned fin curls sideways, not inward.
    const tw = S.ltw, ct = Math.cos(tw), stw = Math.sin(tw);
    lb.bx[0] = sg * (S.ldn + 0.08 * fu + st);
    lb.by[0] = -sg * tw;
    lb.bz[0] = (0.3 * S.lin + 0.1 * fu + 0.5 * st2) * ct;
    for (let i = 1; i < LOBE_BONES; i++) {
      const bin = 0.3 * S.lin + 0.05 * fu + 0.4 * st2, bdn = 0.08 * S.ldn + 0.03 * fu;
      lb.bx[i] = sg * (bdn * ct + bin * stw); lb.bz[i] = bin * ct - bdn * stw; lb.bl[i - 1] = 1 - 0.3 * fu + 0.18 * (1 - fu);
    }
    lb.bl[LOBE_BONES - 1] = 1 - 0.3 * fu + 0.18 * (1 - fu);
    // Rolled: the medial strip stays nearly flat on top, the rest wraps down the outside, under,
    // up the inside and a little past a full turn, so the tube closes with the dark side out.
    for (let m = 0; m < CROSS; m++) {
      const x = C[IDX.lobeX[s] + m];
      for (let i = 0; i < CROSS_BONES; i++) x.bx[i] = -sg * (fu * ROLL[i] + (1 - fu) * S.cup) * (1 + 0.15 * st);
    }
  }

  // ---- Tail: a whip trailing the body ------------------------------------------------------
  const tl = C[IDX.tail];
  for (let i = 0; i < tl.bz.length; i++) {
    tl.bz[i] = 0.025 * Math.sin(phi - 1.4 - 0.4 * i) - 0.4 * arch / tl.bz.length;
    tl.bx[i] = 0.03 * Math.sin(ph + 0.5 - 0.3 * i) - 0.08 * (S.bank + S.wb * sw) / 4;
  }

  P.parts.floor = S.floor;
  P.parts.surface = S.surf;
  P.parts.surfY = S.hy + LAP_SURFACE;
  // splashes where the body breaks the surface: [age 0..1 (0 = none), x, z] for the exit and the flop
  const splash = (u0, j) => { const a = ((u - u0) % 1 + 1) % 1 / 0.28; return a < 1 && lp * S.surf > 0 ? [Math.max(1e-3, a) * lp * S.surf, LAP[j][1], LAP[j][3]] : [0, 0, 0]; };
  P.parts.splash = [...splash(LAP_EXIT, 3), ...splash(LAP_FLOP, 6)];
  return P;
}
