/**
 * SDF Looks — named, tested starting points for the SDF generator.
 *
 * Pure data, so ParameterSystem can build the `sdf.look` menu from it without
 * importing the generator (and three.js with it). main.js applies a Look by
 * writing every value below.
 *
 * A Look writes EVERY value that shapes the result, not just the ones it cares
 * about — the same rule as GROWTH_LOOKS, for the same reason: a leftover Twist
 * or Fold from whatever was on screen before turns a named Look into something
 * else, and the menu then lies. That is what LOOK_BASE is for: it is every
 * `sdf.*` default, and each Look spreads it before stating its differences.
 * tests/audit-sdf-looks.mjs holds LOOK_BASE to the registered defaults, so a
 * param added later cannot be forgotten here.
 *
 * Deliberately NOT written by a Look, because they are stage settings that
 * should hold across Looks rather than part of any one:
 *   sdf.active      — main.js switches the generator on when a Look is picked;
 *   sdf.texSrc      — which picture is on the surface (routing);
 *   sdf.refractSrc  — which picture is behind the glass (routing);
 *   sdf.rscale      — Detail, a quality setting that depends on the machine.
 *
 * Values are param values as the panel shows them (degrees, not radians).
 * sdf.shape:  0 Sphere 1 Box 2 Torus 3 Capsule 4 Hex Prism 5 Octahedron 6 Link
 *             7 Mandelbulb 8 Cylinder 9 Cone 10 Gyroid 11 Helicoid 12 Catenoid
 * sdf.shapeB: 0 is "Same as A", then the list above shifted up by one.
 * sdf.opMode: 0 Union 1 Smooth Union 2 Subtraction 3 Intersection
 * sdf.motion: 0 Orbit 1 Lissajous 2 Swarm 3 Pulse
 *
 * APPEND-ONLY — sdf.look persists the index.
 */

const LOOK_BASE = {
  'sdf.opMode': 0, 'sdf.opAmount': 0.5, 'sdf.distance': 1.5, 'sdf.shape': 0, 'sdf.shapeB': 0,
  'sdf.morph': 0, 'sdf.count': 2, 'sdf.motion': 0, 'sdf.vary': 0, 'sdf.size': 1,
  'sdf.tile': 0, 'sdf.repeat': 3, 'sdf.warp': 0, 'sdf.warpMode': 0, 'sdf.twist': 0,
  'sdf.orbitX': 0, 'sdf.orbitY': 0, 'sdf.camDist': 5, 'sdf.moveX': 0, 'sdf.moveY': 0, 'sdf.moveZ': 0,
  'sdf.fov': 74, 'sdf.depthRange': 1, 'sdf.steps': 96,
  'sdf.kifsIter': 0, 'sdf.kifsAngle': 0, 'sdf.kifsScale': 1, 'sdf.kifsOffset': 1,
  'sdf.lumaWarp': 0, 'sdf.speed': 0.2, 'sdf.lumaThresh': 0.2, 'sdf.texBlend': 0.8, 'sdf.ao': 0.5,
  'sdf.glow': 0, 'sdf.glowHue': 274, 'sdf.glowSize': 0.4, 'sdf.glowSat': 0.875, 'sdf.glowVal': 0.8,
  'sdf.glowHue2': 274, 'sdf.glowSat2': 0.875, 'sdf.glowVal2': 0.8, 'sdf.glowEnv': 0,
  'sdf.envAmt': 1, 'sdf.selfReflect': 0, 'sdf.reflectAmt': 0.5, 'sdf.reflectRange': 6, 'sdf.reflectDetail': 0.5,
  'sdf.lightAz': 27, 'sdf.lightEl': 34, 'sdf.shadow': 0,
  'sdf.hue': 0, 'sdf.sat': 0, 'sdf.val': 1,
  'sdf.refract': 0, 'sdf.glassSolid': 0, 'sdf.dispersion': 0, 'sdf.fresnel': 0.5,
};

