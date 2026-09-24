/**
 * ClipStrip — the clip as a bar under a model's Segment row.
 *
 * Shows: the takes (alternating bands, ⟲ loops tinted), the cut lines, a
 * motion curve (per-frame speed from ClipSegments, cut frames left out so
 * the splices do not drown the moves), the playing range, and the playhead.
 *
 * Gestures:
 *   click          play that take (through the Segment param, so Morph applies)
 *   drag           set a range; grabbing near an edge trims that edge.
 *                  With Length on, a drag moves Start (the window follows)
 *   pinch / ⌥-wheel  zoom around the pointer; shift-wheel / sideways swipe pans
 *   double-click   zoom out to the whole clip
 * Plain vertical wheel is left alone so the panel still scrolls.
 *
 * The static layers (bands, curve, cuts) are drawn once per clip / view /
 * width into an offscreen canvas; each frame only copies it and draws the
 * range and playhead. The loop idles while the strip is not on screen.
 *
 * @param {object} o
 * @param {() => ({clip, segs, cuts, speed, fps}|null)} o.data
 * @param {() => ({s:number, e:number})} o.range   seconds
 * @param {() => (number|null)} o.time              playhead, seconds
 * @param {() => boolean} o.lenLocked               Length > 0
 * @param {(i:number) => void} o.pick               take index, 0-based
 * @param {(s:number, e:number) => void} o.setRange seconds
 * @param {(s:number) => void} o.setStart           seconds
 */
