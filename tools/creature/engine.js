// The creature engine: one creature's bones, skin, fur and springs, built from its definition
// (<name>-def.js: movement library and pose maths) and its view (<name>-view.js or a block in
// views.js: body parts and colours), and its walk through the movement library.
//
// One engine, two hosts — the test page (creature.html) and ImWeb's 3D scene
// (src/scene3d/CreatureObject.js) — so what the owner approves on the page is what plays in
// ImWeb. The host owns the renderer, camera, lights, floor and controls; the engine owns the
// creature. THREE comes from the host (as it does for the views), so this file imports no three.js.
//
//   const c = createCreature(THREE, def, view, { world, envMap, shadows, furTry, segment });
//   each frame: c.step(dt × speed, { advance: 'next' | 'random' | 'off', loops, springs })
//   c.jump(i) · c.setSkin('soft' | 'chrome' | 'glass' | 'video') · c.setVideo(texture) · c.onSegment = i => … · c.dispose()
//
// Skin is built ONCE and bound to bones; each frame only bone transforms change (GPU skinning).
import { TAU, segmentState, lerpState, makePose, chainLengths } from './core.js';

// ---- Skins: same bones, different look -------------------------------------------------
// patchSkin adds, to any skin, what the view asks for in view.skinFx:
//   suckers — underside colour + two staggered rows of raised cups (aSk: u round the tube,
//             sucker count from the root; y < 0 = not an arm). Underside = u 0.5, the chain's
//             local −X, which faces down when the arm tilts outward. One cell = one local radius
//             along the arm; across, arc / radius = angle, so the cups stay round as arms taper.
//   eyes    — a slit cut through the head skin where the eyeball shows (aEye: eye-plane x, y,
//             mask). The lids ARE the head surface, so there is no join; uBlink closes the slit.
//   mottle  — patchy colour; bump — fine wrinkles and papillae. Both from 3D noise on the BIND
//             position, so the pattern stays stuck to the skin as it bends.
// colour terms apply only when `colour` is true (the Soft skin); relief applies to every skin.
//
// The Video skin wears a picture the host hands over (setVideo: a camera, a movie, any texture). A
// creature has no texture coordinates — its tubes and its view's own surfaces were never unwrapped —
// so the picture is laid on from three sides of the BIND pose (the side each bit of skin faces most)
// and so stays stuck to the skin as it bends, stretches and twists. One picture spans the whole
// animal, mirrored where it runs past an edge so there is never a hard seam.
const NOISE = `
float hash3(vec3 p){ p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float vnoise(vec3 x){ vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash3(i), hash3(i + vec3(1,0,0)), f.x), mix(hash3(i + vec3(0,1,0)), hash3(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(hash3(i + vec3(0,0,1)), hash3(i + vec3(1,0,1)), f.x), mix(hash3(i + vec3(0,1,1)), hash3(i + vec3(1,1,1)), f.x), f.y), f.z); }
float fbm(vec3 p){ return 0.5 * vnoise(p) + 0.3 * vnoise(p * 2.03 + 7.1) + 0.2 * vnoise(p * 4.1 + 1.7); }
`;
// Stretch and thinning, in the vertex shader (every skin material, and the shadow pass).
// uBoneX holds one texel per bone: r thickness, g bind arclength of its joint along its chain,
// b posed arclength of that joint, a stretch (len·bl) of the segment the bone owns.
// Per vertex, aStr = (bind axis direction, arclength s) on chain tubes and zero elsewhere, and
// aAxis = the axis point it sits around. Moving bones apart alone stretches the skin only in the
// blend near each joint; here each bone first re-places the vertex at its posed arclength, so a
// segment stretches evenly. The radius scales by the blended thickness, 1/√stretch: a stretched
// arm thins and a shortened one fattens (a muscular hydrostat keeps its volume).
const VERT_HEAD = `attribute vec3 aAxis;\nattribute vec4 aStr;\nuniform sampler2D uBoneX;
vec4 boneX(float i) { return texelFetch(uBoneX, ivec2(int(i + 0.5), 0), 0); }\n`;

// ---- Fur: shells over the skin -------------------------------------------------------------
// Where fur grows is per vertex, aFur = (length, density 0..1, tip lightness, strands per unit or 0
// for view.fur.freq): from a chain's `fur` option or a view geometry's aFur attribute; 0 = bald.
// Fur is drawn as view.fur.shells copies of the furry part of the skin, each pushed out along the
// skinned normal by shell/shells × length and drooped (combed along the limb, pulled by gravity)
// as the square of that. Each shell cuts strands out of itself: hash cells on the bind-space
// position, one strand per cell where the cell's hash is under the density, thinning to the tip.
// The cells live on the bind skin, so every strand is a column through all shells and stays put as
// the skin bends, stretches and twists. The creature's own skinFx.glsl runs on the fur too (banded
// hair on banded legs). Roots are shaded darker, tips lighter. Soft skin only.
const FUR_V = `attribute vec4 aFur;\nuniform float uShell, uShells, uDroop, uGrav;\nvarying vec4 vFur;\nvarying float vShellF;\nvarying vec3 vBindN;\n`;
const RINGS_PER_SEG = 3;

