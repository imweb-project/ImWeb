// The cuttlefish's view (Sepia officinalis), after the owner's photos: tan mantle with fine wavy
// stripes and white spots, a lilac sheen on the head and arms, a pale ribbon fin with a dotted
// white line along its base and an iridescent edge, big silvery eyes with W pupils.
// Its own file, as creature.html prefers. skin(ctx) / build(THREE, body, mats) / apply(P, parts, s).
//
// The skin is the instrument: skinFx.glsl draws every pattern from uniforms that pose() sets each
// frame (cuttlefish-def.js), so the colour waves run on the same seamless clock as the movement.
// Two looks: natural (default) and glow (open the page with &look=glow): the same pattern signals
// drawn as emitted light over a deep blue body.
import { SHAPE, CHAINS, INK_PUFFS } from './cuttlefish-def.js';

const LOOK = new URLSearchParams(globalThis.location?.search || '').get('look') === 'glow' ? 1 : 0;
const ARMS = CHAINS[0].count, NR = SHAPE.fin.n;
const sst = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// ---- Small vector maths on plain arrays (the eye frames are needed before three.js is handed in)
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const addS = (a, b, k) => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const nrm = a => { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
// Outward normal of the body surface at (s, th).
function surfN(s, th) {
  const e = 1e-3, p = SHAPE.at(s, th);
  let n = nrm(cross(sub(SHAPE.at(s, th + e), p), sub(SHAPE.at(s + e, th), p)));
  if (dot(n, [p[0], 0, p[2]]) < 0) n = n.map(v => -v);
  return n;
}
// Eye frames: centre on the plain head surface, normal, the mound's peak, and the eye plane
// (right along the body, up toward the back) the slit and the W pupil are drawn in.
const EYES = [1, -1].map(sg => {
  const E = SHAPE.eye, th = sg > 0 ? E.th : Math.PI - E.th;
  const c = SHAPE.at(E.s, th), n = surfN(E.s, th), peak = addS(c, n, E.mound);
  let right = nrm(addS([0, 1, 0], n, -n[1])), up = cross(n, right);
  if (up[0] < 0) { right = right.map(v => -v); up = up.map(v => -v); }
  return { c, n, peak, right, up };
});
const v3 = a => `vec3(${a.map(v => v.toFixed(4)).join(', ')})`;

// ---- The skin shader ------------------------------------------------------------------------
// Coordinates: vBind is build space (y along the body: arms −, tail +; x the back; z the sides).
// vCustom.x tells the part: 0 head/mantle, 1 fin, 2 tentacle, 3 papilla, 4 funnel, 5 arm.
//   head/mantle: y = cos θ (±1 at the lateral edges), z = sin θ (+1 the back, −1 the belly)
//   fin: y = place along the fin (0 front → 1 back), z = side, w = out across the fin (0 base → 1 edge)
//   tentacle: w = place along the club (−1 on the stalk); papilla: w = height up the papilla
const GLSL = {
  uniforms: { uCloud: 0, uCloudPh: 0, uZebra: 0, uMot: 0, uDis: 0, uFlash: 0, uPale: 0, uDark: 0, uPap: 0,
    uIri: 0.6, uChroma: 0.5, uLook: LOOK },
  head: `
vec3 cuG(vec3 c) { return c * c; }   // picked in sRGB, used linear
// Round dots on a jittered grid: x = distance to the nearest dot centre (cell units), y = its id.
// Only the 8 cells on p's side can hold a nearer centre (jitter is ±0.25), so 8 lookups, not 27.
vec2 cuDots(vec3 p) {
  vec3 c = floor(p), o = step(0.5, fract(p)) * 2.0 - 1.0;
  float best = 9.0, id = 0.0;
  for (int k = 0; k < 8; k++) {
    vec3 g = c + vec3(float(k & 1), float((k >> 1) & 1), float((k >> 2) & 1)) * o;
    vec3 r = g + 0.5 + (vec3(hash3(g), hash3(g + 17.3), hash3(g + 41.9)) - 0.5) * 0.5 - p;
    float d = dot(r, r);
    if (d < best) { best = d; id = hash3(g + 5.7); }
  }
  return vec2(sqrt(best), id);
}
// Arm suckers on the view's own arm skin: two staggered rows of cups on the oral side.
// a = angle from the oral line, n = cups counted from the root (one per local radius).
vec2 cuSuck(float a, float n) {
  float under = smoothstep(0.2, 0.75, cos(a));
  float d = min(length(vec2(fract(n) - 0.5, a + 0.45)), length(vec2(fract(n + 0.5) - 0.5, a - 0.45)));
  float h = smoothstep(0.38, 0.27, d) - 1.4 * smoothstep(0.21, 0.1, d);
  return vec2(under, h * under * smoothstep(0.6, 1.8, n));
}
const mat3 CU_ROT = mat3(0.788, 0.6, -0.138, -0.48, 0.744, 0.465, 0.381, -0.293, 0.875);   // breaks the noise grid's alignment
const vec3 CU_EYE_A = ${v3(EYES[0].c)}, CU_EYE_B = ${v3(EYES[1].c)};
`,
  surface: `
  float reg = vCustom.x;
  float isBody = 1.0 - step(0.5, reg), isFin = 1.0 - step(0.5, abs(reg - 1.0)), isTen = 1.0 - step(0.5, abs(reg - 2.0));
  float isPap = 1.0 - step(0.5, abs(reg - 3.0)), isFun = 1.0 - step(0.5, abs(reg - 4.0)), isArm = 1.0 - step(0.5, abs(reg - 5.0));
  vec3 p = vBind;
  float sA = p.y;                                         // along the body: arms −, tail +
  // Arms carry 5 + 0.4 × how far they have rounded out of the crown (0 at the head's rim, 1 on the arm).
  float armB = isArm * clamp((reg - 5.0) / 0.4, 0.0, 1.0);
  vec2 su = isArm * cuSuck(vCustom.y, vCustom.z);
  // How much this point is "upper side" (patterned) rather than pale belly / sucker side.
  float dors = isBody * vCustom.z + isArm * vCustom.w + isPap + isFin * 0.55 + isTen * -0.2 + isFun * -0.6;
  float back = smoothstep(-0.45, 0.35, dors);
  float eyeD = min(length(p - CU_EYE_A), length(p - CU_EYE_B));
  float onMantle = smoothstep(0.5, 0.62, sA) * isBody;

  // ---- Papillae: bumps rise out of the skin (relief, every skin) ----
  float hp = 0.0;
  if (uPap > 0.003 && isBody + isPap > 0.5) {
    vec3 q = p * 13.0, ci = floor(q), cf = fract(q) - 0.5;
    float rr = hash3(ci + 0.5);
    vec3 jit = (vec3(hash3(ci + 3.1), hash3(ci + 7.7), hash3(ci + 5.3)) - 0.5) * 0.4;
    hp = uPap * back * step(0.35, rr) * (0.5 + rr) * pow(smoothstep(0.28, 0.0, length(cf - jit)), 1.5);
    hp += uPap * back * 0.4 * smoothstep(0.55, 0.85, vnoise(p * 34.0));
  }
  {
    // Relief from papillae and sucker cups: height field → normal (derivatives outside any branch).
    float hR = hp + 0.45 * su.y;
    vec3 dpx = dFdx(-vViewPosition), dpy = dFdy(-vViewPosition);
    float hx = dFdx(hR), hy = dFdy(hR);
    vec3 r1 = cross(dpy, normal), r2 = cross(normal, dpx);
    float det = dot(dpx, r1);
    normal = normalize(abs(det) * normal - sign(det) * (hx * r1 + hy * r2) * 0.025);
  }

  if (uColour > 0.5) {
    vec3 TAN = cuG(vec3(0.66, 0.56, 0.45)), BROWN = cuG(vec3(0.38, 0.27, 0.19)), DARK = cuG(vec3(0.09, 0.065, 0.06));
    vec3 CREAM = cuG(vec3(0.93, 0.9, 0.85)), WHITE = cuG(vec3(0.98, 0.97, 0.95)), LILAC = cuG(vec3(0.74, 0.6, 0.74));
    vec3 ROSE = cuG(vec3(0.78, 0.52, 0.5)), YEL = cuG(vec3(0.85, 0.68, 0.32));

    // Chromatophores: fine dots that expand (uChroma); faded to their average once smaller than a pixel.
    vec3 qd = p * 36.0;
    vec2 cd = cuDots(qd);
    float far = smoothstep(0.35, 1.0, length(fwidth(qd)));
    float rD = (0.09 + 0.2 * uChroma) * (0.6 + 0.8 * fract(cd.y * 7.13));
    float aaD = max(fwidth(cd.x), 1e-4);
    float dot1 = 1.0 - smoothstep(rD - aaD, rD + aaD, cd.x);
    float dots = mix(dot1 * step(0.3, cd.y), 0.7 * 2.4 * (0.09 + 0.2 * uChroma) * (0.09 + 0.2 * uChroma) * 1.1, far);
    float dotsY = mix(dot1 * (1.0 - step(0.3, cd.y)), 0.0, far);
    // Head and arms carry the lilac-rose sheen of the photos; the mantle is tan.
    float headish = 1.0 - smoothstep(0.32, 0.62, sA);
    vec3 col = mix(TAN, mix(LILAC, ROSE, 0.35), 0.6 * headish);
    col = mix(col, BROWN, dots * 0.6);
    col = mix(col, YEL, dotsY * 0.35);
    // Always a little of the fine striping and the white leucophore spots.
    float zs = sA * 70.0 + 2.2 * sin(p.z * 14.0 + sA * 6.0) + 1.1 * sin(p.z * 33.0 - sA * 9.0);
    float zeb = smoothstep(-0.35, 0.35, sin(zs));                     // 1 dark stripe, 0 white
    vec2 sd = cuDots(p * 9.0 + 3.3);
    float spots = step(0.62, sd.y) * (1.0 - smoothstep(0.1 - fwidth(sd.x), 0.1 + fwidth(sd.x), sd.x * (0.8 + 0.5 * sd.y))) * back;
    float zThin = smoothstep(0.8, 0.97, sin(zs));                       // the fine dark lines of the photos
    col = mix(col, BROWN * 0.75, 0.28 * zThin * onMantle * back);

    // Mottle: light and dark blotches, more white spots.
    float mb = fbm(CU_ROT * p * 4.0 + vec3(3.1, 0.0, 1.7));
    float mLight = smoothstep(0.5, 0.66, mb), mDark = 1.0 - smoothstep(0.32, 0.46, mb);
    float mFine = smoothstep(0.45, 0.7, fbm(CU_ROT * p * 11.0 + 9.0));     // smaller flecks inside the blotches
    col = mix(col, CREAM, uMot * mLight * 0.75 * back);
    col = mix(col, BROWN * 0.45, uMot * mDark * 0.8 * back);
    col = mix(col, mix(BROWN * 0.6, CREAM, step(0.5, mb)), uMot * mFine * 0.45 * back);
    col = mix(col, WHITE, (0.3 + 0.6 * uMot) * spots);

    // White dotted line along the mantle edge, just above the fin base.
    float fromEdge = atan(vCustom.z, abs(vCustom.y));                  // angle up from the lateral edge
    float edge = (1.0 - smoothstep(0.1, 0.2, abs(fromEdge - 0.22))) * onMantle;
    float edgeDots = onMantle * (1.0 - smoothstep(0.13, 0.22, length(vec2(fract(sA * 26.0) - 0.5, (fromEdge - 0.2) * 5.0))));
    col = mix(col, WHITE, 0.85 * edgeDots);

    // Disruptive: white square mid-mantle, dark bars either side, white head bar, dark eye ring, banded arms.
    float sq = (1.0 - smoothstep(0.1, 0.14, abs(p.z))) * smoothstep(0.86, 0.9, sA) * (1.0 - smoothstep(1.12, 1.16, sA)) * smoothstep(0.0, 0.3, dors) * isBody;
    float bars = (smoothstep(0.7, 0.74, sA) * (1.0 - smoothstep(0.8, 0.84, sA)) + smoothstep(1.24, 1.28, sA) * (1.0 - smoothstep(1.36, 1.4, sA))) * back * isBody;
    float headBar = smoothstep(0.03, 0.06, sA) * (1.0 - smoothstep(0.11, 0.14, sA)) * back * isBody;
    float eyeRing = smoothstep(0.2, 0.15, eyeD) * isBody;
    float armBand = armB * back * smoothstep(0.3, 0.7, sin(-sA * 20.0));
    vec3 dcol = mix(col, DARK, 0.85 * bars);
    dcol = mix(dcol, WHITE, max(sq, 0.9 * headBar));
    dcol = mix(dcol, DARK, 0.8 * eyeRing);
    dcol = mix(dcol, WHITE * 0.9, 0.7 * armBand);
    col = mix(col, dcol, uDis);

    // Zebra: the male display, fine wavy black and white stripes; arms banded across.
    float zArm = smoothstep(-0.3, 0.3, sin(-sA * 34.0));
    vec3 zcol = mix(WHITE, DARK, mix(zeb, zArm, armB));
    col = mix(col, mix(col, zcol, back), uZebra * (1.0 - isFin * 0.7));

    // Passing cloud: dark bands sweep forward over the back and on down the arms.
    float cw = 0.5 + 0.5 * sin((sA + 0.8 * p.z * p.z) * 16.0 + uCloudPh);
    float cloud = smoothstep(0.45, 0.9, cw) * back;
    col = mix(col, mix(col, CREAM, 0.35), uCloud * (1.0 - cloud) * back);
    col = mix(col, DARK * 1.4, uCloud * cloud * 0.88);

    // Deimatic flash: pales, two dark eyespots on the mantle, dark margins and eye rings.
    float es = min(length(vec2(sA - 1.02, p.z - 0.17)), length(vec2(sA - 1.02, p.z + 0.17)));
    float spot = (1.0 - smoothstep(0.06, 0.078, es)) * smoothstep(0.0, 0.4, dors) * isBody;
    float margin = isFin * smoothstep(0.7, 1.0, vCustom.w) + smoothstep(0.86, 0.97, abs(vCustom.y)) * onMantle;
    vec3 fcol = mix(col, WHITE, 0.82);
    fcol = mix(fcol, DARK, max(spot, max(0.8 * margin, eyeRing)));
    col = mix(col, fcol, uFlash);

    // Fin: paler, with the dotted white line at its base.
    float fdots = isFin * (1.0 - smoothstep(0.08, 0.2, vCustom.w)) * smoothstep(0.3, 0.8, sin(vCustom.y * 190.0));
    col = mix(col, mix(CREAM, LILAC, 0.35), 0.5 * isFin);
    col = mix(col, WHITE, 0.8 * fdots);
    // Tentacles pale rose, the club darker; funnel cream; papilla tips paler.
    float club = isTen * step(0.0, vCustom.w);
    col = mix(col, mix(mix(CREAM, ROSE, 0.45), ROSE * 0.7, club), isTen);
    col = mix(col, CREAM, 0.8 * isFun);
    col = mix(col, CREAM, isPap * vCustom.w * 0.55 * uPap + hp * 0.2);

    // Belly: pale; the arms' sucker side as the engine draws it.
    col = mix(mix(CREAM, LILAC, 0.18), col, max(back, isTen + isFun));
    col = mix(col, uUnder, su.x * 0.7);
    col = mix(col, uUnder * 1.15, max(su.y, 0.0) * 0.5);
    col *= 1.0 + min(su.y, 0.0) * 0.3;

    if (vEye.z > 0.99) { float e = slitE(); col = mix(col * 0.4, col, smoothstep(1.0, 1.3, e)); }    // a thin dark lid rim (wider showed as a blob where the eye mask ends)
    col = mix(col, WHITE * 0.95, uPale);
    col *= 1.0 - 0.68 * uDark;

    // Iridescence: shifts with the viewing angle, strongest round the eyes, on the fin and the arms.
    vec3 V = normalize(vViewPosition);
    float ndv = abs(dot(normal, V));
    // violet at grazing angles, through teal, to a green-gold sheen face-on (no full rainbow)
    vec3 iriC = mix(mix(vec3(0.55, 0.35, 1.0), vec3(0.15, 0.85, 0.8), smoothstep(0.0, 0.45, ndv)), vec3(0.65, 0.85, 0.35), smoothstep(0.45, 0.9, ndv));
    float iriM = 0.25 + 0.75 * smoothstep(0.2, 0.12, eyeD) * isBody + 0.6 * isFin * smoothstep(0.6, 1.0, vCustom.w) + 0.4 * armB * back + 0.8 * edge;
    vec3 iri = iriC * iriM * uIri * pow(1.0 - ndv, 1.6);

    if (uLook < 0.5) {
      diffuseColor.rgb = col;
      totalEmissiveRadiance += iri * 0.3;
    } else {
      // Glow: the same signals as light over a deep blue body.
      vec3 CY = vec3(0.1, 0.85, 1.0), MG = vec3(1.0, 0.22, 0.72), AM = vec3(1.0, 0.55, 0.12), VI = vec3(0.45, 0.3, 1.0);
      vec3 E = AM * dots * 0.3 * back + vec3(0.4, 1.0, 0.5) * dotsY * 0.4;
      E += mix(VI, CY, 0.5) * uMot * mLight * 0.7 * back + vec3(0.9, 0.95, 1.0) * spots * 0.7;
      E += vec3(0.9, 0.95, 1.0) * (edgeDots + fdots) * 0.9;
      E += CY * uCloud * cloud * 1.8;
      E += mix(CY, vec3(1.0), 0.4) * uZebra * (1.0 - zeb) * back * 1.3;
      E += vec3(1.0) * uDis * (sq + headBar + 0.6 * armBand) * 1.1 + MG * uDis * bars * 0.7;
      E += MG * uFlash * (1.5 * spot + margin) + vec3(0.85, 0.9, 1.0) * uFlash * 0.25;
      E += vec3(0.85, 0.9, 1.0) * uPale * 0.8;
      E += iri * 1.0;
      diffuseColor.rgb = cuG(vec3(0.07, 0.08, 0.2)) + col * 0.12;
      totalEmissiveRadiance += E * (1.0 - 0.75 * uDark);
    }
  }
`,
};

// ---- Ink: soft billboards in WORLD space (added to the scene, not the body) ------------------
const INK_PER = 16;
const INK_VERT = `
uniform vec4 uP[${INK_PUFFS}]; uniform float uO[${INK_PUFFS}];
attribute float aPuff; attribute vec4 aOff;
varying float vA; varying vec2 vUv; varying float vShade;
void main() {
  int k = int(aPuff + 0.5);
  vec4 P = uP[k];
  vec4 mv = viewMatrix * vec4(P.xyz + aOff.xyz * P.w, 1.0);
  mv.xy += position.xy * P.w * aOff.w;
  gl_Position = projectionMatrix * mv;
  vA = uO[k]; vUv = position.xy; vShade = clamp(0.5 + aOff.y * 0.6, 0.0, 1.0);
}`;
const INK_FRAG = `
varying float vA; varying vec2 vUv; varying float vShade;
void main() {
  float r2 = dot(vUv, vUv) * 4.0;
  if (r2 > 1.0 || vA < 0.002) discard;
  float a = (1.0 - r2); a *= a;
  vec3 c = mix(vec3(0.07, 0.05, 0.04), vec3(0.3, 0.23, 0.18), vShade * (1.0 - r2 * 0.5));
  gl_FragColor = vec4(c, a * vA * 0.6);
}`;

// Cuttlefish iris, drawn once: silvery with faint gold, fine striations; the W pupil.
function irisCanvas() {
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const g = c.getContext('2d'), C = 128;
  g.fillStyle = '#2c2a24'; g.fillRect(0, 0, 256, 256);
  const rad = g.createRadialGradient(C, C, 10, C, C, 120);
  rad.addColorStop(0, '#c9c6b4'); rad.addColorStop(0.45, '#b3ab86'); rad.addColorStop(0.8, '#7c806e'); rad.addColorStop(1, '#2a2a24');
  g.fillStyle = rad; g.beginPath(); g.arc(C, C, 120, 0, Math.PI * 2); g.fill();
  let s = 11; const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 220; i++) {
    const a = rnd() * Math.PI * 2, r0 = 30 + rnd() * 30, r1 = 85 + rnd() * 30;
    g.strokeStyle = rnd() < 0.5 ? `rgba(255,250,230,${0.15 + rnd() * 0.25})` : `rgba(110,100,70,${0.12 + rnd() * 0.25})`;
    g.lineWidth = 0.6 + rnd() * 1.2; g.beginPath();
    g.moveTo(C + Math.cos(a) * r0, C + Math.sin(a) * r0); g.lineTo(C + Math.cos(a) * r1, C + Math.sin(a) * r1); g.stroke();
  }
  // The W: the upper iris hangs down in the middle, so the dark pupil is a wide W.
  g.strokeStyle = '#050405'; g.lineWidth = 30; g.lineCap = 'round'; g.lineJoin = 'round';
  g.beginPath(); g.moveTo(34, 100); g.quadraticCurveTo(60, 178, 92, 160); g.quadraticCurveTo(120, 140, 128, 128);
  g.quadraticCurveTo(136, 140, 164, 160); g.quadraticCurveTo(196, 178, 222, 100); g.stroke();
  return c;
}

