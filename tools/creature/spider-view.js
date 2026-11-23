// The peacock spider's view (Maratus volans): body parts that are not chains (carapace, abdomen, fan,
// eyes), the camera framing, the Soft skin and its shader. Its own file, as creature.html prefers for
// new creatures. build(THREE, body, mats) / skin(ctx) / apply(P) as in views.js.
//
// The look follows the owner's photos (tools side-session notes, spider-refs 5–10; 10 is the classic
// M. volans): a dome-shaped fan of golden-orange flaps round nested arches of red and light blue, a
// dark centre stripe, a green crown and a light-blue rim with a white fringe; red and blue-grey
// stripes over the top of the head; huge main eyes with a green rim; white fluffy palps and
// chelicerae; legs banded brown and white, legs III ending in a black brush and a white tip.
import { SHAPE as S } from './spider-def.js';

// Leg banding and the fan, in the engine's per-creature shader hook (skinFx.glsl). Legs and palps
// carry vCustom = [kind, k, q, 0] (spider-def.js limbFx): kind 1 leg, 2 leg III, 3 palp; u, how far
// along the limb, comes back from the tube's length count. The fan carries vCustom = [−1, X, s, ρ]
// from its own geometry: X across, s along (0 = the bottom of the raised fan), ρ = |X| / the fan's
// half-width there (1 at the rim). Painting it here, not per vertex, keeps the stripes' edges
// crisp at any size.
const lin = hex => {
  const f = c => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  return `vec3(${[16, 8, 0].map(b => f((hex >> b) & 255).toFixed(4)).join(', ')})`;
};
// The fan's pattern (photo 10): bands either side of a dark centre stripe that run up from the
// bottom and fan outward toward the top, like a fountain. Each band's outer edge at the bottom
// (a fraction of the fan's half-width), colour, iridescence. Then the centre stripe, a green
// crown, a red arc under the rim, the light-blue rim and the white fringe.
const BANDS = [[0.1, 0x8cc4f4, 1], [0.2, 0xd8301a, 0.25], [0.27, 0x8cc4f4, 1], [0.52, 0xf2a01a, 0.2], [0.6, 0x3a84e0, 1]];
const FLARE = 1.3;   // how far the bands spread toward the top
const HEAD = `
// Hair. On a limb tube, strands run along it: noise sampled round a circle (vSk.x is periodic,
// so no seam down the leg) and stretched along the length count vSk.y. Elsewhere, fuzz.
float strands(float n, float along, float seed) {
  float a = vSk.x * 6.2831853, R = n / 6.2831853;
  return vnoise(vec3(R * cos(a), R * sin(a), vSk.y * along + seed));
}
// Scale hairs (photo 8): flat, lying back over each other like roof tiles, pointing along +a.
// ab = (along, across) in body units on the surface; n scales per unit across, each about twice as
// long as wide, rows staggered. Returns (how far toward its tip 0..1, the scale's own random, the
// shadowed gap round it, fade); fade drops where a scale is under a couple of pixels, so distant
// scales blend to their average instead of shimmering.
vec4 scaleField(vec2 ab, float n) {
  // No rows (rows read as woven cloth): each point belongs to the nearest of a scatter of scale
  // centres, and a scale reaches further back than forward, so they overlap like loose tiles.
  vec2 q = vec2(ab.x * n * 0.6, ab.y * n), ci = floor(q), f = fract(q);
  float d1 = 9.0, d2 = 9.0, r = 0.0; vec2 b = vec2(0.0);
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 o = vec2(float(i), float(j)), c = ci + o;
    vec2 d = o + 0.075 + 0.85 * vec2(hash3(vec3(c, 1.0)), hash3(vec3(c, 2.0))) - f;   // to this scale's centre
    vec2 e = vec2(d.x < 0.0 ? 0.6 * d.x : d.x, d.y);                                  // longer toward its tip
    float dd = dot(e, e);
    if (dd < d1) { d2 = d1; d1 = dd; b = d; r = hash3(vec3(c, 7.0)); } else if (dd < d2) d2 = dd;
  }
  float t = clamp(0.5 - 0.9 * b.x, 0.0, 1.0);                                       // from its covered base to its tip
  float gap = 1.0 - smoothstep(0.02, 0.22, sqrt(d2) - sqrt(d1));                     // where the next scale overlaps
  float fade = 1.0 - smoothstep(0.35, 0.65, max(fwidth(q.x), fwidth(q.y)));
  return vec4(t, r, gap, fade);
}
// Bare cuticle, not scales: the dark sides of the carapace and abdomen (photo 6).
float cuticle() { return 1.0 - smoothstep(0.015, 0.06, dot(vTint, vec3(0.3, 0.6, 0.1))); }
#define BODY_SCALES 95.0
#define FAN_SCALES 120.0
float hairH() {
  // Kept faint on the legs: the cuticle shows between a few real hairs (the shell fur); strong
  // strands here read as a coat of fur (owner: too dense).
  if (vCustom.x > 0.5 && vSk.y >= 0.0) return 0.22 * strands(48.0, 0.4, 0.0) + 0.1 * strands(110.0, 1.0, 5.0);
  // Scales rise toward their tips and drop into the gap: the light catches every tip.
  if (vCustom.x > 0.1) { vec4 s = scaleField(vCustom.yz, BODY_SCALES); return (0.35 * s.x * (1.0 - 0.6 * s.z) * s.w) * (1.0 - 0.8 * cuticle()); }
  if (vCustom.x < -0.5) { vec4 s = scaleField(vCustom.zy, FAN_SCALES); return 0.2 * s.x * (1.0 - 0.6 * s.z) * s.w; }
  return 0.18 * vnoise(vBind * 120.0) + 0.08 * vnoise(vBind * 260.0);          // chelicerae, waist: a fine grain
}
vec3 fanColour(vec3 f, out float ir) {
  float ax = abs(f.x) / ${S.fanMax.toFixed(3)}, y = f.y / ${S.abd.toFixed(3)}, rho = f.z;
  float u = ax / (1.0 + ${FLARE.toFixed(2)} * y * y * y) + 0.014 * (vnoise(vBind * 70.0) - 0.5);   // scaly, not ruled, edges
  float uw = fwidth(u) + 1e-4;
  vec3 c = ${lin(0xf2a01a)}; ir = 0.2;
  float line = 1.0; bool found = false;
  ${BANDS.map(([w, col, i]) => `{
    line = min(line, smoothstep(0.0, 2.5 * uw + 0.01, abs(u - ${w.toFixed(3)})));
    if (!found && u < ${w.toFixed(3)}) { c = ${lin(col)}; ir = ${i.toFixed(2)}; found = true; }
  }`).join('\n  ')}
  vec3 dg = ${lin(0x14261a)};
  c = mix(c, dg, 0.45 * (1.0 - line));                                          // soft dark lines between bands
  float aw = fwidth(ax) + 1e-4, yw = fwidth(y) + 1e-4, rw = fwidth(rho) + 1e-4;
  float stripe = (1.0 - smoothstep(0.05 - aw, 0.05 + aw, ax)) * (1.0 - smoothstep(0.86 - yw, 0.86 + yw, y));
  c = mix(c, dg, stripe); ir = mix(ir, 0.4, stripe);
  float cx = ax / 0.2, cy = (y - 0.9) / 0.12, cr = cx * cx + cy * cy;   // (pow of a negative base is undefined)
  float crown = 1.0 - smoothstep(1.0 - 3.0 * fwidth(cr), 1.0, cr);
  c = mix(c, mix(${lin(0x3e7a2c)}, dg, 0.35), crown); ir = mix(ir, 0.7, crown);
  float arc = smoothstep(0.76 - rw, 0.76 + rw, rho) * (1.0 - smoothstep(0.87 - rw, 0.87 + rw, rho)) * smoothstep(0.48, 0.52, y);
  c = mix(c, ${lin(0xd8301a)}, arc); ir = mix(ir, 0.25, arc);
  float rim = smoothstep(0.87 - rw, 0.87 + rw, rho);
  c = mix(c, ${lin(0x88b8f2)}, rim); ir = mix(ir, 1.0, rim);
  float fr = smoothstep(0.955, 0.975, rho);
  c = mix(c, ${lin(0xf2efe8)}, fr); ir = mix(ir, 0.0, fr);
  return c;
}`;
const SURFACE = `
if (uColour > 0.5) {
  if (vCustom.x > 0.5 && vSk.y >= 0.0) {
    float u = clamp((1.0 - exp(-vSk.y * vCustom.y)) / vCustom.z, 0.0, 1.0);
    float f = fract(u * 6.0 + 0.02);                       // six segments, a pale ring at each joint and one mid-way
    float band = max(smoothstep(0.8, 0.86, f), 1.0 - smoothstep(0.03, 0.09, f))
      + 0.55 * (smoothstep(0.4, 0.44, f) - smoothstep(0.5, 0.54, f));
    float s1 = strands(48.0, 0.4, 0.0), s2 = strands(110.0, 1.0, 5.0);
    band = clamp(band + 0.3 * (s1 - 0.5), 0.0, 1.0);        // ragged band edges: hairs, not paint
    vec3 brown = vec3(0.15, 0.115, 0.085), pale = vec3(0.6, 0.57, 0.52);
    vec3 c = mix(brown, pale, band);
    // Salt and pepper: single white hairs in the brown, dark ones in the pale.
    c = mix(c, pale * 1.15, 0.7 * smoothstep(0.78, 0.9, strands(150.0, 1.5, 11.0)) * (1.0 - band));
    c = mix(c, brown * 0.5, 0.6 * smoothstep(0.8, 0.92, strands(140.0, 1.3, 23.0)) * band);
    if (vCustom.x > 1.5 && vCustom.x < 2.5) {              // leg III: black brush, white tip
      c = mix(c, vec3(0.012), smoothstep(0.63, 0.68, u + 0.03 * (s1 - 0.5)));
      c = mix(c, vec3(0.9, 0.88, 0.84), smoothstep(0.85, 0.89, u + 0.03 * (s2 - 0.5)));
    }
    if (vCustom.x > 2.5) c = mix(vec3(0.09, 0.06, 0.04), vec3(0.86, 0.84, 0.8), smoothstep(0.3, 0.6, u + 0.15 * (s1 - 0.5)));   // palp: a white pad
    c *= 0.8 + 0.25 * s1 + 0.1 * s2;                        // faint strand shading
    diffuseColor.rgb = c * vTint;                           // vTint keeps the joint shading
  } else if (vCustom.x > 0.1) {
    // Carapace and abdomen: scale hairs, read as velvet. Each scale a little lighter toward its
    // tip, a shade off its neighbours in tone and hue, a soft shadow round it; a broad mottle
    // underneath keeps the surface alive where the scales are too small to draw.
    vec4 s = scaleField(vCustom.yz, BODY_SCALES);
    float r2 = hash3(vec3(s.y * 91.0, 3.0, 5.0)), cut = cuticle();
    vec3 tone = vec3((0.84 + 0.22 * s.x) * (0.86 + 0.28 * s.y) * (1.0 - 0.22 * s.z)) * vec3(0.95 + 0.1 * r2, 1.0, 1.05 - 0.1 * r2);
    diffuseColor.rgb *= mix(vec3(0.97), tone, s.w * (1.0 - 0.75 * cut)) * (0.88 + 0.24 * vnoise(vBind * 18.0));
    roughnessFactor = mix(roughnessFactor, 0.4, cut);       // cuticle has a soft shine; scales stay matte
  } else if (vCustom.x > -0.5) {
    // Chelicerae, waist, the flaps' undersides: a fine grain.
    diffuseColor.rgb *= 0.84 + 0.3 * vnoise(vBind * 120.0);
  } else {
    // The fan: coloured scales. Structural colour shifts toward violet-teal at a slant, and single
    // scales flash as the angle to the eye passes theirs.
    vec4 s = scaleField(vCustom.zy, FAN_SCALES);
    float ir; vec3 c = fanColour(vCustom.yzw, ir);
    c *= mix(0.98, (0.88 + 0.16 * s.x) * (0.9 + 0.2 * s.y) * (1.0 - 0.14 * s.z), s.w) * (0.92 + 0.16 * vnoise(vBind * 18.0));
    vec3 V = normalize(vViewPosition);
    float ndv = abs(dot(normal, V)), fres = pow(1.0 - ndv, 2.0);
    vec3 shift = vec3(0.5 * c.b + 0.2 * c.g, 0.3 * c.r + 0.6 * c.b, 0.4 * c.g + 0.5 * c.r + 0.1);
    diffuseColor.rgb = mix(c, shift, 0.5 * ir * fres) * vTint;
    float flash = s.w * (1.0 - s.z) * smoothstep(0.955, 0.995, fract(s.y * 13.7 + dot(V, vec3(1.3, 2.1, 0.7)) * 1.6));
    totalEmissiveRadiance += diffuseColor.rgb * (0.14 + 0.8 * ir * flash);
  }
}`;

