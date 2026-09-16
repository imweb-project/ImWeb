/**
 * Mapping pages hold every PHYSICAL binding, not just the MIDI ones.
 *
 * Pages were built for a desk: a nanoKONTROL2 has eight faders and the
 * instrument has hundreds of parameters, so `param.midiPages[i]` holds the
 * binding for page i and `param.controller` is the live projection of the
 * current page. OSC and gamepad bindings were written straight into
 * `controller` and never entered a page at all — which on a rig with no MIDI on
 * it (the owner's: a relay and a Flic) meant the page controls existed, moved,
 * repainted, and changed nothing whatsoever.
 *
 * Every failure in this file is silent in the same way. Nothing throws. The
 * binding still works, the page indicator still moves, and the only symptom is
 * that a page switch does not do what the page switch is for — or, in the
 * opposite direction, that it quietly eats a mapping. Specifically:
 *
 *  - a learned OSC address that never enters a page keeps working on every
 *    page, so pages look "not implemented" rather than broken;
 *  - once it DOES enter a page, the projection must reach it on the way back,
 *    or the first page switch deletes a working mapping with no message;
 *  - `clearAllMIDI` emptied the whole page array, so a button labelled "Clear
 *    All MIDI" would have taken an entire OSC layout with it — and the
 *    confirmation dialog would have counted those bindings as MIDI while
 *    promising to spare everything that is not;
 *  - a saved file written before this seeds page 1 from `controller`, and the
 *    seed read `startsWith('midi')`, so an OSC rig's whole mapping stayed
 *    unpaged after the upgrade;
 *  - soft takeover was armed for anything continuous, which for a press-only
 *    remote (a Flic sends the same message every click, so it can never cross
 *    the value) means the binding is swallowed FOREVER and reads as dead. This
 *    one shipped, and the owner found it within the hour: "it say it is
 *    asigned, but not responding". The first attempt guessed a button from an
 *    argument-less message and was checked only against that spelling; their
 *    relay forwards `1`, so the guess never fired. Both spellings are driven
 *    here, and OSC is now never armed at all.
 *
 * The load-bearing shape here is "both directions". A check that a binding
 * leaves on a page switch passes just as well against code that erased it, so
 * every disappearance is paired with the return.
 *
 * ── MUTATION CALIBRATION ────────────────────────────────────────────────────
 *
 * Caught: `isPagedBinding` narrowed back to midi-only; OSC learn routed through
 * `assign` again; the gamepad menu routed through `assign`; the migration seed
 * narrowed to midi; `clearAllMIDI` emptying the array; pickup armed for gamepad
 * buttons; pickup not consulted on a gamepad axis; the bare-press disarm
 * dropped; `setPageBinding` letting an LFO into a page.
 *
 * Run:  node tests/audit-mapping-pages.mjs
 */

import { ParameterSystem, PARAM_TYPE, MIDI_PAGES }
  from '../src/controls/ParameterSystem.js';
import { isPagedBinding } from '../src/controls/controlInput.js';
import { readFileSync } from 'node:fs';

// ── Stubs ────────────────────────────────────────────────────────────────────
// One fake pad, mutated between ticks, exactly as audit-gamepad models it.
const pads = [null];
globalThis.navigator ??= {};
globalThis.navigator.getGamepads = () => pads;
globalThis.document ??= {
  body: { classList: { toggle: () => {}, add: () => {}, remove: () => {} } },
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener: () => {},
};
globalThis.window ??= {};
globalThis.window.addEventListener ??= () => {};
const sockets = [];
class FakeWS {
  static OPEN = 1;
  constructor(url) { this.url = url; this.readyState = 0; this.sent = []; sockets.push(this); }
  send(s) { this.sent.push(JSON.parse(s)); }
  close() { this.readyState = 3; }
}
globalThis.WebSocket = FakeWS;
const store = new Map();
globalThis.localStorage ??= {
  getItem: k => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: k => store.delete(k),
};

const { ControllerManager } = await import('../src/controls/ControllerManager.js');
const { OSCBridge } = await import('../src/io/OSCBridge.js');

let failures = 0;
const check = (label, cond, detail = '') => {
  if (cond) console.log(`  ok   ${label}`);
  else { console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); failures++; }
};

const newPad = () => ({
  id: 'fake', index: 0, mapping: 'standard',
  axes: [0, 0, 0, 0],
  buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })),
});

/**
 * A ControllerManager and an OSCBridge over ONE ParameterSystem, plus a pad.
 *
 * The page params are mirrored from the real registry rather than imported with
 * it; a check at the bottom asserts the real registry still declares them, so a
 * drift fails there instead of silently testing a fiction.
 */
