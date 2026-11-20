/**
 * Live strip — eight slots at the foot of the control panel, each holding one
 * parameter of your choosing. The few controls a patch is actually played by.
 *
 * A slot is a VIEW of its parameter, like a row: it shows the param's label,
 * value and position, and a drag writes the param itself. Pin with the
 * context menu ("Pin to strip / unpin"), which fires `stripPin` on the
 * ParameterSystem.
 *
 * WHERE THE EIGHT IDS LIVE, two places with different jobs:
 *   - each Display State's `extra.strip` (captured in main.js's extra
 *     callback) — so recalling a Look brings its own eight controls. A state
 *     saved before this existed has no key and leaves the strip alone;
 *   - per-origin localStorage — what a plain reload restores.
 *
 * MIDI: each slot has an inlet param, `strip.k1` … `strip.k8` (group 'global',
 * so Display States never capture them — their mappings are persisted like any
 * other mapping). Map a knob to the INLET, by right-clicking the slot number,
 * and that knob plays whatever the slot holds, in every state. The inlet is
 * one-way: it forwards to the target and is never written back, so there is
 * no loop to guard. It does not forward while a project or state is being
 * restored — a stored inlet value is not a gesture.
 */
import { PARAM_TYPE } from '../../controls/ParameterSystem.js';

export const STRIP_SLOTS = 8;
const STORE_KEY = 'imweb.liveStrip';
const DRAG_START_PX = 3;

export class LiveStrip {
  constructor(ps, contextMenu, { toast = () => {} } = {}) {
    this.ps = ps;
    this.contextMenu = contextMenu;
    this.toast = toast;
    this._ids = Array(STRIP_SLOTS).fill(null);
    this._unsubs = Array(STRIP_SLOTS).fill(null);
    this._dirty = new Set();
    this._raf = 0;

    this.el = document.createElement('div');
    this.el.id = 'live-strip';
    this._cells = this._ids.map((_, i) => this._buildCell(i));
    document.getElementById('control-panel')?.appendChild(this.el);

    for (let i = 0; i < STRIP_SLOTS; i++) {
      const inlet = ps.get(`strip.k${i + 1}`);
      inlet?.onChange(() => {
        if (ps.restoring) return;
        this._target(i)?.setNormalized(inlet.normalized);
      });
    }
    ps.addEventListener('stripPin', e => this.toggle(e.detail));

    let stored = null;
    try { stored = JSON.parse(localStorage.getItem(STORE_KEY) ?? 'null'); } catch { /* corrupt or private mode */ }
    this.set(Array.isArray(stored) ? stored : [], { save: false });

    // A controller assignment fires no onChange, so the inlet marks are polled.
    setInterval(() => this._cells.forEach((c, i) => this._paintInlet(i)), 1000);
  }

  ids() { return [...this._ids]; }

  _target(i) {
    const id = this._ids[i];
    return id ? this.ps.get(id) : null;
  }

  /** Replace all eight slots. Unknown ids and triggers become empty slots. */
  set(ids, { save = true } = {}) {
    for (let i = 0; i < STRIP_SLOTS; i++) {
      const p = ids[i] ? this.ps.get(ids[i]) : null;
      this._assign(i, p && this._pinnable(p) ? p.id : null);
    }
    if (save) this._save();
  }

  _pinnable(p) {
    return p.type !== PARAM_TYPE.TRIGGER && !p.id.startsWith('strip.') && !p.setup;
  }

  /** Context-menu action: unpin if present, else take the first empty slot. */
  toggle(param) {
    if (!param) return;
    const at = this._ids.indexOf(param.id);
    if (at >= 0) { this._assign(at, null); this._save(); return; }
    if (!this._pinnable(param)) { this.toast(`${param.label} cannot go on the strip.`); return; }
    const free = this._ids.indexOf(null);
    if (free < 0) { this.toast('The strip is full — clear a slot with its ✕ first.'); return; }
    this._assign(free, param.id);
    this._save();
  }

  _assign(i, id) {
    if (this._ids[i] === id) return;
    this._unsubs[i]?.();
    this._ids[i] = id;
    const p = this._target(i);
    this._unsubs[i] = p ? p.onChange(() => this._markDirty(i)) : null;
    this._paint(i);
  }

