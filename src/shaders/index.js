/**
 * ImWeb Shaders
 * All effects shaders as GLSL strings.
 * WebGPU / WGSL equivalents are annotated with // WGSL: comments.
 * These run as Three.js ShaderMaterial fragment shaders on a full-screen quad.
 */

// ── Shared vertex shader (used by all passes) ─────────────────────────────────

export const VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position, 1.0);
  }
`;

// ── Motion Extraction ─────────────────────────────────────────────────────────
// Two passes over one source: a background estimate that adapts over time, and
// the matte that comes out of comparing the live frame against it.
//
// ONE mechanism, not two modes. Background subtraction and frame differencing
// are the two ENDS of the same control: the background is an exponential
// running average, so a long adapt time gives a stable background (a subject
// who pauses stays visible), and an adapt time of zero makes the background
// equal to the previous frame, which IS frame differencing. Shipping them as a
// mode select would offer two points on a continuum the shader already spans.
//
// The matte is a clean continuous signal on purpose — no threshold, no
// softness. Those already exist on the keyer as White/Black/Softness, and this
// is meant to be fed to the keyer's key source, so growing its own copies would
// mean two sets of controls doing one job.

export const MOTION_MATTE = /* glsl */ `
  uniform sampler2D uCurrent;
  uniform sampler2D uBg;      // background estimate (previous state)
  uniform sampler2D uTrail;   // matte from last frame, for persistence
  uniform float     uGain;    // difference multiplier
  uniform float     uDecay;   // per-frame trail retention, 0 = no trail

  varying vec2 vUv;

  void main() {
    vec3 cur = texture2D(uCurrent, vUv).rgb;
    vec3 bg  = texture2D(uBg,      vUv).rgb;

    // Largest per-channel departure, not luminance of the difference: a change
    // that swaps hue at constant luminance is still movement, and a luma-only
    // measure scores it near zero.
    vec3  d = abs(cur - bg);
    float m = clamp(max(max(d.r, d.g), d.b) * uGain, 0.0, 1.0);

    // max(), never +=. Instant attack, exponential release — which is a flake
    // streaking and fading — and bounded by construction, so where two paths
    // cross the matte holds at 1 instead of compounding toward white.
    float prev = texture2D(uTrail, vUv).r;
    float t    = max(m, prev * uDecay);

    gl_FragColor = vec4(vec3(t), 1.0);
  }
`;

export const MOTION_BG = /* glsl */ `
  uniform sampler2D uCurrent;
  uniform sampler2D uBg;
  uniform float     uAdapt;   // 0..1 — share of the live frame folded in

  varying vec2 vUv;

  void main() {
    vec3 cur = texture2D(uCurrent, vUv).rgb;
    vec3 bg  = texture2D(uBg,      vUv).rgb;
    // uAdapt = 1 makes the background exactly this frame, so next frame's
    // comparison is against the previous one: frame differencing, no branch.
    gl_FragColor = vec4(mix(bg, cur, uAdapt), 1.0);
  }
`;

// ── Growth: Variation — one slow noise field shared by every Growth mode ──────
// Gray-Scott has ONE stripe width, set by diffusion/feed/kill, identical
// everywhere — which is why its detail evens out. This field lets each mode
// vary its own size parameter across the canvas: stripe width (Single), arm
// thickness (Frost), fine↔coarse (Nested). Value noise, three octaves, aspect
// corrected so regions are round, drifting slowly. −1…1; 0 when off.
const GROWTH_VAR_GLSL = /* glsl */ `
  uniform float uVar;       // 0–1 amount
  uniform vec3  uVarP;      // x: regions across, y: drift time, z: aspect (w/h)
  float gvHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float gvNoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(gvHash(i), gvHash(i + vec2(1.0, 0.0)), u.x),
               mix(gvHash(i + vec2(0.0, 1.0)), gvHash(i + vec2(1.0, 1.0)), u.x), u.y);
  }
  // The raw field, −1…1, whatever uVar is — Zones reads it too.
  float gvField(vec2 uv) {
    vec2 p = vec2(uv.x * uVarP.z, uv.y) * uVarP.x;
    float t = uVarP.y;
    float n = 0.57 * gvNoise(p + vec2(t, 0.37 * t))
            + 0.29 * gvNoise(p * 2.03 + vec2(5.2 - 0.6 * t, 5.2 + t))
            + 0.14 * gvNoise(p * 4.1 + vec2(11.7 - 0.8 * t, 11.7));
    // Summed value noise huddles round 0.5; ×3 spreads it to use the range.
    return clamp((n - 0.5) * 3.0, -1.0, 1.0);
  }
  float growthVar(vec2 uv) { return uVar > 0.0 ? gvField(uv) : 0.0; }

  // Edge: room to grow, 1 inside and easing to 0 at the frame's edge over a
  // margin of uEdge × the frame height (aspect corrected, so the margin is
  // the same on all four sides). Each engine turns it into its own brake, so
  // growth thins out before the frame instead of being cut off by it.
  // A straight margin made every engine stop along a ruled rectangle — a
  // picture frame, not a colony's edge (seen on GPU renders) — so the corners
  // are rounded (smooth min of the side distances) and the line wanders
  // with the slow noise field Variation uses.
  uniform float uEdge;
  float edgeRoom(vec2 uv) {
    if (uEdge <= 0.0) return 1.0;
    vec2 d = min(uv, 1.0 - uv) * vec2(uVarP.z, 1.0);
    float k = 0.5 * uEdge;
    float dd = -k * log(exp(-d.x / k) + exp(-d.y / k));
    dd += 0.6 * uEdge * gvField(uv + vec2(3.7, 9.1));
    return smoothstep(0.0, uEdge, dd);
  }
`;

// ── Growth: Gray-Scott reaction-diffusion ─────────────────────────────────────
// State texture: r = A (food), g = B (the grower). One step of
//   A' = A + Da∇²A − AB² + f(1−A)
//   B' = B + Db∇²B + AB² − (f+k)B
// with Δt = 1, Da = uDiff (≤ 1), Db = Da/2 — stable for this 9-point Laplacian
// (centre −1, edges 0.2, corners 0.05). Da sets the feature size in texels
// (~√(Da/f)), so it is exposed as Scale. (f, k) is blended per pixel from two
// patterns by the field's luminance, then offset by the performable knobs.
// Out-of-range taps clamp to the edge texel, which makes the border reflective.

export const GROWTH_RD_STEP = /* glsl */ `
${GROWTH_VAR_GLSL}
  uniform sampler2D uState;
  uniform vec2      uTexel;
  uniform sampler2D uSeed;
  uniform float     uSeedAmt;   // 0 = seed source ignored
  uniform sampler2D uSeedPrev;  // last frame's seed — a rise means the stroke ARRIVED here
  uniform sampler2D uField;
  uniform float     uFieldAmt;  // 0 = Pattern A everywhere
  uniform vec2      uFkA;       // (feed, kill) for field = 0
  uniform vec2      uFkB;       // (feed, kill) for field = 1
  uniform vec2      uFkOff;     // performable offsets
  uniform vec3      uPoint;     // spore: xy in uv, z radius in texels (0 = none)
  uniform float     uDiff;      // Da; Db = Da/2. Sets the pattern's size in texels
  uniform float     uAgeDt;     // real seconds this step stands for
  uniform float     uLife;      // seconds a cell may live; 0 = immortal
  uniform float     uRest;      // seconds dead ground stays barren after dying
  uniform float     uNow;       // lineage clock, seconds — stamps new plantings
  uniform float     uGrowTime;  // seconds a colony grows from its planting; 0 = forever
  uniform float     uFadeTime;  // seconds it then takes to fade and clear
  uniform float     uPenRate;   // Pen fade: decay per second (0 = off) — the pen's own curve
  uniform float     uZones;     // 0–1: Pattern A → B by region, from the built-in field

  varying vec2 vUv;

  vec2 S(vec2 o) { return texture2D(uState, vUv + o * uTexel).rg; }

  void main() {
    vec2 c   = S(vec2(0.0));
    vec2 lap = -c
      + 0.2  * (S(vec2( 1.0, 0.0)) + S(vec2(-1.0, 0.0)) + S(vec2(0.0, 1.0)) + S(vec2(0.0, -1.0)))
      + 0.05 * (S(vec2( 1.0, 1.0)) + S(vec2(-1.0, 1.0)) + S(vec2(1.0, -1.0)) + S(vec2(-1.0, -1.0)));

    float m = 0.0;
    if (uFieldAmt > 0.0) {
      vec3 fc = texture2D(uField, vUv).rgb;
      m = clamp(dot(fc, vec3(0.299, 0.587, 0.114)) * uFieldAmt, 0.0, 1.0);
    }
    // Zones: the same drifting field Variation uses, another slice of it
    // (offset), so the patchwork does not depend on the Noise source's setup.
    if (uZones > 0.0) m = max(m, uZones * smoothstep(-0.25, 0.25, gvField(vUv + vec2(17.3, 5.1))));
    vec2 fk = mix(uFkA, uFkB, m) + uFkOff;
    float f = max(fk.x, 0.0);
    float k = max(fk.y, 0.0);

    // ── Age (blue channel, real seconds) ──────────────────────────────────
    // > 0: alive that long. < 0: died of age, barren for −age more seconds.
    // Old cells get extra kill, ramping in over the last quarter of their
    // life, so a colony dies back from its OLDEST part — the centre of a
    // spore, the first stroke — while the young edge keeps advancing. Barren
    // ground is held dead (full extra kill) until its rest runs out, then the
    // living edge can recolonise it: rings, fronts and regrowth cycles.
    float age  = texture2D(uState, vUv).b;
    // ── Lineage (alpha: the time this colony was planted) ─────────────────
    // Barren ground is barred to the colony that died there, not to new
    // growth. Age alone cannot tell them apart — a cell the old pattern
    // re-colonises is young too, and letting "young" neighbours in kept the
    // dead centre alive forever (measured). So every cell carries a stamp:
    // a seed pixel gets "now" once, when it is first seeded; a newly
    // colonised cell takes the stamp of its PARENT — the living neighbour
    // with the most B, the one that actually grew into it; living cells keep
    // theirs, and barren ground keeps the stamp of what died. A barren cell
    // opens only to a living neighbour with a NEWER stamp.
    // Parent, not newest: inheriting the newest stamp let the last part of a
    // stroke win wherever growth met, so a whole picture shared the final
    // stamp and stopped at once instead of fading in drawing order.
    float stamp = texture2D(uState, vUv).a;
    float nbStamp = -1.0;                 // newest living neighbour, −1 = none
    float parent  = -1.0;                 // stamp of the strongest living neighbour
    {
      vec2 o[4];
      o[0] = vec2(1.0, 0.0); o[1] = vec2(-1.0, 0.0); o[2] = vec2(0.0, 1.0); o[3] = vec2(0.0, -1.0);
      float pB = 0.1;
      for (int j = 0; j < 4; j++) {
        vec4 n = texture2D(uState, vUv + o[j] * uTexel);
        if (n.g > 0.1) nbStamp = max(nbStamp, n.a);
        if (n.g > pB) { pB = n.g; parent = n.a; }
      }
    }
    if (uLife > 0.0 && age < 0.0 && nbStamp > stamp + 1e-3) age = 0.0;
    float die  = 0.0;
    if (uLife > 0.0) die = age < 0.0 ? 1.0 : smoothstep(uLife * 0.75, uLife, age);
    k += 0.04 * die;

    // Grow time: past it a colony may not spread (below); during Fade time it
    // DISSOLVES while still alive — extra kill ramps in with the fade, so the
    // pattern keeps moving as it thins out, instead of freezing (the first
    // version froze it, and the whole picture stood still).
    float fadeP = 0.0;
    if (uGrowTime > 0.0 && stamp > 0.0) fadeP = clamp((uNow - stamp - uGrowTime) / max(uFadeTime, 1e-3), 0.0, 1.0);
    // Pen fade: the pen's curve instead of hold-then-fade — every part starts
    // decaying the moment it was drawn, exp(−rate·age), newest brightest.
    if (uPenRate > 0.0 && stamp > 0.0) fadeP = 1.0 - exp(-uPenRate * (uNow - stamp));
    // Squared ramp: the extra kill stays small for most of the fade and only
    // tips the pattern past its death line near the end, so the dissolving
    // spans the whole Fade time (linear 0.05 killed it in half of it).
    k += 0.012 * fadeP * fadeP;
    // Edge: kill rises toward the frame, so the pattern thins — stripes to
    // spots to nothing — rather than meeting the border at full strength.
    k += 0.03 * (1.0 - edgeRoom(vUv));

    float a = c.r, b = c.g;
    float r = a * b * b;
    // Variation: diffusion swung ±2.3 octaves by region, CLAMPED to the band
    // where patterns live — 0.2 (measured: coral dies below it, maze below
    // 0.15) to 1 (the 9-point stability limit). Stripe width goes as √D, so
    // up to ~2.2× across one canvas at ANY Size. The first version only
    // widened from Size, so near the top of Size there was no room and the
    // canvas stayed uniform (owner's screenshot); an unclamped ± swing
    // killed seeds and left islands.
    float D = clamp(uDiff * exp2(2.3 * uVar * growthVar(vUv)), 0.2, 1.0);
    a += D * lap.r - r + f * (1.0 - a);
    b += 0.5 * D * lap.g + r - (f + k) * b;

    // ── Grow time: every part grows for Grow time from when IT was seeded,
    // then stops spreading, dissolves over Fade time (kill ramp above) and
    // clears. Each part keeps its own clock, so a stroke drawn over three
    // seconds fades out in the order it was drawn.
    if (uGrowTime > 0.0) {
      if (c.g <= 0.1 && parent > 0.0 && uNow - parent > uGrowTime) b = min(b, 0.05);
      if (stamp > 0.0 && uNow - stamp > uGrowTime + uFadeTime) { a = 1.0; b = 0.0; age = 0.0; stamp = 0.0; }
    }
    // Pen fade clears a part once it is darker than one 8-bit level — where
    // the pen's own strokes reach black.
    if (uPenRate > 0.0 && stamp > 0.0 && fadeP > 1.0 - 1.0 / 255.0) { a = 1.0; b = 0.0; age = 0.0; stamp = 0.0; }

    // Seeding moves a cell TOWARD the classic inoculum (A 0.5, B 0.25) and
    // never away from it: B only rises, A only falls, so a held seed (a drawn
    // line) cannot scrub the growth around it. Food has to drop as well —
    // raising B alone on a full-food cell (A 1, B 0.5) inoculates some
    // patterns and simply dies out in others (Spots, from a spore).
    if (uSeedAmt > 0.0) {
      vec3 sc = texture2D(uSeed, vUv).rgb;
      float s = clamp(dot(sc, vec3(0.299, 0.587, 0.114)) * uSeedAmt, 0.0, 1.0);
      b = max(b, s * 0.25);
      a = min(a, 1.0 - s * 0.5);
      // A seed is a new generation where it lands.
      // Stamped ONCE, when first seeded — a held stroke re-stamping "now"
      // every frame could never reach its Grow time. After its fade clears
      // it, a still-held seed sprouts again with a fresh stamp: a cycle.
      // ARRIVAL also stamps, even over growth that got here first: a stroke
      // drawn over three seconds must carry three seconds of stamps along
      // its length, or the growth racing ahead of the pen gives the whole
      // stroke its starting time (measured in Frost: all faded at once).
      float sp = smoothstep(0.05, 0.3, clamp(dot(texture2D(uSeedPrev, vUv).rgb, vec3(0.299, 0.587, 0.114)) * uSeedAmt, 0.0, 1.0));
      // Wherever a seed acts at all, it stamps: a faint seed that inoculated
      // without stamping grew a colony no fade could ever reach (measured in
      // Frost). Residue under 5% is already cut by the knee above.
      if (s > 0.0 && (s - sp > 0.1 || c.g <= 0.1 || stamp <= 0.0)) { age = max(age, 0.0); stamp = uNow; }
    }
    if (uPoint.z > 0.0) {
      vec2 d = (vUv - uPoint.xy) / uTexel;
      if (dot(d, d) < uPoint.z * uPoint.z) { a = 0.5; b = 0.25; age = 0.0; stamp = uNow; }
    }

    // Alive = the same threshold the eye uses (the view starts at B 0.08).
    // A living cell ages; one that falls below it either died of age (→ goes
    // barren) or was just a gap in the pattern (→ age resets, no memory).
    if (b > 0.1) {
      age += uAgeDt;
    } else if (uLife > 0.0 && age >= uLife * 0.75) {
      age = -max(uRest, uAgeDt);
    } else if (age > 0.0) {
      age = 0.0;
    } else {
      age = min(0.0, age + uAgeDt);
    }

    // Colonised this step (dead → alive): inherit the colonisers' lineage.
    if (c.g <= 0.1 && b > 0.1 && parent >= 0.0) stamp = parent;

    gl_FragColor = vec4(clamp(a, 0.0, 1.0), clamp(b, 0.0, 1.0), age, stamp);
  }
`;

// B sits between ~0.1 and ~0.45 wherever something is growing, so the view
// stretches that band by Contrast. Spread walks the hue along the concentration,
// so the dense core and the thin growing edge read as different colours.
// Nested's state drawn up to OUTPUT resolution through a cubic B-spline (four
// bilinear taps, as the multi-scale step samples its pyramid). Its field is
// ±1 plateaus with one-texel cliffs and one-texel specks, so a grid-sized
// view stretched 3–6× to the canvas showed square blocks and dotted trails
// (measured). GrowthRD hands the result to GROWTH_RD_VIEW as its state, so
// the view — colour, Relief, Details — reads a smooth field at one tap per
// sample. B-spline inside the view instead cost ~7 ms/frame at 1640 wide, and
// one bilinear tap for Relief showed the grid as facets at Size 70 (measured).
export const GROWTH_UPSAMPLE = /* glsl */ `
  uniform sampler2D uSrc;    // linear-filterable copy of the state
  uniform vec2      uGrid;   // its size, texels
  varying vec2 vUv;
  void main() {
    vec2 st = vUv * uGrid - 0.5;
    vec2 i  = floor(st);
    vec2 f  = st - i;
    vec2 f2 = f * f, f3 = f2 * f;
    vec2 w0 = (1.0 - 3.0 * f + 3.0 * f2 - f3) / 6.0;
    vec2 w1 = (4.0 - 6.0 * f2 + 3.0 * f3) / 6.0;
    vec2 w2 = (1.0 + 3.0 * f + 3.0 * f2 - 3.0 * f3) / 6.0;
    vec2 w3 = f3 / 6.0;
    vec2 s0 = w0 + w1, s1 = w2 + w3;
    vec2 c0 = (i - 0.5 + w1 / s0) / uGrid;
    vec2 c1 = (i + 1.5 + w3 / s1) / uGrid;
    gl_FragColor = s0.y * (s0.x * texture2D(uSrc, vec2(c0.x, c0.y)) + s1.x * texture2D(uSrc, vec2(c1.x, c0.y)))
                 + s1.y * (s0.x * texture2D(uSrc, vec2(c0.x, c1.y)) + s1.x * texture2D(uSrc, vec2(c1.x, c1.y)));
  }
