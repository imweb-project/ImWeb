// The cobra's look: ONE skin over the whole spine (head, jaw, hood, body, tail), the mouth lining,
// glossy eyes, and a gritty ground that slides by P.parts (gc, gs) while it crawls.
// Shape constants come from snake-def.js (never the other way round).
import { SPINE, HOOD, SHAPE } from './snake-def.js';

const TAU = Math.PI * 2;
const cl = (x, a, b) => Math.min(b, Math.max(a, x));
const ss = (a, b, x) => { const t = cl((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const sgp = (x, e) => Math.sign(x) * Math.pow(Math.abs(x), e);
const mix = (a, b, t) => a + (b - a) * t;

const SN = SPINE.snout;          // snout tip (s < 0: ahead of the head joint)
const S_SPLIT = 0.075;           // mouth corner: in front of it the head is two lips, behind one skin
const NA = 64;                   // columns round the body; column 0 runs along the belly
const QD = 17;                   // lip line: QD columns either side of the top (≈ 96° from the back)

// Cross-section size at s: a long, flat-topped head with a squarish snout, wider at the temples
// than the neck (photo 5), blending into the neck and body. ey/ez: how boxy the top and sides are.
const BROW_S = -0.045;           // the eyes and the ledges over them
function dims(s) {
  const t = (s - SN) / 0.23, cap = Math.sqrt(Math.max(0, 1 - Math.pow(1 - Math.min(1, Math.max(0, t) / 0.25), 2)));
  const cv = Math.pow(cap, 0.8);
  const wH = cap * (0.05 + 0.026 * ss(0.25, 0.85, t));
  const hdH = cv * (0.028 + 0.012 * ss(0.05, 0.6, t));
  const hvH = cv * (0.022 + 0.012 * ss(0.15, 0.7, t));
  const sb = Math.max(s, 0.1), w = SHAPE.w(sb), m = ss(0.08, 0.2, s);
  return { w: mix(wH, w, m), hd: mix(hdH, 0.88 * w, m), hv: mix(hvH, 0.72 * w, m), ey: mix(0.45, 0.9, m), ez: mix(0.62, 0.85, m), head: 1 - m };
}
// Point on the skin at s, angle th from the back (0 = dorsal midline, π = belly). Body frame in
// bind space: x along (the head toward +x), y up, z to the side.
function section(s, th, d = dims(s)) {
  const c = Math.cos(th), sn = Math.sin(th), tw = Math.atan2(sn, c);
  let y = c >= 0 ? d.hd * Math.pow(c, d.ey) : -d.hv * Math.pow(-c, 0.55), z = d.w * sgp(sn, d.ez);
  const b = d.head * Math.exp(-Math.pow((s - BROW_S) / 0.03, 2)) * Math.exp(-Math.pow((Math.abs(tw) - 0.9) / 0.28, 2));
  y += 0.004 * b; z += Math.sign(sn) * 0.006 * b;                 // a ledge over each eye (photo 5)
  return { y, z };
}

// ---- Spectacled-cobra markings (skinFx.glsl) ------------------------------------------------
// Painted in skin coordinates laid out as at FULL hood spread (X: sideways distance the skin will
// have when open), so they are round on an open hood and squeezed, as on the real animal, when
// it is shut. Back of the hood: the spectacle, two ocelli joined by a U dipping toward the tail.
// Front (photos 2, 7): a dark blotch either side, mottled brown flanks with a darker rim, slate
// bands across the cream throat.
const f4 = x => x.toFixed(4);
const COBRA_MARKS = `
const float H_S0 = ${f4(HOOD.s0)}, H_S1 = ${f4(HOOD.s1)}, H_MAX = ${f4(HOOD.max)}, H_IN = ${f4(HOOD.inset)};
vec3 srgb(vec3 c) { return pow(c, vec3(2.2)); }
float cobraHS(float s) { float u = (s - H_S0) / (H_S1 - H_S0); return (u <= 0.0 || u >= 1.0) ? 0.0 : pow(sin(3.14159265 * pow(u, 0.6)), 0.6); }
float cobraW(float s) { return ${f4(SHAPE.w0)} + ${f4(SHAPE.w1)} * smoothstep(0.12, 1.6, s); }
float bandAt(float s, float c, float h) { return 1.0 - smoothstep(0.75 * h, 1.25 * h, abs(s - c)); }
// Body skin (region 1) and hood flaps (region 3). On a flap, vCustom.w is how far out the point
// lies on the OPEN hood; on the neck it is worked out from the angle round.
float cobraMarks(inout vec3 rgb) {                                   // returns how much this is the back of the hood
  float reg = vCustom.z;
  if (reg < 0.5 || (reg > 1.5 && reg < 2.5)) return 0.0;
  float th = vCustom.x * 6.2831853, s = vCustom.y, c = cos(th), sn = sin(th);
  float w = cobraW(s), w0 = w - H_IN, W = w0 + cobraHS(s) * (H_MAX - w0), flap = step(2.5, reg);
  float aX = flap > 0.5 ? vCustom.w : pow(abs(sn), 0.85) * w;
  float uf = flap * clamp((aX - w0) / max(W - w0, 1e-4), 0.0, 1.0); // 0 at the flap's root → 1 at its edge
  float hood = smoothstep(H_S0, H_S0 + 0.04, s) * (1.0 - smoothstep(H_S1 - 0.08, H_S1 + 0.02, s));
  float back = smoothstep(0.02, 0.3, c), front = smoothstep(0.02, 0.3, -c);
  // back of the hood (Commons File:Naja.jpg): pale scales in a dark net, and the spectacle: one
  // dark line with a pale halo, a deep U whose arms each end in a loop curling outward
  float mk = hood * back;
  rgb = mix(rgb, srgb(vec3(0.8, 0.76, 0.68)), 0.55 * mk);
  float rag = 0.0018 * (vnoise(vec3(aX * 90.0, s * 90.0, 3.0)) - 0.5);
  float x = min(aX, 0.048), f = 0.41 - 76.0 * x * x, fp = -152.0 * x;
  float dU = abs(s - f) / sqrt(1.0 + fp * fp) + max(aX - 0.048, 0.0);
  dU = max(dU, 0.235 - s);                                            // nothing above the arm tops
  float dL = abs(length(vec2(aX - 0.068, s - 0.228)) - 0.02);         // the loops
  float dm = min(dU, dL) + rag;
  rgb = mix(rgb, srgb(vec3(0.95, 0.92, 0.85)), 0.9 * mk * (1.0 - smoothstep(0.007, 0.013, dm)));
  rgb = mix(rgb, srgb(vec3(0.06, 0.045, 0.04)), 0.97 * mk * (1.0 - smoothstep(0.004, 0.0062, dm)));
  // front of the hood (photos 2, 7): mottled brown flaps, a darker rim, a dark blotch either side
  float fl = hood * front * flap;
  float n1 = vnoise(vec3(aX * 70.0, s * 70.0, 7.0)), n2 = vnoise(vec3(aX * 220.0, s * 220.0, 1.0));
  rgb = mix(rgb, srgb(vec3(0.55, 0.44, 0.36)) * (0.8 + 0.4 * n1), 0.8 * fl * smoothstep(0.0, 0.25, uf));
  rgb = mix(rgb, srgb(vec3(0.88, 0.84, 0.78)), 0.55 * fl * smoothstep(0.78, 0.9, n2));
  rgb = mix(rgb, srgb(vec3(0.3, 0.21, 0.16)), 0.7 * hood * flap * smoothstep(0.72, 0.97, uf));
  float sp = length(vec2((aX - 0.11) / 0.028, (s - 0.27) / 0.05)) + 0.25 * (n1 - 0.5);
  rgb = mix(rgb, srgb(vec3(0.08, 0.06, 0.05)), 0.92 * fl * (1.0 - smoothstep(0.7, 1.05, sp)));
  // slate bands across the cream throat (on the hood only down its middle, the neck itself)
  float bands = bandAt(s, 0.47, 0.05) + bandAt(s, 0.615, 0.018) + bandAt(s, 0.76, 0.018) + 0.6 * bandAt(s, 0.9, 0.012);
  rgb = mix(rgb, srgb(vec3(0.4, 0.45, 0.54)), 0.85 * min(1.0, bands) * front * (1.0 - flap) * (1.0 - smoothstep(1.0, 1.1, s)));
  // a faint blotchy mottle stuck to the skin, big enough to see from afar, so the body's own
  // motion along its path shows (a plain tube seemed to slide through its own shape)
  float mo = 0.6 * vnoise(vec3(s * 9.0, cos(th) * 1.4, sin(th) * 1.4)) + 0.4 * vnoise(vec3(s * 23.0, cos(th) * 3.1 + 5.0, sin(th) * 3.1));
  rgb *= mix(1.0, 0.78 + 0.4 * mo, (1.0 - flap) * (0.4 + 0.6 * smoothstep(-0.3, 0.3, c)));
  // along the body: faint pale chevron bands (seen from afar), a darker line down the back
  float ch = smoothstep(0.82, 0.98, cos(6.2831853 * (s + 0.05 * abs(sn)) / 0.34)) * smoothstep(0.7, 1.0, s) * back * (1.0 - flap);
  rgb = mix(rgb, rgb * 1.3 + 0.015, 0.45 * ch);
  return mk;
}
`;

// ---- Scales (skinFx.glsl) -----------------------------------------------------------------
// Dorsal scales: rhombs on a staggered lattice (rows every half scale, alternate rows offset half
// a column), nearest centre by the L1 metric. Each lies like a shingle: low where it tucks under
// the scale in front, high at its free rear edge. Under the belly: wide transverse scutes. On the
// head: the same lattice, coarser (the big head plates). On a spread hood each scale keeps its
// width and the skin between them shows (uHood × the vertex's own stretch, aCustom.w). Where a
// scale shrinks to a few pixels the pattern fades out, so it never shimmers.
const SCALES_HEAD = `
// Head shields (photos 4, 5): big crown plates around hand-placed centres (rostral, internasals,
// prefrontals, frontal, supraoculars, parietals, occipitals: a Voronoi on the top of the head),
// a row of tall shields along each lip, small scales on the temples between. Returns 0 where it
// is none of these (the lattice takes over).
const vec2 CROWN[12] = vec2[12](vec2(-0.112, 0.0), vec2(-0.097, 0.012), vec2(-0.077, 0.017), vec2(-0.044, 0.0),
  vec2(-0.046, 0.034), vec2(-0.004, 0.019), vec2(0.034, 0.024), vec2(0.066, 0.012), vec2(0.05, 0.048), vec2(-0.012, 0.047),
  vec2(-0.084, 0.036), vec2(0.004, 0.0));
int headPlates(float th, float s, out float h, out float line, out float rnd, out float fw) {
  float tw = abs(atan(sin(th), cos(th))), z = abs(vBind.z);
  fw = (fwidth(s) + fwidth(z)) / 0.01;
  if (tw < 1.12 && s < 0.085) {
    float d1 = 9.0, d2 = 9.0, id = 0.0;
    for (int i = 0; i < 12; i++) { vec2 c = CROWN[i]; float d = length(vec2((s - c.x) * 0.85, z - c.y)); if (d < d1) { d2 = d1; d1 = d; id = float(i); } else if (d < d2) d2 = d; }
    float e = d2 - d1, a = fwidth(e) + 0.0004;
    line = 1.0 - smoothstep(0.0009, 0.0009 + a, e);
    h = 0.8 * smoothstep(0.0, 0.014, e); rnd = fract(sin(id * 12.9898) * 43758.5453);
    return 1;
  }
  if (tw > 1.28 && tw < 2.02) {
    float f = (s - ${f4(SN)}) / 0.024, fr = fract(f), lower = step(1.669, tw);
    float e = min(min(fr, 1.0 - fr) * 0.024, mix(tw - 1.28, 2.02 - tw, lower) * 0.03), a = fwidth(e) + 0.0004;
    line = 1.0 - smoothstep(0.0008, 0.0008 + a, e);
    h = 0.8 * smoothstep(0.0, 0.008, e); rnd = fract(sin(floor(f) * 7.13 + lower * 3.1) * 43758.5453);
    return 2;
  }
  return 0;
}
void snakeScales(out float h, out float cover, out float line, out float rnd, out float fade) {
  h = 0.0; cover = 1.0; line = 0.0; rnd = 0.5; fade = 0.0;
  float reg = vCustom.z;
  if (reg < 0.5) return;
  float th = vCustom.x * 6.2831853, s = vCustom.y;
  float belly = reg > 1.5 ? 0.0 : 1.0 - smoothstep(-0.88, -0.74, cos(th));
  vec2 p = vec2(vCustom.x * 21.0, s / 0.036);                   // 21 rows round the body (Naja)
  if (reg > 2.5) p = vec2(vCustom.w / 0.014, s / 0.036);         // hood flap: laid out as on the open hood
  // Head: big plates, laid on from above (crown) and from the side (lips), not wrapped round
  // the snout (a wrapped lattice converges into a net at the tip).
  if (reg > 1.5 && reg < 2.5) {
    float hp, lp, rp, fwp;
    if (headPlates(th, s, hp, lp, rp, fwp) > 0) { fade = 1.0 - smoothstep(0.6, 1.4, fwp); h = hp * fade; line = lp; rnd = rp; cover = 1.0; return; }
    p = vec2(vBind.y / 0.012 + 7.0, s / 0.016);                  // temples: small scales
  }
  vec2 pv = vec2(0.0, s / 0.03);
  float fw = max(fwidth(p.x), fwidth(p.y)), fwv = fwidth(pv.y);
  fade = 1.0 - smoothstep(0.22, 0.48, fw);
  if (fade <= 0.0) return;
  // dorsal lattice
  float k0 = floor(p.y * 2.0), d1 = 9.0, d2 = 9.0; vec2 dd = vec2(0.0), cc = vec2(0.0);
  for (int n = -1; n <= 2; n++) {
    float k = k0 + float(n), off = 0.5 * mod(k, 2.0);
    vec2 c = vec2(floor(p.x - off + 0.5) + off, 0.5 * k), d = p - c;
    float m = abs(d.x) + abs(d.y);
    if (m < d1) { d2 = d1; d1 = m; dd = d; cc = c; } else if (m < d2) d2 = m;
  }
  float st = 1.0 + 0.6 * uHood * step(2.5, reg);               // on an open hood flap the scales part
  float ms = abs(dd.x) * st + abs(dd.y);                      // the scale itself, unstretched
  float aa = fw * 1.5 + 0.02;
  float cov = 1.0 - smoothstep(0.5 - aa, 0.5, ms);
  float edge = 1.0 - smoothstep(0.0, 0.05 + aa, d2 - d1);     // the dark seam between neighbours
  float sh = clamp(0.5 + dd.y, 0.0, 1.0);                      // shingle: rises toward the rear edge
  float dome = 1.0 - (ms / 0.5) * (ms / 0.5);
  float hD = (0.6 * sh + 0.4 * max(dome, 0.0)) * cov;
  float rD = fract(sin(dot(cc, vec2(127.1, 311.7))) * 43758.5453);
  // ventral scutes
  float fv = fract(pv.y), id = floor(pv.y);
  float hV = 0.8 * fv;
  float eV = 1.0 - smoothstep(0.0, 0.1 + 2.0 * fwv, min(fv, 1.0 - fv));
  float rV = fract(sin(id * 91.7) * 43758.5453);
  float gap = smoothstep(1.0, 1.15, st);                        // on a spread hood the seams become gaps
  h = mix(hD, hV, belly) * fade;
  cover = mix(mix(1.0, cov, gap), 1.0, belly);
  line = mix(edge * (1.0 - gap), eV, belly);
  rnd = mix(rD, rV, belly);
}
float snakeH() { float h, c, l, r, f; snakeScales(h, c, l, r, f); return 0.24 * h; }
`;
const SCALES_SURFACE = `
  if (uColour > 0.5) {
    float hb = cobraMarks(diffuseColor.rgb);
    float h, cover, line, rnd, fade; snakeScales(h, cover, line, rnd, fade);
    diffuseColor.rgb *= mix(1.0, 0.88 + 0.24 * rnd, fade);                   // no two scales alike
    diffuseColor.rgb *= mix(1.0, 0.62, step(0.86, rnd) * fade * (1.0 - hb));  // and some darker: a fine speckle (photo 7)
    diffuseColor.rgb *= 1.0 - (0.5 + 0.25 * hb) * line * fade;               // dark seams between them (a strong net on the hood's back)
    diffuseColor.rgb *= mix(1.0, 0.86 + 0.2 * h / max(fade, 0.001), 0.5 * fade);   // rear edges catch light
    diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 0.35, 0.85 * (1.0 - cover) * fade);   // dark skin between spread hood scales: the net
  }
`;

export const VIEW = {
  camera: { pos: [2.3, 2.5, 5.7], target: [0, 0.35, 0] },
  floor: { color: 0x8a7a66 },
  // Dry, satiny scales, not a glossy toy (owner: "looks plastic"): rough base, a weak soft clear
  // coat, a dusty sheen, lower specular. Colour is per vertex (the tints) and in the shader.
  soft: { limb: 0xffffff, body: 0x222222, bodyClear: false, roughness: 0.64, clearcoat: 0.22, clearcoatRoughness: 0.5,
    limbProps: { sheen: 0.35, sheenRoughness: 0.75, sheenColor: 0xcfc2ad, specularIntensity: 0.6 } },
  // Scales and markings are the creature's own shader (skinFx.glsl, see SCALES below); the page's noise
  // mottle stays faint and its wrinkle bump is off.
  skinFx: { mottle: 0.05, bump: 0.12, glsl: {          // bump: fine relief that breaks the highlight at any distance
    uniforms: { uHood: 0 },          // hood spread this frame (pose(): P.parts.uniforms)
    head: COBRA_MARKS + SCALES_HEAD, height: 'snakeH()', surface: SCALES_SURFACE } },

  skin(ctx) {
    const { THREE, chains } = ctx, { L, MID, NSEG } = SPINE;
    const F = chains[0], R = chains[1], JAW = chains[2];
    const X0 = MID * L;                                    // bind x of the head joint (s = 0)
    // Each segment has one bone (front chain toward the head, rear toward the tail). A point
    // follows its own segment's bone, blended with the neighbour across the nearer joint.
    const segBone = j => j < MID ? F.boneBase + (MID - 1 - j) : R.boneBase + (j - MID);
    const spineW = s => {
      if (s <= 0.5 * L) return [[segBone(0), 0, 0, 0], [1, 0, 0, 0]];
      const j = Math.min(NSEG - 1, Math.floor(s / L)), f = Math.min(1, s / L - j);
      if (f >= 0.5) { const n = j + 1 < NSEG ? segBone(j + 1) : segBone(j); return [[segBone(j), n, 0, 0], [1.5 - f, f - 0.5, 0, 0]]; }
      return [[segBone(j), segBone(j - 1), 0, 0], [0.5 + f, 0.5 - f, 0, 0]];
    };
    const ribTip = (k, side) => chains[6 + 2 * k + side].boneBase + 1;
    const jawW = s => { const wj = 1 - ss(0.0, S_SPLIT, s), [ii, ww] = spineW(s);
      return [[JAW.boneBase, ii[0], ii[1], 0], [wj, (1 - wj) * ww[0], (1 - wj) * ww[1], 0]]; };

    // ---- Colour: a spectacled cobra (owner's photo 7). Pale grey-tan above, cream below, the
    // throat whitest; hood marks and throat bands are drawn crisp in the shader (COBRA_MARKS).
    const C = h => new THREE.Color(h), col = new THREE.Color();
    const BACK = C(0x847260), FLANK = C(0xa89680), BELLY = C(0xe2d9c6), THROAT = C(0xf0eade), HEAD = C(0x7a6854);
    const tintAt = (s, th) => {
      const c = Math.cos(th), under = ss(-0.15, -0.55, c);           // 0 on the back → 1 on the belly
      col.copy(s < 0.1 ? HEAD : BACK).lerp(FLANK, 0.55 * ss(0.55, 0.05, c) * (1 - under));
      col.lerp(s < 1.0 ? THROAT : BELLY, under);
      if (s > 0.1) col.multiplyScalar(1 - 0.1 * ss(3.6, 4.8, s));    // the tail darkens a little
      return col;
    };

    // ---- Rings along the body: dense at the snout and through the hood --------------------
    const rings = [];
    for (let i = 0; i <= 14; i++) rings.push(SN + 0.06 * (1 - Math.cos(Math.PI / 2 * i / 14)));   // the rounded snout
    for (let s = SN + 0.068; s < 0.17; s += 0.008) rings.push(s);
    for (let s = 0.17; s < 0.95; s += 0.012) rings.push(s);
    for (let s = 0.95; s < 4.0; s += 0.03) rings.push(s);
    for (let s = 4.0; s < SPINE.length - 0.02; s += 0.02) rings.push(s);
    rings.push(SPINE.length - 1e-4);
    const head = rings.filter(s => s < S_SPLIT); head.push(S_SPLIT);
    const body = [S_SPLIT, ...rings.filter(s => s > S_SPLIT + 1e-6)];

    const p = [], tint = [], wts = [], ix = [], cust = [];
    // aCustom per vertex for the scale shader: (angle round / 2π from the back, s, region, hood stretch)
    // region 1 = body scales, 2 = the head's larger plates, 0 = none (tongue, mouth lining).
    let region = 1, jawShape = false;
    // The lower jaw is narrower than the upper head (a V from below) and its lip tucks up inside
    // the upper lip (photo 6); a narrow skirt on the upper lip covers the step (MOUTH below).
    const jawN = s => mix(0.74, 1, ss(SN + 0.02, S_SPLIT, s));
    const vert = (s, q, w) => {
      const th = Math.PI + TAU * q / NA, v = section(s, th);
      if (jawShape) v.z *= jawN(s);
      p.push(X0 - s, v.y, v.z); const c = tintAt(s, th); tint.push(c.r, c.g, c.b); wts.push(w(s, v.z));
      cust.push(th / TAU, s, region, 0);
      return p.length / 3 - 1;
    };
    const grid = (ss_, q0, q1, w) => {                             // rings ss_ × columns q0..q1
      const base = p.length / 3, nq = q1 - q0 + 1;
      for (const s of ss_) for (let q = q0; q <= q1; q++) vert(s, q, w);
      for (let m = 0; m < ss_.length - 1; m++) for (let k = 0; k < nq - 1; k++) {
        const a = base + m * nq + k; ix.push(a, a + nq, a + 1, a + 1, a + nq, a + nq + 1);
      }
    };
    const top = NA / 2;
    region = 2;
    grid(head, top - QD, top + QD, s => spineW(s));                        // upper head (and upper lip)
    jawShape = true;
    grid(head, top + QD, NA + top - QD, s => jawW(s));                     // lower jaw, through the belly
    jawShape = false; region = 1;
    grid(body, 0, NA, s => spineW(s));                                     // neck, body, tail
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3)); g.setIndex(ix); g.computeVertexNormals();
    // One smooth surface: points that coincide (the belly seam, the mouth corner ring, the snout
    // tip, the closed lips) share their normals.
    {
      const Nn = g.attributes.normal, groups = new Map(), n = new THREE.Vector3();
      for (let i = 0; i < p.length / 3; i++) {
        const key = `${Math.round(p[3 * i] * 2e4)},${Math.round(p[3 * i + 1] * 2e4)},${Math.round(p[3 * i + 2] * 2e4)}`;
        (groups.get(key) || groups.set(key, []).get(key)).push(i);
      }
      for (const ids of groups.values()) if (ids.length > 1) {
        n.set(0, 0, 0); for (const i of ids) n.x += Nn.getX(i), n.y += Nn.getY(i), n.z += Nn.getZ(i);
        n.normalize(); for (const i of ids) Nn.setXYZ(i, n.x, n.y, n.z);
      }
    }
    g.setAttribute('aTint', new THREE.Float32BufferAttribute(tint, 3));
    g.setAttribute('aCustom', new THREE.Float32BufferAttribute(cust, 4));
    ctx.addGeometry(g, vi => wts[vi]);

    // ---- The hood: a thin skin flap each side, rooted just inside the neck's flank ----------
    // Two layers (back and front) that meet at a thin edge. Bound folded flat against the neck
    // (every point of a flap at the neck's side), they open as the ribs lengthen: a point a
    // fraction u of the way out follows the rib tips by u, the spine by 1 − u, so it lands u of the
    // way to the hood's outline. The ribs also cup it forward round the head.
    {
      const hp = [], ht = [], hw = [], hc = [], hn = [], hi = [], NU = 18;
      const hs = rings.filter(s => s >= HOOD.s0 && s <= HOOD.s1); if (hs[0] > HOOD.s0) hs.unshift(HOOD.s0); hs.push(HOOD.s1);
      for (const sg of [1, -1]) for (const ly of [1, -1]) {
        const base = hp.length / 3;
        for (const s of hs) {
          const w = SHAPE.w(s), w0 = w - HOOD.inset, W = w0 + SHAPE.hs((s - HOOD.s0) / (HOOD.s1 - HOOD.s0)) * (HOOD.max - w0);
          // Rib weights: a quadratic B-spline over the three nearest ribs, so the outline is smooth
          // (straight blends between ribs gave it corners); the root follows its own segment's bone.
          const xr = (s - HOOD.s0) / L, k = Math.round(xr), g = xr - k, side = sg > 0 ? 0 : 1;
          const bw = [(0.5 - g) ** 2 / 2, 0.75 - g * g, (0.5 + g) ** 2 / 2], own = spineW(s)[0][0];
          for (let n = 0; n <= NU; n++) {
            const u = n / NU, t = 0.008 * (1 - u * u) + 0.0004;
            hp.push(X0 - s, ly * t, sg * w0); hn.push(0, ly, 0);
            const c = tintAt(s, ly > 0 ? 0 : Math.PI); ht.push(c.r, c.g, c.b);
            hc.push(ly > 0 ? 0 : 0.5, s, 3, w0 + u * (W - w0));
            const lo = k >= 1;                                    // no rib before the first: that share stays on the spine
            hw.push([[own, lo ? ribTip(k - 1, side) : own, ribTip(k, side), ribTip(k + 1, side)],
                     [(1 - u) + (lo ? 0 : u * bw[0]), lo ? u * bw[0] : 0, u * bw[1], u * bw[2]]]);
          }
        }
        for (let m = 0; m < hs.length - 1; m++) for (let n = 0; n < NU; n++) {
          const a = base + m * (NU + 1) + n, b = a + NU + 1;
          if (sg * ly > 0) hi.push(a, b, a + 1, a + 1, b, b + 1); else hi.push(a, a + 1, b, a + 1, b + 1, b);
        }
      }
      const gh = new THREE.BufferGeometry();
      gh.setAttribute('position', new THREE.Float32BufferAttribute(hp, 3)); gh.setAttribute('normal', new THREE.Float32BufferAttribute(hn, 3));
      gh.setIndex(hi); gh.setAttribute('aTint', new THREE.Float32BufferAttribute(ht, 3)); gh.setAttribute('aCustom', new THREE.Float32BufferAttribute(hc, 4));
      ctx.addGeometry(gh, vi => hw[vi]);
    }

    // ---- Mouth lining: pink palate under the upper head, a floor on the jaw ------------------
    {
      const p2 = [], t2 = [], w2 = [], i2 = [], NU = 12, PINK = C(0xb8605e), DEEP = C(0x4e1c1e);
      for (const [sign, wf] of [[1, s => spineW(s)], [-1, s => jawW(s)]]) {
        const base = p2.length / 3;
        for (const s of head) {
          const d = dims(s), lip = section(s, TAU * QD / NA, d), lz = lip.z * (sign > 0 ? 1 : jawN(s));   // lip line, one side
          for (let u = 0; u <= NU; u++) {
            const a = u / NU, z = mix(-lz, lz, a), arch = 4 * a * (1 - a) * 0.5 * (sign > 0 ? d.hd : d.hv);
            p2.push(X0 - s, lip.y + sign * arch, z);
            const c = col.copy(PINK).lerp(DEEP, ss(-0.04, S_SPLIT, s) * 0.85).multiplyScalar(1 - 0.35 * Math.exp(-Math.pow((a - 0.5) / 0.12, 2)));   // darker down the middle, deeper toward the throat
            t2.push(c.r, c.g, c.b); w2.push(wf(s));
          }
        }
        for (let m = 0; m < head.length - 1; m++) for (let u = 0; u < NU; u++) {
          const a = base + m * (NU + 1) + u; i2.push(a, a + NU + 1, a + 1, a + 1, a + NU + 1, a + NU + 2);
        }
      }
      const g2 = new THREE.BufferGeometry();
      g2.setAttribute('position', new THREE.Float32BufferAttribute(p2, 3)); g2.setIndex(i2); g2.computeVertexNormals();
      g2.setAttribute('aTint', new THREE.Float32BufferAttribute(t2, 3));
      ctx.addGeometry(g2, vi => w2[vi]);
      // Fangs (photo 6): two short white hooks at the front of the upper jaw. Shut, their tips
      // sit inside the lower jaw; they show when it gapes.
      const sf = -0.088, d = dims(sf), lip = section(sf, TAU * QD / NA, d), IVORY = C(0xf2ede0);
      for (const sg of [1, -1]) {
        const f = new THREE.ConeGeometry(0.0028, 0.017, 8, 1); f.rotateX(Math.PI); f.rotateZ(0.25);   // point down, raked back
        f.translate(X0 - sf, lip.y - 0.0005, sg * 0.6 * lip.z);
        const n = f.attributes.position.count;
        f.setAttribute('aTint', new THREE.Float32BufferAttribute(Array.from({ length: n }, () => [IVORY.r, IVORY.g, IVORY.b]).flat(), 3));
        ctx.addGeometry(f, () => spineW(sf));
      }
      // Upper-lip skirt: from the lip line in and down to the narrower lower lip, so a shut mouth
      // shows no gap where the jaw steps in.
      const sk = [], sn = [], st = [], sw = [], si = [];
      for (const sg of [1, -1]) {
        const base = sk.length / 3;
        for (const s of head) {
          const dd = dims(s), lp = section(s, TAU * QD / NA, dd), c = tintAt(s, TAU * QD / NA);
          for (const [z, y] of [[lp.z, lp.y], [lp.z * jawN(s) * 0.97, lp.y - 0.006 * (1 - ss(S_SPLIT - 0.03, S_SPLIT, s))]]) {
            sk.push(X0 - s, y, sg * z); sn.push(0, -0.6, sg * 0.8); st.push(c.r, c.g, c.b); sw.push(spineW(s));
          }
        }
        for (let m = 0; m < head.length - 1; m++) { const a = base + 2 * m; si.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
      }
      const gs = new THREE.BufferGeometry();
      gs.setAttribute('position', new THREE.Float32BufferAttribute(sk, 3)); gs.setAttribute('normal', new THREE.Float32BufferAttribute(sn, 3));
      gs.setIndex(si); gs.setAttribute('aTint', new THREE.Float32BufferAttribute(st, 3));
      ctx.addGeometry(gs, vi => sw[vi]);
    }

    // ---- Eyes: glossy dark lenses on the head bone ----------------------------------------
    {
      const hb = F.bones[MID - 1], hbPos = new THREE.Vector3(X0 - L, 0, 0), qi = F.q.clone().invert();
      // Bronze iris round a big round black pupil (photos 5, 7), set on the side under the brow ledge.
      const iris = new THREE.CanvasTexture(irisCanvas()); iris.colorSpace = THREE.SRGBColorSpace;
      const lens = new THREE.MeshPhysicalMaterial({ map: iris, roughness: 0.05, clearcoat: 1, clearcoatRoughness: 0.03 });
      const se = BROW_S;
      for (const sg of [1, -1]) {
        const th = sg * (Math.PI / 2 - 0.4), v = section(se, th);
        const nrm = new THREE.Vector3(0.15, Math.cos(th) * 0.7, Math.sin(th)).normalize();   // looks out and a little forward
        const m = new THREE.Mesh(new THREE.SphereGeometry(0.016, 32, 20), lens);
        m.position.set(X0 - se, v.y - 0.002, v.z).addScaledVector(nrm, -0.008).sub(hbPos).applyQuaternion(qi);   // only a dome shows
        m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), nrm.clone().applyQuaternion(qi));   // texture pole = pupil
        hb.add(m);
      }
    }
    return {};
  },

  // The ground: a layer of grit and pebbles over the page's floor, fixed in place, its pattern
  // sliding back as the cobra crawls (P.parts gc/gs: TILE per 2π), so the belly visibly grips.
  build(THREE, body) {
    const tex = new THREE.CanvasTexture(gritCanvas());
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping; tex.repeat.set(14, 14); tex.colorSpace = THREE.SRGBColorSpace;
    const fc = document.createElement('canvas'); fc.width = fc.height = 256;
    const g2 = fc.getContext('2d'), gr = g2.createRadialGradient(128, 128, 10, 128, 128, 128);
    gr.addColorStop(0, '#fff'); gr.addColorStop(0.5, '#bbb'); gr.addColorStop(1, '#000');
    g2.fillStyle = gr; g2.fillRect(0, 0, 256, 256);
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(14, 14), new THREE.MeshStandardMaterial({
      map: tex, alphaMap: new THREE.CanvasTexture(fc), transparent: true, depthWrite: false, roughness: 1 }));
    ground.rotation.x = -Math.PI / 2; ground.position.y = 0.002; ground.receiveShadow = true; ground.renderOrder = 1;
    body.parent.add(ground);
    return { meshes: [], ground };
  },
  apply(P, parts) {
    const g = parts.ground; if (!g) return;
    g.material.map.offset.x = Math.atan2(P.parts.gs ?? 0, P.parts.gc ?? 1) / TAU;   // in tiles; one tile = one pattern
    const f = P.parts.floor ?? 1; g.material.opacity = f; g.visible = f > 0.01;
  },
};

