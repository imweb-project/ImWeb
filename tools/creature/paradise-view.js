// The Western parotia's view: the feathered surfaces hung on paradise-def.js's chains, the eyes,
// the camera, the Soft skin and the breast shield's structural colour. Its own file, as
// creature.html prefers. skin(ctx) builds everything into the one skinned mesh; build/apply as in
// views.js.
//
// Feathers are skin, not bones: the skirt is ONE sheet over sixteen ribs, the tail and folded
// wings are feather cards on short chains, the racquets are cards on the wire tips. Each surface
// carries aCustom.x, an id the shader code below reads:
//   0 velvet (body, head, neck, wings, tail)   1 breast shield   2 skirt   3 racquet
//   4 forehead tuft   5 bill   6 legs and toes   7 wire shafts
import { SHAPE } from './paradise-def.js';

// Structural colour of the breast shield (thin-film-like, after Stavenga et al. 2011 on Parotia
// lawesii: the barbules reflect gold to yellow-green face on, turning blue to violet at a slant).
// Each scale is a small tilted mirror, so neighbours sit at different points of the ramp and the
// shield breaks into a mosaic that shifts as the bird or the camera moves.
const HEAD = `
vec3 paroRamp(float h) {
  h = clamp(h, 0.0, 1.0) * 5.0;
  vec3 c = mix(vec3(1.0, 0.48, 0.08), vec3(0.88, 0.86, 0.12), clamp(h, 0.0, 1.0));
  c = mix(c, vec3(0.32, 0.92, 0.22), clamp(h - 1.0, 0.0, 1.0));
  c = mix(c, vec3(0.06, 0.78, 0.78), clamp(h - 2.0, 0.0, 1.0));
  c = mix(c, vec3(0.14, 0.3, 1.0), clamp(h - 3.0, 0.0, 1.0));
  return mix(c, vec3(0.5, 0.14, 0.88), clamp(h - 4.0, 0.0, 1.0));
}
`;
const SURFACE = `
  float pid = floor(vCustom.x + 0.5);
  vec3 pV = normalize(vViewPosition), pL = normalize(vec3(0.3, 1.0, 0.5));
  #if NUM_DIR_LIGHTS > 0
  pL = directionalLights[0].direction;          // the key light (it casts the shadow, so it sorts first)
  #endif
  vec3 pH = normalize(pL + pV);
  float pnv = clamp(dot(normal, pV), 0.0, 1.0), pnh = clamp(dot(normal, pH), 0.0, 1.0);
  if (pid == 2.0) {
    // Skirt: one plume per strip round the disc, each tip its own length (every skin: the outline)
    // The rim: a nearly even edge of fine plume tips, a few longer strands breaking it (photos:
    // soft, not a comb). Two scales of tips, so the edge has no single repeating tooth.
    float pl = vCustom.z * 220.0 + 0.5 * sin(vCustom.z * 37.0), pc = fract(pl), pn = floor(pl);
    float pl2 = vCustom.z * 61.0, pn2 = floor(pl2), pc2 = fract(pl2);
    float tip = 0.955 + 0.03 * hash3(vec3(pn, 3.0, 11.0)) - 0.035 * pow(abs(2.0 * pc - 1.0), 1.2)
              - 0.03 * smoothstep(0.55, 0.95, hash3(vec3(pn2, 5.0, 2.0))) * pow(abs(2.0 * pc2 - 1.0), 2.0)
              + 0.02 * step(0.9, hash3(vec3(pn, 8.0, 4.0)));
    if (vCustom.y > tip) discard;
    if (uColour > 0.5) {
      float ridge = 1.0 - abs(2.0 * fract(vCustom.z * 70.0 + 0.3 * sin(vCustom.y * 6.0)) - 1.0);   // plume shafts, gently wavy
      diffuseColor.rgb *= (0.9 + 0.15 * ridge) * (1.0 - 0.35 * smoothstep(0.9, 0.99, vCustom.y));     // tips a shade darker
      totalEmissiveRadiance += vec3(0.025, 0.03, 0.1) * pow(pnh, 10.0) * (0.4 + 0.6 * ridge) * smoothstep(0.05, 0.4, vCustom.y);
    }
  } else if (pid == 1.0) {
    // Shield: staggered rows of scales, dark between them, the bottom edge scalloped
    // scales overlap like roof tiles: each row's rounded tips over the bases of the row below
    vec2 g = vec2(vCustom.y, -vCustom.z) * 78.0;
    float row = floor(g.y);
    g.x += 0.5 * mod(row, 2.0);
    vec2 cell = floor(g), f = fract(g) - vec2(0.5, 0.0);
    float hs = hash3(vec3(cell, row * 0.37 + 3.1));
    float tipD = length(vec2(f.x * 1.1, (f.y - 0.45) * 1.0));     // distance from this scale's tip centre
    float gap = smoothstep(0.5, 0.62, tipD) * smoothstep(0.62, 0.75, length(vec2(abs(f.x) - 0.5, f.y - 0.95)));
    float shade = 0.65 + 0.35 * smoothstep(0.0, 0.8, f.y);       // a scale darkens toward its covered base
    if (vCustom.w > 0.9 && tipD > 0.5) discard;                  // the lower edge ends in scale tips
    if (uColour > 0.5) {
      float hue = 0.1 + 0.85 * (1.0 - pnv) + 0.3 * (1.0 - pnh) + 0.1 * (hs - 0.5) + 0.06 * f.y;
      float glint = 0.2 + 1.7 * pow(pnh, 14.0) * (0.6 + 0.8 * hs) + 0.3 * (1.0 - pnv);
      vec3 c = paroRamp(hue) * shade * (1.0 - 0.85 * gap);
      diffuseColor.rgb = c * 0.15;
      totalEmissiveRadiance += c * glint * 0.55 * uFlash;
      roughnessFactor = 0.28;
    }
  } else if (uColour > 0.5) {
    if (pid == 3.0) { diffuseColor.rgb *= 0.5; roughnessFactor = 0.55; }                 // racquets: glossy black
    else if (pid == 4.0) {                                                             // tuft: silvery white
      diffuseColor.rgb = vec3(0.86, 0.86, 0.82); roughnessFactor = 0.45;
      totalEmissiveRadiance += vec3(0.22, 0.2, 0.14) * pow(pnh, 8.0);
    }
    else if (pid == 5.0) roughnessFactor = 0.3;                                        // bill
    else if (pid == 6.0) roughnessFactor = 0.55;                                       // scaly legs
    else if (pid == 7.0) roughnessFactor = 0.35;                                       // wire shafts
  }
`;

