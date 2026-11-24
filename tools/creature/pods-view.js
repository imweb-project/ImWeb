// The pods' view: the balls, their eyes and veins, the camera and the Soft skin. build(THREE, body,
// mats) / skin(ctx) / apply(P) as in views.js.
//
// BALL BONES. Each ball is one bone of this view's own, and its matrix is written whole, every
// frame, from P.parts.ball (pods-def.js): frame · squash · rocking is a shear, which a bone's
// position / turn / scale cannot hold, so the bone's updateMatrixWorld is replaced (as the feather
// star's fold bones are). All balls are BOUND AT THE ORIGIN, one on top of the other: the hair
// chains the engine has already built stand on a ball at the origin, so hanging each chain's root
// on its ball's bone here changes nothing at bind time, and afterwards the hair goes where the
// ball goes. (`parented` tells the engine the root already has a parent.)
//
// SOCKETS ARE IN THE MESH, EYES ARE PAINTED IN THEM. Every ball carries the same EYE_SITES. The
// ball's surface is pressed in at each one — a raised lip, a wall, and a domed floor (SOCKET) — and
// the skin shader finds the socket a bit of skin belongs to, draws the gold iris and bar pupil on
// its floor, shades the wall, and closes the lids when that eye's own blink comes round. Blinks
// are whole numbers per loop, so the loop stays a loop. (The Blender study this came from cut real
// holes in a shell and set a domed eye in each; this is one mesh per ball and no extra draw.)
//
// HAIR IS SIMULATED. A ball has HAIRS hairs; each is one thick strand in the same skinned mesh,
// bound along its own string of bones, and those bones are moved by simulate() below.
import { BALLS, HAIRS, BALL_R, EYE_SITES, HAIR_SITES, HAIR_LEN, HAIR_JOINTS, LOOP_SECONDS } from './pods-def.js';

const EYE_T = 0.72;    // the eye itself fills this share of its socket's radius; the rest is wall and lip

