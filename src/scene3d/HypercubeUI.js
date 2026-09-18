/**
 * HypercubeUI.js
 * Build a hypercube control panel matching the ImWeb param-row pattern.
 * No external dependencies beyond HypercubeGeometry.js imports.
 */

import {
  DIMENSION_COLORS,
  EASING,
  MAX_DIM,
  rotationPlaneCount,
  vertexCount,
  edgeCount,
} from './HypercubeGeometry.js';

const EASING_KEYS = Object.keys(EASING);

// ── Layout ──────────────────────────────────────────────────────────────────
// One panel, grouped the way the cube is built. Every row below is a STANDARD
// param row (badge → LFO/MIDI/OSC, live value, same units everywhere); the
// hand-built rows it replaces had no badges, read ps once and went stale, and
// disagreed with the badge rows on units and names (owner, 2026-09-18).
// tests/audit-hypercube.mjs checks every hypercube param sits in exactly one
// of these lists, so a new param cannot silently get no row.
export const HC_DIMENSION_IDS = ['hypercube.dim', 'hypercube.morphDuration'];
export const HC_SECTIONS = [
  { title: 'Projection',     ids: ['hypercube.projMode', 'hypercube.wDistance', 'hypercube.scale'] },
  { title: 'Rotation',       ids: ['hypercube.rot.xy', 'hypercube.rot.xz', 'hypercube.rot.yz', 'hypercube.rot.xw'],
    morePlanes: true },
  { title: 'Edges & Points', ids: ['hypercube.renderMode', 'hypercube.edgeWidth', 'hypercube.edgeOpacity',
                                   'hypercube.pointSize', 'hypercube.depthCue'] },
  { title: 'Faces',          ids: ['hypercube.faces.active', 'hypercube.faces.opacity', 'hypercube.faces.blend',
                                   'hypercube.faces.hue', 'hypercube.faces.sat', 'hypercube.faces.texsrc',
                                   'hypercube.faces.masksrc', 'hypercube.faces.maskinv', 'hypercube.faces.masklvl'],
    openWhen: 'hypercube.faces.active' },
  { title: 'Instancer',      ids: ['hypercube.inst.active', 'hypercube.inst.showGeo', 'hypercube.inst.geo',
                                   'hypercube.inst.scale', 'hypercube.inst.opacity', 'hypercube.inst.texsrc',
                                   'hypercube.inst.budget'],
    openWhen: 'hypercube.inst.active' },
];

// Planes that have a param are shown as its row; the rest are live-only.
const _ROT_PARAM = { '0,1': 'hypercube.rot.xy', '0,2': 'hypercube.rot.xz', '1,2': 'hypercube.rot.yz', '0,3': 'hypercube.rot.xw' };
const _AXIS = 'XYZWVUTSRQPO';

/**
 * Build the hypercube panel ONCE. Returns { panel, refresh }: standard rows
 * follow their params by themselves, so a state recall only needs refresh()
 * for the live-only extra planes — rebuilding the whole panel per recall
 * leaked every row's param listeners and a 200 ms interval each time.
 *
 * @param {HTMLElement}     container
 * @param {HypercubeObject} hypercube
 * @param {ParameterSystem} ps
 * @param {(id:string) => HTMLElement} rowFor  – builds a standard param row
 */
