/**
 * Gamepad — a stick at rest is not a message, and a button is not a fader.
 *
 * The bug this was written for: `_tickGamepad` runs every frame and wrote
 * EVERY bound parameter from the pad's current state whether or not anything
 * had moved. A MIDI knob speaks only when turned; a polled pad has to be taught
 * the same manners. Without that, a parameter bound to a resting stick was
 * pinned at 0.5 — a state recall, a slider drag or a controller write was
 * overwritten within one frame, and the binding fired its write path sixty
 * times a second for a pad lying on the desk.
 *
 * Also asserted, because they failed the same way silently:
 *  - a centred stick is never exactly 0, so without a deadzone "at rest" jitters;
 *  - the button edge was stored INSIDE the per-parameter loop, so the second
 *    parameter bound to one button saw the edge already consumed and never
 *    fired — the sibling rule to audit-midi-buttons ("every param above saw
 *    the same edge");
 *  - the menu offered 4 of the standard mapping's buttons and no triggers or
 *    d-pad, and every gamepad badge read "GAME".
 *
 * Run:  node tests/audit-gamepad.mjs
 */

import { readFileSync } from 'node:fs';
import { ParameterSystem, PARAM_TYPE } from '../src/controls/ParameterSystem.js';

// One fake pad, mutated between ticks. `pads[0] = null` models a disconnect.
const pads = [null];
const winListeners = {};
globalThis.navigator ??= {};
globalThis.navigator.getGamepads = () => pads;
globalThis.document ??= {
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener: () => {},
};
globalThis.window ??= {};
globalThis.window.addEventListener = (type, fn) => {
  (winListeners[type] ??= []).push(fn);
};

const { ControllerManager } = await import('../src/controls/ControllerManager.js');

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

function rig() {
  const ps = new ParameterSystem();
  ps.register({ id: 't.tog',   label: 'T',  group: 'g', type: PARAM_TYPE.TOGGLE, value: 0 });
  ps.register({ id: 't.tog2',  label: 'T2', group: 'g', type: PARAM_TYPE.TOGGLE, value: 0 });
  ps.register({ id: 't.trig',  label: 'R',  group: 'g', type: PARAM_TYPE.TRIGGER });
  ps.register({ id: 't.cont',  label: 'C',  group: 'g', min: 0, max: 100, value: 0 });
  const cm = new ControllerManager(ps);
  const pad = newPad();
  pads[0] = pad;
  // Count WRITES, not value changes: a write of the value already held is the
  // exact thing that pins a parameter against every other writer.
  const p = ps.get('t.cont');
  let writes = 0;
  const orig = p.setNormalized.bind(p);
  p.setNormalized = (n) => { writes++; return orig(n); };
  const tick = (n = 1) => { for (let i = 0; i < n; i++) cm._tickGamepad(); };
  return { ps, cm, pad, p, tick, writes: () => writes };
}

console.log('\na stick at rest does not write, so other writers are not pinned');
{
  const { p, pad, tick, writes } = rig();
  p.controller = { type: 'gamepad-axis-0' };
  tick(3);                       // pad appears, stick centred
  p.value = 30;                  // a slider drag or a state recall
  tick(30);
  check('a recalled value SURVIVES a resting stick', p.value === 30,
    `${p.value} — the resting stick overwrote it`);
  check('no writes at all while the stick rests', writes() === 0, `${writes()} writes`);

  pad.axes[0] = 0.04;            // real centring error
  tick(10);
  check('drift inside the deadzone is still rest', p.value === 30 && writes() === 0,
    `${p.value}, ${writes()} writes`);
}

console.log('\na moving stick writes, once per change');
{
  const { p, pad, tick, writes } = rig();
  p.controller = { type: 'gamepad-axis-0' };
  tick();
  pad.axes[0] = 1;  tick();
  check('full right reaches max', Math.abs(p.value - 100) < 1e-6, String(p.value));
  pad.axes[0] = -1; tick();
  check('full left reaches min', Math.abs(p.value) < 1e-6, String(p.value));
  const before = writes();
  tick(30);
  check('a HELD deflection writes nothing further', writes() === before,
    `${writes() - before} extra writes over 30 frames`);
  // A SWEEP, not one point: a single reading near the deadzone edge cannot tell
  // a rescale from none once quantisation rounds it (mutation calibration found
  // 0.2 → 59.96 slipping under a "< 60" bound). The largest step between
  // neighbouring positions can: a rescaled stick moves ~0.6 per 0.01, while a
  // dead band that is not rescaled jumps by half its width at the edge.
  let prevV = null, maxJump = 0;
  for (let i = 0; i <= 100; i++) {
    pad.axes[0] = i / 100; tick();
    if (prevV !== null) maxJump = Math.max(maxJump, Math.abs(p.value - prevV));
    prevV = p.value;
  }
  check('leaving the deadzone is continuous from centre, not a jump', maxJump < 1.5,
    `largest step ${maxJump.toFixed(2)} per 0.01 of travel`);
  pad.axes[0] = 0; tick();
  check('returning to centre lands exactly on centre', Math.abs(p.value - 50) < 1e-6,
    String(p.value));
}

