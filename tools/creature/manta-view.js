// The manta ray's view: the disc (trunk and wings as ONE closed surface skinned between the
// ribs), the mouth cavity, the cephalic fins, the eyes, the colouring and the water surface.
// Shape constants come from manta-def.js (the def never imports this file).
import { SHAPE as S, IDX } from './manta-def.js';

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const ss = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
// Up to four bone influences from a list of [bone, weight] (merged, largest kept, renormalised).
function top4(list) {
  const m = new Map();
  for (const [b, w] of list) if (w > 1e-6) m.set(b, (m.get(b) || 0) + w);
  const e = [...m].sort((p, q) => q[1] - p[1]).slice(0, 4), t = e.reduce((s, p) => s + p[1], 0) || 1;
  while (e.length < 4) e.push([0, 0]);
  return [e.map(p => p[0]), e.map(p => p[1] / t)];
}

// ---- Colouring (Soft skin), in the creature's own shader code ------------------------------
// aCustom per vertex: x dorsal (+1) / ventral (−1); y region (0 disc, 1 mouth cavity, 2 fin,
// 3 eye, 4 tail); z chord position (0 trailing edge → 1 leading edge; on a fin: 0 medial → 1
// outer edge); w span fraction (on a fin: 0 base → 1 tip). The pattern reads the BIND position
// (vBind), so it stays stuck to the skin as the wings bend.
const HEAD = `
float mH21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
// Where the belly spots gather: the abdomen behind the gills, a few between the gill rows, a
// scatter along the inner trailing edges. One individual's pattern: uSpotSeed.
float mantaDensity(vec2 p) {
  float zz = abs(p.y);
  float abd = exp(-pow((p.x + 0.13) / 0.19, 2.0) - pow(zz / 0.23, 2.0));
  float mid = exp(-pow((p.x - 0.13) / 0.12, 2.0) - pow(zz / 0.055, 2.0));
  float te = exp(-pow((p.x + 0.3) / 0.07, 2.0)) * smoothstep(0.12, 0.3, zz) * smoothstep(0.7, 0.4, zz);
  return clamp(0.95 * abd + 0.6 * mid + 0.35 * te, 0.0, 0.92);
}
float mantaSpots(vec2 p) {
  vec2 g = p / 0.034, i = floor(g);
  float m = 0.0;
  for (int dx = -1; dx <= 1; dx++) for (int dy = -1; dy <= 1; dy++) {
    vec2 c = i + vec2(float(dx), float(dy));
    float h1 = mH21(c + uSpotSeed), h2 = mH21(c * 1.31 + uSpotSeed + 7.7), pr = mH21(c * 0.73 - uSpotSeed + 3.3);
    if (pr > mantaDensity((c + 0.5) * 0.034)) continue;
    vec2 ctr = c + 0.2 + 0.6 * vec2(h1, h2);
    float r = 0.16 + 0.36 * h1 * h2 + 0.1 * pr;
    m = max(m, smoothstep(1.0, 0.75, length(g - ctr) / r));
  }
  return m;
}
// Sunlight through the waves: thin bright filaments on the edges of drifting cells (F2 − F1 of a
// moving Voronoi field), two layers at different scales and speeds.
float mantaCell(vec2 p, float t) {
  vec2 i = floor(p), f = fract(p); float d1 = 8.0, d2 = 8.0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 g = vec2(float(x), float(y)), c = i + g;
    vec2 o = 0.5 + 0.4 * sin(t + 6.2831 * vec2(mH21(c), mH21(c + 5.3)));
    float d = length(g + o - f);
    if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) d2 = d;
  }
  return 1.0 - smoothstep(0.0, 0.15, d2 - d1);
}
float mantaCaustic(vec2 p, float t) {
  p += 0.45 * vec2(vnoise(vec3(p * 0.7, t * 0.3)), vnoise(vec3(p * 0.7 + 4.0, t * 0.3)));   // wavy, not tiled
  float c = mantaCell(p, t) * (0.55 + 0.45 * mantaCell(p * 1.6 + 3.1, t * 1.3));
  return c * c;
}
// Five gill slits a side, curving back at their outer ends.
float mantaGills(vec2 p) {
  float zz = abs(p.y), m = 0.0;
  for (int i = 0; i < 5; i++) {
    float fi = float(i), z0 = 0.068, z1 = 0.205 - 0.01 * fi;
    float t = clamp((zz - z0) / (z1 - z0), 0.0, 1.0);
    float xc = 0.29 - 0.055 * fi + 0.008 * t - 0.03 * t * t;
    float along = smoothstep(z0 - 0.003, z0 + 0.007, zz) * smoothstep(z1 + 0.003, z1 - 0.007, zz);
    m = max(m, smoothstep(0.006, 0.0015, abs(p.x - xc)) * along);
  }
  return m;
}
// White shoulder patches: a triangle each side behind the head, a dark band left along the
// leading edge and a dark stripe down the middle (the black "T"), ragged at the edges.
float mantaShoulder(vec2 p) {
  float zz = abs(p.y);
  float le = 0.385 - 0.68 * (zz - 0.3);
  float f = smoothstep(0.03, 0.1, min(le, 0.32) - p.x)
          * smoothstep(0.06, 0.13, zz)
          * smoothstep(-0.05, 0.05, p.x + 0.04 - 0.4 * (zz - 0.12))
          * smoothstep(0.72, 0.48, zz);
  float n = fbm(vec3(p * 6.0, 2.7)) + 0.5 * fbm(vec3(p * 19.0, 5.1)) - 0.75;
  return smoothstep(0.3, 0.7, f + 0.9 * n);
}
`;
const SURFACE = `
  float reg = vCustom.y;
  vec2 mp = vBind.xz;
  float vent = reg < 0.5 ? smoothstep(0.25, -0.25, vCustom.x) : 0.0;
  float gl = mantaGills(mp) * vent;
  if (uColour > 0.5) {
    vec3 col = vec3(1.0);
    if (reg > 3.5) col = vec3(1.0);                                   // tail: its chain tint
    else if (reg > 2.5) col = vec3(0.025);                            // eye
    else if (reg > 1.5) {                                             // cephalic fin
      float rim = smoothstep(0.86, 1.0, vCustom.z);
      col = gl_FrontFacing ? mix(vec3(0.045, 0.047, 0.055), vec3(0.8), 0.7 * rim)
                           : vec3(0.88, 0.88, 0.86) * (1.0 - 0.3 * smoothstep(0.75, 1.0, vCustom.w));
    } else if (reg > 0.5) {                                           // mouth: dark, gill rakers
      float bars = smoothstep(0.6, 0.95, 0.5 + 0.5 * sin(mp.x * 330.0)) * smoothstep(0.14, 0.08, abs(mp.y)) * smoothstep(0.47, 0.4, mp.x);
      col = mix(vec3(0.05, 0.045, 0.05), vec3(0.3, 0.29, 0.29), 0.5 * bars);
    } else {
      float dors = smoothstep(-0.25, 0.25, vCustom.x), zz = abs(mp.y), sf = vCustom.w;
      float sh = mantaShoulder(mp);
      sh *= 1.0 - 0.75 * smoothstep(0.68, 0.8, vnoise(vBind * 46.0)) * smoothstep(0.95, 0.4, sh);   // dark flecks fraying the patch edges
      float mot = fbm(vBind * 4.5 + 3.0), mot2 = vnoise(vBind * 22.0);
      vec3 D = mix(vec3(0.035, 0.037, 0.043) * (0.7 + 0.75 * mot) * (0.9 + 0.2 * mot2), vec3(0.84, 0.85, 0.84) * (0.88 + 0.14 * mot), sh);
      D += vec3(0.05, 0.055, 0.06) * smoothstep(0.85, 1.0, vCustom.z) * smoothstep(0.3, 0.8, sf);   // paler leading-edge rim out toward the tips
      // underneath: white; dark trailing margins and wingtips; grey round the mouth; spots; slits
      float margin = smoothstep(0.2, 0.03, vCustom.z) * smoothstep(0.16, 0.32, sf) + smoothstep(0.72, 0.94, sf);
      vec3 V = mix(vec3(0.9, 0.9, 0.88) * (0.9 + 0.12 * fbm(vBind * 6.0 + 9.0)), vec3(0.07, 0.07, 0.08), 0.85 * clamp(margin, 0.0, 1.0));
      V = mix(V, vec3(0.4, 0.39, 0.4), smoothstep(0.38, 0.47, mp.x) * smoothstep(0.17, 0.11, zz));
      V *= 1.0 - 0.92 * mantaSpots(mp);
      V = mix(V, vec3(0.28, 0.27, 0.28), gl);
      col = mix(V, D, dors);
    }
    diffuseColor.rgb *= col;
    if (reg < 0.5) totalEmissiveRadiance += diffuseColor.rgb * 0.3 * smoothstep(0.2, -0.4, vCustom.x);
    if (reg < 0.5 || reg > 3.5) totalEmissiveRadiance += vec3(0.55, 0.75, 0.85) * 0.045 * mantaCaustic(vBind.xz * 3.6, uTime * 0.6) * smoothstep(-0.2, 0.6, vCustom.x);
    if (reg > 1.5 && reg < 2.5 && !gl_FrontFacing) totalEmissiveRadiance += diffuseColor.rgb * 0.12;
  }
  if (reg > 0.5 && reg < 1.5) roughnessFactor = 1.0;   // inside the mouth: no glancing highlights off the roof
  {   // the gill slits are grooves (every skin)
    float hgt = -0.0025 * gl;
    vec3 dpx = dFdx(-vViewPosition), dpy = dFdy(-vViewPosition);
    vec3 r1 = cross(dpy, normal), r2 = cross(normal, dpx);
    float det = dot(dpx, r1);
    normal = normalize(abs(det) * normal - sign(det) * (dFdx(hgt) * r1 + dFdy(hgt) * r2));
  }
`;

