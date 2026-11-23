// The feather star's view: the calyx, the pinnules, the camera and the banded Soft skin. Its own
// file, as creature.html prefers for new creatures. build(THREE, body, mats) / skin(ctx) / apply(P)
// as in views.js.
//
// PINNULES are geometry in the arms' skinned mesh (no chains): ~800 little tapered prisms, one per
// brachial, alternating sides. Each is bound to a FOLD BONE, a twin of the arm bone it grows from
// whose world matrix is that arm bone's × a fold matrix F (set every frame in apply()). In the arm
// bone's own frame (x oral side, y back along the arm, z round the ring) a pinnule on side σ points
// along u = (sin v0, 0, σ cos v0), and pose() wants it along
//     u′ = (cos f · sin ψ,  −sin f,  σ cos f · cos ψ)      (f: P.parts.fold, toward the tip;
//                                                           ψ: P.parts.vee, lifted toward the oral side)
// One linear map does it for BOTH sides, because the sides differ only in the sign of z:
//     F x̂ = (cos f sin ψ, −sin f, 0) / sin v0,   F ŷ = ŷ,   F ẑ = (0, 0, cos f cos ψ / cos v0)
// F moves a point by how far it lies out along the pinnule, so every pinnule turns about its OWN
// base, wherever it sits on the segment, and one fold bone per arm bone folds them all. (A
// pinnule's own thickness is sheared along its length when it folds, where it does not show.)
// Pinnules near a joint blend two fold bones, as the arm skin blends two arm bones, so they stay on
// the arm when it coils.
// A fold bone is not a child of its arm bone (ctx.newBone makes a root): its updateMatrixWorld
// reads the arm bone's matrixWorld instead. creature.html adds chain roots to the mesh before
// extra roots, so the arm bones are already up to date when the fold bones are computed.
import { ARMS, AB, SHAPE } from './featherstar-def.js';

const PIN = { s0: 0.14, gap: 0.026, v0: 0.3, r: 0.0065 };   // first pinnule, spacing, bind V angle, radius
const pinLen = (s, len) => (0.2 + 0.1 * Math.exp(-s / 0.15)) * (1 - 0.45 * (s / len) * (s / len));
const A = SHAPE.arm;

// Placeholder black-and-white banding until the owner's photos: bands along the arms, each
// pinnule the colour of the band it grows from, its tip paler.
const GLSL = {
  uniforms: { uLight: [0.93, 0.92, 0.88], uDark: [0.045, 0.042, 0.05], uBand: [0.24, 0.42, 0.018] },
  head: `
// Arm tube: bind arclength from vSk.y (creature.html counts ∫ds/r along a linearly tapering tube).
const float ARM_LEN = ${A.len.toFixed(4)}, ARM_R0 = ${A.r0.toFixed(4)}, ARM_QR = ${(1 - A.r1 / A.r0).toFixed(5)};
float armS(float k) { return ARM_LEN * (1.0 - exp(-k * ARM_R0 * ARM_QR / ARM_LEN)) / ARM_QR; }
// 1 on a white band, 0 on a black one (uBand: period, white share, edge softness).
float bandW(float s) {
  float g = fract(s / uBand.x - 0.5 * uBand.y + 0.5) - 0.5;
  float w = smoothstep(0.5 * uBand.y + uBand.z / uBand.x, 0.5 * uBand.y - uBand.z / uBand.x, abs(g));
  return w * smoothstep(0.08, 0.16, s);   // dark where the arm leaves the cup
}`,
  surface: `
  if (uColour > 0.5 && vCustom.x > 0.5 && vCustom.x < 2.5) {
    bool pin = vCustom.x > 1.5;
    float s = pin ? vCustom.y : armS(vSk.y);
    vec3 c = mix(uDark, uLight, bandW(s));
    if (pin) c = mix(c, uLight * 0.9, 0.25 * smoothstep(0.5, 1.0, vCustom.z));
    diffuseColor.rgb = c * vTint;
    // Thin pinnules: a glossy highlight covers most of their width and greys out the dark ones.
    // roughnessFactor is three's own local (roughnessmap_fragment, declared before this point).
    if (pin) roughnessFactor = max(roughnessFactor, 0.85);
  }`,
};

