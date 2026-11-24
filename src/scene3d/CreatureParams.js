/**
 * Creature parameters — the procedural creatures of tools/creature/ as an object
 * in the 3D scene (CreatureObject.js).
 *
 * Registered here rather than inline in main.js so that Node-side audits can
 * build the same parameter set the app has; same shape as
 * registerHypercubeParams. Data only: no three.js, no creature code, so boot
 * pays nothing for a creature nobody switches on.
 */

import { OPT_SOURCES } from '../controls/ParameterSystem.js';

/**
 * The creatures ImWeb offers, and each one's movements.
 *
 * APPEND-ONLY, twice over. `creature.kind` is stored as an index into this
 * list and `creature.segment` as an index into that animal's `moves` — in
 * Display States, .imweb projects and MIDI recall ranges. Insert or reorder
 * either and every saved state recalls a different animal or a different
 * movement, with no error anywhere (the SOURCE_DEFS lesson).
 *
 * `moves` repeats the names in each animal's definition file
 * (tools/creature/<key>-def.js SEGMENTS) on purpose: the Movement menu has to
 * be right the instant the animal changes — a state recall writes
 * creature.kind and creature.segment back to back, long before the definition
 * file has loaded — and a menu still holding the previous animal's shorter
 * list would clamp the recalled movement to it. tests/audit-creature.mjs
 * fails if a list here drifts from its definition, and so does the creature
 * page's own check (tools/creature/seam-check.mjs), which is the one the
 * sessions that edit creatures run.
 *
 * `key` names the files; `label` is the definition's NAME.
 *
 * Not here yet: the jellyfish and the peacock spider. They cost 9 and 15 ms a
 * frame on the owner's machine against 1–2 for these seven, and the 3D scene
 * can be drawn twice a frame (3D Scene and 3D Depth). They join — appended —
 * when they have lighter versions.
 *
 * Pods (a string of eyed, hairy balls; its hair is a live simulation in
 * pods-view.js) is the heaviest one in: about 4 ms a frame, after a lighter
 * version was made for exactly this list (it was 12).
 */
export const CREATURE_KINDS = [
  { key: 'octopus', label: 'Octopus', moves: ['Den', 'Breathe', 'Bask', 'Crawl', 'Tiptoe', 'Haul', 'Jet', 'Swim', 'Reach', 'Fetch',
    'Grope', 'Probe', 'Search', 'Startle', 'Ball', 'Flare', 'Spiral', 'Flower', 'Waltz', 'Corkscrew', 'Minds'] },
  { key: 'centipede', label: 'Centipede', moves: ['Rest', 'Coil', 'Walk', 'Run', 'Creep', 'Reverse', 'Circle', 'Ripple', 'Sense', 'Rear',
    'Strike', 'Startle', 'Thrash', 'Wave', 'Snake', 'Arch', 'Float', 'Tumble', 'Corkscrew', 'Grasp'] },
  { key: 'snake', label: 'Cobra', moves: ['Coil', 'Bask', 'Slither', 'Circle', 'Hurry', 'Concertina', 'Creep', 'Alert', 'Hood', 'Sway',
    'Hiss', 'Strike', 'Bluff', 'Swim', 'Drift'] },
  { key: 'cuttlefish', label: 'Cuttlefish', moves: ['Hover', 'Drift', 'Cruise', 'Stretch', 'Walk', 'Crab', 'Stalk', 'Explore', 'Strike', 'Eat',
    'Cloud', 'Zebra', 'Bloom', 'Splay', 'Curl', 'Wave', 'Braid', 'Flash', 'Settle', 'Algae', 'Groom', 'Disrupt', 'Papillae', 'Flick', 'Jet', 'Ink'] },
  { key: 'manta', label: 'Manta ray', moves: ['Cruise', 'Glide', 'Bank', 'Swoop', 'Chain', 'Somersault', 'Breach', 'Clean'] },
  { key: 'paradise', label: 'Parotia', moves: ['Rest', 'Look up', 'Clear', 'Hop round', 'Bow', 'Raise', 'Ballerina', 'Sway', 'Pivot', 'Bounce',
    'Head shake', 'Head tilt', 'Hold', 'Full dance'] },
  { key: 'featherstar', label: 'Feather star', moves: ['Perch', 'Feed', 'Bowl', 'Swim', 'Parachute', 'Escape', 'Settle', 'Regrip', 'Cling', 'Curl',
    'Unfurl', 'Crawl'] },
  { key: 'pods', label: 'Pods', moves: ['Eight', 'Ring', 'Stretch', 'Flower', 'Knot', 'Travel', 'Tumble', 'Full'] },
];

/** creature.advance, as the engine names them (tools/creature/engine.js step). */
export const CREATURE_ADVANCE = ['off', 'next', 'random'];
/** creature.skin, as the engine names them (engine.js setSkin). APPEND-ONLY: saved as an index. */
export const CREATURE_SKINS = ['soft', 'chrome', 'glass', 'video'];
/** Index of the Video skin — the one that wears creature.texsrc. */
export const CREATURE_SKIN_VIDEO = CREATURE_SKINS.indexOf('video');

/** The Movement menu of animal `kind`: numbered, as the creature page numbers them. */
export function creatureMoveOptions(kind, names = CREATURE_KINDS[kind]?.moves ?? []) {
  return names.map((n, i) => `${i + 1} · ${n}`);
}

