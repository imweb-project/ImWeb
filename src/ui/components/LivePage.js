/**
 * Live page — one pane holding only what is in play right now.
 *
 * It is a VIEW, not a mode: every row is an ordinary buildParamRow() bound to
 * the same Parameter as its home row in Sources / Mix / Effects / Output, so
 * the two can never disagree.
 *
 * THREE PARTS, top to bottom:
 *   Layers  — the three routing selectors, always.
 *   Recent  — the last RECENT_MAX controls a hand moved (touch detection is
 *             the OSD's — FeedbackOverlay.onTouch — not a second copy).
 *             Newest on top. Touching one that is already there does NOT move
 *             it: a row must never jump while it is being played. When a ninth
 *             arrives, the one touched longest ago leaves. It survives a state
 *             recall — it is a record of your hands, not of the patch.
 *   Driven  — every param with a controller, under its home section, by one
 *             rule (inPlay() below): it has a controller, it does not belong
 *             to a source that nothing routes, and its own on-switch
 *             (`<prefix>.active|enable|enabled|on`) is not off.
 * A param is in ONE part only: Layers and Driven win over Recent.
 * Triggers never qualify: they hold no state.
 *
 * ORDER of Driven is the document order of the home rows, so it reads top to
 * bottom exactly as the tabs do, and a row always appears in the same place.
 * Rows are added and removed in place — never rebuilt — so a drag in progress
 * survives a refresh. A row that stops qualifying lingers for LINGER_MS: a
 * value dragged through its default must not vanish under the hand.
 */
import { PARAM_TYPE, SOURCE_KEYS } from '../../controls/ParameterSystem.js';
import { buildParamRow } from './ParamRow.js';

const REFRESH_MS = 250;
const LINGER_MS  = 8000;
const REINDEX_MS = 2000;
const RECENT_MAX = 8;

/** The routing itself — always shown, it is the first thing to reach for. */
const ALWAYS = ['layer.fg', 'layer.bg', 'layer.ds'];

/**
 * Which source(s) a param belongs to, by id prefix. A prefix that IS a source
 * key needs no entry; this lists only the ones that differ, and the sources
 * with a second output (depth) that keeps the same panel alive.
 * A prefix found in neither is simply not gated — it shows whenever it is off
 * its default, which errs toward showing too much, never toward hiding.
 * `td` is deliberately absent: Time Displace is gated by td.enabled instead.
 */
const PREFIX_SOURCES = {
  particle: ['particles'], vol: ['volume'], color1: ['color'],
  palette: ['color', 'color2'], vectorscope: ['scope'],
  scene3d: ['scene3d', 'depth3d'], hypercube: ['scene3d', 'depth3d'],
  model2: ['scene3d', 'depth3d'], model3: ['scene3d', 'depth3d'],
  model4: ['scene3d', 'depth3d'],
  sdf: ['sdf', 'sdfdepth'], teletext: ['analog'],
  drawloop1: ['draw'], drawloop2: ['draw'], drawloop3: ['draw'], drawloop4: ['draw'],
  buffer: ['buffer', 'aidepth', 'splat'], reimagine: ['buffer', 'aidepth', 'splat'],
};
const sourcesOf = (id) => {
  const pre = id.split('.')[0];
  const keys = PREFIX_SOURCES[pre] ?? (SOURCE_KEYS.includes(pre) ? [pre] : []);
  return keys.map(k => SOURCE_KEYS.indexOf(k)).filter(i => i >= 0);
};

const PANE_LABEL = {
  'tab-sources': 'Sources', 'tab-mix': 'Mix', 'tab-effects': 'Effects',
  'tab-output': 'Output', 'tab-audio': 'Audio', 'tab-presets': 'Project',
  'tab-scene3d': '3D', 'tab-analog': 'Analog', 'tab-draw': 'Draw',
};