export function buildHypercubePanel(container, hypercube, ps, rowFor) {
  const panel = document.createElement('div');
  panel.className = 'hc-panel';

  // ── Header: dimension pills + stats ─────────────────────────────────────
  const stats = document.createElement('div');
  stats.className = 'hc-stats';
  panel.appendChild(stats);

  const pillRow = document.createElement('div');
  pillRow.className = 'hc-pills';
  const pills = [];
  for (let d = 4; d <= MAX_DIM; d++) {
    const col  = DIMENSION_COLORS[d] ?? '#ffffff';
    const pill = document.createElement('button');
    pill.textContent = `${d}D`;
    pill.dataset.dim = d;
    pill.style.setProperty('--pill', col);
    // Through the param, like any controller: it morphs over Morph Time.
    pill.addEventListener('click', () => ps.set('hypercube.dim', d));
    pillRow.appendChild(pill);
    pills.push(pill);
  }
  panel.appendChild(pillRow);
  for (const id of HC_DIMENSION_IDS) panel.appendChild(rowFor(id));
  // Easing is a panel preference, not a param (never saved) — the dim handler
  // reads it from the object so pills, drags and controllers ease alike.
  hypercube.morphEasing ??= 'easeInOut';
  _selectRow(panel, 'Easing', EASING_KEYS, EASING_KEYS.indexOf(hypercube.morphEasing), idx => {
    hypercube.morphEasing = EASING_KEYS[idx];
  });

  // ── Sections ────────────────────────────────────────────────────────────
  let moreBody = null;
  for (const sec of HC_SECTIONS) {
    const wrap = document.createElement('div');
    wrap.className = 'panel-subsection';
    const hdr = document.createElement('div');
    hdr.className = 'subsection-header';
    hdr.textContent = sec.title;
    // Wired here; the flag stops main.js's sweep of .subsection-header wiring
    // it a second time (two toggles per click = no toggle), whichever of the
    // two runs first.
    hdr.dataset.collapseWired = '1';
    hdr.addEventListener('click', () => {
      wrap.classList.toggle('collapsed');
      hdr.classList.toggle('collapsed', wrap.classList.contains('collapsed'));
    });
    wrap.appendChild(hdr);
    for (const id of sec.ids) wrap.appendChild(rowFor(id));

    if (sec.openWhen) {
      // Faces / Instancer: closed while off, and opened when switched on —
      // by a hand, a controller or a recall.
      const setOpen = on => { wrap.classList.toggle('collapsed', !on); hdr.classList.toggle('collapsed', !on); };
      setOpen(!!ps.get(sec.openWhen)?.value);
      ps.get(sec.openWhen)?.onChange(v => { if (v) setOpen(true); });
    }
    if (sec.morePlanes) {
      const { body } = _collapsible(wrap, 'More planes — live only, not saved', false);
      moreBody = body;
    }
    panel.appendChild(wrap);
  }

  // Planes beyond the four with params: live speeds on the object, rebuilt
  // when the dimension changes (the plane count does).
  let planesDim = -1;
  function rebuildMorePlanes() {
    if (!moreBody) return;
    moreBody.textContent = '';
    const dim = hypercube.dim;
    let idx = 0;
    for (let i = 0; i < dim; i++) {
      for (let j = i + 1; j < dim; j++, idx++) {
        if (_ROT_PARAM[`${i},${j}`]) continue;
        const pIdx = idx;
        _paramRow(moreBody, `Rot ${_AXIS[i]}${_AXIS[j]}`, hypercube._rotSpeeds?.[pIdx] ?? 0, -2, 2, 0.01,
          v => hypercube.setRotationSpeed(pIdx, v));
      }
    }
    if (!moreBody.children.length) {
      const none = document.createElement('div');
      none.className = 'hc-note';
      none.textContent = 'All planes of this dimension have rows above.';
      moreBody.appendChild(none);
    }
  }

  function refresh() {
    const d = hypercube.dim, target = hypercube.targetDim ?? d;
    const lim = hypercube._hInstancer?._visible ? hypercube._hInstancer.budgetLimit : null;
    stats.textContent = `${d}D · ${vertexCount(d)} verts · ${edgeCount(d)} edges · ${rotationPlaneCount(d)} planes` +
      (lim ? ` · instances ${lim.drawn}/${lim.wanted} (Inst Budget)` : '');
    stats.classList.toggle('limited', !!lim);
    for (const p of pills) p.classList.toggle('active', Number(p.dataset.dim) === target);
    if (d !== planesDim) { planesDim = d; rebuildMorePlanes(); }
  }
  refresh();
  setInterval(refresh, 200);   // once — the panel is never rebuilt

  container.appendChild(panel);
  return { panel, refresh: () => { planesDim = -1; refresh(); } };
}

// ── DOM helpers ───────────────────────────────────────────────────────────────