  _save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(this._ids)); } catch { /* private mode */ }
  }

  // ── Painting ───────────────────────────────────────────────────────────────

  _markDirty(i) {
    this._dirty.add(i);
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => {
      this._raf = 0;
      const d = [...this._dirty];
      this._dirty.clear();
      d.forEach(k => this._paint(k));
    });
  }

  _paint(i) {
    const c = this._cells[i];
    const p = this._target(i);
    c.el.classList.toggle('empty', !p);
    c.label.textContent = p ? p.label : '';
    c.value.textContent = p ? p.displayValue : '';
    c.el.title = p
      ? `${p.label}: ${p.displayValue}\nDrag to change · right-click the number to map a MIDI knob to this slot`
      : 'Empty slot — right-click any control and choose “Pin to strip”';
    const n = !p ? 0
      : p.type === PARAM_TYPE.TOGGLE ? (p.value ? 1 : 0)
      : Math.max(0, Math.min(1, p.normalized));
    c.fill.style.width = `${Math.round(n * 1000) / 10}%`;
    this._paintInlet(i);
  }

  _paintInlet(i) {
    const inlet = this.ps.get(`strip.k${i + 1}`);
    const t = inlet?.controller?.type;
    this._cells[i].num.classList.toggle('mapped', !!t && t !== 'none');
  }

  // ── One cell ───────────────────────────────────────────────────────────────

  _buildCell(i) {
    const el = document.createElement('div');
    el.className = 'strip-cell empty';
    const fill = document.createElement('i');
    fill.className = 'strip-fill';
    const num = document.createElement('span');
    num.className = 'strip-num';
    num.textContent = String(i + 1);
    const label = document.createElement('span');
    label.className = 'strip-label';
    const value = document.createElement('span');
    value.className = 'strip-value';
    const clear = document.createElement('button');
    clear.className = 'strip-clear';
    clear.textContent = '✕';
    clear.title = 'Clear this slot';
    el.append(fill, num, label, value, clear);
    this.el.appendChild(el);

    clear.addEventListener('pointerdown', e => e.stopPropagation());
    clear.addEventListener('click', e => {
      e.stopPropagation();
      this._assign(i, null);
      this._save();
    });

    // Right-click: on the number → the slot's MIDI inlet; elsewhere → the
    // parameter's own menu, exactly as on its row.
    el.addEventListener('contextmenu', e => {
      e.preventDefault();
      const onNum = e.target === num;
      const p = onNum ? this.ps.get(`strip.k${i + 1}`) : this._target(i);
      if (p) this.contextMenu.show(p, e.clientX, e.clientY);
    });

    // Drag = relative, so grabbing a cell never jumps the value.
    let drag = null;
    el.addEventListener('pointerdown', e => {
      if (e.button !== 0 || e.ctrlKey) return;
      const p = this._target(i);
      if (!p) return;
      drag = { x: e.clientX, n: p.normalized, moved: false, id: e.pointerId };
      try { el.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
    });
    el.addEventListener('pointermove', e => {
      if (!drag || e.pointerId !== drag.id) return;
      const dx = e.clientX - drag.x;
      if (!drag.moved && Math.abs(dx) < DRAG_START_PX) return;
      drag.moved = true;
      const p = this._target(i);
      if (!p || p.type === PARAM_TYPE.TOGGLE) return;
      const w = el.getBoundingClientRect().width || 1;
      const gain = e.shiftKey ? 0.1 : 1;
      p.setNormalized(Math.max(0, Math.min(1, drag.n + (dx / w) * gain)));
    });
    const end = e => {
      if (!drag || e.pointerId !== drag.id) return;
      const wasClick = !drag.moved && e.type === 'pointerup';
      drag = null;
      const p = this._target(i);
      if (!wasClick || !p) return;
      if (p.type === PARAM_TYPE.TOGGLE) p.toggle();
      else if (p.type === PARAM_TYPE.SELECT) p.cycleNext();
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);

    return { el, fill, num, label, value };
  }
}
