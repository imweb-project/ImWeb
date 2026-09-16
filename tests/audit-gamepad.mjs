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

// ── Gamepad Learn ────────────────────────────────────────────────────────────
// The menu names the standard layout, which means nothing on a pad printed
// 1–10 (the owner's Logitech RumblePad 2) or one the browser does not map as
// standard. Learn asks the pad. Every scenario reads what got BOUND, and the
// last one drives the learned binding, because a bind that names the right
// index and then does nothing is the failure a user would actually meet.
console.log('\ngamepad learn binds what the hand moved, not what the menu calls it');
{
  // A DirectInput pad as a browser may report it: no standard mapping, ten
  // buttons, and a D-pad reported as one HAT axis resting far outside -1..1.
  const HAT_REST = 1.2857;
  const oddPad = () => ({
    id: 'Logitech Cordless RumblePad 2', index: 0, mapping: '',
    axes: [0, 0, 0, 0, 0, 0, 0, 0, 0, HAT_REST],
    buttons: Array.from({ length: 10 }, () => ({ pressed: false, value: 0 })),
  });
  const learnRig = (padFactory = oddPad) => {
    const r = rig();
    pads[0] = r.pad = padFactory();
    let t = 0;
    r.cm._now = () => t;
    r.cm.gamepadLearnWindowMs = 100;
    r.advance = (ms, frames = 1) => {
      for (let i = 0; i < frames; i++) { t += ms / frames; r.cm._tickGamepad(); }
    };
    r.press = (i, down = true) => { r.pad.buttons[i] = { pressed: down, value: down ? 1 : 0 }; };
    r.tick(2);                                   // pad seen; first frame is a reading
    return r;
  };
  const bound = (ps, id) => ps.get(id).controller?.type;

  {
    const { ps, cm, advance, press } = learnRig();
    cm.startGamepadLearn('t.tog');
    advance(16);                                 // baseline
    press(3);
    advance(16);
    check('nothing binds before the window closes', !bound(ps, 't.tog'), bound(ps, 't.tog'));
    press(3, false);
    advance(200, 10);
    check('button "4" on a non-standard pad binds gamepad-btn-3',
      bound(ps, 't.tog') === 'gamepad-btn-3', bound(ps, 't.tog'));
    check('and learn disarms after binding', cm._gpLearn === null);
  }
  {
    const { ps, cm, pad, advance } = learnRig();
    cm.startGamepadLearn('t.cont');
    advance(16);
    pad.axes[0] = 1;                             // full push right
    advance(200, 10);
    check('a full stick push binds that axis', bound(ps, 't.cont') === 'gamepad-axis-0',
      bound(ps, 't.cont'));
  }
  {
    // A diagonal crosses Y first but travels further on X: X was meant.
    const { ps, cm, pad, advance } = learnRig();
    cm.startGamepadLearn('t.cont');
    advance(16);
    pad.axes[1] = 0.6;
    advance(16);
    pad.axes[0] = 1;
    advance(200, 10);
    check('a diagonal binds the axis that went FURTHER, not the one that crossed first',
      bound(ps, 't.cont') === 'gamepad-axis-0', bound(ps, 't.cont'));
  }
  {
    const { ps, cm, pad, advance } = learnRig();
    cm.startGamepadLearn('t.cont');
    advance(16);
    pad.axes[2] = 0.3; pad.axes[3] = -0.35;      // a worn stick at rest
    advance(500, 30);
    check('stick drift under half travel binds nothing', !bound(ps, 't.cont'),
      bound(ps, 't.cont'));
    check('and learn is still armed, waiting for a real move', cm._gpLearn !== null);
  }
  {
    const { ps, cm, pad, advance } = learnRig();
    cm.startGamepadLearn('t.tog');
    advance(16);
    pad.axes[9] = -1;                            // D-pad up on the hat
    advance(200, 10);
    check('a D-pad reported as a hat axis binds that axis',
      bound(ps, 't.tog') === 'gamepad-axis-9', bound(ps, 't.tog'));
  }
  {
    const { ps, cm, advance, press } = learnRig();
    press(5);                                    // already held when learn arms
    advance(16);
    cm.startGamepadLearn('t.tog');
    advance(200, 10);
    check('a button held when learn arms does not bind', !bound(ps, 't.tog'),
      bound(ps, 't.tog'));
    press(5, false); advance(16);
    press(5); advance(200, 10);
    check('pressing it again does', bound(ps, 't.tog') === 'gamepad-btn-5',
      bound(ps, 't.tog'));
  }
  {
    const { ps, cm, advance, press } = learnRig();
    ps.get('t.tog2').controller = { type: 'gamepad-btn-0' };
    cm.startGamepadLearn('t.tog');
    advance(16);
    press(0); advance(16);
    check('a control already mapped still works while learn is armed',
      ps.get('t.tog2').value === 1, String(ps.get('t.tog2').value));
  }
  {
    const { ps, cm, advance, press } = learnRig();
    cm._mapPage = 1;                             // learning on page 2
    cm.startGamepadLearn('t.tog');
    advance(16);
    press(2); advance(16); press(2, false);
    advance(200, 10);
    const pages = ps.get('t.tog').midiPages ?? [];
    check('learn lands in the CURRENT page', pages[1]?.type === 'gamepad-btn-2',
      JSON.stringify(pages));
    check('and not in page 1', !pages[0], JSON.stringify(pages));
  }
  {
    // End to end: the learned button must then actually drive the row.
    const { ps, cm, advance, press } = learnRig();
    cm.startGamepadLearn('t.tog');
    advance(16);
    press(7); advance(16); press(7, false);
    advance(200, 10);
    const before = ps.get('t.tog').value;
    press(7); advance(16);
    check('the learned button then toggles the row', ps.get('t.tog').value !== before,
      `${before} -> ${ps.get('t.tog').value}`);
  }
  {
    const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
    const ui = readFileSync(new URL('../src/ui/UI.js', import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    check('the row menu offers Gamepad Learn', /data-action="gamepad-learn"/.test(html));
    check('and the menu action arms it',
      /action === 'gamepad-learn'[\s\S]{0,200}?startGamepadLearn/.test(ui));
    check('the status bar has the PAD chip learn lights up', /id="status-pad"/.test(html));
  }
}

// ── PAD IN ───────────────────────────────────────────────────────────────────
// The monitor exists to answer "what is this control called?" before mapping,
// so the name it shows must be the name the badge shows afterwards — asserted
// by binding each reported control and reading the badge back, not by
// comparing two copies of a name table.
console.log('\nPAD IN names each control exactly as its badge will');
{
  const { ps, cm, pad, tick } = rig();
  tick(2);                                       // first frame is a reading
  check('the first reading reports nothing', cm.padLog.length === 0,
    JSON.stringify(cm.padLog));

  pad.buttons[12] = { pressed: true, value: 1 };   // D-pad up
  tick();
  let e = cm.padLog[0];
  check('a press is reported, newest first', e?.type === 'gamepad-btn-12' && e.val === 'on',
    JSON.stringify(e));
  const p = ps.get('t.tog');
  p.controller = { type: e.type };
  check('its name is the badge the row shows once mapped', e.name === p.controllerLabel,
    `${e.name} vs ${p.controllerLabel}`);
  check('and the bound column names that row', cm.padBindingsFor(e.type).includes('T'),
    JSON.stringify(cm.padBindingsFor(e.type)));

  pad.buttons[12] = { pressed: false, value: 0 };
  tick();
  check('the release updates the SAME row', cm.padLog.length === 1 && cm.padLog[0].val === 'off'
    && cm.padLog[0].count === 2, JSON.stringify(cm.padLog));

  pad.axes[0] = 0.8;
  tick();
  e = cm.padLog[0];
  const q = ps.get('t.cont');
  q.controller = { type: e?.type };
  check('a stick move is reported under the badge name too',
    e?.type === 'gamepad-axis-0' && e.name === q.controllerLabel, JSON.stringify(e));
  check('consumePadDirty is true once, then false', cm.consumePadDirty() && !cm.consumePadDirty());
}
{
  // The owner's RumblePad 2 rests at 0.18 on a stick axis, past the deadzone,
  // and a real stick jitters by a few 1/1024 steps. Neither is movement.
  const { cm, pad, tick } = rig();
  pad.axes = [0.18, 0.5, 0.08, 0.46];
  tick(2);
  for (let i = 0; i < 20; i++) {
    pad.axes[0] = 0.18 + ((i % 3) - 1) * 0.004;
    tick();
  }
  check('a stick resting off-centre with jitter reports nothing', cm.padLog.length === 0,
    JSON.stringify(cm.padLog));
  for (let i = 1; i <= 10; i++) { pad.axes[0] = 0.18 + i * 0.03; tick(); }
  check('a slow sweep still reports, as one coalesced row',
    cm.padLog.length === 1 && cm.padLog[0].count > 1, JSON.stringify(cm.padLog));
}
{
  const { cm, pad, tick } = rig();
  tick(2);
  pad.buttons[7] = { pressed: true, value: 0.4 };  // RT half pulled
  tick();
  check('an analog trigger reports its travel', cm.padLog[0]?.val === '0.40',
    JSON.stringify(cm.padLog[0]));
}
{
  const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  check('the render loop paints PAD IN', /_paintMidiMonitor\(\);\s*_paintPadMonitor\(\);/.test(main));
  check('PAD IN takes its names from the monitor entry, not a table of its own',
    /midi-mon-id">\$\{e\.name\}/.test(main) && !/'LX',\s*'LY'/.test(main));
}

// ── Relative sticks ──────────────────────────────────────────────────────────
// A stick springs back, so as a position it holds a value only while held.
// Relative, deflection is a speed and letting go leaves the value where it got
// to. Every check reads the VALUE after the frames a performer would spend.
console.log('\na relative stick pushes the value and lets go of it');
{
  const FRAME = 1 / 60;
  const jogRig = (extra = {}) => {
    const r = rig();
    r.ps.register({ id: 't.int', label: 'I', group: 'g', min: 1, max: 200, value: 1, step: 1 });
    r.run = (secs) => { for (let i = 0; i < Math.round(secs * 60); i++) r.cm._tickGamepad(FRAME); };
    r.bind = (id, axis, cfg = {}) => {
      r.ps.get(id).controller = { type: `gamepad-axis-${axis}`, relative: true, ...cfg, ...extra };
    };
    r.tick(2);
    return r;
  };
  const near = (a, b, tol) => Math.abs(a - b) <= tol;

  {
    const { ps, pad, run, bind } = jogRig();
    bind('t.cont', 0);
    pad.axes[0] = 1;                             // full push right, held still
    run(1);
    const held = ps.get('t.cont').value;
    check('a stick held still at full push keeps moving the value (half range in 1 s at 2 s)',
      near(held, 50, 3), held.toFixed(2));
    pad.axes[0] = 0;
    run(1);
    check('THE FEATURE: letting go leaves the value where it got to',
      ps.get('t.cont').value === held, `${held} -> ${ps.get('t.cont').value}`);
  }
  {
    const { ps, pad, run, bind, writes } = jogRig();
    bind('t.cont', 0);
    pad.axes[0] = 0.18;                          // the owner's LX at rest
    const before = writes();
    run(2);
    check('a stick resting slightly off-centre does not creep', writes() === before
      && ps.get('t.cont').value === 0, `${writes() - before} writes, value ${ps.get('t.cont').value}`);
  }
  {
    const { ps, pad, run, bind } = jogRig();
    ps.get('t.cont').value = 50;
    bind('t.cont', 1);
    pad.axes[1] = -1;                            // standard Y: up reads LOW
    run(0.5);
    const up = ps.get('t.cont').value;
    check('pushing UP raises the value', up > 50, up.toFixed(2));
    pad.axes[1] = 1;
    run(0.5);
    check('pushing down lowers it', ps.get('t.cont').value < up, ps.get('t.cont').value.toFixed(2));
  }
  {
    // Integer-stepped row: at a gentle push each frame adds under one unit, and
    // `_modStep` would round a read-back value straight back to where it was.
    const { ps, pad, run, bind } = jogRig();
    bind('t.int', 0);
    pad.axes[0] = 0.45;                          // a gentle push
    run(2);
    const v = ps.get('t.int').value;
    check('a gentle push still moves an integer-stepped row', v > 10, String(v));
    check('and it lands on whole numbers', Number.isInteger(v), String(v));
  }
  {
    const { ps, pad, run, bind } = jogRig();
    bind('t.cont', 0);
    pad.axes[0] = 1;
    run(4);                                      // well past the end
    check('it stops at max', ps.get('t.cont').value === 100, String(ps.get('t.cont').value));
    pad.axes[0] = -1;
    run(0.1);
    check('and the first pull back moves it straight away — no wind-up past max',
      ps.get('t.cont').value < 100, String(ps.get('t.cont').value));
  }
  {
    const { ps, pad, run, bind } = jogRig();
    bind('t.cont', 0);
    pad.axes[0] = 1;
    run(0.5);
    pad.axes[0] = 0;
    run(0.1);
    ps.get('t.cont').value = 80;                 // a recall or a mouse drag
    pad.axes[0] = 1;
    run(0.1);
    check('after something else moves the value, the jog continues from THERE',
      ps.get('t.cont').value > 80, String(ps.get('t.cont').value));
  }
  {
    const { ps, pad, run, bind } = jogRig();
    ps.get('t.cont').ctrlMin = 20;
    ps.get('t.cont').ctrlMax = 40;
    ps.get('t.cont').value = 30;
    bind('t.cont', 0, { jogTime: 1 });
    pad.axes[0] = 1;
    run(0.25);
    const v = ps.get('t.cont').value;
    check('speed is relative to the row\'s min/max fields (quarter of 20..40 in 0.25 s at 1 s)',
      near(v, 35, 1), v.toFixed(2));
    run(2);
    check('and the row\'s max field is the ceiling', ps.get('t.cont').value === 40,
      String(ps.get('t.cont').value));
  }
  {
    const { ps, pad, run, bind } = jogRig();
    ps.get('t.cont').value = 50;
    ps.get('t.cont').invert = true;
    bind('t.cont', 0);
    pad.axes[0] = 1;
    run(0.5);
    check('invert reverses the direction', ps.get('t.cont').value < 50,
      String(ps.get('t.cont').value));
  }
  {
    // Slew must not slow a jog down: the jog reads where the value is HEADED.
    const { ps, pad, run, bind } = jogRig();
    ps.get('t.cont').slew = 0.5;
    bind('t.cont', 0);
    pad.axes[0] = 1;
    for (let i = 0; i < 60; i++) { ps.get('t.cont').tickSlew(FRAME); run(FRAME); }
    const target = ps.get('t.cont')._target;
    check('slew on the row does not slow the jog down', near(target, 50, 3), target.toFixed(2));
  }
  {
    const { ps, pad, run } = jogRig();
    ps.get('t.cont').controller = { type: 'gamepad-axis-0' };   // NOT relative
    pad.axes[0] = 1;
    run(0.2);
    pad.axes[0] = 0;
    run(0.2);
    check('without Relative a stick is still a position — it springs back',
      near(ps.get('t.cont').value, 50, 1), String(ps.get('t.cont').value));
  }
  {
    const { ps } = jogRig();
    const p = ps.get('t.cont');
    p.controller = { type: 'gamepad-axis-1', relative: true };
    check('the badge marks a relative stick', p.controllerLabel === 'G:LY ↕', p.controllerLabel);
    p.controller = { type: 'gamepad-btn-0', relative: true };
    check('but not a button, where the flag means nothing', p.controllerLabel === 'G:A',
      p.controllerLabel);
  }
}

console.log(failures ? `\n${failures} failure(s)` : '\nall gamepad checks pass');
process.exit(failures ? 1 : 0);
