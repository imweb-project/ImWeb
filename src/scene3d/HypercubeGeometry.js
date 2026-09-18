/**
 * HypercubeGeometry.js
 * Pure JS N-dimensional hypercube geometry engine (4D–12D).
 * Zero imports. MAX_DIM = 12.
 */

export const MAX_DIM = 12;

// One colour per dimension index (0–12); indices 0–2 unused / base.
export const DIMENSION_COLORS = [
  '#7F77DD', // 0  X — purple
  '#7F77DD', // 1  Y — purple
  '#7F77DD', // 2  Z — purple
  '#D85A30', // 3  W — coral
  '#1D9E75', // 4  V — teal
  '#BA7517', // 5  U — amber
  '#378ADD', // 6  T — blue
  '#D4537E', // 7  S — pink
  '#888780', // 8  R — gray
  '#639922', // 9  Q — green
  '#534AB7', // 10 P — deep purple
  '#0F6E56', // 11 O — deep teal
];

// ── Easing ────────────────────────────────────────────────────────────────────

export const EASING = {
  linear:    t => t,
  easeIn:    t => t * t * t,
  easeOut:   t => 1 - Math.pow(1 - t, 3),
  easeInOut: t => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2,
  bounce:    t => {
    const n1 = 7.5625, d1 = 2.75;
    if (t < 1 / d1)       return n1 * t * t;
    if (t < 2 / d1)       { t -= 1.5  / d1; return n1 * t * t + 0.75; }
    if (t < 2.5 / d1)     { t -= 2.25 / d1; return n1 * t * t + 0.9375; }
                            t -= 2.625 / d1; return n1 * t * t + 0.984375;
  },
};

// ── Rotation plane names ──────────────────────────────────────────────────────

/** Axis letters, 0..MAX_DIM-1: X Y Z W, then V U T S R Q P O. */
export const AXIS_NAMES = 'XYZWVUTSRQPO'.split('');

/**
 * Every rotation plane of the 12-cube, in the projection's own (i,j) order at
 * MAX_DIM — "XY", "XZ" … "XO", "YZ" …. The Plane Bank's menus store an index
 * into this list, so it is APPEND-ONLY by construction (it is derived from
 * MAX_DIM, which only grows at the end).
 */
export const PLANE_PAIRS = [];
for (let i = 0; i < MAX_DIM; i++) for (let j = i + 1; j < MAX_DIM; j++) PLANE_PAIRS.push([i, j]);
export const PLANE_NAMES = PLANE_PAIRS.map(([i, j]) => AXIS_NAMES[i] + AXIS_NAMES[j]);

// ── Stat helpers ──────────────────────────────────────────────────────────────

/** 2^dim vertices */
export function vertexCount(dim) { return 1 << dim; }

/** dim * 2^(dim-1) edges */
export function edgeCount(dim) { return dim <= 0 ? 0 : dim * (1 << (dim - 1)); }

/** C(dim,2) * 2^(dim-2) two-faces */
export function faceCount(dim) {
  if (dim < 2) return 0;
  return (dim * (dim - 1) / 2) * (1 << (dim - 2));
}

/** C(dim,2) rotation planes */
export function rotationPlaneCount(dim) {
  return dim < 2 ? 0 : (dim * (dim - 1)) >> 1;
}

// ── Geometry generation ───────────────────────────────────────────────────────

/**
 * Generate all 2^dim vertices of a unit hypercube centred at origin.
 * Returns array of Float64Arrays of length dim.
 * Bit d of index i = 0 → coordinate −1, = 1 → coordinate +1.
 */
export function generateVertices(dim) {
  const n = 1 << dim;
  const verts = [];
  for (let i = 0; i < n; i++) {
    const v = new Float64Array(dim);
    for (let d = 0; d < dim; d++) v[d] = (i >> d) & 1 ? 1.0 : -1.0;
    verts.push(v);
  }
  return verts;
}

/**
 * Generate all edges of a dim-dimensional hypercube.
 * Returns array of [indexA, indexB, dimAxis].
 * dimAxis = the coordinate axis along which the edge runs (0-based).
 */
