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
export const GROWTH_MODES = ['Single', 'Nested', 'Frost', 'Hyphae', 'Curves'];   // Frost = crystals, Hyphae = 1-px threads, Curves = free-moving smooth threads

// ── Looks ─────────────────────────────────────────────────────────────────────
// A Look writes EVERY value that shapes the result, not just the obvious
// ones: a leftover Feed offset or Lifetime silently turned "Mitosis" into
// static dots with a dead centre (owner, 2026-09-25). Values are param values
// as the panel shows them. APPEND-ONLY — growth.look persists the index.
// Optional `plants`: extra colonies main.js sows after the centre spore.
// Edge (growth.edge) is deliberately NOT here: it sets how growth meets the
// frame — a stage setting that holds across Looks (owner, 2026-09-26) — and
// unlike the leftovers above it cannot make a Look fail, only trim it.
// Each one is verified on the GPU to look like its name (CHANGELOG).
const LOOK_BASE = {
  'growth.speed': 16, 'growth.feed': 0, 'growth.kill': 0, 'growth.fieldAmt': 0,
  'growth.zones': 0, 'growth.variation': 0, 'growth.varSize': 3, 'growth.varDrift': 0.05,
  'growth.fadeStyle': 0, 'growth.lifetime': 12, 'growth.rest': 4, 'growth.details': 0,
  'growth.sat': 45, 'growth.spread': 15, 'growth.colonies': 0, 'growth.contrast': 4,
  'growth.relief': 45, 'growth.bevel': 2, 'growth.lightAngle': 135, 'growth.gloss': 25, 'growth.ground': 12,
  'growth.res': 1, 'growth.seedAmt': 100, 'growth.plantSize': 3,
  'growth.hyDensity': 31, 'growth.crFold': 6, 'growth.crAniso': 0.04, 'growth.crAngle': 0, 'growth.crHeat': 1.6, 'growth.crNoise': 0.02, 'growth.crRingGap': 0.4,
};
export const GROWTH_LOOKS = [
  // Mitosis only divides from a spore in a slightly more fertile medium:
  // measured over 8 settings, a 6% spore at Size 0.4 grew only at Kill −2
  // (1 → 68 → 237 cells in 15 s); Kill −1, a bigger spore, or more Feed all
  // died to nothing. That is the whole reason Mitosis "did not work".
  { name: 'Mitosis', values: { ...LOOK_BASE,
    'growth.mode': 0, 'growth.patternA': 1, 'growth.patternB': 1, 'growth.scale': 23, 'growth.kill': -2,
    'growth.variation': 25, 'growth.plantSize': 6,
    'growth.fadeStyle': 3, 'growth.lifetime': 10, 'growth.rest': 1.5,
    'growth.hue': 70, 'growth.spread': 8 } },
  { name: 'Lichen', values: { ...LOOK_BASE,
    'growth.mode': 0, 'growth.patternA': 0, 'growth.patternB': 5, 'growth.scale': 14,
    'growth.zones': 80, 'growth.variation': 60, 'growth.details': 20,
    'growth.relief': 50, 'growth.bevel': 3, 'growth.gloss': 15, 'growth.ground': 30,
    'growth.hue': 45, 'growth.sat': 55, 'growth.spread': 25, 'growth.colonies': 35, 'growth.plantSize': 4 },
    // Colonies sown after the centre one, [PlantX, PlantY] — each its own
    // colour, meeting the others at borders, like lichens on a rock.
    plants: [[24, 28], [76, 70], [22, 74], [78, 26]] },
  { name: 'Coral', values: { ...LOOK_BASE,
    'growth.mode': 0, 'growth.patternA': 0, 'growth.patternB': 0, 'growth.scale': 23,
    'growth.variation': 40, 'growth.relief': 55, 'growth.bevel': 3, 'growth.ground': 18,
    'growth.hue': 12, 'growth.sat': 60, 'growth.spread': 8, 'growth.plantSize': 4 } },
  // Snowflake at 512 / Size 0.25 / Heat 2.0 is still inside the frame at
  // 17 s (22% solid); every 256 setting reached the edges by 12 s and set
  // into a slab. Hold 20 s fades it before it can fill the frame.
  { name: 'Snowflake', values: { ...LOOK_BASE,
    'growth.mode': 2, 'growth.res': 1, 'growth.scale': 37, 'growth.crHeat': 2.0,
    'growth.fadeStyle': 2, 'growth.lifetime': 20,
    'growth.details': 45, 'growth.relief': 35, 'growth.ground': 10, 'growth.gloss': 30,
    'growth.hue': 205, 'growth.sat': 30, 'growth.spread': 20, 'growth.plantSize': 2 } },
  // Mycelium: branching threads exactly one pixel wide (the Hyphae engine),
  // colour walking with age so old threads and fresh tips differ. Size 15 is
  // the 1024 grid — the finest lines; this engine is cheap enough for it.
  { name: 'Mycelium', values: { ...LOOK_BASE,
    'growth.mode': 3, 'growth.scale': 15, 'growth.variation': 45, 'growth.hyBranch': 70,
    'growth.relief': 0, 'growth.ground': 4, 'growth.gloss': 0,
    'growth.hue': 40, 'growth.sat': 25, 'growth.spread': 45, 'growth.plantSize': 1 } },
];
