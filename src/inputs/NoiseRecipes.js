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
};

export function loadUserRecipes() {
  try { return JSON.parse(localStorage.getItem(USER_KEY) || '{}') || {}; }
  catch { return {}; }
}
function _storeUser(all) {
  try { localStorage.setItem(USER_KEY, JSON.stringify(all)); return true; }
  catch { return false; }
}

/** Menu order: a "—" placeholder, built-ins, then user recipes. */
export function recipeMenu() {
  const user = Object.keys(loadUserRecipes());
  return {
    labels: ['—', ...Object.keys(NOISE_RECIPES), ...user.map(n => `★ ${n}`)],
    keys:   [null, ...Object.keys(NOISE_RECIPES).map(n => ({ n })), ...user.map(n => ({ n, user: true }))],
  };
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
