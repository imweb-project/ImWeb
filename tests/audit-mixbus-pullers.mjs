/**
 * Mix-bus / puller consumption audit.
 *
 * Why this exists. A mix bus (sources 26/27/28) renders only while
 * inputs.mixbusNeeded[k] is set, and a puller (Motion, Particles, Growth,
 * Volume, the 3D scene) reads its inputs only while it is itself needed. Both
 * are the same kind of node — "a source that reads other sources while it is
 * needed" — so their need has to be ONE closure in main.js: a bus read by a
 * needed puller is needed, and a puller read by a needed bus is needed, to any
 * depth, in either order.
 *
 * What went wrong: bus need was closed over _direct() and bus→bus reads only,
 * BEFORE the _pullers loop ran. Growth on FG with growth.seedSrc = Mix 1 (and
 * nothing else reading Mix 1) left Mix 1 unrendered — headless, its render
 * target was never even allocated — so Growth seeded from the blank fallback.
 * The same hole held for motion.source, particle.masksrc and every later
 * puller. Silent: the picture is just "Growth not seeding", which reads as a
 * setting, not a bug.
 *
 * The block lives inside the render loop and reads a dozen locals, so it can't
 * be imported. This audit slices the REAL code out of main.js (from the _bus
 * map to the _mixbusNeeded line), runs it against a stub ps, and asserts on
 * the result — the code under test is never retyped.
 *
 * Run:  node tests/audit-mixbus-pullers.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { SOURCE_KEYS, MIXBUS_IDX, TEXSRC_TO_SOURCE } from '../src/controls/ParameterSystem.js';
import { SLOT_PREFIXES } from '../src/scene3d/ModelSlots.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const main = readFileSync(resolve(root, 'src/main.js'), 'utf8');

let failures = 0;
const check = (label, cond, detail = '') => {
  if (cond) { console.log(`  ok   ${label}`); }
  else { console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); failures++; }
};

const START = '    const _bus = MIXBUS_IDX.map((idx, k) => {';
const END_RE = /\n    const _mixbusNeeded = [^\n]*\n/;
const s0 = main.indexOf(START);
const m = END_RE.exec(main.slice(s0));
check('consumption block found in main.js', s0 >= 0 && m,
  'expected `const _bus = MIXBUS_IDX.map(...)` … `const _mixbusNeeded = …` — if renamed, update START/END_RE here, do not delete the audit');
if (s0 < 0 || !m) process.exit(1);
const block = main.slice(s0, s0 + m.index + m[0].length);

// Structural: ONE closure. The buses must be rows of _pullers and their need
// must be read off the shared closure, not computed beside it.
check('buses are rows of _pullers (`..._bus,` inside the list)',
  /const _pullers = \[\s*\.\.\._bus,/.test(block),
  'put the buses into _pullers as rows; a separate bus fixpoint misses buses read by pullers');
check('_mixbusNeeded is read off the puller closure (_pulled)',
  /const _mixbusNeeded = MIXBUS_IDX\.map\(\(i\) => _pulled\.has\(i\)\)/.test(block),
  'derive _mixbusNeeded from _pulled, after the closure has run');
check('no second bus fixpoint (`b.needed`) remains',
  !/\.needed\b/.test(block), 'remove the per-bus needed flag; the closure is the only fixpoint');

// Behavioural: run the real block.
const idx = (k) => SOURCE_KEYS.indexOf(k);
const MOTION_IDX = idx('motion'), PARTICLES_IDX = idx('particles'),
  GROWTH_IDX = idx('growth'), VOLUME_IDX = idx('volume');
const [M1, M2, M3] = MIXBUS_IDX;
const CAMERA = idx('camera');

const run = ({ params = {}, direct = [], motion = -1, pmask = -1, seed = -1, field = -1 }) => {
  const vals = { 'mix.xfade': 0.5, 'mix2.xfade': 0.5, 'mix3.xfade': 0.5,
    'mix.srcA': CAMERA, 'mix.srcB': CAMERA, 'mix2.srcA': CAMERA, 'mix2.srcB': CAMERA,
    'mix3.srcA': CAMERA, 'mix3.srcB': CAMERA, 'vol.source': CAMERA, ...params };
  const ps = { get: (id) => ({ value: vals[id] ?? 0 }) };
  const _direct = (i) => direct.includes(i);
  const fn = new Function(
    'ps', '_direct', 'MIXBUS_IDX', 'SOURCE_KEYS', 'TEXSRC_TO_SOURCE', 'SLOT_PREFIXES',
    'MOTION_IDX', 'PARTICLES_IDX', 'GROWTH_IDX', 'VOLUME_IDX', '_captureIdx',
    '_cMotion', '_pmIdx', '_cGrowSeed', '_cGrowField',
    `${block}\nreturn { _srcUsed, _mixbusNeeded };`);
  return fn(ps, _direct, MIXBUS_IDX, SOURCE_KEYS, TEXSRC_TO_SOURCE, SLOT_PREFIXES,
    MOTION_IDX, PARTICLES_IDX, GROWTH_IDX, VOLUME_IDX, (v) => v,
    motion, pmask, seed, field);
};
const fmt = (r) => JSON.stringify(r._mixbusNeeded);

let r = run({});
check('nothing routed → no bus needed', r._mixbusNeeded.every((b) => !b), fmt(r));

r = run({ direct: [GROWTH_IDX], seed: M1 });
check('Growth (on a layer) seeded from Mix 1 → Mix 1 needed', r._mixbusNeeded[0], fmt(r));
check('  … and only Mix 1', !r._mixbusNeeded[1] && !r._mixbusNeeded[2], fmt(r));

r = run({ direct: [GROWTH_IDX], field: M2 });
check('Growth field from Mix 2 → Mix 2 needed', r._mixbusNeeded[1], fmt(r));

r = run({ direct: [MOTION_IDX], motion: M2 });
check('Motion watching Mix 2 → Mix 2 needed', r._mixbusNeeded[1], fmt(r));

r = run({ direct: [PARTICLES_IDX], pmask: M3 });
check('Particle mask = Mix 3 → Mix 3 needed', r._mixbusNeeded[2], fmt(r));

r = run({ direct: [VOLUME_IDX], params: { 'vol.source': M1 } });
check('Volume recording Mix 1 → Mix 1 needed', r._mixbusNeeded[0], fmt(r));

// Puller → bus → bus: transitivity through a puller-needed bus.
r = run({ direct: [GROWTH_IDX], seed: M1, params: { 'mix.srcA': M3 } });
check('Growth → Mix 1 → Mix 3 → both buses needed', r._mixbusNeeded[0] && r._mixbusNeeded[2], fmt(r));

// Bus → puller → bus: a bus-needed puller pulls its own bus.
r = run({ direct: [M1], seed: M2, params: { 'mix.srcA': GROWTH_IDX } });
check('layer reads Mix 1, Mix 1 reads Growth, Growth seeds from Mix 2 → Mix 2 needed',
  r._mixbusNeeded[1] && r._srcUsed(GROWTH_IDX), fmt(r));

// Margin: no over-pull.
r = run({ seed: M1 });
check('Growth NOT used → its Mix 1 seed does not render Mix 1', !r._mixbusNeeded[0], fmt(r));
r = run({ params: { 'mix.srcA': M1 } });
check('a bus feeding only itself is not needed', !r._mixbusNeeded[0], fmt(r));
r = run({ direct: [M1], params: { 'mix.xfade': 0, 'mix.srcB': M2 } });
check('hidden srcB (xfade 0) does not pull Mix 2', !r._mixbusNeeded[1], fmt(r));

console.log(failures ? `\n${failures} FAILURE(S)\n` : '\nAll mixbus-puller checks passed.\n');
process.exit(failures ? 1 : 0);