/** Every creature param, in panel order (CreatureUI.js; checked by tests/audit-creature.mjs). */
export const CREATURE_PARAM_IDS = ['creature.active', 'creature.kind', 'creature.segment', 'creature.advance',
  'creature.loops', 'creature.speed', 'creature.skin', 'creature.texsrc', 'creature.scale', 'creature.withObject'];

/**
 * True for a param the creature is moving BY ITSELF right now: creature.segment
 * while the creature is on and Advance is Next or Random — the engine writes
 * each new movement back to it so the row follows along.
 *
 * Preset.liveIsUnsaved() asks this. It decides "is the look on screen unsaved
 * work?" by comparing every value with the stored state, and skips params a
 * controller drives, because an LFO changes them every frame. A creature
 * walking through its library is the same case with no controller object to
 * see: the first time it moved on, the look read as unsaved, and a hand-driven
 * bank switch then carried it along ("Unsaved look kept") instead of recalling
 * the bank — for ever after, with nothing edited.
 */
export function creatureSelfDriven(ps, id) {
  return id === 'creature.segment' && !!ps.get('creature.active')?.value && Math.round(ps.get('creature.advance')?.value ?? 0) !== 0;
}

export function registerCreatureParams(ps) {
  // Group 'creature', not 'global': all of it is captured by Display States.
  // Unlike glsl.preset — an index into a list the user edits — every index
  // here points into a list that lives in code and only ever grows (above), so
  // a saved index means the same thing on every machine and every origin.
  const g = 'creature';
  ps.register({ id: 'creature.active', type: 'toggle', value: 0, label: 'Creature', group: g,
    help: 'Puts a moving creature into the 3D scene. It shows wherever 3D Scene is routed, and its shape reaches 3D Depth too.' });
  // kind BEFORE segment: a state recall writes params in registration order,
  // and the animal has to be in place (its menu swapped, below) before its
  // movement is written.
  const kind = ps.register({ id: 'creature.kind', type: 'select', select: true, options: CREATURE_KINDS.map(k => k.label), value: 0,
    label: 'Animal', group: g,
    help: 'Which creature. Each has its own skeleton and its own list of movements; changing it starts the new one at its first movement.' });
  const seg = ps.register({ id: 'creature.segment', type: 'select', select: true, options: creatureMoveOptions(0), value: 0,
    label: 'Movement', group: g,
    help: 'The movement being played. Every movement loops without a seam, and the creature glides from one into the next over one loop. With Advance on, this follows along by itself.' });
  ps.register({ id: 'creature.advance', type: 'select', options: ['Off', 'Next', 'Random'], value: 1, label: 'Creature Advance', group: g,
    help: 'What happens when a movement has played its loops. Off: it keeps looping. Next: on to the following movement, so the whole library plays as one piece. Random: any other movement.' });
  ps.register({ id: 'creature.loops', type: 'continuous', value: 2, min: 1, max: 16, step: 1, label: 'Creature Loops', group: g,
    help: 'How many loops each movement plays before Advance moves on.' });
  ps.register({ id: 'creature.speed', type: 'continuous', value: 1, min: 0, max: 2, step: 0.01, label: 'Creature Speed', group: g,
    help: 'How fast the creature lives: 1 is its natural pace, 0 holds it still.' });
  ps.register({ id: 'creature.skin', type: 'select', options: ['Soft', 'Chrome', 'Glassy', 'Video'], value: 0, label: 'Skin', group: g,
    help: 'Soft is the creature\'s own skin, with its colours, markings and fur. Chrome and Glassy keep the body and the movement and replace the surface. Video wears the picture chosen in Skin Source.' });
  // OPT_SOURCES ('None' + the one canonical source list), resolved through
  // SceneManager._resolveOptSource like the Hypercube's face texture — never a
  // list of its own (six hand-kept copies of the source list once drifted).
  // Group 'creature': the list is append-only and in code, so the index means
  // the same source everywhere. Default Movie A: Video with no picture is a
  // plain white animal, which reads as "broken".
  ps.register({ id: 'creature.texsrc', type: 'select', select: true, options: OPT_SOURCES, value: Math.max(0, OPT_SOURCES.indexOf('Movie A')),
    label: 'Skin Source', group: g,
    help: 'The picture the Video skin wears: the camera, a movie, the draw layer, a mix bus — any source. It is wrapped onto the body from three sides and sticks to the skin as the creature bends and stretches. Used only while Skin is Video.' });
  ps.register({ id: 'creature.scale', type: 'continuous', value: 1, min: 0.1, max: 4, step: 0.01, label: 'Creature Size', group: g,
    help: 'Size of the creature. At 1 it fills the picture with the 3D camera at its defaults; Transform (position, rotation, spin, scale) moves it as it moves the object.' });
  ps.register({ id: 'creature.withObject', type: 'toggle', value: 0, label: 'Show Object', group: g,
    help: 'Off: the creature replaces the 3D scene\'s own object (the geometry or imported model). On: both are shown, sharing Transform. Models M2–M4 are never hidden.' });

  // Each animal has its own movements, so the menu is swapped the moment the
  // animal changes — here, at the param, not in the panel: a recall writes
  // kind then segment in one synchronous pass, and the segment's value is
  // clamped to whatever list is in place when it lands. The new animal starts
  // at its first movement; on a recall the saved movement is written next.
  kind.onChange(i => {
    seg.options = creatureMoveOptions(i);
    seg.value = 0;
  });
}
