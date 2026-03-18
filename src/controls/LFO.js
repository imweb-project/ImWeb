/**
 * ImWeb LFO System
 * Four waveforms: sine, triangle, sawtooth, square (with pulse width)
 * Modes: norm (free-running), shot (one cycle), x-mapping (externally triggered)
 * All LFOs retrigger on DisplayState recall.
 */

export const LFO_SHAPE = { SINE: 'sine', TRIANGLE: 'triangle', SAWTOOTH: 'sawtooth', SQUARE: 'square' };
export const LFO_MODE  = { NORM: 'norm', SHOT: 'shot', XMAP: 'xmap' };

export class LFO {
  constructor({ shape = LFO_SHAPE.SINE, hz = 0.5, phase = 0, mode = LFO_MODE.NORM, width = 0.5 } = {}) {
    this.shape  = shape;
    this.hz     = hz;
    this.phase  = phase; // 0–1
    this.mode   = mode;
    this.width  = width; // pulse width for square wave (0–1)

    this._t     = phase; // current phase accumulator 0–1
    this._running = true;
    this._cycleComplete = false;
  }

  // Called every frame with delta time in seconds. Returns 0–1.
  tick(dt) {
    if (!this._running) return this._sample(this._t);

    this._t += this.hz * dt;

    if (this.mode === LFO_MODE.SHOT) {
      if (this._t >= 1) {
        this._t = 1;
        this._running = false;
        this._cycleComplete = true;
      }
    } else {
      this._t = this._t % 1; // free-running wrap
    }

    return this._sample(this._t);
  }

  retrigger() {
    this._t = this.phase;
    this._running = true;
    this._cycleComplete = false;
  }

  _sample(t) {
    switch (this.shape) {
      case LFO_SHAPE.SINE:
        return 0.5 + 0.5 * Math.sin(t * Math.PI * 2);
      case LFO_SHAPE.TRIANGLE:
        return t < 0.5 ? t * 2 : 2 - t * 2;
      case LFO_SHAPE.SAWTOOTH:
        return t; // rises 0→1, snaps back
      case LFO_SHAPE.SQUARE:
        return t < this.width ? 1 : 0;
      default:
        return t;
    }
  }

  serialize() {
    return { shape: this.shape, hz: this.hz, phase: this.phase, mode: this.mode, width: this.width };
  }
}

// LFOController wraps an LFO for use with the parameter system
export class LFOController {
  constructor(config = {}) {
    this.type = `lfo-${config.shape ?? 'sine'}`;
    this.lfo  = new LFO(config);
    this.min  = config.min ?? 0;
    this.max  = config.max ?? 1;
  }

  tick(dt) {
    return this.min + this.lfo.tick(dt) * (this.max - this.min);
  }

  retrigger() { this.lfo.retrigger(); }

  serialize() {
    return { type: this.type, ...this.lfo.serialize(), min: this.min, max: this.max };
  }
}
