// Hasta mudras (the 28 single-hand gestures of the Abhinaya Darpana) as finger
// poses for the Poser "James" hand. One table, used by the preview sheet and by
// the baking tool, so what is approved is what is baked.
//
// Each finger: [curl at knuckle, curl at middle joint, curl at tip joint, spread]
// in degrees. Curl bends toward the palm; spread is away from the middle finger
// (for the middle finger: toward the index). Thumb: t1 = [opposition (swing
// under the palm), across (swing in the palm plane toward the fingers), roll],
// t2 / t3 = bend of the two outer thumb joints.
// close: 1 presses the four fingers side by side (the Poser hand rests splayed).
// maxC2 caps the middle-joint curl the solver may use; focus moves the bud's meeting point.
// touch / bud: what sheet-mudras.html?solve=1 fits — pairs of fingertips that
// meet, or all five tips gathered round one point at that radius (Poser units).
// The numbers below the marker line are the solver's output, pasted back.
import * as THREE from 'three';

const S = [0, 0, 0, 0];                 // straight
const F = [80, 100, 70, 0];             // folded into the palm
const T_SIDE = { t1: [4, 30, 0], t2: 12, t3: 30 };       // thumb bent against the side of the hand
const T_OUT = { t1: [0, -35, 0], t2: 0, t3: 0 };         // thumb stretched away
const T_OVER = { t1: [50, 55, 0], t2: 30, t3: 40 };      // thumb across the folded fingers
const T_UP = { t1: [-22, 32, 0], t2: -14, t3: -20 };    // thumbs-up: tall and straight, clear of the fist

