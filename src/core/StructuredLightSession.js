/**
 * ImWeb Structured Light — the scan as a state machine, driven by camera frames.
 *
 * The rig I/O (a projector window, a camera track, a Worker) only has to do
 * two things: show whatever pattern this says to, and push every camera frame
 * in. All the timing decisions live HERE, where the simulated rig can drive
 * them with latency, rolling-shutter tears and noise — rather than being
 * invented inside a requestAnimationFrame loop that can only be tested by
 * standing in front of a projector.
 *
 * Two machines, run in order:
 *   LatencyProbe  flashes black/white and counts frames until the camera sees
 *                 each change — the `latency` SettleGate requires;
 *   ScanSession   walks patternSet(), accepting one settled frame per pattern
 *                 into the decoder.
 *
 * Both are pure: frames in (8-bit luma, row 0 = top), instructions out.
 */

import { patternSet, GrayDecoder, SettleGate, frameStats } from './StructuredLight.js';

/**
 * Measures, in camera frames, how long a projected change takes to reach the
 * camera. Alternates black and white `trials` times each way. For each switch
 * it counts frames from the command until the picture has CHANGED and then
 * HELD STILL, and records the first frame of the still pair: the first whole
 * frame of the new pattern. Not "first changed frame + 1": that assumes
 * exactly one transitional frame, and a camera whose exposure straddles the
 * switch delivers a torn frame AND a blended one.
 *
 * Protocol: start() says what to show; after every push(), show `show` if it
 * is set. `done` ends it, with `latency` or `error`.
 */
export class LatencyProbe {
  constructor({ w, h, trials = 3, changeTol = 12, minChanged = 0.01, stableTol = 4, maxFrames = 120 }) {
    Object.assign(this, { w, h, trials, changeTol, minChanged, stableTol, maxFrames });
    this.counts = [];
  }

  start() {
    this.level = 'black';
    this.phase = 'settle';   // the first settle only establishes the black reference
    this.ref = null;
    this.last = null;
    this.frames = 0;
    return { show: this.level };
  }

  push(frame) {
    const { w, h } = this;
    this.frames++;
    const last = this.last;
    this.last = frame;
    const st = last ? frameStats(frame, last, this.phase === 'wait' ? this.ref : null, w, h, this) : null;
    // Only cells that are still can count as changed (see frameStats), so a
    // change is first detected on the frame that CONFIRMS the first whole
    // one — record there when the frame is stable. Waiting for a further
    // still pair reported every latency one frame late.
    let settled = false;
    if (this.phase === 'wait') {
      if (st && st.changed >= this.minChanged) {
        if (st.stable) settled = true;
        else this.phase = 'settle';
      }
    } else if (st?.stable) settled = true;
    if (settled) {
      // `last` is the first whole frame; this one confirms it.
      if (this.ref) this.counts.push(this.frames - 1);
      if (this.counts.length >= 2 * this.trials) {
        return { done: true, latency: Math.max(...this.counts), counts: this.counts.slice() };
      }
      this.ref = frame;
      this.level = this.level === 'black' ? 'white' : 'black';
      this.phase = 'wait';
      this.frames = 0;
      return { show: this.level, done: false };
    }
    if (this.frames >= this.maxFrames) {
      return { done: true, error: `no ${this.phase === 'wait' ? 'change' : 'still picture'} seen in ${this.maxFrames} frames — is the camera pointed at the projection?` };
    }
    return { done: false };
  }
}

/**
 * One scan. start(baseline) with a frame of what the camera sees before the
 * scan, then push() every camera frame; when a push reports `accepted`, show
 * `next` (null once the scan is done).
 *
 * Refuses to produce a correspondence it has reason to distrust:
 *   - the white or black reference accepted WITHOUT a visible change means
 *     the camera cannot see the projection, and the scan stops there;
 *   - a timed-out pattern is recorded in `log` and counted in the result.
 * Quiet accepts of gray patterns are normal for bits the camera cannot
 * resolve; they are counted, not refused.
 */
export class ScanSession {
  constructor({ camW, camH, projW, projH, latency, decoder = {}, gate = {} }) {
    this.patterns = patternSet(projW, projH);
    this.decoder = new GrayDecoder({ camW, camH, projW, projH, ...decoder });
    this.gate = new SettleGate({ w: camW, h: camH, latency, ...gate });
    this.i = -1;
    this.log = [];
    this.error = null;
  }

  start(baseline) {
    this.i = 0;
    this.gate.begin(baseline);
    return this.patterns[0];
  }

  get pattern() { return this.patterns[this.i] ?? null; }
  get done() { return this.error !== null || this.i >= this.patterns.length; }

  push(frame) {
    if (this.i < 0) throw new Error('ScanSession.push before start()');
    if (this.done) return { accepted: false, next: null, done: true, error: this.error };
    const r = this.gate.push(frame);
    if (!r.accept) return { accepted: false, next: null, done: false };
    const pat = this.patterns[this.i];
    this.log.push({ index: pat.index, frames: r.frames, changed: r.changed, timedOut: r.timedOut });
    if (pat.kind !== 'gray' && !r.changed) {
      this.error = `the camera did not see the ${pat.kind} reference appear — is it pointed at the projection?`;
      return { accepted: false, next: null, done: true, error: this.error };
    }
    this.decoder.addFrame(pat, frame);
    this.i++;
    this.gate.begin(frame);
    return { accepted: true, next: this.pattern, done: this.done };
  }

  result() {
    if (this.error) throw new Error(this.error);
    if (!this.done) throw new Error(`scan unfinished: pattern ${this.i} of ${this.patterns.length}`);
    const res = this.decoder.finish();
    const frames = this.log.reduce((s, e) => s + e.frames, 0);
    return {
      ...res,
      log: this.log,
      frames,
      quiet: this.log.filter(e => !e.changed && !e.timedOut).length,
      timeouts: this.log.filter(e => e.timedOut).length,
    };
  }
}
