/**
 * Every physical input obeys the same button rule.
 *
 * `audit-midi-buttons.mjs` pins the rule for MIDI CC and says why it is not
 * enough on its own:
 *
 *   "the next input path can be added with the same hole and no test will
 *    notice. These assertions are about the RULE, not about one controller."
 *
 * That prediction came true twice. MIDI CC shipped without the rule (#83) and
 * a learned OSC address shipped without it months later, each found by the
 * owner and fixed alone, because five copies of "press acts, release does not"
 * existed and nothing compared them.
 *
 * So this drives EVERY input — MIDI CC, MIDI note, the computer keyboard, the
 * gamepad, and a learned OSC address — through one scenario table and demands
 * the same answers. A new input path is added to `PATHS` and either agrees or
 * fails here. Behavioural throughout: it runs the real handlers rather than
 * matching source text.
 *
 * Run:  node tests/audit-control-input.mjs
 */

import { ParameterSystem, PARAM_TYPE } from '../src/controls/ParameterSystem.js';

// ── Environment stubs ───────────────────────────────────────────────────────
const winListeners = {};
const pads = [null];
globalThis.navigator ??= {};
globalThis.navigator.getGamepads = () => pads;
globalThis.document ??= {
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener: () => {},
};
globalThis.window ??= {};
globalThis.window.addEventListener = (type, fn) => { (winListeners[type] ??= []).push(fn); };
const sockets = [];
class FakeWS {
  static OPEN = 1;
  constructor(url) { this.url = url; this.readyState = FakeWS.OPEN; this.sent = []; sockets.push(this); }
  send(s) { this.sent.push(JSON.parse(s)); }
  close() { this.readyState = 3; }
}
globalThis.WebSocket = FakeWS;
globalThis.localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };

const { ControllerManager } = await import('../src/controls/ControllerManager.js');
const { OSCBridge } = await import('../src/io/OSCBridge.js');

let failures = 0;
const check = (label, cond, detail = '') => {
  if (cond) console.log(`  ok   ${label}`);
  else { console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); failures++; }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

function rig() {
  const ps = new ParameterSystem();
  ps.register({ id: 't.tog',  label: 'T', group: 'g', type: PARAM_TYPE.TOGGLE, value: 0 });
  ps.register({ id: 't.trig', label: 'R', group: 'g', type: PARAM_TYPE.TRIGGER });
  ps.register({ id: 't.cont', label: 'C', group: 'g', min: 0, max: 100, value: 0 });
  const cm = new ControllerManager(ps);
  return { ps, cm };
}

/**
 * Each entry binds a parameter to its own hardware and exposes the same three
 * verbs. `press`/`release` are the leading and trailing edge of a button;
 * `value` is a fader position 0..1.
 */
const PATHS = [
  {
    name: 'MIDI CC',
    make({ cm, ps }) {
      const input = {};
      cm._attachMIDIInput(input);
      const cc = (v) => input.onmidimessage({ data: [0xB0, 20, v] });
      return {
        bind: (id) => { ps.get(id).controller = { type: 'midi-cc', cc: 20, channel: 1 }; },
        press: () => cc(127), release: () => cc(0), value: (v) => cc(Math.round(v * 127)),
      };
    },
  },
  {
    name: 'MIDI note',
    make({ cm, ps }) {
      const input = {};
      cm._attachMIDIInput(input);
      const note = (st, vel) => input.onmidimessage({ data: [st, 60, vel] });
      return {
        bind: (id) => { ps.get(id).controller = { type: 'midi-note', note: 60, channel: 1 }; },
        press: () => note(0x90, 127), release: () => note(0x90, 0),
        value: (v) => note(0x90, Math.max(1, Math.round(v * 127))),
      };
    },
  },
  {
    name: 'keyboard',
    make({ ps }) {
      const fire = (type, key) => (winListeners[type] ?? []).forEach(fn => fn({ key, getModifierState: () => false }));
      return {
        bind: (id) => { ps.get(id).controller = { type: 'key', key: 'q' }; },
        press: () => fire('keydown', 'q'), release: () => fire('keyup', 'q'),
        value: null, // a key has no position — scenarios needing one are skipped
      };
    },
  },
  {
    name: 'gamepad',
    make({ cm, ps }) {
      const pad = {
        id: 'fake', index: 0, mapping: 'standard',
        axes: [0, 0, 0, 0],
        buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })),
      };
      pads[0] = pad;
      cm._tickGamepad();                       // first frame is a reading
      const set = (pressed, value) => { pad.buttons[0] = { pressed, value }; cm._tickGamepad(); };
      return {
        bind: (id) => { ps.get(id).controller = { type: 'gamepad-btn-0' }; },
        press: () => set(true, 1), release: () => set(false, 0),
        value: (v) => set(v > 0.5, v),
      };
    },
  },
  {
    name: 'OSC (learned)',
    make({ ps }) {
      const bridge = new OSCBridge(ps, { loadPreset() {} });
      bridge.connect('ws://relay');
      const ws = sockets.at(-1);
      ws.onopen?.();
      const msg = (args) => ws.onmessage({ data: JSON.stringify({ address: '/pad/1', args }) });
      return {
        bind: (id) => { ps.get(id).controller = { type: 'osc', address: '/pad/1' }; },
        press: () => msg([1]), release: () => msg([0]), value: (v) => msg([v]),
        cleanup: () => bridge.disconnect(),
      };
    },
  },
];