export const MUDRAS = {
  Pataka:        { close: 1, I: S, M: S, R: S, P: S, ...T_SIDE },
  Tripataka:     { close: 1, I: S, M: S, R: [85, 60, 20, 0], P: S, ...T_SIDE },
  Ardhapataka:   { close: 1, I: S, M: S, R: [85, 70, 30, 0], P: [85, 70, 30, 0], ...T_SIDE },
  Kartarimukha:  { I: [-5, 0, 0, 14], M: [10, 0, 0, -6], R: F, P: F, t1: [50, 45, 0], t2: 30, t3: 35 },
  Mayura:        { I: [0, 0, 0, 8], M: [0, 0, 0, 0], R: [62, 40, 20, 0], P: [0, 0, 0, 10], t1: [48, 30, 0], t2: 15, t3: 15, touch: [['T', 'R']] },
  Ardhachandra:  { close: 1, I: S, M: S, R: S, P: S, ...T_OUT },
  Arala:         { close: 1, I: [45, 70, 35, 0], M: S, R: S, P: S, ...T_SIDE },
  Shukatunda:    { close: 1, I: [45, 70, 35, 0], M: S, R: [60, 70, 30, 0], P: S, ...T_SIDE },
  Mushti:        { I: F, M: F, R: F, P: F, ...T_OVER },
  Shikhara:      { I: F, M: F, R: F, P: F, ...T_UP },
  Kapittha:      { I: [22, 88, 58, 0], M: F, R: F, P: F, ...T_UP, touch: [['T', 'I']], fixed: ['T'] },
  Katakamukha:   { I: [55, 55, 30, 0], M: [62, 50, 30, 0], R: [5, 10, 5, 6], P: [0, 5, 5, 14], t1: [42, 22, 0], t2: 20, t3: 20, touch: [['T', 'I'], ['T', 'M']] },
  Suchi:         { I: S, M: F, R: F, P: F, ...T_OVER },
  Chandrakala:   { I: S, M: F, R: F, P: F, ...T_OUT },
  Padmakosha:    { I: [62, 22, 14, 8], M: [66, 22, 14, 0], R: [66, 22, 14, 4], P: [62, 24, 14, 10], t1: [42, 18, 0], t2: 8, t3: 8, bud: 0.012, maxC2: 28, focus: [0.006, -0.031, 0.004] },
  Sarpashirsha:  { close: 1, I: [18, 12, 12, 0], M: [18, 12, 12, 0], R: [18, 12, 12, 0], P: [18, 12, 12, 0], t1: [10, 30, 0], t2: 12, t3: 25 },
  Mrigashirsha:  { close: 1, I: [88, 4, 0, 0], M: [88, 4, 0, 0], R: [88, 4, 0, 0], P: [-4, 0, 0, 6], t1: [-16, 44, 0], t2: -14, t3: -20 },
  Simhamukha:    { I: [-5, 0, 0, 12], M: [58, 45, 25, 0], R: [60, 45, 25, 0], P: [-5, 0, 0, 14], t1: [45, 26, 0], t2: 18, t3: 18, touch: [['T', 'M'], ['T', 'R']] },
  Kangula:       { I: [8, 14, 10, 12], M: [8, 14, 10, 0], R: [85, 95, 60, 0], P: [8, 14, 10, 14], t1: [4, -12, 0], t2: 8, t3: 10 },
  Alapadma:      { I: [-12, 0, 0, 24], M: [5, 5, 0, -4], R: [28, 10, 5, 12], P: [50, 15, 5, 26], t1: [-10, -40, 0], t2: 0, t3: 0 },
  Chatura:       { close: 1, I: [20, 5, 0, 0], M: [20, 5, 0, 0], R: [20, 5, 0, 0], P: [-8, 0, 0, 20], t1: [50, 55, 0], t2: 25, t3: 20 },
  Bhramara:      { I: [85, 105, 70, 0], M: [58, 45, 25, 0], R: [-5, 0, 0, 10], P: [-8, 0, 0, 22], t1: [44, 28, 0], t2: 18, t3: 18, touch: [['T', 'M']], fixed: ['I'] },
  Hamsasya:      { I: [55, 45, 25, 0], M: [8, 5, 0, 0], R: [-2, 0, 0, 10], P: [-8, 0, 0, 22], t1: [40, 12, 0], t2: 18, t3: 22, touch: [['T', 'I']] },
  Hamsapaksha:   { close: 1, I: [55, 10, 5, 0], M: [55, 10, 5, 0], R: [55, 10, 5, 0], P: [-8, 0, 0, 18], ...T_SIDE },
  Sandamsha:     { I: [58, 50, 30, 2], M: [62, 50, 30, 0], R: [62, 50, 30, 2], P: [58, 52, 30, 4], t1: [48, 24, 0], t2: 18, t3: 15, bud: 0.007 },
  Mukula:        { I: [72, 24, 15, -4], M: [76, 24, 15, 0], R: [76, 24, 15, -2], P: [74, 26, 15, -6], t1: [48, 26, 0], t2: 10, t3: 8, bud: 0.0034, maxC2: 30, focus: [0.006, -0.031, 0.004] },
  Tamrachuda:    { I: [0, 80, 55, 0], M: F, R: F, P: F, ...T_OVER },
  Trishula:      { I: [0, 0, 0, 14], M: S, R: [0, 0, 0, 12], P: F, t1: [55, 60, 0], t2: 35, t3: 30 },
};