export const SDF_LOOKS = [
  // 0 — the registered defaults: two spheres on the old orbit. A real Look, not
  // a heading: picking it is the clean reset.
  { name: 'Default', values: { ...LOOK_BASE } },

  // Warm blobs that wander, meet and part. Swarm + a wide Smooth Union is the
  // whole effect; Variation keeps the blobs from being six copies of one.
  { name: 'Lava Lamp', values: { ...LOOK_BASE,
    'sdf.count': 6, 'sdf.motion': 2, 'sdf.opMode': 1, 'sdf.opAmount': 0.5,
    'sdf.distance': 3.8, 'sdf.size': 0.95, 'sdf.vary': 0.5, 'sdf.speed': 0.35,
    'sdf.camDist': 3.8,
    'sdf.texBlend': 0, 'sdf.hue': 14, 'sdf.sat': 0.85, 'sdf.val': 1,
    'sdf.ao': 0.35, 'sdf.shadow': 0.35, 'sdf.fresnel': 0.35, 'sdf.envAmt': 0,
    'sdf.glow': 0.45, 'sdf.glowHue': 28, 'sdf.glowSat': 0.9, 'sdf.glowVal': 1,
    'sdf.glowHue2': 330, 'sdf.glowSat2': 0.9, 'sdf.glowVal2': 0.7, 'sdf.glowSize': 0.7,
    'sdf.lightAz': 20, 'sdf.lightEl': 40,
  } },

  // Clear glass balls, each showing the surround small and upside down, with a
  // colour fringe. Needs something on Refract Src to be worth looking at.
  { name: 'Crystal Balls', values: { ...LOOK_BASE,
    'sdf.count': 5, 'sdf.motion': 1, 'sdf.opMode': 1, 'sdf.opAmount': 0.15,
    'sdf.distance': 3.4, 'sdf.size': 1.15, 'sdf.vary': 0.45, 'sdf.speed': 0.18,
    'sdf.texBlend': 0, 'sdf.sat': 0, 'sdf.val': 1, 'sdf.ao': 0,
    'sdf.refract': 0.92, 'sdf.glassSolid': 1, 'sdf.dispersion': 0.45,
    'sdf.fresnel': 0.7, 'sdf.envAmt': 1, 'sdf.lightAz': 40, 'sdf.lightEl': 50,
    'sdf.camDist': 4,
  } },

  // Branching, grown-looking mass: one fold for the branching, Organic warp
  // for the surface, deep occlusion and shadow for the crevices.
  { name: 'Coral', values: { ...LOOK_BASE,
    'sdf.shape': 3, 'sdf.shapeB': 3, 'sdf.morph': 0.4, 'sdf.count': 5,
    'sdf.opMode': 1, 'sdf.opAmount': 0.45, 'sdf.distance': 2.2, 'sdf.size': 1.25,
    'sdf.vary': 0.6, 'sdf.speed': 0.08,
    'sdf.kifsIter': 1, 'sdf.kifsAngle': 38, 'sdf.kifsScale': 1, 'sdf.kifsOffset': 0.75,
    'sdf.warp': 0.22, 'sdf.warpMode': 1,
    'sdf.texBlend': 0, 'sdf.hue': 10, 'sdf.sat': 0.7, 'sdf.val': 1,
    'sdf.ao': 0.85, 'sdf.shadow': 0.6, 'sdf.fresnel': 0.2, 'sdf.envAmt': 0,
    'sdf.orbitX': 25, 'sdf.orbitY': 20, 'sdf.camDist': 4.4, 'sdf.steps': 160,
    'sdf.lightAz': 60, 'sdf.lightEl': 45,
  } },

  // An endless field of differing solids, fading with distance. Variation is
  // what stops it being wallpaper; Move Z is the control to fly through it.
  { name: 'Lattice', values: { ...LOOK_BASE,
    'sdf.tile': 1, 'sdf.repeat': 3.2, 'sdf.shape': 1, 'sdf.shapeB': 6, 'sdf.morph': 0.25,
    'sdf.count': 2, 'sdf.distance': 1.3, 'sdf.size': 0.8, 'sdf.vary': 0.8,
    'sdf.opMode': 1, 'sdf.opAmount': 0.2, 'sdf.speed': 0.15, 'sdf.twist': 0.35,
    'sdf.texBlend': 0, 'sdf.hue': 205, 'sdf.sat': 0.45, 'sdf.val': 1,
    'sdf.ao': 0.5, 'sdf.shadow': 0.5, 'sdf.fresnel': 0.4, 'sdf.envAmt': 0,
    'sdf.glow': 0.2, 'sdf.glowHue': 200, 'sdf.glowHue2': 260, 'sdf.glowSize': 0.5,
    'sdf.orbitX': 18, 'sdf.orbitY': 14, 'sdf.camDist': 6, 'sdf.steps': 220,
    'sdf.lightAz': 50, 'sdf.lightEl': 40,
  } },

  // The picture wrapped on a twisted, breathing form: Pulse gathers the three
  // parts into one mass and throws them out again.
  { name: 'Video Helix', values: { ...LOOK_BASE,
    'sdf.shape': 1, 'sdf.shapeB': 3, 'sdf.morph': 0.5, 'sdf.count': 3, 'sdf.motion': 3,
    'sdf.opMode': 1, 'sdf.opAmount': 0.3, 'sdf.distance': 3.4, 'sdf.size': 1.5,
    'sdf.twist': 1.1, 'sdf.speed': 0.25, 'sdf.camDist': 3.6,
    'sdf.texBlend': 1, 'sdf.sat': 0, 'sdf.val': 1,
    'sdf.ao': 0.5, 'sdf.shadow': 0.4, 'sdf.fresnel': 0.3,
    'sdf.orbitX': 20, 'sdf.orbitY': 15, 'sdf.steps': 160,
    'sdf.lightAz': 35, 'sdf.lightEl': 40,
  } },

  // Thin clear bubbles drifting on their own, each edged with a rainbow
  // fringe. The flat lens, not Solid Glass: a bubble is a skin, not a ball.
  { name: 'Bubbles', values: { ...LOOK_BASE,
    'sdf.count': 7, 'sdf.motion': 2, 'sdf.opMode': 1, 'sdf.opAmount': 0.08,
    'sdf.distance': 4.2, 'sdf.size': 0.9, 'sdf.vary': 0.8, 'sdf.speed': 0.2,
    'sdf.texBlend': 0, 'sdf.sat': 0, 'sdf.val': 1, 'sdf.ao': 0,
    'sdf.refract': 0.85, 'sdf.dispersion': 1, 'sdf.fresnel': 1, 'sdf.envAmt': 1,
    'sdf.glow': 0.2, 'sdf.glowHue': 190, 'sdf.glowSat': 0.5, 'sdf.glowVal': 1,
    'sdf.glowHue2': 300, 'sdf.glowSat2': 0.7, 'sdf.glowVal2': 0.8, 'sdf.glowSize': 0.25,
    'sdf.camDist': 4, 'sdf.lightAz': 30, 'sdf.lightEl': 55,
  } },

  // A spiky geode: three kaleidoscopic folds of an octahedron, lit hard so
  // the facets read.
  { name: 'Amethyst', values: { ...LOOK_BASE,
    'sdf.shape': 5, 'sdf.count': 2, 'sdf.distance': 1.2, 'sdf.size': 1.1, 'sdf.speed': 0.12,
    'sdf.opMode': 1, 'sdf.opAmount': 0.25,
    'sdf.kifsIter': 3, 'sdf.kifsAngle': 42, 'sdf.kifsScale': 1.15, 'sdf.kifsOffset': 0.8,
    'sdf.texBlend': 0, 'sdf.hue': 285, 'sdf.sat': 0.6, 'sdf.val': 1,
    'sdf.ao': 0.9, 'sdf.shadow': 0.7, 'sdf.fresnel': 0.5, 'sdf.envAmt': 0,
    'sdf.glow': 0.3, 'sdf.glowHue': 300, 'sdf.glowHue2': 200, 'sdf.glowSize': 0.5,
    'sdf.orbitX': 30, 'sdf.orbitY': 25, 'sdf.camDist': 8, 'sdf.steps': 200,
    'sdf.lightAz': 80, 'sdf.lightEl': 35,
  } },
];
