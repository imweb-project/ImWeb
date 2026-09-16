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

import { applyControlInput } from '../controls/controlInput.js';

const DEFAULT_URL = 'ws://localhost:8080';
const FLUSH_MS    = 50;
/**
 * Where the last working relay URL is remembered, so the next launch connects
 * by itself. Per origin, like every other localStorage key here: a URL learned
 * on :5173 is invisible on :4173 (the standing trap in CLAUDE.md).
 */
const URL_KEY     = 'imweb.oscUrl';
/**
 * Learn listens for this long after the first message, then binds the address
 * that MOVED — not the first one to arrive.
 *
 * A rig is rarely quiet: a TouchOSC layout streams its accelerometer, a Max
 * patch sends continuously, and "first address wins" would bind whichever
 * stream landed first instead of the control the performer just touched. MIDI
 * learn can get away with first-wins because a MIDI controller says nothing
 * until it is moved.
 */
const LEARN_WINDOW_MS = 1200;
/** Below this, a value is jittering rather than moving. */
const LEARN_MOVE_EPS  = 0.05;

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
    // believed to show, per ADDRESS — not per id, because a page switch or a
    // recall can put a different param behind the same fader, and the param's
    // own last-sent value says nothing about what that fader shows.
    // `_watched`: params already subscribed.
    this._dirty      = new Set();
    this._heard      = new Set();
    this._sentVal    = new Map();
    /**
     * Param ids the remote has addressed by id this session. Feedback goes to
     * what the remote actually talks to — see _feedbackAddress.
     */
    this._addressedById = new Set();
    this._watched    = new WeakSet();
    this._flushTimer = null;
    // Learn: the next address to arrive binds to this param. Held here rather
    // than in ControllerManager because this is where addresses are seen;
    // ctrl.startOSCLearn() is the entry point, so the UI has one door per
    // input the way it does for MIDI.
    this._learn      = null;   // { paramId, onLearned, cands, settleTimer }
    this._learnTimer = null;
    /**
     * How long to listen before deciding WHICH address was meant. Overridable
     * so audits can settle in milliseconds instead of waiting.
     */
    this.learnWindowMs = LEARN_WINDOW_MS;
    this._ctrl       = null;   // ControllerManager, for assign() + badge repaint
  }

  /** Wired in main.js so a learned binding goes through the sanctioned writer. */
  setControllerManager(ctrl) { this._ctrl = ctrl; }

  /**
   * Arm: the next incoming address binds to `paramId`.
   *
   * The message that binds is CONSUMED — it does not also drive the parameter.
   * Pressing a button to learn it should not fire whatever it just landed on.
   */
  startLearn(paramId, onLearned = null) {
    this._learn = { paramId, onLearned, cands: new Map(), settleTimer: null };
    document.getElementById('status-osc')?.classList.add('learning');
    clearTimeout(this._learnTimer);
    // Same 10 s as the one-shot MIDI learn: long enough to reach the button,
    // short enough that a forgotten arm does not silently eat the next message.
    this._learnTimer = setTimeout(() => this.cancelLearn(), 10000);
  }

  cancelLearn() {
    clearTimeout(this._learn?.settleTimer);
    this._learn = null;
    clearTimeout(this._learnTimer);
    document.getElementById('status-osc')?.classList.remove('learning');
  }

  get learning() { return !!this._learn; }

  get active() { return this._active; }

  // ── Connect / Disconnect ──────────────────────────────────────────────────

  connect(url = DEFAULT_URL) {
    this._url = url;
    this._open();
  }

  /** The last URL that actually connected, or null. Also the prompt's default. */
  get savedUrl() {
    try { return localStorage.getItem(URL_KEY); } catch { return null; }
  }

  /**
   * Reconnect to the last working relay, if there was one.
   *
   * Why this exists: "I forgot to turn on OSC" is the most likely way the whole
   * chain fails, and it looks exactly like a broken button — the relay logs the
   * press, the app never hears it. Nothing is dialled until a connection has
   * succeeded once, so a rig that never uses OSC opens no sockets.
   *
   * A relay that is not up yet is fine: `_scheduleRetry` keeps trying every 3 s,
   * so starting ImWeb first and the relay second also works.
   */
  autoConnect() {
    const url = this.savedUrl;
    if (!url) return null;
    console.info(`[OSC] Reconnecting to remembered relay ${url}`);
    this.connect(url);
    return url;
  }

  _remember(url) {
    try { localStorage.setItem(URL_KEY, url); } catch { /* private mode */ }
  }

  _forget() {
    try { localStorage.removeItem(URL_KEY); } catch { /* private mode */ }
  }

  disconnect() {
    clearTimeout(this._retryTimer);
    clearInterval(this._flushTimer);
    this._dirty.clear();
    // Deliberate: turning OSC off should STAY off across launches. A dropped
    // connection is not this path and must not forget — the relay being
    // restarted is the common case, and forgetting there would quietly undo
    // auto-connect for good.
    this._forget();
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
   * Where a parameter's feedback goes, or null for silence.
   *
   * Feedback used to be every changing parameter, sent as `/imweb/<id>`. On a
   * patch with LFOs running that measured **70–90 messages a second** at a Flic,
   * which has nothing to display and never asked. So: only what the remote
   * actually talks to.
   *
   *  - a learned binding gets ITS OWN address, because that is what the control
   *    listens on — a TouchOSC fader at /1/fader1 tracks /1/fader1, not
   *    /imweb/blend.amount;
   *  - a param the remote has driven by id gets `/imweb/<id>` back;
   *  - anything else is silent.
   *
   * The consequence worth knowing: a display-only widget that never sends
   * anything is never heard from, so it gets nothing. Touch it once, or learn
   * it, and it starts tracking.
   */
  _feedbackAddress(p) {
    const c = p.controller;
    if (c?.type === 'osc' && c.address) return c.address;
    if (this._addressedById.has(p.id)) return `/imweb/${p.id}`;
    return null;
  }

  /**
   * Queue a param for feedback although its VALUE has not changed.
   *
   * Feedback rides on `onChange`, and a binding can move without the value
   * moving: a page switch puts another param behind a fader, a recall restores
   * an address. The remote then shows the last page's position until something
   * happens to change. Called from `ControllerManager.assign()` for every OSC
   * binding it projects, so every door that rebinds — page switch, learn, state
   * recall, bank load — tells the remote where to be. Unchanged addresses are
   * still suppressed at flush, so this costs nothing where nothing moved.
   */
  markDirty(p) {
    if (this._active && p && p.type !== 'trigger') this._dirty.add(p);
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
      const address = this._feedbackAddress(p);
      if (!address) continue;
      const n = p.normalized;
      if (this._heard.has(p.id)) { this._sentVal.set(address, n); continue; }
      if (this._sentVal.get(address) === n) continue;
      this._sentVal.set(address, n);
      this.send(address, n);
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
      // Remembered only once it actually OPENED: a typo in the prompt must not
      // become the address every future launch dials.
      this._remember(this._url);
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
    // A button is not a fader. A momentary button sends 1 then 0, and acting
    // on both fired a trigger twice per press — the same bug audit-midi-buttons
    // pins for MIDI CC. No value at all (a bare Flic click) is a press.
    const isPress = !args.length || Number(args[0]) > 0.5;

    // Whatever this address showed, the control has moved since: forget it, so
    // the next flush tells it where to be. This matters when NOTHING is bound
    // here — a fader moved on a page where it drives nothing is otherwise
    // believed to still show the value sent before, and the send on switching
    // back is suppressed as a repeat.
    this._sentVal.delete(address);

    // Learn WATCHES rather than grabbing: it notes each address and decides at
    // the end of the window. Dispatch continues underneath, so arming learn
    // does not freeze controls that are already mapped.
    if (this._learn) this._observeLearn(address, args);

    // Learned bindings answer to ANY address, so a Flic can keep whatever it
    // already sends. Checked before the /imweb/ paths below, and independently
    // of them: an address is matched by value, not parsed.
    this._driveLearned(address, args, isPress);

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
      const id = rest.slice(7);
      if (isPress) this.ps.get(id)?.toggle();
      this._addressedById.add(id); // it asked about this param — it may want the state back
      return;
    }

    // /imweb/<paramId>  [value]
    const p = this.ps.get(rest);
    if (!p) return;
    this._heard.add(p.id);         // not echoed back this flush — see _flush
    this._addressedById.add(p.id); // but it does get LATER changes — _feedbackAddress

    const val = typeof args[0] === 'number' ? args[0] : parseFloat(args[0]);
    if (!isNaN(val)) {
      if (p.type === 'toggle')  p.value = val > 0.5 ? 1 : 0;
      else if (p.type === 'trigger') { if (isPress) p.trigger(); }
      else p.setNormalized(Math.max(0, Math.min(1, val)));
    }
  }

  /**
   * Note one address seen while learning. Never binds — `_settleLearn` does,
   * once the window closes.
   */
  _observeLearn(address, args) {
    // ImWeb's own feedback vocabulary is not learnable: those addresses already
    // work by id, and a device echoing our feedback would otherwise compete.
    if (address.startsWith('/imweb/')) return;
    const c = this._learn.cands.get(address)
      ?? { min: Infinity, max: -Infinity, count: 0 };
    const v = args.length ? Number(args[0]) : 1;
    if (Number.isFinite(v)) { c.min = Math.min(c.min, v); c.max = Math.max(c.max, v); }
    c.count++;
    this._learn.cands.set(address, c);
    this._learn.settleTimer ??= setTimeout(() => this._settleLearn(), this.learnWindowMs);
  }

  /**
   * Decide which address was meant, and bind it.
   *
   * Movement first: a fader swept across its range beats anything jittering in
   * place. When nothing moved — which is the normal case for a button, since a
   * Flic sends the same value every press — the tie goes to the address that
   * spoke LEAST, so one press beats a stream running at 60 a second.
   */
  _settleLearn() {
    if (!this._learn) return;
    let best = null;
    for (const [address, c] of this._learn.cands) {
      const move  = c.max > c.min ? c.max - c.min : 0;
      const score = move >= LEARN_MOVE_EPS ? move : 0;
      if (!best
        || score > best.score
        || (score === best.score && c.count < best.count)) {
        best = { address, score, count: c.count };
      }
    }
    if (best) this._bindLearned(best.address);
    else this.cancelLearn();
  }

  /** Bind the armed param to `address`, through ControllerManager when wired. */
  _bindLearned(address) {
    const { paramId, onLearned } = this._learn;
    clearTimeout(this._learn.settleTimer);
    const cfg = { type: 'osc', address };
    // setPageBinding() is the sanctioned writer: it puts the binding in the
    // CURRENT mapping page and projects it live through assign(), which clears
    // any previous controller and refuses setup acts. Learning through assign()
    // alone would bind the remote to the page you are on and to every other
    // page at once — and the next page switch would then erase it, because the
    // projection would find no entry to project.
    // Without a manager (audits, headless) write directly.
    if (this._ctrl) this._ctrl.setPageBinding(paramId, cfg);
    else { const p = this.ps.get(paramId); if (p) p.controller = cfg; }
    this._ctrl?._repaintCtrlBadge?.(paramId);
    // Send the current value once, so a fader that just bound jumps to where
    // the parameter actually is instead of showing whatever it last displayed.
    const p = this.ps.get(paramId);
    if (p && p.type !== 'trigger') this._dirty.add(p);
    console.info(`[OSC] Learned ${address} → ${paramId}`);
    this.cancelLearn();
    onLearned?.(address);
  }

  /**
   * Drive every parameter bound to this address.
   *
   * Same button rules as everywhere else: a toggle flips on the press, a
   * trigger fires on the press, and anything continuous follows the value —
   * so a Flic, which sends no argument at all, reads as a press each time.
   */
  _driveLearned(address, args, isPress) {
    this.ps.getAll().forEach(p => {
      const c = p.controller;
      if (c?.type !== 'osc' || c.address !== address) return;
      this._heard.add(p.id); // not echoed back this flush — see _flush
      const val = typeof args[0] === 'number' ? args[0] : parseFloat(args[0]);
      /**
       * No pickup here, deliberately — `setMapPage` never arms an OSC binding,
       * so a gate on this path would be inert, and an inert gate reads as
       * coverage it does not have.
       *
       * The reason is in `setMapPage`: an address cannot say whether the far
       * end is a fader or a button, and a press-only remote armed for soft
       * takeover can never cross the parameter's value, so it goes silently
       * dead. That was measured on the owner's rig before this comment existed.
       */
      // A bare press carries no value: read it as full scale, which is what
      // makes a button usable on a continuous param at all. The press rule
      // itself is shared with MIDI, the keyboard and the gamepad.
      applyControlInput(p, { norm: isNaN(val) ? 1 : val, isPress });
    });
  }

  _updateIndicator(on) {
    const el = document.getElementById('status-osc');
    el?.classList.toggle('active', on);
  }
}
