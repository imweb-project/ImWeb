/**
 * A state recall that drops a binding must not leave the row advertising it.
 *
 * Display States are self-contained: `recallState` clears every controller and
 * restores only what that state saved. That is deliberate — a leftover LFO from
 * the previous state would keep writing to a parameter and corrupt the values
 * the recall just restored — and it means a mapping assigned but not saved into
 * the state is correctly gone after a recall.
 *
 * What was not deliberate is that the row went on showing it. `clearAllAssignments`
 * writes `p.controller = null` directly and notifies nothing; a row's badge is
 * refreshed by `updateDisplay()` off the param's `onChange`, which fires on a
 * VALUE change. So the badge repainted only when the recall also happened to
 * move that parameter — and a recall that restores the value already on screen
 * repaints nothing at all. MEASURED: `ps.set(id, sameValue)` fires 0 listeners.
 *
 * The owner hit it within minutes of the mapping-pages work landing and
 * reported it as broken hardware — "it say it is asigned, but not responding" —
 * which is what this failure sounds like from outside. The forgotten save was
 * theirs; the twenty minutes spent looking for a dispatch bug were the badge's.
 *
 * Why an audit rather than a manual check: every assertion here is invisible to
 * the model. `p.controller` is correct at every point in the sequence — the
 * defect exists only in the DOM, which is why a headless check that reads the
 * parameter passes while the instrument lies. So this drives a real badge
 * element and reads the TEXT back.
 *
 * ── MUTATION CALIBRATION ────────────────────────────────────────────────────
 *
 * Caught: the repaint removed; the repaint narrowed to params that still have a
 * controller (the cleared ones are exactly the stale ones); a bank load left
 * with its own un-repainted copy of the sequence.
 *
 * Run:  node tests/audit-state-recall-badges.mjs
 */

import { ParameterSystem, PARAM_TYPE } from '../src/controls/ParameterSystem.js';
import { readFileSync } from 'node:fs';

// ── A DOM with real badge elements ───────────────────────────────────────────
// The point of the file: a stub returning null makes `_repaintCtrlBadge` return
// early and every check below pass vacuously — the fail-open shape this suite
// exists to refuse (audit-midi-map-mode says the same about its own stub).
const badges = new Map();          // paramId -> { textContent, className }
const badgeFor = (id) => {
  if (!badges.has(id)) badges.set(id, { textContent: '', className: '' });
  return badges.get(id);
};
globalThis.navigator ??= {};
globalThis.navigator.getGamepads = () => [null];
globalThis.document ??= {
  body: { classList: { toggle: () => {}, add: () => {}, remove: () => {} } },
  getElementById: () => null,
  querySelectorAll: () => [],
  addEventListener: () => {},
  querySelector: (sel) => {
    const m = /\.param-row\[data-param-id="([^"]+)"\] \.param-ctrl/.exec(sel);
    return m ? badgeFor(m[1]) : null;
  },
};
globalThis.window ??= {};
globalThis.window.addEventListener ??= () => {};
const store = new Map();
globalThis.localStorage ??= {
  getItem: k => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: k => store.delete(k),
};

const { ControllerManager } = await import('../src/controls/ControllerManager.js');
const { PresetManager, Preset } = await import('../src/state/Preset.js');

let failures = 0;
const check = (label, cond, detail = '') => {
  if (cond) console.log(`  ok   ${label}`);
  else { console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); failures++; }
};

/**
 * What an unbound row shows — read off the model rather than hardcoded.
 *
 * An earlier version of this file asserted the badge went EMPTY, and went red
 * against a working repaint: the label for "no controller" is an em dash, so
 * the badge had changed from `OSC:/flic/1` to `—` exactly as intended. Reading
 * the blank from a fresh unassigned param means a future change of glyph
 * retunes this file instead of breaking it.
 */
const BLANK = (() => {
  const t = new ParameterSystem();
  t.register({ id: 'x', label: 'x', group: 'g', min: 0, max: 1, value: 0 });
  return t.get('x').controllerLabel;
})();
const showsBinding = (id) => {
  const txt = badgeFor(id).textContent;
  return txt !== BLANK && txt !== '';
};

function rig() {
  badges.clear();
  const ps = new ParameterSystem();
  ps.register({ id: 't.a', label: 'A', group: 'g', min: 0, max: 100, value: 40 });
  ps.register({ id: 't.b', label: 'B', group: 'g', min: 0, max: 100, value: 40 });
  const cm = new ControllerManager(ps);
  const pm = new PresetManager(ps, cm, null);
  const preset = new Preset(0);
  preset.save = async () => {};
  pm.presets = [preset];
  pm.currentIdx = 0;
  Object.defineProperty(pm, 'current', { get: () => preset, configurable: true });
  // Paint the badges once, as building the rows does.
  const paint = () => ps.getAll().forEach(p => cm._repaintCtrlBadge(p.id));
  return { ps, cm, pm, preset, paint };
}

console.log('\nthe instrument under test is wired (no vacuous passes)');
{
  const { ps, cm, paint } = rig();
  cm.assign('t.a', { type: 'lfo-sine', hz: 1 });
  paint();
  check('a real badge element is reachable', badgeFor('t.a') !== null);
  check('and the repaint actually writes to it',
    badgeFor('t.a').textContent === ps.get('t.a').controllerLabel
    && badgeFor('t.a').textContent !== '',
    JSON.stringify(badgeFor('t.a')));
}

/**
 * The owner's sequence. The value is deliberately UNCHANGED by the recall —
 * that is the case the old code could not see, because the badge rode on
 * `onChange` and an unchanged `set` fires nothing.
 */
