/**
 * Noise recipes — named combinations of the Noise generator's stages.
 *
 * A recipe is only a set of noise.* values. Recalling one first returns every
 * noise param to its default and then applies the recipe's own values, so a
 * recipe is COMPLETE: the look does not depend on what was set before. After
 * that the params are ordinary — every one stays editable and mappable, and
 * Save captures the edited result as a user recipe.
 *
 * The reset includes the two colours, so one recipe's palette cannot leak into
 * the next. Kept out of it: Resolution (a performance choice, not a look) and
 * the recipe selector itself.
 *
 * User recipes live in localStorage, so they are per-origin like the GLSL user
 * presets — "lost recipes" on another port is a different origin, not data loss.
 */

const USER_KEY = 'imweb.noiseRecipes';

// Only non-default values are listed; applyRecipe() fills in the rest.
export const NOISE_RECIPES = {
  'Clouds':         { 'noise.type': 1, 'noise.octaves': 6, 'noise.contrast': 1.2 },
  'Marble':         { 'noise.type': 9, 'noise.family': 2, 'noise.warp': 1.2, 'noise.warpMode': 1,
                      'noise.warpScale': 0.5 },
  'Wood Rings':     { 'noise.type': 9, 'noise.family': 2, 'noise.coords': 1, 'noise.rotate': 90,
                      'noise.scale': 12, 'noise.warp': 0.35, 'noise.warpScale': 0.6 },
  'Topography':     { 'noise.type': 1, 'noise.octaves': 5, 'noise.bands': 8 },
  'Electric':       { 'noise.type': 1, 'noise.fractal': 3, 'noise.octaves': 6, 'noise.gamma': 2.2,
                      'noise.warp': 0.3 },
  'Smoke':          { 'noise.type': 2, 'noise.fractal': 2, 'noise.octaves': 6, 'noise.warp': 1,
                      'noise.warpMode': 2 },
  'Cracked Earth':  { 'noise.type': 1, 'noise.fractal': 3, 'noise.octaves': 5, 'noise.combine': 3,
                      'noise.amount': 1, 'noise.b.type': 6, 'noise.b.scale': 7, 'noise.cellOut': 2,
                      'noise.width': 0.08, 'noise.invert': 1 },
  'Organic Cells':  { 'noise.type': 6, 'noise.family': 1, 'noise.fractal': 0, 'noise.cellOut': 2,
                      'noise.scale': 6, 'noise.combine': 9, 'noise.amount': 0.25,
                      'noise.b.type': 1, 'noise.b.fractal': 1, 'noise.b.scale': 3 },
  'Stained Glass':  { 'noise.type': 6, 'noise.family': 1, 'noise.fractal': 0, 'noise.cellOut': 3,
                      'noise.scale': 7, 'noise.warp': 0.3, 'noise.color': 2 },
  'Mosaic':         { 'noise.type': 8, 'noise.family': 1, 'noise.fractal': 0, 'noise.cellOut': 3,
                      'noise.scale': 16, 'noise.combine': 3, 'noise.amount': 0.6,
                      'noise.b.type': 1, 'noise.b.fractal': 1, 'noise.b.scale': 3 },
  'Lava Flow':      { 'noise.type': 4, 'noise.warp': 2, 'noise.warpMode': 2, 'noise.contrast': 1.4,
                      'noise.col1.r': 0.15, 'noise.col1.g': 0, 'noise.col1.b': 0,
                      'noise.col2.r': 1, 'noise.col2.g': 0.75, 'noise.col2.b': 0.1 },
  'Spiral':         { 'noise.type': 9, 'noise.family': 2, 'noise.coords': 1, 'noise.rotate': 45,
                      'noise.scale': 6, 'noise.warp': 0.4, 'noise.color': 2 },
  'Tunnel':         { 'noise.type': 10, 'noise.family': 2, 'noise.coords': 2, 'noise.scale': 6,
                      'noise.driftY': 0.5 },
  'Flowing Tiles':  { 'noise.type': 12, 'noise.family': 2, 'noise.scale': 8, 'noise.warp': 0.6,
                      'noise.warpMode': 2 },
  'Starfield':      { 'noise.type': 14, 'noise.family': 2, 'noise.scale': 12, 'noise.density': 0.35,
                      'noise.width': 0.3, 'noise.driftX': 0.1 },
  'Patchy Static':  { 'noise.type': 15, 'noise.family': 3, 'noise.combine': 8, 'noise.amount': 1,
                      'noise.b.type': 1, 'noise.b.fractal': 1, 'noise.b.scale': 3, 'noise.b.speed': 0.2 },
  // Curl's RG is a flow vector: route it to Displace rather than to a layer.
  'Displace Flow':  { 'noise.type': 5, 'noise.octaves': 3, 'noise.scale': 2 },

  // ── Appended 2026-09-23 — keep appending: controllers recall by index ────
  // Hair, fur, grass and grain are STRETCHED noise (long along Rotate).
  'Straight Hair':  { 'noise.type': 1, 'noise.octaves': 5, 'noise.scale': 10, 'noise.stretch': 18,
                      'noise.rotate': 90, 'noise.contrast': 1.6 },
  'Flowing Hair':   { 'noise.type': 1, 'noise.octaves': 4, 'noise.scale': 8, 'noise.stretch': 14,
                      'noise.rotate': 90, 'noise.warp': 0.9, 'noise.warpMode': 2, 'noise.warpScale': 0.12,
                      'noise.contrast': 1.6 },
  'Fur':            { 'noise.type': 1, 'noise.fractal': 3, 'noise.octaves': 5, 'noise.scale': 12,
                      'noise.stretch': 10, 'noise.rotate': 70, 'noise.warp': 0.8, 'noise.warpMode': 2,
                      'noise.warpScale': 0.5, 'noise.gamma': 1.4 },
  'Grass':          { 'noise.type': 1, 'noise.fractal': 3, 'noise.octaves': 4, 'noise.scale': 14,
                      'noise.stretch': 12, 'noise.rotate': 95, 'noise.warp': 0.3, 'noise.warpMode': 2,
                      'noise.col1.r': 0.02, 'noise.col1.g': 0.08, 'noise.col1.b': 0.01,
                      'noise.col2.r': 0.5, 'noise.col2.g': 0.85, 'noise.col2.b': 0.25 },
  'Wood Grain':     { 'noise.type': 1, 'noise.octaves': 3, 'noise.scale': 3, 'noise.stretch': 8,
                      'noise.rotate': 90, 'noise.bands': 7, 'noise.warp': 0.2,
                      'noise.col1.r': 0.25, 'noise.col1.g': 0.12, 'noise.col1.b': 0.04,
                      'noise.col2.r': 0.8, 'noise.col2.g': 0.55, 'noise.col2.b': 0.3 },
  'Tree Bark':      { 'noise.type': 1, 'noise.fractal': 3, 'noise.octaves': 5, 'noise.scale': 5,
                      'noise.stretch': 8, 'noise.rotate': 90, 'noise.warp': 0.3, 'noise.gamma': 1.3 },
  'Brushed Metal':  { 'noise.type': 0, 'noise.octaves': 4, 'noise.scale': 24, 'noise.stretch': 20,
                      'noise.contrast': 0.5, 'noise.brightness': 0.1 },
  'Rain':           { 'noise.type': 14, 'noise.family': 2, 'noise.scale': 14, 'noise.stretch': 20,
                      'noise.rotate': 80, 'noise.density': 0.6, 'noise.width': 0.25, 'noise.driftY': -1.2 },
  'Fingerprint':    { 'noise.type': 1, 'noise.fractal': 0, 'noise.scale': 2.5, 'noise.bands': 10,
                      'noise.warp': 0.25, 'noise.contrast': 1.4 },
  'Neurons':        { 'noise.type': 1, 'noise.fractal': 3, 'noise.octaves': 7, 'noise.scale': 3,
                      'noise.gamma': 2.2, 'noise.warp': 0.4, 'noise.warpMode': 2 },
  'Leaf Veins':     { 'noise.type': 6, 'noise.family': 1, 'noise.octaves': 3, 'noise.cellOut': 2,
                      'noise.width': 0.05, 'noise.scale': 4, 'noise.warp': 0.35 },
  'Moss':           { 'noise.type': 6, 'noise.family': 1, 'noise.fractal': 2, 'noise.octaves': 6,
                      'noise.scale': 10, 'noise.col1.r': 0.05, 'noise.col1.g': 0.12, 'noise.col1.b': 0.02,
                      'noise.col2.r': 0.55, 'noise.col2.g': 0.75, 'noise.col2.b': 0.25 },
  'Skin Cells':     { 'noise.type': 6, 'noise.family': 1, 'noise.fractal': 0, 'noise.scale': 8,
                      'noise.warp': 0.25, 'noise.invert': 1, 'noise.gamma': 0.7,
                      'noise.col1.r': 0.35, 'noise.col1.g': 0.08, 'noise.col1.b': 0.1,
                      'noise.col2.r': 1, 'noise.col2.g': 0.75, 'noise.col2.b': 0.7 },
  'Coral':          { 'noise.type': 2, 'noise.fractal': 3, 'noise.octaves': 4, 'noise.scale': 5,
                      'noise.bands': 2, 'noise.warp': 0.5, 'noise.warpMode': 2 },
  'Sponge':         { 'noise.type': 6, 'noise.family': 1, 'noise.fractal': 2, 'noise.octaves': 4,
                      'noise.scale': 6, 'noise.steps': 2, 'noise.brightness': 0.05 },
  'Worms':          { 'noise.type': 1, 'noise.octaves': 2, 'noise.scale': 7, 'noise.contrast': 3,
                      'noise.bands': 1, 'noise.steps': 2 },
  'Silk':           { 'noise.type': 4, 'noise.fractal': 3, 'noise.octaves': 6, 'noise.scale': 3,
                      'noise.warp': 3, 'noise.warpMode': 2, 'noise.gamma': 2 },
  'Plasma':         { 'noise.type': 2, 'noise.octaves': 3, 'noise.scale': 2, 'noise.bands': 2,
                      'noise.color': 2, 'noise.speed': 0.6 },
  'Zebra':          { 'noise.type': 9, 'noise.family': 2, 'noise.scale': 7, 'noise.width': 1,
                      'noise.warp': 0.9, 'noise.warpScale': 0.4 },
  'Giraffe':        { 'noise.type': 6, 'noise.family': 1, 'noise.fractal': 0, 'noise.cellOut': 2,
                      'noise.width': 0.45, 'noise.scale': 8, 'noise.warp': 0.4, 'noise.invert': 1,
                      'noise.col1.r': 0.08, 'noise.col1.g': 0.04, 'noise.col1.b': 0,
                      'noise.col2.r': 0.95, 'noise.col2.g': 0.65, 'noise.col2.b': 0.25 },
  'Camouflage':     { 'noise.type': 6, 'noise.family': 1, 'noise.fractal': 0, 'noise.scale': 9,
                      'noise.warp': 0.3, 'noise.steps': 3,
                      'noise.col1.r': 0.12, 'noise.col1.g': 0.14, 'noise.col1.b': 0.06,
                      'noise.col2.r': 0.62, 'noise.col2.g': 0.58, 'noise.col2.b': 0.38 },
  'Honeycomb':      { 'noise.type': 7, 'noise.family': 1, 'noise.fractal': 0, 'noise.cellOut': 2,
                      'noise.scale': 10, 'noise.width': 0.15 },
  'Dimples':        { 'noise.type': 7, 'noise.family': 1, 'noise.fractal': 0, 'noise.cellOut': 1,
                      'noise.scale': 10, 'noise.gamma': 0.5, 'noise.stretch': 1.4, 'noise.rotate': 90 },
  'Moiré':          { 'noise.type': 9, 'noise.family': 2, 'noise.coords': 1, 'noise.rotate': 90,
                      'noise.scale': 30, 'noise.width': 1, 'noise.combine': 5, 'noise.amount': 1,
                      'noise.b.type': 9, 'noise.b.scale': 33 },
  'Interference':   { 'noise.type': 9, 'noise.family': 2, 'noise.coords': 1, 'noise.rotate': 90,
                      'noise.scale': 14, 'noise.offsetX': 0.2, 'noise.combine': 1, 'noise.amount': 0.5,
                      'noise.b.type': 9, 'noise.b.scale': 16 },
  'Mandala':        { 'noise.type': 10, 'noise.family': 2, 'noise.coords': 1, 'noise.rotate': 30,
                      'noise.scale': 10, 'noise.warp': 0.15 },
  'Halftone':       { 'noise.type': 11, 'noise.family': 2, 'noise.jitter': 0, 'noise.density': 1,
                      'noise.width': 0.55, 'noise.scale': 24, 'noise.combine': 3, 'noise.amount': 1,
                      'noise.b.type': 1, 'noise.b.fractal': 1, 'noise.b.scale': 2 },
  'Weave':          { 'noise.type': 10, 'noise.family': 2, 'noise.scale': 16, 'noise.combine': 3,
                      'noise.amount': 1, 'noise.b.type': 9, 'noise.b.scale': 48, 'noise.contrast': 1.2 },
};

