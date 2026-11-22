/**
 * The tape, drawn. §4.2's landscape and §8.6's "draw the loop", at the first
 * resolution that is useful: a min/max envelope of the whole tape with the
 * partition layout and the two zone regions marked on it.
 *
 * **This module imports nothing and knows nothing.** Not ParameterSystem, not
 * the engine — it is handed columns and rectangles and it draws them. That is
 * not tidiness: §4.1 keeps the engine ImWeb-free and `AudioBinding` is the one
 * place the halves meet, so a display that reached for `ps` on one side and
 * `engine` on the other would make a second bridge and quietly end the property
 * the whole audio half is built on. The binding fetches; this paints.
 *
 * **Min/max, never an average, and never resampled.** A peak is the thing a
 * performer is looking for — where the transient is, where the recording
 * actually starts — and an average of a column smears exactly that away. Two
 * consequences, both §6 item 6's rule restated: a zoom asks the engine for a new
 * envelope rather than stretching this one, and a column that covers no whole
 * sample draws as a flat line at zero rather than as nothing.
 *
 * Drawing is coalesced onto one animation frame. Dirty notifications arrive at
 * frame cadence already (rule 7), and region params can change several times in
 * a frame under a controller, so painting per event would be several full
 * canvas repaints per frame for one visible result.
 */

/** Region kinds, in draw order — later ones are drawn on top. */
export const REGION_KINDS = Object.freeze(['part', 'rec', 'play', 'spec', 'stretch']);

/**
 * The kinds that are ZONES — things you do to the tape, as opposed to the
 * partition layout it sits on. Each gets its own lane along the top, in this
 * order, because zones overlap by default (every one starts out covering its
 * whole partition) and a handle you cannot reach under another handle is not a
 * handle. The lane is where a zone is grabbed; its tint runs the full height.
 */
export const ZONE_KINDS = Object.freeze(['rec', 'play', 'spec', 'stretch']);

/** CSS px. Lane height, edge grab width, bottom ruler height. */
const LANE_H = 14;
const EDGE_GRAB = 6;
const RULER_H = 13;
/** The closest zoom, as a fraction of the tape. */
const MIN_SPAN = 1 / 4096;
const TICK_STEPS = [0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 30, 60, 120, 300];

/**
 * Move one edge or the whole of a region by a drag. Pure, and exported so the
 * arithmetic is tested without a pointer: `mode` is 'move', 'l' or 'r', `from`
 * the region when the drag began, `d` how far the pointer has travelled (same
 * units as the region — fractions of the tape). A move keeps the length and
 * stops at the ends of the tape; an edge stops `min` short of the other edge,
 * so a region can be made small but never inverted.
 */
export function dragRegion(from, mode, d, min = 1e-4) {
  const len = from.end - from.start;
  if (mode === 'move') {
    const start = Math.min(Math.max(from.start + d, 0), Math.max(0, 1 - len));
    return { start, end: start + len };
  }
  if (mode === 'l') {
    return { start: Math.min(Math.max(from.start + d, 0), from.end - min), end: from.end };
  }
  return { start: from.start, end: Math.max(Math.min(from.end + d, 1), from.start + min) };
}

/**
 * Zoom a view span about a fixed point. `factor` > 1 zooms out. The point under
 * the pointer stays under the pointer, which is the whole feel of it; the span
 * is then slid back inside [0, 1] rather than squeezed, so zooming out near an
 * end does not also change the zoom level.
 */
export function zoomSpan(start, end, at, factor, minSpan = MIN_SPAN) {
  const span = Math.min(1, Math.max(minSpan, (end - start) * factor));
  const t = end > start ? (at - start) / (end - start) : 0.5;
  let s = at - t * span;
  s = Math.min(Math.max(s, 0), 1 - span);
  return { start: s, end: s + span };
}

