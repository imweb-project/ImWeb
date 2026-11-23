/**
 * The Remote layout — which controls ImWeb's own phone/iPad remote shows, and
 * on which page.
 *
 * The remote (tools/remote/, served by tools/osc-relay.mjs) is a web page that
 * renders whatever ImWeb tells it to in its manifest (OSCBridge._sendManifest).
 * This is the "what": REMOTE_PAGES pages of up to PAGE_MAX items each. An item
 * is a parameter (`{ id }`, optionally `w` to force a fader or a knob, `s` to
 * spring back on release) or one of ImWeb's shortcut keys pinned as a button
 * (`{ key }`).
 *
 * The layout is written HERE, in ImWeb, never on the phone: right-click →
 * Remote page 1–4. A performance surface with edit gestures on it is one slip
 * away from losing its layout mid-set. The hard cap (4 × 12) is how "few
 * controls" is kept.
 *
 * Saved in two places that hold ONE fact, the same shape as the panel layout:
 * the per-origin autosave (a reload keeps it) and the .imweb project (another
 * project has its own remote). It is NOT a parameter and NOT in Display States:
 * which controls are on the remote is a property of the rig, not of a look.
 */
export const REMOTE_PAGES = 4;
export const PAGE_MAX = 12;          // items on one page — one row of strips on an iPad
export const REMOTE_MAX = PAGE_MAX;  // older name: the cap a "full" message quotes
export const REMOTE_KEY = 'imweb.remoteList'; // per origin, like every key here
export const WIDGETS = ['fader', 'knob'];

/**
 * Fader or knob when the performer has not said: a knob for angles and hues
 * (unit °), which are set and left or go round; a fader for anything ridden.
 */
export function autoWidget(p) {
  return p?.type === 'continuous' && String(p.unit ?? '').startsWith('°') ? 'knob' : 'fader';
}

const emptyPages = () => Array.from({ length: REMOTE_PAGES }, () => ({ items: [] }));
const same = (it, t) => (t.id ? it.id === t.id : !!t.key && it.key === t.key);

export class RemoteList {
  constructor(store = globalThis.localStorage) {
    this._store = store;
    this._pages = emptyPages();
    this._listeners = new Set();
    this._load();
  }

  // ── Reading ─────────────────────────────────────────────────────────────────
  /** Every parameter id on any page, in page order. */
  get ids() { return this._pages.flatMap((p) => p.items.filter((it) => it.id).map((it) => it.id)); }
  get pages() { return this._pages.map((p) => ({ items: p.items.map((it) => ({ ...it })) })); }
  has(id) { return this.pageOf(id) >= 0; }
  hasKey(key) { return this._find({ key }) >= 0; }
  pageOf(id) { return this._find({ id }); }
  pageOfKey(key) { return this._find({ key }); }
  pageFull(n) { return (this._pages[n]?.items.length ?? PAGE_MAX) >= PAGE_MAX; }
  /** The performer's explicit choice, or undefined for "auto". */
  widgetOf(id) { return this._item({ id })?.w; }
  /** Springs back to where the finger landed when let go. */
  springOf(id) { return !!this._item({ id })?.s; }

  // ── Writing ─────────────────────────────────────────────────────────────────
  /**
   * Put a control (`{ id }`) or key (`{ key }`) on page n — moving it there if
   * it is on another page. The one behaviour behind every Remote menu row.
   * @returns {string|null} a message for the performer when it could not
   */
  put(target, n) {
    if (!target?.id && !target?.key) return null;
    if (!Number.isInteger(n) || !this._pages[n]) return null;
    const from = this._find(target);
    if (from === n) return null;
    if (this.pageFull(n)) return `Remote page ${n + 1} is full (${PAGE_MAX}) — remove one or use another page`;
    let item = target.id ? { id: target.id } : { key: target.key };
    if (from >= 0) {
      const items = this._pages[from].items;
      item = items.splice(items.findIndex((it) => same(it, target)), 1)[0];
    }
    this._pages[n].items.push(item);
    this._changed();
    return null;
  }

