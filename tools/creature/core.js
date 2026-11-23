// Shared by every creature definition (jelly-def.js, octopus-def.js, …). Pure maths, no three.js.
//
// A creature definition exports:
//   NAME, LOOP_SECONDS, BODY, CHAINS, INT_KEYS, DEFAULT, GROUPS, SEGMENTS, pose(S, phase, P)
// CHAINS lists the bone chains ({ group, count, bones, length, r0, r1, rs }); pose() fills one
// placement per chain, in CHAINS order, so the page can drive any creature the same way.
// Optional per group:
//   decay  — each bone this × the one before (default 0.95; 1 = equal segments)
//   tube   — false: no tube skin (the view builds its own surface on these bones)
//   on     — { chain, bone: j => n }: chain j grows from bone n of chain `chain` (absolute index),
//            and its placement (a, rad, y, tilt) is in THAT bone's frame, not the body's
//   stiff  — joint-spring stiffness multiplier (default 1)
//   damp   — joint-spring damping ratio ζ (default 0.55: a little bounce; ~1 none; >1 slow and heavy,
//            like a limb dragged through water). Also damps the chain's tilt (default there 0.6).
//   tint   — colour of this group in the Soft skin (hex); tipTint fades to another colour at the tip
//   alpha  — opacity multiplier of this group in the Soft skin (shows when the view's
//            soft.limbProps make the material transparent); a view's own geometry can carry aAlpha
//   art, pinch, dark — a jointed limb: articles that swell, pinch and darken at their joints
//   rings  — rings along the tube (default 3 per bone)
//   custom — [4 numbers] per vertex of this group, for the view's own shader code (skinFx.glsl, vCustom)
//   fur    — { len, dens 0..1, tip lightness, freq } hair on this group (shell fur, Soft skin), or a
//            function (u along the chain 0..1, v round it 0..1, index in group) → the same or null.
//            A view's own geometry can carry aFur (4 per vertex); view.fur = { shells, freq, droop,
//            gravity } sets the coat as a whole.
//
// Seamless-loop rules (asserted by seam-check.mjs for every creature):
//   - one phase clock, 0 → 2π per loop
//   - every frequency and every whole-turn count is an integer (INT_KEYS)
//   - phase offsets may be anything

export const TAU = Math.PI * 2;

// Every creature, in button order. Each is <name>-def.js plus a view (<name>-view.js exporting
// VIEW, or a block in views.js). The page and seam-check.mjs both read this list, and both skip a
// name whose files do not exist yet, so a creature can be registered before it is written.
export const CREATURES = ['jelly', 'octopus', 'centipede', 'spider', 'snake', 'cuttlefish', 'manta', 'paradise', 'featherstar'];

export function segmentState(def, i) {
  return { ...def.DEFAULT, ...def.SEGMENTS[i].s };
}

// Continuous keys ease. Integer keys are NOT touched when `out` already has them: the caller
// switches those at a loop boundary, and writing a[k] back here every frame would undo that.
export function lerpState(def, a, b, e, out = {}) {
  for (const k in def.DEFAULT) {
    if (def.INT_KEYS.includes(k)) { if (!(k in out)) out[k] = a[k]; }
    else out[k] = a[k] + (b[k] - a[k]) * e;
  }
  return out;
}

// root: whole-body transform. parts: creature-specific (bell, mantle…). chains: one per bone chain.
export function makePose(def) {
  const chains = [];
  for (const c of def.CHAINS) for (let j = 0; j < c.count; j++)
    // per bone: bz, bx bend (two planes), by twist about the chain's own axis, bl length scale
    chains.push({ a: 0, rad: 0, y: 0, tilt: 0, len: 1, bz: new Float64Array(c.bones), bx: new Float64Array(c.bones),
      by: new Float64Array(c.bones), bl: new Float64Array(c.bones).fill(1) });
  // root turn order is Y·Z·X: heading, then pitch, then roll about the body's own length
  return { root: { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0 }, parts: {}, chains };
}

// ---- Forward kinematics, exactly as the page applies a pose (creature.html applyPose) -------
// 3×3 rotations, row-major. A chain's root sits at (cos a·rad, y, sin a·rad) turned
// Ry(−a)·Rz(tilt)·E0; each next bone is one segment (× bl) further along its parent's −y, turned
// E_i; E = three.js Euler XYZ (bx, by, bz) = Rx·Ry·Rz; the tip bone is unturned.
export const M3 = {
  rx(t) { const c = Math.cos(t), s = Math.sin(t); return [1, 0, 0, 0, c, -s, 0, s, c]; },
  ry(t) { const c = Math.cos(t), s = Math.sin(t); return [c, 0, s, 0, 1, 0, -s, 0, c]; },
  rz(t) { const c = Math.cos(t), s = Math.sin(t); return [c, -s, 0, s, c, 0, 0, 0, 1]; },
  mul(A, B) {
    const C = new Array(9);
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) C[r * 3 + c] = A[r * 3] * B[c] + A[r * 3 + 1] * B[3 + c] + A[r * 3 + 2] * B[6 + c];
    return C;
  },
  mv(A, v) { return [A[0] * v[0] + A[1] * v[1] + A[2] * v[2], A[3] * v[0] + A[4] * v[1] + A[5] * v[2], A[6] * v[0] + A[7] * v[1] + A[8] * v[2]]; },
};
// Joints of one chain placement C (segment lengths L, before C.len), each { p:[x,y,z], R:[9] },
// in the space of `parent` (a joint of another chain) or of the body when there is none.
export function chainFK(C, L, parent) {
  const { rx, ry, rz, mul, mv } = M3;
  let p = [Math.cos(C.a) * C.rad, C.y, Math.sin(C.a) * C.rad];
  const E = i => mul(mul(rx(C.bx[i]), ry(C.by ? C.by[i] : 0)), rz(C.bz[i]));
  let R = mul(mul(ry(-C.a), rz(C.tilt)), E(0));
  if (parent) { const q = mv(parent.R, p); p = [parent.p[0] + q[0], parent.p[1] + q[1], parent.p[2] + q[2]]; R = mul(parent.R, R); }
  const out = [{ p, R }], B = C.bz.length;
  for (let i = 1; i <= L.length; i++) {
    const d = mv(R, [0, -L[i - 1] * C.len * (C.bl ? C.bl[i - 1] : 1), 0]);
    p = [p[0] + d[0], p[1] + d[1], p[2] + d[2]];
    if (i < B) R = mul(R, E(i));
    out.push({ p, R });
  }
  return out;
}

// Segment lengths of a chain of nb bones, total length `total`, each `decay` × the one before.
// Shared by the page (to build the bones) and by any pose() that needs real positions.
export function chainLengths(nb, total, decay = 0.95) {
  if (decay === 1) return Array.from({ length: nb }, () => total / nb);
  const base = total * (1 - decay) / (1 - Math.pow(decay, nb));
  return Array.from({ length: nb }, (_, i) => base * Math.pow(decay, i));
}

// Seeded per-limb scatter, the same on every run, so irregularity stays periodic.
export function scatter(n, seed = 12345) {
  let s = seed; const r = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  return Array.from({ length: n }, () => r() * TAU);
}