function rig() {
  pads[0] = null;
  const ps = new ParameterSystem();
  ps.register({ id: 't.a', label: 'A', group: 'g', min: 0, max: 100, value: 0 });
  ps.register({ id: 't.b', label: 'B', group: 'g', min: 0, max: 100, value: 0 });
  ps.register({ id: 't.tog', label: 'T', group: 'g', type: PARAM_TYPE.TOGGLE, value: 0 });
  ps.register({ id: 't.lfo', label: 'L', group: 'g', min: 0, max: 100, value: 0 });
  ps.register({ id: 'midi.page', label: 'Map Page', group: 'global',
    type: PARAM_TYPE.SELECT, value: 0,
    options: Array.from({ length: MIDI_PAGES }, (_, i) => `${i + 1}`) });
  ps.register({ id: 'midi.pagePrev', label: 'P-', group: 'global', type: PARAM_TYPE.TRIGGER });
  ps.register({ id: 'midi.pageNext', label: 'P+', group: 'global', type: PARAM_TYPE.TRIGGER });
  ps.register({ id: 'midi.pickup', label: 'Pickup', group: 'global',
    type: PARAM_TYPE.TOGGLE, value: 1 });
  // 0, not the shipped 0.3: learning slews a continuous parameter, and every
  // value assertion here would otherwise be measuring the slew.
  ps.register({ id: 'midi.slew', label: 'Learn Slew', group: 'global',
    min: 0, max: 1, value: 0, step: 0.01 });

  const cm = new ControllerManager(ps);
  const bridge = new OSCBridge(ps, { loadPreset() {} });
  // The door main.js uses: it wires BOTH directions. Calling only
  // bridge.setControllerManager() leaves cm.oscBridge unset, so anything the
  // manager pushes to the remote would silently go nowhere in this rig.
  cm.setOSCBridge(bridge);
  bridge.connect('ws://relay');
  const ws = sockets.at(-1);
  ws.readyState = FakeWS.OPEN;
  ws.onopen?.();
  const msg = (address, args = []) =>
    ws.onmessage({ data: JSON.stringify({ address, args }) });

  // The pad's first frame is a READING, not a move, so `tick` seeds it once.
  const pad = newPad();
  const seat = () => { pads[0] = pad; cm._tickGamepad(); };
  const tick = () => cm._tickGamepad();
  return { ps, cm, bridge, ws, msg, pad, seat, tick };
}

console.log('\nthe predicate: what a mapping page is allowed to hold');
{
  for (const t of ['midi-cc', 'midi-note', 'midi-cc-map', 'osc',
                   'gamepad-axis-0', 'gamepad-btn-3']) {
    check(`${t} is paged`, isPagedBinding(t));
  }
  // `key` is deliberately out: a computer keyboard has a hundred keys and is
  // always attached, so it has none of the scarcity pages exist to relieve.
  for (const t of ['key', 'lfo-sine', 'random', 'fixed', 'expr',
                   'sound', 'mouse-x', 'tilt-x', 'stroke']) {
    check(`${t} is NOT paged`, !isPagedBinding(t));
  }
  check('undefined is not paged', !isPagedBinding(undefined));
  check('null is not paged', !isPagedBinding(null));
}

console.log('\na learned OSC address lands in the CURRENT page');
{
  const { ps, cm } = rig();
  cm.setMapPage(1);
  cm.setPageBinding('t.a', { type: 'osc', address: '/flic/1' });
  const p = ps.get('t.a');
  check('page 2 holds it', p.midiPages[1]?.address === '/flic/1',
    JSON.stringify(p.midiPages));
  check('page 1 does not', !p.midiPages[0]);
  check('and it is projected live', p.controller?.address === '/flic/1');
}

console.log('\nthe OSC binding leaves on a page switch AND comes back');
{
  const { ps, cm, msg } = rig();
  cm.setPageBinding('t.a', { type: 'osc', address: '/fader/1' });
  const p = ps.get('t.a');

  msg('/fader/1', [0.5]);
  check('it drives the param on its own page', p.value === 50, String(p.value));

  cm.setMapPage(1);
  check('page 2 has no binding projected', p.controller === null,
    JSON.stringify(p.controller));
  msg('/fader/1', [0.9]);
  check('and the address no longer reaches it', p.value === 50, String(p.value));

  cm.setMapPage(0);
  check('back on page 1 the binding returns', p.controller?.address === '/fader/1',
    JSON.stringify(p.controller));
  msg('/fader/1', [0.7]);
  check('and the VERY FIRST message drives the param again', p.value === 70,
    String(p.value));
}

/**
 * The owner's report, verbatim as a scenario: "i tested to asign flic to 2
 * different stages. after asigning clicks to the second one and then return to
 * the previous one, it say it is asigned, but not responding."
 *
 * Soft takeover was armed for the returning OSC binding, and a Flic sends the
 * same value every click, so it could never cross the parameter's value and
 * every press was swallowed — with the badge still showing the binding, which
 * is what makes it read as broken hardware rather than as a mode.
 *
 * Driven at BOTH spellings a relay might forward. The bug was invisible to the
 * argument-less one, which is the spelling the first fix guessed at and the
 * only one it was checked against.
 */