// THREE: the host's three.js. def, view: the creature's two modules (def, and the view's VIEW).
// opts.world: the space the body moves through, the body's parent (the page's scene; a group in
//   ImWeb) — view.build() leaves things there that must stay put while the body moves on (ink,
//   the manta's water). Whatever build() adds to it is the creature's, and dispose() removes it.
// opts.envMap: the environment the Chrome and Glassy skins reflect — a texture, or a function that
//   returns one (called when such a skin is first built, so a host can make it only when needed).
//   The host makes it; it is never freed here.
// opts.shadows: the host has a shadow-casting light, so the limbs cast with the same stretch.
// opts.furTry: { len, dens, tip } — a coat on every chain that has none (the page's ?fur=).
// opts.segment: the movement to start in (default the first).
// opts.onMaterial: (material) — called for every material the engine makes (each skin's limb and
//   body, each fur shell), after its own shader patch is in place: a host that needs something of
//   every creature material (ImWeb's output encoding) adds it here.
export function createCreature(THREE, def, view, { world, envMap = null, shadows = false, furTry = null, segment = 0, onMaterial = null } = {}) {
  let boneTex = null;   // made once the skeleton exists, before the first render compiles anything
  let envUsed = null;
  const env = () => (envUsed ??= typeof envMap === 'function' ? envMap() : envMap);
  const made = m => { onMaterial?.(m); return m; };
  const videoBox = new THREE.Vector4(0, 0, 0, 1);   // bind-space centre and 1 / size of the skin (filled once it is built)
  function patchVertex(sh) {
    sh.uniforms.uBoneX = { value: boneTex };
    sh.vertexShader = VERT_HEAD + sh.vertexShader
      .replace('#include <begin_vertex>', `#include <begin_vertex>
  #ifdef USE_SKINNING
  transformed = aAxis + (transformed - aAxis) * (skinWeight.x * boneX(skinIndex.x).r + skinWeight.y * boneX(skinIndex.y).r
    + skinWeight.z * boneX(skinIndex.z).r + skinWeight.w * boneX(skinIndex.w).r);
  #endif`)
      .replace('#include <skinning_vertex>', `vec3 skinAxis = vec3( 0.0 );   // the limb's posed axis direction here (fur combs along it)
#ifdef USE_SKINNING
  vec4 skinVertex = bindMatrix * vec4( transformed, 1.0 );
  vec4 sDir = bindMatrix * vec4( aStr.xyz, 0.0 );
  vec4 b0 = boneX( skinIndex.x );
  float Ds = b0.b + ( aStr.w - b0.g ) * b0.a;   // this vertex's posed arclength
  vec4 skinned = vec4( 0.0 );
  #define SLOT( M, I, W ) { vec4 bj = boneX( I ); skinned += M * ( skinVertex + sDir * ( ( Ds - bj.b ) - ( aStr.w - bj.g ) ) ) * W; }
  SLOT( boneMatX, skinIndex.x, skinWeight.x ) SLOT( boneMatY, skinIndex.y, skinWeight.y )
  SLOT( boneMatZ, skinIndex.z, skinWeight.z ) SLOT( boneMatW, skinIndex.w, skinWeight.w )
  transformed = ( bindMatrixInverse * skinned ).xyz;
  skinAxis = ( bindMatrixInverse * ( boneMatX * sDir * skinWeight.x + boneMatY * sDir * skinWeight.y
    + boneMatZ * sDir * skinWeight.z + boneMatW * sDir * skinWeight.w ) ).xyz;
#endif`);
  }

  function patchFur(sh, k, n) {
    Object.assign(sh.uniforms, { uShell: { value: k }, uShells: { value: n }, uDroop: { value: view.fur?.droop ?? 0.35 },
      uGrav: { value: view.fur?.gravity ?? 0.2 }, uFurFreq: { value: view.fur?.freq ?? 60 } });
    sh.vertexShader = FUR_V + sh.vertexShader
      .replace('#include <begin_vertex>', `#include <begin_vertex>
  vFur = aFur; vShellF = uShell / uShells; vBindN = normal;`)
      .replace('#include <displacementmap_vertex>', `#include <displacementmap_vertex>
  {
    float f = uShell / uShells;
    vec3 down = normalize( inverse( mat3( modelMatrix ) ) * vec3( 0.0, -1.0, 0.0 ) );
    vec3 comb = dot( skinAxis, skinAxis ) > 1e-8 ? normalize( skinAxis ) : vec3( 0.0 );
    transformed += aFur.x * ( normalize( objectNormal ) * f + ( comb * uDroop + down * uGrav ) * f * f );
  }`);
    sh.fragmentShader = 'uniform float uFurFreq;\nvarying vec4 vFur;\nvarying float vShellF;\nvarying vec3 vBindN;\n' + sh.fragmentShader
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
  {
    if ( vFur.x <= 0.0 ) discard;
    vec3 q = vBind * ( vFur.w > 0.0 ? vFur.w : uFurFreq ), ci = floor( q );
    vec3 c = ( vec3( hash3( ci ), hash3( ci + 17.0 ), hash3( ci + 41.0 ) ) - 0.5 ) * 0.6;
    vec3 d = fract( q ) - 0.5 - c, nb = normalize( vBindN );
    d -= dot( d, nb ) * nb;                                  // distance across the skin, not into it
    if ( hash3( ci + 5.0 ) > vFur.y || length( d ) > 0.42 * ( 1.0 - 0.85 * vShellF ) ) discard;
  }`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
  diffuseColor.rgb *= 0.35 + 0.65 * vShellF;                 // roots in the shade of the coat
  diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 1.0 ), vFur.z * vShellF * vShellF );`);
  }

  function patchSkin(mat, colour) {
    const fx = view.skinFx || {};     // every skin gets stretch and thinning; the extras only when asked
    // skinFx.glsl: a creature's own shader code, kept in its view file (no engine edit needed).
    //   uniforms — { name: number | [2–4 numbers] }, declared for you; set per frame via P.parts.uniforms
    //   head     — GLSL declarations (functions, constants)
    //   height   — a GLSL float expression added to the relief height (raised scales, ridges); same
    //              inputs as surface except normal, which it is used to perturb
    //   surface  — GLSL run after the normals, before lighting, in every skin (test uColour > 0.5 for
    //              the Soft skin only). It may change diffuseColor (rgb, a) and totalEmissiveRadiance.
    //              Available: vBind (bind-space position, stuck to the skin), vSk (tube: u round,
    //              length count; y < 0 off-tube), vTint, vAlpha, vCustom (aCustom: chain `custom`
    //              [4 numbers] or the view's geometry), normal and vViewPosition (view space),
    //              uPhase (0..2π this loop), uTime (seconds), uColour.
    const G = fx.glsl || {};
    const decl = Object.entries(G.uniforms || {}).map(([k, v]) => `uniform ${Array.isArray(v) ? 'vec' + v.length : 'float'} ${k};`).join('\n');
    // three.js shares one compiled program between materials whose settings and onBeforeCompile
    // SOURCE TEXT match — and that text is the same for every creature, while the code it writes
    // (skinFx.glsl) is not. In a host that swaps creatures in one renderer, the second creature
    // would be drawn with the first one's shader. The key says whose shader it is.
    mat.customProgramCacheKey = () => `creature|${def.NAME}`;
    mat.onBeforeCompile = sh => {
      patchVertex(sh);
      Object.assign(sh.uniforms, {
        uUnder: { value: new THREE.Color(view.soft.under ?? 0xffffff) }, uColour: { value: colour ? 1 : 0 },
        uMottle: { value: fx.mottle ?? 0 }, uBump: { value: fx.bump ?? 0 },
        uSlit: { value: new THREE.Vector2(fx.slit?.[0] ?? 0, fx.slit?.[1] ?? 0) }, uBlink: { value: 0 },
        uSuck: { value: fx.suckers ? 1 : 0 }, uPhase: { value: 0 }, uTime: { value: 0 },
        uVideo: { value: null }, uVideoOn: { value: 0 }, uVideoBox: { value: videoBox },
      });
      // A creature's own uniforms (skinFx.glsl.uniforms: name → number or [2–4 numbers]); pose()
      // can set them every frame through P.parts.uniforms.
      for (const [k, v] of Object.entries(G.uniforms || {}))
        sh.uniforms[k] = { value: Array.isArray(v) ? new [0, 0, THREE.Vector2, THREE.Vector3, THREE.Vector4][v.length]().fromArray(v) : v };
      mat.userData.shader = sh;
      sh.vertexShader = 'attribute vec2 aSk;\nattribute vec3 aEye;\nattribute vec3 aTint;\nattribute float aAlpha;\nattribute vec4 aCustom;\nvarying vec2 vSk;\nvarying vec3 vEye;\nvarying vec3 vBind;\nvarying vec3 vTint;\nvarying float vAlpha;\nvarying vec4 vCustom;\nvarying vec3 vBindNrm;\n' +
        sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n  vSk = aSk; vEye = aEye; vBind = position; vTint = aTint; vAlpha = aAlpha; vCustom = aCustom; vBindNrm = normal;');
      sh.fragmentShader = `uniform vec3 uUnder; uniform float uColour, uMottle, uBump, uBlink, uSuck, uPhase, uTime; uniform vec2 uSlit;
uniform sampler2D uVideo; uniform float uVideoOn; uniform vec4 uVideoBox;
varying vec2 vSk; varying vec3 vEye; varying vec3 vBind; varying vec3 vTint; varying float vAlpha; varying vec4 vCustom; varying vec3 vBindNrm;
${decl}
${NOISE}
${G.head || ''}
// The Video skin's picture at this bit of skin, in linear light (a camera or movie frame is stored
// ready for the screen; the lighting below works in linear). uVideoBox = bind-space centre, 1 / size.
vec2 videoMirror(vec2 u){ return 1.0 - abs(fract(u * 0.5) * 2.0 - 1.0); }
vec3 videoSkin(){
  vec3 w = pow(abs(normalize(vBindNrm)), vec3(4.0)); w /= (w.x + w.y + w.z);
  vec3 q = (vBind - uVideoBox.xyz) * uVideoBox.w + 0.5;
  vec3 c = texture2D(uVideo, videoMirror(q.zy)).rgb * w.x + texture2D(uVideo, videoMirror(q.xz)).rgb * w.y + texture2D(uVideo, videoMirror(q.xy)).rgb * w.z;
  return pow(c, vec3(2.2));
}
// Sucker field: x = underside mask, y = cup height (raised rim, sunken centre).
vec2 suckers(){
  if (vSk.y < 0.0 || uSuck < 0.5) return vec2(0.0);
  float a = (vSk.x - 0.5) * 6.2831853;
  float under = smoothstep(0.2, 0.75, cos(a));
  float d = min(length(vec2(fract(vSk.y) - 0.5, a + 0.45)), length(vec2(fract(vSk.y + 0.5) - 0.5, a - 0.45)));
  float fade = smoothstep(0.3, 1.5, vSk.y);
  float h = smoothstep(0.38, 0.27, d) - 1.4 * smoothstep(0.21, 0.1, d);
  return vec2(under, h * under * fade);
}
float slitE(){ float b = uSlit.y * (1.0 - uBlink); return (vEye.x * vEye.x) / (uSlit.x * uSlit.x) + (vEye.y * vEye.y) / max(b * b, 1e-6); }
` + sh.fragmentShader
        .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
  if (vEye.z > 0.99 && uBlink < 0.98 && slitE() < 1.0) discard;`)
        .replace('#include <color_fragment>', `#include <color_fragment>
  if (uColour > 0.5) {
    diffuseColor.rgb *= vTint;   // per-part colour (chain tint, or the view's own surface)
    diffuseColor.a *= vAlpha;    // per-part see-through (shows only on a transparent material)
    vec2 su = suckers();
    float m = fbm(vBind * 2.6);
    diffuseColor.rgb *= mix(1.0, 0.62 + 0.75 * m, uMottle * (1.0 - su.x * 0.7));
    diffuseColor.rgb *= 1.0 - uMottle * 0.25 * smoothstep(0.62, 0.8, vnoise(vBind * 14.0));
    diffuseColor.rgb = mix(diffuseColor.rgb, uUnder, su.x * 0.75);
    diffuseColor.rgb = mix(diffuseColor.rgb, uUnder * 1.15, max(su.y, 0.0) * 0.5);
    diffuseColor.rgb *= 1.0 + min(su.y, 0.0) * 0.3;
    if (vEye.z > 0.99) { float e = slitE(); diffuseColor.rgb *= mix(0.55, 1.0, smoothstep(1.0, 2.2, e)); }
  }
  vec3 videoC = vec3(0.0);
  if (uVideoOn > 0.5) { videoC = videoSkin(); diffuseColor.rgb = videoC; }`)
        .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
  {
    // Relief: height field → normal, from screen-space derivatives (no tangents needed).
    float h = uBump * (0.55 * fbm(vBind * 9.0) + 0.45 * vnoise(vBind * 38.0)) + 0.9 * suckers().y * step(0.001, uBump)
      + (${G.height || '0.0'});   // skinFx.glsl.height: the creature's own relief (scales, ridges)
    vec3 dpx = dFdx(-vViewPosition), dpy = dFdy(-vViewPosition);
    float hx = dFdx(h), hy = dFdy(h);
    vec3 r1 = cross(dpy, normal), r2 = cross(normal, dpx);
    float det = dot(dpx, r1);
    vec3 grad = sign(det) * (hx * r1 + hy * r2);
    normal = normalize(abs(det) * normal - grad * 0.012);
  }
  // A picture worn as skin lights itself a little, so the side turned from the light is dim, not
  // black (the same floor ImWeb's own textured object has).
  totalEmissiveRadiance += videoC * 0.35;
  ${G.surface ? `{\n${G.surface}\n  }` : ''}`);
    };
    return mat;
  }
  const SKINS = {
    soft: () => ({
      limb: made(patchSkin(
        new THREE.MeshPhysicalMaterial({ color: view.soft.limb, roughness: view.soft.roughness ?? 0.5, clearcoat: view.soft.clearcoat ?? 0.55,
          clearcoatRoughness: view.soft.clearcoatRoughness ?? 0.35, side: THREE.DoubleSide,
          ...(view.soft.limbProps || {}) }), true)),   // any other material settings a view wants (transparency, sheen…)
      body: made(new THREE.MeshPhysicalMaterial({ color: view.soft.body, roughness: 0.3, clearcoat: 1, side: THREE.DoubleSide,
        ...(view.soft.bodyClear ? { transparent: true, opacity: 0.8 } : {}) })) }),
    chrome: () => ({
      limb: made(patchSkin(new THREE.MeshStandardMaterial({ color: 0xdddddd, metalness: 1, roughness: 0.12, envMap: env(), side: THREE.DoubleSide }), false)),
      body: made(new THREE.MeshStandardMaterial({ color: 0xeeeeee, metalness: 1, roughness: 0.08, envMap: env(), side: THREE.DoubleSide })) }),
    glass: () => ({
      limb: made(patchSkin(new THREE.MeshPhysicalMaterial({ color: 0xbfe6ff, roughness: 0.05, envMap: env(), transparent: true, opacity: 0.55, clearcoat: 1, side: THREE.DoubleSide }), false)),
      body: made(new THREE.MeshPhysicalMaterial({ color: 0xcff0ff, roughness: 0.05, envMap: env(), transparent: true, opacity: 0.35, clearcoat: 1, side: THREE.DoubleSide, depthWrite: false })) }),
  };
  // video: matte, lit, nothing of its own — the picture is everything (setVideo).
  SKINS.video = () => ({
    limb: made(patchSkin(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.62, metalness: 0, side: THREE.DoubleSide }), false)),
    body: made(new THREE.MeshStandardMaterial({ color: 0x1c1c1c, roughness: 0.4, side: THREE.DoubleSide })) });
  let mats = SKINS.soft(), skinName = 'soft';
  let video = null;   // the picture the Video skin wears (a texture the HOST owns; never freed here)

  // ---- Body: every chain in ONE SkinnedMesh with ONE skeleton (one draw call) --------------
  // A chain of nb segments has nb+1 bones; bone i sits at joint i and owns segment i.
  const body = new THREE.Group(); world.add(body);
  // Y·Z·X: heading, pitch about the body's side axis, roll about its length. With no roll this is
  // the same matrix as the default XYZ order, so the jellyfish and octopus are unchanged.
  body.rotation.order = 'YZX';
  // build(THREE, body, mats, world): `world` is the space the body moves through (its parent), for
  // things that must stay where they were left while the body moves on (ink, bubbles, tracks).
  const worldBefore = new Set(world.children);
  const parts = view.build(THREE, body, mats, world);
  const worldAdded = world.children.filter(o => !worldBefore.has(o) && o !== body);

  // Bound in the creature's REST layout (segment 1 at phase 0, chains straight), not all at the
  // origin: geometry that spans two chains (the octopus web) needs real positions and normals.
  const REST = makePose(def); def.pose(segmentState(def, 0), 0, REST);
  const Yax = new THREE.Vector3(0, 1, 0), Zax = new THREE.Vector3(0, 0, 1);
  const pos = [], nrm = [], sIdx = [], sW = [], idx = [], bones = [], chains = [], extraRoots = [];
  // aSk per vertex: (u round the tube, sucker count from the root); y = −1 marks "not an arm".
  const sk = [], eyeA = [];   // eyeA: (eye-plane x, y, mask) — only the head carries it
  const tint = [];            // aTint: Soft-skin colour multiplier per vertex (1,1,1 = the skin's own colour)
  const axisP = [], strA = [];   // aAxis, aStr: for stretch and thinning (see patchVertex)
  const alphaA = [];          // aAlpha: Soft-skin opacity multiplier per vertex (chain `alpha`, or the view's own)
  const customA = [];         // aCustom: 4 free numbers per vertex for a creature's own shader code (skinFx.glsl)
  const furA = [];            // aFur: (length, density, tip lightness, freq) per vertex; 0 = bald (see patchFur)
  // Which bones a point s along a chain follows: bone i, blended with the neighbour across the
  // nearer joint so bends are smooth. Returns absolute bone indices.
  function boneAt(ch, s) {
    const nb = ch.L.length; let i = 0; while (i < nb - 1 && s > ch.cum[i + 1]) i++;
    const f = Math.min(1, (s - ch.cum[i]) / ch.L[i]);
    let b1, w1;
    if (f < 0.5) { b1 = Math.max(0, i - 1); w1 = 0.5 - f; } else { b1 = Math.min(nb, i + 1); w1 = f - 0.5; }
    return { i: ch.boneBase + i, b1: ch.boneBase + b1, w1 };
  }
  // Bind-pose point on a chain's axis at distance s from its root.
  function axisAt(ch, s, out = new THREE.Vector3()) { return out.set(0, -s, 0).applyQuaternion(ch.q).add(ch.p); }
  function addChain(cd, j, C0) {
    const j0 = j;   // this chain's index in its group (the ring loop below reuses j)
    const { bones: nb, length: total, r0, r1, rs } = cd;
    const L = chainLengths(nb, total, cd.decay ?? 0.95), boneBase = bones.length, vBase = pos.length / 3;
    // p, q: the root in its parent's frame (the body, or a bone of another chain — cd.on).
    // P0, Q0: the same in bind space, where the vertices are built.
    const p = new THREE.Vector3(Math.cos(C0.a) * C0.rad, C0.y, Math.sin(C0.a) * C0.rad);
    const q = new THREE.Quaternion().setFromAxisAngle(Yax, -C0.a).multiply(new THREE.Quaternion().setFromAxisAngle(Zax, C0.tilt));
    let parent = null, P0 = p, Q0 = q;
    if (cd.on) {
      const pc = chains[cd.on.chain]; parent = pc.bones[cd.on.bone(j)];
      pc.root.updateMatrixWorld(true);                 // parent chain is still unattached: its root's world = local
      const pq = new THREE.Quaternion(); parent.matrixWorld.decompose(new THREE.Vector3(), pq, new THREE.Vector3());
      P0 = p.clone().applyMatrix4(parent.matrixWorld); Q0 = pq.multiply(q);
    }
    const cb = [];
    for (let i = 0; i <= nb; i++) {
      const b = new THREE.Bone();
      if (i > 0) { b.position.y = -L[i - 1]; cb[i - 1].add(b); } else { b.position.copy(p); b.quaternion.copy(q); if (parent) parent.add(b); }
      cb.push(b); bones.push(b);
    }
    const cum = [0]; L.forEach(l => cum.push(cum[cum.length - 1] + l));
    const ch = { root: cb[0], bones: cb, L, cum, boneBase, p: P0, q: Q0, length: cum[nb], parented: !!parent, stiff: cd.stiff ?? 1, damp: cd.damp ?? 0.55, dampT: cd.damp ?? 0.6 };
    chains.push(ch);
    if (cd.tube === false) return;
    const base = new THREE.Color(cd.tint ?? 0xffffff), tipC = new THREE.Color(cd.tipTint ?? cd.tint ?? 0xffffff), col = new THREE.Color();
    // art: jointed limb — `art` articles along the chain, each swelling in its middle, pinched and
    // darkened at its joints (leg segments, antenna beads). Shape and colour only; bones still bend.
    const art = cd.art ?? 0, pinch = cd.pinch ?? 0.25, dark = cd.dark ?? 0.45;
    const M = (cd.rings ?? nb * RINGS_PER_SEG) + 1, v = new THREE.Vector3(), n = new THREE.Vector3();
    for (let m = 0; m < M; m++) {
      const s = (m / (M - 1)) * cum[nb], u = m / (M - 1), { i, b1, w1 } = boneAt(ch, s);
      let r = r0 * (1 - u) + r1 * u;
      col.copy(base).lerp(tipC, Math.max(0, (u - 0.7) / 0.3));
      if (art) {
        const f = (u * art) % 1, e = Math.min(f, 1 - f);
        r *= (1 - pinch) + pinch * Math.pow(Math.sin(Math.PI * Math.min(1, f)), 0.5);
        col.multiplyScalar(1 - dark * Math.max(0, 1 - e / 0.12));
      }
      if (u === 1) r *= 0.3;   // a point, not a cut-off end
      // Suckers are about one local radius apart, so they shrink toward the tip: the count up to
      // s is ∫ ds / r(s) for a linearly tapering radius.
      const qr = 1 - r1 / r0, suck = cum[nb] / (r0 * qr) * -Math.log(1 - qr * u);
      const ax = new THREE.Vector3(0, -s, 0).applyQuaternion(Q0).add(P0), dir = new THREE.Vector3(0, -1, 0).applyQuaternion(Q0);
      for (let j = 0; j <= rs; j++) {
        const an = TAU * j / rs, c = Math.cos(an), sn = Math.sin(an);
        v.set(c * r, -s, sn * r).applyQuaternion(Q0).add(P0); n.set(c, 0, sn).applyQuaternion(Q0);
        pos.push(v.x, v.y, v.z); nrm.push(n.x, n.y, n.z); sk.push(j / rs, suck); eyeA.push(0, 0, 0); tint.push(col.r, col.g, col.b);   // col: per ring
        axisP.push(ax.x, ax.y, ax.z); strA.push(dir.x, dir.y, dir.z, s); alphaA.push(cd.alpha ?? 1); customA.push(...(cd.custom ?? [0, 0, 0, 0]));
        { const F = typeof cd.fur === 'function' ? cd.fur(u, j / rs, j0) : cd.fur ?? furTry; furA.push(F?.len ?? 0, F?.dens ?? 0.7, F?.tip ?? 0, F?.freq ?? 0); }
        sIdx.push(i, b1, 0, 0); sW.push(1 - w1, w1, 0, 0);
      }
    }
    for (let m = 0; m < M - 1; m++) for (let j = 0; j < rs; j++) {
      const a = vBase + m * (rs + 1) + j, b = a + 1, c = a + rs + 1, d = c + 1;
      idx.push(a, b, c, b, d, c);
    }
  }
  { let k = 0; for (const c of def.CHAINS) for (let j = 0; j < c.count; j++) addChain(c, j, REST.chains[k++]); }

  // A view may add skinned geometry of its own (head, webs) into the SAME mesh, so it shares the
  // skin material and has no seam of a second material against the arms.
  const skinCtx = {
    THREE, chains, boneAt, axisAt,
    newBone(position) { const b = new THREE.Bone(); b.position.copy(position); bones.push(b); extraRoots.push(b); return { bone: b, index: bones.length - 1 }; },
    // g: BufferGeometry (position, normal, index) in bind space. weights(vi, x, y, z) → [[i0,i1,i2,i3],[w0,w1,w2,w3]]
    addGeometry(g, weights) {
      const base = pos.length / 3, P = g.attributes.position, Nn = g.attributes.normal;
      for (let vi = 0; vi < P.count; vi++) {
        const x = P.getX(vi), y = P.getY(vi), z = P.getZ(vi), [ii, ww] = weights(vi, x, y, z);
        pos.push(x, y, z); nrm.push(Nn.getX(vi), Nn.getY(vi), Nn.getZ(vi)); sIdx.push(...ii); sW.push(...ww);
        const Sk = g.attributes.aSk; sk.push(Sk ? Sk.getX(vi) : 0, Sk ? Sk.getY(vi) : -1);   // a view's own surface coords, if it has them
        const E = g.attributes.aEye; eyeA.push(E ? E.getX(vi) : 0, E ? E.getY(vi) : 0, E ? E.getZ(vi) : 0);
        const Tn = g.attributes.aTint; tint.push(Tn ? Tn.getX(vi) : 1, Tn ? Tn.getY(vi) : 1, Tn ? Tn.getZ(vi) : 1);
        axisP.push(x, y, z); strA.push(0, 0, 0, 0);   // not a chain tube: no stretch, no thinning
        const Al = g.attributes.aAlpha; alphaA.push(Al ? Al.getX(vi) : 1);
        const Cu = g.attributes.aCustom; customA.push(Cu ? Cu.getX(vi) : 0, Cu ? Cu.getY(vi) : 0, Cu ? Cu.getZ(vi) : 0, Cu ? Cu.getW(vi) : 0);
        const Fu = g.attributes.aFur; furA.push(Fu ? Fu.getX(vi) : 0, Fu ? Fu.getY(vi) : 0, Fu ? Fu.getZ(vi) : 0, Fu ? Fu.getW(vi) : 0);
      }
      const I = g.index; for (let t = 0; t < I.count; t++) idx.push(base + I.getX(t));
    },
  };
  const skinParts = view.skin ? view.skin(skinCtx) : {};
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(sIdx, 4));
  geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sW, 4));
  geo.setAttribute('aSk', new THREE.Float32BufferAttribute(sk, 2));
  geo.setAttribute('aEye', new THREE.Float32BufferAttribute(eyeA, 3));
  geo.setAttribute('aTint', new THREE.Float32BufferAttribute(tint, 3));
  geo.setAttribute('aAxis', new THREE.Float32BufferAttribute(axisP, 3));
  geo.setAttribute('aStr', new THREE.Float32BufferAttribute(strA, 4));
  geo.setAttribute('aAlpha', new THREE.Float32BufferAttribute(alphaA, 1));
  geo.setAttribute('aCustom', new THREE.Float32BufferAttribute(customA, 4));
  geo.setAttribute('aFur', new THREE.Float32BufferAttribute(furA, 4));
  geo.setIndex(idx);
  {   // the Video skin spans one picture across the animal's longest side
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < pos.length; i++) { const k = i % 3; if (pos[i] < lo[k]) lo[k] = pos[i]; if (pos[i] > hi[k]) hi[k] = pos[i]; }
    videoBox.set((lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2, 1 / Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2], 1e-6));
  }
  const limbs = new THREE.SkinnedMesh(geo, mats.limb);
  limbs.frustumCulled = false;
  chains.forEach(c => { if (!c.parented) limbs.add(c.root); });
  extraRoots.forEach(b => limbs.add(b));
  limbs.updateMatrixWorld(true);
  limbs.bind(new THREE.Skeleton(bones));
  // Per-bone stretch and thickness for the vertex shader (patchVertex); updated every frame.
  const boneXD = new Float32Array(bones.length * 4);
  for (let i = 0; i < bones.length; i++) boneXD.set([1, 0, 0, 1], i * 4);
  boneTex = new THREE.DataTexture(boneXD, bones.length, 1, THREE.RGBAFormat, THREE.FloatType); boneTex.needsUpdate = true;
  limbs.castShadow = !!shadows;
  if (shadows) {   // the shadow pass needs the same stretch and thinning, or shadows detach from limbs
    limbs.customDepthMaterial = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
    limbs.customDepthMaterial.onBeforeCompile = patchVertex;
  }
  body.add(limbs);

  // Fur shells: the furry triangles only (bald skin costs nothing), sharing the skin's buffers and
  // skeleton, one mesh per shell. Each shell has its own material (only its shell index differs; the
  // compiled program is shared).
  const furShells = [];
  function furMaterial(k, n) {
    const m = patchSkin(new THREE.MeshStandardMaterial({ color: view.soft.limb, roughness: 0.85, side: THREE.DoubleSide }), true);
    const base = m.onBeforeCompile;
    m.onBeforeCompile = sh => { base(sh); patchFur(sh, k, n); };
    m.customProgramCacheKey = () => `creature|${def.NAME}|fur`;   // one program for all its shells
    return made(m);
  }
  {
    const fi = [];
    for (let t = 0; t < idx.length; t += 3) if (furA[idx[t] * 4] > 0 || furA[idx[t + 1] * 4] > 0 || furA[idx[t + 2] * 4] > 0) fi.push(idx[t], idx[t + 1], idx[t + 2]);
    if (fi.length) {
      const fg = new THREE.BufferGeometry();
      for (const [k, a] of Object.entries(geo.attributes)) fg.setAttribute(k, a);
      fg.setIndex(fi);
      const N = view.fur?.shells ?? 10;
      for (let k = 1; k <= N; k++) {
        const m = new THREE.SkinnedMesh(fg, furMaterial(k, N));
        m.frustumCulled = false; m.bind(limbs.skeleton, limbs.bindMatrix);
        body.add(m); furShells.push(m);
      }
    }
  }

  function setSkin(name) {
    if (!SKINS[name] || name === skinName) return;
    const old = mats; mats = SKINS[name](); skinName = name;
    limbs.material = mats.limb; parts.meshes.forEach(m => { m.material = mats.body; });
    (parts.limbMeshes || []).forEach(m => { m.material = mats.limb; });
    old.limb.dispose(); old.body.dispose();
    furShells.forEach(m => { m.visible = name === 'soft'; });
  }
  // The picture the Video skin wears: any texture, or null for plain white. The host calls this as
  // often as it likes (every frame, for a source that may be re-routed) and goes on owning the texture.
  function setVideo(texture) { video = texture || null; }

  // ---- Applying a pose to the bones --------------------------------------------------------
  const qa = new THREE.Quaternion(), qb = new THREE.Quaternion(), eu = new THREE.Euler(), Y = new THREE.Vector3(0, 1, 0), Z = new THREE.Vector3(0, 0, 1);
  const P = makePose(def);

  // Springs: each joint chases the pose instead of jumping to it — stiff near the root, loose at
  // the tip, a little under-damped — so motion carries weight and follow-through. The pose maths
  // still decides WHERE every joint goes (and seam-check.mjs checks that); a damped spring driven
  // periodically settles into a periodic motion, so loops stay loops after a moment's warm-up.
  const SPR = P.chains.map(C => ({ z: Float64Array.from(C.bz), x: Float64Array.from(C.bx), y: Float64Array.from(C.by),
    vz: new Float64Array(C.bz.length), vx: new Float64Array(C.bz.length), vy: new Float64Array(C.bz.length), t: 0, vt: 0, ready: false }));
  // Hot loop (the jellyfish springs 3500 bones, 4 substeps a frame): arrays in locals, the three
  // springs (bend z, bend x, twist y) inlined. Same maths as a per-channel helper, ~11× cheaper
  // than looking channels up by string key (measured by the jellyfish session: 3.47 → 0.30 ms).
  function applySprings(dt) {
    const steps = Math.max(1, Math.ceil(dt / (1 / 240))), h = dt / steps;
    P.chains.forEach((C, k) => {
      const s = SPR[k], B = C.bz.length, st = chains[k].stiff;   // stiff: quick legs, floppy feelers
      const zeta = chains[k].damp, zt = chains[k].dampT;          // damp: 0.55 a lively wobble, >1 heavy, slow, no bounce (in water)
      if (!s.ready) { s.z.set(C.bz); s.x.set(C.bx); s.y.set(C.by); s.t = C.tilt; s.ready = true; }
      const z = s.z, x = s.x, y = s.y, vz = s.vz, vx = s.vx, vy = s.vy, tz = C.bz, tx = C.bx, ty = C.by;
      const wt = TAU * 2.2 * st;
      for (let n = 0; n < steps; n++) {
        s.vt += (wt * wt * (C.tilt - s.t) - 2 * zt * wt * s.vt) * h; s.t += s.vt * h;
        for (let i = 0; i < B; i++) {
          const w = TAU * (3.0 - 1.9 * i / B) * st, w2 = w * w, d = 2 * zeta * w;   // 3 Hz at the root → 1.1 Hz at the tip (× stiff)
          vz[i] += (w2 * (tz[i] - z[i]) - d * vz[i]) * h; z[i] += vz[i] * h;
          vx[i] += (w2 * (tx[i] - x[i]) - d * vx[i]) * h; x[i] += vx[i] * h;
          vy[i] += (w2 * (ty[i] - y[i]) - d * vy[i]) * h; y[i] += vy[i] * h;
        }
      }
      tz.set(z); tx.set(x); ty.set(y); C.tilt = s.t;
    });
  }

  let hook = null;        // (P, phase): change the pose before it is applied (debug, from the console)
  let onSegment = null;   // (i): the movement changed (jump, or advance at the end of a movement)

  // A creature may do its own segment-to-segment transitions: def.transition(from, target, x, phase, P)
  // gets both full states and the LINEAR progress x in [0, 1) (it eases x itself), and must equal
  // pose(target) as x → 1. Without it, pose() gets one state blended between the two (cur), which
  // moves every point straight from where it was to where it will be — a snake slides across the
  // floor instead of crawling into its next pose.
  // `from` and `target` are the SAME objects for the whole of one transition (jump() makes new ones,
  // once): a creature may cache an expensive plan keyed on their identity (the cobra plans its crawl
  // path once per handover, ~4 ms). Never copy them per frame — that would re-plan every frame.
  function applyPose(S, phase, dt, trX, springs) {
    if (trX >= 0 && def.transition) def.transition(from, target, trX, phase, P); else def.pose(S, phase, P);
    hook?.(P, phase);
    if (springs) applySprings(dt); else SPR.forEach(s => { s.ready = false; });
    view.apply(P, parts, skinParts);
    for (const mesh of [limbs, ...furShells]) {
      const sh = mesh.material.userData.shader; if (!sh) continue;
      sh.uniforms.uBlink.value = P.parts.blink ?? 0; sh.uniforms.uPhase.value = phase; sh.uniforms.uTime.value += dt;
      sh.uniforms.uVideo.value = video; sh.uniforms.uVideoOn.value = video && skinName === 'video' ? 1 : 0;
      for (const [k, v] of Object.entries(P.parts.uniforms || {})) {   // a creature's own uniforms (skinFx.glsl)
        const u = sh.uniforms[k]; if (!u) continue;
        if (Array.isArray(v)) u.value.fromArray(v); else u.value = v;
      }
    }
    body.position.set(P.root.x, P.root.y, P.root.z);
    body.rotation.set(P.root.rx, P.root.ry, P.root.rz);   // order YZX (set above): heading · pitch · roll
    chains.forEach((ch, k) => {
      const C = P.chains[k];
      ch.root.position.set(Math.cos(C.a) * C.rad, C.y, Math.sin(C.a) * C.rad);
      // Point the chain down, turned to face outward at angle a, tilted outward by C.tilt.
      qa.setFromAxisAngle(Y, -C.a); qb.setFromAxisAngle(Z, C.tilt);
      // Each bone: bend in two planes (bx, bz), twist about the chain's own axis (by); each segment
      // stretches or shortens by bl (core.js chainFK computes exactly this, for poses that need it).
      ch.root.quaternion.copy(qa).multiply(qb).multiply(qb.setFromEuler(eu.set(C.bx[0], C.by[0], C.bz[0])));
      for (let i = 1; i < ch.bones.length; i++) {
        const b = ch.bones[i];
        b.position.y = -ch.L[i - 1] * C.len * C.bl[i - 1];
        if (i < C.bz.length) b.quaternion.setFromEuler(eu.set(C.bx[i], C.by[i], C.bz[i]));
        else b.quaternion.identity();
      }
      // Stretch and thickness per bone (patchVertex). Thickness keeps volume: 1/√bl, clamped so a
      // hard stretch never makes a thread nor a hard squeeze a ball. The tip bone follows the last segment.
      const nb = ch.L.length; let D = 0;
      for (let i = 0; i <= nb; i++) {
        const bl = C.bl[Math.min(i, nb - 1)], o = (ch.boneBase + i) * 4;
        boneXD[o] = Math.min(1.5, Math.max(0.6, 1 / Math.sqrt(bl))); boneXD[o + 1] = ch.cum[i]; boneXD[o + 2] = D; boneXD[o + 3] = C.len * bl;
        if (i < nb) D += ch.L[i] * C.len * bl;
      }
    });
    boneTex.needsUpdate = true;
  }

  // ---- Navigator -------------------------------------------------------------------------
  // One clock. Integer keys switch at a loop boundary; everything else eases over one loop.
  const T = def.LOOP_SECONDS, N = def.SEGMENTS.length;
  let seg = ((Math.round(segment) % N) + N) % N, loopsInSeg = 0, tt = 0, lastLoop = 0;
  let cur = segmentState(def, seg), from = { ...cur }, target = cur, trStart = -1;
  function jump(i) {
    seg = ((i % N) + N) % N; loopsInSeg = 0;
    from = { ...cur }; target = segmentState(def, seg); trStart = tt;
    onSegment?.(seg);
  }
  // One frame. dt: seconds of the creature's own clock (the host multiplies in its speed).
  // advance: after `loops` loops of a movement, 'next' goes on to the next one (the page's Play
  // whole), 'random' to any other, 'off' stays (Loop one). springs: false = joints jump to the pose.
  function step(dt, { advance = 'next', loops = 2, springs = true } = {}) {
    tt += dt;
    const loop = Math.floor(tt / T);
    if (loop !== lastLoop) {                              // loop boundary: phase is exactly 0 here
      lastLoop = loop;
      for (const k of def.INT_KEYS) cur[k] = target[k];   // frequencies change only now
      loopsInSeg++;
      if (advance !== 'off' && loopsInSeg >= loops)
        jump(advance === 'random' && N > 1 ? seg + 1 + Math.floor(Math.random() * (N - 1)) : seg + 1);
    }
    let trX = -1;                                         // linear progress of a running transition
    if (trStart >= 0) {
      const x = Math.min(1, (tt - trStart) / T), e = x * x * (3 - 2 * x);
      lerpState(def, from, target, e, cur);
      if (x >= 1) trStart = -1; else trX = x;
    }
    const phase = TAU * ((tt % T) / T);
    applyPose(cur, phase, dt, trX, springs);
    return phase;
  }

  // Everything this creature made goes: its meshes, materials and textures, and what build() left in
  // the world. The envMap belongs to the host and is left alone.
  function dispose() {
    world.remove(body); worldAdded.forEach(o => o.parent?.remove(o));
    const free = o => {
      o.geometry?.dispose();
      for (const m of [].concat(o.material || [])) {
        for (const v of Object.values(m)) if (v?.isTexture && v !== envUsed) v.dispose();
        for (const u of Object.values(m.uniforms || {})) if (u?.value?.isTexture && u.value !== envUsed) u.value.dispose();
        m.dispose();
      }
    };
    body.traverse(free); worldAdded.forEach(o => o.traverse(free));
    limbs.customDepthMaterial?.dispose();
    mats.limb.dispose(); mats.body.dispose();
    limbs.skeleton.dispose(); boneTex.dispose();
  }

  return {
    def, view, body, limbs, furShells, bones, P, T,
    parts, worldAdded,   // what view.build() made: its own meshes, and what it left in the world
    patchVertex,         // the stretch-and-thinning vertex patch, for a host's own depth materials
    jump, step, setSkin, setVideo, dispose,
    get seg() { return seg; }, get state() { return cur; }, get loopsInSeg() { return loopsInSeg; }, get time() { return tt; },
    get skin() { return skinName; },
    get hook() { return hook; }, set hook(f) { hook = f; },
    get onSegment() { return onSegment; }, set onSegment(f) { onSegment = f; },
  };
}