console.log('\na recall that drops a binding blanks the badge');
{
  const { ps, cm, pm, paint } = rig();
  await pm.saveCurrentState(0);            // state 1: no bindings
  await pm.saveCurrentState(1);            // state 2: no bindings
  await pm.recallState(0);

  cm.setPageBinding('t.a', { type: 'osc', address: '/flic/1' });  // assigned, NOT saved
  paint();
  check('the badge shows the binding once assigned',
    /OSC/i.test(badgeFor('t.a').textContent), badgeFor('t.a').textContent);

  const valueBefore = ps.get('t.a').value;
  await pm.recallState(1);
  check('the recall really did drop the binding (the premise holds)',
    ps.get('t.a').controller === null, JSON.stringify(ps.get('t.a').controller));
  check('the recall left the VALUE untouched — the blind spot',
    ps.get('t.a').value === valueBefore,
    `${ps.get('t.a').value} vs ${valueBefore}`);
  check('AND THE BADGE STOPS SHOWING OSC',
    !showsBinding('t.a'),
    JSON.stringify(badgeFor('t.a').textContent));
}

console.log('\na recall that RESTORES a binding paints it back');
{
  const { ps, cm, pm, paint } = rig();
  cm.setPageBinding('t.a', { type: 'osc', address: '/flic/1' });
  await pm.saveCurrentState(0);            // state 1 carries the binding
  cm.assign('t.a', null);
  await pm.saveCurrentState(1);            // state 2 carries none
  await pm.recallState(1);
  paint();
  check('state 2 shows no binding', !showsBinding('t.a'),
    badgeFor('t.a').textContent);

  await pm.recallState(0);
  check('state 1 restores it in the model',
    ps.get('t.a').controller?.address === '/flic/1',
    JSON.stringify(ps.get('t.a').controller));
  check('and the badge says so without anything else having to change',
    /OSC/i.test(badgeFor('t.a').textContent), badgeFor('t.a').textContent);
}

console.log('\nevery row that changed is repainted, not just the first');
{
  const { ps, cm, pm, paint } = rig();
  await pm.saveCurrentState(1);            // state 2: no bindings
  cm.setPageBinding('t.a', { type: 'osc', address: '/flic/1' });
  cm.setPageBinding('t.b', { type: 'midi-cc', cc: 7 });
  paint();
  await pm.saveCurrentState(0);            // state 1: both bindings

  await pm.recallState(1);
  check('both badges stop naming a controller',
    !showsBinding('t.a') && !showsBinding('t.b'),
    `${badgeFor('t.a').textContent} / ${badgeFor('t.b').textContent}`);
  await pm.recallState(0);
  check('both badges come back', /OSC/i.test(badgeFor('t.a').textContent)
    && showsBinding('t.b'),
    `${badgeFor('t.a').textContent} / ${badgeFor('t.b').textContent}`);
}

/**
 * The siblings. `clearAllAssignments` has four callers and every one of them
 * had the same hole — a state recall, a bank load, Reset All Parameters, and
 * the controller map's Clear All. Fixing only the reported one is the mistake
 * LEARNED 2026-09-14 is about, so the repaint lives in the function that does
 * the blanking and this drives it DIRECTLY: whatever calls it, the badge goes.
 */
console.log('\nclearing assignments blanks the badge, whoever asked');
{
  const { ps, cm, paint } = rig();
  cm.setPageBinding('t.a', { type: 'osc', address: '/flic/1' });
  cm.assign('t.b', { type: 'lfo-sine', hz: 1 });
  paint();
  check('both rows show a controller first',
    showsBinding('t.a') && showsBinding('t.b'),
    `${badgeFor('t.a').textContent} / ${badgeFor('t.b').textContent}`);
  const before = ps.get('t.a').value;
  cm.clearAllAssignments();
  check('no value moved — nothing else could have repainted',
    ps.get('t.a').value === before, String(ps.get('t.a').value));
  check('the OSC badge stops naming it', !showsBinding('t.a'),
    JSON.stringify(badgeFor('t.a').textContent));
  check('the LFO badge stops naming it', !showsBinding('t.b'),
    JSON.stringify(badgeFor('t.b').textContent));
}

console.log('\nthe bag swap is one function, so a second caller cannot half-do it');
{
  const { sanitizeSource, calibrateSanitizer } =
    await import('./lib/sanitize-source.mjs');
  calibrateSanitizer(check);   // a stripper that strips nothing passes everything
  const raw = readFileSync(new URL('../src/state/Preset.js', import.meta.url), 'utf8');
  // Comment-stripped: an earlier version of this check counted the mentions in
  // its own explanation and went red against correct code.
  const src = sanitizeSource(raw, { blankStrings: false });
  const bagCalls = src.match(/_applyControllerBag\(/g) ?? [];
  check('the bag swap is one function', /_applyControllerBag\(bag\)/.test(src));
  check('and both call sites use it (declaration + 2 uses)',
    bagCalls.length === 3, `${bagCalls.length} occurrences`);
  check('neither call site clears assignments on its own',
    (src.match(/clearAllAssignments\(\)/g) ?? []).length === 1,
    'clearAllAssignments should appear only inside the bag swap');
  check('the restore half repaints', /_repaintCtrlBadge\?\.\(id\)/.test(src));
}

console.log(failures
  ? `\n${failures} state-recall badge check(s) FAILED\n`
  : '\nAll state-recall badge checks passed.\n');
process.exit(failures ? 1 : 0);