export function generateEdges(dim) {
  const n = 1 << dim;
  const edges = [];
  for (let i = 0; i < n; i++) {
    for (let d = 0; d < dim; d++) {
      const j = i ^ (1 << d);
      if (j > i) edges.push([i, j, d]);
    }
  }
  return edges;
}

// ── Projection ────────────────────────────────────────────────────────────────

/**
 * Apply a Givens rotation in the (i,j) plane to a coordinate array in-place.
 */
export function givensRotate(coords, i, j, angle) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const xi = coords[i], xj = coords[j];
  coords[i] =  c * xi - s * xj;
  coords[j] =  s * xi + c * xj;
}

/**
 * Iterative perspective projection from N-D → 3D.
 * Projects dimension by dimension from the outermost inward.
 * wDistance: viewing distance in each higher dimension.
 * Returns [x, y, z].
 */
export function projectVertex(coords, wDistance = 4.0) {
  let c = Array.from(coords);
  for (let d = c.length - 1; d >= 3; d--) {
    const w = c[d];
    const scale = wDistance / (wDistance - w);
    const next = new Array(d);
    for (let k = 0; k < d; k++) next[k] = c[k] * scale;
    c = next;
  }
  return [c[0] ?? 0, c[1] ?? 0, c[2] ?? 0];
}

/**
 * Apply all rotation planes then project every vertex to 3D.
 * rotAngles: flat array of length rotationPlaneCount(dim), one angle per (i<j) plane pair.
 * Returns array of [x, y, z].
 */
export function projectAllVertices(vertices, dim, rotAngles, wDistance = 4.0) {
  return vertices.map(v => {
    const c = Array.from(v);
    let planeIdx = 0;
    for (let i = 0; i < dim; i++) {
      for (let j = i + 1; j < dim; j++) {
        givensRotate(c, i, j, rotAngles[planeIdx] ?? 0);
        planeIdx++;
      }
    }
    return projectVertex(c, wDistance);
  });
}

// ── 2-cell centroids ──────────────────────────────────────────────────────────

/**
 * Generate centroids of all 2-cells (square faces) of a dim-D hypercube.
 * Returns array of Float64Arrays of length dim.
 */
export function generate2CellCentroids(dim) {
  if (dim < 2) return [];
  const verts = generateVertices(dim);
  const centroids = [];

  for (let a = 0; a < dim; a++) {
    for (let b = a + 1; b < dim; b++) {
      // Fixed axes: everything except a and b
      const fixedAxes = [];
      for (let d = 0; d < dim; d++) {
        if (d !== a && d !== b) fixedAxes.push(d);
      }
      const fixedCount = 1 << fixedAxes.length;

      for (let fi = 0; fi < fixedCount; fi++) {
        const centroid = new Float64Array(dim);
        let corners = 0;
        for (const v of verts) {
          let match = true;
          for (let k = 0; k < fixedAxes.length; k++) {
            const expected = (fi >> k) & 1 ? 1 : -1;
            if (v[fixedAxes[k]] !== expected) { match = false; break; }
          }
          if (match) {
            for (let d = 0; d < dim; d++) centroid[d] += v[d];
            corners++;
          }
        }
        if (corners > 0) {
          for (let d = 0; d < dim; d++) centroid[d] /= corners;
          centroids.push(centroid);
        }
      }
    }
  }
  return centroids;
}

// ── 2-cell faces ──────────────────────────────────────────────────────────────