export class LivePage {
  constructor(ps, contextMenu) {
    this.ps = ps;
    this.contextMenu = contextMenu;
    this.el = document.getElementById('tab-live');
    this._home = new Map();      // paramId → { key, pane, title, order, srcIdx[] }
    this._indexedAt = 0;
    this._rows = new Map();      // paramId → { row, sectionKey }
    this._sections = new Map();  // sectionKey → { el, body, order }
    this._lastSeen = new Map();  // paramId → ms it last qualified
    this._used = null;           // per-source booleans from the render loop
    this._usedAt = -Infinity;
    this._shownAt = 0;
    this._pointerDown = false;
    this._recent = [];           // { id, t } — newest first, never reordered
    this._recentRows = new Map(); // paramId → row
    // Wide layout (main.js sets this): while it returns true, a home section
    // is opened at the moment something in it comes into play.
    this.isWide = () => false;
    this._openFor = new Set();   // section elements already opened this spell
    if (!this.el) return;

    this._empty = document.createElement('div');
    this._empty.className = 'live-empty';
    this._empty.textContent =
      'Move a control or assign a controller, and it appears here.';
    this.el.appendChild(this._empty);

    // The Recent section is built once and sits right under Layers.
    this._recentEl = document.createElement('div');
    this._recentEl.className = 'live-section live-recent';
    const rh = document.createElement('div');
    rh.className = 'live-header';
    const clear = document.createElement('span');
    clear.className = 'live-where live-clear';
    clear.textContent = 'clear';
    rh.append('Recent', clear);
    rh.title = 'The last eight controls you moved — click to clear';
    rh.addEventListener('click', () => { this._recent = []; this._syncRecent(); });
    this._recentBody = document.createElement('div');
    this._recentEl.append(rh, this._recentBody);
    this._recentEl.style.display = 'none';
    this.el.insertBefore(this._recentEl, this._empty);

    // Never pull a row out from under a hand.
    this.el.addEventListener('pointerdown', () => { this._pointerDown = true; }, true);
    const up = () => { this._pointerDown = false; };
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', up, true);

    setInterval(() => this.refresh(), REFRESH_MS);
  }

  get visible() {
    // Rendered, not "is the active tab": the wide layout shows this pane by a
    // CSS rule while another tab holds the active class.
    return !!this.el && this.el.offsetParent !== null;
  }

  /** The render loop asks before computing usage, so a hidden page costs nothing. */
  wantsUsage(now) {
    return (this.visible || this.isWide()) && now - this._usedAt > REFRESH_MS;
  }

  /** A hand moved this (FeedbackOverlay.onTouch). */
  touch(id) {
    const p = this.ps.get(id);
    if (!p || p.type === PARAM_TYPE.TRIGGER || id.startsWith('strip.')) return;
    const now = performance.now();
    const hit = this._recent.find(r => r.id === id);
    if (hit) { hit.t = now; return; }       // refresh its age, keep its place
    this._recent.unshift({ id, t: now });
    // Trim here as well as in _syncRecent: touches arrive whether or not the
    // page is showing, and the sync only runs while it is.
    if (!this._pointerDown) this._trimRecent();
  }

  _trimRecent() {
    while (this._recent.length > RECENT_MAX) {
      const oldest = this._recent.reduce((a, b) => (b.t < a.t ? b : a));
      this._recent.splice(this._recent.indexOf(oldest), 1);
    }
  }

  _hasCtrl(p) { return !!p.controller && p.controller.type !== 'none'; }

  /**
   * Bring the Recent rows in line with the stack. Entries shown elsewhere on
   * the page (Layers, or anything that has since gained a controller) are
   * dropped; past RECENT_MAX the one touched longest ago goes. Nothing is
   * removed while the pointer is down in the page.
   */
  _syncRecent() {
    if (!this._pointerDown) {
      this._recent = this._recent.filter(r => {
        const p = this.ps.get(r.id);
        return p && !ALWAYS.includes(r.id) && !this._hasCtrl(p);
      });
      this._trimRecent();
      const keep = new Set(this._recent.map(r => r.id));
      for (const [id, row] of [...this._recentRows]) {
        if (keep.has(id)) continue;
        row._psUnsub?.();
        row.remove();
        this._recentRows.delete(id);
      }
    }
    // New entries are only ever added at the front, so walking the stack from
    // the back and prepending leaves the rows in stack order.
    for (let i = this._recent.length - 1; i >= 0; i--) {
      const { id } = this._recent[i];
      if (this._recentRows.has(id) || this._rows.has(id)) continue;
      const row = buildParamRow(this.ps.get(id), this.contextMenu);
      this._recentBody.prepend(row);
      this._recentRows.set(id, row);
    }
    this._recentEl.style.display = this._recentRows.size ? '' : 'none';
  }