function _collapsible(parent, label, open = true) {
  const group  = document.createElement('div');
  const toggle = document.createElement('div');
  toggle.style.cssText = `
    padding:2px 8px;cursor:pointer;color:var(--text-2,#8888a0);
    font-size:10px;display:flex;align-items:center;gap:4px;
  `;
  const arrow = document.createElement('span');
  arrow.textContent = open ? '▾' : '▸';

  toggle.appendChild(arrow);
  toggle.appendChild(document.createTextNode(' ' + label));

  const body = document.createElement('div');
  body.style.display = open ? 'block' : 'none';

  toggle.addEventListener('click', () => {
    const isOpen = body.style.display !== 'none';
    body.style.display = isOpen ? 'none' : 'block';
    arrow.textContent  = isOpen ? '▸' : '▾';
  });

  group.appendChild(toggle);
  group.appendChild(body);
  parent.appendChild(group);
  return { group, body };
}

/**
 * Param row: [label] [draggable value display]
 * Drag: (startY – currentY) × step × 0.5; Shift = ×10.
 * Double-click opens inline number input; Enter commits, Escape cancels.
 */
function _paramRow(parent, label, value, min, max, step, onChange) {
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;align-items:center;padding:2px 8px;gap:6px;';

  const lbl = document.createElement('span');
  lbl.textContent = label;
  lbl.style.cssText = 'flex:1;color:var(--text-1,#e0e0f0);min-width:60px;';

  const display = document.createElement('span');
  display.style.cssText = `
    min-width:44px;text-align:right;color:var(--accent,#c8a020);
    cursor:ns-resize;user-select:none;
  `;

  let current = value;

  const fmt = v => step < 1 ? v.toFixed(2) : String(Math.round(v));
  display.textContent = fmt(current);

  let dragging = false, startY = 0, startVal = 0;

  // Window listeners live only for the length of a drag. Registered per row
  // for the row's lifetime, they were never removed — rebuildRotationRows()
  // discards its rows on every dimension change, leaking two each (132 at 12D).
  const onMove = e => {
    if (!dragging) return;
    const mult = e.shiftKey ? 10 : 1;
    const delta = (startY - e.clientY) * step * 0.5 * mult;
    current = Math.max(min, Math.min(max, startVal + delta));
    display.textContent = fmt(current);
    onChange(current);
  };
  const onUp = () => {
    dragging = false;
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
  };
  display.addEventListener('mousedown', e => {
    dragging = true; startY = e.clientY; startVal = current;
    e.preventDefault();
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  });

  display.addEventListener('dblclick', () => {
    const input = document.createElement('input');
    input.type  = 'number';
    input.value = current;
    input.min   = min; input.max = max; input.step = step;
    input.style.cssText = 'width:60px;background:#1a1a22;color:#e0e0f0;border:1px solid #555;font-size:11px;padding:1px 3px;';
    row.replaceChild(input, display);
    input.focus();
    const commit = () => {
      const v = Math.max(min, Math.min(max, parseFloat(input.value) || current));
      current = v;
      display.textContent = fmt(v);
      if (row.contains(input)) row.replaceChild(display, input);
      onChange(v);
    };
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter')  commit();
      if (e.key === 'Escape' && row.contains(input)) row.replaceChild(display, input);
    });
    input.addEventListener('blur', commit);
  });

  row.appendChild(lbl);
  row.appendChild(display);
  parent.appendChild(row);
  return row;
}

function _selectRow(parent, label, options, selectedIdx, onChange) {
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;align-items:center;padding:2px 8px;gap:6px;';

  const lbl = document.createElement('span');
  lbl.textContent = label;
  lbl.style.cssText = 'flex:1;color:var(--text-1,#e0e0f0);min-width:60px;';

  const sel = document.createElement('select');
  sel.style.cssText = `
    background:var(--bg-2,#18181f);color:var(--text-1,#e0e0f0);
    border:1px solid #444;font-size:10px;font-family:monospace;padding:1px 3px;
  `;
  options.forEach((opt, i) => {
    const o = document.createElement('option');
    o.value = i; o.textContent = opt;
    if (i === selectedIdx) o.selected = true;
    sel.appendChild(o);
  });
  sel.addEventListener('change', () => onChange(parseInt(sel.value)));

  row.appendChild(lbl);
  row.appendChild(sel);
  parent.appendChild(row);
  return row;
}