console.log('\nREGRESSION: a Flic still works after a page switch and back');
{
  for (const [label, args] of [['no argument', []], ['[1]', [1]]]) {
    const { ps, cm, msg } = rig();
    const p = ps.get('t.a');
    cm.setPageBinding('t.a', { type: 'osc', address: '/flic/1' });
    p.value = 30;
    cm.setMapPage(1);
    cm.setPageBinding('t.b', { type: 'osc', address: '/flic/1' });
    msg('/flic/1', args);
    check(`${label}: it drives the page-2 row`, ps.get('t.b').value === 100,
      String(ps.get('t.b').value));
    cm.setMapPage(0);
    check(`${label}: back on page 1 it still says assigned`,
      p.controller?.address === '/flic/1', JSON.stringify(p.controller));
    msg('/flic/1', args);
    check(`${label}: AND IT RESPONDS`, p.value === 100, String(p.value));
  }
}

console.log('\ntwo remotes, two pages, one row');
{
  const { ps, cm, msg } = rig();
  cm.setPageBinding('t.a', { type: 'osc', address: '/A' });
  cm.setMapPage(1);
  cm.setPageBinding('t.a', { type: 'osc', address: '/B' });
  const p = ps.get('t.a');
  ps.set('midi.pickup', 0);          // measuring projection, not takeover

  msg('/B', [0.25]);
  check('page 2 answers /B', p.value === 25, String(p.value));
  msg('/A', [0.75]);
  check('page 2 ignores /A', p.value === 25, String(p.value));

  cm.setMapPage(0);
  msg('/A', [0.75]);
  check('page 1 answers /A', p.value === 75, String(p.value));
  msg('/B', [0.1]);
  check('page 1 ignores /B', p.value === 75, String(p.value));
}

console.log('\na gamepad axis pages the same way');
{
  const { ps, cm, pad, seat, tick } = rig();
  cm.setPageBinding('t.a', { type: 'gamepad-axis-0' });
  ps.set('midi.pickup', 0);
  const p = ps.get('t.a');
  seat();
  pad.axes[0] = 0.5;                 // deadzone-rescaled, then 0..1: > centre
  tick();
  const moved = p.value;
  check('the stick drives the param on its page', moved > 50, String(moved));

  cm.setMapPage(1);
  check('page 2 projects it away', p.controller === null);
  pad.axes[0] = -0.5;
  tick();
  check('and the stick no longer reaches it', p.value === moved, String(p.value));

  cm.setMapPage(0);
  check('page 1 restores the binding',
    p.controller?.type === 'gamepad-axis-0', JSON.stringify(p.controller));
}

console.log('\nan LFO is never paged, and a page switch does not touch it');
{
  const { ps, cm } = rig();
  cm.setPageBinding('t.lfo', { type: 'lfo-sine', hz: 1 });
  const p = ps.get('t.lfo');
  check('it did not enter a page', !p.midiPages?.some(Boolean),
    JSON.stringify(p.midiPages));
  check('but it IS assigned', p.controller?.type === 'lfo-sine');
  cm.setMapPage(2);
  check('and it survives a page switch', p.controller?.type === 'lfo-sine',
    JSON.stringify(p.controller));
  cm.setMapPage(0);
  check('and another one back', p.controller?.type === 'lfo-sine');
}

console.log('\nClear All MIDI spares OSC and gamepad, and counts only MIDI');
{
  const { ps, cm } = rig();
  cm.setPageBinding('t.a', { type: 'midi-cc', cc: 7 });
  cm.setMapPage(1);
  cm.setPageBinding('t.a', { type: 'osc', address: '/keep' });
  cm.setPageBinding('t.b', { type: 'gamepad-btn-0' });
  cm.setMapPage(2);
  cm.setPageBinding('t.b', { type: 'midi-note', note: 60 });
  cm.setMapPage(0);

  const n = cm.clearAllMIDI();
  check('it counted exactly the two MIDI bindings', n === 2, String(n));
  check('the CC is gone from page 1', !ps.get('t.a').midiPages[0],
    JSON.stringify(ps.get('t.a').midiPages));
  check('the note is gone from page 3', !ps.get('t.b').midiPages[2]);
  check('the OSC address on page 2 SURVIVES',
    ps.get('t.a').midiPages[1]?.address === '/keep',
    JSON.stringify(ps.get('t.a').midiPages));
  check('the gamepad button on page 2 survives',
    ps.get('t.b').midiPages[1]?.type === 'gamepad-btn-0');
  check('the live projection of the cleared page is null',
    ps.get('t.a').controller === null);

  cm.setMapPage(1);
  check('and switching to page 2 brings the OSC binding back',
    ps.get('t.a').controller?.address === '/keep');
}