console.log('\nbuttons: press acts, hold and release do not');
{
  const { ps, pad, tick } = rig();
  const t = ps.get('t.tog');
  t.controller = { type: 'gamepad-btn-0' };
  tick();
  pad.buttons[0] = { pressed: true, value: 1 };  tick();
  check('press turns the toggle on', t.value === 1, String(t.value));
  tick(10);
  check('holding does not flip it again', t.value === 1, String(t.value));
  pad.buttons[0] = { pressed: false, value: 0 }; tick();
  check('release leaves it on', t.value === 1, String(t.value));

  const r = ps.get('t.trig');
  r.controller = { type: 'gamepad-btn-1' };
  let fires = 0;
  r.onChange(() => fires++);
  pad.buttons[1] = { pressed: true, value: 1 };  tick(5);
  pad.buttons[1] = { pressed: false, value: 0 }; tick(5);
  check('a trigger fires once per press', fires === 1, `${fires} fires`);
}

console.log('\ntwo parameters on ONE button both see the press');
{
  const { ps, pad, tick } = rig();
  const a = ps.get('t.tog'), b = ps.get('t.tog2');
  a.controller = { type: 'gamepad-btn-2' };
  b.controller = { type: 'gamepad-btn-2' };
  tick();
  pad.buttons[2] = { pressed: true, value: 1 }; tick();
  check('the first bound toggle flips', a.value === 1, String(a.value));
  check('THE SECOND bound toggle flips too', b.value === 1,
    `${b.value} — the first consumed the edge`);
}

console.log('\nan analog trigger on a continuous param');
{
  const { p, pad, tick, writes } = rig();
  p.controller = { type: 'gamepad-btn-7' };
  tick(5);
  check('an untouched trigger does not write', writes() === 0, `${writes()} writes`);
  pad.buttons[7] = { pressed: true, value: 0.5 }; tick();
  check('half pull reaches mid', Math.abs(p.value - 50) < 1e-6, String(p.value));
  const before = writes();
  tick(20);
  check('a held pull writes nothing further', writes() === before,
    `${writes() - before} extra writes`);
  pad.buttons[7] = { pressed: false, value: 0 }; tick();
  check('release returns to min', Math.abs(p.value) < 1e-6, String(p.value));
}

// Two reset paths, tested APART: firing both in one case let each hide the
// other's removal (mutation calibration). In each, the stick and button CHANGE
// across the gap, so a stale reading would register a move and a press.
for (const [how, gap] of [
  ['a poll that finds no pad', (pad, tick, _cm) => { pads[0] = null; tick(); }],
  ['the disconnect event alone', (pad, _tick, cm) => {
    // Unplugged and replugged between two polls: getGamepads never shows null.
    for (const fn of winListeners.gamepaddisconnected ?? []) fn({ gamepad: pad });
  }],
]) {
  console.log(`\na reconnected pad starts clean — via ${how}`);
  const { ps, cm, p, pad, tick, writes } = rig();
  // rig() registers a listener per manager; keep only this one's.
  winListeners.gamepaddisconnected = winListeners.gamepaddisconnected.slice(-1);
  const t = ps.get('t.tog');
  t.controller = { type: 'gamepad-btn-0' };
  p.controller = { type: 'gamepad-axis-0' };
  pad.axes[0] = 0.8;
  tick(2);
  gap(pad, tick, cm);
  p.value = 30;
  const before = writes();
  pad.axes[0] = 0.3;                              // held somewhere new
  pad.buttons[0] = { pressed: true, value: 1 };   // held while plugging in
  pads[0] = pad; tick();
  check('a stick held across the reconnect does not jump the param',
    p.value === 30, `${p.value}, ${writes() - before} writes`);
  check('a button held across the reconnect does not fire', t.value === 0,
    String(t.value));
}

console.log('\nthe menu and the badge cover the standard mapping');
{
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const offered = new Set([...html.matchAll(/data-ctrl="(gamepad-(?:axis|btn)-\d+)"/g)].map(m => m[1]));
  const wanted = [
    ...Array.from({ length: 4 },  (_, i) => `gamepad-axis-${i}`),
    ...Array.from({ length: 16 }, (_, i) => `gamepad-btn-${i}`),
  ];
  const missing = wanted.filter(t => !offered.has(t));
  check('every standard stick axis and button 0–15 is assignable', missing.length === 0,
    `missing: ${missing.join(', ')}`);

  const ps = new ParameterSystem();
  ps.register({ id: 't.x', label: 'X', group: 'g', min: 0, max: 1, value: 0 });
  const p = ps.get('t.x');
  const labels = wanted.map(type => { p.controller = { type }; return p.controllerLabel; });
  check('every one of them has a DISTINCT badge', new Set(labels).size === wanted.length,
    labels.join(' '));
}

console.log(failures ? `\n${failures} failure(s)` : '\nall gamepad checks pass');
process.exit(failures ? 1 : 0);
