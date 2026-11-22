/**
 * Audio start-up audit.
 *
 * Why this exists. Starting and stopping sound has four properties that must
 * hold together, and every one of them was broken at once without a single
 * error anywhere:
 *
 *  1. ONE SWITCH. Audio On, with the Mic armed, opens the input — once. It took
 *     three controls in two tabs, and arming Mic before Audio On did nothing at
 *     all: the param flipped, no device opened, and nothing acted on it later.
 *
 *  2. THE MICROPHONE IS RELEASED. `_tapConsumers` was a count that only ever
 *     went up — nothing decremented it, and a device change counted the same
 *     consumer again. After the vectorscope had been started once, the mic
 *     stayed open through Audio Off for the rest of the session.
 *
 *  3. A FAILED START CAN BE RETRIED. `AudioEngine.start()` assigned `node`
 *     before the handshake. When the handshake timed out the binding never
 *     reached `running`, its `stop()` returned early, `close()` never ran, and
 *     every later `start()` found the stale node and returned the same rejected
 *     promise. Audio On was dead until the page was reloaded.
 *
 *  4. ONE NODE. `node` and `running` are each set after an await, so on/off/on
 *     in quick succession built two worklet nodes, or left the engine running
 *     with the toggle reading off.
 *
 * None of these can be a runtime assertion — each is an absence (a device not
 * closed, a second node nobody counted). So this drives the REAL AudioBinding
 * and AudioEngine against a fake Web Audio that counts what was opened, closed
 * and constructed. Checks are on outcomes, never on the source text.
 *
 * Run:  node tests/audit-audio-setup.mjs
 */
import { register } from 'node:module';

// AudioEngine imports its worklet as a Vite `?url`. Node has no such thing;
// the URL is never fetched here (addModule is faked), so any string will do.
register('data:text/javascript,' + encodeURIComponent(`
  export async function resolve(spec, ctx, next) {
    if (spec.endsWith('?url')) return { url: 'data:text/javascript,export default "worklet.js"', shortCircuit: true };
    return next(spec, ctx);
  }`));

let failures = 0;
const check = (label, cond, detail = '') => {
  if (cond) { console.log(`  ok   ${label}`); }
  else { console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); failures++; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── a Web Audio that counts ────────────────────────────────────────────────
const world = { nodes: 0, liveNodes: 0, streams: [], gumCalls: 0, gumConstraints: [], answerHello: true };

class FakeNode { connect() {} disconnect() {} }
class FakeWorkletNode extends FakeNode {
  constructor() {
    super();
    world.nodes++; world.liveNodes++;
    const self = this;
    this.port = {
      onmessage: null,
      postMessage(m) {
        const reply = (a, ...v) => queueMicrotask(() => self.port.onmessage?.({ data: { a, v } }));
        if (m.a === '/engine/hello') { if (world.answerHello) reply('/engine/ready', m.v[0], 48000, 600); }
        else if (m.a === '/engine/tape/alloc') reply('/tape/env/dirty', 0, 1);      // the liveness proof
        else if (m.a === '/tape/read') reply('/tape/read/err', m.v[2]);             // nothing recorded
        else if (m.a === '/tape/env/req') reply('/tape/env/err', m.v[3]);
      },
    };
  }
  disconnect() { world.liveNodes--; }
}
class FakeContext {
  constructor() { this.state = 'suspended'; this.sampleRate = 48000; this.destination = new FakeNode();
    this.audioWorklet = { addModule: async () => {} }; }
  async resume() { this.state = 'running'; }
  async suspend() { this.state = 'suspended'; }
  createGain() { return new FakeNode(); }
  createMediaStreamSource() { return new FakeNode(); }
}
globalThis.AudioContext = FakeContext;
globalThis.AudioWorkletNode = FakeWorkletNode;
globalThis.window = globalThis.window ?? { devicePixelRatio: 1 };
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {
  mediaDevices: {
    async getUserMedia({ audio }) {
      world.gumCalls++; world.gumConstraints.push(audio);
      await sleep(5);                                    // a real open is not instant
      if (audio?.deviceId?.exact === 'gone') { const e = new Error('no such device'); e.name = 'OverconstrainedError'; throw e; }
      const s = { stopped: false, getTracks: () => [{ stop() { s.stopped = true; } }] };
      world.streams.push(s);
      return s;
    },
  },
} });
const openStreams = () => world.streams.filter((s) => !s.stopped).length;

