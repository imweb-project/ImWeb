/**
 * ImWeb Window — visitor mode for a shop-window installation.
 *
 * Connects to the window-kiosk server (window-kiosk/ in this repo) over a
 * WebSocket and serves its queue, one visitor at a time:
 *
 *   job arrives → "Green · Anna — stand on the mark" → 3, 2, 1 → ONE camera
 *   frame → three Reimagine runs, one per visitor instruction, each fading in
 *   on the window as usual → each picture sent back (JPEG ≤1024 px) → thanks.
 *
 * One capture for all three: the visitor can step away after the countdown.
 * Reimagine's own Auto loop is paused for the visit and restored after, so
 * between visitors the window can keep drifting as its attract mode.
 *
 * The overlay is a DOM layer, drawn on the main page AND in the second-screen
 * Output window when one is open: that window only receives finished frames
 * as bitmaps, so nothing drawn over the main page reaches it by itself. Its
 * CSS lives here, not in style.css, because the Output window doesn't load
 * style.css and one definition has to serve both documents.
 */

const OVERLAY_ID = 'window-visitor-overlay';
const STYLE_ID = 'window-visitor-style';
const OVERLAY_CSS = `
#${OVERLAY_ID} {
  position: fixed; inset: 0; z-index: 100000; pointer-events: none;
  display: flex; align-items: center; justify-content: center;
}
#${OVERLAY_ID}[hidden] { display: none; }
#${OVERLAY_ID}.wvo-low { align-items: flex-end; padding-bottom: 6vh; }
.wvo-card {
  display: flex; align-items: center; gap: 2.2vw; max-width: 80vw;
  background: rgba(0, 0, 0, 0.62); color: #fff; border-radius: 2vw;
  padding: 2.4vw 3.4vw; font-family: "IBM Plex Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
.wvo-dot { width: 5vw; height: 5vw; border-radius: 50%; flex: none; }
.wvo-big { font-size: 4.4vw; font-weight: 700; line-height: 1.1; }
.wvo-small { font-size: 2vw; opacity: 0.85; margin-top: 0.6vw; }
.wvo-low .wvo-dot { width: 2.6vw; height: 2.6vw; }
.wvo-low .wvo-big { font-size: 2.6vw; }
.wvo-low .wvo-small { font-size: 1.6vw; }
.wvo-huge .wvo-big { font-size: 22vw; }
.wvo-huge .wvo-dot { width: 9vw; height: 9vw; }
.wvo-flash {
  position: fixed; inset: 0; z-index: 100001; background: #fff; pointer-events: none;
  animation: wvo-flash 0.45s ease-out forwards;
}
@keyframes wvo-flash { from { opacity: 0.9; } to { opacity: 0; } }
`;