const f4 = v => v.toFixed(5);
const GLSL = {
  uniforms: { uBlinkAmt: 1, uIris: [1.0, 0.56, 0.16], uVein: [0.50, 0.34, 0.80] },
  head: `
const int POD_EYES = ${EYE_SITES.length};
const float EYE_T = ${EYE_T.toFixed(3)};
const vec4 POD_EYE[${EYE_SITES.length}] = vec4[${EYE_SITES.length}](
  ${EYE_SITES.map(e => `vec4(${f4(e.d[0])}, ${f4(e.d[1])}, ${f4(e.d[2])}, ${f4(e.rad)})`).join(',\n  ')});
// 1 / (1 − cos radius) per socket: (1 − cos angle) × this orders the sockets as angle / radius does,
// so the search below needs no acos (this shader runs on every pixel of every ball, back to front).
const float POD_INV[${EYE_SITES.length}] = float[${EYE_SITES.length}](${EYE_SITES.map(e => f4(1 / (1 - Math.cos(e.rad)))).join(', ')});
// The socket this bit of skin is nearest: (u, v across the eye, −1..1; t = distance from its centre
// in socket radii — the eye is t < EYE_T, the wall up to 1; its number). Worked out once per fragment and kept.
vec4 gPodEye = vec4(0.0, 0.0, -1.0, 0.0);
vec4 podEye() {
  if (gPodEye.z >= 0.0) return gPodEye;
  vec3 d = normalize(vBind); float bt = 1e9; int bi = 0;
  for (int k = 0; k < POD_EYES; k++) {
    float t = (1.0 - dot(d, POD_EYE[k].xyz)) * POD_INV[k];
    if (t < bt) { bt = t; bi = k; }
  }
  bt = acos(clamp(dot(d, POD_EYE[bi].xyz), -1.0, 1.0)) / POD_EYE[bi].w;
  vec3 e = POD_EYE[bi].xyz, rt = normalize(cross(vec3(0.02, 1.0, 0.01), e)), up = cross(e, rt);
  vec3 q = (d - e * dot(d, e)) / (sin(POD_EYE[bi].w) * EYE_T);
  gPodEye = vec4(dot(q, rt), dot(q, up), bt, float(bi));
  return gPodEye;
}
// How far this eye's lids are shut, 0..1. Each eye blinks a whole number of times a loop (3–7),
// at its own moment; uBlinkAmt is the share of eyes that blink at all.
float podLid(float eye, float ball) {
  float h = hash3(vec3(eye * 1.7 + 3.0, ball * 2.3 + 11.0, 5.0)), h2 = hash3(vec3(eye * 3.1 + 7.0, ball * 1.3 + 2.0, 9.0));
  if (hash3(vec3(eye + 0.5, ball + 0.5, 21.0)) > uBlinkAmt) return 0.0;
  float m = 3.0 + floor(h * 5.0), c = abs(fract(m * uPhase / 6.2831853 + h2) - 0.5) * 2.0, w = 0.028 * m;
  return smoothstep(1.0 - w, 1.0 - 0.4 * w, c);
}
// Veins: two nets of thin branching lines, a coarse one and a fine one, on a warped field.
float gPodVein = -1.0;
float podVeins() {
  if (gPodVein >= 0.0) return gPodVein;
  // Fine lines turn to grain once they are thinner than a pixel: they fade out with distance, and
  // from where they have gone the five noise lookups below are skipped.
  float near = smoothstep(0.03, 0.008, length(fwidth(vBind)));
  if (near <= 0.0) { gPodVein = 0.0; return 0.0; }
  vec3 p = normalize(vBind) * 2.2 + (vec3(vnoise(vBind * 5.0), vnoise(vBind * 5.0 + 9.0), vnoise(vBind * 5.0 + 17.0)) - 0.5) * 0.7;
  float a = 1.0 - abs(2.0 * vnoise(p * 2.1 + vCustom.z) - 1.0), b = 1.0 - abs(2.0 * vnoise(p * 5.3 + 3.0 + vCustom.z) - 1.0);
  gPodVein = max(smoothstep(0.90, 0.985, a), 0.6 * smoothstep(0.93, 0.99, b)) * near;
  return gPodVein;
}
float gPodOpen = -1.0;
float podOpen(vec4 E) {
  if (gPodOpen < 0.0) gPodOpen = (1.0 - podLid(E.w, vCustom.y)) * sqrt(max(0.0, 1.0 - E.x * E.x)) * 0.92;
  return gPodOpen;
}
float podHeight() {
  if (vCustom.x < 0.5 || vCustom.x > 1.5) return 0.0;
  vec4 E = podEye(); float h = 0.3 * podVeins() * smoothstep(1.0, 1.25, E.z);
  h -= 0.3 * smoothstep(1.05, EYE_T, E.z);                              // the wall, crisper than the mesh has it
  if (E.z < EYE_T && abs(E.y) >= podOpen(E)) h += 0.9;                  // the lids, standing proud of the eye
  return h;
}`,
  height: 'podHeight()',
  surface: `
  if (vCustom.x > 0.5 && vCustom.x < 1.5) {
    vec4 E = podEye();
    float vn = podVeins() * smoothstep(1.0, 1.25, E.z);
    if (uColour > 0.5) {
      diffuseColor.rgb = mix(diffuseColor.rgb, uVein, 0.62 * vn);
      diffuseColor.rgb *= mix(0.80, 1.0, smoothstep(EYE_T, 1.02, E.z));     // the socket's wall is in its own shade
    }
    if (E.z < EYE_T) {
      if (abs(E.y) < podOpen(E)) {
        float r = length(E.xy), an = atan(E.y, E.x);
        if (uColour > 0.5) {
          vec3 iris = uIris * (0.86 + 0.24 * vnoise(vec3(an * 7.0, r * 5.0, E.w * 3.0)));
          iris = mix(iris, vec3(1.0, 0.86, 0.45), 0.35 * smoothstep(0.5, 0.15, r));
          iris *= mix(1.0, 0.62, smoothstep(0.78, 1.0, r));
          // the octopus pupil: a dark bar, pinched in the middle, swollen at its ends
          float bar = smoothstep(0.03, -0.02, abs(E.y) - (0.035 + 0.10 * E.x * E.x)) * smoothstep(0.72, 0.60, abs(E.x));
          diffuseColor.rgb = mix(iris, vec3(0.012, 0.01, 0.015), bar);
        }
        roughnessFactor = 0.07;                                              // wet
      } else if (uColour > 0.5) {
        diffuseColor.rgb *= 0.86 + 0.14 * smoothstep(0.0, 0.25, abs(abs(E.y) - podOpen(E)));   // the lid's edge
      }
    }
    // soft and see-through: where the skin turns away from the eye it glows from inside, as thin
    // flesh does with light behind it (a true see-through skin would need the scene drawn twice)
    if (uColour > 0.5) {
      float rim = pow(1.0 - abs(dot(normalize(vViewPosition), normal)), 2.2);
      totalEmissiveRadiance += vec3(1.0, 0.42, 0.40) * 0.42 * rim;
      diffuseColor.rgb = mix(diffuseColor.rgb, vec3(1.0, 0.80, 0.78), 0.35 * rim);
    }
  } else if (vCustom.x > 1.5) {
    roughnessFactor = 0.85;                                                  // hair: matte, no wet glint
    if (uColour > 0.5) {   // faint bands along the hair, each hair starting its own way through them
      float band = smoothstep(-0.35, 0.35, sin(vCustom.y * 34.0 + vCustom.z * 6.2832));
      diffuseColor.rgb *= mix(vec3(1.0), vec3(0.45, 0.32, 0.55), 0.6 * band);
    }
  }`,
};