`;

export const GROWTH_RD_VIEW = /* glsl */ `
  uniform sampler2D uState;
  uniform vec2  uTexel;
  uniform float uHue;       // 0–1
  uniform float uSat;       // 0–1
  uniform float uSpread;    // 0–1, hue travel across the concentration
  uniform float uColonies;  // 0–1, per-colony hue swing (lineage stamp)
  uniform float uContrast;
  uniform float uMode;      // 0 = Gray-Scott, 1 = multi-scale, 2 = crystal
  uniform float uNow;       // lineage clock
  uniform float uGrowTime;  // 0 = no fade
  uniform float uFadeTime;
  uniform float uPenRate;   // Pen fade (see GROWTH_RD_STEP)
  uniform float uRings;     // Frost: growth-ring strength, 0 = off
  uniform float uRingGap;   // Frost: seconds of growth between rings
  uniform float uLines;     // Details, first half: strength of the 1-px lines
  uniform float uFill;      // Details, second half: 1 = full fill … 0 = pure line art
  uniform float uRelief;    // 0 = flat; height-map depth
  uniform vec3  uLight;     // unit vector toward the light (z = out of screen)
  uniform float uGloss;     // 0–1 specular
  uniform float uGround;    // 0–1 brightness of the low areas
  uniform float uBevel;     // texels the relief gradient spans (1–6)

  varying vec2 vUv;

  vec3 hsv2rgb(vec3 c) {
    vec3 p = abs(fract(c.xxx + vec3(1.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0);
    return c.z * mix(vec3(1.0), clamp(p - 1.0, 0.0, 1.0), c.y);
  }

  // Engines: 0 Gray-Scott, 1 multi-scale, 2 crystal, 3 hyphae. Exact tests —
  // "uMode > 1.5" meant crystal while there were three, and would silently
  // have claimed hyphae too.
  #define IS_CRYSTAL (abs(uMode - 2.0) < 0.5)
  #define IS_HYPHAE  (uMode > 2.5)

  // ONE definition of what each mode shows, 0–1. Colour and relief both read
  // it, so the lit surface is exactly the shape you see, not a second guess.
  float heightOf(vec4 st) {
    if (uMode < 0.5) return clamp((st.g - 0.08) * uContrast, 0.0, 1.0);            // B
    if (IS_HYPHAE)   return st.r > 0.5 ? 1.0 : 0.0;                                 // a thread
    if (IS_CRYSTAL)  return clamp(0.5 + (st.r - 0.5) * uContrast * 0.5, 0.0, 1.0); // p
    return clamp(0.5 + 0.5 * st.r * uContrast * 0.5, 0.0, 1.0);                    // v
  }

  // The surface relief lights: the RAW field, not heightOf(). heightOf() is
  // contrast-clamped — plateaus with one-texel cliffs — and lighting it drew
  // hairline outlines, not relief (measured). The raw fields are smooth domes
  // (a Gray-Scott stripe peaks mid-stripe; the crystal interface is a ramp).
  float surf(vec2 uv) {
    vec4 st = texture2D(uState, uv);
    if (uMode < 0.5) return st.g / 0.4;
    if (IS_HYPHAE) return st.r > 0.5 ? 1.0 : 0.0;
    if (IS_CRYSTAL) {
      // Rings as engraved grooves: a narrow cos² profile per ring. Its width
      // scales with the gap, not the pixel, which suits relief — a groove
      // should be a groove at any zoom.
      float g = uRings > 0.0 && st.r > 0.5 ? pow(0.5 + 0.5 * cos(6.2831853 * st.b / uRingGap), 12.0) : 0.0;
      return st.r - 0.12 * uRings * g;
    }
    return 0.5 + 0.5 * st.r;
  }

  void main() {
    vec4 st = texture2D(uState, vUv);
    float v = heightOf(st);
    float hue;
    float val = v;
    float sat = uSat;
    if (uMode < 0.5) {
      hue = uHue + uSpread * (1.0 - v);
    } else if (IS_HYPHAE) {
      // Colour by age: fresh tips and young threads at Colour, older ones
      // walk along HueSpread — the history of the growth, readable.
      hue = uHue + uSpread * clamp(st.b / 10.0, 0.0, 1.0);
      // …and fade a little as they age (owner): brightness toward 60% and
      // saturation toward 70%, easing over ~20 s, so fresh tips stand out.
      float fade = exp(-st.b / 20.0);
      val *= 0.6 + 0.4 * fade;
      sat *= 0.7 + 0.3 * fade;
    } else if (IS_CRYSTAL) {
      // Crystal: the latent-heat halo a faint glow round the solid; hue walks
      // with temperature, so growing tips read warm.
      float T = clamp(st.g, 0.0, 1.0);
      val = max(v, 0.3 * T * (1.0 - st.r));
      hue = uHue + uSpread * T;
    } else {
      // Hue walks with the scale that has been winning here (g, 0 finest …
      // 1 coarsest), so each nesting level can read as its own colour.
      hue = uHue + uSpread * st.g;
    }
    // Colonies: a hue per lineage. The stamp is the planting time in seconds,
    // so a random value per second, eased between seconds: a spore gets one
    // colour, a stroke (stamped all along its length) drifts smoothly instead
    // of breaking into confetti. Hoskins' hash — the stamp is small, but see
    // LEARNED 2026-09-25 on fract(sin). Multi-scale writes no lineage.
    if (uColonies > 0.0 && uMode != 1.0 && st.a > 0.0) {
      float i = floor(st.a), f = fract(st.a);
      vec2 p = fract(vec2(i, i + 1.0) * 0.1031);
      p *= p + 33.33;
      p *= p + p;
      hue += uColonies * (mix(fract(p.x), fract(p.y), f * f * (3.0 - 2.0 * f)) - 0.5);
    }
    // Ground: the low areas as a surface rather than a hole.
    val = uGround + (1.0 - uGround) * val;
    vec3 col = hsv2rgb(vec3(fract(hue), sat, val));

    float ringLine = 0.0;   // Frost ring coverage, reused by the Lines view

    // ── Frost growth rings ──────────────────────────────────────────────────
    // b holds how long each solid cell has been solid, so a line wherever it
    // crosses a multiple of Ring gap is a growth ring: where the front stood
    // that long ago. Every cell keeps ageing, so the rings drift outward on
    // their own and new ones rise from the oldest centre. Kept ~1 px thin at
    // any spacing: distance to the ring in TEXELS = phase distance ÷ the age
    // gradient, taken from the neighbours (no derivative functions here).
    if (IS_CRYSTAL && uRings > 0.0 && st.r > 0.5) {
      float ax = texture2D(uState, vUv + vec2(uTexel.x, 0.0)).b - texture2D(uState, vUv - vec2(uTexel.x, 0.0)).b;
      float ay = texture2D(uState, vUv + vec2(0.0, uTexel.y)).b - texture2D(uState, vUv - vec2(0.0, uTexel.y)).b;
      float grad = 0.5 * length(vec2(ax, ay)) / uRingGap;             // rings per texel
      float ph   = abs(fract(st.b / uRingGap + 0.5) - 0.5);            // 0 on a ring
      float line = 1.0 - smoothstep(0.5, 1.5, ph / max(grad, 1e-4));   // ~1 px wide
      // Where age barely changes across a texel (the oldest core, or a flat
      // plateau) the ring would smear into a band: fade it out there.
      line *= smoothstep(0.004, 0.02, grad);
      col = mix(col, col * 0.35, line * uRings);
      ringLine = line * uRings;
    }

    // ── Relief: the surface lit ─────────────────────────────────────────────
    // Sobel gradient of surf() over ±Bevel texels — rounded bevels, not the
    // hairlines a 1-texel difference draws; wider = broader domes — a light
    // from Light angle at 40°
    // elevation, Lambert normalised so a flat area keeps its colour exactly
    // (a slope toward the light brightens, away darkens), plus a Blinn
    // highlight for a wet, waxy sheen.
    if (uRelief > 0.0) {
      vec2 e = uBevel * uTexel;
      float tl = surf(vUv + vec2(-e.x,  e.y)), tc = surf(vUv + vec2(0.0,  e.y)), tr = surf(vUv + vec2(e.x,  e.y));
      float ml = surf(vUv + vec2(-e.x, 0.0)),                                   mr = surf(vUv + vec2(e.x, 0.0));
      float bl = surf(vUv + vec2(-e.x, -e.y)), bc = surf(vUv + vec2(0.0, -e.y)), br = surf(vUv + vec2(e.x, -e.y));
      float gx = ((tr + 2.0 * mr + br) - (tl + 2.0 * ml + bl)) / (8.0 * uBevel);   // per texel
      float gy = ((tl + 2.0 * tc + tr) - (bl + 2.0 * bc + br)) / (8.0 * uBevel);
      vec3 n = normalize(vec3(-gx * uRelief, -gy * uRelief, 1.0));
      // Cavity: a point below the mean of its ring sits in a hollow — a cell
      // floor beside its walls — and darkens, so cells read deep, not flat.
      float ring = (tl + tc + tr + ml + mr + bl + bc + br) / 8.0;
      float cav  = 1.0 - clamp((ring - surf(vUv)) * uRelief * 0.12, 0.0, 0.65);
      const float AMB = 0.3;
      float flatShade = AMB + (1.0 - AMB) * uLight.z;
      float shade = (AMB + (1.0 - AMB) * max(dot(n, uLight), 0.0)) / flatShade;
      vec3 hv = normalize(uLight + vec3(0.0, 0.0, 1.0));
      // Exponent 16, not 48: at 48 the highlight was a pin-prick only steep
      // slopes facing the half-vector ever hit, and Gloss 20 → 90 changed the
      // picture by 1–2/255 in every mode (measured).
      float spec = pow(max(dot(n, hv), 0.0), 16.0) * uGloss * 1.5;
      col = col * shade * cav + vec3(spec) * (0.25 + 0.75 * v);
    }

    // ── Details: 1-px lines over the growth, then line art alone ────────────
    // The outline — the ½ contour of the same raw surface Relief lights —
    // kept one grid texel wide at any slope, as the rings are: height
    // distance to the contour ÷ the height gradient per texel. Flat ground
    // has no gradient and no contour, so it is faded out there rather than
    // smeared. Frost's rings join the lines. One knob: the first half draws
    // the lines over the growth, the second fades the fill away until only
    // the line art is left, on the Ground colour.
    // One contour, not several: a Levels control was built and measured —
    // these fields are steep cliffs, so extra contours either merged into a
    // fill or, spaced apart, were faded to nearly nothing. A dead control.
    if (uLines > 0.0) {
      float hc = surf(vUv);
      float gx = surf(vUv + vec2(uTexel.x, 0.0)) - surf(vUv - vec2(uTexel.x, 0.0));
      float gy = surf(vUv + vec2(0.0, uTexel.y)) - surf(vUv - vec2(0.0, uTexel.y));
      float gr = 0.5 * length(vec2(gx, gy));                           // height per texel
      float ln = (1.0 - smoothstep(0.5, 1.5, abs(hc - 0.5) / max(gr, 1e-4))) * smoothstep(0.002, 0.01, gr);
      ln = max(ln, ringLine);
      vec3 ink  = hsv2rgb(vec3(fract(hue), uSat * 0.5, 1.0));
      vec3 over = mix(col, ink, ln * uLines);
      vec3 art  = mix(hsv2rgb(vec3(fract(hue), uSat, uGround)), ink, ln);
      col = mix(art, over, uFill);
    }

    // A colony past its Grow time fades out over Fade time (lineage in alpha;
    // multi-scale has none, and writes 1 there).
    if (uGrowTime > 0.0 && uMode != 1.0 && st.a > 0.0) {
      col *= 1.0 - clamp((uNow - st.a - uGrowTime) / max(uFadeTime, 1e-3), 0.0, 1.0);
    }
    if (uPenRate > 0.0 && uMode != 1.0 && st.a > 0.0) col *= exp(-uPenRate * (uNow - st.a));
    gl_FragColor = vec4(col, 1.0);
  }
`;

// ── Growth: crystals — phase-field dendritic solidification (Kobayashi 1993) ──
// How ice and snowflakes grow. p is the phase (0 liquid … 1 solid), T the
// temperature (0 = undercooled melt, 1 = melting point). Solidifying releases
// latent heat (K), which slows the front where it is crowded; tips reaching
// into cold liquid grow fastest, and a small noise term splits them into
// side branches — fractal dendrites. The interface energy ε varies with the
// front's angle as 1 + δ·cos(j(θ − θ0)): j-fold symmetry (4 square, 6 snow).
// State: r = p, g = T, b = age, a = lineage stamp. Two passes per step: the
// anisotropic terms differentiate products of ε and ∇p, so ε at the
// neighbours is needed — the first pass writes it, the second uses it.
// Constants are Kobayashi's own (dx 0.03, dt 1e-4, τ 3e-4, ε̄ 0.01, α 0.9,
// γ 10); K, δ, j, θ0 and the noise are the performable ones.

export const GROWTH_CR_AUX = /* glsl */ `
  uniform sampler2D uState;
  uniform vec2      uTexel;
  uniform float     uAniso;     // δ
  uniform float     uFold;      // j
  uniform float     uAngle;     // θ0, radians
  uniform float     uDX;        // grid spacing — Size: smaller = bigger crystal in pixels
  varying vec2 vUv;
  #define DX uDX
  const float EB = 0.01;
  void main() {
    float pxp = texture2D(uState, vUv + vec2(uTexel.x, 0.0)).r;
    float pxm = texture2D(uState, vUv - vec2(uTexel.x, 0.0)).r;
    float pyp = texture2D(uState, vUv + vec2(0.0, uTexel.y)).r;
    float pym = texture2D(uState, vUv - vec2(0.0, uTexel.y)).r;
    float px = (pxp - pxm) / (2.0 * DX);
    float py = (pyp - pym) / (2.0 * DX);
    float th  = atan(py, px + 1e-12);
    float eps  = EB * (1.0 + uAniso * cos(uFold * (th - uAngle)));
    float deps = -EB * uFold * uAniso * sin(uFold * (th - uAngle));
    gl_FragColor = vec4(eps * deps * px, eps * deps * py, eps * eps, 1.0);
  }
`;

export const GROWTH_CR_STEP = /* glsl */ `
${GROWTH_VAR_GLSL}
  uniform sampler2D uState;
  uniform sampler2D uAux;
  uniform vec2      uTexel;
  uniform float     uHeat;      // K, latent heat
  uniform float     uNoise;     // side-branch noise amplitude
  uniform float     uSeedRand;  // per-step random offset
  uniform sampler2D uSeed;
  uniform float     uSeedAmt;
  uniform sampler2D uSeedPrev;
  uniform vec3      uPoint;     // spore: xy uv, z radius in texels
  uniform float     uNow;       // lineage clock
  uniform float     uGrowTime;  // see GROWTH_RD_STEP
  uniform float     uFadeTime;
  uniform float     uPenRate;   // Pen fade (see GROWTH_RD_STEP)
  uniform float     uAgeDt;
  uniform sampler2D uField;
  uniform float     uFieldAmt;  // field lowers the melt's temperature locally
  uniform float     uDX;        // grid spacing (see GROWTH_CR_AUX)
  varying vec2 vUv;
  #define DX uDX
  const float DT = 1e-4, TAU = 3e-4, ALPHA = 0.9, GAMMA = 10.0, TEQ = 1.0;
  const float PI = 3.14159265;

  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7)) + uSeedRand) * 43758.5453); }

  void main() {
    vec4 c  = texture2D(uState, vUv);
    vec4 xp = texture2D(uState, vUv + vec2(uTexel.x, 0.0));
    vec4 xm = texture2D(uState, vUv - vec2(uTexel.x, 0.0));
    vec4 yp = texture2D(uState, vUv + vec2(0.0, uTexel.y));
    vec4 ym = texture2D(uState, vUv - vec2(0.0, uTexel.y));
    vec4 a0  = texture2D(uAux, vUv);
    vec4 axp = texture2D(uAux, vUv + vec2(uTexel.x, 0.0));
    vec4 axm = texture2D(uAux, vUv - vec2(uTexel.x, 0.0));
    vec4 ayp = texture2D(uAux, vUv + vec2(0.0, uTexel.y));
    vec4 aym = texture2D(uAux, vUv - vec2(0.0, uTexel.y));

    float p = c.r, T = c.g;
    // 9-point isotropic Laplacian. The 5-point one prefers the grid's axes
    // strongly enough to swamp a 6-fold anisotropy — a "snowflake" grew as a
    // cross (measured). Weights: edges 4/6, corners 1/6, centre −20/6.
    vec2 d1 = texture2D(uState, vUv + uTexel).rg;
    vec2 d2 = texture2D(uState, vUv - uTexel).rg;
    vec2 d3 = texture2D(uState, vUv + vec2(uTexel.x, -uTexel.y)).rg;
    vec2 d4 = texture2D(uState, vUv + vec2(-uTexel.x, uTexel.y)).rg;
    vec2 edges = xp.rg + xm.rg + yp.rg + ym.rg;
    vec2 lap   = (4.0 * edges + (d1 + d2 + d3 + d4) - 20.0 * c.rg) / (6.0 * DX * DX);
    float lapP = lap.x;
    float lapT = lap.y;
    float px = (xp.r - xm.r) / (2.0 * DX);
    float py = (yp.r - ym.r) / (2.0 * DX);

    float term1 =  (ayp.x - aym.x) / (2.0 * DX);          // ∂/∂y(εε′ ∂p/∂x)
    float term2 = -(axp.y - axm.y) / (2.0 * DX);          // −∂/∂x(εε′ ∂p/∂y)
    vec2  gE2   = vec2(axp.z - axm.z, ayp.z - aym.z) / (2.0 * DX);
    float term3 = a0.z * lapP + dot(gE2, vec2(px, py));  // ∇·(ε²∇p)

    float Tl = T;
    if (uFieldAmt > 0.0) Tl -= uFieldAmt * 0.5 * dot(texture2D(uField, vUv).rgb, vec3(0.299, 0.587, 0.114));
    float m  = ALPHA / PI * atan(GAMMA * (TEQ - Tl));
    // Edge: less undercooling toward the frame, and a little melt at it, so
    // tips slow and stop short instead of freezing against the border.
    float er = edgeRoom(vUv);
    m = m * er - 0.05 * (1.0 - er);
    float pp = p * (1.0 - p);
    float dp = DT / TAU * (term1 + term2 + term3 + pp * (p - 0.5 + m) + uNoise * pp * (hash(vUv) - 0.5));

    // Lineage travels through the whole INTERFACE, not just the solid: a
    // crystal front is a diffuse band several cells wide, and cells crossing
    // p 0.5 before any neighbour had done so inherited nothing — stamp 0, so
    // they never stopped, never faded, and regrew the crystal after its
    // reset (measured). Anything above 2% solid carries a stamp; an unstamped
    // cell entering the band takes its PARENT's (the neighbour with most p),
    // not the newest — see GROWTH_RD_STEP for why newest stopped everything.
    float parent = -1.0, pP = 0.02;
    if (xp.r > pP) { pP = xp.r; parent = xp.a; }
    if (xm.r > pP) { pP = xm.r; parent = xm.a; }
    if (yp.r > pP) { pP = yp.r; parent = yp.a; }
    if (ym.r > pP) { pP = ym.r; parent = ym.a; }
    float lin = (p > 0.02 && c.a > 0.0) ? c.a : parent;
    // Grow time (see GROWTH_RD_STEP): past it, this part may no longer
    // solidify — melting and the heat field carry on.
    if (uGrowTime > 0.0 && lin > 0.0 && uNow - lin > uGrowTime) dp = min(dp, 0.0);

    float pn = clamp(p + dp, 0.0, 1.0);
    // Variation: latent heat raised by up to 50% by region — thinner,
    // branchier arms there. UP only: ±40% let low-heat regions fill solid.
    float Tn = T + DT * lapT + uHeat * (1.0 + 0.5 * uVar * (0.5 + 0.5 * growthVar(vUv))) * (pn - p);

    float age = c.b, stamp = c.a;
    // During Fade time the crystal MELTS: a linear decrement that takes full
    // solid to melt in exactly Fade time, so thin arms go first and the
    // picture keeps moving as it fades.
    if (uGrowTime > 0.0 && stamp > 0.0 && uNow - stamp > uGrowTime) pn = max(0.0, pn - uAgeDt / max(uFadeTime, 1e-3));
    // Pen fade: solid capped at twice the remaining brightness, so the
    // crystal melts through the second half of its decay, thin arms first.
    float penKeep = (uPenRate > 0.0 && stamp > 0.0) ? exp(-uPenRate * (uNow - stamp)) : 1.0;
    pn = min(pn, 2.0 * penKeep);
    // Entering the interface unstamped: inherit the parent's lineage. Melt
    // carries none, so a cell that melts and later re-solidifies is re-parented.
    if (pn > 0.02 && stamp <= 0.0) stamp = parent;
    if (pn <= 0.02) stamp = 0.0;
    age = pn > 0.5 ? age + uAgeDt : 0.0;
    if ((uGrowTime > 0.0 && stamp > 0.0 && uNow - stamp > uGrowTime + uFadeTime) || penKeep < 1.0 / 255.0) {
      pn = 0.0; age = 0.0; stamp = 0.0;          // faded out: back to melt
    }

    if (uSeedAmt > 0.0) {
      float s = clamp(dot(texture2D(uSeed, vUv).rgb, vec3(0.299, 0.587, 0.114)) * uSeedAmt, 0.0, 1.0);
      s = smoothstep(0.05, 0.3, s);
      if (s > 0.0) pn = max(pn, s);
      // Once when first seeded, and again whenever the stroke ARRIVES (a rise
      // since last frame) — see GROWTH_RD_STEP.
      float sp = smoothstep(0.05, 0.3, clamp(dot(texture2D(uSeedPrev, vUv).rgb, vec3(0.299, 0.587, 0.114)) * uSeedAmt, 0.0, 1.0));
      if (s > 0.0 && (c.a <= 0.0 || s - sp > 0.1)) stamp = uNow;   // any acting seed stamps
    }
    if (uPoint.z > 0.0) {
      vec2 d = (vUv - uPoint.xy) / uTexel;
      if (dot(d, d) < uPoint.z * uPoint.z) { pn = 1.0; stamp = uNow; age = 0.0; }
    }
    gl_FragColor = vec4(pn, Tn, age, stamp);
  }