const RETRY_MS = 5000;
const PING_MS = 30000;
const B64_MAX = 900_000;   // under the server's limit with room to spare

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export class WindowVisitor {
  /**
   * @param {object} o
   * @param {import('./Reimagine.js').Reimagine} o.reimagine
   * @param {import('../controls/ParameterSystem.js').ParameterSystem} o.ps
   * @param {(msg:string, kind?:'ok'|'busy'|'err') => void} o.onStatus
   * @param {() => (Document|null)} [o.outputDoc]  the second-screen window's document, if open
   */
  constructor({ reimagine, ps, onStatus, outputDoc }) {
    this.r = reimagine;
    this.ps = ps;
    this.onStatus = onStatus ?? (() => {});
    this.outputDoc = outputDoc ?? (() => null);
    this.url = '';
    this.ws = null;
    this.current = null;     // the job id being served, or null
    this._want = false;      // should we be connected?
    this._retry = null;
    this._ping = null;
  }

  connect(url) {
    this.disconnect();
    this.url = url;
    this._want = true;
    this._open();
  }

  disconnect() {
    this._want = false;
    clearTimeout(this._retry);
    clearInterval(this._ping);
    if (this.ws) { try { this.ws.close(); } catch { /* gone */ } }
    this.ws = null;
    if (!this.current) this.onStatus('Off');
  }

  _open() {
    let ws;
    try { ws = new WebSocket(this.url); } catch (err) {
      this.onStatus(`✗ ${err.message}`, 'err');
      return;
    }
    this.ws = ws;
    this.onStatus('Connecting…', 'busy');
    ws.onopen = () => {
      this.onStatus(this.current ? 'Connected · serving a visitor' : 'Connected · waiting for visitors', 'ok');
      this._send({ type: 'hello', current: this.current });
      if (!this.current) this._send({ type: 'ready' });
      clearInterval(this._ping);
      this._ping = setInterval(() => { if (ws.readyState === 1) ws.send('ping'); }, PING_MS);
    };
    ws.onmessage = (e) => {
      if (e.data === 'pong') return;
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.type === 'job' && !this.current) this._serve(msg);
    };
    ws.onclose = (e) => {
      clearInterval(this._ping);
      if (this.ws === ws) this.ws = null;
      if (e.code === 4000) { this._want = false; this.onStatus('Replaced by another window', 'err'); return; }
      if (!this._want) return;
      this.onStatus(`Disconnected (${e.code}) · retrying…`, 'err');
      this._retry = setTimeout(() => this._want && this._open(), RETRY_MS);
    };
  }

  _send(obj) {
    if (this.ws?.readyState === 1) { this.ws.send(JSON.stringify(obj)); return true; }
    return false;
  }

  async _serve(job) {
    this.current = job.id;
    const ps = this.ps;
    const label = job.name ? `${job.colour[0]} · ${job.name}` : job.colour[0];
    const hex = job.colour[1];
    const was = { auto: ps.get('reimagine.auto').value, follow: ps.get('reimagine.follow').value };
    let error = null;
    this.onStatus(`Serving ${label}`, 'busy');
    try {
      // Pause the attract loop and let any request in flight land first.
      if (was.auto) ps.set('reimagine.auto', 0);
      for (let t = 0; this.r.busy && t < 600; t++) await wait(100);
      ps.set('reimagine.follow', 1);

      this._send({ type: 'state', id: job.id, state: 'up' });
      this._show(hex, label, 'Stand on the mark and look at the window');
      await wait(6000);

      this._send({ type: 'state', id: job.id, state: 'countdown' });
      for (const n of ['3', '2', '1']) { this._show(hex, n, label, true); await wait(1000); }

      let frame;
      // The visitor sees this message: say it in their terms ("camera is off"),
      // the panel's status line keeps the technical one via console.
      try { frame = this.r.captureFrame(1024, 0.85, 1); } catch (err) {
        console.warn('[window] capture:', err.message);
        throw new Error('the window camera is off');
      }
      if (!frame) throw new Error('the camera gave no picture');
      this._flash();
      this._send({ type: 'state', id: job.id, state: 'working' });

      for (let i = 0; i < 3; i++) {
        this._show(hex, label, `${i + 1} / 3 · “${job.prompts[i]}”`, false, true);
        const url = await this.r.run({ frame, prompt: job.prompts[i] });
        if (!url) throw new Error(this.r.lastError || 'the AI gave no picture');
        const b64 = await toJpegB64(url);
        if (!this._send({ type: 'result', id: job.id, n: i, b64 })) {
          throw new Error('lost the connection while sending a picture');
        }
      }
      this._show(hex, `Thank you, ${job.name || job.colour[0]}`, 'Your pictures are on your phone', false, true);
      await wait(5000);
    } catch (err) {
      error = err.message || String(err);
      console.warn('[window] visit failed:', err);
      this._show('#ff4a3d', 'Sorry — something went wrong', error, false, true);
      await wait(4000);
    } finally {
      this._hide();
      ps.set('reimagine.follow', was.follow);
      if (was.auto) ps.set('reimagine.auto', 1);
      this._send({ type: 'finished', id: job.id, error });
      this.current = null;
      this.onStatus(error ? `Last visit failed: ${error}` : 'Connected · waiting for visitors', error ? 'err' : 'ok');
      this._send({ type: 'ready' });
    }
  }

  // ── overlay ──────────────────────────────────────────────────────────────
  /** Every document the overlay should appear in, right now. */
  _docs() {
    const docs = [document];
    try {
      const out = this.outputDoc();
      if (out?.body) docs.push(out);
    } catch { /* the Output window closed under us */ }
    return docs;
  }

  /** The overlay in `doc`, built on first use. Looked up each time, so an
   *  Output window opened mid-visit joins at the next line, and a closed one
   *  leaves nothing behind to keep a reference to. */
  _el(doc) {
    if (!doc.getElementById(STYLE_ID)) {
      const st = doc.createElement('style');
      st.id = STYLE_ID;
      st.textContent = OVERLAY_CSS;
      doc.head.append(st);
    }
    let el = doc.getElementById(OVERLAY_ID);
    if (!el) {
      el = doc.createElement('div');
      el.id = OVERLAY_ID;
      el.innerHTML = '<div class="wvo-card"><div class="wvo-dot"></div><div><div class="wvo-big"></div><div class="wvo-small"></div></div></div>';
      doc.body.append(el);
    }
    return el;
  }

  /** big: headline; small: second line; huge: countdown digits; low: tuck it at the bottom. */
  _show(hex, big, small, huge = false, low = false) {
    for (const doc of this._docs()) {
      const el = this._el(doc);
      el.hidden = false;
      el.classList.toggle('wvo-huge', huge);
      el.classList.toggle('wvo-low', low);
      el.querySelector('.wvo-dot').style.background = hex;
      el.querySelector('.wvo-big').textContent = big;
      el.querySelector('.wvo-small').textContent = small ?? '';
    }
  }

  _hide() {
    for (const doc of this._docs()) {
      const el = doc.getElementById(OVERLAY_ID);
      if (el) el.hidden = true;
    }
  }

  _flash() {
    for (const doc of this._docs()) {
      this._el(doc); // brings the stylesheet
      const f = doc.createElement('div');
      f.className = 'wvo-flash';
      doc.body.append(f);
      setTimeout(() => f.remove(), 450);
    }
  }
}

/** Re-encode a landed image as a JPEG of at most 1024 px, base64 without the prefix. */
async function toJpegB64(url) {
  const img = new Image();
  img.src = url;
  await img.decode();
  const s = Math.min(1, 1024 / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement('canvas');
  c.width = Math.round(img.naturalWidth * s);
  c.height = Math.round(img.naturalHeight * s);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  for (const q of [0.85, 0.7, 0.55]) {
    const d = c.toDataURL('image/jpeg', q);
    const b64 = d.slice(d.indexOf(',') + 1);
    if (b64.length <= B64_MAX) return b64;
  }
  throw new Error('a picture came back too large to send');
}