  /** Onto the first page with room. @returns {boolean} */
  add(id) {
    if (!id || this.has(id)) return false;
    const n = this._pages.findIndex((p) => p.items.length < PAGE_MAX);
    if (n < 0) return false;
    this._pages[n].items.push({ id });
    this._changed();
    return true;
  }

  remove(id) { return this._drop({ id }); }
  removeKey(key) { return this._drop({ key }); }

  /** 'fader' | 'knob' forces one; anything else goes back to automatic. */
  setWidget(id, w) {
    const it = this._item({ id });
    if (!it) return false;
    const next = WIDGETS.includes(w) ? w : undefined;
    if (it.w === next) return false;
    if (next) it.w = next; else delete it.w;
    this._changed();
    return true;
  }

  /**
   * Spring: push, and on release the control glides back to where the finger
   * LANDED — throw-and-return, playable without looking, always back on the Look.
   */
  setSpring(id, on) {
    const it = this._item({ id });
    if (!it || !!it.s === !!on) return false;
    if (on) it.s = true; else delete it.s;
    this._changed();
    return true;
  }

  onChange(fn) { this._listeners.add(fn); return () => this._listeners.delete(fn); }

  // ── Project file hook (ProjectFile.extras.remote) ───────────────────────────
  capture() { return { v: 2, pages: this.pages }; }

  /** Called only when a project HAS a `remote` key — see ProjectFile._apply. */
  restore(d) {
    this._pages = RemoteList.normalize(d);
    this._changed();
  }

  /**
   * Any stored shape → exactly REMOTE_PAGES valid pages. v1 (`{ ids }`, one
   * flat list) becomes page 1, so a project saved before pages existed opens
   * with its remote intact.
   */
  static normalize(d) {
    const raw = Array.isArray(d?.pages) ? d.pages
      : Array.isArray(d?.ids) ? [{ items: d.ids.map((id) => ({ id })) }]
      : [];
    const seen = new Set();
    const pages = emptyPages();
    raw.slice(0, REMOTE_PAGES).forEach((p, n) => {
      for (const it of Array.isArray(p?.items) ? p.items : []) {
        if (pages[n].items.length >= PAGE_MAX) break;
        const id = typeof it?.id === 'string' && it.id ? it.id : null;
        const key = !id && typeof it?.key === 'string' && it.key ? it.key : null;
        const tag = id ? `id:${id}` : key ? `key:${key}` : null;
        if (!tag || seen.has(tag)) continue;
        seen.add(tag);
        pages[n].items.push(id
          ? { id, ...(WIDGETS.includes(it.w) ? { w: it.w } : {}), ...(it.s === true ? { s: true } : {}) }
          : { key });
      }
    });
    return pages;
  }

  // ── Internals ───────────────────────────────────────────────────────────────
  _find(t) { return this._pages.findIndex((p) => p.items.some((it) => same(it, t))); }
  _item(t) { for (const p of this._pages) { const it = p.items.find((x) => same(x, t)); if (it) return it; } return null; }

  _drop(t) {
    const n = this._find(t);
    if (n < 0) return false;
    const items = this._pages[n].items;
    items.splice(items.findIndex((it) => same(it, t)), 1);
    this._changed();
    return true;
  }

  _load() {
    try { this._pages = RemoteList.normalize(JSON.parse(this._store?.getItem(REMOTE_KEY) ?? 'null')); }
    catch { this._pages = emptyPages(); }
  }

  _changed() {
    try { this._store?.setItem(REMOTE_KEY, JSON.stringify(this.capture())); } catch { /* private mode */ }
    this._listeners.forEach((fn) => { try { fn(this.ids); } catch (e) { console.warn('[Remote]', e); } });
  }
}
