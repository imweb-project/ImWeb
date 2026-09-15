/**
 * ImWeb OSC Bridge
 *
 * Connects to a local WebSocket-to-OSC relay server (e.g. osc-relay, node-osc).
 * Default: ws://localhost:8080
 *
 * Incoming OSC messages are mapped to parameters by address:
 *   /imweb/<paramId>   value  →  param.setNormalized(value)  (a toggle: >0.5 on)
 *   /imweb/toggle/<id>        →  flip a toggle on the press, ignore the release
 *   /imweb/trigger/<id>       →  param.trigger() on the press, ignore the release
 *   /imweb/preset/<n>         →  presetMgr.loadPreset(n)
 * A press is a message with no value or a value above 0.5.
 *
 * Outgoing: parameter changes are batched every FLUSH_MS and sent as
 *   /imweb/<paramId>   value(normalized)
 * one message per parameter at its latest value — see _flush.
 *
 * The relay server format is simple JSON over WebSocket:
 *   { address: "/imweb/foo", args: [0.5] }
 */

const DEFAULT_URL = 'ws://localhost:8080';
const FLUSH_MS    = 50;

export class OSCBridge {
  constructor(ps, presetMgr) {
    this.ps        = ps;
    this.presets   = presetMgr;
    this._ws       = null;
    this._url      = DEFAULT_URL;
    this._active   = false;
    this._retryTimer = null;
    // Feedback. `_dirty`: params changed since the last flush. `_heard`: ids the
    // remote set in that same window. `_sentVal`: the value the remote is
    // believed to show, per id. `_watched`: params already subscribed.
    this._dirty      = new Set();
    this._heard      = new Set();
    this._sentVal    = new Map();
    this._watched    = new WeakSet();
    this._flushTimer = null;
  }

  get active() { return this._active; }

  // ── Connect / Disconnect ──────────────────────────────────────────────────

  connect(url = DEFAULT_URL) {
    this._url = url;
    this._open();
  }

  disconnect() {
    clearTimeout(this._retryTimer);
    clearInterval(this._flushTimer);
    this._dirty.clear();
    if (this._ws) {
      this._ws.onclose = null; // suppress auto-reconnect
      this._ws.close();
      this._ws = null;
    }
    this._active = false;
    this._updateIndicator(false);
  }

  // ── Send outgoing ─────────────────────────────────────────────────────────

  send(address, ...args) {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;
    try {
      this._ws.send(JSON.stringify({ address, args }));
    } catch { /* ignore */ }
  }

  sendParam(param) {
    this.send(`/imweb/${param.id}`, param.normalized);
  }

  /**
   * Subscribe to every parameter not yet watched. Runs on each connect, not
   * once in the constructor, so params registered after boot are covered. The
   * listener only records WHICH param changed; the value is read at flush.
   * Triggers are skipped: they have no state for a remote to show.
   */
  _watchParams() {
    this.ps.getAll().forEach(p => {
      if (this._watched.has(p) || p.type === 'trigger') return;
      this._watched.add(p);
      p.onChange(() => { if (this._active) this._dirty.add(p); });
    });
  }

  /**
   * Send each param changed since the last flush, once, at its latest value.
   *
   * This was documented and never wired: `sendParam` had no callers, so a
   * TouchOSC layout never followed a state recall. Batching is what makes it
   * affordable — an LFO fires onChange every frame, and a recall changes
   * hundreds of params at once.
   *
   * A param the remote set during this window is NOT sent back: echoing a
   * fader's own value (or its table-shaped result) would fight the finger on
   * it. That holds for this window only, so a later local change is sent.
   */
  _flush() {
    if (!this._active || this._ws?.readyState !== WebSocket.OPEN) {
      this._dirty.clear();
      this._heard.clear();
      return;
    }
    for (const p of this._dirty) {
      const n = p.normalized;
      if (this._heard.has(p.id)) { this._sentVal.set(p.id, n); continue; }
      if (this._sentVal.get(p.id) === n) continue;
      this._sentVal.set(p.id, n);
      this.send(`/imweb/${p.id}`, n);
    }
    this._dirty.clear();
    this._heard.clear();
  }

  // ── Private ───────────────────────────────────────────────────────────────

  _open() {
    if (this._ws) { this._ws.onclose = null; this._ws.close(); }

    try {
      this._ws = new WebSocket(this._url);
    } catch (err) {
      console.warn('[OSC] WebSocket open failed:', err.message);
      this._scheduleRetry();
      return;
    }

    this._ws.onopen = () => {
      console.info(`[OSC] Connected to ${this._url}`);
      this._active = true;
      this._updateIndicator(true);
      // A new connection may be a different device: assume it shows nothing.
      this._sentVal.clear();
      this._watchParams();
      clearInterval(this._flushTimer);
      this._flushTimer = setInterval(() => this._flush(), FLUSH_MS);
    };

    this._ws.onclose = () => {
      this._active = false;
      clearInterval(this._flushTimer);
      this._dirty.clear();
      this._updateIndicator(false);
      this._scheduleRetry();
    };

    this._ws.onerror = () => { /* handled by onclose */ };

    this._ws.onmessage = e => {
      try {
        const msg = JSON.parse(e.data);
        this._dispatch(msg.address, msg.args ?? []);
      } catch { /* ignore malformed */ }
    };
  }

  _scheduleRetry() {
    clearTimeout(this._retryTimer);
    this._retryTimer = setTimeout(() => this._open(), 3000);
  }

  _dispatch(address, args) {
    // /imweb/<paramId>  [value 0-1]
    const m = address.match(/^\/imweb\/(.+)$/);
    if (!m) return;

    const rest = m[1];

    // /imweb/preset/<n>
    if (rest.startsWith('preset/')) {
      const n = parseInt(rest.split('/')[1]);
      if (!isNaN(n)) this.presets?.loadPreset(n);
      return;
    }

    // A button is not a fader. A momentary button sends 1 then 0, and acting
    // on both fired a trigger twice per press — the same bug audit-midi-buttons
    // pins for MIDI CC. No value at all (a bare Flic click) is a press.
    const isPress = !args.length || Number(args[0]) > 0.5;

    // /imweb/trigger/<id>
    if (rest.startsWith('trigger/')) {
      if (isPress) this.ps.trigger(rest.slice(8));
      return;
    }

    // /imweb/toggle/<id> — FLIPS on the press. /imweb/<id> below stays
    // absolute, which is right for a widget that sends the state it shows and
    // useless for a button that sends the same "pressed" every time: a Flic
    // could turn a toggle on and never off.
    if (rest.startsWith('toggle/')) {
      if (isPress) this.ps.get(rest.slice(7))?.toggle();
      return;
    }

    // /imweb/<paramId>  [value]
    const p = this.ps.get(rest);
    if (!p) return;
    this._heard.add(p.id); // not echoed back this flush — see _flush

    const val = typeof args[0] === 'number' ? args[0] : parseFloat(args[0]);
    if (!isNaN(val)) {
      if (p.type === 'toggle')  p.value = val > 0.5 ? 1 : 0;
      else if (p.type === 'trigger') { if (isPress) p.trigger(); }
      else p.setNormalized(Math.max(0, Math.min(1, val)));
    }
  }

  _updateIndicator(on) {
    const el = document.getElementById('status-osc');
    el?.classList.toggle('active', on);
  }
}
