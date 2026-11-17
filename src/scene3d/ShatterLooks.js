/**
 * Shatter Looks — named starting points for the 3D scene's Shatter.
 *
 * Data only (no imports), so ParameterSystem can take the names for the
 * scene3d.shatter.look menu. Choosing a Look writes `set` and nothing else:
 * it styles HOW the object comes apart, and leaves the object, its material
 * and the rest of the patch alone.
 *
 * Every Look sets EVERY Shatter control (tests/audit-shatter-looks.mjs holds
 * that), so a name always gives its look whatever was dialled before. Selects
 * are written as LABELS and resolved when applied, so a renamed shape or
 * source fails the audit instead of silently loading something else.
 *
 * Index 0 is a no-op heading: the menu must not claim a Look the patch is
 * not in. APPEND-ONLY after that — the menu persists as an index.
 */
export const SHATTER_LOOKS = [
  { name: 'Choose a Look…' },
  {
    // Big curved pieces that turn slowly: the object as broken china.
    name: 'Porcelain',
    about: 'Breaks into large turning pieces, like china, that drift through a knot and reassemble.',
    set: [
      ['scene3d.shatter', 70], ['scene3d.shatter.shape', 'Thomas'], ['scene3d.shatter.size', 60], ['scene3d.shatter.flow', 70],
      ['scene3d.shatter.piece', 30], ['scene3d.shatter.by', 'Pieces'],
      ['scene3d.shatter.tumble', 45], ['scene3d.shatter.dust', 0], ['scene3d.shatter.mask', 'None'],
    ],
  },
  {
    // Single triangles, shrinking as they go: the object blown away as spray.
    name: 'Dust storm',
    about: 'Every triangle flies alone and shrinks to dust along the butterfly.',
    set: [
      ['scene3d.shatter', 100], ['scene3d.shatter.shape', 'Lorenz'], ['scene3d.shatter.size', 70], ['scene3d.shatter.flow', 120],
      ['scene3d.shatter.piece', 0], ['scene3d.shatter.by', 'Pieces'],
      ['scene3d.shatter.tumble', 0], ['scene3d.shatter.dust', 45], ['scene3d.shatter.mask', 'None'],
    ],
  },
  {
    // For a figure: limbs fly whole and go on moving. On an unrigged object
    // Body parts falls back to Pieces, so PieceSize is set for that case.
    name: 'Limb from limb',
    about: 'A figure comes apart at the joints; each part flies whole, still moving, around a shell.',
    set: [
      ['scene3d.shatter', 80], ['scene3d.shatter.shape', 'Aizawa'], ['scene3d.shatter.size', 55], ['scene3d.shatter.flow', 60],
      ['scene3d.shatter.piece', 35], ['scene3d.shatter.by', 'Body parts'],
      ['scene3d.shatter.tumble', 25], ['scene3d.shatter.dust', 0], ['scene3d.shatter.mask', 'None'],
    ],
  },
  {
    // Shatter held in the middle with the camera as the mask: whatever is
    // bright in front of the lens is what comes apart.
    name: 'Eaten by light',
    about: 'The camera decides: where its picture is bright the object dissolves, where it is dark it holds.',
    set: [
      ['scene3d.shatter', 50], ['scene3d.shatter.shape', 'Rössler'], ['scene3d.shatter.size', 60], ['scene3d.shatter.flow', 100],
      ['scene3d.shatter.piece', 15], ['scene3d.shatter.by', 'Pieces'],
      ['scene3d.shatter.tumble', 30], ['scene3d.shatter.dust', 30], ['scene3d.shatter.mask', 'Camera'],
    ],
  },
];

/**
 * A Look's `set` as [id, number] pairs — labels resolved against `ps`.
 * @returns {{ values: Array<[string, number]>, errors: string[] }}
 */
export function resolveShatterLook(ps, look) {
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
