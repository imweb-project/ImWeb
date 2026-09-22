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

/**
 * Hermite basis. Position weights for the two ends of a span, then the two
 * TANGENT weights — which is the whole reason the sampler is written this way
 * rather than in the Catmull-Rom basis it started in.
 *
 * Interpolating, not approximating: the span passes THROUGH its endpoints.
 * That is the property this instrument needs — a control point is dragged to
 * where the image should land, so the image has to land there. A Bezier
 * control polygon, whose defining points sit off the surface, would be the
 * wrong tool for calibrating against a physical object; the curve HANDLES are
 * a view on the tangents, and the points they belong to stay on the surface.
 *
 * Catmull-Rom hides its tangents: they are `(P[i+1] - P[i-1]) / 2`, implied by
 * the neighbours and unreachable. Hermite names them, so a handle can replace
 * one. With the derived values substituted the two bases agree to 2 ulps
 * (measured 4.4e-16 over four net sizes), which is what made it safe to swap
 * the basis under a shipped surface — see §12 of the audit, which asserts it
 * against a reference Catmull-Rom kept in the test for exactly that purpose.
 * That reference is the ONLY copy now: the Catmull-Rom helper that used to
 * live here was left behind by the rewrite with no caller at all, and a
 * mutation run found it by breaking it and watching nothing fail.
 */
function hermiteP(t) {
  const t2 = t * t, t3 = t2 * t;
  return [2 * t3 - 3 * t2 + 1, -2 * t3 + 3 * t2];
}
function hermiteT(t) {
  const t2 = t * t, t3 = t2 * t;
  return [t3 - 2 * t2 + t, t3 - t2];
}

export class ProjMapMesh {
  constructor(cols = 2, rows = 2) {
    this.cols = 2;
    this.rows = 2;
    this.pts  = [
      { x: 0, y: 0 }, { x: 1, y: 0 },
      { x: 0, y: 1 }, { x: 1, y: 1 },
    ];
    /**
     * 0..1 blend from the piecewise-projective surface toward a Catmull-Rom
     * spline through the same control points. A blend rather than a mode
     * switch because BOTH surfaces interpolate every control point exactly,
     * so the mix does too: raising this never moves a point away from where
     * it was dragged, whatever it does between them.
     */
    this.curve = 0;
    /**
     * Explicit tangent overrides, sparse: `{ <pointIndex>: { u: [dx,dy],
     * v: [dx,dy] } }`, either axis optionally absent.
     *
     * Sparse and absent-by-default on purpose. A point with no entry uses the
     * derived Catmull-Rom tangent, so an untouched mesh — including every mesh
     * ever saved before handles existed — samples exactly as it did, and a
     * `.imweb` written today stays readable by a build that predates this.
     * One tangent per point per AXIS, not two per edge: this is a tensor
     * product surface, and two independent handles on one edge would tear the
     * patch away from its neighbour rather than bend it.
     */
    this.tans = {};
    /** Bumped by every mutation, so a consumer can skip rebuilding. */
    this._rev = 0;
    this._morph = null;
    this.onChange = null;
    if (cols !== 2 || rows !== 2) this.setGrid(cols, rows);
  }

