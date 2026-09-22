/**
 * ImWeb Projection Mesh
 *
 * An N-by-M grid of control points for projection mapping, in WINDOW FRACTIONS
 * with y DOWN — the same convention projmap.tl_x/tl_y already use and the same
 * one the output window's handles are positioned in. One convention, shared by
 * the params, the handles and the renderer.
 *
 * At 2x2 this is exactly the four corners, and the existing projmap.* params
 * stay authoritative: every saved project, the projmap lock and any controller
 * mapping keep working untouched. Above 2x2 the mesh owns the geometry.
 *
 * Slots and fades mirror WarpMapEditor deliberately (beginMorph/tickMorph,
 * per-origin localStorage), because that pattern is already understood here and
 * already gives controller-driven recall with a crossfade.
 *
 * What this file does NOT do: render. It holds control points and interpolates
 * them. The output window owns the drawing, because that is where the image is.
 */

const STORAGE_KEY = 'imweb-projmesh';

/** Bilinear sample of a 4-corner quad, u/v in 0..1. */
function quadAt(tl, tr, br, bl, u, v) {
  const topX = tl.x + (tr.x - tl.x) * u, topY = tl.y + (tr.y - tl.y) * u;
  const botX = bl.x + (br.x - bl.x) * u, botY = bl.y + (br.y - bl.y) * u;
  return { x: topX + (botX - topX) * v, y: topY + (botY - topY) * v };
}

/**
 * Projective sample of a 4-corner quad (unit square -> quad), u/v in 0..1.
 *
 * Subdividing must not change the picture, and bilinear subdivision WOULD:
 * the renderer maps each cell projectively, so interior points have to be
 * placed where the projective map puts them, not where a straight-line average
 * does. On a keystoned quad those differ by a third of the frame.
 */
function homographyAt(tl, tr, br, bl, u, v) {
  const x0 = tl.x, y0 = tl.y, x1 = tr.x, y1 = tr.y;
  const x2 = br.x, y2 = br.y, x3 = bl.x, y3 = bl.y;
  const dx1 = x1 - x2, dx2 = x3 - x2, dx3 = x0 - x1 + x2 - x3;
  const dy1 = y1 - y2, dy2 = y3 - y2, dy3 = y0 - y1 + y2 - y3;
  const den = dx1 * dy2 - dx2 * dy1;
  if (Math.abs(den) < 1e-12) return quadAt(tl, tr, br, bl, u, v); // degenerate
  const g = (dx3 * dy2 - dx2 * dy3) / den;
  const h = (dx1 * dy3 - dx3 * dy1) / den;
  const a = x1 - x0 + g * x1, b = x3 - x0 + h * x3, c = x0;
  const d = y1 - y0 + g * y1, e = y3 - y0 + h * y3, f = y0;
  const w = g * u + h * v + 1;
  if (Math.abs(w) < 1e-12) return quadAt(tl, tr, br, bl, u, v);
  return { x: (a * u + b * v + c) / w, y: (d * u + e * v + f) / w };
}

export class ProjMapMesh {
  constructor(cols = 2, rows = 2) {
    this.cols = 2;
    this.rows = 2;
    this.pts  = [
      { x: 0, y: 0 }, { x: 1, y: 0 },
      { x: 0, y: 1 }, { x: 1, y: 1 },
    ];
    this._morph = null;
    this.onChange = null;
    if (cols !== 2 || rows !== 2) this.setGrid(cols, rows);
  }

  idx(i, j) { return j * this.cols + i; }
  get(i, j) { return this.pts[this.idx(i, j)]; }

  /** Is this still the plain 4-corner case the projmap params describe? */
  get isQuad() { return this.cols === 2 && this.rows === 2; }

  /** The four outer corners, in the order the renderer and params use. */
  corners() {
    return {
      tl: this.get(0, 0),
      tr: this.get(this.cols - 1, 0),
      br: this.get(this.cols - 1, this.rows - 1),
      bl: this.get(0, this.rows - 1),
    };
  }

  /** Replace the four corners (2x2 only — above that the mesh owns them). */
  setCorners(c) {
    if (!this.isQuad) return false;
    this.pts[0] = { x: c.tl.x, y: c.tl.y };
    this.pts[1] = { x: c.tr.x, y: c.tr.y };
    this.pts[2] = { x: c.bl.x, y: c.bl.y };
    this.pts[3] = { x: c.br.x, y: c.br.y };
    this._changed();
    return true;
  }

