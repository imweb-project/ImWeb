/**
 * Playheads audit.
 *
 * Why this exists. The Playback zone has four heads — the zone itself and three
 * extra readers of the same region, each with its own speed, direction and
 * level — and the tape display draws a line where each one is. Two things about
 * that can be wrong while everything still sounds and looks plausible:
 *
 *  - a head reading a region the Playback zone is not showing. The extra heads
 *    have no region of their own; every change to the zone's partition, region
 *    or Unsafe has to reach all four, and one that is missed leaves a head
 *    playing where the handle used to be.
 *  - a line drawn where the sound is not. The position is reported by the
 *    engine as a fraction of the TAPE; a fraction of the zone, or of the
 *    partition, draws a perfectly smooth, perfectly wrong line.
 *
 * The engine half runs the worklet in Node and checks the reported positions
 * against where the playhead must be; the client half drives the real binding
 * against a fake node and reads what it sent.
 *
 * Run:  node tests/audit-audio-heads.mjs
 */
import { register } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { PROTO_VERSION, ENGINE_TO_CLIENT } from '../src/audio/protocol.js';

register('data:text/javascript,' + encodeURIComponent(`
  export async function resolve(spec, ctx, next) {
    if (spec.endsWith('?url')) return { url: 'data:text/javascript,export default "worklet.js"', shortCircuit: true };
    return next(spec, ctx);
  }`));

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const check = (label, cond, detail = '') => {
  if (cond) { console.log(`  ok   ${label}`); }
  else { console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); failures++; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── the engine half ────────────────────────────────────────────────────────
const SR = 48000;
globalThis.sampleRate = SR;
globalThis.AudioWorkletProcessor = class {
  constructor() { this.port = { onmessage: null, postMessage: (m) => this.__sent.push(m) }; this.__sent = []; }
};
let Processor = null;
globalThis.registerProcessor = (_n, cls) => { Processor = cls; };
await import(`file://${resolve(root, 'src/audio/engine/tape-processor.js')}`);

console.log('the engine reports where the heads are');
{
  check("'/play/heads' is in the engine→client table", ENGINE_TO_CLIENT['/play/heads'] === 'b');
  const p = new Processor();
  const send = (a, ...v) => p.port.onmessage({ data: { a, t: '', v } });
  send('/engine/hello', PROTO_VERSION);
  send('/engine/tape/alloc', 8);
  const N = 8 * SR;
  send('/part/1/bounds', 2 * SR, 4 * SR);                 // P1 = 2 s .. 6 s
  for (const i of [0, 1]) {
    send(`/zone/play/${i}/part`, 1);
    send(`/zone/play/${i}/region`, SR, 2 * SR);           // 3 s .. 5 s of the tape
  }
  send('/zone/play/0/rate', 1);
  send('/zone/play/1/rate', -0.5);
  const out = [new Float32Array(128), new Float32Array(128)];
  const run = (n) => { for (let q = 0; q < n; q++) p.process([[]], [out]); };
  run(40);
  check('nothing is reported while nothing plays', !p.__sent.some((m) => m.a === '/play/heads'));
  send('/zone/play/0/on'); send('/zone/play/1/on');
  p.__sent.length = 0;
  run(375);                                               // one second
  const msgs = p.__sent.filter((m) => m.a === '/play/heads').map((m) => new Float32Array(m.v[0]));
  check('one message per frame, not per quantum', msgs.length > 20 && msgs.length < 120, `${msgs.length} in 375 quanta`);
  const last = msgs.at(-1);
  check('both running heads are in it', last.length === 4 && last[0] === 0 && last[2] === 1, [...last].join(' '));
  // After ~1 s at rate 1 from the start of a region that begins at 3 s: ~4 s of 8.
  check('head 1 is where its playhead is, as a fraction of the TAPE',
    Math.abs(last[1] - 4 / 8) < 0.01, `reported ${last[1].toFixed(4)}, expected about 0.5`);
  // Rate −0.5 from the start wraps to the end of the region and runs backwards:
  // 5 s − 0.5 s = 4.5 s of 8.
  check('head 2 runs backwards at half speed from the same region',
    Math.abs(last[3] - 4.5 / 8) < 0.01, `reported ${last[3].toFixed(4)}, expected about 0.5625`);
  check('every reported position is inside the region',
    msgs.every((m) => { for (let i = 1; i < m.length; i += 2) if (m[i] < 3 / 8 - 1e-6 || m[i] > 5 / 8 + 1e-6) return false; return true; }));
  let moved = 0;
  for (let i = 1; i < msgs.length; i++) if (msgs[i][1] !== msgs[i - 1][1]) moved++;
  check('and they move', moved > msgs.length * 0.8);
  send('/zone/play/0/off'); send('/zone/play/1/off');
  p.__sent.length = 0;
  run(400);
  const after = p.__sent.filter((m) => m.a === '/play/heads').map((m) => new Float32Array(m.v[0]));
  check('when the last head stops there is one empty message, then silence',
    after.length >= 1 && after.at(-1).length === 0 && after.filter((m) => m.length === 0).length === 1,
    `${after.length} messages, ${after.filter((m) => m.length === 0).length} empty`);
  void N;
}

// ── the client half ────────────────────────────────────────────────────────
const sent = [];
class FakeNode { connect() {} disconnect() {} }
class FakeWorkletNode extends FakeNode {
  constructor() {
    super();
    const self = this;
    this.port = { onmessage: null, postMessage(m) {
      sent.push(m);
      const reply = (a, ...v) => queueMicrotask(() => self.port.onmessage?.({ data: { a, v } }));
      if (m.a === '/engine/hello') reply('/engine/ready', m.v[0], 48000, 600);
      else if (m.a === '/engine/tape/alloc') reply('/tape/env/dirty', 0, 1);
      else if (m.a === '/tape/read') reply('/tape/read/err', m.v[2]);
      else if (m.a === '/tape/env/req') reply('/tape/env/err', m.v[3]);
    } };
  }
}
class FakeContext {
  constructor() { this.state = 'suspended'; this.sampleRate = 48000; this.destination = new FakeNode();
    this.audioWorklet = { addModule: async () => {} }; }
  async resume() { this.state = 'running'; } async suspend() { this.state = 'suspended'; }
  createGain() { return new FakeNode(); } createMediaStreamSource() { return new FakeNode(); }
}
globalThis.AudioContext = FakeContext;
globalThis.AudioWorkletNode = FakeWorkletNode;
globalThis.window = globalThis.window ?? { devicePixelRatio: 1 };
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: {
  async getUserMedia() { return { getTracks: () => [{ stop() {} }] }; } } } });

