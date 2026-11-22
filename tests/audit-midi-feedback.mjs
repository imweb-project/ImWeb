/**
 * MIDI feedback audit — two-way sync with a surface (MIDI Designer, motorised
 * faders, LED rings).
 *
 * What must stay true:
 *   1. something OTHER than the surface moving a bound param sends its value;
 *   2. the surface is never answered with its own move (echo rule), even when
 *      the param lands somewhere the CC did not say (SELECT detent);
 *   3. change-only: an unchanged desk sends nothing;
 *   4. a page switch and a Display State recall (`sendParamFeedback`) re-send;
 *   5. invert, slew TARGET, toggles, triggers, note pads and option buttons
 *      come out the way input would read them back;
 *   6. the `midi.feedback` toggle silences it, and the real registry declares
 *      it as a page-exempt TOGGLE, on by default.
 * Each "nothing sent" check is paired with a positive control that DOES send
 * through the same rig, so a dead rig cannot pass (LEARNED 2026-09-22).
 *
 * Run:  node tests/audit-midi-feedback.mjs
 */
import { ParameterSystem, PARAM_TYPE, MIDI_PAGES, registerCoreParameters }
  from '../src/controls/ParameterSystem.js';

globalThis.navigator ??= {};
globalThis.document ??= {
  body: { classList: { toggle() {}, add() {}, remove() {}, contains: () => false } },
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener: () => {},
};
globalThis.window ??= { addEventListener: () => {} };

const { ControllerManager, FEEDBACK_INTERVAL } = await import('../src/controls/ControllerManager.js');

let failures = 0;
const check = (label, cond, detail = '') => {
  if (cond) console.log(`  ok   ${label}`);
  else { console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); failures++; }
};

function rig() {
  const ps = new ParameterSystem();
  ps.register({ id: 't.a', label: 'A', group: 'g', min: 0, max: 100, value: 0 });
  ps.register({ id: 't.b', label: 'B', group: 'g', min: 0, max: 100, value: 0 });
  ps.register({ id: 't.sel', label: 'S', group: 'g', type: PARAM_TYPE.SELECT, value: 0,
    options: ['P0', 'P1', 'P2', 'P3', 'P4'] });
  ps.register({ id: 't.tog', label: 'T', group: 'g', type: PARAM_TYPE.TOGGLE, value: 0 });
  ps.register({ id: 't.trig', label: 'R', group: 'g', type: PARAM_TYPE.TRIGGER });
  ps.register({ id: 'midi.page', label: 'Map Page', group: 'global',
    type: PARAM_TYPE.SELECT, value: 0,
    options: Array.from({ length: MIDI_PAGES }, (_, i) => `${i + 1}`) });
  ps.register({ id: 'midi.pickup', label: 'Pickup', group: 'global', type: PARAM_TYPE.TOGGLE, value: 0 });
  ps.register({ id: 'midi.feedback', label: 'Feedback', group: 'global', type: PARAM_TYPE.TOGGLE, value: 1 });
  ps.register({ id: 'midi.slew', label: 'Learn Slew', group: 'global', min: 0, max: 1, value: 0 });

  const cm = new ControllerManager(ps);
  const sent = [];
  cm.midi = { outputs: new Map([['o', { send: (d) => sent.push([...d]) }]]) };
  const input = { onmidimessage: null };
  cm._attachMIDIInput(input);
  const cc = (num, val, ch = 1) => input.onmidimessage({ data: [0xB0 | (ch - 1), num, val] });
  const note = (n, vel, ch = 1) => input.onmidimessage({ data: [0x90 | (ch - 1), n, vel] });
  /** One feedback pass; returns what it sent. */
  const pass = () => { sent.length = 0; cm._tickFeedback(FEEDBACK_INTERVAL); return [...sent]; };
  return { ps, cm, cc, note, pass };
}
const ccMsg = (num, val, ch = 1) => JSON.stringify([0xB0 | (ch - 1), num, val]);
const has = (out, msg) => out.some((m) => JSON.stringify(m) === msg);

console.log('\n1–3. moves, echo, change-only');
{
  const { ps, cm, cc, pass } = rig();
  cm.assign('t.a', { type: 'midi-cc', cc: 10, channel: 1 });
  let out = pass();
  check('first pass dumps the bound control', has(out, ccMsg(10, 0)), JSON.stringify(out));
  out = pass();
  check('unchanged desk sends nothing', out.length === 0, JSON.stringify(out));
  ps.set('t.a', 50);
  out = pass();
  check('a non-surface move is sent (positive control)', has(out, ccMsg(10, 64)), JSON.stringify(out));
  cc(10, 100);
  check('the surface move reached the param', Math.abs(ps.get('t.a').value - 100 * 100 / 127) < 1e-6);
  out = pass();
  check('the surface is not answered with its own move', out.length === 0, JSON.stringify(out));
  ps.set('t.a', 10);
  out = pass();
  check('a later move after an echo is still sent', has(out, ccMsg(10, 13)), JSON.stringify(out));
}