`;

// Gray-Scott starts as pure food (A 1, B 0); multi-scale as uniform −1, which
// is exactly stable (every blur equals every other), so nothing happens until
// something is seeded.
export const GROWTH_RD_INIT = /* glsl */ `
  uniform vec4 uInit;
  void main() { gl_FragColor = uInit; }
`;

// ── Growth: hyphae — branching threads exactly one pixel wide ─────────────────
// A cell is empty (r 0), a thread (r 1, g −1) or a growing tip (r 1, g =
// heading in turns, 0…1). b = age, a = lineage stamp, as in the other
// engines. An empty cell becomes a tip only when its ONLY occupied neighbour
// (of eight) is a tip pointing at it — the direction nearest the tip's
// heading — so a thread can never thicken past one pixel and threads keep
// clear of each other, as real hyphae do. A tip retires once its child
// exists; forks come only from the side rule, rare per step so that they
// are spaced along the thread. Headings bend along the
// drifting Variation field (neighbouring threads flow together) and wander.
export const GROWTH_HY_STEP = /* glsl */ `
${GROWTH_VAR_GLSL}
  uniform sampler2D uState;
  uniform vec2      uTexel;
  uniform float     uNow;
  uniform float     uAgeDt;
  uniform float     uSeedRand;
  uniform float     uGrowP;     // chance a tip advances this step
  uniform float     uWander;    // how much headings bend
  uniform float     uBranch;    // 0–1 how often threads fork
  uniform sampler2D uSeed;
  uniform sampler2D uSeedPrev;
  uniform float     uSeedAmt;
  uniform vec3      uPoint;     // spore: xy uv, z radius in texels
  uniform float     uGrowTime;
  uniform float     uFadeTime;
  uniform float     uPenRate;
  varying vec2 vUv;
  const float TWO_PI = 6.2831853, PI = 3.14159265;

  // Hoskins' hash12 — not fract(sin(dot)·43758): on pixel coordinates up to
  // ~1000 the sine argument reaches ~4e5, where float32 leaves too few bits
  // for sin() to scatter, and "rare" tests pass far too often.
  float hsh(vec2 p, float k) {
    vec3 p3 = fract(vec3(p.xyx + vec3(uSeedRand * k * 0.37, uSeedRand * k * 0.71, uSeedRand * k * 0.13)) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }
  vec2 dir8(int j) {
    if (j == 0) return vec2( 1.0,  0.0); if (j == 1) return vec2( 1.0,  1.0);
    if (j == 2) return vec2( 0.0,  1.0); if (j == 3) return vec2(-1.0,  1.0);
    if (j == 4) return vec2(-1.0,  0.0); if (j == 5) return vec2(-1.0, -1.0);
    if (j == 6) return vec2( 0.0, -1.0); return vec2( 1.0, -1.0);
  }
  // Past Grow time (or faded to 30% under Pen) a lineage stops growing …
  bool stopped(float st) {
    if (st <= 0.0) return false;
    if (uGrowTime > 0.0 && uNow - st > uGrowTime) return true;
    return uPenRate > 0.0 && exp(-uPenRate * (uNow - st)) < 0.3;
  }
  // … and once fully faded it is cleared.
  bool gone(float st) {
    if (st <= 0.0) return false;
    if (uGrowTime > 0.0 && uNow - st > uGrowTime + uFadeTime) return true;
    return uPenRate > 0.0 && exp(-uPenRate * (uNow - st)) < 1.0 / 255.0;
  }

  void main() {
    vec4 c  = texture2D(uState, vUv);
    vec2 px = floor(vUv / uTexel);
    vec4 o  = c;
    if (c.r > 0.5) {
      o.b = c.b + uAgeDt;
      if (c.g >= 0.0) {
        bool child = false;
        for (int j = 0; j < 8; j++) {
          vec4 n = texture2D(uState, vUv + dir8(j) * uTexel);
          if (n.r > 0.5 && n.g >= 0.0 && n.b < c.b) child = true;
        }
        // Grown on: now a thread. Always — letting a share of parents stay
        // tips (the first cut) doubled the tip count every few steps and
        // packed a 1024 grid solid in 3 s (measured: 41 000 tips).
        if (child) o.g = -1.0;
        if (c.b > 3.0) o.g = -1.0;                            // stuck tips give up
      }
      if (gone(c.a)) o = vec4(0.0);
    } else {
      int count = 0; vec4 par = vec4(0.0); vec2 pd = vec2(0.0);
      for (int j = 0; j < 8; j++) {
        vec4 n = texture2D(uState, vUv + dir8(j) * uTexel);
        if (n.r > 0.5) { count++; par = n; pd = -dir8(j); }
      }
      if (count == 1 && par.g >= 0.0 && !stopped(par.a)) {
        float h    = par.g * TWO_PI;
        float ad   = atan(pd.y, pd.x);
        float diff = abs(mod(ad - h + PI, TWO_PI) - PI);
        bool ahead = diff <= 0.3927 + 1e-3;                            // nearest of 8
        // A fork. Per step AND per candidate cell, so it must be tiny: at
        // 0.014 each tip forked ~10×/s. Now ~every 250 px at 35, ~90 at 100.
        // Edge: tips advance and fork less toward the frame, so threads thin
        // out and stop short of it.
        float er   = edgeRoom(vUv);
        bool side  = diff <= 1.1781 && hsh(px, 2.0) < uBranch * 0.004 * er;
        if ((ahead && hsh(px, 3.0) < uGrowP * er) || side) {
          float phi = gvField(vUv) * PI;                   // the flow the threads follow
          // A light pull toward the flow and a strong random wander: at 0.12 /
          // 0.3 every thread lined up into parallel 45° bundles — circuit
          // traces, not hyphae (measured by eye on GPU renders).
          float nh  = (ahead ? h : ad) + uWander * (0.04 * sin(phi - h) + 0.6 * (hsh(px, 4.0) - 0.5));
          o = vec4(1.0, fract(nh / TWO_PI), 0.0, par.a);
        }
      }
    }

    // Seeds. A stroke is a solid band, and any cell beside a band touches
    // several occupied cells — so a stroke marked occupied could never sprout.
    // It seeds SPARSE isolated tips instead, only where it has just arrived.
    if (uSeedAmt > 0.0 && c.r < 0.5) {
      float s  = smoothstep(0.05, 0.3, clamp(dot(texture2D(uSeed, vUv).rgb, vec3(0.299, 0.587, 0.114)) * uSeedAmt, 0.0, 1.0));
      float sp = smoothstep(0.05, 0.3, clamp(dot(texture2D(uSeedPrev, vUv).rgb, vec3(0.299, 0.587, 0.114)) * uSeedAmt, 0.0, 1.0));
      if (s - sp > 0.1 && hsh(px, 5.0) < 0.004) o = vec4(1.0, hsh(px, 6.0), 0.0, uNow);
    }
    // A spore: eight tips on a small ring, pointing outward, never adjacent
    // to each other (2+ texels apart), so each can grow.
    if (uPoint.z > 0.0) {
      vec2 d = floor(vUv / uTexel) - floor(uPoint.xy / uTexel);
      float R = max(2.0, floor(uPoint.z / 3.0));
      bool spoke = (d.x == 0.0 || d.y == 0.0 || abs(d.x) == abs(d.y)) && max(abs(d.x), abs(d.y)) == R;
      if (spoke) o = vec4(1.0, fract(atan(d.y, d.x) / TWO_PI), 0.0, uNow);
    }
    gl_FragColor = o;
  }
`;

// ── Growth: multi-scale Turing patterns (J. McCabe, 2010) ─────────────────────
// Several activator/inhibitor pairs at doubling radii run at once; at each
// pixel the scale whose activator and inhibitor differ LEAST wins and moves
// the value toward its winning side. Coarse scales take bigger steps, so large
// structures form first and finer ones grow inside them: patterns made of
// patterns. The blurs come from a pyramid (each level half the last), sampled
// with a cubic B-spline so coarse levels do not show their texel grid.

// One pyramid level from the one below: four bilinear taps. uOff is 1.0 for a
// linear-filtered source (each tap a 2×2 average → a 4×4 tent) and 0.5 for the
// nearest-filtered float state (taps on texel centres → exact 2×2 box).
export const GROWTH_MS_DOWN = /* glsl */ `
  uniform sampler2D uSrc;
  uniform vec2      uSrcTexel;
  uniform float     uOff;
  varying vec2 vUv;
  void main() {
    vec2 o = uSrcTexel * uOff;
    float v = texture2D(uSrc, vUv + vec2(-o.x, -o.y)).r + texture2D(uSrc, vUv + vec2(o.x, -o.y)).r
            + texture2D(uSrc, vUv + vec2(-o.x,  o.y)).r + texture2D(uSrc, vUv + vec2(o.x,  o.y)).r;
    gl_FragColor = vec4(v * 0.25, 0.0, 0.0, 1.0);
  }
`;

export const GROWTH_MS_STEP = /* glsl */ `
${GROWTH_VAR_GLSL}
  uniform sampler2D uState;
  uniform sampler2D uL1;
  uniform sampler2D uL2;
  uniform sampler2D uL3;
  uniform sampler2D uL4;
  uniform sampler2D uL5;
  uniform sampler2D uL6;
  uniform vec2      uS1;  uniform vec2 uS2;  uniform vec2 uS3;
  uniform vec2      uS4;  uniform vec2 uS5;  uniform vec2 uS6;   // level sizes, texels
  uniform vec2      uTexel;
  uniform float     uStep;      // overall step multiplier
  uniform float     uFine;      // lowest scale index in play (0–4)
  uniform float     uCoarse;    // highest scale index in play (0–4)
  uniform float     uBias;      // −1 favour fine … +1 favour coarse
  uniform sampler2D uField;
  uniform float     uFieldAmt;  // field shifts the bias per pixel
  uniform sampler2D uSeed;
  uniform float     uSeedAmt;
  uniform vec3      uPoint;     // spore: xy uv, z radius in texels (0 = none)

  varying vec2 vUv;

  // Cubic B-spline from four bilinear taps (Sigg & Hadwiger, GPU Gems 2 ch.20).
  float bspline(sampler2D t, vec2 size, vec2 uv) {
    vec2 st = uv * size - 0.5;
    vec2 i  = floor(st);
    vec2 f  = st - i;
    vec2 f2 = f * f, f3 = f2 * f;
    vec2 w0 = (1.0 - 3.0 * f + 3.0 * f2 - f3) / 6.0;
    vec2 w1 = (4.0 - 6.0 * f2 + 3.0 * f3) / 6.0;
    vec2 w2 = (1.0 + 3.0 * f + 3.0 * f2 - 3.0 * f3) / 6.0;
    vec2 w3 = f3 / 6.0;
    vec2 s0 = w0 + w1, s1 = w2 + w3;
    vec2 c0 = (i - 0.5 + w1 / s0) / size;
    vec2 c1 = (i + 1.5 + w3 / s1) / size;
    return s0.y * (s0.x * texture2D(t, vec2(c0.x, c0.y)).r + s1.x * texture2D(t, vec2(c1.x, c0.y)).r)
         + s1.y * (s0.x * texture2D(t, vec2(c0.x, c1.y)).r + s1.x * texture2D(t, vec2(c1.x, c1.y)).r);
  }

  void main() {
    vec4 st = texture2D(uState, vUv);
    float v = st.r;

    float L[6];
    L[0] = bspline(uL1, uS1, vUv);
    L[1] = bspline(uL2, uS2, vUv);
    L[2] = bspline(uL3, uS3, vUv);
    L[3] = bspline(uL4, uS4, vUv);
    L[4] = bspline(uL5, uS5, vUv);
    L[5] = bspline(uL6, uS6, vUv);

    float bias = uBias + 2.5 * uVar * growthVar(vUv);   // fine and coarse regions
    if (uFieldAmt > 0.0) {
      float fl = dot(texture2D(uField, vUv).rgb, vec3(0.299, 0.587, 0.114));
      bias += (fl * 2.0 - 1.0) * uFieldAmt * 2.0;
    }

    // Scale i: activator L[i], inhibitor L[i+1]. Smallest |difference| wins.
    float best = 1e9, dir = 0.0, amt = 0.0, win = 0.0;
    for (int i = 0; i < 5; i++) {
      float fi = float(i);
      if (fi < uFine - 0.5 || fi > uCoarse + 0.5) continue;
      float d = L[i] - L[i + 1];
      float var = abs(d);
      if (var < best) {
        best = var;
        // Dead band: the pyramid is half-float, so two "equal" blurs differ
        // by up to ~1e-4 of rounding. sign() of that is noise, and it
        // patterned an untouched grid edge to edge the moment its value sat
        // anywhere but exactly ±1. Real fronts differ by 0.01 and up.
        dir  = var > 2e-3 ? sign(d) : 0.0;
        // Coarser scales step further (0.01 … 0.05, McCabe's proportions);
        // bias tilts that ladder toward the fine or the coarse end.
        amt  = 0.01 * (fi + 1.0) * pow(2.0, bias * (fi - 2.0));
        win  = fi / 4.0;
      }
    }
    v = clamp(v + dir * amt * uStep, -1.0, 1.0);
    // Edge: a steady push toward empty (−1) near the frame.
    v = max(-1.0, v - 0.03 * uStep * (1.0 - edgeRoom(vUv)));

    // Which scale has been winning here, smoothed — the colour channel.
    float g = mix(st.g, win, 0.05);

    // Seeds push toward +1 and never pull down: max(), as in Gray-Scott.
    // Near-black does not seed: max(v, 2s − 1) turns ANY faint residue into a
    // floor across the whole grid (a 1/255 seed lifted every cell to −0.992),
    // which breaks the stillness this mode relies on. 5% knee, smooth ramp.
    if (uSeedAmt > 0.0) {
      float s = clamp(dot(texture2D(uSeed, vUv).rgb, vec3(0.299, 0.587, 0.114)) * uSeedAmt, 0.0, 1.0);
      s = smoothstep(0.05, 0.3, s);
      if (s > 0.0) v = max(v, s * 2.0 - 1.0);
    }
    if (uPoint.z > 0.0) {
      vec2 dd = (vUv - uPoint.xy) / uTexel;
      if (dot(dd, dd) < uPoint.z * uPoint.z) v = 1.0;
    }
    gl_FragColor = vec4(v, g, 0.0, 1.0);
  }
`;

// ── RGB Channel Delay ─────────────────────────────────────────────────────────
// Three frames of ONE delay ring, one colour channel taken from each. A moving
// edge separates into coloured fringes trailing its own past, because each
// channel is showing a different moment. Anything still is unaffected: where
// three frames agree, taking one channel from each reproduces the pixel exactly,
// which is why equal delays are a bit-exact identity rather than a near-miss.

export const RGB_DELAY = /* glsl */ `
  uniform sampler2D tR;
  uniform sampler2D tG;
  uniform sampler2D tB;

  varying vec2 vUv;

  void main() {
    gl_FragColor = vec4(
      texture2D(tR, vUv).r,
      texture2D(tG, vUv).g,
      texture2D(tB, vUv).b,
      1.0
    );
  }
`;

// ── Passthrough ───────────────────────────────────────────────────────────────

export const PASSTHROUGH = /* glsl */ `
  uniform sampler2D uTexture;
  varying vec2 vUv;
  void main() {
    gl_FragColor = texture2D(uTexture, vUv);
  }
`;

// ── Luminance keyer ───────────────────────────────────────────────────────────

export const KEYER = /* glsl */ `
  uniform sampler2D uFG;
  uniform sampler2D uBG;
  uniform sampler2D uEK;       // external key source (DS texture when extkey=1)
  uniform sampler2D uFGRaw;    // pre-color-correction FG source for raw keying
  uniform float uKeyWhite;
  uniform float uKeyBlack;
  uniform float uKeySoftness;
  uniform int   uKeyActive;
  uniform int   uAlpha;
  uniform int   uAlphaInvert;
  uniform int   uExtKey;       // 1 = key on uEK luminance instead of uFG
  uniform int   uAlphaEmissive; // 1 = bg*(1-a) + fg, for glows and other emitters
  uniform int   uRawKey;       // 1 = key on uFGRaw (pre-color-correction) luma

  varying vec2 vUv;

  float luma(vec3 c) {
    return dot(c, vec3(0.2126, 0.7152, 0.0722));
  }

  void main() {
    vec4 fg = texture2D(uFG, vUv);
    vec4 bg = texture2D(uBG, vUv);

    if (uKeyActive == 0) {
      gl_FragColor = fg;
      return;
    }

    float alpha;

    if (uAlpha == 1) {
      alpha = uAlphaInvert == 1 ? (1.0 - fg.a) : fg.a;
    } else {
      vec4 keySrc   = uExtKey == 1 ? texture2D(uEK, vUv)
                    : uRawKey == 1 ? texture2D(uFGRaw, vUv)
                    : fg;
      float lumaVal = luma(keySrc.rgb);
      float soft    = max(uKeySoftness, 0.001);
      // Pass band between black and white thresholds; soft edges on both
      float lo = smoothstep(uKeyBlack - soft, uKeyBlack + soft, lumaVal);
      float hi = 1.0 - smoothstep(uKeyWhite - soft, uKeyWhite + soft, lumaVal);
      alpha = lo * hi;
    }

    // EMISSIVE compositing, for sources whose partial coverage means "light
    // added here", not "this much of the pixel is me".
    //
    // mix(bg, fg, alpha) is correct for a matte: at half coverage you get half
    // the background, so whatever is behind shows THROUGH. For a glow that is
    // backwards — a glow does not occlude, it adds — and the background's dark
    // areas show through the aura and read as shadows in it.
    //
    // bg*(1-a) + fg attenuates the background by coverage and then adds the
    // source on top, so a bright aura over a dark patch stays bright. At a=1
    // the two forms are identical, so an opaque object is unaffected either way.
    //
    // The same branch is also the exactly-correct composite for a source whose
    // RGB is already PREMULTIPLIED — bg*(1-a) + fg IS "over" in premultiplied
    // form. The Text layer uploads premultiplied (TextLayer.js explains why:
    // TRANSFERMODE blends RGB only, so straight alpha put full-intensity colour
    // in every antialiased edge pixel and the glyphs came out hard-edged). So
    // for keyed text, Alpha Emissive ON is the mathematically exact path; with
    // it OFF, mix() attenuates those edges a second time and the antialiasing
    // reads slightly thin. Everything at a=1 — which is all of the glyph but
    // its outermost pixel — is identical either way.
    // OUTPUT ALPHA is the composite's own coverage, not the foreground's.
    // This branch used to emit fg.a, which was invisible for as long as every
    // foreground was opaque — fg.a was a constant 1, so "the fg's coverage" and
    // "the result's coverage" were the same number. The moment a source carries
    // real alpha (the 3D scene's Transparent BG), they diverge: outside the
    // object fg.a is 0, so the whole frame went transparent and the BACKGROUND
    // vanished, which is what it looks like — a black frame with only the
    // subject in it. The background is not being keyed out; the composite is
    // reporting that nothing is there.
    //
    // fg.a + bg.a*(1-fg.a) is "over" in premultiplied form, matching the RGB
    // line above it. Over an opaque background it is exactly 1, so nothing that
    // composited correctly before moves.
    gl_FragColor = uAlphaEmissive == 1
      ? vec4(bg.rgb * (1.0 - alpha) + fg.rgb, fg.a + bg.a * (1.0 - fg.a))
      : mix(bg, fg, alpha);
  }
`;

// ── Displacement ──────────────────────────────────────────────────────────────

export const DISPLACE = /* glsl */ `
  uniform sampler2D uFG;
  uniform sampler2D uDS;
  uniform float uAmount;
  uniform float uAngle;
  uniform float uOffset;
  uniform int   uRotateGrey;
  uniform int   uEdge;           // 0 Mirror  1 Wrap  2 Clamp  3 Black

  varying vec2 vUv;

  void main() {
    if (uAmount == 0.0) {
      gl_FragColor = texture2D(uFG, vUv);
      return;
    }

    vec4 ds = texture2D(uDS, vUv);
    float lumaVal = dot(ds.rgb, vec3(0.2126, 0.7152, 0.0722));
    float strength = (lumaVal + uOffset - 0.5) * uAmount * 0.1;

    vec2 offset;
    if (uRotateGrey == 1) {
      float theta = (lumaVal - 0.5) * 2.0 * 3.14159265;
      offset = vec2(cos(theta), sin(theta)) * uAmount * 0.05;
    } else {
      vec2 dir = vec2(cos(uAngle), sin(uAngle));
      offset = dir * strength;
    }

    // Edge — what a pixel pushed past the border shows. Something has to:
    // Mirror folds the picture back (default); Wrap re-enters from the far
    // side, invisible on a tiling source (Noise › Tile); Clamp repeats the
    // border row, which reads as streaks; Black shows nothing.
    vec2 uv = vUv + offset;
    if (uEdge == 0)      uv = 1.0 - abs(1.0 - mod(uv, 2.0));
    else if (uEdge == 1) uv = fract(uv);
    else if (uEdge == 3 && (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0)) {
      gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
      return;
    }
    gl_FragColor = texture2D(uFG, clamp(uv, 0.0, 1.0));
  }
`;

// ── Blend ─────────────────────────────────────────────────────────────────────

export const BLEND = /* glsl */ `
  uniform sampler2D uCurrent;
  uniform sampler2D uPrev;
  uniform int       uActive;
  uniform float     uAmount;

  varying vec2 vUv;

  void main() {
    vec4 curr = texture2D(uCurrent, vUv);
    if (uActive == 0) { gl_FragColor = curr; return; }
    vec4 prev = texture2D(uPrev, vUv);
    gl_FragColor = mix(curr, prev, uAmount);
  }
`;

// Clip crossfade — the outgoing and incoming clips of ONE movie deck during a
// ClipFade. Deliberately not the mixbus shader: this has no modes, no mask and
// no displacement, because a deck switching clips is a dissolve and nothing
// else, and borrowing a mode index from another feature is how the two drift.
export const CLIP_FADE = /* glsl */ `
  uniform sampler2D uFrom;
  uniform sampler2D uTo;
  uniform float     uMix;   // 0 = fully outgoing, 1 = fully incoming

  varying vec2 vUv;

  void main() {
    gl_FragColor = mix(texture2D(uFrom, vUv), texture2D(uTo, vUv), uMix);
  }
`;

// ── Feedback ──────────────────────────────────────────────────────────────────

// Edge behaviour for the feedback passes, shared so the offset pass and the
// rotate/zoom pass cannot drift apart. Clamp is the historical behaviour (the
// smear you get from ClampToEdge); the rest are chosen looks.
//   0 Clamp   1 Mirror   2 Wrap   3 Black
export const FEEDBACK_EDGE_GLSL = /* glsl */ `
  vec4 fbSample(sampler2D tex, vec2 uv, int mode) {
    if (mode == 1) {
      // Triangle wave with period 2 — ...0,1,0,1... so the frame reflects.
      vec2 t = abs(fract(uv * 0.5) * 2.0 - 1.0);
      return texture2D(tex, t);
    }
    if (mode == 2) return texture2D(tex, fract(uv));
    if (mode == 3) {
      // Opaque black, NOT vec4(0.0): the blend that consumes this frame carries
      // fg.a through to the output, so a transparent "black" edge punched a
      // fully transparent hole in the composite — which reads on screen as the
      // live picture disappearing on that side, not as a black border.
      if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return vec4(0.0, 0.0, 0.0, 1.0);
      return texture2D(tex, uv);
    }
    return texture2D(tex, clamp(uv, 0.0, 1.0));
  }
`;

export const FEEDBACK = /* glsl */ `
  uniform sampler2D uOutput;
  uniform float uHorOffset;
  uniform float uVerOffset;
  uniform float uScale;
  uniform vec2  uResolution;
  uniform float uDecay;    // 0..1 multiplier on the recirculated frame
  uniform float uBlur;     // 0..1, radius in texels via uResolution
  uniform float uHue;      // radians
  uniform int   uMirror;   // 0 off, 1 H, 2 V, 3 both
  uniform int   uEdge;

  varying vec2 vUv;

${FEEDBACK_EDGE_GLSL}

  // Hue rotation about the luma axis. Matrix form rather than an RGB→HSV round
  // trip: no branches, no atan, and it leaves greys exactly grey, which matters
  // when the result is fed back into itself a few hundred times.
  vec3 hueRotate(vec3 c, float a) {
    const vec3 k = vec3(0.57735026919);  // normalize(vec3(1.0))
    float ca = cos(a);
    return c * ca + cross(k, c) * sin(a) + k * dot(k, c) * (1.0 - ca);
  }

  void main() {
    vec2 uv = vUv;

    if (uMirror == 1 || uMirror == 3) uv.x = 1.0 - uv.x;
    if (uMirror == 2 || uMirror == 3) uv.y = 1.0 - uv.y;

    if (uScale != 0.0) {
      vec2 center = vec2(0.5);
      float s = 1.0 + uScale * 0.1;
      uv = (uv - center) / s + center;
    }
    uv.x += uHorOffset * 0.1;
    uv.y += uVerOffset * 0.1;

    vec4 col;
    if (uBlur > 0.0) {
      // 3×3 tent, one pass. Separable would be cheaper in the abstract, but a
      // second render target for a blur this small costs more than it saves —
      // and the radius is in texels, which is what uResolution is finally for.
      vec2 r = uBlur * 4.0 / max(uResolution, vec2(1.0));
      col  = fbSample(uOutput, uv, uEdge) * 4.0;
      col += fbSample(uOutput, uv + vec2( r.x, 0.0), uEdge) * 2.0;
      col += fbSample(uOutput, uv + vec2(-r.x, 0.0), uEdge) * 2.0;
      col += fbSample(uOutput, uv + vec2( 0.0, r.y), uEdge) * 2.0;
      col += fbSample(uOutput, uv + vec2( 0.0,-r.y), uEdge) * 2.0;
      col += fbSample(uOutput, uv + vec2( r.x, r.y), uEdge);
      col += fbSample(uOutput, uv + vec2( r.x,-r.y), uEdge);
      col += fbSample(uOutput, uv + vec2(-r.x, r.y), uEdge);
      col += fbSample(uOutput, uv + vec2(-r.x,-r.y), uEdge);
      col /= 16.0;
    } else {
      col = fbSample(uOutput, uv, uEdge);
    }

    if (uHue != 0.0) col.rgb = clamp(hueRotate(col.rgb, uHue), 0.0, 1.0);
    gl_FragColor = vec4(col.rgb * uDecay, col.a);
  }
`;

// ── Transfer modes ────────────────────────────────────────────────────────────

export const TRANSFERMODE = /* glsl */ `
  uniform sampler2D uFG;
  uniform sampler2D uBG;
  uniform int       uMode;
  uniform float     uBlendAmount;
  // 0 = two-stop opacity  (0 → BG, 1 → the blended result)
  // 1 = three-stop layers (0 → BG, 0.5 → blended, 1 → FG)
  //
  // Only the FG layer blend uses the three-stop curve. The BG self-process
  // passes the same texture as both uFG and uBG, so its "FG end" is just the
  // Background again and the curve would fold back on itself; the feedback
  // blend is a different instrument entirely and its saved amounts must keep
  // meaning what they meant. Like uBlendAmount, this MUST be set at every call
  // site — the material is shared, and _pass() only writes what it is given.
  uniform float     uCurve;

  varying vec2 vUv;

  vec3 blendMix(vec3 bgc, vec3 blended, vec3 fgc, float amt) {
    if (uCurve < 0.5) return mix(bgc, blended, amt);
    return amt < 0.5
      ? mix(bgc, blended, amt * 2.0)
      : mix(blended, fgc, (amt - 0.5) * 2.0);
  }

  // ── bitwise helpers ──────────────────────────────────────────────────────────
  ivec3 floatToInt8(vec3 c) { return ivec3(clamp(c * 255.0, 0.0, 255.0)); }
  vec3 int8ToFloat(ivec3 i)  { return vec3(i) / 255.0; }

  // ── photographic blend helpers ───────────────────────────────────────────────
  vec3 blendMultiply(vec3 a, vec3 b)   { return a * b; }
  vec3 blendScreen(vec3 a, vec3 b)     { return 1.0 - (1.0 - a) * (1.0 - b); }
  vec3 blendAdd(vec3 a, vec3 b)        { return min(a + b, 1.0); }
  vec3 blendDiff(vec3 a, vec3 b)       { return abs(a - b); }
  vec3 blendExclude(vec3 a, vec3 b)    { return a + b - 2.0 * a * b; }
  vec3 blendDodge(vec3 a, vec3 b)      { return min(a / max(1.0 - b, 0.001), 1.0); }
  vec3 blendBurn(vec3 a, vec3 b)       { return 1.0 - min((1.0 - a) / max(b, 0.001), 1.0); }

  float overlayF(float a, float b) {
    return b < 0.5 ? 2.0 * a * b : 1.0 - 2.0 * (1.0 - a) * (1.0 - b);
  }
  vec3 blendOverlay(vec3 a, vec3 b) {
    return vec3(overlayF(a.r,b.r), overlayF(a.g,b.g), overlayF(a.b,b.b));
  }

  float hardlightF(float a, float b) {
    return b < 0.5 ? 2.0 * a * b : 1.0 - 2.0 * (1.0 - a) * (1.0 - b);
  }
  vec3 blendHardlight(vec3 a, vec3 b) {
    // hardlight = overlay with layers swapped
    return vec3(hardlightF(b.r,a.r), hardlightF(b.g,a.g), hardlightF(b.b,a.b));
  }

  float softlightF(float a, float b) {
    if (b < 0.5) return a - (1.0 - 2.0*b) * a * (1.0 - a);
    float d = a < 0.25 ? ((16.0*a - 12.0)*a + 4.0)*a : sqrt(a);
    return a + (2.0*b - 1.0) * (d - a);
  }
  vec3 blendSoftlight(vec3 a, vec3 b) {
    return vec3(softlightF(a.r,b.r), softlightF(a.g,b.g), softlightF(a.b,b.b));
  }

  // ── HSL helpers (for hue/sat/luma blend modes) ───────────────────────────────
  vec3 rgb2hsl(vec3 c) {
    float cmax = max(c.r, max(c.g, c.b));
    float cmin = min(c.r, min(c.g, c.b));
    float d = cmax - cmin;
    float l = (cmax + cmin) * 0.5;
    float s = d < 0.0001 ? 0.0 : d / (1.0 - abs(2.0*l - 1.0));
    float h = 0.0;
    if (d > 0.0001) {
      if      (cmax == c.r) h = mod((c.g - c.b) / d, 6.0) / 6.0;
      else if (cmax == c.g) h = ((c.b - c.r) / d + 2.0) / 6.0;
      else                  h = ((c.r - c.g) / d + 4.0) / 6.0;
    }
    return vec3(h, s, l);
  }

  vec3 hsl2rgb(vec3 hsl) {
    float h = hsl.x, s = hsl.y, l = hsl.z;
    float c = (1.0 - abs(2.0*l - 1.0)) * s;
    float x = c * (1.0 - abs(mod(h * 6.0, 2.0) - 1.0));
    float m = l - c * 0.5;
    vec3 rgb;
    int hi = int(h * 6.0);
    if      (hi == 0) rgb = vec3(c, x, 0);
    else if (hi == 1) rgb = vec3(x, c, 0);
    else if (hi == 2) rgb = vec3(0, c, x);
    else if (hi == 3) rgb = vec3(0, x, c);
    else if (hi == 4) rgb = vec3(x, 0, c);
    else              rgb = vec3(c, 0, x);
    return rgb + m;
  }

  // ── HSY (hue/sat from FG, luma from BG or vice-versa) ───────────────────────
  vec3 blendHue(vec3 a, vec3 b) {          // FG hue, BG sat+luma
    vec3 ha = rgb2hsl(a);
    vec3 hb = rgb2hsl(b);
    return hsl2rgb(vec3(ha.x, hb.y, hb.z));
  }
  vec3 blendSaturation(vec3 a, vec3 b) {   // FG sat, BG hue+luma
    vec3 ha = rgb2hsl(a);
    vec3 hb = rgb2hsl(b);
    return hsl2rgb(vec3(hb.x, ha.y, hb.z));
  }
  vec3 blendColor(vec3 a, vec3 b) {        // FG hue+sat, BG luma
    vec3 ha = rgb2hsl(a);
    vec3 hb = rgb2hsl(b);
    return hsl2rgb(vec3(ha.x, ha.y, hb.z));
  }
  vec3 blendLuminosity(vec3 a, vec3 b) {   // FG luma, BG hue+sat
    vec3 ha = rgb2hsl(a);
    vec3 hb = rgb2hsl(b);
    return hsl2rgb(vec3(hb.x, hb.y, ha.z));
  }
  vec3 blendSubtract(vec3 a, vec3 b)    { return max(a - b, 0.0); }
  vec3 blendDivide(vec3 a, vec3 b)      { return min(a / max(b, 0.001), 1.0); }
  vec3 blendPinLight(vec3 a, vec3 b) {
    return vec3(
      b.r < 0.5 ? min(a.r, 2.0*b.r) : max(a.r, 2.0*b.r - 1.0),
      b.g < 0.5 ? min(a.g, 2.0*b.g) : max(a.g, 2.0*b.g - 1.0),
      b.b < 0.5 ? min(a.b, 2.0*b.b) : max(a.b, 2.0*b.b - 1.0)
    );
  }
  vec3 blendVividLight(vec3 a, vec3 b) {
    return vec3(
      b.r < 0.5 ? 1.0 - min((1.0-a.r)/max(2.0*b.r,0.001),1.0) : min(a.r/max(2.0*(1.0-b.r),0.001),1.0),
      b.g < 0.5 ? 1.0 - min((1.0-a.g)/max(2.0*b.g,0.001),1.0) : min(a.g/max(2.0*(1.0-b.g),0.001),1.0),
      b.b < 0.5 ? 1.0 - min((1.0-a.b)/max(2.0*b.b,0.001),1.0) : min(a.b/max(2.0*(1.0-b.b),0.001),1.0)
    );
  }

  void main() {
    vec4 fg = texture2D(uFG, vUv);
    vec4 bg = texture2D(uBG, vUv);
    vec3 a = fg.rgb;
    vec3 b = bg.rgb;
    vec3 r;

    // modes 0-3: bitwise
    if (uMode < 4) {
      if (uMode == 0) { gl_FragColor = fg; return; }
      ivec3 ia = floatToInt8(a);
      ivec3 ib = floatToInt8(b);
      ivec3 ir;
      if      (uMode == 1) ir = ia ^ ib;
      else if (uMode == 2) ir = ia | ib;
      else                 ir = ia & ib;
      // Mix toward b exactly as the photographic branch does. This used to
      // return here, so BlendAmount was live in the UI and dead in XOR, OR and
      // AND — three of twenty-one modes silently ignoring their own strength
      // control. uMode 0 (Copy) still returns fg untouched: it is the identity
      // pass, not a blend, and mixing it would turn Copy into a dissolve.
      gl_FragColor = vec4(blendMix(b, int8ToFloat(ir), a, uBlendAmount), fg.a);
      return;
    }

    // modes 4+: photographic
    if      (uMode ==  4) r = blendMultiply(a, b);
    else if (uMode ==  5) r = blendScreen(a, b);
    else if (uMode ==  6) r = blendAdd(a, b);
    else if (uMode ==  7) r = blendDiff(a, b);
    else if (uMode ==  8) r = blendExclude(a, b);
    else if (uMode ==  9) r = blendOverlay(a, b);
    else if (uMode == 10) r = blendHardlight(a, b);
    else if (uMode == 11) r = blendSoftlight(a, b);
    else if (uMode == 12) r = blendDodge(a, b);
    else if (uMode == 13) r = blendBurn(a, b);
    else if (uMode == 14) r = blendSubtract(a, b);
    else if (uMode == 15) r = blendDivide(a, b);
    else if (uMode == 16) r = blendPinLight(a, b);
    else if (uMode == 17) r = blendVividLight(a, b);
    else if (uMode == 18) r = blendHue(a, b);
    else if (uMode == 19) r = blendSaturation(a, b);
    else if (uMode == 20) r = blendColor(a, b);
    else if (uMode == 21) r = blendLuminosity(a, b);
    else r = a;

    vec3 blended = clamp(r, 0.0, 1.0);
    gl_FragColor = vec4(blendMix(b, blended, a, uBlendAmount), fg.a);
  }
`;

// ── Color Shift ───────────────────────────────────────────────────────────────

export const COLORSHIFT = /* glsl */ `
  uniform sampler2D uTexture;
  uniform float uShift;

  varying vec2 vUv;

  vec3 rgb2hsv(vec3 c) {
    vec4 K = vec4(0.0, -1.0/3.0, 2.0/3.0, -1.0);
    vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
    vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
    float d = q.x - min(q.w, q.y);
    float e = 1.0e-10;
    return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
  }

  vec3 hsv2rgb(vec3 c) {
    vec4 K = vec4(1.0, 2.0/3.0, 1.0/3.0, 3.0);
    vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
    return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
  }

  void main() {
    vec4 color = texture2D(uTexture, vUv);
    if (uShift == 0.0) { gl_FragColor = color; return; }
    vec3 hsv = rgb2hsv(color.rgb);
    hsv.x = fract(hsv.x + uShift);
    gl_FragColor = vec4(hsv2rgb(hsv), color.a);
  }
`;

// ── Noise generator — basis × fractal × warp × layer B × shaping ─────────────
// One field, built in stages that every type shares instead of one entry per
// combination (the old 41-entry list held three exact duplicates and a family
// of per-type copies of fBm/turbulence/warp):
//
//   coords (aspect, polar/tunnel, rotate) → warp → basis × fractal → combine
//   with layer B → shape (contrast, contours, steps, gamma) → colour
//
// Basis (noise.type) — the index is what saved states hold:
//   Smooth   0 Value  1 Perlin  2 Simplex  3 Psrd (periodic, Alpha turns it)
//            4 Flow (Psrd, octaves warped by their own gradient)
//            5 Curl (RG = flow vector, B = magnitude — a displacement source)
//   Cells    6 Voronoi  7 Hex  8 Grid        (Output: Distance/Round/Edges/ID)
//   Pattern  9 Waves 10 Checker 11 Dots 12 Truchet 13 Gabor 14 Stars
//   Grain   15 White 16 Gaussian 17 SaltPepper 18 Blue  (per PIXEL: Width =
//            grain size, Speed = refresh rate)
//
// Every smooth basis returns a signed value normalised to the same spread
// (SD ≈ 0.4) before the fractal sum, and fBm divides by sqrt(Σamp²) rather
// than Σamp, so the output keeps its contrast at any octave count — the old
// sum/Σamp averaged 4 octaves down to SD 13/255, a grey wash.
//
// Time: uPhase / uPhaseB are ACCUMULATED in JS (∫speed·dt), never uTime·speed,
// so modulating Speed changes the rate instead of scrubbing the position.

// Uniform defaults for NOISE_BFG — the Pipeline material is built from this,
// so a uniform added to the shader is declared in exactly one other place.
export const NOISE_UNIFORM_DEFAULTS = {
  uPhase: 0, uPhaseB: 0, uType: 1, uFractal: 1, uOctaves: 4, uLacunarity: 2,
  uGain: 0.5, uScale: 3, uRotate: 0, uStretch: 1, uOffset: [0, 0], uAspect: 1, uCoords: 0,
  uSeed: 0, uWarp: 0, uWarpMode: 0, uWarpScale: 1, uCellMetric: 0,
  uCellOut: 0, uJitter: 1, uWidth: 0.2, uDensity: 0.5, uPeriod: [0, 0],
  uAlpha: 0, uCombine: 0, uAmount: 0.5, uTypeB: 6, uFractalB: 0, uScaleB: 6,
  uContrast: 1, uBrightness: 0, uGamma: 1, uBands: 0, uSteps: 0, uInvert: 0,
  uColor: 0, uColor1: [0, 0, 0], uColor2: [1, 1, 1], uRes: [512, 512], uTile: 0,
};

export const NOISE_BFG = /* glsl */ `
  uniform float uPhase;
  uniform float uPhaseB;
  uniform int   uType;
  uniform int   uFractal;
  uniform float uOctaves;
  uniform float uLacunarity;
  uniform float uGain;
  uniform float uScale;
  uniform float uRotate;
  uniform float uStretch;
  uniform vec2  uOffset;
  uniform float uAspect;
  uniform int   uCoords;
  uniform float uSeed;
  uniform float uWarp;
  uniform int   uWarpMode;
  uniform float uWarpScale;
  uniform int   uCellMetric;
  uniform int   uCellOut;
  uniform float uJitter;
  uniform float uWidth;
  uniform float uDensity;
  uniform vec2  uPeriod;
  uniform float uAlpha;
  uniform int   uCombine;
  uniform float uAmount;
  uniform int   uTypeB;
  uniform int   uFractalB;
  uniform float uScaleB;
  uniform float uContrast;
  uniform float uBrightness;
  uniform float uGamma;
  uniform float uBands;
  uniform float uSteps;
  uniform int   uInvert;
  uniform int   uColor;
  uniform vec3  uColor1;
  uniform vec3  uColor2;
  uniform vec2  uRes;
  uniform int   uTile;
  varying vec2  vUv;

  const float TAU = 6.28318530718;
  // Fractal-mode centring, measured (tests: noise calibration in the harness)
  const float TURB_K = 0.83;
  const float RIDGE_MEAN = 0.45;
  const float RIDGE_MID = 0.5;
  const float RIDGE_K = 0.75;

  // Per-evaluation globals (GLSL ES 1.00 has no closures): pattern-unit size
  // of one pixel for anti-aliasing, and a salt that decorrelates RGB channels.
  float gPx   = 0.01;
  float gSalt = 0.0;
  // Tile: the lattice period (in cells) of the field being evaluated, 0 = off.
  // Every lattice hash wraps its x/y by it, so any type built on h1/h3/gHash
  // repeats exactly — Scale, Lacunarity and Warp Scale are rounded in JS so
  // each octave's period is a whole number. Simplex and Hex use skewed
  // lattices that cannot wrap on a square; Psrd/Flow take it as their period.
  vec2  gPer  = vec2(0.0);
  vec3 wrapP(vec3 p) {
    if (gPer.x > 0.0) p.xy = mod(p.xy, gPer);
    return p;
  }

  // ── Hashes ────────────────────────────────────────────────────────────────
  float h1(vec3 p) {
    p = fract(wrapP(p) * 0.1031);
    p += dot(p, p.zyx + 31.32);
    return fract((p.x + p.y) * p.z);
  }
  vec3 h3(vec3 p) {
    p = fract(wrapP(p) * vec3(0.1031, 0.1030, 0.0973));
    p += dot(p, p.yxz + 33.33);
    return fract((p.xxy + p.yxx) * p.zyx);
  }
  vec2 h2(vec2 v, float s) { return h3(vec3(v, s)).xy; }
  // Continuous-position hash for per-pixel grain (h1 goes ~1D on non-lattice
  // input along the diagonal). Hoskins' hash13, not the sin hash: seed
  // carries the frame count, which grows all session, and the sin version
  // collapsed to 14–52 distinct values after an hour (measured). The seed is
  // wrapped at 4096 frames INSIDE the hash, so frame n's a1 and frame
  // n+1's a0 still agree across the wrap.
  float hashPos(vec2 p, float seed) {
    vec3 p3 = fract(vec3(p, mod(seed, 4096.0)) * 0.1031);
    p3 += dot(p3, p3.zyx + 31.32);
    return fract((p3.x + p3.y) * p3.z);
  }

  // ── Value noise — two time-phases crossfaded so z-animation doesn't breathe
  float _vLat(vec3 i, vec3 u) {
    return mix(
      mix(mix(h1(i),              h1(i+vec3(1,0,0)), u.x),
          mix(h1(i+vec3(0,1,0)), h1(i+vec3(1,1,0)), u.x), u.y),
      mix(mix(h1(i+vec3(0,0,1)), h1(i+vec3(1,0,1)), u.x),
          mix(h1(i+vec3(0,1,1)), h1(i+vec3(1,1,1)), u.x), u.y),
      u.z);
  }
  float vNoise(vec3 p) {
    vec3 i = floor(p), f = fract(p);
    vec3 u = f*f*f*(f*(f*6.0-15.0)+10.0);
    float a = _vLat(i, u);
    vec3 pB = p + vec3(0.0, 0.0, 0.5);
    vec3 iB = floor(pB), fB = fract(pB);
    vec3 uB = fB*fB*fB*(fB*(fB*6.0-15.0)+10.0);
    float b = _vLat(iB, uB);
    float w = 1.0 - 4.0 * f.z * (1.0 - f.z);
    return mix(a, b, w);
  }

  // ── Perlin gradient noise — quintic interpolation ─────────────────────────
  vec3 gHash(vec3 p) {
    p = fract(wrapP(p) * vec3(0.1031, 0.1030, 0.0973));
    p += dot(p, p.yxz + 33.33);
    return normalize(-1.0 + 2.0 * fract((p.xxy + p.yxx) * p.zyx));
  }
  float pNoise(vec3 p) {
    vec3 i = floor(p), f = fract(p);
    vec3 u = f*f*f*(f*(f*6.0-15.0)+10.0);
    float v000 = dot(gHash(i),              f);
    float v100 = dot(gHash(i+vec3(1,0,0)), f-vec3(1,0,0));
    float v010 = dot(gHash(i+vec3(0,1,0)), f-vec3(0,1,0));
    float v110 = dot(gHash(i+vec3(1,1,0)), f-vec3(1,1,0));
    float v001 = dot(gHash(i+vec3(0,0,1)), f-vec3(0,0,1));
    float v101 = dot(gHash(i+vec3(1,0,1)), f-vec3(1,0,1));
    float v011 = dot(gHash(i+vec3(0,1,1)), f-vec3(0,1,1));
    float v111 = dot(gHash(i+vec3(1,1,1)), f-vec3(1,1,1));
    return mix(
      mix(mix(v000,v100,u.x), mix(v010,v110,u.x), u.y),
      mix(mix(v001,v101,u.x), mix(v011,v111,u.x), u.y),
      u.z);
  }

  // ── Simplex noise 3D — Stefan Gustavson ───────────────────────────────────
  vec3  _m289v3(vec3  x){return x-floor(x*(1.0/289.0))*289.0;}
  vec4  _m289v4(vec4  x){return x-floor(x*(1.0/289.0))*289.0;}
  vec4  _prm(vec4   x){return _m289v4(((x*34.0)+1.0)*x);}
  vec4  _tiS(vec4   r){return 1.79284291400159-0.85373472095314*r;}
  float sNoise(vec3 v) {
    const vec2 C = vec2(1.0/6.0, 1.0/3.0);
    const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
    vec3 i  = floor(v + dot(v, C.yyy));
    vec3 x0 = v - i + dot(i, C.xxx);
    vec3 g  = step(x0.yzx, x0.xyz);
    vec3 l  = 1.0 - g;
    vec3 i1 = min(g.xyz, l.zxy);
    vec3 i2 = max(g.xyz, l.zxy);
    vec3 x1 = x0 - i1 + C.xxx;
    vec3 x2 = x0 - i2 + C.yyy;
    vec3 x3 = x0 - D.yyy;
    i = _m289v3(i);
    vec4 p = _prm(_prm(_prm(
               i.z + vec4(0.0,i1.z,i2.z,1.0))
             + i.y + vec4(0.0,i1.y,i2.y,1.0))
             + i.x + vec4(0.0,i1.x,i2.x,1.0));
    float n_ = 0.142857142857;
    vec3  ns = n_ * D.wyz - D.xzx;
    vec4  j  = p - 49.0*floor(p*ns.z*ns.z);
    vec4  x_ = floor(j*ns.z);
    vec4  y_ = floor(j - 7.0*x_);
    vec4  x  = x_*ns.x + ns.yyyy;
    vec4  y  = y_*ns.x + ns.yyyy;
    vec4  h  = 1.0 - abs(x) - abs(y);
    vec4  b0 = vec4(x.xy, y.xy);
    vec4  b1 = vec4(x.zw, y.zw);
    vec4  s0 = floor(b0)*2.0 + 1.0;
    vec4  s1 = floor(b1)*2.0 + 1.0;
    vec4  sh = -step(h, vec4(0.0));
    vec4  a0 = b0.xzyw + s0.xzyw*sh.xxyy;
    vec4  a1 = b1.xzyw + s1.xzyw*sh.zzww;
    vec3  p0 = vec3(a0.xy, h.x);
    vec3  p1 = vec3(a0.zw, h.y);
    vec3  p2 = vec3(a1.xy, h.z);
    vec3  p3 = vec3(a1.zw, h.w);
    vec4  nm = _tiS(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
    p0 *= nm.x; p1 *= nm.y; p2 *= nm.z; p3 *= nm.w;
    vec4 m = max(0.5 - vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)), 0.0);
    m = m * m;
    return 42.0 * dot(m*m, vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
  }

  // ── psrdnoise2 — Stefan Gustavson 2021, MIT license ──────────────────────
  // Periodic (period 0 = none) with rotating gradients (alpha): flow noise.
  // Rewritten for GLSL ES 1.00: no out param, value + gradient in a struct.
  struct PsrdResult { float n; vec2 g; };
  PsrdResult psrdnoise(vec2 x, vec2 period, float alpha) {
    vec2 uv = vec2(x.x + x.y * 0.5, x.y);
    vec2 i0 = floor(uv);
    vec2 f0 = fract(uv);
    float cmp = step(f0.y, f0.x);
    vec2 o1 = vec2(cmp, 1.0 - cmp);
    vec2 i1 = i0 + o1;
    vec2 i2 = i0 + vec2(1.0, 1.0);
    vec2 v0 = vec2(i0.x - i0.y * 0.5, i0.y);
    vec2 v1 = vec2(i1.x - i1.y * 0.5, i1.y);
    vec2 v2 = vec2(i2.x - i2.y * 0.5, i2.y);
    vec2 x0 = x - v0, x1 = x - v1, x2 = x - v2;
    vec3 iu, iv;
    if (period.x > 0.001 || period.y > 0.001) {
      vec3 xw = vec3(v0.x, v1.x, v2.x);
      vec3 yw = vec3(v0.y, v1.y, v2.y);
      if (period.x > 0.001) xw = mod(xw, period.x);
      if (period.y > 0.001) yw = mod(yw, period.y);
      iu = floor(xw + 0.5 * yw + 0.5);
      iv = floor(yw + 0.5);
    } else {
      iu = vec3(i0.x, i1.x, i2.x);
      iv = vec3(i0.y, i1.y, i2.y);
    }
    vec3 hash = mod(iu, 289.0);
    hash = mod((hash * 51.0 + 2.0) * hash + iv, 289.0);
    hash = mod((hash * 34.0 + 10.0) * hash, 289.0);
    vec3 psi = hash * 0.07482 + alpha;
    vec3 gx = cos(psi); vec3 gy = sin(psi);
    vec2 g0 = vec2(gx.x, gy.x);
    vec2 g1 = vec2(gx.y, gy.y);
    vec2 g2 = vec2(gx.z, gy.z);
    vec3 w = max(0.8 - vec3(dot(x0,x0), dot(x1,x1), dot(x2,x2)), 0.0);
    vec3 w2 = w * w; vec3 w4 = w2 * w2;
    vec3 gdotx = vec3(dot(g0,x0), dot(g1,x1), dot(g2,x2));
    vec3 dw = -8.0 * w2 * w * gdotx;
    PsrdResult r;
    r.n = 10.9 * dot(w4, gdotx);
    r.g = 10.9 * (w4.x * g0 + dw.x * x0 + w4.y * g1 + dw.y * x1 + w4.z * g2 + dw.z * x2);
    return r;
  }

  // ── Cells: Voronoi (3D, time morphs the seeds), Hex, Grid ─────────────────
  // All three answer the same Output question, so one control serves them:
  //   0 Distance  1 Round  2 Edges  3 Cell ID
  float cellOut(float d, float dRound, float edge, float id) {
    if (uCellOut == 0) return d;
    if (uCellOut == 1) return dRound;
    if (uCellOut == 2) {
      float w = mix(0.005, 0.2, uWidth);
      return 1.0 - smoothstep(w, w + gPx * 1.5, edge);
    }
    return id;
  }

  float voronoiN(vec3 p) {
    vec3 i = floor(p), f = fract(p);
    float f1 = 9.0, f2 = 9.0;
    vec3 c1 = vec3(0.0);
    for (int z = -1; z <= 1; z++)
    for (int y = -1; y <= 1; y++)
    for (int x = -1; x <= 1; x++) {
      vec3 nb = vec3(float(x), float(y), float(z));
      vec3 dv = nb + 0.5 + (h3(i + nb) - 0.5) * uJitter - f;
      float d = length(dv);
      if (uCellMetric == 1) d = abs(dv.x) + abs(dv.y) + abs(dv.z);
      if (uCellMetric == 2) d = max(max(abs(dv.x), abs(dv.y)), abs(dv.z));
      if (d < f1) { f2 = f1; f1 = d; c1 = i + nb; }
      else if (d < f2) { f2 = d; }
    }
    float k = uCellMetric == 1 ? 0.6 : (uCellMetric == 2 ? 1.2 : 1.0);
    return cellOut(clamp(f1 * k * 1.1, 0.0, 1.0),
                   clamp(f2 * k * 0.8, 0.0, 1.0),
                   (f2 - f1) * k,
                   h1(c1 + 17.3));
  }

  // Cell ID that drifts over time: each tile cycles at its own rate.
  float liveId(vec2 cell, float z) {
    float h = h1(vec3(cell, uSeed * 1.618 + gSalt + 5.1));
    return 0.5 + 0.5 * sin(TAU * (h + z * 0.25 * (0.5 + h)));
  }

  float hexN(vec3 p) {
    const vec2 s = vec2(1.0, 1.7320508);
    vec2 q = p.xy;
    vec4 hc = floor(vec4(q, q - vec2(0.5, 1.0)) / s.xyxy) + 0.5;
    vec4 hh = vec4(q - hc.xy * s, q - (hc.zw + 0.5) * s);
    vec4 h = dot(hh.xy, hh.xy) < dot(hh.zw, hh.zw) ? vec4(hh.xy, hc.xy) : vec4(hh.zw, hc.zw + 0.5);
    vec2 a = abs(h.xy);
    float hd = max(dot(a, s * 0.5), a.x);       // 0 centre → 0.5 edge
    return cellOut(hd * 2.0, clamp(length(h.xy) * 2.0, 0.0, 1.0),
                   0.5 - hd, liveId(h.zw, p.z));
  }

  float gridN(vec3 p) {
    vec2 c = floor(p.xy), l = fract(p.xy) - 0.5;
    float d = max(abs(l.x), abs(l.y));
    return cellOut(d * 2.0, clamp(length(l) * 1.4142, 0.0, 1.0),
                   0.5 - d, liveId(c, p.z));
  }

  // ── Patterns ──────────────────────────────────────────────────────────────
  // Width: Waves = sine→square, Dots = radius, Truchet = line,
  // Gabor = alignment (0 random directions → 1 all along the Rotate angle),
  // Stars = size.  Density: Dots/Stars fill, SaltPepper amount.
  float wavesN(vec3 p) {
    float s = 0.5 + 0.5 * sin(TAU * p.x + p.z * TAU * 0.25);
    float aa = gPx * 3.0 + 0.001;
    return mix(s, smoothstep(0.5 - aa, 0.5 + aa, s), uWidth);
  }

  float checkerN(vec3 p) {
    float c = sin(3.14159265 * p.x) * sin(3.14159265 * p.y);
    return smoothstep(-gPx * 3.0, gPx * 3.0, c);
  }

  float dotsN(vec3 p) {
    vec2 i = floor(p.xy), f = fract(p.xy);
    float r = mix(0.05, 0.5, uWidth);
    float v = 0.0;
    for (int y = -1; y <= 1; y++)
    for (int x = -1; x <= 1; x++) {
      vec2 nb = vec2(float(x), float(y));
      vec3 hh = h3(vec3(i + nb, uSeed * 1.618 + gSalt + 9.7));
      if (hh.z > uDensity) continue;
      vec2 c = nb + 0.5 + (hh.xy - 0.5) * uJitter * (1.0 - r);
      float d = length(f - c);
      v = max(v, 1.0 - smoothstep(r - gPx, r + gPx, d));
    }
    return v;
  }

  float truchetN(vec3 p) {
    vec2 i = floor(p.xy), l = fract(p.xy);
    if (h1(vec3(i, uSeed * 1.618 + gSalt + 37.3)) > 0.5) l.x = 1.0 - l.x;
    float d = min(abs(length(l) - 0.5), abs(length(l - 1.0) - 0.5));
    float w = mix(0.02, 0.25, uWidth);
    return 1.0 - smoothstep(w - gPx, w + gPx, d);
  }

  // Sparse-convolution Gabor noise (Lagae 2009): random impulses per cell,
  // each a Gaussian-windowed cosine. 3×3 cells × 3 impulses.
  float gaborN(vec3 p) {
    vec2 i = floor(p.xy), f = fract(p.xy);
    float sum = 0.0;
    for (int y = -1; y <= 1; y++)
    for (int x = -1; x <= 1; x++) {
      vec2 nb = vec2(float(x), float(y));
      for (int k = 0; k < 3; k++) {
        vec3 hh = h3(vec3(i + nb, uSeed * 1.618 + gSalt + float(k) * 7.31));
        vec2 r = f - nb - hh.xy;
        float ang = mix(hh.z * TAU, 0.0, uWidth);
        float env = exp(-dot(r, r) * 12.0);
        float wgt = h1(vec3(i + nb, float(k) + 91.0)) < 0.5 ? -1.0 : 1.0;
        sum += wgt * env * cos(TAU * 2.0 * dot(r, vec2(cos(ang), sin(ang))) + p.z * 3.0);
      }
    }
    return 0.5 + 0.5 * clamp(sum * 0.55, -1.0, 1.0);
  }

  float starsN(vec3 p) {
    vec2 i = floor(p.xy), f = fract(p.xy);
    float v = 0.0;
    for (int y = -1; y <= 1; y++)
    for (int x = -1; x <= 1; x++) {
      vec2 nb = vec2(float(x), float(y));
      vec3 hh = h3(vec3(i + nb, uSeed * 1.618 + gSalt + 3.3));
      if (hh.z > uDensity) continue;
      float b = h1(vec3(i + nb, 55.1));
      float sz = mix(0.01, 0.12, uWidth) * (0.4 + b) + gPx;
      float tw = 0.65 + 0.35 * sin(p.z * 4.0 + b * 40.0);
      float d = length(f - nb - hh.xy);
      v += b * tw * exp(-d * d / (sz * sz));
    }
    return clamp(v * 1.5, 0.0, 1.0);
  }

  // ── Grain (per pixel; Speed = refresh rate, crossfaded between frames) ───
  float grainN(int type) {
    vec2 cell = floor(gl_FragCoord.xy / (1.0 + floor(uWidth * uWidth * 16.0)));  // Width 0–0.24 = 1 px
    float seed = uSeed + gSalt * 13.0;
    float frB = uPhase * 24.0;
    float fr = floor(frB), ff = fract(frB);
    float v0, v1;
    if (type == 18) {
      // Interleaved gradient noise (Jimenez) with its temporal offset — the
      // cheap blue-ish dither; per pixel, so run the Noise at Full resolution.
      vec2 ign = vec2(0.06711056, 0.00583715);
      vec2 c = cell + seed * 7.0;
      v0 = fract(52.9829189 * fract(dot(c + 5.588238 * fr, ign)));
      v1 = fract(52.9829189 * fract(dot(c + 5.588238 * (fr + 1.0), ign)));
      return mix(v0, v1, ff);
    }
    float a0 = hashPos(cell, seed + fr),        a1 = hashPos(cell, seed + fr + 1.0);
    if (type == 15) return mix(a0, a1, ff);
    if (type == 16) {
      float b0 = hashPos(cell + 17.0, seed + 91.7 + fr);
      float b1 = hashPos(cell + 17.0, seed + 92.7 + fr);
      float g0 = sqrt(-2.0 * log(max(a0, 1e-4))) * cos(TAU * b0);
      float g1 = sqrt(-2.0 * log(max(a1, 1e-4))) * cos(TAU * b1);
      return clamp(0.5 + 0.2 * mix(g0, g1, ff), 0.0, 1.0);
    }
    // Salt & pepper: Density sets how many pixels flip to black or white.
    float hv = mix(a0, a1, ff);
    float d = uDensity * 0.5;
    return hv < d ? 0.0 : (hv > 1.0 - d ? 1.0 : 0.5);
  }

  // ── Basis → signed value, SD ≈ 0.4 for every smooth type ─────────────────
  float basisS(int type, vec3 p, float freq) {
    if (type == 0) return (vNoise(p) - 0.5) * 2.5;
    if (type == 2) return sNoise(p) * 2.8;
    if (type == 3) {
      vec2 per = gPer.x > 0.0 ? gPer : uPeriod * freq;
      return psrdnoise(p.xy, per, p.z + uAlpha).n * 0.85;
    }
    if (type == 6) return voronoiN(p) * 2.0 - 1.0;
    if (type == 7) return hexN(p) * 2.0 - 1.0;
    if (type == 8) return gridN(p) * 2.0 - 1.0;
    return pNoise(p) * 2.0;                          // Perlin (and Curl's field)
  }

  // Flow: Gustavson's gradient-warped psrdnoise — each octave is displaced by
  // the accumulated gradient of the ones before it. Warp = strength,
  // Warp mode Curl = swirl (rotate the gradient 90°), Fractal Turbulence/
  // Ridged fold each octave. Always layered: Octaves counts even when Off.
  float flowN(vec3 p, int fm) {
    vec2 gsum = vec2(0.0);
    float acc = 0.0, wt = 1.0, sc = 1.0, wtSum = 0.0;
    float swirl = uWarpMode == 2 ? 1.0 : 0.0;
    vec2 per = gPer.x > 0.0 ? gPer : uPeriod;
    for (int i = 0; i < 8; i++) {
      if (float(i) >= uOctaves) break;
      vec2 wv = mix(gsum, vec2(-gsum.y, gsum.x), swirl);
      float aS = pow(sc, 0.33);
      float aArg = p.z + uAlpha;
      float aPh = aS * ((per.x > 0.001 || per.y > 0.001) ? mod(aArg, TAU / aS) : aArg);
      PsrdResult r = psrdnoise(sc * p.xy + uWarp * 0.15 * wv, sc * per, aPh);
      float v = r.n;
      if (fm == 2) v = abs(v) * 2.0 - 1.0;
      if (fm == 3) v = 1.0 - 2.0 * abs(v);
      acc += wt * v;
      gsum += wt * r.g;
      wtSum += wt;
      wt *= uGain;
      sc *= 2.0;
    }
    return clamp(0.5 + 0.5 * acc / max(wtSum, 0.001), 0.0, 1.0);
  }

  // ── Field: basis with its fractal, returned in 0..1 ──────────────────────
  // fm: 0 Off (one octave, the plain basis)  1 fBm  2 Turbulence  3 Ridged
  float field(int type, int fm, vec3 p) {
    if (type == 4) return flowN(p, fm);
    if (type >= 15) return grainN(type);
    if (type == 9)  return wavesN(p);
    if (type == 10) return checkerN(p);
    if (type == 11) return dotsN(p);
    if (type == 12) return truchetN(p);
    if (type == 13) return gaborN(p);
    if (type == 14) return starsN(p);
    float oct = fm == 0 ? 1.0 : uOctaves;
    int m = fm == 0 ? 1 : fm;
    float sum = 0.0, amp = 1.0, freq = 1.0, n2 = 0.0, prev = 1.0;
    float px0 = gPx;
    vec2 per0 = gPer;
    for (int i = 0; i < 8; i++) {
      if (float(i) >= oct) break;
      gPer = per0 * freq;
      vec3 o = vec3(float(i) * 19.19, float(i) * 7.37, 0.0);
      float s = basisS(type, p * freq + o, freq);
      if (m == 1) {
        sum += s * amp;
      } else if (m == 2) {
        sum += (abs(s) - 0.32) * amp;              // E|s| at SD 0.4
      } else {
        float r = clamp(1.0 - abs(s), 0.0, 1.0);
        r = r * r * prev;                          // Musgrave: crests gate
        prev = r;                                  // the next octave
        sum += (r - RIDGE_MEAN) * amp;
      }
      n2 += amp * amp;
      amp *= uGain;
      freq *= uLacunarity;
      gPx *= uLacunarity;
    }
    gPx = px0;
    gPer = per0;
    // Each mode is re-centred on 0.5 with a spread close to the plain basis,
    // so switching mode or octave count changes the character, not the level.
    float z = sum / sqrt(n2);
    if (m == 1) return 0.5 + 0.5 * z;
    if (m == 2) return 0.5 + TURB_K * z;
    return RIDGE_MID + RIDGE_K * z;
  }

  // ── Coordinates ───────────────────────────────────────────────────────────
  // aspect → Cartesian/Polar/Tunnel → rotate. In Polar and Tunnel, Rotate
  // shears angle against radius, so 90° turns Waves into rings and anything
  // between gives spirals; Offset X spins, Offset Y zooms.
  // Angle is mirrored (|atan|) so the ±180° seam cannot show.
  vec2 baseCoords() {
    vec2 q = vUv - 0.5;
    if (uTile == 1) return q;        // tiling: no aspect, polar or rotation
    q.x *= uAspect;
    if (uCoords == 1) q = vec2(abs(atan(q.y, q.x)) / 3.14159265, length(q) * 2.0) - 0.5;
    if (uCoords == 2) q = vec2(abs(atan(q.y, q.x)) / 3.14159265 - 0.5, 0.15 / max(length(q), 0.002));
    float c = cos(uRotate), s = sin(uRotate);
    q = vec2(c * q.x - s * q.y, s * q.x + c * q.y);
    // Stretch: features grow long along the Rotate direction and fine across
    // it (hair, fibre, grain, rain). Area-preserving, so Scale keeps meaning.
    float k = sqrt(max(uStretch, 1.0));
    return vec2(q.x / k, q.y * k);
  }

  // Warp vector (pattern units) — Domain: one fBm displacement (Quilez);
  // Double: the displacement warped again; Curl: along the curl of the field,
  // which swirls and never pinches.
  vec2 warpVec(vec3 wp) {
    // One call site for field(): GLSL ES inlines every call, so the samples
    // are taken in a loop rather than written out (compile time, not speed).
    bool curl = uWarpMode == 2;
    int nS = curl ? 3 : (uWarpMode == 1 ? 4 : 2);
    const float e = 0.02;
    vec2 w = vec2(0.0);
    float a = 0.0, b = 0.0, c = 0.0;
    for (int k = 0; k < 4; k++) {
      if (k >= nS) break;
      vec3 q;
      if (curl) q = wp + (k == 1 ? vec3(e, 0.0, 0.0) : (k == 2 ? vec3(0.0, e, 0.0) : vec3(0.0)));
      else      q = wp + vec3(w * uWarp, 0.0)
                       + (k == 0 || k == 2 ? vec3(1.7, 9.2, 0.0) : vec3(8.3, 2.8, 0.0));
      float v = field(1, 1, q);
      if (k == 0) a = v; else if (k == 1) b = v; else c = v;
      if (!curl && (k == 1 || k == 3)) {
        if (k == 3) a = c;
        w = vec2(a, v) * 2.0 - 1.0;
      }
    }
    if (curl) return vec2(c - a, -(b - a)) / e * 0.12;
    return w;
  }

  // ── One channel of the full chain ─────────────────────────────────────────
  float evalChannel(vec2 q, float salt) {
    gSalt = salt;
    float tA = uPhase + uSeed * 3.17 + salt * 11.3;
    gPx = uScale / uRes.y;
    // Centred: q is 0 at the middle of the frame, so Scale zooms about the
    // centre. (Tiling needs no anchor — a whole-number period tiles from
    // any starting point.)
    vec3 pA = vec3(q * uScale + uOffset, tA);

    bool grain = uType >= 15;
    float tile = uTile == 1 ? 1.0 : 0.0;
    if (uWarp > 0.0 && !grain && uType != 4) {
      gPer = vec2(uScale * uWarpScale * tile);
      vec3 wp = vec3(pA.xy * uWarpScale, tA * 0.5 + 4.1);
      pA.xy += uWarp * warpVec(wp) / uWarpScale;
    }

    // Layer B — its own type, fractal, scale and clock over the same coords.
    float b = 0.0;
    vec3 pB = vec3(q * uScaleB + uOffset, uPhaseB + uSeed * 3.17 + salt * 11.3 + 23.0);
    // Warp takes two samples of B (x and y displacement); the rest take one.
    // A loop, so B's field() is compiled once.
    float b2 = 0.0;
    gPx = uScaleB / uRes.y;
    gPer = vec2(uScaleB * tile);
    for (int k = 0; k < 2; k++) {
      if (uCombine == 0 || (k == 1 && uCombine != 9)) break;
      float v = field(uTypeB, uFractalB, pB + (k == 1 ? vec3(5.2, 1.3, 0.0) : vec3(0.0)));
      if (k == 0) b = v; else b2 = v;
    }
    if (uCombine == 9) pA.xy += uAmount * 1.5 * (vec2(b, b2) * 2.0 - 1.0) * uScale / uScaleB;

    gPx = uScale / uRes.y;
    gPer = vec2(uScale * tile);
    float a = field(uType, uFractal, pA);
    float n = a;
    if (uCombine > 0 && uCombine < 9) {
      float o = a;
      if      (uCombine == 1) o = b;                          // Mix (crossfade A→B)
      else if (uCombine == 2) o = a + b - 0.5;                // Add
      else if (uCombine == 3) o = a * b * 2.0;                // Multiply
      else if (uCombine == 4) o = 1.0 - (1.0 - a) * (1.0 - b);// Screen
      else if (uCombine == 5) o = abs(a - b) * 2.0;           // Difference
      else if (uCombine == 6) o = min(a, b);                  // Min
      else if (uCombine == 7) o = max(a, b);                  // Max
      else if (uCombine == 8) o = a * smoothstep(0.45, 0.55, b); // Mask (B gates A)
      n = mix(a, o, uAmount);
    }

    // Shape
    n = (n - 0.5) * uContrast + 0.5 + uBrightness;
    if (uBands > 0.0) n = 0.5 - 0.5 * cos(TAU * n * uBands);
    n = clamp(n, 0.0, 1.0);
    if (uSteps >= 2.0) n = min(floor(n * uSteps), uSteps - 1.0) / (uSteps - 1.0);
    n = pow(n, uGamma);
    if (uInvert == 1) n = 1.0 - n;
    return n;
  }

  void main() {
    vec2 q = baseCoords();

    // Curl: a displacement source. RG = flow vector (0.5 = still), B = speed.
    if (uType == 5) {
      gPx = uScale / uRes.y;
      float tA = uPhase + uSeed * 3.17;
      vec3 p = vec3(q * uScale + uOffset, tA);
      float tile = uTile == 1 ? 1.0 : 0.0;
      gPer = vec2(uScale * uWarpScale * tile);
      if (uWarp > 0.0) p.xy += uWarp * warpVec(vec3(p.xy * uWarpScale, tA * 0.5 + 4.1)) / uWarpScale;
      gPer = vec2(uScale * tile);
      const float e = 0.01;
      float n0 = 0.0, nx = 0.0, ny = 0.0;
      for (int k = 0; k < 3; k++) {
        float v = field(1, uFractal, p + (k == 1 ? vec3(e, 0.0, 0.0) : (k == 2 ? vec3(0.0, e, 0.0) : vec3(0.0))));
        if (k == 0) n0 = v; else if (k == 1) nx = v; else ny = v;
      }
      vec2 cv = vec2(ny - n0, -(nx - n0)) / e * 0.25;
      vec3 col = vec3(0.5 + 0.5 * clamp(cv, -1.0, 1.0), clamp(length(cv), 0.0, 1.0));
      if (uInvert == 1) col.xy = 1.0 - col.xy;
      gl_FragColor = vec4(col, 1.0);
      return;
    }

    // RGB runs the SAME chain once per channel, decorrelated by salt. A loop,
    // not three calls, so the chain is compiled once rather than inlined 3×.
    vec3 ch = vec3(0.0);
    for (int c = 0; c < 3; c++) {
      if (c > 0 && uColor != 1) break;
      float v = evalChannel(q, float(c));
      if (c == 0) ch.r = v; else if (c == 1) ch.g = v; else ch.b = v;
    }
    vec3 col;
    if      (uColor == 1) col = ch;
    else if (uColor == 2) col = 0.5 + 0.5 * cos(TAU * (ch.r * 0.85 + vec3(0.0, 0.33, 0.67)));
    else                  col = mix(uColor1, uColor2, ch.r);
    gl_FragColor = vec4(col, 1.0);
  }
`;

// ── Interlace ─────────────────────────────────────────────────────────────────

export const INTERLACE = /* glsl */ `
  uniform sampler2D uTexture;
  uniform float uResY;
  uniform float uAmount;
  uniform float uTime;

  varying vec2 vUv;

  void main() {
    if (uAmount < 1.0) {
      gl_FragColor = texture2D(uTexture, vUv);
      return;
    }
    float line = floor(vUv.y * uResY);
    float field = mod(floor(uTime * 30.0), 2.0);
    if (mod(line + field, 2.0) < 1.0) {
      gl_FragColor = texture2D(uTexture, vUv);
    } else {
      vec4 above = texture2D(uTexture, vec2(vUv.x, vUv.y + 1.0/uResY));
      vec4 below = texture2D(uTexture, vec2(vUv.x, vUv.y - 1.0/uResY));
      gl_FragColor = (above + below) * 0.5;
    }
  }
`;

// ── Mirror ────────────────────────────────────────────────────────────────────

export const MIRROR = /* glsl */ `
  uniform sampler2D uTexture;
  uniform int uFlipH;
  uniform int uFlipV;
  varying vec2 vUv;

  void main() {
    vec2 uv = vUv;
    if (uFlipH == 1) uv.x = 1.0 - uv.x;
    if (uFlipV == 1) uv.y = 1.0 - uv.y;
    gl_FragColor = texture2D(uTexture, uv);
  }
`;

// ── WarpMap ───────────────────────────────────────────────────────────────────

export const WARP = /* glsl */ `
  uniform sampler2D uFG;
  uniform sampler2D uWarpMap;
  uniform float uStrength;

  varying vec2 vUv;

  void main() {
    if (uStrength == 0.0) {
      gl_FragColor = texture2D(uFG, vUv);
      return;
    }
    vec4 warp = texture2D(uWarpMap, vUv);
    vec2 displacement = (warp.rg - 0.5) * uStrength * 0.3;
    gl_FragColor = texture2D(uFG, clamp(vUv + displacement, 0.0, 1.0));
  }
`;

// ── Fade ──────────────────────────────────────────────────────────────────────

export const FADE = /* glsl */ `
  uniform sampler2D uTexture;
  uniform float uAmount;
  varying vec2 vUv;
  void main() {
    gl_FragColor = texture2D(uTexture, vUv) * uAmount;
  }
`;

// ── Bicubic interpolation blit ────────────────────────────────────────────────
// Mitchell-Netravali cubic filter for smooth upscaling on the final blit.
// uMode: 0=nearest/linear (passthrough), 1=bicubic
// WGSL: equivalent textureSample with custom filter kernel

export const INTERP = /* glsl */ `
  uniform sampler2D uTexture;
  uniform vec2      uResolution; // output resolution
  uniform int       uMode;       // 0=linear, 1=bicubic
  varying vec2 vUv;

  vec4 cubic(float v) {
    vec4 n  = vec4(1.0, 2.0, 3.0, 4.0) - v;
    vec4 s  = n * n * n;
    float x = s.x;
    float y = s.y - 4.0 * s.x;
    float z = s.z - 4.0 * s.y + 6.0 * s.x;
    float w = 6.0 - x - y - z;
    return vec4(x, y, z, w) * (1.0 / 6.0);
  }

  vec4 textureBicubic(sampler2D tex, vec2 uv, vec2 texSize) {
    uv = uv * texSize - 0.5;
    vec2 fxy = fract(uv);
    uv -= fxy;
    vec4 xcubic = cubic(fxy.x);
    vec4 ycubic = cubic(fxy.y);
    vec4 c = uv.xxyy + vec4(-0.5, 1.5, -0.5, 1.5);
    vec4 s = vec4(xcubic.xz + xcubic.yw, ycubic.xz + ycubic.yw);
    vec4 offset = c + vec4(xcubic.yw, ycubic.yw) / s;
    vec4 sample0 = texture2D(tex, vec2(offset.x, offset.z) / texSize);
    vec4 sample1 = texture2D(tex, vec2(offset.y, offset.z) / texSize);
    vec4 sample2 = texture2D(tex, vec2(offset.x, offset.w) / texSize);
    vec4 sample3 = texture2D(tex, vec2(offset.y, offset.w) / texSize);
    float sx = s.x / (s.x + s.y);
    float sy = s.z / (s.z + s.w);
    return mix(mix(sample3, sample2, sx), mix(sample1, sample0, sx), sy);
  }

  void main() {
    if (uMode == 1) {
      gl_FragColor = textureBicubic(uTexture, vUv, uResolution);
    } else {
      gl_FragColor = texture2D(uTexture, vUv);
    }
  }
`;

// ── Buffer pan / zoom ─────────────────────────────────────────────────────────
// uPanX/uPanY: offset from center in UV units (-0.5..0.5; 0 = centered)
// uScale: zoom factor (1 = identity, 2 = 2× zoom in)
// WGSL: equivalent textureLoad with computed coords

// ── Pixelate / Mosaic ─────────────────────────────────────────────────────────
// uAmount: pixel block size in pixels (1 = no effect, 2–200)
// uResolution: output size in pixels

export const PIXELATE = /* glsl */ `
  uniform sampler2D uTexture;
  uniform float uAmount;
  uniform vec2  uResolution;
  varying vec2 vUv;
  void main() {
    if (uAmount <= 1.0) { gl_FragColor = texture2D(uTexture, vUv); return; }
    vec2 blockSize = vec2(uAmount) / uResolution;
    vec2 snapped   = floor(vUv / blockSize) * blockSize + blockSize * 0.5;
    gl_FragColor   = texture2D(uTexture, clamp(snapped, 0.0, 1.0));
  }
`;

// ── Edge detection (Sobel) ────────────────────────────────────────────────────
// uAmount: strength 0–1; uInvert: show edges on black (0) or white (1) bg

export const EDGE = /* glsl */ `
  uniform sampler2D uTexture;
  uniform float uAmount;
  uniform int   uInvert;
  uniform int   uColor;   // 1 = keep source colour, 0 = grey edges (original)
  uniform vec2  uResolution;
  varying vec2 vUv;

  float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

  void main() {
    if (uAmount == 0.0) { gl_FragColor = texture2D(uTexture, vUv); return; }
    vec2 px = 1.0 / uResolution;
    float tl = luma(texture2D(uTexture, vUv + vec2(-px.x,  px.y)).rgb);
    float t  = luma(texture2D(uTexture, vUv + vec2( 0.0,   px.y)).rgb);
    float tr = luma(texture2D(uTexture, vUv + vec2( px.x,  px.y)).rgb);
    float l  = luma(texture2D(uTexture, vUv + vec2(-px.x,  0.0 )).rgb);
    float r  = luma(texture2D(uTexture, vUv + vec2( px.x,  0.0 )).rgb);
    float bl = luma(texture2D(uTexture, vUv + vec2(-px.x, -px.y)).rgb);
    float b  = luma(texture2D(uTexture, vUv + vec2( 0.0,  -px.y)).rgb);
    float br = luma(texture2D(uTexture, vUv + vec2( px.x, -px.y)).rgb);
    float gx = -tl - 2.0*l - bl + tr + 2.0*r + br;
    float gy = -tl - 2.0*t - tr + bl + 2.0*b + br;
    float edge = clamp(sqrt(gx*gx + gy*gy) * uAmount * 4.0, 0.0, 1.0);
    float v    = uInvert == 1 ? (1.0 - edge) : edge;
    vec4 orig  = texture2D(uTexture, vUv);
    // uColor keeps the source colour and uses the Sobel response as a mask
    // instead of drawing grey edges — the picture, outlined in itself.
    vec3 e = uColor == 1 ? orig.rgb * v : vec3(v);
    gl_FragColor = mix(orig, vec4(e, orig.a), uAmount);
  }
`;

// ── Sharpen (unsharp mask) ─────────────────────────────────────────────────────
// uAmount: 0 = no effect, higher = stronger edge contrast boost

export const SHARPEN = /* glsl */ `
  uniform sampler2D uTexture;
  uniform float uAmount;
  uniform vec2  uResolution;
  varying vec2 vUv;

  void main() {
    vec4 c = texture2D(uTexture, vUv);
    if (uAmount <= 0.0) { gl_FragColor = c; return; }
    vec2 px = 2.0 / uResolution;
    vec3 n = texture2D(uTexture, vUv + vec2(0.0,  px.y)).rgb;
    vec3 s = texture2D(uTexture, vUv + vec2(0.0, -px.y)).rgb;
    vec3 e = texture2D(uTexture, vUv + vec2( px.x, 0.0)).rgb;
    vec3 w = texture2D(uTexture, vUv + vec2(-px.x, 0.0)).rgb;
    vec3 blur = (n + s + e + w) * 0.25;
    vec3 col  = c.rgb + (c.rgb - blur) * uAmount;
    gl_FragColor = vec4(clamp(col, 0.0, 1.0), c.a);
  }
`;

// ── RGB Shift (chromatic aberration) ──────────────────────────────────────────
// uAmount: shift in UV units (0–0.05); uAngle: direction in radians

export const RGBSHIFT = /* glsl */ `
  uniform sampler2D uTexture;
  uniform float uAmount;
  uniform float uAngle;
  varying vec2 vUv;
  void main() {
    if (uAmount == 0.0) { gl_FragColor = texture2D(uTexture, vUv); return; }
    vec2 dir = vec2(cos(uAngle), sin(uAngle)) * uAmount;
    float r  = texture2D(uTexture, clamp(vUv + dir,        0.0, 1.0)).r;
    float g  = texture2D(uTexture, vUv).g;
    float b  = texture2D(uTexture, clamp(vUv - dir,        0.0, 1.0)).b;
    float a  = texture2D(uTexture, vUv).a;
    gl_FragColor = vec4(r, g, b, a);
  }
`;

// ── Posterize ─────────────────────────────────────────────────────────────────
// uLevels: number of colour levels per channel (2–16)

export const POSTERIZE = /* glsl */ `
  uniform sampler2D uTexture;
  uniform float uLevels;
  varying vec2 vUv;
  void main() {
    vec4 c = texture2D(uTexture, vUv);
    if (uLevels >= 255.0) { gl_FragColor = c; return; }
    float lvl = max(uLevels, 2.0);
    gl_FragColor = vec4(floor(c.rgb * lvl) / (lvl - 1.0), c.a);
  }
`;

// ── Solarize ──────────────────────────────────────────────────────────────────
// uThreshold: invert values above this luminance (0–1)

export const SOLARIZE = /* glsl */ `
  uniform sampler2D uTexture;
  uniform float uThreshold;
  uniform float uSoftness;   // 0 = the original hard switch
  varying vec2 vUv;
  float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
  void main() {
    vec4 c = texture2D(uTexture, vUv);
    float l = luma(c.rgb);
    // Softness 0 must stay the old hard switch, but smoothstep is UNDEFINED
    // when edge0 >= edge1 — on some drivers that is a divide by zero, not a
    // step. Clamp to a sub-8-bit epsilon instead: narrower than one code value,
    // so it is a step in every frame anyone will ever render, and defined.
    float s = max(uSoftness, 0.0005);
    float t = smoothstep(uThreshold - s, uThreshold + s, l);
    gl_FragColor = vec4(mix(c.rgb, 1.0 - c.rgb, t), c.a);
  }
`;

export const CHROMA_KEY = /* glsl */ `
  uniform sampler2D uFG;
  uniform sampler2D uBG;
  uniform float uKeyHue;       // 0-1 target hue
  uniform float uKeyRange;     // 0-1 half-width of hue range
  uniform float uKeySoftness;  // 0-1 feather
  uniform int   uKeyActive;    // 0 = bypass
  varying vec2 vUv;

  vec3 rgb2hsv(vec3 c) {
    vec4 K = vec4(0.0, -1.0/3.0, 2.0/3.0, -1.0);
    vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
    vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
    float d = q.x - min(q.w, q.y);
    return vec3(abs(q.z + (q.w - q.y) / (6.0*d + 1e-10)), d / (q.x + 1e-10), q.x);
  }

  void main() {
    vec4 fg = texture2D(uFG, vUv);
    vec4 bg = texture2D(uBG, vUv);
    if (uKeyActive == 0) { gl_FragColor = fg; return; }

    vec3 hsv = rgb2hsv(fg.rgb);
    // Hue distance: 0 = exact match, 1 = opposite side of wheel
    float hueDist = abs(fract(hsv.x - uKeyHue + 0.5) - 0.5) * 2.0;
    // Alpha: 1 = keep FG, 0 = show BG (keyed out)
    float alpha = smoothstep(uKeyRange, uKeyRange + max(uKeySoftness, 0.001), hueDist);
    // Desaturated areas are not keyed out
    alpha = max(alpha, 1.0 - clamp(hsv.y * 4.0, 0.0, 1.0));
    gl_FragColor = mix(bg, fg, clamp(alpha, 0.0, 1.0));
  }
`;

export const COLOR_CORRECT = /* glsl */ `
  uniform sampler2D uTexture;
  uniform float uHue;    // hue shift in turns (-0.5 to 0.5)
  uniform float uSat;    // saturation multiplier (1 = unchanged)
  uniform float uBright; // brightness multiplier (1 = unchanged)
  uniform float uFlipH;  // 1 = horizontal mirror (layer mirror, folded in)
  varying vec2 vUv;

  vec3 rgb2hsv(vec3 c) {
    vec4 K = vec4(0.0, -1.0/3.0, 2.0/3.0, -1.0);
    vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
    vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
    float d = q.x - min(q.w, q.y);
    return vec3(abs(q.z + (q.w - q.y) / (6.0*d + 1e-10)), d / (q.x + 1e-10), q.x);
  }

  vec3 hsv2rgb(vec3 c) {
    vec4 K = vec4(1.0, 2.0/3.0, 1.0/3.0, 3.0);
    vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
    return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
  }

  void main() {
    vec2 uv = vUv;
    if (uFlipH > 0.5) uv.x = 1.0 - uv.x;
    vec4 col = texture2D(uTexture, uv);
    vec3 hsv = rgb2hsv(col.rgb);
    hsv.x = fract(hsv.x + uHue);
    hsv.y = clamp(hsv.y * uSat, 0.0, 1.0);
    hsv.z = clamp(hsv.z * uBright, 0.0, 1.0);
    gl_FragColor = vec4(hsv2rgb(hsv), col.a);
  }
`;

export const KALEIDOSCOPE = /* glsl */ `
  uniform sampler2D uTexture;
  uniform float uSegments;  // number of mirror segments (2-16)
  uniform float uRotation;  // 0-1 rotation of the pattern
  uniform vec2  uCenter;    // pivot, 0.5,0.5 = the old hardcoded middle
  uniform float uAspect;    // width / height, 1.0 reproduces the old behaviour
  uniform int   uEdge;      // 0 clamp, 1 mirror, 2 wrap, 3 black
  varying vec2 vUv;

${FEEDBACK_EDGE_GLSL}

  void main() {
    // Work in ASPECT-CORRECTED space. The old version measured angle and radius
    // in raw UV, where one unit across is a different number of pixels from one
    // unit down — so on any non-square output the wedges came out sheared and
    // the "circle" was an ellipse. Correcting on the way in and undoing it on
    // the way out keeps the sampling in the original frame.
    vec2 uv = (vUv - uCenter) * vec2(uAspect, 1.0);
    float angle = atan(uv.y, uv.x);
    float r     = length(uv);
    float seg   = 3.14159265 / max(1.0, uSegments);
    angle = mod(angle + uRotation * 3.14159265 * 2.0, seg * 2.0);
    if (angle > seg) angle = seg * 2.0 - angle; // mirror
    vec2 nuv = vec2(cos(angle), sin(angle)) * r / vec2(uAspect, 1.0) + uCenter;
    // Edge handling is a CHOICE now, not a fallback. It used to be fract(),
    // which wrapped a hard seam into everything outside the disc.
    gl_FragColor = fbSample(uTexture, nuv, uEdge);
  }
`;

export const VIGNETTE = /* glsl */ `
  uniform sampler2D uTexture;
  uniform float uAmount;   // 0=none, 1=full black edges
  uniform float uRadius;   // 0=center point, 1=edges (default ~0.6)
  uniform vec2  uCenter;   // 0.5,0.5 = the old hardcoded middle
  uniform vec3  uColor;    // what the edges fall TO — black by default
  varying vec2 vUv;
  void main() {
    vec4 c = texture2D(uTexture, vUv);
    vec2 uv = vUv - uCenter;
    float d  = length(uv * vec2(1.0, 0.85)); // slightly oval
    float vig = smoothstep(uRadius, uRadius - uAmount * 0.5, d);
    // mix TO the colour rather than multiplying by vig: identical at uColor =
    // black (mix(0,c,v) == c*v), and a real tint at any other colour.
    gl_FragColor = vec4(mix(uColor, c.rgb, vig), c.a);
  }
`;

// Bloom: two-pass separable Gaussian blur for bright pixels
export const BLOOM_EXTRACT = /* glsl */ `
  uniform sampler2D uTexture;
  uniform float uThreshold;  // 0-1 luminance threshold
  varying vec2 vUv;
  float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
  void main() {
    vec4 c = texture2D(uTexture, vUv);
    float l = luma(c.rgb);
    float w = smoothstep(uThreshold - 0.1, uThreshold + 0.1, l);
    gl_FragColor = vec4(c.rgb * w, 1.0);
  }
`;

export const BLOOM_BLUR = /* glsl */ `
  uniform sampler2D uTexture;
  uniform vec2      uDirection;  // (1,0) or (0,1)
  uniform vec2      uResolution;
  uniform float     uRadius;     // tap spacing multiplier, 1.0 = original
  varying vec2 vUv;
  void main() {
    // Widening the tap spacing rather than adding taps: the kernel weights stay
    // the same 9-tap Gaussian, so radius is nearly free. Far enough out it
    // undersamples into rings, which is why the parameter tops out at 4.
    vec2 texel = uDirection / uResolution * uRadius;
    vec4 c = vec4(0.0);
    // 9-tap Gaussian
    float w[5];
    w[0]=0.2270; w[1]=0.1945; w[2]=0.1216; w[3]=0.0540; w[4]=0.0162;
    c += texture2D(uTexture, vUv) * w[0];
    for (int i = 1; i <= 4; i++) {
      c += texture2D(uTexture, vUv + texel * float(i)) * w[i];
      c += texture2D(uTexture, vUv - texel * float(i)) * w[i];
    }
    gl_FragColor = c;
  }
`;

export const BLOOM_COMPOSITE = /* glsl */ `
  uniform sampler2D uTexture;   // original
  uniform sampler2D uBloom;     // blurred bright
  uniform float     uStrength;  // blend amount
  varying vec2 vUv;
  void main() {
    vec4 orig  = texture2D(uTexture, vUv);
    vec4 bloom = texture2D(uBloom,   vUv);
    gl_FragColor = vec4(orig.rgb + bloom.rgb * uStrength, orig.a);
  }
`;

// Variable-radius bokeh gather.
//
// BLOOM_BLUR cannot be reused and its own comment says why: it widens tap
// SPACING rather than adding taps, which is what makes its radius nearly free.
// That trick cannot work here — a bladed iris kernel is non-separable by
// definition — so this pass spends real taps distributed across a disc, and
// sample count is the cost knob.
//
// BOKEH_SAMPLES is a preprocessor constant, not a uniform, because GLSL ES 1.00
// requires CONSTANT loop bounds. Pipeline compiles one material per quality
// tier by prefixing this source with a #define; the #ifndef below only keeps
// the bare export compiling on its own.
export const BOKEH_GATHER = /* glsl */ `
  #ifndef BOKEH_SAMPLES
  #define BOKEH_SAMPLES 32
  #endif

  uniform sampler2D uTexture;
  uniform sampler2D uMask;
  uniform vec2      uResolution;
  uniform float     uRadius;      // max circle of confusion, in pixels
  uniform float     uFocus;       // 0-1 mask value that stays sharp
  uniform float     uFeather;     // 0-1 transition width around focus
  uniform float     uBlades;      // 0 = circle, else blade count
  uniform float     uIris;        // iris rotation, radians
  uniform float     uRing;        // -1..1 apodization
  uniform float     uHighlight;   // 0-1 highlight dominance
  uniform float     uThreshold;   // 0-1 what counts as a highlight

  varying vec2 vUv;

  const float GOLDEN = 2.39996323;
  const float PI     = 3.14159265;

  float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

  // Cheap per-pixel hash. Used to rotate the sample spiral, nothing else.
  float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }

  void main() {
    vec4 centre = texture2D(uTexture, vUv);

    // Focus is a PLANE, not a side: distance from the focus value in either
    // direction defocuses, so uFocus 0 and 1 cover both polarities of a mask
    // and a mid value keeps a band sharp. This is why there is no Invert.
    float m   = texture2D(uMask, vUv).r;
    float coc = smoothstep(0.0, max(uFeather, 0.001), abs(m - uFocus));

    float radiusPx = uRadius * coc;
    if (radiusPx < 0.5) { gl_FragColor = centre; return; }

    vec2 texel = radiusPx / uResolution;

    // Highlights must DOMINATE the disc, not average into it, or overlapping
    // discs turn to mush exactly where a real lens gives structure. Gathering
    // in a power space and taking the root back out preserves highlight energy,
    // so a bright sample survives being averaged with dark neighbours.
    float p    = 1.0 + uHighlight * 2.0;
    float invP = 1.0 / p;

    // Rotate the whole spiral by a per-pixel angle.
    //
    // Without this, every fragment samples the SAME set of offsets, so one
    // bright point lands on a regular lattice of output pixels and the disc
    // reads as a field of separate dots rather than a disc — worse the larger
    // the radius, because the same sample count is spread over an area that
    // grows with its square. Decorrelating the pattern per pixel converts that
    // structured aliasing into noise, which the eye reads as grain.
    //
    // Keyed on gl_FragCoord, so the pattern is STATIC: it does not crawl or
    // flicker between frames, which a time-seeded jitter would.
    float jitter = hash12(gl_FragCoord.xy) * 6.28318531;

    vec3  acc  = vec3(0.0);
    float wsum = 0.0;

    for (int i = 0; i < BOKEH_SAMPLES; i++) {
      float fi = float(i);

      // sqrt keeps the spiral EQUAL-AREA: without it the samples bunch toward
      // the centre and the disc reads as a soft blob rather than a disc.
      float t = (fi + 0.5) / float(BOKEH_SAMPLES);
      float r = sqrt(t);
      // uIris is deliberately NOT in here. It orients the POLYGON below, and
      // the jitter must not rotate that: a per-pixel iris rotation averages
      // every blade count back into a circle, so Blades would stop working
      // while still appearing to be set.
      float a = fi * GOLDEN + jitter;

      // Bladed iris: push the unit disc out to the polygon boundary at this
      // angle. uBlades 0 leaves it circular.
      if (uBlades >= 3.0) {
        // 'half' is a RESERVED word in GLSL ES 1.00 — naming this halfSeg is
        // not style, it is the difference between compiling and not.
        float seg     = 2.0 * PI / uBlades;
        float halfSeg = PI / uBlades;
        // Evaluated at (a - uIris), so the iris is fixed in SCREEN space and
        // turns only with uIris, while the samples inside it stay jittered.
        r *= cos(halfSeg) / cos(mod(a - uIris, seg) - halfSeg);
      }

      vec2 off = vec2(cos(a), sin(a)) * r * texel;
      vec3 c   = max(texture2D(uTexture, vUv + off).rgb, 0.0);

      // Apodization — where the energy sits across the disc. Positive puts a
      // bright rim on every highlight (spherical aberration, or a mirror lens)
      // and reads as nearly hollow at the extreme; negative is centre-weighted
      // and smooth. This is what separates an optical effect from a soft one.
      float w = 1.0;
      if (uRing >= 0.0) w = mix(1.0, pow(r, 4.0),      uRing);
      else              w = mix(1.0, 1.0 - r * r,     -uRing);

      // Threshold decides what is a specular worth blooming into a disc, so a
      // merely light-coloured region does not.
      float hl = smoothstep(uThreshold - 0.08, uThreshold + 0.08, luma(c));
      c *= 1.0 + uHighlight * 2.0 * hl;

      acc  += pow(c, vec3(p)) * w;
      wsum += w;
    }

    // wsum can go small when uRing drives the weights toward the rim.
    vec3 col = pow(acc / max(wsum, 0.0001), vec3(invP));
    gl_FragColor = vec4(col, centre.a);
  }
