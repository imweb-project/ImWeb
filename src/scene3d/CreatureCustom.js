/**
 * CreatureCustom.js — creature FILES: a creature a player made from one of
 * ImWeb's animals, saved, shared and loaded as a `.imcreature` file.
 *
 * A creature file is DATA ONLY: a name, the animal it is built on, a list of
 * movements (each a set of numbers for that animal's own controls) and a few
 * colours. It holds no code, and nothing in it is ever run or put into the
 * page as markup — an animal's body and the way it moves are programs
 * (tools/creature/<key>-def.js and its view), and loading one of THOSE from a
 * stranger would hand them the page, saved AI keys included. So a file can
 * re-choreograph and re-colour an animal ImWeb has; it cannot bring a new body.
 *
 * Everything read from a file passes cleanCreatureFile() (shape, sizes, names
 * reduced to plain text) and then applyCreatureFile() (each value checked
 * against the animal's own definition: unknown controls dropped, whole-number
 * controls rounded, numbers bounded). tests/audit-creature-file.mjs holds both
 * to that with hostile files.
 *
 * ONE custom creature is live at a time, per browser origin (localStorage
 * 'imweb.creatureCustom'). It REPLACES the movements and colours of the animal
 * it is built on while it is loaded; `creature.kind` still names that animal,
 * and `creature.segment` still counts into the list on screen. A Display State
 * therefore stores "animal 7, movement 3" — not the file — and recalls that
 * animal's own third movement on a machine that does not have the file. That
 * is the same trade glsl.preset makes for user presets, and the reason the
 * file is not a new entry in CREATURE_KINDS (which is append-only, in code).
 *
 * No three.js, no DOM: Node-side audits import this.
 */

export const CREATURE_FILE_FORMAT = 'imweb-creature';
export const CREATURE_FILE_VERSION = 1;
export const CREATURE_FILE_EXT = '.imcreature';
const STORE_KEY = 'imweb.creatureCustom';

const MAX_MOVES = 40, MAX_NAME = 24, MAX_DESC = 120, MAX_VALUES = 80, MAX_ABS = 1000;

/** Plain text only: letters, digits, spaces and a little punctuation. Never markup. */
export function plainText(v, max) {
  return String(typeof v === 'string' || typeof v === 'number' ? v : '')
    .replace(/[^\p{L}\p{N} _.,'()+\-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, max);
}
const isNum = v => typeof v === 'number' && Number.isFinite(v);
const bound = v => Math.max(-MAX_ABS, Math.min(MAX_ABS, v));
const HEX = /^#[0-9a-f]{6}$/i;
const toHex = n => '#' + (Math.round(n) & 0xffffff).toString(16).padStart(6, '0');

/**
 * A file as read (JSON.parse output, or anything at all) → a clean file, or a
 * thrown Error whose message can be shown to the player. `knownBases` is the
 * list of animal keys this build has (CREATURE_KINDS).
 */
export function cleanCreatureFile(raw, knownBases) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('This is not a creature file.');
  if (raw.format !== CREATURE_FILE_FORMAT) throw new Error('This is not a creature file.');
  if (!isNum(raw.version) || raw.version > CREATURE_FILE_VERSION) throw new Error('This creature file was made by a newer ImWeb.');
  if (typeof raw.base !== 'string' || !knownBases.includes(raw.base)) throw new Error('This creature is built on an animal this ImWeb does not have.');
  if (!Array.isArray(raw.moves) || !raw.moves.length) throw new Error('This creature file has no movements.');
  const moves = [];
  for (const m of raw.moves.slice(0, MAX_MOVES)) {
    if (!m || typeof m !== 'object') continue;
    const values = {};
    let n = 0;
    if (m.values && typeof m.values === 'object' && !Array.isArray(m.values)) {
      for (const k of Object.keys(m.values)) {
        if (n >= MAX_VALUES) break;
        if (/^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(k) && isNum(m.values[k])) { values[k] = bound(m.values[k]); n++; }
      }
    }
    moves.push({ name: plainText(m.name, MAX_NAME) || `Move ${moves.length + 1}`, desc: plainText(m.desc, MAX_DESC), values });
  }
  if (!moves.length) throw new Error('This creature file has no movements.');
  const look = {};
  if (raw.look && typeof raw.look === 'object' && !Array.isArray(raw.look)) {
    for (const k of ['limb', 'body', 'under']) if (typeof raw.look[k] === 'string' && HEX.test(raw.look[k])) look[k] = raw.look[k].toLowerCase();
    if (isNum(raw.look.roughness)) look.roughness = Math.max(0, Math.min(1, raw.look.roughness));
    if (raw.look.colours && typeof raw.look.colours === 'object' && !Array.isArray(raw.look.colours)) {
      look.colours = {};
      for (const k of Object.keys(raw.look.colours).slice(0, 16)) {
        const v = raw.look.colours[k];
        if (/^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(k) && typeof v === 'string' && HEX.test(v)) look.colours[k] = v.toLowerCase();
      }
    }
  }
  return { format: CREATURE_FILE_FORMAT, version: CREATURE_FILE_VERSION, name: plainText(raw.name, MAX_NAME) || 'Custom', base: raw.base, moves, look };
}

/** The view's own colour uniforms a file may set: three-number arrays in 0..1 (pods: uIris, uVein). */
function colourUniforms(view) {
  const u = view?.skinFx?.glsl?.uniforms || {}, out = {};
  for (const k of Object.keys(u)) if (Array.isArray(u[k]) && u[k].length === 3 && u[k].every(isNum)) out[k] = u[k];
  return out;
}
const rgbToHex = a => '#' + a.map(c => Math.round(Math.max(0, Math.min(1, c)) * 255).toString(16).padStart(2, '0')).join('');
const hexToRgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255);