console.log('\nan unmap clears the PAGE, not just the projection');
{
  const { ps, cm } = rig();
  cm.setPageBinding('t.a', { type: 'osc', address: '/gone' });
  cm.setPageBinding('t.a', null);
  const p = ps.get('t.a');
  check('the projection is null', p.controller === null);
  check('the page entry is null too', !p.midiPages?.some(Boolean),
    JSON.stringify(p.midiPages));
  cm.setMapPage(1); cm.setMapPage(0);
  check('so it does not return on a page switch', p.controller === null,
    JSON.stringify(p.controller));
}

console.log('\na file written before this seeds page 1 from `controller`');
{
  const ps = new ParameterSystem();
  ps.register({ id: 't.osc', label: 'O', group: 'g', min: 0, max: 100, value: 0 });
  ps.register({ id: 't.pad', label: 'P', group: 'g', min: 0, max: 100, value: 0 });
  ps.register({ id: 't.lfo', label: 'L', group: 'g', min: 0, max: 100, value: 0 });
  ps.register({ id: 't.key', label: 'K', group: 'g', min: 0, max: 100, value: 0 });
  ps.get('t.osc').deserialize({ id: 't.osc', controller: { type: 'osc', address: '/old' } });
  ps.get('t.pad').deserialize({ id: 't.pad', controller: { type: 'gamepad-axis-1' } });
  ps.get('t.lfo').deserialize({ id: 't.lfo', controller: { type: 'lfo-sine', hz: 2 } });
  ps.get('t.key').deserialize({ id: 't.key', controller: { type: 'key', key: 'q' } });

  check('an unpaged OSC binding becomes page 1',
    ps.get('t.osc').midiPages?.[0]?.address === '/old',
    JSON.stringify(ps.get('t.osc').midiPages));
  check('an unpaged gamepad binding becomes page 1',
    ps.get('t.pad').midiPages?.[0]?.type === 'gamepad-axis-1');
  check('an LFO is NOT seeded into a page',
    !ps.get('t.lfo').midiPages?.some(Boolean),
    JSON.stringify(ps.get('t.lfo').midiPages));
  check('nor is a keyboard binding',
    !ps.get('t.key').midiPages?.some(Boolean),
    JSON.stringify(ps.get('t.key').midiPages));

  // A file that already HAS pages is taken at its word, not re-seeded.
  const p = ps.get('t.osc');
  p.deserialize({ id: 't.osc', controller: { type: 'osc', address: '/live' },
    midiPages: [null, { type: 'osc', address: '/two' }] });
  check('an already-paged file is not re-seeded from controller',
    !p.midiPages[0] && p.midiPages[1]?.address === '/two',
    JSON.stringify(p.midiPages));
}

console.log('\na paged OSC binding survives a round trip');
{
  const { ps, cm } = rig();
  cm.setMapPage(2);
  cm.setPageBinding('t.a', { type: 'osc', address: '/rt' });
  const blob = ps.get('t.a').serialize();
  const fresh = new ParameterSystem();
  fresh.register({ id: 't.a', label: 'A', group: 'g', min: 0, max: 100, value: 0 });
  fresh.get('t.a').deserialize(blob);
  check('page 3 restores', fresh.get('t.a').midiPages?.[2]?.address === '/rt',
    JSON.stringify(fresh.get('t.a').midiPages));
}

console.log('\nsoft takeover now reaches a gamepad axis');
{
  const { ps, cm, pad, seat, tick } = rig();
  const p = ps.get('t.a');
  cm.setPageBinding('t.a', { type: 'gamepad-axis-0' });
  seat();
  pad.axes[0] = 0.6; tick();         // park the stick high
  p.value = 20;                      // and the parameter low
  cm.setMapPage(1); cm.setMapPage(0);  // arms pickup

  pad.axes[0] = 0.55; tick();
  check('the first reading is swallowed', p.value === 20, String(p.value));
  pad.axes[0] = 0.5; tick();
  check('and so is one that has not crossed yet', p.value === 20, String(p.value));
  pad.axes[0] = -0.9; tick();
  check('crossing the value takes control', p.value < 20, String(p.value));
}

console.log('\nsoft takeover is NOT armed where there is no position to take');
{
  const { ps, cm, pad, seat, tick } = rig();
  const p = ps.get('t.a');
  cm.setPageBinding('t.a', { type: 'gamepad-btn-2' });
  p.value = 50;
  cm.setMapPage(1); cm.setMapPage(0);
  check('a gamepad button is not armed', !cm._pickup.has('t.a'));
  seat();
  pad.buttons[2] = { pressed: true, value: 1 };
  tick();
  check('so the very first press acts', p.value === 100, String(p.value));
}