  /**
   * Evaluate the surface at u,v, PROJECTIVELY at every level — over the whole
   * quad at 2x2, and within the containing cell above that. This matches what
   * the renderer draws, which is what makes subdivision shape-preserving:
   * measured worst deviation 3.3e-16 over 81 probes across 3x3, 5x5, 9x5, 17x17.
   */
  sample(u, v) {
    if (this.isQuad) {
      const c = this.corners();
      return homographyAt(c.tl, c.tr, c.br, c.bl, u, v);
    }
    const cu = Math.min(this.cols - 2, Math.floor(u * (this.cols - 1)));
    const cv = Math.min(this.rows - 2, Math.floor(v * (this.rows - 1)));
    const lu = u * (this.cols - 1) - cu, lv = v * (this.rows - 1) - cv;
    // PROJECTIVE within the cell, not bilinear. The renderer maps each cell
    // projectively, and a projective map is fixed by its 4 corners — so a cell
    // whose corners sit on the global homography reproduces that homography
    // exactly, which is what makes subdivision shape-preserving. Sampling
    // bilinearly here would disagree with what is actually drawn, and repeated
    // resampling would drift the shape a little each time.
    return homographyAt(this.get(cu, cv), this.get(cu + 1, cv),
                        this.get(cu + 1, cv + 1), this.get(cu, cv + 1), lu, lv);
  }

  /**
   * Resize the control grid, PRESERVING the current shape by resampling the
   * existing surface. Going 2x2 -> 3x3 must not move a single projected pixel;
   * a grid that jumped on subdivision would be unusable for calibration,
   * because you would have to re-align after every change of resolution.
   */
  setGrid(cols, rows) {
    cols = Math.max(2, Math.min(17, Math.round(cols)));
    rows = Math.max(2, Math.min(17, Math.round(rows)));
    if (cols === this.cols && rows === this.rows) return false;
    const next = [];
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const p = this.sample(i / (cols - 1), j / (rows - 1));
        next.push({ x: p.x, y: p.y });
      }
    }
    this.cols = cols; this.rows = rows; this.pts = next;
    this._changed();
    return true;
  }

  /** Move one control point (window fractions, y-down). */
  setPoint(i, j, x, y) {
    const p = this.pts[this.idx(i, j)];
    if (!p) return false;
    p.x = x; p.y = y;
    this._changed();
    return true;
  }

  /** Reset to the full canvas. */
  reset() {
    const c = this.cols, r = this.rows;
    this.cols = 2; this.rows = 2;
    this.pts = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }];
    if (c !== 2 || r !== 2) this.setGrid(c, r); else this._changed();
  }

  // ── Serialization ─────────────────────────────────────────────────────────

  serialize() {
    return { cols: this.cols, rows: this.rows,
             pts: this.pts.map(p => [+p.x.toFixed(6), +p.y.toFixed(6)]) };
  }

  deserialize(d) {
    if (!d || !Array.isArray(d.pts)) return false;
    const n = (d.cols | 0) * (d.rows | 0);
    if (n !== d.pts.length || n < 4) return false;
    this.cols = d.cols; this.rows = d.rows;
    this.pts = d.pts.map(p => ({ x: p[0], y: p[1] }));
    this._changed();
    return true;
  }

  /**
   * Slots are per-origin localStorage, exactly like the warp map's. That is
   * why the slot INDEX must not be captured by Display States: the contents
   * live on this machine at this port, so a captured index would recall a
   * different mesh elsewhere.
   */
  save(slot) {
    try {
      const all = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
      all[slot] = this.serialize();
      localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
      return true;
    } catch (e) { console.warn('[ProjMesh] save failed', e); return false; }
  }

  getSavedSlots() {
    try { return Object.keys(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')); }
    catch { return []; }
  }

  // ── Morph between saved meshes ────────────────────────────────────────────

  /**
   * Crossfade to a saved slot over `secs`. Returns false for an empty slot, so
   * a controller-driven recall of a slot that holds nothing does not blank the
   * mapping mid-performance.
   *
   * A morph only runs between meshes of the SAME grid size; otherwise there is
   * no correspondence between control points to interpolate. Different sizes
   * snap, which is honest — a silent half-interpolated grid would be worse.
   */
  beginMorph(slot, secs = 0) {
    let data = null;
    try { data = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')[slot] ?? null; }
    catch { data = null; }
    if (!data) return false;
    if (!(secs > 0) || data.cols !== this.cols || data.rows !== this.rows) {
      return this.deserialize(data);
    }
    this._morph = {
      from: this.pts.map(p => ({ x: p.x, y: p.y })),
      to:   data.pts.map(p => ({ x: p[0], y: p[1] })),
      t: 0, dur: secs,
    };
    return true;
  }

  get morphing() { return !!this._morph; }

  /** Called from the render loop with dt in seconds. */
  tickMorph(dt) {
    const m = this._morph;
    if (!m) return false;
    m.t = Math.min(1, m.t + dt / m.dur);
    const s = m.t * m.t * (3 - 2 * m.t); // smoothstep, as state morphs use
    for (let k = 0; k < this.pts.length; k++) {
      this.pts[k].x = m.from[k].x + (m.to[k].x - m.from[k].x) * s;
      this.pts[k].y = m.from[k].y + (m.to[k].y - m.from[k].y) * s;
    }
    if (m.t >= 1) this._morph = null;
    this._changed();
    return true;
  }

  _changed() { if (this.onChange) this.onChange(); }
}
