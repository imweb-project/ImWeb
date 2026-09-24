/**
 * ClipSegments — find the loops inside a long baked animation.
 *
 * A Poser export is fully baked (every channel keyed every frame), and the
 * owner's long clips are many short takes spliced end to end. Sample the clip
 * at 30 fps and sum how far every moving channel moves per frame; a splice is
 * a HARD CUT — one frame that moves far more than both its neighbours (8–14
 * rad against 0.05–2 on Haraldur6). Each take between two cuts is a segment,
 * played exactly as the file has it. A take can be half a second long.
 *
 * Fallback, for a clip with no cuts (one continuous take, e.g. avatar.dae):
 * the moments where the figure nearly stops become the cut points, and each
 * segment's ends are nudged (±SNAP s) to the pair of frames whose poses match
 * best, so looping it with Anim Start/End does not jump.
 *
 * The owner's 26.6–27.1 % segment of Haraldur6 (26.10–26.67 s) is what showed
 * the joins are cuts: the still-moment detector alone, with its 1 s minimum,
 * merged such takes into their neighbours.
 *
 * Units: a quaternion channel counts its change in radians; a vector channel
 * (position/scale) counts its change as a fraction of its own range, so a
 * channel moving across its full span weighs about as much as a 1-rad turn.
 *
 * Pure function of the clip — cached per clip object.
 */

import * as THREE from 'three';

const FPS = 30;
const SMOOTH = 0.2;      // s — box filter on the speed curve
const QUIET = 0.08;      // bottom fraction of speed samples that count as still
const MIN_GAP = 1.0;     // s — shortest segment
const SNAP = 0.4;        // s — how far a cut may move to find a matching pose
// Hard cut: moves more than JUMP rad in one frame AND more than JUMP_RATIO ×
// both neighbouring frames. Real splices are mostly 4–15 rad; the scale runs
// down without a clean gap, so this leans inclusive — a missed cut plays
// through a jump, an extra one only splits a take.
const JUMP = 1.0;
const JUMP_RATIO = 3;

const _cache = new WeakMap();

/** @returns {{ cuts:number[], segments:{start:number,end:number,match:number}[] }} */
export function clipSegments(clip) {
  let r = _cache.get(clip);
  if (!r) { r = analyse(clip); _cache.set(clip, r); }
  return r;
}

function analyse(clip) {
  const d = clip.duration;
  const N = Math.floor(d * FPS) + 1;
  const empty = { cuts: [], segments: [] };
  if (!(d > 0) || N < FPS * 2) return empty;

  // Sample every channel that moves. chans: { q: bool, w: weight, v: Float32Array(N*size) }
  const chans = [];
  for (const track of clip.tracks) {
    const size = track.getValueSize();
    const q = track instanceof THREE.QuaternionKeyframeTrack;
    const interp = track.createInterpolant();
    const v = new Float32Array(N * size);
    for (let k = 0; k < N; k++) v.set(interp.evaluate(Math.min(k / FPS, d)), k * size);
    let w = 1;
    if (!q) {
      let span = 0;
      for (let c = 0; c < size; c++) {
        let lo = Infinity, hi = -Infinity;
        for (let k = 0; k < N; k++) { const x = v[k * size + c]; if (x < lo) lo = x; if (x > hi) hi = x; }
        span = Math.max(span, hi - lo);
      }
      if (span < 1e-6) continue;
      w = 1 / span;
    }
    const ch = { q, size, w, v };
    if (q) {
      let moved = 0;
      for (let k = 1; k < N && moved < 1e-4; k++) moved = Math.max(moved, diff(ch, 0, k));
      if (moved < 1e-4) continue;
    }
    chans.push(ch);
  }
  if (!chans.length) return empty;

  // Speed per frame step, box-smoothed.
  const speed = new Float32Array(N - 1);
  for (const ch of chans) for (let k = 0; k < N - 1; k++) speed[k] += diff(ch, k, k + 1);

  // Hard cuts: step k jumps from frame k to k+1, so a take ends at frame k and
  // the next begins at k+1 — never interpolating across the splice.
  const jumps = [];
  for (let k = 0; k < N - 1; k++) {
    const nb = Math.max(speed[k - 1] ?? 0, speed[k + 1] ?? 0);
    if (speed[k] > JUMP && speed[k] > JUMP_RATIO * nb) jumps.push(k);
  }
  if (jumps.length) {
    const segments = [];
    let a = 0;
    for (const k of [...jumps, N - 1]) {
      const b = k;                                      // last frame of the take
      if (b - a >= 2) {                                 // drop 1–2 frame slivers
        let m = 0;
        for (const ch of chans) m += diff(ch, a, b);
        segments.push({ start: a / FPS, end: Math.min(b / FPS, d), match: m });
      }
      a = k + 1;
    }
    return { cuts: jumps.map(k => (k + 1) / FPS), segments, speed, fps: FPS };
  }
  const h = Math.max(1, Math.round(SMOOTH * FPS / 2));
  const sm = new Float32Array(N - 1);
  for (let k = 0; k < N - 1; k++) {
    let s = 0, n = 0;
    for (let j = Math.max(0, k - h); j <= Math.min(N - 2, k + h); j++) { s += speed[j]; n++; }
    sm[k] = s / n;
  }

  // Quiet runs → one cut each, at the run's slowest frame.
  const thr = Array.from(sm).sort((a, b) => a - b)[Math.floor(QUIET * (sm.length - 1))];
  const gap = Math.round(MIN_GAP * FPS);
  const cutsK = [];
  for (let k = 0; k < sm.length;) {
    if (sm[k] > thr) { k++; continue; }
    let best = k;
    while (k < sm.length && sm[k] <= thr) { if (sm[k] < sm[best]) best = k; k++; }
    if (best < gap || best > N - 1 - gap) continue;           // too near the clip's ends
    const last = cutsK[cutsK.length - 1];
    if (last !== undefined && best - last < gap) {
      if (sm[best] < sm[last]) cutsK[cutsK.length - 1] = best;
      continue;
    }
    cutsK.push(best);
  }

  // Segments between consecutive cuts (and the clip's ends), each snapped to
  // its best-matching pair of end poses.
  const bounds = [0, ...cutsK, N - 1];
  const snap = Math.round(SNAP * FPS);
  const segments = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const a = bounds[i], b = bounds[i + 1];
    let bestA = a, bestB = b, bestD = Infinity;
    for (let x = Math.max(0, a - snap); x <= Math.min(N - 1, a + snap); x++) {
      for (let y = Math.max(0, b - snap); y <= Math.min(N - 1, b + snap); y++) {
        if (y - x < gap) continue;
        let dd = 0;
        for (const ch of chans) dd += diff(ch, x, y);
        if (dd < bestD) { bestD = dd; bestA = x; bestB = y; }
      }
    }
    segments.push({ start: bestA / FPS, end: Math.min(bestB / FPS, d), match: bestD });
  }
  return { cuts: cutsK.map(k => k / FPS), segments, speed, fps: FPS };
}

// Change of one channel between frames i and j.
function diff(ch, i, j) {
  const { v, size, q, w } = ch;
  const a = i * size, b = j * size;
  if (q) {
    const dot = Math.abs(v[a] * v[b] + v[a + 1] * v[b + 1] + v[a + 2] * v[b + 2] + v[a + 3] * v[b + 3]);
    return 2 * Math.acos(Math.min(1, dot));
  }
  let s = 0;
  for (let c = 0; c < size; c++) { const e = v[a + c] - v[b + c]; s += e * e; }
  return Math.sqrt(s) * w;
}