  /** @param {boolean[]} used indexed like SOURCE_DEFS */
  setUsage(used, now) {
    this._used = used;
    this._usedAt = now;
  }

  // ── Home index: where each param lives in the ordinary tabs ────────────────

  _reindex(now) {
    this._indexedAt = now;
    this._home.clear();
    const rows = document.querySelectorAll(
      '.tab-content:not(#tab-live) .param-row[data-param-id]');
    let order = 0;
    rows.forEach(row => {
      const id = row.dataset.paramId;
      if (this._home.has(id)) return;
      const paneEl = row.closest('.tab-content');
      const pane = paneEl?.id ?? '';
      // Own text nodes only — headers carry buttons (↗) whose glyphs are not
      // part of the name.
      const head = row.closest('.panel-section')?.querySelector('.section-header');
      const title = [...(head?.childNodes ?? [])].filter(n => n.nodeType === 3)
        .map(n => n.textContent).join('').trim() || 'Other';
      // The routing rows lead the page, whatever tab they live in.
      const o = ALWAYS.includes(id) ? ALWAYS.indexOf(id) - ALWAYS.length : order++;
      this._home.set(id, { key: `${pane}|${title}`, pane, title, order: o,
        srcIdx: sourcesOf(id), section: row.closest('.panel-section') });
    });
  }

  // ── The rule ───────────────────────────────────────────────────────────────

  _switchOff(p) {
    const pre = p.id.split('.')[0];
    for (const s of ['active', 'enable', 'enabled', 'on']) {
      const sw = this.ps.get(`${pre}.${s}`);
      if (sw && sw.type === PARAM_TYPE.TOGGLE && sw !== p) {
        return !sw.value && !sw.controller;
      }
    }
    return false;
  }

  inPlay(p, home) {
    if (p.type === PARAM_TYPE.TRIGGER) return false;
    if (!this._hasCtrl(p)) return false;
    if (home.srcIdx.length && this._used && !home.srcIdx.some(i => this._used[i])) return false;
    if (this._switchOff(p)) return false;
    return true;
  }

  // ── Refresh: diff the wanted set against the rows that exist ───────────────

  refresh() {
    const visible = this.visible;
    const wide = this.isWide();
    if (!wide) this._openFor.clear();
    if (!visible && !wide) { this._shownAt = 0; return; }
    const now = performance.now();
    // On showing the tab, wait (up to a second) for the render loop's fresh
    // usage before the first diff. Without it every unrouted source's rows
    // qualify once, and then linger for LINGER_MS — eight seconds of noise on
    // every visit. The wait is bounded so a stalled loop cannot blank the page.
    if (!this._shownAt) this._shownAt = now;
    if (now - this._usedAt > 1000 && now - this._shownAt < 1000) return;
    if (!this._home.size) this._reindex(now);

    const want = new Set();
    let missed = false;
    for (const id of ALWAYS) if (this.ps.get(id)) want.add(id);
    for (const p of this.ps.getAll()) {
      if (p.id.startsWith('strip.')) continue; // inlets: no row, never listed
      const home = this._home.get(p.id);
      if (!home) {
        // No home row — only worth a re-index if it would otherwise qualify.
        if (p.controller && p.type !== PARAM_TYPE.TRIGGER) missed = true;
        continue;
      }
      if (this.inPlay(p, home)) { want.add(p.id); this._lastSeen.set(p.id, now); }
    }
    // Panels injected after load (I/O, Hypercube) are not in the first index.
    if (missed && now - this._indexedAt > REINDEX_MS) this._reindex(now);

    // A touched control opens its home section in the wide layout too.
    if (wide) this._openSections(new Set([...want, ...this._recent.map(r => r.id)]));
    if (!visible) return;

    for (const id of want) if (!this._rows.has(id)) this._add(id);
    if (!this._pointerDown) {
      for (const id of [...this._rows.keys()]) {
        if (want.has(id)) continue;
        if (now - (this._lastSeen.get(id) ?? 0) < LINGER_MS) continue;
        this._remove(id);
      }
    }
    this._syncRecent();
    this._empty.style.display =
      this._rows.size > ALWAYS.length || this._recentRows.size ? 'none' : '';
  }