// Menu grouping (display only — the index stays the append order above).
export const RECIPE_GROUPS = [
  ['NATURE',    ['Clouds', 'Smoke', 'Electric', 'Topography', 'Lava Flow', 'Plasma', 'Rain', 'Starfield']],
  ['ORGANIC',   ['Straight Hair', 'Flowing Hair', 'Fur', 'Grass', 'Neurons', 'Leaf Veins', 'Moss',
                 'Skin Cells', 'Organic Cells', 'Coral', 'Sponge', 'Worms', 'Silk', 'Fingerprint']],
  ['MATERIALS', ['Marble', 'Wood Rings', 'Wood Grain', 'Tree Bark', 'Brushed Metal', 'Cracked Earth',
                 'Stained Glass', 'Mosaic']],
  ['PATTERNS',  ['Zebra', 'Giraffe', 'Camouflage', 'Honeycomb', 'Dimples', 'Moiré', 'Interference',
                 'Spiral', 'Tunnel', 'Mandala', 'Halftone', 'Weave', 'Flowing Tiles']],
  ['SIGNAL',    ['Patchy Static', 'Displace Flow']],
];

// Hover text: what the recipe is BUILT from, so it teaches the stages.
export const RECIPE_HELP = {
  'Clouds': 'Perlin fBm, 6 octaves',
  'Marble': 'Waves through a Double domain warp',
  'Wood Rings': 'Waves in Polar coords (Rotate 90° = rings), light warp',
  'Topography': 'Perlin fBm through Contours',
  'Electric': 'Ridged Perlin, high Gamma leaves only the crests',
  'Smoke': 'Simplex Turbulence carried by a Curl warp',
  'Cracked Earth': 'Ridged Perlin × Voronoi edges (Layer B, Multiply)',
  'Organic Cells': 'Voronoi edges bent by Perlin (Layer B, Warp)',
  'Stained Glass': 'Voronoi Cell ID in Spectrum colour',
  'Mosaic': 'Grid Cell ID shaded by Perlin (Layer B, Multiply)',
  'Lava Flow': 'Flow with a strong Curl warp, two-tone',
  'Spiral': 'Waves in Polar coords at 45°',
  'Tunnel': 'Checker in Tunnel coords, Drift Y flies you through',
  'Flowing Tiles': 'Truchet through a Curl warp',
  'Starfield': 'Stars drifting sideways',
  'Patchy Static': 'White grain masked by slow Perlin (Layer B, Mask)',
  'Displace Flow': 'Curl: a flow vector — route it to Displace',
  'Straight Hair': 'Perlin stretched 18× along Rotate',
  'Flowing Hair': 'Stretched Perlin bent by a large, slow Curl warp',
  'Fur': 'Ridged Perlin, stretched and combed by Curl',
  'Grass': 'Ridged Perlin stretched upright, green',
  'Wood Grain': 'Stretched Perlin through Contours',
  'Tree Bark': 'Ridged Perlin stretched vertically',
  'Brushed Metal': 'Value noise stretched 20×, low contrast',
  'Rain': 'Stars stretched into streaks, falling',
  'Fingerprint': 'Single-octave Perlin through 10 Contours',
  'Neurons': 'Ridged Perlin, 7 octaves, Curl warp',
  'Leaf Veins': 'Fractal Voronoi edges, warped',
  'Moss': 'Voronoi Turbulence, 6 octaves',
  'Skin Cells': 'Inverted Voronoi distance, warped',
  'Coral': 'Ridged Simplex through 2 Contours, Curl warp',
  'Sponge': 'Voronoi Turbulence posterized to 2',
  'Worms': 'High-contrast Perlin, one Contour, posterized',
  'Silk': 'Ridged Flow under a strong Curl warp',
  'Plasma': 'Simplex Contours in Spectrum colour',
  'Zebra': 'Square Waves through a domain warp',
  'Giraffe': 'Thick inverted Voronoi edges, warped',
  'Camouflage': 'Voronoi distance posterized to 3',
  'Honeycomb': 'Hex edges',
  'Dimples': 'Hex Round, slightly stretched',
  'Moiré': 'Rings minus slightly larger rings (Difference)',
  'Interference': 'Two ring sets mixed, off-centre',
  'Mandala': 'Checker in Polar coords at 30°',
  'Halftone': 'Regular Dots × Perlin (Layer B, Multiply)',
  'Weave': 'Checker × fine Waves',
};

