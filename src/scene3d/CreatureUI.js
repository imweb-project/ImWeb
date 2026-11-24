/**
 * CreatureUI.js — the Creature section of the 3D workspace.
 *
 * Every row is a STANDARD param row (badge → LFO/MIDI/OSC, live value), in the
 * order of CREATURE_PARAM_IDS; tests/audit-creature.mjs checks that every
 * creature param is in that list exactly once, so a new one cannot silently
 * get no row.
 */

import { CREATURE_PARAM_IDS, CREATURE_KINDS } from './CreatureParams.js';
import { getCreatureCustom, setCreatureCustom, onCreatureCustomChange, exportCreatureFile, applyCreatureFile,
  CREATURE_FILE_EXT } from './CreatureCustom.js';

const GUIDE_URL = 'docs/Making_Creatures.md';

/**
 * Build the panel ONCE.
 * @param {HTMLElement}     container
 * @param {ParameterSystem} ps
 * @param {(id:string) => HTMLElement} rowFor  – builds a standard param row
 * @param {(url:string, title:string) => void} [openGuide] – opens a manual page in the docs viewer
 */
export function buildCreaturePanel(container, ps, rowFor, openGuide) {
  const panel = document.createElement('div');
  panel.className = 'creature-panel';
  const rows = new Map();
  for (const id of CREATURE_PARAM_IDS) {
    if (!ps.get(id)) continue;
    const row = rowFor(id);
    rows.set(id, row);
    panel.appendChild(row);
  }
  container.appendChild(panel);

  // Each animal has its own movements. The param swaps its option list the
  // moment the animal changes (CreatureParams.js — registered before this
  // listener, so it has already run), but a row keeps the list it was built
  // with: build the Movement row again. Same move as the model takes'
  // Segment row (UI.js buildSegmentRow) on a new clip.
  const rebuildMoves = () => {
    const old = rows.get('creature.segment');
    if (!old) return;
    const row = rowFor('creature.segment');
    old.replaceWith(row);
    rows.set('creature.segment', row);
  };
  ps.get('creature.kind')?.onChange(rebuildMoves);

  // ── Creature files (CreatureCustom.js): a creature made from one of these
  // animals, as a data-only file. Everything from a file is shown with
  // textContent — never as markup.
  const files = document.createElement('div');
  files.className = 'creature-files';
  const status = document.createElement('div');
  status.className = 'creature-files-status';
  const btn = (label, title, fn) => {
    const b = document.createElement('button');
    b.className = 'import-btn'; b.type = 'button'; b.textContent = label; b.title = title;
    b.addEventListener('click', fn);
    files.appendChild(b);
    return b;
  };
  const say = (text, bad = false) => { status.textContent = text; status.classList.toggle('bad', bad); };
  const showCustom = () => {
    const c = getCreatureCustom();
    const base = c && CREATURE_KINDS.find(k => k.key === c.base);
    say(c ? `Custom creature: ${c.name} (on ${base?.label ?? c.base})` : 'Custom creature: none');
    removeBtn.disabled = !c;
  };

  const pick = document.createElement('input');
  pick.type = 'file'; pick.accept = `${CREATURE_FILE_EXT},.json,application/json`; pick.style.display = 'none';
  pick.addEventListener('change', async () => {
    const file = pick.files?.[0];
    pick.value = '';
    if (!file) return;
    try {
      if (file.size > 512 * 1024) throw new Error('That file is too big to be a creature file.');
      let raw;
      try { raw = JSON.parse(await file.text()); } catch { throw new Error('That file could not be read as a creature file.'); }
      const c = setCreatureCustom(raw);               // cleaned in there; throws with a message for the player
      const kind = CREATURE_KINDS.findIndex(k => k.key === c.base);
      if (Math.round(ps.get('creature.kind').value) !== kind) ps.set('creature.kind', kind);
      ps.set('creature.segment', 0);
      if (!ps.get('creature.active').value) ps.set('creature.active', 1);
    } catch (e) { say(e.message || 'That file could not be loaded.', true); }
  });
  files.appendChild(pick);

  btn('Import…', 'Load a creature file (.imcreature). It replaces the movements and colours of the animal it is built on, until you remove it.', () => pick.click());
  btn('Export…', 'Save the animal on screen, with its movements and colours, as a creature file you can edit and share.', async () => {
    try {
      const K = CREATURE_KINDS[Math.round(ps.get('creature.kind').value)];
      const { loadCreatureFiles } = await import('./CreatureFiles.js');
      let { def, view } = await loadCreatureFiles(K.key);
      const c = getCreatureCustom();
      if (c?.base === K.key) ({ def, view } = applyCreatureFile(def, view, c));
      const out = exportCreatureFile(K.key, def, view, c?.base === K.key ? c.name : `My ${K.label}`);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' }));
      a.download = `${out.name.replace(/[^\p{L}\p{N} _-]/gu, '').trim() || 'creature'}${CREATURE_FILE_EXT}`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      say(`Saved ${a.download}`);
    } catch (e) { say('The creature could not be saved.', true); console.error('[Creature] export:', e); }
  });
  const removeBtn = btn('Remove', 'Go back to the animal\'s own movements and colours.', () => setCreatureCustom(null));
  const guide = document.createElement('a');
  guide.className = 'creature-guide-link'; guide.href = GUIDE_URL; guide.target = '_blank'; guide.rel = 'noopener';
  guide.textContent = 'How to make a creature';
  guide.addEventListener('click', e => { if (openGuide) { e.preventDefault(); openGuide(GUIDE_URL, 'Making creatures'); } });
  files.appendChild(guide);
  panel.appendChild(files);
  panel.appendChild(status);

  onCreatureCustomChange(() => { rebuildMoves(); showCustom(); });
  showCustom();
  return { panel };
}