export const VIEW = {
  camera: { pos: [1.4, 2.2, 3.4], target: [-0.05, -0.05, 0] },
  floor: { color: 0x6c6352 },                 // only at the cleaning station (P.parts.floor)
  soft: { limb: 0xffffff, body: 0x222222, bodyClear: false, roughness: 0.5, clearcoat: 0.22, clearcoatRoughness: 0.45 },   // satin, not glossy (a sheen washed the black out to grey)
  skinFx: { mottle: 0.12, bump: 0.13, glsl: { uniforms: { uSpotSeed: 7.0 }, head: HEAD, surface: SURFACE } },

  skin(ctx) {
    const { THREE, chains, boneAt, axisAt } = ctx, NR = IDX.NR;
    const spine = chains[IDX.spine], jawB = chains[IDX.jaw].boneBase;
    const ribs = Array.from({ length: 2 * NR }, (_, j) => chains[IDX.rib + j]);
    const spineAt = x => boneAt(spine, clamp(S.NOSE - x, 0, spine.length - 1e-4));
    // The two ribs either side of chord position x, on z's side, at that span.
    const ribAt = (x, z) => {
      const zz = Math.abs(z), o = z >= 0 ? 0 : NR;
      let k = 0; while (k < NR - 2 && x < S.RIB_X[k + 1]) k++;
      const u = clamp((S.RIB_X[k] - x) / (S.RIB_X[k] - S.RIB_X[k + 1]), 0, 1), A = ribs[o + k], B = ribs[o + k + 1];
      const a = boneAt(A, clamp(zz - S.RIB_ZR[k], 0, A.length - 1e-4)), b = boneAt(B, clamp(zz - S.RIB_ZR[k + 1], 0, B.length - 1e-4));
      return [[a.i, (1 - u) * (1 - a.w1)], [a.b1, (1 - u) * a.w1], [b.i, u * (1 - b.w1)], [b.b1, u * b.w1]];
    };
    // Trunk → wing: the spine (and the jaw, wj) inside, the ribs outside, blended across the hinge.
    const discW = (x, z, wj) => {
      const zr = S.ribZr(x), wr = ss(zr - 0.07, zr + 0.05, Math.abs(z)), L = [];
      if (wr > 0) for (const [b, w] of ribAt(x, z)) L.push([b, w * wr]);
      if (wr < 1) {
        const sp = spineAt(x), wb = 1 - wr;
        L.push([sp.i, wb * (1 - wj) * (1 - sp.w1)], [sp.b1, wb * (1 - wj) * sp.w1], [jawB, wb * wj]);
      }
      return top4(L);
    };
    const add = (p, cu, wts, ix, upCheck) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3)); g.setIndex(ix); g.computeVertexNormals();
      if (upCheck !== undefined && g.attributes.normal.getY(upCheck) < 0) {   // wound inside out: turn every triangle
        for (let t = 0; t < ix.length; t += 3) { const s = ix[t + 1]; ix[t + 1] = ix[t + 2]; ix[t + 2] = s; }
        g.setIndex(ix); g.computeVertexNormals();
      }
      g.setAttribute('aCustom', new THREE.Float32BufferAttribute(cu, 4));
      ctx.addGeometry(g, vi => wts[vi]);
    };

    // ---- The disc: stations across the span, each a closed section round the chord: top surface
    // trailing edge → leading edge, (the mouth cavity, at the head front), bottom surface back to
    // the trailing edge (a sharp edge: the first and last points of a section are separate).
    const NH = 14, NZ = 40, G = 0.004, HX = S.NOSE - S.HINGE;
    const zAt = t => S.TIP * (0.55 * t + 0.45 * Math.sin(Math.PI / 2 * t));    // closer stations toward the tips
    const zs = [];
    for (let m = NZ; m >= 1; m--) zs.push(-zAt(m / NZ));
    zs.push(0);
    for (let m = 1; m <= NZ; m++) zs.push(zAt(m / NZ));
    // Mouth cavity, closed: a slit going back to the jaw hinge — roof (head), back, floor (jaw).
    const CAV = [[0.12, 1], [0.35, 1], [0.65, 1], [1, 1], [1, 0], [1, -1], [0.65, -1], [0.35, -1], [0.12, -1]];
    const p = [], cu = [], wts = [], ix = [];
    let NP = 0, upV = 0;
    zs.forEach((z, si) => {
      const zz = Math.abs(z), le = S.LE(zz), te = S.TE(zz), c = le - te, ht = S.Htop(zz), hb = S.Hbot(zz), sf = zz / S.TIP;
      const mu = ss(S.MOUTH + 0.02, S.MOUTH - 0.03, zz), muJ = ss(S.MOUTH + 0.04, S.MOUTH - 0.02, zz);
      const pt = [];   // [x, y, dorsal, region, chord v, jaw weight]
      for (let j = 0; j <= NH; j++) {
        const v = (1 - Math.cos(Math.PI * j / NH)) / 2;
        pt.push([te + c * v, ht * S.section(v, zz) + (j === NH ? mu * G : 0), j === NH ? 0.3 : 1, 0, v, 0]);
      }
      for (const [q, s] of CAV)
        pt.push([le - S.HINGE * mu * q, s * mu * G, 0, 1, 1, s < 0 ? muJ : s === 0 ? 0.5 * muJ : 0]);   // inside (collapsed away from the mouth: zero-area, unseen)
      pt.push([le, -mu * G, -0.3, 0, 1, muJ]);                        // lower lip
      for (let j = 1; j <= NH; j++) {
        const v = (1 + Math.cos(Math.PI * j / NH)) / 2, x = te + c * v;
        pt.push([x, -hb * S.section(v, zz), -1, 0, v, muJ * ss(HX - 0.05, HX + 0.05, x)]);
      }
      NP = pt.length;
      if (z === 0) upV = si * NP + (NH >> 1);
      for (const [x, y, dv, reg, v, wj] of pt) {
        p.push(x, y, z); cu.push(dv, reg, v, sf); wts.push(discW(x, z, wj));
      }
    });
    for (let si = 0; si < zs.length - 1; si++) for (let j = 0; j < NP - 1; j++) {
      const a = si * NP + j, b = a + 1, c = a + NP, d = c + 1;
      ix.push(a, c, b, b, c, d);
    }
    add(p, cu, wts, ix, upV);

    // ---- Cephalic fins: a sheet between the cross-chains of each fin (base → tip), across its
    // width from the medial edge out. Narrower at the base, rounded at the tip. One sheet, two
    // faces: the shader colours the dorsal face dark and the inner face white (gl_FrontFacing).
    for (let s = 0; s < 2; s++) {
      const X = Array.from({ length: S.CROSS }, (_, m) => chains[IDX.lobeX[s] + m]);
      const NT = 4 * (S.CROSS - 1), NU = 10, a = new THREE.Vector3(), b = new THREE.Vector3();
      const lp = [], lc = [], lw = [], li = [];
      for (let r = 0; r <= NT; r++) {
        const t = r / NT, fm = t * (S.CROSS - 1), m = Math.min(S.CROSS - 2, Math.floor(fm)), f = fm - m;
        const wd = (0.8 + 0.2 * ss(0, 0.3, t)) * (t > 0.8 ? Math.sqrt(Math.max(0, 1 - ((t - 0.8) / 0.2) ** 2)) : 1);
        for (let q = 0; q <= NU; q++) {
          const u = q / NU, sl = clamp(u * S.LOBE_W * Math.max(wd, 0.015), 0, X[0].length - 1e-4);
          axisAt(X[m], sl, a); axisAt(X[m + 1], sl, b); a.lerp(b, f);
          const A = boneAt(X[m], sl), B = boneAt(X[m + 1], sl);
          lp.push(a.x, a.y, a.z); lc.push(1, 2, u, t);
          lw.push(top4([[A.i, (1 - f) * (1 - A.w1)], [A.b1, (1 - f) * A.w1], [B.i, f * (1 - B.w1)], [B.b1, f * B.w1]]));
        }
      }
      for (let r = 0; r < NT; r++) for (let q = 0; q < NU; q++) {
        const i0 = r * (NU + 1) + q; li.push(i0, i0 + NU + 1, i0 + 1, i0 + 1, i0 + NU + 1, i0 + NU + 2);
      }
      add(lp, lc, lw, li, (NT >> 1) * (NU + 1) + (NU >> 1));
    }

    // ---- Eyes: dark glossy beads on the sides of the head, behind the fin bases.
    const head = spine.boneBase;
    for (const sg of [1, -1]) {
      const g = new THREE.SphereGeometry(0.015, 14, 10); g.translate(0.437, 0.004, sg * 0.222);
      const n = g.attributes.position.count, ec = [], ew = [];
      for (let i = 0; i < n; i++) { ec.push(0, 3, 0, 0); ew.push([[head, 0, 0, 0], [1, 0, 0, 0]]); }
      g.setAttribute('aCustom', new THREE.Float32BufferAttribute(ec, 4));
      ctx.addGeometry(g, vi => ew[vi]);
    }
    return {};
  },

  // The water surface, for the breach: a sheet in the world (it stays put while the body leaps).
  build(THREE, body, mats, world) {
    const g = new THREE.PlaneGeometry(16, 16); g.rotateX(-Math.PI / 2);
    // ripples: a tiling normal map drawn once from summed waves, drifted in apply()
    const R = 256, cv = document.createElement('canvas'); cv.width = cv.height = R;
    const cx = cv.getContext('2d'), im = cx.createImageData(R, R), W = [];
    { let sd = 911; const r = () => ((sd = (sd * 16807) % 2147483647) / 2147483647);   // many waves, every direction (integer wavevectors so it tiles)
      for (let k = 0; k < 28; k++) { const f = 2 + Math.floor(r() * r() * 22), an = r() * Math.PI * 2;
        W.push([Math.round(f * Math.cos(an)), Math.round(f * Math.sin(an)), r() * 6.28]); } }
    for (let y = 0; y < R; y++) for (let x = 0; x < R; x++) {
      let dx = 0, dy = 0;
      for (const [a, b, ph] of W) { const n = Math.hypot(a, b) || 1, k = Math.cos(2 * Math.PI * (a * x + b * y) / R + ph) / (n * n); dx += a * k; dy += b * k; }
      const o = 4 * (y * R + x); im.data[o] = 128 + 110 * dx; im.data[o + 1] = 128 + 110 * dy; im.data[o + 2] = 255; im.data[o + 3] = 255;
    }
    cx.putImageData(im, 0, 0);
    const nm = new THREE.CanvasTexture(cv); nm.wrapS = nm.wrapT = THREE.RepeatWrapping; nm.repeat.set(5, 5);
    // fades out with distance, so the sea has no hard edge against the background
    const fc = document.createElement('canvas'); fc.width = fc.height = 256;
    const fg = fc.getContext('2d'), gr = fg.createRadialGradient(128, 128, 10, 128, 128, 128);
    gr.addColorStop(0, '#fff'); gr.addColorStop(0.35, '#ddd'); gr.addColorStop(1, '#000');
    fg.fillStyle = gr; fg.fillRect(0, 0, 256, 256);
    const water = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: 0x2c6f93, roughness: 0.12, metalness: 0.1, transparent: true, opacity: 0,
      side: THREE.DoubleSide, depthWrite: false, normalMap: nm, normalScale: new THREE.Vector2(0.85, 0.85), alphaMap: new THREE.CanvasTexture(fc) }));
    water.visible = false; world.add(water);
    // Splashes where the body breaks the surface: a white ring of foam spreading and fading.
    const ring = new THREE.RingGeometry(0.8, 1, 48, 1); ring.rotateX(-Math.PI / 2);
    const splashes = [0, 1].map(() => {
      const m = new THREE.Mesh(ring, new THREE.MeshBasicMaterial({ color: 0xeaf6fa, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false }));
      m.visible = false; world.add(m); return m;
    });
    // spray: droplets thrown up and falling back, one burst per splash
    const ND = 220, drops = [0, 1].map(k => {
      const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(ND * 3), 3));
      let sd = 17 + 31 * k; const r = () => ((sd = (sd * 16807) % 2147483647) / 2147483647);
      const v = Array.from({ length: ND }, () => { const a = r() * 6.283, sp = 0.3 + 1.1 * r() * r(); return [Math.cos(a) * sp, 1.2 + 2.6 * r() * (1 - 0.6 * sp / 1.4), Math.sin(a) * sp, 0.15 + 0.25 * r()]; });
      const m = new THREE.Points(geo, new THREE.PointsMaterial({ color: 0xf2fbff, size: 0.035, transparent: true, opacity: 0, depthWrite: false }));
      m.visible = false; m.frustumCulled = false; world.add(m); return { m, v };
    });
    return { meshes: [], water, splashes, drops, t0: performance.now() };
  },
  apply(P, v) {
    const s = P.parts.surface ?? 0;
    v.water.visible = s > 0.01; v.water.material.opacity = 0.55 * s; v.water.position.y = P.parts.surfY ?? 0;
    v.water.material.normalMap.offset.set(((performance.now() - v.t0) * 0.00006) % 1, ((performance.now() - v.t0) * 0.00004) % 1);
    const sp = P.parts.splash || [];
    v.drops.forEach(({ m, v: vel }, k) => {
      const a = sp[3 * k] ?? 0; m.visible = a > 0 && a < 0.8;
      if (!m.visible) return;
      const t = a * 1.7, A = m.geometry.attributes.position, x0 = sp[3 * k + 1], z0 = sp[3 * k + 2], y0 = v.water.position.y;
      vel.forEach(([vx, vy, vz, r0], i) => {
        const y = Math.max(0, vy * t - 2.6 * t * t);
        A.setXYZ(i, x0 + vx * t + Math.sign(vx) * r0, y0 + y, z0 + vz * t + Math.sign(vz) * r0);
      });
      A.needsUpdate = true; m.material.opacity = 0.9 * (1 - a / 0.8);
    });
    v.splashes.forEach((m, k) => {
      const a = sp[3 * k] ?? 0; m.visible = a > 0;
      if (!m.visible) return;
      const r = 0.35 + 1.3 * Math.sqrt(a);
      m.scale.set(r, 1, r); m.position.set(sp[3 * k + 1], v.water.position.y + 0.005, sp[3 * k + 2]);
      m.material.opacity = 0.4 * (1 - a) * (1 - a);
    });
  },
};