  /**
   * Wide layout: open the home section of anything in play.
   *
   * Opened ONCE per spell — when the section first has something in play, or
   * when the wide layout is entered — and never closed here. So a section you
   * close by hand stays closed until it has left play and come back, and
   * nothing folds away under a hand.
   */
  _openSections(want) {
    const now = new Set();
    for (const id of want) {
      const sec = this._home.get(id)?.section;
      if (sec?.isConnected) now.add(sec);
    }
    for (const sec of now) {
      if (this._openFor.has(sec)) continue;
      sec.classList.remove('collapsed');
      sec.querySelector(':scope > .section-header')?.classList.remove('collapsed');
    }
    this._openFor = now;
  }

  _section(home) {
    let s = this._sections.get(home.key);
    if (s) return s;
    const el = document.createElement('div');
    el.className = 'live-section';
    const head = document.createElement('div');
    head.className = 'live-header';
    const where = document.createElement('span');
    where.className = 'live-where';
    where.textContent = PANE_LABEL[home.pane] ?? '';
    head.append(home.title, where);
    head.title = 'Go to this section';
    head.addEventListener('click', () => this._goHome(home));
    const body = document.createElement('div');
    el.append(head, body);
    s = { el, body, order: home.order };
    // Sections sit in home order; the order of a section is its first row's.
    const after = [...this._sections.values()]
      .filter(o => o.order > s.order).sort((a, b) => a.order - b.order)[0];
    // Layers (negative order) goes above Recent; every other section below it.
    const anchor = after ? after.el : this._empty;
    this.el.insertBefore(el, home.order < 0 ? this._recentEl : anchor);
    this._sections.set(home.key, s);
    return s;
  }

  _add(id) {
    const p = this.ps.get(id);
    const home = this._home.get(id)
      ?? { key: 'live|Layers', pane: '', title: 'Layers', order: -1, srcIdx: [] };
    const s = this._section(home);
    const row = buildParamRow(p, this.contextMenu);
    row._liveOrder = home.order;
    const after = [...s.body.children].find(r => r._liveOrder > home.order);
    s.body.insertBefore(row, after ?? null);
    this._rows.set(id, { row, sectionKey: home.key });
  }

  _remove(id) {
    const { row, sectionKey } = this._rows.get(id);
    row._psUnsub?.();
    row.remove();
    this._rows.delete(id);
    const s = this._sections.get(sectionKey);
    if (s && !s.body.children.length) {
      s.el.remove();
      this._sections.delete(sectionKey);
    }
  }

  /** Header click: open the tab the section lives in and bring it into view. */
  _goHome(home) {
    const tab = home.pane.replace(/^tab-/, '');
    const btn = document.querySelector(`.tab[data-tab="${tab}"]`);
    if (!btn) return; // workspace panes have no fixed tab button
    btn.click();
    const first = [...this._home.entries()].find(([, h]) => h.key === home.key)?.[0];
    const row = first && document.querySelector(
      `#${home.pane} .param-row[data-param-id="${CSS.escape(first)}"]`);
    row?.closest('.panel-section')?.scrollIntoView({ block: 'start' });
  }
}