/**
 * An OSC binding is NEVER armed for soft takeover, whatever it looks like.
 *
 * The distinction pickup needs — is this a fader or a button? — does not exist
 * at an address. Guessing it per message ("no argument means a button") was
 * measured wrong against the owner's relay, which forwards `1`, and the cost of
 * guessing wrong is not a jump but a control that is permanently dead while
 * still reporting as assigned. A jump is visible and recoverable; a dead button
 * mid-set is neither.
 *
 * Asserted at the arming site as well as through behaviour: an inert gate
 * further down would keep passing the behavioural checks while quietly doing
 * nothing, which is the shape this suite exists to refuse.
 */
console.log('\nsoft takeover never arms an OSC binding, fader-shaped or not');
{
  for (const [label, first, second] of [
    ['a button repeating one value', [1], [1]],
    ['a fader parked above the param', [0.9], [0.8]],
    ['an argument-less press', [], []],
  ]) {
    const { ps, cm, msg } = rig();
    const p = ps.get('t.a');
    cm.setPageBinding('t.a', { type: 'osc', address: '/x' });
    p.value = 50;
    cm.setMapPage(1); cm.setMapPage(0);
    check(`${label}: not armed`, !cm._pickup.has('t.a'));
    msg('/x', first);
    const expect = first.length ? first[0] * 100 : 100;
    check(`${label}: the first message lands`, p.value === expect,
      `${p.value}, expected ${expect}`);
    msg('/x', second);
    const expect2 = second.length ? second[0] * 100 : 100;
    check(`${label}: and so does the second`, p.value === expect2,
      `${p.value}, expected ${expect2}`);
  }
}

console.log('\nbut a MIDI fader still picks up — the reason pickup exists');
{
  const { ps, cm } = rig();
  const p = ps.get('t.a');
  cm.setPageBinding('t.a', { type: 'midi-cc', cc: 7 });
  p.value = 50;
  cm.setMapPage(1); cm.setMapPage(0);
  check('a MIDI CC binding IS armed', cm._pickup.has('t.a'));
  check('a value above the param is swallowed', cm._pickupBlocks(p, 0.9));
  check('still swallowed on the way down', cm._pickupBlocks(p, 0.8));
  check('and released once it crosses', !cm._pickupBlocks(p, 0.3));
}

console.log('\na latched row never picks up — the press IS the travel');
{
  const { ps, cm, msg } = rig();
  const p = ps.get('t.a');
  cm.setPageBinding('t.a', { type: 'osc', address: '/flic/2', latch: true });
  p.value = 10;
  cm.setMapPage(1); cm.setMapPage(0);
  check('a latched row is not armed', !cm._pickup.has('t.a'));
  msg('/flic/2', [1]);
  check('and the first press travels to the far end', p.value === 100,
    String(p.value));
  msg('/flic/2', [1]);
  check('the next press comes back', p.value === 0, String(p.value));
}

/**
 * A page switch changes which param is behind an address without changing any
 * VALUE, and feedback rides on onChange — so without a push the remote keeps
 * showing the previous page. Every check reads the socket, which is what the
 * remote would receive; the model being right is not the question.
 */