const { ParameterSystem, registerCoreParameters } = await import('../src/controls/ParameterSystem.js');
const { AudioBinding } = await import('../src/audio/AudioBinding.js');

console.log('\nthe extra heads read exactly what the Playback zone shows');
{
  const ps = new ParameterSystem();
  registerCoreParameters(ps);
  const audio = new AudioBinding(ps);
  await audio.start(); await sleep(20);
  const zonesOf = (re) => sent.filter((m) => re.test(m.a)).map((m) => Number(/\/zone\/play\/(\d+)\//.exec(m.a)[1])).sort();
  check('all four heads were given the region at start',
    [0, 1, 2, 3].every((i) => sent.some((m) => m.a === `/zone/play/${i}/region`)));
  sent.length = 0;
  ps.set('aplay.start', 0.25);
  check('moving Start reaches all four', zonesOf(/^\/zone\/play\/\d+\/region$/).join() === '0,1,2,3', zonesOf(/region$/).join());
  const regions = sent.filter((m) => /\/region$/.test(m.a)).map((m) => m.v.join(','));
  check('with the same numbers', new Set(regions).size === 1, regions.join(' | '));
  sent.length = 0;
  ps.set('aplay.part', 2);
  check('so does the partition', zonesOf(/^\/zone\/play\/\d+\/part$/).join() === '0,1,2,3');
  sent.length = 0;
  ps.set('aplay.unsafe', 1);
  check('and Unsafe', zonesOf(/^\/zone\/play\/\d+\/unsafe$/).join() === '0,1,2,3');
  sent.length = 0;
  ps.set('arec.start', 0.5);
  check('the Recording zone still has one writer, zone 0',
    sent.filter((m) => /^\/zone\/rec\/\d+\/region$/.test(m.a)).map((m) => m.a).join() === '/zone/rec/0/region');

  sent.length = 0;
  ps.set('aheads.on3', 1); ps.set('aheads.rate3', -2); ps.set('aheads.level3', 0.4);
  const has = (a, v) => sent.some((m) => m.a === a && (v === undefined || m.v[0] === v));
  check('head 3 is engine play zone 2: its switch, rate and level go there',
    has('/zone/play/2/on') && has('/zone/play/2/rate', -2) && has('/zone/play/2/level', 0.4),
    sent.map((m) => m.a).join(' '));
  check('and nowhere else', !sent.some((m) => /\/zone\/play\/[013]\//.test(m.a)));
  check('the defaults are three different speeds, not three unisons',
    new Set([2, 3, 4].map((n) => ps.get(`aheads.rate${n}`).defaultValue ?? ps.get(`aheads.rate${n}`).value)).size === 3);

  // The engine stops a head; the switch must say so.
  audio.engine.onZoneState('play', 2, false);
  check('a head the engine stopped reads off on its switch', ps.get('aheads.on3').value === 0);
  audio.engine.onZoneState('play', 0, true);
  check('and zone 0 is still the Playback zone\'s own switch', ps.get('aplay.on').value === 1);
  await audio.stop();
}

console.log(failures ? `\n${failures} FAILURE(S)\n` : '\nAll playhead checks passed.\n');
process.exit(failures ? 1 : 0);
