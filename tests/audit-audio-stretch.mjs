/**
 * Stretch (PaulStretch) audit.
 *
 * Why this exists. The stretch reads one span of tape and writes a much longer
 * version of it somewhere else, with the pitch unchanged. Almost everything that
 * can be wrong with it produces SOUND — a transform with a sign flipped, an
 * overlap that does not sum to one, a phase table that is not mirrored — and the
 * sound is still a long smeared wash, which is exactly what the feature is
 * supposed to make. A wrong stretch cannot be told from a right one by looking
 * at whether the tape filled, and hardly by listening.
 *
 * So the worklet itself runs here in Node, quantum by quantum, and the output is
 * MEASURED: a sine goes in and the same frequency must come out; the level must
 * come out the same; a stereo-left source must stay left; the same job must give
 * the same samples twice. The paced FFT is checked against itself — the result
 * must not depend on where the quantum boundaries happened to fall, which is
 * what a resumable transform gets wrong first.
 *
 * It cannot be a runtime check: there is no reference signal at runtime.
 *
 * Run:  node tests/audit-audio-stretch.mjs
 */
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { PROTO_VERSION, REFUSE, CLIENT_TO_ENGINE } from '../src/audio/protocol.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
const check = (label, cond, detail = '') => {
  if (cond) { console.log(`  ok   ${label}`); }
  else { console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); failures++; }
};

const SR = 48000;
globalThis.sampleRate = SR;
globalThis.AudioWorkletProcessor = class {
  constructor() {
    this.port = { onmessage: null, postMessage: (m) => this.__sent.push(m) };
    this.__sent = [];
  }
};
let Processor = null;
globalThis.registerProcessor = (_name, cls) => { Processor = cls; };
await import(`file://${resolve(root, 'src/audio/engine/tape-processor.js')}`);
if (!Processor) { console.error('the worklet did not register a processor'); process.exit(1); }
const procSrc = readFileSync(resolve(root, 'src/audio/engine/tape-processor.js'), 'utf8');

/** Goertzel magnitude at `hz`, normalized so a unit sine reads about 1. */
function energyAt(buf, hz) {
  const w = (2 * Math.PI * hz) / SR;
  const coeff = 2 * Math.cos(w);
  let s1 = 0, s2 = 0;
  for (let i = 0; i < buf.length; i++) {
    const s0 = buf[i] + coeff * s1 - s2;
    s2 = s1; s1 = s0;
  }
  return (2 * Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - coeff * s1 * s2))) / buf.length;
}
const rms = (buf) => { let s = 0; for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i]; return Math.sqrt(s / buf.length); };

function makeEngine({ tapeSeconds = 8 } = {}) {
  const p = new Processor();
  const send = (a, ...v) => p.port.onmessage({ data: { a, t: '', v } });
  send('/engine/hello', PROTO_VERSION);
  send('/engine/tape/alloc', tapeSeconds);
  p.__sent.length = 0;
  const out = [new Float32Array(128), new Float32Array(128)];
  const runJob = (id, cap = 400000) => {
    for (let q = 0; q < cap; q++) {
      p.process([[]], [out]);
      if (p.__sent.some((m) => m.a === `/job/${id}/done` || m.a === `/job/${id}/error`)) return q + 1;
    }
    return -1;
  };
  const refusals = () => p.__sent.filter((m) => m.a === '/engine/refuse');
  return { p, send, runJob, refusals, out, clear: () => { p.__sent.length = 0; } };
}
/**
 * Energy at `hz` averaged over short blocks. NOT one Goertzel over the whole
 * output: the method gives every frame a new random phase, so a stretched sine
 * is the right pitch with no long-term phase coherence at all, and a single
 * long correlation against it sums to nearly nothing — which reads exactly like
 * "the pitch is wrong". (The first version of this audit made that mistake.)
 */