console.log('\na page switch tells the remote where its controls now are');
{
  const { ps, cm, bridge, ws } = rig();
  const flush = () => { const n = ws.sent.length; bridge._flush(); return ws.sent.slice(n); };
  const to = (out, address) => out.filter(o => o.address === address);
  ps.set('t.a', 30);
  ps.set('t.b', 70);
  cm.setPageBinding('t.a', { type: 'osc', address: '/1/f' });
  cm.setMapPage(1);
  cm.setPageBinding('t.b', { type: 'osc', address: '/1/f' });
  cm.setMapPage(0);
  flush();

  cm.setMapPage(1);
  let out = flush();
  check('switching to page 2 sends the page-2 value to the fader',
    to(out, '/1/f').length === 1 && Math.abs(to(out, '/1/f')[0].args[0] - 0.7) < 1e-9,
    JSON.stringify(out));
  check('and nothing else — only what the remote talks to', out.length === 1,
    JSON.stringify(out));
  check('it is one burst, not a stream', flush().length === 0);

  cm.setMapPage(0);
  out = flush();
  check('switching back sends the page-1 value again',
    Math.abs(to(out, '/1/f')[0]?.args[0] - 0.3) < 1e-9, JSON.stringify(out));
}
{
  // Same value on both pages: the fader already shows it, so say nothing.
  const { ps, cm, bridge, ws } = rig();
  ps.set('t.a', 40);
  ps.set('t.b', 40);
  cm.setPageBinding('t.a', { type: 'osc', address: '/1/f' });
  cm.setMapPage(1);
  cm.setPageBinding('t.b', { type: 'osc', address: '/1/f' });
  bridge._flush();
  const n = ws.sent.length;
  cm.setMapPage(0);
  bridge._flush();
  check('an unchanged position is not resent', ws.sent.length === n,
    JSON.stringify(ws.sent.slice(n)));
}
{
  // The fader moved on a page where it drives nothing. Believing it still
  // shows the old value would suppress the send on the way back.
  const { ps, cm, bridge, ws, msg } = rig();
  ps.set('t.a', 30);
  cm.setPageBinding('t.a', { type: 'osc', address: '/1/f' });
  bridge._flush();
  cm.setMapPage(1);
  msg('/1/f', [0.9]);
  bridge._flush();
  check('an unbound fader drives nothing', ps.get('t.a').value === 30);
  const n = ws.sent.length;
  cm.setMapPage(0);
  bridge._flush();
  const back = ws.sent.slice(n).filter(o => o.address === '/1/f');
  check('a fader moved on another page is put back on returning',
    back.length === 1 && Math.abs(back[0].args[0] - 0.3) < 1e-9,
    JSON.stringify(ws.sent.slice(n)));
}
{
  // A value already sent under /imweb/<id> says nothing about a fader that has
  // just been bound to that param at a different address.
  const { ps, cm, bridge, ws, msg } = rig();
  ps.set('t.a', 30);
  msg('/imweb/t.a', [0.5]);   // the remote asks about t.a by id
  bridge._flush();
  ps.set('t.a', 60);
  bridge._flush();            // /imweb/t.a 0.6 goes out
  const n = ws.sent.length;
  cm.setPageBinding('t.a', { type: 'osc', address: '/2/f' });
  bridge._flush();
  const got = ws.sent.slice(n).filter(o => o.address === '/2/f');
  check('binding to a new address sends there even though the value is unchanged',
    got.length === 1 && Math.abs(got[0].args[0] - 0.6) < 1e-9,
    JSON.stringify(ws.sent.slice(n)));
}
{
  // A recall / bank load re-projects through assign() after clearing, with the
  // value often already in place.
  const { ps, cm, bridge, ws } = rig();
  ps.set('t.a', 30);
  cm.assign('t.b', { type: 'osc', address: '/1/f' });
  bridge._flush();
  cm.clearAllAssignments();
  const n = ws.sent.length;
  cm.assign('t.a', { type: 'osc', address: '/1/f' });
  bridge._flush();
  const got = ws.sent.slice(n).filter(o => o.address === '/1/f');
  check('a rebind through assign() (recall, bank load) tells the remote',
    got.length === 1 && Math.abs(got[0].args[0] - 0.3) < 1e-9,
    JSON.stringify(ws.sent.slice(n)));
}

/**
 * A setting made in the badge popover must live on the PAGE, not only on the
 * projection — a page switch projects the page's copy, so an edit that stops
 * at `param.controller` is undone by switching away and back. Reported by the
 * owner: Latch ticked on a page-2 OSC binding was gone after visiting page 1.
 *
 * Drives the REAL popover over a fake DOM and ticks the real checkbox: the
 * model was correct at every step of the failing sequence except the one
 * write the popover never made, so a check that calls the manager directly
 * would have passed on the shipped bug.
 */