  /** Blend toward the spline. 0 leaves the projective surface untouched. */
  setCurve(a) {
    a = Math.max(0, Math.min(1, +a || 0));
    if (a === this.curve) return false;
    this.curve = a;
    this._changed();
    return true;
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
   * The FLAT surface: projective at every level — over the whole quad at 2x2,
   * and within the containing cell above that. This is what the renderer draws
   * at curve 0, which is what makes subdivision shape-preserving: measured
   * worst deviation 3.3e-16 over 81 probes across 3x3, 5x5, 9x5, 17x17.
   */
  _sampleFlat(u, v) {
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
   * Control point with one step of LINEAR EXTRAPOLATION outside the net, which
   * is what a Catmull-Rom needs for its end tangents.
   *
   * Extrapolation, not clamping. Clamping (`P[-1] = P[0]`) gives a zero end
   * tangent, so the surface flattens into every border of the net — on a
   * cylinder mapped across three columns that is visible as the image going
   * slack at the left and right edges, exactly where alignment matters most.
   * `2*P0 - P1` instead continues the curve, and has the property the flat
   * case needs: over collinear points it reproduces the straight line.
   *
   * The two axes are independent linear operators, so a corner ghost is the
   * same value whichever axis is extrapolated first.
   */
  _ctl(i, j) {
    const C = this.cols, R = this.rows;
    if (i < 0) {
      const a = this._ctl(0, j), b = this._ctl(1, j);
      return { x: 2 * a.x - b.x, y: 2 * a.y - b.y };
    }
    if (i > C - 1) {
      const a = this._ctl(C - 1, j), b = this._ctl(C - 2, j);
      return { x: 2 * a.x - b.x, y: 2 * a.y - b.y };
    }
    if (j < 0) {
      const a = this._ctl(i, 0), b = this._ctl(i, 1);
      return { x: 2 * a.x - b.x, y: 2 * a.y - b.y };
    }
    if (j > R - 1) {
      const a = this._ctl(i, R - 1), b = this._ctl(i, R - 2);
      return { x: 2 * a.x - b.x, y: 2 * a.y - b.y };
    }
    return this.pts[j * C + i];
  }

  // ── Tangents ──────────────────────────────────────────────────────────────

  /**
   * The tangent at a control point along one axis — the explicit override if
   * one has been dragged, otherwise the Catmull-Rom value derived from the
   * neighbours.
   *
   * This is the ONE place the two answers meet. A handle is a view on this
   * number, and the renderer reads the same call, so a dragged handle and the
   * drawn surface cannot describe different curves.
   */
  tangent(i, j, axis) {
    const t = this.tans[this.idx(i, j)]?.[axis];
    if (t) return { x: t[0], y: t[1], explicit: true };
    const a = axis === 'u' ? this._ctl(i + 1, j) : this._ctl(i, j + 1);
    const b = axis === 'u' ? this._ctl(i - 1, j) : this._ctl(i, j - 1);
    return { x: (a.x - b.x) / 2, y: (a.y - b.y) / 2, explicit: false };
  }

  /**
   * The twist term, always derived. It has no handle and is not meant to: a
   * twist is the second cross-derivative, it has no legible position on screen,
   * and leaving it derived keeps a dragged u-handle from silently reshaping the
   * v direction. Zeroing it instead would be the usual shortcut (a Ferguson
   * patch) and would NOT reproduce Catmull-Rom, which is the property §12
   * exists to hold.
   */
  _twist(i, j) {
    const a = this._ctl(i + 1, j + 1), b = this._ctl(i - 1, j + 1);
    const c = this._ctl(i + 1, j - 1), d = this._ctl(i - 1, j - 1);
    return { x: (a.x - b.x - c.x + d.x) / 4, y: (a.y - b.y - c.y + d.y) / 4 };
  }

  /**
   * Override a tangent. Pass the VECTOR, not the handle position.
   *
   * REFUSES anything non-finite, and clamps the magnitude. This is not
   * defensive tidiness — an unvalidated NaN here put 456 of 625 render-net
   * vertices non-finite, and a Float32Array of NaN handed to drawArrays is a
   * driver fault. Chrome runs one GPU process for every window, so the output
   * window taking that fault lost the MAIN window's context too: the whole
   * instrument went black from one handle drag. The popup divides by
   * `window.innerWidth`, which is 0 for a frame while a window goes
   * fullscreen, so Infinity was one resize away the entire time.
   *
   * TAN_MAX is 4 screen-widths. A tangent that large is already meaningless —
   * the span it governs is at most one cell — so clamping costs nothing real
   * and keeps every sample bounded.
   */
  setTangent(i, j, axis, dx, dy) {
    if (axis !== 'u' && axis !== 'v') return false;
    const k = this.idx(i, j);
    if (!this.pts[k]) return false;
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return false;
    const TAN_MAX = 4;
    const mag = Math.hypot(dx, dy);
    if (mag > TAN_MAX) { dx = dx / mag * TAN_MAX; dy = dy / mag * TAN_MAX; }
    (this.tans[k] ??= {})[axis] = [dx, dy];
    this._changed();
    return true;
  }

  /** Drop an override, returning that tangent to the derived value. */
  clearTangent(i, j, axis) {
    const k = this.idx(i, j), e = this.tans[k];
    if (!e || !e[axis]) return false;
    delete e[axis];
    if (!e.u && !e.v) delete this.tans[k];
    this._changed();
    return true;
  }

  /** Drop every override. */
  clearTangents() {
    if (!Object.keys(this.tans).length) return false;
    this.tans = {};
    this._changed();
    return true;
  }

  /** How many tangents are currently overridden (both axes counted). */
  get tangentCount() {
    return Object.values(this.tans).reduce((n, e) => n + (e.u ? 1 : 0) + (e.v ? 1 : 0), 0);
  }

  /**
   * Bicubic Hermite over the containing cell.
   *
   * Reproduces the tensor-product Catmull-Rom this started as, to 2 ulps, as
   * long as every tangent is derived — that equality is asserted in §12 and is
   * what makes an existing mesh sample identically. What it adds is a seam
   * where a handle can substitute one tangent without touching anything else.
   */
  _sampleSpline(u, v) {
    const C = this.cols, R = this.rows;
    const gu = u * (C - 1), gv = v * (R - 1);
    const cu = Math.max(0, Math.min(C - 2, Math.floor(gu)));
    const cv = Math.max(0, Math.min(R - 2, Math.floor(gv)));
    const lu = gu - cu, lv = gv - cv;
    const pu = hermiteP(lu), tu = hermiteT(lu);
    const pv = hermiteP(lv), tv = hermiteT(lv);
    let x = 0, y = 0;
    for (let a = 0; a < 2; a++) {
      for (let b = 0; b < 2; b++) {
        const i = cu + a, j = cv + b;
        const P = this._ctl(i, j);
        const Tu = this.tangent(i, j, 'u');
        const Tv = this.tangent(i, j, 'v');
        const Tw = this._twist(i, j);
        const pp = pu[a] * pv[b], tp = tu[a] * pv[b];
        const pt = pu[a] * tv[b], tt = tu[a] * tv[b];
        x += pp * P.x + tp * Tu.x + pt * Tv.x + tt * Tw.x;
        y += pp * P.y + tp * Tu.y + pt * Tv.y + tt * Tw.y;
      }
    }
    return { x, y };
  }

  /**
   * Evaluate the surface at u,v. THE single definition — the renderer's net,
   * the calibration grid and setGrid all route through this one call, so
   * changing the interpolation changes all three at once and none of them can
   * describe a shape the others are not drawing.
   *
   * At curve 0 this is the flat sample VERBATIM, not a blend that happens to
   * land there: the projective path must stay bit-exact, because a 2x2 mesh is
   * asserted byte-identical to the corner-pin path it replaced.
   *
   * 2x2 stays flat at ANY curve, and that guard is load-bearing rather than
   * cosmetic. Four corners carry no curvature information, so the Catmull-Rom
   * over their extrapolated ghosts is exactly the BILINEAR surface — which on
   * a keystoned quad differs from the projective one by a third of the frame.
   * Blending toward it would silently drag a calibrated keystone off the wall.
   * Curvature needs interior points; the grid has to be raised first.
   */
  sample(u, v) {
    const flat = this._sampleFlat(u, v);
    const a = this.curve;
    if (!(a > 0) || this.isQuad) return flat;
    const s = this._sampleSpline(u, v);
    return { x: flat.x + (s.x - flat.x) * a,
             y: flat.y + (s.y - flat.y) * a };
  }

  /**
   * A denser net of SAMPLED points for the renderer to draw.
   *
   * The output window draws one projective quad per cell of whatever net it is
   * handed. That reproduces the surface exactly while the surface is flat, and
   * cuts every curve into chords the moment it is not — so a curved surface
   * has to arrive already tessellated, or the picture and `sample()` become
   * two truths about one shape (which is the bug this whole subsystem paid for
   * on 2026-09-22). Sampling HERE, in the window that owns the mesh, is the
   * same rule the calibration grid already follows: the popup never
   * re-implements the surface maths.
   *
   * At sub 1 this returns the control net itself, so the flat path is
   * unchanged rather than merely equivalent.
   */
  renderNet(sub = 1) {
    sub = Math.max(1, Math.min(16, Math.round(sub) || 1));
    if (sub === 1) {
      return { cols: this.cols, rows: this.rows,
               pts: this.pts.map(p => ({ x: p.x, y: p.y })) };
    }
    const C = (this.cols - 1) * sub + 1, R = (this.rows - 1) * sub + 1;
    const pts = [];
    let bad = 0;
    for (let j = 0; j < R; j++) {
      for (let i = 0; i < C; i++) {
        const u = i / (C - 1), v = j / (R - 1);
        const p = this.sample(u, v);
        // The LAST line before a GPU buffer. Every producer upstream is
        // guarded, and this is here anyway, because a non-finite vertex is
        // not a wrong picture — it is a driver fault that takes every WebGL
        // context in the browser with it. Falling back to the flat sample
        // keeps the surface drawable; a vertex that still will not resolve is
        // pinned to the quad, which is always finite.
        if (Number.isFinite(p.x) && Number.isFinite(p.y)) {
          pts.push({ x: p.x, y: p.y });
        } else {
          bad++;
          const f = this._sampleFlat(u, v);
          pts.push(Number.isFinite(f.x) && Number.isFinite(f.y)
            ? { x: f.x, y: f.y } : { x: u, y: v });
        }
      }
    }
    if (bad) console.warn(`[ProjMesh] ${bad} non-finite vertices replaced — a tangent or control point is out of range`);
    return { cols: C, rows: R, pts };
  }

  /**
   * How finely a cell must be cut for the curve to read as a curve rather than
   * as a fan of chords. 1 while flat — there is nothing to approximate, and a
   * flat net drawn at sub 1 is the path every existing measurement was made
   * against. Above that the budget is fixed in TOTAL vertices, not per cell,
   * so a 17x17 net does not multiply into a quarter of a million points.
   */
  renderSub() {
    if (!(this.curve > 0) || this.isQuad) return 1;
    const span = Math.max(this.cols - 1, this.rows - 1);
    return Math.max(1, Math.min(12, Math.floor(48 / span)));
  }

  /**
   * Resize the control grid, PRESERVING the current shape by resampling the
   * existing surface. Going 2x2 -> 3x3 must not move a single projected pixel;
   * a grid that jumped on subdivision would be unusable for calibration,
   * because you would have to re-align after every change of resolution.
   *
   * That exactness is a property of the PROJECTIVE surface — a cell reproduces
   * the global homography from its four corners, so resampling is lossless.
   * A spline is not closed under subdivision the same way: with curve > 0 the
   * new net lands exactly on the current curved surface (so every control
   * point still sits where it was put, and the shape is right AT the knots),
   * but re-splining that net moves the surface slightly BETWEEN them. Measured
   * in tests/audit-projmap-curve.mjs rather than assumed; the error shrinks as
   * the net gets finer, which is the direction subdivision goes.
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
    // Overrides are keyed by an index into the OLD net, so they cannot survive
    // a resize — index 4 of a 3x3 and of a 5x5 are different places on the
    // surface, and carrying them over would move handles the user never
    // touched. Dropping them costs little: the new net is sampled from the
    // curved surface, so the shape the handles produced is already in the
    // points. Said out loud because silently re-keying would be worse.
    this.tans = {};
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
    this.tans = {};
    if (c !== 2 || r !== 2) this.setGrid(c, r); else this._changed();
  }

  // ── Serialization ─────────────────────────────────────────────────────────

  serialize() {
    const d = { cols: this.cols, rows: this.rows,
                pts: this.pts.map(p => [+p.x.toFixed(6), +p.y.toFixed(6)]) };
    // Omitted entirely when nothing is overridden, so a mesh shaped without
    // handles writes the same object it always did and an older build reads it
    // back unchanged.
    if (this.tangentCount) {
      d.tans = {};
      for (const [k, e] of Object.entries(this.tans)) {
        const o = {};
        if (e.u) o.u = [+e.u[0].toFixed(6), +e.u[1].toFixed(6)];
        if (e.v) o.v = [+e.v[0].toFixed(6), +e.v[1].toFixed(6)];
        d.tans[k] = o;
      }
    }
    return d;
  }

  deserialize(d) {
    if (!d || !Array.isArray(d.pts)) return false;
    const n = (d.cols | 0) * (d.rows | 0);
    if (n !== d.pts.length || n < 4) return false;
    this.cols = d.cols; this.rows = d.rows;
    this.pts = d.pts.map(p => ({ x: p[0], y: p[1] }));
    // Absent in every mesh saved before handles existed, and in every mesh
    // shaped without them — so its absence is the normal case, not an error.
    // Entries outside the net are dropped rather than trusted: a file edited
    // by hand, or written by a build with a different net, must not be able to
    // park a tangent on an index that has no point.
    this.tans = {};
    if (d.tans && typeof d.tans === 'object') {
      for (const [k, e] of Object.entries(d.tans)) {
        const i = +k;
        if (!Number.isInteger(i) || i < 0 || i >= n || !e) continue;
        // Finite check on the way IN as well as on the way out. JSON has no
        // NaN, so a bad tangent serializes as `null` and reads back as 0 —
        // but a file written by hand, a future format, or an in-memory copy
        // that never went through JSON all can carry one, and a single
        // non-finite tangent is enough to fault the GPU.
        const fin = (a) => Array.isArray(a) && a.length === 2 &&
                           Number.isFinite(+a[0]) && Number.isFinite(+a[1]);
        const o = {};
        if (fin(e.u)) o.u = [+e.u[0], +e.u[1]];
        if (fin(e.v)) o.v = [+e.v[0], +e.v[1]];
        if (o.u || o.v) this.tans[i] = o;
      }
    }
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
   * Meshes of DIFFERENT grid sizes morph too. An earlier version snapped,
   * on the reasoning that there is no correspondence between a 3x3 and a 5x5
   * control net — but that was wrong, and in practice it meant the fade
   * "did not work" for anyone whose slots were not all the same size.
   *
   * setGrid resamples EXACTLY (measured 3.3e-16), so both meshes can be
   * expressed on a common net losslessly and then interpolated point by point.
   * The common net is the FINER of the two in each axis: coarsening the finer
   * one would throw away its interior detail, so the maximum is the only
   * choice that loses nothing.
   */
  beginMorph(slot, secs = 0) {
    let data = null;
    try { data = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')[slot] ?? null; }
    catch { data = null; }
    if (!data) return false;
    if (!(secs > 0)) return this.deserialize(data);

    // Express the TARGET on a net at least as fine as either side.
    const target = new ProjMapMesh();
    if (!target.deserialize(data)) return false;
    // setGrid resamples through sample(), which reads `curve` — so the target
    // must carry THIS mesh's curve or the two sides are resampled on different
    // surfaces and the crossfade starts from a shape neither of them is.
    target.curve = this.curve;
    const C = Math.max(this.cols, target.cols);
    const R = Math.max(this.rows, target.rows);
    target.setGrid(C, R);
    this.setGrid(C, R);          // shape-preserving on this side too

    this._morph = {
      from: this.pts.map(p => ({ x: p.x, y: p.y })),
      to:   target.pts.map(p => ({ x: p.x, y: p.y })),
      t: 0, dur: secs,
      ...this._morphTangents(target),
    };
    return true;
  }

  /**
   * Tangent state for a crossfade — and NOTHING when neither side has a
   * handle on it, which is the overwhelmingly common case and the one every
   * existing measurement was made against.
   *
   * When either side does, both are snapshotted as EFFECTIVE tangents
   * (explicit where set, derived otherwise) and interpolated as explicit
   * values for the duration. They have to be pinned like that: a derived
   * tangent is recomputed from the neighbours every sample, so leaving them
   * derived would make the tangents chase the moving points instead of
   * travelling between the two saved shapes, and the crossfade would pass
   * through surfaces belonging to neither.
   */
  _morphTangents(target) {
    if (!this.tangentCount && !target.tangentCount) return {};
    const snap = (m) => {
      const out = [];
      for (let j = 0; j < m.rows; j++) {
        for (let i = 0; i < m.cols; i++) {
          const u = m.tangent(i, j, 'u'), v = m.tangent(i, j, 'v');
          out.push({ u: [u.x, u.y], v: [v.x, v.y] });
        }
      }
      return out;
    };
    // The set to END on: whatever the TARGET holds explicitly. Anything else
    // goes back to derived, so a shape saved without handles recalls without
    // them rather than inheriting a frozen copy of the shape it faded from.
    const land = {};
    for (const [k, e] of Object.entries(target.tans)) {
      land[k] = { ...(e.u ? { u: [...e.u] } : {}), ...(e.v ? { v: [...e.v] } : {}) };
    }
    return { tanFrom: snap(this), tanTo: snap(target), tanLand: land };
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
    if (m.tanFrom) {
      for (let k = 0; k < m.tanFrom.length; k++) {
        const f = m.tanFrom[k], t = m.tanTo[k];
        this.tans[k] = {
          u: [f.u[0] + (t.u[0] - f.u[0]) * s, f.u[1] + (t.u[1] - f.u[1]) * s],
          v: [f.v[0] + (t.v[0] - f.v[0]) * s, f.v[1] + (t.v[1] - f.v[1]) * s],
        };
      }
    }
    if (m.t >= 1) {
      if (m.tanLand) this.tans = m.tanLand;
      this._morph = null;
    }
    this._changed();
    return true;
  }

  _changed() { this._rev++; if (this.onChange) this.onChange(); }
}
