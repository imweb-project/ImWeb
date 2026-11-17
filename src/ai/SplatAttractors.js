/**
 * Splat attractors — the strange attractors Splat World's Scatter flows into.
 *
 * Data only (no imports), so ParameterSystem can take the names for the
 * splat.shape menu without pulling three into its graph, and so a second
 * consumer (a 3D-scene model's vertices, say) can use the same shapes.
 *
 * ONE definition per shape. `d` is the three components of dq/dt written in
 * the subset of syntax that is valid as BOTH GLSL and JavaScript — x, y, z,
 * sin(), float literals WITH a decimal point, + - * /. The shader is generated
 * from it (attractorGLSL) and tests/audit-splat-attractors.mjs integrates the
 * very same strings in node, so the storm test runs the real field, not a
 * hand-copied twin of it.
 *
 *   extent  half-size of the form in its own units: it is scaled so that this
 *           fills the frame.
 *   centre  the middle of the form in its own units.
 *   axes    swizzle from world to shape space, and back. Must be its own
 *           inverse (xyz, xzy, yxz, zyx) — one string serves both directions.
 *   rate    shape time units per second at Flow 100 %.
 *   hold    radius (shape units, from `centre`) the field is evaluated inside.
 *           Further out a point feels the field at the rim plus a pull back in,
 *           so a point that starts far outside the basin — a far corner of the
 *           picture — comes in instead of running away.
 *
 * APPEND-ONLY: splat.shape persists as an index into this list.
 */
export const SPLAT_ATTRACTORS = [
  {
    // Thomas' cyclically symmetric attractor. The sines bound every term, so
    // any start ends on the form; b = 0.208186 is the classic chaotic value.
    name: 'Thomas',
    d: [
      'sin(y) - 0.208186 * x',
      'sin(z) - 0.208186 * y',
      'sin(x) - 0.208186 * z',
    ],
    extent: 4.0, centre: [0.0, 0.0, 0.0], axes: 'xyz', rate: 2.5, hold: 9.0,
  },
  {
    // Aizawa: a hollow shell with a tight column through its axis. Its own
    // axis is z; `axes` stands it upright in the world. The spin term is 1.5,
    // not the textbook 3.5: the same shell, turning at less than half the speed
    // (the owner found 3.5 too fast), without slowing how quickly it forms.
    name: 'Aizawa',
    d: [
      '(z - 0.7) * x - 1.5 * y',
      '1.5 * x + (z - 0.7) * y',
      '0.6 + 0.95 * z - z * z * z / 3.0 - (x * x + y * y) * (1.0 + 0.25 * z) + 0.1 * z * x * x * x',
    ],
    extent: 1.6, centre: [0.0, 0.0, 0.6], axes: 'xzy', rate: 0.6, hold: 2.5,
  },
  // Tried and NOT shipped: Halvorsen (2026-11-17). Its basin does not fill any
  // ball around it, so starts that are caught by the hold are then parked at
  // the rim — 56 of 245 in the storm test, even sampling the field well inside
  // the rim. The audit's "ends ON the form" check is what says so; a shape
  // must pass it before it goes in this list.
  // Likewise Burke–Shaw and Nosé–Hoover (2026-11-18): 5 of 245 starts parked at
  // the rim each. Close, but a handful of stragglers is still a shell.
  // And a four-wing attractor (0.2x + yz, -0.01x - 0.4y - xz, -z - xy): it PASSES
  // the storm test, but after 60 s on screen it is still a cloud with a faint
  // cross in it, not a form. The audit cannot see that; an eye has to.
  {
    // Lorenz: the butterfly. Its own axis is z; `axes` stands it upright.
    name: 'Lorenz',
    d: [
      '10.0 * (y - x)',
      'x * (28.0 - z) - y',
      'x * y - 2.6666667 * z',
    ],
    extent: 32.0, centre: [0.0, 0.0, 24.7], axes: 'xzy', rate: 0.2, hold: 45.0,
  },
  {
    // Rössler: a flat spiral that now and then throws one loop straight up.
    name: 'Rössler',
    d: [
      '-y - z',
      'x + 0.2 * y',
      '0.2 + z * (x - 5.7)',
    ],
    extent: 15.0, centre: [1.0, -1.5, 8.0], axes: 'xzy', rate: 1.0, hold: 18.0,
  },
  {
    // Thomas with half the damping: the single knot opens into a lattice the
    // points wander through, cell to cell.
    name: 'Lattice',
    d: [
      'sin(y) - 0.1 * x',
      'sin(z) - 0.1 * y',
      'sin(x) - 0.1 * z',
    ],
    extent: 7.8, centre: [0.0, 0.0, 0.0], axes: 'xyz', rate: 4.2, hold: 11.0,
  },
  {
    // Rucklidge: two rounded lobes, like a figure of eight seen from above.
    name: 'Rucklidge',
    d: [
      '-2.0 * x + 6.7 * y - y * z',
      'x',
      '-z + y * y',
    ],
    extent: 12.6, centre: [0.0, 0.0, 7.7], axes: 'xzy', rate: 1.1, hold: 14.5,
  },
];

