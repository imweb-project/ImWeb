/**
 * Structured-light session audit — the scan's TIMING, end to end.
 *
 * The decoder audit feeds perfectly chosen frames. This one feeds the
 * session a camera stream the way a real rig delivers it: every frame, with
 * the projector's change arriving `latency` frames after the command and
 * landing torn across one frame like a rolling shutter (makeSimCamera). The
 * session has to pick the right frame for every one of the 38 patterns
 * without being told which it is.
 *
 * Control: a fixed "skip N frames after each switch" loop — the obvious
 * implementation — is run on the same stream and shown to corrupt the scan,
 * so the session's agreement with a clean scan is evidence rather than a
 * property of an easy stream.
 *
 * Run:  node tests/audit-structured-light-session.mjs
 */

import { LatencyProbe, ScanSession } from '../src/core/StructuredLightSession.js';
import { GrayDecoder, patternSet } from '../src/core/StructuredLight.js';
import { makeRig, makeSimCamera, PW, PH, CW, CH, SIGMA } from './lib/procam-sim.mjs';

let failures = 0;
const check = (label, cond, detail = '') => {
  if (cond) { console.log(`  ok   ${label}`); }
  else { console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); failures++; }
};

const rig = makeRig({ gi: false });

function runProbe(cam) {
  const p = new LatencyProbe({ w: CW, h: CH });
  cam.command({ kind: p.start().show });
  for (let k = 0; k < 5000; k++) {
    const r = p.push(cam.frame());
    if (r.show) cam.command({ kind: r.show });
    if (r.done) return r;
  }
  return { done: false };
}

function runSession(cam, latency) {
  const s = new ScanSession({ camW: CW, camH: CH, projW: PW, projH: PH, latency, decoder: { noise: SIGMA } });
  cam.command({ kind: 'black' });
  for (let k = 0; k < 12; k++) cam.frame();
  cam.command(s.start(cam.frame()));
  for (let k = 0; k < 20000; k++) {
    const r = s.push(cam.frame());
    if (r.accepted && r.next) cam.command(r.next);
    if (r.done) break;
  }
  return s;
}

// Agreement with a clean scan, as a fraction of the CLEAN scan's valid pixels
// — not of the pixels both happen to share, which is an empty set (and a
// perfect score) for a scan that decoded nothing.
function agreement(a, clean) {
  let same = 0;
  for (let i = 0; i < CW * CH; i++) {
    if (a.valid[i] && clean.valid[i] && a.x[i] === clean.x[i] && a.y[i] === clean.y[i]) same++;
  }
  return same / clean.nValid;
}

function fixedFlush(latency, skip, seed) {
  const cam = makeSimCamera(rig, { latency, seed });
  const dec = new GrayDecoder({ camW: CW, camH: CH, projW: PW, projH: PH, noise: SIGMA });
  for (const pat of patternSet(PW, PH)) {
    cam.command(pat);
    for (let k = 0; k < skip; k++) cam.frame();
    dec.addFrame(pat, cam.frame());
  }
  return dec.finish();
}

// ── 1. Latency probe ────────────────────────────────────────────────────────
console.log('\nLatency probe');
{
  const got = [];
  for (const L of [0, 1, 3, 6]) {
    const r = runProbe(makeSimCamera(rig, { latency: L, seed: 11 + L }));
    got.push(`${L}→${r.latency}`);
    // The simulated camera always tears: the command's first visible frame
    // is torn at count L+1, the first WHOLE frame is L+2 — which is exactly
    // what the probe claims to report. A range here once let a probe that
    // dropped its +1 (reporting the torn frame) pass.
    check(`true latency ${L}: measured ${r.latency} = the first whole frame (L+2)`, r.done && !r.error && r.latency === L + 2,
      JSON.stringify(r));
  }
  console.log(`       true → measured: ${got.join(', ')}`);
  // Torn AND blended: two transitional frames, first whole frame at L+3.
  const bl = runProbe(makeSimCamera(rig, { latency: 3, blend: true, seed: 21 }));
  console.log(`       torn + blended transition, latency 3: measured ${bl.latency}`);
  check('with a torn and a blended frame, the probe still reports the first whole frame (L+3)',
    bl.done && !bl.error && bl.latency === 6, JSON.stringify(bl));
  const frozen = runProbe(makeSimCamera(rig, { latency: 3, frozen: true }));
  check('a camera that never sees a change ends the probe with an error, not a number',
    frozen.done && frozen.error && frozen.latency === undefined, JSON.stringify(frozen));
}