// Value noise for the lumps (the shader has its own; this one shapes the mesh).
function lump(x, y, z) {
  const h = (i, j, k) => { const s = Math.sin(i * 127.1 + j * 311.7 + k * 74.7) * 43758.5453; return s - Math.floor(s); };
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z), s = t => t * t * (3 - 2 * t);
  const fx = s(x - xi), fy = s(y - yi), fz = s(z - zi), L = (a, b, t) => a + (b - a) * t;
  return L(L(L(h(xi, yi, zi), h(xi + 1, yi, zi), fx), L(h(xi, yi + 1, zi), h(xi + 1, yi + 1, zi), fx), fy),
    L(L(h(xi, yi, zi + 1), h(xi + 1, yi, zi + 1), fx), L(h(xi, yi + 1, zi + 1), h(xi + 1, yi + 1, zi + 1), fx), fy), fz) - 0.5;
}
// Distance of direction (x, y, z) from the nearest socket's centre, in that socket's radii.
let eyeRad = 0.2;   // the angular radius of the socket eyeT last found nearest (socket() reads it)
function eyeT(x, y, z) {
  let t = 1e9;
  for (const e of EYE_SITES) { const v = Math.acos(Math.max(-1, Math.min(1, x * e.d[0] + y * e.d[1] + z * e.d[2]))) / e.rad; if (v < t) { t = v; eyeRad = e.rad; } }
  return t;
}
// SOCKET: the surface, as a share of the radius, across a socket — a raised lip just outside it,
// a wall down, and a floor that domes up again (the eyeball).
const sstep = (a, b, v) => { const t = Math.max(0, Math.min(1, (v - a) / (b - a))); return t * t * (3 - 2 * t); };
function socket(t) {
  if (t > 2.0) return 0;
  // the flesh round an eye swells into a mound (higher for a bigger eye), so the eye stands out
  // from the ball on its own bulb; a shallow crease marks where the lids meet the eyeball
  const mound = 0.62 * eyeRad * sstep(2.0, 0.8, t);
  const crease = -0.018 * Math.exp(-(((t - 0.86) / 0.10) ** 2));
  const dome = t < EYE_T ? 0.075 * (1 - (t / EYE_T) ** 2) : 0;
  return mound + crease + dome;
}
const surfR = (x, y, z) => BALL_R * (1 + 0.07 * lump(x * 1.7 + 3.1, y * 1.7, z * 1.7) + 0.02 * lump(x * 4.3, y * 4.3 + 5.0, z * 4.3) + socket(eyeT(x, y, z)));

