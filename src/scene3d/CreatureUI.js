/**
 * CreatureUI.js — the Creature section of the 3D workspace.
 *
 * Every row is a STANDARD param row (badge → LFO/MIDI/OSC, live value), in the
 * order of CREATURE_PARAM_IDS; tests/audit-creature.mjs checks that every
 * creature param is in that list exactly once, so a new one cannot silently
 * get no row.
 */

import { CREATURE_PARAM_IDS } from './CreatureParams.js';

/**
 * Build the panel ONCE.
 * @param {HTMLElement}     container
 * @param {ParameterSystem} ps
 * @param {(id:string) => HTMLElement} rowFor  – builds a standard param row
 */
export function buildCreaturePanel(container, ps, rowFor) {
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
  ps.get('creature.kind')?.onChange(() => {
    const old = rows.get('creature.segment');
    if (!old) return;
    const row = rowFor('creature.segment');
    old.replaceWith(row);
    rows.set('creature.segment', row);
  });
  return { panel };
}
