/**
 * OSC bridge — a button is not a fader, and feedback reaches the remote.
 *
 * Two bugs this was written for, both silent:
 *
 *  - **A plain button could turn a toggle on but never off.** `/imweb/<id>` is
 *    ABSOLUTE (>0.5 on, else off), which is right for a TouchOSC toggle widget
 *    that sends the state it shows — and useless for a Flic, which sends the
 *    same "pressed" every time. There was no address that flips. And a
 *    momentary button's RELEASE (0) fired a trigger a second time, the exact
 *    "bangs again when released" that audit-midi-buttons pins for MIDI CC.
 *
 *  - **Feedback was documented and never sent.** `sendParam` existed, the
 *    header said every change is broadcast, the relay logged "ImWeb also SENDS"
 *    — and nothing called it. A TouchOSC layout never moved when a state was
 *    recalled.
 *
 * Feedback rules asserted here: batched (one message per param per flush,
 * carrying the latest value), never echoed straight back to the remote that
 * just set it, nothing for triggers, nothing while disconnected, and params
 * registered after the bridge was built are still watched.
 *
 * Run:  node tests/audit-osc.mjs
 */

import { ParameterSystem, PARAM_TYPE } from '../src/controls/ParameterSystem.js';

const sockets = [];
class FakeWS {
  static OPEN = 1;
  constructor(url) { this.url = url; this.readyState = 0; this.sent = []; sockets.push(this); }
  send(s) { this.sent.push(JSON.parse(s)); }
  close() { this.readyState = 3; }
}
globalThis.WebSocket = FakeWS;
globalThis.document ??= { getElementById: () => null };
const store = new Map();
globalThis.localStorage ??= {
  getItem: k => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: k => store.delete(k),
};

const { OSCBridge } = await import('../src/io/OSCBridge.js');

let failures = 0;
const check = (label, cond, detail = '') => {
  if (cond) console.log(`  ok   ${label}`);
  else { console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); failures++; }
};

function rig() {
  const ps = new ParameterSystem();
  ps.register({ id: 't.tog',  label: 'T', group: 'g', type: PARAM_TYPE.TOGGLE, value: 0 });
  ps.register({ id: 't.trig', label: 'R', group: 'g', type: PARAM_TYPE.TRIGGER });
  ps.register({ id: 't.cont', label: 'C', group: 'g', min: 0, max: 100, value: 0 });
  const bridge = new OSCBridge(ps, { loadPreset() {} });
  bridge.connect('ws://relay');
  const ws = sockets.at(-1);
  ws.readyState = FakeWS.OPEN;
  ws.onopen?.();
  const msg = (address, args = []) => ws.onmessage({ data: JSON.stringify({ address, args }) });
  // Optional call: on a bridge with no batching this must FAIL an assertion,
  // not throw before reaching one.
  const flush = () => { const before = ws.sent.length; bridge._flush?.(); return ws.sent.slice(before); };
  const fires = (p) => { let n = 0; p.onChange(() => n++); return () => n; };
  return { ps, bridge, ws, msg, flush, fires };
}

console.log('\n/imweb/toggle/<id> flips on the press, ignores the release');
{
  const { ps, msg } = rig();
  const t = ps.get('t.tog');
  msg('/imweb/toggle/t.tog', [1]);
  check('press turns it on', t.value === 1, String(t.value));
  msg('/imweb/toggle/t.tog', [0]);
  check('RELEASE LEAVES IT ON', t.value === 1, String(t.value));
  msg('/imweb/toggle/t.tog', [1]);
  check('a second press turns it OFF — what a Flic could never do', t.value === 0, String(t.value));
  msg('/imweb/toggle/t.tog', []);
  check('a bare message (no argument) is a press', t.value === 1, String(t.value));
}

console.log('\n/imweb/<id> on a toggle stays absolute, for widgets that send their state');
{
  const { ps, msg } = rig();
  const t = ps.get('t.tog');
  msg('/imweb/t.tog', [1]);
  check('1 sets it on', t.value === 1, String(t.value));
  msg('/imweb/t.tog', [1]);
  check('1 again leaves it on', t.value === 1, String(t.value));
  msg('/imweb/t.tog', [0]);
  check('0 sets it off', t.value === 0, String(t.value));
}

console.log('\na trigger fires once per press, on either address');
{
  const { ps, msg, fires } = rig();
  const n = fires(ps.get('t.trig'));
  msg('/imweb/t.trig', [1]);
  msg('/imweb/t.trig', [0]);
  check('/imweb/<id>: press fires, release does not', n() === 1, `${n()} fires`);
  msg('/imweb/trigger/t.trig', [1]);
  msg('/imweb/trigger/t.trig', [0]);
  check('/imweb/trigger/<id>: press fires, release does not', n() === 2, `${n()} fires`);
  msg('/imweb/trigger/t.trig', []);
  check('a bare message still fires', n() === 3, `${n()} fires`);
}

