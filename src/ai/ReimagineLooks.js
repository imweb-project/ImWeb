/**
 * Reimagine Looks — named starting points for the AI stills loop.
 *
 * Data only (no imports), so ParameterSystem can take the names for the
 * reimagine.look menu without pulling the AI module into its graph.
 *
 * Choosing a Look runs the same clean reset as Shift+Esc (behind a confirm),
 * then writes `set`. Values are written as LABELS for selects and resolved by
 * Guide.resolveStart, so a renamed source or blend mode fails
 * tests/audit-reimagine-looks.mjs instead of silently loading a different
 * patch. `prompt` fills the prompt box. `seed: true` captures the camera into
 * FirstSlot first — a Look whose output is the buffer alone would otherwise
 * send the model an empty slot (a black frame) on its first run.
 *
 * Composition rule these rely on (Pipeline): FG Blend 'Copy' shows the
 * Foreground ALONE. Any other mode mixes it with the Background, with Blend
 * Amt on a curve — 0 % Background alone, 50 % the blend at full strength,
 * 100 % Foreground alone.
 *
 * Index 0 is a no-op heading: the menu must not claim a Look the patch is
 * not in. APPEND-ONLY after that — reimagine.look persists as an index.
 */
export const REIMAGINE_LOOKS = [
  { name: 'Choose a Look…' },
  {
    name: 'Live in the painting',
    about: 'You stay live; the AI painting carries your light and shade.',
    prompt: 'as wet ink on rice paper',
    set: [
      ['layer.fg', 'Camera'], ['layer.bg', 'Stills Buffer'],
      ['layer.fg.blend', 'Luminosity'], ['layer.fg.blendAmount', '40'],
      ['reimagine.interval', '15'], ['reimagine.fade', '8'],
    ],
  },
  {
    name: 'Breathing painting',
    about: 'The painting fills the frame; your movement warps it.',
    prompt: 'as a thick impasto oil painting, visible brush strokes',
    seed: true,
    set: [
      ['layer.fg', 'Stills Buffer'], ['layer.ds', 'Camera'],
      ['displace.amount', '12'],
      ['reimagine.interval', '20'], ['reimagine.fade', '10'],
    ],
  },
  {
    name: 'Woodcut shadow',
    about: 'A carved print multiplied over the live camera.',
    prompt: 'as a black-and-white woodcut print with bold carved lines',
    set: [
      ['layer.fg', 'Stills Buffer'], ['layer.bg', 'Camera'],
      ['layer.fg.blend', 'Multiply'], ['layer.fg.blendAmount', '50'],
      ['reimagine.interval', '15'], ['reimagine.fade', '6'],
    ],
  },
  {
    name: 'Drift',
    about: 'Each answer is reimagined again — it wanders away from you.',
    prompt: 'as a mineral cross-section with agate bands',
    seed: true,
    set: [
      ['layer.fg', 'Stills Buffer'],
      ['reimagine.interval', '10'], ['reimagine.fade', '12'],
    ],
  },
  {
    // The AI image as a surface in 3D: texture = the buffer, height = its
    // depth (AI Depth, made in the browser for each image). Turns slowly so
    // the relief reads. Needs reimagine.depth on, which the reset leaves on.
    name: 'Relief (3D)',
    about: 'Each AI image becomes a turning 3D relief, pushed out by its own depth.',
    prompt: 'as a carved and painted wooden altarpiece, deep relief',
    seed: true,
    set: [
      ['layer.fg', '3D Scene'], ['scene3d.active', '1'],
      ['scene3d.geo', 'Basic: Plane'],
      ['scene3d.mat.texsrc', 'Buffer'], ['scene3d.mat.dispsrc', 'AI Depth'],
      ['scene3d.mat.tDisplace', '0.3'], ['scene3d.spin.y', '6'],
      // The AI sees the flat camera, not the turning plane on screen.
      ['reimagine.send', 'Camera'],
      ['reimagine.interval', '15'], ['reimagine.fade', '8'],
    ],
  },
];
