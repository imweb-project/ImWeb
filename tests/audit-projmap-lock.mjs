/**
 * Projection-mapping lock audit.
 *
 * Why this exists. Corner-pin geometry is a calibration to a PHYSICAL surface,
 * not part of a look. It must survive a .imweb project load, and it must never
 * be touched by a Display State recall or morph.
 *
 * Those two requirements pull in opposite directions through one mechanism.
 * Display States and project files BOTH go through ps.captureState() and
 * ps.restoreState(), so the group-'global' exclusion — the tool used for
 * glsl.preset and displace.warpSlot — cannot separate them: making projmap
 * 'global' would fix the recall hazard and simultaneously drop corners from
 * every saved project. The split is therefore made in Preset._stripLocked(),
 * on the Display-State side only, while ProjectFile keeps calling
 * ps.restoreState directly.
 *
 * What actually went wrong. Before this, projmap.* was group 'projmap', so it
 * was captured by every state and bank and written back by FOUR paths —
 * recallState and activatePreset, each with a snap and a morph branch. Worse,
 * not being 'global' meant the morph lerp animated it: recalling a state saved
 * at another site would SLIDE the image off the object over the morph
 * duration. On an irregular surface — projecting onto lava rock — alignment
 * cannot be re-found by eye mid-performance, so the failure is unrecoverable
 * in the field and silent everywhere else (on a flat test wall it looks fine).
 *
 * This cannot be a runtime check: the guarantee is that no NEW state-applying
 * path forgets the helper, and a path that forgets it simply works, quietly,
 * until someone is standing in a field.
 *
 * Run:  node tests/audit-projmap-lock.mjs
 */

import { readFileSync } from 'node:fs';
import { ParameterSystem, registerCoreParameters } from '../src/controls/ParameterSystem.js';

let failures = 0;
const check = (label, cond, detail = '') => {
  if (cond) { console.log(`  ok   ${label}`); }
  else { console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); failures++; }
};

// ── Registry invariants ───────────────────────────────────────────────────
const ps = new ParameterSystem();
registerCoreParameters(ps);

const lock = ps.get('projmap.lock');
check('projmap.lock is registered', !!lock,
  'add it beside projmap.active in ParameterSystem.js');
check('projmap.lock is group "global"', lock?.group === 'global',
  `is "${lock?.group}" — a non-global lock is itself captured, so recalling a ` +
  'state saved while unlocked would switch the protection off');
check('projmap.lock defaults ON', lock?.value === 1,
  'losing alignment in the field is unrecoverable; an uncaptured corner set is not');

// Params in the projmap namespace that are deliberately NOT geometry, and so
// are deliberately group 'global' (never captured, never recalled):
//   projmap.lock — the calibration lock itself; a state must not switch it off
//   projmap.edit — whether the rings/grid/toolbar are shown; a view state, the
//                  same treatment global.showwarpgrid gets
// Everything else under projmap. IS geometry and must stay capturable, or
// .imweb project files stop carrying the site alignment.
//   projmap.grid — the calibration grid overlay; view state, same as edit
//   projmap.meshSlot — an index into PER-ORIGIN localStorage, like warpSlot;
//                      capturing it would recall a different mesh elsewhere
//   projmap.meshStore — a TRIGGER; capturing it means recalling a state FIRES
//                       it, overwriting a slot nobody asked to overwrite
//   projmap.meshHandlesClear — a TRIGGER, same reasoning: captured, every
//                       Display State recall would reset the curve handles of
//                       whatever mesh happened to be loaded. The handles
//                       themselves are geometry and DO travel, but they live
//                       in the mesh, not in a parameter — see ProjMapMesh.tans
//                       and audit-projmap-curve §14.
const VIEW_STATE = new Set(['projmap.lock', 'projmap.edit', 'projmap.grid',
                            'projmap.meshSlot', 'projmap.meshStore',
                            'projmap.meshHandlesClear']);
const corners = ps.getAll().filter(p => p.id.startsWith('projmap.') && !VIEW_STATE.has(p.id));
check('projmap corner params exist', corners.length >= 8, `found ${corners.length}`);
const wronglyGlobal = corners.filter(p => p.group === 'global').map(p => p.id);
const edit = ps.get('projmap.edit');
check('projmap.edit is registered', !!edit, 'the rings/grid/toolbar switch');
check('projmap.edit is group "global"', edit?.group === 'global',
  `is "${edit?.group}" — a capturable view state means recalling a look could ` +
  'switch the corner rings back on in the middle of a performance');

check('geometry params are NOT group "global"', wronglyGlobal.length === 0,
  `${wronglyGlobal.join(', ')} — 'global' would drop them from captureState(), ` +
  'so .imweb project files would stop carrying the site alignment');

// ── Preset.js: every state-application path routes through the helper ─────
const preset = readFileSync(new URL('../src/state/Preset.js', import.meta.url), 'utf8');

check('Preset._stripLocked is defined', /_stripLocked\s*\(\s*values\s*\)\s*\{/.test(preset),
  'the single choke point for Display-State value application');

// restoreState call sites. Two args are legitimately raw:
//   fromValues    — the CURRENT live values, captured a moment earlier
//   this._morphTo — already stripped where it was assigned
const RAW_OK = new Set(['fromValues', 'this._morphTo']);
const restoreArgs = [...preset.matchAll(/this\.ps\.restoreState\(([^)]*)\)/g)].map(m => m[1].trim());
check('restoreState call sites found', restoreArgs.length >= 3, `found ${restoreArgs.length}`);
const badRestore = restoreArgs.filter(a => !a.startsWith('this._stripLocked(') && !RAW_OK.has(a));
check('every restoreState arg is stripped or a known-raw exception', badRestore.length === 0,
  `raw: ${badRestore.join(' | ')} — wrap it in this._stripLocked(...) or, if it is ` +
  'genuinely current live values, add it to RAW_OK here with a reason');

// morph targets built from a stored state must be stripped
const morphTo = [...preset.matchAll(/this\._morphTo\s*=\s*([^;]+);/g)].map(m => m[1].trim());
const fromStored = morphTo.filter(a => /ds\.values/.test(a));
check('morph targets built from ds.values found', fromStored.length >= 2,
  `found ${fromStored.length} — recallState and activatePreset each have one`);
const badMorph = fromStored.filter(a => !a.startsWith('this._stripLocked('));
check('every morph target from a stored state is stripped', badMorph.length === 0,
  `raw: ${badMorph.join(' | ')} — an unstripped target makes the lerp animate the ` +
  'corners, sliding the projection off the object over the morph duration');

// ── The other direction: project files MUST still carry the corners ───────
const projectFile = readFileSync(new URL('../src/io/ProjectFile.js', import.meta.url), 'utf8');
check('ProjectFile restores params WITHOUT stripping',
  /restoreState\(\s*data\.params\s*\)/.test(projectFile),
  'a project load must re-apply the saved site alignment — if this ever routes ' +
  'through _stripLocked, corners stop surviving a project load and the lock ' +
  'has eaten the thing it was protecting');

console.log(failures ? `\n${failures} FAILURE(S)\n` : '\nAll projmap-lock checks passed.\n');
process.exit(failures ? 1 : 0);
