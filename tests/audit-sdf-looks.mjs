/**
 * SDF Looks audit — a Look must write every value that shapes the picture.
 *
 * The rule comes from Growth (GrowthPatterns.js, owner 2026-09-25): a Look that
 * states only the values it cares about inherits the rest from whatever was on
 * screen before, so "Coral" picked after a twisted lattice is a twisted lattice
 * with coral colours, and the menu lies. Nothing errors — every leftover is a
 * valid value — so it can only be held structurally:
 *
 *   - every Look carries EXACTLY the set of sdf.* params, minus the four stage
 *     settings a Look deliberately leaves alone. A param added to the generator
 *     later therefore fails here until SDFLooks.js states it;
 *   - every value is inside its param's range (a SELECT index inside its
 *     options), because ps.set clamps silently and a clamped Look is a
 *     different Look;
 *   - Look 0, "Default", IS the registered defaults — it is the reset, and the
 *     base every other Look spreads;
 *   - sdf.look is a loader: group 'global' (a Display State must capture the
 *     values, not an index that would re-apply over them), reselect on, and
 *     its menu is SDF_LOOKS in order (the index persists, so APPEND-ONLY).
 *
 * This does not judge whether a Look resembles its name — that was done by
 * rendering each one (see CHANGELOG) and is not something text can check.
 *
 * Run:  node tests/audit-sdf-looks.mjs
 */
import { ParameterSystem, registerCoreParameters } from '../src/controls/ParameterSystem.js';
import { SDF_LOOKS } from '../src/inputs/SDFLooks.js';

const fails = [];
let checks = 0;
const check = (msg, ok) => { checks++; if (!ok) fails.push(msg); };

const ps = new ParameterSystem();
registerCoreParameters(ps);

// Stage settings: held across Looks on purpose (see the header of SDFLooks.js).
const NOT_IN_A_LOOK = ['sdf.active', 'sdf.texSrc', 'sdf.refractSrc', 'sdf.rscale'];
const sdfIds = [...ps.params.values()].filter((p) => p.group === 'sdf').map((p) => p.id);
const required = sdfIds.filter((id) => !NOT_IN_A_LOOK.includes(id)).sort();

check('there are sdf params to check (vacuity guard)', required.length >= 40);
check('there are Looks to check (vacuity guard)', SDF_LOOKS.length >= 3);
check('every stage setting named here still exists', NOT_IN_A_LOOK.every((id) => ps.get(id)));

const menu = ps.get('sdf.look');
check('sdf.look exists', !!menu);
check('sdf.look menu is SDF_LOOKS, in order',
  JSON.stringify(menu?.options) === JSON.stringify(SDF_LOOKS.map((l) => l.name)));
check('sdf.look is group global (a recall must not re-apply a Look)', menu?.group === 'global');
check('sdf.look re-applies when the shown Look is picked again', menu?.reselect === true);
check('Look names are unique', new Set(SDF_LOOKS.map((l) => l.name)).size === SDF_LOOKS.length);

for (const look of SDF_LOOKS) {
  const keys = Object.keys(look.values).sort();
  const missing = required.filter((id) => !keys.includes(id));
  const extra   = keys.filter((id) => !required.includes(id));
  check(`${look.name}: states every sdf value (missing: ${missing.join(', ')})`, missing.length === 0);
  check(`${look.name}: states nothing else (extra: ${extra.join(', ')})`, extra.length === 0);
  for (const [id, v] of Object.entries(look.values)) {
    const p = ps.get(id);
    if (!p) continue;                       // already reported as extra
    if (Array.isArray(p.options) && p.options.length) {
      check(`${look.name}: ${id} = ${v} is an index into its ${p.options.length} options`,
        Number.isInteger(v) && v >= 0 && v < p.options.length);
    } else if (typeof p.min === 'number' && typeof p.max === 'number') {
      check(`${look.name}: ${id} = ${v} is within ${p.min}..${p.max}`, v >= p.min && v <= p.max);
    }
  }
}

const base = SDF_LOOKS[0];
check('Look 0 is named Default', base?.name === 'Default');
for (const id of required) {
  const want = ps.get(id).value;
  check(`Default: ${id} is the registered default (${base?.values[id]} vs ${want})`,
    Number(base?.values[id]) === Number(want));
}

if (fails.length) {
  for (const f of fails) console.error(`  FAIL ${f}`);
  console.error(`\n${fails.length} FAILURE(S) of ${checks} checks`);
  process.exit(1);
}
console.log(`All SDF Look checks passed (${checks} checks, ${SDF_LOOKS.length} Looks, ${required.length} values each).`);
