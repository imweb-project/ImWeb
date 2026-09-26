/**
 * The 3D Material's texture menus stay on the canonical source list, stay in
 * register with each other, and every source they name is switched on while
 * the 3D scene wears it.
 *
 * Why this exists. `scene3d.mat.texsrc`, `modelN.texsrc` and
 * `scene3d.mat.dispsrc` carried a hand-written eight-entry list (None Camera
 * Movie Screen Draw Buffer Noise Image) while SOURCE_DEFS grew to 34; the
 * owner found Growth missing from Material ▸ Texture Source (2026-09-26).
 * Unlike the Hypercube menus these could not be swapped for OPT_SOURCES
 * without a migration, so the first eight keep their indices and everything
 * after them is DERIVED from SOURCE_DEFS (TEXSRC_OPTIONS). Two silent failures
 * that would come back without this audit:
 *
 *   - the three menus drift apart. modelN.texsrc is the list offset by one
 *     ('Shared' first), dispsrc offset by two; dispsrc had no 'Image', so
 *     appending the derived sources to it would have put every one of them a
 *     place off its texsrc twin — a menu that reads right and shows the
 *     neighbouring source.
 *   - a source chosen there is never drawn. Growth, SDF, the Mix buses … only
 *     render while something consumes them (_srcUsed); the 3D scene is such a
 *     consumer only through its puller row in main.js. Without it the
 *     material wears the Output fallback or a frozen frame, and no error says
 *     so (LEARNED 2026-09-25, the gate lesson).
 *
 * Run:  node tests/audit-material-texsrc.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  SOURCE_DEFS,
  SOURCE_KEYS,
  TEXSRC_OPTIONS,
  TEXSRC_TO_SOURCE,
  ParameterSystem,
  registerCoreParameters,
} from '../src/controls/ParameterSystem.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(resolve(root, p), 'utf8');
const main  = read('src/main.js');
const scene = read('src/scene3d/SceneManager.js');

let failures = 0;
const check = (label, cond, detail = '') => {
  if (cond) console.log(`  ok   ${label}`);
  else { console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); failures++; }
};

const ps = new ParameterSystem();
registerCoreParameters(ps);
const tex  = ps.get('scene3d.mat.texsrc').options;
const disp = ps.get('scene3d.mat.dispsrc').options;
const slot = ps.get('model2.texsrc').options;

console.log('The three menus are one list at their offsets');
check('scene3d.mat.texsrc reads TEXSRC_OPTIONS', tex.length === TEXSRC_OPTIONS.length && tex.every((o, i) => o === TEXSRC_OPTIONS[i]));
check('modelN.texsrc is Shared + the list (offset 1)',
  slot[0] === 'Shared' && slot.length === tex.length + 1 && tex.every((o, i) => slot[i + 1] === o));
check('scene3d.mat.dispsrc is Same/Displace Layer + the list (offset 2, DISPSRC_TEX_BASE)',
  disp[0] === 'Same as Surface' && disp[1] === 'Displace Layer' && disp.length === tex.length + 2 && tex.every((o, i) => disp[i + 2] === o));
check('SceneManager and UI.js still read the list at offset 2', /DISPSRC_TEX_BASE = 2/.test(scene) && /DISPSRC_TEX_BASE = 2/.test(read('src/ui/UI.js')));

console.log('The hand-written eight keep their indices (saved projects)');
const HAND = ['None', 'Camera', 'Movie', 'Screen', 'Draw', 'Buffer', 'Noise', 'Image'];
check('indices 0–7 unchanged', HAND.every((o, i) => tex[i] === o), tex.slice(0, 8).join(','));
check('Noise is still 6 (the Auto-mapping rule in SceneManager and UI.js)', tex[6] === 'Noise' && /srcIdx === 6/.test(scene));

console.log('Every source is offered or deliberately skipped');
const offered = new Set(TEXSRC_TO_SOURCE.filter((i) => i >= 0));
const SELF = ['scene3d', 'depth3d'];
for (const [i, d] of SOURCE_DEFS.entries()) {
  if (SELF.includes(d.key)) check(`${d.label} is NOT offered (the scene reading itself)`, !offered.has(i));
  else check(`${d.label} is offered`, offered.has(i));
}
check('each derived entry is labelled as its source',
  TEXSRC_TO_SOURCE.every((s, i) => i < 8 || tex[i] === SOURCE_DEFS[s]?.label));
check('Growth is on the menu', tex.includes('Growth'));

console.log('A source the scene wears is switched on (the consumption gate)');
check('SceneManager resolves 8+ through resolveSource, from TEXSRC_TO_SOURCE',
  /TEXSRC_TO_SOURCE\.slice\(8\)\.map\(\(i\) => inputs\.resolveSource/.test(scene));
check('main.js has a puller row for 3D Scene reading the material sources',
  /\{ idx: SOURCE_KEYS\.indexOf\("scene3d"\), reads: _s3dReads, seed: /.test(main));
check('… and one for 3D Depth (the same render)', /\{ idx: SOURCE_KEYS\.indexOf\("depth3d"\), reads: _s3dReads \}/.test(main));
// The block that builds _s3dReads, bounded by two markers that must BOTH exist
// (an absent marker would make indexOf -1 and the slice silently wrong).
const i0 = main.indexOf('const _dispSel'), i1 = main.indexOf('const _pullers');
check('the _s3dReads block is present', i0 !== -1 && i1 !== -1 && i0 < i1);
const s3dBlock = i0 !== -1 && i1 > i0 ? main.slice(i0, i1) : '';
check('_s3dReads covers texsrc, dispsrc and the model slots',
  /scene3d\.mat\.texsrc/.test(s3dBlock) && /scene3d\.mat\.dispsrc/.test(s3dBlock) && /SLOT_PREFIXES\.map/.test(s3dBlock));
check('the puller seed honours scene3d rendering on its own (p.seed)', /_pullers\.filter\(\(p\) => p\.seed \|\| _usedBase\(p\.idx\)\)/.test(main));

if (failures) { console.error(`\n${failures} material-texsrc check(s) failed.`); process.exit(1); }
console.log('\nAll material-texsrc checks passed.');