export function loadUserRecipes() {
  try { return JSON.parse(localStorage.getItem(USER_KEY) || '{}') || {}; }
  catch { return {}; }
}
function _storeUser(all) {
  try { localStorage.setItem(USER_KEY, JSON.stringify(all)); return true; }
  catch { return false; }
}

/**
 * The recipe menu. `labels` is the param's option list — built-ins in append
 * order, then user recipes (★) — and is what controllers recall by index.
 * `order` is the display sequence with group headers; `help` is hover text.
 */
export function recipeMenu() {
  const user = Object.keys(loadUserRecipes());
  const names = Object.keys(NOISE_RECIPES);
  const labels = ['—', ...names, ...user.map(n => `★ ${n}`)];
  const keys = [null, ...names.map(n => ({ n })), ...user.map(n => ({ n, user: true }))];
  const order = [0];
  for (const [hdr, list] of RECIPE_GROUPS) {
    order.push({ header: hdr });
    for (const n of list) order.push(1 + names.indexOf(n));
  }
  if (user.length) {
    order.push({ header: 'YOURS' });
    user.forEach((_, i) => order.push(1 + names.length + i));
  }
  const help = labels.map((_, i) => (i > 0 && i <= names.length) ? RECIPE_HELP[names[i - 1]] ?? '' : '');
  return { labels, keys, order, help };
}

const _KEEP = id => id === 'noise.recipe' || id === 'noise.res';

export function applyRecipe(ps, values) {
  if (!values) return;
  for (const p of ps.getGroup('noise')) {
    if (!_KEEP(p.id)) ps.set(p.id, p.defaultValue ?? p.default ?? p.value);
  }
  // family before type (see the panel's family→type guard)
  if ('noise.family' in values) ps.set('noise.family', values['noise.family']);
  for (const [id, v] of Object.entries(values)) {
    if (id !== 'noise.family' && ps.get(id)) ps.set(id, v);
  }
}

export function captureRecipe(ps) {
  const out = {};
  for (const p of ps.getGroup('noise')) {
    if (p.id === 'noise.recipe' || p.id === 'noise.res') continue;
    out[p.id] = p.value;
  }
  return out;
}

export function saveUserRecipe(name, values) {
  const all = loadUserRecipes();
  all[name] = values;
  return _storeUser(all);
}
export function deleteUserRecipe(name) {
  const all = loadUserRecipes();
  delete all[name];
  return _storeUser(all);
}
