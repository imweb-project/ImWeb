/**
 * TakeFavs — starred takes per model file and clip.
 *
 * A take is starred by right-clicking it on the timeline strip (ClipStrip).
 * Advance (Next / Random) then plays only the starred takes of that model,
 * all takes while none are starred (advanceTake, ModelSlots.js). The Segment
 * menu marks them ★.
 *
 * Keyed by file name + clip name + clip length, so the same file loaded into
 * any slot finds its stars, and two clips of one file do not share them.
 * Takes are 1-based, as the Segment param counts them (0 = whole clip).
 *
 * localStorage, per origin, like the other small per-browser settings; read
 * once and kept in memory, since advanceTake may ask on any frame.
 */

const KEY = 'imweb.takeFavs';
let _all = null;

function all() {
  if (!_all) {
    try { _all = JSON.parse(localStorage.getItem(KEY)) ?? {}; } catch { _all = {}; }
  }
  return _all;
}

/** The key for a model file's clip, or null without both. */
export function favKey(modelName, clip) {
  if (!modelName || !clip) return null;
  return `${String(modelName).split('/').pop()}|${clip.name ?? ''}|${clip.duration.toFixed(2)}`;
}

/** Starred takes (1-based, ascending) for a key; [] when none. */
export function getFavs(key) {
  return key ? [...(all()[key] ?? [])] : [];
}

/** Star or unstar take i (1-based). Returns the new list. */
export function toggleFav(key, i) {
  if (!key || !(i >= 1)) return getFavs(key);
  const set = new Set(all()[key] ?? []);
  if (set.has(i)) set.delete(i); else set.add(i);
  const list = [...set].sort((a, b) => a - b);
  if (list.length) all()[key] = list; else delete all()[key];
  try { localStorage.setItem(KEY, JSON.stringify(all())); } catch { /* storage blocked: stars last this session */ }
  return list;
}