function blockEnergy(buf, hz, block = 2048) {
  let sum = 0, n = 0;
  for (let i = 0; i + block <= buf.length; i += block) { sum += energyAt(buf.subarray(i, i + block), hz); n++; }
  return n ? sum / n : 0;
}
/** Deterministic white noise, ±amp. */
const noise = (buf, at, len, amp = 0.5, seed = 12345) => {
  let x = seed >>> 0;
  for (let i = 0; i < len; i++) { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; buf[at + i] = amp * (x / 2147483648 - 1); }
};
const sine = (buf, at, len, hz, amp = 0.5) => {
  for (let i = 0; i < len; i++) buf[at + i] = amp * Math.sin((2 * Math.PI * hz * i) / SR);
};

// src 0..1 s, dst from 2 s on; the tape is 8 s.
const SRC = 0, SRC_LEN = SR, DST = 2 * SR;

// ═══════════════════════════════════════════════════════════════════════════
console.log('the protocol knows the verb');
{
  check("'/stretch/render' is in the client→engine table", CLIENT_TO_ENGINE['/stretch/render'] === 'iiiiiffi',
    String(CLIENT_TO_ENGINE['/stretch/render']));
  check('the worklet dispatches it', /case '\/stretch\/render':/.test(procSrc));
}

console.log('\na sine goes in and the same pitch comes out, longer');
let reference = null;
{
  const e = makeEngine();
  sine(e.p._tape[0], SRC, SRC_LEN, 440); sine(e.p._tape[1], SRC, SRC_LEN, 440);
  const before = Float32Array.from(e.p._tape[0].subarray(SRC, SRC + SRC_LEN));
  void rms;
  const dstLen = 4 * SR;
  e.send('/stretch/render', SRC, SRC_LEN, DST, dstLen, 8192, 4, 1, 7);
  check('the job is accepted', e.refusals().length === 0, JSON.stringify(e.refusals()[0]?.v));
  const quanta = e.runJob(7);
  check('and ends with exactly one terminal message',
    quanta > 0 && e.p.__sent.filter((m) => /^\/job\/7\/(done|error)$/.test(m.a)).length === 1
      && e.p.__sent.some((m) => m.a === '/job/7/done'), `${quanta} quanta`);
  check('it is paced: far more than one quantum, and never the whole job at once', quanta > 200, `${quanta}`);
  const out = e.p._tape[0].subarray(DST, DST + dstLen);
  // Skip the first and last window: they are the fade in and out.
  const body = out.subarray(8192, dstLen - 8192);
  const at440 = blockEnergy(body, 440);
  check('the output is at 440 Hz', at440 > 0.15, `block energy at 440 = ${at440.toFixed(3)}`);
  // A semitone is 26 Hz away and a 2048-sample block resolves 23 Hz, so the
  // neighbours are the fifth and the octaves — a transposed or mirrored
  // spectrum lands on one of those, or nowhere near any of them.
  const off = Math.max(blockEnergy(body, 220), blockEnergy(body, 880), blockEnergy(body, 660), blockEnergy(body, 293.3));
  check('and not at another pitch', off < at440 * 0.05,
    `strongest wrong pitch ${off.toFixed(4)} against ${at440.toFixed(3)}`);
  check('the source is untouched',
    before.every((v, i) => v === e.p._tape[0][SRC + i]));
  check('nothing is written past the destination', e.p._tape[0][DST + dstLen] === 0 && e.p._tape[0][DST - 1] === 0);
  check('progress is reported', e.p.__sent.some((m) => m.a === '/job/7/progress'));
  check('the display is told the tape changed', e.p.__sent.some((m) => m.a === '/tape/env/dirty'));
  reference = Float32Array.from(out);
}

