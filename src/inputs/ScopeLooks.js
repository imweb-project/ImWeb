/**
 * Scope Looks — named starting points for the Vectorscope.
 *
 * Data only (no imports), so ParameterSystem can take the names for the
 * vectorscope.look menu. Choosing a Look writes `set` and nothing else.
 *
 * Every Look sets EVERY Vectorscope control (tests/audit-scope.mjs holds
 * that), so a name always gives its look whatever was dialled before. Selects
 * are written as LABELS and resolved when applied, so a renamed mode or colour
 * fails the audit instead of silently loading something else.
 *
 * Index 0 is a no-op heading: the menu must not claim a Look the scope is not
 * in. APPEND-ONLY after that — the menu persists as an index.
 */
export const SCOPE_LOOKS = [
  { name: 'Choose a Look…' },
  {
    name: 'Phosphor',
    about: 'A classic green tube: where the trace moves slowly it burns bright, where it races it goes faint.',
    set: [
      ['vectorscope.mode', 'Lissajous'], ['vectorscope.color', 'Green'], ['vectorscope.beam', 85],
      ['vectorscope.spin', 0], ['vectorscope.freeze', 0], ['vectorscope.gain', 100],
      ['vectorscope.decay', 70], ['vectorscope.glow', 10], ['vectorscope.linewidth', 1.5],
    ],
  },
  {
    name: 'Rosette',
    about: 'The figure turns slowly and its long trail paints rosettes; the colour follows the pitch.',
    set: [
      ['vectorscope.mode', 'Lissajous'], ['vectorscope.color', 'Pitch'], ['vectorscope.beam', 70],
      ['vectorscope.spin', 40], ['vectorscope.freeze', 0], ['vectorscope.gain', 100],
      ['vectorscope.decay', 92], ['vectorscope.glow', 6], ['vectorscope.linewidth', 1],
    ],
  },
  {
    name: 'Ember',
    about: 'Loudness turns the trace from blue to red, and it smoulders in a long trail.',
    set: [
      ['vectorscope.mode', 'Phase Space'], ['vectorscope.color', 'Level'], ['vectorscope.beam', 80],
      ['vectorscope.spin', 0], ['vectorscope.freeze', 0], ['vectorscope.gain', 90],
      ['vectorscope.decay', 85], ['vectorscope.glow', 16], ['vectorscope.linewidth', 2],
    ],
  },
  {
    name: 'Mandala',
    about: 'Sound as a flower that keeps turning, gold, leaving its earlier petals behind.',
    set: [
      ['vectorscope.mode', 'Polar'], ['vectorscope.color', 'Gold'], ['vectorscope.beam', 60],
      ['vectorscope.spin', 25], ['vectorscope.freeze', 0], ['vectorscope.gain', 110],
      ['vectorscope.decay', 90], ['vectorscope.glow', 8], ['vectorscope.linewidth', 1],
    ],
  },
];

/**
 * A Look's `set` as [id, number] pairs — labels resolved against `ps`.
 * @returns {{ values: Array<[string, number]>, errors: string[] }}
 */
export function resolveScopeLook(ps, look) {
  const values = [], errors = [];
  for (const [id, v] of look?.set ?? []) {
    const p = ps.get(id);
    if (!p) { errors.push(`no param ${id}`); continue; }
    if (typeof v === 'string') {
      const i = p.options?.indexOf(v) ?? -1;
      if (i < 0) errors.push(`${id}: no option "${v}"`); else values.push([id, i]);
    } else values.push([id, v]);
  }
  return { values, errors };
}
