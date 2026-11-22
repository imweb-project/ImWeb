/**
 * Step sequencer — a controller type.
 *
 * A row of up to sixteen values, stepped through by a clock, driving ONE
 * parameter the way an LFO or Random does. It is to an LFO what a drawn curve
 * is to a sine: the shape is yours. The lineage is the analog step sequencer
 * and, for the parts that make it play rather than loop — a chance per step,
 * steps that can be skipped, a row that slowly rewrites itself — five12's
 * Numerology.
 *
 * **The configuration lives on the parameter, and only there.** Everything in
 * `param.controller` is plain data (numbers and two arrays), so it is saved
 * with a state, a bank and a project like any other controller, and the
 * popover edits it in place. This class holds nothing but the PLAYHEAD — which
 * step it is on and what it last put out — and reads the configuration again
 * on every tick. There is no second copy to fall out of step with the first
 * (LEARNED 2026-09-22, "one thing shown two ways").
 *
 * Imports nothing, so the stepping is testable in Node without a parameter
 * system. Randomness comes in through `rng`, so a test can make it certain.
 */

export const SEQ_MAX_STEPS = 16;
export const SEQ_DIRECTIONS = Object.freeze(['Forward', 'Reverse', 'Ping-pong', 'Random']);

/** A fresh configuration: eight steps, a rising staircase, two a second. */
export function seqDefaults() {
  return {
    type: 'seq',
    count: 8,
    steps: Array.from({ length: SEQ_MAX_STEPS }, (_, i) => (i % 8) / 7),
    on: Array.from({ length: SEQ_MAX_STEPS }, () => 1),
    hz: 2,              // steps per second, when free-running
    beatSync: false,
    beatDiv: 0.25,      // beats per step, when locked to the clock (¼ = sixteenths)
    chance: 1,          // 0..1: how likely a step is to sound at all
    glide: 0,           // 0..1: how much of the step is spent sliding to it
    dir: 0,             // index into SEQ_DIRECTIONS
    evolve: 0,          // 0..1: how far a step drifts each time the row comes round
  };
}

/**
 * Fill in whatever a configuration is missing, in place, and make its two
 * arrays its OWN. A controller restored from a state arrives sharing its
 * arrays with the state it came from; editing a step would then rewrite the
 * saved state under the performer's hand.
 */
export function seqNormalize(c) {
  const d = seqDefaults();
  for (const k of Object.keys(d)) if (c[k] === undefined) c[k] = d[k];
  const fill = (a, def) => Array.from({ length: SEQ_MAX_STEPS },
    (_, i) => (Number.isFinite(a?.[i]) ? a[i] : def[i]));
  c.steps = fill(c.steps, d.steps).map((v) => Math.min(1, Math.max(0, v)));
  c.on = fill(c.on, d.on).map((v) => (v ? 1 : 0));
  c.count = Math.min(SEQ_MAX_STEPS, Math.max(1, Math.round(c.count)));
  return c;
}

export class SeqController {
  /** @param {() => number} rng 0..1 — injectable, for tests */
  constructor(rng = Math.random) {
    this.rng = rng;
    this.reset();
  }

  reset() {
    this._t = 0;          // free-running clock, in steps
    this._k = null;       // the last whole step the clock reached
    this.index = -1;      // which step is sounding (for the display)
    this._dir = 1;        // ping-pong's current direction
    this._cur = null;     // the value being held
    this._from = null;    // where a glide started
  }

  /** The step after `i`, for a direction and a length. */
  _next(i, dir, count) {
    if (count === 1) return 0;
    if (dir === 3) {                      // Random — never the same step twice running
      let j = Math.floor(this.rng() * (count - 1));
      if (j >= i && i >= 0) j++;
      return Math.min(count - 1, j);
    }
    if (dir === 1) return i <= 0 ? count - 1 : i - 1;
    if (dir === 2) {                      // Ping-pong — the ends are played once, not twice
      if (i < 0) { this._dir = 1; return 0; }
      if (i + this._dir >= count) this._dir = -1;
      else if (i + this._dir < 0) this._dir = 1;
      return Math.min(count - 1, Math.max(0, i + this._dir));
    }
    return (i + 1) % count;
  }

  /**
   * Advance by `dt` seconds (or to `beatPhase` beats, when synced) and return
   * the value to write, 0..1 — or `null` when nothing has sounded yet.
   *
   * @param {object} c the configuration, i.e. `param.controller`
   */
  tick(c, dt, beatPhase = 0) {
    const count = Math.min(SEQ_MAX_STEPS, Math.max(1, c.count | 0));
    let pos;
    if (c.beatSync) pos = beatPhase / Math.max(1e-4, c.beatDiv ?? 0.25);
    else { this._t += dt * Math.max(0, c.hz ?? 2); pos = this._t; }
    const k = Math.floor(pos);
    const frac = pos - k;

    if (k !== this._k) {
      // One step per clock edge, however many edges a long frame skipped: a
      // sequencer that jumps three steps after a stall has lost the pattern.
      this._k = k;
      const i = this._next(Math.min(this.index, count - 1), c.dir | 0, count);
      const wrapped = this.index >= 0 && (c.dir | 0) === 0 && i === 0;
      this.index = i;
      // Evolve: each time the row comes round, every step drifts a little.
      // Written INTO the configuration — the row you see is the row that plays.
      if (wrapped && c.evolve > 0) {
        for (let s = 0; s < count; s++) {
          const v = c.steps[s] + (this.rng() * 2 - 1) * c.evolve * 0.25;
          c.steps[s] = v < 0 ? 0 : v > 1 ? 1 : v;
        }
      }
      const sounds = c.on[i] && (c.chance >= 1 || this.rng() < c.chance);
      this._from = this._cur;
      // A skipped step, or one that lost its chance, HOLDS: the value stays
      // where it was. That is what makes a rest a rest and not a jump to zero.
      if (sounds || this._cur === null) this._cur = c.steps[i];
      if (this._from === null) this._from = this._cur;
    }
    if (this._cur === null) return null;
    const g = c.glide ?? 0;
    if (g > 0 && frac < g) return this._from + (this._cur - this._from) * (frac / g);
    return this._cur;
  }
}