export const VIEW = {
  camera: { pos: [3.0, 1.45, 3.3], target: [-0.75, 0.6, 0] },
  floor: { color: 0x5a4c3e },
  // The coat (engine shell fur): where and how long is per vertex (legs, palps: CHAINS `fur` in
  // spider-def.js; body: aFur here). 5 shells: the owner's Intel MacBook draws each one again.
  fur: { shells: 5, freq: 100, droop: 0.3, gravity: 0.12 },
  // Matte: fur and scales do not shine (only the eyes do, in their own material). Sheen gives the
  // soft bright edge a velvety, hairy surface has against the light.
  soft: { limb: 0xffffff, body: 0x222222, bodyClear: false, roughness: 0.82, clearcoat: 0, clearcoatRoughness: 0.5,
    limbProps: { sheen: 1, sheenRoughness: 0.55, sheenColor: 0x7a746c } },
  skinFx: { mottle: 0.06, bump: 0.22, glsl: { head: HEAD, height: 'hairH()', surface: SURFACE } },

  // Carapace, pedicel, abdomen and fan go into the skinned mesh; the eyes are glossy lenses
  // parented to the carapace bone (their own material: they shine where the hairy body does not).
  skin(ctx) {
    const { THREE, chains, boneAt, axisAt } = ctx, TAUv = Math.PI * 2;
    const C = h => new THREE.Color(h), col = new THREE.Color();
    const sgp = (x, e) => Math.sign(x) * Math.pow(Math.abs(x), e);
    const cl = (x, a, b) => Math.min(b, Math.max(a, x));
    const ssv = (a, b, x) => { const t = cl((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
    const NOFX = [0, 0, 0, 0];
    // Fur (the engine's shell fur): [length, density, tip lightness, strands per unit]; none = bald.
    // White fluff on the face and chelicerae; the rest of the body and the fan are bald (most of a
    // real peacock spider shows cuticle; its hairiness is on the legs and palps).
    const FLUFF_FUR = [0.035, 0.3, 0.5, 120];
    // A grid of (NU+1) × (NV+1) points; closed: column NV repeats column 0 (normals averaged).
    // at(m, q) → { x, y, z, c (colour), w (bone weights), k (aCustom), f (aFur); k and f optional }.
    const sheet = (NU, NV, at, closed) => {
      const p = [], tint = [], wts = [], cu = [], fu = [], ix = [];
      for (let m = 0; m <= NU; m++) for (let q = 0; q <= NV; q++) {
        const r = at(m, q); p.push(r.x, r.y, r.z); tint.push(r.c.r, r.c.g, r.c.b); wts.push(r.w); cu.push(...(r.k || NOFX)); fu.push(...(r.f || NOFX));
      }
      for (let m = 0; m < NU; m++) for (let q = 0; q < NV; q++) {
        const a = m * (NV + 1) + q; ix.push(a, a + NV + 1, a + 1, a + 1, a + NV + 1, a + NV + 2);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3)); g.setIndex(ix); g.computeVertexNormals();
      if (closed) {
        const N = g.attributes.normal, n1 = new THREE.Vector3(), n2 = new THREE.Vector3();
        for (let m = 0; m <= NU; m++) {
          const a0 = m * (NV + 1), b0 = a0 + NV;
          n1.fromBufferAttribute(N, a0).add(n2.fromBufferAttribute(N, b0)).normalize();
          N.setXYZ(a0, n1.x, n1.y, n1.z); N.setXYZ(b0, n1.x, n1.y, n1.z);
        }
      }
      g.setAttribute('aTint', new THREE.Float32BufferAttribute(tint, 3));
      g.setAttribute('aCustom', new THREE.Float32BufferAttribute(cu, 4));
      g.setAttribute('aFur', new THREE.Float32BufferAttribute(fu, 4));
      ctx.addGeometry(g, vi => wts[vi]);
    };
    const rigid = b => [[b, 0, 0, 0], [1, 0, 0, 0]];

    // ---- Carapace: a tall box, flat face, flat eye region sloping down to the back. In bind
    // space it lies along −x from the face at x = 0; y up. The lower half narrows so the legs
    // come out from under its margin.
    const cara = chains[0], cb = cara.boneBase, LC = cara.length, rho = 0.06, rb = 0.12;
    const top = X => 0.5 + 0.012 * Math.sin(Math.PI * Math.min(1, X / 0.45)) - 0.3 * ssv(0.45, 1, X);
    const bot = X => -0.11 + 0.06 * ssv(0.55, 1, X);
    const wid = X => 0.31 + 0.06 * Math.sin(Math.PI * Math.min(1, X / 0.95)) - 0.05 * ssv(0.75, 1, X);
    const rings = [];
    for (let i = 0; i <= 6; i++) rings.push({ X: 0, k: i / 6, d: rho });            // the flat face
    for (let i = 1; i <= 6; i++) { const ph = Math.PI / 2 * i / 6; rings.push({ X: rho * (1 - Math.cos(ph)), k: 1, d: rho * (1 - Math.sin(ph)) }); }
    for (let i = 1; i <= 40; i++) rings.push({ X: rho + (LC - rho - rb) * i / 40, k: 1, d: 0 });
    for (let i = 1; i <= 8; i++) { const ph = Math.PI / 2 * i / 8; rings.push({ X: LC - rb + rb * Math.sin(ph), k: Math.cos(ph), d: 0 }); }
    // Photo 8: bold stripes run front to back over the top and on down the face above the eyes:
    // blue-grey down the middle, then red-orange, blue-grey, red-orange, a thin blue-grey; the sides
    // dark, a fringe of white hair along the margin; white fluff under the eyes.
    const RED = C(0xd8441c), BLUEGREY = C(0x7a96a8), DARK = C(0x1e1612), MARGIN = C(0xd6d0c4), FLUFF = C(0xdcd8d0);
    const stripe = zn => zn < 0.1 ? BLUEGREY : zn < 0.36 ? RED : zn < 0.5 ? BLUEGREY : zn < 0.76 ? RED : zn < 0.86 ? BLUEGREY : DARK;
    const NV = 96;
    sheet(rings.length - 1, NV, (m, q) => {
      const { X, k, d } = rings[m], T = top(X), B = bot(X), yc = (T + B) / 2;
      const hh = k * ((T - B) / 2 - d), hw = k * (wid(X) - d);
      const th = TAUv * q / NV, cs = Math.cos(th), sn = Math.sin(th);
      const y = yc + hh * sgp(cs, 0.667), z = hw * sgp(sn, 0.667) * (1 - 0.22 * Math.max(0, -cs));
      const zn = Math.abs(z) / wid(X), face = X < 0.035;
      col.copy(DARK);
      if (face) { if (y > 0.43) col.copy(stripe(zn)); else if (y < 0.17) col.copy(FLUFF); }
      else if (cs > 0.3) col.copy(stripe(zn)).lerp(DARK, ssv(0.62, 0.85, X) + (1 - ssv(0.3, 0.5, cs)) * 0.6);
      else if (cs < -0.25) col.copy(MARGIN).lerp(DARK, ssv(-0.55, -0.8, cs));
      // Fur: only the white fluff under the eyes. Sparse fuzz elsewhere hardly showed and cost the
      // most (the shells redraw every furry triangle); the hairy look is the legs' and palps'.
      const f = face && y < 0.17 ? FLUFF_FUR : null;
      // Scale-hair coordinates for the shader: along the body (back from the face) and around it,
      // its seam under the sternum where no one looks.
      const around = (th > Math.PI ? th - TAUv : th) * 0.5 * (hw + hh);
      return { x: -X, y, z, c: col, w: rigid(cb), f, k: [0.25, X, around, 0] };
    }, true);
    // Chelicerae: two rounded lumps under the face, white fluff (mostly hidden behind the palps).
    const blob = (cx, cy, cz, rx, ry, rz, colour, b) => sheet(12, 16, (m, q) => {
      const th = Math.PI * m / 12, ph = TAUv * q / 16;
      return { x: cx + rx * Math.sin(th) * Math.cos(ph), y: cy + ry * Math.cos(th), z: cz + rz * Math.sin(th) * Math.sin(ph), c: colour, w: rigid(b), f: FLUFF_FUR };
    }, true);
    for (const sg of [1, -1]) blob(-0.01, 0.0, sg * 0.075, 0.06, 0.1, 0.065, FLUFF, cb);

    // ---- Pedicel and abdomen (chain 1: bone 0 the waist, bone 1 the abdomen) --------------
    const ab = chains[1], pb = ab.boneBase, ax = new THREE.Vector3();
    sheet(10, 12, (m, q) => {
      const s = -0.05 + (ab.L[0] + 0.1) * m / 10, ph = TAUv * q / 12;
      axisAt(ab, s, ax);
      const k = boneAt(ab, cl(s, 0, ab.length - 1e-4));
      return { x: ax.x, y: ax.y + 0.05 * Math.cos(ph), z: ax.z + 0.05 * Math.sin(ph), c: DARK, w: [[k.i, k.b1, 0, 0], [1 - k.w1, k.w1, 0, 0]] };
    }, true);
    const A0 = axisAt(ab, ab.L[0], new THREE.Vector3()), abone = pb + 1;

    // The fan (dorsal plate and flaps alike) is painted by the shader (HEAD fanColour); its
    // vertices carry the fan coordinates: X across (the abdomen's own side axis), s along, ρ.
    const ONE = C(0xffffff), WHITE = C(0xf2efe8);
    const fanK = (X, s) => { const fw = S.fanW(s); return [-1, X, s, Math.min(1.2, fw > 1e-4 ? Math.abs(X) / fw : 1.2)]; };
    const Hd = s => 0.07 * Math.pow(S.hinge(s) / S.hw, 0.8);                   // dorsal dome over the hinge line
    const Hb = s => 0.31 * Math.pow(1 - Math.pow(Math.min(1, Math.abs(2 * s / S.abd - 1)), 2.2), 1 / 2.2);   // belly
    const SIDE = C(0x3a2a20), BELLY = C(0x6a5444);
    sheet(64, 96, (m, q) => {
      const u = m / 64, s = S.abd * (0.5 - 0.5 * Math.cos(Math.PI * u));      // closer rings at the ends
      const th = TAUv * q / 96, cs = Math.cos(th), sn = Math.sin(th), Zl = S.hinge(s) * sn;
      const y = cs >= 0 ? Hd(s) * Math.pow(cs, 2.2) : Hb(s) * cs;             // the dome flattens into the flaps: no crease
      let k = NOFX;
      if (cs > 0.0) { col.copy(ONE); k = fanK(Zl, s); } else col.copy(SIDE).lerp(BELLY, ssv(-0.4, -0.85, cs));
      if (cs <= 0) k = [0.25, s, (th > Math.PI ? th - TAUv : th) * 0.5 * (S.hinge(s) + Hb(s)), 0];   // scale hairs on the sides
      return { x: A0.x - s, y: A0.y + y, z: A0.z - Zl, c: col, w: rigid(abone), k };   // bald: the fan, and sides the flaps cover
    }, true);

    // ---- Flaps: from the hinge line out to the fan's outline, on the ribs either side. Two
    // sheets: the patterned top (it faces out when the flaps fold down round the belly) and a dark
    // underside.
    const NR = S.ribs.length, ribs = chains.slice(-2 * NR), UNDER = C(0x4a2e18);
    for (const sg of [1, -1]) for (const lay of [1, -1]) sheet(64, 18, (m, q) => {
      const s = 0.01 + (S.abd - 0.02) * m / 64, v = q / 18, hw = S.hinge(s), d = v * Math.max(0, S.fanW(s) - hw);
      const fr = s / S.abd; let r = 0; while (r < NR - 2 && fr > S.ribs[r + 1]) r++;
      const u = cl((fr - S.ribs[r]) / (S.ribs[r + 1] - S.ribs[r]), 0, 1), o = sg < 0 ? 1 : 0;
      const A = ribs[2 * r + o], B = ribs[2 * r + 2 + o];
      const ka = boneAt(A, Math.min(d, A.length - 1e-4)), kb = boneAt(B, Math.min(d, B.length - 1e-4));
      const Zl = sg * (hw + d);
      let k = NOFX;
      if (lay > 0) { col.copy(ONE); k = fanK(Zl, s); } else col.copy(UNDER).lerp(WHITE, 0.8 * ssv(0.9, 0.98, v));
      return { x: A0.x - s, y: A0.y + lay * 0.006, z: A0.z - Zl, c: col, k,
        w: [[ka.i, ka.b1, kb.i, kb.b1], [(1 - u) * (1 - ka.w1), (1 - u) * ka.w1, u * (1 - kb.w1), u * kb.w1]] };
    }, false);

    // ---- Eyes: glossy lenses on the carapace bone (photos 8, 10). The two huge main eyes and
    // the smaller anterior laterals are lenses set into the face, not beads: black at the centre,
    // a ring of green iridescence toward the edge, a window of sky in the upper part and the key
    // light's sharp highlight; each sits in a dark margin of hair. Tiny posterior medians, and the
    // posterior laterals on top at the back of the eye region.
    const bone0 = cara.bones[0], qi = cara.q.clone().invert();
    const lens = (ring, amt) => {
      const m = new THREE.MeshPhysicalMaterial({ color: 0x010101, roughness: 0.04, clearcoat: 1, clearcoatRoughness: 0.02 });
      m.onBeforeCompile = sh => {
        sh.fragmentShader = sh.fragmentShader.replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
  { vec3 V = normalize(vViewPosition); float g = 1.0 - abs(dot(normal, V));
    float ir = ${amt.toFixed(2)} * smoothstep(0.2, 0.5, g) * (1.0 - 0.55 * smoothstep(0.75, 0.97, g));
    diffuseColor.rgb = mix(vec3(0.004), vec3(${ring}), ir); totalEmissiveRadiance += vec3(${ring}) * ir * 0.3;
    vec3 R = reflect(-V, normal);
    totalEmissiveRadiance += vec3(0.55, 0.6, 0.66) * 0.45 * smoothstep(0.8, 0.93, R.y) * (1.0 - smoothstep(0.85, 1.0, g)); }`);
      };
      return m;
    };
    const green = lens('0.02, 0.26, 0.13', 1), dim = lens('0.02, 0.08, 0.05', 0.6);
    const margin = new THREE.MeshStandardMaterial({ color: 0x120c09, roughness: 0.95 });
    const faceOut = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(1, 0, 0));
    const eye = (x, y, z, r, mat, ring) => {
      const m = new THREE.Mesh(new THREE.SphereGeometry(r, 48, 28), mat);
      m.position.set(x, y, z).sub(cara.p).applyQuaternion(qi); bone0.add(m);
      if (!ring) return;   // a dark hairy margin round the lens, where it meets the face
      const t = new THREE.Mesh(new THREE.TorusGeometry(ring[0], ring[1], 12, 48), margin);
      t.position.set(ring[2], y, z).sub(cara.p).applyQuaternion(qi);
      t.quaternion.copy(qi).multiply(faceOut); bone0.add(t);
    };
    for (const sg of [1, -1]) {
      eye(-0.078, 0.29, sg * 0.125, 0.12, green, [0.108, 0.014, -0.012]);      // main eyes: a dome 0.04 proud of the face
      eye(-0.06, 0.345, sg * 0.262, 0.055, green);                              // at the face's rounded corner: no margin
      eye(-0.2, 0.49, sg * 0.23, 0.02, dim); eye(-0.42, 0.455, sg * 0.275, 0.05, dim);
    }
    return {};
  },
  build() { return { meshes: [] }; },
  apply() {},
};