export const VIEW = {
  camera: { pos: [9.0, 10.5, 9.0], target: [0, 1.7, 0] },   // three-quarters from above, as the study was filmed
  pixelRatio: 1.25,       // the test page: this creature covers much of a large screen (a host renders at its own size)
  background: 0xc6c6c0,   // the pale grey of the study (the test page's backdrop; a host has its own)
  soft: { limb: 0xfde0d9, body: 0x222222, bodyClear: false, roughness: 0.32, clearcoat: 0, clearcoatRoughness: 0.4,
    // side 0 = FrontSide: balls and strands are closed, and with 48 balls overlapping, shading the
    // backs as well doubled the cost of every pixel. (A sheen was tried for softness: too dear here.)
    limbProps: { side: 0 } },
  skinFx: { mottle: 0.03, bump: 0.04, glsl: GLSL },

  skin(ctx) {
    const { THREE } = ctx, V = THREE.Vector3;
    // ---- One lumpy, socketed ball, added once per ball with that ball's number on it. (A short
    // shell-fur down between the eyes was tried: it read as grain from any distance and cost six
    // more draws.)
    const g = new THREE.SphereGeometry(1, 52, 34), Pp = g.attributes.position, Nn = g.attributes.normal;
    const cus = new Float32Array(Pp.count * 4);
    const d = new V(), t1 = new V(), t2 = new V(), p0 = new V(), p1 = new V(), p2 = new V(), E = 0.012;
    const at = (v, out) => out.copy(v).normalize().multiplyScalar(surfR(v.x, v.y, v.z));
    for (let i = 0; i < Pp.count; i++) {
      d.fromBufferAttribute(Pp, i).normalize();
      // the normal of the surface, from two nearby points (the sphere's own seam and poles would
      // show if the normals were averaged from its triangles)
      t1.set(d.y, -d.x, 0); if (t1.lengthSq() < 1e-4) t1.set(0, d.z, -d.y); t1.normalize(); t2.crossVectors(d, t1);
      at(d, p0); at(p1.copy(d).addScaledVector(t1, E).normalize(), p1); at(p2.copy(d).addScaledVector(t2, E).normalize(), p2);
      p1.sub(p0); p2.sub(p0); t1.crossVectors(p1, p2).normalize(); if (t1.dot(d) < 0) t1.negate();
      Pp.setXYZ(i, p0.x, p0.y, p0.z); Nn.setXYZ(i, t1.x, t1.y, t1.z);
    }
    g.setAttribute('aCustom', new THREE.BufferAttribute(cus, 4));

    // ---- One ball's hair, in the ball's own frame: per guide a tuft of strands rooted on the skin
    // round it (never in a socket), each a fine three-sided tube leaning a little toward its guide.
    let seed = 2027; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const NR = 25, NS = 5, hp = [], hn = [], ht = [], hc = [], hi = [], hs = [], hg = [];
    const gd = new V(), sd = new V(), ax = new V(), ex = new V(), ey = new V(), q = new V(), n = new V();
    const ROOT = new THREE.Color(0.85, 0.54, 0.50), TIP = new THREE.Color(1.02, 0.87, 0.82), col = new THREE.Color();
    HAIR_SITES.forEach((H, h) => {
      gd.set(H.d[0], H.d[1], H.d[2]); sd.copy(gd); ax.copy(gd);   // one strand per hair, on its guide, straight out of the skin
      {
        const L = HAIR_LEN * (0.8 + 0.2 * rnd()), r0 = 0.020 + 0.006 * rnd(), kink = (rnd() - 0.5) * 0.05, v0 = hp.length / 3;
        ex.set(ax.y, -ax.x, 0); if (ex.lengthSq() < 1e-4) ex.set(0, ax.z, -ax.y); ex.normalize(); ey.crossVectors(ax, ex);
        const base = surfR(sd.x, sd.y, sd.z) * 0.97, r = rnd();
        for (let m = 0; m < NR; m++) {
          const u = m / (NR - 1), s = L * u, rad = r0 * (1 - 0.65 * u);
          col.copy(ROOT).lerp(TIP, Math.pow(u, 0.7));
          for (let j = 0; j < NS; j++) {
            const an = Math.PI * 2 * j / NS; n.copy(ex).multiplyScalar(Math.cos(an)).addScaledVector(ey, Math.sin(an));
            q.copy(sd).multiplyScalar(base).addScaledVector(ax, s).addScaledVector(ex, kink * s * u).addScaledVector(n, rad);
            hp.push(q.x, q.y, q.z); hn.push(n.x, n.y, n.z); ht.push(col.r, col.g, col.b); hc.push(2, u, r, 0); hs.push(s); hg.push(h);
          }
        }
        for (let m = 0; m < NR - 1; m++) for (let j = 0; j < NS; j++) {
          const a0 = v0 + m * NS + j, a1 = v0 + m * NS + (j + 1) % NS;
          hi.push(a0, a1, a0 + NS, a1, a1 + NS, a0 + NS);
        }
      }
    });
    const hair = new THREE.BufferGeometry();
    hair.setAttribute('position', new THREE.Float32BufferAttribute(hp, 3));
    hair.setAttribute('normal', new THREE.Float32BufferAttribute(hn, 3));
    hair.setAttribute('aTint', new THREE.Float32BufferAttribute(ht, 3));
    hair.setAttribute('aCustom', new THREE.Float32BufferAttribute(hc, 4));
    hair.setIndex(hi);

    // ---- The hair simulation's store: every guide is a string of NP points with weight (see
    // simulate). Its bones are the view's own, bound standing straight out of a ball at the origin;
    // the simulation writes each bone's matrix itself, so the engine neither poses nor springs them.
    const NC = BALLS * HAIRS;
    const sim = { ready: false, pos: new Float32Array(NC * NP * 3), prev: new Float32Array(NC * NP * 3), mats: new Array(NC * NP), phase: 0, seg: new Float32Array(NC),
      q: new THREE.Quaternion(), qd: new THREE.Quaternion(), qb: new THREE.Quaternion(), m: new THREE.Matrix4(),
      v: new V(), d: new V(), cur: new V(), sc: new V() };
    const balls = [], wts = new Array(hs.length), hv = new V();
    for (let b = 0; b < BALLS; b++) {
      const nb = ctx.newBone(new V(0, 0, 0)), bone = nb.bone, M = new THREE.Matrix4();
      bone.matrixAutoUpdate = false;
      bone.updateMatrixWorld = function () { this.matrixWorld.multiplyMatrices(this.parent.matrixWorld, M); };
      for (let i = 0; i < Pp.count; i++) cus.set([1, b, (b * 7.31) % 13, 0], i * 4);
      const rigid = [[nb.index, 0, 0, 0], [1, 0, 0, 0]];
      ctx.addGeometry(g, () => rigid);
      const first = [];
      for (let h = 0; h < HAIRS; h++) for (let j = 0; j < NP; j++) {
        const D = HAIR_SITES[h].d, r = BALL_R + SEG * j, hb = ctx.newBone(hv.set(D[0] * r, D[1] * r, D[2] * r));
        hb.bone.matrixAutoUpdate = false; hb.bone.updateMatrix();
        sim.mats[(b * HAIRS + h) * NP + j] = hb.bone.matrix; if (j === 0) first.push(hb.index);
      }
      // each strand vertex follows its guide's bones at the distance it has reached along the hair
      for (let v = 0; v < hs.length; v++) {
        const x = Math.min(hs[v], HAIR_LEN * 0.999) / SEG, i = Math.floor(x), f = x - i, i0 = first[hg[v]] + i;
        wts[v] = f < 0.5 ? [[i0, i0 + (i > 0 ? -1 : 0), 0, 0], [0.5 + f, 0.5 - f, 0, 0]] : [[i0, i0 + 1, 0, 0], [1.5 - f, f - 0.5, 0, 0]];
      }
      ctx.addGeometry(hair, v => wts[v]);
      balls.push(M);
    }
    g.dispose(); hair.dispose();
    return { balls, sim };
  },

  build() { return { meshes: [] }; },

  apply(P, parts, sp) {
    const a = P.parts.ball; if (!a || !sp.balls) return;
    for (let b = 0; b < BALLS; b++) {
      const o = b * 12;
      sp.balls[b].set(a[o], a[o + 1], a[o + 2], a[o + 9], a[o + 3], a[o + 4], a[o + 5], a[o + 10], a[o + 6], a[o + 7], a[o + 8], a[o + 11], 0, 0, 0, 1);
    }
    if (P.parts.sim) simulate(a, P.parts.sim, sp.sim);
  },
};