export const VIEW = {
  camera: { pos: [3.8, 3.3, 8.8], target: [0, 1.5, 0] },
  floor: { color: 0x3a4246 },
  soft: { limb: 0xffffff, body: 0x161412, bodyClear: false, roughness: 0.55, clearcoat: 0.2, clearcoatRoughness: 0.4 },
  skinFx: { mottle: 0, bump: 0.12, glsl: GLSL },

  skin(ctx) {
    const { THREE, chains, boneAt, axisAt } = ctx, V = THREE.Vector3;
    const body = ctx.newBone(new V(0, 0, 0));   // the cup: never moves relative to the body

    // ---- Calyx: the centrodorsal knob (cirri), the cup, the rim where the arms leave, and the
    // oral disc on top with five pale food grooves running to the mouth.
    const prof = [];
    for (let i = 0; i <= 8; i++) { const th = 1.45 * i / 8; prof.push([Math.max(0.001, SHAPE.cdR * Math.sin(th)), SHAPE.cdY - SHAPE.cdR * Math.cos(th)]); }
    prof.push([0.09, 0.005], [0.112, 0.04], [SHAPE.rim + 0.003, SHAPE.rimY], [0.12, 0.094], [0.085, 0.113], [0.035, 0.124], [0.001, 0.126]);
    const lathe = new THREE.LatheGeometry(prof.map(([r, y]) => new THREE.Vector2(r, y)), 40);
    const LP = lathe.attributes.position, tintC = new Float32Array(LP.count * 3);
    const DARK = new THREE.Color(0x1a1714), DISC = new THREE.Color(0x3a2f28), GROOVE = new THREE.Color(0xd8d0c0), c = new THREE.Color();
    for (let i = 0; i < LP.count; i++) {
      const x = LP.getX(i), y = LP.getY(i), z = LP.getZ(i), r = Math.hypot(x, z);
      c.copy(DARK);
      if (y > SHAPE.rimY + 0.01) {
        c.lerp(DISC, 0.8);
        const a = Math.atan2(z, x) - Math.PI / 10, f = a / (Math.PI * 2 / 5);
        const d = Math.abs(f - Math.round(f)) * (Math.PI * 2 / 5) * r;   // distance from the nearest groove
        c.lerp(GROOVE, 0.7 * Math.exp(-(d * d) / (0.012 * 0.012)) * (r > 0.02 ? 1 : 0));
        if (r < 0.022) c.copy(DARK);                                      // the mouth
      }
      tintC.set([c.r, c.g, c.b], i * 3);
    }
    lathe.setAttribute('aTint', new THREE.BufferAttribute(tintC, 3));
    const rigid = [[body.index, 0, 0, 0], [1, 0, 0, 0]];
    ctx.addGeometry(lathe, () => rigid);

    // ---- Fold bones: one per arm bone, for both sides.
    const folds = [];   // [arm][bone] → bone index
    const twins = [];
    for (let j = 0; j < ARMS; j++) {
      const arm = chains[j], row = [];
      for (let i = 0; i <= AB; i++) {
        const t = ctx.newBone(new V()), ab = arm.bones[i], F = new THREE.Matrix4();
        t.bone.matrixAutoUpdate = false;
        t.bone.updateMatrixWorld = function () { this.matrixWorld.multiplyMatrices(ab.matrixWorld, F); };
        row.push(t.index); twins.push({ F, j, i });
      }
      folds.push(row);
    }

    // ---- Pinnules: tapered three-sided prisms, alternating sides, in a V toward the oral side.
    // In the arm's bind frame: ex oral side, ey along the arm (toward the root), ez round the ring.
    const pos = [], nrm = [], cus = [], ix = [], wts = [];
    const base = new V(), ex = new V(), ey = new V(), ez = new V(), ud = new V(), wo = new V(), p = new V(), n = new V();
    const NR = 4, NS = 3, cv = Math.cos(PIN.v0), sv = Math.sin(PIN.v0);
    for (let j = 0; j < ARMS; j++) {
      const arm = chains[j];
      ex.set(1, 0, 0).applyQuaternion(arm.q); ey.set(0, 1, 0).applyQuaternion(arm.q); ez.set(0, 0, 1).applyQuaternion(arm.q);
      for (let k = 0; ; k++) {
        const s = PIN.s0 + k * PIN.gap; if (s > arm.length - 0.05) break;
        const sg = k % 2 ? 1 : -1, u = s / arm.length, rA = A.r0 * (1 - u) + A.r1 * u, L = pinLen(s, arm.length);
        axisAt(arm, s, base);
        ud.copy(ez).multiplyScalar(sg * cv).addScaledVector(ex, sv);   // pinnule direction
        wo.copy(ex).multiplyScalar(cv).addScaledVector(ez, -sg * sv);  // its oral-side normal
        const b = boneAt(arm, s), i0 = b.i - arm.boneBase, i1 = b.b1 - arm.boneBase;
        const w = [[folds[j][i0], folds[j][i1], 0, 0], [1 - b.w1, b.w1, 0, 0]];
        const v0 = pos.length / 3;
        for (let m = 0; m < NR; m++) {
          const v = m / (NR - 1), d = rA * 0.4 + v * L, r = PIN.r * (1 - 0.8 * v);
          for (let q = 0; q < NS; q++) {
            const th = Math.PI * 2 * q / NS, cs = Math.cos(th), sn = Math.sin(th);
            n.copy(ey).multiplyScalar(cs).addScaledVector(wo, sn);
            p.copy(base).addScaledVector(ud, d).addScaledVector(wo, 0.12 * v * v * L).addScaledVector(n, r);   // curving up a little
            pos.push(p.x, p.y, p.z); nrm.push(n.x, n.y, n.z); cus.push(2, s, v, sg); wts.push(w);
          }
        }
        for (let m = 0; m < NR - 1; m++) for (let q = 0; q < NS; q++) {
          const a0 = v0 + m * NS + q, a1 = v0 + m * NS + (q + 1) % NS;
          ix.push(a0, a1, a0 + NS, a1, a1 + NS, a0 + NS);
        }
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    g.setAttribute('aCustom', new THREE.Float32BufferAttribute(cus, 4));
    g.setIndex(ix);
    ctx.addGeometry(g, vi => wts[vi]);
    return { twins };
  },

  build() { return { meshes: [] }; },

  // Fold matrices from the pose (see the top of this file): column-major, e[col·4 + row].
  apply(P, parts, sp) {
    const fold = P.parts.fold, vee = P.parts.vee;
    if (!fold || !sp.twins) return;
    const s0 = Math.sin(PIN.v0), c0 = Math.cos(PIN.v0);
    for (const T of sp.twins) {
      const f = fold[T.j * (AB + 1) + T.i], v = vee[T.j], cf = Math.cos(f), e = T.F.elements;
      e[0] = cf * Math.sin(v) / s0; e[1] = -Math.sin(f) / s0; e[2] = 0;
      e[8] = 0; e[9] = 0; e[10] = cf * Math.cos(v) / c0;
    }
  },
};