// ── 2. Full scan through the session ────────────────────────────────────────
console.log('\nScan session');
const clean = rig.scan();
{
  const L = 4;
  const cam = makeSimCamera(rig, { latency: L, seed: 5 });
  const probe = runProbe(cam);
  const s = runSession(cam, probe.latency);
  check('session finishes without error', s.done && !s.error, s.error ?? '');
  let res;
  try { res = s.result(); } catch (e) {
    console.error(`  FAIL session produced no result — ${e.message}`);
    process.exit(1);
  }
  const ag = agreement(res, clean);
  const perPattern = res.log.map(e => e.frames);
  console.log(`       latency ${L} (measured ${probe.latency}): ${res.frames} frames for ${res.log.length} patterns (min ${Math.min(...perPattern)}, max ${Math.max(...perPattern)} per pattern); ${res.quiet} quiet, ${res.timeouts} timed out`);
  console.log(`       valid ${res.nValid} vs clean scan ${clean.nValid}; ${(ag * 100).toFixed(2)}% of the clean scan's pixels decode identically`);
  check('no pattern timed out', res.timeouts === 0);
  check('no frame accepted before the change could be whole (≥ latency + 1 frames)', Math.min(...perPattern) >= L + 1,
    `${Math.min(...perPattern)}`);
  check('valid coverage within 1% of a clean scan', Math.abs(res.nValid - clean.nValid) < 0.01 * clean.nValid,
    `${res.nValid} vs ${clean.nValid}`);
  check('≥ 99% of the clean scan decodes identically through the session', clean.nValid > 40000 && ag >= 0.99, `${ag}`);

  // Controls. Skipping a fixed 2 frames — the obvious loop — against a
  // latency of 4 must corrupt the scan; skipping exactly the measured latency
  // must not, which shows the stream is fair rather than rigged against
  // fixed flushes. The session's case is that it needs no number that can go
  // stale: a different projector, camera or frame rate moves the latency.
  const short = fixedFlush(L, 2, 5), exact = fixedFlush(L, probe.latency - 1, 5);
  const agS = agreement(short, clean), agE = agreement(exact, clean);
  console.log(`       control, fixed flush: skip 2 → ${(agS * 100).toFixed(2)}% identical (valid ${short.nValid}); skip ${probe.latency - 1} → ${(agE * 100).toFixed(2)}%`);
  check('separation: a fixed flush shorter than the latency corrupts the scan (< 50%)', agS < 0.5, `${agS}`);
  check('positive control: a fixed flush of the measured latency works on this stream (≥ 99%)', agE >= 0.99, `${agE}`);
}

{
  // Torn AND blended transitions on every switch: the gate must skip both.
  const cam = makeSimCamera(rig, { latency: 2, blend: true, seed: 8 });
  const probe = runProbe(cam);
  const s = runSession(cam, probe.latency);
  const res = s.done && !s.error ? s.result() : null;
  const ag = res ? agreement(res, clean) : 0;
  console.log(`       torn + blended, latency 2 (measured ${probe.latency}): ${(ag * 100).toFixed(2)}% identical, ${res?.frames} frames`);
  check('with blended frames too, ≥ 99% of the clean scan decodes identically', ag >= 0.99, `${ag}`);
}

{
  const s = runSession(makeSimCamera(rig, { latency: 3, frozen: true }), 4);
  let msg = null;
  try { s.result(); } catch (e) { msg = e.message; }
  console.log(`       frozen camera: ${s.error}`);
  check('a camera that cannot see the projection stops at the white reference', s.done && /white/.test(s.error ?? ''));
  check('and result() refuses, saying WHY (not a generic "incomplete")', /white/.test(msg ?? ''), msg ?? 'did not throw');
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