`;

// Quarter-resolution box downsample, for the wide-radius bokeh path.
//
// Four taps at ±1 full-res texel, each of which is itself a bilinear 2×2
// average — so this is a 4×4 box, not a point sample. That matters: a bare
// bilinear stretch into a quarter-res target only reads 4 of every 16 source
// pixels, which aliases, and aliasing in the SOURCE of a blur shows up as
// shimmer under motion rather than as softness.
export const BOKEH_DOWNSAMPLE = /* glsl */ `
  uniform sampler2D uTexture;
  uniform vec2      uTexel;   // 1 / full resolution
  varying vec2 vUv;
  void main() {
    vec4 c = texture2D(uTexture, vUv + uTexel * vec2(-1.0, -1.0))
           + texture2D(uTexture, vUv + uTexel * vec2( 1.0, -1.0))
           + texture2D(uTexture, vUv + uTexel * vec2(-1.0,  1.0))
           + texture2D(uTexture, vUv + uTexel * vec2( 1.0,  1.0));
    gl_FragColor = c * 0.25;
  }
`;

// Temporal smoothing for the bokeh mask.
//
// The gather is stateless — it answers the mask instantly, frame by frame, so
// defocus snaps on and off with every twitch of a motion matte. Easing the MASK
// instead of the picture makes the discs glide: focus drifts in and lets go
// rather than flicking, which is the whole character of a real focus pull.
//
// Symmetric on purpose. MOTION_MATTE already offers instant-attack /
// exponential-release through its own uDecay, so an asymmetric curve here would
// duplicate a control the mask source already has. This one eases BOTH
// directions, which is the part nothing else provides.
export const BOKEH_MASK_SLEW = /* glsl */ `
  uniform sampler2D uMask;   // this frame's mask
  uniform sampler2D uPrev;   // last frame's smoothed mask
  uniform float     uDecay;  // per-frame retention; 0 = follow instantly
  varying vec2 vUv;
  void main() {
    float m = texture2D(uMask, vUv).r;
    float p = texture2D(uPrev, vUv).r;
    gl_FragColor = vec4(vec3(mix(m, p, uDecay)), 1.0);
  }
