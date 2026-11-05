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
 * Every counts from when a request is SENT, and at most InFlight (1–2) run at
 * once — so a slow model can never stack up paid calls beyond that cap. An
 * image that lands while a fade runs waits for it (no jump back mid-fade).
 *
 * Director (optional): the prompt box becomes a THEME and the active text AI
 * writes each next prompt (directReimagine). A failed director call falls back
 * to the last prompt and the loop carries on — only the image call can stop it.
 */

import { reimagineImage, directReimagine } from './AIFeatures.js';

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
   * @param {(slot:number, url:string) => void} [o.onLanded]  an image landed in `slot`
   * @param {(prompt:string|null) => void} [o.onDirected]  the director wrote a prompt
   */
  constructor({ ps, stillsBuffer, captureFrame, aspect, onStatus, onWrote, onLanded, onDirected }) {
    this.ps = ps;
    this.sb = stillsBuffer;
    this.captureFrame = captureFrame;
    this.aspect = aspect;
    this.onStatus = onStatus ?? (() => {});
    this.onWrote = onWrote ?? (() => {});
    this.onLanded = onLanded ?? (() => {});
    this.onDirected = onDirected ?? (() => {});
    this.prompt = '';      // the owner's prompt (the THEME when Director is on)
    this.directed = null;  // the director's current prompt, or null
    this._inFlight = 0;
    this._wait = 0;        // seconds since the last request was SENT (auto mode)
    this._cursor = 0;      // offset inside [slotFrom, slotFrom + slots)
    this._fade = null;     // { to, t, dur } while a crossfade runs
    this._queued = null;   // a slot that landed mid-fade, shown when it ends
    this._sent = 0;        // requests sent (the director's NewPromptEvery count)
    this._recent = [];     // prompts used, newest last (director context)
    this._dirChain = Promise.resolve();  // one director call at a time

    ps.get('reimagine.go').onTrigger(() => this.run());
    // Turning Auto on fires at once — waiting a full interval to see whether
    // anything happens reads as broken.
    ps.get('reimagine.auto').onChange((v) => { if (v) { this._wait = 0; this.run(); } });
    // Director off: back to the owner's prompt at once (and hide its line).
    ps.get('reimagine.director').onChange((v) => {
      if (!v && this.directed !== null) { this.directed = null; this.onDirected(null); }
    });
  }

  get busy() { return this._inFlight > 0; }
  _maxInFlight() { return Math.max(1, Math.round(this.ps.get('reimagine.inflight').value)); }

  /** Called every frame from the render loop. */
  tick(dt) {
    if (this._fade) this._stepFade(dt);
    if (!this.ps.get('reimagine.auto').value) return;
    this._wait += dt;
    if (this._inFlight >= this._maxInFlight()) return;
    if (this._wait >= this.ps.get('reimagine.interval').value) this.run();
  }

  _nextSlot() {
    const n = this.sb.frameCount;
    const from = Math.min(Math.round(this.ps.get('reimagine.slotFrom').value), n - 1);
    const span = Math.max(1, Math.min(Math.round(this.ps.get('reimagine.slots').value), n - from));
    // Never overwrite the slot on show when there is another to use: a fade
    // FROM the slot being written is a cut (a Look's camera seed sits in
    // FirstSlot, so the first image after a Look always cut in).
    // With two in flight the same holds for a slot being faded TO or waiting.
    const avoid = new Set([Math.round(this.ps.get('buffer.fs1').value)]);
    if (this._fade) avoid.add(this._fade.to);
    if (this._queued !== null) avoid.add(this._queued);
    let slot = from + (this._cursor % span);
    for (let k = 0; k < span; k++) {
      slot = from + (this._cursor % span);
      this._cursor = (this._cursor + 1) % span;
      if (!avoid.has(slot)) break;
    }
    return slot;
  }

  /** The prompt for this request: the owner's, or the director's next step. */
  async _promptFor(frame, n) {
    if (!this.ps.get('reimagine.director').value) {
      if (this.directed !== null) { this.directed = null; this.onDirected(null); }
      return { prompt: this.prompt, note: '' };
    }
    const every = Math.max(1, Math.round(this.ps.get('reimagine.directEvery').value));
    const fresh = this.directed === null || n % every === 0;
    if (fresh) {
      // Chained so two in flight never ask the director twice for one step.
      const step = this._dirChain.then(async () => {
        try {
          this.directed = await directReimagine(this.prompt, this._recent.slice(-6), frame);
          this.onDirected(this.directed);
          return '';
        } catch (err) {
          console.warn('[reimagine] director failed:', err);
          return err.message === 'no-key' ? ' · director needs a text AI key (⚙)' : ' · director ✗';
        }
      });
      this._dirChain = step;
      const note = await step;
      return { prompt: this.directed ?? this.prompt, note };
    }
    return { prompt: this.directed, note: '' };
  }

  async run() {
    if (this._inFlight >= this._maxInFlight()) return;
    this._inFlight++;
    this._wait = 0;
    const n = this._sent++;
    const t0 = performance.now();
    this.onStatus(this._inFlight > 1 ? `Reimagining… (${this._inFlight} in flight)` : 'Reimagining…', 'busy');
    try {
      const frame = this.captureFrame(SEND_W, SEND_Q);
      const { prompt, note } = await this._promptFor(frame, n);
      this._recent.push(prompt);
      if (this._recent.length > 12) this._recent.shift();
      const out = await reimagineImage(frame, prompt, this.aspect());
      const slot = this._nextSlot();
      if (this.sb.isProtected?.(slot)) throw new Error(`slot ${slot} is protected`);
      const url = `data:${out.mime};base64,${out.b64}`;
      const ok = await this.sb.importFrame(slot, url);
      if (!ok) throw new Error('the image came back but could not be decoded');
      this.onWrote();
      this.onLanded(slot, url);
      if (this.ps.get('reimagine.follow').value) this._startFade(slot);
      this.onStatus(`→ slot ${slot} · ${((performance.now() - t0) / 1000).toFixed(1)} s${note}`, 'ok');
    } catch (err) {
      this.onStatus(err.message === 'no-key'
        ? '⚠ Needs a Google Gemini key — add it in AI settings (⚙).'
        : `✗ ${err.message}`, 'err');
      // A failing loop must not keep paying for the same failure.
      if (this.ps.get('reimagine.auto').value) this.ps.set('reimagine.auto', 0);
    } finally {
      this._inFlight--;
    }
  }

  _startFade(to) {
    // Mid-fade: wait for it to land rather than jumping back to fs1.
    if (this._fade) { this._queued = to; return; }
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
    if (this._queued !== null) { const q = this._queued; this._queued = null; this._startFade(q); }
  }

  /** Is fs1 showing a real frame? If not, cut straight to the new one. */
  _hasShown() {
    return !!this.sb._hasFrame[Math.round(this.ps.get('buffer.fs1').value)];
  }
}