check('every input path is represented', PATHS.length === 5, `${PATHS.length} paths`);

console.log('\na TOGGLE latches: press acts, release does not');
for (const path of PATHS) {
  const r = rig();
  const drv = path.make(r);
  drv.bind('t.tog');
  const p = r.ps.get('t.tog');

  drv.press();
  check(`${path.name}: press turns it on`, p.value === 1, String(p.value));
  drv.release();
  check(`${path.name}: RELEASE LEAVES IT ON`, p.value === 1,
    `${p.value} — it only runs while held`);
  drv.press();
  check(`${path.name}: the next press turns it off`, p.value === 0, String(p.value));
  drv.release();
  check(`${path.name}: and its release leaves it off`, p.value === 0, String(p.value));
  drv.cleanup?.();
}

console.log('\na TRIGGER fires once per press');
for (const path of PATHS) {
  const r = rig();
  const drv = path.make(r);
  drv.bind('t.trig');
  const p = r.ps.get('t.trig');
  let fires = 0;
  p.onChange(() => fires++);

  drv.press();
  check(`${path.name}: press fires once`, fires === 1, `${fires} fires`);
  drv.release();
  check(`${path.name}: RELEASE DOES NOT FIRE AGAIN`, fires === 1, `${fires} fires — the second bang`);
  drv.press();
  check(`${path.name}: the next press fires again`, fires === 2, `${fires} fires`);
  drv.cleanup?.();
}

console.log('\na CONTINUOUS param follows the value, edge-gated by nothing');
for (const path of PATHS) {
  const r = rig();
  const drv = path.make(r);
  // `value` lives on the DRIVER, not on the factory entry. Gating on
  // `path.value` skipped every path — five silent skips reading as coverage,
  // which is the vacuous-check failure audit-audit-hygiene exists to catch.
  if (!drv.value) { console.log(`  --   ${path.name}: no position to send, skipped`); continue; }
  drv.bind('t.cont');
  const p = r.ps.get('t.cont');

  drv.value(1);
  check(`${path.name}: full scale reaches max`, Math.abs(p.value - 100) < 1.5, String(p.value));
  drv.value(0.5);
  check(`${path.name}: a mid value is followed, not edge-gated`,
    Math.abs(p.value - 50) < 1.5, String(p.value));
  drv.cleanup?.();
}

console.log('\nthe keyboard holds its own shape: 1 while held, 0 on release');
{
  const r = rig();
  const drv = PATHS.find(p => p.name === 'keyboard').make(r);
  drv.bind('t.cont');
  const p = r.ps.get('t.cont');
  drv.press();
  check('keydown drives a continuous param to full', p.value === 100, String(p.value));
  drv.release();
  check('keyup returns it to zero', p.value === 0, String(p.value));
}

console.log(failures ? `\n${failures} failure(s)` : '\nevery input agrees on the rule');
process.exit(failures ? 1 : 0);