console.log('\na popover edit survives a page switch');
{
  const { openCtrlPopover } = await import('../src/ui/components/CtrlPopover.js');
  const fakeEl = (tag) => {
    const e = {
      tagName: tag.toUpperCase(), children: [], style: {}, _on: {},
      className: '', textContent: '', innerHTML: '',
      appendChild(ch) { this.children.push(ch); return ch; },
      addEventListener(t, f) { (this._on[t] ??= []).push(f); },
      removeEventListener() {}, remove() {}, contains: () => false,
      getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }),
      focus() {}, select() {}, setPointerCapture() {}, hasPointerCapture: () => false,
      fire(t, ev = {}) {
        for (const f of this._on[t] ?? []) {
          f({ preventDefault() {}, stopPropagation() {}, target: this, ...ev });
        }
      },
    };
    return e;
  };
  const opened = [];
  Object.assign(globalThis.document, {
    createElement: fakeEl,
    body: { ...globalThis.document.body, appendChild: (p) => opened.push(p) },
    removeEventListener: () => {},
  });
  globalThis.getComputedStyle ??= () => ({ zoom: '1' });
  globalThis.requestAnimationFrame ??= () => 0;
  const walk = (n, pred, out = []) => {
    if (pred(n)) out.push(n);
    for (const ch of n.children ?? []) walk(ch, pred, out);
    return out;
  };
  const valueOfRow = (pop, label) =>
    walk(pop, (n) => n.children?.[0]?.textContent === label)[0]?.children[1];
  const typeInto = (span, v) => {
    span.fire('dblclick');
    const input = span.children.at(-1);
    input.value = String(v);
    input.fire('keydown', { key: 'Enter' });
  };
  const open = (ps, cm, id) => {
    openCtrlPopover(ps.get(id), fakeEl('span'), cm, null);
    return opened.at(-1);
  };

  {
    const { ps, cm } = rig();
    cm.setMapPage(1);
    cm.setPageBinding('t.a', { type: 'osc', address: '/flic/1' });
    const box = walk(open(ps, cm, 't.a'), (n) => n.type === 'checkbox')[0];
    check('the popover offers Latch on a continuous OSC row', !!box);
    box.checked = true;
    box.fire('change');
    check('ticking it latches the live binding', ps.get('t.a').controller?.latch === true,
      JSON.stringify(ps.get('t.a').controller));
    cm.setMapPage(0);
    cm.setMapPage(1);
    check('THE REPORTED BUG: Latch is still on after page 1 and back',
      ps.get('t.a').controller?.latch === true, JSON.stringify(ps.get('t.a').controller));
    check('and it is on the page itself, which is what a saved file carries',
      ps.get('t.a').midiPages[1]?.latch === true, JSON.stringify(ps.get('t.a').midiPages));
    check('page 1 was not given the page-2 binding', !ps.get('t.a').midiPages[0],
      JSON.stringify(ps.get('t.a').midiPages));
  }
  {
    // A field edited AFTER Latch replaced the controller object must still land.
    const { ps, cm } = rig();
    cm.setPageBinding('t.b', { type: 'midi-cc', cc: 7, channel: 0 });
    const pop = open(ps, cm, 't.b');
    const box = walk(pop, (n) => n.type === 'checkbox')[0];
    box.checked = true;
    box.fire('change');
    // The edit under test must be the LAST one: a later field's commit carries
    // every earlier field along with it, and would hide a setter that forgot.
    typeInto(valueOfRow(pop, 'CC#'), 21);
    cm.setMapPage(2);
    cm.setMapPage(0);
    const c = ps.get('t.b').controller;
    check('a CC# typed in the popover survives a page switch', c?.cc === 21, JSON.stringify(c));
    check('and a Latch ticked before it is not lost to the later edit',
      c?.latch === true, JSON.stringify(c));
  }
  {
    const { ps, cm } = rig();
    cm.setPageBinding('t.b', { type: 'midi-cc', cc: 7, channel: 0 });
    typeInto(valueOfRow(open(ps, cm, 't.b'), 'Chan (0=any)'), 3);
    cm.setMapPage(2);
    cm.setMapPage(0);
    check('a channel typed in the popover survives a page switch',
      ps.get('t.b').controller?.channel === 3, JSON.stringify(ps.get('t.b').controller));
  }
  {
    const { ps, cm } = rig();
    cm.setPageBinding('t.b', { type: 'midi-note', note: 60, channel: 0 });
    typeInto(valueOfRow(open(ps, cm, 't.b'), 'Note#'), 64);
    cm.setMapPage(3);
    cm.setMapPage(0);
    check('a Note# typed in the popover survives a page switch',
      ps.get('t.b').controller?.note === 64, JSON.stringify(ps.get('t.b').controller));
  }
  {
    // Relative is a binding field like Latch, so it goes through the same
    // commit — and a relative stick has no position, so pickup must not arm.
    const { ps, cm } = rig();
    const checkboxes = (pop) => walk(pop, (n) => n.type === 'checkbox');
    const labelOf = (box, pop) =>
      walk(pop, (n) => n.children?.[1] === box)[0]?.children[0]?.textContent;

    cm.setMapPage(1);
    cm.setPageBinding('t.a', { type: 'gamepad-axis-1' });
    const pop = open(ps, cm, 't.a');
    const rel = checkboxes(pop).find((b) => /^Relative/.test(labelOf(b, pop)));
    check('the popover offers Relative on a continuous stick row', !!rel);
    const speed = valueOfRow(pop, 'Full range (s)');
    const speedRow = walk(pop, (n) => n.children?.[1] === speed)[0];
    check('its speed row is hidden until Relative is on', speedRow?.style.display === 'none');
    rel.checked = true;
    rel.fire('change');
    check('and shown once it is', speedRow?.style.display === '');
    typeInto(speed, 4);
    cm.setMapPage(0);
    cm.setMapPage(1);
    const c = ps.get('t.a').controller;
    check('Relative and its speed survive a page switch', c?.relative === true && c?.jogTime === 4,
      JSON.stringify(c));
    check('a relative stick is not armed for soft takeover', !cm._pickup.has('t.a'),
      JSON.stringify([...cm._pickup.keys()]));

    cm.setPageBinding('t.b', { type: 'gamepad-btn-0' });
    const pop2 = open(ps, cm, 't.b');
    check('Relative is not offered on a button',
      !checkboxes(pop2).some((b) => /^Relative/.test(labelOf(b, pop2))));
  }
  {
    // A key binding is not paged: an edit must not smuggle it into one, or it
    // would vanish from every other page.
    const { ps, cm } = rig();
    cm.assign('t.a', { type: 'key', key: 'q' });
    const box = walk(open(ps, cm, 't.a'), (n) => n.type === 'checkbox')[0];
    box.checked = true;
    box.fire('change');
    check('Latch on a key binding still latches', ps.get('t.a').controller?.latch === true);
    check('and does not put the key binding into a page',
      !ps.get('t.a').midiPages?.some(Boolean), JSON.stringify(ps.get('t.a').midiPages));
    cm.setMapPage(1);
    check('so it is still there on another page', ps.get('t.a').controller?.type === 'key',
      JSON.stringify(ps.get('t.a').controller));
  }
}