export const VIEW = {
  camera: { pos: [1.0, 3.2, 7.4], target: [-0.1, 0.65, 0] },
  floor: { color: 0x6a6252 },
  soft: { limb: 0xffffff, under: 0xeadbd0, body: 0xffffff, bodyClear: false, roughness: 0.46, clearcoat: 0.4, clearcoatRoughness: 0.3 },
  skinFx: { slit: SHAPE.eye.slit, mottle: 0, bump: 0.16, suckers: false, glsl: GLSL },   // suckers: the view's own (cuSuck)

  skin(ctx) {
    const { THREE, chains, axisAt } = ctx;
    const V3 = a => new THREE.Vector3(a[0], a[1], a[2]);
    const head = ctx.newBone(new THREE.Vector3(0, 0, 0));          // never moves: head, eyes, funnel
    const O = V3(SHAPE.mantleO), mantle = ctx.newBone(O.clone()); // squeezes (breathing, jets)
    const geo = (p, ix, extra) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3)); g.setIndex(ix);
      for (const [k, [arr, n]] of Object.entries(extra)) g.setAttribute(k, new THREE.Float32BufferAttribute(arr, n));
      g.computeVertexNormals();
      return g;
    };
    const grid = (NU, NV, ix) => {
      for (let m = 0; m < NU; m++) for (let q = 0; q < NV; q++) {
        const a = m * (NV + 1) + q; ix.push(a, a + 1, a + NV + 1, a + 1, a + NV + 2, a + NV + 1);
      }
    };
    // First and last column are the same points: average their normals (no crease).
    const weld = (g, NU, NV) => {
      const N = g.attributes.normal, n1 = new THREE.Vector3(), n2 = new THREE.Vector3();
      for (let m = 0; m <= NU; m++) {
        const a0 = m * (NV + 1), b0 = a0 + NV;
        n1.fromBufferAttribute(N, a0).add(n2.fromBufferAttribute(N, b0)).normalize();
        N.setXYZ(a0, n1.x, n1.y, n1.z); N.setXYZ(b0, n1.x, n1.y, n1.z);
      }
    };

    // ---- Head and mantle: one surface, oval sections, a rounded mouth dome and tail. Eye mounds
    // rise out of it and the shader cuts the eye opening through them (aEye).
    const ss = [];
    const cr = SHAPE.crown;                                     // the head ends in this rim; the arms go on from it
    for (let i = 0; i <= 92; i++) ss.push(cr + (1.82 - cr) * i / 92);
    for (let i = 1; i <= 10; i++) ss.push(1.82 + (SHAPE.s1 - 1.82) * Math.sin(Math.PI / 2 * i / 10));   // tail
    const NA = 80, NS = ss.length - 1, p = [], eye = [], cu = [], wts = [], ix = [];
    for (let m = 0; m <= NS; m++) {
      const s = ss[m], w = sst(SHAPE.neck[0], SHAPE.neck[1], s);
      for (let q = 0; q <= NA; q++) {
        const th = Math.PI * 2 * q / NA;
        let v = SHAPE.at(s, th);
        let ea = [0, 0, 0];
        for (const E of EYES) {
          const d2 = dot(sub(v, E.c), sub(v, E.c)), gs = Math.exp(-d2 / (SHAPE.eye.sigma ** 2));
          if (gs > 1e-4) v = addS(v, E.n, SHAPE.eye.mound * gs);
        }
        const E = dot(sub(v, EYES[0].peak), sub(v, EYES[0].peak)) < dot(sub(v, EYES[1].peak), sub(v, EYES[1].peak)) ? EYES[0] : EYES[1];
        // Eye-plane coordinates scaled to the TRUE distance from the peak: a plain projection folds
        // back where the head narrows behind the eye and cut a second hole there.
        const d = sub(v, E.peak), dt = addS(d, E.n, -dot(d, E.n)), len = Math.hypot(...d), lt = Math.hypot(...dt);
        if (len < 0.25) { const k = lt > 1e-6 ? len / lt : 1; ea = [dot(dt, E.right) * k, dot(dt, E.up) * k, 1]; }
        p.push(...v); eye.push(...ea); cu.push(0, Math.cos(th), Math.sin(th), 0);
        wts.push([[head.index, mantle.index, 0, 0], [1 - w, w, 0, 0]]);
      }
    }
    grid(NS, NA, ix);
    const body = geo(p, ix, { aEye: [eye, 3], aCustom: [cu, 4] });
    weld(body, NS, NA);
    for (let q = 0; q <= NA; q++) body.attributes.normal.setXYZ(NS * (NA + 1) + q, 0, 1, 0);   // the tail tip

    // ---- Arms, grown out of the head's skin. At the rim each arm's section is its eighth of the
    // rim (outer arc), closed by two straight sides to the mouth; neighbours share those sides, so
    // the eight sections tile the crown and head, crown and arms are one surface. Along the arm
    // the section rounds out into the arm (by SB) while the head's weight fades (by SW): the arms
    // flex out of the head instead of hinging at a seam. Their own suckers: cuSuck in the shader.
    const NAR = 20, HALF = NAR / 2, Q = NAR / 4, SB = 0.17, SW = 0.13, MA = 46;
    const rimPt = al => SHAPE.at(cr, Math.PI / 2 - al);          // arm angle (0 = the back) → head rim point
    const { r0, r1 } = CHAINS[0], armG = [];
    for (let j = 0; j < ARMS; j++) {
      const ch = chains[j], a = SHAPE.armA(j), Lt = ch.length, qr = 1 - r1 / r0;
      const dir = new THREE.Vector3(0, -1, 0).applyQuaternion(ch.q), ex = new THREE.Vector3(1, 0, 0).applyQuaternion(ch.q), ez = new THREE.Vector3(0, 0, 1).applyQuaternion(ch.q);
      // Rim section point k, and how much of the head's back it is (sin θ there), for the colour.
      const slice = k => {
        if (k <= HALF) { const al = a - Math.PI / 8 + (Math.PI / 4) * k / HALF; return [rimPt(al), Math.cos(al)]; }
        const kk = k - HALF, side = kk <= Q ? 1 : -1, f = kk <= Q ? kk / Q : (HALF - kk) / Q, al = a + side * Math.PI / 8, R = rimPt(al);
        return [[R[0] * (1 - f), cr, R[2] * (1 - f)], Math.cos(al)];
      };
      const ap = [], ac = [], aw = [], ax = [], A = new THREE.Vector3();
      for (let m = 0; m <= MA; m++) {
        const s = Lt * Math.pow(m / MA, 1.25), u = s / Lt, r = (r0 * (1 - u) + r1 * u) * (m === MA ? 0.3 : 1);
        const b = sst(0, SB, s), hw = 1 - sst(0, SW, s), sc = Math.min(s, Lt - 1e-5);
        axisAt(ch, sc, A);
        const kb = ctx.boneAt(ch, sc), suck = Lt / (r0 * qr) * -Math.log(1 - qr * u);
        for (let k = 0; k <= NAR; k++) {
          const phi = -Math.PI / 2 + 2 * Math.PI * k / NAR, c = Math.cos(phi), sn = Math.sin(phi), [sp, hd] = slice(k);
          const cx = A.x + r * (c * ex.x + sn * ez.x), cy = A.y + r * (c * ex.y + sn * ez.y), cz = A.z + r * (c * ex.z + sn * ez.z);
          const qx = sp[0] + dir.x * s, qy = sp[1] + dir.y * s, qz = sp[2] + dir.z * s;
          ap.push(qx + (cx - qx) * b, qy + (cy - qy) * b, qz + (cz - qz) * b);
          ac.push(5 + 0.4 * b, phi - Math.PI, suck, hd * (1 - b) + c * b);
          aw.push([[head.index, kb.i, kb.b1, 0], [hw, (1 - hw) * (1 - kb.w1), (1 - hw) * kb.w1, 0]]);
        }
      }
      grid(MA, NAR, ax);
      const g = geo(ap, ax, { aCustom: [ac, 4] }); weld(g, MA, NAR);
      armG.push({ g, aw });
    }
    // One normal where head and arms meet (rim) and where neighbouring arms meet (their shared
    // sides, the mouth): averaged over every piece that has a vertex there, so no shading seam.
    {
      const joins = new Map(), key = (P, i) => [P.getX(i), P.getY(i), P.getZ(i)].map(v => Math.round(v * 1e5)).join(',');
      const add = (g, i) => { const k = key(g.attributes.position, i); (joins.get(k) || joins.set(k, []).get(k)).push([g, i]); };
      for (let q = 0; q <= NA; q++) add(body, q);
      for (const { g } of armG) for (let k = 0; k <= NAR; k++) add(g, k);
      const n = new THREE.Vector3(), t = new THREE.Vector3();
      for (const list of joins.values()) {
        if (list.length < 2) continue;
        n.set(0, 0, 0);
        for (const [g, i] of list) n.add(t.fromBufferAttribute(g.attributes.normal, i));
        n.normalize();
        for (const [g, i] of list) g.attributes.normal.setXYZ(i, n.x, n.y, n.z);
      }
    }
    ctx.addGeometry(body, vi => wts[vi]);
    for (const { g, aw } of armG) ctx.addGeometry(g, vi => aw[vi]);

    // ---- Funnel (siphon): a short flattened tube under the head, opening forward.
    {
      const B = [-0.125, 0.42, 0], T = SHAPE.siphon, d = nrm(sub(T, B)), e1 = nrm(cross(d, [0, 0, 1])), e2 = [0, 0, 1];
      const NU = 12, NV = 16, fp = [], fc = [], fx = [];
      for (let m = 0; m <= NU; m++) {
        const u = m / NU, c = addS(B, sub(T, B), u), r = 0.05 - 0.022 * u + 0.006 * sst(0.85, 1, u);
        for (let q = 0; q <= NV; q++) {
          const a = Math.PI * 2 * q / NV;
          fp.push(...addS(addS(c, e1, Math.cos(a) * r * 0.75), e2, Math.sin(a) * r * 1.1)); fc.push(4, 0, -1, 0);
        }
      }
      grid(NU, NV, fx);
      const g = geo(fp, fx, { aCustom: [fc, 4] }); weld(g, NU, NV);
      ctx.addGeometry(g, () => [[head.index, 0, 0, 0], [1, 0, 0, 0]]);
    }

    // ---- Tentacles: a smooth stalk on linear weights (so it stretches evenly when its length
    // shoots out) and a club fixed to the tip bone (so apply() can shrink it while hidden).
    const clubs = [];
    for (let j = 0; j < 2; j++) {
      const ch = chains[ARMS + j], nb = ch.L.length, Lt = ch.length, clubL = 0.2, tip = ch.boneBase + nb;
      const ex = new THREE.Vector3(1, 0, 0).applyQuaternion(ch.q), ez = new THREE.Vector3(0, 0, 1).applyQuaternion(ch.q);
      const NU = 72, NV = 10, tp = [], tc = [], tw = [], tx = [], a = new THREE.Vector3(), o = new THREE.Vector3();
      for (let m = 0; m <= NU; m++) {
        const s = Lt * m / NU, u = (s - (Lt - clubL)) / clubL, isClub = u > 0;
        let r = 0.026 - 0.006 * s / Lt, fl = 1;
        if (isClub) { r = (0.021 + 0.03 * Math.pow(Math.sin(Math.PI * Math.min(1, u * 1.15)), 0.8)) * (u > 0.85 ? Math.sqrt(Math.max(0, 1 - ((u - 0.85) / 0.15) ** 2)) : 1); fl = 0.7; }
        axisAt(ch, Math.min(s, Lt - 1e-5), a);
        let w;
        if (isClub) w = [[tip, 0, 0, 0], [1, 0, 0, 0]];
        else { const i = Math.min(nb - 1, Math.floor(s / ch.L[0])), f = Math.min(1, (s - ch.cum[i]) / ch.L[i]); w = [[ch.boneBase + i, ch.boneBase + i + 1, 0, 0], [1 - f, f, 0, 0]]; }
        for (let q = 0; q <= NV; q++) {
          const an = Math.PI * 2 * q / NV;
          o.copy(a).addScaledVector(ex, Math.cos(an) * r * fl).addScaledVector(ez, Math.sin(an) * r);
          tp.push(o.x, o.y, o.z); tc.push(2, Math.cos(an), 0, isClub ? u : -1); tw.push(w);
        }
      }
      grid(NU, NV, tx);
      const g = geo(tp, tx, { aCustom: [tc, 4] }); weld(g, NU, NV);
      ctx.addGeometry(g, vi => tw[vi]);
      clubs.push(ch.bones[nb]);
    }

    // ---- Fins: a sheet between neighbouring rays, each point on two rays (linear along each,
    // so the sheet stretches evenly as pose() sets each ray's length to the fin's width).
    for (let side = 0; side < 2; side++) {
      const rays = chains.slice(ARMS + 2 + side * NR, ARMS + 2 + (side + 1) * NR);
      const SUB = 3, NU = (NR - 1) * SUB, NV = 6, fp = [], fc = [], fw = [], fx = [];
      const A = new THREE.Vector3(), Bv = new THREE.Vector3();
      for (let m = 0; m <= NU; m++) {
        const k = Math.min(NR - 2, Math.floor(m / SUB)), u = m / SUB - k, ra = rays[k], rb = rays[k + 1];
        for (let q = 0; q <= NV; q++) {
          const v = q / NV, s = v * ra.length * 0.999, i = Math.min(1, Math.floor(s / ra.L[0])), f = Math.min(1, (s - ra.cum[i]) / ra.L[i]);
          axisAt(ra, s, A); axisAt(rb, s, Bv); A.lerp(Bv, u);
          fp.push(A.x, A.y, A.z); fc.push(1, m / NU, side ? -1 : 1, v);
          fw.push([[ra.boneBase + i, ra.boneBase + i + 1, rb.boneBase + i, rb.boneBase + i + 1],
            [(1 - u) * (1 - f), (1 - u) * f, u * (1 - f), u * f]]);
        }
      }
      grid(NU, NV, fx);
      ctx.addGeometry(geo(fp, fx, { aCustom: [fc, 4] }), vi => fw[vi]);
    }

    // ---- Papillae: little cones, each on its own bone, sunk just under the skin; apply() raises
    // them by scaling the bone (and keeps the mantle's ones on the squeezing mantle).
    const paps = [];
    let sd = 4711; const rnd = () => ((sd = (sd * 16807) % 2147483647) / 2147483647);
    const sites = [];
    for (let r = 0; r < 9; r++) for (let c = 0; c < 5; c++) {
      const s = 0.62 + r * 0.145 + (rnd() - 0.5) * 0.08, th = 0.45 + (Math.PI - 0.9) * (c + (r % 2) * 0.5 + (rnd() - 0.5) * 0.5) / 5;
      if (th < Math.PI - 0.4) sites.push([s, th, 0.016 + 0.014 * rnd()]);
    }
    for (const E of [SHAPE.eye.th, Math.PI - SHAPE.eye.th]) for (const ds of [-0.05, 0.04])
      sites.push([SHAPE.eye.s + ds, E + (E < 1.5 ? 0.42 : -0.42), 0.028]);    // big ones over the eyes
    for (const [s, th, rb] of sites) {
      const n = surfN(s, th), base = addS(SHAPE.at(s, th), n, -0.014), h = rb * (1.2 + 0.9 * rnd());
      const b = ctx.newBone(V3(base)), t1 = nrm(cross(n, [0, 1, 0])), t2 = cross(n, t1);
      const pp = [], pc = [], px = [], NUc = 4, NVc = 8;
      for (let m = 0; m <= NUc; m++) {
        const u = m / NUc, r = rb * Math.pow(Math.cos(u * Math.PI / 2), 0.7);   // a soft cone, rounded tip
        for (let q = 0; q <= NVc; q++) {
          const a = Math.PI * 2 * q / NVc;
          pp.push(...addS(addS(addS(base, n, h * u), t1, Math.cos(a) * r), t2, Math.sin(a) * r)); pc.push(3, 0, 1, u);
        }
      }
      grid(NUc, NVc, px);
      const g = geo(pp, px, { aCustom: [pc, 4] }); weld(g, NUc, NVc);
      ctx.addGeometry(g, () => [[b.index, 0, 0, 0], [1, 0, 0, 0]]);
      paps.push({ bone: b.bone, p: V3(base), mantle: s > SHAPE.neck[0], d: 0.5 * rnd() });
    }
    return { mantle: mantle.bone, O, clubs, paps };
  },

  build(THREE, body, mats, world) {
    // Eyeballs under the mounds; only the opening cut through the skin shows them.
    const tex = new THREE.CanvasTexture(irisCanvas()); tex.colorSpace = THREE.SRGBColorSpace;
    // Only the front cap of the ball: a whole sphere this big poked out behind the eye where the head narrows to the neck.
    const r = SHAPE.eye.ball, ball = new THREE.SphereGeometry(r, 40, 16, 0, Math.PI * 2, 0, 1.1).rotateX(Math.PI / 2);
    const P = ball.attributes.position, uv = ball.attributes.uv;
    for (let i = 0; i < P.count; i++) uv.setXY(i, P.getX(i) / (2 * r) + 0.5, P.getY(i) / (2 * r) + 0.5);   // project from the front (+Z)
    // Clipped to an ellipse a little larger than the skin's opening (same eye-plane axes): the
    // rest of the ball is never meant to show, and where the head narrows it poked through.
    const [ex, ey] = SHAPE.eye.slit, clip = m => { m.onBeforeCompile = sh => {
      sh.vertexShader = 'varying vec2 vEyeL;\n' + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n  vEyeL = position.xy;');
      sh.fragmentShader = 'varying vec2 vEyeL;\n' + sh.fragmentShader.replace('#include <clipping_planes_fragment>',
        `#include <clipping_planes_fragment>\n  { vec2 q = vEyeL / vec2(${(ex * 1.06).toFixed(4)}, ${(ey * 1.08).toFixed(4)}); if (dot(q, q) > 1.0) discard; }`);
    }; return m; };
    const eyeMat = clip(new THREE.MeshStandardMaterial({ map: tex, roughness: 0.3 }));
    const cornea = clip(new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 0.02, clearcoat: 1, transparent: true, opacity: 0.12 }));
    for (const E of EYES) {
      const g = new THREE.Group(), n = new THREE.Vector3(...E.n);
      g.position.set(...E.peak).addScaledVector(n, -0.018 - r);
      g.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(new THREE.Vector3(...E.right), new THREE.Vector3(...E.up), n));
      g.add(new THREE.Mesh(ball, eyeMat), new THREE.Mesh(new THREE.SphereGeometry(r * 1.03, 32, 12, 0, Math.PI * 2, 0, 1.1).rotateX(Math.PI / 2), cornea));
      body.add(g);
    }

    // Ink: INK_PER soft sprites per puff; pose() moves the puffs, the sprites keep their places in them.
    const K = INK_PUFFS, N = K * INK_PER, plane = new THREE.PlaneGeometry(1, 1);
    const g = new THREE.InstancedBufferGeometry();
    g.index = plane.index; g.setAttribute('position', plane.attributes.position);
    const puff = new Float32Array(N), off = new Float32Array(N * 4);
    let sd = 99; const rnd = () => ((sd = (sd * 16807) % 2147483647) / 2147483647);
    const gauss = () => (rnd() + rnd() + rnd() - 1.5) * 0.9;
    for (let i = 0; i < N; i++) { puff[i] = Math.floor(i / INK_PER); off.set([gauss(), gauss() * 0.8, gauss(), 0.75 + 0.6 * rnd()], i * 4); }
    g.setAttribute('aPuff', new THREE.InstancedBufferAttribute(puff, 1));
    g.setAttribute('aOff', new THREE.InstancedBufferAttribute(off, 4));
    g.instanceCount = N;
    const uP = Array.from({ length: K }, () => new THREE.Vector4()), uO = new Array(K).fill(0);
    const inkMesh = new THREE.Mesh(g, new THREE.ShaderMaterial({ uniforms: { uP: { value: uP }, uO: { value: uO } },
      vertexShader: INK_VERT, fragmentShader: INK_FRAG, transparent: true, depthWrite: false }));
    inkMesh.frustumCulled = false; inkMesh.visible = false; inkMesh.renderOrder = 2;
    // The space the body moves through (the engine's `world`; today the scene). Not in `meshes`,
    // so a skin swap never turns the ink into chrome.
    (world || body.parent || body).add(inkMesh);
    return { meshes: [], ink: { mesh: inkMesh, uP, uO } };
  },

  apply(P, parts, s) {
    const c = P.parts.squeeze ?? 0, O = s.O;
    s.mantle.scale.set(1 - c, 1, 1 - c);
    const up = P.parts.uniforms?.uPap ?? 0;
    for (const q of s.paps) {
      q.bone.scale.setScalar(Math.max(1e-3, sst(q.d, q.d + 0.4, up)));
      if (q.mantle) q.bone.position.set(O.x + (q.p.x - O.x) * (1 - c), q.p.y, O.z + (q.p.z - O.z) * (1 - c));
    }
    for (const b of s.clubs) b.scale.setScalar(P.parts.club ?? 1);
    const ink = P.parts.ink, I = parts.ink; let any = false;
    if (ink) for (let k = 0; k < INK_PUFFS; k++) {
      I.uP[k].set(ink[k * 5], ink[k * 5 + 1], ink[k * 5 + 2], ink[k * 5 + 3]); I.uO[k] = ink[k * 5 + 4];
      if (I.uO[k] > 0.002) any = true;
    }
    I.mesh.visible = any;
    if (P.parts.uniforms) P.parts.uniforms.uLook = LOOK;
  },
};
