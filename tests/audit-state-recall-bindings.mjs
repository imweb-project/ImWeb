/**
 * A state recall changes the look, never what the desk is wired to.
 *
 * Display States used to be self-contained down to the MIDI map: `recallState`
 * cleared every controller and restored only what the state had saved, so a
 * binding learned in one state was gone in the next and the whole desk had to
 * be learned again after every state change. The owner called it "a wrong
 * decision earlier" (2026-11-24), and the master project showed the shape of
 * it: the bank carried no bindings at all while eight states each carried
 * their own copy of 5–14.
 *
 * The rule now, in one line: HARDWARE BINDINGS BELONG TO THE RIG, GENERATORS
 * BELONG TO THE STATE. `isPagedBinding` is the one predicate that tells them
 * apart, the same one mapping pages use.
 *
 * Why an audit: every way this can regress is silent. A recall that drops the
 * map throws nothing — the faders just stop. A recall that keeps a leftover
 * LFO throws nothing either — the look is just wrong one frame later.
 *
 * ── MUTATION CALIBRATION ────────────────────────────────────────────────────
 *
 * Caught: the recall calling the bag swap without `keepBindings`; the keep
 * branch returning before it removes a masking generator; a state capture
 * going back to `serializeControllers`; the legacy hand-over removed; an old
 * binding adopted onto a control already in use.
 *
 * Run:  node tests/audit-state-recall-bindings.mjs
 */

import { ParameterSystem } from '../src/controls/ParameterSystem.js';