// Zone tints are faint on purpose: zones overlap by default, and three stacked
// washes at the old 0.18 turned the waveform under them to mud. The lane handle
// and the two edge lines are what say where a zone is; the tint only hints.
const STYLE = {
  bg: '#0a0a0b',
  grid: '#2a2a34',
  wave: '#a6a6c0',
  waveDim: '#4a4a5c',
  part: 'rgba(64, 128, 232, 0.10)',
  partEdge: '#4080e8',
  rec: 'rgba(232, 64, 64, 0.07)',
  recEdge: '#e84040',
  play: 'rgba(64, 200, 120, 0.07)',
  playEdge: '#40c878',
  spec: 'rgba(232, 176, 64, 0.07)',
  specEdge: '#e8b040',
  stretch: 'rgba(176, 96, 232, 0.07)',
  stretchEdge: '#b060e8',
  head: '#eafff2',
  headExtra: '#40c878',
  grainMark: '#e8d040',
  text: '#a6a6c0',
};

export class TapeView {
  /** @param {HTMLCanvasElement} canvas */
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    /** Envelope columns, interleaved [min, max] per column. */
    this._env = null;
    /** The span the envelope covers, in samples. */
    this._envStart = 0;
    this._envEnd = 0;
    /** The span being VIEWED, as fractions of the tape. */
    this._viewStart = 0;
    this._viewEnd = 0;
    /** Overlay rectangles, fractions of the tape: { kind, start, end, label, id? }. */
    this._regions = [];
    this._pending = false;
    this._empty = 'no tape';
    /** Device pixels per CSS pixel, refreshed on every resize. */
    this._dpr = 1;
    /** Tape length in seconds, for the ruler. 0 = unknown, no ruler. */
    this._seconds = 0;
    /**
     * Set by the binding. The view still knows nothing: it reports what the
     * hand did, in fractions of the tape, and the binding decides what that
     * means for a parameter.
     *   onSpanChange(start, end)            the view was zoomed or panned
     *   onRegionDrag(id, start, end, mode)  a zone handle was dragged
     */
    this.onSpanChange = null;
    this.onRegionDrag = null;
    /** Playheads: flat [zone, fractionOfTape] pairs from the engine, or null. */
    this._heads = null;
    /** Point marks: { kind, at } in fractions of the tape. */
    this._marks = [];
    this._drag = null;
    this.resize();
    this._attachPointer();
  }

  /**
   * Where the playheads are — flat [zone, fraction] pairs, straight from the
   * engine's per-frame message. Empty or null takes them down. This is the
   * only thing that repaints the display every frame, and only while
   * something is playing.
   */
  setPlayheads(pairs) {
    const next = pairs && pairs.length ? pairs : null;
    if (!next && !this._heads) return;
    this._heads = next;
    this.invalidate();
  }

  /** @param {{kind:string, at:number}[]} marks point marks, fractions of the tape */
  setMarks(marks) {
    if (!marks.length && !this._marks.length) return;
    this._marks = marks;
    this.invalidate();
  }

  /** Tape length in seconds — only the ruler wants it. */
  setSeconds(sec) {
    if (this._seconds === sec) return;
    this._seconds = sec;
    this.invalidate();
  }

  get span() { return { start: this._viewStart, end: this._viewEnd }; }

  // ── the hand ──────────────────────────────────────────────────────────────

  /** Client x → device-pixel x. Through the rect, so CSS zoom cannot skew it. */
  _px(e) {
    const r = this.canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - r.left) / (r.width || 1)) * this.canvas.width,
      y: ((e.clientY - r.top) / (r.height || 1)) * this.canvas.height,
    };
  }

  /** Device-pixel x → fraction of the tape. */
  _frac(x) {
    return this._viewStart + (x / (this.canvas.width || 1)) * (this._viewEnd - this._viewStart);
  }

  _laneOf(kind) { return ZONE_KINDS.indexOf(kind); }

  /** Which zone handle is under this device-pixel point, and which part of it. */
  hit(x, y) {
    const lane = Math.floor(y / (LANE_H * this._dpr));
    const grab = EDGE_GRAB * this._dpr;
    for (let i = this._regions.length - 1; i >= 0; i--) {
      const r = this._regions[i];
      if (!r.id || this._laneOf(r.kind) !== lane) continue;
      const x0 = this._x(r.start), x1 = this._x(r.end);
      if (x < x0 - grab || x > x1 + grab) continue;
      // A zone narrower than two grab widths is all "move" in the middle third
      // — otherwise a short zone could be resized but never picked up.
      const narrow = x1 - x0 < grab * 3;
      let mode = 'move';
      if (!narrow || x < x0 || x > x1) {
        if (Math.abs(x - x0) <= grab) mode = 'l';
        else if (Math.abs(x - x1) <= grab) mode = 'r';
      }
      return { region: r, mode };
    }
    return null;
  }

  _attachPointer() {
    const c = this.canvas;
    if (typeof c.addEventListener !== 'function') return;   // a stub, in tests
    c.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const { x, y } = this._px(e);
      const h = this.hit(x, y);
      this._drag = h
        ? { kind: 'region', id: h.region.id, mode: h.mode, x0: x,
            from: { start: h.region.start, end: h.region.end } }
        : { kind: 'pan', x0: x, from: { start: this._viewStart, end: this._viewEnd } };
      try { c.setPointerCapture(e.pointerId); } catch { /* synthetic event */ }
      e.preventDefault();
    });
    c.addEventListener('pointermove', (e) => {
      const { x, y } = this._px(e);
      const d = this._drag;
      if (!d) {
        const h = this.hit(x, y);
        c.style.cursor = !h ? '' : h.mode === 'move' ? 'grab' : 'ew-resize';
        return;
      }
      const w = this.canvas.width || 1;
      if (d.kind === 'region') {
        // Distance in fractions of the tape AT THE CURRENT ZOOM, so a drag is
        // as fine as the view is close.
        const df = ((x - d.x0) / w) * (this._viewEnd - this._viewStart);
        const next = dragRegion(d.from, d.mode, df);
        this.onRegionDrag?.(d.id, next.start, next.end, d.mode);
      } else {
        const span = d.from.end - d.from.start;
        if (span >= 1) return;
        const s = Math.min(Math.max(d.from.start - ((x - d.x0) / w) * span, 0), 1 - span);
        this.setSpan(s, s + span);
      }
    });
    const end = () => { this._drag = null; };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const { x } = this._px(e);
      const span = this._viewEnd - this._viewStart;
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        if (span >= 1) return;
        const s = Math.min(Math.max(this._viewStart + (e.deltaX / (this.canvas.width || 1)) * span * this._dpr, 0), 1 - span);
        this.setSpan(s, s + span);
        return;
      }
      const z = zoomSpan(this._viewStart, this._viewEnd, this._frac(x), Math.exp(e.deltaY * 0.0015));
      this.setSpan(z.start, z.end);
    }, { passive: false });
    c.addEventListener('dblclick', (e) => {
      const { x, y } = this._px(e);
      const h = this.hit(x, y);
      // On a zone handle: zoom to that zone with a little air round it.
      // Anywhere else: the whole tape.
      if (h) {
        const pad = (h.region.end - h.region.start) * 0.08;
        const s = Math.max(0, h.region.start - pad), en = Math.min(1, h.region.end + pad);
        if (en - s >= MIN_SPAN) { this.setSpan(s, en); return; }
      }
      this.setSpan(0, 1);
    });
  }

  /**
   * Match the backing store to the element's CSS size. Returns the column count
   * a full-width envelope should have — ONE COLUMN PER DEVICE PIXEL, which is
   * the resolution at which min/max is exactly what the screen can show: fewer
   * loses peaks the display could have drawn, more asks the audio thread for
   * detail that cannot be painted.
   */
  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));
    this._dpr = Math.min(window.devicePixelRatio || 1, 2);
    const bw = Math.round(w * this._dpr);
    const bh = Math.round(h * this._dpr);
    if (this.canvas.width !== bw || this.canvas.height !== bh) {
      this.canvas.width = bw;
      this.canvas.height = bh;
    }
    return bw;
  }

  /** @returns {number} the column count a full-width request should ask for. */
  get columns() { return this.canvas.width; }

  setSpan(start, end) {
    if (start === this._viewStart && end === this._viewEnd) return;
    this._viewStart = start;
    this._viewEnd = end;
    this.invalidate();
    // A zoom ASKS for a new envelope (§6 item 6) — what is held is redrawn in
    // place at the wrong resolution until the right one arrives.
    this.onSpanChange?.(start, end);
  }

  /** @param {{start:number,end:number,columns:number,data:Float32Array}} r */
  setEnvelope(r) {
    this._env = r.data;
    this._envStart = r.start;
    this._envEnd = r.end;
    this.invalidate();
  }

  /** Drop the envelope but keep the frame — the tape is gone, the view is not. */
  clearEnvelope(message = 'no tape') {
    this._env = null;
    this._empty = message;
    this.invalidate();
  }

  /**
   * What an empty frame says, without discarding an envelope it may already
   * hold. "No tape", "reading the tape" and "audio off" are three different
   * situations and only one of them is a reason to stop waiting — an engine
   * whose audio callback never runs (no output device) sits in the second one
   * forever, and saying "no tape" there sends the reader after the wrong fault.
   */
  setEmptyMessage(message) {
    if (this._empty === message) return;
    this._empty = message;
    if (!this._env) this.invalidate();
  }

  /** @param {{kind:string,start:number,end:number,label?:string}[]} regions */
  setRegions(regions) {
    this._regions = regions;
    this.invalidate();
  }

  invalidate() {
    if (this._pending) return;
    this._pending = true;
    requestAnimationFrame(() => { this._pending = false; this.draw(); });
  }

  /** Sample position → device-pixel x, against the VIEW span. */
  _x(sample) {
    const span = this._viewEnd - this._viewStart;
    if (!(span > 0)) return 0;
    return ((sample - this._viewStart) / span) * this.canvas.width;
  }

  draw() {
    const { ctx } = this;
    const w = this.canvas.width, h = this.canvas.height;
    ctx.fillStyle = STYLE.bg;
    ctx.fillRect(0, 0, w, h);

    // Partitions under the waveform, zones over it: the layout is the ground the
    // material sits on, and a region is a thing you are doing TO that material.
    for (const r of this._regions) if (r.kind === 'part') this._fill(r, STYLE.part, STYLE.partEdge);

    if (this._env) this._drawEnvelope();
    else {
      ctx.fillStyle = STYLE.text;
      ctx.font = `${Math.round(11 * this._dpr)}px "IBM Plex Mono", monospace`;
      ctx.fillText(this._empty, 8 * this._dpr, h / 2);
    }

    // Zero line last among the ground layers, so it reads through the waveform.
    ctx.strokeStyle = STYLE.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, Math.round(h / 2) + 0.5);
    ctx.lineTo(w, Math.round(h / 2) + 0.5);
    ctx.stroke();

    for (const r of this._regions) {
      if (r.kind === 'part') continue;
      const fill = STYLE[r.kind], edge = STYLE[`${r.kind}Edge`];
      if (fill) this._fill(r, fill, edge);
    }
    this._drawHeads();
    this._drawRuler();
  }

  /** Playheads and marks: full-height lines over everything but the ruler. */
  _drawHeads() {
    const { ctx } = this;
    const h = this.canvas.height, w = this.canvas.width;
    const line = (frac, colour, width, label) => {
      const x = this._x(frac);
      if (x < -1 || x > w + 1) return;
      ctx.fillStyle = colour;
      ctx.fillRect(Math.round(x - width / 2), 0, width, h);
      if (label) {
        ctx.font = `${Math.round(9 * this._dpr)}px "IBM Plex Mono", monospace`;
        ctx.fillText(label, x + 3 * this._dpr, h - (RULER_H + 4) * this._dpr);
      }
    };
    for (const m of this._marks) line(m.at, STYLE.grainMark, Math.max(1, this._dpr), 'GRAIN');
    if (!this._heads) return;
    for (let i = 0; i + 1 < this._heads.length; i += 2) {
      const zone = this._heads[i];
      // Head 1 (the Playback zone) is the bright one; the extra heads are
      // thinner and numbered, so four lines are four things and not a blur.
      line(this._heads[i + 1], zone === 0 ? STYLE.head : STYLE.headExtra,
        (zone === 0 ? 2 : 1) * this._dpr, zone === 0 ? '' : String(zone + 1));
    }
  }

  /** Seconds along the bottom. Only when the tape's length is known. */
  _drawRuler() {
    const sec = this._seconds;
    const span = this._viewEnd - this._viewStart;
    if (!(sec > 0) || !(span > 0)) return;
    const { ctx } = this;
    const w = this.canvas.width, h = this.canvas.height;
    const visible = span * sec;
    const want = (70 * this._dpr * visible) / w;          // seconds per ~70px
    const step = TICK_STEPS.find((s) => s >= want) ?? TICK_STEPS[TICK_STEPS.length - 1];
    const t0 = this._viewStart * sec;
    ctx.fillStyle = STYLE.text;
    ctx.strokeStyle = STYLE.grid;
    ctx.font = `${Math.round(9 * this._dpr)}px "IBM Plex Mono", monospace`;
    ctx.beginPath();
    for (let t = Math.ceil(t0 / step) * step; t <= t0 + visible + 1e-9; t += step) {
      const x = Math.round(this._x(t / sec)) + 0.5;
      ctx.moveTo(x, h - RULER_H * this._dpr);
      ctx.lineTo(x, h);
      const label = step >= 1
        ? (t >= 60 ? `${Math.floor(t / 60)}:${String(Math.round(t % 60)).padStart(2, '0')}` : `${Math.round(t)}s`)
        : `${t.toFixed(step >= 0.1 ? 1 : step >= 0.01 ? 2 : 3)}s`;
      ctx.fillText(label, x + 3 * this._dpr, h - 3 * this._dpr);
    }
    ctx.stroke();
  }

  _drawEnvelope() {
    const { ctx } = this;
    const h = this.canvas.height;
    const mid = h / 2;
    const cols = this._env.length / 2;
    const span = this._envEnd - this._envStart;
    if (!(span > 0) || !cols) return;
    ctx.fillStyle = STYLE.wave;
    for (let c = 0; c < cols; c++) {
      const lo = this._env[c * 2], hi = this._env[c * 2 + 1];
      // The envelope's own span may differ from the view's — a reply can arrive
      // for a span the user has already left — so columns are placed by SAMPLE
      // POSITION rather than by index. A stale envelope then draws in the right
      // place at the wrong resolution instead of in the wrong place.
      const x0 = this._x(this._envStart + (c * span) / cols);
      const x1 = this._x(this._envStart + ((c + 1) * span) / cols);
      const wpx = Math.max(1, x1 - x0);
      const yTop = mid - hi * mid;
      const yBot = mid - lo * mid;
      // A silent column is a hairline, not nothing: "there is tape here and it
      // is silent" and "there is no tape here" must not look the same.
      ctx.fillRect(x0, yTop, wpx, Math.max(1, yBot - yTop));
    }
  }

  _fill(r, fill, edge) {
    const { ctx } = this;
    const h = this.canvas.height;
    const x0 = this._x(r.start);
    const x1 = this._x(r.end);
    const w = Math.max(1, x1 - x0);
    ctx.fillStyle = fill;
    ctx.fillRect(x0, 0, w, h);
    ctx.strokeStyle = edge;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(Math.round(x0) + 0.5, 0);
    ctx.lineTo(Math.round(x0) + 0.5, h);
    ctx.moveTo(Math.round(x1) - 0.5, 0);
    ctx.lineTo(Math.round(x1) - 0.5, h);
    ctx.stroke();
    const lane = this._laneOf(r.kind);
    // Zones sit in their lanes; a partition's name goes just under the lanes,
    // where no handle can cover it.
    const ly = (lane >= 0 ? lane : ZONE_KINDS.length) * LANE_H * this._dpr;
    if (lane >= 0 && r.id) {
      // The handle: a solid bar in this zone's own lane. This is what the hand
      // takes hold of — see ZONE_KINDS for why each kind has its own.
      ctx.globalAlpha = 0.55;
      ctx.fillStyle = edge;
      ctx.fillRect(x0, ly + 1, w, LANE_H * this._dpr - 2);
      ctx.globalAlpha = 1;
    }
    if (r.label) {
      ctx.fillStyle = lane >= 0 && r.id ? STYLE.bg : edge;
      ctx.font = `${Math.round(9 * this._dpr)}px "IBM Plex Mono", monospace`;
      // Clamped to the left edge so a zone that starts off-screen keeps its name.
      ctx.fillText(r.label, Math.max(x0, 0) + 3 * this._dpr, ly + 10 * this._dpr);
    }
  }
}