console.log('\na continuous param still follows the value');
{
  const { ps, msg } = rig();
  msg('/imweb/t.cont', [0.25]);
  check('0.25 lands at 25', Math.abs(ps.get('t.cont').value - 25) < 1e-9, String(ps.get('t.cont').value));
}

console.log('\nfeedback: a change made in ImWeb reaches the remote');
{
  const { ps, flush } = rig();
  ps.set('t.cont', 70);
  const out = flush();
  const m = out.find(o => o.address === '/imweb/t.cont');
  check('a UI change is sent as /imweb/<id> <normalised>', m && Math.abs(m.args[0] - 0.7) < 1e-9,
    JSON.stringify(out));
  check('and nothing is sent again while it stays put', flush().length === 0, 'resent an unchanged value');

  ps.set('t.cont', 10); ps.set('t.cont', 20); ps.set('t.cont', 30);
  const burst = flush().filter(o => o.address === '/imweb/t.cont');
  check('three changes in one batch send ONE message', burst.length === 1, `${burst.length} messages`);
  check('carrying the latest value', Math.abs(burst[0]?.args[0] - 0.3) < 1e-9, JSON.stringify(burst));

  ps.set('t.cont', 80); ps.set('t.cont', 30);
  check('a change and back within one batch sends nothing — the remote already shows it',
    !flush().some(o => o.address === '/imweb/t.cont'), 'resent the value the remote shows');

  ps.set('t.tog', 1);
  const tog = flush().find(o => o.address === '/imweb/t.tog');
  check('a toggle is sent as 1', tog?.args[0] === 1, JSON.stringify(tog));

  ps.get('t.trig').trigger();
  check('a trigger is NOT sent — it has no state to show', flush().length === 0, 'sent a trigger');
}