`;

// Full-res composite for the half-res gather.
//
// This exists so half-res gathering costs nothing in the SHARP regions: an
// in-focus pixel takes the full-res original verbatim and never sees the
// downsampled buffer. The defocus term is recomputed here rather than passed
// through the gather's output, because a half-res alpha channel would carry
// the same downsampling the composite is here to avoid.
export const BOKEH_COMPOSITE = /* glsl */ `
  uniform sampler2D uTexture;   // original, full resolution
  uniform sampler2D uBokeh;     // gathered, half resolution
  uniform sampler2D uDiscs;     // gathered HIGHLIGHTS, half resolution
  uniform sampler2D uMask;
  uniform float     uFocus;
  uniform float     uFeather;
  uniform float     uAmount;    // master, crossfades the whole effect
  uniform float     uDiscAmt;   // how hard the highlight discs are added back
  varying vec2 vUv;
  void main() {
    vec4  orig = texture2D(uTexture, vUv);
    vec3  blur = texture2D(uBokeh,   vUv).rgb;
    float m    = texture2D(uMask,    vUv).r;
    float coc  = smoothstep(0.0, max(uFeather, 0.001), abs(m - uFocus));

    vec3 col = mix(orig.rgb, blur, coc * uAmount);

    // Discs are ADDED, not averaged, and that is the whole reason this branch
    // exists. Spreading a point across a disc divides its energy by the sample
    // count: measured, a 4px highlight over a 12px radius peaks at 13/255 —
    // a disc too faint to see against anything. Adding the gathered highlights
    // back with gain restores what the averaging took out.
    //
    // Scaled by coc so a highlight that is still in FOCUS does not sprout a
    // disc it has no business having.
    col += texture2D(uDiscs, vUv).rgb * uDiscAmt * coc * uAmount;

    gl_FragColor = vec4(col, orig.a);
  }
