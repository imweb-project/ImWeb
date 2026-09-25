/**
 * Growth tables — kept free of three.js so ParameterSystem (which the node
 * audits import) can build its option menus from them.
 */

// Gray-Scott (feed, kill) pairs. APPEND-ONLY — growth.patternA/B persist as
// indices into this list, exactly like SOURCE_DEFS.
export const GROWTH_PATTERNS = [
  { label: 'Coral',       f: 0.0545, k: 0.0620 },
  { label: 'Mitosis',     f: 0.0367, k: 0.0649 },
  { label: 'Worms',       f: 0.0500, k: 0.0630 },
  { label: 'Spots',       f: 0.0350, k: 0.0650 },
  { label: 'Maze',        f: 0.0290, k: 0.0570 },
  { label: 'Holes',       f: 0.0390, k: 0.0580 },
  { label: 'Chaos',       f: 0.0260, k: 0.0510 },
  { label: 'Fingerprint', f: 0.0370, k: 0.0600 },
  { label: 'U-Skate',     f: 0.0620, k: 0.0609 },
  { label: 'Waves',       f: 0.0140, k: 0.0450 },
];

export const GROWTH_RES = [256, 512, 1024];

// growth.mode. APPEND-ONLY. Indices match MODE_* in GrowthRD.js.
// Single = Gray-Scott (one pattern scale); Nested = multi-scale Turing.
// ≤ 6 characters and no hyphen: a short SELECT renders as a button group
// that abbreviates longer labels ("Gray-Scott" showed as "Scott").
export const GROWTH_MODES = ['Single', 'Nested', 'Frost'];   // Frost = crystals
