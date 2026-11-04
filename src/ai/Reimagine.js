/**
 * ImWeb Reimagine — slow AI, fast instrument.
 *
 * Grabs the output frame, sends it to an image-edit model with a prompt, and
 * writes the answer into a Stills Buffer slot. With FollowNew on, the buffer
 * view crossfades to the new slot (fs1 → fs2 over FrameBlend, then fs1 lands
 * on the new slot and FrameBlend returns to 0, so the hand-off has no jump).
 *
 * Route the Stills Buffer to a layer and the picture feeds back: the next
 * frame sent already contains the last answer, so repeated runs DRIFT. That
 * drift is the instrument, not a bug.
 *
 * One request at a time. The interval counts from when an answer lands, not
 * from when it was asked — a slow model can never stack up paid calls.
 */

import { reimagineImage } from './AIFeatures.js';

const SEND_W = 1024;   // what the model sees; edit models work around 1K anyway
const SEND_Q = 0.85;

export class Reimagine {
  /**
   * @param {object} o
   * @param {import('../controls/ParameterSystem.js').ParameterSystem} o.ps
   * @param {import('../inputs/StillsBuffer.js').StillsBuffer} o.stillsBuffer
   * @param {(w:number, q:number) => ({b64:string,mime:string}|null)} o.captureFrame
   * @param {() => number} o.aspect            canvas width / height
   * @param {(msg:string, kind?:'busy'|'ok'|'err') => void} o.onStatus
   * @param {() => void} o.onWrote             a slot changed (refresh the grid)
   */
  constructor({ ps, stillsBuffer, captureFrame, aspect, onStatus, onWrote }) {
    this.ps = ps;
    this.sb = stillsBuffer;
    this.captureFrame = captureFrame;
    this.aspect = aspect;
    this.onStatus = onStatus ?? (() => {});
    this.onWrote = onWrote ?? (() => {});
    this.prompt = '';
    this.busy = false;
    this._wait = 0;        // seconds since the last answer landed (auto mode)
    this._cursor = 0;      // offset inside [slotFrom, slotFrom + slots)
    this._fade = null;     // { to, t, dur } while a crossfade runs

    ps.get('reimagine.go').onTrigger(() => this.run());
    // Turning Auto on fires at once — waiting a full interval to see whether
    // anything happens reads as broken.
    ps.get('reimagine.auto').onChange((v) => { if (v) { this._wait = 0; this.run(); } });
  }

  /** Called every frame from the render loop. */
  tick(dt) {
    if (this._fade) this._stepFade(dt);
    if (!this.ps.get('reimagine.auto').value || this.busy) return;
    this._wait += dt;
    if (this._wait >= this.ps.get('reimagine.interval').value) this.run();
  }

  _nextSlot() {
    const n = this.sb.frameCount;
    const from = Math.min(Math.round(this.ps.get('reimagine.slotFrom').value), n - 1);
    const span = Math.max(1, Math.min(Math.round(this.ps.get('reimagine.slots').value), n - from));
    const slot = from + (this._cursor % span);
    this._cursor = (this._cursor + 1) % span;
    return slot;
  }

  async run() {
    if (this.busy) return;
    this.busy = true;
    this._wait = 0;
    const t0 = performance.now();
    this.onStatus('Reimagining…', 'busy');
    try {
      const frame = this.captureFrame(SEND_W, SEND_Q);
      const out = await reimagineImage(frame, this.prompt, this.aspect());
      const slot = this._nextSlot();
      if (this.sb.isProtected?.(slot)) throw new Error(`slot ${slot + 1} is protected`);
      const ok = await this.sb.importFrame(slot, `data:${out.mime};base64,${out.b64}`);
      if (!ok) throw new Error('the image came back but could not be decoded');
      this.onWrote();
      if (this.ps.get('reimagine.follow').value) this._startFade(slot);
      this.onStatus(`→ slot ${slot + 1} · ${((performance.now() - t0) / 1000).toFixed(1)} s`, 'ok');
    } catch (err) {
      this.onStatus(err.message === 'no-key'
        ? '⚠ Needs a Google Gemini key — add it in AI settings (⚙).'
        : `✗ ${err.message}`, 'err');
      // A failing loop must not keep paying for the same failure.
      if (this.ps.get('reimagine.auto').value) this.ps.set('reimagine.auto', 0);
    } finally {
      this.busy = false;
      this._wait = 0;
    }
  }

  _startFade(to) {
    const dur = this.ps.get('reimagine.fade').value;
    if (dur <= 0 || !this._hasShown()) { this._land(to); return; }
    this.ps.set('buffer.fs2', to);
    this.ps.set('buffer.frameblend', 0);
    this._fade = { to, t: 0, dur };
  }

  _stepFade(dt) {
    const f = this._fade;
    f.t += dt;
    if (f.t >= f.dur) { this._land(f.to); return; }
    this.ps.set('buffer.frameblend', (f.t / f.dur) * 100);
  }

  /** fs1 takes the new slot and the blend drops to 0 in the same frame. */
  _land(to) {
    this._fade = null;
    this.ps.set('buffer.fs1', to);
    this.ps.set('buffer.frameblend', 0);
  }

  /** Is fs1 showing a real frame? If not, cut straight to the new one. */
  _hasShown() {
    return !!this.sb._hasFrame[Math.round(this.ps.get('buffer.fs1').value)];
  }
}
