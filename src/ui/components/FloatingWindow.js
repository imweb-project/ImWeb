/**
 * FloatingWindow — drag by a handle, resize from the corner (CSS `resize:
 * both` on the box), geometry remembered per origin and clamped back on
 * screen on every placement.
 *
 * ONE implementation for every floating tool window (the docs viewer, ⌘K
 * parameter search). Two windows with their own copies of this would drift —
 * LEARNED.md 2026-09-22, "one thing shown two ways".
 *
 * Geometry is stored in VIEWPORT px and written through setViewportPos/Size,
 * so it is right at any --ui-scale (the boxes are zoomed; their layers are
 * not). A box that is collapsed keeps its last expanded height.
 */
import { setViewportPos, setViewportSize, elementZoom } from '../layout/LayoutManager.js';
import { clampPos, clampSize } from '../layout/PanelLayout.js';

/**
 * @param box      the window element (zoomed, `resize: both` in CSS)
 * @param handle   the element that drags it (title bar); buttons inside are ignored
 * @param storeKey localStorage key for { x, y, w, h }
 * @param opts.isCollapsed () => bool — a collapsed box keeps its saved height
 * @param opts.isHidden    () => bool — no saving while hidden
 * @param opts.defaultPos  (w, h, vw, vh) => { x, y } for a first open
 * @returns {{ place(): void, save(): void }}
 */
export function makeFloating(box, handle, storeKey, opts = {}) {
  const isCollapsed = opts.isCollapsed ?? (() => false);
  const isHidden = opts.isHidden ?? (() => false);
  const defaultPos = opts.defaultPos ?? ((w, h, vw, vh) => ({ x: (vw - w) / 2, y: (vh - h) / 2 }));

  const load = () => {
    try { return JSON.parse(localStorage.getItem(storeKey)) || null; }
    catch { return null; }
  };
  const save = () => {
    const b = box.getBoundingClientRect();
    const prev = load() || {};
    const g = {
      x: Math.round(b.left),
      y: Math.round(b.top),
      w: Math.round(b.width),
      h: isCollapsed() ? prev.h ?? null : Math.round(b.height),
    };
    try { localStorage.setItem(storeKey, JSON.stringify(g)); } catch { /* private mode */ }
  };

  /** Saved geometry if any, else defaultPos. Call AFTER un-hiding: a hidden
   *  node has no computed zoom. */
  const place = () => {
    const vw = window.innerWidth, vh = window.innerHeight;
    const z = elementZoom(box);
    const g = load();
    if (g && Number.isFinite(g.w)) {
      const size = clampSize(g.w, Number.isFinite(g.h) ? g.h : null, vw, vh);
      setViewportSize(box, size.w, size.h, z);
    }
    const b = box.getBoundingClientRect();
    const d = g && Number.isFinite(g.x) ? { x: g.x, y: g.y } : defaultPos(b.width, b.height, vw, vh);
    const pos = clampPos(d.x, d.y, b.width, b.height, vw, vh);
    setViewportPos(box, pos.x, pos.y, z);
  };

  // Drag. gBCR, not offsetLeft: the box is zoomed by --ui-scale, and mixing
  // element px with clientX makes it jump on grab.
  let pid = null, ox = 0, oy = 0, z = 1;
  handle.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button, input') || e.button !== 0) return;
    handle.setPointerCapture(e.pointerId);
    pid = e.pointerId;
    z = elementZoom(box);
    const b = box.getBoundingClientRect();
    ox = e.clientX - b.left;
    oy = e.clientY - b.top;
    e.preventDefault();
  });
  handle.addEventListener('pointermove', (e) => {
    if (pid !== e.pointerId) return;
    const b = box.getBoundingClientRect();
    const pos = clampPos(e.clientX - ox, e.clientY - oy, b.width, b.height,
      window.innerWidth, window.innerHeight);
    setViewportPos(box, pos.x, pos.y, z);
  });
  const endDrag = (e) => {
    if (pid !== e.pointerId) return;
    pid = null;
    save();
  };
  handle.addEventListener('pointerup', endDrag);
  handle.addEventListener('pointercancel', endDrag);

  // `resize: both` has no event of its own; remember the size it leaves.
  let t = null;
  new ResizeObserver(() => {
    if (isHidden() || isCollapsed()) return;
    clearTimeout(t);
    t = setTimeout(save, 200);
  }).observe(box);

  return { place, save };
}