/** An animal as it stands (its definition and view, possibly already a custom one) → a creature file. */
export function exportCreatureFile(key, def, view, name) {
  const look = {};
  for (const k of ['limb', 'body', 'under']) if (isNum(view?.soft?.[k])) look[k] = toHex(view.soft[k]);
  if (isNum(view?.soft?.roughness)) look.roughness = view.soft.roughness;
  const cu = colourUniforms(view);
  if (Object.keys(cu).length) { look.colours = {}; for (const k in cu) look.colours[k] = rgbToHex(cu[k]); }
  return {
    format: CREATURE_FILE_FORMAT, version: CREATURE_FILE_VERSION,
    name: plainText(name, MAX_NAME) || def.NAME, base: key,
    // every control of this animal with its resting value, for whoever edits the file by hand
    controls: Object.fromEntries(Object.entries(def.DEFAULT).filter(([, v]) => isNum(v))),
    wholeNumberControls: [...(def.INT_KEYS || [])],
    moves: def.SEGMENTS.map(s => ({ name: s.name, desc: s.desc || '', values: Object.fromEntries(Object.entries(s.s || {}).filter(([, v]) => isNum(v))) })),
    look,
  };
}

/**
 * A CLEAN file laid over its animal: { def, view } to hand the engine in place
 * of the animal's own. A value is kept only for a control the animal has, and
 * only as a number; a control that must be whole (INT_KEYS — a fraction there
 * breaks the seamless loop) is rounded. Movements are never dropped, so the
 * list is as long as the file says and the Movement menu can be filled from
 * the file alone, before the animal's code has loaded.
 */
export function applyCreatureFile(def, view, file) {
  const ints = def.INT_KEYS || [];
  const SEGMENTS = file.moves.map(m => {
    const s = {};
    for (const k in m.values) if (isNum(def.DEFAULT[k])) s[k] = ints.includes(k) ? Math.round(m.values[k]) : m.values[k];
    return { name: m.name, group: 'custom', desc: m.desc, s };
  });
  const soft = { ...view.soft }, L = file.look || {};
  for (const k of ['limb', 'body', 'under']) if (L[k] && isNum(view.soft?.[k])) soft[k] = parseInt(L[k].slice(1), 16);
  if (isNum(L.roughness) && isNum(view.soft?.roughness)) soft.roughness = L.roughness;
  let skinFx = view.skinFx;
  const cu = colourUniforms(view);
  if (L.colours && Object.keys(cu).length) {
    const uniforms = { ...view.skinFx.glsl.uniforms };
    for (const k in cu) if (L.colours[k]) uniforms[k] = hexToRgb(L.colours[k]);
    skinFx = { ...view.skinFx, glsl: { ...view.skinFx.glsl, uniforms } };
  }
  return { def: { ...def, NAME: file.name, SEGMENTS, CUSTOM: true }, view: { ...view, soft, skinFx } };
}

// ── The one live custom creature ─────────────────────────────────────────────
let _custom = null, _bases = null;
const _subs = new Set();
const store = () => { try { return globalThis.localStorage ?? null; } catch { return null; } };

/** Read what the last session left (called once, with the animal keys this build has). */
export function initCreatureCustom(knownBases) {
  _bases = knownBases;
  try {
    const raw = store()?.getItem(STORE_KEY);
    _custom = raw ? cleanCreatureFile(JSON.parse(raw), knownBases) : null;
  } catch { _custom = null; }     // unreadable, or for an animal since removed: as if none
}
export function getCreatureCustom() { return _custom; }
/** Movement names of the custom creature built on `key`, or null when that animal is its own. */
export function customMovesFor(key) { return _custom && _custom.base === key ? _custom.moves.map(m => m.name) : null; }
/**
 * Load a creature (anything read from a file — it is cleaned here) or, with
 * null, go back to the built-in animals. Throws what cleanCreatureFile throws.
 * Subscribers get (now, before).
 */
export function setCreatureCustom(raw) {
  const before = _custom;
  _custom = raw == null ? null : cleanCreatureFile(raw, _bases || []);
  try { const s = store(); if (s) { if (_custom) s.setItem(STORE_KEY, JSON.stringify(_custom)); else s.removeItem(STORE_KEY); } } catch { /* private window: it lasts the session */ }
  for (const fn of [..._subs]) fn(_custom, before);
  return _custom;
}
export function onCreatureCustomChange(fn) { _subs.add(fn); return () => _subs.delete(fn); }