export function createClipStrip(o) {
  const H = 38;
  const el = document.createElement('canvas');
  el.className = 'clip-strip';
  el.style.cssText = `display:block;width:100%;height:${H}px;margin:2px 0 6px;border-radius:3px;cursor:crosshair;touch-action:none;`;
  el.title = 'Click a take to play it · drag to set a range (near an edge trims it; with Length on, drag moves Start)\n'
    + 'Pinch or ⌥-scroll to zoom · shift-scroll to pan · double-click to zoom out';
  const ctx = el.getContext('2d');
  const base = document.createElement('canvas');
  const bctx = base.getContext('2d');

  let v0 = 0, v1 = 1, viewClip = null, baseKey = '', hoverX = null;
  const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim() || '#888';

  function view(d) {
    const cur = o.data();
    if (cur?.clip !== viewClip) { viewClip = cur?.clip ?? null; v0 = 0; v1 = d || 1; }
    return cur;
  }
  const tx = (t, W) => (t - v0) / (v1 - v0) * W;
  const xt = (x, W) => v0 + x / W * (v1 - v0);

  function drawBase(D, W, dpr) {
    const key = `${W}|${dpr}|${v0}|${v1}|${D.segs.length}|${D.clip.uuid}`;
    if (key === baseKey) return;
    baseKey = key;
    base.width = W * dpr; base.height = H * dpr;
    bctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    bctx.fillStyle = css('--bg-1');
    bctx.fillRect(0, 0, W, H);
    // Takes: alternating bands, seamless loops tinted.
    D.segs.forEach((s, i) => {
      const a = tx(s.start, W), b = tx(s.end + 1 / D.fps, W);
      if (b < 0 || a > W) return;
      bctx.fillStyle = css(i % 2 ? '--bg-2' : '--bg-3');
      bctx.fillRect(a, 0, b - a, H);
      if (s.match < 0.1) {
        bctx.globalAlpha = 0.18; bctx.fillStyle = css('--green');
        bctx.fillRect(a, 0, b - a, H); bctx.globalAlpha = 1;
      }
    });
    // Motion curve: mean speed per pixel column, cut frames skipped,
    // scaled to the 95th percentile so one violent move does not flatten it.
    const sp = D.speed, fps = D.fps;
    if (sp?.length) {
      const cutK = new Set(D.cuts.map(c => Math.round(c * fps) - 1));
      const sorted = Array.from(sp).filter((_, k) => !cutK.has(k)).sort((a, b) => a - b);
      const p95 = sorted[Math.floor(sorted.length * 0.95)] || 1;
      bctx.beginPath(); bctx.moveTo(0, H);
      for (let x = 0; x < W; x++) {
        const k0 = Math.max(0, Math.floor(xt(x, W) * fps)), k1 = Math.min(sp.length, Math.ceil(xt(x + 1, W) * fps));
        let sum = 0, n = 0;
        for (let k = k0; k < Math.max(k1, k0 + 1) && k < sp.length; k++) if (!cutK.has(k)) { sum += sp[k]; n++; }
        const v = n ? Math.min(1, sum / n / p95) : 0;
        bctx.lineTo(x, H - 2 - v * (H * 0.62));
      }
      bctx.lineTo(W, H); bctx.closePath();
      bctx.globalAlpha = 0.5; bctx.fillStyle = css('--text-2'); bctx.fill(); bctx.globalAlpha = 1;
    }
    // Cuts.
    bctx.fillStyle = css('--border-hi');
    for (const c of D.cuts) { const x = Math.round(tx(c, W)); if (x >= 0 && x <= W) bctx.fillRect(x, 0, 1, H); }
  }

  function frame() {
    requestAnimationFrame(frame);
    if (!el.isConnected || el.offsetParent === null) return;
    const D = view(o.data()?.clip?.duration);
    const W = el.clientWidth, dpr = window.devicePixelRatio || 1;
    if (!W) return;
    if (el.width !== Math.round(W * dpr) || el.height !== H * dpr) { el.width = Math.round(W * dpr); el.height = H * dpr; baseKey = ''; }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (!D) { ctx.clearRect(0, 0, el.width, el.height); return; }
    drawBase(D, W, dpr);
    ctx.drawImage(base, 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // Range.
    const r = o.range();
    const a = tx(r.s, W), b = tx(r.e, W);
    ctx.globalAlpha = 0.22; ctx.fillStyle = css('--accent'); ctx.fillRect(a, 0, b - a, H); ctx.globalAlpha = 1;
    ctx.fillStyle = css('--accent');
    ctx.fillRect(Math.round(a), 0, 2, H); ctx.fillRect(Math.round(b) - 2, 0, 2, H);
    // Playhead.
    const t = o.time();
    if (t != null) { ctx.fillStyle = css('--text-0'); ctx.fillRect(Math.round(tx(t, W)), 0, 1, H); }
    // Hover readout: the time, and the take under the pointer.
    const zoomed = v0 > 0 || v1 < D.clip.duration;
    let label = zoomed ? `${v0.toFixed(1)}–${v1.toFixed(1)} s` : '';
    if (hoverX != null) {
      const ht = xt(hoverX, W);
      const i = D.segs.findIndex(s => ht >= s.start && ht < s.end + 1 / D.fps);
      label = `${ht.toFixed(2)} s` + (i >= 0 ? ` · take ${i + 1}${D.segs[i].match < 0.1 ? ' ⟲' : ''}` : '');
    }
    if (label) {
      ctx.font = '10px monospace';
      const w = ctx.measureText(label).width + 8;
      ctx.fillStyle = 'rgba(0,0,0,0.6)'; ctx.fillRect(2, 2, w, 14);
      ctx.fillStyle = css('--text-0'); ctx.fillText(label, 6, 12);
    }
  }
  requestAnimationFrame(frame);

  // ── Gestures ───────────────────────────────────────────────────────────────
  let drag = null;
  const px = e => e.clientX - el.getBoundingClientRect().left;
  el.addEventListener('pointerdown', e => {
    const D = o.data(); if (!D || e.button !== 0) return;
    const W = el.clientWidth, x = px(e), r = o.range();
    const nearS = Math.abs(x - tx(r.s, W)) < 6, nearE = Math.abs(x - tx(r.e, W)) < 6;
    const mode = o.lenLocked() ? 'start' : nearS ? 'trimS' : nearE ? 'trimE' : 'new';
    drag = { x0: x, t0: xt(x, W), mode, moved: false, off: xt(x, W) - r.s };
    el.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  el.addEventListener('pointermove', e => {
    hoverX = px(e);
    if (!drag) return;
    const W = el.clientWidth, x = hoverX;
    if (!drag.moved && Math.abs(x - drag.x0) < 3) return;
    drag.moved = true;
    const d = o.data().clip.duration, t = Math.min(d, Math.max(0, xt(x, W))), r = o.range();
    if (drag.mode === 'start') o.setStart(Math.max(0, t - drag.off));
    else if (drag.mode === 'trimS') o.setRange(Math.min(t, r.e), Math.max(t, r.e));
    else if (drag.mode === 'trimE') o.setRange(Math.min(r.s, t), Math.max(r.s, t));
    else o.setRange(Math.min(drag.t0, t), Math.max(drag.t0, t));
  });
  const end = e => {
    if (!drag) return;
    if (!drag.moved) {
      const D = o.data();
      const i = D?.segs.findIndex(s => drag.t0 >= s.start && drag.t0 < s.end + 1 / D.fps) ?? -1;
      if (i >= 0) o.pick(i);
    }
    drag = null;
    try { el.releasePointerCapture(e.pointerId); } catch { /* already released */ }
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  el.addEventListener('pointerleave', () => { if (!drag) hoverX = null; });
  el.addEventListener('dblclick', () => { const d = o.data()?.clip.duration; if (d) { v0 = 0; v1 = d; } });
  el.addEventListener('wheel', e => {
    const d = o.data()?.clip.duration; if (!d) return;
    const W = el.clientWidth, span = v1 - v0;
    if (e.ctrlKey || e.altKey) {                    // pinch arrives as ctrl+wheel
      e.preventDefault();
      const at = xt(px(e), W);
      const ns = Math.min(d, Math.max(0.5, span * Math.exp(e.deltaY * 0.01)));
      v0 = at - (at - v0) / span * ns; v1 = v0 + ns;
    } else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      e.preventDefault();
      const dx = (e.shiftKey ? e.deltaY || e.deltaX : e.deltaX) / W * span;
      v0 += dx; v1 += dx;
    } else return;
    if (v0 < 0) { v1 -= v0; v0 = 0; }
    if (v1 > d) { v0 -= v1 - d; v1 = d; }
    v0 = Math.max(0, v0);
  }, { passive: false });

  return { el };
}