`;

export const BUFFER_TRANSFORM = /* glsl */ `
  uniform sampler2D uTexture;
  uniform float uPanX;
  uniform float uPanY;
  uniform float uScale;
  varying vec2 vUv;
  void main() {
    vec2 uv = (vUv - 0.5 - vec2(uPanX, uPanY)) / max(uScale, 0.001) + 0.5;
    gl_FragColor = texture2D(uTexture, uv);
  }
`;

// ─── Pixel Sort ────────────────────────────────────────────────────────────────
// Approximates pixel-sorting by reading a strip of N pixels from the input
// and replacing each sample with the min/max brightness pixel in a window.
// uDirection: 0=vertical columns, 1=horizontal rows
// uThreshold: luminance threshold — pixels below threshold are unsorted "anchors"
// uLength:    sort window length (1–512 px)
export const PIXEL_SORT = /* glsl */ `
  uniform sampler2D uTexture;
  uniform vec2  uResolution;
  uniform float uThreshold;   // 0–1 luminance anchor point
  uniform float uLength;      // sort window size in pixels
  uniform float uDirection;   // 0=vertical, 1=horizontal
  uniform float uMode;        // 0=light→dark, 1=dark→light
  varying vec2 vUv;

  float luma(vec3 c) {
    return dot(c, vec3(0.2126, 0.7152, 0.0722));
  }

  void main() {
    vec2 res  = uResolution;
    vec2 step = uDirection < 0.5
      ? vec2(0.0, 1.0 / res.y)   // vertical
      : vec2(1.0 / res.x, 0.0);  // horizontal

    vec4 src  = texture2D(uTexture, vUv);
    float l   = luma(src.rgb);

    // If this pixel is below threshold → it's an anchor, no sort
    if (l < uThreshold) {
      gl_FragColor = src;
      return;
    }

    // Sample a window of ±N/2 pixels and find the sorted replacement
    int halfLen = int(uLength * 0.5);
    vec4 best = src;
    float bestL = uMode < 0.5 ? -1.0 : 2.0; // looking for max (mode=0) or min (mode=1)

    for (int i = -128; i <= 128; i++) {
      if (i < -halfLen || i > halfLen) continue;
      vec2 uv2 = vUv + float(i) * step;
      if (uv2.x < 0.0 || uv2.x > 1.0 || uv2.y < 0.0 || uv2.y > 1.0) continue;
      vec4 s  = texture2D(uTexture, uv2);
      float sl = luma(s.rgb);
      if (sl < uThreshold) break; // hit an anchor — stop window
      if (uMode < 0.5) {
        if (sl > bestL) { bestL = sl; best = s; } // brightest
      } else {
        if (sl < bestL) { bestL = sl; best = s; } // darkest
      }
    }

    gl_FragColor = best;
  }