/**
 * Generate all 2-cell faces of a dim-D hypercube.
 * Returns array of { corners: [i,i,i,i], axisA: number, axisB: number }
 * where corners are the 4 vertex indices from generateVertices().
 *
 * Corners come out ALREADY WOUND, in (axisA, axisB) order:
 *   [ (-,-), (+,-), (-,+), (+,+) ]
 * That is the contract — a consumer reads corners[0..3] directly and must NOT
 * re-sort. HypercubeFaces.update() used to derive this winding itself with a
 * `[...corners].sort()` per face per frame: 66 ms/frame at 12D, every bit of it
 * recomputing a value that is constant for a given (dim, face).
 *
 * The indices follow from the bits, so no vertex scan is needed: a face IS the
 * fixed-axis bit pattern plus the two free axis bits, and a set bit means the
 * +1 side of that axis (see generateVertices). The scan this replaced was
 * O(faces x 2^dim x dim) — building dims 2..12 through it blocked the main
 * thread for 78-86 s at boot (measured, production build, Chrome). The same
 * 114,687 faces take ~75 ms this way.
 */
export function generate2CellFaces(dim) {
  if (dim < 2) return [];
  const faces = [];

  for (let a = 0; a < dim; a++) {
    const bitA = 1 << a;
    for (let b = a + 1; b < dim; b++) {
      const bitB = 1 << b;
      const fixedAxes = [];
      for (let d = 0; d < dim; d++) {
        if (d !== a && d !== b) fixedAxes.push(d);
      }
      const fixedCount = 1 << fixedAxes.length;

      for (let fi = 0; fi < fixedCount; fi++) {
        // Bit k of fi picks the side of fixedAxes[k] this face sits on.
        let base = 0;
        for (let k = 0; k < fixedAxes.length; k++) {
          if ((fi >> k) & 1) base |= 1 << fixedAxes[k];
        }
        faces.push({
          corners: [base, base | bitA, base | bitB, base | bitA | bitB],
          axisA: a,
          axisB: b,
        });
      }
    }
  }
  return faces;
}

// ── Edge opacity ──────────────────────────────────────────────────────────────

/**
 * Compute normalised opacity [0,1] for an edge given its axis index and current dim.
 * Base 3D axes are fully opaque; higher axes fade.
 */
export function edgeOpacity(dimAxis, currentDim) {
  if (currentDim <= 3 || dimAxis < 3) return 1.0;
  const fade = 1.0 - (dimAxis - 2) / (currentDim - 2);
  return Math.max(0.15, fade);
}

// ── Default rotation speeds ───────────────────────────────────────────────────

/**
 * Build a Float64Array of default rotation speeds (rad/s) for every plane of dim.
 * Base 3D planes spin fastest; each higher tier spins progressively slower.
 * Alternate signs for visual variety.
 */
export function defaultRotationSpeeds(dim) {
  const n = rotationPlaneCount(dim);
  const speeds = new Float64Array(n);
  let idx = 0;
  for (let i = 0; i < dim; i++) {
    for (let j = i + 1; j < dim; j++) {
      const tier = Math.max(i, j);
      let spd;
      if (tier < 3)      spd = 0.30;
      else if (tier < 5) spd = 0.20;
      else if (tier < 8) spd = 0.12;
      else               spd = 0.06;
      speeds[idx] = (i + j) % 2 === 1 ? -spd : spd;
      idx++;
    }
  }
  return speeds;
}

// ── Morph state ───────────────────────────────────────────────────────────────

/**
 * Create a morph state object for animating a dimension change.
 * @param {number} fromDim
 * @param {number} toDim
 * @param {number} durationMs
 * @param {string} easingKey – key of EASING
 */
export function createMorphState(fromDim, toDim, durationMs = 800, easingKey = 'easeInOut') {
  return {
    fromDim,
    toDim,
    durationMs,
    elapsed: 0,
    easingFn: EASING[easingKey] ?? EASING.easeInOut,
    done: false,
    t: 0,
  };
}

/**
 * Advance morph state by deltaMs. Mutates in place. Returns state.
 * state.t is the eased progress [0..1].
 */
export function morphStep(state, deltaMs) {
  if (state.done) return state;
  state.elapsed = Math.min(state.elapsed + deltaMs, state.durationMs);
  const rawT = state.durationMs > 0 ? state.elapsed / state.durationMs : 1;
  state.t = state.easingFn(rawT);
  if (state.elapsed >= state.durationMs) state.done = true;
  return state;
}