console.log('\n2. echo rule holds when the param lands off the CC (SELECT detent)');
{
  const { ps, cm, cc, pass } = rig();
  cm.assign('t.sel', { type: 'midi-cc', cc: 20, channel: 1 });
  pass();
  cc(20, 70);            // 70/127 of 4 steps → index 2, which reads back as 64
  check('select landed on index 2', ps.get('t.sel').value === 2);
  const out = pass();
  check('no snap-back to the detent under the finger', out.length === 0, JSON.stringify(out));
  ps.set('t.sel', 4);
  check('select recall is sent', has(pass(), ccMsg(20, 127)));
}

console.log('\n4. page switch and Display State recall re-send');
{
  const { ps, cm, pass } = rig();
  cm.assign('t.a', { type: 'midi-cc', cc: 10, channel: 1 });
  pass();
  check('quiet before', pass().length === 0);
  cm.sendParamFeedback(ps.get('t.a'));
  check('sendParamFeedback forces a re-send', has(pass(), ccMsg(10, 0)));
  cm.setPageBinding('t.a', { type: 'midi-cc', cc: 10, channel: 1 });
  ps.set('t.b', 100);
  cm.setMapPage(1);
  cm.setPageBinding('t.b', { type: 'midi-cc', cc: 10, channel: 1 });
  pass();                                   // page 1 now shows t.b on CC 10
  ps.set('t.a', 0);
  cm.setMapPage(0);
  const out = pass();
  check('switching page re-sends what CC 10 now means', has(out, ccMsg(10, 0)), JSON.stringify(out));
}

console.log('\n5. inverse mapping, kinds');
{
  const { ps, cm, note, pass } = rig();
  cm.assign('t.a', { type: 'midi-cc', cc: 1, channel: 2 });
  ps.get('t.a').invert = true;
  ps.set('t.a', 25);
  check('invert is undone, channel kept', has(pass(), ccMsg(1, 95, 2)));

  ps.get('t.b').slew = 1;
  cm.assign('t.b', { type: 'midi-cc', cc: 2, channel: 1 });
  pass();
  ps.get('t.b').setNormalized(1);           // target 100, value still gliding at 0
  check('slew is mid-glide', ps.get('t.b').value < 100);
  check('slew TARGET is sent, not the glide', has(pass(), ccMsg(2, 127)));

  cm.assign('t.tog', { type: 'midi-note', note: 36, channel: 1 });
  cm.assign('t.trig', { type: 'midi-cc', cc: 3, channel: 1 });
  let out = pass();
  // Same pass DID send the toggle's first dump, so an empty `out` cannot pass.
  check('that pass sent something (positive control)', out.length === 1 && out[0][1] === 36, JSON.stringify(out));
  check('a trigger sends nothing', out.filter((m) => m[0] === 0xB0 && m[1] === 3).length === 0, JSON.stringify(out));
  ps.set('t.tog', 1);
  out = pass();
  check('toggle on a note pad lights it', has(out, JSON.stringify([0x90, 36, 127])), JSON.stringify(out));
  note(36, 127);                            // press on the pad itself
  out = pass();
  check('pad press is not echoed back', out.length === 0, JSON.stringify(out));

  cm.assign('t.sel', { type: 'midi-cc-map', ccs: [40, 41, 42, null, null], notes: [null, null, null, 60, null], channel: 1 });
  pass();
  ps.set('t.sel', 3);
  out = pass();
  check('option buttons: old one dark', has(out, ccMsg(40, 0)), JSON.stringify(out));
  check('option buttons: selected note pad lit', has(out, JSON.stringify([0x90, 60, 127])), JSON.stringify(out));
}

console.log('\n1. two params on one CC do not fight');
{
  const { ps, cm, pass } = rig();
  cm.assign('t.a', { type: 'midi-cc', cc: 5, channel: 1 });
  cm.assign('t.b', { type: 'midi-cc', cc: 5, channel: 1 });
  ps.set('t.a', 0); ps.set('t.b', 100);
  pass();
  check('settles: second pass is silent', pass().length === 0);
}

console.log('\n6. off switch and registry');
{
  const { ps, cm, pass } = rig();
  cm.assign('t.a', { type: 'midi-cc', cc: 10, channel: 1 });
  ps.set('midi.feedback', 0);
  ps.set('t.a', 70);
  check('midi.feedback off sends nothing', pass().length === 0);
  ps.set('midi.feedback', 1);
  check('back on, it sends (positive control)', pass().length > 0);

  const real = new ParameterSystem();
  registerCoreParameters(real);
  const f = real.get('midi.feedback');
  check('real midi.feedback is a TOGGLE', f?.type === PARAM_TYPE.TOGGLE);
  check('real midi.feedback defaults ON', f?.value === 1);
  check('real midi.feedback is group global', f?.group === 'global');
  check('midi.feedback is page-exempt', ControllerManager.PAGE_EXEMPT.has('midi.feedback'));
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