// ---- THE HAIR SIMULATION. Each guide is a string of points with weight, in the creature's own
// space, so a hair keeps going when its ball stops, trails when the ball travels or turns, hangs
// under its weight and drapes over the balls instead of passing through them. Per step:
//   1. every free point coasts on its own speed, slowed by the water, pulled by weight and current;
//   2. it is drawn a little toward continuing straight on from the two points before it (the
//      hair's own stiffness: strong at the root, almost none at the tip);
//   3. it is put back at its fixed distance from the point before it (a hair does not stretch);
//   4. it is pushed out of its own ball and the neighbours either side.
// The first two points are held by the ball, so a hair leaves the skin the way it grows.
// State carries over from frame to frame, so the first loop after a change differs a little.
const NP = HAIR_JOINTS + 1, SEG = HAIR_LEN / HAIR_JOINTS;   // points on a guide, and the rest distance between them
const SUB = 1, ITER = 3, REACH = 2;   // steps per frame, passes of 2–4 per step (4 from the second pass on), neighbour balls each side
const SET = 0.9, BEND = 1, GR = 2.8, BEAD = 0.22;   // how firmly a hair holds its set, resists kinks, and how heavy it is
const cR = new Float32Array(BALLS), cS = new Float32Array(BALLS), hit = new Uint8Array(16);
function simulate(a, par, sim) {
  const { pos, prev, mats, q, qd, qb, m, v, d, cur, sc } = sim;
  const phase = Math.atan2(par[0], par[5]), grav = par[1], drag = par[2], flow = par[3], hairLen = par[4];
  let dph = phase - sim.phase; dph -= Math.PI * 2 * Math.round(dph / (Math.PI * 2)); sim.phase = phase;
  const dt = Math.min(0.05, Math.abs(dph) / (Math.PI * 2) * LOOP_SECONDS);
  const first = !sim.ready; sim.ready = true;
  const steps = first ? 1 : dt > 1e-5 ? SUB : 0, h = dt / SUB;
  const keep = Math.exp(-(2.5 + 4 * drag) * h), h2 = h * h, G = -GR * grav;
  for (let b = 0; b < BALLS; b++) {
    const o = b * 12;
    const det = a[o] * (a[o + 4] * a[o + 8] - a[o + 5] * a[o + 7]) - a[o + 1] * (a[o + 3] * a[o + 8] - a[o + 5] * a[o + 6]) + a[o + 2] * (a[o + 3] * a[o + 7] - a[o + 4] * a[o + 6]);
    cS[b] = Math.cbrt(Math.abs(det)); cR[b] = cS[b] * BALL_R * 0.99;
  }
  for (let b = 0; b < BALLS; b++) {
    const o = b * 12, s = cS[b], cx = a[o + 9], cy = a[o + 10], cz = a[o + 11];
    // the ball's turning without its squash: its three axes made square again
    let x0 = a[o], x1 = a[o + 3], x2 = a[o + 6], y0 = a[o + 1], y1 = a[o + 4], y2 = a[o + 7];
    let l = Math.hypot(x0, x1, x2) || 1; x0 /= l; x1 /= l; x2 /= l;
    const dt0 = x0 * y0 + x1 * y1 + x2 * y2; y0 -= dt0 * x0; y1 -= dt0 * x1; y2 -= dt0 * x2;
    l = Math.hypot(y0, y1, y2) || 1; y0 /= l; y1 /= l; y2 /= l;
    const z0 = x1 * y2 - x2 * y1, z1 = x2 * y0 - x0 * y2, z2 = x0 * y1 - x1 * y0;
    m.set(x0, y0, z0, 0, x1, y1, z1, 0, x2, y2, z2, 0, 0, 0, 0, 1);
    qb.setFromRotationMatrix(m);
    // the current where this ball is: a slow gust crossing the scene, the same after one loop
    const g1 = Math.sin(phase - 0.9 * cx + 0.6 * cz), g3 = Math.sin(3 * phase - 0.9 * cx + 0.6 * cz);
    const wx = flow * 4.5 * (0.7 * g1 + 0.3 * g3), wz = flow * 2.7 * Math.sin(2 * phase + 0.7 * cx);
    for (let hh = 0; hh < HAIRS; hh++) {
      const k = b * HAIRS + hh, D0 = HAIR_SITES[hh].d, base = k * NP * 3, seg = SEG * s * hairLen;
      // the root on the skin, and the way the hair grows out of it
      const rpx = D0[0] * BALL_R, rpy = D0[1] * BALL_R, rpz = D0[2] * BALL_R;
      const r0x = a[o] * rpx + a[o + 1] * rpy + a[o + 2] * rpz + cx, r0y = a[o + 3] * rpx + a[o + 4] * rpy + a[o + 5] * rpz + cy,
        r0z = a[o + 6] * rpx + a[o + 7] * rpy + a[o + 8] * rpz + cz;
      const gx = x0 * D0[0] + y0 * D0[1] + z0 * D0[2], gy = x1 * D0[0] + y1 * D0[1] + z1 * D0[2], gz = x2 * D0[0] + y2 * D0[1] + z2 * D0[2];
      // which balls this hair can lie on: not one its own root is buried in (neighbours overlap, and
      // a hair cannot be pushed out of a ball it grows inside)
      for (let n = -REACH; n <= REACH; n++) {
        const no = ((b + n + BALLS) % BALLS) * 12, R = cR[(b + n + BALLS) % BALLS] * 1.04;
        const ex = r0x + gx * 0.02 - a[no + 9], ey = r0y + gy * 0.02 - a[no + 10], ez = r0z + gz * 0.02 - a[no + 11];
        hit[n + REACH] = n === 0 || ex * ex + ey * ey + ez * ez > R * R ? 1 : 0;
      }
      // A ball shrunk to a bead has hairs too short to see moving: they are not simulated (half the
      // balls are beads at any moment, so this is half the work) but carried along with their root,
      // keeping the shape they had — laid straight instead, a hair would start every swell as a rod.
      const bead = s < BEAD;
      if (bead && !first) {
        const dx = r0x - pos[base], dy = r0y - pos[base + 1], dz = r0z - pos[base + 2], k0 = seg / (sim.seg[k] || seg);
        for (let j = 0; j < NP; j++) {   // … easing toward standing out of the bead as it turns, so it is not left pointing the old way
          const i = base + j * 3, D = seg * j;
          pos[i] = prev[i] = r0x + (pos[i] + dx - r0x) * k0 * 0.985 + gx * D * 0.015; pos[i + 1] = prev[i + 1] = r0y + (pos[i + 1] + dy - r0y) * k0 * 0.985 + gy * D * 0.015;
          pos[i + 2] = prev[i + 2] = r0z + (pos[i + 2] + dz - r0z) * k0 * 0.985 + gz * D * 0.015;
        }
        sim.seg[k] = seg;
      }
      if (first) for (let j = 0, D = 0; j < NP; j++) {
        const i = base + j * 3; pos[i] = prev[i] = r0x + gx * D; pos[i + 1] = prev[i + 1] = r0y + gy * D; pos[i + 2] = prev[i + 2] = r0z + gz * D;
        D += seg;
      }
      // A hair grows and shrinks with its ball. Its points are moved out or in to the new length
      // first (and their memory with them, so this adds no speed): left to the length rule alone, a
      // growing hair buckles into a zigzag, each link lengthening before the next has made room.
      if (!first && steps && !bead) {
        const k0 = seg / (sim.seg[k] || seg), ox = pos[base], oy = pos[base + 1], oz = pos[base + 2];
        if (k0 !== 1) for (let j = 1; j < NP; j++) {
          const i = base + j * 3;
          pos[i] = ox + (pos[i] - ox) * k0; pos[i + 1] = oy + (pos[i + 1] - oy) * k0; pos[i + 2] = oz + (pos[i + 2] - oz) * k0;
          prev[i] = ox + (prev[i] - ox) * k0; prev[i + 1] = oy + (prev[i + 1] - oy) * k0; prev[i + 2] = oz + (prev[i + 2] - oz) * k0;
        }
      }
      if (first || steps) sim.seg[k] = seg;
      for (let st = 0; st < steps && !bead; st++) {
        // 1. coast, slowed by the water, pulled by weight and current
        for (let j = 2; j < NP; j++) {
          const i = base + j * 3;
          let vx = (pos[i] - prev[i]) * keep, vy = (pos[i + 1] - prev[i + 1]) * keep, vz = (pos[i + 2] - prev[i + 2]) * keep;
          const sp2 = vx * vx + vy * vy + vz * vz; if (sp2 > 0.0025) { const f = 0.05 / Math.sqrt(sp2); vx *= f; vy *= f; vz *= f; }   // a jump of the ball does not fling the hair
          prev[i] = pos[i]; prev[i + 1] = pos[i + 1]; prev[i + 2] = pos[i + 2];
          pos[i] += vx + wx * h2; pos[i + 1] += vy + G * h2; pos[i + 2] += vz + wz * h2;
        }
        // the two points the ball holds
        pos[base] = r0x; pos[base + 1] = r0y; pos[base + 2] = r0z;
        pos[base + 3] = r0x + gx * seg; pos[base + 4] = r0y + gy * seg; pos[base + 5] = r0z + gz * seg;
        for (let it = 0; it < ITER; it++) for (let j = 2; j < NP; j++) {
          const i = base + j * 3, p1 = i - 3;
          let px = pos[i], py = pos[i + 1], pz = pos[i + 2];
          const u = j / (NP - 1);
          // 2a. the hair's set: once a step, toward where it would be if it stood straight out of
          // the skin — firmly near the root, hardly at all at the tip
          if (it === 0) {
            const D = seg * j, w = 1 - Math.exp(-(SET * (1 - u) * (1 - u) * (1 - u) + 0.04) * h);
            px += (r0x + gx * D - px) * w; py += (r0y + gy * D - py) * w; pz += (r0z + gz * D - pz) * w;
          }
          // 2b. no kinks: toward the middle of its two neighbours (stiffer near the root). Smoothing
          // only ever calms a hair; aiming each point "straight on" from the two before it was
          // tried first and shook the tips into a zigzag.
          if (j < NP - 1) {
            // … in proportion to how sharp the bend is: a gentle curve is left alone (smoothing it
            // too turns a soft hair into a spine), a kink is ironed out
            const n1 = i + 3, mx = (pos[p1] + pos[n1]) * 0.5 - px, my = (pos[p1 + 1] + pos[n1 + 1]) * 0.5 - py, mz = (pos[p1 + 2] + pos[n1 + 2]) * 0.5 - pz;
            const kk = (mx * mx + my * my + mz * mz) / (0.09 * seg * seg), al = (0.02 + 0.6 * (kk > 1 ? 1 : kk)) * BEND;
            px += mx * al; py += my * al; pz += mz * al;
          }
          // 3. length, shared between the two points it joins (the held ones do not give)
          let ex = px - pos[p1], ey = py - pos[p1 + 1], ez = pz - pos[p1 + 2], el = Math.sqrt(ex * ex + ey * ey + ez * ez) || 1e-6, f = (el - seg) / el;
          if (j === 2) { px -= ex * f; py -= ey * f; pz -= ez * f; }
          else { f *= 0.5; px -= ex * f; py -= ey * f; pz -= ez * f; pos[p1] += ex * f; pos[p1 + 1] += ey * f; pos[p1 + 2] += ez * f; }
          // 4. out of the balls
          if (it > 0) for (let n = -REACH; n <= REACH; n++) {
            if (!hit[n + REACH]) continue;
            const nb = (b + n + BALLS) % BALLS, no = nb * 12, R = cR[nb];
            ex = px - a[no + 9]; ey = py - a[no + 10]; ez = pz - a[no + 11]; el = ex * ex + ey * ey + ez * ez;
            if (el < R * R) { el = Math.sqrt(el) || 1e-6; f = (R / el - 1) * 0.4; px += ex * f; py += ey * f; pz += ez * f; }   // eased out, not snapped: a snap is a twitch
          }
          pos[i] = px; pos[i + 1] = py; pos[i + 2] = pz;
        }
        // 5. what stretch is left is taken out from the root outward — moving the point's memory
        // with it, so this tidying-up adds no speed (it is what makes a dragged string whip)
        for (let j = 2; j < NP; j++) {
          const i = base + j * 3, p1 = i - 3;
          const ex = pos[i] - pos[p1], ey = pos[i + 1] - pos[p1 + 1], ez = pos[i + 2] - pos[p1 + 2], f = seg / (Math.sqrt(ex * ex + ey * ey + ez * ez) || 1e-6) - 1;
          pos[i] += ex * f; pos[i + 1] += ey * f; pos[i + 2] += ez * f; prev[i] += ex * f; prev[i + 1] += ey * f; prev[i + 2] += ez * f;
        }
      }
      // ---- the bones: bone 0 is the ball's own (squash and all, so roots stay on the skin); the
      // rest sit on the points, each turned the least it takes to follow the hair from the one before
      const e = mats[k * NP].elements;
      e[0] = a[o]; e[1] = a[o + 3]; e[2] = a[o + 6]; e[3] = 0; e[4] = a[o + 1]; e[5] = a[o + 4]; e[6] = a[o + 7]; e[7] = 0;
      e[8] = a[o + 2]; e[9] = a[o + 5]; e[10] = a[o + 8]; e[11] = 0; e[12] = r0x; e[13] = r0y; e[14] = r0z; e[15] = 1;
      sc.set(s, s, s); q.copy(qb); cur.set(gx, gy, gz);
      for (let j = 1; j < NP; j++) {
        const i = base + j * 3;
        if (j > 1 && j < NP - 1) {   // the first two bones are the ball's: a tuft's foot stays put on the skin
          d.set(pos[i + 3] - pos[i], pos[i + 4] - pos[i + 1], pos[i + 5] - pos[i + 2]);
          if (d.lengthSq() > 1e-12) { d.normalize(); qd.setFromUnitVectors(cur, d); q.premultiply(qd); cur.copy(d); }
        }
        mats[k * NP + j].compose(v.set(pos[i], pos[i + 1], pos[i + 2]), q, sc);
      }
    }
  }
}