/** Pull back toward the rim outside `hold`, per shape time unit. */
export const HOLD_PULL = 1.5;

const f = (n) => (Number.isInteger(n) ? n.toFixed(1) : String(n));

/**
 * GLSL for `vec3 flow(vec3 w, float shape)`: the velocity, in frame units per
 * second, of a point at `w` — its position in frame units (1 = the edge of the
 * frame) measured from the middle of the world.
 */
export function attractorGLSL() {
  const fns = SPLAT_ATTRACTORS.map((a, i) => `
    vec3 flow${i}(vec3 w) {
      vec3 c = vec3(${a.centre.map(f).join(', ')});
      vec3 q0 = w.${a.axes} * ${f(a.extent)};
      vec3 q = q0 * min(1.0, ${f(a.hold)} / max(length(q0), 1.0e-4));
      float x = q.x + c.x; float y = q.y + c.y; float z = q.z + c.z;
      vec3 v = vec3(${a.d.join(',\n               ')});
      return ((v - (q0 - q) * ${f(HOLD_PULL)}) * ${f(a.rate / a.extent)}).${a.axes};
    }`).join('\n');
  return `${fns}
    vec3 flow(vec3 w, float shape) {
      return ${chain(0)};
    }`;
}

/** shape < 0.5 ? flow0(w) : (shape < 1.5 ? flow1(w) : flow2(w)) … */
function chain(i) {
  return i === SPLAT_ATTRACTORS.length - 1
    ? `flow${i}(w)`
    : `(shape < ${i + 0.5} ? flow${i}(w) : ${chain(i + 1)})`;
}

// ── The scatter step: shared by everything that scatters ─────────────────────
// A scattered thing — a Splat World point, a shard of a 3D model — keeps an
// OFFSET from its home, so at offset zero it is exactly home and home is free
// to move underneath it.
export const PULL = 3.0;        // 1/s: how hard Scatter 0 calls a thing home
export const OFF_MAX = 100.0;   // the step never stores an offset longer than this
export const OFF_EPS = 1.0e-4;  // … and one shorter than this is home
// At Scatter 0 an offset only decays, by exp(-PULL·dt) a step — so after this
// many simulated seconds every one of them is below OFF_EPS. A bound computed
// from the limits above, not a guess at when things look settled.
export const SETTLE_S = Math.log(OFF_MAX / OFF_EPS) / PULL;
export const MAX_DT = 1 / 30;   // a stalled tab must not become one giant step

/**
 * GLSL for flow() plus
 *   vec3 scatterStep(vec3 h, vec3 off, vec3 pivot, float frame,
 *                    float s, float flowAmt, float shape, float dt)
 * — one step for a thing with home `h` and offset `off`: flow along the
 * attractor centred on `pivot` (midpoint rule; `frame` world units per frame
 * unit), then decay toward home by how far Scatter `s` is from 1. Returns the
 * new offset. tests/audit-splat-attractors.mjs mirrors this function in JS.
 */
export function scatterStepGLSL() {
  return `${attractorGLSL()}
    vec3 scatterStep(vec3 h, vec3 off, vec3 pivot, float frame, float s, float flowAmt, float shape, float dt) {
      vec3 w = (h + off - pivot) / frame;
      float hs = s * flowAmt * dt;
      vec3 mid = w + flow(w, shape) * hs * 0.5;
      w += flow(mid, shape) * hs;
      vec3 o = (pivot + w * frame - h) * exp(-${f(PULL)} * (1.0 - s) * dt);
      // NaN or a runaway would live in the ping-pong for good: send it home.
      // Written as !(a < b) so that NaN, which fails every comparison, is caught.
      if (!(dot(o, o) < ${f(OFF_MAX * OFF_MAX)})) o = vec3(0.0);
      return o;
    }`;
}

/**
 * The settle clock every scatterer runs: call once a frame with the scatter
 * amount (0..1), BEFORE stepping; it says whether anything may be out. After
 * a step at scatter 0, call ran(dt) with the dt the step used.
 */
export class SettleClock {
  constructor() { this.left = 0; }
  get out() { return this.left > 0; }
  /** @returns {{ out: boolean, woke: boolean }} woke: out now, and was not before */
  tick(scatter) {
    const was = this.left > 0;
    if (scatter > 0) this.left = SETTLE_S;
    return { out: this.left > 0, woke: this.left > 0 && !was };
  }
  ran(scatter, dt) { if (scatter <= 0) this.left -= dt; }
}