console.log('\nthe page controls stay unpageable, so the desk cannot be bricked');
{
  const { ps, cm } = rig();
  cm.setPageBinding('midi.pageNext', { type: 'osc', address: '/flic/next' });
  const p = ps.get('midi.pageNext');
  check('an OSC binding on Next Page is not written into a page',
    !p.midiPages?.some(Boolean), JSON.stringify(p.midiPages));
  check('but it IS assigned', p.controller?.address === '/flic/next');
  cm.setMapPage(2);
  check('and it survives every page switch', p.controller?.address === '/flic/next');
}

// ── Source-level: every door leads to the one writer ─────────────────────────
//
// Anchored by POSITION and left open at the end (2026-09-13): these calls will
// grow arguments, and an audit that pinned their arity would go red against
// correct code.
console.log('\nevery learn/assign path goes through setPageBinding');
{
  const osc = readFileSync(new URL('../src/io/OSCBridge.js', import.meta.url), 'utf8');
  check('OSC learn binds through setPageBinding',
    /_ctrl\.setPageBinding\(paramId,\s*cfg/.test(osc));
  check('and no longer through assign()', !/_ctrl\.assign\(paramId/.test(osc));
  // The inverse of the usual shape: the OSC dispatcher must NOT carry a pickup
  // gate. `setMapPage` never arms one, so a gate here could only ever be inert
  // — and an inert gate is how the first version of this looked correct.
  check('the OSC dispatcher carries no pickup gate',
    !/_pickupBlocks/.test(osc) && !/pickupBlocked/.test(osc));
  check('and nothing disarms what was never armed',
    !/clearPickup/.test(osc));

  const ui = readFileSync(new URL('../src/ui/UI.js', import.meta.url), 'utf8');
  check('the controller menu assigns through setPageBinding',
    /this\.ctrl\.setPageBinding\(this\._currentParam\.id,\s*\{\s*type\s*\}/.test(ui));
  check('"None" clears the page too',
    /this\.ctrl\.setPageBinding\(this\._currentParam\.id,\s*null/.test(ui));

  const cmSrc = readFileSync(
    new URL('../src/controls/ControllerManager.js', import.meta.url), 'utf8');
  check('setPageBinding refuses to page a generated controller',
    /isPagedBinding\(cfg\.type\)/.test(cmSrc));
  check('clearAllMIDI nulls entries rather than emptying the array',
    !/p\.midiPages\s*=\s*\[\];[\s\S]{0,200}?clearAllMIDI/.test(cmSrc)
    && /midiPages\[i\]\s*=\s*null/.test(cmSrc));

  const psSrc = readFileSync(
    new URL('../src/controls/ParameterSystem.js', import.meta.url), 'utf8');
  check('the saved-file seed uses the shared predicate',
    /isPagedBinding\(data\.controller\.type\)/.test(psSrc));
}

// ── The mirrored registry is still the real one ──────────────────────────────
console.log('\nthe page params this file mirrors still exist as declared');
{
  const { registerCoreParameters } = await import('../src/controls/ParameterSystem.js');
  const real = new ParameterSystem();
  registerCoreParameters(real);
  check('midi.page is a SELECT', real.get('midi.page')?.type === PARAM_TYPE.SELECT);
  check('midi.pageNext is a TRIGGER',
    real.get('midi.pageNext')?.type === PARAM_TYPE.TRIGGER);
  check('midi.pickup is a TOGGLE',
    real.get('midi.pickup')?.type === PARAM_TYPE.TOGGLE);
  check('midi.pickup defaults ON', real.get('midi.pickup')?.value === 1);
  for (const id of ['midi.page', 'midi.pagePrev', 'midi.pageNext', 'midi.pickup']) {
    check(`${id} is page-exempt`, ControllerManager.PAGE_EXEMPT.has(id));
  }
  // The I/O panel shows these rows together and a label truncates from the END,
  // so two labels sharing a long prefix render identically ("Map Page..." ×2).
  // Four characters is narrower than the label column at any panel width.
  const heads = ['midi.page', 'midi.pagePrev', 'midi.pageNext']
    .map((id) => real.get(id)?.label.slice(0, 4));
  check('the page rows are told apart within their first four characters',
    new Set(heads).size === heads.length, JSON.stringify(heads));
}

console.log(failures
  ? `\n${failures} mapping-page check(s) FAILED\n`
  : '\nAll mapping-page checks passed.\n');
process.exit(failures ? 1 : 0);