globalThis.navigator ??= {};
globalThis.navigator.getGamepads = () => [null];
globalThis.document ??= {
  body: { classList: { toggle: () => {}, add: () => {}, remove: () => {} } },
  getElementById: () => null,
  querySelectorAll: () => [],
  addEventListener: () => {},
  querySelector: () => null,
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
const J = (v) => JSON.stringify(v);

function rig() {
  const ps = new ParameterSystem();
  for (const id of ['t.a', 't.b', 't.c'])
    ps.register({ id, label: id, group: 'g', min: 0, max: 100, value: 40 });
  const cm = new ControllerManager(ps);
  const pm = new PresetManager(ps, cm, null);
  const preset = new Preset(0);
  preset.save = async () => {};
  pm.presets = [preset];
  pm.currentIdx = 0;
  Object.defineProperty(pm, 'current', { get: () => preset, configurable: true });
  return { ps, cm, pm, preset };
}
const CC7 = { type: 'midi-cc', cc: 7, channel: 0 };

console.log('\na binding learned in one state is still there in the next');
{
  const { ps, cm, pm } = rig();
  await pm.saveCurrentState(0);
  await pm.saveCurrentState(1);
  await pm.recallState(0);
  cm.setPageBinding('t.a', CC7);
  await pm.recallState(1);
  check('the binding survives the recall', ps.get('t.a').controller?.cc === 7,
    J(ps.get('t.a').controller));
  check('and so does its page copy', ps.get('t.a').midiPages?.[0]?.cc === 7,
    J(ps.get('t.a').midiPages));
  await pm.recallState(0);
  check('and the recall back', ps.get('t.a').controller?.cc === 7,
    J(ps.get('t.a').controller));
}

console.log('\ngenerators still swap with the state');
{
  const { ps, cm, pm } = rig();
  cm.setPageBinding('t.a', CC7);
  cm.assign('t.b', { type: 'lfo-sine', hz: 1 });
  await pm.saveCurrentState(0);            // state 1: LFO on B
  cm.assign('t.b', null);
  await pm.saveCurrentState(1);            // state 2: none
  await pm.recallState(0);
  check('state 1 brings its LFO', ps.get('t.b').controller?.type === 'lfo-sine',
    J(ps.get('t.b').controller));
  await pm.recallState(1);
  check('state 2 takes it away again', ps.get('t.b').controller === null,
    J(ps.get('t.b').controller));
  check('with the binding untouched throughout', ps.get('t.a').controller?.cc === 7,
    J(ps.get('t.a').controller));
}

console.log('\na state no longer stores the desk');
{
  const { ps, cm, pm, preset } = rig();
  cm.setPageBinding('t.a', CC7);
  ps.get('t.a').ctrlMin = 10;
  cm.assign('t.b', { type: 'lfo-sine', hz: 1 });
  await pm.saveCurrentState(0);
  const bag = preset.getState(0)?.controllers ?? null;
  check('the state was captured', bag !== null);
  check('the bound param is not in it', !(bag && 't.a' in bag), J(bag?.['t.a']));
  check('the generator is', bag?.['t.b']?.controller?.type === 'lfo-sine', J(bag?.['t.b']));
  check('no entry carries pages',
    !!bag && Object.values(bag).every((c) => c.midiPages === undefined));
  check('the BANK has the binding instead', preset.controllers?.['t.a']?.controller?.cc === 7,
    J(preset.controllers?.['t.a']));
  check('without a value', !('value' in (preset.controllers?.['t.a'] ?? { value: 1 })));
  check('and without the state\'s generators', !('t.b' in (preset.controllers ?? {})));
}

console.log('\nlearning a binding does not make the look "unsaved"');
{
  const { cm, pm } = rig();
  await pm.saveCurrentState(0);
  await pm.recallState(0);
  check('clean after the recall', pm.liveIsUnsaved() === false);
  cm.setPageBinding('t.a', CC7);
  check('still clean with a binding learned', pm.liveIsUnsaved() === false);
  cm.assign('t.b', { type: 'lfo-sine', hz: 1 });
  check('but a new generator does count', pm.liveIsUnsaved() === true);
}

/**
 * States saved before the rule carry their own map, and for an old bank they
 * are the ONLY place it was written. So the map is taken up as the states are
 * visited — but never against the desk: a parameter the rig already binds
 * keeps its binding, and a control the rig already uses gets no second target.
 */
console.log('\nan old state that carries its own map');
{
  const { ps, cm, pm, preset } = rig();
  const old = {
    't.a': { id: 't.a', value: 40, controller: { type: 'midi-cc', cc: 3, channel: 0 } },
    't.b': { id: 't.b', value: 40, controller: { type: 'midi-cc', cc: 9, channel: 0 } },
    't.c': { id: 't.c', value: 40, controller: { type: 'midi-cc', cc: 7, channel: 0 } },
  };
  preset.addState({ 't.a': 40, 't.b': 40, 't.c': 40 }, 0, null, old);
  preset.addState({ 't.a': 40, 't.b': 40, 't.c': 40 }, 1, null, {});
  cm.setPageBinding('t.a', CC7);
  await pm.recallState(0);
  check('does not move a parameter the desk already binds', ps.get('t.a').controller?.cc === 7,
    J(ps.get('t.a').controller));
  check('adds a binding the desk did not have', ps.get('t.b').controller?.cc === 9,
    J(ps.get('t.b').controller));
  check('but puts no second parameter on a control in use', ps.get('t.c').controller === null,
    J(ps.get('t.c').controller));
  await pm.recallState(1);
  check('and what it added stays through the next recall', ps.get('t.b').controller?.cc === 9,
    J(ps.get('t.b').controller));
  check('as a page binding, not a loose one', ps.get('t.b').midiPages?.[0]?.cc === 9,
    J(ps.get('t.b').midiPages));
}
{
  const { ps, pm, preset } = rig();
  const old = { 't.b': { id: 't.b', value: 40, controller: { type: 'midi-cc', cc: 9, channel: 0 } } };
  preset.addState({ 't.a': 40, 't.b': 40, 't.c': 40 }, 0, null, old);
  preset.addState({ 't.a': 40, 't.b': 40, 't.c': 40 }, 1, null, {});
  await pm.recallState(0);
  check('hands its whole map to a desk with none', ps.get('t.b').controller?.cc === 9,
    J(ps.get('t.b').controller));
  await pm.recallState(1);
  check('which then stays through the next recall', ps.get('t.b').controller?.cc === 9,
    J(ps.get('t.b').controller));
}

console.log('\na state\'s generator plays over a binding, and gives it back');
{
  const { ps, cm, pm, preset } = rig();
  preset.addState({ 't.a': 40, 't.b': 40, 't.c': 40 }, 0, null,
    { 't.a': { id: 't.a', value: 40, controller: { type: 'lfo-sine', hz: 1 }, ctrlMin: 60, ctrlMax: 80 } });
  preset.addState({ 't.a': 40, 't.b': 40, 't.c': 40 }, 1, null, {});
  cm.setPageBinding('t.a', CC7);
  ps.get('t.a').ctrlMin = 10;
  await pm.recallState(0);
  check('the generator is live', ps.get('t.a').controller?.type === 'lfo-sine',
    J(ps.get('t.a').controller));
  check('with the state\'s range', ps.get('t.a').ctrlMin === 60, String(ps.get('t.a').ctrlMin));
  await pm.recallState(1);
  check('the binding returns', ps.get('t.a').controller?.cc === 7, J(ps.get('t.a').controller));
  check('with the range it had', ps.get('t.a').ctrlMin === 10 && ps.get('t.a').ctrlMax === null,
    `${ps.get('t.a').ctrlMin} / ${ps.get('t.a').ctrlMax}`);
}

console.log('\na binding on another page survives too');
{
  const { ps, cm, pm } = rig();
  await pm.saveCurrentState(0);
  cm.setMapPage(1);
  cm.setPageBinding('t.c', CC7);
  cm.setMapPage(0);
  await pm.recallState(0);
  cm.setMapPage(1);
  check('page 2 still has it after a recall on page 1', ps.get('t.c').controller?.cc === 7,
    J(ps.get('t.c').controller));
}

console.log('\nsoft takeover is armed for what the recall moved, and only that');
{
  const { ps, cm, pm, preset } = rig();
  preset.addState({ 't.a': 90, 't.b': 40, 't.c': 40 }, 0, null, {});
  cm.setPageBinding('t.a', CC7);
  cm.setPageBinding('t.b', { type: 'midi-cc', cc: 8, channel: 0 });
  cm._pickup.clear();
  await pm.recallState(0);
  check('the moved parameter is armed', cm._pickup.has('t.a'), J([...cm._pickup.keys()]));
  check('the unmoved one is not', !cm._pickup.has('t.b'), J([...cm._pickup.keys()]));
}

console.log(failures
  ? `\n${failures} state-recall binding check(s) FAILED\n`
  : '\nAll state-recall binding checks passed.\n');
process.exit(failures ? 1 : 0);