// ── solved (sheet-mudras.html?solve=1) ── replaced wholesale; edit the table above instead
export const SOLVED = {
  Mayura: {"t1": [58, 30, 0], "t2": 8, "t3": 6.4, "R": [67, 50, 30, 3]},
  Kapittha: {"I": [-10, 100, 60, -6.9]},
  Katakamukha: {"t1": [52, 12, 0], "t2": 20, "t3": 16, "I": [57.5, 46.2, 27.7, 0.5], "M": [58.4, 56.4, 33.8, -2.6]},
  Padmakosha: {"I": [74.5, 28, 16.8, -13.8], "M": [76, 15.8, 9.5, 10.6], "R": [48.5, 28, 16.8, -15], "P": [30.1, 28, 16.8, -15], "t1": [52, 18, 0], "t2": 6.7, "t3": 5.4},
  Simhamukha: {"t1": [70, 36, 0], "t2": -2, "t3": -1.6, "M": [78.6, 45, 27, 10], "R": [60, 65, 39, 16.9]},
  Bhramara: {"t1": [68.8, 17.8, 0], "t2": -2, "t3": -1.6, "M": [66.2, 50, 30, -1.3]},
  Hamsasya: {"t1": [50.6, 12, 0], "t2": 8, "t3": 6.4, "I": [60, 62.5, 37.5, 11.3]},
  Sandamsha: {"I": [68, 50.6, 30.4, 7], "M": [42, 78.8, 47.3, -15], "R": [32, 100, 60, 25], "P": [49.9, 96.9, 58.1, 25], "t1": [46.1, 24, 0], "t2": 18, "t3": 14.4},
  Mukula: {"I": [60.8, 17.7, 10.6, -15], "M": [52.2, 30, 18, 18.1], "R": [47.2, 30, 18, -15], "P": [29.6, 30, 18, -15], "t1": [33.1, 37.1, 0], "t2": -10, "t3": -8},
};
for (const [k, v] of Object.entries(SOLVED)) Object.assign(MUDRAS[k], v);

// A soft resting hand, for loops that are given no mudra.
export const RELAXED = { I: [12, 18, 10, 2], M: [16, 22, 12, 0], R: [20, 26, 14, 2], P: [24, 28, 16, 5], t1: [12, 5, 0], t2: 10, t3: 10 };

const D = Math.PI / 180, Y = new THREE.Vector3(0, 1, 0), X = new THREE.Vector3(1, 0, 0);
const FINGERS = { I: 'Index', M: 'Mid', R: 'Ring', P: 'Pinky' };
const OUT = { I: -1, M: -1, R: 1, P: 1 };          // which way "spread" turns about the palm normal, left hand

/**
 * Joint rotations for one hand.
 * @param pose   an entry of MUDRAS
 * @param side   'l' or 'r'
 * @param dirOf  (jointName) → THREE.Vector3, the joint's bone direction in the LEFT hand's bind frame
 *               (e.g. 'Index1' → from Index1 to Index2)
 * @returns Map jointName ('lIndex1' …) → THREE.Quaternion (local, bind-relative)
 */
export function handQuats(pose, side, dirOf) {
  const out = new Map();
  const mirror = q => side === 'r' ? new THREE.Quaternion(q.x, -q.y, -q.z, q.w) : q;
  const axisAngle = (a, deg) => new THREE.Quaternion().setFromAxisAngle(a, deg * D);
  const heading = n => { const d = dirOf(n); return Math.atan2(d.z, d.x) / D; };
  const mid = heading('Mid1');
  for (const [k, name] of Object.entries(FINGERS)) {
    const [c1, c2, c3, sp] = pose[k];
    [c1, c2, c3].forEach((c, i) => {
      const d = dirOf(name + (i + 1)).clone().setY(0).normalize();
      const curlAxis = new THREE.Vector3(d.z, 0, -d.x);                    // d × palm-normal(−Y)
      let q = axisAngle(curlAxis, c);
      // side by side: turn the finger to the middle finger's heading, a touch past it so the tips meet
      if (i === 0) q = axisAngle(Y, OUT[k] * sp + (pose.close ?? 0) * (heading(name + '1') - mid) * 1.12).multiply(q);
      out.set(side + name + (i + 1), mirror(q));
    });
  }
  const [opp, across, roll] = pose.t1;
  const d1 = dirOf('Thumb1').clone().normalize();
  const q1 = axisAngle(Y, across).multiply(axisAngle(X, opp)).multiply(axisAngle(d1, roll));
  out.set(side + 'Thumb1', mirror(q1));
  for (const [n, bend] of [['Thumb2', pose.t2], ['Thumb3', pose.t3]]) {
    const d = dirOf(n).clone().normalize();
    const ax = Y.clone().addScaledVector(d, -Y.dot(d)).normalize();        // palm normal, squared to the thumb
    out.set(side + n, mirror(axisAngle(ax, bend)));
  }
  return out;
}