`;

// ─── Film Grain ────────────────────────────────────────────────────────────────
// Adds animated film grain and optional scanlines overlay.
// uGrain:     0–1 grain amount
// uScanlines: 0–1 scanline intensity
// uTime:      frame time for animated noise
export const FILM_GRAIN = /* glsl */ `
  uniform sampler2D uTexture;
  uniform float uGrain;
  uniform float uScanlines;
  uniform float uCount;      // scanline count over the frame height
  uniform float uTime;
  varying vec2 vUv;

  float hash(vec2 p) {
    p = fract(p * vec2(443.897, 441.423));
    p += dot(p, p + 19.19);
    return fract(p.x * p.y);
  }

  void main() {
    vec4 col = texture2D(uTexture, vUv);

    // Grain
    if (uGrain > 0.0) {
      // The seed used to be vUv + fract(uTime * 0.017) — the SAME offset on
      // both axes, which slides one fixed noise field diagonally instead of
      // drawing a new one. That reads as grain crawling across the picture
      // rather than scintillating in place. Decorrelating the two axes and
      // using a large multiplier gives an independent field per frame.
      float n = hash(vUv * 1024.0 + vec2(fract(uTime * 71.7) * 512.0,
                                         fract(uTime * 37.3) * 512.0));
      n = (n - 0.5) * 2.0; // centre around 0
      col.rgb += n * uGrain * 0.25;
    }

    // Scanlines — uCount was hardcoded at 400 regardless of output size, so the
    // line pitch meant something different on every display and moiréd against
    // some of them. It is a parameter now; the default is still 400.
    if (uScanlines > 0.0) {
      float line = sin(vUv.y * uCount) * 0.5 + 0.5;
      float mask = 1.0 - uScanlines * (1.0 - line) * 0.4;
      col.rgb *= mask;
    }

    gl_FragColor = vec4(clamp(col.rgb, 0.0, 1.0), col.a);
  }