console.log('\nthe level that goes in is the level that comes out');
{
  // Measured on NOISE. A pure tone is the one input whose level this method
  // does not preserve — neighbouring frames carry the same frequency at
  // unrelated phases and partly cancel — and that shimmer is its character,
  // not a fault. Noise has no phase to lose, so what is left is the window
  // arithmetic: applied twice, overlapped at half, corrected by `hinv`.
  const e = makeEngine();
  noise(e.p._tape[0], SRC, SRC_LEN); noise(e.p._tape[1], SRC, SRC_LEN, 0.5, 999);
  const inRms = rms(e.p._tape[0].subarray(SRC, SRC + SRC_LEN));
  e.send('/stretch/render', SRC, SRC_LEN, DST, 5 * SR, 8192, 5, 1, 4);
  e.runJob(4);
  const body = e.p._tape[0].subarray(DST + 8192, DST + 5 * SR - 8192);
  const lvl = rms(body) / inRms;
  check('noise comes out at the level it went in', lvl > 0.85 && lvl < 1.18, `output/input RMS = ${lvl.toFixed(3)}`);
  // An overlap that does not sum to a constant shows as a pulse at the frame
  // rate: loud in the middle of each half-window, quiet at the joins. Fold the
  // output on the half-window and compare the two halves of the fold.
  const half = 4096, bins = 8;
  const acc = new Float64Array(bins), cnt = new Float64Array(bins);
  for (let i = 0; i < body.length; i++) { const b = Math.floor(((i % half) / half) * bins); acc[b] += body[i] * body[i]; cnt[b]++; }
  const prof = [...acc].map((v, i) => Math.sqrt(v / cnt[i]));
  const lo = Math.min(...prof), hi = Math.max(...prof);
  check('with no pulse at the frame rate', lo / hi > 0.9, `level across a half-window ${lo.toFixed(3)}..${hi.toFixed(3)}`);
  const max = body.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  check('and is finite', Number.isFinite(max) && max < 4, `peak ${max}`);
}

console.log('\nthe same stretch is the same sound');
{
  const e = makeEngine();
  sine(e.p._tape[0], SRC, SRC_LEN, 440); sine(e.p._tape[1], SRC, SRC_LEN, 440);
  e.send('/stretch/render', SRC, SRC_LEN, DST, 4 * SR, 8192, 4, 1, 3);
  e.runJob(3);
  const out = e.p._tape[0].subarray(DST, DST + 4 * SR);
  let same = true;
  for (let i = 0; i < out.length; i++) if (out[i] !== reference[i]) { same = false; break; }
  check('two runs give identical samples (seeded phases)', same);
}

console.log('\nthe paced transform does not depend on where the quanta fall');
{
  // Same job, but another job's worth of budget is burnt between every pair of
  // steps by calling the stepper with the work cut at different points. Done by
  // patching the per-quantum budget through a second processor whose source has
  // a smaller constant: a resumable FFT that loses its place gives DIFFERENT
  // samples, not merely slower ones.
  const small = procSrc.replace('const STRETCH_OPS_PER_QUANTUM = 1 << 15;', 'const STRETCH_OPS_PER_QUANTUM = 777;');
  check('the budget constant was found to vary', small !== procSrc);
  let Alt = null;
  const prev = globalThis.registerProcessor;
  globalThis.registerProcessor = (_n, cls) => { Alt = cls; };
  await import('data:text/javascript;base64,' + Buffer.from(small).toString('base64'));
  globalThis.registerProcessor = prev;
  const p = new Alt();
  const send = (a, ...v) => p.port.onmessage({ data: { a, t: '', v } });
  send('/engine/hello', PROTO_VERSION); send('/engine/tape/alloc', 8);
  sine(p._tape[0], SRC, SRC_LEN, 440); sine(p._tape[1], SRC, SRC_LEN, 440);
  send('/stretch/render', SRC, SRC_LEN, DST, SR, 8192, 4, 1, 5);
  const out = [new Float32Array(128), new Float32Array(128)];
  let q = 0;
  for (; q < 4000000 && !p.__sent.some((m) => m.a === '/job/5/done'); q++) p.process([[]], [out]);
  check('an odd, tiny budget still finishes', p.__sent.some((m) => m.a === '/job/5/done'), `${q} quanta`);
  const got = p._tape[0].subarray(DST, DST + SR);
  let worst = 0;
  for (let i = 0; i < got.length; i++) worst = Math.max(worst, Math.abs(got[i] - reference[i]));
  check('and gives the same samples as the full budget', worst === 0, `largest difference ${worst}`);
}