// One TILE of ground, seamless: sand specks, small stones, a few bigger ones, faint patches.
function gritCanvas() {
  const N = 1024, c = document.createElement('canvas'); c.width = c.height = N;
  const g = c.getContext('2d');
  let sd = 4711; const r = () => ((sd = (sd * 16807) % 2147483647) / 2147483647);
  const blot = (x, y, rx, ry, rot, fill) => {
    for (const ox of [-N, 0, N]) for (const oy of [-N, 0, N]) {
      const X = x + ox, Y = y + oy, m = Math.max(rx, ry) + 2;
      if (X < -m || X > N + m || Y < -m || Y > N + m) continue;
      g.save(); g.translate(X, Y); g.rotate(rot); g.fillStyle = fill; g.beginPath(); g.ellipse(0, 0, rx, ry, 0, 0, TAU); g.fill(); g.restore();
    }
  };
  // Only small features: anything bigger than a few % of the tile shows the repeat.
  for (let i = 0; i < 11000; i++) { const d = r() < 0.5; blot(r() * N, r() * N, 1.2 + r() * 2.2, 1 + r() * 1.8, r() * TAU, d ? `rgba(58,46,34,${0.3 + r() * 0.35})` : `rgba(214,198,170,${0.25 + r() * 0.35})`); }
  for (let i = 0; i < 700; i++) {
    const rr = 4 + r() * 12, v = 90 + (r() * 90 | 0), x = r() * N, y = r() * N, rot = r() * TAU, e = 0.55 + 0.4 * r();
    blot(x + 2, y + 2.5, rr, rr * e, rot, 'rgba(30,22,14,0.4)');                           // contact shadow
    blot(x, y, rr, rr * e, rot, `rgba(${v + 14},${v + 4},${v - 10},${0.6 + 0.3 * r()})`);
    blot(x - rr * 0.25, y - rr * 0.3, rr * 0.45, rr * e * 0.35, rot, 'rgba(255,245,225,0.18)');   // a lit top
  }
  return c;
}

