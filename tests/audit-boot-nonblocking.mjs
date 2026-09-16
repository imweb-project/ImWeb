/**
 * Boot does not block on the first-launch project — and everything that needs
 * that project waits for it.
 *
 * The bug: `await _loadMasterProject()` sat at main.js ~2911, in front of the
 * remaining ~7400 lines of `main()`. On a fresh profile the panels were painted
 * (they are built ~1183) while the status bar below the await had no handlers
 * yet, so clicking the OSC chip did nothing and the app read as broken.
 * Measured headless: MasterProject loaded at +470 ms, the first click was
 * ignored, the second at ~2.2 s connected. A slow network makes that window
 * arbitrarily long.
 *
 * The fix makes boot non-blocking, which moves the danger rather than removing
 * it: `ProjectFile` STASHES data whose UI hook is not registered yet
 * (`pendingGlsl`, `pendingPanelLayout`), and a drain that now runs BEFORE the
 * import finds an empty stash, fills nothing, and loses the file's shader or
 * window layout with no error anywhere. That is the write-path-without-its-
 * read-path failure this project keeps paying for, so the invariant asserted
 * here is not "is it awaited" but:
 *
 *   every `this.pending<X>` stash in ProjectFile has a drain in main.js,
 *   and every one of those drains is chained off `bootProject`.
 *
 * A future third stash therefore cannot be added with an unchained drain
 * without this failing.
 *
 * Every match runs against COMMENT-STRIPPED source: the prose above says
 * "bootProject" and "await _loadMasterProject" repeatedly, and a proximity
 * check that counted comments would be satisfied by the explanation rather
 * than by the code it describes.
 *
 * Run:  node tests/audit-boot-nonblocking.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { stripComments } from './lib/source.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const mainCode = stripComments(readFileSync(join(root, 'src/main.js'), 'utf8'));
const projCode = stripComments(readFileSync(join(root, 'src/io/ProjectFile.js'), 'utf8'));

let failures = 0;
const check = (label, cond, detail = '') => {
  if (cond) console.log(`  ok   ${label}`);
  else { console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); failures++; }
};

console.log('\nthe first-launch project does not block the rest of boot');
check('the loader still runs, and its promise is kept',
  /bootProject\s*=\s*_loadMasterProject\s*\(/.test(mainCode),
  'nothing starts the first-launch import');
check('bootProject starts resolved, so a normal launch waits for nothing',
  /let\s+bootProject\s*=\s*Promise\.resolve\(\)/.test(mainCode));
check('the blocking form is gone', !/await\s+_loadMasterProject\s*\(/.test(mainCode),
  'await _loadMasterProject() is back — everything wired below it is dead until the fetch lands');

// Anchor on CODE, not on the section comment: `_firstLaunch` is a real read.
// A -1 here would make the filter below keep every await in the file, which
// reads as a loud failure rather than a quiet pass — but say so explicitly.
const firstLaunchAt = mainCode.indexOf('_firstLaunch');
check('the first-launch branch is still in main.js', firstLaunchAt !== -1,
  'presetMgr._firstLaunch is gone — this audit no longer knows where boot is');

// Top-level statements inside main() are indented exactly two spaces, so this
// finds an await that would block init without matching awaits inside
// callbacks, which are indented deeper and are not on the boot path.
if (firstLaunchAt !== -1) {
  const topLevelAwaits = [...mainCode.matchAll(/^ {2}(?:await |const [^=\n]+= await )/gm)]
    .filter(m => m.index > firstLaunchAt);
  check('nothing else blocks init after that point', topLevelAwaits.length === 0,
    `${topLevelAwaits.length} top-level await(s) after the first-launch branch`);
}

console.log('\nevery stashed-until-later payload is drained AFTER the import');
const stashes = [...projCode.matchAll(/this\.(pending[A-Za-z]+)\s*=/g)]
  .map(m => m[1])
  .filter((v, i, a) => a.indexOf(v) === i);
check('ProjectFile still stashes something (this audit has subjects)', stashes.length > 0,
  'no this.pending* found — renamed? then update this audit deliberately');
console.log(`  (${stashes.length} stash(es): ${stashes.join(', ')})`);

for (const name of stashes) {
  const reads = [...mainCode.matchAll(new RegExp(`projectFile\\.${name}`, 'g'))];
  check(`${name} is drained in main.js`, reads.length > 0,
    'stashed by ProjectFile and never read — the payload is silently dropped');
  // One verdict per stash, not one per mention: the drain touches the stash
  // two or three times and repeating the same check reads as extra coverage.
  const unchained = reads.filter(r =>
    !/bootProject\s*\.then\(/.test(mainCode.slice(Math.max(0, r.index - 500), r.index)));
  if (reads.length) {
    check(`…and that drain waits for bootProject (${name})`, unchained.length === 0,
      `${unchained.length}/${reads.length} reference(s) run before the import resolves: the stash fills afterwards and nothing reads it again`);
  }
}

console.log('\nthe mapping autosave still restores after the project, not before');
check('mappingAutosave.restore() is present', mainCode.includes('mappingAutosave.restore()'));
check('…and is chained off bootProject',
  /bootProject\s*\.then\(\s*\(\)\s*=>\s*\{[^}]*mappingAutosave\.restore\(\)/s.test(mainCode),
  "restores before the project lands, so a file's mappings would overwrite the autosave");

console.log(failures ? `\n${failures} failure(s)` : '\nall boot-ordering checks pass');
process.exit(failures ? 1 : 0);