console.log('\nstereo survives');
{
  const e = makeEngine();
  sine(e.p._tape[0], SRC, SRC_LEN, 330);          // left only
  e.send('/stretch/render', SRC, SRC_LEN, DST, 2 * SR, 4096, 2, 1, 1);
  e.runJob(1);
  const l = rms(e.p._tape[0].subarray(DST + 4096, DST + 2 * SR - 4096));
  const r = rms(e.p._tape[1].subarray(DST + 4096, DST + 2 * SR - 4096));
  check('a left-only source stays left', l > 0.1 && r < l * 0.001, `L ${l.toFixed(3)}  R ${r.toExponential(2)}`);
}

console.log('\namount, level and the end of the source');
{
  const e = makeEngine();
  // Quiet on purpose: this block checks exact scaling, which only holds below
  // the soft ceiling.
  sine(e.p._tape[0], SRC, SRC_LEN, 440, 0.15); sine(e.p._tape[1], SRC, SRC_LEN, 440, 0.15);
  // ×2 into a 6 s destination: only 2 s of it should be written. The rest of
  // the zone holds a recognisable value first — on an empty tape "left alone"
  // and "overwritten with silence" are the same zeros, and this check passed
  // against a job that padded the whole zone.
  e.p._tape[0].fill(0.25, DST + 3 * SR, DST + 6 * SR);
  e.send('/stretch/render', SRC, SRC_LEN, DST, 6 * SR, 4096, 2, 0.5, 2);
  e.runJob(2);
  const t = e.p._tape[0];
  check('the job stops when the source runs out, not when the destination is full',
    rms(t.subarray(DST + SR, DST + SR + 4096)) > 0.01
      && t.subarray(DST + 3 * SR, DST + 6 * SR).every((v) => v === 0.25),
    'material in the rest of the zone must survive');
  // Against the same job at Level 1 — the phases are seeded, so the two runs
  // differ by exactly the factor and nothing else.
  const f = makeEngine();
  sine(f.p._tape[0], SRC, SRC_LEN, 440, 0.15); sine(f.p._tape[1], SRC, SRC_LEN, 440, 0.15);
  f.send('/stretch/render', SRC, SRC_LEN, DST, 6 * SR, 4096, 2, 1, 2);
  f.runJob(2);
  const lvl = rms(t.subarray(DST + 8192, DST + SR)) / rms(f.p._tape[0].subarray(DST + 8192, DST + SR));
  check('Level scales the result', Math.abs(lvl - 0.5) < 1e-4, `×0.5 gave ${lvl.toFixed(5)}`);
}

console.log('\na loud source cannot leave the tape over full scale');
{
  // A full-scale tone has peaks of 1 at an RMS of 0.7. The same RMS with random
  // phases has peaks three or four times that. Seen in the browser as a frozen
  // beep whose waveform filled the display top to bottom.
  const e = makeEngine();
  for (const ch of e.p._tape) sine(ch, SRC, SRC_LEN, 440, 1);
  e.send('/stretch/render', SRC, SRC_LEN, DST, 4 * SR, 8192, 4, 1, 8);
  e.runJob(8);
  const out = e.p._tape[0].subarray(DST, DST + 4 * SR);
  let peak = 0; for (let i = 0; i < out.length; i++) peak = Math.max(peak, Math.abs(out[i]));
  check('a stretched full-scale tone stays under full scale', peak < 1, `peak ${peak.toFixed(4)}`);
  check('and is still loud — a ceiling, not a level change', rms(out.subarray(8192, out.length - 8192)) > 0.3,
    `RMS ${rms(out.subarray(8192, out.length - 8192)).toFixed(3)}`);
}

