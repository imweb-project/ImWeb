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

console.log(failures ? `\n${failures} failure(s)` : '\nall OSC checks pass');
process.exit(failures ? 1 : 0);
