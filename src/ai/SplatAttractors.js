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
    // axis is z; `axes` stands it upright in the world.
    name: 'Aizawa',
    d: [
      '(z - 0.7) * x - 3.5 * y',
      '3.5 * x + (z - 0.7) * y',
      '0.6 + 0.95 * z - z * z * z / 3.0 - (x * x + y * y) * (1.0 + 0.25 * z) + 0.1 * z * x * x * x',
    ],
    extent: 1.6, centre: [0.0, 0.0, 0.6], axes: 'xzy', rate: 0.6, hold: 2.5,
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