console.log('\nfreeze holds one moment');
{
  // An amount of 0 is the limit of the method: the window does not move. The
  // source is 440 Hz for its first half second and 880 Hz after; a freeze must
  // sound the first and never reach the second, however long it runs.
  const e = makeEngine();
  for (const ch of e.p._tape) { sine(ch, SRC, SR / 2, 440); for (let i = 0; i < SR / 2; i++) ch[SRC + SR / 2 + i] = 0.5 * Math.sin((2 * Math.PI * 880 * i) / SR); }
  e.send('/stretch/render', SRC, 8192, DST, 5 * SR, 8192, 0, 1, 6);
  check('an amount of 0 is accepted', e.refusals().length === 0, JSON.stringify(e.refusals()[0]?.v));
  e.runJob(6);
  const end = e.p._tape[0].subarray(DST + 4 * SR, DST + 5 * SR - 8192);
  const start = e.p._tape[0].subarray(DST + 8192, DST + SR);
  check('it fills the whole destination', rms(end) > 0.05, `RMS at the end ${rms(end).toFixed(3)}`);
  check('with the first moment, start to finish',
    blockEnergy(start, 440) > 0.1 && blockEnergy(end, 440) > 0.1,
    `440 Hz at the start ${blockEnergy(start, 440).toFixed(3)}, at the end ${blockEnergy(end, 440).toFixed(3)}`);
  check('and never moves on to what came after it',
    blockEnergy(end, 880) < blockEnergy(end, 440) * 0.05, `880 Hz at the end ${blockEnergy(end, 880).toFixed(4)}`);
  check('at a steady level', Math.abs(rms(end) / rms(start) - 1) < 0.25, `${(rms(end) / rms(start)).toFixed(3)}`);
}

console.log('\nwhat the engine refuses');
{
  const refuse = (label, args, re) => {
    const e = makeEngine();
    e.send('/stretch/render', ...args);
    const r = e.refusals()[0];
    check(label, !!r && re.test(r.v[1]) && e.p.__sent.some((m) => m.a === `/job/${args[7]}/error`) && !e.p._stretchJob,
      r ? r.v[1] : 'accepted');
  };
  refuse('overlapping source and destination', [0, SR, SR / 2, SR, 4096, 2, 1, 9], /overlap/);
  refuse('a destination off the end of the tape', [0, SR, 7 * SR, 2 * SR, 4096, 2, 1, 9], /leaves the tape/);
  refuse('a source off the end of the tape', [7 * SR + 1, SR, 0, SR, 4096, 2, 1, 9], /leaves the tape/);
  refuse('a window that is not a power of two', [0, SR, 2 * SR, SR, 5000, 2, 1, 9], /power of two/);
  refuse('a window larger than the limit', [0, SR, 2 * SR, SR, 131072, 2, 1, 9], /power of two/);
  refuse('an amount below 1', [0, SR, 2 * SR, SR, 4096, 0.5, 1, 9], /amount/);
  refuse('a NaN amount', [0, SR, 2 * SR, SR, 4096, NaN, 1, 9], /amount/);
  refuse('a fractional sample position', [0.5, SR, 2 * SR, SR, 4096, 2, 1, 9], /not an integer/);

  const e = makeEngine();
  sine(e.p._tape[0], SRC, SRC_LEN, 440);
  e.send('/stretch/render', SRC, SRC_LEN, DST, 4 * SR, 8192, 4, 1, 11);
  e.send('/stretch/render', SRC, SRC_LEN, DST, 4 * SR, 8192, 4, 1, 12);
  check('a second stretch while one runs is BUSY',
    e.refusals().some((r) => r.v[0] === REFUSE.BUSY) && e.p._stretchJob.id === 11);
  e.clear();
  e.send('/engine/tape/alloc', 4);
  check('the tape cannot be reallocated under a running stretch',
    e.refusals().some((r) => r.v[0] === REFUSE.LAYOUT_LOCKED) && e.p._length === 8 * SR);
  e.clear();
  e.send('/part/0/bounds', 0, SR);
  check('nor the layout changed', e.refusals().some((r) => r.v[0] === REFUSE.LAYOUT_LOCKED));
  e.clear();
  for (let q = 0; q < 50; q++) e.p.process([[]], [e.out]);
  e.send('/job/11/cancel');
  check('cancel ends it with one error and keeps what was written',
    e.p.__sent.filter((m) => m.a === '/job/11/error').length === 1 && !e.p._stretchJob);
  e.send('/stretch/render', SRC, SRC_LEN, DST, 4 * SR, 8192, 4, 1, 13);
  e.clear();
  e.send('/engine/panic');
  check('panic ends it', !e.p._stretchJob && e.p.__sent.some((m) => m.a === '/job/13/error'));
}

console.log(failures ? `\n${failures} FAILURE(S)\n` : '\nAll stretch checks passed.\n');
process.exit(failures ? 1 : 0);