const { ParameterSystem, registerCoreParameters } = await import('../src/controls/ParameterSystem.js');
const { AudioBinding } = await import('../src/audio/AudioBinding.js');

function fresh() {
  Object.assign(world, { nodes: 0, liveNodes: 0, streams: [], gumCalls: 0, gumConstraints: [], answerHello: true });
  const ps = new ParameterSystem();
  registerCoreParameters(ps);
  const audio = new AudioBinding(ps);
  const said = [];
  audio.onStatus = (m) => said.push(m);
  return { ps, audio, said };
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('one switch: Audio On opens an armed input, once');
{
  const { ps, audio, said } = fresh();
  check('nothing is opened by constructing the binding', world.gumCalls === 0 && world.nodes === 0);
  await audio.start(); await sleep(30);
  check('the engine is running', audio.running === true);
  check('the armed mic was opened by Audio On alone', openStreams() === 1 && audio.engine.micOpen,
    `${openStreams()} open stream(s), ${world.gumCalls} getUserMedia call(s)`);
  check('exactly one getUserMedia call', world.gumCalls === 1, `${world.gumCalls}`);
  check('and it said so', said.some((m) => /^mic open/.test(m)), said.join(' | '));
  await audio.stop();
  check('Audio Off releases the device', openStreams() === 0, `${openStreams()} still open`);
}
{
  const { ps, audio } = fresh();
  ps.set('audio.mic', 0);
  await audio.start(); await sleep(30);
  check('with Mic disarmed, Audio On opens no device', world.gumCalls === 0, `${world.gumCalls} call(s)`);
  ps.set('audio.mic', 1); await sleep(30);
  check('arming it while running opens it', openStreams() === 1);
  await audio.stop();
}

console.log('\nthe microphone is released when its last user leaves');
{
  const { audio } = fresh();
  await audio.ensureTap({ owner: 'vectorscope' });
  check('a tap consumer opens the mic without the engine', openStreams() === 1 && !audio.running);
  await audio.ensureTap({ owner: 'vectorscope' });       // a re-init, as on a device change
  audio.releaseTap('vectorscope');
  check('one release frees it, however many times the same consumer attached',
    openStreams() === 0, `${openStreams()} still open — the count only ever went up`);
}
{
  const { audio } = fresh();
  await audio.ensureTap({ owner: 'vectorscope' });
  await audio.ensureTap({ owner: 'sound-ctrl' });
  audio.releaseTap('vectorscope');
  check('a second consumer keeps it open', openStreams() === 1);
  audio.releaseTap('sound-ctrl');
  check('and the last one out closes it', openStreams() === 0);
}
{
  const { audio } = fresh();
  await audio.ensureTap({ owner: 'vectorscope' });
  await audio.start(); await sleep(30);
  audio.releaseTap('vectorscope');
  check('while the engine runs the mic is the engine\'s, and stays', openStreams() === 1);
  await audio.stop();
  check('Audio Off after the consumer left closes it — this is the one that stayed open all session',
    openStreams() === 0, `${openStreams()} still open`);
}
{
  const { audio } = fresh();
  await audio.ensureTap({ owner: 'sound-ctrl' });
  await audio.start(); await sleep(30);
  await audio.stop();
  check('a consumer still attached keeps its mic across Audio Off', openStreams() === 1);
}

console.log('\nno stream is orphaned by two opens at once');
{
  const { audio } = fresh();
  await Promise.all([audio.engine.openMic(), audio.engine.openMic(), audio.engine.openMic()]);
  check('three simultaneous opens make one stream', world.gumCalls === 1 && openStreams() === 1,
    `${world.gumCalls} getUserMedia calls, ${openStreams()} open`);
  audio.engine.closeMic();
  check('and closing leaves none behind', openStreams() === 0);
}

console.log('\na remembered input that is gone falls back instead of failing');
{
  const { audio, said } = fresh();
  let lost = 0; audio.onInputLost = () => lost++;
  await audio.setInputDevice('gone');
  await audio.start(); await sleep(60);
  check('the mic still opened', openStreams() === 1, said.join(' | '));
  check('on the default device', world.gumConstraints.at(-1)?.deviceId === undefined);
  check('the picker was told', lost === 1);
  await audio.stop();
}
{
  const { audio } = fresh();
  await audio.setInputDevice('usb-1');
  await audio.start(); await sleep(30);
  check('a chosen device is asked for EXACTLY', world.gumConstraints.at(-1)?.deviceId?.exact === 'usb-1');
  await audio.setInputDevice('usb-2'); await sleep(30);
  check('changing it reopens on the new device and stops the old stream',
    openStreams() === 1 && world.gumConstraints.at(-1)?.deviceId?.exact === 'usb-2',
    `${openStreams()} open`);
  await audio.stop();
}

console.log('\none node, whatever the order of the clicks');
{
  // What ONE start subscribes, for comparison. The node count alone cannot
  // see an unqueued start: the engine dedupes the node, and the binding then
  // runs its whole start twice over it — every parameter subscribed twice, so
  // every later change is sent to the engine twice.
  const one = fresh();
  await one.audio.start();
  const subs = one.audio._unsubs.length;
  await one.audio.stop();
  const { audio } = fresh();
  await Promise.all([audio.start(), audio.start(), audio.start()]);
  check('three simultaneous starts build one worklet node', world.nodes === 1, `${world.nodes} nodes`);
  check('and subscribe each parameter once, not three times',
    subs > 0 && audio._unsubs.length === subs, `${audio._unsubs.length} subscriptions, one start makes ${subs}`);
  await audio.stop();
}
{
  const { audio } = fresh();
  const a = audio.start(); const b = audio.stop(); const c = audio.start();
  await Promise.all([a, b, c]); await sleep(30);
  check('on / off / on ends ON', audio.running === true);
  check('with exactly one live node', world.liveNodes === 1, `${world.liveNodes} live of ${world.nodes} built`);
  const d = audio.stop(); const e = audio.start(); const f = audio.stop();
  await Promise.all([d, e, f]); await sleep(30);
  check('off / on / off ends OFF', audio.running === false);
  check('with no live node', world.liveNodes === 0, `${world.liveNodes} live`);
  check('and no device held', openStreams() === 0, `${openStreams()} open`);
}

console.log('\nthe tape is as long as it was allocated, not as long as the slider says');
{
  // Reported by the owner, 2026-11-22: "when I make the number bigger, Spectral
  // Writer won't write … ruins the tape, audio engine off and on again fixes
  // it." A new length applies on the next Audio On, but every fraction→sample
  // conversion read the PARAM, so the client and the engine disagreed about the
  // tape from the moment the slider moved.
  const { ps, audio, said } = fresh();
  await audio.start(); await sleep(20);
  const before = audio._tapeLen;
  check('60 s at 48 kHz to begin with', before === 60 * 48000, `${before}`);
  ps.set('audio.tapeSec', 120);
  check('moving Tape length while running does not move the tape', audio._tapeLen === before,
    `conversions now use ${audio._tapeLen} samples against an engine holding ${before}`);
  check('and the status line says when it will apply', /120 s applies on the next Audio On/.test(said.at(-1) ?? ''), said.at(-1));
  await audio.stop(); await audio.start(); await sleep(20);
  check('the next Audio On takes the new length', audio._tapeLen === 120 * 48000, `${audio._tapeLen}`);
  await audio.stop();
  ps.set('audio.tapeSec', 30);
  check('with the engine off the layout follows the slider', audio._tapeLen === 30 * 48000);
}

console.log('\na failed start can be tried again');
{
  const { audio } = fresh();
  world.answerHello = false;
  // The handshake waits 5 s for real; shorten the wait, not the logic.
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...a) => realSetTimeout(fn, ms >= 3000 ? 20 : ms, ...a);
  let failed = null;
  try { await audio.start(); } catch (e) { failed = e; }
  globalThis.setTimeout = realSetTimeout;
  check('a silent engine fails the start', !!failed && /did not answer/.test(failed.message), String(failed?.message));
  check('and leaves no half-built node behind', audio.engine.node === null && world.liveNodes === 0,
    `node ${audio.engine.node ? 'kept' : 'gone'}, ${world.liveNodes} live`);
  world.answerHello = true;
  let second = null;
  try { await audio.start(); } catch (e) { second = e; }
  check('the next Audio On works without a reload', !second && audio.running === true,
    second ? `still failing: ${second.message}` : '');
  await audio.stop();
}

console.log(failures ? `\n${failures} FAILURE(S)\n` : '\nAll audio start-up checks passed.\n');
process.exit(failures ? 1 : 0);