export const VIEW = {
  camera: { pos: [2.55, 1.45, 3.1], target: [0, 0.8, 0] },
  floor: { color: 0x4b3b2b },
  // Velvet black: rough, no clearcoat, a blue-violet sheen at the grazing edge (the plumage absorbs
  // nearly all light; what reads is the rim and the structural colours).
  soft: { limb: 0xffffff, body: 0x111111, bodyClear: false, roughness: 0.72, clearcoat: 0, clearcoatRoughness: 0.5,
    limbProps: { sheen: 1, sheenColor: 0x131430, sheenRoughness: 0.5 } },
  skinFx: { mottle: 0, bump: 0.1, glsl: { uniforms: { uFlash: 1 }, head: HEAD, surface: SURFACE } },

  skin(ctx) {
    const { THREE, chains, boneAt, axisAt } = ctx, TAUv = Math.PI * 2, SH = SHAPE;
    const cl = (x, a, b) => Math.min(b, Math.max(a, x));
    const ssv = (a, b, x) => { const t = cl((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
    const V = (x, y, z) => new THREE.Vector3(x, y, z);
    const BLACK = new THREE.Color(0x070609), WHITE = new THREE.Color(1, 1, 1);
    // A grid of (NU+1) × (NV+1) points; closed: column NV repeats column 0 (normals averaged).
    // at(m, q) → { p: Vector3, c: Color, k: [id, a, b, c] (aCustom), w: [[bones], [weights]] }
    const sheet = (NU, NV, at, closed) => {
      const p = [], tint = [], cus = [], wts = [], ix = [];
      for (let m = 0; m <= NU; m++) for (let q = 0; q <= NV; q++) {
        const r = at(m, q); p.push(r.p.x, r.p.y, r.p.z); tint.push(r.c.r, r.c.g, r.c.b); cus.push(...r.k); wts.push(r.w);
      }
      for (let m = 0; m < NU; m++) for (let q = 0; q < NV; q++) {
        const a = m * (NV + 1) + q; ix.push(a, a + NV + 1, a + 1, a + 1, a + NV + 1, a + NV + 2);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3)); g.setIndex(ix); g.computeVertexNormals();
      if (closed) {
        const N = g.attributes.normal, n1 = V(), n2 = V();
        for (let m = 0; m <= NU; m++) {
          const a0 = m * (NV + 1), b0 = a0 + NV;
          n1.fromBufferAttribute(N, a0).add(n2.fromBufferAttribute(N, b0)).normalize();
          N.setXYZ(a0, n1.x, n1.y, n1.z); N.setXYZ(b0, n1.x, n1.y, n1.z);
        }
      }
      g.setAttribute('aTint', new THREE.Float32BufferAttribute(tint, 3));
      g.setAttribute('aCustom', new THREE.Float32BufferAttribute(cus, 4));
      ctx.addGeometry(g, vi => wts[vi]);
    };
    const rigid = b => [[b, 0, 0, 0], [1, 0, 0, 0]];
    const along = (ch, s) => { const k = boneAt(ch, cl(s, 0, ch.length - 1e-4)); return [[k.i, k.b1, 0, 0], [1 - k.w1, k.w1, 0, 0]]; };
    const axes = q => ({ x: V(1, 0, 0).applyQuaternion(q), y: V(0, 1, 0).applyQuaternion(q), z: V(0, 0, 1).applyQuaternion(q) });

    const trunk = chains[0], neck = chains[1], head = chains[2], tail = chains[13];
    const wings = [chains[14], chains[15]], wires = chains.slice(16, 22), ribs = chains.slice(22, 22 + SH.NRIB);

    // ---- Body: an egg round the trunk axis, rump to the base of the neck. Trunk frame: +x the
    // back, −x the breast, +z the right. Its top blends onto the neck's first bones, so the neck
    // tube grows out of it without a crease.
    const tA = axes(trunk.q);
    const rLat = s => s < 0.35 ? 0.165 * Math.sqrt(Math.max(0, 1 - ((0.35 - s) / 0.62) ** 2)) : 0.165 - 0.06 * ssv(0.35, 0.78, s);
    const rDor = s => 0.92 * rLat(s);
    const rVen = s => 1.06 * rLat(s) + 0.02 * Math.exp(-(((s - 0.45) / 0.15) ** 2));   // the breast
    const bodyW = s => {
      const a = boneAt(trunk, cl(s, 0, trunk.length - 1e-4));
      if (s < 0.58) return [[a.i, a.b1, 0, 0], [1 - a.w1, a.w1, 0, 0]];
      const b = boneAt(neck, cl(s - SH.TR, 0, neck.length - 1e-4)), w = ssv(0.6, 0.8, s);
      return [[a.i, a.b1, b.i, b.b1], [(1 - w) * (1 - a.w1), (1 - w) * a.w1, w * (1 - b.w1), w * b.w1]];
    };
    const S0 = -0.27, S1 = 0.82, ax = V();
    sheet(52, 36, (m, q) => {
      const u = m / 52, s = S0 + (S1 - S0) * (u < 0.15 ? 0.15 * Math.sin(Math.PI / 2 * u / 0.15) : u);   // rounder rump
      const th = TAUv * q / 36, cs = Math.cos(th), sn = Math.sin(th), rd = cs >= 0 ? rDor(s) : rVen(s);
      axisAt(trunk, s, ax);
      const p = ax.clone().addScaledVector(tA.x, rd * cs).addScaledVector(tA.z, rLat(s) * sn);
      return { p, c: BLACK, k: [0, 0, 0, 0], w: bodyW(s) };
    }, true);

    // ---- Breast shield: a crescent bib from the upper breast onto the neck, just proud of the
    // body, bulging a little. aCustom: (1, arc across, s along the body, 0 top → 1 bottom edge).
    const THM = 1.45;
    const neckR = s => SH.neck.r0 + (SH.neck.r1 - SH.neck.r0) * cl((s - SH.TR) / SH.NK, 0, 1);
    sheet(24, 40, (m, q) => {
      const tn = -1 + 2 * q / 40, th = tn * THM, v = m / 24;
      const mid = 0.77 + 0.05 * tn * tn, half = 0.09 * (1 - 0.55 * tn * tn) + 0.008;   // a necklace: low in the middle
      const hi = mid + half, lo = mid - half, s = hi + (lo - hi) * v;
      const rv = Math.max(rVen(s), s > SH.TR ? neckR(s) : 0), rl = Math.max(rLat(s), s > SH.TR ? neckR(s) : 0);
      const bul = 0.012 + 0.012 * (1 - tn * tn) * Math.sin(Math.PI * v);
      axisAt(trunk, s, ax);
      const p = ax.clone().addScaledVector(tA.x, -(rv + bul) * Math.cos(th)).addScaledVector(tA.z, (rl + bul) * Math.sin(th));
      return { p, c: WHITE, k: [1, th * 0.13, s, v], w: bodyW(s) };
    }, false);

    // ---- Head, in its bone's frame: −y the bill, +x the crown, +z the right. Rigid on bone 0.
    const hb = head.boneBase, hA = axes(head.q);
    const H = (x, y, z) => head.p.clone().addScaledVector(hA.x, x).addScaledVector(hA.y, y).addScaledVector(hA.z, z);
    const SK = { cx: 0.035, cy: -0.04, rx: 0.102, ry: 0.122, rz: 0.09 };
    const skull = (th, ph, k = 1) => H(SK.cx + k * SK.rx * Math.sin(th) * Math.cos(ph), SK.cy - k * SK.ry * Math.cos(th), k * SK.rz * Math.sin(th) * Math.sin(ph));
    sheet(24, 32, (m, q) => ({ p: skull(Math.PI * m / 24, TAUv * q / 32), c: BLACK, k: [0, 0, 0, 0], w: rigid(hb) }), true);
    // bill: short, a little decurved, from inside the face to the tip
    sheet(14, 16, (m, q) => {
      const w = m / 14, ph = TAUv * q / 16, y = -0.12 - 0.135 * w;
      const rx = 0.03 * Math.pow(1 - w, 0.75) + 0.0015, rz = 0.026 * Math.pow(1 - w, 0.85) + 0.0015;
      return { p: H(-0.02 * w * w + rx * Math.cos(ph), y, rz * Math.sin(ph)), c: new THREE.Color(0x141316), k: [5, 0, 0, 0], w: rigid(hb) };
    }, true);
    // forehead tuft: a white crescent over the bill base, just proud of the skull
    sheet(6, 20, (m, q) => {
      const ph = -0.9 + 1.8 * q / 20, half = 0.09 * Math.sqrt(Math.max(0, 1 - (ph / 0.9) ** 2)) + 0.008;
      const th = 0.42 + half * (2 * m / 6 - 1);
      return { p: skull(th, ph, 1.03), c: WHITE, k: [4, 0, 0, 0], w: rigid(hb) };
    }, false);
    // eyes: sapphire-blue irises round a black pupil, on the head bone (own glossy materials)
    const bone0 = head.bones[0];
    const iris = new THREE.MeshPhysicalMaterial({ color: 0x2f6bff, emissive: 0x1238c0, emissiveIntensity: 0.35, roughness: 0.2, clearcoat: 1, clearcoatRoughness: 0.05 });
    const pupil = new THREE.MeshPhysicalMaterial({ color: 0x020203, roughness: 0.1, clearcoat: 1 });
    for (const sg of [1, -1]) {
      const ex = 0.05, ey = -0.105, ez = SK.rz * Math.sqrt(1 - ((ex - SK.cx) / SK.rx) ** 2 - ((ey - SK.cy) / SK.ry) ** 2);
      const e = new THREE.Mesh(new THREE.SphereGeometry(0.015, 20, 14), iris); e.position.set(ex, ey, sg * (ez - 0.006)); bone0.add(e);
      const pu = new THREE.Mesh(new THREE.SphereGeometry(0.0075, 14, 10), pupil); pu.position.set(ex, ey, sg * (ez + 0.0045)); bone0.add(pu);
    }

    // ---- Racquets: a black oval vane on each wire's last few centimetres
    for (const wc of wires) {
      const wa = axes(wc.q), L = wc.length, s0 = L - 0.05;
      sheet(10, 4, (m, q) => {
        const s = s0 + (L + 0.004 - s0) * m / 10, v = 2 * q / 4 - 1;
        const wd = 0.016 * Math.pow(Math.sin(Math.PI * cl((s - s0) / (L + 0.004 - s0), 0, 1)), 0.6);
        return { p: axisAt(wc, s, V()).addScaledVector(wa.x, v * wd), c: BLACK, k: [3, 0, 0, 0], w: along(wc, s) };
      }, false);
    }

    // ---- Tail: ten feathers in a narrow fan, the middle pair longest, the outer ones beneath
    const tlA = axes(tail.q);
    for (let k = 0; k < 10; k++) {
      const x = (k + 0.5) / 10 - 0.5, sg = 0.36 * x, Lk = SH.TAIL * (1 - 0.3 * Math.abs(2 * x));
      sheet(16, 4, (m, q) => {
        const s = Lk * m / 16, v = 2 * q / 4 - 1, uu = s / Lk;
        const wd = 0.042 * Math.sqrt(Math.max(0, 1 - ((uu - 0.35) / 0.65) ** 4)) + 0.003;
        const p = axisAt(tail, s, V()).addScaledVector(tlA.z, 0.1 * sg + s * Math.tan(sg) + v * wd).addScaledVector(tlA.x, -0.006 * Math.abs(x) * 10 * 0.4);
        return { p, c: BLACK, k: [0, 0, 0, 0], w: along(tail, s) };
      }, false);
    }

    // ---- Folded wings: a long teardrop lying on each flank (hidden under the folded plumes or
    // the raised skirt most of the time, seen from behind)
    wings.forEach((wc, k) => {
      const dir = V(0, -1, 0).applyQuaternion(wc.q), sg = k ? -1 : 1;
      const up = tA.x.clone().addScaledVector(dir, -tA.x.dot(dir)).normalize();   // the back, square to the wing
      sheet(16, 5, (m, q) => {
        const uu = m / 16, s = SH.WING * uu, v = 2 * q / 5 - 1;
        const wd = 0.1 * Math.pow(Math.sin(Math.PI * (0.12 + 0.88 * uu)), 0.8) * (1 - 0.3 * uu);
        const p = axisAt(wc, s, V()).addScaledVector(up, 0.02 + v * wd).addScaledVector(tA.z, sg * 0.012 * Math.sin(Math.PI * uu));
        return { p, c: BLACK, k: [0, 0, 0, 0], w: along(wc, s) };
      }, false);
    });

    // ---- Skirt: one sheet over the sixteen ribs. Between two ribs a point is the first rib's
    // point turned about the trunk axis (so the bound sheet is round, not faceted) and weighted to
    // both ribs. aCustom: (2, out along the plume, round the disc 0..1, 0).
    const SUB = 6, NR = SH.NRIB, dA = TAUv / NR, tP = trunk.p, tD = V(0, -1, 0).applyQuaternion(trunk.q);
    const turn = (pt, ang) => pt.sub(tP).applyAxisAngle(tD, ang).add(tP);
    // which way round is "toward the next rib" (Ry(−a) about the trunk's own y)
    const probe = axisAt(ribs[0], 0.3, V()), next = axisAt(ribs[1], 0.3, V());
    const dir = turn(probe.clone(), dA).distanceTo(next) < turn(probe.clone(), -dA).distanceTo(next) ? 1 : -1;
    sheet(28, NR * SUB, (m, q) => {
      const u = m / 28, d = SH.RIB * u, r = Math.floor(q / SUB) % NR, f = (q % SUB) / SUB;
      const A = ribs[r], B = ribs[(r + 1) % NR];
      const ka = boneAt(A, Math.min(d, A.length - 1e-4)), kb = boneAt(B, Math.min(d, B.length - 1e-4));
      const p = turn(axisAt(A, d, V()), dir * f * dA);
      return { p, c: BLACK, k: [2, u, q / (NR * SUB), 0],
        w: [[ka.i, ka.b1, kb.i, kb.b1], [(1 - f) * (1 - ka.w1), (1 - f) * ka.w1, f * (1 - kb.w1), f * kb.w1]] };
    }, true);
    return {};
  },

  // A dim forest-floor backdrop, so a velvet-black bird reads against something.
  build(THREE, body, mats, world) {
    const c = document.createElement('canvas'); c.width = 2; c.height = 256;
    const g = c.getContext('2d'), gr = g.createLinearGradient(0, 0, 0, 256);
    gr.addColorStop(0, '#2a3524'); gr.addColorStop(0.55, '#1e241a'); gr.addColorStop(1, '#17130f');
    g.fillStyle = gr; g.fillRect(0, 0, 2, 256);
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
    world.background = tex;
    return { meshes: [] };
  },
  apply() {},
};
