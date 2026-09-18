/**
 * HypercubeUI.js
 * Build a hypercube control panel matching the ImWeb param-row pattern.
 * No external dependencies beyond HypercubeGeometry.js imports.
 */

import {
  DIMENSION_COLORS,
  MAX_DIM,
  rotationPlaneCount,
  vertexCount,
  edgeCount,
} from './HypercubeGeometry.js';


// ── Layout ──────────────────────────────────────────────────────────────────
// One panel, grouped the way the cube is built. Every row below is a STANDARD
// param row (badge → LFO/MIDI/OSC, live value, same units everywhere); the
// hand-built rows it replaces had no badges, read ps once and went stale, and
// disagreed with the badge rows on units and names (owner, 2026-09-18).
// tests/audit-hypercube.mjs checks every hypercube param sits in exactly one
// of these lists, so a new param cannot silently get no row.
export const HC_DIMENSION_IDS = ['hypercube.dim', 'hypercube.morphDuration', 'hypercube.easing'];
export const HC_SECTIONS = [
  { title: 'Projection',     ids: ['hypercube.projMode', 'hypercube.wDistance', 'hypercube.scale'] },
  // The Plane Bank: each slot is a plane menu + its speed. Slots 1–4 speeds
  // are the old rot.xy/xz/yz/xw ids (see main.js); 5–8 fold away.
  { title: 'Rotation',       ids: ['hypercube.slot1.plane', 'hypercube.rot.xy', 'hypercube.slot2.plane', 'hypercube.rot.xz',
                                   'hypercube.slot3.plane', 'hypercube.rot.yz', 'hypercube.slot4.plane', 'hypercube.rot.xw'],
    fold: { title: 'Slots 5–8', ids: ['hypercube.slot5.plane', 'hypercube.slot5.speed', 'hypercube.slot6.plane', 'hypercube.slot6.speed',
                                      'hypercube.slot7.plane', 'hypercube.slot7.speed', 'hypercube.slot8.plane', 'hypercube.slot8.speed'] } },
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

/**
 * Build the hypercube panel ONCE. Returns { panel, refresh }: every row is a
 * standard param row that follows its param by itself, so a state recall
 * needs nothing rebuilt — rebuilding the whole panel per recall leaked every
 * row's param listeners and a 200 ms interval each time.
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

  // ── Sections ────────────────────────────────────────────────────────────
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
    if (sec.fold) {
      const { body } = _collapsible(wrap, sec.fold.title, false);
      for (const id of sec.fold.ids) body.appendChild(rowFor(id));
    }
    panel.appendChild(wrap);
  }

  function refresh() {
    const d = hypercube.dim, target = hypercube.targetDim ?? d;
    const lim = hypercube._hInstancer?._visible ? hypercube._hInstancer.budgetLimit : null;
    stats.textContent = `${d}D · ${vertexCount(d)} verts · ${edgeCount(d)} edges · ${rotationPlaneCount(d)} planes` +
      (lim ? ` · instances ${lim.drawn}/${lim.wanted} (Inst Budget)` : '');
    stats.classList.toggle('limited', !!lim);
    for (const p of pills) p.classList.toggle('active', Number(p.dataset.dim) === target);
  }
  refresh();
  setInterval(refresh, 200);   // once — the panel is never rebuilt

  container.appendChild(panel);
  return { panel, refresh };
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