// Cobra iris (photo 5) for a sphere whose +y pole looks out: rows run pole → equator. A big round
// black pupil, an amber iris streaked toward a dark rim, then dark.
function irisCanvas() {
  const W = 256, H = 128, c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d');
  g.fillStyle = '#120c08'; g.fillRect(0, 0, W, H);
  const band = (v0, v1, a, b) => { const gr = g.createLinearGradient(0, v0 * H, 0, v1 * H); gr.addColorStop(0, a); gr.addColorStop(1, b); g.fillStyle = gr; g.fillRect(0, v0 * H, W, (v1 - v0) * H); };
  band(0.12, 0.33, '#b07a34', '#5a3612');
  let sd = 3; const r = () => ((sd = (sd * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 160; i++) { g.strokeStyle = r() < 0.5 ? `rgba(250,210,130,${0.2 + 0.3 * r()})` : `rgba(60,30,10,${0.25 + 0.3 * r()})`;
    const x = r() * W; g.lineWidth = 1 + r() * 1.5; g.beginPath(); g.moveTo(x, 0.13 * H); g.lineTo(x + (r() - 0.5) * 6, 0.32 * H); g.stroke(); }
  band(0.3, 0.36, 'rgba(26,18,12,0)', '#1a120c');
  g.fillStyle = '#050404'; g.fillRect(0, 0, W, 0.14 * H);
  return c;
}
