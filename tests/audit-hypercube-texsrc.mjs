/**
 * The hypercube texture/mask menus stay on the canonical source list, and the
 * migration that carries old files stays wired to every import path.
 *
 * Why this exists. `hypercube.faces.texsrc`, `hypercube.faces.masksrc` and
 * `hypercube.inst.texsrc` each carried a hand-written seven-entry copy of the
 * source list — ['None','Camera','Movie','Screen','Draw','Buffer','Noise'] —
 * plus a matching seven-entry texture map in SceneManager and a fourth copy of
 * the labels in HypercubeUI. SOURCE_DEFS had grown to 33 sources in the
 * meantime, so 28 of them were simply unreachable from a face. Nothing broke,
 * nothing warned: the dropdown just looked short.
 *
 * Switching them to OPT_SOURCES changes what a stored integer MEANS. Only
 * None/Camera/Movie land on themselves; Screen/Draw/Buffer/Noise all move. A
 * saved bank recalls a number, not a label, so without the migration an old
 * project silently comes back showing the wrong source — which is the same
 * plausible-looking-picture failure audit-source-resolution.mjs was written for.
 *
 * The migration is gated on PARAM_SCHEMA >= 3 and cannot be made idempotent by
 * inspection: a stored 3 is 'Screen' or 'Buffer' depending only on when it was
 * written. So the invariants are
 *
 *   - the three menus read OPT_SOURCES, never a retyped list,
 *   - OPT_SOURCES is 'None' + the canonical SOURCES, derived not copied,
 *   - the remap sends each old label to the SAME label's new index,
 *   - PARAM_SCHEMA is at least 3, so the gate can ever fire,
 *   - every path that calls migrateBlendPercent also calls this one.
 *
 * That last one is the real guard: the two migrations are stamped by the same
 * schema field and must run in the same places, so a new import path that
 * remembers one and forgets the other fails here rather than in a saved file.
 *
 * Run:  node tests/audit-hypercube-texsrc.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  SOURCES,
  OPT_SOURCES,
  PARAM_SCHEMA,
  HC_TEXSRC_IDS,
  migrateHypercubeTexSrc,
  migrateStatesHypercubeTexSrc,
} from '../src/controls/ParameterSystem.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(resolve(root, p), 'utf8');
const main    = read('src/main.js');
const psrc    = read('src/controls/ParameterSystem.js');
const scene   = read('src/scene3d/SceneManager.js');
const preset  = read('src/state/Preset.js');
const project = read('src/io/ProjectFile.js');

let failures = 0;
const check = (label, cond, detail = '') => {
  if (cond) console.log(`  ok   ${label}`);
  else { console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); failures++; }
};

console.log('\nhypercube texture/mask menus are the canonical source list');

// ── The menu is derived, not retyped ─────────────────────────────────────────
check("OPT_SOURCES is 'None' + SOURCES, in that order",
  OPT_SOURCES.length === SOURCES.length + 1 &&
  OPT_SOURCES[0] === 'None' &&
  SOURCES.every((s, i) => OPT_SOURCES[i + 1] === s),
  `${OPT_SOURCES.length} vs ${SOURCES.length + 1}`);

check('OPT_SOURCES is built from SOURCES in source, not written out',
  /export const OPT_SOURCES = \[\s*'None',\s*\.\.\.SOURCES\s*\]/.test(psrc));

for (const id of HC_TEXSRC_IDS) {
  const decl = new RegExp(`id\\s*:\\s*'${id.replace(/\./g, '\\.')}'[^}]*`);
  const m = main.match(decl);
  check(`${id} registers options: OPT_SOURCES`,
    !!m && /options\s*:\s*OPT_SOURCES/.test(m[0]),
    m ? 'found the param but not the canonical options' : 'param not found in main.js');
}

// ── No private copy of the list survives on the read side ────────────────────
check('SceneManager has the canonical resolver helper',
  /_resolveOptSource\s*\(params?,/.test(scene) || /_resolveOptSource\(p,/.test(scene));

// Named per param, not "is there a literal map anywhere": `scene3d.mat.texsrc`
// still carries the old seven-entry menu ON PURPOSE — `scene3d.mat.dispsrc`
// mirrors that list at DISPSRC_TEX_BASE, so moving it is its own job with its
// own migration. A blanket search for `[null, inputs.camera, ...]` therefore
// reds on code that is deliberately unchanged, which teaches people to edit
// the audit. This asserts only that the THREE hypercube menus are read through
// the resolver and nowhere else.
for (const id of HC_TEXSRC_IDS) {
  const reads = [...scene.matchAll(
    new RegExp(`['"]${id.replace(/\./g, '\\.')}['"]`, 'g'))];
  const viaResolver = [...scene.matchAll(
    new RegExp(`_resolveOptSource\\([^,]+,\\s*['"]${id.replace(/\./g, '\\.')}['"]`, 'g'))];
  check(`${id} is read only through _resolveOptSource in SceneManager`,
    reads.length > 0 && reads.length === viaResolver.length,
    `${reads.length} mention(s), ${viaResolver.length} through the resolver`);
}

check('main.js hands the canonical resolver to scene3d.render',
  /resolveSource:\s*_resolveLayerTex/.test(main));

// ── The remap preserves meaning, label for label ─────────────────────────────
// The list as it stood before the change, and what each entry resolved to.
const OLD_MENU = ['None', 'Camera', 'Movie', 'Screen', 'Draw', 'Buffer', 'Noise'];
const OLD_MEANS = {                 // old label -> the SOURCES label it bound to
  Camera: 'Camera',
  Movie:  'Movie A',
  Screen: 'Output',                 // it was pipeline.prev.texture
  Draw:   'Draw',
  Buffer: 'Buffer',
  Noise:  'Noise',
};
for (let old = 1; old < OLD_MENU.length; old++) {
  const label = OLD_MENU[old];
  const values = {};
  for (const id of HC_TEXSRC_IDS) values[id] = old;
  migrateHypercubeTexSrc(values, null, 2);          // a file written at schema 2
  const got = OPT_SOURCES[values[HC_TEXSRC_IDS[0]]];
  check(`old ${old} (${label}) still means ${OLD_MEANS[label]}`,
    got === OLD_MEANS[label], `got ${got}`);
}

check('None stays None', (() => {
  const v = { [HC_TEXSRC_IDS[0]]: 0 };
  migrateHypercubeTexSrc(v, null, 2);
  return v[HC_TEXSRC_IDS[0]] === 0;
})());

check('a file already at the current schema is left alone', (() => {
  const v = { [HC_TEXSRC_IDS[0]]: 5 };
  migrateHypercubeTexSrc(v, null, PARAM_SCHEMA);
  return v[HC_TEXSRC_IDS[0]] === 5;
})());

check('an absent stamp is treated as legacy and migrated', (() => {
  const v = { [HC_TEXSRC_IDS[0]]: 3 };            // old 'Screen'
  migrateHypercubeTexSrc(v, undefined, undefined);
  return OPT_SOURCES[v[HC_TEXSRC_IDS[0]]] === 'Output';
})());

check('controller recall bounds move with the value', (() => {
  const recs = { [HC_TEXSRC_IDS[1]]: { value: 3, ctrlMin: 1, ctrlMax: 6 } };
  migrateHypercubeTexSrc(null, recs, 2);
  const r = recs[HC_TEXSRC_IDS[1]];
  return OPT_SOURCES[r.value] === 'Output' &&
         OPT_SOURCES[r.ctrlMin] === 'Camera' &&
         OPT_SOURCES[r.ctrlMax] === 'Noise';
})());

check('the Display State wrapper migrates each state', (() => {
  const states = [{ values: { [HC_TEXSRC_IDS[0]]: 4 } }, null];
  migrateStatesHypercubeTexSrc(states, 2);
  return OPT_SOURCES[states[0].values[HC_TEXSRC_IDS[0]]] === 'Draw';
})());

// ── The gate can fire at all ─────────────────────────────────────────────────
check('PARAM_SCHEMA is at least 3, so the schema-2 gate is reachable',
  PARAM_SCHEMA >= 3, `PARAM_SCHEMA = ${PARAM_SCHEMA}`);

// ── Wired everywhere its twin is ─────────────────────────────────────────────
// Same schema stamp, same import paths: whatever calls one must call the other.
for (const [name, src] of [['Preset.js', preset], ['ProjectFile.js', project]]) {
  const blend  = (src.match(/migrateBlendPercent\s*\(/g)        || []).length;
  const hyper  = (src.match(/migrateHypercubeTexSrc\s*\(/g)     || []).length;
  const sBlend = (src.match(/migrateStatesBlendPercent\s*\(/g)  || []).length;
  const sHyper = (src.match(/migrateStatesHypercubeTexSrc\s*\(/g) || []).length;
  check(`${name} calls migrateHypercubeTexSrc wherever it calls migrateBlendPercent`,
    hyper >= blend, `${hyper} vs ${blend}`);
  check(`${name} calls migrateStatesHypercubeTexSrc wherever it calls the states twin`,
    sHyper >= sBlend, `${sHyper} vs ${sBlend}`);
}

console.log(failures
  ? `\nFAIL — ${failures} hypercube texsrc invariant(s) broken.\n`
  : '\nPASS — the menus are canonical and old files still recall the right source.\n');
process.exit(failures ? 1 : 0);