console.log('\nfeedback is not echoed to the remote that set the value');
{
  const { ps, msg, flush } = rig();
  msg('/imweb/t.cont', [0.4]);
  check('an incoming value is not sent straight back', flush().length === 0, 'echoed');
  ps.set('t.cont', 90);
  const m = flush().find(o => o.address === '/imweb/t.cont');
  check('but a LATER local change to the same param is', Math.abs(m?.args[0] - 0.9) < 1e-9,
    JSON.stringify(m));
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
/** Arm with a window short enough to test, and wait for it to close. */
const arm = (bridge, id) => { bridge.learnWindowMs = 30; bridge.startLearn(id); };
const settled = () => sleep(80);

console.log('\nOSC learn binds the control that MOVED, not the first to speak');
{
  const { ps, bridge, msg } = rig();
  const p = ps.get('t.cont');
  arm(bridge, 't.cont');
  check('arming reports as learning', bridge.learning === true);

  // A rig is rarely quiet: an accelerometer or a Max patch streams the whole
  // time. First-address-wins would bind THIS, which is the bug this rule exists
  // for — it arrives first and keeps arriving.
  for (let i = 0; i < 40; i++) msg('/accel/x', [0.50 + (i % 2) * 0.01]);
  msg('/flic/1', [1]);                      // the button actually pressed
  for (let i = 0; i < 40; i++) msg('/accel/x', [0.50 + (i % 2) * 0.01]);
  await settled();

  check('the pressed button wins over a jittering stream',
    p.controller?.address === '/flic/1', JSON.stringify(p.controller));
  check('and disarms', bridge.learning === false);
  check('the binding traffic did not drive the param', p.value === 0,
    `${p.value} — learning also moved what it landed on`);
  check('the badge names the address', p.controllerLabel === 'OSC:/flic/1', p.controllerLabel);

  msg('/flic/1', [0.5]);
  check('afterwards that address drives the param', Math.abs(p.value - 50) < 1e-9, String(p.value));
  msg('/flic/9', [1]);
  check('an unbound address does nothing', Math.abs(p.value - 50) < 1e-9, String(p.value));
}

console.log('\na swept fader beats a stream that is merely noisy');
{
  const { ps, bridge, msg } = rig();
  arm(bridge, 't.cont');
  // Same number of messages from each, so only MOVEMENT can separate them.
  for (let i = 0; i < 40; i++) {
    msg('/accel/x', [0.50 + (i % 2) * 0.01]);   // jitter in place
    msg('/fader/1', [i / 39]);                  // a real sweep
  }
  await settled();
  check('the fader that swept is the one bound',
    ps.get('t.cont').controller?.address === '/fader/1',
    JSON.stringify(ps.get('t.cont').controller));
}

console.log("\nImWeb's own feedback vocabulary is never learnable");
{
  const { ps, bridge, msg } = rig();
  arm(bridge, 't.cont');
  msg('/imweb/t.tog', [1]);                 // e.g. a device echoing our feedback
  msg('/flic/7', [1]);
  await settled();
  check('an /imweb/ address is not a learn candidate',
    ps.get('t.cont').controller?.address === '/flic/7',
    JSON.stringify(ps.get('t.cont').controller));
}

console.log('\na learned button obeys the same press rules');
{
  const { ps, bridge, msg, fires } = rig();
  const t = ps.get('t.tog');
  arm(bridge, 't.tog');
  msg('/flic/2', []);                    // a Flic sends no argument
  await settled();
  check('a bare message can be learned', t.controller?.address === '/flic/2', JSON.stringify(t.controller));
  msg('/flic/2', []);
  check('press flips the toggle on', t.value === 1, String(t.value));
  msg('/flic/2', []);
  check('the next press flips it off', t.value === 0, String(t.value));

  const r = ps.get('t.trig');
  const n = fires(r);
  arm(bridge, 't.trig');
  msg('/flic/3', [1]);
  await settled();
  msg('/flic/3', [1]);
  msg('/flic/3', [0]);
  check('a learned trigger fires on the press only', n() === 1, `${n()} fires`);

  const c = ps.get('t.cont');
  arm(bridge, 't.cont');
  msg('/flic/4', []);
  await settled();
  msg('/flic/4', []);
  check('a bare press on a continuous param reads as full scale', c.value === 100, String(c.value));
}

console.log('\nlearn can be cancelled, and a learned value is not echoed');
{
  const { ps, bridge, msg, flush } = rig();
  arm(bridge, 't.cont');
  bridge.cancelLearn();
  msg('/flic/5', [1]);
  await settled();
  check('a cancelled arm binds nothing', !ps.get('t.cont').controller, JSON.stringify(ps.get('t.cont').controller));

  arm(bridge, 't.cont');
  msg('/flic/6', [1]);
  await settled();
  flush();                                  // clear anything the bind queued
  msg('/flic/6', [0.4]);
  check('a value arriving through a learned binding is not sent back',
    !flush().some(o => o.address === '/imweb/t.cont'), 'echoed');
}

console.log('\nfeedback respects the connection');
{
  const { ps, bridge, ws, flush } = rig();
  bridge.disconnect();
  ps.set('t.cont', 55);
  bridge._flush?.();
  check('nothing is sent after disconnect', ws.sent.length === 0, `${ws.sent.length} sent`);
  // The flush above is not what runs in life — disconnect stops the timer, so
  // nothing flushes until reconnect. Change again with NO flush in between, or
  // this check is passed by the flush discarding the queue (mutation found it).
  ps.set('t.cont', 65);

  ps.register({ id: 't.late', label: 'L', group: 'g', min: 0, max: 1, value: 0 });
  bridge.connect('ws://relay');
  const ws2 = sockets.at(-1);
  ws2.readyState = FakeWS.OPEN;
  ws2.onopen?.();
  ps.set('t.late', 0.5);
  const before = ws2.sent.length;
  bridge._flush?.();
  const late = ws2.sent.slice(before).find(o => o.address === '/imweb/t.late');
  check('a param registered after the bridge was built is watched once connected',
    late?.args[0] === 0.5, JSON.stringify(ws2.sent));
  check('a change made while disconnected is not replayed on reconnect',
    !ws2.sent.some(o => o.address === '/imweb/t.cont'), JSON.stringify(ws2.sent));
  bridge.disconnect();
}

console.log('\nthe relay URL is remembered, so OSC comes back by itself');
{
  store.clear();
  const ps = new ParameterSystem();
  const bridge = new OSCBridge(ps, { loadPreset() {} });
  check('nothing is dialled before OSC has ever been used', bridge.autoConnect() === null,
    String(bridge.savedUrl));
  const before = sockets.length;
  check('and no socket was opened', sockets.length === before);

  bridge.connect('ws://relay:9999');
  const ws = sockets.at(-1);
  check('a URL is NOT remembered until the socket opens', bridge.savedUrl === null,
    String(bridge.savedUrl));
  ws.readyState = FakeWS.OPEN;
  ws.onopen();
  check('a connection that opened is remembered', bridge.savedUrl === 'ws://relay:9999',
    String(bridge.savedUrl));

  ws.onclose();  // the relay was restarted — not a decision to stop using OSC
  check('a dropped connection does NOT forget it', bridge.savedUrl === 'ws://relay:9999',
    String(bridge.savedUrl));

  const bridge2 = new OSCBridge(ps, { loadPreset() {} });
  const n2 = sockets.length;
  check('a later launch dials it without being asked', bridge2.autoConnect() === 'ws://relay:9999');
  check('and really opens a socket to it', sockets.length === n2 + 1 && sockets.at(-1).url === 'ws://relay:9999',
    sockets.at(-1)?.url);

  bridge2.disconnect(); // deliberate: OSC off stays off
  check('turning OSC off forgets the relay', bridge2.savedUrl === null, String(bridge2.savedUrl));
  check('so the next launch dials nothing', bridge2.autoConnect() === null);
}

console.log(failures ? `\n${failures} failure(s)` : '\nall OSC checks pass');
process.exit(failures ? 1 : 0);