`;

// ─── Polar ────────────────────────────────────────────────────────────────────
// Maps the frame between rectangular and polar coordinates. Cheap, and it turns
// every other effect in the chain into a different one — a horizontal scanline
// becomes a ring, a vertical wipe becomes a sweep.
// uMode 0: rect→polar (the picture wraps around the centre)
// uMode 1: polar→rect (the inverse — unrolls a radial picture into a strip)
export const POLAR = /* glsl */ `
  uniform sampler2D uTexture;
  uniform int   uMode;
  uniform float uAmount;   // 0..1 blend with the untransformed picture
  uniform float uRotate;   // turns
  uniform vec2  uCenter;
  uniform float uAspect;
  uniform int   uEdge;
  varying vec2 vUv;

${FEEDBACK_EDGE_GLSL}

  void main() {
    vec2 src = vUv;
    vec2 dst;
    float TAU = 6.28318530718;

    if (uMode == 0) {
      // rect → polar: x becomes angle, y becomes radius.
      vec2 d = (src - uCenter) * vec2(uAspect, 1.0);
      float a = atan(d.y, d.x) / TAU + 0.5 + uRotate;
      float r = length(d) * 2.0;
      dst = vec2(fract(a), clamp(r, 0.0, 1.0));
    } else {
      // polar → rect: read the picture as (angle, radius) and lay it flat.
      float a = (src.x + uRotate) * TAU;
      float r = src.y * 0.5;
      dst = vec2(cos(a), sin(a)) * r / vec2(uAspect, 1.0) + uCenter;
    }

    vec4 warped = fbSample(uTexture, dst, uEdge);
    gl_FragColor = mix(texture2D(uTexture, src), warped, uAmount);
  }
`;

// ─── Wave ─────────────────────────────────────────────────────────────────────
// Sine displacement on both axes. The oldest gesture in the instrument's
// lineage, and the one that most rewards an LFO on its phase.
export const WAVE = /* glsl */ `
  uniform sampler2D uTexture;
  uniform float uAmpX;    // UV displacement
  uniform float uAmpY;
  uniform float uFreqX;
  uniform float uFreqY;
  uniform float uPhase;   // radians
  uniform int   uEdge;
  varying vec2 vUv;

${FEEDBACK_EDGE_GLSL}

  void main() {
    // Each axis is driven by the OTHER axis's coordinate — displacing x by
    // sin(x) only stretches the picture along its own direction and reads as a
    // smear. Driving x by sin(y) is what makes it a wave you can see.
    vec2 uv = vUv;
    uv.x += sin(vUv.y * uFreqX + uPhase) * uAmpX;
    uv.y += sin(vUv.x * uFreqY + uPhase) * uAmpY;
    gl_FragColor = fbSample(uTexture, uv, uEdge);
  }
`;

// ─── Halftone ─────────────────────────────────────────────────────────────────
// Ordered dot screen. Pairs with Post.Levels, and it is the one effect here that
// reads BETTER on a projector than on a monitor.
export const HALFTONE = /* glsl */ `
  uniform sampler2D uTexture;
  uniform float uAmount;
  uniform float uSize;      // dot pitch in pixels
  uniform float uAngle;     // screen angle in radians
  uniform int   uMode;      // 0 mono, 1 per-channel (colour separation)
  uniform vec2  uResolution;
  varying vec2 vUv;

  float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

  // Distance from the centre of the nearest cell, 0 at centre, ~1 at corner.
  float cellDist(vec2 pos, float ang) {
    float ca = cos(ang), sa = sin(ang);
    vec2 r = vec2(ca * pos.x - sa * pos.y, sa * pos.x + ca * pos.y);
    return length(fract(r) - 0.5) * 2.0;
  }

  void main() {
    vec4 c = texture2D(uTexture, vUv);
    if (uAmount <= 0.0) { gl_FragColor = c; return; }
    vec2 pos = vUv * uResolution / max(uSize, 1.0);

    vec3 dots;
    if (uMode == 1) {
      // Classic separation: each channel gets its own screen angle, which is
      // what stops the three grids beating against each other into moiré.
      dots = vec3(
        step(cellDist(pos, uAngle),              c.r * 1.4),
        step(cellDist(pos, uAngle + 0.4014),     c.g * 1.4),
        step(cellDist(pos, uAngle + 0.8029),     c.b * 1.4)
      );
    } else {
      dots = vec3(step(cellDist(pos, uAngle), luma(c.rgb) * 1.4));
    }
    gl_FragColor = vec4(mix(c.rgb, dots, uAmount), c.a);
  }
`;

// ─── Duotone ──────────────────────────────────────────────────────────────────
// Remaps luminance through a two-colour ramp. Not a tint: shadows go to one
// hue and highlights to the other, which is why it survives being fed back.
export const DUOTONE = /* glsl */ `
  uniform sampler2D uTexture;
  uniform float uAmount;
  uniform vec3  uDark;
  uniform vec3  uLight;
  varying vec2 vUv;
  float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
  void main() {
    vec4 c = texture2D(uTexture, vUv);
    if (uAmount <= 0.0) { gl_FragColor = c; return; }
    vec3 mapped = mix(uDark, uLight, luma(c.rgb));
    gl_FragColor = vec4(mix(c.rgb, mapped, uAmount), c.a);
  }
`;

// ─── Lens ─────────────────────────────────────────────────────────────────────
// Barrel/pincushion on one signed control, plus twirl. With Scanlines it is a
// CRT; with Halftone it is a printed page photographed off one.
export const LENS = /* glsl */ `
  uniform sampler2D uTexture;
  uniform float uDistort;  // <0 pincushion, 0 none, >0 barrel
  uniform float uTwirl;    // turns at the centre, falling to 0 by half-radius
  uniform vec2  uCenter;
  uniform float uAspect;
  uniform int   uEdge;
  varying vec2 vUv;

${FEEDBACK_EDGE_GLSL}

  void main() {
    vec2 d = (vUv - uCenter) * vec2(uAspect, 1.0);
    float r = length(d);

    // Twirl first: rotate by an amount that falls off with radius, so the
    // centre winds up and the rim stays put. The falloff reaches zero at
    // r = 0.5, not at the frame edge, so the corners are never twisted.
    if (uTwirl != 0.0) {
      float a = uTwirl * 6.28318530718 * (1.0 - clamp(r * 2.0, 0.0, 1.0));
      float ca = cos(a), sa = sin(a);
      d = vec2(ca * d.x - sa * d.y, sa * d.x + ca * d.y);
    }

    // Then the radial polynomial. r*r keeps the centre linear, which is what
    // makes a small amount read as a lens rather than as a zoom.
    d *= 1.0 + uDistort * r * r;

    vec2 uv = d / vec2(uAspect, 1.0) + uCenter;
    gl_FragColor = fbSample(uTexture, uv, uEdge);
  }
`;

// ─── Feedback Rotate/Zoom ─────────────────────────────────────────────────────
// Applies a centred rotation and/or zoom to the feedback (prev) texture
// before it is blended, creating spiral and vortex effects.
// uAngle: rotation in turns (0–1 = 0–360°)
// uZoom:  zoom factor centred on 0.5,0.5 (1=no change, >1=zoom in, <1=zoom out)
export const FEEDBACK_ROTATE = /* glsl */ `
  uniform sampler2D uTexture;
  uniform float uAngle;  // turns
  uniform float uZoom;
  uniform vec2  uCenter; // pivot for both, 0.5,0.5 = the old hardcoded middle
  uniform int   uEdge;
  varying vec2 vUv;

${FEEDBACK_EDGE_GLSL}

  void main() {
    float a   = uAngle * 6.28318530718;
    float ca  = cos(a);
    float sa  = sin(a);
    vec2  uv  = vUv - uCenter;
    uv = vec2(ca * uv.x - sa * uv.y, sa * uv.x + ca * uv.y);
    float z   = max(0.001, uZoom);
    uv  = uv / z + uCenter;
    gl_FragColor = fbSample(uTexture, uv, uEdge);
  }
`;

// ─── Quad Mirror ───────────────────────────────────────────────────────────────
// 4-way symmetry: folds UV into the top-left quadrant and mirrors all four.
// uMode: 0=quad 4-way, 1=diagonal (top-left triangle reflected to all 4 triangles)
export const QUAD_MIRROR = /* glsl */ `
  uniform sampler2D uTexture;
  uniform float uMode;
  varying vec2 vUv;

  void main() {
    vec2 uv = vUv;

    if (uMode < 0.5) {
      // 4-way: fold into top-left quadrant
      vec2 f = abs(uv * 2.0 - 1.0);
      uv = f * 0.5;
    } else {
      // Diagonal: fold along both diagonals
      if (uv.x + uv.y > 1.0) uv = 1.0 - uv;
      if (uv.x > uv.y)       uv = vec2(uv.y, uv.x);
      uv = uv * 2.0;
    }

    gl_FragColor = texture2D(uTexture, clamp(uv, 0.0, 1.0));
  }
`;

// ─── 3D LUT colour grade ──────────────────────────────────────────────────────
// Applies a 3D colour look-up table encoded as a 2D texture strip.
// uLUT:    2D texture (N*N wide, N tall) — horizontal slices of the 3D cube
// uLUTSize: cube edge length N (e.g. 17 or 33)
// uAmount: 0–1 blend between original and graded colour
export const LUT3D = /* glsl */ `
  uniform sampler2D uTexture;
  uniform sampler2D uLUT;
  uniform float     uLUTSize;  // cube edge N
  uniform float     uAmount;   // blend 0–1
  varying vec2 vUv;

  vec3 sampleLUT(vec3 col) {
    float N   = uLUTSize;
    float scale = (N - 1.0) / N;
    float offset = 0.5 / N;

    // clamp to [0,1]
    col = clamp(col, 0.0, 1.0);

    // Map into [offset, scale+offset] — texel CENTRES within one N-wide slice.
    float r = col.r * scale + offset;
    float g = col.g * scale + offset;

    // The texture is laid out as N horizontal slices each N×N pixels.
    // Total texture size: (N*N) wide × N tall.
    // The slice index comes from the RAW blue, not the centre-mapped one:
    // feeding the scaled+offset value in here compressed the blue axis by
    // (N-1)/N and shifted it, so pure blue never reached the last slice.
    float bSlice  = col.b * (N - 1.0);
    float bFloor  = floor(bSlice);
    float bFrac   = bSlice - bFloor;
    float bNext   = min(bFloor + 1.0, N - 1.0);

    // UV for floor slice
    float sliceW  = 1.0 / N;
    float uBase0  = bFloor * sliceW + r * sliceW;
    float uBase1  = bNext  * sliceW + r * sliceW;
    float vCoord  = g;

    vec3 c0 = texture2D(uLUT, vec2(uBase0, vCoord)).rgb;
    vec3 c1 = texture2D(uLUT, vec2(uBase1, vCoord)).rgb;
    return mix(c0, c1, bFrac);
  }

  void main() {
    vec4 col = texture2D(uTexture, vUv);
    vec3 graded = sampleLUT(col.rgb);
    gl_FragColor = vec4(mix(col.rgb, graded, uAmount), col.a);
  }
`;

// ─── Levels ───────────────────────────────────────────────────────────────────
// Adjusts black point, white point, gamma (lift-gamma-gain style).
export const LEVELS = /* glsl */ `
  uniform sampler2D uTexture;
  uniform float uBlack;  // 0–1 input black point
  uniform float uWhite;  // 0–1 input white point
  uniform float uGamma;  // gamma (1=neutral, <1=lighten, >1=darken)
  varying vec2 vUv;

  void main() {
    vec4 col = texture2D(uTexture, vUv);
    vec3 c = clamp((col.rgb - uBlack) / max(uWhite - uBlack, 0.001), 0.0, 1.0);
    c = pow(c, vec3(1.0 / max(uGamma, 0.001)));
    gl_FragColor = vec4(c, col.a);
  }
`;

// ─── White Balance / Temperature ──────────────────────────────────────────────
// uTemperature: -100 (warm/orange) to +100 (cool/blue)
// uTint:        -100 (green) to +100 (magenta)
export const WHITE_BALANCE = /* glsl */ `
  uniform sampler2D uTexture;
  uniform float uTemperature; // -100..100
  uniform float uTint;        // -100..100
  varying vec2 vUv;

  void main() {
    vec4 col = texture2D(uTexture, vUv);
    vec3 c = col.rgb;

    // Temperature: shift red-blue axis
    float t = uTemperature / 100.0; // -1..1
    c.r += t * 0.2;
    c.b -= t * 0.2;

    // Tint: shift green-magenta axis
    float m = uTint / 100.0; // -1..1
    c.g -= m * 0.15;
    c.r += m * 0.07;
    c.b += m * 0.07;

    gl_FragColor = vec4(clamp(c, 0.0, 1.0), col.a);
  }
`;

// ── TimeWarp ──────────────────────────────────────────────────────────────────
// Strip-based temporal slit-scan readout. Used by SequenceBuffer timewarp mode.
// Reads the strip RT (one column per captured frame) and assembles a full output
// frame with axis, flip, scroll-offset, and cubic time-warp controls.

export const TIMEWARP = /* glsl */ `
  uniform sampler2D tStrip;   // strip RT — one column per captured frame
  uniform sampler2D tLive;    // live input for mix-in
  uniform float uMix;         // 0 = all live, 1 = all strip
  uniform int   uAxis;        // 0 = Horizontal (time along X), 1 = Vertical (time along Y)
  uniform float uFlip;        // 1.0 = reverse time direction
  uniform float uOffset;      // temporal scroll offset [0, 1)
  uniform float uWarp;        // cubic time-warp 0..1
  varying vec2 vUv;

  void main() {
    float coord = (uAxis == 0) ? vUv.x : vUv.y;
    if (uFlip > 0.5) coord = 1.0 - coord;
    coord = fract(coord + uOffset);

    if (uWarp > 0.001) {
      float t    = coord * 2.0 - 1.0;
      float bent = t * (1.0 - uWarp * 0.5 * t * t);
      coord = clamp(bent * 0.5 + 0.5, 0.0, 1.0);
    }

    vec2 stripUv = (uAxis == 0)
      ? vec2(coord, vUv.y)
      : vec2(vUv.x, coord);

    vec4 warped = texture2D(tStrip, stripUv);
    vec4 live   = texture2D(tLive,  vUv);
    gl_FragColor = mix(live, warped, uMix);
  }
`;

// ─────────────────────────────────────────────────────────────────────────────
// MIXBUS — dual-deck A/B movie mix (v0.12)
// uFG = Deck A, uBG = Deck B. uXfade 0 = pure Deck A (back-compat default),
// 1 = full mode result. Mode list is APPEND-ONLY (persisted SELECT indices).
// ─────────────────────────────────────────────────────────────────────────────

export const MIXBUS = /* glsl */ `
  uniform sampler2D uFG;    // Deck A
  uniform sampler2D uBG;    // Deck B
  uniform int   uMode;      // 0 Crossfade, 1 Add, 2 Multiply, 3 Luma Mask, 4 Displace
  uniform float uXfade;
  uniform float uDispAmt;
  uniform float uMaskLo;
  uniform float uMaskHi;

  varying vec2 vUv;

  float lumaOf(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }

  void main() {
    vec3 a = texture2D(uFG, vUv).rgb;
    vec3 b = texture2D(uBG, vUv).rgb;

    vec3 res = b; // 0: Crossfade
    if (uMode == 1) {
      res = min(a + b, 1.0);                                    // Add
    } else if (uMode == 2) {
      res = a * b;                                              // Multiply
    } else if (uMode == 3) {
      float m = smoothstep(uMaskLo, uMaskHi, lumaOf(b));        // Luma Mask
      res = mix(a, b, m);
    } else if (uMode == 4) {
      float lb = lumaOf(b);                                     // Displace
      res = texture2D(uFG, vUv + (lb - 0.5) * uDispAmt).rgb;
    }

    gl_FragColor = vec4(mix(a, res, uXfade), 1.0);
  }
`;
