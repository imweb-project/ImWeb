/**
 * The audio tape survives Audio Off and travels in a project file
 * (src/audio/tape-snapshot.js). Before this, both lost the recording silently:
 * Audio Off discarded the worklet with the tape inside it, and a .imweb carried
 * the audio settings but not one sample of sound.
 *
 * Driven against a fake tape in node — the module is pure by design, so the
 * round trip, the silence skipping, the resample and the clear-on-load path are
 * all checked without an AudioContext.
 *
 * Run:  node tests/audit-tape-snapshot.mjs
 */

import {
  captureSnapshot, restoreSnapshot, snapshotToJSON, snapshotFromJSON, CHUNK_SECONDS,
} from '../src/audio/tape-snapshot.js';

let failures = 0;
const check = (label, cond, detail = '') => {
  if (cond) { console.log(`  ok   ${label}`); }
  else { console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); failures++; }
};

/** A stereo tape behind the same read/write shape the engine offers. */
function fakeTape(length) {
  const l = new Float32Array(length), r = new Float32Array(length);
  let reads = 0, maxRead = 0;
  return {
    l, r, length,
    get reads() { return reads; }, get maxRead() { return maxRead; },
    read: async (a, b) => {
      reads++; maxRead = Math.max(maxRead, b - a);
      const out = new Float32Array((b - a) * 2);
      for (let i = a; i < b; i++) { out[2 * (i - a)] = l[i]; out[2 * (i - a) + 1] = r[i]; }
      return { start: a, channels: 2, data: out };
    },
    write: (at, ch, data) => {
      for (let i = 0; i < data.length / ch; i++) { l[at + i] = data[i * ch]; r[at + i] = data[i * ch + 1]; }
    },
  };
}

const SR = 1000;                       // small rate keeps the arrays small
const LEN = 25 * SR;                   // 25 s: three read chunks, last one short

console.log('round trip');
{
  const src = fakeTape(LEN);
  // Two recorded spans, one crossing a chunk boundary (10 s), silence between.
  for (let i = 2 * SR; i < 3 * SR; i++) { src.l[i] = Math.sin(i / 7) * 0.5; src.r[i] = -src.l[i]; }
  for (let i = 9 * SR + 500; i < 12 * SR; i++) { src.l[i] = 0.25; src.r[i] = (i % 100) / 100 - 0.5; }
  const snap = await captureSnapshot(src.read, LEN, SR);
  check('every read stays inside the engine cap', src.maxRead <= CHUNK_SECONDS * SR, `max ${src.maxRead}`);
  check('silent blocks are skipped (two runs, not one tape)', snap.runs.length === 2,
    `${snap.runs.length} runs`);
  const frames = snap.runs.reduce((n, r) => n + r.pcm.length / 2, 0);
  check('only recorded seconds are stored', frames === 1 * SR + 3 * SR, `${frames} frames`);

  const back = snapshotFromJSON(JSON.parse(JSON.stringify(snapshotToJSON(snap))));
  const dst = fakeTape(LEN);
  dst.l.fill(0.9); dst.r.fill(0.9);    // old material that a load must replace
  restoreSnapshot(back, dst.write, SR, LEN, { clear: true });
  let err = 0;
  for (let i = 0; i < LEN; i++) err = Math.max(err, Math.abs(dst.l[i] - src.l[i]), Math.abs(dst.r[i] - src.r[i]));
  check('JSON round trip restores every sample within 16-bit error', err <= 1 / 32767 + 1e-7, `max err ${err}`);

  // The control: without `clear`, the old material survives in the gaps — so
  // the check above really is what clears it, not an accident of the fixture.
  const keep = fakeTape(LEN);
  keep.l.fill(0.9); keep.r.fill(0.9);
  restoreSnapshot(back, keep.write, SR, LEN, { clear: false });
  check('control: without clear, gaps keep what was there', keep.l[20 * SR] === Math.fround(0.9));
}

console.log('\nan untouched tape stores nothing');
{
  const t = fakeTape(LEN);
  const snap = await captureSnapshot(t.read, LEN, SR);
  check('empty tape gives zero runs', snap.runs.length === 0);
}

console.log('\na refused read is not a partial snapshot');
{
  const t = fakeTape(LEN);
  t.l[100] = 0.5;
  let n = 0;
  const flaky = (a, b) => (++n === 2 ? Promise.resolve(null) : t.read(a, b));
  check('a refused chunk returns null', (await captureSnapshot(flaky, LEN, SR)) === null);
}

console.log('\nanother sample rate keeps time');
{
  const src = fakeTape(LEN);
  for (let i = 5 * SR; i < 6 * SR; i++) { src.l[i] = 0.5; src.r[i] = 0.5; }
  const snap = await captureSnapshot(src.read, LEN, SR);
  const SR2 = 2 * SR, LEN2 = 2 * LEN;
  const dst = fakeTape(LEN2);
  restoreSnapshot(snap, dst.write, SR2, LEN2);
  check('a second recorded at 5 s still starts at 5 s', dst.l[5 * SR2 + 10] > 0.49 && dst.l[5 * SR2 - 10] === 0);
  check('and still lasts one second', dst.l[6 * SR2 - 10] > 0.49 && dst.l[6 * SR2 + 10] === 0);
}

console.log('\na shorter tape drops what no longer fits');
{
  const src = fakeTape(LEN);
  for (let i = 20 * SR; i < 21 * SR; i++) src.l[i] = 0.5;
  const snap = await captureSnapshot(src.read, LEN, SR);
  const dst = fakeTape(10 * SR);
  let threw = null;
  try { restoreSnapshot(snap, dst.write, SR, 10 * SR); } catch (e) { threw = e; }
  check('no write past the end', threw === null, String(threw));
}

if (failures) { console.error(`\n${failures} tape-snapshot check(s) FAILED`); process.exit(1); }
console.log('\nAll tape-snapshot checks passed.');
